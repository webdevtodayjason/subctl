#!/usr/bin/env bash
# lib/core.sh — foundational helpers. Sourced by every other lib + bin/subctl.
# Idempotent: sourcing twice is safe.

[[ -n "${_SUBCTL_CORE_LOADED:-}" ]] && return 0
_SUBCTL_CORE_LOADED=1

# ── paths ────────────────────────────────────────────────────────────────────
# Resolve repo root from this file's location (lib/core.sh → ..)
_SUBCTL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBCTL_REPO_ROOT="${SUBCTL_REPO_ROOT:-$(cd "$_SUBCTL_LIB_DIR/.." && pwd)}"
export SUBCTL_REPO_ROOT

# User config lives outside the repo. XDG-compliant fallback to $HOME/.config.
SUBCTL_CONFIG_DIR="${SUBCTL_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/subctl}"
SUBCTL_ACCOUNTS_CONF="${SUBCTL_ACCOUNTS_CONF:-$SUBCTL_CONFIG_DIR/accounts.conf}"
SUBCTL_LOG_DIR="${SUBCTL_LOG_DIR:-$HOME/Library/Logs/subctl}"
SUBCTL_RL_LOG="$HOME/.claude/rate-limit-events.log"

# Install tree — a git worktree pinned to `main` that the launchd daemons
# (dashboard, master) point at instead of the dev tree ($SUBCTL_REPO_ROOT).
# Decouples the running daily-driver from feature-branch checkouts in the
# dev tree (otherwise any `git checkout` in $SUBCTL_REPO_ROOT silently
# changes what the daemons would serve on next restart — slow-burn bug
# documented in ORCHESTRATION.md, 2026-05-13 night).
#
# Default: $HOME/.local/lib/subctl-install. Override at install time:
#   SUBCTL_INSTALL_TREE=/some/other/path bash install.sh
# Created idempotently by install.sh:ensure_install_tree.
SUBCTL_INSTALL_TREE="${SUBCTL_INSTALL_TREE:-$HOME/.local/lib/subctl-install}"

export SUBCTL_CONFIG_DIR SUBCTL_ACCOUNTS_CONF SUBCTL_LOG_DIR SUBCTL_RL_LOG SUBCTL_INSTALL_TREE

# ── colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\033[31m';  C_GRN=$'\033[32m';  C_YLW=$'\033[33m'
  C_BLU=$'\033[34m';  C_MAG=$'\033[35m';  C_CYN=$'\033[36m'
  C_ORN=$'\033[38;5;208m'
  C_DIM=$'\033[2m';   C_BLD=$'\033[1m';   C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_MAG=""; C_CYN=""
  C_ORN=""; C_DIM=""; C_BLD=""; C_RST=""
fi
export C_RED C_GRN C_YLW C_BLU C_MAG C_CYN C_ORN C_DIM C_BLD C_RST

# ── logging ──────────────────────────────────────────────────────────────────
subctl_info() { printf "%s==>%s %s\n" "$C_CYN" "$C_RST" "$*"; }
subctl_ok()   { printf "%s ✓%s %s\n" "$C_GRN" "$C_RST" "$*"; }
subctl_warn() { printf "%s ⚠%s %s\n" "$C_YLW" "$C_RST" "$*"; }
subctl_err()  { printf "%s ✗%s %s\n" "$C_RED" "$C_RST" "$*" >&2; }
subctl_die()  { subctl_err "$@"; exit 1; }

# ── accounts.conf parsing ────────────────────────────────────────────────────
# Each non-comment line: alias | provider | email | config_dir | description
# All whitespace around `|` is trimmed. Tilde in config_dir expands to $HOME.
#
# Output format (TAB-separated): alias\tprovider\temail\tconfig_dir\tdescription
_subctl_trim() {
  local s="$1"
  # Strip leading and trailing whitespace (any amount).
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf "%s" "$s"
}

subctl_list_accounts() {
  [[ -f "$SUBCTL_ACCOUNTS_CONF" ]] || return 0
  while IFS='|' read -r alias provider email cfg_dir desc; do
    alias=$(_subctl_trim "$alias")
    provider=$(_subctl_trim "$provider")
    email=$(_subctl_trim "$email")
    cfg_dir=$(_subctl_trim "$cfg_dir")
    desc=$(_subctl_trim "$desc")
    [[ -z "$alias" || "${alias:0:1}" == "#" ]] && continue
    cfg_dir="${cfg_dir/#\~/$HOME}"
    printf "%s\t%s\t%s\t%s\t%s\n" "$alias" "$provider" "$email" "$cfg_dir" "$desc"
  done < "$SUBCTL_ACCOUNTS_CONF"
}

# SIGPIPE note (W6.5): never pipe subctl_list_accounts straight into an
# early-exit awk (`{print; exit}`). The producer is slow (5 _subctl_trim
# command substitutions per row); awk's early exit closes the pipe while
# the producer is mid-write, the producer takes SIGPIPE, and under
# bin/subctl's `set -uo pipefail` the pipeline status becomes 141 — so the
# lookup "fails" even though the answer was already printed and captured.
# Position-dependent: aliases early in accounts.conf always lost the race
# (reproduced 5/5 with openai-jason mid-file, 2026-06-11). Buffer the
# roster once and feed awk via herestring instead.

# Get a specific field for an alias. Field index: 1=alias 2=provider 3=email 4=config_dir 5=description
# Usage: subctl_account_field <alias> <field_num>
subctl_account_field() {
  local want="$1" idx="$2" all
  all=$(subctl_list_accounts)
  awk -F'\t' -v w="$want" -v i="$idx" '$1==w {print $i; exit}' <<<"$all"
}

# Resolve an alias that may be given with or without the provider prefix.
# `personal` → first match whose alias is `personal` OR `<provider>-personal`;
# `claude-dfox` → alias `dfox` when its provider is `claude` (dashboard-created
# profiles often carry bare aliases while muscle memory types prefixed ones).
# Returns the canonical alias on stdout, or exit 1 if no match.
subctl_resolve_alias() {
  local want="$1" hit all
  all=$(subctl_list_accounts)
  awk -F'\t' -v w="$want" '
    $1==w { print $1; found=1; exit }
    END { if (!found) exit 1 }
  ' <<<"$all" && return 0
  # Bare → prefixed: any alias ending in "-$want"
  hit=$(awk -F'\t' -v w="$want" '
    $1 ~ "-" w "$" { print $1; exit }
  ' <<<"$all")
  [[ -n "$hit" ]] && { printf '%s\n' "$hit"; return 0; }
  # Prefixed → bare: "$want" is exactly "<provider>-<alias>"
  hit=$(awk -F'\t' -v w="$want" '
    w == $2 "-" $1 { print $1; exit }
  ' <<<"$all")
  [[ -n "$hit" ]] && { printf '%s\n' "$hit"; return 0; }
  # No match: fail so callers die with "unknown account: <name>" instead of
  # threading an empty alias into downstream field lookups.
  return 1
}

# Auth status of an account by config_dir. Returns: ready | empty | missing
# Detects the provider by file shape so callers don't have to thread the
# provider through. Today we know two shapes:
#   - Claude:  $cfg_dir/.credentials.json  OR  non-empty $cfg_dir/projects/
#   - Codex:   $cfg_dir/auth.json with .tokens populated (OAuth tokens present)
# We deliberately do NOT key off Codex's auth_mode field: the simplified
# login flow (current default) doesn't write it at all, while older flows
# did. Token presence is the durable signal across both schemas.
subctl_auth_status() {
  local cfg_dir="$1"
  [[ -d "$cfg_dir" ]] || { echo missing; return; }
  if [[ -f "$cfg_dir/.credentials.json" ]] \
     || { [[ -d "$cfg_dir/projects" ]] && [[ -n "$(ls -A "$cfg_dir/projects" 2>/dev/null)" ]]; }; then
    echo ready; return
  fi
  if [[ -f "$cfg_dir/auth.json" ]] \
     && jq -e '(.tokens.id_token // .tokens.access_token // "") | length > 0' \
              "$cfg_dir/auth.json" >/dev/null 2>&1; then
    echo ready; return
  fi
  echo empty
}

# Filter accounts by provider. Outputs same format as subctl_list_accounts.
subctl_accounts_by_provider() {
  local provider="$1"
  subctl_list_accounts | awk -F'\t' -v p="$provider" '$2==p'
}

# Count accounts per provider. Output: provider count
subctl_accounts_count_by_provider() {
  subctl_list_accounts | awk -F'\t' '{print $2}' | sort | uniq -c | awk '{printf "%s\t%s\n", $2, $1}'
}

# ── prerequisite checks ──────────────────────────────────────────────────────
subctl_require() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    subctl_err "missing required command: $cmd"
    [[ -n "$hint" ]] && subctl_err "  $hint"
    return 1
  fi
}

subctl_have() { command -v "$1" >/dev/null 2>&1; }

# ── ensure config dir + touch accounts.conf if first run ─────────────────────
subctl_ensure_config_dir() {
  mkdir -p "$SUBCTL_CONFIG_DIR" "$SUBCTL_LOG_DIR"
  if [[ ! -f "$SUBCTL_ACCOUNTS_CONF" ]] && [[ -f "$SUBCTL_REPO_ROOT/config/accounts.conf.example" ]]; then
    cp "$SUBCTL_REPO_ROOT/config/accounts.conf.example" "$SUBCTL_ACCOUNTS_CONF"
    chmod 600 "$SUBCTL_ACCOUNTS_CONF"
    subctl_info "seeded $SUBCTL_ACCOUNTS_CONF from example template — edit it with your real accounts"
  fi
}

# ── version ──────────────────────────────────────────────────────────────────
# Single source of truth: VERSION file at repo root.
# bin/subctl, lib/update.sh, dashboard/server.ts, and components/evy/server.ts
# all derive their version string from this file (see CHANGELOG.md for bump policy).
if [[ -r "$SUBCTL_REPO_ROOT/VERSION" ]]; then
  SUBCTL_VERSION="$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION")"
else
  SUBCTL_VERSION="0.0.0-dev"
fi
export SUBCTL_VERSION
