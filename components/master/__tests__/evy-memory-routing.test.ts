// v2.8.10 Memory Init #3 Phase 3c — evy_remember/evy_recall dual-substrate routing.
//
// Verifies:
//   1. evy_remember writes to evy-memory (canonical) AND fires Memori
//      capture as best-effort when reachable.
//   2. evy_recall prefers Memori when reachable + non-empty; falls back
//      to evy-memory when Memori is down or returns empty.
//   3. Output carries `source` field so callers know which substrate
//      answered.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  evyMemoryTools,
  _setMemoriAvailableForTesting,
} from "../tools/evy-memory";
import {
  _setDepsForTesting as _setMemoriDeps,
  _resetDepsForTesting as _resetMemoriDeps,
} from "../memori-client";
import { recordEntry, _setStateDirForTesting } from "../memory";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => {
  // memory.ts uses _setStateDirForTesting (not SUBCTL_CONFIG_DIR) for its
  // tmp landing zone — match that convention to keep the canonical store
  // isolated per test.
  const tmp = mkdtempSync(join(tmpdir(), "subctl-evy-mem-test-"));
  _setStateDirForTesting(tmp);
  _setMemoriAvailableForTesting(null);
});

afterEach(() => {
  _setStateDirForTesting(null);
  _resetMemoriDeps();
  _setMemoriAvailableForTesting(null);
});

describe("evy_remember dual-write", () => {
  test("returns evy-memory record and surfaces source=evy-memory", async () => {
    _setMemoriAvailableForTesting(false);
    const out = await evyMemoryTools.evy_remember.invoke({
      content: "operator prefers terse responses",
      kind: "preference",
    });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("evy-memory");
    expect((out as { entry: { content: string } }).entry.content).toBe(
      "operator prefers terse responses",
    );
  });

  test("fires Memori capture in the background when reachable", async () => {
    _setMemoriAvailableForTesting(true);
    let captureBody: unknown = null;
    _setMemoriDeps({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/capture")) {
          captureBody = JSON.parse((init?.body as string) ?? "{}");
          return new Response(JSON.stringify({ id: "mem_abc" }), {
            status: 200,
          });
        }
        return new Response("not used", { status: 404 });
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const out = await evyMemoryTools.evy_remember.invoke({
      content: "lock decision: cognee for tier 4",
      kind: "decision",
    });
    expect(out.ok).toBe(true);
    // Let the fire-and-forget capture promise resolve.
    await new Promise((r) => setTimeout(r, 20));
    expect(captureBody).not.toBeNull();
    expect(captureBody).toMatchObject({
      entity_id: "jason",
      process_id: "evy-master",
    });
    expect(
      (captureBody as { turn: { decisions: unknown[] } }).turn.decisions,
    ).toBeTruthy();
  });

  test("Memori failure does NOT fail the tool — evy-memory remains canonical", async () => {
    _setMemoriAvailableForTesting(true);
    _setMemoriDeps({
      fetcher: (async () =>
        new Response("server error", { status: 500 })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const out = await evyMemoryTools.evy_remember.invoke({
      content: "something durable",
    });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("evy-memory");
  });
});

describe("evy_recall routing", () => {
  test("prefers Memori when reachable + non-empty", async () => {
    _setMemoriAvailableForTesting(true);
    _setMemoriDeps({
      fetcher: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/recall")) {
          return new Response(
            JSON.stringify({
              hits: [
                {
                  id: "mem_1",
                  text: "operator prefers helix",
                  score: 0.95,
                  ts: "2026-05-16T22:00:00Z",
                  kind: "preference",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const out = await evyMemoryTools.evy_recall.invoke({
      query: "favorite editor",
    });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("memori");
    expect((out as { count: number }).count).toBe(1);
  });

  test("falls back to evy-memory when Memori reachable but empty", async () => {
    // Seed an entry in the canonical store.
    recordEntry({
      role: "assistant",
      kind: "preference",
      content: "operator likes monospace fonts",
      team_id: null,
    });
    _setMemoriAvailableForTesting(true);
    _setMemoriDeps({
      fetcher: (async () =>
        new Response(JSON.stringify({ hits: [] }), {
          status: 200,
        })) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const out = await evyMemoryTools.evy_recall.invoke({
      query: "monospace",
    });
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("evy-memory");
    expect((out as { count: number }).count).toBe(1);
  });

  test("falls back to evy-memory when Memori unreachable", async () => {
    recordEntry({
      role: "assistant",
      kind: "evy-note",
      content: "fallback works",
      team_id: null,
    });
    _setMemoriAvailableForTesting(false);
    const out = await evyMemoryTools.evy_recall.invoke({});
    expect(out.ok).toBe(true);
    expect((out as { source: string }).source).toBe("evy-memory");
  });
});
