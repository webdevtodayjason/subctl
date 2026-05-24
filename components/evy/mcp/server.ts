// components/evy/mcp/server.ts
//
// MCP-Expose (#24, wave 1) — server skeleton. Builds an `McpServer`
// from the official @modelcontextprotocol/sdk and bridges it to a Bun
// `Request → Promise<Response>` handler via the SDK's web-standard
// streamable-HTTP transport.
//
// This module owns the runtime wiring:
//
//   • Construct McpServer with no tools / resources (those land in #25).
//   • Wrap the SDK transport in a thin handler that enforces
//     bearer-token + caller_id auth BEFORE forwarding to the SDK.
//   • Serve an unauthenticated GET `/.well-known/mcp` discovery doc
//     announcing the bearer scheme + caller_id header requirement.
//   • Return `null` from `startMcpServer` when no token is configured —
//     the daemon then never mounts the routes. Auto-generation is a
//     deliberate non-feature: secrets are operator-owned.
//
// NOT wired here: any actual mount onto components/evy/server.ts.
// The integration commit follows in a separate wave-1 PR after this
// skeleton lands. See README.md alongside this file.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  authenticateRequest,
  authErrorResponseBody,
  HEADERS,
} from "./auth.js";

/** Daemon-visible identity advertised to MCP clients on initialize. */
export interface McpServerInfo {
  name: string;
  version: string;
}

export interface StartMcpServerOptions {
  /**
   * Bearer token from secrets.json#subctl_mcp_token. When undefined or
   * empty, the function returns null (boot-disabled) and a log line.
   */
  expectedToken: string | null | undefined;
  /** Identity returned by the MCP `initialize` response. */
  serverInfo: McpServerInfo;
  /**
   * Optional structured logger. Defaults to `console.log` with a `[mcp]`
   * prefix so logs interleave cleanly with the master daemon's output.
   */
  log?: (line: string) => void;
  /**
   * Optional pre-connect hook. The SDK rejects capability changes
   * (which include tool registrations) after `mcp.connect(transport)`.
   * If provided, this callback runs synchronously between McpServer
   * construction and the transport connect, so wave-2 callers can
   * registerMcpTools(mcp, ...) without hitting the registerCapabilities
   * runtime error.
   */
  registerCapabilities?: (mcp: McpServer) => void;
}

export interface McpServerHandle {
  /**
   * Bun-style request handler. Mount with
   * `if (url.pathname.startsWith("/mcp"))` from the daemon's Bun.serve
   * fetch handler. Unauthenticated discovery is served at the exact
   * path `/.well-known/mcp`.
   */
  handle: (req: Request) => Promise<Response>;
  /**
   * Tear down all live sessions (each session has its own McpServer +
   * transport pair). Idempotent.
   */
  stop: () => Promise<void>;
}

const DISCOVERY_PATH = "/.well-known/mcp";

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function discoveryDocument(info: McpServerInfo): Record<string, unknown> {
  return {
    name: info.name,
    version: info.version,
    /**
     * Capability shape the MCP `initialize` response will mirror. Kept
     * intentionally empty here — tools/resources arrive in wave 2.
     */
    capabilities: {},
    /**
     * How a client should authenticate. The header names are stable
     * contract; do not change without bumping the discovery version.
     */
    auth: {
      type: "bearer",
      header: HEADERS.bearer,
      scheme: "Bearer",
    },
    /** Header the client must send on every authenticated request. */
    caller_id_header: HEADERS.callerId,
    /** Transport binding the server speaks. */
    transport: "streamable-http",
    /** The base path the daemon mounts this server under. */
    base_path: "/mcp",
  };
}

/**
 * Boot an MCP server with auth + identity wiring. Returns null when no
 * token is configured (the master should treat MCP as disabled). Throws
 * only on programmer errors (invalid serverInfo) — never on missing
 * config.
 */
export async function startMcpServer(
  opts: StartMcpServerOptions,
): Promise<McpServerHandle | null> {
  const log = opts.log ?? ((line: string) => console.log(`[mcp] ${line}`));

  const token = opts.expectedToken?.trim() ?? "";
  if (!token) {
    log("disabled — no subctl_mcp_token secret");
    return null;
  }
  if (!opts.serverInfo.name || !opts.serverInfo.version) {
    throw new Error("startMcpServer: serverInfo.name/version required");
  }

  // v2.8.10 — per-session McpServer + transport routing.
  //
  // BUG that v2.8.9 had: one global McpServer + one transport. The SDK
  // protocol layer's `_initialized` guard fires on the SECOND initialize
  // request and returns `Invalid Request: Server already initialized`
  // (webStandardStreamableHttp.js line 425). Two MCP clients (e.g. our
  // smoke-test curl AND Claude Desktop's mcp-remote) cannot coexist —
  // whichever connected first owns the session forever; the second
  // client's initialize is refused.
  //
  // FIX: a session map keyed by mcp-session-id. Each new session spawns
  // its OWN transport + McpServer pair. The SDK's `onsessioninitialized`
  // callback registers the pair as soon as the session-id is minted;
  // `onsessionclosed` reaps it. Subsequent requests carrying
  // mcp-session-id route to the existing session; first requests
  // (no header) get a fresh pair.
  //
  // This matches the SDK's documented multi-session pattern (the
  // single-server example in the transport's JSDoc is for
  // single-client scenarios like Cloudflare Workers / Hono).
  interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    mcp: McpServer;
  }
  const sessions = new Map<string, Session>();

  /** Build a fresh per-session pair with tools registered. */
  const newSession = async (): Promise<Session> => {
    const sessionMcp = new McpServer(
      { name: opts.serverInfo.name, version: opts.serverInfo.version },
      { capabilities: {} },
    );
    // Tool registration MUST happen before connect — SDK rejects
    // capability mutation post-connect.
    if (opts.registerCapabilities) {
      opts.registerCapabilities(sessionMcp);
    }
    let sessionTransport!: WebStandardStreamableHTTPServerTransport;
    sessionTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport: sessionTransport, mcp: sessionMcp });
        log(`session opened — id=${sid}, active=${sessions.size}`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        log(`session closed — id=${sid}, active=${sessions.size}`);
      },
    });
    await sessionMcp.connect(sessionTransport);
    return { transport: sessionTransport, mcp: sessionMcp };
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // ── Unauthenticated discovery ────────────────────────────────────
    if (url.pathname === DISCOVERY_PATH) {
      if (req.method !== "GET") {
        return jsonResponse(
          { ok: false, error: "method_not_allowed" },
          { status: 405, headers: { allow: "GET" } },
        );
      }
      return jsonResponse(discoveryDocument(opts.serverInfo));
    }

    // Everything else lives under /mcp and requires auth.
    if (!url.pathname.startsWith("/mcp")) {
      return jsonResponse(
        { ok: false, error: "not_found" },
        { status: 404 },
      );
    }

    const auth = authenticateRequest(req, { expectedToken: token });
    if (!auth.ok) {
      return jsonResponse(authErrorResponseBody(auth), { status: auth.status });
    }

    // v2.8.10 — session routing. Look up existing session by
    // mcp-session-id header (set by SDK on initialize response); fall
    // back to spawning a fresh session for first-time requests.
    // Header lookup must be case-insensitive — fetch's Headers does
    // that automatically.
    const sessionHeader = req.headers.get("mcp-session-id");
    let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (!session) {
      session = await newSession();
    }

    try {
      return await session.transport.handleRequest(req, {
        authInfo: {
          token,
          clientId: auth.caller_id,
          scopes: [],
          extra: { caller_id: auth.caller_id },
        },
      });
    } catch (err) {
      log(`transport.handleRequest threw: ${(err as Error).message}`);
      return jsonResponse(
        { ok: false, error: "internal_error" },
        { status: 500 },
      );
    }
  };

  const stop = async () => {
    // Iterate a snapshot — close() mutates the map via onsessionclosed.
    for (const [, sess] of [...sessions]) {
      try {
        await sess.mcp.close();
      } catch {
        /* idempotent */
      }
      try {
        await sess.transport.close();
      } catch {
        /* idempotent */
      }
    }
    sessions.clear();
  };

  log(`enabled — server="${opts.serverInfo.name}@${opts.serverInfo.version}"`);

  return { handle, stop };
}
