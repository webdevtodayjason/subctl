// subctl evy — the master daemon entry point.
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
// Lives at: /Users/you/code/subctl/components/evy/
// Started by: launchd plist (com.subctl.evy.plist) at boot
// Logs to:    /Users/you/Library/Logs/subctl/evy.log
// HTTP at:    127.0.0.1:8788 (configurable via SUBCTL_EVY_PORT) — kept on
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
import {
  getCaptureDiagnostics,
  getLastSupervisorUsage,
  installSupervisorUsageCapture,
  resolveRealPromptTokens,
} from "./supervisor-usage-capture";

// pi-ai's stream factory keeps a registry keyed by `model.api`. Built-in
// providers (anthropic-messages, openai-completions, openai-responses,
// google-generative-ai, …) are registered ONLY when this function is
// called — it's NOT a side-effect of `import`. Without this call, every
// agent.prompt() returns an empty content array because the agent loop
// looks up the api in the registry, finds nothing, and silently produces
// a no-op stream. Diagnosed 2026-05-09 after the daemon's first boot
// produced empty assistant responses while direct curl to LM Studio worked.
registerBuiltInApiProviders();

// v3.3.7 — Install the `globalThis.fetch` monkey-patch that captures
// `usage.prompt_tokens` from supervisor API responses. MUST run before
// any agent activity (pi-agent-core inherits whatever fetch is global at
// the time of its calls — but for safety we install before the first
// possible call site). pi-agent-core v0.74.0 doesn't expose usage on
// any public surface (verified by reading dist + scouting events), so
// the wrapper sniffs the SSE stream and the unary JSON body for the
// usage object. See components/evy/supervisor-usage-capture.ts.
installSupervisorUsageCapture();

import { subctlOrchTools } from "./tools/subctl-orch";
import { ghTools } from "./tools/gh";
import { coderabbitTools } from "./tools/coderabbit";
import { telegramTools, sendTelegramOutbound } from "./tools/telegram";
import { systemTools, bindToolRegistry as bindSystemToolRegistry } from "./tools/system";
import { projectTools } from "./tools/project";
import { memoryTools } from "./tools/memory";
import { context7Tools } from "./tools/context7";
import {
  tier1MemoryTools,
  buildMemoryBlock,
  readMemory as readTier1MemoryFile,
} from "./tools/tier1-memory";
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
import { listPendingFollowups } from "./tools/scheduler";
import {
  start as startCognitionLoop,
  WATCHDOG_ID as COGNITION_LOOP_WATCHDOG_ID,
  type StartResult as CognitionLoopStartResult,
} from "./consciousness-loop";
import {
  startIdlePaneWatchdog,
  defaultPaneProviders as defaultIdlePaneProviders,
  IDLE_PANE_WATCHDOG_ID,
  type IdlePaneStartResult,
} from "./idle-pane-watchdog";
import { attachmentsTools } from "./tools/attachments";
import { vaultLinkTools } from "./tools/vault-link";
import { policyTools } from "./tools/policy";
import {
  diagTools,
  bindWatchdogState,
  bindCogneePromotionState,
} from "./tools/diag";
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
} from "./evy-notify-listener";
import { startClusterTicker } from "./tools/policy/verifier-cluster";
import {
  decideCompactAction,
  estimateTranscriptTokens,
  loadCompactConfig,
  type CompactConfig,
  type CompactDecision,
} from "./compact-policy";
import {
  computeThresholdTokens as hermesComputeThresholdTokens,
  loadCompressionConfig as hermesLoadCompressionConfig,
  shouldCompress as hermesShouldCompress,
  type CompressionConfig as HermesCompressionConfig,
} from "./compression-policy";
import {
  compressTranscript as hermesCompressTranscript,
  type CompactableMessage as HermesCompactableMessage,
} from "./compression-compactor";
import { loadSecret, resolveSecret } from "./secrets";
import { registerMcpTools, startMcpServer } from "./mcp";
// v2.9.1 — Provider Model Catalog Phase 3: aggregator routing
import { fetchUpstreamCatalog } from "./aggregator-clients";
// ── v2.7.31 secret backends ──
import {
  describeBackendChain,
  testSecret,
  flushOnePasswordCache,
} from "./secrets-backends";
// ── v2.8.7 openai-codex OAuth (ChatGPT Pro subscription) ──
import { getCodexAccessToken } from "./openai-codex-auth";
// ── xAI Grok OAuth (SuperGrok Subscription) ──
import { getXaiOauthAccessToken, getXaiOauthBaseUrl } from "./xai-oauth-auth";
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
  recall as cogneeRecall,
  remember as cogneeRemember,
  resolveCogneeUrl,
} from "./cognee-client";
import {
  startPromotionTicker as startCogneePromotionTicker,
  resolvePromotionIntervalMs as resolveCogneePromotionIntervalMs,
  getState as getCogneePromotionState,
  isPromotionArmed as isCogneePromotionArmed,
  _setDepsForTesting as _setCogneePromotionDepsForTesting,
} from "./cognee-promotion";
import {
  health as memoriHealth,
  resolveMemoriUrl,
  recall as memoriRecall,
  type MemoriHit,
  type MemoriRecallInput,
  type MemoriResult,
} from "./memori-client";
import {
  hydrateContext,
  loadContextHydrationConfig,
  type ContextHydrationConfig,
  type CogneeHit as ContextHydrationCogneeHit,
  type MemoriCuratedRow as ContextHydrationCuratedRow,
} from "./context-hydration";
import { probeWithRetry } from "./probe-with-retry";
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
  consolidate as tier1Consolidate,
  type ConsolidatorDeps as Tier1ConsolidatorDeps,
} from "./tier1-consolidator";
import {
  classifyWorkerReply,
  runStaleTeamSweep,
  type ClassifiedReply,
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
  readUpdateHistory,
  runManualUpdate,
  setAutoUpdateEnabled,
  isAutoUpdateEnabled,
  type UpstreamWatchdogHandle,
  type AuditEntry,
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
// ── v2.8.13 Provider Model Catalog Phase 4: local backend adapters ──
import {
  getAdapter as getLocalBackendAdapter,
  listAvailableBackends as listLocalBackendKinds,
  type LocalBackendKind,
} from "./local-backends";
// ── v3.1.0 Kernel Fitness Phase 1: engagement instrumentation (write-only). ──
// Surface emission for chat responses + watchdog-registered timeout
// sweeper for un-engaged surfaces. This module is structurally a
// writer — no reader API is imported here or anywhere else along
// the supervisor-prompt path. The negative-criterion red-team test
// in `__tests__/engagement-ledger-isolation.test.ts` enforces this.
import {
  hashPayload,
  makeSurfaceId,
  recordSurfaceEmitted,
  runTimeoutSweeper as runEngagementTimeoutSweeper,
} from "./engagement-tracker";
// ── v3.3.0 Kernel Fitness Phase 2: fitness writer (write-only). ────────
// Pure data-plane roll-up of engagement-ledger + decisions.jsonl +
// consciousness-loop audit into hourly fitness-ledger.jsonl entries.
// Same isolation discipline as Phase 1: no reader API, no supervisor-
// prompt path touches this module. Red-team test in
// `__tests__/fitness-ledger-isolation.test.ts` enforces both layers.
import {
  writeFitnessWindow as runFitnessWindow,
} from "./fitness-writer";

const HOME = homedir();
const COMPONENT_DIR = import.meta.dir;
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const EVY_STATE_DIR = join(SUBCTL_CONFIG_DIR, "evy");
const MASTER_LOG = join(HOME, "Library", "Logs", "subctl", "evy.log");

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
// logic here. Mirrors components/evy/tools/subctl-orch.ts.
const SUBCTL_API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

const PROVIDERS_PATH = join(EVY_STATE_DIR, "providers.json");
const POLICY_PATH = join(EVY_STATE_DIR, "policy.json");
const STATE_PATH = join(EVY_STATE_DIR, "state.json");
const AGENT_STATE_PATH = join(EVY_STATE_DIR, "agent-state.json");
const DECISIONS_LOG = join(EVY_STATE_DIR, "decisions.jsonl");
const SKILL_PATH = join(COMPONENT_DIR, "..", "skills", "evy", "SKILL.md");

// ─── boot probe ─────────────────────────────────────────────────────────────

function ensureConfigFiles(): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Ensure state dir exists
  mkdirSync(EVY_STATE_DIR, { recursive: true });

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
  // `escalate` and `fallback` are operator-config slots that are NOT
  // currently read by the daemon (verified 2026-05-14 audit). Left as
  // optional so existing providers.json files with these blocks still
  // parse. The `fallback: { provider: "anthropic", ... }` pattern is
  // explicitly forbidden by buildModel()'s anthropic guard — see ADR 0019.
  escalate?: { provider: string; model: string; auth?: string };
  fallback?: { provider: string; model: string; auth?: string };
  routing_policy?: Record<string, string>;
  memory_budget_gb?: { target: number; ceiling: number };
  // v2.8.13 Phase 4 — single source of truth for local-inference backend.
  // When a role's provider is "local", the role's effective dispatch (host,
  // model, kind) is resolved from this block via resolveRoleCfg(). Seeded
  // on first boot from any pre-existing lmstudio/ollama/mlx/omlx/vllm role.
  local_backend?: {
    kind: LocalBackendKind;
    host: string;
    models: Partial<Record<string, string | null>>;
    last_verified?: string | null;
  };
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
  // presence (URL override OR auth token) OR the launchd plist existing
  // (operator ran `subctl cognee install`). Actual reachability is
  // probed async post-boot and logged. Plist-presence matches the
  // memori gate below: the operator-installed-it signal is enough for
  // the gate to flip, even before a token is wired.
  cognee:
    hasSecretOrEnv("COGNEE_AUTH_TOKEN", "cognee_auth_token") ||
    (process.env.COGNEE_SERVICE_URL ?? "").trim().length > 0 ||
    (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const path = require("node:path") as typeof import("node:path");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const os = require("node:os") as typeof import("node:os");
        return fs.existsSync(
          path.join(os.homedir(), "Library", "LaunchAgents", "com.subctl.cognee.plist"),
        );
      } catch {
        return false;
      }
    })(),
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
  `[evy] tool gates: ${Object.entries(TOOL_GATES).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`,
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
  // system at components/evy/knowledge/subctl.toon. Operator uses TOON
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
      // see components/evy/circuit-breaker.ts for the trigger
      // condition + reset semantics. Logs to stderr at warn level so
      // the operator can grep evy.log for circuit-breaker trips.
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
  // Local OpenAI-compatible runtimes (mlx, ollama, lmstudio, vllm, omlx…)
  // all speak the OpenAI Chat Completions wire format.
  mlx: "openai-completions",
  ollama: "openai-completions",
  lmstudio: "openai-completions",
  vllm: "openai-completions",
  // v2.8.13 Phase 4 — oMLX (jundot/omlx) joins as a first-class local
  // backend. Same wire format as the others.
  omlx: "openai-completions",
  // OpenRouter — unified gateway for hundreds of models (incl. a free preview
  // tier). OpenAI-compat wire format at https://openrouter.ai/api/v1. Model
  // IDs use vendor/name (e.g. "anthropic/claude-sonnet-4", "openai/gpt-5.2").
  // Auth via openrouter_api_key (secrets.json) / OPENROUTER_API_KEY (env). The
  // optional attribution headers (HTTP-Referer, X-OpenRouter-Title) are
  // intentionally NOT injected in v2.7.17 — operators stay anonymous on the
  // OpenRouter leaderboard. If we ever want attribution that's a separate
  // change in pi-ai's openai-completions header pipeline.
  openrouter: "openai-completions",
  // xAI Grok via SuperGrok OAuth — api.x.ai/v1 is OpenAI-compatible, so the
  // openai-completions transport reaches it cleanly. The OAuth-issued JWT is
  // supplied per-turn by getApiKeyForProvider's "xai-oauth" branch (which
  // routes through xai-oauth-auth.ts's sync resolver). pi-ai's `KnownProvider`
  // union doesn't include "xai-oauth" today, so callers that need the
  // unioned type at compile time cast at the call site — runtime dispatch
  // is purely string-keyed off this table.
  "xai-oauth": "openai-completions",
};

// Module-level dedup so the anthropic guard's loud alert (notification +
// Telegram + log line) fires once per unique provider+model per boot.
// buildModel can be called multiple times across roles + profile swaps;
// we don't want to spam the operator if the guard trips on every role.
const _anthropicGuardSeen = new Set<string>();

export function buildModel(cfg: {
  provider: string;
  model: string;
  host?: string;
  max_tokens?: number;
}): Model<string> {
  // ─── Anthropic provider guard (ADR 0019, 2026-05-14) ────────────────────
  // pi-agent-core is an Agent-SDK-shaped harness. Per Anthropic's policy
  // change taking effect 2026-06-15, programmatic/Agent-SDK traffic bills
  // against the $200/mo Agent SDK credit, NOT against the operator's
  // Max 20× subscription — regardless of any `auth: max-subscription`
  // hint in providers.json. Under master's tick cadence (60s watchdog +
  // 60s followup ticker + auto-compact + inbox poll + chat) this would
  // exhaust the monthly credit in days and start drawing extra-usage
  // charges. The Anthropic provider is therefore HARD-FAILED at model
  // construction unless the operator has deliberately set
  // SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1 in the launchd plist.
  //
  // Defense in depth: even when allowed, fire a one-shot loud alert
  // (notification + Telegram + log line with `[ANTHROPIC-API-GUARD]`
  // prefix) so accidental activation is visible immediately, not from
  // a billing alert weeks later.
  if (cfg.provider === "anthropic") {
    const allowed = process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER === "1";
    const dedupKey = `${cfg.provider}:${cfg.model}:${allowed ? "armed" : "blocked"}`;
    if (!_anthropicGuardSeen.has(dedupKey)) {
      _anthropicGuardSeen.add(dedupKey);
      const verdict = allowed ? "ARMED (env opt-in)" : "BLOCKED";
      console.error(
        `[evy][ANTHROPIC-API-GUARD] buildModel called with provider="anthropic" model="${cfg.model}" host="${cfg.host ?? "(default)"}" — ${verdict}`,
      );
      const title = allowed
        ? `Anthropic provider ARMED (${cfg.model})`
        : `Anthropic provider BLOCKED (${cfg.model})`;
      const body = allowed
        ? `An agent role just built a Model<anthropic/${cfg.model}>. SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1 is set, so the call is going through. Under master's tick cadence this can burn the $200/mo Agent SDK credit in days and then start charging extra usage. Confirm this was intentional. See ADR 0019.`
        : `An agent role tried to build a Model<anthropic/${cfg.model}>. Blocked by ADR 0019 (no Anthropic provider in master). pi-agent-core traffic is Agent-SDK-shaped and would bill the $200/mo credit, not Max 20×. To override deliberately, set SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1 in the launchd plist EnvironmentVariables after reading DECISIONS.md + docs/adr/0019.`;
      // emitNotification is in-process (ring buffer + subscribers) — always
      // safe to fire, including from tests. Tests assert on the ring.
      try {
        emitNotification({
          kind: allowed
            ? "anthropic-provider-armed"
            : "anthropic-provider-blocked",
          severity: "alert",
          title,
          body,
          metadata: {
            provider: cfg.provider,
            model: cfg.model,
            host: cfg.host ?? null,
            allowed,
          },
        });
      } catch (err) {
        console.error(
          `[evy][ANTHROPIC-API-GUARD] emitNotification failed: ${(err as Error).message}`,
        );
      }
      // External side effects (real Telegram push + decisions.jsonl append)
      // are gated behind SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS so a test run on
      // an operator's machine doesn't blast their Telegram bot or pollute
      // their decisions log. Production never sets this; the
      // anthropic-provider-guard.test.ts suite sets it in beforeEach.
      // Suppressing these does NOT affect the throw — the safety guarantee
      // (refuse to build the Model) is unconditional.
      const skipExternal =
        process.env.SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS === "1";
      if (!skipExternal) {
        void sendTelegramOutbound(`🚨 ${title}\n\n${body}`).catch(
          (err: unknown) => {
            console.error(
              `[evy][ANTHROPIC-API-GUARD] Telegram alert failed: ${(err as Error)?.message ?? String(err)}`,
            );
          },
        );
        try {
          logDecision({
            project: "_master",
            action: allowed
              ? "anthropic_provider_armed"
              : "anthropic_provider_blocked",
            rationale: `buildModel(provider=anthropic, model=${cfg.model}, host=${cfg.host ?? "(default)"}) — verdict=${verdict}. SUBCTL_ALLOW_ANTHROPIC_PROVIDER=${process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER ?? "(unset)"}.`,
          });
        } catch (err) {
          console.error(
            `[evy][ANTHROPIC-API-GUARD] logDecision failed: ${(err as Error).message}`,
          );
        }
      }
    }
    if (!allowed) {
      throw new Error(
        `Anthropic provider blocked by ADR 0019. pi-agent-core calls to provider=anthropic bill against the $200/mo Agent SDK credit (Anthropic policy 2026-06-15+), not Max 20×. Master's tick cadence would burn the credit in days. To override deliberately, set SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1 in the launchd plist EnvironmentVariables and bounce master. See DECISIONS.md → "No Anthropic provider in master" and docs/adr/0019.`,
      );
    }
  }

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
      // CodeRabbit pass-11 (2): pick the provider-correct defaultHost. Pass-9
      // added `omlx` to LOCAL_PROVIDERS for the auth-sentinel path, but this
      // shared :1234 fallback still routed hostless omlx (and ollama) configs
      // to LM Studio's port. Prefer the adapter's declared defaultHost for
      // first-class LocalBackendKinds (lmstudio/ollama/omlx); fall through to
      // the legacy LM Studio default for mlx/vllm tags that aren't adapters
      // (they speak the OpenAI-compatible dialect well enough to ride it).
      LOCAL_PROVIDERS.has(cfg.provider) ? (
        (cfg.provider === "omlx" || cfg.provider === "ollama" || cfg.provider === "lmstudio")
          ? getLocalBackendAdapter(cfg.provider as LocalBackendKind).defaultHost
          : "http://localhost:1234/v1"
      ) :
      cfg.provider === "openrouter" ? "https://openrouter.ai/api/v1" :
      cfg.provider === "xai-oauth" ? getXaiOauthBaseUrl() :
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
// v2.8.13 Phase 4 — `omlx` added so resolveRoleCfg-rewritten roles
// (provider: "local" → kind from local_backend) flow through the
// "not-needed" auth sentinel + local baseUrl default like the other
// OpenAI-compatible local runtimes.
export const LOCAL_PROVIDERS = new Set(["mlx", "ollama", "lmstudio", "vllm", "omlx"]);
export function getApiKeyForProvider(provider: string): string | undefined {
  if (provider === "lmstudio") {
    return resolveSecret("lmstudio_api_token") ?? "not-needed";
  }
  if (provider === "omlx") {
    // oMLX supports optional `--api-key` server-side auth. When the
    // operator runs `omlx serve --api-key …`, every request needs an
    // `Authorization: Bearer <token>` header. Resolution mirrors the
    // LM Studio chain — env (`OMLX_API_TOKEN`, via envVarFor's uppercase
    // fallback) beats `~/.config/subctl/secrets.json#omlx_api_token`
    // beats the "not-needed" sentinel for localhost-bypass deployments.
    return resolveSecret("omlx_api_token") ?? "not-needed";
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
    // "No API key for provider: openai-codex" with a clear evy.log
    // breadcrumb from openai-codex-auth.ts above it.
    //
    // Refresh-on-near-expiry / refresh-on-401 is a tracked follow-up.
    return getCodexAccessToken();
  }
  if (provider === "xai-oauth") {
    // xAI Grok via SuperGrok OAuth. The resolver in xai-oauth-auth.ts is
    // sync (pi-ai's getApiKey hook is sync) and kicks a background refresh
    // when the JWT is within 120s of expiry — the deduped in-flight map
    // means N concurrent chat turns share ONE refresh fetch. The base URL
    // is wired into buildModel above via getXaiOauthBaseUrl().
    return getXaiOauthAccessToken();
  }
  // Fall through — pi-ai handles real providers via env vars / OAuth
  return undefined;
}

// v2.8.13 Phase 4 — set of provider IDs that the migration treats as
// "this role currently points at a local runtime, fold it into
// local_backend". Includes legacy aliases the operator may have in their
// providers.json (`mlx`, `vllm`) plus the three first-class backends.
export const LEGACY_LOCAL_PROVIDER_IDS = new Set([
  "lmstudio",
  "ollama",
  "omlx",
  "mlx",
  "vllm",
]);

/**
 * Map a legacy/operator-typed provider string to a first-class
 * LocalBackendKind. `mlx` and `vllm` aren't first-class adapters; we fold
 * them into LM Studio per the Phase 4 spec (mlx was the operator's
 * dead-config bite — they didn't intentionally pick MLX).
 *
 * CodeRabbit pass-9 (3): optional `host` arg for migration disambiguation.
 * Operators running real oMLX with a legacy `mlx`/`vllm` provider tag get
 * mislabeled as `lmstudio` and their daemon probes LM Studio endpoints
 * against an oMLX server forever (`last_verified` stays null). When the
 * host clearly points at oMLX's default port (:8000) we treat the legacy
 * tag as `omlx` instead. Hosts without :8000 still map to `lmstudio` for
 * back-compat (vllm/mlx commonly proxied behind other ports speak the
 * LM Studio OpenAI-compatible dialect well enough to ride that adapter).
 */
export function mapToLocalBackendKind(
  p: string,
  host?: string | null,
): LocalBackendKind | null {
  if (p === "lmstudio" || p === "ollama" || p === "omlx") return p;
  if (p === "mlx" || p === "vllm") {
    if (host && /:8000(\/|$)/.test(host)) return "omlx";
    return "lmstudio";
  }
  return null;
}

/**
 * Normalize a role-model value coming from POST /local-backend or its
 * tests. CodeRabbit pass-9 (2) — hoisted from the POST handler so the
 * helper has one home and the test suite imports it instead of cloning.
 * Invariant (pass-1): non-string → null; empty/whitespace string → null;
 * otherwise the trimmed string.
 */
export function normalizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Merge a prior `local_backend.models` map with an incoming partial.
 * CodeRabbit pass-9 (2) — hoisted from POST /local-backend so the
 * presence-check semantics from pass-4 (b) have one home.
 *
 * Semantics:
 *   - key present in `incoming` (even when null) → honor incoming
 *   - key absent from `incoming`                 → fall back to prev
 *   - `normalizeModel` applies in both branches (type / empty-string
 *     sanitization is the pass-1 invariant).
 *
 * Output always carries the four standard role slots so persistence sees
 * a stable shape regardless of which subset the caller mutated.
 */
export function mergeModels(
  prev: Partial<Record<string, string | null>>,
  incoming: Record<string, unknown>,
): Record<string, string | null> {
  const pick = (
    role: "supervisor" | "reviewer" | "embeddings" | "router",
  ): string | null => {
    if (Object.prototype.hasOwnProperty.call(incoming, role)) {
      return normalizeModel(incoming[role]);
    }
    return normalizeModel(prev[role]);
  };
  return {
    supervisor: pick("supervisor"),
    reviewer: pick("reviewer"),
    embeddings: pick("embeddings"),
    router: pick("router"),
  };
}

/**
 * Pre-resolve a role's effective dispatch config. When provider === "local"
 * we look up providers.local_backend and rewrite provider/host/model from
 * the local-backend block. Every downstream reader (buildModel,
 * getApiKeyForProvider, ensureModelLoaded, /diag probes) only sees concrete
 * provider strings — no "local" leaks into pi-ai dispatch.
 */
export function resolveRoleCfg(
  role: string,
  raw: { provider: string; model: string; host?: string; context_length?: number; max_tokens?: number },
  providers: Pick<Providers, "local_backend">,
): { provider: string; model: string; host?: string; context_length?: number; max_tokens?: number } {
  if (raw.provider !== "local") return raw;
  const lb = providers.local_backend;
  if (!lb) {
    // Spec invariant: provider="local" requires a local_backend block.
    // Failure mode is loud — silently falling back to the raw cfg would
    // hide a broken migration.
    throw new Error(
      `role ${role} has provider="local" but providers.local_backend is missing`,
    );
  }
  // CodeRabbit pass-6 (a): presence-check semantics so an explicit `null`
  // in `lb.models[role]` is honored as "operator cleared this role" rather
  // than treated as missing and silently falling back to `raw.model`. The
  // legacy `lb.models?.[role] ?? raw.model` defeated the pass-4 (b) fix that
  // taught the POST /local-backend handler to persist null when the
  // operator clears a model in Settings — resolveRoleCfg would then ignore
  // the cleared state and keep using the stale providers.models.<role>.model
  // from before the local_backend migration. Now:
  //   - key present in lb.models (even when null) → honor that value
  //   - key absent → fall back to raw.model (legacy migration safety net)
  const model =
    lb.models && Object.prototype.hasOwnProperty.call(lb.models, role)
      ? lb.models[role]
      : raw.model;
  if (!model) {
    throw new Error(
      `role ${role}: providers.local_backend.models.${role} is null and role.model is empty — pick a model in Settings → Local Inference Backend`,
    );
  }
  return {
    ...raw,
    provider: lb.kind,
    host: lb.host,
    model,
  };
}

/**
 * First-boot migration. If providers.local_backend is missing AND any role
 * still carries a legacy local-provider string (lmstudio/ollama/mlx/omlx/
 * vllm), seed local_backend from the most common candidate (preferring LM
 * Studio per the Phase 4 spec) and rewrite affected roles to
 * provider: "local". Idempotent — re-running is a no-op once seeded.
 *
 * Returns true when a migration was applied (caller persists + logs).
 */
export function migrateLocalBackend(providers: Providers): {
  migrated: boolean;
  picked: { kind: LocalBackendKind; host: string } | null;
  rewrittenRoles: string[];
} {
  if (providers.local_backend) {
    return { migrated: false, picked: null, rewrittenRoles: [] };
  }
  const candidates: Array<{ kind: LocalBackendKind; host: string; role: string }> = [];
  for (const [role, cfg] of Object.entries(providers.models)) {
    if (!cfg || typeof cfg !== "object") continue;
    const p = (cfg as { provider?: string }).provider;
    if (!p || !LEGACY_LOCAL_PROVIDER_IDS.has(p)) continue;
    // CodeRabbit pass-9 (3): pass the role's host so legacy `mlx`/`vllm`
    // on :8000 disambiguates to omlx instead of falling back to lmstudio.
    // Operators running real oMLX with a legacy provider tag previously
    // ended up with kind="lmstudio" and a dead config — the daemon
    // probed LM Studio endpoints against oMLX forever.
    const cfgHost = (cfg as { host?: string }).host;
    const kind = mapToLocalBackendKind(p, cfgHost);
    if (!kind) continue;
    const h = cfgHost ?? getLocalBackendAdapter(kind).defaultHost;
    candidates.push({ kind, host: h, role });
  }
  if (candidates.length === 0) {
    return { migrated: false, picked: null, rewrittenRoles: [] };
  }
  // Prefer LM Studio when any role pointed there; otherwise first candidate.
  const pick = candidates.find((c) => c.kind === "lmstudio") ?? candidates[0]!;
  // Operators sometimes had two LM Studio instances on different ports
  // (the live providers.json on 2026-05-16 had reviewer @ :8000 and
  // embeddings @ :1234). Phase 4 collapses to ONE host — log the lossy
  // migration so the operator sees what got dropped and can fix via the
  // dashboard's Local Inference Backend section.
  const distinctHosts = Array.from(
    new Set(candidates.map((c) => c.host)),
  );
  if (distinctHosts.length > 1) {
    console.error(
      `[evy] WARN local_backend migration: ${candidates.length} local-role(s) used ${distinctHosts.length} different hosts (${distinctHosts.join(", ")}); folding into ${pick.host}. Verify in dashboard → Settings → Local Inference Backend.`,
    );
  }
  providers.local_backend = {
    kind: pick.kind,
    host: pick.host,
    models: { supervisor: null, reviewer: null, embeddings: null, router: null },
    last_verified: null,
  };
  const rewrittenRoles: string[] = [];
  for (const [role, cfg] of Object.entries(providers.models)) {
    if (!cfg || typeof cfg !== "object") continue;
    const p = (cfg as { provider?: string }).provider;
    if (!p || !LEGACY_LOCAL_PROVIDER_IDS.has(p)) continue;
    const m = (cfg as { model?: string }).model;
    if (m) {
      (providers.local_backend.models as Record<string, string | null>)[role] = m;
    }
    (cfg as { provider: string }).provider = "local";
    rewrittenRoles.push(role);
  }
  return { migrated: true, picked: { kind: pick.kind, host: pick.host }, rewrittenRoles };
}

/**
 * Persist providers.json. Mirrors the dashboard's /api/master/supervisor
 * write pattern (writeFileSync(providersPath, JSON.stringify(_, null, 2))).
 * Stays in master so the adapter and migration can call it without
 * duplicating the path logic.
 */
function persistProviders(providers: Providers): void {
  writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2));
}

/**
 * ensureModelLoaded — delegates to the LocalBackendAdapter for the role's
 * resolved provider. Master keeps the role-default ctx map (policy) and
 * the cloud-skip; the adapter owns the protocol (LM Studio's load/unload
 * dance, or no-op for Ollama/oMLX).
 *
 * Accepts the RAW role cfg — local resolution happens here, so callers
 * (boot pin loop, /reload-supervisor, profile-swap) don't need to know
 * the local-backend block exists.
 */
export async function ensureModelLoaded(
  cfg: { provider: string; model: string; host?: string; context_length?: number },
  role: string,
  providersForResolve?: Pick<Providers, "local_backend">,
): Promise<{ ok: boolean; detail: string }> {
  const resolved = providersForResolve
    ? resolveRoleCfg(role, cfg, providersForResolve)
    : cfg;
  // CodeRabbit pass-9 (3): pass host so a stray un-migrated `mlx`/`vllm`
  // role on :8000 picks the omlx adapter instead of LM Studio.
  const kind = mapToLocalBackendKind(resolved.provider, resolved.host);
  if (!kind) {
    return { ok: true, detail: `${role} is ${resolved.provider} (cloud) — no local load needed` };
  }
  const adapter = getLocalBackendAdapter(kind);
  if (!adapter.pinModel) {
    return { ok: true, detail: `${role} backend ${kind} has no pin endpoint — auto-load on first prompt` };
  }
  const desired = resolved.context_length ?? ROLE_DEFAULT_CONTEXT[role] ?? 0;
  const apiKey =
    kind === "lmstudio"
      ? resolveSecret("lmstudio_api_token")
      : kind === "omlx"
        ? resolveSecret("omlx_api_token")
        : null;
  const result = await adapter.pinModel(
    resolved.host ?? adapter.defaultHost,
    resolved.model,
    desired,
    { api_key: apiKey },
  );
  return {
    ok: result.ok,
    detail: `${role}=${resolved.model} (${kind}): ${result.detail}`,
  };
}

// ─── agent transcript persistence ──────────────────────────────────────────

// ── v2.8.11 — Phase 4: curated Tier 3 hydration helpers ──────────────────
//
// composeSystemPrompt prepends curated facts (consciousness-cycle output)
// ahead of Tier 1 so a fresh chat or post-compact transcript still sees
// what the reviewer promoted. Recall is async + the sidecar may be down;
// we factor the format / filter / fetch logic as pure helpers so:
//   - tests inject a stub `recall` to exercise success / unreachable / budget paths
//   - composeSystemPrompt (sync hot path) reads a TTL-cached text
//     populated by an async refresh
//
// Curated rows from services/memori/server.py /promote land with id
// prefix "curated_" (raw rows are "mem_*"). The /recall sidecar contract
// returns both kinds mixed; the prefix filter is the bright line.

export const CURATED_PROMPT_BUDGET_CHARS = 2000;
export const CURATED_PROMPT_TOP_K = 15;
export const CURATED_PROMPT_HEADER =
  "## Curated Tier 3 memory (consciousness-cycle output)\n\n";

/** Keep only rows promoted by the memory-kernel reviewer. */
export function filterCuratedHits(hits: MemoriHit[]): MemoriHit[] {
  return hits.filter(
    (h) => typeof h.id === "string" && h.id.startsWith("curated_"),
  );
}

/**
 * Render curated hits as a prompt-prepended section, never exceeding
 * `budgetChars`. When over budget, drop the LONGEST lines first so
 * concise facts survive. Returns "" for empty input (caller handles the
 * no-curated case by prepending nothing).
 */
export function formatCuratedSection(
  hits: MemoriHit[],
  budgetChars: number,
): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h) => {
    const tag = h.kind ? `[${h.kind}] ` : "";
    const ts = typeof h.ts === "string" && h.ts.length >= 10
      ? `${h.ts.slice(0, 10)} `
      : "";
    return `- ${ts}${tag}${h.text}`;
  });
  const render = (kept: string[]) =>
    kept.length === 0 ? "" : CURATED_PROMPT_HEADER + kept.join("\n") + "\n\n";

  let text = render(lines);
  if (text.length <= budgetChars) return text;

  // Drop longest lines first. Track by original index so we can
  // reconstruct ordering on the survivors.
  const indexed = lines.map((line, i) => ({ line, i }));
  const sorted = [...indexed].sort((a, b) => b.line.length - a.line.length);
  const dropped = new Set<number>();
  for (const { i } of sorted) {
    dropped.add(i);
    const remaining = lines.filter((_, idx) => !dropped.has(idx));
    text = render(remaining);
    if (text.length <= budgetChars) return text;
  }
  // Even the empty set would have returned via render(""); defensive
  // fallback: return the header alone if every line was dropped.
  return text.length <= budgetChars ? text : "";
}

/**
 * Pure helper: pull curated hits from Memori, filter, sort newest-first,
 * keep top-K, and format under the prompt budget. Returns "" on any
 * recall failure (sidecar unreachable, transport error, etc.) — the
 * caller never throws and never sees a partial section.
 */
export async function buildCuratedPromptSection(deps: {
  recall: (
    input: MemoriRecallInput,
  ) => Promise<MemoriResult<{ hits: MemoriHit[] }>>;
  entityId: string;
  budgetChars?: number;
  topK?: number;
}): Promise<string> {
  const budget = deps.budgetChars ?? CURATED_PROMPT_BUDGET_CHARS;
  const topK = deps.topK ?? CURATED_PROMPT_TOP_K;
  // top_k=50 widens the candidate window so the prefix-filter has
  // material to pick from; topK then trims down for the prompt budget.
  let result: MemoriResult<{ hits: MemoriHit[] }>;
  try {
    result = await deps.recall({
      entity_id: deps.entityId,
      query: "",
      top_k: Math.max(topK * 4, 50),
    });
  } catch (err) {
    console.error(
      `[curated] recall threw: ${(err as Error).message ?? String(err)}`,
    );
    return "";
  }
  if (!result.ok) {
    console.error(`[curated] recall failed: ${result.error}`);
    return "";
  }
  const curated = filterCuratedHits(result.data.hits);
  // Newest first — ts is ISO-8601 so lexicographic compare works.
  curated.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  return formatCuratedSection(curated.slice(0, topK), budget);
}

// ── v2.10.1 — Memory Cycle Phase 4: outcome reducer ──────────────────────
//
// Pure helper that converts a resolved (or thrown) hydrateContext call
// into the right side-effects on the master daemon. Extracted out of
// scheduleHydration so the seq-guard + audit-emission contract is
// unit-testable without standing up the whole daemon.
//
// Decision matrix:
//   superseded (mySeq < currentSeq)  → no state write, no audit emission
//   threw, not superseded            → audit + broadcast failure
//   ok:false, not superseded         → audit + broadcast failure
//   ok:true,  not superseded         → setPayload + broadcast ready
//
// Failure cases emit BOTH logDecision AND broadcast — operator looking at
// decisions.jsonl OR watching SSE sees the same event. Pre-2.10.1 the
// throw path was silent (CodeRabbit pass-1 MAJOR).
//
// v2.10.x CodeRabbit pass-2 — every deps.* call (setPayload, log,
// logDecision, broadcast, now) is individually try-wrapped so the
// reducer NEVER throws. Side-effect failures degrade gracefully:
//   - setPayload throwing → state-write didn't take, return logged_failure
//   - log/logDecision/broadcast throwing → swallowed locally, other
//     channels still fire, outcome action reflects what actually happened
//   - now() throwing → fall back to a deps-free "ts: <unknown>" sentinel
//     so broadcasts can still construct without exploding

export type HydrationOutcomeAction =
  | "applied"
  | "superseded"
  | "logged_failure"
  | "ignored_superseded_failure";

export interface ApplyHydrationOutcomeDeps {
  reason: string;
  /** This request's sequence number (captured at scheduleHydration call). */
  mySeq: number;
  /** Latest sequence number at outcome time. mySeq < currentSeq → stale. */
  currentSeq: number;
  /** hydrateContext's resolved result, or null when the await threw. */
  result:
    | import("./context-hydration").HydrationResult
    | null;
  /** Error message captured from the throw path. Null when not thrown. */
  threwMessage: string | null;
  setPayload: (payload: string) => void;
  logDecision: (entry: { project: string; action: string; rationale: string }) => void;
  broadcast: (eventType: string, payload: unknown) => void;
  log: (line: string) => void;
  now: () => Date;
}

// ── deps wrappers — each side-effect dep wrapped in its own try/catch ────
//
// All defensive: any thrown error is swallowed. The reducer reports the
// outcome via the returned tagged action, not via thrown exceptions.

function _safeLog(deps: ApplyHydrationOutcomeDeps, line: string): void {
  try {
    deps.log(line);
  } catch {
    /* swallow — log channel itself is broken; nothing we can do */
  }
}

function _safeLogDecision(
  deps: ApplyHydrationOutcomeDeps,
  entry: { project: string; action: string; rationale: string },
): void {
  try {
    deps.logDecision(entry);
  } catch (err) {
    // logDecision is the audit primary; if it broke, log the breakage
    // so operator can investigate via stderr, then swallow.
    _safeLog(
      deps,
      `[context-hydration] logDecision threw (audit dropped): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function _safeBroadcast(
  deps: ApplyHydrationOutcomeDeps,
  eventType: string,
  payload: unknown,
): void {
  try {
    deps.broadcast(eventType, payload);
  } catch (err) {
    _safeLog(
      deps,
      `[context-hydration] broadcast(${eventType}) threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function _safeNowIso(deps: ApplyHydrationOutcomeDeps): string {
  try {
    return deps.now().toISOString();
  } catch {
    return "<unknown>";
  }
}

/**
 * Apply the outcome of a hydration attempt. Returns a tag indicating
 * which branch ran (for tests + observability). Never throws.
 *
 * State-write contract:
 *   - "applied": setPayload succeeded. log/broadcast MAY have thrown
 *     but the payload IS committed.
 *   - "logged_failure": payload is NOT committed. Either we never
 *     attempted setPayload (failure path), OR setPayload itself threw.
 *   - "superseded" / "ignored_superseded_failure": no setPayload
 *     attempt by design.
 */
export function applyHydrationOutcome(deps: ApplyHydrationOutcomeDeps): HydrationOutcomeAction {
  const superseded = deps.mySeq !== deps.currentSeq;
  // Throw path — async await rejected.
  if (deps.result === null) {
    const msg = deps.threwMessage ?? "unknown";
    if (superseded) {
      // Don't pollute the audit trail with stale-throw noise; just log.
      _safeLog(
        deps,
        `[context-hydration] ${deps.reason} (seq=${deps.mySeq}) superseded then threw — ignoring: ${msg}`,
      );
      return "ignored_superseded_failure";
    }
    _safeLog(deps, `[context-hydration] ${deps.reason} scheduler threw: ${msg}`);
    _safeLogDecision(deps, {
      project: "_master",
      action: "context_hydration_failed",
      rationale: `${deps.reason}: ${msg}`,
    });
    _safeBroadcast(deps, "context_hydration_failed", {
      ts: _safeNowIso(deps),
      reason: deps.reason,
      error: msg,
    });
    return "logged_failure";
  }

  // Resolved with ok:false — Memori or other structural failure.
  if (!deps.result.ok) {
    const errMsg = deps.result.error ?? "unknown";
    if (superseded) {
      _safeLog(
        deps,
        `[context-hydration] ${deps.reason} (seq=${deps.mySeq}) superseded; discarding stale ok:false`,
      );
      return "superseded";
    }
    _safeLog(deps, `[context-hydration] ${deps.reason} hydration failed: ${errMsg}`);
    _safeLogDecision(deps, {
      project: "_master",
      action: "context_hydration_failed",
      rationale: `${deps.reason}: ${errMsg}`,
    });
    _safeBroadcast(deps, "context_hydration_failed", {
      ts: _safeNowIso(deps),
      reason: deps.reason,
      error: errMsg,
    });
    return "logged_failure";
  }

  // Resolved with ok:true — success path.
  if (superseded) {
    // Quietly drop the stale-success: a fresher payload is on its way
    // (or already landed) and we MUST NOT overwrite it.
    _safeLog(
      deps,
      `[context-hydration] ${deps.reason} (seq=${deps.mySeq}) superseded by seq=${deps.currentSeq}; discarding ${deps.result.context_payload.length}-char payload`,
    );
    return "superseded";
  }

  // setPayload is the load-bearing state write. If it throws, the
  // payload didn't land — degrade to logged_failure and emit the same
  // audit a failure path would. Returning "applied" with no state
  // change would be a lie to the caller; returning "logged_failure"
  // lets observers see the breakage. CodeRabbit pass-2 MAJOR.
  try {
    deps.setPayload(deps.result.context_payload);
  } catch (err) {
    const setMsg = err instanceof Error ? err.message : String(err);
    _safeLog(
      deps,
      `[context-hydration] ${deps.reason} setPayload threw — state NOT written: ${setMsg}`,
    );
    _safeLogDecision(deps, {
      project: "_master",
      action: "context_hydration_failed",
      rationale: `${deps.reason}: setPayload threw: ${setMsg}`,
    });
    _safeBroadcast(deps, "context_hydration_failed", {
      ts: _safeNowIso(deps),
      reason: deps.reason,
      error: `setPayload threw: ${setMsg}`,
    });
    return "logged_failure";
  }

  // State write succeeded — anything below is observational. log +
  // broadcast + logDecision failures don't downgrade the action;
  // "applied" reflects that the payload IS committed.
  _safeLog(
    deps,
    `[context-hydration] ${deps.reason} ready — ${deps.result.sources.memori_curated_count} curated + ${deps.result.sources.cognee_hits_count} graph hits + tier1=${deps.result.sources.tier1_chars}b; will prepend on next prompt`,
  );
  _safeBroadcast(deps, "context_hydration_ready", {
    ts: _safeNowIso(deps),
    reason: deps.reason,
    sources: deps.result.sources,
  });
  // CodeRabbit pass-3: durable audit on success path, symmetric with
  // the failure branches above. Failures already land in
  // decisions.jsonl via `context_hydration_failed`; this row lets the
  // operator grep for both "the hydration ATTEMPTS" and "the hydration
  // RESULTS" in the same audit stream.
  _safeLogDecision(deps, {
    project: "_master",
    action: "context_hydration_ready",
    rationale: `${deps.reason}: ${deps.result.sources.memori_curated_count} curated + ${deps.result.sources.cognee_hits_count} graph hits + ${deps.result.sources.tier1_chars} tier1_chars`,
  });
  return "applied";
}

function loadAgentTranscript(): AgentMessage[] {
  if (!existsSync(AGENT_STATE_PATH)) return [];
  try {
    const raw = readFileSync(AGENT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as { messages?: AgentMessage[] };
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    return dropOrphanToolResults(msgs);
  } catch (err) {
    console.error(
      `[evy] WARN agent-state.json corrupt, starting fresh: ${(err as Error).message}`,
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
      `[evy] dropped ${dropped} orphan toolResult(s) at load — preempted Codex/OpenAI HTTP 400.`,
    );
  }
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────
// v2.8.14 — Per-team activity record shape, lifted to module scope so the
// re-classify helper below (deriveActivityFromPaneCapture) and its tests
// can reference the same shape used by the closure-local teamLastActivity
// Map inside startMaster.
//
// Background: classifyWorkerReply only ran on inbox.jsonl arrivals. When a
// worker replied via the tmux pane (auto-nudge response path), the
// pane-hash bump path preserved the spawn-time "working" classification
// forever, so the staleness sweep kept escalating even after the worker
// said "work complete, idle by design". v2.8.14 re-runs the classifier on
// every pane-hash change and surfaces nudge/reply observability through
// the watchdog state snapshot. (operator-reported false positive on
// claude-birdie, 2026-05-21).
// ─────────────────────────────────────────────────────────────────────────
export type TeamEvent = {
  ts: string;
  type: string;
  text?: string;
  [k: string]: unknown;
};

export interface TeamActivity {
  /** Date.now()-style ms of last observed activity (inbox event or pane bump). */
  ts: number;
  /** Last inbox event we saw, if any. Used for notification context. */
  lastEvent?: TeamEvent;
  /** Most recent worker-reply classification. v2.8.14: refreshed on every
   *  pane-hash change, not just inbox events. */
  classification?: import("./auto-nudge").ClassifiedReply;
  /** v2.8.14 — set inside sendAutoNudge after a successful POST. Allows the
   *  pane-hash bump path to recognise a reply that lands after a nudge. */
  last_nudge_at_ms?: number;
  /** v2.8.14 — set when a pane-hash change is detected AFTER the most
   *  recent nudge. Surfaces in watchdog state for operator debugging. */
  last_reply_at_ms?: number;
}

/**
 * Pure helper for the v2.8.14 fix: given an existing activity record and a
 * fresh pane capture, return the next activity record.
 *
 *   - When `paneText` is non-empty, re-classify it via classifyWorkerReply
 *     and adopt the fresh classification. This is the fix for the false
 *     positive: a worker that replies via the tmux pane (e.g. responding
 *     "work complete, idle by design" to an auto-nudge) will now flip to
 *     classification "completed_idle", which decideTeamAction short-circuits.
 *   - When `paneText` is null (capture failed), preserve the prior
 *     classification. Capture failure is non-fatal; better to keep the
 *     last-known good signal than reset to "working" on transient error.
 *   - Always carry `lastEvent` and `last_nudge_at_ms` forward.
 *   - Set `last_reply_at_ms` to `now` iff a nudge has been sent AND no
 *     reply has been recorded since that nudge — i.e. this pane change is
 *     the first detectable response since the last nudge.
 *
 * Pure (no side effects) and exported so the watchdog-pane-classify test
 * suite can exercise the decision logic without booting the master.
 */
export function deriveActivityFromPaneCapture(opts: {
  existing: TeamActivity | undefined;
  paneText: string | null;
  now: number;
}): TeamActivity {
  // Import lazily inside the function to avoid a circular-import surprise.
  // classifyWorkerReply is also imported at module top; this synchronous
  // require keeps the function pure-ish without a top-level cycle risk.
  const { classifyWorkerReply: classify } = require("./auto-nudge") as typeof import("./auto-nudge");

  const existing = opts.existing;
  const now = opts.now;

  // v2.8.14 (CodeRabbit MINOR follow-up) — `hasPaneText` gates BOTH the
  // re-classify and the last_reply_at_ms stamp. Treating a capture
  // failure (paneText === null) or whitespace-only capture as a "reply"
  // would falsely record an acknowledgement timestamp on a transient
  // tmux error, breaking nudge/reply pairing for the diag tool.
  const hasPaneText =
    opts.paneText !== null && opts.paneText.trim().length > 0;

  let nextClassification = existing?.classification;
  if (hasPaneText) {
    nextClassification = classify(opts.paneText);
  }

  // last_reply_at_ms: only stamped when we actually observed pane text
  // AND there's an outstanding nudge that hasn't been acknowledged yet
  // (the pane change IS the acknowledgement).
  let nextLastReplyAtMs = existing?.last_reply_at_ms;
  const lastNudgeAtMs = existing?.last_nudge_at_ms;
  if (
    hasPaneText &&
    lastNudgeAtMs !== undefined &&
    lastNudgeAtMs > (existing?.last_reply_at_ms ?? 0)
  ) {
    nextLastReplyAtMs = now;
  }

  return {
    ts: now,
    lastEvent: existing?.lastEvent,
    classification: nextClassification,
    last_nudge_at_ms: lastNudgeAtMs,
    last_reply_at_ms: nextLastReplyAtMs,
  };
}

/**
 * v2.8.14 — Merge a fresh activity update onto an existing record while
 * preserving the nudge/reply observability fields (`last_nudge_at_ms`,
 * `last_reply_at_ms`).
 *
 * CodeRabbit-caught follow-up on the original fix: both inbox-jsonl paths
 * (boot-scan reconciliation at server.ts:2283, tail at server.ts:2325)
 * were calling `teamLastActivity.set(team, { ts, lastEvent, classification })`
 * which REPLACES the whole record. After v2.8.14 added the new fields,
 * any inbox event arrival would clobber a freshly-stamped `last_nudge_at_ms`
 * and break nudge/reply pairing for the diag tool.
 *
 * Centralised here so all "I have a fresh ts + classification + lastEvent"
 * call sites go through one merge function and don't drift over time.
 */
export function mergeActivityUpdate(
  existing: TeamActivity | undefined,
  fresh: {
    ts: number;
    lastEvent?: TeamEvent;
    classification?: import("./auto-nudge").ClassifiedReply;
  },
): TeamActivity {
  return {
    ts: fresh.ts,
    lastEvent: fresh.lastEvent,
    classification: fresh.classification,
    last_nudge_at_ms: existing?.last_nudge_at_ms,
    last_reply_at_ms: existing?.last_reply_at_ms,
  };
}

// v2.8.9 — strip helpers moved to components/evy/text-sanitize.ts so the
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

// v2.10.x CodeRabbit pass-4: filter `_ephemeral: true` messages
// (Phase 4 hydration blocks) out of the durable transcript. The
// pi-agent-core supervisor sees them in-memory for the turn they
// land on; they're invisible to disk persistence so they don't
// accumulate across restarts.
//
// Pure helper, exported for unit tests. The flag is a synthetic-only
// marker placed by master itself (the operator can't smuggle it in
// because pi-agent-core doesn't surface a way to set arbitrary
// per-message metadata via /chat). Safe to scan unconditionally.
export function dropEphemeralMessages(messages: AgentMessage[]): AgentMessage[] {
  let dropped = 0;
  const kept = messages.filter((m) => {
    if ((m as { _ephemeral?: boolean })._ephemeral === true) {
      dropped++;
      return false;
    }
    return true;
  });
  if (dropped > 0) {
    console.error(
      `[transcript] dropped ${dropped} ephemeral message(s) before persistence (hydration blocks etc.)`,
    );
  }
  return kept;
}

// v2.10.x CodeRabbit pass-5: in-place strip used by the prompt
// handler immediately after the model has consumed the current
// turn's messages. Without this, the hydration block (pushed with
// `_ephemeral: true` per pass-4) survives in `agent.state.messages`
// forever — defeating Phase 4's whole point: token bloat on every
// subsequent supervisor call.
//
// Mirrors the splice-from-tail idiom compactTranscriptInline uses
// for orphan-toolResult removal — pi-agent-core's Agent holds the
// reference to `state.messages`, so we mutate in place rather than
// reassign. Returns the count of removed entries for caller logging.
//
// Exported pure helper — unit-testable without standing up the daemon.
export function stripEphemeralInPlace(messages: AgentMessage[]): number {
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { _ephemeral?: boolean } | undefined;
    if (m && m._ephemeral === true) {
      messages.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

function saveAgentTranscript(messages: AgentMessage[]) {
  writeFileSync(
    AGENT_STATE_PATH,
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        // CodeRabbit pass-4: filter ephemeral hydration blocks first,
        // then scrub reasoning channels. Order matters — scrubbing
        // mutates content; doing it on already-dropped messages saves
        // work and keeps the ephemeral filter loud.
        messages: scrubMessageContent(dropEphemeralMessages(messages)),
      },
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
      `[evy] WARN could not update state.json last_review_ts: ${(err as Error).message}`,
    );
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[evy] booting subctl evy v${SUBCTL_VERSION}`);

  const probe = ensureConfigFiles();
  if (!probe.ok) {
    console.error(`[evy] boot failed: ${probe.warnings.join("; ")}`);
    process.exit(1);
  }
  for (const w of probe.warnings) console.error(`[evy] WARN ${w}`);

  const { providers, policy, skill } = loadConfig();
  console.error(
    `[evy] loaded — operator=${policy.operator.name}, projects=${policy.projects.length}, models=${Object.keys(providers.models).length}`,
  );

  // ── v2.8.13 Phase 4: local_backend migration ────────────────────────────
  // First boot of a daemon that knows about local_backend, but operator's
  // providers.json was written before. Seed local_backend from any role
  // still pointing at lmstudio/ollama/mlx/omlx/vllm, prefer LM Studio,
  // rewrite affected roles to provider: "local", persist.
  try {
    const mig = migrateLocalBackend(providers);
    if (mig.migrated && mig.picked) {
      persistProviders(providers);
      console.error(
        `[evy] local_backend seeded from ${mig.picked.kind} @ ${mig.picked.host}; rewrote roles ${mig.rewrittenRoles.join(", ")} → provider="local"`,
      );
      logDecision({
        project: "_master",
        action: "providers_migration",
        rationale: `Phase 4 local_backend seeded from ${mig.picked.kind} @ ${mig.picked.host}; roles rewritten: ${mig.rewrittenRoles.join(", ")}`,
      });
    }
  } catch (err) {
    console.error(`[evy] local_backend migration failed: ${(err as Error).message}`);
  }

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
      `[evy] FATAL providers.json missing models.supervisor — cannot boot agent`,
    );
    process.exit(1);
  }
  let profilesFile: ProfilesFile;
  try {
    profilesFile = loadProfiles();
  } catch (err) {
    console.error(
      `[evy] FATAL profiles.json load failed: ${(err as Error).message}`,
    );
    process.exit(1);
    throw err; // unreachable, narrows the type
  }
  // `supervisorCfg` is the live, profile-overridden view used by the
  // rest of the daemon (status responses, /diag, /context, LM Studio
  // pre-flight). Reassigned on profile swap so all readers see the
  // new model id / host without restart.
  //
  // v2.8.13 Phase 4: if the role is provider="local", resolveRoleCfg
  // rewrites provider/host/model from providers.local_backend before any
  // downstream reader (buildModel, pi-ai dispatch, /diag probe) sees it.
  let supervisorCfg: Providers["models"][string] = resolveRoleCfg("supervisor", {
    ...supervisorCfgFromProviders,
    model: profilesFile.profiles[profilesFile.active].supervisor,
    host: profilesFile.profiles[profilesFile.active].host,
  }, providers);
  let activeProfile: ProfileName = profilesFile.active;
  console.error(
    `[evy] profile=${activeProfile} → supervisor=${supervisorCfg.provider}/${supervisorCfg.model}`,
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
    if (!a || !b) return false;
    // Resolve both through local_backend BEFORE comparing — two roles with
    // provider="local" both fold to the same backend.kind, model, host. The
    // dedup is about avoiding LM Studio's `:2` shadow instance when the
    // actual dispatch target is identical.
    const ra = resolveRoleCfg("reviewer", a, providers);
    const rb = resolveRoleCfg("supervisor", b, providers);
    return ra.provider === rb.provider
      && ra.model === rb.model
      && (ra.host ?? "") === (rb.host ?? "");
  }
  const rolesToPin = (["supervisor", "reviewer"] as const).filter(
    (role) => {
      if (!providers.models[role]) return false;
      if (
        role === "reviewer"
        && sameLocalRoute(providers.models.reviewer, supervisorCfg)
      ) {
        console.error(
          `[evy] ctx-pin reviewer: SKIPPED — same model+host as supervisor (avoids LM Studio :2 instance)`,
        );
        return false;
      }
      return true;
    },
  );
  await Promise.allSettled(
    rolesToPin.map(async (role) => {
      const cfg = providers.models[role]!;
      const result = await ensureModelLoaded(cfg, role, providers);
      console.error(`[evy] ${result.ok ? "ctx-pin" : "ctx-pin FAILED"} ${role}: ${result.detail}`);
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

  // ── v2.8.11 — Phase 4: curated Tier 3 cache ─────────────────────────────
  // composeSystemPrompt is sync (the agent pulls `state.systemPrompt`
  // every turn and the caller can't await mid-build). The /recall sidecar
  // call is async + may be slow + could fail. Bridge: keep a TTL-cached
  // curated text and fire a fire-and-forget refresh from inside compose.
  // First turn after boot may see an empty cache — we kick a refresh
  // right after [memori] reachable logs so by the time the operator
  // types their first message, the cache is usually warm. On stale or
  // unreachable sidecar, compose prepends nothing — Tier 1 + skill +
  // persona ride alone, behavior matches pre-Phase-4.
  const CURATED_TTL_MS = 60_000;
  let curatedCache: { text: string; ts: number } = { text: "", ts: 0 };
  let curatedRefreshInFlight = false;

  function refreshCuratedAsync(reason: string): void {
    if (curatedRefreshInFlight) return;
    curatedRefreshInFlight = true;
    const entityId = (policy.operator.name ?? "operator").toLowerCase();
    buildCuratedPromptSection({
      recall: memoriRecall,
      entityId,
      budgetChars: CURATED_PROMPT_BUDGET_CHARS,
      topK: CURATED_PROMPT_TOP_K,
    })
      .then((text) => {
        curatedCache = { text, ts: Date.now() };
        if (text.length > 0) {
          console.error(
            `[curated] refreshed (${reason}) — ${text.length} chars prepended next turn`,
          );
        }
      })
      .catch((err) => {
        // Never throw — keep last good cache, log once.
        console.error(
          `[curated] refresh threw: ${(err as Error).message ?? String(err)}`,
        );
      })
      .finally(() => {
        curatedRefreshInFlight = false;
      });
  }

  // ── v2.10.0 — Memory Cycle Phase 4: context slimming hydration ──────────
  //
  // SEPARATE from the v2.8.11 curated-cache above. The cache prepends the
  // SAME curated rows into the SYSTEM PROMPT on EVERY turn. The Phase 4
  // hydration block is a ONE-SHOT synthetic `role: "user"` message
  // (mirrors compactTranscriptInline's summary message) pushed into
  // `agent.state.messages` on the FIRST prompt after master boot OR
  // immediately after `/compact` clears the transcript. It also adds
  // Cognee graph hits — the cache doesn't.
  //
  // The raw transcript file on disk (agent-state.json) stays untouched
  // as the audit trail. We still loadAgentTranscript() at boot so
  // multi-turn coherence holds across daemon restarts — the slimming
  // here is the LLM-VISIBLE summary that gets prepended ON TOP of the
  // resumed transcript, not a replacement for it.
  //
  // Lifecycle (set/clear of _pendingHydrationPayload):
  //   1. SET at boot once Memori + Cognee probes complete (scheduleHydration("boot"))
  //   2. SET inside compactTranscriptInline AFTER clearing messages (scheduleHydration("post-compact"))
  //   3. CLEAR inside processOnePrompt the moment it gets prepended
  //
  // Failure modes are absorbed inside hydrateContext (Cognee outage →
  // no graph section, Memori outage → ok:false → we just don't set the
  // flag). The agent never crashes on missing hydration.
  let _pendingHydrationPayload: string | null = null;
  const _contextHydrationConfig: ContextHydrationConfig =
    loadContextHydrationConfig();
  // v2.10.1 — monotonic seq counter for hydration requests. Defends
  // against the boot-then-post-compact race where the slow boot reply
  // would otherwise stale-overwrite a fresh post-compact payload. Each
  // call to scheduleHydration() ++'s this; the resolved continuation
  // checks `mySeq === _lastHydrationReqSeq` BEFORE writing state.
  let _lastHydrationReqSeq = 0;
  console.error(
    `[context-hydration] config: enabled=${_contextHydrationConfig.enabled} curated_limit=${_contextHydrationConfig.recent_curated_limit} cognee_limit=${_contextHydrationConfig.cognee_limit} cognee_query=${_contextHydrationConfig.cognee_relevance_query ?? "null"}`,
  );

  /**
   * Kick off an async hydration query and stash the result in
   * `_pendingHydrationPayload` for the next prompt to consume. Safe to
   * call repeatedly — re-entry is allowed and seq-guarded: stale results
   * are discarded WITHOUT overwriting a fresher payload.
   *
   * `reason` shows up in the decision log + SSE event so the operator can
   * tell boot-hydration from post-compact-hydration in the transcript view.
   */
  function scheduleHydration(reason: "boot" | "post-compact" | "manual"): void {
    if (!_contextHydrationConfig.enabled) {
      console.error(
        `[context-hydration] skipped (${reason}) — disabled via config / env`,
      );
      return;
    }
    const entityId = (policy.operator.name ?? "operator").toLowerCase();
    // Reserve a sequence number for THIS request. The async continuation
    // below uses the captured `mySeq` to detect supersession.
    const mySeq = ++_lastHydrationReqSeq;
    void (async () => {
      let result: Awaited<ReturnType<typeof hydrateContext>> | null = null;
      let threwMessage: string | null = null;
      try {
        result = await hydrateContext(
          {
            entity_id: entityId,
            recent_curated_limit: _contextHydrationConfig.recent_curated_limit,
            cognee_relevance_query:
              _contextHydrationConfig.cognee_relevance_query,
            cognee_limit: _contextHydrationConfig.cognee_limit,
          },
          {
            // Memori curated rows come through the same /recall +
            // curated_-prefix filter the v2.8.11 cache uses. Keeps a
            // single source-of-truth for what counts as curated.
            listMemoriCurated: async ({ entity_id, limit }) => {
              const wide = await memoriRecall({
                entity_id,
                query: "",
                // Pull a wider window so the prefix-filter has material;
                // hydrateContext clamps to `limit` internally.
                top_k: Math.max(limit * 4, 50),
              });
              if (!wide.ok) {
                throw new Error(wide.error);
              }
              const curated = wide.data.hits.filter(
                (h: MemoriHit) =>
                  typeof h.id === "string" && h.id.startsWith("curated_"),
              );
              // Newest first — ts is ISO-8601 so lexicographic compare works.
              curated.sort((a, b) =>
                (b.ts ?? "").localeCompare(a.ts ?? ""),
              );
              const rows: ContextHydrationCuratedRow[] = curated.map((h) => ({
                id: h.id,
                text: h.text,
                ts: h.ts,
                kind: h.kind,
                // memori-client typing doesn't surface confidence on hits;
                // omit — formatter falls back to kind-only tag.
              }));
              return rows.slice(0, limit);
            },
            queryCognee: async ({ query, limit }) => {
              const r = await cogneeRecall({ query, top_k: limit });
              if (!r.ok) {
                throw new Error(r.error);
              }
              const hits: ContextHydrationCogneeHit[] = r.data.hits.map((h) => ({
                text: h.text,
                score: h.score,
                id: h.id,
              }));
              return hits;
            },
            now: () => new Date(),
          },
        );
      } catch (err) {
        // hydrateContext is defensive — should never throw out — but
        // protect against bad deps wiring just in case. Audit emission
        // happens via applyHydrationOutcome below so the throw path
        // shares the same logDecision + broadcast contract as ok:false.
        threwMessage = err instanceof Error ? err.message : String(err);
      }
      applyHydrationOutcome({
        reason,
        mySeq,
        currentSeq: _lastHydrationReqSeq,
        result,
        threwMessage,
        setPayload: (p) => {
          _pendingHydrationPayload = p;
        },
        logDecision: (entry) => logDecision(entry),
        broadcast: (eventType, payload) => broadcast(eventType, payload),
        log: (line) => console.error(line),
        now: () => new Date(),
      });
    })();
  }

  function composeSystemPrompt(userMessage?: string): string {
    // Curated Tier 3 goes FIRST so the supervisor sees the consciousness-
    // cycle output ahead of tier-1 + skill + persona. Stale or empty
    // cache → empty string → prepending is a no-op. Hot path is sync;
    // refreshCuratedAsync runs the actual /recall in the background.
    if (Date.now() - curatedCache.ts > CURATED_TTL_MS) {
      refreshCuratedAsync("ttl-expired");
    }
    const curatedBlock = curatedCache.text;

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
    return curatedBlock + memBlock + routerBlock + skill + personality;
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

  // v2.8.15 (CodeRabbit pass-2 MAJOR): capture the Cognee promotion
  // ticker's stop handle at function scope so the SIGTERM/SIGINT
  // shutdown path can cancel it cleanly. The ticker also registers a
  // watchdog (kill via /watchdogs killall), but graceful shutdown
  // explicitly tears down each ticker rather than going through the
  // watchdog registry — so we wire stop() into shutdown() directly.
  let cogneePromotionStop: (() => void) | null = null;

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
    supervisorCfg = resolveRoleCfg("supervisor", {
      ...supervisorCfgFromProviders,
      model: entry.supervisor,
      host: entry.host,
    }, providers);
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
    void ensureModelLoaded(supervisorCfg, "supervisor", providers)
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
  // the change so the operator can see in evy.log that the toggle took
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
  // Each running dev team gets a JSONL file at $EVY_STATE_DIR/inbox/{team}.jsonl.
  // The team lead (claude in tmux pane 0) appends one JSON line per status event:
  //
  //   {"ts":"…","type":"progress|blocked|done|error|note","text":"…", …}
  //
  // We tail every file in the dir, broadcast new lines as `team_event` SSE
  // events (so the dashboard updates live), expose per-team last-activity to
  // the watchdog (so it can decide if a team's gone stale), and surface
  // "blocked"/"error" events to the agent so it can decide whether to ping
  // the lead or escalate to Jason.
  const INBOX_DIR = join(EVY_STATE_DIR, "inbox");
  mkdirSync(INBOX_DIR, { recursive: true });

  // TeamEvent + TeamActivity types are declared at module scope so the
  // exported re-classify helper (deriveActivityFromPaneCapture) and its
  // tests can reference the same shape — see notes above the helper.
  const teamLastActivity = new Map<string, TeamActivity>();
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
              // WEB-216: classify on boot-scan too so a team that
              // shipped completed_idle text right before master
              // restarted starts the next session classified, not
              // mistakenly marked as silent-and-stale.
              const classification = classifyWorkerReply(lastEv.text);
              // v2.8.14 (CodeRabbit follow-up) — go through
              // mergeActivityUpdate so an in-memory record's nudge/reply
              // observability fields survive the boot reconciliation.
              // (In practice the map is empty at boot scan, so this is a
              // no-op there — but the same helper is used by the inbox
              // tail path below where the map IS populated, and keeping
              // both sites symmetric makes the contract obvious.)
              teamLastActivity.set(
                team,
                mergeActivityUpdate(teamLastActivity.get(team), {
                  ts: stat.mtimeMs,
                  lastEvent: lastEv,
                  classification,
                }),
              );
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
      console.error(`[evy] inbox tail error ${filePath}: ${(err as Error).message}`);
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
      // WEB-216: classify worker reply text so the staleness sweep can
      // distinguish completed_idle / awaiting_input from genuine silence.
      // The classifier accepts undefined/empty text and degrades to
      // {kind:"working"} so non-text events keep the prior behavior.
      const classification = classifyWorkerReply(ev.text);
      // v2.8.14 (CodeRabbit follow-up) — go through mergeActivityUpdate
      // so the nudge/reply observability fields survive inbox arrivals.
      // Without this, a sendAutoNudge that stamps last_nudge_at_ms would
      // be clobbered by the worker's next inbox-jsonl write, breaking
      // the next pane bump's ability to recognise the reply.
      teamLastActivity.set(
        team,
        mergeActivityUpdate(teamLastActivity.get(team), {
          ts: Date.now(),
          lastEvent: ev,
          classification,
        }),
      );
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
      console.error(`[evy] inbox scan error: ${(err as Error).message}`);
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
    console.error(`[evy] inbox watcher+poll armed at ${INBOX_DIR}`);
  } catch (err) {
    console.error(`[evy] inbox fs.watch failed (${(err as Error).message}) — relying on 2s poll`);
  }

  console.error(
    `[evy] agent ready — supervisor=${supervisorCfg.provider}/${supervisorCfg.model}, tools=${tools.length}, transcript=${agent.state.messages.length} msgs`,
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
        // Retry-with-backoff: Python sidecar takes 5–15s to start
        // (interpreter + SDK load). One-shot probe at boot used to log
        // a loud false UNREACHABLE; the retry helper logs quiet
        // intermediate lines and only escalates after exhaustion.
        const probe = await probeWithRetry({
          name: "cognee",
          probe: cogneeHealth,
          budgetMs: 30_000,
          baseDelayMs: 1500,
          maxAttempts: 6,
          log: (line) => console.error(line),
        });
        if (probe.reachable) {
          console.error(
            `[cognee] reachable at ${probe.url}${probe.version ? ` (v${probe.version})` : ""} — ${probe.latency_ms}ms — auth=${probe.auth_status}`,
          );
        } else {
          console.error(
            `[cognee] Tier 4 tools fall back to claude-mem until the service is up (last error: ${probe.error ?? "unknown"}, auth=${probe.auth_status}).`,
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
        // Retry-with-backoff (see cognee block above for rationale).
        const probe = await probeWithRetry({
          name: "memori",
          probe: memoriHealth,
          budgetMs: 30_000,
          baseDelayMs: 1500,
          maxAttempts: 6,
          log: (line) => console.error(line),
        });
        if (probe.reachable) {
          console.error(
            `[memori] reachable at ${probe.url}${probe.version ? ` (v${probe.version})` : ""} — ${probe.latency_ms}ms — db=${probe.database ?? "?"} — auth=${probe.auth_status}`,
          );
          // v2.8.11 Phase 4: warm the curated cache now so the first
          // operator turn after boot sees Tier 3 facts. The function is
          // fire-and-forget; subsequent refreshes are driven by the
          // TTL check inside composeSystemPrompt.
          refreshCuratedAsync("boot");
          // v2.10.0 — Memory Cycle Phase 4 (different lifecycle from
          // the v2.8.11 cache above). One-shot hydration block prepended
          // to the FIRST new prompt as a synthetic role:"user" message.
          // Includes curated Tier 3 + Cognee Tier 4 hits. Fire-and-forget
          // — if the operator types before the async resolves, the next
          // turn picks it up.
          scheduleHydration("boot");
        } else {
          console.error(
            `[memori] Tier 3 falls back to evy-memory until the sidecar is up (last error: ${probe.error ?? "unknown"}, auth=${probe.auth_status}).`,
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
          const reviewerCfgRaw = providers.models.reviewer ?? supervisorCfg;
          // v2.8.13 Phase 4: provider="local" → local_backend.kind, host, model
          const reviewerCfg = resolveRoleCfg("reviewer", reviewerCfgRaw, providers);
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

          // v2.8.15 — Cognee write path (Tier 3 → Tier 4 promotion ticker).
          //
          // Gates: cognee + memori + memory_kernel must all be on. We also
          // require the live Memori probe to have come back reachable
          // (same `probe.reachable` we already gated the kernel on) and
          // perform a fast Cognee health probe so we don't arm a ticker
          // that's going to 502 every interval.
          if (TOOL_GATES.cognee) {
            try {
              // CodeRabbit MAJOR: retry-with-backoff (same shape as the
              // boot probe above) so a single transient flake during
              // master boot doesn't disarm the promotion ticker until
              // restart. Mirrors the cogneeHealth wrap at line ~2484.
              const cogneeProbe = await probeWithRetry({
                name: "cognee",
                probe: cogneeHealth,
                budgetMs: 30_000,
                baseDelayMs: 1500,
                maxAttempts: 6,
                log: (line) => console.error(line),
              });
              if (cogneeProbe.reachable) {
                const promotionIntervalMs = resolveCogneePromotionIntervalMs();
                // Wire the entity id from the same operator scope the
                // memory-kernel uses, and use the explicit `cogneeRemember`
                // import so the type-link from server.ts → cognee-client
                // stays declared at this seam.
                _setCogneePromotionDepsForTesting({
                  entityId: () => entityId,
                  cogneeRemember: (input) => cogneeRemember(input),
                });
                // CodeRabbit pass-2 MAJOR: capture the stop handle into
                // function-scope `cogneePromotionStop` so shutdown() can
                // cancel the ticker. The previous version dropped the
                // return value entirely.
                cogneePromotionStop = startCogneePromotionTicker({
                  intervalMs: promotionIntervalMs,
                  registerWatchdog,
                  touchWatchdog,
                  onError: (err) => {
                    emitNotification({
                      kind: "cognee-promotion-error",
                      severity: "warn",
                      title: "cognee-promotion: tick threw",
                      body: `Tier 3 → Tier 4 promotion surfaced an error: ${err.message}`,
                    });
                    // CodeRabbit MAJOR: broadcast errored ticks so the
                    // dashboard can distinguish idle from failed from
                    // never-armed instead of only emitting on success.
                    broadcast("cognee_promotion_tick_error", {
                      ts: new Date().toISOString(),
                      error: err.message,
                    });
                  },
                  onTick: (result) => {
                    if (result.scanned > 0) {
                      console.error(
                        `[cognee-promotion] tick — promoted=${result.promoted} errors=${result.errored} watermark=${result.watermark_id ?? "null"} elapsed=${result.elapsed_ms}ms`,
                      );
                    }
                    // CodeRabbit MAJOR: broadcast EVERY successful tick
                    // (including idle no-op ticks) so the dashboard can
                    // render "ticker is alive but no work" as a
                    // first-class state.
                    broadcast("cognee_promotion_tick_success", {
                      promoted: result.promoted,
                      errored: result.errored,
                      scanned: result.scanned,
                      watermark_ts: result.watermark_ts,
                      watermark_id: result.watermark_id,
                      elapsed_ms: result.elapsed_ms,
                      ts: new Date().toISOString(),
                    });
                  },
                });
                console.error(
                  `[cognee-promotion] armed — interval=${Math.round(promotionIntervalMs / 60_000)}min, entity=${entityId}, cognee=${cogneeProbe.url}`,
                );
              } else {
                console.error(
                  `[cognee-promotion] not armed — Cognee unreachable (${cogneeProbe.error ?? "unknown"}). Tier 3 → Tier 4 promotion will not run until master restart with the service up.`,
                );
                // CodeRabbit MAJOR: surface the "not armed" state to the
                // operator instead of silently logging — otherwise the
                // ticker silently never runs.
                emitNotification({
                  kind: "cognee-promotion-disarmed",
                  severity: "warn",
                  title: "cognee-promotion: not armed at boot",
                  body: `Cognee unreachable after retries (${cogneeProbe.error ?? "unknown"}). Tier 3 → Tier 4 promotion will not run until master restart with the service up.`,
                });
              }
            } catch (err) {
              const message = (err as Error).message ?? String(err);
              console.error(`[cognee-promotion] arm threw: ${message}`);
              // CodeRabbit MAJOR: surface arm-time exceptions to the
              // operator — silent failure here means the dashboard's
              // armed flag goes false and nobody knows why.
              emitNotification({
                kind: "cognee-promotion-arm-failed",
                severity: "warn",
                title: "cognee-promotion: arm threw",
                body: `Could not arm the Tier 3 → Tier 4 promotion ticker: ${message}`,
              });
            }
          }
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
    // v2.8.12 — "mcp" added so the MCP send_message tool can flow through
    // dispatchToAgent's normal drain loop (the prior wave-3 wiring just
    // pushed to promptQueue without triggering the loop, so prompts queued
    // but Evy never picked them up). The literal source string used at
    // runtime is `mcp:<caller_id>` for provenance — typed as "mcp" here.
    source: "chat" | "telegram" | "watchdog" | "mcp";
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
  const COMPACT_CFG_PATH = join(EVY_STATE_DIR, "compact.json");

  async function getSupervisorLoadedCtx(timeoutMs = 1500): Promise<number | null> {
    // Phase 4: probe through the LocalBackendAdapter so the loaded-context
    // lookup is correct for whichever runtime is actually behind
    // supervisorCfg. Pre-Phase-4 this hit LM Studio's native
    // /api/v0/models against ANY host — when supervisorCfg.provider had
    // been rewritten to "ollama" or "omlx" by resolveRoleCfg the request
    // either 404'd silently (Ollama) or returned the wrong shape (oMLX),
    // and the caller got `null` for the wrong reason. The adapter knows
    // the right endpoint per backend; LocalModel.context_length is
    // populated where the backend exposes it (lmstudio: yes, omlx: yes,
    // ollama: no — falls through to null naturally).
    const kind = mapToLocalBackendKind(supervisorCfg.provider, supervisorCfg.host);
    if (!kind) return null;
    const adapter = getLocalBackendAdapter(kind);
    const host = supervisorCfg.host ?? adapter.defaultHost;
    const apiKey =
      kind === "lmstudio"
        ? resolveSecret("lmstudio_api_token")
        : kind === "omlx"
          ? resolveSecret("omlx_api_token")
          : null;
    try {
      const models = await adapter.listModels(host, {
        timeout_ms: timeoutMs,
        api_key: apiKey,
      });
      const found = models.find((m) => m.id === supervisorCfg.model);
      return found?.context_length ?? null;
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
      // v2.10.0 — Memory Cycle Phase 4. Compaction just dumped most of
      // the transcript into a single summary message; the LLM has lost
      // the broader curated/graph context that previously rode along
      // implicitly in the bulk. Re-hydrate so the FIRST prompt after
      // compaction sees a fresh `[memory-context-hydration]` block.
      scheduleHydration("post-compact");
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

    // v3.3.5 — `warn` now triggers compaction (in addition to the existing
    // SSE banner) per Hermes findings §1.5: lift the summariser to fire on
    // warn so warn becomes the operating threshold and compact becomes a
    // safety net. Both stages run through the same compactTranscriptInline
    // call so the post-compact transcript shape is identical regardless of
    // which threshold tripped. Distinct `initiator` values
    // (`jit-warn` vs `jit`) let the dashboard tell them apart.
    const isWarn = decision.action === "warn";
    const initiator = isWarn ? "jit-warn" : "jit";
    const stage = isWarn ? "warn-compacting" : "compacting";
    const logLabel = isWarn
      ? "just-in-time compact (warn-threshold)"
      : "just-in-time compact";

    console.error(
      `[evy] ${logLabel}: ${decision.reason} — compacting toward ${cfg.target_tokens.toLocaleString()} tok`,
    );
    broadcast("compact_warning", {
      ts: new Date().toISOString(),
      stage,
      initiator,
      current_tokens: decision.current_tokens,
      warn_at: cfg.warn_tokens || null,
      compact_at: cfg.compact_tokens || null,
      threshold_used: decision.threshold_used,
      reason: decision.reason,
    });
    const result = compactTranscriptInline({
      target_tokens: cfg.target_tokens,
      keep_recent: cfg.keep_recent,
      initiator,
    });
    if (!result.ok) {
      console.error(`[evy] ${logLabel} failed: ${result.error}`);
    } else if (result.noop) {
      console.error(`[evy] ${logLabel} noop: ${result.message}`);
    } else {
      console.error(
        `[evy] ${logLabel} ok — archived ${result.archived_count}, kept ${result.kept_msgs}`,
      );
    }
  }

  // ── v3.3.6 Hermes-aligned compression gate ────────────────────────────────
  // Implements the literal Hermes spec from
  // `.subctl/docs/hermes-compact-and-skills-findings.md` §1.1-§1.3:
  //   threshold_tokens = max(threshold_pct × ctx_window, 64_000)
  //   should_compress(real_prompt_tokens) → run LLM compactor
  //   Three triggers share the same algorithm: pre-flight, post-turn, recovery.
  //
  // Coexists with the v2.7.3 absolute-token JIT gate (`runJitCompactCheck`
  // above). The two are layered: Hermes fires FIRST when config.yaml is
  // present and enabled; the legacy module still runs as a back-compat
  // safety net for operators who haven't migrated to config.yaml. After
  // both run, the supervisor's prompt window is guaranteed to be below the
  // smaller of (Hermes threshold, legacy compact_tokens).
  async function runHermesCompactCheck(
    stage: "pre-flight" | "post-turn" | "recovery",
    realPromptTokensHint?: number,
  ): Promise<void> {
    let cfg: HermesCompressionConfig;
    try {
      cfg = hermesLoadCompressionConfig();
    } catch {
      return;
    }
    if (!cfg.enabled) return;

    // Real prompt_tokens — Hermes priority order:
    //   1. `usage.prompt_tokens` from the most recent supervisor response
    //      (preferred; passed via `realPromptTokensHint` when the v3.3.7
    //      `globalThis.fetch` interceptor in supervisor-usage-capture.ts
    //      caught a usage chunk in the previous turn's response stream).
    //   2. char/4 estimate including the +2500 fixed prompt overhead —
    //      same shape `runJitCompactCheck` uses. The fallback when the
    //      hint is unavailable (first turn after boot, sniffer disabled,
    //      provider that doesn't ship a usage tail-chunk).
    // resolveRealPromptTokens centralises the hint-vs-estimator decision
    // so it's unit-testable in isolation from this closure (v3.3.7).
    const realTokens = resolveRealPromptTokens(realPromptTokensHint, () => {
      const transcriptTokens = estimateTranscriptTokens(
        agent.state.messages as Array<{ content?: unknown }>,
      );
      return transcriptTokens + FIXED_PROMPT_OVERHEAD_TOKENS;
    });

    // v3.3.8 — cloud supervisors don't surface `loaded_ctx` (LM Studio's
    // /v1/models payload is the only source today and Codex/GPT/Claude
    // cloud routes have no equivalent). When unavailable, fall back to
    // `MINIMUM_CONTEXT_LENGTH` from compression-policy as the ctx_window —
    // Hermes' formula `max(pct × ctx, floor)` then resolves to exactly the
    // floor, which is the conservative right answer ("we don't know your
    // window, compact when we hit the smallest plausible value"). This
    // matches Hermes' own behaviour for models whose advertised window
    // isn't trusted (`auxiliary_client.py:227-239` per-model overrides
    // fall back to the floor when no override is set).
    const measuredCtx = await getSupervisorLoadedCtx();
    const loadedCtx =
      measuredCtx && measuredCtx > 0
        ? measuredCtx
        : cfg.minimum_context_length ?? 64_000;
    const threshold = hermesComputeThresholdTokens(loadedCtx, cfg);
    if (!hermesShouldCompress(realTokens, loadedCtx, cfg)) return;

    console.error(
      `[evy] hermes-compress (${stage}): ${realTokens} tok >= threshold ${threshold} (ctx=${loadedCtx}, pct=${cfg.threshold}) — invoking LLM summariser`,
    );
    broadcast("compact_warning", {
      ts: new Date().toISOString(),
      stage: `hermes-${stage}`,
      initiator: `hermes-${stage}`,
      current_tokens: realTokens,
      warn_at: threshold,
      compact_at: threshold,
      threshold_used: "hermes_compression_threshold",
      reason: `real_prompt_tokens=${realTokens} >= max(${cfg.threshold}×${loadedCtx}, ${cfg.minimum_context_length ?? 64000})=${threshold}`,
    });

    // Pick the auxiliary model. Config.yaml override > active supervisor.
    const auxModel = cfg.auxiliary_model
      ? {
          provider: cfg.auxiliary_model.provider,
          model: cfg.auxiliary_model.model,
          baseUrl: cfg.auxiliary_model.base_url,
        }
      : (() => {
          // Fall back to the configured supervisor for this profile. Same
          // pattern memory-kernel-reviewer uses at server.ts:3081.
          const sup = (() => {
            try {
              return {
                provider: agent.state.provider ?? "openai-codex",
                model: (agent.state as { model?: string }).model ?? "gpt-5.5",
              };
            } catch {
              return { provider: "openai-codex", model: "gpt-5.5" };
            }
          })();
          return { provider: sup.provider, model: sup.model, baseUrl: undefined };
        })();

    // Snapshot agent.state.messages so the compactor sees a stable input.
    const snapshot = (agent.state.messages as HermesCompactableMessage[]).map(
      (m) => ({ ...m }),
    );

    const result = await hermesCompressTranscript(
      snapshot,
      {
        threshold_tokens: threshold,
        protect_first_n: cfg.protect_first_n ?? 3,
        protect_last_n: cfg.protect_last_n ?? 20,
        target_ratio: cfg.target_ratio ?? 0.20,
        abort_on_summary_failure: cfg.abort_on_summary_failure ?? false,
      },
      {
        llmFetcher: async (messages, opts) => {
          // Reuse the same supervisor-fetcher shape used by
          // memory-kernel-reviewer (server.ts:3061). For v3.3.6 we route
          // through the active supervisor's fetcher; if the operator wants
          // a separate cheap aux endpoint they can wire it via
          // `compression.auxiliary_model.base_url` + provider-side
          // routing. Full standalone aux-model dispatch is a v3.3.7+
          // follow-up.
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          const token = getApiKeyForProvider(opts.provider);
          if (token && token !== "not-needed") {
            headers["Authorization"] = `Bearer ${token}`;
          }
          const body = {
            model: opts.model,
            messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.max_tokens ?? 4096,
            stream: false,
          };
          const baseUrl = opts.baseUrl ?? "https://api.openai.com";
          const r = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: opts.signal,
          });
          if (!r.ok) {
            const t = await r.text().catch(() => "");
            throw new Error(`aux summariser ${r.status}: ${t.slice(0, 300)}`);
          }
          const json = (await r.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return json.choices?.[0]?.message?.content ?? "";
        },
        auxiliaryModel: () => auxModel,
        estimateTokens: (msgs) =>
          estimateTranscriptTokens(msgs as Array<{ content?: unknown }>),
      },
      null, // no prior-summary chaining in v3.3.6
    );

    if (!result.ok) {
      console.error(
        `[evy] hermes-compress (${stage}) FAILED: ${result.error ?? "unknown"} — notes: ${result.notes.join("; ")}`,
      );
      return;
    }
    if (result.collapsed_count === 0) {
      console.error(
        `[evy] hermes-compress (${stage}) noop — ${result.notes.join("; ")}`,
      );
      return;
    }

    // Archive the original transcript before replacement. Mirrors what
    // compactTranscriptInline does at line 3422.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = AGENT_STATE_PATH.replace(
      /\.json$/,
      `.archive-hermes-${stage}-${ts}.json`,
    );
    if (existsSync(AGENT_STATE_PATH)) {
      try {
        const { copyFileSync } = require("node:fs") as typeof import("node:fs");
        copyFileSync(AGENT_STATE_PATH, archivePath);
      } catch (e) {
        console.error(
          `[evy] hermes-compress archive failed (continuing): ${(e as Error).message}`,
        );
      }
    }
    agent.state.messages.length = 0;
    for (const m of result.messages) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent.state.messages.push(m as any);
    }
    console.error(
      `[evy] hermes-compress (${stage}) ok — collapsed ${result.collapsed_count} middle msg(s), final ${result.final_tokens} tok, llm=${result.llm_invoked}`,
    );
  }

  async function processOnePrompt(p: PendingPrompt): Promise<{ ok: boolean; error?: string }> {
    try {
      // ── v2.7.19 circuit-breaker reset ──────────────────────────────────
      // Operator messages (chat or telegram) start a fresh turn and clear
      // any in-flight breaker state. Synthetic prompts (source="watchdog",
      // covers [verifier]/[watchdog]/[scheduled]/[team-report]) DON'T
      // reset — they're tail continuations of the prior turn's reasoning,
      // not new operator intent.
      // v2.8.12 — "mcp" source treated like chat (operator intent from
      // an external MCP client — Claude Desktop, ArgentOS, etc.).
      if (p.source === "chat" || p.source === "telegram" || p.source === "mcp") {
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
      // ── v3.3.6 Hermes pre-flight trigger ────────────────────────────────
      // Layered on top of the legacy gate. Loads compression.threshold from
      // config.yaml (default 0.50), computes max(pct × ctx, 64K), and runs
      // the LLM-driven compactor when the real-token estimate crosses the
      // threshold. Coexists with runJitCompactCheck — both gates leave the
      // transcript valid for the next agent.prompt() call.
      //
      // v3.3.7 — pre-flight uses the PREVIOUS turn's `prompt_tokens` from
      // `lastSupervisorUsage` (populated by the fetch interceptor). When
      // null (first turn after boot, fetch sniffer disabled, or non-OpenAI-
      // shape provider) the helper falls back to the char/4 estimator.
      try {
        await runHermesCompactCheck(
          "pre-flight",
          getLastSupervisorUsage()?.prompt_tokens,
        );
      } catch (e) {
        console.error(
          `[evy] hermes pre-flight threw (continuing): ${(e as Error).message}`,
        );
      }

      // ── v2.10.0 — Memory Cycle Phase 4: context-hydration injection ────
      // After any pending compact (jit gate above) has settled, but
      // BEFORE composeSystemPrompt + agent.prompt, prepend the latest
      // ready hydration payload as a synthetic `role:"user"` message.
      // The agent.prompt(p.text) call below then naturally appends the
      // operator's real prompt AFTER the hydration block.
      //
      // Why AFTER runJitCompactCheck (not at function top): if the JIT
      // compact fires this turn, it clears agent.state.messages and
      // calls scheduleHydration("post-compact") — the new payload
      // populates AFTER hydrateContext's async resolves. We check the
      // flag here so EITHER a boot-pending payload OR a freshly-set
      // post-compact payload (when it has time to land) gets prepended
      // on the same turn. Boot-pending is the common case; the post-
      // compact race is acceptable because the next operator turn
      // picks it up.
      if (_pendingHydrationPayload !== null) {
        const payload = _pendingHydrationPayload;
        _pendingHydrationPayload = null;
        try {
          // v2.10.x CodeRabbit pass-4: tag the synthetic hydration
          // message with `_ephemeral: true` so saveAgentTranscript's
          // dropEphemeralMessages filter strips it before writing to
          // agent-state.json. The pi-agent-core supervisor still sees
          // the message in-memory this turn (which is the whole point
          // — Phase 4 hydration), but it's NEVER persisted to the
          // durable transcript. Without this marker, every boot would
          // accumulate stale `[memory-context-hydration]` blocks in
          // the audit file and they'd replay forever on restore.
          agent.state.messages.push({
            role: "user",
            content: [{ type: "text", text: payload }],
            timestamp: Date.now(),
            _ephemeral: true,
          } as any);
          logDecision({
            project: "_master",
            action: "context_hydrated",
            rationale: `prepended ${payload.length}-char [memory-context-hydration] block on ${p.source} prompt (ephemeral — not persisted)`,
          });
          try {
            broadcast("context_hydration_injected", {
              ts: new Date().toISOString(),
              source: p.source,
              payload_chars: payload.length,
            });
          } catch {
            /* never block on broadcast */
          }
          console.error(
            `[context-hydration] injected ${payload.length} chars into transcript ahead of ${p.source} prompt`,
          );
        } catch (err) {
          // Push failure is unrecoverable for THIS turn; the flag is
          // already cleared so it doesn't loop on the next prompt.
          console.error(
            `[context-hydration] inject failed: ${(err as Error).message ?? String(err)} — continuing without hydration`,
          );
        }
      }

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
      // ── v3.3.6 Hermes post-turn trigger ─────────────────────────────────
      // After the assistant's response lands, re-check the transcript
      // against the threshold. Mirrors Hermes' post-iteration check at
      // `agent/conversation_loop.py:3636-3663`. Runs BEFORE the transient-
      // retry path so a retry never inherits a known-over-budget window.
      //
      // v3.3.7 — post-turn uses the JUST-LANDED turn's `prompt_tokens`.
      // The fetch interceptor records usage as the stream's tail-chunk
      // is read, which finishes BEFORE pi-agent-core's stream consumer
      // sees `[DONE]` — so by the time we reach here the latest record
      // already reflects this turn.
      try {
        await runHermesCompactCheck(
          "post-turn",
          getLastSupervisorUsage()?.prompt_tokens,
        );
      } catch (e) {
        console.error(
          `[evy] hermes post-turn threw (continuing): ${(e as Error).message}`,
        );
      }
      let { stop, err } = lastStopReason();
      if (stop === "error" && isTransient(err) && !stopped) {
        console.error(`[evy] transient error "${err}" (source=${p.source}), retrying in 5s`);
        // ── v3.3.6 Hermes recovery trigger ────────────────────────────────
        // If the error LOOKS like a context-overflow (HTTP 400 from the
        // provider, or a clear "context length exceeded" / "too many
        // tokens" message), compact BEFORE the retry. Mirrors Hermes'
        // recovery path at `agent/conversation_loop.py:2499-2520`. For
        // non-overflow transient errors (rate limit, timeout) the
        // compact would be no-op anyway since transcript hasn't grown.
        const errStr = String(err ?? "").toLowerCase();
        const looksLikeOverflow =
          errStr.includes("context") ||
          errStr.includes("too many tokens") ||
          errStr.includes("maximum context") ||
          errStr.includes("token limit");
        if (looksLikeOverflow) {
          // v3.3.7 — recovery uses the JUST-FAILED turn's `prompt_tokens`
          // (already captured by the interceptor — the failure on the
          // provider side doesn't prevent us from having parsed the
          // request-time usage, when present).
          try {
            await runHermesCompactCheck(
              "recovery",
              getLastSupervisorUsage()?.prompt_tokens,
            );
          } catch (e) {
            console.error(
              `[evy] hermes recovery threw (continuing): ${(e as Error).message}`,
            );
          }
        }
        await new Promise((r) => setTimeout(r, 5000));
        await agent.prompt(p.text);
        ({ stop, err } = lastStopReason());
      }
      // ── v2.10.x CodeRabbit pass-5: one-shot hydration cleanup ──────────
      // The pass-4 `_ephemeral: true` flag kept the hydration block off
      // disk, but the message itself remained in `agent.state.messages`
      // and bloated every subsequent supervisor call's token budget.
      // The model has now consumed (or attempted to consume) the
      // hydration on this turn's dispatch — strip the ephemeral
      // message(s) from in-memory state so turn 2+ proceeds without
      // them. Runs BEFORE the verifier gate so claim verification +
      // any synthetic re-prompt sees a clean transcript without the
      // bootstrap noise.
      try {
        const stripped = stripEphemeralInPlace(agent.state.messages);
        if (stripped > 0) {
          console.error(
            `[context-hydration] stripped ${stripped} ephemeral message(s) from in-memory transcript after ${p.source} dispatch — one-shot consumed`,
          );
        }
      } catch (stripErr) {
        // Stripping is best-effort. The disk-persistence filter
        // (dropEphemeralMessages inside saveAgentTranscript) is still
        // load-bearing for durability; this is just the in-memory
        // hygiene pass. Worst case: the block lingers for the rest
        // of this session, but never lands on disk.
        console.error(
          `[context-hydration] strip threw (best-effort, continuing): ${(stripErr as Error).message ?? String(stripErr)}`,
        );
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
              console.error(`[evy] telegram auto-relay failed: ${err.message}`);
            });
          }
        } catch (err) {
          console.error(`[evy] telegram auto-relay setup failed: ${(err as Error).message}`);
        }
      }

      // ── v3.1.0 Kernel Fitness Phase 1: chat surface emission ─────────────
      // Each completed dashboard/MCP turn produces exactly one
      // `chat_response` surface in the engagement ledger. The dashboard
      // SSE consumer latches the returned surface_id onto the just-
      // finished assistant bubble so an operator reply → `acted` and a
      // dismiss click → `acked` can be attributed back here. Telegram
      // turns are surface-emitted via the outbound path
      // (`tools/telegram.ts` → `notePendingTelegramSurface`) instead —
      // skipping double-emission here keeps the per-surface accounting
      // clean. Watchdog / scheduled / verifier synth prompts aren't
      // operator surfaces and aren't recorded.
      if (
        !isInternalSynthPrompt &&
        !stopped &&
        (p.source === "chat" || p.source === "mcp")
      ) {
        try {
          const turn = extractLastTurn(
            agent.state.messages as ReadonlyArray<{ role?: string; content?: unknown }>,
          );
          const text = (turn.text || "").trim();
          if (text) {
            const ts = new Date().toISOString();
            const surface_id = makeSurfaceId("chat_response", text, ts);
            recordSurfaceEmitted(
              surface_id,
              "chat_response",
              hashPayload(text),
            );
            // Surface a discrete SSE event so the dashboard chat panel
            // can latch the surface_id onto the just-finished bubble.
            // A new event type (rather than piggybacking on `agent_end`)
            // keeps the contract forward-compatible: future surface
            // types can emit the same `surface_emitted` event without
            // disturbing existing SSE consumers.
            broadcast("surface_emitted", {
              ts,
              surface_id,
              surface_type: "chat_response",
              source: p.source,
            });
          }
        } catch (err) {
          console.error(
            `[engagement] chat surface emission failed: ${(err as Error).message}`,
          );
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
    source: "chat" | "telegram" | "watchdog" | "mcp",
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
  const masterPort = Number(process.env.SUBCTL_EVY_PORT ?? 8788);
  // Default 127.0.0.1 — master is the brain; the dashboard server proxies
  // public traffic. Keeps the agent off the open LAN by default.
  const masterHost = process.env.SUBCTL_EVY_HOST ?? "127.0.0.1";

  // Forward-declared so the fetch handler can capture it; assignment
  // happens after the watchdog ticker block below. The /upstreams/check
  // route guards on null to handle the (vanishingly small) window
  // between Bun.serve() returning and the watchdog being armed.
  let upstreamWatchdog: UpstreamWatchdogHandle | null = null;

  // Forward-declared so the Bun.serve fetch handler can reference the
  // MCP handle. Assigned later in the boot block after startMcpServer().
  let mcpHandle: Awaited<ReturnType<typeof startMcpServer>> | null = null;

  const httpServer = Bun.serve({
    port: masterPort,
    hostname: masterHost,
    // SSE connections are long-lived. Default 10s idleTimeout drops them
    // and the dashboard chat panel would lose its event stream every 10s
    // when there's no agent activity to send. Disable.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // ── MCP routes ──────────────────────────────────────────────────────
      // Forward /.well-known/mcp + /mcp/* to the MCP handle when the
      // server is armed. The handle itself enforces auth + discovery
      // exposure rules; we just route by pathname.
      if (mcpHandle && (url.pathname === "/.well-known/mcp" || url.pathname.startsWith("/mcp"))) {
        return mcpHandle.handle(req);
      }

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

      // ── /api/debug/usage — v3.3.8 introspection, v3.3.10 diagnostics ─
      // Returns the latest `lastSupervisorUsage` captured by the
      // globalThis.fetch interceptor in supervisor-usage-capture.ts plus
      // v3.3.10 wrapper counters (fetch_calls_observed / matched / captured
      // + last_matched_url). Operator-facing diagnostic so the live capture
      // path can be verified after deploys without booting a debugger or
      // growing the transcript to threshold.
      //
      // Reading the counters:
      //   - fetch_calls_observed = 0      → wrapper not installed
      //   - observed > 0, matched = 0     → wrapper alive but supervisor
      //                                     uses a non-fetch transport
      //                                     (WebSocket, raw TCP, …). The
      //                                     openai-codex-responses provider
      //                                     defaults to WebSocket; HTTP is
      //                                     the fallback only.
      //   - matched > 0, captured = 0     → URL matched but the response
      //                                     stream didn't carry a usage
      //                                     object (older OpenAI Chat
      //                                     Completions without
      //                                     stream_options.include_usage,
      //                                     for example — but v3.3.7's
      //                                     outbound rewrite should be
      //                                     setting that).
      //   - captured > 0                  → working as designed.
      //
      // Read-only; safe to expose unguarded.
      if (
        url.pathname === "/api/debug/usage" &&
        (req.method === "GET" || req.method === undefined)
      ) {
        const u = getLastSupervisorUsage();
        return Response.json({
          ok: true,
          last_supervisor_usage: u,
          captured: u !== null,
          diagnostics: getCaptureDiagnostics(),
          version: SUBCTL_VERSION,
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
      // describeBackendChain() directly via evy-notify-listener.
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
      // directly via evy-notify-listener. Routes:
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

      // ── /upstreams/history — v2.7.37 dashboard manual-update history ────
      // Reads the upstream-update audit log (JSONL written by the watchdog
      // + every manual trigger). Newest-first, capped at 500 entries. The
      // event field is normalized: the audit log writes "failure" but the
      // dashboard payload uses "error" per the v2.7.37 spec.
      if (url.pathname === "/upstreams/history" && req.method === "GET") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw
          ? Math.max(1, Math.min(500, Number(limitRaw) || 50))
          : 50;
        try {
          const raw: AuditEntry[] = readUpdateHistory({ limit });
          const entries = raw.map((e) => ({
            ts: e.ts,
            event: e.event === "failure" ? "error" : e.event,
            package: e.package,
            from: e.from,
            to: e.to,
            branch: e.branch,
            trigger: e.trigger,
            detail: e.detail,
          }));
          return Response.json({ ok: true, entries });
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }

      // ── /upstreams/update — v2.7.37 manual upstream-update trigger ──────
      // Bypasses the 24h throttle. Runs the full worktree → bun install →
      // bun test → bun build → typecheck → commit → push pipeline. Never
      // merges to main. Returns the first updated branch name on success.
      // Long-running: dashboards should treat this as fire-and-poll —
      // history endpoint reflects the outcome once the runner completes.
      if (url.pathname === "/upstreams/update" && req.method === "POST") {
        try {
          // Body is optional. If provided, accept { package?: string } to
          // narrow the trigger to one package; otherwise run every tracked
          // upstream that has a newer version.
          let body: { package?: string } = {};
          try {
            const text = await req.text();
            if (text.trim()) body = JSON.parse(text) as typeof body;
          } catch {
            // malformed JSON → treat as empty body, run every package
          }
          const summary = await runManualUpdate({
            packageJsonPath: join(COMPONENT_DIR, "package.json"),
            package: body.package,
          });
          // Find the first ok outcome with a branch (the operator wants
          // the URL/branch to inspect). If none succeeded, surface the
          // first failure detail.
          const updates = summary.auto_update ?? [];
          const succeeded = updates.find((u) => u.outcome.ok && u.outcome.branch);
          if (succeeded) {
            return Response.json({
              ok: true,
              branch: succeeded.outcome.branch,
              package: succeeded.package,
              from: succeeded.from,
              to: succeeded.to,
              detail: succeeded.outcome.detail,
            });
          }
          const noOp = updates.length === 0;
          if (noOp) {
            // Nothing to do — no newer versions on the registry.
            return Response.json({
              ok: true,
              branch: null,
              detail: "no upstream updates available",
            });
          }
          const firstFail = updates[0]!;
          return Response.json(
            {
              ok: false,
              error: firstFail.outcome.detail,
              package: firstFail.package,
              from: firstFail.from,
              to: firstFail.to,
              stderr_excerpt: firstFail.outcome.stderr_excerpt,
            },
            { status: 500 },
          );
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
      }

      // ── /upstreams/auto-update/toggle — v2.7.37 auto-update gate ────────
      // Flips the ~/.config/subctl/auto-update-upstreams.enabled flag.
      // Body shape: { enabled?: boolean } — if provided sets explicitly,
      // otherwise toggles the current state. Returns the resulting state.
      if (
        url.pathname === "/upstreams/auto-update/toggle" &&
        req.method === "POST"
      ) {
        try {
          let body: { enabled?: boolean } = {};
          try {
            const text = await req.text();
            if (text.trim()) body = JSON.parse(text) as typeof body;
          } catch {
            // malformed JSON → treat as empty body and toggle
          }
          const current = isAutoUpdateEnabled();
          const next =
            typeof body.enabled === "boolean" ? body.enabled : !current;
          const ok = setAutoUpdateEnabled(next);
          if (!ok) {
            return Response.json(
              { ok: false, error: "failed to write auto-update flag" },
              { status: 500 },
            );
          }
          return Response.json({ ok: true, enabled: isAutoUpdateEnabled() });
        } catch (err) {
          return Response.json(
            { ok: false, error: (err as Error).message },
            { status: 500 },
          );
        }
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
        let body: {
          candidate_id?: unknown;
          note?: unknown;
          text_override?: unknown;
          source_type_override?: unknown;
        };
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
        // v2.9.0 (Tier 1 Consolidator) — Apply path on the dashboard
        // modal hands us the operator-edited consolidated text + the
        // consolidator's chosen highest-trust source_type. Both flow
        // through tier1-candidates → writeTier1 → memory_remember.
        const textOverride =
          typeof body.text_override === "string" && body.text_override.trim().length > 0
            ? body.text_override.trim()
            : undefined;
        const sourceTypeOverride =
          typeof body.source_type_override === "string" &&
          body.source_type_override.trim().length > 0
            ? body.source_type_override.trim()
            : undefined;
        // CodeRabbit pass-4: validate source_type_override against the
        // canonical enum used by memory_remember (tools/tier1-memory.ts).
        // Reject unknown values with 400 instead of silently letting
        // garbage flow into the [source:<x>] provenance tag.
        const allowedSourceTypes = new Set([
          "operator-asserted",
          "verified-external",
          "self-inferred",
          "agent-reported",
        ]);
        if (
          sourceTypeOverride !== undefined &&
          !allowedSourceTypes.has(sourceTypeOverride)
        ) {
          return Response.json(
            {
              ok: false,
              error: `invalid source_type_override "${sourceTypeOverride}" (allowed: ${[...allowedSourceTypes].join(", ")})`,
            },
            { status: 400 },
          );
        }
        try {
          const result = await approveTier1Candidate(candidateId, {
            resolved_by: "operator",
            note,
            text_override: textOverride,
            source_type_override: sourceTypeOverride,
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

      // ── /memory/tier1/consolidate — Tier 1 Consolidator (v2.9.0) ─────────
      //
      // LLM-driven dedup pass for the pending candidate queue. Reads the
      // current memory.md + listTier1Pending(), sends to the supervisor
      // model (via the same wire-format helper the memory-kernel reviewer
      // uses), returns a structured proposal:
      //   { ok, proposal[], dropped_candidate_ids[], dropped_reasons{},
      //     pending_unchanged_candidate_ids[], char_total, char_budget,
      //     char_current, headroom_after, reviewer_model, llm_raw_response? }
      //
      // Operator-in-the-loop required by design — this endpoint NEVER
      // writes Tier 1. The dashboard modal renders the proposal and the
      // operator clicks Apply, which then calls the existing approve/reject
      // endpoints (with text_override on approve).
      //
      // Body: { dry_run?: boolean } — when true, the response includes the
      // raw LLM text for debugging.
      if (url.pathname === "/memory/tier1/consolidate" && req.method === "POST") {
        let body: { dry_run?: unknown };
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as typeof body) : {};
        } catch {
          return Response.json(
            { ok: false, error: "invalid JSON body" },
            { status: 400 },
          );
        }
        const dryRun = body.dry_run === true;

        // Wire the supervisor identity + LLM transport the same way the
        // memory-kernel ticker does — prefer providers.models.reviewer,
        // fall back to the active supervisorCfg. Re-resolve at request
        // time so profile swaps and provider edits land without restart.
        // CodeRabbit pass-3/4: defensively fall back to supervisorCfg if the
        // reviewer slot is present-but-unresolvable (explicitly false, empty
        // object, missing required keys, throws). Pass-4 adds structural
        // validation — a resolveRoleCfg that returns successfully but lacks
        // provider/model would otherwise sneak through.
        const isUsableRoleCfg = (
          cfg: Partial<{ provider: string; model: string }>,
        ): cfg is { provider: string; model: string } =>
          typeof cfg?.provider === "string" &&
          cfg.provider.trim().length > 0 &&
          typeof cfg?.model === "string" &&
          cfg.model.trim().length > 0;
        let reviewerCfg = supervisorCfg;
        if (providers.models.reviewer) {
          try {
            const resolved = resolveRoleCfg("reviewer", providers.models.reviewer, providers);
            reviewerCfg = isUsableRoleCfg(resolved) ? resolved : supervisorCfg;
          } catch {
            reviewerCfg = supervisorCfg;
          }
        }
        // CodeRabbit pass-1/2/5: fall back to provider-default base URL
        // when reviewerCfg.host is empty. The consolidator does a DIRECT
        // OpenAI-compat chat-completion HTTP fetch (not via pi-ai), so
        // only providers whose canonical wire format IS OpenAI-compat
        // make sense here. Reject non-compat providers (anthropic,
        // google, mistral, openai-codex which talks to chatgpt.com/backend-api)
        // early with a clear error instead of falling through to the
        // generic "host not configured" 500.
        // CodeRabbit pass-7: trim + treat empty-string as unset.
        // `??` only catches null/undefined, but reviewerCfg.host = ""
        // (operator cleared the field) should also trigger the fallback.
        const normalizedHost =
          typeof reviewerCfg.host === "string" && reviewerCfg.host.trim().length > 0
            ? reviewerCfg.host.trim()
            : undefined;
        const resolvedHost =
          normalizedHost
          ?? (LOCAL_PROVIDERS.has(reviewerCfg.provider)
            ? ((reviewerCfg.provider === "omlx"
                || reviewerCfg.provider === "ollama"
                || reviewerCfg.provider === "lmstudio")
              ? getLocalBackendAdapter(reviewerCfg.provider as LocalBackendKind).defaultHost
              : "http://localhost:1234/v1")
            : reviewerCfg.provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : reviewerCfg.provider === "xai-oauth"
                ? getXaiOauthBaseUrl()
                : "");
        // CodeRabbit pass-6: openai removed from the fallback list — though
        // api.openai.com/v1 IS OpenAI-compat, getApiKeyForProvider("openai")
        // doesn't resolve an OPENAI_API_KEY in this flow (only lmstudio and
        // omlx have explicit secret-resolution paths). Adding it would send
        // unauthenticated requests. Operator can use openrouter for cloud
        // reviewer or any local backend.
        const baseUrl = resolvedHost.replace(/\/v1\/?$/, "");
        if (!baseUrl) {
          const openaiCompat = "lmstudio, ollama, omlx, openrouter, xai-oauth, mlx, vllm";
          return Response.json(
            {
              ok: false,
              error: `reviewer provider "${reviewerCfg.provider}" isn't OpenAI-compatible for the consolidator. The consolidator does a direct OpenAI chat-completions call — pick a reviewer from: ${openaiCompat}. (Set via providers.json models.reviewer or use the dashboard's chat model picker.)`,
              reviewer_model: `${reviewerCfg.provider}/${reviewerCfg.model}`,
            },
            { status: 400 },
          );
        }
        // CodeRabbit pass-9: snapshot pending list + memory once up-front
        // so the LLM sees a CONSISTENT view across the empty-check,
        // prompt-build, char-budget-math, and post-LLM validation steps.
        // Without this, a candidate landing mid-consolidate could show up
        // in one read and disappear in the next.
        const pendingSnapshot = listTier1Pending();
        const memorySnapshot = readTier1MemoryFile();
        const consolidatorDeps: Tier1ConsolidatorDeps = {
          listPending: () => pendingSnapshot,
          readMemoryContent: () => memorySnapshot.content,
          charBudget: () => memorySnapshot.char_limit,
          configuredSupervisor: () => ({
            provider: reviewerCfg.provider,
            model: reviewerCfg.model,
          }),
          llmFetcher: async (messages, opts) => {
            const token = getApiKeyForProvider(reviewerCfg.provider);
            // CodeRabbit pass-8: fail fast when credentials are required
            // but missing. openrouter and xai-oauth require real tokens;
            // an undefined here would result in an unauthenticated request
            // that the upstream rejects with a confusing 401. Surface a
            // clear configuration error instead.
            const requiresAuth =
              reviewerCfg.provider === "openrouter" ||
              reviewerCfg.provider === "xai-oauth";
            if (requiresAuth && (token === undefined || token === "not-needed")) {
              throw new Error(
                `missing API key for reviewer provider "${reviewerCfg.provider}". ` +
                  `Set ${reviewerCfg.provider === "openrouter" ? "openrouter_api_key" : "xai_oauth_*"} ` +
                  `in ~/.config/subctl/secrets.json or via the dashboard Secrets panel.`,
              );
            }
            return memoryKernelSupervisorFetcher(messages, {
              ...opts,
              baseUrl,
              authToken: token === "not-needed" ? undefined : token,
            });
          },
        };
        try {
          const result = await tier1Consolidate({ dry_run: dryRun }, consolidatorDeps);
          // ok:false carries reviewer_model so the dashboard can still
          // surface which supervisor was attempted.
          return Response.json(result, { status: result.ok ? 200 : 500 });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              error: `consolidate threw: ${(err as Error).message}`,
              reviewer_model: `${reviewerCfg.provider}/${reviewerCfg.model}`,
            },
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
      // current loaded context length per supervisor model from whichever
      // local backend resolveRoleCfg routed us to (LM Studio populates
      // loaded_context_length; oMLX populates context_length; Ollama
      // doesn't expose load-time context per model and falls through to
      // null, which the UI renders as "—").
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
        // Get loaded context window via the adapter for the resolved
        // supervisor backend. Pre-Phase-4 this hit LM Studio's native
        // /api/v0/models directly — that quietly mis-fired against
        // Ollama / oMLX hosts. getSupervisorLoadedCtx routes through the
        // adapter's listModels and reads LocalModel.context_length, which
        // is populated where the backend exposes it.
        const loadedContext = await getSupervisorLoadedCtx(1500);
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
          const r = await ensureModelLoaded(cfg, role, providers);
          results.push({ role, ...r });
        }
        return Response.json({ ok: results.every((r) => r.ok), results });
      }

      // ── /local-backend — Phase 4 local-inference-backend control ──────
      //
      // GET  returns the current backend config + reachability + catalog.
      // POST {kind, host, models} persists, re-resolves role assignments,
      //      returns the updated GET shape.
      // POST /local-backend/test {kind, host, api_key?} runs a non-destructive
      //      health probe without persisting.
      //
      // Internal 127.0.0.1-only — same trust boundary as /profile.
      if (url.pathname === "/local-backend/test" && req.method === "POST") {
        let body: { kind?: string; host?: string; api_key?: string | null } = {};
        try { body = await req.json(); } catch { /* empty body 400 below */ }
        const kindRaw = body.kind ?? "";
        // CodeRabbit pass-9 (3): pass body.host so the kind-resolve agrees
        // with the migration heuristic — picking "omlx" for a legacy
        // `mlx`/`vllm` tag on :8000.
        const mappedKind = mapToLocalBackendKind(kindRaw, body.host ?? null);
        if (!mappedKind) {
          return Response.json({
            ok: false,
            error: `unknown kind "${kindRaw}" — supported: ${listLocalBackendKinds().join(", ")}`,
          }, { status: 400 });
        }
        const adapter = getLocalBackendAdapter(mappedKind);
        const host = body.host?.trim() || adapter.defaultHost;
        const apiKey =
          body.api_key ??
          (mappedKind === "lmstudio"
            ? resolveSecret("lmstudio_api_token")
            : mappedKind === "omlx"
              ? resolveSecret("omlx_api_token")
              : null);
        const probe = await adapter.healthProbe(host, {
          api_key: apiKey,
        });
        return Response.json({
          ok: probe.ok,
          detail: probe.detail,
          model_count: probe.model_count ?? null,
          reachable_at: probe.reachable_at ?? null,
        });
      }

      if (url.pathname === "/local-backend" && req.method === "GET") {
        const lb = providers.local_backend;
        if (!lb) {
          return Response.json({
            ok: true,
            kind: null,
            host: null,
            models: {},
            available_models: [],
            health: { ok: false, detail: "no local_backend configured" },
            last_verified: null,
          });
        }
        const adapter = getLocalBackendAdapter(lb.kind);
        const apiKey =
          lb.kind === "lmstudio"
            ? resolveSecret("lmstudio_api_token")
            : lb.kind === "omlx"
              ? resolveSecret("omlx_api_token")
              : null;
        const health = await adapter.healthProbe(lb.host, { api_key: apiKey });
        let available: unknown[] = [];
        if (health.ok) {
          try {
            available = await adapter.listModels(lb.host, { api_key: apiKey });
          } catch (err) {
            // listModels failure shouldn't fail the whole GET — leave
            // available empty and let the health row tell the operator
            // what's broken.
            console.error(`[local-backend] listModels(${lb.kind}) failed: ${(err as Error).message}`);
          }
        }
        return Response.json({
          ok: true,
          kind: lb.kind,
          host: lb.host,
          models: lb.models,
          available_models: available,
          health,
          last_verified: lb.last_verified ?? null,
        });
      }

      if (url.pathname === "/local-backend" && req.method === "POST") {
        let body: {
          kind?: string;
          host?: string;
          models?: Record<string, unknown>;
        } = {};
        try { body = await req.json(); } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const kindRaw = body.kind ?? "";
        // CodeRabbit pass-9 (3): pass body.host so the kind-resolve agrees
        // with the migration heuristic — picking "omlx" for a legacy
        // `mlx`/`vllm` tag on :8000.
        const mappedKind = mapToLocalBackendKind(kindRaw, body.host ?? null);
        if (!mappedKind) {
          return Response.json({
            ok: false,
            error: `unknown kind "${kindRaw}" — supported: ${listLocalBackendKinds().join(", ")}`,
          }, { status: 400 });
        }
        const adapter = getLocalBackendAdapter(mappedKind);
        const host = body.host?.trim() || adapter.defaultHost;
        const apiKey =
          mappedKind === "lmstudio"
            ? resolveSecret("lmstudio_api_token")
            : mappedKind === "omlx"
              ? resolveSecret("omlx_api_token")
              : null;
        const health = await adapter.healthProbe(host, { api_key: apiKey });
        // CodeRabbit pass-7 (1): refuse to mutate providers.local_backend or
        // persist when the probe failed. Previously the handler would assign
        // providers.local_backend and call persistProviders regardless of
        // health.ok, leaving the operator with a persisted-but-unreachable
        // config and (more importantly) clobbering whatever previously
        // working backend was already there. Guard placed BEFORE any mutation
        // so prevModels and the prior providers.local_backend stay untouched.
        if (!health.ok) {
          return Response.json({
            ok: false,
            error: `local_backend health probe failed: ${health.detail ?? "unknown error"} — previous configuration preserved`,
            health,
          }, { status: 400 });
        }
        const prevModels = providers.local_backend?.models ?? {};
        const incoming = body.models ?? {};
        // CodeRabbit pass-9 (2): merge composition now lives in the
        // exported `mergeModels` helper (presence-check semantics from
        // pass-4 (b) and the pass-1 normalizeModel invariant moved with it).
        // Tests import the same helpers so the contract has one home.
        const mergedModels = mergeModels(prevModels, incoming);
        // CodeRabbit pass-10 (1) — CRITICAL: supervisor is mandatory.
        // The pass-4 (b) presence-check semantics let operators clear a
        // role by sending an explicit `null` (— disabled — in the
        // dashboard). That's the right contract for `embeddings`,
        // `reviewer`, and `router` — all optional — but supervisor is
        // load-bearing: the daemon can't boot a turn without one, and
        // resolveRoleCfg("supervisor", ...) throws when it's null. Reject
        // BEFORE mutating providers.local_backend so the prior config
        // stays intact when the operator tried to clear supervisor.
        if (mergedModels.supervisor === null) {
          return Response.json({
            ok: false,
            error:
              "supervisor role cannot be cleared — pick a supervisor model before saving",
            health,
          }, { status: 400 });
        }
        providers.local_backend = {
          kind: mappedKind,
          host,
          models: mergedModels,
          last_verified: new Date().toISOString(),
        };
        // Re-rewrite any role still on a legacy local-provider id to
        // provider="local" so the new backend is actually used.
        for (const [role, cfg] of Object.entries(providers.models)) {
          if (!cfg || typeof cfg !== "object") continue;
          const p = (cfg as { provider?: string }).provider;
          if (p && LEGACY_LOCAL_PROVIDER_IDS.has(p)) {
            // CodeRabbit pass-7 (2): explicit `undefined` checks replace the
            // old truthy guards (`m && !mergedModels[role]`). The truthy form
            // treated operator-set `null` (an explicit "disabled") as missing
            // and overwrote it with the stale legacy `raw.model`, defeating
            // the pass-4 (b) presence-check semantics in mergedModels above.
            // Same null-vs-missing thread as pass-4 (b) and pass-6 (a).
            const m = (cfg as { model?: string | null }).model;
            if (m !== undefined && mergedModels[role] === undefined) {
              mergedModels[role] = m;
            }
            (cfg as { provider: string }).provider = "local";
          }
        }
        try {
          persistProviders(providers);
        } catch (err) {
          return Response.json({
            ok: false,
            error: `persist failed: ${(err as Error).message}`,
          }, { status: 500 });
        }
        // CodeRabbit pass-4 (c): rebind in-memory supervisor state so chat /
        // diag / context routes pick up the new local backend on the NEXT
        // prompt without a daemon restart. The original Phase 4 commit
        // message promised "no restart needed" but didn't actually reapply
        // supervisorCfg / supervisorModel / agent.state.model — the running
        // daemon kept dispatching to the old backend until manual restart.
        //
        // Mirrors applyProfileSwap (~L1872). We're outside processOnePrompt
        // here so we lack the promptInFlight guarantee — but readers either
        // grab supervisorCfg or supervisorModel independently (no caller
        // pairs them in a torn-read window), pi-agent-core reads
        // agent.state.model at the START of each prompt (not mid-turn), and
        // single JS field assignment is atomic. In-flight prompts keep
        // their captured model reference; the new value lands next prompt.
        // TODO: factor with profile-swap path.
        try {
          let entrySupervisor: string | undefined;
          let entryHost: string | undefined;
          try {
            const pf = loadProfiles();
            const entry = pf.profiles[pf.active];
            entrySupervisor = entry?.supervisor;
            entryHost = entry?.host;
          } catch (err) {
            console.error(
              `[local-backend] profiles reload during rebind failed (continuing without profile override): ${(err as Error).message}`,
            );
          }
          const newSupCfg = resolveRoleCfg(
            "supervisor",
            {
              ...supervisorCfgFromProviders,
              ...(entrySupervisor ? { model: entrySupervisor } : {}),
              ...(entryHost ? { host: entryHost } : {}),
            },
            providers,
          );
          supervisorCfg = newSupCfg;
          supervisorModel = buildModel(supervisorCfg);
          (agent.state as { model?: unknown }).model = supervisorModel;
          console.error(
            `[local-backend] supervisor rebound — ${supervisorCfg.provider}/${supervisorCfg.model} @ ${supervisorCfg.host ?? "(default)"}`,
          );
          broadcast("supervisor_swap", {
            ts: new Date().toISOString(),
            reason: "local-backend-change",
            supervisor: `${supervisorCfg.provider}/${supervisorCfg.model}`,
            backend: `${mappedKind}@${host}`,
          });
          // Re-pin context length on the new backend. Fire-and-forget;
          // first prompt after the swap will JIT-load if the pin is still
          // in flight (same pattern as applyProfileSwap).
          void ensureModelLoaded(supervisorCfg, "supervisor", providers)
            .then((r) =>
              console.error(
                `[local-backend] ${r.ok ? "ctx-pin" : "ctx-pin FAILED"} supervisor: ${r.detail}`,
              ),
            )
            .catch((err) =>
              console.error(`[local-backend] ctx-pin error: ${(err as Error).message}`),
            );
        } catch (err) {
          // Rebind failure is non-fatal: providers.json is already
          // persisted, the daemon will pick up the change on next restart.
          // Surface it loudly so the operator knows to restart.
          console.error(
            `[local-backend] supervisor rebind failed (daemon restart required to pick up change): ${(err as Error).message}`,
          );
        }
        // CodeRabbit pass-11 (1): mirror the pass-4 (c) supervisor rebind for
        // the memory-kernel's reviewer closure. The boot block at L2376–2461
        // captures `reviewerCfg` (a `const`) inside the `llmFetcher` and
        // `reviewEventsWired` closures and hands them to the kernel via
        // `_setMemoryKernelDepsForTesting`. The captured value is the closure
        // shape — the const itself cannot be reassigned — so the rebind path
        // is: rebuild fresh `llmFetcher` + `reviewEventsWired` closures with
        // a re-resolved `reviewerCfg`, then call the setter again. The
        // kernel's `runOneCycle` reads `deps.reviewEvents` at the START of
        // each tick (memory-kernel.ts:368), so the next tick uses the new
        // closures atomically. We only re-wire when TOOL_GATES.memory_kernel
        // is on — the kernel may have never been armed at boot (Memori
        // sidecar unreachable), in which case there's no ticker reading deps
        // and the re-wire would be a harmless no-op anyway.
        if (TOOL_GATES.memory_kernel) {
          try {
            const reviewerCfgRaw = providers.models?.reviewer ?? supervisorCfgFromProviders;
            const newReviewerCfg = resolveRoleCfg("reviewer", reviewerCfgRaw, providers);
            const baseUrl = (newReviewerCfg.host ?? "").replace(/\/v1\/?$/, "");
            const reviewerHasUsableHost = baseUrl.length > 0;
            if (!reviewerHasUsableHost) {
              console.error(
                `[local-backend] reviewer rebind — reviewer host not configured for ${newReviewerCfg.provider}/${newReviewerCfg.model}; kernel ticker will run no-op cycles until a host is set`,
              );
            }
            const llmFetcher = async (
              messages: Parameters<typeof memoryKernelSupervisorFetcher>[0],
              opts: Parameters<typeof memoryKernelSupervisorFetcher>[1],
            ): Promise<string> => {
              if (!reviewerHasUsableHost) return "";
              const token = getApiKeyForProvider(newReviewerCfg.provider);
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
                    provider: newReviewerCfg.provider,
                    model: newReviewerCfg.model,
                  }),
                });
            _setMemoryKernelDepsForTesting({ reviewEvents: reviewEventsWired });
            console.error(
              `[local-backend] reviewer rebound — ${newReviewerCfg.provider}/${newReviewerCfg.model} @ ${newReviewerCfg.host ?? "(default)"}`,
            );
            broadcast("reviewer_swap", {
              ts: new Date().toISOString(),
              reason: "local-backend-change",
              reviewer: `${newReviewerCfg.provider}/${newReviewerCfg.model}`,
              backend: `${mappedKind}@${host}`,
            });
          } catch (err) {
            console.error(
              `[local-backend] reviewer rebind failed (daemon restart required to pick up change): ${(err as Error).message}`,
            );
          }
        }
        logDecision({
          project: "_master",
          action: "local_backend_set",
          rationale: `kind=${mappedKind} host=${host} health=${health.ok ? "ok" : "fail"}`,
        });
        let available: unknown[] = [];
        if (health.ok) {
          try {
            available = await adapter.listModels(host, { api_key: apiKey });
          } catch (err) {
            console.error(`[local-backend] listModels(${mappedKind}) failed: ${(err as Error).message}`);
          }
        }
        return Response.json({
          ok: true,
          kind: mappedKind,
          host,
          models: mergedModels,
          available_models: available,
          health,
          last_verified: providers.local_backend.last_verified,
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
          // 1. Local-backend reachability + supervisor model present.
          // Pre-Phase-4 the row was hard-coded to "lmstudio" and hit a
          // raw $host/models URL. resolveRoleCfg can route supervisorCfg
          // through ollama or omlx — when it does, the old probe label
          // was misleading AND the path resolved against the wrong port.
          // Route through the adapter's listModels so the row name + the
          // endpoint match whichever runtime is actually serving.
          (async () => {
            const kind = mapToLocalBackendKind(supervisorCfg.provider, supervisorCfg.host);
            if (!kind) {
              return {
                name: "local-inference",
                ok: true,
                detail: `supervisor provider="${supervisorCfg.provider}" is cloud — no local backend probe`,
              };
            }
            const adapter = getLocalBackendAdapter(kind);
            const host = supervisorCfg.host ?? adapter.defaultHost;
            const apiKey =
              kind === "lmstudio"
                ? resolveSecret("lmstudio_api_token")
                : kind === "omlx"
                  ? resolveSecret("omlx_api_token")
                  : null;
            try {
              const models = await adapter.listModels(host, {
                timeout_ms: 2000,
                api_key: apiKey,
              });
              const ids = models.map((m) => m.id);
              const found = ids.includes(supervisorCfg.model);
              // CodeRabbit pass-11 (3): /diag readiness must reflect whether
              // the configured supervisor model is actually present in the
              // backend's listModels response. Returning ok=true even when
              // the model was missing made the green row a lie — the JIT
              // load promise is best-effort and the operator deserves a red
              // row when the chosen supervisor isn't loaded yet. listModels
              // succeeded (we're past the catch), so connectivity is fine;
              // ok now mirrors model presence.
              return {
                name: kind,
                ok: found,
                detail: `${ids.length} models available${found ? `, supervisor "${supervisorCfg.model}" present` : `, supervisor "${supervisorCfg.model}" NOT loaded (will JIT-load on first call)`}`,
              };
            } catch (err) {
              return { name: kind, ok: false, detail: (err as Error).message };
            }
          })(),
          // 2. Telegram bot reachable + listener actively polling
          (async () => {
            try {
              const notifyPath = join(SUBCTL_CONFIG_DIR, "evy-notify.json");
              if (!existsSync(notifyPath)) {
                return { name: "telegram", ok: false, detail: "evy-notify.json missing" };
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
                  detail: "no bot_token (or telegram_bot_token) in evy-notify.json",
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

      // ── Provider Model Catalog Phase 3 — aggregator routing ─────────────
      //
      // GET  /providers/<id>/upstream-catalog          — cached if fresh
      // POST /providers/<id>/upstream-catalog/refresh  — force live fetch
      //
      // Caches into the existing per-provider catalog file
      // (~/.config/subctl/catalogs/<id>.json) in the same on-disk shape
      // that dashboard/lib/catalogs.ts reads, so the existing
      // /api/catalogs/<id> reader + the per-model enable-toggle endpoint
      // continue to work against aggregator data.
      //
      // Proxied transparently by the dashboard /api/master/* catch-all.
      // Browser URL ends up as /api/master/providers/<id>/upstream-catalog.
      if (
        url.pathname.startsWith("/providers/") &&
        url.pathname.endsWith("/upstream-catalog") &&
        req.method === "GET"
      ) {
        const provider = url.pathname.slice("/providers/".length, url.pathname.length - "/upstream-catalog".length);
        if (!provider || provider.includes("/")) {
          return Response.json(
            { ok: false, error: "expected /providers/<id>/upstream-catalog" },
            { status: 400 },
          );
        }
        const result = await fetchUpstreamCatalog(provider, { forceLive: false });
        return Response.json(result, { status: result.ok ? 200 : 502 });
      }
      if (
        url.pathname.startsWith("/providers/") &&
        url.pathname.endsWith("/upstream-catalog/refresh") &&
        req.method === "POST"
      ) {
        const provider = url.pathname.slice(
          "/providers/".length,
          url.pathname.length - "/upstream-catalog/refresh".length,
        );
        if (!provider || provider.includes("/")) {
          return Response.json(
            { ok: false, error: "expected /providers/<id>/upstream-catalog/refresh" },
            { status: 400 },
          );
        }
        const result = await fetchUpstreamCatalog(provider, { forceLive: true });
        return Response.json(result, { status: result.ok ? 200 : 502 });
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

  console.error(`[evy] http listening on http://${masterHost}:${httpServer.port} — POST /chat, GET /events, GET /health`);

  // ── Telegram poll loop (evy-notify-listener) ────────────────────────
  // Each operator message arrives via the listener's onOperatorMessage
  // callback; we feed it into the same dispatchToAgent funnel that handles
  // dashboard-chat and watchdog-synthesized prompts. Source="telegram" so
  // the SSE stream + decision log can distinguish channels.
  const listenerResult = startMasterNotifyListener({
    onOperatorMessage: (msg) => {
      console.error(`[evy] telegram inbound from ${msg.from_name ?? "?"}: ${msg.text.slice(0, 80)}`);
      void dispatchToAgent(msg.text, "telegram");
    },
  });
  if (listenerResult.running) {
    console.error(`[evy] telegram listener armed`);
  } else {
    console.error(`[evy] telegram listener NOT armed: ${listenerResult.reason}`);
  }

  // ── notification Telegram push (v2.7.22) ───────────────────────────────
  // severity:"alert" notifications page the operator on Telegram. info /
  // warn stay in the dashboard tray only — the goal is to make the alert
  // surface itself selective so the operator can trust a Telegram buzz to
  // mean "you actually need to look at this". Subscribe AFTER the
  // listener arms; if evy-notify.json isn't configured, sendTelegramOutbound
  // throws and we swallow it.
  subscribeNotifications((n: Notification) => {
    if (n.severity !== "alert") return;
    const txt = `🚨 ${n.title}\n\n${n.body}`;
    void sendTelegramOutbound(txt).catch((err) => {
      console.error(
        `[evy] notification telegram push failed (${n.id}): ${(err as Error).message}`,
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
          // activity at now. Classify the visible pane content so a
          // worker that boots straight into a "work complete" state
          // doesn't get mistaken for "working" on the first tick.
          if (!existing) {
            const seedClassification = classifyWorkerReply(content);
            teamLastActivity.set(session, {
              ts: now,
              classification: seedClassification,
            });
          } else {
            // Bump only if our new "now" is later than existing — it
            // always is in practice, but defensively ordered.
            if (now > existing.ts) {
              // v2.8.14 — re-classify the actual pane content on every
              // hash change. Previously this path preserved the stale
              // spawn-time "working" classification forever, which is
              // why a worker that replied via the pane (auto-nudge
              // response path) kept getting escalated as silent.
              // Routed through the pure helper so the decision logic
              // is unit-testable (see watchdog-pane-classify.test.ts).
              teamLastActivity.set(
                session,
                deriveActivityFromPaneCapture({
                  existing,
                  paneText: content,
                  now,
                }),
              );
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
      // v2.8.14 — nudge/reply observability so future false-positives
      // (worker replied via pane, watchdog kept escalating) are
      // debuggable from `system_watchdog_self` without re-reading
      // jsonl decision logs.
      last_nudge_at_ms: v.last_nudge_at_ms ?? null,
      last_reply_at_ms: v.last_reply_at_ms ?? null,
      reply_classification: v.classification?.kind ?? null,
      completion_flag: v.classification?.kind === "completed_idle",
    })),
    last_tick_at_ms: watchdogLastTickMs,
    last_fire_at_ms: watchdogLastFireMs,
    last_fire_reason: watchdogLastFireReason,
    interval_minutes: watchdogIntervalMin,
    staleness_threshold_minutes: stalenessThresholdMin,
  }));

  // v2.8.15 — Cognee promotion observability. system_cognee_promotion_self
  // reads from this getter on demand. "Armed" reflects RUNTIME ticker
  // state (`isCogneePromotionArmed()`) — flipped true only after
  // `startCogneePromotionTicker(...)` resolves, flipped false on
  // shutdown or arm failure. CodeRabbit MAJOR fix: the previous version
  // returned a static gate evaluation that stayed `true` even when the
  // ticker never armed (Cognee unreachable at boot, arm threw, etc).
  bindCogneePromotionState(() => {
    const snap = getCogneePromotionState();
    return {
      last_run_at_ms: snap.last_run_at_ms,
      last_watermark_ts: snap.last_promoted_ts,
      last_watermark_id: snap.last_promoted_id,
      total_promoted: snap.total_promoted,
      recent_errors: snap.errors,
      interval_minutes: Math.round(resolveCogneePromotionIntervalMs() / 60_000),
      armed: isCogneePromotionArmed(),
    };
  });

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
      // v2.8.14 — stamp last_nudge_at_ms on the team's activity record so
      // the pane-hash bump path can recognise the next pane change as a
      // reply to this nudge (last_reply_at_ms) and so operators can read
      // the nudge/reply pairing out of system_watchdog_self.
      const existing = teamLastActivity.get(team);
      if (existing) {
        teamLastActivity.set(team, {
          ...existing,
          last_nudge_at_ms: Date.now(),
        });
      }
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
        // WEB-216: propagate the classifier output so decideTeamAction
        // can short-circuit escalation on completed_idle/awaiting_input.
        classification: v.classification,
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
    expected_interval_s: Math.floor(watchdogIntervalMs / 1000),
    kill: () => clearInterval(watchdog),
  });
  console.error(
    `[evy] watchdog armed — interval=${watchdogIntervalMin}m, staleness_threshold=${stalenessThresholdMin}m`,
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
      console.error(`[evy] followup tick error: ${(err as Error).message}`);
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
  console.error(`[evy] scheduled-followup ticker armed — every 60s`);

  // ── v3.1.0 Kernel Fitness Phase 1: engagement timeout sweeper ──────────
  // Every hour, walk the engagement ledger and write `ignored` outcomes
  // for any `surface_emitted` entries older than 24h with no follow-on
  // engagement. Pure data-plane: never reads outside the tracker
  // module, never touches the agent state, never feeds the supervisor
  // prompt. Disabling the watchdog has zero behavioral impact on Evy.
  const ENGAGEMENT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
  const engagementSweeper = setInterval(() => {
    touchWatchdog("engagement-sweeper");
    void runEngagementTimeoutSweeper().then((r) => {
      if (r.swept > 0) {
        console.error(
          `[engagement] sweeper flipped ${r.swept} surface(s) to ignored (inspected=${r.inspected})`,
        );
      }
    }).catch((err) => {
      console.error(`[engagement] sweeper failed: ${(err as Error).message}`);
    });
  }, ENGAGEMENT_SWEEP_INTERVAL_MS);
  registerWatchdog({
    id: "engagement-sweeper",
    kind: "engagement-sweeper",
    expected_interval_s: Math.floor(ENGAGEMENT_SWEEP_INTERVAL_MS / 1000),
    kill: () => clearInterval(engagementSweeper),
  });
  console.error(`[evy] engagement sweeper armed — every 1h, 24h floor`);

  // ── v3.3.0 Kernel Fitness Phase 2: hourly fitness writer ────────────────
  // Every hour, roll up the prior window's engagement-ledger +
  // decisions.jsonl + consciousness-loop audit into one
  // fitness-ledger.jsonl entry. Pure data-plane: never reads outside
  // those three sources, never touches the supervisor prompt, never
  // calls an LLM. Disabling the watchdog has zero behavioral impact
  // on Evy — the writer is a passive measurement layer.
  const FITNESS_WRITE_INTERVAL_MS = 60 * 60 * 1000; // hourly
  const fitnessTimer = setInterval(() => {
    touchWatchdog("fitness-writer");
    void runFitnessWindow().then((entry) => {
      if (entry) {
        console.error(
          `[fitness] wrote window ${entry.window_start} ` +
            `(stall=${entry.stall_composite ?? "null"}, ` +
            `engagement=${entry.engagement_rate ?? "null"}, ` +
            `reflections=${entry.reflection_count}, ticks=${entry.tick_count})`,
        );
      }
    }).catch((err) => {
      console.error(`[fitness] writer tick failed: ${(err as Error).message}`);
    });
  }, FITNESS_WRITE_INTERVAL_MS);
  registerWatchdog({
    id: "fitness-writer",
    kind: "fitness-writer",
    expected_interval_s: Math.floor(FITNESS_WRITE_INTERVAL_MS / 1000),
    kill: () => clearInterval(fitnessTimer),
  });
  console.error(`[evy] fitness writer armed — every 1h, hourly windows`);

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
        `[evy] safety-net compact (ticker): ${decision.reason} — compacting toward ${cfg.target_tokens.toLocaleString()} tok`,
      );
      const result = compactTranscriptInline({
        target_tokens: cfg.target_tokens,
        keep_recent: cfg.keep_recent,
        initiator: "ticker",
      });
      if (result.ok && !result.noop) {
        console.error(`[evy] safety-net compact ok — archived ${result.archived_count}, kept ${result.kept_msgs}`);
      } else if (result.noop) {
        console.error(`[evy] safety-net compact noop — ${result.message}`);
      } else {
        console.error(`[evy] safety-net compact failed: ${result.error ?? "unknown"}`);
        emitNotification({
          kind: "auto-compact-error",
          severity: "warn",
          title: "auto-compact: compaction returned an error",
          body: `compactTranscriptInline failed: ${result.error ?? "unknown"}`,
        });
      }
    } catch (err) {
      console.error(`[evy] safety-net compact error: ${(err as Error).message}`);
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
  console.error("[evy] auto-compact safety-net ticker armed — every 5min (PRIMARY gate is just-in-time, see runJitCompactCheck())");

  // ── verifier denial-cluster ticker (PR 6.5, HANDOFF_DIGEST D8) ─────────
  // Scans each team's recent audit entries every 30s. If a Gated worker is
  // hitting policy denials in clusters (>5 in 60s OR >3 of the same
  // rule_path in 5min), fire a synthetic [verifier] correction prompt at
  // the worker. See components/evy/tools/policy/verifier-cluster.ts.
  const clusterTicker = startClusterTicker({
    onTick: () => touchWatchdog("verifier-cluster"),
  });
  registerWatchdog({
    id: "verifier-cluster",
    kind: "verifier-cluster",
    kill: () => clusterTicker.stop(),
  });
  console.error("[evy] verifier denial-cluster ticker armed — interval=30s, burst=>5/60s, stuck=>3/5min");

  // ── upstream-check watchdog (v2.7.25 Scope C) ───────────────────────────
  // ADR 0015 declared pi-ai + pi-agent-core first-class upstreams under
  // an "always-latest" policy. This watchdog polls npm every 6h, emits
  // notifications when a newer version is available, and (when the
  // ~/.config/subctl/auto-update-upstreams.enabled flag is set)
  // attempts the upgrade itself with a bun install + bun test gate.
  // See components/evy/upstream-check.ts.
  upstreamWatchdog = startUpstreamWatchdog({
    packageJsonPath: join(COMPONENT_DIR, "package.json"),
  });
  console.error("[evy] upstream-check watchdog armed — interval=6h, packages=pi-ai + pi-agent-core");

  // ── Evy cognition loop (Memory Init #7, v0.1) ──────────────────────────
  // Disabled-by-default bounded cognition loop. Config gate lives at
  // ~/.config/subctl/evy/consciousness-loop.json — if the file is
  // missing or { enabled: false }, start() registers NO watchdog and
  // arms NO interval. When enabled it ticks on its own interval,
  // gathers compact signals, runs a rule-based planner, and routes
  // safe actions through the existing notification + scheduler
  // surfaces. NO LLM, NO push/merge/deploy, NO recursive spawn.
  const cognitionLoop: CognitionLoopStartResult = startCognitionLoop({
    registry: {
      register: (entry) => registerWatchdog({
        id: entry.id,
        kind: entry.kind,
        kill: entry.kill,
      }),
      touch: (id) => touchWatchdog(id),
    },
    signals: {
      watchdogs: () => listWatchdogs().map((w) => ({
        id: w.id,
        kind: w.kind,
        age_seconds: w.age_seconds,
        last_tick_at: w.last_tick_at,
        expected_interval_s: w.expected_interval_s,
      })),
      notifications: () => {
        const ring = listNotifications({ limit: 200 });
        const by_severity: Record<string, number> = {};
        let unread = 0;
        for (const n of ring) {
          by_severity[n.severity] = (by_severity[n.severity] ?? 0) + 1;
          if (!n.read_at) unread++;
        }
        return { total: ring.length, unread, by_severity };
      },
      followups: () => {
        let pending: ReturnType<typeof listPendingFollowups> = [];
        try { pending = listPendingFollowups(); } catch { pending = []; }
        let next_due_at: string | null = null;
        for (const f of pending) {
          if (!next_due_at || Date.parse(f.fire_at) < Date.parse(next_due_at)) {
            next_due_at = f.fire_at;
          }
        }
        return { pending: pending.length, next_due_at };
      },
    },
    executor: {
      notify: (n) => emitNotification({
        kind: "cognition-loop",
        severity: n.severity,
        title: n.title,
        body: n.body,
        metadata: n.suppression_key ? { suppression_key: n.suppression_key } : undefined,
      }),
      scheduleFollowup: (f) => {
        // Route through the existing scheduler tool so cognition-loop
        // followups land in the same followups.jsonl as everything else.
        void schedulerTools.schedule_followup.invoke({
          summary: f.summary,
          prompt: f.prompt,
          fire_at_iso: f.fire_at,
        });
      },
      // v0.1 deliberately omits rememberCandidate / askOperator /
      // recordRecommendation providers — the planner is allowed to
      // emit those decision kinds but the executor will refuse with
      // "no <name> provider", and the audit records the refusal.
      // Wiring them is a Memory Init #7.1 step once the bounded
      // surface has proven itself.
    },
  });
  if (cognitionLoop.armed) {
    console.error(
      `[evy] cognition-loop armed — interval=${cognitionLoop.config.tick_interval_ms}ms, id=${COGNITION_LOOP_WATCHDOG_ID}`,
    );
  } else {
    console.error("[evy] cognition-loop disabled by config (enable via ~/.config/subctl/evy/consciousness-loop.json)");
  }

  // ── idle-pane watchdog (2026-05-19 transport reliability fix) ──────────
  // Detects worker tmux panes where a directive sits typed at the
  // prompt but unsubmitted. Notify-only by default. Auto-retry path
  // (sending Enter) is gated behind both (a) config.auto_retry_enabled
  // AND (b) buffered text exactly matching a recently-sent directive.
  // Disabled-by-default config gate at
  // ~/.config/subctl/evy/idle-pane-watchdog.json.
  const idlePaneWatchdog: IdlePaneStartResult = startIdlePaneWatchdog({
    registry: {
      register: (entry) => registerWatchdog({ id: entry.id, kind: entry.kind, kill: entry.kill }),
      touch: (id) => touchWatchdog(id),
    },
    providers: defaultIdlePaneProviders((n) => emitNotification({
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      metadata: n.metadata,
    })),
  });
  if (idlePaneWatchdog.armed) {
    console.error(
      `[evy] idle-pane watchdog armed — interval=${idlePaneWatchdog.config.interval_ms}ms, threshold=${idlePaneWatchdog.config.idle_threshold_ticks} ticks, auto_retry=${idlePaneWatchdog.config.auto_retry_enabled}, id=${IDLE_PANE_WATCHDOG_ID}`,
    );
  } else {
    console.error("[evy] idle-pane watchdog disabled by config (enable via ~/.config/subctl/evy/idle-pane-watchdog.json)");
  }

  // ── MCP server (MCP-Expose #1 mount, follow-up to f3a8e7a) ─────────────
  // Mount the in-process MCP server under /mcp/* plus the unauthenticated
  // /.well-known/mcp discovery endpoint. Boots disabled if
  // secrets.json#subctl_mcp_token is missing — no auto-generation, the
  // operator manages this credential. See components/evy/mcp/README.md
  // for the design summary and wave-2 tool-surface plan.
  // (The mcpHandle binding itself is forward-declared above Bun.serve so
  //  the fetch handler can route /mcp/* without TDZ trouble.)
  mcpHandle = await startMcpServer({
    expectedToken: loadSecret("subctl_mcp_token"),
    serverInfo: { name: "subctl-master", version: SUBCTL_VERSION },
    log: (line) => console.error(`[mcp] ${line}`),
    // Wave-2 (#25) tool surface: ping / state_snapshot / notify.
    // Tools must register before mcp.connect(transport) — see the
    // registerCapabilities contract in components/evy/mcp/server.ts.
    registerCapabilities: (mcp) => {
      registerMcpTools(mcp, {
        serverVersion: SUBCTL_VERSION,
        getStateSnapshot: () => ({
          version: SUBCTL_VERSION,
          uptime_s: Math.floor(process.uptime()),
          transcript_msgs: agent.state.messages.length,
          teams_tracked: teamLastActivity.size,
          active_profile: activeProfile,
          watchdogs: listWatchdogs().map((w) => ({
            id: w.id,
            kind: w.kind,
            last_tick_at: w.last_tick_at,
            expected_interval_s: w.expected_interval_s,
          })),
          notifications: (() => {
            const ring = listNotifications({ limit: 200 });
            let unread = 0;
            for (const n of ring) if (!n.read_at) unread++;
            return { total: ring.length, unread };
          })(),
        }),
        emitNotification: (n, provenance) => {
          emitNotification({
            kind: n.kind,
            severity: n.severity,
            title: n.title,
            body: n.body,
            metadata: { mcp_provenance: provenance },
          });
        },

        // v2.8.11 — wave-3 tools. Each provider is a thin shim over an
        // already-existing master function. The MCP layer cares about
        // schema + auth; the actual behavior lives in master internals.

        enqueuePrompt: (text, _source) => {
          // v2.8.12 — Route through dispatchToAgent so the drain loop
          // actually fires. The prior wave-3 wiring just pushed to
          // promptQueue + broadcast; nothing triggered the agent turn,
          // so prompts queued but Evy never processed them.
          //
          // Source is typed "mcp" at the queue level (provenance lives
          // in the prompt text itself / agent transcript / decisions
          // log). Fire-and-forget — MCP send_message returns the queue
          // depth synchronously; the caller polls recent_messages for
          // Evy's reply rather than blocking here for what could be a
          // minutes-long agent turn.
          void dispatchToAgent(text, "mcp");
          return { queue_depth: promptQueue.length };
        },

        getRecentMessages: (limit) => {
          const msgs = agent.state.messages.slice(-limit);
          return msgs.map((m) => {
            // agent messages are openai-shape; trim to opaque shape
            const role = (m as { role?: string }).role ?? "unknown";
            let content = "";
            const c = (m as { content?: unknown }).content;
            if (typeof c === "string") content = c;
            else if (Array.isArray(c)) {
              content = c
                .map((part) => {
                  if (typeof part === "string") return part;
                  if (part && typeof part === "object" && "text" in part) {
                    return String((part as { text: unknown }).text);
                  }
                  return JSON.stringify(part);
                })
                .join("");
            } else if (c != null) {
              content = JSON.stringify(c);
            }
            return { role, content };
          });
        },

        getRecentDecisions: (limit) => {
          try {
            const path = join(EVY_STATE_DIR, "decisions.jsonl");
            const raw = require("node:fs").readFileSync(path, "utf8") as string;
            const lines = raw.trimEnd().split("\n").filter((l: string) => l.trim());
            const tail = lines.slice(-limit);
            const out: Array<{ ts: string; project?: string; action: string; rationale: string }> = [];
            for (const line of tail) {
              try {
                const obj = JSON.parse(line) as {
                  ts?: string;
                  project?: string;
                  action?: string;
                  rationale?: string;
                };
                if (obj && obj.ts && obj.action) {
                  out.push({
                    ts: obj.ts,
                    project: obj.project,
                    action: obj.action,
                    rationale: obj.rationale ?? "",
                  });
                }
              } catch {
                /* skip malformed lines */
              }
            }
            return out;
          } catch {
            return [];
          }
        },

        listNotifications: ({ unread_only, limit }) => {
          const lim = Math.max(1, Math.min(200, limit ?? 50));
          const all = listNotifications({ limit: lim });
          const filtered = unread_only ? all.filter((n) => !n.read_at) : all;
          return filtered.map((n) => ({
            id: n.id,
            ts: n.ts,
            kind: n.kind,
            severity: n.severity,
            title: n.title,
            body: n.body,
            read: Boolean(n.read_at),
          }));
        },

        getWatchdogState: () => ({
          last_tick_at_ms: watchdogLastTickMs,
          last_fire_at_ms: watchdogLastFireMs,
          last_fire_reason: watchdogLastFireReason,
          interval_minutes: watchdogIntervalMin,
          staleness_threshold_minutes: stalenessThresholdMin,
          watching: [...teamLastActivity.entries()].map(([team_id, v]) => ({
            team_id,
            tmux_session_id: team_id,
            last_seen_ms: v.ts,
            // v2.8.14 — same observability surface as bindWatchdogState
            // for kernel-surface readers that don't go through the diag
            // tool path.
            last_nudge_at_ms: v.last_nudge_at_ms ?? null,
            last_reply_at_ms: v.last_reply_at_ms ?? null,
            reply_classification: v.classification?.kind ?? null,
            completion_flag: v.classification?.kind === "completed_idle",
          })),
        }),

        listTeams: () => {
          // Use dashboard's /api/orchestration endpoint via fetch — it
          // already enriches with attached/windows/last-activity. Sync
          // call is forbidden here, so we shell to tmux for the cheap
          // sync path. Returns a minimal slice; richer queries should
          // hit dashboard directly via team_inbox or HTTP.
          try {
            const out = require("node:child_process")
              .execSync("tmux list-sessions -F '#{session_name}'", {
                encoding: "utf8",
                timeout: 1500,
                stdio: ["ignore", "pipe", "ignore"],
              }) as string;
            const names = out
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            return names.map((name) => ({ name }));
          } catch {
            return [];
          }
        },

        getTeamInbox: (team, limit) => {
          try {
            const safeTeam = team.replace(/[^A-Za-z0-9._-]/g, "_");
            const path = join(EVY_STATE_DIR, "inbox", `${safeTeam}.jsonl`);
            const raw = require("node:fs").readFileSync(path, "utf8") as string;
            const lines = raw.trimEnd().split("\n").filter((l: string) => l.trim());
            const tail = lines.slice(-limit);
            const out: Array<{ ts: string; [k: string]: unknown }> = [];
            for (const line of tail) {
              try {
                const obj = JSON.parse(line) as { ts?: string } & Record<string, unknown>;
                if (obj && obj.ts) {
                  out.push(obj as { ts: string } & Record<string, unknown>);
                }
              } catch {
                /* skip */
              }
            }
            return out;
          } catch {
            return [];
          }
        },

        sendTeamMsg: async (team, text, phase) => {
          try {
            const r = await fetch(
              `${SUBCTL_API}/api/orchestration/${encodeURIComponent(team)}/msg`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, phase: phase ?? "mcp" }),
                signal: AbortSignal.timeout(10_000),
              },
            );
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            const j = (await r.json()) as { ok?: boolean; error?: string };
            if (j.ok === false) return { ok: false, error: j.error ?? "unknown" };
            return { ok: true };
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
        },

        killTeam: async (team) => {
          try {
            const r = await fetch(
              `${SUBCTL_API}/api/orchestration/${encodeURIComponent(team)}/kill`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(10_000),
              },
            );
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            const j = (await r.json()) as { ok?: boolean; error?: string };
            if (j.ok === false) return { ok: false, error: j.error ?? "unknown" };
            return { ok: true };
          } catch (err) {
            return { ok: false, error: (err as Error).message };
          }
        },

        memorySearch: async (query, limit) => {
          const out: Array<{ source: string; score?: number; text: string; ts?: string; meta?: Record<string, unknown> }> = [];
          // Try cognee first — semantic graph recall. Result is wrapped
          // as `{ ok: true, data: { hits: [...] } }` per the Result<T> shape.
          try {
            const res = await cogneeRecall({ query, top_k: limit });
            if (res.ok) {
              for (const h of res.data.hits.slice(0, limit)) {
                out.push({
                  source: "cognee",
                  score: h.score,
                  text: h.text,
                  meta: h.metadata,
                });
              }
            }
          } catch {
            /* cognee unavailable — fall through */
          }
          // Then memori — Tier 3 SQLite recall. memori requires
          // entity_id; operator's id is "jason" per policy.
          try {
            const res = await memoriRecall({
              entity_id: "jason",
              query,
              top_k: limit,
            });
            if (res.ok) {
              for (const h of res.data.hits.slice(0, limit)) {
                out.push({
                  source: "memori",
                  score: h.score,
                  text: h.text,
                  ts: h.ts,
                });
              }
            }
          } catch {
            /* memori unavailable — fall through */
          }
          return out.slice(0, limit);
        },

        memoryTimeline: async (limit) => {
          // Memori is the canonical Tier-3 timeline. Empty query
          // returns recent-first results per the memori-client contract.
          try {
            const res = await memoriRecall({
              entity_id: "jason",
              query: "",
              top_k: limit,
            });
            if (res.ok) {
              return res.data.hits.slice(0, limit).map((h) => ({
                ts: h.ts ?? new Date().toISOString(),
                text: h.text,
                source: "memori",
              }));
            }
          } catch {
            /* memori unavailable */
          }
          return [];
        },
      });
    },
  });
  if (mcpHandle) {
    console.error(`[evy] mcp server armed — base=/mcp, discovery=/.well-known/mcp, version=${SUBCTL_VERSION}, tools=ping+state_snapshot+notify+send_message+recent_messages+recent_decisions+list_notifications+watchdog_state+list_teams+team_inbox+team_msg+team_kill+memory_search+memory_timeline`);
  }

  // ── graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.error(`[evy] caught ${signal}, shutting down`);
    clearInterval(watchdog);
    clearInterval(followupTicker);
    clearInterval(autoCompactInterval);
    clearInterval(inboxPoll);
    if (mcpHandle) void mcpHandle.stop();
    clusterTicker.stop();
    try { upstreamWatchdog?.stop(); } catch { /* ignore */ }
    try { cognitionLoop.kill(); } catch { /* ignore */ }
    try { idlePaneWatchdog.kill(); } catch { /* ignore */ }
    // v2.8.15 (CodeRabbit pass-2 MAJOR): cancel the Cognee promotion
    // ticker on graceful shutdown. stop() flips _armed=false +
    // clearInterval; idempotent if it's already been killed via the
    // watchdog registry.
    try { cogneePromotionStop?.(); } catch { /* ignore */ }
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
        `[evy] WARN transcript flush on shutdown failed: ${(err as Error).message}`,
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
// launchd / `subctl evy start`). Skipping this when imported lets the
// test suite pull in helpers like `getApiKeyForProvider` and
// `ensureModelLoaded` without spinning up the full daemon.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`[evy] fatal:`, err);
    process.exit(1);
  });
}
