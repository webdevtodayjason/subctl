// components/evy/consciousness-loop/config.ts
//
// Memory Init #7 — config loader for the Evy cognition loop.
//
// Disabled by default. The on-disk config lives at
// `${SUBCTL_CONFIG_DIR or ~/.config/subctl}/master/consciousness-loop.json`.
// Missing file → defaults (disabled). Parse error → defaults (disabled)
// — never block boot just because the operator hasn't authored this
// file or corrupted it manually. Field-level merge: any key the file
// omits inherits the default, so partial files don't accidentally
// arm the loop.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, type CognitionLoopConfig } from "./types";

function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}

export function defaultConfigPath(): string {
  return join(subctlConfigDir(), "evy", "consciousness-loop.json");
}

export function defaultStatePath(): string {
  return join(subctlConfigDir(), "evy", "consciousness-loop", "state.json");
}

export function defaultAuditPath(): string {
  return join(subctlConfigDir(), "evy", "consciousness-loop", "audit.jsonl");
}

/**
 * Read the cognition-loop config from disk. On any failure returns
 * DEFAULT_CONFIG (disabled). Field-level merge means partial files
 * inherit defaults — but a partial file with `enabled: true` and
 * nothing else still enables the loop.
 */
export function loadConfig(path?: string): CognitionLoopConfig {
  const p = path ?? defaultConfigPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  let raw: Partial<CognitionLoopConfig>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CognitionLoopConfig>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const merged: CognitionLoopConfig = {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    tick_interval_ms:
      typeof raw.tick_interval_ms === "number" && raw.tick_interval_ms > 0
        ? raw.tick_interval_ms
        : DEFAULT_CONFIG.tick_interval_ms,
    audit_max_bytes:
      typeof raw.audit_max_bytes === "number" && raw.audit_max_bytes > 0
        ? raw.audit_max_bytes
        : DEFAULT_CONFIG.audit_max_bytes,
    suppression_window_ms:
      typeof raw.suppression_window_ms === "number" && raw.suppression_window_ms >= 0
        ? raw.suppression_window_ms
        : DEFAULT_CONFIG.suppression_window_ms,
    followup_throttle_ms:
      typeof raw.followup_throttle_ms === "number" && raw.followup_throttle_ms >= 0
        ? raw.followup_throttle_ms
        : DEFAULT_CONFIG.followup_throttle_ms,
    recent_decisions_keep:
      typeof raw.recent_decisions_keep === "number" && raw.recent_decisions_keep > 0
        ? Math.floor(raw.recent_decisions_keep)
        : DEFAULT_CONFIG.recent_decisions_keep,
    state_path: typeof raw.state_path === "string" ? raw.state_path : null,
    audit_path: typeof raw.audit_path === "string" ? raw.audit_path : null,
  };
  return merged;
}

/** Resolve concrete paths, applying overrides if set. */
export function resolvePaths(cfg: CognitionLoopConfig): {
  state_path: string;
  audit_path: string;
} {
  return {
    state_path: cfg.state_path ?? defaultStatePath(),
    audit_path: cfg.audit_path ?? defaultAuditPath(),
  };
}
