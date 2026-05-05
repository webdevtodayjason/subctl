#!/usr/bin/env bash
# providers/claude/auth.sh — OAuth flow runner for Anthropic Claude accounts.
# Spawns `claude` with CLAUDE_CONFIG_DIR set; user completes OAuth in browser
# and types /exit to return.

[[ -n "${_SUBCTL_CLAUDE_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_CLAUDE_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/settings.sh"

# Implements the provider interface: provider_auth <alias> <config_dir> <email>
provider_claude_auth() {
  local alias="$1" cfg_dir="$2" email="$3"

  if ! subctl_have claude; then
    subctl_die "claude binary not on PATH — install Claude Code first: https://claude.com/claude-code"
  fi

  mkdir -p "$cfg_dir"
  # Seed the experimental teams keys before launching claude, so the very first
  # session in this account already has Team*/SendMessage tools available.
  subctl_settings_ensure_teams "$cfg_dir"
  local before_status
  before_status=$(subctl_auth_status "$cfg_dir")

  if [[ "$before_status" == "ready" ]]; then
    subctl_ok "$alias is already authenticated ($cfg_dir)"
    printf "  email expected: %s\n" "$email"
    printf "  to re-auth, delete %s/.credentials.json and re-run.\n" "$cfg_dir"
    return 0
  fi

  echo
  printf "${C_CYN}━━━ %s ━━━${C_RST}\n" "$alias"
  printf "  Email expected: ${C_GRN}%s${C_RST}\n" "$email"
  printf "  Config dir:     %s\n" "$cfg_dir"
  echo
  echo "  A Claude Code session will start in this account's isolated config dir."
  echo "  Complete the OAuth flow in your browser, then type /exit to return here."
  echo
  read -r -p "  Press Enter to launch (Ctrl-C to skip): " _

  CLAUDE_CONFIG_DIR="$cfg_dir" command claude || true

  local after_status
  after_status=$(subctl_auth_status "$cfg_dir")
  if [[ "$after_status" == "ready" ]]; then
    subctl_ok "$alias logged in"
    return 0
  else
    subctl_warn "$alias may not have completed login (no credentials file detected)"
    subctl_warn "  re-run: subctl auth claude $alias"
    return 1
  fi
}

# Walk every claude account and auth those that need it.
provider_claude_auth_all() {
  local count=0
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "claude" ]] && continue
    provider_claude_auth "$alias" "$cfg_dir" "$email"
    count=$((count + 1))
  done < <(subctl_list_accounts)
  if [[ $count -eq 0 ]]; then
    subctl_warn "no claude accounts in $SUBCTL_ACCOUNTS_CONF — add one with: subctl accounts add claude <alias>"
  fi
}
