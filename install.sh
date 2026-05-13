#!/usr/bin/env bash
# subctl/install.sh — pre-install dep orchestrator + component installer.
#
# Usage:
#   ./install.sh                          Interactive install (preflight → install → verify → wire)
#   ./install.sh --check-only             Preflight + verify only; no installs, no component wiring
#   ./install.sh --skip-deps              Skip dep phase; jump straight to component wiring
#   ./install.sh --yes / -y               Assume yes to every confirm (non-interactive auto-install)
#   ./install.sh --allow-missing-hard     Don't abort if a hard dep is missing after install phase
#   ./install.sh --botfather              Run only the BotFather Telegram walkthrough + exit
#   ./install.sh --migrate                Detect + migrate from prior installs
#   ./install.sh --no-shell-rewrite       Skip touching ~/.zshrc
#   ./install.sh --no-service             Skip launchd dashboard service install
#   ./install.sh --dry-run                Show what would happen
#   ./install.sh --uninstall              (delegates to uninstall.sh)
#
# Reads canonical dep manifest from lib/dep-manifest.json — single source of
# truth shared with lib/setup.sh, bin/subctl doctor, dashboard install-checks.
#
# Honors operator decisions (locked 2026-05-10):
#   - GUI: Docker → cask install (confirm); LM Studio + Obsidian → detect-only + manual link
#   - Homebrew: auto-bootstrap if missing (confirm + ~2min)
#   - Bun: BUN_INSTALL_NO_PROFILE=1; subctl's ~/.zshrc alias block owns the PATH
#   - LM Studio default model: post-detect, offer `lms get qwen/qwen3.6-35b-a3b` (~20GB, Y/n)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$REPO_ROOT/lib/core.sh"

MANIFEST="$REPO_ROOT/lib/dep-manifest.json"

# ── flags ────────────────────────────────────────────────────────────────────
DO_MIGRATE=false
NO_SHELL=false
NO_SERVICE=false
DRY_RUN=false
CHECK_ONLY=false
ASSUME_YES=false
ALLOW_MISSING_HARD=false
SKIP_DEPS=false
ONLY_BOTFATHER=false

for arg in "$@"; do
  case "$arg" in
    --migrate)               DO_MIGRATE=true ;;
    --no-shell-rewrite)      NO_SHELL=true ;;
    --no-service)            NO_SERVICE=true ;;
    --dry-run)               DRY_RUN=true ;;
    --check-only|--check)    CHECK_ONLY=true ;;
    --skip-deps)             SKIP_DEPS=true ;;
    --yes|-y)                ASSUME_YES=true ;;
    --allow-missing-hard)    ALLOW_MISSING_HARD=true ;;
    --botfather)             ONLY_BOTFATHER=true ;;
    --uninstall)             exec bash "$REPO_ROOT/uninstall.sh" ;;
    -h|--help)
      sed -n '2,21p' "$0"; exit 0 ;;
    *) subctl_err "unknown arg: $arg"; exit 1 ;;
  esac
done

run() { $DRY_RUN && echo "[dry-run] $*" || eval "$@"; }

# ── jq is the manifest reader; bootstrap it before we can read the manifest ──
_bootstrap_jq() {
  if command -v jq >/dev/null 2>&1; then return 0; fi
  subctl_warn "jq missing — required to read $MANIFEST"
  if command -v brew >/dev/null 2>&1; then
    if $ASSUME_YES || _confirm "Install jq via Homebrew now?" "Y"; then
      run brew install jq || subctl_die "brew install jq failed"
    else
      subctl_die "Cannot continue without jq."
    fi
  else
    subctl_die "Install Homebrew first (https://brew.sh) or install jq manually, then re-run."
  fi
}

# ── small helpers ────────────────────────────────────────────────────────────
_confirm() {
  # _confirm "Question?" "Y"|"N"  → returns 0 for yes, 1 for no
  local q="$1" def="${2:-Y}" reply prompt
  if $ASSUME_YES; then return 0; fi
  if [[ "$def" == "Y" ]]; then prompt="[Y/n]"; else prompt="[y/N]"; fi
  read -r -p "$q $prompt: " reply || reply=""
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$reply" ]]; then [[ "$def" == "Y" ]]; return $?; fi
  case "$reply" in
    y|yes) return 0 ;;
    *)     return 1 ;;
  esac
}

# Expand $HOME / ${VAR:-default} in a manifest path string
_expand_path() {
  local p="$1"
  # shellcheck disable=SC2016
  eval "printf '%s' \"$p\""
}

# Run the detect argv from manifest; returns 0 if detected (PATH or fallback)
_dep_detect() {
  local id="$1"
  local detect_json fallback_json argv_str fp
  detect_json=$(jq -c --arg id "$id" '.deps[] | select(.id==$id) | .detect' "$MANIFEST")
  [[ -z "$detect_json" || "$detect_json" == "null" ]] && return 1

  # Build a quoted argv string from JSON array via @sh
  argv_str=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .detect | @sh' "$MANIFEST")
  if eval "$argv_str" >/dev/null 2>&1; then
    return 0
  fi

  # Probe explicit fallback_paths (binary-only — substitute argv[0] then re-run)
  fallback_json=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .fallback_paths[]?' "$MANIFEST")
  if [[ -n "$fallback_json" ]]; then
    while IFS= read -r fp; do
      [[ -z "$fp" ]] && continue
      fp=$(_expand_path "$fp")
      [[ -e "$fp" ]] || continue
      # Re-run detect with binary swapped to fp
      local rest_json
      rest_json=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .detect[1:] | @sh' "$MANIFEST")
      if eval "\"\$fp\" $rest_json" >/dev/null 2>&1; then
        return 0
      fi
    done <<< "$fallback_json"
  fi
  return 1
}

# Best-effort version extractor (from detect cmd's stdout, first semver-ish run)
_dep_version() {
  local id="$1" out
  local argv_str
  argv_str=$(jq -r --arg id "$id" '.deps[] | select(.id==$id) | .detect | @sh' "$MANIFEST")
  out=$(eval "$argv_str" 2>/dev/null | head -3)
  # Strip ANSI + look for x.y[.z]
  out=$(printf '%s' "$out" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g')
  printf '%s' "$out" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

_dep_field() {
  jq -r --arg id "$1" --arg f "$2" '.deps[] | select(.id==$id) | .[$f] // empty' "$MANIFEST"
}

_dep_ids() {
  jq -r '.deps[].id' "$MANIFEST"
}

# ── status table (preflight + verify share this) ─────────────────────────────
print_status_table() {
  local title="$1"
  local id name tier method ok ver want_min mark color
  local hard_total=0 hard_ok=0 soft_total=0 soft_ok=0

  printf "\n%s%s%s\n" "$C_BLD" "$title" "$C_RST"
  printf "  %-22s %-6s %-10s %-22s %s\n" "name" "tier" "status" "version" "install"
  printf "  %-22s %-6s %-10s %-22s %s\n" "----" "----" "------" "-------" "-------"

  while IFS= read -r id; do
    name=$(_dep_field "$id" "name")
    tier=$(_dep_field "$id" "tier")
    method=$(_dep_field "$id" "install_method")
    want_min=$(_dep_field "$id" "version_min")

    if _dep_detect "$id"; then
      ok=true
      ver=$(_dep_version "$id" 2>/dev/null)
      [[ -z "$ver" ]] && ver="present"
      mark="${C_GRN}✓${C_RST}"
      color=""
    else
      ok=false
      ver="not installed"
      if [[ "$tier" == "hard" ]]; then
        mark="${C_RED}✗${C_RST}"
      else
        mark="${C_YLW}⚠${C_RST}"
      fi
    fi

    if [[ "$tier" == "hard" ]]; then
      hard_total=$((hard_total + 1))
      $ok && hard_ok=$((hard_ok + 1))
    else
      soft_total=$((soft_total + 1))
      $ok && soft_ok=$((soft_ok + 1))
    fi

    printf "  %s %-20s %-6s %-10s %-22s %s\n" "$mark" "$name" "$tier" "$( $ok && echo OK || echo missing )" "$ver" "$method"
  done < <(_dep_ids)

  printf "\n  hard: %d/%d   soft: %d/%d\n" "$hard_ok" "$hard_total" "$soft_ok" "$soft_total"

  # Stash counts for callers (Verify uses them for go/no-go)
  PRE_HARD_OK=$hard_ok
  PRE_HARD_TOTAL=$hard_total
  PRE_SOFT_OK=$soft_ok
  PRE_SOFT_TOTAL=$soft_total
}

# ── BotFather walkthrough (callable standalone via --botfather) ──────────────
run_botfather_walkthrough() {
  local cfg_dir="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}"
  local notify="$cfg_dir/master-notify.json"

  echo
  printf "%s== Telegram BotFather walkthrough ==%s\n" "$C_BLD" "$C_RST"
  echo
  if [[ -f "$notify" ]]; then
    subctl_ok "master-notify.json already exists at $notify"
    if ! _confirm "Overwrite with new credentials?" "N"; then
      subctl_info "leaving existing config in place"
      return 0
    fi
  fi

  cat <<'EOF'
subctl master uses a SEPARATE Telegram bot from `subctl notify` (the worker-
escalation bot). Walk through these steps in another window:

  1. Open Telegram and message @BotFather: https://t.me/BotFather
  2. Send /newbot, pick a name + username for THIS master bot.
     (Don't reuse the token from ~/.config/subctl/notify.json — only one
      getUpdates poller is allowed per bot.)
  3. BotFather replies with a token like 1234567890:AAEhBP...
  4. Open a chat with your new bot, send /start, then visit:
       https://api.telegram.org/bot<TOKEN>/getUpdates
     Look for "chat":{"id":<NUMBER>} — that's your chat_id.

When you have the token + chat_id, paste them below.

EOF

  if $ASSUME_YES; then
    subctl_warn "--yes mode: skipping interactive prompts (cannot type a token unattended)"
    subctl_info "Re-run without --yes to enter token + chat_id, or write $notify by hand."
    return 0
  fi

  local token chat_id
  read -r -p "Telegram bot token: " token
  read -r -p "Telegram chat_id:   " chat_id

  if [[ -z "$token" || -z "$chat_id" ]]; then
    subctl_warn "token or chat_id empty — aborting walkthrough"
    return 1
  fi

  mkdir -p "$cfg_dir"
  cat > "$notify" <<JSON
{
  "telegram_bot_token": "$token",
  "telegram_chat_id":   "$chat_id"
}
JSON
  chmod 600 "$notify"
  subctl_ok "wrote $notify (chmod 600)"
  subctl_info "you can now run: subctl master enable"
}

# ── install one dep ──────────────────────────────────────────────────────────
install_dep() {
  local id="$1"
  local name tier method cmd auto dna manual_url hint
  name=$(_dep_field "$id" "name")
  tier=$(_dep_field "$id" "tier")
  method=$(_dep_field "$id" "install_method")
  cmd=$(_dep_field "$id" "install_cmd")
  auto=$(_dep_field "$id" "auto_install")
  dna=$(_dep_field "$id" "do_not_auto_install")
  manual_url=$(_dep_field "$id" "manual_url")
  hint=$(_dep_field "$id" "post_install_hint")

  # 1. Already present? Short-circuit.
  if _dep_detect "$id"; then
    subctl_ok "$name — already installed"
    return 0
  fi

  # 2. Detect-only (LM Studio, Obsidian, Context7) — never auto-install
  if [[ "$dna" == "true" ]]; then
    if [[ "$tier" == "hard" ]]; then
      subctl_err "$name missing (HARD, manual install required)"
    else
      subctl_warn "$name missing (soft, manual install)"
    fi
    [[ -n "$manual_url" ]] && printf "    install: %s\n" "$manual_url"
    [[ -n "$cmd" ]]        && printf "    steps:   %s\n" "$cmd"
    return 0
  fi

  # 3. Walkthrough deps (Telegram bot)
  if [[ "$method" == "walkthrough" ]]; then
    if [[ "$id" == "telegram-bot" ]]; then
      if _confirm "Run BotFather walkthrough now to set up master-notify.json?" "Y"; then
        run_botfather_walkthrough
      else
        subctl_info "skipping — run later with: bash install.sh --botfather"
      fi
    fi
    return 0
  fi

  # 4. Auto-install (with confirm unless --yes)
  if [[ "$auto" != "true" ]]; then
    subctl_warn "$name missing — no auto-install path. See: $cmd"
    return 0
  fi

  local prompt_str default
  if [[ "$tier" == "hard" ]]; then default="Y"; else default="Y"; fi
  prompt_str="Install $name now? (method: $method)"
  if ! _confirm "$prompt_str" "$default"; then
    if [[ "$tier" == "hard" ]] && ! $ALLOW_MISSING_HARD; then
      subctl_warn "$name (HARD) skipped — re-run installer or use --allow-missing-hard"
    else
      subctl_info "$name skipped"
    fi
    return 0
  fi

  subctl_info "installing $name via $method"
  case "$method" in
    homebrew-bootstrap)
      run "$cmd"
      ;;
    brew)
      # Strip the leading "brew install" so we can pipe through run
      run "brew install $(printf '%s' "$cmd" | sed -E 's/^brew install //')"
      ;;
    brew-cask)
      run "$cmd"
      ;;
    curl)
      run "$cmd"
      ;;
    npm)
      run "$cmd"
      ;;
    npx)
      run "$cmd"
      ;;
    builtin|preinstalled)
      subctl_warn "$name is supposed to be present from a parent dep — install ${cmd}"
      ;;
    *)
      subctl_warn "unknown install method: $method (cmd: $cmd)"
      ;;
  esac

  # 5. Verify install
  if _dep_detect "$id"; then
    subctl_ok "$name installed"
    [[ -n "$hint" ]] && printf "    %s\n" "$hint"
    return 0
  fi

  if [[ "$tier" == "hard" ]] && ! $ALLOW_MISSING_HARD; then
    subctl_err "$name install attempted but still not detected"
    return 1
  fi
  subctl_warn "$name install completed but not yet detected (may need PATH refresh)"
  return 0
}

# ── install order: topological — homebrew → runtimes → CLIs → GUIs ──────────
INSTALL_ORDER=(
  homebrew
  jq
  git
  tmux
  gh
  gum
  go
  node
  npm
  bun
  claude
  codex
  coderabbit
  docker
  obsidian
  lm-studio
  lms
  claude-mem
  telegram-bot
  context7-key
)

# ── Phase B: install ─────────────────────────────────────────────────────────
phase_install() {
  printf "\n%s== Phase 2/3 — install ==%s\n" "$C_BLD" "$C_RST"
  local id any_failed=0
  for id in "${INSTALL_ORDER[@]}"; do
    install_dep "$id" || any_failed=1
  done

  # Optional model pull after LM Studio + lms detected
  if _dep_detect "lm-studio" && _dep_detect "lms"; then
    echo
    printf "%sLM Studio + lms detected.%s subctl's default master supervisor is\n" "$C_BLD" "$C_RST"
    printf "  qwen/qwen3.6-35b-a3b (~20 GB download).\n"
    if _confirm "Pull the default supervisor model now via lms?" "Y"; then
      run "lms get qwen/qwen3.6-35b-a3b" \
        && subctl_ok "qwen3.6-35b-a3b ready" \
        || subctl_warn "lms get failed — pull manually later: lms get qwen/qwen3.6-35b-a3b"
    else
      subctl_info "skipped — pull later: lms get qwen/qwen3.6-35b-a3b"
    fi
  fi

  return $any_failed
}

# ── Phase C: verify ──────────────────────────────────────────────────────────
phase_verify() {
  print_status_table "== Phase 3/3 — verify =="
  echo
  if (( PRE_HARD_OK == PRE_HARD_TOTAL )); then
    subctl_ok "all $PRE_HARD_TOTAL hard deps present"
  else
    local missing=$((PRE_HARD_TOTAL - PRE_HARD_OK))
    if $ALLOW_MISSING_HARD; then
      subctl_warn "$missing hard dep(s) still missing — proceeding (--allow-missing-hard)"
    else
      subctl_err "$missing hard dep(s) still missing. Re-run install or use --allow-missing-hard."
      return 1
    fi
  fi
  if (( PRE_SOFT_OK < PRE_SOFT_TOTAL )); then
    subctl_info "$((PRE_SOFT_TOTAL - PRE_SOFT_OK)) soft dep(s) skipped — install later if you need those features"
  fi
  return 0
}

# ── Phase A: preflight ───────────────────────────────────────────────────────
phase_preflight() {
  print_status_table "== Phase 1/3 — preflight =="
}

# ── component install (legacy steps from old install.sh — Claude wiring etc) ─
component_install() {
  printf "\n%s== Component install ==%s\n" "$C_BLD" "$C_RST"

  # config dir
  subctl_info "config"
  run subctl_ensure_config_dir

  # migrate (optional)
  if $DO_MIGRATE; then
    subctl_info "detecting prior installs"
    . "$REPO_ROOT/lib/migrate.sh"
    subctl_migrate_detect || true
    echo
    subctl_migrate_import_accounts
  fi

  # symlink shims
  #
  # v2.7.32 — Fallback target changed from $HOME/bin to $HOME/.local/bin (XDG
  # standard). `~/.local/bin` is auto-added to PATH by recent macOS / zsh /
  # GNOME shells; `~/bin` only worked if the operator's dotfiles already
  # exported it. After install we also emit a PATH-status line so the
  # operator can tell at a glance whether the target dir is reachable from
  # their current shell.
  subctl_info "linking subctl CLI + shorthand shims"
  local shims=(subctl claude-teams claude-radar claude-dash claude-deck claude-kill claude-resume)
  local sys_bin="/usr/local/bin"
  local user_bin="$HOME/.local/bin"
  local target_bin
  if [[ -w "$sys_bin" ]]; then
    target_bin="$sys_bin"
  else
    run mkdir -p "$user_bin"
    target_bin="$user_bin"
    subctl_warn "$sys_bin not writable (would require sudo) — linking into $user_bin instead"
  fi
  local shim src dst backup
  for shim in "${shims[@]}"; do
    src="$REPO_ROOT/bin/$shim"
    dst="$target_bin/$shim"
    if [[ -f "$dst" && ! -L "$dst" ]]; then
      backup="$HOME/code/${shim}.pre-subctl.$(date +%Y%m%d-%H%M%S).bak"
      run cp "$dst" "$backup"
      subctl_info "backed up existing $dst → $backup"
    fi
    run ln -sfn "$src" "$dst"
    subctl_ok "$shim → $dst"
  done
  run ln -sfn "$REPO_ROOT" "$HOME/.subctl"

  # PATH probe — only matters when we fell back to $HOME/.local/bin. We use
  # `case` against $PATH because `command -v subctl` would pick up the
  # symlink we just wrote even if PATH doesn't include the target dir
  # (subprocess PATH inheritance vs current shell's PATH lookup), giving a
  # false-OK signal.
  if [[ "$target_bin" == "$user_bin" ]]; then
    case ":$PATH:" in
      *":$user_bin:"*)
        subctl_ok "$user_bin is already on PATH"
        ;;
      *)
        subctl_warn "$user_bin is NOT on PATH — subctl won't be found in this shell."
        subctl_warn "  Add to ~/.zshrc (zsh) or ~/.bashrc (bash):"
        subctl_warn "    export PATH=\"\$HOME/.local/bin:\$PATH\""
        subctl_warn "  Then: source ~/.zshrc (or open a new shell)"
        ;;
    esac
  fi

  # claude wiring
  subctl_info "wiring Claude statusline + hook + slash command"
  . "$REPO_ROOT/lib/settings.sh"
  $DRY_RUN || subctl_settings_install_claude

  subctl_info "applying autonomy patches to settings.json (per-account)"
  $DRY_RUN || subctl_settings_apply_autonomy_all

  subctl_info "linking autonomy skill into ~/.claude/skills/"
  $DRY_RUN || subctl_settings_install_autonomy_skill

  subctl_info "installing MCP server (~/.claude/settings.json mcpServers.subctl)"
  $DRY_RUN || subctl_settings_install_mcp

  subctl_info "installing master daemon (components/master/)"
  $DRY_RUN || subctl_settings_install_master

  # v2.7.21 (ADR 0011 L2): dashboard now ships its own package.json
  # (xterm.js + node-pty for the web-terminal escape hatch). The helper
  # is a no-op on pre-v2.7.21 layouts that lack dashboard/package.json.
  subctl_info "installing dashboard vendor deps (web terminal — xterm.js + node-pty)"
  $DRY_RUN || subctl_settings_install_dashboard_deps

  # shell aliases
  if ! $NO_SHELL; then
    subctl_info "shell aliases"
    . "$REPO_ROOT/lib/migrate.sh"
    $DRY_RUN || subctl_migrate_generate_aliases
    $DRY_RUN || subctl_migrate_zshrc
  fi

  # go deck build
  if [[ -d "$REPO_ROOT/deck" ]]; then
    if command -v go >/dev/null 2>&1; then
      subctl_info "building subctl-deck (Go TUI session manager)"
      if $DRY_RUN; then
        echo "[dry-run] cd $REPO_ROOT/deck && go build -o $REPO_ROOT/bin/subctl-deck ."
      else
        (cd "$REPO_ROOT/deck" && go build -o "$REPO_ROOT/bin/subctl-deck" . 2>&1) \
          && subctl_ok "built bin/subctl-deck" \
          || subctl_warn "go build failed — deck unavailable"
      fi
    else
      subctl_warn "go not installed — deck binary skipped"
    fi
  fi

  # go subctl-policy-check build (PR 8 — policy engine hot path)
  # Compiled binary sits next to the bash subctl entry; the PreToolUse hook
  # in providers/claude (PR 10) shells out to it on every Bash invocation.
  # If Go is missing the master daemon's TS check.ts still works as a fallback.
  if [[ -d "$REPO_ROOT/bin/subctl-policy-check" ]]; then
    if command -v go >/dev/null 2>&1; then
      subctl_info "building subctl-policy-check (Go policy engine hot path)"
      if $DRY_RUN; then
        echo "[dry-run] cd $REPO_ROOT/bin/subctl-policy-check && make build"
      else
        (cd "$REPO_ROOT/bin/subctl-policy-check" && make build 2>&1) \
          && subctl_ok "built bin/subctl-policy-check/subctl-policy-check" \
          || subctl_warn "go build failed — policy-check unavailable (TS fallback still works)"
      fi
    else
      subctl_warn "go not installed — policy-check binary skipped (brew install go to enable)"
    fi
  fi

  # dashboard service (opt-in)
  if ! $NO_SERVICE && command -v bun >/dev/null 2>&1; then
    echo
    if $ASSUME_YES || _confirm "Enable dashboard service (auto-start on http://127.0.0.1:8787)?" "N"; then
      . "$REPO_ROOT/lib/service.sh"
      $DRY_RUN || subctl_service_enable
    else
      subctl_info "dashboard service skipped — enable later: subctl service enable"
    fi
  fi
}

# ── final summary ────────────────────────────────────────────────────────────
final_summary() {
  echo
  subctl_ok "subctl v$SUBCTL_VERSION installed"
  echo

  local first_run=true
  if [[ -f "$SUBCTL_ACCOUNTS_CONF" ]]; then
    if awk -F'|' '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        {
          a=$1; gsub(/[[:space:]]/, "", a)
          if (a != "claude-personal" && a != "claude-work" && a != "claude-overflow") { found=1 }
        }
        END { exit !found }
      ' "$SUBCTL_ACCOUNTS_CONF" 2>/dev/null; then
      first_run=false
    fi
  fi

  if $first_run; then
    echo "${C_CYN}First time?${C_RST} Run the setup wizard:"
    echo "  ${C_BLD}subctl setup --wizard${C_RST}"
  else
    echo "Next steps:"
    echo "  1. Reload shell:    source ~/.zshrc"
    echo "  2. Run TUI:         subctl"
    echo "  3. Health check:    subctl doctor"
    echo "  4. Reconfigure:     subctl setup"
  fi

  if ! _dep_detect "telegram-bot"; then
    echo
    subctl_warn "Telegram master-notify.json not configured."
    echo "  Run: bash $0 --botfather   (before: subctl master enable)"
  fi

  echo
  echo "Uninstall: subctl uninstall"
}

# ── main ─────────────────────────────────────────────────────────────────────
_bootstrap_jq
[[ -f "$MANIFEST" ]] || subctl_die "manifest missing: $MANIFEST"

# --botfather: walkthrough only, exit
if $ONLY_BOTFATHER; then
  run_botfather_walkthrough
  exit $?
fi

phase_preflight
PRE_BEFORE_HARD_OK=$PRE_HARD_OK
PRE_BEFORE_HARD_TOTAL=$PRE_HARD_TOTAL

if $CHECK_ONLY; then
  echo
  printf "%s== Phase 3/3 — verify (re-check, no installs) ==%s\n" "$C_BLD" "$C_RST"
  phase_verify
  rc=$?
  echo
  subctl_info "--check-only mode: skipped install + component wiring"
  exit $rc
fi

if ! $SKIP_DEPS; then
  if (( PRE_BEFORE_HARD_OK == PRE_BEFORE_HARD_TOTAL )); then
    echo
    subctl_info "all hard deps already present — skipping install phase (idempotent)"
  else
    phase_install || true
  fi
fi

phase_verify || true
component_install
final_summary
