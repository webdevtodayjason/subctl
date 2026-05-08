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
      --diagnose)     shift; subctl_notify_diagnose "$@"; return $? ;;
      ask-yesno)      shift; subctl_notify_ask_yesno "$@"; return $? ;;
      ask-choice)     shift; subctl_notify_ask_choice "$@"; return $? ;;
      ask-text)       shift; subctl_notify_ask_text "$@"; return $? ;;
      inbox)          shift; subctl_notify_inbox "$@"; return $? ;;
      inbox-ack)      shift; subctl_notify_inbox_ack "$@"; return $? ;;
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
  --diagnose       passive health check: bot alive + chat history + config
                   sanity (does NOT send a ping by default)
  --diagnose --send  same checks PLUS deliver a live test message

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
# By default does NOT send a test message — just verifies bot + lists chats.
# Pass --send to actually deliver a ping (use --test for that idiomatically).
subctl_notify_diagnose() {
  local should_send=false
  for arg in "$@"; do
    case "$arg" in
      --send) should_send=true ;;
    esac
  done

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

  # Step 3: optional live send (skip by default — diagnose is read-only).
  if ! $should_send; then
    echo
    echo "[3/3] Skipping live send (use --send to ping, or 'subctl notify --test')"
    # Sanity-check the chat_id matches a chat that's messaged the bot.
    local known_ids
    known_ids=$(echo "$updates_resp" | jq -r '.result[].message.chat.id' 2>/dev/null | sort -u)
    if [[ -n "$known_ids" ]] && ! echo "$known_ids" | grep -qx "$chat"; then
      subctl_warn "configured chat_id ($chat) doesn't match any chat that has messaged the bot"
      echo "  Known chat ids: $(echo "$known_ids" | tr '\n' ' ')"
      echo "  --test would likely fail until you fix the config or message the bot first."
      return 1
    fi
    subctl_ok "configured chat_id matches a known chat — looks good"
    return 0
  fi

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

# ── ask protocol — structured Q&A via Telegram inline keyboards ─────────────

# Internal: read token + chat from env or config (DRY)
_subctl_notify_creds() {
  local token chat
  token="${TELEGRAM_BOT_TOKEN:-}"
  chat="${TELEGRAM_CHAT_ID:-}"
  if [[ -f "$NOTIFY_CONFIG" ]]; then
    [[ -z "$token" ]] && token=$(jq -r '.telegram_bot_token // empty' "$NOTIFY_CONFIG" 2>/dev/null)
    [[ -z "$chat" ]]  && chat=$(jq -r '.telegram_chat_id // empty'   "$NOTIFY_CONFIG" 2>/dev/null)
  fi
  printf "%s\t%s\n" "$token" "$chat"
}

# Auto-generate a question id if not provided.
_subctl_notify_genid() {
  printf "Q%s\n" "$(date +%s)"
}

# Internal: send a message with an inline keyboard via Telegram bot API.
# Args: $1 = chat_id, $2 = token, $3 = text, $4 = json keyboard array
_subctl_notify_send_keyboard() {
  local chat="$1" token="$2" text="$3" keyboard="$4"
  local payload
  payload=$(jq -nc \
    --arg chat "$chat" \
    --arg text "$text" \
    --argjson kb "$keyboard" \
    '{chat_id: $chat, text: $text, reply_markup: {inline_keyboard: $kb}}')
  local resp
  resp=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "https://api.telegram.org/bot${token}/sendMessage" 2>&1)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then return 0; fi
  echo "$resp" | head -c 400 >&2
  return 1
}

# subctl notify ask-yesno "<question>" [--id Q42] [--timeout 30m] [--default yes|no] [--wait]
subctl_notify_ask_yesno() {
  local question="" qid="" timeout="" default="" wait=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)       qid="$2"; shift 2 ;;
      --timeout)  timeout="$2"; shift 2 ;;
      --default)  default="$2"; shift 2 ;;
      --wait)     wait=true; shift ;;
      -h|--help)
        echo "subctl notify ask-yesno <question> [--id Q42] [--timeout DUR] [--default yes|no] [--wait]"
        return 0 ;;
      *) [[ -z "$question" ]] && question="$1" || question="$question $1"; shift ;;
    esac
  done
  [[ -z "$question" ]] && { subctl_err "no question — usage: subctl notify ask-yesno <question>"; return 1; }
  [[ -z "$qid" ]] && qid=$(_subctl_notify_genid)

  local creds token chat
  creds=$(_subctl_notify_creds)
  token=$(echo "$creds" | cut -f1)
  chat=$(echo "$creds" | cut -f2)
  if [[ -z "$token" || -z "$chat" ]]; then
    subctl_err "no token/chat configured — run: subctl notify --setup"
    return 1
  fi

  local cwd_short
  cwd_short=$(pwd | sed "s|$HOME|~|")
  local text="🚨 subctl · ${cwd_short} · [${qid}]

${question}"

  # Inline keyboard: [Yes][No]. callback_data = "Q42:yes" / "Q42:no"
  local keyboard
  keyboard=$(jq -nc --arg q "$qid" '[[
    {text: "✅ Yes", callback_data: ($q + ":yes")},
    {text: "❌ No",  callback_data: ($q + ":no")}
  ]]')

  if _subctl_notify_send_keyboard "$chat" "$token" "$text" "$keyboard"; then
    subctl_ok "ask-yesno sent · id=${qid}"
  else
    subctl_err "send failed"
    return 1
  fi

  echo "$qid"  # printed to stdout so callers can capture it

  if $wait; then
    _subctl_notify_inbox_wait "$qid" "${timeout:-1h}" "$default"
  fi
}

# subctl notify ask-choice "<question>" -o A:label1 -o B:label2 [--id Q42] [--wait] ...
subctl_notify_ask_choice() {
  local question="" qid="" timeout="" default="" wait=false
  local -a options=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -o|--option) options+=("$2"); shift 2 ;;
      --id)        qid="$2"; shift 2 ;;
      --timeout)   timeout="$2"; shift 2 ;;
      --default)   default="$2"; shift 2 ;;
      --wait)      wait=true; shift ;;
      -h|--help)
        cat <<EOF
subctl notify ask-choice <question> -o ID:label [-o ID:label …] [opts]

Send a multi-button question to your Telegram bot. Each --option becomes
a button; the user's tap is captured as 'choice_id' in the inbox.

Options:
  -o ID:label   button definition (label is what user sees, ID is the
                short code returned in the inbox). Repeatable, 1-8 times.
  --id Q42      explicit question id (default: Qts auto-generated)
  --timeout DUR with --wait, time to block (e.g. 30m, 1h, 90s)
  --default ID  fallback choice if --wait times out
  --wait        block until reply arrives or timeout

Example:
  subctl notify ask-choice "Migration approach?" \\
    -o A:drop-fk-recreate \\
    -o B:migrate-and-backfill \\
    -o C:defer \\
    --id Q42 --wait --timeout 30m --default C
EOF
        return 0 ;;
      *) [[ -z "$question" ]] && question="$1" || question="$question $1"; shift ;;
    esac
  done
  [[ -z "$question" ]] && { subctl_err "no question"; return 1; }
  [[ ${#options[@]} -lt 1 ]] && { subctl_err "no options — use -o ID:label at least once"; return 1; }
  [[ ${#options[@]} -gt 8 ]] && { subctl_err "max 8 options (Telegram limit)"; return 1; }
  [[ -z "$qid" ]] && qid=$(_subctl_notify_genid)

  local creds token chat
  creds=$(_subctl_notify_creds)
  token=$(echo "$creds" | cut -f1)
  chat=$(echo "$creds" | cut -f2)
  if [[ -z "$token" || -z "$chat" ]]; then
    subctl_err "no token/chat configured — run: subctl notify --setup"
    return 1
  fi

  local cwd_short
  cwd_short=$(pwd | sed "s|$HOME|~|")
  local body="🚨 subctl · ${cwd_short} · [${qid}]\n\n${question}\n"
  # Show the option mapping in the message body too
  for opt in "${options[@]}"; do
    body="${body}\n• ${opt}"
  done
  # printf-friendly text (escape -e style)
  local text
  text=$(printf "%b" "$body")

  # Build keyboard JSON: one button per option, vertical stack
  local kb_json
  kb_json=$(printf '%s\n' "${options[@]}" | jq -R --arg q "$qid" '
    split(":") as $p
    | [{text: ($p[0] // "?") + ": " + ($p[1] // ""), callback_data: ($q + ":" + ($p[0] // "?") + ":" + ($p[1] // ""))}]
  ' | jq -s '.')

  if _subctl_notify_send_keyboard "$chat" "$token" "$text" "$kb_json"; then
    subctl_ok "ask-choice sent · id=${qid} · ${#options[@]} options"
  else
    subctl_err "send failed"
    return 1
  fi
  echo "$qid"

  if $wait; then
    _subctl_notify_inbox_wait "$qid" "${timeout:-1h}" "$default"
  fi
}

# subctl notify ask-text "<question>" [--id Q42] [--wait] [--timeout DUR]
# Telegram supports force_reply to prompt the user with a reply box.
subctl_notify_ask_text() {
  local question="" qid="" timeout="" wait=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)      qid="$2"; shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      --wait)    wait=true; shift ;;
      -h|--help)
        echo "subctl notify ask-text <question> [--id Q42] [--wait] [--timeout DUR]"
        return 0 ;;
      *) [[ -z "$question" ]] && question="$1" || question="$question $1"; shift ;;
    esac
  done
  [[ -z "$question" ]] && { subctl_err "no question"; return 1; }
  [[ -z "$qid" ]] && qid=$(_subctl_notify_genid)

  local creds token chat
  creds=$(_subctl_notify_creds)
  token=$(echo "$creds" | cut -f1)
  chat=$(echo "$creds" | cut -f2)
  if [[ -z "$token" || -z "$chat" ]]; then
    subctl_err "no token/chat configured — run: subctl notify --setup"
    return 1
  fi

  local cwd_short
  cwd_short=$(pwd | sed "s|$HOME|~|")
  local text="🚨 subctl · ${cwd_short} · [${qid}]

${question}

Reply to this message with your answer."

  local payload
  payload=$(jq -nc \
    --arg chat "$chat" \
    --arg text "$text" \
    '{chat_id: $chat, text: $text, reply_markup: {force_reply: true, selective: true}}')
  local resp
  resp=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "https://api.telegram.org/bot${token}/sendMessage" 2>&1)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" != "true" ]]; then
    subctl_err "send failed"
    echo "$resp" | head -c 200 >&2
    return 1
  fi
  subctl_ok "ask-text sent · id=${qid}"
  echo "$qid"

  if $wait; then
    _subctl_notify_inbox_wait "$qid" "${timeout:-1h}" ""
  fi
}

# subctl notify inbox [--id Q42] [--unacked] [--limit 20] [--json]
# Lists inbox entries from the listener (or empty if listener isn't running).
subctl_notify_inbox() {
  local qid="" unacked=false limit=20 json=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)       qid="$2"; shift 2 ;;
      --unacked)  unacked=true; shift ;;
      --limit)    limit="$2"; shift 2 ;;
      --json)     json=true; shift ;;
      *) shift ;;
    esac
  done

  # Fetch from dashboard API if running; fall back to direct file read.
  local source="(none)" data="[]"
  if curl -sS --max-time 2 -o /tmp/_subctl_inbox.json \
       "http://127.0.0.1:8787/api/notify/inbox?$(\
         [[ -n "$qid" ]] && echo "question_id=$qid&"
         [[ "$unacked" == "true" ]] && echo "unacked_only=1&"
         echo "limit=$limit"
       )" 2>/dev/null; then
    source="dashboard-api"
    data=$(jq '.entries // []' /tmp/_subctl_inbox.json)
  elif [[ -f "$HOME/.config/subctl/inbox.jsonl" ]]; then
    source="file"
    data=$(tac "$HOME/.config/subctl/inbox.jsonl" 2>/dev/null \
      | head -n "$limit" \
      | jq -s '.')
    if [[ -n "$qid" ]]; then
      data=$(echo "$data" | jq --arg q "$qid" '[ .[] | select(.question_id == $q) ]')
    fi
    if $unacked; then
      data=$(echo "$data" | jq '[ .[] | select(.acked != true) ]')
    fi
  fi

  if $json; then
    echo "$data"
    return 0
  fi

  local count
  count=$(echo "$data" | jq 'length')
  if [[ "$count" == "0" ]]; then
    subctl_info "📭 inbox empty (source: $source)"
    return 0
  fi
  echo "$data" | jq -r '.[] | "  \(.ts | .[11:19])Z  \([.question_id // "—"][0])  \([.type])  \([.answer_label // .answer // .raw_text // ""])"'
}

# subctl notify inbox-ack <question_id>
subctl_notify_inbox_ack() {
  local qid="${1:-}"
  [[ -z "$qid" ]] && { subctl_err "usage: subctl notify inbox-ack <question_id>"; return 1; }
  if curl -sS --max-time 2 -X POST \
       -o /dev/null -w "%{http_code}" \
       "http://127.0.0.1:8787/api/notify/inbox/${qid}/ack" 2>/dev/null \
       | grep -q '^200$'; then
    subctl_ok "acked $qid"
  else
    subctl_err "ack failed (dashboard not running, or question not found)"
    return 1
  fi
}

# Internal: poll the inbox for an answer to a specific question id.
# Args: $1 = qid, $2 = timeout (5m, 30m, 1h), $3 = default-on-timeout (or empty)
_subctl_notify_inbox_wait() {
  local qid="$1" timeout_str="$2" default="$3"
  # Parse duration → seconds
  local timeout_sec
  case "$timeout_str" in
    *h) timeout_sec=$(( ${timeout_str%h} * 3600 )) ;;
    *m) timeout_sec=$(( ${timeout_str%m} * 60 )) ;;
    *s) timeout_sec=${timeout_str%s} ;;
    *)  timeout_sec=${timeout_str:-3600} ;;
  esac
  local deadline=$(( $(date +%s) + timeout_sec ))
  echo "  waiting up to ${timeout_str} for reply to ${qid}..." >&2
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 5
    local entries
    entries=$(subctl_notify_inbox --id "$qid" --json 2>/dev/null)
    if [[ -n "$entries" ]] && [[ "$entries" != "[]" ]]; then
      # Got a reply — print the answer to stdout, ack it
      local answer
      answer=$(echo "$entries" | jq -r '.[0].answer_label // .[0].answer // .[0].raw_text // empty')
      echo "$answer"
      subctl_notify_inbox_ack "$qid" >/dev/null 2>&1 || true
      return 0
    fi
  done
  if [[ -n "$default" ]]; then
    echo "$default"
    subctl_warn "timeout — falling back to default: $default" >&2
    return 0
  fi
  subctl_err "timeout — no reply received in ${timeout_str}, no default"
  return 2
}
