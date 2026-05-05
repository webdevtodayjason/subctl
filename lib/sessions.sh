#!/usr/bin/env bash
# lib/sessions.sh — discover Claude Code sessions across cfg_dirs and adopt
# (copy) them into a target account so `claude --resume <sid>` works.
#
# Why: subctl multi-account isolation puts each account's transcripts under
# `~/.claude-<alias>/projects/<encoded-cwd>/<sid>.jsonl`. Sessions that ran
# under bare `claude` (no CLAUDE_CONFIG_DIR set) live in `~/.claude/projects/`
# — invisible to `claude-<alias> --resume`. This module finds them and lets
# the user copy a chosen session into the target account so resume works.
#
# Naming note: "sessions" (plural) here = Claude conversations that
# `claude --resume <sid>` can pick up. "session-*" (hyphenated singular)
# subcommands act on tmux sessions. Different namespace, different concept.

[[ -n "${_SUBCTL_SESSIONS_LOADED:-}" ]] && return 0
_SUBCTL_SESSIONS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# Resolve all known cfg_dirs: the default ~/.claude plus every per-account
# dir from accounts.conf. Echoes one absolute path per line.
_subctl_sessions_cfg_dirs() {
  printf '%s\n' "$HOME/.claude"
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ -z "$cfg_dir" ]] && continue
    cfg_dir="${cfg_dir/#\~/$HOME}"
    [[ "$cfg_dir" == "$HOME/.claude" ]] && continue
    [[ -d "$cfg_dir" ]] && printf '%s\n' "$cfg_dir"
  done < <(subctl_list_accounts)
}

# Map a cfg_dir to a short display label. Default → "default", others → alias
# without the "claude-" prefix when possible.
_subctl_sessions_label_for() {
  local cfg_dir="$1"
  [[ "$cfg_dir" == "$HOME/.claude" ]] && { printf 'default'; return; }
  local found
  found=$(subctl_list_accounts | awk -F'\t' -v c="$cfg_dir" '$4==c {print $1; exit}')
  if [[ -n "$found" ]]; then
    printf '%s' "${found#claude-}"
  else
    printf '%s' "$(basename "$cfg_dir" | sed 's/^\.claude-//')"
  fi
}

# Walk every cfg_dir's projects/ tree and emit one session per line as TSV:
#   cfg_dir \t label \t encoded_cwd \t cwd \t sid \t bytes \t mtime \t start_ts
# `cwd` is read from the first jsonl line; `mtime` is filesystem last-modified.
subctl_sessions_list_all() {
  local cfg_dir
  while IFS= read -r cfg_dir; do
    [[ -d "$cfg_dir/projects" ]] || continue
    local label
    label=$(_subctl_sessions_label_for "$cfg_dir")
    local pdir
    for pdir in "$cfg_dir/projects"/*/; do
      [[ -d "$pdir" ]] || continue
      local encoded_cwd
      encoded_cwd=$(basename "$pdir")
      local jsonl
      for jsonl in "$pdir"*.jsonl; do
        [[ -f "$jsonl" ]] || continue
        local sid bytes mtime cwd start_ts first_line
        sid=$(basename "$jsonl" .jsonl)
        bytes=$(stat -f %z "$jsonl" 2>/dev/null || stat -c %s "$jsonl" 2>/dev/null || echo 0)
        mtime=$(stat -f %m "$jsonl" 2>/dev/null || stat -c %Y "$jsonl" 2>/dev/null || echo 0)
        first_line=$(head -1 "$jsonl" 2>/dev/null)
        cwd=$(printf '%s' "$first_line" | jq -r '.cwd // empty' 2>/dev/null || true)
        start_ts=$(printf '%s' "$first_line" | jq -r '.timestamp // empty' 2>/dev/null || true)
        # Fall back to decoded encoded_cwd if jsonl has no .cwd (some old
        # session formats). Decode is lossy when path components contain "-",
        # but it's the best we can do.
        if [[ -z "$cwd" ]]; then
          cwd="${encoded_cwd//-//}"
        fi
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
          "$cfg_dir" "$label" "$encoded_cwd" "$cwd" "$sid" "$bytes" "$mtime" "${start_ts:-?}"
      done
    done
  done < <(_subctl_sessions_cfg_dirs)
}

_fmt_size() {
  local b="$1"
  if (( b >= 1048576 )); then printf '%.1fMB' "$(awk -v n="$b" 'BEGIN{print n/1048576}')"
  elif (( b >= 1024 )); then  printf '%.1fKB' "$(awk -v n="$b" 'BEGIN{print n/1024}')"
  else printf '%dB' "$b"
  fi
}
_fmt_age() {
  local now mtime age
  now=$(date +%s); mtime="$1"; age=$(( now - mtime ))
  if (( age < 60 )); then    printf '%ds'  "$age"
  elif (( age < 3600 )); then printf '%dm' $(( age / 60 ))
  elif (( age < 86400 )); then printf '%dh' $(( age / 3600 ))
  else printf '%dd' $(( age / 86400 ))
  fi
}

# Pretty table, sorted by last activity (newest first). Optionally filtered:
#   --orphans      only sessions in the default ~/.claude (not yet adopted)
#   --account <alias>   only sessions in that account's cfg_dir
subctl_sessions_list_table() {
  local filter="all"
  local filter_alias=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orphans) filter="orphans"; shift ;;
      --account) filter="account"; filter_alias="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  local target_label=""
  if [[ "$filter" == "account" ]]; then
    [[ -z "$filter_alias" ]] && { subctl_err "--account requires an alias"; return 1; }
    local canonical
    canonical=$(subctl_resolve_alias "$filter_alias") || { subctl_err "unknown alias: $filter_alias"; return 1; }
    target_label="${canonical#claude-}"
  fi

  printf "%-10s  %-44s  %-36s  %-7s  %-8s  %s\n" \
    "ACCOUNT" "CWD" "SESSION-ID" "SIZE" "LAST" "STARTED"
  printf "%-10s  %-44s  %-36s  %-7s  %-8s  %s\n" \
    "──────────" "$(printf -- '─%.0s' {1..44})" "$(printf -- '─%.0s' {1..36})" \
    "───────" "────────" "────────────────────"

  subctl_sessions_list_all | sort -t$'\t' -k7,7nr | \
    while IFS=$'\t' read -r cfg_dir label encoded_cwd cwd sid bytes mtime start_ts; do
      case "$filter" in
        orphans)
          [[ "$label" != "default" ]] && continue
          ;;
        account)
          [[ "$label" != "$target_label" ]] && continue
          ;;
      esac
      local cwd_short="$cwd"
      [[ ${#cwd_short} -gt 44 ]] && cwd_short="…${cwd_short: -43}"
      local started=""
      [[ "$start_ts" != "?" && -n "$start_ts" ]] && started="${start_ts:0:16}Z"
      printf "%-10s  %-44s  %-36s  %-7s  %-8s  %s\n" \
        "$label" "$cwd_short" "$sid" "$(_fmt_size "$bytes")" "$(_fmt_age "$mtime") ago" "$started"
    done
}

# Adopt one session into a target account.
#   subctl_sessions_adopt <alias> <sid> [--force]
subctl_sessions_adopt() {
  local target_alias="${1:-}"
  local sid="${2:-}"
  local force=false
  shift $(( $# > 2 ? 2 : $# ))
  [[ "${1:-}" == "--force" ]] && force=true

  [[ -z "$target_alias" || -z "$sid" ]] && {
    subctl_err "usage: subctl sessions adopt <alias> <session-id> [--force]"
    return 1
  }

  local canonical target_cfg_dir
  canonical=$(subctl_resolve_alias "$target_alias") || { subctl_err "unknown alias: $target_alias"; return 1; }
  target_cfg_dir=$(subctl_account_field "$canonical" 4)
  [[ -z "$target_cfg_dir" ]] && { subctl_err "no config_dir for $canonical"; return 1; }

  # Find the session.
  local row
  row=$(subctl_sessions_list_all | awk -F'\t' -v s="$sid" '$5==s { print; exit }')
  [[ -z "$row" ]] && { subctl_err "session $sid not found in any cfg_dir"; return 1; }

  local src_cfg_dir src_label src_encoded src_cwd
  IFS=$'\t' read -r src_cfg_dir src_label src_encoded src_cwd _ _ _ _ <<<"$row"

  if [[ "$src_cfg_dir" == "$target_cfg_dir" ]]; then
    subctl_warn "$sid already lives in $canonical's cfg_dir; nothing to do"
    return 0
  fi

  local src="$src_cfg_dir/projects/$src_encoded/$sid.jsonl"
  local dst_dir="$target_cfg_dir/projects/$src_encoded"
  local dst="$dst_dir/$sid.jsonl"

  if [[ -f "$dst" ]] && ! $force; then
    subctl_warn "destination already exists: $dst"
    subctl_warn "  re-run with --force to overwrite"
    return 1
  fi

  mkdir -p "$dst_dir"
  cp -p "$src" "$dst"
  subctl_ok "adopted $sid"
  printf "  source: %s\n" "$src"
  printf "  dest:   %s\n" "$dst"
  echo
  echo "Resume with:"
  printf "  cd %q\n" "$src_cwd"
  printf "  claude-%s --resume %s\n" "${canonical#claude-}" "$sid"
  echo "  (or: CLAUDE_CONFIG_DIR=%q command claude --resume $sid)" "$target_cfg_dir"
}

# Adopt-latest: take the newest orphaned session and adopt it for <alias>.
subctl_sessions_adopt_latest() {
  local target_alias="${1:-}"
  [[ -z "$target_alias" ]] && { subctl_err "usage: subctl sessions adopt-latest <alias>"; return 1; }

  local row
  row=$(subctl_sessions_list_all \
    | awk -F'\t' '$2=="default" {print}' \
    | sort -t$'\t' -k7,7nr | head -1)
  [[ -z "$row" ]] && { subctl_warn "no orphaned sessions to adopt"; return 0; }
  local sid
  IFS=$'\t' read -r _ _ _ _ sid _ _ _ <<<"$row"
  subctl_sessions_adopt "$target_alias" "$sid"
}

# Interactive picker. Uses gum if available; otherwise a numbered prompt.
subctl_sessions_pick() {
  local target_alias="${1:-}"
  [[ -z "$target_alias" ]] && { subctl_err "usage: subctl sessions pick <alias>"; return 1; }
  local canonical
  canonical=$(subctl_resolve_alias "$target_alias") || { subctl_err "unknown alias: $target_alias"; return 1; }

  # Build a list of candidates (everything not already in the target account).
  local target_cfg_dir
  target_cfg_dir=$(subctl_account_field "$canonical" 4)

  local rows=()
  while IFS= read -r r; do
    rows+=( "$r" )
  done < <(subctl_sessions_list_all \
    | awk -F'\t' -v t="$target_cfg_dir" '$1!=t {print}' \
    | sort -t$'\t' -k7,7nr)

  if [[ ${#rows[@]} -eq 0 ]]; then
    subctl_warn "no candidate sessions to adopt for $canonical"
    return 0
  fi

  if subctl_have gum; then
    # gum-driven picker — display compact line, parse SID off the trailing column.
    local picked
    picked=$(printf "%s\n" "${rows[@]}" | while IFS=$'\t' read -r cfg_dir label encoded cwd sid bytes mtime start_ts; do
      printf "[%-10s] %-44s  %s  (%s, %s ago)\n" \
        "$label" "${cwd:0:44}" "$sid" "$(_fmt_size "$bytes")" "$(_fmt_age "$mtime")"
    done | gum filter --header "Pick a session to adopt for $canonical (type to filter)")
    [[ -z "$picked" ]] && { subctl_info "no selection — cancelled"; return 0; }
    # Extract SID — it's a UUIDish token after the cwd column.
    local sid
    sid=$(printf '%s' "$picked" | awk '{
      for (i=1; i<=NF; i++) if ($i ~ /^[0-9a-f]{8}-[0-9a-f]{4}/) { print $i; exit }
    }')
    [[ -z "$sid" ]] && { subctl_err "could not parse session id from selection"; return 1; }
    subctl_sessions_adopt "$canonical" "$sid"
    return $?
  fi

  # Fallback: numbered prompt.
  local i=0
  for r in "${rows[@]}"; do
    i=$((i+1))
    IFS=$'\t' read -r cfg_dir label encoded cwd sid bytes mtime start_ts <<<"$r"
    printf "%2d. [%-10s] %-44s  %s  (%s, %s ago)\n" \
      "$i" "$label" "${cwd:0:44}" "$sid" "$(_fmt_size "$bytes")" "$(_fmt_age "$mtime")"
  done
  echo
  read -r -p "Pick number (q to cancel): " choice
  [[ "$choice" == "q" || -z "$choice" ]] && return 0
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#rows[@]} )); then
    subctl_err "invalid choice"; return 1
  fi
  local picked_row="${rows[$((choice-1))]}"
  local sid
  IFS=$'\t' read -r _ _ _ _ sid _ _ _ <<<"$picked_row"
  subctl_sessions_adopt "$canonical" "$sid"
}
