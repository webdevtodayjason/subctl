// dashboard/lib/catalogs.ts
//
// v2.8.8 Phase 2 — per-provider model catalog cache.
//
// Each known provider gets a JSON file under ~/.config/subctl/catalogs/
// containing the catalog Evy + the operator see. The file is generated
// from one of two sources:
//
//   - pi-ai's bundled static catalog (the baseline, always available)
//   - a live fetch against the provider's own `/v1/models` endpoint
//     (when the provider exposes one — Phase 2b)
//
// The "Refresh" button in the Providers tab POSTs /api/catalogs/<p>/refresh
// which re-derives the file. Until refresh runs, GET returns the pi-ai
// bundle materialised as a CatalogFile shape so the dashboard always has
// something to render.
//
// Storage scheme is per-provider files (not one big enabled-models.json)
// because:
//   - operators routinely refresh ONE provider at a time
//   - per-file writes are atomic, no global mutex needed
//   - per-file timestamps map cleanly to per-provider "last refreshed" UI

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  resolveProviderId,
  isCatalogProvider,
  getBundledModels,
  listAllProviderIds,
  getDefaultModel,
} from "../../components/master/pi-ai-catalog.ts";

const HOME = homedir();
// v2.8.9 — Lazy-eval SUBCTL_CONFIG_DIR like the pi-ai-catalog fix in b9bd182.
// The previous eager const captured the env at module load, so tests that set
// SUBCTL_CONFIG_DIR after import had their writes/reads land in the operator's
// real ~/.config/subctl/. Lazy resolution makes per-test isolation viable.
function catalogsDir(): string {
  return process.env.SUBCTL_CONFIG_DIR
    ? join(process.env.SUBCTL_CONFIG_DIR, "catalogs")
    : join(HOME, ".config", "subctl", "catalogs");
}

export interface CatalogModel {
  id: string;
  name: string;
  /** Wire-format protocol (anthropic-messages, openai-responses, etc.). */
  api?: string;
  /** Base URL pi-ai routes through. May differ from a future custom-host
   *  override; this is the canonical provider endpoint. */
  base_url?: string;
  context_window?: number;
  max_tokens?: number;
  /** Modalities accepted as input (text, image, audio, video). */
  input?: string[];
  /** True iff the model supports chain-of-thought / reasoning channels. */
  reasoning?: boolean;
  /** USD per million tokens. Pi-ai surfaces input/output and cache costs. */
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  /** Operator opt-in/opt-out toggle. v2.8.17 — a freshly-seeded catalog
   *  enables ONLY the provider's default model; the operator opts the rest
   *  in via the Providers-tab model table. A model is "enabled" (appears in
   *  the chat dropdown) unless this is explicitly false. */
  enabled: boolean;
}

export interface CatalogFile {
  provider: string;
  /** When the catalog was last derived. */
  fetched_at: string;
  /** Where the data came from. `pi-ai-bundle` is the baseline; `live-fetch`
   *  means we hit the provider's HTTP API directly. */
  source: "pi-ai-bundle" | "live-fetch";
  /** Endpoint hit when source=live-fetch. Helps debugging when a refresh
   *  returns weirdly. */
  source_url?: string;
  models: CatalogModel[];
}

function ensureCatalogsDir(): void {
  if (!existsSync(catalogsDir())) {
    mkdirSync(catalogsDir(), { recursive: true });
  }
}

function catalogPath(provider: string): string {
  // Provider ids contain hyphens and lowercase letters only (per pi-ai's
  // naming convention); the resolveProviderId() pass also drops any
  // funny characters. Defensive: slash-strip just in case.
  const safe = provider.replace(/[^a-z0-9_-]/gi, "");
  return join(catalogsDir(), `${safe}.json`);
}

/** Materialise pi-ai's bundled catalog for a provider into our CatalogFile
 *  shape. This is what `GET /api/catalogs/<p>` returns when no cache file
 *  exists yet, and what `POST refresh` falls back to when a provider has
 *  no public live endpoint. */
export function fromPiAiBundle(provider: string): CatalogFile {
  const canonical = resolveProviderId(provider);
  const raw = getBundledModels(canonical);
  // v2.8.17 — seed only the provider's default model as enabled. Previously
  // every bundled model seeded `enabled: true`, so connecting a provider
  // flipped all ~40 models into the chat dropdown at once. Now a fresh
  // catalog is immediately usable (the default works) but uncluttered; the
  // operator opts the rest in via the Providers-tab model table.
  const shippedDefault = getDefaultModel(canonical);
  const models: CatalogModel[] = raw.map((m) => ({
    id: String(m.id ?? ""),
    name: String(m.name ?? m.id ?? ""),
    api: typeof m.api === "string" ? m.api : undefined,
    base_url: typeof m.baseUrl === "string" ? m.baseUrl : undefined,
    context_window:
      typeof m.contextWindow === "number" ? m.contextWindow : undefined,
    max_tokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
    input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
    reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
    cost: m.cost && typeof m.cost === "object"
      ? {
          input: typeof (m.cost as Record<string, unknown>).input === "number"
            ? ((m.cost as Record<string, unknown>).input as number)
            : undefined,
          output: typeof (m.cost as Record<string, unknown>).output === "number"
            ? ((m.cost as Record<string, unknown>).output as number)
            : undefined,
          cache_read:
            typeof (m.cost as Record<string, unknown>).cacheRead === "number"
              ? ((m.cost as Record<string, unknown>).cacheRead as number)
              : undefined,
          cache_write:
            typeof (m.cost as Record<string, unknown>).cacheWrite === "number"
              ? ((m.cost as Record<string, unknown>).cacheWrite as number)
              : undefined,
        }
      : undefined,
    enabled: String(m.id ?? "") === shippedDefault,
  }));
  return {
    provider: canonical,
    fetched_at: new Date().toISOString(),
    source: "pi-ai-bundle",
    models,
  };
}

/** v2.8.17 — Reconcile the `enabled` flags of a freshly-derived catalog
 *  against whatever is already on disk for the provider.
 *
 *  - If a prior catalog file exists, carry every prior model's `enabled`
 *    flag forward (matched by id). Models that are new since the last
 *    refresh seed `enabled: false` — the operator opts them in. This is
 *    the load-bearing "Refresh must not clobber operator curation" rule.
 *  - If no prior catalog exists (first-ever derivation), seed only the
 *    provider's default model as enabled, mirroring fromPiAiBundle().
 *
 *  Pure: returns a new CatalogFile, does not persist. */
function reconcileEnabled(fresh: CatalogFile): CatalogFile {
  const prior = loadCatalog(fresh.provider);
  if (prior) {
    const priorEnabled = new Map(
      prior.models.map((m) => [m.id, m.enabled !== false] as const),
    );
    return {
      ...fresh,
      models: fresh.models.map((m) => ({
        ...m,
        enabled: priorEnabled.has(m.id) ? priorEnabled.get(m.id)! : false,
      })),
    };
  }
  const shippedDefault = getDefaultModel(fresh.provider);
  return {
    ...fresh,
    models: fresh.models.map((m) => ({
      ...m,
      enabled: m.id === shippedDefault,
    })),
  };
}

/** Read a cached catalog file. Returns null when no cache exists OR the
 *  file is malformed (corrupt cache is treated as "no cache" so refresh
 *  rebuilds cleanly rather than half-merging broken data). */
export function loadCatalog(provider: string): CatalogFile | null {
  const path = catalogPath(provider);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
    if (!parsed.provider || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a catalog file. Creates the catalogs directory on first write. */
export function saveCatalog(cat: CatalogFile): void {
  ensureCatalogsDir();
  writeFileSync(catalogPath(cat.provider), JSON.stringify(cat, null, 2));
}

/** Return a CatalogFile for the provider — cached if available, else
 *  derived from the pi-ai bundle (without persisting; saving is the
 *  refresh path's job). Use this from GET handlers to always have a
 *  catalog to render. */
export function getCatalog(provider: string): CatalogFile {
  const cached = loadCatalog(provider);
  if (cached) return cached;
  return fromPiAiBundle(provider);
}

/** Enumerate every catalog file on disk. Used by GET /api/catalogs. */
export function listCachedCatalogs(): CatalogFile[] {
  if (!existsSync(catalogsDir())) return [];
  const out: CatalogFile[] = [];
  for (const f of readdirSync(catalogsDir())) {
    if (!f.endsWith(".json")) continue;
    const provider = f.replace(/\.json$/, "");
    const cat = loadCatalog(provider);
    if (cat) out.push(cat);
  }
  return out;
}

/** Quick validity check for an incoming provider id. */
export function isKnownProvider(provider: string): boolean {
  const canonical = resolveProviderId(provider);
  return isCatalogProvider(canonical) || listAllProviderIds().includes(canonical);
}

/** v2.8.9 — Flip the `enabled` flag for a specific model in a provider's
 *  cached catalog. If no cache exists yet (operator never refreshed), we
 *  materialise from the pi-ai bundle first, then flip + save. Returns the
 *  post-write catalog so the caller can render the new state without an
 *  extra GET round-trip.
 *
 *  Throws when the model id isn't in the provider's catalog (caller
 *  surfaces as a 404 to the operator). */
export function setModelEnabled(
  provider: string,
  modelId: string,
  enabled: boolean,
): CatalogFile {
  const canonical = resolveProviderId(provider);
  const current = loadCatalog(canonical) ?? fromPiAiBundle(canonical);
  const idx = current.models.findIndex((m) => m.id === modelId);
  if (idx === -1) {
    throw new Error(`model "${modelId}" not found in ${canonical} catalog`);
  }
  current.models[idx] = { ...current.models[idx], enabled };
  saveCatalog(current);
  return current;
}

/** v2.8.17 — Flip EVERY model in a provider's catalog to `enabled`. Backs
 *  the "Enable all" / "Disable all" buttons in the Providers-tab model
 *  table. Like setModelEnabled, materialises from the pi-ai bundle first
 *  when no cache exists yet, then writes + returns the post-write catalog. */
export function setAllModelsEnabled(
  provider: string,
  enabled: boolean,
): CatalogFile {
  const canonical = resolveProviderId(provider);
  const current = loadCatalog(canonical) ?? fromPiAiBundle(canonical);
  current.models = current.models.map((m) => ({ ...m, enabled }));
  saveCatalog(current);
  return current;
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2b — live refresh from provider /models endpoints
// ──────────────────────────────────────────────────────────────────────────

const SECRETS_PATH = process.env.SUBCTL_CONFIG_DIR
  ? join(process.env.SUBCTL_CONFIG_DIR, "secrets.json")
  : join(HOME, ".config", "subctl", "secrets.json");

/** Read a credential, env var first then secrets.json. Returns undefined
 *  when neither source has a non-empty value. Mirrors the pattern used by
 *  components/master/secrets.ts resolveSecret() but doesn't pull in the
 *  full caching layer — refresh is a rare, operator-initiated action. */
function readSecret(envName: string, secretKey: string): string | undefined {
  const envVal = process.env[envName];
  if (envVal && envVal.trim()) return envVal.trim();
  try {
    const data = JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as Record<string, unknown>;
    const val = data[secretKey];
    if (typeof val === "string" && val.trim()) return val.trim();
  } catch {
    // missing or malformed secrets.json — operator has none configured yet
  }
  return undefined;
}

/** Live-fetch the model list from Anthropic's API. Requires
 *  ANTHROPIC_API_KEY env or `anthropic_api_key` in secrets.json. Returns
 *  null when no API key is available (caller falls back to pi-ai bundle). */
async function refreshAnthropic(): Promise<CatalogFile | null> {
  const apiKey = readSecret("ANTHROPIC_API_KEY", "anthropic_api_key");
  if (!apiKey) return null;
  const url = "https://api.anthropic.com/v1/models";
  const res = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`anthropic /v1/models returned HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    data?: Array<{ id?: string; display_name?: string; created_at?: string }>;
  };
  const live = j.data ?? [];
  // Anthropic's /v1/models is minimal — id + display_name + created. Enrich
  // with pi-ai's bundled cost/context data when we have it (joined by id).
  const bundle = fromPiAiBundle("anthropic").models;
  const byId = new Map(bundle.map((m) => [m.id, m]));
  const models: CatalogModel[] = live.map((m) => {
    const id = String(m.id ?? "");
    const bundled = byId.get(id);
    return {
      id,
      name: m.display_name ?? bundled?.name ?? id,
      api: bundled?.api ?? "anthropic-messages",
      base_url: bundled?.base_url ?? "https://api.anthropic.com",
      context_window: bundled?.context_window,
      max_tokens: bundled?.max_tokens,
      input: bundled?.input,
      reasoning: bundled?.reasoning,
      cost: bundled?.cost,
      enabled: true,
    };
  });
  return {
    provider: "anthropic",
    fetched_at: new Date().toISOString(),
    source: "live-fetch",
    source_url: url,
    models,
  };
}

/** Live-fetch the model list from OpenRouter's API. No auth required for
 *  the public /api/v1/models endpoint, though authenticated requests
 *  return additional fields (we don't currently use them). */
async function refreshOpenRouter(): Promise<CatalogFile> {
  const url = "https://openrouter.ai/api/v1/models";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`openrouter /api/v1/models returned HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      architecture?: { input_modalities?: string[] };
    }>;
  };
  const live = j.data ?? [];
  const models: CatalogModel[] = live.map((m) => ({
    id: String(m.id ?? ""),
    name: m.name ?? String(m.id ?? ""),
    api: "openai-completions",
    base_url: "https://openrouter.ai/api/v1",
    context_window: m.context_length,
    max_tokens: undefined,
    input: m.architecture?.input_modalities,
    reasoning: undefined,
    // OpenRouter reports per-token prices as strings in USD; convert to
    // per-million for parity with pi-ai's bundled shape (cost.input/output).
    cost: m.pricing
      ? {
          input: m.pricing.prompt ? Number(m.pricing.prompt) * 1_000_000 : undefined,
          output: m.pricing.completion ? Number(m.pricing.completion) * 1_000_000 : undefined,
        }
      : undefined,
    enabled: true,
  }));
  return {
    provider: "openrouter",
    fetched_at: new Date().toISOString(),
    source: "live-fetch",
    source_url: url,
    models,
  };
}

/** Live-fetch openai's model catalog. Requires OPENAI_API_KEY env or
 *  `openai_api_key` in secrets.json. Returns null when no key, caller
 *  falls back to pi-ai bundle. */
async function refreshOpenAI(): Promise<CatalogFile | null> {
  const apiKey = readSecret("OPENAI_API_KEY", "openai_api_key");
  if (!apiKey) return null;
  const url = "https://api.openai.com/v1/models";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`openai /v1/models returned HTTP ${res.status}`);
  }
  const j = (await res.json()) as { data?: Array<{ id?: string; owned_by?: string; created?: number }> };
  const live = j.data ?? [];
  const bundle = fromPiAiBundle("openai").models;
  const byId = new Map(bundle.map((m) => [m.id, m]));
  const models: CatalogModel[] = live.map((m) => {
    const id = String(m.id ?? "");
    const bundled = byId.get(id);
    return {
      id,
      name: bundled?.name ?? id,
      api: bundled?.api ?? "openai-responses",
      base_url: bundled?.base_url ?? "https://api.openai.com/v1",
      context_window: bundled?.context_window,
      max_tokens: bundled?.max_tokens,
      input: bundled?.input,
      reasoning: bundled?.reasoning,
      cost: bundled?.cost,
      enabled: true,
    };
  });
  return {
    provider: "openai",
    fetched_at: new Date().toISOString(),
    source: "live-fetch",
    source_url: url,
    models,
  };
}

/** Live-fetch google's model catalog. Requires GEMINI_API_KEY env or
 *  `gemini_api_key` in secrets.json. Note: Google's models list endpoint
 *  takes the API key as a query parameter, not a header. */
async function refreshGoogle(): Promise<CatalogFile | null> {
  const apiKey = readSecret("GEMINI_API_KEY", "gemini_api_key");
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`google /v1beta/models returned HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      outputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }>;
  };
  const live = j.models ?? [];
  const bundle = fromPiAiBundle("google").models;
  const byId = new Map(bundle.map((m) => [m.id, m]));
  // Google's `name` looks like "models/gemini-1.5-pro" — strip the prefix
  // for the canonical id, matching pi-ai's convention.
  const models: CatalogModel[] = live
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => {
      const fullName = m.name ?? "";
      const id = fullName.startsWith("models/") ? fullName.slice("models/".length) : fullName;
      const bundled = byId.get(id);
      return {
        id,
        name: m.displayName ?? bundled?.name ?? id,
        api: bundled?.api ?? "google-generative-ai",
        base_url: bundled?.base_url ?? "https://generativelanguage.googleapis.com",
        context_window: m.inputTokenLimit ?? bundled?.context_window,
        max_tokens: m.outputTokenLimit ?? bundled?.max_tokens,
        input: bundled?.input,
        reasoning: bundled?.reasoning,
        cost: bundled?.cost,
        enabled: true,
      };
    });
  return {
    provider: "google",
    fetched_at: new Date().toISOString(),
    source: "live-fetch",
    source_url: url.replace(/key=[^&]*/, "key=***redacted***"),
    models,
  };
}

/** Live-fetch mistral's model catalog. Requires MISTRAL_API_KEY env or
 *  `mistral_api_key` in secrets.json. */
async function refreshMistral(): Promise<CatalogFile | null> {
  const apiKey = readSecret("MISTRAL_API_KEY", "mistral_api_key");
  if (!apiKey) return null;
  const url = "https://api.mistral.ai/v1/models";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`mistral /v1/models returned HTTP ${res.status}`);
  }
  const j = (await res.json()) as { data?: Array<{ id?: string; max_context_length?: number }> };
  const live = j.data ?? [];
  const bundle = fromPiAiBundle("mistral").models;
  const byId = new Map(bundle.map((m) => [m.id, m]));
  const models: CatalogModel[] = live.map((m) => {
    const id = String(m.id ?? "");
    const bundled = byId.get(id);
    return {
      id,
      name: bundled?.name ?? id,
      api: bundled?.api ?? "mistral-conversations",
      base_url: bundled?.base_url ?? "https://api.mistral.ai/v1",
      context_window: m.max_context_length ?? bundled?.context_window,
      max_tokens: bundled?.max_tokens,
      input: bundled?.input,
      reasoning: bundled?.reasoning,
      cost: bundled?.cost,
      enabled: true,
    };
  });
  return {
    provider: "mistral",
    fetched_at: new Date().toISOString(),
    source: "live-fetch",
    source_url: url,
    models,
  };
}

/** Derive a provider's catalog afresh. Tries the live-fetch path first;
 *  falls back to a fresh derivation from pi-ai's bundle on auth failure
 *  (return null from the live helper) or fetch error (caught here).
 *  Produces a catalog whose `enabled` flags are NOT yet reconciled against
 *  the on-disk state — refreshCatalog() does that. */
async function deriveRefreshedCatalog(provider: string): Promise<{
  catalog: CatalogFile;
  notice?: string;
}> {
  const canonical = resolveProviderId(provider);
  try {
    if (canonical === "anthropic") {
      const live = await refreshAnthropic();
      if (live) return { catalog: live };
      return {
        catalog: fromPiAiBundle("anthropic"),
        notice: "anthropic API key not configured — falling back to pi-ai bundle",
      };
    }
    if (canonical === "openrouter") {
      return { catalog: await refreshOpenRouter() };
    }
    if (canonical === "openai") {
      const live = await refreshOpenAI();
      if (live) return { catalog: live };
      return {
        catalog: fromPiAiBundle("openai"),
        notice: "OPENAI_API_KEY not configured — falling back to pi-ai bundle",
      };
    }
    if (canonical === "google") {
      const live = await refreshGoogle();
      if (live) return { catalog: live };
      return {
        catalog: fromPiAiBundle("google"),
        notice: "GEMINI_API_KEY not configured — falling back to pi-ai bundle",
      };
    }
    if (canonical === "mistral") {
      const live = await refreshMistral();
      if (live) return { catalog: live };
      return {
        catalog: fromPiAiBundle("mistral"),
        notice: "MISTRAL_API_KEY not configured — falling back to pi-ai bundle",
      };
    }
  } catch (err) {
    return {
      catalog: fromPiAiBundle(canonical),
      notice: `live fetch failed (${(err as Error).message}) — falling back to pi-ai bundle`,
    };
  }
  // Default: re-derive from pi-ai bundle. Fresh fetched_at, no live source.
  return {
    catalog: fromPiAiBundle(canonical),
    notice: "no live-fetch implementation for this provider yet — using pi-ai bundle",
  };
}

/** Refresh a provider's catalog. Wraps deriveRefreshedCatalog() and then
 *  reconciles the new catalog's `enabled` flags against whatever is on
 *  disk — see reconcileEnabled(). This is what preserves operator
 *  enable/disable curation across a Refresh: a freshly live-fetched model
 *  list never resets choices the operator already made.
 *
 *  The caller is responsible for persisting the result via saveCatalog()
 *  — this function only computes the new value. */
export async function refreshCatalog(provider: string): Promise<{
  catalog: CatalogFile;
  notice?: string;
}> {
  const { catalog, notice } = await deriveRefreshedCatalog(provider);
  return { catalog: reconcileEnabled(catalog), notice };
}
