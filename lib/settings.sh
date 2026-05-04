#!/usr/bin/env bash
# lib/settings.sh — merge subctl statusline + Stop hook into ~/.claude/settings.json.
# Idempotent. Backs up before each merge.

[[ -n "${_SUBCTL_SETTINGS_LOADED:-}" ]] && return 0
_SUBCTL_SETTINGS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SCRIPTS="$HOME/.claude/scripts"
CLAUDE_HOOKS="$HOME/.claude/hooks"
CLAUDE_COMMANDS="$HOME/.claude/commands"

# Install symlinks for statusline, dispatch-check, hook, slash command.
# Then merge settings.json so Claude Code uses them.
subctl_settings_install_claude() {
  subctl_require jq "install: brew install jq" || return 1

  mkdir -p "$CLAUDE_SCRIPTS" "$CLAUDE_HOOKS" "$CLAUDE_COMMANDS"

  # Symlink components from the repo
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/statusline.sh"      "$CLAUDE_SCRIPTS/statusline.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/dispatch-check.sh"  "$CLAUDE_SCRIPTS/dispatch-check.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/lib/radar.sh"                        "$CLAUDE_SCRIPTS/signals.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/hooks/log-rate-limits.sh" "$CLAUDE_HOOKS/log-rate-limits.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/commands/dispatch-check.md" "$CLAUDE_COMMANDS/dispatch-check.md"
  subctl_ok "linked claude statusline + dispatch-check + hook + slash command into ~/.claude/"

  # Backup settings.json before merge
  if [[ -f "$CLAUDE_SETTINGS" ]]; then
    local backup="$CLAUDE_SETTINGS.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$CLAUDE_SETTINGS" "$backup"
    subctl_info "backed up $CLAUDE_SETTINGS → $backup"
  fi

  # Merge: set statusLine; add Stop hook if not present.
  [[ -f "$CLAUDE_SETTINGS" ]] || echo '{}' > "$CLAUDE_SETTINGS"

  jq --arg statusline "$CLAUDE_SCRIPTS/statusline.sh" \
     --arg hook "$CLAUDE_HOOKS/log-rate-limits.sh" '
    .statusLine = {type: "command", command: $statusline}
    | .hooks = (.hooks // {})
    | .hooks.Stop = (.hooks.Stop // [])
    | if (.hooks.Stop | map((.hooks // []) | map(.command // "") | any(. == $hook)) | any) then .
      else .hooks.Stop += [{hooks: [{type: "command", command: $hook}]}] end
  ' "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
  subctl_ok "merged settings.json (statusLine + Stop hook)"
}

# Remove subctl entries from settings.json. Restores most recent backup if available.
subctl_settings_uninstall_claude() {
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    subctl_info "no settings.json to clean"
    return 0
  fi
  local backup
  backup=$(ls -t "$CLAUDE_SETTINGS".bak.* 2>/dev/null | head -1 || true)

  # Try to restore most recent backup
  if [[ -n "$backup" ]]; then
    cp "$backup" "$CLAUDE_SETTINGS"
    subctl_ok "restored settings.json from $backup"
  else
    # Surgical removal of subctl entries
    jq 'del(.statusLine) |
        if .hooks.Stop then
          .hooks.Stop = (.hooks.Stop | map(select(
            (.hooks // []) | map(.command // "") | any(test("subctl|log-rate-limits")) | not
          )))
        else . end' \
       "$CLAUDE_SETTINGS" > "$CLAUDE_SETTINGS.tmp" && mv "$CLAUDE_SETTINGS.tmp" "$CLAUDE_SETTINGS"
    subctl_info "removed subctl entries from settings.json (no backup found)"
  fi

  # Remove symlinks (only if they point at our repo)
  for f in \
    "$CLAUDE_SCRIPTS/statusline.sh" \
    "$CLAUDE_SCRIPTS/dispatch-check.sh" \
    "$CLAUDE_SCRIPTS/signals.sh" \
    "$CLAUDE_HOOKS/log-rate-limits.sh" \
    "$CLAUDE_COMMANDS/dispatch-check.md"; do
    if [[ -L "$f" ]]; then
      local target
      target=$(readlink "$f")
      if [[ "$target" == "$SUBCTL_REPO_ROOT"/* ]]; then
        rm -f "$f"
        subctl_info "unlinked $f"
      fi
    fi
  done
}
