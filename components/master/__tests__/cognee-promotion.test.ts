// components/master/__tests__/cognee-promotion.test.ts
//
// Tests for the Cognee write path — Tier 3 → Tier 4 promotion ticker
// introduced in v2.8.15. Every external surface (curated-table reader,
// `cogneeRemember`, entity scope, statePath, clock) is injected via
// `_setDepsForTesting` so the suite runs hermetic — no sidecars, no
// real bun:sqlite open.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  getState,
  isPromotionArmed,
  runOneTick,
  startPromotionTicker,
  type CuratedMemoriRow,
  type PromotionDeps,
} from "../cognee-promotion";
import type { CogneeResult } from "../cognee-client";

// ─── helpers ─────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  ts: string,
  over: Partial<CuratedMemoriRow> = {},
): CuratedMemoriRow {
  return {
    id,
    entity_id: "jason",
    source_event_ids: JSON.stringify([`raw_${id}`]),
    memory: `curated memory ${id}`,
    kind: "preference",
    reason: "test fixture",
    confidence: 0.85,
    reviewer_model: "test/model",
    ts,
    ...over,
  };
}

interface MockState {
  listCuratedCalls: Array<{
    afterTs: string | null;
    afterId: string | null;
    limit: number;
  }>;
  cogneeRememberCalls: Array<{ text: string; metadata: Record<string, unknown> }>;
  rowsByCall: CuratedMemoriRow[][];
  failFor: Set<string>;
}

function makeMocks(opts: {
  rows: CuratedMemoriRow[] | CuratedMemoriRow[][];
  failFor?: string[];
  statePath: string;
}): { deps: Partial<PromotionDeps>; state: MockState } {
  const rowsByCall: CuratedMemoriRow[][] = Array.isArray(opts.rows[0])
    ? (opts.rows as CuratedMemoriRow[][])
    : [opts.rows as CuratedMemoriRow[]];

  const state: MockState = {
    listCuratedCalls: [],
    cogneeRememberCalls: [],
    rowsByCall,
    failFor: new Set(opts.failFor ?? []),
  };

  const deps: Partial<PromotionDeps> = {
    listCurated: (args) => {
      state.listCuratedCalls.push(args);
      // Pop the next pre-staged batch, defaulting to [] once exhausted so
      // multi-tick tests can assert "no new curated rows".
      const next = state.rowsByCall.shift() ?? [];
      return next;
    },
    cogneeRemember: async (input): Promise<CogneeResult<{ id: string | null }>> => {
      state.cogneeRememberCalls.push({
        text: input.text,
        metadata: (input.metadata ?? {}) as Record<string, unknown>,
      });
      const memoriId = (input.metadata as { memori_id?: string } | undefined)
        ?.memori_id;
      if (memoriId && state.failFor.has(memoriId)) {
        return { ok: false, error: `cognee HTTP 500: synthetic fail for ${memoriId}` };
      }
      return { ok: true, data: { id: `cognee_${memoriId ?? "anon"}` } };
    },
    entityId: () => "jason",
    statePath: opts.statePath,
    now: () => 1_700_000_000_000,
    batchLimit: 200,
  };
  return { deps, state };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cognee-promotion-"));
  _resetDepsForTesting();
});

afterEach(() => {
  _resetDepsForTesting();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── tests ───────────────────────────────────────────────────────────────

describe("runOneTick — no new rows", () => {
  test("returns no-op result + leaves watermark unchanged", async () => {
    const statePath = join(tempDir, "state.json");
    const { deps, state } = makeMocks({ rows: [], statePath });
    _setDepsForTesting(deps);

    const result = await runOneTick();

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.errored).toBe(0);
    expect(result.watermark_ts).toBeNull();
    expect(result.watermark_id).toBeNull();
    expect(state.cogneeRememberCalls).toHaveLength(0);
    // State file written so last_run_at_ms moves even on a no-op tick.
    expect(existsSync(statePath)).toBe(true);
    const snap = getState();
    expect(snap.last_run_at_ms).toBe(1_700_000_000_000);
    expect(snap.last_promoted_ts).toBeNull();
  });
});

describe("runOneTick — happy path", () => {
  test("promotes N rows, watermark = (max ts, max id), state persisted", async () => {
    const statePath = join(tempDir, "state.json");
    const rows = [
      makeRow("a", "2026-05-21T01:00:00.000Z"),
      makeRow("b", "2026-05-21T02:00:00.000Z"),
      makeRow("c", "2026-05-21T03:00:00.000Z"),
    ];
    const { deps, state } = makeMocks({ rows, statePath });
    _setDepsForTesting(deps);

    const result = await runOneTick();

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.promoted).toBe(3);
    expect(result.errored).toBe(0);
    expect(result.watermark_ts).toBe("2026-05-21T03:00:00.000Z");
    expect(result.watermark_id).toBe("c");
    // Each curated row → exactly one cogneeRemember call.
    expect(state.cogneeRememberCalls).toHaveLength(3);
    expect(state.cogneeRememberCalls[0]!.text).toBe("curated memory a");
    expect(state.cogneeRememberCalls[0]!.metadata.source).toBe("memori-tier3-promotion");
    expect(state.cogneeRememberCalls[0]!.metadata.memori_id).toBe("a");
    expect(state.cogneeRememberCalls[0]!.metadata.kind).toBe("preference");
    expect(state.cogneeRememberCalls[0]!.metadata.confidence).toBe(0.85);
    expect(state.cogneeRememberCalls[0]!.metadata.reviewer_model).toBe("test/model");
    expect(state.cogneeRememberCalls[0]!.metadata.source_event_ids).toEqual(["raw_a"]);
    // State file: watermark advances to the last row + total_promoted counter.
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.last_promoted_ts).toBe("2026-05-21T03:00:00.000Z");
    expect(persisted.last_promoted_id).toBe("c");
    expect(persisted.total_promoted).toBe(3);
    expect(persisted.errors).toEqual([]);
  });
});

describe("runOneTick — mixed success and failure", () => {
  test("watermark advances past successes; failures recorded; ordering preserved", async () => {
    const statePath = join(tempDir, "state.json");
    const rows = [
      makeRow("a", "2026-05-21T01:00:00.000Z"),
      makeRow("b", "2026-05-21T02:00:00.000Z"),
      makeRow("c", "2026-05-21T03:00:00.000Z"),
      makeRow("d", "2026-05-21T04:00:00.000Z"),
    ];
    // Fail the middle one — successes before AND after still advance.
    const { deps, state } = makeMocks({
      rows,
      failFor: ["b"],
      statePath,
    });
    _setDepsForTesting(deps);

    const result = await runOneTick();

    expect(result.ok).toBe(false);
    expect(result.scanned).toBe(4);
    expect(result.promoted).toBe(3);
    expect(result.errored).toBe(1);
    // Watermark should be the LAST successfully-promoted row (d), NOT
    // pinned at the failed row (b) — we want subsequent ticks to
    // re-attempt the failed row's id via the bare-id-watermark query
    // path (it's strictly less than d's ts).
    expect(result.watermark_ts).toBe("2026-05-21T04:00:00.000Z");
    expect(result.watermark_id).toBe("d");
    // Every row attempted; failure recorded in errors[].
    expect(state.cogneeRememberCalls).toHaveLength(4);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.total_promoted).toBe(3);
    expect(persisted.errors).toHaveLength(1);
    expect(persisted.errors[0].memori_id).toBe("b");
    expect(persisted.errors[0].error).toContain("synthetic fail for b");
  });

  test("error ring capped at 50 — older entries evicted FIFO", async () => {
    const statePath = join(tempDir, "state.json");
    // 60 rows, all failing → ring should keep last 50.
    const rows = Array.from({ length: 60 }, (_, i) =>
      makeRow(`x${String(i).padStart(3, "0")}`, `2026-05-21T${String(i).padStart(2, "0")}:00:00.000Z`),
    );
    const { deps } = makeMocks({
      rows,
      failFor: rows.map((r) => r.id),
      statePath,
    });
    _setDepsForTesting(deps);

    const result = await runOneTick();

    expect(result.promoted).toBe(0);
    expect(result.errored).toBe(60);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.errors).toHaveLength(50);
    // Newest preserved.
    expect(persisted.errors[49].memori_id).toBe("x059");
    // Oldest evicted (x000-x009 dropped; first kept is x010).
    expect(persisted.errors[0].memori_id).toBe("x010");
  });
});

describe("runOneTick — watermark persistence across restart", () => {
  test("re-hydrated state forwards the next query past the prior watermark", async () => {
    const statePath = join(tempDir, "state.json");

    // First tick: promote 2 rows.
    {
      const { deps } = makeMocks({
        rows: [
          makeRow("a", "2026-05-21T01:00:00.000Z"),
          makeRow("b", "2026-05-21T02:00:00.000Z"),
        ],
        statePath,
      });
      _setDepsForTesting(deps);
      const r = await runOneTick();
      expect(r.watermark_id).toBe("b");
    }

    // Simulate restart: reset module state, re-point at the same statePath,
    // pre-stage 1 new row.
    _resetDepsForTesting();
    {
      const { deps, state } = makeMocks({
        rows: [makeRow("c", "2026-05-21T03:00:00.000Z")],
        statePath,
      });
      _setDepsForTesting(deps);
      const r = await runOneTick();
      expect(r.watermark_id).toBe("c");
      // The query passed the rehydrated watermark down to listCurated —
      // proves we did not re-ingest a/b from scratch.
      expect(state.listCuratedCalls).toHaveLength(1);
      expect(state.listCuratedCalls[0]!.afterTs).toBe("2026-05-21T02:00:00.000Z");
      expect(state.listCuratedCalls[0]!.afterId).toBe("b");
      // total_promoted should be cumulative across the restart.
      const persisted = JSON.parse(readFileSync(statePath, "utf8"));
      expect(persisted.total_promoted).toBe(3);
    }
  });
});

describe("runOneTick — payload provenance", () => {
  test("CSV-style source_event_ids (older rows) still parses into an array", async () => {
    const statePath = join(tempDir, "state.json");
    const row = makeRow("legacy", "2026-05-21T01:00:00.000Z", {
      source_event_ids: "raw_1, raw_2 ,raw_3",
    });
    const { deps, state } = makeMocks({ rows: [row], statePath });
    _setDepsForTesting(deps);

    await runOneTick();

    expect(state.cogneeRememberCalls).toHaveLength(1);
    expect(state.cogneeRememberCalls[0]!.metadata.source_event_ids).toEqual([
      "raw_1",
      "raw_2",
      "raw_3",
    ]);
  });

  test("metadata bag includes memori_ts and entity_id for downstream provenance queries", async () => {
    const statePath = join(tempDir, "state.json");
    const row = makeRow("a", "2026-05-21T01:00:00.000Z");
    const { deps, state } = makeMocks({ rows: [row], statePath });
    _setDepsForTesting(deps);

    await runOneTick();

    const md = state.cogneeRememberCalls[0]!.metadata;
    expect(md.memori_ts).toBe("2026-05-21T01:00:00.000Z");
    expect(md.entity_id).toBe("jason");
  });
});

describe("startPromotionTicker — lifecycle", () => {
  test("stop() prevents any future tick — gate-off equivalent", async () => {
    const statePath = join(tempDir, "state.json");
    const { deps, state } = makeMocks({
      rows: [makeRow("a", "2026-05-21T01:00:00.000Z")],
      statePath,
    });
    _setDepsForTesting(deps);

    // Stand up a manual scheduler so we control the clock.
    let bootFn: (() => void) | null = null;
    let intervalFn: (() => void) | null = null;
    const sched = {
      setTimeout: (fn: () => void) => {
        bootFn = fn;
        return 1 as unknown;
      },
      clearTimeout: () => {
        /* noop */
      },
      setInterval: (fn: () => void) => {
        intervalFn = fn;
        return 2 as unknown;
      },
      clearInterval: () => {
        /* noop */
      },
    };

    const { startPromotionTicker } = await import("../cognee-promotion");
    const watchdogs: Array<{ id: string }> = [];
    const stop = startPromotionTicker({
      intervalMs: 1_000,
      registerWatchdog: (entry) => {
        watchdogs.push({ id: entry.id });
      },
      scheduler: sched,
      firstTickDelayMs: 100,
    });

    // Gate-off path: stop immediately. The boot timer SHOULD have been
    // scheduled but never fired; the interval should never be installed.
    stop();

    expect(watchdogs).toHaveLength(1);
    expect(watchdogs[0]!.id).toBe("cognee-promotion");
    expect(state.cogneeRememberCalls).toHaveLength(0);

    // Even if a stale handle somehow fired, the in-flight guard should
    // short-circuit. Force it for paranoia: bootFn() AFTER stop() should
    // still cleanly no-op the tick (stopped=true).
    if (bootFn) await Promise.resolve(bootFn());
    expect(state.cogneeRememberCalls).toHaveLength(0);
    // Mark intervalFn as observed to silence "assigned but never read"
    // linters — it's the long-lived recurring handle and we don't drive
    // it in this gate-off test (that's the steady-state path).
    expect(intervalFn).toBeNull();
  });
});

// ─── armed-flag state machine ────────────────────────────────────────────
//
// CodeRabbit MAJOR (server.ts:5497-5515): `bindCogneePromotionState`'s
// `armed` flag must reflect RUNTIME ticker state — not a static gate
// evaluation that stays `true` even when the ticker never started
// (Cognee unreachable at boot, arm threw, gate disabled mid-runtime).
//
// The flag lives in cognee-promotion.ts (alongside the lifecycle it
// reflects) and is read by server.ts via `isPromotionArmed()`.
//
// TODO: integration test for broadcast events
// (cognee_promotion_tick_success / cognee_promotion_tick_error) — unit
// scope here covers the armed flag only; broadcast contracts need
// master-boot integration coverage.
describe("armed flag — runtime lifecycle", () => {
  function makeManualScheduler(): {
    sched: NonNullable<Parameters<typeof startPromotionTicker>[0]["scheduler"]>;
    fire: () => void;
  } {
    let bootFn: (() => void) | null = null;
    const sched = {
      setTimeout: (fn: () => void) => {
        bootFn = fn;
        return 1 as unknown;
      },
      clearTimeout: () => {
        /* noop */
      },
      setInterval: () => 2 as unknown,
      clearInterval: () => {
        /* noop */
      },
    };
    return {
      sched,
      fire: () => {
        if (bootFn) bootFn();
      },
    };
  }

  test("armed flips to true after successful startPromotionTicker", () => {
    expect(isPromotionArmed()).toBe(false);

    const { sched } = makeManualScheduler();
    const stop = startPromotionTicker({
      intervalMs: 1_000,
      registerWatchdog: () => {
        /* registered */
      },
      scheduler: sched,
      firstTickDelayMs: 100,
    });

    expect(isPromotionArmed()).toBe(true);
    stop();
  });

  test("armed flips back to false after stop()", () => {
    const { sched } = makeManualScheduler();
    const stop = startPromotionTicker({
      intervalMs: 1_000,
      registerWatchdog: () => {
        /* registered */
      },
      scheduler: sched,
      firstTickDelayMs: 100,
    });
    expect(isPromotionArmed()).toBe(true);

    stop();
    expect(isPromotionArmed()).toBe(false);

    // Idempotent: a second stop() must not flip armed back on or throw.
    stop();
    expect(isPromotionArmed()).toBe(false);
  });

  test("armed stays false when registerWatchdog throws during start", () => {
    expect(isPromotionArmed()).toBe(false);

    const { sched } = makeManualScheduler();
    expect(() =>
      startPromotionTicker({
        intervalMs: 1_000,
        registerWatchdog: () => {
          throw new Error("synthetic registerWatchdog failure");
        },
        scheduler: sched,
        firstTickDelayMs: 100,
      }),
    ).toThrow("synthetic registerWatchdog failure");

    // Invariant: `_armed = true` is the last step in startPromotionTicker,
    // so an earlier throw must leave armed false.
    expect(isPromotionArmed()).toBe(false);
  });
});

describe("runOneTick — cogneeRemember throws (transport-level explosion)", () => {
  test("treated as a recorded error, watermark advances past successes", async () => {
    const statePath = join(tempDir, "state.json");
    const rows = [
      makeRow("a", "2026-05-21T01:00:00.000Z"),
      makeRow("b", "2026-05-21T02:00:00.000Z"),
    ];
    const { deps } = makeMocks({ rows, statePath });
    _setDepsForTesting({
      ...deps,
      cogneeRemember: async (input) => {
        if (
          (input.metadata as { memori_id?: string } | undefined)?.memori_id === "a"
        ) {
          throw new Error("ECONNREFUSED 127.0.0.1:8745");
        }
        return { ok: true, data: { id: "cognee_b" } };
      },
    });

    const result = await runOneTick();

    expect(result.ok).toBe(false);
    expect(result.errored).toBe(1);
    expect(result.promoted).toBe(1);
    // Watermark = the successful row.
    expect(result.watermark_id).toBe("b");
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(persisted.errors[0].error).toContain("cognee remember threw");
    expect(persisted.errors[0].error).toContain("ECONNREFUSED");
  });
});
