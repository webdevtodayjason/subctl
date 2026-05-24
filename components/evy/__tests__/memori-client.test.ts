// v2.8.10 — Memori client tests (Phase 3a scaffold).

import { describe, test, expect, afterEach } from "bun:test";
import {
  health,
  capture,
  recall,
  forget,
  selectUnreviewed,
  markReviewed,
  promote,
  resolveMemoriUrl,
  _setDepsForTesting,
  _resetDepsForTesting,
} from "../memori-client";

interface StubResponse {
  ok: boolean;
  status: number;
  text: string;
}

function makeFetcher(map: Record<string, StubResponse | (() => never)>) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    const match = Object.entries(map).find(([path]) => url.endsWith(path));
    if (!match) throw new Error(`unexpected URL: ${url}`);
    const v = match[1];
    if (typeof v === "function") v();
    const r = v as StubResponse;
    return new Response(r.text, { status: r.status });
  };
}

afterEach(() => {
  _resetDepsForTesting();
});

describe("URL resolution", () => {
  test("env MEMORI_SERVICE_URL wins", () => {
    const prev = process.env.MEMORI_SERVICE_URL;
    process.env.MEMORI_SERVICE_URL = "https://memori.test:8746/";
    try {
      expect(resolveMemoriUrl()).toBe("https://memori.test:8746");
    } finally {
      if (prev === undefined) delete process.env.MEMORI_SERVICE_URL;
      else process.env.MEMORI_SERVICE_URL = prev;
    }
  });

  test("falls back to built-in 127.0.0.1 default", () => {
    const prev = process.env.MEMORI_SERVICE_URL;
    delete process.env.MEMORI_SERVICE_URL;
    try {
      expect(resolveMemoriUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      if (prev !== undefined) process.env.MEMORI_SERVICE_URL = prev;
    }
  });
});

describe("health", () => {
  test("reports reachable + db + version when sidecar responds", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": {
          ok: true,
          status: 200,
          text: JSON.stringify({
            version: "0.1.0",
            database: "sqlite",
            total_memories: 42,
          }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.reachable).toBe(true);
    expect(h.database).toBe("sqlite");
    expect(h.total_memories).toBe(42);
    expect(h.version).toBe("0.1.0");
  });

  test("reports auth_status=rejected on 401", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": { ok: false, status: 401, text: "denied" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => "tok",
    });
    const h = await health();
    expect(h.reachable).toBe(false);
    expect(h.auth_status).toBe("rejected");
  });

  test("reports missing_token when sidecar unreachable + no token", async () => {
    _setDepsForTesting({
      fetcher: (() => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.reachable).toBe(false);
    expect(h.auth_status).toBe("missing_token");
  });
});

describe("capture / recall / forget", () => {
  test("capture POSTs structured turn payload and returns id", async () => {
    let capturedBody: string | null = null;
    _setDepsForTesting({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        capturedBody =
          typeof init?.body === "string" ? (init.body as string) : null;
        return new Response(JSON.stringify({ id: "mem_99" }), { status: 200 });
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await capture({
      entity_id: "jason",
      process_id: "evy-master",
      turn: {
        user_text: "hello",
        assistant_text: "hi back",
        tool_calls: [
          { name: "system_load", args: {}, result: { load: 1 }, ok: true },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe("mem_99");
    expect(capturedBody).toContain("jason");
    expect(capturedBody).toContain("system_load");
  });

  test("recall returns hits with default empty when sidecar omits", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/recall": { ok: true, status: 200, text: JSON.stringify({}) },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await recall({
      entity_id: "jason",
      process_id: "evy-master",
      query: "favorite color",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.hits).toEqual([]);
  });

  test("forget reports removed count", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/forget": {
          ok: true,
          status: 200,
          text: JSON.stringify({ removed: 5 }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await forget({ entity_id: "jason" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.removed).toBe(5);
  });
});

describe("error mapping", () => {
  test("malformed JSON surfaces parse error", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/recall": { ok: true, status: 200, text: "not json" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await recall({ entity_id: "x", query: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  test("5xx propagates status + truncated body", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/capture": { ok: false, status: 502, text: "bad gateway" },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await capture({
      entity_id: "x",
      process_id: "y",
      turn: { user_text: "z" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.error).toMatch(/HTTP 502/);
    }
  });
});

describe("memory-kernel review surface", () => {
  test("health surfaces total_unreviewed + total_curated when sidecar exposes them", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": {
          ok: true,
          status: 200,
          text: JSON.stringify({
            version: "0.1.0",
            database: "sqlite",
            total_memories: 9,
            total_unreviewed: 4,
            total_curated: 2,
          }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.total_unreviewed).toBe(4);
    expect(h.total_curated).toBe(2);
  });

  test("health leaves new fields null when sidecar predates the migration", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/health": {
          ok: true,
          status: 200,
          text: JSON.stringify({
            version: "0.0.9",
            database: "sqlite",
            total_memories: 9,
          }),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const h = await health();
    expect(h.total_unreviewed).toBeNull();
    expect(h.total_curated).toBeNull();
  });

  test("selectUnreviewed POSTs the filter shape and returns events", async () => {
    let path: string | null = null;
    let body: string | null = null;
    _setDepsForTesting({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        path = String(input);
        body = typeof init?.body === "string" ? (init.body as string) : null;
        return new Response(
          JSON.stringify({
            events: [
              {
                id: "mem_001",
                ts: "2026-05-17T00:00:00Z",
                user_text: "hi",
                assistant_text: "hello",
                tool_calls_json: "[]",
                decisions_json: "[]",
                outcomes_json: "[]",
                metadata_json: "{}",
                review_state: "unreviewed",
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await selectUnreviewed({
      entity_id: "jason",
      since: "2026-05-01T00:00:00Z",
      limit: 25,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.events).toHaveLength(1);
      expect(r.data.events[0]?.id).toBe("mem_001");
      expect(r.data.events[0]?.review_state).toBe("unreviewed");
    }
    expect(path).toMatch(/\/select_unreviewed$/);
    expect(body).toContain("jason");
    expect(body).toContain("2026-05-01");
    expect(body).toContain("25");
  });

  test("selectUnreviewed defaults events to [] when sidecar omits the key", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/select_unreviewed": {
          ok: true,
          status: 200,
          text: JSON.stringify({}),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await selectUnreviewed({ entity_id: "jason" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.events).toEqual([]);
  });

  test("selectUnreviewed surfaces parse error on malformed response", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/select_unreviewed": {
          ok: true,
          status: 200,
          text: "<not json>",
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await selectUnreviewed({ entity_id: "jason" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  test("markReviewed POSTs ids + state and returns marked count", async () => {
    let body: string | null = null;
    _setDepsForTesting({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        body = typeof init?.body === "string" ? (init.body as string) : null;
        return new Response(JSON.stringify({ marked: 3 }), { status: 200 });
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await markReviewed({
      ids: ["mem_001", "mem_002", "mem_003"],
      review_state: "reviewed",
      reviewer_model: "reviewer-v1",
      reason: "routine",
      confidence: 0.85,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.marked).toBe(3);
    expect(body).toContain("mem_001");
    expect(body).toContain("reviewer-v1");
    expect(body).toContain("0.85");
  });

  test("markReviewed defaults marked to 0 when sidecar omits the key", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/mark_reviewed": {
          ok: true,
          status: 200,
          text: JSON.stringify({}),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await markReviewed({
      ids: ["mem_x"],
      review_state: "discarded",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.marked).toBe(0);
  });

  test("markReviewed surfaces parse error on malformed response", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/mark_reviewed": {
          ok: true,
          status: 200,
          text: "garbage{",
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await markReviewed({
      ids: ["mem_x"],
      review_state: "reviewed",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  test("promote POSTs curated payload and returns curated id", async () => {
    let body: string | null = null;
    _setDepsForTesting({
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        body = typeof init?.body === "string" ? (init.body as string) : null;
        return new Response(
          JSON.stringify({ id: "curated_abcdef123456" }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await promote({
      entity_id: "jason",
      source_ids: ["mem_001", "mem_002"],
      memory: "Jason prefers MikroTik over Cisco at the edge",
      kind: "preference",
      reason: "two consistent statements over the week",
      confidence: 0.92,
      reviewer_model: "reviewer-v1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe("curated_abcdef123456");
    expect(body).toContain("MikroTik");
    expect(body).toContain("mem_001");
    expect(body).toContain("preference");
  });

  test("promote returns null id when sidecar omits it", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/promote": {
          ok: true,
          status: 200,
          text: JSON.stringify({}),
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await promote({
      entity_id: "jason",
      source_ids: ["mem_001"],
      memory: "X",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBeNull();
  });

  test("promote surfaces parse error on malformed response", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/promote": {
          ok: true,
          status: 200,
          text: "}{",
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await promote({
      entity_id: "jason",
      source_ids: ["mem_001"],
      memory: "X",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  test("promote propagates 4xx validation errors from the sidecar", async () => {
    _setDepsForTesting({
      fetcher: makeFetcher({
        "/promote": {
          ok: false,
          status: 400,
          text: "source_ids must be a non-empty list",
        },
      }) as unknown as typeof fetch,
      resolveUrl: () => "http://test.local:8746",
      resolveToken: () => null,
    });
    const r = await promote({
      entity_id: "jason",
      source_ids: [],
      memory: "X",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/HTTP 400/);
    }
  });
});
