#!/usr/bin/env bash
# providers/claude/signals.sh — provider interface for emitting Claude account
# signals to the dashboard / radar. Wraps lib/radar.sh with the right scope.

[[ -n "${_SUBCTL_CLAUDE_SIGNALS_LOADED:-}" ]] && return 0
_SUBCTL_CLAUDE_SIGNALS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/radar.sh"

# Implements provider interface: provider_signals <alias>
# Outputs JSON shaped like the dashboard's /api/state.accounts[] entry.
provider_claude_signals() {
  local alias="$1"
  local cfg_dir email
  cfg_dir=$(subctl_account_field "$alias" 4)
  email=$(subctl_account_field "$alias" 3)

  [[ -z "$cfg_dir" ]] && {
    echo '{"alias":"'"$alias"'","provider":"claude","auth_status":"unknown","error":"alias not found"}'
    return 1
  }

  local auth active_sessions rl_today last_activity
  auth=$(subctl_auth_status "$cfg_dir")
  active_sessions=$(subctl_radar_parallel_sessions_for "$cfg_dir")

  # RL hits today scoped to this account's sessions
  if [[ -f "$SUBCTL_RL_LOG" ]] && [[ -d "$cfg_dir/projects" ]]; then
    rl_today=$(jq -r --arg today "$(date +%Y-%m-%d)" \
      'select(.date == $today) | .session' "$SUBCTL_RL_LOG" 2>/dev/null \
      | sort -u | while read -r sid; do
          [[ -f "$cfg_dir/projects/${sid}.jsonl" ]] && echo "$sid"
        done | wc -l | tr -d ' ')
  else
    rl_today=0
  fi

  # Last activity = most recent jsonl mtime in this account's projects/
  if [[ -d "$cfg_dir/projects" ]]; then
    last_activity=$(find "$cfg_dir/projects" -maxdepth 1 -name '*.jsonl' -type f \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)
    if [[ -n "$last_activity" ]]; then
      last_activity=$(( $(date +%s) - last_activity ))
    else
      last_activity=null
    fi
  else
    last_activity=null
  fi

  jq -nc --arg alias "$alias" --arg email "$email" --arg cfg "$cfg_dir" \
         --arg auth "$auth" \
         --argjson sess "$active_sessions" --argjson rl "$rl_today" \
         --argjson last "$last_activity" '
    {
      alias: $alias,
      provider: "claude",
      email: $email,
      config_dir: $cfg,
      auth_status: $auth,
      active_sessions: $sess,
      rl_hits_today: $rl,
      last_activity_seconds_ago: $last
    }'
}
