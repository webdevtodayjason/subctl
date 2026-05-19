// v2.8.11 Phase 4 — composeSystemPrompt curated-hydration tests.
//
// composeSystemPrompt itself is a closure-scoped function inside
// startMaster(), so we don't reach it directly. Instead we exercise the
// pure helpers it delegates to — filterCuratedHits, formatCuratedSection,
// and buildCuratedPromptSection — and verify:
//
//   1. curated facts are prepended when Memori has them
//      (buildCuratedPromptSection returns a section beginning with
//      `## Curated Tier 3 memory`)
//   2. SKIPS cleanly when sidecar is unreachable
//      (recall returns { ok: false } → buildCuratedPromptSection returns "")
//   3. Budget enforcement: when total render exceeds the cap, the
//      LONGEST lines are dropped first.
//   4. Tier 1 injection is preserved alongside — proven structurally:
//      composeSystemPrompt's return shape is
//      `curatedBlock + memBlock + routerBlock + skill + personality`.
//      We verify the curated section starts with the documented header
//      so the caller's concatenation order is unambiguous.

import { describe, test, expect } from "bun:test";
import {
  filterCuratedHits,
  formatCuratedSection,
  buildCuratedPromptSection,
  CURATED_PROMPT_BUDGET_CHARS,
  CURATED_PROMPT_HEADER,
} from "../server";
import type { MemoriHit, MemoriRecallInput, MemoriResult } from "../memori-client";

function mkHit(partial: Partial<MemoriHit> & { id: string; text: string }): MemoriHit {
  return {
    id: partial.id,
    text: partial.text,
    score: partial.score ?? 1.0,
    ts: partial.ts ?? "2026-05-18T10:00:00Z",
    kind: partial.kind,
    metadata: partial.metadata,
  };
}

describe("filterCuratedHits", () => {
  test("keeps only ids starting with curated_", () => {
    const hits: MemoriHit[] = [
      mkHit({ id: "curated_aaa", text: "promoted fact" }),
      mkHit({ id: "mem_bbb", text: "raw event" }),
      mkHit({ id: "curated_ccc", text: "another promoted" }),
      mkHit({ id: "x_ddd", text: "noise" }),
    ];
    const out = filterCuratedHits(hits);
    expect(out.map((h) => h.id)).toEqual(["curated_aaa", "curated_ccc"]);
  });

  test("returns empty array when no curated rows", () => {
    expect(filterCuratedHits([])).toEqual([]);
    expect(
      filterCuratedHits([mkHit({ id: "mem_xyz", text: "raw" })]),
    ).toEqual([]);
  });
});

describe("formatCuratedSection", () => {
  test("returns empty string when no hits", () => {
    expect(formatCuratedSection([], 2000)).toBe("");
  });

  test("renders header + one line per hit when under budget", () => {
    const hits: MemoriHit[] = [
      mkHit({
        id: "curated_1",
        text: "reviewer model now lmstudio gemma",
        kind: "decision",
        ts: "2026-05-18T10:00:00Z",
      }),
      mkHit({
        id: "curated_2",
        text: "memory tiers documented",
        kind: "design-note",
        ts: "2026-05-18T11:00:00Z",
      }),
    ];
    const out = formatCuratedSection(hits, 2000);
    expect(out.startsWith(CURATED_PROMPT_HEADER)).toBe(true);
    expect(out).toContain("[decision] reviewer model now lmstudio gemma");
    expect(out).toContain("[design-note] memory tiers documented");
    expect(out).toContain("2026-05-18");
    // Trailing blank-line separator before whatever the caller prepends to.
    expect(out.endsWith("\n\n")).toBe(true);
  });

  test("longest-first truncation when over budget", () => {
    const tiny = "short fact";
    const medium = "medium-length fact " + "x".repeat(200);
    const huge = "x".repeat(1800);
    const hits: MemoriHit[] = [
      mkHit({ id: "curated_short", text: tiny }),
      mkHit({ id: "curated_med", text: medium }),
      mkHit({ id: "curated_huge", text: huge }),
    ];
    const out = formatCuratedSection(hits, 500); // tight budget
    expect(out.length).toBeLessThanOrEqual(500);
    // The largest (huge) MUST be dropped first; the smallest survives.
    expect(out).toContain(tiny);
    expect(out).not.toContain(huge);
  });

  test("budget cap is honored even at the documented prompt limit", () => {
    // Stress: 30 hits of ~150 chars each → ~4500 chars body. Must
    // shrink to <=2000.
    const hits: MemoriHit[] = Array.from({ length: 30 }, (_, i) =>
      mkHit({
        id: `curated_${i}`,
        text: `fact #${i}: ` + "y".repeat(140),
        kind: "fact",
      }),
    );
    const out = formatCuratedSection(hits, CURATED_PROMPT_BUDGET_CHARS);
    expect(out.length).toBeLessThanOrEqual(CURATED_PROMPT_BUDGET_CHARS);
    // Must still produce a non-empty section — at least a few short
    // lines fit in the 2000-char budget.
    expect(out.startsWith(CURATED_PROMPT_HEADER)).toBe(true);
  });
});

describe("buildCuratedPromptSection", () => {
  function stubRecall(hits: MemoriHit[]) {
    return async (
      _input: MemoriRecallInput,
    ): Promise<MemoriResult<{ hits: MemoriHit[] }>> => ({
      ok: true,
      data: { hits },
    });
  }

  test("prepends curated facts when Memori has them", async () => {
    const recall = stubRecall([
      mkHit({
        id: "curated_a",
        text: "operator decided reviewer = gemma",
        kind: "decision",
        ts: "2026-05-18T12:00:00Z",
      }),
      mkHit({ id: "mem_x", text: "raw noise", ts: "2026-05-18T11:00:00Z" }),
    ]);
    const out = await buildCuratedPromptSection({
      recall,
      entityId: "jason",
      budgetChars: 2000,
    });
    expect(out.startsWith(CURATED_PROMPT_HEADER)).toBe(true);
    expect(out).toContain("operator decided reviewer = gemma");
    // Raw mem_ rows must NOT leak into the curated section.
    expect(out).not.toContain("raw noise");
  });

  test("returns empty string when sidecar is unreachable (ok:false)", async () => {
    const recall = async (
      _input: MemoriRecallInput,
    ): Promise<MemoriResult<{ hits: MemoriHit[] }>> => ({
      ok: false,
      error: "memori transport: ECONNREFUSED",
    });
    const out = await buildCuratedPromptSection({
      recall,
      entityId: "jason",
    });
    expect(out).toBe("");
  });

  test("returns empty string when recall throws (sidecar crash)", async () => {
    const recall = async () => {
      throw new Error("boom");
    };
    const out = await buildCuratedPromptSection({
      recall: recall as unknown as (
        input: MemoriRecallInput,
      ) => Promise<MemoriResult<{ hits: MemoriHit[] }>>,
      entityId: "jason",
    });
    expect(out).toBe("");
  });

  test("returns empty string when no curated rows are in the recall window", async () => {
    const recall = stubRecall([
      mkHit({ id: "mem_a", text: "raw one" }),
      mkHit({ id: "mem_b", text: "raw two" }),
    ]);
    const out = await buildCuratedPromptSection({
      recall,
      entityId: "jason",
    });
    expect(out).toBe("");
  });

  test("sorts newest-first and keeps only top-K", async () => {
    const hits: MemoriHit[] = Array.from({ length: 25 }, (_, i) =>
      mkHit({
        id: `curated_${i}`,
        text: `fact ${i}`,
        // Older index → earlier ts; newest index has the highest ts.
        ts: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const out = await buildCuratedPromptSection({
      recall: stubRecall(hits),
      entityId: "jason",
      topK: 3,
    });
    // The 3 newest (indices 24, 23, 22) must be present; the oldest
    // (index 0) must not.
    expect(out).toContain("fact 24");
    expect(out).toContain("fact 23");
    expect(out).toContain("fact 22");
    expect(out).not.toContain("fact 0");
  });

  test("enforces budget end-to-end (longest dropped first)", async () => {
    const hits: MemoriHit[] = [
      mkHit({ id: "curated_short", text: "ack", ts: "2026-05-18T03:00:00Z" }),
      mkHit({
        id: "curated_huge",
        text: "Z".repeat(3000),
        ts: "2026-05-18T02:00:00Z",
      }),
    ];
    const out = await buildCuratedPromptSection({
      recall: stubRecall(hits),
      entityId: "jason",
      budgetChars: 400,
    });
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("ack");
    expect(out).not.toContain("Z".repeat(100));
  });
});

describe("composition contract (Tier 1 + curated coexist)", () => {
  // composeSystemPrompt's return shape is documented as:
  //   curatedBlock + memBlock + routerBlock + skill + personality
  // We can't import the closure-bound function, but we can verify the
  // curated section's shape so the caller's concatenation order is
  // unambiguous: the curated text always begins with the header AND
  // ends with a blank-line separator so memBlock (Tier 1) starts cleanly
  // on its own boundary.

  test("section ends with a blank-line separator so Tier 1 starts clean", async () => {
    const out = await buildCuratedPromptSection({
      recall: async () => ({
        ok: true,
        data: {
          hits: [
            {
              id: "curated_1",
              text: "fact",
              score: 1,
              ts: "2026-05-18T00:00:00Z",
              kind: "fact",
            },
          ],
        },
      }),
      entityId: "jason",
    });
    expect(out.endsWith("\n\n")).toBe(true);
  });

  test("when curated is empty, composeSystemPrompt sees pure memBlock head", async () => {
    // Empty curated section means the caller's concatenation `"" + memBlock + ...`
    // leaves memBlock at index 0 — Tier 1 is preserved verbatim.
    const empty = await buildCuratedPromptSection({
      recall: async () => ({ ok: true, data: { hits: [] } }),
      entityId: "jason",
    });
    expect(empty).toBe("");
    const memBlock = "MEMORY START\n...rest of tier-1 block...\n";
    const composed = empty + memBlock;
    expect(composed.startsWith("MEMORY START")).toBe(true);
  });
});
