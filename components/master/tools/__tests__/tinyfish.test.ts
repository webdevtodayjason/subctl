// components/master/tools/__tests__/tinyfish.test.ts
//
// Tests for the v2.7.16 tinyfish-tool family (tinyfish_search +
// tinyfish_fetch). Every path is hermetic — the injectable `fetchHttp`
// dep takes the place of `globalThis.fetch`, so the suite never hits
// api.search.tinyfish.ai or api.fetch.tinyfish.ai for real. Covers:
// happy paths, missing API key, network error / timeout, rate limit
// (429), 401 (invalid key), 4xx, 5xx, malformed JSON, invalid URL, and
// the family export shape. Mirrors the pattern in web.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  tinyfishTools,
} from "../tinyfish";

afterEach(() => {
  _resetDepsForTesting();
  delete process.env.TINYFISH_API_KEY;
});

// Type-narrowing helper — invoke returns `unknown`. Tests know the shape.
async function callTool<T = Record<string, unknown>>(
  tool: { invoke: (args: Record<string, unknown>) => Promise<unknown> },
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await tool.invoke(args)) as T;
}

// ---------------------------------------------------------------------------
// tinyfish_search — GET https://api.search.tinyfish.ai
// ---------------------------------------------------------------------------

describe("tinyfish_search", () => {
  beforeEach(() => {
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
  });

  test("happy path — returns results, total_results, page", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedMethod: string | undefined;
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedMethod = opts.method;
        return {
          ok: true,
          status: 200,
          latencyMs: 88,
          text: JSON.stringify({
            query: "anthropic api docs",
            total_results: 42,
            page: 0,
            results: [
              {
                position: 1,
                site_name: "docs.anthropic.com",
                title: "Anthropic API docs",
                snippet: "Official documentation for the Claude API.",
                url: "https://docs.anthropic.com",
              },
              {
                position: 2,
                site_name: "tinyfish.ai",
                title: "TinyFish",
                snippet: "Web agent toolkit.",
                url: "https://tinyfish.ai",
              },
            ],
          }),
        };
      },
    });
    const r = await callTool<{
      ok: boolean;
      query: string;
      count_returned: number;
      total_results: number | null;
      page: number;
      results: Array<{
        position: number | null;
        title: string;
        url: string;
        snippet: string;
        site_name: string;
      }>;
      latency_ms: number;
    }>(tinyfishTools.tinyfish_search, { query: "anthropic api docs" });
    expect(r.ok).toBe(true);
    expect(r.query).toBe("anthropic api docs");
    expect(r.count_returned).toBe(2);
    expect(r.total_results).toBe(42);
    expect(r.page).toBe(0);
    expect(r.results[0]!.position).toBe(1);
    expect(r.results[0]!.title).toBe("Anthropic API docs");
    expect(r.results[0]!.url).toContain("anthropic.com");
    expect(r.results[0]!.site_name).toBe("docs.anthropic.com");
    expect(r.latency_ms).toBe(88);
    // Confirm endpoint, method, header, query encoding.
    expect(capturedMethod).toBe("GET");
    expect(capturedUrl).toContain("api.search.tinyfish.ai");
    expect(capturedUrl).toContain("query=anthropic+api+docs");
    expect(capturedHeaders?.["X-API-Key"]).toBe("test-tinyfish-key");
    expect(capturedHeaders?.["Accept"]).toBe("application/json");
  });

  test("forwards optional location, language, and page params", async () => {
    let capturedUrl = "";
    _setDepsForTesting({
      fetchHttp: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({ query: "x", results: [] }),
        };
      },
    });
    await callTool(tinyfishTools.tinyfish_search, {
      query: "weather",
      location: "GB",
      language: "en",
      page: 2,
    });
    expect(capturedUrl).toContain("location=GB");
    expect(capturedUrl).toContain("language=en");
    expect(capturedUrl).toContain("page=2");
  });

  test("clamps page to [0, 10]", async () => {
    let capturedUrl = "";
    _setDepsForTesting({
      fetchHttp: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({ results: [] }),
        };
      },
    });
    await callTool(tinyfishTools.tinyfish_search, { query: "x", page: 99 });
    expect(capturedUrl).toContain("page=10");
    await callTool(tinyfishTools.tinyfish_search, { query: "x", page: -5 });
    expect(capturedUrl).toContain("page=0");
  });

  test("missing TINYFISH_API_KEY returns structured error with setup hint", async () => {
    delete process.env.TINYFISH_API_KEY;
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("fetchHttp must not be called when key is missing");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_search,
      { query: "test" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("TINYFISH_API_KEY");
    expect(r.error).toContain("agent.tinyfish.ai");
    expect(r.error).toContain("secrets.json");
  });

  test("missing query returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_search,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("query is required");
  });

  test("network error / timeout surfaces as structured error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 0,
        text: "",
        latencyMs: 30_000,
        error: "timeout after 30000ms",
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      latency_ms: number;
    }>(tinyfishTools.tinyfish_search, { query: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network error");
    expect(r.error).toContain("timeout");
    expect(r.latency_ms).toBe(30_000);
  });

  test("rate limit (429) returns retry_after when header present", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 429,
        latencyMs: 22,
        text: '{"error":"too many requests"}',
        headers: { "retry-after": "30" },
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      status: number;
      retry_after: string | null;
    }>(tinyfishTools.tinyfish_search, { query: "x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after).toBe("30");
    expect(r.error).toContain("rate limited");
  });

  test("401 (invalid key) returns structured error with re-mint hint", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 401,
        latencyMs: 18,
        text: '{"error":"missing or invalid API key"}',
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      status: number;
      hint: string;
    }>(tinyfishTools.tinyfish_search, { query: "x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toContain("HTTP 401");
    expect(r.hint).toContain("agent.tinyfish.ai");
  });

  test("5xx returns structured error with body excerpt", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 503,
        latencyMs: 12,
        text: "Service Unavailable",
      }),
    });
    const r = await callTool<{ ok: boolean; error: string; status: number }>(
      tinyfishTools.tinyfish_search,
      { query: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(r.error).toContain("HTTP 503");
    expect(r.error).toContain("Service Unavailable");
  });

  test("malformed JSON body surfaces a parse error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 5,
        text: "<html>not json</html>",
      }),
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_search,
      { query: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// tinyfish_fetch — POST https://api.fetch.tinyfish.ai
// ---------------------------------------------------------------------------

describe("tinyfish_fetch", () => {
  beforeEach(() => {
    process.env.TINYFISH_API_KEY = "test-tinyfish-key";
  });

  test("happy path — returns markdown + metadata + final_url", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedMethod: string | undefined;
    let capturedBody = "";
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedMethod = opts.method;
        capturedBody = opts.body ?? "";
        return {
          ok: true,
          status: 200,
          latencyMs: 412,
          text: JSON.stringify({
            results: [
              {
                url: "https://example.com/post/1",
                final_url: "https://example.com/post/1",
                title: "Hello page",
                description: "A friendly greeting.",
                language: "en",
                author: "Jane Doe",
                published_date: "2026-01-15",
                text: "# Hello\n\nThis is the page body.",
                latency_ms: 380,
                format: "markdown",
              },
            ],
            errors: [],
          }),
        };
      },
    });
    const r = await callTool<{
      ok: boolean;
      url: string;
      final_url: string;
      format: string;
      markdown: string;
      markdown_length: number;
      metadata: {
        title: string | null;
        description: string | null;
        language: string | null;
        author: string | null;
        published_date: string | null;
      };
      latency_ms: number;
      upstream_latency_ms: number | null;
    }>(tinyfishTools.tinyfish_fetch, { url: "https://example.com/post/1" });
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://example.com/post/1");
    expect(r.final_url).toBe("https://example.com/post/1");
    expect(r.format).toBe("markdown");
    expect(r.markdown).toContain("# Hello");
    expect(r.markdown_length).toBe(r.markdown.length);
    expect(r.metadata.title).toBe("Hello page");
    expect(r.metadata.description).toBe("A friendly greeting.");
    expect(r.metadata.author).toBe("Jane Doe");
    expect(r.metadata.published_date).toBe("2026-01-15");
    expect(r.metadata.language).toBe("en");
    expect(r.latency_ms).toBe(412);
    expect(r.upstream_latency_ms).toBe(380);
    // Wire-shape checks.
    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe("https://api.fetch.tinyfish.ai");
    expect(capturedHeaders?.["X-API-Key"]).toBe("test-tinyfish-key");
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
    const sentBody = JSON.parse(capturedBody);
    expect(sentBody.urls).toEqual(["https://example.com/post/1"]);
    expect(sentBody.format).toBe("markdown");
    expect(sentBody.links).toBe(false);
    expect(sentBody.image_links).toBe(false);
  });

  test("format / links / image_links flags are honored on the wire", async () => {
    let sentBody: {
      urls: string[];
      format: string;
      links: boolean;
      image_links: boolean;
    } | null = null;
    _setDepsForTesting({
      fetchHttp: async (_url, opts) => {
        sentBody = JSON.parse(opts.body ?? "{}");
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({
            results: [
              {
                url: "https://example.com",
                text: "<h1>x</h1>",
                format: "html",
              },
            ],
          }),
        };
      },
    });
    await callTool(tinyfishTools.tinyfish_fetch, {
      url: "https://example.com",
      format: "html",
      links: true,
      image_links: true,
    });
    expect(sentBody!.format).toBe("html");
    expect(sentBody!.links).toBe(true);
    expect(sentBody!.image_links).toBe(true);
  });

  test("missing TINYFISH_API_KEY returns structured error with setup hint", async () => {
    delete process.env.TINYFISH_API_KEY;
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_fetch,
      { url: "https://example.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("TINYFISH_API_KEY");
    expect(r.error).toContain("agent.tinyfish.ai");
  });

  test("invalid URL returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r1 = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_fetch,
      { url: "not a url" },
    );
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("invalid URL");
    // ftp scheme rejected — http(s) only.
    const r2 = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_fetch,
      { url: "ftp://example.com/file" },
    );
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("invalid URL");
  });

  test("missing url returns ok=false", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_fetch,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("url is required");
  });

  test("5xx returns structured error with body excerpt", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 502,
        latencyMs: 18,
        text: "Bad Gateway",
      }),
    });
    const r = await callTool<{ ok: boolean; error: string; status: number }>(
      tinyfishTools.tinyfish_fetch,
      { url: "https://example.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.error).toContain("HTTP 502");
    expect(r.error).toContain("Bad Gateway");
  });

  test("per-URL failure in errors array surfaces as structured error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 30,
        text: JSON.stringify({
          results: [],
          errors: [
            {
              url: "https://example.com/blocked",
              error: "robots_blocked",
              status: 403,
            },
          ],
        }),
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      status: number | null;
      url: string;
    }>(tinyfishTools.tinyfish_fetch, { url: "https://example.com/blocked" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("robots_blocked");
    expect(r.status).toBe(403);
    expect(r.url).toBe("https://example.com/blocked");
  });

  test("401 (invalid key) returns structured error with re-mint hint", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 401,
        latencyMs: 9,
        text: '{"error":"missing or invalid API key"}',
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      status: number;
      hint: string;
    }>(tinyfishTools.tinyfish_fetch, { url: "https://example.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toContain("HTTP 401");
    expect(r.hint).toContain("agent.tinyfish.ai");
  });

  test("rate limit (429) returns retry_after when header present", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 429,
        latencyMs: 11,
        text: '{"error":"rate limit exceeded"}',
        headers: { "retry-after": "60" },
      }),
    });
    const r = await callTool<{
      ok: boolean;
      error: string;
      status: number;
      retry_after: string | null;
    }>(tinyfishTools.tinyfish_fetch, { url: "https://example.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after).toBe("60");
    expect(r.error).toContain("rate limited");
  });

  test("malformed JSON body surfaces a parse error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 5,
        text: "<html>not json</html>",
      }),
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      tinyfishTools.tinyfish_fetch,
      { url: "https://example.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// Family export sanity
// ---------------------------------------------------------------------------

describe("tinyfishTools family export", () => {
  test("exports search + fetch + agent (v2.7.27) with the expected shape", () => {
    expect(Object.keys(tinyfishTools).sort()).toEqual([
      "tinyfish_agent",
      "tinyfish_fetch",
      "tinyfish_search",
    ]);
    for (const [name, t] of Object.entries(tinyfishTools)) {
      expect(typeof t.description, name).toBe("string");
      expect(t.description.length, name).toBeGreaterThan(20);
      // Imperative-voice marker from the Evy persona pattern.
      expect(t.description, name).toContain("Use this when");
      expect(typeof t.schema, name).toBe("object");
      expect(typeof t.invoke, name).toBe("function");
    }
  });
});
