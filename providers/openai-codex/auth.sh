#!/usr/bin/env bash
# providers/openai-codex/auth.sh — first-class OpenAI Codex OAuth.
#
# Replaces the `codex login` shell-out in providers/openai/auth.sh with a
# self-contained device-code flow living in TypeScript. The operator no
# longer needs the official `codex` CLI installed; subctl mints tokens
# directly against https://auth.openai.com using OpenAI's public Codex
# CLI OAuth client id.
#
# Routing: bin/subctl `auth openai-codex <alias>` dispatches here. We
# look up the alias's config_dir + email in accounts.conf and hand them
# to components/master/cli/codex-login.ts, which runs the device-code
# flow and writes <config_dir>/auth.json.

[[ -n "${_SUBCTL_OPENAI_CODEX_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_OPENAI_CODEX_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

provider_openai_codex_auth() {
  local alias="$1"
  local cfg_dir="$2"
  local email="${3:-}"

  if [[ -z "$alias" || -z "$cfg_dir" ]]; then
    subctl_die "usage: provider_openai_codex_auth <alias> <config_dir> [<email>]"
  fi

  if ! command -v bun >/dev/null 2>&1; then
    subctl_die "bun not found in PATH — install Bun first (https://bun.sh)"
  fi

  local repo_root cli_script
  repo_root="$SUBCTL_REPO_ROOT"
  cli_script="$repo_root/components/master/cli/codex-login.ts"
  if [[ ! -f "$cli_script" ]]; then
    subctl_die "codex-login.ts not found at $cli_script"
  fi

  subctl_info "openai-codex: starting OAuth device-code flow for $alias"
  subctl_info "  config_dir: $cfg_dir"
  [[ -n "$email" ]] && subctl_info "  email:      $email"
  echo ""

  # Pass through stdin/stdout/stderr so the operator sees the
  # verification URL + user code and can Ctrl-C to cancel.
  bun run "$cli_script" "$alias" "$cfg_dir" "$email"
  local rc=$?

  if [[ $rc -eq 0 ]]; then
    subctl_info "openai-codex: $alias is now authenticated."
    subctl_info "  test: subctl status (look for openai-codex/$alias)"
  elif [[ $rc -eq 3 ]]; then
    subctl_warn "openai-codex: $alias auth cancelled"
  else
    subctl_die "openai-codex: $alias auth failed (exit $rc)"
  fi

  return $rc
}

# Walk every accounts.conf row whose provider is `openai-codex` and run
# the device-code flow for each that doesn't yet have a valid auth.json.
# Mirror of provider_openai_auth_all (which shells out to `codex login`).
provider_openai_codex_auth_all() {
  if ! command -v jq >/dev/null 2>&1; then
    subctl_warn "jq not found — skipping openai-codex auth_all"
    return 0
  fi
  local conf
  conf="$(subctl_config_dir)/accounts.conf"
  if [[ ! -f "$conf" ]]; then
    subctl_warn "no accounts.conf at $conf — skipping openai-codex auth_all"
    return 0
  fi

  local line
  while IFS='|' read -r alias provider email cfg_dir description; do
    alias="${alias// /}"
    provider="${provider// /}"
    email="${email# }"; email="${email% }"
    cfg_dir="${cfg_dir# }"; cfg_dir="${cfg_dir% }"
    [[ -z "$alias" || "$alias" =~ ^# ]] && continue
    [[ "$provider" != "openai-codex" ]] && continue

    # Expand ~ in config_dir (subctl_account_field does this, but we're
    # parsing inline here for the loop).
    case "$cfg_dir" in
      "~") cfg_dir="$HOME" ;;
      "~/"*) cfg_dir="$HOME/${cfg_dir#~/}" ;;
    esac

    local auth_path="$cfg_dir/auth.json"
    if [[ -f "$auth_path" ]] && [[ $(stat -f%z "$auth_path" 2>/dev/null || stat -c%s "$auth_path" 2>/dev/null) -gt 50 ]]; then
      subctl_info "openai-codex: $alias already has auth.json — skipping (delete it to re-auth)"
      continue
    fi

    provider_openai_codex_auth "$alias" "$cfg_dir" "$email"
  done < "$conf"
}
