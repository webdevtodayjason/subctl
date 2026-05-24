// components/evy/consciousness-loop/signals.ts
//
// Memory Init #7 — compact signal gathering + canonical hashing.
//
// The cognition loop is meant to be cheap and bounded. The signal
// bundle MUST stay small enough that hashing and serializing it on
// every tick is negligible. v0.1 sources:
//
//   - watchdog registry  → id/kind/age (no internal pointers)
//   - notifications      → counts only
//   - followups          → pending count + next-due timestamp
//
// `gatherSignals` accepts injectable provider functions so the tick
// runner can be tested without the watchdog registry or notifications
// module loaded.
//
// Canonical hashing: sorted-keys JSON → sha256 → hex. Stable across
// processes, deterministic for "did anything change?" checks. We
// deliberately exclude `ts` from the hash (otherwise unchanged state
// would still hash differently every tick).

import { createHash } from "node:crypto";

import type { SignalBundle } from "./types";

export interface SignalProviders {
  /** Watchdog snapshot — see watchdogs.ts listWatchdogs(). */
  watchdogs: () => Array<{
    id: string;
    kind: string;
    age_seconds: number;
    last_tick_at: string | null;
    expected_interval_s?: number | null;
  }>;
  /** Notification rollup. */
  notifications: () => {
    total: number;
    unread: number;
    by_severity: Record<string, number>;
  };
  /** Followup queue summary. */
  followups: () => { pending: number; next_due_at: string | null };
  /**
   * Optional extension hook. Each entry adds one keyed blob to the
   * signal bundle's `extra` field. Useful for tests + future
   * integrations without touching this file.
   */
  extra?: () => Record<string, unknown> | null;
}

export function gatherSignals(providers: SignalProviders): SignalBundle {
  const bundle: SignalBundle = {
    ts: new Date().toISOString(),
    watchdogs: safeCall(providers.watchdogs, []),
    notifications: safeCall(providers.notifications, {
      total: 0,
      unread: 0,
      by_severity: {},
    }),
    followups: safeCall(providers.followups, {
      pending: 0,
      next_due_at: null,
    }),
  };
  if (providers.extra) {
    const ex = safeCall(providers.extra, null);
    if (ex && typeof ex === "object") bundle.extra = ex;
  }
  return bundle;
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Canonical JSON serialization: keys sorted at every level, arrays
 * preserved in order. Used as input to the signal hash so two bundles
 * with the same logical content always hash identically.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Hash the signal bundle MINUS its `ts` field — otherwise the loop
 * could never detect "unchanged" state. The watchdog ages and unread
 * counts ARE included on purpose: a watchdog growing stale is a
 * meaningful change worth noticing.
 *
 * Note: watchdog `age_seconds` changes every tick by construction. To
 * keep "unchanged" detection useful we coarsen it to 10-second buckets
 * inside the hash input only — the bundle itself keeps the precise
 * value for the planner / audit.
 */
export function hashSignalBundle(bundle: SignalBundle): string {
  const coarsened = {
    ...bundle,
    ts: undefined,
    watchdogs: bundle.watchdogs.map((w) => ({
      ...w,
      age_seconds: Math.floor(w.age_seconds / 10) * 10,
    })),
  };
  // Drop `ts` cleanly from the serialized input.
  delete (coarsened as { ts?: unknown }).ts;
  const input = canonicalize(coarsened);
  return createHash("sha256").update(input).digest("hex");
}
