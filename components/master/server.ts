// subctl master — the master daemon entry point.
//
// A persistent, conversational orchestrator running on the M3 Ultra:
//   1. Loads providers.json + policy.json + the master SKILL prompt
//   2. Initializes pi-agent-core with multi-tool registry (subctl_orch_*, gh_*,
//      coderabbit_*, telegram_*) and a transcript that survives restarts
//   3. Exposes HTTP/SSE so the dashboard browser tab and Telegram listener can
//      both push messages in (POST /chat) and subscribe to streaming agent
//      events (GET /events).
//   4. Runs a watchdog ticker that scans open dev teams + tracked projects for
//      staleness and fires synthetic agent prompts so the master can ping the
//      lead, escalate to Jason, or take corrective action. Master is reactive
//      to user chat AND proactive about keeping projects moving — that's the KPI.
//
// Lives at: /Users/sem/code/subctl/components/master/
// Started by: launchd plist (com.subctl.master.plist) at boot
// Logs to:    /Users/sem/Library/Logs/subctl/master.log
// HTTP at:    127.0.0.1:8788 (configurable via SUBCTL_MASTER_PORT) — kept on
//             localhost on purpose; dashboard server proxies the public surface.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { registerBuiltInApiProviders } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

// pi-ai's stream factory keeps a registry keyed by `model.api`. Built-in
// providers (anthropic-messages, openai-completions, openai-responses,
// google-generative-ai, …) are registered ONLY when this function is
// called — it's NOT a side-effect of `import`. Without this call, every
// agent.prompt() returns an empty content array because the agent loop
// looks up the api in the registry, finds nothing, and silently produces
// a no-op stream. Diagnosed 2026-05-09 after the daemon's first boot
// produced empty assistant responses while direct curl to LM Studio worked.
registerBuiltInApiProviders();

import { subctlOrchTools } from "./tools/subctl-orch";
import { ghTools } from "./tools/gh";
import { coderabbitTools } from "./tools/coderabbit";
import { telegramTools } from "./tools/telegram";

const HOME = homedir();
const COMPONENT_DIR = import.meta.dir;
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const MASTER_STATE_DIR = join(SUBCTL_CONFIG_DIR, "master");
const MASTER_LOG = join(HOME, "Library", "Logs", "subctl", "master.log");

const PROVIDERS_PATH = join(MASTER_STATE_DIR, "providers.json");
const POLICY_PATH = join(MASTER_STATE_DIR, "policy.json");
const STATE_PATH = join(MASTER_STATE_DIR, "state.json");
const AGENT_STATE_PATH = join(MASTER_STATE_DIR, "agent-state.json");
const DECISIONS_LOG = join(MASTER_STATE_DIR, "decisions.jsonl");
const SKILL_PATH = join(COMPONENT_DIR, "..", "skills", "master", "SKILL.md");

// ─── boot probe ─────────────────────────────────────────────────────────────

function ensureConfigFiles(): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Ensure state dir exists
  mkdirSync(MASTER_STATE_DIR, { recursive: true });

  // Seed providers.json from .example if absent
  if (!existsSync(PROVIDERS_PATH)) {
    const example = join(COMPONENT_DIR, "providers.json.example");
    if (existsSync(example)) {
      writeFileSync(PROVIDERS_PATH, readFileSync(example));
      warnings.push(
        `seeded ${PROVIDERS_PATH} from example — edit before first run`,
      );
    } else {
      warnings.push(`providers.json missing and no example to seed from`);
    }
  }

  // Seed policy.json from .example if absent
  if (!existsSync(POLICY_PATH)) {
    const example = join(COMPONENT_DIR, "policy.json.example");
    if (existsSync(example)) {
      writeFileSync(POLICY_PATH, readFileSync(example));
      warnings.push(
        `seeded ${POLICY_PATH} from example — edit before first run`,
      );
    }
  }

  // Initialize state.json
  if (!existsSync(STATE_PATH)) {
    writeFileSync(
      STATE_PATH,
      JSON.stringify(
        {
          last_review_ts: null,
          active_projects: {},
          known_workers: {},
          version: "0.1.0",
        },
        null,
        2,
      ),
    );
  }

  // SKILL.md sanity
  if (!existsSync(SKILL_PATH)) {
    return { ok: false, warnings: [...warnings, `missing SKILL.md at ${SKILL_PATH}`] };
  }

  return { ok: true, warnings };
}

// ─── load configuration ─────────────────────────────────────────────────────

interface Providers {
  models: Record<string, { provider: string; model: string; host?: string }>;
  escalate: { provider: string; model: string; auth?: string };
  fallback: { provider: string; model: string; auth?: string };
  routing_policy?: Record<string, string>;
  memory_budget_gb?: { target: number; ceiling: number };
}

interface Policy {
  operator: { name: string; telegram_chat_id: string; office_hours?: string };
  global_defaults: {
    autonomy_level: "drive" | "ask" | "shadow";
    require_coderabbit_pre_push: boolean;
    max_concurrent_workers: number;
    review_interval_minutes: number;
    stall_detection_minutes: number;
    stall_action: "escalate" | "auto_unstick" | "kill";
  };
  projects: Array<{
    path: string;
    autonomy_level: "drive" | "ask" | "shadow";
    watch_branches?: string[];
    ci_required?: boolean;
    coderabbit_config?: string;
    must_escalate?: string[];
  }>;
  escalation_triggers: Record<string, boolean>;
  silence_triggers: Record<string, boolean>;
}

function loadConfig(): { providers: Providers; policy: Policy; skill: string } {
  // Strip _comment fields when parsing (jsonc-lite)
  const stripComments = (raw: string) =>
    raw
      .split("\n")
      .filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l))
      .join("\n")
      .replace(/,(\s*[}\]])/g, "$1"); // trailing-comma forgiveness

  const providers = JSON.parse(
    stripComments(readFileSync(PROVIDERS_PATH, "utf8")),
  ) as Providers;
  const policy = JSON.parse(
    stripComments(readFileSync(POLICY_PATH, "utf8")),
  ) as Policy;
  const skill = readFileSync(SKILL_PATH, "utf8");
  return { providers, policy, skill };
}

// ─── decision logging ───────────────────────────────────────────────────────

interface DecisionEntry {
  ts: string;
  project: string;
  action: string;
  rationale: string;
  operator_signal_required?: boolean;
  result?: unknown;
}

function logDecision(entry: Omit<DecisionEntry, "ts">) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(DECISIONS_LOG, line + "\n");
}

// ─── tool registry ──────────────────────────────────────────────────────────
// Aggregated catalog of every tool the master can call, namespaced by source
// module. The shape (`description` + raw JSON `schema` + `invoke`) is stable
// across the four tool modules so workers in other slices can extend it.

interface InternalTool {
  description: string;
  schema: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

export const toolRegistry: Record<string, InternalTool> = {
  ...Object.fromEntries(
    Object.entries(subctlOrchTools).map(([k, v]) => [
      `subctl_orch_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(ghTools).map(([k, v]) => [
      `gh_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(coderabbitTools).map(([k, v]) => [
      `coderabbit_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(telegramTools).map(([k, v]) => [
      `telegram_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
};

// ─── SDK adapters ──────────────────────────────────────────────────────────
// pi-agent-core wants AgentTool<TSchema> (typebox parameters + `execute`). Our
// tools/*.ts modules export `{description, schema (raw JSON Schema), invoke}`.
// The agent loop validates args with Value.Convert + a TypeBox/JsonSchema
// fallback validator, so passing a plain JSON Schema as `parameters` is safe;
// the Anthropic provider just reads `schema.properties` + `schema.required`.

function adaptTool(name: string, tool: InternalTool): AgentTool {
  return {
    name,
    label: name,
    description: tool.description,
    parameters: tool.schema as TSchema,
    execute: async (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await tool.invoke(params as Record<string, unknown>);
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

// providers.json gives us `{provider, model, host?}` for each role. pi-ai's
// `getModel(provider, modelId)` only resolves models in its built-in registry,
// which doesn't cover local runtimes (mlx/ollama/lmstudio) or operator-pinned
// custom IDs. We construct a Model<any> object directly — it's a structural
// type and the provider/api fields drive dispatch in pi-ai's stream pipeline.
const PROVIDER_API: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  "openai-codex": "openai-codex-responses",
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
  "amazon-bedrock": "bedrock-converse-stream",
  mistral: "mistral-conversations",
  // Local OpenAI-compatible runtimes (mlx, ollama, lmstudio, vllm…) all speak
  // the OpenAI Chat Completions wire format.
  mlx: "openai-completions",
  ollama: "openai-completions",
  lmstudio: "openai-completions",
  vllm: "openai-completions",
};

function buildModel(cfg: {
  provider: string;
  model: string;
  host?: string;
}): Model<string> {
  const api = PROVIDER_API[cfg.provider] ?? "openai-completions";
  return {
    id: cfg.model,
    name: cfg.model,
    api,
    provider: cfg.provider,
    baseUrl: cfg.host ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

// ─── agent transcript persistence ──────────────────────────────────────────

function loadAgentTranscript(): AgentMessage[] {
  if (!existsSync(AGENT_STATE_PATH)) return [];
  try {
    const raw = readFileSync(AGENT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { messages?: AgentMessage[] };
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (err) {
    console.error(
      `[master] WARN agent-state.json corrupt, starting fresh: ${(err as Error).message}`,
    );
    return [];
  }
}

function saveAgentTranscript(messages: AgentMessage[]) {
  writeFileSync(
    AGENT_STATE_PATH,
    JSON.stringify({ saved_at: new Date().toISOString(), messages }, null, 2),
  );
}

function updateLastReviewTs() {
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    state.last_review_ts = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(
      `[master] WARN could not update state.json last_review_ts: ${(err as Error).message}`,
    );
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[master] booting subctl master v0.1.0`);

  const probe = ensureConfigFiles();
  if (!probe.ok) {
    console.error(`[master] boot failed: ${probe.warnings.join("; ")}`);
    process.exit(1);
  }
  for (const w of probe.warnings) console.error(`[master] WARN ${w}`);

  const { providers, policy, skill } = loadConfig();
  console.error(
    `[master] loaded — operator=${policy.operator.name}, projects=${policy.projects.length}, models=${Object.keys(providers.models).length}`,
  );

  // ── pi-agent-core wiring ────────────────────────────────────────────────
  const supervisorCfg = providers.models.supervisor;
  if (!supervisorCfg) {
    console.error(
      `[master] FATAL providers.json missing models.supervisor — cannot boot agent`,
    );
    process.exit(1);
  }
  const supervisorModel = buildModel(supervisorCfg);
  const tools = Object.entries(toolRegistry).map(([name, t]) =>
    adaptTool(name, t),
  );

  // Local-runtime providers (mlx/ollama/lmstudio/vllm) don't need real API
  // keys — LM Studio and Ollama accept any value, and the request never leaves
  // the box. pi-ai's openai-completions provider still requires SOMETHING in
  // the Authorization header, so feed it a sentinel for local providers and
  // let real ones fall through (Anthropic + Codex pull from their own env vars
  // / OAuth flow internally; we don't need to thread those here).
  const LOCAL_PROVIDERS = new Set(["mlx", "ollama", "lmstudio", "vllm"]);
  const getApiKey = (provider: string): string | undefined => {
    if (LOCAL_PROVIDERS.has(provider)) return "not-needed";
    // Fall through — pi-ai handles real providers via env vars / OAuth
    return undefined;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: skill,
      model: supervisorModel,
      tools,
      messages: loadAgentTranscript(),
    },
    sessionId: `subctl-master-${Date.now()}`,
    getApiKey,
  });

  // ── event bus: agent → SSE subscribers ──────────────────────────────────
  // Every connected /events client gets every agent event (text deltas, tool
  // calls, decisions, watchdog firings) as Server-Sent Events. Persist the
  // transcript on agent_end so a restart resumes the conversation.
  const sseClients = new Set<{ write: (data: string) => void }>();

  function broadcast(eventType: string, payload: unknown) {
    const line = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of sseClients) {
      try { c.write(line); } catch { /* client dropped, will GC on next iter */ }
    }
  }

  agent.subscribe((event) => {
    // Stream every event to subscribers — the dashboard chat panel renders
    // text deltas live, the tool-call ticker shows what the master is doing,
    // and the decision log captures rationale.
    broadcast(event.type, event);
    if (event.type === "agent_end") {
      saveAgentTranscript(agent.state.messages);
    }
  });

  // ── lead-report inbox ──────────────────────────────────────────────────
  // Each running dev team gets a JSONL file at $MASTER_STATE_DIR/inbox/{team}.jsonl.
  // The team lead (claude in tmux pane 0) appends one JSON line per status event:
  //
  //   {"ts":"…","type":"progress|blocked|done|error|note","text":"…", …}
  //
  // We tail every file in the dir, broadcast new lines as `team_event` SSE
  // events (so the dashboard updates live), expose per-team last-activity to
  // the watchdog (so it can decide if a team's gone stale), and surface
  // "blocked"/"error" events to the agent so it can decide whether to ping
  // the lead or escalate to Jason.
  const INBOX_DIR = join(MASTER_STATE_DIR, "inbox");
  mkdirSync(INBOX_DIR, { recursive: true });

  type TeamEvent = {
    ts: string;
    type: string;
    text?: string;
    [k: string]: unknown;
  };
  const teamLastActivity = new Map<string, { ts: number; lastEvent?: TeamEvent }>();
  const teamReadOffsets = new Map<string, number>(); // file path → last byte read

  function teamNameFromPath(p: string): string {
    return p.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  }

  function tailInboxFile(filePath: string) {
    let stat;
    try {
      stat = require("node:fs").statSync(filePath);
    } catch {
      return;
    }
    const team = teamNameFromPath(filePath);
    const prev = teamReadOffsets.get(filePath) ?? 0;
    if (stat.size === prev) return;
    if (stat.size < prev) {
      // file truncated/rotated — re-read from 0
      teamReadOffsets.set(filePath, 0);
      return tailInboxFile(filePath);
    }
    let chunk: string;
    try {
      const fd = require("node:fs").openSync(filePath, "r");
      const buf = Buffer.alloc(stat.size - prev);
      require("node:fs").readSync(fd, buf, 0, buf.length, prev);
      require("node:fs").closeSync(fd);
      chunk = buf.toString("utf8");
    } catch (err) {
      console.error(`[master] inbox tail error ${filePath}: ${(err as Error).message}`);
      return;
    }
    teamReadOffsets.set(filePath, stat.size);
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let ev: TeamEvent;
      try {
        ev = JSON.parse(line) as TeamEvent;
      } catch {
        continue;
      }
      teamLastActivity.set(team, { ts: Date.now(), lastEvent: ev });
      broadcast("team_event", { team, ...ev });
      // Auto-prompt the agent on important event types so it can react.
      if (ev.type === "blocked" || ev.type === "error") {
        const summary = ev.text ?? JSON.stringify(ev);
        const synth = `[team-report] dev-team "${team}" reported ${ev.type}: ${summary}. Decide whether to ping the lead via subctl_orch_msg, escalate to Jason via telegram_send, or take corrective action.`;
        void dispatchToAgent(synth, "watchdog");
      }
    }
  }

  function scanInboxOnce() {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const f of readdirSync(INBOX_DIR)) {
        if (f.endsWith(".jsonl")) tailInboxFile(join(INBOX_DIR, f));
      }
    } catch (err) {
      console.error(`[master] inbox scan error: ${(err as Error).message}`);
    }
  }

  // Initial pass to populate teamLastActivity from existing files.
  scanInboxOnce();
  // ALWAYS poll — fs.watch on macOS fires unreliably (filename arg often
  // undefined for content writes inside the watched dir), so we can't depend
  // on it. The watcher below is an opportunistic "wake sooner" optimization;
  // the poll is the contract.
  const inboxPoll = setInterval(scanInboxOnce, 2000);
  let inboxWatcher: import("node:fs").FSWatcher | null = null;
  try {
    inboxWatcher = require("node:fs").watch(INBOX_DIR, { persistent: false }, () => {
      // Don't trust the filename arg — just rescan all .jsonl files.
      scanInboxOnce();
    });
    console.error(`[master] inbox watcher+poll armed at ${INBOX_DIR}`);
  } catch (err) {
    console.error(`[master] inbox fs.watch failed (${(err as Error).message}) — relying on 2s poll`);
  }

  console.error(
    `[master] agent ready — supervisor=${supervisorCfg.provider}/${supervisorCfg.model}, tools=${tools.length}, transcript=${agent.state.messages.length} msgs`,
  );

  logDecision({
    project: "_master",
    action: "boot",
    rationale: `daemon started — ${tools.length} tools, ${policy.projects.length} projects in portfolio, supervisor=${supervisorCfg.provider}/${supervisorCfg.model}`,
  });

  let stopped = false;
  let promptInFlight = false;

  // Errors that mean "the call didn't go through, try again" — not "the model
  // refused / produced bad output". LM Studio evicts idle models under memory
  // pressure; the next call auto-loads them, but the call that hit eviction
  // returns "Model unloaded.". Network blips fall in the same bucket.
  const TRANSIENT_ERROR_PATTERNS = [
    /model unloaded/i,
    /econnreset/i,
    /econnrefused/i,
    /ehostunreach/i,
    /etimedout/i,
    /fetch failed/i,
    /socket hang up/i,
  ];

  function lastStopReason(): { stop?: string; err?: string } {
    const msgs = agent.state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string; stopReason?: string; errorMessage?: string };
      if (m.role === "assistant") return { stop: m.stopReason, err: m.errorMessage };
    }
    return {};
  }

  function isTransient(errMsg: string | undefined): boolean {
    if (!errMsg) return false;
    return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(errMsg));
  }

  // Single funnel for any inbound message: user chat from dashboard, Telegram,
  // or synthetic watchdog prompts. Serializes calls (one prompt at a time)
  // because pi-agent-core doesn't support concurrent runs on the same agent.
  async function dispatchToAgent(
    text: string,
    source: "chat" | "telegram" | "watchdog",
  ): Promise<{ ok: boolean; error?: string }> {
    if (stopped) return { ok: false, error: "daemon shutting down" };
    if (promptInFlight) return { ok: false, error: "agent busy with prior prompt" };
    promptInFlight = true;
    try {
      broadcast("inbound", { source, text, ts: new Date().toISOString() });
      await agent.prompt(text);
      let { stop, err } = lastStopReason();
      if (stop === "error" && isTransient(err) && !stopped) {
        console.error(`[master] transient error "${err}" (source=${source}), retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        await agent.prompt(text);
        ({ stop, err } = lastStopReason());
      }
      if (stop === "error") {
        logDecision({
          project: "_master",
          action: `prompt_error_${source}`,
          rationale: err ?? "unknown",
        });
        return { ok: false, error: err ?? "unknown error" };
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logDecision({
        project: "_master",
        action: `prompt_failed_${source}`,
        rationale: msg,
      });
      return { ok: false, error: msg };
    } finally {
      promptInFlight = false;
    }
  }

  // ── HTTP server: chat in, events out ───────────────────────────────────
  const masterPort = Number(process.env.SUBCTL_MASTER_PORT ?? 8788);
  // Default 127.0.0.1 — master is the brain; the dashboard server proxies
  // public traffic. Keeps the agent off the open LAN by default.
  const masterHost = process.env.SUBCTL_MASTER_HOST ?? "127.0.0.1";

  const httpServer = Bun.serve({
    port: masterPort,
    hostname: masterHost,
    // SSE connections are long-lived. Default 10s idleTimeout drops them
    // and the dashboard chat panel would lose its event stream every 10s
    // when there's no agent activity to send. Disable.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          version: "0.1.0",
          uptime_s: Math.floor(process.uptime()),
          transcript_msgs: agent.state.messages.length,
          subscribers: sseClients.size,
          prompt_in_flight: promptInFlight,
          teams_tracked: teamLastActivity.size,
        });
      }

      if (url.pathname === "/teams" && req.method === "GET") {
        const now = Date.now();
        const teams = Array.from(teamLastActivity.entries()).map(([name, v]) => ({
          name,
          last_activity_seconds_ago: Math.floor((now - v.ts) / 1000),
          last_event: v.lastEvent ?? null,
        }));
        return Response.json({ ok: true, teams });
      }

      if (url.pathname === "/chat" && req.method === "POST") {
        let body: { text?: string; source?: "chat" | "telegram" | "watchdog" };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const text = (body.text ?? "").trim();
        const source = body.source ?? "chat";
        if (!text) return Response.json({ ok: false, error: "empty text" }, { status: 400 });
        // Fire and forget — caller subscribes to /events to watch the response stream.
        void dispatchToAgent(text, source);
        return Response.json({ ok: true, source, accepted_at: new Date().toISOString() }, { status: 202 });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        // Per-connection state captured in closure scope so BOTH start() and
        // cancel() can reach it. (Earlier version stashed cleanup on the
        // controller, but ReadableStream.cancel() runs with `this` bound to
        // the source object — not the controller — so the cleanup never
        // fired and disconnected clients accumulated in sseClients forever.
        // Verified by `/health.subscribers` climbing to 69 on a fresh
        // daemon with one tab refreshed a few times.)
        let client: { write: (data: string) => void } | null = null;
        let keepAlive: ReturnType<typeof setInterval> | null = null;
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
          if (client) { sseClients.delete(client); client = null; }
        };
        // Browser tab close fires AbortSignal on req.signal — wire that to
        // cleanup so we don't depend solely on ReadableStream.cancel().
        req.signal?.addEventListener("abort", cleanup);

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            client = {
              write: (data: string) => {
                try {
                  controller.enqueue(encoder.encode(data));
                } catch {
                  // controller closed (client gone) — prune ourselves
                  cleanup();
                }
              },
            };
            sseClients.add(client);
            client.write(`event: connected\ndata: ${JSON.stringify({
              ts: new Date().toISOString(),
              transcript_msgs: agent.state.messages.length,
            })}\n\n`);
            const lastAssistant = [...agent.state.messages].reverse().find(
              (m: any) => m.role === "assistant",
            );
            if (lastAssistant) {
              client.write(`event: snapshot_last\ndata: ${JSON.stringify(lastAssistant)}\n\n`);
            }
            keepAlive = setInterval(() => {
              if (client) client.write(`: keep-alive ${Date.now()}\n\n`);
            }, 25_000);
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.error(`[master] http listening on http://${masterHost}:${httpServer.port} — POST /chat, GET /events, GET /health`);

  // ── watchdog ticker ────────────────────────────────────────────────────
  // Master's KPI is "keep projects moving forward". Periodically scan open
  // dev teams + tracked projects; if anything looks stuck (no lead report
  // recently, no git activity, etc.), synthesize a prompt so the agent can
  // decide what to do — ping the lead, escalate to Jason, take corrective
  // action. The actual scan logic gets richer as dev teams come online.
  const watchdogIntervalMin = Math.max(
    1,
    policy.global_defaults.review_interval_minutes ?? 5,
  );
  const watchdogIntervalMs = watchdogIntervalMin * 60 * 1000;
  const stalenessThresholdMin =
    policy.global_defaults.stall_detection_minutes ?? 60;

  async function runWatchdogTick() {
    if (stopped || promptInFlight) return;
    // Use the in-memory teamLastActivity map (populated by the inbox tailer)
    // rather than re-stat'ing files every tick. Teams that have NEVER reported
    // are also stale candidates — we know they exist if the inbox file exists.
    const now = Date.now();
    const stale: Array<{ team: string; lastSeenMin: number; lastEventType?: string }> = [];
    for (const [team, v] of teamLastActivity) {
      const ageMin = (now - v.ts) / 60_000;
      if (ageMin > stalenessThresholdMin) {
        stale.push({
          team,
          lastSeenMin: Math.round(ageMin),
          lastEventType: v.lastEvent?.type,
        });
      }
    }
    if (stale.length === 0) {
      broadcast("watchdog_ok", {
        ts: new Date().toISOString(),
        teams_tracked: teamLastActivity.size,
        stale: 0,
      });
      return;
    }
    const summary = stale
      .map((s) => `${s.team} (${s.lastSeenMin}min ago${s.lastEventType ? `, last=${s.lastEventType}` : ""})`)
      .join(", ");
    const synthPrompt = `[watchdog] ${stale.length} dev team(s) appear stale: ${summary}. Decide whether to ping the lead via subctl_orch_msg, escalate to Jason via telegram_send, or take corrective action.`;
    broadcast("watchdog_fire", { ts: new Date().toISOString(), stale, prompt: synthPrompt });
    await dispatchToAgent(synthPrompt, "watchdog");
  }

  const watchdog = setInterval(() => void runWatchdogTick(), watchdogIntervalMs);
  console.error(
    `[master] watchdog armed — interval=${watchdogIntervalMin}m, staleness_threshold=${stalenessThresholdMin}m`,
  );

  // ── graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.error(`[master] caught ${signal}, shutting down`);
    clearInterval(watchdog);
    clearInterval(inboxPoll);
    if (inboxWatcher) try { inboxWatcher.close(); } catch { /* ignore */ }
    httpServer.stop(true);
    agent.abort();
    try {
      saveAgentTranscript(agent.state.messages);
    } catch (err) {
      console.error(
        `[master] WARN transcript flush on shutdown failed: ${(err as Error).message}`,
      );
    }
    logDecision({
      project: "_master",
      action: "shutdown",
      rationale: `signal=${signal}`,
    });
    agent
      .waitForIdle()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[master] fatal:`, err);
  process.exit(1);
});
