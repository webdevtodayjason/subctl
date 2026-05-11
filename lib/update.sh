#!/usr/bin/env bash
# lib/update.sh — `subctl update`: pull origin/main and apply.
#
# Mirrors ArgentOS's update flow: stop services, fetch + fast-forward,
# bun install / build if anything dependency-y changed, restart services,
# run subctl doctor on the way out. Safe by default — refuses to update
# if the working tree has uncommitted changes (override with --force).

[[ -n "${_SUBCTL_UPDATE_LOADED:-}" ]] && return 0
_SUBCTL_UPDATE_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

subctl_update() {
  local force=false branch="" no_restart=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--force)      force=true; shift ;;
      -b|--branch)     branch="$2"; shift 2 ;;
      --no-restart)    no_restart=true; shift ;;
      -h|--help)
        cat <<EOF
subctl update [opts]

  Pull the latest subctl from origin and apply it. Mirrors ArgentOS:
    1. Verify clean working tree (or pass --force)
    2. git fetch + fast-forward to origin/<branch> (default: current branch,
       falls back to main)
    3. bun install in dirs whose package.json changed
    4. Restart master + dashboard launchd jobs (skip with --no-restart)
    5. subctl doctor

Options:
  -f, --force        Update even if the working tree has uncommitted changes
                     (stashes first, restores after; you may need to resolve
                     conflicts manually).
  -b, --branch <b>   Update from a specific branch instead of current.
  --no-restart       Don't bounce the launchd services. Useful if you're
                     attached to a running session you don't want killed.

Exit codes:
  0  updated cleanly (or already up to date)
  1  pre-flight failure (dirty tree, no remote, etc.)
  2  fetch / merge failed
  3  service restart failed
EOF
        return 0
        ;;
      *) subctl_die "unknown update flag: $1 (try -h)" ;;
    esac
  done

  cd "$SUBCTL_REPO_ROOT" || subctl_die "cannot cd to $SUBCTL_REPO_ROOT"

  # ── 1. preflight ──────────────────────────────────────────────────────────
  subctl_require git "install: brew install git" || return 1
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    subctl_die "$SUBCTL_REPO_ROOT is not a git repo — `subctl update` only works on a cloned install"
  fi

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  branch="${branch:-$current_branch}"
  [[ -z "$branch" ]] && branch="main"

  if ! git remote get-url origin >/dev/null 2>&1; then
    subctl_die "no 'origin' remote configured — can't pull updates"
  fi

  # The local checkout may be on a branch that doesn't exist on origin
  # (e.g. a local-only feat/ branch the operator created, or a dev-team
  # worker's fix/* branch that never got pushed). Without this guard
  # `git fetch origin <branch>` dies with "couldn't find remote ref"
  # and update aborts. Detect that case and fall back to main.
  # Diagnosed 2026-05-10: dev team worker had created
  # fix/watchdog-skip-dead-sessions locally; subctl update on the M3
  # Ultra broke until we manually checked out main.
  if ! git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    subctl_warn "branch '$branch' doesn't exist on origin — falling back to main"
    if [[ "$current_branch" != "main" ]]; then
      subctl_info "switching local checkout from '$current_branch' to 'main' (your work on '$current_branch' is preserved as a local branch)"
      if ! git checkout main 2>&1 | tail -2; then
        subctl_die "checkout main failed — resolve manually then re-run"
      fi
      current_branch="main"
    fi
    branch="main"
  fi

  # Working-tree cleanliness check
  local stashed=false
  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    if $force; then
      subctl_warn "working tree dirty — stashing (will restore after update)"
      git stash push -u -m "subctl-update-$(date +%s)" >/dev/null 2>&1 && stashed=true
    else
      subctl_err "working tree has uncommitted changes — commit, stash, or pass --force"
      git status -sb | head -20
      return 1
    fi
  fi

  # ── 2. fetch + fast-forward ───────────────────────────────────────────────
  local current_sha new_sha old_version new_version
  current_sha=$(git rev-parse HEAD)
  old_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")

  subctl_info "fetching origin..."
  if ! git fetch --quiet origin "$branch"; then
    subctl_err "git fetch failed"
    $stashed && git stash pop >/dev/null 2>&1
    return 2
  fi

  # Are we already on $branch?
  if [[ "$current_branch" != "$branch" ]]; then
    subctl_info "switching from $current_branch → $branch"
    if ! git checkout "$branch" 2>&1 | tail -3; then
      subctl_err "checkout failed"
      $stashed && git stash pop >/dev/null 2>&1
      return 2
    fi
  fi

  # Fast-forward
  if ! git merge --ff-only "origin/$branch" >/dev/null 2>&1; then
    subctl_err "fast-forward failed — local branch $branch has commits not on origin/$branch"
    subctl_info "to force update: git reset --hard origin/$branch  (loses local commits)"
    $stashed && git stash pop >/dev/null 2>&1
    return 2
  fi
  new_sha=$(git rev-parse HEAD)

  if [[ "$current_sha" == "$new_sha" ]]; then
    subctl_ok "already up to date ($branch @ ${current_sha:0:8})"
    $stashed && git stash pop >/dev/null 2>&1 && subctl_info "stash restored"
    return 0
  fi

  new_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  if [[ "$old_version" != "$new_version" ]]; then
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${old_version} → v${new_version}, $(git rev-list --count "$current_sha".."$new_sha") commits)"
  else
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${new_version}, $(git rev-list --count "$current_sha".."$new_sha") commits)"
  fi
  echo
  subctl_info "summary of incoming commits:"
  git log --oneline "$current_sha".."$new_sha" | head -15
  echo

  # ── 3. bun install where package.json changed ─────────────────────────────
  local changed_pkg_dirs
  changed_pkg_dirs=$(git diff --name-only "$current_sha".."$new_sha" -- '**/package.json' 2>/dev/null | xargs -n1 dirname 2>/dev/null | sort -u)
  if [[ -n "$changed_pkg_dirs" ]]; then
    if subctl_have bun; then
      while IFS= read -r d; do
        [[ -z "$d" || ! -f "$SUBCTL_REPO_ROOT/$d/package.json" ]] && continue
        subctl_info "bun install in $d (package.json changed)"
        (cd "$SUBCTL_REPO_ROOT/$d" && bun install --silent) || subctl_warn "bun install in $d failed (continuing)"
      done <<< "$changed_pkg_dirs"
    else
      subctl_warn "package.json changed in: $changed_pkg_dirs"
      subctl_warn "  bun is not on PATH — install: curl -fsSL https://bun.sh/install | bash"
    fi
  fi

  # ── 4. restart launchd services ────────────────────────────────────────────
  if $no_restart; then
    subctl_info "--no-restart: skipping service bounce"
  else
    local restarted_any=false
    for label in com.subctl.master com.subctl.dashboard; do
      local plist="$HOME/Library/LaunchAgents/${label}.plist"
      if [[ -f "$plist" ]] && launchctl list | awk '{print $3}' | grep -qx "$label"; then
        subctl_info "restarting $label"
        launchctl unload "$plist" 2>/dev/null || true
        # Wait briefly so the SIGTERM's transcript-flush completes
        local i=0
        while pgrep -f "$label" >/dev/null 2>&1 && [[ $i -lt 5 ]]; do
          sleep 1; i=$((i+1))
        done
        if ! launchctl load "$plist" 2>&1 | tail -3; then
          subctl_err "failed to reload $label"
          continue
        fi
        restarted_any=true
      fi
    done
    if ! $restarted_any; then
      subctl_info "no subctl launchd services running — nothing to restart"
    else
      subctl_ok "services restarted"
    fi
  fi

  # ── 5. restore stash + run doctor ─────────────────────────────────────────
  if $stashed; then
    if git stash pop >/dev/null 2>&1; then
      subctl_info "stash restored"
    else
      subctl_warn "stash pop had conflicts — your changes are still in `git stash list`, resolve manually"
    fi
  fi

  if [[ -x "$SUBCTL_REPO_ROOT/bin/subctl" ]]; then
    echo
    subctl_info "running subctl doctor..."
    "$SUBCTL_REPO_ROOT/bin/subctl" doctor 2>&1 | tail -20 || true
  fi
  return 0
}
