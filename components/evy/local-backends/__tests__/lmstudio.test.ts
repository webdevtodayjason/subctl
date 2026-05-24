// components/evy/local-backends/__tests__/lmstudio.test.ts
//
// Phase 4 — LM Studio adapter contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { lmstudio } from "../lmstudio";

const origFetch = globalThis.fetch;

interface MockCall {
  url: string;
  init?: RequestInit;
}

let calls: MockCall[] = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error — overriding global fetch for tests
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("lmstudio adapter", () => {
  test("URLs strip trailing /v1 from host", () => {
    expect(lmstudio.inferenceUrl("http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(lmstudio.inferenceUrl("http://localhost:1234")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(lmstudio.embeddingsUrl("http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1/embeddings",
    );
  });

  test("listModels parses /api/v0/models rich rows", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/qwen3.6-27b",
              state: "loaded",
              loaded_context_length: 65536,
              max_context_length: 131072,
              quantization: "Q4_K_M",
              type: "llm",
            },
            {
              id: "text-embedding-nomic",
              state: "not-loaded",
              quantization: "F16",
              type: "embeddings",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const models = await lmstudio.listModels("http://localhost:1234");
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "qwen/qwen3.6-27b",
      loaded: true,
      context_length: 65536,
      type: "llm",
      quantization: "Q4_K_M",
    });
    expect(models[1]).toMatchObject({
      id: "text-embedding-nomic",
      loaded: false,
      type: "embeddings",
    });
    expect(calls[0]!.url).toBe("http://localhost:1234/api/v0/models");
  });

  test("healthProbe ok path returns model_count", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
      }),
    );
    const h = await lmstudio.healthProbe("http://localhost:1234");
    expect(h.ok).toBe(true);
    expect(h.model_count).toBe(2);
    expect(h.reachable_at).toBe("http://localhost:1234/api/v0/models");
  });

  test("healthProbe HTTP error path", async () => {
    mockFetch(() => new Response("nope", { status: 500 }));
    const h = await lmstudio.healthProbe("http://localhost:1234");
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("500");
  });

  test("healthProbe network error path", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const h = await lmstudio.healthProbe("http://localhost:1234");
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("ECONNREFUSED");
  });

  test("pinModel respects already-loaded model", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen/qwen3.6-27b",
              state: "loaded",
              loaded_context_length: 32768,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const r = await lmstudio.pinModel!("http://localhost:1234", "qwen/qwen3.6-27b", 65536);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("already loaded");
    // Only the /api/v0/models probe should have been made — no load call.
    expect(calls.length).toBe(1);
  });

  test("pinModel POSTs /models/load when not loaded", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "qwen/qwen3.6-27b", state: "not-loaded" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/v1/models/unload")) {
        return new Response("{}", { status: 200 });
      }
      if (url.endsWith("/api/v1/models/load")) {
        return new Response(
          JSON.stringify({ load_config: { context_length: 65536 } }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const r = await lmstudio.pinModel!("http://localhost:1234", "qwen/qwen3.6-27b", 65536);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("65,536");
    // probe + unload + load
    expect(calls.length).toBe(3);
    expect(calls[2]!.url).toBe("http://localhost:1234/api/v1/models/load");
  });

  test("pinModel bails when LM Studio is unreachable", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const r = await lmstudio.pinModel!("http://localhost:1234", "qwen/qwen3.6-27b", 65536);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("did not respond");
  });

  test("pinModel distinguishes non-2xx probe from timeout (CodeRabbit pass-4 (a))", async () => {
    // LM Studio reachable but returning 503 (e.g. internal error) used to be
    // reported as "did not respond within 2s" — misleading. Now surfaces the
    // actual HTTP status so the operator knows the daemon is up but unhappy.
    mockFetch(
      () => new Response("upstream timeout", { status: 503 }),
    );
    const r = await lmstudio.pinModel!("http://localhost:1234", "qwen/qwen3.6-27b", 65536);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("HTTP 503");
    expect(r.detail).not.toContain("did not respond");
  });

  test("ctx_size=0 short-circuits before any fetch", async () => {
    let called = 0;
    mockFetch(() => {
      called++;
      return new Response("{}", { status: 200 });
    });
    const r = await lmstudio.pinModel!("http://localhost:1234", "x", 0);
    expect(r.ok).toBe(true);
    expect(called).toBe(0);
  });

  test("api_key threads Authorization header", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await lmstudio.healthProbe("http://localhost:1234", { api_key: "secret" });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
  });

  test("api_key='not-needed' sentinel does NOT inject header", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await lmstudio.healthProbe("http://localhost:1234", {
      api_key: "not-needed",
    });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
