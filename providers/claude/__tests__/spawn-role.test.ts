// providers/claude/__tests__/spawn-role.test.ts
//
// v3.3.x row ⑦ — SUBCTL_AGENT_ROLE must be scoped to the spawn type, not
// hardcoded into every tmux session this launcher creates. Regression for
// the 2026-06-11 leak where an operator interactive session
// (claude-samsung-phones) carried SUBCTL_AGENT_ROLE=worker in its tmux
// SESSION environment and tripped orchestrator-mode's anti-self-promotion
// guard.
//
// Contract under test (teams.sh AGENT_ROLE resolution):
//   -o / --orchestrator                        → "orchestrator"
//   worker mandate present (-p / -f / -t / -T) → "worker"
//   bare interactive, -c, --resume             → no stamp at all
//
// Two layers of proof:
//   1. --dry-run prints the resolved role in the spawn banner (no tmux).
//   2. A fake `tmux` on PATH records argv for real (non-dry-run) spawns, so
//      we assert the stamp is present/absent on the new-session call itself,
//      that the server-global scrub fires, and that the SPAWNING process
//      never gains the stamp.
//
// Mirrors the deepseek/pi spawn.test.ts harness shape (tmpdir fixture +
// SUBCTL_ACCOUNTS_CONF injection + fake binaries on PATH).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const TEAMS_SH = join(REPO_ROOT, "providers", "claude", "teams.sh");

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  home: string;
  configDir: string;
  accountsConf: string;
  cfgDir: string;       // the claude account's CLAUDE_CONFIG_DIR
  fakeBin: string;      // dir containing fake `tmux`
  projectRoot: string;
  tmuxLog: string;      // every fake-tmux invocation, one line each
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-claude-role-"));
  const home = join(root, "home");
  const configDir = join(root, "userconfig");
  const accountsConf = join(configDir, "accounts.conf");
  const cfgDir = join(root, "claude-cfg");
  const fakeBin = join(root, "bin");
  const projectRoot = join(root, "proj");
  const tmuxLog = join(root, "tmux-invoke.log");

  for (const d of [home, configDir, cfgDir, fakeBin, projectRoot]) {
    mkdirSync(d, { recursive: true });
  }

  // Fake `tmux`: append argv to the log; has-session says "no stale
  // session" (exit 1) so the kill path is skipped; capture-pane prints the
  // ❯ ready marker so the detached prompt-paste loop terminates fast.
  const tmuxScript = [
    "#!/bin/sh",
    `echo "tmux $*" >> "${tmuxLog}"`,
    'case "$1" in',
    "  has-session) exit 1 ;;",
    '  capture-pane) echo "❯" ;;',
    "esac",
    "exit 0",
  ].join("\n");
  writeFileSync(join(fakeBin, "tmux"), tmuxScript);
  chmodSync(join(fakeBin, "tmux"), 0o755);

  writeFileSync(
    accountsConf,
    `claude-test     | claude   | test@example.com           | ${cfgDir}     | Claude test\n`,
  );

  return { root, home, configDir, accountsConf, cfgDir, fakeBin, projectRoot, tmuxLog };
}

function teardown(d: Fixture) {
  rmSync(d.root, { recursive: true, force: true });
}

async function runSpawn(d: Fixture, flags: string): Promise<BashResult> {
  const script = `cd "${d.projectRoot}"
. "${TEAMS_SH}"
provider_claude_teams -a claude-test ${flags}
rc=$?
echo "SPAWNER_ROLE=\${SUBCTL_AGENT_ROLE:-unset}"
exit $rc`;
  const proc = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      HOME: d.home,
      PATH: `${d.fakeBin}:${process.env.PATH}`,
      SUBCTL_REPO_ROOT: REPO_ROOT,
      SUBCTL_CONFIG_DIR: d.configDir,
      SUBCTL_ACCOUNTS_CONF: d.accountsConf,
      SUBCTL_STATE_DIR: join(d.root, "state"),
      // Skip the policy snapshot/bridge — it's PR-10 plumbing with its own
      // integration suite, orthogonal to the role stamp.
      SUBCTL_DISABLE_POLICY_GATE: "1",
      // Never try to attach a tmux client from a test runner.
      SUBCTL_NO_ATTACH: "1",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function newSessionLine(d: Fixture): string {
  const log = readFileSync(d.tmuxLog, "utf8");
  const line = log.split("\n").find((l) => l.includes("new-session"));
  expect(line).toBeTruthy();
  return line!;
}

let d: Fixture;
beforeEach(() => { d = setup(); });
afterEach(() => { teardown(d); });

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — --dry-run banner shows the resolved role
// ─────────────────────────────────────────────────────────────────────────

describe("role resolution (--dry-run banner)", () => {
  test("worker mandate (-p) resolves to worker", async () => {
    const r = await runSpawn(d, `-p "fix the flaky test" --dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+worker/);
  });

  test("-o resolves to orchestrator, never worker", async () => {
    const r = await runSpawn(d, `-o --dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+orchestrator/);
    expect(r.stdout).not.toMatch(/Role:\s+worker/);
  });

  test("-o wins over -p (orchestrator prompt overrides mandate)", async () => {
    const r = await runSpawn(d, `-o -p "ignored" --dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+orchestrator/);
  });

  test("bare interactive spawn gets NO role stamp", async () => {
    const r = await runSpawn(d, `--dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+none \(operator\/interactive/);
  });

  test("-c (continue) without a mandate gets NO role stamp", async () => {
    const r = await runSpawn(d, `-c --dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+none \(operator\/interactive/);
  });

  test("--resume clears any mandate flags → NO role stamp", async () => {
    const r = await runSpawn(d, `--resume abc123 -p "ignored" --dry-run`);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+none \(operator\/interactive/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — real spawn path (fake tmux): the stamp on the wire
// ─────────────────────────────────────────────────────────────────────────

describe("tmux session env stamp (fake tmux argv)", () => {
  test("(a) worker spawn carries SUBCTL_AGENT_ROLE=worker in session env", async () => {
    const r = await runSpawn(d, `-p "do the task"`);
    expect(r.code).toBe(0);
    const line = newSessionLine(d);
    expect(line).toContain("SUBCTL_AGENT_ROLE=worker");
    // Session-scoped (-e on new-session), never a global set-environment.
    const log = readFileSync(d.tmuxLog, "utf8");
    expect(log).not.toMatch(/set-environment.*-g[^u]*SUBCTL_AGENT_ROLE=/);
  });

  test("(b) orchestrator (-o) spawn is stamped orchestrator, not worker", async () => {
    const r = await runSpawn(d, `-o`);
    expect(r.code).toBe(0);
    const line = newSessionLine(d);
    expect(line).toContain("SUBCTL_AGENT_ROLE=orchestrator");
    expect(line).not.toContain("SUBCTL_AGENT_ROLE=worker");
  });

  test("(b) operator interactive spawn carries NO SUBCTL_AGENT_ROLE at all", async () => {
    const r = await runSpawn(d, ``);
    expect(r.code).toBe(0);
    const line = newSessionLine(d);
    expect(line).not.toContain("SUBCTL_AGENT_ROLE");
    // Other session env still rides along.
    expect(line).toContain("CLAUDE_CONFIG_DIR=");
    expect(line).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
  });

  test("every spawn scrubs a leaked server-GLOBAL stamp", async () => {
    const r = await runSpawn(d, `-p "do the task"`);
    expect(r.code).toBe(0);
    const log = readFileSync(d.tmuxLog, "utf8");
    expect(log).toMatch(/set-environment -gu SUBCTL_AGENT_ROLE/);
  });

  test("(b) the spawning process never gains the stamp", async () => {
    for (const flags of [`-p "task"`, `-o`, ``]) {
      rmSync(d.tmuxLog, { force: true });
      const r = await runSpawn(d, flags);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("SPAWNER_ROLE=unset");
    }
  });
});
