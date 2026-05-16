// components/master/tools/tinyfish.ts
//
// TinyFish web toolkit integration — three tools across the
// free + paid tiers:
//   - tinyfish_search — live web search, structured agent-ready results (v2.7.16, free)
//   - tinyfish_fetch  — full-page content extraction as clean markdown (v2.7.16, free)
//   - tinyfish_agent  — natural-language browser-automation agent (v2.7.27, paid: credits)
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
//   - Agent: POST https://agent.tinyfish.ai/v1/automation/run
//     body: { url (req), goal (req), browser_profile?, agent_config?,
//             capture_config?, output_schema?, ... }
//     response: { run_id, status: "COMPLETED"|"FAILED", started_at,
//                 finished_at, num_of_steps, result, error }
//     5xx → retries up to 3 attempts with exponential backoff; 4xx
//     surfaces directly (no retry, no credits consumed on auth/billing
//     errors).
//   - Auth: X-API-Key header (NOT Authorization: Bearer; the brief
//     used "tinyfish_oauth_token" assuming OAuth, but the REST API
//     uses an API key obtained by signing up at agent.tinyfish.ai —
//     the MCP endpoint's OAuth flow is a separate auth surface).
//   - Free tier: 30 req/min; 429 returned with rate limit excess.
//   - "Search and Fetch do not use credits" per TinyFish docs.
//   - Agent and Browser DO use credits. tinyfish_agent runs that
//     return `status: "FAILED"` due to operator goal phrasing still
//     consume credits; SYSTEM_FAILURE may be refunded per TinyFish
//     billing terms (verify with TinyFish, not subctl).
//
// All three tools are READ-ONLY from subctl's perspective — nothing is
// cached to subctl state, written to disk, or otherwise persisted.
// (The agent itself may interact with target sites; that's the
// operator's responsibility to mandate appropriately via the `goal`.)
// HTTP errors (network, 4xx, 5xx, timeout, rate limit) all surface as
// `{ ok: false, error: "..." }` — tools never throw to the caller.
// Pattern mirrors components/master/tools/web.ts.

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
  /**
   * Sleep helper, injectable for tests. tinyfish_agent uses this for
   * exponential backoff between 5xx retries — tests stub it to a no-op
   * so the suite doesn't burn real wall time.
   */
  sleep: (ms: number) => Promise<void>;
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
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
const TINYFISH_AGENT_URL =
  process.env.TINYFISH_AGENT_URL ??
  "https://agent.tinyfish.ai/v1/automation/run";
const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
// Agent runs are long-lived (TinyFish hosts the browser, runs N steps,
// returns when done). The default operator-tunable max is 120s; HTTP
// timeout adds 30s headroom for the response to arrive after the agent
// itself wraps up.
const AGENT_DEFAULT_DURATION_SECONDS = 120;
const AGENT_HTTP_TIMEOUT_HEADROOM_MS = 30_000;
// Retry policy for 5xx + network errors. Auth/billing/rate-limit (4xx)
// never retry — the operator must intervene. Backoff: 500ms, 1500ms,
// 4500ms (exponential x3).
const AGENT_RETRY_MAX_ATTEMPTS = 3;
const AGENT_RETRY_BACKOFF_MS = [500, 1500, 4500];

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

// ─── tool 3: tinyfish_agent (v2.7.27) ──────────────────────────────────────

/**
 * Public input shape for `callTinyfishAgent` — used by tests and by any
 * direct caller that wants to invoke the agent outside the tool registry.
 * The tool-facing names match the operator's v2.7.27 spec; they are
 * mapped to TinyFish's `goal` / `url` / `max_duration_seconds` on the
 * wire.
 */
export interface TinyfishAgentArgs {
  /** Natural-language goal description. Maps to TinyFish `goal`. */
  task?: string;
  /**
   * Target URL the agent should start from. Maps to TinyFish `url`.
   * REQUIRED — the spec wording called this optional, but the
   * Agent API enforces `url` as required (per
   * docs.tinyfish.ai/api-reference/automation/run-browser-automation-synchronously
   * verified 2026-05-13). The agent does NOT free-pick a URL from
   * the task description.
   */
  starting_url?: string;
  /**
   * Max seconds the agent may spend on the task. Default 120.
   * Maps to TinyFish `agent_config.max_duration_seconds`. The outer
   * HTTP timeout is this value + 30s headroom.
   */
  timeout_seconds?: number;
  /** Optional cap on agent steps. Maps to `agent_config.max_steps`. */
  max_steps?: number;
  /**
   * Browser profile — "lite" (default; faster, less stealth) or
   * "stealth" (slower, anti-bot countermeasures). Maps to
   * `browser_profile`.
   */
  browser_profile?: "lite" | "stealth";
}

/** Per-attempt summary surfaced when retries kick in. */
export interface TinyfishAgentRetryAttempt {
  attempt: number;
  status: number;
  error?: string;
  latency_ms: number;
}

/** Public output shape. `ok: true` means status === "COMPLETED" on the wire. */
export type TinyfishAgentResult =
  | {
      ok: true;
      run_id: string | null;
      status: "COMPLETED";
      started_at: string | null;
      finished_at: string | null;
      num_of_steps: number | null;
      result: Record<string, unknown> | null;
      latency_ms: number;
      attempts: number;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      run_id?: string | null;
      retry_after?: string | null;
      hint?: string;
      retries?: TinyfishAgentRetryAttempt[];
      latency_ms?: number;
    };

interface TinyFishAgentErrorRaw {
  code?: string;
  message?: string;
  category?: string;
  retry_after?: number | null;
  help_url?: string;
  help_message?: string;
}

interface TinyFishAgentResponseRaw {
  run_id?: string | null;
  status?: "COMPLETED" | "FAILED" | string;
  started_at?: string | null;
  finished_at?: string | null;
  num_of_steps?: number | null;
  result?: Record<string, unknown> | null;
  error?: TinyFishAgentErrorRaw | null;
}

/**
 * Direct callable entry point. Exposed alongside the tool registry
 * entry so tests + other components can drive the Agent API without
 * going through the `invoke` indirection. Both surfaces share this
 * implementation.
 */
export async function callTinyfishAgent(
  args: TinyfishAgentArgs = {},
): Promise<TinyfishAgentResult> {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    return {
      ok: false,
      error: "task is required and must be a non-empty string",
    };
  }
  const startingUrl =
    typeof args.starting_url === "string" ? args.starting_url.trim() : "";
  if (!startingUrl) {
    return {
      ok: false,
      error:
        "starting_url is required — TinyFish Agent API requires an explicit target URL (it does not free-pick from the task description)",
    };
  }
  if (!isValidUrl(startingUrl)) {
    return {
      ok: false,
      error: `tinyfish_agent invalid starting_url: must be http:// or https://, got ${bodyExcerpt(startingUrl, 120)}`,
    };
  }
  const apiKey = resolveSecret("tinyfish_api_key");
  if (!apiKey) {
    return {
      ok: false,
      error: `TINYFISH_API_KEY not configured. ${KEY_MISSING_HINT}`,
    };
  }
  const rawTimeout =
    typeof args.timeout_seconds === "number" && args.timeout_seconds > 0
      ? Math.floor(args.timeout_seconds)
      : AGENT_DEFAULT_DURATION_SECONDS;
  // Per TinyFish docs: max_duration_seconds.minimum = 1; no documented
  // ceiling but the practical TinyFish-side cap is ~10 minutes. Clamp
  // to [1, 600] so a runaway operator instruction can't park the agent
  // forever.
  const durationSeconds = Math.max(1, Math.min(rawTimeout, 600));
  const httpTimeoutMs =
    durationSeconds * 1000 + AGENT_HTTP_TIMEOUT_HEADROOM_MS;

  const agentConfig: Record<string, unknown> = {
    max_duration_seconds: durationSeconds,
  };
  if (
    typeof args.max_steps === "number" &&
    args.max_steps > 0 &&
    args.max_steps <= 500
  ) {
    agentConfig.max_steps = Math.floor(args.max_steps);
  }

  const requestBody: Record<string, unknown> = {
    url: startingUrl,
    goal: task,
    agent_config: agentConfig,
  };
  if (args.browser_profile === "lite" || args.browser_profile === "stealth") {
    requestBody.browser_profile = args.browser_profile;
  }
  const body = JSON.stringify(requestBody);

  const retries: TinyfishAgentRetryAttempt[] = [];
  let r: FetchResult | null = null;
  let attempts = 0;
  for (let i = 1; i <= AGENT_RETRY_MAX_ATTEMPTS; i++) {
    attempts = i;
    r = await deps.fetchHttp(TINYFISH_AGENT_URL, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      timeoutMs: httpTimeoutMs,
    });
    // Retry on 5xx or transport-level network failure (status 0).
    // 4xx (auth, billing, rate-limit, invalid request) is operator-
    // actionable — surface immediately, never retry.
    const isRetryable = r.status === 0 || (r.status >= 500 && r.status < 600);
    if (!isRetryable) break;
    if (i < AGENT_RETRY_MAX_ATTEMPTS) {
      retries.push({
        attempt: i,
        status: r.status,
        error: r.error,
        latency_ms: r.latencyMs,
      });
      const backoff =
        AGENT_RETRY_BACKOFF_MS[i - 1] ??
        AGENT_RETRY_BACKOFF_MS[AGENT_RETRY_BACKOFF_MS.length - 1]!;
      await deps.sleep(backoff);
    }
  }
  if (!r) {
    return { ok: false, error: "tinyfish_agent: no response (no attempts made)" };
  }
  // Final non-2xx — surface with structured error.
  if (!r.ok) {
    if (r.status === 429) {
      const retry = r.headers?.["retry-after"];
      return {
        ok: false,
        error: `tinyfish_agent rate limited by TinyFish (HTTP 429)${
          retry ? `, retry-after: ${retry}` : ""
        }. ${bodyExcerpt(r.text)}`,
        status: r.status,
        retry_after: retry ?? null,
        retries: retries.length > 0 ? retries : undefined,
        latency_ms: r.latencyMs,
      };
    }
    if (r.status === 401) {
      return {
        ok: false,
        error: `tinyfish_agent HTTP 401: invalid or missing API key. ${bodyExcerpt(r.text)}`,
        status: r.status,
        hint: "Re-mint your key at https://agent.tinyfish.ai and update the `tinyfish_api_key` secret (dashboard panel or plist).",
        latency_ms: r.latencyMs,
      };
    }
    if (r.status === 402) {
      return {
        ok: false,
        error: `tinyfish_agent HTTP 402 (Payment Required): TinyFish credit balance exhausted. ${bodyExcerpt(r.text)}`,
        status: r.status,
        hint: "Top up credits at https://agent.tinyfish.ai/billing. Agent + Browser surfaces consume credits; Search + Fetch do not.",
        latency_ms: r.latencyMs,
      };
    }
    if (r.status === 0) {
      return {
        ok: false,
        error: `tinyfish_agent network error after ${attempts} attempts: ${r.error ?? "unknown"}`,
        latency_ms: r.latencyMs,
        retries: retries.length > 0 ? retries : undefined,
      };
    }
    return {
      ok: false,
      error: `tinyfish_agent HTTP ${r.status}${
        r.status >= 500 ? ` after ${attempts} attempts` : ""
      }: ${bodyExcerpt(r.text)}`,
      status: r.status,
      retries: retries.length > 0 ? retries : undefined,
      latency_ms: r.latencyMs,
    };
  }
  // 2xx — parse the agent envelope. `status` inside the body still may
  // be "FAILED" (agent reached an error state mid-run); that surfaces as
  // ok=false with the agent's structured error attached.
  let parsed: TinyFishAgentResponseRaw;
  try {
    parsed = JSON.parse(r.text) as TinyFishAgentResponseRaw;
  } catch (err) {
    return {
      ok: false,
      error: `tinyfish_agent response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      latency_ms: r.latencyMs,
    };
  }
  if (parsed.status === "FAILED") {
    const errPayload = parsed.error ?? {};
    const category = errPayload.category ?? "UNKNOWN";
    const code = errPayload.code ?? "";
    const message = errPayload.message ?? "no error message provided";
    return {
      ok: false,
      error: `tinyfish_agent run FAILED (${category}${code ? `:${code}` : ""}): ${message}`,
      status: r.status,
      run_id: parsed.run_id ?? null,
      retry_after:
        typeof errPayload.retry_after === "number"
          ? String(errPayload.retry_after)
          : null,
      hint: errPayload.help_message ?? errPayload.help_url,
      latency_ms: r.latencyMs,
    };
  }
  if (parsed.status !== "COMPLETED") {
    return {
      ok: false,
      error: `tinyfish_agent returned unexpected status: ${
        parsed.status ?? "(missing)"
      }`,
      status: r.status,
      latency_ms: r.latencyMs,
    };
  }
  return {
    ok: true,
    run_id: parsed.run_id ?? null,
    status: "COMPLETED",
    started_at: parsed.started_at ?? null,
    finished_at: parsed.finished_at ?? null,
    num_of_steps:
      typeof parsed.num_of_steps === "number" ? parsed.num_of_steps : null,
    result: parsed.result ?? null,
    latency_ms: r.latencyMs,
    attempts,
  };
}

const tinyfish_agent = {
  description:
    "**Use this when** you need a hosted browser to actually *do something* on a page — fill a form, click through a multi-step flow, scrape dynamic content that requires interaction, run a natural-language workflow on a real site. TinyFish operates the browser on their cloud, executes your `task` starting from `starting_url`, and returns the extracted result + run metadata. For pure read/search use `tinyfish_search` (live web search) or `tinyfish_fetch` (URL → markdown) instead — those are free; this consumes TinyFish credits. Requires `tinyfish_api_key` (or TINYFISH_API_KEY env var) on the master daemon. 5xx errors retry with exponential backoff (3 attempts); 4xx surfaces immediately.",
  schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Natural-language description of what the agent should do, e.g. 'Find the pricing page and extract all plan details' or 'Fill the email field with x@y.com, click Sign In, return the resulting page title'.",
      },
      starting_url: {
        type: "string",
        description:
          "Target URL the agent starts from (http:// or https:// only). REQUIRED — the Agent API does not free-pick a URL from the task.",
      },
      timeout_seconds: {
        type: "number",
        description:
          "Max seconds the agent may spend (1–600, default 120). The outer HTTP timeout adds 30s headroom.",
        minimum: 1,
        maximum: 600,
      },
      max_steps: {
        type: "integer",
        description:
          "Optional cap on agent steps (1–500). Useful for bounding cost on exploratory tasks.",
        minimum: 1,
        maximum: 500,
      },
      browser_profile: {
        type: "string",
        enum: ["lite", "stealth"],
        description:
          "'lite' (default, faster) or 'stealth' (slower, anti-bot countermeasures). Pick stealth only for sites that block 'lite'.",
      },
    },
    required: ["task", "starting_url"],
  },
  invoke: async (args: TinyfishAgentArgs = {}) => callTinyfishAgent(args),
};

// ─── tool 4: tinyfish_agent_async (v2.8.10) ────────────────────────────────
//
// Fire-and-forget wrapper around callTinyfishAgent. Returns a run_id
// immediately so the operator can keep the conversation moving while
// the agent runs on TinyFish's cloud. On completion the result is
// surfaced (a) via tray notification and (b) prepended to the
// operator's NEXT chat/telegram prompt — see
// components/master/background-runs.ts for the surfacing mechanism.
//
// Limitation: this run does NOT survive a master restart. The underlying
// fetch terminates with the process. For restart-durable runs against
// TinyFish use the MCP `run_web_automation_async` flow directly (it
// keeps state on TinyFish's side). Phase A trades durability for
// simplicity.

import { startBackgroundRun } from "../background-runs";

const tinyfish_agent_async = {
  description:
    "**Use this when** you'd otherwise call `tinyfish_agent` but the task is likely to take more than ~15s and the operator wants to keep talking while it runs. Returns immediately with a `run_id`; the result is delivered as a tray notification and prepended to the operator's next message. Same arguments as `tinyfish_agent`. Limitation: the run terminates if master is restarted before it completes.",
  schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Natural-language goal description (same as tinyfish_agent).",
      },
      starting_url: {
        type: "string",
        description: "Target URL the agent starts from (same as tinyfish_agent).",
      },
      timeout_seconds: {
        type: "number",
        description: "Max seconds the agent may spend (1–600, default 120).",
        minimum: 1,
        maximum: 600,
      },
      max_steps: {
        type: "integer",
        description: "Optional cap on agent steps (1–500).",
        minimum: 1,
        maximum: 500,
      },
      browser_profile: {
        type: "string",
        enum: ["lite", "stealth"],
        description: "'lite' (default) or 'stealth'.",
      },
      label: {
        type: "string",
        description:
          "Optional short label so the operator + Evy can recognize this run in background_status output.",
      },
    },
    required: ["task", "starting_url"],
  },
  invoke: async (args: TinyfishAgentArgs & { label?: string } = {}) => {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    const starting_url =
      typeof args.starting_url === "string" ? args.starting_url.trim() : "";
    if (!task || !starting_url) {
      return {
        ok: false,
        error:
          "tinyfish_agent_async requires both `task` and `starting_url` (same as tinyfish_agent).",
      };
    }
    const argsSummary = `${task.slice(0, 80)} @ ${starting_url}`;
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: argsSummary,
      label: args.label,
      executor: async (_signal) => {
        // Note: callTinyfishAgent builds its own AbortSignal.timeout
        // internally. Phase A doesn't thread _signal through yet — Phase
        // C's cancel UX needs to refactor fetchHttp to accept an external
        // signal. Tracked in the Phase C task.
        const out = await callTinyfishAgent(args);
        if (out.ok) return { ok: true, result: out };
        return { ok: false, error: out.error };
      },
    });
    return {
      ok: true,
      run_id: id,
      status: "started",
      tool_name: "tinyfish_agent",
      args_summary: argsSummary,
      label: args.label ?? null,
      note: "Result will be delivered as a notification and prepended to the operator's next chat/telegram message.",
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const tinyfishTools = {
  tinyfish_search,
  tinyfish_fetch,
  tinyfish_agent,
  tinyfish_agent_async,
};
