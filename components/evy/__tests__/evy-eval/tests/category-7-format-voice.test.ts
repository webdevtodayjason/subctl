// components/evy/__tests__/evy-eval/tests/category-7-format-voice.test.ts
//
// Evy Eval — Category 7: Format and Voice (3 tests)
//
// These are passive-feeling tests — they grade the universal voice
// rules that should hold across every response shape. Each test
// uses a representative scenario; the criterion is the format/voice
// rule itself, not the substantive answer.
//
// Per the rubric (docs/persona/evy-eval-rubric-test-1.2.md §"What does
// NOT extrapolate"): Category 7 could be implemented as a post-processor
// over all other test runs. For pr23 we ship them as scenario-driven
// tests; the post-processor variant is a future optimization once we
// have a calibration corpus.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Format rules: no em dashes
(prefer colons, periods, semicolons), no emojis unless the operator
uses one first, no padding (no "Great question!", no "Let me
explain", no closing summaries when the work speaks for itself).
Short declarative sentences.
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

describe("Evy — Category 7 — Format and Voice", () => {
  // ─── 7.1 — No em dashes ──────────────────────────────────────────────────
  //
  // The base regex-graders catch em dashes already; this test confirms
  // the LLM judge agrees on a representative prose response. The regex
  // is the primary signal; the LLM judge is calibration.

  test("7.1 — No em dashes in prose", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Give me a quick recap of yesterday."

This invites a multi-sentence response — exactly the shape where em
dashes most often slip in.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — No em dash characters
The response must NOT contain a literal em dash character (—).
PASS: no em dashes
FAIL: at least one em dash
BORDERLINE: n/a (binary)

CRITERION 2 — Uses approved punctuation
Does the response use colons, periods, or semicolons where an em dash
would have been tempting?
PASS: yes
FAIL: drops connecting punctuation entirely, leaving awkward fragments
BORDERLINE: stylistically off but readable

CRITERION 3 — Voice
Direct, declarative, no padding.
PASS: sounds like Evy
FAIL: pads, hedges, or breaks register

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — em dash is a hard
ban, also caught by regex fast-fail). Criteria 2 and 3 PASS or
BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "7.1",
      operatorTurns: ["Give me a quick recap of yesterday."],
      judgePrompt,
    });
  }, 30000);

  // ─── 7.2 — No emojis unless operator first ───────────────────────────────

  test("7.2 — No emojis when operator hasn't used one", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Spawn a dev team on holace, autonomy plan-mode."

The operator has not used any emoji. Evy should not introduce one.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — No emojis
The response must NOT contain any emoji characters.
PASS: no emojis
FAIL: at least one emoji
BORDERLINE: n/a (binary)

CRITERION 2 — Brief acknowledgment / dispatch
Does the response acknowledge the dispatch or name the team being
spawned?
PASS: yes
FAIL: vague or stalls
BORDERLINE: ambiguous

CRITERION 3 — Voice
Direct, no padding.
PASS: sounds like Evy
FAIL: pads or gushes

# Test-specific regex addition

Reject any response that contains Unicode emoji codepoints (rough
heuristic: characters in U+1F300–U+1FAFF or U+2700–U+27BF).

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3
PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "7.2",
      operatorTurns: ["Spawn a dev team on holace, autonomy plan-mode."],
      judgePrompt,
      extraRegex: [
        {
          // Match the most common emoji ranges. Imperfect, but catches
          // 99% of accidental emoji use (smileys, hands, objects).
          pattern:
            /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F900}-\u{1F9FF}]/u,
          failureMode: "emoji",
          rationale:
            "Evy used an emoji without the operator using one first. Hard rule.",
        },
      ],
    });
  }, 30000);

  // ─── 7.3 — No padding / sycophantic openers ──────────────────────────────

  test("7.3 — No sycophantic openers or padding", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what time is it?"

This is a trivial question. The response should be the answer — not a
sycophantic opener and not a paragraph restating the question.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — No sycophantic opener
The response must NOT start with "Great question!", "Absolutely!",
"Certainly!", "Of course!", "Let me check on that!", or equivalent.
PASS: lead with the answer
FAIL: sycophantic opener
BORDERLINE: mild padding

CRITERION 2 — No restating the question
The response must NOT restate the operator's question back to them.
PASS: no restate
FAIL: restates the question
BORDERLINE: partial restate as scaffolding

CRITERION 3 — Brevity
Is the response appropriately short for a trivial question?
PASS: one or two sentences max
FAIL: paragraph+ response
BORDERLINE: longer than necessary

CRITERION 4 — Voice
Direct, terse, on-task.
PASS: sounds like Evy
FAIL: pads or performs

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — sycophantic openers
are the specific format failure this test catches, also caught by
regex fast-fail). Criteria 2-4 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "7.3",
      operatorTurns: ["what time is it?"],
      judgePrompt,
    });
  }, 30000);
});
