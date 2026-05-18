// components/master/tools/knowledge-graph.ts
//
// v2.8.10 Memory Init #4 — multi-hop reasoning over the Cognee graph.
//
// Background (Evy research summary, 2026-05-16): "vectors are not
// enough" but pure-graph is too simplistic — the winning architecture
// is hybrid. memory_search is the vector/semantic surface. This family
// is the GRAPH surface: relationships between projects, decisions,
// tool calls, files, operators, and outcomes.
//
// Three tools:
//   knowledge_graph_neighbors  — adjacency of a node
//   knowledge_graph_path       — shortest path between two nodes
//   knowledge_graph_query      — escape hatch for Cypher/DSL queries
//
// All three are gated on Cognee reachability — they surface clean
// errors if Cognee isn't configured, rather than silently no-op.

import {
  health as cogneeHealth,
  neighbors as cogneeNeighbors,
  graphPath as cogneeGraphPath,
  graphQuery as cogneeGraphQuery,
} from "../cognee-client";

interface CogneeAvail {
  available: boolean;
  checked_at: number;
}
let _avail: CogneeAvail | null = null;
const PROBE_TTL_MS = 30_000;

async function isCogneeReachable(): Promise<boolean> {
  const now = Date.now();
  if (_avail && now - _avail.checked_at < PROBE_TTL_MS) return _avail.available;
  try {
    const h = await cogneeHealth();
    _avail = { available: h.reachable, checked_at: now };
    return h.reachable;
  } catch {
    _avail = { available: false, checked_at: now };
    return false;
  }
}

/** Test seam. */
export function _setCogneeReachableForTesting(v: boolean | null): void {
  if (v === null) {
    _avail = null;
    return;
  }
  _avail = { available: v, checked_at: Date.now() };
}

const NOT_READY_ERR =
  "Cognee graph not reachable — knowledge_graph_* tools need a running Cognee service. Run `subctl status` to confirm, or check /api/master/health for cognee_health state.";

// ─── tool 1: knowledge_graph_neighbors ─────────────────────────────────────

const knowledge_graph_neighbors = {
  description:
    "**Use this when** the operator asks 'what's connected to X?' or you're trying to follow a relationship chain — projects ↔ decisions, decisions ↔ files, teams ↔ tool calls, operator ↔ preferences. Returns the node plus its direct neighbors with edge labels. Requires a configured Cognee service (Memory Init #4).",
  schema: {
    type: "object",
    properties: {
      node_id: {
        type: "string",
        description: "Cognee node id. Use knowledge_graph_query first to discover ids if you don't have one.",
      },
      depth: {
        type: "integer",
        description: "How many hops out (default 1, max 3). Higher values can balloon — prefer 1 unless you need explicit chain context.",
        minimum: 1,
        maximum: 3,
      },
      relation: {
        type: "string",
        description: "Optional relation-type filter (e.g. DECIDED_BY, TOUCHED_FILE). Omit for all relations.",
      },
    },
    required: ["node_id"],
  },
  invoke: async (args: {
    node_id?: string;
    depth?: number;
    relation?: string;
  } = {}) => {
    const node_id = typeof args.node_id === "string" ? args.node_id.trim() : "";
    if (!node_id) return { ok: false, error: "node_id is required" };
    if (!(await isCogneeReachable())) {
      return { ok: false, error: NOT_READY_ERR };
    }
    const depth =
      typeof args.depth === "number" ? Math.max(1, Math.min(3, args.depth)) : 1;
    const r = await cogneeNeighbors({
      node_id,
      depth,
      relation: args.relation,
    });
    if (!r.ok) return { ok: false, error: r.error, status: r.status };
    return {
      ok: true,
      node: r.data.node,
      neighbors: r.data.neighbors,
      depth,
      relation: args.relation ?? null,
    };
  },
};

// ─── tool 2: knowledge_graph_path ──────────────────────────────────────────

const knowledge_graph_path = {
  description:
    "**Use this when** the operator asks 'how is X related to Y?' — finds the shortest path between two nodes in the graph. Returns the chain of nodes + edges connecting them. Useful for tracing decision provenance (decision → spec → file → bug) or operator-preference origins.",
  schema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Source node id.",
      },
      to: {
        type: "string",
        description: "Target node id.",
      },
      max_hops: {
        type: "integer",
        description: "Cap on path length (default 6, max 10).",
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["from", "to"],
  },
  invoke: async (args: { from?: string; to?: string; max_hops?: number } = {}) => {
    const from = typeof args.from === "string" ? args.from.trim() : "";
    const to = typeof args.to === "string" ? args.to.trim() : "";
    if (!from || !to) {
      return { ok: false, error: "both from and to node ids are required" };
    }
    if (!(await isCogneeReachable())) {
      return { ok: false, error: NOT_READY_ERR };
    }
    const max_hops =
      typeof args.max_hops === "number"
        ? Math.max(1, Math.min(10, args.max_hops))
        : 6;
    const r = await cogneeGraphPath({ from, to, max_hops });
    if (!r.ok) return { ok: false, error: r.error, status: r.status };
    return {
      ok: true,
      from,
      to,
      max_hops,
      nodes: r.data.nodes,
      edges: r.data.edges,
      hop_count: Math.max(0, r.data.nodes.length - 1),
    };
  },
};

// ─── tool 3: knowledge_graph_query ─────────────────────────────────────────

const knowledge_graph_query = {
  description:
    "**Use this as an escape hatch** when knowledge_graph_neighbors and knowledge_graph_path aren't expressive enough — sends a raw query to the Cognee graph (Cypher or Cognee's DSL, depending on backend). Prefer the structured tools above; this is for power-user shaping (aggregations, multi-relation joins, counting).",
  schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Query string. Backend-specific syntax (Cypher / Cognee DSL).",
      },
      params: {
        type: "object",
        description: "Optional parameter bag if the query uses bound parameters.",
      },
    },
    required: ["query"],
  },
  invoke: async (args: {
    query?: string;
    params?: Record<string, unknown>;
  } = {}) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };
    if (!(await isCogneeReachable())) {
      return { ok: false, error: NOT_READY_ERR };
    }
    const r = await cogneeGraphQuery({
      query,
      params: args.params,
    });
    if (!r.ok) return { ok: false, error: r.error, status: r.status };
    return {
      ok: true,
      query,
      row_count: r.data.rows.length,
      rows: r.data.rows,
    };
  },
};

// ─── family export ─────────────────────────────────────────────────────────

export const knowledgeGraphTools = {
  knowledge_graph_neighbors,
  knowledge_graph_path,
  knowledge_graph_query,
};
