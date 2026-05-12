#!/usr/bin/env bash
# lib/update.sh — `subctl update`: pull origin/main and apply.
#
# Mirrors ArgentOS's update flow: stop services, fetch + fast-forward,
# bun install / build if anything dependency-y changed, restart services,
# run subctl doctor on the way out. Safe by default — refuses to update
# if the working tree has uncommitted changes (override with --force).
#
# v2.7.5: prints a version-state block BEFORE the working-tree check (so
# the operator sees current+remote even on aborted updates), and silently
# auto-stashes lockfile-only drift (bun.lock platform-hash rewrites are
# normal and shouldn't require --force).

[[ -n "${_SUBCTL_UPDATE_LOADED:-}" ]] && return 0
_SUBCTL_UPDATE_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# ── lockfile classification helpers ──────────────────────────────────────────
# Exposed (underscore-prefixed) so lib/__tests__/update.test.ts can source
# update.sh and exercise them directly without booting the full update flow.

# _subctl_update_is_lockfile <path> → exit 0 if path's basename matches a
# package-manager lockfile we know rewrites itself across machines.
# NARROW carve-out: bun / npm / yarn / pnpm only. Cargo.lock, Gemfile.lock,
# poetry.lock, etc. are NOT in this list — those projects historically
# expect deterministic lockfiles and dirty drift there is a real signal.
_subctl_update_is_lockfile() {
  local base="${1##*/}"
  case "$base" in
    bun.lock|bun.lockb|package-lock.json|yarn.lock|pnpm-lock.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

# _subctl_update_classify_dirty "<git status --porcelain output>"
# Prints exactly one of:
#   "clean"
#   "lockfile-only|<path1>|<path2>|..."
#   "mixed|<non_lockfile_count>"
# Single-line, pipe-separated so callers can parse without re-running git.
_subctl_update_classify_dirty() {
  local porcelain="$1"
  if [[ -z "$porcelain" ]]; then
    printf "clean"
    return 0
  fi
  local lockfiles=() non_lock=0 line path
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # porcelain row: XY<space><path>  (rename: XY<space><old> -> <new>)
    path="${line:3}"
    [[ "$path" == *" -> "* ]] && path="${path##* -> }"
    if _subctl_update_is_lockfile "$path"; then
      lockfiles+=("$path")
    else
      non_lock=$((non_lock + 1))
    fi
  done <<< "$porcelain"
  if (( non_lock > 0 )); then
    printf "mixed|%d" "$non_lock"
  else
    local _ifs="$IFS"; IFS='|'
    printf "lockfile-only|%s" "${lockfiles[*]}"
    IFS="$_ifs"
  fi
}

# _subctl_update_pop_stash <kind>
# kind=lockfile → "auto-stashed lockfile restored"
# kind=force    → "stash restored"
# On conflict: prints structured guidance about resolving the lockfile.
_subctl_update_pop_stash() {
  local kind="${1:-force}"
  if git stash pop >/dev/null 2>&1; then
    case "$kind" in
      lockfile) subctl_info "auto-stashed lockfile restored" ;;
      *)        subctl_info "stash restored" ;;
    esac
    return 0
  fi
  subctl_err "stash pop conflict on lockfile — stash@{0} contains your old lockfile;"
  printf "   inspect: git stash show -p stash@{0}\n"
  printf "   abandon: git stash drop stash@{0}\n"
  printf "   accept the new lockfile (from origin) as-is: git checkout --theirs <lockfile>\n"
  return 1
}

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
    1. Print version state (current vs remote) — always, even on abort
    2. Verify clean working tree (lockfile-only drift auto-stashes; pass
       --force to stash anything else)
    3. git fetch + fast-forward to origin/<branch> (default: current branch,
       falls back to main)
    4. bun install in dirs whose package.json changed
    5. Restart master + dashboard launchd jobs (skip with --no-restart)
    6. subctl doctor

Options:
  -f, --force        Update even if the working tree has uncommitted changes
                     (stashes first, restores after; you may need to resolve
                     conflicts manually). Lockfile-only drift auto-stashes
                     without --force.
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
    subctl_die "$SUBCTL_REPO_ROOT is not a git repo — \`subctl update\` only works on a cloned install"
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

  # ── 2. version state — printed BEFORE the working-tree check ──────────────
  # `git fetch` is read-only at the working-tree level (it just updates
  # remote-tracking refs) so it's safe to run before the cleanliness gate.
  # Running it here means the operator sees current+remote even when the
  # update can't proceed — historically the dirty-tree abort hid both.
  local current_sha current_version remote_sha remote_version
  current_sha=$(git rev-parse HEAD 2>/dev/null || true)
  current_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  [[ -z "$current_version" ]] && current_version="?"

  subctl_info "fetching origin..."
  if ! git fetch --quiet origin "$branch"; then
    subctl_err "git fetch failed"
    return 2
  fi

  remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || true)
  remote_version=$(git show "origin/$branch:VERSION" 2>/dev/null | tr -d '[:space:]')
  [[ -z "$remote_version" ]] && remote_version="?"

  local ahead_count=0 behind_count=0
  if [[ -n "$current_sha" && -n "$remote_sha" ]]; then
    ahead_count=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo "0")
    behind_count=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo "0")
  fi

  echo
  printf "%s==>%s subctl update — version state\n" "$C_CYN" "$C_RST"
  printf "    current: v%s (%s)\n" "$current_version" "${current_sha:0:8}"
  printf "    branch:  %s\n" "$branch"
  if [[ -z "$remote_sha" ]]; then
    printf "    remote:  unknown — couldn't read origin/%s\n" "$branch"
  elif [[ "$current_sha" == "$remote_sha" ]]; then
    printf "    remote:  same — already up to date\n"
  elif (( ahead_count > 0 && behind_count == 0 )); then
    printf "    remote:  v%s (%s) — local is %d commits AHEAD of remote\n" \
      "$remote_version" "${remote_sha:0:8}" "$ahead_count"
  elif (( behind_count > 0 && ahead_count == 0 )); then
    printf "    remote:  v%s (%s) — %d commits ahead\n" \
      "$remote_version" "${remote_sha:0:8}" "$behind_count"
  else
    printf "    remote:  v%s (%s) — diverged (%d ahead / %d behind)\n" \
      "$remote_version" "${remote_sha:0:8}" "$ahead_count" "$behind_count"
  fi
  echo

  # Fast-exit if already up to date — there's nothing to merge, and we
  # don't want to risk a stash dance just to no-op the merge.
  if [[ -n "$current_sha" && "$current_sha" == "$remote_sha" ]]; then
    subctl_ok "already up to date ($branch @ ${current_sha:0:8})"
    return 0
  fi

  # ── 3. working-tree cleanliness — lockfile-only carve-out ─────────────────
  # NARROW: bun.lock / package-lock.json / yarn.lock / pnpm-lock.yaml only.
  # If only these are dirty, silently auto-stash + restore (no --force
  # required). Anything else → require --force, same as before.
  local stashed=false stash_kind=""
  local porcelain
  porcelain=$(git status --porcelain 2>/dev/null)
  local classification
  classification=$(_subctl_update_classify_dirty "$porcelain")

  case "$classification" in
    clean)
      : ;;  # nothing to do
    lockfile-only*)
      local lockfile_csv="${classification#lockfile-only|}"
      local _ifs_save="$IFS"
      IFS='|' read -ra _lockfile_paths <<< "$lockfile_csv"
      IFS="$_ifs_save"
      subctl_info "dirty lockfile detected (bun lockfile drift is normal across machines)"
      local _lf
      for _lf in "${_lockfile_paths[@]}"; do
        printf "    auto-stashing: %s\n" "$_lf"
      done
      printf "    will restore after update\n"
      # `-u` so a (rare) untracked lockfile is also captured. The pathspec
      # restricts the stash to lockfiles only — siblings stay in place.
      if git stash push -u -m "subctl-update-lockfile-$(date +%s)" -- "${_lockfile_paths[@]}" >/dev/null 2>&1; then
        stashed=true
        stash_kind="lockfile"
      else
        subctl_err "auto-stash of lockfile failed — commit or stash manually then retry"
        return 1
      fi
      ;;
    mixed*)
      if $force; then
        subctl_warn "working tree dirty — stashing (will restore after update)"
        if git stash push -u -m "subctl-update-$(date +%s)" >/dev/null 2>&1; then
          stashed=true
          stash_kind="force"
        fi
      else
        subctl_err "working tree has uncommitted changes — commit, stash, or pass --force"
        git status -sb | head -20
        return 1
      fi
      ;;
  esac

  # ── 4. checkout + fast-forward ────────────────────────────────────────────
  if [[ "$current_branch" != "$branch" ]]; then
    subctl_info "switching from $current_branch → $branch"
    if ! git checkout "$branch" 2>&1 | tail -3; then
      subctl_err "checkout failed"
      $stashed && _subctl_update_pop_stash "$stash_kind"
      return 2
    fi
  fi

  if ! git merge --ff-only "origin/$branch" >/dev/null 2>&1; then
    subctl_err "fast-forward failed — local branch $branch has commits not on origin/$branch"
    subctl_info "to force update: git reset --hard origin/$branch  (loses local commits)"
    $stashed && _subctl_update_pop_stash "$stash_kind"
    return 2
  fi
  local new_sha
  new_sha=$(git rev-parse HEAD)

  local new_version
  new_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  if [[ "$current_version" != "$new_version" ]]; then
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${current_version} → v${new_version}, $(git rev-list --count "$current_sha".."$new_sha") commits)"
  else
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${new_version}, $(git rev-list --count "$current_sha".."$new_sha") commits)"
  fi
  echo
  subctl_info "summary of incoming commits:"
  git log --oneline "$current_sha".."$new_sha" | head -15
  echo

  # ── 5. bun install where package.json changed ─────────────────────────────
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

  # ── 6. restart launchd services ───────────────────────────────────────────
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

  # ── 7. restore stash + run doctor ─────────────────────────────────────────
  if $stashed; then
    _subctl_update_pop_stash "$stash_kind"
  fi

  if [[ -x "$SUBCTL_REPO_ROOT/bin/subctl" ]]; then
    echo
    subctl_info "running subctl doctor..."
    "$SUBCTL_REPO_ROOT/bin/subctl" doctor 2>&1 | tail -20 || true
  fi
  return 0
}
