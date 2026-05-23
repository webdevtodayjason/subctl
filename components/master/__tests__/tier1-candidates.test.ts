// components/master/__tests__/tier1-candidates.test.ts
//
// Phase 3 — Tier 1 candidate queue. Hermetic: every test injects a tmp
// JSONL path and a fake writeTier1 callback via _setDepsForTesting so no
// real config dir is touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  appendCandidate,
  approveCandidate,
  getCandidate,
  listAll,
  listPending,
  rejectCandidate,
  type Tier1WriteResult,
  type WriteTier1Fn,
} from "../tier1-candidates";

// ─── fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;
let candidatesPath: string;

function baseInput(over: { id?: string; memory?: string; kind?: string; source_event_ids?: string[] } = {}) {
  return {
    source_event_ids: over.source_event_ids ?? ["e1"],
    memory: over.memory ?? "operator prefers tmux pane layout",
    kind: over.kind ?? "preference",
    reason: "stated explicitly in recent turn",
    confidence: 0.9,
    reviewer_model: "test/reviewer",
  };
}

function makeWriteTier1(
  record: Array<{ text: string; kind: string; source_type_override?: string }>,
  override?: () => Tier1WriteResult,
): WriteTier1Fn {
  return async (text, kind, opts) => {
    record.push({ text, kind, source_type_override: opts?.source_type_override });
    return override ? override() : { ok: true, appended_index: record.length - 1 };
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tier1-candidates-"));
  candidatesPath = join(tmpDir, "tier1-candidates.jsonl");
  _resetDepsForTesting();
  _setDepsForTesting({ candidatesPath });
});

afterEach(() => {
  _resetDepsForTesting();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── tests ───────────────────────────────────────────────────────────────

describe("appendCandidate", () => {
  test("writes one JSONL line and returns the new record (pending)", () => {
    const rec = appendCandidate(baseInput());

    expect(rec.id).toMatch(/^c_[a-z0-9]+_[0-9a-f]{8}$/);
    expect(rec.resolution).toBe("pending");
    expect(rec.memory).toBe("operator prefers tmux pane layout");
    expect(rec.source_event_ids).toEqual(["e1"]);

    const raw = readFileSync(candidatesPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe(rec.id);
    expect(parsed.resolution).toBe("pending");
  });

  test("each call generates a distinct id", () => {
    const a = appendCandidate(baseInput());
    const b = appendCandidate(baseInput({ memory: "another candidate" }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("listPending", () => {
  test("only surfaces records whose latest resolution is pending", async () => {
    const a = appendCandidate(baseInput({ memory: "fact A" }));
    const b = appendCandidate(baseInput({ memory: "fact B" }));
    const c = appendCandidate(baseInput({ memory: "fact C" }));

    // Reject B; approve C with a noop writeTier1.
    const writes: Array<{ text: string; kind: string }> = [];
    _setDepsForTesting({ writeTier1: makeWriteTier1(writes) });
    rejectCandidate(b.id);
    await approveCandidate(c.id);

    const pending = listPending();
    expect(pending.map((p) => p.id)).toEqual([a.id]);
  });

  test("empty when the JSONL file does not exist", () => {
    expect(listPending()).toEqual([]);
  });
});

describe("approveCandidate", () => {
  test("invokes writeTier1 with memory + kind and appends an approved record", async () => {
    const writes: Array<{ text: string; kind: string }> = [];
    _setDepsForTesting({ writeTier1: makeWriteTier1(writes) });

    const c = appendCandidate(baseInput({ memory: "operator likes tmux", kind: "preference" }));
    const result = await approveCandidate(c.id, { note: "looks good" });

    expect(result.ok).toBe(true);
    expect(result.candidate?.resolution).toBe("approved");
    expect(result.candidate?.resolved_by).toBe("operator");
    expect(result.candidate?.resolution_note).toBe("looks good");
    expect(result.tier1_entry?.ok).toBe(true);

    // writeTier1 was called exactly once with the candidate's memory+kind.
    expect(writes).toEqual([{ text: "operator likes tmux", kind: "preference" }]);

    // Listing reflects the approval.
    expect(listPending()).toHaveLength(0);
    const all = listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.resolution).toBe("approved");
  });

  test("returns ok:false when the candidate is not found", async () => {
    const result = await approveCandidate("c_does_not_exist");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("v2.9.0: text_override writes the override string, not candidate.memory", async () => {
    const writes: Array<{ text: string; kind: string; source_type_override?: string }> = [];
    _setDepsForTesting({ writeTier1: makeWriteTier1(writes) });

    const c = appendCandidate(baseInput({ memory: "raw candidate text" }));
    const result = await approveCandidate(c.id, {
      text_override: "consolidated merged sentence",
      source_type_override: "verified-external",
      note: "consolidator: merged 3 dups",
    });

    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe("consolidated merged sentence");
    expect(writes[0]!.source_type_override).toBe("verified-external");
    expect(result.candidate?.resolution_note).toBe("consolidator: merged 3 dups");
  });

  test("v2.9.0: empty/whitespace text_override falls back to candidate.memory", async () => {
    const writes: Array<{ text: string; kind: string; source_type_override?: string }> = [];
    _setDepsForTesting({ writeTier1: makeWriteTier1(writes) });

    const c = appendCandidate(baseInput({ memory: "the original text" }));
    const result = await approveCandidate(c.id, { text_override: "   " });

    expect(result.ok).toBe(true);
    expect(writes[0]!.text).toBe("the original text");
    expect(writes[0]!.source_type_override).toBeUndefined();
  });

  test("does NOT approve when writeTier1 returns ok:false (leaves pending)", async () => {
    const writes: Array<{ text: string; kind: string }> = [];
    _setDepsForTesting({
      writeTier1: makeWriteTier1(writes, () => ({ ok: false, error: "char budget" })),
    });

    const c = appendCandidate(baseInput());
    const result = await approveCandidate(c.id);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("char budget");
    // writeTier1 was attempted.
    expect(writes).toHaveLength(1);
    // Still pending — no resolution line appended.
    const pending = listPending();
    expect(pending.map((p) => p.id)).toEqual([c.id]);
  });
});

describe("rejectCandidate", () => {
  test("appends rejected record and does NOT touch writeTier1", () => {
    let writeCalls = 0;
    _setDepsForTesting({
      writeTier1: async () => {
        writeCalls++;
        return { ok: true };
      },
    });

    const c = appendCandidate(baseInput());
    const result = rejectCandidate(c.id, { note: "duplicate" });

    expect(result.ok).toBe(true);
    expect(result.candidate?.resolution).toBe("rejected");
    expect(result.candidate?.resolution_note).toBe("duplicate");
    expect(writeCalls).toBe(0);

    expect(listPending()).toHaveLength(0);
    const all = listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.resolution).toBe("rejected");
  });

  test("returns ok:false when the candidate is not found", () => {
    const result = rejectCandidate("c_nope");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("getCandidate", () => {
  test("returns the latest resolution for an id", async () => {
    const writes: Array<{ text: string; kind: string }> = [];
    _setDepsForTesting({ writeTier1: makeWriteTier1(writes) });

    const c = appendCandidate(baseInput());
    expect(getCandidate(c.id)?.resolution).toBe("pending");

    await approveCandidate(c.id);
    expect(getCandidate(c.id)?.resolution).toBe("approved");
  });

  test("returns null for an unknown id", () => {
    expect(getCandidate("c_missing")).toBeNull();
  });
});

describe("JSONL append-only invariant", () => {
  test("re-appending a resolution adds a new line and dedup picks the latest", () => {
    const c = appendCandidate(baseInput());
    rejectCandidate(c.id);

    const raw = readFileSync(candidatesPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    // First line is pending, second is rejected — neither line was rewritten.
    expect(JSON.parse(lines[0]!).resolution).toBe("pending");
    expect(JSON.parse(lines[1]!).resolution).toBe("rejected");

    // Deduped view shows only the latest.
    const all = listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(c.id);
    expect(all[0]!.resolution).toBe("rejected");
  });

  test("listPending excludes a candidate after rejection (dedupe by id, latest wins)", () => {
    const c = appendCandidate(baseInput());
    expect(listPending().map((p) => p.id)).toEqual([c.id]);

    rejectCandidate(c.id);

    expect(listPending()).toEqual([]);
    // listAll still reports the (resolved) record once.
    expect(listAll()).toHaveLength(1);
  });
});
