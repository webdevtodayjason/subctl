// components/master/tools/policy/__tests__/perf.test.ts
//
// Hot-path latency budget. Pack 11 §6: "1000 checks complete in under 100ms"
// on the operator's M-series Mac. The hook runs this before every Bash
// invocation; if it gets slow, the worker stalls and the operator notices.
//
// The check loop touches:
//   - tokenize() (shell-quote parse, no I/O)
//   - regex cache (compiled once, reused)
//   - allow_pattern walk (linear, ~10 entries in node preset)
//   - default-deny path (rm -rf / hits deny_always.substrings on first try)
//
// Two checks per iteration (one allow path, one deny path), 1000 iterations
// = 2000 calls total. The test asserts the SUM <100ms.

import { beforeAll, describe, expect, it } from "bun:test";

import { _resetCachesForTesting, checkCommand } from "../check";
import { loadPreset } from "../load";
import type { PolicyDocument } from "../types";

let node: PolicyDocument;

beforeAll(async () => {
  _resetCachesForTesting();
  const partial = (await loadPreset("node")) as PolicyDocument;
  partial.default_mode = partial.default_mode ?? "gated";
  node = partial;
});

describe("performance — pack 11 §6 budget", () => {
  it("1000 iterations × 2 checks complete in under 100ms (warm cache)", () => {
    const req1 = { command: "git status", cwd: "/tmp", team_id: "t" } as const;
    const req2 = { command: "rm -rf /", cwd: "/tmp", team_id: "t" } as const;

    // Warm the regex + allow_pattern caches first. The budget is "warm cache"
    // performance per pack 06 §4 ("Budget: <20ms p99 on a warm cache").
    for (let i = 0; i < 100; i++) {
      checkCommand(node, req1);
      checkCommand(node, req2);
    }

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      checkCommand(node, req1);
      checkCommand(node, req2);
    }
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`perf: 2000 checks in ${elapsed.toFixed(2)}ms`);
    expect(elapsed).toBeLessThan(100);
  });
});
