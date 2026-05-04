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

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

// ---------- thresholds (mirror lib/radar.sh) ----------

const THRESH_PARALLEL_RED    = 4;
const THRESH_PARALLEL_YELLOW = 2;
const THRESH_AGE_RED         = 21600; // 6h
const THRESH_AGE_YELLOW      = 7200;  // 2h
const THRESH_CTX_RED         = 80;
const THRESH_CTX_ORANGE      = 60;
const THRESH_CTX_YELLOW      = 30;
const THRESH_RL_RED          = 3;
const THRESH_RL_YELLOW       = 1;

function classifyParallel(n: number): "green" | "yellow" | "red" {
  if (n >= THRESH_PARALLEL_RED)    return "red";
  if (n >= THRESH_PARALLEL_YELLOW) return "yellow";
  return "green";
}
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
function classifyRl(n: number): "green" | "yellow" | "red" {
  if (n >= THRESH_RL_RED)    return "red";
  if (n >= THRESH_RL_YELLOW) return "yellow";
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

// Best-effort ctx % from the last usage block in the jsonl.
function ctxPctForFile(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) return 0;
  const raw = safeRead(jsonlPath);
  if (!raw) return 0;
  const lines = raw.split("\n");
  // Walk backwards to find the last non-empty line containing usage.
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t || !t.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(t);
      const usage = obj?.message?.usage ?? obj?.usage ?? null;
      if (!usage) continue;
      const curr = (usage.input_tokens ?? 0)
                 + (usage.cache_creation_input_tokens ?? 0)
                 + (usage.cache_read_input_tokens ?? 0)
                 + (usage.output_tokens ?? 0);
      if (curr <= 0) return 0;
      return Math.min(100, Math.floor(curr * 100 / 200000));
    } catch { /* continue */ }
  }
  return 0;
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

interface RLData {
  today_total: number;
  by_account: Map<string, { count_today: number; buckets_24h: number[] }>;
  by_session_today: Map<string, number>;
}

function buildRateLimits(accountAliases: string[], sidToAlias: Map<string, string>, now: number): RLData {
  const today = todayDateStr();
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  const currentHourMs = startOfHour.getTime();

  const byAccount = new Map<string, { count_today: number; buckets_24h: number[] }>();
  for (const a of accountAliases) {
    byAccount.set(a, { count_today: 0, buckets_24h: new Array(24).fill(0) });
  }
  const bySession = new Map<string, number>();

  const raw = safeRead(RL_LOG);
  if (!raw) return { today_total: 0, by_account: byAccount, by_session_today: bySession };

  let total = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try { ev = JSON.parse(t); } catch { continue; }
    const explicitAcct: string | null = ev.account ?? ev.alias ?? null;
    const sid: string | null = ev.session ?? null;
    const date = ev.date ?? (typeof ev.ts === "string" ? ev.ts.slice(0, 10) : null);

    // Resolve account: explicit > session lookup
    let acct = explicitAcct;
    if (!acct && sid && sidToAlias.has(sid)) acct = sidToAlias.get(sid)!;

    if (date === today) {
      total += 1;
      if (acct && byAccount.has(acct)) byAccount.get(acct)!.count_today += 1;
      if (sid) bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
    }
    // Hourly buckets covering the trailing 24h, oldest -> newest.
    if (typeof ev.ts === "string" && acct && byAccount.has(acct)) {
      const evMs = Date.parse(ev.ts);
      if (!Number.isNaN(evMs)) {
        const hoursAgo = Math.floor((currentHourMs - evMs) / (60 * 60 * 1000));
        if (hoursAgo >= 0 && hoursAgo < 24) {
          const idx = 23 - hoursAgo;
          byAccount.get(acct)!.buckets_24h[idx] += 1;
        }
      }
    }
  }
  return { today_total: total, by_account: byAccount, by_session_today: bySession };
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

function dispatchVerdict(
  accounts: ReturnType<typeof buildAccountSummaries>,
  sessions: SessionRecord[],
  rl: RLData,
): { verdict: "green" | "yellow" | "red"; reasons: string[] } {
  const reasons: string[] = [];
  let level: "green" | "yellow" | "red" = "green";
  const bump = (l: "yellow" | "red") => {
    if (l === "red") level = "red";
    else if (level !== "red") level = "yellow";
  };

  if (accounts.length === 0) {
    return { verdict: "red", reasons: ["No accounts configured"] };
  }

  const unauth = accounts.filter(a => a.auth_status !== "ready");
  if (unauth.length === accounts.length) {
    return { verdict: "red", reasons: ["All accounts unauthenticated"] };
  }
  if (unauth.length > 0) {
    bump("yellow");
    reasons.push(`${unauth.length} account(s) not authenticated`);
  }

  // Parallel sessions across all accounts.
  const parallelClass = classifyParallel(sessions.length);
  if (parallelClass === "red") {
    bump("red");
    reasons.push(`⚡ ${sessions.length} parallel sessions across all accounts (red ≥${THRESH_PARALLEL_RED})`);
  } else if (parallelClass === "yellow") {
    bump("yellow");
    reasons.push(`⚡ ${sessions.length} parallel sessions (yellow ≥${THRESH_PARALLEL_YELLOW})`);
  }

  // Per-session age.
  for (const s of sessions) {
    if (s.age_color === "red") {
      bump("red");
      reasons.push(`⏱ session ${formatAge(s.age_seconds)} old in ${s.project} (red ≥6h)`);
    } else if (s.age_color === "yellow") {
      bump("yellow");
      reasons.push(`⏱ session ${formatAge(s.age_seconds)} old in ${s.project} (yellow ≥2h)`);
    }
  }

  // Per-session ctx.
  for (const s of sessions) {
    if (s.ctx_color === "red") {
      bump("red");
      reasons.push(`ctx ${s.ctx_pct}% in ${s.project} (red ≥${THRESH_CTX_RED}%)`);
    } else if (s.ctx_color === "orange") {
      bump("yellow");
      reasons.push(`ctx ${s.ctx_pct}% in ${s.project} (orange ${THRESH_CTX_ORANGE}-${THRESH_CTX_RED-1}%)`);
    } else if (s.ctx_color === "yellow") {
      bump("yellow");
      reasons.push(`ctx ${s.ctx_pct}% in ${s.project} (yellow ≥${THRESH_CTX_YELLOW}%)`);
    }
  }

  // Rate-limits today.
  const rlClass = classifyRl(rl.today_total);
  if (rlClass === "red") {
    bump("red");
    reasons.push(`⚠ ${rl.today_total} rate-limit hits today (red ≥${THRESH_RL_RED})`);
  } else if (rlClass === "yellow") {
    bump("yellow");
    reasons.push(`⚠ ${rl.today_total} rate-limit hit${rl.today_total === 1 ? "" : "s"} today`);
  }

  return { verdict: level, reasons };
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}

// ---------- account summaries ----------

function buildAccountSummaries(
  accounts: Account[],
  sessions: SessionRecord[],
  rl: RLData,
  now: number,
) {
  return accounts.map(acc => {
    const mySessions = sessions.filter(s => s.account === acc.alias);
    const lastSec = mySessions.reduce(
      (min, s) => Math.min(min, s.age_seconds),
      Number.POSITIVE_INFINITY,
    );
    const rlEntry = rl.by_account.get(acc.alias);
    return {
      alias: acc.alias,
      provider: acc.provider,
      email: acc.email,
      config_dir: acc.config_dir,
      auth_status: authStatus(acc),
      active_sessions: mySessions.length,
      rl_hits_today: rlEntry?.count_today ?? 0,
      last_activity_seconds_ago: Number.isFinite(lastSec) ? lastSec : null,
      color_class: colorClassFor(acc.alias),
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

  const accountSummaries = buildAccountSummaries(rawAccounts, sessions, rl, now);

  const sessionsOut = sessions
    .slice()
    .sort((a, b) => a.age_seconds - b.age_seconds);

  const rateLimits = {
    today_total: rl.today_total,
    by_account: Array.from(rl.by_account.entries()).map(([account, data]) => ({
      account,
      color_class: colorClassFor(account),
      count_today: data.count_today,
      buckets_24h: data.buckets_24h,
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
