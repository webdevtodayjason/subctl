// components/master/consciousness-loop/types.ts
//
// Memory Init #7 — Evy Cognition Loop v0.1.
//
// Schemas for the bounded, deterministic cognition loop. v0.1 is
// disabled by default, rule-based only, and never executes irreversible
// actions. See .subctl/docs/memory-init/007-evy-cognition-loop.md and
// .subctl/docs/consciousness-loop/SPEC.md.
//
// Why a separate types file: the planner, executor, tick runner, and
// status surface all consume these shapes. Centralizing avoids a circular
// import graph and lets bun:test import shapes without dragging in the
// watchdog wiring.

/** Allowed decision kinds — the closed set for v0.1. */
export type DecisionKind =
  | "noop"
  | "audit_only"
  | "notify_dashboard"
  | "schedule_followup"
  | "remember_candidate"
  | "ask_operator"
  | "recommend_team_spawn";

/** Closed set of decision kinds in display order — used by status + tests. */
export const DECISION_KINDS: readonly DecisionKind[] = [
  "noop",
  "audit_only",
  "notify_dashboard",
  "schedule_followup",
  "remember_candidate",
  "ask_operator",
  "recommend_team_spawn",
] as const;

/**
 * Things the planner / executor MUST refuse in v0.1. Spec is explicit:
 * no push, merge, deploy, migrate, recursive spawn, Tier 1 promotion.
 * Listed as strings so the refusal path can name-check anything
 * synthesized from signals without enumerating every irreversible variant.
 */
export const IRREVERSIBLE_ACTIONS: readonly string[] = [
  "git_push",
  "git_merge",
  "deploy",
  "migrate",
  "spawn_team",
  "tier1_promote",
  "publish",
  "release",
  "delete",
  "drop_table",
] as const;

export interface PlannerDecision {
  kind: DecisionKind;
  /** Free-text rationale, must reference at least one signal source. */
  rationale: string;
  /** Names of signals that contributed (e.g. "watchdogs", "notifications"). */
  sources: string[];
  /** Optional structured payload — shape varies by kind. */
  payload?: Record<string, unknown>;
  /** Anything the planner CONSIDERED and refused, with reason. */
  refused?: { action: string; reason: string }[];
  /** ISO timestamp the decision was made. */
  ts: string;
  /** Stable hash of the signal bundle that produced the decision. */
  signal_hash: string;
}

export interface SignalBundle {
  /** ISO timestamp the bundle was gathered. */
  ts: string;
  /** Compact watchdog snapshot — id, kind, last_tick_at, age_seconds. */
  watchdogs: Array<{
    id: string;
    kind: string;
    age_seconds: number;
    last_tick_at: string | null;
  }>;
  /** Compact notification rollup — counts only, no body. */
  notifications: {
    total: number;
    unread: number;
    by_severity: Record<string, number>;
  };
  /** Compact pending-followups count + next-due. */
  followups: {
    pending: number;
    next_due_at: string | null;
  };
  /**
   * Free-form extensions — additional signal sources may inject keyed
   * blobs here. Hashing canonicalizes JSON so extensions stay
   * deterministic across runs.
   */
  extra?: Record<string, unknown>;
}

export interface CognitionState {
  version: 1;
  last_tick_at: string | null;
  last_signal_hash: string | null;
  last_decision: PlannerDecision | null;
  /** Ring buffer of recent decisions, oldest first. Bounded by config. */
  recent_decisions: PlannerDecision[];
  /** suppression_key → ISO timestamp the suppression expires. */
  suppressions: Record<string, string>;
  /** Current focus/topic the loop is tracking (if any). */
  focus: string | null;
  /** Monotonic tick counter — bumped once per real tick. */
  tick_count: number;
  /** ISO timestamp of last schedule_followup action — used for throttle. */
  last_followup_at: string | null;
}

export interface AuditEntry {
  ts: string;
  tick: number;
  signal_hash: string;
  /** True when signal_hash matches the prior tick's hash. */
  unchanged: boolean;
  /** Lightweight summary — counts only, no full bodies. */
  signals_summary: {
    watchdogs: number;
    notifications_unread: number;
    followups_pending: number;
  };
  decision: PlannerDecision;
  /** True if the executor ran the decision (vs. refused or audit-only). */
  executed: boolean;
  execution_result?: { ok: boolean; reason?: string };
}

export interface CognitionLoopConfig {
  /** v0.1: false by default. The whole loop is gated on this flag. */
  enabled: boolean;
  /** How often the watchdog ticks when armed. */
  tick_interval_ms: number;
  /** Audit JSONL rotation threshold. */
  audit_max_bytes: number;
  /** Dedup window for notify_dashboard actions keyed by suppression_key. */
  suppression_window_ms: number;
  /** Minimum spacing between schedule_followup actions. */
  followup_throttle_ms: number;
  /** Max entries kept in state.recent_decisions. */
  recent_decisions_keep: number;
  /** Override paths — null means "use defaults under SUBCTL_CONFIG_DIR". */
  state_path: string | null;
  audit_path: string | null;
}

export const DEFAULT_CONFIG: CognitionLoopConfig = {
  enabled: false,
  tick_interval_ms: 60_000,
  audit_max_bytes: 2_000_000,
  suppression_window_ms: 15 * 60_000,
  followup_throttle_ms: 5 * 60_000,
  recent_decisions_keep: 32,
  state_path: null,
  audit_path: null,
};

/** Initial state for a fresh install. */
export const INITIAL_STATE: CognitionState = {
  version: 1,
  last_tick_at: null,
  last_signal_hash: null,
  last_decision: null,
  recent_decisions: [],
  suppressions: {},
  focus: null,
  tick_count: 0,
  last_followup_at: null,
};
