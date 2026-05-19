// components/master/consciousness-loop/executor.ts
//
// Memory Init #7 — safe-action executor (v0.1).
//
// Decisions arrive from the planner already shaped + audited. The
// executor's job is the gate between "decision recorded" and "side
// effect happens". It:
//
//   - Enforces an allow-list of action kinds. Anything outside is
//     refused with a structured reason (NOT a throw — the loop must
//     keep running).
//   - Refuses anything tagged in IRREVERSIBLE_ACTIONS even if a
//     decision somehow proposes one.
//   - Throttles schedule_followup actions by config.followup_throttle_ms.
//   - Honors notification suppression windows (sets suppressions in
//     state so future ticks can read them back).
//
// Side effects in v0.1 are intentionally minimal:
//   - notify_dashboard         → emit a Notification via the provided sink
//   - schedule_followup        → call providers.scheduleFollowup (caller wires it)
//   - remember_candidate       → call providers.rememberCandidate
//   - ask_operator             → call providers.askOperator
//   - recommend_team_spawn     → call providers.recordRecommendation (NEVER spawns)
//   - noop / audit_only        → nothing
//
// Every provider is injectable so the tick runner can be tested in
// isolation, and so spec compliance ("no push/merge/deploy/spawn") is
// guaranteed by absence — there's literally no provider for those
// kinds, and the allow-list rejects unknown kinds.

import {
  IRREVERSIBLE_ACTIONS,
  type CognitionLoopConfig,
  type CognitionState,
  type DecisionKind,
  type PlannerDecision,
} from "./types";

export interface ExecutorProviders {
  /** Push a low-severity dashboard banner. */
  notify?: (n: {
    title: string;
    body: string;
    severity: "info" | "warn";
    suppression_key?: string;
  }) => void;
  /** Record a follow-up prompt the loop wants to revisit later. */
  scheduleFollowup?: (f: { summary: string; prompt: string; fire_at: string }) => void;
  /** Record a candidate memory for operator review. */
  rememberCandidate?: (c: { content: string; sources: string[] }) => void;
  /** Surface a yes/no question to the operator. */
  askOperator?: (q: { prompt: string; tags: string[] }) => void;
  /** Record a recommendation that a team COULD be spawned. NEVER spawns. */
  recordRecommendation?: (r: { template: string; reason: string }) => void;
}

export interface ExecutorResult {
  /** True if a side effect ran. False for noop/audit_only and for refusals. */
  executed: boolean;
  /** True iff the executor permitted the action. */
  ok: boolean;
  /** Human-readable reason — populated when executed=false. */
  reason?: string;
  /** Mutated state — never mutate the input; return the new one. */
  state: CognitionState;
}

/** Side-effecting kinds the executor is allowed to run in v0.1. */
const ALLOWED_SIDE_EFFECT_KINDS: ReadonlySet<DecisionKind> = new Set([
  "notify_dashboard",
  "schedule_followup",
  "remember_candidate",
  "ask_operator",
  "recommend_team_spawn",
]);

/** Kinds that are pure observation — executor returns ok+no side effect. */
const OBSERVATION_KINDS: ReadonlySet<DecisionKind> = new Set([
  "noop",
  "audit_only",
]);

export function executeDecision(
  decision: PlannerDecision,
  state: CognitionState,
  config: CognitionLoopConfig,
  providers: ExecutorProviders,
  now: Date,
): ExecutorResult {
  const nextState: CognitionState = cloneState(state);

  // Defense in depth — even if a decision tags itself with an
  // irreversible action via payload, refuse.
  const proposedAction = typeof decision.payload?.action === "string"
    ? (decision.payload.action as string)
    : null;
  if (proposedAction && IRREVERSIBLE_ACTIONS.includes(proposedAction)) {
    return {
      executed: false,
      ok: false,
      reason: `executor refused irreversible action: ${proposedAction}`,
      state: nextState,
    };
  }

  if (OBSERVATION_KINDS.has(decision.kind)) {
    return { executed: false, ok: true, state: nextState };
  }

  if (!ALLOWED_SIDE_EFFECT_KINDS.has(decision.kind)) {
    return {
      executed: false,
      ok: false,
      reason: `executor refused unknown decision kind: ${decision.kind}`,
      state: nextState,
    };
  }

  // Suppression check — keyed by payload.suppression_key. Same key
  // within suppression_window_ms is silently dropped (audit still
  // records the attempt).
  const suppressionKey =
    typeof decision.payload?.suppression_key === "string"
      ? decision.payload.suppression_key
      : null;
  if (suppressionKey) {
    const until = nextState.suppressions[suppressionKey];
    if (until && Date.parse(until) > now.getTime()) {
      return {
        executed: false,
        ok: true,
        reason: `suppressed (window active until ${until})`,
        state: nextState,
      };
    }
  }

  switch (decision.kind) {
    case "notify_dashboard": {
      if (!providers.notify) {
        return { executed: false, ok: false, reason: "no notify provider", state: nextState };
      }
      const severity = decision.payload?.severity === "warn" ? "warn" : "info";
      providers.notify({
        title: "cognition-loop",
        body: decision.rationale,
        severity,
        suppression_key: suppressionKey ?? undefined,
      });
      if (suppressionKey) {
        const until = new Date(now.getTime() + config.suppression_window_ms).toISOString();
        nextState.suppressions[suppressionKey] = until;
      }
      return { executed: true, ok: true, state: nextState };
    }
    case "schedule_followup": {
      if (!providers.scheduleFollowup) {
        return { executed: false, ok: false, reason: "no scheduleFollowup provider", state: nextState };
      }
      // Throttle — refuse if we scheduled one too recently.
      if (nextState.last_followup_at) {
        const lastMs = Date.parse(nextState.last_followup_at);
        if (!Number.isNaN(lastMs) && now.getTime() - lastMs < config.followup_throttle_ms) {
          return {
            executed: false,
            ok: true,
            reason: `followup throttled (last at ${nextState.last_followup_at})`,
            state: nextState,
          };
        }
      }
      const summary = typeof decision.payload?.summary === "string"
        ? decision.payload.summary
        : decision.rationale;
      const prompt = typeof decision.payload?.prompt === "string"
        ? decision.payload.prompt
        : decision.rationale;
      const fire_at = typeof decision.payload?.fire_at === "string"
        ? decision.payload.fire_at
        : new Date(now.getTime() + 15 * 60_000).toISOString();
      providers.scheduleFollowup({ summary, prompt, fire_at });
      nextState.last_followup_at = now.toISOString();
      return { executed: true, ok: true, state: nextState };
    }
    case "remember_candidate": {
      if (!providers.rememberCandidate) {
        return { executed: false, ok: false, reason: "no rememberCandidate provider", state: nextState };
      }
      const content = typeof decision.payload?.content === "string"
        ? decision.payload.content
        : decision.rationale;
      providers.rememberCandidate({ content, sources: decision.sources });
      return { executed: true, ok: true, state: nextState };
    }
    case "ask_operator": {
      if (!providers.askOperator) {
        return { executed: false, ok: false, reason: "no askOperator provider", state: nextState };
      }
      const prompt = typeof decision.payload?.prompt === "string"
        ? decision.payload.prompt
        : decision.rationale;
      const tags = Array.isArray(decision.payload?.tags)
        ? (decision.payload.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      providers.askOperator({ prompt, tags });
      return { executed: true, ok: true, state: nextState };
    }
    case "recommend_team_spawn": {
      if (!providers.recordRecommendation) {
        return { executed: false, ok: false, reason: "no recordRecommendation provider", state: nextState };
      }
      const template = typeof decision.payload?.template === "string"
        ? decision.payload.template
        : "unspecified";
      providers.recordRecommendation({
        template,
        reason: decision.rationale,
      });
      return { executed: true, ok: true, state: nextState };
    }
    default: {
      return {
        executed: false,
        ok: false,
        reason: `executor refused unknown decision kind: ${decision.kind}`,
        state: nextState,
      };
    }
  }
}

function cloneState(s: CognitionState): CognitionState {
  return {
    version: s.version,
    last_tick_at: s.last_tick_at,
    last_signal_hash: s.last_signal_hash,
    last_decision: s.last_decision,
    recent_decisions: [...s.recent_decisions],
    suppressions: { ...s.suppressions },
    focus: s.focus,
    tick_count: s.tick_count,
    last_followup_at: s.last_followup_at,
  };
}
