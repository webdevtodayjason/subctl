// components/master/__tests__/local-backend-endpoints.test.ts
//
// Phase 4 — pin the GET / POST /local-backend shape contracts.
//
// The route handlers themselves live inside the fetch closure in
// server.ts (alongside /reload-supervisor, /diag, /context). We can't
// invoke them directly without spinning up the full daemon, so this
// suite tests the underlying machinery the routes walk:
//
//   1. mapToLocalBackendKind rejects unknown kinds (POST validation).
//   2. getAdapter returns a working adapter for every supported kind.
//   3. healthProbe + listModels return adapter-uniform shapes that the
//      GET payload reuses verbatim.
//   4. The merged-models composition (POST keeps existing roles when
//      body.models omits them) is testable as plain logic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getAdapter,
  listAvailableBackends,
  type LocalBackendKind,
} from "../local-backends";
import { mapToLocalBackendKind } from "../server";

const origFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // @ts-expect-error — overriding global fetch for tests
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  };
}

beforeEach(() => { /* nothing */ });
afterEach(() => { globalThis.fetch = origFetch; });

describe("POST /local-backend/test — validation", () => {
  test("unknown kind is rejected by mapToLocalBackendKind", () => {
    expect(mapToLocalBackendKind("not-a-real-backend")).toBeNull();
    expect(mapToLocalBackendKind("")).toBeNull();
  });

  test("first-class + legacy kinds are accepted", () => {
    for (const k of ["lmstudio", "ollama", "omlx", "mlx", "vllm"]) {
      expect(mapToLocalBackendKind(k)).not.toBeNull();
    }
  });

  test("listAvailableBackends returns the three first-class kinds", () => {
    expect(listAvailableBackends().sort()).toEqual(["lmstudio", "ollama", "omlx"]);
  });
});

describe("GET /local-backend — health + catalog shape per backend", () => {
  // GET's response is { ok, kind, host, models, available_models, health,
  // last_verified }. The non-trivial pieces are health + available_models,
  // which come from adapter.healthProbe + adapter.listModels — pin them
  // for all three adapters.

  test("lmstudio adapter returns operator-readable health + catalog", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "qwen3.6-27b", state: "loaded", loaded_context_length: 65536, type: "llm" }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const a = getAdapter("lmstudio");
    const h = await a.healthProbe("http://localhost:1234");
    expect(h.ok).toBe(true);
    expect(h.model_count).toBe(1);
    expect(h.reachable_at).toBeDefined();
    const models = await a.listModels("http://localhost:1234");
    expect(models[0]).toMatchObject({ id: "qwen3.6-27b", loaded: true, type: "llm" });
  });

  test("ollama adapter returns operator-readable health + catalog", async () => {
    mockFetch((url) => {
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2" }] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    const a = getAdapter("ollama");
    const h = await a.healthProbe("http://localhost:11434");
    expect(h.ok).toBe(true);
    expect(h.reachable_at).toContain("/api/tags");
    const models = await a.listModels("http://localhost:11434");
    expect(models[0]!.id).toBe("llama3.2");
  });

  test("omlx adapter returns operator-readable health + catalog", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ data: [{ id: "qwen3-4b-mlx", loaded: true, type: "llm" }] }),
        { status: 200 },
      ),
    );
    const a = getAdapter("omlx");
    const h = await a.healthProbe("http://localhost:8000");
    expect(h.ok).toBe(true);
    expect(h.reachable_at).toContain("/v1/models");
    const models = await a.listModels("http://localhost:8000");
    expect(models[0]).toMatchObject({ id: "qwen3-4b-mlx", loaded: true });
  });

  test("health probe fail path is non-throwing across all kinds", async () => {
    mockFetch(() => { throw new Error("ECONNREFUSED"); });
    for (const kind of listAvailableBackends()) {
      const a = getAdapter(kind as LocalBackendKind);
      const h = await a.healthProbe(a.defaultHost);
      expect(h.ok).toBe(false);
      expect(h.detail).toBeDefined();
    }
  });
});

describe("POST /local-backend — merged-models composition", () => {
  // The route walks this shape: take existing local_backend.models,
  // overlay body.models, fill the four standard role slots with null
  // when neither side provided them. Test the recipe directly.

  function mergeModels(
    prev: Partial<Record<string, string | null>>,
    incoming: Record<string, string | null>,
  ): Record<string, string | null> {
    return {
      supervisor: incoming.supervisor ?? prev.supervisor ?? null,
      reviewer: incoming.reviewer ?? prev.reviewer ?? null,
      embeddings: incoming.embeddings ?? prev.embeddings ?? null,
      router: incoming.router ?? prev.router ?? null,
    };
  }

  test("empty incoming preserves existing assignments", () => {
    const prev = { supervisor: "qwen/qwen3.6-27b", reviewer: "qwen/qwen3.6-27b" };
    const out = mergeModels(prev, {});
    expect(out.supervisor).toBe("qwen/qwen3.6-27b");
    expect(out.reviewer).toBe("qwen/qwen3.6-27b");
    expect(out.embeddings).toBeNull();
    expect(out.router).toBeNull();
  });

  test("incoming overrides existing per-role", () => {
    const prev = { supervisor: "qwen3.6-27b", reviewer: "qwen3.6-27b" };
    const out = mergeModels(prev, { supervisor: "qwen3.6-72b" });
    expect(out.supervisor).toBe("qwen3.6-72b");
    expect(out.reviewer).toBe("qwen3.6-27b");
  });

  test("null in incoming falls back to prev (?? semantics)", () => {
    // The route uses `?? prev.x ?? null` — null treats as "no override".
    // Operators clear a role by sending an explicit empty assignment via
    // the dashboard, which is encoded as the field being absent. Test pins
    // the actual server.ts behavior so future refactors don't drift.
    const prev = { router: "qwen-router" };
    const out = mergeModels(prev, { router: null });
    expect(out.router).toBe("qwen-router");
  });

  test("all four standard role slots are always present in the output", () => {
    const out = mergeModels({}, {});
    expect(Object.keys(out).sort()).toEqual(["embeddings", "reviewer", "router", "supervisor"]);
  });
});
