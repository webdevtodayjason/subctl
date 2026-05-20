// components/master/mcp/server.ts
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
// NOT wired here: any actual mount onto components/master/server.ts.
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
}

export interface McpServerHandle {
  /**
   * Bun-style request handler. Mount with
   * `if (url.pathname.startsWith("/mcp"))` from the daemon's Bun.serve
   * fetch handler. Unauthenticated discovery is served at the exact
   * path `/.well-known/mcp`.
   */
  handle: (req: Request) => Promise<Response>;
  /** Tear down the underlying MCP server + transport. Idempotent. */
  stop: () => Promise<void>;
  /** The McpServer — exposed for the wave-2 tool-surface registration. */
  mcp: McpServer;
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

  const mcp = new McpServer(
    { name: opts.serverInfo.name, version: opts.serverInfo.version },
    { capabilities: {} },
  );

  // Stateless mode keeps the skeleton simple: each request stands
  // alone (no in-memory session table). The wave-2 tool surface can
  // switch to `sessionIdGenerator: () => crypto.randomUUID()` if a
  // long-lived per-client session becomes useful.
  //
  // `enableJsonResponse: true` short-circuits SSE framing on
  // request/response style RPCs so the skeleton's handshake test can
  // parse a single JSON object back. The transport still upgrades to
  // SSE for server-initiated notifications when the client opens a
  // GET stream.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await mcp.connect(transport);

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

    // Forward to the MCP SDK transport. We pass authInfo through so
    // wave-2 tool handlers can recover the caller_id via
    // `RequestHandlerExtra.authInfo`. The transport's authInfo type
    // requires `token` + `clientId` + `scopes`; we synthesize a
    // minimal shape — there's no OAuth flow here, just opaque bearer.
    try {
      return await transport.handleRequest(req, {
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
    try {
      await mcp.close();
    } catch {
      /* idempotent */
    }
    try {
      await transport.close();
    } catch {
      /* idempotent */
    }
  };

  log(`enabled — server="${opts.serverInfo.name}@${opts.serverInfo.version}"`);

  return { handle, stop, mcp };
}
