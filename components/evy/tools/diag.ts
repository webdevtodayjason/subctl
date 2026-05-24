// diag tools — self-diagnostic introspection for the master daemon.
//
// Origin: 2026-05-11. v2.7.0 just shipped. The M3's master daemon hit a
// watchdog bug firing on a stale tmux session. After the issue was
// resolved, the M3 agent reflected on what would have caught the bug
// and proposed seven self-diagnostic tools via Telegram. The operator
// accepted plus added an eighth (version awareness). All eight ship in
// v2.7.1 here. This is the persistent-supervisor loop working as
// designed: agent hits a failure mode, asks for capability, capability
// ships.
//
// Every tool in this family is READ-ONLY. No tool mutates subctl
// state — they exist purely so the master can answer "is the host
// healthy?" with first-hand evidence rather than an LLM guess.
//
// Tool family:
//   system_watchdog_self    — what the watchdog is currently watching
//   system_port_check       — which ports are bound, by whom
//   system_lmstudio_health  — LM Studio HTTP endpoint reachability
//   system_log_tail         — tail master/dashboard/lmstudio/tmux logs
//   system_rate_limit_status — per-account 5h / 7d utilization summary
//   system_git_status       — repo drift across ~/code (1-level walk)
//   system_network_health   — LAN gateway, tailscale, DNS, external
//   system_version_status   — VERSION + commit + tags + behind-origin

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSecret } from "../secrets";

const HOME = homedir();
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const LMSTUDIO_HOST =
  process.env.SUBCTL_LMSTUDIO_HOST ?? "http://localhost:1234";

// v2.7.4 — LM Studio gained an optional "Require API Token" toggle. When
// the operator enables it, every request — including the diag tools'
// reachability probes — must carry `Authorization: Bearer <token>` or
// the server 401s. Token resolved via the v2.7.4 priority chain (env
// var beats secrets.json beats absent — see components/evy/secrets.ts).
// Absent → empty headers map (back-compat for LM Studio servers without
// the toggle enabled, which is the default).
export function lmstudioAuthHeader(): Record<string, string> {
  const token = resolveSecret("lmstudio_api_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// macOS launchd PATH doesn't include /usr/sbin by default — the system.ts
// family hit this when sysctl/vm_stat silently failed under launchd. Use
// the same PATH-forcing pattern for every shell call here.
const SHELL_PATH =
  "/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin:/usr/local/bin";

// ─── injectable side-effect surface (for tests) ────────────────────────────
//
// Tests stub these via `_setDepsForTesting`. The tools call only into
// `deps.*`, never into the raw modules, so a test can swap in a fake
// shell that returns a canned `lsof` output without touching the
// machine. Pattern mirrors the policy module's `_resetCachesForTesting`
// convention.

interface Deps {
  shell: (cmd: string, opts?: { timeout?: number }) => string;
  fetchText: (url: string, opts?: { timeoutMs?: number; method?: string; body?: string; headers?: Record<string, string> }) => Promise<{
    ok: boolean;
    status: number;
    text: string;
    latencyMs: number;
    error?: string;
  }>;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  fileSize: (path: string) => number;
  listDir: (path: string) => string[];
  now: () => number;
}

const realDeps: Deps = {
  shell: (cmd, opts = {}) => {
    try {
      return execSync(cmd, {
        encoding: "utf8",
        timeout: opts.timeout ?? 3000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, PATH: SHELL_PATH },
      }).trim();
    } catch {
      return "";
    }
  },
  fetchText: async (url, opts = {}) => {
    const t0 = Date.now();
    try {
      // Merge: body→content-type baseline, plus any caller-supplied
      // headers (used in v2.7.4 to thread the LMSTUDIO_API_TOKEN bearer
      // through LM Studio probes). Caller headers win on conflict.
      const headers: Record<string, string> = {};
      if (opts.body) headers["content-type"] = "application/json";
      if (opts.headers) Object.assign(headers, opts.headers);
      const r = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: Object.keys(headers).length ? headers : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2500),
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text, latencyMs: Date.now() - t0 };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        text: "",
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  fileExists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  fileSize: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  now: () => Date.now(),
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── watchdog state binder ─────────────────────────────────────────────────
//
// The watchdog ticker lives in server.ts inside the startMaster() closure.
// To expose its state to system_watchdog_self without restructuring the
// daemon, we use the late-binder pattern (same as bindToolRegistry in
// system.ts): server.ts calls bindWatchdogState(getter) at boot, the diag
// tool calls the getter on demand. No circular import; no global mutable
// state visible outside this module.

export interface WatchdogStateSnapshot {
  /** Sessions the watchdog is actively tracking. */
  watching: Array<{
    team_id: string;
    tmux_session_id: string;
    last_seen_ms: number; // epoch ms
    /** v2.8.14 — epoch ms of the most recent successful auto-nudge POST
     *  for this team. null when no nudge has ever fired. */
    last_nudge_at_ms?: number | null;
    /** v2.8.14 — epoch ms of the first pane-hash change observed AFTER
     *  the most recent nudge. null when no post-nudge change has been
     *  detected (worker hasn't visibly replied yet). */
    last_reply_at_ms?: number | null;
    /** v2.8.14 — classifier kind for the worker's latest pane content
     *  ("working" | "completed_idle" | "awaiting_input" | "blocked").
     *  null when classification has never run. */
    reply_classification?: string | null;
    /** v2.8.14 — convenience flag: true iff `reply_classification ===
     *  "completed_idle"`. Suppresses escalation in decideTeamAction. */
    completion_flag?: boolean;
  }>;
  /** When the last watchdog tick ran (epoch ms, 0 if never). */
  last_tick_at_ms: number;
  /** When the watchdog last fired a synthetic prompt (0 if never). */
  last_fire_at_ms: number;
  /** Reason text from the last fire (empty if never). */
  last_fire_reason: string;
  /** Watchdog interval in minutes. */
  interval_minutes: number;
  /** Staleness threshold in minutes. */
  staleness_threshold_minutes: number;
}

let _watchdogStateGetter: (() => WatchdogStateSnapshot) | null = null;

export function bindWatchdogState(
  getter: () => WatchdogStateSnapshot,
): void {
  _watchdogStateGetter = getter;
}

// v2.8.15 — Cognee promotion observability binder. Independent of
// `WatchdogStateSnapshot` so the tmux-team-watching path doesn't pick up
// memory-pipeline fields that are noise from its perspective.
export interface CogneePromotionStateSnapshot {
  /** Wall-clock of the last tick start (epoch ms; 0 if never). */
  last_run_at_ms: number;
  /** Watermark `(ts, id)` tuple. `null` until the first successful promotion. */
  last_watermark_ts: string | null;
  last_watermark_id: string | null;
  /** Cumulative successful Tier 3 → Tier 4 writes since the state file was created. */
  total_promoted: number;
  /** Most recent ~5 failures (newest at the end). */
  recent_errors: Array<{ memori_id: string; error: string; ts: string }>;
  /** Configured tick interval in minutes (`SUBCTL_COGNEE_PROMOTION_INTERVAL_MIN`, default 10). */
  interval_minutes: number;
  /** Whether the ticker is currently armed (cognee + memori + memory_kernel + live probes). */
  armed: boolean;
}

let _cogneePromotionStateGetter: (() => CogneePromotionStateSnapshot) | null = null;

export function bindCogneePromotionState(
  getter: () => CogneePromotionStateSnapshot,
): void {
  _cogneePromotionStateGetter = getter;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isoOrNull(epochMs: number): string | null {
  if (!epochMs || epochMs <= 0) return null;
  return new Date(epochMs).toISOString();
}

function tmuxSessionExists(name: string): boolean {
  // `tmux has-session -t NAME` exits 0 if session exists, 1 otherwise.
  // execSync throws on non-zero, our shell helper swallows. We instead
  // use list-sessions (cached per-call) so this scales when a tool
  // checks N sessions.
  return _liveTmuxSessions().has(name);
}

function _liveTmuxSessions(): Set<string> {
  const out = deps.shell(`tmux list-sessions -F '#{session_name}'`, { timeout: 1500 });
  if (!out) return new Set();
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

// ─── tool 1: system_watchdog_self ──────────────────────────────────────────

const system_watchdog_self = {
  description:
    "Inspect the master daemon's watchdog state — what teams it's currently watching, when the last tick ran, when it last fired, and (critically) which watched tmux sessions no longer exist on the host. Use when asked 'is the watchdog healthy?', 'why did the watchdog fire?', or before troubleshooting a watchdog false-positive. Would have caught today's stale-tmux-session bug.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    if (!_watchdogStateGetter) {
      return {
        ok: false,
        error:
          "watchdog state not bound — daemon is mid-boot or startMaster() hasn't called bindWatchdogState() yet.",
      };
    }
    const snap = _watchdogStateGetter();
    const live = _liveTmuxSessions();
    const watching = snap.watching.map((w) => ({
      team_id: w.team_id,
      tmux_session_id: w.tmux_session_id,
      last_seen: isoOrNull(w.last_seen_ms),
      tmux_session_exists: live.has(w.tmux_session_id),
      // v2.8.14 — nudge/reply observability for false-positive debugging.
      last_nudge_at: isoOrNull(w.last_nudge_at_ms ?? 0),
      last_reply_at: isoOrNull(w.last_reply_at_ms ?? 0),
      reply_classification: w.reply_classification ?? null,
      completion_flag: w.completion_flag ?? false,
    }));
    const stuck_sessions = watching.filter((w) => !w.tmux_session_exists);
    return {
      ok: true,
      last_tick_at: isoOrNull(snap.last_tick_at_ms),
      last_fire_at: isoOrNull(snap.last_fire_at_ms),
      last_fire_reason: snap.last_fire_reason || null,
      interval_minutes: snap.interval_minutes,
      staleness_threshold_minutes: snap.staleness_threshold_minutes,
      watching_count: watching.length,
      currently_watching: watching,
      stuck_sessions,
      stuck_count: stuck_sessions.length,
    };
  },
};

// ─── tool 2: system_port_check ─────────────────────────────────────────────

const DEFAULT_PORTS = [8787, 8788, 1234];

interface PortRow {
  port: number;
  listening: boolean;
  pid_if_listening: number | null;
  process_name: string | null;
  user: string | null;
}

function checkOnePort(port: number): PortRow {
  // -iTCP:PORT  → only TCP on that port
  // -sTCP:LISTEN → only LISTEN state (skip ESTABLISHED inbound)
  // -n -P       → no DNS / port name resolution
  // -F pcLn     → field output: p=pid c=command L=user n=name
  const out = deps.shell(`lsof -iTCP:${port} -sTCP:LISTEN -n -P -F pcLn`, {
    timeout: 2500,
  });
  if (!out) {
    return {
      port,
      listening: false,
      pid_if_listening: null,
      process_name: null,
      user: null,
    };
  }
  // Parse lsof -F output: each record is several lines like
  //   p1234
  //   ccodexbun
  //   Lsem
  //   n*:8788
  // We keep the FIRST listener if multiple processes bind (rare).
  let pid: number | null = null;
  let cmd: string | null = null;
  let user: string | null = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p" && pid === null) pid = parseInt(val, 10) || null;
    else if (tag === "c" && cmd === null) cmd = val;
    else if (tag === "L" && user === null) user = val;
  }
  return {
    port,
    listening: pid !== null,
    pid_if_listening: pid,
    process_name: cmd,
    user,
  };
}

const system_port_check = {
  description:
    "Check whether a list of TCP ports is being listened on, and by which process. Defaults to subctl's own ports (8787 dashboard, 8788 master, 1234 LM Studio) when no list is given. Use to diagnose 'why won't the dashboard start?' (port conflict) or to confirm a daemon is up. Catches the orphaned-bun-vs-launchd class of bug.",
  schema: {
    type: "object",
    properties: {
      ports: {
        type: "array",
        items: { type: "number" },
        description:
          "Optional list of TCP ports to check. Defaults to [8787, 8788, 1234].",
      },
    },
    required: [],
  },
  invoke: async (args: { ports?: number[] } = {}) => {
    const ports =
      args.ports && args.ports.length > 0 ? args.ports : DEFAULT_PORTS;
    const rows = ports.map(checkOnePort);
    return {
      ok: true,
      checked_ports: ports,
      ports: rows,
      conflicts:
        rows.filter((r) => r.listening && r.process_name === null).length > 0
          ? "lsof returned hits with no command — investigate"
          : null,
    };
  },
};

// ─── tool 3: system_lmstudio_health ────────────────────────────────────────

const system_lmstudio_health = {
  description:
    "End-to-end LM Studio health: is the HTTP server reachable, does /v1/models respond, and does a tiny chat-completions ping return without error? Returns latency + last error if anything fails. Use when a worker reports model trouble — gives a fresh signal independent of system_lmstudio_models (which only lists known models, doesn't prove the API is responsive).",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    const url = LMSTUDIO_HOST;
    const reachableR = await deps.fetchText(`${url}/v1/models`, {
      timeoutMs: 2500,
      headers: lmstudioAuthHeader(),
    });
    const models_endpoint_ok = reachableR.ok;
    const reachable =
      reachableR.ok || (reachableR.status > 0 && reachableR.status < 600);

    let supervisor_responsive = false;
    let supervisor_latency_ms = 0;
    let supervisor_error: string | null = null;
    if (models_endpoint_ok) {
      // Tiny ping. We don't care about the assistant text — just that the
      // endpoint accepts a request without erroring. Use the first model
      // returned by /v1/models. If parsing fails, skip.
      let modelId: string | null = null;
      try {
        const parsed = JSON.parse(reachableR.text) as {
          data?: Array<{ id: string }>;
        };
        modelId = parsed.data?.[0]?.id ?? null;
      } catch {
        /* fall through — parser fail handled below */
      }
      if (modelId) {
        const pingR = await deps.fetchText(`${url}/v1/chat/completions`, {
          method: "POST",
          timeoutMs: 4000,
          headers: lmstudioAuthHeader(),
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
          }),
        });
        supervisor_responsive = pingR.ok;
        supervisor_latency_ms = pingR.latencyMs;
        if (!pingR.ok) supervisor_error = pingR.error ?? `http ${pingR.status}`;
      } else {
        supervisor_error = "no models returned by /v1/models";
      }
    } else {
      supervisor_error = reachableR.error ?? `http ${reachableR.status}`;
    }
    return {
      ok: models_endpoint_ok && supervisor_responsive,
      url,
      reachable,
      models_endpoint_ok,
      supervisor_responsive,
      models_endpoint_latency_ms: reachableR.latencyMs,
      supervisor_latency_ms,
      last_error: supervisor_error,
    };
  },
};

// ─── tool 4: system_log_tail ───────────────────────────────────────────────

type LogName = "master" | "tmux" | "lmstudio" | "dashboard";

const LOG_PATHS: Record<LogName, string> = {
  master: join(HOME, "Library", "Logs", "subctl", "evy.log"),
  dashboard: join(HOME, "Library", "Logs", "subctl", "dashboard.out.log"),
  tmux: "/tmp/tmux-server.log", // best-effort; tmux doesn't log by default
  lmstudio: join(HOME, ".lmstudio", "server-logs", "server.log"),
};

const system_log_tail = {
  description:
    "Read the last N lines of one of the master daemon's log files (master, dashboard, lmstudio, tmux). Use when diagnosing — agent previously could only point to a path, not read its contents. Caps at 500 lines per call to avoid context blowup.",
  schema: {
    type: "object",
    properties: {
      log: {
        type: "string",
        enum: ["master", "tmux", "lmstudio", "dashboard"],
        description: "Which log to tail.",
      },
      lines: {
        type: "number",
        description: "Number of trailing lines (1–500). Default 50.",
      },
    },
    required: ["log"],
  },
  invoke: async (args: { log: LogName; lines?: number }) => {
    const log = args.log;
    if (!log || !(log in LOG_PATHS)) {
      return {
        ok: false,
        error: `log must be one of: ${Object.keys(LOG_PATHS).join(", ")}`,
      };
    }
    const requestedLines = Math.min(Math.max(args.lines ?? 50, 1), 500);
    const path = LOG_PATHS[log];
    if (!deps.fileExists(path)) {
      return {
        ok: false,
        log,
        log_path: path,
        error: "log file does not exist",
      };
    }
    let raw = "";
    try {
      raw = deps.readFile(path);
    } catch (err) {
      return {
        ok: false,
        log,
        log_path: path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const allLines = raw.split("\n");
    // The last element is usually "" because logs end in \n. Strip it so
    // line counts match operator intuition.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    const tail = allLines.slice(-requestedLines);
    return {
      ok: true,
      log,
      log_path: path,
      total_size_bytes: deps.fileSize(path),
      total_lines_in_file: allLines.length,
      requested_lines: requestedLines,
      returned_lines: tail.length,
      lines: tail,
    };
  },
};

// ─── tool 5: system_rate_limit_status ──────────────────────────────────────

interface RLEntry {
  ts: number;
  alias: string;
  five_hour: number | null;
  seven_day: number | null;
  seven_day_sonnet: number | null;
}

function readUsageHistory(): RLEntry[] {
  const path = join(SUBCTL_CONFIG_DIR, "cache", "usage-history.jsonl");
  if (!deps.fileExists(path)) return [];
  let raw = "";
  try {
    raw = deps.readFile(path);
  } catch {
    return [];
  }
  const out: RLEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.alias === "string" && typeof j.ts === "number") {
        out.push({
          ts: j.ts,
          alias: j.alias,
          five_hour: typeof j.five_hour === "number" ? j.five_hour : null,
          seven_day: typeof j.seven_day === "number" ? j.seven_day : null,
          seven_day_sonnet:
            typeof j.seven_day_sonnet === "number" ? j.seven_day_sonnet : null,
        });
      }
    } catch {
      // skip malformed line — usage-history.jsonl is append-only and a
      // truncated tail line is normal under crash.
    }
  }
  return out;
}

const system_rate_limit_status = {
  description:
    "Per-account rate-limit utilization summary derived from subctl's local usage cache (no remote API call — uses the same data the dashboard renders). Returns the most recent observation per alias plus a 'healthiest_alias' pick. Lighter-weight than subctl_orch_state for spawn-decision use.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    const all = readUsageHistory();
    if (all.length === 0) {
      return {
        ok: false,
        error: "no usage history found",
        path: join(SUBCTL_CONFIG_DIR, "cache", "usage-history.jsonl"),
      };
    }
    // Group by alias, keep most recent.
    const latest = new Map<string, RLEntry>();
    for (const e of all) {
      const prev = latest.get(e.alias);
      if (!prev || e.ts > prev.ts) latest.set(e.alias, e);
    }
    const accounts = [...latest.values()]
      .map((e) => ({
        alias: e.alias,
        // We don't carry provider in the JSONL; infer from alias prefix.
        provider: e.alias.startsWith("openai-")
          ? "openai"
          : e.alias.startsWith("claude-")
            ? "claude"
            : "unknown",
        observed_at: new Date(e.ts).toISOString(),
        rl_5h_pct: e.five_hour,
        rl_week_pct: e.seven_day,
        rl_today_sonnet_pct: e.seven_day_sonnet,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    // Healthiest pick: lowest five-hour utilization that is still defined,
    // tiebreak on seven-day. Aliases with no data drop to the back.
    const healthiest = [...accounts]
      .filter((a) => a.rl_5h_pct !== null)
      .sort((a, b) => {
        const aFive = a.rl_5h_pct ?? 100;
        const bFive = b.rl_5h_pct ?? 100;
        if (aFive !== bFive) return aFive - bFive;
        return (a.rl_week_pct ?? 100) - (b.rl_week_pct ?? 100);
      })[0];
    return {
      ok: true,
      observed_count: accounts.length,
      accounts,
      healthiest_alias: healthiest?.alias ?? null,
    };
  },
};

// ─── tool 6: system_git_status ─────────────────────────────────────────────

const MAX_REPOS = 50;

const system_git_status = {
  description:
    "Walk a directory one level deep and report git status for every subdir that's a git repo: branch, ahead/behind origin, dirty flag, last fetch time. Defaults to ~/code. Capped at 50 repos. Use before spawning a team to catch repo drift (uncommitted work, behind origin, detached HEAD) that would derail the team's first push.",
  schema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        description:
          "Absolute path to walk one level deep. Defaults to ~/code.",
      },
    },
    required: [],
  },
  invoke: async (args: { root?: string } = {}) => {
    const root = args.root ?? join(HOME, "code");
    if (!deps.fileExists(root)) {
      return { ok: false, error: `root does not exist: ${root}`, root };
    }
    const entries = deps.listDir(root);
    const repos: Array<{
      path: string;
      name: string;
      branch: string | null;
      ahead: number;
      behind: number;
      dirty: boolean;
      last_fetched_at: string | null;
      last_commit: string | null;
      error?: string;
    }> = [];
    let walked = 0;
    let skipped = 0;
    for (const name of entries) {
      if (walked >= MAX_REPOS) {
        skipped = entries.length - walked;
        break;
      }
      const path = join(root, name);
      const gitDir = join(path, ".git");
      if (!deps.fileExists(gitDir)) continue;
      walked++;
      const branch = deps.shell(
        `git -C '${path}' rev-parse --abbrev-ref HEAD 2>/dev/null`,
        { timeout: 1500 },
      );
      const sb = deps.shell(`git -C '${path}' status --porcelain`, {
        timeout: 2000,
      });
      const dirty = sb.length > 0;
      // ahead/behind via @{u} — silently fail for branches with no upstream.
      const ab = deps.shell(
        `git -C '${path}' rev-list --left-right --count HEAD...@{u} 2>/dev/null`,
        { timeout: 1500 },
      );
      let ahead = 0,
        behind = 0;
      if (ab) {
        const m = ab.match(/^(\d+)\s+(\d+)/);
        if (m) {
          ahead = parseInt(m[1]!, 10);
          behind = parseInt(m[2]!, 10);
        }
      }
      // Last fetch time: mtime of .git/FETCH_HEAD if present.
      const fetchHead = join(gitDir, "FETCH_HEAD");
      let lastFetched: string | null = null;
      try {
        if (deps.fileExists(fetchHead)) {
          const m = statSync(fetchHead).mtimeMs;
          lastFetched = new Date(m).toISOString();
        }
      } catch {
        /* ignore */
      }
      const lastCommit = deps.shell(
        `git -C '${path}' log -1 --format='%h %s (%cr)' 2>/dev/null`,
        { timeout: 1500 },
      );
      repos.push({
        path,
        name,
        branch: branch || null,
        ahead,
        behind,
        dirty,
        last_fetched_at: lastFetched,
        last_commit: lastCommit || null,
      });
    }
    return {
      ok: true,
      root,
      walked_count: walked,
      skipped_due_to_cap: skipped,
      cap: MAX_REPOS,
      repos,
    };
  },
};

// ─── tool 7: system_network_health ─────────────────────────────────────────

const system_network_health = {
  description:
    "Network reachability snapshot: LAN gateway ping, tailscale status (if installed), DNS resolution for github.com + api.anthropic.com, and a TCP connect to a known reliable external host (1.1.1.1:443). Use when a worker reports it can't reach external APIs or when you suspect Wi-Fi / VPN trouble.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    // 1. LAN gateway via `route get default`. macOS-only; Linux differs but
    // subctl is mac-first.
    const routeOut = deps.shell("route -n get default 2>/dev/null", {
      timeout: 1500,
    });
    let gateway: string | null = null;
    const m = routeOut.match(/gateway:\s+(\S+)/);
    if (m) gateway = m[1]!;
    let lan_gateway_reachable = false;
    if (gateway) {
      // -c1 -W1: one packet, 1s timeout.
      const ping = deps.shell(`ping -c1 -W1 ${gateway} 2>/dev/null`, {
        timeout: 2500,
      });
      lan_gateway_reachable = /\b1 (received|packets received)/.test(ping);
    }

    // 2. Tailscale (optional — many hosts won't have it).
    const which_ts = deps.shell("command -v tailscale 2>/dev/null", {
      timeout: 1000,
    });
    let tailscale: { installed: boolean; status?: unknown; raw?: string } = {
      installed: !!which_ts,
    };
    if (which_ts) {
      const ts = deps.shell("tailscale status --json 2>/dev/null", {
        timeout: 2500,
      });
      if (ts) {
        try {
          tailscale = { installed: true, status: JSON.parse(ts) };
        } catch {
          tailscale = { installed: true, raw: ts.slice(0, 500) };
        }
      }
    }

    // 3. DNS — `dig +short`. Empty stdout ⇒ no resolution.
    const dnsHosts = ["github.com", "api.anthropic.com"];
    const dns_resolves: Record<string, boolean> = {};
    for (const host of dnsHosts) {
      const out = deps.shell(`dig +short +time=2 +tries=1 ${host} 2>/dev/null`, {
        timeout: 3000,
      });
      dns_resolves[host] = out.length > 0;
    }

    // 4. External reachability — Cloudflare 1.1.1.1:443. nc -zw2 → just try
    // to open the socket, 2s wall-clock timeout.
    const ncOut = deps.shell("nc -zw2 1.1.1.1 443 2>&1 || echo FAIL", {
      timeout: 3000,
    });
    const external_reachable = !ncOut.includes("FAIL") && !/refused|timed out|timeout/i.test(ncOut);

    return {
      ok: lan_gateway_reachable && external_reachable,
      gateway,
      lan_gateway_reachable,
      tailscale,
      dns_resolves,
      external_reachable,
    };
  },
};

// ─── tool 8: system_version_status ─────────────────────────────────────────

const system_version_status = {
  description:
    "Self-version awareness: the running subctl version (from VERSION), current commit SHA + message, count of commits behind origin/main, recent tags, and whether an update is available. Mirrors the safe-fetch pattern from lib/update.sh — fetch is bounded with a timeout and never mutates working tree.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    const versionPath = join(REPO_ROOT, "VERSION");
    let current_version = "unknown";
    if (deps.fileExists(versionPath)) {
      try {
        current_version = deps.readFile(versionPath).trim();
      } catch {
        /* keep "unknown" */
      }
    }
    const sha = deps.shell(`git -C '${REPO_ROOT}' rev-parse HEAD 2>/dev/null`, {
      timeout: 1500,
    });
    const subj = deps.shell(
      `git -C '${REPO_ROOT}' log -1 --format=%s HEAD 2>/dev/null`,
      { timeout: 1500 },
    );
    const lastCommitISO = deps.shell(
      `git -C '${REPO_ROOT}' log -1 --format=%cI HEAD 2>/dev/null`,
      { timeout: 1500 },
    );
    // Bounded fetch — same intent as lib/update.sh's safe-fetch (no force,
    // no merge, just refresh remote refs). Short timeout because the master
    // is calling this synchronously.
    deps.shell(`git -C '${REPO_ROOT}' fetch --quiet origin 2>/dev/null`, {
      timeout: 8000,
    });
    const behindStr = deps.shell(
      `git -C '${REPO_ROOT}' rev-list --count HEAD..origin/main 2>/dev/null`,
      { timeout: 1500 },
    );
    const behind_origin_main = parseInt(behindStr || "0", 10) || 0;
    const tagsRaw = deps.shell(
      `git -C '${REPO_ROOT}' tag -l --sort=-version:refname`,
      { timeout: 1500 },
    );
    const tags_available = tagsRaw
      ? tagsRaw.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 5)
      : [];
    const latest_tag = tags_available[0] ?? null;
    // days_since_last_pull: mtime of .git/FETCH_HEAD. After our fetch above
    // this should be ~0; if fetch failed (network down) it'll reflect the
    // last successful fetch.
    let daysSinceLastPull: number | null = null;
    try {
      const fh = join(REPO_ROOT, ".git", "FETCH_HEAD");
      if (deps.fileExists(fh)) {
        const m = statSync(fh).mtimeMs;
        daysSinceLastPull = (deps.now() - m) / 86_400_000;
      }
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      current_version,
      current_commit_sha: sha || null,
      current_commit_short_sha: sha ? sha.slice(0, 8) : null,
      current_commit_message: subj || null,
      current_commit_at: lastCommitISO || null,
      behind_origin_main,
      tags_available,
      latest_tag,
      update_available:
        behind_origin_main > 0 ||
        (latest_tag !== null && latest_tag !== `v${current_version}` && latest_tag !== current_version),
      days_since_last_pull:
        daysSinceLastPull === null ? null : Number(daysSinceLastPull.toFixed(2)),
    };
  },
};

// ─── tool 9: system_supervisor_info ────────────────────────────────────────
//
// Added 2026-05-12 (v2.7.2). The M3 agent asked, mid-conversation, how
// much context budget it had left and which model it was actually
// running on — the supervisor model id and its loaded context window.
// Operator pulled the trigger same morning along with the web tools.
//
// Reads three sources:
//   1. ~/.config/subctl/evy/providers.json — configured supervisor
//      role (provider, model, host).
//   2. LM Studio's /api/v0/models — loaded state of THAT specific
//      model (state, loaded_context_length, max_context_length,
//      quantization, arch). This is the LM-Studio-specific extension
//      to OpenAI's /v1/models; the v2.7.1 auto-compact tick already
//      uses it.
//   3. ~/.config/subctl/evy/compact.json — auto-compact policy
//      (threshold_pct, target_tokens, keep_recent). Missing file
//      falls back to the daemon's documented defaults — that's
//      treated as a healthy state, not an error.
//
// Read-only. No transcript snooping (the daemon-side msg/util numbers
// aren't bound through here yet — keep this PR additive).

const EVY_STATE_DIR_FOR_INFO = join(SUBCTL_CONFIG_DIR, "evy");

interface ProvidersJson {
  models?: {
    supervisor?: {
      provider?: string;
      model?: string;
      host?: string;
      context_length?: number;
    };
  };
}

interface CompactJson {
  auto_compact?: boolean;
  threshold_pct?: number;
  target_tokens?: number;
  keep_recent?: number;
}

interface LMStudioModelRow {
  id: string;
  type?: string;
  state?: string;
  loaded_context_length?: number;
  max_context_length?: number;
  quantization?: string;
  arch?: string;
  publisher?: string;
}

const COMPACT_DEFAULTS: Required<CompactJson> = {
  auto_compact: true,
  threshold_pct: 90,
  target_tokens: 50_000,
  keep_recent: 6,
};

const system_supervisor_info = {
  description:
    "Introspection about the agent's own runtime: which supervisor model is configured (from providers.json), its loaded + max context length from LM Studio, and the auto-compact policy (from compact.json, with daemon defaults if missing). The agent uses this to reason about its own context budget — 'do I have room for a 30K-token tool result?' and similar. Read-only.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    // 1. Configured supervisor from providers.json.
    const providersPath = join(EVY_STATE_DIR_FOR_INFO, "providers.json");
    if (!deps.fileExists(providersPath)) {
      return {
        ok: false,
        error: `providers.json missing at ${providersPath}. Master daemon hasn't been initialized — run \`subctl evy enable\` to seed it from providers.json.example.`,
        providers_path: providersPath,
      };
    }
    let providers: ProvidersJson;
    try {
      providers = JSON.parse(deps.readFile(providersPath)) as ProvidersJson;
    } catch (err) {
      return {
        ok: false,
        error: `providers.json unreadable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        providers_path: providersPath,
      };
    }
    const sup = providers.models?.supervisor;
    if (!sup || !sup.model || !sup.provider) {
      return {
        ok: false,
        error:
          "providers.json missing models.supervisor.provider or models.supervisor.model — agent cannot self-introspect without a configured supervisor.",
        providers_path: providersPath,
      };
    }
    // 2. Auto-compact policy (always returns something — defaults are healthy).
    const compactPath = join(EVY_STATE_DIR_FOR_INFO, "compact.json");
    let compact: Required<CompactJson> = { ...COMPACT_DEFAULTS };
    let compact_source: "file" | "defaults" = "defaults";
    if (deps.fileExists(compactPath)) {
      try {
        const raw = JSON.parse(deps.readFile(compactPath)) as CompactJson;
        compact = { ...COMPACT_DEFAULTS, ...raw };
        compact_source = "file";
      } catch {
        // Malformed compact.json → fall back to defaults silently. The
        // auto-compact ticker in server.ts uses the same try/catch
        // pattern; mirror that behavior here for consistency.
        compact_source = "defaults";
      }
    }
    // 3. Loaded model info from LM Studio's /api/v0/models — the
    // OpenAI-compatible /v1/models endpoint does NOT include
    // loaded_context_length / state, so use LM Studio's extension.
    // Strip a trailing /v1 from the host since /api/v0 is on the root.
    const supHost = (sup.host ?? `${LMSTUDIO_HOST}/v1`).replace(/\/v1\/?$/, "");
    const modelsR = await deps.fetchText(`${supHost}/api/v0/models`, {
      timeoutMs: 2500,
      headers: lmstudioAuthHeader(),
    });
    if (!modelsR.ok) {
      return {
        ok: false,
        error: `LM Studio /api/v0/models unreachable at ${supHost}: ${
          modelsR.error ?? `http ${modelsR.status}`
        }. Loaded model state unavailable.`,
        supervisor: {
          provider: sup.provider,
          model_id: sup.model,
          host: supHost,
          configured_context_length: sup.context_length ?? null,
        },
        auto_compact: compact,
        auto_compact_source: compact_source,
      };
    }
    let modelsJson: { data?: LMStudioModelRow[] };
    try {
      modelsJson = JSON.parse(modelsR.text) as { data?: LMStudioModelRow[] };
    } catch (err) {
      return {
        ok: false,
        error: `LM Studio /api/v0/models returned invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const row = (modelsJson.data ?? []).find((m) => m.id === sup.model) ?? null;
    return {
      ok: true,
      supervisor: {
        provider: sup.provider,
        model_id: sup.model,
        host: supHost,
        configured_context_length: sup.context_length ?? null,
      },
      loaded: row
        ? {
            is_loaded: row.state === "loaded",
            state: row.state ?? null,
            loaded_context_length: row.loaded_context_length ?? null,
            max_context_length: row.max_context_length ?? null,
            type: row.type ?? null,
            quantization: row.quantization ?? null,
            arch: row.arch ?? null,
            publisher: row.publisher ?? null,
          }
        : {
            is_loaded: false,
            state: null,
            loaded_context_length: null,
            max_context_length: null,
            type: null,
            quantization: null,
            arch: null,
            publisher: null,
            note: `supervisor model id '${sup.model}' not found in LM Studio model list — model not installed, or id drift between providers.json and LM Studio's catalog.`,
          },
      auto_compact: compact,
      auto_compact_source: compact_source,
    };
  },
};

// ─── tool: system_cognee_promotion_self ────────────────────────────────────

const system_cognee_promotion_self = {
  description:
    "Inspect the Cognee promotion ticker — when it last ran, where the (ts,id) watermark is, total promoted since boot, and the last few errors. Use when asked 'is the Tier 3 → Tier 4 promotion running?', 'why isn't Cognee growing?', or before troubleshooting a memory-pipeline stall. Surface for the v2.8.15 promotion ticker.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    if (!_cogneePromotionStateGetter) {
      return {
        ok: false,
        error:
          "cognee-promotion state not bound — daemon is mid-boot, TOOL_GATES.cognee is off, or the ticker never armed (Cognee or Memori unreachable at boot).",
      };
    }
    const snap = _cogneePromotionStateGetter();
    return {
      ok: true,
      armed: snap.armed,
      interval_minutes: snap.interval_minutes,
      last_run_at: isoOrNull(snap.last_run_at_ms),
      last_run_at_ms: snap.last_run_at_ms || null,
      last_watermark_ts: snap.last_watermark_ts,
      last_watermark_id: snap.last_watermark_id,
      total_promoted: snap.total_promoted,
      recent_error_count: snap.recent_errors.length,
      recent_errors: snap.recent_errors.slice(-5),
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const diagTools = {
  system_watchdog_self,
  system_port_check,
  system_lmstudio_health,
  system_log_tail,
  system_rate_limit_status,
  system_git_status,
  system_network_health,
  system_version_status,
  system_supervisor_info,
  system_cognee_promotion_self,
};
