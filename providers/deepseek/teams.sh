#!/usr/bin/env bash
# providers/deepseek/teams.sh — tmux launcher for a CodeWhale (codewhale)
# session pinned to a specific subctl account via HOME-shadowing.
#
# v3.0.0-rc1: UNGATED. No SPEC-block HMAC, no trust-marker, no PreToolUse
# hook. CodeWhale does not (yet) expose a hook surface analogous to Claude
# Code's PreToolUse contract; once that lands — either an upstream hook
# affordance or a wrapper that intercepts `codewhale exec --output-format
# stream-json` — this file will grow a policy section analogous to
# providers/claude/teams.sh:184-228. Tracked as v3.0.0-rc2 work.
#
# Isolation strategy: HOME-shadowing. CodeWhale reads HOME at startup to
# locate ~/.deepseek/{config.toml,secrets/,sessions/,audit.log}. Re-pointing
# HOME at a per-alias subdir gives us account isolation natively, no env-
# var juggling and no keychain shim. The shadow root is the same path
# auth.sh used; pinned in cfg_dir/.subctl-deepseek-home.

[[ -n "${_SUBCTL_DEEPSEEK_TEAMS_LOADED:-}" ]] && return 0
_SUBCTL_DEEPSEEK_TEAMS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Mirror of _provider_deepseek_home_dir in auth.sh. Duplicated to avoid
# pulling auth.sh's full sourcing chain into the teams hot path.
_provider_deepseek_teams_home_dir() {
  local alias="$1"
  printf '%s\n' "$HOME/.subctl-deepseek-aliases/$alias"
}

# Implements the provider interface: provider_teams [opts]
# Opts:
#   -a, --account <alias>   Required. Account to pin this session to.
#   -p, --prompt <text>     Send an initial prompt after launch (paste-buffer)
#   -f, --prompt-file <f>   Read initial prompt from file
#   -m, --model <name>      CodeWhale model to use (sets --model on codewhale)
#   -y, --yes               Auto-approve tools (maps to codewhale --yolo)
#   -c, --continue          Continue the most recent session for this workspace
#                           (maps to `codewhale resume --last`)
#   -o, --orchestrator      Accepted as no-op in v3.0.0-rc1 — CodeWhale has
#                           no orchestrator role concept. Reserved for
#                           v3.0.0-rc2 once the HMAC + trust-marker work
#                           defines what "orchestrator pane" means here.
#   --dry-run               Print what it would do, don't launch tmux
#   --no-attach             Skip the final tmux attach/switch (HTTP-spawn path)
#
# Differences from providers/claude/teams.sh worth noting:
#   - No --template: dev-team templates encode Claude-specific personas +
#     skills paths. CodeWhale parity for the template format is a follow-up.
#   - No --mode / --policy-preset: UNGATED in v3.0.0-rc1.
#   - -c is --continue (boolean), NOT a cwd flag — `subctl teams claude`
#     uses the same semantic, mirrored here.
provider_deepseek_teams() {
  local ACCOUNT="" DRY_RUN=false MODEL=""
  local INITIAL_PROMPT="" PROMPT_FILE=""
  local YOLO=false CONTINUE=false ORCHESTRATOR=false
  local NO_ATTACH="${SUBCTL_NO_ATTACH:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a|--account)      ACCOUNT="$2"; shift 2 ;;
      -p|--prompt)       INITIAL_PROMPT="$2"; shift 2 ;;
      -f|--prompt-file)  PROMPT_FILE="$2"; shift 2 ;;
      -m|--model)        MODEL="$2"; shift 2 ;;
      -y|--yes)          YOLO=true; shift ;;
      -c|--continue)     CONTINUE=true; shift ;;
      -o|--orchestrator) ORCHESTRATOR=true; shift ;;
      --no-attach)       NO_ATTACH=1; shift ;;
      --dry-run)         DRY_RUN=true; shift ;;
      -h|--help)
        cat <<EOF
Usage: subctl teams deepseek -a <alias> [opts]

Spawn a CodeWhale (\`codewhale\`) session in a detached tmux session,
pinned to a specific subctl account via HOME-shadowing.

Options:
  -a, --account <alias>     Required. Account from accounts.conf.
  -p, --prompt <text>       Initial prompt to send after the session boots.
  -f, --prompt-file <f>     Read initial prompt from file.
  -m, --model <name>        Model passed to codewhale --model.
  -y, --yes                 Auto-approve tools (maps to codewhale --yolo).
  -c, --continue            Resume most recent session (codewhale resume --last).
  -o, --orchestrator        Accepted as no-op in v3.0.0-rc1 (reserved).
      --no-attach           Detached spawn (HTTP-spawn / external callers).
      --dry-run             Print what it would do; don't launch.

v3.0.0-rc1 ships UNGATED — no SPEC-block HMAC / PreToolUse policy hook
for codewhale yet. See providers/deepseek/README.md for the roadmap.
EOF
        return 0
        ;;
      *) subctl_die "unknown teams option: $1" ;;
    esac
  done

  [[ -z "$ACCOUNT" ]] && subctl_die "subctl teams deepseek requires -a <alias>. Run: subctl accounts"

  if ! subctl_have codewhale; then
    subctl_err "codewhale binary not on PATH"
    subctl_err "  install: npm install -g codewhale"
    subctl_err "  or:      cargo install codewhale-cli --locked"
    subctl_err "  or:      brew install deepseek-tui   # formula kept the old name"
    return 1
  fi
  subctl_require tmux "install: brew install tmux" || return 1

  # Resolve alias (allows bare "personal" → "deepseek-personal")
  local resolved cfg_dir email provider
  resolved=$(subctl_resolve_alias "$ACCOUNT") \
    || subctl_die "unknown account: $ACCOUNT (run: subctl accounts)"

  provider=$(subctl_account_field "$resolved" 2)
  [[ "$provider" != "deepseek" ]] && \
    subctl_die "account $resolved is provider=$provider, not deepseek"

  cfg_dir=$(subctl_account_field "$resolved" 4)
  email=$(subctl_account_field "$resolved" 3)

  # HOME-shadow dir. Prefer the pinned path in cfg_dir/.subctl-deepseek-home
  # if auth.sh wrote one; fall back to the derive-from-alias path. Keeps
  # the contract stable even if cfg_dir got nuked.
  local dsk_home
  if [[ -f "$cfg_dir/.subctl-deepseek-home" ]]; then
    dsk_home=$(head -1 "$cfg_dir/.subctl-deepseek-home")
  fi
  [[ -z "$dsk_home" ]] && dsk_home=$(_provider_deepseek_teams_home_dir "$resolved")
  mkdir -p "$dsk_home/.deepseek"

  # Resolve initial prompt source
  if [[ -n "$PROMPT_FILE" ]]; then
    [[ -f "$PROMPT_FILE" ]] || subctl_die "prompt file not found: $PROMPT_FILE"
    INITIAL_PROMPT="$(cat "$PROMPT_FILE")"
  fi

  # team_id == tmux SESSION_NAME — matches the claude/pi convention so
  # dashboards can treat all providers' sessions uniformly. Prefix with
  # `dsk-` to distinguish from claude-* / pi-*.
  local SESSION_NAME
  SESSION_NAME="dsk-$(basename "$PWD" | tr '.: ' '___')"

  # Build the launch command. codewhale is interactive by default; we let
  # the binary occupy the pane same as pi. `--yolo` maps to -y. Model flag
  # is passed via --model (codewhale also honors DEEPSEEK_MODEL env, but
  # the flag wins).
  local -a CW_CMD=( command codewhale )
  $YOLO && CW_CMD+=( --yolo )
  [[ -n "$MODEL" ]] && CW_CMD+=( --model "$MODEL" )
  if $CONTINUE; then
    # `codewhale resume --last` resumes the most recent session for the
    # current workspace. Subcommand goes BEFORE the global flags above
    # don't apply to resume — codewhale parses them positionally.
    CW_CMD=( command codewhale resume --last )
  fi

  echo "🚀 Starting CodeWhale in tmux session: $SESSION_NAME"
  echo "   Directory:             $PWD"
  echo "   Account:               $resolved  ($email)"
  echo "   codewhale HOME shadow: $dsk_home"
  echo "   Command:               ${CW_CMD[*]}"
  [[ -n "$MODEL" ]] && echo "   Model:                 $MODEL"
  $YOLO          && echo "   Tool approval:         YOLO (auto-approve)"
  $CONTINUE      && echo "   Session:               resume --last"
  $ORCHESTRATOR  && echo "   Orchestrator flag:     (no-op in v3.0.0-rc1)"
  if [[ -n "$INITIAL_PROMPT" ]]; then
    local SHORT_PROMPT
    SHORT_PROMPT="$(echo "$INITIAL_PROMPT" | head -c 80)"
    echo "   Prompt:                ${SHORT_PROMPT}..."
  fi
  echo "   Policy:                UNGATED (v3.0.0-rc1 — see providers/deepseek/README.md)"

  $DRY_RUN && { echo "(dry run — not launching tmux)"; return 0; }

  # Kill stale session with same name (silently)
  tmux has-session -t "$SESSION_NAME" 2>/dev/null && tmux kill-session -t "$SESSION_NAME"

  # Start new detached session with HOME shadowed at the per-alias dir.
  # PATH is preserved via tmux's default env-passthrough. We do NOT set
  # DEEPSEEK_API_KEY here — codewhale will find the key under
  # $dsk_home/.deepseek/config.toml via the HOME shadow, which is more
  # robust than env-var injection (keys never appear in `tmux show-env`).
  #
  # -x 220 -y 50: same rationale as claude/pi providers — wider pane so
  # the dashboard's tmux-preview modal stays readable.
  local -a tmux_env_args=(
    -e "HOME=$dsk_home"
    -e "SUBCTL_DEEPSEEK_ACCOUNT=$resolved"
    -e "SUBCTL_AGENT_ROLE=worker"
    -e "SUBCTL_SPAWN_TS=$(date +%s)"
  )

  tmux new-session -d -s "$SESSION_NAME" -c "$PWD" \
    -x 220 -y 50 \
    "${tmux_env_args[@]}"

  # Mouse + wheel ergonomics — same defensive setup as claude/pi providers.
  tmux set-option -g mouse on 2>/dev/null || true
  if ! tmux list-keys -T root 2>/dev/null | grep -q 'WheelUpPane'; then
    tmux bind-key -T root WheelUpPane \
      if-shell -F -t = "#{?pane_in_mode,1,#{alternate_on}}" \
      "send-keys -M" "select-pane -t=; copy-mode -e; send-keys -M"
    tmux bind-key -T root WheelDownPane select-pane -t= \\\; send-keys -M
  fi

  # Launch codewhale in the first pane.
  tmux send-keys -t "$SESSION_NAME" "${CW_CMD[*]}" Enter

  # Paste the initial prompt once codewhale's prompt marker shows up.
  # CodeWhale's TUI prompt marker is empirically not documented (per its
  # README); we poll for either `>` or `❯` to stay tolerant of variations
  # and skinning. 60s ceiling mirrors the claude/pi provider wait-loops.
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
