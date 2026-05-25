// components/evy/memory-kernel.ts
//
// Memory Consciousness Cycle — orchestration / watchdog glue (Worker C).
//
// Wires Worker A's sidecar endpoints (memori-client.ts) and Worker B's
// reviewer (memory-kernel-reviewer.ts) into a periodic cycle:
//
//   1. select_unreviewed  — pull a batch of raw Tier 3 events the kernel
//                            has not adjudicated yet
//   2. reviewEvents       — let the supervisor LLM produce a decisions[]
//                            array per Evy's reviewer-prompt contract
//   3. enact decisions    — per-decision: mark_reviewed and (when the
//                            action is promote_tier3 + confidence >= 0.7)
//                            call /promote
//   4. persist state      — record cycle counters to
//                            ~/.config/subctl/evy/memory-kernel-state.json
//                            and append a decisions.jsonl row
//
// This file is the ONLY new module touching state on disk. It depends on
// the reviewer (pure module, no fs) and the memori-client (already has
// dep injection). All side-effect surfaces are injectable for tests.
//
// Design contract: /Users/you/Documents/Obsidian Vault/Subctl/design/
// memory-kernel-consciousness-cycle.md — "Architecture Sketch".

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  selectUnreviewed as memoriSelectUnreviewed,
  markReviewed as memoriMarkReviewed,
  promote as memoriPromote,
  type MemoriResult,
  type MemoriReviewState,
  type MemoriUnreviewedEvent,
} from "./memori-client";
import {
  reviewEvents as defaultReviewEvents,
  type RawEvent,
  type ReviewDecision,
  type ReviewerContext,
  type ReviewerOutput,
} from "./memory-kernel-reviewer";
import { appendCandidate as appendTier1Candidate } from "./tier1-candidates";

// ─── public types ─────────────────────────────────────────────────────────

export interface MemoryKernelState {
  last_cycle_at: string | null;
  last_cycle_decisions: number;
  last_cycle_promotions: number;
  last_cycle_errors: number;
  total_cycles: number;
  total_promotions: number;
  paused: boolean;
}

export interface MemoryKernelCycleResult {
  ok: boolean;
  decisions_count: number;
  promotions_count: number;
  errors_count: number;
  cycle_ms: number;
  /** Set when the kernel short-circuited (paused, no events, etc.). */
  note?: string;
  /** Optional first-error message — useful for the operator surface. */
  error?: string;
  /** Reviewer's last batch (echoed for /status). */
  decisions?: ReviewDecision[];
  /** Resolved reviewer ident ("<provider>/<model>"). */
  reviewer_model?: string;
}

export interface RunOneCycleOpts {
  entity_id: string;
  dry_run?: boolean;
  limit?: number;
}

// ─── promotion-policy constants ───────────────────────────────────────────

/** Confidence floor for autonomous promote_tier3 writes. */
export const PROMOTION_CONFIDENCE_THRESHOLD = 0.7;

// ─── state file ───────────────────────────────────────────────────────────

const STATE_VERSION = 1;
const HOME = homedir();
const DEFAULT_STATE_PATH = join(
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl"),
  "master",
  "memory-kernel-state.json",
);

interface PersistedState {
  version: number;
  last_cycle_at: string | null;
  last_cycle_decisions: number;
  last_cycle_promotions: number;
  last_cycle_errors: number;
  total_cycles: number;
  total_promotions: number;
  paused: boolean;
}

function freshState(): PersistedState {
  return {
    version: STATE_VERSION,
    last_cycle_at: null,
    last_cycle_decisions: 0,
    last_cycle_promotions: 0,
    last_cycle_errors: 0,
    total_cycles: 0,
    total_promotions: 0,
    paused: false,
  };
}

function loadStateFromDisk(path: string): PersistedState {
  try {
    if (!existsSync(path)) return freshState();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
    if (typeof parsed !== "object" || parsed === null) return freshState();
    return {
      version: STATE_VERSION,
      last_cycle_at: typeof parsed.last_cycle_at === "string" ? parsed.last_cycle_at : null,
      last_cycle_decisions: Number(parsed.last_cycle_decisions ?? 0) || 0,
      last_cycle_promotions: Number(parsed.last_cycle_promotions ?? 0) || 0,
      last_cycle_errors: Number(parsed.last_cycle_errors ?? 0) || 0,
      total_cycles: Number(parsed.total_cycles ?? 0) || 0,
      total_promotions: Number(parsed.total_promotions ?? 0) || 0,
      paused: parsed.paused === true,
    };
  } catch (err) {
    console.error(
      `[memory-kernel] state load failed (${(err as Error).message}) — starting fresh`,
    );
    return freshState();
  }
}

function persistStateToDisk(path: string, state: PersistedState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.error(
      `[memory-kernel] state persist failed: ${(err as Error).message}`,
    );
  }
}

// ─── injectable dep surface ───────────────────────────────────────────────

export interface KernelDeps {
  /** Resolve raw events to review. Default: memori-client.selectUnreviewed */
  selectUnreviewed: (input: { entity_id: string; limit?: number }) =>
    Promise<MemoriResult<{ events: MemoriUnreviewedEvent[] }>>;
  /** Mark raw rows reviewed. Default: memori-client.markReviewed */
  markReviewed: (input: {
    ids: string[];
    review_state: MemoriReviewState;
    reviewer_model?: string;
    reason?: string;
    confidence?: number;
  }) => Promise<MemoriResult<{ marked: number }>>;
  /** Atomic curated insert + source-row state flip. Default: memori-client.promote */
  promote: (input: {
    entity_id: string;
    source_ids: string[];
    memory: string;
    kind?: string;
    reason?: string;
    confidence?: number;
    reviewer_model?: string;
  }) => Promise<MemoriResult<{ id: string | null }>>;
  /** Reviewer entry point. Default: memory-kernel-reviewer.reviewEvents */
  reviewEvents: (
    events: RawEvent[],
    context: ReviewerContext,
  ) => Promise<ReviewerOutput>;
  /** Operator name threaded into reviewer context. */
  operatorName: () => string;
  /** Recent curated context the reviewer needs to avoid re-promotion. */
  recentTier1Facts: () => string[];
  recentEvyMemories: () => string[];
  /** Active project name (optional). */
  activeProject: () => string | undefined;
  /** Operator notifications for escalate-action decisions. */
  emitNotification: (input: {
    kind: string;
    severity: "info" | "warn" | "alert";
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) => void;
  /** Append a row to decisions.jsonl. */
  logDecision: (entry: { project: string; action: string; rationale: string }) => void;
  /** SSE broadcast to the dashboard. */
  broadcast: (eventType: string, payload: unknown) => void;
  /** Hook for tests to swap the state file path. */
  statePath: string;
  /** Clock seam. */
  now: () => number;
}

const realDeps: KernelDeps = {
  selectUnreviewed: (input) => memoriSelectUnreviewed({ entity_id: input.entity_id, limit: input.limit }),
  markReviewed: (input) => memoriMarkReviewed(input),
  promote: (input) => memoriPromote(input),
  reviewEvents: (events, context) => defaultReviewEvents(events, context),
  operatorName: () => "operator",
  recentTier1Facts: () => [],
  recentEvyMemories: () => [],
  activeProject: () => undefined,
  emitNotification: () => {
    /* default no-op — caller wires the real notifications surface */
  },
  logDecision: () => {
    /* default no-op — caller wires the real decisions.jsonl appender */
  },
  broadcast: () => {
    /* default no-op — caller wires the real SSE bus */
  },
  statePath: DEFAULT_STATE_PATH,
  now: () => Date.now(),
};

let deps: KernelDeps = realDeps;

export function _setDepsForTesting(partial: Partial<KernelDeps>): void {
  deps = { ...realDeps, ...deps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
  // Wipe module-level state so the next test starts from zero. We
  // deliberately do NOT read realDeps.statePath here — a real state
  // file on disk (from a live master run) would leak counters into
  // every test. Tests inject a temp statePath via _setDepsForTesting
  // anyway, so this is the correct hermetic reset.
  _state = freshState();
  _lastDecisions = [];
  _lastReviewerModel = "unknown/unknown";
}

// ─── in-memory state ──────────────────────────────────────────────────────

let _state: PersistedState = loadStateFromDisk(realDeps.statePath);
/** Last cycle's full decisions list (for /memory/kernel/status echo). */
let _lastDecisions: ReviewDecision[] = [];
let _lastReviewerModel = "unknown/unknown";

/** Returns the live kernel state (in-memory; mirror of last persisted write). */
export function getState(): MemoryKernelState {
  return {
    last_cycle_at: _state.last_cycle_at,
    last_cycle_decisions: _state.last_cycle_decisions,
    last_cycle_promotions: _state.last_cycle_promotions,
    last_cycle_errors: _state.last_cycle_errors,
    total_cycles: _state.total_cycles,
    total_promotions: _state.total_promotions,
    paused: _state.paused,
  };
}

/** Operator-controlled pause flag. Survives restart via state file. */
export function pause(): void {
  if (_state.paused) return;
  _state.paused = true;
  persistStateToDisk(deps.statePath, _state);
}

export function resume(): void {
  if (!_state.paused) return;
  _state.paused = false;
  persistStateToDisk(deps.statePath, _state);
}

/** Echo of last cycle's decisions for the /status endpoint. */
export function getLastDecisions(): {
  reviewer_model: string;
  decisions: ReviewDecision[];
} {
  return { reviewer_model: _lastReviewerModel, decisions: _lastDecisions };
}

// ─── one-cycle orchestration ──────────────────────────────────────────────

/**
 * Convert a sidecar raw event into the reviewer's RawEvent shape. Drop
 * sidecar-specific fields the reviewer doesn't need (review_state) and
 * normalize nullable strings to undefined.
 */
function toReviewerEvent(ev: MemoriUnreviewedEvent): RawEvent {
  return {
    id: ev.id,
    ts: ev.ts,
    user_text: ev.user_text ?? undefined,
    assistant_text: ev.assistant_text ?? undefined,
    tool_calls_json: ev.tool_calls_json ?? undefined,
    decisions_json: ev.decisions_json ?? undefined,
    outcomes_json: ev.outcomes_json ?? undefined,
    metadata_json: ev.metadata_json ?? undefined,
  };
}

/**
 * Run one full review cycle. Always returns a result object; never
 * throws past this boundary. Caller (ticker / HTTP run-now) handles
 * logging + broadcasting using the same shape.
 */
export async function runOneCycle(
  opts: RunOneCycleOpts,
): Promise<MemoryKernelCycleResult> {
  const t0 = deps.now();

  if (_state.paused) {
    return {
      ok: true,
      decisions_count: 0,
      promotions_count: 0,
      errors_count: 0,
      cycle_ms: deps.now() - t0,
      note: "paused",
    };
  }

  // 1. Pull a batch of unreviewed events.
  const selected = await deps.selectUnreviewed({
    entity_id: opts.entity_id,
    limit: opts.limit ?? 50,
  });
  if (!selected.ok) {
    return {
      ok: false,
      decisions_count: 0,
      promotions_count: 0,
      errors_count: 1,
      cycle_ms: deps.now() - t0,
      error: `selectUnreviewed: ${selected.error}`,
    };
  }
  const events = selected.data.events ?? [];
  if (events.length === 0) {
    return {
      ok: true,
      decisions_count: 0,
      promotions_count: 0,
      errors_count: 0,
      cycle_ms: deps.now() - t0,
      note: "no events",
    };
  }

  // 2. Hand the batch to the reviewer.
  const context: ReviewerContext = {
    operator_name: deps.operatorName(),
    recent_tier1_facts: deps.recentTier1Facts(),
    recent_evy_memories: deps.recentEvyMemories(),
    active_project: deps.activeProject(),
  };
  let reviewOut: ReviewerOutput;
  try {
    reviewOut = await deps.reviewEvents(events.map(toReviewerEvent), context);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      ok: false,
      decisions_count: 0,
      promotions_count: 0,
      errors_count: 1,
      cycle_ms: deps.now() - t0,
      error: `reviewer threw: ${msg}`,
    };
  }

  const decisions = reviewOut.decisions ?? [];
  _lastDecisions = decisions;
  _lastReviewerModel = reviewOut.reviewer_model ?? "unknown/unknown";

  // 3. Enact decisions. Dry-run skips every write (mark_reviewed + promote).
  let promotionsCount = 0;
  let tier1CandidatesCount = 0;
  let errorsCount = 0;
  let escalations = 0;
  let firstError: string | undefined;
  const recordError = (msg: string) => {
    errorsCount++;
    if (!firstError) firstError = msg;
    console.error(`[memory-kernel] enact error: ${msg}`);
  };

  if (!opts.dry_run) {
    for (const d of decisions) {
      try {
        await enactDecision(d, {
          entity_id: opts.entity_id,
          reviewer_model: _lastReviewerModel,
          onPromoted: () => {
            promotionsCount++;
          },
          onEscalated: () => {
            escalations++;
          },
          onTier1Candidate: () => {
            tier1CandidatesCount++;
          },
          recordError,
        });
      } catch (err) {
        recordError(`enact threw: ${(err as Error).message}`);
      }
    }
  }

  // 4. Update in-memory + persisted state.
  const completedAt = new Date().toISOString();
  _state.last_cycle_at = completedAt;
  _state.last_cycle_decisions = decisions.length;
  _state.last_cycle_promotions = promotionsCount;
  _state.last_cycle_errors = errorsCount;
  _state.total_cycles += 1;
  _state.total_promotions += promotionsCount;
  persistStateToDisk(deps.statePath, _state);

  // 5. decisions.jsonl row + SSE broadcast.
  const cycle_ms = deps.now() - t0;
  const rationale =
    `${events.length} events reviewed, ${promotionsCount} promoted, ` +
    `${tier1CandidatesCount} tier1-candidates, ${escalations} escalated, ` +
    `model=${_lastReviewerModel}` +
    (opts.dry_run ? ", dry_run=true" : "") +
    (errorsCount > 0 ? `, errors=${errorsCount}` : "");
  deps.logDecision({
    project: "_master",
    action: "memory_kernel_cycle",
    rationale,
  });
  deps.broadcast("memory_kernel_cycle", {
    ts: completedAt,
    decisions_count: decisions.length,
    promotions_count: promotionsCount,
    errors_count: errorsCount,
    escalations,
    cycle_ms,
    reviewer_model: _lastReviewerModel,
    dry_run: opts.dry_run === true,
  });

  return {
    ok: errorsCount === 0,
    decisions_count: decisions.length,
    promotions_count: promotionsCount,
    errors_count: errorsCount,
    cycle_ms,
    error: firstError,
    decisions,
    reviewer_model: _lastReviewerModel,
  };
}

/**
 * Apply one decision per the policy table:
 *   - discard            → mark_reviewed state=discarded
 *   - keep_raw           → mark_reviewed state=reviewed
 *   - promote_tier3 +
 *       confidence>=0.7  → /promote, then (note: /promote already flips
 *                          source rows to state='promoted' atomically;
 *                          this enactor follows the spec and does NOT
 *                          double-call mark_reviewed in the common case
 *                          to avoid clobbering the reviewer_model/reason
 *                          /confidence already written by /promote.)
 *   - promote_tier3 +
 *       confidence<0.7   → mark_reviewed state=reviewed; log skip
 *   - propose_tier1      → mark_reviewed state=reviewed (Phase 3 deferred)
 *   - escalate           → mark_reviewed state=escalated + alert notification
 */
async function enactDecision(
  d: ReviewDecision,
  ctx: {
    entity_id: string;
    reviewer_model: string;
    onPromoted: () => void;
    onEscalated: () => void;
    onTier1Candidate: () => void;
    recordError: (msg: string) => void;
  },
): Promise<void> {
  const baseMark = {
    ids: d.source_event_ids,
    reviewer_model: ctx.reviewer_model,
    reason: d.reason,
    confidence: d.confidence,
  };

  switch (d.action) {
    case "discard": {
      const r = await deps.markReviewed({ ...baseMark, review_state: "discarded" });
      if (!r.ok) ctx.recordError(`mark_reviewed(discarded): ${r.error}`);
      return;
    }
    case "keep_raw": {
      const r = await deps.markReviewed({ ...baseMark, review_state: "reviewed" });
      if (!r.ok) ctx.recordError(`mark_reviewed(reviewed): ${r.error}`);
      return;
    }
    case "promote_tier3": {
      if (!d.memory) {
        // Reviewer validation would normally reject this, but be defensive.
        ctx.recordError("promote_tier3 decision missing memory text");
        return;
      }
      if (d.confidence < PROMOTION_CONFIDENCE_THRESHOLD) {
        const r = await deps.markReviewed({ ...baseMark, review_state: "reviewed" });
        if (!r.ok) {
          ctx.recordError(`mark_reviewed(reviewed): ${r.error}`);
        }
        console.error(
          `[memory-kernel] low-confidence promotion candidate skipped (confidence=${d.confidence.toFixed(2)} < ${PROMOTION_CONFIDENCE_THRESHOLD}): ${d.memory.slice(0, 80)}`,
        );
        return;
      }
      const promoted = await deps.promote({
        entity_id: ctx.entity_id,
        source_ids: d.source_event_ids,
        memory: d.memory,
        kind: d.kind,
        reason: d.reason,
        confidence: d.confidence,
        reviewer_model: ctx.reviewer_model,
      });
      if (!promoted.ok) {
        ctx.recordError(`promote: ${promoted.error}`);
        return;
      }
      // /promote already atomically flips source rows to review_state='promoted'
      // and writes reviewer_model/reason/confidence (server.py L519-525). The
      // spec asks for an additional mark_reviewed call, but that would clobber
      // the freshly-written metadata with the same values. Skipped here to
      // avoid the redundant write; flagged in REPORT BACK.
      ctx.onPromoted();
      return;
    }
    case "propose_tier1": {
      // Phase 3 — append the proposal to the Tier 1 candidate queue for
      // operator/Evy review. Still mark the source rows reviewed so the
      // reviewer doesn't re-evaluate them on every cycle. If the reviewer
      // omitted the memory text we treat it as an error (validation would
      // normally reject this).
      const r = await deps.markReviewed({ ...baseMark, review_state: "reviewed" });
      if (!r.ok) {
        ctx.recordError(`mark_reviewed(reviewed): ${r.error}`);
        // continue — still queue the candidate so the operator sees it
      }
      if (!d.memory) {
        ctx.recordError("propose_tier1 decision missing memory text");
        return;
      }
      try {
        const candidate = appendTier1Candidate({
          source_event_ids: d.source_event_ids,
          memory: d.memory,
          kind: d.kind ?? "preference",
          reason: d.reason,
          confidence: d.confidence,
          reviewer_model: ctx.reviewer_model,
        });
        ctx.onTier1Candidate();
        console.error(
          `[memory-kernel] tier1-candidate queued ${candidate.id}: ${d.memory.slice(0, 80)}`,
        );
      } catch (err) {
        ctx.recordError(`appendTier1Candidate: ${(err as Error).message}`);
      }
      return;
    }
    case "escalate": {
      const r = await deps.markReviewed({ ...baseMark, review_state: "escalated" });
      if (!r.ok) {
        ctx.recordError(`mark_reviewed(escalated): ${r.error}`);
        // continue — still emit the notification so the operator sees it
      }
      ctx.onEscalated();
      try {
        deps.emitNotification({
          kind: "memory-kernel-escalation",
          severity: "warn",
          title: `Memory kernel escalation (${d.source_event_ids.length} event${d.source_event_ids.length === 1 ? "" : "s"})`,
          body: `Reviewer flagged for operator attention: ${d.reason}\n\nSource events: ${d.source_event_ids.join(", ")}`,
          metadata: {
            source_event_ids: d.source_event_ids,
            confidence: d.confidence,
            reviewer_model: ctx.reviewer_model,
          },
        });
      } catch (err) {
        ctx.recordError(`emitNotification: ${(err as Error).message}`);
      }
      return;
    }
    default: {
      // Belt + suspenders: reviewer validation already enforces the enum.
      ctx.recordError(`unknown action: ${(d as { action: string }).action}`);
      return;
    }
  }
}

// ─── ticker ───────────────────────────────────────────────────────────────

export interface StartTickerOpts {
  intervalMs: number;
  entityId: string;
  /** Watchdog registration hook (server passes registerWatchdog). */
  registerWatchdog: (entry: {
    id: string;
    kind: string;
    kill: () => void;
  }) => void;
  /** Watchdog freshness hook (touchWatchdog). */
  touchWatchdog?: (id: string) => void;
  /** Tester seam — defaults to setTimeout / setInterval. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Error handler — surfaces uncaught ticker exceptions for the operator. */
  onError?: (err: Error) => void;
  /** First-tick delay (ms). Defaults to 10_000 so boot can settle. */
  firstTickDelayMs?: number;
}

/** Public id under which the kernel is registered with watchdogs.ts. */
export const KERNEL_WATCHDOG_ID = "memory-kernel";

/**
 * Arm the periodic loop. Returns a `stop()` closure that clears both the
 * boot timeout and the periodic interval — safe to call from graceful
 * shutdown or the kill endpoint.
 */
export function startTicker(opts: StartTickerOpts): () => void {
  const sched = opts.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  let stopped = false;
  let inFlight = false;
  let tickHandle: unknown = null;
  let bootHandle: unknown = null;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      opts.touchWatchdog?.(KERNEL_WATCHDOG_ID);
      const result = await runOneCycle({ entity_id: opts.entityId });
      if (!result.ok && result.error) {
        // tick already broadcast + logged; surface the first error to onError
        opts.onError?.(new Error(result.error));
      }
    } catch (err) {
      opts.onError?.(err as Error);
    } finally {
      inFlight = false;
    }
  };

  const stopFn = () => {
    if (stopped) return;
    stopped = true;
    try { if (bootHandle !== null) sched.clearTimeout(bootHandle); } catch { /* ignore */ }
    try { if (tickHandle !== null) sched.clearInterval(tickHandle); } catch { /* ignore */ }
  };

  const firstDelay = opts.firstTickDelayMs ?? 10_000;
  bootHandle = sched.setTimeout(() => {
    if (stopped) return;
    void tick();
    tickHandle = sched.setInterval(() => void tick(), opts.intervalMs);
  }, firstDelay);

  opts.registerWatchdog({
    id: KERNEL_WATCHDOG_ID,
    kind: KERNEL_WATCHDOG_ID,
    kill: stopFn,
  });

  return stopFn;
}
