// subctl dashboard server
//
// Single-file Bun HTTP + WebSocket server. Reads filesystem-only data sources
// plus tmux state via subprocess (no API calls, no auth). Emits a JSON
// snapshot to the frontend over WebSocket every 2s.
//
// State JSON schema (also returned by GET /api/state):
// {
//   "version": "0.4.1",                    // read from lib/core.sh at startup
//   "now": "2026-05-04T14:42:00Z",         // ISO8601 UTC
//   "warning": "accounts.conf not found",  // optional, top-level
//   "service": { "running": true, "port": 8787, "uptime_seconds": 15921 },
//   "accounts": [
//     {
//       "alias": "claude-personal",
//       "provider": "claude",
//       "email": "you@example.com",
//       "config_dir": "/Users/you/.claude-personal",
//       "auth_status": "ready" | "not_authenticated",
//       "active_sessions": 2,                // count of tmux sessions bound to this account
//       "rl_hits_today": 0,
//       "last_activity_seconds_ago": 12,     // null if never
//       "color_class": "cyan" | "blue" | "magenta" | "grey"
//     }
//   ],
//   "sessions": [
//     {
//       "name": "myproject",                 // tmux session name
//       "path": "/Users/you/code/myproject",
//       "project": "myproject",
//       "branch": "main",
//       "account": "claude-personal" | "(none)",
//       "account_email": "you@example.com" | null,
//       "color_class": "cyan" | "blue" | "magenta" | "grey",
//       "panes": 2,
//       "attached": true,
//       "command": "claude",
//       "preview": "...last 3 lines plain text...",
//       "ctx_pct": 11,
//       "ctx_color": "green" | "yellow" | "orange" | "red",
//       "rl_today": 0,
//       "age_seconds": 1620,
//       "age_color": "green" | "yellow" | "red",
//       "status": "working" | "idle" | "waiting" | "unknown"
//     }
//   ],
//   "rate_limits": {
//     "today_total": 0,
//     "by_account": [
//       { "account": "claude-personal", "color_class": "cyan",
//         "count_today": 0,
//         "buckets_24h": [0,0,0,...]            // 24 hourly buckets, oldest -> newest
//       }
//     ]
//   },
//   "dispatch": {
//     "verdict": "green" | "yellow" | "red",
//     "reasons": ["..."]
//   },
//   "totals": {
//     "tmux_sessions": 8,
//     "ready_accounts": 3,
//     "rl_today": 2
//   }
// }

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname as osHostname } from "node:os";
import { spawnSync } from "node:child_process";
import { aggregateAll as aggregateCostAll, type AccountCostSummary } from "./lib/cost.ts";
// PR 8.5 (v2.7.0): central exec helper. Coexists with the legacy `spawnSync`
// imports; migrations land incrementally. Tracked in docs/exec-migration.md.
import { execCommand } from "../components/evy/policy/exec.ts";
import { classifySpawnError } from "./lib/spawn-errors.ts";
// PR 11 (v2.7.0): policy-audit dashboard surface. Pure request handlers live
// in dashboard/lib/audit-api.ts so they're testable without booting the
// server. The SSE stream is built inline below — it owns its ReadableStream.
import {
  getAuditPath,
  handleAuditAggregate,
  handleAuditList,
  handlePolicyTeams,
  isValidTeamId,
  readNewAuditEntries,
} from "./lib/audit-api.ts";
import { loadResolvedPolicy } from "../components/evy/tools/policy/load.ts";
import {
  resolveSecret,
  loadSecret,
  setSecret,
  listSecrets,
  SECRET_KEYS,
  envVarFor,
} from "../components/evy/secrets.ts";
// v2.7.20 (ADR 0011 Layer 1): HMAC-authenticated trust marker. The
// per-team secret lives at ~/.local/state/subctl/teams/<team_id>/hmac.secret
// (chmod 600), generated at spawn time by providers/claude/teams.sh and
// also injected into the worker's spawn-time system prompt. The
// /api/orchestration/:name/msg route below reads the secret, computes
// HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body), and bakes the
// first 16 hex chars into the marker as `hmac:<16hex>`. Missing secret
// fails LOUD (refuses to send) — falling back to an unauthenticated
// marker would teach workers to ignore the auth field.
import { buildSignedDirective } from "../components/evy/trust-marker.ts";
// v2.7.24: pi-ai provider catalog — replaces the hand-curated dropdown
// at /api/providers with the full pi-ai enumeration so new providers
// (groq, cerebras, openrouter, bedrock, xai, ...) light up automatically.
// `@earendil-works/pi-agent-core` remains the agent runtime — pi-ai is
// strictly the catalog layer (see ADR 0015).
import {
  listCatalogProviders,
  resolveProviderId,
  isCatalogProvider,
  legacyAliasFor,
  SUBCTL_TO_PI_AI,
  getDefaultModel,
  getDefaultModelWithSource,
  setProviderDefault,
  clearProviderDefault,
  isObviouslyInvalidModel,
  type CatalogProvider,
} from "../components/evy/pi-ai-catalog.ts";
import {
  getCatalog,
  listCachedCatalogs,
  isKnownProvider,
  refreshCatalog,
  saveCatalog,
  setModelEnabled,
  setAllModelsEnabled,
} from "./lib/catalogs.ts";
import {
  completeCodexLogin,
  type DeviceCodePrompt,
} from "../components/evy/codex-oauth.ts";
import { loadAccountsConf } from "../components/evy/openai-codex-auth.ts";
// v2.8.7 — supervisor dropdown sync. POST /api/master/supervisor edits
// providers.json AND profiles.json so the operator's dropdown pick survives
// the next master restart (master overrides supervisor.model + host from
// profiles.json[active] at boot — see components/evy/server.ts:931).
import {
  loadProfiles,
  setProfileEntry,
} from "../components/evy/profiles.ts";
// v2.7.21 (ADR 0011 Layer 2): web terminal escape hatch. Routes are gated
// by a flag file at ~/.config/subctl/terminal.enabled; absent = OFF (the
// default). When enabled, the dashboard upgrades a WebSocket to a node
// sidecar running `tmux attach -t <session>` so the operator can break
// out of any worker paranoia loop directly from the browser. See
// docs/adr/0011-trust-marker-hmac-replacement.md.
import {
  terminalEnabled,
  handleEnabled as handleTerminalEnabled,
  handleTeams as handleTerminalTeams,
  evaluateUpgrade as evaluateTerminalUpgrade,
  spawnPtyBridge,
  type PtyBridge,
} from "./terminal.ts";
// ── v2.8.1 skills clarity ──
// Categorized skills listing + Evy-authored draft curation (promote/delete).
// The legacy /api/skills route stays for the imported-catalog flow; these new
// routes drive the categorized Skills tab view operator asked for.
import {
  listSkills as listAllSkills,
  promoteEvySkill,
  deleteEvySkill,
  templatesUsingSkill,
  type Skill,
  type SkillCategory,
} from "../components/evy/skills-registry.ts";
// ── end v2.8.1 skills clarity ──
// ── v3.1.0 Kernel Fitness Phase 1: engagement instrumentation (write-only). ──
// Imported here so the dashboard can record `acted` / `acked` outcomes
// from the chat panel's reply submission and dismiss button. No reader
// API is imported — the dashboard is structurally a writer of this
// ledger, never a reader.
import {
  recordEngagement as recordEvyEngagement,
} from "../components/evy/engagement-tracker.ts";
import type {
  Outcome as EvyOutcome,
  Source as EvySource,
} from "../components/evy/engagement-types.ts";
// ── v3.3.1 Kernel Fitness Phase 3: dashboard read-only ledger access. ──
// Read-only handlers used by the new Fitness tab. The dashboard reads
// fitness-ledger.jsonl + engagement-ledger.jsonl via node:fs through
// these pure helpers — it never imports from components/evy/fitness-
// writer.ts (whose isolation test forbids a reader API). The Fitness
// tab is a separate-process observability surface; Evy's supervisor
// prompt assembly path remains structurally unable to see either ledger.
import {
  computeHealth as computeFitnessHealth,
  defaultEngagementLedgerPath,
  defaultFitnessLedgerPath,
  parseWindow as parseFitnessWindow,
  readEngagementLedger,
  readFitnessLedger,
} from "./lib/fitness-api.ts";

const PORT = Number(process.env.PORT ?? 8787);
const STARTED_AT = Date.now();

const HOME = homedir();
const ACCOUNTS_CONF = process.env.SUBCTL_ACCOUNTS_CONF
  ?? join(HOME, ".config", "subctl", "accounts.conf");
const RL_LOG = process.env.SUBCTL_RL_LOG
  ?? join(HOME, ".claude", "rate-limit-events.log");

// Repo root (where lib/core.sh lives) — used to read the live version on startup.
// dashboard/server.ts → ../lib/core.sh
const REPO_ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(import.meta.dir, "public");

// ---------- version (read on every request — one canonical source) ----------
// VERSION is read from disk on every render/request so a `git pull` always
// reflects on the running dashboard without a restart. The VERSION file at
// repo root is the single source of truth — same file master and lib/core.sh
// read.

function readSubctlVersion(): string {
  try {
    const v = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim();
    if (v) return v;
  } catch { /* fall through to legacy probe */ }
  try {
    const raw = readFileSync(join(REPO_ROOT, "lib", "core.sh"), "utf8");
    const m = raw.match(/^\s*SUBCTL_VERSION\s*=\s*"([^"]+)"/m);
    if (m && m[1]) return m[1];
  } catch { /* fall through */ }
  return "(unknown)";
}

// ---------- thresholds for session-row coloring ----------
//
// These drive the visual color tags in the sessions table only. The dispatch
// verdict is computed elsewhere from per-account usage (see
// computeAccountVerdict) and intentionally does NOT consider session-level
// signals — a fresh session in another folder has 0% ctx and is a moment old,
// regardless of what's happening in any other tmux pane.

const THRESH_AGE_RED    = 21600; // 6h — session row turns red
const THRESH_AGE_YELLOW = 7200;  // 2h — session row turns yellow
const THRESH_CTX_RED    = 80;
const THRESH_CTX_ORANGE = 60;
const THRESH_CTX_YELLOW = 30;

function classifyAge(s: number): "green" | "yellow" | "red" {
  if (s >= THRESH_AGE_RED)    return "red";
  if (s >= THRESH_AGE_YELLOW) return "yellow";
  return "green";
}
function classifyCtx(p: number): "green" | "yellow" | "orange" | "red" {
  if (p >= THRESH_CTX_RED)    return "red";
  if (p >= THRESH_CTX_ORANGE) return "orange";
  if (p >= THRESH_CTX_YELLOW) return "yellow";
  return "green";
}

// ---------- helpers ----------

// v2.7.4 — LM Studio's optional "Require API Token" server setting. The
// dashboard queries LM Studio for the model picker (/api/models,
// /api/providers); when the operator has enabled the toggle, those
// queries must carry `Authorization: Bearer <token>` or LM Studio 401s.
// Token resolved via the v2.7.4 priority chain (env > secrets.json >
// absent — see components/evy/secrets.ts). Returns {} when neither
// is configured so callers can spread it unconditionally — back-compat
// with LM Studio servers that don't have the toggle on (the default).
function lmstudioAuthHeader(): Record<string, string> {
  const token = resolveSecret("lmstudio_api_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// v2.8.2 — Best-effort lifecycle notify to the master daemon when a
// dev-team tmux session is killed via the dashboard. The master keeps
// its own `teamLastActivity` + `teamNudgeState` maps for the staleness
// watchdog; without this hook those maps would only get pruned by the
// next watchdog tick's tmux-prune block, leaving a ~3min window where
// an escalation could fire on the corpse (bug 2026-05-18).
//
// Failure modes are non-fatal: master down, route 404 (older master
// version), network blip — we log and continue. The watchdog tick has
// its own per-team `tmux has-session` safety net that will catch the
// same case on the next interval.
async function notifyMasterTeamPruned(name: string): Promise<void> {
  const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
  const url = `http://127.0.0.1:${masterPort}/teams/${encodeURIComponent(name)}/prune`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!r.ok && r.status !== 404) {
      console.log(`[dashboard] master prune notify ${name}: HTTP ${r.status}`);
    }
  } catch (err) {
    console.log(`[dashboard] master prune notify ${name} failed: ${(err as Error).message}`);
  }
}

// v2.8.7 — LM Studio /api/v0/models response cache.
//
// Background: the dashboard polls LM Studio's catalog from TWO surfaces
// (Models tab every 5s + chat-model-selector every 10s) and several
// route handlers (/api/models, /api/providers) hit the same endpoint
// per request. Multiple browser clients multiply that. Without a
// server-side cache the operator sees a constant `GET /api/v0/models`
// drumbeat in LM Studio's log even when the model catalog hasn't
// changed in hours.
//
// Design:
//   * 30s TTL — fresh enough that a freshly-loaded model appears
//     quickly, slow enough to coalesce hundreds of polls.
//   * In-flight coalescing — if a fetch is already in progress, all
//     concurrent callers await the SAME promise rather than each
//     opening their own connection to LM Studio.
//   * Cache successes only. 401/4xx/network-fail responses are NOT
//     cached, so the operator's token rotation or LM Studio restart
//     takes effect on the next request, not 30s later.
//   * Cache key is the host string — survives operator switching
//     SUBCTL_LMSTUDIO_HOST without restart.
//
// Manual bust: `POST /api/models/refresh` (see route handler below) or
// `getLmstudioModels(host, true)` from server code.
type LmstudioModelsResponse = {
  data?: Array<Record<string, unknown>>;
};
interface LmstudioFetchError extends Error {
  status?: number;
  host: string;
}
let _lmstudioModelsCache:
  | { host: string; data: LmstudioModelsResponse; ts: number }
  | null = null;
let _lmstudioModelsInFlight: Promise<LmstudioModelsResponse> | null = null;
const LMSTUDIO_CACHE_TTL_MS = 30_000;

// ─── v2.8.9 — in-process state for /api/auth/openai-codex SSE flows ──────────
//
// One session per alias. Kicked by POST /start. Subscribers (EventSource
// readers) receive replayed events on connect + live events thereafter.
// Cleared 30s after terminal state (success/failed/cancelled).
interface CodexAuthSession {
  alias: string;
  configDir: string;
  email: string;
  abortController: AbortController;
  subscribers: Set<{ write: (chunk: string) => void; close: () => void }>;
  events: Array<Record<string, unknown>>;
  state: "starting" | "awaiting_authorization" | "success" | "failed" | "cancelled";
}
const codexAuthSessions: Map<string, CodexAuthSession> = new Map();
function publishCodexAuthEvent(
  session: CodexAuthSession,
  event: Record<string, unknown>,
): void {
  // Buffer for late-joiners (typed event name comes from event.type).
  session.events.push(event);
  const type = String(event.type ?? "message");
  const payload = JSON.stringify(event);
  const wire = `event: ${type}\ndata: ${payload}\n\n`;
  for (const s of session.subscribers) {
    try { s.write(wire); } catch { /* subscriber dropped */ }
  }
}

// ─── update-flow event bus (v2.8.8) ──────────────────────────────────────────
//
// Surfaces upstream releases + streams progress from /api/update/run to any
// EventSource subscriber listening on /api/update/events. Mirrors the codex
// auth pattern: module-level subscriber Set, publish helper, no per-session
// state because the operator only runs one update at a time. Buffer keeps the
// last N events so a freshly-opened modal replays the run-in-progress without
// missing the first few lines.
interface UpdateEventSubscriber {
  write: (chunk: string) => void;
  close: () => void;
}
const updateEventSubscribers: Set<UpdateEventSubscriber> = new Set();
const updateEventBuffer: Array<{ type: string; payload: Record<string, unknown> }> = [];
const UPDATE_EVENT_BUFFER_MAX = 200;

function publishUpdateEvent(type: string, payload: Record<string, unknown>): void {
  const event = { type, payload };
  updateEventBuffer.push(event);
  if (updateEventBuffer.length > UPDATE_EVENT_BUFFER_MAX) {
    updateEventBuffer.shift();
  }
  const wire = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const s of updateEventSubscribers) {
    try { s.write(wire); } catch { /* dropped */ }
  }
}

// /api/update/check cache. Stores the latest_tag and the timestamp; on
// network failure the prior tag is served (and `stale: true` is set) so a
// flaky remote doesn't flip `has_update` to false mid-session.
interface UpdateCheckCache {
  latest_tag: string;
  fetched_at: number;
  stale: boolean;
}
let _updateCheckCache: UpdateCheckCache | null = null;
const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;

function cmpSemver(a: string, b: string): number {
  // Strip leading 'v'. Compare triplets numerically. Non-numeric suffixes
  // (e.g. "-rc1") are stripped — operator is on stable channel today.
  const norm = (s: string) => s.replace(/^v/i, "").split(/[-+]/)[0]!;
  const parts = (s: string) => norm(s).split(".").map((p) => parseInt(p, 10) || 0);
  const ap = parts(a);
  const bp = parts(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

// In-flight guard so a second POST while an update is mid-run rejects with
// 409 rather than spawning two parallel CLI invocations.
let _updateRunInFlight: { mode: string; started_at: number } | null = null;

async function getLmstudioModels(
  host: string,
  force = false,
): Promise<LmstudioModelsResponse> {
  const now = Date.now();
  if (
    !force
    && _lmstudioModelsCache
    && _lmstudioModelsCache.host === host
    && now - _lmstudioModelsCache.ts < LMSTUDIO_CACHE_TTL_MS
  ) {
    return _lmstudioModelsCache.data;
  }
  // Coalesce: if another caller is already fetching, await the same
  // promise. The `finally` clears the in-flight slot before the
  // rejection propagates, so awaiters get the error rather than hang.
  if (_lmstudioModelsInFlight) {
    return await _lmstudioModelsInFlight;
  }
  _lmstudioModelsInFlight = (async () => {
    try {
      const r = await fetch(`${host}/api/v0/models`, {
        headers: { ...lmstudioAuthHeader() },
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) {
        const err = new Error(`LM Studio HTTP ${r.status}`) as LmstudioFetchError;
        err.status = r.status;
        err.host = host;
        throw err;
      }
      const data = (await r.json()) as LmstudioModelsResponse;
      _lmstudioModelsCache = { host, data, ts: Date.now() };
      return data;
    } finally {
      _lmstudioModelsInFlight = null;
    }
  })();
  return await _lmstudioModelsInFlight;
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function safeReaddir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return null; }
}

// Single-quote a string for safe shell injection.
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function todayDateStr(): string {
  // Local YYYY-MM-DD — matches what the rate-limit log writes.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ANSI escape stripper. tmux `capture-pane -p` (no -e) usually emits plain
// text already, but commands that print raw escapes can leak through.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Color class for an account alias — mirrors providers/claude/statusline.sh.
// Uses substring rules consistent with the existing statusline classification.
function colorClassFor(alias: string): "cyan" | "blue" | "magenta" | "grey" {
  // Convention from config/accounts.conf.example: aliases follow
  // claude-personal / claude-work / claude-overflow (any provider).
  // Unmatched aliases fall through to grey.
  const a = alias.toLowerCase();
  if (a.includes("personal")) return "cyan";
  if (a.includes("work"))     return "blue";
  if (a.includes("overflow")) return "magenta";
  return "grey";
}

// ---------- accounts.conf ----------

interface Account {
  alias: string;
  provider: string;
  email: string;
  config_dir: string;
  description: string;
}

function parseAccountsConf(): { accounts: Account[]; warning?: string } {
  const raw = safeRead(ACCOUNTS_CONF);
  if (raw === null) {
    return { accounts: [], warning: `accounts.conf not found at ${ACCOUNTS_CONF}` };
  }
  const accounts: Account[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|");
    if (parts.length < 4) continue;
    const [alias, provider, email, config_dir, description = ""] = parts;
    accounts.push({
      alias: alias!.trim(),
      provider: provider!.trim(),
      email: email!.trim(),
      // Expand a leading ~ to $HOME.
      config_dir: config_dir!.trim().replace(/^~(?=\/|$)/, HOME),
      description: description.trim(),
    });
  }
  return { accounts };
}

// ---------- tmux ----------
//
// We treat each tmux session as an "active session" — even if Claude isn't
// actively typing in it. This matches user mental model: "I have 8 sessions
// running" should equal "the dashboard shows 8 rows."
//
// Strategy notes (informed by advisor):
//   - One `tmux list-sessions` to enumerate.
//   - One `tmux list-panes -a` to get all panes in a single subprocess (avoids
//     N round-trips). We filter by session_name in JS.
//   - Per-session subprocess for `show-environment` (need -t SESS) and
//     `capture-pane -p -t SESS -S -3` (last 3 lines, plain text — strip ANSI).
//   - Strip ANSI server-side; render preview as <pre>. Full ANSI-to-HTML is a
//     tarpit and unnecessary for "show me what's on screen."
//
// Empty preview UI choice: an expander row underneath each session row. A
// popover is awkward across 8+ rows on one screen; always-visible blocks
// explode vertical space. The expander defaults collapsed, click to reveal.

interface TmuxSessionRaw {
  name: string;
  created: number;     // seconds since epoch
  path: string;
  windows: number;
  attached: boolean;
}

// Resolve the absolute path of a binary by checking common locations and
// falling back to a `which`-style search via PATH. This runs once at
// module load. Necessary because launchd-spawned processes get a minimal
// PATH that doesn't include /opt/homebrew/bin (Apple Silicon brew) or
// /usr/local/bin (Intel brew), where tmux/git typically live.
function resolveBinary(name: string): string {
  // Common absolute locations, ordered Apple-Silicon-first.
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/bin/${name}`,
  ];
  for (const p of candidates) {
    try {
      const r = spawnSync(p, ["--version"], { encoding: "utf8" });
      if (!r.error && (r.status === 0 || r.status === 1)) return p;
    } catch { /* try next */ }
  }
  // Fall back to PATH-based 'which'.
  const w = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (!w.error && w.status === 0 && w.stdout) return w.stdout.trim();
  // Last resort — let spawnSync search PATH at call time.
  return name;
}

const TMUX_BIN = resolveBinary("tmux");
const GIT_BIN = resolveBinary("git");
const SUBCTL_BIN = join(REPO_ROOT, "bin", "subctl");

// ---------- per-account usage (Anthropic /api/oauth/usage) ----------

interface UsageEntry {
  five_hour?:        { utilization: number; resets_at: string | null } | null;
  seven_day?:        { utilization: number; resets_at: string | null } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string | null } | null;
  seven_day_opus?:   { utilization: number; resets_at: string | null } | null;
  extra_usage?:      { is_enabled: boolean; monthly_limit?: number; used_credits?: number; currency?: string } | null;
  [key: string]: unknown;
}

interface AccountUsageResult {
  alias: string;
  cfg_dir: string;
  ok: boolean;
  usage?: UsageEntry;
  error?: string;
  // v2.8.18 — added fields for stale-fallback rendering. Set when the
  // fresh fetch failed and we're returning a cached last-good entry.
  stale?: boolean;
  stale_age_ms?: number;
  last_good_at_ms?: number;
}

let _usageCache: { fetchedAt: number; data: AccountUsageResult[] } | null = null;
// 5min — same cadence as the history poller. The /api/refresh endpoint
// (POST or GET) clears this cache for an explicit on-demand fetch.
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

// v2.8.18 — per-alias last-good cache. When a fresh fetch errors for an
// alias (Anthropic 429, transient network, etc.) we substitute the cached
// last-successful entry tagged `stale: true` so the dashboard shows real
// numbers + a "·stale Xm" indicator instead of blank dashes.
const _usageLastGood = new Map<string, { entry: AccountUsageResult; at_ms: number }>();

// v2.8.18 — exponential backoff on Anthropic 429s. Anthropic rate-limits
// /api/oauth/usage aggressively; before this fix the dashboard hammered
// the endpoint every 5min even while being throttled. Backoff starts at
// 5min, doubles per consecutive 429 wave, caps at 30min. Resets on any
// successful tick. Module-level state — restart clears it, which is
// acceptable (the next tick will simply observe whatever Anthropic says).
let _usagePollBackoffUntil = 0;
let _usagePollConsecutive429s = 0;
const USAGE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const USAGE_BACKOFF_CAP_MS = 30 * 60 * 1000;

// Shells out to `subctl usage --json` once per TTL window. The bash impl has
// its own 60s on-disk cache; this in-process cache just avoids spawning a
// subprocess on every WebSocket tick.
//
// CodeRabbit pass-2 fixes:
//   Fix 1: `forceRefresh: true` bypasses the backoff short-circuit so the
//          operator's explicit /api/refresh button always attempts a live
//          fetch (otherwise clicking Refresh during a 429 storm would
//          silently keep showing stale data). The backoff bookkeeping
//          (consecutive-429s, until-ms) still ticks on the forced fetch
//          — if the forced refresh also 429s, we record the sample and
//          extend the backoff window like any other 429.
//   Fix 2: cache-hit branch now bumps `stale_age_ms` by
//          `now - _usageCache.fetchedAt` so the UI indicator advances
//          inside the 5-min in-process TTL window instead of being
//          frozen at whatever it was when the cache was last filled.
function subctlUsageFetchAll(now: number, opts?: { forceRefresh?: boolean }): AccountUsageResult[] {
  const forceRefresh = opts?.forceRefresh === true;

  if (!forceRefresh && _usageCache && now - _usageCache.fetchedAt < USAGE_CACHE_TTL_MS) {
    // Fix 2 — recompute stale_age_ms on every cache-hit read so the UI
    // doesn't show a frozen "stale 3m" for the whole 5-min cache TTL.
    const elapsedSinceCacheFetch = now - _usageCache.fetchedAt;
    if (elapsedSinceCacheFetch <= 0) return _usageCache.data;
    return _usageCache.data.map((u) => {
      if (!u.stale) return u;
      return {
        ...u,
        stale_age_ms: (u.stale_age_ms ?? 0) + elapsedSinceCacheFetch,
      };
    });
  }
  // v2.8.18 — honour the backoff window. While backed off we don't spawn
  // a subprocess; we re-run the stale-fallback against `_usageLastGood`
  // with an empty parsed[] so `stale_age_ms` is recomputed for every
  // /api/state call (CodeRabbit pass-1 Fix 3 — without this, stale_age_ms
  // gets frozen at the value computed when the cache was last filled and
  // the UI shows "stale 5m" for the entire backoff window). Cheap — just
  // a Map iteration.
  //
  // Fix 1 (pass-2): forceRefresh skips this; explicit /api/refresh
  // attempts to spawn a live fetch even mid-backoff. If the forced
  // refresh also 429s, the post-parse backoff bookkeeping (below) ticks
  // the consecutive-429s and extends the window like normal.
  if (!forceRefresh && now < _usagePollBackoffUntil) {
    return subctlUsageApplyFallback([], now);
  }
  // CodeRabbit pass-3 Fix 4 — track whether the fetch genuinely succeeded.
  // Hard errors (spawnSync error, non-zero exit, JSON parse throw) used to
  // collapse `parsed = []` and downstream code treated that as a clean
  // zero-429 sample, wrongly CLEARING the 429 backoff state. A hard error
  // is not a successful fetch — preserve the backoff window across it.
  let fetchSucceeded = false;
  let parsed: AccountUsageResult[] = [];
  try {
    const r = spawnSync(SUBCTL_BIN, ["usage", "--json"], {
      encoding: "utf8",
      timeout: 12_000,
    });
    if (r.error || (typeof r.status === "number" && r.status !== 0)) {
      // hard failure — leave parsed=[], DON'T touch backoff
    } else {
      parsed = JSON.parse(r.stdout || "[]") as AccountUsageResult[];
      // CodeRabbit pass-7: an empty array isn't a real success — it means
      // the bash CLI silently returned nothing (corrupted accounts.conf,
      // internal bash bug). Only treat non-empty as success so backoff
      // state isn't wrongly cleared.
      if (Array.isArray(parsed) && parsed.length > 0) {
        fetchSucceeded = true;
      }
    }
  } catch {
    // parse threw — leave parsed=[], DON'T touch backoff
  }

  // Stale-fallback first — substitute cached entries for any failed alias
  // BEFORE updating last-good, so a fresh failure followed by a fresh
  // success doesn't accidentally overwrite the cache with stale data.
  const withFallback = subctlUsageApplyFallback(parsed, now);

  // Backoff bookkeeping: count 429s in the fresh response. Use the raw
  // `parsed` (not withFallback) so substituted stale-good entries don't
  // hide a 429 that triggered them.
  let count429 = 0;
  for (const u of parsed) {
    if (!u.ok && typeof u.error === "string" && /\b429\b/.test(u.error)) count429++;
  }
  if (count429 > 0) {
    _usagePollConsecutive429s++;
    const k = _usagePollConsecutive429s - 1;
    const backoff = Math.min(USAGE_BACKOFF_BASE_MS * Math.pow(2, k), USAGE_BACKOFF_CAP_MS);
    _usagePollBackoffUntil = now + backoff;
    console.warn(
      `[usage-poll] ${count429} alias(es) returned 429 — backing off ${Math.round(backoff / 60_000)}min (consecutive=${_usagePollConsecutive429s})`,
    );
  } else if (fetchSucceeded && (_usagePollConsecutive429s > 0 || _usagePollBackoffUntil > 0)) {
    // Fix 4 — only clear backoff on a real success with zero 429s.
    // !fetchSucceeded && count429===0 → hard error: preserve backoff.
    console.warn(`[usage-poll] backoff cleared (no 429s this tick)`);
    _usagePollConsecutive429s = 0;
    _usagePollBackoffUntil = 0;
  }

  _usageCache = { fetchedAt: now, data: withFallback };
  return withFallback;
}

// v2.8.18 — for any alias whose fresh fetch returned ok:false, substitute
// the cached last-good entry tagged stale. For ok:true entries, update the
// cache.
//
// CodeRabbit pass-1 fixes:
//   Fix 2: also synthesize entries for cached aliases the fresh-fetch
//          omitted entirely (e.g. `subctl usage --json` returned []
//          because the bash CLI itself failed before reaching all
//          aliases). Without this, those cached good entries silently
//          vanish from /api/state.
//   Fix 4: stale entries are tagged `ok: false`. The dashboard render
//          path uses `stale` / `usage_stale` (not `ok`), so the cells
//          still show their cached numbers + "·stale Xm". But
//          recordUsageSnapshot() gates on `u.ok` and would otherwise
//          append the SAME cached entry to usage-history.jsonl every
//          5-min tick during a 429 storm — exploding the history file
//          with synthetic samples.
// CodeRabbit pass-3 fix:
//   Fix 3: when BOTH parsed and _usageLastGood are empty (fresh install,
//          fresh restart with no prior good fetch), synthesize a "no
//          data yet" row per configured claude account so the dashboard
//          renders an error indicator instead of dropping the row
//          silently.
function subctlUsageApplyFallback(parsed: AccountUsageResult[], now: number): AccountUsageResult[] {
  const out: AccountUsageResult[] = parsed.map((u) => {
    if (u.ok && u.usage) {
      _usageLastGood.set(u.alias, { entry: u, at_ms: now });
      return u;
    }
    const cached = _usageLastGood.get(u.alias);
    if (!cached) return u;
    return {
      alias: u.alias,
      cfg_dir: u.cfg_dir,
      ok: false,                            // Fix 4 — synthetic, not fresh
      usage: cached.entry.usage,
      error: u.error,
      stale: true,
      stale_age_ms: Math.max(0, now - cached.at_ms),
      last_good_at_ms: cached.at_ms,
    };
  });

  // Fix 2 — fold in cached aliases the fresh-fetch dropped entirely.
  const seenAliases = new Set(out.map((u) => u.alias));
  for (const [alias, cached] of _usageLastGood) {
    if (seenAliases.has(alias)) continue;
    out.push({
      alias,
      cfg_dir: cached.entry.cfg_dir,
      ok: false,                            // Fix 4 — synthetic, not fresh
      usage: cached.entry.usage,
      error: "no fresh fetch result — using cached",
      stale: true,
      stale_age_ms: Math.max(0, now - cached.at_ms),
      last_good_at_ms: cached.at_ms,
    });
    seenAliases.add(alias);
  }

  // CodeRabbit pass-3 Fix 3 — when BOTH parsed and _usageLastGood produce
  // nothing for a configured claude account (brand-new install, fresh
  // restart with no successful fetch yet, or every fetch has been
  // failing), synthesize a "no data yet" row so the dashboard renders
  // a per-row error indicator instead of dropping the row silently.
  // Only Anthropic accounts emit usage; non-Anthropic (gemini/openai) get
  // null usage naturally and are intentionally omitted here. CodeRabbit
  // pass-5: accept both legacy ("claude") and canonical ("anthropic")
  // provider ids — accounts.conf can carry either form depending on when
  // the row was written.
  try {
    const { accounts: configured } = parseAccountsConf();
    for (const acct of configured) {
      if (acct.provider !== "claude" && acct.provider !== "anthropic") continue;
      if (seenAliases.has(acct.alias)) continue;
      out.push({
        alias: acct.alias,
        cfg_dir: acct.config_dir,
        ok: false,
        error: "usage fetch failed — no data yet",
        stale: false,                       // never had good data; not stale
      });
      seenAliases.add(acct.alias);
    }
  } catch { /* best-effort — parseAccountsConf is normally pure */ }

  return out;
}

function usageForAlias(alias: string, all: AccountUsageResult[]): UsageEntry | null {
  // v2.8.18 — accept stale entries too; the per-row `usage_stale` flag in
  // /api/state tells the UI to dim/label them.
  const hit = all.find(u => u.alias === alias && (u.ok || u.stale));
  return hit?.usage ?? null;
}

// v2.8.18 — companion lookup so /api/state can surface per-row error +
// stale info. Returns the full entry (or null if absent) so callers can
// pick the fields they want.
function usageEntryForAlias(alias: string, all: AccountUsageResult[]): AccountUsageResult | null {
  return all.find(u => u.alias === alias) ?? null;
}

// ---------- utilization history (24h sparkline) ----------
//
// Polls /api/oauth/usage every POLL_INTERVAL_MS and appends a snapshot per
// account to a JSONL file. The Accounts table renders 24 hourly buckets
// per account, each colored by the MAX five_hour utilization observed that
// hour. Empty hours (no poll, or no auth at the time) render dim.
//
// 429 events on the local hook log remain orthogonal — they record actual
// blocking outcomes; this records the upstream signal (utilization curve)
// that drives whether 429s fire.

const SUBCTL_CONFIG_DIR = process.env.SUBCTL_CONFIG_DIR
  ?? join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "subctl");
const HISTORY_FILE = join(SUBCTL_CONFIG_DIR, "cache", "usage-history.jsonl");
const HISTORY_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface HistoryEntry {
  ts: number;
  alias: string;
  five_hour: number | null;
  seven_day: number | null;
  seven_day_sonnet: number | null;
}

function recordUsageSnapshot(now: number, all: AccountUsageResult[]) {
  const lines: string[] = [];
  for (const u of all) {
    if (!u.ok || !u.usage) continue;
    const entry: HistoryEntry = {
      ts: now,
      alias: u.alias,
      five_hour: u.usage.five_hour?.utilization ?? null,
      seven_day: u.usage.seven_day?.utilization ?? null,
      seven_day_sonnet: u.usage.seven_day_sonnet?.utilization ?? null,
    };
    lines.push(JSON.stringify(entry));
  }
  if (lines.length === 0) return;
  try {
    mkdirSync(join(SUBCTL_CONFIG_DIR, "cache"), { recursive: true });
    appendFileSync(HISTORY_FILE, lines.join("\n") + "\n");
  } catch { /* best-effort */ }
}

// Read all snapshots within the last 24 hours, bucket by alias and hour-of-day-relative-to-now.
// Returns Map<alias, Array<{maxFiveHour, maxSevenDay, sampleCount}>> with 24 entries per alias
// (oldest hour first, current hour last).
function readUsageHistory24h(now: number) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const currentHour = Math.floor(now / (60 * 60 * 1000));
  const buckets = new Map<string, Array<{ five_hour_max: number | null; seven_day_max: number | null; samples: number }>>();
  const init = () => Array.from({ length: 24 }, () => ({ five_hour_max: null as number | null, seven_day_max: null as number | null, samples: 0 }));
  if (!existsSync(HISTORY_FILE)) return buckets;

  let raw: string;
  try { raw = readFileSync(HISTORY_FILE, "utf8"); } catch { return buckets; }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: HistoryEntry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.ts !== "number" || entry.ts < cutoff) continue;
    // Bucket by absolute hour (each entry's clock hour) so a poll at 17:42
    // lands in the same bucket whether read at 17:43 or 17:59.
    const entryHour = Math.floor(entry.ts / (60 * 60 * 1000));
    const hoursAgo = currentHour - entryHour;
    if (hoursAgo < 0 || hoursAgo >= 24) continue;
    const idx = 23 - hoursAgo;
    if (!buckets.has(entry.alias)) buckets.set(entry.alias, init());
    const slot = buckets.get(entry.alias)![idx]!;
    slot.samples += 1;
    if (typeof entry.five_hour === "number") {
      slot.five_hour_max = slot.five_hour_max === null ? entry.five_hour : Math.max(slot.five_hour_max, entry.five_hour);
    }
    if (typeof entry.seven_day === "number") {
      slot.seven_day_max = slot.seven_day_max === null ? entry.seven_day : Math.max(slot.seven_day_max, entry.seven_day);
    }
  }
  return buckets;
}

// One-time housekeeping at startup: drop entries older than HISTORY_RETAIN_MS.
function pruneUsageHistory(now: number) {
  if (!existsSync(HISTORY_FILE)) return;
  const cutoff = now - HISTORY_RETAIN_MS;
  let raw: string;
  try { raw = readFileSync(HISTORY_FILE, "utf8"); } catch { return; }
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.ts === "number" && e.ts >= cutoff) kept.push(line);
    } catch { /* drop malformed */ }
  }
  try {
    mkdirSync(join(SUBCTL_CONFIG_DIR, "cache"), { recursive: true });
    Bun.write(HISTORY_FILE, kept.length > 0 ? kept.join("\n") + "\n" : "");
  } catch { /* ignore */ }
}

// ---------- cost summary (jsonl walk, API-rate cost) ----------
//
// Walking every account's transcript jsonls is expensive on large histories
// (Jason has 80K+ turns in the default config). Cache aggressively.

interface CostBundle {
  this_month: AccountCostSummary[];
  this_week:  AccountCostSummary[];
  totals: {
    api_cost_month_usd: number;
    subscription_total_usd: number;
    savings_month_usd: number;
  };
}

let _costCache: { fetchedAt: number; data: CostBundle } | null = null;
const COST_CACHE_TTL_MS = 5 * 60 * 1000; // 5min — same cadence as usage

function buildCostBundle(now: number): CostBundle {
  if (_costCache && now - _costCache.fetchedAt < COST_CACHE_TTL_MS) {
    return _costCache.data;
  }
  const month = aggregateCostAll("month", now);
  const week  = aggregateCostAll("week", now);
  const totals = month.reduce(
    (acc, r) => ({
      api_cost_month_usd: acc.api_cost_month_usd + r.total_cost_usd,
      subscription_total_usd: acc.subscription_total_usd + r.subscription_usd,
      savings_month_usd: acc.savings_month_usd + r.savings_usd,
    }),
    { api_cost_month_usd: 0, subscription_total_usd: 0, savings_month_usd: 0 },
  );
  const data: CostBundle = {
    this_month: month,
    this_week: week,
    totals: {
      api_cost_month_usd: Number(totals.api_cost_month_usd.toFixed(2)),
      subscription_total_usd: Number(totals.subscription_total_usd.toFixed(2)),
      savings_month_usd: Number(totals.savings_month_usd.toFixed(2)),
    },
  };
  _costCache = { fetchedAt: now, data };
  return data;
}

let _pollerStarted = false;
function ensureUsagePoller() {
  if (_pollerStarted) return;
  _pollerStarted = true;
  pruneUsageHistory(Date.now());
  // Snapshot once at startup, then on a 5-minute cadence.
  const tick = () => {
    const now = Date.now();
    const all = subctlUsageFetchAll(now);
    recordUsageSnapshot(now, all);
  };
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

// Verdict thresholds for usage signals. Yellow flags "be aware"; red flags
// "you're about to hit a wall and a fresh dispatch may run out mid-task".
const THRESH_7D_YELLOW = 70; // ≥70% weekly used → yellow
const THRESH_7D_RED    = 90; // ≥90% weekly used → red
const THRESH_5H_YELLOW = 80; // ≥80% session used → yellow
const THRESH_5H_RED    = 95; // ≥95% session used → red

interface AccountVerdict {
  verdict: "green" | "yellow" | "red";
  reasons: string[];
}

function computeAccountVerdict(args: {
  alias: string;
  authReady: boolean;
  usage: UsageEntry | null;
  recent429: number;
  parallelOnAccount: number;
}): AccountVerdict {
  const reasons: string[] = [];
  let level: "green" | "yellow" | "red" = "green";
  const bump = (l: "yellow" | "red") => {
    if (l === "red") level = "red";
    else if (level !== "red") level = "yellow";
  };

  if (!args.authReady) {
    return { verdict: "red", reasons: ["account not authenticated"] };
  }

  const wkly = args.usage?.seven_day?.utilization;
  if (typeof wkly === "number") {
    if (wkly >= THRESH_7D_RED)         { bump("red");    reasons.push(`weekly ${wkly}% (red ≥${THRESH_7D_RED}%)`); }
    else if (wkly >= THRESH_7D_YELLOW) { bump("yellow"); reasons.push(`weekly ${wkly}%`); }
  }

  const sess = args.usage?.five_hour?.utilization;
  if (typeof sess === "number") {
    if (sess >= THRESH_5H_RED)         { bump("red");    reasons.push(`5h ${sess}% (red ≥${THRESH_5H_RED}%)`); }
    else if (sess >= THRESH_5H_YELLOW) { bump("yellow"); reasons.push(`5h ${sess}%`); }
  }

  if (args.recent429 >= 3)      { bump("red");    reasons.push(`${args.recent429} RL hits today`); }
  else if (args.recent429 >= 1) { bump("yellow"); reasons.push(`${args.recent429} RL hit${args.recent429 === 1 ? "" : "s"} today`); }

  if (args.parallelOnAccount >= 5)      { bump("red");    reasons.push(`${args.parallelOnAccount} parallel sessions on this account`); }
  else if (args.parallelOnAccount >= 3) { bump("yellow"); reasons.push(`${args.parallelOnAccount} parallel sessions on this account`); }

  return { verdict: level, reasons };
}

function tmuxRun(args: string[]): { stdout: string; ok: boolean } {
  try {
    const r = spawnSync(TMUX_BIN, args, { encoding: "utf8" });
    if (r.error) return { stdout: "", ok: false };
    if (typeof r.status === "number" && r.status !== 0) return { stdout: r.stdout ?? "", ok: false };
    return { stdout: r.stdout ?? "", ok: true };
  } catch {
    return { stdout: "", ok: false };
  }
}

function listTmuxSessions(): TmuxSessionRaw[] {
  const r = tmuxRun([
    "list-sessions",
    "-F",
    "#{session_name}|#{session_created}|#{session_path}|#{session_windows}|#{?session_attached,1,0}",
  ]);
  if (!r.ok || !r.stdout.trim()) return [];
  const out: TmuxSessionRaw[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const [name, created, path, windows, attached] = parts;
    out.push({
      name: name!,
      created: Number(created) || 0,
      path: path ?? "",
      windows: Number(windows) || 0,
      attached: attached === "1",
    });
  }
  return out;
}

interface PaneInfo {
  session: string;
  pane_id: string;
  command: string;
  active: boolean;
}

function listAllPanes(): Map<string, PaneInfo[]> {
  const r = tmuxRun([
    "list-panes", "-a",
    "-F", "#{session_name}|#{pane_id}|#{pane_current_command}|#{pane_active}",
  ]);
  const map = new Map<string, PaneInfo[]>();
  if (!r.ok) return map;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [session, pane_id, command, active] = parts;
    const pi: PaneInfo = {
      session: session!, pane_id: pane_id!, command: command ?? "",
      active: active === "1",
    };
    const arr = map.get(pi.session) ?? [];
    arr.push(pi);
    map.set(pi.session, arr);
  }
  return map;
}

function tmuxShowEnv(session: string, varName: string): string | null {
  const r = tmuxRun(["show-environment", "-t", session, varName]);
  if (!r.ok) return null;
  // Output forms:
  //   "VAR=value"   → set
  //   "-VAR"        → unset (leading dash)
  //   "" or error   → not present
  const line = r.stdout.split("\n").find(l => l.trim().length > 0) ?? "";
  if (!line || line.startsWith("-")) return null;
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  return line.slice(eq + 1).replace(/\/+$/, "");
}

function tmuxCapturePreview(session: string): string {
  // Last 3 visible lines, plain (no -e → no ANSI). Strip stray escapes anyway.
  const r = tmuxRun(["capture-pane", "-p", "-t", session, "-S", "-3"]);
  if (!r.ok) return "";
  return stripAnsi(r.stdout).replace(/\s+$/g, "");
}

// Capture N lines from a tmux session for the camera-grid view.
// Used by /api/orchestration/captures (the Orchestration tab's NVR-style
// multi-team grid). Returns ANSI-stripped content suitable for rendering
// in a <pre> tile; phase-2 xterm.js per tile would skip the strip and
// render real terminal escapes.
function tmuxCaptureFrame(session: string, lines: number): string {
  const n = Math.max(8, Math.min(200, Math.floor(lines || 40)));
  const r = tmuxRun(["capture-pane", "-p", "-t", session, "-S", `-${n}`]);
  if (!r.ok) return "";
  return stripAnsi(r.stdout).replace(/\s+$/g, "");
}

// Naive Claude session-status detector — same logic as lib/session-preview.sh.
function detectStatus(preview: string): "working" | "idle" | "waiting" | "unknown" {
  const last = preview.split("\n").slice(-10).join("\n");
  // Permission prompts → waiting
  if (/Do you want to proceed|Do you want to|❯ 1\. Yes|\[y\/n\]|Approve/i.test(last)) return "waiting";
  // Spinner glyphs / tool use → working
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last)) return "working";
  if (/Tool use:|Thinking|thinking…/i.test(last)) return "working";
  // Visible Claude prompt → idle
  if (/❯ |^> /m.test(last)) return "idle";
  return "unknown";
}

function gitBranch(path: string): string {
  if (!path) return "—";
  if (!safeStat(path)) return "—";
  try {
    const r = spawnSync(GIT_BIN, ["-C", path, "branch", "--show-current"], { encoding: "utf8" });
    if (r.status === 0) {
      const b = (r.stdout ?? "").trim();
      return b || "—";
    }
  } catch { /* ignore */ }
  return "—";
}

// Find the most recently-modified Claude jsonl in a config dir; return its
// basename without extension (the session UUID).
function latestClaudeSessionId(cfgDir: string): string | null {
  const projectsDir = join(cfgDir, "projects");
  if (!existsSync(projectsDir)) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const proj of safeReaddir(projectsDir)) {
    const projPath = join(projectsDir, proj);
    const pst = safeStat(projPath);
    if (!pst || !pst.isDirectory()) continue;
    for (const file of safeReaddir(projPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const fp = join(projPath, file);
      const st = safeStat(fp);
      if (!st) continue;
      if (!best || st.mtimeMs > best.mtime) best = { file: fp, mtime: st.mtimeMs };
    }
  }
  if (!best) return null;
  return basename(best.file).replace(/\.jsonl$/, "");
}

// Default context window per model. The 1M-context variants (opus-4-7[1m],
// sonnet-4-6[1m], etc.) record the same model id in the API response as the
// 200K default — Anthropic doesn't expose the variant in usage blocks. So we
// auto-detect: if any turn in the session exceeded 90% of the default window,
// the session is on the larger variant and we bump up accordingly.
function defaultContextWindow(model: string): number {
  const m = (model || "").toLowerCase();
  if (m.startsWith("claude-haiku")) return 200_000;
  if (m.startsWith("claude-sonnet")) return 200_000;
  if (m.startsWith("claude-opus"))   return 200_000;
  return 200_000;
}

// Best-effort ctx % from the last usage block in the jsonl. Walks the whole
// file once: finds the latest turn (numerator) and the max turn-total
// (used to detect the active context-window variant).
function ctxPctForFile(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) return 0;
  const raw = safeRead(jsonlPath);
  if (!raw) return 0;

  let latestTotal = 0;
  let latestModel = "";
  let observedMax = 0;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes('"usage"')) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const usage = obj?.message?.usage ?? obj?.usage ?? null;
    if (!usage) continue;
    const curr = (usage.input_tokens ?? 0)
               + (usage.cache_creation_input_tokens ?? 0)
               + (usage.cache_read_input_tokens ?? 0)
               + (usage.output_tokens ?? 0);
    if (curr <= 0) continue;
    if (curr > observedMax) observedMax = curr;
    latestTotal = curr;
    latestModel = obj?.message?.model ?? obj?.model ?? latestModel;
  }
  if (latestTotal <= 0) return 0;

  let window = defaultContextWindow(latestModel);
  // If any turn exceeded 90% of the default window, the session is clearly
  // running on the 1M-context variant of the model.
  if (observedMax > window * 0.9) {
    window = observedMax <= 1_000_000
      ? 1_000_000
      : Math.ceil(observedMax / 100_000) * 100_000;
  }
  return Math.min(100, Math.floor(latestTotal * 100 / window));
}

// Age of a Claude session by parsing the first timestamp line of its jsonl.
function claudeSessionAgeSeconds(jsonlPath: string, now: number): number {
  if (!existsSync(jsonlPath)) return 0;
  const raw = safeRead(jsonlPath);
  if (!raw) return 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes('"timestamp"')) continue;
    try {
      const obj = JSON.parse(t);
      const ts = obj?.timestamp;
      if (typeof ts !== "string") continue;
      const ms = Date.parse(ts);
      if (Number.isNaN(ms)) continue;
      return Math.max(0, Math.floor((now - ms) / 1000));
    } catch { /* keep looking */ }
  }
  return 0;
}

// ---------- rate limits ----------

interface RLEvent {
  ts: string;                 // ISO8601 UTC
  age_seconds: number;        // relative to now
  type_code: number;          // 429 or 529 (parsed from .type string)
  type_label: string;         // raw .type field, e.g. "529 (overload)"
  is_user_rate_limit: boolean;// true for 429, false for 529 — only 429 reflects user behavior
  account: string | null;     // resolved alias if known, else null
  session: string;            // session UUID
}

interface RLData {
  today_total: number;
  // Hits within the trailing 2h that are 429 (user rate limit). These are the
  // only hits that should affect the dispatch verdict — 529 is server-side
  // overload, unrelated to user behavior, and aged-out hits are stale.
  recent_429_count: number;
  recent_429_events: RLEvent[];
  events_today: RLEvent[];     // all today's events, newest-first, with full detail
  by_account: Map<string, { count_today: number; buckets_24h: number[] }>;
  by_session_today: Map<string, number>;
}

const RL_RECENT_WINDOW_SEC = 2 * 60 * 60; // 2h — the window that drives verdict

function buildRateLimits(accountAliases: string[], sidToAlias: Map<string, string>, now: number): RLData {
  const today = todayDateStr();
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  const currentHourMs = startOfHour.getTime();
  const nowMs = now;

  const byAccount = new Map<string, { count_today: number; buckets_24h: number[] }>();
  for (const a of accountAliases) {
    byAccount.set(a, { count_today: 0, buckets_24h: new Array(24).fill(0) });
  }
  const bySession = new Map<string, number>();
  const eventsToday: RLEvent[] = [];
  const recent429s: RLEvent[] = [];

  const raw = safeRead(RL_LOG);
  if (!raw) {
    return {
      today_total: 0, recent_429_count: 0, recent_429_events: [],
      events_today: [], by_account: byAccount, by_session_today: bySession,
    };
  }

  let total = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try { ev = JSON.parse(t); } catch { continue; }
    const explicitAcct: string | null = ev.account ?? ev.alias ?? null;
    const sid: string | null = ev.session ?? null;
    const date = ev.date ?? (typeof ev.ts === "string" ? ev.ts.slice(0, 10) : null);
    const tsStr: string = ev.ts ?? "";
    const typeLabel: string = ev.type ?? "unknown";

    // Parse 429 vs 529 from the .type label. Format historically:
    //   "429 (rate_limit)"  → 429, user's per-minute/daily cap
    //   "529 (overload)"    → 529, Anthropic-side capacity, NOT the user's fault
    let typeCode = 0;
    if (typeLabel.startsWith("429")) typeCode = 429;
    else if (typeLabel.startsWith("529")) typeCode = 529;

    // Resolve account: explicit field > session-id lookup
    let acct = explicitAcct;
    if (!acct && sid && sidToAlias.has(sid)) acct = sidToAlias.get(sid)!;

    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ageSec = Number.isFinite(tsMs) ? Math.max(0, Math.floor((nowMs - tsMs) / 1000)) : 0;

    const event: RLEvent = {
      ts: tsStr,
      age_seconds: ageSec,
      type_code: typeCode,
      type_label: typeLabel,
      is_user_rate_limit: typeCode === 429,
      account: acct,
      session: sid ?? "",
    };

    if (date === today) {
      total += 1;
      eventsToday.push(event);
      if (acct && byAccount.has(acct)) byAccount.get(acct)!.count_today += 1;
      if (sid) bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
    }

    // Recent window: only 429 events within the last RL_RECENT_WINDOW_SEC
    if (typeCode === 429 && ageSec <= RL_RECENT_WINDOW_SEC) {
      recent429s.push(event);
    }

    // Hourly buckets covering the trailing 24h, oldest -> newest.
    if (Number.isFinite(tsMs) && acct && byAccount.has(acct)) {
      const hoursAgo = Math.floor((currentHourMs - tsMs) / (60 * 60 * 1000));
      if (hoursAgo >= 0 && hoursAgo < 24) {
        const idx = 23 - hoursAgo;
        byAccount.get(acct)!.buckets_24h[idx] += 1;
      }
    }
  }

  // Newest-first.
  eventsToday.sort((a, b) => b.ts.localeCompare(a.ts));
  recent429s.sort((a, b) => b.ts.localeCompare(a.ts));

  return {
    today_total: total,
    recent_429_count: recent429s.length,
    recent_429_events: recent429s,
    events_today: eventsToday,
    by_account: byAccount,
    by_session_today: bySession,
  };
}

// ---------- auth status ----------

function authStatus(account: Account): "ready" | "not_authenticated" {
  // Claude shape: .credentials.json present, or projects/ has at least one
  // session-keyed subdirectory.
  const credsPath = join(account.config_dir, ".credentials.json");
  if (existsSync(credsPath)) return "ready";
  const projectsDir = join(account.config_dir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of safeReaddir(projectsDir)) {
      const st = safeStat(join(projectsDir, entry));
      if (st && st.isDirectory()) return "ready";
    }
  }
  // Codex (OpenAI) shape: auth.json with .tokens populated. We key off token
  // presence rather than .auth_mode because Codex's simplified login flow
  // (current default) doesn't write auth_mode at all.
  const codexAuthPath = join(account.config_dir, "auth.json");
  if (existsSync(codexAuthPath)) {
    try {
      const parsed = JSON.parse(readFileSync(codexAuthPath, "utf8"));
      const t = parsed?.tokens ?? {};
      if ((typeof t.id_token === "string" && t.id_token.length > 0)
          || (typeof t.access_token === "string" && t.access_token.length > 0)) {
        return "ready";
      }
    } catch { /* fall through */ }
  }
  return "not_authenticated";
}

// ---------- session enrichment ----------

// Active Claude Code conversation (jsonl mtime within last 5 min), regardless
// of whether it's inside a tmux pane. Surfaces the "I'm running claude in a
// terminal tab outside tmux" case the tmux panel can't see.
interface ActiveConversation {
  sid: string;                  // full session UUID
  account: string;              // alias if known, else "default"
  account_color_class: "cyan" | "blue" | "magenta" | "grey";
  config_dir: string;
  project: string;              // basename of cwd
  cwd: string;
  age_seconds: number;          // wall clock since first message
  last_activity_seconds_ago: number;  // since last jsonl write
  size_kb: number;
  first_message_preview: string;
  is_worker: boolean;           // orchestrator-spawned team agent
}

function findActiveClaudeConversations(accounts: Account[], now: number): ActiveConversation[] {
  const ACTIVE_WINDOW_MS = 5 * 60 * 1000;  // 5 min
  const cutoffMs = now - ACTIVE_WINDOW_MS;

  // Map config_dir -> {alias, color}
  const cfgIndex = new Map<string, { alias: string; color: "cyan" | "blue" | "magenta" | "grey" }>();
  for (const a of accounts) {
    cfgIndex.set(a.config_dir, { alias: a.alias, color: colorClassFor(a.alias) });
  }
  // Default ~/.claude (no alias)
  const defaultCfg = join(HOME, ".claude");
  if (!cfgIndex.has(defaultCfg)) {
    cfgIndex.set(defaultCfg, { alias: "default", color: "grey" });
  }

  const out: ActiveConversation[] = [];

  for (const [cfgDir, meta] of cfgIndex.entries()) {
    const projectsRoot = join(cfgDir, "projects");
    const projectDirs = safeReaddir(projectsRoot);
    for (const pd of projectDirs) {
      const projectPath = join(projectsRoot, pd);
      const projectStat = safeStat(projectPath);
      if (!projectStat || !projectStat.isDirectory()) continue;
      const files = safeReaddir(projectPath);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const jpath = join(projectPath, f);
        const st = safeStat(jpath);
        if (!st || !st.isFile()) continue;
        const mtimeMs = st.mtime.getTime();
        if (mtimeMs < cutoffMs) continue;

        // Decode cwd from project dir name: "-path-to-project" → "/path/to/project"
        const cwd = "/" + pd.replace(/^-/, "").replace(/-/g, "/");
        const sid = f.replace(/\.jsonl$/, "");

        // First message + first timestamp via head-of-file scan.
        let firstTs = 0;
        let firstMsg = "";
        try {
          // Read just the first ~64KB to find first user message + first timestamp.
          const fd = require("node:fs").openSync(jpath, "r");
          // 512KB head — large enough to cover busy session preambles
          // (system prompts, agent-setting events, etc.) before the first
          // user message in long-running conversations.
          const buf = Buffer.alloc(524288);
          const n = require("node:fs").readSync(fd, buf, 0, 524288, 0);
          require("node:fs").closeSync(fd);
          const head = buf.subarray(0, n).toString("utf8");
          for (const line of head.split("\n")) {
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (firstTs === 0 && ev.timestamp) {
                const t = Date.parse(ev.timestamp);
                if (Number.isFinite(t)) firstTs = t;
              }
              if (!firstMsg && ev.type === "user") {
                const c = ev.message?.content;
                if (typeof c === "string") firstMsg = c.slice(0, 100);
                else if (Array.isArray(c) && c[0]?.text) firstMsg = String(c[0].text).slice(0, 100);
                if (firstMsg) firstMsg = firstMsg.replace(/\s+/g, " ").trim();
              }
            } catch { /* skip malformed line */ }
            if (firstTs > 0 && firstMsg) break;
          }
        } catch { /* unreadable file */ }

        const ageSec = firstTs > 0 ? Math.floor((now - firstTs) / 1000) : 0;
        const lastActivitySec = Math.max(0, Math.floor((now - mtimeMs) / 1000));

        out.push({
          sid,
          account: meta.alias,
          account_color_class: meta.color,
          config_dir: cfgDir,
          project: basename(cwd),
          cwd,
          age_seconds: ageSec,
          last_activity_seconds_ago: lastActivitySec,
          size_kb: Math.round(st.size / 1024),
          first_message_preview: firstMsg || "(no user message yet)",
        });
      }
    }
  }

  // Sort: most-recently-active first
  out.sort((a, b) => a.last_activity_seconds_ago - b.last_activity_seconds_ago);
  return out;
}

// Catalog row for the session browser — every Claude Code session on the
// machine, regardless of recency. Lazily computed on /api/sessions/list.
interface SessionCatalogRow {
  sid: string;
  account: string;
  account_color_class: "cyan" | "blue" | "magenta" | "grey";
  config_dir: string;
  cwd: string;
  project: string;
  mtime_ts: number;        // ms since epoch
  size_kb: number;
  first_message_preview: string;
  is_worker: boolean;      // true for orchestrator-spawned team agents
}

// Reads the first ~64KB of a transcript and extracts:
//   - cwd: the canonical working dir (so e.g. 'my-project' decodes correctly,
//     not the lossy "decode every dash to /" of the encoded directory name)
//   - first user message + isWorker flag (`<teammate-message teammate_id="..."`
//     means orchestrator-spawned worker; user typically wants to resume the
//     operator session, not these)
function detectSessionMeta(jsonlPath: string): { cwd: string; preview: string; isWorker: boolean } {
  let cwd = "", preview = "", isWorker = false;
  try {
    const fs = require("node:fs");
    const fd = fs.openSync(jsonlPath, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        // Capture cwd from any event that exposes it (first line wins).
        if (!cwd && typeof ev.cwd === "string" && ev.cwd) {
          cwd = ev.cwd;
        }
        if (!preview && ev.type === "user") {
          const c = ev.message?.content;
          let text = "";
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) {
            const t = c.find((x: any) => x && typeof x.text === "string" && x.text);
            text = t?.text ?? "";
            if (!text && c[0]?.type) {
              text = `(${c.map((x: any) => x?.type).filter(Boolean).slice(0, 3).join(", ")})`;
            }
          }
          if (text) {
            const trimmed = text.trim();
            isWorker = /^<teammate-message\s+teammate_id="/i.test(trimmed);
            preview = trimmed.slice(0, 240).replace(/\s+/g, " ");
          }
        }
      } catch { /* skip bad line */ }
      if (cwd && preview) break;
    }
  } catch { /* unreadable */ }
  return { cwd, preview, isWorker };
}

function listAllClaudeSessions(limit: number): SessionCatalogRow[] {
  // Same cfgIndex shape as findActiveClaudeConversations but no time filter.
  const cfgIndex = new Map<string, { alias: string; color: "cyan" | "blue" | "magenta" | "grey" }>();
  // Pull accounts.conf.
  const { accounts } = parseAccountsConf();
  for (const a of accounts) {
    cfgIndex.set(a.config_dir, { alias: a.alias, color: colorClassFor(a.alias) });
  }
  const defaultCfg = join(HOME, ".claude");
  if (!cfgIndex.has(defaultCfg)) {
    cfgIndex.set(defaultCfg, { alias: "default", color: "grey" });
  }

  const rows: SessionCatalogRow[] = [];
  for (const [cfgDir, meta] of cfgIndex.entries()) {
    const projectsRoot = join(cfgDir, "projects");
    const projectDirs = safeReaddir(projectsRoot);
    for (const pd of projectDirs) {
      const projectPath = join(projectsRoot, pd);
      const projectStat = safeStat(projectPath);
      if (!projectStat || !projectStat.isDirectory()) continue;
      const files = safeReaddir(projectPath);
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const jpath = join(projectPath, f);
        const st = safeStat(jpath);
        if (!st || !st.isFile()) continue;
        const sid = f.replace(/\.jsonl$/, "");
        const meta2 = detectSessionMeta(jpath);
        // Prefer the canonical cwd from inside the transcript (handles
        // dashes-in-project-names correctly, e.g. 'my-project' or 'multi-word-name').
        // Fall back to the lossy decode if first-line cwd is missing.
        const cwd = meta2.cwd || ("/" + pd.replace(/^-/, "").replace(/-/g, "/"));
        rows.push({
          sid,
          account: meta.alias,
          account_color_class: meta.color,
          config_dir: cfgDir,
          cwd,
          project: basename(cwd),
          mtime_ts: st.mtime.getTime(),
          size_kb: Math.round(st.size / 1024),
          first_message_preview: meta2.preview,
          is_worker: meta2.isWorker,
        });
      }
    }
  }
  // Sort newest-first.
  rows.sort((a, b) => b.mtime_ts - a.mtime_ts);
  return rows.slice(0, limit);
}

interface SessionRecord {
  name: string;
  path: string;
  project: string;
  branch: string;
  account: string;
  account_email: string | null;
  color_class: "cyan" | "blue" | "magenta" | "grey";
  panes: number;
  attached: boolean;
  command: string;
  preview: string;
  ctx_pct: number;
  ctx_color: "green" | "yellow" | "orange" | "red";
  rl_today: number;
  age_seconds: number;
  age_color: "green" | "yellow" | "red";
  status: "working" | "idle" | "waiting" | "unknown";
}

function enrichSessions(
  rawSessions: TmuxSessionRaw[],
  panesBySession: Map<string, PaneInfo[]>,
  accounts: Account[],
  now: number,
  rl: RLData,
): { records: SessionRecord[]; sidToAlias: Map<string, string> } {
  const cfgToAccount = new Map<string, Account>();
  for (const a of accounts) cfgToAccount.set(a.config_dir.replace(/\/+$/, ""), a);

  const sidToAlias = new Map<string, string>();
  const records: SessionRecord[] = [];

  for (const ts of rawSessions) {
    const cfg = tmuxShowEnv(ts.name, "CLAUDE_CONFIG_DIR");
    const account = cfg ? cfgToAccount.get(cfg.replace(/\/+$/, "")) : undefined;
    const alias = account?.alias ?? "(none)";
    const colorClass = account ? colorClassFor(alias) : "grey";

    // Active pane → command. Default to first pane if none flagged active.
    const panes = panesBySession.get(ts.name) ?? [];
    const activePane = panes.find(p => p.active) ?? panes[0];
    const command = activePane?.command ?? "";

    const preview = tmuxCapturePreview(ts.name);
    const status = detectStatus(preview);

    // Try to resolve a Claude session ID for this tmux session (for ctx/age/RL).
    let sid: string | null = null;
    if (account) sid = latestClaudeSessionId(account.config_dir);

    let ctxPct = 0;
    let claudeAgeSec = 0;
    if (account && sid) {
      const projectsDir = join(account.config_dir, "projects");
      // Find which project subdir contains this jsonl
      for (const proj of safeReaddir(projectsDir)) {
        const fp = join(projectsDir, proj, `${sid}.jsonl`);
        if (existsSync(fp)) {
          ctxPct = ctxPctForFile(fp);
          claudeAgeSec = claudeSessionAgeSeconds(fp, now);
          break;
        }
      }
      sidToAlias.set(sid, alias);
    }

    // Wall-clock age — preferred from tmux session_created. Falls back to
    // claude session age if tmux time was 0.
    const tmuxAgeSec = ts.created > 0 ? Math.floor(now / 1000) - ts.created : 0;
    const ageSeconds = tmuxAgeSec > 0 ? tmuxAgeSec : claudeAgeSec;

    const rlToday = sid ? (rl.by_session_today.get(sid) ?? 0) : 0;

    records.push({
      name: ts.name,
      path: ts.path,
      project: ts.path ? basename(ts.path) : ts.name,
      branch: gitBranch(ts.path),
      account: alias,
      account_email: account?.email ?? null,
      color_class: colorClass,
      panes: panes.length || ts.windows,
      attached: ts.attached,
      command,
      preview,
      ctx_pct: ctxPct,
      ctx_color: classifyCtx(ctxPct),
      rl_today: rlToday,
      age_seconds: Math.max(0, ageSeconds),
      age_color: classifyAge(ageSeconds),
      status,
    });
  }

  return { records, sidToAlias };
}

// ---------- dispatch verdict ----------
//
// Mirror lib/radar.sh's classification but emit human-readable reasons that
// reference the actual offending session/account, not just aggregate numbers.

// Global verdict = best-of any account's verdict. The user can dispatch fresh
// work to any account that's GREEN, so as long as one is, the global state is
// "you have somewhere to go." Reasons for non-green accounts surface below
// the banner so it's still obvious which accounts are constrained.
//
// Session-level signals (ctx %, age) are intentionally NOT considered here:
// they describe state of an EXISTING session and have no bearing on whether a
// fresh dispatch in another folder can run.
function dispatchVerdict(
  accounts: ReturnType<typeof buildAccountSummaries>,
  _sessions: SessionRecord[],
  _rl: RLData,
): { verdict: "green" | "yellow" | "red"; reasons: string[] } {
  if (accounts.length === 0) {
    return { verdict: "red", reasons: ["No accounts configured"] };
  }

  const order = { green: 0, yellow: 1, red: 2 } as const;
  let bestLevel: "green" | "yellow" | "red" = "red";
  for (const a of accounts) {
    if (order[a.dispatch.verdict] < order[bestLevel]) bestLevel = a.dispatch.verdict;
    if (bestLevel === "green") break;
  }

  const reasons: string[] = [];
  for (const a of accounts) {
    if (a.dispatch.verdict === "green") {
      reasons.push(`${a.alias}: GO`);
    } else {
      const why = a.dispatch.reasons.join(", ");
      reasons.push(`${a.alias}: ${a.dispatch.verdict.toUpperCase()}${why ? ` — ${why}` : ""}`);
    }
  }

  return { verdict: bestLevel, reasons };
}

// ---------- account summaries ----------

function buildAccountSummaries(
  accounts: Account[],
  sessions: SessionRecord[],
  rl: RLData,
  usageAll: AccountUsageResult[],
  history24h: ReturnType<typeof readUsageHistory24h>,
  now: number,
) {
  return accounts.map(acc => {
    const mySessions = sessions.filter(s => s.account === acc.alias);
    const lastSec = mySessions.reduce(
      (min, s) => Math.min(min, s.age_seconds),
      Number.POSITIVE_INFINITY,
    );
    const rlEntry = rl.by_account.get(acc.alias);
    const auth = authStatus(acc);
    const usage = usageForAlias(acc.alias, usageAll);
    // v2.8.18 — pick up the raw entry so we can surface per-row error +
    // stale info without re-running the lookup downstream.
    const usageEntry = usageEntryForAlias(acc.alias, usageAll);
    const verdict = computeAccountVerdict({
      alias: acc.alias,
      authReady: auth === "ready",
      usage,
      recent429: rlEntry?.count_today ?? 0,
      parallelOnAccount: mySessions.length,
    });
    const hist = history24h.get(acc.alias) ?? Array.from({ length: 24 }, () => ({ five_hour_max: null, seven_day_max: null, samples: 0 }));
    return {
      alias: acc.alias,
      provider: acc.provider,
      email: acc.email,
      config_dir: acc.config_dir,
      auth_status: auth,
      active_sessions: mySessions.length,
      rl_hits_today: rlEntry?.count_today ?? 0,
      last_activity_seconds_ago: Number.isFinite(lastSec) ? lastSec : null,
      color_class: colorClassFor(acc.alias),
      usage,
      dispatch: verdict,
      usage_history_24h: hist,
      // v2.8.18 — per-row usage status for the dashboard. `usage_error`
      // is the actual cause (e.g. "HTTP 429" / "no auth"); `usage_stale`
      // tells the UI to dim the cells + show "·stale Xm"; the `_ms`
      // field is the age of the cached fallback if any.
      usage_error: usageEntry?.error ?? null,
      usage_stale: !!usageEntry?.stale,
      usage_stale_age_ms: usageEntry?.stale_age_ms ?? null,
    };
  });
}

// ---------- orchestration list ----------

// Filter tmux sessions to those spawned by `subctl teams claude` —
// they have a CLAUDE_CONFIG_DIR set in their tmux env, which is the
// signal that distinguishes "orchestrator session" from random tmux noise.
// Used by the /api/orchestration endpoint AND included in buildState() so
// the dashboard UI can render an Orchestrations panel.
// In-memory cache of master /teams response. Refreshed in the background
// every 2s so buildState() stays synchronous (called from many places, some
// HTTP-handler-sync) and never blocks on a master fetch.
type MasterTeamRow = {
  name: string;
  last_activity_seconds_ago: number;
  last_event: { ts: string; type: string; text?: string; [k: string]: unknown } | null;
};
let _masterTeams = new Map<string, MasterTeamRow>();
let _masterTeamsLastSyncMs: number | null = null;

async function refreshMasterTeams(): Promise<void> {
  try {
    const port = process.env.SUBCTL_EVY_PORT ?? "8788";
    const r = await fetch(`http://127.0.0.1:${port}/teams`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { ok: boolean; teams: MasterTeamRow[] };
    const map = new Map<string, MasterTeamRow>();
    for (const t of j.teams ?? []) map.set(t.name, t);
    _masterTeams = map;
    _masterTeamsLastSyncMs = Date.now();
  } catch {
    // Master may be down — keep the last known map so the dashboard still
    // shows something, but mark it stale via _masterTeamsLastSyncMs.
  }
}
// Kick off the background refresh loop (only once per process).
let _masterTeamsPoller: ReturnType<typeof setInterval> | null = null;
function ensureMasterTeamsPoller() {
  if (_masterTeamsPoller) return;
  void refreshMasterTeams(); // fire one immediately
  _masterTeamsPoller = setInterval(() => void refreshMasterTeams(), 2000);
}

// Dev teams = tmux sessions with CLAUDE_CONFIG_DIR set (spawned by `subctl
// teams claude`). We enrich each with last-activity from the master daemon's
// inbox tracker. The team name in tmux matches the inbox file basename when
// the lead reports under that name; if it doesn't match, last_activity stays
// null (still rendered, just without the staleness signal).
function buildOrchestrations(): Array<{
  name: string;
  path: string;
  attached: boolean;
  windows: number;
  claude_account_dir: string | null;
  is_orchestrator: boolean;
  last_activity_seconds_ago: number | null;
  last_event_type: string | null;
  last_event_text: string | null;
}> {
  ensureMasterTeamsPoller();
  const rawSessions = listTmuxSessions();
  return rawSessions
    .map((s) => {
      const cfg = tmuxShowEnv(s.name, "CLAUDE_CONFIG_DIR");
      const team = _masterTeams.get(s.name);
      return {
        name: s.name,
        path: s.path,
        attached: s.attached,
        windows: s.windows,
        claude_account_dir: cfg,
        is_orchestrator: cfg !== null,
        last_activity_seconds_ago: team?.last_activity_seconds_ago ?? null,
        last_event_type: team?.last_event?.type ?? null,
        last_event_text: (team?.last_event?.text as string | undefined) ?? null,
      };
    })
    .filter((x) => x.is_orchestrator);
}

// ---------- top-level state builder ----------

function buildState(opts?: { forceUsageRefresh?: boolean }) {
  const now = Date.now();
  const { accounts: rawAccounts, warning } = parseAccountsConf();

  // 1. Snapshot tmux state (cheap up-front calls).
  const rawSessions = listTmuxSessions();
  const panesBySession = listAllPanes();

  // 2. Rate limits — single pass. We pass an empty sid→alias map; the radar.sh
  //    bash uses an awk pipeline to back-attribute account-less log lines via
  //    session UUID, but per-account RL counts here come from explicit
  //    `account` fields in the log, while per-session counts come from the
  //    `session` field. That's enough for the dashboard's needs.
  const rl = buildRateLimits(rawAccounts.map(a => a.alias), new Map(), now);

  const { records: sessions } = enrichSessions(
    rawSessions, panesBySession, rawAccounts, now, rl,
  );

  ensureUsagePoller();
  // CodeRabbit pass-2 Fix 1 — when the caller is the operator-clicked
  // /api/refresh, bypass both the in-process TTL cache (already cleared
  // by the handler) AND the 429 backoff so an explicit refresh always
  // attempts a live fetch. Background pollers / regular state queries
  // keep the default (respect backoff).
  const usageAll = subctlUsageFetchAll(now, { forceRefresh: opts?.forceUsageRefresh === true });
  const history24h = readUsageHistory24h(now);
  const accountSummaries = buildAccountSummaries(rawAccounts, sessions, rl, usageAll, history24h, now);

  const sessionsOut = sessions
    .slice()
    .sort((a, b) => a.age_seconds - b.age_seconds);

  const rateLimits = {
    today_total: rl.today_total,
    recent_429_count: rl.recent_429_count,
    by_account: Array.from(rl.by_account.entries()).map(([account, data]) => ({
      account,
      color_class: colorClassFor(account),
      count_today: data.count_today,
      buckets_24h: data.buckets_24h,
      // Utilization curve from /api/oauth/usage polling — much richer signal
      // than 429 event counts. Each entry is a 1h bucket, oldest→newest.
      usage_history_24h: history24h.get(account) ?? Array.from({ length: 24 }, () => ({ five_hour_max: null, seven_day_max: null, samples: 0 })),
    })),
    // Last 20 events today, newest-first, with full detail so the dashboard
    // can show what actually happened (time, type, account, severity).
    events_today: rl.events_today.slice(0, 20).map(ev => ({
      ts: ev.ts,
      age_seconds: ev.age_seconds,
      type: ev.type_label,
      type_code: ev.type_code,
      is_user_rate_limit: ev.is_user_rate_limit,
      account: ev.account,
      account_color_class: ev.account ? colorClassFor(ev.account) : "grey",
      session: ev.session,
    })),
  };

  const dispatch = dispatchVerdict(accountSummaries, sessionsOut, rl);
  const cost = buildCostBundle(now);

  // Active Claude Code conversations — scans every ~/.claude*/projects/*/*.jsonl
  // for files modified in the last 5 minutes. These are CONVERSATIONS, not
  // tmux sessions; many overlap with the tmux panel above, but some don't
  // (e.g. claude run directly in a terminal tab, in iTerm, in a CLI host).
  // The frontend can decide whether to show a unified "active everything"
  // view or filter to non-tmux only.
  const activeConversations = findActiveClaudeConversations(rawAccounts, now);

  const totals = {
    tmux_sessions: sessionsOut.length,
    ready_accounts: accountSummaries.filter(a => a.auth_status === "ready").length,
    rl_today: rl.today_total,
    active_conversations_no_tmux: activeConversations.length,
  };

  const state: any = {
    version: readSubctlVersion(),
    now: new Date(now).toISOString(),
    service: {
      running: true,
      port: PORT,
      uptime_seconds: Math.floor((now - STARTED_AT) / 1000),
    },
    accounts: accountSummaries,
    sessions: sessionsOut,
    orchestrations: buildOrchestrations(),
    active_conversations: activeConversations,
    rate_limits: rateLimits,
    dispatch,
    cost,
    totals,
  };
  if (warning) state.warning = warning;
  return state;
}

// ---------- static file serving ----------

// v2.7.21 (ADR 0011 L2): xterm.js + xterm-addon-fit vendored from
// dashboard/node_modules. We deliberately don't commit the vendor blobs;
// `bun install` in dashboard/ (run by install.sh) lands them.
const NODE_MODULES_DIR = join(import.meta.dir, "node_modules");
const STATIC_FILES: Record<string, { path: string; type: string }> = {
  "/":            { path: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html":  { path: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
  "/style.css":   { path: join(PUBLIC_DIR, "style.css"),  type: "text/css; charset=utf-8" },
  "/app.js":      { path: join(PUBLIC_DIR, "app.js"),     type: "application/javascript; charset=utf-8" },
  "/terminal.js": { path: join(PUBLIC_DIR, "terminal.js"), type: "application/javascript; charset=utf-8" },
  // v2.8.8 — update modal, lazy-loaded by app.js on first #version-chip
  // click. Not added to the index.html <script> manifest so the initial
  // page payload stays lean.
  "/update-modal.js": { path: join(PUBLIC_DIR, "update-modal.js"), type: "application/javascript; charset=utf-8" },
  // v2.7.25 (Scope A): Lucide-backed SVG icon helper. Module-shape file
  // so future code can `import { icon } from "/icons.js"`; today it also
  // exposes window.subctlIcon for the classic-script app.js call sites.
  "/icons.js":    { path: join(PUBLIC_DIR, "icons.js"),   type: "application/javascript; charset=utf-8" },
  // v2.8.6 (decomposition wave 1): per-tab ES modules + their loader shell.
  // See ORCHESTRATION.md 2026-05-13 night session. Each future tab adds one
  // line here when it extracts.
  "/bootstrap.js":      { path: join(PUBLIC_DIR, "bootstrap.js"),               type: "application/javascript; charset=utf-8" },
  "/tabs/logs.js":      { path: join(PUBLIC_DIR, "tabs", "logs.js"),            type: "application/javascript; charset=utf-8" },
  "/tabs/templates.js": { path: join(PUBLIC_DIR, "tabs", "templates.js"),       type: "application/javascript; charset=utf-8" },
  "/tabs/models.js":    { path: join(PUBLIC_DIR, "tabs", "models.js"),          type: "application/javascript; charset=utf-8" },
  "/tabs/preferences.js": { path: join(PUBLIC_DIR, "tabs", "preferences.js"),   type: "application/javascript; charset=utf-8" },
  "/tabs/providers.js": { path: join(PUBLIC_DIR, "tabs", "providers.js"),       type: "application/javascript; charset=utf-8" },
  "/tabs/vault.js":     { path: join(PUBLIC_DIR, "tabs", "vault.js"),           type: "application/javascript; charset=utf-8" },
  "/tabs/memory.js":    { path: join(PUBLIC_DIR, "tabs", "memory.js"),          type: "application/javascript; charset=utf-8" },
  "/tabs/skills.js":    { path: join(PUBLIC_DIR, "tabs", "skills.js"),          type: "application/javascript; charset=utf-8" },
  "/tabs/projects.js":  { path: join(PUBLIC_DIR, "tabs", "projects.js"),        type: "application/javascript; charset=utf-8" },
  "/tabs/settings.js":  { path: join(PUBLIC_DIR, "tabs", "settings.js"),        type: "application/javascript; charset=utf-8" },
  "/tabs/policy.js":    { path: join(PUBLIC_DIR, "tabs", "policy.js"),          type: "application/javascript; charset=utf-8" },
  "/tabs/teams.js":     { path: join(PUBLIC_DIR, "tabs", "teams.js"),           type: "application/javascript; charset=utf-8" },
  "/tabs/orch.js":      { path: join(PUBLIC_DIR, "tabs", "orch.js"),            type: "application/javascript; charset=utf-8" },
  "/tabs/chat.js":      { path: join(PUBLIC_DIR, "tabs", "chat.js"),            type: "application/javascript; charset=utf-8" },
  "/logo.png":    { path: join(PUBLIC_DIR, "logo.png"),   type: "image/png" },
  "/tool-display.json": { path: join(PUBLIC_DIR, "tool-display.json"), type: "application/json; charset=utf-8" },
  "/vendor/xterm/xterm.js":  { path: join(NODE_MODULES_DIR, "xterm", "lib", "xterm.js"),  type: "application/javascript; charset=utf-8" },
  "/vendor/xterm/xterm.css": { path: join(NODE_MODULES_DIR, "xterm", "css", "xterm.css"), type: "text/css; charset=utf-8" },
  "/vendor/xterm/xterm-addon-fit.js": { path: join(NODE_MODULES_DIR, "xterm-addon-fit", "lib", "xterm-addon-fit.js"), type: "application/javascript; charset=utf-8" },
};

function serveStatic(pathname: string): Response | null {
  const entry = STATIC_FILES[pathname];
  if (!entry) return null;
  try {
    const body = readFileSync(entry.path);
    return new Response(body, { headers: { "Content-Type": entry.type } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// ---------- /help — markdown -> HTML ----------
//
// Tiny in-house markdown renderer. We only need the subset our help.md uses:
// H1-H4, paragraphs, fenced code, inline code, tables, lists, bold/italic,
// links, and HR. No need for a 50KB dep — the file is ~400 lines of text and
// the render runs once per page load.

const HELP_MD_PATH = join(import.meta.dir, "help.md");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Slugify "Setting up an account" -> "setting-up-an-account" for anchor IDs.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Render only inline-level constructs: code, bold, italic, links.
// Order matters: extract code spans first so we don't mangle them.
function renderInline(text: string): string {
  // Pull out `code` spans into placeholders so escaping/bold/italic
  // don't mutate them.
  const codeSpans: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE${codeSpans.length - 1}\x00`;
  });

  text = escapeHtml(text);

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    const safeHref = href.replace(/"/g, "&quot;");
    return `<a href="${safeHref}">${label}</a>`;
  });

  // Bold **x** then italic *x* (avoid clobbering the bold pair).
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  // Restore code spans.
  text = text.replace(/\x00CODE(\d+)\x00/g, (_m, i) => codeSpans[Number(i)] ?? "");
  return text;
}

function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push(`<p>${renderInline(buf.join(" ").trim())}</p>`);
    buf.length = 0;
  };

  let paraBuf: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (/^```/.test(line)) {
      flushParagraph(paraBuf);
      const langMatch = line.match(/^```(\w*)\s*$/);
      const lang = langMatch?.[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence
      const cls = lang ? ` class="lang-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      flushParagraph(paraBuf);
      const level = h[1]!.length;
      const text = h[2]!;
      const id = slugify(text);
      out.push(`<h${level} id="${id}"><a href="#${id}" class="anchor">#</a> ${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      flushParagraph(paraBuf);
      out.push("<hr>");
      i++;
      continue;
    }

    // Table — simple GFM. Detected by a header line + a separator like |---|---|
    if (/^\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
      flushParagraph(paraBuf);
      const headerCells = line.replace(/^\||\|$/g, "").split("|").map(s => s.trim());
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.replace(/^\||\|$/g, "").split("|").map(s => s.trim());
        rows.push(cells);
        i++;
      }
      const thead = "<thead><tr>" + headerCells.map(c => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead>";
      const tbody = "<tbody>" + rows.map(r => "<tr>" + r.map(c => `<td>${renderInline(c)}</td>`).join("") + "</tr>").join("") + "</tbody>";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Unordered list
    if (/^[\-\*]\s+/.test(line)) {
      flushParagraph(paraBuf);
      const items: string[] = [];
      while (i < lines.length && /^[\-\*]\s+/.test(lines[i]!)) {
        // Collect continuation lines (next line indented OR not empty/non-list)
        let item = lines[i]!.replace(/^[\-\*]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
          item += " " + lines[i]!.trim();
          i++;
        }
        items.push(`<li>${renderInline(item)}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph(paraBuf);
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\d+\.\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
          item += " " + lines[i]!.trim();
          i++;
        }
        items.push(`<li>${renderInline(item)}</li>`);
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line — paragraph boundary
    if (/^\s*$/.test(line)) {
      flushParagraph(paraBuf);
      i++;
      continue;
    }

    // Default — accumulate into a paragraph
    paraBuf.push(line);
    i++;
  }
  flushParagraph(paraBuf);

  return out.join("\n");
}

// Pre-parse the markdown for heading structure (H2 + nested H3) so we can
// render a sidebar nav alongside the body. We don't try to be clever about
// matching headings inside fenced code — we skip lines between ``` fences.
interface OutlineItem { level: 2 | 3; text: string; slug: string; }
function extractOutline(src: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inFence = false;
  for (const line of src.split("\n")) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1]!.length === 2 ? 2 : 3;
    const text = m[2]!.trim();
    out.push({ level, text, slug: slugify(text) });
  }
  return out;
}

function renderSidebarNav(outline: OutlineItem[]): string {
  const parts: string[] = [];
  parts.push(`<nav class="docs-nav" aria-label="Sections">`);
  parts.push(`<ul class="docs-nav-list">`);
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i]!;
    if (item.level === 2) {
      // Open a new H2 group; collect any following H3 items as a nested ul.
      const subs: OutlineItem[] = [];
      let j = i + 1;
      while (j < outline.length && outline[j]!.level === 3) {
        subs.push(outline[j]!);
        j++;
      }
      parts.push(`<li class="docs-nav-section">`);
      parts.push(`  <a class="docs-nav-link docs-nav-h2" data-slug="${item.slug}" data-text="${escapeHtml(item.text.toLowerCase())}" href="#${item.slug}">${escapeHtml(item.text)}</a>`);
      if (subs.length > 0) {
        parts.push(`  <ul class="docs-nav-sublist">`);
        for (const sub of subs) {
          parts.push(`    <li><a class="docs-nav-link docs-nav-h3" data-slug="${sub.slug}" data-text="${escapeHtml(sub.text.toLowerCase())}" href="#${sub.slug}">${escapeHtml(sub.text)}</a></li>`);
        }
        parts.push(`  </ul>`);
      }
      parts.push(`</li>`);
      i = j - 1; // skip the consumed H3s
    }
  }
  parts.push(`</ul></nav>`);
  return parts.join("\n");
}

function renderCheatsheetPage(): string {
  // Single-page cheat sheet — every CLI verb, shim, slash command, dashboard
  // action, and useful tmux shortcut grouped by category. Scannable, dense,
  // dark-themed to match the dashboard.
  const sections: Array<{ title: string; rows: Array<[string, string]> }> = [
    {
      title: "Master daemon (the conversational orchestrator)",
      rows: [
        ["subctl evy enable", "Install + load launchd plist (auto-starts at login)"],
        ["subctl evy disable", "Unload + remove the plist (state preserved)"],
        ["subctl evy status", "Daemon state, PID, uptime, supervisor model, tools loaded"],
        ["subctl evy logs [-f]", "Tail ~/Library/Logs/subctl/evy.log"],
        ["subctl evy prompt \"text\"", "Inject a one-shot prompt into the running daemon"],
        ["subctl evy restart", "disable + enable (full reload)"],
        ["subctl evy kick", "Force-recover when launchd is throttled (local TTY only)"],
        ["subctl evy providers", "cat ~/.config/subctl/evy/providers.json"],
        ["subctl evy policy", "cat ~/.config/subctl/evy/policy.json"],
        ["http://<host>:8787 → Chat tab", "Talk to master from the dashboard (SSE-streamed)"],
        ["Telegram bot", "Bidirectional — master auto-relays responses to the channel you used"],
      ],
    },
    {
      title: "Master personality presets (Phase 3k)",
      rows: [
        ["subctl evy personality list", "List all built-in presets with previews"],
        ["subctl evy personality show", "Print the currently-active preset"],
        ["subctl evy personality set <preset>", "Hot-swap voice — takes effect on next prompt"],
        ["Built-ins", "straight-shooter (default), witty, sarcastic, robotic, arnold, elon, hilarious"],
        ["Settings → Master personality", "Dashboard tile with dropdown + Apply"],
        ["~/.config/subctl/evy/personality.json", "Persisted state — single 'preset' key"],
      ],
    },
    {
      title: "Account management",
      rows: [
        ["subctl accounts", "Show all configured accounts + auth status"],
        ["subctl auth claude <alias>", "Run OAuth flow for one account"],
        ["subctl auth openai <alias>", "Codex OAuth (device-auth when SSH'd, browser otherwise)"],
        ["subctl auth all", "Auth every account that needs it"],
        ["subctl accounts add <provider> <alias> <email>", "Add a new account row to accounts.conf"],
        ["subctl accounts remove <alias> [--purge]", "Remove account; --purge also deletes the config dir"],
        ["subctl accounts edit", "Open accounts.conf in $EDITOR"],
      ],
    },
    {
      title: "Per-shell account switching",
      rows: [
        ["claude-use", "List accounts; show current"],
        ["claude-use jason", "Set CLAUDE_CONFIG_DIR for current shell (next claude uses jason)"],
        ["claude-use default", "Back to ~/.claude (unset)"],
        ["claude-<alias> (e.g. claude-personal, claude-work)", "One-off: run claude with that account, current command only"],
        ["claude-whoami", "Print which account this shell is using"],
      ],
    },
    {
      title: "Tmux team launcher",
      rows: [
        ["claude-teams -a <acct> -o -y", "Start orchestrator session, dangerous-skip-permissions"],
        ["claude-teams -a <acct> -c", "Continue most recent session for that account"],
        ["claude-teams -a <acct> --resume <sid>", "Resume a SPECIFIC session by id, in fresh tmux"],
        ["claude-teams -a <acct> -p \"text\"", "Send an initial prompt after the session boots"],
        ["claude-teams -a <acct> -f file.md", "Read initial prompt from a file"],
        ["subctl teams claude [opts]", "Explicit form (claude-teams is a shim for this)"],
      ],
    },
    {
      title: "Find + resume sessions",
      rows: [
        ["claude-resume", "Picker: lists every session for current cwd across all accounts"],
        ["claude-resume --latest", "Auto-resume newest, no prompt (claude --continue analog)"],
        ["claude-resume --account jason", "Picker filtered to one account"],
        ["claude-resume --cwd ~/code/holace --list", "Print candidates, don't resume"],
        ["subctl session-resume [opts]", "Same thing without the shim"],
      ],
    },
    {
      title: "Kill + cleanup",
      rows: [
        ["claude-kill <name>", "Kill one tmux session"],
        ["claude-kill <a> <b> <c>", "Kill multiple by name"],
        ["subctl prune --older-than 6h", "Kill tmux sessions older than 6h (asks before)"],
        ["subctl prune --older-than 24h --yes", "Skip confirmation"],
        ["subctl session-list", "List all tmux sessions enriched with account/ctx/branch"],
        ["subctl session-list --format json", "Machine-readable output"],
        ["subctl prune-transcripts", "Delete worker transcript JSONLs >30d (default safe)"],
        ["subctl prune-transcripts --dry-run", "Preview what would be deleted, no changes"],
        ["subctl prune-transcripts --older-than 7d --yes", "Aggressive: workers >7d, no prompt"],
        ["subctl prune-transcripts --all --older-than 90d", "Includes OPERATOR sessions older than 90d"],
        ["subctl prune-transcripts --archive ~/archive", "Move instead of delete"],
      ],
    },
    {
      title: "Rate-limit radar",
      rows: [
        ["claude-radar", "Print dispatch readiness verdict + signals"],
        ["subctl radar log", "Last 50 rate-limit events from the log"],
        ["subctl radar log --tail", "Follow the log in real time"],
        ["/dispatch-check", "Slash command inside any Claude Code session — same verdict"],
      ],
    },
    {
      title: "Web dashboard / service",
      rows: [
        ["claude-dash", "Open browser to http://127.0.0.1:8787 (starts service if needed)"],
        ["subctl service status", "Show service state (running / stopped / not installed)"],
        ["subctl service start | stop | restart", "Control the running service"],
        ["subctl service enable | disable", "Install/remove the launchd plist (auto-start at login)"],
        ["subctl service logs [N]", "Last N lines of stdout + stderr"],
        ["subctl service foreground", "Run dashboard in current shell (debug mode)"],
      ],
    },
    {
      title: "Document attachments in chat (Phase 3l)",
      rows: [
        ["📎 paperclip button (chat input)", "File picker — multi-select supported"],
        ["Drag-drop onto chat panel", "Auto-attaches dropped files; highlights drop zone"],
        ["Paste >4 KB into chat input", "Auto-converted to attachment with pill chip"],
        ["× on pill chip", "Remove an attachment before send"],
        ["Visible chat: 📎 filename instead of inline content", "Model still sees full inline content"],
        ["~/.config/subctl/evy/attachments/", "On-disk storage (date-bucketed) + index.jsonl"],
        ["master tool: read_attachment(id, range?)", "Re-fetch after auto-compaction"],
        ["master tool: list_attachments(filter?, limit?)", "Find an attachment id by filename substring"],
        ["Mime allowlist", "text/* + JSON/YAML/TOML/XML/script families; 5 MiB cap"],
      ],
    },
    {
      title: "Vault viewer (Phase 3n)",
      rows: [
        ["Sidebar → Vault", "In-page Obsidian-flavoured viewer"],
        ["Pick a vault from the dropdown", "Detects subdirs of vault_root with .obsidian/ or .md files"],
        ["Click any note in the tree", "Renders markdown with wikilinks + embeds + callouts + tags"],
        ["[[wikilink]] click", "Navigates to that note (case-insensitive last-segment fallback)"],
        ["![[image.png]]", "Inline image via /api/vault/<v>/asset"],
        ["> [!note] / [!warning] / [!danger]", "Styled callout blockquotes"],
        ["#tag in body", "Pill rendering (filterable in Phase 3q+)"],
        ["URL: /dashboard#vault?root=<v>&path=<rel>", "Deep-link to a specific note"],
        ["Projects tab → Open in Vault Viewer", "Routes to <project>/decisions.md inside master vault"],
        ["master tool: vault_link(note_path, root?)", "Returns the deep-link URL — drop in chat / Telegram"],
        ["master tool: vault_append(path, text)", "Append-only write (sandboxed to vault_root)"],
      ],
    },
    {
      title: "Multi-team camera view (Phase 3m)",
      rows: [
        ["Sidebar → Orchestration", "Top section is the camera grid"],
        ["Tiles auto-fit", "1 team = full row, 2 = side-by-side, 4 = 2x2, 9+ = scrolling 4x4"],
        ["Click tile", "Expand to full-pane view"],
        ["Esc / click backdrop / ✕", "Collapse back to grid"],
        ["Status pill: active/idle/stale/error/ended", "Green/gray/yellow/red/faded — colored left border too"],
        ["Polls /api/orchestration/captures every 2 s", "Tab-aware — stops when you switch away"],
        ["GET /api/orchestration/captures?lines=N", "Bulk capture endpoint for external integrations"],
      ],
    },
    {
      title: "Update + versioning",
      rows: [
        ["subctl update", "git fetch + ff-merge main + bun install + service bounce + doctor"],
        ["subctl update --force", "Stash dirty tree first (operator's WIP preserved)"],
        ["subctl update --branch <name>", "Update from a non-main branch"],
        ["subctl version", "version + git branch + short SHA + dirty flag + repo path"],
        ["VERSION file at repo root", "Single source of truth — bump it, commit, push"],
        ["docs/release-workflow.md", "Bump policy: patch default, minor for features, major for breaks"],
      ],
    },
    {
      title: "MCP server (Claude Code tools)",
      rows: [
        ["mcp__subctl__stats", "Live dashboard state — verdict, accounts, RL, savings"],
        ["mcp__subctl__orch_list", "List running orchestrator sessions"],
        ["mcp__subctl__orch_spawn", "Spawn a new orchestrator (typed inputs)"],
        ["mcp__subctl__orch_status / msg / kill", "Per-session control"],
        ["mcp__subctl__notify_send", "Fire-and-forget Telegram message"],
        ["mcp__subctl__notify_ask_yesno / ask_choice", "Structured Q&A — replies in inbox"],
        ["mcp__subctl__notify_inbox / inbox_ack", "Read + ack operator replies"],
        ["mcp__subctl__session_list", "Browse session JSONLs across accounts"],
        ["~/.claude/settings.json mcpServers.subctl", "Auto-registered by `subctl install`"],
        ["bun ~/code/subctl/components/mcp/server.ts", "Manual run for debugging"],
      ],
    },
    {
      title: "Skills catalog",
      rows: [
        ["subctl skills import <owner/repo>", "Pull skills from a github repo into ~/.config/subctl/skills/"],
        ["subctl skills list [--source <name>]", "List imported skills, optionally filtered by source"],
        ["subctl skills sources", "Show every imported source + skill count"],
        ["subctl skills info <source/path>", "Print one skill's frontmatter + first lines"],
        ["subctl skills remove <source/path>", "Remove from catalog (asks before)"],
        ["components/skills/subctl/SKILL.md", "Baseline skill shipped to every Claude cfg_dir at install"],
        ["components/skills/autonomy/SKILL.md", "Autonomy doctrine — applies when CLAUDE_AUTONOMY=full"],
        ["components/skills/orchestrator-mode/SKILL.md", "Anti-deadlock activation guard for workers"],
        ["~/.claude*/skills/<name>/SKILL.md", "Per-account symlink (created by subctl install)"],
      ],
    },
    {
      title: "Team templates",
      rows: [
        ["subctl templates list", "List saved team templates"],
        ["subctl templates show <name>", "Print one template's JSON"],
        ["subctl templates create <name>", "Wizard for new template"],
        ["subctl templates duplicate <src> <dst>", "Clone an existing template under a new name"],
        ["subctl templates delete <name>", "Delete (asks before)"],
        ["~/.config/subctl/teams/<name>.json", "Template manifests on disk"],
        ["subctl_orch_spawn_template (master tool)", "Spawn worker using a saved template"],
        ["subctl teams claude -t <template>", "Spawn directly with template via CLI"],
        ["Dashboard → Teams tab", "Visual template CRUD"],
      ],
    },
    {
      title: "Plugin system",
      rows: [
        ["subctl plugins list", "List installed plugins under ~/.config/subctl/plugins/"],
        ["subctl plugins install <git-url|owner/repo|path>", "Clone + validate manifest + activate"],
        ["subctl plugins remove <id>", "Uninstall"],
        ["subctl plugins show <id>", "Print manifest + file tree"],
        ["subctl plugins status", "Validate every plugin's manifest"],
        ["subctl.plugin.json", "Required at plugin root: id, kind, configSchema, tools/skills/tabs/verbs"],
        ["kind: tool | skill-pack | dashboard-tab | cli-verb", "Plugin types"],
      ],
    },
    {
      title: "Orchestration control plane",
      rows: [
        ["subctl orch list", "List running orchestrator tmux sessions"],
        ["subctl orch spawn -a <acct> -c <path> [-o] [-y] [-p text]", "Spawn detached orchestrator session"],
        ["subctl orch status <name>", "Live preview + panes for one session"],
        ["subctl orch msg <name> <text>", "Inject text into a session's pane"],
        ["subctl orch kill <name>", "Kill a session"],
        ["POST /api/orchestration/spawn", "HTTP API for external controllers (ArgentOS, scripts, MCP)"],
        ["GET  /api/orchestration", "List active orchestrator sessions"],
        ["GET  /api/orchestration/:name", "Status JSON for one session"],
        ["POST /api/orchestration/:name/msg", "Inject text"],
        ["POST /api/orchestration/:name/kill", "Kill"],
        ["/sessions (in Telegram)", "List sessions from your phone"],
        ["/msg <name> <text> (in Telegram)", "Send text to a session"],
        ["/kill <name> (in Telegram)", "Kill a session"],
      ],
    },
    {
      title: "Autonomy + escalation",
      rows: [
        ["subctl notify <message>", "Fire-and-forget Telegram message"],
        ["subctl notify --setup", "Store bot token + chat id (one-time)"],
        ["subctl notify --diagnose", "Passive bot health check (no live ping)"],
        ["subctl notify --diagnose --send", "Same checks + send a real test message"],
        ["subctl notify --test", "Send just the test message"],
        ["subctl notify ask-yesno \"q\" --id Q42", "Send Yes/No buttons — reply lands in inbox"],
        ["subctl notify ask-choice \"q\" -o A:label -o B:label", "Multi-button (2-8 options)"],
        ["subctl notify ask-text \"q\" --id Q42", "Force-reply prompt for free-form text"],
        ["subctl notify ... --wait --timeout 30m --default C", "Block until reply or fall back to default"],
        ["subctl notify inbox [--id Q42] [--unacked]", "Show inbox entries (operator replies)"],
        ["subctl notify inbox-ack Q42", "Mark a question's reply as consumed"],
        ["/stats (in Telegram)", "Bot command — verdict + accounts + 5h%/week% + RL + savings"],
        ["/help, /inbox (in Telegram)", "More bot commands"],
        ["CLAUDE_AUTONOMY=full", "Env var set by subctl install — triggers autonomy doctrine"],
        ["~/.claude/skills/autonomy/SKILL.md", "Doctrine: drive-forward, ask-protocol, mem+vault required"],
      ],
    },
    {
      title: "Setup + reconfigure",
      rows: [
        ["subctl setup", "TUI menu — pick a stage to (re)configure"],
        ["subctl setup --wizard", "Linear walk: deps → existing config → accounts → auth → service"],
        ["subctl setup --reconfigure", "Backup current accounts.conf, then run wizard fresh"],
        ["subctl setup --auth-only", "Walk OAuth for accounts that aren't authenticated yet"],
        ["subctl setup --service-only", "Just the dashboard-service prompt"],
        ["subctl setup --check", "Pre-flight only — what's installed, what's missing"],
      ],
    },
    {
      title: "Health + config",
      rows: [
        ["subctl doctor", "Full health check: tools, settings, integrations, accounts"],
        ["subctl whoami", "Current shell's CLAUDE_CONFIG_DIR resolved to alias"],
        ["subctl config show", "Print accounts.conf"],
        ["subctl config edit", "Open accounts.conf"],
        ["subctl config path", "Just the path"],
        ["subctl version", "Print version"],
        ["subctl install [--migrate]", "Re-install / re-link shims / regenerate aliases"],
        ["subctl uninstall", "Remove subctl; restores backup of settings.json"],
      ],
    },
    {
      title: "Web dashboard sidebar tabs",
      rows: [
        ["Chat", "Conversational front door to subctl evy — SSE-streamed, attachments, personality picker via Settings"],
        ["Orchestration", "Camera grid (every dev-team tmux pane) + Active Dev Teams + Watchdog + Live Activity + Diagnostics"],
        ["Dashboard", "Verdict + accounts + active tmux + active conversations + cost + util + RL events"],
        ["Projects", "~/code scan + policy state + per-project chat + Open in Vault Viewer + Spawn dev team"],
        ["Teams", "Team template CRUD with skills picker"],
        ["Claude Sessions", "Search every session across all accounts; copy resume cmd or open in iTerm"],
        ["Models", "LM Studio catalog + load state + context length"],
        ["Providers", "Profile CRUD + supervisor switch (only wired providers selectable)"],
        ["Memory", "Tier-1 user.md + memory.md editors + claude-mem health + Obsidian vault status"],
        ["Vault", "In-page Obsidian viewer — tree + rendered note + wikilink navigation"],
        ["Skills", "3-pane catalog browser with import modal"],
        ["Live Logs", "SSE-streamed tail of master / dashboard / launchd logs"],
        ["Settings", "Health checks + Master personality picker + Telegram + API keys + OAuth + Obsidian config"],
      ],
    },
    {
      title: "Web dashboard interactions",
      rows: [
        ["Hover session row in Sessions", "Loads first user-message preview lazily"],
        ["[copy] on a session row", "Puts CLAUDE_CONFIG_DIR=… claude --resume <sid> on clipboard"],
        ["[open in iTerm]", "Spawns a new iTerm window pre-running the resume cmd (macOS)"],
        ["Click any session row", "Expands to show last 3 lines of that pane"],
        ["⟳ button (top-right)", "Force-refresh /api/oauth/usage (bypasses 5min cache)"],
        ["View on a dev-team row", "Letterboxed tmux preview modal"],
        ["Attach on a dev-team row", "Copies the SSH attach command"],
        ["Kill on a dev-team row", "Asks before sending tmux kill-session"],
        ["Click Foothold game card (downtimearena.com/arcade.html)", "Opens retro-style game modal"],
      ],
    },
    {
      title: "Useful tmux shortcuts",
      rows: [
        ["Ctrl-b d", "Detach from current tmux session (returns to outer shell)"],
        ["Ctrl-b w", "Pick a window across sessions"],
        ["Ctrl-b s", "Pick a session"],
        ["Ctrl-b , (comma)", "Rename current window"],
        ["Ctrl-b $", "Rename current session"],
        ["tmux attach -t <name>", "Attach to a session by name (outside tmux)"],
        ["tmux switch-client -t <name>", "Switch to another session (inside tmux)"],
        ["tmux kill-server", "Nuclear — kill ALL sessions (use sparingly)"],
      ],
    },
    {
      title: "Inside Claude Code",
      rows: [
        ["/dispatch-check", "Pre-dispatch radar verdict"],
        ["/help", "Built-in command reference"],
        ["/clear", "Reset conversation context"],
        ["/exit", "Leave the session"],
        ["/usage", "Show your subscription usage / quota"],
        ["/compact", "Compress conversation history"],
      ],
    },
  ];

  let body = "";
  // TOC
  body += '<nav class="cheat-toc"><ul>';
  for (const s of sections) {
    const id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    body += `<li><a href="#${id}">${escapeHtml(s.title)}</a></li>`;
  }
  body += "</ul></nav>";

  // Sections
  for (const s of sections) {
    const id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    body += `<section class="cheat-section" id="${id}"><h2>${escapeHtml(s.title)}</h2><table class="cheat-table"><tbody>`;
    for (const [cmd, desc] of s.rows) {
      body += `<tr><td class="cheat-cmd"><code>${escapeHtml(cmd)}</code></td><td class="cheat-desc">${escapeHtml(desc)}</td></tr>`;
    }
    body += "</tbody></table></section>";
  }

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>subctl cheat sheet</title>
<link rel="stylesheet" href="/style.css">
<style>
  body { background: #0a0a0a; color: #c4c4c4; font-family: ui-monospace, "SF Mono", Menlo, monospace; padding: 24px; max-width: 1100px; margin: 0 auto; }
  .cheat-header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid #1f1f1f; padding-bottom: 12px; margin-bottom: 24px; }
  .cheat-header h1 { margin: 0; font-size: 22px; color: #ffffff; letter-spacing: 0.04em; }
  .cheat-header a { color: #5fd7ff; text-decoration: none; font-size: 13px; }
  .cheat-header a:hover { text-decoration: underline; }
  .cheat-toc { background: #0f0f0f; border: 1px solid #1f1f1f; border-radius: 4px; padding: 12px 16px; margin-bottom: 28px; }
  .cheat-toc ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
  .cheat-toc a { color: #9c9c9c; text-decoration: none; font-size: 12px; }
  .cheat-toc a:hover { color: #5fd7ff; }
  .cheat-section { margin-bottom: 32px; }
  .cheat-section h2 { color: #ffffff; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; border-bottom: 1px solid #1a1a1a; padding-bottom: 6px; margin: 0 0 10px; }
  .cheat-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .cheat-table tr { border-bottom: 1px solid #141414; }
  .cheat-table tr:last-child { border-bottom: none; }
  .cheat-table td { padding: 7px 10px; vertical-align: top; }
  .cheat-cmd { width: 42%; }
  .cheat-cmd code { background: #161616; padding: 2px 8px; border-radius: 3px; color: #5fd7ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: 100%; }
  .cheat-desc { color: #9c9c9c; }
</style>
</head><body>
<div class="cheat-header">
  <h1>subctl cheat sheet</h1>
  <div><a href="/">← dashboard</a> &nbsp; <a href="/help">full docs →</a></div>
</div>
${body}
</body></html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderHelpPage(): string {
  let md: string;
  try { md = readFileSync(HELP_MD_PATH, "utf8"); }
  catch { return `<!doctype html><meta charset="utf-8"><title>help</title><pre>help.md not found at ${HELP_MD_PATH}</pre>`; }

  const body = renderMarkdown(md);
  const outline = extractOutline(md);
  const nav = renderSidebarNav(outline);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>subctl · docs</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="docs-body">
  <header class="docs-topbar">
    <div class="docs-topbar-brand">
      <a href="/" class="brand-name">subctl</a>
      <span class="brand-version">v${readSubctlVersion()}</span>
      <span class="docs-crumb">docs</span>
    </div>
    <div class="docs-topbar-right">
      <a href="/" class="docs-back-link">← back to dashboard</a>
    </div>
  </header>
  <div class="docs-shell">
    <aside class="docs-sidebar" id="docs-sidebar">
      <div class="docs-search">
        <input type="search" id="docs-search-input" placeholder="Search docs (⌘K)" autocomplete="off" spellcheck="false">
      </div>
      ${nav}
    </aside>
    <main class="docs-content">
      <article class="help-doc" id="docs-article">
        ${body}
      </article>
      <footer class="docs-footer">
        <a href="/">← dashboard</a>
        <span class="sep">·</span>
        <a href="https://github.com/webdevtodayjason/subctl" target="_blank" rel="noopener">github</a>
        <span class="sep">·</span>
        <span>subctl v${readSubctlVersion()}</span>
      </footer>
    </main>
  </div>
  <script>
  (function () {
    "use strict";
    var input = document.getElementById("docs-search-input");
    var navLinks = Array.prototype.slice.call(document.querySelectorAll(".docs-nav-link"));
    var navItems = Array.prototype.slice.call(document.querySelectorAll(".docs-nav-section"));

    // ⌘K / Ctrl+K focuses the search.
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (input) input.focus();
      } else if (e.key === "Escape" && document.activeElement === input) {
        input.value = "";
        applyFilter("");
        input.blur();
      }
    });

    function applyFilter(q) {
      q = (q || "").trim().toLowerCase();
      if (!q) {
        navItems.forEach(function (el) { el.style.display = ""; });
        navLinks.forEach(function (el) {
          el.style.display = "";
          el.classList.remove("docs-search-hit");
        });
        return;
      }
      // Hide H2 groups whose H2 text and all nested H3s don't match.
      navItems.forEach(function (section) {
        var links = Array.prototype.slice.call(section.querySelectorAll(".docs-nav-link"));
        var anyMatch = false;
        links.forEach(function (link) {
          var hay = link.dataset.text || link.textContent.toLowerCase();
          var match = hay.indexOf(q) !== -1;
          link.style.display = match ? "" : "none";
          link.classList.toggle("docs-search-hit", match);
          if (match) anyMatch = true;
        });
        section.style.display = anyMatch ? "" : "none";
      });
    }

    if (input) input.addEventListener("input", function () { applyFilter(input.value); });

    // Active-section highlight via IntersectionObserver.
    var sections = Array.prototype.slice.call(document.querySelectorAll("h2[id], h3[id]"));
    var byId = {};
    navLinks.forEach(function (l) { byId[l.dataset.slug] = l; });
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target.id);
        else                  visible.delete(e.target.id);
      });
      // Choose topmost visible heading as "active".
      var active = null;
      for (var i = 0; i < sections.length; i++) {
        if (visible.has(sections[i].id)) { active = sections[i].id; break; }
      }
      navLinks.forEach(function (l) { l.classList.remove("docs-nav-active"); });
      if (active && byId[active]) byId[active].classList.add("docs-nav-active");
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  })();
  </script>
</body>
</html>`;
}

// ---------- WebSocket fan-out ----------

const sockets = new Set<any>();
// v2.7.21 (ADR 0011 Layer 2): per-socket PtyBridge map for /api/terminal/attach
// WebSockets. Lives alongside `sockets` (which tracks the /api/live state-push
// fan-out) so we can route close/message events back through the right bridge.
// Each entry is created in the websocket.open handler when the ws.data marks
// it as a terminal session, and disposed in close.
const ptyBridges = new Map<any, PtyBridge>();
let pushTimer: ReturnType<typeof setInterval> | null = null;

function startPushLoop() {
  if (pushTimer) return;
  pushTimer = setInterval(() => {
    if (sockets.size === 0) return;
    const payload = JSON.stringify(buildState());
    for (const ws of sockets) {
      try { ws.send(payload); } catch { /* drop, will be cleaned up on close */ }
    }
  }, 2000);
}

// ---------- notify listener (Telegram poll loop, in-process) ----------
//
// Loads only when ~/.config/subctl/notify.json exists. Bundles into the
// dashboard's Bun process: same lifecycle, single restart point. Bot
// command /stats reads buildState() directly for live data.

import {
  startNotifyListener,
  notifyListenerStatus,
  readInbox,
  ackInboxEntry,
  injectExternalReply,
} from "./notify-listener";
import {
  getPendingAsk,
  listPendingAsks,
} from "../components/evy/asks-pending";

const _listener = startNotifyListener({ stateProvider: buildState });
if (_listener.running) {
  console.log("[server] notify-listener started");
} else if (_listener.reason) {
  console.log(`[server] notify-listener not started: ${_listener.reason}`);
}

// ---------- server ----------

// Default to localhost-only — safer for fresh installs. Opt in to LAN
// exposure via SUBCTL_DASHBOARD_HOST=0.0.0.0 (or a specific interface IP)
// in the launchd plist or shell env. The dashboard is a control plane
// (spawns/kills orchestrators), so binding to 0.0.0.0 should be a
// deliberate choice on a trusted network.
const HOSTNAME = process.env.SUBCTL_DASHBOARD_HOST || "127.0.0.1";

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  // SSE pass-through (/api/master/events) and our own WebSocket (/api/live)
  // are long-lived. The default 10s idleTimeout was killing them every 10s,
  // making the chat connection pill flash CONNECTED↔RECONNECTING forever.
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/live") {
      if (srv.upgrade(req)) return undefined as any;
      return new Response("Upgrade failed", { status: 400 });
    }

    // ── /api/terminal/* — web terminal escape hatch (v2.7.21, ADR 0011 L2)
    //
    // /api/terminal/enabled  GET  → { enabled, flag_path }   (always 200)
    // /api/terminal/teams    GET  → { teams: [...] }         (403 when disabled)
    // /api/terminal/attach   WS   tmux-attach proxy          (403 when disabled,
    //                                                          400 bad team,
    //                                                          404 no session)
    //
    // The enabled-check is a flag file existence check at
    // ~/.config/subctl/terminal.enabled — default OFF. See terminal.ts.
    if (url.pathname === "/api/terminal/enabled" && req.method === "GET") {
      return handleTerminalEnabled();
    }
    if (url.pathname === "/api/terminal/teams" && req.method === "GET") {
      return handleTerminalTeams();
    }
    if (url.pathname === "/api/terminal/attach") {
      const decision = evaluateTerminalUpgrade({ req, url, bindHost: HOSTNAME });
      if (!decision.ok) {
        return new Response(JSON.stringify({ ok: false, error: decision.reason ?? "denied" }), {
          status: decision.status ?? 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      const cols = Math.max(2, Math.min(500, parseInt(url.searchParams.get("cols") ?? "80", 10)));
      const rows = Math.max(2, Math.min(500, parseInt(url.searchParams.get("rows") ?? "24", 10)));
      // ws.data lets us identify "this WS is a terminal session" in the
      // websocket.open/message/close hooks below — separate from the
      // /api/live fan-out path.
      const upgraded = srv.upgrade(req, {
        data: { kind: "terminal", session: decision.session!, cols, rows },
      });
      if (upgraded) return undefined as any;
      return new Response("Upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api/state") {
      return new Response(JSON.stringify(buildState()), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // ── /api/host — local host identity for dashboard labels ────────────────
    // Frontend calls this once on boot to delabel every "M3 Ultra" mention
    // baked into the static UI. Operator can override the label by writing a
    // one-line text file at ~/.config/subctl/host_label (e.g. "Jason's Studio").
    // Otherwise we use the short hostname (everything before the first ".").
    if (url.pathname === "/api/host" && req.method === "GET") {
      const userLabelPath = join(SUBCTL_CONFIG_DIR, "host_label");
      let userLabel: string | null = null;
      try {
        if (existsSync(userLabelPath)) {
          const raw = readFileSync(userLabelPath, "utf8").trim();
          userLabel = raw.length > 0 ? raw : null;
        }
      } catch { /* ignore unreadable file */ }
      const hostname = osHostname();
      const shortHostname = hostname.split(".")[0] || hostname;
      return Response.json({
        ok: true,
        hostname,
        short_hostname: shortHostname,
        user_label: userLabel ?? shortHostname,
      });
    }

    // ── /api/models — LM Studio model catalog (native API, richer than /v1) ──
    // Error shape (when ok:false):
    //   kind:    "missing_token" | "invalid_token" | "unreachable" | "http_error"
    //   error:   short label (back-compat — UI may still read this)
    //   message: human-language sentence the dashboard renders directly
    //   hint:    one-line "what to do" pointer
    //   host:    LM Studio base URL we tried
    if (url.pathname === "/api/models") {
      const host = process.env.SUBCTL_LMSTUDIO_HOST ?? "http://localhost:1234";
      const token = resolveSecret("lmstudio_api_token");
      try {
        // v2.8.7 — getLmstudioModels caches successful responses for
        // 30s and coalesces concurrent in-flight requests. Error
        // shapes below are preserved; only successful upstream JSON
        // gets cached.
        const j = await getLmstudioModels(host);
        const models = j.data ?? [];
        return Response.json({
          ok: true,
          host,
          ts: new Date().toISOString(),
          total: models.length,
          loaded_count: models.filter((m) => m.state === "loaded").length,
          models,
        });
      } catch (err) {
        const status = (err as LmstudioFetchError).status;
        if (status === 401) {
          // LM Studio is requiring an API token. Either we sent nothing
          // (missing) or we sent something that LM Studio rejected
          // (invalid).
          if (!token) {
            return Response.json({
              ok: false,
              kind: "missing_token",
              error: "missing token",
              message: "LM Studio is requiring an API token, but subctl doesn't have one configured.",
              hint: "Either paste the current token into Settings → API Tokens, or turn off \"Require API Token\" in LM Studio (Developer → Server settings).",
              host,
            }, { status: 401 });
          }
          return Response.json({
            ok: false,
            kind: "invalid_token",
            error: "token rejected",
            message: "LM Studio rejected the saved API token. It's likely stale — the token in LM Studio was rotated or cleared.",
            hint: "Rotate the token in LM Studio (Developer → Server settings), then paste the new value into Settings → API Tokens. Or turn off \"Require API Token\" if you don't need it.",
            host,
          }, { status: 401 });
        }
        if (status !== undefined) {
          return Response.json({
            ok: false,
            kind: "http_error",
            error: `HTTP ${status}`,
            message: `LM Studio returned HTTP ${status} from /api/v0/models.`,
            hint: "Check the LM Studio app's server logs for the underlying error.",
            host,
          }, { status: 502 });
        }
        // fetch threw — almost always a network/connection issue
        // (LM Studio not running, host unreachable, port closed, DNS).
        return Response.json({
          ok: false,
          kind: "unreachable",
          error: (err as Error).message,
          message: `LM Studio at ${host} didn't respond.`,
          hint: "Make sure the LM Studio app is running and the server is started (Developer → Start Server). If you bound it to 127.0.0.1, confirm subctl is on the same host.",
          host,
        }, { status: 502 });
      }
    }

    // ── /api/models/refresh — force-bust the 30s cache and re-fetch
    // upstream. Used by the "Refresh" buttons in the Models tab and
    // chat-model-selector. Returns the same shape /api/models would
    // return on success/failure so the UI can swap a normal fetch for
    // this one when the operator clicks Refresh.
    if (url.pathname === "/api/models/refresh" && req.method === "POST") {
      const host = process.env.SUBCTL_LMSTUDIO_HOST ?? "http://localhost:1234";
      const token = resolveSecret("lmstudio_api_token");
      try {
        const j = await getLmstudioModels(host, true);
        const models = j.data ?? [];
        return Response.json({
          ok: true,
          host,
          ts: new Date().toISOString(),
          refreshed: true,
          total: models.length,
          loaded_count: models.filter((m) => m.state === "loaded").length,
          models,
        });
      } catch (err) {
        const status = (err as LmstudioFetchError).status;
        if (status === 401) {
          if (!token) {
            return Response.json({
              ok: false,
              kind: "missing_token",
              error: "missing token",
              message: "LM Studio is requiring an API token, but subctl doesn't have one configured.",
              hint: "Either paste the current token into Settings → API Tokens, or turn off \"Require API Token\" in LM Studio (Developer → Server settings).",
              host,
            }, { status: 401 });
          }
          return Response.json({
            ok: false,
            kind: "invalid_token",
            error: "token rejected",
            message: "LM Studio rejected the saved API token. It's likely stale.",
            hint: "Rotate the token in LM Studio and update Settings → API Tokens, or turn off \"Require API Token\".",
            host,
          }, { status: 401 });
        }
        if (status !== undefined) {
          return Response.json({
            ok: false,
            kind: "http_error",
            error: `HTTP ${status}`,
            message: `LM Studio returned HTTP ${status} from /api/v0/models.`,
            hint: "Check the LM Studio app's server logs for the underlying error.",
            host,
          }, { status: 502 });
        }
        return Response.json({
          ok: false,
          kind: "unreachable",
          error: (err as Error).message,
          message: `LM Studio at ${host} didn't respond.`,
          hint: "Make sure the LM Studio app is running and the server is started.",
          host,
        }, { status: 502 });
      }
    }

    // ── /api/projects — scan ~/code, mark which are in policy.json ──
    if (url.pathname === "/api/projects") {
      const codeRoot = process.env.SUBCTL_CODE_ROOT ?? `${process.env.HOME}/code`;
      let policyProjects: Array<{ path: string; autonomy_level?: string }> = [];
      try {
        const policyPath = join(SUBCTL_CONFIG_DIR, "evy", "policy.json");
        if (existsSync(policyPath)) {
          const raw = readFileSync(policyPath, "utf8");
          const stripped = raw.split("\n").filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
          const policy = JSON.parse(stripped) as { projects?: Array<{ path: string; autonomy_level?: string }> };
          policyProjects = policy.projects ?? [];
        }
      } catch { /* ignore parse errors */ }
      const policyByPath = new Map<string, string>();
      for (const p of policyProjects) {
        const expanded = p.path.replace(/^~/, process.env.HOME ?? "");
        policyByPath.set(expanded, p.autonomy_level ?? "unknown");
      }

      let dirs: string[] = [];
      try {
        if (existsSync(codeRoot)) {
          dirs = readdirSync(codeRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .map((d) => join(codeRoot, d.name));
        }
      } catch { /* ignore */ }

      const projects = dirs.map((path) => {
        const name = path.split("/").pop() ?? path;
        const lastCommit = (() => {
          try {
            const r = spawnSync("git", ["-C", path, "log", "-1", "--format=%h %s (%cr)"], { encoding: "utf8", timeout: 1500 });
            return r.status === 0 ? r.stdout.trim() : null;
          } catch { return null; }
        })();
        const branch = (() => {
          try {
            const r = spawnSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 1000 });
            return r.status === 0 ? r.stdout.trim() : null;
          } catch { return null; }
        })();
        const has = (rel: string) => existsSync(join(path, rel));
        return {
          name,
          path,
          branch,
          last_commit: lastCommit,
          has_claude_md: has("CLAUDE.md"),
          has_package_json: has("package.json"),
          has_pyproject: has("pyproject.toml") || has("requirements.txt"),
          has_readme: has("README.md") || has("README"),
          in_policy: policyByPath.has(path),
          autonomy_level: policyByPath.get(path) ?? null,
        };
      });
      return Response.json({ ok: true, code_root: codeRoot, projects });
    }

    // ── Logs: streaming tail of master + dashboard launchd logs ──────────
    // GET /api/logs/sources    list available log files with size + mtime
    // GET /api/logs/<id>?tail=N return last N lines of one log
    // GET /api/logs/<id>/stream SSE: tail -f equivalent
    if (url.pathname === "/api/logs/sources" && req.method === "GET") {
      const home = process.env.HOME ?? "";
      const logsDir = `${home}/Library/Logs/subctl`;
      const sources = [
        { id: "master",        path: `${logsDir}/evy.log`,         label: "master daemon (com.subctl.evy)" },
        { id: "dashboard-out", path: `${logsDir}/dashboard.out.log`,  label: "dashboard stdout (com.subctl.dashboard)" },
        { id: "dashboard-err", path: `${logsDir}/dashboard.err.log`,  label: "dashboard stderr" },
        { id: "decisions",     path: `${home}/.config/subctl/evy/decisions.jsonl`, label: "Evy decisions log (JSONL)" },
      ];
      const enriched = sources.map((s) => {
        try {
          const { statSync } = require("node:fs") as typeof import("node:fs");
          const st = statSync(s.path);
          return { ...s, exists: true, size: st.size, mtime: st.mtimeMs };
        } catch {
          return { ...s, exists: false, size: 0, mtime: 0 };
        }
      });
      return Response.json({ ok: true, sources: enriched });
    }

    {
      const m = url.pathname.match(/^\/api\/logs\/([\w-]+)(?:\/stream)?$/);
      if (m) {
        const id = m[1]!;
        const isStream = url.pathname.endsWith("/stream");
        const home = process.env.HOME ?? "";
        const map: Record<string, string> = {
          "master":         `${home}/Library/Logs/subctl/evy.log`,
          "dashboard-out":  `${home}/Library/Logs/subctl/dashboard.out.log`,
          "dashboard-err":  `${home}/Library/Logs/subctl/dashboard.err.log`,
          "decisions":      `${home}/.config/subctl/evy/decisions.jsonl`,
        };
        const path = map[id];
        if (!path) return Response.json({ ok: false, error: "unknown log id" }, { status: 404 });
        if (!existsSync(path)) return Response.json({ ok: false, error: "log file does not exist", path }, { status: 404 });

        if (req.method === "GET" && !isStream) {
          const tailN = Math.max(1, Math.min(2000, Number(url.searchParams.get("tail") ?? "200")));
          try {
            const raw = readFileSync(path, "utf8");
            const lines = raw.split("\n");
            const slice = lines.slice(-tailN);
            const { statSync } = require("node:fs") as typeof import("node:fs");
            const st = statSync(path);
            return Response.json({
              ok: true,
              path,
              size: st.size,
              mtime: st.mtimeMs,
              total_lines: lines.length,
              returned: slice.length,
              lines: slice,
            });
          } catch (err) {
            return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
          }
        }

        if (req.method === "GET" && isStream) {
          // Stream new appended bytes via SSE. Polls the file's size every
          // 700ms and emits any newly-appended chunk as line events. Not
          // as efficient as fs.watch but works around the unreliable
          // FSEvents behavior on macOS for log files written by launchd-
          // managed processes.
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const { statSync, openSync, readSync, closeSync } = require("node:fs") as typeof import("node:fs");
              let lastSize = 0;
              try { lastSize = statSync(path).size; } catch { lastSize = 0; }
              const send = (event: string, data: unknown) => {
                try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
                catch { /* client gone */ }
              };
              // Initial: send the last 200 lines so the UI doesn't start empty
              try {
                const raw = readFileSync(path, "utf8");
                const lines = raw.split("\n");
                const last200 = lines.slice(-200);
                send("snapshot", { lines: last200, total_lines: lines.length });
              } catch { /* no-op */ }
              const tick = () => {
                let curSize = 0;
                try { curSize = statSync(path).size; } catch { return; }
                if (curSize === lastSize) return;
                if (curSize < lastSize) {
                  // file truncated/rotated — re-emit a fresh snapshot
                  try {
                    const raw = readFileSync(path, "utf8");
                    const lines = raw.split("\n");
                    send("snapshot", { lines: lines.slice(-200), total_lines: lines.length });
                  } catch { /* no-op */ }
                  lastSize = curSize;
                  return;
                }
                try {
                  const fd = openSync(path, "r");
                  const buf = Buffer.alloc(curSize - lastSize);
                  readSync(fd, buf, 0, buf.length, lastSize);
                  closeSync(fd);
                  const newLines = buf.toString("utf8").split("\n").filter((l) => l.length);
                  if (newLines.length) send("append", { lines: newLines });
                  lastSize = curSize;
                } catch { /* fs errored, retry next tick */ }
              };
              const ticker = setInterval(tick, 700);
              const ka = setInterval(() => {
                try { controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`)); } catch { clearInterval(ka); }
              }, 25_000);
              (controller as any)._cleanup = () => {
                clearInterval(ticker);
                clearInterval(ka);
              };
              req.signal?.addEventListener("abort", () => {
                const c = (controller as any)._cleanup; if (c) c();
                try { controller.close(); } catch {}
              });
            },
            cancel() {
              const c = (this as any)._cleanup; if (c) c();
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
      }
    }

    // ── Policy audit endpoints (PR 11, v2.7.0) ─────────────────────────
    //
    // Pack 09 §6 specifies the surface. Three list endpoints + one SSE stream.
    // Path resolution honors SUBCTL_STATE_DIR via the audit-api module.
    //
    //   GET /api/audit/<team>?tail=N&since=DUR&decision=allow|deny&filter=...
    //   GET /api/audit/<team>/stream     ← SSE (server-side file tail)
    //   GET /api/audit/aggregate         ← cross-team grouping for Policy tab
    //   GET /api/policy/teams            ← per-team mode/preset/allowlist_sha
    //   GET /api/policy/list?project_root=<dir>   ← resolved policy JSON
    //   POST /api/policy/allowlist/apply ← optional "Apply" path; copy-only for v2.7.0
    //
    if (url.pathname === "/api/audit/aggregate" && req.method === "GET") {
      return handleAuditAggregate(url.searchParams);
    }
    if (url.pathname === "/api/policy/teams" && req.method === "GET") {
      return handlePolicyTeams();
    }
    if (url.pathname === "/api/policy/list" && req.method === "GET") {
      const projectRoot = url.searchParams.get("project_root") ?? "";
      if (!projectRoot || !projectRoot.startsWith("/")) {
        return Response.json(
          { ok: false, error: "project_root must be an absolute path" },
          { status: 400 },
        );
      }
      // Guard against shell-relative tricks; the resolver will read files
      // inside this dir + global locations, so we want the path canonicalized.
      try {
        const policy = await loadResolvedPolicy(projectRoot);
        return Response.json({
          ok: true,
          project_root: projectRoot,
          preset: policy.preset ?? null,
          default_mode: policy.default_mode ?? "gated",
          source_paths: policy.__meta?.sourcePaths ?? [],
          allowlist_sha: policy.__meta?.allowlistSha ?? "",
          resolved_at: policy.__meta?.resolvedAt ?? null,
          mode: {
            gated: policy.mode?.gated ?? null,
            sealed: policy.mode?.sealed ?? null,
          },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }
    {
      const m = url.pathname.match(/^\/api\/audit\/([A-Za-z0-9_-]+)(\/stream)?\/?$/);
      if (m && req.method === "GET") {
        const teamId = m[1]!;
        const isStream = !!m[2];
        if (!isValidTeamId(teamId)) {
          return Response.json({ ok: false, error: "invalid team_id" }, { status: 400 });
        }
        if (!isStream) {
          return handleAuditList(teamId, url.searchParams);
        }
        // ── SSE stream ──────────────────────────────────────────────────
        // Mirrors the /api/logs/<id>/stream pattern above: polls statSync()
        // for size growth and emits new JSONL lines as SSE `audit` events.
        // We deliberately do NOT inotify/fsevents — that's been unreliable
        // for files written by launchd-managed processes on macOS. 700ms
        // poll matches the logs tab and is plenty for a UI tail.
        const path = getAuditPath(teamId);
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (event: string, data: unknown) => {
              try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
              catch { /* client gone */ }
            };
            let lastSize = 0;
            try { lastSize = existsSync(path) ? statSync(path).size : 0; } catch { lastSize = 0; }
            // Initial snapshot: send the most recent tail (50 entries) so
            // the UI doesn't start empty.
            try {
              const initial = handleAuditList(teamId, new URLSearchParams("tail=50"));
              initial.json().then((j) => {
                if (j && j.ok) send("snapshot", { entries: j.entries });
              }).catch(() => { /* ignore */ });
            } catch { /* ignore */ }

            const tick = () => {
              try {
                const r = readNewAuditEntries(path, lastSize);
                if (r.truncated) {
                  // file rotated underneath us — re-snapshot
                  try {
                    const after = handleAuditList(teamId, new URLSearchParams("tail=50"));
                    after.json().then((j) => {
                      if (j && j.ok) send("snapshot", { entries: j.entries });
                    }).catch(() => { /* ignore */ });
                  } catch { /* ignore */ }
                  lastSize = r.size;
                  return;
                }
                if (r.entries.length > 0) {
                  send("append", { entries: r.entries });
                }
                lastSize = r.size;
              } catch { /* keep polling */ }
            };
            const ticker = setInterval(tick, 700);
            const ka = setInterval(() => {
              try { controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`)); }
              catch { clearInterval(ka); }
            }, 25_000);
            (controller as any)._cleanup = () => {
              clearInterval(ticker);
              clearInterval(ka);
            };
            req.signal?.addEventListener("abort", () => {
              const c = (controller as any)._cleanup; if (c) c();
              try { controller.close(); } catch {}
            });
          },
          cancel() {
            const c = (this as any)._cleanup; if (c) c();
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
    }

    // ── Teams (dev-team templates) ──────────────────────────────────────
    // GET    /api/teams         list every template
    // GET    /api/teams/:name   one template's full JSON
    // POST   /api/teams         create a new template
    // PUT    /api/teams/:name   update a template in place
    // DELETE /api/teams/:name   remove a template
    const TEAMS_DIR = process.env.SUBCTL_TEAM_TEMPLATES_DIR ?? `${process.env.HOME}/.config/subctl/evy/team-templates`;

    // /api/teams/tools — list available tool families. MUST come BEFORE
    // the /api/teams/:name regex below or the regex eats "tools" as a
    // template name and 404's.
    if (url.pathname === "/api/teams/tools" && req.method === "GET") {
      return Response.json({
        ok: true,
        tool_families: [
          { id: "subctl_orch_*", description: "spawn / list / status / msg / kill dev-team tmux sessions" },
          { id: "gh_*",          description: "GitHub PRs, issues, checks" },
          { id: "coderabbit_*",  description: "AI code review on a branch or PR" },
          { id: "telegram_*",    description: "send messages to Jason via the master bot" },
          { id: "system_*",      description: "introspect host: hardware, load, models, processes, projects" },
          { id: "project_create", description: "create a new project (clone/init + vault + policy)" },
          { id: "vault_append",  description: "append-only writes inside ~/Documents/Obsidian Vault" },
        ],
      });
    }

    if (url.pathname === "/api/teams" && req.method === "GET") {
      const teams: Array<Record<string, unknown>> = [];
      try {
        if (existsSync(TEAMS_DIR)) {
          for (const entry of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const p = join(TEAMS_DIR, entry.name);
            try {
              const t = JSON.parse(readFileSync(p, "utf8"));
              teams.push({
                name: t.name ?? entry.name.replace(/\.json$/, ""),
                description: t.description ?? "",
                persona_preview: ((t.persona as string) ?? "").slice(0, 140),
                skills_count: Array.isArray(t.skills) ? t.skills.length : 0,
                tools_count: Array.isArray(t.tools) ? t.tools.length : 0,
                default_autonomy: t.default_autonomy ?? "ask",
                file: p,
              });
            } catch { /* skip bad JSON */ }
          }
        }
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
      teams.sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      return Response.json({ ok: true, teams_dir: TEAMS_DIR, teams });
    }

    {
      const m = url.pathname.match(/^\/api\/teams\/([^/]+)\/?$/);
      if (m) {
        const name = decodeURIComponent(m[1]!);
        const file = join(TEAMS_DIR, `${name}.json`);

        if (req.method === "GET") {
          if (!existsSync(file)) return Response.json({ ok: false, error: "template not found" }, { status: 404 });
          try {
            return Response.json({ ok: true, name, file, template: JSON.parse(readFileSync(file, "utf8")) });
          } catch (err) {
            return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
          }
        }

        if (req.method === "PUT") {
          if (!existsSync(file)) return Response.json({ ok: false, error: "template not found" }, { status: 404 });
          let body: Record<string, unknown>;
          try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
          // Force the name on disk to match the file name
          body.name = name;
          try {
            const { writeFileSync } = require("node:fs") as typeof import("node:fs");
            writeFileSync(file, JSON.stringify(body, null, 2));
            return Response.json({ ok: true, name, file });
          } catch (err) {
            return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
          }
        }

        if (req.method === "DELETE") {
          if (!existsSync(file)) return Response.json({ ok: false, error: "template not found" }, { status: 404 });
          try {
            const { unlinkSync } = require("node:fs") as typeof import("node:fs");
            unlinkSync(file);
            return Response.json({ ok: true, deleted: name });
          } catch (err) {
            return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
          }
        }
      }
    }

    if (url.pathname === "/api/teams" && req.method === "POST") {
      let body: { name?: string; description?: string; persona?: string; skills?: string[]; tools?: string[]; default_autonomy?: string; boot_prompt?: string; from_template?: string };
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const name = (body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "name required" }, { status: 400 });
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        return Response.json({ ok: false, error: "name must be alphanumerics + . - _ only" }, { status: 400 });
      }
      const file = join(TEAMS_DIR, `${name}.json`);
      if (existsSync(file)) return Response.json({ ok: false, error: `template '${name}' already exists` }, { status: 409 });
      const tpl: Record<string, unknown> = {
        name,
        description: body.description ?? "(describe what this dev team does)",
        persona: body.persona ?? "You are the lead of a dev team. Replace this with the persona prompt your team should boot with.",
        skills: Array.isArray(body.skills) ? body.skills : [],
        tools: Array.isArray(body.tools) && body.tools.length ? body.tools : ["subctl_orch_*", "gh_*", "telegram_*"],
        default_autonomy: body.default_autonomy ?? "ask",
        boot_prompt: body.boot_prompt ?? "Read CLAUDE.md and any RESUME.md in the project, then ask Jason what scope to start with.",
      };
      try {
        const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(TEAMS_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify(tpl, null, 2));
        return Response.json({ ok: true, name, file, template: tpl });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // ── Skills catalog endpoints ────────────────────────────────────────
    // GET /api/skills        — list all skills with frontmatter
    // GET /api/skills/sources — list imported sources
    // GET /api/skills/<id>   — get one skill's full SKILL.md content
    // POST /api/skills/import — { repo, source?, branch? } → clone + register

    const SKILLS_DIR = process.env.SUBCTL_SKILLS_DIR ?? `${process.env.HOME}/.config/subctl/skills`;

    if (url.pathname === "/api/skills" && req.method === "GET") {
      const skills: Array<{
        id: string;
        source: string;
        category: string;
        name: string;
        description: string;
        path: string;
      }> = [];
      try {
        if (existsSync(SKILLS_DIR)) {
          const stack = [SKILLS_DIR];
          while (stack.length) {
            const cur = stack.pop()!;
            const entries = readdirSync(cur, { withFileTypes: true });
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              const p = join(cur, e.name);
              if (e.isDirectory()) {
                stack.push(p);
              } else if (e.name === "SKILL.md") {
                // p = <SKILLS_DIR>/<source>/skills/<rest>/SKILL.md
                const rel = p.slice(SKILLS_DIR.length + 1);
                const segs = rel.split("/");
                const source = segs[0]!;
                // segs: [source, "skills", ...rest, "SKILL.md"]
                const inner = segs.slice(2, -1).join("/");
                const id = `${source}/${inner}`;
                const category = segs.length > 4 ? segs[2]! : "general";
                // Parse frontmatter
                const raw = readFileSync(p, "utf8");
                let name = "", description = "";
                const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
                if (fmMatch) {
                  for (const line of fmMatch[1]!.split("\n")) {
                    const nm = line.match(/^name:\s*(.*)$/);
                    if (nm) name = nm[1]!.trim();
                    const dm = line.match(/^description:\s*(.*)$/);
                    if (dm) description = dm[1]!.trim();
                  }
                }
                skills.push({
                  id,
                  source,
                  category,
                  name: name || (segs.at(-2) ?? "?"),
                  description: description.replace(/^['"]|['"]$/g, ""),
                  path: p,
                });
              }
            }
          }
        }
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
      skills.sort((a, b) => a.id.localeCompare(b.id));
      return Response.json({ ok: true, skills_dir: SKILLS_DIR, total: skills.length, skills });
    }

    if (url.pathname === "/api/skills/sources" && req.method === "GET") {
      const sources: Array<{ name: string; origin: string | null; skill_count: number; path: string }> = [];
      try {
        if (existsSync(SKILLS_DIR)) {
          for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            const sourceDir = join(SKILLS_DIR, entry.name);
            // Count SKILL.md files
            let count = 0;
            const stack = [join(sourceDir, "skills")];
            while (stack.length) {
              const cur = stack.pop()!;
              if (!existsSync(cur)) continue;
              try {
                for (const e of readdirSync(cur, { withFileTypes: true })) {
                  if (e.name.startsWith(".")) continue;
                  const p = join(cur, e.name);
                  if (e.isDirectory()) stack.push(p);
                  else if (e.name === "SKILL.md") count++;
                }
              } catch { /* ignore */ }
            }
            // git origin if present
            let origin: string | null = null;
            const gitDir = join(sourceDir, ".git");
            if (existsSync(gitDir)) {
              const r = spawnSync("git", ["-C", sourceDir, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 1500 });
              if (r.status === 0) origin = r.stdout.trim();
            }
            sources.push({ name: entry.name, origin, skill_count: count, path: sourceDir });
          }
        }
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
      return Response.json({ ok: true, skills_dir: SKILLS_DIR, sources });
    }

    {
      const m = url.pathname.match(/^\/api\/skills\/(.+)$/);
      if (m && req.method === "GET" && m[1] !== "sources") {
        const id = decodeURIComponent(m[1]!);
        // Resolve id → on-disk path
        // id format: <source>/<rest>  → SKILLS_DIR/<source>/skills/<rest>/SKILL.md
        const segs = id.split("/");
        if (segs.length < 2) return Response.json({ ok: false, error: "invalid skill id" }, { status: 400 });
        const source = segs[0]!;
        const rest = segs.slice(1).join("/");
        const path = join(SKILLS_DIR, source, "skills", rest, "SKILL.md");
        if (!existsSync(path)) {
          return Response.json({ ok: false, error: `skill not found: ${id}` }, { status: 404 });
        }
        try {
          const raw = readFileSync(path, "utf8");
          return Response.json({ ok: true, id, path, content: raw });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }
    }

    if (url.pathname === "/api/skills/import" && req.method === "POST") {
      let body: { repo?: string; source?: string; branch?: string };
      try { body = await req.json(); }
      catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
      const repo = (body.repo ?? "").trim();
      if (!repo) return Response.json({ ok: false, error: "repo required" }, { status: 400 });
      // Use the subctl CLI so all the validation + fallback logic stays in one place.
      // PR 8.5: routed through execCommand (the central helper) so this exec
      // shows up in the migration ledger. Ungated — the gate point for
      // "operator typed a skills repo URL" lives inside `subctl skills import`
      // itself, not at the spawn layer. (EXEC_SURFACE §4e.)
      const subctlBin = join(REPO_ROOT, "bin", "subctl");
      const args = ["skills", "import", repo];
      if (body.source) args.push("--source", body.source);
      if (body.branch) args.push("--branch", body.branch);
      const r = await execCommand(subctlBin, args, {
        timeout: 120_000,
        env: { ...process.env, PATH: "/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin:/usr/local/bin", SUBCTL_SKILLS_DIR },
      });
      if (r.exitCode !== 0) {
        return Response.json(
          { ok: false, error: ((r.stderr || r.stdout) ?? "").slice(0, 1500) },
          { status: 500 },
        );
      }
      return Response.json({
        ok: true,
        output: ((r.stdout || "") + (r.stderr || "")).slice(-500),
      });
    }

    // ── v2.8.1 skills clarity ──
    //
    // /api/skills/categorized — single payload powering the redesigned Skills
    // tab. Returns the full set bucketed by category (evy-loaded,
    // team-developer, evy-authored, project-local) plus, for team-developer
    // skills, the list of templates that reference them. The legacy
    // /api/skills route above stays unchanged so the team-builder modal that
    // pulls all imported skills doesn't regress.
    if (url.pathname === "/api/skills/categorized" && req.method === "GET") {
      try {
        const skills = listAllSkills({});
        // Load templates once so we can annotate which templates use each
        // team-developer skill. The team-templates module exports a sync
        // listTemplates() that seeds + caches, so this is cheap.
        let templates: { name: string; lead: { skills: string[] }; developers: { name: string; skills: string[] }[] }[] = [];
        try {
          const mod = await import("../components/evy/team-templates.ts");
          const r = mod.listTemplates();
          templates = r.templates.map((t) => ({
            name: t.name,
            lead: { skills: t.lead?.skills ?? [] },
            developers: (t.developers ?? []).map((d) => ({ name: d.name, skills: d.skills ?? [] })),
          }));
        } catch {
          /* templates dir missing is fine — show skills without annotations */
        }
        const byCategory: Record<SkillCategory, Skill[]> = {
          "evy-loaded": [],
          "team-developer": [],
          "evy-authored": [],
          "project-local": [],
        };
        for (const s of skills) byCategory[s.category].push(s);
        const annotate = (s: Skill) => ({
          ...s,
          templates_using: templatesUsingSkill(s.name, templates),
        });
        return Response.json({
          ok: true,
          counts: {
            "evy-loaded": byCategory["evy-loaded"].length,
            "team-developer": byCategory["team-developer"].length,
            "evy-authored": byCategory["evy-authored"].length,
            "project-local": byCategory["project-local"].length,
          },
          categories: {
            "evy-loaded": byCategory["evy-loaded"].map(annotate),
            "team-developer": byCategory["team-developer"].map(annotate),
            "evy-authored": byCategory["evy-authored"].map(annotate),
            "project-local": byCategory["project-local"].map(annotate),
          },
        });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // GET /api/skills/evy/:name — read the full SKILL.md body of an
    // Evy-authored draft.
    {
      const m = url.pathname.match(/^\/api\/skills\/evy\/([^/]+)$/);
      if (m && req.method === "GET") {
        const name = decodeURIComponent(m[1]!);
        const draft = listAllSkills({ category: "evy-authored", skipImported: true })
          .find((s) => s.name === name);
        if (!draft) return Response.json({ ok: false, error: `not found: ${name}` }, { status: 404 });
        try {
          const content = readFileSync(draft.path, "utf8");
          return Response.json({ ok: true, skill: draft, content });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }
    }

    // POST /api/skills/evy/:name/promote — promote a draft into
    // components/skills/<name>/.
    {
      const m = url.pathname.match(/^\/api\/skills\/evy\/([^/]+)\/promote$/);
      if (m && req.method === "POST") {
        const name = decodeURIComponent(m[1]!);
        let body: { promoted_by?: string } = {};
        try { body = await req.json(); } catch { /* allow empty body */ }
        const promotedBy = (body.promoted_by ?? "operator").toString().slice(0, 80);
        const r = promoteEvySkill(name, promotedBy);
        if (!r.ok) return Response.json(r, { status: 400 });
        return Response.json(r);
      }
    }

    // POST /api/skills/evy/:name/delete — discard a draft. POST (not DELETE)
    // for parity with the rest of this dashboard's curation endpoints.
    {
      const m = url.pathname.match(/^\/api\/skills\/evy\/([^/]+)\/delete$/);
      if (m && (req.method === "POST" || req.method === "DELETE")) {
        const name = decodeURIComponent(m[1]!);
        const r = deleteEvySkill(name);
        if (!r.ok) return Response.json(r, { status: 400 });
        return Response.json(r);
      }
    }
    // ── end v2.8.1 skills clarity ──

    // ── Settings page endpoints ─────────────────────────────────────────

    // /api/settings/install-checks — broad install matrix beyond /diag.
    // Each entry: {name, ok, version, install_cmd, required}
    if (url.pathname === "/api/settings/install-checks" && req.method === "GET") {
      const home = process.env.HOME ?? "";
      // PATH for install probes — extends launchd's minimal default with
      // common user-binary locations that installers drop binaries into:
      //   ~/.bun/bin       — bun installer
      //   ~/.local/bin     — coderabbit, many other curl|sh installers
      //   ~/.lmstudio/bin  — LM Studio's `lms` after "Use lms in terminal"
      //   ~/.cargo/bin     — rust toolchain
      const checkPath = [
        "/usr/sbin", "/usr/bin", "/bin", "/sbin",
        "/opt/homebrew/bin", "/usr/local/bin",
        `${home}/.bun/bin`,
        `${home}/.local/bin`,
        `${home}/.lmstudio/bin`,
        `${home}/.cargo/bin`,
      ].join(":");

      // Canonical dep list lives in lib/dep-manifest.json — single source of
      // truth shared with install.sh, lib/setup.sh, and `subctl doctor`. This
      // endpoint reads + maps the manifest into the legacy {name, check,
      // install, required, fallback_paths} shape so the dashboard UI doesn't
      // need to change. The manifest IS the canonical version of this list;
      // edit it (not this file) when adding/removing a dep.
      type ManifestDep = {
        id: string;
        name: string;
        type: string;
        tier: "hard" | "soft";
        detect: string[];
        fallback_paths?: string[];
        install_cmd?: string;
        install_method?: string;
        manual_url?: string;
        post_install_hint?: string;
      };
      type DashboardTool = {
        name: string;
        check: string[];
        install: string;
        required?: boolean;
        fallback_paths?: string[];
      };
      const expand = (s: string): string =>
        s.replace(/\$HOME/g, home).replace(/\$\{HOME\}/g, home);

      const manifestPath = join(REPO_ROOT, "lib", "dep-manifest.json");
      let tools: DashboardTool[] = [];
      try {
        const raw = readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as { deps: ManifestDep[] };
        tools = parsed.deps.map((d) => {
          // Compose the install hint shown in the dashboard. Append manual_url
          // and post_install_hint so the row carries everything the operator
          // needs without a click-through.
          const parts: string[] = [];
          if (d.install_cmd) parts.push(d.install_cmd);
          if (d.manual_url) parts.push(`[${d.manual_url}]`);
          if (d.post_install_hint) parts.push(d.post_install_hint);
          return {
            name: d.name,
            check: (d.detect ?? []).map(expand),
            install: parts.join("   "),
            required: d.tier === "hard",
            fallback_paths: (d.fallback_paths ?? []).map(expand),
          };
        });
      } catch (err) {
        // If the manifest is unreadable, return an error rather than falling
        // back silently — drift between the manifest and the dashboard is
        // exactly what this refactor is meant to prevent.
        return Response.json({
          ok: false,
          error: `dep-manifest.json unreadable: ${(err as Error).message}`,
          manifest_path: manifestPath,
        }, { status: 500 });
      }

      // Strip ANSI escape codes — lms's --version emits a colored ASCII
      // banner that renders as garbage in the dashboard's plain-text rows.
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      // Extract a sensible single-line version from output that may be
      // multi-line + box-drawing-decorated (lms prints a banner like
      // `│ Version 1.4.1 │`). Strategy:
      //   1. Strip ANSI
      //   2. Remove unicode box-drawing chars (─│┃╭╮╰╯┌┐└┘├┤┬┴┼ etc)
      //   3. Look for a semver-shaped substring in any non-empty line
      //   4. Fall back to first non-empty line trimmed to 80 chars
      const SEMVER_RE = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/;
      const cleanVersion = (raw: string): string => {
        const cleaned = stripAnsi(raw)
          .replace(/[─-╿▀-▟]/g, "") // box-drawing + block elements
          .trim();
        const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          const m = line.match(SEMVER_RE);
          if (m) return m[1]!;
        }
        return (lines[0] ?? "").slice(0, 80);
      };

      async function probeOne(t: typeof tools[number]) {
        try {
          const r = spawnSync(t.check[0]!, t.check.slice(1), {
            encoding: "utf8",
            timeout: 2500,
            env: { ...process.env, PATH: checkPath },
          });
          if (r.status === 0) {
            // For app/dir checks (test -d X), version output is empty;
            // emit a friendly "installed" string so the row reads cleanly.
            const isDirCheck = t.check[0] === "test";
            const version = isDirCheck ? "installed" : cleanVersion(r.stdout || "");
            return { name: t.name, ok: true, version: version || "ok", install: t.install, required: !!t.required };
          }
          for (const fp of t.fallback_paths ?? []) {
            if (existsSync(fp)) {
              const r2 = spawnSync(fp, t.check.slice(1), { encoding: "utf8", timeout: 2500 });
              if (r2.status === 0) {
                const version = cleanVersion(r2.stdout || "");
                return { name: t.name, ok: true, version: version || "ok (via fallback path)", install: t.install, required: !!t.required };
              }
            }
          }
          return { name: t.name, ok: false, version: null, install: t.install, required: !!t.required, detail: stripAnsi((r.stderr || r.stdout) ?? "").slice(0, 120) };
        } catch (err) {
          return { name: t.name, ok: false, version: null, install: t.install, required: !!t.required, detail: (err as Error).message };
        }
      }

      const results = await Promise.all(tools.map(probeOne));
      const required = results.filter((r) => r.required);
      return Response.json({
        ok: true,
        checks: results,
        summary: `${results.filter((r) => r.ok).length}/${results.length} installed (${required.filter((r) => r.ok).length}/${required.length} required)`,
      });
    }

    // /api/settings/obsidian — get/set the configured Obsidian vault root path
    if (url.pathname === "/api/settings/obsidian" && req.method === "GET") {
      const cfgPath = join(SUBCTL_CONFIG_DIR, "evy", "obsidian.json");
      let vaultRoot = `${process.env.HOME}/Documents/Obsidian Vault`;
      let configured = false;
      try {
        if (existsSync(cfgPath)) {
          const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
          if (j.vault_root) {
            vaultRoot = j.vault_root.replace(/^~/, process.env.HOME ?? "");
            configured = true;
          }
        }
      } catch { /* ignore */ }
      return Response.json({
        ok: true,
        vault_root: vaultRoot,
        configured,
        exists: existsSync(vaultRoot),
        config_path: cfgPath,
      });
    }
    if (url.pathname === "/api/settings/obsidian" && req.method === "POST") {
      let body: { vault_root?: string; bootstrap?: boolean };
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const path = (body.vault_root ?? "").trim();
      if (!path) return Response.json({ ok: false, error: "vault_root required" }, { status: 400 });
      // Default true — saving a vault root configuration without bootstrapping
      // is what created the "Obsidian installed, no vault detected" hole that
      // forced the operator to mkdir manually. Only a deliberate
      // {bootstrap:false} skips the structure creation.
      const bootstrap = body.bootstrap !== false;
      const expanded = path.replace(/^~/, process.env.HOME ?? "");
      const cfgPath = join(SUBCTL_CONFIG_DIR, "evy", "obsidian.json");
      try {
        const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(join(SUBCTL_CONFIG_DIR, "evy"), { recursive: true });
        writeFileSync(cfgPath, JSON.stringify({ vault_root: path, _comment: `set via dashboard ${new Date().toISOString()}` }, null, 2));

        // Auto-bootstrap the vault structure. The master's vault_append tool
        // writes to <root>/<project>/decisions.md and creates dirs on the fly,
        // but Obsidian itself only recognizes a folder as a vault if it has a
        // .obsidian/ directory. Without bootstrapping, the dashboard reports
        // "no vault detected" even though the master is functionally writing
        // there. Create the default "master" sub-vault with a .obsidian/ stub
        // so Obsidian-the-app and the dashboard both see a real vault.
        const created: string[] = [];
        let bootstrapErr: string | null = null;
        if (bootstrap) {
          try {
            mkdirSync(expanded, { recursive: true });
            if (!existsSync(expanded + "/master")) {
              mkdirSync(expanded + "/master/.obsidian", { recursive: true });
              writeFileSync(
                expanded + "/master/welcome.md",
                "# subctl evy vault\n\n" +
                "This vault is the master daemon's long-term memory store (tier 3).\n\n" +
                "Per-project notes land here as the master records decisions, drafts " +
                "specs, and tracks dev-team progress. Each spawned dev team gets a " +
                "subdirectory with its own `decisions.md`.\n\n" +
                "Created automatically by the subctl dashboard. Open this folder in " +
                "Obsidian to browse. Safe to rename, restructure, or add your own " +
                "notes — the master writes append-only and never deletes.\n",
              );
              created.push(expanded + "/master/.obsidian");
              created.push(expanded + "/master/welcome.md");
            }
          } catch (err) {
            bootstrapErr = (err as Error).message;
          }
        }

        return Response.json({
          ok: true,
          vault_root: expanded,
          exists: existsSync(expanded),
          bootstrapped: bootstrap,
          created,
          bootstrap_error: bootstrapErr,
          config_path: cfgPath,
        });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // /api/settings/keys — STATUS only (presence flag, never the value)
    //
    // v2.7.4: each row now reflects BOTH sources — process env var AND
    // ~/.config/subctl/secrets.json — so the operator can see exactly
    // which path is providing the key at a glance. The known-secret rows
    // (lmstudio + brave + firecrawl + linear + context7) carry a
    // `secrets_json` boolean alongside the env flag; cloud-provider rows
    // without a secrets.json counterpart leave it null.
    if (url.pathname === "/api/settings/keys" && req.method === "GET") {
      const vars = [
        { name: "ANTHROPIC_API_KEY",    purpose: "Anthropic direct API (claude-sonnet, claude-opus)" },
        { name: "OPENAI_API_KEY",       purpose: "OpenAI direct API (gpt-4, gpt-5, codex)" },
        { name: "GEMINI_API_KEY",       purpose: "Google Gemini" },
        { name: "GROQ_API_KEY",         purpose: "Groq inference" },
        { name: "OPENROUTER_API_KEY",   purpose: "OpenRouter (200+ models via one key)" },
        { name: "GITHUB_TOKEN",         purpose: "gh CLI fallback (usually authed via gh auth login)" },
        { name: "CONTEXT7_API_KEY",     purpose: "Context7 — up-to-date library docs (master tool + MCP for dev-team Claude leads)", secret_key: "context7_api_key" },
        { name: "BRAVE_API_KEY",        purpose: "Brave AI Search (web_search master tool — v2.7.2)", secret_key: "brave_api_key" },
        { name: "FIRECRAWL_API_KEY",    purpose: "Firecrawl scraping (web_fetch master tool — v2.7.2)", secret_key: "firecrawl_api_key" },
        { name: "TINYFISH_API_KEY",     purpose: "TinyFish search + fetch (tinyfish_search, tinyfish_fetch master tools — v2.7.16, free tier)", secret_key: "tinyfish_api_key" },
        { name: "LINEAR_API_KEY",       purpose: "Linear API (linear_list_issues, linear_search, linear_create_issue, linear_update_issue master tools — v2.7.2)", secret_key: "linear_api_key" },
        { name: "LMSTUDIO_API_TOKEN",   purpose: "LM Studio API auth (when 'Require API Token' is enabled in LM Studio server settings — v2.7.4)", secret_key: "lmstudio_api_token" },
      ];
      // CRITICAL: only the boolean `ok` + length escape — value is never
      // serialized into the response body. `length` is intentionally a
      // length, not a prefix, so the operator can sanity-check rotation
      // without leaking any byte of the credential.
      const results = vars.map((v) => {
        const val = process.env[v.name];
        const secretsVal = v.secret_key ? loadSecret(v.secret_key) : null;
        return {
          name: v.name,
          ok: !!val || !!secretsVal,
          env: !!val,
          secrets_json: v.secret_key ? !!secretsVal : null,
          length: val ? val.length : (secretsVal ? secretsVal.length : 0),
          purpose: v.purpose,
        };
      });
      return Response.json({
        ok: true,
        keys: results,
        note: "v2.7.4 priority: process env beats ~/.config/subctl/secrets.json beats absent. Edit secrets via the Settings → API Tokens panel (chmod 600 file, never echoed back). Env vars set in your shell ~/.zshrc are NOT inherited by launchd services; set them in ~/Library/LaunchAgents/com.subctl.evy.plist EnvironmentVariables.",
      });
    }

    // /api/settings/secrets — list known secret keys and their presence
    // flags. NEVER returns the values themselves. Safe to surface to the
    // dashboard panel for the "API Tokens" UI. v2.7.4.
    if (url.pathname === "/api/settings/secrets" && req.method === "GET") {
      try {
        return Response.json({
          ok: true,
          secrets: listSecrets(),
          // Surface the resolution priority so the panel can render
          // "env override active" hints next to rows where the env var
          // is winning over the on-disk value.
          priority: ["env_var", "secrets_json", "absent"],
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }

    // /api/settings/secrets/:key — write or clear a single secret.
    // Body: { "value": string | null }. NEVER echoes the value back.
    // Returns the updated listSecrets() row for the affected key so the
    // panel can refresh in place.
    if (
      url.pathname.startsWith("/api/settings/secrets/") &&
      req.method === "POST"
    ) {
      const key = decodeURIComponent(url.pathname.slice("/api/settings/secrets/".length));
      // Allow-list: only the well-known SECRET_KEYS can be written
      // through this endpoint. Prevents an attacker (or buggy client)
      // from writing arbitrary fields into the JSON blob.
      if (!(SECRET_KEYS as readonly string[]).includes(key)) {
        return Response.json(
          { ok: false, error: `unknown secret key: ${key} (allowed: ${SECRET_KEYS.join(", ")})` },
          { status: 400 },
        );
      }
      let body: { value?: unknown };
      try {
        body = (await req.json()) as { value?: unknown };
      } catch {
        return Response.json(
          { ok: false, error: "body must be valid JSON" },
          { status: 400 },
        );
      }
      const v = body.value;
      // null OR empty string clears the field. Anything else must be a
      // string we accept verbatim. We do NOT trim — operator might have
      // intentional whitespace on either end of an opaque token.
      if (v !== null && typeof v !== "string") {
        return Response.json(
          { ok: false, error: "value must be a string or null" },
          { status: 400 },
        );
      }
      try {
        await setSecret(key, (v as string | null) ?? null);
      } catch (err) {
        return Response.json(
          { ok: false, error: `write failed: ${(err as Error).message}` },
          { status: 500 },
        );
      }
      // Build the response from listSecrets so the caller gets the new
      // presence flag + last-modified without us touching the value.
      const row = listSecrets().find((s) => s.key === key);
      return Response.json({
        ok: true,
        secret: row,
        // CRITICAL: nothing here echoes the value back to the caller.
        // Even an audit log entry would be a leak vector — we just don't.
      });
    }

    // /api/settings/oauth — Claude/OpenAI account auth status from accounts.conf
    // Format: pipe-delimited "alias | provider | email | config_dir | description"
    // (whitespace around pipes is normal — strip after split)
    if (url.pathname === "/api/settings/oauth" && req.method === "GET") {
      const accountsPath = join(SUBCTL_CONFIG_DIR, "accounts.conf");
      const accounts: Array<{ alias: string; provider: string; email: string; config_dir: string; auth_status: string; description: string }> = [];
      try {
        if (existsSync(accountsPath)) {
          const raw = readFileSync(accountsPath, "utf8");
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const parts = trimmed.split("|").map((p) => p.trim());
            if (parts.length < 4) continue;
            const [alias, provider, email, configDirRaw, description = ""] = parts;
            const configDir = configDirRaw!.replace(/^~/, process.env.HOME ?? "");
            // Different providers store creds differently:
            //   claude: <config_dir>/.credentials.json  (mac keychain too, but this file is the disk signal)
            //   openai (codex): <config_dir>/auth.json with .tokens
            let authStatus = "not_authenticated";
            const claudeCred = join(configDir, ".credentials.json");
            const codexAuth = join(configDir, "auth.json");
            if (existsSync(claudeCred)) {
              authStatus = "ready";
            } else if (existsSync(codexAuth)) {
              try {
                const j = JSON.parse(readFileSync(codexAuth, "utf8"));
                if (j && (j.tokens || j.access_token)) authStatus = "ready";
              } catch { /* ignore */ }
            }
            accounts.push({
              alias: alias!,
              provider: provider!,
              email: email!,
              config_dir: configDirRaw!,
              auth_status: authStatus,
              description: description,
            });
          }
        }
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
      return Response.json({ ok: true, accounts });
    }

    // /api/settings/telegram — update bot_token / chat_id in evy-notify.json
    if (url.pathname === "/api/settings/telegram" && req.method === "POST") {
      let body: { bot_token?: string; chat_id?: string };
      try { body = await req.json(); }
      catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
      const notifyPath = join(SUBCTL_CONFIG_DIR, "evy-notify.json");
      let cur: Record<string, unknown> = {};
      try {
        if (existsSync(notifyPath)) cur = JSON.parse(readFileSync(notifyPath, "utf8"));
      } catch { /* ignore */ }
      const newToken = (body.bot_token ?? "").trim();
      const newChatId = (body.chat_id ?? "").trim();
      if (newToken) cur.bot_token = newToken;
      if (newChatId) cur.chat_id = newChatId;
      // Test the resulting config by hitting Telegram /getMe
      const testToken = (cur.bot_token as string | undefined) ?? null;
      if (!testToken) {
        return Response.json({ ok: false, error: "bot_token missing — provide one or set previously" }, { status: 400 });
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${testToken}/getMe`, {
          signal: AbortSignal.timeout(4000),
        });
        const j = (await r.json()) as { ok: boolean; result?: { username?: string }; description?: string };
        if (!j.ok) {
          return Response.json({ ok: false, error: `getMe failed: ${j.description ?? "unknown"}` }, { status: 400 });
        }
        // Persist
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(notifyPath, JSON.stringify(cur, null, 2));
        // Bounce master so the listener picks up new config
        const label = "com.subctl.evy";
        const plist = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
        if (existsSync(plist)) {
          spawnSync("launchctl", ["unload", plist], { encoding: "utf8", timeout: 5000 });
          for (let i = 0; i < 5; i++) {
            const ps = spawnSync("pgrep", ["-f", "subctl.*master/server.ts"], { encoding: "utf8", timeout: 1000 });
            if (!ps.stdout?.trim()) break;
            await new Promise((r) => setTimeout(r, 1000));
          }
          spawnSync("launchctl", ["load", plist], { encoding: "utf8", timeout: 5000 });
        }
        return Response.json({
          ok: true,
          bot_username: j.result?.username ?? null,
          chat_id_set: !!cur.chat_id,
          message: "saved + master restarted",
        });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // /api/settings/telegram/test — test the CURRENT config without changing
    if (url.pathname === "/api/settings/telegram/test" && req.method === "POST") {
      const notifyPath = join(SUBCTL_CONFIG_DIR, "evy-notify.json");
      if (!existsSync(notifyPath)) return Response.json({ ok: false, error: "evy-notify.json missing" }, { status: 404 });
      try {
        const cfg = JSON.parse(readFileSync(notifyPath, "utf8")) as { bot_token?: string; chat_id?: string };
        const token = cfg.bot_token;
        if (!token) return Response.json({ ok: false, error: "no bot_token in evy-notify.json" }, { status: 400 });
        const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(4000) });
        const j = (await r.json()) as { ok: boolean; result?: { username?: string }; description?: string };
        return Response.json({
          ok: !!j.ok,
          bot_username: j.result?.username ?? null,
          chat_id: cfg.chat_id ?? null,
          error: j.ok ? undefined : (j.description ?? "getMe failed"),
        });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // /api/settings/config/:name — return raw config file content (read-only)
    {
      const m = url.pathname.match(/^\/api\/settings\/config\/(\w+)\/?$/);
      if (m && req.method === "GET") {
        const name = m[1]!;
        const map: Record<string, string> = {
          policy:    join(SUBCTL_CONFIG_DIR, "evy", "policy.json"),
          providers: join(SUBCTL_CONFIG_DIR, "evy", "providers.json"),
          notify:    join(SUBCTL_CONFIG_DIR, "evy-notify.json"),
        };
        const path = map[name];
        if (!path) return Response.json({ ok: false, error: "unknown config" }, { status: 400 });
        if (!existsSync(path)) return Response.json({ ok: false, error: `${name} not found at ${path}` }, { status: 404 });
        try {
          let content = readFileSync(path, "utf8");
          // Redact obvious secrets in the displayed content
          content = content.replace(/("bot_token"\s*:\s*")[^"]+(")/g, "$1<redacted>$2");
          return Response.json({ ok: true, name, path, content });
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
      }
    }

    // ── /api/projects/create — wizard endpoint ───────────────────────────
    // Body: {name, git_url?, autonomy_level: "drive"|"ask"|"shadow",
    //        create_vault: boolean, add_to_policy: boolean}
    // Steps:
    //   1. Validate name (no shell-special chars, not already at ~/code/<name>)
    //   2. Either git clone or mkdir into ~/code/<name>
    //   3. If create_vault: mkdir ~/Documents/Obsidian Vault/<name>/{,design,reviews,postmortems}
    //      and seed RESUME.md with a tiny template
    //   4. If add_to_policy: append entry to ~/.config/subctl/evy/policy.json
    //   5. Return success + path + vault_path so the UI can refresh and select it
    if (url.pathname === "/api/projects/create" && req.method === "POST") {
      let body: {
        name?: string;
        git_url?: string;
        autonomy_level?: "drive" | "ask" | "shadow";
        create_vault?: boolean;
        add_to_policy?: boolean;
        create_github_repo?: boolean;
        github_visibility?: "public" | "private" | "internal";
      };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
      }
      // Normalize name: trim, collapse whitespace runs to a single dash,
      // strip any other non-alphanumeric+.-_ chars, then trim leading/
      // trailing dashes. Avoids forcing the user to type a slug manually.
      const rawName = (body.name ?? "").trim();
      const name = rawName
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .replace(/^-+|-+$/g, "");

      // Normalize git URL: accept several forms users actually paste:
      //   - "gh repo clone owner/repo"          → https://github.com/owner/repo.git
      //   - "owner/repo"                        → https://github.com/owner/repo.git
      //   - "https://github.com/owner/repo"     → leave as-is (git accepts)
      //   - "git@github.com:owner/repo.git"     → leave as-is
      let gitUrl = (body.git_url ?? "").trim();
      if (gitUrl.startsWith("gh repo clone ")) {
        gitUrl = gitUrl.replace(/^gh repo clone\s+/, "").trim();
      }
      if (/^[\w.-]+\/[\w.-]+$/.test(gitUrl)) {
        gitUrl = `https://github.com/${gitUrl}.git`;
      }
      const autonomy = body.autonomy_level ?? "ask";
      const createVault = body.create_vault !== false; // default true
      const addToPolicy = body.add_to_policy !== false; // default true
      const createGithub = body.create_github_repo === true;
      const ghVisibility = body.github_visibility ?? "private";

      // Validate (after normalization)
      if (!name) return Response.json({ ok: false, error: "name required (after normalizing spaces/special chars, nothing was left)" }, { status: 400 });
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        return Response.json(
          { ok: false, error: `normalized name "${name}" still contains invalid chars — alphanumerics + dots/dashes/underscores only` },
          { status: 400 },
        );
      }
      if (!["drive", "ask", "shadow"].includes(autonomy)) {
        return Response.json({ ok: false, error: "autonomy_level must be drive/ask/shadow" }, { status: 400 });
      }

      const codeRoot = process.env.SUBCTL_CODE_ROOT ?? `${process.env.HOME}/code`;
      const projectPath = join(codeRoot, name);
      if (existsSync(projectPath)) {
        return Response.json({ ok: false, error: `~/code/${name} already exists` }, { status: 409 });
      }

      const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

      // 1. Clone or mkdir
      // PR 8.5: routed through execCommand. EXEC_SURFACE §4f flags this as a
      // user-supplied input path (`gitUrl` from JSON body). The argv-array
      // form already disarms shell injection; the helper adds consistent
      // timeout + capture semantics and registers the site in the migration
      // ledger. Stays ungated — gating "is `git clone <url>` allowed?" lives
      // upstream of the spawn (URL normalization at request entry).
      if (gitUrl) {
        const r = await execCommand("git", ["clone", gitUrl, projectPath], {
          timeout: 120_000,
        });
        if (r.exitCode !== 0) {
          steps.push({ step: "clone", ok: false, detail: (r.stderr || r.stdout || "").slice(0, 500) });
          return Response.json({ ok: false, error: "git clone failed", steps }, { status: 500 });
        }
        steps.push({ step: "clone", ok: true, detail: gitUrl });
      } else {
        try {
          const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
          mkdirSync(projectPath, { recursive: true });
          // Seed README so it's not totally empty
          writeFileSync(
            join(projectPath, "README.md"),
            `# ${name}\n\nCreated via subctl new-project wizard on ${new Date().toISOString()}.\n`,
          );
          // Init git so the project page can show branch / commits
          spawnSync("git", ["-C", projectPath, "init", "--initial-branch=main"], { encoding: "utf8", timeout: 10_000 });
          spawnSync("git", ["-C", projectPath, "add", "."], { encoding: "utf8", timeout: 5_000 });
          spawnSync("git", ["-C", projectPath, "commit", "-m", "Initial commit"], { encoding: "utf8", timeout: 10_000 });
          steps.push({ step: "mkdir+init", ok: true, detail: projectPath });

          // 1b. Optionally create + push to GitHub
          if (createGithub) {
            // gh repo create accepts <owner>/<name> or just <name> (uses
            // currently-authed user as owner). --source=<path> --push pushes
            // the initial commit; --remote=origin wires the remote.
            const visFlag = ghVisibility === "public" ? "--public" : ghVisibility === "internal" ? "--internal" : "--private";
            const ghArgs = [
              "repo", "create", name,
              visFlag,
              "--source", projectPath,
              "--remote", "origin",
              "--push",
              "--description", `Created via subctl on ${new Date().toISOString().slice(0, 10)}`,
            ];
            const ghProc = spawnSync("gh", ghArgs, {
              encoding: "utf8",
              timeout: 60_000,
              env: { ...process.env, PATH: "/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin:/usr/local/bin" },
            });
            if (ghProc.status === 0) {
              const out = ((ghProc.stdout || "") + (ghProc.stderr || "")).trim();
              steps.push({ step: "github", ok: true, detail: out.slice(-200) || `created ${ghVisibility} repo` });
            } else {
              steps.push({
                step: "github",
                ok: false,
                detail: ((ghProc.stderr || ghProc.stdout) ?? "").slice(0, 500) + "  (project created locally; you can push later with: gh repo create " + name + " " + visFlag + " --source=" + projectPath + " --remote=origin --push)",
              });
              // Non-fatal — local project still exists, vault + policy steps continue
            }
          }
        } catch (err) {
          steps.push({ step: "mkdir+init", ok: false, detail: (err as Error).message });
          return Response.json({ ok: false, error: "init failed", steps }, { status: 500 });
        }
      }

      // 2. Vault
      let vaultPath: string | null = null;
      if (createVault) {
        try {
          const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
          const vaultRoot = `${process.env.HOME}/Documents/Obsidian Vault`;
          vaultPath = join(vaultRoot, name);
          mkdirSync(join(vaultPath, "design"), { recursive: true });
          mkdirSync(join(vaultPath, "reviews"), { recursive: true });
          mkdirSync(join(vaultPath, "postmortems"), { recursive: true });
          writeFileSync(
            join(vaultPath, "RESUME.md"),
            [
              `# ${name} — RESUME`,
              "",
              `**Path:** \`${projectPath}\``,
              gitUrl ? `**Repo:** ${gitUrl}` : "**Repo:** (local-only)",
              `**Created:** ${new Date().toISOString()}`,
              "",
              "## Current state",
              "",
              "_New project. Master will populate this as work progresses._",
              "",
              "## What's next",
              "",
              "- [ ] Define initial scope",
              "- [ ] Spawn first dev team",
              "",
            ].join("\n"),
          );
          steps.push({ step: "vault", ok: true, detail: vaultPath });
        } catch (err) {
          steps.push({ step: "vault", ok: false, detail: (err as Error).message });
          // non-fatal — vault is optional
        }
      }

      // 3. policy.json append
      if (addToPolicy) {
        try {
          const policyPath = join(SUBCTL_CONFIG_DIR, "evy", "policy.json");
          if (existsSync(policyPath)) {
            const raw = readFileSync(policyPath, "utf8");
            const stripped = raw.split("\n").filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
            const policy = JSON.parse(stripped) as { projects?: Array<Record<string, unknown>> };
            policy.projects = policy.projects ?? [];
            policy.projects.push({
              path: projectPath,
              autonomy_level: autonomy,
              _comment_autonomy: `Added via dashboard wizard on ${new Date().toISOString().slice(0, 10)}`,
            });
            const { writeFileSync } = require("node:fs") as typeof import("node:fs");
            writeFileSync(policyPath, JSON.stringify(policy, null, 2));
            steps.push({ step: "policy", ok: true, detail: `appended ${name} (autonomy=${autonomy})` });
            // Restart master so it picks up the new project
            const label = "com.subctl.evy";
            const plist = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
            if (existsSync(plist)) {
              spawnSync("launchctl", ["unload", plist], { encoding: "utf8", timeout: 5000 });
              for (let i = 0; i < 5; i++) {
                const ps = spawnSync("pgrep", ["-f", "subctl.*master/server.ts"], { encoding: "utf8", timeout: 1000 });
                if (!ps.stdout?.trim()) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
              spawnSync("launchctl", ["load", plist], { encoding: "utf8", timeout: 5000 });
              steps.push({ step: "master-restart", ok: true });
            }
          } else {
            steps.push({ step: "policy", ok: false, detail: "policy.json missing" });
          }
        } catch (err) {
          steps.push({ step: "policy", ok: false, detail: (err as Error).message });
        }
      }

      return Response.json({
        ok: true,
        name,
        path: projectPath,
        vault_path: vaultPath,
        steps,
      });
    }

    // ── /api/projects/:name — drill-down detail for one project ──────────
    {
      const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/?$/);
      if (m && req.method === "GET") {
        const name = decodeURIComponent(m[1]!);
        const codeRoot = process.env.SUBCTL_CODE_ROOT ?? `${process.env.HOME}/code`;
        const path = join(codeRoot, name);
        if (!existsSync(path)) {
          return Response.json({ ok: false, error: "project not found" }, { status: 404 });
        }
        const gitOut = (args: string[]) => {
          const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", timeout: 1500 });
          return r.status === 0 ? r.stdout.trim() : "";
        };
        const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]) || null;
        const lastCommit = gitOut(["log", "-1", "--format=%h%x09%s%x09%cr%x09%an"]) || null;
        const remoteUrl = gitOut(["config", "--get", "remote.origin.url"]) || null;
        const dirty = gitOut(["status", "--porcelain"]).length > 0;
        // ahead / behind
        const aheadBehind = gitOut(["rev-list", "--left-right", "--count", `HEAD...@{u}`]).split("\t");
        const ahead = parseInt(aheadBehind[0] ?? "0", 10) || 0;
        const behind = parseInt(aheadBehind[1] ?? "0", 10) || 0;
        // last 10 commits
        const log10 = gitOut(["log", "-10", "--format=%h%x09%s%x09%cr%x09%an"])
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [sha, subject, when, author] = line.split("\t");
            return { sha, subject, when, author };
          });
        const has = (rel: string) => existsSync(join(path, rel));
        // Policy lookup
        let policyEntry: Record<string, unknown> | null = null;
        try {
          const policyPath = join(SUBCTL_CONFIG_DIR, "evy", "policy.json");
          if (existsSync(policyPath)) {
            const raw = readFileSync(policyPath, "utf8");
            const stripped = raw.split("\n").filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
            const policy = JSON.parse(stripped) as { projects?: Array<{ path: string; [k: string]: unknown }> };
            const expanded = path;
            policyEntry = (policy.projects ?? []).find((p) => {
              const pPath = (p.path as string).replace(/^~/, process.env.HOME ?? "");
              return pPath === expanded;
            }) ?? null;
          }
        } catch { /* ignore parse errors */ }

        // Pull recent decisions from master decisions log, filtered by project
        const decisions: Array<Record<string, unknown>> = [];
        try {
          const decPath = join(SUBCTL_CONFIG_DIR, "evy", "decisions.jsonl");
          if (existsSync(decPath)) {
            const raw = readFileSync(decPath, "utf8");
            const lines = raw.split("\n").filter(Boolean).slice(-200); // last 200 lines
            for (const line of lines) {
              try {
                const d = JSON.parse(line) as Record<string, unknown>;
                if (d.project === name || d.project === path) decisions.push(d);
              } catch { /* skip */ }
            }
            decisions.reverse(); // newest first
          }
        } catch { /* ignore */ }

        // Identify dev teams targeting this project (tmux session whose path == project path)
        const teamsForThis: Array<Record<string, unknown>> = [];
        try {
          const allOrch = buildOrchestrations();
          for (const o of allOrch) {
            if (o.path === path) teamsForThis.push(o);
          }
        } catch { /* ignore */ }

        // Vault status
        const vaultRoot = `${process.env.HOME}/Documents/Obsidian Vault`;
        const vaultProjectDir = join(vaultRoot, name);
        const vaultExists = existsSync(vaultProjectDir);

        // GitHub PR list (best-effort) — only if remoteUrl looks like github.com/owner/repo
        let ghRepo: string | null = null;
        const ghMatch = remoteUrl?.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
        if (ghMatch) ghRepo = `${ghMatch[1]}/${ghMatch[2]}`;
        let prs: Array<Record<string, unknown>> = [];
        let issues: Array<Record<string, unknown>> = [];
        if (ghRepo) {
          try {
            const r = spawnSync(
              "gh",
              ["pr", "list", "--repo", ghRepo, "--state", "open", "--limit", "10",
               "--json", "number,title,state,isDraft,headRefName,statusCheckRollup,url,updatedAt"],
              { encoding: "utf8", timeout: 4000 },
            );
            if (r.status === 0) prs = JSON.parse(r.stdout || "[]");
          } catch { /* gh unavail */ }
          try {
            const r = spawnSync(
              "gh",
              ["issue", "list", "--repo", ghRepo, "--state", "open", "--limit", "10",
               "--json", "number,title,state,labels,url,updatedAt"],
              { encoding: "utf8", timeout: 4000 },
            );
            if (r.status === 0) issues = JSON.parse(r.stdout || "[]");
          } catch { /* gh unavail */ }
        }

        return Response.json({
          ok: true,
          name,
          path,
          remote_url: remoteUrl,
          github_repo: ghRepo,
          branch,
          last_commit: lastCommit,
          dirty,
          ahead,
          behind,
          recent_commits: log10,
          flags: {
            has_claude_md: has("CLAUDE.md"),
            has_package_json: has("package.json"),
            has_pyproject: has("pyproject.toml") || has("requirements.txt"),
            has_readme: has("README.md") || has("README"),
          },
          in_policy: !!policyEntry,
          policy: policyEntry,
          decisions: decisions.slice(0, 20),
          dev_teams: teamsForThis,
          vault: {
            project_dir: vaultProjectDir,
            exists: vaultExists,
            root: vaultRoot,
          },
          prs,
          issues,
        });
      }
    }

    // ── /api/memory/tier1 — read/write master's always-in-context memory ──
    // memory.md (learned facts, ~2200 char limit) and user.md (operator
    // profile, ~1375 char limit). Both auto-injected into master's
    // system prompt every turn. Edits land in the next turn without
    // master restart.
    if (url.pathname === "/api/memory/tier1" && req.method === "GET") {
      const home = process.env.HOME ?? "";
      const memPath = join(home, ".config/subctl/evy/memory.md");
      const userPath = join(home, ".config/subctl/evy/user.md");
      const readSafe = (p: string, limit: number) => {
        if (!existsSync(p)) return { exists: false, content: "", char_count: 0, char_limit: limit };
        try {
          const c = readFileSync(p, "utf8");
          return { exists: true, content: c, char_count: c.length, char_limit: limit };
        } catch (e) {
          return { exists: false, content: "", char_count: 0, char_limit: limit, error: (e as Error).message };
        }
      };
      return Response.json({
        ok: true,
        memory: { path: memPath, ...readSafe(memPath, 2200) },
        user_profile: { path: userPath, ...readSafe(userPath, 1375) },
      });
    }
    if (url.pathname === "/api/memory/tier1" && req.method === "POST") {
      let body: { which?: "memory" | "user"; content?: string };
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      if (body.which !== "memory" && body.which !== "user") {
        return Response.json({ ok: false, error: "which must be 'memory' or 'user'" }, { status: 400 });
      }
      const home = process.env.HOME ?? "";
      const path = body.which === "memory"
        ? join(home, ".config/subctl/evy/memory.md")
        : join(home, ".config/subctl/evy/user.md");
      const limit = body.which === "memory" ? 2200 : 1375;
      const content = (body.content ?? "").trim();
      if (content.length > limit) {
        return Response.json({ ok: false, error: `content exceeds char limit (${content.length} > ${limit})` }, { status: 400 });
      }
      try {
        const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(join(home, ".config/subctl/evy"), { recursive: true });
        writeFileSync(path, content);
        return Response.json({ ok: true, path, char_count: content.length, char_limit: limit, message: "next agent prompt will pick up the new content" });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // ── /api/vault — In-browser Obsidian vault viewer (Phase 3n) ─────────
    //
    // Treats each subdirectory of vault_root with a .obsidian/ dir as a
    // discrete vault. Per-vault tree + raw-markdown note fetch. Frontend
    // renders the markdown with Marked.js from CDN + wikilink post-render
    // transforms. No file watching for MVP — refresh on click.
    //
    // Endpoints:
    //   GET /api/vault/roots                          → list vaults
    //   GET /api/vault/<vault>/tree                   → folder tree
    //   GET /api/vault/<vault>/note?path=rel/path.md  → raw markdown + frontmatter
    //   GET /api/vault/<vault>/asset?path=rel/img.png → passthrough (image/pdf)

    function listVaultRoots(): Array<{ slug: string; name: string; path: string; note_count: number }> {
      // Resolve the configured root from obsidian.json (or default).
      let vaultRoot = `${process.env.HOME}/Documents/Obsidian Vault`;
      try {
        const cfgPath = join(SUBCTL_CONFIG_DIR, "evy", "obsidian.json");
        if (existsSync(cfgPath)) {
          const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
          if (j.vault_root) vaultRoot = j.vault_root.replace(/^~/, process.env.HOME ?? "");
        }
      } catch { /* ignore */ }
      if (!existsSync(vaultRoot)) return [];

      // Count .md files under a directory (depth-bounded for safety).
      const countNotes = (dir: string): number => {
        let count = 0;
        const stack = [dir];
        while (stack.length && count < 5000) {
          const cur = stack.pop()!;
          try {
            for (const e of readdirSync(cur, { withFileTypes: true })) {
              if (e.name.startsWith(".")) continue;
              const p = join(cur, e.name);
              if (e.isDirectory()) stack.push(p);
              else if (e.name.endsWith(".md")) count++;
            }
          } catch { /* skip unreadable */ }
        }
        return count;
      };

      const out: Array<{ slug: string; name: string; path: string; note_count: number }> = [];

      // Case A: vault_root IS a single Obsidian vault (has .obsidian/ directly).
      if (existsSync(join(vaultRoot, ".obsidian"))) {
        const name = vaultRoot.replace(/^.*\//, "") || "vault";
        out.push({
          slug: name,
          name,
          path: vaultRoot,
          note_count: countNotes(vaultRoot),
        });
      }

      // Case B: vault_root is a CONTAINER of vaults — enumerate child dirs.
      // Recognize a subdir as a vault if it has .obsidian/ (canonical) OR
      // contains any .md files (looser fallback, common when master's
      // vault_append created the dir but no human opened Obsidian on it
      // yet so .obsidian/ doesn't exist).
      try {
        for (const entry of readdirSync(vaultRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".")) continue;
          const sub = join(vaultRoot, entry.name);
          // Skip if we already added vault_root and this is a subdir we'd double-count
          const isCanonical = existsSync(join(sub, ".obsidian"));
          const noteCount = countNotes(sub);
          if (!isCanonical && noteCount === 0) continue;
          out.push({
            slug: entry.name,
            name: entry.name,
            path: sub,
            note_count: noteCount,
          });
        }
      } catch { /* ignore */ }
      return out;
    }

    function resolveVaultPath(vaultSlug: string): string | null {
      const vaults = listVaultRoots();
      const v = vaults.find((x) => x.slug === vaultSlug);
      return v ? v.path : null;
    }

    // Path safety — reject anything containing `..` or absolute references.
    // Returns the resolved absolute path if safe, null otherwise.
    function safeJoinUnder(root: string, rel: string): string | null {
      if (!rel) return null;
      if (rel.includes("\0") || rel.startsWith("/") || rel.startsWith("~")) return null;
      const normalized = rel.replace(/\\/g, "/");
      if (normalized.split("/").some((seg) => seg === "..")) return null;
      const abs = join(root, normalized);
      // Defensive: confirm the resolved path actually lives under root.
      if (!abs.startsWith(root + "/") && abs !== root) return null;
      return abs;
    }

    if (url.pathname === "/api/vault/roots" && req.method === "GET") {
      return Response.json({ ok: true, vaults: listVaultRoots() });
    }

    {
      const m = url.pathname.match(/^\/api\/vault\/([^/]+)\/tree$/);
      if (m && req.method === "GET") {
        const vaultSlug = decodeURIComponent(m[1]!);
        const root = resolveVaultPath(vaultSlug);
        if (!root) return Response.json({ ok: false, error: "vault not found" }, { status: 404 });
        // Recursive .md tree, depth-first, sorted dirs-before-files alphabetical.
        type Node =
          | { kind: "dir"; name: string; path: string; children: Node[] }
          | { kind: "note"; name: string; path: string; size: number; mtime: string };
        function walk(dir: string, relPrefix: string): Node[] {
          const out: Node[] = [];
          let entries;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return out;
          }
          const dirs: Node[] = [];
          const notes: Node[] = [];
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const full = join(dir, e.name);
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
              const children = walk(full, rel);
              if (children.length > 0) {
                dirs.push({ kind: "dir", name: e.name, path: rel, children });
              }
            } else if (e.name.endsWith(".md")) {
              try {
                const st = require("node:fs").statSync(full);
                notes.push({
                  kind: "note",
                  name: e.name,
                  path: rel,
                  size: st.size,
                  mtime: new Date(st.mtimeMs).toISOString(),
                });
              } catch { /* skip */ }
            }
          }
          dirs.sort((a, b) => a.name.localeCompare(b.name));
          notes.sort((a, b) => a.name.localeCompare(b.name));
          out.push(...dirs, ...notes);
          return out;
        }
        return Response.json({
          ok: true,
          vault: vaultSlug,
          root,
          tree: walk(root, ""),
        });
      }
    }

    {
      const m = url.pathname.match(/^\/api\/vault\/([^/]+)\/note$/);
      if (m && req.method === "GET") {
        const vaultSlug = decodeURIComponent(m[1]!);
        const rel = url.searchParams.get("path") || "";
        const root = resolveVaultPath(vaultSlug);
        if (!root) return Response.json({ ok: false, error: "vault not found" }, { status: 404 });
        const abs = safeJoinUnder(root, rel);
        if (!abs || !abs.endsWith(".md") || !existsSync(abs)) {
          return Response.json({ ok: false, error: "note not found" }, { status: 404 });
        }
        let raw: string;
        try {
          raw = readFileSync(abs, "utf8");
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
        }
        // Parse YAML frontmatter (between leading --- … ---). Naive parser:
        // supports key: value pairs, no nesting / multiline. Anything fancier
        // can be added when a note actually uses it.
        let frontmatter: Record<string, string> | null = null;
        let body = raw;
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (fmMatch) {
          frontmatter = {};
          for (const line of fmMatch[1].split(/\r?\n/)) {
            const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
            if (kv) frontmatter[kv[1]] = kv[2].trim();
          }
          body = raw.slice(fmMatch[0].length);
        }
        const st = require("node:fs").statSync(abs);
        return Response.json({
          ok: true,
          vault: vaultSlug,
          path: rel,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          frontmatter,
          body,
        });
      }
    }

    {
      const m = url.pathname.match(/^\/api\/vault\/([^/]+)\/asset$/);
      if (m && req.method === "GET") {
        const vaultSlug = decodeURIComponent(m[1]!);
        const rel = url.searchParams.get("path") || "";
        const root = resolveVaultPath(vaultSlug);
        if (!root) return new Response("vault not found", { status: 404 });
        const abs = safeJoinUnder(root, rel);
        if (!abs || !existsSync(abs)) return new Response("asset not found", { status: 404 });
        const lower = abs.toLowerCase();
        let mime = "application/octet-stream";
        if (lower.endsWith(".png")) mime = "image/png";
        else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
        else if (lower.endsWith(".gif")) mime = "image/gif";
        else if (lower.endsWith(".svg")) mime = "image/svg+xml";
        else if (lower.endsWith(".pdf")) mime = "application/pdf";
        else if (lower.endsWith(".webp")) mime = "image/webp";
        try {
          return new Response(readFileSync(abs), {
            headers: { "Content-Type": mime, "Cache-Control": "max-age=300" },
          });
        } catch {
          return new Response("read error", { status: 500 });
        }
      }
    }

    // ── /api/memory — Obsidian + vault state ─────────────────────────────
    if (url.pathname === "/api/memory") {
      const obsidianApp = "/Applications/Obsidian.app";
      const obsidianInstalled = existsSync(obsidianApp);
      // Configured vault root (from dashboard Settings) takes precedence
      let configuredRoot: string | null = null;
      try {
        const cfgPath = join(SUBCTL_CONFIG_DIR, "evy", "obsidian.json");
        if (existsSync(cfgPath)) {
          const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
          if (j.vault_root) configuredRoot = j.vault_root.replace(/^~/, process.env.HOME ?? "");
        }
      } catch { /* ignore */ }
      const candidates = configuredRoot ? [configuredRoot] : [
        `${process.env.HOME}/Documents/Obsidian Vault`,
        `${process.env.HOME}/Documents/ObsidianVault`,
        `${process.env.HOME}/Obsidian`,
        `${process.env.HOME}/vaults`,
      ];
      const vaults: Array<{ path: string; note_count: number; last_modified: string | null }> = [];
      for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        try {
          const entries = readdirSync(candidate, { withFileTypes: true });
          // Each subdir with a .obsidian/ dir is a vault root
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const vaultDir = join(candidate, entry.name);
            if (!existsSync(join(vaultDir, ".obsidian"))) continue;
            // Count .md files (one level deep is plenty for the index)
            let count = 0;
            const stack = [vaultDir];
            while (stack.length && count < 5000) {
              const cur = stack.pop()!;
              for (const e of readdirSync(cur, { withFileTypes: true })) {
                if (e.name.startsWith(".")) continue;
                const p = join(cur, e.name);
                if (e.isDirectory()) stack.push(p);
                else if (e.name.endsWith(".md")) count++;
              }
            }
            const stat = require("node:fs").statSync(vaultDir);
            vaults.push({
              path: vaultDir,
              note_count: count,
              last_modified: new Date(stat.mtimeMs).toISOString(),
            });
          }
        } catch { /* ignore */ }
      }
      return Response.json({
        ok: true,
        obsidian_installed: obsidianInstalled,
        obsidian_app_path: obsidianInstalled ? obsidianApp : null,
        vaults,
        suggested_install: "brew install --cask obsidian",
        suggested_vault_path: `${process.env.HOME}/Documents/Obsidian Vault`,
      });
    }
    if (url.pathname === "/api/version") {
      return new Response(JSON.stringify({ version: readSubctlVersion() }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    // ── /api/update/check — is origin/main ahead of the running daemon? ───
    //
    // GET → { running_version, latest_tag, has_update, channel, stale?, error? }
    //
    // Runs `git ls-remote --tags origin` with a 5s timeout. Caches the
    // latest_tag for 5min so the periodic poll (every 5min from app.js) doesn't
    // hammer github. On network failure, serves the stale cached value so a
    // flaky remote doesn't flip has_update to false mid-session. Broadcasts
    // an `update_available` SSE event the first time has_update becomes true
    // (de-duped via cache state).
    if (url.pathname === "/api/update/check" && req.method === "GET") {
      const running = readSubctlVersion();
      const now = Date.now();
      const forceRefresh = url.searchParams.get("force") === "1";
      // Operator override hatch for live testing — env var or query param
      // pins a synthetic latest_tag so we can verify the wiggle/modal path
      // without waiting for a real release.
      const stub = url.searchParams.get("stub_latest") ?? process.env.SUBCTL_UPDATE_STUB_LATEST;

      let cache = _updateCheckCache;
      let usedStub = false;
      let stale = false;

      if (stub && stub.length > 0) {
        cache = { latest_tag: stub, fetched_at: now, stale: false };
        usedStub = true;
      } else if (!cache || forceRefresh || now - cache.fetched_at > UPDATE_CHECK_TTL_MS) {
        // Probe the remote. spawnSync with explicit args, 5s budget.
        try {
          const r = spawnSync(
            GIT_BIN,
            ["-C", REPO_ROOT, "ls-remote", "--tags", "--refs", "origin"],
            { encoding: "utf8", timeout: 5000 },
          );
          if (r.status === 0 && r.stdout) {
            // Lines like: <sha>\trefs/tags/v2.8.7
            const tags: string[] = [];
            for (const line of r.stdout.split("\n")) {
              const m = line.match(/refs\/tags\/(\S+)/);
              if (m && m[1] && /^v?\d+\.\d+\.\d+/.test(m[1])) tags.push(m[1]);
            }
            if (tags.length > 0) {
              tags.sort(cmpSemver);
              const latest = tags[tags.length - 1]!;
              cache = { latest_tag: latest, fetched_at: now, stale: false };
              _updateCheckCache = cache;
            } else if (cache) {
              cache.stale = true;
              stale = true;
            }
          } else if (cache) {
            cache.stale = true;
            stale = true;
          }
        } catch {
          if (cache) {
            cache.stale = true;
            stale = true;
          }
        }
      }

      const latest_tag = cache?.latest_tag ?? null;
      const has_update = latest_tag !== null && cmpSemver(latest_tag, running) > 0;

      // First-rising-edge broadcast: emit `update_available` when an open
      // SSE client should be notified that an update just appeared. We
      // de-dupe by stashing the last-broadcast tag on the cache so the same
      // tag doesn't fire repeatedly across the 5-min poll cycle.
      if (has_update && latest_tag && !usedStub) {
        const sentinel = (_updateCheckCache as any)?.__broadcastedTag;
        if (sentinel !== latest_tag) {
          publishUpdateEvent("update_available", {
            running_version: running,
            latest_tag,
            channel: "stable",
          });
          if (_updateCheckCache) (_updateCheckCache as any).__broadcastedTag = latest_tag;
        }
      }

      return Response.json({
        running_version: running,
        latest_tag,
        has_update,
        channel: "stable",
        stale: stale || (cache?.stale ?? false),
        ...(usedStub ? { stub: true } : {}),
      });
    }

    // ── /api/update/events — SSE stream for update_progress + update_available
    if (url.pathname === "/api/update/events" && req.method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const subscriber: UpdateEventSubscriber = {
            write(chunk) {
              try { controller.enqueue(enc.encode(chunk)); } catch { /* closed */ }
            },
            close() {
              try { controller.close(); } catch { /* closed */ }
            },
          };
          updateEventSubscribers.add(subscriber);

          // Replay buffered events so a late-joining modal sees what the
          // run produced before its EventSource handshake completed.
          for (const ev of updateEventBuffer) {
            subscriber.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
          }
          // If a run is in flight, send a synthetic update_running event
          // so the modal can paint the right state on open.
          if (_updateRunInFlight) {
            subscriber.write(
              `event: update_running\ndata: ${JSON.stringify(_updateRunInFlight)}\n\n`,
            );
          }
          // Keep-alive every 15s for proxies / Bun's internal idle reaper.
          const keepAlive = setInterval(() => { subscriber.write(": ka\n\n"); }, 15_000);
          req.signal.addEventListener("abort", () => {
            clearInterval(keepAlive);
            updateEventSubscribers.delete(subscriber);
            subscriber.close();
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── /api/update/run — execute one of the three subctl update verbs ────
    //
    // POST body: { mode: "dashboard-deploy" | "fast-deploy" | "full-update" }
    //
    // Spawns the corresponding `bin/subctl` CLI invocation. stdout/stderr
    // lines are streamed to /api/update/events as `update_progress` events
    // (one event per line). Per-mode timeouts surface as a `timeout` event +
    // a 408 response. Returns { ok, exitCode, mode, started_at, finished_at }.
    if (url.pathname === "/api/update/run" && req.method === "POST") {
      if (_updateRunInFlight) {
        return Response.json(
          {
            ok: false,
            error: `update already running: ${_updateRunInFlight.mode} (started ${new Date(_updateRunInFlight.started_at).toISOString()})`,
          },
          { status: 409 },
        );
      }
      let body: { mode?: string } = {};
      try { body = (await req.json()) as { mode?: string }; } catch { /* body optional */ }
      const mode = String(body.mode ?? "");
      const MODES: Record<string, { args: string[]; timeoutMs: number }> = {
        "dashboard-deploy": { args: ["dashboard", "deploy"], timeoutMs: 60_000 },
        "fast-deploy":      { args: ["deploy"],              timeoutMs: 120_000 },
        "full-update":      { args: ["update"],              timeoutMs: 600_000 },
      };
      const spec = MODES[mode];
      if (!spec) {
        return Response.json(
          { ok: false, error: `unknown mode: ${mode || "(missing)"}; expected dashboard-deploy|fast-deploy|full-update` },
          { status: 400 },
        );
      }
      const started_at = Date.now();
      _updateRunInFlight = { mode, started_at };
      publishUpdateEvent("update_started", { mode, args: spec.args, started_at });

      // Bun.spawn streams stdout + stderr line-by-line via web-stream readers.
      // Stay off shell strings — explicit argv prevents injection.
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc?.kill(15); } catch { /* already exited */ }
        // Escalate if the child doesn't exit after a grace window.
        setTimeout(() => { try { proc?.kill(9); } catch { /* ignore */ } }, 3000);
      }, spec.timeoutMs);

      try {
        proc = Bun.spawn([SUBCTL_BIN, ...spec.args], {
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        const pumpLines = async (
          reader: ReadableStreamDefaultReader<Uint8Array>,
          stream: "stdout" | "stderr",
        ) => {
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              if (buf.length > 0) {
                publishUpdateEvent("update_progress", { mode, stream, line: buf });
              }
              break;
            }
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).replace(/\r$/, "");
              buf = buf.slice(idx + 1);
              publishUpdateEvent("update_progress", { mode, stream, line });
            }
          }
        };

        const outReader = proc.stdout.getReader();
        const errReader = proc.stderr.getReader();
        const pumps = Promise.all([
          pumpLines(outReader, "stdout"),
          pumpLines(errReader, "stderr"),
        ]);

        const exitCode = await proc.exited;
        await pumps;
        clearTimeout(timer);

        const finished_at = Date.now();
        if (timedOut) {
          publishUpdateEvent("update_finished", {
            mode, exitCode, ok: false, timeout: true, started_at, finished_at,
          });
          return Response.json(
            { ok: false, mode, exitCode, started_at, finished_at, error: `timeout after ${spec.timeoutMs}ms` },
            { status: 408 },
          );
        }
        const ok = exitCode === 0;
        publishUpdateEvent("update_finished", { mode, exitCode, ok, started_at, finished_at });
        // Invalidate the version-check cache so the next poll reflects the
        // post-update VERSION immediately.
        _updateCheckCache = null;
        return Response.json({ ok, mode, exitCode, started_at, finished_at });
      } catch (err) {
        clearTimeout(timer);
        const finished_at = Date.now();
        const message = (err as Error).message ?? String(err);
        publishUpdateEvent("update_finished", {
          mode, exitCode: -1, ok: false, error: message, started_at, finished_at,
        });
        return Response.json(
          { ok: false, mode, exitCode: -1, started_at, finished_at, error: message },
          { status: 500 },
        );
      } finally {
        _updateRunInFlight = null;
      }
    }
    // ── /api/providers — list available providers + their profiles + which
    //    are usable as supervisor right now (auth status + load state) ─────
    if (url.pathname === "/api/providers" && req.method === "GET") {
      // Provider catalog. Local-first: lmstudio shows up with its model
      // catalog; cloud providers show up if at least one ready profile.
      const providers: Array<Record<string, unknown>> = [];

      // 1. lmstudio — query LM Studio API directly for loaded state.
      // v2.8.7 — pulls through the shared 30s response cache (same
      // upstream call used by /api/models). Single fetch coalesces
      // across both endpoints + all concurrent clients.
      const lmHost = process.env.SUBCTL_LMSTUDIO_HOST ?? "http://localhost:1234";
      try {
        const j = await getLmstudioModels(lmHost);
        const models = (j.data ?? []).filter((m) => m.type === "vlm" || m.type === "llm");
        providers.push({
          id: "lmstudio",
          display: "LM Studio (local)",
          kind: "local",
          host: lmHost,
          available: true,
          note: "Always-on local inference. Per-model availability depends on LM Studio's loaded state.",
          models: models.map((m) => ({
            id: m.id,
            state: m.state,                  // "loaded" | "not-loaded"
            loaded: m.state === "loaded",
            quantization: m.quantization,
            loaded_context_length: m.loaded_context_length,
            max_context_length: m.max_context_length,
            capabilities: m.capabilities ?? [],
          })),
        });
      } catch { /* lmstudio offline or auth-rejected; skip */ }

      // 2. accounts.conf — find any cloud providers with at least one
      //    authenticated profile. Pull the relevant profile metadata.
      const accountsPath = join(SUBCTL_CONFIG_DIR, "accounts.conf");
      const profilesByProvider: Record<string, Array<Record<string, unknown>>> = {};
      try {
        if (existsSync(accountsPath)) {
          const raw = readFileSync(accountsPath, "utf8");
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const parts = trimmed.split("|").map((p) => p.trim());
            if (parts.length < 4) continue;
            const [alias, provider, email, configDirRaw, description = ""] = parts;
            const configDir = configDirRaw!.replace(/^~/, process.env.HOME ?? "");
            // Auth detection per provider (matches /api/settings/oauth)
            let authed = false;
            if (provider === "claude") {
              // Claude Code keeps the OAuth bearer token in macOS Keychain;
              // .claude.json is the per-config-dir state file that gets
              // written the first time the profile is used. Pre-v2026.x
              // versions used .credentials.json — left as fallback for
              // operators still on those builds. Either-or: if any of the
              // expected markers is present at non-trivial size, treat the
              // profile as authed. Keychain-only detection would require
              // shelling out to `security find-generic-password`, which is
              // too invasive for a hot /api/providers handler.
              const markers = [".claude.json", ".credentials.json"];
              for (const m of markers) {
                const path = join(configDir, m);
                if (!existsSync(path)) continue;
                try {
                  const st = statSync(path);
                  if (st.size > 100) { authed = true; break; }
                } catch { /* ignore */ }
              }
            } else if (provider === "openai" || provider === "openai-codex") {
              // openai-codex was missing from this chain before v2.8.9 — every
              // codex profile rendered as unauthenticated regardless of what
              // was on disk. Both providers persist tokens in <configDir>/auth.json
              // with the same shape (top-level `tokens` object with access_token +
              // refresh_token), so the check is identical.
              const codexAuth = join(configDir, "auth.json");
              if (existsSync(codexAuth)) {
                try {
                  const j = JSON.parse(readFileSync(codexAuth, "utf8"));
                  authed = !!(j && (j.tokens || j.access_token));
                } catch { authed = false; }
              }
            }
            (profilesByProvider[provider!] ??= []).push({
              alias, email, config_dir: configDirRaw, description, authed,
            });
          }
        }
      } catch { /* ignore */ }

      // v2.7.24 — pi-ai catalog drives the cloud-provider list. Anything
      // pi-ai exports is surfaced. The hand-curated `(future)` tags are
      // gone: every catalog entry is available; operators that don't have
      // an account yet just have an empty `profiles` list. Backwards
      // compat: legacy subctl ids (`claude`, `gemini`) in accounts.conf
      // are routed to their pi-ai canonicals (`anthropic`, `google`)
      // via SUBCTL_TO_PI_AI so existing profiles still attach.
      const catalog: CatalogProvider[] = listCatalogProviders();

      // v2.9.1 — Provider Model Catalog Phase 3 — aggregator routing.
      // Hard-coded set of provider ids that route through an aggregator
      // catalog (one upstream serves ~30 downstream providers). Mirrors
      // AGGREGATOR_PROVIDER_IDS in components/evy/aggregator-clients.ts;
      // keep the two lists in sync. The flag gates the "Browse Upstream
      // Catalog" button in the Providers tab UI.
      const AGGREGATOR_PROVIDER_IDS = new Set([
        "openrouter",
        "amazon-bedrock",
        "vercel-ai-gateway",
        "cloudflare-ai-gateway",
      ]);

      // Build a profiles-by-pi-ai-id index that respects the alias map.
      const profilesByPiId: Record<string, Array<Record<string, unknown>>> = {};
      for (const [legacyOrCanonical, profiles] of Object.entries(profilesByProvider)) {
        const canonical = resolveProviderId(legacyOrCanonical);
        (profilesByPiId[canonical] ??= []).push(...profiles);
      }

      for (const entry of catalog) {
        const profiles = profilesByPiId[entry.id] ?? [];
        const anyAuthed = profiles.some((p) => (p as { authed?: boolean }).authed);
        providers.push({
          id: entry.id,
          display: entry.display_name,
          kind: entry.kind,
          auth_method: entry.auth_method,
          model_count: entry.model_count,
          available: entry.available,
          // v2.9.1 Phase 3 — routes through an aggregator's upstream
          // catalog (browse-and-pick UX in Providers tab).
          is_aggregator: AGGREGATOR_PROVIDER_IDS.has(entry.id),
          // v2.8.8 Phase 1a — surface the EFFECTIVE default model (operator
          // override if set, else shipped fallback) plus its source so the
          // UI can render "★ operator" vs "shipped" badges. The default_model
          // field on `entry` is the shipped value only; the override lives
          // in ~/.config/subctl/provider-defaults.json.
          default_model: getDefaultModel(entry.id) ?? null,
          default_model_source: getDefaultModelWithSource(entry.id).source,
          // v2.8.9 — whether the current default_model is enabled in the
          // catalog. If the operator disabled their currently-default model
          // via the Models panel checkbox, this returns false and the chat
          // dropdown disables the option. true when no cache exists yet
          // (operator hasn't touched defaults; assume on).
          default_model_enabled: (() => {
            const def = getDefaultModel(entry.id);
            if (!def) return true; // no default; not gating
            try {
              const cached = getCatalog(entry.id);
              const target = cached.models.find((m) => m.id === def);
              return target?.enabled !== false;
            } catch {
              return true; // catalog read fails → assume enabled
            }
          })(),
          // v2.8.17 — every catalog model the operator has enabled. The
          // chat-tab dropdown enumerates one <option> per entry (cloud
          // providers only) so non-default models the operator opted in
          // are actually selectable as the supervisor. Empty when the
          // catalog hasn't been derived yet — the chat tab then falls
          // back to the single default_model row.
          enabled_models: (() => {
            try {
              const cached = getCatalog(entry.id);
              return cached.models
                .filter((m) => m.enabled !== false)
                .map((m) => ({ id: m.id, name: m.name }));
            } catch {
              return [];
            }
          })(),
          // Surface a legacy alias when one exists so the UI can render
          // `subctl auth <legacy> <alias>` correctly without having to
          // know the alias table.
          legacy_alias: legacyAliasFor(entry.id) === entry.id ? null : legacyAliasFor(entry.id),
          profiles,
          note: entry.notes ?? (anyAuthed
            ? `${profiles.filter((p) => (p as { authed?: boolean }).authed).length} authed profile(s)`
            : "no profile yet — add one via + New Profile"),
        });
      }

      // Catch-all: surface any accounts.conf provider that pi-ai doesn't
      // know about. Should be empty in practice (the alias table covers
      // every historical name), but a stale entry shouldn't disappear
      // from the dashboard — the operator needs to see it to clean it up.
      const knownPiIds = new Set(catalog.map((c) => c.id));
      for (const [provider, profiles] of Object.entries(profilesByPiId)) {
        if (knownPiIds.has(provider)) continue;
        providers.push({
          id: provider,
          display: provider,
          kind: "cloud",
          auth_method: "api-key",
          available: false,
          profiles,
          note: "unknown provider — not in pi-ai catalog; remove or rename",
        });
      }

      return Response.json({ ok: true, providers });
    }

    // ── /api/catalogs — v2.8.8 Phase 2 — per-provider model catalogs ────
    // GET /api/catalogs                — list every cached catalog file
    // GET /api/catalogs/<provider>     — single catalog (cache or pi-ai bundle)
    // POST /api/catalogs/<provider>/refresh — re-derive + persist (Phase 2b)
    if (url.pathname === "/api/catalogs" && req.method === "GET") {
      const cached = listCachedCatalogs();
      // For providers that have no on-disk cache yet, surface a thin
      // record so the UI knows they exist and can offer "Refresh" without
      // pre-populating every catalog at boot time.
      const piAiProviderIds = new Set(listCatalogProviders().map((p) => p.id));
      const cachedIds = new Set(cached.map((c) => c.provider));
      const uncached: Array<{ provider: string; cached: false; models_in_bundle: number }> = [];
      for (const id of piAiProviderIds) {
        if (cachedIds.has(id)) continue;
        const bundle = getCatalog(id);
        uncached.push({
          provider: id,
          cached: false,
          models_in_bundle: bundle.models.length,
        });
      }
      return Response.json({
        ok: true,
        cached: cached.map((c) => ({
          provider: c.provider,
          source: c.source,
          fetched_at: c.fetched_at,
          model_count: c.models.length,
          source_url: c.source_url ?? null,
        })),
        uncached,
      });
    }
    if (url.pathname.startsWith("/api/catalogs/") && req.method === "GET") {
      // /api/catalogs/<provider>  — single-provider read. Trailing /refresh
      // is handled by the POST branch below; bare GET returns the catalog.
      const provider = url.pathname.slice("/api/catalogs/".length).replace(/\/+$/, "");
      if (!provider || provider.includes("/")) {
        return Response.json(
          { ok: false, error: "expected /api/catalogs/<provider>" },
          { status: 400 },
        );
      }
      if (!isKnownProvider(provider)) {
        return Response.json(
          { ok: false, error: `unknown provider "${provider}"` },
          { status: 404 },
        );
      }
      return Response.json({ ok: true, catalog: getCatalog(provider) });
    }
    // POST /api/catalogs/<provider>/models/enabled-all
    //   body: { enabled: boolean }
    // v2.8.17 — bulk toggle. Flips EVERY model in the provider's catalog
    // on or off in one write. Backs the "Enable all" / "Disable all"
    // buttons in the Providers-tab model table. Checked BEFORE the
    // per-model /enabled branch below — `/models/enabled-all` does not end
    // in `/enabled`, but listing it first keeps routing unambiguous.
    if (
      url.pathname.startsWith("/api/catalogs/") &&
      url.pathname.endsWith("/models/enabled-all") &&
      req.method === "POST"
    ) {
      const provider = url.pathname
        .slice("/api/catalogs/".length, url.pathname.length - "/models/enabled-all".length)
        .replace(/\/+$/, "");
      if (!provider || provider.includes("/")) {
        return Response.json(
          { ok: false, error: "expected /api/catalogs/<provider>/models/enabled-all" },
          { status: 400 },
        );
      }
      if (!isKnownProvider(provider)) {
        return Response.json(
          { ok: false, error: `unknown provider "${provider}"` },
          { status: 404 },
        );
      }
      let body: { enabled?: boolean };
      try { body = await req.json(); }
      catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.enabled !== "boolean") {
        return Response.json(
          { ok: false, error: "body.enabled must be a boolean" },
          { status: 400 },
        );
      }
      try {
        const updated = setAllModelsEnabled(provider, body.enabled);
        return Response.json({
          ok: true,
          provider: updated.provider,
          enabled: body.enabled,
          model_count: updated.models.length,
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }
    // POST /api/catalogs/<provider>/models/<model_id>/enabled
    //   body: { enabled: boolean }
    // Flips a per-model enabled flag in the cached catalog file. UI surface:
    // checkbox in the Models panel. Effect: future consumers (chat dropdown
    // filtering, default_model picker) can honour the flag. Today it's a
    // persistence-only feature — no consumer code filters by it yet.
    if (
      url.pathname.startsWith("/api/catalogs/") &&
      url.pathname.endsWith("/enabled") &&
      req.method === "POST"
    ) {
      // Path: /api/catalogs/<provider>/models/<model_id>/enabled
      const inner = url.pathname.slice("/api/catalogs/".length, url.pathname.length - "/enabled".length);
      const [provider, modelsLit, ...modelIdParts] = inner.split("/");
      if (!provider || modelsLit !== "models" || modelIdParts.length === 0) {
        return Response.json(
          {
            ok: false,
            error: "expected /api/catalogs/<provider>/models/<model_id>/enabled",
          },
          { status: 400 },
        );
      }
      const modelId = modelIdParts.join("/"); // model ids can contain slashes (openrouter)
      if (!isKnownProvider(provider)) {
        return Response.json(
          { ok: false, error: `unknown provider "${provider}"` },
          { status: 404 },
        );
      }
      let body: { enabled?: boolean };
      try { body = await req.json(); }
      catch { return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
      if (typeof body.enabled !== "boolean") {
        return Response.json(
          { ok: false, error: "body.enabled must be a boolean" },
          { status: 400 },
        );
      }
      try {
        const updated = setModelEnabled(provider, modelId, body.enabled);
        const target = updated.models.find((m) => m.id === modelId);
        return Response.json({
          ok: true,
          provider: updated.provider,
          model: modelId,
          enabled: target?.enabled ?? body.enabled,
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 404 },
        );
      }
    }
    if (
      url.pathname.startsWith("/api/catalogs/") &&
      url.pathname.endsWith("/refresh") &&
      req.method === "POST"
    ) {
      // POST /api/catalogs/<provider>/refresh — re-derive and persist.
      // Live-fetches for providers with a public /models endpoint (anthropic,
      // openrouter today); other providers fall back to a fresh pi-ai bundle
      // derivation. The endpoint is idempotent: calling repeatedly just
      // re-derives. Concurrency: per-file writes are atomic on macOS, so
      // overlapping refreshes settle on whichever finishes last.
      const provider = url.pathname
        .slice("/api/catalogs/".length, url.pathname.length - "/refresh".length)
        .replace(/\/+$/, "");
      if (!provider || provider.includes("/")) {
        return Response.json(
          { ok: false, error: "expected /api/catalogs/<provider>/refresh" },
          { status: 400 },
        );
      }
      if (!isKnownProvider(provider)) {
        return Response.json(
          { ok: false, error: `unknown provider "${provider}"` },
          { status: 404 },
        );
      }
      try {
        const { catalog, notice } = await refreshCatalog(provider);
        saveCatalog(catalog);
        return Response.json({
          ok: true,
          catalog,
          notice: notice ?? null,
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: `refresh failed: ${(err as Error).message}`,
          },
          { status: 500 },
        );
      }
    }

    // ── /api/providers/<provider>/default-model — v2.8.9 operator override ──
    //
    // Operator-pickable default per provider. Persists to
    // ~/.config/subctl/provider-defaults.json so the operator's choice
    // survives subctl upgrades (shipped defaults in pi-ai-catalog.ts are
    // just fallbacks).
    //
    //   GET    → { ok, provider, default_model, source: operator|shipped|none }
    //   POST   { model: string } → write override, returns new state
    //   DELETE → clear override, fall back to shipped
    if (url.pathname.startsWith("/api/providers/") && url.pathname.endsWith("/default-model")) {
      const provider = url.pathname
        .slice("/api/providers/".length, url.pathname.length - "/default-model".length)
        .replace(/\/+$/, "");
      if (!provider || provider.includes("/")) {
        return Response.json(
          { ok: false, error: "expected /api/providers/<provider>/default-model" },
          { status: 400 },
        );
      }
      if (!isCatalogProvider(provider)) {
        return Response.json(
          { ok: false, error: `unknown provider "${provider}"` },
          { status: 404 },
        );
      }
      if (req.method === "GET") {
        const { model, source } = getDefaultModelWithSource(provider);
        return Response.json({
          ok: true,
          provider: resolveProviderId(provider),
          default_model: model ?? null,
          source,
        });
      }
      if (req.method === "POST") {
        let body: { model?: string };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const model = (body.model ?? "").trim();
        if (!model || isObviouslyInvalidModel(model)) {
          return Response.json(
            { ok: false, error: "model required (non-empty string)" },
            { status: 400 },
          );
        }
        setProviderDefault(provider, model);
        const { model: resolved, source } = getDefaultModelWithSource(provider);
        return Response.json({
          ok: true,
          provider: resolveProviderId(provider),
          default_model: resolved,
          source,
        });
      }
      if (req.method === "DELETE") {
        clearProviderDefault(provider);
        const { model: resolved, source } = getDefaultModelWithSource(provider);
        return Response.json({
          ok: true,
          provider: resolveProviderId(provider),
          default_model: resolved,
          source,
        });
      }
      return Response.json(
        { ok: false, error: "method must be GET, POST, or DELETE" },
        { status: 405 },
      );
    }

    // ── /api/auth/openai-codex — v2.8.9 device-code OAuth via dashboard ───
    //
    // Three endpoints + module-level session state:
    //   POST /api/auth/openai-codex/<alias>/start   — kick off the flow
    //   GET  /api/auth/openai-codex/<alias>/events  — SSE: verification,
    //                                                 progress, success, failed
    //   POST /api/auth/openai-codex/<alias>/cancel  — abort in-flight flow
    //
    // The dashboard modal POSTs /start, opens an EventSource on /events,
    // renders the verification URL + user_code when the `verification`
    // event arrives, then closes on `success` or `failed`. Closing the
    // modal mid-flow POSTs /cancel which trips the AbortSignal in
    // codex-oauth.ts's pollDeviceCode, stopping the server-side poll.
    if (url.pathname.startsWith("/api/auth/openai-codex/")) {
      const tail = url.pathname.slice("/api/auth/openai-codex/".length);
      const [alias, action] = tail.split("/");
      if (!alias || !action) {
        return Response.json(
          { ok: false, error: "expected /api/auth/openai-codex/<alias>/<action>" },
          { status: 400 },
        );
      }

      // Look up the alias's config_dir + email from accounts.conf so the
      // flow knows where to write auth.json. Reject unknown aliases.
      const rows = loadAccountsConf();
      const row = rows.find((r) => r.alias === alias && r.provider === "openai-codex");
      if (!row) {
        return Response.json(
          {
            ok: false,
            error: `unknown openai-codex alias "${alias}" — add to accounts.conf first`,
          },
          { status: 404 },
        );
      }

      if (action === "start" && req.method === "POST") {
        if (codexAuthSessions.has(alias)) {
          return Response.json(
            {
              ok: false,
              error: `auth flow already in progress for ${alias} — cancel it first or wait`,
            },
            { status: 409 },
          );
        }
        const session: CodexAuthSession = {
          alias,
          configDir: row.configDir,
          email: row.email,
          abortController: new AbortController(),
          subscribers: new Set(),
          events: [],
          state: "starting",
        };
        codexAuthSessions.set(alias, session);

        // Kick the flow in the background. Use void to detach — the
        // promise resolves/rejects independently; we don't await here.
        void (async () => {
          try {
            const result = await completeCodexLogin({
              alias: row.alias,
              configDir: row.configDir,
              email: row.email,
              signal: session.abortController.signal,
              onVerification: (prompt: DeviceCodePrompt) => {
                publishCodexAuthEvent(session, {
                  type: "verification",
                  verification_url: prompt.verificationUrl,
                  user_code: prompt.userCode,
                  expires_in_ms: prompt.expiresInMs,
                });
                session.state = "awaiting_authorization";
                publishCodexAuthEvent(session, {
                  type: "progress",
                  message: "Open the URL, enter the code, click Authorize. Waiting…",
                });
              },
              onProgress: (message: string) => {
                publishCodexAuthEvent(session, { type: "progress", message });
              },
            });
            session.state = "success";
            publishCodexAuthEvent(session, {
              type: "success",
              alias: result.alias,
              auth_path: result.authPath,
              expires_at: new Date(result.expires_at_ms).toISOString(),
              chatgpt_account_id: result.chatgpt_account_id ?? null,
            });
          } catch (err) {
            session.state = "failed";
            publishCodexAuthEvent(session, {
              type: "failed",
              error: (err as Error).message,
            });
          } finally {
            // Hold the session in the map for ~30s after completion so a
            // late-joining EventSource still gets the terminal event,
            // then GC. Subscribers that aren't drained by then miss it,
            // which is fine — they can re-POST /start.
            setTimeout(() => {
              codexAuthSessions.delete(alias);
              for (const s of session.subscribers) {
                try { s.write("event: closed\ndata: {}\n\n"); } catch { /* ignore */ }
              }
              session.subscribers.clear();
            }, 30_000);
          }
        })();

        return Response.json({
          ok: true,
          session: { alias, state: session.state },
          events_url: `/api/auth/openai-codex/${alias}/events`,
        });
      }

      if (action === "events" && req.method === "GET") {
        const session = codexAuthSessions.get(alias);
        if (!session) {
          return Response.json(
            {
              ok: false,
              error: `no auth session for ${alias} — POST /start first`,
            },
            { status: 404 },
          );
        }
        // SSE response. ReadableStream is supported by Bun's Response.
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const subscriber = {
              write(chunk: string): void {
                try {
                  controller.enqueue(enc.encode(chunk));
                } catch { /* controller closed */ }
              },
              close(): void {
                try { controller.close(); } catch { /* already closed */ }
              },
            };
            session.subscribers.add(subscriber);
            // Replay buffered events for late-joiners (operator clicked
            // start, then took 200ms to open the EventSource).
            for (const ev of session.events) {
              subscriber.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
            }
            // Keep-alive comment every 15s so proxies don't time out.
            const keepAlive = setInterval(() => {
              subscriber.write(": ka\n\n");
            }, 15_000);
            // When the underlying connection drops, drop the subscriber.
            req.signal.addEventListener("abort", () => {
              clearInterval(keepAlive);
              session.subscribers.delete(subscriber);
              subscriber.close();
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      if (action === "cancel" && req.method === "POST") {
        const session = codexAuthSessions.get(alias);
        if (!session) {
          return Response.json(
            { ok: false, error: `no auth session for ${alias}` },
            { status: 404 },
          );
        }
        session.abortController.abort();
        return Response.json({ ok: true, alias, cancelled: true });
      }

      return Response.json(
        {
          ok: false,
          error: `unknown action "${action}" — expected start, events, or cancel`,
        },
        { status: 400 },
      );
    }

    // ── /api/providers/profiles — accounts.conf CRUD ────────────────────
    // GET: returns parsed profiles (same shape as /api/settings/oauth)
    // POST: add/edit a profile
    // DELETE: remove a profile
    if (url.pathname === "/api/providers/profiles" && req.method === "POST") {
      let body: { alias?: string; provider?: string; email?: string; config_dir?: string; description?: string; mode?: "add" | "edit" };
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const { alias, provider, email, config_dir, description = "", mode = "add" } = body;
      if (!alias || !provider || !email || !config_dir) {
        return Response.json({ ok: false, error: "alias, provider, email, config_dir required" }, { status: 400 });
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
        return Response.json({ ok: false, error: "alias must be alphanumerics + . - _" }, { status: 400 });
      }
      // v2.7.24 — validate provider against the pi-ai catalog (after
      // alias resolution). Rejecting unknown providers at write time
      // keeps accounts.conf clean — without this, a typo lands a row
      // that the /api/providers handler can't link to a catalog entry.
      if (!isCatalogProvider(provider)) {
        const hint = Object.keys(SUBCTL_TO_PI_AI).join(", ");
        return Response.json({
          ok: false,
          error: `provider "${provider}" is not in the pi-ai catalog`,
          hint: `known legacy aliases: ${hint}. Otherwise pass a pi-ai canonical id (see /api/providers).`,
        }, { status: 400 });
      }
      const accountsPath = join(SUBCTL_CONFIG_DIR, "accounts.conf");
      let lines: string[] = [];
      if (existsSync(accountsPath)) lines = readFileSync(accountsPath, "utf8").split("\n");
      const newRow = `${alias.padEnd(15)} | ${provider.padEnd(7)} | ${email.padEnd(32)} | ${config_dir.padEnd(25)} | ${description}`;
      // Find existing line for this alias
      const existingIdx = lines.findIndex((l) => {
        const t = l.trim();
        if (!t || t.startsWith("#")) return false;
        const parts = t.split("|").map((p) => p.trim());
        return parts[0] === alias;
      });
      if (mode === "edit") {
        if (existingIdx === -1) return Response.json({ ok: false, error: "alias not found to edit" }, { status: 404 });
        lines[existingIdx] = newRow;
      } else {
        if (existingIdx !== -1) return Response.json({ ok: false, error: `alias '${alias}' already exists` }, { status: 409 });
        lines.push(newRow);
      }
      try {
        const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(SUBCTL_CONFIG_DIR, { recursive: true });
        writeFileSync(accountsPath, lines.join("\n"));
        return Response.json({ ok: true, alias, mode });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }
    if (url.pathname === "/api/providers/profiles" && req.method === "DELETE") {
      let body: { alias?: string };
      try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }
      const { alias } = body;
      if (!alias) return Response.json({ ok: false, error: "alias required" }, { status: 400 });
      const accountsPath = join(SUBCTL_CONFIG_DIR, "accounts.conf");
      if (!existsSync(accountsPath)) return Response.json({ ok: false, error: "accounts.conf missing" }, { status: 404 });
      try {
        const lines = readFileSync(accountsPath, "utf8").split("\n");
        const filtered = lines.filter((l) => {
          const t = l.trim();
          if (!t || t.startsWith("#")) return true;
          const parts = t.split("|").map((p) => p.trim());
          return parts[0] !== alias;
        });
        if (filtered.length === lines.length) return Response.json({ ok: false, error: "alias not found" }, { status: 404 });
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(accountsPath, filtered.join("\n"));
        return Response.json({ ok: true, alias });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }

    // ── /api/master/supervisor — switch the master's supervisor model ────
    // Edits ~/.config/subctl/evy/providers.json (writes the picked id
    // into models.supervisor.model and models.reviewer.model — they share
    // a model in our setup) and bounces the master launchd job. The
    // master's transcript persists across restart, so the switch is
    // effectively in-place.
    if (url.pathname === "/api/master/supervisor" && req.method === "POST") {
      let body: { provider?: string; model?: string; host?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
      }
      const newProvider = (body.provider ?? "").trim();
      let modelId = (body.model ?? "").trim();
      const newHost = (body.host ?? "").trim();

      // v2.8.8 Phase 1b — reject obviously bad model values BEFORE writing
      // providers.json. The unwired-dropdown bug on 2026-05-15 wrote model="?"
      // into providers.json, breaking chat for hours. Catches: empty string,
      // whitespace-only, "?", "-".
      if (isObviouslyInvalidModel(modelId)) {
        // If the operator picked a provider but not a model AND we ship a
        // default for that provider, fill it in rather than 400'ing. Surfaces
        // in the response so the operator sees what was chosen.
        const fallback = newProvider ? getDefaultModel(newProvider) : undefined;
        if (fallback) {
          modelId = fallback;
        } else {
          return Response.json(
            {
              ok: false,
              error: `invalid model "${body.model ?? ""}" — pick a real model id (or set body.provider so we can use its default)`,
              hint: newProvider
                ? `provider "${newProvider}" has no shipped default — supply body.model explicitly`
                : "set body.provider to use its default_model, or supply body.model directly",
            },
            { status: 400 },
          );
        }
      }

      // Guard: refuse to set a provider that pi-ai can't actually call.
      // Mirror of components/evy/server.ts PROVIDER_API table — must stay
      // in sync. If a provider isn't here, master will silently return empty
      // assistant content because pi-ai's stream factory has no api factory
      // for it. Diagnosed 2026-05-10 after openai-codex was selected and
      // every chat turn produced "[]" with `prompt_error_chat: No API key
      // for provider: openai-codex` in decisions.jsonl.
      const WIRED_PROVIDERS = new Set([
        "anthropic",
        "openai",          // API-key-based; works
        "openai-codex",    // v2.8.7 — ChatGPT Pro OAuth via components/evy/openai-codex-auth.ts
        "google",
        "google-vertex",
        "amazon-bedrock",
        "mistral",
        "lmstudio",
        "mlx",
        "ollama",
        "vllm",
        "openrouter",      // v2.7.17 — OpenAI-compat gateway, hundreds of models (incl. free preview tier)
      ]);
      // Local providers — host stays under operator control (or defaults
      // to localhost:1234/v1). Cloud providers — host clears to "" so
      // master's buildModel falls back to the provider's canonical
      // baseURL (DEFAULT_CODEX_BASE_URL for openai-codex,
      // openrouter.ai/api/v1 for openrouter, etc.).
      const LOCAL_PROVIDER_IDS = new Set([
        "lmstudio",
        "mlx",
        "ollama",
        "vllm",
      ]);
      if (newProvider && !WIRED_PROVIDERS.has(newProvider)) {
        return Response.json(
          {
            ok: false,
            error: `provider "${newProvider}" is not wired into pi-ai yet`,
            hint: `wired providers: ${[...WIRED_PROVIDERS].sort().join(", ")}.`,
          },
          { status: 400 },
        );
      }

      const providersPath = join(SUBCTL_CONFIG_DIR, "evy", "providers.json");
      if (!existsSync(providersPath)) {
        return Response.json({ ok: false, error: "providers.json missing" }, { status: 404 });
      }
      try {
        const raw = readFileSync(providersPath, "utf8");
        const stripped = raw.split("\n").filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l)).join("\n").replace(/,(\s*[}\]])/g, "$1");
        const cfg = JSON.parse(stripped) as {
          models?: Record<string, { provider?: string; model?: string; host?: string }>;
        };
        if (!cfg.models?.supervisor) {
          return Response.json({ ok: false, error: "no models.supervisor in providers.json" }, { status: 400 });
        }
        const prev = `${cfg.models.supervisor.provider}/${cfg.models.supervisor.model}`;
        cfg.models.supervisor.model = modelId;
        if (newProvider) cfg.models.supervisor.provider = newProvider;
        // v2.8.8 hot fix — host handling on provider switch:
        //   1. explicit body.host wins (operator override)
        //   2. cloud provider → delete host (pi-ai uses canonical baseUrl)
        //   3. local provider with no host → restore default localhost URL
        //      (without this, a cloud→local switch left host=undefined, so
        //      master fell back to pi-ai's bundled baseUrl which isn't local).
        const DEFAULT_LOCAL_HOST = "http://localhost:1234/v1";
        const applyHost = (
          slot: { host?: string },
        ): void => {
          if (newHost) {
            slot.host = newHost;
          } else if (newProvider && LOCAL_PROVIDER_IDS.has(newProvider)) {
            slot.host = DEFAULT_LOCAL_HOST;
          } else if (newProvider) {
            delete slot.host;
          }
          // No newProvider passed: leave host as-is.
        };
        applyHost(cfg.models.supervisor);
        if (cfg.models.reviewer) {
          cfg.models.reviewer.model = modelId;
          if (newProvider) cfg.models.reviewer.provider = newProvider;
          applyHost(cfg.models.reviewer);
        }
        (cfg as any)._comment = `models.supervisor switched via /api/master/supervisor at ${new Date().toISOString()} (was: ${prev})`;
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(providersPath, JSON.stringify(cfg, null, 2));

        // v2.8.7 — sync profiles.json so the operator's pick survives a
        // master restart. Master overrides supervisorCfg.model + .host
        // from profiles.json[active] at boot (components/evy/server.ts
        // around the let supervisorCfg block); without this sync the
        // restart silently reverts to whatever stale value profiles.json
        // already had. Non-fatal on failure — providers.json was already
        // written and the restart will at least proceed; the swap will
        // appear "stuck" until the next dropdown apply OR a profile-pill
        // toggle.
        let profilesSyncMessage = "profiles.json updated";
        try {
          const profiles = loadProfiles();
          const active = profiles.active;
          // Host policy. Operator intent is "what I select sticks", so we
          // do NOT preserve any prior profile host — that would let a stale
          // custom URL outlive the switch that was supposed to replace it.
          //   - explicit body.host  → use as-is (e.g. proxies, regional)
          //   - local provider, no host  → "http://localhost:1234/v1"
          //   - cloud provider, no host  → "" (master.buildModel falls back
          //     to the provider's canonical baseURL)
          const effectiveProvider =
            newProvider || cfg.models.supervisor.provider || "";
          const resolvedHost = newHost
            ? newHost
            : LOCAL_PROVIDER_IDS.has(effectiveProvider)
              ? "http://localhost:1234/v1"
              : "";
          setProfileEntry(active, { supervisor: modelId, host: resolvedHost });
        } catch (err) {
          profilesSyncMessage = `profiles.json sync FAILED: ${(err as Error).message}`;
          console.error(`[supervisor-switch] ${profilesSyncMessage}`);
        }

        // Bounce master via launchctl. The new daemon's boot-time
        // ensureModelLoaded() will re-pin the LM Studio context for the
        // supervisor (and reviewer) using the freshly-written providers.json,
        // so the new model lands at the right context window automatically.
        const label = "com.subctl.evy";
        const plist = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
        spawnSync("launchctl", ["unload", plist], { encoding: "utf8", timeout: 5000 });
        for (let i = 0; i < 5; i++) {
          const ps = spawnSync("pgrep", ["-f", "subctl.*master/server.ts"], { encoding: "utf8", timeout: 1000 });
          if (!ps.stdout?.trim()) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        spawnSync("launchctl", ["load", plist], { encoding: "utf8", timeout: 5000 });
        return Response.json({
          ok: true,
          previous: prev,
          new: modelId,
          message: `providers.json updated, ${profilesSyncMessage}, master daemon restarted, supervisor will be re-pinned at the configured context_length on first boot tick`,
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }

    // ── /api/watchdogs — watchdog kill controls (v2.7.19) ────────────────
    // Thin pass-through to the master daemon's /watchdogs endpoints.
    //   GET  /api/watchdogs           → { ok, count, watchdogs: [...] }
    //   POST /api/watchdogs/:id/kill  → { ok, killed_id } | { ok:false, error }
    // The dashboard's Watchdogs panel polls the GET every 10s while
    // open. Master owns the registry; the dashboard just renders it.
    if (url.pathname === "/api/watchdogs" && req.method === "GET") {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}/watchdogs`;
      try {
        const upstream = await fetch(masterUrl, { method: "GET" });
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }
    {
      const m = url.pathname.match(/^\/api\/watchdogs\/([A-Za-z0-9_.-]+)\/kill\/?$/);
      if (m && req.method === "POST") {
        const id = m[1]!;
        const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
        const masterUrl = `http://127.0.0.1:${masterPort}/watchdogs/${encodeURIComponent(id)}/kill`;
        try {
          const upstream = await fetch(masterUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });
          const body = await upstream.text();
          return new Response(body, {
            status: upstream.status,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
            { status: 502 },
          );
        }
      }
    }

    // ── /api/profile — supervisor profile (v2.7.18) ─────────────────────
    // Thin pass-through to the master daemon's /profile endpoint. Master
    // owns the source of truth (~/.config/subctl/profiles.json) and its
    // fs.watch on the file triggers the swap-on-next-prompt behavior;
    // the dashboard just needs a stable surface for the pill in the
    // sticky chat header to call. GET → { active, profiles }; POST
    // { profile } → { ok, active }.
    if (url.pathname === "/api/profile") {
      if (req.method !== "GET" && req.method !== "POST") {
        return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
      }
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}/profile`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method === "POST") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
          },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/evy/engagement — Kernel Fitness Phase 1 (v3.1.0) ──────────────
    // Operator engagement signal from the dashboard chat panel.
    //   body: {
    //     surface_id: string,
    //     outcome: "acted" | "acked",
    //     source?: "dashboard_click",          // defaults to dashboard_click
    //     latency_ms?: number,                 // optional emission→outcome ms
    //   }
    //
    // Writes a single `engagement` entry to the engagement ledger via the
    // tracker. This endpoint is WRITE-ONLY by design — there is no
    // corresponding GET to read the ledger from the browser. The fitness
    // signal must not leak back into Evy's supervisor prompt (negative
    // criterion enforced by tests in
    // components/evy/__tests__/engagement-ledger-isolation.test.ts).
    if (url.pathname === "/api/evy/engagement" && req.method === "POST") {
      let body: {
        surface_id?: string;
        outcome?: string;
        source?: string;
        latency_ms?: number;
      };
      try {
        body = await req.json();
      } catch {
        return Response.json(
          { ok: false, error: "invalid JSON body" },
          { status: 400 },
        );
      }
      const surface_id = typeof body.surface_id === "string" ? body.surface_id.trim() : "";
      const outcome = body.outcome === "acted" || body.outcome === "acked"
        ? (body.outcome as EvyOutcome)
        : null;
      // Only dashboard_click is accepted from this endpoint; other sources
      // are recorded by the daemon directly (Telegram, plan approvals,
      // timeout sweep) and must not be forge-able from the dashboard.
      const source: EvySource =
        body.source === "dashboard_click" || body.source === undefined
          ? "dashboard_click"
          : "dashboard_click";
      if (!surface_id || surface_id.length > 128) {
        return Response.json(
          { ok: false, error: "surface_id required (1..128 chars)" },
          { status: 400 },
        );
      }
      if (!outcome) {
        return Response.json(
          { ok: false, error: "outcome must be 'acted' or 'acked'" },
          { status: 400 },
        );
      }
      const latency_ms =
        typeof body.latency_ms === "number" && Number.isFinite(body.latency_ms) && body.latency_ms >= 0
          ? Math.floor(body.latency_ms)
          : undefined;
      try {
        recordEvyEngagement(surface_id, outcome, source, latency_ms);
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, surface_id, outcome, source });
    }

    // ── /api/evy/fitness/ledger — Kernel Fitness Phase 3 (v3.3.1) ─────────
    // Read-only proxy for ~/.config/subctl/evy/fitness-ledger.jsonl.
    // Optional query: ?window=24h|7d|30d|Nh|Nd to filter by window_start.
    // File-missing → { entries: [] }, never 500.
    if (url.pathname === "/api/evy/fitness/ledger" && req.method === "GET") {
      const win = parseFitnessWindow(url.searchParams.get("window"));
      const entries = readFitnessLedger(defaultFitnessLedgerPath(), {
        windowSeconds: win,
      });
      return Response.json({ entries }, { headers: { "Cache-Control": "no-store" } });
    }

    // ── /api/evy/engagement/ledger — Kernel Fitness Phase 3 (v3.3.1) ──────
    // Read-only proxy for ~/.config/subctl/evy/engagement-ledger.jsonl.
    // Optional query: ?window=...&type=surface_emitted|engagement.
    if (url.pathname === "/api/evy/engagement/ledger" && req.method === "GET") {
      const win = parseFitnessWindow(url.searchParams.get("window"));
      const typeParam = url.searchParams.get("type");
      const type: "surface_emitted" | "engagement" | null =
        typeParam === "surface_emitted" || typeParam === "engagement"
          ? typeParam
          : null;
      const entries = readEngagementLedger(defaultEngagementLedgerPath(), {
        windowSeconds: win,
        type,
      });
      return Response.json({ entries }, { headers: { "Cache-Control": "no-store" } });
    }

    // ── /api/evy/fitness/health — Kernel Fitness Phase 3 (v3.3.1) ─────────
    // Rolls last 24h of fitness ledger into a red/yellow/green verdict.
    if (url.pathname === "/api/evy/fitness/health" && req.method === "GET") {
      const entries = readFitnessLedger(defaultFitnessLedgerPath());
      const result = computeFitnessHealth(entries);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    // ── /api/master/restart — operator-triggered daemon kickstart ─────────
    // v2.8.9 — added so the operator can restart the master daemon from the
    // dashboard UI without dropping to a terminal. Uses launchctl kickstart
    // -k which sends SIGTERM, waits ExitTimeOut, then SIGKILLs if needed.
    // Master's shutdown handler saves the transcript before exit so no
    // chat state is lost. Non-blocking: returns immediately with the
    // kickstart command's exit code; the dashboard polls /health to know
    // when master is back.
    if (url.pathname === "/api/master/restart" && req.method === "POST") {
      try {
        const uid = process.getuid?.() ?? 0;
        const r = spawnSync(
          "launchctl",
          ["kickstart", "-k", `gui/${uid}/com.subctl.evy`],
          { encoding: "utf8", timeout: 10_000 },
        );
        if (r.status !== 0) {
          return Response.json(
            {
              ok: false,
              error: `launchctl kickstart returned ${r.status}: ${r.stderr || r.stdout}`,
            },
            { status: 500 },
          );
        }
        return Response.json({
          ok: true,
          message: "master kickstart issued — poll /api/master/health for return",
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }

    // ── master proxy: /api/master/* → http://127.0.0.1:8788/* ────────────
    // The master daemon listens locally; the dashboard fronts it for the
    // browser. POST /api/master/chat forwards the JSON body. GET
    // /api/master/events streams the SSE through. /health is just convenient.
    //
    // v2.7.3: GET /api/master/transcript/util → /transcript/util on master.
    // Returns { current_tokens, loaded_ctx, util_pct, warn_at, compact_at,
    // decision } for the 4-state context-budget banner. No special handling
    // here — the generic proxy below relays it.
    // ── /api/notifications/* — proxy to master's notification channel (v2.7.22)
    // Operator-facing alerts (team-staleness auto-nudge, auto-compact
    // errors). The master owns the in-memory ring buffer; this just
    // forwards REST + SSE so the dashboard tray + xtab readers don't have
    // to know the master's port. Mirrors /api/master/events SSE handling.
    if (url.pathname.startsWith("/api/notifications")) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/notifications/, "/notifications")}${url.search}`;
      try {
        if (url.pathname === "/api/notifications/stream" && req.method === "GET") {
          const upstream = await fetch(masterUrl, {
            headers: { Accept: "text/event-stream" },
            signal: req.signal,
          });
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "Connection": "keep-alive",
            },
          });
        }
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/voice/* — proxy to master's voice layer (v2.8.0) ───────────
    // Voice rendering happens on master (which fronts the local TTS
    // server at :8789 and owns the cache + redaction). The dashboard
    // browser tab hits these endpoints:
    //
    //   POST /api/voice/render          → master /voice/render
    //   GET  /api/voice/status          → master /voice/status
    //   POST /api/voice/config          → master /voice/config
    //   GET  /api/voice/audio/:hash.fmt → master /voice/audio/:hash.fmt (bytes)
    //
    // /api/voice/audio is the one that streams binary audio back; the
    // others are JSON.
    if (url.pathname.startsWith("/api/voice")) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/voice/, "/voice")}${url.search}`;
      try {
        if (url.pathname.startsWith("/api/voice/audio/") && req.method === "GET") {
          const upstream = await fetch(masterUrl, { signal: req.signal });
          // Pass through bytes + content-type so <audio src=…> works directly.
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "Content-Type": upstream.headers.get("Content-Type") ?? "audio/wav",
              "Cache-Control": upstream.headers.get("Cache-Control") ?? "public, max-age=3600",
            },
          });
        }
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/preferences — proxy to master's operator preferences (v2.8.1) ──
    // Bilateral-maintenance config. Master owns the source of truth at
    // ~/.config/subctl/preferences.toml; this proxy lets the dashboard's
    // Preferences tab read + edit without knowing master's port. Routes
    // mirror master's /preferences/* exactly. Reset gates on `{confirm: true}`.
    if (url.pathname === "/api/preferences" || url.pathname.startsWith("/api/preferences/")) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/preferences/, "/preferences")}${url.search}`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/upstreams — proxy to master's upstream-check (v2.7.25 C) ───
    // ADR 0015 always-latest policy. The master owns the watchdog state;
    // this proxy lets the dashboard's Memory tab "Upstreams" card read it
    // without knowing the master's port. Routes:
    //
    //   GET  /api/upstreams                      → master /upstreams
    //   POST /api/upstreams/check                → master /upstreams/check (manual tick)
    //   GET  /api/upstreams/history?limit=N      → master /upstreams/history (v2.7.37)
    //   POST /api/upstreams/update               → master /upstreams/update (v2.7.37 manual)
    //   POST /api/upstreams/auto-update/toggle   → master /upstreams/auto-update/toggle (v2.7.37)
    if (
      url.pathname === "/api/upstreams" ||
      url.pathname === "/api/upstreams/check" ||
      url.pathname === "/api/upstreams/history" ||
      url.pathname === "/api/upstreams/update" ||
      url.pathname === "/api/upstreams/auto-update/toggle"
    ) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/upstreams/, "/upstreams")}${url.search}`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/cognee/* — proxy to local Cognee sidecar (v2.8.7 memory tab) ─
    // Mirrors the master-side proxy idiom below, but talks directly to the
    // Cognee HTTP daemon on 127.0.0.1:8745 (default). Used by the Memory
    // tab's Tier-health strip + Graph Extraction panel to call /health and
    // /cognify without going through the master. Ports follow the defaults
    // in components/evy/cognee-client.ts:100.
    if (url.pathname.startsWith("/api/cognee/")) {
      const port = process.env.SUBCTL_COGNEE_PORT ?? "8745";
      const upstreamUrl = `http://127.0.0.1:${port}${url.pathname.replace(/^\/api\/cognee/, "")}${url.search}`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(upstreamUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `cognee sidecar unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/memori/* — proxy to local Memori sidecar (v2.8.7 memory tab) ─
    // Mirrors the cognee block above. Hits 127.0.0.1:8746 by default; used
    // by the Memory tab's Tier-health strip + Curated Tier 3 browser to
    // call /health and /recall directly. Port follows the default in
    // components/evy/memori-client.ts:185.
    if (url.pathname.startsWith("/api/memori/")) {
      const port = process.env.SUBCTL_MEMORI_PORT ?? "8746";
      const upstreamUrl = `http://127.0.0.1:${port}${url.pathname.replace(/^\/api\/memori/, "")}${url.search}`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(upstreamUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `memori sidecar unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // ── /api/memory/* — proxy to master's Evy Memory (v2.7.23) ──────────
    // Tier 3 conversational memory: operator-Evy chat, decisions, captured
    // notifications, shipped events. The master owns the SQLite store
    // (~/.local/state/subctl/memory/evy.db); this just forwards REST so the
    // dashboard Memory panel + the operator can search/recall without
    // touching the master's port directly.
    //
    // Subpath-only — `/api/memory` (no suffix) stays mapped to the existing
    // Obsidian vault status endpoint farther up. We only proxy when there's
    // a real subpath ("/search", "/recent", "/stats", "/entries", …).
    if (url.pathname.startsWith("/api/memory/")) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/memory/, "/memory")}${url.search}`;
      try {
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    if (url.pathname.startsWith("/api/master/")) {
      const masterPort = process.env.SUBCTL_EVY_PORT ?? "8788";
      const masterUrl = `http://127.0.0.1:${masterPort}${url.pathname.replace(/^\/api\/master/, "")}${url.search}`;
      try {
        if (url.pathname === "/api/master/events" && req.method === "GET") {
          // SSE pass-through. Bun's fetch returns a streaming Response;
          // we forward its body directly so the browser sees text/event-stream.
          const upstream = await fetch(masterUrl, {
            headers: { Accept: "text/event-stream" },
            signal: req.signal,
          });
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "Connection": "keep-alive",
            },
          });
        }
        const init: RequestInit = {
          method: req.method,
          headers: { "Content-Type": "application/json" },
        };
        if (req.method !== "GET" && req.method !== "HEAD") {
          init.body = await req.text();
        }
        const upstream = await fetch(masterUrl, init);
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: `master daemon unreachable: ${(err as Error).message}` },
          { status: 502 },
        );
      }
    }

    // POST or GET /api/refresh — bypass usage caches (in-process AND on-disk)
    // and return a fresh state snapshot. Clicked from the dashboard "↻" button
    // or invoked by scripts. Costs one API call per claude account; rest of
    // the day uses the normal 5-min auto-cadence.
    //
    // v2.8.18 (CodeRabbit pass-2 Fix 1) — `forceUsageRefresh: true` also
    // skips the 429 backoff. Without it, clicking Refresh mid-backoff was
    // a silent no-op (kept returning stale data) which is a confusing
    // UX. The forced fetch still records 429s if Anthropic returns them.
    if (url.pathname === "/api/refresh") {
      _usageCache = null;
      _costCache = null;
      try {
        const cacheGlob = join(SUBCTL_CONFIG_DIR, "cache", "usage");
        if (existsSync(cacheGlob)) {
          for (const f of readdirSync(cacheGlob)) {
            if (f.endsWith(".json")) {
              try { rmSync(join(cacheGlob, f)); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* best-effort */ }
      const fresh = buildState({ forceUsageRefresh: true });
      for (const ws of sockets) {
        try { ws.send(JSON.stringify(fresh)); } catch { /* ignore */ }
      }
      return new Response(JSON.stringify(fresh), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/cheat" || url.pathname === "/cheatsheet" || url.pathname === "/cheat/") {
      return new Response(renderCheatsheetPage(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.pathname === "/help" || url.pathname === "/help/") {
      return new Response(renderHelpPage(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    // GET /api/sessions/preview?account=<alias>&sid=<uuid>
    // Returns the first user-message preview for one session. Used by the
    // browser to lazy-load previews on row hover (avoiding 200× file reads
    // on the bulk list endpoint).
    if (url.pathname === "/api/sessions/preview" && req.method === "GET") {
      const account = url.searchParams.get("account") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (!account || !sid || !/^[a-zA-Z0-9_-]+$/.test(sid)) {
        return new Response(JSON.stringify({ ok: false, error: "missing/invalid account or sid" }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
      // Resolve config_dir for this account.
      const { accounts: accs } = parseAccountsConf();
      let cfgDir: string | null = null;
      if (account === "default") {
        cfgDir = join(HOME, ".claude");
      } else {
        const a = accs.find(x => x.alias === account);
        if (a) cfgDir = a.config_dir;
      }
      if (!cfgDir) {
        return new Response(JSON.stringify({ ok: false, error: "unknown account" }),
          { status: 404, headers: { "Content-Type": "application/json" } });
      }
      // Find the jsonl in any project dir under this account.
      const projectsRoot = join(cfgDir, "projects");
      const projects = safeReaddir(projectsRoot);
      let preview = "";
      let firstTs = "";
      for (const pd of projects) {
        const candidate = join(projectsRoot, pd, `${sid}.jsonl`);
        const st = safeStat(candidate);
        if (!st || !st.isFile()) continue;
        try {
          // Stream-read line by line until we find first_ts + first user
          // text. Necessary because user messages with embedded base64
          // images can produce multi-MB single lines that overflow any
          // fixed head buffer.
          const fs = require("node:fs");
          const fd = fs.openSync(candidate, "r");
          const CHUNK = 1024 * 1024;     // 1MB chunks
          const MAX_BYTES = 8 * 1024 * 1024;  // bail after 8MB scanned
          let bufStr = "";
          let totalRead = 0;
          let pos = 0;
          let scanComplete = false;
          while (!scanComplete && totalRead < MAX_BYTES) {
            const tmp = Buffer.alloc(CHUNK);
            const n = fs.readSync(fd, tmp, 0, CHUNK, pos);
            if (n === 0) break;
            pos += n;
            totalRead += n;
            bufStr += tmp.subarray(0, n).toString("utf8");
            // Process complete lines; keep tail for next iteration.
            let nl;
            while ((nl = bufStr.indexOf("\n")) >= 0) {
              const line = bufStr.slice(0, nl);
              bufStr = bufStr.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
              if (!firstTs && ev.timestamp) firstTs = ev.timestamp;
              if (!preview && ev.type === "user") {
                const c = ev.message?.content;
                if (typeof c === "string") {
                  preview = c.slice(0, 240);
                } else if (Array.isArray(c)) {
                  // Find first part with a .text field (text or tool_result content).
                  const textPart = c.find((x: any) => x && typeof x.text === "string" && x.text);
                  if (textPart) {
                    preview = String(textPart.text).slice(0, 240);
                  } else if (c[0]?.type) {
                    // Fall back to a marker like "(image)" or "(tool_use)" so
                    // image-first or tool-first sessions still get something.
                    const types = c.map((x: any) => x?.type).filter(Boolean).slice(0, 3).join(", ");
                    preview = `(${types || "no text"})`;
                  }
                }
                if (preview) preview = preview.replace(/\s+/g, " ").trim();
              }
              } catch { /* skip bad line */ }
              if (firstTs && preview) { scanComplete = true; break; }
            }
          }
          fs.closeSync(fd);
        } catch { /* unreadable */ }
        break;
      }
      return new Response(JSON.stringify({ ok: true, sid, account, preview, first_ts: firstTs }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // POST /api/sessions/spawn  body: {account, sid, cwd?}
    // Opens a new iTerm window (macOS only) with the resume command pre-running.
    // Falls back gracefully on Linux / non-iTerm environments — caller gets
    // ok:false + a "fallback" field with the copy-paste command.
    if (url.pathname === "/api/sessions/spawn" && req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const account = String(body.account ?? "");
      const sid = String(body.sid ?? "");
      const cwdRaw = String(body.cwd ?? "");
      if (!account || !sid || !/^[a-zA-Z0-9_-]+$/.test(sid)) {
        return new Response(JSON.stringify({ ok: false, error: "missing/invalid account or sid" }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const { accounts: accs } = parseAccountsConf();
      let cfgDir: string | null = null;
      if (account === "default") cfgDir = join(HOME, ".claude");
      else {
        const a = accs.find(x => x.alias === account);
        if (a) cfgDir = a.config_dir;
      }
      if (!cfgDir) {
        return new Response(JSON.stringify({ ok: false, error: "unknown account" }),
          { status: 404, headers: { "Content-Type": "application/json" } });
      }
      // Sanitize cwd: must exist as a directory; default to $HOME.
      const cwd = cwdRaw && existsSync(cwdRaw) ? cwdRaw : HOME;

      // Build the shell command to inject into iTerm.
      // Single-quote-safe by escaping inner single quotes.
      const cmdParts = [
        `cd ${shellEscape(cwd)}`,
        `CLAUDE_CONFIG_DIR=${shellEscape(cfgDir)} command claude --resume ${shellEscape(sid)}`,
      ];
      const fallbackCmd = cmdParts.join(" && ");

      // macOS osascript to spawn iTerm. Detect platform via process.platform.
      if (process.platform !== "darwin") {
        return new Response(JSON.stringify({
          ok: false, error: "spawn requires macOS + iTerm",
          fallback: fallbackCmd,
        }), { status: 501, headers: { "Content-Type": "application/json" } });
      }

      const osascript = [
        'tell application "iTerm"',
        '  activate',
        '  set newWin to (create window with default profile)',
        `  tell current session of newWin to write text "${fallbackCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
        'end tell',
      ].join("\n");

      // PR 8.5: routed through execCommand. EXEC_SURFACE §4d flags this as
      // the 2-layer-escape risk (osascript -e <script> with fallbackCmd
      // interpolated). Migration does NOT fix the escape concern — that
      // requires a separate "build osascript via argv" effort tracked in
      // exec-migration.md — but it does normalize the spawn so a future
      // policy gate (gating "interactive iTerm spawn for sid X") has a
      // single chokepoint to attach to.
      const r = await execCommand("/usr/bin/osascript", ["-e", osascript], {
        timeout: 5_000,
      });
      if (r.exitCode === null || r.exitCode !== 0) {
        return new Response(JSON.stringify({
          ok: false,
          error: (r.stderr || r.stdout || (r.timedOut ? "timed out" : "spawn failed")).slice(0, 500),
          fallback: fallbackCmd,
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /api/notify/inbox?question_id=Q42&unacked_only=1&limit=50
    // Returns inbox entries (newest first). Filterable by question_id and
    // unacked-only for the orchestrator's "is my answer in?" check.
    if (url.pathname === "/api/notify/inbox" && req.method === "GET") {
      const qid = url.searchParams.get("question_id") ?? undefined;
      const unackedOnly = url.searchParams.get("unacked_only") === "1";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
      const entries = readInbox({ question_id: qid, unacked_only: unackedOnly, limit });
      return new Response(JSON.stringify({ entries, listener: notifyListenerStatus() }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // POST /api/notify/inbox/:id/ack — mark a question's latest reply as acked
    {
      const m = url.pathname.match(/^\/api\/notify\/inbox\/([A-Za-z0-9_-]+)\/ack\/?$/);
      if (m && req.method === "POST") {
        const ok = ackInboxEntry(m[1]!);
        return new Response(JSON.stringify({ ok }), {
          status: ok ? 200 : 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ─── v3.2.0 — buddy-integration surface ─────────────────────────────────
    //
    // The subctl-buddy bridge polls GET /api/asks/pending to mirror
    // pending operator questions on the M5Stack device, and POSTs to
    // /api/notify/reply to submit button-tap answers. Canonical schema
    // doc: docs/asks-pending-surface.md.

    // GET /api/asks/pending          → { entries: [...] }
    // GET /api/asks/pending?id=X     → single record OR 404
    if (url.pathname === "/api/asks/pending" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const rec = getPendingAsk(id);
        if (!rec) {
          return new Response(
            JSON.stringify({ error: "not found", id }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify(rec), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const entries = listPendingAsks();
      return new Response(JSON.stringify({ entries }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // POST /api/notify/reply  body: {question_id, answer, source?, from_name?, answer_label?}
    // Inject a reply as if a Telegram button tap had answered it. The
    // bash --wait poll loop picks the new inbox entry up on its next
    // tick; the corresponding asks-pending record is removed atomically.
    if (url.pathname === "/api/notify/reply" && req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch { /* invalid JSON */ }
      const question_id = String(body.question_id ?? "").trim();
      const answer = String(body.answer ?? "").trim();
      if (!question_id || !answer) {
        return new Response(
          JSON.stringify({ ok: false, error: "question_id + answer required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      try {
        const entry = await injectExternalReply({
          question_id,
          answer,
          answer_label: body.answer_label ?? undefined,
          source: typeof body.source === "string" && body.source.length > 0
            ? body.source
            : undefined,
          from_name: body.from_name ?? undefined,
        });
        return new Response(JSON.stringify({ ok: true, entry }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e: any) {
        return new Response(
          JSON.stringify({ ok: false, error: e?.message ?? "inject failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // GET /api/sessions/list — enumerate every Claude Code session across all
    // accounts. Used by the dashboard's session browser for search/copy-resume.
    if (url.pathname === "/api/sessions/list" && req.method === "GET") {
      // Default 1500 (we have ~5K sessions on heavy users — bigger limit so
      // search can hit deep history). Cap at 5000.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 1500), 5000);
      const includeWorkers = url.searchParams.get("workers") === "1";
      let sessions = listAllClaudeSessions(limit);
      if (!includeWorkers) {
        sessions = sessions.filter(s => !s.is_worker);
      }
      return new Response(JSON.stringify({ sessions, total: sessions.length }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    // ── orchestration control plane (v1.3.0) ──────────────────────────────
    //
    // Wraps `subctl teams claude` + tmux primitives behind HTTP so external
    // controllers (ArgentOS, scripts, future bot commands) can manage tmux
    // orchestrator sessions without shelling out per call.
    //
    //   POST /api/orchestration/spawn            body: {account, project, prompt?, orchestrator?, continue?, skip_perms?, resume?, name?}
    //   GET  /api/orchestration                  list current orchestrator sessions
    //   GET  /api/orchestration/:name            preview + status for one session
    //   POST /api/orchestration/:name/msg        body: {text}  → injects into the active pane
    //   POST /api/orchestration/:name/kill       same as /api/sessions/:name/kill (alias)
    //
    // No new launchd plist; runs inside the dashboard's Bun process.

    if (url.pathname === "/api/orchestration/spawn" && req.method === "POST") {
      let body: any = {};
      try { body = await req.json(); } catch {}
      const account = String(body.account ?? "").trim();
      const project = String(body.project ?? "").trim();
      if (!account || !project) {
        return new Response(JSON.stringify({ ok: false, error: "account + project required" }),
          { status: 400, headers: { "Content-Type": "application/json" } });
      }
      // Validate project dir exists.
      if (!existsSync(project)) {
        return new Response(JSON.stringify({ ok: false, error: `project dir not found: ${project}` }),
          { status: 404, headers: { "Content-Type": "application/json" } });
      }

      // PR 11.5: dispatch by account provider instead of hardcoded "claude".
      // Pre-existing tech debt — multi-provider work needed it regardless of
      // pi-coding-agent. Look up the account's provider; refuse spawn if
      // unknown so we fail loud instead of routing to the wrong CLI.
      const { accounts: spawnAccs } = parseAccountsConf();
      const acct = spawnAccs.find(a => a.alias === account);
      if (!acct) {
        return new Response(JSON.stringify({
          ok: false, error: `unknown account: ${account} (not in accounts.conf)`,
        }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      const provider = acct.provider;
      // Allowlist providers that have a teams.sh implementation. Keeping
      // this explicit prevents `subctl teams gemini` etc. from being
      // dispatched here just because some operator typed `gemini` into the
      // accounts.conf provider column. Mirror the bin/subctl dispatcher.
      const TEAMS_SUPPORTED = new Set(["claude", "pi-coding-agent"]);
      if (!TEAMS_SUPPORTED.has(provider)) {
        return new Response(JSON.stringify({
          ok: false,
          error: `provider "${provider}" does not support teams spawn (alias=${account})`,
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      // Build provider-specific argv. claude supports the rich flag set
      // shipped with PR 10 (orchestrator/skip_perms/continue/resume/template).
      // pi-coding-agent (UNGATED in v2.7.0) supports a smaller flag set —
      // any unsupported field in `body` is silently ignored to keep the HTTP
      // contract permissive. Prompt + project apply to both providers.
      const args: string[] = ["teams", provider, "-a", account, "--no-attach"];
      if (provider === "claude") {
        if (body.orchestrator) args.push("-o");
        if (body.skip_perms) args.push("-y");
        if (body.continue) args.push("-c");
        if (typeof body.resume === "string" && body.resume) {
          args.push("--resume", String(body.resume));
        }
        if (typeof body.template === "string" && body.template) {
          args.push("--template", body.template);
        }
      } else if (provider === "pi-coding-agent") {
        // Pi takes a model override via -m; nothing else from the claude
        // grab-bag applies yet (no orchestrator, no resume, no template).
        if (typeof body.model === "string" && body.model) {
          args.push("-m", String(body.model));
        }
      }
      if (typeof body.prompt === "string" && body.prompt) {
        args.push("-p", body.prompt);
      }

      const subctlBin = join(REPO_ROOT, "bin", "subctl");
      // PR 8.5: routed through execCommand. EXEC_SURFACE §4b flags the
      // downstream tmux paste-buffer (inside teams.sh) as the highest-risk
      // user-input path because operator-supplied `prompt` ends up pasted
      // into the worker TUI with unrestricted Bash. Gating for claude
      // happens further down (PR 10's PreToolUse hook). pi-coding-agent is
      // UNGATED in v2.7.0; its gate lands in v2.7.1+.
      const r = await execCommand(subctlBin, args, {
        cwd: project,
        // 30s is plenty — teams.sh now backgrounds the prompt-paste, so the
        // synchronous portion is just tmux session creation + setup (typically
        // <2s). The wait-for-ready + paste happens async in a detached subshell.
        timeout: 30_000,
        env: { ...process.env, SUBCTL_NO_ATTACH: "1" },
      });
      if (r.exitCode === null || r.exitCode !== 0) {
        const c = classifySpawnError({ stderr: r.stderr, stdout: r.stdout, timedOut: r.timedOut });
        return new Response(JSON.stringify({
          ok: false,
          error: c.error,
          error_kind: c.kind,
        }), { status: c.status, headers: { "Content-Type": "application/json" } });
      }
      // Session name mirrors each provider's teams.sh prefix:
      //   claude          → claude-<basename>
      //   pi-coding-agent → pi-<basename>
      // Keep these in lockstep with the SESSION_NAME computation in each
      // provider's teams.sh.
      const sessionPrefix = provider === "pi-coding-agent" ? "pi" : "claude";
      const sessionName = `${sessionPrefix}-` + project.split("/").pop()!.replace(/[.: ]/g, "_");
      const tmuxSessions = listTmuxSessions();
      const live = tmuxSessions.find(s => s.name === sessionName);
      // Push fresh state to dashboard observers.
      try {
        const fresh = buildState();
        for (const ws of sockets) { try { ws.send(JSON.stringify(fresh)); } catch {} }
      } catch {}
      return new Response(JSON.stringify({
        ok: true,
        session_name: sessionName,
        provider,
        spawned: !!live,
        attached: live?.attached ?? false,
        cwd: project,
        account,
        stdout: r.stdout?.slice(0, 600) ?? "",
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/orchestration" && req.method === "GET") {
      return new Response(JSON.stringify({ orchestrations: buildOrchestrations() }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // ── /api/orchestration/captures — bulk NVR-style frame fetch ──────────
    // Returns the last N lines of pane content for EVERY tracked session in
    // one call. Frontend polls every 2s for the camera-grid view. Captured
    // text is ANSI-stripped — phase 2 xterm.js per tile would skip the
    // strip and render real escapes. ?lines=N (default 40, clamped 8..200).
    if (url.pathname === "/api/orchestration/captures" && req.method === "GET") {
      const linesParam = parseInt(url.searchParams.get("lines") ?? "40", 10);
      const orchs = buildOrchestrations();
      const captures = orchs.map((o) => {
        const capture = tmuxCaptureFrame(o.name, linesParam);
        const lastFew = capture.split("\n").slice(-10).join("\n");
        // Cheap status heuristic — same family as detectStatus() below but
        // adapted to the per-tile context: red if visible error patterns,
        // yellow for stale, green if recently changed.
        const ageS = o.last_activity_seconds_ago ?? null;
        let status: "active" | "idle" | "stale" | "error" | "ended" = "idle";
        if (/error\b|Error:|failed\b|fatal:/i.test(lastFew)) status = "error";
        else if (typeof ageS === "number") {
          if (ageS < 60) status = "active";
          else if (ageS < 900) status = "idle";   // < 15min
          else status = "stale";                  // > 15min
        }
        return {
          name: o.name,
          status,
          last_activity_seconds_ago: o.last_activity_seconds_ago ?? null,
          path: o.path ?? null,
          claude_account_dir: o.claude_account_dir ?? null,
          windows: o.windows ?? null,
          attached: o.attached ?? false,
          capture,
        };
      });
      return new Response(JSON.stringify({ ok: true, count: captures.length, captures }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    {
      const m = url.pathname.match(/^\/api\/orchestration\/([^/]+)\/msg\/?$/);
      if (m && req.method === "POST") {
        const name = decodeURIComponent(m[1]!);
        let body: any = {};
        try { body = await req.json(); } catch {}
        const text = String(body.text ?? "").trim();
        const phaseRaw = body.phase;
        const phase = typeof phaseRaw === "string" && phaseRaw.trim().length > 0
          ? phaseRaw.trim()
          : null;
        if (!text) {
          return new Response(JSON.stringify({ ok: false, error: "text required" }),
            { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const known = listTmuxSessions().some(s => s.name === name);
        if (!known) {
          return new Response(JSON.stringify({ ok: false, error: "session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } });
        }
        // v2.7.9 → v2.7.20 (ADR 0011 Layer 1): HMAC-authenticated
        // trusted-channel marker. The marker carries phase, ts, and a
        // truncated HMAC over (phase + "\n" + ts + "\n" + body), keyed
        // by the team's secret on disk. The worker's spawn-time prompt
        // contains the matching secret so it can recompute and verify.
        // Anything that can't read both files (the disk secret + the
        // worker's prompt) cannot forge a valid marker.
        //
        // team_id == tmux session name, matching the policy-snapshot
        // convention (providers/claude/teams.sh sets SESSION_NAME and
        // passes it as team_id to the snapshot writer).
        //
        // v2.8.8+ wire format (SPEC-wrapped, consumed by the worker-
        // contract preamble in providers/claude/teams.sh):
        //   [subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]
        //   SPEC:
        //     <body indented>
        //
        // The SPEC block is required — a directive with no SPEC body is
        // a contract violation and the worker will refuse it. The HMAC
        // is computed over the wrapped body so the worker can verify
        // both the sender (HMAC) and that a real task was sent (SPEC).
        //
        // Secret missing on disk = REFUSE TO SEND (fail loud, do NOT
        // fall back to unauthenticated marker — that would train
        // workers to ignore the auth field).
        let wrapped: string;
        try {
          const { wireFormat } = buildSignedDirective({
            teamId: name,
            phase,
            body: text,
          });
          wrapped = wireFormat;
        } catch (err) {
          const msg = (err as Error).message;
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Use a tmux buffer so multi-line text injects safely (avoids escape chaos)
        const r1 = spawnSync(TMUX_BIN, ["set-buffer", "-b", "subctl-msg", wrapped], { encoding: "utf8" });
        const r2 = spawnSync(TMUX_BIN, ["paste-buffer", "-t", name, "-b", "subctl-msg"], { encoding: "utf8" });
        // v2.7.8 — give Claude Code's TUI a beat to register the pasted text
        // before sending Enter. Without this delay, the three subprocesses
        // fire so fast that the TUI's input event loop sometimes hasn't
        // ingested the paste when Enter arrives — net result: text sits in
        // the input box, never submitted. Operator-observed: master had to
        // re-send messages multiple times to actually trigger execution.
        // 200ms is well below human noticeability and well above paste-event
        // latency in our profiling.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const r3 = spawnSync(TMUX_BIN, ["send-keys", "-t", name, "Enter"], { encoding: "utf8" });
        const ok = !r1.error && !r2.error && !r3.error;
        return new Response(JSON.stringify({ ok }), {
          status: ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    {
      const m = url.pathname.match(/^\/api\/orchestration\/([^/]+)\/?$/);
      if (m && req.method === "GET") {
        const name = decodeURIComponent(m[1]!);
        const all = listTmuxSessions();
        const s = all.find(x => x.name === name);
        if (!s) {
          return new Response(JSON.stringify({ ok: false, error: "session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } });
        }
        const cfgDir = tmuxShowEnv(name, "CLAUDE_CONFIG_DIR");
        const preview = tmuxCapturePreview(name);
        const panes = listAllPanes().get(name) ?? [];
        return new Response(JSON.stringify({
          ok: true,
          session: {
            name: s.name,
            path: s.path,
            attached: s.attached,
            windows: s.windows,
            created: s.created,
            claude_account_dir: cfgDir,
            preview: preview,
            panes: panes,
          },
        }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    }

    {
      const m = url.pathname.match(/^\/api\/orchestration\/([^/]+)\/kill\/?$/);
      if (m && req.method === "POST") {
        const name = decodeURIComponent(m[1]!);
        const known = listTmuxSessions().some(s => s.name === name);
        if (!known) {
          return new Response(JSON.stringify({ ok: false, error: "session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } });
        }
        const subctlBin = join(REPO_ROOT, "bin", "subctl");
        // PR 8.5: routed through execCommand. `name` is validated against
        // `listTmuxSessions()` above, so this is not user-arbitrary command
        // input; the argv-array form was already safe. Migration is purely
        // for chokepoint consistency.
        const r = await execCommand(subctlBin, ["session-kill", name], { timeout: 8_000 });
        if (r.exitCode === null || r.exitCode !== 0) {
          return new Response(JSON.stringify({ ok: false, error: (r.stderr || r.stdout || (r.timedOut ? "timed out" : "spawn failed")).slice(0, 500) }),
            { status: 500, headers: { "Content-Type": "application/json" } });
        }
        // v2.8.2 — Lifecycle notify to master so the team-staleness
        // watchdog drops `name` from its tracking maps immediately and
        // doesn't fire a nudge/escalation on a corpse. Best-effort:
        // master may be down, the watchdog tick has its own safety-net
        // prune that will catch this on next interval. Don't block or
        // fail the kill on this.
        await notifyMasterTeamPruned(name);
        try {
          const fresh = buildState();
          for (const ws of sockets) { try { ws.send(JSON.stringify(fresh)); } catch {} }
        } catch {}
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // POST /api/sessions/<name>/kill — shells out to `subctl session-kill <name>`.
    // Validates the session name against current tmux state to avoid arbitrary
    // input being passed to the CLI. Reuses the existing safe code path.
    {
      const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/kill\/?$/);
      if (m && req.method === "POST") {
        const name = decodeURIComponent(m[1]!);
        // Check the session actually exists in tmux right now.
        const known = listTmuxSessions().some(s => s.name === name);
        if (!known) {
          return new Response(JSON.stringify({ ok: false, error: "session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } });
        }
        const subctlBin = join(REPO_ROOT, "bin", "subctl");
        const r = spawnSync(subctlBin, ["session-kill", name], { encoding: "utf8", timeout: 8_000 });
        if (r.error || (typeof r.status === "number" && r.status !== 0)) {
          return new Response(JSON.stringify({ ok: false, error: (r.stderr || r.stdout || String(r.error)).slice(0, 500) }),
            { status: 500, headers: { "Content-Type": "application/json" } });
        }
        // v2.8.2 — Same lifecycle notify as /api/orchestration/:name/kill.
        // Both routes funnel through `subctl session-kill`; both must
        // tell the master to unregister the team or the watchdog will
        // keep escalating against the gone session.
        await notifyMasterTeamPruned(name);
        // Push a fresh state immediately so the row disappears in real-time.
        const fresh = buildState();
        for (const ws of sockets) {
          try { ws.send(JSON.stringify(fresh)); } catch { /* ignore */ }
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    const staticResp = serveStatic(url.pathname);
    if (staticResp) return staticResp;
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const data = (ws as any).data;
      if (data && data.kind === "terminal") {
        // v2.7.21 (ADR 0011 L2): terminal-attach websocket. Spawn the node
        // pty-helper sidecar and wire it to this socket.
        try {
          const bridge = spawnPtyBridge({
            session: data.session,
            cols: data.cols,
            rows: data.rows,
            sinks: {
              sendBinary: (chunk) => { try { ws.send(chunk); } catch { /* socket closing */ } },
              closeSocket: () => { try { ws.close(); } catch { /* already closing */ } },
            },
          });
          ptyBridges.set(ws, bridge);
        } catch (err) {
          console.log(`[terminal] failed to spawn bridge: ${(err as Error).message}`);
          try { ws.close(); } catch {}
        }
        return;
      }
      sockets.add(ws);
      try { ws.send(JSON.stringify(buildState())); } catch { /* ignore */ }
      startPushLoop();
    },
    message(ws, msg) {
      const bridge = ptyBridges.get(ws);
      if (bridge) {
        bridge.onClientMessage(msg);
        return;
      }
      // /api/live: no client→server messages on the state-push socket.
    },
    close(ws) {
      const bridge = ptyBridges.get(ws);
      if (bridge) {
        ptyBridges.delete(ws);
        try { bridge.close(); } catch {}
        return;
      }
      sockets.delete(ws);
    },
  },
});

console.log(`subctl dashboard v${readSubctlVersion()} listening on http://${HOSTNAME}:${server.port}`);
