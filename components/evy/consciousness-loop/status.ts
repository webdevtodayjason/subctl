// components/evy/consciousness-loop/status.ts
//
// Memory Init #7 — read-only status surface.
//
// `getStatus()` returns the shape that CLI / dashboard / API surfaces
// can render verbatim. Stateless: re-reads state.json on every call.
// Returns a sentinel object when the loop is disabled or has never
// ticked, so callers don't need to special-case "first boot, no state
// yet".

import { loadConfig, resolvePaths } from "./config";
import { loadState, tailAudit } from "./state";
import type {
  AuditEntry,
  CognitionLoopConfig,
  CognitionState,
  PlannerDecision,
} from "./types";

export interface StatusSnapshot {
  enabled: boolean;
  armed: boolean;
  config: {
    tick_interval_ms: number;
    suppression_window_ms: number;
    followup_throttle_ms: number;
  };
  last_tick_at: string | null;
  tick_count: number;
  focus: string | null;
  last_decision: PlannerDecision | null;
  recent_decisions: PlannerDecision[];
  suppressions: Array<{ key: string; until: string; active: boolean }>;
  audit_tail: AuditEntry[];
}

export interface GetStatusOptions {
  configPath?: string;
  /**
   * Whether the watchdog is currently armed in-process. Status itself
   * is stateless, but callers (server.ts) know the runtime answer and
   * can pass it through.
   */
  armed?: boolean;
  /** Tail size for the audit log. Defaults to 20. */
  audit_tail_size?: number;
}

export function getStatus(opts: GetStatusOptions = {}): StatusSnapshot {
  const config: CognitionLoopConfig = loadConfig(opts.configPath);
  const paths = resolvePaths(config);
  const state: CognitionState = loadState(paths.state_path);
  const now = Date.now();
  const auditN = opts.audit_tail_size ?? 20;

  const suppressions = Object.entries(state.suppressions).map(([key, until]) => ({
    key,
    until,
    active: Date.parse(until) > now,
  }));

  return {
    enabled: config.enabled,
    armed: opts.armed ?? false,
    config: {
      tick_interval_ms: config.tick_interval_ms,
      suppression_window_ms: config.suppression_window_ms,
      followup_throttle_ms: config.followup_throttle_ms,
    },
    last_tick_at: state.last_tick_at,
    tick_count: state.tick_count,
    focus: state.focus,
    last_decision: state.last_decision,
    recent_decisions: state.recent_decisions,
    suppressions,
    audit_tail: tailAudit(paths.audit_path, auditN),
  };
}
