// components/evy/consciousness-loop/index.ts
//
// Memory Init #7 — public barrel for the Evy cognition loop v0.1.
//
// Importers (server.ts, tests, future CLI) should pull from here
// rather than reaching into individual files; that keeps the
// internal layout free to evolve without breaking consumers.

export { start, WATCHDOG_ID, WATCHDOG_KIND } from "./watchdog";
export type {
  StartOptions,
  StartResult,
  WatchdogRegistryHooks,
} from "./watchdog";

export { getStatus } from "./status";
export type { StatusSnapshot, GetStatusOptions } from "./status";

export { runTick } from "./tick";
export type { TickInputs, TickOutcome } from "./tick";

export { plan } from "./planner";
export type { PlannerInput } from "./planner";

export { executeDecision } from "./executor";
export type { ExecutorProviders, ExecutorResult } from "./executor";

export { gatherSignals, hashSignalBundle } from "./signals";
export type { SignalProviders } from "./signals";

export { loadConfig, defaultConfigPath, defaultStatePath, defaultAuditPath } from "./config";

export {
  loadState,
  saveState,
  appendAudit,
  tailAudit,
  _wipeForTesting,
} from "./state";

export {
  DEFAULT_CONFIG,
  DECISION_KINDS,
  IRREVERSIBLE_ACTIONS,
  INITIAL_STATE,
} from "./types";
export type {
  AuditEntry,
  CognitionLoopConfig,
  CognitionState,
  DecisionKind,
  PlannerDecision,
  SignalBundle,
} from "./types";
