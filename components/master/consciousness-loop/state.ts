// components/master/consciousness-loop/state.ts
//
// Memory Init #7 — persistent state + audit log.
//
// Two on-disk artifacts:
//   1. state.json   — cognition state snapshot (last tick, hash, focus,
//                     suppressions). Atomically written on every tick.
//   2. audit.jsonl  — append-only audit trail, one JSON object per tick.
//                     Rotated to audit.jsonl.1 when audit_max_bytes is
//                     exceeded — only one historical generation kept,
//                     bounded disk usage.
//
// State writes use the standard write-temp-then-rename pattern so a
// crash mid-write can't leave a half-written JSON file that breaks
// the next boot.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  INITIAL_STATE,
  type AuditEntry,
  type CognitionState,
} from "./types";

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Load persisted state. Missing file or corrupt file → INITIAL_STATE
 * (we never let bad on-disk state crash the boot). Version mismatches
 * also reset — future migrations can land a real migration step here.
 */
export function loadState(statePath: string): CognitionState {
  if (!existsSync(statePath)) return { ...INITIAL_STATE };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { ...INITIAL_STATE };
  }
  if (!raw || typeof raw !== "object") return { ...INITIAL_STATE };
  const obj = raw as Partial<CognitionState>;
  if (obj.version !== 1) return { ...INITIAL_STATE };
  return {
    version: 1,
    last_tick_at: typeof obj.last_tick_at === "string" ? obj.last_tick_at : null,
    last_signal_hash:
      typeof obj.last_signal_hash === "string" ? obj.last_signal_hash : null,
    last_decision: obj.last_decision ?? null,
    recent_decisions: Array.isArray(obj.recent_decisions)
      ? obj.recent_decisions
      : [],
    suppressions:
      obj.suppressions && typeof obj.suppressions === "object"
        ? obj.suppressions
        : {},
    focus: typeof obj.focus === "string" ? obj.focus : null,
    tick_count: typeof obj.tick_count === "number" ? obj.tick_count : 0,
    last_followup_at:
      typeof obj.last_followup_at === "string" ? obj.last_followup_at : null,
  };
}

/** Atomically persist state. */
export function saveState(statePath: string, state: CognitionState): void {
  ensureDir(statePath);
  const tmp = statePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
}

/**
 * Append one audit entry, rotating if the file would exceed
 * `maxBytes`. Rotation keeps a single `.1` generation; older
 * material is discarded — the loop is bounded-resource by design.
 */
export function appendAudit(
  auditPath: string,
  entry: AuditEntry,
  maxBytes: number,
): void {
  ensureDir(auditPath);
  const line = JSON.stringify(entry) + "\n";
  if (existsSync(auditPath)) {
    try {
      const size = statSync(auditPath).size;
      if (size + line.length > maxBytes) {
        const rotated = auditPath + ".1";
        if (existsSync(rotated)) {
          try { unlinkSync(rotated); } catch { /* best-effort */ }
        }
        renameSync(auditPath, rotated);
      }
    } catch {
      // statSync failure is non-fatal — fall through to append.
    }
  }
  appendFileSync(auditPath, line);
}

/**
 * Read the tail of the audit log — last N entries, newest last.
 * Parses line-by-line and skips malformed lines (never throws on
 * partial writes from a crash). Returns [] when the file does not
 * exist.
 */
export function tailAudit(auditPath: string, n: number): AuditEntry[] {
  if (!existsSync(auditPath)) return [];
  let text: string;
  try {
    text = readFileSync(auditPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out: AuditEntry[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Test/teardown helper: forget any on-disk state under these paths. */
export function _wipeForTesting(paths: { state_path: string; audit_path: string }): void {
  for (const p of [paths.state_path, paths.audit_path, paths.audit_path + ".1"]) {
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
