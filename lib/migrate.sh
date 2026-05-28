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

# NOTE: as of v0.2.0, the claude-teams shim is a first-class deliverable
# at bin/claude-teams in the repo. install.sh symlinks it into the right
# place automatically. This function is kept as a no-op for legacy callers.
subctl_migrate_claude_teams_shim() {
  subctl_info "claude-teams shim is now installed via install.sh step 3 (no-op here)"
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

    # v3 subctl dispatcher. v4 (subctl-chat-tui) now owns the bare `subctl`
    # name on PATH and does NOT dispatch v3 verbs like `config show`/`accounts`,
    # so the helper functions below must resolve the v3 binary explicitly —
    # same reason the `claude-teams` shim calls its sibling directly. The path
    # is baked at generation time; `command subctl` is only the last resort if
    # the v3 install has moved (in which case there is no v3 to find anyway).
    echo "# v3 subctl dispatcher — v4 owns the bare \`subctl\` name on PATH."
    echo "_SUBCTL_V3=\"$SUBCTL_REPO_ROOT/bin/subctl\""
    cat <<'RESOLVER'
_subctl_v3() {
  if [[ -x "$_SUBCTL_V3" ]]; then "$_SUBCTL_V3" "$@"; return $?; fi
  if [[ -x "$HOME/bin/subctl" ]]; then "$HOME/bin/subctl" "$@"; return $?; fi
  command subctl "$@"
}
RESOLVER
    cat <<'FNS'

# ── helpers ──────────────────────────────────────────────────────────────────
claude-whoami() {
  if [[ -z "${CLAUDE_CONFIG_DIR:-}" ]]; then
    echo "default ($HOME/.claude)"
  else
    # Resolve to alias when possible
    local alias
    alias=$(_subctl_v3 config show 2>/dev/null | awk -F'|' -v c="$CLAUDE_CONFIG_DIR" '
      !/^#/ && NF >= 4 {
        d=$4; gsub(/[ \t]/, "", d)
        gsub("~", ENVIRON["HOME"], d)
        if (d == c) { a=$1; gsub(/[ \t]/, "", a); print a; exit }
      }')
    if [[ -n "$alias" ]]; then
      echo "$alias  ($CLAUDE_CONFIG_DIR)"
    else
      echo "custom  ($CLAUDE_CONFIG_DIR)"
    fi
  fi
}

claude-accounts() { _subctl_v3 accounts; }

# claude-use <alias> — switch the current shell's CLAUDE_CONFIG_DIR in place.
# Affects every subsequent `claude` invocation in this shell. Existing tmux
# sessions/processes are NOT affected (their env is locked at launch time).
#
# Usage:
#   claude-use jason          # short form
#   claude-use claude-jason   # full alias
#   claude-use                # show current + list options
#   claude-use default        # back to ~/.claude (unset)
claude-use() {
  local target="$1"
  if [[ -z "$target" ]]; then
    echo "Current: $(claude-whoami)"
    echo
    echo "Available accounts:"
    _subctl_v3 config show 2>/dev/null | awk -F'|' '
      !/^#/ && NF >= 4 {
        a=$1; e=$3; d=$4
        gsub(/^[ \t]+|[ \t]+$/, "", a)
        gsub(/^[ \t]+|[ \t]+$/, "", e)
        gsub(/^[ \t]+|[ \t]+$/, "", d)
        printf "  %-20s %s\n", a, e
      }'
    echo
    echo "Switch with: claude-use <alias>"
    echo "Reset with:  claude-use default"
    return 0
  fi

  if [[ "$target" == "default" ]]; then
    unset CLAUDE_CONFIG_DIR
    echo "→ default ($HOME/.claude)"
    return 0
  fi

  # Resolve alias (allow bare "jason" or full "claude-jason")
  local cfg_dir
  cfg_dir=$(_subctl_v3 config show 2>/dev/null | awk -F'|' -v t="$target" '
    !/^#/ && NF >= 4 {
      a=$1; gsub(/[ \t]/, "", a)
      d=$4; gsub(/[ \t]/, "", d)
      gsub("~", ENVIRON["HOME"], d)
      if (a == t || a == "claude-" t) { print d; exit }
    }')

  if [[ -z "$cfg_dir" ]]; then
    echo "Unknown account: $target"
    echo "Try: claude-use   (no args, lists available)"
    return 1
  fi

  if [[ ! -d "$cfg_dir" ]]; then
    echo "Config dir doesn't exist: $cfg_dir"
    echo "Authenticate first: subctl auth claude $target"
    return 1
  fi

  export CLAUDE_CONFIG_DIR="$cfg_dir"
  echo "→ $target  ($CLAUDE_CONFIG_DIR)"
}

# safety net: bare `claude` (interactive REPL) reminds you to pick an account.
# Subcommands and non-interactive flags pass through unguarded — they don't
# touch credentials beyond what they always have, and blocking them breaks
# routine maintenance like `claude update`, `claude doctor`, `claude --version`.
claude() {
  # Pass-through commands/flags. Interactive REPL is the ONLY thing we guard.
  case "${1:-}" in
    update|doctor|migrate-installer|setup-token|mcp|config|ultrareview|""|"") ;;
  esac
  if [[ $# -gt 0 ]]; then
    case "$1" in
      update|doctor|migrate-installer|setup-token|mcp|config|ultrareview \
      |--version|-v|--help|-h|-p|--print|--resume|--continue|-c|-r)
        command claude "$@"
        return $?
        ;;
    esac
  fi
  # Bare `claude` with no args = interactive REPL → require explicit account.
  echo "Pick an account first:"
  echo "  claude-use jason       # switch this shell"
  echo "  claude-jason           # one-off (per-command env)"
  echo
  echo "Current shell account: $(claude-whoami)"
  echo "(or run 'command claude' to bypass this guard)"
  return 1
}
FNS
  } > "$out"
  subctl_ok "generated shell aliases at $out"
}
