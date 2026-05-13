# lib/voice.sh — subctl voice layer install / enable / disable / status.
#
# v2.8.0. Mirrors lib/master.sh's launchd plumbing for the master daemon
# but for services/tts/server.py. Pure bash on purpose: install.sh
# sources this same library so the operator can install voice in two
# places (interactive `subctl voice install` vs `./install.sh --voice`).
#
# Self-hosted-only floor per ADR 0009 — this file never touches a cloud
# TTS API. Backend choice is mock | voxcpm | kokoro.

# Resolve repo root if not already exported (matches lib/master.sh).
: "${SUBCTL_REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

SUBCTL_TTS_LABEL="${SUBCTL_TTS_LABEL:-com.subctl.tts}"
SUBCTL_TTS_PLIST="$HOME/Library/LaunchAgents/${SUBCTL_TTS_LABEL}.plist"
SUBCTL_TTS_PLIST_TPL="$SUBCTL_REPO_ROOT/services/tts/launchd/com.subctl.tts.plist"
SUBCTL_TTS_SERVER_PY="$SUBCTL_REPO_ROOT/services/tts/server.py"
SUBCTL_TTS_VOICES_DIR="$SUBCTL_REPO_ROOT/services/tts/voices"
SUBCTL_TTS_LOG="$HOME/Library/Logs/subctl/tts.log"
SUBCTL_VOICE_CONFIG="$HOME/.config/subctl/voice.json"

# ── helpers (assume lib/core.sh is sourced before this lib) ─────────────
_subctl_voice_pick_python() {
  # Prefer python3.11/3.10; fall back to python3.
  for py in python3.12 python3.11 python3.10 python3; do
    if command -v "$py" >/dev/null 2>&1; then
      echo "$(command -v "$py")"
      return 0
    fi
  done
  return 1
}

# ── install ────────────────────────────────────────────────────────────
# Seeds voice.json with defaults, picks a python binary, and installs
# launchd plist. Does NOT install voxcpm/kokoro wheels — that's a manual
# operator step documented in services/tts/README.md so install.sh stays
# fast on first run.
subctl_voice_install() {
  local backend="${1:-mock}"
  local python_bin
  python_bin=$(_subctl_voice_pick_python) || {
    subctl_err "no python3 found in PATH — install python 3.10+ first"
    return 1
  }
  if [[ ! -f "$SUBCTL_TTS_PLIST_TPL" ]]; then
    subctl_err "plist template missing: $SUBCTL_TTS_PLIST_TPL"
    return 1
  fi
  if [[ ! -f "$SUBCTL_TTS_SERVER_PY" ]]; then
    subctl_err "server stub missing: $SUBCTL_TTS_SERVER_PY"
    return 1
  fi

  mkdir -p "$(dirname "$SUBCTL_TTS_PLIST")" "$(dirname "$SUBCTL_TTS_LOG")" \
           "$(dirname "$SUBCTL_VOICE_CONFIG")"

  # Seed voice.json with defaults (disabled by default — operator opts
  # in with `subctl voice on`).
  if [[ ! -f "$SUBCTL_VOICE_CONFIG" ]]; then
    cat > "$SUBCTL_VOICE_CONFIG" <<JSON
{
  "enabled": false,
  "default_voice_id": "evy-rachel-weisz",
  "model": "voxcpm-0.5b",
  "tts_server": "http://localhost:8789"
}
JSON
    subctl_ok "seeded $SUBCTL_VOICE_CONFIG (enabled=false; toggle with 'subctl voice on')"
  fi

  # Render plist with the operator's local python + paths substituted.
  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__PYTHON__|$python_bin|g" \
      -e "s|__SERVER_PY__|$SUBCTL_TTS_SERVER_PY|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__BACKEND__|$backend|g" \
      -e "s|__VOICES_DIR__|$SUBCTL_TTS_VOICES_DIR|g" \
      "$SUBCTL_TTS_PLIST_TPL" > "$SUBCTL_TTS_PLIST"

  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_TTS_LABEL" "$SUBCTL_TTS_PLIST" 2>/dev/null || true

  launchctl unload "$SUBCTL_TTS_PLIST" 2>/dev/null || true
  if ! launchctl load -w "$SUBCTL_TTS_PLIST"; then
    subctl_err "launchctl load failed — plist at $SUBCTL_TTS_PLIST"
    return 1
  fi

  subctl_ok "subctl tts service enabled (backend=$backend)"
  printf "  Label:    %s\n" "$SUBCTL_TTS_LABEL"
  printf "  Plist:    %s\n" "$SUBCTL_TTS_PLIST"
  printf "  Server:   %s\n" "$SUBCTL_TTS_SERVER_PY"
  printf "  Backend:  %s\n" "$backend"
  printf "  Logs:     %s\n" "$SUBCTL_TTS_LOG"
  printf "  Test:     subctl voice test\n"
  case "$backend" in
    voxcpm)
      printf "  %s\n" "Heads up: ensure 'pip install voxcpm' has been run + reference clip at $SUBCTL_TTS_VOICES_DIR/evy-rachel-weisz/reference.wav (see services/tts/README.md)."
      ;;
    kokoro)
      printf "  %s\n" "Heads up: ensure 'pip install kokoro' has been run (see services/tts/README.md)."
      ;;
    mock)
      printf "  %s\n" "Mock backend active — outputs 1s of silence. Pick voxcpm or kokoro for real speech."
      ;;
  esac
}

# ── disable ────────────────────────────────────────────────────────────
subctl_voice_disable() {
  if [[ -f "$SUBCTL_TTS_PLIST" ]]; then
    launchctl unload "$SUBCTL_TTS_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_TTS_PLIST"
    subctl_ok "subctl tts disabled — plist removed (voice.json preserved)"
  else
    subctl_info "subctl tts was not enabled"
  fi
}
