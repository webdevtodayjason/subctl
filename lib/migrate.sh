#!/usr/bin/env bash
# lib/migrate.sh — migration from prior installs
# (claude-dispatch-radar, claude-multi-account, /usr/local/bin/claude-teams).

[[ -n "${_SUBCTL_MIGRATE_LOADED:-}" ]] && return 0
_SUBCTL_MIGRATE_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# ── detection ────────────────────────────────────────────────────────────────
subctl_migrate_detect() {
  local found=0

  # claude-dispatch-radar: detected via the symlinks we used to install
  if [[ -L "$HOME/.claude/scripts/statusline.sh" ]]; then
    local target
    target=$(readlink "$HOME/.claude/scripts/statusline.sh")
    if [[ "$target" == *claude-dispatch-radar* ]]; then
      printf "  ${C_YLW}detected${C_RST} claude-dispatch-radar at %s\n" "$target"
      found=1
    fi
  fi
  if [[ -f "$HOME/.claude/scripts/statusline.sh" ]] && [[ ! -L "$HOME/.claude/scripts/statusline.sh" ]]; then
    if grep -q "dispatch-radar\|signals.sh" "$HOME/.claude/scripts/statusline.sh" 2>/dev/null; then
      printf "  ${C_YLW}detected${C_RST} dispatch-radar (regular file)\n"
      found=1
    fi
  fi

  # claude-multi-account: symlink to either active or archived dir
  if [[ -L "$HOME/.claude-multi-account" ]]; then
    printf "  ${C_YLW}detected${C_RST} claude-multi-account at %s\n" "$(readlink "$HOME/.claude-multi-account")"
    found=1
  fi

  # /usr/local/bin/claude-teams (the patched script)
  if [[ -f "/usr/local/bin/claude-teams" ]]; then
    if grep -q "ACCOUNT" "/usr/local/bin/claude-teams" 2>/dev/null; then
      printf "  ${C_YLW}detected${C_RST} claude-teams (with -a patch) at /usr/local/bin/claude-teams\n"
      found=1
    fi
  fi

  return $found
}

# ── import accounts.conf ─────────────────────────────────────────────────────
# If user has ~/.claude-multi-account/src/accounts.conf, copy values into
# ~/.config/subctl/accounts.conf (adding the provider column).
subctl_migrate_import_accounts() {
  subctl_ensure_config_dir
  local mca_conf=""
  if [[ -L "$HOME/.claude-multi-account" ]]; then
    mca_conf="$(readlink "$HOME/.claude-multi-account")/src/accounts.conf"
  fi
  if [[ ! -f "$mca_conf" ]]; then
    subctl_info "no claude-multi-account accounts.conf to import"
    return 0
  fi

  # If subctl's accounts.conf already has user data (not just example seed), skip.
  # Heuristic: if every non-comment alias is one of the example seed names
  # (claude-personal, claude-work, claude-overflow) AND every email is a
  # known placeholder, we treat the file as un-edited.
  local non_example_lines
  non_example_lines=$(awk -F'|' '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      a=$1; gsub(/[[:space:]]/, "", a)
      e=$3; gsub(/[[:space:]]/, "", e)
      if (a != "claude-personal" && a != "claude-work" && a != "claude-overflow") { print; next }
      if (e != "you@example.com" && e != "you@company.com" && e != "you+overflow@gmail.com") { print }
    }' "$SUBCTL_ACCOUNTS_CONF" 2>/dev/null)

  if [[ -n "$non_example_lines" ]]; then
    subctl_info "subctl accounts.conf already has user entries — skipping import (edit manually if you want to merge)"
    return 0
  fi

  subctl_info "importing accounts from $mca_conf"

  # Backup current
  cp "$SUBCTL_ACCOUNTS_CONF" "$SUBCTL_ACCOUNTS_CONF.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

  # Build new file: keep header comments from example, then translate mca format
  # mca format:    alias|email|config_dir|description
  # subctl format: alias|provider|email|config_dir|description
  {
    echo "# subctl accounts (imported $(date +%Y-%m-%d) from claude-multi-account)"
    echo "# Format: alias|provider|email|config_dir|description"
    echo ""
    while IFS='|' read -r alias email cfg_dir desc; do
      alias="${alias## }"; alias="${alias%% }"
      [[ -z "$alias" || "${alias:0:1}" == "#" ]] && continue
      email="${email## }"; email="${email%% }"
      cfg_dir="${cfg_dir## }"; cfg_dir="${cfg_dir%% }"
      desc="${desc## }"; desc="${desc%% }"
      printf "%-15s | claude  | %-32s | %-25s | %s\n" "$alias" "$email" "$cfg_dir" "$desc"
    done < "$mca_conf"
  } > "$SUBCTL_ACCOUNTS_CONF"

  chmod 600 "$SUBCTL_ACCOUNTS_CONF"
  subctl_ok "imported $(grep -cv -E '^\s*#|^\s*$' "$SUBCTL_ACCOUNTS_CONF") accounts"
}

# ── replace claude-teams shim ────────────────────────────────────────────────
# Replace /usr/local/bin/claude-teams with a thin wrapper that delegates to
# `subctl teams claude`. Backup the existing one first.
subctl_migrate_claude_teams_shim() {
  local target="/usr/local/bin/claude-teams"
  if [[ ! -f "$target" ]]; then
    subctl_info "no /usr/local/bin/claude-teams to replace"
    return 0
  fi

  if [[ ! -w "$target" ]]; then
    subctl_warn "$target not writable — skipping. Manually update if desired."
    return 0
  fi

  local backup="$HOME/code/claude-teams.pre-subctl.$(date +%Y%m%d-%H%M%S).bak"
  cp "$target" "$backup"

  cat > "$target" <<'SHIM'
#!/usr/bin/env bash
# claude-teams — thin shim that delegates to `subctl teams claude`.
# Original script archived to ~/code/claude-teams.pre-subctl.*.bak
exec subctl teams claude "$@"
SHIM
  chmod +x "$target"
  subctl_ok "replaced /usr/local/bin/claude-teams with subctl shim (backup: $backup)"
}

# ── update zshrc managed block ──────────────────────────────────────────────
# Replace any old claude-multi-account managed block with one pointing at
# the subctl-generated alias file.
subctl_migrate_zshrc() {
  local rc="$HOME/.zshrc"
  [[ "$SHELL" == */bash ]] && rc="$HOME/.bashrc"
  [[ ! -f "$rc" ]] && return 0

  # Backup
  cp "$rc" "$rc.bak.subctl.$(date +%Y%m%d-%H%M%S)"

  # Remove any prior block (mca or subctl)
  local tmp
  tmp=$(mktemp)
  awk '
    /# >>> claude-multi-account >>>/{skip=1}
    /# >>> subctl >>>/{skip=1}
    /# <<< claude-multi-account <<</ {skip=0; next}
    /# <<< subctl <<</ {skip=0; next}
    !skip
  ' "$rc" > "$tmp" && mv "$tmp" "$rc"

  # Append subctl block
  cat >> "$rc" <<EOF

# >>> subctl >>>
# Auto-generated by subctl. Do not edit between markers — re-run \`subctl install\` instead.
[ -f "$SUBCTL_CONFIG_DIR/shell-aliases.sh" ] && . "$SUBCTL_CONFIG_DIR/shell-aliases.sh"
# <<< subctl <<<
EOF

  subctl_ok "updated $rc managed block"
}

# ── generate shell aliases from accounts.conf ───────────────────────────────
subctl_migrate_generate_aliases() {
  subctl_ensure_config_dir
  local out="$SUBCTL_CONFIG_DIR/shell-aliases.sh"
  {
    echo "# Auto-generated by subctl from $SUBCTL_ACCOUNTS_CONF"
    echo "# Re-run \`subctl install\` to regenerate."
    echo ""
    while IFS=$'\t' read -r alias provider email cfg_dir desc; do
      [[ "$provider" == "claude" ]] || continue
      echo "alias ${alias}='CLAUDE_CONFIG_DIR=\"$cfg_dir\" command claude'"
    done < <(subctl_list_accounts)
    cat <<'FNS'

# helpers
claude-whoami() {
  if [[ -z "${CLAUDE_CONFIG_DIR:-}" ]]; then
    echo "default ($HOME/.claude)"
  else
    echo "$CLAUDE_CONFIG_DIR"
  fi
}
claude-accounts() { subctl accounts; }

# safety net: bare `claude` reminds you to pick an account
claude() {
  echo "Use one of your aliases (subctl accounts) or run 'command claude' to bypass."
  echo "Current shell account: $(claude-whoami)"
  return 1
}
FNS
  } > "$out"
  subctl_ok "generated shell aliases at $out"
}
