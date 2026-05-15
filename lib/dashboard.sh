#!/usr/bin/env bash
# lib/dashboard.sh — operator verbs for the dashboard launchd service.
#
# Wraps the 3-step deploy flow that emerged during dashboard decomposition
# (2026-05-13/14):
#
#   cd ~/.local/lib/subctl-install      # the install worktree (pinned main)
#   git fetch origin main && git merge --ff-only origin/main
#   launchctl kickstart -k gui/$UID/com.subctl.dashboard
#
# Background: the dashboard is served from a separate git worktree (the
# "install tree") so the operator's working repo (~/code/subctl) can sit on
# feature branches without taking the daily-driver dashboard hostage. The
# launchd plist (com.subctl.dashboard) points at the install tree's
# server.ts, so a deploy = ff-merge in the install tree + kickstart.
#
# This file exposes two verbs:
#   subctl_dashboard_open   — preserves the legacy `subctl dashboard`
#                              behavior (ensure running → open browser).
#   subctl_dashboard_deploy — ff-merges origin/main into the install tree
#                              and kickstarts the launchd job. Idempotent.

[[ -n "${_SUBCTL_DASHBOARD_LOADED:-}" ]] && return 0
_SUBCTL_DASHBOARD_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# Override-able install-tree path. Default matches the layout established
# 2026-05-13 (HANDOFF.md §2). Operators with a different layout can set
# SUBCTL_INSTALL_TREE before invocation.
SUBCTL_INSTALL_TREE="${SUBCTL_INSTALL_TREE:-$HOME/.local/lib/subctl-install}"

# ── open (legacy behavior) ───────────────────────────────────────────────────
# Ensure the service is running, then open the dashboard URL in the browser.
# Identical to the pre-2026-05-15 `subctl dashboard` one-shot — just routed
# through this lib so the dispatcher can sub-verb on `open|deploy`.
subctl_dashboard_open() {
  . "$SUBCTL_REPO_ROOT/lib/service.sh"
  local state
  state=$(subctl_service_state)
  [[ "$state" != "running" ]] && subctl_service_start
  open "http://127.0.0.1:$SUBCTL_SERVICE_PORT"
}

# ── deploy: ff-merge install tree + kickstart launchd job ────────────────────
# Steps:
#   1. validate $SUBCTL_INSTALL_TREE exists and is a git worktree
#   2. git fetch origin main
#   3. capture BEFORE sha; git merge --ff-only origin/main; capture AFTER
#   4. if no change → exit 0 (idempotent no-op)
#   5. if dashboard/package.json changed between BEFORE..AFTER → bun install
#   6. launchctl kickstart -k gui/$UID/com.subctl.dashboard
#   7. smoke-check /api/version (warn-only — daemon may be slow to bind)
#   8. print summary line
subctl_dashboard_deploy() {
  local tree="$SUBCTL_INSTALL_TREE"

  if [[ ! -d "$tree" ]]; then
    subctl_err "install tree not found: $tree"
    subctl_err "  expected a git worktree of the subctl repo pinned to main."
    subctl_err "  bootstrap (one-time) with:"
    subctl_err "    git worktree add $tree main"
    subctl_err "    (cd $tree/dashboard && bun install)"
    subctl_err "  or run: bash install.sh   (will create it for you)"
    return 1
  fi

  if [[ ! -d "$tree/.git" && ! -f "$tree/.git" ]]; then
    subctl_err "$tree is not a git worktree (no .git entry)"
    subctl_err "  this verb only operates on git-managed install trees."
    return 1
  fi

  # Source the dashboard port for the post-deploy smoke check. service.sh
  # has its own load-guard so this is a no-op if already sourced.
  . "$SUBCTL_REPO_ROOT/lib/service.sh"

  subctl_info "install tree: $tree"

  # Fetch — explicit error check (set -uo pipefail doesn't catch a bare
  # command failure outside a pipeline, and we want a clear message).
  if ! ( cd "$tree" && git fetch origin main ) ; then
    subctl_err "git fetch origin main failed in $tree"
    return 1
  fi

  local before after
  before=$(cd "$tree" && git rev-parse HEAD 2>/dev/null)
  if [[ -z "$before" ]]; then
    subctl_err "could not read HEAD in $tree"
    return 1
  fi

  # ff-only merge — fails cleanly if the install tree has diverged.
  if ! ( cd "$tree" && git merge --ff-only origin/main ) ; then
    subctl_err "git merge --ff-only origin/main failed in $tree"
    subctl_err "  install tree has diverged from origin/main. Investigate before"
    subctl_err "  deploying:  cd $tree && git status && git log --oneline -5"
    return 1
  fi

  after=$(cd "$tree" && git rev-parse HEAD 2>/dev/null)

  local before_s="${before:0:7}"
  local after_s="${after:0:7}"

  if [[ "$before" == "$after" ]]; then
    subctl_ok "install tree already at $after_s — nothing to deploy"
    return 0
  fi

  subctl_info "updating install tree: $before_s → $after_s"

  # If dashboard/package.json changed between BEFORE and AFTER, the install
  # tree's node_modules/ may be stale. Run `bun install` in the dashboard
  # subtree before kickstarting.
  local changed
  changed=$(cd "$tree" && git diff --name-only "$before" "$after" | grep -x 'dashboard/package.json' || true)
  if [[ -n "$changed" ]]; then
    subctl_info "dashboard/package.json changed — running bun install"
    if ! subctl_require bun "install: curl -fsSL https://bun.sh/install | bash" ; then
      return 1
    fi
    if ! ( cd "$tree/dashboard" && bun install ) ; then
      subctl_err "bun install failed in $tree/dashboard"
      subctl_err "  fix the install before kickstarting — daemon would crash-loop."
      return 1
    fi
  fi

  # Kickstart the launchd job. `-k` kills the current process first, then
  # relaunches under the same plist (so the new SHA's server.ts runs).
  local label="${SUBCTL_SERVICE_LABEL:-com.subctl.dashboard}"
  local target="gui/$UID/$label"
  if ! launchctl kickstart -k "$target" ; then
    subctl_err "launchctl kickstart -k $target failed"
    subctl_err "  is the service enabled?  subctl service status"
    return 1
  fi

  # Smoke check — give the daemon a moment to bind, then probe /api/version.
  # Warn-only: a slow startup shouldn't fail the deploy (the operator can
  # `subctl service status` immediately after if they're worried).
  sleep 2
  local port="${SUBCTL_SERVICE_PORT:-8787}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/api/version" 2>/dev/null || echo 000)
  if [[ "$code" == "200" ]]; then
    subctl_ok "smoke check: /api/version → 200"
  else
    subctl_warn "smoke check: /api/version → $code (daemon may still be starting up)"
    subctl_warn "  re-check with:  curl http://127.0.0.1:${port}/api/version"
  fi

  subctl_ok "deployed $after_s to :${port}"
}
