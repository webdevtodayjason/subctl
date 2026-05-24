// components/evy/__tests__/mcp-tools.test.ts
//
// MCP-Expose (#25, wave 2) — tool surface tests. Pins:
//
//   1. Tool registration ships ping + state_snapshot + notify with
//      the expected schemas, after registerMcpTools runs against an
//      McpServer instance returned by startMcpServer.
//
//   2. tools/list (JSON-RPC) returns those three tool names so an
//      MCP client can discover them post-handshake.
//
//   3. tools/call ping → returns the caller_id from the request, so
//      provenance plumbing is end-to-end working.
//
//   4. tools/call state_snapshot → returns the master state shape
//      the StateSnapshot interface promises (version, uptime_s,
//      watchdogs array, etc.).
//
//   5. tools/call notify → forwards the args to the emitNotification
//      provider AND passes a provenance struct whose `by` field is
//      `mcp:<caller_id>`.
//
// Tests go through the public HTTP handle to validate the same path
// a real MCP client would hit. This catches integration mistakes the
// wave-1 mcp-handshake test alone wouldn't.

import { describe, expect, test } from "bun:test";

import { startMcpServer, HEADERS, registerMcpTools, type StateSnapshot, type ToolNotification } from "../mcp";

const TOKEN = "tools-test-bearer";
const SERVER_INFO = { name: "subctl-master", version: "9.9.9-test" };

interface CapturedNotification {
  notification: ToolNotification;
  provenance: Record<string, unknown>;
}

function makeStateSnapshot(): StateSnapshot {
  return {
    version: SERVER_INFO.version,
    uptime_s: 42,
    transcript_msgs: 7,
    teams_tracked: 2,
    active_profile: "chat",
    watchdogs: [
      {
        id: "team-staleness",
        kind: "team-staleness",
        last_tick_at: "2026-05-19T22:00:00.000Z",
        expected_interval_s: 1800,
      },
    ],
    notifications: { total: 12, unread: 3 },
  };
}

async function withToolMcp<T>(
  fn: (h: NonNullable<Awaited<ReturnType<typeof startMcpServer>>>, captured: CapturedNotification[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedNotification[] = [];
  const h = await startMcpServer({
    expectedToken: TOKEN,
    serverInfo: SERVER_INFO,
    log: () => {},
    registerCapabilities: (mcp) => {
      registerMcpTools(mcp, {
        serverVersion: SERVER_INFO.version,
        getStateSnapshot: makeStateSnapshot,
        emitNotification: (notification, provenance) => {
          captured.push({ notification, provenance });
        },
      });
    },
  });
  if (!h) throw new Error("expected handle");
  try {
    return await fn(h, captured);
  } finally {
    await h.stop();
  }
}

// In stateless mode every batched rpc() call includes its own initialize;
// keep this as a no-op so the test scripts read cleanly.
async function initialize(_h: NonNullable<Awaited<ReturnType<typeof startMcpServer>>>): Promise<void> {
  // intentionally empty
}

// Track the Mcp-Session-Id assigned to each transport after initialize.
// Session-aware mode requires every follow-up request to carry it.
const sessionIds = new WeakMap<object, string>();

async function rpcRaw(
  h: NonNullable<Awaited<ReturnType<typeof startMcpServer>>>,
  callerId: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ json: unknown; response: Response }> {
  const req = new Request("http://127.0.0.1:8788/mcp", {
    method: "POST",
    headers: {
      [HEADERS.bearer]: `Bearer ${TOKEN}`,
      [HEADERS.callerId]: callerId,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const res = await h.handle(req);
  if (res.status >= 400) {
    throw new Error(`rpc failed ${res.status}: ${await res.text()}`);
  }
  const raw = await res.text();
  const json = raw.startsWith("data:")
    ? raw.replace(/^data:\s*/, "").trim()
    : raw;
  return { json: JSON.parse(json), response: res };
}

async function rpc(
  h: NonNullable<Awaited<ReturnType<typeof startMcpServer>>>,
  callerId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let sessionId = sessionIds.get(h);
  if (!sessionId) {
    const initRes = await rpcRaw(h, callerId, {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tools-test", version: "0.0.0" },
      },
    });
    sessionId =
      initRes.response.headers.get("mcp-session-id") ??
      initRes.response.headers.get("Mcp-Session-Id") ??
      "";
    if (!sessionId) {
      throw new Error(
        "test rpc: server did not return Mcp-Session-Id header on initialize",
      );
    }
    sessionIds.set(h, sessionId);
    // Send the `initialized` notification with the session id.
    await rpcRaw(
      h,
      callerId,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-session-id": sessionId },
    ).catch(() => undefined);
  }
  const out = await rpcRaw(h, callerId, body, {
    "mcp-session-id": sessionId,
  });
  return out.json;
}

function parseToolText(rpcResult: unknown): unknown {
  const parsed = rpcResult as {
    result?: { content?: Array<{ type: string; text: string }> };
  };
  const text = parsed.result?.content?.[0]?.text;
  if (!text) throw new Error(`no text content in rpc result: ${JSON.stringify(rpcResult)}`);
  return JSON.parse(text);
}

describe("tools/list", () => {
  test("returns ping + state_snapshot + notify", async () => {
    await withToolMcp(async (h) => {
      await initialize(h);
      const out = (await rpc(h, "test-client", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as { result: { tools: Array<{ name: string }> } };
      const names = out.result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["notify", "ping", "state_snapshot"]);
    });
  });
});

describe("tools/call ping", () => {
  test("returns server version + caller_id from auth", async () => {
    await withToolMcp(async (h) => {
      await initialize(h);
      const out = await rpc(h, "argentos", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ping", arguments: {} },
      });
      const payload = parseToolText(out) as {
        ok: boolean;
        version: string;
        caller_id: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.version).toBe(SERVER_INFO.version);
      expect(payload.caller_id).toBe("argentos");
    });
  });
});

describe("tools/call state_snapshot", () => {
  test("returns the master state shape", async () => {
    await withToolMcp(async (h) => {
      await initialize(h);
      const out = await rpc(h, "claude-desktop", {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "state_snapshot", arguments: {} },
      });
      const snap = parseToolText(out) as StateSnapshot;
      expect(snap.version).toBe(SERVER_INFO.version);
      expect(snap.uptime_s).toBe(42);
      expect(snap.transcript_msgs).toBe(7);
      expect(snap.watchdogs).toHaveLength(1);
      expect(snap.watchdogs[0]?.id).toBe("team-staleness");
      expect(snap.notifications).toEqual({ total: 12, unread: 3 });
    });
  });
});

describe("tools/call notify", () => {
  test("emits notification through provider with mcp:<caller_id> provenance", async () => {
    await withToolMcp(async (h, captured) => {
      await initialize(h);
      await rpc(h, "orch-claude-code-session-42", {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "notify",
          arguments: {
            kind: "mcp-test",
            severity: "info",
            title: "hello from MCP",
            body: "this came in via tools/call",
          },
        },
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.notification).toEqual({
        kind: "mcp-test",
        severity: "info",
        title: "hello from MCP",
        body: "this came in via tools/call",
      });
      // Provenance must carry the mcp:<caller_id> attribution.
      expect(captured[0]?.provenance.by).toBe("mcp:orch-claude-code-session-42");
    });
  });

  test("rejects invalid severity (zod schema enforcement)", async () => {
    await withToolMcp(async (h, captured) => {
      await initialize(h);
      const out = (await rpc(h, "test-client", {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "notify",
          arguments: {
            kind: "mcp-test",
            severity: "critical", // not in enum [info,warn,alert]
            title: "bad severity",
            body: "should reject",
          },
        },
      })) as { result?: { isError?: boolean }; error?: unknown };
      // Either the SDK returns a JSON-RPC error or a result with isError:true.
      const rejected = Boolean(out.error) || Boolean(out.result?.isError);
      expect(rejected).toBe(true);
      expect(captured).toHaveLength(0);
    });
  });
});
