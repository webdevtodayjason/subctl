#!/usr/bin/env bash
# providers/claude/statusline.sh — Claude Code statusline.
# Reads JSON from stdin (Claude Code statusLine spec) and prints one line
# with rate-limit + parallelism awareness.
#
# Symlinked into ~/.claude/scripts/statusline.sh by `subctl install`.
set -uo pipefail

# Resolve repo root via the canonical install symlink, with fallbacks.
if [[ -L "$HOME/.subctl" ]]; then
  SUBCTL_REPO_ROOT="$(readlink "$HOME/.subctl")"
elif [[ -d "$HOME/code/subctl" ]]; then
  SUBCTL_REPO_ROOT="$HOME/code/subctl"
fi
. "$SUBCTL_REPO_ROOT/lib/core.sh"
. "$SUBCTL_REPO_ROOT/lib/radar.sh"

input=$(cat)

project=$(basename "$(echo "$input" | jq -r '.workspace.project_dir // .cwd')")
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
sid=$(echo "$input" | jq -r '.session_id // empty')
model=$(echo "$input" | jq -r '.model.display_name // "Claude"')

# Active account (from the env Claude Code inherited)
account_label=""
if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
  account_alias=$(subctl_list_accounts | awk -F'\t' -v c="$CLAUDE_CONFIG_DIR" '$4==c {print $1; exit}')
  [[ -z "$account_alias" ]] && account_alias="custom"
  account_label="$account_alias"
fi

# Git
branch="" gstatus=""
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  if ! git -C "$cwd" diff-index --quiet HEAD -- 2>/dev/null; then gstatus="*"; fi
  if [[ -n "$(git -C "$cwd" ls-files --others --exclude-standard 2>/dev/null)" ]]; then gstatus="${gstatus}+"; fi
fi
[[ -z "$branch" ]] && branch="no-git"

# Context %
ctx_pct=0
usage=$(echo "$input" | jq -c '.context_window.current_usage // null')
if [[ "$usage" != "null" ]]; then
  curr=$(echo "$usage" | jq '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)')
  out=$(echo "$usage" | jq '.output_tokens // 0')
  size=$(echo "$input" | jq '.context_window.context_window_size // 200000')
  [[ "$size" -gt 0 ]] && ctx_pct=$(( (curr + out) * 100 / size ))
fi
ctx_color=$(subctl_radar_classify_ctx "$ctx_pct")

# Tokens
tin=$(echo "$input" | jq '.context_window.total_input_tokens // 0')
tout=$(echo "$input" | jq '.context_window.total_output_tokens // 0')
tin_fmt=$(subctl_radar_format_count "$tin")
tout_fmt=$(subctl_radar_format_count "$tout")

# Cross-account signals
psess=$(subctl_radar_parallel_sessions)
psess_color=$(subctl_radar_classify_parallel "$psess")
sage=$(subctl_radar_session_age_seconds "$sid")
sage_color=$(subctl_radar_classify_age "$sage")
sage_fmt=$(subctl_radar_format_age "$sage")
rl=$(subctl_radar_rl_hits_today)
rl_color=$(subctl_radar_classify_rl "$rl")

# Render
bar='\033[38;5;240m│\033[0m'
out_str=""
out_str+="\033[38;5;51m\xef\x81\xbb $project\033[0m $bar "                          # 󰉋 folder
out_str+="\033[38;5;205m\xee\x9c\xa5 $branch$gstatus\033[0m $bar "                  # branch
if [[ -n "$account_label" ]]; then
  case "$account_label" in
    *personal*|*jason*) acc_color="\033[36m" ;;       # cyan
    *work*|*titanium*)  acc_color="\033[34m" ;;       # blue
    *overflow*|*semfreak*) acc_color="\033[35m" ;;    # magenta
    custom)             acc_color="\033[31m" ;;       # red — unconfigured
    *)                  acc_color="\033[37m" ;;
  esac
  out_str+="${acc_color}\xf0\x9f\x91\xa4 $account_label\033[0m $bar "                # 👤
fi
out_str+="\033[38;5;141m\xef\x8b\x9b $model\033[0m $bar "                           # 󰋛 robot
out_str+="$(subctl_radar_color_code "$ctx_color")ctx $ctx_pct%\033[0m $bar "
out_str+="$(subctl_radar_color_code "$psess_color")\xe2\x9a\xa1 $psess ses\033[0m $bar "   # ⚡
out_str+="$(subctl_radar_color_code "$sage_color")\xe2\x8f\xb1 $sage_fmt\033[0m $bar "     # ⏱
out_str+="\033[38;5;220m\xe2\x86\x91$tin_fmt \xe2\x86\x93$tout_fmt\033[0m"                  # ↑↓
if [[ "$rl" -gt 0 ]]; then
  out_str+=" $bar $(subctl_radar_color_code "$rl_color")\xe2\x9a\xa0 $rl RL today\033[0m"  # ⚠
fi
printf "%b\n" "$out_str"
