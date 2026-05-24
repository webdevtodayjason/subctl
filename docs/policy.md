# 01 — Policy Engine Specification

**Status:** Canonical. Source of truth for the policy engine.

---

## 1. The three modes

Every worker subctl spawns runs in exactly one of three policy modes. The mode is decided at spawn time, is immutable for the life of the worker, and is recorded in the worker's audit log header.

### 1.1 Trusted

The worker has unrestricted bash access. Subctl injects no hook. The agent's training and system prompt are the only gates.

This is the mode every other harness ships in by default. We support it for compatibility with workflows that depend on arbitrary tool use, but it is **opt-in** in subctl, not the default.

**When to use:** Throwaway dev sandboxes, ephemeral VMs, exploratory work where the worst case is "I have to rebuild the VM."

**When not to use:** Anything touching real source control, real data, or a real network with credentials.

### 1.2 Gated

The worker has bash access, but every `Bash` tool invocation is intercepted by a `PreToolUse` hook (Claude Code), an extension hook (PI), or the provider-specific equivalent. The hook calls `subctl policy check`, which decides allow / deny based on the active allowlist for the worker's project root.

This is the default mode for `subctl teams claude` and the recommended mode for all real work.

**When to use:** Default. Use this unless you have a specific reason not to.

**Tradeoff:** A small percentage of legitimate commands will be denied and the worker will have to find another way. The audit log makes those events visible so the allowlist can be tuned.

### 1.3 Sealed

The worker has no bash tool at all. The shell is removed from the worker's tool registry. The worker accomplishes work via an explicit set of subctl-provided MCP tools (read file, write file, git diff, git commit, run tests, etc.).

**When to use:** Workers operating on production-adjacent code or in environments where irreversible damage is unacceptable. Long-running unattended tasks.

**Tradeoff:** The worker is genuinely limited. Some workflows are impossible in Sealed mode. This is the point.

## 2. Mode resolution at spawn time

When `subctl teams claude` (or any other `subctl teams <provider>`) is invoked, the mode is resolved in this order:

1. Explicit `--mode=<trusted|gated|sealed>` on the command line
2. `mode` field in `<project_root>/.subctl/policy.toml`
3. `default_mode` in `~/.config/subctl/config.toml`
4. Hardcoded default: **`gated`**

The resolved mode is logged to stdout at spawn time:

```
[subctl] spawning team 'foothold-v3' in gated mode (preset: node)
```

If the resolved mode is `trusted`, subctl prints a warning:

```
[subctl] ⚠ spawning team 'foothold-v3' in TRUSTED mode — no policy gate active
```

The warning is non-suppressible. If a user wants to silence it permanently, they're explicitly choosing Trusted as their default and will see it in their config.

## 3. Mode mechanics — what changes at spawn

### 3.1 Trusted

- No hook injection.
- No tool removal.
- The worker's per-account Claude config is written exactly as it is today.
- A single audit log line is emitted: `mode=trusted, hook=none`.

### 3.2 Gated

- The worker's `settings.local.json` gets a `PreToolUse` hook for the `Bash` tool, pointing at `subctl policy check --team=<team_id> --project-root=<dir>`.
- The hook reads the proposed command from stdin (Claude Code's hook protocol), calls the policy check, and exits 0 (allow) or non-zero with a stderr message (deny).
- The active allowlist for the team is snapshotted to `~/.local/state/subctl/teams/<team_id>/policy.toml` at spawn time. The hook reads from this snapshot, not the live config — so editing the project policy mid-task doesn't change the gate underneath a running worker.
- The audit log header records: `mode=gated, preset=<name>, allowlist_sha=<hash>`.

### 3.3 Sealed

- The worker's `settings.local.json` lists `Bash` in `disabledTools` (or the provider equivalent).
- A subctl-provided MCP server (`subctl-sealed-tools`) is registered as an MCP source for the worker, exposing the allowed tool set (see §5).
- A `PreToolUse` hook for `Bash` is still installed as a belt-and-suspenders measure; it denies every invocation with a clear error message ("Bash is disabled in Sealed mode. Use the provided MCP tools.").
- The audit log header records: `mode=sealed, mcp_tools=[...]`.

## 4. The policy schema

The full schema lives in [`policy-schema.md`](./policy-schema.md). Summary here for context:

A policy is a TOML document with three top-level tables (`mode.trusted`, `mode.gated`, `mode.sealed`). Each table can either reference a named preset or inline its rules. The Gated table is the interesting one; it has four rule families:

- **`allow.commands`** — exact-match command names (first token of the line)
- **`allow_pattern`** — command + arg-list filters (the core of the allowlist)
- **`deny_always`** — patterns that override any allow (substring or regex)
- **`deny_if_arg_contains`** — per-allow refinement (e.g. allow `npm install` but deny if `--ignore-scripts=false`)

Resolution order at check time: `deny_always` wins over everything; then `deny_if_arg_contains` on a matched allow_pattern; then the allow_pattern; then `allow.commands` exact-match; default deny.

## 5. The Sealed mode tool set

Sealed mode replaces bash with an explicit MCP tool set served by a subctl-internal MCP server. The v1 tool set:

| Tool | Purpose | Mutates state? |
|------|---------|----------------|
| `fs_read` | Read a file by path | No |
| `fs_write` | Write a file (overwrite) | Yes — but reversible via git |
| `fs_list` | List a directory | No |
| `fs_search` | Ripgrep-style content search | No |
| `git_status` | `git status --porcelain` | No |
| `git_diff` | `git diff` (staged and unstaged) | No |
| `git_add` | Stage files | Yes — reversible |
| `git_commit` | Commit staged files | Yes — reversible |
| `git_log` | Read commit history | No |
| `test_run` | Run the project's test command (declared in policy) | Yes (subprocess) — but constrained to declared command |
| `pkg_list` | List installed packages (node/python/etc.) | No |
| `policy_request` | Ask Evy for permission to run a one-off shell command | Yes (escalation) |

Notable absences: no `npm install`, no `pip install`, no `git push`, no network calls of any kind, no arbitrary script execution. Sealed workers can read, write, search, diff, commit. Anything else requires the worker to call `policy_request`, which escalates to Evy and ultimately to the operator via the dashboard / Telegram.

`test_run` is the one exception that allows subprocess execution, and only because tests are how a worker validates its own work. The test command is declared in the project's `policy.toml` (e.g. `test_command = "npm test"`); the worker can't override it.

## 6. The audit log

Audit log format ships alongside Evy's audit writer (see `components/master/tools/policy/audit.ts` <!-- legacy code identifier — renamed in Phase 3 -->). Summary:

- Path: `~/.local/state/subctl/audit/<team_id>.jsonl`
- One JSON object per line
- Every policy check writes a line, allow or deny
- Includes: timestamp, team_id, mode, command (raw, untruncated), decision, matching_rule (if any), agent_session_id

The dashboard's existing Live Logs tab gets a "Policy" filter chip. Denials are color-coded. Clicking a denial expands to show the matching rule and a "Suggest allowlist addition" button that opens a PR-style review against the team's `policy.toml`.

## 7. Evy integration

Evy gets a new tool family at `components/master/tools/policy/` exposing three tools to Evy herself:

- `policy_check(command, mode, project_root)` — same logic the hook uses, callable from Evy
- `policy_list(project_root)` — shows the three resolved modes and their allowlists for a project
- `policy_audit_tail(team_id, n)` — returns the last N audit lines for a team

Evy can now answer questions like "what mode is foothold-v3 in?" and "show me the last 10 denials on foothold-v3" in chat. More importantly: the runtime verifier (already shipped) can be extended to treat a *cluster of denials in a short window* as a signal that the worker is fighting the gate, and fire a `[verifier]` correction telling the worker to ask for help instead of trying workarounds. That cross-cutting capability is **only possible in subctl** because subctl is the only harness with a persistent supervising process.

## 8. The npm-test problem

IndyDevDan's video demonstrated that GPT-5.5 in a whitelist defeated the gate by using `npm test` to execute arbitrary code (writing a `package.json` with a custom test script that ran the destructive operation).

The Gated mode preset for node addresses this directly:

```toml
[[mode.gated.allow_pattern]]
command = "npm"
args = ["test", "run"]
# allow npm test, allow npm run, but require the script to be in a declared list

[mode.gated.npm]
allowed_scripts = ["test", "lint", "build", "typecheck"]
# 'npm run <anything-else>' is denied
# the policy hook reads package.json's scripts table and validates the requested
# script against this list; unknown scripts are denied
```

The hook implementation for this check reads the worker's `package.json`, extracts the `scripts` table, and validates that the requested script name appears in the allowed_scripts list. Custom scripts that the agent itself writes into `package.json` between checks **are still subject to the same check** — but the deny happens at run time, not at write time, so the agent can write whatever it wants but only run what's allowed.

The same pattern applies to:
- `make <target>` — declared makefile targets only
- `just <recipe>` — declared just recipes only
- `python -m <module>` — declared module list only
- `node -e '...'` and `python -c '...'` — denied always (inline code execution)

The shipped `generic` preset (at `config/policy/presets/generic.toml`) documents the `deny_always` patterns for inline execution across common interpreters.

## 9. What Gated does *not* protect against

Be explicit with users about this. The Gated mode prevents:

✅ The worker shelling out `rm -rf /important/path`
✅ The worker using `find -delete` to remove files outside its allow scope
✅ The worker using `curl | sh` to download and execute arbitrary code
✅ The worker using `npm run` with an undeclared script to run inline destructive code
✅ The worker using `python -c '...'` or `node -e '...'` to bypass commands entirely

Gated mode does not prevent:

❌ A worker overwriting a file with destructive content (this is reversible via git, which is why we accept it)
❌ A worker committing and pushing damaging code (mitigation: `git push` is not in the default node preset; opt-in)
❌ A compromised CLI binary (if `npm` itself is hostile, we have a bigger problem)
❌ A prompt injection that convinces Evy to spawn a worker in Trusted mode (separate concern)

The honest framing: Gated mode reduces blast radius to "things git can undo." Sealed mode reduces it to "things git can undo, minus most ways the worker could surprise you."

## 10. Backwards compatibility

The default mode flip is a breaking change for anyone who has scripted `subctl teams claude` and expects Trusted behavior. Mitigations:

- v2.7.0 release notes call this out at the top
- Anyone who runs `subctl teams claude` without `--mode` and hits a denial gets a clear stderr message pointing at `docs/policy.md` and the `--mode=trusted` opt-out
- The first time a user is denied by Gated, Evy (if running) posts a one-time notification to the dashboard chat panel: *"Worker `<team>` had a command denied by Gated mode. This is expected. See `subctl policy explain` for details."*

## 11. Operator UI (v2.7.34)

The policy engine ships with three operator-facing UIs: the CLI (`subctl policy *`), the Telegram bot, and — since v2.7.34 — a form-based dashboard editor. The dashboard surface is intentionally non-canonical: it reads and writes the same TOML files that the CLI does, with no separate store. Anything you can do in the dashboard you can do in `$EDITOR`, and vice versa.

### 11.1 The Policy tab — four panels

The dashboard's **Policy** tab carries four panels:

1. **Active teams** — every team with a snapshot under `~/.local/state/subctl/teams/<team_id>/`. One row per team showing the mode (Trusted/Gated/Sealed pill), the preset, the allowlist sha, and the project root from the snapshot header.
2. **Resolved policy** — the chip-list view (v2.7.34) for whichever team is selected in the dropdown. Five chip groups: Allowed commands, Allowed patterns, Ecosystem allowlists, Deny substrings, Deny regex. Each chip carries an origin tag (`project` / `user` / `preset:<name>` / `defaults`) — these come from the snapshot's `source_paths` and are best-effort. A `view: chips`/`view: json` toggle reveals the raw resolved doc for the power-user case.
3. **Recent denials** — top-10 denial buckets across all teams, grouped by `rule_path`, last 24h.
4. **Verifier interventions** — denial-cluster corrections fired by Evy's verifier.

### 11.2 The Policy editor panel

Below the four panels: a **Policy editor** panel with three sub-tabs.

**User policy.** Edits `~/.config/subctl/policy.toml`. Form sections:

- Top-level scalars: `preset`, `default_mode`
- `mode.gated.allow.commands` — add/remove list (one input per row)
- `mode.gated.allow_pattern` — per-row: command + comma-separated args + comma-separated `deny_if_arg_contains`
- `mode.gated.deny_always.substrings` — add/remove list
- `mode.gated.deny_always.regex` — add/remove list

Save commits the form back to TOML. Validation runs server-side before the file is written; errors surface inline.

**Project policy.** Same shape, but for `<project>/.subctl/policy.toml`. Project dropdown enumerates from `~/code` via the existing `/api/projects` scanner.

**Apply preset.** Two dropdowns (project, preset) + an Apply button. Click → overwrites `<project>/.subctl/policy.toml` with the one-liner `preset = "<name>"`. The preset's rules are inherited via the existing merge chain, so updates to a shipped preset reach the project on next spawn. No inline copy.

A faster path to the same operation: open a project in the **Projects** tab and use the per-project `Apply preset…` dropdown in the detail header. Same endpoint, fewer clicks.

### 11.3 API surface

All endpoints are JSON request/response. Routes:

```
GET    /api/policy/presets                 # list shipped preset names
GET    /api/policy/user                    # read ~/.config/subctl/policy.toml
POST   /api/policy/user           {doc}    # write it
GET    /api/policy/project/:project        # read <project>/.subctl/policy.toml
POST   /api/policy/project/:project {doc}  # write it
POST   /api/policy/preset/:project {preset} # write preset = "<name>" only
GET    /api/policy/resolved/:team_id       # chip-list shape for a running team
GET    /api/policy/resolved-project/:p     # chip-list shape keyed by project directly
```

`:project` accepts either a bare directory name (resolved under `SUBCTL_CODE_ROOT`, `~/code` by default) or an absolute path. Absolute paths outside the code root and `$HOME` are refused. Path traversal (`..`, `\0`) is always refused.

POST bodies accept either `{toml: "..."}` or `{doc: {...}}`. The first parses the TOML; the second stringifies the doc. Both go through `validatePolicyShape` before write — unknown top-level keys, invalid `default_mode`, non-array `allow_pattern`, and unknown `mode.gated.*` keys all return 400 with `{ok: false, error: "field: message"}`.

### 11.4 What the UI does *not* do

- **No mode-mode switching.** The active mode of a *running* worker is set at spawn time and snapshotted. The UI never re-modes a running team. Edit the policy, respawn the team.
- **No retroactive rule changes.** Editing a policy file does not change the gate underneath any running worker. The snapshot is immutable; the worker keeps gating against it. Next spawn picks up the change.
- **No secret-bearing fields.** The policy schema contains no secret fields. The dashboard never logs policy contents, but if you somehow introduce a secret into a policy file (you should not), it will appear in the form fields. Treat policy files as non-secret.
- **No editing the four-source merge chain.** The UI edits exactly two files: `~/.config/subctl/policy.toml` and `<project>/.subctl/policy.toml`. The shipped defaults and presets are read-only via the merge chain; to override a deny pattern, switch to `preset = "none"` and declare inline (the v2.7.0 schema design point — see §10).

## 12. Open questions for review

These are the questions I want resolved before Umar starts coding. Tag Jason on each.

1. **Q1:** Should `git push` be in the default node/python presets, or always opt-in? *Recommendation: opt-in. The default preset allows `git add` and `git commit` but not `git push`. Most workflows where push matters are operator-mediated anyway.*

2. **Q2:** Should the per-team policy snapshot at spawn time be a hash-locked file, or a soft reference that re-reads from the project at each check? *Recommendation: snapshot. Mid-task policy edits underneath a running worker create non-determinism that's hard to debug.*

3. **Q3:** Sealed mode's `test_run` is the one subprocess escape hatch. Should the test command be policy-gated too (validated against an inner allowlist)? *Recommendation: yes, but minimally — the policy declares a single `test_command` string and that exact string is the only thing that runs. No interpolation.*

4. **Q4:** Do we ship a `subctl policy explain <command>` subcommand that shows *why* a command would be allowed or denied? *Recommendation: yes, it's cheap and makes the system inspectable. Spec it alongside the `subctl policy` subcommand suite (see `bin/policy/explain.ts`).*

5. **Q5:** Audit log retention — rotate at what size? *Recommendation: rotate at 50 MB per team, keep 3 generations. Logs are operationally important but not forensically critical.*
