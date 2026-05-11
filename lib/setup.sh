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

# ── canonical dep manifest reader ──────────────────────────────────────────
# Single source of truth: lib/dep-manifest.json. Consumed here, by install.sh,
# by `subctl doctor`, and by the dashboard's /api/settings/install-checks.

SUBCTL_DEP_MANIFEST="${SUBCTL_DEP_MANIFEST:-$SUBCTL_REPO_ROOT/lib/dep-manifest.json}"

_subctl_setup_manifest_field() {
  jq -r --arg id "$1" --arg f "$2" '.deps[] | select(.id==$id) | .[$f] // empty' "$SUBCTL_DEP_MANIFEST"
}

_subctl_setup_manifest_ids_by_tier() {
  jq -r --arg t "$1" '.deps[] | select(.tier==$t) | .id' "$SUBCTL_DEP_MANIFEST"
}

# Detect a single dep by running its detect argv (PATH first, then fallbacks).
_subctl_setup_dep_detect() {
  local id="$1" argv_str fp rest
  argv_str=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .detect | @sh' "$SUBCTL_DEP_MANIFEST")
  [[ -z "$argv_str" ]] && return 1
  if eval "$argv_str" >/dev/null 2>&1; then return 0; fi
  while IFS= read -r fp; do
    [[ -z "$fp" ]] && continue
    eval "fp=\"$fp\""
    [[ -e "$fp" ]] || continue
    rest=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .detect[1:] | @sh' "$SUBCTL_DEP_MANIFEST")
    if eval "\"\$fp\" $rest" >/dev/null 2>&1; then return 0; fi
  done < <(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .fallback_paths[]?' "$SUBCTL_DEP_MANIFEST")
  return 1
}

# Try to install one brew dep by manifest id. Used for the wizard's "install
# missing recommended tools" pass. Auto-install + manual deps are out of scope
# here — install.sh owns the full install matrix.
_subctl_setup_brew_install() {
  local id="$1" name method cmd
  name=$(_subctl_setup_manifest_field "$id" "name")
  method=$(_subctl_setup_manifest_field "$id" "install_method")
  cmd=$(_subctl_setup_manifest_field "$id" "install_cmd")

  if _subctl_setup_dep_detect "$id"; then return 0; fi

  if [[ "$method" != "brew" && "$method" != "brew-cask" ]]; then
    subctl_warn "$name install method is '$method' — run install.sh for the full installer"
    return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    subctl_warn "$name missing — Homebrew not found, can't auto-install"
    subctl_warn "  bootstrap brew first: bash $SUBCTL_REPO_ROOT/install.sh"
    return 1
  fi

  subctl_info "installing $name via $cmd ..."
  if eval "$cmd" >/dev/null 2>&1; then
    subctl_ok "$name installed"
    return 0
  else
    eval "$cmd" 2>&1 | tail -10
    subctl_err "install failed: $cmd"
    return 1
  fi
}

# ── stage 1: pre-flight check + auto-install ───────────────────────────────

subctl_setup_preflight() {
  _subctl_tui_header "subctl setup · pre-flight" "Reading $SUBCTL_DEP_MANIFEST"

  if ! command -v jq >/dev/null 2>&1; then
    subctl_die "jq required to read manifest — bootstrap with: bash $SUBCTL_REPO_ROOT/install.sh"
  fi
  [[ -f "$SUBCTL_DEP_MANIFEST" ]] || subctl_die "manifest not found: $SUBCTL_DEP_MANIFEST"

  local id name tier missing_hard=() missing_soft=()
  printf "  %-22s %-6s %s\n" "name" "tier" "status"
  while IFS= read -r id; do
    name=$(_subctl_setup_manifest_field "$id" "name")
    tier=$(_subctl_setup_manifest_field "$id" "tier")
    if _subctl_setup_dep_detect "$id"; then
      printf "  ${C_GRN}✓${C_RST} %-20s %-6s present\n" "$name" "$tier"
    else
      if [[ "$tier" == "hard" ]]; then
        printf "  ${C_RED}✗${C_RST} %-20s %-6s missing (HARD)\n" "$name" "$tier"
        missing_hard+=("$id")
      else
        printf "  ${C_DIM}-${C_RST} %-20s %-6s missing (soft)\n" "$name" "$tier"
        missing_soft+=("$id")
      fi
    fi
  done < <(jq -r '.deps[].id' "$SUBCTL_DEP_MANIFEST")

  echo
  if [[ ${#missing_hard[@]} -gt 0 ]]; then
    subctl_warn "${#missing_hard[@]} hard dep(s) missing"
    subctl_info "Run the full installer to handle them: bash $SUBCTL_REPO_ROOT/install.sh"
    if _subctl_tui_confirm "Attempt brew-only install of missing hard deps now?"; then
      local id
      for id in "${missing_hard[@]}"; do
        _subctl_setup_brew_install "$id" || true
      done
    fi
  fi

  if [[ ${#missing_soft[@]} -gt 0 ]]; then
    echo
    subctl_info "${#missing_soft[@]} soft dep(s) missing — install for full feature set"
    if _subctl_tui_confirm "Try brew install for the brew-installable subset?"; then
      local id
      for id in "${missing_soft[@]}"; do
        _subctl_setup_brew_install "$id" || true
      done
    else
      subctl_info "OK, skipping. Re-run \`subctl setup --check\` to revisit."
    fi
  fi

  echo
  subctl_ok "pre-flight done"
  return 0
}

# ── BotFather walkthrough wrapper (delegates to install.sh) ─────────────────
# Callable as `subctl setup --botfather`. install.sh hosts the actual
# walkthrough function so install.sh can offer it standalone too.
subctl_setup_botfather() {
  bash "$SUBCTL_REPO_ROOT/install.sh" --botfather
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
      --botfather)     mode="botfather"; shift ;;
      -h|--help)
        cat <<EOF
subctl setup [mode]

  No flag         → menu (pick a stage)
  --wizard        → linear walk (best for first-time setup)
  --reconfigure   → back up + clear accounts.conf, then wizard
  --auth-only     → just walk OAuth for unauthenticated accounts
  --service-only  → just the dashboard service prompt
  --check         → just pre-flight (tool availability)
  --botfather     → run the Telegram BotFather walkthrough
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
    botfather)    subctl_setup_botfather ;;
  esac
}
