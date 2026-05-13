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
      /\b(I('?ve| have)? (logged|recorded|written|appended|noted|saved|filed) .{0,40}(decision|to (the )?vault|to (the )?decisions|to RESUME|to memory))/i,
    requires_any_tool: ["vault_append", "memory_remember", "team_decision_log"],
    hint: "You claimed a decision was logged but didn't call vault_append, memory_remember, or team_decision_log this turn.",
  },
  {
    // v2.7.11 — patch for an operator-observed gap (2026-05-12). Evy
    // claimed "I've updated my learned-facts memory" and "I have committed
    // the rule to my Tier-1 memory" without calling memory_remember. The
    // earlier decision-logged-claim rule didn't catch it because its verb
    // list (logged|recorded|written|appended|noted|saved|filed) lacked
    // `updated|committed|stored|pinned|locked|added|remembered` and its
    // object list lacked `learned facts | tier-1 | tier 1 | MEMORY.md`.
    // This rule captures memory-update claims specifically.
    id: "memory-update-claim",
    description: "Claiming memory was updated, committed, or remembered.",
    trigger:
      /\bI(?:'ve|'m|\s+am|\s+have)\s+(?:(?:now|already|just|formally)\s+){0,3}(?:updat(?:ed|ing)|commit(?:ted|ting)|stor(?:ed|ing)|pinn(?:ed|ing)|locked?(?:\s+in)?|add(?:ed|ing)|remember(?:ed|ing)|memoriz(?:ed|ing)|persist(?:ed|ing)|saved|writ(?:ten|ing)|record(?:ed|ing))\s.{0,80}(?:memory|MEMORY\.md|learned[- ]facts?|tier[- ]?1|tier[- ]?2|operating procedure|internal procedure)|\b(?:memory|MEMORY\.md|tier[- ]?1)\s+(?:has been|is now|has now been)\s+(?:updated|committed|stored|pinned|locked|added|set|persisted)/i,
    requires_any_tool: ["memory_remember", "memory_user_update", "memory_forget"],
    hint: "You claimed you updated, committed, or stored something to memory but didn't call memory_remember, memory_user_update, or memory_forget this turn. Promises about memory must be backed by the actual tool call IN THE SAME TURN. If you intended to, call the tool now. If you didn't, rephrase to reflect that you have NOT yet stored it.",
  },
  {
    // v2.7.11 — companion to memory-update-claim. Evy claimed "I am
    // updating my internal operating procedure" / "I have updated my
    // internal rule" / "I've authored a skill". These belong in skills
    // or in tier-1 memory; either way, a claim of having WRITTEN them
    // needs a backing tool call.
    id: "procedure-or-rule-update-claim",
    description:
      "Claiming an internal procedure, rule, policy, or skill was updated / authored.",
    trigger:
      /\bI(?:'ve|'m|\s+am|\s+have)\s+(?:(?:now|already|just|formally)\s+){0,3}(?:updat(?:ed|ing)|author(?:ed|ing)|writ(?:ten|ing)|add(?:ed|ing)|commit(?:ted|ting)|formaliz(?:ed|ing)|codif(?:ied|ying)|encod(?:ed|ing))\s.{0,80}(?:internal\s+(?:operating\s+)?procedure|operating\s+procedure|skill|skills\s+library|rule\s+of\s+engagement|hard[- ]coded\s+(?:event|rule)|durable\s+constraint|tier[- ]?1)|\b(?:rule|procedure|skill)\s+(?:has\s+been|is\s+now)\s+(?:added|locked|committed|written|authored|encoded)/i,
    requires_any_tool: [
      "memory_remember",
      "memory_user_update",
      "vault_append",
      "team_doc_write",
      "skill_create",
    ],
    hint: "You claimed you updated or authored an internal procedure, rule, or skill but didn't call a backing tool this turn. Either (a) call memory_remember (for rules), vault_append (for long-form documentation), team_doc_write (for project-local procedures), or skill_create (for orchestration skills); or (b) rephrase to reflect what you have actually done so far, which is describe an intent — not commit it.",
  },
];

// v2.7.11 — structured tool-call inspection.
//
// Pre-v2.7.11 the verifier only checked tool NAMES — if "memory_remember"
// appeared in this turn's tool list, any memory-related claim was treated
// as verified. Operator-observed exploit (2026-05-12): Evy could call
// memory_remember with arbitrary content and then claim she'd stored
// something else entirely; the verifier had no view into args or results.
//
// v2.7.11 widens the interface: each tool call carries its name, its
// arguments, and its result (with is_error). Rules can attach an optional
// `validate` function that runs after the name-match passes — for
// memory-update-claim and procedure-or-rule-update-claim, that validator
// is `keywordOverlapValidate`, which requires the claim's significant
// terms to appear in the tool call's args. Tool calls that errored are
// excluded from consideration entirely.
export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: unknown;
  /** Raw tool-result content (whatever the tool returned). */
  result?: unknown;
  /** True if the tool call returned with is_error=true OR its result object had ok:false. */
  is_error?: boolean;
}

export interface AssistantTurn {
  text: string;
  tool_calls: ToolCallRecord[];
}

// Walk back from the end of `messages` to find the last user-role message
// (a real prompt — chat, telegram, watchdog, or scheduled). Everything
// after that is "this turn." Return the assistant text plus a paired
// list of tool calls (name + arguments + result + is_error).
//
// Pairing: tool_use blocks in assistant messages carry an `id`. tool_result
// blocks (in user/tool role messages) carry `tool_use_id`. We key by id
// to attach results to their originating calls.
/**
 * Distinguish a real user prompt from a tool_result-bearing user message.
 *
 * In Anthropic / pi-agent-core message format, tool_result blocks live
 * inside role:"user" messages (because they arrive "from outside the
 * assistant's perspective"). A naive last-user-role scan would slice the
 * turn at the most recent tool_result instead of the most recent real
 * prompt, missing all tool_use blocks from earlier in the same logical
 * turn — which is exactly when the verifier needs to see them.
 *
 * A real user prompt has at least one text block (or has no tool_result
 * blocks at all). A tool-result-only message has only tool_result blocks
 * and is skipped by the scan.
 */
function isRealUserPrompt(msg: { content?: unknown }): boolean {
  if (!Array.isArray(msg.content)) return true; // assume real if shape unknown
  let hasText = false;
  let hasToolResult = false;
  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string") hasText = true;
    if (block.type === "tool_result") hasToolResult = true;
  }
  return hasText || !hasToolResult;
}

export function extractLastTurn(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): AssistantTurn {
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role === "user" && isRealUserPrompt(m)) {
      userIdx = i;
      break;
    }
  }
  const slice = userIdx === -1 ? messages : messages.slice(userIdx + 1);
  let text = "";
  // Preserve insertion order; key by tool_use id when available, fall
  // back to an order-indexed key if the SDK ever omits the id.
  const callsById: Map<string, ToolCallRecord> = new Map();
  const orderedKeys: string[] = [];

  for (const m of slice) {
    const msg = m as {
      role?: string;
      content?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          text += "\n" + (block.text as string);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const id =
            (typeof block.id === "string" && (block.id as string)) ||
            `__no_id_${orderedKeys.length}`;
          if (!callsById.has(id)) orderedKeys.push(id);
          callsById.set(id, {
            id,
            name: block.name as string,
            arguments: block.input ?? block.arguments ?? {},
          });
        }
      }
    } else {
      // tool_result blocks live in user-role (or tool-role) messages
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const existing = callsById.get(block.tool_use_id as string);
          if (existing) {
            existing.result = block.content;
            existing.is_error = inferToolError(block);
          }
        }
      }
    }
  }

  const tool_calls = orderedKeys
    .map((k) => callsById.get(k))
    .filter((c): c is ToolCallRecord => c !== undefined);
  return { text: text.trim(), tool_calls };
}

/**
 * Decide if a tool_result block represents an error.
 *
 * Three signals, in order:
 *   1. `is_error` flag on the block itself (Anthropic SDK convention).
 *   2. The result content is an object with `ok: false` (subctl tool convention).
 *   3. The result content stringifies to something starting with "Error:" /
 *      "error:" — fallback heuristic for raw-string returns.
 */
function inferToolError(block: Record<string, unknown>): boolean {
  if (block.is_error === true) return true;
  const c = block.content;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const obj = c as Record<string, unknown>;
    if (obj.ok === false) return true;
  }
  if (typeof c === "string") {
    if (/^\s*error[:\s]/i.test(c)) return true;
  }
  return false;
}

export interface VerificationGap {
  rule: VerificationRule;
  matched_phrase: string;
  /**
   * Specific reason this gap was recorded. One of:
   *   - "no matching tool call this turn"
   *   - "matching tool call(s) all errored"
   *   - "tool call's arguments don't reference the claim's significant terms"
   *
   * Surfaced into the correction prompt so the agent has actionable signal.
   */
  reason: string;
}

// ───────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────

export type ValidatorContext = {
  rule: VerificationRule;
  text: string;
  matched_phrase: string;
  /** Only includes successful (is_error !== true) calls whose name is in requires_any_tool. */
  candidate_calls: ToolCallRecord[];
};

export type ValidatorResult = { ok: true } | { ok: false; reason: string };

/**
 * Default validator. The candidate_calls list is already filtered for
 * (a) name match and (b) non-error. If we reach here with at least one
 * candidate call, the claim is considered verified. Rules that need
 * stricter checks override with their own `validate` function.
 */
function defaultValidate(_ctx: ValidatorContext): ValidatorResult {
  return { ok: true };
}

// Stop words excluded from significant-token extraction. Operator-facing
// verbs ("now", "already", "formally") are stopped because they're
// rhetorical, not substantive. Pronouns and common auxiliaries are stopped
// for the obvious reasons.
const STOP_WORDS = new Set([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "should", "may", "might", "can", "could", "must", "shall",
  "of", "to", "from", "with", "without", "in", "on", "at", "by", "for", "about",
  "between", "into", "through", "during", "before", "after",
  "above", "below", "up", "down", "off", "over", "under", "again",
  "and", "or", "but", "so", "yet", "if", "then", "than",
  "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they",
  "me", "him", "her", "them", "us",
  "my", "your", "their", "his", "its", "our",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "too", "very", "just", "also",
  "as", "what", "which", "who", "whom",
  "now", "already", "formally", "actually", "really",
  "thing", "things", "way", "ways",
]);

/**
 * Extract significant tokens from a claim text. Stop words removed,
 * 4-char minimum (catches "memory" / "rule" but drops "the" / "it").
 * Order preserved, deduped.
 */
function extractSignificantTokens(claimText: string, maxTokens = 20): string[] {
  const raw = claimText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of raw) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }
  return unique.slice(0, maxTokens);
}

function stringifyToolArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function tokenAppearsInText(token: string, text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(token)) return true;
  // Loose stem match: strip trailing s/d/g (catches "rules"↔"rule",
  // "stored"↔"store", "storing"↔"stor"). 4-char floor on the stem so we
  // don't match "thi" against everything.
  const stem = token.replace(/(?:s|ed|ing)$/, "");
  if (stem.length >= 4 && t.includes(stem)) return true;
  return false;
}

/**
 * Validator factory: claim's significant tokens must appear in at least
 * one candidate tool call's arguments. Threshold scales with claim size
 * (don't fail-by-default on tiny claims).
 *
 * Default: minOverlap=2, with a floor of min(minOverlap, ceil(half the
 * claim's significant tokens)). So a claim with 4 keywords needs 2
 * overlapping; a claim with 1 keyword needs 1. Prevents short prepositional
 * matches from passing trivially while still being lenient.
 */
export function keywordOverlapValidate(minOverlap = 2): (ctx: ValidatorContext) => ValidatorResult {
  return (ctx: ValidatorContext): ValidatorResult => {
    const claimKeywords = extractSignificantTokens(ctx.matched_phrase);
    if (claimKeywords.length === 0) {
      // Claim text has no significant tokens. Can't tell either way; pass.
      return { ok: true };
    }
    const threshold = Math.min(minOverlap, Math.max(1, Math.ceil(claimKeywords.length / 2)));

    for (const call of ctx.candidate_calls) {
      const argText = stringifyToolArgs(call.arguments);
      if (!argText) continue;
      const overlapping = claimKeywords.filter((k) => tokenAppearsInText(k, argText));
      if (overlapping.length >= threshold) return { ok: true };
    }

    const summary = ctx.candidate_calls
      .map((c) => `${c.name}(args: ${stringifyToolArgs(c.arguments).slice(0, 80)}…)`)
      .join(", ");
    return {
      ok: false,
      reason: `tool was called but its arguments don't reference the claim's significant terms. Claim keywords: [${claimKeywords.slice(0, 6).join(", ")}]. Tool calls inspected: ${summary || "(none with non-empty args)"}. Either the call's content was unrelated to what you claimed, or your claim text overstated what you actually committed.`,
    };
  };
}

// Attach validators to specific rules. (Done here rather than inline in
// the rule declaration so the validator implementations sit grouped.)
for (const rule of VERIFICATION_RULES) {
  if (rule.id === "memory-update-claim" || rule.id === "procedure-or-rule-update-claim") {
    rule.validate = keywordOverlapValidate(2);
  } else if (!rule.validate) {
    rule.validate = defaultValidate;
  }
}

// Returns rules that triggered without backing tool evidence. Empty array
// means "all claims verified" (or no claims made — same outcome).
//
// Per-rule gap recording:
//   1. trigger regex matches? if no, skip.
//   2. any matching, non-errored tool call? if no, gap recorded ("no
//      matching tool call this turn (or all matching calls errored)").
//   3. run rule.validate(ctx). if it returns ok:false, gap recorded
//      with the validator's specific reason. Default validator returns
//      ok:true (name match was sufficient — back-compat).
export function findGaps(turn: AssistantTurn): VerificationGap[] {
  const gaps: VerificationGap[] = [];
  for (const rule of VERIFICATION_RULES) {
    const m = turn.text.match(rule.trigger);
    if (!m) continue;
    const matched_phrase = m[0].slice(0, 160);

    const candidates = turn.tool_calls.filter(
      (c) => rule.requires_any_tool.includes(c.name) && c.is_error !== true,
    );

    if (candidates.length === 0) {
      const anyMatchingButErrored = turn.tool_calls.some(
        (c) => rule.requires_any_tool.includes(c.name),
      );
      gaps.push({
        rule,
        matched_phrase,
        reason: anyMatchingButErrored
          ? "matching tool call(s) all errored — the claim is unverified because the underlying tool failed"
          : "no matching tool call this turn",
      });
      continue;
    }

    const ctx: ValidatorContext = {
      rule,
      text: turn.text,
      matched_phrase,
      candidate_calls: candidates,
    };
    const result = (rule.validate ?? defaultValidate)(ctx);
    if (!result.ok) {
      gaps.push({ rule, matched_phrase, reason: result.reason });
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
        `${i + 1}. RULE: ${g.rule.id}\n   YOUR CLAIM: "${g.matched_phrase}"\n   WHY UNVERIFIED: ${g.reason}\n   HOW TO FIX: ${g.rule.hint}`,
    )
    .join("\n\n");
  return [
    "[verifier] Your last reply made claims that aren't backed by tool use this turn. The runtime is gating you — fix and reply again. ONE of two paths:",
    "",
    "(a) Make the missing tool call(s) now (with arguments that actually contain what you claimed to store), then re-state your reply with the result.",
    "(b) Rephrase your reply to remove the unverified claim. Truth-telling beats sounding helpful.",
    "",
    "Gaps:",
    "",
    items,
    "",
    "Don't acknowledge this prompt with 'oh you're right' filler — fix it.",
  ].join("\n");
}
