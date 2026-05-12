#!/usr/bin/env bash
# lib/service.sh — launchd-based dashboard service management on macOS.

[[ -n "${_SUBCTL_SERVICE_LOADED:-}" ]] && return 0
_SUBCTL_SERVICE_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/exec.sh"

SUBCTL_SERVICE_LABEL="${SUBCTL_SERVICE_LABEL:-com.subctl.dashboard}"
SUBCTL_SERVICE_PORT="${SUBCTL_SERVICE_PORT:-8787}"
# Dashboard bind interface. Default 127.0.0.1 keeps fresh installs locked to
# localhost — the dashboard is a control plane (spawns/kills orchestrators).
# Set SUBCTL_DASHBOARD_HOST=0.0.0.0 before `subctl service enable` to expose
# on LAN + Tailscale + every other interface.
SUBCTL_DASHBOARD_HOST="${SUBCTL_DASHBOARD_HOST:-127.0.0.1}"
SUBCTL_SERVICE_PLIST="$HOME/Library/LaunchAgents/${SUBCTL_SERVICE_LABEL}.plist"
SUBCTL_SERVICE_TPL="$SUBCTL_REPO_ROOT/dashboard/launchd/com.example.subctl.dashboard.plist.tpl"
SUBCTL_DASHBOARD_TS="$SUBCTL_REPO_ROOT/dashboard/server.ts"

# ── status ───────────────────────────────────────────────────────────────────
# Returns: running | stopped | not-installed
subctl_service_state() {
  if launchctl list | awk '{print $3}' | grep -qx "$SUBCTL_SERVICE_LABEL"; then
    echo running
  elif [[ -f "$SUBCTL_SERVICE_PLIST" ]]; then
    echo stopped
  else
    echo not-installed
  fi
}

subctl_service_pid() {
  launchctl list "$SUBCTL_SERVICE_LABEL" 2>/dev/null | awk -F'=' '/"PID"/ {gsub(/[^0-9]/, "", $2); print $2}'
}

subctl_service_status() {
  local state
  state=$(subctl_service_state)
  case "$state" in
    running)
      local pid
      pid=$(subctl_service_pid)
      printf "%s● Running%s\n" "$C_GRN" "$C_RST"
      printf "  Label:    %s\n" "$SUBCTL_SERVICE_LABEL"
      printf "  PID:      %s\n" "${pid:-?}"
      # Read host from the running plist so status reflects what's actually bound
      local host
      host=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:SUBCTL_DASHBOARD_HOST" "$SUBCTL_SERVICE_PLIST" 2>/dev/null || echo "127.0.0.1")
      if [[ "$host" == "0.0.0.0" ]]; then
        printf "  URL:      http://127.0.0.1:%s  (also LAN/Tailscale on this port — bound 0.0.0.0)\n" "$SUBCTL_SERVICE_PORT"
      else
        printf "  URL:      http://%s:%s\n" "$host" "$SUBCTL_SERVICE_PORT"
      fi
      printf "  Plist:    %s\n" "$SUBCTL_SERVICE_PLIST"
      ;;
    stopped)
      printf "%s○ Stopped%s (auto-start enabled)\n" "$C_YLW" "$C_RST"
      printf "  Plist:    %s\n" "$SUBCTL_SERVICE_PLIST"
      printf "  Start:    subctl service start\n"
      ;;
    not-installed)
      printf "%s○ Not installed%s\n" "$C_DIM" "$C_RST"
      printf "  Enable:   subctl service enable\n"
      ;;
  esac
}

# ── enable: install plist + load ─────────────────────────────────────────────
subctl_service_enable() {
  subctl_require bun "install: curl -fsSL https://bun.sh/install | bash" || return 1
  [[ ! -f "$SUBCTL_SERVICE_TPL" ]] && subctl_die "plist template missing: $SUBCTL_SERVICE_TPL"

  mkdir -p "$(dirname "$SUBCTL_SERVICE_PLIST")" "$SUBCTL_LOG_DIR"

  local bun_bin
  bun_bin=$(command -v bun)

  # Substitute placeholders
  sed -e "s|__OWNER__|com.subctl|g" \
      -e "s|__BUN__|$bun_bin|g" \
      -e "s|__SERVER_TS__|$SUBCTL_DASHBOARD_TS|g" \
      -e "s|__PORT__|$SUBCTL_SERVICE_PORT|g" \
      -e "s|__DASH_HOST__|$SUBCTL_DASHBOARD_HOST|g" \
      -e "s|__HOME__|$HOME|g" \
      "$SUBCTL_SERVICE_TPL" > "$SUBCTL_SERVICE_PLIST"

  # Ensure label inside plist matches our SUBCTL_SERVICE_LABEL
  /usr/libexec/PlistBuddy -c "Set :Label $SUBCTL_SERVICE_LABEL" "$SUBCTL_SERVICE_PLIST" 2>/dev/null || true

  # PR 8.5: routed through subctl_exec. Operator-typed CLI verb, no agent input.
  subctl_exec launchctl unload "$SUBCTL_SERVICE_PLIST" 2>/dev/null || true
  subctl_exec launchctl load -w "$SUBCTL_SERVICE_PLIST"

  subctl_ok "service enabled — auto-starts at login"
  sleep 1
  subctl_service_status
}

# ── disable: unload + remove plist ───────────────────────────────────────────
subctl_service_disable() {
  if [[ -f "$SUBCTL_SERVICE_PLIST" ]]; then
    launchctl unload "$SUBCTL_SERVICE_PLIST" 2>/dev/null || true
    rm -f "$SUBCTL_SERVICE_PLIST"
    subctl_ok "service disabled — plist removed"
  else
    subctl_info "service was not installed"
  fi
}

# ── start / stop / restart ───────────────────────────────────────────────────
subctl_service_start() {
  if [[ ! -f "$SUBCTL_SERVICE_PLIST" ]]; then
    subctl_warn "service not enabled. Run: subctl service enable"
    return 1
  fi
  launchctl load "$SUBCTL_SERVICE_PLIST" 2>/dev/null || true
  launchctl start "$SUBCTL_SERVICE_LABEL"
  sleep 1
  subctl_service_status
}

subctl_service_stop() {
  launchctl stop "$SUBCTL_SERVICE_LABEL" 2>/dev/null || true
  subctl_ok "service stopped"
}

subctl_service_restart() {
  subctl_service_stop
  sleep 1
  subctl_service_start
}

# ── logs ─────────────────────────────────────────────────────────────────────
subctl_service_logs() {
  local n="${1:-50}"
  local out="$SUBCTL_LOG_DIR/dashboard.out.log"
  local err="$SUBCTL_LOG_DIR/dashboard.err.log"
  if [[ -f "$out" ]]; then
    printf "%s──── stdout (last %d) ────%s\n" "$C_DIM" "$n" "$C_RST"
    tail -n "$n" "$out"
  fi
  if [[ -f "$err" ]]; then
    printf "%s──── stderr (last %d) ────%s\n" "$C_DIM" "$n" "$C_RST"
    tail -n "$n" "$err"
  fi
}

# ── foreground (no service) ──────────────────────────────────────────────────
subctl_service_foreground() {
  subctl_require bun "install: curl -fsSL https://bun.sh/install | bash" || return 1
  PORT="$SUBCTL_SERVICE_PORT" exec bun "$SUBCTL_DASHBOARD_TS"
}
