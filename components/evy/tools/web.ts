// web tools — web search + web fetch for the master daemon.
//
// Origin: 2026-05-12 morning Telegram exchange. After v2.7.1 shipped
// the self-diagnostic family, the M3 agent asked whether it had any
// way to search the live web — current docs, current API references,
// current Anthropic / OpenAI announcements. The operator confirmed
// "no, not yet" and funded two third-party services on the spot:
// Brave AI Search for the search side, Firecrawl for the fetch /
// scrape side. Two new master tools land in v2.7.2 here. Same
// persistent-supervisor pattern as v2.7.1 (`diag.ts`): agent hits a
// capability gap, asks, capability ships.
//
// Both tools are READ-ONLY. Results are returned directly to the
// caller; nothing is cached to subctl state, written to disk, or
// otherwise persisted. API keys live in the master daemon process
// environment (operator paste into the plist EnvironmentVariables
// block AFTER deploy) — when a key is missing the tool returns a
// structured error with an actionable hint, never throws.
//
// Tool family:
//   web_search  — Brave AI Search (top results: title + url + snippet)
//   web_fetch   — Firecrawl (URL → clean markdown)
//
// HTTP errors (network, 4xx, 5xx, timeout, rate limit) all surface as
// `{ ok: false, error: "..." }`. The caller (an LLM agent) reads the
// error string and decides whether to retry, narrow the query, or
// move on. Tools never throw to the caller.

// ─── injectable side-effect surface (for tests) ────────────────────────────
//
// Same pattern as diag.ts: a `Deps` object the tools call into instead
// of `globalThis.fetch` directly, so the test suite swaps in a canned
// `fetch` without touching the network. The `now` clock is injectable
// for deterministic latency assertions.

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

// v2.7.4 added a dashboard-managed secrets.json layer below the env-var
// layer, so the operator no longer has to edit the launchd plist to
// rotate Brave / Firecrawl / Linear / Context7 keys. The hint surfaces
// both paths.
const KEY_MISSING_HINT =
  "Set it via the dashboard Settings → API Tokens panel (writes ~/.config/subctl/secrets.json, chmod 600) OR in ~/Library/LaunchAgents/com.subctl.master.plist EnvironmentVariables followed by `launchctl kickstart -k gui/$UID/com.subctl.master`.";

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

// ─── tool 1: web_search (Brave AI Search) ──────────────────────────────────

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_TIMEOUT_MS = 30_000;

interface BraveSearchResultRaw {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResultRaw[];
  };
}

const web_search = {
  description:
    "Search the web via Brave AI Search. Returns top results with title + URL + snippet. Useful for current docs, news, API references, or verifying claims that may have changed since the model was trained. Requires BRAVE_API_KEY env var on the master daemon — returns a structured error with setup hint if missing.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      count: {
        type: "integer",
        description: "Number of results to return (default 10, max 20)",
        minimum: 1,
        maximum: 20,
      },
    },
    required: ["query"],
  },
  invoke: async (args: { query?: string; count?: number } = {}) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, error: "query is required and must be a non-empty string" };
    }
    const requestedCount = Math.min(Math.max(args.count ?? 10, 1), 20);
    // v2.7.4 priority chain: env > secrets.json > absent.
    const apiKey = resolveSecret("brave_api_key");
    if (!apiKey) {
      return {
        ok: false,
        error: `BRAVE_API_KEY not configured. ${KEY_MISSING_HINT}`,
      };
    }
    const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${requestedCount}`;
    const r = await deps.fetchHttp(url, {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      // Rate limit gets a dedicated branch so the caller can back off
      // intelligently. Brave returns 429 with optional retry-after.
      if (r.status === 429) {
        const retry = r.headers?.["retry-after"];
        return {
          ok: false,
          error: `web_search rate limited by Brave (HTTP 429)${
            retry ? `, retry-after: ${retry}` : ""
          }. ${bodyExcerpt(r.text)}`,
          status: r.status,
          retry_after: retry ?? null,
        };
      }
      if (r.status === 0) {
        return {
          ok: false,
          error: `web_search network error: ${r.error ?? "unknown"}`,
          latency_ms: r.latencyMs,
        };
      }
      return {
        ok: false,
        error: `web_search HTTP ${r.status}: ${bodyExcerpt(r.text)}`,
        status: r.status,
      };
    }
    let parsed: BraveSearchResponse;
    try {
      parsed = JSON.parse(r.text) as BraveSearchResponse;
    } catch (err) {
      return {
        ok: false,
        error: `web_search response was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const raw = parsed.web?.results ?? [];
    const results = raw.slice(0, requestedCount).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      description: x.description ?? "",
    }));
    return {
      ok: true,
      query,
      count_requested: requestedCount,
      count_returned: results.length,
      latency_ms: r.latencyMs,
      results,
    };
  },
};

// ─── tool 2: web_fetch (Firecrawl) ─────────────────────────────────────────

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v0/scrape";
const FETCH_TIMEOUT_MS = 60_000;

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    content?: string;
    metadata?: {
      title?: string;
      description?: string;
      [k: string]: unknown;
    };
  };
  error?: string;
}

const web_fetch = {
  description:
    "Fetch a URL and convert to clean markdown via Firecrawl. Use when you need to read a specific page's content (docs, articles, GitHub READMEs, API references). Strips nav/footer/sidebar by default so the agent gets the article body, not the chrome. Requires FIRECRAWL_API_KEY env var on the master daemon — returns a structured error with setup hint if missing.",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch (http/https only)" },
      onlyMainContent: {
        type: "boolean",
        description: "Strip nav/footer/sidebar (default true)",
      },
    },
    required: ["url"],
  },
  invoke: async (args: { url?: string; onlyMainContent?: boolean } = {}) => {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) {
      return { ok: false, error: "url is required and must be a non-empty string" };
    }
    if (!isValidUrl(url)) {
      return {
        ok: false,
        error: `web_fetch invalid URL: must be http:// or https://, got ${bodyExcerpt(url, 120)}`,
      };
    }
    const onlyMainContent = args.onlyMainContent !== false; // default true
    // v2.7.4 priority chain: env > secrets.json > absent.
    const apiKey = resolveSecret("firecrawl_api_key");
    if (!apiKey) {
      return {
        ok: false,
        error: `FIRECRAWL_API_KEY not configured. ${KEY_MISSING_HINT}`,
      };
    }
    const body = JSON.stringify({
      url,
      pageOptions: { onlyMainContent },
    });
    const r = await deps.fetchHttp(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      if (r.status === 429) {
        const retry = r.headers?.["retry-after"];
        return {
          ok: false,
          error: `web_fetch rate limited by Firecrawl (HTTP 429)${
            retry ? `, retry-after: ${retry}` : ""
          }. ${bodyExcerpt(r.text)}`,
          status: r.status,
          retry_after: retry ?? null,
        };
      }
      if (r.status === 0) {
        return {
          ok: false,
          error: `web_fetch network error: ${r.error ?? "unknown"}`,
          latency_ms: r.latencyMs,
        };
      }
      return {
        ok: false,
        error: `web_fetch HTTP ${r.status}: ${bodyExcerpt(r.text)}`,
        status: r.status,
      };
    }
    let parsed: FirecrawlResponse;
    try {
      parsed = JSON.parse(r.text) as FirecrawlResponse;
    } catch (err) {
      return {
        ok: false,
        error: `web_fetch response was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (parsed.success === false || !parsed.data) {
      return {
        ok: false,
        error: `web_fetch Firecrawl reported failure: ${
          parsed.error ?? "no data field in response"
        }`,
      };
    }
    const markdown = parsed.data.markdown ?? parsed.data.content ?? "";
    const meta = parsed.data.metadata ?? {};
    return {
      ok: true,
      url,
      onlyMainContent,
      latency_ms: r.latencyMs,
      markdown,
      markdown_length: markdown.length,
      metadata: {
        title: typeof meta.title === "string" ? meta.title : null,
        description:
          typeof meta.description === "string" ? meta.description : null,
      },
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const webTools = {
  web_search,
  web_fetch,
};
