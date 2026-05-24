#!/usr/bin/env bash
# components/teams/teams.sh — dev-team template management.
#
# A team template = a named bundle that defines how a dev-team lead boots:
#   - persona: the system prompt that defines the lead's role
#   - skills:  list of skill IDs from the local skill catalog
#              (~/.config/subctl/skills/) that get copied into the lead's
#              .claude/skills/ directory before tmux starts
#   - tools:   subctl tool family whitelist (subctl_orch, gh, coderabbit,
#              telegram, system, project, vault) — controls what the lead
#              can call via TeamCreate/Agent
#   - default_autonomy: drive | ask | shadow override per template
#   - boot_prompt: what the lead is told as its first message
#
# Stored at $SUBCTL_TEAM_TEMPLATES_DIR/<name>.json (default
# ~/.config/subctl/evy/team-templates/).
#
# Used by `subctl orch spawn --template <name>` (Phase 3c) to wire a
# specialized lead before launching its tmux session.

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

SUBCTL_TEAM_TEMPLATES_DIR="${SUBCTL_TEAM_TEMPLATES_DIR:-$HOME/.config/subctl/evy/team-templates}"

subctl_templates() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    list|ls)   subctl_templates_list "$@" ;;
    show)      subctl_templates_show "$@" ;;
    create)    subctl_templates_create "$@" ;;
    delete|rm) subctl_templates_delete "$@" ;;
    duplicate|dup) subctl_templates_duplicate "$@" ;;
    -h|--help|"")
      cat <<EOF
subctl templates <verb> [args]

  Manage dev-team templates at \$SUBCTL_TEAM_TEMPLATES_DIR
  (default: ~/.config/subctl/evy/team-templates/).

Verbs:
  list, ls                       List all templates.
  show <name>                    Print one template's JSON.
  create <name> [--from <file>]  Create from a JSON file (or empty stub).
  delete <name>                  Remove a template.
  duplicate <src> <dst>          Copy a template under a new name.

Templates are JSON. See the dashboard's Teams tab for the schema and a
guided editor.
EOF
      ;;
    *) subctl_die "unknown templates verb: $sub" ;;
  esac
}

subctl_templates_list() {
  if [[ ! -d "$SUBCTL_TEAM_TEMPLATES_DIR" ]]; then
    echo "(no templates yet — create one in the dashboard's Teams tab or via subctl teams create)"
    return 0
  fi
  local found=0
  for f in "$SUBCTL_TEAM_TEMPLATES_DIR"/*.json; do
    [[ -e "$f" ]] || continue
    found=1
    local name desc skills_count tools_count
    name=$(basename "$f" .json)
    desc=$(jq -r '.description // "(no description)"' "$f" 2>/dev/null)
    skills_count=$(jq -r '(.skills // []) | length' "$f" 2>/dev/null)
    tools_count=$(jq -r '(.tools // []) | length' "$f" 2>/dev/null)
    printf "  %-30s  %s skills · %s tools  %s\n" "$name" "$skills_count" "$tools_count" "${desc:0:60}"
  done
  [[ $found -eq 0 ]] && echo "(no templates yet)"
}

subctl_templates_show() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl teams show <name>"
  local f="$SUBCTL_TEAM_TEMPLATES_DIR/$name.json"
  [[ -f "$f" ]] || subctl_die "template not found: $name"
  jq . "$f"
}

subctl_templates_create() {
  local name="" from_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from) from_file="$2"; shift 2 ;;
      *) name="$1"; shift ;;
    esac
  done
  [[ -z "$name" ]] && subctl_die "usage: subctl teams create <name> [--from <file>]"
  [[ ! "$name" =~ ^[a-zA-Z0-9._-]+$ ]] && subctl_die "name must be alphanumerics + . - _"
  mkdir -p "$SUBCTL_TEAM_TEMPLATES_DIR"
  local f="$SUBCTL_TEAM_TEMPLATES_DIR/$name.json"
  [[ -f "$f" ]] && subctl_die "template already exists: $name"
  if [[ -n "$from_file" ]]; then
    [[ -f "$from_file" ]] || subctl_die "source file not found: $from_file"
    jq . "$from_file" > "$f" || subctl_die "source is not valid JSON"
  else
    cat > "$f" <<JSON
{
  "name": "$name",
  "description": "(describe what this dev team does)",
  "persona": "You are the lead of a dev team. Replace this with the persona prompt your team should boot with.",
  "skills": [],
  "tools": ["subctl_orch_*", "gh_*", "telegram_*"],
  "default_autonomy": "ask",
  "boot_prompt": "Read CLAUDE.md and any RESUME.md in the project, then ask Jason what scope to start with."
}
JSON
  fi
  subctl_ok "created $f"
}

subctl_templates_delete() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl teams delete <name>"
  local f="$SUBCTL_TEAM_TEMPLATES_DIR/$name.json"
  [[ -f "$f" ]] || subctl_die "template not found: $name"
  read -r -p "Delete $f? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] && rm "$f" && subctl_ok "deleted $name"
}

subctl_templates_duplicate() {
  local src="${1:-}" dst="${2:-}"
  [[ -z "$src" || -z "$dst" ]] && subctl_die "usage: subctl teams duplicate <src> <dst>"
  [[ ! "$dst" =~ ^[a-zA-Z0-9._-]+$ ]] && subctl_die "dst name must be alphanumerics + . - _"
  local sf="$SUBCTL_TEAM_TEMPLATES_DIR/$src.json"
  local df="$SUBCTL_TEAM_TEMPLATES_DIR/$dst.json"
  [[ -f "$sf" ]] || subctl_die "src not found: $src"
  [[ -f "$df" ]] && subctl_die "dst already exists: $dst"
  jq --arg n "$dst" '.name = $n' "$sf" > "$df"
  subctl_ok "duplicated $src → $dst"
}
