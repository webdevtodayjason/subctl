// components/master/__tests__/watchdog-diag.test.ts
//
// v2.7.35 — Tests for the rich watchdog diagnostic surface.
//
// Pins:
//   1. /diag entries have every documented field (shape lock).
//   2. classifyStatus boundaries — healthy/degraded/dead per spec.
//   3. Long-poll kinds (telegram-listener) report healthy regardless.
//   4. Unknown kinds report "unknown" status.
//   5. Tick history observer captures last_tick_at advances.
//   6. Notification correlator maps kinds to watchdog ids correctly.
//   7. Restart factory round-trip: register → run → can_restart=true.
//   8. recordWatchdogError surfaces in the diag entry.
//   9. Killed watchdogs garbage-collect their history.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  registerWatchdog,
  touchWatchdog,
  killWatchdog,
  _resetForTesting as resetRegistry,
  type WatchdogSnapshot,
} from "../watchdogs";
import {
  classifyStatus,
  expectedIntervalSeconds,
  observeOnce,
  recordWatchdogError,
  registerRestartFactory,
  runRestartFactory,
  canRestart,
  getWatchdogDiag,
  listWatchdogDiag,
  notificationToWatchdogId,
  startWatchdogDiagNotificationTracker,
  stopWatchdogDiagNotificationTracker,
  _resetForTesting as resetDiag,
  _injectTickForTesting,
  _injectNotificationForTesting,
} from "../watchdog-diag";
import {
  emitNotification,
  _resetForTesting as resetNotifications,
  type Notification,
} from "../notifications";

beforeEach(() => {
  resetRegistry();
  resetDiag();
  resetNotifications();
});

afterEach(() => {
  resetRegistry();
  resetDiag();
  resetNotifications();
});

// ── helpers ──────────────────────────────────────────────────────────────

function snapshot(opts: {
  id: string;
  kind: string;
  startedAgoMs: number;
  lastTickAgoMs: number | null;
}): WatchdogSnapshot {
  const now = Date.now();
  const startedMs = now - opts.startedAgoMs;
  return {
    id: opts.id,
    kind: opts.kind,
    started_at: new Date(startedMs).toISOString(),
    last_tick_at:
      opts.lastTickAgoMs === null
        ? null
        : new Date(now - opts.lastTickAgoMs).toISOString(),
    age_seconds: Math.floor(opts.startedAgoMs / 1000),
  };
}

// ── shape tests ──────────────────────────────────────────────────────────

describe("listWatchdogDiag shape", () => {
  test("entry includes every documented field", () => {
    registerWatchdog({ id: "test-poll", kind: "inbox-poll", kill: () => {} });
    touchWatchdog("test-poll");
    observeOnce();
    const all = listWatchdogDiag();
    expect(all).toHaveLength(1);
    const e = all[0]!;
    expect(e.id).toBe("test-poll");
    expect(e.kind).toBe("inbox-poll");
    expect(typeof e.started_at).toBe("string");
    expect(typeof e.age_seconds).toBe("number");
    expect(typeof e.status).toBe("string");
    expect(e.expected_interval_seconds).toBe(2); // inbox-poll
    expect(Array.isArray(e.tick_history)).toBe(true);
    expect(Array.isArray(e.recent_notifications)).toBe(true);
    expect(e.last_error).toBeNull(); // not yet
    expect(e.memory_bytes).toBeNull(); // always null today
    expect(typeof e.can_restart).toBe("boolean");
  });

  test("sorts dead → degraded → unknown → healthy", () => {
    registerWatchdog({ id: "a", kind: "auto-compact", kill: () => {} });
    registerWatchdog({ id: "b", kind: "team-staleness", kill: () => {} });
    registerWatchdog({ id: "c", kind: "inbox-poll", kill: () => {} });
    // Make a dead, b degraded by touching only b recently.
    touchWatchdog("c");
    touchWatchdog("b");
    observeOnce();
    const list = listWatchdogDiag();
    // We can't precisely control timestamps here without injecting now,
    // but the contract is: dead/degraded must precede healthy by status
    // rank. Verify the ordering is consistent with the rank fn.
    const rank = (st: string) =>
      st === "dead" ? 0 : st === "degraded" ? 1 : st === "unknown" ? 2 : 3;
    for (let i = 1; i < list.length; i++) {
      expect(rank(list[i - 1]!.status)).toBeLessThanOrEqual(rank(list[i]!.status));
    }
  });
});

// ── status classification ────────────────────────────────────────────────

describe("classifyStatus", () => {
  test("healthy when last tick is within 2× expected interval", () => {
    const s = snapshot({
      id: "x",
      kind: "team-staleness", // 180s expected
      startedAgoMs: 60_000,
      lastTickAgoMs: 200_000, // ~ within 2x (360s threshold)
    });
    expect(classifyStatus(s)).toBe("healthy");
  });

  test("degraded when between 2× and 5× expected interval", () => {
    const s = snapshot({
      id: "x",
      kind: "team-staleness", // 180s expected
      startedAgoMs: 60_000_0,
      lastTickAgoMs: 400_000, // ~6.7 min — past 2x(6min), under 5x(15min)
    });
    expect(classifyStatus(s)).toBe("degraded");
  });

  test("dead when older than 5× expected interval", () => {
    const s = snapshot({
      id: "x",
      kind: "team-staleness", // 180s expected
      startedAgoMs: 9_999_999,
      lastTickAgoMs: 1_500_000, // 25min — well past 5x (15min)
    });
    expect(classifyStatus(s)).toBe("dead");
  });

  test("long-poll kinds always healthy when registered", () => {
    const s = snapshot({
      id: "tg",
      kind: "telegram-listener",
      startedAgoMs: 60_000_000,
      lastTickAgoMs: null, // never ticked
    });
    expect(classifyStatus(s)).toBe("healthy");
  });

  test("unknown kind classifies as 'unknown'", () => {
    const s = snapshot({
      id: "weird",
      kind: "my-custom-kind-not-in-table",
      startedAgoMs: 5_000,
      lastTickAgoMs: 1_000,
    });
    expect(classifyStatus(s)).toBe("unknown");
  });

  test("never-ticked watchdog has grace until 2× expected interval has elapsed", () => {
    // expected 60s for followup-scheduler → grace = 120s
    const fresh = snapshot({
      id: "fresh",
      kind: "followup-scheduler",
      startedAgoMs: 10_000, // 10s old, never ticked
      lastTickAgoMs: null,
    });
    expect(classifyStatus(fresh)).toBe("healthy");

    const old = snapshot({
      id: "old",
      kind: "followup-scheduler",
      startedAgoMs: 800_000, // 13min old, never ticked → dead
      lastTickAgoMs: null,
    });
    expect(classifyStatus(old)).toBe("dead");
  });

  test("expectedIntervalSeconds returns null for unknown kinds", () => {
    expect(expectedIntervalSeconds("not-a-real-kind")).toBeNull();
    expect(expectedIntervalSeconds("inbox-poll")).toBe(2);
    expect(expectedIntervalSeconds("telegram-listener")).toBe(-1);
  });
});

// ── tick history observer ─────────────────────────────────────────────────

describe("observer", () => {
  test("observeOnce captures tick history when last_tick_at advances", () => {
    registerWatchdog({ id: "t1", kind: "inbox-poll", kill: () => {} });
    touchWatchdog("t1");
    observeOnce();
    let e = getWatchdogDiag("t1")!;
    expect(e.tick_history).toHaveLength(1);
    // Tick again after waiting so the ISO timestamp advances.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        touchWatchdog("t1");
        observeOnce();
        e = getWatchdogDiag("t1")!;
        expect(e.tick_history.length).toBeGreaterThanOrEqual(2);
        // delta_ms on the SECOND record should be a positive number.
        expect(typeof e.tick_history[1]!.delta_ms).toBe("number");
        expect(e.tick_history[1]!.delta_ms!).toBeGreaterThan(0);
        resolve();
      }, 10);
    });
  });

  test("garbage-collects history when a watchdog is killed", () => {
    registerWatchdog({ id: "kill-me", kind: "inbox-poll", kill: () => {} });
    touchWatchdog("kill-me");
    observeOnce();
    expect(getWatchdogDiag("kill-me")).not.toBeNull();

    killWatchdog("kill-me");
    observeOnce(); // observer prunes
    expect(getWatchdogDiag("kill-me")).toBeNull();
  });
});

// ── notification correlation ──────────────────────────────────────────────

describe("notificationToWatchdogId", () => {
  test("maps team-stale family to team-staleness", () => {
    const n: Notification = {
      id: "1",
      kind: "team-stale",
      severity: "warn",
      title: "x",
      body: "x",
      ts: new Date().toISOString(),
      read_at: null,
    };
    expect(notificationToWatchdogId(n)).toBe("team-staleness");
  });
  test("maps auto-compact-error to auto-compact", () => {
    const n: Notification = {
      id: "1",
      kind: "auto-compact-error",
      severity: "warn",
      title: "x",
      body: "x",
      ts: new Date().toISOString(),
      read_at: null,
    };
    expect(notificationToWatchdogId(n)).toBe("auto-compact");
  });
  test("maps upstream-available to upstream-check", () => {
    const n: Notification = {
      id: "1",
      kind: "upstream-available",
      severity: "info",
      title: "x",
      body: "x",
      ts: new Date().toISOString(),
      read_at: null,
    };
    expect(notificationToWatchdogId(n)).toBe("upstream-check");
  });
  test("returns null for unattributable kinds", () => {
    const n: Notification = {
      id: "1",
      kind: "random-kind",
      severity: "info",
      title: "x",
      body: "x",
      ts: new Date().toISOString(),
      read_at: null,
    };
    expect(notificationToWatchdogId(n)).toBeNull();
  });
});

describe("notification tracker", () => {
  test("subscribed tracker routes new emissions to the matching watchdog", () => {
    registerWatchdog({ id: "auto-compact", kind: "auto-compact", kill: () => {} });
    startWatchdogDiagNotificationTracker();
    emitNotification({
      kind: "auto-compact-error",
      severity: "warn",
      title: "boom",
      body: "tick threw",
    });
    const e = getWatchdogDiag("auto-compact")!;
    expect(e.recent_notifications).toHaveLength(1);
    expect(e.recent_notifications[0]!.title).toBe("boom");
    stopWatchdogDiagNotificationTracker();
  });

  test("backfills from the existing ring on start", () => {
    emitNotification({
      kind: "team-stale",
      severity: "warn",
      title: "team-A went stale",
      body: "12 min idle",
    });
    registerWatchdog({ id: "team-staleness", kind: "team-staleness", kill: () => {} });
    startWatchdogDiagNotificationTracker();
    const e = getWatchdogDiag("team-staleness")!;
    expect(e.recent_notifications).toHaveLength(1);
    expect(e.recent_notifications[0]!.kind).toBe("team-stale");
    stopWatchdogDiagNotificationTracker();
  });
});

// ── restart factory ───────────────────────────────────────────────────────

describe("registerRestartFactory / runRestartFactory", () => {
  test("round-trip: register → run → factory fires", () => {
    let fired = 0;
    registerRestartFactory("foo", () => {
      fired++;
    });
    expect(canRestart("foo")).toBe(true);
    const r = runRestartFactory("foo");
    expect(r.ok).toBe(true);
    expect(fired).toBe(1);
  });

  test("unknown id returns structured error", () => {
    const r = runRestartFactory("not-registered");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no restart factory/);
  });

  test("factory throw is captured as structured error, not propagated", () => {
    registerRestartFactory("bad", () => {
      throw new Error("boom");
    });
    const r = runRestartFactory("bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/boom/);
  });

  test("can_restart reflects factory presence", () => {
    registerWatchdog({ id: "can-restart-me", kind: "auto-compact", kill: () => {} });
    let e = getWatchdogDiag("can-restart-me")!;
    expect(e.can_restart).toBe(false);
    registerRestartFactory("can-restart-me", () => {});
    e = getWatchdogDiag("can-restart-me")!;
    expect(e.can_restart).toBe(true);
  });
});

// ── recordWatchdogError ───────────────────────────────────────────────────

describe("recordWatchdogError", () => {
  test("surfaces in the diag entry as last_error", () => {
    registerWatchdog({ id: "errored", kind: "auto-compact", kill: () => {} });
    recordWatchdogError("errored", new Error("kaboom"));
    const e = getWatchdogDiag("errored")!;
    expect(e.last_error).not.toBeNull();
    expect(e.last_error!.message).toBe("kaboom");
    expect(typeof e.last_error!.stack).toBe("string");
  });

  test("accepts non-Error values without throwing", () => {
    registerWatchdog({ id: "errored", kind: "auto-compact", kill: () => {} });
    recordWatchdogError("errored", "raw string");
    const e = getWatchdogDiag("errored")!;
    expect(e.last_error!.message).toBe("raw string");
    expect(e.last_error!.stack).toBeNull();
  });
});

// ── direct injection helpers (for downstream tests) ───────────────────────

describe("test injection helpers", () => {
  test("_injectTickForTesting populates tick history", () => {
    registerWatchdog({ id: "i", kind: "inbox-poll", kill: () => {} });
    _injectTickForTesting("i", new Date(Date.now() - 4_000).toISOString());
    _injectTickForTesting("i", new Date(Date.now() - 2_000).toISOString());
    const e = getWatchdogDiag("i")!;
    expect(e.tick_history).toHaveLength(2);
    expect(e.tick_history[1]!.delta_ms).toBeGreaterThan(0);
  });

  test("_injectNotificationForTesting populates notification history", () => {
    registerWatchdog({ id: "i", kind: "auto-compact", kill: () => {} });
    const n: Notification = {
      id: "fake-1",
      kind: "auto-compact-error",
      severity: "warn",
      title: "fake",
      body: "fake",
      ts: new Date().toISOString(),
      read_at: null,
    };
    _injectNotificationForTesting("i", n);
    const e = getWatchdogDiag("i")!;
    expect(e.recent_notifications).toHaveLength(1);
  });
});
