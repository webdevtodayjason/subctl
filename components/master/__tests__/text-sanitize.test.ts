// components/master/__tests__/text-sanitize.test.ts
//
// v2.8.9 — Pins the channel-marker strip behaviour shared across all
// outbound text surfaces (transcript persistence, Telegram send, dashboard
// SSE broadcast). The strip exists because gemma-4-26b-a4b-it MLX 4-bit
// (and likely other 4-bit MLX quantisations) emit malformed harmony-
// format reasoning channels that bleed through LM Studio's chat template.
//
// What we test:
//   1. The malformed gemma form (<|channel>NAME<channel|>) strips cleanly.
//   2. The canonical form (<|channel|>NAME<|channel|>) also strips.
//   3. Empty markers (<|channel|><|channel|>) strip cleanly.
//   4. Multiple paired markers in one string all strip.
//   5. Non-matching `<` or `>` characters in surrounding text are preserved.
//   6. Empty / non-string input is handled without throwing.
//   7. Already-clean text passes through unchanged (idempotency).

import { describe, expect, test } from "bun:test";

import {
  stripReasoningChannels,
  REASONING_CHANNEL_RE,
} from "../text-sanitize.ts";

describe("stripReasoningChannels", () => {
  test("strips the malformed gemma-4-26b-a4b form", () => {
    const input = "<|channel>thought\n<channel|>I have filed the bug report.";
    expect(stripReasoningChannels(input)).toBe("I have filed the bug report.");
  });

  test("strips the canonical harmony form (both pipes each side)", () => {
    const input = "<|channel|>thought<|channel|>Actual response here.";
    expect(stripReasoningChannels(input)).toBe("Actual response here.");
  });

  test("strips empty marker pairs", () => {
    expect(stripReasoningChannels("<|channel|><|channel|>")).toBe("");
    expect(stripReasoningChannels("prefix<|channel|><|channel|>suffix")).toBe(
      "prefixsuffix",
    );
  });

  test("strips multiple paired markers in one string", () => {
    const input =
      "<|channel>thought\n<channel|>step 1<|channel>final\n<channel|>step 2";
    // Both pairs strip; only the content survives.
    expect(stripReasoningChannels(input)).toBe("step 1step 2");
  });

  test("preserves stray < and > that aren't part of a marker", () => {
    const input = "result: 5 < 10 and 10 > 5";
    expect(stripReasoningChannels(input)).toBe(input);
  });

  test("preserves stray <|partial that isn't a closed pair", () => {
    const input = "incomplete <|channel> alone";
    // No closing marker, so the regex finds no pair to strip.
    expect(stripReasoningChannels(input)).toBe(input);
  });

  test("is idempotent on already-clean text", () => {
    const input = "Right then, the desk is in order.";
    expect(stripReasoningChannels(input)).toBe(input);
    expect(stripReasoningChannels(stripReasoningChannels(input))).toBe(input);
  });

  test("handles empty string", () => {
    expect(stripReasoningChannels("")).toBe("");
  });

  test("handles strings with only whitespace between markers", () => {
    expect(stripReasoningChannels("<|channel> <channel|>after")).toBe("after");
  });

  test("regex has the g flag (matches all occurrences)", () => {
    expect(REASONING_CHANNEL_RE.flags).toContain("g");
  });
});
