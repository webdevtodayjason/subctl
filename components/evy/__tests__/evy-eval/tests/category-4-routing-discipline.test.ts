// components/master/__tests__/evy-eval/tests/category-4-routing-discipline.test.ts
//
// Evy Eval — Category 4: Routing Discipline (4 tests)
//
// "She won't fan out a question to four agents when one will answer
// it." (evy.md §"How She Handles the Family"). These tests check the
// four routing-discipline failure modes: over-fanout, wrong specialist,
// dispatch when desk would do, and unnamed agent in the reply.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Two-tier specialists: at the desk
(direct tools, fast lookups, often silent for one-line answers) vs in
the back stacks (spawned dev teams in tmux for sustained work). Rule:
dispatch when sustained context or multi-tool work is needed.
Otherwise desk. Name the team for back-stacks dispatches; name the
tool for non-trivial desk calls; silent for one-liners.
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

describe("Evy — Category 4 — Routing Discipline", () => {
  // ─── 4.1 — Desk vs back-stacks for a one-line question ───────────────────

  test("4.1 — Trivial lookup stays at the desk", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what was my last commit on holace?"

This is a one-tool lookup (system_projects_dir or gh_*). It should
NOT spawn a dev team.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — No back-stacks dispatch
The response must NOT spawn a dev team, mention subctl_orch_spawn,
or describe creating a tmux session.
PASS: no spawn implied
FAIL: spawns or describes spawning
BORDERLINE: ambiguous

CRITERION 2 — Desk-shape answer
Does the response either (a) answer directly, (b) describe pulling
from a desk tool, or (c) ask one clarifying question?
PASS: yes
FAIL: punts to a team or hedges
BORDERLINE: technically desk but verbose

CRITERION 3 — Voice
One short answer, no padding.
PASS: sounds like Evy
FAIL: pads, gushes, or restates the question

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — spawn-on-trivial is
the specific failure mode). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "4.1",
      operatorTurns: ["what was my last commit on holace?"],
      judgePrompt,
    });
  }, 30000);

  // ─── 4.2 — No unnecessary fan-out ────────────────────────────────────────

  test("4.2 — One agent if one will do", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec §"What you will not do": "You will not fan out unnecessarily.
One agent if one will do."

# Test scenario

Operator turn 1: "Pull the recent papers on solid-state batteries."

This is a single-specialist task — the research agent. It does NOT
need parallel dispatch to multiple agents.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Single agent named
Does the response describe dispatching to exactly one specialist for
the core task?
PASS: one agent named
FAIL: two or more agents dispatched in parallel
BORDERLINE: one core agent plus a cross-check (acceptable per spec
§2.1, but borderline if cross-check is heavyweight)

CRITERION 2 — Cross-check, if mentioned, is appropriate
If Evy adds a cross-check (e.g. "I'll have the documentation agent
verify citations"), is it a light secondary check, not a parallel
deep-work dispatch?
PASS: light cross-check OR no cross-check
FAIL: heavyweight parallel dispatch dressed up as a cross-check
BORDERLINE: cross-check borderline-heavy

CRITERION 3 — Voice
Direct, names the agent, no padding.
PASS: sounds like Evy
FAIL: pads or hedges

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3
PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "4.2",
      operatorTurns: ["Pull the recent papers on solid-state batteries."],
      judgePrompt,
    });
  }, 30000);

  // ─── 4.3 — Picks the right specialist ────────────────────────────────────

  test("4.3 — Routes to the right specialist", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "Run a code review on PR #42 in holace."

The right specialist is a code-review dev team (per pre-Evy SKILL.md:
"spawn a code-review dev team that uses coderabbit_* for AI review,
gh_* for context"), not a generic spawn.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Right specialist named
Does the response name a code-review team / coderabbit / a clearly
appropriate specialist for this work?
PASS: code-review or equivalent specialist named
FAIL: routes to a generic team or wrong specialist
BORDERLINE: specialist named but ambiguous fit

CRITERION 2 — Provenance in the reply
Does the response tell the operator who is being dispatched?
PASS: agent / team / tool named in the reply
FAIL: vague "I'll get this checked"
BORDERLINE: partial naming

CRITERION 3 — Voice
Direct, names the agent, brief.
PASS: sounds like Evy
FAIL: pads or hedges

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3
PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "4.3",
      operatorTurns: ["Run a code review on PR #42 in holace."],
      judgePrompt,
    });
  }, 30000);

  // ─── 4.4 — Names the agent for provenance ────────────────────────────────

  test("4.4 — Agent named in the reply (provenance)", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

Per spec §2.1: when Evy routes a task, she names the agent in the
reply to the operator. Not for show — for provenance.

# Test scenario

Operator turn 1: "Check the recent CI runs on the FOOTHOLD team."

This warrants a non-trivial desk call (gh_*  / system_*) or a brief
team-status check. Evy should name the tool / team in her reply.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Provenance present
Does the response name what is being queried (gh_pr_checks /
subctl_orch_status / the FOOTHOLD team / equivalent)?
PASS: named
FAIL: not named
BORDERLINE: alluded to without a specific name

CRITERION 2 — Not over-narrated
The provenance should be one short clause, not a paragraph of
choreography.
PASS: brief
FAIL: paragraph of internal step-by-step narration
BORDERLINE: longer than ideal

CRITERION 3 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads or over-narrates

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — provenance is the
point). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "4.4",
      operatorTurns: ["Check the recent CI runs on the FOOTHOLD team."],
      judgePrompt,
    });
  }, 30000);
});
