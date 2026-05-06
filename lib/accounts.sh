#!/usr/bin/env bash
# lib/accounts.sh — accounts.conf management (add, remove, edit, status table).

[[ -n "${_SUBCTL_ACCOUNTS_LOADED:-}" ]] && return 0
_SUBCTL_ACCOUNTS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# ── status table ─────────────────────────────────────────────────────────────
subctl_accounts_status_table() {
  subctl_ensure_config_dir
  printf "%-20s %-9s %-12s %-32s %s\n" "ALIAS" "PROVIDER" "STATUS" "EMAIL" "CONFIG DIR"
  printf "%-20s %-9s %-12s %-32s %s\n" \
    "$(printf -- '─%.0s' {1..18})" \
    "$(printf -- '─%.0s' {1..7})" \
    "$(printf -- '─%.0s' {1..10})" \
    "$(printf -- '─%.0s' {1..30})" \
    "$(printf -- '─%.0s' {1..30})"
  subctl_list_accounts | while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    local status status_colored
    status=$(subctl_auth_status "$cfg_dir")
    case "$status" in
      ready)   status_colored="${C_GRN}ready${C_RST}" ;;
      empty)   status_colored="${C_YLW}empty${C_RST}" ;;
      missing) status_colored="${C_DIM}not setup${C_RST}" ;;
      *)       status_colored="${C_DIM}$status${C_RST}" ;;
    esac
    printf "%-20s %-9s %-21s %-32s %s\n" "$alias" "$provider" "$status_colored" "$email" "$cfg_dir"
  done
}

# ── add ──────────────────────────────────────────────────────────────────────
# Usage: subctl_accounts_add <provider> <alias> <email> [config_dir] [description]
# If config_dir omitted, defaults to ~/.<provider>-<short_alias>.
subctl_accounts_add() {
  subctl_ensure_config_dir
  local provider="$1" alias="$2" email="$3" cfg_dir="${4:-}" desc="${5:-}"

  [[ -z "$provider" || -z "$alias" || -z "$email" ]] && {
    subctl_err "usage: subctl accounts add <provider> <alias> <email> [config_dir] [description]"
    return 1
  }

  case "$provider" in
    claude|gemini|openai) ;;
    *) subctl_err "unknown provider: $provider (must be claude, gemini, openai)"; return 1 ;;
  esac

  # Default config_dir. Each provider's CLI has its own natural per-user dir
  # (Claude uses ~/.claude, Codex uses ~/.codex), so the default mirrors that
  # rather than the subctl-internal provider name.
  if [[ -z "$cfg_dir" ]]; then
    local short="${alias#${provider}-}"
    case "$provider" in
      openai) cfg_dir="~/.codex-${short}" ;;   # Codex CLI's per-user dir is ~/.codex
      *)      cfg_dir="~/.${provider}-${short}" ;;
    esac
  fi

  # Default description
  [[ -z "$desc" ]] && desc="$provider account"

  # Check duplicate
  if subctl_list_accounts | awk -F'\t' -v a="$alias" '$1==a {found=1} END{exit !found}'; then
    subctl_err "alias already exists: $alias"
    return 1
  fi

  printf "%-15s | %-7s | %-32s | %-25s | %s\n" \
    "$alias" "$provider" "$email" "$cfg_dir" "$desc" >> "$SUBCTL_ACCOUNTS_CONF"
  subctl_ok "added $alias → $cfg_dir"

  # Wire statusline + Stop hook into the new account's cfg_dir so the radar
  # bar shows up the first time it's used — no re-run of `subctl install`
  # required. Only meaningful for claude (others don't have a Claude Code
  # statusline contract).
  if [[ "$provider" == "claude" ]]; then
    local expanded="${cfg_dir/#\~/$HOME}"
    . "$(dirname "${BASH_SOURCE[0]}")/settings.sh"
    subctl_settings_install_claude_dir "$expanded" || \
      subctl_warn "could not wire statusline into $expanded — re-run \`subctl install\`"
  fi
}

# ── remove ───────────────────────────────────────────────────────────────────
# Usage: subctl_accounts_remove <alias> [--purge]
# --purge also deletes the config dir (with prompt).
subctl_accounts_remove() {
  subctl_ensure_config_dir
  local alias="$1" purge=false
  [[ "${2:-}" == "--purge" ]] && purge=true

  [[ -z "$alias" ]] && { subctl_err "usage: subctl accounts remove <alias> [--purge]"; return 1; }

  local cfg_dir
  cfg_dir=$(subctl_account_field "$alias" 4)
  [[ -z "$cfg_dir" ]] && { subctl_err "alias not found: $alias"; return 1; }

  # Remove the line by alias (first field). awk-based safe rewrite.
  local tmp
  tmp=$(mktemp)
  awk -F'|' -v a="$alias" '
    /^[[:space:]]*#/ { print; next }
    /^[[:space:]]*$/ { print; next }
    {
      first=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", first)
      if (first != a) print
    }
  ' "$SUBCTL_ACCOUNTS_CONF" > "$tmp" && mv "$tmp" "$SUBCTL_ACCOUNTS_CONF"
  subctl_ok "removed $alias from accounts.conf"

  if $purge; then
    if [[ -d "$cfg_dir" ]]; then
      read -r -p "Also delete $cfg_dir? [y/N]: " confirm
      [[ "$confirm" == "y" || "$confirm" == "Y" ]] && rm -rf "$cfg_dir" \
        && subctl_ok "deleted $cfg_dir" \
        || subctl_info "kept $cfg_dir"
    fi
  fi
}

# ── edit ─────────────────────────────────────────────────────────────────────
subctl_accounts_edit() {
  subctl_ensure_config_dir
  local editor="${VISUAL:-${EDITOR:-vi}}"
  "$editor" "$SUBCTL_ACCOUNTS_CONF"
}
