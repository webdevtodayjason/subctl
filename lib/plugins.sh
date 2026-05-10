#!/usr/bin/env bash
# lib/plugins.sh — subctl plugin discovery + lifecycle.
#
# Plugins live under ~/.config/subctl/plugins/<plugin-id>/. Each plugin
# ships a subctl.plugin.json manifest at its root:
#
#   {
#     "id": "my-plugin",                    canonical id
#     "name": "My Plugin",                  display name
#     "description": "...",                 one-liner
#     "version": "0.1.0",
#     "kind": "tool" | "skill-pack" | "dashboard-tab" | "cli-verb",
#     "tools":     ["…"],                   master tool family ids registered
#     "skills":    ["category/name"],       skill paths under skills/ (relative)
#     "tabs":      [{"id":"…","label":"…","icon":"…"}],
#     "verbs":     [{"verb":"…","exec":"./bin/foo"}],
#     "configSchema": { ... }               JSON schema for plugin config
#   }
#
# Discovery: subctl plugins list
# Install:   subctl plugins install <git-url-or-local-path>
# Remove:    subctl plugins remove <id>
# Status:    subctl plugins status (validates manifests, reports issues)
#
# Mirrors ArgentOS's plugin pattern (~/argentos/docs/plugins/manifest.md):
# manifest validates config WITHOUT executing plugin code; runtime loads
# the plugin module separately. Discoverable + auditable.

set -uo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

SUBCTL_PLUGINS_DIR="${SUBCTL_PLUGINS_DIR:-$HOME/.config/subctl/plugins}"

subctl_plugins() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    list|ls)   subctl_plugins_list "$@" ;;
    install)   subctl_plugins_install "$@" ;;
    remove|rm) subctl_plugins_remove "$@" ;;
    status)    subctl_plugins_status "$@" ;;
    show)      subctl_plugins_show "$@" ;;
    -h|--help|"")
      cat <<EOF
subctl plugins <verb> [args]

  Manage subctl plugins under \$SUBCTL_PLUGINS_DIR
  (default: ~/.config/subctl/plugins/).

Verbs:
  list, ls                   List installed plugins (with manifest summary)
  install <repo|path>        Install from git URL or local path. Validates
                             manifest before activating.
  remove <id>                Uninstall a plugin (no-ask).
  show <id>                  Print one plugin's manifest + file tree.
  status                     Validate every plugin's manifest. Report any
                             with missing or malformed subctl.plugin.json.

Manifest spec: every plugin must ship subctl.plugin.json at its root.
See ~/argentos/docs/plugins/manifest.md for the pattern this mirrors;
our schema is similar but with subctl-specific kinds (tool, skill-pack,
dashboard-tab, cli-verb).

Plugin runtime hookup:
  - tool plugins      auto-registered into master's tool registry at
                      master daemon boot
  - skill-pack        copied/symlinked into skill catalog as a source
  - dashboard-tab     sidebar item registered at dashboard boot
  - cli-verb          dispatched via subctl <verb> ...

EOF
      ;;
    *) subctl_die "unknown plugins verb: $sub" ;;
  esac
}

subctl_plugins_list() {
  if [[ ! -d "$SUBCTL_PLUGINS_DIR" ]]; then
    echo "(no plugins installed at $SUBCTL_PLUGINS_DIR)"
    return 0
  fi
  local found=0
  for plugin_dir in "$SUBCTL_PLUGINS_DIR"/*/; do
    [[ -d "$plugin_dir" ]] || continue
    found=1
    local id manifest
    id=$(basename "$plugin_dir")
    manifest="$plugin_dir/subctl.plugin.json"
    if [[ ! -f "$manifest" ]]; then
      printf "  %-30s ${C_RED}MISSING manifest${C_RST}\n" "$id"
      continue
    fi
    local name kind version
    name=$(jq -r '.name // .id // empty' "$manifest" 2>/dev/null)
    kind=$(jq -r '.kind // "?"' "$manifest" 2>/dev/null)
    version=$(jq -r '.version // ""' "$manifest" 2>/dev/null)
    printf "  %-30s %-15s %s %s\n" "$id" "[$kind]" "${version:-(no ver)}" "${name:-}"
  done
  [[ $found -eq 0 ]] && echo "(no plugins installed)"
}

subctl_plugins_install() {
  local source="${1:-}"
  [[ -z "$source" ]] && subctl_die "usage: subctl plugins install <git-url|local-path>"
  subctl_require git "install: brew install git" || return 1
  subctl_require jq "install: brew install jq" || return 1

  mkdir -p "$SUBCTL_PLUGINS_DIR"
  local tmpdir tmp_manifest plugin_id target_dir
  tmpdir=$(mktemp -d)

  # 1. Fetch into temp
  if [[ -d "$source" ]]; then
    cp -R "$source" "$tmpdir/plugin"
  elif [[ "$source" == http* || "$source" == git@* ]]; then
    if ! git clone --depth 1 "$source" "$tmpdir/plugin" 2>&1 | tail -3; then
      rm -rf "$tmpdir"
      subctl_die "git clone failed"
    fi
  else
    # Try as owner/repo shorthand
    if [[ "$source" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
      if ! git clone --depth 1 "https://github.com/${source}.git" "$tmpdir/plugin" 2>&1 | tail -3; then
        rm -rf "$tmpdir"
        subctl_die "git clone failed"
      fi
    else
      rm -rf "$tmpdir"
      subctl_die "source not recognized — pass a git URL, owner/repo, or local path: $source"
    fi
  fi

  # 2. Validate manifest
  tmp_manifest="$tmpdir/plugin/subctl.plugin.json"
  if [[ ! -f "$tmp_manifest" ]]; then
    rm -rf "$tmpdir"
    subctl_die "plugin missing required manifest at subctl.plugin.json"
  fi
  if ! jq -e '.id' "$tmp_manifest" >/dev/null 2>&1; then
    rm -rf "$tmpdir"
    subctl_die "manifest missing required 'id' field"
  fi
  plugin_id=$(jq -r '.id' "$tmp_manifest")
  if [[ ! "$plugin_id" =~ ^[a-z][a-z0-9-]{1,48}$ ]]; then
    rm -rf "$tmpdir"
    subctl_die "manifest id must match /^[a-z][a-z0-9-]{1,48}$/ — got: $plugin_id"
  fi

  # 3. Move into place
  target_dir="$SUBCTL_PLUGINS_DIR/$plugin_id"
  if [[ -d "$target_dir" ]]; then
    rm -rf "$target_dir"
    subctl_warn "removed existing $target_dir before reinstall"
  fi
  mv "$tmpdir/plugin" "$target_dir"
  rm -rf "$tmpdir"

  # 4. Report what got registered
  local kind tools_count skills_count tabs_count verbs_count
  kind=$(jq -r '.kind // "?"' "$target_dir/subctl.plugin.json")
  tools_count=$(jq -r '(.tools // []) | length' "$target_dir/subctl.plugin.json")
  skills_count=$(jq -r '(.skills // []) | length' "$target_dir/subctl.plugin.json")
  tabs_count=$(jq -r '(.tabs // []) | length' "$target_dir/subctl.plugin.json")
  verbs_count=$(jq -r '(.verbs // []) | length' "$target_dir/subctl.plugin.json")
  subctl_ok "installed $plugin_id [$kind] at $target_dir"
  echo "  tools=$tools_count skills=$skills_count tabs=$tabs_count verbs=$verbs_count"
  echo "  Restart master + dashboard to activate (or wait for next boot tick)."
}

subctl_plugins_remove() {
  local id="${1:-}"
  [[ -z "$id" ]] && subctl_die "usage: subctl plugins remove <id>"
  local plugin_dir="$SUBCTL_PLUGINS_DIR/$id"
  [[ -d "$plugin_dir" ]] || subctl_die "plugin not found: $id"
  rm -rf "$plugin_dir"
  subctl_ok "removed $id"
  echo "  Restart master + dashboard to deactivate."
}

subctl_plugins_show() {
  local id="${1:-}"
  [[ -z "$id" ]] && subctl_die "usage: subctl plugins show <id>"
  local plugin_dir="$SUBCTL_PLUGINS_DIR/$id"
  [[ -d "$plugin_dir" ]] || subctl_die "plugin not found: $id"
  echo "── $plugin_dir/subctl.plugin.json ──"
  jq . "$plugin_dir/subctl.plugin.json" 2>&1 || cat "$plugin_dir/subctl.plugin.json"
  echo
  echo "── files ──"
  (cd "$plugin_dir" && find . -maxdepth 3 -type f | head -30)
}

subctl_plugins_status() {
  if [[ ! -d "$SUBCTL_PLUGINS_DIR" ]]; then
    echo "(plugin dir not yet created — install one with: subctl plugins install <repo>)"
    return 0
  fi
  local total=0 ok=0 broken=0
  for plugin_dir in "$SUBCTL_PLUGINS_DIR"/*/; do
    [[ -d "$plugin_dir" ]] || continue
    total=$((total + 1))
    local id manifest
    id=$(basename "$plugin_dir")
    manifest="$plugin_dir/subctl.plugin.json"
    if [[ ! -f "$manifest" ]]; then
      printf "  ${C_RED}✗${C_RST} %-30s missing subctl.plugin.json\n" "$id"
      broken=$((broken + 1))
      continue
    fi
    if ! jq -e '.id and .configSchema' "$manifest" >/dev/null 2>&1; then
      printf "  ${C_RED}✗${C_RST} %-30s manifest missing required fields (id, configSchema)\n" "$id"
      broken=$((broken + 1))
      continue
    fi
    printf "  ${C_GRN}✓${C_RST} %-30s\n" "$id"
    ok=$((ok + 1))
  done
  echo
  echo "$ok ok / $broken broken / $total total"
}
