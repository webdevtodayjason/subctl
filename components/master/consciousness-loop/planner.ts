// components/master/consciousness-loop/planner.ts
//
// Memory Init #7 — rule-based deterministic planner (v0.1).
//
// No LLM. No model-assisted reflection. The planner is a pure function:
//
//     (signal_bundle, state, config, now) → PlannerDecision
//
// Same inputs → same output. That guarantee is load-bearing for
// auditability and test stability.
//
// Decision shape:
//
//   noop                 — nothing to do this tick
//   audit_only           — record the tick but take no observable action
//   notify_dashboard     — emit a low-severity dashboard banner
//   schedule_followup    — push a self-scheduled prompt for later
//   remember_candidate   — write a candidate memory for operator review
//   ask_operator         — surface a yes/no question to the operator
//   recommend_team_spawn — record a spawn recommendation (NEVER spawns)
//
// v0.1 rules — kept narrow on purpose so the loop is predictable:
//
//   R1. If signal_hash matches last_signal_hash → audit_only.
//       (If state.tick_count is 0 we still take R1 — first tick is
//        always logged as audit_only; no synthesized urgency on boot.)
//   R2. Any watchdog whose last_tick_at is null AND age_seconds >=
//       stale_threshold OR whose last_tick_at is older than
//       stale_threshold → notify_dashboard, suppressed by id.
//   R3. Notifications unread >= 5 → notify_dashboard (suppression
//       key "notifications-backlog").
//   R4. Pending followups > 0 with next_due_at within the next tick
//       interval → audit_only (the followup-scheduler ticker handles
//       firing; the cognition loop just acknowledges).
//   R5. Otherwise → noop.
//
// Anything in IRREVERSIBLE_ACTIONS is rejected unconditionally and
// recorded in decision.refused — even if a future caller passes it
// in via an extra signal source.

import {
  IRREVERSIBLE_ACTIONS,
  type CognitionLoopConfig,
  type CognitionState,
  type DecisionKind,
  type PlannerDecision,
  type SignalBundle,
} from "./types";

/** Watchdog is considered stale after this many seconds without a tick. */
const STALE_WATCHDOG_THRESHOLD_S = 10 * 60; // 10 min

export interface PlannerInput {
  bundle: SignalBundle;
  signal_hash: string;
  state: CognitionState;
  config: CognitionLoopConfig;
  now: Date;
  /**
   * Optional list of CANDIDATE actions a signal source proposed.
   * Used so the planner can explicitly REFUSE irreversible candidates
   * — making test 5 ("planner refuses irreversible actions")
   * deterministic + observable. Anything in IRREVERSIBLE_ACTIONS is
   * dropped into decision.refused; nothing else short-circuits the
   * rule pipeline.
   */
  candidate_actions?: string[];
}

export function plan(input: PlannerInput): PlannerDecision {
  const { bundle, signal_hash, state, config, now, candidate_actions } = input;
  const refused = collectRefusals(candidate_actions ?? []);
  const ts = now.toISOString();
  const sources: string[] = [];

  // R1 — unchanged signals
  if (state.last_signal_hash && state.last_signal_hash === signal_hash) {
    sources.push("signal_hash");
    return {
      kind: "audit_only",
      rationale: "signal bundle unchanged since last tick",
      sources,
      ts,
      signal_hash,
      ...(refused.length > 0 ? { refused } : {}),
    };
  }

  // R2 — stale watchdog
  const stale = findStaleWatchdog(bundle, now);
  if (stale) {
    sources.push("watchdogs");
    const suppressionKey = `watchdog-stale:${stale.id}`;
    if (suppressionActive(state, suppressionKey, now, config)) {
      return {
        kind: "audit_only",
        rationale: `stale watchdog ${stale.id} suppressed by active window`,
        sources,
        payload: { watchdog_id: stale.id, suppression_key: suppressionKey },
        ts,
        signal_hash,
        ...(refused.length > 0 ? { refused } : {}),
      };
    }
    return {
      kind: "notify_dashboard",
      rationale: `watchdog ${stale.id} (${stale.kind}) has not ticked in ${stale.age_seconds}s`,
      sources,
      payload: {
        watchdog_id: stale.id,
        watchdog_kind: stale.kind,
        age_seconds: stale.age_seconds,
        suppression_key: suppressionKey,
        severity: "warn",
      },
      ts,
      signal_hash,
      ...(refused.length > 0 ? { refused } : {}),
    };
  }

  // R3 — notification backlog
  if (bundle.notifications.unread >= 5) {
    sources.push("notifications");
    const suppressionKey = "notifications-backlog";
    if (suppressionActive(state, suppressionKey, now, config)) {
      return {
        kind: "audit_only",
        rationale: `notifications backlog ${bundle.notifications.unread} (suppressed)`,
        sources,
        payload: { suppression_key: suppressionKey },
        ts,
        signal_hash,
        ...(refused.length > 0 ? { refused } : {}),
      };
    }
    return {
      kind: "notify_dashboard",
      rationale: `${bundle.notifications.unread} unread notifications outstanding`,
      sources,
      payload: {
        unread: bundle.notifications.unread,
        suppression_key: suppressionKey,
        severity: "info",
      },
      ts,
      signal_hash,
      ...(refused.length > 0 ? { refused } : {}),
    };
  }

  // R4 — followup imminent
  if (bundle.followups.pending > 0 && bundle.followups.next_due_at) {
    const dueMs = Date.parse(bundle.followups.next_due_at);
    if (!Number.isNaN(dueMs) && dueMs - now.getTime() <= config.tick_interval_ms) {
      sources.push("followups");
      return {
        kind: "audit_only",
        rationale: `${bundle.followups.pending} followup(s) pending, next due ${bundle.followups.next_due_at}`,
        sources,
        payload: { pending: bundle.followups.pending },
        ts,
        signal_hash,
        ...(refused.length > 0 ? { refused } : {}),
      };
    }
  }

  // R5 — fallback noop
  return {
    kind: "noop",
    rationale: "no actionable signals this tick",
    sources: ["signal_hash"],
    ts,
    signal_hash,
    ...(refused.length > 0 ? { refused } : {}),
  };
}

function collectRefusals(
  candidates: string[],
): { action: string; reason: string }[] {
  const refused: { action: string; reason: string }[] = [];
  const irreversible = new Set(IRREVERSIBLE_ACTIONS);
  for (const action of candidates) {
    if (irreversible.has(action)) {
      refused.push({
        action,
        reason: "irreversible action — v0.1 policy refuses without explicit operator approval",
      });
    }
  }
  return refused;
}

function findStaleWatchdog(
  bundle: SignalBundle,
  now: Date,
): { id: string; kind: string; age_seconds: number } | null {
  for (const w of bundle.watchdogs) {
    let last: number | null = null;
    if (w.last_tick_at) {
      const t = Date.parse(w.last_tick_at);
      last = Number.isNaN(t) ? null : t;
    }
    if (last === null) {
      // Never ticked. Use age_seconds as the staleness proxy.
      if (w.age_seconds >= STALE_WATCHDOG_THRESHOLD_S) {
        return { id: w.id, kind: w.kind, age_seconds: w.age_seconds };
      }
      continue;
    }
    const sinceLast = Math.floor((now.getTime() - last) / 1000);
    if (sinceLast >= STALE_WATCHDOG_THRESHOLD_S) {
      return { id: w.id, kind: w.kind, age_seconds: sinceLast };
    }
  }
  return null;
}

function suppressionActive(
  state: CognitionState,
  key: string,
  now: Date,
  _config: CognitionLoopConfig,
): boolean {
  const until = state.suppressions[key];
  if (!until) return false;
  const untilMs = Date.parse(until);
  if (Number.isNaN(untilMs)) return false;
  return untilMs > now.getTime();
}

/** Exported for status surface — closed set of decision kinds. */
export function isValidDecisionKind(kind: string): kind is DecisionKind {
  return [
    "noop",
    "audit_only",
    "notify_dashboard",
    "schedule_followup",
    "remember_candidate",
    "ask_operator",
    "recommend_team_spawn",
  ].includes(kind);
}
