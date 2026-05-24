// components/evy/__tests__/mcp-identity.test.ts
//
// MCP-Expose (#24, wave 1) — caller_id → decisions.jsonl `by` field
// adapter. The wave-2 tool surface will spread `buildMcpProvenance`'s
// output into decision rows; this test pins the FORMAT contract so the
// historian, dashboard, and any downstream consumer can rely on it.
//
// What we pin:
//   1. formatDecisionBy("claude-desktop") === "mcp:claude-desktop"
//   2. The prefix is exactly "mcp:" (constant exported for consumers).
//   3. parseDecisionBy round-trips formatDecisionBy.
//   4. parseDecisionBy returns null for non-MCP rows (so callers can
//      fall through to other decision sources without surprises).
//   5. buildMcpProvenance produces the full record with deterministic
//      timestamp + correct discriminator + matching `by`.
//   6. Provenance JSON-serializes cleanly — the JSON line written to
//      decisions.jsonl is what we expect.

import { describe, expect, test } from "bun:test";

import {
  MCP_DECISION_PREFIX,
  formatDecisionBy,
  parseDecisionBy,
  buildMcpProvenance,
} from "../mcp/identity";

describe("MCP_DECISION_PREFIX", () => {
  test("is exactly 'mcp:' — DO NOT rename without updating consumers", () => {
    expect(MCP_DECISION_PREFIX).toBe("mcp:");
  });
});

describe("formatDecisionBy", () => {
  test("prefixes the caller_id with mcp:", () => {
    expect(formatDecisionBy("claude-desktop")).toBe("mcp:claude-desktop");
  });

  test("works for all realistic caller_id shapes", () => {
    expect(formatDecisionBy("argentos")).toBe("mcp:argentos");
    expect(formatDecisionBy("orch-claude-code-abc123")).toBe(
      "mcp:orch-claude-code-abc123",
    );
    expect(formatDecisionBy("scope:tool_name_v3")).toBe(
      "mcp:scope:tool_name_v3",
    );
    expect(formatDecisionBy("argentos.v2.7")).toBe("mcp:argentos.v2.7");
  });
});

describe("parseDecisionBy", () => {
  test("round-trips formatDecisionBy for realistic ids", () => {
    for (const id of [
      "claude-desktop",
      "argentos",
      "orch-claude-code-abc123",
      "scope:tool_name_v3",
      "argentos.v2.7",
    ]) {
      const parsed = parseDecisionBy(formatDecisionBy(id));
      expect(parsed).toEqual({ source: "mcp", caller_id: id });
    }
  });

  test("returns null for non-MCP rows", () => {
    expect(parseDecisionBy("operator")).toBeNull();
    expect(parseDecisionBy("evy")).toBeNull();
    expect(parseDecisionBy("auto-timeout")).toBeNull();
    expect(parseDecisionBy("dashboard:user@example.com")).toBeNull();
    expect(parseDecisionBy("")).toBeNull();
  });

  test("returns null for bare prefix without a caller_id", () => {
    // "mcp:" alone is nonsense — refuse to round-trip an empty id
    // and surface it as not-MCP rather than silently producing
    // { source: "mcp", caller_id: "" }.
    expect(parseDecisionBy("mcp:")).toBeNull();
  });
});

describe("buildMcpProvenance", () => {
  test("returns the full record with matching `by`", () => {
    const fixed = new Date("2026-05-19T16:00:00.000Z");
    const p = buildMcpProvenance("claude-desktop", fixed);
    expect(p).toEqual({
      source: "mcp",
      caller_id: "claude-desktop",
      by: "mcp:claude-desktop",
      received_at: "2026-05-19T16:00:00.000Z",
    });
  });

  test("JSON-stringifies into a stable decisions.jsonl-shaped object", () => {
    const fixed = new Date("2026-05-19T16:00:00.000Z");
    const p = buildMcpProvenance("argentos", fixed);
    const line = JSON.stringify(p);
    expect(line).toBe(
      '{"source":"mcp","caller_id":"argentos","by":"mcp:argentos",' +
        '"received_at":"2026-05-19T16:00:00.000Z"}',
    );
  });

  test("defaults to a fresh Date when `now` is omitted", () => {
    const before = Date.now();
    const p = buildMcpProvenance("x");
    const after = Date.now();
    const ts = new Date(p.received_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("`source` discriminator is the literal 'mcp'", () => {
    const p = buildMcpProvenance("anything");
    // Typescript narrowing aside, runtime check that the
    // discriminator is stable — wave-2 unions on it.
    expect(p.source).toBe("mcp");
  });
});
