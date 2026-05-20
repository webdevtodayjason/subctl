// components/master/consciousness-loop/watchdog.ts
//
// Memory Init #7 — disabled-by-default watchdog wiring.
//
// `start()` is the only entry point. It:
//
//   - Loads config. If disabled → returns { armed: false, ... } and
//     touches nothing else. No setInterval, no registerWatchdog call,
//     no audit entry.
//   - If enabled → registers a watchdog with id "consciousness-loop"
//     via the injected registry hooks, arms a setInterval that calls
//     runTick on each fire, and returns a `kill()` callable.
//
// Registry hooks are injected so this module doesn't import
// watchdogs.ts directly — that lets the bun:test suite verify the
// disabled / enabled branches without booting the rest of master.

import { runTick, type TickInputs } from "./tick";
import { loadState, saveState } from "./state";
import { loadConfig, resolvePaths } from "./config";
import type { ExecutorProviders } from "./executor";
import type { SignalProviders } from "./signals";
import type {
  CognitionLoopConfig,
  CognitionState,
  PlannerDecision,
} from "./types";

export interface WatchdogRegistryHooks {
  /** Register an id+kind+kill triple with the master registry. */
  register: (entry: { id: string; kind: string; kill: () => void }) => void;
  /** Bump last_tick_at for an id. */
  touch: (id: string) => void;
}

export interface StartOptions {
  /** Path to the config JSON; default → ~/.config/subctl/master/consciousness-loop.json. */
  configPath?: string;
  /** Pre-loaded config (skips loadConfig). Used by tests + by callers who already have it. */
  configOverride?: CognitionLoopConfig;
  registry: WatchdogRegistryHooks;
  signals: SignalProviders;
  executor: ExecutorProviders;
  /** Override of new Date() for tests. */
  now?: () => Date;
}

export interface StartResult {
  /** True only when config.enabled was true and the watchdog is armed. */
  armed: boolean;
  /** Config that was loaded (for status surfaces). */
  config: CognitionLoopConfig;
  /** Idempotent teardown. No-op if armed=false. */
  kill: () => void;
  /** Force a single tick out-of-band (e.g. from CLI). Returns null if not armed. */
  tickNow: () => PlannerDecision | null;
  /** Snapshot of the in-memory state. */
  getState: () => CognitionState;
}

export const WATCHDOG_ID = "consciousness-loop";
export const WATCHDOG_KIND = "consciousness-loop";

export function start(opts: StartOptions): StartResult {
  const config = opts.configOverride ?? loadConfig(opts.configPath);
  const paths = resolvePaths(config);

  if (!config.enabled) {
    return {
      armed: false,
      config,
      kill: () => undefined,
      tickNow: () => null,
      getState: () => loadState(paths.state_path),
    };
  }

  let state = loadState(paths.state_path);
  let killed = false;

  const tickOnce = (): PlannerDecision => {
    const inputs: TickInputs = {
      state,
      config,
      paths,
      signals: opts.signals,
      executor: opts.executor,
      now: opts.now,
    };
    const out = runTick(inputs);
    state = out.state;
    return out.decision;
  };

  const interval = setInterval(() => {
    if (killed) return;
    opts.registry.touch(WATCHDOG_ID);
    try {
      tickOnce();
    } catch (err) {
      // The tick already attempts to record errors via execution_result.
      // If runTick itself throws (defensive), surface to stderr so
      // master.log captures it but don't crash the daemon.
      console.error(
        `[consciousness-loop] tick threw: ${(err as Error).message ?? err}`,
      );
    }
  }, config.tick_interval_ms);

  const kill = () => {
    if (killed) return;
    killed = true;
    clearInterval(interval);
    try { saveState(paths.state_path, state); } catch { /* best-effort */ }
  };

  opts.registry.register({
    id: WATCHDOG_ID,
    kind: WATCHDOG_KIND,
    kill,
  });

  return {
    armed: true,
    config,
    kill,
    tickNow: () => {
      if (killed) return null;
      return tickOnce();
    },
    getState: () => state,
  };
}
