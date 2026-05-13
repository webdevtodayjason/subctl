// components/master/watchdog-diag.ts
//
// v2.7.35 — Rich diagnostic surface for the watchdog registry.
//
// The base registry in watchdogs.ts (v2.7.19) tracks the bare minimum
// needed for kill controls: id, kind, started_at, last_tick_at, kill().
// That's enough for the existing kill-table UI and the /watchdogs Telegram
// command, but it doesn't answer the questions the operator actually
// asks when something looks wrong:
//
//   "Is this watchdog dead, slow, or behaving normally?"
//   "When was the LAST 20 ticks — am I seeing it slow down?"
//   "Which notifications has THIS watchdog emitted recently?"
//   "Did it throw the last time it tried to tick?"
//
// This module layers those answers on top of the existing registry
// without mutating it. The registry is shared with watchdog-notif-ux
// (notifications channel emitter); modifying watchdogs.ts would risk
// the two scopes diverging. So:
//
//   1. Tick history — a passive observer polls listWatchdogs() every
//      500ms and records a row whenever last_tick_at advances. Zero
//      changes to existing touchWatchdog() sites.
//   2. Last error — exposed as recordWatchdogError(id, err). Callers
//      that already catch tick errors (auto-compact, upstream-check)
//      opt-in by adding one call inside the catch block.
//   3. Notification history — subscribeNotifications() correlation by
//      kind prefix (auto-compact-error → auto-compact, etc).
//   4. Expected interval per kind — a static table; status classification
//      reads last_tick_at against that.
//   5. Memory bytes — null today. Per-tick allocation isn't tracked by
//      anything in the daemon and process.memoryUsage() is daemon-wide,
//      not per-watchdog. Leaving the field present (always null) so the
//      response shape is stable when we eventually wire heap diff.
//
// Status thresholds (per spec):
//   healthy:  last_tick within 2× expected_interval
//   degraded: last_tick within 5× expected_interval
//   dead:     no tick in 10× expected_interval
//
// "telegram-listener" is exempt — long-poll, no fixed cadence. It reports
// healthy whenever it's registered; the only way it goes dead is by being
// killed (in which case it disappears from the registry entirely).

import { listWatchdogs, type WatchdogKind, type WatchdogSnapshot } from "./watchdogs";
import {
  subscribeNotifications,
  listNotifications,
  type Notification,
} from "./notifications";

// ── per-kind expected tick interval (seconds) ───────────────────────────────
//
// Sourced from the actual setInterval() values in master/server.ts and
// related modules. Update here when those change — status classification
// derives from this table.
//
// Special sentinel: -1 means "long-poll / no fixed cadence". Status
// classifier reports "healthy" as long as the watchdog is registered.

const EXPECTED_INTERVAL_SECONDS: Record<string, number> = {
  "telegram-listener": -1, // long-poll
  "cli-prompt-poll": 5, // master-notify-listener.ts cli-prompts.jsonl bridge
  "inbox-poll": 2, // server.ts lead-report inbox tailer
  "team-staleness": 180, // server.ts 3-min ticker
  "followup-scheduler": 60, // server.ts 60s scheduler
  "auto-compact": 300, // server.ts 5-min safety-net compact
  "verifier-cluster": 30, // tools/policy/verifier-cluster.ts denial scan
  "upstream-check": 21600, // upstream-check.ts 6h npm poll
};

/** Look up the expected tick interval for a given kind, or null if unknown. */
export function expectedIntervalSeconds(kind: WatchdogKind): number | null {
  const v = EXPECTED_INTERVAL_SECONDS[kind];
  return typeof v === "number" ? v : null;
}

export type WatchdogStatus = "healthy" | "degraded" | "dead" | "unknown";

/**
 * Classify a watchdog snapshot into a status band based on the time
 * since its last tick vs. its expected interval. See the file header
 * for thresholds.
 *
 * @param snapshot — entry returned by listWatchdogs()
 * @param nowMs — defaults to Date.now(); injectable for tests so the
 *   thresholds are deterministic.
 */
export function classifyStatus(
  snapshot: WatchdogSnapshot,
  nowMs: number = Date.now(),
): WatchdogStatus {
  const expected = expectedIntervalSeconds(snapshot.kind);
  if (expected === null) return "unknown";
  // Long-poll: healthy as long as registered.
  if (expected < 0) return "healthy";
  // Never ticked yet — grace until 2× the expected interval has elapsed
  // since `started_at` so newly-armed watchdogs aren't flagged dead.
  if (!snapshot.last_tick_at) {
    const ageMs = nowMs - Date.parse(snapshot.started_at);
    if (ageMs < expected * 2 * 1000) return "healthy";
    if (ageMs < expected * 5 * 1000) return "degraded";
    return "dead";
  }
  const sinceTickMs = nowMs - Date.parse(snapshot.last_tick_at);
  if (sinceTickMs < expected * 2 * 1000) return "healthy";
  if (sinceTickMs < expected * 5 * 1000) return "degraded";
  return "dead";
}

// ── tick history (passive observer) ─────────────────────────────────────────
//
// Per-id ring buffer of the last 20 ticks observed. The observer polls
// listWatchdogs() every OBSERVER_INTERVAL_MS and writes a TickRecord
// whenever last_tick_at changes. Polling rate is faster than the fastest
// real watchdog (inbox-poll @ 2s) so we don't miss ticks.

export interface TickRecord {
  /** ISO 8601 timestamp the tick was observed at. */
  ts: string;
  /** Milliseconds since the previous tick, or null for the first tick. */
  delta_ms: number | null;
}

const TICK_HISTORY_LIMIT = 20;
const OBSERVER_INTERVAL_MS = 500;

const _tickHistory: Map<string, TickRecord[]> = new Map();
const _lastObservedTick: Map<string, string> = new Map();
const _lastError: Map<
  string,
  { ts: string; message: string; stack: string | null }
> = new Map();

let _observerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Begin watching the registry. Idempotent — calling twice is a no-op.
 * Returns a stop function so callers (and tests) can dispose cleanly.
 *
 * The observer never registers itself as a watchdog — that would create
 * a meta-cycle (the observer's own ticks would be observed). We accept
 * that the observer's freshness is not visible through this module's
 * own surface.
 */
export function startWatchdogDiagObserver(): () => void {
  if (_observerHandle) return stopWatchdogDiagObserver;
  _observerHandle = setInterval(() => {
    try {
      observeOnce();
    } catch (err) {
      // Never throw out of an interval — the master process death surface
      // is too important to take down for a diagnostic bookkeeping bug.
      console.error(
        `[watchdog-diag] observer threw: ${(err as Error).message ?? err}`,
      );
    }
  }, OBSERVER_INTERVAL_MS);
  return stopWatchdogDiagObserver;
}

/** Stop the passive observer if running. Idempotent. */
export function stopWatchdogDiagObserver(): void {
  if (_observerHandle) {
    clearInterval(_observerHandle);
    _observerHandle = null;
  }
}

/**
 * Run one observation pass. Exported for testing — production callers
 * should use startWatchdogDiagObserver().
 */
export function observeOnce(): void {
  const snaps = listWatchdogs();
  const liveIds = new Set<string>();
  for (const s of snaps) {
    liveIds.add(s.id);
    if (!s.last_tick_at) continue;
    const prev = _lastObservedTick.get(s.id);
    if (prev === s.last_tick_at) continue;
    _lastObservedTick.set(s.id, s.last_tick_at);
    const ring = _tickHistory.get(s.id) ?? [];
    const prevTickIso = ring.length > 0 ? ring[ring.length - 1]!.ts : null;
    const delta = prevTickIso
      ? Date.parse(s.last_tick_at) - Date.parse(prevTickIso)
      : null;
    ring.push({ ts: s.last_tick_at, delta_ms: delta });
    while (ring.length > TICK_HISTORY_LIMIT) ring.shift();
    _tickHistory.set(s.id, ring);
  }
  // Garbage-collect history for watchdogs that have been killed. We can't
  // distinguish "killed deliberately" from "transient unregister", but the
  // registry IS the source of truth — anything missing is gone.
  for (const id of [..._tickHistory.keys()]) {
    if (!liveIds.has(id)) {
      _tickHistory.delete(id);
      _lastObservedTick.delete(id);
      _lastError.delete(id);
    }
  }
}

/**
 * Record an error encountered by a watchdog's tick. Callers opt-in from
 * their existing try/catch; this is structurally additive — nothing in
 * the existing tick paths breaks if a caller never wires it up.
 *
 * Silent no-op for unknown ids so misuse can't crash a tick body.
 */
export function recordWatchdogError(id: string, err: unknown): void {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  _lastError.set(id, {
    ts: new Date().toISOString(),
    message,
    stack,
  });
}

// ── notification correlation ────────────────────────────────────────────────
//
// Notifications carry a `kind` field — "team-stale", "auto-compact-error",
// "upstream-available", etc. We map kinds to watchdog ids so each diag
// entry can carry the last N notifications it emitted.
//
// The mapping is conservative: when in doubt, return null and the
// notification doesn't get attributed. False positives (notification
// shown under the wrong watchdog) are worse than false negatives
// (notification visible only in the global tray).

const KIND_TO_WATCHDOG_ID: Array<[RegExp, string]> = [
  // team-staleness fires the auto-nudge family
  [/^team-(stale|nudge-sent|unresponsive)/, "team-staleness"],
  // auto-compact tick errors
  [/^auto-compact-/, "auto-compact"],
  // upstream-check family (v2.7.25)
  [/^upstream-/, "upstream-check"],
];

export function notificationToWatchdogId(n: Notification): string | null {
  for (const [re, id] of KIND_TO_WATCHDOG_ID) {
    if (re.test(n.kind)) return id;
  }
  return null;
}

const _notificationHistory: Map<string, Notification[]> = new Map();
const NOTIF_HISTORY_LIMIT = 10;
let _notifUnsub: (() => void) | null = null;

/**
 * Begin tracking per-watchdog notification history. Idempotent.
 * Subscribes to the notifications channel and routes each event to
 * the matching watchdog's ring. Also backfills from the existing
 * ring buffer so a freshly-started observer has historical context.
 */
export function startWatchdogDiagNotificationTracker(): () => void {
  if (_notifUnsub) return stopWatchdogDiagNotificationTracker;
  // Backfill from the ring so first /diag after boot isn't empty.
  for (const n of listNotifications({ limit: 200 })) {
    const id = notificationToWatchdogId(n);
    if (!id) continue;
    appendNotification(id, n);
  }
  _notifUnsub = subscribeNotifications((n) => {
    const id = notificationToWatchdogId(n);
    if (!id) return;
    appendNotification(id, n);
  });
  return stopWatchdogDiagNotificationTracker;
}

export function stopWatchdogDiagNotificationTracker(): void {
  if (_notifUnsub) {
    _notifUnsub();
    _notifUnsub = null;
  }
}

function appendNotification(watchdogId: string, n: Notification): void {
  const ring = _notificationHistory.get(watchdogId) ?? [];
  // Avoid duplicates (backfill + live subscribe overlap).
  if (ring.some((x) => x.id === n.id)) return;
  ring.push(n);
  while (ring.length > NOTIF_HISTORY_LIMIT) ring.shift();
  _notificationHistory.set(watchdogId, ring);
}

// ── restart factory registry ────────────────────────────────────────────────
//
// The watchdog registry holds a kill() closure but no way to re-arm a
// killed watchdog — once killed, the only path back is a master daemon
// restart. The dashboard's Restart button needs more flexibility. So
// each registration site can OPT-IN by also calling registerRestartFactory:
//
//   registerRestartFactory("auto-compact", () => armAutoCompactWatchdog());
//
// Restart calls kill() (if still registered) then runs the factory.
// Factories are kept across kills — they live in this module's closure,
// not in the watchdog entry, so a killed watchdog can come back.

type RestartFactory = () => void;
const _restartFactories: Map<string, RestartFactory> = new Map();

/**
 * Register a re-arm closure for a watchdog id. The factory should be
 * the same code that originally registered the watchdog (or a wrapper
 * that calls it) — restart calls factory(), which is expected to call
 * registerWatchdog() with the same id internally.
 *
 * Overwrites any previous factory for that id (registration sites are
 * usually one-per-id; we don't need to chain).
 */
export function registerRestartFactory(
  id: string,
  factory: RestartFactory,
): void {
  _restartFactories.set(id, factory);
}

/** Returns true if a restart factory is registered for `id`. */
export function canRestart(id: string): boolean {
  return _restartFactories.has(id);
}

/**
 * Run the restart factory for `id`. Returns ok=true on success;
 * { ok:false, error } if no factory is registered or the factory threw.
 *
 * Does NOT call kill() — the caller is expected to call killWatchdog()
 * first when the watchdog is still live. (Splitting the responsibility
 * keeps the HTTP endpoint composable: kill+restart vs restart-only.)
 */
export function runRestartFactory(
  id: string,
): { ok: true } | { ok: false; error: string } {
  const f = _restartFactories.get(id);
  if (!f) return { ok: false, error: `no restart factory for: ${id}` };
  try {
    f();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `restart factory threw: ${(err as Error).message ?? err}`,
    };
  }
}

// ── diag assembly ───────────────────────────────────────────────────────────

export interface WatchdogDiagEntry {
  /** Snapshot fields from listWatchdogs(). */
  id: string;
  kind: WatchdogKind;
  started_at: string;
  last_tick_at: string | null;
  age_seconds: number;
  /** Derived status — healthy / degraded / dead / unknown. */
  status: WatchdogStatus;
  /** Expected tick interval in seconds (null if unknown kind, -1 if long-poll). */
  expected_interval_seconds: number | null;
  /** Seconds since the last observed tick, or null if never ticked. */
  last_tick_ago_seconds: number | null;
  /** Whether a restart factory is registered for this id. */
  can_restart: boolean;
  /** Last 20 ticks observed (oldest first). */
  tick_history: TickRecord[];
  /** Last 10 notifications attributed to this watchdog (oldest first). */
  recent_notifications: Notification[];
  /** Last error recorded via recordWatchdogError(), or null. */
  last_error:
    | { ts: string; message: string; stack: string | null }
    | null;
  /** Per-watchdog memory bytes if measurable. Always null today — see header. */
  memory_bytes: number | null;
}

/**
 * Build the full diag entry for one watchdog id. Returns null if the
 * id is unknown to the registry.
 */
export function getWatchdogDiag(
  id: string,
  nowMs: number = Date.now(),
): WatchdogDiagEntry | null {
  const snap = listWatchdogs().find((s) => s.id === id);
  if (!snap) return null;
  return buildEntry(snap, nowMs);
}

/**
 * Build a diag snapshot for every registered watchdog. Server endpoint
 * + Telegram /watchdogs details both consume this.
 */
export function listWatchdogDiag(
  nowMs: number = Date.now(),
): WatchdogDiagEntry[] {
  return listWatchdogs()
    .map((s) => buildEntry(s, nowMs))
    .sort((a, b) => {
      // dead > degraded > unknown > healthy so the operator's eye lands
      // on the bad ones first.
      const rank = (st: WatchdogStatus) =>
        st === "dead" ? 0 : st === "degraded" ? 1 : st === "unknown" ? 2 : 3;
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.id.localeCompare(b.id);
    });
}

function buildEntry(s: WatchdogSnapshot, nowMs: number): WatchdogDiagEntry {
  const lastTickAgo =
    s.last_tick_at !== null
      ? Math.max(0, Math.floor((nowMs - Date.parse(s.last_tick_at)) / 1000))
      : null;
  return {
    id: s.id,
    kind: s.kind,
    started_at: s.started_at,
    last_tick_at: s.last_tick_at,
    age_seconds: s.age_seconds,
    status: classifyStatus(s, nowMs),
    expected_interval_seconds: expectedIntervalSeconds(s.kind),
    last_tick_ago_seconds: lastTickAgo,
    can_restart: _restartFactories.has(s.id),
    tick_history: [...(_tickHistory.get(s.id) ?? [])],
    recent_notifications: [...(_notificationHistory.get(s.id) ?? [])],
    last_error: _lastError.get(s.id) ?? null,
    memory_bytes: null,
  };
}

// ── test helpers ────────────────────────────────────────────────────────────

export function _resetForTesting(): void {
  stopWatchdogDiagObserver();
  stopWatchdogDiagNotificationTracker();
  _tickHistory.clear();
  _lastObservedTick.clear();
  _lastError.clear();
  _notificationHistory.clear();
  _restartFactories.clear();
}

/**
 * Inject a tick record directly without going through the observer.
 * Tests use this to populate history deterministically.
 */
export function _injectTickForTesting(id: string, ts: string): void {
  const ring = _tickHistory.get(id) ?? [];
  const prevTickIso = ring.length > 0 ? ring[ring.length - 1]!.ts : null;
  const delta = prevTickIso ? Date.parse(ts) - Date.parse(prevTickIso) : null;
  ring.push({ ts, delta_ms: delta });
  while (ring.length > TICK_HISTORY_LIMIT) ring.shift();
  _tickHistory.set(id, ring);
  _lastObservedTick.set(id, ts);
}

/**
 * Inject a notification record directly without going through the
 * subscription path. Tests use this to populate notification history
 * deterministically.
 */
export function _injectNotificationForTesting(
  id: string,
  n: Notification,
): void {
  appendNotification(id, n);
}
