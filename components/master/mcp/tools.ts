// components/master/mcp/tools.ts
//
// MCP-Expose (#25, wave 2) — minimum-viable tool surface.
//
// Three tools, each proving one piece of the contract:
//
//   • ping           — trivial. Returns server info + the request's
//                      caller_id. Proves auth/identity plumbing without
//                      touching master state.
//
//   • state_snapshot — read-only summary of the master daemon's runtime
//                      state (transcript depth, watchdogs, profile,
//                      uptime). Proves a tool can reach into master
//                      deps via the injected providers.
//
//   • notify         — write-side. Lets an MCP client emit a notification
//                      into master's feed. Provenance flows through to
//                      decisions.jsonl as `mcp:<caller_id>`. Proves that
//                      a caller's identity threads to the audit trail.
//
// Heavier tools (send_message, memory.*, kernel.*, teams.*) defer to
// wave-3 once this thin slice has run in the operator's env for a few
// real interactions.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildMcpProvenance } from "./identity.js";

// ─── Provider interface — what each tool needs from master ──────────────

export interface McpToolProviders {
  /** Master daemon version (matches the `serverInfo` advertised). */
  serverVersion: string;

  /** Read-only state snapshot. Tools never mutate this. */
  getStateSnapshot: () => StateSnapshot;

  /**
   * Emit a notification into master's normal feed. Implementation
   * lives in server.ts and routes through emitNotification(). The
   * provenance struct is opaque to the tool — master decides how to
   * thread it into decisions.jsonl.
   */
  emitNotification: (n: ToolNotification, provenance: Record<string, unknown>) => void;
}

export interface StateSnapshot {
  /** Master version. */
  version: string;
  /** Process uptime in seconds. */
  uptime_s: number;
  /** Number of messages in the transcript (no bodies). */
  transcript_msgs: number;
  /** Number of teams currently tracked. */
  teams_tracked: number;
  /** Active profile name. */
  active_profile: string;
  /** Compact watchdog roster — id, kind, last_tick_at, expected_interval_s. */
  watchdogs: Array<{
    id: string;
    kind: string;
    last_tick_at: string | null;
    expected_interval_s: number | null;
  }>;
  /** Unread + total notification counts. */
  notifications: {
    total: number;
    unread: number;
  };
}

export interface ToolNotification {
  kind: string;
  severity: "info" | "warn" | "alert";
  title: string;
  body: string;
}

// ─── Schemas (Zod for the SDK's high-level registerTool) ────────────────

const PingArgs = z.object({});

const StateSnapshotArgs = z.object({});

const NotifyArgs = z.object({
  kind: z.string().min(1).max(64).describe("Notification kind (e.g. 'mcp-client-info', 'argentos-event')"),
  severity: z.enum(["info", "warn", "alert"]).describe("Severity level"),
  title: z.string().min(1).max(200).describe("Short headline"),
  body: z.string().max(4000).describe("Notification body (markdown ok)"),
});

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Recover the caller_id from RequestHandlerExtra.authInfo. The auth
 * layer (mcp/server.ts) writes it into `extra.caller_id` after the
 * bearer + caller_id headers validate. If absent, the request bypassed
 * auth somehow — refuse loudly.
 */
function callerIdFrom(extra: unknown): string {
  const info = (extra as { authInfo?: { extra?: { caller_id?: unknown } } } | null | undefined)?.authInfo;
  const callerId = info?.extra?.caller_id;
  if (typeof callerId !== "string" || callerId.length === 0) {
    throw new Error("missing caller_id — server.ts must populate authInfo.extra.caller_id");
  }
  return callerId;
}

/**
 * Wrap a result as the SDK's content array. Tools return JSON-as-text
 * because the SDK expects `content: Array<{type:"text",text:string}>`
 * (or richer types like images / resources, but text is the universal
 * baseline).
 */
function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

// ─── Registration ───────────────────────────────────────────────────────

export function registerMcpTools(
  mcp: McpServer,
  providers: McpToolProviders,
): void {
  mcp.registerTool(
    "ping",
    {
      description: "Trivial readiness probe. Returns the server's version and the caller_id the auth layer recovered for this request. Useful to validate transport + auth + identity end-to-end before invoking heavier tools.",
      inputSchema: PingArgs.shape,
    },
    async (_args, extra) => {
      const callerId = callerIdFrom(extra);
      return textResult({
        ok: true,
        server: "subctl-master",
        version: providers.serverVersion,
        caller_id: callerId,
        ts: new Date().toISOString(),
      });
    },
  );

  mcp.registerTool(
    "state_snapshot",
    {
      description: "Read-only snapshot of the master daemon's runtime state: version, uptime, transcript depth, teams tracked, active profile, watchdog roster, notification counts. Bodies are intentionally omitted — call notification-list (future) for content.",
      inputSchema: StateSnapshotArgs.shape,
    },
    async (_args, extra) => {
      callerIdFrom(extra);
      const snap = providers.getStateSnapshot();
      return textResult(snap);
    },
  );

  mcp.registerTool(
    "notify",
    {
      description: "Emit a notification into the master daemon's notification feed (visible in the dashboard's curated activity panel + the Telegram bot for severity=alert). Provenance threads through as `mcp:<caller_id>` for the audit trail.",
      inputSchema: NotifyArgs.shape,
    },
    async (args, extra) => {
      const callerId = callerIdFrom(extra);
      const provenance = buildMcpProvenance(callerId);
      providers.emitNotification(
        {
          kind: args.kind,
          severity: args.severity,
          title: args.title,
          body: args.body,
        },
        provenance,
      );
      return textResult({
        ok: true,
        emitted: { kind: args.kind, severity: args.severity },
        provenance,
      });
    },
  );
}
