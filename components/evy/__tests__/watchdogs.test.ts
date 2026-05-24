// components/evy/__tests__/watchdogs.test.ts
//
// v2.7.19 — Watchdog registry contracts. The registry backs three
// surfaces (Evy tools, dashboard, Telegram) so the public API is small
// and load-bearing. These tests pin:
//
//   1. register → list → kill round-trip with side-effects observed.
//   2. kill-missing-id surfaces a structured error, never throws.
//   3. duplicate registration is loud (throws) — leaks should fail fast.
//   4. touchWatchdog moves last_tick_at forward; unknown id is a no-op.
//   5. killAllWatchdogs honors `preserve_kinds` so the Telegram
//      /watchdogs killall command can't accidentally sever its own
//      command path.
//   6. age_seconds advances over wall-clock time.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  registerWatchdog,
  touchWatchdog,
  listWatchdogs,
  killWatchdog,
  killAllWatchdogs,
  _resetForTesting,
} from "../watchdogs";

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

describe("registerWatchdog", () => {
  test("registers an entry that listWatchdogs returns", () => {
    let killed = false;
    registerWatchdog({
      id: "test-poll",
      kind: "inbox-poll",
      kill: () => {
        killed = true;
      },
    });
    const all = listWatchdogs();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("test-poll");
    expect(all[0]!.kind).toBe("inbox-poll");
    expect(all[0]!.last_tick_at).toBeNull();
    expect(all[0]!.started_at.length).toBeGreaterThan(0);
    expect(all[0]!.age_seconds).toBeGreaterThanOrEqual(0);
    expect(killed).toBe(false); // not killed yet
  });

  test("throws on duplicate id (loud — duplicates indicate a leak)", () => {
    registerWatchdog({ id: "dup", kind: "inbox-poll", kill: () => {} });
    expect(() =>
      registerWatchdog({ id: "dup", kind: "inbox-poll", kill: () => {} }),
    ).toThrow(/already registered/i);
  });
});

describe("listWatchdogs", () => {
  test("returns a fresh array (caller can mutate without poisoning the registry)", () => {
    registerWatchdog({ id: "a", kind: "inbox-poll", kill: () => {} });
    const list1 = listWatchdogs();
    list1.length = 0; // mutate caller copy
    const list2 = listWatchdogs();
    expect(list2).toHaveLength(1); // registry untouched
  });

  test("snapshot shape includes age_seconds derived from started_at", async () => {
    registerWatchdog({ id: "age-test", kind: "inbox-poll", kill: () => {} });
    const first = listWatchdogs()[0]!;
    // Sleep ~1.1s so the integer floor of age has time to advance.
    await new Promise((r) => setTimeout(r, 1100));
    const second = listWatchdogs()[0]!;
    expect(second.age_seconds).toBeGreaterThan(first.age_seconds);
  });
});

describe("touchWatchdog", () => {
  test("advances last_tick_at on an existing id", async () => {
    registerWatchdog({ id: "tick", kind: "inbox-poll", kill: () => {} });
    expect(listWatchdogs()[0]!.last_tick_at).toBeNull();
    touchWatchdog("tick");
    const after1 = listWatchdogs()[0]!.last_tick_at;
    expect(after1).not.toBeNull();
    // Bump again to confirm monotonicity. ISO timestamps compare
    // lexicographically the same as chronologically.
    await new Promise((r) => setTimeout(r, 20));
    touchWatchdog("tick");
    const after2 = listWatchdogs()[0]!.last_tick_at;
    expect(after2! > after1!).toBe(true);
  });

  test("silent no-op on unknown id (so ticker wiring can't crash daemon)", () => {
    expect(() => touchWatchdog("nope")).not.toThrow();
    expect(listWatchdogs()).toHaveLength(0);
  });
});

describe("killWatchdog", () => {
  test("invokes kill() and removes the entry", () => {
    let killed = false;
    registerWatchdog({
      id: "kill-me",
      kind: "inbox-poll",
      kill: () => {
        killed = true;
      },
    });
    const result = killWatchdog("kill-me");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.killed_id).toBe("kill-me");
    }
    expect(killed).toBe(true);
    expect(listWatchdogs()).toHaveLength(0);
  });

  test("returns { ok: false, error } on unknown id — never throws", () => {
    const result = killWatchdog("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown watchdog id/i);
      expect(result.error).toMatch(/ghost/);
    }
  });

  test("swallows kill() throws but still removes the entry", () => {
    registerWatchdog({
      id: "throws",
      kind: "inbox-poll",
      kill: () => {
        throw new Error("teardown blew up");
      },
    });
    const result = killWatchdog("throws");
    expect(result.ok).toBe(true);
    // Crucially: the entry is gone even though kill() threw, so a
    // misbehaving teardown can't leave the registry showing ghosts.
    expect(listWatchdogs()).toHaveLength(0);
  });

  test("double-kill returns { ok: false } on the second call", () => {
    registerWatchdog({ id: "once", kind: "inbox-poll", kill: () => {} });
    const r1 = killWatchdog("once");
    const r2 = killWatchdog("once");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
  });
});

describe("killAllWatchdogs", () => {
  test("kills everything when no preserve_kinds is given", () => {
    let killedA = false;
    let killedB = false;
    registerWatchdog({ id: "a", kind: "inbox-poll", kill: () => { killedA = true; } });
    registerWatchdog({ id: "b", kind: "team-staleness", kill: () => { killedB = true; } });
    const result = killAllWatchdogs();
    expect(result.killed.sort()).toEqual(["a", "b"]);
    expect(result.preserved).toEqual([]);
    expect(killedA).toBe(true);
    expect(killedB).toBe(true);
    expect(listWatchdogs()).toHaveLength(0);
  });

  test("preserves entries whose kind is in preserve_kinds (the /watchdogs killall contract)", () => {
    registerWatchdog({ id: "tg", kind: "telegram-listener", kill: () => {} });
    registerWatchdog({ id: "tg-cli", kind: "cli-prompt-poll", kill: () => {} });
    registerWatchdog({ id: "tea", kind: "team-staleness", kill: () => {} });
    registerWatchdog({ id: "inbox", kind: "inbox-poll", kill: () => {} });

    const result = killAllWatchdogs({ preserve_kinds: ["telegram-listener"] });

    expect(result.preserved).toEqual(["tg"]);
    expect(result.killed.sort()).toEqual(["inbox", "tea", "tg-cli"]);
    const survivors = listWatchdogs().map((w) => w.id);
    expect(survivors).toEqual(["tg"]);
  });

  test("swallows kill() throws during killall and removes the entry anyway", () => {
    registerWatchdog({
      id: "throws-too",
      kind: "inbox-poll",
      kill: () => {
        throw new Error("nope");
      },
    });
    registerWatchdog({ id: "ok", kind: "inbox-poll", kill: () => {} });
    const result = killAllWatchdogs();
    expect(result.killed.sort()).toEqual(["ok", "throws-too"]);
    expect(listWatchdogs()).toHaveLength(0);
  });
});
