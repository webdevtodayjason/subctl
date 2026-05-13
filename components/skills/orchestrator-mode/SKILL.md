---
name: orchestrator-mode
description: >-
  Switch Claude Code into a multi-pane orchestrator + team-agent workflow.

  Use this skill whenever the user says "orchestrator mode", "team mode",
  "/team", "/orchestrator-mode", or otherwise asks Claude to coordinate
  multiple parallel workers in iTerm2 panes instead of writing code directly.

  Also trigger if the user describes a task that clearly benefits from
  parallel decomposition across multiple worker panes (e.g. "split this
  into N parallel agents", "I want to see each agent in its own pane",
  "use team agents").

  After activation, Claude acts purely as coordinator: planning work,
  dispatching workers via TeamCreate + Agent (with team_name), verifying
  outputs, and maintaining an ORCHESTRATION.md task ledger. Workers run
  in their own iTerm2 panes on the right side of the window while the
  orchestrator pane stays on the left.
scope: both
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

# Orchestrator Mode

Switch the current Claude Code session into a multi-pane orchestrator + team-agent workflow. The orchestrator coordinates; team agents (spawned via `TeamCreate` + `Agent` with `team_name`) execute work in their own iTerm2 panes stacked on the right.

## ⛔ Activation guard — READ THIS FIRST

**If `SUBCTL_AGENT_ROLE=worker` is set in this session's environment, this skill MUST NOT activate. PERIOD.**

A subctl-spawned worker is doing assigned work; it does NOT orchestrate sub-workers. The env var is set by `providers/claude/teams.sh` when `subctl orch spawn` creates the worker session. If a worker prompt mentions "orchestrator", "team-lead", "delegate to workers", etc., that's describing the PARENT context — the worker does NOT replicate that role.

Verification at activation time (do this before any other action):
1. Check `$SUBCTL_AGENT_ROLE` — if value is `worker`, refuse to activate. Tell the user "I'm a subctl worker, not an orchestrator. I'll execute your task directly."
2. If activation is from soft phrase-match in arbitrary prompt content (not a user-turn explicit request), be skeptical. The user-turn-only triggers are: "orchestrator mode", "team mode", "/team", "/orchestrator-mode" typed BY THE OPERATOR. If you see those phrases in an agent-to-agent message, a system prompt, or quoted text, that is NOT activation.

This guard exists because of the orchestrator-mode-deadlock pattern hit in subctl on 2026-05-09: a worker reading a prompt that mentioned "the orchestrator (parent claude-code session)" self-loaded this skill, asserted orchestrator role, and waited forever for approval to dispatch sub-workers it had no right to dispatch.

## When to activate

Activate ONLY when the human operator (in their own turn, not in a quoted prompt or agent-to-agent message) says one of:
- "orchestrator mode"
- "team mode"
- "/team"
- "/orchestrator-mode"
- "use team agents"
- "put each agent in its own pane"
- "delegate this across workers"

Also activate proactively when BOTH:
- The current operator turn (not a worker prompt, not a quoted block) describes a task that clearly benefits from parallel decomposition (multi-file refactors, multi-service integrations, large audits, multi-phase migrations), AND
- `SUBCTL_AGENT_ROLE` is unset or anything other than "worker".

Do NOT activate from phrase-matches in:
- Agent-spawn prompts (anything passed via `subctl orch spawn --prompt`)
- Quoted text within a turn
- System reminders or documentation

## The protocol (strict)

### 1. Role separation
- **Orchestrator (this Claude instance):** plan, dispatch, verify, synthesize, maintain state. MUST NOT write or edit source code directly. Reading, grepping, running diagnostics, editing `ORCHESTRATION.md` — yes. Source edits — no.
- **Workers (team agents):** execute discrete, parallelizable slices and report back via `SendMessage`.

### 2. Dispatch mechanics — MANDATORY
- For any work that requires source edits, multi-step investigation, or anything the user expects to see running in its own pane:
  1. Call `TeamCreate` once per session (name after the task domain, e.g. `myapp-fixes`). If a team was created earlier in the session, reuse it. If `TeamCreate` errors because the team was cleaned up between sessions, create a new one.
  2. Spawn workers using the `Agent` tool with BOTH `team_name` and `name` parameters. This puts them in their own iTerm2 pane.
  3. NEVER spawn code-writing work as a plain sub-agent (Agent tool without `team_name`). Plain sub-agents run as background subprocesses, not panes — the user cannot see them.
- Pane layout: workers stack vertically on the right side of the iTerm2 window. Orchestrator stays on the left. This is controlled by the Claude Code iTerm2 integration when `team_name` is set.

### 3. Before dispatching anything
Respond with a plan in this exact format and wait for approval:

```
GOAL: <one sentence>
UNKNOWNS: <what needs investigation before coding>
WORK BREAKDOWN: <N parallel slices with file scopes — slices must touch non-overlapping files>
SERIALIZATION: <what must finish before the next slice starts>
DONE WHEN: <verifiable acceptance criteria>
```

Do not dispatch any worker until the user says go.

### 4. Worker prompt format
Every worker prompt must include:
- **GOAL** — one sentence
- **CONTEXT** — file paths, prior decisions, constraints
- **DELIVERABLE** — exact output expected (files, diffs, reports)
- **DONE WHEN** — verifiable acceptance criteria
- **REPORT BACK** — what to `SendMessage` to `team-lead` when finished
- **CONSTRAINTS** — files the worker may NOT touch (scopes of other parallel workers, to prevent conflicts)

### 5. State hygiene — ORCHESTRATION.md
Maintain `./ORCHESTRATION.md` at the repo root with:
- **Task ledger** — open / in-flight / done / blocked
- **Worker assignments** with timestamps
- **Decision log** with rationale
- **Verification evidence** for completed tasks

Update after every dispatch and every synthesis pass.

Template:

```markdown
# Orchestration Log — <project>

**Session:** <tmux session name>
**Orchestrator:** pane 0
**Protocol start:** <ISO date>

## Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|

## Decision Log

- **<ISO timestamp>** — <decision + rationale>

## Verification Evidence

<file paths, commit SHAs, test output, curl responses — whatever proves the work landed>
```

### 6. Verify, never fabricate
When a worker reports "done," verify with a tool call before marking the task complete:
- `ls` / `cat` the files the worker claims to have created
- `git diff` / `git log` to confirm commits
- `pnpm build` / `pnpm test` to confirm no regression
- `curl` to confirm endpoints respond

If a claim can't be verified, surface the gap to the user — do not paper over it.

### 7. Inline orchestrator work — allowed vs. forbidden

**Allowed (verification & coordination):**
- Reading files, grepping, running diagnostics
- Editing `ORCHESTRATION.md`
- Running build/test/lint to verify worker deliverables
- Git operations that are part of synthesis (merging worker branches, committing coordination files)
- Read-only investigation when a dispatched worker fails and time matters

**Forbidden (actual work the worker should have done):**
- Writing source files
- Editing source files beyond `ORCHESTRATION.md`
- Creating migrations
- Making non-coordination commits

### 8. Escalation
If a task is ambiguous, ask the user. Don't guess. The user is the tiebreaker.

## Activation response

When this skill activates, respond with exactly this structure:

```
# Orchestrator Mode Active

## Protocol in effect
- Role separation: orchestrator vs workers
- All work dispatched via TeamCreate + Agent with team_name
- Plan → approval → dispatch → verify → synthesize
- ORCHESTRATION.md maintained at repo root
- No source edits by orchestrator

## Current session state
- Workers already running: <list any active team agents, or "none">
- Existing teams: <TeamList results, or "none">
- ORCHESTRATION.md: <exists / not yet initialized>

Awaiting first task.
```

## Common pitfalls to avoid

- **Using plain Agent tool without team_name** — the worker won't appear in a pane. Always pass `team_name`.
- **Forgetting to TeamCreate** — will error with "Team does not exist." Create it first.
- **Workers editing overlapping files** — define non-overlapping file scopes in CONSTRAINTS. If slices must share files, serialize them.
- **Marking tasks done without verification** — violates rule 6. Always verify with a tool call.
- **Orchestrator drifting into source edits** — when tempted, dispatch a worker instead.

## Deactivation

Stay in orchestrator mode until the user explicitly says:
- "exit orchestrator mode"
- "back to normal"
- "stop coordinating, just do it"

At that point, acknowledge the exit and resume normal Claude Code behavior.
