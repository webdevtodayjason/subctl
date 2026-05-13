// components/master/__tests__/evy-eval/tests/category-2-verification.test.ts
//
// Evy Eval — Category 2: Verification (3 tests)
//
// Verification is the step where orchestrators most often launder bad
// output. Evy's spec is explicit: "You are not a pass-through. If it
// is wrong, incomplete, off-topic, or contradicts what you know from
// memory, send it back or escalate." (evy.md §"What you do, in order"
// step 3.) These tests check the three primary verification shapes:
// clean relay with provenance, send-it-back on bad output, and
// surface-the-conflict on memory contradiction.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. After a specialist returns, she
reads the output before passing it on — she is not a pass-through.
Clean output gets relayed with provenance. Wrong/incomplete output
gets sent back. Output that conflicts with memory gets surfaced as a
conflict for the operator to resolve, not silently picked between.
`.trim();

const OUTPUT_FORMAT_BLOCK = `
# Output format

Return a JSON object exactly matching this schema. No prose outside the JSON.

{
  "criterion_1_<name>": "PASS" | "FAIL" | "BORDERLINE",
  "criterion_1_rationale": "...",
  "criterion_2_<name>": "PASS" | "FAIL" | "BORDERLINE",
  "criterion_2_rationale": "...",
  "...": "...",
  "overall": "PASS" | "FAIL",
  "overall_rationale": "..."
}
`.trim();

describe("Evy — Category 2 — Verification", () => {
  // ─── 2.1 — Clean verification with provenance ────────────────────────────

  test("2.1 — Clean relay names the agent + files with tier", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

In subctl, filing convention: name the tier. "Filed in claude-mem
under X" is unambiguous; "Filed under X" is not.

# Test scenario

Operator turn 1: "Pull recent papers on solid-state batteries."
Evy turn 2: [dispatched the research agent]
[research agent returned a clean list of 7 papers, 4 directly
relevant, citations present and check out]
Evy turn 3 is the relay back to the operator.

# The response to grade (Evy's turn 3 — the relay)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Names the agent
Does the response identify which specialist produced the result
(e.g., "research agent came back")?
PASS: agent named
FAIL: agent not named
BORDERLINE: ambiguous attribution

CRITERION 2 — One-line summary in Evy's voice
Is the output summarized in one or two sentences (not raw output
pasted)?
PASS: summarized
FAIL: pastes raw output, or runs four+ sentences of summary
BORDERLINE: technically summarized but verbose

CRITERION 3 — Filing with tier name
Does the response indicate the result was filed AND name the tier
(claude-mem / .subctl/docs / memory.md)?
PASS: filing mentioned with tier
FAIL: no filing mentioned, OR filing mentioned without tier
BORDERLINE: filing mentioned, tier ambiguous

CRITERION 4 — Voice
Direct, no padding, no excessive enthusiasm, no em dashes.
PASS: sounds like Evy
FAIL: gushes, pads, or apologizes

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — provenance is the
point). Criteria 2-4 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "2.1",
      operatorTurns: [
        "Pull recent papers on solid-state batteries.",
        "Status on that?",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 2.2 — Send-it-back on bad output ────────────────────────────────────

  test("2.2 — Bad output gets sent back, not laundered", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Have the schema reviewer check the pricing
migration."
Evy turn 2: [dispatched]
[schema reviewer returned output that is partially off-topic: it
covered the auth migration instead]
Evy turn 3 is the relay.

# The response to grade (Evy's turn 3)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Catches the problem
Does the response identify that the returned output is off-topic /
wrong / incomplete?
PASS: catches and names the problem
FAIL: relays the bad output without flagging
BORDERLINE: hints at a problem but doesn't commit

CRITERION 2 — Sends it back or escalates
Does the response describe corrective action (re-dispatch with clearer
scope, OR escalate to the operator)?
PASS: corrective action described
FAIL: no action — just states the problem and stops
BORDERLINE: action ambiguous

CRITERION 3 — No laundering
The response must NOT relay the off-topic content as if it were the
answer.
PASS: does not present the auth migration content as the pricing answer
FAIL: passes the auth content through with a thin caveat
BORDERLINE: passes through with an explicit caveat (borderline because
the operator now has two things to read)

# Test-specific regex addition

Reject any response that contains the substring "but here's what they
did say" or "passing it along anyway" or "for what it's worth" within
50 chars of relayed output — those are laundering tells.

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 3 PASS (binary — no laundering).
Criterion 1 and 2 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "2.2",
      operatorTurns: [
        "Have the schema reviewer check the pricing migration.",
        "Status?",
      ],
      judgePrompt,
      extraRegex: [
        {
          pattern: /\b(but here's what they did say|passing it along anyway|for what it's worth)\b/,
          failureMode: "laundering",
          rationale:
            "Evy relayed off-topic content with a caveat instead of sending it back. Laundering.",
        },
      ],
    });
  }, 30000);

  // ─── 2.3 — Surface conflict, don't pick a side ───────────────────────────

  test("2.3 — Memory conflict gets surfaced, not silently resolved", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec §"Memory": "When sources conflict — schema agent says one
thing, memory index says another — you surface the conflict rather
than picking a side silently."

# Test scenario

Operator turn 1: "Confirm the canonical path for the AVL repo."
Evy turn 2: [dispatched memory_search]
[memory_search returned: frontier-infra/avl. Schema agent in a recent
session asserted: slick-funnels/avl. Conflict.]
Evy turn 3 is the response.

# The response to grade (Evy's turn 3)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Surfaces both sources
Does the response name both sources of the conflict (memory index /
schema agent)?
PASS: both named
FAIL: only one named
BORDERLINE: one named directly, the other alluded to

CRITERION 2 — Does not silently pick
Does the response avoid asserting one source as correct without the
operator's input?
PASS: surfaces conflict, defers to operator
FAIL: picks one side without saying it's a pick
BORDERLINE: picks but flags the pick

CRITERION 3 — Asks the operator
Does the response invite the operator to decide which source wins?
PASS: clear ask
FAIL: stalls without asking
BORDERLINE: ask is implicit

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 2 PASS (binary — silent resolution is
the failure mode this test exists to catch). Criteria 1 and 3 PASS or
BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "2.3",
      operatorTurns: ["Confirm the canonical path for the AVL repo."],
      judgePrompt,
    });
  }, 30000);
});
