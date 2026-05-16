// components/master/__tests__/lmstudio-token.test.ts
//
// v2.7.4 — LM Studio's optional "Require API Token" server setting.
// These tests pin down the contract: when LMSTUDIO_API_TOKEN is set,
// every LM Studio HTTP call carries `Authorization: Bearer <token>`;
// when unset, behavior matches v2.7.3 exactly (no Authorization header
// on direct fetches, the "not-needed" sentinel goes to pi-ai). That
// back-compat path is non-negotiable — existing deploys without LM
// Studio token auth must keep working unchanged after this PR.
//
// Strategy:
//   - Save/restore process.env.LMSTUDIO_API_TOKEN per test (beforeEach
//     captures the original, afterEach restores). No leakage across
//     tests even when they run interleaved.
//   - For ensureModelLoaded we swap global.fetch for a recording stub
//     and assert on the captured init.headers. The stub returns a
//     minimal-but-valid response shape so the function actually walks
//     to the load() call we care about.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  ensureModelLoaded,
  getApiKeyForProvider,
  lmstudioAuthHeader,
} from "../server";

// ---------------------------------------------------------------------------
// env-var save/restore — every test mutates process.env, so we snapshot
// + restore to keep tests order-independent.
// ---------------------------------------------------------------------------

let savedToken: string | undefined;

beforeEach(() => {
  savedToken = process.env.LMSTUDIO_API_TOKEN;
  delete process.env.LMSTUDIO_API_TOKEN;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.LMSTUDIO_API_TOKEN;
  else process.env.LMSTUDIO_API_TOKEN = savedToken;
});

// ---------------------------------------------------------------------------
// lmstudioAuthHeader
// ---------------------------------------------------------------------------

describe("lmstudioAuthHeader", () => {
  test("returns {} when LMSTUDIO_API_TOKEN is unset (back-compat default)", () => {
    expect(lmstudioAuthHeader()).toEqual({});
  });

  test("returns {Authorization: Bearer <token>} when LMSTUDIO_API_TOKEN is set", () => {
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-AAAAAAAA:BBBBBBBBBBBB";
    expect(lmstudioAuthHeader()).toEqual({
      Authorization: "Bearer sk-lm-AAAAAAAA:BBBBBBBBBBBB",
    });
  });

  test("empty-string env var is treated as unset (no Authorization header)", () => {
    // process.env coerces values to strings; "" is the only falsy form a
    // shell can produce. Honor the same back-compat path as 'unset'.
    process.env.LMSTUDIO_API_TOKEN = "";
    expect(lmstudioAuthHeader()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getApiKeyForProvider — pi-ai's getApiKey callback
// ---------------------------------------------------------------------------

describe("getApiKeyForProvider", () => {
  test("lmstudio + token set → returns the token", () => {
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-DEADBEEF:CAFEBABE0000";
    expect(getApiKeyForProvider("lmstudio")).toBe("sk-lm-DEADBEEF:CAFEBABE0000");
  });

  test("lmstudio + token unset → returns 'not-needed' (back-compat)", () => {
    // CRITICAL: this is the back-compat path. Deploys without LM Studio
    // token auth must keep getting the "not-needed" sentinel exactly as
    // they did in v2.7.3.
    expect(getApiKeyForProvider("lmstudio")).toBe("not-needed");
  });

  test("mlx returns 'not-needed' regardless of LMSTUDIO_API_TOKEN", () => {
    expect(getApiKeyForProvider("mlx")).toBe("not-needed");
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-XXX:YYY";
    expect(getApiKeyForProvider("mlx")).toBe("not-needed");
  });

  test("ollama returns 'not-needed' regardless of LMSTUDIO_API_TOKEN", () => {
    expect(getApiKeyForProvider("ollama")).toBe("not-needed");
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-XXX:YYY";
    expect(getApiKeyForProvider("ollama")).toBe("not-needed");
  });

  test("vllm returns 'not-needed' regardless of LMSTUDIO_API_TOKEN", () => {
    expect(getApiKeyForProvider("vllm")).toBe("not-needed");
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-XXX:YYY";
    expect(getApiKeyForProvider("vllm")).toBe("not-needed");
  });

  test("real providers (anthropic, openai) return undefined — pi-ai picks up its own env", () => {
    expect(getApiKeyForProvider("anthropic")).toBeUndefined();
    expect(getApiKeyForProvider("openai")).toBeUndefined();
    // LM Studio token MUST NOT leak to other providers.
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-XXX:YYY";
    expect(getApiKeyForProvider("anthropic")).toBeUndefined();
    expect(getApiKeyForProvider("openai")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureModelLoaded — direct fetch() against LM Studio's native API
// ---------------------------------------------------------------------------
//
// ensureModelLoaded walks through three fetch sites:
//   1. GET  /api/v0/models             (probe load state)
//   2. POST /api/v1/models/unload      (only when ctx-pin needs reload)
//   3. POST /api/v1/models/load        (the actual pin)
// All three must carry the bearer header when LMSTUDIO_API_TOKEN is set,
// and none of them may carry it when it's unset.

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetchRecorder(
  modelsResponse: { data?: Array<{ id: string; state?: string; loaded_context_length?: number }> },
): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    // First call (/api/v0/models): return the configured catalog so
    // ensureModelLoaded proceeds past the "already loaded?" check.
    if (url.endsWith("/api/v0/models")) {
      return new Response(JSON.stringify(modelsResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Unload: 200 with no body — return value is ignored by the caller.
    if (url.endsWith("/api/v1/models/unload")) {
      return new Response("", { status: 200 });
    }
    // Load: surface the configured context so the success branch fires.
    if (url.endsWith("/api/v1/models/load")) {
      const body = init.body ? JSON.parse(init.body as string) as { context_length?: number } : {};
      return new Response(
        JSON.stringify({ load_config: { context_length: body.context_length ?? 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("ensureModelLoaded — Bearer header injection (v2.7.4)", () => {
  test("includes Bearer header on all LM Studio HTTP calls when LMSTUDIO_API_TOKEN is set", async () => {
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-AUTH1234:TOKEN5678";
    // Catalog where the model is "loaded" but with a smaller-than-desired ctx,
    // forcing the unload + load path so we exercise all three fetch sites.
    const { calls, restore } = installFetchRecorder({
      data: [{ id: "qwen/qwen3-30b-a3b", state: "loaded", loaded_context_length: 8192 }],
    });
    try {
      const result = await ensureModelLoaded(
        {
          provider: "lmstudio",
          model: "qwen/qwen3-30b-a3b",
          host: "http://localhost:1234/v1",
          context_length: 65536,
        },
        "supervisor",
      );
      expect(result.ok).toBe(true);
      // v2.8.9 — Asserts the invariant ("every LM Studio call carries the
      // Bearer when the token is set") regardless of how many calls
      // ensureModelLoaded ends up making. Previously this pinned 3 (probe
      // + unload + load), but a34f72a changed ensureModelLoaded to RESPECT
      // existing loads rather than unload+reload — the typical case now
      // makes just 1 call (the probe). The Bearer header invariant we
      // actually care about still holds for whatever calls do happen.
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const c of calls) {
        const headers = c.init.headers as Record<string, string> | undefined;
        expect(headers).toBeDefined();
        expect(headers!.Authorization).toBe("Bearer sk-lm-AUTH1234:TOKEN5678");
      }
    } finally {
      restore();
    }
  });

  test("omits Authorization header on all LM Studio HTTP calls when LMSTUDIO_API_TOKEN is unset (back-compat)", async () => {
    // No env var → behavior identical to v2.7.3. Pin a back-compat trip
    // wire here so a regression that "always injects something" fails.
    const { calls, restore } = installFetchRecorder({
      data: [{ id: "qwen/qwen3-30b-a3b", state: "loaded", loaded_context_length: 8192 }],
    });
    try {
      const result = await ensureModelLoaded(
        {
          provider: "lmstudio",
          model: "qwen/qwen3-30b-a3b",
          host: "http://localhost:1234/v1",
          context_length: 65536,
        },
        "supervisor",
      );
      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const c of calls) {
        const headers = (c.init.headers ?? {}) as Record<string, string>;
        // The load + unload calls still carry Content-Type; we only
        // forbid Authorization here.
        expect(headers.Authorization).toBeUndefined();
      }
    } finally {
      restore();
    }
  });

  test("non-lmstudio provider short-circuits before any fetch is issued", async () => {
    // Even with the env var set, ensureModelLoaded is a no-op for non-local
    // providers — no Bearer header can be sent because no fetch happens.
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-AUTH1234:TOKEN5678";
    const { calls, restore } = installFetchRecorder({ data: [] });
    try {
      const result = await ensureModelLoaded(
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          context_length: 65536,
        },
        "supervisor",
      );
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("cloud");
      expect(calls.length).toBe(0);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// diag tools — system_lmstudio_health respects the env var via the same
// helper (duplicated in diag.ts to keep the import graph disjoint). We
// inject deps.fetchText and assert the headers field carries the bearer.
// ---------------------------------------------------------------------------

import { diagTools, _setDepsForTesting, _resetDepsForTesting } from "../tools/diag";

describe("diag.system_lmstudio_health — Bearer header injection (v2.7.4)", () => {
  afterEach(() => {
    _resetDepsForTesting();
  });

  test("system_lmstudio_health threads LMSTUDIO_API_TOKEN through to fetchText.headers", async () => {
    process.env.LMSTUDIO_API_TOKEN = "sk-lm-HEALTH:1111";
    const recorded: Array<{ url: string; headers?: Record<string, string> }> = [];
    _setDepsForTesting({
      fetchText: async (url, opts) => {
        recorded.push({ url, headers: opts?.headers });
        // First call: /v1/models → return a single fake model so the
        // health tool proceeds to the chat-completions ping.
        if (url.endsWith("/v1/models")) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ data: [{ id: "fake-model" }] }),
            latencyMs: 4,
          };
        }
        // /v1/chat/completions ping — return OK.
        if (url.endsWith("/v1/chat/completions")) {
          return { ok: true, status: 200, text: "{}", latencyMs: 7 };
        }
        return { ok: false, status: 404, text: "", latencyMs: 0 };
      },
    });
    const result = await (diagTools.system_lmstudio_health.invoke as () => Promise<{ ok: boolean }>)();
    expect(result.ok).toBe(true);
    expect(recorded.length).toBe(2);
    for (const r of recorded) {
      expect(r.headers).toBeDefined();
      expect(r.headers!.Authorization).toBe("Bearer sk-lm-HEALTH:1111");
    }
  });

  test("system_lmstudio_health omits Authorization when LMSTUDIO_API_TOKEN is unset", async () => {
    const recorded: Array<{ url: string; headers?: Record<string, string> }> = [];
    _setDepsForTesting({
      fetchText: async (url, opts) => {
        recorded.push({ url, headers: opts?.headers });
        if (url.endsWith("/v1/models")) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({ data: [{ id: "fake-model" }] }),
            latencyMs: 4,
          };
        }
        return { ok: true, status: 200, text: "{}", latencyMs: 7 };
      },
    });
    await (diagTools.system_lmstudio_health.invoke as () => Promise<unknown>)();
    expect(recorded.length).toBe(2);
    for (const r of recorded) {
      // Helper returned {} → fetchText sees an empty headers object (or none).
      const auth = (r.headers ?? {}).Authorization;
      expect(auth).toBeUndefined();
    }
  });
});
