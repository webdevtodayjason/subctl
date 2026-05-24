// components/evy/tools/memory.ts
//
// v2.8.10 — Tier 4 with Cognee primary + claude-mem fallback.
//
// Origin: this file used to wrap ONLY claude-mem (the Claude Code
// session-observation worker at localhost:37701). Memory Init #2
// (task #7) layers Cognee in front: if cogneeClient.health() reports
// reachable, master uses Cognee for memory_search / memory_timeline /
// memory_observations. claude-mem stays as fallback until the operator
// confirms Cognee is the source of truth — that way the transition
// can't break Tier 4 mid-flight.
//
// Tool names and schemas are unchanged so Evy's SKILL.md and persona
// don't need rewrites. The output gains a `source` field
// ("cognee" | "claude-mem" | "both-empty") so callers know which
// substrate answered.
//
// Backfill: NOT auto-invoked. The companion script
// `bin/subctl memory backfill` (Memory Init #2 follow-up) ingests
// existing claude-mem observations + .subctl/docs/ + Obsidian into
// Cognee on operator demand.

import { health as cogneeHealth, recall as cogneeRecall } from "../cognee-client";

const MEM_WORKER = process.env.SUBCTL_CLAUDE_MEM_HOST ?? "http://localhost:37701";

async function memFetch<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const r = await fetch(`${MEM_WORKER}${path}`, {
      ...init,
      signal: AbortSignal.timeout(4000),
      headers: { ...(init.headers || {}), "Content-Type": "application/json" },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ─── Cognee preferred-path probe ───────────────────────────────────────────
//
// Cached for 30s — every tool call probing health would tank latency.
// On any non-OK response we fall back to claude-mem and the next probe
// re-checks. broadcast happens in server.ts so the dashboard sees it.

interface CogneeAvailability {
  available: boolean;
  checked_at: number;
}

let _cogneeCache: CogneeAvailability | null = null;
const COGNEE_PROBE_TTL_MS = 30_000;

async function isCogneeAvailable(): Promise<boolean> {
  const now = Date.now();
  if (_cogneeCache && now - _cogneeCache.checked_at < COGNEE_PROBE_TTL_MS) {
    return _cogneeCache.available;
  }
  try {
    const h = await cogneeHealth();
    _cogneeCache = { available: h.reachable, checked_at: now };
    return h.reachable;
  } catch {
    _cogneeCache = { available: false, checked_at: now };
    return false;
  }
}

/** Test seam — force the availability state without hitting the real probe. */
export function _setCogneeAvailableForTesting(v: boolean | null): void {
  if (v === null) {
    _cogneeCache = null;
    return;
  }
  _cogneeCache = { available: v, checked_at: Date.now() };
}

// ─── tools ─────────────────────────────────────────────────────────────────

export const memoryTools = {
  memory_search: {
    description:
      "**Use this FIRST when** the operator references past work, asks about prior decisions, or you need historical context (\"what did we decide about X\", \"have we hit this error before\", \"how did we solve Y last time\"). Don't recall from your own context window — query. Returns Tier 4 memory: routed through Cognee when its service is reachable, falls back to claude-mem otherwise. The response includes `source` so you can see which substrate answered. Does NOT search your own conversation transcripts; for that, read agent-state.json or decisions.jsonl directly.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query. Will be matched semantically against the indexed corpus.",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default 10, cap 50.",
        },
      },
      required: ["query"],
    },
    invoke: async ({ query, limit }: { query: string; limit?: number }) => {
      const lim = Math.max(1, Math.min(50, limit ?? 10));
      if (await isCogneeAvailable()) {
        const r = await cogneeRecall({ query, top_k: lim });
        if (r.ok) {
          return {
            ok: true,
            source: "cognee" as const,
            query,
            count: r.data.hits.length,
            items: r.data.hits,
          };
        }
        // Cognee accepted the request but errored. Fall through to
        // claude-mem rather than reporting nothing.
      }
      const r = await memFetch<{ items?: unknown[]; results?: unknown[] }>(
        "/api/search",
        { method: "POST", body: JSON.stringify({ query, limit: lim }) },
      );
      if (!r) {
        return {
          ok: false,
          error: `Tier 4 unreachable: Cognee not configured/reachable AND claude-mem worker down at ${MEM_WORKER}.`,
          source: "both-empty" as const,
        };
      }
      const items = r.items ?? r.results ?? [];
      return {
        ok: true,
        source: "claude-mem" as const,
        query,
        count: Array.isArray(items) ? items.length : 0,
        items,
      };
    },
  },

  memory_timeline: {
    description:
      "**Use this FIRST when** asked \"what's been happening?\", \"give me a recap of last week\", or before spawning a team to see if related work was already in progress. Don't recall — query. Returns recent Tier 4 observations in time order, routed through Cognee when reachable, claude-mem otherwise. Accepts an optional semantic filter; pass empty to get the most recent overall.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional semantic filter. Pass an empty string or omit if you want the most recent overall.",
        },
        limit: {
          type: "number",
          description: "Max results. Default 20, cap 100.",
        },
      },
      required: [],
    },
    invoke: async ({ query, limit }: { query?: string; limit?: number }) => {
      const lim = Math.max(1, Math.min(100, limit ?? 20));
      const q = (query ?? "").trim();
      if (await isCogneeAvailable()) {
        // Cognee returns most-recent-first ordering when we recall
        // with no session id and an empty/wildcard query. For semantic
        // filtering, the query string IS the filter.
        const r = await cogneeRecall({ query: q || "*", top_k: lim });
        if (r.ok) {
          return {
            ok: true,
            source: "cognee" as const,
            query: q,
            count: r.data.hits.length,
            items: r.data.hits,
          };
        }
      }
      const params = new URLSearchParams({ query: q || "*", limit: String(lim) });
      const r = await memFetch<unknown>(`/api/timeline?${params.toString()}`);
      if (!r) {
        return {
          ok: false,
          error: `Tier 4 unreachable: Cognee not configured/reachable AND claude-mem worker down at ${MEM_WORKER}.`,
          source: "both-empty" as const,
        };
      }
      return { ok: true, source: "claude-mem" as const, query: q, response: r };
    },
  },

  memory_observations: {
    description:
      "**Use this when** memory_search and memory_timeline aren't enough and you need a paginated view of Tier 4 storage. Prefer memory_search (semantic) or memory_timeline (recency-filtered) for targeted queries. NOTE: when Cognee is the active substrate this falls back to recall-with-wildcard ordering; for true raw paginated storage view, query Cognee's REST API directly via the operator dashboard.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max items per page. Default 25, cap 200." },
        offset: { type: "number", description: "Pagination offset. Default 0." },
      },
      required: [],
    },
    invoke: async ({ limit, offset }: { limit?: number; offset?: number }) => {
      const lim = Math.max(1, Math.min(200, limit ?? 25));
      const off = Math.max(0, offset ?? 0);
      // Cognee doesn't expose a paginated raw-storage endpoint the way
      // claude-mem does. We fall back to wildcard recall + manual slice
      // so callers still get SOMETHING, but the operator dashboard is
      // the right place for deep audit-style paging.
      if (await isCogneeAvailable()) {
        const r = await cogneeRecall({ query: "*", top_k: lim + off });
        if (r.ok) {
          const sliced = r.data.hits.slice(off, off + lim);
          return {
            ok: true,
            source: "cognee" as const,
            count: sliced.length,
            hasMore: r.data.hits.length > off + lim,
            offset: off,
            limit: lim,
            items: sliced,
            note: "Cognee recall + client-side slice; for raw paginated audit use the Cognee dashboard.",
          };
        }
      }
      const params = new URLSearchParams({ limit: String(lim), offset: String(off) });
      const r = await memFetch<{ items?: unknown[]; hasMore?: boolean; offset?: number; limit?: number }>(`/api/observations?${params.toString()}`);
      if (!r) {
        return {
          ok: false,
          error: `Tier 4 unreachable: Cognee not configured/reachable AND claude-mem worker down at ${MEM_WORKER}.`,
          source: "both-empty" as const,
        };
      }
      return {
        ok: true,
        source: "claude-mem" as const,
        count: Array.isArray(r.items) ? r.items.length : 0,
        hasMore: !!r.hasMore,
        offset: r.offset ?? off,
        limit: r.limit ?? lim,
        items: r.items ?? [],
      };
    },
  },

  memory_health: {
    description:
      "**Use this when** memory_search or memory_timeline returned an unexpected error and you need to know whether Tier 4 is alive. Reports BOTH substrates: Cognee health (primary post v2.8.10) and the claude-mem worker (fallback). At least one must be reachable for Tier 4 tools to answer.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const [cog, claudeMem] = await Promise.all([
        cogneeHealth().catch((e: unknown) => ({
          reachable: false,
          url: "",
          latency_ms: null,
          version: null,
          auth_status: "n/a" as const,
          error: e instanceof Error ? e.message : String(e),
        })),
        memFetch<Record<string, unknown>>("/api/health"),
      ]);
      const cogneeBlock = {
        reachable: cog.reachable,
        url: cog.url,
        latency_ms: cog.latency_ms,
        version: cog.version,
        auth_status: cog.auth_status,
        error: cog.error,
      };
      const claudeMemBlock = claudeMem
        ? { reachable: true, host: MEM_WORKER, status: claudeMem }
        : { reachable: false, host: MEM_WORKER, error: "worker unreachable" };
      return {
        ok: cogneeBlock.reachable || claudeMemBlock.reachable,
        active_substrate: cogneeBlock.reachable ? "cognee" : claudeMemBlock.reachable ? "claude-mem" : "none",
        cognee: cogneeBlock,
        claude_mem: claudeMemBlock,
      };
    },
  },
};
