#!/usr/bin/env bash
# providers/claude/dispatch-check.sh — pre-dispatch readiness check.
# Returns 🟢 GO / 🟡 HOLD / 🔴 STOP based on the same signals the statusline reads.
#
# Symlinked into ~/.claude/scripts/dispatch-check.sh by `subctl install`.
set -uo pipefail

if [[ -L "$HOME/.subctl" ]]; then
  SUBCTL_REPO_ROOT="$(readlink "$HOME/.subctl")"
elif [[ -d "$HOME/code/subctl" ]]; then
  SUBCTL_REPO_ROOT="$HOME/code/subctl"
fi
. "$SUBCTL_REPO_ROOT/lib/core.sh"
. "$SUBCTL_REPO_ROOT/lib/radar.sh"

# Find the most-recently-active session (across all accounts)
sid_file=""
for d in $(subctl_radar_projects_dirs); do
  newest=$(find "$d" -maxdepth 1 -name '*.jsonl' -type f -mmin -10 2>/dev/null \
    | xargs ls -t 2>/dev/null | head -1)
  if [[ -n "$newest" ]]; then
    if [[ -z "$sid_file" ]] || [[ "$newest" -nt "$sid_file" ]]; then
      sid_file="$newest"
    fi
  fi
done

sid=""
cwd="$(pwd)"
account_alias=""
account_email=""
if [[ -n "$sid_file" ]]; then
  sid=$(basename "${sid_file%.jsonl}")
  cwd_log=$(grep -m1 '"cwd"' "$sid_file" 2>/dev/null | jq -r '.cwd // empty' 2>/dev/null)
  [[ -n "$cwd_log" ]] && cwd="$cwd_log"
  # Identify which account the session belongs to from its parent dir
  parent_cfg=$(dirname "$(dirname "$sid_file")")
  account_alias=$(subctl_list_accounts | awk -F'\t' -v c="$parent_cfg" '$4==c {print $1; exit}')
  account_email=$(subctl_list_accounts | awk -F'\t' -v c="$parent_cfg" '$4==c {print $3; exit}')
  [[ -z "$account_alias" ]] && account_alias="default ($parent_cfg)"
fi

# Approximate ctx % from latest usage entry
ctx_pct=0
if [[ -n "$sid_file" ]]; then
  last_usage=$(grep -h '"usage"' "$sid_file" 2>/dev/null | tail -1 \
    | jq -c '.message.usage // .usage // null' 2>/dev/null)
  if [[ "$last_usage" != "null" ]] && [[ -n "$last_usage" ]]; then
    curr=$(echo "$last_usage" | jq '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0) + (.output_tokens // 0)')
    [[ "$curr" -gt 0 ]] && ctx_pct=$(( curr * 100 / 200000 ))
  fi
fi

model=$(grep -h '"model"' "$sid_file" 2>/dev/null | tail -1 \
  | jq -r '.message.model // .model // "unknown"' 2>/dev/null)
[[ -z "$model" ]] && model="unknown"

psess=$(subctl_radar_parallel_sessions)
sage=$(subctl_radar_session_age_seconds "$sid")
rl=$(subctl_radar_rl_hits_today)

pc=$(subctl_radar_classify_parallel "$psess")
ac=$(subctl_radar_classify_age "$sage")
cc=$(subctl_radar_classify_ctx "$ctx_pct")
rc=$(subctl_radar_classify_rl "$rl")

# Git
branch="" gstatus=""
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  if ! git -C "$cwd" diff-index --quiet HEAD -- 2>/dev/null; then gstatus="${gstatus}*"; fi
  if [[ -n "$(git -C "$cwd" ls-files --others --exclude-standard 2>/dev/null)" ]]; then gstatus="${gstatus}+"; fi
fi
gc=green
[[ -n "$gstatus" ]] && gc=yellow

reds=() yellows=()
[[ "$pc" = red ]]    && reds+=("⚡ $psess parallel sessions across all accounts (red ≥4)")
[[ "$pc" = yellow ]] && yellows+=("⚡ $psess parallel sessions")
[[ "$ac" = red ]]    && reds+=("⏱ session $(subctl_radar_format_age "$sage") old (red ≥6h)")
[[ "$ac" = yellow ]] && yellows+=("⏱ session $(subctl_radar_format_age "$sage") old")
[[ "$cc" = red ]]    && reds+=("ctx $ctx_pct% (red ≥80%)")
[[ "$cc" = orange ]] && yellows+=("ctx $ctx_pct% (orange 60-80%)")
[[ "$cc" = yellow ]] && yellows+=("ctx $ctx_pct%")
[[ "$rc" = red ]]    && reds+=("⚠ $rl rate-limit hits today (red ≥3)")
[[ "$rc" = yellow ]] && yellows+=("⚠ $rl rate-limit hits today")
[[ -n "$gstatus" ]]  && yellows+=("git: ${branch:-no-git}$gstatus (uncommitted/untracked)")

if   [[ ${#reds[@]} -gt 0 ]];    then printf '\033[31m🔴 STOP\033[0m — do not dispatch this wave\n'
elif [[ ${#yellows[@]} -gt 0 ]]; then printf '\033[33m🟡 HOLD\033[0m — proceed with caution\n'
else                                  printf '\033[32m🟢 GO\033[0m — all signals clear\n'
fi

echo
echo "Signals:"
printf "  Active account:    %s\n" "${account_alias:-(none)}"
[[ -n "$account_email" ]] && printf "  Email:             %s\n" "$account_email"
printf "  Parallel sessions: %d  [%s]\n" "$psess" "$pc"
printf "  Session age:       %s  [%s]\n" "$(subctl_radar_format_age "$sage")" "$ac"
printf "  Context usage:     %d%%  [%s]\n" "$ctx_pct" "$cc"
printf "  RL hits today:     %d  [%s]\n" "$rl" "$rc"
printf "  Active model:      %s\n" "$model"
printf "  Branch state:      %s%s  [%s]\n" "${branch:-no-git}" "$gstatus" "$gc"

if [[ ${#reds[@]} -gt 0 ]]; then
  echo; echo "🔴 Reds:"
  for r in "${reds[@]}"; do echo "  - $r"; done
fi
if [[ ${#yellows[@]} -gt 0 ]]; then
  echo; echo "🟡 Yellows:"
  for y in "${yellows[@]}"; do echo "  - $y"; done
fi
