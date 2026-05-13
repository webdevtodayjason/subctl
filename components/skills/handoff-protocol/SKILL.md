---
name: handoff-protocol
description: >-
  How to hand off a task mid-flight — context summary, what's done, what's
  pending, where to find work-in-progress, and when to escalate instead.

  Use this skill when a worker needs to pass an unfinished task to a peer or
  back to the team lead — auto-compact pressure, scope shift, blocker outside
  the worker's tool set, end-of-shift, or running into the spawn-time context
  budget. Also load it when receiving a handoff so you know what shape to
  expect.
---

# Handoff Protocol

A handoff transfers an in-flight task from one agent to another (peer worker,
team lead, or a freshly-spawned replacement) without losing the work-in-progress
context. Done well, the receiving agent picks up in one message. Done poorly,
they re-investigate everything and the work effectively restarts.

This skill is loaded by both senders and receivers so the message shape is
canonical.

---

## 1. When to hand off vs. escalate vs. shut down

| Situation | Action |
|-----------|--------|
| Approaching auto-compact threshold (>80% context) and the task is non-trivial | **Hand off** to a fresh worker — your context window is the bottleneck, not your knowledge |
| Hit a blocker outside your tool set (e.g. need a Rust expert, you only know TS) | **Hand off** to a peer with the right tool affinities |
| Task is complete | **Shut down** (`shutdown_response: approve`), don't hand off — there's nothing to transfer |
| Hit a real judgment call the operator must make | **Escalate** via `plan_approval_request`, don't hand off — the next worker would face the same question |
| Task scope was wrong / impossible / overlaps another worker | **Escalate** to lead, don't hand off — the plan needs revision |
| End of shift / pane being closed | **Hand off** to lead with full state so they can re-dispatch |

The cheapest handoff is the one you didn't need to do. Before handing off,
ask: can I finish this in the next 5 tool calls? If yes, finish it.

---

## 2. The handoff message — canonical format

Send via `SendMessage` to the next agent (peer name, or `team-lead` if the
lead will re-dispatch). The message body is plain text with these labeled
sections, in this order:

```
HANDOFF — <one-line summary of what's being handed off>

GOAL
  <original task GOAL, verbatim from your assignment if possible>

STATUS
  <one sentence: where am I in the work? "50% — implementation done, tests
   pending" / "scoping — no code written yet" / "blocked on X">

DONE
  - <concrete deliverable 1, with file path or SHA>
  - <concrete deliverable 2>

PENDING
  - <thing 1 remaining>
  - <thing 2 remaining>

WORK-IN-PROGRESS LOCATIONS
  - Branch: <branch name>
  - Worktree: <absolute path>
  - Uncommitted files: <paths, or "none — all committed">
  - Scratch notes: <path to any notes file, or "none">

KEY DECISIONS MADE
  - <decision 1 + rationale — short>
  - <decision 2>

OPEN QUESTIONS
  - <question 1 — what answer would unblock>
  - <question 2>

CONSTRAINTS (do not touch)
  - <file/scope being touched by another worker>
  - <file/scope explicitly out-of-scope per the original brief>

NEXT STEP
  <one sentence: the literal next action the receiver should take>
```

Required sections: `GOAL`, `STATUS`, `DONE`, `PENDING`, `WORK-IN-PROGRESS
LOCATIONS`, `NEXT STEP`. The others are optional but recommended.

If `DONE` is empty, you probably should not be handing off — you have not
de-risked the task enough for someone else to pick it up.

---

## 3. Worktree / branch hygiene before handing off

Before sending the handoff message, the outgoing worker MUST:

1. **Commit all in-progress work.** Even messy. The receiver needs to see your
   diff, not reconstruct it. Use a `wip(<scope>): handoff snapshot` commit
   message. Do NOT amend; create a new commit.
2. **Push the branch.** The receiver may be running in a different worktree.
3. **Record the SHA** in the handoff message under `WORK-IN-PROGRESS LOCATIONS`.
4. **Leave a `RESUME.md` at the repo root** if there are more than 3 PENDING
   items. Brief — same shape as the handoff message — so the next agent can
   re-read it if their context fills up mid-task.

If you cannot commit (e.g. hook failure you couldn't fix), `git stash` with a
message like `handoff-2026-05-13-001` and reference the stash in the handoff.
Do not lose work to a force-push or reset.

---

## 4. Receiver-side checklist

When you receive a handoff message:

1. **Acknowledge first.** Reply with `SendMessage` to confirm receipt — the
   sender's `shutdown_request` may be queued behind your ack.
2. **Read `RESUME.md` if it exists** before reading the worktree. It's the
   compressed form.
3. **Check out the branch** and inspect the latest commit. Do not start a
   fresh branch.
4. **Run the test suite once.** Confirms the baseline the handoff describes.
5. **Re-read the original task description** (lead's prompt to the original
   worker). Don't trust the handoff's `GOAL` summary alone — it may have
   drifted.
6. **Take the NEXT STEP.** If it doesn't make sense after step 5, ask the
   lead before doing anything else.

---

## 5. Lead-side responsibilities

When a lead receives a handoff (because the original worker is done with
their pane but the task isn't finished):

1. Verify the handoff message has all required sections. If not, ask the
   outgoing worker to re-send before they shut down.
2. Decide: re-dispatch to a fresh worker, or absorb into a running peer's
   scope, or queue.
3. The new worker's prompt MUST include the full handoff message verbatim
   under a `## Handoff context` heading, plus the original task description.
   Do not paraphrase — the receiver may catch nuances the lead missed.
4. Update `ORCHESTRATION.md` task ledger: original worker's task moves to
   `handed-off`; new task created for receiver with a `handoff_from: <name>`
   metadata field.

---

## 6. Escalation thresholds

A handoff becomes an escalation when one of these is true:

- The next worker would face the same blocker you faced. → Surface to lead.
- The PENDING list is longer than the DONE list AND you haven't been working
  long. → Lead needs to re-decompose; not a handoff problem.
- You discover the task overlaps another worker's scope. → Lead arbitrates.
- The OPEN QUESTIONS list includes anything that requires an operator
  decision. → `plan_approval_request` to lead, who forwards.

Handoffs are for "I can't finish this but someone else can." Escalations are
for "this can't be finished as scoped." Don't dress an escalation up as a
handoff — it wastes a pane.

---

## 7. Common pitfalls

- **Handoff without committing.** The receiver inherits a clean tree and no
  idea what you actually wrote. Always commit first.
- **`NEXT STEP` too vague.** "Continue the work" is not a next step. "Run
  `bun test components/master/__tests__/foo.test.ts` and fix the two failing
  cases at lines 47 and 89" is.
- **Skipping `CONSTRAINTS`.** The receiver doesn't know which sibling workers
  are running. Always list scopes they must not touch.
- **Handing off because you're tired of the task.** That's not a handoff
  reason. Either finish or escalate.

---

## 8. Related skills

- `subctl-team-protocol` — the message-passing primitives this skill builds on
- `spec-driven-dev` — the receiver's first job is to re-read the spec
- `orchestrator-mode` — lead-side dispatch + verification rules

## References

- Operator auto-memory `feedback_shutdown_idle_workers.md` — context for why
  shutdown is preferred over leaving panes parked
- `ORCHESTRATION.md` template in `components/skills/orchestrator-mode/SKILL.md`
