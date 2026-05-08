#!/usr/bin/env bash
# components/notify/notify.sh — Telegram escalation hook for subctl.
#
# Pure bash + curl. Standalone — no external connector frameworks
# required, no Python deps, no external services beyond Telegram itself.
# Anyone with a Telegram bot token + chat id can use this.
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
  local token="" chat="" silent=false dry_run=false use_markdown=false
  local -a positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --token)        token="$2"; shift 2 ;;
      --chat)         chat="$2"; shift 2 ;;
      --silent)       silent=true; shift ;;
      --markdown)     use_markdown=true; shift ;;
      --dry-run|-n)   dry_run=true; shift ;;
      --setup)        subctl_notify_setup; return $? ;;
      --test)         subctl_notify_test; return $? ;;
      --status)       subctl_notify_status; return $? ;;
      --diagnose)     subctl_notify_diagnose; return $? ;;
      -h|--help)
        cat <<EOF
subctl notify <message> [opts]

  Send a Telegram message to your operator chat. Used by orchestrators
  to escalate when a decision is needed and the user is AFK.

  --token X        bot token (default: env TELEGRAM_BOT_TOKEN, then config)
  --chat  Y        chat id   (default: env TELEGRAM_CHAT_ID, then config)
  --silent         suppress Telegram's notification sound
  --markdown       use Markdown parse_mode (default: plain text — safer for
                   messages with paths, underscores, or special chars)
  --dry-run, -n    don't send; just print the payload + log line
  --setup          interactive: store token + chat id in config
  --test           send a test message
  --status         show current config (token redacted)
  --diagnose       run end-to-end check: bot alive, chat history, identify
                   what's wrong if --test fails

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

  # Build payload — plain-text by default (Markdown is opt-in via --markdown
  # because hostnames/paths frequently contain underscores or asterisks that
  # break Telegram's Markdown parser with HTTP 400).
  local prefix="🚨 subctl · ${cwd_short}"
  local payload
  if $use_markdown; then
    # Best-effort markdown — caller is on the hook for clean syntax
    prefix="🚨 *subctl* · \`${cwd_short}\`"
    payload=$(jq -nc \
      --arg chat "$chat" \
      --arg text "$prefix"$'\n\n'"$message" \
      --argjson silent "$silent" \
      '{chat_id: $chat, text: $text, parse_mode: "Markdown", disable_notification: $silent}')
  else
    payload=$(jq -nc \
      --arg chat "$chat" \
      --arg text "$prefix"$'\n\n'"$message" \
      --argjson silent "$silent" \
      '{chat_id: $chat, text: $text, disable_notification: $silent}')
  fi

  if $dry_run; then
    echo "→ would POST to https://api.telegram.org/bot<redacted>/sendMessage"
    echo "  payload: $payload"
    return 0
  fi

  # NOT using -f — we want the response body on errors so callers see what
  # Telegram actually rejected (e.g. "can't parse entities at offset N").
  local resp http_code body
  resp=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    -w $'\n__HTTP_CODE__:%{http_code}' \
    "https://api.telegram.org/bot${token}/sendMessage" 2>&1)
  http_code=$(echo "$resp" | grep -oE '__HTTP_CODE__:[0-9]+' | cut -d: -f2)
  body=$(echo "$resp" | sed '/__HTTP_CODE__:/d')

  if [[ "$http_code" == "200" ]]; then
    subctl_ok "notification sent (logged to $NOTIFY_LOG)"
    return 0
  else
    subctl_err "Telegram API returned HTTP $http_code"
    # Print the description Telegram returned (helps debug)
    local desc
    desc=$(echo "$body" | jq -r '.description // empty' 2>/dev/null)
    [[ -n "$desc" ]] && subctl_err "  $desc"
    echo "$body" | head -c 400
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

# ── --diagnose: end-to-end health check ────────────────────────────────────
subctl_notify_diagnose() {
  local token chat
  token="${TELEGRAM_BOT_TOKEN:-}"
  chat="${TELEGRAM_CHAT_ID:-}"
  if [[ -f "$NOTIFY_CONFIG" ]]; then
    [[ -z "$token" ]] && token=$(jq -r '.telegram_bot_token // empty' "$NOTIFY_CONFIG" 2>/dev/null)
    [[ -z "$chat" ]]  && chat=$(jq -r '.telegram_chat_id // empty'   "$NOTIFY_CONFIG" 2>/dev/null)
  fi
  if [[ -z "$token" ]]; then
    subctl_err "no bot token configured — run: subctl notify --setup"
    return 1
  fi

  echo "=== subctl notify · diagnose ==="
  echo

  # Step 1: getMe — does the token correspond to a real, live bot?
  echo "[1/3] Verifying bot identity (getMe)..."
  local me_resp
  me_resp=$(curl -sS "https://api.telegram.org/bot${token}/getMe" 2>&1)
  local me_ok
  me_ok=$(echo "$me_resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$me_ok" != "true" ]]; then
    subctl_err "  bot token rejected by Telegram"
    echo "  $(echo "$me_resp" | jq -r '.description // .' 2>/dev/null | head -c 200)"
    echo
    echo "Likely cause: bot token in config is wrong, expired, or revoked."
    echo "Fix: run 'subctl notify --setup' and paste a fresh token from @BotFather."
    return 1
  fi
  local username first
  username=$(echo "$me_resp" | jq -r '.result.username')
  first=$(echo "$me_resp" | jq -r '.result.first_name')
  echo "  ✓ bot is live: @${username} (\"${first}\")"
  echo

  # Step 2: getUpdates — has anyone messaged this bot?
  echo "[2/3] Checking incoming message history (getUpdates)..."
  local updates_resp updates_count
  updates_resp=$(curl -sS "https://api.telegram.org/bot${token}/getUpdates" 2>&1)
  updates_count=$(echo "$updates_resp" | jq -r '.result | length' 2>/dev/null)
  if [[ "$updates_count" == "0" ]] || [[ -z "$updates_count" ]]; then
    subctl_err "  ✗ no messages in this bot's recent history"
    echo
    echo "Likely cause: you haven't sent the bot any message yet, OR Telegram"
    echo "has GC'd the queue (it auto-clears after ~24h or after webhooks/polls)."
    echo
    echo "Fix:"
    echo "  1. Open Telegram on your phone"
    echo "  2. Search for: @${username}"
    echo "  3. Tap 'Start' (or send any message — '/start' is the convention)"
    echo "  4. Re-run: subctl notify --diagnose"
    return 1
  fi
  echo "  ✓ ${updates_count} message(s) in recent history"
  echo
  echo "  Chats that have messaged @${username}:"
  echo "$updates_resp" | jq -r '
    [.result[].message.chat | select(. != null) | {id, type, first: (.first_name // ""), username: (.username // "")}]
    | unique_by(.id)
    | .[]
    | "    chat_id=\(.id)  type=\(.type)  name=\"\(.first)\"  @\(.username)"
  ' 2>/dev/null

  # Step 3: try sending to the configured chat
  echo
  echo "[3/3] Attempting send to configured chat_id (${chat})..."
  local send_resp send_ok
  send_resp=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    --data "$(jq -nc --arg c "$chat" --arg t "🧪 diagnose ping from subctl" '{chat_id:$c, text:$t}')" \
    "https://api.telegram.org/bot${token}/sendMessage" 2>&1)
  send_ok=$(echo "$send_resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$send_ok" == "true" ]]; then
    echo "  ✓ message sent — Telegram should show it on your phone now"
    return 0
  fi

  local err_desc
  err_desc=$(echo "$send_resp" | jq -r '.description // .' 2>/dev/null | head -c 200)
  subctl_err "  send failed: ${err_desc}"
  echo
  case "$err_desc" in
    *"chat not found"*)
      local correct_id
      correct_id=$(echo "$updates_resp" | jq -r '.result[].message.chat.id' 2>/dev/null | sort -u | head -1)
      echo "Diagnosis: configured chat_id (${chat}) doesn't match any chat that"
      echo "has messaged this bot."
      if [[ -n "$correct_id" ]]; then
        echo
        echo "It looks like the right chat_id is: ${correct_id}"
        echo
        echo "To fix:"
        echo "  jq '.telegram_chat_id = \"${correct_id}\"' $NOTIFY_CONFIG > /tmp/n && mv /tmp/n $NOTIFY_CONFIG"
        echo "  chmod 600 $NOTIFY_CONFIG"
        echo "  subctl notify --test"
      else
        echo "(could not auto-detect — try messaging the bot first)"
      fi
      ;;
    *"bot was blocked"*)
      echo "Diagnosis: you blocked this bot. Unblock in Telegram, send /start, retry."
      ;;
    *"not enough rights"*)
      echo "Diagnosis: bot doesn't have permission in that group/channel."
      ;;
    *)
      echo "Diagnosis: see Telegram's error description above."
      echo "Full response: ${send_resp}"
      ;;
  esac
  return 1
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
