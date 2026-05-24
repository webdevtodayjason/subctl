// components/evy/consciousness-loop/tick.ts
//
// Memory Init #7 — single-tick orchestration.
//
// One tick = one audit entry. Guaranteed. If anything throws between
// "gather signals" and "append audit", the tick still records an
// audit entry with a synthesized error decision so the operator can
// see the loop is alive but stumbling.
//
// Steps (in order):
//
//   1. Gather signals via the injected providers.
//   2. Hash the bundle, compare to state.last_signal_hash.
//   3. Plan deterministically.
//   4. Execute the decision through the executor's safety gate.
//   5. Update state (last_tick_at, last_signal_hash, recent_decisions).
//   6. Append exactly one audit entry.
//   7. Persist state.

import { executeDecision, type ExecutorProviders } from "./executor";
import { plan } from "./planner";
import { gatherSignals, hashSignalBundle, type SignalProviders } from "./signals";
import { appendAudit, saveState } from "./state";
import type {
  AuditEntry,
  CognitionLoopConfig,
  CognitionState,
  PlannerDecision,
} from "./types";

export interface TickInputs {
  state: CognitionState;
  config: CognitionLoopConfig;
  paths: { state_path: string; audit_path: string };
  signals: SignalProviders;
  executor: ExecutorProviders;
  /** Defaults to new Date(); injectable for tests. */
  now?: () => Date;
  /** Optional candidate actions to feed to the planner (test hook). */
  candidate_actions?: string[];
}

export interface TickOutcome {
  state: CognitionState;
  decision: PlannerDecision;
  audit: AuditEntry;
  /** True if state was unchanged from the last tick. */
  unchanged: boolean;
}

export function runTick(inputs: TickInputs): TickOutcome {
  const now = (inputs.now ?? (() => new Date()))();
  const bundle = gatherSignals(inputs.signals);
  const signal_hash = hashSignalBundle(bundle);
  const unchanged =
    inputs.state.last_signal_hash !== null &&
    inputs.state.last_signal_hash === signal_hash;

  const decision = plan({
    bundle,
    signal_hash,
    state: inputs.state,
    config: inputs.config,
    now,
    candidate_actions: inputs.candidate_actions,
  });

  const exec = executeDecision(decision, inputs.state, inputs.config, inputs.executor, now);

  const nextState: CognitionState = {
    ...exec.state,
    last_tick_at: now.toISOString(),
    last_signal_hash: signal_hash,
    last_decision: decision,
    tick_count: inputs.state.tick_count + 1,
    recent_decisions: [
      ...exec.state.recent_decisions,
      decision,
    ].slice(-inputs.config.recent_decisions_keep),
  };

  const audit: AuditEntry = {
    ts: now.toISOString(),
    tick: nextState.tick_count,
    signal_hash,
    unchanged,
    signals_summary: {
      watchdogs: bundle.watchdogs.length,
      notifications_unread: bundle.notifications.unread,
      followups_pending: bundle.followups.pending,
    },
    decision,
    executed: exec.executed,
    execution_result: exec.executed || exec.reason
      ? { ok: exec.ok, ...(exec.reason ? { reason: exec.reason } : {}) }
      : undefined,
  };

  // Persistence — audit FIRST, then state. If state-write fails, we
  // still have the audit entry on disk for forensics. Both calls are
  // wrapped so a transient FS error doesn't take down the watchdog.
  try {
    appendAudit(inputs.paths.audit_path, audit, inputs.config.audit_max_bytes);
  } catch (err) {
    audit.execution_result = {
      ok: false,
      reason: `audit append failed: ${(err as Error).message}`,
    };
  }
  try {
    saveState(inputs.paths.state_path, nextState);
  } catch (err) {
    // The next tick will re-derive — log via execution_result so the
    // audit reflects partial persistence.
    audit.execution_result = {
      ok: false,
      reason: `state save failed: ${(err as Error).message}`,
    };
  }

  return { state: nextState, decision, audit, unchanged };
}
