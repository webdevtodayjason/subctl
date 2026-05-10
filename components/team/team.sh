#!/usr/bin/env bash
# components/team/team.sh — dev-team lead reporting CLI.
#
# Dev teams are tmux sessions spawned by the master orchestrator. The lead
# Claude Code in pane 0 appends status events to a per-team JSONL file:
#
#   ~/.config/subctl/master/inbox/{team}.jsonl
#
# The master daemon tails these files, broadcasts new lines as `team_event`
# SSE events to the dashboard, surfaces "blocked"/"error" events to its own
# agent for action, and uses file mtime for staleness detection.
#
# This CLI is the one-line append helper so leads don't have to hand-roll
# JSON or hunt for the inbox path.

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

SUBCTL_MASTER_INBOX="${SUBCTL_MASTER_INBOX:-$HOME/.config/subctl/master/inbox}"

subctl_team() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    report)   subctl_team_report "$@" ;;
    inbox)    subctl_team_inbox "$@" ;;
    list)     subctl_team_list "$@" ;;
    -h|--help|"")
      cat <<EOF
subctl team <verb> [args]

  Dev-team status reporting. Used by team leads (the lead Claude Code session
  in a dev-team tmux pane) to push status events back to the master
  orchestrator. Each event becomes a line in
    \$SUBCTL_MASTER_INBOX/{team}.jsonl
  which the master daemon tails and surfaces in the dashboard + chat.

Verbs:
  report   Append a status event for a team
  inbox    Show recent events for a team (or all teams)
  list     List teams that have an inbox file

Examples:
  subctl team report --team my-team --type progress --text "branch created, running tests"
  subctl team report --team my-team --type blocked --text "lint failing on src/x.ts"
  subctl team report --team my-team --type done --text "PR ready" --pr "owner/repo#42"
  subctl team inbox my-team --tail 10
  subctl team list
EOF
      ;;
    *) subctl_die "unknown team verb: $sub" ;;
  esac
}

subctl_team_report() {
  local team="" type="" text=""
  local -a extra_kv=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --team|-t)  team="$2"; shift 2 ;;
      --type|-k)  type="$2"; shift 2 ;;
      --text|-m)  text="$2"; shift 2 ;;
      --*)
        # Pass-through key/value: --pr "owner/repo#42" → "pr": "owner/repo#42"
        local key="${1#--}"
        extra_kv+=("$key" "${2:-}")
        shift 2
        ;;
      *) subctl_die "unknown report flag: $1" ;;
    esac
  done

  [[ -z "$team" ]] && { team="${SUBCTL_TEAM_NAME:-${TMUX_SESSION_NAME:-}}"; }
  [[ -z "$team" ]] && subctl_die "--team required (or set SUBCTL_TEAM_NAME)"
  [[ -z "$type" ]] && subctl_die "--type required (progress|blocked|done|error|note)"

  case "$type" in
    progress|blocked|done|error|note) ;;
    *) subctl_warn "unknown event type '$type' — accepted but master may not act on it" ;;
  esac

  mkdir -p "$SUBCTL_MASTER_INBOX"
  local inbox="$SUBCTL_MASTER_INBOX/${team}.jsonl"

  # Build JSON line via jq for safe escaping. Extra --kv args become top-level fields.
  local jq_args=(-nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg type "$type" --arg text "$text")
  local jq_obj='{ts: $ts, type: $type, text: $text}'
  local i=0
  while [[ $i -lt ${#extra_kv[@]} ]]; do
    local k="${extra_kv[$i]}"
    local v="${extra_kv[$((i+1))]}"
    # Slot name in jq must be unique; prefix with kv_ to avoid collision.
    jq_args+=(--arg "kv_$k" "$v")
    jq_obj="$jq_obj + {\"$k\": \$kv_$k}"
    i=$((i+2))
  done

  local line
  line=$(jq "${jq_args[@]}" "$jq_obj")
  printf "%s\n" "$line" >> "$inbox"
  subctl_ok "team=$team type=$type → $inbox"
}

subctl_team_inbox() {
  local team="${1:-}"; shift || true
  local tail_n=20
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tail|-n) tail_n="$2"; shift 2 ;;
      *) subctl_die "unknown inbox flag: $1" ;;
    esac
  done

  if [[ -z "$team" ]]; then
    subctl_die "usage: subctl team inbox <team> [--tail N]   (or: subctl team list)"
  fi
  local inbox="$SUBCTL_MASTER_INBOX/${team}.jsonl"
  if [[ ! -f "$inbox" ]]; then
    subctl_warn "no inbox for team '$team' (looking in $inbox)"
    return 1
  fi
  tail -n "$tail_n" "$inbox" | jq -r '"\(.ts)  \(.type | ascii_upcase | .[0:8])  \(.text // "")"'
}

subctl_team_list() {
  if [[ ! -d "$SUBCTL_MASTER_INBOX" ]]; then
    echo "(no inbox dir at $SUBCTL_MASTER_INBOX — no teams have reported yet)"
    return 0
  fi
  local found=0
  for f in "$SUBCTL_MASTER_INBOX"/*.jsonl; do
    [[ -e "$f" ]] || continue
    found=1
    local team mtime size lines
    team=$(basename "$f" .jsonl)
    mtime=$(date -r "$f" "+%Y-%m-%d %H:%M:%S")
    size=$(wc -c < "$f" | tr -d ' ')
    lines=$(wc -l < "$f" | tr -d ' ')
    printf "  %-32s  %s  %5s lines  %6s bytes\n" "$team" "$mtime" "$lines" "$size"
  done
  if [[ $found -eq 0 ]]; then
    echo "(no teams have reported yet — inbox dir is empty)"
  fi
}
