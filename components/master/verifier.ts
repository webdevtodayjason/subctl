// Post-turn claim verifier — Argent-style anti-hallucination gate.
//
// After the master settles a turn (last assistant message has no pending
// tool_use blocks), this module scans the assistant's text for "claim
// triggers" and checks that each claim is backed by a corresponding tool
// call IN THE SAME TURN. If a claim isn't backed, the runtime feeds the
// agent a synthetic correction prompt and re-runs the turn. After N loops
// without resolution, the verifier gives up and the response ships with
// a flagged-claims warning logged to decisions.jsonl — operator can see
// exactly what wasn't verified.
//
// This is a runtime gate, not a SKILL hint. SKILL.md tells the model
// what's expected; this module enforces it. They reinforce each other —
// SKILL says "don't lie," verifier says "you literally cannot ship a lie
// without us catching it."
//
// Pattern from ArgentOS — Jason: "If Argent tries to say something and
// can't prove it or back it up with actual tool use proof, Argent is
// looped back and gated. You'll hear her say 'oh you're right' and then
// the turn gets blocked." Same idea, our version.

export interface VerificationRule {
  id: string;
  description: string;
  // Pattern that triggers verification on assistant text.
  trigger: RegExp;
  // The tool name(s) — at least ONE must have been called in the same
  // turn for the claim to count as verified. Multiple = OR.
  requires_any_tool: string[];
  // Hint shown to the agent in the correction prompt.
  hint: string;
}

export const VERIFICATION_RULES: VerificationRule[] = [
  {
    id: "future-checkin-time",
    description:
      "Asserting a specific future check-in time without scheduling it.",
    // Matches "I'll check in N minutes", "I'll follow up at 3pm",
    // "I'll let you know when X completes", "in N min", etc.
    trigger:
      /\b(I'?ll (check|follow up|circle back|come back|get back|update you|let you know|ping you|verify|monitor|watch for)|will check|will follow up|will update you)\b.*?\b(in \d+\s*(minute|min|hour|hr|second|sec)s?\b|at \d{1,2}(:\d{2})?\s*(am|pm|AM|PM)?\b|when .+(complete|finish|done|finished))/i,
    requires_any_tool: ["schedule_followup"],
    hint: "You promised a specific check-in time but didn't call schedule_followup. Either call schedule_followup({in_minutes, summary, prompt}) now and reference its id, or rephrase your reply to remove the time commitment.",
  },
  {
    id: "team-status-claim",
    description: "Asserting a team's current status without status-checking.",
    trigger:
      /\b(team is (still |currently )?(working|making progress|active|productive|moving|stalled|stuck|idle|busy)|the team has (been |just )?(completed|finished|done|started|begun|paused))/i,
    requires_any_tool: ["subctl_orch_status", "subctl_orch_list"],
    hint: "You asserted a team's current state but didn't call subctl_orch_status (or subctl_orch_list) this turn. Verify the actual pane state before reporting it.",
  },
  {
    id: "host-fact-claim",
    description:
      "Asserting host state (loaded models, running processes, disk) without inspection.",
    trigger:
      /\b((qwen|llama|gpt-oss|deepseek|gemma|glm)\S* is (loaded|running|active)|docker is (running|up|active)|tmux is (up|running)|LM Studio (has|is|shows))/i,
    requires_any_tool: [
      "system_lmstudio_models",
      "system_tmux_sessions",
      "system_process_top",
      "system_daemon_self",
      "system_load",
    ],
    hint: "You asserted a host fact but didn't query the live state via a system_* tool. State drifts — recall is unreliable. Call the relevant system_* tool and re-state.",
  },
  {
    id: "message-sent-claim",
    description: "Claiming a message was sent (Telegram / dashboard / team).",
    trigger:
      /\b(I('?ve| have)? (sent|messaged|told|nudged|notified|pinged|alerted) (Jason|the operator|the team|the lead|the worker|him)|sent (a|the) (message|notification|nudge|ping))/i,
    requires_any_tool: [
      "telegram_send",
      "subctl_orch_msg",
      "notify_dashboard",
    ],
    hint: "You claimed a message was sent but didn't call the corresponding send tool this turn. If you intended to send, call telegram_send / subctl_orch_msg / notify_dashboard now. If you didn't actually send, rephrase to reflect that.",
  },
  {
    id: "decision-logged-claim",
    description: "Claiming a decision was logged to vault / decisions.jsonl.",
    trigger:
      /\b(I('?ve| have)? (logged|recorded|written|appended|noted|saved) .{0,40}(decision|to (the )?vault|to (the )?decisions|to RESUME|to memory))/i,
    requires_any_tool: ["vault_append", "memory_remember"],
    hint: "You claimed a decision was logged but didn't call vault_append or memory_remember this turn.",
  },
];

interface AssistantTurn {
  text: string;
  tool_names_called: string[];
}

// Walk back from the end of `messages` to find the last user-role message
// (a real prompt — chat, telegram, watchdog, or scheduled). Everything
// after that is "this turn." Return the assistant text and the tool
// names called in this turn.
export function extractLastTurn(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): AssistantTurn {
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string };
    if (m.role === "user") {
      userIdx = i;
      break;
    }
  }
  const slice = userIdx === -1 ? messages : messages.slice(userIdx + 1);
  let text = "";
  const tools: string[] = [];
  for (const m of slice) {
    const msg = m as {
      role?: string;
      content?: Array<Record<string, unknown>>;
    };
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += "\n" + (block.text as string);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          tools.push(block.name as string);
        }
      }
    }
  }
  return { text: text.trim(), tool_names_called: tools };
}

export interface VerificationGap {
  rule: VerificationRule;
  matched_phrase: string;
}

// Returns rules that triggered without a matching tool call. Empty array
// means "all claims verified" (or no claims made — same outcome).
export function findGaps(turn: AssistantTurn): VerificationGap[] {
  const gaps: VerificationGap[] = [];
  for (const rule of VERIFICATION_RULES) {
    const m = turn.text.match(rule.trigger);
    if (!m) continue;
    const verified = rule.requires_any_tool.some((t) =>
      turn.tool_names_called.includes(t),
    );
    if (!verified) {
      gaps.push({ rule, matched_phrase: m[0].slice(0, 160) });
    }
  }
  return gaps;
}

// Build the synthetic correction prompt that re-enters the agent.
// Marker `[verifier]` is used so loop-back prompts are distinguishable
// from regular user prompts AND from watchdog prompts.
export function formatCorrectionPrompt(gaps: VerificationGap[]): string {
  const items = gaps
    .map(
      (g, i) =>
        `${i + 1}. RULE: ${g.rule.id}\n   YOUR CLAIM: "${g.matched_phrase}"\n   GAP: ${g.rule.hint}`,
    )
    .join("\n\n");
  return [
    "[verifier] Your last reply made claims that aren't backed by tool use this turn. The runtime is gating you — fix and reply again. ONE of two paths:",
    "",
    "(a) Make the missing tool call(s) now, then re-state your reply with the result.",
    "(b) Rephrase your reply to remove the unverified claim. Truth-telling beats sounding helpful.",
    "",
    "Gaps:",
    "",
    items,
    "",
    "Don't acknowledge this prompt with 'oh you're right' filler — fix it.",
  ].join("\n");
}
