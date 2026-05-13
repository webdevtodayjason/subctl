#!/usr/bin/env bash
# components/skills/skills.sh — local skill catalog management.
#
# Skills are markdown files with frontmatter that define a focused agent
# capability. Format (per Claude Code):
#
#   ---
#   name: skill-name
#   description: When to use this skill, in one paragraph.
#   ---
#
#   # Skill content (markdown)
#
# We import skills from public git repos that publish in this format
# (mattpocock/skills, affaan-m/everything-claude-code, etc.) into a
# local catalog at $SUBCTL_SKILLS_DIR. Team templates (Phase 3b) then
# pick from this catalog when defining what skills a dev-team lead
# should boot with.

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

SUBCTL_SKILLS_DIR="${SUBCTL_SKILLS_DIR:-$HOME/.config/subctl/skills}"

subctl_skills() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    import)   subctl_skills_import "$@" ;;
    list|ls)  subctl_skills_list "$@" ;;
    info)     subctl_skills_info "$@" ;;
    rm|remove) subctl_skills_remove "$@" ;;
    sources)  subctl_skills_sources ;;
    # ── v2.8.1 chat perf / skill router ──
    router-trace) subctl_skills_router_trace "$@" ;;
    -h|--help|"")
      cat <<EOF
subctl skills <verb> [args]

  Manage the local skill catalog at \$SUBCTL_SKILLS_DIR
  (default: ~/.config/subctl/skills).

Verbs:
  import <github-repo> [--source <name>]
                            Clone a skills repo and copy its skills/
                            subtree into the local catalog.
  list, ls [--source <s>]   List imported skills.
  info <skill-id>           Show a skill's frontmatter + first lines.
  rm, remove <skill-id>     Remove a skill from the catalog.
  sources                   List skill sources (each repo imported = source).
  router-trace <msg...>     v2.8.1 — Score the master's in-repo skill
                            catalog against a sample operator message
                            and show which skills the router would
                            preload. Add --force to bypass the runtime
                            enable flag.

Examples:
  subctl skills import mattpocock/skills
  subctl skills import affaan-m/everything-claude-code --source ecc
  subctl skills list
  subctl skills list --source mattpocock
  subctl skills info mattpocock/engineering/grill-with-docs
  subctl skills router-trace --force "spawn a node team to refactor server.ts"
EOF
      ;;
    *) subctl_die "unknown skills verb: $sub" ;;
  esac
}

# ── v2.8.1 chat perf / skill router ──
# Thin shim — defer to the TS implementation at bin/skills/router-trace.ts.
# Routed through bun so the implementation can re-import the live
# skill-router module the master daemon uses (no shell duplication of
# the scoring logic).
subctl_skills_router_trace() {
  local script="$SUBCTL_REPO_ROOT/bin/skills/router-trace.ts"
  if [[ ! -f "$script" ]]; then
    subctl_die "router-trace script missing at $script"
  fi
  subctl_require bun "install: brew install oven-sh/bun/bun" || return 1
  bun "$script" "$@"
}

subctl_skills_import() {
  local repo="" source="" branch="main"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source|-s) source="$2"; shift 2 ;;
      --branch|-b) branch="$2"; shift 2 ;;
      *) repo="$1"; shift ;;
    esac
  done

  [[ -z "$repo" ]] && subctl_die "usage: subctl skills import <owner/repo or full URL> [--source <name>]"

  subctl_require git "install: brew install git" || return 1

  # Normalize repo input. Accept "owner/repo" or "https://github.com/owner/repo"
  local clone_url
  if [[ "$repo" == http* || "$repo" == git@* ]]; then
    clone_url="$repo"
    [[ -z "$source" ]] && source=$(basename "$repo" .git)
  else
    clone_url="https://github.com/${repo}.git"
    [[ -z "$source" ]] && source=$(echo "$repo" | cut -d/ -f1)
  fi

  mkdir -p "$SUBCTL_SKILLS_DIR"
  local source_dir="$SUBCTL_SKILLS_DIR/$source"
  if [[ -d "$source_dir" ]]; then
    subctl_warn "source '$source' already exists at $source_dir — pulling latest"
    (cd "$source_dir" && git pull --ff-only 2>&1 | tail -3) || subctl_warn "pull failed (continuing)"
  else
    subctl_info "cloning $clone_url → $source_dir"
    local tmp="${SUBCTL_SKILLS_DIR}/.tmp-import-$$"
    rm -rf "$tmp"
    if ! git clone --depth 1 --branch "$branch" "$clone_url" "$tmp" 2>&1 | tail -5; then
      rm -rf "$tmp"
      subctl_die "clone failed"
    fi
    if [[ ! -d "$tmp/skills" ]]; then
      rm -rf "$tmp"
      subctl_die "$repo has no skills/ directory at the top level — not a skills repo"
    fi
    # Move skills/ subtree into source_dir; preserve .git so we can pull later
    mkdir -p "$source_dir"
    rsync -a "$tmp/skills/" "$source_dir/skills/"
    # Keep the upstream git ref for future pulls — but stash it inside
    # the source_dir so it doesn't pollute the user's view.
    mv "$tmp/.git" "$source_dir/.git" 2>/dev/null || true
    rm -rf "$tmp"
  fi

  # Count skills in the imported set
  local count
  count=$(find "$source_dir/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
  subctl_ok "imported source '$source' — $count skill(s) at $source_dir/skills"
}

subctl_skills_list() {
  local filter_source=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source|-s) filter_source="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ ! -d "$SUBCTL_SKILLS_DIR" ]]; then
    echo "(no catalog at $SUBCTL_SKILLS_DIR — import some skills first)"
    return 0
  fi
  local found=0
  while IFS= read -r skill_md; do
    [[ -z "$skill_md" ]] && continue
    found=1
    # skill_md = $SUBCTL_SKILLS_DIR/<source>/skills/<rest>/SKILL.md
    local rel="${skill_md#$SUBCTL_SKILLS_DIR/}"
    local source="${rel%%/*}"
    [[ -n "$filter_source" && "$source" != "$filter_source" ]] && continue
    # Skill id = source/rel-without-leading-skills/
    local skill_path="${rel#$source/skills/}"
    local skill_id="$source/${skill_path%/SKILL.md}"
    local desc
    desc=$(awk '
      /^---/ { in_fm = !in_fm; next }
      in_fm && /^description:/ { sub(/^description:[ ]*/, ""); print; exit }
    ' "$skill_md" 2>/dev/null | head -c 100)
    printf "  %-60s %s\n" "$skill_id" "${desc:0:80}"
  done < <(find "$SUBCTL_SKILLS_DIR" -name SKILL.md 2>/dev/null | sort)
  if [[ $found -eq 0 ]]; then
    echo "(no skills imported yet — try: subctl skills import mattpocock/skills)"
  fi
}

subctl_skills_info() {
  local id="${1:-}"
  [[ -z "$id" ]] && subctl_die "usage: subctl skills info <source/path/to/skill>"
  local skill_md="$SUBCTL_SKILLS_DIR/$id/SKILL.md"
  # ID convention: source/skill-relative-path. The on-disk layout adds /skills/
  # between the source and the skill path, so try the conventional form first
  # then fall back to {source}/skills/{rest}/SKILL.md.
  if [[ ! -f "$skill_md" ]]; then
    local source="${id%%/*}"
    local rest="${id#*/}"
    skill_md="$SUBCTL_SKILLS_DIR/$source/skills/$rest/SKILL.md"
  fi
  if [[ ! -f "$skill_md" ]]; then
    subctl_die "skill not found: $id"
  fi
  echo "── $skill_md ──"
  cat "$skill_md"
}

subctl_skills_remove() {
  local id="${1:-}"
  [[ -z "$id" ]] && subctl_die "usage: subctl skills rm <source/path/to/skill>"
  local skill_dir="$SUBCTL_SKILLS_DIR/$id"
  if [[ ! -d "$skill_dir" ]]; then
    local source="${id%%/*}"
    local rest="${id#*/}"
    skill_dir="$SUBCTL_SKILLS_DIR/$source/skills/$rest"
  fi
  if [[ ! -d "$skill_dir" ]]; then
    subctl_die "skill not found: $id"
  fi
  read -r -p "Remove $skill_dir? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] && rm -rf "$skill_dir" && subctl_ok "removed $id"
}

subctl_skills_sources() {
  if [[ ! -d "$SUBCTL_SKILLS_DIR" ]]; then
    echo "(no catalog yet)"
    return 0
  fi
  for source_dir in "$SUBCTL_SKILLS_DIR"/*/; do
    [[ -d "$source_dir" ]] || continue
    local source
    source=$(basename "$source_dir")
    local count
    count=$(find "$source_dir/skills" -name SKILL.md 2>/dev/null | wc -l | tr -d ' ')
    local origin="(local)"
    if [[ -d "$source_dir/.git" ]]; then
      origin=$(git -C "$source_dir" config --get remote.origin.url 2>/dev/null || echo "(no remote)")
    fi
    printf "  %-30s  %s skills  %s\n" "$source" "$count" "$origin"
  done
}
