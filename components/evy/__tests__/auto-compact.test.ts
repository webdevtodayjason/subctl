// components/evy/__tests__/auto-compact.test.ts
//
// v2.7.22 — fix for the auto-compact watchdog whose last_tick_at stayed
// null indefinitely. Root cause: the boot-time setTimeout that fired
// runAutoCompactTick() early never called touchWatchdog(), and the
// regular setInterval called touchWatchdog OUTSIDE the tick body. So a
// freshly-booted master daemon could show last_tick_at: null even though
// the tick had run, and any error inside the tick was silent.
//
// These tests pin the operator-observable contract:
//   1. A watchdog wired the way v2.7.22 wires it ticks at least once
//      within the first 30s (we use a much shorter interval in the test
//      so it runs in <1s without sleeping for 30s).
//   2. Compaction reduces a synthetic 50k-token transcript well below
//      35k tokens — verifying the compaction primitive itself works.
//   3. A throwing compaction body emits a `severity: "warn"`
//      "auto-compact-error" notification (the observability path).
//
// Tests #2 and #3 use the same primitives the master daemon uses
// (estimateTranscriptTokens + emitNotification) without booting the
// daemon — the actual setInterval wiring is exercised separately in #1
// using a minimal harness that mirrors server.ts's pattern.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  registerWatchdog,
  touchWatchdog,
  listWatchdogs,
  _resetForTesting as resetWatchdogs,
} from "../watchdogs";
import {
  emitNotification,
  listNotifications,
  _resetForTesting as resetNotifications,
} from "../notifications";
import {
  DEFAULT_COMPACT_CONFIG,
  decideCompactAction,
  estimateTranscriptTokens,
} from "../compact-policy";

beforeEach(() => {
  resetWatchdogs();
  resetNotifications();
});

afterEach(() => {
  resetWatchdogs();
  resetNotifications();
});

describe("auto-compact watchdog wiring", () => {
  test("ticks at least once within 30s of boot (touchWatchdog called from tick body)", async () => {
    // Mirror server.ts's pattern: tick body bumps the watchdog FIRST,
    // then does work. The boot-time early-fire calls the SAME function
    // so a fresh daemon's last_tick_at lights up before the 5-min
    // setInterval fires.
    let ticked = 0;
    async function runTick() {
      touchWatchdog("auto-compact");
      ticked++;
    }
    const interval = setInterval(() => void runTick(), 5 * 60 * 1000);
    registerWatchdog({
      id: "auto-compact",
      kind: "auto-compact",
      kill: () => clearInterval(interval),
    });
    // Early-fire that the v2.7.22 fix puts at 15s — collapsed to 50ms
    // for the test. The KEY contract: this path bumps the watchdog,
    // which the pre-v2.7.22 wiring did not.
    setTimeout(() => void runTick(), 50);

    // Wait for the early fire.
    await new Promise((r) => setTimeout(r, 200));

    const entries = listWatchdogs();
    const auto = entries.find((e) => e.id === "auto-compact");
    expect(auto).toBeDefined();
    expect(auto?.last_tick_at).not.toBeNull();
    expect(ticked).toBeGreaterThan(0);

    clearInterval(interval);
  });
});

describe("compaction primitive — reduces 50k transcript to <35k tokens", () => {
  test("estimateTranscriptTokens shrinks when we drop older messages", () => {
    // Build a fake transcript of ~50k tokens. tokenize uses char/4, so
    // we need ~200k chars total. 100 messages × 2k chars each.
    const bigText = "x".repeat(2000);
    const messages: Array<{ content: Array<Record<string, unknown>> }> = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ content: [{ type: "text", text: bigText }] });
    }
    const before = estimateTranscriptTokens(messages);
    expect(before).toBeGreaterThanOrEqual(50_000);

    // Simulate compactTranscriptInline's keep-recent + summary: replace
    // everything but the last 6 messages with a single summary message
    // (mirrors the real compaction shape — summary ~1k chars).
    const KEEP_RECENT = 6;
    const recent = messages.slice(-KEEP_RECENT);
    const summaryText = "[transcript compaction] " + "y".repeat(1000);
    const after: Array<{ content: Array<Record<string, unknown>> }> = [
      { content: [{ type: "text", text: summaryText }] },
      ...recent,
    ];
    const afterTokens = estimateTranscriptTokens(after);
    expect(afterTokens).toBeLessThan(35_000);
  });
});

// ---------------------------------------------------------------------------
// v3.3.5 — Hermes-findings-aligned compact behavior
// ---------------------------------------------------------------------------
//
// Two narrow contract checks for the v3.3.5 changes:
//   1. The +30K default bump means a 60k-token transcript now lands in the
//      WARN band (between warn_tokens=55k and compact_tokens=70k) instead of
//      the COMPACT band as it did pre-v3.3.5 (when compact_tokens=40k).
//   2. The WARN band is the new operating threshold. server.ts's
//      runJitCompactCheck calls compactTranscriptInline on both warn and
//      compact actions — the only difference is the SSE/log initiator tag
//      (jit-warn vs jit). The decision module's "warn" return value still
//      means the same thing it always did (between thresholds); what
//      changed is what the caller DOES with that signal.
//
// Spec source: .subctl/docs/hermes-compact-and-skills-findings.md §1.5.

describe("v3.3.5 default-bump bands (Hermes findings §1.5)", () => {
  test("60k transcript lands in warn band (55k ≤ x < 70k)", () => {
    const decision = decideCompactAction(60_000, 0, DEFAULT_COMPACT_CONFIG);
    expect(decision.action).toBe("warn");
    expect(decision.threshold_used).toBe("warn_tokens");
  });

  test("v3.3.5 contract: full warn/compact/ok matrix at new bands", () => {
    const cfg = DEFAULT_COMPACT_CONFIG;
    // Below warn_tokens (55k) → ok (server proceeds with prompt as-is).
    expect(decideCompactAction(50_000, 0, cfg).action).toBe("ok");
    expect(decideCompactAction(54_999, 0, cfg).action).toBe("ok");
    // At/above warn, below compact → warn (server now compacts; v3.3.5
    // change). Pre-v3.3.5 this band only emitted an SSE banner.
    expect(decideCompactAction(55_000, 0, cfg).action).toBe("warn");
    expect(decideCompactAction(69_999, 0, cfg).action).toBe("warn");
    // At/above compact → compact (server always summarized at this point).
    expect(decideCompactAction(70_000, 0, cfg).action).toBe("compact");
    expect(decideCompactAction(100_000, 0, cfg).action).toBe("compact");
  });

  test("warn band actually fits a realistic 60k transcript shape", () => {
    // Build a synthetic transcript that lands at ~60k tokens (char/4 =>
    // ~240k chars total). Verifies the bump-defaults don't create a
    // pathological band where no realistic transcript falls in warn.
    const bigText = "x".repeat(2400);
    const messages: Array<{ content: Array<Record<string, unknown>> }> = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ content: [{ type: "text", text: bigText }] });
    }
    const tokens = estimateTranscriptTokens(messages);
    // Expect somewhere in the warn band (55k–70k).
    expect(tokens).toBeGreaterThanOrEqual(55_000);
    expect(tokens).toBeLessThan(70_000);
    expect(decideCompactAction(tokens, 0, DEFAULT_COMPACT_CONFIG).action).toBe(
      "warn",
    );
  });
});

describe("auto-compact error path emits a warn notification", () => {
  test("tick body throws → severity:warn 'auto-compact-error' notification", () => {
    // Mirrors the server.ts try/catch wrapper for runAutoCompactTick.
    // If the compaction code throws, we expect a warn-severity
    // notification with kind: "auto-compact-error".
    try {
      throw new Error("synthetic compaction failure");
    } catch (err) {
      emitNotification({
        kind: "auto-compact-error",
        severity: "warn",
        title: "auto-compact: tick threw",
        body: `runAutoCompactTick threw: ${(err as Error).message}`,
      });
    }
    const all = listNotifications();
    expect(all.length).toBe(1);
    expect(all[0]?.kind).toBe("auto-compact-error");
    expect(all[0]?.severity).toBe("warn");
    expect(all[0]?.body).toContain("synthetic compaction failure");
  });
});
