// components/evy/tools/policy/__tests__/tools.test.ts
//
// Tests for the master daemon's `policy` tool family (PR 6):
//   - policy_check  — allow / deny / mode-override
//   - policy_list   — shape + meta
//   - policy_audit_tail — fixture read, filter, missing-file
//
// These tests exercise the public tool surface (the {description, schema, invoke}
// objects) end-to-end against real on-disk fixtures. They do NOT mock the
// loader or the checker — PR 4/5 are the source of truth and these tests
// verify the tool layer correctly composes them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { policyTools } from "../index";

const FIXTURE_AUDIT_DIR = join(import.meta.dir, "fixtures", "audit");

const ORIG_SUBCTL_CONFIG_DIR = process.env.SUBCTL_CONFIG_DIR;
const ORIG_SUBCTL_STATE_DIR = process.env.SUBCTL_STATE_DIR;

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "subctl-policy-tools-"));
  // Per-project policy that opts into a small explicit gated set so we can
  // assert allow/deny without depending on the shipped node preset details.
  mkdirSync(join(root, ".subctl"), { recursive: true });
  writeFileSync(
    join(root, ".subctl", "policy.toml"),
    `preset = "none"
default_mode = "gated"

[mode.gated]

[mode.gated.allow]
commands = ["ls", "pwd", "git"]

[[mode.gated.allow_pattern]]
command = "echo"
args = ["hello"]

[mode.gated.deny_always]
substrings = ["rm -rf"]
`,
  );
  return root;
}

beforeEach(() => {
  // Point SUBCTL_CONFIG_DIR at an empty temp dir so loadUserPolicy() doesn't
  // accidentally pick up the dev machine's real ~/.config/subctl/policy.toml.
  const emptyCfg = mkdtempSync(join(tmpdir(), "subctl-policy-cfg-"));
  process.env.SUBCTL_CONFIG_DIR = emptyCfg;
});

afterEach(() => {
  if (ORIG_SUBCTL_CONFIG_DIR === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = ORIG_SUBCTL_CONFIG_DIR;
  if (ORIG_SUBCTL_STATE_DIR === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_SUBCTL_STATE_DIR;
});

// ---------------------------------------------------------------------------
// Shape sanity — the tool registration should be wired correctly
// ---------------------------------------------------------------------------

describe("policyTools registration", () => {
  test("exports check, list, audit_tail with the {description, schema, invoke} convention", () => {
    for (const key of ["check", "list", "audit_tail"] as const) {
      const t = policyTools[key];
      expect(t).toBeDefined();
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.schema).toBeDefined();
      expect((t.schema as { type: string }).type).toBe("object");
      expect(typeof t.invoke).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// policy_check
// ---------------------------------------------------------------------------

describe("policy_check", () => {
  let project: string;
  beforeEach(() => {
    project = makeTempProject();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("allow path: a command in allow.commands returns decision=allow", async () => {
    const r = (await policyTools.check.invoke({
      command: "ls -la",
      project_root: project,
    })) as { ok: boolean; decision: string; rule_path?: string; mode: string };
    expect(r.ok).toBe(true);
    expect(r.decision).toBe("allow");
    expect(r.rule_path).toBe("mode.gated.allow.commands");
    expect(r.mode).toBe("gated");
  });

  test("deny path: deny_always substring fires before allow checks", async () => {
    const r = (await policyTools.check.invoke({
      command: "rm -rf /tmp/x",
      project_root: project,
    })) as { ok: boolean; decision: string; rule_path?: string };
    expect(r.ok).toBe(true);
    expect(r.decision).toBe("deny");
    expect(r.rule_path).toBe("mode.gated.deny_always.substrings");
  });

  test("default deny: an unknown command is denied (no_match_default_deny)", async () => {
    const r = (await policyTools.check.invoke({
      command: "nuke-the-fridge",
      project_root: project,
    })) as { ok: boolean; decision: string; rule?: string };
    expect(r.ok).toBe(true);
    expect(r.decision).toBe("deny");
    expect(r.rule).toBe("no_match_default_deny");
  });

  test("mode override: explicit mode='trusted' makes any command allow", async () => {
    const r = (await policyTools.check.invoke({
      command: "rm -rf /",
      project_root: project,
      mode: "trusted",
    })) as { ok: boolean; decision: string; rule_path?: string; mode: string };
    expect(r.ok).toBe(true);
    expect(r.decision).toBe("allow");
    expect(r.rule_path).toBe("mode.trusted");
    expect(r.mode).toBe("trusted");
  });

  test("rejects missing args", async () => {
    const r1 = (await policyTools.check.invoke({
      command: "",
      project_root: project,
    } as never)) as { ok: boolean; error?: string };
    expect(r1.ok).toBe(false);
    const r2 = (await policyTools.check.invoke({
      command: "ls",
      project_root: "",
    } as never)) as { ok: boolean; error?: string };
    expect(r2.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// policy_list
// ---------------------------------------------------------------------------

describe("policy_list", () => {
  let project: string;
  beforeEach(() => {
    project = makeTempProject();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("returns the expected shape with meta + merged gated table", async () => {
    const r = (await policyTools.list.invoke({ project_root: project })) as {
      ok: boolean;
      project_root: string;
      preset?: string;
      default_mode: string;
      source_paths: string[];
      allowlist_sha: string;
      mode: { gated?: { allow?: { commands?: string[] }; deny_always?: { substrings?: string[] } }; sealed?: unknown };
    };
    expect(r.ok).toBe(true);
    expect(r.project_root).toBe(project);
    expect(r.default_mode).toBe("gated");
    // preset = "none" is a directive, not surfaced
    expect(r.preset).toBeUndefined();
    expect(r.allowlist_sha).toMatch(/^[0-9a-f]{8}$/);
    expect(Array.isArray(r.source_paths)).toBe(true);
    expect(r.source_paths.length).toBeGreaterThanOrEqual(1);
    expect(r.mode.gated?.allow?.commands).toEqual(["ls", "pwd", "git"]);
    expect(r.mode.gated?.deny_always?.substrings).toEqual(["rm -rf"]);
  });

  test("rejects missing project_root", async () => {
    const r = (await policyTools.list.invoke({ project_root: "" } as never)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// policy_audit_tail
// ---------------------------------------------------------------------------

describe("policy_audit_tail", () => {
  // Tests point SUBCTL_STATE_DIR at the fixture parent dir, so the resolved
  // audit dir is <fixtures>/audit/ — matching the fixture file's location.
  beforeEach(() => {
    process.env.SUBCTL_STATE_DIR = join(import.meta.dir, "fixtures");
  });

  test("reads the fixture file and returns 5 entries most-recent-first", async () => {
    const r = (await policyTools.audit_tail.invoke({
      team_id: "test-team",
      n: 20,
    })) as {
      ok: boolean;
      count: number;
      entries: Array<{ event_type: string; decision: string; ts: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(5);
    expect(r.entries.length).toBe(5);
    // Most-recent-first: first entry should be the verifier_correction (last
    // line in the fixture, ts 18:44).
    expect(r.entries[0].event_type).toBe("verifier_correction");
    expect(r.entries[0].decision).toBe("deny");
    // Last entry should be the header (first line in the fixture, ts 18:42:00).
    expect(r.entries[4].event_type).toBe("header");
  });

  test("decisions=['deny'] filter returns only deny lines (3: 2 checks + 1 verifier)", async () => {
    const r = (await policyTools.audit_tail.invoke({
      team_id: "test-team",
      decisions: ["deny"],
    })) as { ok: boolean; count: number; entries: Array<{ decision: string }> };
    expect(r.ok).toBe(true);
    // 2 deny checks + 1 verifier_correction with decision=deny = 3 total
    expect(r.count).toBe(3);
    for (const e of r.entries) expect(e.decision).toBe("deny");
  });

  test("decisions=['allow'] filter returns only allow lines (2: header + git status)", async () => {
    const r = (await policyTools.audit_tail.invoke({
      team_id: "test-team",
      decisions: ["allow"],
    })) as { ok: boolean; count: number; entries: Array<{ decision: string }> };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    for (const e of r.entries) expect(e.decision).toBe("allow");
  });

  test("n=2 caps to last 2 entries (most-recent-first)", async () => {
    const r = (await policyTools.audit_tail.invoke({
      team_id: "test-team",
      n: 2,
    })) as {
      ok: boolean;
      count: number;
      entries: Array<{ event_type: string }>;
    };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(r.entries[0].event_type).toBe("verifier_correction"); // last line
    expect(r.entries[1].event_type).toBe("check"); // 4th line (curl deny)
  });

  test("missing audit file returns empty array, not an error", async () => {
    const r = (await policyTools.audit_tail.invoke({
      team_id: "does-not-exist-team",
    })) as { ok: boolean; count: number; entries: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(r.entries).toEqual([]);
  });

  test("SUBCTL_STATE_DIR override is honored", async () => {
    // Write a fixture into a temp dir, point SUBCTL_STATE_DIR there.
    const tmpState = mkdtempSync(join(tmpdir(), "subctl-policy-state-"));
    mkdirSync(join(tmpState, "audit"), { recursive: true });
    writeFileSync(
      join(tmpState, "audit", "scratch.jsonl"),
      JSON.stringify({
        ts: "2026-05-11T19:00:00.000Z",
        team_id: "scratch",
        mode: "gated",
        allowlist_sha: "deadbeef",
        command: "ls",
        decision: "allow",
        event_type: "check",
      }) + "\n",
    );
    process.env.SUBCTL_STATE_DIR = tmpState;
    const r = (await policyTools.audit_tail.invoke({ team_id: "scratch" })) as {
      ok: boolean;
      count: number;
      path: string;
    };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.path).toContain(tmpState);
    rmSync(tmpState, { recursive: true, force: true });
  });

  test("rejects missing team_id", async () => {
    const r = (await policyTools.audit_tail.invoke({ team_id: "" } as never)) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
  });
});
