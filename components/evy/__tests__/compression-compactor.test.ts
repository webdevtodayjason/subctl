// components/evy/__tests__/compression-compactor.test.ts
//
// v3.3.6 — tests for the Hermes-literal LLM-driven compactor module.
// Covers the four-phase compaction:
//   Phase 1 — pre-pass tool-result pruning (no LLM)
//   Phase 2 — boundary detection by token budget
//   Phase 3 — LLM summarisation
//   Phase 4 — assemble head + summary + tail
//
// Also covers the abort_on_summary_failure path and the integration test
// (synthetic transcript that crosses the threshold runs end-to-end).

import { describe, expect, test } from "bun:test";

import {
  buildSummariserPrompt,
  compressTranscript,
  findTailCutByTokens,
  prePassPruneToolResults,
  type CompactableMessage,
  type CompressionDeps,
} from "../compression-compactor";

// ---------------------------------------------------------------------------
// Test deps — deterministic mocks
// ---------------------------------------------------------------------------

function mockDeps(
  llmFetcher?: CompressionDeps["llmFetcher"],
): CompressionDeps {
  const defaultFetcher: CompressionDeps["llmFetcher"] = async () =>
    "## Active Task\nMock summary";
  return {
    llmFetcher: llmFetcher ?? defaultFetcher,
    auxiliaryModel: () => ({ provider: "mock", model: "mock-summariser" }),
    estimateTokens: (msgs) => {
      // char/4 heuristic
      let chars = 0;
      for (const m of msgs) {
        if (Array.isArray(m.content)) {
          for (const b of m.content as Array<Record<string, unknown>>) {
            if (typeof b?.text === "string") chars += b.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    },
  };
}

function textMsg(role: string, text: string): CompactableMessage {
  return { role, content: [{ type: "text", text }] };
}

function toolResultMsg(
  toolName: string,
  output: string,
): CompactableMessage {
  return {
    role: "tool",
    content: [{ type: "toolResult", toolName, content: output }],
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — pre-pass pruning
// ---------------------------------------------------------------------------

describe("prePassPruneToolResults (Phase 1)", () => {
  test("replaces old tool-result content with one-line summary", () => {
    const msgs: CompactableMessage[] = [
      textMsg("user", "hi"),
      toolResultMsg("npm-test", "x".repeat(5000)),
      textMsg("assistant", "tests passed"),
    ];
    // tailIndex=2 means everything before index 2 (head + middle) is pruned.
    const { pruned, droppedCount } = prePassPruneToolResults(msgs, 2);
    expect(droppedCount).toBe(1);
    // The old tool-result is now a 1-line summary nested one level down
    const prunedTool = pruned[1]?.content as Array<Record<string, unknown>>;
    const prunedToolContent = prunedTool?.[0]?.content as Array<
      Record<string, unknown>
    >;
    const summary = (prunedToolContent?.[0]?.text as string) ?? "";
    expect(summary).toMatch(/npm-test/);
    expect(summary).toMatch(/output elided/);
    // Tail (index 2) is unchanged
    expect(pruned[2]?.content).toEqual([{ type: "text", text: "tests passed" }]);
  });

  test("preserves verbatim tool results in the tail", () => {
    const msgs: CompactableMessage[] = [
      textMsg("user", "hi"),
      toolResultMsg("npm-test", "y".repeat(5000)),
    ];
    // tailIndex=1 means index 0 is head, index 1 is tail
    const { pruned, droppedCount } = prePassPruneToolResults(msgs, 1);
    expect(droppedCount).toBe(0);
    const tail = pruned[1]?.content as Array<Record<string, unknown>>;
    expect(tail?.[0]?.content).toBe("y".repeat(5000));
  });

  test("strips image parts in old messages", () => {
    const msgs: CompactableMessage[] = [
      {
        role: "user",
        content: [{ type: "image", source: { data: "base64..." } }],
      },
      textMsg("assistant", "I see"),
    ];
    const { pruned } = prePassPruneToolResults(msgs, 1);
    const oldContent = pruned[0]?.content as Array<Record<string, unknown>>;
    expect(oldContent?.[0]?.type).toBe("text");
    expect(oldContent?.[0]?.text).toMatch(/screenshot removed/);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — tail boundary detection by token budget
// ---------------------------------------------------------------------------

describe("findTailCutByTokens (Phase 2)", () => {
  const deps = mockDeps();

  test("budget=0 → tail size = protect_last_n (minimum tail guarantee)", () => {
    const msgs: CompactableMessage[] = Array.from({ length: 50 }, (_, i) =>
      textMsg("user", `msg ${i} ${"x".repeat(100)}`),
    );
    const tailStart = findTailCutByTokens(msgs, 0, 20, deps.estimateTokens);
    expect(msgs.length - tailStart).toBe(20);
  });

  test("budget large enough for all msgs → tail starts at 0", () => {
    const msgs: CompactableMessage[] = Array.from({ length: 10 }, () =>
      textMsg("user", "tiny"),
    );
    const tailStart = findTailCutByTokens(
      msgs,
      1_000_000,
      0,
      deps.estimateTokens,
    );
    expect(tailStart).toBe(0);
  });

  test("respects protect_last_n even when budget is exhausted", () => {
    // 30 large msgs; budget 100 tokens; protect_last_n=10 → tail forced to 10
    const msgs: CompactableMessage[] = Array.from({ length: 30 }, () =>
      textMsg("user", "x".repeat(2000)),
    );
    const tailStart = findTailCutByTokens(msgs, 100, 10, deps.estimateTokens);
    expect(msgs.length - tailStart).toBeGreaterThanOrEqual(10);
  });

  test("empty messages → tailStart = 0", () => {
    expect(findTailCutByTokens([], 1000, 5, deps.estimateTokens)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — summariser prompt construction
// ---------------------------------------------------------------------------

describe("buildSummariserPrompt (Phase 3)", () => {
  test("first compaction (no priorSummary) → fresh-summary prompt", () => {
    const middle = [textMsg("user", "hello"), textMsg("assistant", "hi back")];
    const msgs = buildSummariserPrompt(middle, null);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toMatch(/Active Task/);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toMatch(/FIRST summary/);
    expect(msgs[1].content).toMatch(/hello/);
  });

  test("subsequent compaction (priorSummary present) → update-existing prompt", () => {
    const middle = [textMsg("user", "second turn")];
    const msgs = buildSummariserPrompt(middle, "## Active Task\nPrior task");
    expect(msgs[1].content).toMatch(/PRIOR SUMMARY/);
    expect(msgs[1].content).toMatch(/Prior task/);
    expect(msgs[1].content).toMatch(/NEW DIALOGUE/);
  });

  test("tool calls and tool results in dialogue are rendered into the prompt", () => {
    const middle: CompactableMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "git_status", arguments: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "toolResult", content: [{ type: "text", text: "clean" }] },
        ],
      },
    ];
    const msgs = buildSummariserPrompt(middle, null);
    expect(msgs[1].content).toMatch(/git_status/);
    expect(msgs[1].content).toMatch(/clean/);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — orchestrated compressTranscript
// ---------------------------------------------------------------------------

describe("compressTranscript — orchestration", () => {
  function bigTranscript(count: number, charsPerMsg: number): CompactableMessage[] {
    return Array.from({ length: count }, (_, i) =>
      textMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(charsPerMsg)),
    );
  }

  test("collapses middle into a single summary message", async () => {
    const msgs = bigTranscript(50, 2_000); // 50 × 2000 chars = 25K tokens
    let fetcherCalls = 0;
    const result = await compressTranscript(
      msgs,
      { threshold_tokens: 5_000, protect_first_n: 3, protect_last_n: 10 },
      mockDeps(async () => {
        fetcherCalls++;
        return "## Active Task\nMiddle was busy.";
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.llm_invoked).toBe(true);
    expect(fetcherCalls).toBe(1);
    expect(result.collapsed_count).toBeGreaterThan(0);
    // Final = head (3) + summary (1) + tail (≥10)
    expect(result.messages.length).toBe(result.head_count + 1 + result.tail_count);
    expect(result.final_tokens).toBeLessThan(result.collapsed_count * 500);
  });

  test("noop when transcript shorter than protect_first_n + protect_last_n + 1", async () => {
    const msgs = bigTranscript(5, 100);
    const result = await compressTranscript(
      msgs,
      { threshold_tokens: 1000, protect_first_n: 3, protect_last_n: 20 },
      mockDeps(),
    );
    expect(result.ok).toBe(true);
    expect(result.llm_invoked).toBe(false);
    expect(result.collapsed_count).toBe(0);
  });

  test("LLM failure with abort_on_summary_failure=true → ok=false, original messages returned", async () => {
    const msgs = bigTranscript(50, 2_000);
    const result = await compressTranscript(
      msgs,
      {
        threshold_tokens: 5_000,
        protect_first_n: 3,
        protect_last_n: 10,
        abort_on_summary_failure: true,
      },
      mockDeps(async () => {
        throw new Error("simulated llm outage");
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/simulated llm outage/);
    expect(result.messages.length).toBe(50); // unchanged
  });

  test("LLM failure with abort_on_summary_failure=false → ok=true, placeholder summary inserted", async () => {
    const msgs = bigTranscript(50, 2_000);
    const result = await compressTranscript(
      msgs,
      { threshold_tokens: 5_000, protect_first_n: 3, protect_last_n: 10 },
      mockDeps(async () => {
        throw new Error("simulated llm outage");
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.llm_invoked).toBe(false);
    // Summary text should include the fallback placeholder
    const summaryMsg = result.messages[result.head_count];
    const summaryText = (
      summaryMsg?.content as Array<Record<string, unknown>>
    )?.[0]?.text as string;
    expect(summaryText).toMatch(/simulated llm outage/);
  });

  test("(INTEGRATION) full compact cycle on synthetic 200-msg transcript crosses the threshold", async () => {
    // 200 messages × 1000 chars = ~50K tokens. Threshold at 30K.
    const msgs = bigTranscript(200, 1000);

    // Pre-compact baseline
    const pre = mockDeps().estimateTokens(msgs);
    expect(pre).toBeGreaterThanOrEqual(30_000);

    const result = await compressTranscript(
      msgs,
      {
        threshold_tokens: 30_000,
        protect_first_n: 3,
        protect_last_n: 20,
        target_ratio: 0.20,
      },
      mockDeps(),
    );

    expect(result.ok).toBe(true);
    expect(result.llm_invoked).toBe(true);
    // Compaction must reduce tokens — that's the contract.
    expect(result.final_tokens).toBeLessThan(pre);
    // And the result list must be much shorter than the input.
    expect(result.messages.length).toBeLessThan(msgs.length);
    // Head preserved
    expect(result.head_count).toBe(3);
    // Tail preserved (at minimum protect_last_n)
    expect(result.tail_count).toBeGreaterThanOrEqual(20);
    // Summary message exists between head and tail
    const summaryIdx = result.head_count;
    const summaryMsg = result.messages[summaryIdx];
    const summaryContent = summaryMsg?.content as Array<Record<string, unknown>>;
    expect(summaryContent?.[0]?.text).toMatch(/compacted on/);
  });
});
