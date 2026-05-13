#!/usr/bin/env bash
# lib/settings.sh — merge subctl statusline + Stop hook into every Claude config dir.
# Idempotent. Backs up before each merge.
#
# Each Claude account uses its own CLAUDE_CONFIG_DIR, so settings.json keys must
# be present in *that* dir's settings.json — not just ~/.claude. We install into:
#   - $HOME/.claude (the default, used when CLAUDE_CONFIG_DIR is unset)
#   - every claude-provider account's cfg_dir from accounts.conf

[[ -n "${_SUBCTL_SETTINGS_LOADED:-}" ]] && return 0
_SUBCTL_SETTINGS_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# Constants kept for backwards-compat with any external callers that referenced
# the default-dir paths directly. Internal code now derives paths from cfg_dir.
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_SCRIPTS="$HOME/.claude/scripts"
CLAUDE_HOOKS="$HOME/.claude/hooks"
CLAUDE_COMMANDS="$HOME/.claude/commands"

# Enumerate every Claude config dir we need to wire up: the default ~/.claude
# plus every claude-provider account from accounts.conf. De-duped, one path per
# line, ~ already expanded.
subctl_settings_claude_dirs() {
  printf "%s\n" "$HOME/.claude"
  subctl_accounts_by_provider claude | awk -F'\t' '{print $4}'
}

# Install symlinks + merge settings.json for ONE Claude config dir.
# Args: $1 = cfg_dir (e.g. ~/.claude or ~/.claude-personal)
subctl_settings_install_claude_dir() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "install_claude_dir: missing cfg_dir"; return 1; }
  subctl_require jq "install: brew install jq" || return 1

  local scripts="$cfg_dir/scripts"
  local hooks="$cfg_dir/hooks"
  local commands="$cfg_dir/commands"
  local skills="$cfg_dir/skills"
  local settings="$cfg_dir/settings.json"

  mkdir -p "$scripts" "$hooks" "$commands" "$skills"

  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/statusline.sh"            "$scripts/statusline.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/dispatch-check.sh"        "$scripts/dispatch-check.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/lib/radar.sh"                              "$scripts/signals.sh"
  ln -sfn "$SUBCTL_REPO_ROOT/providers/claude/hooks/log-rate-limits.sh" "$hooks/log-rate-limits.sh"

  # Slash commands: symlink every .md from providers/claude/commands/ into
  # the cfg_dir's commands/ — operator's hand-rolled commands are kept
  # untouched (only files matching repo names get re-symlinked).
  if compgen -G "$SUBCTL_REPO_ROOT/providers/claude/commands/*.md" >/dev/null 2>&1; then
    for cmd_md in "$SUBCTL_REPO_ROOT/providers/claude/commands/"*.md; do
      ln -sfn "$cmd_md" "$commands/$(basename "$cmd_md")"
    done
  fi

  # Skills: symlink every repo-built skill into the cfg_dir's skills/.
  # Excludes "master" — that's the master daemon's own system prompt,
  # loaded at boot by components/master/server.ts; workers must not have
  # it (would confuse them about their role). Operator-personal skills
  # in <cfg_dir>/skills/ are untouched (only directories matching repo
  # skill names get symlinked).
  if [[ -d "$SUBCTL_REPO_ROOT/components/skills" ]]; then
    for skill_dir in "$SUBCTL_REPO_ROOT/components/skills"/*/; do
      [[ -d "$skill_dir" ]] || continue
      local skill_name
      skill_name=$(basename "$skill_dir")
      [[ "$skill_name" == "master" ]] && continue
      [[ -f "$skill_dir/SKILL.md" ]] || continue
      mkdir -p "$skills/$skill_name"
      ln -sfn "$skill_dir/SKILL.md" "$skills/$skill_name/SKILL.md"
    done
  fi

  if [[ -f "$settings" ]]; then
    local backup="$settings.bak.$(date +%Y%m%d-%H%M%S)"
    cp "$settings" "$backup"
  fi
  [[ -f "$settings" ]] || echo '{}' > "$settings"

  # Idempotent merge:
  # 1. Set statusLine to current script path.
  # 2. Rewrite any existing Stop hook command that points at log-rate-limits.sh
  #    in a *different* cfg_dir to point at THIS cfg_dir. Catches the
  #    laptop-→-M3Ultra alias migration case where settings.json gets copied
  #    with stale paths (claude-personal/claude-work/claude-overflow).
  # 3. If after the rewrite no Stop hook entry references the expected path,
  #    add one.
  jq --arg statusline "$scripts/statusline.sh" \
     --arg hook       "$hooks/log-rate-limits.sh" '
    .statusLine = {type: "command", command: $statusline}
    | .hooks = (.hooks // {})
    | .hooks.Stop = (.hooks.Stop // [] | map(
        .hooks = ((.hooks // []) | map(
          if (.command // "" | test("log-rate-limits\\.sh$")) and (.command != $hook) then
            .command = $hook
          else . end
        ))
      ))
    | if (.hooks.Stop | map((.hooks // []) | map(.command // "") | any(. == $hook)) | any) then .
      else .hooks.Stop += [{hooks: [{type: "command", command: $hook}]}] end
  ' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"

  subctl_ok "wired statusline + Stop hook into $cfg_dir"
}

# Public entrypoint. Installs into every Claude config dir (default + accounts).
subctl_settings_install_claude() {
  subctl_require jq "install: brew install jq" || return 1
  local cfg_dir
  while IFS= read -r cfg_dir; do
    [[ -z "$cfg_dir" ]] && continue
    subctl_settings_install_claude_dir "$cfg_dir"
  done < <(subctl_settings_claude_dirs | awk '!seen[$0]++')
}

# Ensure a per-account settings.json carries the keys that gate Claude Code's
# experimental team-pane runtime (TeamCreate/TeamList/SendMessage and the
# Agent(team_name=...) variant). Without these in the *account's* settings.json
# the flags from ~/.claude/settings.json don't apply, because each account uses
# its own CLAUDE_CONFIG_DIR.
#
# Idempotent: only adds keys that are missing; leaves user customizations alone.
# Safe to call on every launch.
#
# Args: $1 = cfg_dir (e.g. ~/.claude-overflow)
subctl_settings_ensure_teams() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "ensure_teams: missing cfg_dir"; return 1; }
  [[ -d "$cfg_dir" ]] || { subctl_warn "ensure_teams: $cfg_dir does not exist"; return 1; }
  subctl_require jq "install: brew install jq" || return 1

  local f="$cfg_dir/settings.json"
  [[ -f "$f" ]] || echo '{}' > "$f"

  # Already has both keys? Skip silently — this runs on every launch.
  if jq -e '
    (.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS == "1") and
    (.teammateMode == "tmux")
  ' "$f" >/dev/null 2>&1; then
    return 0
  fi

  jq '
    .env = (.env // {})
    | .env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    | .teammateMode = (.teammateMode // "tmux")
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  subctl_ok "seeded experimental teams keys into $f"
}

# Uninstall subctl entries from ONE Claude config dir.
# Restores most recent <settings>.bak.* if found; otherwise surgically deletes
# .statusLine and any Stop hook command containing "subctl" or "log-rate-limits".
# Removes symlinks under that dir only if they point at our repo.
subctl_settings_uninstall_claude_dir() {
  local cfg_dir="$1"
  [[ -z "$cfg_dir" ]] && { subctl_warn "uninstall_claude_dir: missing cfg_dir"; return 1; }

  local settings="$cfg_dir/settings.json"
  local scripts="$cfg_dir/scripts"
  local hooks="$cfg_dir/hooks"
  local commands="$cfg_dir/commands"

  if [[ -f "$settings" ]]; then
    local backup
    backup=$(ls -t "$settings".bak.* 2>/dev/null | head -1 || true)
    if [[ -n "$backup" ]]; then
      cp "$backup" "$settings"
      subctl_ok "restored $settings from $backup"
    else
      jq 'del(.statusLine) |
          if .hooks.Stop then
            .hooks.Stop = (.hooks.Stop | map(select(
              (.hooks // []) | map(.command // "") | any(test("subctl|log-rate-limits")) | not
            )))
          else . end' \
         "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
      subctl_info "removed subctl entries from $settings (no backup found)"
    fi
  fi

  local f target
  for f in \
    "$scripts/statusline.sh" \
    "$scripts/dispatch-check.sh" \
    "$scripts/signals.sh" \
    "$hooks/log-rate-limits.sh" \
    "$commands/dispatch-check.md"; do
    if [[ -L "$f" ]]; then
      target=$(readlink "$f")
      if [[ "$target" == "$SUBCTL_REPO_ROOT"/* ]]; then
        rm -f "$f"
        subctl_info "unlinked $f"
      fi
    fi
  done
}

# Public entrypoint. Uninstalls from every Claude config dir (default + accounts).
subctl_settings_uninstall_claude() {
  local cfg_dir
  while IFS= read -r cfg_dir; do
    [[ -z "$cfg_dir" ]] && continue
    subctl_settings_uninstall_claude_dir "$cfg_dir"
  done < <(subctl_settings_claude_dirs | awk '!seen[$0]++')
}

# ── autonomy helpers (Phase 1: defaultMode + CLAUDE_AUTONOMY) ────────────────

# Apply the autonomy patch (defaultMode bypassPermissions + CLAUDE_AUTONOMY=full)
# to a single settings.json. Backs up first. Idempotent — re-running is safe.
subctl_settings_apply_autonomy_patch() {
  local settings="$1"
  local patch="$SUBCTL_REPO_ROOT/components/claude-config/settings-autonomy.patch.json"
  [[ ! -f "$patch" ]] && { subctl_warn "autonomy patch missing: $patch"; return 1; }
  if [[ ! -f "$settings" ]]; then
    mkdir -p "$(dirname "$settings")"
    echo '{}' > "$settings"
  fi
  local backup="$settings.bak.autonomy.$(date +%Y%m%d-%H%M%S)"
  cp "$settings" "$backup"
  jq -s '
    (.[1] | del(._comment)) as $p
    | .[0]
    | .permissions = ((.permissions // {}) + ($p.permissions // {}))
    | .env         = ((.env         // {}) + ($p.env         // {}))
  ' "$settings" "$patch" > "$settings.tmp" && mv "$settings.tmp" "$settings"
  subctl_ok "autonomy patch applied → $(basename "$(dirname "$settings")")/settings.json (backup: $(basename "$backup"))"
}

# Apply autonomy patch to default + every claude-provider account in
# accounts.conf. Avoids the wildcard ~/.claude-* trap (.claude-mem,
# .claude-archive, .claude-code-router, etc. are unrelated tools that
# shouldn't be patched — they have their own settings.json shapes).
subctl_settings_apply_autonomy_all() {
  subctl_require jq "install: brew install jq" || return 1

  # Default config dir
  subctl_settings_apply_autonomy_patch "$HOME/.claude/settings.json"

  # Per-account dirs from accounts.conf — claude provider only
  while IFS=$'\t' read -r alias provider email cfg_dir desc; do
    [[ "$provider" != "claude" ]] && continue
    [[ -d "$cfg_dir" ]] || continue
    subctl_settings_apply_autonomy_patch "$cfg_dir/settings.json"
  done < <(subctl_list_accounts 2>/dev/null)
}

# Symlink every subctl-shipped skill from components/skills/<name>/SKILL.md
# into ~/.claude/skills/<name>/SKILL.md. Currently:
#   - autonomy   (drive-forward + memory + vault + ask-protocol doctrine)
#   - subctl     (full capability reference for any agent)
subctl_settings_install_autonomy_skill() {
  local skills_root="$SUBCTL_REPO_ROOT/components/skills"
  [[ ! -d "$skills_root" ]] && { subctl_warn "no components/skills/ in repo"; return 1; }
  local dst_root="$HOME/.claude/skills"
  mkdir -p "$dst_root"
  local linked=0
  for skill_dir in "$skills_root"/*; do
    [[ -d "$skill_dir" ]] || continue
    local name src dst
    name=$(basename "$skill_dir")
    src="$skill_dir/SKILL.md"
    [[ -f "$src" ]] || continue
    dst="$dst_root/$name"
    mkdir -p "$dst"
    ln -sfn "$src" "$dst/SKILL.md"
    subctl_ok "skill linked → $dst/SKILL.md"
    linked=$((linked + 1))
  done
  [[ $linked -eq 0 ]] && subctl_warn "no skills linked from $skills_root"
  return 0
}

# Install + register the subctl MCP server. Two steps:
#   1. bun install in components/mcp/ (downloads @modelcontextprotocol/sdk)
#   2. add an mcpServers.subctl entry to ~/.claude/settings.json
#
# Idempotent. Re-running upgrades the SDK and refreshes the settings entry.
subctl_settings_install_mcp() {
  local mcp_dir="$SUBCTL_REPO_ROOT/components/mcp"
  local server_ts="$mcp_dir/server.ts"
  [[ ! -f "$server_ts" ]] && { subctl_warn "MCP server.ts missing"; return 1; }

  # Step 1 — install deps via bun
  if ! command -v bun >/dev/null 2>&1; then
    subctl_warn "bun missing — MCP server cannot run. Install: curl -fsSL https://bun.sh/install | bash"
    return 1
  fi
  if [[ ! -d "$mcp_dir/node_modules" ]]; then
    subctl_info "installing MCP SDK dependencies..."
    (cd "$mcp_dir" && bun install >/dev/null 2>&1) \
      && subctl_ok "MCP deps installed" \
      || { subctl_err "bun install failed in $mcp_dir"; return 1; }
  fi

  # Step 2 — register in settings.json under mcpServers.subctl
  local settings="$HOME/.claude/settings.json"
  [[ -f "$settings" ]] || echo '{}' > "$settings"
  local bun_path
  bun_path=$(command -v bun)
  jq --arg cmd "$bun_path" --arg server "$server_ts" '
    .mcpServers = (.mcpServers // {}) |
    .mcpServers.subctl = {
      command: $cmd,
      args: ["run", $server]
    }
  ' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
  subctl_ok "MCP server registered → settings.json (mcpServers.subctl)"
}

# Install the subctl master daemon. Two steps:
#   1. Sanity-check components/master/server.ts is present (stage 1 scaffold)
#   2. bun install in components/master/ if node_modules is missing
#
# Does NOT register the launchd plist — that's `subctl master enable`'s job.
# Idempotent. Re-running upgrades deps only when node_modules is absent.
subctl_settings_install_master() {
  local master_dir="$SUBCTL_REPO_ROOT/components/master"
  local server_ts="$master_dir/server.ts"
  [[ ! -f "$server_ts" ]] && { subctl_warn "master server.ts missing at $server_ts"; return 1; }

  if ! command -v bun >/dev/null 2>&1; then
    subctl_warn "bun missing — master daemon cannot run. Install: curl -fsSL https://bun.sh/install | bash"
    return 1
  fi
  if [[ ! -d "$master_dir/node_modules" ]]; then
    subctl_info "installing master daemon dependencies..."
    (cd "$master_dir" && bun install >/dev/null 2>&1) \
      && subctl_ok "master deps installed" \
      || { subctl_err "bun install failed in $master_dir"; return 1; }
  fi

  subctl_ok "master daemon installed (components/master/). Run 'subctl master enable' to start."
}

# v2.7.21 (ADR 0011 L2): dashboard now has its own package.json (xterm.js +
# node-pty for the web-terminal escape hatch). Mirrors the master daemon
# install pattern above.
subctl_settings_install_dashboard_deps() {
  local dashboard_dir="$SUBCTL_REPO_ROOT/dashboard"
  local pkg_json="$dashboard_dir/package.json"
  [[ ! -f "$pkg_json" ]] && return 0  # nothing to install (pre-v2.7.21)

  if ! command -v bun >/dev/null 2>&1; then
    subctl_warn "bun missing — dashboard web-terminal vendor deps will not be installed."
    return 0
  fi

  # node-pty (a native module) installs prebuilt binaries that bun may
  # forget to chmod +x. Fix-up is below.
  if [[ ! -d "$dashboard_dir/node_modules" ]]; then
    subctl_info "installing dashboard vendor dependencies (xterm.js + node-pty)..."
    (cd "$dashboard_dir" && bun install >/dev/null 2>&1) \
      && subctl_ok "dashboard deps installed" \
      || { subctl_warn "bun install failed in $dashboard_dir — web terminal will be unavailable until fixed"; return 0; }
  fi

  # node-pty prebuilt spawn-helper binaries: bun's installer sometimes
  # drops the execute bit. Make them executable so the helper sidecar
  # can fork its child without a posix_spawnp failure.
  local prebuilds_root="$dashboard_dir/node_modules/node-pty/prebuilds"
  if [[ -d "$prebuilds_root" ]]; then
    find "$prebuilds_root" -name "spawn-helper" -type f -exec chmod +x {} \; 2>/dev/null || true
  fi
}
