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
ROLLBACK_V3_RENAME=false

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
    --rollback-v3-rename)    ROLLBACK_V3_RENAME=true ;;
    --uninstall)             exec bash "$REPO_ROOT/uninstall.sh" ;;
    -h|--help)
      sed -n '2,21p' "$0"; exit 0 ;;
    *) subctl_err "unknown arg: $arg"; exit 1 ;;
  esac
done

run() { $DRY_RUN && echo "[dry-run] $*" || eval "$@"; }

# ── v3.0 Phase 3 — Evy rename migration ─────────────────────────────────────
#
# Migrates legacy "master" naming → "Evy" naming on disk. Idempotent — safe
# to re-run, safe to run on fresh installs (no-ops when there's nothing to
# migrate). Runs unconditionally during component_install on v3.0+ installs
# so operators upgrading from v2.x get migrated transparently.
#
# What changes on disk:
#   ~/Library/LaunchAgents/com.subctl.master.plist  → unloaded + removed
#   ~/.config/subctl/master/                        → renamed to evy/
#   ~/.config/subctl/master-notify.json             → renamed to evy-notify.json
#   ~/.config/subctl/_backup-pre-v3-rename-<ISO>.tar.gz  ← created BEFORE rename
#   ~/.config/subctl/master                         → symlink to evy/ (one-cycle compat)
#   ~/.config/subctl/master-notify.json             → symlink to evy-notify.json (one-cycle compat)
#
# The new com.subctl.evy.plist is loaded by `subctl evy enable` (operator-driven),
# not by this migration. We tear down the old plist here so the v2.x daemon
# stops running before the operator brings up the v3.0 daemon.
subctl_migrate_to_evy() {
  local home_dir="${HOME:?HOME unset}"
  local cfg_dir="$home_dir/.config/subctl"
  local agents_dir="$home_dir/Library/LaunchAgents"
  local old_plist="$agents_dir/com.subctl.master.plist"
  local new_plist="$agents_dir/com.subctl.evy.plist"
  local old_state="$cfg_dir/master"
  local new_state="$cfg_dir/evy"
  local old_notify="$cfg_dir/master-notify.json"
  local new_notify="$cfg_dir/evy-notify.json"
  local backup_ts; backup_ts=$(date -u +%Y%m%dT%H%M%SZ)
  local backup_tgz="$cfg_dir/_backup-pre-v3-rename-$backup_ts.tar.gz"

  # Idempotency guard — if the state dir is already migrated AND the old
  # path is either gone or already a symlink to the new path, we're done.
  if [[ -d "$new_state" && ( ! -e "$old_state" || -L "$old_state" ) ]] \
     && [[ ! -f "$old_plist" ]]; then
    subctl_info "v3.0 Evy rename migration already complete (skipping)"
    return 0
  fi

  # Nothing to migrate? (fresh install, no legacy artifacts)
  if [[ ! -f "$old_plist" && ! -d "$old_state" && ! -f "$old_notify" ]]; then
    subctl_info "no v2.x master artifacts on disk — Evy rename migration not needed"
    return 0
  fi

  subctl_info "v3.0 Phase 3 — migrating master → Evy on disk"

  # Pre-migration backup. Tarball everything that's about to move so a
  # botched rename can be reversed manually.
  if [[ -d "$old_state" || -f "$old_notify" ]]; then
    local backup_items=()
    [[ -d "$old_state" ]] && backup_items+=("master")
    [[ -f "$old_notify" ]] && backup_items+=("master-notify.json")
    if $DRY_RUN; then
      echo "[dry-run] tar -czf $backup_tgz -C $cfg_dir ${backup_items[*]}"
    else
      tar -czf "$backup_tgz" -C "$cfg_dir" "${backup_items[@]}" \
        && subctl_info "  pre-migration backup → $backup_tgz" \
        || { subctl_err "  backup failed — refusing to continue"; return 1; }
    fi
  fi

  # Unload the old plist (best effort — may not be loaded).
  if [[ -f "$old_plist" ]]; then
    run launchctl unload "$old_plist" 2>/dev/null || true
    subctl_info "  unloaded com.subctl.master (if it was running)"
  fi

  # Atomic rename of the state dir. We only rename when target doesn't
  # exist — defensive against partial prior migrations.
  if [[ -d "$old_state" && ! -e "$new_state" ]]; then
    run mv "$old_state" "$new_state"
    subctl_info "  renamed state dir: $old_state → $new_state"
  elif [[ -d "$old_state" && -d "$new_state" && ! -L "$old_state" ]]; then
    subctl_warn "  both $old_state and $new_state exist — leaving both alone"
    subctl_warn "  resolve manually then re-run: bash install.sh"
    return 1
  fi

  # Notify config — same atomic-rename pattern.
  if [[ -f "$old_notify" && ! -e "$new_notify" ]]; then
    run mv "$old_notify" "$new_notify"
    subctl_info "  renamed notify config: $old_notify → $new_notify"
  fi

  # One-cycle compat symlinks. External tooling that hardcoded the old
  # paths (operator scripts, third-party watchers) keeps working through
  # v3.x. Removed in v3.x+1.
  if [[ -d "$new_state" && ! -e "$old_state" ]]; then
    run ln -s "$new_state" "$old_state"
    subctl_info "  compat symlink: $old_state → $new_state (removed in v3.x+1)"
  fi
  if [[ -f "$new_notify" && ! -e "$old_notify" ]]; then
    run ln -s "$new_notify" "$old_notify"
    subctl_info "  compat symlink: $old_notify → $new_notify (removed in v3.x+1)"
  fi

  # Remove the old plist file. The label may persist as a launchctl ghost
  # entry until reboot if the unload didn't fully complete, which is
  # harmless — `subctl evy enable` will write and load com.subctl.evy.
  if [[ -f "$old_plist" ]]; then
    run rm "$old_plist"
    subctl_info "  removed $old_plist"
  fi

  subctl_ok "Evy rename migration complete"
  subctl_info "  run 'subctl evy enable' to bring up the v3.0 daemon"
}

# Reverse the v3.0 Evy rename. Best-effort — restores state dir, notify
# config, and (if a backup tarball is on disk) the original layout.
subctl_rollback_v3_rename() {
  local home_dir="${HOME:?HOME unset}"
  local cfg_dir="$home_dir/.config/subctl"
  local agents_dir="$home_dir/Library/LaunchAgents"
  local old_plist="$agents_dir/com.subctl.master.plist"
  local new_plist="$agents_dir/com.subctl.evy.plist"
  local old_state="$cfg_dir/master"
  local new_state="$cfg_dir/evy"
  local old_notify="$cfg_dir/master-notify.json"
  local new_notify="$cfg_dir/evy-notify.json"

  subctl_info "v3.0 rollback — restoring master/ layout from evy/"

  # Unload the new plist so it isn't holding the daemon up while we reverse.
  if [[ -f "$new_plist" ]]; then
    run launchctl unload "$new_plist" 2>/dev/null || true
    subctl_info "  unloaded com.subctl.evy (if it was running)"
    run rm -f "$new_plist"
  fi

  # Tear down compat symlinks first.
  if [[ -L "$old_state" ]]; then
    run rm "$old_state"
    subctl_info "  removed compat symlink $old_state"
  fi
  if [[ -L "$old_notify" ]]; then
    run rm "$old_notify"
    subctl_info "  removed compat symlink $old_notify"
  fi

  # Rename the actual state dir back to master/.
  if [[ -d "$new_state" && ! -e "$old_state" ]]; then
    run mv "$new_state" "$old_state"
    subctl_info "  renamed state dir: $new_state → $old_state"
  fi
  if [[ -f "$new_notify" && ! -e "$old_notify" ]]; then
    run mv "$new_notify" "$old_notify"
    subctl_info "  renamed notify config: $new_notify → $old_notify"
  fi

  # Inform operator about the backup tarball (latest by mtime).
  local latest_backup
  latest_backup=$(ls -t "$cfg_dir"/_backup-pre-v3-rename-*.tar.gz 2>/dev/null | head -1)
  if [[ -n "$latest_backup" ]]; then
    subctl_info "  pre-migration backup still on disk: $latest_backup"
    subctl_info "  (delete manually once you've confirmed the rollback works)"
  fi

  # The v2.x plist must be restored separately — the operator brings the
  # daemon back up the v2.x way (via `subctl master enable` on a v2.x
  # checkout, or by re-running `bash install.sh` from main).
  subctl_warn "  v2.x master plist NOT restored — re-checkout a v2.x branch and run 'bash install.sh' to regenerate"

  subctl_ok "rollback complete"
}

# ── install tree (worktree pinned to main, decoupled from dev tree) ──────────
#
# Why this exists: before this function, the launchd plist for the dashboard
# (and master) pointed `ProgramArguments` directly at $SUBCTL_REPO_ROOT/...,
# i.e. the dev tree. ANY `git checkout <branch>` in the dev tree would change
# what the launchd daemon would serve on next restart — slow-burn bug. The
# fix (documented in ORCHESTRATION.md 2026-05-13 night, applied manually
# first on the local Mac) is to pin a separate worktree to `main` at
# $SUBCTL_INSTALL_TREE and target the plist there.
#
# v2.8.9 — seed operator configs with sane defaults on fresh install.
#
# Three config artifacts that the master daemon checks at boot time. Prior
# to v2.8.9 these were operator-owned-only — meaning a fresh subctl
# install came up with cognition loop disabled, idle-pane watchdog
# disabled, and MCP server unconfigured (no token in secrets.json). The
# operator had to manually touch each file to opt in.
#
# Side effect on M3-style deploys: a fresh box that pulled v2.8.8 from
# main had zero memory automation by default, and MCP integration was
# non-functional without explicit secret-minting. That defeated the
# "first 10 minutes magical" goal.
#
# This function writes sane defaults IF (and only if) the target file
# doesn't already exist. Existing files are NEVER overwritten — the
# operator-override contract is preserved exactly as before. Re-running
# is idempotent.
subctl_install_seed_operator_configs() {
  local evy_cfg="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}/evy"
  local secrets_file="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}/secrets.json"
  mkdir -p "$evy_cfg" 2>/dev/null || true

  # 1) Cognition loop — Memory Init #7. Enabled-by-default so Evy starts
  # observing immediately. Operator can disable by editing this file or
  # setting "enabled": false.
  local cl_cfg="$evy_cfg/consciousness-loop.json"
  if [[ ! -f "$cl_cfg" ]]; then
    cat > "$cl_cfg" <<'CL_EOF'
{
  "enabled": true
}
CL_EOF
    subctl_ok "seeded $cl_cfg (cognition loop enabled)"
  else
    subctl_info "$cl_cfg exists — leaving operator's config untouched"
  fi

  # 2) Idle-pane watchdog — notify-only by default (auto_retry off). Catches
  # worker panes where typed-but-unsubmitted directives sit at the prompt
  # without triggering tmux paste-buffer mutation safeguards.
  local ip_cfg="$evy_cfg/idle-pane-watchdog.json"
  if [[ ! -f "$ip_cfg" ]]; then
    cat > "$ip_cfg" <<'IP_EOF'
{
  "enabled": true,
  "auto_retry_enabled": false
}
IP_EOF
    subctl_ok "seeded $ip_cfg (idle-pane watchdog enabled, notify-only)"
  else
    subctl_info "$ip_cfg exists — leaving operator's config untouched"
  fi

  # 3) MCP token — mint a fresh 32-byte hex token if secrets.json lacks
  # one. Without this, the master's MCP server boots disabled (`[mcp]
  # disabled — no subctl_mcp_token secret`) and Claude Desktop / external
  # MCP clients can't connect.
  local need_mint="no"
  if [[ ! -f "$secrets_file" ]]; then
    need_mint="yes"
    echo '{}' > "$secrets_file"
    chmod 600 "$secrets_file" 2>/dev/null || true
  elif ! grep -q '"subctl_mcp_token"' "$secrets_file" 2>/dev/null; then
    need_mint="yes"
  fi
  if [[ "$need_mint" == "yes" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      local mcp_tok
      mcp_tok=$(openssl rand -hex 32)
      # Use a tmpfile + mv for atomic write. Use jq if available, else
      # fall back to sed-style merge (safe because secrets.json is JSON
      # and we control the key shape).
      if command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq --arg t "$mcp_tok" '. + {subctl_mcp_token: $t}' "$secrets_file" > "$tmp" \
          && mv "$tmp" "$secrets_file" \
          && chmod 600 "$secrets_file" 2>/dev/null || true
      else
        # No jq fallback — rewrite the file. Loses formatting; acceptable
        # because the operator can install jq for future-pretty writes.
        printf '{"subctl_mcp_token":"%s"}\n' "$mcp_tok" > "$secrets_file"
        chmod 600 "$secrets_file" 2>/dev/null || true
      fi
      subctl_ok "minted subctl_mcp_token into $secrets_file (32 hex bytes)"
    else
      subctl_warn "openssl not available — skipping MCP token mint. Generate manually:"
      subctl_warn "  openssl rand -hex 32 | jq -R '{subctl_mcp_token: .}' >> $secrets_file"
    fi
  else
    subctl_info "subctl_mcp_token already set — leaving untouched"
  fi
}

# Idempotent: re-running on a system that already has the install tree is a
# no-op early-return. Override the path via $SUBCTL_INSTALL_TREE.
ensure_install_tree() {
  local install_tree="${SUBCTL_INSTALL_TREE:-$HOME/.local/lib/subctl-install}"
  if [[ -e "$install_tree/.git" ]]; then  # worktree's `.git` is a FILE, not a dir → -e
    subctl_info "install tree already exists at $install_tree (skipping create)"
    return 0
  fi
  if [[ -e "$install_tree" ]]; then
    subctl_err "$install_tree exists but isn't a git worktree — refusing to overwrite"
    subctl_err "  move or remove it, then re-run install.sh, or set SUBCTL_INSTALL_TREE elsewhere"
    return 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    subctl_warn "git missing — cannot create install tree. Falling back to dev tree for launchd plists."
    subctl_warn "  install git, then re-run install.sh to create $install_tree"
    return 0
  fi

  subctl_info "creating install tree (pinned to main): $install_tree"
  run mkdir -p "$(dirname "$install_tree")" || return 1
  if $DRY_RUN; then
    echo "[dry-run] git -C $SUBCTL_REPO_ROOT worktree add $install_tree main"
    for sub in dashboard components/evy components/mcp; do
      echo "[dry-run] (cd $install_tree/$sub && bun install)"
    done
    return 0
  fi

  if ! git -C "$SUBCTL_REPO_ROOT" worktree add "$install_tree" main 2>&1; then
    subctl_err "git worktree add failed — see message above. Plist will fall back to dev tree."
    return 1
  fi

  # Vendor deps for every workspace that has a package.json. The master
  # daemon's policy snapshot bridge resolves smol-toml etc. relative to
  # components/evy/, so a missing node_modules there blocks every
  # team spawn with an opaque HTTP 500 ("policy snapshot bridge failed:
  # Cannot find package 'smol-toml'") — diagnosed 2026-05-18 when Evy
  # could not spawn subctl-proxy-team.
  if command -v bun >/dev/null 2>&1; then
    for sub in dashboard components/evy components/mcp; do
      if [[ -f "$install_tree/$sub/package.json" ]]; then
        subctl_info "vendoring $sub deps in install tree"
        if ! (cd "$install_tree/$sub" && bun install >/dev/null 2>&1); then
          subctl_warn "bun install in $install_tree/$sub failed — runtime may be missing deps"
        else
          subctl_ok "install-tree $sub deps installed"
        fi
      fi
    done
  fi

  subctl_ok "install tree ready: $install_tree"
  subctl_info "  daily-driver launchd plists will target this path, not the dev tree at $SUBCTL_REPO_ROOT"
  subctl_info "  to redeploy after a main merge: cd $install_tree && git pull origin main && launchctl kickstart -k gui/\$UID/com.subctl.dashboard"
}

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
  local notify="$cfg_dir/evy-notify.json"

  echo
  printf "%s== Telegram BotFather walkthrough ==%s\n" "$C_BLD" "$C_RST"
  echo
  if [[ -f "$notify" ]]; then
    subctl_ok "evy-notify.json already exists at $notify"
    if ! _confirm "Overwrite with new credentials?" "N"; then
      subctl_info "leaving existing config in place"
      return 0
    fi
  fi

  cat <<'EOF'
subctl evy uses a SEPARATE Telegram bot from `subctl notify` (the worker-
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
  subctl_info "you can now run: subctl evy enable"
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
      if _confirm "Run BotFather walkthrough now to set up evy-notify.json?" "Y"; then
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
    service-launchd)
      # Cognee + future first-class launchd sidecars. The install command
      # is a subctl verb that loads the plist via lib/<name>.sh — driven
      # through the operator-facing CLI surface so a one-off
      # `subctl <name> install` works the same way the installer does.
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
    # Per-dep post-install patches for known upstream bugs.
    if [[ "$id" == "claude-mem" ]]; then
      _patch_claude_mem_plugin_deps
    fi
    return 0
  fi

  if [[ "$tier" == "hard" ]] && ! $ALLOW_MISSING_HARD; then
    subctl_err "$name install attempted but still not detected"
    return 1
  fi
  subctl_warn "$name install completed but not yet detected (may need PATH refresh)"
  return 0
}

# claude-mem (thedotmack) ships marketplace install bundles without bundled
# node_modules — known upstream bug across v13.x: github.com/thedotmack/
# claude-mem/issues/2407 (root), /2437 (still broken 13.x), /2520 (current
# v13.2.0). The SessionStart / UserPromptSubmit / Stop hooks load
# scripts/worker-service.cjs which require('zod/v3'), and the import fails
# with "Cannot find module 'zod/v3'" because node_modules was never installed.
#
# We patch each per-account plugin install location after `npx claude-mem
# install` lands. --ignore-scripts is mandatory because the plugin's
# tree-sitter@0.25.0 native build fails on Node 26 (the C++20 '<=>' token
# issue) — but the hook scripts only actually need zod + shell-quote (pure
# JS), which install fine. Tree-sitter native bindings stay broken; that
# only affects smart_outline/smart_search code paths the hooks don't hit.
#
# Will need to re-run on each claude-mem auto-update; we re-run this on
# every subctl install pass so a 'bash install.sh' after a claude-mem
# upgrade restores the patch.
_patch_claude_mem_plugin_deps() {
  local patched=0 skipped=0
  for accountdir in "$HOME"/.claude "$HOME"/.claude-*; do
    [[ -d "$accountdir" ]] || continue
    local plugindir="$accountdir/plugins/marketplaces/thedotmack/plugin"
    [[ -d "$plugindir" ]] || continue
    if [[ -f "$plugindir/node_modules/zod/v3/package.json" ]]; then
      skipped=$((skipped + 1))
      continue
    fi
    subctl_info "    patching claude-mem plugin deps in $accountdir"
    if (cd "$plugindir" && npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
      patched=$((patched + 1))
    else
      subctl_warn "    npm install --ignore-scripts failed in $plugindir (hooks will keep emitting zod/v3 errors)"
    fi
  done
  if (( patched > 0 || skipped > 0 )); then
    subctl_ok "    claude-mem plugin deps: $patched patched, $skipped already ok"
  fi
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
  cognee
  cloakbrowser
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

  # v3.0 Phase 3 — Evy rename migration. Runs unconditionally (idempotent;
  # no-ops on fresh installs or after a successful prior run). Must
  # precede the daemon-install step so the old plist is torn down before
  # the operator brings up the v3.0 daemon.
  subctl_migrate_to_evy

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

  subctl_info "installing master daemon (components/evy/)"
  $DRY_RUN || subctl_settings_install_evy

  # v2.8.9 — seed operator configs with sane defaults on fresh installs.
  # These three config artifacts WERE operator-owned-only in v2.8.7-v2.8.8,
  # which meant a fresh subctl install came up with cognition loop +
  # idle-pane watchdog disabled and MCP server with no token — making
  # M3-style deploys non-functional out of the box without operator
  # intervention. Seeding here keeps the operator-override contract
  # (existing configs are NEVER overwritten) while giving fresh installs
  # a working default. See [[Daily Updates/2026-05-20]] §"Deploy gaps".
  subctl_info "seeding operator configs (cognition loop + idle-pane + MCP token)"
  $DRY_RUN || subctl_install_seed_operator_configs

  # v2.7.21 (ADR 0011 L2): dashboard now ships its own package.json
  # (xterm.js + node-pty for the web-terminal escape hatch). The helper
  # is a no-op on pre-v2.7.21 layouts that lack dashboard/package.json.
  subctl_info "installing dashboard vendor deps (web terminal — xterm.js + node-pty)"
  $DRY_RUN || subctl_settings_install_dashboard_deps

  # Decouple the daily-driver dashboard from dev-tree branch activity by
  # creating $SUBCTL_INSTALL_TREE — a git worktree pinned to `main`. Must
  # happen BEFORE the dashboard service plist is generated below (so the
  # plist's ProgramArguments can point at the install tree).
  subctl_info "ensuring install tree (worktree pinned to main, decoupled from dev tree)"
  ensure_install_tree || subctl_warn "ensure_install_tree returned non-zero — plist will fall back to dev tree"

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

  # v2.8.0 — voice layer (opt-in). Default backend is the in-tree mock
  # (1s silent WAV) so install is fast and the rest of the voice pipeline
  # — voice_render tool, dashboard 🔊 button, Telegram /say — can be
  # validated end-to-end. Real TTS (voxcpm or kokoro) needs a manual
  # pip install + model weights; see services/tts/README.md.
  if ! $NO_SERVICE; then
    echo
    if $ASSUME_YES || _confirm "Install v2.8.0 voice layer (TTS service, mock backend by default)?" "N"; then
      . "$REPO_ROOT/lib/voice.sh"
      local _backend="mock"
      if $ASSUME_YES; then
        _backend="mock"
      else
        local _reply
        echo "  Backend: mock = 1s silent WAV (no pip install needed)"
        echo "           voxcpm = pip install voxcpm (operator's primary lean; ADR 0017)"
        echo "           kokoro = pip install kokoro (CPU-friendly fallback)"
        read -r -p "  Backend [mock]: " _reply
        case "${_reply:-mock}" in
          voxcpm|kokoro|mock) _backend="${_reply:-mock}" ;;
          *) subctl_warn "unknown backend '$_reply' — using mock" ;;
        esac
      fi
      $DRY_RUN || subctl_voice_install "$_backend"
    else
      subctl_info "voice layer skipped — enable later: bash $0 (re-run) or load lib/voice.sh and call subctl_voice_install"
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
    subctl_warn "Telegram evy-notify.json not configured."
    echo "  Run: bash $0 --botfather   (before: subctl evy enable)"
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

# --rollback-v3-rename: reverse the Evy rename migration, exit
if $ROLLBACK_V3_RENAME; then
  subctl_rollback_v3_rename
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
