// components/master/tools/tinyfish.ts
//
// TinyFish web toolkit integration — two tools at the free tier:
//   - tinyfish_search — live web search, structured agent-ready results
//   - tinyfish_fetch  — full-page content extraction as clean markdown
//
// Operator-decided (v2.7.16): subctl integrates TinyFish FIRST-CLASS
// alongside `web_search` (Brave) and `web_fetch` (Firecrawl) rather
// than via MCP passthrough — the tools show up in /diag, the registry,
// and Evy's tool list as native master tools. Master is a daemon and
// can't pop a browser for OAuth; the API key lives in
// ~/.config/subctl/secrets.json under `tinyfish_api_key` and is sent
// on every request via the `X-API-Key` header.
//
// API endpoints verified against https://docs.tinyfish.ai on
// 2026-05-13:
//   - Search: GET  https://api.search.tinyfish.ai
//     params: query (req), location, language, page (0–10)
//     response: { query, results: [{position, site_name, title,
//                                   snippet, url}], total_results, page }
//   - Fetch:  POST https://api.fetch.tinyfish.ai
//     body: { urls: [string], format?: "markdown"|"html"|"json",
//             links?: bool, image_links?: bool }
//     response: { results: [{url, final_url, title, description,
//                            language, author, published_date, text,
//                            links, image_links, latency_ms, format}],
//                 errors: [{url, error, status?}] }
//   - Auth: X-API-Key header (NOT Authorization: Bearer; the brief
//     used "tinyfish_oauth_token" assuming OAuth, but the REST API
//     uses an API key obtained by signing up at agent.tinyfish.ai —
//     the MCP endpoint's OAuth flow is a separate auth surface).
//   - Free tier: 30 req/min; 429 returned with rate limit excess.
//   - "Search and Fetch do not use credits" per TinyFish docs.
//
// Both tools are READ-ONLY. Results are returned directly to the
// caller; nothing is cached to subctl state, written to disk, or
// otherwise persisted. HTTP errors (network, 4xx, 5xx, timeout, rate
// limit) all surface as `{ ok: false, error: "..." }` — tools never
// throw to the caller. Pattern mirrors components/master/tools/web.ts.

// ─── injectable side-effect surface (for tests) ────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  latencyMs: number;
  error?: string;
  /** Lower-cased header name → header value. Only populated when present. */
  headers?: Record<string, string>;
}

interface Deps {
  fetchHttp: (
    url: string,
    opts: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs: number;
    },
  ) => Promise<FetchResult>;
  now: () => number;
}

const realDeps: Deps = {
  fetchHttp: async (url, opts) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await r.text();
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return {
        ok: r.ok,
        status: r.status,
        text,
        latencyMs: Date.now() - t0,
        headers,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "TimeoutError";
      return {
        ok: false,
        status: 0,
        text: "",
        latencyMs: Date.now() - t0,
        error: isAbort ? `timeout after ${opts.timeoutMs}ms` : msg,
      };
    }
  },
  now: () => Date.now(),
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── shared helpers ────────────────────────────────────────────────────────

import { resolveSecret } from "../secrets";

const KEY_MISSING_HINT =
  "Sign up at https://agent.tinyfish.ai to mint an API key (free tier — search + fetch don't use credits), then paste it via the dashboard Settings → API Tokens panel (writes ~/.config/subctl/secrets.json, chmod 600) OR set TINYFISH_API_KEY in ~/Library/LaunchAgents/com.subctl.master.plist EnvironmentVariables followed by `launchctl kickstart -k gui/$UID/com.subctl.master`.";

/** Cap a response body excerpt so a 5MB error page doesn't flood the agent context. */
function bodyExcerpt(text: string, max = 400): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…(truncated ${trimmed.length - max} chars)`;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Override the API base for tests / staging environments. Production
// uses the documented per-tool subdomains.
const TINYFISH_SEARCH_URL =
  process.env.TINYFISH_SEARCH_URL ?? "https://api.search.tinyfish.ai";
const TINYFISH_FETCH_URL =
  process.env.TINYFISH_FETCH_URL ?? "https://api.fetch.tinyfish.ai";
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;

// ─── tool 1: tinyfish_search ───────────────────────────────────────────────

interface TinyFishSearchResultRaw {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  url?: string;
}

interface TinyFishSearchResponse {
  query?: string;
  results?: TinyFishSearchResultRaw[];
  total_results?: number;
  page?: number;
}

const tinyfish_search = {
  description:
    "**Use this when** you need to query the live web for current information — news, prices, recent events, anything that changes over time. Returns structured agent-ready results (title + URL + snippet + site_name). Free tier, no credits. Parallel to web_search (Brave); try TinyFish first for current-events queries (different index + freshness), fall back to web_search if results are sparse. Requires `tinyfish_api_key` (or TINYFISH_API_KEY env var) on the master daemon — returns a structured error with setup hint if missing.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      location: {
        type: "string",
        description: "Country code for geo-targeted results (e.g. US, GB, FR)",
      },
      language: {
        type: "string",
        description: "Language code (e.g. en, fr, de)",
      },
      page: {
        type: "integer",
        description: "Page number for pagination, starting from 0 (max 10)",
        minimum: 0,
        maximum: 10,
      },
    },
    required: ["query"],
  },
  invoke: async (
    args: {
      query?: string;
      location?: string;
      language?: string;
      page?: number;
    } = {},
  ) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return {
        ok: false,
        error: "query is required and must be a non-empty string",
      };
    }
    const apiKey = resolveSecret("tinyfish_api_key");
    if (!apiKey) {
      return {
        ok: false,
        error: `TINYFISH_API_KEY not configured. ${KEY_MISSING_HINT}`,
      };
    }
    const params = new URLSearchParams({ query });
    if (args.location) params.set("location", args.location);
    if (args.language) params.set("language", args.language);
    if (typeof args.page === "number") {
      const page = Math.min(Math.max(args.page, 0), 10);
      params.set("page", String(page));
    }
    const url = `${TINYFISH_SEARCH_URL}?${params.toString()}`;
    const r = await deps.fetchHttp(url, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      if (r.status === 429) {
        const retry = r.headers?.["retry-after"];
        return {
          ok: false,
          error: `tinyfish_search rate limited by TinyFish (HTTP 429)${
            retry ? `, retry-after: ${retry}` : ""
          }. ${bodyExcerpt(r.text)}`,
          status: r.status,
          retry_after: retry ?? null,
        };
      }
      if (r.status === 401) {
        return {
          ok: false,
          error: `tinyfish_search HTTP 401: invalid or missing API key. ${bodyExcerpt(r.text)}`,
          status: r.status,
          hint: "Re-mint your key at https://agent.tinyfish.ai and update the `tinyfish_api_key` secret (dashboard panel or plist).",
        };
      }
      if (r.status === 0) {
        return {
          ok: false,
          error: `tinyfish_search network error: ${r.error ?? "unknown"}`,
          latency_ms: r.latencyMs,
        };
      }
      return {
        ok: false,
        error: `tinyfish_search HTTP ${r.status}: ${bodyExcerpt(r.text)}`,
        status: r.status,
      };
    }
    let parsed: TinyFishSearchResponse;
    try {
      parsed = JSON.parse(r.text) as TinyFishSearchResponse;
    } catch (err) {
      return {
        ok: false,
        error: `tinyfish_search response was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const raw = parsed.results ?? [];
    const results = raw.map((x) => ({
      position: typeof x.position === "number" ? x.position : null,
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.snippet ?? "",
      site_name: x.site_name ?? "",
    }));
    return {
      ok: true,
      query,
      count_returned: results.length,
      total_results: parsed.total_results ?? null,
      page: parsed.page ?? 0,
      latency_ms: r.latencyMs,
      results,
    };
  },
};

// ─── tool 2: tinyfish_fetch ────────────────────────────────────────────────

interface TinyFishFetchResultRaw {
  url?: string;
  final_url?: string;
  title?: string;
  description?: string;
  language?: string;
  author?: string;
  published_date?: string;
  text?: string;
  links?: unknown;
  image_links?: unknown;
  latency_ms?: number;
  format?: string;
}

interface TinyFishFetchErrorRaw {
  url?: string;
  error?: string;
  status?: number;
}

interface TinyFishFetchResponse {
  results?: TinyFishFetchResultRaw[];
  errors?: TinyFishFetchErrorRaw[];
}

const tinyfish_fetch = {
  description:
    "**Use this when** you need the full text of a specific URL — articles, docs, product pages, anything you need to reason over. Returns clean extracted text (markdown by default). Free tier, no credits. Parallel to web_fetch (Firecrawl); try TinyFish first for cleaner extraction with metadata (title, author, published_date), fall back to web_fetch if needed. Requires `tinyfish_api_key` (or TINYFISH_API_KEY env var) on the master daemon.",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch (http/https only)" },
      format: {
        type: "string",
        enum: ["markdown", "html", "json"],
        description:
          "Output format: 'markdown' (default, clean for LLMs), 'html' (semantic HTML), 'json' (structured document tree)",
      },
      links: {
        type: "boolean",
        description: "Include anchor URLs in the response (default false)",
      },
      image_links: {
        type: "boolean",
        description: "Include image URLs in the response (default false)",
      },
    },
    required: ["url"],
  },
  invoke: async (
    args: {
      url?: string;
      format?: "markdown" | "html" | "json";
      links?: boolean;
      image_links?: boolean;
    } = {},
  ) => {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return {
        ok: false,
        error: "url is required and must be a non-empty string",
      };
    }
    if (!isValidUrl(url)) {
      return {
        ok: false,
        error: `tinyfish_fetch invalid URL: must be http:// or https://, got ${bodyExcerpt(url, 120)}`,
      };
    }
    const apiKey = resolveSecret("tinyfish_api_key");
    if (!apiKey) {
      return {
        ok: false,
        error: `TINYFISH_API_KEY not configured. ${KEY_MISSING_HINT}`,
      };
    }
    const format = args.format ?? "markdown";
    const body = JSON.stringify({
      urls: [url],
      format,
      links: args.links === true,
      image_links: args.image_links === true,
    });
    const r = await deps.fetchHttp(TINYFISH_FETCH_URL, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      if (r.status === 429) {
        const retry = r.headers?.["retry-after"];
        return {
          ok: false,
          error: `tinyfish_fetch rate limited by TinyFish (HTTP 429)${
            retry ? `, retry-after: ${retry}` : ""
          }. ${bodyExcerpt(r.text)}`,
          status: r.status,
          retry_after: retry ?? null,
        };
      }
      if (r.status === 401) {
        return {
          ok: false,
          error: `tinyfish_fetch HTTP 401: invalid or missing API key. ${bodyExcerpt(r.text)}`,
          status: r.status,
          hint: "Re-mint your key at https://agent.tinyfish.ai and update the `tinyfish_api_key` secret (dashboard panel or plist).",
        };
      }
      if (r.status === 0) {
        return {
          ok: false,
          error: `tinyfish_fetch network error: ${r.error ?? "unknown"}`,
          latency_ms: r.latencyMs,
        };
      }
      return {
        ok: false,
        error: `tinyfish_fetch HTTP ${r.status}: ${bodyExcerpt(r.text)}`,
        status: r.status,
      };
    }
    let parsed: TinyFishFetchResponse;
    try {
      parsed = JSON.parse(r.text) as TinyFishFetchResponse;
    } catch (err) {
      return {
        ok: false,
        error: `tinyfish_fetch response was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const errors = parsed.errors ?? [];
    const results = parsed.results ?? [];
    // We send a single URL; surface the first result as the canonical
    // payload. If the request URL appears in `errors` instead, treat it
    // as a structured per-URL failure.
    const perUrlError = errors.find((e) => e.url === url);
    if (perUrlError && results.length === 0) {
      return {
        ok: false,
        error: `tinyfish_fetch per-URL failure: ${perUrlError.error ?? "unknown"}`,
        status: perUrlError.status ?? null,
        url,
      };
    }
    const first = results[0];
    if (!first) {
      return {
        ok: false,
        error: "tinyfish_fetch returned no results and no errors",
      };
    }
    const text = first.text ?? "";
    return {
      ok: true,
      url,
      final_url: first.final_url ?? url,
      format: first.format ?? format,
      latency_ms: r.latencyMs,
      upstream_latency_ms:
        typeof first.latency_ms === "number" ? first.latency_ms : null,
      markdown: text,
      markdown_length: text.length,
      metadata: {
        title: typeof first.title === "string" ? first.title : null,
        description:
          typeof first.description === "string" ? first.description : null,
        language: typeof first.language === "string" ? first.language : null,
        author: typeof first.author === "string" ? first.author : null,
        published_date:
          typeof first.published_date === "string"
            ? first.published_date
            : null,
      },
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const tinyfishTools = {
  tinyfish_search,
  tinyfish_fetch,
};
