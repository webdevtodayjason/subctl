// components/master/plan-approvals.ts
//
// v2.7.29 — Plan-approval workflow.
//
// Origin: The subctl orchestrator-mode protocol supports `plan_approval_request`
// from workers to their team lead. Until now the OPERATOR (Jason) couldn't
// see that exchange — the team lead was the only humanish actor in the
// loop, and any approval decision was opaque unless he happened to be
// staring at the tmux pane.
//
// This module gives the master daemon a pending-approvals queue so the
// dashboard's Plans tab and the master-bot's /plans command can both
// surface the request and let the operator approve/reject from anywhere.
//
// Storage:
//   • In-memory queue holds the live state every API/listener reads from.
//   • Append-only JSONL log at ~/.local/state/subctl/plan-approvals.jsonl
//     captures every state transition so we don't lose approvals on
//     daemon restart. The log is replayed on load() — last-write-wins per
//     id reconstructs the queue.
//
// Auto-expire: a pending entry older than `maxAgeMin` minutes (default
// 60) auto-rejects with feedback "auto-expired". Operator can re-request
// from the worker if they want another shot.
//
// IMPORTANT: never log `plan_body` to stderr at the default level — the
// body may include secrets or unredacted snippets the worker pasted in.
// We truncate to the first 80 chars of the summary in any console output.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type PendingApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export type DecidedBy = "operator" | "auto-timeout";

export interface PendingApproval {
  /** uuid v4 assigned by the master at recordApprovalRequest time. */
  id: string;
  /** worker's original request_id (echoed in plan_approval_response). */
  request_id: string;
  /** worker name as the worker self-identifies (e.g. "profiles-impl"). */
  worker_name: string;
  /** tmux session / team identifier the worker belongs to. */
  team_id: string;
  /** Short title (≤120 chars; truncated with ellipsis). */
  plan_summary: string;
  /** Full plan text as the worker sent it. May contain secrets — handle with care. */
  plan_body: string;
  /** ISO-8601. */
  created_at: string;
  status: PendingApprovalStatus;
  /** ISO-8601, set when status leaves "pending". */
  decided_at?: string;
  decided_by?: DecidedBy;
  /** Operator's reject reason (or "auto-expired" for timeouts). */
  feedback?: string;
}

export interface RecordApprovalRequestInput {
  request_id: string;
  worker_name: string;
  team_id: string;
  plan_summary: string;
  plan_body: string;
  /** Optional override (mostly for tests). Defaults to `new Date().toISOString()`. */
  created_at?: string;
  /** Optional override id (mostly for tests). Defaults to a fresh uuid. */
  id?: string;
}

// ─── persistence config ────────────────────────────────────────────────────
//
// Honors XDG_STATE_HOME, falling back to ~/.local/state. Per the spec, the
// canonical log path is ~/.local/state/subctl/plan-approvals.jsonl.
const _stateRoot =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const DEFAULT_LOG_PATH = join(_stateRoot, "subctl", "plan-approvals.jsonl");

let _logPath: string = DEFAULT_LOG_PATH;
const _queue = new Map<string, PendingApproval>();
let _loaded = false;

/**
 * Override the on-disk log path. Tests use this to redirect the log into
 * a tmp dir so production state isn't touched. Pass null to restore the
 * default. Implicitly resets the in-memory queue + load flag — next
 * recordApprovalRequest / listPending replays from the new path.
 */
export function setLogPathForTesting(path: string | null): void {
  _logPath = path ?? DEFAULT_LOG_PATH;
  _queue.clear();
  _loaded = false;
}

export function getLogPath(): string {
  return _logPath;
}

function ensureLogDir(): void {
  try {
    mkdirSync(dirname(_logPath), { recursive: true });
  } catch {
    /* best-effort; the appendFileSync call will surface the real error */
  }
}

function appendLog(entry: PendingApproval): void {
  ensureLogDir();
  try {
    appendFileSync(_logPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Last-resort: log the failure (without plan_body) so the operator
    // can see the queue is degraded. Don't throw — the in-memory state
    // is still authoritative for the current process.
    console.error(
      `[plan-approvals] append failed (${entry.id}): ${(err as Error).message}`,
    );
  }
}

function loadFromDisk(): void {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(_logPath)) return;
  let raw: string;
  try {
    raw = readFileSync(_logPath, "utf8");
  } catch (err) {
    console.error(
      `[plan-approvals] read failed (${_logPath}): ${(err as Error).message}`,
    );
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: PendingApproval;
    try {
      entry = JSON.parse(trimmed) as PendingApproval;
    } catch {
      continue;
    }
    if (!entry.id) continue;
    // Last-write-wins replay. The log is append-only so the LAST occurrence
    // of an id is the freshest state.
    _queue.set(entry.id, entry);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Record an incoming plan_approval_request from a worker. Returns the
 * materialized PendingApproval (which the caller can use to drive the
 * notification + downstream side effects).
 */
export function recordApprovalRequest(
  input: RecordApprovalRequestInput,
): PendingApproval {
  loadFromDisk();
  const now = input.created_at ?? new Date().toISOString();
  const id = input.id ?? randomUUID();
  const entry: PendingApproval = {
    id,
    request_id: input.request_id,
    worker_name: input.worker_name,
    team_id: input.team_id,
    plan_summary: truncate(input.plan_summary.trim() || "(no summary)", 120),
    plan_body: input.plan_body,
    created_at: now,
    status: "pending",
  };
  _queue.set(id, entry);
  appendLog(entry);
  return { ...entry };
}

/** Snapshot of currently pending approvals (oldest-first). */
export function listPending(): PendingApproval[] {
  loadFromDisk();
  const out: PendingApproval[] = [];
  for (const entry of _queue.values()) {
    if (entry.status === "pending") out.push({ ...entry });
  }
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

/** Snapshot of recently-decided approvals (newest-first), capped at `limit`. */
export function listDecided(limit = 20): PendingApproval[] {
  loadFromDisk();
  const out: PendingApproval[] = [];
  for (const entry of _queue.values()) {
    if (entry.status !== "pending") out.push({ ...entry });
  }
  out.sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Look up one approval by id. Returns a copy so callers can't mutate
 * the live record.
 */
export function getApproval(id: string): PendingApproval | null {
  loadFromDisk();
  const entry = _queue.get(id);
  return entry ? { ...entry } : null;
}

class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly code: "not-found" | "not-pending",
  ) {
    super(message);
  }
}

function transition(
  id: string,
  next: Exclude<PendingApprovalStatus, "pending">,
  decided_by: DecidedBy,
  feedback: string | undefined,
): PendingApproval {
  loadFromDisk();
  const entry = _queue.get(id);
  if (!entry) {
    throw new ApprovalError(`no approval with id ${id}`, "not-found");
  }
  if (entry.status !== "pending") {
    // Idempotent race-guard: a second concurrent approve/reject must NOT
    // overwrite a prior decision. The first writer wins; the second sees
    // a "not-pending" error and the caller surfaces the existing state.
    throw new ApprovalError(
      `approval ${id} already ${entry.status}`,
      "not-pending",
    );
  }
  const updated: PendingApproval = {
    ...entry,
    status: next,
    decided_at: new Date().toISOString(),
    decided_by,
  };
  if (feedback !== undefined) updated.feedback = feedback;
  _queue.set(id, updated);
  appendLog(updated);
  return { ...updated };
}

/**
 * Operator approves the request. Throws ApprovalError when the id is
 * unknown or the entry is no longer pending.
 */
export function approveRequest(id: string): PendingApproval {
  return transition(id, "approved", "operator", undefined);
}

/**
 * Operator rejects the request with feedback (used as the worker-facing
 * reason). Empty feedback is allowed but discouraged — the worker should
 * know why so it can revise.
 */
export function rejectRequest(id: string, feedback: string): PendingApproval {
  return transition(id, "rejected", "operator", feedback);
}

/**
 * Auto-expire pending entries older than `maxAgeMin` minutes. Returns the
 * number of entries flipped. Default threshold matches the spec (60 min).
 * Idempotent — only PENDING entries are touched, so calling this twice in
 * a row leaves the second call as a no-op.
 */
export function expireOldRequests(maxAgeMin = 60): number {
  loadFromDisk();
  const now = Date.now();
  const cutoff = now - maxAgeMin * 60_000;
  let n = 0;
  for (const entry of _queue.values()) {
    if (entry.status !== "pending") continue;
    const created = Date.parse(entry.created_at);
    if (Number.isFinite(created) && created < cutoff) {
      const updated: PendingApproval = {
        ...entry,
        status: "expired",
        decided_at: new Date().toISOString(),
        decided_by: "auto-timeout",
        feedback: "auto-expired",
      };
      _queue.set(entry.id, updated);
      appendLog(updated);
      n++;
    }
  }
  return n;
}

/**
 * Test/teardown helper. Clears the in-memory queue (does NOT touch the
 * log file). Pair with setLogPathForTesting() to fully isolate.
 */
export function _resetForTesting(): void {
  _queue.clear();
  _loaded = false;
}

export { ApprovalError };
