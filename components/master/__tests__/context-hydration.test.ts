// v2.10.0 Memory Cycle Phase 4 — context-hydration unit tests.
//
// Exercises the pure entry point `hydrateContext` against deps-injected
// stubs (no real Memori/Cognee sidecars). Covers the seven cases the
// spec calls out, plus a couple of structural invariants (open/close
// markers always present, ordering deterministic).

import { describe, test, expect } from "bun:test";

import {
  CLOSE_MARKER,
  DEFAULT_CONFIG,
  formatHydrationPayload,
  formatOpenMarker,
  hydrateContext,
  loadContextHydrationConfig,
} from "../context-hydration";
import type {
  CogneeHit,
  HydrationDeps,
  HydrationInput,
  MemoriCuratedRow,
} from "../context-hydration";

// ─── helpers ────────────────────────────────────────────────────────────────

function mkRow(
  partial: Partial<MemoriCuratedRow> & { id: string; text: string },
): MemoriCuratedRow {
  return {
    id: partial.id,
    text: partial.text,
    ts: partial.ts ?? "2026-05-23T10:00:00.000Z",
    kind: partial.kind,
    confidence: partial.confidence,
  };
}

function mkHit(partial: Partial<CogneeHit> & { text: string }): CogneeHit {
  return {
    text: partial.text,
    score: partial.score,
    id: partial.id,
  };
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function mkDeps(overrides: Partial<HydrationDeps>): HydrationDeps {
  return {
    listMemoriCurated: async () => [],
    queryCognee: async () => [],
    now: fixedClock("2026-05-23T17:30:00.000Z"),
    ...overrides,
  };
}

const BASE_INPUT: HydrationInput = {
  entity_id: "jason",
  recent_curated_limit: 20,
  cognee_limit: 5,
  cognee_relevance_query: null,
  // Use a path that almost certainly does not exist; tier1ByteCount
  // returns 0 silently. We're not exercising tier1 sizing in most tests.
  tier1_memory_md_path: "/tmp/subctl-test-nonexistent-memory.md",
};

// ─── 1. empty curated + empty Cognee → empty-marker payload ────────────────

describe("hydrateContext — empty inputs", () => {
  test("empty curated + Cognee disabled → opens and closes with zero counts", async () => {
    const deps = mkDeps({
      listMemoriCurated: async () => [],
    });
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.ok).toBe(true);
    expect(out.context_payload).toContain(
      formatOpenMarker(new Date("2026-05-23T17:30:00.000Z"), 0, 0),
    );
    expect(out.context_payload).toContain(CLOSE_MARKER);
    expect(out.context_payload).not.toContain("CURATED FACTS");
    expect(out.context_payload).not.toContain("GRAPH CONTEXT");
    expect(out.sources.memori_curated_count).toBe(0);
    expect(out.sources.cognee_hits_count).toBe(0);
  });
});

// ─── 2. N curated rows render in order ─────────────────────────────────────

describe("hydrateContext — curated rendering", () => {
  test("renders all curated rows in source order, numbered, with kind/confidence tags", async () => {
    const rows: MemoriCuratedRow[] = [
      mkRow({
        id: "curated_a",
        text: "operator prefers terse responses",
        kind: "preference",
        confidence: 0.9,
      }),
      mkRow({
        id: "curated_b",
        text: "v2.9.0 ships Tier 1 consolidator",
        kind: "decision",
        confidence: 1.0,
      }),
      mkRow({
        id: "curated_c",
        text: "M3 Ultra reachable via Tailscale",
        kind: "project-state",
        // intentionally no confidence — should render with kind only
      }),
    ];
    const deps = mkDeps({ listMemoriCurated: async () => rows });
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.ok).toBe(true);
    expect(out.context_payload).toContain("CURATED FACTS");
    expect(out.context_payload).toContain("1. [preference/0.90] operator prefers terse responses");
    expect(out.context_payload).toContain("2. [decision/1.00] v2.9.0 ships Tier 1 consolidator");
    expect(out.context_payload).toContain("3. [project-state] M3 Ultra reachable via Tailscale");
    expect(out.sources.memori_curated_count).toBe(3);
    // Header reflects the count even with Cognee disabled.
    expect(out.context_payload).toContain("3 curated + 0 graph hits");
  });

  test("curated rows fall back to [fact] when kind is omitted", async () => {
    const deps = mkDeps({
      listMemoriCurated: async () => [
        mkRow({ id: "curated_x", text: "no kind provided" }),
      ],
    });
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.context_payload).toContain("1. [fact] no kind provided");
  });
});

// ─── 3. Cognee returns hits → GRAPH CONTEXT populated ──────────────────────

describe("hydrateContext — Cognee graph hits", () => {
  test("renders Cognee hits when a relevance query is supplied", async () => {
    const hits: CogneeHit[] = [
      mkHit({ text: "context slimming hydrates from Tier 3 + Tier 4", score: 0.92 }),
      mkHit({ text: "raw transcript stays on disk for audit", score: 0.81 }),
    ];
    const deps = mkDeps({
      listMemoriCurated: async () => [],
      queryCognee: async () => hits,
    });
    const out = await hydrateContext(
      { ...BASE_INPUT, cognee_relevance_query: "current task", cognee_limit: 5 },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(out.context_payload).toContain('GRAPH CONTEXT (top-relevance hits for "current task"):');
    expect(out.context_payload).toContain("- [Cognee [score=0.92]] context slimming hydrates from Tier 3 + Tier 4");
    expect(out.context_payload).toContain("- [Cognee [score=0.81]] raw transcript stays on disk for audit");
    expect(out.sources.cognee_hits_count).toBe(2);
    expect(out.context_payload).toContain("0 curated + 2 graph hits");
  });

  test("null relevance query → Cognee is SKIPPED, queryCognee never invoked", async () => {
    let cogneeCalled = false;
    const deps = mkDeps({
      queryCognee: async () => {
        cogneeCalled = true;
        return [];
      },
    });
    const out = await hydrateContext(
      { ...BASE_INPUT, cognee_relevance_query: null, cognee_limit: 10 },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(cogneeCalled).toBe(false);
    expect(out.context_payload).not.toContain("GRAPH CONTEXT");
  });

  test("empty-string relevance query → Cognee is SKIPPED", async () => {
    let cogneeCalled = false;
    const deps = mkDeps({
      queryCognee: async () => {
        cogneeCalled = true;
        return [];
      },
    });
    const out = await hydrateContext(
      { ...BASE_INPUT, cognee_relevance_query: "   ", cognee_limit: 10 },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(cogneeCalled).toBe(false);
  });
});

// ─── 4. Cognee call fails → continue with just curated, no crash ───────────

describe("hydrateContext — Cognee failures absorbed", () => {
  test("Cognee throws → ok:true, GRAPH CONTEXT omitted, curated still rendered", async () => {
    const deps = mkDeps({
      listMemoriCurated: async () => [
        mkRow({ id: "curated_keep", text: "this survives the cognee outage", kind: "fact" }),
      ],
      queryCognee: async () => {
        throw new Error("cognee transport: ECONNREFUSED");
      },
    });
    const out = await hydrateContext(
      { ...BASE_INPUT, cognee_relevance_query: "anything", cognee_limit: 3 },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(out.context_payload).toContain("this survives the cognee outage");
    expect(out.context_payload).not.toContain("GRAPH CONTEXT");
    expect(out.sources.memori_curated_count).toBe(1);
    expect(out.sources.cognee_hits_count).toBe(0);
  });
});

// ─── 5. Memori call fails → returns ok:false with error string ─────────────

describe("hydrateContext — Memori failure", () => {
  test("listMemoriCurated throws → ok:false, error populated, no crash", async () => {
    const deps = mkDeps({
      listMemoriCurated: async () => {
        throw new Error("memori transport: ECONNREFUSED");
      },
    });
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("listMemoriCurated threw");
    expect(out.error).toContain("ECONNREFUSED");
    expect(out.sources.memori_curated_count).toBe(0);
  });
});

// ─── 6. Limit enforcement ─────────────────────────────────────────────────

describe("hydrateContext — limit enforcement", () => {
  test("50 curated rows + limit=20 → only 20 rendered", async () => {
    const big: MemoriCuratedRow[] = Array.from({ length: 50 }, (_, i) =>
      mkRow({ id: `curated_${i}`, text: `row #${i}`, kind: "fact" }),
    );
    const deps = mkDeps({ listMemoriCurated: async () => big });
    const out = await hydrateContext(
      { ...BASE_INPUT, recent_curated_limit: 20 },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(out.sources.memori_curated_count).toBe(20);
    // First 20 must be present, the 21st must NOT be.
    expect(out.context_payload).toContain("20. [fact] row #19");
    expect(out.context_payload).not.toContain("21. [fact] row #20");
  });

  test("Cognee limit is respected (3 hits returned, limit=2 → only 2 rendered)", async () => {
    const deps = mkDeps({
      queryCognee: async () => [
        mkHit({ text: "alpha" }),
        mkHit({ text: "beta" }),
        mkHit({ text: "gamma" }),
      ],
    });
    const out = await hydrateContext(
      {
        ...BASE_INPUT,
        cognee_relevance_query: "test",
        cognee_limit: 2,
      },
      deps,
    );
    expect(out.sources.cognee_hits_count).toBe(2);
    expect(out.context_payload).toContain("alpha");
    expect(out.context_payload).toContain("beta");
    expect(out.context_payload).not.toContain("gamma");
  });

  test("recent_curated_limit floor: zero/negative clamps to 1", async () => {
    const deps = mkDeps({
      listMemoriCurated: async ({ limit }) => {
        // Stub asserts the deps received a clamped >=1 limit.
        expect(limit).toBeGreaterThanOrEqual(1);
        return [];
      },
    });
    const out1 = await hydrateContext(
      { ...BASE_INPUT, recent_curated_limit: 0 },
      deps,
    );
    expect(out1.ok).toBe(true);
    const out2 = await hydrateContext(
      { ...BASE_INPUT, recent_curated_limit: -5 },
      deps,
    );
    expect(out2.ok).toBe(true);
  });
});

// ─── 7. Payload structure: open/close markers always frame the block ──────

describe("hydrateContext — payload structure", () => {
  test("opens with `[memory-context-hydration · ...]` and closes with `[/memory-context-hydration]`", async () => {
    const deps = mkDeps({});
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.context_payload.startsWith("[memory-context-hydration · ")).toBe(true);
    expect(out.context_payload.endsWith(CLOSE_MARKER)).toBe(true);
  });

  test("counts in header match the data block content", async () => {
    const deps = mkDeps({
      listMemoriCurated: async () => [
        mkRow({ id: "curated_1", text: "x" }),
        mkRow({ id: "curated_2", text: "y" }),
      ],
      queryCognee: async () => [mkHit({ text: "z" })],
    });
    const out = await hydrateContext(
      { ...BASE_INPUT, cognee_relevance_query: "q", cognee_limit: 5 },
      deps,
    );
    expect(out.context_payload).toContain("2 curated + 1 graph hits");
  });

  test("timestamp in header reflects deps.now()", async () => {
    const deps = mkDeps({ now: fixedClock("2030-01-02T03:04:05.000Z") });
    const out = await hydrateContext(BASE_INPUT, deps);
    expect(out.context_payload).toContain("2030-01-02T03:04:05.000Z");
  });
});

// ─── formatHydrationPayload (pure, no I/O) standalone ──────────────────────

describe("formatHydrationPayload (pure)", () => {
  test("zero data still produces well-bounded marker block", () => {
    const out = formatHydrationPayload({
      ts: new Date("2026-05-23T00:00:00.000Z"),
      curated: [],
      cognee: [],
      cogneeQuery: null,
    });
    expect(out).toContain("[memory-context-hydration · 2026-05-23T00:00:00.000Z · 0 curated + 0 graph hits]");
    expect(out).toContain(CLOSE_MARKER);
  });

  test("graph hits without query → generic graph label", () => {
    const out = formatHydrationPayload({
      ts: new Date("2026-05-23T00:00:00.000Z"),
      curated: [],
      cognee: [{ text: "a hit" }],
      cogneeQuery: null,
    });
    expect(out).toContain("GRAPH CONTEXT (top-relevance hits):");
    expect(out).toContain("- [Cognee] a hit");
  });
});

// ─── config loader ─────────────────────────────────────────────────────────

describe("loadContextHydrationConfig", () => {
  test("missing file → returns DEFAULT_CONFIG", () => {
    const cfg = loadContextHydrationConfig(
      "/tmp/subctl-test-nonexistent-context-hydration.json",
    );
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  test("env override SUBCTL_CONTEXT_SLIMMING_ENABLED=0 forces enabled:false", () => {
    const prev = process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
    try {
      process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED = "0";
      const cfg = loadContextHydrationConfig(
        "/tmp/subctl-test-nonexistent-context-hydration.json",
      );
      expect(cfg.enabled).toBe(false);
      // Other defaults preserved.
      expect(cfg.recent_curated_limit).toBe(DEFAULT_CONFIG.recent_curated_limit);
    } finally {
      if (prev === undefined) delete process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
      else process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED = prev;
    }
  });

  test("env override accepts 'false' and 'no'", () => {
    const prev = process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
    try {
      for (const v of ["false", "no"]) {
        process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED = v;
        const cfg = loadContextHydrationConfig(
          "/tmp/subctl-test-nonexistent-context-hydration.json",
        );
        expect(cfg.enabled).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
      else process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED = prev;
    }
  });

  test("malformed JSON file → falls back to DEFAULT_CONFIG, doesn't throw", async () => {
    const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const path = `/tmp/subctl-test-context-hydration-malformed-${Date.now()}.json`;
    writeFileSync(path, "{ not valid json");
    try {
      const cfg = loadContextHydrationConfig(path);
      expect(cfg).toEqual(DEFAULT_CONFIG);
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });

  test("file overrides individual fields, defaults the rest", async () => {
    const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const path = `/tmp/subctl-test-context-hydration-${Date.now()}.json`;
    writeFileSync(
      path,
      JSON.stringify({
        recent_curated_limit: 7,
        cognee_relevance_query: "current focus",
      }),
    );
    try {
      const cfg = loadContextHydrationConfig(path);
      expect(cfg.enabled).toBe(true);
      expect(cfg.recent_curated_limit).toBe(7);
      expect(cfg.cognee_limit).toBe(DEFAULT_CONFIG.cognee_limit);
      expect(cfg.cognee_relevance_query).toBe("current focus");
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });

  test("file with empty/whitespace cognee_relevance_query → null", async () => {
    const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const path = `/tmp/subctl-test-context-hydration-${Date.now()}-empty.json`;
    writeFileSync(path, JSON.stringify({ cognee_relevance_query: "   " }));
    try {
      const cfg = loadContextHydrationConfig(path);
      expect(cfg.cognee_relevance_query).toBeNull();
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });
});
