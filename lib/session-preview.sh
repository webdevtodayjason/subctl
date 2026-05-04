#!/usr/bin/env bash
# lib/session-preview.sh — sesh integration helpers.
#
# Two entry points:
#   subctl_session_list   → all tmux sessions, optionally enriched, in plain/sesh/json
#   subctl_session_preview <name> → multi-line metadata block + recent activity tail

[[ -n "${_SUBCTL_SESSION_PREVIEW_LOADED:-}" ]] && return 0
_SUBCTL_SESSION_PREVIEW_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/radar.sh"

# ── helpers ──────────────────────────────────────────────────────────────────

# Strip ANSI control sequences. Operates on stdin → stdout.
_strip_ansi() {
  sed -E $'s/\033\\[[0-9;]*[a-zA-Z]//g; s/\033\\][^\007]*\007//g'
}

# Detect Claude session status from pane content (last ~200 lines).
# Output: working | idle | waiting | unknown
_detect_status() {
  local content="$1"
  local clean
  clean=$(printf '%s' "$content" | _strip_ansi | tail -10)

  # Permission prompts → waiting
  case "$clean" in
    *"Do you want to proceed"*|*"Do you want to"*|*"❯ 1. Yes"*|*"[y/n]"*|*"Approve"*)
      echo waiting; return ;;
  esac

  # Active spinner glyphs or tool-use → working
  case "$clean" in
    *⠋*|*⠙*|*⠹*|*⠸*|*⠼*|*⠴*|*⠦*|*⠧*|*⠇*|*⠏*) echo working; return ;;
    *"Tool use:"*|*"Thinking"*|*"thinking…"*) echo working; return ;;
  esac

  # Visible Claude prompt → idle
  case "$clean" in
    *"❯ "*|*"> "*) echo idle; return ;;
  esac

  echo unknown
}

# Resolve account alias from a session's CLAUDE_CONFIG_DIR (if any).
_account_for_session() {
  local sess="$1"
  local raw
  raw=$(tmux show-environment -t "$sess" CLAUDE_CONFIG_DIR 2>/dev/null) || return 0
  # raw looks like: CLAUDE_CONFIG_DIR=/Users/you/.claude-titanium  or  -CLAUDE_CONFIG_DIR (unset)
  case "$raw" in
    -*) return 0 ;;
    *=*)
      local dir="${raw#*=}"
      dir="${dir%/}"
      subctl_list_accounts | awk -F'\t' -v d="$dir" '$4==d {print $1; exit}'
      ;;
  esac
}

# Best-effort find the Claude Code session UUID for a tmux session by mtime.
_claude_session_id_for() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" || ! -d "$cfg_dir/projects" ]] && return 0
  # Most recently active jsonl in this account's projects/
  find "$cfg_dir/projects" -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null \
    | xargs ls -t 2>/dev/null | head -1 | xargs -I {} basename {} .jsonl
}

# Read ctx % from a session's last usage block.
_ctx_pct_for() {
  local sid_file="$1"
  [[ ! -f "$sid_file" ]] && { echo 0; return; }
  local last_usage
  last_usage=$(grep -h '"usage"' "$sid_file" 2>/dev/null | tail -1 \
    | jq -c '.message.usage // .usage // null' 2>/dev/null)
  [[ -z "$last_usage" || "$last_usage" == "null" ]] && { echo 0; return; }
  local curr
  curr=$(echo "$last_usage" | jq '
    (.input_tokens // 0)
    + (.cache_creation_input_tokens // 0)
    + (.cache_read_input_tokens // 0)
    + (.output_tokens // 0)' 2>/dev/null)
  [[ -z "$curr" || "$curr" == "0" ]] && { echo 0; return; }
  echo $(( curr * 100 / 200000 ))
}

# Format a session row for sesh preview / plain listing. Outputs one line.
# Args: tmux_session_name
_session_one_line() {
  local sess="$1"
  local path branch alias cfg_dir sid pct
  path=$(tmux display-message -p -t "$sess" '#{session_path}' 2>/dev/null)
  alias=$(_account_for_session "$sess")
  alias="${alias:-(none)}"
  cfg_dir=""
  [[ -n "$alias" && "$alias" != "(none)" ]] && cfg_dir=$(subctl_account_field "$alias" 4)
  sid=""
  [[ -n "$cfg_dir" ]] && sid=$(_claude_session_id_for "$cfg_dir")
  pct=0
  [[ -n "$sid" && -n "$cfg_dir" ]] && pct=$(_ctx_pct_for "$cfg_dir/projects/${sid}.jsonl")

  branch=""
  [[ -d "$path" ]] && branch=$(git -C "$path" branch --show-current 2>/dev/null)
  [[ -z "$branch" ]] && branch="—"

  printf "%s  ●%s ctx %d%%  %s  %s\n" \
    "$sess" "$alias" "$pct" "$branch" "$(basename "${path:-?}")"
}

# ── public: subctl session-list [--format plain|sesh|json] ──────────────────
subctl_session_list() {
  local format="plain"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --format) format="$2"; shift 2 ;;
      -h|--help)
        cat <<EOF
subctl session-list [--format <plain|sesh|json>]

  plain  (default)  one line per session: name · account · ctx · branch · path
  sesh              just the session names (one per line) — for sesh.toml
  json              one JSON object per line per session (for tooling)
EOF
        return 0 ;;
      *) subctl_die "unknown flag: $1" ;;
    esac
  done

  if ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi

  local sessions
  sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 0

  case "$format" in
    sesh)
      # Sesh consumes plain newline-separated names.
      printf "%s\n" "$sessions"
      ;;
    json)
      while IFS= read -r sess; do
        [[ -z "$sess" ]] && continue
        local path alias pct
        path=$(tmux display-message -p -t "$sess" '#{session_path}' 2>/dev/null)
        alias=$(_account_for_session "$sess"); alias="${alias:-(none)}"
        local cfg_dir sid
        [[ "$alias" != "(none)" ]] && cfg_dir=$(subctl_account_field "$alias" 4)
        sid=""
        [[ -n "$cfg_dir" ]] && sid=$(_claude_session_id_for "$cfg_dir")
        pct=0
        [[ -n "$sid" ]] && pct=$(_ctx_pct_for "$cfg_dir/projects/${sid}.jsonl")
        jq -nc --arg s "$sess" --arg p "$path" --arg a "$alias" --argjson c "$pct" \
          '{session:$s, path:$p, account:$a, ctx_pct:$c}'
      done <<< "$sessions"
      ;;
    plain|*)
      while IFS= read -r sess; do
        [[ -z "$sess" ]] && continue
        _session_one_line "$sess"
      done <<< "$sessions"
      ;;
  esac
}

# ── public: subctl session-preview <name> ───────────────────────────────────
subctl_session_preview() {
  local sess="${1:-}"
  [[ -z "$sess" ]] && {
    cat <<EOF
subctl session-preview <session_name>

  Renders an enriched metadata block for one tmux session.
  Used as sesh's preview_command. See docs/sesh-integration.md.
EOF
    return 1
  }

  if ! command -v tmux >/dev/null 2>&1; then
    echo "(tmux not installed)"
    return 0
  fi

  if ! tmux has-session -t "$sess" 2>/dev/null; then
    echo "(no tmux session named '$sess')"
    return 0
  fi

  local path alias email cfg_dir sid pct branch gstatus
  local panes_total panes_active capture status

  path=$(tmux display-message -p -t "$sess" '#{session_path}')
  alias=$(_account_for_session "$sess")
  alias="${alias:-(none)}"
  email=""
  cfg_dir=""
  if [[ "$alias" != "(none)" ]]; then
    email=$(subctl_account_field "$alias" 3)
    cfg_dir=$(subctl_account_field "$alias" 4)
  fi

  sid=""
  [[ -n "$cfg_dir" ]] && sid=$(_claude_session_id_for "$cfg_dir")
  pct=0
  [[ -n "$sid" ]] && pct=$(_ctx_pct_for "$cfg_dir/projects/${sid}.jsonl")

  branch=""
  gstatus=""
  if [[ -d "$path" ]] && git -C "$path" rev-parse --git-dir >/dev/null 2>&1; then
    branch=$(git -C "$path" branch --show-current 2>/dev/null)
    if ! git -C "$path" diff-index --quiet HEAD -- 2>/dev/null; then gstatus="*"; fi
    if [[ -n "$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null)" ]]; then gstatus="${gstatus}+"; fi
  fi
  branch="${branch:-—}"

  panes_total=$(tmux list-panes -t "$sess" 2>/dev/null | wc -l | tr -d ' ')
  panes_active=$(tmux list-panes -t "$sess" -F '#{pane_active}' 2>/dev/null | grep -c '^1' || true)

  capture=$(tmux capture-pane -p -t "$sess" 2>/dev/null)
  status=$(_detect_status "$capture")

  local rl_today rl_color
  rl_today=$(get_rl_for_session_today "$sid" 2>/dev/null || echo 0)
  rl_color=$(subctl_radar_classify_rl "$rl_today")

  local status_color
  case "$status" in
    working) status_color="$C_GRN" ;;
    waiting) status_color="$C_YLW" ;;
    idle)    status_color="$C_DIM" ;;
    *)       status_color="$C_DIM" ;;
  esac

  # Color the account label like the statusline does.
  local acc_color
  case "$alias" in
    *personal*) acc_color="$C_CYN" ;;
    *work*)     acc_color="$C_BLU" ;;
    *overflow*) acc_color="$C_MAG" ;;
    *)          acc_color="$C_DIM" ;;
  esac

  printf "%s%s%s" "$acc_color" "$alias" "$C_RST"
  [[ -n "$email" ]] && printf " %s· %s%s" "$C_DIM" "$email" "$C_RST"
  printf "\n"
  printf "%s─────────────────────────────────────────────%s\n" "$C_DIM" "$C_RST"
  printf "ctx        %s%d%%%s\n" "$(subctl_radar_color_code "$(subctl_radar_classify_ctx "$pct")")" "$pct" "$C_RST"
  printf "status     %s%s%s\n"   "$status_color" "$status" "$C_RST"
  printf "branch     %s%s\n"     "$branch" "$gstatus"
  printf "panes      %s active / %s total\n" "$panes_active" "$panes_total"
  printf "RL today   %s%s%s\n"   "$(subctl_radar_color_code "$rl_color")" "$rl_today" "$C_RST"
  printf "path       %s%s%s\n"   "$C_DIM" "$path" "$C_RST"
  printf "%s─────────────────────────────────────────────%s\n" "$C_DIM" "$C_RST"
  printf "%s\n" "$capture" | tail -8
}

# Helper: count rate-limit hits today scoped to a specific session UUID.
get_rl_for_session_today() {
  local sid="$1"
  [[ -z "$sid" || ! -f "$SUBCTL_RL_LOG" ]] && { echo 0; return; }
  local today
  today=$(date +%Y-%m-%d)
  local n
  n=$(jq -r --arg today "$today" --arg sid "$sid" \
    'select(.date == $today and .session == $sid) | 1' "$SUBCTL_RL_LOG" 2>/dev/null \
    | wc -l | tr -d ' ')
  echo "${n:-0}"
}
