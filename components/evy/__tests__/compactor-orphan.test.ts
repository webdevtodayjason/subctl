// v2.8.10 task #5 — orphan-toolResult filter tests.
//
// Verifies dropOrphanToolResults strips toolResults whose parent
// toolCall has been compacted away. This was the cause of the Codex
// HTTP 400 errors at 2026-05-16 21:35 / 21:36 / 19:06 — manually
// patched live in each instance, now fixed at the source.

import { describe, test, expect } from "bun:test";
import { dropOrphanToolResults } from "../server";

describe("dropOrphanToolResults", () => {
  test("returns input unchanged when every toolResult has a parent toolCall", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "do X" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "system_load", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "tc-1", toolName: "system_load", content: [] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    expect(dropOrphanToolResults(msgs).length).toBe(msgs.length);
  });

  test("drops a toolResult with no matching toolCall", () => {
    const msgs = [
      // The original assistant toolCall got compacted into the summary above.
      { role: "user", content: [{ type: "text", text: "[compaction summary...]" }] },
      { role: "toolResult", toolCallId: "tc-orphan", toolName: "system_load", content: [] },
      { role: "user", content: [{ type: "text", text: "next operator prompt" }] },
    ];
    const out = dropOrphanToolResults(msgs);
    expect(out.length).toBe(2);
    expect(out.find((m: { toolCallId?: string }) => m.toolCallId === "tc-orphan")).toBeUndefined();
  });

  test("drops multiple orphans in one pass", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "summary" }] },
      { role: "toolResult", toolCallId: "tc-1", toolName: "x", content: [] },
      { role: "toolResult", toolCallId: "tc-2", toolName: "y", content: [] },
      { role: "toolResult", toolCallId: "tc-3", toolName: "z", content: [] },
      { role: "user", content: [{ type: "text", text: "ok" }] },
    ];
    expect(dropOrphanToolResults(msgs).length).toBe(2);
  });

  test("preserves toolResult when paired with assistant toolCall later in the slice", () => {
    // Defensive case — paired assistant comes after the toolResult by
    // mistake (shouldn't happen in practice but the filter shouldn't
    // panic). Our filter checks toolCallId presence in ANY assistant
    // message in the slice, regardless of order.
    const msgs = [
      { role: "toolResult", toolCallId: "tc-1", toolName: "x", content: [] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "x", arguments: {} }],
      },
    ];
    expect(dropOrphanToolResults(msgs).length).toBe(2);
  });

  test("leaves non-toolResult messages untouched even when toolCallId-less", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      // toolResult without toolCallId is a malformed shape — leave it alone,
      // not our job to fix.
      { role: "toolResult", content: [] },
    ];
    expect(dropOrphanToolResults(msgs).length).toBe(3);
  });
});
