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
import { telegramTools, sendTelegramOutbound } from "./tools/telegram";
import { systemTools, bindToolRegistry as bindSystemToolRegistry } from "./tools/system";
import { projectTools } from "./tools/project";
import { memoryTools } from "./tools/memory";
import { context7Tools } from "./tools/context7";
import { tier1MemoryTools, buildMemoryBlock } from "./tools/tier1-memory";
// ── v2.8.1 chat perf / skill router ──
import {
  selectSkills as routerSelectSkills,
  renderSelected as routerRenderSelected,
  isRouterEnabled as routerIsEnabled,
  type RouterDecision,
} from "./skill-router";
import { skillAuthorTools } from "./tools/skill-author";
// ── v2.8.1 skills clarity ──
import {
  evySkillsAuthorTools,
  bindSkillsAuthorBroadcast,
} from "./tools/skills-author";
// ── end v2.8.1 skills clarity ──
import { notifyTools, bindNotifyBroadcast } from "./tools/notify";
import { specforgeTools } from "./tools/specforge";
import { schedulerTools, popDueFollowups } from "./tools/scheduler";
import { attachmentsTools } from "./tools/attachments";
import { vaultLinkTools } from "./tools/vault-link";
import { policyTools } from "./tools/policy";
import { diagTools, bindWatchdogState } from "./tools/diag";
import { webTools } from "./tools/web";
import { tinyfishTools } from "./tools/tinyfish";
import {
  backgroundTools,
  bindBackgroundToolRegistry,
} from "./tools/background";
import { knowledgeGraphTools } from "./tools/knowledge-graph";
import { linearTools } from "./tools/linear";
import { knowledgeTools } from "./tools/knowledge";
import { teamDocsTools } from "./tools/team-docs";
import {
  saveAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
  inlineAttachmentBlocks,
} from "./attachments";
import { extractLastTurn, findGaps, formatCorrectionPrompt } from "./verifier";
import {
  buildPersonalityFragment,
  readActivePreset,
  setPreset as setPersonalityPreset,
  describePresets as describePersonalities,
  ALL_PRESETS as ALL_PERSONALITY_PRESETS,
} from "./personality";
import {
  startMasterNotifyListener,
  stopMasterNotifyListener,
  masterNotifyListenerStatus,
} from "./master-notify-listener";
import { startClusterTicker } from "./tools/policy/verifier-cluster";
import {
  decideCompactAction,
  estimateTranscriptTokens,
  loadCompactConfig,
  type CompactConfig,
  type CompactDecision,
} from "./compact-policy";
import { resolveSecret } from "./secrets";
// ── v2.7.31 secret backends ──
import {
  describeBackendChain,
  testSecret,
  flushOnePasswordCache,
} from "./secrets-backends";
// ── v2.8.7 openai-codex OAuth (ChatGPT Pro subscription) ──
import { getCodexAccessToken } from "./openai-codex-auth";
import {
  loadProfiles,
  setActiveProfile,
  watchProfiles,
  PROFILE_NAMES,
  type ProfileName,
  type ProfilesFile,
} from "./profiles";
import {
  registerWatchdog,
  touchWatchdog,
  listWatchdogs,
  killWatchdog,
  killAllWatchdogs,
} from "./watchdogs";
import { watchdogTools } from "./tools/watchdogs";
import {
  recordToolResult,
  shouldRefuseToolCall,
  synthesizeRefusal,
  resetOnNewTurn as resetCircuitBreakerOnNewTurn,
} from "./circuit-breaker";
import {
  emitNotification,
  listNotifications,
  markRead as markNotificationRead,
  markAllRead as markAllNotificationsRead,
  subscribeNotifications,
  type Notification,
} from "./notifications";
import {
  hydrateFromSidecar as hydrateBackgroundRuns,
  drainPendingForNextTurn as drainBackgroundCompletions,
  formatPrependForOperator as formatBackgroundPrepend,
  _setDepsForTesting as _setBackgroundRunsDeps,
} from "./background-runs";
import {
  health as cogneeHealth,
  resolveCogneeUrl,
} from "./cognee-client";
import {
  health as memoriHealth,
  resolveMemoriUrl,
} from "./memori-client";
import {
  runOneCycle as runMemoryKernelCycle,
  getState as getMemoryKernelState,
  getLastDecisions as getMemoryKernelLastDecisions,
  pause as pauseMemoryKernel,
  resume as resumeMemoryKernel,
  startTicker as startMemoryKernelTicker,
  _setDepsForTesting as _setMemoryKernelDepsForTesting,
} from "./memory-kernel";
import {
  approveCandidate as approveTier1Candidate,
  listPending as listTier1Pending,
  rejectCandidate as rejectTier1Candidate,
} from "./tier1-candidates";
import {
  callSupervisor as memoryKernelSupervisorFetcher,
  reviewEvents as memoryKernelReviewEvents,
} from "./memory-kernel-reviewer";
import {
  runStaleTeamSweep,
  type TeamNudgeState,
  type TeamSnapshot,
} from "./auto-nudge";
import {
  defaultTmuxRunner,
  pruneOneTeam,
  pruneVanishedTeams,
} from "./watchdog-prune";
import {
  recordEntry as recordMemoryEntry,
  recallEntries as recallMemoryEntries,
  deleteEntry as deleteMemoryEntry,
  memoryStats,
  redactEntryForEgress,
  type MemoryEntry,
} from "./memory";
import { evyMemoryTools } from "./tools/evy-memory";
import {
  backfillEvyMemoryToMemori,
  backfillClaudeMemToCognee,
  backfillObsidianToCognee,
} from "./backfill";
import {
  startUpstreamWatchdog,
  describeUpstreamState,
  type UpstreamWatchdogHandle,
} from "./upstream-check";
// ── v2.8.0 voice layer ──
import {
  voiceTools,
  renderVoice,
  resolveCachedAudio,
  probeTtsServer,
} from "./tools/voice-render";
import {
  loadVoiceConfig,
  saveVoiceConfig,
  watchVoiceConfig,
} from "./voice-config";

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

// Dashboard API base for outbound calls FROM master (auto-nudge → /api/orchestration/:name/msg).
// The dashboard owns the tmux paste-buffer + HMAC-signed marker, so the
// auto-nudge path POSTs through the dashboard rather than duplicating that
// logic here. Mirrors components/master/tools/subctl-orch.ts.
const SUBCTL_API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

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

// ─── v2.8.9 Tier-2 lazy tool registration ───────────────────────────────────
//
// From the 2026-05-16 tool-registry audit: 74 of 88 registered tools never
// fired in the operator's live transcript. Most of the dead surface is
// integrations whose backing service the operator hasn't configured (no
// LINEAR_API_KEY → linear_* tools never useful; no CONTEXT7_API_KEY →
// context7_* tools never useful; etc.). Registering these unconditionally
// inflates the prompt prefix by an estimated 6-8k tokens for the typical
// operator. Gating them shaves 180-300ms off every cold-start turn.
//
// Pattern: spreadIf(condition, prefix, source) — drops the entire module
// from the registry when the condition is false. Per-module probes are
// cheap (env / secrets.json file reads). Log a one-line summary at boot
// so the operator sees what's gated in vs out.

function spreadIf<T>(
  condition: boolean,
  prefix: string | undefined,
  source: Record<string, T>,
): Record<string, T> {
  if (!condition) return {};
  if (!prefix) return source;
  return Object.fromEntries(
    Object.entries(source).map(([k, v]) => [`${prefix}${k}`, v]),
  ) as Record<string, T>;
}

function hasSecretOrEnv(envKey: string, secretsKey: string): boolean {
  if ((process.env[envKey] ?? "").trim().length > 0) return true;
  try {
    return resolveSecret(secretsKey) !== null;
  } catch {
    return false;
  }
}

function hasGhCli(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function hasCodeRabbitCli(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("coderabbit", ["--version"], { stdio: "ignore", timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isVoiceEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    const dir = process.env.SUBCTL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "subctl");
    const voicePath = path.join(dir, "voice.json");
    if (!fs.existsSync(voicePath)) return false;
    const cfg = JSON.parse(fs.readFileSync(voicePath, "utf8")) as { enabled?: boolean };
    return cfg.enabled === true;
  } catch {
    return false;
  }
}

function isSkillRouterEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    const dir = process.env.SUBCTL_CONFIG_DIR ?? path.join(os.homedir(), ".config", "subctl");
    return fs.existsSync(path.join(dir, "skill-router.enabled"));
  } catch {
    return false;
  }
}

// Compute gate decisions once at module load — saves repeating the checks
// for each tool group below. Cached at boot; operator restart applies any
// changes (consistent with how other config flags work in master).
const TOOL_GATES = {
  gh: hasGhCli(),
  coderabbit: hasCodeRabbitCli(),
  context7: hasSecretOrEnv("CONTEXT7_API_KEY", "context7_api_key"),
  linear: hasSecretOrEnv("LINEAR_API_KEY", "linear_api_key"),
  tinyfish: hasSecretOrEnv("TINYFISH_API_KEY", "tinyfish_api_key"),
  // v2.8.10 — memory substrate migration. Cognee gates on configuration
  // presence (URL override OR auth token); actual reachability is probed
  // async post-boot and logged. Phase 1 scaffold — no tools wired yet,
  // so the gate just flags whether configuration exists.
  cognee:
    hasSecretOrEnv("COGNEE_AUTH_TOKEN", "cognee_auth_token") ||
    (process.env.COGNEE_SERVICE_URL ?? "").trim().length > 0,
  // Memori gates on api key OR a configured sidecar URL OR the launchd
  // plist existing (operator ran `subctl memori install`). The
  // operator's chosen "augmentation=off, pure local SQLite" path needs
  // no API key, so token-only gating would mis-fire. Reachability is
  // probed runtime per tool call (isMemoriAvailable in
  // tools/evy-memory.ts) — this gate just tells the boot log whether
  // we should look.
  memori:
    hasSecretOrEnv("MEMORI_API_KEY", "memori_api_key") ||
    (process.env.MEMORI_SERVICE_URL ?? "").trim().length > 0 ||
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require("node:path") as typeof import("node:path");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require("node:os") as typeof import("node:os");
        return fs.existsSync(
          path.join(os.homedir(), "Library", "LaunchAgents", "com.subctl.memori.plist"),
        );
      } catch {
        return false;
      }
    })(),
  voice: isVoiceEnabled(),
  skillRouter: isSkillRouterEnabled(),
  // Memory consciousness cycle (Memory Init #5 Phase 3). Kernel only
  // runs when Memori sidecar is reachable — no point reviewing if
  // there's no Tier 3 source data.
  memory_kernel: false as boolean, // resolved below after TOOL_GATES.memori is known
};

// Backfill the post-aggregation gates (here so the literal stays readable above).
TOOL_GATES.memory_kernel = TOOL_GATES.memori;

console.error(
  `[master] tool gates: ${Object.entries(TOOL_GATES).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`,
);

export const toolRegistry: Record<string, InternalTool> = {
  ...Object.fromEntries(
    Object.entries(subctlOrchTools).map(([k, v]) => [
      `subctl_orch_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  // gh_* — gated on `gh` binary presence (Tier-2 audit 2026-05-16).
  ...(spreadIf(TOOL_GATES.gh, "gh_", ghTools) as Record<string, InternalTool>),
  // coderabbit_* — gated on `coderabbit` CLI presence.
  ...(spreadIf(TOOL_GATES.coderabbit, "coderabbit_", coderabbitTools) as Record<string, InternalTool>),
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
  // context7_* — gated on CONTEXT7_API_KEY. Already-prefixed keys.
  ...(spreadIf(TOOL_GATES.context7, undefined, context7Tools) as Record<string, InternalTool>),
  ...Object.fromEntries(
    Object.entries(tier1MemoryTools).map(([k, v]) => [
      k, // already prefixed (memory_show, memory_remember, memory_forget, memory_user_update)
      v as unknown as InternalTool,
    ]),
  ),
  // skill_* — gated on skill-router being enabled. Already-prefixed keys.
  ...(spreadIf(TOOL_GATES.skillRouter, undefined, skillAuthorTools) as Record<string, InternalTool>),
  // ── v2.8.1 skills clarity ──
  // Evy-curated authoring channel — also gated on skill-router. Writes drafts under
  // ~/.local/state/subctl/evy-skills/ for operator review (promote/delete).
  // Distinct from legacy skill-author.ts (private master-only catalog).
  ...(spreadIf(TOOL_GATES.skillRouter, undefined, evySkillsAuthorTools) as Record<string, InternalTool>),
  // ── end v2.8.1 skills clarity ──
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
  ...Object.fromEntries(
    Object.entries(schedulerTools).map(([k, v]) => [
      k, // schedule_followup, list_followups, cancel_followup
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(attachmentsTools).map(([k, v]) => [
      k, // read_attachment, list_attachments
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(vaultLinkTools).map(([k, v]) => [
      k, // vault_link
      v as unknown as InternalTool,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(policyTools).map(([k, v]) => [
      `policy_${k}`,
      v as unknown as InternalTool,
    ]),
  ),
  // diag family: keys are already fully-qualified `system_*` (matches what
  // the M3 agent asked for via Telegram on 2026-05-11). v2.7.1.
  ...Object.fromEntries(
    Object.entries(diagTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // web family: keys are already fully-qualified `web_*` (web_search +
  // web_fetch). Operator-funded Brave + Firecrawl, agent-requested via
  // Telegram on 2026-05-12. v2.7.2.
  ...Object.fromEntries(
    Object.entries(webTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // tinyfish_* — gated on TINYFISH_API_KEY (~.config/subctl/secrets.json or env).
  // Parallel to web_* (Brave + Firecrawl). v2.7.16.
  ...(spreadIf(TOOL_GATES.tinyfish, undefined, tinyfishTools) as Record<string, InternalTool>),
  // background_* — v2.8.10 background-run runtime surface. Always
  // registered; the runtime itself is always available. Tools:
  //   background_run    — dispatch any registered tool in the background
  //   background_status — inspect active + recent runs
  //   background_cancel — abort a running run by id
  ...Object.fromEntries(
    Object.entries(backgroundTools).map(([k, v]) => [
      k,
      v as unknown as InternalTool,
    ]),
  ),
  // knowledge_graph_* — v2.8.10 Memory Init #4. Multi-hop reasoning
  // over the Cognee graph. Tools gate themselves on Cognee
  // reachability at call time so they're discoverable in the registry
  // and surface a clean "configure Cognee" error when the service
  // isn't running.
  ...(spreadIf(TOOL_GATES.cognee, undefined, knowledgeGraphTools) as Record<string, InternalTool>),
  // linear_* — gated on LINEAR_API_KEY. Operator-funded Linear API access
  // configured 2026-05-12. v2.7.2.
  ...(spreadIf(TOOL_GATES.linear, undefined, linearTools) as Record<string, InternalTool>),
  // knowledge family: key already fully-qualified `system_subctl_knowledge`.
  // Self-introspection over a TOON-formatted breakdown of the entire subctl
  // system at components/master/knowledge/subctl.toon. Operator uses TOON
  // heavily in Argent and asked for the same pattern here. v2.7.7.
  ...Object.fromEntries(
    Object.entries(knowledgeTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // team-docs family: write/read/list/append to <project>/.subctl/docs/.
  // Operator decision (v2.7.10): subctl scopes its docs under .subctl/docs/
  // alongside the policy.toml — keeps subctl-managed state out of the
  // project's own docs/ tree.
  ...Object.fromEntries(
    Object.entries(teamDocsTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // watchdog family (v2.7.19): enumerate + kill stale watchdogs. Evy uses
  // these when the operator says "what's running?" or "kill the inbox
  // poll". Keys are fully-qualified (watchdog_list, watchdog_kill).
  ...Object.fromEntries(
    Object.entries(watchdogTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // evy-memory family (v2.7.23): Tier 3 conversational memory. evy_recall
  // reads the operator-Evy chat history + decisions + shipped events that
  // master captures at turn boundaries; evy_remember is the explicit save
  // surface. Distinct from memory_search (claude-mem, Tier 4). Keys are
  // fully-qualified (evy_recall, evy_remember).
  ...Object.fromEntries(
    Object.entries(evyMemoryTools).map(([k, v]) => [k, v as unknown as InternalTool]),
  ),
  // voice_* — gated on voice.json's enabled:true. Disabled by default
  // — operator opts in via voice.json or the dashboard /voice toggle.
  // v2.8.0; gating added 2026-05-16.
  ...(spreadIf(TOOL_GATES.voice, undefined, voiceTools) as Record<string, InternalTool>),
};

// system_my_tools needs to introspect the live registry. Bind it here so
// the tool can answer "what tools do you have?" without a circular import.
bindSystemToolRegistry(toolRegistry as Record<string, { description?: string }>);

// v2.8.10 — background_run needs to resolve tool_name → invoke() at
// dispatch time, so bind it to the live registry here (post-construction).
bindBackgroundToolRegistry(
  toolRegistry as unknown as Record<
    string,
    { description: string; schema: unknown; invoke: (args: Record<string, unknown>) => Promise<unknown> }
  >,
);

// ─── SDK adapters ──────────────────────────────────────────────────────────
// pi-agent-core wants AgentTool<TSchema> (typebox parameters + `execute`). Our
// tools/*.ts modules export `{description, schema (raw JSON Schema), invoke}`.
// The agent loop validates args with Value.Convert + a TypeBox/JsonSchema
// fallback validator, so passing a plain JSON Schema as `parameters` is safe;
// the Anthropic provider just reads `schema.properties` + `schema.required`.

// v2.7.23 — compact tool-call args summary for memory recording. We don't
// want full payloads in the memory log (a single large tool-call could
// dominate the FTS index), but we DO want the load-bearing field values
// the operator might later search ("what did Evy ask gh about?"). Strategy:
// keep top-level string/number values, truncate strings >120 chars, drop
// nested objects/arrays as "<obj>" / "<arr>".
function summarizeArgs(params: unknown): string {
  if (params == null) return "";
  if (typeof params !== "object") return String(params).slice(0, 120);
  const out: string[] = [];
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === "string") {
      const s = v.length > 120 ? v.slice(0, 117) + "…" : v;
      out.push(`${k}=${JSON.stringify(s)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      out.push(`${k}=<arr:${v.length}>`);
    } else {
      out.push(`${k}=<obj>`);
    }
    if (out.join(", ").length > 320) {
      out.push("…");
      break;
    }
  }
  return out.join(", ");
}

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
      // v2.7.19 — empty-listener circuit breaker. After 3 consecutive
      // empty-and-dead-listener returns for THIS exact tool name, we
      // refuse the 4th call within the same turn-window. Returns a
      // synthesized error to the model in place of invoking the tool;
      // see components/master/circuit-breaker.ts for the trigger
      // condition + reset semantics. Logs to stderr at warn level so
      // the operator can grep master.log for circuit-breaker trips.
      if (shouldRefuseToolCall(name)) {
        const refusal = synthesizeRefusal(name);
        console.error(
          `[circuit-breaker] tripped on tool=${name} after 3 empty-dead-listener returns`,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }],
          details: refusal,
        };
      }
      // v2.7.23 — record the tool call into Evy Memory (Tier 3). We log
      // only the call (not the result) because results can be huge and
      // most of the value is "did Evy call X, with roughly what args?"
      // Names are short, args are stringified short-form. Failures are
      // swallowed — memory must never break a tool call.
      try {
        const shortArgs = summarizeArgs(params);
        recordMemoryEntry({
          role: "tool",
          kind: "tool-call",
          content: `${name}(${shortArgs})`,
          metadata: { tool_name: name },
        });
      } catch (err) {
        console.error(
          `[memory] tool-call record failed: ${(err as Error).message ?? err}`,
        );
      }
      const result = await tool.invoke(params as Record<string, unknown>);
      // Inspect the result and update breaker state. Never throws; on
      // malformed result types the matcher just returns false (treating
      // it as a non-empty result, which resets the counter — the safe
      // default).
      try {
        recordToolResult(name, result);
      } catch {
        /* breaker bookkeeping must never break the tool call */
      }
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
export const PROVIDER_API: Record<string, string> = {
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
  // OpenRouter — unified gateway for hundreds of models (incl. a free preview
  // tier). OpenAI-compat wire format at https://openrouter.ai/api/v1. Model
  // IDs use vendor/name (e.g. "anthropic/claude-sonnet-4", "openai/gpt-5.2").
  // Auth via openrouter_api_key (secrets.json) / OPENROUTER_API_KEY (env). The
  // optional attribution headers (HTTP-Referer, X-OpenRouter-Title) are
  // intentionally NOT injected in v2.7.17 — operators stay anonymous on the
  // OpenRouter leaderboard. If we ever want attribution that's a separate
  // change in pi-ai's openai-completions header pipeline.
  openrouter: "openai-completions",
};

export function buildModel(cfg: {
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
    // Default base URL for local OpenAI-compatible runtimes when providers.json
    // omits `host`. Without this, pi-ai's OpenAI client falls back to
    // api.openai.com and sends the local-runtime token to real OpenAI,
    // which 401s. Fixed in v2.7.7 after a long debug.
    baseUrl: cfg.host ?? (
      LOCAL_PROVIDERS.has(cfg.provider) ? "http://localhost:1234/v1" :
      cfg.provider === "openrouter" ? "https://openrouter.ai/api/v1" :
      ""
    ),
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

// LM Studio added an optional "Require API Token" toggle in its server
// settings. When enabled, every request — including the OpenAI-compatible
// /v1/* surface AND LM Studio's native /api/v0/* and /api/v1/models/load
// surfaces — must carry `Authorization: Bearer <token>` or it 401s.
//
// Token resolution honors the v2.7.4 priority chain (see secrets.ts):
//   1. process.env.LMSTUDIO_API_TOKEN (launchd plist EnvironmentVariables)
//   2. ~/.config/subctl/secrets.json `lmstudio_api_token` (dashboard UI)
//   3. Absent → return {} so the spread is a no-op (back-compat with
//      LM Studio servers that don't have token auth enabled).
export function lmstudioAuthHeader(): Record<string, string> {
  const token = resolveSecret("lmstudio_api_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// pi-ai's openai-completions provider requires *something* in the
// Authorization header even when talking to a local server that doesn't
// care (LM Studio, Ollama, MLX, vLLM all accept any value when the
// "Require API Token" toggle is off). For lmstudio specifically, if the
// operator has enabled "Require API Token", the v2.7.4 priority chain
// (env > secrets.json > absent) flows through here and pi-ai sends a
// real `Authorization: Bearer <token>`. Otherwise we keep the legacy
// "not-needed" sentinel.
//
// Exported so the test suite can exercise the resolution chain without
// having to spin up the full master boot pipeline.
export const LOCAL_PROVIDERS = new Set(["mlx", "ollama", "lmstudio", "vllm"]);
export function getApiKeyForProvider(provider: string): string | undefined {
  if (provider === "lmstudio") {
    return resolveSecret("lmstudio_api_token") ?? "not-needed";
  }
  if (LOCAL_PROVIDERS.has(provider)) return "not-needed";
  if (provider === "openrouter") {
    // OpenRouter REQUIRES a real key on every request — unlike LM Studio
    // there's no "not-needed" fallback. Return undefined (NOT a sentinel)
    // when the secret is absent so pi-ai surfaces a clear "no API key for
    // provider: openrouter" instead of pushing a bogus token to api/v1
    // and getting a generic 401. Operator mints a key at
    // https://openrouter.ai/keys and pastes it into Settings → API Tokens
    // (or sets OPENROUTER_API_KEY in the launchd plist).
    return resolveSecret("openrouter_api_key") ?? undefined;
  }
  if (provider === "openai-codex") {
    // v2.8.7 — OAuth (ChatGPT Pro subscription) for the openai-codex pi-ai
    // provider. We read the active codex profile's auth.json (per
    // accounts.conf) and return the JWT access_token. Pi-ai decodes the
    // JWT to pull chatgpt_account_id for the `chatgpt-account-id` header
    // and uses the same token as `Authorization: Bearer …`.
    //
    // Returns undefined when no codex profile is configured, the JWT is
    // missing/malformed, or the token is past `exp` — pi-ai will surface
    // "No API key for provider: openai-codex" with a clear master.log
    // breadcrumb from openai-codex-auth.ts above it.
    //
    // Refresh-on-near-expiry / refresh-on-401 is a tracked follow-up.
    return getCodexAccessToken();
  }
  // Fall through — pi-ai handles real providers via env vars / OAuth
  return undefined;
}

export async function ensureModelLoaded(cfg: { provider: string; model: string; host?: string; context_length?: number }, role: string): Promise<{ ok: boolean; detail: string }> {
  if (cfg.provider !== "lmstudio") {
    return { ok: true, detail: `${role} is ${cfg.provider} (cloud) — no local load needed` };
  }
  const desired = cfg.context_length ?? ROLE_DEFAULT_CONTEXT[role] ?? 0;
  if (!desired) return { ok: true, detail: `${role} context_length=0; not enforcing` };
  const apiBase = (cfg.host ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
  // 1. Check current load state — skip the reload if it's already where we
  //    want it. Tight 2s timeout: if LM Studio isn't even responding to a
  //    GET we shouldn't dump a load request into it — bail to JIT.
  let lmReachable = false;
  try {
    const r = await fetch(`${apiBase}/api/v0/models`, {
      headers: { ...lmstudioAuthHeader() },
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      lmReachable = true;
      const j = (await r.json()) as { data?: Array<{ id: string; state?: string; loaded_context_length?: number }> };
      const current = (j.data ?? []).find((m) => m.id === cfg.model);
      // If model is already loaded at ANY context, leave it alone. The
      // operator's manual config (and LM Studio's own state) wins. The
      // previous "upgrade ctx if loaded < desired" path tried to
      // unload+reload, but unload-by-model-name silently fails in current
      // LM Studio (it requires instance_id), so the load step created a
      // duplicate :2 instance. Master only enforces ctx on cold start
      // (model not yet loaded) — see commit fix(master): ctx-pin respects
      // existing model load.
      if (current?.state === "loaded") {
        return {
          ok: true,
          detail: `${role}=${cfg.model} already loaded at ctx ${(current.loaded_context_length ?? 0).toLocaleString()} — respecting existing load (operator/LM Studio config wins)`,
        };
      }
    }
  } catch { /* fall through */ }
  if (!lmReachable) {
    return {
      ok: false,
      detail: `LM Studio at ${apiBase} did not respond to /api/v0/models within 2s — skipping pin, JIT will handle on first prompt`,
    };
  }
  // 2. Unload first (safe reload pattern).
  try {
    await fetch(`${apiBase}/api/v1/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...lmstudioAuthHeader() },
      body: JSON.stringify({ model: cfg.model }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* unload failures are non-fatal — load below will replace */ }
  // 3. Load with explicit context_length. Cap at 20s (was 60) — if LM Studio
  //    can't load in 20s the daemon shouldn't block boot. JIT-on-first-prompt
  //    is the fallback.
  try {
    const r = await fetch(`${apiBase}/api/v1/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...lmstudioAuthHeader() },
      body: JSON.stringify({
        model: cfg.model,
        context_length: desired,
        flash_attention: true,
        echo_load_config: true,
      }),
      signal: AbortSignal.timeout(20_000),
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
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    return dropOrphanToolResults(msgs);
  } catch (err) {
    console.error(
      `[master] WARN agent-state.json corrupt, starting fresh: ${(err as Error).message}`,
    );
    return [];
  }
}

// v2.8.10 (task #5) — defensive orphan filter. The compactor was leaving
// behind toolResult messages whose parent toolCall got folded into the
// summary. Codex's /responses API rejects those with HTTP 400. We
// already filter on the way OUT (in compactTranscriptInline post-2.8.10)
// but this load-time sweep catches state files written by older daemon
// builds that never had the filter.
export function dropOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
  const calledIds = new Set<string>();
  for (const m of messages) {
    if ((m as { role?: string }).role !== "assistant") continue;
    const c = ((m as { content?: unknown }).content ?? []) as Array<
      { type?: string; id?: string }
    >;
    for (const p of c) if (p?.type === "toolCall" && typeof p.id === "string") calledIds.add(p.id);
  }
  let dropped = 0;
  const filtered = messages.filter((m) => {
    const role = (m as { role?: string }).role;
    const tcid = (m as { toolCallId?: string }).toolCallId;
    if (role === "toolResult" && typeof tcid === "string" && !calledIds.has(tcid)) {
      dropped++;
      return false;
    }
    return true;
  });
  if (dropped > 0) {
    console.error(
      `[master] dropped ${dropped} orphan toolResult(s) at load — preempted Codex/OpenAI HTTP 400.`,
    );
  }
  return filtered;
}

// v2.8.9 — strip helpers moved to components/master/text-sanitize.ts so the
// Telegram outgoing path (tools/telegram.ts) and any future surface can
// import the same regex without duplicating it. Existing call sites in
// scrubMessageContent below are unchanged.
import { stripReasoningChannels } from "./text-sanitize";
function scrubMessageContent(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      const cleaned = stripReasoningChannels(content);
      return cleaned === content ? m : { ...m, content: cleaned };
    }
    if (Array.isArray(content)) {
      let mutated = false;
      const next = content.map((block) => {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: string }).text;
          if (typeof text === "string") {
            const cleaned = stripReasoningChannels(text);
            if (cleaned !== text) {
              mutated = true;
              return { ...block, text: cleaned };
            }
          }
        }
        return block;
      });
      return mutated ? { ...m, content: next } : m;
    }
    return m;
  });
}

function saveAgentTranscript(messages: AgentMessage[]) {
  writeFileSync(
    AGENT_STATE_PATH,
    JSON.stringify(
      { saved_at: new Date().toISOString(), messages: scrubMessageContent(messages) },
      null,
      2,
    ),
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
  // v2.7.18: the active supervisor is decided by profiles.json, NOT
  // providers.json. providers.json still supplies the surrounding
  // metadata for the supervisor role (provider id, context_length,
  // max_tokens) — profiles.json just overrides the model id + host so
  // the operator can switch between a light chat model and a heavy
  // reasoning model from the dashboard or Telegram without restarting.
  const supervisorCfgFromProviders = providers.models.supervisor;
  if (!supervisorCfgFromProviders) {
    console.error(
      `[master] FATAL providers.json missing models.supervisor — cannot boot agent`,
    );
    process.exit(1);
  }
  let profilesFile: ProfilesFile;
  try {
    profilesFile = loadProfiles();
  } catch (err) {
    console.error(
      `[master] FATAL profiles.json load failed: ${(err as Error).message}`,
    );
    process.exit(1);
    throw err; // unreachable, narrows the type
  }
  // `supervisorCfg` is the live, profile-overridden view used by the
  // rest of the daemon (status responses, /diag, /context, LM Studio
  // pre-flight). Reassigned on profile swap so all readers see the
  // new model id / host without restart.
  let supervisorCfg: Providers["models"][string] = {
    ...supervisorCfgFromProviders,
    model: profilesFile.profiles[profilesFile.active].supervisor,
    host: profilesFile.profiles[profilesFile.active].host,
  };
  let activeProfile: ProfileName = profilesFile.active;
  console.error(
    `[master] profile=${activeProfile} → supervisor=${supervisorCfg.provider}/${supervisorCfg.model}`,
  );
  let supervisorModel = buildModel(supervisorCfg);
  const tools = Object.entries(toolRegistry).map(([name, t]) =>
    adaptTool(name, t),
  );

  // Pre-flight: ensure LM Studio has the supervisor (and reviewer if
  // configured) loaded with the right context window. Protects against
  // the recurring 4K JIT trap. Non-blocking — if LM Studio is offline
  // the agent boots anyway; first user message will fail loudly.
  //
  // Run role pins in PARALLEL so a slow/dead reviewer can't block the
  // supervisor pin OR the rest of boot. Diagnosed 2026-05-10 when LM
  // Studio crashed, supervisor pin succeeded immediately ("already
  // loaded") but reviewer pin hung for 60s on /api/v1/models/load
  // timeout. With Promise.allSettled boot is bounded by the SLOWEST
  // single role, not the sum.
  //
  // Dedup: when reviewer points at the same provider+model+host as
  // supervisor, skip the reviewer pin entirely. LM Studio's load API
  // treats two pins of the same model with DIFFERENT ctx_size values
  // (supervisor typically 65K, reviewer typically 32K) as a request
  // for a second instance — it spawns a `qwen/qwen3.6-27b:2` shadow
  // model and burns ~30GB of unified memory for nothing, because the
  // supervisor's already-loaded 65K context window is a strict
  // superset of what the reviewer would need. One pin at the larger
  // size handles both callers correctly.
  function sameLocalRoute(
    a: Providers["models"][string] | undefined,
    b: Providers["models"][string] | undefined,
  ): boolean {
    return !!a && !!b
      && a.provider === b.provider
      && a.model === b.model
      && (a.host ?? "") === (b.host ?? "");
  }
  const rolesToPin = (["supervisor", "reviewer"] as const).filter(
    (role) => {
      if (!providers.models[role]) return false;
      if (
        role === "reviewer"
        && sameLocalRoute(providers.models.reviewer, providers.models.supervisor)
      ) {
        console.error(
          `[master] ctx-pin reviewer: SKIPPED — same model+host as supervisor (avoids LM Studio :2 instance)`,
        );
        return false;
      }
      return true;
    },
  );
  await Promise.allSettled(
    rolesToPin.map(async (role) => {
      const cfg = providers.models[role]!;
      const result = await ensureModelLoaded(cfg, role);
      console.error(`[master] ${result.ok ? "ctx-pin" : "ctx-pin FAILED"} ${role}: ${result.detail}`);
    }),
  );

  // Local-runtime providers (mlx/ollama/lmstudio/vllm) don't need real API
  // keys — LM Studio and Ollama accept any value, and the request never leaves
  // the box. pi-ai's openai-completions provider still requires SOMETHING in
  // the Authorization header, so feed it a sentinel for local providers and
  // let real ones fall through (Anthropic + Codex pull from their own env vars
  // / OAuth flow internally; we don't need to thread those here).
  // v2.7.4 — see module-level getApiKeyForProvider for the env-var branching
  // (LMSTUDIO_API_TOKEN). Kept inline-named here so pi-ai's Agent ctor
  // callback signature matches.
  const getApiKey = (provider: string): string | undefined =>
    getApiKeyForProvider(provider);

  // Compose the initial system prompt: master persona + tier-1 memory
  // (user profile + learned facts). Both memory files are re-read on
  // every dispatchToAgent call below, so writes from operator OR master
  // tools land in the next turn without restart.
  // ── v2.8.1 chat perf / skill router ──
  // Last router decision for the current turn, captured so the SSE
  // broadcast in processOnePrompt can surface it to the dashboard pill
  // without re-running scoring. Re-set on every compose call.
  let lastRouterDecision: RouterDecision | null = null;

  function composeSystemPrompt(userMessage?: string): string {
    const memBlock = buildMemoryBlock();
    const personality = buildPersonalityFragment();
    // ── v2.8.1: skill router (Hermes-style preloading) ──
    // When ~/.config/subctl/skill-router.enabled exists, score the
    // inbound message against the in-repo skill catalog and prepend
    // the chosen skills' bodies BEFORE the master SKILL.md. Absent
    // the flag, behavior is identical to v2.8.0 (master SKILL.md
    // only). Routing runs sub-ms (no LLM call, no embeddings) and
    // re-uses a stat()-invalidated catalog cache.
    let routerBlock = "";
    try {
      const decision = routerSelectSkills(userMessage ?? "", {
        cwd: process.cwd(),
      });
      lastRouterDecision = decision;
      if (decision.enabled) {
        routerBlock = routerRenderSelected(decision.selected);
      }
    } catch (err) {
      // Router must never block the prompt path. Fail open (no extra
      // skills) and log loud.
      console.error(`[skill-router] selection failed: ${(err as Error).message}`);
      lastRouterDecision = null;
    }
    // Personality goes LAST so voice rules are the most-recent thing the
    // model reads before responding. SKILL.md (the behavioral contract)
    // and anti-hallucination rules stay authoritative — the personality
    // fragment cannot relax them, and every preset's content explicitly
    // says so. Hot-swappable: composeSystemPrompt() runs before every
    // turn, so writes to personality.json take effect on the next prompt.
    return memBlock + routerBlock + skill + personality;
  }

  // v2.8.9 — LM Studio cache_prompt: true via pi-ai's onPayload hook.
  // Argent landed this 2026-05-16; mirrored here. Without it, llama.cpp /
  // LM Studio rebuilds the KV cache from scratch on every turn, even
  // when the prompt prefix is identical (which it nearly always is —
  // 14k-char SKILL.md + tool registry + persona). With cache_prompt: true,
  // LM Studio reuses the KV cache across calls; Argent measured 702ms →
  // 316ms (~55% faster) on a 624-token prompt; our 14k-char prompts will
  // see larger absolute savings.
  //
  // Detection is substring-based on baseUrl. Reasonable default for
  // localhost LM Studio; if operator reconfigures the port we'll need a
  // more robust check. Local providers other than LM Studio (mlx, ollama,
  // vllm) tolerate the flag — llama.cpp-family servers ignore unknown
  // fields, OpenAI-compat hosts reject anything they don't know. We
  // restrict to LM Studio specifically to avoid surprising other backends.
  function isLmStudioBaseUrl(url: string): boolean {
    return url.includes("localhost:1234") || url.includes("127.0.0.1:1234");
  }
  const onPayload: NonNullable<ConstructorParameters<typeof Agent>[0]["onPayload"]> = (
    payload,
    model,
  ) => {
    if (!isLmStudioBaseUrl(model.baseUrl ?? "")) return undefined;
    if (!payload || typeof payload !== "object") return undefined;
    return { ...(payload as Record<string, unknown>), cache_prompt: true };
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(),
      model: supervisorModel,
      tools,
      messages: loadAgentTranscript(),
    },
    sessionId: `subctl-master-${Date.now()}`,
    getApiKey,
    onPayload,
  });

  // ── shared lifecycle flags (declared early so the inbox tailer below
  //     can reference dispatchToAgent which checks `stopped`) ─────────────
  let stopped = false;
  let promptInFlight = false;

  // v2.7.18: profile-swap state. Watcher fires async on file change
  // (debounced inside watchProfiles); we set this flag and rebuild the
  // model at the START of the next prompt processing — never mid-turn.
  let pendingProfileSwap = false;

  // Apply a profile swap: reassign supervisorCfg, rebuild the pi-ai
  // model, and re-pin LM Studio at the configured context_length so we
  // don't fall into the 4K JIT trap on the first prompt with the new
  // model. Called from processOnePrompt(); safe because promptInFlight
  // is true by then so nothing else can be reading these.
  async function applyProfileSwap(reason: string) {
    let next: ProfilesFile;
    try {
      next = loadProfiles();
    } catch (err) {
      console.error(`[profile] swap aborted: ${(err as Error).message}`);
      return;
    }
    const prev = activeProfile;
    const entry = next.profiles[next.active];
    activeProfile = next.active;
    supervisorCfg = {
      ...supervisorCfgFromProviders,
      model: entry.supervisor,
      host: entry.host,
    };
    supervisorModel = buildModel(supervisorCfg);
    // pi-agent-core's Agent reads model from `state.model` on each
    // prompt — reassign and the next agent.prompt() picks it up.
    (agent.state as any).model = supervisorModel;
    console.error(
      `[profile] swapped ${prev} → ${activeProfile} on next prompt (${reason}) — supervisor=${supervisorCfg.provider}/${supervisorCfg.model}`,
    );
    broadcast("profile_swapped", {
      ts: new Date().toISOString(),
      from: prev,
      to: activeProfile,
      supervisor: `${supervisorCfg.provider}/${supervisorCfg.model}`,
      reason,
    });
    logDecision({
      project: "_master",
      action: "profile_swapped",
      rationale: `${prev} → ${activeProfile} (${reason}); supervisor=${supervisorCfg.provider}/${supervisorCfg.model}`,
    });
    // Re-pin LM Studio context length. Non-blocking — first prompt
    // after a profile swap will JIT-load if the pin is still in flight.
    void ensureModelLoaded(supervisorCfg, "supervisor")
      .then((r) => console.error(`[profile] ${r.ok ? "ctx-pin" : "ctx-pin FAILED"} supervisor: ${r.detail}`))
      .catch((err) => console.error(`[profile] ctx-pin error: ${(err as Error).message}`));
  }

  // Install the watcher. fs.watch on profiles.json → debounce 200ms in
  // watchProfiles → callback runs here on the reloaded file. We DON'T
  // swap immediately: set the flag and let processOnePrompt apply the
  // change at the start of the next turn so a swap can never collide
  // with a mid-flight pi-agent-core stream.
  const profilesWatcher = watchProfiles((next) => {
    if (next.active !== activeProfile) {
      pendingProfileSwap = true;
      console.error(
        `[profile] file change detected (active: ${activeProfile} → ${next.active}); will swap at start of next prompt`,
      );
    }
  });

  // ── v2.8.0 voice layer ────────────────────────────────────────────────
  // voice.json hot-reload. The voice_render tool reads the config on every
  // call (no in-memory cache; same "VERSION is the canonical source" rule
  // the operator pinned 2026-05-11), so the watcher's only job is logging
  // the change so the operator can see in master.log that the toggle took
  // effect immediately. SSE bus also notifies the dashboard so the chat
  // panel's 🔊 button can hide itself live.
  const voiceConfigInitial = loadVoiceConfig();
  console.error(
    `[voice] booted: enabled=${voiceConfigInitial.enabled} voice=${voiceConfigInitial.default_voice_id} model=${voiceConfigInitial.model} server=${voiceConfigInitial.tts_server}`,
  );
  // Watcher registration deferred until after `broadcast` is defined (TDZ).

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
  // ── v2.8.1 skills clarity ──
  // Same broadcast bus for evy-authored skill events so the dashboard's
  // Skills tab refreshes the moment Evy authors / promotes / deletes.
  bindSkillsAuthorBroadcast(broadcast);
  // ── end v2.8.1 skills clarity ──

  // v2.8.0 — voice config watcher (defined after `broadcast` so the SSE
  // bus is available to the callback). The watcher only logs + emits
  // a `voice_config` SSE event; voice_render itself reads the file on
  // every call.
  const voiceWatcher = watchVoiceConfig((next) => {
    console.error(
      `[voice] config reloaded: enabled=${next.enabled} voice=${next.default_voice_id} model=${next.model}`,
    );
    broadcast("voice_config", next);
  });

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
  // v2.8.2 — Hoisted up here (was declared near the watchdog ticker
  // further down) so the inbox first-scan reconciliation and the
  // HTTP /teams/:name/prune route can reference them without TDZ
  // risk during the brief window between Bun.serve() returning and
  // the ticker block running. Both maps are still mutated only by
  // the watchdog/inbox paths — the new HTTP route and prune helpers
  // operate on them by reference.
  const teamPaneHash = new Map<string, string>();
  const teamNudgeState = new Map<string, TeamNudgeState>();
  // v2.8.2 — Cheap per-team `tmux has-session` check, used both by the
  // inbox first-scan reconciliation (refuse to re-seed activity for a
  // team whose tmux session is gone) and by the watchdog tick's
  // per-team safety net. Centralised here so server.ts has a single
  // mockable seam during tests.
  const inboxTmux = defaultTmuxRunner();

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
      // v2.8.2 — Before backfilling last_event metadata from an
      // existing-on-disk inbox file, reconcile against tmux. If the
      // session is gone, the file is an orphan from a prior boot:
      // re-seeding teamLastActivity from it is exactly the bug that
      // re-armed the staleness watchdog on stale state across master
      // restarts (2026-05-18 incident). Archive the orphan file out
      // of the polled dir so the next boot's scan doesn't trip on it
      // again, and skip the seed.
      if (!firstScanDone && stat.size > 0) {
        const sessionAlive = inboxTmux.hasSession(team);
        if (!sessionAlive) {
          try {
            // teamNudgeState isn't declared until the watchdog ticker
            // initialises (further down in startMaster). At first-scan
            // boot time it's empty by construction, so we don't pass it.
            const moved = pruneOneTeam(
              team,
              {
                teamLastActivity,
                teamReadOffsets,
                inboxDir: INBOX_DIR,
                tmux: inboxTmux,
              },
              "orphan-inbox-on-boot",
            );
            if (moved) {
              broadcast("team_pruned", {
                ts: new Date().toISOString(),
                teams: [team],
                reason: "orphan inbox file at boot — tmux session no longer exists",
              });
              logDecision({
                project: "_master",
                action: "watchdog_pruned",
                rationale: `orphan inbox file at boot for ${team} (tmux session gone); archived`,
              });
            }
          } catch { /* ignore */ }
          return;
        }
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
  // v2.8.2 — Flip the boot flag so any future "never seen this file"
  // discoveries (a new team file appearing while master is running)
  // start at offset 0 instead of stat.size — they're live events for
  // us, not historical replay. Without this flip the flag was dead
  // code: it was declared `false` and never assigned, so newly-
  // appearing post-boot jsonl files were also being skipped to EOF
  // and their first batch of events vanished into the void.
  firstScanDone = true;
  // ALWAYS poll — fs.watch on macOS fires unreliably (filename arg often
  // undefined for content writes inside the watched dir), so we can't depend
  // on it. The watcher below is an opportunistic "wake sooner" optimization;
  // the poll is the contract.
  //
  // v2.7.19 wraps the tick in touchWatchdog() and registers a kill via
  // clearInterval, so the registry can answer "is the inbox poll still
  // alive?" and the operator can kill it from Telegram / dashboard / Evy
  // without restarting master.
  const inboxPoll = setInterval(() => {
    touchWatchdog("inbox-poll");
    scanInboxOnce();
  }, 2000);
  registerWatchdog({
    id: "inbox-poll",
    kind: "inbox-poll",
    kill: () => clearInterval(inboxPoll),
  });
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

  // v2.8.10 — background-task runtime. Wire emitNotification into the
  // module's deps so tray notifications fire on run completion, then
  // hydrate sidecar state (any "running" entries from a prior boot get
  // marked failed with "lost on master restart").
  _setBackgroundRunsDeps({ emitNotification });
  await hydrateBackgroundRuns();

  // v2.8.10 — memory substrate scaffold (task #6). Probe Cognee
  // reachability at boot, log the result, and broadcast on the SSE bus
  // so the dashboard can show the gate state. Non-blocking — if the
  // service is down, master still boots normally; Tier 4 fallback
  // (claude-mem) keeps memory_search alive in the interim.
  if (TOOL_GATES.cognee) {
    void (async () => {
      try {
        const probe = await cogneeHealth();
        if (probe.reachable) {
          console.error(
            `[cognee] reachable at ${probe.url}${probe.version ? ` (v${probe.version})` : ""} — ${probe.latency_ms}ms — auth=${probe.auth_status}`,
          );
        } else {
          console.error(
            `[cognee] UNREACHABLE at ${probe.url} — ${probe.error ?? "unknown"} (auth=${probe.auth_status}). Tier 4 tools fall back to claude-mem until the service is up.`,
          );
        }
        broadcast("cognee_health", probe);
      } catch (err) {
        console.error(
          `[cognee] probe threw: ${(err as Error).message ?? err}`,
        );
      }
    })();
  } else {
    console.error(
      `[cognee] not configured (set COGNEE_SERVICE_URL or write cognee_auth_token via secrets panel). Memory init #1 scaffold inactive until configured.`,
    );
  }

  // v2.8.10 — Memori sidecar probe (task #8 Phase 3a). Same pattern as
  // Cognee: async, non-blocking, broadcast result on SSE bus. The
  // sidecar itself lives at services/memori/server.py (Phase 3b);
  // until that's installed + running, probe fails → Tier 3 falls
  // back to evy-memory (the existing substrate).
  if (TOOL_GATES.memori) {
    void (async () => {
      try {
        const probe = await memoriHealth();
        if (probe.reachable) {
          console.error(
            `[memori] reachable at ${probe.url}${probe.version ? ` (v${probe.version})` : ""} — ${probe.latency_ms}ms — db=${probe.database ?? "?"} — auth=${probe.auth_status}`,
          );
        } else {
          console.error(
            `[memori] UNREACHABLE at ${probe.url} — ${probe.error ?? "unknown"} (auth=${probe.auth_status}). Tier 3 falls back to evy-memory until the sidecar is up.`,
          );
        }
        broadcast("memori_health", probe);

        // ── memory consciousness cycle (Memory Init #5 Phase 3) ──────────
        // Gate the kernel on BOTH the static memori gate (env / plist) and
        // a live reachability probe. The kernel reviewer needs the sidecar
        // to be answering — no point arming the ticker if /select_unreviewed
        // would just 502 every minute.
        if (TOOL_GATES.memory_kernel && probe.reachable) {
          // Pick the reviewer-role model if configured; fall back to the
          // active supervisor. Matches the rolesToPin logic above — same
          // provider/model identity that the LM Studio ctx-pin honored.
          const reviewerCfg = providers.models.reviewer ?? supervisorCfg;
          // baseUrl resolution: providers.host is the OpenAI-compatible
          // root (`http://localhost:1234/v1` etc.); the reviewer's
          // callSupervisor helper appends `/v1/...` paths, so strip a
          // trailing /v1 to avoid /v1/v1.
          //
          // Bail-out: when the reviewer is on an auth-flow provider that
          // doesn't expose an OpenAI-compatible host on a known port
          // (openai-codex talks to ChatGPT's backend-api with bespoke
          // headers handled by pi-ai), the default callSupervisor helper
          // can't speak to it. Arm the kernel anyway so /status + the
          // ticker freshness signal stay live, but skip the
          // operator-visible LLM call until the operator wires a local
          // reviewer.
          const baseUrl = (reviewerCfg.host ?? "").replace(/\/v1\/?$/, "");
          const reviewerHasUsableHost = baseUrl.length > 0;
          if (!reviewerHasUsableHost) {
            console.error(
              `[memory-kernel] reviewer host not configured for ${reviewerCfg.provider}/${reviewerCfg.model} — ticker will run no-op cycles until providers.json.models.reviewer has a host (or a local provider is selected). To enable: set models.reviewer to an lmstudio/ollama route.`,
            );
          }
          const llmFetcher = async (
            messages: Parameters<typeof memoryKernelSupervisorFetcher>[0],
            opts: Parameters<typeof memoryKernelSupervisorFetcher>[1],
          ): Promise<string> => {
            if (!reviewerHasUsableHost) {
              // Empty completion → reviewer's JSON parser produces []
              // decisions → cycle exits cleanly with 0 promotions.
              return "";
            }
            const token = getApiKeyForProvider(reviewerCfg.provider);
            return memoryKernelSupervisorFetcher(messages, {
              ...opts,
              baseUrl,
              authToken: token === "not-needed" ? undefined : token,
            });
          };
          const reviewEventsWired: Parameters<typeof _setMemoryKernelDepsForTesting>[0]["reviewEvents"] =
            async (events, ctx) =>
              memoryKernelReviewEvents(events, ctx, {
                llmFetcher,
                configuredSupervisor: () => ({
                  provider: reviewerCfg.provider,
                  model: reviewerCfg.model,
                }),
              });
          _setMemoryKernelDepsForTesting({
            operatorName: () => policy.operator.name,
            recentTier1Facts: () => [],
            recentEvyMemories: () => [],
            activeProject: () => undefined,
            emitNotification: (n) => { emitNotification(n); },
            logDecision: (entry) => logDecision(entry),
            broadcast: (type, payload) => broadcast(type, payload),
            reviewEvents: reviewEventsWired,
          });
          const intervalMs = 5 * 60 * 1000;
          // entity_id matches what tools/evy-memory.ts uses for capture so
          // /select_unreviewed pulls the same scope master is writing to.
          // The capture path lowercases the operator name (tools/evy-memory.ts
          // pins it as "jason"); mirror that here so the kernel reads what
          // the capture writes.
          const entityId = (policy.operator.name ?? "operator").toLowerCase();
          startMemoryKernelTicker({
            intervalMs,
            entityId,
            registerWatchdog,
            touchWatchdog,
            onError: (err) => {
              emitNotification({
                kind: "memory-kernel-error",
                severity: "warn",
                title: "memory-kernel: cycle threw",
                body: `runOneCycle surfaced an error: ${err.message}`,
              });
            },
          });
          console.error(
            `[memory-kernel] armed — interval=5min, entity=${entityId}, reviewer=${reviewerCfg.provider}/${reviewerCfg.model}`,
          );
        } else if (TOOL_GATES.memory_kernel && !probe.reachable) {
          console.error(
            `[memory-kernel] not armed — Memori sidecar unreachable (${probe.error ?? "unknown"}). Will not retry until master restart.`,
          );
        }
      } catch (err) {
        console.error(
          `[memori] probe threw: ${(err as Error).message ?? err}`,
        );
      }
    })();
  } else {
    console.error(
      `[memori] not configured (set MEMORI_API_KEY env or write memori_api_key via secrets panel). Tier 3 stays on evy-memory until configured.`,
    );
  }

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
  type PendingPrompt = {
    text: string;
    source: "chat" | "telegram" | "watchdog";
    // Used by the verifier to cap correction loop iterations. Caller does
    // not set this; the verifier bumps it on re-entry.
    verifier_iteration?: number;
  };
  const promptQueue: PendingPrompt[] = [];

  // ── compact policy: just-in-time + safety-net (v2.7.3) ─────────────────
  // The supervisor model has a finite loaded context window. If the next
  // prompt would push us past `compact_tokens` (default 40k) the daemon
  // MUST compact synchronously BEFORE composing & dispatching. The 5min
  // ticker below is a safety net for transcripts that grow due to tool
  // outputs after prompt composition — it cannot prevent overflow alone.
  //
  // Fixed system+tool-schema overhead in every prompt. Empirical from
  // /v1/chat/completions logs (SKILL.md + ~70 tool descriptors). Kept in
  // sync with the value in /context's response so dashboard + JIT agree.
  const FIXED_PROMPT_OVERHEAD_TOKENS = 2500;
  const COMPACT_CFG_PATH = join(MASTER_STATE_DIR, "compact.json");

  async function getSupervisorLoadedCtx(timeoutMs = 1500): Promise<number | null> {
    try {
      const host = (supervisorCfg.host ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
      const r = await fetch(`${host}/api/v0/models`, {
        headers: { ...lmstudioAuthHeader() },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return null;
      const j = (await r.json()) as { data?: Array<{ id: string; loaded_context_length?: number }> };
      const found = (j.data ?? []).find((m) => m.id === supervisorCfg.model);
      return found?.loaded_context_length ?? null;
    } catch {
      return null;
    }
  }

  interface CompactInlineOpts {
    target_tokens: number;
    keep_recent: number;
    initiator: string; // "jit" | "ticker" | "operator"
  }
  interface CompactInlineResult {
    ok: boolean;
    noop?: boolean;
    archived_count?: number;
    kept_msgs?: number;
    archive_path?: string;
    error?: string;
    message?: string;
  }
  /**
   * Compact the transcript in-place. Shared between the HTTP route, the
   * just-in-time pre-prompt check, and the 5min safety-net ticker.
   * Caller is responsible for ensuring no other agent.prompt() is in flight.
   */
  function compactTranscriptInline(opts: CompactInlineOpts): CompactInlineResult {
    const TARGET_TOKENS = Math.max(2000, Math.min(200_000, opts.target_tokens));
    const KEEP_RECENT = Math.max(2, Math.min(40, opts.keep_recent));
    try {
      const messages = agent.state.messages as Array<Record<string, unknown>>;
      if (messages.length < KEEP_RECENT + 2) {
        return {
          ok: true,
          noop: true,
          message: `Nothing to compact — transcript only has ${messages.length} messages (last ${KEEP_RECENT} are always kept). Compaction kicks in automatically when the transcript grows past about ${KEEP_RECENT + 2} turns.`,
        };
      }
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
      let keepN = KEEP_RECENT;
      let recent = messages.slice(-keepN);
      let recentTokens = recent.reduce((acc, m) => acc + tokenize(m), 0);
      while (recentTokens > TARGET_TOKENS && keepN > 2) {
        keepN--;
        recent = messages.slice(-keepN);
        recentTokens = recent.reduce((acc, m) => acc + tokenize(m), 0);
      }
      const toCompact = messages.slice(0, -keepN);

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
        `[transcript compaction · ${toCompact.length} prior messages compacted into this summary on ${new Date().toISOString()} (initiator=${opts.initiator})]\n\n` +
        `User said:\n` + userTexts.slice(-12).map((t) => "  · " + t).join("\n") + "\n\n" +
        `You replied (highlights):\n` + lastAssistantText.slice(-8).map((t) => "  · " + t).join("\n") + "\n\n" +
        `Tools you used during this period: ${Array.from(toolsCalled).join(", ") || "(none)"}\n\n` +
        `(Original messages archived to disk; resume the conversation from here.)`;

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const archivePath = AGENT_STATE_PATH.replace(/\.json$/, `.archive-compact-${ts}.json`);
      if (existsSync(AGENT_STATE_PATH)) {
        const { copyFileSync } = require("node:fs") as typeof import("node:fs");
        copyFileSync(AGENT_STATE_PATH, archivePath);
      }

      agent.state.messages.length = 0;
      agent.state.messages.push({
        role: "user",
        content: [{ type: "text", text: summary }],
        timestamp: Date.now(),
      } as any);
      for (const m of recent) agent.state.messages.push(m as any);

      // v2.8.10 (task #5) — drop orphan toolResults. Compaction folds
      // older assistant messages (which contain toolCall blocks) into
      // the summary, but a `toolResult` may sit in `recent` whose
      // parent `toolCall` was just absorbed into the summary. Codex's
      // /responses API rejects orphan `function_call_output`s with
      // HTTP 400 ("No tool call found for function call output with
      // call_id ..."). This caused two operator-visible chat breaks
      // today (2026-05-16 21:35 / 21:36). Filter them out here so the
      // post-compact transcript is structurally valid for ANY provider.
      const _calledIds = new Set<string>();
      for (const m of agent.state.messages) {
        if ((m as { role?: string }).role !== "assistant") continue;
        const c = ((m as { content?: unknown }).content ?? []) as Array<
          { type?: string; id?: string }
        >;
        for (const p of c) if (p?.type === "toolCall" && typeof p.id === "string") _calledIds.add(p.id);
      }
      const _orphans: number[] = [];
      agent.state.messages.forEach((m, i) => {
        const role = (m as { role?: string }).role;
        const toolCallId = (m as { toolCallId?: string }).toolCallId;
        if (role === "toolResult" && typeof toolCallId === "string" && !_calledIds.has(toolCallId)) {
          _orphans.push(i);
        }
      });
      if (_orphans.length > 0) {
        // Iterate from the tail so indexes stay valid as we splice.
        for (let i = _orphans.length - 1; i >= 0; i--) {
          agent.state.messages.splice(_orphans[i]!, 1);
        }
        console.error(
          `[compact] dropped ${_orphans.length} orphan toolResult(s) — parent toolCalls folded into compaction summary; ids would have caused Codex HTTP 400.`,
        );
      }

      saveAgentTranscript(agent.state.messages);
      broadcast("transcript_compacted", {
        ts: new Date().toISOString(),
        archived_count: toCompact.length,
        kept: recent.length + 1,
        archive_path: archivePath,
        initiator: opts.initiator,
      });
      logDecision({
        project: "_master",
        action: "transcript_compacted",
        rationale: `compacted ${toCompact.length} msgs, kept last ${recent.length} (initiator=${opts.initiator})`,
      });
      return {
        ok: true,
        archived_count: toCompact.length,
        kept_msgs: recent.length + 1,
        archive_path: archivePath,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Build a util-snapshot for the dashboard banner / /transcript/util route.
   * Pure read — does NOT compact.
   */
  async function buildUtilSnapshot(): Promise<{
    current_tokens: number;
    transcript_tokens: number;
    overhead_tokens: number;
    loaded_ctx: number | null;
    util_pct: number | null;
    warn_at: number | null;
    compact_at: number | null;
    target_tokens: number;
    config_mode: "absolute" | "threshold_pct" | "none";
    decision: CompactDecision;
  }> {
    const cfg = loadCompactConfig(COMPACT_CFG_PATH);
    const transcriptTokens = estimateTranscriptTokens(
      agent.state.messages as Array<{ content?: unknown }>,
    );
    const current = transcriptTokens + FIXED_PROMPT_OVERHEAD_TOKENS;
    const loadedCtx = await getSupervisorLoadedCtx();
    const decision = decideCompactAction(current, loadedCtx ?? 0, cfg);
    const hasAbs =
      typeof cfg.warn_tokens === "number" &&
      typeof cfg.compact_tokens === "number" &&
      cfg.warn_tokens > 0 &&
      cfg.compact_tokens > 0 &&
      cfg.compact_tokens > cfg.warn_tokens;
    const mode: "absolute" | "threshold_pct" | "none" = hasAbs
      ? "absolute"
      : loadedCtx
      ? "threshold_pct"
      : "none";
    return {
      current_tokens: current,
      transcript_tokens: transcriptTokens,
      overhead_tokens: FIXED_PROMPT_OVERHEAD_TOKENS,
      loaded_ctx: loadedCtx,
      util_pct: loadedCtx ? Math.round((current / loadedCtx) * 100) : null,
      warn_at: hasAbs ? cfg.warn_tokens : null,
      compact_at: hasAbs ? cfg.compact_tokens : null,
      target_tokens: cfg.target_tokens,
      config_mode: mode,
      decision,
    };
  }

  /**
   * Just-in-time compact gate. Run at the TOP of processOnePrompt before
   * composeSystemPrompt() and before agent.prompt() — so the supervisor
   * never sees a prompt window past `compact_tokens`. Synchronous
   * compaction; on warn, emits an SSE event (dashboard turns the banner
   * yellow) and proceeds.
   */
  async function runJitCompactCheck(): Promise<void> {
    let cfg: CompactConfig;
    try {
      cfg = loadCompactConfig(COMPACT_CFG_PATH);
    } catch {
      return;
    }
    if (!cfg.auto_compact) return;
    const transcriptTokens = estimateTranscriptTokens(
      agent.state.messages as Array<{ content?: unknown }>,
    );
    const current = transcriptTokens + FIXED_PROMPT_OVERHEAD_TOKENS;
    const loadedCtx = await getSupervisorLoadedCtx();
    const decision = decideCompactAction(current, loadedCtx ?? 0, cfg);
    if (decision.action === "ok") return;
    if (decision.action === "warn") {
      console.error(`[master] compact-warn (jit): ${decision.reason}`);
      broadcast("compact_warning", {
        ts: new Date().toISOString(),
        stage: "warn",
        initiator: "jit",
        current_tokens: decision.current_tokens,
        warn_at: cfg.warn_tokens || null,
        compact_at: cfg.compact_tokens || null,
        threshold_used: decision.threshold_used,
        reason: decision.reason,
      });
      return;
    }
    // decision.action === "compact"
    console.error(
      `[master] just-in-time compact: ${decision.reason} — compacting toward ${cfg.target_tokens.toLocaleString()} tok`,
    );
    broadcast("compact_warning", {
      ts: new Date().toISOString(),
      stage: "compacting",
      initiator: "jit",
      current_tokens: decision.current_tokens,
      warn_at: cfg.warn_tokens || null,
      compact_at: cfg.compact_tokens || null,
      threshold_used: decision.threshold_used,
      reason: decision.reason,
    });
    const result = compactTranscriptInline({
      target_tokens: cfg.target_tokens,
      keep_recent: cfg.keep_recent,
      initiator: "jit",
    });
    if (!result.ok) {
      console.error(`[master] just-in-time compact failed: ${result.error}`);
    } else if (result.noop) {
      console.error(`[master] just-in-time compact noop: ${result.message}`);
    } else {
      console.error(
        `[master] just-in-time compact ok — archived ${result.archived_count}, kept ${result.kept_msgs}`,
      );
    }
  }

  async function processOnePrompt(p: PendingPrompt): Promise<{ ok: boolean; error?: string }> {
    try {
      // ── v2.7.19 circuit-breaker reset ──────────────────────────────────
      // Operator messages (chat or telegram) start a fresh turn and clear
      // any in-flight breaker state. Synthetic prompts (source="watchdog",
      // covers [verifier]/[watchdog]/[scheduled]/[team-report]) DON'T
      // reset — they're tail continuations of the prior turn's reasoning,
      // not new operator intent.
      if (p.source === "chat" || p.source === "telegram") {
        resetCircuitBreakerOnNewTurn();
        // v2.8.10 — drain any background-run completions that landed
        // while the operator was away and prepend them to the prompt
        // text BEFORE composeSystemPrompt/agent.prompt see it. We mutate
        // p.text (not a copy) so downstream code paths (compose, verify,
        // memory recording) all see the augmented prompt.
        const completed = drainBackgroundCompletions();
        const prepend = formatBackgroundPrepend(completed);
        if (prepend) {
          p.text = `${prepend}\n\n${p.text}`;
        }
      }

      // ── v2.7.18 profile-swap gate ─────────────────────────────────────
      // If the watcher (fs.watch on profiles.json) flagged a pending
      // swap, apply it BEFORE anything else this turn. Runs at the
      // prompt boundary specifically so it never collides with an
      // in-flight pi-agent-core stream — pi-agent-core reads
      // agent.state.model once per prompt, so a swap here lands cleanly
      // on the next agent.prompt() call.
      if (pendingProfileSwap) {
        pendingProfileSwap = false;
        await applyProfileSwap("watcher");
      }

      // ── v2.7.3 just-in-time compact gate ───────────────────────────────
      // The supervisor must never see a prompt window past compact_tokens.
      // Run this BEFORE composeSystemPrompt() (so the recomposed prompt
      // reflects the post-compact transcript) and BEFORE agent.prompt()
      // (so the new user text doesn't sneak in over-budget). The 5-min
      // ticker below is a safety net; this is the primary gate.
      await runJitCompactCheck();

      // ── v2.8.1 chat perf / skill router ──
      // Per-turn latency telemetry. Stage timestamps recorded on the
      // local stack so they don't leak across overlapping turns
      // (processOnePrompt is serialized via promptInFlight, but the
      // closure is reentered for each turn). emitStage() logs to stderr
      // AND broadcasts a `latency_stage` SSE event so the dashboard can
      // surface the breakdown — see chat-perf zone in app.js.
      const turnT0 = performance.now();
      const turnId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const stageTimes: Record<string, number> = {};
      const emitStage = (stage: string, extras?: Record<string, unknown>) => {
        const elapsed = Math.round(performance.now() - turnT0);
        stageTimes[stage] = elapsed;
        const extraStr = extras
          ? " " + Object.entries(extras).map(([k, v]) => `${k}=${v}`).join(" ")
          : "";
        console.error(
          `[latency] turn=${turnId} stage=${stage} ms=${elapsed}${extraStr}`,
        );
        try {
          broadcast("latency_stage", {
            ts: new Date().toISOString(),
            turn: turnId,
            source: p.source,
            stage,
            elapsed_ms: elapsed,
            extras: extras ?? null,
          });
        } catch { /* never block on broadcast */ }
      };
      emitStage("process_start");

      // Refresh the system prompt with current tier-1 memory before every
      // prompt. Both memory.md and user.md are re-read fresh — operator
      // edits via the dashboard Memory tab AND master's own memory_*
      // tool writes both flow into the next turn without restart.
      try {
        // ── v2.8.1 chat perf / skill router ──
        // Pass the operator's message into composeSystemPrompt so the
        // skill router can score against it. Falls back to legacy
        // single-skill behavior when the flag file is absent.
        const newPrompt = composeSystemPrompt(p.text);
        (agent.state as any).systemPrompt = newPrompt;
        emitStage("compose_prompt_done", {
          prompt_chars: newPrompt.length,
          router_enabled: lastRouterDecision?.enabled ? 1 : 0,
          routed_skills:
            lastRouterDecision?.selected.map((s) => s.name).join(",") || "-",
        });
        // Surface the routing decision on the SSE bus so the dashboard
        // can render the "[router] X · Y" pill under this operator
        // message. Cheap; just metadata.
        if (lastRouterDecision && lastRouterDecision.enabled) {
          try {
            broadcast("skill_router", {
              ts: new Date().toISOString(),
              turn: turnId,
              source: p.source,
              message_preview: p.text.slice(0, 80),
              selected: lastRouterDecision.selected.map((s) => s.name),
              reason: lastRouterDecision.reason,
            });
          } catch { /* never block */ }
        }
      } catch { /* if pi-agent-core ever locks state.systemPrompt, we'll see it loud */ }
      broadcast("inbound", { source: p.source, text: p.text, ts: new Date().toISOString() });
      // v2.7.23 — record the inbound on Tier 3 (Evy Memory). User-facing
      // chat (chat / telegram / cli) lands as role="user" kind="message";
      // synthetic prompts (verifier / watchdog / scheduled / team-report)
      // land as role="event" so search-by-role filters out daemon noise.
      try {
        const isSynth =
          p.source === "watchdog" &&
          (p.text.startsWith("[verifier]") ||
            p.text.startsWith("[watchdog]") ||
            p.text.startsWith("[scheduled]") ||
            p.text.startsWith("[team-report]"));
        recordMemoryEntry({
          role: isSynth ? "event" : "user",
          kind: isSynth ? "synthetic-prompt" : "message",
          content: p.text,
          metadata: { source: p.source },
        });
      } catch (err) {
        console.error(
          `[memory] inbound record failed: ${(err as Error).message ?? err}`,
        );
      }
      // ── v2.8.1 chat perf / skill router ──
      // Hook agent.subscribe just for the duration of this turn so we
      // can record first-token + last-token timings. The longstanding
      // global subscriber upstream stays in place; this is a piggyback
      // listener that detaches in finally{}.
      emitStage("llm_call_start");
      let firstTokenEmitted = false;
      const detach = agent.subscribe((event: any) => {
        try {
          if (
            !firstTokenEmitted &&
            event?.type === "message_update" &&
            event?.assistantMessageEvent?.type === "text_delta"
          ) {
            firstTokenEmitted = true;
            emitStage("first_token");
          }
          if (event?.type === "agent_end") {
            emitStage("last_token");
          }
        } catch { /* never throw out of subscriber */ }
      });
      try {
        await agent.prompt(p.text);
      } finally {
        if (typeof detach === "function") {
          try { detach(); } catch { /* ignore */ }
        }
      }
      emitStage("turn_complete", { stages: JSON.stringify(stageTimes) });
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

      // ── claim-verification gate ────────────────────────────────────────
      // Argent-style anti-hallucination: scan the assistant text for
      // "claim triggers" (specific check-in times, asserted team status,
      // host-fact claims, message-sent claims). Each rule names tool(s)
      // that must have been called THIS turn for the claim to count as
      // verified. If we find unbacked claims, feed a synthetic correction
      // prompt and re-run the turn. Cap iterations to 2 to prevent loops.
      // The text the operator eventually sees is either (a) verified, or
      // (b) flagged in decisions.jsonl as a verification giveup.
      //
      // Gate skips itself for [verifier] re-entries so we don't recurse
      // on our own correction prompts. Gate also skips for source=
      // "watchdog" with "[scheduled]" or "[watchdog]" prefixes — those
      // are runtime-internal prompts, not operator-facing claims.
      const isInternalSynthPrompt =
        p.source === "watchdog" &&
        (p.text.startsWith("[verifier]") ||
          p.text.startsWith("[watchdog]") ||
          p.text.startsWith("[scheduled]") ||
          p.text.startsWith("[team-report]"));
      if (!isInternalSynthPrompt && !stopped) {
        const turn = extractLastTurn(agent.state.messages as ReadonlyArray<{ role?: string; content?: unknown }>);
        const gaps = findGaps(turn);
        if (gaps.length > 0) {
          broadcast("verifier_gap", {
            ts: new Date().toISOString(),
            source: p.source,
            iteration: p.verifier_iteration ?? 0,
            gaps: gaps.map((g) => ({ id: g.rule.id, phrase: g.matched_phrase })),
          });
          const iter = p.verifier_iteration ?? 0;
          if (iter < 2) {
            const correction = formatCorrectionPrompt(gaps);
            await agent.prompt(correction);
            // Recurse the verification once more on the newly-settled turn.
            // We re-use processOnePrompt with bumped iteration counter so
            // serialization stays through promptQueue. But since we're
            // already inside processOnePrompt, do it inline.
            const turn2 = extractLastTurn(agent.state.messages as ReadonlyArray<{ role?: string; content?: unknown }>);
            const gaps2 = findGaps(turn2);
            if (gaps2.length === 0) {
              logDecision({
                project: "_master",
                action: "verifier_resolved",
                rationale: `iteration ${iter + 1} — claims now backed by tool use`,
              });
            } else if (iter + 1 >= 2) {
              logDecision({
                project: "_master",
                action: "verifier_giveup",
                rationale: `gave up after 2 corrections; unmet rules: ${gaps2.map((g) => g.rule.id).join(",")}`,
              });
            }
          } else {
            logDecision({
              project: "_master",
              action: "verifier_giveup",
              rationale: `iter cap reached; unmet: ${gaps.map((g) => g.rule.id).join(",")}`,
            });
          }
        }
      }

      // ── Evy Memory record (v2.7.23) ────────────────────────────────────
      // Capture the assistant's final text turn into Tier 3. We use
      // extractLastTurn (same helper the claim-verifier uses) so we get the
      // post-stream consolidated text rather than the streaming deltas.
      // Skip for internal synth prompts — verifier/watchdog/scheduled
      // re-entries already echo the operator's intent and would create
      // redundant entries. Failures swallowed; memory must not block the
      // operator-reply path.
      if (!isInternalSynthPrompt && !stopped) {
        try {
          const turn = extractLastTurn(
            agent.state.messages as ReadonlyArray<{ role?: string; content?: unknown }>,
          );
          const text = (turn.text || "").trim();
          if (text) {
            recordMemoryEntry({
              role: "assistant",
              kind: "message",
              content: text,
              metadata: { source: p.source },
            });
          }
        } catch (err) {
          console.error(
            `[memory] assistant record failed: ${(err as Error).message ?? err}`,
          );
        }
      }

      // ── Telegram auto-relay ────────────────────────────────────────────
      // If the inbound came from Telegram, mirror the assistant's final
      // text response back to the same Telegram chat. Without this, an
      // operator who texted from their phone has to switch to the
      // dashboard to see the reply — defeats the purpose of having a
      // Telegram channel. Diagnosed 2026-05-10. Skip for internal synth
      // prompts ([verifier]/[watchdog]/[scheduled]) since those don't
      // represent a Telegram conversation turn.
      if (p.source === "telegram" && !isInternalSynthPrompt && !stopped) {
        try {
          const turn = extractLastTurn(agent.state.messages as ReadonlyArray<{ role?: string; content?: unknown }>);
          const text = (turn.text || "").trim();
          if (text) {
            // Telegram has a 4096-char limit per message — truncate with
            // an ellipsis hint rather than failing if the response is
            // huge. The dashboard sees the full text via SSE.
            const out = text.length > 3900
              ? text.slice(0, 3900) + "\n\n…[truncated; full reply in dashboard chat]"
              : text;
            void sendTelegramOutbound(out).catch((err) => {
              console.error(`[master] telegram auto-relay failed: ${err.message}`);
            });
          }
        } catch (err) {
          console.error(`[master] telegram auto-relay setup failed: ${(err as Error).message}`);
        }
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

  // Forward-declared so the fetch handler can capture it; assignment
  // happens after the watchdog ticker block below. The /upstreams/check
  // route guards on null to handle the (vanishingly small) window
  // between Bun.serve() returning and the watchdog being armed.
  let upstreamWatchdog: UpstreamWatchdogHandle | null = null;

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
          active_profile: activeProfile,
        });
      }

      // ── /profile — supervisor profile API (v2.7.18) ─────────────────────
      // GET returns the active profile name + the list of profile names.
      // POST { profile: "chat" | "heavy" } writes profiles.json. The
      // fs.watch on the file fires the watcher above, which flags
      // pendingProfileSwap; the actual rebuild happens at the start of
      // the next prompt so we never disturb an in-flight turn.
      if (url.pathname === "/profile" && req.method === "GET") {
        let snapshot: ProfilesFile;
        try {
          snapshot = loadProfiles();
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
        return Response.json({
          ok: true,
          active: snapshot.active,
          profiles: [...PROFILE_NAMES],
          // Expose the resolved supervisor + host for each profile so
          // the dashboard can render a tooltip ("chat → gemma-4-31b").
          // Pure-read endpoint; no secrets surface here.
          detail: snapshot.profiles,
        });
      }
      if (url.pathname === "/profile" && req.method === "POST") {
        let body: { profile?: string };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
        }
        const want = (body.profile ?? "").trim();
        if (!(PROFILE_NAMES as ReadonlyArray<string>).includes(want)) {
          return Response.json(
            {
              ok: false,
              error: `unknown profile "${want}". valid: ${PROFILE_NAMES.join(", ")}`,
            },
            { status: 400 },
          );
        }
        try {
          setActiveProfile(want);
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
        // The fs.watch event picks this up and flips pendingProfileSwap.
        // We don't wait for it: respond immediately with the new active
        // name so the UI can update optimistically.
        return Response.json({
          ok: true,
          active: want,
          note: "takes effect on the next prompt — no restart needed",
        });
      }

      // ── /watchdogs — watchdog kill controls (v2.7.19) ────────────────────
      // GET    /watchdogs           → { ok, count, watchdogs: [...] }
      // POST   /watchdogs/:id/kill  → { ok, killed_id } | { ok:false, error }
      // POST   /watchdogs/killall   → { ok, killed: [...], preserved: [...] }
      //
      // killall preserves kind="telegram-listener" so the operator's
      // command path doesn't sever itself when invoked from Telegram.
      // The dashboard's /api/watchdogs (in dashboard/server.ts) proxies
      // these — keep paths in sync if you rename.
      if (url.pathname === "/watchdogs" && req.method === "GET") {
        const watchdogs = listWatchdogs();
        return Response.json({ ok: true, count: watchdogs.length, watchdogs });
      }
      {
        const m = url.pathname.match(/^\/watchdogs\/([A-Za-z0-9_.-]+)\/kill\/?$/);
        if (m && req.method === "POST") {
          const id = m[1]!;
          const result = killWatchdog(id);
          const status = result.ok ? 200 : 404;
          return Response.json(result, { status });
        }
      }
      if (url.pathname === "/watchdogs/killall" && req.method === "POST") {
        // Always preserve the telegram listener — see comment above.
        // killall is intentionally a separate endpoint (not just looping
        // /kill from the client) so the preserve-list lives on the
        // server and the dashboard / Telegram client can't accidentally
        // omit it.
        const result = killAllWatchdogs({
          preserve_kinds: ["telegram-listener"],
        });
        return Response.json({ ok: true, ...result });
      }

      // ── /notifications — operator notification channel (v2.7.22) ─────────
      // Replaces the old "synthesize a [watchdog] prompt into Evy's
      // transcript" path. The watchdog tick + auto-compact errors emit
      // here; dashboard pulls via GET /notifications + GET
      // /notifications/stream (SSE), Telegram pushes on severity=alert.
      //
      //   GET  /notifications?since=<iso>&limit=N → { ok, notifications: [...] }
      //   POST /notifications/:id/read           → { ok, found }
      //   POST /notifications/read-all           → { ok, marked }
      //   GET  /notifications/stream             → text/event-stream
      if (url.pathname === "/notifications" && req.method === "GET") {
        const since = url.searchParams.get("since") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Math.max(1, Math.min(200, Number(limitRaw))) : 50;
        const notifications = listNotifications({ since, limit });
        return Response.json({ ok: true, notifications });
      }
      {
        const m = url.pathname.match(/^\/notifications\/([A-Za-z0-9-]+)\/read\/?$/);
        if (m && req.method === "POST") {
          const found = markNotificationRead(m[1]!);
          return Response.json({ ok: true, found });
        }
      }
      if (url.pathname === "/notifications/read-all" && req.method === "POST") {
        const marked = markAllNotificationsRead();
        return Response.json({ ok: true, marked });
      }
      if (url.pathname === "/notifications/stream" && req.method === "GET") {
        // Dedicated SSE channel — separate from /events so a notification
        // subscriber doesn't have to grok the full kitchen-sink agent
        // event stream. Each new notification emits one
        //   event: notification
        //   data: <json>
        // frame. No replay; clients should GET /notifications first to
        // seed their state, then keep this open for live deltas.
        let unsub: (() => void) | null = null;
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const write = (line: string) => {
              try {
                controller.enqueue(enc.encode(line));
              } catch {
                /* client dropped */
              }
            };
            // Initial comment so the EventSource fires `onopen` and
            // proxies (nginx) flush headers without waiting for the
            // first event.
            write(`: notifications stream open\n\n`);
            unsub = subscribeNotifications((n: Notification) => {
              write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
            });
            // 25s keepalive — comments are ignored by EventSource but
            // keep the socket open through idle-timeout proxies.
            const keepalive = setInterval(() => write(`: keepalive\n\n`), 25_000);
            const cancel = () => {
              clearInterval(keepalive);
              if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
              try { controller.close(); } catch { /* ignore */ }
            };
            req.signal.addEventListener("abort", cancel);
          },
          cancel() {
            if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
          },
        });
      }

      // ── v2.7.31 secret backends — ADR 0012 multi-backend chain ──────────
      // These endpoints never return a secret VALUE. Only chain
      // configuration + per-key existence/origin metadata. Dashboard proxies
      // these under /api/secrets/*; Telegram's /secrets command reads
      // describeBackendChain() directly via master-notify-listener.
      //
      //   GET  /secrets/backends        → chain config + 1Password CLI status
      //   POST /secrets/test {key}      → { ok, key, exists, found_via }
      //   POST /secrets/cache/flush     → { ok, cleared } — wipes 1P cache
      if (url.pathname === "/secrets/backends" && req.method === "GET") {
        return Response.json({ ok: true, ...describeBackendChain() });
      }
      if (url.pathname === "/secrets/test" && req.method === "POST") {
        try {
          const body = (await req.json().catch(() => ({}))) as { key?: unknown };
          const key = typeof body.key === "string" ? body.key.trim() : "";
          if (!key) {
            return Response.json(
              { ok: false, error: "missing 'key' in request body" },
              { status: 400 },
            );
          }
          const result = await testSecret(key);
          return Response.json({ ok: true, ...result });
        } catch (err) {
          return Response.json(
            { ok: false, error: `test failed: ${(err as Error).message}` },
            { status: 500 },
          );
        }
      }
      if (url.pathname === "/secrets/cache/flush" && req.method === "POST") {
        const cleared = flushOnePasswordCache();
        return Response.json({ ok: true, cleared });
      }

      // ── /upstreams — pi-ai + pi-agent-core tracker (v2.7.25 Scope C) ────
      // ADR 0015 "always-latest" policy. The dashboard proxies these under
      // /api/upstreams; Telegram's /upstreams reads describeUpstreamState()
      // directly via master-notify-listener. Routes:
      //
      //   GET  /upstreams        → { ok, checked_at, results[], auto_update_enabled, auto_update_flag_path }
      //   POST /upstreams/check  → runs the watchdog once, returns the same shape
      if (url.pathname === "/upstreams" && req.method === "GET") {
        const state = describeUpstreamState();
        return Response.json({ ok: true, ...state });
      }
      if (url.pathname === "/upstreams/check" && req.method === "POST") {
        // Trigger a manual tick. Forward-declared above; null only in
        // the brief window between Bun.serve() returning and the
        // watchdog being armed a few lines below.
        if (!upstreamWatchdog) {
          return Response.json(
            { ok: false, error: "upstream watchdog not yet armed" },
            { status: 503 },
          );
        }
        try {
          await upstreamWatchdog.runNow();
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
        const state = describeUpstreamState();
        return Response.json({ ok: true, ...state });
      }

      // ── /memory/* — Evy Memory (Tier 3) operator surface (v2.7.23) ──────
      // The dashboard proxies these under /api/memory/*. Subpath
      // namespacing keeps the dashboard's existing /api/memory (Obsidian
      // vault status) untouched — that route only matches the bare path,
      // ours all live under /memory/<subpath>.
      //
      //   GET    /memory/search?query=...&team_id=...&kind=...&since=...&limit=N
      //   GET    /memory/recent?limit=N
      //   GET    /memory/stats
      //   POST   /memory/entries           body { content, kind?, team_id? }
      //   DELETE /memory/entries/:id
      //
      // All response bodies pass entries through redactEntryForEgress
      // before serialization. The on-disk DB is chmod 600, but the
      // dashboard endpoint is a real egress surface (anyone on the LAN
      // who reaches the dashboard host gets these), so we redact obvious
      // secrets (HMAC marks, sk-*, bearer tokens) on the way out.
      if (url.pathname === "/memory/search" && req.method === "GET") {
        const queryParam = url.searchParams.get("query") ?? undefined;
        const teamParam = url.searchParams.get("team_id");
        const kindParam = url.searchParams.get("kind") ?? undefined;
        const sinceParam = url.searchParams.get("since") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw
          ? Math.max(1, Math.min(200, Number(limitRaw)))
          : 50;
        // team_id="" → null (operator can search the unscoped tier)
        // team_id absent → undefined (all teams)
        const team_id =
          teamParam === null
            ? undefined
            : teamParam === ""
              ? null
              : teamParam;
        const entries = recallMemoryEntries({
          query: queryParam,
          team_id,
          kind: kindParam,
          since: sinceParam,
          limit,
        });
        return Response.json({
          ok: true,
          count: entries.length,
          entries: entries.map(redactEntryForEgress),
        });
      }
      if (url.pathname === "/memory/recent" && req.method === "GET") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw
          ? Math.max(1, Math.min(200, Number(limitRaw)))
          : 25;
        const entries = recallMemoryEntries({ limit });
        return Response.json({
          ok: true,
          count: entries.length,
          entries: entries.map(redactEntryForEgress),
        });
      }
      if (url.pathname === "/memory/stats" && req.method === "GET") {
        return Response.json({ ok: true, stats: memoryStats() });
      }
      if (url.pathname === "/memory/entries" && req.method === "POST") {
        let body: {
          content?: unknown;
          kind?: unknown;
          team_id?: unknown;
        };
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const content =
          typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          return Response.json(
            { ok: false, error: "content is required" },
            { status: 400 },
          );
        }
        const kind =
          typeof body.kind === "string" && body.kind.trim()
            ? body.kind.trim()
            : "operator-note";
        const team_id =
          typeof body.team_id === "string" && body.team_id.trim()
            ? body.team_id.trim()
            : null;
        const entry = recordMemoryEntry({
          role: "user",
          kind,
          content,
          team_id,
        });
        return Response.json(
          { ok: true, entry: redactEntryForEgress(entry) },
          { status: 201 },
        );
      }
      {
        const m = url.pathname.match(/^\/memory\/entries\/([A-Za-z0-9-]+)$/);
        if (m && req.method === "DELETE") {
          const found = deleteMemoryEntry(m[1]!);
          return Response.json(
            { ok: true, found },
            { status: found ? 200 : 404 },
          );
        }
      }

      // ── /memory/kernel/* — memory consciousness cycle controls ──────────
      // Memory Init #5 Phase 3. Reachable through the dashboard's existing
      // /api/memory/* proxy (dashboard/server.ts L5852) without any
      // dashboard-side changes — operator's `subctl memory kernel ...` CLI
      // verbs forward through the same path.
      //
      //   GET  /memory/kernel/status   → { ok, state, last_decisions[] }
      //   POST /memory/kernel/run-now  → { ok, result } (forces one cycle)
      //   POST /memory/kernel/pause    → { ok, paused: true }
      //   POST /memory/kernel/resume   → { ok, paused: false }
      if (url.pathname === "/memory/kernel/status" && req.method === "GET") {
        const state = getMemoryKernelState();
        const last = getMemoryKernelLastDecisions();
        return Response.json({
          ok: true,
          armed: TOOL_GATES.memory_kernel,
          state,
          reviewer_model: last.reviewer_model,
          last_decisions: last.decisions,
        });
      }
      if (url.pathname === "/memory/kernel/run-now" && req.method === "POST") {
        if (!TOOL_GATES.memory_kernel) {
          return Response.json(
            { ok: false, error: "memory_kernel gate is off — install + load Memori sidecar first" },
            { status: 503 },
          );
        }
        const entityId = (policy.operator.name ?? "operator").toLowerCase();
        try {
          const result = await runMemoryKernelCycle({ entity_id: entityId });
          return Response.json({ ok: result.ok, result });
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }
      if (url.pathname === "/memory/kernel/pause" && req.method === "POST") {
        pauseMemoryKernel();
        return Response.json({ ok: true, paused: true });
      }
      if (url.pathname === "/memory/kernel/resume" && req.method === "POST") {
        resumeMemoryKernel();
        return Response.json({ ok: true, paused: false });
      }

      // ── /memory/tier1/* — Tier 1 candidate queue (Memory Init #5 Phase 3) ─
      //
      //   GET  /memory/tier1/pending  → { ok, count, candidates[] }
      //   POST /memory/tier1/approve  → body {candidate_id, note?}; on success
      //                                 routes through memory_remember so the
      //                                 Tier 1 char-budget guardrails apply.
      //   POST /memory/tier1/reject   → body {candidate_id, note?}; resolves
      //                                 without touching memory.md.
      if (url.pathname === "/memory/tier1/pending" && req.method === "GET") {
        const pending = listTier1Pending();
        return Response.json({
          ok: true,
          count: pending.length,
          candidates: pending,
        });
      }
      if (url.pathname === "/memory/tier1/approve" && req.method === "POST") {
        let body: { candidate_id?: unknown; note?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const candidateId =
          typeof body.candidate_id === "string" ? body.candidate_id.trim() : "";
        if (!candidateId) {
          return Response.json(
            { ok: false, error: "candidate_id required" },
            { status: 400 },
          );
        }
        const note = typeof body.note === "string" ? body.note : undefined;
        try {
          const result = await approveTier1Candidate(candidateId, {
            resolved_by: "operator",
            note,
          });
          return Response.json(result, { status: result.ok ? 200 : 404 });
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }
      if (url.pathname === "/memory/tier1/reject" && req.method === "POST") {
        let body: { candidate_id?: unknown; note?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const candidateId =
          typeof body.candidate_id === "string" ? body.candidate_id.trim() : "";
        if (!candidateId) {
          return Response.json(
            { ok: false, error: "candidate_id required" },
            { status: 400 },
          );
        }
        const note = typeof body.note === "string" ? body.note : undefined;
        try {
          const result = rejectTier1Candidate(candidateId, {
            resolved_by: "operator",
            note,
          });
          return Response.json(result, { status: result.ok ? 200 : 404 });
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }

      // ── /memory/backfill/* — operator-invoked memory substrate backfill ──
      //
      // Ingest existing storage (evy.db, claude-mem, Obsidian vault) into
      // the new memory substrates. Each verb returns a BackfillResult shape
      // directly as JSON. Nothing here runs at boot — these only fire when
      // the operator hits the endpoint or runs `subctl memory backfill`.
      //
      //   POST /memory/backfill/evy-to-memori           body {dryRun?, limit?}
      //   POST /memory/backfill/claude-mem-to-cognee    body {dryRun?, limit?}
      //   POST /memory/backfill/obsidian-to-cognee      body {dryRun?, vault_path?}
      if (
        url.pathname === "/memory/backfill/evy-to-memori" &&
        req.method === "POST"
      ) {
        let body: { dryRun?: unknown; limit?: unknown; entity_id?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const dryRun = body.dryRun === true;
        const limit =
          typeof body.limit === "number" && body.limit > 0
            ? Math.floor(body.limit)
            : undefined;
        const entity_id =
          typeof body.entity_id === "string" && body.entity_id.trim()
            ? body.entity_id.trim()
            : (policy.operator.name ?? "operator").toLowerCase();
        try {
          const result = await backfillEvyMemoryToMemori({
            dryRun,
            limit,
            entity_id,
          });
          return Response.json(result);
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }
      if (
        url.pathname === "/memory/backfill/claude-mem-to-cognee" &&
        req.method === "POST"
      ) {
        let body: { dryRun?: unknown; limit?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const dryRun = body.dryRun === true;
        const limit =
          typeof body.limit === "number" && body.limit > 0
            ? Math.floor(body.limit)
            : undefined;
        try {
          const result = await backfillClaudeMemToCognee({ dryRun, limit });
          return Response.json(result);
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }
      if (
        url.pathname === "/memory/backfill/obsidian-to-cognee" &&
        req.method === "POST"
      ) {
        let body: { dryRun?: unknown; vault_path?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const dryRun = body.dryRun === true;
        const vault_path =
          typeof body.vault_path === "string" && body.vault_path.trim()
            ? body.vault_path.trim()
            : undefined;
        try {
          const result = await backfillObsidianToCognee({
            dryRun,
            vault_path,
          });
          return Response.json(result);
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
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
          const r = await fetch(`${host}/api/v0/models`, {
            headers: { ...lmstudioAuthHeader() },
            signal: AbortSignal.timeout(1500),
          });
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
      //                              (default 30000 per v2.7.3 policy;
      //                              50000 historical default kept as fallback
      //                              when caller passes nothing AND the
      //                              compact config also lacks target_tokens)
      //   keep_recent?: number    — minimum recent turns to preserve
      //                              (default 6)
      // Algorithm: start with keep_recent, then expand the "compact" set
      // backwards until estimated remaining tokens fits target_tokens.
      //
      // v2.7.3: delegated to compactTranscriptInline() which is the same
      // function the just-in-time gate and the 5min safety-net ticker both
      // call. Keeps one source of truth.
      if (url.pathname === "/transcript/compact" && req.method === "POST") {
        if (promptInFlight) {
          return Response.json({ ok: false, error: "agent busy — try again in a moment" }, { status: 409 });
        }
        let body: { target_tokens?: number; keep_recent?: number } = {};
        try { body = await req.json(); } catch { /* empty body is fine */ }
        const cfg = loadCompactConfig(COMPACT_CFG_PATH);
        const result = compactTranscriptInline({
          target_tokens: body.target_tokens ?? cfg.target_tokens ?? 50_000,
          keep_recent: body.keep_recent ?? cfg.keep_recent ?? 6,
          initiator: "operator",
        });
        if (!result.ok) {
          return Response.json(result, { status: 500 });
        }
        return Response.json(result);
      }

      // /transcript/util — current transcript utilization + active thresholds
      // for the dashboard banner. Pure read — does NOT trigger compaction.
      // Added in v2.7.3 so the banner can render the four-state model
      // (ok / warn / compacting / overflow) using server-side policy
      // decisions rather than recomputing util thresholds in the browser.
      if (url.pathname === "/transcript/util" && req.method === "GET") {
        const snap = await buildUtilSnapshot();
        return Response.json({ ok: true, ...snap });
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

      // v2.8.2 — Lifecycle hook called by the dashboard's
      // POST /api/orchestration/:name/kill (and /api/sessions/:name/kill)
      // immediately after `subctl session-kill` returns 0. Drops the
      // team from the watchdog tracking maps + archives its inbox file,
      // so the next watchdog tick won't escalate on a corpse. Internal
      // 127.0.0.1-only endpoint; no auth (matches /profile, /watchdogs,
      // etc. — same trust boundary).
      {
        const m = url.pathname.match(/^\/teams\/([^/]+)\/prune\/?$/);
        if (m && req.method === "POST") {
          const teamName = decodeURIComponent(m[1]!);
          const decision = pruneOneTeam(teamName, {
            teamLastActivity,
            teamNudgeState,
            teamPaneHash,
            teamReadOffsets,
            inboxDir: INBOX_DIR,
            // tmux runner is unused by pruneOneTeam (operator already
            // told us the session is gone), but the type requires it.
            tmux: inboxTmux,
          });
          if (decision) {
            broadcast("team_pruned", {
              ts: new Date().toISOString(),
              teams: [teamName],
              reason: "operator-initiated kill",
            });
            logDecision({
              project: "_master",
              action: "watchdog_pruned",
              rationale: `operator-killed ${teamName}; removed from staleness tracker${decision.inbox_archived ? "; inbox archived" : ""}`,
            });
          }
          return Response.json({
            ok: true,
            pruned: decision !== null,
            inbox_archived: decision?.inbox_archived ?? false,
          });
        }
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

      // ── Personality presets ─────────────────────────────────────────────
      // GET returns the active preset + the full preset catalog with previews
      // so the dashboard can render a picker. POST swaps the active preset
      // by writing personality.json — composeSystemPrompt() reads it fresh
      // on every prompt, so the change takes effect on the next turn with
      // no daemon restart.
      if (url.pathname === "/personality" && req.method === "GET") {
        return Response.json({
          ok: true,
          active: readActivePreset(),
          presets: describePersonalities(),
        });
      }
      if (url.pathname === "/personality" && req.method === "POST") {
        let body: { preset?: string };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
        }
        const result = setPersonalityPreset((body.preset ?? "").trim());
        if (!result.ok) {
          return Response.json(result, { status: 400 });
        }
        logDecision({
          project: "_master",
          action: "personality_set",
          rationale: `voice preset → ${result.preset}`,
        });
        broadcast("personality_set", {
          ts: new Date().toISOString(),
          preset: result.preset,
        });
        return Response.json({
          ok: true,
          active: result.preset,
          note: "takes effect on the next prompt — no restart needed",
        });
      }

      if (url.pathname === "/chat" && req.method === "POST") {
        let body: {
          text?: string;
          source?: "chat" | "telegram" | "watchdog";
          attachments?: string[];
        };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const text = (body.text ?? "").trim();
        const source = body.source ?? "chat";
        const attachmentIds = Array.isArray(body.attachments)
          ? body.attachments.filter((s): s is string => typeof s === "string" && s.length > 0)
          : [];
        if (!text && attachmentIds.length === 0) {
          return Response.json({ ok: false, error: "empty text and no attachments" }, { status: 400 });
        }

        // Resolve attachments → fenced <attachment>…</attachment> blocks
        // and prepend to the prompt the agent actually sees. The browser-
        // visible transcript will record just the metadata (handled in
        // dispatchToAgent's annotation path, future work; for now the
        // assistant sees the inline content + the user's text).
        let prompt = text;
        let resolvedAttachments: Array<{ id: string; filename: string; size: number }> = [];
        if (attachmentIds.length > 0) {
          const inj = inlineAttachmentBlocks(attachmentIds);
          if (inj.errors.length > 0) {
            return Response.json(
              { ok: false, error: "attachment resolution failed", details: inj.errors },
              { status: 400 },
            );
          }
          resolvedAttachments = inj.resolved;
          prompt = inj.text + (text ? "\n\n" + text : "");
        }

        // Fire and forget — caller subscribes to /events to watch the response stream.
        void dispatchToAgent(prompt, source);
        return Response.json(
          {
            ok: true,
            source,
            accepted_at: new Date().toISOString(),
            attachments: resolvedAttachments,
          },
          { status: 202 },
        );
      }

      // ── Attachments (Phase 3l) ──────────────────────────────────────────
      // POST /attachments — body: raw bytes. Headers carry metadata:
      //   X-Filename: original filename
      //   X-Mime:     mime type (optional; inferred from filename if omitted)
      //   X-Source:   one of "upload" | "paste" | "tool"
      if (url.pathname === "/attachments" && req.method === "POST") {
        // Browser sends X-Filename URL-encoded (handles unicode + special chars).
        // decodeURIComponent is safe to call on bare ASCII too.
        const rawFilename = req.headers.get("X-Filename") ?? "untitled.txt";
        let filename: string;
        try {
          filename = decodeURIComponent(rawFilename);
        } catch {
          filename = rawFilename;
        }
        const mime = req.headers.get("X-Mime") ?? undefined;
        const sourceHdr = req.headers.get("X-Source") ?? "upload";
        const validSources = new Set(["upload", "paste", "tool"]);
        const source = (validSources.has(sourceHdr) ? sourceHdr : "upload") as
          "upload" | "paste" | "tool";
        let buf: Buffer;
        try {
          const ab = await req.arrayBuffer();
          buf = Buffer.from(ab);
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
        const result = saveAttachment(buf, filename, mime, source);
        if (!result.ok) {
          return Response.json(result, { status: 400 });
        }
        return Response.json(
          {
            ok: true,
            attachment: {
              id: result.attachment!.id,
              filename: result.attachment!.filename,
              size: result.attachment!.size,
              mime: result.attachment!.mime,
              sha256: result.attachment!.sha256,
              created_at: result.attachment!.created_at,
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/attachments" && req.method === "GET") {
        const all = listAttachments();
        // Sort newest first, return metadata only.
        all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        return Response.json({
          ok: true,
          count: all.length,
          attachments: all.map((a) => ({
            id: a.id,
            filename: a.filename,
            size: a.size,
            mime: a.mime,
            source: a.source,
            created_at: a.created_at,
          })),
        });
      }
      {
        const m = url.pathname.match(/^\/attachments\/([a-f0-9]+)$/);
        if (m && req.method === "GET") {
          const id = m[1]!;
          const att = getAttachment(id);
          if (!att) {
            return Response.json({ ok: false, error: "not found" }, { status: 404 });
          }
          try {
            const buf = readFileSync(att.storage_path);
            return new Response(buf, {
              headers: {
                "Content-Type": att.mime,
                "Content-Disposition": `inline; filename="${att.filename}"`,
              },
            });
          } catch (err) {
            return Response.json(
              { ok: false, error: (err as Error).message },
              { status: 500 },
            );
          }
        }
        if (m && req.method === "DELETE") {
          const id = m[1]!;
          const r = deleteAttachment(id);
          return Response.json(r, { status: r.ok ? 200 : 404 });
        }
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

      // ── v2.8.0 voice layer routes ────────────────────────────────────
      // Dashboard + CLI hit these directly via the master HTTP surface.
      // The TTS server itself stays on 8789 and is never reached from the
      // browser; this layer brokers cache, redaction, and config.
      if (url.pathname === "/voice/render" && req.method === "POST") {
        let body: { text?: string; voice_id?: string };
        try {
          body = (await req.json()) as { text?: string; voice_id?: string };
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        const out = await renderVoice({
          text: body.text ?? "",
          voice_id: body.voice_id,
        });
        if (!out.ok) {
          // Disabled is a 200-with-ok:false — operator-facing state, not a server error.
          return Response.json(out, {
            status: out.error?.includes("disabled") ? 200 : 502,
          });
        }
        // Strip the absolute path before returning to the network.
        const { audio_path: _omit, ...rest } = out;
        void _omit;
        return Response.json(rest);
      }

      if (url.pathname === "/voice/status" && req.method === "GET") {
        const cfg = loadVoiceConfig();
        const probe = await probeTtsServer();
        return Response.json({
          ok: true,
          config: cfg,
          tts_reachable: probe.reachable,
          tts_url: probe.url,
          latency_ms: probe.ms ?? null,
          error: probe.error,
        });
      }

      if (url.pathname === "/voice/config" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        // Allowlist the fields the dashboard can set — drop anything else.
        const patch: Record<string, unknown> = {};
        for (const k of ["enabled", "default_voice_id", "model", "tts_server"]) {
          if (k in body) patch[k] = body[k];
        }
        const next = saveVoiceConfig(patch);
        return Response.json({ ok: true, config: next });
      }

      {
        const m = url.pathname.match(/^\/voice\/audio\/([a-f0-9]+\.[a-z0-9]+)$/i);
        if (m && req.method === "GET") {
          const hit = resolveCachedAudio(m[1]!);
          if (!hit) {
            return Response.json({ ok: false, error: "not found" }, { status: 404 });
          }
          try {
            const buf = readFileSync(hit.path);
            const ctype = hit.format === "wav" ? "audio/wav" : "audio/mpeg";
            return new Response(buf, {
              headers: {
                "Content-Type": ctype,
                "Cache-Control": "public, max-age=3600",
                "Content-Disposition": `inline; filename="evy.${hit.format}"`,
              },
            });
          } catch (err) {
            return Response.json(
              { ok: false, error: (err as Error).message },
              { status: 500 },
            );
          }
        }
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

  // ── notification Telegram push (v2.7.22) ───────────────────────────────
  // severity:"alert" notifications page the operator on Telegram. info /
  // warn stay in the dashboard tray only — the goal is to make the alert
  // surface itself selective so the operator can trust a Telegram buzz to
  // mean "you actually need to look at this". Subscribe AFTER the
  // listener arms; if master-notify.json isn't configured, sendTelegramOutbound
  // throws and we swallow it.
  subscribeNotifications((n: Notification) => {
    if (n.severity !== "alert") return;
    const txt = `🚨 ${n.title}\n\n${n.body}`;
    void sendTelegramOutbound(txt).catch((err) => {
      console.error(
        `[master] notification telegram push failed (${n.id}): ${(err as Error).message}`,
      );
    });
  });

  // v2.7.23 — record every notification (info/warn/alert) into Evy Memory.
  // Tomorrow when Evy boots, recallEntries({ kind: "notification" }) lets
  // her see what fired overnight without re-tailing the in-memory ring
  // buffer (which doesn't survive restart — that's by design for the
  // dashboard tray, but the memory store is exactly where surviving
  // signal belongs).
  subscribeNotifications((n: Notification) => {
    try {
      recordMemoryEntry({
        role: "event",
        kind: "notification",
        content: n.title,
        team_id: n.team_id ?? null,
        metadata: {
          notification_id: n.id,
          severity: n.severity,
          notification_kind: n.kind,
          body: n.body,
        },
      });
    } catch (err) {
      console.error(
        `[memory] notification record failed (${n.id}): ${(err as Error).message ?? err}`,
      );
    }
  });

  // ── watchdog ticker ────────────────────────────────────────────────────
  // Master's KPI is "keep projects moving forward". Periodically scan open
  // dev teams + tracked projects; if anything looks stuck (no lead report
  // recently, no git activity, etc.), synthesize a prompt so the agent can
  // decide what to do — ping the lead, escalate to Jason, take corrective
  // action. The actual scan logic gets richer as dev teams come online.
  //
  // Defaults were 5min interval / 60min staleness — too coarse during the
  // FOOTHOLD dogfood. Operator wants a 3–5 min pulse cadence: "It's keeping
  // a pulse, and 30 min is a long time to let things go." Tightened to
  // 3min interval / 15min staleness, which aligns with the dashboard's
  // row-colour thresholds (yellow at 15min, red at 30min) — watchdog
  // catches a team transitioning into "yellow" instead of waiting for red.
  // Operator can still override via policy.global_defaults.
  const watchdogIntervalMin = Math.max(
    1,
    policy.global_defaults.review_interval_minutes ?? 3,
  );
  const watchdogIntervalMs = watchdogIntervalMin * 60 * 1000;
  const stalenessThresholdMin =
    policy.global_defaults.stall_detection_minutes ?? 15;

  // Refresh teamLastActivity from real tmux pane content. Initially I
  // tried `tmux list-windows -F '#{window_activity}'` but that variable
  // tracks user-focus events (window selection, attach), NOT pane output
  // — so a detached worker continuously printing into its pane shows the
  // same window_activity for an hour. Diagnosed 2026-05-10 when /teams
  // reported 1h05m ago while the worker had clearly produced files
  // 5 minutes earlier.
  //
  // The reliable signal is capture-pane content. Hash the visible pane
  // for each session; if the hash changed since the last tick, that's
  // activity, bump the timestamp to now.
  // (teamPaneHash declaration hoisted to the inbox-setup block above
  // in v2.8.2 — the HTTP /teams/:name/prune route + first-scan
  // reconciliation need it at server-construction time.)
  async function refreshTeamActivityFromTmux() {
    try {
      // 1. Enumerate sessions whose names start with "claude-" (the
      //    subctl spawn naming convention).
      const ls = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"], {
        stdout: "pipe", stderr: "pipe",
      });
      if (ls.exitCode !== 0) return;
      const sessions = ls.stdout.toString().trim().split("\n").filter(
        (s) => s.startsWith("claude-"),
      );
      const now = Date.now();
      for (const session of sessions) {
        const cap = Bun.spawnSync(
          ["tmux", "capture-pane", "-p", "-t", `${session}:0`, "-S", "-50"],
          { stdout: "pipe", stderr: "pipe" },
        );
        if (cap.exitCode !== 0) continue;
        const content = cap.stdout.toString();
        // Cheap stable hash — Bun has Bun.hash but plain SDBM is fine
        // and lets this module stay portable.
        let h = 5381;
        for (let i = 0; i < content.length; i++) {
          h = ((h << 5) + h + content.charCodeAt(i)) | 0;
        }
        const hash = String(h);
        const prev = teamPaneHash.get(session);
        if (prev !== hash) {
          teamPaneHash.set(session, hash);
          const existing = teamLastActivity.get(session);
          // First time we see this session AND no inbox entry → seed
          // activity at now.
          if (!existing) {
            teamLastActivity.set(session, { ts: now });
          } else {
            // Bump only if our new "now" is later than existing — it
            // always is in practice, but defensively ordered.
            if (now > existing.ts) {
              teamLastActivity.set(session, { ts: now, lastEvent: existing.lastEvent });
            }
          }
        }
        // If hash unchanged, leave teamLastActivity alone — the worker
        // really is idle in the pane (might still be alive; the watchdog's
        // staleness threshold is what flags real concern).
      }

      // PRUNE dead sessions. Without this, the watchdog kept firing on
      // sessions the operator killed because their teamLastActivity entry
      // (set from the inbox seed event at spawn time) lingered forever.
      // Operator caught it 2026-05-10: "Looks like your watchdog is
      // kicking off even though you closed the tab out." Diagnosed: the
      // tmux session was gone but teamLastActivity still had it. Now: any
      // entry whose session name isn't in the live tmux list gets dropped.
      // Guarded — we only prune when the tmux query SUCCEEDED (exitCode
      // 0). If tmux is offline or broken, we leave teamLastActivity alone
      // rather than wiping it on a false negative.
      const liveSet = new Set(sessions);
      const removed: string[] = [];
      for (const team of [...teamLastActivity.keys()]) {
        // Only prune subctl-spawned sessions (claude-*). Other entries
        // might be there for reasons we don't model here.
        if (!team.startsWith("claude-")) continue;
        if (!liveSet.has(team)) {
          teamLastActivity.delete(team);
          teamPaneHash.delete(team);
          removed.push(team);
        }
      }
      if (removed.length > 0) {
        broadcast("team_pruned", {
          ts: new Date().toISOString(),
          teams: removed,
          reason: "tmux session no longer alive",
        });
        logDecision({
          project: "_master",
          action: "watchdog_pruned",
          rationale: `removed ${removed.length} dead team(s) from tracking: ${removed.join(", ")}`,
        });
      }
    } catch {
      // tmux not on PATH or no server running — skip silently. The
      // inbox-only signal still works as a fallback.
    }
  }

  // Diag-tool observability: system_watchdog_self surfaces these so the
  // master can answer "when did you last tick?" / "why did you last fire?"
  // without re-reading the JSONL decision log. Updated each tick below.
  let watchdogLastTickMs = 0;
  let watchdogLastFireMs = 0;
  let watchdogLastFireReason = "";
  bindWatchdogState(() => ({
    watching: [...teamLastActivity.entries()].map(([team, v]) => ({
      team_id: team,
      tmux_session_id: team,
      last_seen_ms: v.ts,
    })),
    last_tick_at_ms: watchdogLastTickMs,
    last_fire_at_ms: watchdogLastFireMs,
    last_fire_reason: watchdogLastFireReason,
    interval_minutes: watchdogIntervalMin,
    staleness_threshold_minutes: stalenessThresholdMin,
  }));

  // v2.7.22 — per-team auto-nudge state. The watchdog NO LONGER appends a
  // synthetic "[watchdog] ... decide whether to ping" prompt into the agent
  // transcript. Instead it attempts the cheap remediation itself — POST to
  // /api/orchestration/:name/msg (HMAC-authenticated via the dashboard's
  // existing route) — and only escalates to the operator via a `severity:
  // "alert"` notification if the team fails to respond within 30 min.
  //
  // The decision logic lives in ./auto-nudge.ts so it's unit-testable.
  // (teamNudgeState declaration hoisted to the inbox-setup block above
  // in v2.8.2 — the HTTP /teams/:name/prune route + first-scan
  // reconciliation need it at server-construction time.)
  // Re-nudge cadence — if a team is still stale 30 min after our last
  // nudge, the spec says fire an alert AND re-nudge.
  const NUDGE_RETRY_MS = 30 * 60_000;

  /**
   * POST the auto-nudge through the dashboard's /api/orchestration/:name/msg
   * route. That route applies the v2.7.20 HMAC trust marker, so the worker's
   * lead verifies this as a legitimate supervisor directive — same path the
   * master tool uses for subctl_orch_msg. Returns ok:false (without throwing)
   * when the dashboard is unreachable; the caller still records the nudge
   * attempt so we don't tight-loop on a downed dashboard.
   */
  async function sendAutoNudge(
    team: string,
    body: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(
        `${SUBCTL_API}/api/orchestration/${encodeURIComponent(team)}/msg`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: body, phase: "auto-nudge" }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (j.ok === false) return { ok: false, error: j.error ?? "unknown" };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function runWatchdogTick() {
    if (stopped) return;
    watchdogLastTickMs = Date.now();
    // Refresh from tmux first — workers may be productive without
    // writing to the inbox; window_activity captures keystrokes and
    // pane output regardless of whether the lead self-reported.
    await refreshTeamActivityFromTmux();

    // v2.8.2 — Per-team safety prune. refreshTeamActivityFromTmux's
    // bulk prune block can silently skip on tmux errors (no server
    // running, transient EAGAIN, list-sessions exit ≠ 0) — that was
    // one half of the 2026-05-18 stale-watchdog bug. Here we do a
    // direct `tmux has-session` for each tracked team and drop the
    // ones that are gone. Per-team `has-session` is cheap (single
    // exit-code check) and won't accidentally wipe everything if the
    // tmux server is down (it returns non-zero, we treat as gone,
    // which is safe: a wrongly-pruned live team will be re-seeded
    // by its next inbox event or pane capture).
    const safetyPruned = pruneVanishedTeams({
      teamLastActivity,
      teamNudgeState,
      teamPaneHash,
      teamReadOffsets,
      inboxDir: INBOX_DIR,
      tmux: inboxTmux,
      claudeOnly: true,
    });
    if (safetyPruned.length > 0) {
      broadcast("team_pruned", {
        ts: new Date().toISOString(),
        teams: safetyPruned.map((d) => d.team_id),
        reason: "tmux session no longer exists",
      });
      logDecision({
        project: "_master",
        action: "watchdog_pruned",
        rationale: `safety-net prune dropped ${safetyPruned.length} team(s): ${safetyPruned.map((d) => d.team_id).join(", ")}`,
      });
    }

    const now = Date.now();
    const teams: TeamSnapshot[] = [];
    for (const [team, v] of teamLastActivity) {
      teams.push({
        team_id: team,
        last_activity_ms: v.ts,
        last_event_type: v.lastEvent?.type,
      });
    }

    const actions = await runStaleTeamSweep({
      teams,
      state: teamNudgeState,
      cfg: {
        staleness_threshold_ms: stalenessThresholdMin * 60_000,
        nudge_retry_ms: NUDGE_RETRY_MS,
        now_ms: now,
      },
      staleness_threshold_min: stalenessThresholdMin,
      callbacks: {
        sendNudge: sendAutoNudge,
        emitInfo: (team_id, title, body) =>
          emitNotification({ kind: "team-nudge-sent", severity: "info", title, body, team_id }),
        emitAlert: (team_id, title, body) =>
          emitNotification({ kind: "team-unresponsive", severity: "alert", title, body, team_id }),
        logDecision: (team_id, action, rationale) =>
          logDecision({ project: team_id, action, rationale }),
        // v2.8.2 — Third line of defense: the sweep itself rechecks
        // tmux before deciding nudge/escalate. The safety-net prune
        // above ALREADY removed gone-teams from teamLastActivity, so
        // in practice this predicate only fires if a team's session
        // dies between the prune and this loop (microseconds).
        // Cheap belt-and-braces.
        teamRegistryExists: (team_id) => inboxTmux.hasSession(team_id),
        emitVanished: (team_id, title, body) =>
          // v2.8.2 — Low-noise info-level (not alert): the bug doc
          // explicitly calls for one quiet "stopped watching ..." event,
          // not another Telegram page. severity:info short-circuits the
          // telegram-push fanout in notifications.ts subscribers.
          emitNotification({ kind: "team-vanished", severity: "info", title, body, team_id }),
      },
    });

    const stale = actions.filter((a) => a.action !== "fresh");
    if (stale.length === 0) {
      broadcast("watchdog_ok", {
        ts: new Date().toISOString(),
        teams_tracked: teamLastActivity.size,
        stale: 0,
      });
      return;
    }
    const summary = stale
      .map(
        (a) =>
          `${a.team_id} (${Math.round(a.age_min)}min${a.last_event_type ? `, last=${a.last_event_type}` : ""}, action=${a.action})`,
      )
      .join(", ");
    watchdogLastFireMs = Date.now();
    watchdogLastFireReason = summary;
    // Still broadcast the SSE event so the dashboard's live-logs view + any
    // operator-facing observability surface can see "the watchdog DID fire,
    // and here's what it found." We just don't synthesize a prompt for the
    // agent anymore.
    broadcast("watchdog_fire", {
      ts: new Date().toISOString(),
      stale_count: stale.length,
      summary,
      action: "auto-nudge",
    });
  }

  const watchdog = setInterval(() => {
    touchWatchdog("team-staleness");
    void runWatchdogTick();
  }, watchdogIntervalMs);
  registerWatchdog({
    id: "team-staleness",
    kind: "team-staleness",
    kill: () => clearInterval(watchdog),
  });
  console.error(
    `[master] watchdog armed — interval=${watchdogIntervalMin}m, staleness_threshold=${stalenessThresholdMin}m`,
  );

  // ── scheduled-followup ticker ────────────────────────────────────────
  // The master can call schedule_followup() to back its "I'll check on
  // this in 15 minutes" promises with real timer state. This ticker
  // polls every 60s, fires any followups whose fire_at has passed, and
  // dispatches them as synthetic agent prompts (source="watchdog" so
  // they serialize through the same prompt queue as everything else,
  // with a [scheduled] prefix so the master can distinguish).
  async function runFollowupTick() {
    if (stopped) return;
    let due;
    try {
      due = popDueFollowups();
    } catch (err) {
      console.error(`[master] followup tick error: ${(err as Error).message}`);
      return;
    }
    if (due.length === 0) return;
    for (const fu of due) {
      const synthPrompt = `[scheduled] ${fu.summary}\n\n${fu.prompt}`;
      broadcast("scheduled_fire", {
        ts: new Date().toISOString(),
        id: fu.id,
        summary: fu.summary,
      });
      await dispatchToAgent(synthPrompt, "watchdog");
    }
  }
  const followupTicker = setInterval(() => {
    touchWatchdog("followup-scheduler");
    void runFollowupTick();
  }, 60_000);
  registerWatchdog({
    id: "followup-scheduler",
    kind: "followup-scheduler",
    kill: () => clearInterval(followupTicker),
  });
  console.error(`[master] scheduled-followup ticker armed — every 60s`);

  // ── auto-compact watchdog (v2.7.3: SAFETY NET) ─────────────────────────
  // v2.7.3 demoted this ticker from the primary gate to a safety net. The
  // primary gate is runJitCompactCheck() inside processOnePrompt — it runs
  // BEFORE every prompt is composed, so the supervisor never sees an
  // over-budget window during normal operation. The ticker remains because:
  //   1. Large tool outputs can land AFTER prompt composition and inflate
  //      the transcript before the next prompt arrives.
  //   2. Long idle periods could be ended by a Telegram burst — running
  //      the ticker every 5min keeps the transcript trimmed proactively.
  //
  // Uses the SAME decideCompactAction algorithm as the JIT gate so the two
  // paths can never disagree.
  //
  // v2.7.22 — bug fix: the boot-time early-fire used to call
  // runAutoCompactTick() WITHOUT touchWatchdog(), and the periodic
  // setInterval called touchWatchdog OUTSIDE the tick body. Net effect:
  // if the master was inspected within the first 5 min of boot the
  // watchdog reported last_tick_at: null even though the early-fire HAD
  // run, and any error inside the tick was a silent console.error rather
  // than an operator-visible notification. Restructured so the watchdog
  // freshness bump happens AT THE TOP of every tick path (early-fire +
  // periodic) and the tick body is wrapped in a try/catch that emits a
  // severity: "warn" notification on failure.
  let autoCompactInFlight = false;
  async function runAutoCompactTick() {
    // Freshness bump FIRST — operator's "is this watchdog alive?" query
    // must succeed on every tick path even if the rest of the function
    // bails early on stopped / autoCompactInFlight / promptInFlight.
    touchWatchdog("auto-compact");
    if (stopped || autoCompactInFlight || promptInFlight) return;
    let cfg: CompactConfig;
    try {
      cfg = loadCompactConfig(COMPACT_CFG_PATH);
    } catch (err) {
      emitNotification({
        kind: "auto-compact-error",
        severity: "warn",
        title: "auto-compact: config load failed",
        body: `loadCompactConfig threw: ${(err as Error).message}`,
      });
      return;
    }
    if (!cfg.auto_compact) return;
    autoCompactInFlight = true;
    try {
      const transcriptTokens = estimateTranscriptTokens(
        agent.state.messages as Array<{ content?: unknown }>,
      );
      const current = transcriptTokens + FIXED_PROMPT_OVERHEAD_TOKENS;
      const loadedCtx = await getSupervisorLoadedCtx(2000);
      const decision = decideCompactAction(current, loadedCtx ?? 0, cfg);
      if (decision.action !== "compact") return; // ticker only acts on hard compact
      console.error(
        `[master] safety-net compact (ticker): ${decision.reason} — compacting toward ${cfg.target_tokens.toLocaleString()} tok`,
      );
      const result = compactTranscriptInline({
        target_tokens: cfg.target_tokens,
        keep_recent: cfg.keep_recent,
        initiator: "ticker",
      });
      if (result.ok && !result.noop) {
        console.error(`[master] safety-net compact ok — archived ${result.archived_count}, kept ${result.kept_msgs}`);
      } else if (result.noop) {
        console.error(`[master] safety-net compact noop — ${result.message}`);
      } else {
        console.error(`[master] safety-net compact failed: ${result.error ?? "unknown"}`);
        emitNotification({
          kind: "auto-compact-error",
          severity: "warn",
          title: "auto-compact: compaction returned an error",
          body: `compactTranscriptInline failed: ${result.error ?? "unknown"}`,
        });
      }
    } catch (err) {
      console.error(`[master] safety-net compact error: ${(err as Error).message}`);
      emitNotification({
        kind: "auto-compact-error",
        severity: "warn",
        title: "auto-compact: tick threw",
        body: `runAutoCompactTick threw: ${(err as Error).message}`,
      });
    } finally {
      autoCompactInFlight = false;
    }
  }
  const autoCompactInterval = setInterval(() => {
    void runAutoCompactTick();
  }, 5 * 60 * 1000);
  registerWatchdog({
    id: "auto-compact",
    kind: "auto-compact",
    kill: () => clearInterval(autoCompactInterval),
  });
  // Also run shortly after boot so a freshly-restarted daemon catches an
  // already-bloated transcript without waiting 5 minutes. v2.7.22 lowered
  // this from 30s to 15s so the watchdog's last_tick_at lights up well
  // inside the operator-observable window (the tests assert <30s).
  // touchWatchdog now happens at the top of runAutoCompactTick itself, so
  // even this early fire counts as a real tick.
  setTimeout(() => void runAutoCompactTick(), 15_000);
  console.error("[master] auto-compact safety-net ticker armed — every 5min (PRIMARY gate is just-in-time, see runJitCompactCheck())");

  // ── verifier denial-cluster ticker (PR 6.5, HANDOFF_DIGEST D8) ─────────
  // Scans each team's recent audit entries every 30s. If a Gated worker is
  // hitting policy denials in clusters (>5 in 60s OR >3 of the same
  // rule_path in 5min), fire a synthetic [verifier] correction prompt at
  // the worker. See components/master/tools/policy/verifier-cluster.ts.
  const clusterTicker = startClusterTicker({
    onTick: () => touchWatchdog("verifier-cluster"),
  });
  registerWatchdog({
    id: "verifier-cluster",
    kind: "verifier-cluster",
    kill: () => clusterTicker.stop(),
  });
  console.error("[master] verifier denial-cluster ticker armed — interval=30s, burst=>5/60s, stuck=>3/5min");

  // ── upstream-check watchdog (v2.7.25 Scope C) ───────────────────────────
  // ADR 0015 declared pi-ai + pi-agent-core first-class upstreams under
  // an "always-latest" policy. This watchdog polls npm every 6h, emits
  // notifications when a newer version is available, and (when the
  // ~/.config/subctl/auto-update-upstreams.enabled flag is set)
  // attempts the upgrade itself with a bun install + bun test gate.
  // See components/master/upstream-check.ts.
  upstreamWatchdog = startUpstreamWatchdog({
    packageJsonPath: join(COMPONENT_DIR, "package.json"),
  });
  console.error("[master] upstream-check watchdog armed — interval=6h, packages=pi-ai + pi-agent-core");

  // ── graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.error(`[master] caught ${signal}, shutting down`);
    clearInterval(watchdog);
    clearInterval(followupTicker);
    clearInterval(autoCompactInterval);
    clearInterval(inboxPoll);
    clusterTicker.stop();
    try { upstreamWatchdog?.stop(); } catch { /* ignore */ }
    try { profilesWatcher.close(); } catch { /* ignore */ }
    try { voiceWatcher.close(); } catch { /* ignore */ }
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

// Only auto-boot when this file is the entrypoint (i.e. launched by
// launchd / `subctl master start`). Skipping this when imported lets the
// test suite pull in helpers like `getApiKeyForProvider` and
// `ensureModelLoaded` without spinning up the full daemon.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`[master] fatal:`, err);
    process.exit(1);
  });
}
