// components/master/__tests__/probe-with-retry.test.ts
//
// Pins the retry-with-backoff contract used by Cognee + Memori boot
// probes. The motivating incident: master logged
// `[cognee] UNREACHABLE` every boot because the one-shot probe fired
// before the Python sidecar finished loading (~5–15s startup). The
// helper should now log a quiet "not yet reachable" line during the
// waiting window and only emit the loud UNREACHABLE after exhaustion.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  probeWithRetry,
  _setDepsForTesting,
  _resetDepsForTesting,
} from "../probe-with-retry";

interface FakeResult {
  reachable: boolean;
  url?: string;
  error?: string | null;
}

// Synthetic clock + sleep so tests don't burn wall time on backoff.
function installFakeTime() {
  let nowMs = 0;
  _setDepsForTesting({
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  });
  return {
    advance: (ms: number) => {
      nowMs += ms;
    },
    get current() {
      return nowMs;
    },
  };
}

function captureLogs(): {
  lines: string[];
  log: (line: string) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    log: (line) => {
      lines.push(line);
    },
  };
}

beforeEach(() => {
  installFakeTime();
});

afterEach(() => {
  _resetDepsForTesting();
});

describe("probeWithRetry — first-try success", () => {
  test("returns immediately, no retries, no logs", async () => {
    let calls = 0;
    const { lines, log } = captureLogs();
    const result = await probeWithRetry<FakeResult>({
      name: "cognee",
      probe: async () => {
        calls += 1;
        return { reachable: true, url: "http://127.0.0.1:8745" };
      },
      budgetMs: 30_000,
      baseDelayMs: 1500,
      maxAttempts: 6,
      log,
    });
    expect(result.reachable).toBe(true);
    expect(calls).toBe(1);
    // First-try success → no log emitted by the helper itself.
    // Caller's existing "reachable" log line handles the success.
    expect(lines).toEqual([]);
  });
});

describe("probeWithRetry — eventual success", () => {
  test("returns after 3 attempts with quiet intermediate lines + success line", async () => {
    let calls = 0;
    const { lines, log } = captureLogs();
    const result = await probeWithRetry<FakeResult>({
      name: "cognee",
      probe: async () => {
        calls += 1;
        if (calls < 3) {
          return {
            reachable: false,
            url: "http://127.0.0.1:8745",
            error: "Unable to connect",
          };
        }
        return { reachable: true, url: "http://127.0.0.1:8745" };
      },
      budgetMs: 30_000,
      baseDelayMs: 1500,
      maxAttempts: 6,
      log,
    });
    expect(result.reachable).toBe(true);
    expect(calls).toBe(3);

    // Quiet intermediate lines + final success line. NO UNREACHABLE.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("not yet reachable");
    expect(lines[0]).toContain("(attempt 1/6");
    expect(lines[0]).toContain("will retry in 1.5s");
    expect(lines[1]).toContain("not yet reachable");
    expect(lines[1]).toContain("(attempt 2/6");
    expect(lines[1]).toContain("will retry in 3.0s");
    expect(lines[2]).toContain("[cognee] reachable after 3 attempts");
    // None of the lines should be the loud UNREACHABLE.
    expect(lines.some((l) => l.includes("UNREACHABLE"))).toBe(false);
  });
});

describe("probeWithRetry — never reachable (attempts exhausted)", () => {
  test("logs all retries + final UNREACHABLE after maxAttempts", async () => {
    let calls = 0;
    const { lines, log } = captureLogs();
    const result = await probeWithRetry<FakeResult>({
      name: "memori",
      probe: async () => {
        calls += 1;
        return {
          reachable: false,
          url: "http://127.0.0.1:8746",
          error: "ECONNREFUSED",
        };
      },
      // Big budget so attempt-cap is the binding constraint.
      budgetMs: 10_000_000,
      baseDelayMs: 100,
      maxAttempts: 4,
      log,
    });
    expect(result.reachable).toBe(false);
    expect(calls).toBe(4);

    // 3 intermediate "not yet reachable" + 1 final UNREACHABLE = 4 lines.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("not yet reachable");
    expect(lines[0]).toContain("(attempt 1/4");
    expect(lines[1]).toContain("(attempt 2/4");
    expect(lines[2]).toContain("(attempt 3/4");
    expect(lines[3]).toContain("[memori] UNREACHABLE");
    expect(lines[3]).toContain("after 4 attempts");
    expect(lines[3]).toContain("ECONNREFUSED");
  });
});

describe("probeWithRetry — budgetMs cap", () => {
  test("stops early when next backoff would exceed budget", async () => {
    let calls = 0;
    const { lines, log } = captureLogs();
    // baseDelayMs=10s, maxAttempts=10, but budget=15s → after 1st
    // attempt (elapsed 0s) we'd wait 10s (elapsed→10s); after 2nd we'd
    // wait 20s which would push us to 30s (>15s budget) → exit with
    // UNREACHABLE.
    const result = await probeWithRetry<FakeResult>({
      name: "cognee",
      probe: async () => {
        calls += 1;
        return {
          reachable: false,
          url: "http://127.0.0.1:8745",
          error: "transport: timed out",
        };
      },
      budgetMs: 15_000,
      baseDelayMs: 10_000,
      maxAttempts: 10,
      log,
    });
    expect(result.reachable).toBe(false);
    // 1 retry succeeded (10s sleep), 2nd retry would exceed budget so
    // we stop after attempt 2.
    expect(calls).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("not yet reachable");
    expect(lines[1]).toContain("UNREACHABLE");
    expect(lines[1]).toContain("after 2 attempts");
  });
});

describe("probeWithRetry — quiet log shape", () => {
  test("intermediate failures never use the UNREACHABLE word", async () => {
    let calls = 0;
    const { lines, log } = captureLogs();
    await probeWithRetry<FakeResult>({
      name: "cognee",
      probe: async () => {
        calls += 1;
        if (calls < 5) {
          return {
            reachable: false,
            url: "http://127.0.0.1:8745",
            error: "Unable to connect",
          };
        }
        return { reachable: true, url: "http://127.0.0.1:8745" };
      },
      budgetMs: 600_000,
      baseDelayMs: 500,
      maxAttempts: 8,
      log,
    });

    // 4 intermediate fails + 1 success line = 5 lines.
    // Every intermediate line must be quiet (no UNREACHABLE token).
    const intermediates = lines.slice(0, 4);
    for (const line of intermediates) {
      expect(line.includes("UNREACHABLE")).toBe(false);
      expect(line).toMatch(/^\[cognee\] not yet reachable \(attempt \d+\/8, will retry in [\d.]+s\)$/);
    }
    expect(lines[4]).toContain("reachable after 5 attempts");
  });
});

describe("probeWithRetry — exponential backoff schedule", () => {
  test("delays double each attempt: base, 2x, 4x, 8x …", async () => {
    const delays: number[] = [];
    _setDepsForTesting({
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      now: () => 0,
    });

    const { log } = captureLogs();
    let calls = 0;
    await probeWithRetry<FakeResult>({
      name: "cognee",
      probe: async () => {
        calls += 1;
        return { reachable: false, error: "down" };
      },
      // Huge budget so backoff is the only stopping condition.
      budgetMs: Number.MAX_SAFE_INTEGER,
      baseDelayMs: 1000,
      maxAttempts: 5,
      log,
    });
    // 4 sleeps between 5 attempts: 1000, 2000, 4000, 8000.
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });
});
