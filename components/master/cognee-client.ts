// components/master/cognee-client.ts
//
// v2.8.10 — Cognee HTTP client.
//
// Knot #1 decision: subctl + ArgentOS point at ONE local Cognee HTTP
// service. Shared graph = shared brain. This client is the typed
// boundary master crosses to reach that service.
//
// Cognee's Python SDK exposes four canonical operations: remember,
// recall, forget, improve. When Cognee runs as a self-hosted HTTP
// service (`cognee.serve()` / docker / one of the bundled deploy
// scripts), those map onto HTTP endpoints. The exact paths can shift
// between Cognee versions; we ENCAPSULATE that here so the rest of
// master speaks a stable interface.
//
// Phase 1 scaffold scope: client + health + typed contract. NO
// destructive migration. NO Tier 4/5 wiring yet. NO automatic backfill.
// Subsequent tasks (#7, #9) wire the actual consumers.
//
// Config + auth:
//   - URL:    process.env.COGNEE_SERVICE_URL > ~/.config/subctl/cognee.json#url > default (127.0.0.1:8745)
//   - Token:  process.env.COGNEE_AUTH_TOKEN  > secrets.json#cognee_auth_token > null (auth-free local dev)
//   The hardcoded default URL is a discovery fallback only — the
//   operator can override at any layer without recompiling.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSecret } from "./secrets";

// ─── types ─────────────────────────────────────────────────────────────────

export interface CogneeRememberInput {
  /** Free-form text to add to permanent memory. */
  text: string;
  /** Optional session key — short-term cache scope (Cognee terminology). */
  session_id?: string;
  /** Optional dataset namespace. Defaults to Cognee's main_dataset. */
  dataset?: string;
  /** Optional metadata bag — provenance, source URL, operator id, etc. */
  metadata?: Record<string, unknown>;
}

export interface CogneeRecallInput {
  query: string;
  session_id?: string;
  dataset?: string;
  /** Max hits to return (default 10). */
  top_k?: number;
}

export interface CogneeRecallHit {
  /** Best-effort: the matched text or summary. */
  text: string;
  /** Score / relevance, 0-1 if Cognee normalized it; else raw. */
  score?: number;
  /** Source metadata from when the item was remembered. */
  metadata?: Record<string, unknown>;
  /** Stable id if Cognee surfaces one. */
  id?: string;
}

export interface CogneeGraphNode {
  id: string;
  label?: string;
  type?: string;
  properties?: Record<string, unknown>;
}

export interface CogneeGraphEdge {
  from: string;
  to: string;
  relation?: string;
  properties?: Record<string, unknown>;
}

export interface CogneeNeighborsOutput {
  node: CogneeGraphNode;
  neighbors: Array<{ node: CogneeGraphNode; edge: CogneeGraphEdge }>;
}

export interface CogneeHealth {
  reachable: boolean;
  url: string;
  /** Round-trip in ms when reachable; null on failure. */
  latency_ms: number | null;
  /** Cognee version string if the service exposes one. */
  version: string | null;
  /** Auth state: "ok", "missing_token", "rejected" (401), or "n/a". */
  auth_status: "ok" | "missing_token" | "rejected" | "n/a";
  /** Last upstream error if not reachable. */
  error: string | null;
}

export type CogneeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// ─── config + secret resolution ────────────────────────────────────────────

const DEFAULT_URL = "http://127.0.0.1:8745";
const DEFAULT_TIMEOUT_MS = 15_000;

function configPath(): string {
  const home = process.env.HOME ?? "/tmp";
  const cfg = process.env.SUBCTL_CONFIG_DIR ?? join(home, ".config", "subctl");
  return join(cfg, "cognee.json");
}

/**
 * Resolve the Cognee service URL.
 * Priority: env COGNEE_SERVICE_URL > cognee.json#url > built-in default.
 * Trailing slashes stripped so callers can compose paths safely.
 */
export function resolveCogneeUrl(): string {
  const fromEnv = process.env.COGNEE_SERVICE_URL?.trim();
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

/**
 * Resolve the auth token via the standard secret chain. Returns null
 * when no token is configured (acceptable for fully-local dev with no
 * auth gate on the Cognee service).
 */
export function resolveCogneeAuthToken(): string | null {
  return resolveSecret("cognee_auth_token");
}

// ─── injectable side-effect surface (for tests) ────────────────────────────

interface Deps {
  /** Test-injectable fetch — defaults to the global. */
  fetcher: typeof fetch;
  /** Test-injectable URL resolver. */
  resolveUrl: () => string;
  /** Test-injectable token resolver. */
  resolveToken: () => string | null;
  /** Override the HTTP timeout in tests. */
  timeoutMs: number;
}

const realDeps: Deps = {
  fetcher: (url, init) => globalThis.fetch(url, init),
  resolveUrl: resolveCogneeUrl,
  resolveToken: resolveCogneeAuthToken,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<CogneeResult<T>> {
  const baseUrl = deps.resolveUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const token = deps.resolveToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
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
      error: isAbort ? `cognee request timed out (${opts.timeoutMs ?? deps.timeoutMs}ms)` : `cognee transport: ${msg}`,
    };
  }
  clearTimeout(t);
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `cognee HTTP ${response.status}: ${text.slice(0, 400)}`,
    };
  }
  if (!text) return { ok: true, data: undefined as unknown as T };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return {
      ok: false,
      error: `cognee response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ─── public client ─────────────────────────────────────────────────────────

/**
 * Probe the Cognee service. Reports reachability, auth status, and
 * version (when surfaced). Used by master's boot probe to populate
 * TOOL_GATES.cognee.
 *
 * Endpoint convention: GET /health. If your Cognee build uses a
 * different path, set COGNEE_SERVICE_URL to include the prefix and
 * leave /health appended — most self-host configurations follow this
 * shape.
 */
export async function health(): Promise<CogneeHealth> {
  const url = deps.resolveUrl();
  const token = deps.resolveToken();
  const t0 = Date.now();
  const r = await request<{ version?: string; status?: string }>("/health");
  const elapsed = Date.now() - t0;
  if (r.ok) {
    return {
      reachable: true,
      url,
      latency_ms: elapsed,
      version: typeof r.data?.version === "string" ? r.data.version : null,
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
    auth_status: isAuthRejected
      ? "rejected"
      : token
        ? "ok"
        : "missing_token",
    error: r.error,
  };
}

/**
 * Persist text into Cognee's permanent graph (or session cache when
 * session_id is provided). Mirrors `cognee.remember()` SDK semantics.
 */
export async function remember(
  input: CogneeRememberInput,
): Promise<CogneeResult<{ id: string | null }>> {
  return request<{ id?: string | null }>("/remember", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { id: r.data?.id ?? null } };
  });
}

/**
 * Retrieve relevant memories. When `session_id` is supplied Cognee
 * checks the fast cache first; absent that it traverses the permanent
 * graph.
 */
export async function recall(
  input: CogneeRecallInput,
): Promise<CogneeResult<{ hits: CogneeRecallHit[] }>> {
  return request<{ hits?: CogneeRecallHit[] }>("/recall", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { hits: r.data?.hits ?? [] } };
  });
}

/**
 * Drop a dataset or specific id from memory. Phase 1 surfaces this for
 * completeness; no consumer wires it yet (operator-initiated cleanup
 * only — destructive).
 */
export async function forget(input: {
  dataset?: string;
  id?: string;
}): Promise<CogneeResult<{ removed: number }>> {
  return request<{ removed?: number }>("/forget", {
    method: "POST",
    body: input,
  }).then((r) => {
    if (!r.ok) return r;
    return { ok: true, data: { removed: r.data?.removed ?? 0 } };
  });
}

/**
 * Graph neighbors of a node — Phase 4 (knowledge_graph_neighbors) will
 * be the primary consumer. Exposed here so the contract is locked in
 * one place.
 */
export async function neighbors(
  input: { node_id: string; depth?: number; relation?: string },
): Promise<CogneeResult<CogneeNeighborsOutput>> {
  return request<CogneeNeighborsOutput>("/graph/neighbors", {
    method: "POST",
    body: input,
  });
}

/** Shortest-path between two nodes — Phase 4 consumer. */
export async function graphPath(input: {
  from: string;
  to: string;
  max_hops?: number;
}): Promise<CogneeResult<{ nodes: CogneeGraphNode[]; edges: CogneeGraphEdge[] }>> {
  return request<{ nodes: CogneeGraphNode[]; edges: CogneeGraphEdge[] }>(
    "/graph/path",
    { method: "POST", body: input },
  );
}

/**
 * Free-form graph query (Cypher or Cognee's query DSL — depends on
 * backend). Phase 4 escape hatch.
 */
export async function graphQuery(input: {
  query: string;
  params?: Record<string, unknown>;
}): Promise<CogneeResult<{ rows: Array<Record<string, unknown>> }>> {
  return request<{ rows: Array<Record<string, unknown>> }>("/graph/query", {
    method: "POST",
    body: input,
  });
}

// ─── module-level convenience export ───────────────────────────────────────

export const cogneeClient = {
  health,
  remember,
  recall,
  forget,
  neighbors,
  graphPath,
  graphQuery,
  resolveCogneeUrl,
  resolveCogneeAuthToken,
};
