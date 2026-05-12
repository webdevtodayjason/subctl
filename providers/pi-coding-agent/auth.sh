#!/usr/bin/env bash
# providers/pi-coding-agent/auth.sh — OAuth flow for @mariozechner/pi-coding-agent.
#
# pi-coding-agent is a coding agent CLI (binary: `pi`) that authenticates via
# its built-in `/login` slash command. /login walks the user through OAuth for
# one of 20+ underlying model providers (Anthropic Pro, ChatGPT Pro, …).
#
# subctl is the control plane for OAuth-via-subscription, not API-key auth.
# The auth flow here mirrors providers/claude/auth.sh but launches `pi` with
# HOME shadowed so that the resulting `~/.pi/` state lands inside this
# account's isolated config dir instead of the operator's real $HOME/.pi.
#
# v2.7.0 ships pi-coding-agent UNGATED — no policy hook in this PR. The
# policy gate lands in v2.7.1+ once pi exposes a stable hook surface.

[[ -n "${_SUBCTL_PI_AUTH_LOADED:-}" ]] && return 0
_SUBCTL_PI_AUTH_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# Per-alias state root. Everything pi writes (sessions, login tokens, config)
# lands here so multiple aliases on the same machine don't clobber each other.
# This is the HOME-shadow target — pi will see this directory as its $HOME,
# meaning `~/.pi/agent/sessions/` resolves to "$pi_home/.pi/agent/sessions/".
#
# We don't try to symlink into the operator's real ~/.pi: pi-coding-agent
# does not document any PI_CONFIG_DIR env var that would let us redirect just
# the pieces we want. HOME-shadow is the smallest workaround that works today
# and is fully reversible. The proper long-term fix is an upstream PR to add
# PI_CONFIG_DIR; tracked in README.md.
_provider_pi_home_dir() {
  local alias="$1"
  printf '%s\n' "$HOME/.subctl-pi-aliases/$alias"
}

# Detect pi auth state by inspecting the per-alias HOME-shadow dir.
# Returns: ready | empty | missing
_provider_pi_auth_status() {
  local pi_home="$1"
  [[ -d "$pi_home" ]] || { echo missing; return; }
  # pi-coding-agent writes one of:
  #   ~/.pi/agent/auth.json        (token blob)
  #   ~/.pi/agent/sessions/*.jsonl (at least one session ⇒ /login completed)
  # We treat either as "ready" — sessions presence handles the case where
  # the user logged in and ran one session before subctl was invoked.
  if [[ -f "$pi_home/.pi/agent/auth.json" ]]; then
    echo ready
    return
  fi
  if [[ -d "$pi_home/.pi/agent/sessions" ]] \
     && [[ -n "$(ls -A "$pi_home/.pi/agent/sessions" 2>/dev/null)" ]]; then
    echo ready
    return
  fi
  echo empty
}

# Implements the provider interface: provider_auth <alias> <config_dir> <email>
#
# Note: cfg_dir is the accounts.conf-recorded config_dir for THIS account,
# but pi-coding-agent doesn't honor an env-var redirect today, so we ALSO
# write a HOME-shadow root and steer pi at that. The shadow root path is
# stable (derived from alias), so re-running this command is idempotent.
provider_pi_coding_agent_auth() {
  local alias="$1" cfg_dir="$2" email="$3"

  if ! subctl_have pi; then
    subctl_err "pi binary not on PATH"
    subctl_err "  install: npm install -g @mariozechner/pi-coding-agent"
    subctl_die "  see also: https://www.npmjs.com/package/@mariozechner/pi-coding-agent"
  fi

  local pi_home
  pi_home=$(_provider_pi_home_dir "$alias")
  mkdir -p "$pi_home/.pi/agent"

  # Record the shadow root inside cfg_dir so other provider scripts (signals,
  # teams) can find it without re-deriving from alias. cfg_dir is what
  # accounts.conf points at; it may be empty / unused otherwise.
  mkdir -p "$cfg_dir"
  printf '%s\n' "$pi_home" > "$cfg_dir/.subctl-pi-home"

  local before_status
  before_status=$(_provider_pi_auth_status "$pi_home")

  if [[ "$before_status" == "ready" ]]; then
    subctl_ok "$alias is already authenticated"
    printf "  email expected: %s\n" "$email"
    printf "  pi HOME shadow: %s\n" "$pi_home"
    printf "  to re-auth, delete %s/.pi and re-run.\n" "$pi_home"
    return 0
  fi

  echo
  printf "${C_CYN}━━━ %s ━━━${C_RST}\n" "$alias"
  printf "  Email expected:  ${C_GRN}%s${C_RST}\n" "$email"
  printf "  Config dir:      %s\n" "$cfg_dir"
  printf "  pi HOME shadow:  %s\n" "$pi_home"
  echo
  echo "  pi-coding-agent will launch inside its own HOME-shadow dir so OAuth"
  echo "  tokens land under $pi_home/.pi/ (not your real ~/.pi)."
  echo
  echo "  Once pi is open, type:  /login"
  echo "  Then complete the browser OAuth flow and type /exit when done."
  echo
  read -r -p "  Press Enter to launch (Ctrl-C to skip): " _

  # HOME shadow: pi reads HOME at startup to locate ~/.pi. Setting HOME to
  # the per-alias dir is what gives us isolation. PATH is preserved so pi
  # can still find git, node, etc.
  HOME="$pi_home" command pi || true

  local after_status
  after_status=$(_provider_pi_auth_status "$pi_home")
  if [[ "$after_status" == "ready" ]]; then
    subctl_ok "$alias logged in"
    return 0
  else
    subctl_warn "$alias may not have completed login (no auth.json or sessions detected)"
    subctl_warn "  re-run: subctl auth pi-coding-agent $alias"
    return 1
  fi
}

# Walk every pi-coding-agent account and auth those that need it.
provider_pi_coding_agent_auth_all() {
  local count=0
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "pi-coding-agent" ]] && continue
    provider_pi_coding_agent_auth "$alias" "$cfg_dir" "$email"
    count=$((count + 1))
  done < <(subctl_list_accounts)
  if [[ $count -eq 0 ]]; then
    subctl_warn "no pi-coding-agent accounts in $SUBCTL_ACCOUNTS_CONF — add one with: subctl accounts add pi-coding-agent <alias>"
  fi
}
