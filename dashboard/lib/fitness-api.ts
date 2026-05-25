// dashboard/lib/fitness-api.ts
//
// v3.3.1 — Kernel Fitness Phase 3: dashboard read-only ledger access.
//
// Pure handlers for the three new fitness/engagement endpoints in
// dashboard/server.ts. Kept here (mirrors dashboard/lib/audit-api.ts)
// so tests can exercise the parsing + windowing + health rollup
// without booting an HTTP server.
//
// DESIGN: the dashboard reads two JSONL ledgers (engagement +
// fitness) written elsewhere in the codebase. We never import the
// writer modules — the fitness-ledger isolation test
// (components/evy/__tests__/fitness-ledger-isolation.test.ts)
// enforces "no reader API" on `components/evy/fitness-writer.ts`,
// so the dashboard parses the JSONL on its own with `node:fs`.
//
// All public functions accept absolute paths so tests can point at
// scratch files without monkey-patching env vars. Server-side
// glue in dashboard/server.ts resolves the canonical paths.
//
// FILE-MISSING SEMANTICS: every reader returns `[]` (or a sentinel
// `red` health verdict) when the ledger file does not exist. We
// never throw or 500 — a freshly-installed daemon has no ledgers
// yet, and the dashboard must render an "insufficient data" empty
// state, not an error toast.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── path resolution ────────────────────────────────────────────────────────

/**
 * Resolve subctl's config dir using the same env vars the rest of
 * the daemon honors. Order matches engagement-tracker.ts +
 * fitness-writer.ts exactly so the dashboard always reads from the
 * same place the writers write to.
 */
export function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}

export function defaultEvyDir(): string {
  return join(subctlConfigDir(), "evy");
}

export function defaultFitnessLedgerPath(): string {
  return join(defaultEvyDir(), "fitness-ledger.jsonl");
}

export function defaultEngagementLedgerPath(): string {
  return join(defaultEvyDir(), "engagement-ledger.jsonl");
}

// ─── window parsing ─────────────────────────────────────────────────────────

/**
 * Parse a `?window=` query param. Accepts `24h`, `7d`, `30d`, `Nh`,
 * `Nd`. Returns the window length in seconds, or `null` when the
 * param is missing or malformed (caller treats null as "no filter").
 */
export function parseWindow(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  const m = /^(\d+)\s*(h|d)$/i.exec(trimmed);
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "h").toLowerCase();
  return unit === "h" ? n * 3600 : n * 86_400;
}

// ─── jsonl reader ───────────────────────────────────────────────────────────

/**
 * Read a JSONL file and return parsed objects. Returns `[]` on
 * missing-file or read-failure. Skips blank lines and lines that
 * fail JSON.parse — the dashboard prefers a partial render over a
 * 500.
 */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Malformed line — likely a partial write mid-rotation. Skip.
    }
  }
  return out;
}

// ─── ledger shapes (mirror components/evy/fitness-types.ts + engagement-types.ts) ──
//
// Re-declared locally so the dashboard surface doesn't import from
// `components/evy/fitness-writer.ts` (which would defeat the
// isolation-test allowlist) and so the JSON wire shapes are
// stable even if the source-of-truth types drift.

export interface FitnessLedgerEntry {
  window_start: string;
  window_end: string;
  window_seconds: number;
  stall_composite: number | null;
  stall_components: {
    reflection_repeat_rate: number | null;
    worker_nudge_rate: number | null;
    compaction_rate: number | null;
  } | null;
  engagement_rate: number | null;
  engagement_counts: { acted: number; acked: number; ignored: number };
  tick_count: number;
  reflection_count: number;
  worker_dispatch_count: number;
  scaffold_version: string;
  missing_data_reason?: string;
}

export interface SurfaceEmittedEntry {
  type: "surface_emitted";
  ts: string;
  surface_id: string;
  surface_type: string;
  payload_hash: string;
}

export interface EngagementOutcomeEntry {
  type: "engagement";
  ts: string;
  surface_id: string;
  outcome: "acted" | "acked" | "ignored";
  source: string;
  latency_ms?: number;
}

export type EngagementEntry = SurfaceEmittedEntry | EngagementOutcomeEntry;

// ─── filtered readers ───────────────────────────────────────────────────────

export interface ReadOpts {
  /** Filter to entries with ts/window_start within last N seconds. */
  windowSeconds?: number | null;
  /** Reference "now" for window math. Tests pass deterministic values. */
  now?: Date;
}

export function readFitnessLedger(
  path: string,
  opts: ReadOpts = {},
): FitnessLedgerEntry[] {
  const entries = readJsonl<FitnessLedgerEntry>(path);
  const win = opts.windowSeconds ?? null;
  if (win === null) return entries;
  const cutoff = (opts.now ?? new Date()).getTime() - win * 1000;
  return entries.filter((e) => {
    const t = Date.parse(e.window_start);
    return Number.isFinite(t) && t >= cutoff;
  });
}

export interface EngagementReadOpts extends ReadOpts {
  /** Filter to one entry type. Omit for both. */
  type?: "surface_emitted" | "engagement" | null;
}

export function readEngagementLedger(
  path: string,
  opts: EngagementReadOpts = {},
): EngagementEntry[] {
  const entries = readJsonl<EngagementEntry>(path);
  const win = opts.windowSeconds ?? null;
  const cutoff = win !== null
    ? (opts.now ?? new Date()).getTime() - win * 1000
    : null;
  return entries.filter((e) => {
    if (opts.type && e.type !== opts.type) return false;
    if (cutoff !== null) {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    }
    return true;
  });
}

// ─── health computation ─────────────────────────────────────────────────────

export type HealthVerdict = "green" | "yellow" | "red";

export interface HealthResult {
  health: HealthVerdict;
  reason: string;
  latest_window: FitnessLedgerEntry | null;
}

/**
 * Roll the last 24h of fitness ledger entries into a red/yellow/green
 * verdict. Rules:
 *   - red    : < 5 valid windows in last 24h, OR 24h trend degrading
 *              on either stall or engagement
 *   - yellow : 24h trend non-degrading on both, but mean engagement ≤ 30%
 *   - green  : 24h trend non-degrading on both AND mean engagement > 30%
 *
 * "Valid" = entries where the metric being checked is non-null.
 * "Non-degrading" stall = slope ≤ 0 (lower better). "Non-degrading"
 * engagement = slope ≥ 0 (higher better).
 */
export function computeHealth(
  entries: FitnessLedgerEntry[],
  now: Date = new Date(),
): HealthResult {
  if (entries.length === 0) {
    return {
      health: "red",
      reason: "no fitness data yet — writer hasn't logged a window",
      latest_window: null,
    };
  }
  const sorted = [...entries].sort(
    (a, b) => Date.parse(a.window_start) - Date.parse(b.window_start),
  );
  const latest = sorted[sorted.length - 1] ?? null;

  const cutoff = now.getTime() - 24 * 3600 * 1000;
  const last24 = sorted.filter(
    (e) => Date.parse(e.window_start) >= cutoff,
  );
  const validStall = last24.filter((e) => e.stall_composite !== null);
  const validEng = last24.filter((e) => e.engagement_rate !== null);

  // "Insufficient data" floor: need at least 5 valid windows on the
  // weaker side. If either metric only has e.g. 2 non-null entries,
  // the slope is noise.
  const validCount = Math.min(validStall.length, validEng.length);
  if (validCount < 5) {
    return {
      health: "red",
      reason:
        `only ${validCount} window(s) with both metrics in last 24h (need ≥5 before health is meaningful)`,
      latest_window: latest,
    };
  }

  const stallSlope = computeSlope(
    validStall.map((e) => [Date.parse(e.window_start), e.stall_composite as number]),
  );
  const engSlope = computeSlope(
    validEng.map((e) => [Date.parse(e.window_start), e.engagement_rate as number]),
  );

  const stallDegrading = stallSlope > 0;
  const engDegrading = engSlope < 0;

  const meanEng = validEng.length > 0
    ? validEng.reduce((a, e) => a + (e.engagement_rate as number), 0) / validEng.length
    : 0;

  if (stallDegrading || engDegrading) {
    const parts = [
      stallDegrading ? `stall trending up (slope ${stallSlope.toExponential(2)})` : null,
      engDegrading ? `engagement trending down (slope ${engSlope.toExponential(2)})` : null,
    ].filter(Boolean);
    return {
      health: "red",
      reason: `24h trend degrading: ${parts.join("; ")}`,
      latest_window: latest,
    };
  }

  if (meanEng > 0.3) {
    return {
      health: "green",
      reason:
        `24h trend non-degrading on both stall + engagement; mean engagement ${(meanEng * 100).toFixed(0)}%`,
      latest_window: latest,
    };
  }

  return {
    health: "yellow",
    reason:
      `24h trend non-degrading but mean engagement ${(meanEng * 100).toFixed(0)}% (≤ 30%)`,
    latest_window: latest,
  };
}

/**
 * Simple least-squares slope (Δy / Δx) over [x, y] points. Used to
 * detect 24h trend direction on the two ledger metrics. Returns 0
 * for empty / degenerate input.
 */
function computeSlope(points: Array<[number, number]>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
