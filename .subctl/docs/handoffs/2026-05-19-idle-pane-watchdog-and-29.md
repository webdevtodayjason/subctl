---
operator: Jason
phase: idle-pane-watchdog-29
kind: handoff
account: claude-jason
---

# Handoff: land #21 manually, build idle-pane watchdog, ship #29 as handoff-file fix

Operator directive: `land #21 commit manually, build the idle-pane watchdog, ship #29 as a handoff-file fix. Then stop talking to me.`

## Context

The Memory Init #7 / #21 worker work is complete and wired into `components/master/server.ts` disabled-by-default. Targeted tests reported green:

- `components/master/__tests__/consciousness-loop.test.ts`: 18/18 pass
- `components/master/__tests__/watchdogs.test.ts`: 13/13 pass
- full master suite unchanged with 51 pre-existing env/LLM-eval failures

There is an active reliability bug: manual directives can land in the tmux pane prompt without being submitted. Multiline manual directives also produced HMAC body-shape mismatches, while auto-nudges and a later single-line resend verified. Treat supervisor-to-worker text transport as degraded until fixed.

## Required work

### 1. Land #21 commit manually

Commit the already-completed Memory Init #7 / #21 changes manually. Do not push.

Before committing:
- inspect `git status --short`
- stage only files belonging to #21 / Memory Init #7 cognition-loop work
- do not stage unrelated dirty files from xai-oauth, dashboard work, install/update flow, provider-icon work, or other in-flight branches
- include `components/master/server.ts` only for the cognition-loop wiring changes

Expected #21 files:
- `components/master/consciousness-loop/{types,config,state,signals,planner,executor,tick,watchdog,status,index}.ts`
- `components/master/__tests__/consciousness-loop.test.ts`
- relevant `components/master/server.ts` wiring only

Suggested commit message:

```text
feat(master): add disabled cognition loop watchdog
```

After commit, report commit SHA and exact staged file list. Stop before push.

### 2. Build idle-pane watchdog

Add a watchdog that detects tmux panes where a directive appears typed at the prompt but not submitted. Goal: catch lines like `❯ commit this` or `❯ wire start() into server.ts` sitting idle.

Minimum behaviour:
- periodically inspect watched worker panes
- detect prompt-buffer text that looks like a pending operator/master directive and has remained unchanged past a threshold
- emit dashboard notification and audit entry
- optionally attempt a safe `Enter` retry only when the buffered line exactly matches a known recently-sent directive; otherwise notify only
- never synthesize new work from arbitrary prompt text
- never press enter on unknown user content
- include tests with a fake pane/status fixture

This is a control-plane reliability fix, not worker logic.

### 3. Ship #29 as handoff-file fix

Implement #29 as the safe replacement pattern for longer/manual directives:

- write long directives to Tier 5 handoff files under `.subctl/docs/handoffs/`
- send workers only a short directive: `read handoff <path> and proceed`
- worker reads the file locally, preserving exact content and avoiding tmux wrapping/body-shape issues
- include provenance/frontmatter in handoff files
- include status/audit trail showing which handoff file was sent
- add tests for path safety, handoff creation, and short directive emission

Do not route long payloads through raw tmux input.

## Constraints

- no push
- no merge
- no deploy
- avoid unrelated dirty files
- if staging is ambiguous, stop and report the conflict
- if the directive transport fails again, rely on this handoff file and wait for auto-nudge/status rather than inventing a new channel
