#!/usr/bin/env bash
# providers/claude/policy.sh — Claude provider policy-gate helpers (v2.7.0 / PR 10).
#
# Sourced by providers/claude/teams.sh. Implements the spawn-time logic that
# turns a `subctl teams claude` invocation into a policy-gated Claude Code
# worker:
#
#   1. Resolve the effective mode (trusted | gated | sealed) per pack 01 §2.
#   2. Detect the project ecosystem (node | python | generic) per pack 08 §3.
#   3. Write the immutable policy snapshot via PR 7's `writePolicySnapshot`,
#      called through the small _write_snapshot.ts bridge in this directory.
#   4. Build the per-team `settings.local.json` body that injects the PreToolUse
#      hook for gated/sealed and registers the sealed-tools MCP server, while
#      leaving the existing defang (`bypassPermissions` +
#      `--dangerously-skip-permissions` + `CLAUDE_AUTONOMY=full`) untouched.
#      Defang STAYS per HANDOFF_DIGEST §3.1 D9.
#   5. Emit the spawn-time stdout banner per pack 08 §5 (including the
#      non-suppressible Trusted-mode warning per pack 01 §2.4).
#
# The hook is ADDITIVE. We do NOT remove `permissions.defaultMode` or the
# `--dangerously-skip-permissions` flag or `CLAUDE_AUTONOMY=full`. The hook
# becomes the deterministic, allowlist-driven, audit-logged gate that Claude
# Code's per-tool prompts would have been — except silent on allow and instant
# on deny via the Go binary in `bin/subctl-policy-check/`.

[[ -n "${_SUBCTL_CLAUDE_POLICY_LOADED:-}" ]] && return 0
_SUBCTL_CLAUDE_POLICY_LOADED=1

. "$(dirname "${BASH_SOURCE[0]}")/../../lib/core.sh"

# ---------------------------------------------------------------------------
# Mode resolution (pack 01 §2)
# ---------------------------------------------------------------------------

# Resolve the spawn-time policy mode. Priority:
#   1. explicit --mode on CLI         (passed in as $1)
#   2. mode/default_mode in <project_root>/.subctl/policy.toml
#   3. default_mode in ~/.config/subctl/policy.toml
#   4. hardcoded "gated"
#
# Args:
#   $1 = cli_mode (may be empty)
#   $2 = project_root
#
# Output: one of "trusted" | "gated" | "sealed" on stdout.
# Exit:   non-zero on invalid CLI value.
_subctl_claude_resolve_mode() {
  local cli_mode="$1" project_root="$2"

  if [[ -n "$cli_mode" ]]; then
    case "$cli_mode" in
      trusted|gated|sealed) printf '%s\n' "$cli_mode"; return 0 ;;
      *) subctl_err "invalid --mode value: $cli_mode (expected trusted|gated|sealed)"; return 1 ;;
    esac
  fi

  # Project policy first.
  local project_policy="$project_root/.subctl/policy.toml"
  if [[ -f "$project_policy" ]]; then
    local m
    m=$(_subctl_claude_extract_default_mode "$project_policy") || m=""
    if [[ -n "$m" ]]; then
      printf '%s\n' "$m"
      return 0
    fi
  fi

  # User policy second.
  local user_policy="${SUBCTL_CONFIG_DIR:-$HOME/.config/subctl}/policy.toml"
  if [[ -f "$user_policy" ]]; then
    local m
    m=$(_subctl_claude_extract_default_mode "$user_policy") || m=""
    if [[ -n "$m" ]]; then
      printf '%s\n' "$m"
      return 0
    fi
  fi

  printf 'gated\n'
}

# Lightweight default_mode reader. We deliberately do not pull in a TOML parser
# at the bash layer; the canonical merge runs inside the TS snapshot writer.
# This only needs to surface the operator-visible default_mode scalar so the
# mode-resolution chain works without a bun invocation for the common case.
#
# Accepts both unquoted and quoted values:
#   default_mode = "trusted"
#   default_mode = trusted
_subctl_claude_extract_default_mode() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*default_mode[[:space:]]*=/ {
      # split on =, take right side, strip quotes + whitespace + comments
      sub(/^[^=]*=[[:space:]]*/, "")
      sub(/[[:space:]]*#.*$/, "")
      gsub(/^["'\'']|["'\'']$/, "")
      gsub(/[[:space:]]+$/, "")
      print
      exit
    }
  ' "$file"
}

# ---------------------------------------------------------------------------
# Ecosystem detection (pack 08 §3)
# ---------------------------------------------------------------------------

# Detect the project ecosystem by scanning for canonical lockfile/manifest
# markers. Returns one of:
#   node      — package.json / pnpm-lock.yaml / bun.lockb / yarn.lock
#   python    — pyproject.toml / setup.py / setup.cfg / requirements.txt /
#               requirements.in / Pipfile / uv.lock / poetry.lock
#   generic   — no markers found, OR multiple ecosystems detected (in which
#               case we also emit a [subctl] warning to stderr so the
#               operator knows to set `preset = "..."` explicitly).
#
# Args:
#   $1 = project_root
_subctl_claude_detect_ecosystem() {
  local project_root="$1"
  local node_markers=(package.json pnpm-lock.yaml bun.lockb yarn.lock)
  local python_markers=(pyproject.toml setup.py setup.cfg requirements.txt requirements.in Pipfile uv.lock poetry.lock)

  local has_node=0 has_python=0 f
  for f in "${node_markers[@]}"; do
    if [[ -e "$project_root/$f" ]]; then has_node=1; break; fi
  done
  for f in "${python_markers[@]}"; do
    if [[ -e "$project_root/$f" ]]; then has_python=1; break; fi
  done

  if [[ $has_node -eq 1 && $has_python -eq 0 ]]; then
    printf 'node\n'
  elif [[ $has_python -eq 1 && $has_node -eq 0 ]]; then
    printf 'python\n'
  elif [[ $has_node -eq 1 && $has_python -eq 1 ]]; then
    # subctl_warn defaults to stdout; redirect to stderr so this function's
    # stdout contract stays "exactly one ecosystem token". Critical because
    # callers capture the stdout into a variable.
    subctl_warn "multiple ecosystems detected (node, python); falling back to generic. Set 'preset = \"...\"' in $project_root/.subctl/policy.toml to pick one." >&2
    printf 'generic\n'
  else
    printf 'generic\n'
  fi
}

# ---------------------------------------------------------------------------
# Snapshot + audit-header writer (bridges to the PR 7 TS helpers)
# ---------------------------------------------------------------------------

# Resolve which `bun` to invoke. We use the same lookup the rest of the repo
# uses (PATH-resident bun). If bun is missing we fail closed — the snapshot is
# required infrastructure for the gate to be auditable.
_subctl_claude_bun_bin() {
  if [[ -n "${SUBCTL_BUN_BIN:-}" ]] && [[ -x "$SUBCTL_BUN_BIN" ]]; then
    printf '%s\n' "$SUBCTL_BUN_BIN"; return 0
  fi
  # v2.7.8 — PATH may be the minimal launchd PATH (no ~/.bun/bin), which
  # left fresh installs unable to spawn teams. Probe well-known install
  # locations after PATH as a fallback. Operator can still override with
  # SUBCTL_BUN_BIN. Order: PATH → ~/.bun/bin (official curl install) →
  # /opt/homebrew/bin (Apple Silicon Homebrew) → /usr/local/bin (Intel
  # Homebrew + manual installs).
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for candidate in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Invoke `_write_snapshot.ts` to (1) write the per-team
# `policy.snapshot.toml` and (2) emit the audit-log header line. The TS
# helper prints a single JSON object on stdout carrying the resolved
# metadata (team_id, mode, allowlist_sha, snapshot_path, source_paths,
# spawned_at). We capture and stash those values into caller-visible vars
# so the spawn banner can render the pack 08 §5 lines without re-reading
# the file.
#
# Args:
#   $1 = team_id
#   $2 = project_root
#   $3 = mode (trusted|gated|sealed)
#
# Sets (in the caller's scope):
#   SUBCTL_POLICY_SNAPSHOT_PATH
#   SUBCTL_POLICY_ALLOWLIST_SHA
#   SUBCTL_POLICY_SOURCE_PATHS_JSON  # JSON array text
#   SUBCTL_POLICY_SPAWNED_AT
#
# Exit non-zero if the TS bridge errors (snapshot is load-bearing — without
# it, the hook would read stale state).
_subctl_claude_write_snapshot() {
  local team_id="$1" project_root="$2" mode="$3"
  local bun_bin
  bun_bin=$(_subctl_claude_bun_bin) || subctl_die "bun not found — policy snapshot bridge requires bun. Install: curl -fsSL https://bun.sh/install | bash"

  local helper="$SUBCTL_REPO_ROOT/providers/claude/_write_snapshot.ts"
  [[ -f "$helper" ]] || subctl_die "snapshot bridge missing: $helper"

  local json
  if ! json=$("$bun_bin" run "$helper" \
        --team="$team_id" \
        --project-root="$project_root" \
        --mode="$mode" 2>&1); then
    subctl_err "policy snapshot bridge failed:"
    printf '%s\n' "$json" >&2
    return 1
  fi

  # Parse the JSON. We require jq (already a hard dep of teams.sh).
  SUBCTL_POLICY_SNAPSHOT_PATH=$(printf '%s' "$json" | jq -r '.snapshot_path')
  SUBCTL_POLICY_ALLOWLIST_SHA=$(printf '%s' "$json" | jq -r '.allowlist_sha')
  SUBCTL_POLICY_SOURCE_PATHS_JSON=$(printf '%s' "$json" | jq -c '.source_paths')
  SUBCTL_POLICY_SPAWNED_AT=$(printf '%s' "$json" | jq -r '.spawned_at')
}

# ---------------------------------------------------------------------------
# settings.local.json builder
# ---------------------------------------------------------------------------

# Resolve the absolute path to `subctl-policy-check`. Mirrors lib/policy.sh's
# resolver — the binary may live in $SUBCTL_HOME/bin (installed) or in
# $SUBCTL_REPO_ROOT/bin/subctl-policy-check (built-in-repo dev path).
#
# We bake the absolute path into the hook command so Claude Code's hook
# executor doesn't depend on the worker's PATH.
_subctl_claude_policy_check_bin() {
  if [[ -n "${SUBCTL_POLICY_CHECK_BIN:-}" ]] && [[ -x "$SUBCTL_POLICY_CHECK_BIN" ]]; then
    printf '%s\n' "$SUBCTL_POLICY_CHECK_BIN"
    return 0
  fi
  local installed="${SUBCTL_HOME:-$HOME/.subctl}/bin/subctl-policy-check"
  if [[ -x "$installed" ]]; then
    printf '%s\n' "$installed"
    return 0
  fi
  local built="$SUBCTL_REPO_ROOT/bin/subctl-policy-check/subctl-policy-check"
  if [[ -x "$built" ]]; then
    printf '%s\n' "$built"
    return 0
  fi
  return 1
}

# Resolve the path to the `subctl` dispatcher itself. Used for the Sealed-mode
# MCP server registration (subctl mcp sealed-tools).
_subctl_claude_subctl_bin() {
  if [[ -n "${SUBCTL_BIN:-}" ]] && [[ -x "$SUBCTL_BIN" ]]; then
    printf '%s\n' "$SUBCTL_BIN"; return 0
  fi
  local installed="${SUBCTL_HOME:-$HOME/.subctl}/bin/subctl"
  if [[ -x "$installed" ]]; then printf '%s\n' "$installed"; return 0; fi
  local built="$SUBCTL_REPO_ROOT/bin/subctl"
  if [[ -x "$built" ]]; then printf '%s\n' "$built"; return 0; fi
  return 1
}

# Build the JSON body for `<cfg_dir>/settings.local.json` for the given mode.
# Per pack 08 §2.3/§2.5:
#
#   Trusted: NO hook injected. Defang stays. Warning is printed at spawn (not
#            in the settings file).
#   Gated:   PreToolUse hook routing Bash → subctl-policy-check. Defang stays.
#   Sealed:  permissions.deny=["Bash"] + MCP server registration +
#            belt-and-suspenders PreToolUse hook (with --mode=sealed so the
#            check always denies even if Claude Code's permissions.deny ever
#            stops behaving). Defang stays.
#
# In all three modes, `permissions.defaultMode = "bypassPermissions"` is set so
# Read/Write/Edit/etc. don't prompt. This preserves the v2.6.x behavior we
# promised operators (see HANDOFF_DIGEST §3.1 D9).
#
# Args:
#   $1 = mode
#   $2 = team_id
#   $3 = project_root
#
# Output: JSON to stdout (pretty-printed via jq).
_subctl_claude_build_settings_json() {
  local mode="$1" team_id="$2" project_root="$3"

  local policy_check_bin
  if ! policy_check_bin=$(_subctl_claude_policy_check_bin); then
    subctl_die "subctl-policy-check binary not found — install or build it before spawning a gated team (looked in: \$SUBCTL_POLICY_CHECK_BIN, \$SUBCTL_HOME/bin, $SUBCTL_REPO_ROOT/bin/subctl-policy-check/)"
  fi

  case "$mode" in
    trusted)
      jq -n '
        {
          permissions: { defaultMode: "bypassPermissions" }
        }'
      ;;
    gated)
      local hook_cmd
      hook_cmd=$(printf '%s --team=%s --project-root=%s' \
        "$policy_check_bin" "$team_id" "$project_root")
      jq -n \
        --arg cmd "$hook_cmd" \
        '{
          permissions: { defaultMode: "bypassPermissions" },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: $cmd }
                ]
              }
            ]
          }
        }'
      ;;
    sealed)
      local hook_cmd subctl_bin
      hook_cmd=$(printf '%s --team=%s --project-root=%s --mode=sealed' \
        "$policy_check_bin" "$team_id" "$project_root")
      if ! subctl_bin=$(_subctl_claude_subctl_bin); then
        # In Sealed mode the MCP server registration is the operator's path
        # to non-bash tooling. Without the dispatcher we can't register it.
        # Defer to a placeholder string so the JSON is well-formed; the
        # spawn-time banner will surface the missing-bin warning.
        subctl_bin="${SUBCTL_HOME:-$HOME/.subctl}/bin/subctl"
        subctl_warn "subctl dispatcher not found at $subctl_bin — Sealed-mode MCP server will fail until installed"
      fi
      jq -n \
        --arg cmd "$hook_cmd" \
        --arg subctl_bin "$subctl_bin" \
        --arg team_id "$team_id" \
        '{
          permissions: {
            defaultMode: "bypassPermissions",
            deny: ["Bash"]
          },
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  { type: "command", command: $cmd }
                ]
              }
            ]
          },
          mcpServers: {
            "subctl-sealed-tools": {
              command: $subctl_bin,
              args: ["mcp", "sealed-tools", "--team=" + $team_id]
            }
          }
        }'
      ;;
    *)
      subctl_die "_subctl_claude_build_settings_json: unknown mode '$mode'"
      ;;
  esac
}

# Write `<cfg_dir>/settings.local.json` carrying the policy hook configuration
# for the given mode. Idempotent: re-spawning a team with the same account
# overwrites the file. (Multi-team-same-account workflows accept "last spawn
# wins" for the hook command; the per-spawn snapshot is independent.)
#
# If the file exists and carries non-subctl keys we merge — we never want to
# silently drop an operator-authored mcpServers entry or permission key. The
# merge rules:
#
#   - `permissions`: shallow-merge; subctl overrides `defaultMode` and `deny`,
#     preserves any operator-added keys.
#
#   - `hooks.PreToolUse`: subctl OWNS the `Bash` matcher slot inside this
#     file (settings.local.json is provider-policy-managed). On merge:
#     - drop ALL entries whose matcher == "Bash" (subctl-staged or otherwise)
#     - preserve every entry whose matcher != "Bash" (operator-authored
#       hooks for Read / Write / Edit / etc. survive intact)
#     - prepend the freshly-built subctl Bash entry (if any — Trusted mode
#       has no hook so this list stays empty)
#     Operators who want their own Bash PreToolUse hook should add it to the
#     account's settings.json (not settings.local.json) where it merges with
#     subctl's runtime policy without contention.
#
#   - `mcpServers`: shallow-merge; subctl overrides `subctl-sealed-tools` for
#     Sealed mode, preserves other servers.
#
# Args:
#   $1 = cfg_dir
#   $2 = mode
#   $3 = team_id
#   $4 = project_root
_subctl_claude_write_settings_local() {
  local cfg_dir="$1" mode="$2" team_id="$3" project_root="$4"
  local target="$cfg_dir/settings.local.json"

  subctl_require jq "install: brew install jq" || return 1

  local new_settings
  new_settings=$(_subctl_claude_build_settings_json "$mode" "$team_id" "$project_root") \
    || return 1

  if [[ ! -f "$target" ]]; then
    printf '%s\n' "$new_settings" > "$target"
    chmod 0644 "$target" 2>/dev/null || true
    return 0
  fi

  # Existing file present — merge surgically. We pre-filter operator hooks
  # ($e_pre) so the assembled object can reference both halves.
  local merged
  merged=$(jq -s '
    .[0] as $existing | .[1] as $sub |
    ($existing // {}) as $e | ($sub // {}) as $s |
    # Operator-authored hooks worth preserving: every PreToolUse entry whose
    # matcher is NOT "Bash". The Bash slot inside settings.local.json is
    # subctl-owned (see policy.sh comment above the function).
    ((($e.hooks // {}).PreToolUse // []) | map(select(.matcher != "Bash"))) as $e_non_bash |
    ($e + {
      permissions: (($e.permissions // {}) + ($s.permissions // {})),
      hooks: (($e.hooks // {}) + {
        PreToolUse: ($e_non_bash + (($s.hooks // {}).PreToolUse // []))
      }),
      mcpServers: (($e.mcpServers // {}) + ($s.mcpServers // {}))
    })
  ' "$target" <(printf '%s' "$new_settings"))

  printf '%s\n' "$merged" > "$target"
  chmod 0644 "$target" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Spawn-time stdout banner (pack 08 §5)
# ---------------------------------------------------------------------------

# Emit the spawn banner. Reads the policy metadata stashed by
# _subctl_claude_write_snapshot. The Trusted-mode warning is
# non-suppressible PER SPAWN (pack 01 §2.4) — the --no-warn-trusted flag
# silences the SECONDARY hint lines but the headline "TRUSTED mode" line
# always prints.
#
# Args:
#   $1 = team_id
#   $2 = mode
#   $3 = preset
#   $4 = no_warn_trusted (true|false)
_subctl_claude_emit_spawn_banner() {
  local team_id="$1" mode="$2" preset="$3" no_warn_trusted="$4"

  case "$mode" in
    trusted)
      # Always print the headline.
      printf '[subctl] \033[33m⚠\033[0m spawning team %s in TRUSTED mode — no policy gate active\n' \
        "'$team_id'"
      if [[ "$no_warn_trusted" != "true" ]]; then
        printf '[subctl]   to use the default Gated mode, omit --mode=trusted\n'
        printf '[subctl]   to silence this warning permanently, set default_mode = "trusted" in ~/.config/subctl/config.toml\n'
      fi
      printf '[subctl]   snapshot: %s\n' "$SUBCTL_POLICY_SNAPSHOT_PATH"
      ;;
    gated)
      printf '[subctl] spawning team %s in gated mode (preset: %s)\n' "'$team_id'" "$preset"
      _subctl_claude_emit_policy_paths_line "$preset"
      printf '[subctl]   allowlist_sha: %s\n' "$SUBCTL_POLICY_ALLOWLIST_SHA"
      printf '[subctl]   snapshot: %s\n' "$SUBCTL_POLICY_SNAPSHOT_PATH"
      ;;
    sealed)
      printf '[subctl] spawning team %s in SEALED mode (preset: %s)\n' "'$team_id'" "$preset"
      _subctl_claude_emit_policy_paths_line "$preset"
      printf '[subctl]   allowlist_sha: %s\n' "$SUBCTL_POLICY_ALLOWLIST_SHA"
      printf '[subctl]   snapshot: %s\n' "$SUBCTL_POLICY_SNAPSHOT_PATH"
      printf '[subctl]   sealed-tools MCP server: subctl mcp sealed-tools (PLACEHOLDER in v2.7.0 — returns "tool not yet implemented")\n'
      ;;
  esac
}

# Helper for the second line of the banner — renders the resolved policy
# source path list compactly. The TS bridge stashes them as a JSON array so we
# parse and pretty-print here.
_subctl_claude_emit_policy_paths_line() {
  local preset="$1"
  if [[ -z "$SUBCTL_POLICY_SOURCE_PATHS_JSON" || "$SUBCTL_POLICY_SOURCE_PATHS_JSON" == "null" ]]; then
    printf '[subctl]   policy: (defaults) + %s preset\n' "$preset"
    return
  fi
  # Build a compact "<path1>, <path2> + <preset> preset" line.
  local joined
  joined=$(printf '%s' "$SUBCTL_POLICY_SOURCE_PATHS_JSON" | jq -r 'join(", ")')
  printf '[subctl]   policy: %s + %s preset\n' "$joined" "$preset"
}
