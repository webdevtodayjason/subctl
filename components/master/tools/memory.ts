// memory tools — query the local claude-mem worker for past observations
// captured from Claude Code sessions (dev-team leads).
//
// claude-mem (https://claude-mem.dev) auto-captures observations from
// every Claude Code session via a SessionStart hook + file-edit hooks.
// Each observation is a small structured record of what was read,
// edited, decided, or run during a session. The plugin keeps them all
// indexed locally and exposes an HTTP API at localhost:37701.
//
// Master's dev teams ARE Claude Code (the lead in pane 0 of every
// dev-team tmux session), so their work flows into claude-mem
// automatically. Master itself is pi-agent-core and is NOT auto-
// captured — but it can SEARCH the captured observations to recall
// what its dev teams have done before.
//
// Endpoints used:
//   POST /api/search     {query, limit?}
//   GET  /api/timeline   ?query=X&limit=N    (anchor or query required)
//   GET  /api/observations ?limit=N&offset=M

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

export const memoryTools = {
  memory_search: {
    description:
      "**Use this FIRST when** the operator references past work, asks about prior decisions, or you need historical context (\"what did we decide about X\", \"have we hit this error before\", \"how did we solve Y last time\"). Don't recall from your own context window — query. Returns observations from claude-mem (Tier 4) captured across past Claude Code sessions, with session/project/timestamp provenance. Does NOT search your own conversation transcripts; for that, read agent-state.json or decisions.jsonl directly.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query. Will be matched semantically against the observation corpus.",
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
      const r = await memFetch<{ items?: unknown[]; results?: unknown[] }>(
        "/api/search",
        { method: "POST", body: JSON.stringify({ query, limit: lim }) },
      );
      if (!r) return { ok: false, error: `claude-mem worker unreachable at ${MEM_WORKER}` };
      const items = r.items ?? r.results ?? [];
      return { ok: true, query, count: Array.isArray(items) ? items.length : 0, items };
    },
  },

  memory_timeline: {
    description:
      "**Use this FIRST when** asked \"what's been happening?\", \"give me a recap of last week\", or before spawning a team to see if related work was already in progress. Don't recall — query. Returns recent observations from claude-mem (Tier 4) in time order. Accepts an optional semantic filter; pass empty to get the most recent overall.",
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
      const q = (query ?? "*").trim() || "*";
      const params = new URLSearchParams({ query: q, limit: String(lim) });
      const r = await memFetch<unknown>(`/api/timeline?${params.toString()}`);
      if (!r) return { ok: false, error: `claude-mem worker unreachable at ${MEM_WORKER}` };
      return { ok: true, query: q, response: r };
    },
  },

  memory_observations: {
    description:
      "**Use this when** memory_search and memory_timeline aren't enough and you need the raw paginated view. Prefer memory_search (semantic) or memory_timeline (recency-filtered) for targeted queries; this is the underlying storage view from claude-mem (Tier 4), ordered by capture time.",
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
      const params = new URLSearchParams({ limit: String(lim), offset: String(off) });
      const r = await memFetch<{ items?: unknown[]; hasMore?: boolean; offset?: number; limit?: number }>(`/api/observations?${params.toString()}`);
      if (!r) return { ok: false, error: `claude-mem worker unreachable at ${MEM_WORKER}` };
      return {
        ok: true,
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
      "**Use this when** memory_search or memory_timeline returned an unexpected error and you need to confirm whether the claude-mem worker (Tier 4 substrate) is alive. Reports pid, initialized state, platform.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const r = await memFetch<Record<string, unknown>>("/api/health");
      if (!r) return { ok: false, error: `claude-mem worker unreachable at ${MEM_WORKER}` };
      return { ok: true, host: MEM_WORKER, status: r };
    },
  },
};
