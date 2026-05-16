// v2.8.10 — Memori client tests (Phase 3a scaffold).

import { describe, test, expect, afterEach } from "bun:test";
import {
  health,
  capture,
  recall,
  forget,
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
