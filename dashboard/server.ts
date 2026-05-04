// subctl dashboard server
//
// Single-file Bun HTTP + WebSocket server. Reads filesystem-only data sources
// (no API calls, no auth) and emits a JSON snapshot to the frontend.
//
// State JSON schema (also returned by GET /api/state):
// {
//   "version": "0.1.0",
//   "now": "2026-05-04T14:42:00Z",        // ISO8601 UTC
//   "warning": "accounts.conf not found",  // optional, top-level
//   "service": { "running": true, "port": 8787, "uptime_seconds": 15921 },
//   "accounts": [
//     {
//       "alias": "claude-personal",
//       "provider": "claude",
//       "email": "you@example.com",
//       "config_dir": "/Users/you/.claude-personal",
//       "auth_status": "ready" | "not_authenticated",
//       "active_sessions": 2,
//       "rl_hits_today": 0,
//       "last_activity_seconds_ago": 12        // null if never
//     }
//   ],
//   "sessions": [
//     {
//       "id": "abc12345",                       // first 8 of session uuid
//       "account": "claude-personal",
//       "repo": "myproject",                    // basename(cwd)
//       "branch": "main",
//       "ctx_pct": 11,
//       "age_seconds": 1620,
//       "model": "Opus 4.7"
//     }
//   ],
//   "rate_limits": {
//     "today_total": 0,
//     "by_account": [
//       { "account": "claude-personal", "count_today": 0,
//         "buckets_24h": [0,0,0,...]            // 24 hourly buckets, oldest -> newest
//       }
//     ]
//   },
//   "dispatch": {
//     "verdict": "green" | "yellow" | "red",
//     "reasons": ["..."]
//   }
// }

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

const VERSION = "0.1.0";
const PORT = Number(process.env.PORT ?? 8787);
const STARTED_AT = Date.now();

const HOME = homedir();
const ACCOUNTS_CONF = process.env.SUBCTL_ACCOUNTS_CONF
  ?? join(HOME, ".config", "subctl", "accounts.conf");
const RL_LOG = process.env.SUBCTL_RL_LOG
  ?? join(HOME, ".claude", "rate-limit-events.log");

const PUBLIC_DIR = join(import.meta.dir, "public");

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

// ---------- sessions ----------

interface SessionInfo {
  id: string;
  account: string;
  repo: string;
  branch: string;
  ctx_pct: number;
  age_seconds: number;
  model: string;
  account_config_dir: string;
  active: boolean;
}

const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

function readSessionsForAccount(account: Account, now: number): SessionInfo[] {
  const projectsDir = join(account.config_dir, "projects");
  const out: SessionInfo[] = [];
  const projectDirs = safeReaddir(projectsDir);
  for (const proj of projectDirs) {
    const projPath = join(projectsDir, proj);
    const st = safeStat(projPath);
    if (!st || !st.isDirectory()) continue;
    for (const file of safeReaddir(projPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const fp = join(projPath, file);
      const fst = safeStat(fp);
      if (!fst) continue;
      const ageMs = now - fst.mtimeMs;
      // Read first non-empty line for cwd / metadata.
      const raw = safeRead(fp);
      if (!raw) continue;
      const firstLine = raw.split("\n").find(l => l.trim().length > 0);
      let cwd = "";
      let model = "";
      let branch = "";
      let ctxPct = 0;
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine);
          cwd = parsed.cwd ?? "";
          model = parsed.model ?? parsed.model_name ?? "";
          branch = parsed.branch ?? parsed.git_branch ?? "";
          ctxPct = Number(parsed.ctx_pct ?? parsed.context_percent ?? 0) || 0;
        } catch { /* tolerate malformed lines */ }
      }
      const id = file.replace(/\.jsonl$/, "").slice(0, 8);
      out.push({
        id,
        account: account.alias,
        repo: cwd ? basename(cwd) : "(unknown)",
        branch: branch || "—",
        ctx_pct: ctxPct,
        age_seconds: Math.max(0, Math.floor(ageMs / 1000)),
        model: model || "—",
        account_config_dir: account.config_dir,
        active: ageMs <= ACTIVE_WINDOW_MS,
      });
    }
  }
  return out;
}

// ---------- rate limits ----------

interface RLBuckets {
  today_total: number;
  by_account: Map<string, { count_today: number; buckets_24h: number[] }>;
}

function buildRateLimits(accountAliases: string[], now: number): RLBuckets {
  const today = todayDateStr();
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  const currentHourMs = startOfHour.getTime();

  const byAccount = new Map<string, { count_today: number; buckets_24h: number[] }>();
  for (const a of accountAliases) {
    byAccount.set(a, { count_today: 0, buckets_24h: new Array(24).fill(0) });
  }

  const raw = safeRead(RL_LOG);
  if (!raw) return { today_total: 0, by_account: byAccount };

  let total = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try { ev = JSON.parse(t); } catch { continue; }
    const acct = ev.account ?? ev.alias ?? null;
    const date = ev.date ?? (typeof ev.ts === "string" ? ev.ts.slice(0, 10) : null);
    if (date === today) {
      total += 1;
      if (acct && byAccount.has(acct)) byAccount.get(acct)!.count_today += 1;
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
  return { today_total: total, by_account: byAccount };
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

// ---------- dispatch verdict ----------

function dispatchVerdict(state: {
  accounts: any[];
  sessions: any[];
  rate_limits: { today_total: number };
}): { verdict: "green" | "yellow" | "red"; reasons: string[] } {
  const reasons: string[] = [];
  if (state.accounts.length === 0) {
    return { verdict: "red", reasons: ["No accounts configured"] };
  }
  const unauth = state.accounts.filter(a => a.auth_status !== "ready");
  if (unauth.length === state.accounts.length) {
    return { verdict: "red", reasons: ["All accounts unauthenticated"] };
  }
  if (unauth.length > 0) reasons.push(`${unauth.length} account(s) not authenticated`);
  if (state.rate_limits.today_total > 0) {
    reasons.push(`${state.rate_limits.today_total} rate-limit hit(s) today`);
  }
  const activeSessions = state.sessions.length;
  if (activeSessions >= state.accounts.length * 3) {
    reasons.push(`High concurrency: ${activeSessions} active sessions`);
  }
  let verdict: "green" | "yellow" | "red" = "green";
  if (reasons.length > 0) verdict = "yellow";
  return { verdict, reasons };
}

// ---------- top-level state builder ----------

function buildState() {
  const now = Date.now();
  const { accounts: rawAccounts, warning } = parseAccountsConf();

  const sessions: SessionInfo[] = [];
  const accountSummaries: any[] = [];

  // Pre-compute rate limits so we can attach hits-today per account.
  const rl = buildRateLimits(rawAccounts.map(a => a.alias), now);

  for (const acc of rawAccounts) {
    const acctSessions = readSessionsForAccount(acc, now);
    sessions.push(...acctSessions);
    const active = acctSessions.filter(s => s.active);
    const lastMs = acctSessions.reduce(
      (min, s) => Math.min(min, s.age_seconds * 1000),
      Number.POSITIVE_INFINITY,
    );
    const rlEntry = rl.by_account.get(acc.alias);
    accountSummaries.push({
      alias: acc.alias,
      provider: acc.provider,
      email: acc.email,
      config_dir: acc.config_dir,
      auth_status: authStatus(acc),
      active_sessions: active.length,
      rl_hits_today: rlEntry?.count_today ?? 0,
      last_activity_seconds_ago: Number.isFinite(lastMs)
        ? Math.floor(lastMs / 1000)
        : null,
    });
  }

  // Only surface active sessions to the frontend; it's a "what's running now" view.
  const activeSessions = sessions
    .filter(s => s.active)
    .map(({ active: _a, account_config_dir: _c, ...rest }) => rest)
    .sort((a, b) => a.age_seconds - b.age_seconds);

  const rateLimits = {
    today_total: rl.today_total,
    by_account: Array.from(rl.by_account.entries()).map(([account, data]) => ({
      account,
      count_today: data.count_today,
      buckets_24h: data.buckets_24h,
    })),
  };

  const dispatch = dispatchVerdict({
    accounts: accountSummaries,
    sessions: activeSessions,
    rate_limits: rateLimits,
  });

  const state: any = {
    version: VERSION,
    now: new Date(now).toISOString(),
    service: {
      running: true,
      port: PORT,
      uptime_seconds: Math.floor((now - STARTED_AT) / 1000),
    },
    accounts: accountSummaries,
    sessions: activeSessions,
    rate_limits: rateLimits,
    dispatch,
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
    message(_ws, _msg) { /* no client->server messages in v0.1 */ },
    close(ws) { sockets.delete(ws); },
  },
});

console.log(`subctl dashboard listening on http://127.0.0.1:${server.port}`);
