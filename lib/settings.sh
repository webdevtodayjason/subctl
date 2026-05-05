#!/usr/bin/env bash
# lib/settings.sh — merge subctl statusline + Stop hook into every Claude config dir.
# Idempotent. Backs up before each merge.
#
# Each Claude account uses its own CLAUDE_CONFIG_DIR, so settings.json keys must
# be present in *that* dir's settings.json — not just ~/.claude. We install into:
#   - $HOME/.claude (the default, used when CLAUDE_CONFIG_DIR is unset)
#   - every claude-provider account's cfg_dir from accounts.conf

[[ -n "${_SUBCTL_SETTINGS_LOADED:-}" ]] && return 0
_SUBCTL_SETTINGS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# Constants kept for backwards-compat with any external callers that referenced
# the default-dir paths directly. Internal code now derives paths from cfg_dir.
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SCRIPTS="$HOME/.claude/scripts"
CLAUDE_HOOKS="$HOME/.claude/hooks"
CLAUDE_COMMANDS="$HOME/.claude/commands"

# Enumerate every Claude config dir we need to wire up: the default ~/.claude
# plus every claude-provider account from accounts.conf. De-duped, one path per
# line, ~ already expanded.
subctl_settings_claude_dirs() {
  printf "%s\n" "$HOME/.claude"
  subctl_accounts_by_provider claude | awk -F'\t' '{print $4}'
}

# Install symlinks + merge settings.json for ONE Claude config dir.
# Args: $1 = cfg_dir (e.g. ~/.claude or ~/.claude-jason)
subctl_settings_install_claude_dir() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "install_claude_dir: missing cfg_dir"; return 1; }
  subctl_require jq "install: brew install jq" || return 1

  local scripts="$cfg_dir/scripts"
  local hooks="$cfg_dir/hooks"
  local commands="$cfg_dir/commands"
  local settings="$cfg_dir/settings.json"

  mkdir -p "$scripts" "$hooks" "$commands"

  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/statusline.sh"            "$scripts/statusline.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/dispatch-check.sh"        "$scripts/dispatch-check.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/lib/radar.sh"                              "$scripts/signals.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/hooks/log-rate-limits.sh" "$hooks/log-rate-limits.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/commands/dispatch-check.md" "$commands/dispatch-check.md"

  if [[ -f "$settings" ]]; then
    local backup="$settings.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$settings" "$backup"
  fi
  [[ -f "$settings" ]] || echo '{}' > "$settings"

  jq --arg statusline "$scripts/statusline.sh" \
     --arg hook       "$hooks/log-rate-limits.sh" '
    .statusLine = {type: "command", command: $statusline}
    | .hooks = (.hooks // {})
    | .hooks.Stop = (.hooks.Stop // [])
    | if (.hooks.Stop | map((.hooks // []) | map(.command // "") | any(. == $hook)) | any) then .
      else .hooks.Stop += [{hooks: [{type: "command", command: $hook}]}] end
  ' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"

  subctl_ok "wired statusline + Stop hook into $cfg_dir"
}

# Public entrypoint. Installs into every Claude config dir (default + accounts).
subctl_settings_install_claude() {
  subctl_require jq "install: brew install jq" || return 1
  local cfg_dir
  while IFS= read -r cfg_dir; do
    [[ -z "$cfg_dir" ]] && continue
    subctl_settings_install_claude_dir "$cfg_dir"
  done < <(subctl_settings_claude_dirs | awk '!seen[$0]++')
}

# Ensure a per-account settings.json carries the keys that gate Claude Code's
# experimental team-pane runtime (TeamCreate/TeamList/SendMessage and the
# Agent(team_name=...) variant). Without these in the *account's* settings.json
# the flags from ~/.claude/settings.json don't apply, because each account uses
# its own CLAUDE_CONFIG_DIR.
#
# Idempotent: only adds keys that are missing; leaves user customizations alone.
# Safe to call on every launch.
#
# Args: $1 = cfg_dir (e.g. ~/.claude-semfreak)
subctl_settings_ensure_teams() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "ensure_teams: missing cfg_dir"; return 1; }
  [[ -d "$cfg_dir" ]] || { subctl_warn "ensure_teams: $cfg_dir does not exist"; return 1; }
  subctl_require jq "install: brew install jq" || return 1

  local f="$cfg_dir/settings.json"
  [[ -f "$f" ]] || echo '{}' > "$f"

  # Already has both keys? Skip silently — this runs on every launch.
  if jq -e '
    (.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS == "1") and
    (.teammateMode == "tmux")
  ' "$f" >/dev/null 2>&1; then
    return 0
  fi

  jq '
    .env = (.env // {})
    | .env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    | .teammateMode = (.teammateMode // "tmux")
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  subctl_ok "seeded experimental teams keys into $f"
}

# Uninstall subctl entries from ONE Claude config dir.
# Restores most recent <settings>.bak.* if found; otherwise surgically deletes
# .statusLine and any Stop hook command containing "subctl" or "log-rate-limits".
# Removes symlinks under that dir only if they point at our repo.
subctl_settings_uninstall_claude_dir() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "uninstall_claude_dir: missing cfg_dir"; return 1; }

  local settings="$cfg_dir/settings.json"
  local scripts="$cfg_dir/scripts"
  local hooks="$cfg_dir/hooks"
  local commands="$cfg_dir/commands"

  if [[ -f "$settings" ]]; then
    local backup
    backup=$(ls -t "$settings".bak.* 2>/dev/null | head -1 || true)
    if [[ -n "$backup" ]]; then
      cp "$backup" "$settings"
      subctl_ok "restored $settings from $backup"
    else
      jq 'del(.statusLine) |
          if .hooks.Stop then
            .hooks.Stop = (.hooks.Stop | map(select(
              (.hooks // []) | map(.command // "") | any(test("subctl|log-rate-limits")) | not
            )))
          else . end' \
         "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
      subctl_info "removed subctl entries from $settings (no backup found)"
    fi
  fi

  local f target
  for f in \
    "$scripts/statusline.sh" \
    "$scripts/dispatch-check.sh" \
    "$scripts/signals.sh" \
    "$hooks/log-rate-limits.sh" \
    "$commands/dispatch-check.md"; do
    if [[ -L "$f" ]]; then
      target=$(readlink "$f")
      if [[ "$target" == "$SUBCTL_REPO_ROOT"/* ]]; then
        rm -f "$f"
        subctl_info "unlinked $f"
      fi
    fi
  done
}

# Public entrypoint. Uninstalls from every Claude config dir (default + accounts).
subctl_settings_uninstall_claude() {
  local cfg_dir
  while IFS= read -r cfg_dir; do
    [[ -z "$cfg_dir" ]] && continue
    subctl_settings_uninstall_claude_dir "$cfg_dir"
  done < <(subctl_settings_claude_dirs | awk '!seen[$0]++')
}
