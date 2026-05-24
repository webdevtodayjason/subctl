#!/usr/bin/env bash
# providers/deepseek/auth.sh — API-key flow for Hmbown/CodeWhale (formerly
# DeepSeek-TUI). Binary: `codewhale`. v3.0.0-rc1 ships UNGATED, mirroring
# the pi-coding-agent v2.7.0 rollout stance.
#
# Why no keychain wrapper? CodeWhale ships first-class credential management
# (`codewhale auth set/get/list/clear/status`). It stores keys in a layered
# `config -> file-based secret store -> env` lookup, all rooted under $HOME.
# Combining HOME-shadowing with codewhale's own auth surface gives us
# per-alias isolation without writing a keychain shim that would have to
# stay in sync with codewhale's storage format. The auth.sh contract here
# is therefore: shadow HOME, launch `codewhale auth set --provider deepseek`,
# let codewhale do the secret handling.
#
# Tradeoff vs. an out-of-band keychain: the key lands at
# $pi_home/.deepseek/config.toml (mode 0600, codewhale-managed). That file
# is readable by the operator user only, never written to accounts.conf,
# never echoed in logs. macOS Keychain would add an extra layer but at the
# cost of a custom shim — defer to v3.x if operator demands it.

[[ -n "${_SUBCTL_DEEPSEEK_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_DEEPSEEK_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Per-alias HOME-shadow root. Codewhale reads HOME to locate
# ~/.deepseek/config.toml, ~/.deepseek/secrets/, ~/.deepseek/sessions/,
# ~/.deepseek/audit.log, and friends. Re-pointing HOME at a per-alias
# subdir gives us full isolation — config, sessions, MCP cache, audit log
# all stay separated across aliases.
_provider_deepseek_home_dir() {
  local alias="$1"
  printf '%s\n' "$HOME/.subctl-deepseek-aliases/$alias"
}

# Detect codewhale auth state by inspecting the per-alias shadow dir.
# Returns: ready | empty | missing
_provider_deepseek_auth_status() {
  local dsk_home="$1"
  [[ -d "$dsk_home" ]] || { echo missing; return; }
  # codewhale writes keys to one of two paths (per `codewhale auth status`):
  #   ~/.deepseek/config.toml         (api_key = sk-…)
  #   ~/.deepseek/secrets/<provider>  (file-based secret store)
  # Either presence ⇒ "ready". The config.toml check is grep-based because
  # codewhale also writes non-secret config there (provider, default model,
  # project trust levels). An empty stub ≠ ready.
  if [[ -f "$dsk_home/.deepseek/config.toml" ]] \
     && grep -qE '^[[:space:]]*api_key[[:space:]]*=' "$dsk_home/.deepseek/config.toml" 2>/dev/null; then
    echo ready
    return
  fi
  if [[ -d "$dsk_home/.deepseek/secrets" ]] \
     && [[ -n "$(ls -A "$dsk_home/.deepseek/secrets" 2>/dev/null)" ]]; then
    echo ready
    return
  fi
  echo empty
}

# Implements the provider interface: provider_auth <alias> <config_dir> <email>
#
# cfg_dir is the accounts.conf-recorded config_dir for this account. We
# write a HOME-shadow pin file there so signals.sh + teams.sh can find the
# shadow path without re-deriving from alias. The shadow root itself is
# stable (derived from alias), so re-running this command is idempotent.
provider_deepseek_auth() {
  local alias="$1" cfg_dir="$2" email="$3"

  if ! subctl_have codewhale; then
    subctl_err "codewhale binary not on PATH"
    subctl_err "  install: npm install -g codewhale"
    subctl_err "  or:      cargo install codewhale-cli --locked"
    subctl_err "  or:      brew install deepseek-tui   # Homebrew formula kept the old name"
    subctl_die "  see also: https://github.com/Hmbown/CodeWhale"
  fi

  local dsk_home
  dsk_home=$(_provider_deepseek_home_dir "$alias")
  mkdir -p "$dsk_home/.deepseek"

  # Record the shadow root in cfg_dir so signals/teams can find it without
  # re-deriving from alias. Mirrors providers/pi-coding-agent/auth.sh:81.
  mkdir -p "$cfg_dir"
  printf '%s\n' "$dsk_home" > "$cfg_dir/.subctl-deepseek-home"

  local before_status
  before_status=$(_provider_deepseek_auth_status "$dsk_home")

  if [[ "$before_status" == "ready" ]]; then
    subctl_ok "$alias is already authenticated"
    printf "  email expected:        %s\n" "$email"
    printf "  codewhale HOME shadow: %s\n" "$dsk_home"
    printf "  to re-auth, delete %s/.deepseek and re-run.\n" "$dsk_home"
    return 0
  fi

  echo
  printf "${C_CYN}━━━ %s ━━━${C_RST}\n" "$alias"
  printf "  Email expected:        ${C_GRN}%s${C_RST}\n" "$email"
  printf "  Config dir:            %s\n" "$cfg_dir"
  printf "  codewhale HOME shadow: %s\n" "$dsk_home"
  echo
  echo "  CodeWhale will be launched inside its own HOME-shadow dir so the"
  echo "  API key lands under $dsk_home/.deepseek/ (not your real ~/.deepseek)."
  echo
  echo "  You will be prompted to paste a DeepSeek API key. CodeWhale does"
  echo "  NOT echo the key. Get one from: https://platform.deepseek.com/"
  echo
  read -r -p "  Press Enter to launch (Ctrl-C to skip): " _

  # HOME shadow: codewhale reads HOME at startup to locate ~/.deepseek/.
  # PATH is preserved so codewhale's own tooling (git, etc.) still works.
  # `auth set --provider deepseek` reads the key from stdin (no echo) and
  # writes it into $dsk_home/.deepseek/config.toml. Falling back to `|| true`
  # mirrors pi's auth.sh — we don't want a non-zero exit from codewhale
  # itself to short-circuit the status check below.
  HOME="$dsk_home" command codewhale auth set --provider deepseek || true

  local after_status
  after_status=$(_provider_deepseek_auth_status "$dsk_home")
  if [[ "$after_status" == "ready" ]]; then
    subctl_ok "$alias logged in (key stored in $dsk_home/.deepseek/config.toml)"
    return 0
  else
    subctl_warn "$alias may not have completed auth (no api_key found in config.toml or secrets/)"
    subctl_warn "  re-run: subctl auth deepseek $alias"
    return 1
  fi
}

# Walk every deepseek account and auth those that need it.
provider_deepseek_auth_all() {
  local count=0
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "deepseek" ]] && continue
    provider_deepseek_auth "$alias" "$cfg_dir" "$email"
    count=$((count + 1))
  done < <(subctl_list_accounts)
  if [[ $count -eq 0 ]]; then
    subctl_warn "no deepseek accounts in $SUBCTL_ACCOUNTS_CONF — add one with: subctl accounts add deepseek <alias> <email>"
  fi
}
