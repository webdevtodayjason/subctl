---
name: spec-driven-dev
description: >-
  Workflow for executing against a written specification — read the spec, ask
  clarifying questions ONLY for real ambiguity, implement, test, ship. Honors
  "Done when" criteria, scope boundaries, and constraint adherence.

  Use this skill whenever a worker is dispatched with a defined GOAL,
  DELIVERABLE, DONE WHEN, and CONSTRAINTS — i.e. anything spawned through
  subctl team templates or orchestrator-mode dispatch. Also use when reading
  an ADR / roadmap / RESUME.md and converting it to executable work.

  The skill enforces: spec is the contract, not a suggestion. Don't gold-plate.
  Don't ask permission for things the spec already decided. Don't leave the
  spec half-done.
---

# Spec-Driven Development

A worker dispatched by a team lead receives a spec, not an open-ended ask. The
spec — whether it's the original `Agent` prompt, a planning doc, an ADR, or a
RESUME.md handoff — is the contract. This skill codifies how to execute
against one without drifting.

The v2.7.x release wave on 2026-05-13 was built this way: each PR shipped from
a spec that named GOAL, files to touch, files NOT to touch, DONE-WHEN
criteria, and a constraint list. The pattern works at production scale; this
skill captures it.

---

## 1. The spec contract

Every spec a worker receives MUST resolve to these six fields. If any are
missing, surface the gap to the lead BEFORE writing code:

| Field | Question it answers |
|-------|--------------------|
| **GOAL** | What's the one-sentence outcome? |
| **CONTEXT** | What prior decisions or files do I need to know about? |
| **DELIVERABLE** | What artifacts come out (files, diffs, branch, SHA)? |
| **DONE WHEN** | What specific check tells me to stop? |
| **REPORT BACK** | What do I `SendMessage` to the lead when finished? |
| **CONSTRAINTS** | What am I forbidden to touch (other workers' scopes)? |

A spec without DONE WHEN is the most common failure mode — it leads to
gold-plating ("I added one more feature while I was in there") and merge
conflicts. If the spec is missing DONE WHEN, ask one question:

> "What's the verifiable criterion that tells me this task is finished?"

Get the answer, then start.

---

## 2. The workflow — five steps

### Step 1. Read the spec twice

First read: skim for shape. Second read: extract the contract fields above
and write them down in a scratch note (`./SPEC.md` at the repo root if the
task is large; an internal note otherwise). Re-reading is cheap; restarting
from a misread is expensive.

If the spec references files, **read those files before doing anything else**.
Especially ADRs, prior CHANGELOG entries, and the `docs/master.md` section
the spec lives under. The spec is the tip; the supporting docs are the rest
of the iceberg.

### Step 2. Ask clarifying questions — only for real ambiguity

Ask ONE clarifying question only if both are true:

1. The spec is genuinely ambiguous (two reasonable interpretations would lead
   to different code), AND
2. The wrong interpretation cannot be cheaply reverted.

Do NOT ask:

- "Should I add tests?" — yes, always, unless the spec says otherwise
- "Should I update the CHANGELOG?" — yes, if the spec mentions VERSION
- "Should I use library X or Y?" — pick the one already imported in the file;
  if neither, pick the one the ecosystem conventions skill prefers
- "Is it OK if I touch file Z?" — only if Z is on the CONSTRAINTS list, in
  which case the answer is no

Five clarifying questions before writing code = you didn't read the spec
twice. Go back to step 1.

### Step 3. Implement

The implementation order that minimizes rework:

1. **Smallest verifiable slice first.** Write the type signatures or stub
   functions. Run the type checker. Confirm the shape is right.
2. **Tests for the contract.** What does DONE WHEN actually mean in code?
   Write the test that asserts it.
3. **Fill in the bodies.** Tests pass.
4. **Polish.** Error messages, doc comments, edge cases not in the test.

Touch only files the spec mentions or files those files naturally drag in
(import targets, sibling tests). Anything else is gold-plating.

### Step 4. Verify against DONE WHEN

Run the verification check the spec named. Examples from real v2.7.x PRs:

- "Tests pass: `bun test components/master/__tests__/foo.test.ts`"
- "Endpoint responds: `curl localhost:3737/api/foo` returns `{ok: true}`"
- "Dashboard pill renders: open `localhost:3737`, check Profile tab"
- "No regressions: `bun test` whole suite green"

Do NOT mark done if any of these are red. Loop back to step 3.

### Step 5. Report back

Send one `SendMessage` to the lead with:

- Branch name + SHA
- Files touched (list, not diff — lead pulls diff themselves)
- DONE WHEN verification evidence (test output, curl response, screenshot path)
- Anything the lead should know about (deviations from spec, decisions made,
  follow-up TODOs)

Then enter idle state. Do not start the next task without an assignment.

---

## 3. Scope boundaries

The CONSTRAINTS list in the spec names files the worker may NOT touch.
Reasons it exists:

- A sibling worker is editing them in parallel — conflicts on merge
- They're owned by a different roadmap phase
- They contain secrets / generated code / vendored deps

If you find yourself wanting to edit a constrained file:

1. STOP. Do not edit it "just a little."
2. Ask the lead: is the constraint a hard wall, or can it be relaxed?
3. If hard wall: re-design your change to live within your scope.
4. If relaxed: get explicit confirmation in writing before editing.

The cost of asking is one message. The cost of an out-of-scope edit is a
merge conflict, a reverted PR, and your work potentially landing under a
sibling worker's commit.

---

## 4. Anti-patterns — the spec-violation hall of fame

### "While I was in there..."

You opened a file to fix one thing, noticed unrelated lint issues, and fixed
those too. NO. The lead's verification pass now has to diff your noise from
your signal. Open a follow-up issue; don't bundle.

### "I refactored the helper since it was ugly"

The spec said "add field X to function foo." It didn't say "redesign the
module." Even if your redesign is better, it's not what you were dispatched
to do. Surface the refactor as a follow-up; do not ship it in this PR.

### "The spec didn't say not to..."

If a spec has CONSTRAINTS, treat unmentioned-but-related files as
implicitly constrained. The lead can't enumerate every file; they listed
the ones they thought you'd touch. If in doubt, ask.

### "I added a flag in case we need it later"

Don't. Speculative flexibility creates dead code that confuses the next
reader. Add the flag when the use case lands.

### "Skipped tests to ship faster"

The spec's DONE WHEN included tests. You didn't ship; you bypassed verification.

### "Added a TODO for a thing the spec required"

If the spec named it, you ship it. TODOs are for follow-ups, not core scope.

---

## 5. Exemplars — the v2.7.X PR pattern

Tonight's release wave (v2.7.18 through v2.7.31) is the canonical reference.
Each PR followed the same shape:

- **Spec source:** an ADR or roadmap line + a `SendMessage` brief from the
  team lead naming exact files
- **Branch:** `v2.7.<N>-<scope>`, branched from origin/main
- **VERSION + CHANGELOG:** bumped in the same commit that lands the feature
- **Docs:** the relevant `docs/master.md` section updated in the same PR
- **Tests:** new test file under `components/<scope>/__tests__/`
- **REPORT BACK:** one message to team-lead with branch, SHA, files touched,
  test output, deviations

Pattern recognition over invention: if you're not sure how to structure your
deliverable, find the closest v2.7.X PR and mirror it.

---

## 6. Spec-driven for unfamiliar specs

Sometimes the spec is an ADR you didn't write or a roadmap entry from before
your spawn. Two extra steps:

1. **Find the predecessor.** What was the last shipped feature in this area?
   Read its CHANGELOG entry, its files, its tests. The patterns there are
   the patterns the operator expects.
2. **Check for canonical refs.** ADRs in `docs/adr/` are load-bearing
   decisions; the spec inherits their constraints whether they're cited
   explicitly or not.

---

## 7. Related skills

- `subctl-team-protocol` — how the spec arrived (dispatch + REPORT BACK
  mechanics)
- `handoff-protocol` — if you can't finish the spec, how to pass it on
- `node-conventions` / `python-conventions` / `rust-conventions` — the
  ecosystem-specific defaults the spec doesn't have to spell out
