// bin/policy/__tests__/cli.test.ts
//
// End-to-end smoke tests for PR 9's `subctl policy <verb>` subcommands.
// Each test spawns the verb as a subprocess (via Bun.spawn) and asserts on
// exit code + stdout/stderr shape. We do NOT exercise the bash dispatcher
// (lib/policy.sh) here — that's just a passthrough; importing each TS verb
// directly through `bun <path>` covers the behavior the dispatcher routes to.
//
// Hermetic fixtures:
//   - per-test SUBCTL_STATE_DIR (audit + snapshot reads/writes)
//   - per-test SUBCTL_CONFIG_DIR (user-level policy.toml — kept empty)
//   - per-test project root (fixture policy.toml so resolution is deterministic)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const LIST_TS = join(REPO_ROOT, "bin", "policy", "list.ts");
const VALIDATE_TS = join(REPO_ROOT, "bin", "policy", "validate.ts");
const EXPLAIN_TS = join(REPO_ROOT, "bin", "policy", "explain.ts");
const AUDIT_TS = join(REPO_ROOT, "bin", "policy", "audit.ts");
const SNAPSHOT_TS = join(REPO_ROOT, "bin", "policy", "snapshot.ts");

const NODE_PRESET = join(REPO_ROOT, "config", "policy", "presets", "node.toml");

const ORIG_STATE = process.env.SUBCTL_STATE_DIR;
const ORIG_CFG = process.env.SUBCTL_CONFIG_DIR;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(scriptPath: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function makeProject(extraPolicyToml = ""): string {
  const root = mkdtempSync(join(tmpdir(), "subctl-pol-cli-"));
  mkdirSync(join(root, ".subctl"));
  writeFileSync(
    join(root, ".subctl", "policy.toml"),
    `preset = "none"
default_mode = "gated"

[mode.gated]

[mode.gated.allow]
commands = ["ls", "pwd", "cat"]

[[mode.gated.allow_pattern]]
command = "git"
args = ["status", "diff", "log"]

[mode.gated.deny_always]
substrings = ["rm -rf"]
${extraPolicyToml}
`,
  );
  return root;
}

function makeEmpty(): string {
  return mkdtempSync(join(tmpdir(), "subctl-pol-cli-empty-"));
}

let projectRoot: string;
let stateDir: string;
let cfgDir: string;

beforeEach(() => {
  projectRoot = makeProject();
  stateDir = makeEmpty();
  cfgDir = makeEmpty();
  process.env.SUBCTL_STATE_DIR = stateDir;
  process.env.SUBCTL_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
  if (ORIG_CFG === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = ORIG_CFG;
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("subctl policy list", () => {
  test("human format prints project + mode + sections", async () => {
    const r = await runCli(LIST_TS, ["--project-root", projectRoot], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`project:       ${projectRoot}`);
    expect(r.stdout).toContain("default_mode:  gated");
    expect(r.stdout).toContain("mode.gated:");
    expect(r.stdout).toContain("allow.commands (3)");
    expect(r.stdout).toContain("allow_pattern (1)");
    expect(r.stdout).toContain("deny_always.substrings (1)");
  });

  test("--json emits parseable JSON with the resolved doc", async () => {
    const r = await runCli(LIST_TS, [projectRoot, "--json"], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.project_root).toBe(projectRoot);
    expect(parsed.default_mode).toBe("gated");
    expect(parsed.mode.gated.allow.commands).toEqual(["ls", "pwd", "cat"]);
    expect(parsed.mode.gated.deny_always.substrings).toEqual(["rm -rf"]);
    expect(typeof parsed.allowlist_sha).toBe("string");
    expect(parsed.allowlist_sha.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe("subctl policy validate", () => {
  test("shipped node preset validates clean (exit 0)", async () => {
    const r = await runCli(VALIDATE_TS, [NODE_PRESET]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });

  test("broken TOML exits 1 with error", async () => {
    const broken = join(projectRoot, ".subctl", "broken.toml");
    writeFileSync(broken, `this is = not [ toml`);
    const r = await runCli(VALIDATE_TS, [broken]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/TOML parse failed|TOML/);
  });

  test("uncompilable regex fails validation", async () => {
    const bad = join(projectRoot, ".subctl", "bad_regex.toml");
    writeFileSync(
      bad,
      `default_mode = "gated"
[mode.gated.deny_always]
regex = ["[unterminated"]
`,
    );
    const r = await runCli(VALIDATE_TS, [bad]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("regex");
  });

  test("--preset=node validates a shipped preset", async () => {
    const r = await runCli(VALIDATE_TS, ["--preset=node"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
  });
});

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

describe("subctl policy explain", () => {
  test("allow trace for 'git status' (exit 0)", async () => {
    const r = await runCli(EXPLAIN_TS, ["git status", "--project-root", projectRoot], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("command:      git status");
    expect(r.stdout).toContain("evaluation trace:");
    expect(r.stdout).toContain("ALLOW");
    expect(r.stdout).toContain("allow_pattern");
  });

  test("deny trace for 'rm -rf /tmp/x' shows the matching substring (exit 1)", async () => {
    const r = await runCli(EXPLAIN_TS, ["rm -rf /tmp/x", "--project-root", projectRoot], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("DENY");
    expect(r.stdout).toContain("deny_always.substrings");
    expect(r.stdout).toContain(`"rm -rf"`);
  });

  test("default-deny prints a suggestion", async () => {
    const r = await runCli(EXPLAIN_TS, ["foobar --whatever", "--project-root", projectRoot], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("default-deny");
    expect(r.stdout).toContain("suggestion:");
    expect(r.stdout).toContain("mode.gated.allow");
  });
});

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

describe("subctl policy audit", () => {
  test("reads JSONL file and renders human format", async () => {
    const team = "t-cli";
    const auditDir = join(stateDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const path = join(auditDir, `${team}.jsonl`);
    const rows = [
      {
        ts: "2026-05-11T18:42:13.901Z",
        team_id: team,
        mode: "gated",
        command: "git status",
        decision: "allow",
        rule: "allow_pattern: git status|diff|log",
        rule_path: "mode.gated.allow_pattern[0]",
        event_type: "check",
      },
      {
        ts: "2026-05-11T18:43:00.111Z",
        team_id: team,
        mode: "gated",
        command: "rm -rf /tmp/foo",
        decision: "deny",
        rule: 'deny_always.substrings: "rm -rf"',
        rule_path: "mode.gated.deny_always.substrings",
        event_type: "check",
      },
    ];
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const r = await runCli(AUDIT_TS, [team], { SUBCTL_STATE_DIR: stateDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("git status");
    expect(r.stdout).toContain("rm -rf /tmp/foo");
    expect(r.stdout).toContain('rule: deny_always.substrings: "rm -rf"');
  });

  test("--decisions=deny filters allow rows", async () => {
    const team = "t-deny";
    const auditDir = join(stateDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const path = join(auditDir, `${team}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ ts: "2026-05-11T18:42:13.901Z", team_id: team, mode: "gated", command: "git status", decision: "allow", event_type: "check" })}
${JSON.stringify({ ts: "2026-05-11T18:43:00.111Z", team_id: team, mode: "gated", command: "rm -rf /tmp/foo", decision: "deny", rule: 'deny_always.substrings: "rm -rf"', event_type: "check" })}
`,
    );
    const r = await runCli(AUDIT_TS, [team, "--decisions=deny"], { SUBCTL_STATE_DIR: stateDir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("git status");
    expect(r.stdout).toContain("rm -rf /tmp/foo");
  });

  test("--jsonl passthrough emits one JSON per line", async () => {
    const team = "t-jsonl";
    const auditDir = join(stateDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const path = join(auditDir, `${team}.jsonl`);
    const row = { ts: "2026-05-11T18:42:13.901Z", team_id: team, mode: "gated", command: "ls", decision: "allow", event_type: "check" };
    writeFileSync(path, JSON.stringify(row) + "\n");
    const r = await runCli(AUDIT_TS, [team, "--jsonl"], { SUBCTL_STATE_DIR: stateDir });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.command).toBe("ls");
    expect(parsed.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

describe("subctl policy snapshot", () => {
  test("--show prints the snapshot file", async () => {
    // Write a snapshot first using the master tool's writer.
    const { writePolicySnapshot } = await import("../../../components/master/tools/policy/snapshot");
    await writePolicySnapshot("t-show", projectRoot, "gated");

    const r = await runCli(SNAPSHOT_TS, ["t-show", "--show"], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# subctl policy snapshot");
    expect(r.stdout).toContain(`team_id = "t-show"`);
    expect(r.stdout).toContain(`mode = "gated"`);
  });

  test("--verify on an untampered snapshot reports OK", async () => {
    const { writePolicySnapshot } = await import("../../../components/master/tools/policy/snapshot");
    await writePolicySnapshot("t-verify", projectRoot, "gated");

    const r = await runCli(SNAPSHOT_TS, ["t-verify", "--verify"], { SUBCTL_STATE_DIR: stateDir, SUBCTL_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK");
    expect(r.stdout).toContain("matches body hash");
  });

  test("--show on missing team exits 1", async () => {
    const r = await runCli(SNAPSHOT_TS, ["never-spawned", "--show"], { SUBCTL_STATE_DIR: stateDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no snapshot");
  });
});

// silence the unused-import warning for `dirname` (kept for future fixture)
void dirname;
