// clawd — the master daemon entry point.
//
// Boots a persistent supervisor process that:
//   1. Loads providers.json (multi-model routing) + policy.json (per-project autonomy)
//   2. Initializes pi-agent-core with the master SKILL prompt + the four tool modules
//   3. Runs the review loop on `review_interval_minutes` cadence
//   4. Polls the master Telegram bot for incoming chat (handled in master-notify-listener.ts)
//
// Lives at: /Users/sem/code/subctl/components/master/
// Started by: launchd plist (com.subctl.master.plist) at boot
// Logs to:    /Users/sem/Library/Logs/subctl/master.log

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

import { appendFileSync } from "node:fs";

// ─── tool registry ──────────────────────────────────────────────────────────
// Aggregated for pi-agent-core. Final wiring happens once we have the agent
// core SDK example open — for now this is the catalog of what's available.

export const toolRegistry = {
  ...Object.fromEntries(
    Object.entries(subctlOrchTools).map(([k, v]) => [`subctl_orch_${k}`, v]),
  ),
  ...Object.fromEntries(
    Object.entries(ghTools).map(([k, v]) => [`gh_${k}`, v]),
  ),
  ...Object.fromEntries(
    Object.entries(coderabbitTools).map(([k, v]) => [`coderabbit_${k}`, v]),
  ),
  ...Object.fromEntries(
    Object.entries(telegramTools).map(([k, v]) => [`telegram_${k}`, v]),
  ),
};

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[master] booting clawd v0.1.0`);

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

  // TODO(stage 1): wire pi-agent-core here.
  //
  //   import { createAgent } from "@earendil-works/pi-agent-core";
  //   const agent = createAgent({
  //     model: providers.models.supervisor,
  //     systemPrompt: skill,
  //     tools: toolRegistry,
  //     state: { path: STATE_PATH },
  //   });
  //   const reviewLoop = setInterval(
  //     () => agent.run("Walk the portfolio, decide next move, send digest if status changed."),
  //     policy.global_defaults.review_interval_minutes * 60 * 1000,
  //   );
  //
  // Until pi-agent-core is `npm install`'d into this component, the boot path
  // above just verifies config + logs heartbeat. Once we install the SDK and
  // confirm its API surface, we wire the real agent here.

  console.error(`[master] config OK. SDK wiring pending — see TODO in server.ts.`);
  console.error(`[master] tools registered: ${Object.keys(toolRegistry).length}`);

  logDecision({
    project: "_master",
    action: "boot",
    rationale: `daemon started — ${Object.keys(toolRegistry).length} tools, ${policy.projects.length} projects in portfolio`,
  });

  // Heartbeat — replaces the agent loop until SDK is wired
  const beat = setInterval(() => {
    console.error(`[master] heartbeat ${new Date().toISOString()}`);
  }, 60_000);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.error(`[master] caught ${signal}, shutting down`);
    clearInterval(beat);
    logDecision({
      project: "_master",
      action: "shutdown",
      rationale: `signal=${signal}`,
    });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[master] fatal:`, err);
  process.exit(1);
});
