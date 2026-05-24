// components/evy/__tests__/watchdog-pane-classify.test.ts
//
// v2.8.14 — Operator-reported watchdog false-positive on `claude-birdie`
// (2026-05-21): worker replied via tmux pane with "work complete, idle by
// design" TWICE; watchdog kept escalating every 30 min because
// `classifyWorkerReply` only ran on inbox.jsonl arrivals, never on the
// pane-hash bump path.
//
// These tests pin the fix: `deriveActivityFromPaneCapture` re-classifies
// on every pane-hash change, preserves prior classification on capture
// failure, and stamps `last_reply_at_ms` exactly once per nudge cycle.
//
// We DO NOT re-test the classifier itself (auto-nudge.test.ts owns
// classifyWorkerReply coverage). We test the integration shape: given
// some pane text and an existing record, the helper produces the right
// next record.

import { describe, expect, test } from "bun:test";

import {
  deriveActivityFromPaneCapture,
  mergeActivityUpdate,
  type TeamActivity,
} from "../server";

describe("deriveActivityFromPaneCapture — re-classify on pane-hash change", () => {
  test("fresh completed_idle text flips classification away from working", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "..." },
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText:
        "● worker: redeploy-prep checklist complete. Idle by design — awaiting next directive.",
      now: 2_000,
    });
    // The reason this matters: decideTeamAction short-circuits escalation
    // when classification.kind === "completed_idle". Without this re-run,
    // the operator gets paged every 30 min on a done team.
    expect(next.classification?.kind).toBe("completed_idle");
    expect(next.ts).toBe(2_000);
  });

  test("capture failure (paneText === null) preserves prior classification", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "completed_idle", snippet: "done" },
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: null,
      now: 2_000,
    });
    // Better to keep the last-known good signal than reset to "working"
    // on a transient tmux error.
    expect(next.classification?.kind).toBe("completed_idle");
    expect(next.classification?.snippet).toBe("done");
    expect(next.ts).toBe(2_000);
  });

  test("empty pane text preserves prior classification", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "completed_idle", snippet: "done" },
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "   \n\t  \n",
      now: 2_000,
    });
    // Whitespace-only capture shouldn't flip a known-good classification.
    expect(next.classification?.kind).toBe("completed_idle");
  });

  test("first-time seed (no existing) with non-empty capture classifies fresh", () => {
    // This path is exercised by the inside-startMaster code, but we
    // ensure the helper doesn't crash on undefined existing.
    const next = deriveActivityFromPaneCapture({
      existing: undefined,
      paneText: "still working...",
      now: 5_000,
    });
    expect(next.ts).toBe(5_000);
    expect(next.classification?.kind).toBe("working");
    expect(next.last_nudge_at_ms).toBeUndefined();
    expect(next.last_reply_at_ms).toBeUndefined();
  });

  test("classification flips back to working when pane scrolls past completed text", () => {
    // If a worker said "done", then later starts a new task, the pane
    // capture window (last 50 lines) eventually loses the completed
    // signal. Re-classification correctly flips back to "working".
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "completed_idle", snippet: "done" },
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "● worker: starting new analysis of foo.ts — reading file...",
      now: 2_000,
    });
    expect(next.classification?.kind).toBe("working");
  });
});

describe("deriveActivityFromPaneCapture — nudge/reply observability", () => {
  test("preserves last_nudge_at_ms across pane-hash bumps", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 1_500,
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "still working on this",
      now: 2_000,
    });
    expect(next.last_nudge_at_ms).toBe(1_500);
  });

  test("first pane change after a nudge stamps last_reply_at_ms = now", () => {
    // Scenario: nudge fired at ts=1_500, no reply seen yet. Pane updates
    // at ts=2_000 with "task complete". That's the reply — record it.
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 1_500,
      // last_reply_at_ms intentionally undefined (no prior reply).
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "task complete. idle by design.",
      now: 2_000,
    });
    expect(next.last_reply_at_ms).toBe(2_000);
    expect(next.classification?.kind).toBe("completed_idle");
  });

  test("pane change WITHOUT a prior nudge does not stamp last_reply_at_ms", () => {
    // No nudge has been sent — pane bumps are just routine worker output,
    // not a reply to anything. Leave last_reply_at_ms unset.
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      // last_nudge_at_ms intentionally undefined.
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "doing more work",
      now: 2_000,
    });
    expect(next.last_reply_at_ms).toBeUndefined();
  });

  test("second pane change after the same nudge does NOT re-stamp last_reply_at_ms", () => {
    // The first reply already acknowledged the nudge. Subsequent pane
    // bumps shouldn't overwrite last_reply_at_ms — that would lose the
    // "first response time" signal.
    const existing: TeamActivity = {
      ts: 2_000,
      classification: { kind: "completed_idle", snippet: "done" },
      last_nudge_at_ms: 1_500,
      last_reply_at_ms: 1_900, // first reply stamp from a previous tick
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "(no further updates, still idle)",
      now: 3_000,
    });
    expect(next.last_reply_at_ms).toBe(1_900); // unchanged
  });

  test("capture failure (paneText=null) preserves prior last_reply_at_ms", () => {
    // CodeRabbit MINOR catch: before the hasPaneText guard, a transient
    // tmux capture failure would falsely stamp last_reply_at_ms=now even
    // though we never actually observed a worker reply. With the guard:
    // null capture leaves last_reply_at_ms exactly where it was (in this
    // case, undefined — no reply has been recorded yet).
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 1_500,
      // last_reply_at_ms intentionally undefined — no prior reply.
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: null,
      now: 2_000,
    });
    // Critical: NOT bumped to 2_000 just because lastNudgeAtMs > 0.
    expect(next.last_reply_at_ms).toBeUndefined();
    // And capture failure preserves prior classification (already tested
    // above, but re-asserting here keeps this test self-contained).
    expect(next.classification?.kind).toBe("working");
  });

  test("capture failure with prior last_reply_at_ms preserves the prior value (no overwrite)", () => {
    // Defensive variant: even when an older reply is on record, a
    // capture failure must NOT clobber it with `now` just because a
    // newer nudge exists.
    const existing: TeamActivity = {
      ts: 1_900,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 2_500, // newer than last_reply_at_ms below
      last_reply_at_ms: 1_900,
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: null,
      now: 3_000,
    });
    expect(next.last_reply_at_ms).toBe(1_900); // unchanged, NOT 3_000
  });

  test("a NEW nudge (newer than last_reply_at_ms) re-arms reply tracking", () => {
    // Operator sequence: nudge1 → reply → nudge2 (auto-renudge after 30min)
    // → pane bumps again. That second bump IS a new reply to nudge2 and
    // should stamp last_reply_at_ms = now (overwriting the old value).
    const existing: TeamActivity = {
      ts: 2_000,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 2_500, // newer than last_reply_at_ms below
      last_reply_at_ms: 1_900,
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "ack — getting back to it",
      now: 3_000,
    });
    expect(next.last_reply_at_ms).toBe(3_000);
  });

  test("ts always bumps to now regardless of classification outcome", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "completed_idle", snippet: "done" },
    };
    const nextWithText = deriveActivityFromPaneCapture({
      existing,
      paneText: "still done",
      now: 5_000,
    });
    expect(nextWithText.ts).toBe(5_000);

    const nextNullText = deriveActivityFromPaneCapture({
      existing,
      paneText: null,
      now: 6_000,
    });
    expect(nextNullText.ts).toBe(6_000);
  });

  test("lastEvent is carried forward across pane-hash bumps", () => {
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      lastEvent: { ts: "2026-05-21T00:00:00Z", type: "report", text: "checkpoint" },
    };
    const next = deriveActivityFromPaneCapture({
      existing,
      paneText: "more work",
      now: 2_000,
    });
    expect(next.lastEvent?.type).toBe("report");
    expect(next.lastEvent?.text).toBe("checkpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CodeRabbit-caught follow-up: both inbox.jsonl paths (boot-scan at
// server.ts:2283, tail at server.ts:2325) were calling
// `teamLastActivity.set(team, { ts, lastEvent, classification })` which
// REPLACES the whole record — clobbering the new v2.8.14 observability
// fields. The mergeActivityUpdate helper preserves them. These tests
// pin the contract so a future drive-by edit can't regress it.
// ─────────────────────────────────────────────────────────────────────────
describe("mergeActivityUpdate — inbox.jsonl arrivals preserve observability fields", () => {
  test("inbox tail update preserves last_nudge_at_ms and last_reply_at_ms", () => {
    // Realistic scenario: watchdog nudged at ts=1500, worker replied via
    // pane at ts=1900 (stamped last_reply_at_ms=1900), THEN the worker
    // also writes a "report" event into inbox.jsonl. Without merge, the
    // inbox-tail set() would clobber both observability fields.
    const existing: TeamActivity = {
      ts: 1_900,
      classification: { kind: "completed_idle", snippet: "done" },
      lastEvent: { ts: "old", type: "report", text: "earlier" },
      last_nudge_at_ms: 1_500,
      last_reply_at_ms: 1_900,
    };
    const merged = mergeActivityUpdate(existing, {
      ts: 2_000,
      lastEvent: { ts: "new", type: "report", text: "checkpoint" },
      classification: { kind: "working", snippet: "" },
    });
    // Fresh fields applied.
    expect(merged.ts).toBe(2_000);
    expect(merged.lastEvent?.text).toBe("checkpoint");
    expect(merged.classification?.kind).toBe("working");
    // Observability fields preserved — the fix.
    expect(merged.last_nudge_at_ms).toBe(1_500);
    expect(merged.last_reply_at_ms).toBe(1_900);
  });

  test("inbox boot-scan update preserves last_nudge_at_ms and last_reply_at_ms", () => {
    // Boot-scan typically runs against an empty map, but if anything has
    // already seeded the entry (e.g. a pane-refresh tick that won the
    // race) we must not clobber its observability fields.
    const existing: TeamActivity = {
      ts: 1_000,
      classification: { kind: "working", snippet: "" },
      last_nudge_at_ms: 800,
      last_reply_at_ms: 950,
    };
    const merged = mergeActivityUpdate(existing, {
      ts: 1_200, // stat.mtimeMs at boot
      lastEvent: { ts: "boot", type: "report", text: "from disk" },
      classification: { kind: "completed_idle", snippet: "done" },
    });
    expect(merged.ts).toBe(1_200);
    expect(merged.classification?.kind).toBe("completed_idle");
    expect(merged.last_nudge_at_ms).toBe(800);
    expect(merged.last_reply_at_ms).toBe(950);
  });

  test("merge with no existing record leaves observability fields undefined", () => {
    // First-time seed path — no existing entry to preserve from. The
    // merged record should have undefined observability fields, not 0
    // or any other sentinel that could falsely satisfy the "nudge has
    // been sent" check in deriveActivityFromPaneCapture.
    const merged = mergeActivityUpdate(undefined, {
      ts: 1_000,
      lastEvent: { ts: "seed", type: "report" },
      classification: { kind: "working", snippet: "" },
    });
    expect(merged.ts).toBe(1_000);
    expect(merged.last_nudge_at_ms).toBeUndefined();
    expect(merged.last_reply_at_ms).toBeUndefined();
  });

  test("only the new fresh fields overwrite (no spread leakage of stale ts/lastEvent/classification)", () => {
    // Defensive: confirm we replace ts/lastEvent/classification with the
    // FRESH values, not the existing ones. An accidental `...existing` /
    // `...fresh` order swap during refactor would regress this.
    const existing: TeamActivity = {
      ts: 999,
      classification: { kind: "blocked", snippet: "stuck" },
      lastEvent: { ts: "old", type: "blocked", text: "old text" },
      last_nudge_at_ms: 500,
      last_reply_at_ms: 600,
    };
    const merged = mergeActivityUpdate(existing, {
      ts: 2_000,
      lastEvent: { ts: "new", type: "report", text: "all good" },
      classification: { kind: "working", snippet: "" },
    });
    expect(merged.ts).toBe(2_000); // not 999
    expect(merged.lastEvent?.type).toBe("report"); // not "blocked"
    expect(merged.classification?.kind).toBe("working"); // not "blocked"
    expect(merged.last_nudge_at_ms).toBe(500);
    expect(merged.last_reply_at_ms).toBe(600);
  });
});
