// components/master/tier1-candidates.ts
//
// Memory Consciousness Cycle — Phase 3 Tier 1 candidate queue.
//
// When the memory kernel's reviewer returns `action: "propose_tier1"`, the
// candidate is appended here for operator (or Evy) review instead of being
// silently dropped. Approval routes through the existing Tier 1 path
// (memory_remember, which honors the char-budget guardrails); rejection
// just resolves the record.
//
// Storage: ~/.config/subctl/master/tier1-candidates.jsonl — append-only.
// Resolution is recorded by appending a NEW line with resolution set; the
// original "pending" line stays in the file. Read paths dedupe by id and
// keep the latest line, so the most recent resolution wins.
//
// All side-effect surfaces are deps-injectable so tests run hermetic
// against a tmp file and a mocked writeTier1 callback.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── public types ─────────────────────────────────────────────────────────

export type Tier1CandidateResolution = "pending" | "approved" | "rejected";
export type Tier1CandidateResolver =
  | "operator"
  | "evy"
  | "auto-expired";

export interface Tier1Candidate {
  /** `c_<base36-time>_<8hex>` — collision-resistant, sort-stable by proposed_at. */
  id: string;
  /** ISO timestamp of the original proposal. Stable across re-appends. */
  proposed_at: string;
  /** Raw Tier 3 event IDs the reviewer cited. */
  source_event_ids: string[];
  /** Proposed durable fact to land in memory.md. One concise sentence. */
  memory: string;
  /** Reviewer's kind label ("preference" | "decision" | …). */
  kind: string;
  /** Reviewer rationale. */
  reason: string;
  /** Reviewer confidence (0..1). */
  confidence: number;
  /** "<provider>/<model>" of the supervisor that proposed this. */
  reviewer_model: string;
  /** Current state. `listPending` filters to "pending" only. */
  resolution: Tier1CandidateResolution;
  resolved_at?: string;
  resolved_by?: Tier1CandidateResolver;
  resolution_note?: string;
}

export interface AppendCandidateInput {
  source_event_ids: string[];
  memory: string;
  kind: string;
  reason: string;
  confidence: number;
  reviewer_model: string;
}

export interface ResolveOpts {
  /** Defaults to "operator" — the master tool layer overrides for Evy. */
  resolved_by?: Tier1CandidateResolver;
  note?: string;
}

export interface Tier1WriteResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export type WriteTier1Fn = (
  text: string,
  kind: string,
) => Promise<Tier1WriteResult>;

export interface ApproveResult {
  ok: boolean;
  error?: string;
  candidate?: Tier1Candidate;
  /** Whatever the injected writeTier1 returned on success. */
  tier1_entry?: Tier1WriteResult;
}

export interface RejectResult {
  ok: boolean;
  error?: string;
  candidate?: Tier1Candidate;
}

// ─── deps surface ─────────────────────────────────────────────────────────

interface Tier1CandidatesDeps {
  /** Absolute path to the JSONL log. */
  candidatesPath: string;
  /** Callback wired by the tools layer to invoke memory_remember. */
  writeTier1: WriteTier1Fn;
  /** Clock seam — tests pin a fixed Date. */
  now: () => Date;
}

const DEFAULT_PATH = join(
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
  "master",
  "tier1-candidates.jsonl",
);

const realDeps: Tier1CandidatesDeps = {
  candidatesPath: DEFAULT_PATH,
  // Default is a tripwire — production wires this at module load via
  // configureWriteTier1() from components/master/tools/tier1-memory.ts. If
  // approve fires before that wiring, this surfaces a clear error instead
  // of silently dropping the approval.
  writeTier1: async () => ({
    ok: false,
    error: "writeTier1 not wired (tools/tier1-memory.ts should call configureWriteTier1 at module load)",
  }),
  now: () => new Date(),
};

let deps: Tier1CandidatesDeps = { ...realDeps };

/** Production wiring entry-point. Called from tools/tier1-memory.ts. */
export function configureWriteTier1(fn: WriteTier1Fn): void {
  deps.writeTier1 = fn;
}

/** Hermetic override for unit tests. Partial — merges over current deps. */
export function _setDepsForTesting(partial: Partial<Tier1CandidatesDeps>): void {
  deps = { ...realDeps, ...deps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = { ...realDeps };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return `c_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function readAllRows(): Tier1Candidate[] {
  if (!existsSync(deps.candidatesPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(deps.candidatesPath, "utf8");
  } catch {
    return [];
  }
  const out: Tier1Candidate[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Tier1Candidate;
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.id === "string" &&
        typeof obj.resolution === "string"
      ) {
        out.push(obj);
      }
    } catch {
      // skip malformed line — append-only log is best-effort durable
    }
  }
  return out;
}

/** Reduce rows to the latest record per id (last write wins). */
function dedupeLatest(rows: Tier1Candidate[]): Tier1Candidate[] {
  const byId = new Map<string, Tier1Candidate>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()];
}

function appendLine(rec: Tier1Candidate): void {
  mkdirSync(dirname(deps.candidatesPath), { recursive: true });
  appendFileSync(deps.candidatesPath, JSON.stringify(rec) + "\n");
}

// ─── public API ───────────────────────────────────────────────────────────

/**
 * Append a new pending candidate. Returns the persisted record so the
 * caller can log its id alongside the kernel cycle's other counters.
 */
export function appendCandidate(input: AppendCandidateInput): Tier1Candidate {
  const rec: Tier1Candidate = {
    id: generateId(),
    proposed_at: deps.now().toISOString(),
    source_event_ids: [...input.source_event_ids],
    memory: input.memory,
    kind: input.kind,
    reason: input.reason,
    confidence: input.confidence,
    reviewer_model: input.reviewer_model,
    resolution: "pending",
  };
  appendLine(rec);
  return rec;
}

/** All known candidates, deduped to latest resolution per id. */
export function listAll(): Tier1Candidate[] {
  return dedupeLatest(readAllRows());
}

/** Candidates whose latest resolution is "pending". */
export function listPending(): Tier1Candidate[] {
  return listAll().filter((c) => c.resolution === "pending");
}

/** Look up a candidate by id; returns null if absent. */
export function getCandidate(id: string): Tier1Candidate | null {
  return listAll().find((c) => c.id === id) ?? null;
}

/**
 * Approve a pending candidate. Calls the injected writeTier1 first — only
 * persists the approval line if the Tier 1 write succeeded, so a failed
 * char-budget check (or any other guardrail) leaves the candidate pending
 * for re-try.
 */
export async function approveCandidate(
  id: string,
  opts: ResolveOpts = {},
): Promise<ApproveResult> {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, error: `candidate not found: ${id}` };
  if (existing.resolution !== "pending") {
    return {
      ok: false,
      error: `candidate already ${existing.resolution}: ${id}`,
      candidate: existing,
    };
  }
  let tier1Result: Tier1WriteResult;
  try {
    tier1Result = await deps.writeTier1(existing.memory, existing.kind);
  } catch (err) {
    return {
      ok: false,
      error: `writeTier1 threw: ${(err as Error).message}`,
      candidate: existing,
    };
  }
  if (!tier1Result.ok) {
    return {
      ok: false,
      error: `tier1 write failed: ${tier1Result.error ?? "unknown"}`,
      candidate: existing,
      tier1_entry: tier1Result,
    };
  }
  const resolved: Tier1Candidate = {
    ...existing,
    resolution: "approved",
    resolved_at: deps.now().toISOString(),
    resolved_by: opts.resolved_by ?? "operator",
  };
  if (opts.note !== undefined && opts.note !== "") {
    resolved.resolution_note = opts.note;
  }
  appendLine(resolved);
  return { ok: true, candidate: resolved, tier1_entry: tier1Result };
}

/**
 * Reject a pending candidate. Does NOT touch Tier 1 — just appends a
 * resolution=rejected line so the candidate disappears from listPending.
 */
export function rejectCandidate(
  id: string,
  opts: ResolveOpts = {},
): RejectResult {
  const existing = getCandidate(id);
  if (!existing) return { ok: false, error: `candidate not found: ${id}` };
  if (existing.resolution !== "pending") {
    return {
      ok: false,
      error: `candidate already ${existing.resolution}: ${id}`,
      candidate: existing,
    };
  }
  const resolved: Tier1Candidate = {
    ...existing,
    resolution: "rejected",
    resolved_at: deps.now().toISOString(),
    resolved_by: opts.resolved_by ?? "operator",
  };
  if (opts.note !== undefined && opts.note !== "") {
    resolved.resolution_note = opts.note;
  }
  appendLine(resolved);
  return { ok: true, candidate: resolved };
}
