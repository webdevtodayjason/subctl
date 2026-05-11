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
| `policy_request` | Ask the master for permission to run a one-off shell command | Yes (escalation) |

Notable absences: no `npm install`, no `pip install`, no `git push`, no network calls of any kind, no arbitrary script execution. Sealed workers can read, write, search, diff, commit. Anything else requires the worker to call `policy_request`, which escalates to the master and ultimately to the operator via the dashboard / Telegram.

`test_run` is the one exception that allows subprocess execution, and only because tests are how a worker validates its own work. The test command is declared in the project's `policy.toml` (e.g. `test_command = "npm test"`); the worker can't override it.

## 6. The audit log

Audit log format ships alongside the master audit writer (see `components/master/tools/policy/audit.ts`). Summary:

- Path: `~/.local/state/subctl/audit/<team_id>.jsonl`
- One JSON object per line
- Every policy check writes a line, allow or deny
- Includes: timestamp, team_id, mode, command (raw, untruncated), decision, matching_rule (if any), agent_session_id

The dashboard's existing Live Logs tab gets a "Policy" filter chip. Denials are color-coded. Clicking a denial expands to show the matching rule and a "Suggest allowlist addition" button that opens a PR-style review against the team's `policy.toml`.

## 7. Master integration

The master daemon gets a new tool family at `components/master/tools/policy/` exposing three tools to the master itself:

- `policy_check(command, mode, project_root)` — same logic the hook uses, callable from the master
- `policy_list(project_root)` — shows the three resolved modes and their allowlists for a project
- `policy_audit_tail(team_id, n)` — returns the last N audit lines for a team

The master can now answer questions like "what mode is foothold-v3 in?" and "show me the last 10 denials on foothold-v3" in chat. More importantly: the runtime verifier (already shipped) can be extended to treat a *cluster of denials in a short window* as a signal that the worker is fighting the gate, and fire a `[verifier]` correction telling the worker to ask for help instead of trying workarounds. That cross-cutting capability is **only possible in subctl** because subctl is the only harness with a persistent supervising process.

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
❌ A prompt injection that convinces the master to spawn a worker in Trusted mode (separate concern)

The honest framing: Gated mode reduces blast radius to "things git can undo." Sealed mode reduces it to "things git can undo, minus most ways the worker could surprise you."

## 10. Backwards compatibility

The default mode flip is a breaking change for anyone who has scripted `subctl teams claude` and expects Trusted behavior. Mitigations:

- v2.7.0 release notes call this out at the top
- Anyone who runs `subctl teams claude` without `--mode` and hits a denial gets a clear stderr message pointing at `docs/policy.md` and the `--mode=trusted` opt-out
- The first time a user is denied by Gated, the master daemon (if running) posts a one-time notification to the dashboard chat panel: *"Worker `<team>` had a command denied by Gated mode. This is expected. See `subctl policy explain` for details."*

## 11. Open questions for review

These are the questions I want resolved before Umar starts coding. Tag Jason on each.

1. **Q1:** Should `git push` be in the default node/python presets, or always opt-in? *Recommendation: opt-in. The default preset allows `git add` and `git commit` but not `git push`. Most workflows where push matters are operator-mediated anyway.*

2. **Q2:** Should the per-team policy snapshot at spawn time be a hash-locked file, or a soft reference that re-reads from the project at each check? *Recommendation: snapshot. Mid-task policy edits underneath a running worker create non-determinism that's hard to debug.*

3. **Q3:** Sealed mode's `test_run` is the one subprocess escape hatch. Should the test command be policy-gated too (validated against an inner allowlist)? *Recommendation: yes, but minimally — the policy declares a single `test_command` string and that exact string is the only thing that runs. No interpolation.*

4. **Q4:** Do we ship a `subctl policy explain <command>` subcommand that shows *why* a command would be allowed or denied? *Recommendation: yes, it's cheap and makes the system inspectable. Spec it alongside the `subctl policy` subcommand suite (see `bin/policy/explain.ts`).*

5. **Q5:** Audit log retention — rotate at what size? *Recommendation: rotate at 50 MB per team, keep 3 generations. Logs are operationally important but not forensically critical.*
