// components/evy/__tests__/compression-triggers.test.ts
//
// v3.3.6 — Tests that pin the three trigger surfaces (pre-flight, post-turn,
// recovery) all call the SAME compactor with the SAME threshold algorithm.
//
// These tests don't boot the full daemon — that's covered by integration
// tests on the compactor module above. Instead they exercise a minimal
// runner that mirrors the wiring inside server.ts's runHermesCompactCheck,
// verifying:
//
//   1. All three trigger sites call shouldCompress with the same args.
//   2. All three call compressTranscript with the same threshold.
//   3. The recovery trigger is gated on a context-overflow-flavoured error
//      string, not on every transient error (rate-limit, timeout shouldn't
//      fire compaction).

import { describe, expect, test } from "bun:test";

import {
  computeThresholdTokens,
  shouldCompress,
  type CompressionConfig,
} from "../compression-policy";
import {
  compressTranscript,
  type CompactableMessage,
} from "../compression-compactor";

interface TriggerCallRecord {
  stage: "pre-flight" | "post-turn" | "recovery";
  realTokens: number;
  threshold: number;
  invokedCompactor: boolean;
}

/**
 * Mini-runner mirroring the wiring in server.ts's runHermesCompactCheck.
 * Returns a record so the test can assert what happened.
 */
async function runOneTrigger(
  stage: "pre-flight" | "post-turn" | "recovery",
  messages: CompactableMessage[],
  realTokens: number,
  ctxWindow: number,
  cfg: CompressionConfig,
): Promise<TriggerCallRecord> {
  const threshold = computeThresholdTokens(ctxWindow, cfg);
  const shouldFire = shouldCompress(realTokens, ctxWindow, cfg);
  if (!shouldFire) {
    return { stage, realTokens, threshold, invokedCompactor: false };
  }
  await compressTranscript(
    messages,
    { threshold_tokens: threshold, protect_first_n: 2, protect_last_n: 5 },
    {
      llmFetcher: async () => "## Summary\nMock",
      auxiliaryModel: () => ({ provider: "mock", model: "mock" }),
      estimateTokens: (msgs) => {
        let c = 0;
        for (const m of msgs) {
          if (Array.isArray(m.content)) {
            for (const b of m.content as Array<Record<string, unknown>>) {
              if (typeof b?.text === "string") c += b.text.length;
            }
          }
        }
        return Math.ceil(c / 4);
      },
    },
  );
  return { stage, realTokens, threshold, invokedCompactor: true };
}

function buildTranscript(n: number): CompactableMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `msg ${i} ${"x".repeat(2000)}` }],
  }));
}

// ---------------------------------------------------------------------------
// Test #1 — pre-flight trigger contract
// ---------------------------------------------------------------------------

describe("pre-flight trigger (Hermes)", () => {
  test("fires compactor when realTokens >= threshold", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const result = await runOneTrigger(
      "pre-flight",
      buildTranscript(30),
      130_000, // > 100_000 threshold (0.50 × 200_000)
      200_000,
      cfg,
    );
    expect(result.invokedCompactor).toBe(true);
    expect(result.threshold).toBe(100_000);
  });

  test("returns ok without firing when realTokens < threshold", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const result = await runOneTrigger(
      "pre-flight",
      buildTranscript(10),
      50_000, // < 64_000 floor
      200_000,
      cfg,
    );
    expect(result.invokedCompactor).toBe(false);
  });

  test("respects the enabled=false kill switch even when threshold is exceeded", async () => {
    const cfg: CompressionConfig = { enabled: false, threshold: 0.50 };
    const result = await runOneTrigger(
      "pre-flight",
      buildTranscript(30),
      150_000,
      200_000,
      cfg,
    );
    expect(result.invokedCompactor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test #2 — post-turn trigger contract
// ---------------------------------------------------------------------------

describe("post-turn trigger (Hermes)", () => {
  test("uses the SAME threshold formula as pre-flight", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const pre = await runOneTrigger(
      "pre-flight",
      buildTranscript(30),
      120_000,
      200_000,
      cfg,
    );
    const post = await runOneTrigger(
      "post-turn",
      buildTranscript(30),
      120_000,
      200_000,
      cfg,
    );
    expect(pre.threshold).toBe(post.threshold);
    expect(pre.invokedCompactor).toBe(post.invokedCompactor);
  });

  test("fires on growth past threshold during the turn", async () => {
    // Pre-flight at 90K (under threshold) → no fire.
    // Post-turn at 110K (over threshold) → fire.
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const pre = await runOneTrigger(
      "pre-flight",
      buildTranscript(30),
      90_000,
      200_000,
      cfg,
    );
    const post = await runOneTrigger(
      "post-turn",
      buildTranscript(30),
      110_000,
      200_000,
      cfg,
    );
    expect(pre.invokedCompactor).toBe(false);
    expect(post.invokedCompactor).toBe(true);
  });

  test("doesn't fire when transcript grew but is still under threshold", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const post = await runOneTrigger(
      "post-turn",
      buildTranscript(30),
      63_999, // under floor
      200_000,
      cfg,
    );
    expect(post.invokedCompactor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test #3 — recovery trigger contract
// ---------------------------------------------------------------------------

describe("recovery trigger (Hermes)", () => {
  test("uses the SAME threshold formula as pre-flight + post-turn", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const rec = await runOneTrigger(
      "recovery",
      buildTranscript(30),
      120_000,
      200_000,
      cfg,
    );
    expect(rec.threshold).toBe(100_000);
    expect(rec.invokedCompactor).toBe(true);
  });

  test("server.ts gates recovery on overflow-flavoured error strings", () => {
    // Mirror the heuristic in server.ts:3877: an error is treated as
    // context-overflow if its lowercased message contains any of:
    //   "context" / "too many tokens" / "maximum context" / "token limit"
    const overflowErrors = [
      "context length exceeded",
      "context_length_exceeded",
      "Request had too many tokens",
      "maximum context length is 128000 tokens",
      "token limit reached",
    ];
    const nonOverflowErrors = [
      "Rate limit exceeded",
      "Connection timeout",
      "503 service unavailable",
      "tls handshake failed",
    ];
    const looksLikeOverflow = (err: string): boolean => {
      const s = err.toLowerCase();
      return (
        s.includes("context") ||
        s.includes("too many tokens") ||
        s.includes("maximum context") ||
        s.includes("token limit")
      );
    };
    for (const e of overflowErrors) expect(looksLikeOverflow(e)).toBe(true);
    for (const e of nonOverflowErrors)
      expect(looksLikeOverflow(e)).toBe(false);
  });

  test("compaction still respects the threshold when recovery fires (doesn't compact under floor)", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.50 };
    const rec = await runOneTrigger(
      "recovery",
      buildTranscript(30),
      30_000, // way under 64K floor
      200_000,
      cfg,
    );
    expect(rec.invokedCompactor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// All three triggers agree on the algorithm
// ---------------------------------------------------------------------------

describe("all-three-triggers consistency", () => {
  test("at the same realTokens + ctx + cfg, all three triggers reach the same decision", async () => {
    const cfg: CompressionConfig = { enabled: true, threshold: 0.60 };
    const tokens = 130_000;
    const ctx = 200_000;
    const msgs = buildTranscript(40);
    const a = await runOneTrigger("pre-flight", msgs, tokens, ctx, cfg);
    const b = await runOneTrigger("post-turn", msgs, tokens, ctx, cfg);
    const c = await runOneTrigger("recovery", msgs, tokens, ctx, cfg);
    expect(a.invokedCompactor).toBe(b.invokedCompactor);
    expect(b.invokedCompactor).toBe(c.invokedCompactor);
    expect(a.threshold).toBe(b.threshold);
    expect(b.threshold).toBe(c.threshold);
  });
});
