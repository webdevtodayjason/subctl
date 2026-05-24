// components/master/memori-client.ts
//
// v2.8.10 — Memori HTTP client (Memory Init #3, Phase 3a).
//
// Why a sidecar and not the @memorilabs/memori npm package:
//   - The TS SDK (v0.0.11 as of 2026-05-16) is CLOUD-ONLY and requires
//     `openai` or `@anthropic-ai/sdk` as peer dependencies to intercept
//     chat.completions.create. Subctl-master is pi-agent-core, not a
//     direct OpenAI client, so the interception model doesn't fit.
//   - BYODB (which the operator picked at Knot #2) is **Python-only**
//     per memorilabs.ai/docs/memori-byodb/.
//   - We therefore mirror the Cognee pattern: stand Memori up as a
//     local Python HTTP sidecar (services/memori/server.py + a launchd
//     plist) and have master talk to it via fetch.
//
// Custody trade-off worth surfacing (operator-side decision):
//   - BYODB controls where MEMORY RECORDS live (SQLite ✓).
//   - Memori's "Advanced Augmentation" (the LoCoMo 81.95% number)
//     runs server-side at memorilabs.ai via MEMORI_API_KEY. Even with
//     BYODB, conversation content flows there for processing.
//   - If the operator's goal is "no conversation content ever leaves
//     this hardware," the sidecar needs to disable augmentation, OR
//     accept that local-record + cloud-augmentation is the compromise.
//
// Phase 3a scope: contract + client + health gate + tests. The actual
// sidecar (server.py + plist) lands in Phase 3b. evy_remember /
// evy_recall substrate swap lands in Phase 3c.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSecret } from "./secrets";

// ─── types ─────────────────────────────────────────────────────────────────

export interface MemoriCaptureInput {
  /** Entity scope — typically the operator id. */
  entity_id: string;
  /** Process scope — typically "evy-master", "claude-code-worker", etc. */
  process_id: string;
  /** Session id; auto-managed if omitted. */
  session_id?: string;
  /** The turn payload — operator text, assistant reply, tool calls, etc. */
  turn: {
    /** Operator's input, redacted of secrets where applicable. */
    user_text?: string;
    /** Assistant's reply text. */
    assistant_text?: string;
    /** Tool calls invoked this turn, with their args + outputs. */
    tool_calls?: Array<{
      name: string;
      args: Record<string, unknown>;
      result: unknown;
      ok: boolean;
      duration_ms?: number;
    }>;
    /** Operator-visible decisions surfaced this turn. */
    decisions?: Array<{
      action: string;
      rationale: string;
    }>;
    /** Outcomes (succeeded / failed / blocked etc.) */
    outcomes?: Array<{
      kind: "succeeded" | "failed" | "blocked" | "deferred";
      detail: string;
    }>;
  };
  /** Optional free-form metadata bag (provenance, source, project). */
  metadata?: Record<string, unknown>;
  /** Capture timestamp (ISO). Server may override. */
  ts?: string;
}

export interface MemoriRecallInput {
  entity_id: string;
  process_id?: string;
  session_id?: string;
  query: string;
  /** Max hits. */
  top_k?: number;
  /** Optional time window. */
  since?: string;
  until?: string;
}

export interface MemoriHit {
  id: string;
  text: string;
  score?: number;
  ts?: string;
  kind?:
    | "conversation"
    | "tool_call"
    | "decision"
    | "outcome"
    | "fact"
    | "preference"
    | "rule"
    | "skill"
    | "relationship";
  metadata?: Record<string, unknown>;
}

export interface MemoriHealth {
  reachable: boolean;
  url: string;
  latency_ms: number | null;
  version: string | null;
  /** Active DB (sqlite | postgres | mysql | ... when sidecar exposes it). */
  database: string | null;
  /** Number of memories — best effort; null if sidecar doesn't expose. */
  total_memories: number | null;
  /**
   * Raw events not yet reviewed by the memory-kernel reviewer.
   * Null when the sidecar predates Memory Init #5.
   */
  total_unreviewed: number | null;
  /**
   * Promoted curated memories (the survivors of the consciousness cycle).
   * Null when the sidecar predates Memory Init #5.
   */
  total_curated: number | null;
  auth_status: "ok" | "missing_token" | "rejected" | "n/a";
  error: string | null;
}

/**
 * Review-state lifecycle for raw events flowing through the memory-kernel.
 * Mirrors VALID_REVIEW_STATES in services/memori/server.py.
 */
export type MemoriReviewState =
  | "unreviewed"
  | "reviewed"
  | "promoted"
  | "discarded"
  | "escalated";

export interface MemoriUnreviewedEvent {
  id: string;
  ts: string;
  user_text: string | null;
  assistant_text: string | null;
  tool_calls_json: string | null;
  decisions_json: string | null;
  outcomes_json: string | null;
  metadata_json: string | null;
  review_state: MemoriReviewState;
}

export interface MemoriSelectUnreviewedInput {
  entity_id: string;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** Max events returned. Server clamps to [1, 200], default 50. */
  limit?: number;
}

export interface MemoriMarkReviewedInput {
  ids: string[];
  review_state: MemoriReviewState;
  reviewer_model?: string;
  reason?: string;
  confidence?: number;
  /** Optional override; server defaults to "now". */
  reviewed_at?: string;
}

export interface MemoriPromoteInput {
  entity_id: string;
  source_ids: string[];
  memory: string;
  kind?: string;
  reason?: string;
  confidence?: number;
  reviewer_model?: string;
}

export type MemoriResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// ─── config + secret resolution ────────────────────────────────────────────

// Default sidecar port — chosen to not collide with claude-mem (37701),
// cognee (8745), TTS (8789), master (8788), or dashboard (8787).
const DEFAULT_URL = "http://127.0.0.1:8746";
const DEFAULT_TIMEOUT_MS = 10_000;

function configPath(): string {
  const home = process.env.HOME ?? "/tmp";
  const cfg = process.env.SUBCTL_CONFIG_DIR ?? join(home, ".config", "subctl");
  return join(cfg, "memori.json");
}

export function resolveMemoriUrl(): string {
  const fromEnv = process.env.MEMORI_SERVICE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  try {
    const path = configPath();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        url?: string;
      };
      if (typeof parsed?.url === "string" && parsed.url.trim()) {
        return parsed.url.trim().replace(/\/+$/, "");
      }
    }
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_URL;
}

/** Distinct from MEMORI_API_KEY (cloud augmentation); this gates the SIDECAR. */
export function resolveMemoriAuthToken(): string | null {
  return resolveSecret("memori_api_key");
}

// ─── injectable side-effect surface (for tests) ────────────────────────────

interface Deps {
  fetcher: typeof fetch;
  resolveUrl: () => string;
  resolveToken: () => string | null;
  timeoutMs: number;
}

const realDeps: Deps = {
  fetcher: (url, init) => globalThis.fetch(url, init),
  resolveUrl: resolveMemoriUrl,
  resolveToken: resolveMemoriAuthToken,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── HTTP helper (mirrors cognee-client.ts shape for consistency) ──────────

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<MemoriResult<T>> {
  const baseUrl = deps.resolveUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const token = deps.resolveToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const controller = new AbortController();
  const t = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? deps.timeoutMs,
  );
  let response: Response;
  try {
    response = await deps.fetcher(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: isAbort
        ? `memori request timed out (${opts.timeoutMs ?? deps.timeoutMs}ms)`
        : `memori transport: ${msg}`,
    };
  }
  clearTimeout(t);
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `memori HTTP ${response.status}: ${text.slice(0, 400)}`,
    };
  }
  if (!text) return { ok: true, data: undefined as unknown as T };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      error: `memori response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ─── public client ─────────────────────────────────────────────────────────

/** Probe the Memori sidecar; gate-driver for TOOL_GATES.memori. */
export async function health(): Promise<MemoriHealth> {
  const url = deps.resolveUrl();
  const token = deps.resolveToken();
  const t0 = Date.now();
  const r = await request<{
    version?: string;
    database?: string;
    total_memories?: number;
    total_unreviewed?: number;
    total_curated?: number;
  }>("/health");
  const elapsed = Date.now() - t0;
  if (r.ok) {
    return {
      reachable: true,
      url,
      latency_ms: elapsed,
      version: r.data?.version ?? null,
      database: r.data?.database ?? null,
      total_memories: r.data?.total_memories ?? null,
      total_unreviewed: r.data?.total_unreviewed ?? null,
      total_curated: r.data?.total_curated ?? null,
      auth_status: token ? "ok" : "n/a",
      error: null,
    };
  }
  const isAuthRejected = r.status === 401 || r.status === 403;
  return {
    reachable: false,
    url,
    latency_ms: null,
    version: null,
    database: null,
    total_memories: null,
    total_unreviewed: null,
    total_curated: null,
    auth_status: isAuthRejected
      ? "rejected"
      : token
        ? "ok"
        : "missing_token",
    error: r.error,
  };
}

/**
 * Persist a turn into Memori. Mirrors the Python SDK's auto-capture
 * shape but exposed as an explicit POST so master controls timing
 * (after agent_end + after egress redaction).
 */
export async function capture(
  input: MemoriCaptureInput,
): Promise<MemoriResult<{ id: string | null }>> {
  return request<{ id?: string | null }>("/capture", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { id: r.data?.id ?? null } };
  });
}

/** Recall relevant memories for an entity/process/query. */
export async function recall(
  input: MemoriRecallInput,
): Promise<MemoriResult<{ hits: MemoriHit[] }>> {
  return request<{ hits?: MemoriHit[] }>("/recall", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { hits: r.data?.hits ?? [] } };
  });
}

/** Forget a memory by id, or wipe an entity/process scope. Destructive. */
export async function forget(input: {
  id?: string;
  entity_id?: string;
  process_id?: string;
}): Promise<MemoriResult<{ removed: number }>> {
  return request<{ removed?: number }>("/forget", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { removed: r.data?.removed ?? 0 } };
  });
}

/**
 * Memory-kernel reviewer feed: pull raw events still pending review.
 * Memory Init #5 Phase 1 (observe-only).
 */
export async function selectUnreviewed(
  input: MemoriSelectUnreviewedInput,
): Promise<MemoriResult<{ events: MemoriUnreviewedEvent[] }>> {
  return request<{ events?: MemoriUnreviewedEvent[] }>("/select_unreviewed", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { events: r.data?.events ?? [] } };
  });
}

/**
 * Bulk-update review_state on raw rows after the reviewer adjudicates
 * them. Returns the count of rows actually modified.
 */
export async function markReviewed(
  input: MemoriMarkReviewedInput,
): Promise<MemoriResult<{ marked: number }>> {
  return request<{ marked?: number }>("/mark_reviewed", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { marked: r.data?.marked ?? 0 } };
  });
}

/**
 * Memory Init #5 Phase 2: promote one or more raw events into a curated
 * memory. Atomic on the server side — either the curated row lands AND
 * source rows flip to review_state='promoted', or neither happens.
 */
export async function promote(
  input: MemoriPromoteInput,
): Promise<MemoriResult<{ id: string | null }>> {
  return request<{ id?: string | null }>("/promote", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { id: r.data?.id ?? null } };
  });
}

export const memoriClient = {
  health,
  capture,
  recall,
  forget,
  selectUnreviewed,
  markReviewed,
  promote,
  resolveMemoriUrl,
  resolveMemoriAuthToken,
};
