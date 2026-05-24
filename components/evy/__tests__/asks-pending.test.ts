// components/evy/__tests__/asks-pending.test.ts
//
// v3.2.0 — buddy-integration surface.
//
// Pins:
//   1. appendPendingAsk persists one JSON line per record.
//   2. listPendingAsks returns records in append order.
//   3. getPendingAsk returns the matching record or null.
//   4. removePendingAsk removes the matching record (idempotent, returns count).
//   5. ask-choice records keep their `options` array intact through the round-trip.
//   6. `channels` metadata round-trips for all routing combinations.
//   7. Mid-stream removal does not corrupt other pending records (atomic rename).
//   8. setAsksPendingPathForTesting confines writes to the override.
//   9. Concurrent removes serialize via mkdir-lock (no lost updates).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendPendingAsk,
  clearPendingAsksForTesting,
  getAsksPendingPath,
  getPendingAsk,
  listPendingAsks,
  removePendingAsk,
  setAsksPendingPathForTesting,
  type PendingAsk,
} from "../asks-pending";

let tmpDir: string;
let asksPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-asks-pending-"));
  asksPath = join(tmpDir, "asks-pending.jsonl");
  setAsksPendingPathForTesting(asksPath);
});

afterEach(() => {
  clearPendingAsksForTesting();
  setAsksPendingPathForTesting(null);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeYesno(id: string, overrides: Partial<PendingAsk> = {}): PendingAsk {
  return {
    id,
    kind: "ask-yesno",
    question: `Q${id}?`,
    default: "yes",
    options: null,
    created_at: "2026-05-24T22:18:31.000Z",
    timeout_at: null,
    source_tool: "notify",
    channels: ["telegram"],
    ...overrides,
  };
}

describe("asks-pending — basics", () => {
  test("setAsksPendingPathForTesting redirects the canonical path", () => {
    expect(getAsksPendingPath()).toBe(asksPath);
  });

  test("listPendingAsks returns [] when file absent", () => {
    expect(existsSync(asksPath)).toBe(false);
    expect(listPendingAsks()).toEqual([]);
  });

  test("appendPendingAsk writes one JSON line", async () => {
    const rec = makeYesno("A1");
    await appendPendingAsk(rec);
    const raw = readFileSync(asksPath, "utf8");
    const lines = raw.split("\n").filter(l => l.trim());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(rec);
  });

  test("listPendingAsks returns records in append order", async () => {
    await appendPendingAsk(makeYesno("A1"));
    await appendPendingAsk(makeYesno("A2"));
    await appendPendingAsk(makeYesno("A3"));
    const out = listPendingAsks();
    expect(out.map(r => r.id)).toEqual(["A1", "A2", "A3"]);
  });

  test("getPendingAsk returns matching record or null", async () => {
    await appendPendingAsk(makeYesno("A1"));
    await appendPendingAsk(makeYesno("A2"));
    expect(getPendingAsk("A1")?.id).toBe("A1");
    expect(getPendingAsk("A2")?.id).toBe("A2");
    expect(getPendingAsk("NOPE")).toBeNull();
  });
});

describe("asks-pending — removal", () => {
  test("removePendingAsk drops the target record, returns 1", async () => {
    await appendPendingAsk(makeYesno("A1"));
    await appendPendingAsk(makeYesno("A2"));
    await appendPendingAsk(makeYesno("A3"));
    const n = await removePendingAsk("A2");
    expect(n).toBe(1);
    expect(listPendingAsks().map(r => r.id)).toEqual(["A1", "A3"]);
  });

  test("removePendingAsk is idempotent on missing id (returns 0)", async () => {
    await appendPendingAsk(makeYesno("A1"));
    expect(await removePendingAsk("NOPE")).toBe(0);
    expect(listPendingAsks().map(r => r.id)).toEqual(["A1"]);
  });

  test("removePendingAsk on the last record empties the file (no trailing garbage)", async () => {
    await appendPendingAsk(makeYesno("ONLY"));
    expect(await removePendingAsk("ONLY")).toBe(1);
    expect(listPendingAsks()).toEqual([]);
    // The file may be either absent or empty depending on rename — both ok.
    if (existsSync(asksPath)) {
      expect(readFileSync(asksPath, "utf8")).toBe("");
    }
  });

  test("removePendingAsk preserves other in-flight records (atomic rename)", async () => {
    // Layout an intentionally chunky file — 50 records — then remove one
    // mid-stream. The kept records must all survive.
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `K${i}`;
      ids.push(id);
      await appendPendingAsk(makeYesno(id));
    }
    const removed = await removePendingAsk("K25");
    expect(removed).toBe(1);
    const kept = listPendingAsks().map(r => r.id);
    expect(kept).toEqual(ids.filter(id => id !== "K25"));
  });

  test("removePendingAsk drops duplicates of the same id", async () => {
    await appendPendingAsk(makeYesno("DUP"));
    await appendPendingAsk(makeYesno("KEEP"));
    await appendPendingAsk(makeYesno("DUP"));
    const n = await removePendingAsk("DUP");
    expect(n).toBe(2);
    expect(listPendingAsks().map(r => r.id)).toEqual(["KEEP"]);
  });
});

describe("asks-pending — schema fidelity", () => {
  test("ask-choice records keep options array through round-trip", async () => {
    const rec: PendingAsk = {
      id: "CHOICE1",
      kind: "ask-choice",
      question: "Pick a migration",
      default: "B",
      options: [
        { id: "A", label: "drop-fk-recreate" },
        { id: "B", label: "migrate-and-backfill" },
        { id: "C", label: "defer" },
      ],
      created_at: "2026-05-24T22:20:00.000Z",
      timeout_at: "2026-05-24T23:20:00.000Z",
      source_tool: "notify",
      channels: ["telegram", "buddy"],
    };
    await appendPendingAsk(rec);
    expect(getPendingAsk("CHOICE1")).toEqual(rec);
  });

  test("ask-text records persist with null options and null default", async () => {
    const rec: PendingAsk = {
      id: "TEXT1",
      kind: "ask-text",
      question: "Describe the failure",
      default: null,
      options: null,
      created_at: "2026-05-24T22:21:00.000Z",
      timeout_at: null,
      source_tool: "notify",
      channels: ["telegram"],
    };
    await appendPendingAsk(rec);
    expect(getPendingAsk("TEXT1")).toEqual(rec);
  });

  test("channels metadata round-trips for every routing combo", async () => {
    const combos: string[][] = [
      ["telegram"],
      ["buddy"],
      ["telegram", "buddy"],
    ];
    for (let i = 0; i < combos.length; i++) {
      await appendPendingAsk(makeYesno(`R${i}`, { channels: combos[i]! }));
    }
    const found = listPendingAsks();
    expect(found.map(r => r.channels)).toEqual(combos);
  });

  test("a garbage line is silently skipped on read", async () => {
    await appendPendingAsk(makeYesno("OK1"));
    // Inject a malformed line directly to simulate corruption.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(asksPath, "{not valid json}\n");
    await appendPendingAsk(makeYesno("OK2"));
    expect(listPendingAsks().map(r => r.id)).toEqual(["OK1", "OK2"]);
  });
});

describe("asks-pending — concurrency", () => {
  test("concurrent removePendingAsk calls serialize without lost updates", async () => {
    for (let i = 0; i < 20; i++) {
      await appendPendingAsk(makeYesno(`C${i}`));
    }
    // Fire 5 simultaneous removes on different ids — all must succeed
    // and the survivors must all still be there.
    const removals = await Promise.all([
      removePendingAsk("C3"),
      removePendingAsk("C7"),
      removePendingAsk("C11"),
      removePendingAsk("C15"),
      removePendingAsk("C19"),
    ]);
    expect(removals).toEqual([1, 1, 1, 1, 1]);
    const survivors = listPendingAsks().map(r => r.id);
    const dropped = new Set(["C3", "C7", "C11", "C15", "C19"]);
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `C${i}`;
      if (!dropped.has(id)) expected.push(id);
    }
    expect(survivors).toEqual(expected);
  });
});
