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
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { aggregateAll as aggregateCostAll, type AccountCostSummary } from "./lib/cost.ts";

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

// ---------- version (read once at startup) ----------

function readSubctlVersion(): string {
  try {
    const raw = readFileSync(join(REPO_ROOT, "lib", "core.sh"), "utf8");
    const m = raw.match(/^\s*SUBCTL_VERSION\s*=\s*"([^"]+)"/m);
    if (m && m[1]) return m[1];
  } catch { /* fall through */ }
  return "(unknown)";
}
const VERSION = readSubctlVersion();

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
}

let _usageCache: { fetchedAt: number; data: AccountUsageResult[] } | null = null;
// 5min — same cadence as the history poller. The /api/refresh endpoint
// (POST or GET) clears this cache for an explicit on-demand fetch.
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

// Shells out to `subctl usage --json` once per TTL window. The bash impl has
// its own 60s on-disk cache; this in-process cache just avoids spawning a
// subprocess on every WebSocket tick.
function subctlUsageFetchAll(now: number): AccountUsageResult[] {
  if (_usageCache && now - _usageCache.fetchedAt < USAGE_CACHE_TTL_MS) {
    return _usageCache.data;
  }
  try {
    const r = spawnSync(SUBCTL_BIN, ["usage", "--json"], {
      encoding: "utf8",
      timeout: 12_000,
    });
    if (r.error || (typeof r.status === "number" && r.status !== 0)) {
      _usageCache = { fetchedAt: now, data: [] };
      return [];
    }
    const parsed = JSON.parse(r.stdout || "[]") as AccountUsageResult[];
    _usageCache = { fetchedAt: now, data: parsed };
    return parsed;
  } catch {
    _usageCache = { fetchedAt: now, data: [] };
    return [];
  }
}

function usageForAlias(alias: string, all: AccountUsageResult[]): UsageEntry | null {
  const hit = all.find(u => u.alias === alias && u.ok);
  return hit?.usage ?? null;
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
    };
  });
}

// ---------- top-level state builder ----------

function buildState() {
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
  const usageAll = subctlUsageFetchAll(now);
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
    version: VERSION,
    now: new Date(now).toISOString(),
    service: {
      running: true,
      port: PORT,
      uptime_seconds: Math.floor((now - STARTED_AT) / 1000),
    },
    accounts: accountSummaries,
    sessions: sessionsOut,
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

const STATIC_FILES: Record<string, { path: string; type: string }> = {
  "/":            { path: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html":  { path: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" },
  "/style.css":   { path: join(PUBLIC_DIR, "style.css"),  type: "text/css; charset=utf-8" },
  "/app.js":      { path: join(PUBLIC_DIR, "app.js"),     type: "application/javascript; charset=utf-8" },
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
      title: "Account management",
      rows: [
        ["subctl accounts", "Show all configured accounts + auth status"],
        ["subctl auth claude <alias>", "Run OAuth flow for one account"],
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
      title: "Web dashboard UI",
      rows: [
        ["Dashboard tab", "Verdict + accounts + active tmux sessions + active conversations + cost + util + events"],
        ["Sessions tab", "Search every session across all accounts; copy resume cmd or open in iTerm"],
        ["Docs link", "Mintlify-style reference (this page → Cheat Sheet)"],
        ["Hover row in Session Browser", "Loads first user-message preview lazily"],
        ["[copy] button", "Puts CLAUDE_CONFIG_DIR=… claude --resume <sid> on clipboard"],
        ["[open in iTerm] button", "Spawns a new iTerm window pre-running the resume cmd (macOS)"],
        ["Click any session row", "Expands to show last 3 lines of that pane"],
        ["⟳ button (top-right)", "Force-refresh /api/oauth/usage (bypasses 5min cache)"],
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
      <span class="brand-version">v${VERSION}</span>
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
        <span>subctl v${VERSION}</span>
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
} from "./notify-listener";

const _listener = startNotifyListener({ stateProvider: buildState });
if (_listener.running) {
  console.log("[server] notify-listener started");
} else if (_listener.reason) {
  console.log(`[server] notify-listener not started: ${_listener.reason}`);
}

// ---------- server ----------

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/live") {
      if (srv.upgrade(req)) return undefined as any;
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
    if (url.pathname === "/api/version") {
      return new Response(JSON.stringify({ version: VERSION }), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    // POST or GET /api/refresh — bypass usage caches (in-process AND on-disk)
    // and return a fresh state snapshot. Clicked from the dashboard "↻" button
    // or invoked by scripts. Costs one API call per claude account; rest of
    // the day uses the normal 5-min auto-cadence.
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
      const fresh = buildState();
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

      const r = spawnSync("/usr/bin/osascript", ["-e", osascript], {
        encoding: "utf8", timeout: 5_000,
      });
      if (r.error || (typeof r.status === "number" && r.status !== 0)) {
        return new Response(JSON.stringify({
          ok: false,
          error: (r.stderr || r.stdout || String(r.error)).slice(0, 500),
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
      // Build subctl teams claude args. Spawn-only mode (no attach).
      const args: string[] = ["teams", "claude", "-a", account, "--no-attach"];
      if (body.orchestrator) args.push("-o");
      if (body.skip_perms) args.push("-y");
      if (body.continue) args.push("-c");
      if (typeof body.resume === "string" && body.resume) {
        args.push("--resume", String(body.resume));
      }
      if (typeof body.prompt === "string" && body.prompt) {
        args.push("-p", body.prompt);
      }
      const subctlBin = join(REPO_ROOT, "bin", "subctl");
      const r = spawnSync(subctlBin, args, {
        cwd: project,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, SUBCTL_NO_ATTACH: "1" },
      });
      if (r.error || (typeof r.status === "number" && r.status !== 0)) {
        return new Response(JSON.stringify({
          ok: false,
          error: (r.stderr || r.stdout || String(r.error)).slice(0, 800),
        }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
      // Compute session name the same way claude-teams does (basename + sanitize).
      const sessionName = "claude-" + project.split("/").pop()!.replace(/[.: ]/g, "_");
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
        spawned: !!live,
        attached: live?.attached ?? false,
        cwd: project,
        account,
        stdout: r.stdout?.slice(0, 600) ?? "",
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/orchestration" && req.method === "GET") {
      // List sessions whose env contains CLAUDE_CONFIG_DIR (i.e. spawned by
      // subctl teams claude) — separates orchestrator sessions from random
      // tmux noise.
      const rawSessions = listTmuxSessions();
      const result = rawSessions.map(s => {
        const cfg = tmuxShowEnv(s.name, "CLAUDE_CONFIG_DIR");
        return {
          name: s.name,
          path: s.path,
          attached: s.attached,
          windows: s.windows,
          claude_account_dir: cfg,
          is_orchestrator: cfg !== null,
        };
      }).filter(x => x.is_orchestrator);
      return new Response(JSON.stringify({ orchestrations: result }), {
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
        if (!text) {
          return new Response(JSON.stringify({ ok: false, error: "text required" }),
            { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const known = listTmuxSessions().some(s => s.name === name);
        if (!known) {
          return new Response(JSON.stringify({ ok: false, error: "session not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } });
        }
        // Use a tmux buffer so multi-line text injects safely (avoids escape chaos)
        const r1 = spawnSync(TMUX_BIN, ["set-buffer", "-b", "subctl-msg", text], { encoding: "utf8" });
        const r2 = spawnSync(TMUX_BIN, ["paste-buffer", "-t", name, "-b", "subctl-msg"], { encoding: "utf8" });
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
        const r = spawnSync(subctlBin, ["session-kill", name], { encoding: "utf8", timeout: 8_000 });
        if (r.error || (typeof r.status === "number" && r.status !== 0)) {
          return new Response(JSON.stringify({ ok: false, error: (r.stderr || r.stdout || String(r.error)).slice(0, 500) }),
            { status: 500, headers: { "Content-Type": "application/json" } });
        }
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
      sockets.add(ws);
      try { ws.send(JSON.stringify(buildState())); } catch { /* ignore */ }
      startPushLoop();
    },
    message(_ws, _msg) { /* no client->server messages */ },
    close(ws) { sockets.delete(ws); },
  },
});

console.log(`subctl dashboard v${VERSION} listening on http://127.0.0.1:${server.port}`);
