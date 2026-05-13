#!/usr/bin/env bash
# lib/cli.sh — v2.7.28 CLI bootstrap helpers.
#
# Implements the five "operator from anywhere" subcommands shipped in v2.7.28:
#
#   subctl status   one-shot health probe of master (:8788) + dashboard (:8787)
#   subctl logs     tail master.log / dashboard.{out,err}.log
#   subctl deploy   git pull + launchctl kickstart -k for both services
#   subctl notif    REST wrapper around /api/notifications
#   subctl memory   REST wrapper around /api/memory/*  (Evy Tier 3)
#
# Design constraints (see PR brief v2.7.28):
#   - Localhost-only HTTP (no auth in v1)
#   - Output goes to stdout on success, exit 0; errors go to stderr, exit 1
#   - `--json` flag on `status` for machine output
#   - Never log secrets in HTTP response bodies (we don't pretty-print arbitrary
#     fields; the upstream master already redacts entries via redactEntryForEgress)
#   - No spinners / progress bars / interactive prompts
#
# We piggy-back on the existing bash dispatcher in bin/subctl rather than
# introducing a parallel Bun executable: the dispatcher is already the CLI
# entry-point on this host, install.sh symlinks it into /usr/local/bin/subctl,
# and shelling out via curl + jq is the cheapest path to first-byte for these
# verbs. If we ever need streaming / SSE in the CLI itself we can add a
# bun-based subcommand at bin/subctl-<verb> and dispatch into it.

[[ -n "${_SUBCTL_CLI_LOADED:-}" ]] && return 0
_SUBCTL_CLI_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

SUBCTL_MASTER_PORT="${SUBCTL_MASTER_PORT:-8788}"
SUBCTL_DASHBOARD_PORT_DEFAULT="${SUBCTL_SERVICE_PORT:-8787}"

# Resolve `http://127.0.0.1:<port>` bases. Kept as functions so SUBCTL_*_PORT
# env overrides at call-time are honored (test harnesses lean on this).
_subctl_cli_master_base() {
  printf "http://127.0.0.1:%s" "${SUBCTL_MASTER_PORT:-8788}"
}
_subctl_cli_dashboard_base() {
  printf "http://127.0.0.1:%s" "${SUBCTL_SERVICE_PORT:-8787}"
}

# curl wrapper with a 3s connect / 5s total timeout. Stays quiet on stderr;
# returns the HTTP body on stdout, exit code matches curl's.
_subctl_cli_curl() {
  curl --silent --show-error --fail \
    --connect-timeout 3 --max-time 5 \
    "$@"
}

# Require jq for any subcommand that parses JSON.
_subctl_cli_require_jq() {
  command -v jq >/dev/null 2>&1 || {
    subctl_err "jq is required for this subcommand (install: brew install jq)"
    return 1
  }
}

# ── subctl status ────────────────────────────────────────────────────────────
# Hits both daemons. With `--json`, prints a single combined doc to stdout.
# Without, prints a human two-line summary plus the secondary fields.
# Exit codes: 0 if both up, 1 if either daemon is unreachable.
subctl_cli_status() {
  local json=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)    json=true; shift ;;
      -h|--help)
        cat <<EOF
subctl status [--json]

  One-shot health probe against the master daemon (:8788) and the dashboard
  service (:8787). Reports version / uptime / active profile / Telegram
  listener state.

  Options:
    --json    Emit a single combined JSON doc (no human formatting).

  Exit codes:
    0  both daemons responded
    1  either daemon unreachable
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done

  _subctl_cli_require_jq || return 1

  local master_url dash_url master_body="" dash_body="" master_ok=false dash_ok=false
  master_url="$(_subctl_cli_master_base)/health"
  dash_url="$(_subctl_cli_dashboard_base)/api/version"

  if master_body=$(_subctl_cli_curl "$master_url" 2>/dev/null); then
    master_ok=true
  fi
  if dash_body=$(_subctl_cli_curl "$dash_url" 2>/dev/null); then
    dash_ok=true
  fi

  if $json; then
    jq -n \
      --argjson master_ok "$master_ok" \
      --argjson dash_ok "$dash_ok" \
      --arg master_raw "$master_body" \
      --arg dash_raw "$dash_body" \
      --arg cli_version "$SUBCTL_VERSION" \
      '{
        ok: ($master_ok and $dash_ok),
        cli_version: $cli_version,
        master: (if $master_ok then ($master_raw | fromjson) else {ok:false, error:"unreachable"} end),
        dashboard: (if $dash_ok then ($dash_raw | fromjson) else {ok:false, error:"unreachable"} end)
      }'
    if $master_ok && $dash_ok; then return 0; fi
    return 1
  fi

  # Human output.
  printf "subctl v%s\n" "$SUBCTL_VERSION"
  if $master_ok; then
    local m_version m_uptime m_subs m_profile m_listener m_listener_running
    m_version=$(printf '%s' "$master_body" | jq -r '.version // "?"')
    m_uptime=$(printf '%s' "$master_body" | jq -r '.uptime_s // 0')
    m_subs=$(printf '%s' "$master_body" | jq -r '.subscribers // 0')
    m_profile=$(printf '%s' "$master_body" | jq -r '.active_profile // "default"')
    m_listener_running=$(printf '%s' "$master_body" | jq -r '.telegram_listener.running // false')
    if [[ "$m_listener_running" == "true" ]]; then
      m_listener="${C_GRN}polling${C_RST}"
    else
      m_listener="${C_DIM}idle${C_RST}"
    fi
    printf "  ${C_GRN}✓${C_RST} master      v%-8s  uptime=%ss  subs=%s  profile=%s  telegram=%b\n" \
      "$m_version" "$m_uptime" "$m_subs" "$m_profile" "$m_listener"
  else
    printf "  ${C_RED}✗${C_RST} master      unreachable at %s\n" "$master_url"
  fi
  if $dash_ok; then
    local d_version
    d_version=$(printf '%s' "$dash_body" | jq -r '.version // "?"')
    printf "  ${C_GRN}✓${C_RST} dashboard   v%-8s  url=%s\n" \
      "$d_version" "$(_subctl_cli_dashboard_base)"
  else
    printf "  ${C_RED}✗${C_RST} dashboard   unreachable at %s\n" "$dash_url"
  fi

  if $master_ok && $dash_ok; then return 0; fi
  return 1
}

# ── subctl logs ──────────────────────────────────────────────────────────────
# Tails the launchd log files. Default: last 50 lines of all three. Flags:
#   --master         only master.log
#   --dashboard      only dashboard.out.log + dashboard.err.log
#   --tail N         number of trailing lines (default 50)
#   --follow / -f    tail -f
subctl_cli_logs() {
  local master_only=false dashboard_only=false follow=false n=50
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --master)        master_only=true; shift ;;
      --dashboard)     dashboard_only=true; shift ;;
      --tail)          n="$2"; shift 2 ;;
      --follow|-f)     follow=true; shift ;;
      -h|--help)
        cat <<EOF
subctl logs [--master | --dashboard] [--tail N] [--follow]

  Tail the launchd log files at ~/Library/Logs/subctl/. Default: last 50
  lines of master.log + dashboard.out.log + dashboard.err.log.

  Options:
    --master      Only master.log
    --dashboard   Only dashboard.out.log + dashboard.err.log
    --tail N      Lines (default 50)
    --follow, -f  Stream new lines (tail -f). Ctrl-C to exit.
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done

  if [[ ! "$n" =~ ^[0-9]+$ ]] || (( n < 1 )); then
    subctl_err "--tail N must be a positive integer (got: $n)"
    return 1
  fi

  local master_log="$SUBCTL_LOG_DIR/master.log"
  local dash_out="$SUBCTL_LOG_DIR/dashboard.out.log"
  local dash_err="$SUBCTL_LOG_DIR/dashboard.err.log"

  local -a files=()
  if $master_only; then
    files+=("$master_log")
  elif $dashboard_only; then
    files+=("$dash_out" "$dash_err")
  else
    files+=("$master_log" "$dash_out" "$dash_err")
  fi

  # Filter to existing files. If none exist, that's an error (helps the
  # operator notice the service hasn't been started yet).
  local -a existing=()
  local f
  for f in "${files[@]}"; do
    [[ -f "$f" ]] && existing+=("$f")
  done
  if [[ ${#existing[@]} -eq 0 ]]; then
    subctl_err "no log files found under $SUBCTL_LOG_DIR — has the service started?"
    return 1
  fi

  if $follow; then
    # tail -F handles file rotation. -n N seeds the buffer with the last N
    # lines from each file before live-following.
    exec tail -n "$n" -F "${existing[@]}"
  fi

  # Non-follow: print each file with a banner so the operator sees which
  # file each chunk came from. Single-file output skips the banner.
  if [[ ${#existing[@]} -eq 1 ]]; then
    tail -n "$n" "${existing[0]}"
  else
    for f in "${existing[@]}"; do
      printf "%s══ %s ══%s\n" "$C_DIM" "$f" "$C_RST"
      tail -n "$n" "$f"
      printf "\n"
    done
  fi
}

# ── subctl deploy ────────────────────────────────────────────────────────────
# `git pull` + `launchctl kickstart -k` for master + dashboard.
#
# Why kickstart -k and not unload/load? kickstart is the modern
# (launchctl 2.0) way to restart a running service in place without
# unregistering it. We still gracefully degrade: if either plist is not
# loaded yet we skip its kickstart with a warning instead of erroring.
#
# This is intentionally simpler than `subctl update` — no stash, no doctor,
# no rollback. Operator-facing tagline: "fast-path deploy from any terminal".
# For careful upgrades (auto-stash + version bracket + doctor) keep using
# `subctl update`.
subctl_cli_deploy() {
  local no_pull=false dry_run=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-pull)   no_pull=true; shift ;;
      --dry-run)   dry_run=true; shift ;;
      -h|--help)
        cat <<EOF
subctl deploy [--no-pull] [--dry-run]

  Fast-path deploy: git pull + launchctl kickstart -k for master + dashboard.

  Options:
    --no-pull   Skip git pull (just restart services).
    --dry-run   Print what would be run, don't execute.

  Notes:
    For the careful path (stash, version bracket, doctor, rollback) use
    'subctl update' instead. Deploy is for when you've already merged on the
    box and just want a fast bounce.
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done

  cd "$SUBCTL_REPO_ROOT" || subctl_die "cannot cd $SUBCTL_REPO_ROOT"

  if ! $no_pull; then
    subctl_info "git pull (repo: $SUBCTL_REPO_ROOT)"
    if $dry_run; then
      echo "[dry-run] git pull --ff-only"
    else
      git pull --ff-only || subctl_die "git pull failed (resolve manually, or use 'subctl update' for stash-aware path)"
    fi
  fi

  local uid label
  uid="$(id -u)"
  for label in com.subctl.master com.subctl.dashboard; do
    local plist="$HOME/Library/LaunchAgents/${label}.plist"
    if [[ ! -f "$plist" ]]; then
      subctl_warn "$label plist not installed — skipping ($plist)"
      continue
    fi
    if ! launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      subctl_warn "$label not currently loaded — skipping (try: launchctl load $plist)"
      continue
    fi
    subctl_info "kickstart -k gui/$uid/$label"
    if $dry_run; then
      echo "[dry-run] launchctl kickstart -k gui/$uid/$label"
    else
      launchctl kickstart -k "gui/$uid/$label" || subctl_warn "kickstart failed for $label"
    fi
  done

  $dry_run || subctl_ok "deploy complete"
}

# ── subctl notif ─────────────────────────────────────────────────────────────
# Wraps /api/notifications endpoints on the dashboard (which proxies to master).
subctl_cli_notif() {
  local sub="${1:-recent}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    -h|--help)
      cat <<EOF
subctl notif [recent | list <N> | mark-all-read]

  Read the master's operator notification ring (team-staleness auto-nudges,
  auto-compact errors, etc). Goes through the dashboard's /api/notifications
  proxy → master's /notifications.

  Verbs:
    recent           Print last 10 (default).
    list <N>         Print last N (1..200).
    mark-all-read    POST /api/notifications/read-all.
EOF
      return 0 ;;
    recent|"")
      _subctl_cli_notif_list 10
      ;;
    list)
      local n="${1:-10}"
      if [[ ! "$n" =~ ^[0-9]+$ ]] || (( n < 1 || n > 200 )); then
        subctl_err "list expects a positive integer 1..200 (got: $n)"
        return 1
      fi
      _subctl_cli_notif_list "$n"
      ;;
    mark-all-read)
      _subctl_cli_require_jq || return 1
      local url body
      url="$(_subctl_cli_dashboard_base)/api/notifications/read-all"
      if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" "$url" 2>/dev/null); then
        subctl_err "POST $url failed — is the dashboard running? (subctl service status)"
        return 1
      fi
      local marked
      marked=$(printf '%s' "$body" | jq -r '.marked // 0')
      subctl_ok "marked $marked notifications as read"
      ;;
    *)
      subctl_err "unknown notif verb: $sub (try: recent | list <N> | mark-all-read)"
      return 1
      ;;
  esac
}

_subctl_cli_notif_list() {
  _subctl_cli_require_jq || return 1
  local n="$1"
  local url body
  url="$(_subctl_cli_dashboard_base)/api/notifications?limit=$n"
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    subctl_err "GET $url failed — is the dashboard running? (subctl service status)"
    return 1
  fi
  local count
  count=$(printf '%s' "$body" | jq -r '.notifications | length')
  if [[ "$count" == "0" ]]; then
    echo "(no notifications)"
    return 0
  fi
  printf '%s' "$body" | jq -r '
    .notifications[]
    | [
        (.created_at // "?" | .[0:19]),
        (.severity // "info"),
        (if .read then "·" else "*" end),
        (.kind // "?"),
        (.title // .summary // .body // "")
      ]
    | @tsv
  ' | awk -F'\t' '{
    printf "%s %-6s %s %-20s %s\n", $1, $2, $3, $4, $5
  }'
}

# ── subctl memory ────────────────────────────────────────────────────────────
# Wraps /api/memory/* on the dashboard → master's Evy Tier 3 store.
subctl_cli_memory() {
  local sub="${1:-recent}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    -h|--help)
      cat <<EOF
subctl memory [recent <N> | search <query> | remember <text>]

  Query / append to master's Evy Memory (Tier 3, SQLite-backed). Goes through
  the dashboard's /api/memory/* proxy → master's /memory/*.

  Verbs:
    recent [N]          Last N entries (default 10, max 200).
    search <query>      Full-text search.
    remember <text>     Append a new entry (kind=note, no team scope).
EOF
      return 0 ;;
    recent|"")
      local n="${1:-10}"
      if [[ ! "$n" =~ ^[0-9]+$ ]] || (( n < 1 || n > 200 )); then
        subctl_err "recent expects a positive integer 1..200 (got: $n)"
        return 1
      fi
      _subctl_cli_memory_render "$(_subctl_cli_dashboard_base)/api/memory/recent?limit=$n"
      ;;
    search)
      local query="${1:-}"
      [[ -z "$query" ]] && { subctl_err "search expects a query string"; return 1; }
      shift
      # URL-encode just the spaces and a couple of common metacharacters.
      # curl --data-urlencode-on-GET pattern would be cleaner; we use jq
      # for portability since jq's already a hard dep.
      _subctl_cli_require_jq || return 1
      local encoded
      encoded=$(printf '%s' "$query" | jq -sRr @uri)
      _subctl_cli_memory_render "$(_subctl_cli_dashboard_base)/api/memory/search?query=$encoded&limit=25"
      ;;
    remember)
      local content="${*:-}"
      [[ -z "$content" ]] && { subctl_err "remember expects body text"; return 1; }
      _subctl_cli_require_jq || return 1
      local payload url body
      payload=$(jq -n --arg c "$content" '{content:$c, kind:"note"}')
      url="$(_subctl_cli_dashboard_base)/api/memory/entries"
      if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" --data "$payload" "$url" 2>/dev/null); then
        subctl_err "POST $url failed — is the dashboard running?"
        return 1
      fi
      local id
      id=$(printf '%s' "$body" | jq -r '.entry.id // .id // "?"')
      subctl_ok "remembered as id=$id"
      ;;
    *)
      subctl_err "unknown memory verb: $sub (try: recent | search | remember)"
      return 1
      ;;
  esac
}

_subctl_cli_memory_render() {
  _subctl_cli_require_jq || return 1
  local url="$1" body
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    subctl_err "GET $url failed — is the dashboard running?"
    return 1
  fi
  local count
  count=$(printf '%s' "$body" | jq -r '.entries | length')
  if [[ "$count" == "0" ]]; then
    echo "(no entries)"
    return 0
  fi
  printf '%s' "$body" | jq -r '
    .entries[]
    | [
        (.created_at // "?" | .[0:19]),
        (.kind // "?"),
        (.team_id // "-"),
        (.content // "" | gsub("\n"; " ⏎ ") | .[0:120])
      ]
    | @tsv
  ' | awk -F'\t' '{
    printf "%s  %-8s %-12s %s\n", $1, $2, $3, $4
  }'
}
