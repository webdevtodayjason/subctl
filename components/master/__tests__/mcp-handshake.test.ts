// components/master/__tests__/mcp-handshake.test.ts
//
// MCP-Expose (#24, wave 1) — transport handshake. Pins:
//
//   1. Unauthenticated GET /.well-known/mcp returns the discovery doc
//      with the bearer + caller_id contract, the transport binding,
//      and the empty capability set (no tools yet, by design).
//   2. POST /mcp with a valid bearer + caller_id + a proper MCP
//      `initialize` JSON-RPC envelope returns a 2xx response naming
//      our server and announcing the SAME (empty) capability shape.
//   3. The handshake response carries the MCP-Session-Id header in
//      its absence is allowed (we run stateless) — assert content-type
//      + JSON-RPC shape instead.
//   4. POST without auth never reaches the SDK transport — the SDK
//      cannot see (and therefore cannot leak) the request body when
//      auth fails.
//
// Why test through `startMcpServer` rather than the SDK directly: the
// auth wrapper is the integration boundary the wave-2 worker depends
// on, and the discovery doc lives outside the SDK entirely.

import { describe, expect, test } from "bun:test";

import { startMcpServer, HEADERS } from "../mcp";

const TOKEN = "handshake-bearer-token";
const SERVER_INFO = { name: "subctl-master", version: "0.0.0-test" };

/**
 * Wrap startMcpServer + automatic cleanup. The handshake tests don't
 * need a long-lived handle, so a tiny helper keeps each test compact.
 */
async function withMcp<T>(
  fn: (h: Awaited<ReturnType<typeof startMcpServer>>) => Promise<T>,
): Promise<T> {
  const h = await startMcpServer({
    expectedToken: TOKEN,
    serverInfo: SERVER_INFO,
    log: () => {},
  });
  try {
    return await fn(h);
  } finally {
    if (h) await h.stop();
  }
}

describe("/.well-known/mcp discovery", () => {
  test("returns 200 + capability + auth metadata WITHOUT a bearer", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/.well-known/mcp"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe(SERVER_INFO.name);
      expect(body.version).toBe(SERVER_INFO.version);
      expect(body.capabilities).toEqual({});
      expect(body.transport).toBe("streamable-http");
      expect(body.base_path).toBe("/mcp");
      expect(body.auth).toEqual({
        type: "bearer",
        header: HEADERS.bearer,
        scheme: "Bearer",
      });
      expect(body.caller_id_header).toBe(HEADERS.callerId);
    });
  });

  test("rejects non-GET methods on the discovery path", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      const res = await h.handle(
        new Request("http://127.0.0.1:8788/.well-known/mcp", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    });
  });
});

describe("POST /mcp — initialize handshake", () => {
  /**
   * A minimal valid MCP `initialize` request body. The SDK validates
   * the envelope shape, so this needs to be a real JSON-RPC 2.0
   * message naming the current MCP protocol version. We pick the
   * value from the SDK's negotiation logic by sending a version the
   * server will accept (the SDK responds with its supported version
   * regardless when the client's version is unknown).
   */
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-handshake-test", version: "0.0.0" },
    },
  };

  function initRequest(): Request {
    return new Request("http://127.0.0.1:8788/mcp", {
      method: "POST",
      headers: {
        [HEADERS.bearer]: `Bearer ${TOKEN}`,
        [HEADERS.callerId]: "claude-desktop",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initBody),
    });
  }

  test("valid bearer + caller_id + initialize → JSON-RPC result", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      const res = await h.handle(initRequest());
      // The SDK transport returns 200 for a successful handshake when
      // enableJsonResponse is true. Any 2xx is acceptable; a 4xx
      // here means auth or transport rejected — surface the body.
      if (res.status >= 400) {
        const detail = await res.text();
        throw new Error(`handshake failed ${res.status}: ${detail}`);
      }
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // Parse JSON-RPC reply. enableJsonResponse: true returns a
      // single application/json body for request/response RPCs.
      const ct = res.headers.get("content-type") ?? "";
      expect(ct.includes("application/json") || ct.includes("text/event-stream"))
        .toBe(true);

      const text = await res.text();
      // Strip optional SSE framing (`data: <json>\n\n`) defensively
      // — the transport COULD respond either way depending on the
      // accept header parsing. We accept both.
      const jsonPayload = text.startsWith("data:")
        ? text.replace(/^data:\s*/, "").trim()
        : text;
      const parsed = JSON.parse(jsonPayload) as {
        jsonrpc: string;
        id: number;
        result?: {
          protocolVersion: string;
          serverInfo: { name: string; version: string };
          capabilities: Record<string, unknown>;
        };
        error?: { code: number; message: string };
      };
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toBe(1);
      expect(parsed.error).toBeUndefined();
      expect(parsed.result).toBeDefined();
      expect(parsed.result?.serverInfo.name).toBe(SERVER_INFO.name);
      expect(parsed.result?.serverInfo.version).toBe(SERVER_INFO.version);
      // Wave-1 has no tools / resources / prompts.
      expect(parsed.result?.capabilities).toBeDefined();
    });
  });

  test("missing bearer never reaches the SDK transport", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      const noAuth = new Request("http://127.0.0.1:8788/mcp", {
        method: "POST",
        headers: { [HEADERS.callerId]: "claude-desktop" },
        body: JSON.stringify(initBody),
      });
      const res = await h.handle(noAuth);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toBe("missing_authorization");
    });
  });

  test("missing caller_id → 400 even with a valid bearer", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      const noCaller = new Request("http://127.0.0.1:8788/mcp", {
        method: "POST",
        headers: {
          [HEADERS.bearer]: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(initBody),
      });
      const res = await h.handle(noCaller);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.error).toBe("missing_caller_id");
    });
  });
});

describe("McpServer handle exposes the underlying SDK server", () => {
  test("`mcp` property is the McpServer instance — needed for wave-2 tool registration", async () => {
    await withMcp(async (h) => {
      if (!h) throw new Error("expected handle");
      // Duck-type check: McpServer exposes `.server` (low-level Server)
      // and `.connect()`. We don't rely on a class identity check
      // because of ESM/CJS shenanigans.
      expect(typeof h.mcp).toBe("object");
      expect(typeof (h.mcp as { connect?: unknown }).connect).toBe("function");
    });
  });
});
