# lib/memori.sh — subctl Memori sidecar install / uninstall / status.
#
# v2.8.10 — Memory Init #3 (Phase 3b). Mirrors lib/voice.sh exactly,
# but for services/memori/server.py. Renders the launchd plist with
# the operator's local python + paths, loads it, and seeds env vars.
# Database lives at ~/.config/subctl/master/memori.db per Knot #2.

SUBCTL_MEMORI_PLIST_TPL="$SUBCTL_REPO_ROOT/services/memori/launchd/com.subctl.memori.plist"
SUBCTL_MEMORI_SERVER_PY="$SUBCTL_REPO_ROOT/services/memori/server.py"
SUBCTL_MEMORI_PLIST="$HOME/Library/LaunchAgents/com.subctl.memori.plist"
SUBCTL_MEMORI_LOG="$HOME/Library/Logs/subctl/memori.log"
SUBCTL_MEMORI_DB_DEFAULT="$HOME/.config/subctl/master/memori.db"
SUBCTL_MEMORI_LABEL="com.subctl.memori"

# Pick the first python3 in PATH that's >= 3.10.
_subctl_memori_pick_python() {
  local p
  for p in $(which -a python3 python3.13 python3.12 python3.11 python3.10 2>/dev/null); do
    [[ -x "$p" ]] || continue
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

# ── install ────────────────────────────────────────────────────────────
# Renders plist + loads it. Operator chooses augmentation on/off (off =
# raw sqlite-only fallback, no conversation content leaves the box).
subctl_memori_install() {
  local augmentation="${1:-off}"
  local python_bin
  python_bin=$(_subctl_memori_pick_python) || {
    subctl_err "no python3 (>=3.10) found in PATH"
    return 1
  }
  if [[ ! -f "$SUBCTL_MEMORI_PLIST_TPL" ]]; then
    subctl_err "plist template missing: $SUBCTL_MEMORI_PLIST_TPL"
    return 1
  fi
  if [[ ! -f "$SUBCTL_MEMORI_SERVER_PY" ]]; then
    subctl_err "server stub missing: $SUBCTL_MEMORI_SERVER_PY"
    return 1
  fi

  mkdir -p "$(dirname "$SUBCTL_MEMORI_PLIST")" "$(dirname "$SUBCTL_MEMORI_LOG")" \
           "$(dirname "$SUBCTL_MEMORI_DB_DEFAULT")"

  # Render plist with operator-local paths.
  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__PYTHON__|$python_bin|g" \
      -e "s|__SERVER_PY__|$SUBCTL_MEMORI_SERVER_PY|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__DB_PATH__|$SUBCTL_MEMORI_DB_DEFAULT|g" \
      -e "s|__AUGMENT__|$augmentation|g" \
      "$SUBCTL_MEMORI_PLIST_TPL" > "$SUBCTL_MEMORI_PLIST"

  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_MEMORI_LABEL" "$SUBCTL_MEMORI_PLIST" 2>/dev/null || true

  launchctl unload "$SUBCTL_MEMORI_PLIST" 2>/dev/null || true
  if ! launchctl load -w "$SUBCTL_MEMORI_PLIST"; then
    subctl_err "launchctl load failed — plist at $SUBCTL_MEMORI_PLIST"
    return 1
  fi

  subctl_ok "subctl memori sidecar enabled (augmentation=$augmentation)"
  printf "  Label:    %s\n" "$SUBCTL_MEMORI_LABEL"
  printf "  Plist:    %s\n" "$SUBCTL_MEMORI_PLIST"
  printf "  Server:   %s\n" "$SUBCTL_MEMORI_SERVER_PY"
  printf "  DB:       %s\n" "$SUBCTL_MEMORI_DB_DEFAULT"
  printf "  URL:      http://127.0.0.1:8746\n"
  printf "  Logs:     %s\n" "$SUBCTL_MEMORI_LOG"
  printf "  Health:   curl -sS http://127.0.0.1:8746/health\n"
  case "$augmentation" in
    on)
      printf "  %s\n" "Augmentation ON: requires \`pip install memori\` + MEMORI_API_KEY. Conversation content flows to memorilabs.ai for fact/preference extraction. Raw records stay local in SQLite."
      ;;
    off)
      printf "  %s\n" "Augmentation OFF (default): raw SQLite-only fallback. No content leaves this box. Lexical recall only — no LoCoMo-style structured extraction."
      ;;
  esac
}

# ── uninstall ──────────────────────────────────────────────────────────
subctl_memori_disable() {
  if [[ -f "$SUBCTL_MEMORI_PLIST" ]]; then
    launchctl unload "$SUBCTL_MEMORI_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_MEMORI_PLIST"
    subctl_ok "subctl memori plist unloaded + removed: $SUBCTL_MEMORI_PLIST"
  else
    subctl_err "no plist at $SUBCTL_MEMORI_PLIST"
  fi
  printf "  Note: database at %s preserved. Delete manually if you want a clean slate.\n" \
    "$SUBCTL_MEMORI_DB_DEFAULT"
}

# ── status ─────────────────────────────────────────────────────────────
subctl_memori_status() {
  if curl -sS --max-time 3 "http://127.0.0.1:8746/health" 2>/dev/null | jq . 2>/dev/null; then
    return 0
  fi
  subctl_err "memori sidecar unreachable at http://127.0.0.1:8746"
  if launchctl list 2>/dev/null | grep -q "com.subctl.memori"; then
    printf "  Service is loaded by launchd but not responding. Check %s.\n" \
      "$SUBCTL_MEMORI_LOG"
  else
    printf "  Service is NOT loaded. Run \`subctl memori install\` first.\n"
  fi
  return 1
}
