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
import { getApiKeyForProvider, mapToLocalBackendKind } from "../server";

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

describe("oMLX auth resolution (CodeRabbit pass-3 #3)", () => {
  // oMLX supports optional `--api-key` server-side auth. Mirror the
  // LM Studio pattern so chat-turn dispatch via openai-completions
  // carries `Authorization: Bearer <token>` when the operator has set
  // it. Resolution order: env (`OMLX_API_TOKEN`, via envVarFor's
  // uppercase fallback) → secrets.json#omlx_api_token → "not-needed"
  // sentinel for localhost-bypass deployments.

  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.OMLX_API_TOKEN;
    delete process.env.OMLX_API_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.OMLX_API_TOKEN;
    else process.env.OMLX_API_TOKEN = savedToken;
  });

  test("omlx + env token set → returns the token (used by pi-ai dispatch)", () => {
    process.env.OMLX_API_TOKEN = "sk-omlx-DEADBEEF";
    expect(getApiKeyForProvider("omlx")).toBe("sk-omlx-DEADBEEF");
  });

  test("omlx + token unset → returns 'not-needed' (localhost-bypass back-compat)", () => {
    expect(getApiKeyForProvider("omlx")).toBe("not-needed");
  });

  test("omlx token MUST NOT leak to cloud providers", () => {
    // Mirrors the LMSTUDIO-token leak test in secrets.test.ts: a local-
    // backend token must never appear as the api_key for a real cloud
    // provider. (lmstudio is omitted from the assertion because its
    // env-resolution interacts with the operator's running launchd
    // plist; the secrets.test.ts suite already pins that path.)
    process.env.OMLX_API_TOKEN = "sk-omlx-DEADBEEF";
    expect(getApiKeyForProvider("anthropic")).toBeUndefined();
    expect(getApiKeyForProvider("openai")).toBeUndefined();
  });
});

describe("POST /local-backend — merged-models composition", () => {
  // The route walks this shape: take existing local_backend.models,
  // overlay body.models, fill the four standard role slots with null
  // when neither side provided them. Test the recipe directly.
  //
  // CodeRabbit pass-4 (b): merge uses presence-check semantics so an
  // explicit `null` in `incoming` CLEARS the role. Key absent → fall
  // back to prev. `normalizeModel` still applies in both branches for
  // type / empty-string sanitization (pass-1 invariant).

  function normalizeModel(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  function mergeModels(
    prev: Partial<Record<string, string | null>>,
    incoming: Record<string, unknown>,
  ): Record<string, string | null> {
    const pick = (role: "supervisor" | "reviewer" | "embeddings" | "router"): string | null => {
      if (Object.prototype.hasOwnProperty.call(incoming, role)) {
        return normalizeModel(incoming[role]);
      }
      return normalizeModel(prev[role]);
    };
    return {
      supervisor: pick("supervisor"),
      reviewer: pick("reviewer"),
      embeddings: pick("embeddings"),
      router: pick("router"),
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

  test("explicit null in incoming clears the role (CodeRabbit pass-4 (b))", () => {
    // Operators clear a role by sending an explicit null via the dashboard
    // (Settings → Local Inference Backend → "— disabled —" → Save). The
    // Save payload always includes all four role keys; "— disabled —"
    // encodes as null. The merge MUST distinguish "key present + null"
    // (clear) from "key absent" (fall back to prev).
    const prev = { router: "qwen-router" };
    const out = mergeModels(prev, { router: null });
    expect(out.router).toBeNull();
  });

  test("absent key falls back to prev (presence-check semantics)", () => {
    const prev = { router: "qwen-router", supervisor: "qwen-sup" };
    const out = mergeModels(prev, { supervisor: "qwen-sup-new" });
    expect(out.router).toBe("qwen-router");
    expect(out.supervisor).toBe("qwen-sup-new");
  });

  test("incoming empty-string sanitizes to null (normalizeModel invariant)", () => {
    const prev = { router: "qwen-router" };
    const out = mergeModels(prev, { router: "   " });
    expect(out.router).toBeNull();
  });

  test("all four standard role slots are always present in the output", () => {
    const out = mergeModels({}, {});
    expect(Object.keys(out).sort()).toEqual(["embeddings", "reviewer", "router", "supervisor"]);
  });
});
