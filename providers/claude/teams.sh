#!/usr/bin/env bash
# providers/claude/teams.sh — tmux launcher for a Claude Code session pinned
# to a specific account. Replaces the standalone claude-teams script.

[[ -n "${_SUBCTL_CLAUDE_TEAMS_LOADED:-}" ]] && return 0
_SUBCTL_CLAUDE_TEAMS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/settings.sh"

# Implements the provider interface: provider_teams [opts]
# Opts:
#   -a, --account <alias>   Required. Account to pin this session to.
#   -y, --yes               Pass --dangerously-skip-permissions to claude
#   -c, --continue          Pass --continue
#   -p, --prompt <text>     Send an initial prompt after launch
#   -f, --prompt-file <f>   Read initial prompt from file
#   -o, --orchestrator      Use built-in orchestrator prompt
#   --resume <sid>          Resume a specific Claude Code session by ID
#                           (mutually exclusive with -c/-o/-p/-f)
#   --dry-run               Print what it would do, don't launch tmux
provider_claude_teams() {
  local ACCOUNT="" SKIP_PERMS=false CONTINUE=false ORCHESTRATOR=false DRY_RUN=false
  local INITIAL_PROMPT="" PROMPT_FILE="" RESUME_SID=""
  # --no-attach is for HTTP-spawned sessions (dashboard's POST /api/orchestration/spawn).
  # Skips the final tmux attach/switch-client so the caller process exits cleanly.
  local NO_ATTACH="${SUBCTL_NO_ATTACH:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a|--account)      ACCOUNT="$2"; shift 2 ;;
      -y|--yes)          SKIP_PERMS=true; shift ;;
      -c|--continue)     CONTINUE=true; shift ;;
      -p|--prompt)       INITIAL_PROMPT="$2"; shift 2 ;;
      -f|--prompt-file)  PROMPT_FILE="$2"; shift 2 ;;
      -o|--orchestrator) ORCHESTRATOR=true; shift ;;
      --resume)          RESUME_SID="$2"; shift 2 ;;
      --no-attach)       NO_ATTACH=1; shift ;;
      --dry-run)         DRY_RUN=true; shift ;;
      *) subctl_die "unknown teams option: $1" ;;
    esac
  done

  # --resume <sid> is mutually exclusive with --continue / --orchestrator /
  # --prompt: claude rejects an initial prompt when resuming, and --continue
  # is the broader 'just resume the latest' that --resume <sid> overrides.
  if [[ -n "$RESUME_SID" ]]; then
    if $CONTINUE || $ORCHESTRATOR || [[ -n "$INITIAL_PROMPT" ]] || [[ -n "$PROMPT_FILE" ]]; then
      subctl_warn "--resume <sid> ignores --continue, --orchestrator, --prompt, and --prompt-file"
      CONTINUE=false; ORCHESTRATOR=false; INITIAL_PROMPT=""; PROMPT_FILE=""
    fi
  fi

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

  # Ensure the per-account settings.json has the experimental teams keys, so
  # Team*/SendMessage tools surface no matter how this account is launched
  # (teams subcommand, claude-<alias> alias, or anything else).
  subctl_settings_ensure_teams "$cfg_dir"

  # Build claude command (use `command claude` to bypass shell function shadow)
  local CLAUDE_CMD="command claude"
  $SKIP_PERMS && CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
  $CONTINUE   && CLAUDE_CMD="$CLAUDE_CMD --continue"
  [[ -n "$RESUME_SID" ]] && CLAUDE_CMD="$CLAUDE_CMD --resume $RESUME_SID"

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
  # CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 is what surfaces the Team*/SendMessage
  # tools and the Agent(team_name=...) variant — without it /team is just a
  # markdown skill with no runtime, which defeats the whole point of `teams`.
  tmux new-session -d -s "$SESSION_NAME" -c "$PWD" \
    -e "CLAUDE_CONFIG_DIR=$cfg_dir" \
    -e "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"

  # Defensive tmux ergonomics for this server. Without these, Claude Code's
  # mouse tracking eats wheel events, leaving tmux's scrollback unreachable
  # and pane resize awkward. Idempotent — only writes WheelUp/Down bindings
  # if not already present, so users with their own wheel mappings keep them.
  tmux set-option -g mouse on 2>/dev/null || true
  if ! tmux list-keys -T root 2>/dev/null | grep -q 'WheelUpPane'; then
    tmux bind-key -T root WheelUpPane \
      if-shell -F -t = "#{?pane_in_mode,1,#{alternate_on}}" \
      "send-keys -M" "select-pane -t=; copy-mode -e; send-keys -M"
    tmux bind-key -T root WheelDownPane select-pane -t= \\\; send-keys -M
  fi

  # Launch Claude in the first pane
  tmux send-keys -t "$SESSION_NAME" "$CLAUDE_CMD" Enter

  # Send initial prompt after Claude boots.
  #
  # PRIOR BUG: a fixed `sleep 3` here silently lost prompts on most spawns —
  # Claude Code takes 5–15s to render its UI on first launch (banner + the
  # SessionStart hook's claude-mem context dump + initial frame). Pasting at
  # T+3s landed the prompt during the boot sequence, where it was either
  # consumed by the still-rendering UI or cleared when claude redrew the
  # screen. Result: spawned sessions sat at an empty `❯` waiting for input
  # the user thought they had already supplied.
  #
  # FIX: poll the pane for the `❯` input-prompt marker (only renders once
  # Claude is fully booted) and paste once it appears. Run the entire
  # wait + paste in a detached subshell so the spawn call returns fast —
  # callers (HTTP API, CLI) get their session_name immediately and the
  # prompt arrives whenever Claude becomes ready. 60s ceiling; warning
  # logged to /tmp/subctl-spawn-paste.log if it can't find the prompt
  # marker before the timeout.
  if [[ -n "$INITIAL_PROMPT" ]]; then
    (
      local elapsed=0
      while [[ $elapsed -lt 120 ]]; do  # 120 × 0.5s = 60s ceiling
        if tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null | grep -q '^❯'; then
          break
        fi
        sleep 0.5
        elapsed=$((elapsed + 1))
      done
      if [[ $elapsed -ge 120 ]]; then
        echo "$(date -u +%FT%TZ) [$SESSION_NAME] ready-check timeout, pasting anyway" \
          >> /tmp/subctl-spawn-paste.log 2>&1 || true
      fi
      sleep 0.3  # a beat after ready so the prompt is fully focused
      tmux set-buffer -b subctl-prompt "$INITIAL_PROMPT"
      tmux paste-buffer -t "$SESSION_NAME" -b subctl-prompt
      sleep 0.3
      tmux send-keys -t "$SESSION_NAME" Enter
    ) </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi

  # Attach (unless --no-attach / SUBCTL_NO_ATTACH=1 was passed, which is the
  # path HTTP-spawned sessions use — they need a clean exit, not a hanging
  # tmux client).
  if [[ -n "$NO_ATTACH" ]]; then
    echo "  (--no-attach: session is detached. Use 'tmux attach -t $SESSION_NAME' to view.)"
    return 0
  fi
  if [[ -n "${TMUX:-}" ]]; then
    tmux switch-client -t "$SESSION_NAME"
  else
    tmux attach-session -t "$SESSION_NAME"
  fi
}
