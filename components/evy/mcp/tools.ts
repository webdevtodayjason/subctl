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

  // ── v2.8.11 — wave-3 tools ──────────────────────────────────────────
  //
  // The minimum surface to make MCP a usable control plane instead of
  // a demo: write path to Evy (`send_message`) + read paths over the
  // master daemon's runtime state (transcript, decisions, notifications,
  // watchdog roster, teams + inboxes) + a few worker-supervision
  // verbs (team_msg, team_kill) + memory recall.
  //
  // Each provider is a thin function that calls into existing master
  // internals. They're optional so the tool surface degrades gracefully
  // on older deployments: if a provider isn't wired, the tool is
  // skipped during registration (registerMcpTools logs a warning).

  /** Post a prompt into master's chat queue. Evy processes on her next
   *  turn. Returns a request-id the caller can use for follow-up
   *  reads against the transcript. */
  enqueuePrompt?: (text: string, source: string) => { queue_depth: number };

  /** Tail master's transcript — last N turns (user/assistant/tool calls).
   *  Returns opaque message objects; caller decides what to render. */
  getRecentMessages?: (limit: number) => Array<RecentMessage>;

  /** Tail master's append-only decisions.jsonl. Returns the last N
   *  parsed entries newest-last. */
  getRecentDecisions?: (limit: number) => Array<RecentDecision>;

  /** List notifications from the in-process ring buffer. Optional
   *  `unread_only` filter; optional `limit` (max 200). */
  listNotifications?: (opts: { unread_only?: boolean; limit?: number }) => Array<NotificationItem>;

  /** Snapshot the watchdog state — currently watching + last fire info.
   *  Same shape system_watchdog_self exposes internally. */
  getWatchdogState?: () => WatchdogStateView;

  /** List active orchestrator/team tmux sessions. */
  listTeams?: () => Array<TeamSummary>;

  /** Read a team's inbox.jsonl — last N events. */
  getTeamInbox?: (team: string, limit: number) => Array<TeamEvent>;

  /** Send an HMAC-signed directive to a team. Mirrors `subctl team
   *  exec` — wraps body with SPEC block, signs with team secret,
   *  routes via the dashboard's /api/orchestration/:name/msg path. */
  sendTeamMsg?: (team: string, text: string, phase?: string) => Promise<{ ok: boolean; error?: string }>;

  /** Kill a team (archive inbox + tmux kill-session). Mirrors
   *  `subctl team kill`. */
  killTeam?: (team: string) => Promise<{ ok: boolean; error?: string }>;

  /** Semantic + lexical recall across cognee/memori. Returns scored
   *  hits with their source substrate. */
  memorySearch?: (query: string, limit: number) => Promise<Array<MemoryHit>>;

  /** Recent memory observations — Tier 2/3 timeline, newest-last. */
  memoryTimeline?: (limit: number) => Promise<Array<MemoryEntry>>;
}

// ── v2.8.11 wave-3 result types ─────────────────────────────────────

export interface RecentMessage {
  role: string;
  content: string;
  ts?: string;
}

export interface RecentDecision {
  ts: string;
  project?: string;
  action: string;
  rationale: string;
}

export interface NotificationItem {
  id: string;
  ts: string;
  kind: string;
  severity: "info" | "warn" | "alert";
  title: string;
  body: string;
  read?: boolean;
}

export interface WatchdogStateView {
  last_tick_at_ms: number;
  last_fire_at_ms: number;
  last_fire_reason: string;
  interval_minutes: number;
  staleness_threshold_minutes: number;
  watching: Array<{
    team_id: string;
    tmux_session_id: string;
    last_seen_ms: number;
  }>;
}

export interface TeamSummary {
  name: string;
  attached?: boolean;
  windows?: number;
  last_activity_seconds_ago?: number;
  last_event_type?: string;
  last_event_text?: string;
}

export interface TeamEvent {
  ts: string;
  type?: string;
  kind?: string;
  text?: string;
  detail?: string;
  [k: string]: unknown;
}

export interface MemoryHit {
  source: "cognee" | "memori" | "claude-mem" | string;
  score?: number;
  text: string;
  ts?: string;
  meta?: Record<string, unknown>;
}

export interface MemoryEntry {
  ts: string;
  text: string;
  source: string;
  meta?: Record<string, unknown>;
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

  // ── v2.8.11 — wave-3 tools ────────────────────────────────────────
  registerWaveThreeTools(mcp, providers);
}

// ─── Wave-3 schemas ─────────────────────────────────────────────────────

const SendMessageArgs = z.object({
  text: z.string().min(1).max(8000).describe("Prompt body. Plain text or markdown — same as a dashboard chat message. Evy processes on her next turn."),
});

const RecentMessagesArgs = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("How many recent transcript entries to return (1-100, default 20)."),
});

const RecentDecisionsArgs = z.object({
  limit: z.number().int().min(1).max(200).default(50).describe("How many recent decisions to return (1-200, default 50)."),
});

const ListNotificationsArgs = z.object({
  unread_only: z.boolean().default(false).describe("If true, return only unread notifications."),
  limit: z.number().int().min(1).max(200).default(50).describe("Max notifications to return (1-200, default 50)."),
});

const WatchdogStateArgs = z.object({});

const ListTeamsArgs = z.object({});

const TeamInboxArgs = z.object({
  team: z.string().min(1).max(128).describe("Team name (tmux session name) — see list_teams output."),
  limit: z.number().int().min(1).max(200).default(50).describe("Max events to return (1-200, default 50)."),
});

const TeamMsgArgs = z.object({
  team: z.string().min(1).max(128).describe("Team name (tmux session name)."),
  text: z.string().min(1).max(8000).describe("Message body. Will be wrapped in a SPEC block and HMAC-signed before delivery."),
  phase: z.string().max(128).optional().describe("Optional phase label embedded in the directive marker (helps the worker locate the task in its work plan)."),
});

const TeamKillArgs = z.object({
  team: z.string().min(1).max(128).describe("Team name (tmux session name) to kill. Inbox is archived to teams/.killed/ before the tmux session ends."),
});

const MemorySearchArgs = z.object({
  query: z.string().min(1).max(500).describe("Semantic search query."),
  limit: z.number().int().min(1).max(50).default(10).describe("Max hits to return across all substrates (1-50, default 10)."),
});

const MemoryTimelineArgs = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("How many recent entries to return (1-100, default 20)."),
});

// ─── Wave-3 registrar ───────────────────────────────────────────────────

function registerWaveThreeTools(mcp: McpServer, providers: McpToolProviders): void {
  if (providers.enqueuePrompt) {
    mcp.registerTool(
      "send_message",
      {
        description: "Post a prompt into master's chat queue. Evy (the master daemon's persona) processes it on her next turn, just like a message typed into the dashboard. The reply lands in the transcript — read it back via recent_messages a moment later. Use this to converse with Evy from Claude Desktop / ArgentOS / any MCP client.",
        inputSchema: SendMessageArgs.shape,
      },
      async (args, extra) => {
        const callerId = callerIdFrom(extra);
        const source = `mcp:${callerId}`;
        const result = providers.enqueuePrompt!(args.text, source);
        return textResult({
          ok: true,
          queued: { source, queue_depth: result.queue_depth },
          ts: new Date().toISOString(),
        });
      },
    );
  }

  if (providers.getRecentMessages) {
    mcp.registerTool(
      "recent_messages",
      {
        description: "Tail master's transcript — last N turns including user prompts, Evy's replies, and tool calls. Use after send_message to read Evy's response, or to inspect what Evy has been doing.",
        inputSchema: RecentMessagesArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const messages = providers.getRecentMessages!(args.limit);
        return textResult({ messages });
      },
    );
  }

  if (providers.getRecentDecisions) {
    mcp.registerTool(
      "recent_decisions",
      {
        description: "Tail master's append-only decisions.jsonl — last N entries newest-last. Each entry is a structured decision: watchdog actions, memory promotions, sweep results, classifier outcomes. The audit trail of what Evy + the watchdog decided.",
        inputSchema: RecentDecisionsArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const decisions = providers.getRecentDecisions!(args.limit);
        return textResult({ decisions });
      },
    );
  }

  if (providers.listNotifications) {
    mcp.registerTool(
      "list_notifications",
      {
        description: "List notifications from master's curated activity feed. Full body content (not just counts like state_snapshot returns). Filter to unread-only or set a limit. Includes notifications emitted by team-staleness escalations, upstream-available alerts, master errors, and MCP notify calls.",
        inputSchema: ListNotificationsArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const notifications = providers.listNotifications!({
          unread_only: args.unread_only,
          limit: args.limit,
        });
        return textResult({ notifications });
      },
    );
  }

  if (providers.getWatchdogState) {
    mcp.registerTool(
      "watchdog_state",
      {
        description: "Inspect the team-staleness watchdog: what teams it's currently tracking, when each was last seen, when the watchdog last ticked, what its last fire reason was. The MCP equivalent of system_watchdog_self.",
        inputSchema: WatchdogStateArgs.shape,
      },
      async (_args, extra) => {
        callerIdFrom(extra);
        const state = providers.getWatchdogState!();
        return textResult(state);
      },
    );
  }

  if (providers.listTeams) {
    mcp.registerTool(
      "list_teams",
      {
        description: "List active orchestrator/team tmux sessions. Mirrors `subctl team list`. Returns name + attached state + windows + last activity per team.",
        inputSchema: ListTeamsArgs.shape,
      },
      async (_args, extra) => {
        callerIdFrom(extra);
        const teams = providers.listTeams!();
        return textResult({ teams });
      },
    );
  }

  if (providers.getTeamInbox) {
    mcp.registerTool(
      "team_inbox",
      {
        description: "Read a team's inbox.jsonl — the append-only stream of events a team has reported (progress, blocked, done, error, note). Use to see what a worker has done.",
        inputSchema: TeamInboxArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const events = providers.getTeamInbox!(args.team, args.limit);
        return textResult({ team: args.team, events });
      },
    );
  }

  if (providers.sendTeamMsg) {
    mcp.registerTool(
      "team_msg",
      {
        description: "Send an HMAC-signed directive to a team. The body is wrapped in a SPEC block per the v2.8.8 contract, signed with the team's secret, and delivered via tmux paste-buffer. The team lead verifies the HMAC before executing. Use this for legitimate supervisor messages — the operator's voice via MCP.",
        inputSchema: TeamMsgArgs.shape,
      },
      async (args, extra) => {
        const callerId = callerIdFrom(extra);
        const result = await providers.sendTeamMsg!(args.team, args.text, args.phase);
        return textResult({
          ok: result.ok,
          team: args.team,
          phase: args.phase ?? null,
          delivered_by: `mcp:${callerId}`,
          error: result.error,
        });
      },
    );
  }

  if (providers.killTeam) {
    mcp.registerTool(
      "team_kill",
      {
        description: "Archive a team's inbox to teams/.killed/ and tear down its tmux session. Mirrors `subctl team kill`. Irreversible — the team's transcript is preserved in the archive but the workers stop.",
        inputSchema: TeamKillArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const result = await providers.killTeam!(args.team);
        return textResult({
          ok: result.ok,
          team: args.team,
          error: result.error,
        });
      },
    );
  }

  if (providers.memorySearch) {
    mcp.registerTool(
      "memory_search",
      {
        description: "Search across master's memory substrates (cognee graph + memori SQLite + claude-mem observations). Returns scored hits with source attribution. Use to recall prior decisions, operator preferences, project context, observed events.",
        inputSchema: MemorySearchArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const hits = await providers.memorySearch!(args.query, args.limit);
        return textResult({ query: args.query, hits });
      },
    );
  }

  if (providers.memoryTimeline) {
    mcp.registerTool(
      "memory_timeline",
      {
        description: "Recent memory observations — Tier 2/3 timeline, newest-last. The chronological feed of what master + Evy have observed and chosen to remember.",
        inputSchema: MemoryTimelineArgs.shape,
      },
      async (args, extra) => {
        callerIdFrom(extra);
        const entries = await providers.memoryTimeline!(args.limit);
        return textResult({ entries });
      },
    );
  }
}
