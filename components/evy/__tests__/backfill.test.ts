// components/evy/__tests__/backfill.test.ts
//
// Tests for the operator-invoked backfill scripts. Every external surface
// (Memori sidecar, Cognee, evy.db, claude-mem HTTP, Obsidian filesystem)
// is injected via _setDepsForTesting so the suite runs hermetic with no
// network / disk / sidecar dependency.

import { afterEach, describe, expect, test } from "bun:test";
import {
  backfillClaudeMemToCognee,
  backfillEvyMemoryToMemori,
  backfillObsidianToCognee,
  _resetDepsForTesting,
  _setDepsForTesting,
  type BackfillDeps,
  type ClaudeMemObservation,
} from "../backfill";
import type { MemoryEntry } from "../memory";
import type {
  MemoriCaptureInput,
  MemoriHealth,
  MemoriHit,
  MemoriRecallInput,
  MemoriResult,
} from "../memori-client";
import type {
  CogneeHealth,
  CogneeRecallHit,
  CogneeRecallInput,
  CogneeRememberInput,
  CogneeResult,
} from "../cognee-client";

// ─── helpers ──────────────────────────────────────────────────────────────

function reachableMemori(): MemoriHealth {
  return {
    reachable: true,
    url: "http://test.local:8746",
    latency_ms: 1,
    version: "test",
    database: "sqlite",
    total_memories: 0,
    total_unreviewed: 0,
    total_curated: 0,
    auth_status: "n/a",
    error: null,
  };
}

function unreachableMemori(reason: string): MemoriHealth {
  return {
    reachable: false,
    url: "http://test.local:8746",
    latency_ms: null,
    version: null,
    database: null,
    total_memories: null,
    total_unreviewed: null,
    total_curated: null,
    auth_status: "missing_token",
    error: reason,
  };
}

function reachableCognee(): CogneeHealth {
  return {
    reachable: true,
    url: "http://test.local:8745",
    latency_ms: 1,
    version: "test",
    auth_status: "n/a",
    error: null,
  };
}

function unreachableCognee(reason: string): CogneeHealth {
  return {
    reachable: false,
    url: "http://test.local:8745",
    latency_ms: null,
    version: null,
    auth_status: "missing_token",
    error: reason,
  };
}

function evyEntry(id: string, content: string): MemoryEntry {
  return {
    id,
    ts: "2026-05-17T00:00:00.000Z",
    team_id: null,
    role: "user",
    kind: "note",
    content,
  };
}

interface RecordedMemori {
  captures: MemoriCaptureInput[];
  recalls: MemoriRecallInput[];
}

interface RecordedCognee {
  remembers: CogneeRememberInput[];
  recalls: CogneeRecallInput[];
}

interface MemoriStub {
  deps: Partial<BackfillDeps>;
  recorded: RecordedMemori;
}

interface CogneeStub {
  deps: Partial<BackfillDeps>;
  recorded: RecordedCognee;
}

/**
 * Build a Memori stub that simulates a persisted dedupe set. Capture
 * calls register the marker in the "stored" set; subsequent recalls for
 * that marker return a single hit. Optional per-id capture errors flow
 * through to BackfillResult.errors.
 */
function memoriStub(
  opts: {
    captureErrors?: Set<string>;
    captureThrows?: Set<string>;
    recallThrows?: Set<string>;
    health?: MemoriHealth;
  } = {},
): MemoriStub {
  const recorded: RecordedMemori = { captures: [], recalls: [] };
  const stored = new Set<string>();

  const deps: Partial<BackfillDeps> = {
    memoriHealth: async () => opts.health ?? reachableMemori(),
    memoriRecall: async (
      input: MemoriRecallInput,
    ): Promise<MemoriResult<{ hits: MemoriHit[] }>> => {
      recorded.recalls.push(input);
      if (opts.recallThrows?.has(input.query)) {
        throw new Error(`recall blew up for ${input.query}`);
      }
      if (stored.has(input.query)) {
        return { ok: true, data: { hits: [{ id: input.query, text: "x" }] } };
      }
      return { ok: true, data: { hits: [] } };
    },
    memoriCapture: async (
      input: MemoriCaptureInput,
    ): Promise<MemoriResult<{ id: string | null }>> => {
      recorded.captures.push(input);
      const marker = String(input.metadata?.backfill_marker ?? "");
      const sourceId = String(input.metadata?.backfill_source_id ?? "");
      if (opts.captureThrows?.has(sourceId)) {
        throw new Error(`capture blew up for ${sourceId}`);
      }
      if (opts.captureErrors?.has(sourceId)) {
        return { ok: false, error: "synthetic capture failure" };
      }
      stored.add(marker);
      return { ok: true, data: { id: `cap-${recorded.captures.length}` } };
    },
  };
  return { deps, recorded };
}

function cogneeStub(
  opts: {
    rememberErrors?: Set<string>;
    rememberThrows?: Set<string>;
    health?: CogneeHealth;
  } = {},
): CogneeStub {
  const recorded: RecordedCognee = { remembers: [], recalls: [] };
  const stored = new Set<string>();

  const deps: Partial<BackfillDeps> = {
    cogneeHealth: async () => opts.health ?? reachableCognee(),
    cogneeRecall: async (
      input: CogneeRecallInput,
    ): Promise<CogneeResult<{ hits: CogneeRecallHit[] }>> => {
      recorded.recalls.push(input);
      if (stored.has(input.query)) {
        return { ok: true, data: { hits: [{ text: "x", id: input.query }] } };
      }
      return { ok: true, data: { hits: [] } };
    },
    cogneeRemember: async (
      input: CogneeRememberInput,
    ): Promise<CogneeResult<{ id: string | null }>> => {
      recorded.remembers.push(input);
      const sourceId = String(input.metadata?.source_id ?? "");
      const marker = String(input.metadata?.backfill_marker ?? "");
      if (opts.rememberThrows?.has(sourceId)) {
        throw new Error(`remember blew up for ${sourceId}`);
      }
      if (opts.rememberErrors?.has(sourceId)) {
        return { ok: false, error: "synthetic remember failure" };
      }
      stored.add(marker);
      return { ok: true, data: { id: `rem-${recorded.remembers.length}` } };
    },
  };
  return { deps, recorded };
}

afterEach(() => {
  _resetDepsForTesting();
});

// ─── evy-memory → Memori ──────────────────────────────────────────────────

describe("backfillEvyMemoryToMemori", () => {
  test("dryRun=true plans without calling capture", async () => {
    const mem = memoriStub();
    const entries = [
      evyEntry("aaa-1", "first thought"),
      evyEntry("bbb-2", "second thought"),
      evyEntry("ccc-3", "third thought"),
    ];
    _setDepsForTesting({
      ...mem.deps,
      readEvyEntries: () => entries,
    });
    const r = await backfillEvyMemoryToMemori({ dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(3);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(3);
    expect(r.errors).toBe(0);
    expect(mem.recorded.captures).toHaveLength(0);
    // recall still fires — that's how we know what would skip vs write
    expect(mem.recorded.recalls).toHaveLength(3);
    // every dry-run detail row is a skip with dry-run reason
    for (const d of r.details ?? []) {
      expect(d.action).toBe("skipped");
      expect(d.reason).toBe("dry-run");
    }
  });

  test("actual run writes via capture; second run dedupes via recall", async () => {
    const mem = memoriStub();
    const entries = [
      evyEntry("aaa-1", "thought one"),
      evyEntry("bbb-2", "thought two"),
    ];
    _setDepsForTesting({
      ...mem.deps,
      readEvyEntries: () => entries,
    });
    const first = await backfillEvyMemoryToMemori({});
    expect(first.ok).toBe(true);
    expect(first.planned).toBe(2);
    expect(first.written).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.errors).toBe(0);
    expect(mem.recorded.captures).toHaveLength(2);
    // marker token round-trips into metadata
    expect(mem.recorded.captures[0]!.metadata?.backfill_source_id).toBe(
      "aaa-1",
    );
    expect(mem.recorded.captures[0]!.metadata?.backfill_marker).toMatch(
      /^bfillevy/,
    );

    // Second run — recall now returns a hit per marker, so everything skips.
    const second = await backfillEvyMemoryToMemori({});
    expect(second.ok).toBe(true);
    expect(second.planned).toBe(2);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
    expect(mem.recorded.captures).toHaveLength(2); // no new captures
  });

  test("per-entry capture failure does not abort the run", async () => {
    const mem = memoriStub({
      captureErrors: new Set(["bbb-2"]),
    });
    const entries = [
      evyEntry("aaa-1", "thought one"),
      evyEntry("bbb-2", "thought two"),
      evyEntry("ccc-3", "thought three"),
    ];
    _setDepsForTesting({
      ...mem.deps,
      readEvyEntries: () => entries,
    });
    const r = await backfillEvyMemoryToMemori({});
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(3);
    expect(r.written).toBe(2);
    expect(r.errors).toBe(1);
    const errored = (r.details ?? []).find((d) => d.action === "errored");
    expect(errored?.source_id).toBe("bbb-2");
    expect(errored?.reason).toContain("synthetic capture failure");
  });

  test("returns ok:false when Memori unreachable, doesn't throw", async () => {
    _setDepsForTesting({
      memoriHealth: async () => unreachableMemori("ECONNREFUSED"),
      readEvyEntries: () => [evyEntry("a", "x")],
    });
    const r = await backfillEvyMemoryToMemori({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Memori unreachable");
    expect(r.planned).toBe(0);
    expect(r.written).toBe(0);
  });
});

// ─── claude-mem → Cognee ──────────────────────────────────────────────────

describe("backfillClaudeMemToCognee", () => {
  test("returns ok:false with helpful error when Cognee unreachable", async () => {
    const fetchCalls: number[] = [];
    _setDepsForTesting({
      cogneeHealth: async () => unreachableCognee("ECONNREFUSED"),
      fetchClaudeMemPage: async (opts) => {
        fetchCalls.push(opts.offset);
        return { observations: [] };
      },
    });
    const r = await backfillClaudeMemToCognee({ dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Cognee unreachable");
    expect(r.planned).toBe(0);
    expect(r.written).toBe(0);
    // Health is the gate — claude-mem fetch should not even fire.
    expect(fetchCalls).toHaveLength(0);
  });

  test("writes observations, then skips on second run via recall dedupe", async () => {
    const cog = cogneeStub();
    const obs: ClaudeMemObservation[] = [
      { id: 101, content: "obs one", ts: "2026-05-01T00:00:00Z" },
      { id: 102, content: "obs two", ts: "2026-05-02T00:00:00Z" },
    ];
    let calls = 0;
    _setDepsForTesting({
      ...cog.deps,
      fetchClaudeMemPage: async () => {
        calls += 1;
        // First page returns the obs, second page returns empty → exhausted
        return calls === 1 ? { observations: obs } : { observations: [] };
      },
    });
    const first = await backfillClaudeMemToCognee({});
    expect(first.ok).toBe(true);
    expect(first.planned).toBe(2);
    expect(first.written).toBe(2);
    expect(cog.recorded.remembers).toHaveLength(2);
    expect(cog.recorded.remembers[0]!.metadata?.source).toBe("claude-mem");
    expect(cog.recorded.remembers[0]!.metadata?.source_id).toBe("101");

    calls = 0; // reset pager
    const second = await backfillClaudeMemToCognee({});
    expect(second.ok).toBe(true);
    expect(second.planned).toBe(2);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
    expect(cog.recorded.remembers).toHaveLength(2); // no new writes
  });

  test("per-entry remember failure does not abort the run", async () => {
    const cog = cogneeStub({ rememberErrors: new Set(["102"]) });
    const obs: ClaudeMemObservation[] = [
      { id: 101, content: "ok" },
      { id: 102, content: "boom" },
      { id: 103, content: "ok again" },
    ];
    let calls = 0;
    _setDepsForTesting({
      ...cog.deps,
      fetchClaudeMemPage: async () => {
        calls += 1;
        return calls === 1 ? { observations: obs } : { observations: [] };
      },
    });
    const r = await backfillClaudeMemToCognee({});
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(3);
    expect(r.written).toBe(2);
    expect(r.errors).toBe(1);
    const errored = (r.details ?? []).find((d) => d.action === "errored");
    expect(errored?.source_id).toBe("102");
  });
});

// ─── Obsidian → Cognee ────────────────────────────────────────────────────

describe("backfillObsidianToCognee", () => {
  test("dryRun walks vault, returns planned without reading files or writing", async () => {
    const cog = cogneeStub();
    const paths = ["/vault/a.md", "/vault/sub/b.md", "/vault/sub/c.md"];
    const reads: string[] = [];
    _setDepsForTesting({
      ...cog.deps,
      listObsidianFiles: async () => paths,
      readObsidianFile: async (p) => {
        reads.push(p);
        return "should not be read";
      },
    });
    const r = await backfillObsidianToCognee({
      dryRun: true,
      vault_path: "/vault",
    });
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(3);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(3);
    expect(cog.recorded.remembers).toHaveLength(0);
    // dry-run never reads file contents — the recall-against-marker check
    // is enough to know what would write.
    expect(reads).toHaveLength(0);
    expect(cog.recorded.recalls).toHaveLength(3);
  });

  test("real run reads + writes; per-file errors counted but don't abort", async () => {
    const cog = cogneeStub({ rememberErrors: new Set(["/vault/b.md"]) });
    const paths = ["/vault/a.md", "/vault/b.md", "/vault/c.md"];
    const readContents: Record<string, string> = {
      "/vault/a.md": "# A",
      "/vault/b.md": "# B",
      "/vault/c.md": "# C",
    };
    _setDepsForTesting({
      ...cog.deps,
      listObsidianFiles: async () => paths,
      readObsidianFile: async (p) => readContents[p] ?? "",
    });
    const r = await backfillObsidianToCognee({
      vault_path: "/vault",
    });
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(3);
    expect(r.written).toBe(2);
    expect(r.errors).toBe(1);
    const errored = (r.details ?? []).find((d) => d.action === "errored");
    expect(errored?.source_id).toBe("/vault/b.md");
  });

  test("returns ok:false when Cognee unreachable", async () => {
    const walked: string[] = [];
    _setDepsForTesting({
      cogneeHealth: async () => unreachableCognee("nope"),
      listObsidianFiles: async (p) => {
        walked.push(p);
        return [];
      },
    });
    const r = await backfillObsidianToCognee({ dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Cognee unreachable");
    expect(r.planned).toBe(0);
    // Health gates the vault walk too.
    expect(walked).toHaveLength(0);
  });
});
