// components/evy/compression-compactor.ts
//
// v3.3.6 — LLM-driven summariser for the Hermes-aligned compaction path.
//
// Companion to `compression-policy.ts`. While the policy module decides
// WHEN to compact (Hermes formula: `max(0.5×ctx, 64K)`), this module
// implements the HOW: a four-phase compaction that mirrors Hermes' shape
// from `agent/context_compressor.py:1495-1516`:
//
//   Phase 1 — Pre-pass tool-result pruning (no LLM). Replace old tool
//             outputs with one-line summaries. Cheap.
//   Phase 2 — Boundary detection. Protect head (first N messages) + tail
//             (token-budgeted recent window).
//   Phase 3 — LLM summarisation. Send the middle turns to a cheap
//             auxiliary model with a structured prompt.
//   Phase 4 — Assemble. Compressed list = head + summary message + tail.
//
// The module is deliberately pure: zero `agent.state` mutation, zero fs,
// zero network. The caller (`server.ts`) decides what to do with the
// compacted list (replace agent.state.messages, write the archive, etc.).
//
// The llmFetcher contract matches `memory-kernel-reviewer.ts` so the
// existing supervisor-resolution wiring in `server.ts` can be reused.

import {
  type LlmMessage,
  type LlmFetcherOpts,
} from "./memory-kernel-reviewer";

/**
 * Minimal message shape this module operates on. Same union as
 * `compactTranscriptInline` uses but typed for testability.
 */
export interface CompactableMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [k: string]: unknown;
}

export interface CompressionDeps {
  /** Dispatch the cheap-model summariser call. Same shape as the kernel reviewer's fetcher. */
  llmFetcher: (messages: LlmMessage[], opts: LlmFetcherOpts) => Promise<string>;
  /** Auxiliary model selection. Hermes uses a CHEAP model — Codex/gpt-5.5 surplus, LM Studio local, or a small remote tier. */
  auxiliaryModel: () => { provider: string; model: string; baseUrl?: string };
  /** Token estimator — char/4 if you have nothing better. */
  estimateTokens: (messages: ReadonlyArray<CompactableMessage>) => number;
}

export interface CompressionOptions {
  /** Hermes `compression.protect_first_n`. Default 3. */
  protect_first_n?: number;
  /** Hermes `compression.protect_last_n`. Default 20. */
  protect_last_n?: number;
  /** Hermes `compression.target_ratio` × threshold = tail budget. Default 0.20. */
  target_ratio?: number;
  /** Computed threshold from `compression-policy.computeThresholdTokens`. */
  threshold_tokens: number;
  /** Abort the LLM summariser if it takes too long. Default no abort. */
  signal?: AbortSignal;
  /** Hermes `compression.abort_on_summary_failure`. Default false (insert placeholder on LLM failure). */
  abort_on_summary_failure?: boolean;
}

export interface CompressionResult {
  ok: boolean;
  /** Final compacted message list (head + summary + tail). */
  messages: CompactableMessage[];
  /** Number of middle messages collapsed into the summary. */
  collapsed_count: number;
  /** Number of head messages preserved. */
  head_count: number;
  /** Number of tail messages preserved. */
  tail_count: number;
  /** Token estimate of the compacted list (caller can verify reduction). */
  final_tokens: number;
  /** True iff the LLM summariser was invoked (false on noop / abort). */
  llm_invoked: boolean;
  /** Optional error string when ok=false. */
  error?: string;
  /** Diagnostic notes (e.g. "tool-result pre-pass dropped 12 messages"). */
  notes: string[];
}

/**
 * Phase 1 — Pre-pass tool-result pruning, no LLM.
 *
 * For every `toolResult` block in the head/middle of the transcript whose
 * sibling `toolCall` is older than the tail window, replace the result
 * content with a one-line summary. Hermes does this at
 * `agent/context_compressor.py:640+` via `_prune_old_tool_results`.
 *
 * Returns a NEW message array; original input is not mutated.
 */
export function prePassPruneToolResults(
  messages: ReadonlyArray<CompactableMessage>,
  tailIndex: number,
): { pruned: CompactableMessage[]; droppedCount: number } {
  let dropped = 0;
  const out: CompactableMessage[] = messages.map((m, idx) => {
    if (idx >= tailIndex) return { ...m };
    const content = m.content;
    if (!Array.isArray(content)) return { ...m };
    const newContent: unknown[] = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type === "toolResult") {
        // Skip already-pruned results to avoid double-pruning when the
        // same tool result spans multiple compaction cycles. Heuristic:
        // a previously-pruned result is a small array containing one
        // text block with the "output elided" sentinel.
        if (
          Array.isArray(b.content) &&
          (b.content as Array<Record<string, unknown>>).length === 1 &&
          typeof (b.content as Array<Record<string, unknown>>)[0]?.text ===
            "string" &&
          ((b.content as Array<Record<string, unknown>>)[0]?.text as string)
            .includes("output elided")
        ) {
          return block;
        }
        // Replace verbose tool result with one-line summary
        const toolName = typeof b.toolName === "string" ? b.toolName : "tool";
        const status =
          typeof b.is_error === "boolean" && b.is_error ? "error" : "ok";
        let approxBytes = 0;
        try {
          approxBytes = JSON.stringify(b.content ?? "").length;
        } catch {
          /* skip non-serializable */
        }
        dropped++;
        return {
          type: "toolResult",
          toolName: b.toolName,
          tool_use_id: b.tool_use_id,
          content: [
            {
              type: "text",
              text: `[${toolName}] ${status} — output elided (${approxBytes} bytes, compacted)`,
            },
          ],
        };
      }
      // Hermes also strips image parts from old multimodal messages
      // (`_strip_image_parts_from_parts`); same idea here:
      if (b.type === "image" || b.type === "image_url") {
        return { type: "text", text: "[screenshot removed to save context]" };
      }
      return block;
    });
    return { ...m, content: newContent };
  });
  return { pruned: out, droppedCount: dropped };
}

/**
 * Phase 2 — Find the tail boundary by TOKEN BUDGET rather than message
 * count. Matches Hermes' `_find_tail_cut_by_tokens`
 * (`agent/context_compressor.py:1413+`).
 *
 * Walks backwards from the end of `messages`, accumulating token estimate
 * until either the budget is exhausted or `protect_last_n` is reached
 * (whichever is LARGER — i.e. tail is at minimum N messages even when
 * they're tiny). Returns the index that marks the START of the tail.
 */
export function findTailCutByTokens(
  messages: ReadonlyArray<CompactableMessage>,
  budgetTokens: number,
  protectLastN: number,
  estimateTokens: (m: ReadonlyArray<CompactableMessage>) => number,
): number {
  if (messages.length === 0) return 0;
  let tailStart = messages.length;
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const oneTokens = estimateTokens([messages[i] as CompactableMessage]);
    if (
      acc + oneTokens > budgetTokens &&
      messages.length - tailStart >= protectLastN
    ) {
      break;
    }
    acc += oneTokens;
    tailStart = i;
  }
  return tailStart;
}

/**
 * Build the structured prompt that goes to the auxiliary summariser model.
 * Hermes' template lives at `agent/context_compressor.py:946-1090+` and
 * uses the following sections (verbatim):
 *
 *   ## Active Task
 *   ## Goal
 *   ## Constraints & Preferences
 *   ## Completed Actions
 *   ## Active State
 *   ## In Progress
 *
 * Plus resolved/pending questions and remaining work. v3.3.6 ships a
 * trimmed version of that template — same sections, same sentinel words
 * so a Hermes-trained operator's eye recognises the output, but adapted
 * for v3 Evy's supervisor flavour.
 */
export function buildSummariserPrompt(
  middleTurns: ReadonlyArray<CompactableMessage>,
  priorSummary: string | null,
): LlmMessage[] {
  const middleText = middleTurns
    .map((m) => {
      const role = m.role ?? "unknown";
      const content = m.content;
      if (!Array.isArray(content)) return `[${role}] (non-text content)`;
      const parts = (content as Array<Record<string, unknown>>)
        .map((b) => {
          if (typeof b.text === "string") return b.text;
          if (typeof b.thinking === "string") return `[thinking] ${b.thinking}`;
          if (b.type === "toolCall" && typeof b.name === "string") {
            return `[toolCall ${b.name}]`;
          }
          if (b.type === "toolResult") {
            const inner = Array.isArray(b.content)
              ? (b.content as Array<Record<string, unknown>>)
                  .map((c) => (typeof c.text === "string" ? c.text : ""))
                  .join("")
              : "";
            return `[toolResult] ${inner}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `## ${role}\n${parts}`.trim();
    })
    .join("\n\n---\n\n");

  const systemPrompt = `You are an aggressive but faithful conversation summariser for the Evy supervisor daemon. Your job is to compress a span of prior dialogue (between the operator and the assistant) into a single structured summary that preserves enough state for the assistant to continue without re-asking what was already decided.

OUTPUT FORMAT (use these section headers verbatim, omit a section only if empty):

## Active Task
(What is being worked on right now — one sentence.)

## Goal
(What "done" looks like — one or two sentences.)

## Constraints & Preferences
(Bulleted list of operator-stated rules, do/don't, naming conventions, performance budgets, etc.)

## Completed Actions
(Bulleted list of concrete things finished — code shipped, files written, commands run successfully.)

## Active State
(What the system / repo / fleet looks like RIGHT NOW — current branch, current version, what's deployed, what's running.)

## In Progress
(Bulleted list of started-but-not-finished work, with current state per item.)

## Resolved Questions
(Bulleted list of questions the operator already answered — keep the answer, not the question.)

## Pending Questions
(Bulleted list of questions waiting on the operator.)

## Remaining Work
(Ordered list of what still needs to happen.)

DON'T:
- Don't quote large blocks of code or tool output. Reference, don't reproduce.
- Don't include error messages verbatim. Summarise: "deploy failed: missing env var X".
- Don't introduce facts not present in the dialogue.
- Don't apologise or hedge. The summary is read by the assistant, not the operator.`;

  const userPrompt = priorSummary
    ? `Here is the PRIOR summary from an earlier compaction. UPDATE it with the new dialogue below (don't summarise from scratch — refine and extend the existing structure).

---PRIOR SUMMARY---
${priorSummary}
---END PRIOR SUMMARY---

---NEW DIALOGUE TO FOLD IN---
${middleText}
---END NEW DIALOGUE---`
    : `Summarise the following dialogue per the format above. This is the FIRST summary for this conversation.

---DIALOGUE---
${middleText}
---END DIALOGUE---`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

const SUMMARY_PREFIX =
  "[compacted on " +
  "${ts}" +
  " — earlier dialogue summarised below; the full transcript is archived on disk. The summary is REFERENCE ONLY: any project files, CLAUDE.md, or memory documents named in the system prompt remain authoritative.]";

/**
 * Main compaction orchestrator. Pure: takes messages in, returns the new
 * list. No fs / no broadcasts / no agent.state mutation.
 *
 * Returns `result.ok=false` only on Phase-3 LLM failure when
 * `abort_on_summary_failure=true`. Otherwise always returns ok=true with
 * a result that the caller is free to drop in place of the original.
 *
 * The Hermes "anti-thrash" guard
 * (`agent/context_compressor.py:614-634` — last two compressions saved
 * <10%) is NOT in v3.3.6 because there's no compression-history record
 * yet. Easy follow-up if the operator hits thrash.
 */
export async function compressTranscript(
  messages: ReadonlyArray<CompactableMessage>,
  opts: CompressionOptions,
  deps: CompressionDeps,
  priorSummary: string | null = null,
): Promise<CompressionResult> {
  const notes: string[] = [];
  const protectFirstN = opts.protect_first_n ?? 3;
  const protectLastN = opts.protect_last_n ?? 20;
  const targetRatio = opts.target_ratio ?? 0.20;
  const tailBudget = Math.max(2_000, Math.floor(opts.threshold_tokens * targetRatio));

  if (messages.length <= protectFirstN + protectLastN + 1) {
    notes.push(
      `noop: only ${messages.length} messages, below protect_first_n(${protectFirstN}) + protect_last_n(${protectLastN}) + 1`,
    );
    return {
      ok: true,
      messages: messages.map((m) => ({ ...m })),
      collapsed_count: 0,
      head_count: Math.min(messages.length, protectFirstN),
      tail_count: Math.max(0, messages.length - protectFirstN),
      final_tokens: deps.estimateTokens(messages),
      llm_invoked: false,
      notes,
    };
  }

  // Phase 2 (first — we need the tail boundary to know the pre-pass window)
  const tailStart = findTailCutByTokens(
    messages,
    tailBudget,
    protectLastN,
    deps.estimateTokens,
  );
  notes.push(
    `tail boundary at index ${tailStart} (budget ${tailBudget} tok, protect_last_n ${protectLastN})`,
  );

  // Phase 1 — Pre-pass tool-result pruning over the head+middle (everything before tail)
  const { pruned, droppedCount } = prePassPruneToolResults(messages, tailStart);
  notes.push(`pre-pass: pruned ${droppedCount} tool-result block(s)`);

  // Phase 3 — LLM summarisation
  const head = pruned.slice(0, protectFirstN);
  const middle = pruned.slice(protectFirstN, tailStart);
  const tail = pruned.slice(tailStart);

  if (middle.length === 0) {
    notes.push(`noop: no middle turns to summarise after boundary detection`);
    return {
      ok: true,
      messages: [...head, ...tail],
      collapsed_count: 0,
      head_count: head.length,
      tail_count: tail.length,
      final_tokens: deps.estimateTokens([...head, ...tail]),
      llm_invoked: false,
      notes,
    };
  }

  const summariserMsgs = buildSummariserPrompt(middle, priorSummary);
  const auxModel = deps.auxiliaryModel();
  let summaryText: string;
  let llmInvoked = true;
  try {
    summaryText = await deps.llmFetcher(summariserMsgs, {
      provider: auxModel.provider,
      model: auxModel.model,
      baseUrl: auxModel.baseUrl,
      max_tokens: 4096,
      temperature: 0.2,
      signal: opts.signal,
    });
    if (!summaryText || summaryText.trim().length < 10) {
      throw new Error(
        `auxiliary summariser returned empty/short response (${summaryText.length} chars)`,
      );
    }
    notes.push(
      `LLM summariser ok via ${auxModel.provider}/${auxModel.model}: ${summaryText.length} chars`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`LLM summariser FAILED: ${msg}`);
    if (opts.abort_on_summary_failure) {
      return {
        ok: false,
        messages: messages.map((m) => ({ ...m })),
        collapsed_count: 0,
        head_count: head.length,
        tail_count: tail.length,
        final_tokens: deps.estimateTokens(messages),
        llm_invoked: false,
        error: msg,
        notes,
      };
    }
    // Hermes fallback: insert a static placeholder so the conversation
    // can continue. Operator sees compact_warning event tagged with
    // error reason and can act if needed.
    summaryText = `[compaction summariser failed (${msg}). ${middle.length} middle turns dropped from active context but archived on disk. Continue the conversation; refer to the archive if you need the dropped detail.]`;
    llmInvoked = false;
  }

  // Phase 4 — Assemble
  const ts = new Date().toISOString();
  const prefixed = SUMMARY_PREFIX.replace("${ts}", ts) + "\n\n" + summaryText;
  // Pick a role that avoids same-role collision with neighbours. Hermes
  // does this at `agent/context_compressor.py:1663-1683`. Conservative
  // default: `user` (since the tail's first message is often `assistant`
  // and the head's last message is often `assistant` too).
  const lastHeadRole = head[head.length - 1]?.role ?? "user";
  const firstTailRole = tail[0]?.role ?? "user";
  const summaryRole =
    lastHeadRole === "user" || firstTailRole === "user"
      ? "user"
      : ("user" as const); // user always safe for v3 Evy supervisor surface

  const summaryMsg: CompactableMessage = {
    role: summaryRole,
    content: [{ type: "text", text: prefixed }],
    timestamp: Date.now(),
  };

  const finalMessages: CompactableMessage[] = [...head, summaryMsg, ...tail];
  return {
    ok: true,
    messages: finalMessages,
    collapsed_count: middle.length,
    head_count: head.length,
    tail_count: tail.length,
    final_tokens: deps.estimateTokens(finalMessages),
    llm_invoked: llmInvoked,
    notes,
  };
}
