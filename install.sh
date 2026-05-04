#!/usr/bin/env bash
# subctl/install.sh — one-shot installer.
#
# Usage:
#   ./install.sh                      Interactive install
#   ./install.sh --migrate            Detect + migrate from prior installs
#   ./install.sh --no-shell-rewrite   Skip touching ~/.zshrc
#   ./install.sh --no-service         Skip launchd dashboard service install
#   ./install.sh --dry-run            Show what would happen
#   ./install.sh --uninstall          (delegates to uninstall.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$REPO_ROOT/lib/core.sh"

# ── flags ────────────────────────────────────────────────────────────────────
DO_MIGRATE=false NO_SHELL=false NO_SERVICE=false DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --migrate)          DO_MIGRATE=true ;;
    --no-shell-rewrite) NO_SHELL=true ;;
    --no-service)       NO_SERVICE=true ;;
    --dry-run)          DRY_RUN=true ;;
    --uninstall)        exec bash "$REPO_ROOT/uninstall.sh" ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) subctl_err "unknown arg: $arg"; exit 1 ;;
  esac
done

run() { $DRY_RUN && echo "[dry-run] $*" || eval "$@"; }

# ── pre-flight ───────────────────────────────────────────────────────────────
subctl_info "preflight"
subctl_require jq "install: brew install jq" || exit 1
subctl_require git "install: brew install git" || exit 1

if ! command -v tmux >/dev/null 2>&1; then
  subctl_warn "tmux missing — \`subctl teams\` will not work until you brew install tmux"
fi
if ! command -v gum >/dev/null 2>&1; then
  subctl_warn "gum missing — TUI will use text fallback. Install: brew install gum"
fi
if ! command -v bun >/dev/null 2>&1; then
  subctl_warn "bun missing — dashboard service won't run until you install: curl -fsSL https://bun.sh/install | bash"
fi

# ── 1. ensure ~/.config/subctl + accounts.conf ──────────────────────────────
subctl_info "config"
run subctl_ensure_config_dir

# ── 2. migrate from prior installs (if requested) ───────────────────────────
if $DO_MIGRATE; then
  subctl_info "detecting prior installs"
  . "$REPO_ROOT/lib/migrate.sh"
  subctl_migrate_detect || true
  echo
  subctl_migrate_import_accounts
fi

# ── 3. symlink subctl into /usr/local/bin (if writable) ─────────────────────
subctl_info "linking subctl CLI"
TARGET_BIN="/usr/local/bin/subctl"
if [[ -w "$(dirname "$TARGET_BIN")" ]]; then
  run ln -sfn "$REPO_ROOT/bin/subctl" "$TARGET_BIN"
  subctl_ok "subctl → $TARGET_BIN"
else
  # Fall back to user-writable location
  USER_BIN="$HOME/bin"
  run mkdir -p "$USER_BIN"
  run ln -sfn "$REPO_ROOT/bin/subctl" "$USER_BIN/subctl"
  subctl_warn "$(dirname "$TARGET_BIN") not writable — linked into $USER_BIN/subctl"
  subctl_warn "  add to PATH: export PATH=\"\$HOME/bin:\$PATH\""
fi

# Convenience: also create ~/.subctl pointing at repo root
run ln -sfn "$REPO_ROOT" "$HOME/.subctl"

# ── 4. install Claude provider into ~/.claude ───────────────────────────────
subctl_info "wiring Claude statusline + hook + slash command"
. "$REPO_ROOT/lib/settings.sh"
$DRY_RUN || subctl_settings_install_claude

# ── 5. generate shell aliases + update zshrc ────────────────────────────────
if ! $NO_SHELL; then
  subctl_info "shell aliases"
  . "$REPO_ROOT/lib/migrate.sh"
  $DRY_RUN || subctl_migrate_generate_aliases
  $DRY_RUN || subctl_migrate_zshrc
fi

# ── 6. claude-teams shim ────────────────────────────────────────────────────
if $DO_MIGRATE; then
  subctl_info "replacing /usr/local/bin/claude-teams with shim"
  . "$REPO_ROOT/lib/migrate.sh"
  $DRY_RUN || subctl_migrate_claude_teams_shim
fi

# ── 7. dashboard service (opt-in) ───────────────────────────────────────────
if ! $NO_SERVICE && command -v bun >/dev/null 2>&1; then
  echo
  read -r -p "Enable dashboard service (auto-start at login on http://127.0.0.1:8787)? [y/N]: " enable_svc
  if [[ "$enable_svc" == "y" || "$enable_svc" == "Y" ]]; then
    . "$REPO_ROOT/lib/service.sh"
    $DRY_RUN || subctl_service_enable
  else
    subctl_info "dashboard service skipped — enable later with: subctl service enable"
  fi
fi

# ── 8. summary ──────────────────────────────────────────────────────────────
echo
subctl_ok "subctl v$SUBCTL_VERSION installed"
echo
echo "Next steps:"
echo "  1. Reload your shell:    source ~/.zshrc"
echo "  2. Run TUI:              subctl"
echo "  3. Health check:         subctl doctor"
echo "  4. Authenticate:         subctl auth claude <alias>"
echo "  5. Launch tmux session:  subctl teams claude -a <alias> -o -c -y"
echo
echo "Uninstall:                 subctl uninstall"
