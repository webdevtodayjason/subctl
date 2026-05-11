// components/master/tools/policy/__tests__/audit.test.ts
//
// Tests for PR 7's audit-log appender + rotator. Exercises the public
// surface (appendAuditEntry, writeAuditHeader, writeVerifierCorrection,
// rotateAuditLogIfNeeded, getAuditLogPath, setRotationThresholdForTest)
// against per-test SUBCTL_STATE_DIR temp dirs so we never touch the
// operator's real ~/.local/state tree.
//
// Coverage targets from the PR 7 brief (10 minimum):
//   1.  append single entry — file exists, one JSONL line
//   2.  multiple appends preserve order
//   3.  writeAuditHeader emits a header line
//   4.  writeVerifierCorrection emits a verifier_correction line
//   5.  every emitted line is JSON-parseable + reconstructs to original entry
//   6.  100 concurrent writers via Promise.all don't tear lines
//   7.  rotation: filling beyond threshold rotates and preserves prior content in .jsonl.1
//   8.  rotation: 4 fills produce .jsonl + .jsonl.1 + .jsonl.2 + .jsonl.3 (no .jsonl.4)
//   9.  audit write failure is fail-open + bumps auditWriteFailures counter
//  10.  SUBCTL_STATE_DIR override is honored

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendAuditEntry,
  auditWriteFailures,
  getAuditLogPath,
  resetRotationThresholdForTest,
  rotateAuditLogIfNeeded,
  setRotationThresholdForTest,
  writeAuditHeader,
  writeVerifierCorrection,
} from "../audit";
import type { AuditEntry } from "../types";

const ORIG_STATE = process.env.SUBCTL_STATE_DIR;

let stateDir: string;

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "subctl-audit-state-"));
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
}

function makeCheckEntry(teamId: string, command: string, decision: "allow" | "deny" = "allow"): AuditEntry {
  return {
    ts: new Date().toISOString(),
    team_id: teamId,
    mode: "gated",
    allowlist_sha: "deadbeef",
    command,
    decision,
    event_type: "check",
  };
}

beforeEach(() => {
  stateDir = makeStateDir();
  process.env.SUBCTL_STATE_DIR = stateDir;
  auditWriteFailures.clear();
  resetRotationThresholdForTest();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
  auditWriteFailures.clear();
  resetRotationThresholdForTest();
});

// ---------------------------------------------------------------------------
// Basic append
// ---------------------------------------------------------------------------

describe("appendAuditEntry", () => {
  test("appends a single entry; file exists with one JSONL line", async () => {
    const teamId = "single-team";
    await appendAuditEntry(teamId, makeCheckEntry(teamId, "ls"));
    const lines = readLines(getAuditLogPath(teamId));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.team_id).toBe(teamId);
    expect(parsed.command).toBe("ls");
    expect(parsed.event_type).toBe("check");
  });

  test("multiple appends preserve order", async () => {
    const teamId = "order-team";
    await appendAuditEntry(teamId, makeCheckEntry(teamId, "alpha"));
    await appendAuditEntry(teamId, makeCheckEntry(teamId, "beta"));
    await appendAuditEntry(teamId, makeCheckEntry(teamId, "gamma"));
    const lines = readLines(getAuditLogPath(teamId)).map((l) => JSON.parse(l).command);
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  test("every emitted line is valid JSON and reconstructs to the original entry", async () => {
    const teamId = "json-team";
    const entry: AuditEntry = {
      ts: "2026-05-11T10:00:00.000Z",
      team_id: teamId,
      agent_session_id: "sess_abc",
      mode: "gated",
      allowlist_sha: "12345678",
      command: "git commit -m 'fix: don\\'t panic'",
      decision: "allow",
      rule: "allow_pattern: git commit|status|diff",
      rule_path: "mode.gated.allow_pattern[2]",
      event_type: "check",
    };
    await appendAuditEntry(teamId, entry);
    const lines = readLines(getAuditLogPath(teamId));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

describe("writeAuditHeader", () => {
  test("emits a header event with decision=allow + rule=spawn", async () => {
    const teamId = "hdr-team";
    await writeAuditHeader(teamId, "gated", "a3f9c2e1");
    const lines = readLines(getAuditLogPath(teamId));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.event_type).toBe("header");
    expect(parsed.decision).toBe("allow");
    expect(parsed.rule).toBe("spawn");
    expect(parsed.command).toBe("");
    expect(parsed.mode).toBe("gated");
    expect(parsed.allowlist_sha).toBe("a3f9c2e1");
    expect(parsed.team_id).toBe(teamId);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("writeVerifierCorrection", () => {
  test("emits a verifier_correction event with decision=deny + rule passed through", async () => {
    const teamId = "vc-team";
    const rule = "verifier: 5 denials in 60s, pattern 'mode.gated.deny_always.regex'";
    await writeVerifierCorrection(teamId, rule, "gated", "deadbeef");
    const lines = readLines(getAuditLogPath(teamId));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.event_type).toBe("verifier_correction");
    expect(parsed.decision).toBe("deny");
    expect(parsed.rule).toBe(rule);
    expect(parsed.command).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Concurrent appends — no torn lines
// ---------------------------------------------------------------------------

describe("concurrent appends", () => {
  test("100 concurrent writers via Promise.all do not tear lines", async () => {
    const teamId = "concurrent-team";
    const N = 100;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      writes.push(
        appendAuditEntry(teamId, {
          ts: new Date().toISOString(),
          team_id: teamId,
          mode: "gated",
          allowlist_sha: "deadbeef",
          command: `cmd-${i}`,
          decision: "allow",
          event_type: "check",
        }),
      );
    }
    await Promise.all(writes);

    const lines = readLines(getAuditLogPath(teamId));
    expect(lines.length).toBe(N);
    // Every line parses + every cmd-N is present exactly once.
    const seen = new Set<string>();
    for (const l of lines) {
      const parsed = JSON.parse(l) as AuditEntry;
      seen.add(parsed.command);
    }
    expect(seen.size).toBe(N);
    for (let i = 0; i < N; i++) expect(seen.has(`cmd-${i}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe("rotateAuditLogIfNeeded", () => {
  test("does nothing when file is missing", async () => {
    const r = await rotateAuditLogIfNeeded("absent-team");
    expect(r.rotated).toBe(false);
  });

  test("does nothing when file is under threshold", async () => {
    const teamId = "small-team";
    await appendAuditEntry(teamId, makeCheckEntry(teamId, "x"));
    setRotationThresholdForTest(1024 * 1024); // 1 MB, file is tiny
    const r = await rotateAuditLogIfNeeded(teamId);
    expect(r.rotated).toBe(false);
  });

  test("rotates once threshold exceeded; .jsonl.1 carries prior content", async () => {
    const teamId = "rotate-team";
    // Keep the threshold huge while we fill up so writes accumulate without
    // mid-loop rotation.
    setRotationThresholdForTest(10_000_000);

    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(teamId, makeCheckEntry(teamId, `pre-${i}`));
    }
    const active = getAuditLogPath(teamId);
    const sizeBefore = statSync(active).size;
    expect(sizeBefore).toBeGreaterThan(0);

    // Now drop the threshold below current size so the next write triggers rotation.
    setRotationThresholdForTest(Math.max(50, Math.floor(sizeBefore / 2)));

    await appendAuditEntry(teamId, makeCheckEntry(teamId, "post-rotation"));

    expect(existsSync(`${active}.1`)).toBe(true);
    const oldLines = readLines(`${active}.1`);
    expect(oldLines.length).toBe(5);
    expect(JSON.parse(oldLines[0]).command).toBe("pre-0");
    expect(JSON.parse(oldLines[4]).command).toBe("pre-4");

    const newLines = readLines(active);
    expect(newLines.length).toBe(1);
    expect(JSON.parse(newLines[0]).command).toBe("post-rotation");
  });

  test("4 fills produce .jsonl + .jsonl.{1,2,3}; no .jsonl.4", async () => {
    const teamId = "multi-rotate-team";
    setRotationThresholdForTest(200);

    // Each "generation" of writes: fill past threshold, write one more to trigger rotation.
    for (let gen = 0; gen < 4; gen++) {
      for (let i = 0; i < 5; i++) {
        await appendAuditEntry(teamId, makeCheckEntry(teamId, `gen${gen}-${i}`));
      }
      await appendAuditEntry(teamId, makeCheckEntry(teamId, `gen${gen}-trigger`));
    }

    const active = getAuditLogPath(teamId);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(`${active}.1`)).toBe(true);
    expect(existsSync(`${active}.2`)).toBe(true);
    expect(existsSync(`${active}.3`)).toBe(true);
    expect(existsSync(`${active}.4`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-open semantics
// ---------------------------------------------------------------------------

describe("fail-open semantics", () => {
  test("write failure does not throw; auditWriteFailures counter bumps", async () => {
    const teamId = "fail-team";

    // Make the audit dir un-writable by pointing SUBCTL_STATE_DIR at a path
    // that has the parent dir's audit subdir occupied by a regular FILE — so
    // mkdirSync(audit_dir, recursive) fails with ENOTDIR.
    const broken = mkdtempSync(join(tmpdir(), "subctl-audit-broken-"));
    // create a regular file at <broken>/audit so the mkdir fails
    writeFileSync(join(broken, "audit"), "blocker");
    process.env.SUBCTL_STATE_DIR = broken;

    const before = auditWriteFailures.get(teamId) ?? 0;
    // Must not throw.
    let threw = false;
    try {
      await appendAuditEntry(teamId, makeCheckEntry(teamId, "ls"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const after = auditWriteFailures.get(teamId) ?? 0;
    expect(after).toBeGreaterThan(before);

    rmSync(broken, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// SUBCTL_STATE_DIR override
// ---------------------------------------------------------------------------

describe("SUBCTL_STATE_DIR override", () => {
  test("audit log lands under SUBCTL_STATE_DIR/audit/<team>.jsonl", async () => {
    const teamId = "env-team";
    const p = getAuditLogPath(teamId);
    expect(p).toBe(join(stateDir, "audit", `${teamId}.jsonl`));
    await writeAuditHeader(teamId, "gated", "deadbeef");
    expect(existsSync(p)).toBe(true);
  });
});
