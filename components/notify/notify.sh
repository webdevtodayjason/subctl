#!/usr/bin/env bash
# components/notify/notify.sh — Telegram escalation hook for subctl.
#
# Pure bash + curl. Independent of argent-core/aos-telegram (which is the
# AOS connector framework's heavier wrapper). Both layers can coexist —
# this one is for fast in-session escalations from any agent.
#
# Sends a POST to the Telegram Bot API's sendMessage endpoint. Reads token
# + chat_id from (in order):
#   1. CLI flags  --token / --chat (rare; mostly for testing)
#   2. Env vars   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
#   3. Config file ~/.config/subctl/notify.json
#
# Always logs to ~/.claude/notification.log regardless of send success.

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

NOTIFY_CONFIG="$SUBCTL_CONFIG_DIR/notify.json"
NOTIFY_LOG="$HOME/.claude/notification.log"

# ── public: subctl_notify <message> [--token X] [--chat Y] [--silent] ───────
subctl_notify() {
  local token="" chat="" silent=false dry_run=false
  local -a positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --token)        token="$2"; shift 2 ;;
      --chat)         chat="$2"; shift 2 ;;
      --silent)       silent=true; shift ;;
      --dry-run|-n)   dry_run=true; shift ;;
      --setup)        subctl_notify_setup; return $? ;;
      --test)         subctl_notify_test; return $? ;;
      --status)       subctl_notify_status; return $? ;;
      -h|--help)
        cat <<EOF
subctl notify <message> [opts]

  Send a Telegram message to your operator chat. Used by orchestrators
  to escalate when a decision is needed and the user is AFK.

  --token X        bot token (default: env TELEGRAM_BOT_TOKEN, then config)
  --chat  Y        chat id   (default: env TELEGRAM_CHAT_ID, then config)
  --silent         suppress Telegram's notification sound
  --dry-run, -n    don't send; just print the payload + log line
  --setup          interactive: store token + chat id in config
  --test           send a test message
  --status         show current config (token redacted)

Examples:
  subctl notify "Stuck: shannon prisma migration needs decision"
  subctl notify --setup
  subctl notify --test
EOF
        return 0 ;;
      *) positional+=("$1"); shift ;;
    esac
  done

  local message="${positional[*]:-}"
  if [[ -z "$message" ]]; then
    subctl_err "no message — usage: subctl notify <message>"
    return 1
  fi

  # Resolve token + chat (flags > env > config)
  if [[ -z "$token" ]]; then token="${TELEGRAM_BOT_TOKEN:-}"; fi
  if [[ -z "$chat" ]];  then chat="${TELEGRAM_CHAT_ID:-}";    fi
  if [[ -z "$token" ]] || [[ -z "$chat" ]]; then
    if [[ -f "$NOTIFY_CONFIG" ]]; then
      [[ -z "$token" ]] && token=$(jq -r '.telegram_bot_token // empty' "$NOTIFY_CONFIG" 2>/dev/null)
      [[ -z "$chat" ]]  && chat=$(jq -r '.telegram_chat_id // empty'   "$NOTIFY_CONFIG" 2>/dev/null)
    fi
  fi

  # Always log (so notifications are auditable even when send fails)
  mkdir -p "$(dirname "$NOTIFY_LOG")"
  local cwd_short
  cwd_short=$(pwd | sed "s|$HOME|~|")
  printf "%s | cwd=%s | %s\n" \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$cwd_short" "$message" >> "$NOTIFY_LOG"

  if [[ -z "$token" ]] || [[ -z "$chat" ]]; then
    subctl_warn "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — logged to $NOTIFY_LOG only"
    subctl_info "set up via: subctl notify --setup"
    return 1
  fi

  # Build payload — prefix with cwd so messages are self-contained
  local prefix="🚨 *subctl* · \`$cwd_short\`"
  local payload
  payload=$(jq -nc \
    --arg chat "$chat" \
    --arg text "$prefix\n\n$message" \
    --argjson silent "$silent" \
    '{chat_id: $chat, text: $text, parse_mode: "Markdown", disable_notification: $silent}')

  if $dry_run; then
    echo "→ would POST to https://api.telegram.org/bot<redacted>/sendMessage"
    echo "  payload: $payload"
    return 0
  fi

  local resp http_code
  resp=$(curl -fsS -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    -w "\n__HTTP_CODE__:%{http_code}" \
    "https://api.telegram.org/bot${token}/sendMessage" 2>&1)
  http_code=$(echo "$resp" | grep -oE '__HTTP_CODE__:[0-9]+' | cut -d: -f2)

  if [[ "$http_code" == "200" ]]; then
    subctl_ok "notification sent (logged to $NOTIFY_LOG)"
    return 0
  else
    subctl_err "Telegram API returned HTTP $http_code"
    echo "$resp" | head -c 400
    echo
    return 1
  fi
}

# ── --setup: interactive wizard ────────────────────────────────────────────
subctl_notify_setup() {
  subctl_ensure_config_dir
  cat <<EOF

subctl notify setup

Stores your Telegram bot token + chat id at: $NOTIFY_CONFIG

To get a bot token:
  1. Open Telegram, search @BotFather, /start
  2. /newbot, follow prompts, copy the token

To find your chat id:
  1. Send any message to your new bot
  2. Visit https://api.telegram.org/bot<TOKEN>/getUpdates
  3. Look for "chat":{"id": <number>}

EOF
  read -r -p "Telegram bot token: " token
  if [[ -z "$token" ]]; then
    subctl_err "no token — aborting"
    return 1
  fi
  read -r -p "Telegram chat id (numeric): " chat
  if [[ -z "$chat" ]]; then
    subctl_err "no chat id — aborting"
    return 1
  fi

  # Write config (mode 600 — token is sensitive)
  jq -n --arg token "$token" --arg chat "$chat" \
    '{telegram_bot_token: $token, telegram_chat_id: $chat}' > "$NOTIFY_CONFIG"
  chmod 600 "$NOTIFY_CONFIG"
  subctl_ok "saved → $NOTIFY_CONFIG (mode 600)"
  echo
  echo "Test it:  subctl notify --test"
}

# ── --test ──────────────────────────────────────────────────────────────────
subctl_notify_test() {
  subctl_notify "🧪 Test from subctl notify · $(hostname) · $(date '+%H:%M:%S %Z')"
}

# ── --status ────────────────────────────────────────────────────────────────
subctl_notify_status() {
  local token_src="missing" chat_src="missing"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then token_src="env"; fi
  if [[ -n "${TELEGRAM_CHAT_ID:-}" ]];  then chat_src="env";   fi
  if [[ -f "$NOTIFY_CONFIG" ]]; then
    local cfg_token cfg_chat
    cfg_token=$(jq -r '.telegram_bot_token // empty' "$NOTIFY_CONFIG" 2>/dev/null)
    cfg_chat=$(jq -r '.telegram_chat_id // empty'   "$NOTIFY_CONFIG" 2>/dev/null)
    [[ "$token_src" == "missing" ]] && [[ -n "$cfg_token" ]] && token_src="config"
    [[ "$chat_src" == "missing" ]]  && [[ -n "$cfg_chat" ]]  && chat_src="config"
  fi
  printf "  Config file: %s%s\n" "$NOTIFY_CONFIG" \
    "$([[ -f "$NOTIFY_CONFIG" ]] && echo " ✓" || echo " (not present)")"
  printf "  Bot token:   %s\n" "$token_src"
  printf "  Chat id:     %s\n" "$chat_src"
  printf "  Log:         %s%s\n" "$NOTIFY_LOG" \
    "$([[ -f "$NOTIFY_LOG" ]] && printf " (%d lines)" "$(wc -l < "$NOTIFY_LOG" | tr -d ' ')" || echo "")"
}
