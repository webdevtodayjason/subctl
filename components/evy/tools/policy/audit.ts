// components/evy/tools/policy/audit.ts
//
// JSONL audit-log appender + size-based rotator for the policy engine.
// Pack 09 §2/§3/§4/§5 + HANDOFF_DIGEST D7 Q5.
//
// Path: ~/.local/state/subctl/audit/<team_id>.jsonl  (honors SUBCTL_STATE_DIR)
//
// Three event_type discriminants are written by this module:
//   - "header"              — emitted by writeAuditHeader at spawn time.
//   - "check"               — emitted by the policy-check hot path; we expose
//                             the generic appendAuditEntry for that.
//   - "verifier_correction" — emitted by writeVerifierCorrection when the
//                             master's denial-cluster detector fires (D8 in
//                             HANDOFF_DIGEST; PR 6.5 will be its caller).
//
// Concurrency: per pack 09 §4, lines are written with O_APPEND|O_WRONLY|O_CREAT
// in a single write() syscall. POSIX guarantees writes <PIPE_BUF (typically
// 4 KB) appended to the same fd from concurrent processes don't tear. Our
// lines are well below 4 KB, so concurrent workers emitting audit lines to
// the same file do not interleave bytes.
//
// Failure semantics (pack 09 §4): if the audit write fails (disk full,
// permission denied, parent dir unwritable), we DO NOT throw. The policy
// check decision must still propagate. We bump a counter so an operator-facing
// metric can surface "audit is silently dropping" rather than the worker
// silently producing decisions with no trail. PR 11 wires the counter into
// the dashboard's metrics surface.
//
// Rotation (pack 09 §5): at 50 MB the active log rotates. 3 generations are
// kept. Race-protected via an advisory lockfile so concurrent workers don't
// double-rotate. If a worker can't acquire the lock, it skips rotation this
// turn — let the holder do it — and just appends to the (slightly oversize)
// active log. Rotation is checked on every write but a stat call is cheap.

import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditEntry, Mode } from "./types";

// ---------------------------------------------------------------------------
// Path resolution — same convention as snapshot.ts + policy_audit_tail.ts
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const override = process.env.SUBCTL_STATE_DIR;
  return override ?? join(homedir(), ".local", "state", "subctl");
}

function resolveAuditDir(): string {
  return join(resolveStateDir(), "audit");
}

/** Deterministic path to a team's active audit log. */
export function getAuditLogPath(teamId: string): string {
  return join(resolveAuditDir(), `${teamId}.jsonl`);
}

function getLockPath(teamId: string): string {
  return join(resolveAuditDir(), `${teamId}.rotate.lock`);
}

// ---------------------------------------------------------------------------
// Rotation threshold (mutable for tests; production stays at 50 MB)
// ---------------------------------------------------------------------------

const PRODUCTION_ROTATION_THRESHOLD = 50 * 1024 * 1024; // 50 MB per pack 09 §5
let rotationThreshold = PRODUCTION_ROTATION_THRESHOLD;

/**
 * Test-only hook: lower the rotation threshold so tests don't have to write
 * 50 MB to exercise the rotation path. Production callers MUST NOT call this.
 */
export function setRotationThresholdForTest(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error("setRotationThresholdForTest: bytes must be a positive finite number");
  }
  rotationThreshold = bytes;
}

export function resetRotationThresholdForTest(): void {
  rotationThreshold = PRODUCTION_ROTATION_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Failure counter (pack 09 §4 — best-effort signaling)
// ---------------------------------------------------------------------------

/**
 * Per-team running tally of audit-write failures. Exported so the dashboard
 * (PR 11) and operator metrics can read it. Module-level mutable state is
 * acceptable here — pack 09 §4 explicitly specifies a counter, and the audit
 * subsystem is single-process per master daemon.
 */
export const auditWriteFailures = new Map<string, number>();

function recordWriteFailure(teamId: string): void {
  auditWriteFailures.set(teamId, (auditWriteFailures.get(teamId) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Check whether the active log has exceeded the rotation threshold; if so,
 * rotate atomically under a lockfile. Returns `{rotated: true, sizeBefore}`
 * iff this call performed the rotation. Returns `{rotated: false}` when:
 *
 *   - the file doesn't exist yet (nothing to rotate)
 *   - the file is under threshold
 *   - another worker holds the rotation lock right now (its rotate will
 *     handle it; this worker proceeds to write against the still-active log)
 *
 * Rotation is `mv .jsonl.3 -> deleted` then shift 2→3, 1→2, .jsonl→.jsonl.1,
 * then create an empty .jsonl. Per pack 09 §5.
 *
 * The lockfile is created via `openSync(lockPath, "wx")` (O_EXCL semantics) —
 * the simplest portable advisory lock that works on macOS+Linux. We unlink it
 * before returning. If a previous process crashed mid-rotation and left a
 * stale lockfile, we tolerate it via a 30s age cutoff (stale → take over).
 */
export async function rotateAuditLogIfNeeded(
  teamId: string,
): Promise<{ rotated: boolean; sizeBefore?: number }> {
  if (!teamId) throw new Error("rotateAuditLogIfNeeded: teamId is required");

  const auditDir = resolveAuditDir();
  const active = getAuditLogPath(teamId);

  if (!existsSync(active)) return { rotated: false };

  let size: number;
  try {
    size = statSync(active).size;
  } catch {
    return { rotated: false };
  }

  if (size < rotationThreshold) return { rotated: false };

  mkdirSync(auditDir, { recursive: true });
  const lockPath = getLockPath(teamId);
  let lockFd: number | null = null;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    // EEXIST — another worker is rotating right now (or a stale lock).
    // Take over if it's >30s old.
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > 30_000) {
        try { unlinkSync(lockPath); } catch { /* race lost */ }
        try { lockFd = openSync(lockPath, "wx"); } catch { lockFd = null; }
      }
    } catch {
      // lockfile vanished between EEXIST and stat — that's fine, retry once.
      try { lockFd = openSync(lockPath, "wx"); } catch { lockFd = null; }
    }
    if (lockFd === null) return { rotated: false };
  }

  try {
    const gen1 = `${active}.1`;
    const gen2 = `${active}.2`;
    const gen3 = `${active}.3`;

    // Re-stat under the lock; another rotator may have just finished and the
    // file is already small. Skip in that case.
    let sizeUnderLock: number;
    try {
      sizeUnderLock = statSync(active).size;
    } catch {
      sizeUnderLock = 0;
    }
    if (sizeUnderLock < rotationThreshold) {
      return { rotated: false };
    }

    if (existsSync(gen3)) {
      try { unlinkSync(gen3); } catch { /* best effort */ }
    }
    if (existsSync(gen2)) {
      try { renameSync(gen2, gen3); } catch { /* best effort */ }
    }
    if (existsSync(gen1)) {
      try { renameSync(gen1, gen2); } catch { /* best effort */ }
    }
    renameSync(active, gen1);
    // Recreate the empty active file so concurrent writers' O_APPEND opens
    // land on a valid descriptor rather than racing the next create.
    writeFileSync(active, "", { mode: 0o644 });
    return { rotated: true, sizeBefore: sizeUnderLock };
  } finally {
    if (lockFd !== null) {
      try { closeSync(lockFd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one entry to the team's audit log. Fail-open per pack 09 §4 — never
 * throws to the caller. The check decision must propagate even if the audit
 * write fails. Failures bump `auditWriteFailures[teamId]` for operator
 * visibility.
 *
 * Implementation:
 *   1. Check rotation first (cheap stat). If at threshold and the lock can be
 *      acquired, rotate before writing.
 *   2. Open the active log with O_APPEND|O_WRONLY|O_CREAT (Node mode "a").
 *   3. One writeSync() with JSON.stringify(entry) + "\n".
 *   4. closeSync().
 *
 * The single writeSync ensures POSIX atomicity for lines < PIPE_BUF (~4 KB).
 * If a future caller pushes much longer command strings we'd need a different
 * strategy, but at v2.7.0 command lines are short.
 */
export async function appendAuditEntry(teamId: string, entry: AuditEntry): Promise<void> {
  if (!teamId) {
    // Not a write failure — a programming error. But still don't throw out of
    // the audit subsystem since callers depend on fail-open. Surface via the
    // counter under a sentinel id.
    recordWriteFailure("<no-team-id>");
    return;
  }

  try {
    await rotateAuditLogIfNeeded(teamId);
  } catch {
    // Rotation problems must not block the write either. The active log will
    // just grow past threshold until a later writer succeeds.
  }

  let line: string;
  try {
    line = JSON.stringify(entry) + "\n";
  } catch (err) {
    // JSON encoding failure (e.g. a circular structure snuck in). Surface
    // through the counter and bail.
    recordWriteFailure(teamId);
    return;
  }

  const auditDir = resolveAuditDir();
  const path = getAuditLogPath(teamId);

  let fd: number | null = null;
  try {
    mkdirSync(auditDir, { recursive: true });
    fd = openSync(path, "a", 0o644);
    writeSync(fd, line);
  } catch {
    recordWriteFailure(teamId);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Write the spawn-time header line. Marks a session boundary in the log so
 * readers can group entries (pack 09 §3.1). Allowed-by-spawn so decision
 * is "allow", rule is "spawn", command is empty.
 */
export async function writeAuditHeader(
  teamId: string,
  mode: Mode,
  allowlistSha: string,
): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    team_id: teamId,
    mode,
    allowlist_sha: allowlistSha,
    command: "",
    decision: "allow",
    rule: "spawn",
    event_type: "header",
  };
  await appendAuditEntry(teamId, entry);
}

/**
 * Write a verifier-correction line (D8 in HANDOFF_DIGEST). PR 6.5 will be the
 * caller; this writer lands now so the format is locked when the verifier
 * lands. Decision is "deny" because corrections are about denials clustered
 * on the worker; command is empty because the correction is meta — it's
 * about the pattern, not a single command.
 */
export async function writeVerifierCorrection(
  teamId: string,
  rule: string,
  mode: Mode,
  allowlistSha: string,
): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    team_id: teamId,
    mode,
    allowlist_sha: allowlistSha,
    command: "",
    decision: "deny",
    rule,
    event_type: "verifier_correction",
  };
  await appendAuditEntry(teamId, entry);
}
