#!/usr/bin/env bash
# providers/xai-oauth/auth.sh — first-class xAI Grok OAuth (SuperGrok Subscription).
#
# Mirrors providers/openai-codex/auth.sh, but uses xAI's PKCE-loopback flow
# rather than OpenAI's device-code flow. No external `grok` CLI dependency;
# subctl mints tokens directly against https://auth.x.ai using the public
# Grok-CLI OAuth client id (b1a00492-073a-47ea-816f-4c329264a828) that
# Hermes already shipped.
#
# Routing: bin/subctl `auth xai-oauth <alias>` dispatches here. We look up
# the alias's config_dir + email in accounts.conf and hand them to
# components/master/cli/xai-oauth-login.ts, which runs the loopback flow,
# prints the authorize URL, waits for the local callback, exchanges the
# code, and writes <config_dir>/auth.json (mode 0o600).

[[ -n "${_SUBCTL_XAI_OAUTH_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_XAI_OAUTH_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

provider_xai_oauth_auth() {
  local alias="$1"
  local cfg_dir="$2"
  local email="${3:-}"

  if [[ -z "$alias" || -z "$cfg_dir" ]]; then
    subctl_die "usage: provider_xai_oauth_auth <alias> <config_dir> [<email>]"
  fi

  if ! command -v bun >/dev/null 2>&1; then
    subctl_die "bun not found in PATH — install Bun first (https://bun.sh)"
  fi

  local repo_root cli_script
  repo_root="$SUBCTL_REPO_ROOT"
  cli_script="$repo_root/components/master/cli/xai-oauth-login.ts"
  if [[ ! -f "$cli_script" ]]; then
    subctl_die "xai-oauth-login.ts not found at $cli_script"
  fi

  subctl_info "xai-oauth: starting PKCE-loopback flow for $alias"
  subctl_info "  config_dir: $cfg_dir"
  [[ -n "$email" ]] && subctl_info "  email:      $email"
  echo ""

  # Pass through stdin/stdout/stderr so the operator sees the
  # authorize URL and can Ctrl-C to cancel before approving.
  bun run "$cli_script" "$alias" "$cfg_dir" "$email"
  local rc=$?

  if [[ $rc -eq 0 ]]; then
    subctl_info "xai-oauth: $alias is now authenticated."
    subctl_info "  test: subctl status (look for xai-oauth/$alias)"
  elif [[ $rc -eq 3 ]]; then
    subctl_warn "xai-oauth: $alias auth cancelled"
  else
    subctl_die "xai-oauth: $alias auth failed (exit $rc)"
  fi

  return $rc
}

# Walk every accounts.conf row whose provider is `xai-oauth` and run the
# loopback flow for each that doesn't yet have a valid auth.json. Mirror
# of provider_openai_codex_auth_all.
provider_xai_oauth_auth_all() {
  if ! command -v jq >/dev/null 2>&1; then
    subctl_warn "jq not found — skipping xai-oauth auth_all"
    return 0
  fi
  local conf
  conf="$(subctl_config_dir)/accounts.conf"
  if [[ ! -f "$conf" ]]; then
    subctl_warn "no accounts.conf at $conf — skipping xai-oauth auth_all"
    return 0
  fi

  local line
  while IFS='|' read -r alias provider email cfg_dir description; do
    alias="${alias// /}"
    provider="${provider// /}"
    email="${email# }"; email="${email% }"
    cfg_dir="${cfg_dir# }"; cfg_dir="${cfg_dir% }"
    [[ -z "$alias" || "$alias" =~ ^# ]] && continue
    [[ "$provider" != "xai-oauth" ]] && continue

    # Expand ~ in config_dir.
    case "$cfg_dir" in
      "~") cfg_dir="$HOME" ;;
      "~/"*) cfg_dir="$HOME/${cfg_dir#~/}" ;;
    esac

    local auth_path="$cfg_dir/auth.json"
    if [[ -f "$auth_path" ]] && [[ $(stat -f%z "$auth_path" 2>/dev/null || stat -c%s "$auth_path" 2>/dev/null) -gt 50 ]]; then
      subctl_info "xai-oauth: $alias already has auth.json — skipping (delete it to re-auth)"
      continue
    fi

    provider_xai_oauth_auth "$alias" "$cfg_dir" "$email"
  done < "$conf"
}
