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
import { systemTools } from "./tools/system";
import { projectTools } from "./tools/project";
import { memoryTools } from "./tools/memory";
import { context7Tools } from "./tools/context7";
import { tier1MemoryTools, buildMemoryBlock } from "./tools/tier1-memory";
import { skillAuthorTools } from "./tools/skill-author";
import { notifyTools, bindNotifyBroadcast } from "./tools/notify";
import { specforgeTools } from "./tools/specforge";
import {
  startMasterNotifyListener,
  stopMasterNotifyListener,
  masterNotifyListenerStatus,
} from "./master-notify-listener";

const HOME = homedir();
const COMPONENT_DIR = import.meta.dir;
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const MASTER_STATE_DIR = join(SUBCTL_CONFIG_DIR, "master");
const MASTER_LOG = join(HOME, "Library", "Logs", "subctl", "master.log");

// Single source of truth: VERSION file at repo root. lib/core.sh reads the
// same file so bash + dashboard + master daemon all agree on the version.
const SUBCTL_VERSION = (() => {
  try {
    return readFileSync(join(COMPONENT_DIR, "..", "..", "VERSION"), "utf8")
      .trim();
  } catch {
    return "0.0.0-dev";
  }
})();

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
          version: SUBCTL_VERSION,
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
  models: Record<string, {
    provider: string;
    model: string;
    host?: string;
    // Optional per-role load-time context window (tokens). When the
    // provider is "lmstudio", master calls POST /api/v1/models/load on
    // boot + on switch to force the model to be loaded with this exact
    // context. Defaults: supervisor 65536, reviewer 32768, router 8192,
    // embeddings keeps whatever LM Studio chose. Set explicitly per
    // role in providers.json to override.
    context_length?: number;
  }>;
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
  ...Object.fromEntries(
    Object.entries(systemTools).map(([k, v]) => [
      `system_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(projectTools).map(([k, v]) => [
      k, // already prefixed (project_create, vault_append)
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(memoryTools).map(([k, v]) => [
      k, // already prefixed (memory_search, memory_timeline, etc.)
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(context7Tools).map(([k, v]) => [
      k, // already prefixed (context7_resolve, context7_docs, context7_health)
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(tier1MemoryTools).map(([k, v]) => [
      k, // already prefixed (memory_show, memory_remember, memory_forget, memory_user_update)
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(skillAuthorTools).map(([k, v]) => [
      k, // already prefixed (skill_create, skill_revise, skill_remove, skill_list_master)
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(notifyTools).map(([k, v]) => [
      k, // notify_dashboard
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(specforgeTools).map(([k, v]) => [
      k, // specforge
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
  max_tokens?: number;
}): Model<string> {
  const api = PROVIDER_API[cfg.provider] ?? "openai-completions";
  // Reasoning models (qwen3.x, deepseek-r1, glm-flash, etc.) consume tokens
  // inside <think> blocks BEFORE producing the user-visible answer or a
  // tool call. 4K maxTokens is the trap: the model burns it all reasoning
  // and stopReason="length" with empty content. 16K is a safer ceiling for
  // local reasoning models; cloud providers can override per-role via
  // providers.json's optional `max_tokens` field.
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
    maxTokens: cfg.max_tokens ?? 16_384,
  };
}

// ─── LM Studio model lifecycle ────────────────────────────────────────
//
// Force-load an LM Studio model with an exact context window via the
// native /api/v1/models/load endpoint. The CLI flag (lms load
// --context-length N) and the UI per-model defaults both work, but the
// REST endpoint is the most reliable for daemon use — explicit, no
// shell-out, no race with operator UI changes.
//
// We call this at master boot for `supervisor` and `reviewer` roles
// (any role with a configured context_length), and again on supervisor
// switch via the dashboard's /api/master/supervisor endpoint. Solves
// the recurring 4K JIT trap where LM Studio quietly evicts the model
// under memory pressure and reloads it at default 4K — master then
// silently truncates everything past that.
const ROLE_DEFAULT_CONTEXT: Record<string, number> = {
  supervisor: 65536,
  reviewer: 32768,
  router: 8192,
  embeddings: 0, // 0 = don't enforce; LM Studio's default is fine
};

async function ensureModelLoaded(cfg: { provider: string; model: string; host?: string; context_length?: number }, role: string): Promise<{ ok: boolean; detail: string }> {
  if (cfg.provider !== "lmstudio") {
    return { ok: true, detail: `${role} is ${cfg.provider} (cloud) — no local load needed` };
  }
  const desired = cfg.context_length ?? ROLE_DEFAULT_CONTEXT[role] ?? 0;
  if (!desired) return { ok: true, detail: `${role} context_length=0; not enforcing` };
  const apiBase = (cfg.host ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
  // 1. Check current load state — skip the reload if it's already where we want it.
  try {
    const r = await fetch(`${apiBase}/api/v0/models`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const j = (await r.json()) as { data?: Array<{ id: string; state?: string; loaded_context_length?: number }> };
      const current = (j.data ?? []).find((m) => m.id === cfg.model);
      if (current?.state === "loaded" && current.loaded_context_length === desired) {
        return { ok: true, detail: `${role}=${cfg.model} already loaded with ctx ${desired.toLocaleString()}` };
      }
    }
  } catch { /* fall through to reload */ }
  // 2. Unload first (safe reload pattern).
  try {
    await fetch(`${apiBase}/api/v1/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* unload failures are non-fatal — load below will replace */ }
  // 3. Load with explicit context_length.
  try {
    const r = await fetch(`${apiBase}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        context_length: desired,
        flash_attention: true,
        echo_load_config: true,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, detail: `load HTTP ${r.status}: ${text.slice(0, 300)}` };
    }
    const j = await r.json() as { load_config?: { context_length?: number } };
    const got = j.load_config?.context_length;
    return { ok: true, detail: `${role}=${cfg.model} loaded with ctx ${(got ?? desired).toLocaleString()}` };
  } catch (err) {
    return { ok: false, detail: `load error: ${(err as Error).message}` };
  }
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
  console.error(`[master] booting subctl master v${SUBCTL_VERSION}`);

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

  // Pre-flight: ensure LM Studio has the supervisor (and reviewer if
  // configured) loaded with the right context window. Protects against
  // the recurring 4K JIT trap. Non-blocking — if LM Studio is offline
  // the agent boots anyway; first user message will fail loudly.
  for (const role of ["supervisor", "reviewer"] as const) {
    const cfg = providers.models[role];
    if (!cfg) continue;
    const result = await ensureModelLoaded(cfg, role);
    console.error(`[master] ${result.ok ? "ctx-pin" : "ctx-pin FAILED"} ${role}: ${result.detail}`);
  }

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

  // Compose the initial system prompt: master persona + tier-1 memory
  // (user profile + learned facts). Both memory files are re-read on
  // every dispatchToAgent call below, so writes from operator OR master
  // tools land in the next turn without restart.
  function composeSystemPrompt(): string {
    const memBlock = buildMemoryBlock();
    return memBlock + skill;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(),
      model: supervisorModel,
      tools,
      messages: loadAgentTranscript(),
    },
    sessionId: `subctl-master-${Date.now()}`,
    getApiKey,
  });

  // ── shared lifecycle flags (declared early so the inbox tailer below
  //     can reference dispatchToAgent which checks `stopped`) ─────────────
  let stopped = false;
  let promptInFlight = false;

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
  // Let the notify tool publish to the SSE bus via the same broadcast.
  bindNotifyBroadcast(broadcast);

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

  // First scan after boot just establishes the read offset to "end of file"
  // — events that already exist when the daemon starts are HISTORICAL, not
  // new. Without this, every boot replays old "blocked"/"error" events as
  // fresh agent prompts and the master reacts to ghosts.
  let firstScanDone = false;

  function tailInboxFile(filePath: string) {
    let stat;
    try {
      stat = require("node:fs").statSync(filePath);
    } catch {
      return;
    }
    const team = teamNameFromPath(filePath);
    let prev = teamReadOffsets.get(filePath);
    if (prev === undefined) {
      // Never seen this file. On first scan after boot, jump to end so
      // pre-existing content doesn't replay as live events. Subsequent
      // discoveries (a new team file appearing while running) start at 0
      // since those events ARE live for us.
      prev = firstScanDone ? 0 : stat.size;
      teamReadOffsets.set(filePath, prev);
      // Still backfill last_event metadata from the existing file so /teams
      // and the dashboard show real state right after boot.
      if (!firstScanDone && stat.size > 0) {
        try {
          const raw = require("node:fs").readFileSync(filePath, "utf8") as string;
          const lines = raw.trimEnd().split("\n").filter((l) => l.trim());
          if (lines.length) {
            try {
              const lastEv = JSON.parse(lines[lines.length - 1]) as TeamEvent;
              teamLastActivity.set(team, { ts: stat.mtimeMs, lastEvent: lastEv });
            } catch { /* ignore parse errors */ }
          }
        } catch { /* ignore */ }
      }
    }
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

  // (`stopped` and `promptInFlight` declared earlier in this function)

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
  // or synthetic watchdog prompts. Serializes calls (pi-agent-core doesn't
  // support concurrent runs on the same agent), but QUEUES instead of
  // dropping when busy. Earlier behavior dropped messages 2..N when the
  // first was still processing — Telegram bursts vanished silently.
  type PendingPrompt = { text: string; source: "chat" | "telegram" | "watchdog" };
  const promptQueue: PendingPrompt[] = [];

  async function processOnePrompt(p: PendingPrompt): Promise<{ ok: boolean; error?: string }> {
    try {
      // Refresh the system prompt with current tier-1 memory before every
      // prompt. Both memory.md and user.md are re-read fresh — operator
      // edits via the dashboard Memory tab AND master's own memory_*
      // tool writes both flow into the next turn without restart.
      try {
        (agent.state as any).systemPrompt = composeSystemPrompt();
      } catch { /* if pi-agent-core ever locks state.systemPrompt, we'll see it loud */ }
      broadcast("inbound", { source: p.source, text: p.text, ts: new Date().toISOString() });
      await agent.prompt(p.text);
      let { stop, err } = lastStopReason();
      if (stop === "error" && isTransient(err) && !stopped) {
        console.error(`[master] transient error "${err}" (source=${p.source}), retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        await agent.prompt(p.text);
        ({ stop, err } = lastStopReason());
      }
      if (stop === "error") {
        logDecision({
          project: "_master",
          action: `prompt_error_${p.source}`,
          rationale: err ?? "unknown",
        });
        return { ok: false, error: err ?? "unknown error" };
      }
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logDecision({
        project: "_master",
        action: `prompt_failed_${p.source}`,
        rationale: msg,
      });
      return { ok: false, error: msg };
    }
  }

  async function dispatchToAgent(
    text: string,
    source: "chat" | "telegram" | "watchdog",
  ): Promise<{ ok: boolean; error?: string }> {
    if (stopped) return { ok: false, error: "daemon shutting down" };
    promptQueue.push({ text, source });
    broadcast("queued", { source, queue_depth: promptQueue.length, ts: new Date().toISOString() });
    if (promptInFlight) {
      // Will be drained by the in-flight processor's loop.
      return { ok: true, error: undefined };
    }
    promptInFlight = true;
    let lastResult: { ok: boolean; error?: string } = { ok: true };
    try {
      while (promptQueue.length > 0 && !stopped) {
        const next = promptQueue.shift()!;
        lastResult = await processOnePrompt(next);
      }
    } finally {
      promptInFlight = false;
    }
    return lastResult;
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
          version: SUBCTL_VERSION,
          uptime_s: Math.floor(process.uptime()),
          transcript_msgs: agent.state.messages.length,
          subscribers: sseClients.size,
          prompt_in_flight: promptInFlight,
          teams_tracked: teamLastActivity.size,
          telegram_listener: masterNotifyListenerStatus(),
        });
      }

      // /transcript — return the persisted transcript so the dashboard can
      // rehydrate the chat log on page load. Optional ?limit=N (default 100).
      if (url.pathname === "/transcript" && req.method === "GET") {
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "100")));
        const all = agent.state.messages as Array<Record<string, unknown>>;
        return Response.json({
          ok: true,
          total: all.length,
          returned: Math.min(limit, all.length),
          messages: all.slice(-limit),
        });
      }

      // /context — token + context-window stats. Approximates token count
      // via char-count / 4 (good enough for a UX indicator). Reads the
      // current LM Studio loaded_context_length per supervisor model.
      if (url.pathname === "/context" && req.method === "GET") {
        const messages = agent.state.messages as Array<Record<string, unknown>>;
        let chars = 0;
        for (const m of messages) {
          const content = m.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block.text === "string") chars += block.text.length;
              if (typeof block.thinking === "string") chars += (block.thinking as string).length;
              if (typeof block.arguments === "object") chars += JSON.stringify(block.arguments).length;
            }
          }
        }
        const estimatedTokens = Math.round(chars / 4);
        // Also factor in the system prompt + tool schemas overhead — these
        // sit in every prompt window. Approximate as 2500 tokens for
        // SKILL.md + 24-tool schema bundle. Empirical from prior /v1/chat/completions logs.
        const fixedOverheadTokens = 2500;
        // Get loaded context window from LM Studio. Earlier version used
        // a /v1/../api/v0 string-replace that quietly failed when the
        // host string didn't end in /v1; just strip /v1 cleanly.
        let loadedContext: number | null = null;
        try {
          const host = (supervisorCfg.host ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
          const r = await fetch(`${host}/api/v0/models`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) {
            const j = (await r.json()) as { data?: Array<{ id: string; loaded_context_length?: number }> };
            const found = (j.data ?? []).find((m) => m.id === supervisorCfg.model);
            if (found?.loaded_context_length) loadedContext = found.loaded_context_length;
          }
        } catch { /* ignore */ }
        const total = estimatedTokens + fixedOverheadTokens;
        return Response.json({
          ok: true,
          transcript_msgs: messages.length,
          transcript_chars: chars,
          estimated_transcript_tokens: estimatedTokens,
          fixed_overhead_tokens: fixedOverheadTokens,
          estimated_total_tokens: total,
          loaded_context_length: loadedContext,
          utilization_pct: loadedContext ? Math.round((total / loadedContext) * 100) : null,
          supervisor: `${supervisorCfg.provider}/${supervisorCfg.model}`,
        });
      }

      // /transcript/compact — summarize older turns into a single message,
      // archive the originals, and keep only the last K turns + the
      // summary as the new transcript. Body accepts:
      //   target_tokens?: number  — try to compact down to this many
      //                              estimated transcript tokens
      //                              (default 50000, matches Jason's 73K
      //                              loaded ctx with 23K headroom)
      //   keep_recent?: number    — minimum recent turns to preserve
      //                              (default 6)
      // Algorithm: start with keep_recent, then expand the "compact" set
      // backwards until estimated remaining tokens fits target_tokens.
      if (url.pathname === "/transcript/compact" && req.method === "POST") {
        if (promptInFlight) {
          return Response.json({ ok: false, error: "agent busy — try again in a moment" }, { status: 409 });
        }
        let body: { target_tokens?: number; keep_recent?: number } = {};
        try { body = await req.json(); } catch { /* empty body is fine */ }
        const TARGET_TOKENS = Math.max(2000, Math.min(200_000, body.target_tokens ?? 50_000));
        const KEEP_RECENT = Math.max(2, Math.min(40, body.keep_recent ?? 6));
        try {
          const messages = agent.state.messages as Array<Record<string, unknown>>;
          if (messages.length < KEEP_RECENT + 2) {
            // Not an error — nothing to do. Return ok:true with a noop flag
            // so the UI can show a friendly "no compaction needed" notice
            // instead of a red error.
            return Response.json({
              ok: true,
              noop: true,
              message: `Nothing to compact — transcript only has ${messages.length} messages (last ${KEEP_RECENT} are always kept). Compaction kicks in automatically when the transcript grows past about ${KEEP_RECENT + 2} turns.`,
              transcript_msgs: messages.length,
            });
          }
          // Token estimator: chars/4 — same heuristic as /context.
          const tokenize = (m: Record<string, unknown>): number => {
            const content = (m.content as Array<Record<string, unknown>>) ?? [];
            let chars = 0;
            for (const b of content) {
              if (typeof b.text === "string") chars += b.text.length;
              if (typeof b.thinking === "string") chars += (b.thinking as string).length;
              if (typeof b.arguments === "object") chars += JSON.stringify(b.arguments).length;
            }
            return Math.ceil(chars / 4);
          };
          // Expand the compact set backwards from KEEP_RECENT until we fit.
          let keepN = KEEP_RECENT;
          let recent = messages.slice(-keepN);
          let recentTokens = recent.reduce((acc, m) => acc + tokenize(m), 0);
          while (recentTokens > TARGET_TOKENS && keepN > 2) {
            keepN--;
            recent = messages.slice(-keepN);
            recentTokens = recent.reduce((acc, m) => acc + tokenize(m), 0);
          }
          const toCompact = messages.slice(0, -keepN);

          // Naive deterministic compaction: extract just user texts +
          // last assistant text in each older turn, plus any tool names
          // called. No LLM round-trip required, which means the compact
          // works even when the model is broken / unreachable.
          const userTexts: string[] = [];
          const lastAssistantText: string[] = [];
          const toolsCalled: Set<string> = new Set();
          for (const m of toCompact) {
            const role = m.role as string;
            const content = (m.content as Array<Record<string, unknown>>) ?? [];
            if (role === "user") {
              const txt = content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
              if (txt && !txt.startsWith("[watchdog]") && !txt.startsWith("[team-report]")) userTexts.push(txt.slice(0, 240));
            } else if (role === "assistant") {
              const txt = content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
              if (txt) lastAssistantText.push(txt.slice(0, 240));
              for (const b of content) {
                if (b.type === "toolCall" && b.name) toolsCalled.add(b.name as string);
              }
            }
          }

          const summary =
            `[transcript compaction · ${toCompact.length} prior messages compacted into this summary on ${new Date().toISOString()}]\n\n` +
            `User said:\n` + userTexts.slice(-12).map((t) => "  · " + t).join("\n") + "\n\n" +
            `You replied (highlights):\n` + lastAssistantText.slice(-8).map((t) => "  · " + t).join("\n") + "\n\n" +
            `Tools you used during this period: ${Array.from(toolsCalled).join(", ") || "(none)"}\n\n` +
            `(Original messages archived to disk; resume the conversation from here.)`;

          // Archive the original transcript with a timestamp suffix
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const archivePath = AGENT_STATE_PATH.replace(/\.json$/, `.archive-compact-${ts}.json`);
          if (existsSync(AGENT_STATE_PATH)) {
            const { copyFileSync } = require("node:fs") as typeof import("node:fs");
            copyFileSync(AGENT_STATE_PATH, archivePath);
          }

          // Replace agent.state.messages in place: a single user message
          // carrying the summary, then the last KEEP_RECENT turns intact.
          agent.state.messages.length = 0;
          agent.state.messages.push({
            role: "user",
            content: [{ type: "text", text: summary }],
            timestamp: Date.now(),
          } as any);
          for (const m of recent) agent.state.messages.push(m as any);
          // Persist
          saveAgentTranscript(agent.state.messages);
          broadcast("transcript_compacted", {
            ts: new Date().toISOString(),
            archived_count: toCompact.length,
            kept: recent.length + 1,
            archive_path: archivePath,
          });
          logDecision({
            project: "_master",
            action: "transcript_compacted",
            rationale: `compacted ${toCompact.length} msgs, kept last ${recent.length}`,
          });
          return Response.json({
            ok: true,
            archived_count: toCompact.length,
            kept_msgs: recent.length + 1,
            archive_path: archivePath,
          });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }

      // /transcript/clear — archive the transcript and start fresh.
      if (url.pathname === "/transcript/clear" && req.method === "POST") {
        try {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          const archivePath = AGENT_STATE_PATH.replace(/\.json$/, `.archive-${ts}.json`);
          if (existsSync(AGENT_STATE_PATH)) {
            const { renameSync } = require("node:fs") as typeof import("node:fs");
            renameSync(AGENT_STATE_PATH, archivePath);
          }
          // Reset in-memory transcript
          agent.state.messages.length = 0;
          broadcast("transcript_cleared", { ts: new Date().toISOString(), archive: archivePath });
          logDecision({
            project: "_master",
            action: "transcript_cleared",
            rationale: "operator clicked New Chat",
          });
          return Response.json({ ok: true, archive: archivePath });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }

      // /reload-supervisor — force a fresh /api/v1/models/load on
      // LM Studio for the supervisor (and reviewer) roles. Use this if
      // LM Studio drifted or you bumped context_length in providers.json.
      // Body: {role?: "supervisor"|"reviewer"|"all"} — default "all".
      if (url.pathname === "/reload-supervisor" && req.method === "POST") {
        let body: { role?: string } = {};
        try { body = await req.json(); } catch { /* empty body OK */ }
        const target = body.role ?? "all";
        const roles = target === "all" ? ["supervisor", "reviewer"] : [target];
        const results: Array<{ role: string; ok: boolean; detail: string }> = [];
        for (const role of roles) {
          const cfg = providers.models[role];
          if (!cfg) {
            results.push({ role, ok: false, detail: "no such role in providers.json" });
            continue;
          }
          const r = await ensureModelLoaded(cfg, role);
          results.push({ role, ...r });
        }
        return Response.json({ ok: results.every((r) => r.ok), results });
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

      if (url.pathname === "/diag" && req.method === "GET") {
        // Fan out connectivity + readiness checks in parallel. Each check
        // returns {name, ok, detail} — UI renders a green/red row per check.
        const checks = await Promise.all([
          // 1. LM Studio reachability + supervisor model present
          (async () => {
            const host = supervisorCfg.host ?? "http://localhost:1234/v1";
            try {
              const r = await fetch(`${host.replace(/\/$/, "")}/models`, {
                signal: AbortSignal.timeout(2000),
              });
              if (!r.ok) return { name: "lmstudio", ok: false, detail: `HTTP ${r.status}` };
              const j = (await r.json()) as { data?: Array<{ id: string }> };
              const ids = (j.data ?? []).map((m) => m.id);
              const found = ids.includes(supervisorCfg.model);
              return {
                name: "lmstudio",
                ok: true,
                detail: `${ids.length} models loaded${found ? `, supervisor "${supervisorCfg.model}" present` : `, supervisor "${supervisorCfg.model}" NOT loaded (will JIT-load on first call)`}`,
              };
            } catch (err) {
              return { name: "lmstudio", ok: false, detail: (err as Error).message };
            }
          })(),
          // 2. Telegram bot reachable + listener actively polling
          (async () => {
            try {
              const notifyPath = join(SUBCTL_CONFIG_DIR, "master-notify.json");
              if (!existsSync(notifyPath)) {
                return { name: "telegram", ok: false, detail: "master-notify.json missing" };
              }
              const cfg = JSON.parse(readFileSync(notifyPath, "utf8")) as {
                bot_token?: string;
                telegram_bot_token?: string;
              };
              const token = cfg.bot_token ?? cfg.telegram_bot_token;
              if (!token) {
                return {
                  name: "telegram",
                  ok: false,
                  detail: "no bot_token (or telegram_bot_token) in master-notify.json",
                };
              }
              const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
                signal: AbortSignal.timeout(3000),
              });
              if (!r.ok) return { name: "telegram", ok: false, detail: `getMe HTTP ${r.status}` };
              const j = (await r.json()) as { ok: boolean; result?: { username?: string } };
              if (!j.ok) {
                return { name: "telegram", ok: false, detail: "getMe returned not-ok" };
              }
              const ls = masterNotifyListenerStatus();
              const listenerNote = ls.running
                ? `listener polling (offset=${ls.offset}, queue=${ls.queue_size})`
                : `LISTENER NOT RUNNING — incoming Telegram messages won't reach the agent`;
              return {
                name: "telegram",
                ok: !!j.ok && ls.running,
                detail: `bot @${j.result?.username ?? "?"} reachable, ${listenerNote}`,
              };
            } catch (err) {
              return { name: "telegram", ok: false, detail: (err as Error).message };
            }
          })(),
          // 3. coderabbit CLI installed
          (async () => {
            try {
              const proc = Bun.spawnSync(["coderabbit", "--version"], {
                stdout: "pipe",
                stderr: "pipe",
              });
              if (proc.exitCode === 0) {
                const out = proc.stdout.toString().trim();
                return { name: "coderabbit", ok: true, detail: out || "CLI on PATH" };
              }
              return {
                name: "coderabbit",
                ok: false,
                detail: `exit=${proc.exitCode}: ${proc.stderr.toString().slice(0, 120)}`,
              };
            } catch (err) {
              return { name: "coderabbit", ok: false, detail: `not on PATH: ${(err as Error).message}` };
            }
          })(),
          // 4. gh (GitHub CLI) installed + authed
          (async () => {
            try {
              const proc = Bun.spawnSync(["gh", "auth", "status"], {
                stdout: "pipe",
                stderr: "pipe",
              });
              const combined = proc.stdout.toString() + proc.stderr.toString();
              if (proc.exitCode === 0) {
                const m = combined.match(/Logged in to .* as ([^\s]+)/);
                return { name: "gh", ok: true, detail: m ? `authed as ${m[1]}` : "authed" };
              }
              return { name: "gh", ok: false, detail: combined.slice(0, 160).trim() || `exit=${proc.exitCode}` };
            } catch (err) {
              return { name: "gh", ok: false, detail: `not on PATH: ${(err as Error).message}` };
            }
          })(),
          // 5. tmux installed (needed to spawn dev teams)
          (async () => {
            try {
              const proc = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
              if (proc.exitCode === 0) {
                return { name: "tmux", ok: true, detail: proc.stdout.toString().trim() };
              }
              return { name: "tmux", ok: false, detail: `exit=${proc.exitCode}` };
            } catch (err) {
              return { name: "tmux", ok: false, detail: `not on PATH: ${(err as Error).message}` };
            }
          })(),
          // 6. docker — required for dev-team work that spins up containers
          // (FOOTHOLD's dockerode bridge, future per-level images, etc.).
          // Two failure modes: binary missing, or daemon not running.
          // Distinguish them so the install hint is actionable.
          (async () => {
            try {
              const versionProc = Bun.spawnSync(["docker", "--version"], { stdout: "pipe", stderr: "pipe" });
              if (versionProc.exitCode !== 0) {
                return {
                  name: "docker",
                  ok: false,
                  detail: "docker binary not on PATH — install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/",
                };
              }
              const versionLine = versionProc.stdout.toString().trim();
              const infoProc = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
                stdout: "pipe",
                stderr: "pipe",
              });
              if (infoProc.exitCode !== 0) {
                return {
                  name: "docker",
                  ok: false,
                  detail: `${versionLine} — daemon not responding (start Docker Desktop: \`open -a Docker\`)`,
                };
              }
              const serverVer = infoProc.stdout.toString().trim();
              return {
                name: "docker",
                ok: true,
                detail: `${versionLine}, daemon ${serverVer}`,
              };
            } catch (err) {
              return {
                name: "docker",
                ok: false,
                detail: `not on PATH: ${(err as Error).message}`,
              };
            }
          })(),
        ]);

        return Response.json({
          ok: checks.every((c) => c.ok),
          ts: new Date().toISOString(),
          version: SUBCTL_VERSION,
          uptime_s: Math.floor(process.uptime()),
          tools_loaded: tools.length,
          transcript_msgs: agent.state.messages.length,
          subscribers: sseClients.size,
          teams_tracked: teamLastActivity.size,
          supervisor: `${supervisorCfg.provider}/${supervisorCfg.model}`,
          checks,
        });
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

  // ── Telegram poll loop (master-notify-listener) ────────────────────────
  // Each operator message arrives via the listener's onOperatorMessage
  // callback; we feed it into the same dispatchToAgent funnel that handles
  // dashboard-chat and watchdog-synthesized prompts. Source="telegram" so
  // the SSE stream + decision log can distinguish channels.
  const listenerResult = startMasterNotifyListener({
    onOperatorMessage: (msg) => {
      console.error(`[master] telegram inbound from ${msg.from_name ?? "?"}: ${msg.text.slice(0, 80)}`);
      void dispatchToAgent(msg.text, "telegram");
    },
  });
  if (listenerResult.running) {
    console.error(`[master] telegram listener armed`);
  } else {
    console.error(`[master] telegram listener NOT armed: ${listenerResult.reason}`);
  }

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

  // ── auto-compact watchdog ──────────────────────────────────────────────
  // The supervisor model has a finite loaded context window in LM Studio.
  // Once the transcript+system+tools exceeds ~90% of that window the model
  // starts truncating silently and hallucinates "Standing by" non-answers.
  // Every 5min, query the supervisor's loaded context, compute estimated
  // total tokens, and auto-compact if we're past the threshold. Compact
  // target is configurable via ~/.config/subctl/master/compact.json:
  //   { "auto_compact": true, "threshold_pct": 90, "target_tokens": 50000, "keep_recent": 6 }
  let autoCompactInFlight = false;
  async function runAutoCompactTick() {
    if (stopped || autoCompactInFlight || promptInFlight) return;
    let cfg = { auto_compact: true, threshold_pct: 90, target_tokens: 50_000, keep_recent: 6 };
    try {
      const cfgPath = join(MASTER_STATE_DIR, "compact.json");
      if (existsSync(cfgPath)) {
        cfg = { ...cfg, ...JSON.parse(readFileSync(cfgPath, "utf8")) };
      }
    } catch { /* use defaults */ }
    if (!cfg.auto_compact) return;
    // Fetch loaded context length from LM Studio
    let loadedContext: number | null = null;
    try {
      const host = (supervisorCfg.host ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
      const r = await fetch(`${host}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { data?: Array<{ id: string; loaded_context_length?: number }> };
        const found = (j.data ?? []).find((m) => m.id === supervisorCfg.model);
        if (found?.loaded_context_length) loadedContext = found.loaded_context_length;
      }
    } catch { /* skip — local-only check */ }
    if (!loadedContext) return; // can't decide without it (cloud supervisors)
    // Estimate current transcript tokens
    let chars = 0;
    for (const m of agent.state.messages as Array<Record<string, unknown>>) {
      const content = (m.content as Array<Record<string, unknown>>) ?? [];
      for (const b of content) {
        if (typeof b.text === "string") chars += b.text.length;
        if (typeof b.thinking === "string") chars += (b.thinking as string).length;
        if (typeof b.arguments === "object") chars += JSON.stringify(b.arguments).length;
      }
    }
    const estTotal = Math.ceil(chars / 4) + 2500; // 2500 fixed overhead for SKILL + tool schemas
    const utilPct = Math.round((estTotal / loadedContext) * 100);
    if (utilPct < cfg.threshold_pct) return; // below threshold, do nothing
    autoCompactInFlight = true;
    try {
      console.error(`[master] auto-compact: util=${utilPct}% (>= ${cfg.threshold_pct}%) — compacting toward ${cfg.target_tokens.toLocaleString()} tokens`);
      // Reuse the same compaction logic as /transcript/compact via a fetch
      // back to ourselves (clean separation; avoids duplicate code paths).
      const r = await fetch(`http://${masterHost}:${masterPort}/transcript/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_tokens: cfg.target_tokens, keep_recent: cfg.keep_recent }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) {
        console.error(`[master] auto-compact ok — archived ${j.archived_count}, kept ${j.kept_msgs}`);
      } else {
        console.error(`[master] auto-compact failed: ${j.error ?? "unknown"}`);
      }
    } catch (err) {
      console.error(`[master] auto-compact error: ${(err as Error).message}`);
    } finally {
      autoCompactInFlight = false;
    }
  }
  const autoCompactInterval = setInterval(() => void runAutoCompactTick(), 5 * 60 * 1000);
  // Also run shortly after boot so a freshly-restarted daemon catches an
  // already-bloated transcript without waiting 5 minutes.
  setTimeout(() => void runAutoCompactTick(), 30_000);
  console.error("[master] auto-compact watchdog armed — every 5min, fires when transcript exceeds 90% of loaded ctx (configurable via compact.json)");

  // ── graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.error(`[master] caught ${signal}, shutting down`);
    clearInterval(watchdog);
    clearInterval(autoCompactInterval);
    clearInterval(inboxPoll);
    if (inboxWatcher) try { inboxWatcher.close(); } catch { /* ignore */ }
    try { stopMasterNotifyListener(); } catch { /* ignore */ }
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
