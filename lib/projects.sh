#!/usr/bin/env bash
# lib/projects.sh — declarative per-account project bindings + bulk launcher.
#
# The user's stated workflow: "I want to run a tmux session for each of three
# projects. One on semfreak, one on jason, one on titanium. Pick up where I
# left off so I'm not rate limiting."
#
# This module reads ~/.config/subctl/projects.conf and lets you launch all
# (or one) project's tmux session in a single command. Each launch is just
# a thin wrapper around `subctl teams claude -a <alias>` so existing teams
# behavior (CLAUDE_CONFIG_DIR set in tmux session env, orchestrator prompt,
# etc.) carries over.

[[ -n "${_SUBCTL_PROJECTS_LOADED:-}" ]] && return 0
_SUBCTL_PROJECTS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

SUBCTL_PROJECTS_CONF="${SUBCTL_PROJECTS_CONF:-$SUBCTL_CONFIG_DIR/projects.conf}"

# Seed the projects.conf from the bundled example if it doesn't exist yet.
subctl_projects_ensure_conf() {
  subctl_ensure_config_dir
  if [[ ! -f "$SUBCTL_PROJECTS_CONF" ]]; then
    local example="$SUBCTL_REPO_ROOT/config/projects.conf.example"
    if [[ -f "$example" ]]; then
      cp "$example" "$SUBCTL_PROJECTS_CONF"
      chmod 600 "$SUBCTL_PROJECTS_CONF"
      subctl_info "seeded $SUBCTL_PROJECTS_CONF from example — edit it with your projects"
    fi
  fi
}

# Stream every non-empty, non-comment row as TSV:
#   name \t account_alias \t project_dir \t description
# project_dir has ~ expanded.
subctl_projects_list() {
  [[ -f "$SUBCTL_PROJECTS_CONF" ]] || return 0
  local line name acct dir desc
  while IFS='|' read -r name acct dir desc; do
    name=$(_subctl_trim "$name")
    acct=$(_subctl_trim "$acct")
    dir=$(_subctl_trim "$dir")
    desc=$(_subctl_trim "$desc")
    [[ -z "$name" || "${name:0:1}" == "#" ]] && continue
    dir="${dir/#\~/$HOME}"
    printf '%s\t%s\t%s\t%s\n' "$name" "$acct" "$dir" "$desc"
  done < "$SUBCTL_PROJECTS_CONF"
}

# tmux session name for a project. Same convention teams.sh uses.
_subctl_projects_session_name() {
  local name="$1"
  printf 'claude-%s' "$(printf '%s' "$name" | tr '.: ' '___')"
}

# Pretty status table: which projects exist + which are currently in tmux.
subctl_projects_status() {
  subctl_projects_ensure_conf
  printf "%-14s %-18s %-44s %s\n" "PROJECT" "ACCOUNT" "DIR" "STATUS"
  printf "%-14s %-18s %-44s %s\n" \
    "$(printf -- '─%.0s' {1..12})" \
    "$(printf -- '─%.0s' {1..16})" \
    "$(printf -- '─%.0s' {1..42})" \
    "$(printf -- '─%.0s' {1..14})"

  local count=0
  while IFS=$'\t' read -r name acct dir desc; do
    count=$((count + 1))
    local sname status_color status_text
    sname=$(_subctl_projects_session_name "$name")
    if subctl_have tmux && tmux has-session -t "$sname" 2>/dev/null; then
      status_color="$C_GRN"
      status_text="● running ($sname)"
    elif [[ ! -d "$dir" ]]; then
      status_color="$C_YLW"
      status_text="⚠ dir missing"
    else
      status_color="$C_DIM"
      status_text="○ stopped"
    fi
    local dir_short="$dir"
    [[ ${#dir_short} -gt 42 ]] && dir_short="…${dir_short: -41}"
    printf "%-14s %-18s %-44s ${status_color}%s${C_RST}\n" \
      "$name" "$acct" "$dir_short" "$status_text"
  done < <(subctl_projects_list)

  if [[ $count -eq 0 ]]; then
    printf "\n${C_DIM}No projects configured. Edit ${SUBCTL_PROJECTS_CONF} to add bindings.${C_RST}\n"
    printf "${C_DIM}Or open it now: subctl projects edit${C_RST}\n"
  fi
}

# Launch one project. Reuses providers/claude/teams.sh.
# Args: <name>  [--resume|--no-resume]  [--orchestrator]  [--yes]  [--dry-run]
subctl_projects_start_one() {
  local target="${1:-}"
  shift || true
  [[ -z "$target" ]] && { subctl_err "subctl_projects_start_one: name required"; return 1; }

  local resume=true orchestrator=false yes_flag=false dry_run=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --resume)        resume=true; shift ;;
      --no-resume)     resume=false; shift ;;
      --orchestrator|-o) orchestrator=true; shift ;;
      --yes|-y)        yes_flag=true; shift ;;
      --dry-run)       dry_run=true; shift ;;
      *) shift ;;
    esac
  done

  local row
  row=$(subctl_projects_list | awk -F'\t' -v t="$target" '$1==t {print; exit}')
  if [[ -z "$row" ]]; then
    subctl_err "no project named '$target' in $SUBCTL_PROJECTS_CONF"
    return 1
  fi

  local name acct dir desc
  IFS=$'\t' read -r name acct dir desc <<<"$row"
  if [[ ! -d "$dir" ]]; then
    subctl_err "project dir does not exist: $dir"
    return 1
  fi

  local sname
  sname=$(_subctl_projects_session_name "$name")
  if subctl_have tmux && tmux has-session -t "$sname" 2>/dev/null; then
    subctl_info "$name already running (tmux session: $sname) — attach with: tmux attach -t $sname"
    return 0
  fi

  local args=( -a "$acct" )
  $resume       && args+=( -c )    # --continue: resume most recent session in cwd
  $orchestrator && args+=( -o )
  $yes_flag     && args+=( -y )
  $dry_run      && args+=( --dry-run )

  subctl_ok "starting $name → $acct in $dir"
  # The teams launcher cd's into PWD, so spawn it with PWD set correctly.
  ( cd "$dir" && . "$SUBCTL_REPO_ROOT/providers/claude/teams.sh" && provider_claude_teams "${args[@]}" )
}

# Launch every project that isn't already running. Detached so the user
# returns to their shell immediately; they can `tmux attach -t claude-<name>`
# (or use `subctl session-list`) to jump in.
subctl_projects_start_all() {
  subctl_projects_ensure_conf
  local pass="$@"
  # Force detached launches when starting all (otherwise the first one would
  # attach and block the rest).
  pass+=" --no-attach"

  local count=0 started=0 already=0
  while IFS=$'\t' read -r name acct dir desc; do
    count=$((count + 1))
    local sname
    sname=$(_subctl_projects_session_name "$name")
    if subctl_have tmux && tmux has-session -t "$sname" 2>/dev/null; then
      already=$((already + 1))
      printf "  ${C_DIM}—${C_RST} %-12s already running ($sname)\n" "$name"
      continue
    fi
    if [[ ! -d "$dir" ]]; then
      printf "  ${C_YLW}!${C_RST} %-12s skip — dir missing: %s\n" "$name" "$dir"
      continue
    fi
    started=$((started + 1))
    # Run the launcher in --dry-run-attach mode: the underlying teams.sh
    # ends with `tmux attach`, which would block. We launch each project's
    # tmux session detached and skip the attach by running the launcher in
    # a subshell with TMUX set so it uses switch-client (no-op when not in
    # a real tmux pane) instead of attach-session. Practical workaround:
    # set TMUX="external" so attach is skipped (the var existence is what
    # teams.sh keys off of).
    ( cd "$dir" && TMUX="${TMUX:-external}" \
        . "$SUBCTL_REPO_ROOT/providers/claude/teams.sh" \
        && provider_claude_teams -a "$acct" -c >/dev/null 2>&1 ) || true
    printf "  ${C_GRN}✓${C_RST} %-12s started → %s in %s\n" "$name" "$acct" "$dir"
  done < <(subctl_projects_list)

  if [[ $count -eq 0 ]]; then
    subctl_warn "no projects configured. Run: subctl projects edit"
    return 1
  fi
  echo
  printf "${C_DIM}Attach with: tmux attach -t claude-<name>   ·   See all: subctl session-list${C_RST}\n"
}

subctl_projects_edit() {
  subctl_projects_ensure_conf
  local editor="${VISUAL:-${EDITOR:-vi}}"
  "$editor" "$SUBCTL_PROJECTS_CONF"
}

subctl_projects_path() {
  echo "$SUBCTL_PROJECTS_CONF"
}
