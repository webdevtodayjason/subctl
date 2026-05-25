// dashboard/__tests__/fitness-api.test.ts
//
// v3.3.1 — Kernel Fitness Phase 3 — tests for the read-only ledger helpers
// in dashboard/lib/fitness-api.ts. We test the pure functions directly
// (path resolution, window parsing, jsonl reading, readers with filters,
// computeHealth). The HTTP layer is a thin wrapper around these and is
// covered by manual smoke (start dashboard → curl /api/evy/fitness/*).
//
// File-missing semantics are explicitly tested — a fresh install has no
// ledgers yet and the dashboard must render an empty state, not 500.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeHealth,
  defaultEngagementLedgerPath,
  defaultFitnessLedgerPath,
  parseWindow,
  readEngagementLedger,
  readFitnessLedger,
  readJsonl,
  subctlConfigDir,
} from "../lib/fitness-api";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "fitness-api-test-"));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── path resolution ──────────────────────────────────────────────────────

describe("path resolution", () => {
  test("subctlConfigDir honors SUBCTL_CONFIG_DIR env", () => {
    const orig = process.env.SUBCTL_CONFIG_DIR;
    process.env.SUBCTL_CONFIG_DIR = "/tmp/test-cfg";
    try {
      expect(subctlConfigDir()).toBe("/tmp/test-cfg");
    } finally {
      if (orig === undefined) delete process.env.SUBCTL_CONFIG_DIR;
      else process.env.SUBCTL_CONFIG_DIR = orig;
    }
  });

  test("defaultFitnessLedgerPath points at evy subdir", () => {
    const p = defaultFitnessLedgerPath();
    expect(p).toMatch(/subctl[/\\]evy[/\\]fitness-ledger\.jsonl$/);
  });

  test("defaultEngagementLedgerPath points at evy subdir", () => {
    const p = defaultEngagementLedgerPath();
    expect(p).toMatch(/subctl[/\\]evy[/\\]engagement-ledger\.jsonl$/);
  });
});

// ─── window parsing ───────────────────────────────────────────────────────

describe("parseWindow", () => {
  test("Nh format", () => {
    expect(parseWindow("24h")).toBe(86400);
    expect(parseWindow("1h")).toBe(3600);
    expect(parseWindow("72h")).toBe(72 * 3600);
  });

  test("Nd format", () => {
    expect(parseWindow("7d")).toBe(7 * 86400);
    expect(parseWindow("30d")).toBe(30 * 86400);
  });

  test("missing or malformed returns null", () => {
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow(undefined)).toBeNull();
    expect(parseWindow("")).toBeNull();
    expect(parseWindow("abc")).toBeNull();
    expect(parseWindow("24")).toBeNull();
    expect(parseWindow("0h")).toBeNull();
    expect(parseWindow("-1h")).toBeNull();
  });

  test("case insensitive", () => {
    expect(parseWindow("24H")).toBe(86400);
    expect(parseWindow("7D")).toBe(7 * 86400);
  });
});

// ─── readJsonl ────────────────────────────────────────────────────────────

describe("readJsonl", () => {
  test("missing file returns empty array", () => {
    const out = readJsonl<{ x: number }>(join(workDir, "nope.jsonl"));
    expect(out).toEqual([]);
  });

  test("reads valid jsonl", () => {
    const path = join(workDir, "test.jsonl");
    writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":3}\n');
    const out = readJsonl<{ a: number }>(path);
    expect(out).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  test("skips blank lines", () => {
    const path = join(workDir, "test.jsonl");
    writeFileSync(path, '{"a":1}\n\n{"a":2}\n\n');
    const out = readJsonl<{ a: number }>(path);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("skips malformed lines without throwing", () => {
    const path = join(workDir, "test.jsonl");
    writeFileSync(path, '{"a":1}\nNOT JSON\n{"a":2}\n');
    const out = readJsonl<{ a: number }>(path);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

// ─── readFitnessLedger ────────────────────────────────────────────────────

describe("readFitnessLedger", () => {
  function writeFitness(path: string, hoursAgo: number[]) {
    const now = Date.now();
    const lines = hoursAgo
      .map((h) =>
        JSON.stringify({
          window_start: new Date(now - h * 3600_000).toISOString(),
          window_end: new Date(now - (h - 1) * 3600_000).toISOString(),
          window_seconds: 3600,
          stall_composite: 0.2 + h * 0.01,
          stall_components: null,
          engagement_rate: 0.5 + h * 0.01,
          engagement_counts: { acted: 1, acked: 0, ignored: 0 },
          tick_count: 60,
          reflection_count: 30,
          worker_dispatch_count: 1,
          scaffold_version: "test",
        }),
      )
      .join("\n");
    writeFileSync(path, lines + "\n");
  }

  test("missing file returns []", () => {
    expect(readFitnessLedger(join(workDir, "x.jsonl"))).toEqual([]);
  });

  test("no window returns everything", () => {
    const p = join(workDir, "f.jsonl");
    writeFitness(p, [1, 5, 24, 100]);
    expect(readFitnessLedger(p).length).toBe(4);
  });

  test("window=24h filters to last 24h", () => {
    const p = join(workDir, "f.jsonl");
    writeFitness(p, [1, 5, 24, 100]);
    const out = readFitnessLedger(p, { windowSeconds: 24 * 3600 });
    // hoursAgo=24 is exactly at boundary — entries with window_start >= cutoff
    // are kept. Implementation uses >=, so 24h should be included.
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  test("window=7d filters appropriately", () => {
    const p = join(workDir, "f.jsonl");
    writeFitness(p, [1, 24, 24 * 8]);
    const out = readFitnessLedger(p, { windowSeconds: 7 * 86400 });
    expect(out.length).toBe(2);
  });
});

// ─── readEngagementLedger ─────────────────────────────────────────────────

describe("readEngagementLedger", () => {
  function writeMixed(path: string) {
    const now = Date.now();
    const entries = [
      {
        type: "surface_emitted",
        ts: new Date(now - 1 * 3600_000).toISOString(),
        surface_id: "abc",
        surface_type: "chat_response",
        payload_hash: "h1",
      },
      {
        type: "engagement",
        ts: new Date(now - 1 * 3600_000 + 60000).toISOString(),
        surface_id: "abc",
        outcome: "acted",
        source: "dashboard_click",
      },
      {
        type: "surface_emitted",
        ts: new Date(now - 30 * 3600_000).toISOString(),
        surface_id: "xyz",
        surface_type: "telegram_message",
        payload_hash: "h2",
      },
    ];
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  test("missing file returns []", () => {
    expect(readEngagementLedger(join(workDir, "x.jsonl"))).toEqual([]);
  });

  test("returns mixed entries by default", () => {
    const p = join(workDir, "e.jsonl");
    writeMixed(p);
    const out = readEngagementLedger(p);
    expect(out.length).toBe(3);
  });

  test("type filter narrows to surface_emitted", () => {
    const p = join(workDir, "e.jsonl");
    writeMixed(p);
    const out = readEngagementLedger(p, { type: "surface_emitted" });
    expect(out.length).toBe(2);
    expect(out.every((e) => e.type === "surface_emitted")).toBe(true);
  });

  test("type filter narrows to engagement", () => {
    const p = join(workDir, "e.jsonl");
    writeMixed(p);
    const out = readEngagementLedger(p, { type: "engagement" });
    expect(out.length).toBe(1);
    expect(out[0]?.type).toBe("engagement");
  });

  test("window=24h excludes 30h-old entry", () => {
    const p = join(workDir, "e.jsonl");
    writeMixed(p);
    const out = readEngagementLedger(p, { windowSeconds: 24 * 3600 });
    expect(out.length).toBe(2);
  });
});

// ─── computeHealth ────────────────────────────────────────────────────────

describe("computeHealth", () => {
  function makeWindow(hoursAgo: number, stall: number | null, eng: number | null) {
    const now = Date.now();
    return {
      window_start: new Date(now - hoursAgo * 3600_000).toISOString(),
      window_end: new Date(now - (hoursAgo - 1) * 3600_000).toISOString(),
      window_seconds: 3600,
      stall_composite: stall,
      stall_components: null,
      engagement_rate: eng,
      engagement_counts: { acted: 0, acked: 0, ignored: 0 },
      tick_count: 0,
      reflection_count: 0,
      worker_dispatch_count: 0,
      scaffold_version: "test",
    };
  }

  test("empty entries → red", () => {
    const r = computeHealth([]);
    expect(r.health).toBe("red");
    expect(r.latest_window).toBeNull();
  });

  test("< 5 valid windows → red (insufficient data)", () => {
    const r = computeHealth([
      makeWindow(1, 0.2, 0.5),
      makeWindow(2, 0.2, 0.5),
    ]);
    expect(r.health).toBe("red");
    expect(r.reason).toContain("only");
  });

  test("5+ valid windows, both metrics non-degrading + high engagement → green", () => {
    const entries = [
      makeWindow(5, 0.3, 0.6),
      makeWindow(4, 0.28, 0.62),
      makeWindow(3, 0.26, 0.64),
      makeWindow(2, 0.24, 0.66),
      makeWindow(1, 0.22, 0.68),
    ];
    const r = computeHealth(entries);
    expect(r.health).toBe("green");
  });

  test("trend improving but mean engagement ≤ 30% → yellow", () => {
    const entries = [
      makeWindow(5, 0.3, 0.20),
      makeWindow(4, 0.28, 0.22),
      makeWindow(3, 0.26, 0.24),
      makeWindow(2, 0.24, 0.26),
      makeWindow(1, 0.22, 0.28),
    ];
    const r = computeHealth(entries);
    expect(r.health).toBe("yellow");
  });

  test("stall trending up → red", () => {
    const entries = [
      makeWindow(5, 0.1, 0.5),
      makeWindow(4, 0.15, 0.5),
      makeWindow(3, 0.2, 0.5),
      makeWindow(2, 0.25, 0.5),
      makeWindow(1, 0.3, 0.5),
    ];
    const r = computeHealth(entries);
    expect(r.health).toBe("red");
    expect(r.reason).toContain("stall");
  });

  test("engagement trending down → red", () => {
    const entries = [
      makeWindow(5, 0.2, 0.7),
      makeWindow(4, 0.2, 0.6),
      makeWindow(3, 0.2, 0.5),
      makeWindow(2, 0.2, 0.4),
      makeWindow(1, 0.2, 0.3),
    ];
    const r = computeHealth(entries);
    expect(r.health).toBe("red");
    expect(r.reason).toContain("engagement");
  });

  test("null metrics excluded from validity count", () => {
    const entries = [
      makeWindow(5, null, 0.5),
      makeWindow(4, null, 0.5),
      makeWindow(3, 0.2, 0.5),
      makeWindow(2, 0.2, 0.5),
      makeWindow(1, 0.2, 0.5),
    ];
    const r = computeHealth(entries);
    // Only 3 valid stall windows (need ≥5)
    expect(r.health).toBe("red");
    expect(r.reason).toContain("only");
  });

  test("latest_window is the most recent by window_start", () => {
    const entries = [
      makeWindow(3, 0.2, 0.5),
      makeWindow(1, 0.3, 0.6),
      makeWindow(2, 0.25, 0.55),
    ];
    const r = computeHealth(entries);
    expect(r.latest_window?.stall_composite).toBe(0.3);
  });
});
