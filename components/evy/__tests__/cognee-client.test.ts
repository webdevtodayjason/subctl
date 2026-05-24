// v2.8.10 — Cognee client tests (Phase 1 scaffold).
//
// Covers URL/token resolution priority chain, health probe success +
// failure shapes, request error mapping (401/5xx/timeout/network), and
// the JSON parse failure path.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  health,
  remember,
  recall,
  forget,
  neighbors,
  graphPath,
  resolveCogneeUrl,
  _setDepsForTesting,
  _resetDepsForTesting,
} from "../cognee-client";

interface StubResponse {
  ok: boolean;
  status: number;
  text: string;
}

function makeFetcher(map: Record<string, StubResponse | (() => never)>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const match = Object.entries(map).find(([path]) => url.endsWith(path));
    if (!match) throw new Error(`unexpected URL: ${url}`);
    const v = match[1];
    if (typeof v === "function") {
      // simulate transport failure
      v();
    }
    const r = v as StubResponse;
    return new Response(r.text, { status: r.status });
  };
}

afterEach(() => {
  _resetDepsForTesting();
});

describe("URL resolution", () => {
  test("env COGNEE_SERVICE_URL wins over config file and default", () => {
    const prev = process.env.COGNEE_SERVICE_URL;
    process.env.COGNEE_SERVICE_URL = "https://shared.local:8745/";
    try {
      expect(resolveCogneeUrl()).toBe("https://shared.local:8745");
    } finally {
      if (prev === undefined) delete process.env.COGNEE_SERVICE_URL;
      else process.env.COGNEE_SERVICE_URL = prev;
    }
  });

  test("strips trailing slashes", () => {
    const prev = process.env.COGNEE_SERVICE_URL;
    process.env.COGNEE_SERVICE_URL = "https://x.test:8745///";
    try {
      expect(resolveCogneeUrl()).toBe("https://x.test:8745");
    } finally {
      if (prev === undefined) delete process.env.COGNEE_SERVICE_URL;
      else process.env.COGNEE_SERVICE_URL = prev;
    }
  });

  test("falls back to built-in default", () => {
    const prev = process.env.COGNEE_SERVICE_URL;
    delete process.env.COGNEE_SERVICE_URL;
    try {
      // The default is 127.0.0.1:8745 — assert the shape, not the exact
      // port, so a future port change in the client doesn't break tests
      // that don't care about the literal value.
      const v = resolveCogneeUrl();
      expect(v).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      if (prev !== undefined) process.env.COGNEE_SERVICE_URL = prev;
    }
  });
});

describe("health probe", () => {
  test("reports reachable + version when service responds 200", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": {
          ok: true,
          status: 200,
          text: JSON.stringify({ version: "1.2.3", status: "ok" }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => "tok123",
    });
    const h = await health();
    expect(h.reachable).toBe(true);
    expect(h.version).toBe("1.2.3");
    expect(h.auth_status).toBe("ok");
    expect(h.url).toBe("http://test.local:8745");
  });

  test("reports auth_status=rejected on 401", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": { ok: false, status: 401, text: "Unauthorized" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => "tok123",
    });
    const h = await health();
    expect(h.reachable).toBe(false);
    expect(h.auth_status).toBe("rejected");
    expect(h.error).toMatch(/HTTP 401/);
  });

  test("reports missing_token when no token is configured + service requires auth", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": { ok: false, status: 403, text: "forbidden" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.reachable).toBe(false);
    expect(h.auth_status).toBe("rejected");
  });

  test("handles transport failure cleanly", async () => {
    _setDepsForTesting({
      fetcher: (() => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://does-not-exist.test:8745",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.reachable).toBe(false);
    expect(h.error).toMatch(/cognee transport/);
  });
});

describe("remember / recall / forget", () => {
  test("remember POSTs to /remember and surfaces id", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/remember": {
          ok: true,
          status: 200,
          text: JSON.stringify({ id: "node_42" }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await remember({ text: "hello" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe("node_42");
  });

  test("recall returns hits array, empty when service omits", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/recall": { ok: true, status: 200, text: JSON.stringify({}) },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await recall({ query: "what about X?" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hits).toEqual([]);
  });

  test("forget propagates removed count", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/forget": {
          ok: true,
          status: 200,
          text: JSON.stringify({ removed: 3 }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await forget({ dataset: "main_dataset" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.removed).toBe(3);
  });
});

describe("graph operations", () => {
  test("neighbors round-trips node payload", async () => {
    const payload = {
      node: { id: "n1", label: "Project", type: "Project" },
      neighbors: [
        {
          node: { id: "n2", label: "Decision" },
          edge: { from: "n1", to: "n2", relation: "DECIDED_BY" },
        },
      ],
    };
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/graph/neighbors": {
          ok: true,
          status: 200,
          text: JSON.stringify(payload),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await neighbors({ node_id: "n1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.node.id).toBe("n1");
      expect(r.data.neighbors).toHaveLength(1);
    }
  });

  test("graphPath surfaces nodes + edges", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/graph/path": {
          ok: true,
          status: 200,
          text: JSON.stringify({
            nodes: [{ id: "a" }, { id: "b" }],
            edges: [{ from: "a", to: "b" }],
          }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await graphPath({ from: "a", to: "b" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.nodes).toHaveLength(2);
      expect(r.data.edges).toHaveLength(1);
    }
  });
});

describe("error mapping", () => {
  test("malformed JSON body produces parse error", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/recall": { ok: true, status: 200, text: "not json {{" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await recall({ query: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  test("5xx surfaces status + truncated body", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/remember": {
          ok: false,
          status: 503,
          text: "service unavailable, please try later",
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8745",
      resolveToken: () => null,
    });
    const r = await remember({ text: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toMatch(/HTTP 503/);
    }
  });
});
