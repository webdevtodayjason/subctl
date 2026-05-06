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

# Classify the plan tier of an authenticated Codex account by examining the
# rate_limits.primary.window_minutes field on any token_count event in this
# account's transcripts. Codex hands us this number directly (no inference
# needed) — Pro plans show a 300-minute (5 hour) primary window. Other plan
# tiers have different windows or lack rate_limits entirely.
#
# Outputs one of:
#   pro                 — 300min primary window observed (ChatGPT Pro)
#   non-pro:<n>min      — primary window present but != 300; <n> is the value
#   unverified          — no transcripts with rate_limits payload found yet
#
# Plan tier becomes verifiable once the user has run codex at least once
# under this CODEX_HOME — it cannot be determined from the JWT alone.
_provider_openai_classify_plan() {
  local cfg_dir="$1"
  local f window
  # `find` is robust where glob expansion isn't: it silently returns nothing
  # when starting points don't exist, vs zsh's "no matches found" error on
  # unmatched globs. Order doesn't matter for classification: any transcript
  # with rate_limits returns the same answer because window_minutes is stable
  # per plan tier.
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    window=$(jq -rs '
      [.[] | select(.type=="event_msg" and .payload.type=="token_count" and (.payload.rate_limits != null))]
      | last | .payload.rate_limits.primary.window_minutes // empty
    ' "$f" 2>/dev/null)
    [[ -n "$window" ]] && break
  done < <(find "$cfg_dir/sessions" "$cfg_dir/archived_sessions" \
                -maxdepth 1 -name '*.jsonl' -type f 2>/dev/null)
  if [[ -z "$window" ]]; then
    echo unverified
  elif [[ "$window" == "300" ]]; then
    echo pro
  else
    echo "non-pro:${window}min"
  fi
}

# Codex-specific status. Returns: ready | empty | wrong-mode | missing.
# Distinguishes the chatgpt-subscription OAuth mode from API-key auth, which
# the cross-provider subctl_auth_status doesn't differentiate.
#
# We detect by what's actually populated, not by the auth_mode field: Codex's
# simplified login flow (the current default) does NOT write auth_mode at
# all, while older flows did. OAuth-token presence is the durable signal
# across both schemas.
_provider_openai_auth_mode_check() {
  local cfg_dir="$1"
  [[ -d "$cfg_dir" ]] || { echo missing; return; }
  local auth_file="$cfg_dir/auth.json"
  [[ -f "$auth_file" ]] || { echo empty; return; }
  if jq -e '(.tokens.id_token // .tokens.access_token // "") | length > 0' \
       "$auth_file" >/dev/null 2>&1; then
    echo ready
  elif jq -e '(.OPENAI_API_KEY // "") | length > 0' \
            "$auth_file" >/dev/null 2>&1; then
    echo wrong-mode
  else
    echo empty
  fi
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
    # Re-running auth on a ready account is also how you verify plan tier
    # after the first codex session — re-classify so that flow works.
    local plan
    plan=$(_provider_openai_classify_plan "$cfg_dir")
    case "$plan" in
      pro)
        subctl_ok "  plan tier: ChatGPT Pro (5h primary window detected)"
        ;;
      non-pro:*)
        subctl_warn "  plan tier looks NON-Pro: primary window=${plan#non-pro:}"
        subctl_warn "  if this should be a Pro account, re-auth picked the wrong identity:"
        subctl_warn "  rm $cfg_dir/auth.json && subctl auth openai $alias"
        ;;
      unverified)
        subctl_info "  plan tier unverified — run codex once in this account, then re-run this command."
        ;;
    esac
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
      local plan
      plan=$(_provider_openai_classify_plan "$cfg_dir")
      case "$plan" in
        pro)
          subctl_ok "  plan tier: ChatGPT Pro (5h primary window detected)"
          ;;
        non-pro:*)
          subctl_warn "  plan tier looks NON-Pro: primary window=${plan#non-pro:}"
          subctl_warn "  subctl tracks paid Pro subscriptions; if this is a Plus or Free account,"
          subctl_warn "  remove with: subctl accounts remove $alias --purge"
          ;;
        unverified)
          subctl_info "  plan tier unverified — run codex once in this account to populate rate_limits data,"
          subctl_info "  then re-run 'subctl auth openai $alias' to classify."
          ;;
      esac
      return 0
      ;;
    wrong-mode)
      subctl_warn "$alias has auth.json but no OAuth tokens — looks like an API key was provided instead of completing OAuth"
      subctl_warn "  subctl tracks subscriptions, not API keys."
      subctl_warn "  to re-do: rm $cfg_dir/auth.json && subctl auth openai $alias"
      return 1
      ;;
    empty)
      subctl_warn "$alias has auth.json but no OAuth tokens — login may not have completed"
      subctl_warn "  re-run: subctl auth openai $alias"
      return 1
      ;;
    *)
      subctl_warn "$alias has no auth.json at $cfg_dir/auth.json"
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
