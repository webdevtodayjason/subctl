---
operator: Jason
phase: approved_execution
kind: implementation-spec
project: subctl
initiative: "Memory Init #7"
---

# Memory Init #7: Evy Cognition Loop

## Approval

Operator approved v0.1 with one rename: queue this as **Memory Init #7: Evy Cognition Loop**.

## Thesis

Do not claim human sentience. Build bounded continuous agency: an audited, policy-gated cognition loop that runs when triggered by watchdog/timer/manual event, gathers compact signals, reflects deterministically, updates working state, and chooses one of: noop, audit_only, notify, schedule, remember_candidate, ask_operator, recommend_team_spawn.

## Ordered implementation slice

Ship exactly this six-step slice, in order:

1. Schemas
   - Add persistent cognition state schema.
   - Add audit JSONL schema.
   - Add config flag, disabled by default.

2. Register disabled watchdog
   - Register `consciousness-loop` or final internal id behind config.
   - It must not start unless enabled.

3. Tick runner
   - Gather compact cheap signals from existing local/read surfaces.
   - Hash signal bundle to detect unchanged state.
   - Append one audit record per tick.

4. Planner
   - Rule-based deterministic planner only for v0.1.
   - No model-assisted reflection in this slice.
   - Return auditable decisions with sources and rationale.

5. Safe-action executor
   - Execute only low-risk allowed actions.
   - Never push, merge, deploy, migrate, spawn, or spend escalation-tier model budget.
   - Dashboard notify and followup scheduling must be throttled.

6. Status surface
   - Add CLI/dashboard/API read surface for last tick, focus, decisions, suppressions, and audit tail.

## Tests

Required:

- Disabled config starts no watchdog.
- Enabled config registers the watchdog.
- Tick writes exactly one audit entry.
- Unchanged signals produce noop/audit_only.
- Planner refuses irreversible actions.
- Notification suppression works.
- Status surface returns last tick and recent decisions.

## Non-scope

- No sentience claims.
- No unbounded free-thinking.
- No recursive team spawning.
- No automatic Tier 1 promotion.
- No LLM planner in v0.1.