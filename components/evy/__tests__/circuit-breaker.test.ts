// components/master/__tests__/circuit-breaker.test.ts
//
// v2.7.19 — Empty-listener circuit breaker. Pins the trigger condition,
// the reset semantics (different tool / non-empty result / new turn),
// and the synthesized refusal payload. Background and motivating
// incident in components/master/circuit-breaker.ts header.
//
// What we test:
//   1. The trigger predicate is tight — only matches { entries: [], listener: { running: false, ... } }.
//   2. After 3 consecutive matching returns for SAME tool, shouldRefuseToolCall flips to true.
//   3. A non-empty result mid-stream resets the counter.
//   4. A different tool result mid-stream resets the counter.
//   5. resetOnNewTurn clears tripped state.
//   6. synthesizeRefusal produces the exact contract string the spec
//      requires (so the model gets the right instruction).
//   7. Counter is per-tool — refusal targets only the looping tool name.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isEmptyListenerResult,
  recordToolResult,
  shouldRefuseToolCall,
  synthesizeRefusal,
  resetOnNewTurn,
  _peekStateForTesting,
  _resetForTesting,
} from "../circuit-breaker";

beforeEach(() => {
  _resetForTesting();
});
afterEach(() => {
  _resetForTesting();
});

// ─── trigger predicate ────────────────────────────────────────────────────

describe("isEmptyListenerResult", () => {
  test("MATCHES the exact 2026-05-13 incident payload", () => {
    expect(
      isEmptyListenerResult({
        entries: [],
        listener: { running: false, offset: 0, inbox_size_kb: 0 },
      }),
    ).toBe(true);
  });

  test("does NOT match a healthy listener (running: true) even with empty entries", () => {
    expect(
      isEmptyListenerResult({
        entries: [],
        listener: { running: true, offset: 0, inbox_size_kb: 0 },
      }),
    ).toBe(false);
  });

  test("does NOT match a non-empty inbox (entries length > 0)", () => {
    expect(
      isEmptyListenerResult({
        entries: [{ id: 1 }],
        listener: { running: false },
      }),
    ).toBe(false);
  });

  test("does NOT match a missing listener key", () => {
    expect(isEmptyListenerResult({ entries: [] })).toBe(false);
  });

  test("does NOT match listener.running === undefined (must be explicitly false)", () => {
    expect(isEmptyListenerResult({ entries: [], listener: {} })).toBe(false);
  });

  test("does NOT match null, primitives, arrays, or strings", () => {
    expect(isEmptyListenerResult(null)).toBe(false);
    expect(isEmptyListenerResult("")).toBe(false);
    expect(isEmptyListenerResult(0)).toBe(false);
    expect(isEmptyListenerResult([])).toBe(false);
    expect(isEmptyListenerResult({})).toBe(false);
  });
});

// ─── core trip flow ──────────────────────────────────────────────────────

describe("3-trip then refusal", () => {
  const DEAD: unknown = {
    entries: [],
    listener: { running: false, offset: 0 },
  };

  test("3 consecutive dead-listener returns trips the breaker on the 4th call", () => {
    expect(shouldRefuseToolCall("subctl_orch_inbox")).toBe(false);
    recordToolResult("subctl_orch_inbox", DEAD);
    expect(shouldRefuseToolCall("subctl_orch_inbox")).toBe(false);
    recordToolResult("subctl_orch_inbox", DEAD);
    expect(shouldRefuseToolCall("subctl_orch_inbox")).toBe(false);
    recordToolResult("subctl_orch_inbox", DEAD);
    // Now the counter is at threshold; the next call would be refused.
    expect(shouldRefuseToolCall("subctl_orch_inbox")).toBe(true);
    // Refusal targets ONLY this tool — another tool is untouched.
    expect(shouldRefuseToolCall("subctl_orch_state")).toBe(false);
  });

  test("counter reflects the consecutive count in state", () => {
    recordToolResult("t", DEAD);
    expect(_peekStateForTesting().count).toBe(1);
    recordToolResult("t", DEAD);
    expect(_peekStateForTesting().count).toBe(2);
    recordToolResult("t", DEAD);
    expect(_peekStateForTesting().count).toBe(3);
  });
});

// ─── reset semantics ─────────────────────────────────────────────────────

describe("reset on non-empty result", () => {
  const DEAD: unknown = { entries: [], listener: { running: false } };
  const HEALTHY: unknown = {
    entries: [{ id: "x" }],
    listener: { running: true },
  };

  test("non-empty result for SAME tool resets the counter to 0", () => {
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    expect(_peekStateForTesting().count).toBe(2);
    // Healthy result arrives — counter clears.
    recordToolResult("inbox", HEALTHY);
    expect(_peekStateForTesting().count).toBe(0);
    expect(_peekStateForTesting().tool).toBeNull();
    // Resume counting from scratch.
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    expect(shouldRefuseToolCall("inbox")).toBe(true);
  });
});

describe("reset on different tool", () => {
  const DEAD: unknown = { entries: [], listener: { running: false } };
  const UNRELATED: unknown = { ok: true, foo: "bar" };

  test("a DIFFERENT tool's non-matching result resets the looping tool's counter", () => {
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    expect(_peekStateForTesting().count).toBe(2);
    // Some other tool ran and returned a plain success — counter clears.
    recordToolResult("watchdog_list", UNRELATED);
    expect(_peekStateForTesting().count).toBe(0);
    expect(shouldRefuseToolCall("inbox")).toBe(false);
  });

  test("a different tool returning the matching pattern starts a fresh counter on the new tool", () => {
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    // Same-pattern from a DIFFERENT tool — counter resets to 1 on the new tool.
    recordToolResult("other_poll", DEAD);
    expect(_peekStateForTesting().count).toBe(1);
    expect(_peekStateForTesting().tool).toBe("other_poll");
    // Old tool no longer near trip.
    expect(shouldRefuseToolCall("inbox")).toBe(false);
  });
});

describe("resetOnNewTurn", () => {
  const DEAD: unknown = { entries: [], listener: { running: false } };
  test("clears tripped state so a new operator turn starts clean", () => {
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    recordToolResult("inbox", DEAD);
    expect(shouldRefuseToolCall("inbox")).toBe(true);
    resetOnNewTurn();
    expect(shouldRefuseToolCall("inbox")).toBe(false);
    expect(_peekStateForTesting().count).toBe(0);
  });
});

// ─── refusal payload contract ────────────────────────────────────────────

describe("synthesizeRefusal", () => {
  test("contains the tool name, the threshold count, and the watchdog_list hint", () => {
    const r = synthesizeRefusal("subctl_orch_inbox");
    expect(r.error).toContain("circuit-breaker");
    expect(r.error).toContain("subctl_orch_inbox");
    expect(r.error).toContain("3 times in a row");
    expect(r.error).toContain("listener is dead");
    expect(r.error).toContain("watchdog_list");
  });
});
