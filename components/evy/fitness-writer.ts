// components/evy/fitness-writer.ts
//
// v3.3.0 — Kernel Fitness Phase 2: pure data-plane fitness writer.
//
// What this module is for
// -----------------------
// Roll up engagement-ledger.jsonl + decisions.jsonl + consciousness-
// loop audit.jsonl into one `fitness-ledger.jsonl` entry per
// hour-window. The result is the immutable measurement stream that
// Phase 3 (v3.4.0 dashboard) charts and Phase 5 (v3.6.0 refiner)
// ingests. Pure data-plane code: ZERO LLM calls, ZERO dependencies on
// `pi-agent-core` or any agent state.
//
// Negative criterion (LOAD-BEARING — don't violate)
// -------------------------------------------------
// The fitness-ledger MUST be write-only from Evy's perspective. No
// code path that feeds the supervisor prompt may read from it. Evy
// reflects without knowing she's being judged.
//
// Structural enforcement (defense-in-depth):
//
//   1. **This module exports NO reader API.** No `readLedger()`, no
//      `getEntries()`, no `listFitness()`. The writer reads upstream
//      sources internally, but the only thing it emits is a write to
//      `fitness-ledger.jsonl`.
//   2. The accompanying test (`fitness-ledger-isolation.test.ts`)
//      asserts the export shape AND surgically greps the bodies of
//      the supervisor-prompt-assembly functions for any reference to
//      this module or its on-disk artifact.
//
// If either guard regresses, the Kernel Fitness design is broken —
// back out the offending change before merging.
//
// Multi-process append safety
// ---------------------------
// One process (the master daemon) drives the hourly writer. Each
// emitted entry is one line of JSON. Lines are kept compact (no
// embedded payloads — only counts, rates, hashes) so POSIX O_APPEND
// atomicity covers us if a dashboard process ever co-writes.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  EngagementCounts,
  FitnessComponents,
  FitnessConfig,
  FitnessLedgerEntry,
  MissingDataReason,
} from "./fitness-types";

// ─── path resolution ──────────────────────────────────────────────────────
//
// Honors SUBCTL_CONFIG_DIR (same env var the rest of the daemon
// respects). The ledger ALWAYS lives at
// `<config>/evy/fitness-ledger.jsonl` — callers cannot redirect via
// the public API (tests use setLedgerPathForTesting). The writer
// refuses to write to any other location even if internal state is
// tampered with (see `assertCanonicalLedgerPath`).

const LEDGER_FILE = "fitness-ledger.jsonl";

function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}

function defaultEvyDir(): string {
  return join(subctlConfigDir(), "evy");
}

function defaultLedgerPath(): string {
  return join(defaultEvyDir(), LEDGER_FILE);
}

function defaultEngagementLedgerPath(): string {
  return join(defaultEvyDir(), "engagement-ledger.jsonl");
}

function defaultDecisionsLedgerPath(): string {
  return join(defaultEvyDir(), "decisions.jsonl");
}

function defaultCognitionAuditPath(): string {
  return join(defaultEvyDir(), "consciousness-loop", "audit.jsonl");
}

function defaultConfigPath(): string {
  // Bundled with the source — read from disk so the operator can
  // hand-edit and bounce the daemon. NOT from EVY_STATE_DIR; this is
  // shipped code, not operator state.
  return join(import.meta.dir, "fitness-config.json");
}

let _ledgerPath: string = defaultLedgerPath();

/**
 * Test-only path override. Production code MUST NOT use this; the
 * canonical path is the one returned by `getLedgerPath()` with no
 * override applied. Pass `null` to restore the default.
 */
export function setLedgerPathForTesting(path: string | null): void {
  _ledgerPath = path ?? defaultLedgerPath();
}

/** Returns the absolute path the ledger is currently writing to. */
export function getLedgerPath(): string {
  return _ledgerPath;
}

// Test-only knobs for the upstream-source paths. NOT exported in any
// reader form — `getLedgerPath` is the only path-introspection API
// the negative-criterion test allowlists. These setters mutate
// module state but never RETURN ledger contents.
let _engagementLedgerPath: string = defaultEngagementLedgerPath();
let _decisionsLedgerPath: string = defaultDecisionsLedgerPath();
let _cognitionAuditPath: string = defaultCognitionAuditPath();
let _configPath: string = defaultConfigPath();

/** Test-only: override upstream source paths. */
export function _setSourcePathsForTesting(paths: {
  engagement?: string | null;
  decisions?: string | null;
  cognition_audit?: string | null;
  config?: string | null;
}): void {
  _engagementLedgerPath = paths.engagement ?? defaultEngagementLedgerPath();
  _decisionsLedgerPath = paths.decisions ?? defaultDecisionsLedgerPath();
  _cognitionAuditPath = paths.cognition_audit ?? defaultCognitionAuditPath();
  _configPath = paths.config ?? defaultConfigPath();
}

/**
 * Belt-and-braces: refuse to write to anywhere other than a path
 * named `fitness-ledger.jsonl`. The override knob is for tests; this
 * is the failsafe for accidental misuse.
 */
function assertCanonicalLedgerPath(): void {
  // Test paths look like `/tmp/abc-fitness-XXXX/fitness-ledger.jsonl`
  // — basename must equal LEDGER_FILE.
  const base = _ledgerPath.split("/").pop();
  if (base !== LEDGER_FILE) {
    throw new Error(
      `fitness-writer: refuses to write to non-canonical path (basename="${base}", expected="${LEDGER_FILE}")`,
    );
  }
}

// ─── config ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FitnessConfig = {
  window_seconds: 3600,
  k_windows: 10,
  delta: 0.05,
  weights: { repeat: 0.4, nudge: 0.3, compaction: 0.3 },
  min_reflections_floor: 5,
};

/**
 * Load fitness-config.json from disk. Read-only — never mutates the
 * file. Falls back to DEFAULT_CONFIG on parse error or missing file
 * (logs a one-liner so the operator sees the degradation but the
 * daemon never crashes on a bad config).
 *
 * Validates weights sum to 1.0 (± 1e-6). A misconfigured weights
 * trio would produce composites that no longer fit [0, 1], which
 * would silently corrupt the downstream signal — fail closed instead.
 */
function loadConfig(): FitnessConfig {
  let raw: Partial<FitnessConfig>;
  try {
    raw = JSON.parse(readFileSync(_configPath, "utf8")) as Partial<FitnessConfig>;
  } catch (err) {
    console.error(
      `[fitness-writer] config load failed at ${_configPath}: ${(err as Error).message} — using defaults`,
    );
    return { ...DEFAULT_CONFIG };
  }
  const merged: FitnessConfig = {
    window_seconds:
      typeof raw.window_seconds === "number" && raw.window_seconds > 0
        ? raw.window_seconds
        : DEFAULT_CONFIG.window_seconds,
    k_windows:
      typeof raw.k_windows === "number" && raw.k_windows > 0
        ? Math.floor(raw.k_windows)
        : DEFAULT_CONFIG.k_windows,
    delta:
      typeof raw.delta === "number" && raw.delta >= 0
        ? raw.delta
        : DEFAULT_CONFIG.delta,
    weights:
      raw.weights &&
      typeof raw.weights.repeat === "number" &&
      typeof raw.weights.nudge === "number" &&
      typeof raw.weights.compaction === "number"
        ? {
            repeat: raw.weights.repeat,
            nudge: raw.weights.nudge,
            compaction: raw.weights.compaction,
          }
        : { ...DEFAULT_CONFIG.weights },
    min_reflections_floor:
      typeof raw.min_reflections_floor === "number" &&
      raw.min_reflections_floor >= 0
        ? Math.floor(raw.min_reflections_floor)
        : DEFAULT_CONFIG.min_reflections_floor,
  };
  // Weight sum check — fail closed to defaults rather than emit a
  // composite outside [0, 1]. Tiny float tolerance.
  const sum =
    merged.weights.repeat + merged.weights.nudge + merged.weights.compaction;
  if (Math.abs(sum - 1.0) > 1e-6) {
    console.error(
      `[fitness-writer] weights sum to ${sum.toFixed(6)}, expected 1.0 — falling back to defaults`,
    );
    merged.weights = { ...DEFAULT_CONFIG.weights };
  }
  return merged;
}

// ─── scaffold version ─────────────────────────────────────────────────────
//
// Placeholder until the scaffold-extraction work in Phase 4 lands.
// Once that ships, this becomes a hash or semver of the extracted
// scaffold; for now a stable literal lets downstream consumers gate
// without churn.

const SCAFFOLD_VERSION_PLACEHOLDER = "v3.x-pre-scaffold-extraction";

// ─── window math ──────────────────────────────────────────────────────────

interface Window {
  start: Date;
  end: Date;
  seconds: number;
}

/**
 * Resolve the most-recently-completed window for `now`. Windows are
 * aligned to floor(now / window_seconds) so consecutive writers land
 * on the same boundaries — important for downstream charting and for
 * the refiner's k-window read-back.
 *
 * The "current" window is the [start, start+window) where now ∈ that
 * range. The writer emits a row for the window that JUST CLOSED at
 * `floor(now / w) * w` — i.e. the prior window. This avoids writing
 * an incomplete window we'd have to backfill later.
 */
function resolveCompletedWindow(now: Date, windowSeconds: number): Window {
  const nowMs = now.getTime();
  const wMs = windowSeconds * 1000;
  const currentStartMs = Math.floor(nowMs / wMs) * wMs;
  const startMs = currentStartMs - wMs;
  return {
    start: new Date(startMs),
    end: new Date(currentStartMs),
    seconds: windowSeconds,
  };
}

// ─── JSONL scan helpers ───────────────────────────────────────────────────
//
// Helpers operate by line. They are tolerant of partial / malformed
// lines (a crash mid-append leaves a partial line — we skip it
// rather than crash). They NEVER return raw payloads outside this
// module: all helpers return counts or summaries.

interface DecisionLine {
  ts: string;
  project?: string;
  action?: string;
}

interface AuditLine {
  ts?: string;
  unchanged?: boolean;
}

interface EngagementLine {
  type: "surface_emitted" | "engagement";
  ts: string;
  outcome?: "acted" | "acked" | "ignored";
}

function readJsonlLines<T>(path: string): T[] {
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
      // skip malformed
    }
  }
  return out;
}

function inWindow(tsIso: string | undefined, w: Window): boolean {
  if (!tsIso) return false;
  const t = Date.parse(tsIso);
  if (!Number.isFinite(t)) return false;
  return t >= w.start.getTime() && t < w.end.getTime();
}

// ─── per-source rollups ───────────────────────────────────────────────────
//
// Each rollup reads its source file IN FULL once, filters to the
// target window, and returns a count summary. The full-file read is
// cheap at hourly cadence (a busy day produces O(10k) lines per
// source) — we don't need an index. Each helper returns counts, not
// rows.

interface DecisionCounts {
  /** action == "transcript_compacted" */
  transcript_compacted: number;
  /** action == "context_hydrated" — used as proxy for reflection count */
  reflections: number;
  /** action == "team_auto_nudge" */
  worker_nudge: number;
  /** any team_* action that isn't a nudge/unresponsive — proxy for dispatch outcomes */
  worker_dispatch: number;
}

function rollupDecisions(w: Window): DecisionCounts {
  const lines = readJsonlLines<DecisionLine>(_decisionsLedgerPath);
  const c: DecisionCounts = {
    transcript_compacted: 0,
    reflections: 0,
    worker_nudge: 0,
    worker_dispatch: 0,
  };
  for (const ln of lines) {
    if (!inWindow(ln.ts, w)) continue;
    const action = ln.action ?? "";
    if (action === "transcript_compacted") c.transcript_compacted++;
    else if (action === "context_hydrated") c.reflections++;
    else if (action === "team_auto_nudge") c.worker_nudge++;
    else if (
      action.startsWith("team_") &&
      action !== "team_auto_nudge" &&
      action !== "team_unresponsive" &&
      action !== "team_vanished"
    ) {
      // team_completed_idle, team_awaiting_input, team_pruned, ...
      c.worker_dispatch++;
    }
  }
  return c;
}

interface AuditCounts {
  /** total audit-ticks in window */
  ticks: number;
  /** ticks with unchanged: true */
  unchanged: number;
}

function rollupAudit(w: Window): AuditCounts {
  const lines = readJsonlLines<AuditLine>(_cognitionAuditPath);
  const c: AuditCounts = { ticks: 0, unchanged: 0 };
  for (const ln of lines) {
    if (!inWindow(ln.ts, w)) continue;
    c.ticks++;
    if (ln.unchanged === true) c.unchanged++;
  }
  // Also include the rotated generation (`audit.jsonl.1`) — when the
  // active file just rotated, the window may straddle both files.
  const rotated = _cognitionAuditPath + ".1";
  if (existsSync(rotated)) {
    for (const ln of readJsonlLines<AuditLine>(rotated)) {
      if (!inWindow(ln.ts, w)) continue;
      c.ticks++;
      if (ln.unchanged === true) c.unchanged++;
    }
  }
  return c;
}

function rollupEngagement(w: Window): EngagementCounts & {
  surface_emitted: number;
} {
  const lines = readJsonlLines<EngagementLine>(_engagementLedgerPath);
  const c = { acted: 0, acked: 0, ignored: 0, surface_emitted: 0 };
  for (const ln of lines) {
    if (!inWindow(ln.ts, w)) continue;
    if (ln.type === "surface_emitted") c.surface_emitted++;
    else if (ln.type === "engagement" && ln.outcome) {
      if (ln.outcome === "acted") c.acted++;
      else if (ln.outcome === "acked") c.acked++;
      else if (ln.outcome === "ignored") c.ignored++;
    }
  }
  return c;
}

// ─── composite math ───────────────────────────────────────────────────────

/** Clamp x into [0, 1]. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeComponents(
  decisions: DecisionCounts,
  audit: AuditCounts,
  cfg: FitnessConfig,
): { components: FitnessComponents; reflectionCount: number } {
  // reflection_count for the floor check: the decision-side proxy
  // (`context_hydrated`) is the most-direct measure of supervisor
  // turns. Audit ticks alone don't imply reflection — a tick may
  // decide to no-op without invoking the supervisor.
  const reflectionCount = decisions.reflections;

  // Floor check — below it, both reflection-dependent rates go null.
  const haveEnoughReflections = reflectionCount >= cfg.min_reflections_floor;

  let reflection_repeat_rate: number | null = null;
  if (audit.ticks >= cfg.min_reflections_floor) {
    reflection_repeat_rate = clamp01(audit.unchanged / audit.ticks);
  }

  let worker_nudge_rate: number | null = null;
  const workerTotal = decisions.worker_nudge + decisions.worker_dispatch;
  if (workerTotal > 0) {
    worker_nudge_rate = clamp01(decisions.worker_nudge / workerTotal);
  }

  let compaction_rate: number | null = null;
  if (haveEnoughReflections) {
    compaction_rate = clamp01(
      decisions.transcript_compacted / reflectionCount,
    );
  }

  return {
    components: { reflection_repeat_rate, worker_nudge_rate, compaction_rate },
    reflectionCount,
  };
}

function composeStall(
  components: FitnessComponents,
  cfg: FitnessConfig,
): number | null {
  // If any component is missing, the composite is missing — don't
  // impute. The refiner expects honest "I don't know" gaps rather
  // than partially-weighted blends.
  if (
    components.reflection_repeat_rate === null ||
    components.worker_nudge_rate === null ||
    components.compaction_rate === null
  ) {
    return null;
  }
  const sum =
    cfg.weights.repeat * components.reflection_repeat_rate +
    cfg.weights.nudge * components.worker_nudge_rate +
    cfg.weights.compaction * components.compaction_rate;
  return clamp01(sum);
}

// ─── write paths ──────────────────────────────────────────────────────────

function ensureLedgerDir(): void {
  try {
    mkdirSync(dirname(_ledgerPath), { recursive: true });
  } catch {
    /* best-effort */
  }
}

function appendLine(entry: FitnessLedgerEntry): void {
  ensureLedgerDir();
  const line = JSON.stringify(entry) + "\n";
  try {
    appendFileSync(_ledgerPath, line);
  } catch (err) {
    console.error(
      `[fitness-writer] append failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Walk the existing ledger and check whether a given window_start has
 * already been written. Idempotent guard: if the daemon restarts and
 * the hourly tick fires twice in the same window, we DO NOT double-
 * write. Reads internally; result never returned to caller — only the
 * boolean.
 */
function windowAlreadyWritten(windowStartIso: string): boolean {
  if (!existsSync(_ledgerPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(_ledgerPath, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { window_start?: string };
      if (obj.window_start === windowStartIso) return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ─── public writer ────────────────────────────────────────────────────────

/**
 * Emit the fitness-ledger row for the window most-recently-completed
 * relative to `now`. Returns the row written, or `null` if a row for
 * that window already exists (idempotent re-fire is a no-op).
 *
 * Fire-and-forget — never throws on disk errors; failures are
 * logged. The negative-criterion guard at the top of this module
 * means production code MUST NOT consume the return value as a
 * fitness signal; the return is for test ergonomics only.
 */
export async function writeFitnessWindow(
  now?: Date,
): Promise<FitnessLedgerEntry | null> {
  assertCanonicalLedgerPath();

  const cfg = loadConfig();
  const w = resolveCompletedWindow(now ?? new Date(), cfg.window_seconds);
  const windowStartIso = w.start.toISOString();

  if (windowAlreadyWritten(windowStartIso)) {
    return null;
  }

  const decisions = rollupDecisions(w);
  const audit = rollupAudit(w);
  const engagement = rollupEngagement(w);

  const { components, reflectionCount } = computeComponents(
    decisions,
    audit,
    cfg,
  );
  const stallComposite = composeStall(components, cfg);

  // engagement_rate: acted / total-outcomes. Null when no outcomes
  // landed in the window. Note: `surface_emitted` without a matching
  // outcome doesn't count here — the timeout sweeper from Phase 1
  // eventually backfills `ignored` outcomes, so this rate is an
  // honest measure of OUTCOMES, not emissions.
  const engagementTotal =
    engagement.acted + engagement.acked + engagement.ignored;
  const engagementRate =
    engagementTotal > 0 ? clamp01(engagement.acted / engagementTotal) : null;

  // Pick a missing_data_reason if there's a story to tell. Order
  // matters — reflection-volume gating is the most-actionable reason.
  let missingDataReason: MissingDataReason | undefined;
  if (stallComposite === null) {
    if (reflectionCount < cfg.min_reflections_floor) {
      missingDataReason = "low_reflection_volume";
    } else {
      missingDataReason = "insufficient_data";
    }
  } else if (engagementRate === null) {
    missingDataReason = "no_engagement_surfaces";
  }

  const entry: FitnessLedgerEntry = {
    window_start: windowStartIso,
    window_end: w.end.toISOString(),
    window_seconds: w.seconds,
    stall_composite: stallComposite,
    // Expose components even when the composite is null — Phase 3
    // (dashboard) wants to show "we had 2 of 3 components, but the
    // third was missing" rather than a blank panel.
    stall_components: components,
    engagement_rate: engagementRate,
    engagement_counts: {
      acted: engagement.acted,
      acked: engagement.acked,
      ignored: engagement.ignored,
    },
    tick_count: audit.ticks,
    reflection_count: reflectionCount,
    worker_dispatch_count: decisions.worker_dispatch + decisions.worker_nudge,
    scaffold_version: SCAFFOLD_VERSION_PLACEHOLDER,
    ...(missingDataReason ? { missing_data_reason: missingDataReason } : {}),
  };

  appendLine(entry);
  return entry;
}

// ─── long-running loop ────────────────────────────────────────────────────
//
// Registered at boot from `components/evy/server.ts` alongside the
// engagement timeout sweeper from Phase 1. Hourly tick. NOT inside
// the supervisor turn loop — the writer is a passive observer, not a
// participant.

interface RunnerHandle {
  /** Underlying setInterval id, exposed for test teardown. */
  timer: ReturnType<typeof setInterval> | null;
}

const _runnerHandle: RunnerHandle = { timer: null };

/**
 * Arm the hourly fitness-writer tick. Idempotent — calling twice
 * (e.g. during boot retry) does not double-arm. The first tick fires
 * `WRITE_DELAY_MS` after boot to give the daemon time to settle,
 * then once per `tick_interval_ms`.
 *
 * Fire-and-forget — never throws. The caller (server.ts) should NOT
 * await; this returns immediately after scheduling.
 */
export async function runFitnessWriter(): Promise<void> {
  if (_runnerHandle.timer !== null) return;

  const cfg = loadConfig();
  // Tick at window cadence — once per hour by default. The actual
  // window-resolution logic uses `floor(now / window)` so a slight
  // jitter in tick timing is harmless.
  const tickIntervalMs = cfg.window_seconds * 1000;

  // First fire after a short boot-settle delay so we don't double-
  // write a row on a fast restart cycle.
  const BOOT_SETTLE_MS = 30_000;

  const fireOnce = (): void => {
    void writeFitnessWindow().catch((err) => {
      console.error(
        `[fitness-writer] tick failed: ${(err as Error).message}`,
      );
    });
  };

  setTimeout(() => {
    fireOnce();
    _runnerHandle.timer = setInterval(fireOnce, tickIntervalMs);
  }, BOOT_SETTLE_MS);
}

// ─── test helpers ─────────────────────────────────────────────────────────

/**
 * Reset module state to defaults. Tests pair with the various
 * `setLedgerPathForTesting()` / `_setSourcePathsForTesting()` calls
 * to fully isolate from production state.
 */
export function _resetForTesting(): void {
  _ledgerPath = defaultLedgerPath();
  _engagementLedgerPath = defaultEngagementLedgerPath();
  _decisionsLedgerPath = defaultDecisionsLedgerPath();
  _cognitionAuditPath = defaultCognitionAuditPath();
  _configPath = defaultConfigPath();
  if (_runnerHandle.timer !== null) {
    clearInterval(_runnerHandle.timer);
    _runnerHandle.timer = null;
  }
}

