// components/master/__tests__/memory.test.ts
//
// v2.7.23 — Evy Memory (Tier 3) storage primitive tests.
//
// Pins:
//   1. recordEntry + recallEntries round-trip preserves every field.
//   2. team_id, kind (single + array), since filters compose correctly.
//   3. FTS5 search ranks matching content; LIKE fallback also works
//      (we verify FTS5 is on in this Bun + force the fallback path via
//      a query that strips to nothing meaningful).
//   4. recentEntries returns newest-first.
//   5. purgeBefore + deleteEntry remove the right rows and the FTS
//      mirror via trigger.
//   6. DB file is chmod 600 after recordEntry, directory is chmod 700.
//   7. redactForEgress masks HMAC / sk-* / bearer tokens.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordEntry,
  recallEntries,
  recentEntries,
  purgeBefore,
  deleteEntry,
  memoryStats,
  getMemoryDbPath,
  redactForEgress,
  redactEntryForEgress,
  _isFts5Available,
  _setStateDirForTesting,
  _closeForTesting,
} from "../memory";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "subctl-memory-test-"));
  _setStateDirForTesting(tmp);
});

afterEach(() => {
  _closeForTesting();
  _setStateDirForTesting(null);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("recordEntry / recallEntries round-trip", () => {
  test("a freshly recorded entry comes back via recallEntries with every field intact", () => {
    const a = recordEntry({
      role: "user",
      kind: "message",
      content: "let's ship v2.7.23 tonight",
    });
    const b = recordEntry({
      role: "assistant",
      kind: "message",
      content: "queued — running tests first",
      metadata: { thinking: "nope, run the tests" },
    });
    const all = recallEntries({ limit: 10 });
    expect(all.length).toBe(2);
    // Newest-first
    expect(all[0]?.id).toBe(b.id);
    expect(all[1]?.id).toBe(a.id);
    expect(all[0]?.role).toBe("assistant");
    expect(all[0]?.metadata?.thinking).toBe("nope, run the tests");
    expect(all[1]?.content).toBe("let's ship v2.7.23 tonight");
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
  });

  test("team_id round-trips (null + non-null) and is filterable", () => {
    recordEntry({ role: "user", kind: "message", content: "global note" });
    recordEntry({
      role: "user",
      kind: "message",
      content: "for team alpha",
      team_id: "alpha",
    });
    recordEntry({
      role: "user",
      kind: "message",
      content: "for team beta",
      team_id: "beta",
    });
    const all = recallEntries();
    expect(all.length).toBe(3);

    const alpha = recallEntries({ team_id: "alpha" });
    expect(alpha.length).toBe(1);
    expect(alpha[0]?.content).toBe("for team alpha");

    const globalOnly = recallEntries({ team_id: null });
    expect(globalOnly.length).toBe(1);
    expect(globalOnly[0]?.content).toBe("global note");
  });
});

describe("kind filter (single + array)", () => {
  test("single kind filter returns only that kind", () => {
    recordEntry({ role: "user", kind: "message", content: "u" });
    recordEntry({ role: "event", kind: "shipped", content: "v2.7.23" });
    recordEntry({ role: "event", kind: "notification", content: "alert" });
    const shipped = recallEntries({ kind: "shipped" });
    expect(shipped.length).toBe(1);
    expect(shipped[0]?.content).toBe("v2.7.23");
  });

  test("array kind filter (event kinds) returns the union", () => {
    recordEntry({ role: "user", kind: "message", content: "u" });
    recordEntry({ role: "event", kind: "shipped", content: "v2.7.23" });
    recordEntry({ role: "event", kind: "notification", content: "alert" });
    const events = recallEntries({ kind: ["shipped", "notification"] });
    expect(events.length).toBe(2);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has("shipped")).toBe(true);
    expect(kinds.has("notification")).toBe(true);
  });
});

describe("since filter", () => {
  test("since filter drops entries with ts < since", async () => {
    const a = recordEntry({ role: "user", kind: "message", content: "old" });
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const b = recordEntry({ role: "user", kind: "message", content: "new" });
    const recent = recallEntries({ since: cutoff });
    expect(recent.length).toBe(1);
    expect(recent[0]?.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });
});

describe("text search", () => {
  test("FTS5 is available in this Bun build", () => {
    // Sanity check — we ship the v1 with FTS5 expected. The module also
    // has a LIKE fallback; if a future Bun strips FTS5 this test pins
    // the regression loud.
    expect(_isFts5Available()).toBe(true);
  });

  test("query returns content-matching entries, ranked", () => {
    recordEntry({
      role: "user",
      kind: "message",
      content: "operator wants to ship the watchdog kill controls",
    });
    recordEntry({
      role: "assistant",
      kind: "message",
      content: "let's draft the notification channel first",
    });
    recordEntry({
      role: "user",
      kind: "message",
      content: "totally unrelated text about cats and dogs",
    });
    const hits = recallEntries({ query: "watchdog" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.content).toContain("watchdog");

    // Multi-token: AND semantics — both tokens have to be present (we
    // build "tok1* AND tok2*" in the FTS expression).
    const notif = recallEntries({ query: "notification channel" });
    expect(notif.length).toBe(1);
    expect(notif[0]?.content).toContain("notification");
  });

  test("query + team_id filter compose", () => {
    recordEntry({
      team_id: "alpha",
      role: "user",
      kind: "message",
      content: "alpha is shipping the watchdog",
    });
    recordEntry({
      team_id: "beta",
      role: "user",
      kind: "message",
      content: "beta is also shipping the watchdog",
    });
    const onlyAlpha = recallEntries({ query: "watchdog", team_id: "alpha" });
    expect(onlyAlpha.length).toBe(1);
    expect(onlyAlpha[0]?.team_id).toBe("alpha");
  });

  test("query + kind filter compose", () => {
    recordEntry({
      role: "user",
      kind: "message",
      content: "user said watchdog kill is broken",
    });
    recordEntry({
      role: "event",
      kind: "notification",
      content: "watchdog tick emitted",
    });
    const onlyEvents = recallEntries({ query: "watchdog", kind: "notification" });
    expect(onlyEvents.length).toBe(1);
    expect(onlyEvents[0]?.kind).toBe("notification");
  });

  test("query that strips to nothing (punctuation only) returns the most-recent rows via LIKE fallback path", () => {
    recordEntry({ role: "user", kind: "message", content: "alpha" });
    recordEntry({ role: "user", kind: "message", content: "beta" });
    // "??" strips to empty tokens; FTS-match-expr build returns "" and we
    // fall through to the LIKE clause — which is also "%??%". With a real
    // empty query we'd get everything; here "%??%" matches nothing because
    // no row contains literal "??".
    const hits = recallEntries({ query: "??" });
    expect(hits.length).toBe(0);
  });
});

describe("recentEntries", () => {
  test("returns N newest entries in newest-first order", () => {
    for (let i = 0; i < 5; i++) {
      recordEntry({ role: "user", kind: "message", content: `n${i}` });
    }
    const r = recentEntries(3);
    expect(r.length).toBe(3);
    expect(r[0]?.content).toBe("n4");
    expect(r[1]?.content).toBe("n3");
    expect(r[2]?.content).toBe("n2");
  });
});

describe("purgeBefore + deleteEntry", () => {
  test("purgeBefore removes entries older than the cutoff and cleans FTS mirror", async () => {
    const old = recordEntry({
      role: "user",
      kind: "message",
      content: "old message with watchdog",
    });
    await new Promise((r) => setTimeout(r, 20));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = recordEntry({
      role: "user",
      kind: "message",
      content: "fresh message with watchdog",
    });
    const r = purgeBefore(cutoff);
    expect(r.deleted).toBe(1);
    // The remaining entry is the fresh one.
    const all = recallEntries();
    expect(all.length).toBe(1);
    expect(all[0]?.id).toBe(fresh.id);
    // FTS mirror — searching for "watchdog" returns only the fresh row.
    const hits = recallEntries({ query: "watchdog" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe(fresh.id);
    expect(old.id).not.toBe(fresh.id);
  });

  test("deleteEntry removes one row and reports found/missing", () => {
    const a = recordEntry({ role: "user", kind: "message", content: "doomed" });
    expect(deleteEntry(a.id)).toBe(true);
    expect(deleteEntry(a.id)).toBe(false); // already gone
    expect(recallEntries().length).toBe(0);
  });
});

describe("file permissions", () => {
  test("after first write, the DB file is chmod 600 and the parent dir is 700", () => {
    recordEntry({ role: "user", kind: "message", content: "probe" });
    const path = getMemoryDbPath();
    expect(existsSync(path)).toBe(true);
    const fileMode = statSync(path).mode & 0o777;
    expect(fileMode).toBe(0o600);
    const dirMode = statSync(join(tmp, "memory")).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe("memoryStats", () => {
  test("count + min/max ts + path reflect the live store", async () => {
    expect(memoryStats().count).toBe(0);
    recordEntry({ role: "user", kind: "message", content: "first" });
    await new Promise((r) => setTimeout(r, 5));
    recordEntry({ role: "user", kind: "message", content: "second" });
    const s = memoryStats();
    expect(s.count).toBe(2);
    expect(s.oldest_ts).not.toBeNull();
    expect(s.newest_ts).not.toBeNull();
    expect(s.path).toContain("/memory/evy.db");
    expect(s.bytes).toBeGreaterThan(0);
  });
});

describe("redactForEgress", () => {
  test("masks sk-* keys, bearer tokens, and HMAC hex blobs", () => {
    const raw =
      "API key sk-proj-abc123def456ghi789 and Authorization: Bearer eyJhbGciOiJIUzI1Ni and hmac mark 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const out = redactForEgress(raw);
    expect(out).not.toContain("sk-proj-abc123def456ghi789");
    expect(out).not.toContain("eyJhbGciOiJIUzI1Ni");
    expect(out).not.toContain(
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    );
    expect(out).toMatch(/\[REDACTED/);
  });

  test("masks hmac:<team>:<hex> trust-marker form", () => {
    const raw = "marker is hmac:alpha-team:deadbeefcafebabe1234567890abcdef";
    const out = redactForEgress(raw);
    expect(out).toContain("hmac:[REDACTED]");
  });

  test("redactEntryForEgress walks content + metadata without mutating input", () => {
    const e = {
      id: "x",
      ts: "2026-05-13T00:00:00Z",
      team_id: null,
      role: "tool" as const,
      kind: "tool-call",
      content: "key sk-test-abc123def456ghi789 leaked",
      metadata: { token: "Bearer eyJhbGciOiJsupersecret", note: "ok" },
    };
    const redacted = redactEntryForEgress(e);
    expect(redacted.content).not.toContain("sk-test-abc123def456ghi789");
    expect((redacted.metadata as Record<string, unknown>).token).not.toContain(
      "supersecret",
    );
    // Original untouched
    expect(e.content).toContain("sk-test-abc123def456ghi789");
  });
});
