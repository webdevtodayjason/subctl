#!/usr/bin/env bash
# lib/tui.sh — gum-based TUI menus. Falls back to numeric prompts if gum is missing.

[[ -n "${_SUBCTL_TUI_LOADED:-}" ]] && return 0
_SUBCTL_TUI_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/accounts.sh"
. "$(dirname "${BASH_SOURCE[0]}")/service.sh"
. "$(dirname "${BASH_SOURCE[0]}")/radar.sh"

# ── helpers ──────────────────────────────────────────────────────────────────
_subctl_tui_have_gum() { command -v gum >/dev/null 2>&1; }

_subctl_tui_choose() {
  local prompt="$1"; shift
  if _subctl_tui_have_gum; then
    gum choose --header="$prompt" --height=15 "$@"
  else
    # Fallback: numeric menu
    echo "$prompt"
    local i=1
    for opt in "$@"; do printf "  %d. %s\n" "$i" "$opt"; i=$((i+1)); done
    local pick
    read -r -p "Pick [1-$#]: " pick
    [[ "$pick" =~ ^[0-9]+$ ]] && [[ "$pick" -ge 1 && "$pick" -le $# ]] && echo "${!pick}"
  fi
}

_subctl_tui_input() {
  local prompt="$1" placeholder="${2:-}"
  if _subctl_tui_have_gum; then
    gum input --prompt="$prompt " --placeholder="$placeholder"
  else
    read -r -p "$prompt " v; echo "$v"
  fi
}

_subctl_tui_confirm() {
  local prompt="$1"
  if _subctl_tui_have_gum; then
    gum confirm "$prompt"
  else
    read -r -p "$prompt [y/N] " v
    [[ "$v" == "y" || "$v" == "Y" ]]
  fi
}

_subctl_tui_header() {
  local title="$1" subtitle="${2:-}"
  clear
  printf "%s╔══════════════════════════════════════════════════════════════════╗%s\n" "$C_CYN" "$C_RST"
  printf "%s║%s  %s%-66s%s%s║%s\n" "$C_CYN" "$C_RST" "$C_BLD" "$title" "$C_RST" "$C_CYN" "$C_RST"
  if [[ -n "$subtitle" ]]; then
    printf "%s║%s  %s%-66s%s%s║%s\n" "$C_CYN" "$C_RST" "$C_DIM" "$subtitle" "$C_RST" "$C_CYN" "$C_RST"
  fi
  printf "%s╚══════════════════════════════════════════════════════════════════╝%s\n" "$C_CYN" "$C_RST"
  echo
}

_subctl_tui_pause() {
  echo
  if _subctl_tui_have_gum; then
    gum input --placeholder="press enter to continue" >/dev/null
  else
    read -r -p "Press enter to continue: " _
  fi
}

# ── main menu ────────────────────────────────────────────────────────────────
subctl_tui_main() {
  while true; do
    _subctl_tui_header "subctl — Subscription Central" "v$SUBCTL_VERSION · $(date '+%Y-%m-%d %H:%M')"

    # Live state for menu labels
    local n_ses n_rl service_state acc_counts
    n_ses=$(subctl_radar_parallel_sessions)
    n_rl=$(subctl_radar_rl_hits_today)
    service_state=$(subctl_service_state)
    acc_counts=$(subctl_accounts_count_by_provider | awk '{printf "%s %s ", $2, $1}')
    [[ -z "$acc_counts" ]] && acc_counts="0 accounts"

    local svc_label
    case "$service_state" in
      running)       svc_label="${C_GRN}● running on :${SUBCTL_SERVICE_PORT}${C_RST}" ;;
      stopped)       svc_label="${C_YLW}○ stopped${C_RST}" ;;
      not-installed) svc_label="${C_DIM}○ not installed${C_RST}" ;;
    esac

    printf "  Accounts:   %s\n" "$acc_counts"
    printf "  Radar:      ⚡ %s active  ·  ⚠ %s RL today\n" "$n_ses" "$n_rl"
    printf "  Service:    %b\n" "$svc_label"
    echo

    local choice
    choice=$(_subctl_tui_choose "Choose:" \
      "1. Accounts" \
      "2. Authentication" \
      "3. Sessions / radar" \
      "4. Teams launcher" \
      "5. Web service / dashboard" \
      "6. Settings & config" \
      "7. Doctor (health check)" \
      "8. Logs" \
      "9. About" \
      "q. Quit")
    case "$choice" in
      1.*) subctl_tui_accounts ;;
      2.*) subctl_tui_auth ;;
      3.*) subctl_tui_radar ;;
      4.*) subctl_tui_teams ;;
      5.*) subctl_tui_service ;;
      6.*) subctl_tui_settings ;;
      7.*) subctl_tui_doctor ;;
      8.*) subctl_tui_logs ;;
      9.*) subctl_tui_about ;;
      q.*|"") clear; return 0 ;;
    esac
  done
}

# ── accounts ─────────────────────────────────────────────────────────────────
subctl_tui_accounts() {
  _subctl_tui_header "Accounts"
  subctl_accounts_status_table
  echo
  local choice
  choice=$(_subctl_tui_choose "Action:" \
    "[a] Add account" \
    "[r] Remove account" \
    "[e] Edit accounts.conf" \
    "[esc] Back")
  case "$choice" in
    \[a\]*)
      local provider alias email
      provider=$(_subctl_tui_choose "Provider:" claude gemini openai)
      alias=$(_subctl_tui_input "Alias (e.g. claude-personal):")
      email=$(_subctl_tui_input "Email:" "you@example.com")
      subctl_accounts_add "$provider" "$alias" "$email"
      _subctl_tui_pause
      ;;
    \[r\]*)
      local rm_alias
      mapfile -t aliases < <(subctl_list_accounts | awk -F'\t' '{print $1}')
      [[ ${#aliases[@]} -eq 0 ]] && { subctl_warn "no accounts"; _subctl_tui_pause; return; }
      rm_alias=$(_subctl_tui_choose "Remove which account?" "${aliases[@]}")
      [[ -n "$rm_alias" ]] && subctl_accounts_remove "$rm_alias"
      _subctl_tui_pause
      ;;
    \[e\]*)
      subctl_accounts_edit
      ;;
    *) ;;
  esac
}

# ── auth ─────────────────────────────────────────────────────────────────────
subctl_tui_auth() {
  _subctl_tui_header "Authentication"
  subctl_accounts_status_table
  echo
  mapfile -t aliases < <(subctl_list_accounts | awk -F'\t' '{print $1}')
  [[ ${#aliases[@]} -eq 0 ]] && { subctl_warn "no accounts — add one first"; _subctl_tui_pause; return; }

  local pick
  pick=$(_subctl_tui_choose "Authenticate which account?" "${aliases[@]}" "[esc] Back")
  case "$pick" in
    \[esc\]*|"") return ;;
    *)
      local provider cfg_dir email
      provider=$(subctl_account_field "$pick" 2)
      cfg_dir=$(subctl_account_field "$pick" 4)
      email=$(subctl_account_field "$pick" 3)
      case "$provider" in
        claude)
          . "$SUBCTL_REPO_ROOT/providers/claude/auth.sh"
          provider_claude_auth "$pick" "$cfg_dir" "$email"
          ;;
        *)
          subctl_warn "$provider provider not yet implemented (phase 2/3)"
          ;;
      esac
      _subctl_tui_pause
      ;;
  esac
}

# ── radar ────────────────────────────────────────────────────────────────────
subctl_tui_radar() {
  _subctl_tui_header "Sessions / radar"
  if [[ -x "$SUBCTL_REPO_ROOT/providers/claude/dispatch-check.sh" ]]; then
    bash "$SUBCTL_REPO_ROOT/providers/claude/dispatch-check.sh"
  fi
  echo
  echo "Recent rate-limit events (last 10):"
  if [[ -f "$SUBCTL_RL_LOG" ]]; then
    tail -10 "$SUBCTL_RL_LOG" | jq -c '{ts, type, session: (.session[0:8])}' 2>/dev/null || tail -10 "$SUBCTL_RL_LOG"
  else
    echo "  (none)"
  fi
  _subctl_tui_pause
}

# ── teams ────────────────────────────────────────────────────────────────────
subctl_tui_teams() {
  _subctl_tui_header "Teams launcher"
  mapfile -t aliases < <(subctl_accounts_by_provider claude | awk -F'\t' '{print $1}')
  [[ ${#aliases[@]} -eq 0 ]] && { subctl_warn "no claude accounts configured"; _subctl_tui_pause; return; }

  local pick
  pick=$(_subctl_tui_choose "Account for this tmux session:" "${aliases[@]}" "[esc] Back")
  [[ "$pick" == "[esc] Back" || -z "$pick" ]] && return

  local opts=()
  _subctl_tui_confirm "Use orchestrator prompt?"          && opts+=("-o")
  _subctl_tui_confirm "Continue last conversation (-c)?"  && opts+=("-c")
  _subctl_tui_confirm "Skip permissions (-y, dangerous)?" && opts+=("-y")

  echo
  echo "Launching: subctl teams claude -a $pick ${opts[*]}"
  echo "(detaching to tmux — Ctrl-b d to leave the session, Ctrl-b ( to switch)"
  sleep 1
  . "$SUBCTL_REPO_ROOT/providers/claude/teams.sh"
  provider_claude_teams -a "$pick" "${opts[@]}"
}

# ── service ──────────────────────────────────────────────────────────────────
subctl_tui_service() {
  _subctl_tui_header "Web service / dashboard"
  subctl_service_status
  echo

  local state
  state=$(subctl_service_state)

  local actions=()
  case "$state" in
    running)
      actions+=("[s] Stop service" "[r] Restart service" "[d] Disable auto-start" \
                "[o] Open dashboard in browser" "[l] View logs (last 50)" "[esc] Back")
      ;;
    stopped)
      actions+=("[s] Start service" "[d] Disable auto-start (uninstall plist)" \
                "[l] View logs (last 50)" "[esc] Back")
      ;;
    not-installed)
      actions+=("[e] Enable (install launchd plist)" \
                "[f] Run dashboard one-shot (foreground)" "[esc] Back")
      ;;
  esac

  local choice
  choice=$(_subctl_tui_choose "Action:" "${actions[@]}")
  case "$choice" in
    \[s\]\ Stop*)    subctl_service_stop;     _subctl_tui_pause ;;
    \[s\]\ Start*)   subctl_service_start;    _subctl_tui_pause ;;
    \[r\]*)          subctl_service_restart;  _subctl_tui_pause ;;
    \[e\]*)          subctl_service_enable;   _subctl_tui_pause ;;
    \[d\]*)          subctl_service_disable;  _subctl_tui_pause ;;
    \[o\]*)          open "http://127.0.0.1:$SUBCTL_SERVICE_PORT" ;;
    \[l\]*)          subctl_service_logs 50;  _subctl_tui_pause ;;
    \[f\]*)          subctl_service_foreground ;;
    *) ;;
  esac
}

# ── settings, doctor, logs, about ────────────────────────────────────────────
subctl_tui_settings() {
  _subctl_tui_header "Settings & config"
  printf "  Repo:           %s\n"  "$SUBCTL_REPO_ROOT"
  printf "  Config dir:     %s\n"  "$SUBCTL_CONFIG_DIR"
  printf "  Accounts file:  %s\n"  "$SUBCTL_ACCOUNTS_CONF"
  printf "  Logs dir:       %s\n"  "$SUBCTL_LOG_DIR"
  printf "  RL events:      %s\n"  "$SUBCTL_RL_LOG"
  echo
  _subctl_tui_pause
}

subctl_tui_doctor() {
  _subctl_tui_header "Doctor / health check"
  bash "$SUBCTL_REPO_ROOT/bin/subctl" doctor
  _subctl_tui_pause
}

subctl_tui_logs() {
  _subctl_tui_header "Logs"
  echo "Service logs:"
  subctl_service_logs 30
  echo
  echo "Recent rate-limit events:"
  if [[ -f "$SUBCTL_RL_LOG" ]]; then
    tail -20 "$SUBCTL_RL_LOG"
  else
    echo "  (none)"
  fi
  _subctl_tui_pause
}

subctl_tui_about() {
  _subctl_tui_header "About"
  cat <<EOF
  subctl — Subscription Central for AI subscriptions you're paying for.

  Version:   $SUBCTL_VERSION
  Repo:      https://github.com/webdevtodayjason/subctl
  License:   MIT

  Built to surface rate-limit signals that built-in /usage doesn't show,
  manage multiple AI subscription accounts on one machine, and provide a
  unified TUI/dashboard surface across providers.

  Phase 1 (v0.1):  Anthropic Claude — full support
  Phase 2 (v0.2):  Google Gemini — planned
  Phase 3 (v0.3):  OpenAI — planned
EOF
  _subctl_tui_pause
}
