// components/evy/supervisor-usage-capture.ts
//
// v3.3.7 — Real `usage.prompt_tokens` capture for the Hermes compression
// gate. Closes the documented gap in v3.3.6 where pi-agent-core v0.74.0
// does NOT surface `usage` to userland via any event, response object, or
// hook (verified by scouting the published `@earendil-works/pi-agent-core`
// + `@earendil-works/pi-ai` packages — see CHANGELOG v3.3.7).
//
// Strategy: `globalThis.fetch` monkey-patch.
//
//   1. pi-agent-core uses `globalThis.fetch` for ALL outbound LLM traffic
//      (no injected fetch, no bundled HTTP client). We can intercept all
//      requests at the global level by replacing `globalThis.fetch` once
//      at daemon boot, before `registerBuiltInApiProviders()`.
//
//   2. On the OUTBOUND side: when the request URL matches `/v1/chat/completions`
//      and the JSON body has `stream: true`, we inject `stream_options:
//      { include_usage: true }` so OpenAI returns the usage chunk just
//      before `[DONE]`. (`/v1/responses` already includes usage by default
//      in the `response.completed` event, so no rewrite needed there.)
//
//   3. On the INBOUND side: we tee the response body so pi-agent-core gets
//      its untouched stream, and we read the OTHER branch in the
//      background looking for SSE chunks that contain a usage object.
//      The latest captured value updates the module-local
//      `lastSupervisorUsage` record.
//
//   4. server.ts trigger sites read the value via `getLastSupervisorUsage()`
//      and pass `.prompt_tokens` as the `realPromptTokensHint` to
//      `runHermesCompactCheck`.
//
// Fragility risk: pi-agent-core could switch to its own bundled HTTP
// client in a future major version, at which point this capture would
// silently stop firing. The `runHermesCompactCheck` already falls back
// to the char/4 estimator when the hint is null, so the failure mode
// is "Hermes path goes back to v3.3.6 behaviour" — degraded, not broken.
// CHANGELOG.md tracks the pinned upstream version so a future operator
// notices when an upgrade may have invalidated this assumption.

interface CapturedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  ts: number;
  /** Which detector caught this — useful in diagnostics. */
  source: "chat-completions" | "responses" | "unary";
}

let lastSupervisorUsage: CapturedUsage | null = null;
let installed = false;

export function getLastSupervisorUsage(): CapturedUsage | null {
  return lastSupervisorUsage;
}

/**
 * Pure helper for the hint-vs-estimator decision the Hermes trigger sites
 * make. Exposed so it's unit-testable in isolation from the daemon closure
 * `runHermesCompactCheck` lives in.
 *
 * Contract per goal v3.3.7 criterion #4:
 *   - When `hint` is a finite positive number, return it.
 *   - Otherwise (undefined / null / NaN / 0 / negative) run the estimator
 *     and return its value.
 *
 * 0 is treated as a missing hint deliberately: a real chat-completions
 * call with a non-empty prompt always reports `prompt_tokens >= 1`. A
 * 0 in the hint slot indicates either a misparsed SSE chunk or a
 * pathological empty turn — fall back to the estimator rather than
 * dispatching with a known-bogus number.
 */
export function resolveRealPromptTokens(
  hint: number | undefined,
  estimator: () => number,
): number {
  if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) {
    return hint;
  }
  return estimator();
}

/** Test-only: reset module state between cases. */
export function _resetForTesting(): void {
  lastSupervisorUsage = null;
}

/** Test-only: install a payload directly (covers the hint-prefers-hint test). */
export function _setForTesting(u: CapturedUsage | null): void {
  lastSupervisorUsage = u;
}

/**
 * Test-only: clear the install-once flag so `installSupervisorUsageCapture()`
 * will re-wrap whatever `globalThis.fetch` currently points at. Tests use
 * this to install the interceptor over a per-case stub fetch.
 */
export function _resetInstalledFlagForTesting(): void {
  installed = false;
}

/**
 * Install the global fetch wrapper. Safe to call multiple times — only
 * the first call patches; subsequent calls are no-ops. (The daemon's
 * boot sequence calls this exactly once but reload/HMR scenarios could
 * re-enter.)
 */
export function installSupervisorUsageCapture(): void {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
    } catch {
      // If we can't even read the URL, just pass through.
      return originalFetch(input as RequestInfo, init);
    }

    // URL matching covers the providers pi-ai v0.74.0 ships with:
    //   - openai-completions       → `${base}/v1/chat/completions`
    //   - openai-responses         → `${base}/v1/responses`
    //   - openai-codex-responses   → `https://chatgpt.com/backend-api/codex/responses`
    //                                or `${base}/codex/responses` /
    //                                `${base}/responses` when `base` ends with
    //                                `/codex` (see openai-codex-responses.js
    //                                `resolveCodexUrl` line 294-298).
    //   - azure-openai-responses   → `${base}/openai/deployments/<dep>/responses`
    //                                (matched by the `/responses` boundary)
    // Trailing boundary char is `?` (query), `/` (subpath like ?stream=), or
    // end-of-string. Liberal enough to catch all `/responses` shapes without
    // matching unrelated routes that contain the word "responses" as a
    // substring (e.g. `/api/health-responses`).
    const isChatCompletions = /\/v1\/chat\/completions(?:[?/]|$)/.test(url);
    const isResponses =
      /\/(?:v1|codex|openai\/deployments\/[^/]+)\/responses(?:[?/]|$)/.test(url) ||
      /\/v1\/responses(?:[?/]|$)/.test(url) ||
      /\/codex\/responses(?:[?/]|$)/.test(url);

    // OUTBOUND REWRITE — only for streaming Chat Completions where we
    // need to opt in to the usage tail-chunk.
    let actualInit = init;
    if (
      isChatCompletions &&
      init?.body &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      try {
        const body =
          typeof init.body === "string"
            ? JSON.parse(init.body)
            : init.body instanceof Uint8Array
              ? JSON.parse(new TextDecoder().decode(init.body))
              : null;
        if (
          body &&
          typeof body === "object" &&
          (body as Record<string, unknown>).stream === true
        ) {
          const b = body as Record<string, unknown>;
          const so = (b.stream_options as Record<string, unknown>) ?? {};
          if (so.include_usage !== true) {
            so.include_usage = true;
            b.stream_options = so;
            actualInit = { ...init, body: JSON.stringify(b) };
          }
        }
      } catch {
        // Body wasn't JSON or wasn't an object — leave the request alone.
      }
    }

    let response: Response;
    try {
      response = await originalFetch(input as RequestInfo, actualInit);
    } catch (err) {
      throw err;
    }

    if (!response.ok) return response;
    if (!isChatCompletions && !isResponses) return response;

    const contentType = response.headers.get("content-type") ?? "";

    // UNARY CASE — non-streaming JSON response. Clone, parse, extract.
    if (
      contentType.includes("application/json") &&
      !contentType.includes("event-stream")
    ) {
      const cloned = response.clone();
      void (async () => {
        try {
          const json = (await cloned.json()) as Record<string, unknown>;
          recordUnaryUsage(json, isResponses ? "responses" : "chat-completions");
        } catch {
          // best-effort
        }
      })();
      return response;
    }

    // STREAMING CASE — tee the body, hand one half back to pi-agent-core,
    // consume the other half in the background.
    if (!response.body) return response;
    try {
      const [forCaller, forCapture] = response.body.tee();
      void consumeStream(
        forCapture,
        isResponses ? "responses" : "chat-completions",
      );
      // Reconstruct the Response with the caller's branch of the tee.
      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      // tee unsupported on this stream? Return original — capture skipped.
      return response;
    }
  }) as typeof globalThis.fetch;
}

/** UNARY parser — Chat Completions returns `usage.prompt_tokens` at top level. */
function recordUnaryUsage(
  json: Record<string, unknown>,
  source: "chat-completions" | "responses",
): void {
  if (source === "chat-completions") {
    const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
      .usage;
    if (u && typeof u.prompt_tokens === "number") {
      lastSupervisorUsage = {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
        ts: Date.now(),
        source: "unary",
      };
    }
    return;
  }
  // Responses API unary shape: { response: { usage: { input_tokens, output_tokens } } }
  const r = (json as { response?: { usage?: { input_tokens?: number; output_tokens?: number } } })
    .response;
  if (r?.usage && typeof r.usage.input_tokens === "number") {
    lastSupervisorUsage = {
      prompt_tokens: r.usage.input_tokens,
      completion_tokens: typeof r.usage.output_tokens === "number" ? r.usage.output_tokens : 0,
      ts: Date.now(),
      source: "unary",
    };
  }
}

/** Consume an SSE stream, looking for usage in chunks. Fire-and-forget. */
async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  kind: "chat-completions" | "responses",
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by `\n\n`. Split greedily.
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const eventChunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        parseSseEventChunk(eventChunk, kind);
      }
    }
    // Drain trailing buffered partial event (some servers don't end with \n\n).
    if (buffer.length > 0) parseSseEventChunk(buffer, kind);
  } catch {
    // Best-effort: never propagate stream errors out of the capture layer.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse one SSE event chunk. SSE format: one chunk = multiple `field: value`
 * lines separated by `\n`. We only care about `data:` payloads. Multiple
 * `data:` lines per event get concatenated per the SSE spec, but in
 * practice OpenAI and Codex use one `data:` per event.
 */
function parseSseEventChunk(
  chunk: string,
  kind: "chat-completions" | "responses",
): void {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (kind === "chat-completions") {
      // The tail-chunk that carries usage has shape:
      //   { choices: [], usage: { prompt_tokens, completion_tokens, total_tokens } }
      const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
        .usage;
      if (u && typeof u.prompt_tokens === "number") {
        lastSupervisorUsage = {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
          ts: Date.now(),
          source: "chat-completions",
        };
      }
      continue;
    }
    // Responses API streaming format. Usage lands in `response.completed`:
    //   { type: "response.completed", response: { usage: { input_tokens, output_tokens } } }
    if (
      (json as { type?: string }).type === "response.completed" &&
      typeof (json as { response?: { usage?: unknown } }).response === "object"
    ) {
      const r = (json as { response: { usage?: { input_tokens?: number; output_tokens?: number } } })
        .response;
      if (r.usage && typeof r.usage.input_tokens === "number") {
        lastSupervisorUsage = {
          prompt_tokens: r.usage.input_tokens,
          completion_tokens: typeof r.usage.output_tokens === "number" ? r.usage.output_tokens : 0,
          ts: Date.now(),
          source: "responses",
        };
      }
    }
  }
}
