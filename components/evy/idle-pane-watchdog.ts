// components/evy/idle-pane-watchdog.ts
//
// Memory Init #7 follow-up — Idle-Pane Watchdog (control-plane reliability fix).
//
// Operator-observed bug, 2026-05-19: directives sent via tmux can land
// in the worker pane's prompt buffer WITHOUT being submitted (the
// `Enter` keystroke is lost / consumed by paste-bracketing / interrupted
// by an in-progress render). The worker then sits idle, the operator
// sees nothing happen, and the directive becomes invisible to both
// sides. This watchdog is the control-plane fix: it watches each
// known `claude-*` tmux pane, looks at the LAST line of the pane's
// captured content, and flags any trailing text that stays unchanged
// across N consecutive ticks as a "buffered-but-unsubmitted" candidate.
//
// Safety rules — these are NON-NEGOTIABLE because the watchdog is
// directly operating on operator/master communication:
//
//   1. We NEVER synthesize new work from arbitrary prompt text. The
//      detection path emits a notification + audit entry. Nothing else.
//   2. We NEVER press `Enter` on text whose content we cannot
//      independently verify. The optional auto-retry path fires ONLY
//      when the buffered line is a known prefix/suffix of a
//      recently-sent directive (registered explicitly via
//      `registerSentDirective`). Without that exact match the
//      watchdog defaults to notify-only.
//   3. Disabled by default. Config gate at
//      ~/.config/subctl/evy/idle-pane-watchdog.json — missing /
//      malformed file → defaults (disabled).
//
// The detection is intentionally CHEAP: one `tmux capture-pane` per
// session per tick, last 5 lines only, no shell parsing. The pane's
// hash IS NOT reused from the team-staleness watchdog because we need
// trailing-line discipline, not full-pane diff.

import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ─── config ────────────────────────────────────────────────────────────────

export interface IdlePaneWatchdogConfig {
  enabled: boolean;
  /** Capture interval. Default 30s. */
  interval_ms: number;
  /** A trailing line must remain unchanged across this many ticks before flagging. */
  idle_threshold_ticks: number;
  /**
   * v0.1: even when the buffered line exactly matches a recently-sent
   * directive, we DO NOT press Enter automatically unless this flag is
   * explicitly set. Notify-only is the safe default.
   */
  auto_retry_enabled: boolean;
  /** Max characters of trailing prompt-buffer to consider. */
  max_trailing_chars: number;
  /** Min characters before we even consider the line "interesting". */
  min_trailing_chars: number;
  /** Audit JSONL path. null → default under SUBCTL_CONFIG_DIR/master/. */
  audit_path: string | null;
  /** Audit rotation threshold. */
  audit_max_bytes: number;
  /** Suppression window — same session+text won't re-fire inside this window. */
  suppression_window_ms: number;
}

export const DEFAULT_IDLE_PANE_CONFIG: IdlePaneWatchdogConfig = {
  enabled: false,
  interval_ms: 30_000,
  idle_threshold_ticks: 3,
  auto_retry_enabled: false,
  max_trailing_chars: 1000,
  min_trailing_chars: 4,
  audit_path: null,
  audit_max_bytes: 2_000_000,
  suppression_window_ms: 15 * 60_000,
};

function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}

export function defaultIdlePaneConfigPath(): string {
  return join(subctlConfigDir(), "evy", "idle-pane-watchdog.json");
}

export function defaultIdlePaneAuditPath(): string {
  return join(subctlConfigDir(), "evy", "idle-pane-watchdog.audit.jsonl");
}

export function loadIdlePaneConfig(path?: string): IdlePaneWatchdogConfig {
  const p = path ?? defaultIdlePaneConfigPath();
  if (!existsSync(p)) return { ...DEFAULT_IDLE_PANE_CONFIG };
  let raw: Partial<IdlePaneWatchdogConfig>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Partial<IdlePaneWatchdogConfig>;
  } catch {
    return { ...DEFAULT_IDLE_PANE_CONFIG };
  }
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_IDLE_PANE_CONFIG.enabled,
    interval_ms:
      typeof raw.interval_ms === "number" && raw.interval_ms > 0
        ? raw.interval_ms
        : DEFAULT_IDLE_PANE_CONFIG.interval_ms,
    idle_threshold_ticks:
      typeof raw.idle_threshold_ticks === "number" && raw.idle_threshold_ticks > 0
        ? Math.floor(raw.idle_threshold_ticks)
        : DEFAULT_IDLE_PANE_CONFIG.idle_threshold_ticks,
    auto_retry_enabled:
      typeof raw.auto_retry_enabled === "boolean"
        ? raw.auto_retry_enabled
        : DEFAULT_IDLE_PANE_CONFIG.auto_retry_enabled,
    max_trailing_chars:
      typeof raw.max_trailing_chars === "number" && raw.max_trailing_chars > 0
        ? raw.max_trailing_chars
        : DEFAULT_IDLE_PANE_CONFIG.max_trailing_chars,
    min_trailing_chars:
      typeof raw.min_trailing_chars === "number" && raw.min_trailing_chars > 0
        ? raw.min_trailing_chars
        : DEFAULT_IDLE_PANE_CONFIG.min_trailing_chars,
    audit_path: typeof raw.audit_path === "string" ? raw.audit_path : null,
    audit_max_bytes:
      typeof raw.audit_max_bytes === "number" && raw.audit_max_bytes > 0
        ? raw.audit_max_bytes
        : DEFAULT_IDLE_PANE_CONFIG.audit_max_bytes,
    suppression_window_ms:
      typeof raw.suppression_window_ms === "number" && raw.suppression_window_ms >= 0
        ? raw.suppression_window_ms
        : DEFAULT_IDLE_PANE_CONFIG.suppression_window_ms,
  };
}

// ─── recently-sent directives registry ────────────────────────────────────
//
// In-memory ring of directive payloads master has sent into worker
// panes. The idle-pane watchdog checks buffered-but-idle pane text
// against this ring before considering an auto-retry. Other parts of
// master should call registerSentDirective(text) right after a successful
// send-keys + paste sequence. Wiring those callsites is a follow-up
// integration step — the registry being empty is harmless (watchdog
// silently falls back to notify-only).

const RECENT_DIRECTIVES_LIMIT = 64;
const _recentDirectives: { ts: number; text: string }[] = [];

export function registerSentDirective(text: string): void {
  if (typeof text !== "string" || text.length === 0) return;
  _recentDirectives.push({ ts: Date.now(), text });
  if (_recentDirectives.length > RECENT_DIRECTIVES_LIMIT) {
    _recentDirectives.shift();
  }
}

export function listRecentSentDirectives(): ReadonlyArray<{ ts: number; text: string }> {
  return _recentDirectives.slice();
}

/** @internal test helper */
export function _resetRecentDirectives(): void {
  _recentDirectives.length = 0;
}

// ─── pane providers (injectable for tests) ─────────────────────────────────

export interface PaneProviders {
  /** Enumerate session names eligible for inspection. */
  listSessions: () => string[];
  /** Capture the last K lines of a session's pane content; null on failure. */
  capturePane: (session: string, lastLines: number) => string | null;
  /** Send keys to a session. Returns false on failure. Only used by auto-retry. */
  sendKeys: (session: string, keys: string[]) => boolean;
  /** Emit a dashboard notification. */
  notify: (n: {
    kind: string;
    severity: "info" | "warn" | "alert";
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

/** Default providers backed by real tmux + emitNotification. */
export function defaultPaneProviders(emit: PaneProviders["notify"]): PaneProviders {
  return {
    listSessions: () => {
      try {
        const r = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"], {
          stdout: "pipe", stderr: "pipe",
        });
        if (r.exitCode !== 0) return [];
        return r.stdout.toString().trim().split("\n").filter((s) => s.startsWith("claude-"));
      } catch { return []; }
    },
    capturePane: (session, lastLines) => {
      try {
        const r = Bun.spawnSync(
          ["tmux", "capture-pane", "-p", "-t", `${session}:0`, "-S", `-${lastLines}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        if (r.exitCode !== 0) return null;
        return r.stdout.toString();
      } catch { return null; }
    },
    sendKeys: (session, keys) => {
      try {
        const r = Bun.spawnSync(["tmux", "send-keys", "-t", `${session}:0`, ...keys], {
          stdout: "pipe", stderr: "pipe",
        });
        return r.exitCode === 0;
      } catch { return false; }
    },
    notify: emit,
  };
}

// ─── audit ────────────────────────────────────────────────────────────────

export interface IdlePaneAuditEntry {
  ts: string;
  session: string;
  trailing_line: string;
  unchanged_for_ticks: number;
  matched_directive: boolean;
  attempted_enter: boolean;
  notified: boolean;
  suppressed: boolean;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function appendIdlePaneAudit(
  auditPath: string,
  entry: IdlePaneAuditEntry,
  maxBytes: number,
): void {
  ensureDir(auditPath);
  const line = JSON.stringify(entry) + "\n";
  if (existsSync(auditPath)) {
    try {
      const size = statSync(auditPath).size;
      if (size + line.length > maxBytes) {
        const rotated = auditPath + ".1";
        if (existsSync(rotated)) {
          try { unlinkSync(rotated); } catch { /* best-effort */ }
        }
        renameSync(auditPath, rotated);
      }
    } catch { /* fall through */ }
  }
  appendFileSync(auditPath, line);
}

// ─── detection ────────────────────────────────────────────────────────────

/**
 * Pull the last meaningful trailing line from a captured pane snapshot.
 * Strips ANSI-ish escape sequences (best-effort) and prompt markers we
 * recognize. Returns null when the trailing line is empty / too short.
 */
export function extractTrailingPromptLine(
  captured: string,
  config: { min_trailing_chars: number; max_trailing_chars: number },
): string | null {
  if (!captured) return null;
  // Best-effort ANSI strip — we don't care about every escape, only the
  // commonly-seen color/CSI sequences tmux capture-pane already strips.
  const stripped = captured.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Look at the LITERAL last line only. The buffered-but-unsubmitted
  // prompt sits on the cursor line, which is the line after the final
  // `\n`. If the capture ends with a newline (cursor on a blank line),
  // the trailing slot is empty → no buffered text → no flag. This is
  // important to distinguish "buffered directive sitting unsubmitted"
  // from "stale shell output scrolled above an empty prompt".
  const lastNewline = stripped.lastIndexOf("\n");
  const rawLast = lastNewline === -1 ? stripped : stripped.slice(lastNewline + 1);
  const trimmed = rawLast.replace(/\s+$/, "");
  if (trimmed.length === 0) return null;
  // Strip common prompt prefixes — claude-code uses "❯ ", "│", ">",
  // etc. We only need to recognize that something AFTER the prefix is
  // sitting there.
  const cleaned = trimmed.replace(/^[│┃|>❯$#%\s]+/, "");
  if (cleaned.length < config.min_trailing_chars) return null;
  if (cleaned.length > config.max_trailing_chars) {
    return cleaned.slice(0, config.max_trailing_chars);
  }
  return cleaned;
}

/**
 * Check whether a buffered trailing line matches (as suffix or full
 * text) any recently-sent directive. Conservative: only an exact suffix
 * match qualifies — we don't fuzzy-match. This is the gate the
 * auto-retry path passes through.
 */
export function matchesRecentDirective(
  trailing: string,
  recent: ReadonlyArray<{ ts: number; text: string }>,
  withinMs: number,
  now: number,
): boolean {
  if (!trailing) return false;
  for (const r of recent) {
    if (now - r.ts > withinMs) continue;
    if (r.text === trailing) return true;
    if (r.text.endsWith(trailing) && trailing.length >= 8) return true;
    if (trailing.endsWith(r.text) && r.text.length >= 8) return true;
  }
  return false;
}

// ─── tick + start ──────────────────────────────────────────────────────────

interface PaneState {
  trailing: string;
  unchanged_ticks: number;
  last_notified_at: number;
  last_notified_text: string;
}

export interface IdlePaneWatchdogState {
  panes: Map<string, PaneState>;
  tick_count: number;
}

export function emptyIdlePaneState(): IdlePaneWatchdogState {
  return { panes: new Map(), tick_count: 0 };
}

export interface IdlePaneTickResult {
  session: string;
  trailing: string | null;
  unchanged_ticks: number;
  flagged: boolean;
  matched_directive: boolean;
  attempted_enter: boolean;
  notified: boolean;
  suppressed: boolean;
}

export function runIdlePaneTick(
  state: IdlePaneWatchdogState,
  config: IdlePaneWatchdogConfig,
  providers: PaneProviders,
  now: Date,
): IdlePaneTickResult[] {
  state.tick_count++;
  const sessions = providers.listSessions();
  const seen = new Set<string>();
  const results: IdlePaneTickResult[] = [];

  for (const session of sessions) {
    seen.add(session);
    const captured = providers.capturePane(session, 10) ?? "";
    const trailing = extractTrailingPromptLine(captured, {
      min_trailing_chars: config.min_trailing_chars,
      max_trailing_chars: config.max_trailing_chars,
    });
    let pstate = state.panes.get(session);
    if (!pstate) {
      pstate = { trailing: "", unchanged_ticks: 0, last_notified_at: 0, last_notified_text: "" };
      state.panes.set(session, pstate);
    }

    if (trailing === null) {
      // Empty / uninteresting prompt buffer — reset counters.
      pstate.trailing = "";
      pstate.unchanged_ticks = 0;
      results.push({
        session,
        trailing: null,
        unchanged_ticks: 0,
        flagged: false,
        matched_directive: false,
        attempted_enter: false,
        notified: false,
        suppressed: false,
      });
      continue;
    }

    if (trailing === pstate.trailing) {
      pstate.unchanged_ticks++;
    } else {
      pstate.trailing = trailing;
      pstate.unchanged_ticks = 1;
    }

    let flagged = false;
    let matched_directive = false;
    let attempted_enter = false;
    let notified = false;
    let suppressed = false;

    if (pstate.unchanged_ticks >= config.idle_threshold_ticks) {
      flagged = true;
      matched_directive = matchesRecentDirective(
        trailing,
        listRecentSentDirectives(),
        Math.max(config.interval_ms * config.idle_threshold_ticks * 4, 5 * 60_000),
        now.getTime(),
      );

      // Suppression — same (session, text) within window stays quiet.
      const sameAsLast = pstate.last_notified_text === trailing;
      if (sameAsLast && pstate.last_notified_at > 0 &&
          now.getTime() - pstate.last_notified_at < config.suppression_window_ms) {
        suppressed = true;
      } else {
        if (matched_directive && config.auto_retry_enabled) {
          attempted_enter = providers.sendKeys(session, ["Enter"]);
        }
        providers.notify({
          kind: "idle-pane",
          severity: "warn",
          title: `idle-pane: ${session} appears stuck at prompt`,
          body: `Trailing line has not changed for ${pstate.unchanged_ticks} ticks. ${
            matched_directive
              ? "Matches a recently-sent directive."
              : "Does NOT match any recently-sent directive — notify-only."
          }`,
          metadata: {
            session,
            unchanged_ticks: pstate.unchanged_ticks,
            matched_directive,
            attempted_enter,
            trailing_preview: trailing.slice(0, 200),
          },
        });
        notified = true;
        pstate.last_notified_at = now.getTime();
        pstate.last_notified_text = trailing;
      }
    }

    const auditPath = config.audit_path ?? defaultIdlePaneAuditPath();
    try {
      appendIdlePaneAudit(auditPath, {
        ts: now.toISOString(),
        session,
        trailing_line: trailing,
        unchanged_for_ticks: pstate.unchanged_ticks,
        matched_directive,
        attempted_enter,
        notified,
        suppressed,
      }, config.audit_max_bytes);
    } catch { /* audit best-effort; don't crash the watchdog */ }

    results.push({
      session,
      trailing,
      unchanged_ticks: pstate.unchanged_ticks,
      flagged,
      matched_directive,
      attempted_enter,
      notified,
      suppressed,
    });
  }

  // GC pane state for sessions that vanished.
  for (const key of [...state.panes.keys()]) {
    if (!seen.has(key)) state.panes.delete(key);
  }

  return results;
}

// ─── start / watchdog wiring ───────────────────────────────────────────────

export interface IdlePaneWatchdogRegistry {
  register: (e: { id: string; kind: string; kill: () => void }) => void;
  touch: (id: string) => void;
}

export interface IdlePaneStartOptions {
  configOverride?: IdlePaneWatchdogConfig;
  configPath?: string;
  registry: IdlePaneWatchdogRegistry;
  providers: PaneProviders;
  now?: () => Date;
}

export interface IdlePaneStartResult {
  armed: boolean;
  config: IdlePaneWatchdogConfig;
  kill: () => void;
  /** Run one tick out-of-band. Returns null if not armed. */
  tickNow: () => IdlePaneTickResult[] | null;
  /** In-memory state snapshot, mostly for status surfaces + tests. */
  getState: () => IdlePaneWatchdogState;
}

export const IDLE_PANE_WATCHDOG_ID = "idle-pane";
export const IDLE_PANE_WATCHDOG_KIND = "idle-pane";

export function startIdlePaneWatchdog(opts: IdlePaneStartOptions): IdlePaneStartResult {
  const config = opts.configOverride ?? loadIdlePaneConfig(opts.configPath);
  const state = emptyIdlePaneState();

  if (!config.enabled) {
    return {
      armed: false,
      config,
      kill: () => undefined,
      tickNow: () => null,
      getState: () => state,
    };
  }

  let killed = false;
  const nowFn = opts.now ?? (() => new Date());

  const tickOnce = (): IdlePaneTickResult[] => {
    return runIdlePaneTick(state, config, opts.providers, nowFn());
  };

  const interval = setInterval(() => {
    if (killed) return;
    opts.registry.touch(IDLE_PANE_WATCHDOG_ID);
    try { tickOnce(); } catch (err) {
      console.error(`[idle-pane] tick threw: ${(err as Error).message ?? err}`);
    }
  }, config.interval_ms);

  const kill = () => {
    if (killed) return;
    killed = true;
    clearInterval(interval);
  };

  opts.registry.register({
    id: IDLE_PANE_WATCHDOG_ID,
    kind: IDLE_PANE_WATCHDOG_KIND,
    kill,
  });

  return {
    armed: true,
    config,
    kill,
    tickNow: () => (killed ? null : tickOnce()),
    getState: () => state,
  };
}
