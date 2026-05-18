// components/master/watchdog-prune.ts
//
// v2.8.2 — Stale-team watchdog hardening.
//
// THE BUG IT FIXES
// ────────────────
// 2026-05-18: `claude-hermes-agent` and `claude-subctl` kept generating
// Telegram alerts for ~10h after their tmux sessions were destroyed.
// `system_watchdog_self` showed `tmux_session_exists: false` for both,
// yet `runStaleTeamSweep` continued to escalate.
//
// Two paths failed simultaneously:
//
//   1. `refreshTeamActivityFromTmux` (server.ts) prunes dead claude-*
//      sessions from `teamLastActivity`, BUT only when the outer
//      `tmux list-sessions` query succeeds. If the call errors (no
//      server running, transient EAGAIN, etc.) the prune block is
//      skipped silently and stale entries linger across many ticks.
//
//   2. `runStaleTeamSweep` (auto-nudge.ts) accepts an opt-in
//      `teamRegistryExists` predicate — but server.ts never wired one.
//      So when path #1 fails to prune, the sweep has zero defense and
//      nudges/alerts on the ghost team.
//
// On master restart, the inbox-watcher's first-scan path
// (`tailInboxFile` in server.ts, lines ~1395-1406) re-seeds
// `teamLastActivity` from the *last line* of any persisted
// `.../inbox/<team>.jsonl` — even for teams whose tmux session is long
// gone. That's how the watchdog "re-arms" on stale state every boot
// and why the operator's `watchdog_kill team-staleness` mitigation
// would have evaporated on the next restart.
//
// THE FIX (3 layers)
// ──────────────────
//   A. Per-team `tmux has-session` safety net inside the watchdog tick.
//      Even if the bulk prune in `refreshTeamActivityFromTmux` skips,
//      we re-check every tracked team before considering it for nudge/
//      escalate; missing sessions are removed in-place + emit one
//      low-noise `team_pruned` SSE event.
//
//   B. Lifecycle hook: the dashboard's
//      `POST /api/orchestration/:name/kill` notifies master via a new
//      internal `POST /teams/:name/prune` route, which drops the team
//      from `teamLastActivity` + `teamNudgeState` AND archives the
//      inbox file so the next master restart won't re-seed from it.
//
//   C. Inbox first-scan reconciliation: the boot scan refuses to
//      re-seed `teamLastActivity` for teams whose tmux session is not
//      currently alive, and archives the orphan inbox file out of the
//      polled dir.
//
// All three layers are individually sufficient for the steady-state
// case — together they survive any single point of failure (tmux
// transient error, dashboard not running at kill time, master killed
// mid-prune, etc.).

import {
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Result of attempting to prune one team. The caller emits the SSE +
 * decision log; this module stays effect-free aside from the actual
 * map mutations + optional inbox archival (which is itself injected
 * via the `archiveInbox` callback so tests can substitute a no-op).
 */
export type PruneReason =
  | "tmux-session-gone"
  | "operator-killed"
  | "orphan-inbox-on-boot";

export interface PruneDecision {
  team_id: string;
  reason: PruneReason;
  /** True when the inbox file was archived as part of the prune. */
  inbox_archived: boolean;
}

export interface TmuxRunner {
  /** Returns true iff `tmux has-session -t <name>` exits 0. */
  hasSession: (name: string) => boolean;
}

/**
 * Synchronous tmux check via `Bun.spawnSync`. Centralised here so
 * server.ts doesn't sprout multiple variants. Returns false on any
 * non-zero exit OR if the spawn itself errors (no tmux binary, no
 * server, etc.) — false is the safe default: it triggers a prune,
 * and a wrongly-pruned team will simply be re-seeded by the next
 * inbox event or tmux capture.
 */
export function defaultTmuxRunner(): TmuxRunner {
  return {
    hasSession: (name: string): boolean => {
      try {
        const r = Bun.spawnSync(["tmux", "has-session", "-t", name], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return r.exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}

export interface PruneOpts {
  /** Map of team_id → last-activity record. Mutated in-place. */
  teamLastActivity: Map<string, unknown>;
  /** Map of team_id → nudge state. Mutated in-place. */
  teamNudgeState?: Map<string, unknown>;
  /** Optional pane-hash cache to keep in sync. */
  teamPaneHash?: Map<string, unknown>;
  /** Optional read-offset cache (file path keyed) — pruned if matching team. */
  teamReadOffsets?: Map<string, unknown>;
  /** Inbox dir used to construct the per-team jsonl path. */
  inboxDir: string;
  tmux: TmuxRunner;
  /** When true, only inspect entries whose team_id starts with "claude-". */
  claudeOnly?: boolean;
  /** Hook to actually move the inbox file out of the polled dir. */
  archiveInbox?: (teamId: string, inboxDir: string) => boolean;
}

/**
 * Default inbox archival: rename `<inbox>/<team>.jsonl` to
 * `<inbox>/.archived/<team>.<epoch>.jsonl`. The leading `.archived`
 * means it's invisible to `for f in inbox/*.jsonl` consumers (CLI,
 * scanInboxOnce) — both globs skip dot-prefixed entries.
 *
 * Returns true iff a file was moved (false means no inbox file
 * existed, which is fine — nothing to do).
 */
export function archiveInboxFile(teamId: string, inboxDir: string): boolean {
  const src = join(inboxDir, `${teamId}.jsonl`);
  if (!existsSync(src)) return false;
  const archived = join(inboxDir, ".archived");
  try {
    mkdirSync(archived, { recursive: true, mode: 0o700 });
    const ts = Date.now();
    const dst = join(archived, `${teamId}.${ts}.jsonl`);
    renameSync(src, dst);
    return true;
  } catch {
    // Best-effort. A failed archival is non-fatal; the map prune
    // still happens and the next inbox poll will be a no-op since
    // `stat.size === prev` for the file (no new writes).
    return false;
  }
}

/**
 * Sweep every tracked team and drop those whose tmux session does
 * not currently exist. Returns the prune decisions so the caller
 * can emit one consolidated SSE event + decision-log line.
 *
 * Idempotent. Calling repeatedly on a clean map is a no-op.
 */
export function pruneVanishedTeams(opts: PruneOpts): PruneDecision[] {
  const decisions: PruneDecision[] = [];
  const archive = opts.archiveInbox ?? archiveInboxFile;

  for (const teamId of [...opts.teamLastActivity.keys()]) {
    if (opts.claudeOnly && !teamId.startsWith("claude-")) continue;
    if (opts.tmux.hasSession(teamId)) continue;

    opts.teamLastActivity.delete(teamId);
    opts.teamNudgeState?.delete(teamId);
    opts.teamPaneHash?.delete(teamId);
    if (opts.teamReadOffsets) {
      // Drop any read offsets keyed by absolute path that match this team.
      const suffix = `/${teamId}.jsonl`;
      for (const k of [...opts.teamReadOffsets.keys()]) {
        if (k.endsWith(suffix)) opts.teamReadOffsets.delete(k);
      }
    }
    const inbox_archived = archive(teamId, opts.inboxDir);
    decisions.push({
      team_id: teamId,
      reason: "tmux-session-gone",
      inbox_archived,
    });
  }
  return decisions;
}

/**
 * Prune one team explicitly — used by the kill-lifecycle hook
 * (dashboard POSTs to /teams/:name/prune after `subctl session-kill`
 * succeeds). Returns the decision iff the team was actually tracked;
 * returns null when the team wasn't in the map (idempotent — calling
 * twice is safe).
 *
 * NOTE: the `reason` here is "operator-killed" rather than
 * "tmux-session-gone" because we trust the lifecycle signal even if
 * the tmux process hasn't been reaped yet. The dashboard route runs
 * synchronously after `subctl session-kill` exits 0; by the time the
 * notify lands, the session is already gone.
 */
export function pruneOneTeam(
  teamId: string,
  opts: Omit<PruneOpts, "claudeOnly">,
  reason: PruneReason = "operator-killed",
): PruneDecision | null {
  const archive = opts.archiveInbox ?? archiveInboxFile;
  const had = opts.teamLastActivity.has(teamId);
  // Even if the team wasn't tracked, we still archive any orphan inbox
  // file — operator may have killed a session that never reported.
  const inbox_archived = archive(teamId, opts.inboxDir);
  if (!had && !inbox_archived) return null;

  opts.teamLastActivity.delete(teamId);
  opts.teamNudgeState?.delete(teamId);
  opts.teamPaneHash?.delete(teamId);
  if (opts.teamReadOffsets) {
    const suffix = `/${teamId}.jsonl`;
    for (const k of [...opts.teamReadOffsets.keys()]) {
      if (k.endsWith(suffix)) opts.teamReadOffsets.delete(k);
    }
  }
  return { team_id: teamId, reason, inbox_archived };
}
