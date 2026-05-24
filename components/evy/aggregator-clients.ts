// components/master/aggregator-clients.ts
//
// v2.9.1 — Provider Model Catalog Phase 3 — aggregator routing.
//
// Direct providers (Anthropic, OpenAI, Google, …) own their model
// namespace — "claude-sonnet-4-6" unambiguously refers to one model.
// Aggregator providers (OpenRouter, AWS Bedrock, Vercel AI Gateway,
// Cloudflare AI Gateway) serve ~30 upstream providers under namespaced
// ids ("anthropic/claude-sonnet-4-6", "openai/gpt-5", …) and the
// aggregator's catalog endpoint returns first-class signal we want to
// surface: cost per million tokens, context window, capability flags.
//
// This module is the master-daemon-side normalization layer. One client
// per aggregator hits the upstream catalog, normalizes the response
// into a unified UpstreamModel[] shape, and the dispatcher caches the
// result in `~/.config/subctl/catalogs/<id>.json` (the same on-disk
// file the existing per-provider catalog reader uses, see
// dashboard/lib/catalogs.ts). The shape extends CatalogFile by adding
// extra optional fields on models[] for capabilities — TypeScript types
// don't strip at runtime, the existing setModelEnabled() spread
// preserves unknown fields, so the existing dashboard catalog code path
// continues to work and capability data round-trips through
// enable/disable toggles.
//
// Known limitation: dashboard/lib/catalogs.ts:refreshOpenRouter() in
// v2.9.0 rebuilds models[] from scratch and clobbers extra fields. So
// clicking the existing "↻ refresh" button in the Models panel after
// using the Browse Upstream Catalog modal will lose capability data
// until the next upstream re-fetch. Fixing this would require modifying
// dashboard/lib/catalogs.ts which is out of scope here; documented in
// the CHANGELOG.
//
// Bedrock: stubbed. AWS SDK isn't bundled and pulling it in for this
// scope is too heavy; the client surface returns an error_with hint so
// the UI can surface "needs @aws-sdk/client-bedrock" cleanly without
// the dashboard having to special-case provider ids.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveSecret } from "./secrets";

// ──────────────────────────────────────────────────────────────────────────
// Public shape — what the API returns and the modal consumes
// ──────────────────────────────────────────────────────────────────────────

/**
 * The normalized per-model record returned by every aggregator client.
 * Aggregator catalogs vary wildly in shape; this is the smallest stable
 * union we can surface to the UI without leaking provider-specific
 * fields. All fields except `id` are optional — upstream catalogs are
 * frequently sparse.
 */
export interface UpstreamModel {
  /** Namespaced model id as the aggregator routes it (e.g.
   *  "anthropic/claude-sonnet-4-6", "openai/gpt-4o"). Passed verbatim
   *  to the chat request when this model is invoked through the
   *  aggregator. */
  id: string;
  /** Display name. Falls back to `id` when the aggregator returns nothing. */
  name?: string;
  /** Max context window in tokens. */
  context_length?: number;
  /** USD per million input tokens. Normalized from per-token strings
   *  (OpenRouter ships these) or per-million floats (Vercel). */
  pricing_per_1m_input?: number;
  /** USD per million output tokens. */
  pricing_per_1m_output?: number;
  /** Model accepts `tools` parameter. */
  supports_tools?: boolean;
  /** Model accepts image input. */
  supports_vision?: boolean;
  /** Model emits reasoning channel / chain-of-thought tokens. */
  supports_reasoning?: boolean;
  /** Aggregator has flagged this model as deprecated. */
  deprecated?: boolean;
  /** Upstream provider id within the aggregator (e.g. "anthropic",
   *  "openai") — derived from the slash-prefix of `id` when not
   *  reported separately. */
  provider_id?: string;
}

/**
 * Result of a single aggregator fetch / cache read. Discriminated by
 * `ok`. The error path carries a `hint` so the dashboard can render
 * actionable instructions ("set openrouter_api_key in secrets") rather
 * than a generic error string.
 */
export type AggregatorResult =
  | {
      ok: true;
      source: "live" | "cached";
      fetched_at: string;
      models: UpstreamModel[];
    }
  | {
      ok: false;
      error: string;
      hint?: string;
    };

// ──────────────────────────────────────────────────────────────────────────
// Aggregator registry
// ──────────────────────────────────────────────────────────────────────────

/**
 * The four aggregator providers Phase 3 ships with. Adding a new
 * aggregator: append here AND add a case in `fetchUpstreamCatalog()`
 * below. Mirrored as a Set on the dashboard side
 * (`/api/providers` → `is_aggregator` flag) — keep the two lists in
 * sync.
 */
export const AGGREGATOR_PROVIDER_IDS = [
  "openrouter",
  "amazon-bedrock",
  "vercel-ai-gateway",
  "cloudflare-ai-gateway",
] as const;
export type AggregatorProviderId = (typeof AGGREGATOR_PROVIDER_IDS)[number];

export function isAggregatorProvider(id: string): id is AggregatorProviderId {
  return (AGGREGATOR_PROVIDER_IDS as readonly string[]).includes(id);
}

// ──────────────────────────────────────────────────────────────────────────
// Cache: on-disk in the existing per-provider catalog file
// ──────────────────────────────────────────────────────────────────────────

/** TTL for the live-fetched aggregator catalog. Aggregator catalogs
 *  change at a slow weekly cadence — a 24h ceiling keeps the dashboard
 *  responsive while not hammering the upstream API on every modal open. */
export const UPSTREAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function catalogsDir(): string {
  const base = process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(base, "catalogs");
}

function catalogPath(provider: string): string {
  const safe = provider.replace(/[^a-z0-9_-]/gi, "");
  return join(catalogsDir(), `${safe}.json`);
}

function ensureCatalogsDir(): void {
  const dir = catalogsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * The on-disk shape — a superset of dashboard/lib/catalogs.ts
 * `CatalogFile`. We write the same fields that file uses (so the
 * existing reader can still parse + render the catalog) PLUS the rich
 * UpstreamModel fields (which the existing reader ignores). The
 * `upstream_fetched_at` sibling field is the aggregator-specific
 * "last live fetch" timestamp used for TTL — distinct from the existing
 * `fetched_at` which means "last file write" in the legacy code path.
 */
interface CatalogFileOnDisk {
  provider: string;
  fetched_at: string;
  /** Reuses the existing `live-fetch` literal so dashboard's Models
   *  panel labels the catalog "live · Nm ago" correctly. The
   *  aggregator-specific cache TTL keys off `upstream_fetched_at`
   *  below, not this field. */
  source: "pi-ai-bundle" | "live-fetch";
  source_url?: string;
  /** Aggregator-specific. Distinct from `fetched_at` so a Models-panel
   *  "↻ refresh" click doesn't accidentally reset the upstream cache
   *  age — only an aggregator-clients write updates this field. */
  upstream_fetched_at?: string;
  models: CatalogModelOnDisk[];
}

interface CatalogModelOnDisk {
  id: string;
  name: string;
  api?: string;
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  enabled: boolean;
  // Phase 3 additions — survive the spread in setModelEnabled() because
  // {...obj, enabled} preserves unknown keys.
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  deprecated?: boolean;
  provider_id?: string;
}

function loadCatalogFile(provider: string): CatalogFileOnDisk | null {
  const path = catalogPath(provider);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.provider !== "string" || !Array.isArray(parsed.models)) return null;
    return parsed as CatalogFileOnDisk;
  } catch {
    return null;
  }
}

/**
 * Reconcile `enabled` flags from the prior on-disk catalog when present.
 * Mirrors dashboard/lib/catalogs.ts:reconcileEnabled() — operator
 * curation must survive a Browse Upstream Catalog re-fetch. New models
 * (not in prior) seed enabled:false; the operator opts them in via the
 * checkbox in the new modal. First-ever fetch seeds everything
 * enabled:false (the operator hasn't picked anything yet; the chat
 * dropdown gates on enabled).
 */
function carryEnabledFlags(
  fresh: CatalogModelOnDisk[],
  prior: CatalogFileOnDisk | null,
): CatalogModelOnDisk[] {
  if (!prior) return fresh; // already enabled:false on the input side
  const priorEnabled = new Map(
    prior.models.map((m) => [m.id, m.enabled !== false] as const),
  );
  return fresh.map((m) => ({
    ...m,
    enabled: priorEnabled.has(m.id) ? priorEnabled.get(m.id)! : false,
  }));
}

/** Translate UpstreamModel → on-disk CatalogModel shape. */
function toOnDisk(m: UpstreamModel): CatalogModelOnDisk {
  return {
    id: m.id,
    name: m.name ?? m.id,
    context_window: m.context_length,
    input: m.supports_vision ? ["text", "image"] : ["text"],
    reasoning: m.supports_reasoning,
    cost: (m.pricing_per_1m_input != null || m.pricing_per_1m_output != null)
      ? { input: m.pricing_per_1m_input, output: m.pricing_per_1m_output }
      : undefined,
    enabled: false,
    supports_tools: m.supports_tools,
    supports_vision: m.supports_vision,
    supports_reasoning: m.supports_reasoning,
    deprecated: m.deprecated,
    provider_id: m.provider_id,
  };
}

/** Translate on-disk CatalogModel → UpstreamModel. */
function fromOnDisk(m: CatalogModelOnDisk): UpstreamModel {
  return {
    id: m.id,
    name: m.name,
    context_length: m.context_window,
    pricing_per_1m_input: m.cost?.input,
    pricing_per_1m_output: m.cost?.output,
    supports_tools: m.supports_tools,
    supports_vision: m.supports_vision,
    supports_reasoning: m.supports_reasoning ?? m.reasoning,
    deprecated: m.deprecated,
    provider_id: m.provider_id ?? deriveProviderId(m.id),
  };
}

function deriveProviderId(modelId: string): string | undefined {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : undefined;
}

function writeCatalogFile(
  provider: string,
  sourceUrl: string,
  fresh: UpstreamModel[],
): { fetched_at: string; models_on_disk: CatalogModelOnDisk[] } {
  ensureCatalogsDir();
  const prior = loadCatalogFile(provider);
  const onDisk = carryEnabledFlags(fresh.map(toOnDisk), prior);
  const fetched_at = new Date().toISOString();
  const file: CatalogFileOnDisk = {
    provider,
    fetched_at,
    // Reuses the existing live-fetch literal — see CatalogFileOnDisk JSDoc.
    source: "live-fetch",
    source_url: sourceUrl,
    upstream_fetched_at: fetched_at,
    models: onDisk,
  };
  writeFileSync(catalogPath(provider), JSON.stringify(file, null, 2));
  return { fetched_at, models_on_disk: onDisk };
}

/**
 * Read cached aggregator data if fresh enough. Returns null when no
 * cache exists, the file isn't aggregator-shaped (e.g. a stale
 * pi-ai-bundle file from before the operator ever browsed upstream),
 * or the cache is stale past the TTL.
 */
function readCachedFresh(provider: string): {
  models: UpstreamModel[];
  fetched_at: string;
} | null {
  const file = loadCatalogFile(provider);
  if (!file) return null;
  const upstreamTs = file.upstream_fetched_at ?? null;
  if (!upstreamTs) return null;
  const age = Date.now() - new Date(upstreamTs).getTime();
  if (!Number.isFinite(age) || age < 0 || age > UPSTREAM_CACHE_TTL_MS) return null;
  return {
    models: file.models.map(fromOnDisk),
    fetched_at: upstreamTs,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-aggregator clients
// ──────────────────────────────────────────────────────────────────────────

// `fetch` is global in Bun and Node ≥18; allow tests to inject a mock
// through a module-level binding without monkey-patching globalThis.
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
let _fetchImpl: FetchImpl = (input, init) => fetch(input, init);

/** Test seam — swap the fetch implementation. Tests use this to
 *  capture-and-return fixtures without hitting the network. */
export function _setFetchForTesting(f: FetchImpl | null): void {
  _fetchImpl = f ?? ((input, init) => fetch(input, init));
}

/**
 * Fetch the OpenRouter catalog. The public `/api/v1/models` endpoint
 * doesn't strictly require auth but we read the API key when present so
 * operator-specific filtering / preview-tier visibility is honored.
 * Missing key is NOT an error here.
 *
 * Shape (trimmed):
 *   { data: [{ id, name, context_length, pricing: { prompt, completion },
 *              architecture: { input_modalities: [...] },
 *              supported_parameters: [...] }] }
 *
 * Pricing strings are USD-per-token; multiply by 1e6 to match the
 * per-million convention used everywhere else in this codebase.
 */
export async function openrouterFetchCatalog(
  apiKey: string | undefined,
): Promise<AggregatorResult> {
  const url = "https://openrouter.ai/api/v1/models";
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await _fetchImpl(url, { headers });
    if (res.status === 401) {
      return {
        ok: false,
        error: "openrouter rejected the API key (401)",
        hint: "set openrouter_api_key in secrets, or remove it to fetch the public catalog",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `openrouter /api/v1/models returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string | number; completion?: string | number };
        architecture?: { input_modalities?: string[]; modality?: string };
        supported_parameters?: string[];
        deprecated?: boolean | string;
      }>;
    };
    const live = body.data ?? [];
    const models: UpstreamModel[] = live.map((m) => {
      const id = String(m.id ?? "");
      const params = m.supported_parameters ?? [];
      const modalities = m.architecture?.input_modalities ?? [];
      // Reasoning detection: openrouter exposes a `reasoning` parameter
      // for models that emit a chain-of-thought channel; also pattern
      // matches the canonical reasoning families.
      const reasoningParam = params.includes("reasoning")
        || params.includes("include_reasoning");
      const reasoningPattern = /(^|\/)(o\d|deepseek-r\d|grok-.*think|qwq|magistral|gpt-5(?:\.\d+)?-pro|claude-.*-(?:opus|thinking))/i;
      return {
        id,
        name: m.name ?? id,
        context_length: m.context_length,
        pricing_per_1m_input: numericPrice(m.pricing?.prompt),
        pricing_per_1m_output: numericPrice(m.pricing?.completion),
        supports_tools: params.includes("tools") || params.includes("tool_choice"),
        supports_vision: modalities.includes("image"),
        supports_reasoning: reasoningParam || reasoningPattern.test(id),
        deprecated: typeof m.deprecated === "boolean"
          ? m.deprecated
          : (typeof m.deprecated === "string" && m.deprecated.length > 0)
          ? true
          : undefined,
        provider_id: deriveProviderId(id),
      };
    });
    return {
      ok: true,
      source: "live",
      fetched_at: new Date().toISOString(),
      models,
    };
  } catch (err) {
    return {
      ok: false,
      error: `openrouter fetch failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Coerce a pricing field to USD-per-million. Pricing is usually a string
 * ("0.000003") or a number, occasionally absent. Negative / NaN values
 * surface as undefined so the UI shows "—" rather than misleading
 * negative cost.
 *
 * `perMillion`: when true the value is treated as already USD/M (no
 * multiplication). OpenRouter ships per-token strings → false; Vercel
 * is documented in per-million → true. Conservative — when in doubt,
 * pick the convention that yields human-readable values in the modal.
 */
function numericPrice(
  v: string | number | undefined,
  perMillion = false,
): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return perMillion ? n : n * 1_000_000;
}

/**
 * Amazon Bedrock catalog. Stubbed — Bedrock's `ListFoundationModels`
 * sits in `@aws-sdk/client-bedrock` which isn't bundled in
 * components/master/package.json. Pulling the SDK in for catalog
 * enumeration is heavy (~200KB after tree-shake, plus its credential
 * provider chain). Deferred to a future minor release that already
 * needs the SDK for chat dispatch.
 */
export async function bedrockFetchCatalog(
  _apiKey: string | undefined,
): Promise<AggregatorResult> {
  return {
    ok: false,
    error: "bedrock catalog client not bundled — requires @aws-sdk/client-bedrock",
    hint: "stubbed in v2.9.1; tracked for a future minor that adds the SDK dependency",
  };
}

/**
 * Vercel AI Gateway catalog. The gateway speaks OpenAI-compatible
 * `/v1/models` at https://ai-gateway.vercel.sh. Models are namespaced
 * (`anthropic/claude-3.5-sonnet`, `openai/gpt-5`, …).
 *
 * Requires `vercel_api_key` / `AI_GATEWAY_API_KEY`. Public unauth GET
 * to /v1/models returns the same data without per-account flags.
 *
 * Caveat: Vercel doesn't publish a stable schema for the response
 * shape; the parser below targets the OpenAI-compat `{ data: [...] }`
 * envelope and is conservative about field presence.
 */
export async function vercelFetchCatalog(
  apiKey: string | undefined,
): Promise<AggregatorResult> {
  const url = "https://ai-gateway.vercel.sh/v1/models";
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await _fetchImpl(url, { headers });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `vercel AI gateway rejected the API key (HTTP ${res.status})`,
        hint: "set vercel_api_key (AI_GATEWAY_API_KEY) in secrets",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `vercel /v1/models returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        display_name?: string;
        context_window?: number;
        context_length?: number;
        pricing?: { input?: number | string; output?: number | string };
        capabilities?: string[];
      }>;
    };
    const live = body.data ?? [];
    const models: UpstreamModel[] = live.map((m) => {
      const id = String(m.id ?? "");
      const caps = m.capabilities ?? [];
      // Vercel's pricing convention isn't well-documented; assume values
      // are already per-million USD (matches the convention used in
      // Vercel's own docs examples). If they ever switch to per-token,
      // the response shape would have decimal-string-looking values
      // small enough to be unambiguous — caught by a future fixture.
      return {
        id,
        name: m.display_name ?? m.name ?? id,
        context_length: m.context_window ?? m.context_length,
        pricing_per_1m_input: numericPrice(m.pricing?.input, /* perMillion */ true),
        pricing_per_1m_output: numericPrice(m.pricing?.output, /* perMillion */ true),
        supports_tools: caps.includes("tools") || caps.includes("function_calling"),
        supports_vision: caps.includes("vision") || caps.includes("image"),
        supports_reasoning: caps.includes("reasoning"),
        provider_id: deriveProviderId(id),
      };
    });
    return {
      ok: true,
      source: "live",
      fetched_at: new Date().toISOString(),
      models,
    };
  } catch (err) {
    return {
      ok: false,
      error: `vercel AI gateway fetch failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Cloudflare AI Gateway catalog. Stubbed — Cloudflare AI Gateway is
 * itself a proxy layer; the actual model list comes from Workers AI at
 * `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/models/search`,
 * which requires a Cloudflare account id we don't currently capture in
 * secrets.json. Deferred until the secrets schema gets a
 * `cloudflare_account_id` field.
 */
export async function cloudflareFetchCatalog(
  _apiKey: string | undefined,
): Promise<AggregatorResult> {
  return {
    ok: false,
    error: "cloudflare AI gateway catalog client not bundled",
    hint: "stubbed in v2.9.1 — requires cloudflare_account_id (not yet in secrets schema) + cloudflare_api_key",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public dispatcher
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the secrets key for a given aggregator. Mirrors the
 * envVarFor()/secrets.json convention used everywhere else. Bedrock's
 * "no single env var" caveat means we accept the AWS_ACCESS_KEY_ID
 * envvar as a presence-check signal even though we don't use it in the
 * stub path.
 */
function readAggregatorKey(provider: AggregatorProviderId): string | undefined {
  switch (provider) {
    case "openrouter":
      return resolveSecret("openrouter_api_key") ?? undefined;
    case "amazon-bedrock":
      // Stub returns regardless; key lookup is here for forward-compat.
      return (
        process.env.AWS_BEDROCK_API_KEY?.trim()
        || process.env.AWS_ACCESS_KEY_ID?.trim()
        || undefined
      );
    case "vercel-ai-gateway":
      return (
        process.env.AI_GATEWAY_API_KEY?.trim()
        || process.env.VERCEL_AI_GATEWAY_API_KEY?.trim()
        || (resolveSecret("vercel_api_key") ?? undefined)
      );
    case "cloudflare-ai-gateway":
      return (
        process.env.CLOUDFLARE_API_KEY?.trim()
        || (resolveSecret("cloudflare_api_key") ?? undefined)
      );
  }
}

/**
 * Top-level: fetch (or serve cached) upstream catalog for an aggregator
 * provider. The `{ forceLive }` option bypasses the TTL cache — used by
 * the explicit "Refresh from upstream" button.
 *
 * Successful live fetches persist to disk in the existing per-provider
 * catalog file shape (see writeCatalogFile()) so the data also flows
 * through the existing `/api/catalogs/<p>` reader and per-model
 * enable-toggle endpoints.
 */
export async function fetchUpstreamCatalog(
  provider: string,
  opts: { forceLive?: boolean } = {},
): Promise<AggregatorResult> {
  if (!isAggregatorProvider(provider)) {
    return {
      ok: false,
      error: `provider "${provider}" is not an aggregator — upstream-catalog applies to: ${AGGREGATOR_PROVIDER_IDS.join(", ")}`,
    };
  }
  if (!opts.forceLive) {
    const cached = readCachedFresh(provider);
    if (cached) {
      return {
        ok: true,
        source: "cached",
        fetched_at: cached.fetched_at,
        models: cached.models,
      };
    }
  }
  const apiKey = readAggregatorKey(provider);
  let res: AggregatorResult;
  let sourceUrl = "";
  switch (provider) {
    case "openrouter":
      sourceUrl = "https://openrouter.ai/api/v1/models";
      res = await openrouterFetchCatalog(apiKey);
      break;
    case "amazon-bedrock":
      sourceUrl = "bedrock:ListFoundationModels";
      res = await bedrockFetchCatalog(apiKey);
      break;
    case "vercel-ai-gateway":
      sourceUrl = "https://ai-gateway.vercel.sh/v1/models";
      res = await vercelFetchCatalog(apiKey);
      break;
    case "cloudflare-ai-gateway":
      sourceUrl = "cloudflare:workers-ai/models/search";
      res = await cloudflareFetchCatalog(apiKey);
      break;
  }
  if (res.ok) {
    try {
      writeCatalogFile(provider, sourceUrl, res.models);
    } catch (err) {
      // Cache write failure is non-fatal — we still have the data in
      // memory for this request. Surface as an in-band notice via the
      // server route, not by failing the response.
      console.error(
        `[aggregator-clients] WARN cache write failed for ${provider}: ${(err as Error).message}`,
      );
    }
  }
  return res;
}
