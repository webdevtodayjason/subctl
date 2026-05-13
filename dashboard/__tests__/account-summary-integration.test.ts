// dashboard/__tests__/account-summary-integration.test.ts
//
// ── v2.8.1 accounts data fix ──
//
// Verifies the wire-up between dashboard/server.ts (which we cannot
// import directly without booting the HTTP server) and the extracted
// verdict module. The shapes that go onto state.accounts and
// state.usage_fetch are exercised here at the data-layer level: given
// a constructed usage-fetch result, the verdict comes out correctly.
//
// We replicate just enough of the buildAccountSummaries call path to
// catch the regression — without booting tmux, the master daemon, or
// the network.

import { describe, expect, test } from "bun:test";

import { computeAccountVerdict, type UsageEntry } from "../lib/account-verdict";

// Mirror of dashboard/server.ts: AccountUsageResult — the per-line
// payload shape `subctl usage --json` produces.
interface AccountUsageResult {
  alias: string;
  cfg_dir: string;
  ok: boolean;
  usage?: UsageEntry;
  error?: string;
}

// Mirror of dashboard/server.ts: UsageFetchMeta — the metadata block
// the server attaches to every state payload (state.usage_fetch).
interface UsageFetchMeta {
  ok: boolean;
  fetched_at_ms: number;
  fetched_at: string;
  age_seconds: number;
  accounts_returned: number;
  accounts_with_usage: number;
  accounts_with_errors: number;
  error?: string;
}

// Re-implementation of the lookup/verdict pair that runs per account inside
// buildAccountSummaries. Keeps the test pure (no fs, no spawn) while
// exercising the same null-handling that produces state.accounts[*].
function summariseAccount(args: {
  alias: string;
  authReady: boolean;
  usageAll: AccountUsageResult[];
  usageMeta: UsageFetchMeta;
  recent429: number;
  parallelOnAccount: number;
}) {
  const rec = args.usageAll.find(u => u.alias === args.alias) ?? null;
  const usage = rec && rec.ok ? (rec.usage ?? null) : null;
  const usageFetchOkForAcct =
    args.usageMeta.ok && rec !== null && rec.ok === true && rec.usage != null;
  const verdict = computeAccountVerdict({
    alias: args.alias,
    authReady: args.authReady,
    usage,
    recent429: args.recent429,
    parallelOnAccount: args.parallelOnAccount,
    usageFetchOk: usageFetchOkForAcct,
  });
  return {
    alias: args.alias,
    usage,
    usage_state: !args.usageMeta.ok
      ? "fetch_failed"
      : (usageFetchOkForAcct ? "ok" : "stale"),
    dispatch: verdict,
  };
}

function meta(over: Partial<UsageFetchMeta> = {}): UsageFetchMeta {
  return {
    ok: true,
    fetched_at_ms: 1_700_000_000_000,
    fetched_at: "2026-05-13T00:00:00.000Z",
    age_seconds: 0,
    accounts_returned: 0,
    accounts_with_usage: 0,
    accounts_with_errors: 0,
    ...over,
  };
}

describe("buildAccountSummaries — usage_fetch wiring (v2.8.1 regression)", () => {
  test("fetch failed globally → every account is yellow + fetch_failed", () => {
    // Reproduces the operator's exact symptom report: dashboard
    // shows everyone "ready" with "dispatches go". After fix, every
    // account renders yellow with data_missing — not green.
    const usageAll: AccountUsageResult[] = [];
    const usageMeta = meta({ ok: false, error: "spawn failed: ENOENT" });

    for (const alias of ["claude-personal", "claude-work", "claude-overflow"]) {
      const row = summariseAccount({
        alias,
        authReady: true,
        usageAll,
        usageMeta,
        recent429: 0,
        parallelOnAccount: 0,
      });
      expect(row.dispatch.verdict).toBe("yellow");
      expect(row.dispatch.data_missing).toBe(true);
      expect(row.usage_state).toBe("fetch_failed");
      expect(row.usage).toBeNull();
    }
  });

  test("fetch succeeded but one alias missing → that account is stale-yellow, others normal", () => {
    const usageAll: AccountUsageResult[] = [
      {
        alias: "claude-personal",
        cfg_dir: "/Users/jason/.claude-personal",
        ok: true,
        usage: {
          five_hour:        { utilization: 12, resets_at: null },
          seven_day:        { utilization: 35, resets_at: null },
          seven_day_sonnet: { utilization: 20, resets_at: null },
        },
      },
      {
        alias: "claude-work",
        cfg_dir: "/Users/jason/.claude-work",
        ok: false,
        error: "HTTP 401",
      },
      // claude-overflow absent from result entirely
    ];
    const usageMeta = meta({
      ok: true,
      accounts_returned: 2,
      accounts_with_usage: 1,
      accounts_with_errors: 1,
    });

    const personal = summariseAccount({
      alias: "claude-personal",
      authReady: true,
      usageAll,
      usageMeta,
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(personal.dispatch.verdict).toBe("green");
    expect(personal.usage_state).toBe("ok");

    const work = summariseAccount({
      alias: "claude-work",
      authReady: true,
      usageAll,
      usageMeta,
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(work.dispatch.verdict).toBe("yellow");
    expect(work.dispatch.data_missing).toBe(true);
    expect(work.usage_state).toBe("stale");

    const overflow = summariseAccount({
      alias: "claude-overflow",
      authReady: true,
      usageAll,
      usageMeta,
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(overflow.dispatch.verdict).toBe("yellow");
    expect(overflow.dispatch.data_missing).toBe(true);
    expect(overflow.usage_state).toBe("stale");
  });

  test("the 98% account — explicit fixture for the original operator scenario", () => {
    const usageAll: AccountUsageResult[] = [
      {
        alias: "claude-personal",
        cfg_dir: "/Users/jason/.claude-personal",
        ok: true,
        usage: {
          five_hour:        { utilization: 45, resets_at: null },
          seven_day:        { utilization: 98, resets_at: null },
          seven_day_sonnet: { utilization: 71, resets_at: null },
        },
      },
    ];
    const row = summariseAccount({
      alias: "claude-personal",
      authReady: true,
      usageAll,
      usageMeta: meta({ ok: true, accounts_returned: 1, accounts_with_usage: 1 }),
      recent429: 0,
      parallelOnAccount: 0,
    });
    expect(row.dispatch.verdict).toBe("red");
    expect(row.dispatch.reasons.some(r => r.includes("98%"))).toBe(true);
    expect(row.usage_state).toBe("ok");
  });
});
