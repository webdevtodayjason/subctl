#!/usr/bin/env bash
# providers/pi-coding-agent/teams.sh — tmux launcher for a pi-coding-agent
# session pinned to a specific subctl account.
#
# v2.7.0: UNGATED. No policy snapshot writes, no PreToolUse hook. Pi has its
# own hook model that doesn't match Claude Code's PreToolUse contract; once
# we settle on a pi-native gate surface (v2.7.1+) this file will grow a
# policy section analogous to providers/claude/teams.sh:184-228.
#
# Isolation strategy: HOME-shadowing. Pi reads HOME at startup to locate
# ~/.pi/agent/sessions and friends. Re-pointing HOME at a per-alias subdir
# gives us account isolation without needing an upstream PI_CONFIG_DIR
# env var. Tracked as a future cleanup in README.md.

[[ -n "${_SUBCTL_PI_TEAMS_LOADED:-}" ]] && return 0
_SUBCTL_PI_TEAMS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Mirror of _provider_pi_home_dir in auth.sh. Duplicated to avoid pulling
# auth.sh's full sourcing chain into the teams hot path.
_provider_pi_teams_home_dir() {
  local alias="$1"
  printf '%s\n' "$HOME/.subctl-pi-aliases/$alias"
}

# Implements the provider interface: provider_teams [opts]
# Opts:
#   -a, --account <alias>   Required. Account to pin this session to.
#   -p, --prompt <text>     Send an initial prompt after launch (paste-buffer)
#   -f, --prompt-file <f>   Read initial prompt from file
#   -m, --model <name>      Pi model to use (overrides PI_MODEL env)
#   --dry-run               Print what it would do, don't launch tmux
#   --no-attach             Skip the final tmux attach/switch (HTTP-spawn path)
#
# Differences from providers/claude/teams.sh worth noting:
#   - No --orchestrator: pi doesn't have an analog to Claude Code's "team
#     agents" tools, so the orchestrator prompt template is meaningless here.
#   - No --continue / --resume <sid>: pi-coding-agent's session resume CLI
#     surface isn't stable yet (RPC mode hints at it; the human CLI doesn't).
#   - No --template: dev-team templates encode Claude-specific personas +
#     skills paths. Pi support for the template format lands in a later PR.
#   - No --mode / --policy-preset: UNGATED per D1 Option B.
provider_pi_coding_agent_teams() {
  local ACCOUNT="" DRY_RUN=false MODEL=""
  local INITIAL_PROMPT="" PROMPT_FILE=""
  local NO_ATTACH="${SUBCTL_NO_ATTACH:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a|--account)      ACCOUNT="$2"; shift 2 ;;
      -p|--prompt)       INITIAL_PROMPT="$2"; shift 2 ;;
      -f|--prompt-file)  PROMPT_FILE="$2"; shift 2 ;;
      -m|--model)        MODEL="$2"; shift 2 ;;
      --no-attach)       NO_ATTACH=1; shift ;;
      --dry-run)         DRY_RUN=true; shift ;;
      -h|--help)
        cat <<EOF
Usage: subctl teams pi-coding-agent -a <alias> [opts]

Spawn a pi-coding-agent (\`pi\`) session in a detached tmux session, pinned
to a specific subctl account via HOME-shadowing.

Options:
  -a, --account <alias>    Required. Account from accounts.conf.
  -p, --prompt <text>      Initial prompt to paste after the session boots.
  -f, --prompt-file <f>    Read initial prompt from file.
  -m, --model <name>       Model to pass to pi (sets PI_MODEL).
      --no-attach          Detached spawn (HTTP-spawn / external callers).
      --dry-run            Print what it would do; don't launch.

v2.7.0 ships UNGATED — no PreToolUse policy hook for pi-coding-agent yet.
See providers/pi-coding-agent/README.md for the policy roadmap.
EOF
        return 0
        ;;
      *) subctl_die "unknown teams option: $1" ;;
    esac
  done

  [[ -z "$ACCOUNT" ]] && subctl_die "subctl teams pi-coding-agent requires -a <alias>. Run: subctl accounts"

  if ! subctl_have pi; then
    subctl_err "pi binary not on PATH"
    subctl_err "  install: npm install -g @mariozechner/pi-coding-agent"
    return 1
  fi
  subctl_require tmux "install: brew install tmux" || return 1

  # Resolve alias (allows bare "personal" → "pi-personal")
  local resolved cfg_dir email provider
  resolved=$(subctl_resolve_alias "$ACCOUNT") \
    || subctl_die "unknown account: $ACCOUNT (run: subctl accounts)"

  provider=$(subctl_account_field "$resolved" 2)
  [[ "$provider" != "pi-coding-agent" ]] && \
    subctl_die "account $resolved is provider=$provider, not pi-coding-agent"

  cfg_dir=$(subctl_account_field "$resolved" 4)
  email=$(subctl_account_field "$resolved" 3)

  # HOME-shadow dir. Prefer the pinned path in cfg_dir/.subctl-pi-home if
  # auth.sh wrote one; fall back to the derive-from-alias path. This keeps
  # the contract stable even if cfg_dir got nuked.
  local pi_home
  if [[ -f "$cfg_dir/.subctl-pi-home" ]]; then
    pi_home=$(head -1 "$cfg_dir/.subctl-pi-home")
  fi
  [[ -z "$pi_home" ]] && pi_home=$(_provider_pi_teams_home_dir "$resolved")
  mkdir -p "$pi_home/.pi/agent"

  # Resolve initial prompt source
  if [[ -n "$PROMPT_FILE" ]]; then
    [[ -f "$PROMPT_FILE" ]] || subctl_die "prompt file not found: $PROMPT_FILE"
    INITIAL_PROMPT="$(cat "$PROMPT_FILE")"
  fi

  # team_id == tmux SESSION_NAME — matches Claude's convention so dashboards
  # can treat all providers' sessions uniformly. Distinguish from claude-*
  # sessions with a `pi-` prefix.
  local SESSION_NAME
  SESSION_NAME="pi-$(basename "$PWD" | tr '.: ' '___')"

  # Build the launch command. pi is interactive by default; we want the same
  # behavior subctl uses for claude — let the binary occupy the pane.
  local PI_CMD="command pi"

  echo "🚀 Starting pi-coding-agent in tmux session: $SESSION_NAME"
  echo "   Directory:     $PWD"
  echo "   Account:       $resolved  ($email)"
  echo "   pi HOME shadow: $pi_home"
  echo "   Command:       $PI_CMD"
  [[ -n "$MODEL" ]] && echo "   Model:         $MODEL"
  if [[ -n "$INITIAL_PROMPT" ]]; then
    local SHORT_PROMPT
    SHORT_PROMPT="$(echo "$INITIAL_PROMPT" | head -c 80)"
    echo "   Prompt:        ${SHORT_PROMPT}..."
  fi
  echo "   Policy:        UNGATED (v2.7.0 — see providers/pi-coding-agent/README.md)"

  $DRY_RUN && { echo "(dry run — not launching tmux)"; return 0; }

  # Kill stale session with same name (silently)
  tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

  # Start new detached session with HOME shadowed at the per-alias dir. PATH
  # is preserved via tmux's default env-passthrough. PI_MODEL is set only if
  # the operator chose one via -m, so we don't accidentally clobber a model
  # the user set in their pi config.
  #
  # -x 220 -y 50: same rationale as providers/claude/teams.sh — wider pane
  # so the dashboard's tmux-preview modal stays readable.
  local -a tmux_env_args=(
    -e "HOME=$pi_home"
    -e "SUBCTL_PI_ACCOUNT=$resolved"
    -e "SUBCTL_AGENT_ROLE=worker"
    -e "SUBCTL_SPAWN_TS=$(date +%s)"
  )
  [[ -n "$MODEL" ]] && tmux_env_args+=( -e "PI_MODEL=$MODEL" )

  tmux new-session -d -s "$SESSION_NAME" -c "$PWD" \
    -x 220 -y 50 \
    "${tmux_env_args[@]}"

  # Mouse + wheel ergonomics — same defensive setup as claude provider.
  tmux set-option -g mouse on 2>/dev/null || true
  if ! tmux list-keys -T root 2>/dev/null | grep -q 'WheelUpPane'; then
    tmux bind-key -T root WheelUpPane \
      if-shell -F -t = "#{?pane_in_mode,1,#{alternate_on}}" \
      "send-keys -M" "select-pane -t=; copy-mode -e; send-keys -M"
    tmux bind-key -T root WheelDownPane select-pane -t= \\\; send-keys -M
  fi

  # Launch pi in the first pane.
  tmux send-keys -t "$SESSION_NAME" "$PI_CMD" Enter

  # Paste the initial prompt once pi's prompt marker shows up. Pi's prompt
  # marker in human-CLI mode is `>` (single chevron, distinct from claude's
  # `❯`). We poll for either to stay tolerant of future skinning. 60s ceiling
  # mirrors the claude provider's wait-loop.
  if [[ -n "$INITIAL_PROMPT" ]]; then
    (
      local elapsed=0
      while [[ $elapsed -lt 120 ]]; do
        if tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null \
             | grep -qE '^(>|❯)'; then
          break
        fi
        sleep 0.5
        elapsed=$((elapsed + 1))
      done
      if [[ $elapsed -ge 120 ]]; then
        echo "$(date -u +%FT%TZ) [$SESSION_NAME] ready-check timeout, pasting anyway" \
          >> /tmp/subctl-spawn-paste.log 2>&1 || true
      fi
      sleep 0.3
      tmux set-buffer -b subctl-prompt "$INITIAL_PROMPT"
      tmux paste-buffer -t "$SESSION_NAME" -b subctl-prompt
      sleep 0.3
      tmux send-keys -t "$SESSION_NAME" Enter
    ) </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi

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
