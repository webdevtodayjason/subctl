// v2.8.10 Memory Init #4 — knowledge_graph_* tests.

import { describe, test, expect, afterEach } from "bun:test";
import {
  knowledgeGraphTools,
  _setCogneeReachableForTesting,
} from "../tools/knowledge-graph";
import {
  _setDepsForTesting as _setCogneeDeps,
  _resetDepsForTesting as _resetCogneeDeps,
} from "../cognee-client";

afterEach(() => {
  _resetCogneeDeps();
  _setCogneeReachableForTesting(null);
});

describe("not-reachable gating", () => {
  test("neighbors errors with NOT_READY when cognee down", async () => {
    _setCogneeReachableForTesting(false);
    const out = await knowledgeGraphTools.knowledge_graph_neighbors.invoke({
      node_id: "n1",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/Cognee graph not reachable/);
  });

  test("path errors with NOT_READY when cognee down", async () => {
    _setCogneeReachableForTesting(false);
    const out = await knowledgeGraphTools.knowledge_graph_path.invoke({
      from: "a",
      to: "b",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
  });

  test("query errors with NOT_READY when cognee down", async () => {
    _setCogneeReachableForTesting(false);
    const out = await knowledgeGraphTools.knowledge_graph_query.invoke({
      query: "MATCH (n) RETURN n LIMIT 1",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
  });
});

describe("input validation", () => {
  test("neighbors requires node_id", async () => {
    _setCogneeReachableForTesting(true);
    const out = await knowledgeGraphTools.knowledge_graph_neighbors.invoke({});
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/node_id is required/);
  });

  test("path requires both from and to", async () => {
    _setCogneeReachableForTesting(true);
    const out = await knowledgeGraphTools.knowledge_graph_path.invoke({
      from: "a",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
  });

  test("query requires non-empty query", async () => {
    _setCogneeReachableForTesting(true);
    const out = await knowledgeGraphTools.knowledge_graph_query.invoke({
      query: "  ",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
  });
});

describe("happy paths", () => {
  test("neighbors returns node + neighbors when cognee responds", async () => {
    _setCogneeReachableForTesting(true);
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/graph/neighbors")) {
          return new Response(
            JSON.stringify({
              node: { id: "p1", type: "Project", label: "subctl" },
              neighbors: [
                {
                  node: { id: "d1", type: "Decision" },
                  edge: { from: "p1", to: "d1", relation: "DECIDED_BY" },
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${input}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await knowledgeGraphTools.knowledge_graph_neighbors.invoke({
      node_id: "p1",
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect((out as { node: { id: string } }).node.id).toBe("p1");
    expect((out as { neighbors: unknown[] }).neighbors).toHaveLength(1);
  });

  test("path returns nodes + edges + hop_count", async () => {
    _setCogneeReachableForTesting(true);
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/graph/path")) {
          return new Response(
            JSON.stringify({
              nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
              edges: [
                { from: "a", to: "b" },
                { from: "b", to: "c" },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${input}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await knowledgeGraphTools.knowledge_graph_path.invoke({
      from: "a",
      to: "c",
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect((out as { hop_count: number }).hop_count).toBe(2);
  });

  test("query returns rows + row_count", async () => {
    _setCogneeReachableForTesting(true);
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/graph/query")) {
          return new Response(
            JSON.stringify({ rows: [{ name: "a" }, { name: "b" }] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${input}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const out = await knowledgeGraphTools.knowledge_graph_query.invoke({
      query: "MATCH (n) RETURN n",
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect((out as { row_count: number }).row_count).toBe(2);
  });
});

describe("depth clamping", () => {
  test("neighbors depth clamps to max 3", async () => {
    _setCogneeReachableForTesting(true);
    let capturedDepth: number | null = null;
    _setCogneeDeps({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/graph/neighbors")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          capturedDepth = body.depth ?? null;
          return new Response(
            JSON.stringify({ node: { id: "n1" }, neighbors: [] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${input}`);
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    await knowledgeGraphTools.knowledge_graph_neighbors.invoke({
      node_id: "n1",
      depth: 99,
    });
    expect(capturedDepth).toBe(3);
  });
});
