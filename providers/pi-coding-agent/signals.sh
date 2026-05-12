#!/usr/bin/env bash
# providers/pi-coding-agent/signals.sh — provider interface for emitting
# pi-coding-agent account signals to the dashboard / radar.
#
# Mirrors providers/claude/signals.sh shape but reads pi's session state
# inside the per-alias HOME-shadow dir.

[[ -n "${_SUBCTL_PI_SIGNALS_LOADED:-}" ]] && return 0
_SUBCTL_PI_SIGNALS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Resolve the HOME-shadow root for a pi alias. Prefer the path pinned by
# auth.sh in cfg_dir/.subctl-pi-home; fall back to the derive-from-alias
# convention.
_provider_pi_signals_home_dir() {
  local alias="$1" cfg_dir="$2"
  if [[ -n "$cfg_dir" && -f "$cfg_dir/.subctl-pi-home" ]]; then
    head -1 "$cfg_dir/.subctl-pi-home"
    return
  fi
  printf '%s\n' "$HOME/.subctl-pi-aliases/$alias"
}

# Auth status of a pi account: ready | empty | missing.
_provider_pi_signals_auth_status() {
  local pi_home="$1"
  [[ -d "$pi_home" ]] || { echo missing; return; }
  if [[ -f "$pi_home/.pi/agent/auth.json" ]]; then
    echo ready; return
  fi
  if [[ -d "$pi_home/.pi/agent/sessions" ]] \
     && [[ -n "$(ls -A "$pi_home/.pi/agent/sessions" 2>/dev/null)" ]]; then
    echo ready; return
  fi
  echo empty
}

# Implements provider interface: provider_signals <alias>
# Outputs JSON shaped like the dashboard's /api/state.accounts[] entry.
provider_pi_coding_agent_signals() {
  local alias="$1"
  local cfg_dir email
  cfg_dir=$(subctl_account_field "$alias" 4)
  email=$(subctl_account_field "$alias" 3)

  if [[ -z "$cfg_dir" ]]; then
    echo '{"alias":"'"$alias"'","provider":"pi-coding-agent","auth_status":"unknown","error":"alias not found"}'
    return 1
  fi

  local pi_home auth active_sessions last_activity
  pi_home=$(_provider_pi_signals_home_dir "$alias" "$cfg_dir")
  auth=$(_provider_pi_signals_auth_status "$pi_home")

  # Active sessions: count of jsonl files in the agent sessions dir that
  # have been touched in the last 2 minutes. Mirrors the claude radar's
  # 2-minute liveness window so cross-provider comparisons stay honest.
  if [[ -d "$pi_home/.pi/agent/sessions" ]]; then
    active_sessions=$(find "$pi_home/.pi/agent/sessions" \
      -maxdepth 2 -name '*.jsonl' -type f -mmin -2 2>/dev/null \
      | wc -l | tr -d ' ')
  else
    active_sessions=0
  fi

  # Last activity = most recent jsonl mtime in this account's sessions dir.
  if [[ -d "$pi_home/.pi/agent/sessions" ]]; then
    last_activity=$(find "$pi_home/.pi/agent/sessions" \
      -maxdepth 2 -name '*.jsonl' -type f \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
    if [[ -n "$last_activity" ]]; then
      last_activity=$(( $(date +%s) - last_activity ))
    else
      last_activity=null
    fi
  else
    last_activity=null
  fi

  # rl_hits_today is claude-specific (Anthropic-emitted rate-limit events).
  # Pi has no equivalent surface yet; emit 0 to keep the JSON shape parallel.
  jq -nc --arg alias "$alias" --arg email "$email" --arg cfg "$cfg_dir" \
         --arg pi_home "$pi_home" --arg auth "$auth" \
         --argjson sess "$active_sessions" \
         --argjson last "$last_activity" '
    {
      alias: $alias,
      provider: "pi-coding-agent",
      email: $email,
      config_dir: $cfg,
      pi_home: $pi_home,
      auth_status: $auth,
      active_sessions: $sess,
      rl_hits_today: 0,
      last_activity_seconds_ago: $last
    }'
}
