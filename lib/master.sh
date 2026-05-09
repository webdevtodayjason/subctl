#!/usr/bin/env bash
# lib/master.sh — subctl master verb dispatcher (subctl master daemon control plane).
#
# Mirrors lib/service.sh's launchd plumbing for the dashboard, but for the
# master daemon (components/master/server.ts). Configuration lives at
# ~/.config/subctl/master/{providers,policy}.json; bot creds at
# ~/.config/subctl/master-notify.json (separate from notify.json — subctl master
# uses its own dedicated Telegram bot per the two-bot mandate in
# components/master/README.md).

[[ -n "${_SUBCTL_MASTER_LOADED:-}" ]] && return 0
_SUBCTL_MASTER_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

SUBCTL_MASTER_LABEL="${SUBCTL_MASTER_LABEL:-com.subctl.master}"
SUBCTL_MASTER_PLIST="$HOME/Library/LaunchAgents/${SUBCTL_MASTER_LABEL}.plist"
SUBCTL_MASTER_PLIST_TPL="$SUBCTL_REPO_ROOT/components/master/launchd/com.subctl.master.plist"
SUBCTL_MASTER_DIR="$SUBCTL_REPO_ROOT/components/master"
SUBCTL_MASTER_SERVER_TS="$SUBCTL_MASTER_DIR/server.ts"
SUBCTL_MASTER_LOG="$SUBCTL_LOG_DIR/master.log"
SUBCTL_MASTER_STATE_DIR="$SUBCTL_CONFIG_DIR/master"
SUBCTL_MASTER_NOTIFY_CFG="$SUBCTL_CONFIG_DIR/master-notify.json"
SUBCTL_MASTER_PAUSED_FLAG="$SUBCTL_MASTER_STATE_DIR/PAUSED"
SUBCTL_MASTER_CLI_PROMPTS="$SUBCTL_MASTER_STATE_DIR/cli-prompts.jsonl"

subctl_master() {
  local sub="${1:-help}"; [[ $# -gt 0 ]] && shift
  case "$sub" in
    enable)    subctl_master_enable "$@" ;;
    disable)   subctl_master_disable "$@" ;;
    status)    subctl_master_status "$@" ;;
    logs)      subctl_master_logs "$@" ;;
    prompt)    subctl_master_prompt "$@" ;;
    providers) subctl_master_providers "$@" ;;
    policy)    subctl_master_policy "$@" ;;
    pause)     subctl_master_pause "$@" ;;
    resume)    subctl_master_resume "$@" ;;
    restart)   subctl_master_restart "$@" ;;
    help|-h|--help|"")
      cat <<'EOF'
subctl master <verb> [args]

  Control subctl master — the master orchestrator daemon.

Verbs:
  enable          Install + load launchd plist (auto-starts at login)
  disable         Unload + remove the plist (state preserved)
  status          launchd state, PID, recent log, models, active workers
  logs [-f]       tail (or tail -f with --follow) ~/Library/Logs/subctl/master.log
  prompt "TEXT"   Inject a one-shot user message to the running daemon
  providers       cat ~/.config/subctl/master/providers.json
  policy          cat ~/.config/subctl/master/policy.json
  pause           Halt the autonomous review loop (manual mode only)
  resume          Resume after pause
  restart         disable + enable (full reload)

Examples:
  subctl master enable
  subctl master prompt "review the AMP Cortex PR queue and pick what's safe to merge"
  subctl master logs --follow
EOF
      ;;
    *) subctl_die "unknown master verb: $sub (try: subctl master help)" ;;
  esac
}

# ── helpers ─────────────────────────────────────────────────────────────────

# Returns: running | stopped | not-installed
subctl_master_state() {
  if launchctl list | awk '{print $3}' | grep -qx "$SUBCTL_MASTER_LABEL"; then
    echo running
  elif [[ -f "$SUBCTL_MASTER_PLIST" ]]; then
    echo stopped
  else
    echo not-installed
  fi
}

subctl_master_pid() {
  launchctl list "$SUBCTL_MASTER_LABEL" 2>/dev/null \
    | awk -F'=' '/"PID"/ {gsub(/[^0-9]/, "", $2); print $2}'
}

# ── enable ──────────────────────────────────────────────────────────────────
subctl_master_enable() {
  subctl_require bun "install: curl -fsSL https://bun.sh/install | bash" || return 1
  [[ ! -f "$SUBCTL_MASTER_PLIST_TPL" ]] && subctl_die "plist template missing: $SUBCTL_MASTER_PLIST_TPL"

  if [[ ! -f "$SUBCTL_MASTER_NOTIFY_CFG" ]]; then
    subctl_err "master Telegram config missing: $SUBCTL_MASTER_NOTIFY_CFG"
    cat <<EOF >&2

subctl master uses a SEPARATE Telegram bot from 'subctl notify' (the worker-
escalation bot). To set it up:

  1. Open Telegram, message @BotFather, /newbot, get a NEW token.
     Don't reuse the token from ~/.config/subctl/notify.json — only
     one getUpdates poller is allowed per bot.
  2. Save the creds:
       cat > $SUBCTL_MASTER_NOTIFY_CFG <<JSON
       {
         "telegram_bot_token": "YOUR_NEW_BOT_TOKEN",
         "telegram_chat_id":   "YOUR_TELEGRAM_CHAT_ID"
       }
       JSON
       chmod 600 $SUBCTL_MASTER_NOTIFY_CFG
  3. Re-run: subctl master enable
EOF
    return 1
  fi

  if [[ ! -d "$SUBCTL_MASTER_DIR/node_modules" ]]; then
    subctl_info "installing master deps (one-time): cd $SUBCTL_MASTER_DIR && bun install"
    (cd "$SUBCTL_MASTER_DIR" && bun install) || subctl_die "bun install failed"
  fi

  mkdir -p "$(dirname "$SUBCTL_MASTER_PLIST")" "$SUBCTL_LOG_DIR" "$SUBCTL_MASTER_STATE_DIR"

  local bun_bin
  bun_bin=$(command -v bun)

  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__BUN__|$bun_bin|g" \
      -e "s|__SERVER_TS__|$SUBCTL_MASTER_SERVER_TS|g" \
      -e "s|__HOME__|$HOME|g" \
      "$SUBCTL_MASTER_PLIST_TPL" > "$SUBCTL_MASTER_PLIST"

  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_MASTER_LABEL" "$SUBCTL_MASTER_PLIST" 2>/dev/null || true

  launchctl unload "$SUBCTL_MASTER_PLIST" 2>/dev/null || true
  if ! launchctl load -w "$SUBCTL_MASTER_PLIST"; then
    subctl_err "launchctl load failed — plist at $SUBCTL_MASTER_PLIST"
    return 1
  fi

  subctl_ok "subctl master enabled — auto-starts at login"
  sleep 1
  local pid
  pid=$(subctl_master_pid)
  printf "  Label:    %s\n" "$SUBCTL_MASTER_LABEL"
  printf "  PID:      %s\n" "${pid:-?}"
  printf "  Plist:    %s\n" "$SUBCTL_MASTER_PLIST"
  printf "  Logs:     %s\n" "$SUBCTL_MASTER_LOG"
  printf "  Tail:     subctl master logs --follow\n"
  printf "  Inspect:  subctl master status\n"
}

# ── disable ─────────────────────────────────────────────────────────────────
subctl_master_disable() {
  if [[ -f "$SUBCTL_MASTER_PLIST" ]]; then
    launchctl unload "$SUBCTL_MASTER_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_MASTER_PLIST"
    subctl_ok "subctl master disabled — plist removed"
    subctl_info "state preserved at $SUBCTL_MASTER_STATE_DIR"
  else
    subctl_info "subctl master was not enabled"
  fi
}

# ── status ──────────────────────────────────────────────────────────────────
subctl_master_status() {
  local state pid
  state=$(subctl_master_state)
  case "$state" in
    running)
      pid=$(subctl_master_pid)
      printf "%s● subctl master running%s\n" "$C_GRN" "$C_RST"
      printf "  Label:    %s\n" "$SUBCTL_MASTER_LABEL"
      printf "  PID:      %s\n" "${pid:-?}"
      ;;
    stopped)
      printf "%s○ subctl master stopped%s (auto-start enabled)\n" "$C_YLW" "$C_RST"
      printf "  Plist:    %s\n" "$SUBCTL_MASTER_PLIST"
      ;;
    not-installed)
      printf "%s○ subctl master not enabled%s\n" "$C_DIM" "$C_RST"
      printf "  Enable:   subctl master enable\n"
      ;;
  esac

  if [[ -f "$SUBCTL_MASTER_PAUSED_FLAG" ]]; then
    printf "  Loop:     %s⏸ PAUSED%s (resume: subctl master resume)\n" "$C_YLW" "$C_RST"
  fi

  if [[ -f "$SUBCTL_MASTER_LOG" ]]; then
    printf "\n%s──── master.log (last 10) ────%s\n" "$C_DIM" "$C_RST"
    tail -n 10 "$SUBCTL_MASTER_LOG"
  fi

  local providers="$SUBCTL_MASTER_STATE_DIR/providers.json"
  if [[ -f "$providers" ]] && subctl_have jq; then
    printf "\n%s──── models ────%s\n" "$C_DIM" "$C_RST"
    jq -r '
      (.models // {}) | to_entries | .[] |
      "  \(.key | (. + ":" + (" " * (12 - (. | length))))) \(.value.provider // "?")/\(.value.model // "?")"
    ' "$providers" 2>/dev/null \
      || jq -r '(.models // {}) | to_entries[] | "  \(.key): \(.value.provider // "?")/\(.value.model // "?")"' "$providers" 2>/dev/null \
      || true
    local esc fb
    esc=$(jq -r '.escalate | "\(.provider // "?")/\(.model // "?")"' "$providers" 2>/dev/null)
    fb=$(jq -r '.fallback | "\(.provider // "?")/\(.model // "?")"' "$providers" 2>/dev/null)
    [[ -n "$esc" && "$esc" != "null/null" ]] && printf "  escalate:    %s\n" "$esc"
    [[ -n "$fb"  && "$fb"  != "null/null" ]] && printf "  fallback:    %s\n" "$fb"
  fi

  # Active worker count (best-effort — needs dashboard service running).
  local worker_count
  worker_count=$(curl -sS --max-time 2 "${SUBCTL_API:-http://127.0.0.1:8787}/api/orchestration" 2>/dev/null \
    | jq -r '.orchestrations | length' 2>/dev/null)
  if [[ -n "$worker_count" ]] && [[ "$worker_count" != "null" ]]; then
    printf "\n  Active workers: %s\n" "$worker_count"
  fi
}

# ── logs ────────────────────────────────────────────────────────────────────
subctl_master_logs() {
  local follow=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow=true; shift ;;
      *) shift ;;
    esac
  done
  if [[ ! -f "$SUBCTL_MASTER_LOG" ]]; then
    subctl_warn "no log yet at $SUBCTL_MASTER_LOG"
    subctl_info "  (created on first subctl master boot — try: subctl master enable)"
    return 1
  fi
  if $follow; then
    tail -f "$SUBCTL_MASTER_LOG"
  else
    tail -n 50 "$SUBCTL_MASTER_LOG"
  fi
}

# ── prompt: queue a one-shot user message for the daemon ────────────────────
# Mechanism: append a JSONL entry to ~/.config/subctl/master/cli-prompts.jsonl.
# components/master/master-notify-listener.ts polls this file (offset-tracked)
# and pushes entries into the same in-process queue as Telegram messages, so
# the agent loop has ONE source of operator input.
subctl_master_prompt() {
  local text="${1:-}"
  if [[ -z "$text" ]]; then
    subctl_err "usage: subctl master prompt \"<text>\""
    return 1
  fi
  mkdir -p "$SUBCTL_MASTER_STATE_DIR"
  subctl_require jq "install: brew install jq" || return 1

  local payload
  payload=$(jq -nc \
    --arg ts "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg text "$text" \
    --arg user "${USER:-cli}" \
    '{ts: $ts, text: $text, source: "cli", user: $user}')
  printf "%s\n" "$payload" >> "$SUBCTL_MASTER_CLI_PROMPTS"
  subctl_ok "queued for subctl master: ${text:0:80}"
  subctl_info "the daemon picks up cli-prompts on its next poll cycle (~2s)"

  # Soft warning if the daemon isn't running — the prompt will wait until it is.
  if [[ "$(subctl_master_state)" != "running" ]]; then
    subctl_warn "subctl master is not running — prompt will be processed when you 'subctl master enable'"
  fi
}

# ── providers / policy: inspect active config ───────────────────────────────
subctl_master_providers() {
  local f="$SUBCTL_MASTER_STATE_DIR/providers.json"
  if [[ ! -f "$f" ]]; then
    subctl_warn "providers.json not found at $f"
    subctl_info "  (seeded from .example on first 'subctl master enable')"
    return 1
  fi
  if subctl_have jq; then
    jq . "$f"
  else
    cat "$f"
  fi
}

subctl_master_policy() {
  local f="$SUBCTL_MASTER_STATE_DIR/policy.json"
  if [[ ! -f "$f" ]]; then
    subctl_warn "policy.json not found at $f"
    subctl_info "  (seeded from .example on first 'subctl master enable')"
    return 1
  fi
  if subctl_have jq; then
    jq . "$f"
  else
    cat "$f"
  fi
}

# ── pause / resume: file-flag the daemon's loop checks each tick ────────────
subctl_master_pause() {
  mkdir -p "$SUBCTL_MASTER_STATE_DIR"
  date -u +'%Y-%m-%dT%H:%M:%SZ' > "$SUBCTL_MASTER_PAUSED_FLAG"
  subctl_ok "subctl master review loop PAUSED"
  subctl_info "  flag: $SUBCTL_MASTER_PAUSED_FLAG"
  subctl_info "  the daemon checks this each tick — already-running tools will complete"
}

subctl_master_resume() {
  if [[ -f "$SUBCTL_MASTER_PAUSED_FLAG" ]]; then
    rm -f "$SUBCTL_MASTER_PAUSED_FLAG"
    subctl_ok "subctl master review loop RESUMED"
  else
    subctl_info "subctl master was not paused"
  fi
}

# ── restart ─────────────────────────────────────────────────────────────────
subctl_master_restart() {
  subctl_master_disable
  sleep 1
  subctl_master_enable
}
