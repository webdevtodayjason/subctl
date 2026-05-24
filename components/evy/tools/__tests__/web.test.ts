// components/master/tools/__tests__/web.test.ts
//
// Tests for the v2.7.2 web-tool family (web_search + web_fetch).
// Every path is hermetic — the injectable `fetchHttp` dep takes the
// place of `globalThis.fetch`, so the suite never hits Brave or
// Firecrawl for real. Covers: happy paths, missing API key,
// network error / timeout, rate limit (429), 4xx, 5xx, malformed
// JSON, invalid URL, and the family export shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  webTools,
} from "../web";

afterEach(() => {
  _resetDepsForTesting();
  delete process.env.BRAVE_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});

// Type-narrowing helper — invoke returns `unknown`. Tests know the shape.
async function callTool<T = Record<string, unknown>>(
  tool: { invoke: (args: Record<string, unknown>) => Promise<unknown> },
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await tool.invoke(args)) as T;
}

// ---------------------------------------------------------------------------
// web_search — Brave AI Search
// ---------------------------------------------------------------------------

describe("web_search", () => {
  beforeEach(() => {
    process.env.BRAVE_API_KEY = "test-brave-key";
  });

  test("happy path — returns results from Brave web.results", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          latencyMs: 142,
          text: JSON.stringify({
            web: {
              results: [
                {
                  title: "Anthropic API docs",
                  url: "https://docs.anthropic.com",
                  description: "Official documentation for the Claude API.",
                },
                {
                  title: "Brave Search API",
                  url: "https://api.search.brave.com",
                  description: "Independent search index.",
                },
              ],
            },
          }),
        };
      },
    });
    const r = await callTool<{
      ok: boolean;
      query: string;
      count_requested: number;
      count_returned: number;
      results: Array<{ title: string; url: string; description: string }>;
      latency_ms: number;
    }>(webTools.web_search, { query: "anthropic api docs", count: 5 });
    expect(r.ok).toBe(true);
    expect(r.query).toBe("anthropic api docs");
    expect(r.count_requested).toBe(5);
    expect(r.count_returned).toBe(2);
    expect(r.results[0]!.title).toBe("Anthropic API docs");
    expect(r.results[0]!.url).toContain("anthropic.com");
    expect(r.latency_ms).toBe(142);
    // Confirm Brave header + query encoding made it onto the wire.
    expect(capturedUrl).toContain("api.search.brave.com");
    expect(capturedUrl).toContain("q=anthropic%20api%20docs");
    expect(capturedUrl).toContain("count=5");
    expect(capturedHeaders?.["X-Subscription-Token"]).toBe("test-brave-key");
    expect(capturedHeaders?.["Accept"]).toBe("application/json");
  });

  test("defaults to count=10 when not provided", async () => {
    let capturedUrl = "";
    _setDepsForTesting({
      fetchHttp: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({ web: { results: [] } }),
        };
      },
    });
    const r = await callTool<{ count_requested: number }>(webTools.web_search, {
      query: "hello",
    });
    expect(r.count_requested).toBe(10);
    expect(capturedUrl).toContain("count=10");
  });

  test("clamps count to [1, 20]", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 1,
        text: JSON.stringify({ web: { results: [] } }),
      }),
    });
    const high = await callTool<{ count_requested: number }>(webTools.web_search, {
      query: "x",
      count: 99,
    });
    expect(high.count_requested).toBe(20);
    const low = await callTool<{ count_requested: number }>(webTools.web_search, {
      query: "x",
      count: 0,
    });
    expect(low.count_requested).toBe(1);
  });

  test("missing BRAVE_API_KEY returns structured error with plist hint", async () => {
    delete process.env.BRAVE_API_KEY;
    // fetchHttp should NEVER be called — surface that explicitly.
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("fetchHttp must not be called when key is missing");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_search, {
      query: "test",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("BRAVE_API_KEY");
    expect(r.error).toContain("com.subctl.master.plist");
    expect(r.error).toContain("launchctl");
  });

  test("missing query returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_search, {});
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
    const r = await callTool<{ ok: boolean; error: string; latency_ms: number }>(
      webTools.web_search,
      { query: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network error");
    expect(r.error).toContain("timeout");
    expect(r.latency_ms).toBe(30_000);
  });

  test("rate limit (429) returns structured error with retry_after", async () => {
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
    }>(webTools.web_search, { query: "x" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after).toBe("30");
    expect(r.error).toContain("rate limited");
  });

  test("4xx (e.g. 401 invalid key) returns structured error with body excerpt", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 401,
        latencyMs: 18,
        text: '{"error":"invalid subscription token"}',
      }),
    });
    const r = await callTool<{ ok: boolean; error: string; status: number }>(
      webTools.web_search,
      { query: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).toContain("invalid subscription token");
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
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_search, {
      query: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not valid JSON");
  });
});

// ---------------------------------------------------------------------------
// web_fetch — Firecrawl scrape
// ---------------------------------------------------------------------------

describe("web_fetch", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
  });

  test("happy path — returns markdown + metadata", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody = "";
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        capturedUrl = url;
        capturedHeaders = opts.headers;
        capturedBody = opts.body ?? "";
        return {
          ok: true,
          status: 200,
          latencyMs: 412,
          text: JSON.stringify({
            success: true,
            data: {
              markdown: "# Hello\n\nThis is the page body.",
              content: "<h1>Hello</h1>",
              metadata: {
                title: "Hello page",
                description: "A friendly greeting.",
              },
            },
          }),
        };
      },
    });
    const r = await callTool<{
      ok: boolean;
      url: string;
      markdown: string;
      markdown_length: number;
      metadata: { title: string | null; description: string | null };
      onlyMainContent: boolean;
      latency_ms: number;
    }>(webTools.web_fetch, { url: "https://example.com/post/1" });
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://example.com/post/1");
    expect(r.markdown).toContain("# Hello");
    expect(r.markdown_length).toBe(r.markdown.length);
    expect(r.metadata.title).toBe("Hello page");
    expect(r.metadata.description).toBe("A friendly greeting.");
    expect(r.onlyMainContent).toBe(true); // default
    expect(r.latency_ms).toBe(412);
    // Wire-shape checks.
    expect(capturedUrl).toBe("https://api.firecrawl.dev/v0/scrape");
    expect(capturedHeaders?.["Authorization"]).toBe("Bearer test-firecrawl-key");
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
    const sentBody = JSON.parse(capturedBody);
    expect(sentBody.url).toBe("https://example.com/post/1");
    expect(sentBody.pageOptions.onlyMainContent).toBe(true);
  });

  test("onlyMainContent=false is honored on the wire", async () => {
    let sentBody: { pageOptions: { onlyMainContent: boolean } } | null = null;
    _setDepsForTesting({
      fetchHttp: async (_url, opts) => {
        sentBody = JSON.parse(opts.body ?? "{}");
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({ success: true, data: { markdown: "" } }),
        };
      },
    });
    await callTool(webTools.web_fetch, {
      url: "https://example.com",
      onlyMainContent: false,
    });
    expect(sentBody!.pageOptions.onlyMainContent).toBe(false);
  });

  test("missing FIRECRAWL_API_KEY returns structured error with plist hint", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_fetch, {
      url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("FIRECRAWL_API_KEY");
    expect(r.error).toContain("com.subctl.master.plist");
  });

  test("invalid URL returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r1 = await callTool<{ ok: boolean; error: string }>(webTools.web_fetch, {
      url: "not a url",
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("invalid URL");
    // ftp scheme rejected too — http(s) only.
    const r2 = await callTool<{ ok: boolean; error: string }>(webTools.web_fetch, {
      url: "ftp://example.com/file",
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("invalid URL");
  });

  test("missing url returns ok=false", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_fetch, {});
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
      webTools.web_fetch,
      { url: "https://example.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.error).toContain("HTTP 502");
    expect(r.error).toContain("Bad Gateway");
  });

  test("Firecrawl success=false surfaces as structured error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 30,
        text: JSON.stringify({ success: false, error: "robots.txt blocked" }),
      }),
    });
    const r = await callTool<{ ok: boolean; error: string }>(webTools.web_fetch, {
      url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("robots.txt blocked");
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
    }>(webTools.web_fetch, { url: "https://example.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after).toBe("60");
    expect(r.error).toContain("rate limited");
  });
});

// ---------------------------------------------------------------------------
// Family export sanity
// ---------------------------------------------------------------------------

describe("webTools family export", () => {
  test("exports exactly web_search + web_fetch with the expected shape", () => {
    expect(Object.keys(webTools).sort()).toEqual(["web_fetch", "web_search"]);
    for (const [name, t] of Object.entries(webTools)) {
      expect(typeof t.description, name).toBe("string");
      expect(t.description.length, name).toBeGreaterThan(20);
      expect(typeof t.schema, name).toBe("object");
      expect(typeof t.invoke, name).toBe("function");
    }
  });
});
