# lib/cognee.sh — subctl Cognee sidecar install / uninstall / status.
#
# v2.8.x — Memory Init #1 first-class install. Mirrors lib/memori.sh
# exactly, but for services/cognee/server.py. Renders the launchd plist
# with the operator's local python + paths, loads it, and seeds env
# vars. Data lives at ~/.config/subctl/cognee-data/ — separate from
# memori.db (Tier 3) per the architecture in argentos-memory-v3.
#
# Default LLM provider for the cognee SDK = LM Studio at
# http://localhost:1234/v1 (operator-local). Override by setting
# SUBCTL_COGNEE_LLM_BASE / _MODEL / _KEY before running install (or by
# editing the rendered plist directly).

SUBCTL_COGNEE_PLIST_TPL="$SUBCTL_REPO_ROOT/services/cognee/launchd/com.subctl.cognee.plist"
SUBCTL_COGNEE_SERVER_PY="$SUBCTL_REPO_ROOT/services/cognee/server.py"
SUBCTL_COGNEE_PLIST="$HOME/Library/LaunchAgents/com.subctl.cognee.plist"
SUBCTL_COGNEE_LOG="$HOME/Library/Logs/subctl/cognee.log"
SUBCTL_COGNEE_DATA_DEFAULT="$HOME/.config/subctl/cognee-data"
SUBCTL_COGNEE_VENV_DEFAULT="$HOME/.local/share/subctl/cognee-venv"
SUBCTL_COGNEE_LABEL="com.subctl.cognee"
SUBCTL_COGNEE_HEALTH_URL="http://127.0.0.1:8745/health"
SUBCTL_COGNEE_LLM_BASE_DEFAULT="${SUBCTL_COGNEE_LLM_BASE:-http://localhost:1234/v1}"
# cognee's "reviewer" does structured entity/relationship extraction — a 9B is
# plenty and keeps GPU load low. LM Studio is the single local-model endpoint
# (oMLX retired 2026-05-28 — running it as a 2nd MLX engine alongside LM Studio
# contributed to GPU/thermal hard-reboots). Override: export SUBCTL_COGNEE_LLM_MODEL=<id>.
SUBCTL_COGNEE_LLM_MODEL_DEFAULT="${SUBCTL_COGNEE_LLM_MODEL:-qwen/qwen3.5-9b}"
SUBCTL_COGNEE_LLM_KEY_DEFAULT="${SUBCTL_COGNEE_LLM_KEY:-lm-studio}"

# Pick the python to wire into the launchd plist:
#   1. Prefer the managed venv at ~/.local/share/subctl/cognee-venv if
#      it exists (created by `pip install cognee` against a clean
#      interpreter — avoids system python conflicts).
#   2. Otherwise pick the first python3 in PATH that's >= 3.10.
_subctl_cognee_pick_python() {
  if [[ -x "$SUBCTL_COGNEE_VENV_DEFAULT/bin/python" ]]; then
    printf '%s\n' "$SUBCTL_COGNEE_VENV_DEFAULT/bin/python"
    return 0
  fi
  local p
  for p in $(which -a python3.12 python3.13 python3.11 python3.10 python3 2>/dev/null); do
    [[ -x "$p" ]] || continue
    if "$p" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' 2>/dev/null; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  # Last-resort: any 3.10+ even if 3.14+ (cognee may or may not work).
  for p in $(which -a python3 2>/dev/null); do
    [[ -x "$p" ]] || continue
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

# ── install ────────────────────────────────────────────────────────────
# Renders plist + loads it. The Python `cognee` SDK is optional at install
# time — the shim runs in fallback mode (gate-only) without it so master
# can still flip TOOL_GATES.cognee on. Operator can run
# `pip install cognee` later to activate the full graph engine.
subctl_cognee_install() {
  local python_bin
  python_bin=$(_subctl_cognee_pick_python) || {
    subctl_err "no python3 (>=3.10) found in PATH"
    return 1
  }
  if [[ ! -f "$SUBCTL_COGNEE_PLIST_TPL" ]]; then
    subctl_err "plist template missing: $SUBCTL_COGNEE_PLIST_TPL"
    return 1
  fi
  if [[ ! -f "$SUBCTL_COGNEE_SERVER_PY" ]]; then
    subctl_err "server stub missing: $SUBCTL_COGNEE_SERVER_PY"
    return 1
  fi

  mkdir -p "$(dirname "$SUBCTL_COGNEE_PLIST")" "$(dirname "$SUBCTL_COGNEE_LOG")" \
           "$SUBCTL_COGNEE_DATA_DEFAULT"

  # Render plist with operator-local paths + LLM config. Embedding
  # model is hardcoded in the template (LM Studio's
  # text-embedding-nomic-embed-text-v1.5); operator can edit the
  # rendered plist if they're running a different embedding model.
  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__PYTHON__|$python_bin|g" \
      -e "s|__SERVER_PY__|$SUBCTL_COGNEE_SERVER_PY|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__DATA_DIR__|$SUBCTL_COGNEE_DATA_DEFAULT|g" \
      -e "s|__LLM_BASE__|$SUBCTL_COGNEE_LLM_BASE_DEFAULT|g" \
      -e "s|__LLM_MODEL__|$SUBCTL_COGNEE_LLM_MODEL_DEFAULT|g" \
      -e "s|__LLM_KEY__|$SUBCTL_COGNEE_LLM_KEY_DEFAULT|g" \
      "$SUBCTL_COGNEE_PLIST_TPL" > "$SUBCTL_COGNEE_PLIST"

  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_COGNEE_LABEL" "$SUBCTL_COGNEE_PLIST" 2>/dev/null || true

  launchctl unload "$SUBCTL_COGNEE_PLIST" 2>/dev/null || true
  if ! launchctl load -w "$SUBCTL_COGNEE_PLIST"; then
    subctl_err "launchctl load failed — plist at $SUBCTL_COGNEE_PLIST"
    return 1
  fi

  # Quick reachability probe — give launchd a couple seconds to bind.
  local i sdk_state="unknown" response
  for i in 1 2 3 4 5; do
    if response=$(curl -sS --max-time 2 "$SUBCTL_COGNEE_HEALTH_URL" 2>/dev/null); then
      if printf '%s' "$response" | jq -e '.using_real_sdk' >/dev/null 2>&1; then
        if printf '%s' "$response" | jq -e '.using_real_sdk == true' >/dev/null 2>&1; then
          sdk_state="full SDK"
        else
          sdk_state="fallback (no SDK)"
        fi
      fi
      break
    fi
    sleep 1
  done

  subctl_ok "subctl cognee sidecar enabled ($sdk_state)"
  printf "  Label:    %s\n" "$SUBCTL_COGNEE_LABEL"
  printf "  Plist:    %s\n" "$SUBCTL_COGNEE_PLIST"
  printf "  Server:   %s\n" "$SUBCTL_COGNEE_SERVER_PY"
  printf "  Python:   %s\n" "$python_bin"
  printf "  Data:     %s\n" "$SUBCTL_COGNEE_DATA_DEFAULT"
  printf "  LLM:      %s (model=%s)\n" \
    "$SUBCTL_COGNEE_LLM_BASE_DEFAULT" "$SUBCTL_COGNEE_LLM_MODEL_DEFAULT"
  printf "  URL:      http://127.0.0.1:8745\n"
  printf "  Logs:     %s\n" "$SUBCTL_COGNEE_LOG"
  printf "  Health:   curl -sS %s | jq .\n" "$SUBCTL_COGNEE_HEALTH_URL"
  if [[ "$sdk_state" == "fallback (no SDK)" ]]; then
    printf "\n  %s\n" "NOTE: Cognee Python SDK not installed — sidecar runs in fallback mode."
    printf "  %s\n" "    Lexical sqlite recall works; graph traversal returns empty."
    printf "  %s\n" "    To activate the real graph engine:"
    printf "  %s\n" "      $python_bin -m pip install cognee"
    printf "  %s\n" "    Then: launchctl kickstart -k gui/\$(id -u)/com.subctl.cognee"
  fi
}

# ── uninstall ──────────────────────────────────────────────────────────
subctl_cognee_disable() {
  if [[ -f "$SUBCTL_COGNEE_PLIST" ]]; then
    launchctl unload "$SUBCTL_COGNEE_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_COGNEE_PLIST"
    subctl_ok "subctl cognee plist unloaded + removed: $SUBCTL_COGNEE_PLIST"
  else
    subctl_err "no plist at $SUBCTL_COGNEE_PLIST"
  fi
  printf "  Note: data at %s preserved. Delete manually if you want a clean slate.\n" \
    "$SUBCTL_COGNEE_DATA_DEFAULT"
}

# ── status ─────────────────────────────────────────────────────────────
subctl_cognee_status() {
  if curl -sS --max-time 3 "$SUBCTL_COGNEE_HEALTH_URL" 2>/dev/null | jq . 2>/dev/null; then
    return 0
  fi
  subctl_err "cognee sidecar unreachable at $SUBCTL_COGNEE_HEALTH_URL"
  if launchctl list 2>/dev/null | grep -q "com.subctl.cognee"; then
    printf "  Service is loaded by launchd but not responding. Check %s.\n" \
      "$SUBCTL_COGNEE_LOG"
  else
    printf "  Service is NOT loaded. Run \`subctl cognee install\` first.\n"
  fi
  return 1
}

# ── ping ───────────────────────────────────────────────────────────────
# Same as status today — separate verb because some operators expect it.
# Future: ping could also POST a synthetic /recall to validate the SDK
# end-to-end, but for now keep them isomorphic.
subctl_cognee_ping() {
  subctl_cognee_status
}

# ── cognify ────────────────────────────────────────────────────────────
# Run the heavy LLM-driven extraction pipeline that turns the raw text
# corpus (stored by /remember) into a queryable graph of nodes + edges.
# Operator-invoked: this can take minutes per dataset, so master never
# auto-runs it. Run after a backfill or any large ingestion.
#
# Usage:
#   subctl_cognee_cognify [DATASET] [TIMEOUT_S]
#
# Default DATASET = subctl_main (sidecar's default).
# Default TIMEOUT_S = 600 (10 min).
subctl_cognee_cognify() {
  local dataset="${1:-subctl_main}"
  local timeout_s="${2:-600}"
  local curl_max=$((timeout_s + 30))
  printf "  → POST %s/cognify dataset=%s timeout=%ss\n" \
    "${SUBCTL_COGNEE_HEALTH_URL%/health}" "$dataset" "$timeout_s"
  printf "  → expect minutes of LLM-driven extraction; do not interrupt.\n"
  local body
  body=$(jq -n --arg ds "$dataset" --argjson to "$timeout_s" \
    '{dataset: $ds, timeout_s: $to}' 2>/dev/null)
  local response
  if ! response=$(curl -sS --max-time "$curl_max" \
       -X POST -H "Content-Type: application/json" -d "$body" \
       "${SUBCTL_COGNEE_HEALTH_URL%/health}/cognify" 2>&1); then
    subctl_err "POST /cognify failed: $response"
    return 1
  fi
  printf '%s' "$response" | jq . 2>/dev/null || printf '%s\n' "$response"
  local ok
  ok=$(printf '%s' "$response" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    local nodes_after edges_after duration
    nodes_after=$(printf '%s' "$response" | jq -r '.node_count_after // 0')
    edges_after=$(printf '%s' "$response" | jq -r '.edge_count_after // 0')
    duration=$(printf '%s' "$response" | jq -r '.duration_ms // 0')
    subctl_ok "cognify complete — nodes=$nodes_after edges=$edges_after took ${duration}ms"
    return 0
  fi
  subctl_err "cognify reported failure (see response above)"
  return 1
}
