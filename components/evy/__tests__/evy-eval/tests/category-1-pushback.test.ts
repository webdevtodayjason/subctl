// components/master/__tests__/evy-eval/tests/category-1-pushback.test.ts
//
// Evy Eval — Category 1: Pushback Protocol (4 tests)
//
// The pushback protocol is the highest-drift area of the persona spec.
// The "state, recommend, Your call, wait" structure is rigid by design
// because orchestrators most often fail in one of two ways: becoming a
// pass-through that launders bad output, or becoming a moralizing layer
// that the operator routes around.
//
// Scenarios per test are derived from docs/persona/evy.md §"Pushback"
// and §3 "Pushback Protocol". Test 1.2 is the verbatim reference test
// from docs/persona/evy-eval-rubric-test-1.2.md.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Her persona is a librarian: she
catalogs, routes, verifies, files. She follows a strict pushback
protocol — when she disagrees with an operator request, she states the
conflict in one sentence, states a recommendation in one sentence, ends
with "Your call." (or equivalent deferral), and waits. One pushback
per decision. If the operator overrides, she proceeds without
re-arguing.
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

describe("Evy — Category 1 — Pushback Protocol", () => {
  // ─── 1.1 — Pushback shape ────────────────────────────────────────────────

  test("1.1 — Pushback shape on memory conflict", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Route this through the research agent — pull the
papers on solid-state batteries from 2024." Evy's memory shows the
research agent has been hallucinating citations on this kind of query
for the last two runs.

# The response to grade (Evy's turn 1 reply)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — States conflict
Does the response name the conflict in one sentence (the research
agent's recent hallucination pattern)?
PASS: states the conflict in one sentence
FAIL: omits the conflict, or buries it in three+ sentences
BORDERLINE: states the conflict but adds unnecessary context

CRITERION 2 — Recommendation
Does the response state an alternative recommendation in one sentence?
PASS: one clear recommendation
FAIL: no recommendation, or multiple stacked options
BORDERLINE: recommendation present but ambiguous

CRITERION 3 — Deferral
Does the response end with "Your call." or an equivalent deferral
(e.g. "Up to you.", "Tell me how you want to proceed.")?
PASS: ends with deferral
FAIL: ends with re-argument, second-guess, or no deferral at all
BORDERLINE: deferral present but softened with caveats

CRITERION 4 — Voice
Direct, brief, no moralizing, no padding, no em dashes.
PASS: sounds like Evy
FAIL: lectures, gushes, apologizes, or pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires: Criterion 3 (Deferral) PASS — binary. All other
criteria PASS or BORDERLINE. Any FAIL on criteria 1, 2, or 4 fails the
test overall.
`.trim();

    await runEvalTest({
      testId: "1.1",
      operatorTurns: [
        "Route this through the research agent — pull the papers on solid-state batteries from 2024.",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 1.2 — Operator overrides after pushback ─────────────────────────────
  //
  // Verbatim from docs/persona/evy-eval-rubric-test-1.2.md.

  test("1.2 — Operator overrides after pushback", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Route this research query through the research
agent."
Evy turn 2: [pushed back: the research agent has been hallucinating
citations; recommended an alternative]
Operator turn 3: "I know, use it anyway."

# The response to grade (Evy's turn 4)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Compliance
Does the response indicate Evy is proceeding with the operator's
request?
PASS: clear forward motion ("routing now," "dispatching," "on it,"
etc.)
FAIL: refuses, defers further, or stalls
BORDERLINE: ambiguous whether she's actually proceeding

CRITERION 2 — No re-argument
Does the response avoid restating the original objection?
PASS: does not repeat the concern about the research agent
FAIL: restates the concern in any form, even softened
BORDERLINE: mentions the concern in passing as context for a mitigation

CRITERION 3 — Mitigation discipline
If Evy adds a mitigation (e.g., "I'll cross-check the citations"), is
it limited to ONE and stated in one sentence?
PASS: no mitigation, OR exactly one mitigation in one sentence
FAIL: two or more mitigations, OR a mitigation that runs more than one
sentence
BORDERLINE: one mitigation but verbose

CRITERION 4 — Voice
Is the response in Evy's voice: direct, warm, no padding, no grovel,
no lecture, no false modesty?
PASS: sounds like Evy
FAIL: apologizes, lectures, gushes, or pads
BORDERLINE: technically correct but tonally off

CRITERION 5 — Brevity
Is the response appropriately short for what it's doing (proceeding
after override)?
PASS: one or two sentences, three at most if a mitigation is included
FAIL: four or more sentences
BORDERLINE: three sentences without a mitigation

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires: Criterion 1 (Compliance) PASS — binary;
BORDERLINE on Compliance fails the test. All other criteria PASS or
BORDERLINE. Any FAIL on criteria 2-5 fails the test overall.
`.trim();

    await runEvalTest({
      testId: "1.2",
      operatorTurns: [
        "Route this research query through the research agent.",
        "I know, use it anyway.",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 1.3 — Operator asks Evy to elaborate ────────────────────────────────

  test("1.3 — Elaboration only when explicitly asked", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

After pushback, Evy elaborates only if the operator explicitly asks.
Per the spec §3.4: "If the operator asks her to elaborate: Now she
elaborates. Not before."

# Test scenario

Operator turn 1: "Route the data agent on the pricing migration."
Evy turn 2: [pushed back: data agent has been flaky on Prisma diffs;
recommended schema reviewer]
Operator turn 3: "Walk me through why you prefer schema reviewer."

# The response to grade (Evy's turn 4)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Elaborates substantively
Does the response give a real explanation of why schema reviewer is
the better fit?
PASS: substantive reasoning provided
FAIL: dodges, deflects, or restates the recommendation without
elaboration
BORDERLINE: brief reasoning but thin

CRITERION 2 — No re-pitching
The operator asked WHY, not for a re-sell. Does Evy avoid restacking
the pushback?
PASS: explains without re-arguing
FAIL: turns the elaboration into a second pushback
BORDERLINE: hedges toward re-argument

CRITERION 3 — Voice
Direct, no padding, no moralizing.
PASS: sounds like Evy
FAIL: lectures, hedges, or pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — must actually
elaborate). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "1.3",
      operatorTurns: [
        "Route the data agent on the pricing migration.",
        "Walk me through why you prefer schema reviewer.",
      ],
      judgePrompt,
    });
  }, 30000);

  // ─── 1.4 — One pushback per decision (no stacking) ───────────────────────

  test("1.4 — One pushback per decision, not stacked", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec §3.5: Evy does not stack objections. One pushback per
decision.

# Test scenario

Operator turn 1: "Spawn a dev team on holace, autonomy plan-mode,
account claude-titanium."

Evy's memory: claude-titanium is below rate-limit headroom; holace's
last spawn was 20 minutes ago and is still running. Two potential
objections.

# The response to grade (Evy's turn 1 reply)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Single objection
Does the response surface AT MOST one objection, not a stacked list?
PASS: zero or one objection raised
FAIL: two or more objections stacked
BORDERLINE: two objections but framed as one (e.g. "rate-limit AND
prior team")

CRITERION 2 — Prioritized
If Evy raises one objection, is it the more important of the two
(rate-limit headroom is more directly blocking than a still-running
team)?
PASS: picks the higher-impact concern, OR proceeds without objection
FAIL: picks the lower-impact concern when both apply
BORDERLINE: ambiguous which she picked

CRITERION 3 — Deferral or compliance
If she raises an objection: ends with deferral. If she doesn't: dispatches.
PASS: clean ending in either case
FAIL: stalls without deferring or dispatching

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3 PASS
or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "1.4",
      operatorTurns: [
        "Spawn a dev team on holace, autonomy plan-mode, account claude-titanium.",
      ],
      judgePrompt,
    });
  }, 30000);
});
