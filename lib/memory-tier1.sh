# lib/memory-tier1.sh — Tier 1 candidate queue CLI helpers.
#
# Memory Init #5 Phase 3. Mirrors lib/memory-kernel.sh in shape: thin shell
# wrappers around the master daemon's HTTP surface at /memory/tier1/*,
# routed through the dashboard proxy so `subctl memory tier1 ...` works
# from anywhere on the LAN that can reach the dashboard.
#
# Endpoints (master :8788):
#   GET  /memory/tier1/pending
#   POST /memory/tier1/approve   body {candidate_id, note?}
#   POST /memory/tier1/reject    body {candidate_id, note?}

# ── pending ────────────────────────────────────────────────────────────
# Lists pending candidates the kernel queued for operator/Evy review.
subctl_memory_tier1_pending() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/memory/tier1/pending"
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    subctl_err "GET $url failed — is the dashboard running?"
    return 1
  fi
  printf '%s' "$body" | jq .
}

# ── approve ────────────────────────────────────────────────────────────
# Approves a candidate by id; promotes through memory_remember (same char
# budget applies, so this may fail and leave the candidate pending).
subctl_memory_tier1_approve() {
  _subctl_cli_require_jq || return 1
  local id="${1:-}"
  shift || true
  if [[ -z "$id" ]]; then
    subctl_err "approve expects a candidate_id (try: subctl memory tier1 pending)"
    return 1
  fi
  local note="${*:-}"
  local payload url body
  if [[ -n "$note" ]]; then
    payload=$(jq -n --arg id "$id" --arg n "$note" '{candidate_id:$id, note:$n}')
  else
    payload=$(jq -n --arg id "$id" '{candidate_id:$id}')
  fi
  url="$(_subctl_cli_dashboard_base)/api/memory/tier1/approve"
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" \
    --data "$payload" "$url" 2>/dev/null); then
    # curl --fail returns non-zero on HTTP 4xx (e.g. 404 not-found); fall
    # back to a non-failing fetch so we can still pretty-print the error
    # body the master returned.
    body=$(curl --silent --show-error \
      --connect-timeout 3 --max-time 5 \
      -X POST -H "Content-Type: application/json" \
      --data "$payload" "$url" 2>/dev/null)
    if [[ -z "$body" ]]; then
      subctl_err "POST $url failed — is the dashboard running?"
      return 1
    fi
  fi
  printf '%s' "$body" | jq .
}

# ── reject ─────────────────────────────────────────────────────────────
subctl_memory_tier1_reject() {
  _subctl_cli_require_jq || return 1
  local id="${1:-}"
  shift || true
  if [[ -z "$id" ]]; then
    subctl_err "reject expects a candidate_id (try: subctl memory tier1 pending)"
    return 1
  fi
  local note="${*:-}"
  local payload url body
  if [[ -n "$note" ]]; then
    payload=$(jq -n --arg id "$id" --arg n "$note" '{candidate_id:$id, note:$n}')
  else
    payload=$(jq -n --arg id "$id" '{candidate_id:$id}')
  fi
  url="$(_subctl_cli_dashboard_base)/api/memory/tier1/reject"
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" \
    --data "$payload" "$url" 2>/dev/null); then
    body=$(curl --silent --show-error \
      --connect-timeout 3 --max-time 5 \
      -X POST -H "Content-Type: application/json" \
      --data "$payload" "$url" 2>/dev/null)
    if [[ -z "$body" ]]; then
      subctl_err "POST $url failed — is the dashboard running?"
      return 1
    fi
  fi
  printf '%s' "$body" | jq .
}
