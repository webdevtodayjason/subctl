#!/usr/bin/env bash
# lib/setup.sh — first-run setup wizard + reconfigure menu.
#
# Three entry shapes:
#   subctl setup                  Menu (default — pick a stage)
#   subctl setup --wizard         Linear (step 1→5, best for first-time)
#   subctl setup --reconfigure    Linear, but backs up + clears existing config first
#
# Plus convenience flags that jump to one stage:
#   subctl setup --auth-only      Walk OAuth for unauthenticated accounts
#   subctl setup --service-only   Just the dashboard-service prompt
#   subctl setup --check          Run the pre-flight check, no other steps

[[ -n "${_SUBCTL_SETUP_LOADED:-}" ]] && return 0
_SUBCTL_SETUP_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"
. "$(dirname "${BASH_SOURCE[0]}")/accounts.sh"
. "$(dirname "${BASH_SOURCE[0]}")/service.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tui.sh"

# ── deps map: cmd → friendly_name | brew_pkg | required(true|false) ─────────

# Format: cmd|brew_pkg
# Friendly display name = cmd. brew_pkg differs only when the tap path differs
# from the binary name (e.g. bun → oven-sh/bun/bun).

# Required tools — install fails without these.
_setup_required_deps() {
  printf "jq|jq\n"
  printf "git|git\n"
}

# Recommended — features degrade without them but install still works.
_setup_recommended_deps() {
  printf "tmux|tmux\n"
  printf "gum|gum\n"
  printf "bun|oven-sh/bun/bun\n"
  printf "go|go\n"
}

# Try to install one binary via brew. Returns 0 on success, 1 otherwise.
_setup_install_via_brew() {
  local cmd="$1" pkg="$2"
  local friendly="$cmd"

  if command -v "$cmd" >/dev/null 2>&1; then
    return 0  # already there
  fi

  if ! command -v brew >/dev/null 2>&1; then
    subctl_warn "$friendly missing — Homebrew not found, can't auto-install"
    subctl_warn "  install brew first: https://brew.sh"
    return 1
  fi

  subctl_info "installing $friendly via brew ($pkg)..."
  if brew install "$pkg" >/dev/null 2>&1; then
    subctl_ok "$friendly installed"
    return 0
  else
    # Show stderr on failure
    brew install "$pkg" 2>&1 | tail -10
    subctl_err "brew install $pkg failed"
    return 1
  fi
}

# ── stage 1: pre-flight check + auto-install ───────────────────────────────

subctl_setup_preflight() {
  _subctl_tui_header "subctl setup · pre-flight" "Checking required + recommended tools"

  local missing_required=() missing_recommended=()

  while IFS='|' read -r cmd pkg; do
    [[ -z "$cmd" ]] && continue
    if command -v "$cmd" >/dev/null 2>&1; then
      printf "  %s✓%s %-12s %s\n" "$C_GRN" "$C_RST" "$cmd" "$(command -v "$cmd")"
    else
      printf "  %s✗%s %-12s missing (REQUIRED)\n" "$C_RED" "$C_RST" "$cmd"
      missing_required+=("$cmd|$pkg")
    fi
  done < <(_setup_required_deps)

  echo
  while IFS='|' read -r cmd pkg; do
    [[ -z "$cmd" ]] && continue
    if command -v "$cmd" >/dev/null 2>&1; then
      printf "  %s✓%s %-12s %s\n" "$C_GRN" "$C_RST" "$cmd" "$(command -v "$cmd")"
    else
      printf "  %s-%s %-12s not installed (optional, some features unavailable)\n" "$C_DIM" "$C_RST" "$cmd"
      missing_recommended+=("$cmd|$pkg")
    fi
  done < <(_setup_recommended_deps)

  echo
  if [[ ${#missing_required[@]} -gt 0 ]]; then
    subctl_warn "Required tools missing: ${#missing_required[@]}"
    if _subctl_tui_confirm "Install them now via brew?"; then
      for entry in "${missing_required[@]}"; do
        IFS='|' read -r cmd pkg <<< "$entry"
        _setup_install_via_brew "$cmd" "$pkg" || subctl_die "$cmd is required to continue"
      done
    else
      subctl_die "Cannot continue without required tools."
    fi
  fi

  if [[ ${#missing_recommended[@]} -gt 0 ]]; then
    echo
    subctl_info "${#missing_recommended[@]} recommended tool(s) missing — these unlock features:"
    for entry in "${missing_recommended[@]}"; do
      IFS='|' read -r cmd pkg <<< "$entry"
      case "$cmd" in
        tmux) printf "  - %-8s claude-teams launcher (REQUIRED for that feature)\n" "$cmd" ;;
        gum)  printf "  - %-8s polished TUI prompts (this wizard works without it)\n" "$cmd" ;;
        bun)  printf "  - %-8s dashboard web service\n" "$cmd" ;;
        go)   printf "  - %-8s deck (Go TUI session manager)\n" "$cmd" ;;
      esac
    done
    echo
    if _subctl_tui_confirm "Install the missing recommended tools via brew?"; then
      for entry in "${missing_recommended[@]}"; do
        IFS='|' read -r cmd pkg <<< "$entry"
        _setup_install_via_brew "$cmd" "$pkg" || true
      done
    else
      subctl_info "OK, skipping. Re-run \`subctl setup --check\` to revisit."
    fi
  fi

  echo
  subctl_ok "pre-flight done"
  return 0
}

# ── stage 2: detect existing config ────────────────────────────────────────

subctl_setup_detect_config() {
  _subctl_tui_header "subctl setup · existing config" "Detecting existing accounts and tools"

  subctl_ensure_config_dir

  local n_accounts
  n_accounts=$(subctl_list_accounts 2>/dev/null | wc -l | tr -d ' ')

  echo
  printf "  Accounts file: %s\n" "$SUBCTL_ACCOUNTS_CONF"
  printf "  Account count: %d\n" "$n_accounts"

  if [[ "$n_accounts" -gt 0 ]]; then
    echo
    subctl_accounts_status_table
    echo
  fi

  # Detect prior installs
  local found_old=()
  [[ -L "$HOME/.claude-multi-account" ]] && found_old+=("claude-multi-account → $(readlink "$HOME/.claude-multi-account")")
  [[ -d "/usr/local/bin" ]] && [[ -f "/usr/local/bin/claude-teams" ]] && \
    grep -q -v 'subctl teams claude' "/usr/local/bin/claude-teams" 2>/dev/null && \
    found_old+=("claude-teams (pre-subctl version) at /usr/local/bin/claude-teams")

  if [[ ${#found_old[@]} -gt 0 ]]; then
    echo
    subctl_warn "Detected legacy artifacts:"
    for a in "${found_old[@]}"; do printf "    - %s\n" "$a"; done
    echo "  Run \`./install.sh --migrate\` to import + replace."
  fi

  echo
}

# ── stage 3: add account ────────────────────────────────────────────────────

subctl_setup_add_account() {
  _subctl_tui_header "subctl setup · add account"

  local provider alias email cfg_dir desc
  provider=$(_subctl_tui_choose "Provider:" claude gemini openai)
  [[ -z "$provider" || "$provider" == "[esc] Back" ]] && return 0

  alias=$(_subctl_tui_input "Alias (e.g. claude-personal, claude-work):" "${provider}-personal")
  [[ -z "$alias" ]] && { subctl_warn "alias required"; return 1; }

  email=$(_subctl_tui_input "Email for this account:" "you@example.com")
  [[ -z "$email" ]] && { subctl_warn "email required"; return 1; }

  cfg_dir="~/.${provider}-${alias#${provider}-}"
  desc="$provider account"

  subctl_accounts_add "$provider" "$alias" "$email" "$cfg_dir" "$desc"
  return $?
}

subctl_setup_add_accounts_loop() {
  _subctl_tui_header "subctl setup · accounts" "Add as many accounts as you have subscriptions for"

  while true; do
    if [[ "$(subctl_list_accounts | wc -l | tr -d ' ')" -gt 0 ]]; then
      echo
      subctl_accounts_status_table
      echo
    fi

    if ! _subctl_tui_confirm "Add an account now?"; then
      break
    fi
    subctl_setup_add_account || true
  done
}

# ── stage 4: walk OAuth for unauthenticated ────────────────────────────────

subctl_setup_walk_auth() {
  _subctl_tui_header "subctl setup · authenticate" "OAuth walk-through for accounts that need it"

  local rows=()
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "claude" ]] && continue
    local status
    status=$(subctl_auth_status "$cfg_dir")
    if [[ "$status" != "ready" ]]; then
      rows+=("$alias|$cfg_dir|$email")
    fi
  done < <(subctl_list_accounts)

  if [[ ${#rows[@]} -eq 0 ]]; then
    subctl_ok "All claude accounts already authenticated."
    return 0
  fi

  echo "${#rows[@]} account(s) need OAuth:"
  for r in "${rows[@]}"; do
    IFS='|' read -r a c e <<< "$r"
    printf "  - %-20s %s\n" "$a" "$e"
  done
  echo

  local mode
  mode=$(_subctl_tui_choose "Walk through which?" \
    "all unauthenticated" \
    "let me pick" \
    "skip — I'll auth later with subctl auth claude <alias>")

  case "$mode" in
    "all unauthenticated")
      . "$SUBCTL_REPO_ROOT/providers/claude/auth.sh"
      for r in "${rows[@]}"; do
        IFS='|' read -r a c e <<< "$r"
        provider_claude_auth "$a" "$c" "$e"
      done
      ;;
    "let me pick")
      . "$SUBCTL_REPO_ROOT/providers/claude/auth.sh"
      local choices=()
      for r in "${rows[@]}"; do
        IFS='|' read -r a c e <<< "$r"
        choices+=("$a")
      done
      choices+=("[esc] done")
      while true; do
        local pick
        pick=$(_subctl_tui_choose "Account to auth:" "${choices[@]}")
        [[ "$pick" == "[esc] done" || -z "$pick" ]] && break
        for r in "${rows[@]}"; do
          IFS='|' read -r a c e <<< "$r"
          if [[ "$a" == "$pick" ]]; then
            provider_claude_auth "$a" "$c" "$e"
            break
          fi
        done
      done
      ;;
    *)
      subctl_info "skipping — auth later with: subctl auth claude <alias>"
      ;;
  esac
}

# ── stage 5: dashboard service ─────────────────────────────────────────────

subctl_setup_service() {
  _subctl_tui_header "subctl setup · dashboard service" "Web dashboard at http://127.0.0.1:8787"

  if ! command -v bun >/dev/null 2>&1; then
    subctl_warn "bun is not installed — dashboard service can't run yet."
    subctl_info "install: brew install oven-sh/bun/bun  (then re-run subctl setup --service-only)"
    return 0
  fi

  echo
  subctl_service_status
  echo

  local state
  state=$(subctl_service_state)

  case "$state" in
    running)
      if _subctl_tui_confirm "Service is running. Disable auto-start?"; then
        subctl_service_disable
      fi
      ;;
    stopped|not-installed)
      if _subctl_tui_confirm "Enable launchd service (auto-start at login, http://127.0.0.1:8787)?"; then
        subctl_service_enable
      else
        subctl_info "skipping — start manually with: subctl service start"
      fi
      ;;
  esac
}

# ── final summary ──────────────────────────────────────────────────────────

subctl_setup_summary() {
  _subctl_tui_header "subctl setup · done" "Quick reference for what to do next"
  cat <<EOF

  Try one of these:

    subctl                         Open the TUI menu
    subctl doctor                  Full health check
    claude-teams -a <alias> -o -y  Start an orchestrator session
    claude-resume                  Pick + resume a past session
    claude-radar                   Pre-dispatch verdict
    claude-dash                    Open the web dashboard

  Cheat sheet:
    http://127.0.0.1:8787/cheat    (if dashboard is running)
    https://github.com/webdevtodayjason/subctl#commands

EOF
  _subctl_tui_pause
}

# ── orchestrators ──────────────────────────────────────────────────────────

# Wizard mode — linear walk of all stages.
subctl_setup_wizard() {
  subctl_setup_preflight
  subctl_setup_detect_config
  subctl_setup_add_accounts_loop
  subctl_setup_walk_auth
  subctl_setup_service
  subctl_setup_summary
}

# Reconfigure — back up current config + run the wizard fresh.
subctl_setup_reconfigure() {
  if [[ -f "$SUBCTL_ACCOUNTS_CONF" ]]; then
    local backup="$SUBCTL_ACCOUNTS_CONF.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$SUBCTL_ACCOUNTS_CONF" "$backup"
    subctl_info "backed up accounts.conf → $backup"
    if _subctl_tui_confirm "Clear existing accounts.conf and start fresh?"; then
      cp "$SUBCTL_REPO_ROOT/config/accounts.conf.example" "$SUBCTL_ACCOUNTS_CONF"
      subctl_ok "reset accounts.conf to example template"
    fi
  fi
  subctl_setup_wizard
}

# Menu — pick which stage to run.
subctl_setup_menu() {
  while true; do
    _subctl_tui_header "subctl setup" "Pick a stage (or run --wizard for a linear walk)"
    local choice
    choice=$(_subctl_tui_choose "Stage:" \
      "1. Pre-flight check + install missing tools" \
      "2. Detect existing config" \
      "3. Add accounts" \
      "4. Authenticate accounts" \
      "5. Dashboard service" \
      "6. Run full wizard (1 → 5)" \
      "7. Reconfigure (back up + start fresh)" \
      "q. Quit")
    case "$choice" in
      1.*) subctl_setup_preflight; _subctl_tui_pause ;;
      2.*) subctl_setup_detect_config; _subctl_tui_pause ;;
      3.*) subctl_setup_add_accounts_loop ;;
      4.*) subctl_setup_walk_auth; _subctl_tui_pause ;;
      5.*) subctl_setup_service; _subctl_tui_pause ;;
      6.*) subctl_setup_wizard; return 0 ;;
      7.*) subctl_setup_reconfigure; return 0 ;;
      q.*|"") clear; return 0 ;;
    esac
  done
}

# Entry point dispatched by `subctl setup`.
subctl_setup() {
  local mode="menu"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wizard)        mode="wizard"; shift ;;
      --reconfigure)   mode="reconfigure"; shift ;;
      --auth-only)     mode="auth"; shift ;;
      --service-only)  mode="service"; shift ;;
      --check)         mode="check"; shift ;;
      -h|--help)
        cat <<EOF
subctl setup [mode]

  No flag         → menu (pick a stage)
  --wizard        → linear walk (best for first-time setup)
  --reconfigure   → back up + clear accounts.conf, then wizard
  --auth-only     → just walk OAuth for unauthenticated accounts
  --service-only  → just the dashboard service prompt
  --check         → just pre-flight (tool availability)
EOF
        return 0 ;;
      *) subctl_die "unknown setup flag: $1" ;;
    esac
  done

  case "$mode" in
    menu)         subctl_setup_menu ;;
    wizard)       subctl_setup_wizard ;;
    reconfigure)  subctl_setup_reconfigure ;;
    auth)         subctl_setup_walk_auth ;;
    service)      subctl_setup_service ;;
    check)        subctl_setup_preflight ;;
  esac
}
