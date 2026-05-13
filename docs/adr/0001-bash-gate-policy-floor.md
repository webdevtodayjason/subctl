# 0001: Default `preset = "generic"` in shipped policy defaults

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.8 (commit `d866149`)

## Context

The v2.7.0 bash-gate work introduced a policy snapshot generation step. Spawning a team would freeze the merged policy chain into `~/.local/state/subctl/teams/<team_id>/policy.snapshot.toml` for the team's lifetime.

The bash side (`providers/claude/policy.sh`) correctly detected the project's ecosystem (node / python / generic) and announced it in the spawn banner: `[subctl] spawning team X in gated mode (preset: generic)`. However, the TS bridge (`_write_snapshot.ts`) only received `--team`, `--project-root`, and `--mode`. The detected ecosystem was NEVER passed through.

`loadResolvedPolicy()` resolves the preset name via `projectDoc.preset ?? userDoc.preset ?? defaultsDoc.preset`. For fresh projects with no `.subctl/policy.toml`, all three were undefined. The preset layer was skipped entirely.

Net effect: every team spawned into a fresh project ran in gated mode with **zero allowlist**. Every `ls`, `cat`, `find`, `pwd`, `git status` required explicit permission. Operator described it as "Bureaucrat Agent" behavior. Workers stalled in permission loops, "ask permission to ask permission."

Symptom diagnosed during a live session (2026-05-12) after operator reported the regression on the `osint-cve-monitor` project. Confirmed by reading the team's `policy.snapshot.toml` which had only `defaults.toml` in `source_paths`.

## Decision

Add `preset = "generic"` to `config/policy/defaults.toml` as the floor.

Since `loadResolvedPolicy()` falls through to `defaultsDoc.preset` when nothing higher is set, declaring `generic` at the floor means every project without an explicit preset override gets the generic allowlist merged into its snapshot (28 commands + git/gh/curl patterns).

## Reasoning

- **Minimum-viable fix.** One line in one TOML file. No code changes. No new code paths.
- **Operator-visible regression that broke active project work.** Needed to ship fast.
- **Doesn't preempt the proper fix.** Threading the bash-detected ecosystem (node / python / generic) through the bridge is queued as a follow-up; the floor doesn't block it.
- **Conservative semantics.** Projects that explicitly set `preset = "node"` or `preset = "python"` or `preset = "none"` still win — the floor only kicks in when nothing else is declared.

## Consequences

### Positive

- Fresh projects no longer boot into permission-loop hell.
- The generic allowlist (28 commands + git/gh/curl) covers the basics every worker needs: filesystem inspection, text processing, git operations.
- The fix is invisible to projects that already declared a preset.

### Negative

- Node and Python projects without an explicit `preset = "..."` declaration still get the **generic** preset, not the **node** or **python** preset. The bash side detects the ecosystem correctly but the TS side ignores the detection. Workers in those projects can use `ls`, `git`, etc. but not `npm`, `pnpm`, `bun`, `pytest`, `uv`, etc. Operator must add `preset = "node"` to `.subctl/policy.toml` for Node projects to get the ecosystem-specific tools.

### Open questions

- Should the bash-detected ecosystem be threaded through to the TS bridge so it becomes the preset override when no explicit preset is declared? This is queued as a v2.7.x follow-up. Once shipped, Node projects get the node preset automatically; the `generic` floor only applies to genuinely-generic projects.

## Alternatives considered

### Alternative A: Thread the bash-detected ecosystem through

Pass `--preset=<detected_ecosystem>` from `policy.sh` to `_write_snapshot.ts`, accept it as a parameter to `writePolicySnapshot()`, and use it as the highest-priority preset source (above defaultsDoc).

Rejected for now because it's a multi-file change (policy.sh, _write_snapshot.ts, snapshot.ts, load.ts, plus tests). Floor-fix unblocks the operator in one line; the proper fix follows.

### Alternative B: Change gated-mode semantics to be "allow by default, deny only `deny_always`"

Would have worked, but it's a fundamental change to what gated means. Sealed-mode users would expect a strict allowlist; if gated is also permissive, the modes collapse into two flavors of permissive. Rejected because it'd weaken the policy system's security story.

### Alternative C: Auto-detect ecosystem in `loadResolvedPolicy()`

Have the loader scan the project for `package.json` / `requirements.txt` / etc. and pick a preset. Rejected because the bash side already does this detection — duplicating it in TS would risk drift.

## References

- Commit `d866149`: `fix(v2.7.8): policy floor + bun path fallback + msg race breath`
- File: `config/policy/defaults.toml`
- Related: [ADR 0002](0002-trust-channel-directive-wrapper.md) (same wave, different bug)
- Diagnosis transcript: session 2026-05-12 with operator working on `osint-cve-monitor`
