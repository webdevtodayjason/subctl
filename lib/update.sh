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
#
# v2.7.6: argent-style polish.
#   1. `subctl update status` — read-only version/channel/state probe.
#   2. `--channel stable|beta|dev` — persisted to ~/.config/subctl/config.toml.
#   3. `--json` — machine-readable single-document output.
#   4. `--yes` — auto-confirm interactive prompts (downgrade, channel switch).
#       Distinct from `--force`, which still gates the dirty-tree stash.
#   5. `--timeout <s>` — per-step timeout (default 1200); wraps fetch/merge/
#       bun install with a portable perl-based timer.
#   6. Friendly --help with What/Channels/Non-interactive/Examples/Notes/Docs.

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

# ── v2.7.6 helpers ───────────────────────────────────────────────────────────

# Channel → branch mapping. Returns 1 (and prints nothing) on unknown channel.
_subctl_update_channel_to_branch() {
  case "${1:-}" in
    stable) printf "main"  ;;
    beta)   printf "beta"  ;;
    dev)    printf "dev"   ;;
    *)      return 1       ;;
  esac
}

_subctl_update_is_valid_channel() {
  case "${1:-}" in
    stable|beta|dev) return 0 ;;
    *)               return 1 ;;
  esac
}

# Read [update].channel from $SUBCTL_CONFIG_DIR/config.toml. Falls back to
# "stable" silently (missing file or missing key both mean default channel).
_subctl_update_load_channel() {
  local conf="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}/config.toml"
  if [[ ! -f "$conf" ]]; then
    printf "stable"
    return 0
  fi
  local val
  val=$(awk -F= '
    /^\[/ { sect=$0; next }
    sect=="[update]" && $1 ~ /^[[:space:]]*channel[[:space:]]*$/ {
      v=$2
      gsub(/[[:space:]"'\'']/, "", v)
      print v
      exit
    }
  ' "$conf" 2>/dev/null)
  if [[ -z "$val" ]] || ! _subctl_update_is_valid_channel "$val"; then
    printf "stable"
  else
    printf "%s" "$val"
  fi
}

# Read [update].last_run timestamp. Empty if absent.
_subctl_update_load_last_run() {
  local conf="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}/config.toml"
  [[ -f "$conf" ]] || return 0
  awk -F= '
    /^\[/ { sect=$0; next }
    sect=="[update]" && $1 ~ /^[[:space:]]*last_run[[:space:]]*$/ {
      v=$2
      gsub(/[[:space:]"'\'']/, "", v)
      print v
      exit
    }
  ' "$conf" 2>/dev/null
}

# Set a key=value under [update] in config.toml. Creates file/section as needed.
# Usage: _subctl_update_set_config_key <key> <value>
_subctl_update_set_config_key() {
  local key="$1" val="$2"
  local dir="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}"
  local conf="$dir/config.toml"
  mkdir -p "$dir"
  if [[ ! -f "$conf" ]]; then
    printf "[update]\n%s = \"%s\"\n" "$key" "$val" > "$conf"
    return 0
  fi
  if ! grep -q '^\[update\]' "$conf"; then
    printf "\n[update]\n%s = \"%s\"\n" "$key" "$val" >> "$conf"
    return 0
  fi
  local tmp="${conf}.tmp.$$"
  awk -v k="$key" -v v="$val" '
    BEGIN { in_update=0; replaced=0 }
    /^\[/ {
      if (in_update && !replaced) {
        printf "%s = \"%s\"\n", k, v
        replaced=1
      }
      in_update = ($0 == "[update]") ? 1 : 0
      print
      next
    }
    in_update && $0 ~ "^[[:space:]]*" k "[[:space:]]*=" {
      if (!replaced) {
        printf "%s = \"%s\"\n", k, v
        replaced=1
      }
      next
    }
    { print }
    END {
      if (in_update && !replaced) {
        printf "%s = \"%s\"\n", k, v
      }
    }
  ' "$conf" > "$tmp" && mv "$tmp" "$conf"
}

_subctl_update_persist_channel() {
  _subctl_update_set_config_key "channel" "$1"
}

# Portable per-step timeout. Falls back to `timeout`/`gtimeout` when present,
# else uses perl's alarm (shipped on every macOS since forever). Returns 124
# on timeout to match GNU `timeout` convention.
#
# Special case: secs=0 means "no timeout" — run the command unwrapped. This
# is how the existing v2.7.5 paths look (no wrapping) and is what we use
# when --timeout is omitted.
_subctl_update_with_timeout() {
  local secs="${1:-0}"; shift
  if [[ "$secs" == "0" ]]; then
    "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  # perl fallback: alarm(SECS) then exec — SIGALRM kills the exec'd child.
  # We translate the SIGALRM exit (128+14 = 142) to 124 so callers can
  # rely on a single timeout sentinel.
  perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV' "$secs" "$@"
  local rc=$?
  [[ "$rc" == "142" ]] && rc=124
  return $rc
}

# Compare two semver-ish strings.
# Prints "older" / "equal" / "newer" describing how $1 relates to $2.
# Uses `sort -V` so it handles "2.7.4" / "2.7.5" / "2.7.6-dev" sensibly.
_subctl_update_version_cmp() {
  local a="$1" b="$2"
  if [[ "$a" == "$b" ]]; then printf "equal"; return 0; fi
  local first
  first=$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)
  if [[ "$first" == "$a" ]]; then
    printf "older"
  else
    printf "newer"
  fi
}

# ── JSON output state ────────────────────────────────────────────────────────
# These are populated as the update flow progresses, then serialized at the
# end when --json is in play. Shell globals are fine here — subctl_update is
# never called re-entrantly and we reset them at the top of every call.

_subctl_update_reset_json_state() {
  _SUBCTL_UPDATE_JSON=false
  _SUBCTL_UPDATE_FROM_VERSION=""
  _SUBCTL_UPDATE_FROM_SHA=""
  _SUBCTL_UPDATE_TO_VERSION=""
  _SUBCTL_UPDATE_TO_SHA=""
  _SUBCTL_UPDATE_CHANNEL=""
  _SUBCTL_UPDATE_COMMITS_APPLIED=0
  _SUBCTL_UPDATE_LOCKFILE_STASHED=false
  _SUBCTL_UPDATE_SERVICES_RESTARTED=()
  _SUBCTL_UPDATE_DOCTOR_WARNINGS=0
  _SUBCTL_UPDATE_STAGE=""
  _SUBCTL_UPDATE_ERROR=""
}

# JSON-escape a string. Handles backslash, quote, newline, tab.
_subctl_update_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf "%s" "$s"
}

# Serialize the JSON document to the saved stdout (fd 8). Called only when
# --json was requested. Caller passes the final rc.
_subctl_update_emit_json() {
  local rc="$1"
  local services_json="["
  local first=true s
  # nounset-safe array expansion: ${arr[@]+"${arr[@]}"} is the canonical
  # idiom for "expand only if defined", since "${arr[@]:-}" doesn't work
  # correctly for empty arrays under `set -u`.
  for s in ${_SUBCTL_UPDATE_SERVICES_RESTARTED[@]+"${_SUBCTL_UPDATE_SERVICES_RESTARTED[@]}"}; do
    $first || services_json+=","
    services_json+="\"$(_subctl_update_json_escape "$s")\""
    first=false
  done
  services_json+="]"

  local err_esc
  err_esc=$(_subctl_update_json_escape "$_SUBCTL_UPDATE_ERROR")
  local lockfile_stashed_str="false"
  $_SUBCTL_UPDATE_LOCKFILE_STASHED && lockfile_stashed_str="true"

  # Caller must restore stdout to the operator BEFORE calling this — we
  # write to fd 1 unconditionally so this works for both --json (where the
  # caller did exec 1>&8) and any future non-redirected use.
  if [[ "$rc" == "0" ]]; then
    printf '{"ok":true,"from":{"version":"%s","sha":"%s"},"to":{"version":"%s","sha":"%s"},"channel":"%s","commits_applied":%d,"lockfile_stashed":%s,"services_restarted":%s,"doctor_warnings":%d}\n' \
      "$_SUBCTL_UPDATE_FROM_VERSION" "$_SUBCTL_UPDATE_FROM_SHA" \
      "$_SUBCTL_UPDATE_TO_VERSION" "$_SUBCTL_UPDATE_TO_SHA" \
      "$_SUBCTL_UPDATE_CHANNEL" \
      "$_SUBCTL_UPDATE_COMMITS_APPLIED" "$lockfile_stashed_str" \
      "$services_json" "$_SUBCTL_UPDATE_DOCTOR_WARNINGS"
  else
    printf '{"ok":false,"error":"%s","stage":"%s"}\n' \
      "$err_esc" "$_SUBCTL_UPDATE_STAGE"
  fi
}

# Emit a JSON error and bail. Returns the supplied rc.
_subctl_update_fail_json() {
  local stage="$1" msg="$2" rc="${3:-1}"
  _SUBCTL_UPDATE_STAGE="$stage"
  _SUBCTL_UPDATE_ERROR="$msg"
  return "$rc"
}

# ── `subctl update --help` (v2.7.6, argent-style) ────────────────────────────
_subctl_update_print_help() {
  cat <<'EOF'
subctl update [options]
subctl update status [options]

  Pull the latest subctl from origin and apply it.

Options:
  -f, --force          Update even if the working tree has uncommitted changes
                       (stashes first, restores after). Lockfile-only drift
                       auto-stashes without --force.
  -b, --branch <name>  Update from a specific branch (overrides --channel).
  --channel <c>        Track stable | beta | dev. Persists to
                       ~/.config/subctl/config.toml as the new default.
  --no-restart         Don't bounce the launchd services after pulling.
  --yes                Auto-confirm interactive prompts (downgrade, channel
                       switch). Independent of --force.
  --json               Emit a single JSON document instead of human output.
  --timeout <secs>     Per-step timeout in seconds (default: 1200). Wraps
                       git fetch, git merge, and bun install.
  -h, --help           Show this help and exit.

What this does:
  1. Print version state (current vs remote) — always, even on abort.
  2. Verify clean working tree; lockfile-only drift auto-stashes,
     anything else requires --force.
  3. git fetch + fast-forward to origin/<channel-branch>.
  4. bun install in dirs whose package.json changed.
  5. Restart master + dashboard launchd jobs (skip with --no-restart).
  6. subctl doctor.

Switch channels:
  subctl update --channel beta            # persist + use beta for this run
  subctl update --channel stable          # back to main / stable
  subctl update status                    # see current channel + state

Non-interactive:
  Combine --yes (auto-confirm), --json (machine output), and --timeout for
  CI / automation. Downgrade and channel-switch prompts respect --yes.

Examples:
  subctl update                           # the usual: ff-merge origin/main
  subctl update status                    # show version, channel, drift — no fetch-pull
  subctl update --channel beta            # switch to beta channel and pull
  subctl update --json                    # emit JSON document, suppress logs
  subctl update --yes --json              # CI-friendly: no prompts, parseable
  subctl update --timeout 60 --no-restart # bounded run, don't touch launchd

Notes:
  - Back-compat: `subctl update` with no flags behaves identically to v2.7.5.
  - Lockfile-only drift (bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml)
    auto-stashes without --force. Cargo.lock / Gemfile.lock / poetry.lock are
    NOT in the carve-out.
  - Downgrades (remote_version < current_version) prompt for confirmation
    unless --yes is passed.
  - `status` is read-only — never fetches a new tip, never modifies state.

Exit codes:
  0  updated cleanly (or already up to date)
  1  pre-flight failure (dirty tree, no remote, bad flag, etc.)
  2  fetch / merge / timeout failed
  3  service restart failed

Docs: https://subctl.com/docs/update
EOF
}

# ── `subctl update status` — read-only ───────────────────────────────────────
_subctl_update_status() {
  local channel="" json=false timeout=1200
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --channel)  channel="${2:-}"; shift 2 ;;
      --json)     json=true; shift ;;
      --timeout)  timeout="${2:-1200}"; shift 2 ;;
      -h|--help)  _subctl_update_print_help; return 0 ;;
      *)          subctl_err "unknown 'update status' flag: $1"; return 1 ;;
    esac
  done

  cd "$SUBCTL_REPO_ROOT" || { subctl_err "cannot cd to $SUBCTL_REPO_ROOT"; return 1; }

  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
    if $json; then
      printf '{"ok":false,"error":"not a git repo","stage":"preflight"}\n'
    else
      subctl_err "$SUBCTL_REPO_ROOT is not a git repo — \`subctl update status\` only works on a cloned install"
    fi
    return 1
  fi

  local stored_channel resolved_channel branch
  stored_channel=$(_subctl_update_load_channel)
  resolved_channel="${channel:-$stored_channel}"
  if ! _subctl_update_is_valid_channel "$resolved_channel"; then
    if $json; then
      printf '{"ok":false,"error":"unknown channel: %s","stage":"preflight"}\n' "$resolved_channel"
    else
      subctl_err "unknown channel '$resolved_channel' — pick one of: stable, beta, dev"
    fi
    return 1
  fi
  branch=$(_subctl_update_channel_to_branch "$resolved_channel")

  local current_sha current_short current_version
  current_sha=$(git rev-parse HEAD 2>/dev/null || true)
  current_short="${current_sha:0:8}"
  current_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  [[ -z "$current_version" ]] && current_version="?"

  local remote_sha="" remote_version="" remote_state="unknown"
  if git remote get-url origin >/dev/null 2>&1; then
    if _subctl_update_with_timeout "$timeout" git fetch --quiet origin "$branch" 2>/dev/null; then
      remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || true)
      remote_version=$(git show "origin/$branch:VERSION" 2>/dev/null | tr -d '[:space:]')
      [[ -z "$remote_version" ]] && remote_version="?"
      if [[ -z "$remote_sha" ]]; then
        remote_state="unreachable"
      elif [[ "$current_sha" == "$remote_sha" ]]; then
        remote_state="up-to-date"
      else
        local ahead behind
        ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo 0)
        behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
        if (( ahead > 0 && behind == 0 )); then
          remote_state="local-ahead:$ahead"
        elif (( behind > 0 && ahead == 0 )); then
          remote_state="behind:$behind"
        else
          remote_state="diverged:$ahead/$behind"
        fi
      fi
    else
      remote_state="unreachable"
    fi
  else
    remote_state="no-origin"
  fi

  local last_run
  last_run=$(_subctl_update_load_last_run)

  local channel_label="$resolved_channel"
  [[ "$resolved_channel" == "stable" ]] && channel_label="stable (default)"

  if $json; then
    local last_run_field="null"
    [[ -n "$last_run" ]] && last_run_field="\"$(_subctl_update_json_escape "$last_run")\""
    printf '{"ok":true,"version":"%s","sha":"%s","branch":"%s","channel":"%s","remote":{"version":"%s","sha":"%s","state":"%s"},"last_update":%s}\n' \
      "$current_version" "$current_short" "$branch" "$resolved_channel" \
      "$remote_version" "${remote_sha:0:8}" "$remote_state" "$last_run_field"
    return 0
  fi

  printf "subctl %s (%s)\n" "$current_version" "$current_short"
  printf "  branch:   %s\n" "$branch"
  printf "  channel:  %s\n" "$channel_label"
  case "$remote_state" in
    up-to-date)
      printf "  remote:   v%s (%s) — up to date\n" "$remote_version" "${remote_sha:0:8}" ;;
    behind:*)
      printf "  remote:   v%s (%s) — %s commits ahead\n" "$remote_version" "${remote_sha:0:8}" "${remote_state#behind:}" ;;
    local-ahead:*)
      printf "  remote:   v%s (%s) — local is %s commits AHEAD\n" "$remote_version" "${remote_sha:0:8}" "${remote_state#local-ahead:}" ;;
    diverged:*)
      local pair="${remote_state#diverged:}"
      printf "  remote:   v%s (%s) — diverged (%s ahead / %s behind)\n" \
        "$remote_version" "${remote_sha:0:8}" "${pair%/*}" "${pair#*/}" ;;
    no-origin)
      printf "  remote:   (no 'origin' remote configured)\n" ;;
    unreachable)
      printf "  remote:   (could not reach origin/%s)\n" "$branch" ;;
    *)
      printf "  remote:   %s\n" "$remote_state" ;;
  esac
  if [[ -n "$last_run" ]]; then
    printf "  last update: %s\n" "$last_run"
  else
    printf "  last update: (never recorded)\n"
  fi
  return 0
}

# Stub: documented in --help; can be elaborated later.
_subctl_update_wizard() {
  subctl_info "update wizard not yet implemented (v2.7.6 stub)"
  subctl_info "for now: run \`subctl update status\` then \`subctl update --channel <c>\`"
  return 0
}

# ── main update flow ─────────────────────────────────────────────────────────
subctl_update() {
  _subctl_update_reset_json_state

  # ── subcommand dispatch ──────────────────────────────────────────────────
  case "${1:-}" in
    status)  shift; _subctl_update_status "$@"; return $? ;;
    wizard)  shift; _subctl_update_wizard "$@"; return $? ;;
  esac

  local force=false branch="" no_restart=false
  local channel="" channel_was_passed=false
  local yes=false json=false timeout=1200

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--force)      force=true; shift ;;
      -b|--branch)     branch="${2:-}"; shift 2 ;;
      --no-restart)    no_restart=true; shift ;;
      --channel)
        channel="${2:-}"
        channel_was_passed=true
        if ! _subctl_update_is_valid_channel "$channel"; then
          subctl_err "unknown channel '$channel' — pick one of: stable, beta, dev"
          return 1
        fi
        shift 2 ;;
      --yes)           yes=true; shift ;;
      --json)          json=true; shift ;;
      --timeout)
        timeout="${2:-}"
        if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
          subctl_err "--timeout requires a non-negative integer (got '$timeout')"
          return 1
        fi
        shift 2 ;;
      -h|--help)       _subctl_update_print_help; return 0 ;;
      *) subctl_die "unknown update flag: $1 (try -h)" ;;
    esac
  done

  _SUBCTL_UPDATE_JSON=$json

  # Resolve channel (CLI > config > default). Branch override (-b) wins
  # over channel mapping — operators sometimes want a one-off branch test.
  local resolved_channel
  if [[ -n "$channel" ]]; then
    resolved_channel="$channel"
    if $channel_was_passed; then
      _subctl_update_persist_channel "$channel"
      $json || subctl_info "channel set to '$channel' (persisted to ~/.config/subctl/config.toml)"
    fi
  else
    resolved_channel=$(_subctl_update_load_channel)
  fi
  _SUBCTL_UPDATE_CHANNEL="$resolved_channel"

  # If --branch was NOT passed, derive from channel.
  if [[ -z "$branch" ]]; then
    branch=$(_subctl_update_channel_to_branch "$resolved_channel")
  fi

  # ── JSON output dance ────────────────────────────────────────────────────
  # When --json is set, swap stdout/stderr to /dev/null and stash the real
  # fds in 8/9 so _subctl_update_emit_json can write the final document to
  # the operator. Every code path below funnels through _subctl_update_main
  # which returns an rc we emit.
  if $json; then
    exec 8>&1 9>&2 >/dev/null 2>/dev/null
    _subctl_update_main "$force" "$branch" "$no_restart" "$resolved_channel" "$yes" "$timeout"
    local rc=$?
    exec 1>&8 8>&- 2>&9 9>&-
    _subctl_update_emit_json "$rc"
    return $rc
  fi

  _subctl_update_main "$force" "$branch" "$no_restart" "$resolved_channel" "$yes" "$timeout"
}

# Args (positional, all required): force branch no_restart channel yes timeout
_subctl_update_main() {
  local force="$1" branch="$2" no_restart="$3" resolved_channel="$4" yes="$5" timeout="$6"

  cd "$SUBCTL_REPO_ROOT" || { _SUBCTL_UPDATE_STAGE="preflight"; _SUBCTL_UPDATE_ERROR="cannot cd to $SUBCTL_REPO_ROOT"; subctl_err "cannot cd to $SUBCTL_REPO_ROOT"; return 1; }

  # ── 1. preflight ──────────────────────────────────────────────────────────
  _SUBCTL_UPDATE_STAGE="preflight"
  if ! command -v git >/dev/null 2>&1; then
    _SUBCTL_UPDATE_ERROR="missing required command: git"
    subctl_err "missing required command: git"
    subctl_err "  install: brew install git"
    return 1
  fi
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    _SUBCTL_UPDATE_ERROR="$SUBCTL_REPO_ROOT is not a git repo"
    subctl_err "$SUBCTL_REPO_ROOT is not a git repo — \`subctl update\` only works on a cloned install"
    return 1
  fi

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  [[ -z "$branch" ]] && branch="${current_branch:-main}"

  if ! git remote get-url origin >/dev/null 2>&1; then
    _SUBCTL_UPDATE_ERROR="no 'origin' remote configured"
    subctl_err "no 'origin' remote configured — can't pull updates"
    return 1
  fi

  # The local checkout may be on a branch that doesn't exist on origin
  # (e.g. a local-only feat/ branch the operator created, or a dev-team
  # worker's fix/* branch that never got pushed). Without this guard
  # `git fetch origin <branch>` dies with "couldn't find remote ref"
  # and update aborts. Detect that case and fall back to main.
  if ! git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    subctl_warn "branch '$branch' doesn't exist on origin — falling back to main"
    if [[ "$current_branch" != "main" ]]; then
      subctl_info "switching local checkout from '$current_branch' to 'main' (your work on '$current_branch' is preserved as a local branch)"
      if ! git checkout main 2>&1 | tail -2; then
        _SUBCTL_UPDATE_ERROR="checkout main failed"
        subctl_err "checkout main failed — resolve manually then re-run"
        return 1
      fi
      current_branch="main"
    fi
    branch="main"
  fi

  # ── 2. version state — printed BEFORE the working-tree check ──────────────
  _SUBCTL_UPDATE_STAGE="fetch"
  local current_sha current_version remote_sha remote_version
  current_sha=$(git rev-parse HEAD 2>/dev/null || true)
  current_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  [[ -z "$current_version" ]] && current_version="?"
  _SUBCTL_UPDATE_FROM_VERSION="$current_version"
  _SUBCTL_UPDATE_FROM_SHA="${current_sha:0:8}"

  subctl_info "fetching origin..."
  # NB: capture $? BEFORE the if-check — `if ! cmd; then $?` is 0 (the
  # negation, not cmd's real exit). Same trick is used at merge / bun install.
  _subctl_update_with_timeout "$timeout" git fetch --quiet origin "$branch"
  local _fetch_rc=$?
  if [[ "$_fetch_rc" -ne 0 ]]; then
    if [[ "$_fetch_rc" == "124" ]]; then
      _SUBCTL_UPDATE_ERROR="timeout after ${timeout}s during git fetch"
      subctl_err "git fetch timed out after ${timeout}s"
    else
      _SUBCTL_UPDATE_ERROR="git fetch failed"
      subctl_err "git fetch failed"
    fi
    return 2
  fi

  remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || true)
  remote_version=$(git show "origin/$branch:VERSION" 2>/dev/null | tr -d '[:space:]')
  [[ -z "$remote_version" ]] && remote_version="?"
  _SUBCTL_UPDATE_TO_VERSION="$remote_version"
  _SUBCTL_UPDATE_TO_SHA="${remote_sha:0:8}"

  local ahead_count=0 behind_count=0
  if [[ -n "$current_sha" && -n "$remote_sha" ]]; then
    ahead_count=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || echo "0")
    behind_count=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo "0")
  fi

  echo
  printf "%s==>%s subctl update — version state\n" "$C_CYN" "$C_RST"
  printf "    current: v%s (%s)\n" "$current_version" "${current_sha:0:8}"
  printf "    branch:  %s\n" "$branch"
  printf "    channel: %s\n" "$resolved_channel"
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

  # Fast-exit if already up to date.
  if [[ -n "$current_sha" && "$current_sha" == "$remote_sha" ]]; then
    subctl_ok "already up to date ($branch @ ${current_sha:0:8})"
    _SUBCTL_UPDATE_TO_VERSION="$current_version"
    _SUBCTL_UPDATE_TO_SHA="${current_sha:0:8}"
    return 0
  fi

  # ── 2b. downgrade prompt ──────────────────────────────────────────────────
  # If remote version is older than current, treat as a downgrade. Default
  # behavior: prompt. With --yes: proceed. Without a TTY and without --yes:
  # abort (CI shouldn't accidentally downgrade prod).
  #
  # NOTE: when local is strictly AHEAD of remote (ahead>0, behind==0), the
  # ff-only merge is a guaranteed no-op — origin's tip is already an
  # ancestor of HEAD. That's the dev-branch case (operator commits land
  # locally before they push), not a downgrade. Skip the prompt for it.
  if [[ "$current_version" != "?" && "$remote_version" != "?" ]] \
     && ! (( ahead_count > 0 && behind_count == 0 )); then
    local cmp
    cmp=$(_subctl_update_version_cmp "$current_version" "$remote_version")
    if [[ "$cmp" == "newer" ]]; then
      subctl_warn "remote v$remote_version is OLDER than current v$current_version — this is a downgrade"
      if $yes; then
        subctl_info "--yes: auto-confirming downgrade"
      elif [[ -t 0 ]]; then
        local reply
        printf "    proceed with downgrade? [y/N] "
        read -r reply
        case "${reply,,}" in
          y|yes) : ;;
          *)
            _SUBCTL_UPDATE_ERROR="downgrade declined by operator"
            subctl_err "aborted by operator"
            return 1
            ;;
        esac
      else
        _SUBCTL_UPDATE_ERROR="downgrade requires --yes in non-interactive mode"
        subctl_err "non-interactive shell and --yes not passed — refusing to downgrade"
        return 1
      fi
    fi
  fi

  # ── 3. working-tree cleanliness — lockfile-only carve-out ─────────────────
  local stashed=false stash_kind=""
  local porcelain
  porcelain=$(git status --porcelain 2>/dev/null)
  local classification
  classification=$(_subctl_update_classify_dirty "$porcelain")

  case "$classification" in
    clean) : ;;
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
      if git stash push -u -m "subctl-update-lockfile-$(date +%s)" -- "${_lockfile_paths[@]}" >/dev/null 2>&1; then
        stashed=true
        stash_kind="lockfile"
        _SUBCTL_UPDATE_LOCKFILE_STASHED=true
      else
        _SUBCTL_UPDATE_ERROR="auto-stash of lockfile failed"
        subctl_err "auto-stash of lockfile failed — commit or stash manually then retry"
        return 1
      fi
      ;;
    mixed*)
      if [[ "$force" == "true" ]]; then
        subctl_warn "working tree dirty — stashing (will restore after update)"
        if git stash push -u -m "subctl-update-$(date +%s)" >/dev/null 2>&1; then
          stashed=true
          stash_kind="force"
        fi
      else
        _SUBCTL_UPDATE_ERROR="working tree has uncommitted changes"
        subctl_err "working tree has uncommitted changes — commit, stash, or pass --force"
        git status -sb | head -20
        return 1
      fi
      ;;
  esac

  # ── 4. checkout + fast-forward ────────────────────────────────────────────
  _SUBCTL_UPDATE_STAGE="merge"
  if [[ "$current_branch" != "$branch" ]]; then
    subctl_info "switching from $current_branch → $branch"
    if ! git checkout "$branch" 2>&1 | tail -3; then
      _SUBCTL_UPDATE_ERROR="checkout failed"
      subctl_err "checkout failed"
      [[ "$stashed" == "true" ]] && _subctl_update_pop_stash "$stash_kind"
      return 2
    fi
  fi

  _subctl_update_with_timeout "$timeout" git merge --ff-only "origin/$branch" >/dev/null 2>&1
  local _merge_rc=$?
  if [[ "$_merge_rc" -ne 0 ]]; then
    if [[ "$_merge_rc" == "124" ]]; then
      _SUBCTL_UPDATE_ERROR="timeout after ${timeout}s during git merge"
      subctl_err "git merge timed out after ${timeout}s"
    else
      _SUBCTL_UPDATE_ERROR="fast-forward failed — local branch has commits not on origin"
      subctl_err "fast-forward failed — local branch $branch has commits not on origin/$branch"
      subctl_info "to force update: git reset --hard origin/$branch  (loses local commits)"
    fi
    [[ "$stashed" == "true" ]] && _subctl_update_pop_stash "$stash_kind"
    return 2
  fi
  local new_sha
  new_sha=$(git rev-parse HEAD)
  _SUBCTL_UPDATE_TO_SHA="${new_sha:0:8}"

  local new_version
  new_version=$(tr -d '[:space:]' < "$SUBCTL_REPO_ROOT/VERSION" 2>/dev/null || echo "?")
  _SUBCTL_UPDATE_TO_VERSION="$new_version"
  _SUBCTL_UPDATE_COMMITS_APPLIED=$(git rev-list --count "$current_sha".."$new_sha" 2>/dev/null || echo 0)
  if [[ "$current_version" != "$new_version" ]]; then
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${current_version} → v${new_version}, ${_SUBCTL_UPDATE_COMMITS_APPLIED} commits)"
  else
    subctl_ok "updated ${current_sha:0:8} → ${new_sha:0:8}  (v${new_version}, ${_SUBCTL_UPDATE_COMMITS_APPLIED} commits)"
  fi
  echo
  subctl_info "summary of incoming commits:"
  git log --oneline "$current_sha".."$new_sha" | head -15
  echo

  # ── 5. bun install where package.json changed ─────────────────────────────
  _SUBCTL_UPDATE_STAGE="deps"
  local changed_pkg_dirs
  changed_pkg_dirs=$(git diff --name-only "$current_sha".."$new_sha" -- '**/package.json' 2>/dev/null | xargs -n1 dirname 2>/dev/null | sort -u)
  if [[ -n "$changed_pkg_dirs" ]]; then
    if subctl_have bun; then
      while IFS= read -r d; do
        [[ -z "$d" || ! -f "$SUBCTL_REPO_ROOT/$d/package.json" ]] && continue
        subctl_info "bun install in $d (package.json changed)"
        ( cd "$SUBCTL_REPO_ROOT/$d" && _subctl_update_with_timeout "$timeout" bun install --silent )
        local _install_rc=$?
        if [[ "$_install_rc" -ne 0 ]]; then
          if [[ "$_install_rc" == "124" ]]; then
            _SUBCTL_UPDATE_ERROR="timeout after ${timeout}s during bun install in $d"
            subctl_err "bun install in $d timed out after ${timeout}s"
            [[ "$stashed" == "true" ]] && _subctl_update_pop_stash "$stash_kind"
            return 2
          fi
          subctl_warn "bun install in $d failed (continuing)"
        fi
      done <<< "$changed_pkg_dirs"
    else
      subctl_warn "package.json changed in: $changed_pkg_dirs"
      subctl_warn "  bun is not on PATH — install: curl -fsSL https://bun.sh/install | bash"
    fi
  fi

  # ── 6. restart launchd services ───────────────────────────────────────────
  _SUBCTL_UPDATE_STAGE="restart"
  if [[ "$no_restart" == "true" ]]; then
    subctl_info "--no-restart: skipping service bounce"
  else
    local restarted_any=false
    for label in com.subctl.evy com.subctl.dashboard; do
      local plist="$HOME/Library/LaunchAgents/${label}.plist"
      if [[ -f "$plist" ]] && launchctl list | awk '{print $3}' | grep -qx "$label"; then
        subctl_info "restarting $label"
        launchctl unload "$plist" 2>/dev/null || true
        local i=0
        while pgrep -f "$label" >/dev/null 2>&1 && [[ $i -lt 5 ]]; do
          sleep 1; i=$((i+1))
        done
        if ! launchctl load "$plist" 2>&1 | tail -3; then
          subctl_err "failed to reload $label"
          continue
        fi
        restarted_any=true
        _SUBCTL_UPDATE_SERVICES_RESTARTED+=("$label")
      fi
    done
    if ! $restarted_any; then
      subctl_info "no subctl launchd services running — nothing to restart"
    else
      subctl_ok "services restarted"
    fi
  fi

  # ── 7. restore stash + run doctor ─────────────────────────────────────────
  _SUBCTL_UPDATE_STAGE="doctor"
  if [[ "$stashed" == "true" ]]; then
    _subctl_update_pop_stash "$stash_kind"
  fi

  if [[ -x "$SUBCTL_REPO_ROOT/bin/subctl" ]]; then
    echo
    subctl_info "running subctl doctor..."
    local doctor_out
    doctor_out=$("$SUBCTL_REPO_ROOT/bin/subctl" doctor 2>&1 | tail -20 || true)
    printf "%s\n" "$doctor_out"
    _SUBCTL_UPDATE_DOCTOR_WARNINGS=$(printf "%s\n" "$doctor_out" | grep -c '⚠\|warn' 2>/dev/null || echo 0)
  fi

  # Record successful run time for `update status`.
  _subctl_update_set_config_key "last_run" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 || true

  _SUBCTL_UPDATE_STAGE=""
  return 0
}
