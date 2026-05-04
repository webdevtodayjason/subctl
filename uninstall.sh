#!/usr/bin/env bash
# subctl/uninstall.sh — full reverse of install.sh.
#
# Removes:
#   - /usr/local/bin/subctl symlink
#   - ~/.subctl symlink
#   - subctl symlinks under ~/.claude/scripts, hooks, commands
#   - subctl block from ~/.zshrc
#   - launchd plist + service
#   - generated shell-aliases.sh (if any)
#
# Keeps:
#   - ~/.config/subctl/accounts.conf  (your real config)
#   - ~/.claude*/  account config dirs
#   - ~/.claude/rate-limit-events.log

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$REPO_ROOT/lib/core.sh"

read -r -p "Uninstall subctl? Account data and logs will be kept. [y/N]: " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { echo "aborted."; exit 0; }

# 1. Disable + remove dashboard service
. "$REPO_ROOT/lib/service.sh"
subctl_service_disable

# 2. Remove Claude integration symlinks + restore settings.json backup
. "$REPO_ROOT/lib/settings.sh"
subctl_settings_uninstall_claude

# 3. Remove zshrc block
RC="$HOME/.zshrc"
[[ "$SHELL" == */bash ]] && RC="$HOME/.bashrc"
if [[ -f "$RC" ]]; then
  cp "$RC" "$RC.bak.subctl-uninstall.$(date +%Y%m%d-%H%M%S)"
  tmp=$(mktemp)
  awk '
    /# >>> subctl >>>/{skip=1}
    /# <<< subctl <<</ {skip=0; next}
    !skip
  ' "$RC" > "$tmp" && mv "$tmp" "$RC"
  subctl_ok "removed subctl block from $RC"
fi

# 4. Remove generated aliases
[[ -f "$SUBCTL_CONFIG_DIR/shell-aliases.sh" ]] && rm -f "$SUBCTL_CONFIG_DIR/shell-aliases.sh"

# 5. Remove CLI symlinks
for path in /usr/local/bin/subctl "$HOME/bin/subctl" "$HOME/.subctl"; do
  if [[ -L "$path" ]]; then
    rm -f "$path"
    subctl_info "removed $path"
  fi
done

# 6. Restore claude-teams from latest backup if present
backup=$(ls -t "$HOME"/code/claude-teams.pre-subctl.*.bak 2>/dev/null | head -1 || true)
if [[ -n "$backup" ]] && [[ -f "/usr/local/bin/claude-teams" ]]; then
  if grep -q "subctl teams claude" "/usr/local/bin/claude-teams" 2>/dev/null; then
    cp "$backup" "/usr/local/bin/claude-teams"
    subctl_ok "restored /usr/local/bin/claude-teams from $backup"
  fi
fi

echo
subctl_ok "subctl uninstalled"
echo
echo "Kept (delete manually if you want):"
echo "  $SUBCTL_CONFIG_DIR        — your accounts.conf and logs"
echo "  ~/.claude*                 — your authenticated account dirs"
echo "  ~/.claude/rate-limit-events.log  — historical RL data"
