// components/master/__tests__/notifications.test.ts
//
// v2.7.22 — operator notification channel.
//
// Pins:
//   1. emit/list/markRead/markAllRead round-trip
//   2. Ring buffer evicts oldest when it hits the cap (NOTIFICATION_RING_LIMIT=200)
//   3. severity routing — subscribers see every emit, but only "alert"
//      gets surfaced to the Telegram-push test callback. (The actual
//      Telegram push lives in server.ts; we verify the callback contract
//      a subscriber would implement.)
//   4. listNotifications honors `since` + `limit`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  emitNotification,
  listNotifications,
  markRead,
  markAllRead,
  subscribeNotifications,
  unreadCount,
  _resetForTesting,
  NOTIFICATION_RING_LIMIT,
  type Notification,
} from "../notifications";

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

describe("emitNotification / listNotifications / markRead", () => {
  test("emit + list round-trip surfaces the entry newest-first", () => {
    const a = emitNotification({
      kind: "team-nudge-sent",
      severity: "info",
      title: "nudged team-foo",
      body: "first",
    });
    const b = emitNotification({
      kind: "team-unresponsive",
      severity: "alert",
      title: "team-foo unresponsive",
      body: "second",
    });
    const all = listNotifications();
    expect(all.length).toBe(2);
    // Newest-first
    expect(all[0]?.id).toBe(b.id);
    expect(all[1]?.id).toBe(a.id);
    expect(all[0]?.severity).toBe("alert");
    expect(all[1]?.severity).toBe("info");
    // Each entry should have a stable id and an ISO ts
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Default read_at is null
    expect(a.read_at).toBeNull();
  });

  test("title >80 chars is truncated with ellipsis", () => {
    const long = "x".repeat(120);
    const n = emitNotification({
      kind: "test",
      severity: "info",
      title: long,
      body: "",
    });
    expect(n.title.length).toBeLessThanOrEqual(80);
    expect(n.title.endsWith("…")).toBe(true);
  });

  test("markRead flips read_at; unreadCount reflects the change", () => {
    const n = emitNotification({
      kind: "k",
      severity: "info",
      title: "t",
      body: "b",
    });
    expect(unreadCount()).toBe(1);
    const ok = markRead(n.id);
    expect(ok).toBe(true);
    expect(unreadCount()).toBe(0);
    const [back] = listNotifications();
    expect(back?.read_at).not.toBeNull();
  });

  test("markRead returns false for unknown id", () => {
    emitNotification({ kind: "k", severity: "info", title: "t", body: "b" });
    expect(markRead("not-a-real-id")).toBe(false);
    expect(unreadCount()).toBe(1);
  });

  test("markAllRead returns the number of newly-read entries", () => {
    emitNotification({ kind: "a", severity: "info", title: "1", body: "" });
    emitNotification({ kind: "b", severity: "warn", title: "2", body: "" });
    emitNotification({ kind: "c", severity: "alert", title: "3", body: "" });
    expect(markAllRead()).toBe(3);
    expect(markAllRead()).toBe(0); // already read
    expect(unreadCount()).toBe(0);
  });
});

describe("ring buffer eviction", () => {
  test("buffer evicts oldest when it crosses NOTIFICATION_RING_LIMIT", () => {
    // Push limit+5 entries, recording the first 5 ids — they should be
    // evicted, the rest preserved.
    const evictedIds = new Set<string>();
    for (let i = 0; i < NOTIFICATION_RING_LIMIT + 5; i++) {
      const n = emitNotification({
        kind: "test",
        severity: "info",
        title: `n${i}`,
        body: "",
      });
      if (i < 5) evictedIds.add(n.id);
    }
    const all = listNotifications({ limit: NOTIFICATION_RING_LIMIT + 10 });
    expect(all.length).toBe(NOTIFICATION_RING_LIMIT);
    for (const n of all) {
      expect(evictedIds.has(n.id)).toBe(false);
    }
  });
});

describe("severity routing", () => {
  test("subscribers see every emit; alert-only routes to a Telegram-style callback", () => {
    const seen: Notification[] = [];
    const telegramSent: Notification[] = [];

    subscribeNotifications((n) => seen.push(n));
    // The Telegram pusher in server.ts is just: subscribe + if alert, send.
    // Re-implement that contract here so the routing rule is pinned.
    subscribeNotifications((n) => {
      if (n.severity === "alert") telegramSent.push(n);
    });

    emitNotification({ kind: "info-thing", severity: "info", title: "i", body: "" });
    emitNotification({ kind: "warn-thing", severity: "warn", title: "w", body: "" });
    emitNotification({ kind: "alert-thing", severity: "alert", title: "a", body: "" });

    expect(seen.length).toBe(3);
    expect(telegramSent.length).toBe(1);
    expect(telegramSent[0]?.severity).toBe("alert");
    expect(telegramSent[0]?.title).toBe("a");
  });

  test("a subscriber that throws does not poison the dispatch loop", () => {
    const ok: Notification[] = [];
    subscribeNotifications(() => {
      throw new Error("subscriber boom");
    });
    subscribeNotifications((n) => ok.push(n));
    expect(() =>
      emitNotification({ kind: "k", severity: "info", title: "t", body: "" }),
    ).not.toThrow();
    expect(ok.length).toBe(1);
  });
});

describe("listNotifications filters", () => {
  test("since filters to entries strictly newer than the cutoff", async () => {
    const a = emitNotification({ kind: "k", severity: "info", title: "a", body: "" });
    // Wait long enough that the next ISO ts is strictly greater.
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const b = emitNotification({ kind: "k", severity: "info", title: "b", body: "" });

    const after = listNotifications({ since: cutoff });
    expect(after.length).toBe(1);
    expect(after[0]?.id).toBe(b.id);
    // Force the linter to acknowledge `a` — it pins the "older entry is filtered out" half of the contract.
    expect(a.id).not.toBe(b.id);
  });

  test("limit caps the returned slice", () => {
    for (let i = 0; i < 10; i++) {
      emitNotification({ kind: "k", severity: "info", title: `n${i}`, body: "" });
    }
    expect(listNotifications({ limit: 3 }).length).toBe(3);
  });
});
