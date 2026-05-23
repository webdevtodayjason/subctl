#!/usr/bin/env bash
# providers/deepseek/signals.sh — provider interface for emitting CodeWhale
# (deepseek) account signals to the dashboard / radar.
#
# Mirrors providers/pi-coding-agent/signals.sh shape but reads codewhale's
# session state inside the per-alias HOME-shadow dir.

[[ -n "${_SUBCTL_DEEPSEEK_SIGNALS_LOADED:-}" ]] && return 0
_SUBCTL_DEEPSEEK_SIGNALS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Resolve the HOME-shadow root for a deepseek alias. Prefer the path pinned
# by auth.sh in cfg_dir/.subctl-deepseek-home; fall back to the
# derive-from-alias convention.
_provider_deepseek_signals_home_dir() {
  local alias="$1" cfg_dir="$2"
  if [[ -n "$cfg_dir" && -f "$cfg_dir/.subctl-deepseek-home" ]]; then
    head -1 "$cfg_dir/.subctl-deepseek-home"
    return
  fi
  printf '%s\n' "$HOME/.subctl-deepseek-aliases/$alias"
}

# Auth status of a deepseek account: ready | empty | missing.
# Mirrors auth.sh's _provider_deepseek_auth_status — duplicated here to
# avoid sourcing auth.sh into the signals hot path.
_provider_deepseek_signals_auth_status() {
  local dsk_home="$1"
  [[ -d "$dsk_home" ]] || { echo missing; return; }
  if [[ -f "$dsk_home/.deepseek/config.toml" ]] \
     && grep -qE '^[[:space:]]*api_key[[:space:]]*=' "$dsk_home/.deepseek/config.toml" 2>/dev/null; then
    echo ready; return
  fi
  if [[ -d "$dsk_home/.deepseek/secrets" ]] \
     && [[ -n "$(ls -A "$dsk_home/.deepseek/secrets" 2>/dev/null)" ]]; then
    echo ready; return
  fi
  echo empty
}

# Implements provider interface: provider_signals <alias>
# Outputs JSON shaped like the dashboard's /api/state.accounts[] entry.
provider_deepseek_signals() {
  local alias="$1"
  local cfg_dir email
  cfg_dir=$(subctl_account_field "$alias" 4)
  email=$(subctl_account_field "$alias" 3)

  if [[ -z "$cfg_dir" ]]; then
    echo '{"alias":"'"$alias"'","provider":"deepseek","auth_status":"unknown","error":"alias not found"}'
    return 1
  fi

  local dsk_home auth active_sessions last_activity
  dsk_home=$(_provider_deepseek_signals_home_dir "$alias" "$cfg_dir")
  auth=$(_provider_deepseek_signals_auth_status "$dsk_home")

  # Active sessions: count of session files in the codewhale sessions dir
  # touched in the last 2 minutes. Codewhale writes session data under
  # ~/.deepseek/sessions/; the file extension hasn't stabilized publicly
  # (we saw .jsonl on one machine, but the docs don't lock it in), so we
  # match any file. Mirrors the claude/pi radar's 2-minute liveness window.
  if [[ -d "$dsk_home/.deepseek/sessions" ]]; then
    active_sessions=$(find "$dsk_home/.deepseek/sessions" \
      -maxdepth 3 -type f -mmin -2 2>/dev/null \
      | wc -l | tr -d ' ')
  else
    active_sessions=0
  fi

  # Last activity = most recent session-file mtime in this account's
  # sessions dir. Same shape as pi-coding-agent's signal.
  if [[ -d "$dsk_home/.deepseek/sessions" ]]; then
    last_activity=$(find "$dsk_home/.deepseek/sessions" \
      -maxdepth 3 -type f \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
    if [[ -n "$last_activity" ]]; then
      last_activity=$(( $(date +%s) - last_activity ))
    else
      last_activity=null
    fi
  else
    last_activity=null
  fi

  # rl_hits_today is provider-specific (Anthropic-emitted RL events for
  # claude). CodeWhale has no equivalent today — DeepSeek's API surfaces
  # rate-limit headers, but codewhale doesn't persist them to a known
  # location. Emit 0 to keep the JSON shape parallel; v3.0.0-rc2 can wire
  # this up once the parsing logic is built.
  jq -nc --arg alias "$alias" --arg email "$email" --arg cfg "$cfg_dir" \
         --arg dsk_home "$dsk_home" --arg auth "$auth" \
         --argjson sess "$active_sessions" \
         --argjson last "$last_activity" '
    {
      alias: $alias,
      provider: "deepseek",
      email: $email,
      config_dir: $cfg,
      deepseek_home: $dsk_home,
      auth_status: $auth,
      active_sessions: $sess,
      rl_hits_today: 0,
      last_activity_seconds_ago: $last
    }'
}
