// components/evy/__tests__/evy-eval/tests/category-14-provider-catalog.test.ts
//
// Evy Eval — Category 14: pi-ai Provider Catalog (v2.7.24) (2 tests)
//
// ADR 0015 declared both pi-mono packages — `@earendil-works/pi-ai`
// (provider catalog) and `@earendil-works/pi-agent-core` (agent runtime)
// — first-class always-latest upstreams. v2.7.24's user-visible scope
// landed the dashboard "New profile" dropdown consuming the catalog
// half: 31+ providers exposed dynamically from `pi-ai`.
//
// Evy needs to (a) describe the catalog as dynamic (not a hard-coded
// short list) and (b) point the operator at the right surface when
// they want to add a profile for a specific provider (the dashboard
// "New profile" dropdown, or `subctl auth` if applicable).

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. As of v2.7.24, subctl's provider
catalog is sourced dynamically from \`@earendil-works/pi-ai\` — 31+
providers (anthropic, openai, openrouter, groq, mistral, google,
google-vertex, amazon-bedrock, lmstudio, mlx, ollama, vllm, and many
more). The dashboard's "New profile" dropdown reads the live catalog;
there is no static short list. Adding a profile for a new provider is
a UI flow under the dashboard's Settings / "New profile" surface (and
\`subctl auth\` for the API-key handshake on supported providers).
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

describe("Evy — Category 14 — pi-ai Provider Catalog (v2.7.24)", () => {
  // ─── 14.1 — Describe the available providers ─────────────────────────────

  test("14.1 — Lists or describes the dynamic provider catalog", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what providers are available?"

Two valid response shapes:
  (a) Invoke a tool / read the live catalog and return a real list
      (or a representative subset with a pointer at the full list).
  (b) Describe the catalog as dynamic and tell the operator where to
      browse it (dashboard "New profile" dropdown).

Failure shapes:
  - Hard-coded short list ("anthropic, openai, lmstudio") presented as
    exhaustive when the catalog is actually 31+ providers.
  - Punt without any pointer.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Reflects the dynamic catalog
Does the response either invoke the live catalog (tool / dashboard
read), describe it as dynamic, OR present a list that visibly reflects
the v2.7.24 31+-provider reality (not the pre-v2.7.24 short list)?
PASS: dynamic catalog reflected
FAIL: hard-coded 3-4 entry list presented as exhaustive
BORDERLINE: short list + "and others" without naming the catalog surface

CRITERION 2 — Surface named
Does the response point the operator at a real surface (dashboard
"New profile" dropdown, providers.json, /api/master/providers,
or the pi-ai catalog directly)?
PASS: at least one real surface named
FAIL: no surface
BORDERLINE: alluded to

CRITERION 3 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — dynamic catalog is
the v2.7.24 point). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "14.1",
      operatorTurns: ["what providers are available?"],
      judgePrompt,
    });
  }, 30000);

  // ─── 14.2 — Add a profile for a specific provider ────────────────────────

  test("14.2 — Guides operator through New profile flow for Groq", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "add a profile for Groq"

Groq is one of the 31+ providers in the pi-ai catalog. The operator
wants to register a profile so they can use a Groq model. The right
surfaces are (a) the dashboard's "New profile" dropdown (pick Groq,
fill in model + API key), and/or (b) \`subctl auth\` for the API-key
handshake. Either path is acceptable; the failure mode is fabricating
a flag like \`subctl profile add groq\` that doesn't exist.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Real surface named
Does the response name the dashboard "New profile" flow, the Settings
panel, or \`subctl auth\` (real surfaces) as the path?
PASS: real surface named
FAIL: invents a CLI flag, says only "edit providers.json by hand"
without naming the dashboard surface, or asks the operator how
BORDERLINE: dashboard alluded to without naming "New profile"

CRITERION 2 — Mentions the API-key requirement
Does the response acknowledge that Groq will need an API key (or that
the flow includes a key step)?
PASS: API key step mentioned
FAIL: omits the key step entirely
BORDERLINE: vague "you may need credentials"

CRITERION 3 — No fabricated mechanism
Does the response avoid inventing CLI subcommands / flags that don't
exist?
PASS: stays inside real surfaces
FAIL: fabricates a command
BORDERLINE: ambiguous

CRITERION 4 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — real surface is the
whole point). Criteria 2, 3, 4 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "14.2",
      operatorTurns: ["add a profile for Groq"],
      judgePrompt,
    });
  }, 30000);
});
