// components/master/mcp/index.ts
//
// Public surface of the master daemon's MCP server. Wave-1 scope:
// auth + identity + transport handshake. Tool/resource registration
// arrives in #25/#26.
//
// Integration boundary: the master daemon imports `startMcpServer`
// from here and mounts the returned `handle` under `/mcp/*` (plus the
// unauthenticated discovery path). See README.md for the integration
// TODO and design summary.

export { startMcpServer } from "./server.js";
export type {
  McpServerHandle,
  McpServerInfo,
  StartMcpServerOptions,
} from "./server.js";

export {
  authenticateRequest,
  authErrorResponseBody,
  parseBearer,
  validateCallerId,
  HEADERS,
} from "./auth.js";
export type {
  AuthResult,
  AuthSuccess,
  AuthFailure,
  AuthenticateOptions,
} from "./auth.js";

export {
  MCP_DECISION_PREFIX,
  formatDecisionBy,
  parseDecisionBy,
  buildMcpProvenance,
} from "./identity.js";
export type { McpProvenance } from "./identity.js";

export { registerMcpTools } from "./tools.js";
export type {
  McpToolProviders,
  StateSnapshot,
  ToolNotification,
} from "./tools.js";
