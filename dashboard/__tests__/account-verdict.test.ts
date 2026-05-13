// dashboard/__tests__/account-verdict.test.ts
//
// ── v2.8.1 accounts data fix ──
//
// Covers the regression from the 2026-05-13 operator bug report: the
// dashboard Accounts surface rendered every account as `ready` with
// `dispatches go` even when the operator knew one account was 98%.
//
// Root cause: when `usage` was null (because `subctl usage --json`
// silently returned an empty array on subprocess failure, OR the alias
// wasn't present in the fetch result), computeAccountVerdict fell
// through every threshold check and returned a default { verdict:
// "green", reasons: [] }. The dashboard therefore showed all-green for
// every authed account regardless of real usage.
//
// Fix: a null `usage` now produces { verdict: "yellow",
// data_missing: true, reasons: ["usage data unavailable — …"] }, and
// the new 80/95 thresholds align with the team-lead's go/caution/
// throttle dispatch model.

import { describe, expect, test } from "bun:test";

import {
  computeAccountVerdict,
  dispatchLabel,
  THRESH_RED,
  THRESH_YELLOW,
  type UsageEntry,
} from "../lib/account-verdict";

function usage(partial: Partial<UsageEntry>): UsageEntry {
  // Default to fully clean usage so each test isolates one signal.
  return {
    five_hour:        { utilization: 0, resets_at: null },
    seven_day:        { utilization: 0, resets_at: null },
    seven_day_sonnet: { utilization: 0, resets_at: null },
    ...partial,
  };
}

describe("computeAccountVerdict — auth gate", () => {
  test("unauthenticated account is always red regardless of usage", () => {
    const v = computeAccountVerdict({
      alias: "claude-personal",
      authReady: false,
      usage: usage({ seven_day: { utilization: 0, resets_at: null } }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
    expect(v.reasons[0]).toMatch(/not authenticated/i);
  });
});

describe("computeAccountVerdict — missing usage data (the v2.8.1 bug)", () => {
  // The whole reason this fix exists. Before v2.8.1, an authed account
  // with `usage: null` returned green with no reasons — which is why
  // every account on the operator's dashboard read "dispatches go" even
  // though one was at 98% upstream.

  test("authed account with null usage is YELLOW + data_missing flag", () => {
    const v = computeAccountVerdict({
      alias: "claude-personal",
      authReady: true,
      usage: null,
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("yellow");
    expect(v.data_missing).toBe(true);
    expect(v.reasons.join(" ").toLowerCase()).toMatch(/usage data unavailable|usage fetch failed/);
  });

  test("upstream fetch failed → reason text mentions `subctl usage`", () => {
    const v = computeAccountVerdict({
      alias: "claude-work",
      authReady: true,
      usage: null,
      recent429: 0,
      parallelOnAccount: 0,
      usageFetchOk: false,
    });
    expect(v.verdict).toBe("yellow");
    expect(v.data_missing).toBe(true);
    expect(v.reasons[0]).toContain("subctl usage");
  });

  test("never returns green when usage is null — the actual regression", () => {
    // Bracket the parameter space: every plausible authed-account input
    // with null usage must NOT be green.
    for (const recent429 of [0, 1, 5]) {
      for (const parallelOnAccount of [0, 1, 4, 10]) {
        const v = computeAccountVerdict({
          alias: "claude-overflow",
          authReady: true,
          usage: null,
          recent429,
          parallelOnAccount,
        });
        expect(v.verdict).not.toBe("green");
      }
    }
  });
});

describe("computeAccountVerdict — threshold mapping (80/95)", () => {
  test("under 80% weekly → green / go", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({ seven_day: { utilization: 79, resets_at: null } }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("green");
    expect(dispatchLabel(v.verdict)).toBe("go");
  });

  test("≥80% weekly → yellow / caution (THRESH_YELLOW boundary)", () => {
    expect(THRESH_YELLOW).toBe(80);
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({ seven_day: { utilization: 80, resets_at: null } }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("yellow");
    expect(dispatchLabel(v.verdict)).toBe("caution");
    expect(v.reasons.some(r => r.includes("80%"))).toBe(true);
  });

  test("operator's 98% account → red / throttle (the original symptom)", () => {
    const v = computeAccountVerdict({
      alias: "claude-personal",
      authReady: true,
      usage: usage({ seven_day: { utilization: 98, resets_at: null } }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
    expect(dispatchLabel(v.verdict)).toBe("throttle");
    expect(v.reasons.some(r => r.includes("98%"))).toBe(true);
  });

  test("≥95% → red / throttle (THRESH_RED boundary)", () => {
    expect(THRESH_RED).toBe(95);
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({ five_hour: { utilization: 95, resets_at: null } }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
  });

  test("Sonnet-only window hot, all-models cool → still yellow", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({
        seven_day:        { utilization: 12, resets_at: null },
        seven_day_sonnet: { utilization: 88, resets_at: null },
      }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("yellow");
    expect(v.reasons.some(r => r.toLowerCase().includes("sonnet"))).toBe(true);
  });

  test("extra-usage credits over the monthly limit → red", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 50.01, currency: "USD" },
      }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
    expect(v.reasons.some(r => r.toLowerCase().includes("extra-usage"))).toBe(true);
  });

  test("extra-usage under limit → no contribution to verdict", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 10, currency: "USD" },
      }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("green");
  });
});

describe("computeAccountVerdict — operational signals (429 + parallel sessions)", () => {
  test("3+ RL hits today bumps to red even on clean usage", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({}),
      recent429: 3,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
  });

  test("1-2 RL hits → yellow", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({}),
      recent429: 1,
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("yellow");
  });

  test("5+ parallel sessions → red", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({}),
      recent429: 0,
      parallelOnAccount: 5,
    });
    expect(v.verdict).toBe("red");
  });

  test("once red, lower signals can't downgrade", () => {
    const v = computeAccountVerdict({
      alias: "a",
      authReady: true,
      usage: usage({ seven_day: { utilization: 96, resets_at: null } }),
      recent429: 1, // would normally only bump to yellow
      parallelOnAccount: 0,
    });
    expect(v.verdict).toBe("red");
  });
});

describe("dispatchLabel — team-lead's go/caution/throttle model", () => {
  test("maps green/yellow/red to go/caution/throttle", () => {
    expect(dispatchLabel("green")).toBe("go");
    expect(dispatchLabel("yellow")).toBe("caution");
    expect(dispatchLabel("red")).toBe("throttle");
  });
});
