# components/master/mcp

In-process Model Context Protocol (MCP) server for the subctl-master
daemon. Wave-1 of issue **#24 — MCP-Expose**.

## Design summary

The master daemon already runs a Bun HTTP server on port 8788 for the
chat surface. Rather than spinning up a second listener, the MCP server
mounts under `/mcp/*` on that same port (localhost-only by default).
Authentication is a fixed bearer token from
`secrets.json#subctl_mcp_token`; every authenticated request must also
carry an `X-Caller-Id` header identifying the upstream (e.g.
`claude-desktop`, `argentos`, `orch-claude-code-<session>`). The
caller_id threads through to `.subctl/docs/decisions.jsonl` as
`by: "mcp:<caller_id>"`, so downstream historians can attribute any
decision back to the originating MCP client.

The transport is the SDK's
`WebStandardStreamableHTTPServerTransport` — Web-Standards Request /
Response, runs natively on Bun, no Node-compat shim. JSON-response mode
is enabled (`enableJsonResponse: true`) so handshakes return a single
JSON object; the transport still upgrades to SSE for server-initiated
notifications when a client opens a GET stream. The discovery endpoint
`/.well-known/mcp` is unauthenticated by convention — it advertises
what the auth requirements are.

## File layout

| File          | Purpose                                                |
| ------------- | ------------------------------------------------------ |
| `auth.ts`     | Bearer + caller_id validation (pure, no I/O)           |
| `identity.ts` | `caller_id → DecisionProvenance` adapter               |
| `server.ts`   | `McpServer` + transport wiring; returns Bun handler    |
| `index.ts`    | Public re-exports                                      |

Tests live in `components/master/__tests__/mcp-*.test.ts`.

## TODO — integration commit (wave-1 follow-up)

This skeleton is **not yet mounted** on `components/master/server.ts`.
The integration commit will:

1. Import `startMcpServer` from this module at daemon boot.
2. Call it with `expectedToken: loadSecret("subctl_mcp_token")` and a
   `serverInfo: { name: "subctl-master", version: SUBCTL_VERSION }`.
3. In the existing Bun.serve fetch handler, branch on
   `url.pathname === "/.well-known/mcp"` and
   `url.pathname.startsWith("/mcp")`, forwarding to the returned
   `handle`.
4. Register the handle's `stop()` in the daemon's shutdown path.

The mount is deliberately deferred so this PR can land without
touching `server.ts` (a heavily-edited, high-merge-conflict file).

## TODO — wave-2 (tool surface, #25)

When tools land:

- Register them via `mcp.server.setRequestHandler(CallToolRequestSchema, …)`
  or the high-level `mcp.registerTool(...)` from
  `@modelcontextprotocol/sdk/server/mcp.js`.
- The handler's `RequestHandlerExtra` carries `authInfo` — recover the
  caller_id via `authInfo?.extra?.caller_id` (set in `server.ts`).
- Build the provenance row with
  `buildMcpProvenance(callerId)` from `./identity.ts` and spread into
  the decisions.jsonl append.
