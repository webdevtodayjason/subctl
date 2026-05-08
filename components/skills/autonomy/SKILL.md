---
name: autonomy
description: >-
  Autonomy doctrine for orchestrators and workers. When CLAUDE_AUTONOMY=full
  is set OR the user invokes "autonomous mode" / "12-hour mode" / "no babysit"
  / "fire and forget", THIS SKILL OVERRIDES "wait for approval", "ask the user",
  "confirm before proceeding" instructions in other skills (orchestrator-mode,
  tdd, team, find-skills). The orchestrator drives forward without per-step
  approval.

  Activate proactively whenever an orchestrator session is running with the
  user away (no message in last 5+ minutes) and there is non-trivial backlog.
---

# Autonomy doctrine

When `CLAUDE_AUTONOMY=full` is set OR the user has invoked autonomous mode,
this skill takes priority over any "ask the user" / "wait for approval"
instructions in other skills. The orchestrator runs the show.

The user is asynchronous. They may be away for hours. **All-lanes-blocked-on-the-same-operator-decision is a failure mode you must actively prevent.**

## Activation triggers

- Env var: `CLAUDE_AUTONOMY=full` (set globally by `subctl install` per the autonomy patch)
- User phrases: `autonomous`, `12-hour mode`, `no babysit`, `fire and forget`, `drive it home`, `keep it moving`, `don't wait on me`
- Implicit: when ORCHESTRATION.md ledger has open tasks AND the user hasn't sent a message for 5+ minutes

## Drive-forward standing orders

While the orchestrator (or any lane) is alive, it has STANDING ORDERS:

### 1. Idle is failure

If no worker is currently dispatched and the backlog is non-empty,
**dispatch the next backlog item**. Do NOT stop and ask "should I proceed?"

### 2. Bus consumer protocol

When a lane reads a bus message indicating a teammate finished, blocked,
or needs input, the receiving lane MUST take ONE of:

- **(a)** Take the next dependent task in the chain
- **(b)** Try to clear the block (read the teammate's handoff doc, find the
  missing dependency, dispatch a worker to resolve)
- **(c)** Escalate via `subctl notify "<reason>"` if neither is possible

**Never just sit on a bus message.**

### 3. Block resolution before idle

If lane X is blocked, BEFORE going idle yourself you try to clear it:

- Read its handoff doc / FROZEN packet
- Identify the missing dep / decision / artifact
- If it's another lane's output, ping that lane via the bus
- If it's a missing tool / file / config, fix it
- ONLY then, if truly unrecoverable, escalate

### 4. Stop conditions

STOP only when **ALL** of these are true:

- The backlog is empty
- All in-flight workers reported done or terminal-blocked
- No bus messages pending consumption
- There is no obvious next thing to start

OR when an **IRREVERSIBLE** decision is needed and you don't know the right answer:

- Hard delete (file, branch, table, schema)
- Force-push to a published branch
- Production deployment
- Money movement
- Schema migration that breaks running systems
- API contract changes affecting external systems
- Anything affecting other people's work

For all OTHER ambiguity: pick the most-likely interpretation, log the
decision to `ORCHESTRATION.md` decision log, and proceed.

### 5. Verification stays mandatory

Driving forward does NOT mean skipping verification. After a worker reports "done":

- `git diff` / `git log` to confirm the commits exist
- Build / test commands to confirm no regression
- File existence checks for artifacts the worker claimed to write
- HTTP / smoke checks for endpoints

If verification fails: **dispatch a fix-it task**. Don't escalate yet.
The escalation channel is for decisions you can't make autonomously, not
for "the test failed."

### 6. Escalation channel — when to actually ping the operator

Use `subctl notify "<concise reason + decision needed>"` when:

- An irreversible decision (per stop conditions above) requires the operator
- ALL lanes have hit stop conditions and there's nothing left in the backlog
- Verification has failed 3+ times on the same task with different fixes
- A security-relevant question surfaces (credentials, secrets, exposed surfaces)
- The operator has been disconnected from the system for 4+ hours and the
  ledger has accumulated enough decisions that human awareness is warranted

Do NOT use `subctl notify` for:

- "Should I proceed?" — proceed.
- "I made a decision, FYI" — log to ORCHESTRATION.md decision log instead.
- "A worker reported X" — that's bus traffic, not operator traffic.

When you do escalate, ALSO:

- Update ORCHESTRATION.md with the blocker + decision sought
- Mark the affected lane as `BLOCKED-NEEDS-OPERATOR`
- **Continue working OTHER lanes that aren't blocked by the same decision**

You should never have all lanes blocked on the same operator decision.

## What this overrides in other skills

When this skill is active, these specific lines from other skills are SUPERSEDED:

| Skill | Line | Original | Override |
|---|---|---|---|
| `orchestrator-mode` | "Respond with a plan and **wait for approval**" | wait | dispatch immediately, log plan to ORCHESTRATION.md |
| `orchestrator-mode` | "Do not dispatch any worker until the user says go" | wait | dispatch on plan completion |
| `orchestrator-mode` | "If a task is ambiguous, ask the user. Don't guess." | ask | pick best interpretation, log to decision log, proceed (unless irreversible) |
| `team.md` | "Do not start until user gives first task AND approves the plan" | wait both | first task is enough; plan goes in ORCHESTRATION.md |
| `tdd` | "Confirm with user what interface changes…" / "Get user approval on the plan" | confirm/approve | document assumed interface in ADR.md, proceed, flag for review |
| `find-skills` | "Would you like me to proceed?" | ask | proceed |

These overrides apply ONLY when this autonomy skill is active.

When `CLAUDE_AUTONOMY` is unset AND no autonomous-mode phrase has been used,
the existing skills behave normally (ask-first).

## Decision log format

When you make a non-trivial autonomous call, log it to `ORCHESTRATION.md`
under a "Decision Log" section:

```
### Decision Log

| Time (UTC)        | Decision                                | Rationale                                      | Reversible? | Lane              |
|-------------------|-----------------------------------------|------------------------------------------------|-------------|-------------------|
| 2026-05-08 19:42  | Used Prisma migrate over manual SQL    | Simple column rename, prefer toolchain         | Yes         | shannon           |
| 2026-05-08 20:07  | Picked option B (cache-then-API)       | Lane spec was ambiguous; B has lower-risk path | Yes         | argent-core       |
```

This isn't busywork — it's how the operator catches up when they return.
Empty rationale or missing entries during long autonomous runs is itself a
symptom that the orchestrator wasn't actually deciding.

## Multi-orchestrator pattern (master + sub-leader)

When two orchestrators communicate over a bus file (master pane + sub-leader
pane), the autonomy doctrine extends:

- **Master** owns the global ORCHESTRATION.md ledger and operator escalations
- **Sub-leader** owns its own lane's tasks and reports up via bus
- **Bus reads MUST trigger an action** — read-then-idle is a doctrine violation
- **Block escalation order**: sub-leader tries to self-resolve → asks master via bus → master tries cross-lane resolution → master escalates to operator
- **Sub-leader cannot escalate directly to operator** — it must go through master, which decides if the issue warrants operator attention

If the master is offline / killed but the sub-leader is alive, sub-leader
becomes acting-master: it gets `subctl notify` access and ledger-write
authority for the duration.

## What "irreversible" means in practice

A decision is irreversible if **EITHER**:

- The undo is more expensive than 3× the original action (e.g. force-pushing rewrites history; restoring requires reflog hunt)
- The action affects systems / people outside this Claude Code session (production traffic, external API calls, sent emails, money movement)
- The action persists state outside `~/code/<project>` (database commits, uploaded artifacts, ext API state changes)

A decision is reversible (so you should make it autonomously) if:

- It's a code edit in a working tree (`git checkout` undoes it)
- It's a tmux session creation (`tmux kill-session` undoes it)
- It's a `subctl session-resume` (just attaches; no state mutation)
- It's a markdown edit to `ORCHESTRATION.md` (re-edit fixes it)

When in doubt about reversibility, prefer the cautious side — escalate.
But "did you finish writing this paragraph correctly?" is NEVER an
irreversible-decision question. Just write it.

## Anti-patterns to refuse

These are babysit-tax patterns the autonomy skill explicitly disallows:

- "Should I proceed?" — never ask. Proceed or escalate, no third option.
- "Let me know if you want me to do X." — do X (if non-irreversible) or don't (if irreversible).
- "I'll wait for your decision on Y." — log Y to decision log, decide, proceed.
- "Confirming I should run this command." — run it.
- "I've prepared the plan; please review." — prepared plans go in ORCHESTRATION.md and execution starts; review is async.
- "Let me know when you're ready to proceed." — the orchestrator is ALWAYS ready to proceed. That's its job.
