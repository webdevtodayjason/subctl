// components/master/__tests__/team-gc.test.ts
//
// v2.7.32 — Tests for the startup team-dir garbage collector.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runStartupTeamGC,
  DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
  DEFAULT_AUDIT_MAX_AGE_DAYS,
} from "../team-gc";

const DAY_MS = 86_400_000;
const NOW = 1_715_000_000_000; // Fixed-point Date.now() so tests are deterministic.

let root: string;
let teamsDir: string;
let auditDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subctl-team-gc-test-"));
  teamsDir = join(root, "teams");
  auditDir = join(root, "audit");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeTeamDir(teamId: string, snapshotAgeDays: number, auditAgeDays: number | null) {
  const dir = join(teamsDir, teamId);
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, "policy.snapshot.toml");
  writeFileSync(snapshotPath, '[meta]\nteam_id = "' + teamId + '"\n');
  const snapshotMtimeS = (NOW - snapshotAgeDays * DAY_MS) / 1000;
  utimesSync(snapshotPath, snapshotMtimeS, snapshotMtimeS);
  // HMAC secret + other typical artifacts
  writeFileSync(join(dir, "hmac.secret"), "a".repeat(64));
  if (auditAgeDays !== null) {
    const auditPath = join(auditDir, `${teamId}.jsonl`);
    writeFileSync(auditPath, '{"ts":"...","decision":"allow"}\n');
    const auditMtimeS = (NOW - auditAgeDays * DAY_MS) / 1000;
    utimesSync(auditPath, auditMtimeS, auditMtimeS);
  }
  return dir;
}

describe("runStartupTeamGC — archives stale team dirs", () => {
  test("snapshot 20d old + audit 10d old → archived", () => {
    makeTeamDir("policy-fix-verify", 20, 10);
    const notifications: Array<{ team_id: string }> = [];
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
      {
        emitNotification: (input) => notifications.push({ team_id: input.team_id }),
      },
    );

    expect(decisions.length).toBe(1);
    expect(decisions[0]?.action).toBe("archived");
    expect(decisions[0]?.team_id).toBe("policy-fix-verify");
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.team_id).toBe("policy-fix-verify");

    // Verify dir moved to .killed/
    expect(existsSync(join(teamsDir, "policy-fix-verify"))).toBe(false);
    expect(existsSync(join(teamsDir, ".killed", "policy-fix-verify"))).toBe(true);
    expect(existsSync(join(teamsDir, ".killed", "policy-fix-verify", "hmac.secret"))).toBe(true);
  });

  test("snapshot 20d old + no audit file → archived", () => {
    makeTeamDir("ship-verify-test", 20, null);
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
    );

    expect(decisions[0]?.action).toBe("archived");
    expect(existsSync(join(teamsDir, ".killed", "ship-verify-test"))).toBe(true);
  });
});

describe("runStartupTeamGC — keeps active or recent teams", () => {
  test("fresh snapshot (3d old) → kept regardless of audit", () => {
    makeTeamDir("claude-active", 3, 30);
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
    );
    expect(decisions[0]?.action).toBe("skipped-fresh-snapshot");
    expect(existsSync(join(teamsDir, "claude-active"))).toBe(true);
  });

  test("old snapshot but recent audit (2d) → kept", () => {
    makeTeamDir("claude-long-running", 30, 2);
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
    );
    expect(decisions[0]?.action).toBe("skipped-recent-audit");
    expect(existsSync(join(teamsDir, "claude-long-running"))).toBe(true);
  });

  test("team without policy.snapshot.toml → skipped-no-snapshot (templates etc.)", () => {
    mkdirSync(join(teamsDir, "template-only"), { recursive: true });
    writeFileSync(join(teamsDir, "template-only", "hmac.secret"), "a".repeat(64));
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
    );
    expect(decisions[0]?.action).toBe("skipped-no-snapshot");
    expect(existsSync(join(teamsDir, "template-only"))).toBe(true);
  });
});

describe("runStartupTeamGC — mixed sweep", () => {
  test("scans every team dir, archives only the matching ones", () => {
    makeTeamDir("policy-fix-verify", 20, 10); // archive
    makeTeamDir("ship-verify-test", 20, null); // archive (no audit)
    makeTeamDir("claude-active", 1, 0.1); // keep — fresh
    makeTeamDir("claude-long-running", 30, 1); // keep — recent audit

    const notifications: Array<{ team_id: string }> = [];
    const logs: Array<{ team_id: string; action: string }> = [];
    const decisions = runStartupTeamGC(
      {
        teams_dir: teamsDir,
        audit_dir: auditDir,
        snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
        audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
        now_ms: NOW,
      },
      {
        emitNotification: (input) => notifications.push({ team_id: input.team_id }),
        logDecision: (team_id, action) => logs.push({ team_id, action }),
      },
    );

    const archived = decisions.filter((d) => d.action === "archived").map((d) => d.team_id).sort();
    expect(archived).toEqual(["policy-fix-verify", "ship-verify-test"]);
    expect(notifications.length).toBe(2);
    expect(logs.length).toBe(2);
    expect(logs.every((l) => l.action === "team_gc_archived")).toBe(true);

    // Surviving teams still in place
    expect(existsSync(join(teamsDir, "claude-active"))).toBe(true);
    expect(existsSync(join(teamsDir, "claude-long-running"))).toBe(true);
  });
});

describe("runStartupTeamGC — idempotency + edge cases", () => {
  test("second run on the same archive doesn't crash + leaves .killed/ alone", () => {
    makeTeamDir("policy-fix-verify", 20, 10);
    const cfg = {
      teams_dir: teamsDir,
      audit_dir: auditDir,
      snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
      audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
      now_ms: NOW,
    };
    const first = runStartupTeamGC(cfg);
    expect(first[0]?.action).toBe("archived");

    // Recreate dir to simulate operator re-spawn-then-quickly-stale
    makeTeamDir("policy-fix-verify", 20, 10);
    const second = runStartupTeamGC(cfg);
    expect(second[0]?.action).toBe("archived");
    // Both archives coexist in .killed/ (second got a timestamp suffix)
    const killedEntries = readdirSync(join(teamsDir, ".killed"));
    expect(killedEntries.length).toBe(2);
  });

  test("teams_dir does not exist → no-op", () => {
    const decisions = runStartupTeamGC({
      teams_dir: join(root, "nonexistent"),
      audit_dir: auditDir,
      snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
      audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
      now_ms: NOW,
    });
    expect(decisions).toEqual([]);
  });

  test(".killed/ dir itself is never inspected", () => {
    // Pre-populate a .killed/ that has a "team" inside; it should never
    // be considered for GC even if it would otherwise qualify.
    mkdirSync(join(teamsDir, ".killed", "old-team"), { recursive: true });
    writeFileSync(join(teamsDir, ".killed", "old-team", "policy.snapshot.toml"), "");
    const decisions = runStartupTeamGC({
      teams_dir: teamsDir,
      audit_dir: auditDir,
      snapshot_max_age_ms: DEFAULT_SNAPSHOT_MAX_AGE_DAYS * DAY_MS,
      audit_max_age_ms: DEFAULT_AUDIT_MAX_AGE_DAYS * DAY_MS,
      now_ms: NOW,
    });
    expect(decisions).toEqual([]);
    expect(existsSync(join(teamsDir, ".killed", "old-team"))).toBe(true);
  });
});
