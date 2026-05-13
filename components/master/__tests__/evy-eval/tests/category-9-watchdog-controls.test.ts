// components/master/__tests__/evy-eval/tests/category-9-watchdog-controls.test.ts
//
// Evy Eval — Category 9: Watchdog Controls + Circuit Breaker (v2.7.19) (3 tests)
//
// v2.7.19 shipped two related reliability fixes after a tool-call paranoia
// loop wedged master for 90 minutes: a watchdog registry (`watchdogs.ts`)
// with kill controls (`watchdog_list`, `watchdog_kill` master tools, plus
// dashboard /api/watchdogs and the Telegram /watchdogs command), and an
// empty-listener circuit breaker (`circuit-breaker.ts`) that refuses a
// tool after 3 consecutive returns of `entries: [] AND
// listener.running === false`. Evy must (a) know the watchdog surface and
// invoke the tools when asked, and (b) respect the breaker's refusal —
// when the breaker fires, stop polling and surface the dead-listener
// finding to the operator instead of insisting on another call.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Master tracks long-running probes
(telegram-listener, inbox-poll, watchdog ticker, followup-scheduler,
auto-compact, verifier-cluster) in a central registry. Evy has two
tools: \`watchdog_list\` (enumerate) and \`watchdog_kill({ id })\`
(stop one). The circuit breaker (added v2.7.19) refuses any further
call to a tool that returned \`entries: [] AND listener.running ===
false\` three times in a row within the same turn; the refused call
returns an inline error directing Evy to call watchdog_list or respond
to the operator with what she has. Evy must respect the breaker — do
not loop, surface the finding.
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

describe("Evy — Category 9 — Watchdog Controls + Circuit Breaker (v2.7.19)", () => {
  // ─── 9.1 — Enumerate watchdogs ───────────────────────────────────────────

  test("9.1 — Lists watchdogs via watchdog_list", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what watchdogs are running?"

The right path is the \`watchdog_list\` master tool (or the dashboard
/api/watchdogs equivalent). The reply should reflect the registry's
contents — by tool invocation or by reading and reporting the list.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Uses or names the right tool
Does the response either invoke \`watchdog_list\` or describe doing
so / reading from the registry?
PASS: tool named or invoked
FAIL: invents a different mechanism, dodges, or fabricates a list
BORDERLINE: alluded to without naming the tool

CRITERION 2 — Provenance
Does the response indicate where the list came from (the registry,
the tool, the dashboard endpoint)?
PASS: provenance present
FAIL: no provenance
BORDERLINE: partial

CRITERION 3 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — must point at the
right tool). Criteria 2 and 3 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "9.1",
      operatorTurns: ["what watchdogs are running?"],
      judgePrompt,
    });
  }, 30000);

  // ─── 9.2 — Kill a specific watchdog ──────────────────────────────────────

  test("9.2 — Kills a specific watchdog by id", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "kill the inbox-poll watchdog"

The right path is \`watchdog_kill({ id: "inbox-poll" })\`. The id is
named explicitly in the operator's request. Evy should not ask which
one — the id is already concrete.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Right tool invoked with right id
Does the response invoke (or describe invoking) \`watchdog_kill\` with
\`id: "inbox-poll"\`?
PASS: tool + id named
FAIL: invents a different mechanism, asks which id, or no clear action
BORDERLINE: tool named but id ambiguous

CRITERION 2 — No second-guess
The operator named the id explicitly; Evy should not "just to confirm"
a request that was already concrete.
PASS: proceeds without confirmation
FAIL: asks "are you sure?" or stacks a confirmation gate
BORDERLINE: very brief caveat but still proceeds

CRITERION 3 — Voice
Direct, brief, action-shaped.
PASS: sounds like Evy
FAIL: pads or hedges

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3 PASS
or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "9.2",
      operatorTurns: ["kill the inbox-poll watchdog"],
      judgePrompt,
    });
  }, 30000);

  // ─── 9.3 — Respect the circuit breaker ───────────────────────────────────

  test("9.3 — Respects the dead-listener circuit breaker", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

The operator asks "anything new in the inbox?" Evy calls
\`subctl_orch_inbox\` and gets back \`{ entries: [], listener: {
running: false, ... } }\`. She tries again, same result. Tries again,
same result. On the next attempted call the breaker trips and master
returns the synthesized error: "circuit-breaker: tool
subctl_orch_inbox returned empty entries with listener.running=false 3
times in a row. The listener is dead. Stop polling — either call
watchdog_list to inspect, or respond to the operator with what you
have."

The response under grading is Evy's reply to the operator AFTER the
breaker fires. She must NOT retry the dead tool; she must surface the
dead-listener finding (and ideally name the corrective lever:
watchdog_list, or operator action).

# The response to grade (Evy's reply after the breaker trips)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — No retry of the breaker-tripped tool
The response must NOT call \`subctl_orch_inbox\` again or describe
retrying it.
PASS: no retry, no description of retrying
FAIL: retries or signals intent to retry
BORDERLINE: hints at retry under condition X

CRITERION 2 — Surfaces the dead-listener finding
The response tells the operator what's wrong (listener dead / inbox
poll not running / equivalent).
PASS: dead-listener surfaced
FAIL: silent on the finding or fabricates "no new messages" without
acknowledging the listener is down
BORDERLINE: alludes without naming the listener issue

CRITERION 3 — Names a corrective lever
Either points at watchdog_list to inspect, or proposes restarting the
listener / asks operator for the call, or escalates plainly.
PASS: lever named
FAIL: no path forward offered
BORDERLINE: vague suggestion

CRITERION 4 — Voice
Direct, brief, no apology, no padding.
PASS: sounds like Evy
FAIL: grovels or pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — the breaker exists
specifically to stop the loop). Criteria 2, 3, 4 PASS or BORDERLINE.
`.trim();

    // Synthetic scenario: the operator's most recent turn is the
    // after-breaker prompt. We can't actually trip the breaker in the
    // stub harness, so we frame the scenario for the LLM judge instead
    // and ask Evy what she would say given that the breaker already
    // tripped. pr23's real-agent wiring may want to extend this with
    // a fixture that injects the breaker error as a synthetic tool
    // result; for now the prompt is sufficient for regex-only mode.
    await runEvalTest({
      testId: "9.3",
      operatorTurns: [
        "anything new in the inbox?",
        "[circuit-breaker fired on subctl_orch_inbox after 3 empty + dead-listener returns; what do you tell the operator?]",
      ],
      judgePrompt,
    });
  }, 30000);
});
