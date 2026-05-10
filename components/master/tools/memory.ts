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
      "Semantic search across observations claude-mem has captured from past Claude Code sessions (your dev-team leads, mostly). Use this to recall: \"what was decided about project X's auth flow?\", \"have we hit this error before?\", \"what file did we update last time we touched the billing code?\". Returns a list of matching observations with their session/project/timestamp metadata. Does NOT search master's own conversation transcripts — for that, look at agent.state.messages or ~/.config/subctl/master/decisions.jsonl directly.",
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
      "Get recent observations from claude-mem in time order — what your dev teams (Claude Code sessions) have been doing recently. Use when asked \"what's been happening?\", \"give me a recap of last week\", or before spawning a team to see if related work was already in progress. Requires either a query (semantic filter) or anchor (timestamp).",
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
      "Paginated raw list of all captured observations. Use sparingly — prefer memory_search or memory_timeline for targeted queries. This is the underlying storage view, ordered by capture time.",
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
      "Check whether the claude-mem worker is reachable and report its status (pid, initialized state, platform). Use to verify memory infra is up before relying on it.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const r = await memFetch<Record<string, unknown>>("/api/health");
      if (!r) return { ok: false, error: `claude-mem worker unreachable at ${MEM_WORKER}` };
      return { ok: true, host: MEM_WORKER, status: r };
    },
  },
};
