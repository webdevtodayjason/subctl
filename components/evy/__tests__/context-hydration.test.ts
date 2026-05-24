// v2.10.0 Memory Cycle Phase 4 — context-hydration unit tests.
// v2.10.1 — extended with CodeRabbit pass-1 coverage:
//   - throw-path audit emission (logDecision + broadcast)
//   - seq guard against stale-overwrite (boot vs post-compact races)
//
// Exercises the pure entry point `hydrateContext` against deps-injected
// stubs (no real Memori/Cognee sidecars). Covers the seven cases the
// spec calls out, plus a couple of structural invariants (open/close
// markers always present, ordering deterministic), plus the
// `applyHydrationOutcome` reducer exported from server.ts.

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
  HydrationResult,
  MemoriCuratedRow,
} from "../context-hydration";
import {
  applyHydrationOutcome,
  dropEphemeralMessages,
  stripEphemeralInPlace,
} from "../server";
import type { ApplyHydrationOutcomeDeps } from "../server";

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

  test("env override is case-insensitive + whitespace-tolerant (CodeRabbit pass-3)", () => {
    const prev = process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
    try {
      for (const v of ["FALSE", "No", " no ", "  0  ", "False", "NO"]) {
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

  test("env override leaves enabled:true for truthy / unrelated values", () => {
    const prev = process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
    try {
      for (const v of ["1", "true", "yes", "on", "FALSEY"]) {
        process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED = v;
        const cfg = loadContextHydrationConfig(
          "/tmp/subctl-test-nonexistent-context-hydration.json",
        );
        expect(cfg.enabled).toBe(true);
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

// ─── applyHydrationOutcome reducer (v2.10.1 CodeRabbit pass-1) ────────────
//
// Tests the seq-guarded outcome reducer extracted from scheduleHydration.
// All branches are exercised: success, ok:false, throw, plus the
// supersession variants of each.

function mkOutcomeDeps(
  overrides: Partial<ApplyHydrationOutcomeDeps>,
): ApplyHydrationOutcomeDeps & {
  // expose spies for assertion
  __payloads: string[];
  __decisions: Array<{ project: string; action: string; rationale: string }>;
  __broadcasts: Array<{ event: string; payload: unknown }>;
  __logs: string[];
} {
  const payloads: string[] = [];
  const decisions: Array<{ project: string; action: string; rationale: string }> = [];
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const logs: string[] = [];
  return {
    reason: "boot",
    mySeq: 1,
    currentSeq: 1,
    result: null,
    threwMessage: null,
    setPayload: (p) => payloads.push(p),
    logDecision: (e) => decisions.push(e),
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    log: (l) => logs.push(l),
    now: () => new Date("2026-05-23T17:30:00.000Z"),
    ...overrides,
    __payloads: payloads,
    __decisions: decisions,
    __broadcasts: broadcasts,
    __logs: logs,
  };
}

function mkSuccessResult(payload: string, counts?: Partial<HydrationResult["sources"]>): HydrationResult {
  return {
    ok: true,
    context_payload: payload,
    sources: {
      memori_curated_count: counts?.memori_curated_count ?? 1,
      cognee_hits_count: counts?.cognee_hits_count ?? 0,
      tier1_chars: counts?.tier1_chars ?? 0,
    },
  };
}

function mkFailureResult(err: string): HydrationResult {
  return {
    ok: false,
    context_payload: "",
    sources: {
      memori_curated_count: 0,
      cognee_hits_count: 0,
      tier1_chars: 0,
    },
    error: err,
  };
}

describe("applyHydrationOutcome — success path", () => {
  test("ok:true + not superseded → setPayload + broadcast + audit 'context_hydration_ready'", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 7,
      currentSeq: 7,
      result: mkSuccessResult(
        "[memory-context-hydration · ts · 2 curated + 0 graph hits]\n\nCURATED FACTS:\n1. [fact] hi\n\n[/memory-context-hydration]",
        { memori_curated_count: 2, cognee_hits_count: 0, tier1_chars: 1500 },
      ),
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("applied");
    expect(deps.__payloads).toHaveLength(1);
    expect(deps.__payloads[0]).toContain("[memory-context-hydration");
    expect(deps.__broadcasts).toHaveLength(1);
    expect(deps.__broadcasts[0]?.event).toBe("context_hydration_ready");
    // CodeRabbit pass-3: durable success audit lands in decisions.jsonl
    // symmetric with the failure path.
    expect(deps.__decisions).toHaveLength(1);
    expect(deps.__decisions[0]?.action).toBe("context_hydration_ready");
    expect(deps.__decisions[0]?.project).toBe("_master");
    expect(deps.__decisions[0]?.rationale).toContain("boot");
    expect(deps.__decisions[0]?.rationale).toContain("2 curated");
    expect(deps.__decisions[0]?.rationale).toContain("0 graph hits");
    expect(deps.__decisions[0]?.rationale).toContain("1500 tier1_chars");
  });
});

describe("applyHydrationOutcome — ok:false failure path", () => {
  test("ok:false + not superseded → logDecision + broadcast 'context_hydration_failed', no payload write", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkFailureResult("memori transport: ECONNREFUSED"),
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("logged_failure");
    expect(deps.__payloads).toHaveLength(0);
    expect(deps.__decisions).toHaveLength(1);
    expect(deps.__decisions[0]?.action).toBe("context_hydration_failed");
    expect(deps.__decisions[0]?.rationale).toContain("ECONNREFUSED");
    expect(deps.__broadcasts).toHaveLength(1);
    expect(deps.__broadcasts[0]?.event).toBe("context_hydration_failed");
    expect((deps.__broadcasts[0]?.payload as { error: string }).error).toContain("ECONNREFUSED");
  });
});

describe("applyHydrationOutcome — throw path (CodeRabbit pass-1 Fix 2)", () => {
  test("threw + not superseded → audit BOTH logDecision AND broadcast", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: null,
      threwMessage: "deps wiring blew up",
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("logged_failure");
    // Pre-2.10.1 this was silent. Both audit channels MUST fire.
    expect(deps.__decisions).toHaveLength(1);
    expect(deps.__decisions[0]?.action).toBe("context_hydration_failed");
    expect(deps.__decisions[0]?.rationale).toContain("deps wiring blew up");
    expect(deps.__broadcasts).toHaveLength(1);
    expect(deps.__broadcasts[0]?.event).toBe("context_hydration_failed");
    // Payload stays null — no write attempted.
    expect(deps.__payloads).toHaveLength(0);
  });

  test("throw with null message → still emits failure audit with 'unknown'", () => {
    const deps = mkOutcomeDeps({
      result: null,
      threwMessage: null,
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("logged_failure");
    expect(deps.__decisions[0]?.rationale).toContain("unknown");
  });

  test("logDecision throwing does NOT prevent broadcast", () => {
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: null,
      threwMessage: "x",
      setPayload: () => {},
      logDecision: () => {
        throw new Error("disk full");
      },
      broadcast: (e, p) => broadcasts.push({ event: e, payload: p }),
      log: () => {},
      now: () => new Date(),
    });
    expect(action).toBe("logged_failure");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.event).toBe("context_hydration_failed");
  });

  test("broadcast throwing does NOT bubble out of applyHydrationOutcome", () => {
    expect(() =>
      applyHydrationOutcome({
        reason: "boot",
        mySeq: 1,
        currentSeq: 1,
        result: null,
        threwMessage: "x",
        setPayload: () => {},
        logDecision: () => {},
        broadcast: () => {
          throw new Error("sse client gone");
        },
        log: () => {},
        now: () => new Date(),
      }),
    ).not.toThrow();
  });
});

describe("applyHydrationOutcome — seq guard (CodeRabbit pass-1 Fix 3)", () => {
  test("ok:true + mySeq < currentSeq → 'superseded', no payload write, no broadcast", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 1,
      currentSeq: 2, // a fresher request came in after this one
      result: mkSuccessResult("STALE BOOT PAYLOAD"),
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("superseded");
    expect(deps.__payloads).toHaveLength(0);
    expect(deps.__broadcasts).toHaveLength(0);
    expect(deps.__decisions).toHaveLength(0);
    // We do log to stderr so the operator can see the discard happened.
    expect(deps.__logs.some((l) => l.includes("superseded"))).toBe(true);
  });

  test("ok:false + superseded → 'superseded' (no stale audit noise)", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 1,
      currentSeq: 2,
      result: mkFailureResult("transport"),
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("superseded");
    // Don't pollute the audit trail with a stale failure.
    expect(deps.__decisions).toHaveLength(0);
    expect(deps.__broadcasts).toHaveLength(0);
  });

  test("threw + superseded → 'ignored_superseded_failure', no audit noise", () => {
    const deps = mkOutcomeDeps({
      reason: "boot",
      mySeq: 1,
      currentSeq: 2,
      result: null,
      threwMessage: "would have been a failure",
    });
    const action = applyHydrationOutcome(deps);
    expect(action).toBe("ignored_superseded_failure");
    expect(deps.__decisions).toHaveLength(0);
    expect(deps.__broadcasts).toHaveLength(0);
    expect(deps.__logs.some((l) => l.includes("superseded then threw"))).toBe(true);
  });

  test("fast post-compact wins over slow boot (race scenario)", () => {
    // Simulates the documented race: boot scheduled first (seq=1), then
    // post-compact scheduled (seq=2), then BOOT's hydrateContext
    // resolves AFTER post-compact's, with stale data. The reducer
    // discards boot's stale payload; the post-compact payload wins.
    let payload: string | null = null;
    const setPayload = (p: string) => { payload = p; };
    const now = () => new Date("2026-05-23T17:30:00.000Z");
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const broadcast = (e: string, p: unknown) => broadcasts.push({ event: e, payload: p });
    // Step 1: post-compact resolves first with currentSeq=2, mySeq=2 → applies.
    const postCompactAction = applyHydrationOutcome({
      reason: "post-compact",
      mySeq: 2,
      currentSeq: 2,
      result: mkSuccessResult("FRESH POST-COMPACT PAYLOAD"),
      threwMessage: null,
      setPayload,
      logDecision: () => {},
      broadcast,
      log: () => {},
      now,
    });
    expect(postCompactAction).toBe("applied");
    expect(payload).toBe("FRESH POST-COMPACT PAYLOAD");
    // Step 2: boot's stale resolution comes in AFTER. currentSeq still 2,
    // boot's mySeq was 1 → superseded → discarded. Payload UNCHANGED.
    const bootAction = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 2,
      result: mkSuccessResult("STALE BOOT PAYLOAD"),
      threwMessage: null,
      setPayload,
      logDecision: () => {},
      broadcast,
      log: () => {},
      now,
    });
    expect(bootAction).toBe("superseded");
    expect(payload).toBe("FRESH POST-COMPACT PAYLOAD");
    // Only the post-compact 'ready' broadcast should have fired.
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.event).toBe("context_hydration_ready");
  });
});

// ─── applyHydrationOutcome — defensive deps wrapping (CodeRabbit pass-2) ──
//
// The reducer must NEVER throw, regardless of which deps callback blows
// up. State-write contract: returns "applied" only when setPayload
// actually succeeded; if setPayload throws, the reducer degrades to
// "logged_failure" and emits the standard failure audit so observers
// see the breakage. log / logDecision / broadcast failures are
// individually swallowed and do NOT downgrade the action.

describe("applyHydrationOutcome — setPayload failure (CodeRabbit pass-2)", () => {
  test("setPayload throws → returns 'logged_failure', payload not committed, failure audit emitted", () => {
    const decisions: Array<{ project: string; action: string; rationale: string }> = [];
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const logs: string[] = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkSuccessResult("PAYLOAD THAT DOES NOT LAND"),
      threwMessage: null,
      setPayload: () => {
        throw new Error("state lock contention");
      },
      logDecision: (e) => decisions.push(e),
      broadcast: (event, payload) => broadcasts.push({ event, payload }),
      log: (l) => logs.push(l),
      now: () => new Date(),
    });
    expect(action).toBe("logged_failure");
    // Failure audit must mention setPayload + the underlying error.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("context_hydration_failed");
    expect(decisions[0]?.rationale).toContain("setPayload threw");
    expect(decisions[0]?.rationale).toContain("state lock contention");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.event).toBe("context_hydration_failed");
    expect((broadcasts[0]?.payload as { error: string }).error).toContain("setPayload threw");
    // The "ready" broadcast must NOT have fired — state never wrote.
    expect(broadcasts.some((b) => b.event === "context_hydration_ready")).toBe(false);
    // The setPayload failure must be loud on stderr too.
    expect(logs.some((l) => l.includes("setPayload threw"))).toBe(true);
  });

  test("setPayload + logDecision + broadcast ALL throw → still returns 'logged_failure' without bubbling", () => {
    // Worst-case: every observable channel is broken. Reducer must
    // still return the right tag and not throw.
    const logs: string[] = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkSuccessResult("X"),
      threwMessage: null,
      setPayload: () => { throw new Error("set"); },
      logDecision: () => { throw new Error("log"); },
      broadcast: () => { throw new Error("bcast"); },
      log: (l) => logs.push(l),
      now: () => new Date(),
    });
    expect(action).toBe("logged_failure");
    // The log channel itself stays alive in this scenario; it
    // captures the breakage of the other channels.
    expect(logs.some((l) => l.includes("setPayload threw"))).toBe(true);
  });
});

describe("applyHydrationOutcome — observational throws don't downgrade 'applied' (CodeRabbit pass-2)", () => {
  test("broadcast throws AFTER setPayload success → still returns 'applied', state IS written", () => {
    // The contract: once setPayload returns, the payload IS committed.
    // A failing broadcast is observational — degrade to "applied" anyway.
    let written: string | null = null;
    const logs: string[] = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkSuccessResult("COMMITTED"),
      threwMessage: null,
      setPayload: (p) => { written = p; },
      logDecision: () => {},
      broadcast: () => { throw new Error("sse client gone"); },
      log: (l) => logs.push(l),
      now: () => new Date(),
    });
    expect(action).toBe("applied");
    expect(written).toBe("COMMITTED");
    // Breakage logged for operator visibility.
    expect(logs.some((l) => l.includes("broadcast(context_hydration_ready) threw"))).toBe(true);
  });

  test("logDecision throwing on success-audit (pass-3) does NOT downgrade 'applied'", () => {
    // CodeRabbit pass-3 added a logDecision call to the success path
    // for symmetric audit. If that throws, state IS still committed —
    // action remains 'applied'.
    let written: string | null = null;
    const logs: string[] = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkSuccessResult("DURABLE"),
      threwMessage: null,
      setPayload: (p) => { written = p; },
      logDecision: () => { throw new Error("decisions.jsonl disk full"); },
      broadcast: () => {},
      log: (l) => logs.push(l),
      now: () => new Date(),
    });
    expect(action).toBe("applied");
    expect(written).toBe("DURABLE");
    // The failure of the audit channel is surfaced on stderr.
    expect(logs.some((l) => l.includes("logDecision threw"))).toBe(true);
  });

  test("log channel throwing in 'applied' branch does NOT bubble", () => {
    let written: string | null = null;
    let action: ReturnType<typeof applyHydrationOutcome> | null = null;
    expect(() => {
      action = applyHydrationOutcome({
        reason: "boot",
        mySeq: 1,
        currentSeq: 1,
        result: mkSuccessResult("DURABLE"),
        threwMessage: null,
        setPayload: (p) => { written = p; },
        logDecision: () => {},
        broadcast: () => {},
        log: () => { throw new Error("stderr closed"); },
        now: () => new Date(),
      });
    }).not.toThrow();
    expect(action).toBe("applied");
    expect(written).toBe("DURABLE");
  });

  test("log channel throwing in 'superseded' branch does NOT bubble", () => {
    let action: ReturnType<typeof applyHydrationOutcome> | null = null;
    expect(() => {
      action = applyHydrationOutcome({
        reason: "boot",
        mySeq: 1,
        currentSeq: 2,
        result: mkSuccessResult("stale"),
        threwMessage: null,
        setPayload: () => {},
        logDecision: () => {},
        broadcast: () => {},
        log: () => { throw new Error("stderr closed"); },
        now: () => new Date(),
      });
    }).not.toThrow();
    expect(action).toBe("superseded");
  });

  test("log channel throwing in 'ignored_superseded_failure' branch does NOT bubble", () => {
    let action: ReturnType<typeof applyHydrationOutcome> | null = null;
    expect(() => {
      action = applyHydrationOutcome({
        reason: "boot",
        mySeq: 1,
        currentSeq: 2,
        result: null,
        threwMessage: "would have failed",
        setPayload: () => {},
        logDecision: () => {},
        broadcast: () => {},
        log: () => { throw new Error("stderr closed"); },
        now: () => new Date(),
      });
    }).not.toThrow();
    expect(action).toBe("ignored_superseded_failure");
  });

  test("now() throwing in failure broadcast → still returns 'logged_failure', payload uses sentinel ts", () => {
    // Defensive: if Date construction blows up (clock-skew faker,
    // tests overriding global Date weirdly, etc.), the broadcast
    // payload should still construct with a sentinel ts.
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const action = applyHydrationOutcome({
      reason: "boot",
      mySeq: 1,
      currentSeq: 1,
      result: mkFailureResult("transport"),
      threwMessage: null,
      setPayload: () => {},
      logDecision: () => {},
      broadcast: (e, p) => broadcasts.push({ event: e, payload: p }),
      log: () => {},
      now: () => {
        throw new Error("Date factory broken");
      },
    });
    expect(action).toBe("logged_failure");
    expect(broadcasts).toHaveLength(1);
    // Payload still constructed despite now() throwing.
    expect((broadcasts[0]?.payload as { ts: string }).ts).toBe("<unknown>");
  });
});

// ─── dropEphemeralMessages — transcript persistence filter (pass-4) ──────
//
// The hydration injection point pushes a `_ephemeral: true` flag on the
// synthetic message so it lives ONLY in the in-memory agent.state.messages
// for the turn it lands on. saveAgentTranscript pipes through this filter
// before writing — durable transcript stays clean across boots.

describe("dropEphemeralMessages — CodeRabbit pass-4", () => {
  test("strips messages tagged `_ephemeral: true`, preserves the rest", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "real user prompt" }] },
      {
        role: "user",
        content: [{ type: "text", text: "[memory-context-hydration · …]" }],
        _ephemeral: true,
      },
      { role: "assistant", content: [{ type: "text", text: "real assistant reply" }] },
    ];
    // bun:test's import of AgentMessage isn't required — the helper
    // narrows on the structural `_ephemeral` flag at runtime. Cast at
    // the test boundary mirrors how server-side code calls it.
    const kept = dropEphemeralMessages(messages as any);
    expect(kept).toHaveLength(2);
    expect((kept[0] as any).content[0].text).toBe("real user prompt");
    expect((kept[1] as any).content[0].text).toBe("real assistant reply");
    // No surviving message carries the ephemeral marker.
    expect(kept.every((m) => (m as { _ephemeral?: boolean })._ephemeral !== true)).toBe(true);
  });

  test("no-op when no messages are marked", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];
    const kept = dropEphemeralMessages(messages as any);
    expect(kept).toHaveLength(2);
    // Ordering preserved.
    expect((kept[0] as any).content[0].text).toBe("a");
    expect((kept[1] as any).content[0].text).toBe("b");
  });

  test("strips multiple ephemeral messages interleaved with real ones", () => {
    // Real-world shape: hydration on boot → operator turn → operator
    // /compact → hydration on post-compact → operator turn. Two
    // separate hydration blocks would land if the daemon persisted
    // and then re-loaded; the filter must catch both.
    const messages = [
      { role: "user", content: [{ type: "text", text: "boot-hydration" }], _ephemeral: true },
      { role: "user", content: [{ type: "text", text: "first prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      { role: "user", content: [{ type: "text", text: "compact-hydration" }], _ephemeral: true },
      { role: "user", content: [{ type: "text", text: "second prompt" }] },
    ];
    const kept = dropEphemeralMessages(messages as any);
    expect(kept).toHaveLength(3);
    expect((kept[0] as any).content[0].text).toBe("first prompt");
    expect((kept[1] as any).content[0].text).toBe("first reply");
    expect((kept[2] as any).content[0].text).toBe("second prompt");
  });

  test("`_ephemeral: false` is treated as a normal (non-ephemeral) message", () => {
    // Defensive: the synthetic-only marker should be `=== true`, not
    // just any truthy value. A user message arriving with
    // `_ephemeral: false` (e.g. an external client setting it) must
    // NOT be silently dropped.
    const messages = [
      { role: "user", content: [{ type: "text", text: "explicit non-ephemeral" }], _ephemeral: false },
      { role: "user", content: [{ type: "text", text: "no flag" }] },
      { role: "user", content: [{ type: "text", text: "ephemeral!" }], _ephemeral: true },
    ];
    const kept = dropEphemeralMessages(messages as any);
    expect(kept).toHaveLength(2);
    expect((kept[0] as any).content[0].text).toBe("explicit non-ephemeral");
    expect((kept[1] as any).content[0].text).toBe("no flag");
  });

  test("empty input returns empty array, never throws", () => {
    expect(dropEphemeralMessages([])).toEqual([]);
  });
});

// ─── config trim (pass-4 Fix 2) ──────────────────────────────────────────

describe("loadContextHydrationConfig — cognee_relevance_query trimmed on store", () => {
  test("file with leading/trailing whitespace stores TRIMMED value", async () => {
    const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const path = `/tmp/subctl-test-context-hydration-trim-${Date.now()}.json`;
    writeFileSync(
      path,
      JSON.stringify({ cognee_relevance_query: "  current focus  " }),
    );
    try {
      const cfg = loadContextHydrationConfig(path);
      // CodeRabbit pass-4: validate-vs-store mismatch — must store
      // the trimmed string, not the raw padded version.
      expect(cfg.cognee_relevance_query).toBe("current focus");
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });

  test("file with tabs / newlines in the surrounding whitespace still trimmed", async () => {
    const { writeFileSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const path = `/tmp/subctl-test-context-hydration-trim2-${Date.now()}.json`;
    writeFileSync(
      path,
      JSON.stringify({ cognee_relevance_query: "\n\tcurrent task\t\n" }),
    );
    try {
      const cfg = loadContextHydrationConfig(path);
      expect(cfg.cognee_relevance_query).toBe("current task");
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  });
});

// ─── stripEphemeralInPlace — one-shot cleanup (CodeRabbit pass-5) ─────────
//
// Pass-4 marked hydration messages with `_ephemeral: true` and the
// persistence filter (dropEphemeralMessages) keeps them off disk. But
// without an in-memory strip, the ephemeral message survives forever
// in agent.state.messages — token bloat on every subsequent supervisor
// call. Pass-5 introduces stripEphemeralInPlace, called immediately
// after the model has consumed the current turn's messages.
//
// The helper MUTATES THE INPUT ARRAY (matching the splice idiom
// compactTranscriptInline uses for orphan-toolResult removal) so the
// pi-agent-core Agent's reference to `state.messages` stays valid.

describe("stripEphemeralInPlace — CodeRabbit pass-5", () => {
  test("removes `_ephemeral: true` entries in place, returns count", () => {
    const messages: any[] = [
      { role: "user", content: "real first prompt" },
      {
        role: "user",
        content: "[memory-context-hydration · …]",
        _ephemeral: true,
      },
      { role: "assistant", content: "real reply" },
    ];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(1);
    // MUTATION in place — original array is now length 2.
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("real first prompt");
    expect(messages[1].content).toBe("real reply");
    // No surviving entry carries the ephemeral marker.
    expect(messages.every((m) => m._ephemeral !== true)).toBe(true);
  });

  test("no-op when no ephemeral messages — array unchanged, returns 0", () => {
    const messages: any[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const before = [...messages];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(0);
    expect(messages).toEqual(before);
  });

  test("strips multiple interleaved ephemeral messages and preserves order", () => {
    const messages: any[] = [
      { role: "user", content: "boot-hydration", _ephemeral: true },
      { role: "user", content: "real prompt 1" },
      { role: "assistant", content: "real reply 1" },
      { role: "user", content: "compact-hydration", _ephemeral: true },
      { role: "user", content: "real prompt 2" },
      { role: "assistant", content: "real reply 2" },
    ];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(2);
    expect(messages).toHaveLength(4);
    // Order of survivors must match input order — splice-from-tail
    // is the correct idiom for that.
    expect(messages.map((m) => m.content)).toEqual([
      "real prompt 1",
      "real reply 1",
      "real prompt 2",
      "real reply 2",
    ]);
  });

  test("strict `=== true` — `_ephemeral: false` does NOT match", () => {
    // Defensive: an external client setting `_ephemeral: false`
    // (i.e. explicitly non-ephemeral) must not be silently dropped.
    const messages: any[] = [
      { role: "user", content: "explicit non-ephemeral", _ephemeral: false },
      { role: "user", content: "no flag at all" },
      { role: "user", content: "real ephemeral", _ephemeral: true },
    ];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("explicit non-ephemeral");
    expect(messages[1].content).toBe("no flag at all");
  });

  test("empty input array — returns 0, no throw", () => {
    const messages: any[] = [];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(0);
    expect(messages).toHaveLength(0);
  });

  test("all-ephemeral array → returns count, array becomes empty", () => {
    const messages: any[] = [
      { role: "user", content: "h1", _ephemeral: true },
      { role: "user", content: "h2", _ephemeral: true },
    ];
    const dropped = stripEphemeralInPlace(messages as any);
    expect(dropped).toBe(2);
    expect(messages).toHaveLength(0);
  });

  test("Phase 4 one-shot semantics: after dispatch + strip, find(_ephemeral) is undefined", () => {
    // Simulates the contract the spec calls for: fire hydration push
    // → run prompt (we represent this as a 'real prompt' landing
    // after the ephemeral) → strip → assert no ephemeral remains.
    // This is the exact assertion the team-lead's spec wanted.
    const messages: any[] = [
      // boot push:
      { role: "user", content: "[memory-context-hydration · …]", _ephemeral: true },
      // operator's actual prompt this turn:
      { role: "user", content: "operator prompt" },
      // assistant's reply lands during agent.prompt:
      { role: "assistant", content: "assistant reply" },
    ];
    // POST-DISPATCH CLEANUP — this is what processOnePrompt calls.
    stripEphemeralInPlace(messages as any);
    // The exact spec assertion: no surviving entry carries _ephemeral.
    expect(messages.find((m) => m._ephemeral === true)).toBeUndefined();
    // And the real conversation remains intact.
    expect(messages.map((m) => m.content)).toEqual([
      "operator prompt",
      "assistant reply",
    ]);
  });
});
