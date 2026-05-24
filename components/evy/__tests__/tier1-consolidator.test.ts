// components/evy/__tests__/tier1-consolidator.test.ts
//
// v2.9.0 — Tier 1 Consolidator. Pure-module tests; the LLM fetcher is
// dependency-injected. No network, no fs.

import { describe, expect, test } from "bun:test";

import {
  buildConsolidatorSystemPrompt,
  buildConsolidatorUserPrompt,
  buildTaggedEntry,
  computeCharBudgetMath,
  consolidate,
  parseConsolidatorResponse,
  projectMemoryContent,
  type ConsolidateProposal,
  type ConsolidatedEntry,
  type ConsolidatorDeps,
  type ConsolidatorSourceType,
} from "../tier1-consolidator";
import type { Tier1Candidate } from "../tier1-candidates";

// ─── fixtures ────────────────────────────────────────────────────────────

function candidate(over: Partial<Tier1Candidate> = {}): Tier1Candidate {
  return {
    id: over.id ?? "c_test_aa",
    proposed_at: "2026-05-23T11:00:00.000Z",
    source_event_ids: ["e1"],
    memory: over.memory ?? "Operator prefers terse responses.",
    kind: over.kind ?? "preference",
    reason: over.reason ?? "stated explicitly",
    confidence: over.confidence ?? 0.9,
    reviewer_model: "test/reviewer",
    resolution: "pending",
    ...over,
  };
}

function makeDeps(over: Partial<ConsolidatorDeps> = {}): ConsolidatorDeps {
  return {
    listPending: () => [],
    readMemoryContent: () => "",
    charBudget: () => 4000,
    configuredSupervisor: () => ({ provider: "test", model: "fake-supervisor" }),
    llmFetcher: async () => "",
    ...over,
  };
}

function entry(
  text: string,
  source_type: ConsolidatorSourceType,
  ids: string[],
  rationale = "merged dups",
): ConsolidatedEntry {
  return {
    text,
    source_type,
    rationale,
    merged_from_candidate_ids: ids,
  };
}

// ─── char budget math ────────────────────────────────────────────────────

describe("char budget math", () => {
  test("buildTaggedEntry emits [source:<type>] <text> with trim", () => {
    expect(buildTaggedEntry("  hi  ", "operator-asserted")).toBe(
      "[source:operator-asserted] hi",
    );
  });

  test("projectMemoryContent appends entries with the §-delimiter when current is non-empty", () => {
    const current = "[source:operator-asserted] existing entry";
    const projected = projectMemoryContent(current, [
      entry("new entry one", "operator-asserted", ["c1"]),
      entry("new entry two", "self-inferred", ["c2"]),
    ]);
    // Existing + 2 delimiters (one between current and first added; one between added)
    expect(projected.startsWith(current)).toBe(true);
    expect(projected).toContain("\n§\n");
    expect(projected).toContain("[source:operator-asserted] new entry one");
    expect(projected).toContain("[source:self-inferred] new entry two");
  });

  test("projectMemoryContent skips the prefix delimiter when current is empty", () => {
    const projected = projectMemoryContent("", [
      entry("first ever entry", "operator-asserted", ["c1"]),
    ]);
    expect(projected).toBe("[source:operator-asserted] first ever entry");
  });

  test("computeCharBudgetMath: empty proposal → no delta, full headroom", () => {
    const math = computeCharBudgetMath({
      currentContent: "abc",
      charBudget: 100,
      proposal: [],
    });
    expect(math).toEqual({ char_current: 3, char_total: 0, headroom_after: 97 });
  });

  test("computeCharBudgetMath: positive headroom when proposal fits", () => {
    const math = computeCharBudgetMath({
      currentContent: "x".repeat(50),
      charBudget: 200,
      proposal: [entry("hi", "operator-asserted", ["c1"])],
    });
    // Added = §-delim (3) + "[source:operator-asserted] hi" (29) = 32
    expect(math.char_current).toBe(50);
    expect(math.char_total).toBeGreaterThan(0);
    expect(math.headroom_after).toBe(200 - 50 - math.char_total);
    expect(math.headroom_after).toBeGreaterThan(0);
  });

  test("computeCharBudgetMath: NEGATIVE headroom when proposal blows the budget", () => {
    const huge = "x".repeat(200);
    const math = computeCharBudgetMath({
      currentContent: "y".repeat(100),
      charBudget: 150,
      proposal: [
        entry(huge, "operator-asserted", ["c1"]),
        entry(huge, "operator-asserted", ["c2"]),
      ],
    });
    expect(math.headroom_after).toBeLessThan(0);
  });
});

// ─── prompts ─────────────────────────────────────────────────────────────

describe("prompt building", () => {
  test("system prompt enforces JSON-only + source_type ordering", () => {
    const sys = buildConsolidatorSystemPrompt();
    expect(sys).toContain("JSON ONLY");
    expect(sys).toContain("operator-asserted > verified-external > self-inferred > agent-reported");
    expect(sys).toContain("merged_from_candidate_ids");
    expect(sys).toContain("dropped_candidate_ids");
  });

  test("user prompt threads current memory + every candidate + budget math", () => {
    const user = buildConsolidatorUserPrompt({
      currentMemoryContent: "existing fact",
      candidates: [
        candidate({ id: "c_a", memory: "fact A" }),
        candidate({ id: "c_b", memory: "fact B" }),
      ],
      charBudget: 4000,
    });
    expect(user).toContain("existing fact");
    expect(user).toContain("[id=c_a]");
    expect(user).toContain("fact A");
    expect(user).toContain("[id=c_b]");
    expect(user).toContain("fact B");
    expect(user).toContain("Char budget (SUBCTL_MEMORY_LIMIT): 4000");
    expect(user).toContain("Available headroom: ");
    expect(user).toContain("count=2");
  });

  test("user prompt renders (empty) marker when memory.md is blank", () => {
    const user = buildConsolidatorUserPrompt({
      currentMemoryContent: "",
      candidates: [candidate()],
      charBudget: 2000,
    });
    expect(user).toContain("(empty)");
  });
});

// ─── parser ──────────────────────────────────────────────────────────────

describe("parseConsolidatorResponse", () => {
  const known = new Set(["c_a", "c_b", "c_c"]);

  test("happy path — parses valid JSON proposal", () => {
    const raw = JSON.stringify({
      proposal: [
        {
          text: "Merged fact",
          source_type: "operator-asserted",
          rationale: "merged 2 dups",
          merged_from_candidate_ids: ["c_a", "c_b"],
        },
      ],
      dropped_candidate_ids: ["c_c"],
      dropped_reasons: { c_c: "low conf" },
    });
    const got = parseConsolidatorResponse(raw, known);
    if ("error" in got) throw new Error("expected ok, got: " + got.error);
    expect(got.proposal).toHaveLength(1);
    expect(got.proposal[0]!.text).toBe("Merged fact");
    expect(got.proposal[0]!.merged_from_candidate_ids).toEqual(["c_a", "c_b"]);
    expect(got.dropped_candidate_ids).toEqual(["c_c"]);
    expect(got.dropped_reasons.c_c).toBe("low conf");
  });

  test("tolerates prose around the JSON object", () => {
    const raw = "Here is the consolidation:\n```\n" + JSON.stringify({
      proposal: [],
      dropped_candidate_ids: ["c_a"],
      dropped_reasons: { c_a: "noise" },
    }) + "\n```\nthat's all";
    const got = parseConsolidatorResponse(raw, known);
    if ("error" in got) throw new Error("expected ok, got: " + got.error);
    expect(got.dropped_candidate_ids).toEqual(["c_a"]);
  });

  test("drops entries whose merged_from_candidate_ids cite unknown ids", () => {
    const raw = JSON.stringify({
      proposal: [
        {
          text: "valid",
          source_type: "operator-asserted",
          rationale: "ok",
          merged_from_candidate_ids: ["c_a", "c_FAKE"],
        },
        {
          text: "all unknown citations",
          source_type: "operator-asserted",
          rationale: "should drop",
          merged_from_candidate_ids: ["c_BAD1", "c_BAD2"],
        },
      ],
      dropped_candidate_ids: [],
      dropped_reasons: {},
    });
    const got = parseConsolidatorResponse(raw, known);
    if ("error" in got) throw new Error("expected ok, got: " + got.error);
    expect(got.proposal).toHaveLength(1);
    expect(got.proposal[0]!.merged_from_candidate_ids).toEqual(["c_a"]);
  });

  test("rejects malformed JSON", () => {
    const got = parseConsolidatorResponse("not even json {{{", known);
    expect("error" in got).toBe(true);
  });

  test("rejects missing proposal array", () => {
    const got = parseConsolidatorResponse(JSON.stringify({ dropped: [] }), known);
    expect("error" in got).toBe(true);
  });

  test("rejects invalid source_type values", () => {
    const raw = JSON.stringify({
      proposal: [
        {
          text: "x",
          source_type: "made-up-type",
          rationale: "x",
          merged_from_candidate_ids: ["c_a"],
        },
      ],
      dropped_candidate_ids: ["c_b"],
      dropped_reasons: { c_b: "noise" },
    });
    const got = parseConsolidatorResponse(raw, known);
    // Entry dropped silently; if drop list still has content, parser still
    // returns a valid result.
    if ("error" in got) throw new Error("expected ok, got: " + got.error);
    expect(got.proposal).toHaveLength(0);
    expect(got.dropped_candidate_ids).toEqual(["c_b"]);
  });

  test("fills missing dropped_reasons with a placeholder", () => {
    const raw = JSON.stringify({
      proposal: [],
      dropped_candidate_ids: ["c_a", "c_b"],
      dropped_reasons: { c_a: "low conf" },
    });
    const got = parseConsolidatorResponse(raw, known);
    if ("error" in got) throw new Error("expected ok, got: " + got.error);
    expect(got.dropped_reasons.c_a).toBe("low conf");
    expect(got.dropped_reasons.c_b).toBe("(no reason provided)");
  });
});

// ─── consolidate() integration ──────────────────────────────────────────

describe("consolidate()", () => {
  test("empty pending queue → no LLM call + zero proposal", async () => {
    let llmCalls = 0;
    const deps = makeDeps({
      listPending: () => [],
      llmFetcher: async () => { llmCalls++; return ""; },
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal).toEqual([]);
    expect(out.dropped_candidate_ids).toEqual([]);
    expect(out.pending_unchanged_candidate_ids).toEqual([]);
    expect(llmCalls).toBe(0);
    expect(out.reviewer_model).toBe("test/fake-supervisor");
  });

  test("happy path — returns parsed proposal + char budget math", async () => {
    const pending = [
      candidate({ id: "c_a", memory: "Operator prefers terse." }),
      candidate({ id: "c_b", memory: "Be terse with operator." }),
      candidate({ id: "c_c", memory: "Low signal note", confidence: 0.5 }),
    ];
    const llmResponse = JSON.stringify({
      proposal: [
        {
          text: "Operator prefers terse responses.",
          source_type: "operator-asserted",
          rationale: "merged 2 candidates",
          merged_from_candidate_ids: ["c_a", "c_b"],
        },
      ],
      dropped_candidate_ids: ["c_c"],
      dropped_reasons: { c_c: "low conf + no unique signal" },
    });
    const deps = makeDeps({
      listPending: () => pending,
      readMemoryContent: () => "existing memory.md content",
      charBudget: () => 2000,
      llmFetcher: async () => llmResponse,
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.proposal).toHaveLength(1);
    expect(out.proposal[0]!.text).toBe("Operator prefers terse responses.");
    expect(out.dropped_candidate_ids).toEqual(["c_c"]);
    expect(out.pending_unchanged_candidate_ids).toEqual([]);
    expect(out.char_budget).toBe(2000);
    expect(out.char_current).toBe("existing memory.md content".length);
    expect(out.char_total).toBeGreaterThan(0);
    expect(out.headroom_after).toBe(out.char_budget - (out.char_current + out.char_total));
    expect(out.reviewer_model).toBe("test/fake-supervisor");
    // dry_run not requested → raw response NOT included.
    expect(out.llm_raw_response).toBeUndefined();
  });

  test("dry_run=true echoes the raw LLM response for debugging", async () => {
    const raw = JSON.stringify({
      proposal: [],
      dropped_candidate_ids: ["c_a"],
      dropped_reasons: { c_a: "n/a" },
    });
    const deps = makeDeps({
      listPending: () => [candidate({ id: "c_a" })],
      llmFetcher: async () => raw,
    });
    const out = await consolidate({ dry_run: true }, deps);
    if (!out.ok) throw new Error("expected ok, got: " + out.error);
    expect(out.llm_raw_response).toBe(raw);
  });

  test("malformed LLM JSON → ok:false with sanitized error + raw response", async () => {
    const deps = makeDeps({
      listPending: () => [candidate({ id: "c_a" })],
      llmFetcher: async () => "not even json",
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("malformed proposal");
    expect(out.llm_raw_response).toBe("not even json");
    expect(out.reviewer_model).toBe("test/fake-supervisor");
  });

  test("empty LLM response → ok:false with clear error", async () => {
    const deps = makeDeps({
      listPending: () => [candidate({ id: "c_a" })],
      llmFetcher: async () => "",
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("empty response");
  });

  test("LLM fetcher throws → ok:false with error message", async () => {
    const deps = makeDeps({
      listPending: () => [candidate({ id: "c_a" })],
      llmFetcher: async () => { throw new Error("502 bad gateway"); },
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("502 bad gateway");
    expect(out.reviewer_model).toBe("test/fake-supervisor");
  });

  test("over-budget proposal still returns ok:true with negative headroom (UI renders red bar)", async () => {
    const fat = "x".repeat(500);
    const pending = [
      candidate({ id: "c_a" }),
      candidate({ id: "c_b" }),
    ];
    const llmResponse = JSON.stringify({
      proposal: [
        {
          text: fat,
          source_type: "operator-asserted",
          rationale: "wide entry",
          merged_from_candidate_ids: ["c_a"],
        },
        {
          text: fat,
          source_type: "self-inferred",
          rationale: "another wide",
          merged_from_candidate_ids: ["c_b"],
        },
      ],
      dropped_candidate_ids: [],
      dropped_reasons: {},
    });
    const deps = makeDeps({
      listPending: () => pending,
      readMemoryContent: () => "y".repeat(300),
      charBudget: () => 800,
      llmFetcher: async () => llmResponse,
    });
    const out = await consolidate({}, deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.headroom_after).toBeLessThan(0);
    expect((out as ConsolidateProposal).proposal).toHaveLength(2);
  });

  test("untouched candidates surface in pending_unchanged_candidate_ids", async () => {
    const pending = [
      candidate({ id: "c_a" }),
      candidate({ id: "c_b" }),
      candidate({ id: "c_unsorted" }),
    ];
    const llmResponse = JSON.stringify({
      proposal: [
        {
          text: "merged",
          source_type: "operator-asserted",
          rationale: "ok",
          merged_from_candidate_ids: ["c_a"],
        },
      ],
      dropped_candidate_ids: ["c_b"],
      dropped_reasons: { c_b: "noise" },
    });
    const deps = makeDeps({
      listPending: () => pending,
      llmFetcher: async () => llmResponse,
    });
    const out = await consolidate({}, deps);
    if (!out.ok) throw new Error("expected ok, got: " + out.error);
    expect(out.pending_unchanged_candidate_ids).toEqual(["c_unsorted"]);
  });

  test("LLM hallucinates candidate ids → only known ids surface in proposal", async () => {
    const pending = [candidate({ id: "c_real" })];
    const llmResponse = JSON.stringify({
      proposal: [
        {
          text: "hallucinated only",
          source_type: "operator-asserted",
          rationale: "should drop",
          merged_from_candidate_ids: ["c_FAKE_1", "c_FAKE_2"],
        },
        {
          text: "mixed cite",
          source_type: "operator-asserted",
          rationale: "real id kept",
          merged_from_candidate_ids: ["c_FAKE_3", "c_real"],
        },
      ],
      dropped_candidate_ids: ["c_FAKE_4"],
      dropped_reasons: { c_FAKE_4: "n/a" },
    });
    const deps = makeDeps({
      listPending: () => pending,
      llmFetcher: async () => llmResponse,
    });
    const out = await consolidate({}, deps);
    if (!out.ok) throw new Error("expected ok, got: " + out.error);
    expect(out.proposal).toHaveLength(1);
    expect(out.proposal[0]!.merged_from_candidate_ids).toEqual(["c_real"]);
    // c_FAKE_4 isn't in pending → dropped from dropped_candidate_ids.
    expect(out.dropped_candidate_ids).toEqual([]);
  });
});
