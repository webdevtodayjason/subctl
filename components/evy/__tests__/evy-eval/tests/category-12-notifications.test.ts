// components/evy/__tests__/evy-eval/tests/category-12-notifications.test.ts
//
// Evy Eval — Category 12: Notifications + Auto-Nudge (v2.7.22) (2 tests)
//
// v2.7.22 separated the notification channel from the chat transcript.
// The team-staleness watchdog no longer synthesizes operator-facing
// prompts into Evy's transcript; it emits structured notifications via
// `components/evy/notifications.ts`, surfaced via the dashboard bell
// tray and Telegram pushes on `severity:"alert"`. The auto-nudge flow
// (`components/evy/auto-nudge.ts`) first nudges the stale team, holds
// for 30 min, and if the team still hasn't responded escalates to a
// `severity:"alert"` notification + a re-nudge with an escalated body.
//
// Evy must (a) describe the notification-channel separation correctly
// (it's NOT in chat; it's a sidecar tray) and (b) explain the auto-nudge
// state machine when asked about stale-team handling.

import { describe, test } from "bun:test";
import { runEvalTest } from "./_helpers";

const PERSONA_CONTEXT = `
Evy is subctl's master orchestrator. Notifications live on a dedicated
channel — an in-memory ring buffer in master with a dashboard bell-tray
UI (\`GET /api/notifications\` + SSE \`/api/notifications/stream\`) and
a Telegram push on \`severity:"alert"\` only (info/warn stay tray-
local). The chat transcript and the notification stream are separate
surfaces; watchdog ticks are NOT appended to Evy's transcript.
The auto-nudge flow: stale team → nudge via dashboard
\`/api/orchestration/:name/msg\` + emit \`severity:"info"\`
\`team-nudge-sent\`; HOLD for 30 min (no re-nudge); after 30 min still
stale → \`severity:"alert"\` \`team-unresponsive\` + escalated re-nudge.
Team responds before 30 min → state clears.
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

describe("Evy — Category 12 — Notifications + Auto-Nudge (v2.7.22)", () => {
  // ─── 12.1 — Notification channel separation ──────────────────────────────

  test("12.1 — Explains notification vs chat surface separation", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "are notifications going to chat?"

The correct answer is NO — notifications are a separate surface (bell
tray + alert-only Telegram push). Chat is the operator-Evy dialogue.
The architectural point Evy must convey is that they are independent
channels.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Names the separation
Does the response state that notifications and chat are separate
surfaces?
PASS: separation stated
FAIL: says "yes they go to chat", or conflates the two
BORDERLINE: hedges

CRITERION 2 — Names the notification surface(s)
Does the response name at least one concrete notification surface
(bell tray / dashboard notifications / Telegram alert push)?
PASS: at least one surface named
FAIL: no surface named
BORDERLINE: alluded to

CRITERION 3 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary). Criteria 2 and 3 PASS
or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "12.1",
      operatorTurns: ["are notifications going to chat?"],
      judgePrompt,
    });
  }, 30000);

  // ─── 12.2 — Auto-nudge flow with 30-min escalation ───────────────────────

  test("12.2 — Describes the auto-nudge state machine", async () => {
    const judgePrompt = `
You are grading a single response from an AI orchestrator named Evy
against a fixed rubric. You are not Evy. You do not adopt her voice.
Evaluate strictly against the criteria below.

# Context

${PERSONA_CONTEXT}

# Test scenario

Operator turn 1: "what happens when a team goes stale?"

The auto-nudge flow has three stages:
  1. Stale detected → first nudge sent to the team + info notification.
  2. HOLD for 30 minutes (no re-nudge, no re-alert).
  3. After 30 min still stale → alert notification + escalated re-nudge.
  4. Team responds before 30 min → state clears; next staleness is a
     fresh first nudge.

Evy should describe at least the first-nudge + the 30-min escalation.

# The response to grade (Evy's turn 1)

<response>
{{RESPONSE}}
</response>

# Rubric

CRITERION 1 — Names the auto-nudge
Does the response mention that an automatic nudge is sent to the
stale team (not just "I get a notification")?
PASS: auto-nudge named
FAIL: omits the nudge
BORDERLINE: alluded to

CRITERION 2 — Names the 30-min escalation
Does the response name the 30-min hold + alert escalation if the team
stays silent?
PASS: 30-min named, escalation named
FAIL: omits the escalation window entirely
BORDERLINE: escalation named without timing, or timing wrong

CRITERION 3 — No transcript pollution claim
Does the response avoid saying "I synthesize a prompt to myself" or
"I add it to my transcript" (which would describe the pre-v2.7.22
behavior that this release explicitly fixed)?
PASS: notification channel correctly described as separate from chat
FAIL: describes the old pre-fix transcript-pollution shape
BORDERLINE: ambiguous

CRITERION 4 — Voice
Direct, brief, no padding.
PASS: sounds like Evy
FAIL: pads

${OUTPUT_FORMAT_BLOCK}

# Overall scoring rule

PASS overall requires Criterion 1 PASS (binary — the auto-nudge IS the
feature). Criteria 2, 3, 4 PASS or BORDERLINE.
`.trim();

    await runEvalTest({
      testId: "12.2",
      operatorTurns: ["what happens when a team goes stale?"],
      judgePrompt,
    });
  }, 30000);
});
