// components/evy/tools/policy/__tests__/verifier-cluster.test.ts
//
// Tests for PR 6.5's denial-cluster detector + correction firer.
// Pack 06 §7 + HANDOFF_DIGEST D8.
//
// We inject all side-effecting deps (audit reader, worker deliverer,
// snapshot reader, team enumerator, decisions.jsonl appender) via
// setClusterDepsForTest so nothing touches disk or tmux. Per-team in-memory
// state is reset between tests via resetClusterStateForTest.
//
// Coverage matches the PR 6.5 brief minimum (8 tests):
//   1. Burst:  6 denials in 60s     → burst trigger returned
//   2. Burst:  4 denials in 60s     → null
//   3. Stuck:  4 denials same rule_path in 5min → stuck trigger returned
//   4. Stuck:  3 denials different rule_paths   → null
//   5. Both fire: burst takes precedence
//   6. Cooldown: 2nd cluster within 5min after a fire → suppressed
//   7. 2-correction cap: 3rd cluster → giveup path logs to decisions.jsonl
//   8. Allows don't count: 100 allows + 4 denies → null

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  detectDenialCluster,
  fireClusterCorrection,
  formatClusterCorrection,
  resetClusterDepsForTest,
  resetClusterStateForTest,
  runClusterTickOnce,
  setClusterDepsForTest,
} from "../verifier-cluster";
import type { AuditEntry, Mode } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-11T12:00:00.000Z");

function denial(secondsAgo: number, rulePath = "mode.gated.deny_always.substrings"): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    team_id: "test-team",
    mode: "gated",
    allowlist_sha: "deadbeef",
    command: "rm -rf /",
    decision: "deny",
    rule: `deny_always.substrings: "rm -rf"`,
    rule_path: rulePath,
    event_type: "check",
  };
}

function allow(secondsAgo: number): AuditEntry {
  return {
    ts: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    team_id: "test-team",
    mode: "gated",
    allowlist_sha: "deadbeef",
    command: "ls",
    decision: "allow",
    rule: "allow_pattern: ls",
    rule_path: "mode.gated.allow_pattern[0]",
    event_type: "check",
  };
}

interface Recorder {
  delivered: Array<{ teamId: string; text: string }>;
  decisions: Array<Record<string, unknown>>;
  audit: AuditEntry[];
}

function makeRecorder(): Recorder {
  return { delivered: [], decisions: [], audit: [] };
}

/**
 * Wire deps for a single test. `auditByTeam` provides canned entries; everything
 * else is captured into `rec` so assertions can introspect what happened. The
 * snapshot reader returns a fixed (mode, allowlistSha) tuple so the audit-write
 * branch in fireClusterCorrection executes.
 */
function wireDeps(
  rec: Recorder,
  auditByTeam: Map<string, AuditEntry[]>,
  options?: { snapshotMissing?: boolean; teams?: string[] },
) {
  setClusterDepsForTest({
    readAudit: async (teamId, n) => {
      const all = auditByTeam.get(teamId) ?? [];
      return all.length > n ? all.slice(-n) : all;
    },
    deliverToWorker: async (teamId, text) => {
      rec.delivered.push({ teamId, text });
    },
    listTeams: async () => options?.teams ?? Array.from(auditByTeam.keys()),
    readSnapshotMeta: async () => {
      if (options?.snapshotMissing) return null;
      return { mode: "gated" as Mode, allowlistSha: "deadbeef" };
    },
    appendDecision: (entry) => {
      rec.decisions.push(entry);
    },
  });
}

// We also need to intercept the audit writer (writeVerifierCorrection writes to
// disk). The simplest sandbox: point SUBCTL_STATE_DIR at a temp dir per test so
// any disk writes that slip through land somewhere safe and irrelevant.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let stateDir: string;
const ORIG_STATE = process.env.SUBCTL_STATE_DIR;
const ORIG_CONFIG = process.env.SUBCTL_CONFIG_DIR;
let configDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "subctl-vc-state-"));
  configDir = mkdtempSync(join(tmpdir(), "subctl-vc-config-"));
  process.env.SUBCTL_STATE_DIR = stateDir;
  process.env.SUBCTL_CONFIG_DIR = configDir;
  resetClusterStateForTest();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
  if (ORIG_CONFIG === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = ORIG_CONFIG;
  resetClusterStateForTest();
  resetClusterDepsForTest();
});

// ---------------------------------------------------------------------------
// detectDenialCluster — burst trigger
// ---------------------------------------------------------------------------

describe("detectDenialCluster — burst trigger", () => {
  test("6 denials in last 60s returns a burst cluster", async () => {
    const rec = makeRecorder();
    // 6 denials within 60s window (>5 trips burst per pack 06 §7)
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(denial(i * 5));
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).not.toBeNull();
    expect(trigger!.reason).toBe("burst");
    expect(trigger!.count).toBe(6);
    expect(trigger!.window_seconds).toBe(60);
    expect(trigger!.rule_path).toBe("mode.gated.deny_always.substrings");
  });

  test("only 4 denials in last 60s returns null (under threshold)", async () => {
    const rec = makeRecorder();
    // Vary rule_paths so this doesn't trip the stuck-on-pattern trigger.
    // We're isolating "burst threshold not crossed" here.
    const entries: AuditEntry[] = [
      denial(5, "mode.gated.deny_always.substrings"),
      denial(15, "mode.gated.deny_always.regex"),
      denial(25, "mode.gated.allowed_scripts.missing"),
      denial(35, "mode.gated.deny_default"),
    ];
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDenialCluster — stuck-on-pattern trigger
// ---------------------------------------------------------------------------

describe("detectDenialCluster — stuck-on-pattern trigger", () => {
  test("4 denials of the same rule_path within 5min returns stuck cluster", async () => {
    const rec = makeRecorder();
    // Spread across ~4 minutes so the burst window misses, but the 5min
    // window catches all 4. Threshold: >3 of the same rule_path.
    const entries: AuditEntry[] = [
      denial(240, "mode.gated.deny_always.regex"),
      denial(180, "mode.gated.deny_always.regex"),
      denial(120, "mode.gated.deny_always.regex"),
      denial(70, "mode.gated.deny_always.regex"),
    ];
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).not.toBeNull();
    expect(trigger!.reason).toBe("stuck_on_pattern");
    expect(trigger!.count).toBe(4);
    expect(trigger!.rule_path).toBe("mode.gated.deny_always.regex");
    expect(trigger!.window_seconds).toBe(300);
  });

  test("3 denials with different rule_paths returns null (no single path crosses threshold)", async () => {
    const rec = makeRecorder();
    const entries: AuditEntry[] = [
      denial(120, "mode.gated.deny_always.regex"),
      denial(90, "mode.gated.deny_always.substrings"),
      denial(60, "mode.gated.allowed_scripts.missing"),
    ];
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectDenialCluster — precedence + filtering
// ---------------------------------------------------------------------------

describe("detectDenialCluster — burst takes precedence", () => {
  test("when both burst AND stuck would fire, burst wins", async () => {
    const rec = makeRecorder();
    // 6 denials of the same rule_path, all within 30s → both triggers active.
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(denial(i * 5, "mode.gated.deny_always.regex"));
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).not.toBeNull();
    expect(trigger!.reason).toBe("burst");
    // Same rule_path either way, but the WINDOW must be the burst's (60s)
    expect(trigger!.window_seconds).toBe(60);
  });
});

describe("detectDenialCluster — allows do not count", () => {
  test("100 allows + 4 denies (varied rule_paths) returns null", async () => {
    const rec = makeRecorder();
    const entries: AuditEntry[] = [];
    // 100 allows scattered across the last 60s
    for (let i = 0; i < 100; i++) entries.push(allow(i * 0.5));
    // 4 denies, varied rule_paths so stuck-on-pattern doesn't trip either —
    // we want to verify that allows are filtered out of cluster detection
    // regardless of how dense they are.
    entries.push(denial(5, "mode.gated.deny_always.substrings"));
    entries.push(denial(15, "mode.gated.deny_always.regex"));
    entries.push(denial(25, "mode.gated.allowed_scripts.missing"));
    entries.push(denial(35, "mode.gated.deny_default"));
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fireClusterCorrection — cooldown + cap
// ---------------------------------------------------------------------------

describe("fireClusterCorrection — cooldown via runClusterTickOnce", () => {
  test("2nd cluster within 5min of a fire is suppressed by cooldown", async () => {
    const rec = makeRecorder();
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(denial(i * 5));
    wireDeps(rec, new Map([["t1", entries]]));

    // First tick: fires.
    const fired1 = await runClusterTickOnce(NOW);
    expect(fired1).toEqual(["t1"]);
    expect(rec.delivered.length).toBe(1);

    // Second tick 2 minutes later — cluster still detectable, but cooldown
    // (5min from last fire) is active.
    const TWO_MIN_LATER = new Date(NOW.getTime() + 2 * 60 * 1000);
    const fired2 = await runClusterTickOnce(TWO_MIN_LATER);
    expect(fired2).toEqual([]);
    expect(rec.delivered.length).toBe(1); // unchanged
  });

  test("after the 5-min cooldown elapses, a fresh cluster fires again", async () => {
    const rec = makeRecorder();
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(denial(i * 5));
    wireDeps(rec, new Map([["t1", entries]]));

    await runClusterTickOnce(NOW);
    expect(rec.delivered.length).toBe(1);

    // 6 minutes later, cooldown lapsed. Refresh the audit window so the
    // denials still appear "recent" relative to the new now.
    const SIX_MIN_LATER = new Date(NOW.getTime() + 6 * 60 * 1000);
    const fresh: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) {
      fresh.push({
        ...denial(i * 5),
        ts: new Date(SIX_MIN_LATER.getTime() - i * 5 * 1000).toISOString(),
      });
    }
    wireDeps(rec, new Map([["t1", fresh]]));

    const fired2 = await runClusterTickOnce(SIX_MIN_LATER);
    expect(fired2).toEqual(["t1"]);
    expect(rec.delivered.length).toBe(2);
  });
});

describe("fireClusterCorrection — 2-correction cap", () => {
  test("3rd cluster after 2 corrections fires the giveup path (decisions.jsonl, no delivery)", async () => {
    const rec = makeRecorder();
    // Fixed denial set — same input each call; we re-fire the trigger
    // bypassing cooldown by calling fireClusterCorrection directly.
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 6; i++) entries.push(denial(i * 5));
    wireDeps(rec, new Map([["t1", entries]]));

    const trigger = await detectDenialCluster("t1", NOW);
    expect(trigger).not.toBeNull();

    // Two normal fires (drain the cap)
    await fireClusterCorrection("t1", trigger!);
    await fireClusterCorrection("t1", trigger!);
    expect(rec.delivered.length).toBe(2);
    expect(rec.decisions.length).toBe(0);

    // Third fire — should NOT deliver, should log giveup instead.
    await fireClusterCorrection("t1", trigger!);
    expect(rec.delivered.length).toBe(2); // unchanged
    expect(rec.decisions.length).toBe(1);
    const giveup = rec.decisions[0];
    expect(giveup.action).toBe("verifier_cluster_giveup");
    expect(giveup.team_id).toBe("t1");
    expect((giveup.trigger as { reason: string }).reason).toBe(trigger!.reason);
  });
});

// ---------------------------------------------------------------------------
// formatClusterCorrection — sanity-check the prompt text
// ---------------------------------------------------------------------------

describe("formatClusterCorrection — agent-facing prompt", () => {
  test("uses [verifier] marker, includes count + minutes + rule_path", async () => {
    const text = formatClusterCorrection({
      reason: "burst",
      rule_path: "mode.gated.deny_always.substrings",
      count: 6,
      window_seconds: 60,
    });
    expect(text.startsWith("[verifier] ")).toBe(true);
    expect(text).toContain("denied 6 times");
    expect(text).toContain("1 minute");
    expect(text).toContain("mode.gated.deny_always.substrings");
    expect(text).toContain("inbox_message_to_master");
  });

  test("stuck trigger uses 5-minute phrasing", async () => {
    const text = formatClusterCorrection({
      reason: "stuck_on_pattern",
      rule_path: "mode.gated.deny_always.regex",
      count: 4,
      window_seconds: 300,
    });
    expect(text).toContain("denied 4 times");
    expect(text).toContain("5 minutes");
  });
});
