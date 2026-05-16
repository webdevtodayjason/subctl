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
} from "../../components/master/pi-ai-catalog.ts";

const HOME = homedir();
const CATALOGS_DIR = process.env.SUBCTL_CONFIG_DIR
  ? join(process.env.SUBCTL_CONFIG_DIR, "catalogs")
  : join(HOME, ".config", "subctl", "catalogs");

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
  /** Operator opt-in/opt-out toggle. Defaults to true — every model from
   *  the source is shown unless the operator explicitly hides it. */
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
  if (!existsSync(CATALOGS_DIR)) {
    mkdirSync(CATALOGS_DIR, { recursive: true });
  }
}

function catalogPath(provider: string): string {
  // Provider ids contain hyphens and lowercase letters only (per pi-ai's
  // naming convention); the resolveProviderId() pass also drops any
  // funny characters. Defensive: slash-strip just in case.
  const safe = provider.replace(/[^a-z0-9_-]/gi, "");
  return join(CATALOGS_DIR, `${safe}.json`);
}

/** Materialise pi-ai's bundled catalog for a provider into our CatalogFile
 *  shape. This is what `GET /api/catalogs/<p>` returns when no cache file
 *  exists yet, and what `POST refresh` falls back to when a provider has
 *  no public live endpoint. */
export function fromPiAiBundle(provider: string): CatalogFile {
  const canonical = resolveProviderId(provider);
  const raw = getBundledModels(canonical);
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
    enabled: true,
  }));
  return {
    provider: canonical,
    fetched_at: new Date().toISOString(),
    source: "pi-ai-bundle",
    models,
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
  if (!existsSync(CATALOGS_DIR)) return [];
  const out: CatalogFile[] = [];
  for (const f of readdirSync(CATALOGS_DIR)) {
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
