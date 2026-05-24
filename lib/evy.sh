#!/usr/bin/env bash
# lib/evy.sh — subctl evy verb dispatcher (subctl evy daemon control plane).
#
# Mirrors lib/service.sh's launchd plumbing for the dashboard, but for the
# master daemon (components/evy/server.ts). Configuration lives at
# ~/.config/subctl/evy/{providers,policy}.json; bot creds at
# ~/.config/subctl/evy-notify.json (separate from notify.json — subctl evy
# uses its own dedicated Telegram bot per the two-bot mandate in
# components/evy/README.md).

[[ -n "${_SUBCTL_EVY_LOADED:-}" ]] && return 0
_SUBCTL_EVY_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/exec.sh"

# v3.0 compat fallback: if the operator still exports SUBCTL_MASTER_LABEL
# (the only operator-overridable env var in the pre-v3.0 master namespace),
# honor it and warn. Removed in v3.x+1.
if [[ -n "${SUBCTL_MASTER_LABEL:-}" && -z "${SUBCTL_EVY_LABEL:-}" ]]; then
  subctl_warn "SUBCTL_MASTER_LABEL is deprecated; use SUBCTL_EVY_LABEL (still honored through v3.x)."
  SUBCTL_EVY_LABEL="$SUBCTL_MASTER_LABEL"
fi

SUBCTL_EVY_LABEL="${SUBCTL_EVY_LABEL:-com.subctl.evy}"
SUBCTL_EVY_PLIST="$HOME/Library/LaunchAgents/${SUBCTL_EVY_LABEL}.plist"
SUBCTL_EVY_PLIST_TPL="$SUBCTL_REPO_ROOT/components/evy/launchd/com.subctl.evy.plist"
SUBCTL_EVY_DIR="$SUBCTL_REPO_ROOT/components/evy"
SUBCTL_EVY_SERVER_TS="$SUBCTL_EVY_DIR/server.ts"
SUBCTL_EVY_LOG="$SUBCTL_LOG_DIR/evy.log"
SUBCTL_EVY_STATE_DIR="$SUBCTL_CONFIG_DIR/evy"
SUBCTL_EVY_NOTIFY_CFG="$SUBCTL_CONFIG_DIR/evy-notify.json"
SUBCTL_EVY_PAUSED_FLAG="$SUBCTL_EVY_STATE_DIR/PAUSED"
SUBCTL_EVY_CLI_PROMPTS="$SUBCTL_EVY_STATE_DIR/cli-prompts.jsonl"

subctl_evy() {
  local sub="${1:-help}"; [[ $# -gt 0 ]] && shift
  case "$sub" in
    enable)      subctl_evy_enable "$@" ;;
    disable)     subctl_evy_disable "$@" ;;
    status)      subctl_evy_status "$@" ;;
    logs)        subctl_evy_logs "$@" ;;
    prompt)      subctl_evy_prompt "$@" ;;
    providers)   subctl_evy_providers "$@" ;;
    policy)      subctl_evy_policy "$@" ;;
    pause)       subctl_evy_pause "$@" ;;
    resume)      subctl_evy_resume "$@" ;;
    restart)     subctl_evy_restart "$@" ;;
    kick)        subctl_evy_kick "$@" ;;
    personality) subctl_evy_personality "$@" ;;
    help|-h|--help|"")
      cat <<'EOF'
subctl evy <verb> [args]

  Control subctl evy — the master orchestrator daemon.

Verbs:
  enable [--no-telegram]
                  Install + load launchd plist (auto-starts at login).
                  --no-telegram skips BotFather walkthrough; daemon runs
                  without notification surface (can be added later).
  disable         Unload + remove the plist (state preserved)
  status          launchd state, PID, recent log, models, active workers
  logs [-f]       tail (or tail -f with --follow) ~/Library/Logs/subctl/evy.log
  prompt "TEXT"   Inject a one-shot user message to the running daemon
  providers       cat ~/.config/subctl/evy/providers.json
  policy          cat ~/.config/subctl/evy/policy.json
  pause           Halt the autonomous review loop (manual mode only)
  resume          Resume after pause
  restart         disable + enable (full reload)
  kick            Force-recover when launchd is throttled. Kills any
                  orphan master process, then bootstraps the launchd job
                  fresh. Use after the daemon has been crash-looping and
                  launchd has given up. Must run from a local TTY (not
                  SSH) — bootstrap requires a GUI domain.
  personality     Set/inspect the master's voice preset (use 'personality help')

Examples:
  subctl evy enable
  subctl evy enable --no-telegram
  subctl evy prompt "review the AMP Cortex PR queue and pick what's safe to merge"
  subctl evy logs --follow
  subctl evy personality list
  subctl evy personality set sarcastic
EOF
      ;;
    *) subctl_die "unknown master verb: $sub (try: subctl evy help)" ;;
  esac
}

# ── launchd recovery (kick) ──────────────────────────────────────────────────
# When the daemon has crash-looped enough that launchd has hit its respawn
# limit, even `launchctl load` won't restart it. The recovery: bootout the
# stale job entry, kill any orphan processes squatting on the port, then
# bootstrap a fresh job. Requires a local TTY (GUI session) — does NOT
# work over SSH because bootstrap targets the gui/$UID domain.
subctl_evy_kick() {
  local label="${SUBCTL_EVY_LABEL:-com.subctl.evy}"
  local plist="${SUBCTL_EVY_PLIST:-$HOME/Library/LaunchAgents/${label}.plist}"
  local port="${SUBCTL_EVY_PORT:-8788}"

  [[ -f "$plist" ]] || subctl_die "no plist at $plist — run 'subctl evy enable' first"

  # GUI-domain check. bootout/bootstrap fail with "Domain does not support
  # specified action" when invoked outside a user-attached session (e.g.
  # SSH without -t).
  if [[ -z "${TERM:-}" || -z "${USER:-}" ]]; then
    subctl_warn "no controlling TTY detected — kick may fail via SSH. Run from local Terminal.app."
  fi

  local uid
  uid=$(id -u)
  local target="gui/$uid/$label"

  subctl_info "bootout $target"
  # PR 8.5: routed through subctl_exec (the bash chokepoint). Ungated — this
  # is launchd plumbing with operator-typed CLI verb, not agent-driven exec.
  subctl_exec launchctl bootout "$target" 2>&1 | tail -3

  # Kill any orphan master process still squatting on the port (e.g. one
  # that survived a stale launchctl entry).
  local pids
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u)
  if [[ -n "$pids" ]]; then
    subctl_warn "orphan process(es) on :$port — killing: $pids"
    for p in $pids; do kill -TERM "$p" 2>/dev/null; done
    sleep 2
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u)
    if [[ -n "$pids" ]]; then
      for p in $pids; do kill -KILL "$p" 2>/dev/null; done
    fi
  fi

  sleep 2
  subctl_info "bootstrap gui/$uid $plist"
  # PR 8.5: routed through subctl_exec.
  if ! subctl_exec launchctl bootstrap "gui/$uid" "$plist" 2>&1; then
    subctl_err "bootstrap failed — likely no GUI session. From local Terminal.app, retry: subctl evy kick"
    subctl_info "fallback: tmux daemon — tmux new-session -d -s subctl-master -c ~/code/subctl '~/.bun/bin/bun components/evy/server.ts > /tmp/evy.log 2>&1'"
    return 1
  fi

  sleep 4
  local health
  health=$(curl -s --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null)
  if [[ -n "$health" ]]; then
    subctl_ok "master back on :$port — $(printf '%s' "$health" | jq -r '"version=" + .version + " uptime=" + (.uptime_s|tostring) + "s"' 2>/dev/null || echo "responding")"
  else
    subctl_warn "bootstrap returned ok but /health didn't respond within 4s — check 'subctl evy logs'"
  fi
}

# ── personality presets ──────────────────────────────────────────────────────
# Hits the running daemon's /personality endpoint at localhost:8788. Daemon
# must be running (use `subctl evy status` to check). State lives in
# ~/.config/subctl/evy/personality.json — but going through the HTTP
# endpoint logs the change to decisions.jsonl and broadcasts to SSE.

subctl_evy_personality() {
  local sub="${1:-show}"; [[ $# -gt 0 ]] && shift
  local port="${SUBCTL_EVY_PORT:-8788}"
  local base="http://127.0.0.1:$port"
  case "$sub" in
    list|ls)
      subctl_require jq "install: brew install jq" || return 1
      local resp
      resp=$(curl -s "$base/personality" 2>&1) || subctl_die "master not reachable at $base — is it running?"
      local active
      active=$(printf "%s" "$resp" | jq -r ".active // empty" 2>/dev/null)
      [[ -z "$active" ]] && subctl_die "no /personality response — daemon may be on an older version"
      echo "active: $active"
      echo
      echo "presets:"
      printf "%s" "$resp" | jq -r '.presets[]? | "  \(if .id == "'"$active"'" then "●" else " " end) \(.id)\n    \(.preview)"'
      ;;
    show|status)
      subctl_require jq "install: brew install jq" || return 1
      local resp
      resp=$(curl -s "$base/personality") || subctl_die "master not reachable at $base"
      printf "%s" "$resp" | jq -r '.active // "(no response)"'
      ;;
    set)
      local preset="${1:-}"
      [[ -z "$preset" ]] && subctl_die "usage: subctl evy personality set <preset>  (run 'list' to see valid presets)"
      subctl_require jq "install: brew install jq" || return 1
      local resp http
      resp=$(curl -s -w '\n%{http_code}' -X POST "$base/personality" \
        -H "Content-Type: application/json" \
        -d "{\"preset\":\"$preset\"}") || subctl_die "master not reachable at $base"
      http=$(printf "%s" "$resp" | tail -n1)
      local body
      body=$(printf "%s" "$resp" | sed '$d')
      if [[ "$http" != "200" ]]; then
        local err
        err=$(printf "%s" "$body" | jq -r ".error // empty" 2>/dev/null)
        subctl_die "${err:-set failed (HTTP $http)}"
      fi
      local active
      active=$(printf "%s" "$body" | jq -r ".active // empty")
      subctl_ok "personality → $active (takes effect on next prompt — no restart needed)"
      ;;
    help|-h|--help|"")
      cat <<EOF
subctl evy personality <verb>

  Control the master daemon's voice preset (tone/cadence/mannerisms).
  Persona — what the master IS — is unchanged. Personality is HOW it
  speaks. Anti-hallucination rules apply across every preset.

Verbs:
  list, ls         List all presets with preview text and active marker
  show, status     Print the currently-active preset
  set <preset>     Switch the active preset (hot-swap; no restart needed)
  help             This help

Built-in presets:
  straight-shooter (default), witty, sarcastic, robotic,
  arnold, elon, hilarious

Examples:
  subctl evy personality list
  subctl evy personality set sarcastic
  subctl evy personality show
EOF
      ;;
    *) subctl_die "unknown personality verb: $sub (try: subctl evy personality help)" ;;
  esac
}

# ── helpers ─────────────────────────────────────────────────────────────────

# Returns: running | stopped | not-installed
subctl_evy_state() {
  if launchctl list | awk '{print $3}' | grep -qx "$SUBCTL_EVY_LABEL"; then
    echo running
  elif [[ -f "$SUBCTL_EVY_PLIST" ]]; then
    echo stopped
  else
    echo not-installed
  fi
}

subctl_evy_pid() {
  launchctl list "$SUBCTL_EVY_LABEL" 2>/dev/null \
    | awk -F'=' '/"PID"/ {gsub(/[^0-9]/, "", $2); print $2}'
}

# Manual BotFather setup instructions — printed on decline, missing installer,
# or walkthrough failure. Reads $SUBCTL_EVY_NOTIFY_CFG from caller scope.
_subctl_evy_print_notify_manual() {
  cat <<EOF

subctl evy uses a SEPARATE Telegram bot from 'subctl notify' (the worker-
escalation bot). To set it up:

  1. Open Telegram, message @BotFather, /newbot, get a NEW token.
     Don't reuse the token from ~/.config/subctl/notify.json — only
     one getUpdates poller is allowed per bot.
  2. Save the creds:
       cat > $SUBCTL_EVY_NOTIFY_CFG <<JSON
       {
         "telegram_bot_token": "YOUR_NEW_BOT_TOKEN",
         "telegram_chat_id":   "YOUR_TELEGRAM_CHAT_ID"
       }
       JSON
       chmod 600 $SUBCTL_EVY_NOTIFY_CFG
  3. Re-run: subctl evy enable
EOF
}

# ── enable ──────────────────────────────────────────────────────────────────
# Flags:
#   --no-telegram  Skip Telegram bot setup (BotFather walkthrough + evy-notify.json
#                  presence check). The master daemon's notify listener already
#                  handles a missing evy-notify.json gracefully (see
#                  components/evy/evy-notify-listener.ts:118-121 — returns
#                  {ok:false, reason:"no evy-notify.json…"} without crashing),
#                  so the daemon runs fine without notification surface. Use when
#                  you want master enabled now and will set up Telegram later via
#                  _subctl_evy_print_notify_manual (or just bash install.sh --botfather).
subctl_evy_enable() {
  local no_telegram=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-telegram) no_telegram=true; shift ;;
      --)            shift; break ;;
      -*)            subctl_die "unknown flag: $1 (try: subctl evy help)" ;;
      *)             break ;;
    esac
  done

  subctl_require bun "install: curl -fsSL https://bun.sh/install | bash" || return 1
  [[ ! -f "$SUBCTL_EVY_PLIST_TPL" ]] && subctl_die "plist template missing: $SUBCTL_EVY_PLIST_TPL"

  if $no_telegram; then
    subctl_warn "Telegram disabled (--no-telegram) — master daemon will run without notification surface."
    subctl_info "  to enable later, see manual setup: subctl evy enable (without --no-telegram), or:"
    subctl_info "    bash install.sh --botfather   # walkthrough"
    subctl_info "    or write $SUBCTL_EVY_NOTIFY_CFG manually (see _subctl_evy_print_notify_manual)"
  elif [[ ! -f "$SUBCTL_EVY_NOTIFY_CFG" ]]; then
    subctl_warn "master Telegram config missing — running BotFather walkthrough"

    # Resolve install.sh: lib/evy.sh → lib/ → repo root → install.sh
    local _lib_dir _repo_root _installer
    _lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _repo_root="$(cd "$_lib_dir/.." && pwd)"
    _installer="$_repo_root/install.sh"

    if [[ ! -f "$_installer" ]]; then
      subctl_err "installer not found at $_installer — see manual setup below"
      _subctl_evy_print_notify_manual >&2
      return 1
    fi

    local _reply
    read -r -p "Run BotFather walkthrough now via 'bash install.sh --botfather'? [Y/n] " _reply
    _reply="${_reply:-Y}"
    if [[ ! "$_reply" =~ ^[Yy] ]]; then
      _subctl_evy_print_notify_manual >&2
      return 1
    fi

    # Run as subprocess — `source` would execute the full installer (no
    # __main__ guard at the bottom of install.sh).
    bash "$_installer" --botfather

    if [[ -f "$SUBCTL_EVY_NOTIFY_CFG" ]]; then
      subctl_ok "evy-notify.json now present — continuing master enable"
    else
      subctl_err "BotFather walkthrough did not write $SUBCTL_EVY_NOTIFY_CFG — see manual setup below"
      _subctl_evy_print_notify_manual >&2
      return 1
    fi
  fi

  if [[ ! -d "$SUBCTL_EVY_DIR/node_modules" ]]; then
    subctl_info "installing master deps (one-time): cd $SUBCTL_EVY_DIR && bun install"
    (cd "$SUBCTL_EVY_DIR" && bun install) || subctl_die "bun install failed"
  fi

  mkdir -p "$(dirname "$SUBCTL_EVY_PLIST")" "$SUBCTL_LOG_DIR" "$SUBCTL_EVY_STATE_DIR"

  local bun_bin
  bun_bin=$(command -v bun)

  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__BUN__|$bun_bin|g" \
      -e "s|__SERVER_TS__|$SUBCTL_EVY_SERVER_TS|g" \
      -e "s|__HOME__|$HOME|g" \
      "$SUBCTL_EVY_PLIST_TPL" > "$SUBCTL_EVY_PLIST"

  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_EVY_LABEL" "$SUBCTL_EVY_PLIST" 2>/dev/null || true

  launchctl unload "$SUBCTL_EVY_PLIST" 2>/dev/null || true
  if ! launchctl load -w "$SUBCTL_EVY_PLIST"; then
    subctl_err "launchctl load failed — plist at $SUBCTL_EVY_PLIST"
    return 1
  fi

  subctl_ok "subctl evy enabled — auto-starts at login"
  sleep 1
  local pid
  pid=$(subctl_evy_pid)
  printf "  Label:    %s\n" "$SUBCTL_EVY_LABEL"
  printf "  PID:      %s\n" "${pid:-?}"
  printf "  Plist:    %s\n" "$SUBCTL_EVY_PLIST"
  printf "  Logs:     %s\n" "$SUBCTL_EVY_LOG"
  printf "  Tail:     subctl evy logs --follow\n"
  printf "  Inspect:  subctl evy status\n"
}

# ── disable ─────────────────────────────────────────────────────────────────
subctl_evy_disable() {
  if [[ -f "$SUBCTL_EVY_PLIST" ]]; then
    launchctl unload "$SUBCTL_EVY_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_EVY_PLIST"
    subctl_ok "subctl evy disabled — plist removed"
    subctl_info "state preserved at $SUBCTL_EVY_STATE_DIR"
  else
    subctl_info "subctl evy was not enabled"
  fi
}

# ── status ──────────────────────────────────────────────────────────────────
subctl_evy_status() {
  local state pid
  state=$(subctl_evy_state)
  case "$state" in
    running)
      pid=$(subctl_evy_pid)
      printf "%s● subctl evy running%s\n" "$C_GRN" "$C_RST"
      printf "  Label:    %s\n" "$SUBCTL_EVY_LABEL"
      printf "  PID:      %s\n" "${pid:-?}"
      ;;
    stopped)
      printf "%s○ subctl evy stopped%s (auto-start enabled)\n" "$C_YLW" "$C_RST"
      printf "  Plist:    %s\n" "$SUBCTL_EVY_PLIST"
      ;;
    not-installed)
      printf "%s○ subctl evy not enabled%s\n" "$C_DIM" "$C_RST"
      printf "  Enable:   subctl evy enable\n"
      ;;
  esac

  if [[ -f "$SUBCTL_EVY_PAUSED_FLAG" ]]; then
    printf "  Loop:     %s⏸ PAUSED%s (resume: subctl evy resume)\n" "$C_YLW" "$C_RST"
  fi

  if [[ -f "$SUBCTL_EVY_LOG" ]]; then
    printf "\n%s──── evy.log (last 10) ────%s\n" "$C_DIM" "$C_RST"
    tail -n 10 "$SUBCTL_EVY_LOG"
  fi

  local providers="$SUBCTL_EVY_STATE_DIR/providers.json"
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
subctl_evy_logs() {
  local follow=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--follow) follow=true; shift ;;
      *) shift ;;
    esac
  done
  if [[ ! -f "$SUBCTL_EVY_LOG" ]]; then
    subctl_warn "no log yet at $SUBCTL_EVY_LOG"
    subctl_info "  (created on first subctl evy boot — try: subctl evy enable)"
    return 1
  fi
  if $follow; then
    tail -f "$SUBCTL_EVY_LOG"
  else
    tail -n 50 "$SUBCTL_EVY_LOG"
  fi
}

# ── prompt: queue a one-shot user message for the daemon ────────────────────
# Mechanism: append a JSONL entry to ~/.config/subctl/evy/cli-prompts.jsonl.
# components/evy/evy-notify-listener.ts polls this file (offset-tracked)
# and pushes entries into the same in-process queue as Telegram messages, so
# the agent loop has ONE source of operator input.
subctl_evy_prompt() {
  local text="${1:-}"
  if [[ -z "$text" ]]; then
    subctl_err "usage: subctl evy prompt \"<text>\""
    return 1
  fi
  mkdir -p "$SUBCTL_EVY_STATE_DIR"
  subctl_require jq "install: brew install jq" || return 1

  local payload
  payload=$(jq -nc \
    --arg ts "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg text "$text" \
    --arg user "${USER:-cli}" \
    '{ts: $ts, text: $text, source: "cli", user: $user}')
  printf "%s\n" "$payload" >> "$SUBCTL_EVY_CLI_PROMPTS"
  subctl_ok "queued for subctl evy: ${text:0:80}"
  subctl_info "the daemon picks up cli-prompts on its next poll cycle (~2s)"

  # Soft warning if the daemon isn't running — the prompt will wait until it is.
  if [[ "$(subctl_evy_state)" != "running" ]]; then
    subctl_warn "subctl evy is not running — prompt will be processed when you 'subctl evy enable'"
  fi
}

# ── providers / policy: inspect active config ───────────────────────────────
subctl_evy_providers() {
  local f="$SUBCTL_EVY_STATE_DIR/providers.json"
  if [[ ! -f "$f" ]]; then
    subctl_warn "providers.json not found at $f"
    subctl_info "  (seeded from .example on first 'subctl evy enable')"
    return 1
  fi
  if subctl_have jq; then
    jq . "$f"
  else
    cat "$f"
  fi
}

subctl_evy_policy() {
  local f="$SUBCTL_EVY_STATE_DIR/policy.json"
  if [[ ! -f "$f" ]]; then
    subctl_warn "policy.json not found at $f"
    subctl_info "  (seeded from .example on first 'subctl evy enable')"
    return 1
  fi
  if subctl_have jq; then
    jq . "$f"
  else
    cat "$f"
  fi
}

# ── pause / resume: file-flag the daemon's loop checks each tick ────────────
subctl_evy_pause() {
  mkdir -p "$SUBCTL_EVY_STATE_DIR"
  date -u +'%Y-%m-%dT%H:%M:%SZ' > "$SUBCTL_EVY_PAUSED_FLAG"
  subctl_ok "subctl evy review loop PAUSED"
  subctl_info "  flag: $SUBCTL_EVY_PAUSED_FLAG"
  subctl_info "  the daemon checks this each tick — already-running tools will complete"
}

subctl_evy_resume() {
  if [[ -f "$SUBCTL_EVY_PAUSED_FLAG" ]]; then
    rm -f "$SUBCTL_EVY_PAUSED_FLAG"
    subctl_ok "subctl evy review loop RESUMED"
  else
    subctl_info "subctl evy was not paused"
  fi
}

# ── restart ─────────────────────────────────────────────────────────────────
subctl_evy_restart() {
  subctl_evy_disable
  sleep 1
  subctl_evy_enable
}
