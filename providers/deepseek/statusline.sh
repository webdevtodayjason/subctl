#!/usr/bin/env bash
# providers/deepseek/statusline.sh — minimal statusline for CodeWhale sessions.
#
# CodeWhale does not (yet) expose a statusLine spec analogous to Claude
# Code's stdin-JSON-per-frame contract. This file is shipped for parity
# with providers/claude/statusline.sh + providers/pi-coding-agent/
# statusline.sh; it renders a one-line summary suitable for tmux pane
# status, polled rather than streamed.
#
# Usage: SUBCTL_DEEPSEEK_ACCOUNT=<alias> bash statusline.sh
#        (SUBCTL_DEEPSEEK_ACCOUNT is set by teams.sh at spawn time)
#
# Output: single line, ANSI-colored. No newline at end.
set -uo pipefail

# Resolve repo root via the canonical install symlink, with fallbacks.
if [[ -L "$HOME/.subctl" ]]; then
  SUBCTL_REPO_ROOT="$(readlink "$HOME/.subctl")"
elif [[ -d "$HOME/code/subctl" ]]; then
  SUBCTL_REPO_ROOT="$HOME/code/subctl"
fi
. "$SUBCTL_REPO_ROOT/lib/core.sh"

# Active alias — set by teams.sh via tmux env, or fall back to "unknown".
account_label="${SUBCTL_DEEPSEEK_ACCOUNT:-unknown}"
cwd="${PWD}"
project=$(basename "$cwd")

# Git
branch="" gstatus=""
if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  if ! git -C "$cwd" diff-index --quiet HEAD -- 2>/dev/null; then gstatus="*"; fi
  if [[ -n "$(git -C "$cwd" ls-files --others --exclude-standard 2>/dev/null)" ]]; then gstatus="${gstatus}+"; fi
fi
[[ -z "$branch" ]] && branch="no-git"

# Session count — number of session files in HOME/.deepseek/sessions
# touched in the last 2 minutes. HOME is the per-alias shadow at runtime
# (teams.sh sets HOME=$dsk_home).
session_count=0
if [[ -d "$HOME/.deepseek/sessions" ]]; then
  session_count=$(find "$HOME/.deepseek/sessions" \
    -maxdepth 3 -type f -mmin -2 2>/dev/null \
    | wc -l | tr -d ' ')
fi

# CodeWhale model — best-effort from env (set by teams.sh -m or operator
# DEEPSEEK_MODEL); else "codewhale".
model="${DEEPSEEK_MODEL:-codewhale}"

# Render
bar='\033[38;5;240m│\033[0m'
out_str=""
out_str+="\033[38;5;51m\xef\x81\xbb $project\033[0m $bar "                            # 󰉋 folder
out_str+="\033[38;5;205m\xee\x9c\xa5 $branch$gstatus\033[0m $bar "                    # branch
out_str+="\033[36m\xf0\x9f\x90\xb3 $account_label\033[0m $bar "                       # 🐳 whale (CodeWhale)
out_str+="\033[38;5;141m\xef\x8b\x9b $model\033[0m $bar "                             # 󰋛 robot
out_str+="\033[38;5;220m\xe2\x9a\xa1 $session_count ses\033[0m"                       # ⚡

printf "%b" "$out_str"
