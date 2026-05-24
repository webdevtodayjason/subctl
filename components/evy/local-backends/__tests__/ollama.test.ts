// components/evy/local-backends/__tests__/ollama.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ollama } from "../ollama";

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

describe("ollama adapter", () => {
  test("URLs use OpenAI-compat shim", () => {
    expect(ollama.inferenceUrl("http://localhost:11434")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(ollama.embeddingsUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1/embeddings",
    );
  });

  test("defaultHost = 11434", () => {
    expect(ollama.defaultHost).toBe("http://localhost:11434");
  });

  test("listModels cross-references /api/tags + /api/ps", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "llama3.2:latest",
                size: 2_000_000_000,
                digest: "abc",
                details: { quantization_level: "Q4_K_M" },
              },
              {
                name: "qwen2.5:7b",
                size: 4_000_000_000,
                digest: "def",
                details: { quantization_level: "Q5_K_M" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/ps")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2:latest" }] }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const models = await ollama.listModels("http://localhost:11434");
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: "llama3.2:latest", loaded: true, quantization: "Q4_K_M" });
    expect(models[1]).toMatchObject({ id: "qwen2.5:7b", loaded: false });
  });

  test("listModels falls back to 'unknown' when /api/ps fails", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "x:latest" }] }),
          { status: 200 },
        );
      }
      return new Response("", { status: 500 });
    });
    const models = await ollama.listModels("http://localhost:11434");
    expect(models[0]!.loaded).toBe("unknown");
  });

  test("healthProbe ok path", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ models: [{ name: "a" }] }), { status: 200 }),
    );
    const h = await ollama.healthProbe("http://localhost:11434");
    expect(h.ok).toBe(true);
    expect(h.model_count).toBe(1);
    expect(h.reachable_at).toBe("http://localhost:11434/api/tags");
  });

  test("healthProbe fail path", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const h = await ollama.healthProbe("http://localhost:11434");
    expect(h.ok).toBe(false);
  });

  test("pinModel is no-op with auto-load hint", async () => {
    mockFetch(() => new Response("", { status: 200 }));
    const r = await ollama.pinModel!("http://localhost:11434", "llama3.2", 8192);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("auto-loads");
    // no HTTP calls
    expect(calls.length).toBe(0);
  });

  test("unloadModel is no-op", async () => {
    const r = await ollama.unloadModel!("http://localhost:11434", "llama3.2");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("auto-evicts");
  });
});
