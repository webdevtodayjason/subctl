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
    # ── v2.8.3 skills clarity ──
    show)     subctl_skills_show "$@" ;;
    promote)  subctl_skills_promote "$@" ;;
    delete)   subctl_skills_delete "$@" ;;
    # ── end v2.8.3 skills clarity ──
    -h|--help|"")
      cat <<EOF
subctl skills <verb> [args]

  Manage the local skill catalog at \$SUBCTL_SKILLS_DIR
  (default: ~/.config/subctl/skills) AND the v2.8.1 categorized view
  (Evy-loaded / team-developer / Evy-authored / project-local).

Verbs:
  import <github-repo> [--source <name>]
                            Clone a skills repo and copy its skills/
                            subtree into the local catalog.
  list, ls [--source <s>] [--category <c>]
                            List skills. --category filters to one of
                            evy-loaded, team-developer, evy-authored,
                            project-local (v2.8.1).
  show <name>               Print a skill's full SKILL.md body. Looks up
                            by frontmatter name across all sources.
                            (v2.8.1)
  info <skill-id>           Show an imported skill's frontmatter +
                            first lines (legacy path-based lookup).
  promote <name>            Promote an Evy-authored draft from
                            ~/.local/state/subctl/evy-skills/<name>/
                            into the repo's components/skills/<name>/.
                            Sets promoted_by + promoted_at; does NOT
                            auto-commit. (v2.8.1)
  delete <name>             Delete an Evy-authored draft. Refuses on
                            anything outside the evy-skills dir.
                            (v2.8.1)
  rm, remove <skill-id>     Remove a skill from the imported catalog.
  sources                   List skill sources (each repo imported = source).
  router-trace <msg...>     v2.8.1 — Score the master's in-repo skill
                            catalog against a sample operator message
                            and show which skills the router would
                            preload. Add --force to bypass the runtime
                            enable flag.

Examples:
  subctl skills import mattpocock/skills
  subctl skills list
  subctl skills list --source mattpocock
  subctl skills list --category evy-authored
  subctl skills info mattpocock/engineering/grill-with-docs
  subctl skills show msp-client-onboarding
  subctl skills promote msp-client-onboarding
  subctl skills delete  draft-bad-name
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

# ── v2.8.1 skills clarity ──

# Resolve the dashboard URL once; reuse for the categorized endpoints.
# Default mirrors components/master/server.ts SUBCTL_API.
_subctl_skills_api_base() {
  echo "${SUBCTL_API:-http://127.0.0.1:8787}"
}

# Pretty-print the categorized payload, optionally filtered to one category.
subctl_skills_list() {
  local filter_source="" filter_category=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source|-s) filter_source="$2"; shift 2 ;;
      --category|-c) filter_category="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # If --category was set OR no --source was set, prefer the categorized
  # view. Otherwise (--source given), fall back to the legacy flat list to
  # keep the imported-catalog UX unchanged.
  if [[ -n "$filter_category" || -z "$filter_source" ]]; then
    local url="$(_subctl_skills_api_base)/api/skills/categorized"
    local json
    if ! json=$(curl -fsSL --max-time 5 "$url" 2>/dev/null); then
      # Dashboard isn't reachable — fall back to the legacy lister.
      _subctl_skills_list_legacy "$filter_source"
      return
    fi
    local cats=(evy-loaded team-developer evy-authored project-local)
    [[ -n "$filter_category" ]] && cats=("$filter_category")
    local cat
    for cat in "${cats[@]}"; do
      printf "\n── %s ──\n" "$cat"
      echo "$json" | jq -r --arg cat "$cat" '
        .categories[$cat] // []
        | if length == 0 then "  (none)"
          else map("  " + .name + "  [" + .scope + "]  " + ((.description // "") | .[0:80]))
               | .[]
          end
      ' 2>/dev/null || echo "  (jq required for categorized output)"
    done
    return
  fi
  _subctl_skills_list_legacy "$filter_source"
}

# Legacy lister — preserved for `subctl skills list --source <s>` and the
# offline-dashboard fallback path. This is the pre-v2.8.1 body verbatim
# (renamed for clarity).
_subctl_skills_list_legacy() {
  local filter_source="${1:-}"
  if [[ ! -d "$SUBCTL_SKILLS_DIR" ]]; then
    echo "(no catalog at $SUBCTL_SKILLS_DIR — import some skills first)"
    return 0
  fi
  local found=0
  while IFS= read -r skill_md; do
    [[ -z "$skill_md" ]] && continue
    found=1
    local rel="${skill_md#$SUBCTL_SKILLS_DIR/}"
    local source="${rel%%/*}"
    [[ -n "$filter_source" && "$source" != "$filter_source" ]] && continue
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

# Print the full SKILL.md body, looked up by frontmatter name across the
# categorized registry. Uses the dashboard so the lookup matches what the
# Skills tab + Telegram /skills see.
subctl_skills_show() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl skills show <name>"
  local base
  base=$(_subctl_skills_api_base)

  # Try the evy-skills endpoint first (cheap exact match), then the
  # categorized index, then fall back to file-system scanning.
  local body
  if body=$(curl -fsSL --max-time 4 "$base/api/skills/evy/$(printf '%s' "$name" | jq -sRr @uri)" 2>/dev/null); then
    local content
    content=$(echo "$body" | jq -r '.content // empty' 2>/dev/null)
    if [[ -n "$content" ]]; then
      echo "── ~/.local/state/subctl/evy-skills/$name/SKILL.md ──"
      echo "$content"
      return
    fi
  fi

  # Search the categorized index for an exact-name match, then read the
  # file directly.
  local idx
  if idx=$(curl -fsSL --max-time 4 "$base/api/skills/categorized" 2>/dev/null); then
    local path
    path=$(echo "$idx" | jq -r --arg n "$name" '
      [.categories[]] | flatten | map(select(.name == $n)) | first | .path // empty
    ' 2>/dev/null)
    if [[ -n "$path" && -f "$path" ]]; then
      echo "── $path ──"
      cat "$path"
      return
    fi
  fi

  # Fall back to repo-skills scan.
  local repo_skill="$SUBCTL_REPO_ROOT/components/skills/$name/SKILL.md"
  if [[ -f "$repo_skill" ]]; then
    echo "── $repo_skill ──"
    cat "$repo_skill"
    return
  fi
  local evy_skill="${SUBCTL_EVY_SKILLS_DIR:-$HOME/.local/state/subctl/evy-skills}/$name/SKILL.md"
  if [[ -f "$evy_skill" ]]; then
    echo "── $evy_skill ──"
    cat "$evy_skill"
    return
  fi
  subctl_die "skill not found: $name"
}

# Promote an Evy-authored draft into the repo. Uses the dashboard
# /api/skills/evy/:name/promote endpoint so frontmatter is rewritten
# correctly + the audit log + notification fire.
subctl_skills_promote() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl skills promote <name>"
  local base
  base=$(_subctl_skills_api_base)
  local r
  if ! r=$(curl -fsSL --max-time 6 -X POST \
        -H "Content-Type: application/json" \
        -d '{"promoted_by":"operator"}' \
        "$base/api/skills/evy/$(printf '%s' "$name" | jq -sRr @uri)/promote" 2>&1); then
    subctl_die "promote failed: dashboard unreachable at $base"
  fi
  local ok
  ok=$(echo "$r" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    local to
    to=$(echo "$r" | jq -r '.to // empty' 2>/dev/null)
    subctl_ok "promoted $name → $to"
    echo "  (review the file diff in git; this command does NOT auto-commit)"
  else
    subctl_die "promote failed: $(echo "$r" | jq -r '.error // "unknown"' 2>/dev/null)"
  fi
}

# Delete an Evy-authored draft. Refuses on repo-tracked skills (handled
# server-side; the endpoint is scoped to evy-skills/).
subctl_skills_delete() {
  local name="${1:-}"
  [[ -z "$name" ]] && subctl_die "usage: subctl skills delete <name>"
  read -r -p "Delete Evy-authored draft '$name'? [y/N]: " yn
  [[ "$yn" =~ ^[Yy] ]] || { echo "aborted"; return; }
  local base
  base=$(_subctl_skills_api_base)
  local r
  if ! r=$(curl -fsSL --max-time 6 -X POST \
        "$base/api/skills/evy/$(printf '%s' "$name" | jq -sRr @uri)/delete" 2>&1); then
    subctl_die "delete failed: dashboard unreachable at $base"
  fi
  local ok
  ok=$(echo "$r" | jq -r '.ok // false' 2>/dev/null)
  if [[ "$ok" == "true" ]]; then
    subctl_ok "deleted $name"
  else
    subctl_die "delete failed: $(echo "$r" | jq -r '.error // "unknown"' 2>/dev/null)"
  fi
}

# ── end v2.8.1 skills clarity ──

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
