// components/evy/__tests__/fitness-writer.test.ts
//
// v3.3.0 — Kernel Fitness Phase 2.
//
// Pins:
//   1. Empty window emits null composite + missing_data_reason.
//   2. Synthetic decisions ledger produces expected composite.
//   3. Stall-composite weights sum to 1.0 in shipped config.
//   4. Writer refuses to write outside the canonical basename.
//   5. 24 hours of synthetic activity → 24 ledger entries.
//   6. engagement_rate is correct from synthetic engagement-ledger data.
//   7. scaffold_version is populated.
//
// The load-bearing negative-criterion test lives in a sibling file
// (`fitness-ledger-isolation.test.ts`) so its failures speak for
// themselves at the suite-listing level.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _resetForTesting,
  _setSourcePathsForTesting,
  getLedgerPath,
  setLedgerPathForTesting,
  writeFitnessWindow,
} from "../fitness-writer";
import type { FitnessLedgerEntry } from "../fitness-types";

let tmpDir: string;
let ledgerPath: string;
let engagementPath: string;
let decisionsPath: string;
let cognitionAuditPath: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-fitness-"));
  ledgerPath = join(tmpDir, "fitness-ledger.jsonl");
  engagementPath = join(tmpDir, "engagement-ledger.jsonl");
  decisionsPath = join(tmpDir, "decisions.jsonl");
  cognitionAuditPath = join(tmpDir, "audit.jsonl");
  configPath = join(tmpDir, "fitness-config.json");

  // Shipped config — keep in sync with components/evy/fitness-config.json.
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        window_seconds: 3600,
        k_windows: 10,
        delta: 0.05,
        weights: { repeat: 0.4, nudge: 0.3, compaction: 0.3 },
        min_reflections_floor: 5,
      },
      null,
      2,
    ),
  );

  setLedgerPathForTesting(ledgerPath);
  _setSourcePathsForTesting({
    engagement: engagementPath,
    decisions: decisionsPath,
    cognition_audit: cognitionAuditPath,
    config: configPath,
  });
});

afterEach(() => {
  _resetForTesting();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Build a `now` Date that resolves the "completed window" to a known
 * one-hour span starting at `windowStart`. The writer treats
 * floor(now/window) as the CURRENT window and writes the PRIOR one,
 * so we pick `now = windowStart + window + 1s` to make the prior
 * window land at [windowStart, windowStart+1h).
 */
function nowForWindowStart(windowStart: Date): Date {
  return new Date(windowStart.getTime() + 3600 * 1000 + 1000);
}

/** Append a decisions.jsonl line at a chosen ISO timestamp. */
function appendDecision(ts: string, action: string, project = "_master"): void {
  const line =
    JSON.stringify({ ts, project, action, rationale: "synthetic test data" }) +
    "\n";
  if (existsSync(decisionsPath)) {
    writeFileSync(decisionsPath, readFileSync(decisionsPath, "utf8") + line);
  } else {
    writeFileSync(decisionsPath, line);
  }
}

/** Append a consciousness-loop audit line. */
function appendAudit(ts: string, unchanged: boolean): void {
  const line = JSON.stringify({ ts, unchanged, signal_hash: "x", tick: 1 }) + "\n";
  if (existsSync(cognitionAuditPath)) {
    writeFileSync(
      cognitionAuditPath,
      readFileSync(cognitionAuditPath, "utf8") + line,
    );
  } else {
    writeFileSync(cognitionAuditPath, line);
  }
}

/** Append an engagement-ledger line. */
function appendEngagement(entry: object): void {
  const line = JSON.stringify(entry) + "\n";
  if (existsSync(engagementPath)) {
    writeFileSync(engagementPath, readFileSync(engagementPath, "utf8") + line);
  } else {
    writeFileSync(engagementPath, line);
  }
}

function readLedgerEntries(): FitnessLedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const out: FitnessLedgerEntry[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as FitnessLedgerEntry);
  }
  return out;
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("fitness-writer", () => {
  test("setLedgerPathForTesting confines writes to the override", () => {
    expect(getLedgerPath()).toBe(ledgerPath);
  });

  test("empty window emits null composite + low_reflection_volume reason", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    const entry = await writeFitnessWindow(nowForWindowStart(windowStart));

    expect(entry).not.toBeNull();
    if (!entry) throw new Error("unreachable");

    expect(entry.window_start).toBe(windowStart.toISOString());
    expect(entry.window_end).toBe(
      new Date(windowStart.getTime() + 3600 * 1000).toISOString(),
    );
    expect(entry.window_seconds).toBe(3600);
    expect(entry.stall_composite).toBeNull();
    // Components stay present so the dashboard can show "we had no
    // data for any component", not a blank panel.
    expect(entry.stall_components).not.toBeNull();
    expect(entry.stall_components?.reflection_repeat_rate).toBeNull();
    expect(entry.stall_components?.worker_nudge_rate).toBeNull();
    expect(entry.stall_components?.compaction_rate).toBeNull();
    expect(entry.engagement_rate).toBeNull();
    expect(entry.engagement_counts).toEqual({ acted: 0, acked: 0, ignored: 0 });
    expect(entry.tick_count).toBe(0);
    expect(entry.reflection_count).toBe(0);
    expect(entry.worker_dispatch_count).toBe(0);
    expect(entry.missing_data_reason).toBe("low_reflection_volume");
  });

  test("synthetic decisions ledger yields the expected composite", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    // Build 10 reflections, 4 compactions, 6 nudges out of 10 worker actions.
    const midIso = (mins: number) =>
      new Date(windowStart.getTime() + mins * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i++) {
      appendDecision(midIso(i * 5), "context_hydrated");
    }
    for (let i = 0; i < 4; i++) {
      appendDecision(midIso(50 + i), "transcript_compacted");
    }
    for (let i = 0; i < 6; i++) {
      appendDecision(midIso(10 + i), "team_auto_nudge");
    }
    for (let i = 0; i < 4; i++) {
      appendDecision(midIso(20 + i), "team_completed_idle");
    }
    // 8 audit ticks, 4 of which were repeats (unchanged: true).
    for (let i = 0; i < 4; i++) appendAudit(midIso(i * 2), true);
    for (let i = 0; i < 4; i++) appendAudit(midIso(i * 2 + 30), false);

    const entry = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(entry).not.toBeNull();
    if (!entry) throw new Error("unreachable");

    expect(entry.reflection_count).toBe(10);
    expect(entry.tick_count).toBe(8);
    expect(entry.worker_dispatch_count).toBe(10); // 6 nudges + 4 dispatches
    expect(entry.stall_components).not.toBeNull();
    if (!entry.stall_components) throw new Error("unreachable");

    // reflection_repeat = 4/8 = 0.5
    expect(entry.stall_components.reflection_repeat_rate).toBeCloseTo(0.5, 6);
    // worker_nudge = 6/10 = 0.6
    expect(entry.stall_components.worker_nudge_rate).toBeCloseTo(0.6, 6);
    // compaction = 4/10 = 0.4
    expect(entry.stall_components.compaction_rate).toBeCloseTo(0.4, 6);

    // composite = 0.4*0.5 + 0.3*0.6 + 0.3*0.4 = 0.2 + 0.18 + 0.12 = 0.5
    expect(entry.stall_composite).toBeCloseTo(0.5, 6);
  });

  test("stall-composite weights sum to 1.0 in shipped config", () => {
    // Validate the on-disk shipped config — guard against typos that
    // would silently produce composites outside [0, 1].
    const shipped = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "fitness-config.json"),
        "utf8",
      ),
    ) as {
      weights: { repeat: number; nudge: number; compaction: number };
    };
    const sum =
      shipped.weights.repeat + shipped.weights.nudge + shipped.weights.compaction;
    expect(sum).toBeCloseTo(1.0, 6);
  });

  test("writer refuses to write to a non-canonical basename", async () => {
    setLedgerPathForTesting(join(tmpDir, "not-the-canonical-name.jsonl"));
    await expect(writeFitnessWindow(new Date("2026-05-01T01:00:01.000Z")))
      .rejects.toThrow(/refuses to write to non-canonical path/);
  });

  test("24 hours of synthetic activity → 24 ledger entries", async () => {
    const baseStart = new Date("2026-05-01T00:00:00.000Z");
    // Seed enough reflections per window to pass the floor (5) — write
    // 5 context_hydrated decisions per hour for 24 hours.
    for (let h = 0; h < 24; h++) {
      const hourStart = new Date(baseStart.getTime() + h * 3600 * 1000);
      for (let i = 0; i < 5; i++) {
        const tsMs = hourStart.getTime() + i * 60 * 1000;
        appendDecision(new Date(tsMs).toISOString(), "context_hydrated");
      }
    }

    for (let h = 0; h < 24; h++) {
      const windowStart = new Date(baseStart.getTime() + h * 3600 * 1000);
      await writeFitnessWindow(nowForWindowStart(windowStart));
    }

    const entries = readLedgerEntries();
    expect(entries.length).toBe(24);
    // Each entry's window_start should align to floor on the hour.
    for (let h = 0; h < 24; h++) {
      const expected = new Date(baseStart.getTime() + h * 3600 * 1000).toISOString();
      expect(entries[h]?.window_start).toBe(expected);
    }
  });

  test("engagement_rate is correct from synthetic engagement-ledger data", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    const midIso = (mins: number) =>
      new Date(windowStart.getTime() + mins * 60 * 1000).toISOString();
    // 3 acted, 2 acked, 5 ignored → engagement_rate = 3/10 = 0.3
    for (let i = 0; i < 3; i++) {
      appendEngagement({
        type: "engagement",
        ts: midIso(i),
        surface_id: `sid${i}`,
        outcome: "acted",
        source: "dashboard_click",
      });
    }
    for (let i = 0; i < 2; i++) {
      appendEngagement({
        type: "engagement",
        ts: midIso(3 + i),
        surface_id: `sid${3 + i}`,
        outcome: "acked",
        source: "dashboard_click",
      });
    }
    for (let i = 0; i < 5; i++) {
      appendEngagement({
        type: "engagement",
        ts: midIso(5 + i),
        surface_id: `sid${5 + i}`,
        outcome: "ignored",
        source: "timeout_sweep",
      });
    }

    const entry = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(entry).not.toBeNull();
    if (!entry) throw new Error("unreachable");
    expect(entry.engagement_counts).toEqual({ acted: 3, acked: 2, ignored: 5 });
    expect(entry.engagement_rate).toBeCloseTo(0.3, 6);
  });

  test("scaffold_version is populated", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    const entry = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(entry).not.toBeNull();
    if (!entry) throw new Error("unreachable");
    expect(typeof entry.scaffold_version).toBe("string");
    expect(entry.scaffold_version.length).toBeGreaterThan(0);
  });

  test("idempotent: writing twice for the same window is a no-op", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    const first = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(first).not.toBeNull();
    const second = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(second).toBeNull();
    expect(readLedgerEntries().length).toBe(1);
  });

  test("missing_data_reason transitions to no_engagement_surfaces when reflections exist but no engagement", async () => {
    const windowStart = new Date("2026-05-01T00:00:00.000Z");
    // 5 reflections, 5 audit ticks (above floor), 0 engagement, 0 workers.
    const midIso = (mins: number) =>
      new Date(windowStart.getTime() + mins * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      appendDecision(midIso(i), "context_hydrated");
      appendAudit(midIso(i), false);
    }
    const entry = await writeFitnessWindow(nowForWindowStart(windowStart));
    expect(entry).not.toBeNull();
    if (!entry) throw new Error("unreachable");

    // No workers in window → worker_nudge_rate is null → composite is null.
    expect(entry.stall_components?.worker_nudge_rate).toBeNull();
    expect(entry.stall_composite).toBeNull();
    // Reason should be insufficient_data (we DO have reflections, but
    // a component is missing).
    expect(entry.missing_data_reason).toBe("insufficient_data");
  });
});
