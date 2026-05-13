// components/master/tools/__tests__/tinyfish-agent.test.ts
//
// Tests for v2.7.27 `tinyfish_agent` — the third TinyFish surface
// (POST https://agent.tinyfish.ai/v1/automation/run). Every path is
// hermetic: the injectable `fetchHttp` + `sleep` deps replace
// globalThis.fetch and the real exponential-backoff timer so the suite
// never hits the network and never burns wall time. Covers happy path,
// validation, missing API key, 4xx (401, 402, 429), 5xx retry +
// backoff, network-error retry, agent-side FAILED status, malformed
// body, timeout headroom, family-export wiring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDepsForTesting,
  _setDepsForTesting,
  callTinyfishAgent,
  tinyfishTools,
  type TinyfishAgentResult,
} from "../tinyfish";

afterEach(() => {
  _resetDepsForTesting();
  delete process.env.TINYFISH_API_KEY;
});

beforeEach(() => {
  process.env.TINYFISH_API_KEY = "test-tinyfish-key";
});

// Capture both the request shape AND the slept backoff intervals.
interface Captured {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

function makeCapture(): { calls: Captured[]; sleeps: number[] } {
  return { calls: [], sleeps: [] };
}

describe("tinyfish_agent — happy path", () => {
  test("returns COMPLETED with result + run_id + metadata; wire shape correct", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: true,
          status: 200,
          latencyMs: 12_400,
          text: JSON.stringify({
            run_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            status: "COMPLETED",
            started_at: "2026-05-13T10:00:00Z",
            finished_at: "2026-05-13T10:00:12Z",
            num_of_steps: 5,
            result: { product: "iPhone 15", price: "$799" },
            error: null,
          }),
        };
      },
      sleep: async (ms) => {
        cap.sleeps.push(ms);
      },
    });
    const r = (await callTinyfishAgent({
      task: "Find pricing page and extract plan details",
      starting_url: "https://example.com",
    })) as Extract<TinyfishAgentResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.status).toBe("COMPLETED");
    expect(r.run_id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(r.num_of_steps).toBe(5);
    expect(r.result).toEqual({ product: "iPhone 15", price: "$799" });
    expect(r.started_at).toBe("2026-05-13T10:00:00Z");
    expect(r.finished_at).toBe("2026-05-13T10:00:12Z");
    expect(r.latency_ms).toBe(12_400);
    expect(r.attempts).toBe(1);
    // Wire-shape: POST agent.tinyfish.ai with X-API-Key header.
    expect(cap.calls.length).toBe(1);
    expect(cap.calls[0]!.method).toBe("POST");
    expect(cap.calls[0]!.url).toBe(
      "https://agent.tinyfish.ai/v1/automation/run",
    );
    expect(cap.calls[0]!.headers?.["X-API-Key"]).toBe("test-tinyfish-key");
    expect(cap.calls[0]!.headers?.["Content-Type"]).toBe("application/json");
    const sentBody = JSON.parse(cap.calls[0]!.body ?? "{}");
    expect(sentBody.url).toBe("https://example.com");
    expect(sentBody.goal).toBe("Find pricing page and extract plan details");
    expect(sentBody.agent_config.max_duration_seconds).toBe(120);
    // No sleeps on happy path.
    expect(cap.sleeps).toEqual([]);
  });

  test("forwards optional max_steps + browser_profile + custom timeout to the wire", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({
            run_id: "r1",
            status: "COMPLETED",
            started_at: null,
            finished_at: null,
            num_of_steps: 0,
            result: {},
            error: null,
          }),
        };
      },
      sleep: async () => {},
    });
    await callTinyfishAgent({
      task: "click signup",
      starting_url: "https://example.com",
      max_steps: 25,
      browser_profile: "stealth",
      timeout_seconds: 30,
    });
    const sent = JSON.parse(cap.calls[0]!.body ?? "{}");
    expect(sent.agent_config.max_steps).toBe(25);
    expect(sent.agent_config.max_duration_seconds).toBe(30);
    expect(sent.browser_profile).toBe("stealth");
    // HTTP timeout headroom: 30s + 30s buffer = 60_000ms.
    expect(cap.calls[0]!.timeoutMs).toBe(60_000);
  });

  test("clamps timeout_seconds to [1, 600]", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (_url, opts) => {
        cap.calls.push({
          url: _url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: true,
          status: 200,
          latencyMs: 1,
          text: JSON.stringify({
            run_id: "r",
            status: "COMPLETED",
            started_at: null,
            finished_at: null,
            num_of_steps: 0,
            result: {},
            error: null,
          }),
        };
      },
      sleep: async () => {},
    });
    await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
      timeout_seconds: 99_999,
    });
    let sent = JSON.parse(cap.calls[0]!.body ?? "{}");
    expect(sent.agent_config.max_duration_seconds).toBe(600);
    await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
      timeout_seconds: 0,
    });
    sent = JSON.parse(cap.calls[1]!.body ?? "{}");
    // 0 falls through to default 120.
    expect(sent.agent_config.max_duration_seconds).toBe(120);
    await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
      timeout_seconds: -10,
    });
    sent = JSON.parse(cap.calls[2]!.body ?? "{}");
    expect(sent.agent_config.max_duration_seconds).toBe(120);
  });
});

describe("tinyfish_agent — validation + missing config", () => {
  test("missing task returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      starting_url: "https://example.com",
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("task is required");
  });

  test("missing starting_url returns ok=false with explicit reason (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({ task: "do thing" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("starting_url is required");
      expect(r.error).toContain("Agent API");
    }
  });

  test("non-http(s) starting_url rejected pre-flight", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "ftp://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid starting_url");
  });

  test("missing TINYFISH_API_KEY returns ok=false with setup hint (no HTTP call)", async () => {
    delete process.env.TINYFISH_API_KEY;
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("TINYFISH_API_KEY");
      expect(r.error).toContain("agent.tinyfish.ai");
      expect(r.error).toContain("secrets.json");
    }
  });
});

describe("tinyfish_agent — 4xx surfaces without retry", () => {
  test("HTTP 401 returns error + re-mint hint, no retry, no sleep", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 401,
          latencyMs: 18,
          text: '{"error":"invalid api key"}',
        };
      },
      sleep: async (ms) => {
        cap.sleeps.push(ms);
      },
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain("HTTP 401");
      expect(r.error).toContain("invalid api key");
      expect(r.hint).toContain("agent.tinyfish.ai");
    }
    expect(cap.calls.length).toBe(1);
    expect(cap.sleeps).toEqual([]);
  });

  test("HTTP 402 (billing) returns error + top-up hint, no retry", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 402,
          latencyMs: 12,
          text: '{"error":"credit balance exhausted"}',
        };
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(402);
      expect(r.error).toContain("HTTP 402");
      expect(r.hint).toContain("billing");
    }
    expect(cap.calls.length).toBe(1);
  });

  test("HTTP 429 returns retry_after when header present, no retry", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 429,
          latencyMs: 22,
          text: '{"error":"too many runs"}',
          headers: { "retry-after": "60" },
        };
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.retry_after).toBe("60");
      expect(r.error).toContain("rate limited");
    }
    expect(cap.calls.length).toBe(1);
  });

  test("HTTP 400 (other 4xx) includes status + body excerpt, no retry", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 400,
          latencyMs: 8,
          text: "Bad Request: starting_url malformed",
        };
      },
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("HTTP 400");
      expect(r.error).toContain("Bad Request");
    }
    expect(cap.calls.length).toBe(1);
  });
});

describe("tinyfish_agent — 5xx retries with exponential backoff", () => {
  test("503 503 200 → succeeds on third attempt; backoff intervals [500, 1500]", async () => {
    const cap = makeCapture();
    let n = 0;
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        n++;
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        if (n < 3) {
          return {
            ok: false,
            status: 503,
            latencyMs: 14,
            text: "Service Unavailable",
          };
        }
        return {
          ok: true,
          status: 200,
          latencyMs: 9_000,
          text: JSON.stringify({
            run_id: "r-final",
            status: "COMPLETED",
            started_at: null,
            finished_at: null,
            num_of_steps: 3,
            result: { x: 1 },
            error: null,
          }),
        };
      },
      sleep: async (ms) => {
        cap.sleeps.push(ms);
      },
    });
    const r = (await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    })) as Extract<TinyfishAgentResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.run_id).toBe("r-final");
    expect(r.attempts).toBe(3);
    expect(cap.calls.length).toBe(3);
    // Backoff between attempts: 500ms then 1500ms (the third attempt is
    // a success so no trailing sleep).
    expect(cap.sleeps).toEqual([500, 1500]);
  });

  test("503 503 503 → ok=false after 3 attempts with retries[] log", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 503,
          latencyMs: 14,
          text: "Service Unavailable",
        };
      },
      sleep: async (ms) => {
        cap.sleeps.push(ms);
      },
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toContain("HTTP 503");
      expect(r.error).toContain("3 attempt");
      expect(r.retries?.length).toBe(2);
    }
    expect(cap.calls.length).toBe(3);
    // Only sleeps BETWEEN attempts (2 of them).
    expect(cap.sleeps).toEqual([500, 1500]);
  });

  test("network error (status 0) retries 3 times then surfaces", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 0,
          latencyMs: 30_000,
          text: "",
          error: "timeout after 30000ms",
        };
      },
      sleep: async (ms) => {
        cap.sleeps.push(ms);
      },
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
      timeout_seconds: 30,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("network error");
      expect(r.error).toContain("3 attempt");
      expect(r.error).toContain("timeout");
    }
    expect(cap.calls.length).toBe(3);
    expect(cap.sleeps).toEqual([500, 1500]);
  });

  test("HTTP timeoutMs honors timeout_seconds + 30s headroom on every retry", async () => {
    const cap = makeCapture();
    _setDepsForTesting({
      fetchHttp: async (url, opts) => {
        cap.calls.push({
          url,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        });
        return {
          ok: false,
          status: 502,
          latencyMs: 1,
          text: "bad gateway",
        };
      },
      sleep: async () => {},
    });
    await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
      timeout_seconds: 45,
    });
    // Every attempt uses the same HTTP timeout = 45s + 30s headroom.
    expect(cap.calls.map((c) => c.timeoutMs)).toEqual([
      75_000, 75_000, 75_000,
    ]);
  });
});

describe("tinyfish_agent — agent-side FAILED + malformed body", () => {
  test("200 + status:FAILED surfaces as ok=false with category + message", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 15_000,
        text: JSON.stringify({
          run_id: "r-fail",
          status: "FAILED",
          started_at: "2026-05-13T10:00:00Z",
          finished_at: "2026-05-13T10:00:15Z",
          num_of_steps: 3,
          result: null,
          error: {
            code: "service_busy",
            message: "Browser crashed during execution",
            category: "SYSTEM_FAILURE",
            retry_after: 60,
            help_url: "https://docs.tinyfish.ai/prompting-guide",
            help_message: "Check our prompting guide.",
          },
        }),
      }),
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("FAILED");
      expect(r.error).toContain("SYSTEM_FAILURE");
      expect(r.error).toContain("Browser crashed");
      expect(r.run_id).toBe("r-fail");
      expect(r.retry_after).toBe("60");
      expect(r.hint).toContain("prompting guide");
    }
  });

  test("200 + unexpected status string surfaces as ok=false", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 1,
        text: JSON.stringify({
          run_id: "r",
          status: "PENDING",
          started_at: null,
          finished_at: null,
          num_of_steps: 0,
          result: null,
          error: null,
        }),
      }),
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unexpected status");
  });

  test("malformed JSON body surfaces a parse error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: true,
        status: 200,
        latencyMs: 1,
        text: "<html>not json</html>",
      }),
      sleep: async () => {},
    });
    const r = await callTinyfishAgent({
      task: "x",
      starting_url: "https://example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not valid JSON");
  });
});

describe("tinyfish_agent — registry wiring", () => {
  test("tinyfishTools.tinyfish_agent exists with schema + invoke + Evy description", () => {
    expect(tinyfishTools.tinyfish_agent).toBeDefined();
    expect(typeof tinyfishTools.tinyfish_agent.description).toBe("string");
    expect(tinyfishTools.tinyfish_agent.description).toContain("Use this when");
    expect(typeof tinyfishTools.tinyfish_agent.schema).toBe("object");
    expect(typeof tinyfishTools.tinyfish_agent.invoke).toBe("function");
    // Schema requires both task and starting_url.
    expect(
      (
        tinyfishTools.tinyfish_agent.schema as {
          required: string[];
        }
      ).required.sort(),
    ).toEqual(["starting_url", "task"]);
  });

  test("invoke() delegates to callTinyfishAgent (validation flows through)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => {},
    });
    const r = await tinyfishTools.tinyfish_agent.invoke({});
    expect((r as { ok: boolean }).ok).toBe(false);
  });
});
