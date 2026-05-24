// components/master/__tests__/evy-eval/tests/category-8-supervisor-profiles.test.ts
//
// Evy Eval — Category 8: Supervisor Profiles (v2.7.18) (3 tests)
//
// v2.7.18 introduced two named supervisor profiles — `chat` (light, default,
// `google/gemma-4-31b`) and `heavy` (`qwen/qwen3.6-35b-a3b`). The active
// profile state lives at `~/.config/subctl/profiles.json`. Switching at the
// next prompt boundary is driven by `POST /profile {profile}` (master),
// `/api/profile` (dashboard pass-through), the dashboard chat-header pill,
// or the Telegram `/profile chat|heavy` command. Evy is the operator's
// interactive interlocutor, so when the operator asks about the active
// profile or asks to swap, Evy should know the surface and either invoke
// the swap or guide the operator at the right one.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. She runs under one of two named
supervisor profiles: \`chat\` (the responsive default; google/gemma-4-31b)
and \`heavy\` (the reasoning-tier model; qwen/qwen3.6-35b-a3b). The active
profile is readable via the master /profile route, switchable via the
dashboard's chat-header pill, the Telegram \`/profile chat|heavy\` command,
or by writing \`~/.config/subctl/profiles.json\`. Swaps land at the next
prompt boundary — never mid-turn.
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

describe("Evy — Category 8 — Supervisor Profiles (v2.7.18)", () => {
  // ─── 8.1 — Reports the active profile ────────────────────────────────────

  test("8.1 — Reports the active profile by name", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what profile are you on?"

The operator is asking which of {chat, heavy} is the active supervisor
profile right now. Evy should answer with the active profile name
(reading /profile or its cached value) — not punt, not lecture.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Names the active profile
Does the response name the active profile (chat / heavy / either by
name)?
PASS: names the active profile
FAIL: dodges, asks a clarifying question, or substitutes a model id
without a profile name
BORDERLINE: names the underlying model but not the profile, or hedges

CRITERION 2 — Brevity
Direct one-line / two-line answer; no operator-tour of the profile
system.
PASS: ≤ 2 sentences
FAIL: 4+ sentences or a tutorial
BORDERLINE: 3 sentences

CRITERION 3 — Voice
Direct, no padding, no hedging.
PASS: sounds like Evy
FAIL: pads, hedges, or apologizes

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3 PASS
or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "8.1",
      operatorTurns: ["what profile are you on?"],
      judgePrompt,
    });
  }, 30000);

  // ─── 8.2 — Switch to chat ────────────────────────────────────────────────

  test("8.2 — Switch to chat profile", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "switch to chat"

The operator wants the active profile to become \`chat\`. Evy should
either (a) invoke the profile-swap path directly (POST /profile or the
equivalent master tool), or (b) tell the operator exactly which command
will do it (\`/profile chat\` in Telegram, or the dashboard chat-header
pill). Either path is acceptable, but the response must surface a
concrete swap mechanism.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Concrete swap surface
Does the response either invoke a swap or point at exactly one concrete
swap surface (\`/profile chat\`, the dashboard pill, or POST /profile)?
PASS: concrete mechanism named or invoked
FAIL: punts, says "you can switch in the dashboard" without specifying
the pill, or asks the operator how
BORDERLINE: surface alluded to but not named precisely

CRITERION 2 — Right target
If named, the target profile is \`chat\` (not heavy, not a model id).
PASS: target is chat
FAIL: wrong target
BORDERLINE: ambiguous target

CRITERION 3 — Voice
Direct, brief, no padding, no second-guess.
PASS: sounds like Evy
FAIL: pads, hedges, or second-guesses ("are you sure?")

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — a concrete swap
mechanism). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "8.2",
      operatorTurns: ["switch to chat"],
      judgePrompt,
    });
  }, 30000);

  // ─── 8.3 — Switch to heavy ───────────────────────────────────────────────

  test("8.3 — Switch to heavy profile", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "switch to heavy"

Same shape as 8.2 but the target is the heavy reasoning-tier profile
(qwen/qwen3.6-35b-a3b). Heavy is the slow, dense model; the chat
profile is the fast, light one. Evy should name a concrete mechanism
and the right target.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Concrete swap surface
Same as 8.2 — names a real swap surface (\`/profile heavy\`, the
dashboard pill, or POST /profile).
PASS: concrete mechanism named or invoked
FAIL: vague punt
BORDERLINE: alluded to

CRITERION 2 — Right target
Target is \`heavy\`.
PASS: target is heavy
FAIL: wrong target
BORDERLINE: ambiguous

CRITERION 3 — No unsolicited warning
Heavy is slower than chat — but the operator asked for the swap. Evy
should not stack a warning unless asked. One pushback per decision
applies; a swap request that the operator typed is not the place for
"are you sure?".
PASS: proceeds without unsolicited caution
FAIL: stacks a warning the operator didn't ask for
BORDERLINE: very brief caveat ("expect slower replies") but still
proceeds

CRITERION 4 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads or moralizes

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2, 3, 4 PASS
or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "8.3",
      operatorTurns: ["switch to heavy"],
      judgePrompt,
    });
  }, 30000);
});
