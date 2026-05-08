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

# ── 3. symlink subctl + convenience shims into /usr/local/bin (if writable) ─
subctl_info "linking subctl CLI + shorthand shims"

SHIMS=(subctl claude-teams claude-radar claude-dash claude-deck claude-kill claude-resume)
SYS_BIN="/usr/local/bin"
USER_BIN="$HOME/bin"

if [[ -w "$SYS_BIN" ]]; then
  TARGET_BIN_DIR="$SYS_BIN"
else
  run mkdir -p "$USER_BIN"
  TARGET_BIN_DIR="$USER_BIN"
  subctl_warn "$SYS_BIN not writable — linking into $USER_BIN"
  subctl_warn "  add to PATH: export PATH=\"\$HOME/bin:\$PATH\""
fi

for shim in "${SHIMS[@]}"; do
  src="$REPO_ROOT/bin/$shim"
  dst="$TARGET_BIN_DIR/$shim"
  # If existing target is a regular file (e.g. user's old claude-teams),
  # back it up before replacing.
  if [[ -f "$dst" && ! -L "$dst" ]]; then
    backup="$HOME/code/${shim}.pre-subctl.$(date +%Y%m%d-%H%M%S).bak"
    run cp "$dst" "$backup"
    subctl_info "backed up existing $dst → $backup"
  fi
  run ln -sfn "$src" "$dst"
  subctl_ok "$shim → $dst"
done

# Convenience: also create ~/.subctl pointing at repo root
run ln -sfn "$REPO_ROOT" "$HOME/.subctl"

# ── 4. install Claude provider into ~/.claude ───────────────────────────────
subctl_info "wiring Claude statusline + hook + slash command"
. "$REPO_ROOT/lib/settings.sh"
$DRY_RUN || subctl_settings_install_claude

# ── 4a. apply autonomy patches (defaultMode + CLAUDE_AUTONOMY) ──────────────
# Runs AFTER step 4 because settings.sh is sourced there. Idempotent — re-run
# any time to re-apply. Each settings.json gets a .bak before merge.
subctl_info "applying autonomy patches to settings.json (per-account)"
$DRY_RUN || subctl_settings_apply_autonomy_all

# ── 4b. install autonomy skill ──────────────────────────────────────────────
subctl_info "linking autonomy skill into ~/.claude/skills/"
$DRY_RUN || subctl_settings_install_autonomy_skill

# ── 5. generate shell aliases + update zshrc ────────────────────────────────
if ! $NO_SHELL; then
  subctl_info "shell aliases"
  . "$REPO_ROOT/lib/migrate.sh"
  $DRY_RUN || subctl_migrate_generate_aliases
  $DRY_RUN || subctl_migrate_zshrc
fi

# ── 6. (claude-teams shim is now installed in step 3 — first-class deliverable)

# ── 6b. build the Go deck TUI binary (v0.3+ feature, restored in v0.4.1) ─────
if [[ -d "$REPO_ROOT/deck" ]]; then
  if command -v go >/dev/null 2>&1; then
    subctl_info "building subctl-deck (Go TUI session manager)"
    if $DRY_RUN; then
      echo "[dry-run] cd $REPO_ROOT/deck && go build -o $REPO_ROOT/bin/subctl-deck ."
    else
      (cd "$REPO_ROOT/deck" && go build -o "$REPO_ROOT/bin/subctl-deck" . 2>&1) \
        && subctl_ok "built bin/subctl-deck" \
        || subctl_warn "go build failed — deck unavailable. Check: cd $REPO_ROOT/deck && go build ./..."
    fi
  else
    subctl_warn "go not installed — deck binary skipped. Install: brew install go && re-run subctl install"
  fi
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

# Detect first-run: accounts.conf is missing OR is the unmodified example seed.
_first_run=true
if [[ -f "$SUBCTL_ACCOUNTS_CONF" ]]; then
  # Has any non-example, non-comment line?
  if awk -F'|' '
      /^[[:space:]]*#/ { next }
      /^[[:space:]]*$/ { next }
      {
        a=$1; gsub(/[[:space:]]/, "", a)
        if (a != "claude-personal" && a != "claude-work" && a != "claude-overflow") { found=1 }
      }
      END { exit !found }
    ' "$SUBCTL_ACCOUNTS_CONF" 2>/dev/null; then
    _first_run=false
  fi
fi

if $_first_run; then
  echo "${C_CYN}First time?${C_RST} Run the setup wizard to add accounts + authenticate:"
  echo "  ${C_BLD}subctl setup --wizard${C_RST}"
  echo
  echo "Or pick a single stage from the menu:"
  echo "  ${C_BLD}subctl setup${C_RST}"
else
  echo "Next steps:"
  echo "  1. Reload your shell:    source ~/.zshrc"
  echo "  2. Run TUI:              subctl"
  echo "  3. Health check:         subctl doctor"
  echo "  4. Reconfigure anytime:  subctl setup"
fi
echo
echo "Uninstall:                 subctl uninstall"
