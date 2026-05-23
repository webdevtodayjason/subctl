// components/master/__tests__/aggregator-clients.test.ts
//
// v2.9.1 — Provider Model Catalog Phase 3 — aggregator routing tests.
//
// Coverage:
//   1. openrouterFetchCatalog normalizes the upstream response into
//      UpstreamModel[] correctly (uses a trimmed real-shape fixture)
//   2. Mock fetch — no real network in CI
//   3. 401 from openrouter → ok:false with hint
//   4. Network error → ok:false with error message
//   5. Cache TTL: fresh cache returns cached source without re-fetch;
//      stale cache triggers a live fetch
//   6. Bedrock + Cloudflare stubs return the expected error shape
//   7. AGGREGATOR_PROVIDER_IDS / isAggregatorProvider contract
//   8. fetchUpstreamCatalog rejects non-aggregator ids
//   9. writeCatalogFile / readCachedFresh round-trip preserves
//      capability flags
//  10. Live fetch persists into the existing per-provider catalog
//      file shape

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGGREGATOR_PROVIDER_IDS,
  bedrockFetchCatalog,
  cloudflareFetchCatalog,
  fetchUpstreamCatalog,
  isAggregatorProvider,
  openrouterFetchCatalog,
  vercelFetchCatalog,
  UPSTREAM_CACHE_TTL_MS,
  _setFetchForTesting,
} from "../aggregator-clients";

// ---------------------------------------------------------------------------
// Per-test tmpdir for the catalogs cache. Without this, writeCatalogFile()
// would land in the operator's real ~/.config/subctl/catalogs/ and the
// tests would cross-contaminate the dashboard's view.
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-aggregator-test-"));
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  process.env.SUBCTL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  _setFetchForTesting(null);
  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

function catalogPath(provider: string): string {
  return join(tmpDir, "catalogs", `${provider}.json`);
}

// ---------------------------------------------------------------------------
// Trimmed OpenRouter /api/v1/models fixture. Captured shape — real
// responses have ~300 models; this is two with full field coverage so
// the normalizer's mapping is verifiable end-to-end.
// ---------------------------------------------------------------------------

const OPENROUTER_FIXTURE = {
  data: [
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Anthropic: Claude 3.5 Sonnet",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: {
        input_modalities: ["text", "image"],
        modality: "text+image->text",
      },
      supported_parameters: ["tools", "tool_choice", "max_tokens"],
    },
    {
      id: "deepseek/deepseek-r1",
      name: "DeepSeek R1",
      context_length: 64000,
      pricing: { prompt: "0.00000055", completion: "0.0000022" },
      architecture: { input_modalities: ["text"], modality: "text->text" },
      supported_parameters: ["reasoning", "max_tokens"],
      deprecated: false,
    },
    {
      id: "weirdvendor/free-preview",
      // sparse: no pricing, no architecture, no params
    },
  ],
};

function mockFetchOk(payload: unknown): void {
  _setFetchForTesting(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchStatus(status: number, payload: unknown = {}): void {
  _setFetchForTesting(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchThrows(err: Error): void {
  _setFetchForTesting(async () => {
    throw err;
  });
}

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

describe("openrouterFetchCatalog — normalization", () => {
  test("maps the captured fixture into UpstreamModel[]", async () => {
    mockFetchOk(OPENROUTER_FIXTURE);
    const res = await openrouterFetchCatalog(undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.models).toHaveLength(3);

    // Claude row: full capability detection
    const claude = res.models.find((m) => m.id === "anthropic/claude-3.5-sonnet");
    expect(claude).toBeDefined();
    expect(claude?.name).toBe("Anthropic: Claude 3.5 Sonnet");
    expect(claude?.context_length).toBe(200000);
    expect(claude?.pricing_per_1m_input).toBeCloseTo(3, 5);
    expect(claude?.pricing_per_1m_output).toBeCloseTo(15, 5);
    expect(claude?.supports_tools).toBe(true);
    expect(claude?.supports_vision).toBe(true);
    expect(claude?.supports_reasoning).toBe(false);
    expect(claude?.provider_id).toBe("anthropic");

    // DeepSeek R1: reasoning flag, no tools, no vision
    const ds = res.models.find((m) => m.id === "deepseek/deepseek-r1");
    expect(ds?.supports_reasoning).toBe(true);
    expect(ds?.supports_tools).toBe(false);
    expect(ds?.supports_vision).toBe(false);
    expect(ds?.pricing_per_1m_input).toBeCloseTo(0.55, 5);

    // Sparse row: undefined fields don't crash, id flows through
    const sparse = res.models.find((m) => m.id === "weirdvendor/free-preview");
    expect(sparse).toBeDefined();
    expect(sparse?.context_length).toBeUndefined();
    expect(sparse?.pricing_per_1m_input).toBeUndefined();
    expect(sparse?.supports_tools).toBe(false);
    expect(sparse?.provider_id).toBe("weirdvendor");
  });

  test("source is 'live' and fetched_at is ISO", async () => {
    mockFetchOk(OPENROUTER_FIXTURE);
    const res = await openrouterFetchCatalog(undefined);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("live");
    expect(new Date(res.fetched_at).toString()).not.toBe("Invalid Date");
  });
});

// ---------------------------------------------------------------------------
// 2. Auth failure path
// ---------------------------------------------------------------------------

describe("openrouterFetchCatalog — error paths", () => {
  test("401 surfaces with hint", async () => {
    mockFetchStatus(401, { error: { message: "bad key" } });
    const res = await openrouterFetchCatalog("sk-or-v1-bogus");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("401");
    expect(res.hint).toContain("openrouter_api_key");
  });

  test("network error surfaces the underlying message", async () => {
    mockFetchThrows(new Error("ECONNREFUSED 127.0.0.1:443"));
    const res = await openrouterFetchCatalog(undefined);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("ECONNREFUSED");
  });

  test("non-401 HTTP error surfaces without hint", async () => {
    mockFetchStatus(503);
    const res = await openrouterFetchCatalog(undefined);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("503");
    expect((res as { hint?: string }).hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Cache TTL behavior
// ---------------------------------------------------------------------------

describe("fetchUpstreamCatalog — cache TTL", () => {
  test("fresh cache returns source='cached' without firing fetch", async () => {
    // Seed the cache file directly.
    const fresh = new Date().toISOString();
    const dir = join(tmpDir, "catalogs");
    if (!existsSync(dir)) require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "openrouter.json"),
      JSON.stringify({
        provider: "openrouter",
        fetched_at: fresh,
        source: "live-fetch",
        upstream_fetched_at: fresh,
        models: [
          {
            id: "anthropic/claude-3.5-sonnet",
            name: "Anthropic: Claude 3.5 Sonnet",
            context_window: 200000,
            cost: { input: 3, output: 15 },
            supports_tools: true,
            supports_vision: true,
            supports_reasoning: false,
            enabled: true,
          },
        ],
      }),
    );

    let fetchCalls = 0;
    _setFetchForTesting(async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    });

    const res = await fetchUpstreamCatalog("openrouter");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("cached");
    expect(fetchCalls).toBe(0);
    expect(res.models[0]?.id).toBe("anthropic/claude-3.5-sonnet");
    expect(res.models[0]?.supports_tools).toBe(true);
    expect(res.models[0]?.context_length).toBe(200000);
    expect(res.models[0]?.pricing_per_1m_input).toBe(3);
  });

  test("stale cache (past TTL) triggers a live fetch", async () => {
    // Seed an aged-out cache.
    const stale = new Date(Date.now() - UPSTREAM_CACHE_TTL_MS - 60_000).toISOString();
    const dir = join(tmpDir, "catalogs");
    if (!existsSync(dir)) require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "openrouter.json"),
      JSON.stringify({
        provider: "openrouter",
        fetched_at: stale,
        source: "live-fetch",
        upstream_fetched_at: stale,
        models: [{ id: "old/model", name: "old", enabled: true }],
      }),
    );

    let fetchCalls = 0;
    _setFetchForTesting(async () => {
      fetchCalls++;
      return new Response(JSON.stringify(OPENROUTER_FIXTURE), { status: 200 });
    });

    const res = await fetchUpstreamCatalog("openrouter");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("live");
    expect(fetchCalls).toBe(1);
    expect(res.models.find((m) => m.id === "anthropic/claude-3.5-sonnet")).toBeDefined();
  });

  test("forceLive: true bypasses the cache even when fresh", async () => {
    const fresh = new Date().toISOString();
    const dir = join(tmpDir, "catalogs");
    if (!existsSync(dir)) require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "openrouter.json"),
      JSON.stringify({
        provider: "openrouter",
        fetched_at: fresh,
        source: "live-fetch",
        upstream_fetched_at: fresh,
        models: [{ id: "cached/one", name: "cached", enabled: true }],
      }),
    );

    let fetchCalls = 0;
    _setFetchForTesting(async () => {
      fetchCalls++;
      return new Response(JSON.stringify(OPENROUTER_FIXTURE), { status: 200 });
    });

    const res = await fetchUpstreamCatalog("openrouter", { forceLive: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("live");
    expect(fetchCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Live fetch persists to the existing per-provider catalog file
// ---------------------------------------------------------------------------

describe("fetchUpstreamCatalog — persistence", () => {
  test("successful live fetch writes <provider>.json with CatalogFile shape", async () => {
    mockFetchOk(OPENROUTER_FIXTURE);
    const res = await fetchUpstreamCatalog("openrouter", { forceLive: true });
    expect(res.ok).toBe(true);
    expect(existsSync(catalogPath("openrouter"))).toBe(true);
    const onDisk = JSON.parse(readFileSync(catalogPath("openrouter"), "utf8"));
    expect(onDisk.provider).toBe("openrouter");
    // Reuses the existing live-fetch literal so dashboard's Models panel
    // labels it "live · Nm ago" correctly. The upstream cache TTL keys
    // off `upstream_fetched_at`, not `source`.
    expect(onDisk.source).toBe("live-fetch");
    expect(onDisk.upstream_fetched_at).toBeDefined();
    expect(Array.isArray(onDisk.models)).toBe(true);
    const claude = onDisk.models.find((m: { id: string }) => m.id === "anthropic/claude-3.5-sonnet");
    // CatalogFile-shape fields preserved for the existing reader:
    expect(claude.context_window).toBe(200000);
    expect(claude.cost.input).toBeCloseTo(3, 5);
    expect(claude.cost.output).toBeCloseTo(15, 5);
    expect(claude.enabled).toBe(false); // seeded disabled; operator opts in
    // Phase 3 capability flags survive serialization:
    expect(claude.supports_tools).toBe(true);
    expect(claude.supports_vision).toBe(true);
  });

  test("re-fetch carries enabled flags from prior catalog file", async () => {
    // First fetch — everything seeded disabled.
    mockFetchOk(OPENROUTER_FIXTURE);
    await fetchUpstreamCatalog("openrouter", { forceLive: true });

    // Operator opts a model in by writing the file directly (simulating
    // the /api/catalogs/<p>/models/<id>/enabled endpoint).
    const path = catalogPath("openrouter");
    const file = JSON.parse(readFileSync(path, "utf8"));
    const claudeIdx = file.models.findIndex((m: { id: string }) => m.id === "anthropic/claude-3.5-sonnet");
    file.models[claudeIdx].enabled = true;
    writeFileSync(path, JSON.stringify(file));

    // Re-fetch (forceLive) — the carry-forward must preserve enabled=true.
    mockFetchOk(OPENROUTER_FIXTURE);
    const res = await fetchUpstreamCatalog("openrouter", { forceLive: true });
    expect(res.ok).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    const claudeAfter = after.models.find((m: { id: string }) => m.id === "anthropic/claude-3.5-sonnet");
    expect(claudeAfter.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Bedrock / Cloudflare stubs
// ---------------------------------------------------------------------------

describe("stubbed aggregators", () => {
  test("bedrockFetchCatalog returns ok:false with hint", async () => {
    const res = await bedrockFetchCatalog(undefined);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("bedrock");
    expect(res.hint).toBeDefined();
  });

  test("cloudflareFetchCatalog returns ok:false with hint", async () => {
    const res = await cloudflareFetchCatalog(undefined);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("cloudflare");
    expect(res.hint).toBeDefined();
  });

  test("fetchUpstreamCatalog returns 502-shape errors for stubbed clients", async () => {
    const a = await fetchUpstreamCatalog("amazon-bedrock", { forceLive: true });
    expect(a.ok).toBe(false);
    const b = await fetchUpstreamCatalog("cloudflare-ai-gateway", { forceLive: true });
    expect(b.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Vercel happy path (best-effort parser)
// ---------------------------------------------------------------------------

describe("vercelFetchCatalog", () => {
  test("normalizes OpenAI-compat /v1/models envelope", async () => {
    mockFetchOk({
      data: [
        {
          id: "anthropic/claude-3.5-sonnet",
          display_name: "Claude 3.5 Sonnet",
          context_window: 200000,
          pricing: { input: 3, output: 15 },
          capabilities: ["tools", "vision"],
        },
      ],
    });
    const res = await vercelFetchCatalog("AI_GATEWAY_TEST_KEY");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.models[0]?.id).toBe("anthropic/claude-3.5-sonnet");
    expect(res.models[0]?.supports_tools).toBe(true);
    expect(res.models[0]?.supports_vision).toBe(true);
    expect(res.models[0]?.pricing_per_1m_input).toBe(3);
  });

  test("403 surfaces auth-style hint", async () => {
    mockFetchStatus(403, { error: "forbidden" });
    const res = await vercelFetchCatalog("bad-key");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("403");
    expect(res.hint).toContain("vercel_api_key");
  });
});

// ---------------------------------------------------------------------------
// 7. Aggregator registry contract
// ---------------------------------------------------------------------------

describe("aggregator registry", () => {
  test("AGGREGATOR_PROVIDER_IDS lists the four canonical ids", () => {
    expect(AGGREGATOR_PROVIDER_IDS).toEqual([
      "openrouter",
      "amazon-bedrock",
      "vercel-ai-gateway",
      "cloudflare-ai-gateway",
    ]);
  });

  test("isAggregatorProvider recognises aggregator ids and rejects direct providers", () => {
    expect(isAggregatorProvider("openrouter")).toBe(true);
    expect(isAggregatorProvider("amazon-bedrock")).toBe(true);
    expect(isAggregatorProvider("anthropic")).toBe(false);
    expect(isAggregatorProvider("openai")).toBe(false);
    expect(isAggregatorProvider("")).toBe(false);
  });

  test("fetchUpstreamCatalog rejects non-aggregator ids with a clear error", async () => {
    const res = await fetchUpstreamCatalog("anthropic", { forceLive: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not an aggregator");
    expect(res.error).toContain("openrouter");
  });
});
