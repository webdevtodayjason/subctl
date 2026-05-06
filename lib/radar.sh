#!/usr/bin/env bash
# lib/radar.sh — rate-limit + dispatch readiness signals.
# Cross-account aware: scans all ~/.claude*/projects/ dirs, not just ~/.claude.

[[ -n "${_SUBCTL_RADAR_LOADED:-}" ]] && return 0
_SUBCTL_RADAR_LOADED=1

# Source core if not already loaded.
. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# ── thresholds ───────────────────────────────────────────────────────────────
# Tunable here. Re-run `subctl install` after editing.
SUBCTL_THRESH_PARALLEL_RED=4      # ≥ red
SUBCTL_THRESH_PARALLEL_YELLOW=2   # ≥ yellow
SUBCTL_THRESH_AGE_RED=21600       # 6h
SUBCTL_THRESH_AGE_YELLOW=7200     # 2h
SUBCTL_THRESH_CTX_RED=80
SUBCTL_THRESH_CTX_ORANGE=60
SUBCTL_THRESH_CTX_YELLOW=30
SUBCTL_THRESH_RL_RED=3
SUBCTL_THRESH_RL_YELLOW=1

# ── projects-dir discovery (cross-account) ───────────────────────────────────
# All ~/.claude* dirs that look like a Claude Code config (have a projects/ subdir).
subctl_radar_projects_dirs() {
  local d
  for d in "$HOME"/.claude "$HOME"/.claude-*; do
    [[ -d "$d/projects" ]] && echo "$d/projects"
  done
}

# ── signals ──────────────────────────────────────────────────────────────────

# How many active sessions on this machine right now (across ALL accounts).
# Definition: session JSONL files modified within the last 2 minutes.
# Claude stores transcripts at projects/<project-cwd-encoded>/<session-id>.jsonl,
# so this needs to descend 2 levels (was -maxdepth 1, which always returned 0).
subctl_radar_parallel_sessions() {
  local total=0 d
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    local n
    n=$(find "$d" -maxdepth 2 -name '*.jsonl' -type f -mmin -2 2>/dev/null | wc -l | tr -d ' ')
    total=$((total + n))
  done < <(subctl_radar_projects_dirs)
  echo "$total"
}

# Same but just for one account (passed as config_dir).
subctl_radar_parallel_sessions_for() {
  local cfg="$1"
  [[ -d "$cfg/projects" ]] || { echo 0; return; }
  find "$cfg/projects" -maxdepth 2 -name '*.jsonl' -type f -mmin -2 2>/dev/null | wc -l | tr -d ' '
}

# Wall-clock age of a session in seconds, given session_id.
# Searches all known projects dirs (projects/<cwd-encoded>/<sid>.jsonl).
subctl_radar_session_age_seconds() {
  local sid="$1"
  [[ -z "$sid" ]] && { echo 0; return; }
  local file
  for d in $(subctl_radar_projects_dirs); do
    file=$(find "$d" -maxdepth 2 -name "${sid}.jsonl" -type f 2>/dev/null | head -1)
    [[ -n "$file" ]] && break
  done
  [[ -z "$file" ]] && { echo 0; return; }
  local first_ts
  first_ts=$(grep -m1 '"timestamp"' "$file" 2>/dev/null \
    | jq -r '.timestamp // empty' 2>/dev/null)
  [[ -z "$first_ts" ]] && { echo 0; return; }
  local first_epoch
  first_epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${first_ts%.*}" +%s 2>/dev/null \
    || date -u -d "${first_ts}" +%s 2>/dev/null \
    || echo 0)
  [[ "$first_epoch" = 0 ]] && { echo 0; return; }
  echo $(( $(date +%s) - first_epoch ))
}

# Count of rate-limit events logged today (local TZ).
subctl_radar_rl_hits_today() {
  [[ ! -f "$SUBCTL_RL_LOG" ]] && { echo 0; return; }
  local today n
  today=$(date +%Y-%m-%d)
  n=$(grep -c "\"$today" "$SUBCTL_RL_LOG" 2>/dev/null)
  echo "${n:-0}"
}

# RL hits today by account (parses session_id → matches against projects dirs).
# Output: account_alias\tcount
subctl_radar_rl_by_account() {
  [[ ! -f "$SUBCTL_RL_LOG" ]] && return 0
  local today
  today=$(date +%Y-%m-%d)
  # jq the events; map each session id to the account whose projects/ contains it.
  jq -r --arg today "$today" 'select(.date == $today) | .session' "$SUBCTL_RL_LOG" 2>/dev/null \
    | sort -u \
    | while read -r sid; do
        [[ -z "$sid" ]] && continue
        for cfg in "$HOME"/.claude "$HOME"/.claude-*; do
          [[ -f "$cfg/projects/${sid}.jsonl" ]] && {
            local alias
            alias=$(subctl_list_accounts | awk -F'\t' -v c="$cfg" '$4==c {print $1; exit}')
            [[ -z "$alias" ]] && alias="default"
            echo "$alias"
            break
          }
        done
      done | sort | uniq -c | awk '{printf "%s\t%s\n", $2, $1}'
}

# ── classifiers ──────────────────────────────────────────────────────────────
subctl_radar_classify_parallel() {
  local n=$1
  if   [[ "$n" -ge $SUBCTL_THRESH_PARALLEL_RED ]];    then echo red
  elif [[ "$n" -ge $SUBCTL_THRESH_PARALLEL_YELLOW ]]; then echo yellow
  else echo green; fi
}

subctl_radar_classify_age() {
  local s=$1
  if   [[ "$s" -ge $SUBCTL_THRESH_AGE_RED ]];    then echo red
  elif [[ "$s" -ge $SUBCTL_THRESH_AGE_YELLOW ]]; then echo yellow
  else echo green; fi
}

subctl_radar_classify_ctx() {
  local p=$1
  if   [[ "$p" -ge $SUBCTL_THRESH_CTX_RED ]];    then echo red
  elif [[ "$p" -ge $SUBCTL_THRESH_CTX_ORANGE ]]; then echo orange
  elif [[ "$p" -ge $SUBCTL_THRESH_CTX_YELLOW ]]; then echo yellow
  else echo green; fi
}

subctl_radar_classify_rl() {
  local n=$1
  if   [[ "$n" -ge $SUBCTL_THRESH_RL_RED ]];    then echo red
  elif [[ "$n" -ge $SUBCTL_THRESH_RL_YELLOW ]]; then echo yellow
  else echo green; fi
}

# ── formatters ───────────────────────────────────────────────────────────────
subctl_radar_format_age() {
  local s=$1
  if   [[ "$s" -lt 60 ]];   then echo "${s}s"
  elif [[ "$s" -lt 3600 ]]; then echo "$((s/60))m"
  else echo "$((s/3600))h$((s%3600/60))m"
  fi
}

subctl_radar_format_count() {
  local n=$1
  if   [[ "$n" -ge 1000000 ]]; then echo "$((n/1000000))M"
  elif [[ "$n" -ge 1000 ]];    then echo "$((n/1000))K"
  else echo "$n"; fi
}

subctl_radar_color_code() {
  case "$1" in
    green)  echo "$C_GRN" ;;
    yellow) echo "$C_YLW" ;;
    orange) echo "$C_ORN" ;;
    red)    echo "$C_RED" ;;
    *)      echo "$C_DIM" ;;
  esac
}

# ── dispatch verdict ─────────────────────────────────────────────────────────
# Computes 🟢 GO / 🟡 HOLD / 🔴 STOP given the current cross-account signals.
# Also accepts an optional active session id to compute its ctx %.
# Emits to stdout, one signal per line in `key=value` format, ending with `verdict=...`.
subctl_radar_dispatch_signals() {
  local sid="${1:-}"
  local psess sage rl ctx
  psess=$(subctl_radar_parallel_sessions)
  sage=$(subctl_radar_session_age_seconds "$sid")
  rl=$(subctl_radar_rl_hits_today)
  ctx=0  # ctx is best-effort — only meaningful when called from the statusline that has context_window in its JSON input

  printf "parallel_sessions=%s\n" "$psess"
  printf "parallel_color=%s\n"    "$(subctl_radar_classify_parallel "$psess")"
  printf "session_age_seconds=%s\n" "$sage"
  printf "session_age_color=%s\n"   "$(subctl_radar_classify_age "$sage")"
  printf "rl_hits_today=%s\n"      "$rl"
  printf "rl_color=%s\n"           "$(subctl_radar_classify_rl "$rl")"

  # Verdict: any red → STOP, else any yellow/orange → HOLD, else GO.
  local verdict=green
  for color in \
    "$(subctl_radar_classify_parallel "$psess")" \
    "$(subctl_radar_classify_age "$sage")" \
    "$(subctl_radar_classify_rl "$rl")"; do
    case "$color" in
      red)            verdict=red ;;
      orange|yellow)  [[ "$verdict" != red ]] && verdict=yellow ;;
    esac
  done
  printf "verdict=%s\n" "$verdict"
}
