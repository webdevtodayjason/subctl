#!/usr/bin/env bun
// components/mcp/server.ts — MCP stdio server exposing subctl as a tool surface.
//
// Registered in ~/.claude/settings.json under mcpServers. Claude Code spawns
// this process as a stdio child whenever it needs subctl tools.
//
// Each tool is a thin wrapper around the dashboard's HTTP API at
// 127.0.0.1:8787. The dashboard service must be running (subctl service status).
// If it isn't, tools return a clear error directing the user to start it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";

const API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

// Resolve the subctl binary so MCP-side shell-outs work even when the user's
// PATH inside the spawned MCP process is minimal (Claude Code spawns MCP
// servers with a thin env).
const SUBCTL_BIN = process.env.SUBCTL_BIN
  ?? `${process.env.HOME}/code/subctl/bin/subctl`;

const server = new Server(
  { name: "subctl", version: "1.4.0" },
  { capabilities: { tools: {} } },
);

// ---------- helpers ----------

async function apiGet(path: string): Promise<any> {
  const r = await fetch(`${API}${path}`);
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function apiPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Shell out to `subctl` for verbs without a clean HTTP equivalent (notify
// send, ask-protocol). The dashboard's HTTP API doesn't yet have notify-send
// endpoints; bin/subctl does. This is the cleanest bridge.
async function subctlExec(args: string[], stdinText?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(SUBCTL_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    if (stdinText) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function ok(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): never {
  throw new Error(message);
}

// ---------- tool list ----------

const TOOLS = [
  {
    name: "subctl_stats",
    description: "Live dashboard state: dispatch verdict, per-account 5h/week utilization, RL hits, savings. Use when the user asks 'what's my status', 'how's everything looking', or before dispatching new work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "subctl_orch_list",
    description: "List all running orchestrator tmux sessions across all accounts. Each session has a unique name (e.g. claude-myproject) used to address it everywhere.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "subctl_orch_status",
    description: "Live preview + state for one orchestrator session. Use to check what a specific session is doing right now without attaching.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Session name (e.g. claude-myproject)" } },
      required: ["name"],
    },
  },
  {
    name: "subctl_orch_spawn",
    description: "Spawn a new detached orchestrator tmux session. Use when starting work on a project that needs the orchestrator-mode pattern. Returns the session name to address with subctl_orch_msg / subctl_orch_kill.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Alias from accounts.conf (e.g. claude-personal)" },
        project: { type: "string", description: "Absolute path to the project root" },
        prompt: { type: "string", description: "Initial prompt to inject after Claude boots" },
        orchestrator: { type: "boolean", description: "Inject the orchestrator-mode prompt", default: true },
        skip_perms: { type: "boolean", description: "Pass --dangerously-skip-permissions", default: true },
        continue: { type: "boolean", description: "Continue the most recent session for this account", default: false },
        resume: { type: "string", description: "Resume a specific session by id" },
      },
      required: ["account", "project"],
    },
  },
  {
    name: "subctl_orch_msg",
    description: "Inject text into a running orchestrator session's active pane. The orchestrator picks it up as if you typed it into tmux directly. Use to redirect mid-flight without attaching.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        text: { type: "string", description: "Text to inject (multi-line OK)" },
      },
      required: ["name", "text"],
    },
  },
  {
    name: "subctl_orch_kill",
    description: "Kill an orchestrator session. Irreversible; use when the session is stuck or its work is no longer needed.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "subctl_notify_send",
    description: "Send a fire-and-forget Telegram message to the operator. Use for status updates, completion announcements, or non-decision FYI messages. Auto-prefixes with cwd.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Message body" } },
      required: ["message"],
    },
  },
  {
    name: "subctl_notify_ask_yesno",
    description: "Send a Yes/No question to the operator with inline keyboard buttons. Async — returns the question id immediately; the operator's tap lands in the inbox. Use subctl_notify_inbox to check for the reply.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        question_id: { type: "string", description: "Optional explicit Q-id (default: auto-generated)" },
      },
      required: ["question"],
    },
  },
  {
    name: "subctl_notify_ask_choice",
    description: "Send a multi-choice question (2-8 options) to the operator with inline keyboard buttons. Async — returns the question id immediately; tap lands in inbox.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          description: "Array of {id, label} objects, 2-8 items. id is the short code returned in the inbox.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
            required: ["id", "label"],
          },
        },
        question_id: { type: "string" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "subctl_notify_inbox",
    description: "Read operator replies from the inbox. Filter by question_id to check for a specific ask's answer. Returns most-recent-first.",
    inputSchema: {
      type: "object",
      properties: {
        question_id: { type: "string", description: "Filter to a specific question id" },
        unacked_only: { type: "boolean", description: "Only return unacked entries", default: false },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "subctl_notify_inbox_ack",
    description: "Mark a question's reply as consumed so --unacked queries don't re-return it.",
    inputSchema: {
      type: "object",
      properties: { question_id: { type: "string" } },
      required: ["question_id"],
    },
  },
  {
    name: "subctl_session_list",
    description: "List Claude Code session JSONL files across all accounts. Useful for finding past sessions to resume.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 50 },
        workers: { type: "boolean", description: "Include orchestrator-spawned worker sessions", default: false },
      },
    },
  },
];

// ---------- handlers ----------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  const name = request.params?.name as string;
  const args = (request.params?.arguments ?? {}) as any;

  try {
    switch (name) {
      case "subctl_stats": {
        const s = await apiGet("/api/state");
        // Compress for context efficiency — strip heavy panels the agent rarely needs
        const compact = {
          version: s.version,
          verdict: s.dispatch?.verdict,
          reasons: s.dispatch?.reasons ?? [],
          accounts: (s.accounts ?? []).map((a: any) => ({
            alias: a.alias,
            auth_status: a.auth_status,
            five_hour_pct: a.five_hour_pct ?? a.five_hour_max_pct,
            seven_day_pct: a.seven_day_pct ?? a.seven_day_max_pct,
            rl_hits_today: a.rl_hits_today,
            active_sessions: a.active_sessions,
          })),
          totals: s.totals,
          rl_today: s.totals?.rl_today,
          recent_429s: s.rate_limits?.recent_429_count,
          savings_month_usd: s.cost?.totals?.savings_month_usd,
        };
        return ok(JSON.stringify(compact, null, 2));
      }
      case "subctl_orch_list": {
        const r = await apiGet("/api/orchestration");
        return ok(JSON.stringify(r.orchestrations ?? [], null, 2));
      }
      case "subctl_orch_status": {
        const n = encodeURIComponent(args.name);
        const r = await apiGet(`/api/orchestration/${n}`);
        return ok(JSON.stringify(r, null, 2));
      }
      case "subctl_orch_spawn": {
        const r = await apiPost("/api/orchestration/spawn", {
          account: args.account,
          project: args.project,
          prompt: args.prompt,
          orchestrator: args.orchestrator ?? true,
          skip_perms: args.skip_perms ?? true,
          continue: args.continue ?? false,
          resume: args.resume,
        });
        return ok(JSON.stringify(r, null, 2));
      }
      case "subctl_orch_msg": {
        const n = encodeURIComponent(args.name);
        const r = await apiPost(`/api/orchestration/${n}/msg`, { text: args.text });
        return ok(JSON.stringify(r, null, 2));
      }
      case "subctl_orch_kill": {
        const n = encodeURIComponent(args.name);
        const r = await apiPost(`/api/orchestration/${n}/kill`, {});
        return ok(JSON.stringify(r, null, 2));
      }
      case "subctl_notify_send": {
        const r = await subctlExec(["notify", args.message]);
        if (r.code !== 0) fail(r.stderr || r.stdout || "notify failed");
        return ok(r.stdout.trim() || "sent");
      }
      case "subctl_notify_ask_yesno": {
        const cmd = ["notify", "ask-yesno", args.question];
        if (args.question_id) cmd.push("--id", args.question_id);
        const r = await subctlExec(cmd);
        if (r.code !== 0) fail(r.stderr || r.stdout || "ask-yesno failed");
        // Last line of stdout is the question id (echoed by ask-yesno)
        const lines = r.stdout.trim().split("\n").filter(Boolean);
        const qid = lines[lines.length - 1] || "";
        return ok(JSON.stringify({ ok: true, question_id: qid }));
      }
      case "subctl_notify_ask_choice": {
        const cmd = ["notify", "ask-choice", args.question];
        for (const opt of args.options ?? []) {
          cmd.push("-o", `${opt.id}:${opt.label}`);
        }
        if (args.question_id) cmd.push("--id", args.question_id);
        const r = await subctlExec(cmd);
        if (r.code !== 0) fail(r.stderr || r.stdout || "ask-choice failed");
        const lines = r.stdout.trim().split("\n").filter(Boolean);
        const qid = lines[lines.length - 1] || "";
        return ok(JSON.stringify({ ok: true, question_id: qid }));
      }
      case "subctl_notify_inbox": {
        const params = new URLSearchParams();
        if (args.question_id) params.set("question_id", args.question_id);
        if (args.unacked_only) params.set("unacked_only", "1");
        params.set("limit", String(args.limit ?? 20));
        const r = await apiGet(`/api/notify/inbox?${params}`);
        return ok(JSON.stringify(r.entries ?? [], null, 2));
      }
      case "subctl_notify_inbox_ack": {
        const id = encodeURIComponent(args.question_id);
        const r = await apiPost(`/api/notify/inbox/${id}/ack`, {});
        return ok(JSON.stringify(r));
      }
      case "subctl_session_list": {
        const params = new URLSearchParams();
        params.set("limit", String(args.limit ?? 50));
        if (args.workers) params.set("workers", "1");
        const r = await apiGet(`/api/sessions/list?${params}`);
        return ok(JSON.stringify({
          total: r.total,
          sessions: (r.sessions ?? []).slice(0, args.limit ?? 50).map((s: any) => ({
            sid: s.sid,
            account: s.account,
            project: s.project,
            mtime_ts: s.mtime_ts,
            size_kb: s.size_kb,
            preview: s.first_message_preview?.slice(0, 100),
          })),
        }, null, 2));
      }
      default:
        fail(`Unknown tool: ${name}`);
    }
  } catch (e: any) {
    return ok(`error: ${e?.message || e}`);
  }
});

// ---------- main ----------

const transport = new StdioServerTransport();
await server.connect(transport);
// Don't write to stdout — that breaks the MCP protocol.
console.error("[subctl-mcp] connected via stdio");
