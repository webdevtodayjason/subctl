// components/master/__tests__/memory-kernel.test.ts
//
// Tests for Worker C's memory-kernel orchestration glue. Every external
// surface (sidecar HTTP, reviewer LLM, notifications, decisions.jsonl,
// SSE broadcast, state file) is injected via _setDepsForTesting so the
// suite runs hermetic without spinning up the sidecar.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  KERNEL_WATCHDOG_ID,
  getLastDecisions,
  getState,
  pause,
  resume,
  runOneCycle,
  startTicker,
  type KernelDeps,
} from "../memory-kernel";
import type {
  MemoriResult,
  MemoriReviewState,
  MemoriUnreviewedEvent,
} from "../memori-client";
import type {
  ReviewerOutput,
  ReviewDecision,
} from "../memory-kernel-reviewer";

// ─── helpers ─────────────────────────────────────────────────────────────

function makeRawEvent(id: string, extra: Partial<MemoriUnreviewedEvent> = {}): MemoriUnreviewedEvent {
  return {
    id,
    ts: new Date().toISOString(),
    user_text: `user said ${id}`,
    assistant_text: null,
    tool_calls_json: null,
    decisions_json: null,
    outcomes_json: null,
    metadata_json: null,
    review_state: "unreviewed",
    ...extra,
  };
}

function makeDecision(over: Partial<ReviewDecision> & Pick<ReviewDecision, "source_event_ids" | "action">): ReviewDecision {
  const base: ReviewDecision = {
    source_event_ids: over.source_event_ids,
    action: over.action,
    reason: over.reason ?? "test reason",
    confidence: over.confidence ?? 0.8,
  };
  if (over.memory !== undefined) base.memory = over.memory;
  if (over.kind !== undefined) base.kind = over.kind;
  return base;
}

interface CallRecord {
  selectUnreviewed: Array<{ entity_id: string; limit?: number }>;
  markReviewed: Array<{ ids: string[]; review_state: MemoriReviewState; reason?: string; confidence?: number; reviewer_model?: string }>;
  promote: Array<{ entity_id: string; source_ids: string[]; memory: string; kind?: string; confidence?: number; reviewer_model?: string }>;
  reviewEvents: Array<{ events_count: number; operator_name: string; active_project?: string }>;
  notifications: Array<{ kind: string; severity: "info" | "warn" | "alert"; title: string; body: string }>;
  decisions: Array<{ project: string; action: string; rationale: string }>;
  broadcasts: Array<{ type: string; payload: unknown }>;
}

function makeKernelDeps(
  over: {
    events?: MemoriUnreviewedEvent[];
    decisions?: ReviewDecision[];
    reviewer_model?: string;
    reviewerThrows?: Error;
    selectFails?: string;
    markReviewedFails?: string;
    promoteFails?: string;
    statePath?: string;
  } = {},
): { deps: Partial<KernelDeps>; calls: CallRecord } {
  const calls: CallRecord = {
    selectUnreviewed: [],
    markReviewed: [],
    promote: [],
    reviewEvents: [],
    notifications: [],
    decisions: [],
    broadcasts: [],
  };

  const deps: Partial<KernelDeps> = {
    selectUnreviewed: async (input): Promise<MemoriResult<{ events: MemoriUnreviewedEvent[] }>> => {
      calls.selectUnreviewed.push(input);
      if (over.selectFails) return { ok: false, error: over.selectFails };
      return { ok: true, data: { events: over.events ?? [] } };
    },
    markReviewed: async (input): Promise<MemoriResult<{ marked: number }>> => {
      calls.markReviewed.push(input);
      if (over.markReviewedFails) return { ok: false, error: over.markReviewedFails };
      return { ok: true, data: { marked: input.ids.length } };
    },
    promote: async (input): Promise<MemoriResult<{ id: string | null }>> => {
      calls.promote.push(input);
      if (over.promoteFails) return { ok: false, error: over.promoteFails };
      return { ok: true, data: { id: `curated_${input.source_ids.join("_")}` } };
    },
    reviewEvents: async (events, context): Promise<ReviewerOutput> => {
      calls.reviewEvents.push({
        events_count: events.length,
        operator_name: context.operator_name,
        active_project: context.active_project,
      });
      if (over.reviewerThrows) throw over.reviewerThrows;
      return {
        decisions: over.decisions ?? [],
        reviewer_model: over.reviewer_model ?? "test/model",
        cycle_ms: 1,
      };
    },
    operatorName: () => "Jason",
    recentTier1Facts: () => [],
    recentEvyMemories: () => [],
    activeProject: () => "subctl",
    emitNotification: (n) => {
      calls.notifications.push(n);
    },
    logDecision: (d) => {
      calls.decisions.push(d);
    },
    broadcast: (type, payload) => {
      calls.broadcasts.push({ type, payload });
    },
    statePath: over.statePath,
    now: () => 1_700_000_000_000,
  };
  return { deps, calls };
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "memory-kernel-state-"));
  // Wipe module-level state up front so each test starts at total_cycles=0,
  // paused=false, even if the prior test crashed before afterEach ran.
  _resetDepsForTesting();
});

afterEach(() => {
  _resetDepsForTesting();
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── tests ───────────────────────────────────────────────────────────────

describe("runOneCycle — dry_run", () => {
  test("dry_run=true does NOT call markReviewed or promote, even when reviewer returns promotions", async () => {
    const decisions = [
      makeDecision({
        source_event_ids: ["e1"],
        action: "promote_tier3",
        memory: "operator prefers free/open-source",
        kind: "preference",
        confidence: 0.9,
      }),
      makeDecision({
        source_event_ids: ["e2"],
        action: "discard",
        confidence: 0.95,
      }),
    ];
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1"), makeRawEvent("e2")],
      decisions,
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator", dry_run: true });

    expect(result.ok).toBe(true);
    expect(result.decisions_count).toBe(2);
    expect(result.promotions_count).toBe(0);
    expect(result.errors_count).toBe(0);
    expect(calls.markReviewed).toHaveLength(0);
    expect(calls.promote).toHaveLength(0);
    // Reviewer DID see the events.
    expect(calls.reviewEvents).toHaveLength(1);
    expect(calls.reviewEvents[0]!.events_count).toBe(2);
    expect(calls.reviewEvents[0]!.operator_name).toBe("Jason");
    expect(calls.reviewEvents[0]!.active_project).toBe("subctl");
  });
});

describe("runOneCycle — promotion policy", () => {
  test("promote_tier3 + confidence>=0.7 calls /promote, no extra mark_reviewed (atomic on server side)", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({
          source_event_ids: ["e1"],
          action: "promote_tier3",
          memory: "operator runs DGX Sparks",
          kind: "finding",
          confidence: 0.9,
        }),
      ],
      reviewer_model: "lmstudio/qwen3-coder",
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });

    expect(result.ok).toBe(true);
    expect(result.promotions_count).toBe(1);
    expect(calls.promote).toHaveLength(1);
    expect(calls.promote[0]!.entity_id).toBe("operator");
    expect(calls.promote[0]!.source_ids).toEqual(["e1"]);
    expect(calls.promote[0]!.memory).toBe("operator runs DGX Sparks");
    expect(calls.promote[0]!.kind).toBe("finding");
    expect(calls.promote[0]!.reviewer_model).toBe("lmstudio/qwen3-coder");
    // /promote already flips source rows to promoted; no extra mark.
    expect(calls.markReviewed).toHaveLength(0);
  });

  test("promote_tier3 + confidence<0.7 skips /promote but still marks reviewed", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({
          source_event_ids: ["e1"],
          action: "promote_tier3",
          memory: "lukewarm finding",
          kind: "finding",
          confidence: 0.4,
        }),
      ],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });

    expect(result.ok).toBe(true);
    expect(result.promotions_count).toBe(0);
    expect(calls.promote).toHaveLength(0);
    expect(calls.markReviewed).toHaveLength(1);
    expect(calls.markReviewed[0]!.review_state).toBe("reviewed");
    expect(calls.markReviewed[0]!.ids).toEqual(["e1"]);
  });

  test("discard action marks state=discarded", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({ source_event_ids: ["e1"], action: "discard", confidence: 1 }),
      ],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });
    expect(calls.markReviewed).toHaveLength(1);
    expect(calls.markReviewed[0]!.review_state).toBe("discarded");
  });

  test("propose_tier1 marks reviewed (deferred, Phase 3)", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({
          source_event_ids: ["e1"],
          action: "propose_tier1",
          memory: "operator prefers terminal UI",
          kind: "preference",
          confidence: 0.95,
        }),
      ],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });
    expect(calls.markReviewed).toHaveLength(1);
    expect(calls.markReviewed[0]!.review_state).toBe("reviewed");
    expect(calls.promote).toHaveLength(0);
  });
});

describe("runOneCycle — escalations", () => {
  test("escalate emits a warn notification AND marks state=escalated", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e7"), makeRawEvent("e8")],
      decisions: [
        makeDecision({
          source_event_ids: ["e7", "e8"],
          action: "escalate",
          reason: "contradiction with Tier 1 fact",
          confidence: 0.6,
        }),
      ],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });

    expect(result.ok).toBe(true);
    expect(calls.markReviewed).toHaveLength(1);
    expect(calls.markReviewed[0]!.review_state).toBe("escalated");
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0]!.kind).toBe("memory-kernel-escalation");
    expect(calls.notifications[0]!.severity).toBe("warn");
    expect(calls.notifications[0]!.body).toContain("contradiction with Tier 1 fact");
  });
});

describe("runOneCycle — resilience", () => {
  test("reviewer throws — surfaced as error in result, 0 promoted, no markReviewed/promote", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      reviewerThrows: new Error("LM Studio refused"),
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("reviewer threw");
    expect(result.error).toContain("LM Studio refused");
    expect(result.promotions_count).toBe(0);
    expect(calls.markReviewed).toHaveLength(0);
    expect(calls.promote).toHaveLength(0);
  });

  test("selectUnreviewed sidecar error — surfaced, no reviewer call", async () => {
    const { deps, calls } = makeKernelDeps({
      selectFails: "sidecar unreachable",
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });

    expect(result.ok).toBe(false);
    expect(result.errors_count).toBe(1);
    expect(result.error).toContain("sidecar unreachable");
    expect(calls.reviewEvents).toHaveLength(0);
  });

  test("zero unreviewed events returns ok with note='no events'", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const result = await runOneCycle({ entity_id: "operator" });
    expect(result.ok).toBe(true);
    expect(result.note).toBe("no events");
    expect(calls.reviewEvents).toHaveLength(0);
  });
});

describe("pause / resume", () => {
  test("pause() flips state; runOneCycle no-ops with note='paused'; resume() restarts cycles", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [makeDecision({ source_event_ids: ["e1"], action: "discard", confidence: 1 })],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    pause();
    expect(getState().paused).toBe(true);

    const paused = await runOneCycle({ entity_id: "operator" });
    expect(paused.ok).toBe(true);
    expect(paused.decisions_count).toBe(0);
    expect(paused.note).toBe("paused");
    expect(calls.reviewEvents).toHaveLength(0);
    expect(calls.markReviewed).toHaveLength(0);

    resume();
    expect(getState().paused).toBe(false);

    const live = await runOneCycle({ entity_id: "operator" });
    expect(live.ok).toBe(true);
    expect(live.decisions_count).toBe(1);
    expect(calls.markReviewed).toHaveLength(1);
  });
});

describe("state persistence", () => {
  test("getState reflects last cycle counters; state file written to disk", async () => {
    const statePath = join(stateDir, "state.json");
    const { deps } = makeKernelDeps({
      events: [makeRawEvent("e1"), makeRawEvent("e2")],
      decisions: [
        makeDecision({
          source_event_ids: ["e1"],
          action: "promote_tier3",
          memory: "x",
          kind: "finding",
          confidence: 0.9,
        }),
        makeDecision({ source_event_ids: ["e2"], action: "discard", confidence: 1 }),
      ],
      statePath,
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });

    const s = getState();
    expect(s.last_cycle_decisions).toBe(2);
    expect(s.last_cycle_promotions).toBe(1);
    expect(s.total_cycles).toBe(1);
    expect(s.total_promotions).toBe(1);
    expect(s.last_cycle_at).not.toBeNull();

    expect(existsSync(statePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; total_cycles: number };
    expect(onDisk.version).toBe(1);
    expect(onDisk.total_cycles).toBe(1);
  });

  test("getLastDecisions echoes the reviewer output for /status", async () => {
    const decisions = [
      makeDecision({
        source_event_ids: ["e1"],
        action: "promote_tier3",
        memory: "operator preference",
        kind: "preference",
        confidence: 0.85,
      }),
    ];
    const { deps } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions,
      reviewer_model: "test/model",
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });
    const last = getLastDecisions();
    expect(last.reviewer_model).toBe("test/model");
    expect(last.decisions).toHaveLength(1);
    expect(last.decisions[0]!.action).toBe("promote_tier3");
  });
});

describe("cycle metadata", () => {
  test("logDecision appends a memory_kernel_cycle row with counts + model", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({ source_event_ids: ["e1"], action: "discard", confidence: 1 }),
      ],
      reviewer_model: "test/model",
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });

    expect(calls.decisions).toHaveLength(1);
    expect(calls.decisions[0]!.action).toBe("memory_kernel_cycle");
    expect(calls.decisions[0]!.project).toBe("_master");
    expect(calls.decisions[0]!.rationale).toContain("1 events reviewed");
    expect(calls.decisions[0]!.rationale).toContain("0 promoted");
    expect(calls.decisions[0]!.rationale).toContain("model=test/model");
  });

  test("broadcast emits memory_kernel_cycle with structured payload", async () => {
    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [
        makeDecision({ source_event_ids: ["e1"], action: "discard", confidence: 1 }),
      ],
      reviewer_model: "test/model",
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    await runOneCycle({ entity_id: "operator" });
    expect(calls.broadcasts).toHaveLength(1);
    expect(calls.broadcasts[0]!.type).toBe("memory_kernel_cycle");
    const p = calls.broadcasts[0]!.payload as Record<string, unknown>;
    expect(p.decisions_count).toBe(1);
    expect(p.promotions_count).toBe(0);
    expect(p.reviewer_model).toBe("test/model");
  });
});

describe("startTicker scheduling", () => {
  test("schedules first tick after 10s, then setInterval at intervalMs", async () => {
    const sched = {
      setTimeoutCalls: [] as Array<{ ms: number; fn: () => void }>,
      setIntervalCalls: [] as Array<{ ms: number; fn: () => void }>,
      clearedTimeouts: [] as unknown[],
      clearedIntervals: [] as unknown[],
    };
    const scheduler = {
      setTimeout: (fn: () => void, ms: number) => {
        sched.setTimeoutCalls.push({ fn, ms });
        return { kind: "timeout", id: sched.setTimeoutCalls.length };
      },
      clearTimeout: (h: unknown) => { sched.clearedTimeouts.push(h); },
      setInterval: (fn: () => void, ms: number) => {
        sched.setIntervalCalls.push({ fn, ms });
        return { kind: "interval", id: sched.setIntervalCalls.length };
      },
      clearInterval: (h: unknown) => { sched.clearedIntervals.push(h); },
    };

    const { deps, calls } = makeKernelDeps({
      events: [makeRawEvent("e1")],
      decisions: [makeDecision({ source_event_ids: ["e1"], action: "discard", confidence: 1 })],
      statePath: join(stateDir, "state.json"),
    });
    _setDepsForTesting(deps);

    const registered: Array<{ id: string; kind: string }> = [];
    const stop = startTicker({
      intervalMs: 60_000,
      entityId: "operator",
      scheduler,
      registerWatchdog: (e) => { registered.push({ id: e.id, kind: e.kind }); },
    });

    // Boot-timer scheduled at 10s, no setInterval yet.
    expect(sched.setTimeoutCalls).toHaveLength(1);
    expect(sched.setTimeoutCalls[0]!.ms).toBe(10_000);
    expect(sched.setIntervalCalls).toHaveLength(0);

    // Watchdog registered at the canonical id.
    expect(registered).toEqual([{ id: KERNEL_WATCHDOG_ID, kind: KERNEL_WATCHDOG_ID }]);

    // Fire the boot timer: triggers a tick AND schedules the interval.
    sched.setTimeoutCalls[0]!.fn();
    // Let the async tick settle.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));

    expect(sched.setIntervalCalls).toHaveLength(1);
    expect(sched.setIntervalCalls[0]!.ms).toBe(60_000);
    expect(calls.selectUnreviewed).toHaveLength(1);

    // stop() clears both handles.
    stop();
    expect(sched.clearedTimeouts).toHaveLength(1);
    expect(sched.clearedIntervals).toHaveLength(1);
  });

  test("firstTickDelayMs override is honored", () => {
    const sched = {
      setTimeout: (_fn: () => void, _ms: number) => ({ kind: "t" }),
      clearTimeout: () => {},
      setInterval: (_fn: () => void, _ms: number) => ({ kind: "i" }),
      clearInterval: () => {},
    };
    const setTimeoutMs: number[] = [];
    const wrappedSched = {
      ...sched,
      setTimeout: (fn: () => void, ms: number) => {
        setTimeoutMs.push(ms);
        return sched.setTimeout(fn, ms);
      },
    };
    const { deps } = makeKernelDeps({ statePath: join(stateDir, "state.json") });
    _setDepsForTesting(deps);
    const stop = startTicker({
      intervalMs: 30_000,
      entityId: "operator",
      scheduler: wrappedSched,
      firstTickDelayMs: 250,
      registerWatchdog: () => {},
    });
    expect(setTimeoutMs).toEqual([250]);
    stop();
  });
});
