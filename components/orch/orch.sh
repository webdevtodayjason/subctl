#!/usr/bin/env bash
# components/orch/orch.sh — orchestration control plane CLI.
#
# Wraps the dashboard's /api/orchestration/* endpoints so any caller (you,
# a script, ArgentOS, an MCP tool) can manage tmux orchestrator sessions
# without typing tmux commands directly.
#
# Requires the dashboard service to be running (subctl service status).

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

API_BASE="${SUBCTL_API:-http://127.0.0.1:8787}"

subctl_orch() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    spawn)   subctl_orch_spawn "$@" ;;
    list|ls) subctl_orch_list "$@" ;;
    status)  subctl_orch_status "$@" ;;
    msg)     subctl_orch_msg "$@" ;;
    kill)    subctl_orch_kill "$@" ;;
    -h|--help|"")
      cat <<EOF
subctl orch <verb> [args]

  Control orchestrator tmux sessions over HTTP. The dashboard service
  must be running (subctl service status).

Verbs:
  spawn     Start a new orchestrator session (account + project required)
  list, ls  Show all running orchestrator sessions (claude_account_dir set)
  status    Live preview + panes for one session
  msg       Inject text into a session (orchestrator picks it up)
  kill      Kill a session

Examples:
  subctl orch spawn --account claude-personal --project ~/code/shannon \\
                    --orchestrator --skip-perms \\
                    --prompt "build the auth flow per ORCHESTRATION.md"
  subctl orch list
  subctl orch status claude-shannon
  subctl orch msg claude-shannon "stop work and commit current state"
  subctl orch kill claude-shannon
EOF
      ;;
    *) subctl_die "unknown orch verb: $sub" ;;
  esac
}

# subctl orch spawn --account <a> --project <p> [--prompt "..."] [--orchestrator] [--continue] [--skip-perms] [--resume <sid>]
subctl_orch_spawn() {
  local account="" project="" prompt=""
  local orchestrator=false skip_perms=false continue_flag=false resume=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --account|-a)     account="$2"; shift 2 ;;
      --project|-c)     project="$2"; shift 2 ;;
      --prompt|-p)      prompt="$2"; shift 2 ;;
      --orchestrator|-o) orchestrator=true; shift ;;
      --skip-perms|-y)  skip_perms=true; shift ;;
      --continue)       continue_flag=true; shift ;;
      --resume)         resume="$2"; shift 2 ;;
      *) subctl_die "unknown spawn flag: $1" ;;
    esac
  done
  [[ -z "$account" || -z "$project" ]] && subctl_die "usage: subctl orch spawn --account <a> --project <path> [opts]"
  # Expand ~ in project path
  project="${project/#\~/$HOME}"

  # Anti-stuck preface — auto-prepend a worker-role assertion to every prompt.
  # Belt-and-braces with the SUBCTL_AGENT_ROLE=worker env var injected by
  # teams.sh: even if the env var is somehow lost, the prompt itself tells
  # the worker not to load orchestrator-mode. Prevents the deadlock pattern
  # where a worker reading 'orchestrator (parent...)' in its assigned task
  # description would self-load orchestrator-mode and wait forever.
  #
  # Skipped when prompt is empty (interactive spawn / resume cases).
  if [[ -n "$prompt" ]]; then
    local PREFACE="⚠ subctl-worker-preface (auto-prepended by orch.sh):
You are running as a subctl worker. NOT an orchestrator. Do NOT load the
orchestrator-mode skill. Do NOT TeamCreate. Do NOT spawn sub-workers. If
your prompt below mentions 'orchestrator (parent...)' or 'team-lead' that
refers to your PARENT — you don't replicate that role. Execute your
assigned task directly. If the task is genuinely too large or ambiguous to
execute as one worker, fire \`subctl notify ask-yesno\` to escalate to
the operator. Don't dispatch sub-workers without explicit authorization.

────────────────────────────────────────────────────────────
"
    prompt="${PREFACE}${prompt}"
  fi

  local payload
  payload=$(jq -nc \
    --arg a "$account" \
    --arg p "$project" \
    --arg pr "$prompt" \
    --arg rs "$resume" \
    --argjson o "$orchestrator" \
    --argjson sp "$skip_perms" \
    --argjson c "$continue_flag" \
    '{
      account: $a, project: $p, prompt: $pr,
      orchestrator: $o, skip_perms: $sp, continue: $c,
      resume: (if $rs == "" then null else $rs end)
    }')
  local resp
  resp=$(curl -sS --max-time 35 -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "${API_BASE}/api/orchestration/spawn" 2>&1)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    local name
    name=$(echo "$resp" | jq -r '.session_name')
    subctl_ok "spawned: $name"
    echo "  attach with: tmux attach -t $name"
    return 0
  fi
  subctl_err "spawn failed"
  echo "$resp" | head -c 500
  echo
  return 1
}

subctl_orch_list() {
  curl -sS --max-time 5 "${API_BASE}/api/orchestration" \
    | jq -r '.orchestrations // [] | if length == 0 then "  (no orchestrator sessions running)" else (
        ["NAME","ATTACHED","ACCOUNT_DIR","PATH"], (.[] | [.name, (.attached | tostring), (.claude_account_dir // "—"), .path])
        | @tsv
      ) end' \
    | column -t -s $'\t'
}

subctl_orch_status() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl orch status <name>"
  curl -sS --max-time 5 "${API_BASE}/api/orchestration/$(printf %s "$name" | jq -sRr @uri)" \
    | jq -r '
        if .ok then (
          "session: \(.session.name)",
          "path:    \(.session.path)",
          "attached:\(.session.attached)",
          "account: \(.session.claude_account_dir // "—")",
          "panes:   \(.session.panes | length)",
          "",
          "── preview (last lines of active pane) ──",
          .session.preview
        ) else "error: \(.error)" end'
}

subctl_orch_msg() {
  local name="${1:-}"; shift || true
  [[ -z "$name" || $# -eq 0 ]] && subctl_die "usage: subctl orch msg <name> <text...>"
  local text="$*"
  local payload
  payload=$(jq -nc --arg t "$text" '{text: $t}')
  local resp
  resp=$(curl -sS --max-time 5 -X POST \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "${API_BASE}/api/orchestration/$(printf %s "$name" | jq -sRr @uri)/msg" 2>&1)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    subctl_ok "message injected into $name"
    return 0
  fi
  subctl_err "msg failed: $(echo "$resp" | jq -r '.error // .' 2>/dev/null | head -c 200)"
  return 1
}

subctl_orch_kill() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl orch kill <name>"
  local resp
  resp=$(curl -sS --max-time 5 -X POST \
    "${API_BASE}/api/orchestration/$(printf %s "$name" | jq -sRr @uri)/kill" 2>&1)
  local ok
  ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    subctl_ok "killed $name"
  else
    subctl_err "kill failed"
    echo "$resp" | head -c 200
    return 1
  fi
}
