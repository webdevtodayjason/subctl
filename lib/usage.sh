#!/usr/bin/env bash
# lib/usage.sh — fetch Claude Max-plan usage stats per account.
#
# Backed by Anthropic's OAuth usage endpoint, which Claude Code itself
# uses to render `/usage` (session %, weekly all-models %, weekly Sonnet,
# resets, extra-usage credit grants). One GET per account, gated by a
# short-lived disk cache.
#
#   GET https://api.anthropic.com/api/oauth/usage
#   Authorization: Bearer <accessToken from macOS Keychain>
#
# Bearer extraction is fully derived: the Keychain service name is
# `Claude Code-credentials-<sha256(cfg_dir)[0:8]>`, exactly how Claude
# Code names it when authenticating with CLAUDE_CONFIG_DIR set. Falls
# back to the unsuffixed `Claude Code-credentials` entry for the default
# ~/.claude config (legacy / pre-multi-account installs).
#
# Nothing in this file references a specific user, email, UUID, or path —
# every account has its bearer derived from its cfg_dir at call time.

[[ -n "${_SUBCTL_USAGE_LOADED:-}" ]] && return 0
_SUBCTL_USAGE_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

: "${SUBCTL_USAGE_API_BASE:=https://api.anthropic.com}"
: "${SUBCTL_USAGE_CACHE_TTL:=300}"  # 5min — matches dashboard history poller cadence; 7d/5h util doesn't move faster
: "${SUBCTL_USAGE_TIMEOUT:=8}"       # curl total timeout

# Compute the macOS Keychain service name Claude Code uses for a given
# config_dir. Mirror of how the CLI derives it: SHA-256 of the cfg_dir
# absolute path, first 8 hex chars, suffixed onto "Claude Code-credentials-".
subctl_usage_keychain_service() {
  local cfg_dir="${1:-}"
  [[ -z "$cfg_dir" ]] && { subctl_err "usage_keychain_service: cfg_dir required"; return 1; }
  cfg_dir="${cfg_dir/#\~/$HOME}"
  local hash
  hash=$(printf '%s' "$cfg_dir" | shasum -a 256 | cut -c1-8)
  printf 'Claude Code-credentials-%s' "$hash"
}

# Read the OAuth bearer for a given cfg_dir from macOS Keychain.
# Echoes the token on stdout (never logged). Returns non-zero with a
# warning to stderr when no entry is found or no accessToken inside.
#
# First read on a given keychain item triggers macOS approval dialog;
# subsequent reads from the same caller path use the user's "Always Allow"
# decision.
subctl_usage_bearer() {
  local cfg_dir="${1:-}"
  [[ -z "$cfg_dir" ]] && { subctl_err "usage_bearer: cfg_dir required"; return 1; }
  cfg_dir="${cfg_dir/#\~/$HOME}"

  if ! subctl_have security; then
    subctl_warn "macOS 'security' CLI unavailable — Keychain bearer extraction unsupported on this platform" >&2
    return 1
  fi

  local svc blob
  svc=$(subctl_usage_keychain_service "$cfg_dir")
  blob=$(security find-generic-password -w -s "$svc" 2>/dev/null || true)

  if [[ -z "$blob" && "$cfg_dir" == "$HOME/.claude" ]]; then
    # Default-config legacy entry has no hash suffix.
    blob=$(security find-generic-password -w -s "Claude Code-credentials" 2>/dev/null || true)
  fi

  if [[ -z "$blob" ]]; then
    subctl_warn "no Keychain entry for $cfg_dir (looked for: $svc) — has 'subctl auth claude <alias>' been run?" >&2
    return 1
  fi

  local token
  token=$(printf '%s' "$blob" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
  if [[ -z "$token" ]]; then
    subctl_warn "Keychain entry for $cfg_dir has no .claudeAiOauth.accessToken (re-auth?)" >&2
    return 1
  fi

  printf '%s' "$token"
}

# GET /api/oauth/usage with the bearer for cfg_dir. Caches the response in
# $SUBCTL_CONFIG_DIR/cache/usage/<hash>.json for SUBCTL_USAGE_CACHE_TTL secs.
# Echoes the JSON on stdout. Returns non-zero on failure with stderr message.
#
# Override SUBCTL_USAGE_FORCE=1 to bypass cache.
subctl_usage_fetch() {
  local cfg_dir="${1:-}"
  [[ -z "$cfg_dir" ]] && { subctl_err "usage_fetch: cfg_dir required"; return 1; }
  cfg_dir="${cfg_dir/#\~/$HOME}"

  subctl_ensure_config_dir

  local hash
  hash=$(printf '%s' "$cfg_dir" | shasum -a 256 | cut -c1-8)
  local cache_dir="$SUBCTL_CONFIG_DIR/cache/usage"
  local cache="$cache_dir/$hash.json"
  mkdir -p "$cache_dir"

  if [[ -z "${SUBCTL_USAGE_FORCE:-}" && -f "$cache" ]]; then
    local mtime now age
    mtime=$(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache" 2>/dev/null || echo 0)
    now=$(date +%s)
    age=$(( now - mtime ))
    if (( age < SUBCTL_USAGE_CACHE_TTL )); then
      cat "$cache"
      return 0
    fi
  fi

  if ! subctl_have curl; then
    subctl_warn "curl missing — usage fetch unavailable" >&2
    return 1
  fi
  if ! subctl_have jq; then
    subctl_warn "jq missing — usage fetch unavailable" >&2
    return 1
  fi

  local token
  token=$(subctl_usage_bearer "$cfg_dir") || return 1

  local tmp
  tmp=$(mktemp)
  local http_code
  http_code=$(curl -sS \
    --max-time "$SUBCTL_USAGE_TIMEOUT" \
    -o "$tmp" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "User-Agent: subctl/$SUBCTL_VERSION" \
    "$SUBCTL_USAGE_API_BASE/api/oauth/usage" 2>/dev/null) || http_code=000

  if [[ "$http_code" != "200" ]]; then
    local body_preview
    body_preview=$(head -c 200 "$tmp" 2>/dev/null)
    rm -f "$tmp"
    subctl_warn "usage fetch HTTP $http_code for $cfg_dir${body_preview:+: $body_preview}" >&2
    return 1
  fi

  if ! jq -e . "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    subctl_warn "usage response was not valid JSON for $cfg_dir" >&2
    return 1
  fi

  mv "$tmp" "$cache"
  cat "$cache"
}

# Walk every claude account, emit one JSON object per line:
#   {"alias":..., "cfg_dir":..., "ok": true,  "usage": {...}}
#   {"alias":..., "cfg_dir":..., "ok": false, "error": "..."}
# Designed to be `jq -s .`-friendly for callers that want a single array.
subctl_usage_fetch_all() {
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "claude" ]] && continue
    local data err
    if data=$(subctl_usage_fetch "$cfg_dir" 2>/dev/null); then
      jq -c --arg alias "$alias" --arg cfg "$cfg_dir" \
        '{alias: $alias, cfg_dir: $cfg, ok: true, usage: .}' <<<"$data"
    else
      err=$(subctl_usage_fetch "$cfg_dir" 2>&1 >/dev/null || true)
      jq -cn --arg alias "$alias" --arg cfg "$cfg_dir" --arg err "${err:-fetch failed}" \
        '{alias: $alias, cfg_dir: $cfg, ok: false, error: $err}'
    fi
  done < <(subctl_list_accounts)
}

# Pretty per-account summary, mimicking what `/usage` shows but cross-account.
# Reads cached data when fresh.
subctl_usage_print_table() {
  printf "%-20s %-8s %-10s %-14s %-14s %s\n" \
    "ALIAS" "5H" "7D-ALL" "7D-SONNET" "7D-OPUS" "RESET (7D)"
  printf "%-20s %-8s %-10s %-14s %-14s %s\n" \
    "$(printf -- '─%.0s' {1..18})" "$(printf -- '─%.0s' {1..6})" \
    "$(printf -- '─%.0s' {1..8})" "$(printf -- '─%.0s' {1..12})" \
    "$(printf -- '─%.0s' {1..12})" "$(printf -- '─%.0s' {1..28})"

  while IFS= read -r line; do
    local alias ok five_h seven_d seven_d_sonnet seven_d_opus seven_reset
    alias=$(jq -r '.alias' <<<"$line")
    ok=$(jq -r '.ok' <<<"$line")
    if [[ "$ok" != "true" ]]; then
      printf "%-20s %s\n" "$alias" "$(jq -r '.error' <<<"$line" | head -c 80)"
      continue
    fi
    fmt() { local v="$1"; [[ "$v" == "null" || -z "$v" ]] && printf '—' || printf '%s%%' "$v"; }
    five_h=$(fmt "$(jq -r '.usage.five_hour.utilization // "null"' <<<"$line")")
    seven_d=$(fmt "$(jq -r '.usage.seven_day.utilization // "null"' <<<"$line")")
    seven_d_sonnet=$(fmt "$(jq -r '.usage.seven_day_sonnet.utilization // "null"' <<<"$line")")
    seven_d_opus=$(fmt "$(jq -r '.usage.seven_day_opus.utilization // "null"' <<<"$line")")
    seven_reset=$(jq -r '.usage.seven_day.resets_at // "—"' <<<"$line")
    printf "%-20s %-8s %-10s %-14s %-14s %s\n" \
      "$alias" "$five_h" "$seven_d" "$seven_d_sonnet" "$seven_d_opus" "$seven_reset"
  done < <(subctl_usage_fetch_all)
}
