// components/evy/__tests__/verifier.test.ts
//
// Tests for the post-turn claim verifier. Covers:
//   - The original name-match rules (back-compat).
//   - The v2.7.11 broader regexes (memory-update-claim,
//     procedure-or-rule-update-claim).
//   - The v2.7.11 structured tool-call inspection: tool calls now carry
//     args + results, and rules with `keywordOverlapValidate` reject
//     calls whose arguments don't reference the claim's significant terms
//     (the "cheat case" — call any tool, claim anything).
//   - Tool calls that errored (is_error: true) are excluded from
//     consideration; matching name with is_error is not enough.

import { describe, test, expect } from "bun:test";
import {
  findGaps,
  VERIFICATION_RULES,
  type AssistantTurn,
  type ToolCallRecord,
} from "../verifier";

// Test helper. Accepts either bare tool names (back-compat shorthand
// where args don't matter) or full ToolCallRecord objects.
function turn(
  text: string,
  toolCalls: Array<string | Partial<ToolCallRecord>> = [],
): AssistantTurn {
  return {
    text,
    tool_calls: toolCalls.map((t, i): ToolCallRecord => {
      if (typeof t === "string") {
        return { id: `t-${i}`, name: t, arguments: {} };
      }
      return {
        id: t.id ?? `t-${i}`,
        name: t.name ?? "unknown",
        arguments: t.arguments ?? {},
        result: t.result,
        is_error: t.is_error,
      };
    }),
  };
}

// ───────────────────────────────────────────────────────────────────
// memory-update-claim (v2.7.11)
// ───────────────────────────────────────────────────────────────────

describe("verifier — memory-update-claim — regex coverage", () => {
  const RULE_ID = "memory-update-claim";

  test("catches 'I've already updated my learned-facts memory' without backing tool", () => {
    const gaps = findGaps(
      turn("I've already updated my learned-facts memory to ensure this persists."),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("catches 'I have now formally committed the rule to my Tier-1 memory'", () => {
    const gaps = findGaps(
      turn("I have now formally committed the Promise rule to my Tier-1 memory."),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("catches 'I am updating my internal operating procedure'", () => {
    const gaps = findGaps(
      turn("I am updating my internal operating procedure for promises."),
    );
    // This pattern is caught by procedure-or-rule-update-claim, not memory.
    // But the broader claim "I have stored this in MEMORY.md" should hit
    // memory-update-claim — covered in the next test.
    expect(gaps.length).toBeGreaterThan(0);
  });

  test("catches 'I've stored this in MEMORY.md'", () => {
    const gaps = findGaps(
      turn("I've stored this fact in MEMORY.md so it persists."),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("catches passive 'Memory has been updated'", () => {
    const gaps = findGaps(turn("Memory has been updated with the new rule."));
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("does NOT false-positive on prose mentioning memory casually", () => {
    const gaps = findGaps(
      turn("Memory is the collection. I protect it. I file with proper metadata."),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────
// memory-update-claim — structured tool inspection (v2.7.11)
// ───────────────────────────────────────────────────────────────────

describe("verifier — memory-update-claim — structured inspection (v2.7.11)", () => {
  const RULE_ID = "memory-update-claim";
  const SAMPLE_CLAIM = "I've committed the Promise to Followup rule to my Tier-1 memory.";

  test("PASSES when memory_remember was called with content referencing the claim", () => {
    const gaps = findGaps(
      turn(SAMPLE_CLAIM, [
        {
          name: "memory_remember",
          arguments: {
            content: "Promise to Followup rule: every future-state communication must call schedule_followup first.",
          },
        },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });

  test("FAILS the cheat case: memory_remember called with unrelated content", () => {
    const gaps = findGaps(
      turn(SAMPLE_CLAIM, [
        {
          name: "memory_remember",
          arguments: { content: "The sky is blue and grass is green." },
        },
      ]),
    );
    const gap = gaps.find((g) => g.rule.id === RULE_ID);
    expect(gap).toBeTruthy();
    expect(gap!.reason).toContain("don't reference the claim's significant terms");
  });

  test("FAILS when memory_remember errored (is_error: true)", () => {
    const gaps = findGaps(
      turn(SAMPLE_CLAIM, [
        {
          name: "memory_remember",
          arguments: { content: "Promise to Followup rule details here." },
          is_error: true,
          result: { ok: false, error: "char budget exceeded" },
        },
      ]),
    );
    const gap = gaps.find((g) => g.rule.id === RULE_ID);
    expect(gap).toBeTruthy();
    expect(gap!.reason).toContain("errored");
  });

  test("FAILS when result has ok:false (inferred error)", () => {
    const gaps = findGaps(
      turn(SAMPLE_CLAIM, [
        {
          name: "memory_remember",
          arguments: { content: "Promise to Followup rule details here." },
          // No is_error flag, but result indicates failure
          is_error: true, // inferred by extractLastTurn from result.ok=false
          result: { ok: false, error: "validation failed" },
        },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("PASSES when at least one of multiple memory calls matched the claim", () => {
    const gaps = findGaps(
      turn(SAMPLE_CLAIM, [
        { name: "memory_remember", arguments: { content: "unrelated stuff" } },
        {
          name: "memory_remember",
          arguments: { content: "Promise rule: anchor in Tier-1." },
        },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────
// procedure-or-rule-update-claim — structured inspection (v2.7.11)
// ───────────────────────────────────────────────────────────────────

describe("verifier — procedure-or-rule-update-claim — structured inspection (v2.7.11)", () => {
  const RULE_ID = "procedure-or-rule-update-claim";
  const CLAIM = "I am updating my internal operating procedure for promise tracking.";

  test("catches the claim regardless of tool calls", () => {
    const gaps = findGaps(turn(CLAIM));
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("PASSES when memory_remember was called with related content", () => {
    const gaps = findGaps(
      turn(CLAIM, [
        {
          name: "memory_remember",
          arguments: {
            content: "Internal operating procedure: every promise about timing must be backed by schedule_followup before the text is generated.",
          },
        },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });

  test("FAILS cheat: memory_remember called with unrelated content", () => {
    const gaps = findGaps(
      turn(CLAIM, [
        {
          name: "memory_remember",
          arguments: { content: "favorite color is teal" },
        },
      ]),
    );
    const gap = gaps.find((g) => g.rule.id === RULE_ID);
    expect(gap).toBeTruthy();
    expect(gap!.reason).toContain("don't reference the claim's significant terms");
  });

  test("PASSES when team_doc_write was called with related content", () => {
    const gaps = findGaps(
      turn(CLAIM, [
        {
          name: "team_doc_write",
          arguments: {
            project_root: "/Users/you/code/foo",
            relative_path: "promise-procedure.md",
            content: "Operating procedure for promises: see schedule_followup tool.",
          },
        },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────
// decision-logged-claim — extended verbs (v2.7.11)
// ───────────────────────────────────────────────────────────────────

describe("verifier — decision-logged-claim — extended in v2.7.11", () => {
  const RULE_ID = "decision-logged-claim";

  test("still catches 'I've logged the decision to the vault'", () => {
    const gaps = findGaps(turn("I've logged the decision to the vault."));
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("new: catches 'I've filed the decision to the decisions log'", () => {
    const gaps = findGaps(turn("I've filed the decision to the decisions log."));
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeTruthy();
  });

  test("v2.7.10 addition: team_decision_log satisfies (no keyword check needed for this rule)", () => {
    const gaps = findGaps(
      turn("I've logged the decision.", [
        { name: "team_decision_log", arguments: { summary: "anything" } },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });

  test("vault_append still satisfies", () => {
    const gaps = findGaps(
      turn("I've appended the decision.", [
        { name: "vault_append", arguments: { path: "x.md", content: "y" } },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === RULE_ID)).toBeFalsy();
  });
});

// ───────────────────────────────────────────────────────────────────
// Back-compat: pre-v2.7.11 rules still work
// ───────────────────────────────────────────────────────────────────

describe("verifier — pre-v2.7.11 rules still work", () => {
  test("future-checkin-time catches 'I'll check in 15 minutes'", () => {
    const gaps = findGaps(turn("I'll check in 15 minutes on the team's progress."));
    expect(gaps.find((g) => g.rule.id === "future-checkin-time")).toBeTruthy();
  });

  test("future-checkin-time is satisfied by schedule_followup (name-only, no keyword check)", () => {
    const gaps = findGaps(
      turn("I'll check in 15 minutes on progress.", [
        { name: "schedule_followup", arguments: { in_minutes: 15, summary: "x", prompt: "y" } },
      ]),
    );
    expect(gaps.find((g) => g.rule.id === "future-checkin-time")).toBeFalsy();
  });

  test("message-sent-claim catches unverified 'I sent a notification'", () => {
    const gaps = findGaps(
      turn("I've sent the operator a notification about the issue."),
    );
    expect(gaps.find((g) => g.rule.id === "message-sent-claim")).toBeTruthy();
  });

  test("team-status-claim caught without subctl_orch_status", () => {
    const gaps = findGaps(turn("The team is currently working on the feature."));
    expect(gaps.find((g) => g.rule.id === "team-status-claim")).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────
// VerificationRule registry invariants
// ───────────────────────────────────────────────────────────────────

describe("verifier — rule list invariants", () => {
  test("has at least 5 rules", () => {
    expect(VERIFICATION_RULES.length).toBeGreaterThanOrEqual(5);
  });

  test("all rule ids are unique", () => {
    const ids = VERIFICATION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every rule has a trigger, requires_any_tool, hint, and validate", () => {
    for (const rule of VERIFICATION_RULES) {
      expect(rule.trigger).toBeInstanceOf(RegExp);
      expect(rule.requires_any_tool.length).toBeGreaterThan(0);
      expect(rule.hint.length).toBeGreaterThan(20);
      // After v2.7.11, every rule has a validate function (default or
      // keyword-overlap), attached by the post-declaration loop.
      expect(typeof rule.validate).toBe("function");
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// extractLastTurn integration smoke test (pairing tool_use ↔ tool_result)
// ───────────────────────────────────────────────────────────────────

describe("verifier — extractLastTurn pairs tool_use with tool_result", () => {
  test("captures tool args + result from a real-shaped message thread", async () => {
    const { extractLastTurn } = await import("../verifier");
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check the time." },
          { type: "tool_use", id: "t_001", name: "system_clock", input: { tz: "America/Chicago" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t_001", content: { ok: true, iso: "2026-05-12T..." } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "It is 9 PM local." },
          { type: "tool_use", id: "t_002", name: "memory_remember", input: { content: "operator timezone preference" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t_002", content: { ok: false, error: "char budget exceeded" }, is_error: false },
        ],
      },
    ];

    const turn = extractLastTurn(messages);
    expect(turn.text).toContain("It is 9 PM local");
    expect(turn.tool_calls.length).toBe(2);

    const clockCall = turn.tool_calls.find((c) => c.name === "system_clock");
    expect(clockCall).toBeTruthy();
    expect(clockCall!.arguments).toEqual({ tz: "America/Chicago" });
    expect(clockCall!.is_error).toBeFalsy();

    const memCall = turn.tool_calls.find((c) => c.name === "memory_remember");
    expect(memCall).toBeTruthy();
    // ok:false in result content should be detected as an error even when
    // the block's is_error flag is false (subctl tool convention).
    expect(memCall!.is_error).toBe(true);
  });
});
