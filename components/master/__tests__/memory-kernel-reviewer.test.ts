// components/master/__tests__/memory-kernel-reviewer.test.ts
//
// Tests for the memory consciousness cycle reviewer module. All tests
// inject the LLM seam via deps so we never hit a real provider.

import { describe, test, expect } from "bun:test";
import {
  reviewEvents,
  buildReviewerSystemPrompt,
  buildReviewerUserPrompt,
  type RawEvent,
  type ReviewerContext,
  type LlmMessage,
  type LlmFetcherOpts,
} from "../memory-kernel-reviewer";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeContext(over: Partial<ReviewerContext> = {}): ReviewerContext {
  return {
    operator_name: "Jason",
    recent_tier1_facts: ["operator runs DGX Sparks"],
    recent_evy_memories: ["operator prefers free/open-source"],
    active_project: "subctl",
    ...over,
  };
}

function makeEvent(over: Partial<RawEvent> & Pick<RawEvent, "id">): RawEvent {
  return {
    ts: Date.now(),
    user_text: "test message",
    ...over,
  };
}

function captureFetcher(payload: string): {
  fetcher: (m: LlmMessage[], o: LlmFetcherOpts) => Promise<string>;
  calls: Array<{ messages: LlmMessage[]; opts: LlmFetcherOpts }>;
} {
  const calls: Array<{ messages: LlmMessage[]; opts: LlmFetcherOpts }> = [];
  return {
    fetcher: async (messages, opts) => {
      calls.push({ messages, opts });
      return payload;
    },
    calls,
  };
}

function throwingFetcher(): (m: LlmMessage[], o: LlmFetcherOpts) => Promise<string> {
  return async () => {
    throw new Error("fetcher must not be called");
  };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe("system prompt", () => {
  test("contains the contract + every action + every rule", () => {
    const p = buildReviewerSystemPrompt();
    for (const action of [
      "discard",
      "keep_raw",
      "promote_tier3",
      "propose_tier1",
      "escalate",
    ]) {
      expect(p).toContain(action);
    }
    expect(p).toMatch(/source_event_ids/);
    expect(p).toMatch(/confidence/);
    expect(p).toMatch(/Do not write secrets/i);
    expect(p).toMatch(/stricter threshold/i);
    expect(p).toMatch(/Escalate contradictions/i);
  });
});

describe("user prompt", () => {
  test("threads operator name, project, and event ids", () => {
    const p = buildReviewerUserPrompt(
      [makeEvent({ id: "ev_42", user_text: "hello" })],
      makeContext({ operator_name: "Jason", active_project: "subctl" }),
    );
    expect(p).toContain("Jason");
    expect(p).toContain("subctl");
    expect(p).toContain("ev_42");
    expect(p).toContain("count=1");
  });
});

describe("reviewEvents", () => {
  test("test 1: empty events list — no LLM call, returns {decisions: []}", async () => {
    const fetcher = throwingFetcher();
    const out = await reviewEvents([], makeContext(), {
      llmFetcher: fetcher,
      configuredSupervisor: () => ({ provider: "openai-codex", model: "gpt-5.5" }),
    });
    expect(out.decisions).toEqual([]);
    expect(out.reviewer_model).toBe("openai-codex/gpt-5.5");
    expect(typeof out.cycle_ms).toBe("number");
  });

  test("test 2: happy path — three decisions of different actions all surface", async () => {
    const payload = JSON.stringify({
      decisions: [
        {
          source_event_ids: ["ev_1"],
          action: "promote_tier3",
          memory: "operator decided to ship v2.9 on Friday",
          kind: "decision",
          reason: "explicit commitment with date",
          confidence: 0.9,
        },
        {
          source_event_ids: ["ev_2"],
          action: "discard",
          reason: "trivial ack",
          confidence: 0.95,
        },
        {
          source_event_ids: ["ev_3"],
          action: "propose_tier1",
          memory: "operator prefers tmux over screen",
          kind: "preference",
          reason: "stable preference stated explicitly",
          confidence: 0.85,
        },
      ],
    });
    const { fetcher, calls } = captureFetcher(payload);
    const out = await reviewEvents(
      [
        makeEvent({ id: "ev_1" }),
        makeEvent({ id: "ev_2" }),
        makeEvent({ id: "ev_3" }),
      ],
      makeContext(),
      { llmFetcher: fetcher },
    );
    expect(calls).toHaveLength(1);
    expect(out.decisions).toHaveLength(3);
    expect(out.decisions[0]!.action).toBe("promote_tier3");
    expect(out.decisions[0]!.memory).toBe("operator decided to ship v2.9 on Friday");
    expect(out.decisions[1]!.action).toBe("discard");
    expect(out.decisions[2]!.action).toBe("propose_tier1");
    expect(out.decisions[2]!.kind).toBe("preference");
  });

  test("test 3: malformed JSON — returns {decisions: []} without throwing (also covers missing/non-array decisions key)", async () => {
    // Sub-case 3a: not JSON at all
    {
      const { fetcher } = captureFetcher("totally not json at all");
      const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
        llmFetcher: fetcher,
      });
      expect(out.decisions).toEqual([]);
    }
    // Sub-case 3b: valid JSON but no `decisions` key
    {
      const { fetcher } = captureFetcher(JSON.stringify({ foo: "bar" }));
      const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
        llmFetcher: fetcher,
      });
      expect(out.decisions).toEqual([]);
    }
    // Sub-case 3c: `decisions` is not an array
    {
      const { fetcher } = captureFetcher(
        JSON.stringify({ decisions: "should-be-array" }),
      );
      const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
        llmFetcher: fetcher,
      });
      expect(out.decisions).toEqual([]);
    }
  });

  test("test 4: extracts JSON when wrapped in prose", async () => {
    const payload =
      "Sure, here's the JSON you asked for:\n\n" +
      JSON.stringify({
        decisions: [
          {
            source_event_ids: ["ev_1"],
            action: "keep_raw",
            reason: "useful for search later",
            confidence: 0.6,
          },
        ],
      }) +
      "\n\nLet me know if you need anything else!";
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
      llmFetcher: fetcher,
    });
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]!.action).toBe("keep_raw");
  });

  test("test 5: invalid action enum — bad rows dropped, valid rows surface", async () => {
    const payload = JSON.stringify({
      decisions: [
        {
          source_event_ids: ["ev_1"],
          action: "promote_to_tier_99", // bogus
          memory: "x",
          kind: "decision",
          reason: "r",
          confidence: 0.7,
        },
        {
          source_event_ids: ["ev_2"],
          action: "discard",
          reason: "trivial",
          confidence: 0.9,
        },
        {
          source_event_ids: ["ev_3"],
          action: "promote_tier3",
          memory: "operator runs DGX Sparks",
          kind: "made-up-kind", // invalid kind on a promoting action → drop
          reason: "r",
          confidence: 0.8,
        },
      ],
    });
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents(
      [makeEvent({ id: "ev_1" }), makeEvent({ id: "ev_2" }), makeEvent({ id: "ev_3" })],
      makeContext(),
      { llmFetcher: fetcher },
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]!.action).toBe("discard");
  });

  test("test 6: confidence out of range is clamped; NaN/string is dropped", async () => {
    const payload = JSON.stringify({
      decisions: [
        // 1.5 → clamped to 1.0
        {
          source_event_ids: ["ev_a"],
          action: "discard",
          reason: "noise",
          confidence: 1.5,
        },
        // -0.3 → clamped to 0.0
        {
          source_event_ids: ["ev_b"],
          action: "keep_raw",
          reason: "maybe useful",
          confidence: -0.3,
        },
        // string → dropped (typeof check)
        {
          source_event_ids: ["ev_c"],
          action: "discard",
          reason: "noise",
          confidence: "high",
        },
        // null → dropped (typeof check fails). Stand-in for NaN, which
        // JSON.stringify would coerce to null on the wire anyway, so the
        // validator's `typeof === "number"` guard is what catches both.
        {
          source_event_ids: ["ev_d"],
          action: "discard",
          reason: "noise",
          confidence: null,
        },
      ],
    });
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents(
      [
        makeEvent({ id: "ev_a" }),
        makeEvent({ id: "ev_b" }),
        makeEvent({ id: "ev_c" }),
        makeEvent({ id: "ev_d" }),
      ],
      makeContext(),
      { llmFetcher: fetcher },
    );
    // ev_a clamped to 1, ev_b clamped to 0; ev_c and ev_d dropped.
    expect(out.decisions).toHaveLength(2);
    const byId = new Map(out.decisions.map((d) => [d.source_event_ids[0], d]));
    expect(byId.get("ev_a")!.confidence).toBe(1);
    expect(byId.get("ev_b")!.confidence).toBe(0);
    expect(byId.has("ev_c")).toBe(false);
    expect(byId.has("ev_d")).toBe(false);
  });

  test("test 7: decisions with missing/empty source_event_ids are dropped as orphans", async () => {
    const payload = JSON.stringify({
      decisions: [
        // missing field
        {
          action: "discard",
          reason: "no provenance",
          confidence: 0.9,
        },
        // empty array
        {
          source_event_ids: [],
          action: "discard",
          reason: "no provenance",
          confidence: 0.9,
        },
        // array of empty strings → all filtered, length 0 after filter
        {
          source_event_ids: ["", ""],
          action: "discard",
          reason: "no provenance",
          confidence: 0.9,
        },
        // valid control row
        {
          source_event_ids: ["ev_real"],
          action: "discard",
          reason: "actually attributable",
          confidence: 0.9,
        },
      ],
    });
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents([makeEvent({ id: "ev_real" })], makeContext(), {
      llmFetcher: fetcher,
    });
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]!.source_event_ids).toEqual(["ev_real"]);
  });

  test("test 8: cycle_ms is populated from the injected now()", async () => {
    let t = 1_000_000;
    // first call (start), second call (return) — bump by 250ms in between.
    const nowImpl = () => {
      const v = t;
      t += 250;
      return v;
    };
    const payload = JSON.stringify({
      decisions: [
        {
          source_event_ids: ["ev_1"],
          action: "discard",
          reason: "noise",
          confidence: 0.9,
        },
      ],
    });
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
      llmFetcher: fetcher,
      now: nowImpl,
    });
    expect(out.cycle_ms).toBe(250);
  });

  test("test 9: reviewer_model reflects configuredSupervisor() output", async () => {
    const payload = JSON.stringify({ decisions: [] });
    const { fetcher } = captureFetcher(payload);
    const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
      llmFetcher: fetcher,
      configuredSupervisor: () => ({
        provider: "lmstudio",
        model: "qwen/qwen3.6-35b-a3b",
      }),
    });
    expect(out.reviewer_model).toBe("lmstudio/qwen/qwen3.6-35b-a3b");
  });

  test("bonus: llmFetcher throwing returns {decisions: []} without throwing", async () => {
    const out = await reviewEvents([makeEvent({ id: "ev_1" })], makeContext(), {
      llmFetcher: async () => {
        throw new Error("network down");
      },
      configuredSupervisor: () => ({ provider: "openai-codex", model: "gpt-5.5" }),
    });
    expect(out.decisions).toEqual([]);
    expect(out.reviewer_model).toBe("openai-codex/gpt-5.5");
    expect(typeof out.cycle_ms).toBe("number");
  });
});
