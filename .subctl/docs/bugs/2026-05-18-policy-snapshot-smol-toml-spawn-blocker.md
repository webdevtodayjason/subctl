# Bug: worker spawn blocked by policy snapshot bridge missing `smol-toml`

Date: 2026-05-18
Project: subctl
Severity: high — blocks dev-team spawn

## Trigger

While starting Step 1 for the operator-approved `subctl-proxy` project, Evy attempted to spawn `subctl-proxy-team` via `subctl_orch_spawn` against `/Users/you/code/subctl` using account `claude-jason`.

## Observed failure

```text
subctl /api/orchestration/spawn → HTTP 500:  ✗ policy snapshot bridge failed:
error: Cannot find package 'smol-toml' from '/Users/you/.local/lib/subctl-install/components/master/tools/policy/snapshot.ts'

Bun v1.2.17 (macOS arm64)
 ✗ policy: failed to write snapshot for team claude-subctl
```

## Impact

The team did not spawn. This blocks the intended two-team system test and any new worker dispatches that require policy snapshot generation.

## Expected behaviour

Spawning a worker should either:

1. write the policy snapshot successfully, or
2. return a structured, actionable error indicating installation/dependency drift and how to repair it.

A missing runtime dependency in the installed tree should not surface as an opaque spawn failure during normal orchestration.

## Likely cause

The installed subctl tree at `~/.local/lib/subctl-install/` references `smol-toml` from `components/master/tools/policy/snapshot.ts`, but that package is not available to Bun in the installed runtime context.

Possibilities:

- dependency missing from installed `package.json` / lockfile
- install/deploy step did not copy or install dependencies
- installed tree is drifted from repo HEAD
- snapshot bridge should avoid runtime package resolution from a partial installed tree

## Reproduction

Attempt to spawn any team whose policy snapshot path is exercised. The failing attempt was:

- account: `claude-jason`
- project: `/Users/you/code/subctl`
- intended team: `subctl-proxy-team`
- phase: `step-1-section-18-decisions`

## Regression cases

- worker spawn succeeds for a project with `.subctl` policy present
- worker spawn succeeds for a project without project-local policy
- installed tree includes all runtime dependencies used by policy snapshot generation
- dependency-missing errors are classified distinctly from account/template/project user errors

## Current workaround

None confirmed. Retrying with another account is unlikely to help because the failure occurs before Claude session startup.
