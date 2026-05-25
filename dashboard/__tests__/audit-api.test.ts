// dashboard/__tests__/audit-api.test.ts
//
// PR 11 (v2.7.0): test coverage for the policy-audit dashboard handlers.
// Pack 09 §6 specifies the surface; this file exercises it.
//
// We hit the pure handlers from dashboard/lib/audit-api.ts directly — no HTTP
// server, no port, no flakiness. SUBCTL_STATE_DIR is overridden to a temp
// dir per-test so we never touch the operator's real ~/.local/state tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyFilter,
  handleAuditAggregate,
  handleAuditList,
  handlePolicyTeams,
  isValidTeamId,
  parseQuery,
  parseSinceDuration,
  readNewAuditEntries,
  suggestAllowlistAdditionToml,
} from "../lib/audit-api";
import type { AuditEntry } from "../../lib/policy/types";

const ORIG_STATE = process.env.SUBCTL_STATE_DIR;

let stateDir: string;

function makeEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-05-11T18:00:00.000Z",
    team_id: "foothold-v3",
    mode: "gated",
    allowlist_sha: "a3f9c2e1",
    command: "git status",
    decision: "allow",
    rule: "allow_pattern: git status|diff|log",
    rule_path: "mode.gated.allow_pattern[4]",
    event_type: "check",
    ...over,
  };
}

function writeAuditFile(teamId: string, entries: AuditEntry[]): string {
  const auditDir = join(stateDir, "audit");
  mkdirSync(auditDir, { recursive: true });
  const path = join(auditDir, `${teamId}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function writeSnapshotFile(teamId: string, opts: {
  mode: "trusted" | "gated" | "sealed";
  spawnedAt: string;
  allowlistSha: string;
  sourcePaths: string[];
  preset?: string;
}): string {
  const teamDir = join(stateDir, "teams", teamId);
  mkdirSync(teamDir, { recursive: true });
  const snapshotPath = join(teamDir, "policy.snapshot.toml");
  const lines: string[] = [
    "# subctl policy snapshot",
    `# team_id = ${JSON.stringify(teamId)}`,
    `# spawned_at = ${JSON.stringify(opts.spawnedAt)}`,
    `# mode = ${JSON.stringify(opts.mode)}`,
  ];
  if (opts.sourcePaths.length === 0) {
    lines.push("# source_paths = []");
  } else {
    lines.push("# source_paths = [");
    for (const p of opts.sourcePaths) lines.push(`#   ${JSON.stringify(p)},`);
    lines.push("# ]");
  }
  lines.push(`# allowlist_sha = ${JSON.stringify(opts.allowlistSha)}`);
  lines.push("");
  // Body: minimal valid TOML with preset.
  if (opts.preset) lines.push(`preset = ${JSON.stringify(opts.preset)}`);
  lines.push(`default_mode = ${JSON.stringify(opts.mode)}`);
  writeFileSync(snapshotPath, lines.join("\n"));
  return snapshotPath;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "subctl-audit-api-"));
  process.env.SUBCTL_STATE_DIR = stateDir;
});

afterEach(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
});

describe("parseSinceDuration", () => {
  test("parses standard suffixes", () => {
    expect(parseSinceDuration("100ms")).toBe(100);
    expect(parseSinceDuration("5s")).toBe(5000);
    expect(parseSinceDuration("2m")).toBe(120_000);
    expect(parseSinceDuration("1h")).toBe(3_600_000);
    expect(parseSinceDuration("1d")).toBe(86_400_000);
  });
  test("rejects garbage", () => {
    expect(parseSinceDuration("")).toBeNull();
    expect(parseSinceDuration(null)).toBeNull();
    expect(parseSinceDuration("forever")).toBeNull();
    expect(parseSinceDuration("-1h")).toBeNull();
    expect(parseSinceDuration("5x")).toBeNull();
  });
});

describe("isValidTeamId", () => {
  test("accepts valid ids", () => {
    expect(isValidTeamId("foothold-v3")).toBe(true);
    expect(isValidTeamId("team_42")).toBe(true);
    expect(isValidTeamId("A1B2-C3")).toBe(true);
  });
  test("rejects path-traversal + shell metacharacters", () => {
    expect(isValidTeamId("../etc")).toBe(false);
    expect(isValidTeamId("foo/bar")).toBe(false);
    expect(isValidTeamId("foo;rm")).toBe(false);
    expect(isValidTeamId("")).toBe(false);
    expect(isValidTeamId(".")).toBe(false);
  });
});

describe("parseQuery", () => {
  test("default values", () => {
    const q = parseQuery(new URLSearchParams());
    expect(q.tail).toBe(100);
    expect(q.sinceMs).toBeNull();
    expect(q.decision).toBeNull();
    expect(q.filter).toBeNull();
  });
  test("tail is clamped to [1,1000]", () => {
    expect(parseQuery(new URLSearchParams("tail=0")).tail).toBe(1);
    expect(parseQuery(new URLSearchParams("tail=99999")).tail).toBe(1000);
    expect(parseQuery(new URLSearchParams("tail=garbage")).tail).toBe(100);
  });
  test("decision must be allow|deny or null", () => {
    expect(parseQuery(new URLSearchParams("decision=deny")).decision).toBe("deny");
    expect(parseQuery(new URLSearchParams("decision=allow")).decision).toBe("allow");
    expect(parseQuery(new URLSearchParams("decision=maybe")).decision).toBeNull();
  });
});

describe("applyFilter", () => {
  test("decision filter narrows to denies only", () => {
    const entries: AuditEntry[] = [
      makeEntry({ decision: "allow" }),
      makeEntry({ decision: "deny", rule_path: "mode.gated.deny_always.substrings" }),
      makeEntry({ decision: "allow" }),
      makeEntry({ decision: "deny", rule_path: "mode.gated.deny_always.regex" }),
    ];
    const q = parseQuery(new URLSearchParams("decision=deny"));
    const filtered = applyFilter(entries, q, Date.parse(entries[0]!.ts) + 1000);
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.decision === "deny")).toBe(true);
  });
  test("filter substring matches rule_path, rule, and command (case-insensitive)", () => {
    const entries: AuditEntry[] = [
      makeEntry({ rule_path: "mode.gated.allow_pattern[0]", command: "git status" }),
      makeEntry({ rule_path: "mode.gated.deny_always.substrings", command: "rm -rf /tmp", decision: "deny" }),
      makeEntry({ rule_path: "mode.gated.allow_pattern[1]", command: "ls" }),
    ];
    const q = parseQuery(new URLSearchParams("filter=DENY_ALWAYS"));
    const filtered = applyFilter(entries, q, Date.parse(entries[0]!.ts) + 1000);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.command).toBe("rm -rf /tmp");
  });
  test("since cutoff drops older entries", () => {
    const entries: AuditEntry[] = [
      makeEntry({ ts: "2026-05-11T16:00:00.000Z" }), // 2h ago
      makeEntry({ ts: "2026-05-11T17:30:00.000Z" }), // 30m ago
      makeEntry({ ts: "2026-05-11T17:55:00.000Z" }), // 5m ago
    ];
    const now = Date.parse("2026-05-11T18:00:00.000Z");
    const q = parseQuery(new URLSearchParams("since=1h"));
    const filtered = applyFilter(entries, q, now);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.ts)).toEqual([
      "2026-05-11T17:30:00.000Z",
      "2026-05-11T17:55:00.000Z",
    ]);
  });
});

describe("handleAuditList", () => {
  test("invalid team_id returns 400", async () => {
    const resp = handleAuditList("../etc/passwd", new URLSearchParams());
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("invalid");
  });

  test("missing team returns ok with empty entries", async () => {
    const resp = handleAuditList("never-spawned", new URLSearchParams());
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.team_id).toBe("never-spawned");
    expect(body.entries).toEqual([]);
    expect(body.count).toBe(0);
    expect(body.total).toBe(0);
  });

  test("returns most-recent-first JSON when entries exist", async () => {
    const entries: AuditEntry[] = [
      makeEntry({ ts: "2026-05-11T17:00:00.000Z", command: "git status" }),
      makeEntry({ ts: "2026-05-11T17:30:00.000Z", command: "ls" }),
      makeEntry({ ts: "2026-05-11T17:45:00.000Z", command: "rm -rf /tmp", decision: "deny",
        rule_path: "mode.gated.deny_always.substrings" }),
    ];
    writeAuditFile("alpha", entries);

    const resp = handleAuditList("alpha", new URLSearchParams("tail=10"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(3);
    // Most-recent-first
    expect(body.entries[0].command).toBe("rm -rf /tmp");
    expect(body.entries[1].command).toBe("ls");
    expect(body.entries[2].command).toBe("git status");
  });

  test("decision filter narrows the result set", async () => {
    const entries: AuditEntry[] = [
      makeEntry({ ts: "2026-05-11T17:00:00.000Z", decision: "allow", command: "a" }),
      makeEntry({ ts: "2026-05-11T17:01:00.000Z", decision: "deny", command: "b" }),
      makeEntry({ ts: "2026-05-11T17:02:00.000Z", decision: "allow", command: "c" }),
      makeEntry({ ts: "2026-05-11T17:03:00.000Z", decision: "deny", command: "d" }),
    ];
    writeAuditFile("beta", entries);

    const resp = handleAuditList("beta", new URLSearchParams("decision=deny"));
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(2);
    expect(body.entries.every((e: AuditEntry) => e.decision === "deny")).toBe(true);
  });

  test("tail caps the response even when more entries match", async () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(makeEntry({
        ts: `2026-05-11T17:${String(i).padStart(2, "0")}:00.000Z`,
        command: `cmd-${i}`,
      }));
    }
    writeAuditFile("gamma", entries);

    const resp = handleAuditList("gamma", new URLSearchParams("tail=5"));
    const body = await resp.json() as any;
    expect(body.count).toBe(5);
    expect(body.total).toBe(20);
    expect(body.entries[0].command).toBe("cmd-19"); // newest
    expect(body.entries[4].command).toBe("cmd-15");
  });

  test("torn JSONL lines are skipped (does not throw)", async () => {
    const auditDir = join(stateDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const path = join(auditDir, "delta.jsonl");
    // First line valid, second torn mid-write, third valid.
    const valid = JSON.stringify(makeEntry({ command: "ok-1" }));
    const valid2 = JSON.stringify(makeEntry({ ts: "2026-05-11T18:01:00.000Z", command: "ok-2" }));
    writeFileSync(path, `${valid}\n{"ts":"2026-05-11T18:00:30.000Z","team_id":"delta","mode":"gated","commaaa\n${valid2}\n`);

    const resp = handleAuditList("delta", new URLSearchParams());
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(2);
  });
});

describe("handleAuditAggregate", () => {
  test("groups denials by rule_path across teams, returns top-N", async () => {
    // Two teams, both with denials. team-a has 3× "deny_always.substrings"
    // and 1× "deny_always.regex"; team-b has 2× "deny_always.substrings".
    writeAuditFile("team-a", [
      makeEntry({ ts: new Date().toISOString(), team_id: "team-a", command: "rm -rf 1",
        decision: "deny", rule_path: "mode.gated.deny_always.substrings",
        rule: 'deny_always.substrings: "rm -rf"' }),
      makeEntry({ ts: new Date().toISOString(), team_id: "team-a", command: "rm -rf 2",
        decision: "deny", rule_path: "mode.gated.deny_always.substrings",
        rule: 'deny_always.substrings: "rm -rf"' }),
      makeEntry({ ts: new Date().toISOString(), team_id: "team-a", command: "rm -rf 3",
        decision: "deny", rule_path: "mode.gated.deny_always.substrings",
        rule: 'deny_always.substrings: "rm -rf"' }),
      makeEntry({ ts: new Date().toISOString(), team_id: "team-a", command: "curl http://evil",
        decision: "deny", rule_path: "mode.gated.deny_always.regex",
        rule: 'deny_always.regex: "evil"' }),
    ]);
    writeAuditFile("team-b", [
      makeEntry({ ts: new Date().toISOString(), team_id: "team-b", command: "rm -rf 4",
        decision: "deny", rule_path: "mode.gated.deny_always.substrings",
        rule: 'deny_always.substrings: "rm -rf"' }),
      makeEntry({ ts: new Date().toISOString(), team_id: "team-b", command: "rm -rf 5",
        decision: "deny", rule_path: "mode.gated.deny_always.substrings",
        rule: 'deny_always.substrings: "rm -rf"' }),
    ]);

    const resp = handleAuditAggregate(new URLSearchParams("since=1h&top=10"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.teams_scanned).toBe(2);
    expect(body.top).toHaveLength(2);
    expect(body.top[0].rule_path).toBe("mode.gated.deny_always.substrings");
    expect(body.top[0].count).toBe(5);
    expect(body.top[0].teams).toContain("team-a");
    expect(body.top[0].teams).toContain("team-b");
    expect(body.top[1].rule_path).toBe("mode.gated.deny_always.regex");
    expect(body.top[1].count).toBe(1);
  });

  test("verifier_correction entries surface in the dedicated array", async () => {
    writeAuditFile("team-vc", [
      makeEntry({ ts: new Date().toISOString(), team_id: "team-vc",
        decision: "deny", event_type: "verifier_correction",
        rule: "verifier: 5 denials in 60s, pattern 'mode.gated.deny_always.regex'",
        command: "" }),
    ]);
    const resp = handleAuditAggregate(new URLSearchParams("since=1h"));
    const body = await resp.json() as any;
    expect(body.verifier_corrections).toHaveLength(1);
    expect(body.verifier_corrections[0].event_type).toBe("verifier_correction");
  });

  test("empty state dir returns ok with zero buckets", async () => {
    const resp = handleAuditAggregate(new URLSearchParams("since=1h"));
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.top).toEqual([]);
    expect(body.verifier_corrections).toEqual([]);
    expect(body.teams_scanned).toBe(0);
  });
});

describe("handlePolicyTeams", () => {
  test("empty teams dir returns ok with empty array", async () => {
    const resp = handlePolicyTeams();
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.teams).toEqual([]);
  });

  test("reads mode + allowlist_sha + spawned_at from snapshot headers", async () => {
    writeSnapshotFile("foothold", {
      mode: "gated",
      spawnedAt: "2026-05-11T18:00:00.000Z",
      allowlistSha: "a3f9c2e1",
      sourcePaths: [
        "/Users/you/code/myproject/.subctl/policy.toml",
        "/Users/you/.config/subctl/policy.toml",
      ],
      preset: "node",
    });
    writeSnapshotFile("sealed-worker", {
      mode: "sealed",
      spawnedAt: "2026-05-11T19:00:00.000Z",
      allowlistSha: "deadbeef",
      sourcePaths: [],
      preset: "generic",
    });

    const resp = handlePolicyTeams();
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.teams).toHaveLength(2);
    // Most-recently-spawned first.
    expect(body.teams[0].team_id).toBe("sealed-worker");
    expect(body.teams[0].mode).toBe("sealed");
    expect(body.teams[1].team_id).toBe("foothold");
    expect(body.teams[1].mode).toBe("gated");
    expect(body.teams[1].allowlist_sha).toBe("a3f9c2e1");
    expect(body.teams[1].preset).toBe("node");
    expect(body.teams[1].project_root).toBe("/Users/you/code/myproject");
    expect(body.teams[1].has_snapshot).toBe(true);
  });
});

describe("readNewAuditEntries", () => {
  test("returns only entries appended since the last byte offset", () => {
    const entries: AuditEntry[] = [makeEntry({ command: "old" })];
    const path = writeAuditFile("eps", entries);
    const fs = require("node:fs") as typeof import("node:fs");
    const sizeAfter1 = fs.statSync(path).size;

    // Append a new entry
    fs.appendFileSync(path, JSON.stringify(makeEntry({ ts: "2026-05-11T19:00:00.000Z", command: "new" })) + "\n");

    const r = readNewAuditEntries(path, sizeAfter1);
    expect(r.truncated).toBe(false);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.command).toBe("new");
  });

  test("flags truncation when file shrinks (rotation)", () => {
    const entries: AuditEntry[] = [makeEntry({ command: "x" })];
    const path = writeAuditFile("zeta", entries);
    const fs = require("node:fs") as typeof import("node:fs");
    const sizeAfter1 = fs.statSync(path).size;
    // simulate rotation
    fs.writeFileSync(path, "");

    const r = readNewAuditEntries(path, sizeAfter1);
    expect(r.truncated).toBe(true);
    expect(r.entries).toEqual([]);
  });
});

describe("suggestAllowlistAdditionToml", () => {
  test("generates a valid allow_pattern snippet for an ordinary denial", () => {
    const entry = makeEntry({
      command: "git push --force-with-lease origin main",
      decision: "deny",
      rule_path: "mode.gated.default-deny",
      rule: "no allow rule matched",
    });
    const out = suggestAllowlistAdditionToml(entry);
    expect(out).toContain("[[mode.gated.allow_pattern]]");
    expect(out).toContain('command = "git"');
    expect(out).toContain("push --force-with-lease origin main");
    // Should NOT have the deny_always-comment-only block
    expect(out).not.toContain("deny_always wins over allow_pattern");
  });

  test("emits a comment-only block when the denial fired on deny_always", () => {
    const entry = makeEntry({
      command: "rm -rf /tmp/foo",
      decision: "deny",
      rule_path: "mode.gated.deny_always.substrings",
      rule: 'deny_always.substrings: "rm -rf"',
    });
    const out = suggestAllowlistAdditionToml(entry);
    expect(out).toContain("deny_always wins over allow_pattern");
    expect(out).not.toContain("[[mode.gated.allow_pattern]]");
  });

  test("refuses to generate for an allow entry", () => {
    const entry = makeEntry({ decision: "allow" });
    const out = suggestAllowlistAdditionToml(entry);
    expect(out).toContain("already allowed");
  });
});
