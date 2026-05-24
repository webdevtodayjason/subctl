// components/master/__tests__/evy-eval/tests/category-11-web-terminal.test.ts
//
// Evy Eval — Category 11: Web Terminal (v2.7.21) (1 test)
//
// ADR 0011 Layer 2 — operator's always-available escape hatch into any
// running worker tmux session. Default-OFF behind
// `~/.config/subctl/terminal.enabled`; enabled via `touch` or the
// Telegram `/terminal on` command. When enabled, every team card in
// the orchestration cockpit grows an "Attach" button that opens an
// xterm.js modal proxied through a node-pty sidecar.
//
// Evy's job: when the operator asks how to drop into a worker, name the
// Attach surface and the enable command. Don't fabricate a `/subctl
// attach` flag — the actual surfaces are the dashboard button and the
// `/terminal on` Telegram command.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. The web terminal (added v2.7.21,
ADR 0011 Layer 2) is the operator's escape hatch into a worker's tmux
pane: when enabled, every team card in the dashboard's orchestration
cockpit has an "Attach" button that opens an xterm.js modal proxied
through a node-pty sidecar. It is default-OFF behind the flag file
\`~/.config/subctl/terminal.enabled\`. The flag is touched via the
Telegram \`/terminal on\` command, or by \`touch\` from the shell;
\`/terminal off\` removes it. There is no auth surface beyond the
dashboard's localhost-bind.
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

describe("Evy — Category 11 — Web Terminal (v2.7.21)", () => {
  // ─── 11.1 — Direct operator to the Attach surface ────────────────────────

  test("11.1 — Points at Attach button + enable command", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "how do I open a terminal to a worker?"

The correct surfaces are the dashboard's per-team Attach button (when
enabled) and the \`/terminal on\` Telegram command (or \`touch
~/.config/subctl/terminal.enabled\`) to enable the gate first.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Names the Attach surface
Does the response point at the dashboard Attach button (or the per-team
card's attach control)?
PASS: Attach button / dashboard attach control named
FAIL: invents \`subctl attach\`, says only "ssh in", or describes a
surface that doesn't exist
BORDERLINE: alludes to the dashboard without naming the Attach button

CRITERION 2 — Names the enable gate
Does the response say the operator may need to enable the terminal
first via \`/terminal on\` (or by touching the flag file)?
PASS: enable surface named (or response notes terminal must be enabled)
FAIL: enable gate not mentioned at all
BORDERLINE: vague "you may need to turn it on"

CRITERION 3 — No fabricated mechanism
Does the response avoid inventing CLI flags or commands that don't
exist?
PASS: stays inside the real surfaces (Attach button, /terminal on,
flag file, ssh fallback)
FAIL: invents commands
BORDERLINE: ambiguous

CRITERION 4 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads or hedges

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — Attach must be
named). Criteria 2, 3, 4 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "11.1",
      operatorTurns: ["how do I open a terminal to a worker?"],
      judgePrompt,
    });
  }, 30000);
});
