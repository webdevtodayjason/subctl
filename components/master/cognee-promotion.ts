// components/master/cognee-promotion.ts
//
// v2.8.15 — Tier 3 → Tier 4 promotion ticker (Cognee WRITE path).
//
// Why this module exists
// ----------------------
// `cognee-client.ts` exports `remember()` — the only path that lands new
// memories in the Cognee graph. Until this module, NOTHING in master called
// it. `server.ts` imported `health` and `recall` (the read path) and
// nothing else. Net effect: Tier 4 stayed at the 3 memories from the one-
// time May 18-19 backfill while Memori (Tier 3) accumulated 1k+ curated
// rows. The reviewer-kernel kept promoting events from Tier 3.raw →
// Tier 3.curated, but the next step — promoting Tier 3.curated rows into
// Cognee — was never wired.
//
// What this ticker does
// ---------------------
// Every N minutes (default 10, env override `SUBCTL_COGNEE_PROMOTION_INTERVAL_MIN`):
//
//   1. Read `subctl_memori_curated` from the Memori sidecar's SQLite file
//      using a tuple watermark `(last_promoted_ts, last_promoted_id)`.
//   2. For each row, call `cogneeClient.remember()` with provenance
//      metadata (memori_id, kind, confidence, reviewer_model).
//   3. On success, advance the watermark to that row's (ts, id). On
//      failure, record the error (capped at the last 50) and SKIP — never
//      block the rest of the batch on one bad row.
//   4. Persist the watermark + counters to
//      `~/.config/subctl/master/cognee-promotion.json` atomically (tmp +
//      rename) so a master restart does not re-ingest the same curated
//      rows.
//
// Why SQL-direct (not HTTP /select_curated)
// -----------------------------------------
// The Memori sidecar doesn't expose a list-curated-by-watermark endpoint.
// Adding one would mean a Python change (out of scope per the dispatch
// constraints). The curated table lives at a known path
// (~/.config/subctl/master/memori.db); we open it READ-ONLY so we can't
// contend with the sidecar's write transactions. The schema is documented
// inline below and matches `services/memori/server.py`'s fallback CREATE.
//
// Tuple watermark
// ---------------
// The curated table uses `id TEXT PRIMARY KEY` (UUIDs) and `ts TEXT NOT
// NULL` (ISO timestamps). A bare-ts watermark would silently drop rows
// inserted in the same millisecond. We use `(ts, id)` ordered
// lexicographically — `WHERE ts > ? OR (ts = ? AND id > ?)` — so every
// row is visited exactly once even under tight insertion bursts.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  remember as defaultCogneeRemember,
  type CogneeResult,
} from "./cognee-client";

// ─── public types ─────────────────────────────────────────────────────────

/** One row out of `subctl_memori_curated`. */
export interface CuratedMemoriRow {
  id: string;
  entity_id: string;
  source_event_ids: string;
  memory: string;
  kind: string | null;
  reason: string | null;
  confidence: number | null;
  reviewer_model: string | null;
  ts: string;
}

export interface CogneePromotionError {
  memori_id: string;
  error: string;
  ts: string;
}

export interface CogneePromotionState {
  /** Last successfully-promoted curated row's `ts` (ISO). null when never run. */
  last_promoted_ts: string | null;
  /** Last successfully-promoted curated row's `id`. null when never run. */
  last_promoted_id: string | null;
  total_promoted: number;
  /** Wall-clock of the last tick start. */
  last_run_at_ms: number;
  /** Cap-50 ring of recent failures (newest at the end). */
  errors: CogneePromotionError[];
}

export interface CogneePromotionTickResult {
  ok: boolean;
  scanned: number;
  promoted: number;
  errored: number;
  /** New watermark tuple after this tick (null when nothing advanced). */
  watermark_ts: string | null;
  watermark_id: string | null;
  elapsed_ms: number;
  /** Optional short-circuit reason — "gates_off", "db_missing", etc. */
  note?: string;
  /** First error in the batch — useful for `onError` surfaces. */
  first_error?: string;
}

// ─── constants ────────────────────────────────────────────────────────────

const STATE_VERSION = 1;
const MAX_RECENT_ERRORS = 50;
const DEFAULT_BATCH_LIMIT = 200;

const HOME = homedir();
function defaultStatePath(): string {
  return join(
    process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl"),
    "master",
    "cognee-promotion.json",
  );
}

function defaultMemoriDbPath(): string {
  return (
    process.env.SUBCTL_MEMORI_DB ??
    join(
      process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl"),
      "master",
      "memori.db",
    )
  );
}

/** Resolved every tick so env changes don't require a master restart. */
export function resolvePromotionIntervalMs(): number {
  const raw = process.env.SUBCTL_COGNEE_PROMOTION_INTERVAL_MIN;
  const minutes = raw ? Number(raw) : 10;
  if (!Number.isFinite(minutes) || minutes <= 0) return 10 * 60_000;
  return Math.max(60_000, Math.floor(minutes * 60_000));
}

// ─── state file ────────────────────────────────────────────────────────────

interface PersistedState {
  version: number;
  last_promoted_ts: string | null;
  last_promoted_id: string | null;
  total_promoted: number;
  last_run_at_ms: number;
  errors: CogneePromotionError[];
}

function freshState(): PersistedState {
  return {
    version: STATE_VERSION,
    last_promoted_ts: null,
    last_promoted_id: null,
    total_promoted: 0,
    last_run_at_ms: 0,
    errors: [],
  };
}

function loadStateFromDisk(path: string): PersistedState {
  try {
    if (!existsSync(path)) return freshState();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
    if (typeof parsed !== "object" || parsed === null) return freshState();
    const errors = Array.isArray(parsed.errors)
      ? (parsed.errors as CogneePromotionError[])
          .filter(
            (e): e is CogneePromotionError =>
              !!e &&
              typeof e.memori_id === "string" &&
              typeof e.error === "string" &&
              typeof e.ts === "string",
          )
          .slice(-MAX_RECENT_ERRORS)
      : [];
    return {
      version: STATE_VERSION,
      last_promoted_ts:
        typeof parsed.last_promoted_ts === "string" ? parsed.last_promoted_ts : null,
      last_promoted_id:
        typeof parsed.last_promoted_id === "string" ? parsed.last_promoted_id : null,
      total_promoted: Number(parsed.total_promoted ?? 0) || 0,
      last_run_at_ms: Number(parsed.last_run_at_ms ?? 0) || 0,
      errors,
    };
  } catch (err) {
    console.error(
      `[cognee-promotion] state load failed (${(err as Error).message}) — starting fresh`,
    );
    return freshState();
  }
}

function persistStateToDisk(path: string, state: PersistedState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.error(
      `[cognee-promotion] state persist failed: ${(err as Error).message}`,
    );
  }
}

// ─── curated-table reader (bun:sqlite, READ-ONLY) ──────────────────────────

/**
 * Read curated rows past `(after_ts, after_id)`, ordered by `(ts, id)`
 * ascending. `entity_id` filter mirrors what the memory-kernel uses to
 * scope writes (server.ts:2609 — operator name lowercased).
 *
 * READ-ONLY by design: bun:sqlite's `{ readonly: true }` flag opens the
 * file with SQLITE_OPEN_READONLY so we can never contend with the Python
 * sidecar's writes. Missing DB file → empty result + best-effort log.
 */
export function readCuratedSince(args: {
  dbPath: string;
  entityId: string;
  afterTs: string | null;
  afterId: string | null;
  limit?: number;
}): CuratedMemoriRow[] {
  if (!existsSync(args.dbPath)) return [];
  let db: Database;
  try {
    db = new Database(args.dbPath, { readonly: true });
  } catch (err) {
    console.error(
      `[cognee-promotion] cannot open memori.db readonly: ${(err as Error).message}`,
    );
    return [];
  }
  try {
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_BATCH_LIMIT, 1000));
    // First-run path: no watermark yet — pull everything for this entity.
    if (args.afterTs === null || args.afterId === null) {
      const stmt = db.prepare(
        `SELECT id, entity_id, source_event_ids, memory, kind, reason,
                confidence, reviewer_model, ts
           FROM subctl_memori_curated
          WHERE entity_id = ?
          ORDER BY ts ASC, id ASC
          LIMIT ?`,
      );
      return stmt.all(args.entityId, limit) as CuratedMemoriRow[];
    }
    // Steady-state path: tuple watermark with strict id-tiebreak.
    const stmt = db.prepare(
      `SELECT id, entity_id, source_event_ids, memory, kind, reason,
              confidence, reviewer_model, ts
         FROM subctl_memori_curated
        WHERE entity_id = ?
          AND (ts > ? OR (ts = ? AND id > ?))
        ORDER BY ts ASC, id ASC
        LIMIT ?`,
    );
    return stmt.all(
      args.entityId,
      args.afterTs,
      args.afterTs,
      args.afterId,
      limit,
    ) as CuratedMemoriRow[];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ─── injectable side-effect surface (for tests) ────────────────────────────

export interface PromotionDeps {
  /** Read curated rows. Default: bun:sqlite read of memori.db. */
  listCurated: (args: {
    afterTs: string | null;
    afterId: string | null;
    limit: number;
  }) => CuratedMemoriRow[];
  /** Write one row into Cognee. Default: cogneeClient.remember. */
  cogneeRemember: (input: {
    text: string;
    metadata?: Record<string, unknown>;
  }) => Promise<CogneeResult<{ id: string | null }>>;
  /** Operator entity scope — matches memory-kernel armer in server.ts. */
  entityId: () => string;
  /** State file path (overridable for tests). */
  statePath: string;
  /** Clock seam. */
  now: () => number;
  /** Batch size cap. */
  batchLimit: number;
}

function buildRealDeps(): PromotionDeps {
  return {
    listCurated: (args) =>
      readCuratedSince({
        dbPath: defaultMemoriDbPath(),
        entityId: _realEntityId(),
        afterTs: args.afterTs,
        afterId: args.afterId,
        limit: args.limit,
      }),
    cogneeRemember: (input) => defaultCogneeRemember(input),
    entityId: () => _realEntityId(),
    statePath: defaultStatePath(),
    now: () => Date.now(),
    batchLimit: DEFAULT_BATCH_LIMIT,
  };
}

/**
 * The real entity id is operator-driven and lives in `server.ts`. When
 * the promotion ticker runs standalone (e.g. tests, or until server.ts
 * calls `_setDepsForTesting({ entityId: ... })`), we fall back to env
 * `SUBCTL_OPERATOR_NAME` lower-cased, then to "operator".
 */
function _realEntityId(): string {
  return (process.env.SUBCTL_OPERATOR_NAME ?? "operator").toLowerCase();
}

let deps: PromotionDeps = buildRealDeps();

export function _setDepsForTesting(partial: Partial<PromotionDeps>): void {
  deps = { ...deps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = buildRealDeps();
  _state = freshState();
  _stateHydratedFor = null;
  _armed = false;
}

// ─── in-memory state ──────────────────────────────────────────────────────

let _state: PersistedState = freshState();
let _stateHydratedFor: string | null = null;

/**
 * Runtime "armed" flag for the promotion ticker. Lives in this module
 * (rather than at the arm site in server.ts) so it can be tested
 * hermetically alongside `startPromotionTicker` — the diag surface
 * (`bindCogneePromotionState` → `armed`) reads it via `isPromotionArmed()`.
 *
 * Lifecycle invariants enforced by `startPromotionTicker` + `stopFn`:
 *   - Starts `false`. Flipped `true` as the LAST step of a successful
 *     `startPromotionTicker(...)` call — so if `registerWatchdog` (or
 *     anything else upstream of that line) throws, `_armed` stays false.
 *   - Flipped back `false` unconditionally inside the ticker's `stopFn`,
 *     which is invoked via the watchdog kill path on shutdown.
 *   - Reset to `false` in `_resetDepsForTesting` so tests start clean.
 */
let _armed = false;

/**
 * Whether the promotion ticker is currently armed (start succeeded and
 * shutdown hasn't run). Read by `server.ts`'s diag binder so the
 * `system_cognee_promotion_self` tool reports runtime state instead of
 * static-gate config.
 */
export function isPromotionArmed(): boolean {
  return _armed;
}

/**
 * Lazy-hydrate from disk on first access for the current `deps.statePath`.
 * Reset on `_resetDepsForTesting` so each test starts at zero.
 */
function ensureHydrated(): void {
  if (_stateHydratedFor === deps.statePath) return;
  _state = loadStateFromDisk(deps.statePath);
  _stateHydratedFor = deps.statePath;
}

export function getState(): CogneePromotionState {
  ensureHydrated();
  return {
    last_promoted_ts: _state.last_promoted_ts,
    last_promoted_id: _state.last_promoted_id,
    total_promoted: _state.total_promoted,
    last_run_at_ms: _state.last_run_at_ms,
    errors: _state.errors.slice(-MAX_RECENT_ERRORS),
  };
}

// ─── promotion logic ──────────────────────────────────────────────────────

/** Build the Cognee remember() payload for one curated row. */
function buildPayload(row: CuratedMemoriRow): {
  text: string;
  metadata: Record<string, unknown>;
} {
  // Source ids are stored as a JSON-encoded string per services/memori/server.py.
  let sourceIds: string[] = [];
  try {
    const parsed = JSON.parse(row.source_event_ids);
    if (Array.isArray(parsed)) {
      sourceIds = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // Older rows may have stored a CSV — best-effort split.
    sourceIds = row.source_event_ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return {
    text: row.memory,
    metadata: {
      source: "memori-tier3-promotion",
      memori_id: row.id,
      memori_ts: row.ts,
      entity_id: row.entity_id,
      kind: row.kind,
      reason: row.reason,
      confidence: row.confidence,
      reviewer_model: row.reviewer_model,
      source_event_ids: sourceIds,
    },
  };
}

/**
 * Run one promotion tick. Always returns a result object — never throws
 * past this boundary. Caller (ticker / future HTTP run-now) handles
 * logging + broadcasting using this shape.
 */
export async function runOneTick(): Promise<CogneePromotionTickResult> {
  ensureHydrated();
  const t0 = deps.now();
  _state.last_run_at_ms = t0;

  const rows = deps.listCurated({
    afterTs: _state.last_promoted_ts,
    afterId: _state.last_promoted_id,
    limit: deps.batchLimit,
  });

  if (rows.length === 0) {
    // Persist the touch on last_run_at_ms so observability still moves.
    persistStateToDisk(deps.statePath, _state);
    return {
      ok: true,
      scanned: 0,
      promoted: 0,
      errored: 0,
      watermark_ts: _state.last_promoted_ts,
      watermark_id: _state.last_promoted_id,
      elapsed_ms: deps.now() - t0,
      note: "no curated rows past watermark",
    };
  }

  let promoted = 0;
  let errored = 0;
  let firstError: string | undefined;

  for (const row of rows) {
    const payload = buildPayload(row);
    let result: CogneeResult<{ id: string | null }>;
    try {
      result = await deps.cogneeRemember(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: `cognee remember threw: ${msg}` };
    }
    if (!result.ok) {
      errored++;
      if (!firstError) firstError = result.error;
      _state.errors.push({
        memori_id: row.id,
        error: result.error,
        ts: new Date(deps.now()).toISOString(),
      });
      if (_state.errors.length > MAX_RECENT_ERRORS) {
        _state.errors = _state.errors.slice(-MAX_RECENT_ERRORS);
      }
      // DO NOT advance watermark on failure — leave the row to retry
      // next tick. We continue past this row so a single bad write
      // doesn't block the rest of the batch.
      continue;
    }
    // Success → advance watermark to this row's (ts, id).
    _state.last_promoted_ts = row.ts;
    _state.last_promoted_id = row.id;
    _state.total_promoted++;
    promoted++;
  }

  persistStateToDisk(deps.statePath, _state);

  const elapsed_ms = deps.now() - t0;
  return {
    ok: errored === 0,
    scanned: rows.length,
    promoted,
    errored,
    watermark_ts: _state.last_promoted_ts,
    watermark_id: _state.last_promoted_id,
    elapsed_ms,
    ...(firstError ? { first_error: firstError } : {}),
  };
}

// ─── ticker ────────────────────────────────────────────────────────────────

export const PROMOTION_WATCHDOG_ID = "cognee-promotion";

export interface StartPromotionTickerOpts {
  intervalMs: number;
  registerWatchdog: (entry: {
    id: string;
    kind: string;
    kill: () => void;
  }) => void;
  touchWatchdog?: (id: string) => void;
  onError?: (err: Error) => void;
  onTick?: (result: CogneePromotionTickResult) => void;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  firstTickDelayMs?: number;
}

/**
 * Arm the periodic promotion loop. Returns a `stop()` closure that
 * clears both the boot timeout and the recurring interval.
 *
 * Mirrors the memory-kernel ticker shape (server.ts:2610) so the seam
 * looks identical to anyone tracing memory-pipeline lifecycle.
 */
export function startPromotionTicker(opts: StartPromotionTickerOpts): () => void {
  const sched = opts.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  let stopped = false;
  let inFlight = false;
  let tickHandle: unknown = null;
  let bootHandle: unknown = null;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      opts.touchWatchdog?.(PROMOTION_WATCHDOG_ID);
      const result = await runOneTick();
      opts.onTick?.(result);
      if (!result.ok && result.first_error) {
        opts.onError?.(new Error(result.first_error));
      }
    } catch (err) {
      opts.onError?.(err as Error);
    } finally {
      inFlight = false;
    }
  };

  const stopFn = () => {
    if (stopped) return;
    stopped = true;
    // Flip armed=false BEFORE we tear timers down so any racing diag
    // read sees the correct runtime state. Idempotent — re-entering
    // stopFn no-ops above on `stopped`.
    _armed = false;
    try {
      if (bootHandle !== null) sched.clearTimeout(bootHandle);
    } catch {
      /* ignore */
    }
    try {
      if (tickHandle !== null) sched.clearInterval(tickHandle);
    } catch {
      /* ignore */
    }
  };

  const firstDelay = opts.firstTickDelayMs ?? 15_000;
  bootHandle = sched.setTimeout(() => {
    if (stopped) return;
    void tick();
    tickHandle = sched.setInterval(() => void tick(), opts.intervalMs);
  }, firstDelay);

  opts.registerWatchdog({
    id: PROMOTION_WATCHDOG_ID,
    kind: PROMOTION_WATCHDOG_ID,
    kill: stopFn,
  });

  // Last step before returning the stop handle — invariant: if any
  // earlier line (scheduler, registerWatchdog) throws, _armed stays
  // false. Mirrors CodeRabbit MAJOR finding (server.ts:5497-5515) that
  // diag's `armed` must reflect runtime state, not static-gate config.
  _armed = true;

  return stopFn;
}
