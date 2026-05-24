// components/evy/team-gc.ts
//
// v2.7.32 — Startup-time garbage collection for stale team registry dirs.
//
// THE PROBLEM IT FIXES
// ────────────────────
// `~/.local/state/subctl/teams/<team_id>/` accumulates one directory per
// `subctl orch spawn` invocation. Each holds a per-team HMAC secret +
// policy snapshot (ADR 0011, v2.7.20). The directory is NOT cleaned up
// when the tmux session dies — we keep it intentionally so a re-spawn of
// the same team_id reuses its HMAC secret (rotation is an explicit
// operator action).
//
// In practice this means CLI test runs leave behind dirs forever:
//   ~/.local/state/subctl/teams/policy-fix-verify     (May 12, never touched again)
//   ~/.local/state/subctl/teams/ship-verify-test      (May 12, never touched again)
//
// The team-staleness watchdog used to repeatedly evaluate them. v2.7.32's
// watchdog reconciliation (auto-nudge.ts) handles the case where the dir
// disappears mid-tracking; this module is the proactive sweep that
// removes the dirs themselves once they're provably unused.
//
// HEURISTICS
// ──────────
// We don't have a "team is dead" signal so we infer staleness from two
// independent timestamps:
//
//   1. policy.snapshot.toml mtime — written once at spawn time, never
//      re-touched. If it's older than 14 days, the team was last
//      provisioned > 14 days ago.
//   2. audit log activity (~/.local/state/subctl/audit/<team_id>.jsonl) —
//      written by the policy engine on every Bash invocation inside the
//      team. If the file is missing OR its mtime is older than 7 days,
//      the team has done nothing audit-worthy in a week.
//
// Both must be true. The two are AND'd because a team can have a fresh
// snapshot (just spawned) but no audit yet, OR an old snapshot but active
// audit (long-running team). Only the AND is unambiguous-dead.
//
// ARCHIVAL, NOT DELETION
// ──────────────────────
// We move the team dir to `~/.local/state/subctl/teams/.killed/<team_id>/`
// rather than deleting it. The operator can dig the HMAC secret out for a
// forensic re-spawn, and the dir is preserved for audit trail. Deletion
// of `.killed/` itself is an explicit operator action — not this module's
// job.
//
// IDEMPOTENCY
// ───────────
// runStartupTeamGC is safe to call repeatedly. Already-archived dirs (in
// `.killed/`) are ignored; teams that don't meet the GC predicate are
// left untouched. The watchdog never races this — GC runs synchronously
// during master boot, before the team-staleness ticker is armed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface TeamGCConfig {
  teams_dir: string;
  audit_dir: string;
  /** Inclusive — snapshot mtime must be strictly older than (now - this) to qualify. */
  snapshot_max_age_ms: number;
  /** Inclusive — audit mtime must be missing OR strictly older than (now - this). */
  audit_max_age_ms: number;
  /** Date.now()-style ms; injected for testability. */
  now_ms: number;
}

export interface TeamGCDecision {
  team_id: string;
  /** "kept" | "gc'd" | "skipped:<reason>". */
  action:
    | "kept"
    | "archived"
    | "skipped-no-snapshot"
    | "skipped-fresh-snapshot"
    | "skipped-recent-audit";
  snapshot_age_days?: number;
  audit_age_days?: number | null;
}

export interface TeamGCCallbacks {
  /** Optional notification hook. Implementation wires this to emitNotification. */
  emitNotification?: (input: {
    team_id: string;
    title: string;
    body: string;
  }) => void;
  /** Optional decision log hook. */
  logDecision?: (team_id: string, action: string, rationale: string) => void;
}

/** Default thresholds per the v2.7.32 spec. Exposed so tests/operators can override. */
export const DEFAULT_SNAPSHOT_MAX_AGE_DAYS = 14;
export const DEFAULT_AUDIT_MAX_AGE_DAYS = 7;

/**
 * Inspect every team dir under teams_dir; return an array of decisions
 * AND perform the archival side-effects (mv to .killed/). Pure-by-default
 * for testing when emitNotification is omitted.
 *
 * Returns the full set of decisions (including kept entries) so the
 * caller can print a "scanned N teams, archived M" summary at boot.
 */
export function runStartupTeamGC(
  cfg: TeamGCConfig,
  callbacks: TeamGCCallbacks = {},
): TeamGCDecision[] {
  const decisions: TeamGCDecision[] = [];

  if (!existsSync(cfg.teams_dir)) {
    // No teams dir → nothing to clean. Idempotent no-op.
    return decisions;
  }

  let entries;
  try {
    entries = readdirSync(cfg.teams_dir, { withFileTypes: true });
  } catch {
    return decisions;
  }

  const killedDir = join(cfg.teams_dir, ".killed");

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip the archive bucket itself + any dotfile-style hidden dirs.
    if (entry.name.startsWith(".")) continue;

    const teamId = entry.name;
    const teamPath = join(cfg.teams_dir, teamId);
    const snapshotPath = join(teamPath, "policy.snapshot.toml");

    // Predicate 1 — snapshot mtime.
    if (!existsSync(snapshotPath)) {
      // No snapshot means we can't reason about provenance — leave alone.
      // (Includes templates / legacy dirs without policy wiring.)
      decisions.push({ team_id: teamId, action: "skipped-no-snapshot" });
      continue;
    }
    let snapshotMtimeMs: number;
    try {
      snapshotMtimeMs = statSync(snapshotPath).mtimeMs;
    } catch {
      decisions.push({ team_id: teamId, action: "skipped-no-snapshot" });
      continue;
    }
    const snapshotAgeMs = cfg.now_ms - snapshotMtimeMs;
    const snapshotAgeDays = snapshotAgeMs / 86_400_000;
    if (snapshotAgeMs < cfg.snapshot_max_age_ms) {
      decisions.push({
        team_id: teamId,
        action: "skipped-fresh-snapshot",
        snapshot_age_days: snapshotAgeDays,
      });
      continue;
    }

    // Predicate 2 — audit activity.
    const auditPath = join(cfg.audit_dir, `${teamId}.jsonl`);
    let auditAgeMs: number | null = null;
    if (existsSync(auditPath)) {
      try {
        const auditMtimeMs = statSync(auditPath).mtimeMs;
        auditAgeMs = cfg.now_ms - auditMtimeMs;
      } catch {
        auditAgeMs = null; // treat unreadable as absent
      }
    }
    // Audit absent OR older than audit_max_age_ms → qualifies for GC.
    if (auditAgeMs !== null && auditAgeMs < cfg.audit_max_age_ms) {
      decisions.push({
        team_id: teamId,
        action: "skipped-recent-audit",
        snapshot_age_days: snapshotAgeDays,
        audit_age_days: auditAgeMs / 86_400_000,
      });
      continue;
    }

    // Both predicates satisfied — archive.
    try {
      mkdirSync(killedDir, { recursive: true, mode: 0o700 });
      // Suffix with timestamp so repeated GC runs that produce the same
      // teamId can coexist in the archive (rare but possible if an
      // operator re-spawned a team that we then re-archived).
      const archiveName =
        existsSync(join(killedDir, teamId))
          ? `${teamId}.${Date.now()}`
          : teamId;
      renameSync(teamPath, join(killedDir, archiveName));
    } catch (err) {
      // Failure here is non-fatal — log via decision callback if provided
      // and move on. Team dir stays in place; next boot will retry.
      if (callbacks.logDecision) {
        callbacks.logDecision(
          teamId,
          "team_gc_failed",
          `archive failed: ${(err as Error).message}`,
        );
      }
      decisions.push({
        team_id: teamId,
        action: "kept",
        snapshot_age_days: snapshotAgeDays,
        audit_age_days: auditAgeMs === null ? null : auditAgeMs / 86_400_000,
      });
      continue;
    }

    decisions.push({
      team_id: teamId,
      action: "archived",
      snapshot_age_days: snapshotAgeDays,
      audit_age_days: auditAgeMs === null ? null : auditAgeMs / 86_400_000,
    });

    if (callbacks.emitNotification) {
      const snapDays = Math.round(snapshotAgeDays);
      const audDays =
        auditAgeMs === null ? "never" : `${Math.round(auditAgeMs / 86_400_000)}d`;
      callbacks.emitNotification({
        team_id: teamId,
        title: `team ${teamId} archived (idle)`,
        body:
          `Team registry dir was archived to teams/.killed/ at boot — ` +
          `policy snapshot ${snapDays}d old, audit ${audDays} old. ` +
          `Re-spawn with \`subctl orch spawn\` will create a fresh dir; ` +
          `the archived secret can be recovered manually from ` +
          `teams/.killed/${teamId}/hmac.secret if needed.`,
      });
    }
    if (callbacks.logDecision) {
      callbacks.logDecision(
        teamId,
        "team_gc_archived",
        `snapshot=${Math.round(snapshotAgeDays)}d audit=${auditAgeMs === null ? "absent" : `${Math.round(auditAgeMs / 86_400_000)}d`}`,
      );
    }
  }

  return decisions;
}
