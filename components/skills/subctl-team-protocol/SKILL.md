---
name: subctl-team-protocol
description: >-
  The wire protocol every subctl-spawned worker speaks with its team lead.

  Use this skill when you are running inside a subctl-managed team — i.e.
  `SUBCTL_AGENT_ROLE=worker` is set, or you were spawned by `subctl orch spawn`
  / `subctl team spawn` / a parent Claude Code instance using
  `TeamCreate` + `Agent` with `team_name`. It describes how to receive work,
  report progress, request approvals, hand off, and shut down cleanly.

  Lead agents (orchestrators / team-leads) also load this skill so the two
  sides of every message agree on shape.
scope: dev-team
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

# Subctl Team Protocol

This skill defines the message contract between a **team lead** (orchestrator
Claude Code session) and its **workers** (sub-agents the lead spawned via
`TeamCreate` + `Agent` with `team_name`). Both sides load this skill so the
shapes never drift.

If you are the worker, **your plain text output is not visible to the team
lead** — to communicate, you MUST use the `SendMessage` tool. The lead's
messages to you are delivered automatically; you do not need to poll an inbox.

---

## 1. Roles

| Role | Set by | Identifier |
|------|--------|------------|
| **Team lead** | `subctl orch spawn` (no `--worker` flag), or the operator's own Claude Code session running orchestrator-mode | `SUBCTL_AGENT_ROLE=lead` (or unset) |
| **Worker** | `subctl orch spawn --worker`, or any agent created by `TeamCreate` + `Agent` with `team_name` | `SUBCTL_AGENT_ROLE=worker` |
| **Operator** | The human at the keyboard | — |

The lead never writes source code. Workers do. The operator is the
tiebreaker on judgment calls.

Refer to teammates by **name**, never by UUID. The names are set by the
parent at spawn time and surface in the iTerm2 pane title.

---

## 2. Sending messages — `SendMessage`

```jsonc
{
  "to": "<teammate-name>",            // e.g. "team-lead", "researcher", "impl-1"
  "summary": "5-10 word preview",     // required when message is a string
  "message": "<plain text or structured JSON>"
}
```

Rules:

- **Worker → lead** uses `to: "team-lead"` unless the lead has a different name.
- **Lead → worker** uses the worker's `name` from the original `Agent` call.
- **Worker → worker** ("peer DM") is allowed for tight coordination on
  non-overlapping scopes — e.g. one worker pinging another to release a file
  lock. Use sparingly; the lead should usually mediate.
- Plain-text status narration is fine. Structured JSON is reserved for the
  protocol messages below.
- Do not quote the original message when relaying — it's already rendered.

---

## 3. Protocol messages (structured JSON)

When the `message` field is a JSON object with a `type`, both sides interpret
it as a protocol message. Echo the `request_id` in your response so the sender
can correlate.

### 3.1 `shutdown_request` / `shutdown_response`

The lead asks a worker to terminate cleanly when its deliverable has landed.

```jsonc
// Lead → worker
{
  "to": "impl-1",
  "message": {
    "type": "shutdown_request",
    "request_id": "shutdown-2026-05-13-001",
    "reason": "Branch pushed, deliverable verified, freeing the pane."
  }
}

// Worker → lead
{
  "to": "team-lead",
  "message": {
    "type": "shutdown_response",
    "request_id": "shutdown-2026-05-13-001",
    "approve": true
  }
}
```

Approving terminates the worker process. The lead is responsible for sending
shutdown as soon as a deliverable is committed — leaving idle workers parked
wastes RAM and tmux panes (operator preference, captured in auto-memory).

Workers MUST NOT originate `shutdown_request` unless explicitly asked.

### 3.2 `plan_approval_request` / `plan_approval_response`

A worker asks the operator (via the lead) for go/no-go on a non-trivial plan
before executing. The lead forwards to the master daemon's plan-approval
queue; the operator decides from the dashboard Plans tab or Telegram
`/plans`. See `docs/master.md` §2.5 for the queue mechanics.

```jsonc
// Worker → lead
{
  "to": "team-lead",
  "message": {
    "type": "plan_approval_request",
    "request_id": "plan-2026-05-13-007",
    "plan_summary": "Refactor profile loader to new schema",
    "plan_body": "1. Move config files\n2. Migrate keys\n3. Add tests\n4. Ship behind flag"
  }
}

// Lead → worker (after operator decides)
{
  "to": "impl-1",
  "message": {
    "type": "plan_approval_response",
    "request_id": "plan-2026-05-13-007",
    "approve": false,
    "feedback": "Skip step 3 — tests already cover this path. Otherwise proceed."
  }
}
```

`approve: false` sends the worker back to revise; do not silently proceed.
Pending requests auto-reject after 60 minutes with `feedback: "auto-expired"`.

### 3.3 No status JSON over SendMessage

Workers MUST NOT send structured status JSON (`{"type": "progress", ...}`)
over `SendMessage` — use `TaskUpdate` on the assigned task instead. The lead
sees task state changes automatically.

---

## 4. Task lifecycle — `TaskCreate` / `TaskUpdate`

The lead creates tasks; workers update them.

```
TaskCreate({ subject, description })          // lead creates pending task
TaskUpdate({ id, status: "in_progress" })     // worker claims it on start
TaskUpdate({ id, status: "completed" })       // worker reports done
TaskUpdate({ id, status: "blocked",           // worker hits a blocker
             metadata: { blocker: "..." } })
```

Status transitions:

- `pending` → `in_progress` — worker starts. Set this BEFORE doing work, not
  after.
- `in_progress` → `completed` — work landed and verified. Only the worker
  sets this; the lead's verification pass may revert it.
- `in_progress` → `blocked` — surfaces an obstacle. Workers SHOULD attach a
  short blocker description; this is what the lead reads first.
- `blocked` → `in_progress` — worker resumes after the lead unblocks.

Do not create duplicate tasks. Call `TaskList` first if unsure.

---

## 5. Idle state

A worker is **idle** when:

- Its assigned task is `completed` AND the lead has acknowledged, OR
- It is waiting on a `plan_approval_response` from the operator, OR
- It explicitly reported "ready for next task" via `SendMessage`.

While idle, do not consume tokens looking for work. Do not run probes. Do not
"check in" repeatedly. Wait for the next message from the lead. If the lead
sends `shutdown_request`, approve it.

Leads: do not park workers idle "in case we need them later." Shut them down
after a deliverable lands and re-spawn on demand. (Operator preference,
auto-memory 2026-05-12.)

---

## 6. Concrete dispatch examples

### 6.1 Lead spawning a worker

```javascript
// In the lead's session:
TeamCreate({ name: "v2.7.33-skills" })
Agent({
  description: "Build skill bundles + agent defs baseline",
  prompt: "<full briefing — see worker-prompt-format below>",
  team_name: "v2.7.33-skills",
  name: "skills-impl"
})
```

Plain `Agent` calls (no `team_name`) run as hidden background sub-processes
and do NOT appear in iTerm2 panes — forbidden for code-writing work.

### 6.2 Worker reporting completion

```javascript
SendMessage({
  to: "team-lead",
  summary: "skills shipped — branch pushed",
  message: "Branch v2.7.33-skills pushed at SHA abc1234. Worktree at " +
           "../subctl-v2.7.33-skills. Shipped 6 skills + 5 agent defs + " +
           "README. CHANGELOG entry added, VERSION bumped. Ready for shutdown."
})
```

---

## 7. Worker prompt format (lead-side)

Every worker prompt the lead writes MUST include:

- **GOAL** — one sentence
- **CONTEXT** — file paths, prior decisions, constraints
- **DELIVERABLE** — exact output expected (files, diffs, branch name, SHA)
- **DONE WHEN** — verifiable acceptance criteria
- **REPORT BACK** — what to `SendMessage` to `team-lead` when finished
- **CONSTRAINTS** — files the worker may NOT touch (scopes of other parallel
  workers, to prevent merge conflicts)

If your prompt cannot fill in CONSTRAINTS, you are probably dispatching the
wrong slice — re-decompose.

---

## 8. Verification — leads only

When a worker reports "done," the lead verifies before marking the task
complete. The verification surface is whatever proves the work landed:

- `ls` / `cat` the files the worker claims to have created
- `git log --oneline -5` on the worker's branch to confirm commits
- `bun test` or `pnpm build` to confirm no regression
- `curl` to confirm endpoints respond

Do not trust the worker's narrative. The worker reports intent; the
filesystem reports reality.

---

## 9. Failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Worker doesn't appear in a pane | `Agent` called without `team_name` | Use `TeamCreate` + `Agent` with `team_name` |
| "Team does not exist" error | Old session cleaned up the team | `TeamCreate` it again |
| Worker stops responding | Hit auto-compact, idle, or shutdown | Check `TaskGet` and `TaskOutput`; if dead, re-spawn |
| Plan approval never returns | Operator AFK; auto-expires at 60min | Worker should accept the auto-reject and re-request when human is back |
| Worker writes outside its scope | Bad CONSTRAINTS in the prompt | Lead fixes the prompt; worker reverts |

---

## 10. Related skills

- `orchestrator-mode` — the lead-side activation rules
- `handoff-protocol` — mid-task handoffs between workers
- `spec-driven-dev` — how workers read and execute against a written spec

## References

- `docs/master.md` §2.5 — plan-approval queue mechanics (v2.7.29)
- `components/master/plan-approvals.ts` — server-side queue implementation
- `providers/claude/teams.sh` — sets `SUBCTL_AGENT_ROLE=worker` at spawn
