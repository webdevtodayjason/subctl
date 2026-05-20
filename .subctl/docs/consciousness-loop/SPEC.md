---
operator: Jason
phase: draft_review
kind: spec
project: subctl-consciousness-loop
---

# SPEC: subCTL Consciousness Loop

## Thesis

Evy should not claim human sentience. That would be imprecise and theatrically wrong. But subCTL can become meaningfully always-awake by adding a bounded cognition loop: a persistent, audited, policy-gated process that periodically gathers signals, reflects on what matters, updates working memory, and chooses one of four outcomes: act silently, notify, ask, or stop.

The useful threshold is not metaphysical consciousness. It is continuous agency with memory, attention, restraint, and self-audit.

## Implementation target

Brownfield subCTL project at `/Users/sem/code/subctl`.

Build a disabled-by-default `consciousness-loop` watchdog with:

- compact signal gathering
- persistent working state
- rule-based reflection
- policy-gated decisions
- durable audit log
- dashboard/CLI status
- tests

## Guardrails

- No claims of human sentience.
- No unbounded free-thinking loop.
- No irreversible actions without explicit operator approval.
- No recursive team spawning in v0.1.
- No notification spam.
- No direct Tier 1 promotion unless explicitly allowed.

## First implementation slice

1. Add state and audit schemas.
2. Register disabled-by-default watchdog.
3. Implement tick runner and signal bundle.
4. Implement deterministic planner returning `noop`, `audit_only`, `notify_dashboard`, `schedule_followup`, `remember_candidate`, `ask_operator`, or `recommend_team_spawn`.
5. Execute only safe low-risk actions in v0.1.
6. Add status endpoint, CLI/dashboard display, and tests.

## Acceptance tests

- Disabled config starts no watchdog.
- Enabled config registers `consciousness-loop`.
- Tick writes one audit entry.
- Unchanged signals produce `noop` or `audit_only`.
- Stale team signal notifies no more than once per suppression window.
- Pending memory duplicate cluster produces recommendation only.
- Planner refuses irreversible actions.
- Status surface returns last tick, focus, and recent decisions.