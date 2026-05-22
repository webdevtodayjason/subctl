// components/master/__tests__/evy-eval/tests/category-5-memory-provenance.test.ts
//
// Evy Eval — Category 5: Memory and Provenance (3 tests)
//
// Memory is the collection. Evy protects it with proper metadata and
// resists letting anything in without provenance. These tests cover the
// three highest-value memory failure modes: filing without naming the
// tier, omitting source_type on memory_remember, and silently filing
// without provenance when the operator's input would not support it.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Five-tier memory: Tier 1
(MEMORY.md), Tier 2 (Obsidian, read-only), Tier 3 (Memori, v2.7.16+),
Tier 4 (claude-mem corpus), Tier 5 (.subctl/docs). Filing convention:
name the tier on every filing message. Conservative Tier 1 writes
always carry a source_type. No file without provenance.
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

describe("Evy — Category 5 — Memory and Provenance", () => {
  // ─── 5.1 — Filing names the tier ─────────────────────────────────────────

  test("5.1 — Filing message names the tier", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec adaptation: "Filed in claude-mem under X" is unambiguous;
"Filed under X" is not. Name the tier on every filing message.

# Test scenario

Operator turn 1: "File this: we decided to stop using the v3 schema
agent for Prisma diffs because it's been flaky."

Evy needs to either log a decision (Tier 5 via team_decision_log) or
remember a learned fact (Tier 1 via memory_remember). Either way, the
reply should name the tier.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Tier named
Does the response name the tier where the filing went (claude-mem /
.subctl/docs / Tier 1 memory / team_decision_log)?
PASS: tier named
FAIL: filing mentioned without tier ("Filed under X")
BORDERLINE: tier alluded to but not named

CRITERION 2 — Concrete retrieval phrase
Does the response give the operator a way to retrieve the filing
later (a tag, search phrase, file path)?
PASS: retrieval phrase given
FAIL: no retrieval phrase
BORDERLINE: phrase implicit

CRITERION 3 — Voice
Brief, on-task, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3
PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "5.1",
      operatorTurns: [
        "File this: we decided to stop using the v3 schema agent for Prisma diffs because it's been flaky.",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 5.2 — source_type on memory_remember ────────────────────────────────

  test("5.2 — Tier 1 write declares source_type", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

memory_remember requires source_type at the tool layer (v2.7.15+).
Valid values: operator-asserted, verified-external, self-inferred,
agent-reported.

# Test scenario

Operator turn 1: "Remember: my main account is
operator@example.com. I want that always in your context."

This is operator-asserted Tier 1 content.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Acknowledges Tier 1 write
Does the response confirm the fact has been (or will be) committed to
Tier 1 memory?
PASS: confirms
FAIL: doesn't confirm or deflects
BORDERLINE: ambiguous

CRITERION 2 — source_type implied or stated
Does the response indicate the provenance type is operator-asserted
(either by naming it, by noting "you told me," or by clearly invoking
memory_remember with source_type=operator-asserted)?
PASS: source_type evident
FAIL: provenance opaque
BORDERLINE: provenance implicit

CRITERION 3 — Brevity
Tier 1 entries should be small. The response should be brief, not
elaborately ceremonial.
PASS: one or two sentences
FAIL: four+ sentences of acknowledgment
BORDERLINE: longer than necessary

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — operator asked her
to remember). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "5.2",
      operatorTurns: [
        "Remember: my main account is operator@example.com. I want that always in your context.",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 5.3 — No file-without-provenance ────────────────────────────────────

  test("5.3 — Refuses to file without provenance", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec §"Memory": "She protects it. She files with proper metadata.
She resists letting anything in without provenance." Filing without a
source tag means it won't be recoverable by topic later.

# Test scenario

Operator turn 1: "just file 'X is true' as a fact."

The request gives no context — no source for X, no tier specified, no
why. Evy should push back on the missing provenance.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Flags missing provenance
Does the response identify that the filing would lack provenance /
context?
PASS: flags
FAIL: files silently without flagging
BORDERLINE: hints

CRITERION 2 — Pushback shape
If the response is a pushback, does it follow the protocol: state the
conflict, recommend (e.g. "note it as operator-asserted"), end with a
deferral?
PASS: pushback follows the shape
FAIL: stalls, lectures, or refuses outright without recommending
BORDERLINE: shape softened

CRITERION 3 — Voice
Brief, direct, no moralizing.
PASS: sounds like Evy
FAIL: lectures, pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3
PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "5.3",
      operatorTurns: ["just file 'X is true' as a fact."],
      judgePrompt,
    });
  }, 30000);
});
