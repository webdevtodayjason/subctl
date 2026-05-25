// components/evy/fitness-types.ts
//
// v3.3.0 — Kernel Fitness Phase 2: fitness-writer types.
//
// Phase 2 builds on the engagement ledger (v3.1.0). The writer rolls
// up one fitness-ledger entry per hour-window from three sources:
//
//   1. engagement-ledger.jsonl  — surface emissions + outcomes
//   2. decisions.jsonl          — transcript_compacted, team_auto_nudge
//   3. consciousness-loop/audit.jsonl + archive transcripts — tick +
//      reflection signals (the loop has `unchanged: boolean` per tick,
//      which is the natural "reflection_repeat" signal).
//
// LOAD-BEARING negative criterion (re-asserted from Phase 1 doctrine):
// the fitness-ledger.jsonl MUST NOT be read by any code path that
// feeds Evy's supervisor prompt. The agent reflects without knowing
// she's being judged. The red-team test in
// `__tests__/fitness-ledger-isolation.test.ts` asserts both layers:
//
//   - Export-shape guard: `fitness-writer.ts` exposes NO reader API.
//   - Surgical body grep: `composeSystemPrompt`,
//     `buildMemoryBlock`, `buildPersonalityFragment`,
//     `hydrateContext`, `buildReviewerSystemPrompt` bodies are free
//     of any fitness symbol.
//
// All scalars are bounded [0, 1]. Composite is "lower is better" for
// stall_*, "higher is better" for engagement_rate.

/** Per-window component breakdown of the stall composite. */
export interface FitnessComponents {
  /**
   * Fraction of reflections in this window that re-saw the same signal
   * hash as the prior reflection. Sourced from the consciousness-loop
   * audit `unchanged: boolean` field. Null when the audit log is
   * absent or the window has < min_reflections_floor reflections.
   */
  reflection_repeat_rate: number | null;
  /**
   * Fraction of worker-related actions in this window that were
   * `team_auto_nudge`. Sourced from decisions.jsonl. Null when there
   * were zero worker-related actions in the window.
   */
  worker_nudge_rate: number | null;
  /**
   * Compactions per reflection in this window, clamped to [0, 1].
   * Sourced from decisions.jsonl. Null when reflection_count is below
   * the floor (same gating as reflection_repeat_rate).
   */
  compaction_rate: number | null;
}

/** Engagement-ledger outcome tallies for the window. */
export interface EngagementCounts {
  acted: number;
  acked: number;
  ignored: number;
}

/**
 * Why a window's composite is null. Surfaced so the dashboard
 * (Phase 3 — v3.4.0) can show "insufficient data" instead of a
 * silent gap.
 */
export type MissingDataReason =
  | "low_reflection_volume"
  | "no_engagement_surfaces"
  | "insufficient_data";

/**
 * One window's worth of fitness state. Append-only — one entry per
 * hour-window. Phase 5 (v3.6.0 refiner) ingests these; Phase 3
 * (v3.4.0 dashboard panel) charts them.
 */
export interface FitnessLedgerEntry {
  /** ISO-8601 timestamp of the window's left edge (inclusive). */
  window_start: string;
  /** ISO-8601 timestamp of the window's right edge (exclusive). */
  window_end: string;
  /** Window duration in seconds — denormalized for downstream charts. */
  window_seconds: number;
  /**
   * stall_composite = 0.4*reflection_repeat + 0.3*worker_nudge + 0.3*compaction.
   * Lower is better. Null when any component is null AND the writer
   * chose to surface that as missing data rather than imputing.
   */
  stall_composite: number | null;
  /** Per-component breakdown so refiner / dashboard can attribute. */
  stall_components: FitnessComponents | null;
  /**
   * engagement_rate = acted / (acted + acked + ignored). Higher is
   * better. Null when the window had zero surfaces emitted.
   */
  engagement_rate: number | null;
  /** Raw engagement tallies. Always present, may be all zero. */
  engagement_counts: EngagementCounts;
  /** Consciousness-loop ticks observed in the window. */
  tick_count: number;
  /**
   * Supervisor-prompt cycles ("reflections") in the window. Proxy:
   * `context_hydrated` decisions, which fire once per supervisor
   * prompt processed. Reasonable approximation until the supervisor
   * starts emitting a first-class reflection event.
   */
  reflection_count: number;
  /** Worker-dispatch-related decisions observed in the window. */
  worker_dispatch_count: number;
  /**
   * Marker for the scaffold/code version that wrote the entry.
   * Phase 4 will pull a stable version out of the scaffold extraction
   * work; until then, a placeholder lets downstream consumers gate.
   */
  scaffold_version: string;
  /**
   * Set when stall_composite is null AND/OR engagement_rate is null
   * so a downstream consumer can render a meaningful empty state.
   */
  missing_data_reason?: MissingDataReason;
}

/**
 * Runtime config for the fitness writer. The on-disk JSON
 * (`fitness-config.json`) is READ-ONLY at runtime — the writer never
 * mutates it and never exposes a setter. Operator tunes values by
 * hand-editing the file and bouncing the daemon.
 */
export interface FitnessConfig {
  /** Window duration in seconds. Locked design decision: 3600. */
  window_seconds: number;
  /** Refiner read-back window count — informational here, used by Phase 5. */
  k_windows: number;
  /** Smallest meaningful composite delta — informational, refiner uses it. */
  delta: number;
  /** Stall-composite component weights. MUST sum to 1.0. */
  weights: {
    repeat: number;
    nudge: number;
    compaction: number;
  };
  /** Below this many reflections per window, composite is null. */
  min_reflections_floor: number;
}
