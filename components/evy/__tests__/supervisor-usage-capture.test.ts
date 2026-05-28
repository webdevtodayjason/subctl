// components/evy/__tests__/supervisor-usage-capture.test.ts
//
// v3.3.7 — tests for the `globalThis.fetch` interceptor that captures
// `usage.prompt_tokens` from supervisor API responses, and for the
// pure helper that picks between the real-token hint and the char/4
// estimator fallback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetForTesting,
  _resetInstalledFlagForTesting,
  _setForTesting,
  getLastSupervisorUsage,
  installSupervisorUsageCapture,
  resolveRealPromptTokens,
} from "../supervisor-usage-capture";

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// resolveRealPromptTokens — criterion #5 sub-tests #1 + #2
// ---------------------------------------------------------------------------

describe("resolveRealPromptTokens — hint vs estimator", () => {
  test("(criterion #5.a) prefers the hint over the estimator when both differ", () => {
    // Goal text: "hint=50_000, estimator=200_000 → decision uses 50_000"
    const out = resolveRealPromptTokens(50_000, () => 200_000);
    expect(out).toBe(50_000);
  });

  test("(criterion #5.b) falls back to the estimator when hint is undefined", () => {
    const out = resolveRealPromptTokens(undefined, () => 42_000);
    expect(out).toBe(42_000);
  });

  test("treats hint=null like undefined → estimator", () => {
    const out = resolveRealPromptTokens(null as unknown as undefined, () => 42_000);
    expect(out).toBe(42_000);
  });

  test("treats hint=0 as missing (would indicate parser bug) → estimator", () => {
    const out = resolveRealPromptTokens(0, () => 42_000);
    expect(out).toBe(42_000);
  });

  test("treats hint=NaN as missing → estimator", () => {
    const out = resolveRealPromptTokens(Number.NaN, () => 42_000);
    expect(out).toBe(42_000);
  });

  test("treats negative hint as missing → estimator", () => {
    const out = resolveRealPromptTokens(-100, () => 42_000);
    expect(out).toBe(42_000);
  });

  test("estimator is NOT called when hint is valid (avoids unnecessary work)", () => {
    let calls = 0;
    const out = resolveRealPromptTokens(123, () => {
      calls++;
      return 0;
    });
    expect(out).toBe(123);
    expect(calls).toBe(0);
  });

  test("estimator IS called when hint is missing", () => {
    let calls = 0;
    const out = resolveRealPromptTokens(undefined, () => {
      calls++;
      return 7;
    });
    expect(out).toBe(7);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// _setForTesting + getLastSupervisorUsage — round-trip
// ---------------------------------------------------------------------------

describe("getLastSupervisorUsage round-trip", () => {
  test("returns null before any capture", () => {
    expect(getLastSupervisorUsage()).toBeNull();
  });

  test("returns the value set via _setForTesting", () => {
    _setForTesting({
      prompt_tokens: 12_345,
      completion_tokens: 678,
      ts: 1_700_000_000_000,
      source: "chat-completions",
    });
    const u = getLastSupervisorUsage();
    expect(u?.prompt_tokens).toBe(12_345);
    expect(u?.completion_tokens).toBe(678);
    expect(u?.source).toBe("chat-completions");
  });

  test("_resetForTesting clears the value", () => {
    _setForTesting({
      prompt_tokens: 1,
      completion_tokens: 1,
      ts: 1,
      source: "unary",
    });
    _resetForTesting();
    expect(getLastSupervisorUsage()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (criterion #5.c) Integration test — recorded SSE response → capture
// extracts the right number
// ---------------------------------------------------------------------------
//
// These tests exercise the full request → response cycle via the patched
// `globalThis.fetch`. We stub the underlying transport by replacing
// `globalThis.fetch` ourselves to return a synthetic streaming Response,
// then call our interceptor's published surface (we re-install the
// interceptor in beforeEach so it wraps OUR stub).

// Helper: build a ReadableStream that emits the given SSE chunks.
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i] + "\n\n"));
      i++;
    },
  });
}

describe("(criterion #5.c) integration — SSE response → captured usage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetForTesting();
    _resetInstalledFlagForTesting();
    // Reset global fetch to the unwrapped original so each test starts
    // from a clean slate. Tests then stub fetch with a synthetic and
    // call installSupervisorUsageCapture() to wrap that stub.
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetInstalledFlagForTesting();
  });

  test("Chat Completions: usage chunk just before [DONE] is captured", async () => {
    // Stub fetch to return a streaming chat completions response.
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const stream = sseStream([
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}',
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        // The tail-chunk OpenAI emits when stream_options.include_usage=true.
        // choices is empty; usage carries the numbers.
        'data: {"choices":[],"usage":{"prompt_tokens":54321,"completion_tokens":2,"total_tokens":54323}}',
        "data: [DONE]",
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown) as typeof globalThis.fetch;

    // Install interceptor over our stub.
    installSupervisorUsageCapture();
    // Mark installed-flag's effect: re-install is idempotent, but we
    // bypass that by manually stubbing AGAIN after install — since
    // install() captured a reference to the stub we just set, future
    // calls go through the interceptor → our stub.

    const resp = await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      },
    );
    expect(resp.ok).toBe(true);

    // Drain the caller-facing half of the tee so the interceptor's
    // background reader can finish.
    const reader = resp.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Allow the background reader microtask to settle.
    await new Promise((r) => setTimeout(r, 50));

    const u = getLastSupervisorUsage();
    expect(u).not.toBeNull();
    expect(u?.prompt_tokens).toBe(54321);
    expect(u?.completion_tokens).toBe(2);
    expect(u?.source).toBe("chat-completions");
  });

  test("Responses API: response.completed event usage is captured", async () => {
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const stream = sseStream([
        'data: {"type":"response.created","response":{"id":"resp_1"}}',
        'data: {"type":"response.output_item.added","item":{"type":"message"}}',
        // The terminal event carrying usage.
        'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":98765,"output_tokens":42,"total_tokens":98807}}}',
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();

    const resp = await globalThis.fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      },
    );
    expect(resp.ok).toBe(true);

    const reader = resp.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 50));

    const u = getLastSupervisorUsage();
    expect(u).not.toBeNull();
    expect(u?.prompt_tokens).toBe(98765);
    expect(u?.completion_tokens).toBe(42);
    expect(u?.source).toBe("responses");
  });

  // v3.3.9 — URL coverage test pinned to the providers pi-ai v0.74.0 ships.
  // Each case stubs fetch to return a synthetic Responses-API SSE that
  // carries `usage.input_tokens`, then asserts the interceptor caught it.
  test("Codex base URL (chatgpt.com/backend-api/codex/responses) is captured", async () => {
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const stream = sseStream([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":11111,"output_tokens":22}}}',
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();
    const resp = await globalThis.fetch(
      "https://chatgpt.com/backend-api/codex/responses",
      { method: "POST", body: JSON.stringify({ input: "hi" }) },
    );
    const reader = resp.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(getLastSupervisorUsage()?.prompt_tokens).toBe(11111);
  });

  test("Azure-OpenAI Responses (openai/deployments/<dep>/responses) is captured", async () => {
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const stream = sseStream([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":33333,"output_tokens":44}}}',
      ]);
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();
    const resp = await globalThis.fetch(
      "https://contoso.openai.azure.com/openai/deployments/gpt-5/responses?api-version=2024",
      { method: "POST", body: JSON.stringify({ input: "hi" }) },
    );
    const reader = resp.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(getLastSupervisorUsage()?.prompt_tokens).toBe(33333);
  });

  test("non-LLM URL (e.g. /api/health) is NOT intercepted, no usage captured", async () => {
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();

    const resp = await globalThis.fetch(
      "https://example.com/api/health",
      { method: "GET" },
    );
    expect(resp.ok).toBe(true);
    await resp.json();
    await new Promise((r) => setTimeout(r, 20));

    expect(getLastSupervisorUsage()).toBeNull();
  });

  test("unary JSON Chat Completions response (stream:false) captures usage from top-level body", async () => {
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1234, completion_tokens: 5, total_tokens: 1239 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();

    const resp = await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      },
    );
    expect(resp.ok).toBe(true);
    // Consume the caller's body just like pi-agent-core would.
    await resp.json();
    await new Promise((r) => setTimeout(r, 30));

    const u = getLastSupervisorUsage();
    expect(u).not.toBeNull();
    expect(u?.prompt_tokens).toBe(1234);
    expect(u?.source).toBe("unary");
  });

  test("outbound rewrite: streaming Chat Completions request gains stream_options.include_usage", async () => {
    let capturedRequestBody: string | undefined;
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedRequestBody = init?.body as string | undefined;
      // Return an empty stream — we don't care about the response side here.
      return new Response(sseStream(["data: [DONE]"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();

    await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      },
    );

    expect(capturedRequestBody).toBeDefined();
    const sentBody = JSON.parse(capturedRequestBody!) as Record<string, unknown>;
    expect(
      (sentBody.stream_options as Record<string, unknown>)?.include_usage,
    ).toBe(true);
  });

  test("non-streaming Chat Completions request is NOT rewritten (no stream_options injection)", async () => {
    let capturedRequestBody: string | undefined;
    globalThis.fetch = ((async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedRequestBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown) as typeof globalThis.fetch;

    installSupervisorUsageCapture();

    await globalThis.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      },
    );

    const sentBody = JSON.parse(capturedRequestBody!) as Record<string, unknown>;
    expect(sentBody.stream_options).toBeUndefined();
  });
});
