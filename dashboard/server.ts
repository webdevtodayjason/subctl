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

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

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
  const a = alias.toLowerCase();
  if (a.includes("personal") || a.includes("jason"))   return "cyan";
  if (a.includes("work")     || a.includes("titanium"))return "blue";
  if (a.includes("overflow") || a.includes("semfreak"))return "magenta";
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
const USAGE_CACHE_TTL_MS = 30_000;

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
  const credsPath = join(account.config_dir, ".credentials.json");
  if (existsSync(credsPath)) return "ready";
  const projectsDir = join(account.config_dir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of safeReaddir(projectsDir)) {
      const st = safeStat(join(projectsDir, entry));
      if (st && st.isDirectory()) return "ready";
    }
  }
  return "not_authenticated";
}

// ---------- session enrichment ----------

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

  const totals = {
    tmux_sessions: sessionsOut.length,
    ready_accounts: accountSummaries.filter(a => a.auth_status === "ready").length,
    rl_today: rl.today_total,
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
    rate_limits: rateLimits,
    dispatch,
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

// ---------- server ----------

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, srv) {
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
