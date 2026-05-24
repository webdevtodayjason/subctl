// v2.8.10 — Tier 4 routing: Cognee primary, claude-mem fallback.
//
// Phase 2 tests for components/evy/tools/memory.ts after the
// substrate swap. Verifies:
//   1. When Cognee is available, memory_search/timeline/observations
//      route through cogneeRecall and surface source="cognee".
//   2. When Cognee returns reachable=false, fallback path queries
//      claude-mem and surfaces source="claude-mem".
//   3. When BOTH are down, the tool returns ok:false with
//      source="both-empty".
//   4. memory_health aggregates both substrates.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { memoryTools, _setCogneeAvailableForTesting } from "../tools/memory";
import {
  _setDepsForTesting as _setCogneeDeps,
  _resetDepsForTesting as _resetCogneeDeps,
} from "../cognee-client";

// Stub the global fetch so claude-mem requests can be controlled
// independently of the cognee-client deps injection.
const origFetch = globalThis.fetch;
let fetchHandler:
  | ((url: string) => { status: number; body: string } | "throw" | "timeout")
  | null = null;

beforeEach(() => {
  _setCogneeAvailableForTesting(null);
  fetchHandler = null;
  // Reroute fetch through fetchHandler so each test can program
  // claude-mem's response independently.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!fetchHandler) {
      throw new Error(`unstubbed fetch to ${url}`);
    }
    const out = fetchHandler(url);
    if (out === "throw") throw new TypeError("network fail");
    if (out === "timeout") {
      // simulate AbortSignal.timeout firing
      const err = new Error("aborted");
      err.name = "TimeoutError";
      throw err;
    }
    return new Response(out.body, { status: out.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  _resetCogneeDeps();
  _setCogneeAvailableForTesting(null);
});

describe("memory_search routing", () => {
  test("uses Cognee when available, surfaces source=cognee", async () => {
    _setCogneeAvailableForTesting(true);
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/recall")) {
          return new Response(
            JSON.stringify({
              hits: [{ text: "decision X", score: 0.9 }],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected cognee URL ${url}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await memoryTools.memory_search.invoke({ query: "what about X?" });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("cognee");
    expect((out as { count: number }).count).toBe(1);
  });

  test("falls back to claude-mem when Cognee is unavailable", async () => {
    _setCogneeAvailableForTesting(false);
    fetchHandler = (url) => {
      if (url.includes("/api/search")) {
        return { status: 200, body: JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const out = await memoryTools.memory_search.invoke({ query: "anything" });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("claude-mem");
    expect((out as { count: number }).count).toBe(2);
  });

  test("falls back when Cognee returns an error response", async () => {
    _setCogneeAvailableForTesting(true);
    _setCogneeDeps({
      fetcher: (async () =>
        new Response("oops", { status: 500 })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    fetchHandler = (url) => {
      if (url.includes("/api/search")) {
        return { status: 200, body: JSON.stringify({ items: [{ id: "fallback" }] }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = await memoryTools.memory_search.invoke({ query: "x" });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("claude-mem");
  });

  test("ok:false with source=both-empty when both substrates down", async () => {
    _setCogneeAvailableForTesting(false);
    fetchHandler = (url) => {
      if (url.includes("/api/search")) return "throw";
      throw new Error(`unexpected ${url}`);
    };
    const out = await memoryTools.memory_search.invoke({ query: "x" });
    expect(out.ok).toBe(false);
    expect((out as { source: string }).source).toBe("both-empty");
  });
});

describe("memory_timeline routing", () => {
  test("uses Cognee with wildcard query for recency", async () => {
    _setCogneeAvailableForTesting(true);
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/recall")) {
          return new Response(
            JSON.stringify({
              hits: [{ text: "recent A" }, { text: "recent B" }],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected cognee URL ${url}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await memoryTools.memory_timeline.invoke({});
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("cognee");
  });

  test("falls back to claude-mem timeline when Cognee unavailable", async () => {
    _setCogneeAvailableForTesting(false);
    fetchHandler = (url) => {
      if (url.includes("/api/timeline")) {
        return { status: 200, body: JSON.stringify({ items: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = await memoryTools.memory_timeline.invoke({});
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("claude-mem");
  });
});

describe("memory_observations routing", () => {
  test("Cognee path returns sliced hits with hasMore signalled", async () => {
    _setCogneeAvailableForTesting(true);
    const all = Array.from({ length: 30 }, (_, i) => ({ text: `obs ${i}` }));
    _setCogneeDeps({
      fetcher: (async () =>
        new Response(JSON.stringify({ hits: all }), { status: 200 })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await memoryTools.memory_observations.invoke({ limit: 10, offset: 0 });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("cognee");
    expect((out as { count: number }).count).toBe(10);
    expect((out as { hasMore: boolean }).hasMore).toBe(true);
  });

  test("claude-mem fallback preserves raw pagination metadata", async () => {
    _setCogneeAvailableForTesting(false);
    fetchHandler = (url) => {
      if (url.includes("/api/observations")) {
        return {
          status: 200,
          body: JSON.stringify({
            items: [{ id: 1 }, { id: 2 }, { id: 3 }],
            hasMore: false,
            offset: 0,
            limit: 25,
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = await memoryTools.memory_observations.invoke({});
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("claude-mem");
    expect((out as { count: number }).count).toBe(3);
  });
});

describe("memory_health aggregation", () => {
  test("reports both substrates with active=cognee when cognee reachable", async () => {
    _setCogneeDeps({
      fetcher: (async () =>
        new Response(JSON.stringify({ version: "0.9.0" }), {
          status: 200,
        })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => "tok",
    });
    fetchHandler = () => ({ status: 200, body: JSON.stringify({ ok: true }) });
    const out = await memoryTools.memory_health.invoke();
    expect(out.ok).toBe(true);
    expect((out as { active_substrate: string }).active_substrate).toBe("cognee");
    expect((out as { cognee: { reachable: boolean } }).cognee.reachable).toBe(true);
    expect((out as { claude_mem: { reachable: boolean } }).claude_mem.reachable).toBe(true);
  });

  test("active=none when both substrates fail", async () => {
    _setCogneeDeps({
      fetcher: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    fetchHandler = () => "throw";
    const out = await memoryTools.memory_health.invoke();
    expect(out.ok).toBe(false);
    expect((out as { active_substrate: string }).active_substrate).toBe("none");
  });
});
