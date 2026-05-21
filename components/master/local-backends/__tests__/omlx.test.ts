// components/master/local-backends/__tests__/omlx.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { omlx } from "../omlx";

const origFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error — overriding global fetch for tests
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = origFetch; });

describe("omlx adapter", () => {
  test("default host = 8000", () => {
    expect(omlx.defaultHost).toBe("http://localhost:8000");
  });

  test("inferenceUrl + embeddingsUrl are OpenAI-compat", () => {
    expect(omlx.inferenceUrl("http://localhost:8000")).toBe(
      "http://localhost:8000/v1/chat/completions",
    );
    expect(omlx.embeddingsUrl("http://localhost:8000/v1")).toBe(
      "http://localhost:8000/v1/embeddings",
    );
  });

  test("listModels parses /v1/models OpenAI-compat rows", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3-4b-mlx",
              object: "model",
              alias: "qwen3-4b",
              directory_name: "qwen3-4b",
              loaded: true,
              context_length: 32768,
              type: "llm",
              quantization: "4bit",
            },
            {
              id: "bge-small-en-mlx",
              object: "model",
              loaded: false,
              type: "embeddings",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const models = await omlx.listModels("http://localhost:8000");
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "qwen3-4b-mlx",
      loaded: true,
      context_length: 32768,
      type: "llm",
      quantization: "4bit",
    });
    expect(models[1]).toMatchObject({ id: "bge-small-en-mlx", loaded: false, type: "embeddings" });
    expect(calls[0]!.url).toBe("http://localhost:8000/v1/models");
  });

  test("listModels passes Bearer token when api_key supplied", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await omlx.listModels("http://localhost:8000", { api_key: "omlx-key-123" });
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer omlx-key-123");
  });

  test("healthProbe ok path counts models", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }), {
        status: 200,
      }),
    );
    const h = await omlx.healthProbe("http://localhost:8000");
    expect(h.ok).toBe(true);
    expect(h.model_count).toBe(3);
    expect(h.reachable_at).toBe("http://localhost:8000/v1/models");
  });

  test("healthProbe fail path", async () => {
    mockFetch(() => new Response("nope", { status: 401 }));
    const h = await omlx.healthProbe("http://localhost:8000");
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("401");
  });

  test("pinModel is no-op with dashboard hint", async () => {
    const r = await omlx.pinModel!("http://localhost:8000", "qwen3-4b-mlx", 32768);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("dashboard");
    expect(calls.length).toBe(0);
  });

  test("unloadModel is no-op", async () => {
    const r = await omlx.unloadModel!("http://localhost:8000", "qwen3-4b-mlx");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("LRU");
  });
});
