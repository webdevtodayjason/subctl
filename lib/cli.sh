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

# =============================================================================
# v2.7.36 — team / config / profile CLI expansion
# =============================================================================
#
# Three new subcommand families layered on the same localhost HTTP surface
# that v2.7.28 introduced. Each one keeps the same operator-from-anywhere
# ergonomics: text-by-default, plain-stdout, exit 0 / exit 1.
#
#   subctl team list                       /api/orchestration
#   subctl team kill <name>                /api/orchestration/<name>/kill + archive inbox
#   subctl team exec <name> <cmd>          /api/orchestration/<name>/msg (HMAC-marker via dashboard)
#   subctl team logs <name>                tail ~/.config/subctl/master/inbox/<name>.jsonl
#
#   subctl config show [section]           pretty-print + redact secrets
#   subctl config edit  [file]             $EDITOR on a specific config file
#   subctl config validate                 schema-shape check for known files
#
#   subctl profile show                    GET /api/profile
#   subctl profile switch chat|heavy       POST /api/profile
#   subctl profile list                    read ~/.config/subctl/profiles.json (or GET /api/profile)
#
# Secret hygiene: `config show` runs every value through _subctl_cli_redact_text
# which strips tokens, sk-*, Bearer, OP_*, 64-hex blobs, telegram-bot ids, AND
# any JSON value whose KEY name matches the secret-pattern (token/secret/
# password/key/credential/bearer/apikey). See the function for the regex set.

SUBCTL_MASTER_INBOX_DEFAULT="$HOME/.config/subctl/master/inbox"

# ── subctl team {list, kill, exec, logs} ─────────────────────────────────────
subctl_cli_team() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    -h|--help|"")
      cat <<EOF
subctl team <verb> [args]

  Manage active dev-team orchestrator sessions (tmux sessions spawned by
  'subctl teams claude' or '/api/orchestration/spawn'). All verbs go through
  the dashboard's /api/orchestration/* surface so they work from any terminal
  on the host without needing a tmux attach.

Verbs:
  list                       List active orchestrator sessions
  kill <name>                Kill the tmux session + archive its inbox to
                             ~/.config/subctl/master/inbox/.killed/
  exec <name> <command...>   Inject a one-off subctl_orch_msg (HMAC-signed)
  logs <name> [--tail N]     Tail the team's inbox JSONL (default 20 lines)
  report  ...                Append a status event   (see 'subctl team report --help')
  inbox <name> [--tail N]    Show recent events       (alias of 'logs')

Examples:
  subctl team list
  subctl team kill v2.7.36-cli-expansion
  subctl team exec v2.7.36-cli-expansion "report progress"
  subctl team logs v2.7.36-cli-expansion --tail 50
EOF
      return 0 ;;
    list)           subctl_cli_team_list "$@" ;;
    kill)           subctl_cli_team_kill "$@" ;;
    exec)           subctl_cli_team_exec "$@" ;;
    logs)           subctl_cli_team_logs "$@" ;;
    # Back-compat: hand the existing dev-team-lead verbs off to components/team/team.sh.
    report|inbox)
      . "$SUBCTL_REPO_ROOT/components/team/team.sh"
      subctl_team "$sub" "$@"
      ;;
    *)
      subctl_err "unknown team verb: $sub (try: list | kill | exec | logs | report | inbox)"
      return 1
      ;;
  esac
}

subctl_cli_team_list() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/orchestration"
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    # Dashboard down → fall back to inbox-file listing so the operator
    # still sees *something* useful. Mirrors the v2.7.27 fallback for
    # 'subctl orch list'.
    subctl_warn "dashboard unreachable — falling back to inbox listing ($SUBCTL_MASTER_INBOX_DEFAULT)"
    local inbox="${SUBCTL_MASTER_INBOX:-$SUBCTL_MASTER_INBOX_DEFAULT}"
    if [[ ! -d "$inbox" ]]; then
      echo "(no teams — inbox dir does not exist yet: $inbox)"
      return 0
    fi
    local found=0
    for f in "$inbox"/*.jsonl; do
      [[ -e "$f" ]] || continue
      found=1
      local team mtime lines
      team=$(basename "$f" .jsonl)
      mtime=$(date -r "$f" "+%Y-%m-%d %H:%M:%S")
      lines=$(wc -l < "$f" | tr -d ' ')
      printf "  %-32s  %s  %5s events\n" "$team" "$mtime" "$lines"
    done
    (( found == 0 )) && echo "(no teams have reported yet)"
    return 0
  fi
  local count
  count=$(printf '%s' "$body" | jq -r '.orchestrations | length')
  if [[ "$count" == "0" ]]; then
    echo "(no active orchestrator sessions)"
    return 0
  fi
  # Render: name | attached | windows | last-event-age | last-event-type | text
  printf "%s%-32s %-8s %-7s %-10s %-10s %s%s\n" \
    "$C_DIM" "NAME" "ATTACHED" "WINDOWS" "AGE" "EVENT" "TEXT" "$C_RST"
  printf '%s' "$body" | jq -r '
    .orchestrations[]
    | [
        .name,
        (if .attached then "yes" else "no" end),
        (.windows // 0),
        (.last_activity_seconds_ago // "-" | tostring),
        (.last_event_type // "-"),
        (.last_event_text // "" | gsub("\n"; " ⏎ ") | .[0:80])
      ]
    | @tsv
  ' | awk -F'\t' '{ printf "%-32s %-8s %-7s %-10s %-10s %s\n", $1, $2, $3, $4, $5, $6 }'
}

subctl_cli_team_kill() {
  _subctl_cli_require_jq || return 1
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    subctl_err "usage: subctl team kill <name>"
    return 1
  fi
  shift || true
  local url body code
  url="$(_subctl_cli_dashboard_base)/api/orchestration/$(_subctl_cli_urlencode "$name")/kill"
  # Capture HTTP body + exit code separately so 404 doesn't make us bail.
  if body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" "$url" 2>/dev/null); then
    code=0
  else
    code=$?
  fi
  if [[ "$code" -ne 0 ]]; then
    # 22 = HTTP failure (curl --fail). Try to surface the dashboard's error body.
    local errbody
    errbody=$(curl --silent --max-time 5 -X POST "$url" 2>/dev/null || true)
    if [[ -n "$errbody" ]]; then
      local msg
      msg=$(printf '%s' "$errbody" | jq -r '.error // .' 2>/dev/null || echo "$errbody")
      subctl_err "kill failed for '$name': $msg"
    else
      subctl_err "POST $url failed — is the dashboard running?"
    fi
    return 1
  fi
  # Archive the inbox file. The dashboard already killed the tmux session;
  # we own the on-disk cleanup so a re-spawn under the same name doesn't
  # inherit stale events. .killed/ stays under the inbox dir to keep the
  # archive auditable from one place.
  local inbox_dir="${SUBCTL_MASTER_INBOX:-$SUBCTL_MASTER_INBOX_DEFAULT}"
  local inbox="$inbox_dir/${name}.jsonl"
  local archived="(no inbox file to archive)"
  if [[ -f "$inbox" ]]; then
    local killed_dir="$inbox_dir/.killed"
    mkdir -p "$killed_dir"
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    local dest="$killed_dir/${name}.${ts}.jsonl"
    if mv "$inbox" "$dest" 2>/dev/null; then
      archived="archived inbox → $dest"
    else
      archived="WARNING: failed to archive $inbox (continuing)"
    fi
  fi
  subctl_ok "killed team '$name' — $archived"
}

subctl_cli_team_exec() {
  _subctl_cli_require_jq || return 1
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    subctl_err "usage: subctl team exec <name> <command...>"
    return 1
  fi
  shift
  local cmd="${*:-}"
  if [[ -z "$cmd" ]]; then
    subctl_err "usage: subctl team exec <name> <command...>"
    return 1
  fi
  local url payload body
  url="$(_subctl_cli_dashboard_base)/api/orchestration/$(_subctl_cli_urlencode "$name")/msg"
  # The dashboard /msg route wraps payloads in an HMAC trust marker before
  # the tmux paste — we just deliver the verbatim text. No phase=… so the
  # marker uses the no-phase shape.
  payload=$(jq -n --arg t "$cmd" '{text: $t}')
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" --data "$payload" "$url" 2>/dev/null); then
    subctl_err "POST $url failed — is the dashboard running?"
    return 1
  fi
  local ok
  ok=$(printf '%s' "$body" | jq -r '.ok // false')
  if [[ "$ok" != "true" ]]; then
    local errmsg
    errmsg=$(printf '%s' "$body" | jq -r '.error // "unknown error"')
    subctl_err "exec failed: $errmsg"
    return 1
  fi
  subctl_ok "exec → $name: ${cmd:0:60}$([[ ${#cmd} -gt 60 ]] && echo …)"
}

subctl_cli_team_logs() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    subctl_err "usage: subctl team logs <name> [--tail N]"
    return 1
  fi
  shift || true
  local tail_n=20 follow=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tail|-n)   tail_n="$2"; shift 2 ;;
      --follow|-f) follow=true; shift ;;
      -h|--help)
        cat <<EOF
subctl team logs <name> [--tail N] [--follow]

  Tail the per-team inbox JSONL written by the team lead via 'subctl team
  report'. Default: last 20 events.

  Options:
    --tail N      Lines (default 20)
    --follow, -f  Stream new events (tail -f). Ctrl-C to exit.
EOF
        return 0 ;;
      *) subctl_err "unknown flag: $1"; return 1 ;;
    esac
  done
  if [[ ! "$tail_n" =~ ^[0-9]+$ ]] || (( tail_n < 1 )); then
    subctl_err "--tail N must be a positive integer (got: $tail_n)"
    return 1
  fi
  local inbox_dir="${SUBCTL_MASTER_INBOX:-$SUBCTL_MASTER_INBOX_DEFAULT}"
  local inbox="$inbox_dir/${name}.jsonl"
  if [[ ! -f "$inbox" ]]; then
    subctl_err "no inbox for team '$name' at $inbox"
    return 1
  fi
  _subctl_cli_require_jq || return 1
  if $follow; then
    # tail -F so file rotation is handled. Pipe through jq for pretty
    # rendering of each new JSONL line.
    tail -F -n "$tail_n" "$inbox" | jq -rc 'select(. != null) |
      "\(.ts // "?")  \(.type // "?" | ascii_upcase | .[0:8])  \(.text // "")"'
    return
  fi
  tail -n "$tail_n" "$inbox" | jq -r '
    "\(.ts // "?")  \(.type // "?" | ascii_upcase | .[0:8])  \(.text // "")"
  '
}

# URL-encode the path segment via jq's @uri. Falls back to raw if jq absent.
_subctl_cli_urlencode() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -sRr @uri
  else
    printf '%s' "$1"
  fi
}

# ── subctl config {show, edit, validate} ─────────────────────────────────────
# v2.7.36 supersedes the old `subctl config edit` shim (which only edited
# accounts.conf) with a richer surface. Backwards compatible — `subctl config`
# with no args still prints accounts.conf, and `subctl config path` still works.

# Canonical list of "known" config files. Each entry: <id>:<path>:<format>
# format is one of: text|json|toml. Used by show/edit/validate.
_subctl_cli_config_files() {
  cat <<EOF
accounts:$SUBCTL_CONFIG_DIR/accounts.conf:text
projects:$SUBCTL_CONFIG_DIR/projects.conf:text
config:$SUBCTL_CONFIG_DIR/config.toml:toml
notify:$SUBCTL_CONFIG_DIR/notify.json:json
master-notify:$SUBCTL_CONFIG_DIR/master-notify.json:json
profiles:$SUBCTL_CONFIG_DIR/profiles.json:json
providers:$SUBCTL_CONFIG_DIR/master/providers.json:json
secrets:$SUBCTL_CONFIG_DIR/master/secrets.json:json
secrets-backends:$SUBCTL_CONFIG_DIR/secrets-backends.json:json
policy:$SUBCTL_CONFIG_DIR/master/policy.json:json
EOF
}

# Redact text that may contain secrets. Conservative — over-redacts is fine.
# Patterns covered:
#   sk-[A-Za-z0-9_-]{16,}        OpenAI/Anthropic-style API keys
#   sk-ant-[A-Za-z0-9_-]+        Anthropic
#   Bearer\s+[A-Za-z0-9._-]+     Authorization headers
#   OP_[A-Z_]+=\S+               1Password service-account env style
#   [0-9]{8,12}:[A-Za-z0-9_-]{30,}  Telegram bot tokens
#   \b[a-fA-F0-9]{64}\b          64-hex (HMAC keys, generic tokens)
#   eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+   JWT
_subctl_cli_redact_text() {
  # sed -E is portable across BSD + GNU; keep patterns simple to stay so.
  sed -E \
    -e 's/sk-ant-[A-Za-z0-9_-]+/***redacted-sk-ant***/g' \
    -e 's/sk-[A-Za-z0-9_-]{16,}/***redacted-sk***/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]+/\1***redacted***/g' \
    -e 's/(OP_[A-Z_]+=)[A-Za-z0-9._:/+-]+/\1***redacted***/g' \
    -e 's/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/***redacted-telegram-token***/g' \
    -e 's/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/***redacted-jwt***/g' \
    -e 's/\b[a-fA-F0-9]{64}\b/***redacted-64hex***/g'
}

# Redact a JSON document: walk every key, replace value with "***redacted***"
# when the key name matches a secret-suggestive pattern. Composes with the
# textual redaction so even values that escaped the structural pass get sanitized.
_subctl_cli_redact_json() {
  local input="$1"
  # jq walk: at each object, replace values for matching keys with a sentinel.
  # The regex set: token, secret, password, credential, bearer, apikey,
  # api_key, access_token, refresh_token, private_key, client_secret, hmac.
  printf '%s' "$input" | jq '
    def redact_keys:
      with_entries(
        if (.key | ascii_downcase | test("token|secret|password|credential|bearer|apikey|api_?key|access_?token|refresh_?token|private_?key|client_?secret|hmac"))
        then .value = "***redacted***"
        else .
        end
      );
    walk(if type == "object" then redact_keys else . end)
  ' 2>/dev/null | _subctl_cli_redact_text
}

# Print one config file in a redacted, human-friendly form.
# fmt: text|json|toml
_subctl_cli_config_show_one() {
  local id="$1" path="$2" fmt="$3"
  printf "%s══ %s (%s) ══%s\n" "$C_DIM" "$id" "$path" "$C_RST"
  if [[ ! -e "$path" ]]; then
    printf "${C_DIM}  (not present)${C_RST}\n\n"
    return 0
  fi
  case "$fmt" in
    json)
      if command -v jq >/dev/null 2>&1; then
        local body
        body=$(cat "$path")
        _subctl_cli_redact_json "$body"
      else
        cat "$path" | _subctl_cli_redact_text
      fi
      ;;
    *)
      cat "$path" | _subctl_cli_redact_text
      ;;
  esac
  printf "\n"
}

subctl_cli_config() {
  local sub="${1:-show}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    -h|--help)
      cat <<EOF
subctl config <verb> [args]

  Inspect / edit / validate the operator's config files under \$XDG_CONFIG_HOME/subctl.

Verbs:
  show [section]      Print one or all config files. Secrets are redacted.
                      Sections: accounts, projects, config, notify, master-notify,
                      profiles, providers, secrets, secrets-backends, policy.
  edit [file]         Open \$EDITOR (or vim) on a config file. Defaults to
                      accounts.conf. 'file' may be a section name or a path.
  validate            Schema-shape check for every known config file.

Examples:
  subctl config show
  subctl config show providers
  subctl config edit notify
  subctl config validate
EOF
      return 0 ;;
    show|"")        subctl_cli_config_show "$@" ;;
    edit)           subctl_cli_config_edit "$@" ;;
    validate)       subctl_cli_config_validate "$@" ;;
    path)           # backward-compat with old dispatcher
      echo "$SUBCTL_ACCOUNTS_CONF"
      ;;
    *)
      subctl_err "unknown config verb: $sub (try: show | edit | validate)"
      return 1
      ;;
  esac
}

subctl_cli_config_show() {
  local section="${1:-}"
  if [[ -z "$section" ]]; then
    # No section: print every known file.
    while IFS=: read -r id path fmt; do
      [[ -z "$id" ]] && continue
      _subctl_cli_config_show_one "$id" "$path" "$fmt"
    done < <(_subctl_cli_config_files)
    return 0
  fi
  # Specific section.
  local line
  line=$(_subctl_cli_config_files | awk -F: -v s="$section" '$1==s')
  if [[ -z "$line" ]]; then
    subctl_err "unknown section '$section' (try: $(_subctl_cli_config_files | cut -d: -f1 | paste -sd, -))"
    return 1
  fi
  local id path fmt
  IFS=: read -r id path fmt <<<"$line"
  _subctl_cli_config_show_one "$id" "$path" "$fmt"
}

subctl_cli_config_edit() {
  local target="${1:-accounts}"
  local path
  # Map of section → path. If target looks like a path (contains / or is
  # absolute), use it directly. Otherwise resolve via the known-file table.
  if [[ "$target" == /* || "$target" == */* ]]; then
    path="$target"
  else
    local line
    line=$(_subctl_cli_config_files | awk -F: -v s="$target" '$1==s')
    if [[ -z "$line" ]]; then
      subctl_err "unknown section '$target' (try: $(_subctl_cli_config_files | cut -d: -f1 | paste -sd, -))"
      return 1
    fi
    path=$(printf '%s' "$line" | cut -d: -f2)
  fi
  # Ensure parent dir exists (so editing a brand-new providers.json works).
  mkdir -p "$(dirname "$path")"
  local editor="${EDITOR:-vim}"
  exec "$editor" "$path"
}

subctl_cli_config_validate() {
  _subctl_cli_require_jq || return 1
  local fail=0 total=0 present=0
  while IFS=: read -r id path fmt; do
    [[ -z "$id" ]] && continue
    total=$((total+1))
    if [[ ! -e "$path" ]]; then
      printf "  ${C_DIM}-${C_RST} %-20s %s ${C_DIM}(not present)${C_RST}\n" "$id" "$path"
      continue
    fi
    present=$((present+1))
    case "$fmt" in
      json)
        if jq -e . "$path" >/dev/null 2>&1; then
          printf "  ${C_GRN}✓${C_RST} %-20s %s ${C_DIM}(valid JSON)${C_RST}\n" "$id" "$path"
        else
          printf "  ${C_RED}✗${C_RST} %-20s %s ${C_RED}(invalid JSON)${C_RST}\n" "$id" "$path"
          fail=$((fail+1))
        fi
        ;;
      toml)
        # Shape-check: every line is either blank, comment, [section], or key = value.
        if awk '
          /^[[:space:]]*(#|$)/ {next}
          /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {next}
          /=/ {next}
          {print NR": "$0; exit 1}
        ' "$path" >/dev/null 2>&1; then
          printf "  ${C_GRN}✓${C_RST} %-20s %s ${C_DIM}(toml-shaped)${C_RST}\n" "$id" "$path"
        else
          printf "  ${C_RED}✗${C_RST} %-20s %s ${C_RED}(toml shape violation)${C_RST}\n" "$id" "$path"
          fail=$((fail+1))
        fi
        ;;
      text)
        # accounts.conf / projects.conf shape: each non-comment line has the
        # right number of `|` separators (>=2). Empty file is fine.
        local bad=0
        while IFS= read -r raw; do
          local stripped="${raw#"${raw%%[![:space:]]*}"}"
          [[ -z "$stripped" || "${stripped:0:1}" == "#" ]] && continue
          local pipes="${stripped//[^|]/}"
          if (( ${#pipes} < 2 )); then bad=$((bad+1)); fi
        done < "$path"
        if (( bad == 0 )); then
          printf "  ${C_GRN}✓${C_RST} %-20s %s ${C_DIM}(text/pipe-form)${C_RST}\n" "$id" "$path"
        else
          printf "  ${C_RED}✗${C_RST} %-20s %s ${C_RED}($bad malformed line(s))${C_RST}\n" "$id" "$path"
          fail=$((fail+1))
        fi
        ;;
    esac
  done < <(_subctl_cli_config_files)
  echo
  if (( fail == 0 )); then
    subctl_ok "$present/$total config files validated; 0 failures"
    return 0
  fi
  subctl_err "$fail of $present config files failed validation"
  return 1
}

# ── subctl profile {show, switch, list} ──────────────────────────────────────
# v2.7.18 introduced profiles.json (active + chat/heavy supervisor configs).
# v2.7.36 surfaces it as a first-class CLI. All HTTP-side ops go through the
# dashboard's /api/profile pass-through; `list` falls back to reading the
# JSON file directly so it works even when the daemons are off.
subctl_cli_profile() {
  local sub="${1:-show}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    -h|--help)
      cat <<EOF
subctl profile <verb> [args]

  Read / switch the master's active supervisor profile (v2.7.18). The
  underlying source-of-truth is ~/.config/subctl/profiles.json; the master
  fs-watches it and swaps on the next prompt.

Verbs:
  show              Print active profile + supervisor model + host.
  switch <name>     Switch to a profile (chat | heavy). POSTs /api/profile.
  list              List all defined profiles + the active marker.

Examples:
  subctl profile show
  subctl profile switch heavy
  subctl profile list
EOF
      return 0 ;;
    show|"")     subctl_cli_profile_show "$@" ;;
    switch|set)  subctl_cli_profile_switch "$@" ;;
    list|ls)     subctl_cli_profile_list "$@" ;;
    *)
      subctl_err "unknown profile verb: $sub (try: show | switch | list)"
      return 1
      ;;
  esac
}

subctl_cli_profile_show() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/profile"
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    subctl_err "GET $url failed — is the dashboard running? (try: subctl profile list)"
    return 1
  fi
  local active model host
  active=$(printf '%s' "$body" | jq -r '.active // "?"')
  model=$(printf '%s' "$body" | jq -r --arg a "$active" '.detail[$a].supervisor // "?"')
  host=$(printf '%s' "$body"  | jq -r --arg a "$active" '.detail[$a].host // "?"')
  printf "active: ${C_BLD}%s${C_RST}\n" "$active"
  printf "  supervisor: %s\n" "$model"
  printf "  host:       %s\n" "$host"
}

subctl_cli_profile_switch() {
  _subctl_cli_require_jq || return 1
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    subctl_err "usage: subctl profile switch <chat|heavy>"
    return 1
  fi
  local url body payload
  url="$(_subctl_cli_dashboard_base)/api/profile"
  payload=$(jq -n --arg p "$target" '{profile: $p}')
  if ! body=$(_subctl_cli_curl -X POST -H "Content-Type: application/json" --data "$payload" "$url" 2>/dev/null); then
    # Try once more raw so we can surface the dashboard's error body.
    local errbody
    errbody=$(curl --silent --max-time 5 -X POST -H "Content-Type: application/json" --data "$payload" "$url" 2>/dev/null || true)
    local msg
    msg=$(printf '%s' "$errbody" | jq -r '.error // empty' 2>/dev/null || echo "")
    if [[ -n "$msg" ]]; then
      subctl_err "switch failed: $msg"
    else
      subctl_err "POST $url failed — is the dashboard running?"
    fi
    return 1
  fi
  local ok active note
  ok=$(printf '%s'    "$body" | jq -r '.ok // false')
  active=$(printf '%s' "$body" | jq -r '.active // "?"')
  note=$(printf '%s'   "$body" | jq -r '.note // ""')
  if [[ "$ok" != "true" ]]; then
    local err
    err=$(printf '%s' "$body" | jq -r '.error // "unknown"')
    subctl_err "switch failed: $err"
    return 1
  fi
  subctl_ok "active profile → $active"
  [[ -n "$note" ]] && printf "  ${C_DIM}%s${C_RST}\n" "$note"
}

subctl_cli_profile_list() {
  _subctl_cli_require_jq || return 1
  local url body
  url="$(_subctl_cli_dashboard_base)/api/profile"
  # Try dashboard first, fall back to local JSON file if daemons are down.
  if ! body=$(_subctl_cli_curl "$url" 2>/dev/null); then
    local path="$SUBCTL_CONFIG_DIR/profiles.json"
    if [[ ! -f "$path" ]]; then
      subctl_err "dashboard unreachable and no $path on disk"
      return 1
    fi
    subctl_warn "dashboard unreachable — reading $path directly"
    body=$(cat "$path")
    # Rewrap to the dashboard shape so the renderer below works for both.
    body=$(printf '%s' "$body" | jq '{ok: true, active: .active, profiles: (.profiles | keys), detail: .profiles}')
  fi
  local active
  active=$(printf '%s' "$body" | jq -r '.active // "?"')
  printf "%s%-10s %-40s %s%s\n" "$C_DIM" "PROFILE" "SUPERVISOR" "HOST" "$C_RST"
  printf '%s' "$body" | jq -r --arg a "$active" '
    .detail
    | to_entries[]
    | [
        (if .key == $a then "* \(.key)" else "  \(.key)" end),
        (.value.supervisor // "?"),
        (.value.host // "?")
      ]
    | @tsv
  ' | awk -F'\t' '{ printf "%-10s %-40s %s\n", $1, $2, $3 }'
}
