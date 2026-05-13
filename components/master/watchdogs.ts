// components/master/watchdogs.ts
//
// v2.7.19 — Watchdog kill controls.
//
// Origin: 2026-05-13 at 21:30. Operator on a 90-minute drive home. The master
// daemon — running the heavy supervisor (qwen3.6-35b-a3b) — stopped responding
// to Telegram. Diagnostics later showed it was stuck in a tool-call loop:
//
//   assistant turn (stopReason="toolUse", empty text)
//   → tool result: { entries: [], listener: { running: false, ... } }
//   → another tool call (same tool, same empty result)
//   → repeat for 90 minutes
//
// The tool was subctl_orch_inbox (→ /api/notify/inbox), and the listener was
// the dashboard's notify-listener (separate from master's own telegram bot).
// The reasoning model fell into a "check again before answering" trap. CPU at
// 0.3% — looked idle, was actually deadlocked from the operator's perspective.
//
// Operator was explicit in advance:
//   "We need to be able to kill stale watchdogs, the operator and also
//    the orchestrator. Evy should be able to kill the watchdog."
//
// So this module is the minimal watchdog registry: anything in master that
// runs on a setInterval / loop and could go stale registers here, exposing a
// stable id, a kind, started_at / last_tick_at, and a kill() function. Three
// entry points consume the registry:
//
//   1. master tools — watchdog_list + watchdog_kill (Evy / agent surface)
//   2. dashboard    — /api/watchdogs + a collapsible panel in the chat tab
//   3. Telegram     — /watchdogs, /watchdogs kill <id>, /watchdogs killall
//
// Killall preserves kind="telegram-listener" so the operator's last surviving
// command path doesn't kill itself.

export type WatchdogKind =
  | "telegram-listener"   // master-notify-listener.ts long-poll
  | "cli-prompt-poll"     // master-notify-listener.ts cli-prompts.jsonl bridge
  | "inbox-poll"          // server.ts lead-report inbox tailer (2s)
  | "team-staleness"      // server.ts 3-min ticker (refreshTeamActivityFromTmux)
  | "followup-scheduler"  // server.ts 60s scheduler (popDueFollowups)
  | "auto-compact"        // server.ts 5min safety-net compact
  | "verifier-cluster"    // tools/policy/verifier-cluster.ts 30s denial scan
  | string;               // forward-compat: new ticker kinds without recompiling

export interface WatchdogEntry {
  id: string;
  kind: WatchdogKind;
  started_at: string;       // ISO 8601
  last_tick_at: string | null; // ISO 8601 or null if never ticked
  /**
   * Caller-supplied teardown. Should be idempotent — killWatchdog() guards
   * against double-invocation, but graceful shutdown paths might also call
   * the underlying clearInterval()/abort() independently.
   */
  kill: () => void;
}

export interface WatchdogSnapshot {
  id: string;
  kind: WatchdogKind;
  started_at: string;
  last_tick_at: string | null;
  age_seconds: number;
}

const _registry: Map<string, WatchdogEntry> = new Map();

/**
 * Register a watchdog. Throws on duplicate id — callers should pass a
 * descriptive unique id ("inbox-poll", "team-staleness-ticker"); duplicates
 * almost always indicate a leak (double-armed setInterval) we want loud.
 */
export function registerWatchdog(entry: {
  id: string;
  kind: WatchdogKind;
  kill: () => void;
}): WatchdogEntry {
  if (_registry.has(entry.id)) {
    throw new Error(`watchdog already registered: ${entry.id}`);
  }
  const record: WatchdogEntry = {
    id: entry.id,
    kind: entry.kind,
    started_at: new Date().toISOString(),
    last_tick_at: null,
    kill: entry.kill,
  };
  _registry.set(entry.id, record);
  return record;
}

/**
 * Bump the last_tick_at timestamp. Callers should invoke this from inside
 * the watchdog's tick body so the registry can answer "is this thing
 * actually firing?". Silent no-op for unknown ids (so tick wiring can't
 * crash the daemon if a watchdog was already killed).
 */
export function touchWatchdog(id: string): void {
  const entry = _registry.get(id);
  if (!entry) return;
  entry.last_tick_at = new Date().toISOString();
}

/**
 * Snapshot every watchdog for surfaces (UI, telegram, master tool).
 * Returns a fresh array each call — safe to filter/sort without mutating
 * registry state.
 */
export function listWatchdogs(): WatchdogSnapshot[] {
  const now = Date.now();
  return [..._registry.values()].map((w) => ({
    id: w.id,
    kind: w.kind,
    started_at: w.started_at,
    last_tick_at: w.last_tick_at,
    age_seconds: Math.max(0, Math.floor((now - Date.parse(w.started_at)) / 1000)),
  }));
}

/**
 * Kill one watchdog by id. Invokes its kill() (swallowing any throw so a
 * misbehaving teardown can't poison the registry), then removes the entry.
 * Returns { ok: false, error } when the id is unknown — the caller is
 * expected to report this back to the operator verbatim.
 */
export function killWatchdog(
  id: string,
): { ok: true; killed_id: string } | { ok: false; error: string } {
  const entry = _registry.get(id);
  if (!entry) {
    return { ok: false, error: `unknown watchdog id: ${id}` };
  }
  try {
    entry.kill();
  } catch (err) {
    // Don't surface this — the operator already wants this thing gone.
    // Best-effort: log to stderr so it surfaces in master.log, then
    // remove anyway so subsequent listWatchdogs() doesn't show ghosts.
    console.error(
      `[watchdog] kill threw for ${id}: ${(err as Error).message ?? err}`,
    );
  }
  _registry.delete(id);
  return { ok: true, killed_id: id };
}

/**
 * Kill every registered watchdog whose kind is NOT in the preserve set.
 * Used by the /watchdogs killall Telegram command — we MUST keep the
 * telegram listener alive, otherwise the operator just severed their
 * only kill path. Returns the killed + preserved id lists so the
 * Telegram reply can render them.
 */
export function killAllWatchdogs(opts: {
  preserve_kinds?: ReadonlyArray<WatchdogKind>;
} = {}): { killed: string[]; preserved: string[] } {
  const preserve = new Set(opts.preserve_kinds ?? []);
  const killed: string[] = [];
  const preserved: string[] = [];
  for (const entry of [..._registry.values()]) {
    if (preserve.has(entry.kind)) {
      preserved.push(entry.id);
      continue;
    }
    try {
      entry.kill();
    } catch (err) {
      console.error(
        `[watchdog] kill threw for ${entry.id} during killall: ${(err as Error).message ?? err}`,
      );
    }
    _registry.delete(entry.id);
    killed.push(entry.id);
  }
  return { killed, preserved };
}

/**
 * Test/teardown helper. Unconditionally clears the registry — used by
 * bun:test setup so individual tests don't leak watchdog entries
 * across files. NOT called from production paths; killWatchdog +
 * killAllWatchdogs handle the real shutdown cases.
 */
export function _resetForTesting(): void {
  _registry.clear();
}
