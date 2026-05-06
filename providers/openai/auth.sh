#!/usr/bin/env bash
# providers/openai/auth.sh — OAuth flow for OpenAI Codex (ChatGPT subscription).
# Spawns `codex login` with CODEX_HOME set; user completes OAuth in browser
# and codex returns control automatically once login finishes.
#
# subctl is the control plane for OAuth-via-subscription, not API-key auth.
# `auth.json` with auth_mode != "chatgpt" is treated as the wrong surface and
# reported back to the user with a re-do path.

[[ -n "${_SUBCTL_OPENAI_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_OPENAI_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Codex-specific status. Returns: ready | empty | wrong-mode | missing.
# Distinguishes the chatgpt-subscription OAuth mode from API-key auth, which
# the cross-provider subctl_auth_status doesn't differentiate.
_provider_openai_auth_mode_check() {
  local cfg_dir="$1"
  [[ -d "$cfg_dir" ]] || { echo missing; return; }
  local auth_file="$cfg_dir/auth.json"
  [[ -f "$auth_file" ]] || { echo empty; return; }
  local mode
  mode=$(jq -r '.auth_mode // empty' "$auth_file" 2>/dev/null)
  case "$mode" in
    chatgpt) echo ready ;;
    "")      echo empty ;;
    *)       echo wrong-mode ;;
  esac
}

# Implements the provider interface: provider_auth <alias> <config_dir> <email>
provider_openai_auth() {
  local alias="$1" cfg_dir="$2" email="$3"

  if ! subctl_have codex; then
    subctl_die "codex binary not on PATH — install Codex CLI first: https://github.com/openai/codex"
  fi
  subctl_require jq "install: brew install jq" || return 1

  mkdir -p "$cfg_dir"
  local before_status
  before_status=$(_provider_openai_auth_mode_check "$cfg_dir")

  if [[ "$before_status" == "ready" ]]; then
    subctl_ok "$alias is already authenticated ($cfg_dir)"
    printf "  email expected: %s\n" "$email"
    printf "  to re-auth, run: CODEX_HOME=%s codex logout && subctl auth openai %s\n" "$cfg_dir" "$alias"
    return 0
  fi

  if [[ "$before_status" == "wrong-mode" ]]; then
    subctl_warn "$alias has auth.json but auth_mode is not 'chatgpt' (looks like API-key auth)"
    subctl_warn "  subctl tracks OAuth-via-subscription accounts, not API keys."
    subctl_warn "  to re-do as ChatGPT OAuth: rm $cfg_dir/auth.json && subctl auth openai $alias"
    return 1
  fi

  echo
  printf "${C_CYN}━━━ %s ━━━${C_RST}\n" "$alias"
  printf "  Email expected: ${C_GRN}%s${C_RST}\n" "$email"
  printf "  Config dir:     %s\n" "$cfg_dir"
  echo
  echo "  Codex will open a browser for OAuth. Sign in with the ChatGPT plan account that"
  echo "  matches the email above. Codex returns control automatically once login completes."
  echo
  read -r -p "  Press Enter to launch (Ctrl-C to skip): " _

  CODEX_HOME="$cfg_dir" command codex login || true

  local after_status
  after_status=$(_provider_openai_auth_mode_check "$cfg_dir")
  case "$after_status" in
    ready)
      subctl_ok "$alias logged in (ChatGPT OAuth)"
      return 0
      ;;
    wrong-mode)
      subctl_warn "$alias finished login but auth_mode != 'chatgpt' — looks like an API key was provided instead of OAuth"
      subctl_warn "  subctl tracks subscriptions, not API keys."
      subctl_warn "  to re-do: rm $cfg_dir/auth.json && subctl auth openai $alias"
      return 1
      ;;
    *)
      subctl_warn "$alias may not have completed login (no auth.json detected at $cfg_dir/auth.json)"
      subctl_warn "  re-run: subctl auth openai $alias"
      return 1
      ;;
  esac
}

# Walk every openai account and auth those that need it.
provider_openai_auth_all() {
  local count=0
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "openai" ]] && continue
    provider_openai_auth "$alias" "$cfg_dir" "$email"
    count=$((count + 1))
  done < <(subctl_list_accounts)
  if [[ $count -eq 0 ]]; then
    subctl_warn "no openai accounts in $SUBCTL_ACCOUNTS_CONF — add one with: subctl accounts add openai <alias>"
  fi
}
