# lib/memory-kernel.sh — Memory consciousness cycle CLI helpers.
#
# Memory Init #5 Phase 3 (Worker C / integration). Mirrors lib/memori.sh
# in shape: thin shell wrappers around the master daemon's HTTP surface
# at /memory/kernel/*. Routes through the dashboard proxy
# (/api/memory/kernel/*) so the operator's `subctl memory kernel ...`
# commands work from anywhere on the LAN that can reach the dashboard.
#
# Endpoints (master :8788):
#   GET  /memory/kernel/status
#   POST /memory/kernel/run-now
#   POST /memory/kernel/pause
#   POST /memory/kernel/resume

# ── status ─────────────────────────────────────────────────────────────
# Hits the dashboard proxy and pretty-prints the kernel state. JSON dump
# via jq so the operator can grep / pipe / read at a glance.
subctl_memory_kernel_status() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/memory/kernel/status"
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    subctl_err "GET $url failed — is the dashboard running?"
    return 1
  fi
  printf '%s' "$body" | jq .
}

# ── run-now ────────────────────────────────────────────────────────────
# Forces a single cycle outside the regular 5-min ticker. Useful right
# after capturing a notable conversation: "review it now, don't wait."
subctl_memory_kernel_run_now() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/memory/kernel/run-now"
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" \
    --data '{}' "$url" 2>/dev/null); then
    subctl_err "POST $url failed — is the dashboard running?"
    return 1
  fi
  printf '%s' "$body" | jq .
}

# ── pause ──────────────────────────────────────────────────────────────
subctl_memory_kernel_pause() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/memory/kernel/pause"
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" \
    --data '{}' "$url" 2>/dev/null); then
    subctl_err "POST $url failed — is the dashboard running?"
    return 1
  fi
  subctl_ok "memory kernel paused"
  printf '%s' "$body" | jq .
}

# ── resume ─────────────────────────────────────────────────────────────
subctl_memory_kernel_resume() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/memory/kernel/resume"
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" \
    --data '{}' "$url" 2>/dev/null); then
    subctl_err "POST $url failed — is the dashboard running?"
    return 1
  fi
  subctl_ok "memory kernel resumed"
  printf '%s' "$body" | jq .
}
