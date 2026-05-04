#!/usr/bin/env bash
# providers/claude/teams.sh — tmux launcher for a Claude Code session pinned
# to a specific account. Replaces the standalone claude-teams script.

[[ -n "${_SUBCTL_CLAUDE_TEAMS_LOADED:-}" ]] && return 0
_SUBCTL_CLAUDE_TEAMS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Implements the provider interface: provider_teams [opts]
# Opts:
#   -a, --account <alias>   Required. Account to pin this session to.
#   -y, --yes               Pass --dangerously-skip-permissions to claude
#   -c, --continue          Pass --continue
#   -p, --prompt <text>     Send an initial prompt after launch
#   -f, --prompt-file <f>   Read initial prompt from file
#   -o, --orchestrator      Use built-in orchestrator prompt
#   --dry-run               Print what it would do, don't launch tmux
provider_claude_teams() {
  local ACCOUNT="" SKIP_PERMS=false CONTINUE=false ORCHESTRATOR=false DRY_RUN=false
  local INITIAL_PROMPT="" PROMPT_FILE=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a|--account)      ACCOUNT="$2"; shift 2 ;;
      -y|--yes)          SKIP_PERMS=true; shift ;;
      -c|--continue)     CONTINUE=true; shift ;;
      -p|--prompt)       INITIAL_PROMPT="$2"; shift 2 ;;
      -f|--prompt-file)  PROMPT_FILE="$2"; shift 2 ;;
      -o|--orchestrator) ORCHESTRATOR=true; shift ;;
      --dry-run)         DRY_RUN=true; shift ;;
      *) subctl_die "unknown teams option: $1" ;;
    esac
  done

  [[ -z "$ACCOUNT" ]] && subctl_die "subctl teams claude requires -a <alias>. Run: subctl accounts"

  subctl_require tmux "install: brew install tmux" || return 1

  # Resolve alias (allows bare "personal" → "claude-personal")
  local resolved cfg_dir email
  resolved=$(subctl_resolve_alias "$ACCOUNT") \
    || subctl_die "unknown account: $ACCOUNT (run: subctl accounts)"

  # Confirm provider
  local provider
  provider=$(subctl_account_field "$resolved" 2)
  [[ "$provider" != "claude" ]] && subctl_die "account $resolved is provider=$provider, not claude"

  cfg_dir=$(subctl_account_field "$resolved" 4)
  email=$(subctl_account_field "$resolved" 3)

  if [[ ! -d "$cfg_dir" ]]; then
    subctl_die "$resolved has no config directory: $cfg_dir (run: subctl auth claude $resolved)"
  fi

  if [[ "$(subctl_auth_status "$cfg_dir")" != "ready" ]]; then
    subctl_warn "$resolved shows no signs of prior login. Claude may prompt OAuth in-pane."
  fi

  # Build claude command (use `command claude` to bypass shell function shadow)
  local CLAUDE_CMD="command claude"
  $SKIP_PERMS && CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
  $CONTINUE   && CLAUDE_CMD="$CLAUDE_CMD --continue"

  # Resolve initial prompt
  local ORCHESTRATOR_PROMPT="This session we will be using team agents. You are the orchestrator. Your role is to:
1. Break down tasks and create specialized subagents to handle them
2. Delegate work to subagents rather than doing everything yourself
3. Coordinate results across agents and synthesize outputs
4. Operate in delegate mode — always prefer spawning an agent over doing it inline

When given a task, first outline your agent plan before proceeding."

  if $ORCHESTRATOR; then
    INITIAL_PROMPT="$ORCHESTRATOR_PROMPT"
  elif [[ -n "$PROMPT_FILE" ]]; then
    [[ -f "$PROMPT_FILE" ]] || subctl_die "prompt file not found: $PROMPT_FILE"
    INITIAL_PROMPT="$(cat "$PROMPT_FILE")"
  fi

  # Sanitize tmux session name
  local SESSION_NAME
  SESSION_NAME="claude-$(basename "$PWD" | tr '.: ' '___')"

  echo "🚀 Starting Claude Teams in tmux session: $SESSION_NAME"
  echo "   Directory: $PWD"
  echo "   Account:   $resolved  ($email)"
  echo "   Config:    $cfg_dir"
  echo "   Command:   $CLAUDE_CMD"
  if [[ -n "$INITIAL_PROMPT" ]]; then
    local SHORT_PROMPT
    SHORT_PROMPT="$(echo "$INITIAL_PROMPT" | head -c 80)"
    echo "   Prompt:    ${SHORT_PROMPT}..."
  fi

  $DRY_RUN && { echo "(dry run — not launching tmux)"; return 0; }

  # Kill stale session with same name (silently)
  tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

  # Start new detached session, passing CLAUDE_CONFIG_DIR via tmux session env
  # so every pane (current and any future split) inherits it explicitly.
  tmux new-session -d -s "$SESSION_NAME" -c "$PWD" -e "CLAUDE_CONFIG_DIR=$cfg_dir"

  # Launch Claude in the first pane
  tmux send-keys -t "$SESSION_NAME" "$CLAUDE_CMD" Enter

  # Send initial prompt after Claude boots
  if [[ -n "$INITIAL_PROMPT" ]]; then
    sleep 3
    tmux set-buffer -b subctl-prompt "$INITIAL_PROMPT"
    tmux paste-buffer -t "$SESSION_NAME" -b subctl-prompt
    sleep 0.3
    tmux send-keys -t "$SESSION_NAME" Enter
  fi

  # Attach. If we're already inside a tmux session, attach-session fails
  # with "open terminal failed: not a terminal" — switch-client is the
  # right verb in that context.
  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$SESSION_NAME"
  else
    tmux attach-session -t "$SESSION_NAME"
  fi
}
