// components/master/tools/policy/verifier-cluster.ts
//
// Denial-cluster detection + correction firing.
// Pack 06 §7 + HANDOFF_DIGEST D8 (β: pulled into v2.7.0 as PR 6.5).
//
// This is the "subctl is a persistent supervisor watching the gate, not just
// a hook" feature. When a Gated-mode worker repeatedly hits policy denials,
// the master spots the pattern and fires a synthetic `[verifier]` correction
// prompt at the worker telling it to stop fighting the gate and either pick a
// different approach or ask the operator for permission.
//
// Two triggers, both per-team:
//   - BURST:           > 5 deny entries in the last 60 seconds
//   - STUCK_ON_PATTERN: > 3 deny entries with the same rule_path in 5 minutes
//
// Either fires. Burst takes precedence if both would fire on the same tick.
//
// Per-team in-memory state (resets on master restart):
//   - correctionCount[teamId]: how many corrections fired for this team.
//     After 2, we give up: log the cluster to ~/.config/subctl/master/decisions.jsonl
//     for operator review (mirrors the existing post-turn claim verifier's
//     2-correction giveup behavior in server.ts §verifier gate).
//   - lastCorrectionAt[teamId]: cooldown clock. After a fire, suppress further
//     fires for that team for 5 minutes — don't hammer the worker while it's
//     still digesting the previous correction.
//
// Worker delivery uses the same tmux paste-buffer + send-keys pattern that
// dashboard/server.ts uses for /api/orchestration/:name/msg (paste-buffer is
// preferred over send-keys for multi-line text — it injects atomically without
// escape chaos). We resolve the worker pane as tmux session `claude-<team_id>`,
// matching the watchdog ticker's `s.startsWith("claude-")` filter in server.ts
// §watchdog ticker.
//
// All side-effecting dependencies (audit reader, worker deliverer, team
// enumerator, snapshot meta reader, decisions.jsonl appender) are injected via
// `setClusterDepsForTest()` so the tests run hermetically.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeVerifierCorrection } from "./audit";
import { readPolicySnapshot } from "./snapshot";
import type { AuditEntry, Mode } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClusterTrigger {
  reason: "burst" | "stuck_on_pattern";
  rule_path: string;
  count: number;
  window_seconds: number;
}

// ---------------------------------------------------------------------------
// Thresholds (constants per pack 06 §7)
// ---------------------------------------------------------------------------

const BURST_THRESHOLD = 5; // > 5 ⇒ ≥ 6 denials trips burst
const BURST_WINDOW_S = 60;
const STUCK_THRESHOLD = 3; // > 3 ⇒ ≥ 4 of the same rule_path trips stuck
const STUCK_WINDOW_S = 5 * 60;

const COOLDOWN_MS = 5 * 60 * 1000; // suppress repeat fires for 5 min per team
const CORRECTION_CAP = 2; // mirrors existing verifier giveup-after-2 in server.ts

const TICKER_INTERVAL_MS = 30 * 1000;

const AUDIT_TAIL_DEPTH = 100; // read window for the cluster detector

// ---------------------------------------------------------------------------
// State (process-scoped; resets on master daemon restart per PR 6.5 brief)
// ---------------------------------------------------------------------------

const correctionCount = new Map<string, number>();
const lastCorrectionAt = new Map<string, Date>();

/** Test-only: clear all per-team cluster state. */
export function resetClusterStateForTest(): void {
  correctionCount.clear();
  lastCorrectionAt.clear();
}

// ---------------------------------------------------------------------------
// Dependency injection (the testing seam — production wiring is the defaults)
// ---------------------------------------------------------------------------

export type AuditReader = (teamId: string, n: number) => Promise<AuditEntry[]>;
export type WorkerDeliverer = (teamId: string, text: string) => Promise<void>;
export type TeamEnumerator = () => Promise<string[]>;
export type SnapshotMetaReader = (
  teamId: string,
) => Promise<{ mode: Mode; allowlistSha: string } | null>;
export type DecisionAppender = (entry: Record<string, unknown>) => void;

interface ClusterDeps {
  readAudit: AuditReader;
  deliverToWorker: WorkerDeliverer;
  listTeams: TeamEnumerator;
  readSnapshotMeta: SnapshotMetaReader;
  appendDecision: DecisionAppender;
}

const defaultDeps: ClusterDeps = {
  readAudit: defaultReadAudit,
  deliverToWorker: defaultDeliverToWorker,
  listTeams: defaultListTeams,
  readSnapshotMeta: defaultReadSnapshotMeta,
  appendDecision: defaultAppendDecision,
};

let deps: ClusterDeps = { ...defaultDeps };

/** Test-only: override one or more dependencies. */
export function setClusterDepsForTest(overrides: Partial<ClusterDeps>): void {
  deps = { ...deps, ...overrides };
}

/** Test-only: restore production deps. */
export function resetClusterDepsForTest(): void {
  deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// Production default deps
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const override = process.env.SUBCTL_STATE_DIR;
  return override ?? join(homedir(), ".local", "state", "subctl");
}

/**
 * Default audit reader: read `<state>/audit/<team_id>.jsonl`, parse each line,
 * return the LAST `n` entries (chronological order, oldest→newest). Missing
 * file → []. Mirrors policy_audit_tail.ts's tolerance for malformed lines
 * (skip rather than throw — torn writes from a crashed worker are forgivable).
 */
async function defaultReadAudit(teamId: string, n: number): Promise<AuditEntry[]> {
  const path = join(resolveStateDir(), "audit", `${teamId}.jsonl`);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const out: AuditEntry[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AuditEntry);
    } catch {
      // skip torn line
    }
  }
  return out.length > n ? out.slice(-n) : out;
}

/**
 * Default worker deliverer: paste the correction into the tmux session
 * `claude-<team_id>` and press Enter. Mirrors dashboard/server.ts §msg
 * endpoint. If the session doesn't exist, we log to stderr and swallow — the
 * worker may have been killed mid-cluster; we don't want to crash the ticker.
 */
async function defaultDeliverToWorker(teamId: string, text: string): Promise<void> {
  const session = `claude-${teamId}`;
  try {
    const setBuf = Bun.spawnSync(
      ["tmux", "set-buffer", "-b", "subctl-verifier-cluster", text],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (setBuf.exitCode !== 0) {
      console.error(`[master] verifier-cluster: tmux set-buffer failed for ${session}: ${setBuf.stderr?.toString()?.trim()}`);
      return;
    }
    const paste = Bun.spawnSync(
      ["tmux", "paste-buffer", "-t", session, "-b", "subctl-verifier-cluster"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (paste.exitCode !== 0) {
      console.error(`[master] verifier-cluster: tmux paste-buffer failed for ${session}: ${paste.stderr?.toString()?.trim()}`);
      return;
    }
    const enter = Bun.spawnSync(
      ["tmux", "send-keys", "-t", session, "Enter"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (enter.exitCode !== 0) {
      console.error(`[master] verifier-cluster: tmux send-keys Enter failed for ${session}: ${enter.stderr?.toString()?.trim()}`);
    }
  } catch (err) {
    console.error(`[master] verifier-cluster: tmux delivery threw for ${session}: ${(err as Error).message}`);
  }
}

/**
 * Default team enumerator: list immediate subdirectories of
 * `<state>/teams/` — each is a team_id with a policy.snapshot.toml file
 * (written at spawn time by writePolicySnapshot). Missing dir → [].
 */
async function defaultListTeams(): Promise<string[]> {
  const teamsDir = join(resolveStateDir(), "teams");
  if (!existsSync(teamsDir)) return [];
  try {
    const entries = readdirSync(teamsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Default snapshot meta reader: pull mode + allowlistSha from the team's
 * policy snapshot. Used to populate the verifier_correction audit entry. Null
 * if the team has no snapshot yet (we still fire the correction but skip the
 * audit-line write — better than crashing).
 */
async function defaultReadSnapshotMeta(
  teamId: string,
): Promise<{ mode: Mode; allowlistSha: string } | null> {
  try {
    const snap = await readPolicySnapshot(teamId);
    if (!snap) return null;
    return { mode: snap.meta.mode, allowlistSha: snap.meta.allowlistSha };
  } catch {
    return null;
  }
}

/**
 * Default decisions.jsonl appender: writes one line to
 * `~/.config/subctl/master/decisions.jsonl`. Mirrors `logDecision` in
 * server.ts. Best-effort — swallow errors so a write failure here can't kill
 * the ticker.
 */
function defaultAppendDecision(entry: Record<string, unknown>): void {
  const cfgDir = process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  const masterDir = join(cfgDir, "master");
  const path = join(masterDir, "decisions.jsonl");
  try {
    mkdirSync(masterDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(path, line);
  } catch (err) {
    console.error(`[master] verifier-cluster: decisions.jsonl append failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Cluster detection
// ---------------------------------------------------------------------------

/**
 * Inspect the team's recent audit entries and decide whether a cluster fired.
 * Returns the first trigger that matches (burst checked before stuck — burst
 * is the "panicked worker" case and outranks the "stuck on one rule" case
 * when both would fire).
 *
 * Only check-type denials count toward clusters. Header lines, prior
 * verifier_correction lines, and allow decisions are filtered out.
 */
export async function detectDenialCluster(
  teamId: string,
  now: Date = new Date(),
): Promise<ClusterTrigger | null> {
  if (!teamId) return null;

  const entries = await deps.readAudit(teamId, AUDIT_TAIL_DEPTH);
  if (entries.length === 0) return null;

  // Filter to denials emitted as policy checks (not header/verifier_correction).
  const nowMs = now.getTime();
  const denials: Array<{ ts: number; rule_path: string }> = [];
  for (const e of entries) {
    if (e.event_type !== "check") continue;
    if (e.decision !== "deny") continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    // Skip future-dated entries from clock skew.
    if (ts > nowMs) continue;
    denials.push({ ts, rule_path: e.rule_path ?? "<unknown>" });
  }
  if (denials.length === 0) return null;

  // ── Burst: > BURST_THRESHOLD in last BURST_WINDOW_S ───────────────────
  const burstCutoff = nowMs - BURST_WINDOW_S * 1000;
  const inBurst = denials.filter((d) => d.ts >= burstCutoff);
  if (inBurst.length > BURST_THRESHOLD) {
    return {
      reason: "burst",
      rule_path: pickModalRulePath(inBurst),
      count: inBurst.length,
      window_seconds: BURST_WINDOW_S,
    };
  }

  // ── Stuck-on-pattern: > STUCK_THRESHOLD of the same rule_path in window ─
  const stuckCutoff = nowMs - STUCK_WINDOW_S * 1000;
  const inStuck = denials.filter((d) => d.ts >= stuckCutoff);
  const byPath = new Map<string, number>();
  for (const d of inStuck) {
    byPath.set(d.rule_path, (byPath.get(d.rule_path) ?? 0) + 1);
  }
  let stuckPath: string | null = null;
  let stuckCount = 0;
  for (const [path, count] of byPath) {
    if (count > STUCK_THRESHOLD && count > stuckCount) {
      stuckPath = path;
      stuckCount = count;
    }
  }
  if (stuckPath !== null) {
    return {
      reason: "stuck_on_pattern",
      rule_path: stuckPath,
      count: stuckCount,
      window_seconds: STUCK_WINDOW_S,
    };
  }

  return null;
}

/** Return the most common rule_path in the bag; ties broken by most-recent. */
function pickModalRulePath(denials: Array<{ ts: number; rule_path: string }>): string {
  const counts = new Map<string, { count: number; latest: number }>();
  for (const d of denials) {
    const prev = counts.get(d.rule_path);
    if (prev) {
      prev.count += 1;
      if (d.ts > prev.latest) prev.latest = d.ts;
    } else {
      counts.set(d.rule_path, { count: 1, latest: d.ts });
    }
  }
  let best: { path: string; count: number; latest: number } | null = null;
  for (const [path, { count, latest }] of counts) {
    if (!best || count > best.count || (count === best.count && latest > best.latest)) {
      best = { path, count, latest };
    }
  }
  return best?.path ?? "<unknown>";
}

// ---------------------------------------------------------------------------
// Correction firing
// ---------------------------------------------------------------------------

/**
 * Format the agent-facing correction prompt per pack 06 §7. Window is shown
 * to the agent in "minute" units (60s → "1 minute"; 300s → "5 minute") because
 * the spec text reads "in the last M minutes" — humans (and instruction-tuned
 * LLMs) parse that better than "in the last 60 seconds".
 */
export function formatClusterCorrection(trigger: ClusterTrigger): string {
  const minutes = Math.max(1, Math.round(trigger.window_seconds / 60));
  return [
    `[verifier] You have been denied ${trigger.count} times in the last ${minutes} minute${minutes === 1 ? "" : "s"} attempting`,
    `commands that match policy rule '${trigger.rule_path}'. This indicates you are working`,
    "around a constraint rather than the intended path. Stop trying variants and",
    "either:",
    "  1. Ask the operator (call inbox_message_to_master) for permission, or",
    "  2. Pick a different approach that doesn't require this command.",
  ].join("\n");
}

/**
 * Fire a correction at the worker, OR — if the team has already received
 * `CORRECTION_CAP` corrections — give up and log the cluster to
 * decisions.jsonl for operator review.
 *
 * Sequence on the fire path:
 *   1. Bump `correctionCount[teamId]`.
 *   2. Write a `verifier_correction` audit entry via PR 7's writer.
 *   3. Deliver the correction text to the worker (tmux paste-buffer).
 *   4. Record `lastCorrectionAt[teamId]` for cooldown.
 *
 * Note: This function does NOT check cooldown. The ticker checks cooldown
 * before calling detectDenialCluster, so by the time we get here the cluster
 * is real and the cooldown has elapsed. Direct callers (tests, future API)
 * are responsible for honoring cooldown themselves; we deliberately don't
 * silently no-op here because that would mask bugs.
 */
export async function fireClusterCorrection(
  teamId: string,
  trigger: ClusterTrigger,
  now: Date = new Date(),
): Promise<void> {
  if (!teamId) return;

  const prior = correctionCount.get(teamId) ?? 0;
  if (prior >= CORRECTION_CAP) {
    // Giveup path — log the cluster but don't keep firing.
    deps.appendDecision({
      project: "_master",
      action: "verifier_cluster_giveup",
      rationale: `team=${teamId} cluster=${trigger.reason} count=${trigger.count} rule_path=${trigger.rule_path} (already fired ${prior} corrections at cap=${CORRECTION_CAP})`,
      team_id: teamId,
      trigger,
    });
    return;
  }

  correctionCount.set(teamId, prior + 1);

  // Record audit entry first — if delivery to the worker fails (worker dead,
  // tmux dropped), the audit line is still a record that we tried.
  const meta = await deps.readSnapshotMeta(teamId);
  if (meta) {
    const auditRule = `verifier: ${trigger.count} denials in ${trigger.window_seconds}s, pattern '${trigger.rule_path}'`;
    try {
      await writeVerifierCorrection(teamId, auditRule, meta.mode, meta.allowlistSha);
    } catch (err) {
      console.error(`[master] verifier-cluster: writeVerifierCorrection failed for ${teamId}: ${(err as Error).message}`);
    }
  }

  // Deliver to the worker.
  const text = formatClusterCorrection(trigger);
  try {
    await deps.deliverToWorker(teamId, text);
  } catch (err) {
    console.error(`[master] verifier-cluster: deliverToWorker failed for ${teamId}: ${(err as Error).message}`);
  }

  lastCorrectionAt.set(teamId, now);
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function cooldownActive(teamId: string, now: Date): boolean {
  const last = lastCorrectionAt.get(teamId);
  if (!last) return false;
  return now.getTime() - last.getTime() < COOLDOWN_MS;
}

/**
 * One ticker pass. Exposed for tests so they don't have to wait 30s of
 * real time to exercise the tick loop. Returns the list of teams it actually
 * fired against (for assertion convenience).
 */
export async function runClusterTickOnce(now: Date = new Date()): Promise<string[]> {
  let teams: string[];
  try {
    teams = await deps.listTeams();
  } catch (err) {
    console.error(`[master] verifier-cluster: listTeams failed: ${(err as Error).message}`);
    return [];
  }
  const fired: string[] = [];
  for (const teamId of teams) {
    if (cooldownActive(teamId, now)) continue;
    try {
      const trigger = await detectDenialCluster(teamId, now);
      if (!trigger) continue;
      await fireClusterCorrection(teamId, trigger, now);
      fired.push(teamId);
    } catch (err) {
      console.error(`[master] verifier-cluster: tick for ${teamId} failed: ${(err as Error).message}`);
    }
  }
  return fired;
}

/**
 * Start the periodic ticker. Returns `{ stop }` for the master daemon's
 * shutdown handler. The interval is fixed at 30s — same cadence as the
 * watchdog's row-color transition resolution, fast enough to catch a burst
 * within ~2 ticks of when it crosses threshold.
 *
 * v2.7.19: optional `onTick` callback fires at the START of each tick.
 * Server.ts uses this to keep the watchdog registry's last_tick_at fresh
 * without having to peek inside this module. Pure side-channel — return
 * value is ignored; throws are swallowed so a misbehaving observer can't
 * stop the ticker.
 */
export function startClusterTicker(
  opts: { onTick?: () => void } = {},
): { stop: () => void } {
  const id = setInterval(() => {
    try {
      opts.onTick?.();
    } catch {
      /* observer must not break the ticker */
    }
    void runClusterTickOnce();
  }, TICKER_INTERVAL_MS);
  return {
    stop: () => clearInterval(id),
  };
}
