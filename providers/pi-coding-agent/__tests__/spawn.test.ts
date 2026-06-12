// providers/pi-coding-agent/__tests__/spawn.test.ts
//
// Smoke tests for the pi-coding-agent provider scaffolding (PR 11.5).
// Validates:
//   - bin/subctl exposes `teams pi-coding-agent` and `auth pi-coding-agent`
//   - auth.sh launches `pi` with HOME shadowed and pins the shadow path
//     in cfg_dir/.subctl-pi-home
//   - teams.sh --dry-run prints the spawn plan without launching tmux
//   - teams.sh refuses --account whose provider is not pi-coding-agent
//
// Everything runs in a per-test tmpdir, with a fake `pi` binary on PATH
// (a shell script that exits 0). No real tmux session is ever created
// because every test uses --dry-run on the spawn path or relies on
// argument-parsing failures that exit before tmux is touched.

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
const SUBCTL_BIN = join(REPO_ROOT, "bin", "subctl");
const AUTH_SH = join(REPO_ROOT, "providers", "pi-coding-agent", "auth.sh");
const TEAMS_SH = join(REPO_ROOT, "providers", "pi-coding-agent", "teams.sh");
const SIGNALS_SH = join(REPO_ROOT, "providers", "pi-coding-agent", "signals.sh");

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
  fakeBin: string;     // dir containing fake `pi`
  projectRoot: string;
}

function setup(opts: { piExit?: number; accounts?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-pr11_5-"));
  const home = join(root, "home");
  const configDir = join(root, "userconfig");
  const accountsConf = join(configDir, "accounts.conf");
  const fakeBin = join(root, "bin");
  const projectRoot = join(root, "proj");

  for (const d of [home, configDir, fakeBin, projectRoot]) {
    mkdirSync(d, { recursive: true });
  }

  // Fake `pi` binary. Records its invocation env to a known file so tests
  // can assert that HOME was shadowed.
  const piScript = [
    "#!/bin/sh",
    `echo "HOME=$HOME" > "${root}/pi-invoke.log"`,
    `echo "args=$*" >> "${root}/pi-invoke.log"`,
    `exit ${opts.piExit ?? 0}`,
  ].join("\n");
  writeFileSync(join(fakeBin, "pi"), piScript);
  chmodSync(join(fakeBin, "pi"), 0o755);

  // Seed accounts.conf
  const accountsBody = opts.accounts ?? [
    "# pi-coding-agent test account",
    `pi-test | pi-coding-agent | test@example.com | ${join(root, "pi-test-cfg")} | Pi test`,
    `claude-test | claude | test@example.com | ${join(root, "claude-cfg")} | Claude test`,
  ].join("\n");
  writeFileSync(accountsConf, accountsBody + "\n");

  return { root, home, configDir, accountsConf, fakeBin, projectRoot };
}

function teardown(d: Fixture) {
  rmSync(d.root, { recursive: true, force: true });
}

async function runBash(d: Fixture, script: string): Promise<BashResult> {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      HOME: d.home,
      // Make the fake `pi` win against any globally-installed binary.
      PATH: `${d.fakeBin}:${process.env.PATH}`,
      SUBCTL_REPO_ROOT: REPO_ROOT,
      SUBCTL_CONFIG_DIR: d.configDir,
      SUBCTL_ACCOUNTS_CONF: d.accountsConf,
      // Silence color escapes so substring asserts stay stable.
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

let d: Fixture;
beforeEach(() => { d = setup(); });
afterEach(() => { teardown(d); });

// ─────────────────────────────────────────────────────────────────────────
// bin/subctl dispatcher integration
// ─────────────────────────────────────────────────────────────────────────

describe("bin/subctl exposes pi-coding-agent", () => {
  test("`subctl help` mentions pi-coding-agent", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pi-coding-agent");
  });

  test("`subctl teams` dispatcher accepts pi-coding-agent (--help path)", async () => {
    // -h short-circuits before any real work, so this exercises the
    // dispatcher case clause without needing tmux.
    const r = await runBash(d, `"${SUBCTL_BIN}" teams pi-coding-agent --help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl teams pi-coding-agent");
    expect(r.stdout).toContain("UNGATED");
  });

  test("`subctl teams unknown-provider` still errors cleanly", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" teams unknown-provider --help`);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("usage: subctl teams");
  });

  test("`subctl auth` dispatcher missing alias produces usage error for pi", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" auth pi-coding-agent`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("usage: subctl auth pi-coding-agent");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// auth.sh HOME-shadowing
// ─────────────────────────────────────────────────────────────────────────

describe("auth.sh HOME-shadow + pin", () => {
  test("invocation launches `pi` with HOME pointed at the per-alias shadow dir", async () => {
    const cfgDir = join(d.root, "pi-test-cfg");
    // Force the auth flow to not detect existing auth (no auth.json, no
    // sessions). Press-enter is the only interactive read.
    const r = await runBash(
      d,
      `set -e
       . "${AUTH_SH}"
       # auto-press Enter at the prompt
       echo "" | provider_pi_coding_agent_auth "pi-test" "${cfgDir}" "test@example.com"
       echo "EXIT=$?"`,
    );
    // Pi exits 0 in our fake; auth_status will then be 'empty' (no auth.json
    // written), so the warning branch should fire. Either way the
    // pi-invoke.log records the HOME we passed.
    const invokeLog = join(d.root, "pi-invoke.log");
    expect(existsSync(invokeLog)).toBe(true);
    const text = readFileSync(invokeLog, "utf8");
    const expectedHome = join(d.home, ".subctl-pi-aliases", "pi-test");
    expect(text).toContain(`HOME=${expectedHome}`);
    // Combined stdout: code path output should not have crashed bash.
    expect(r.stdout + r.stderr).not.toContain("command not found");
  });

  test("the HOME-shadow path is pinned in cfg_dir/.subctl-pi-home", async () => {
    const cfgDir = join(d.root, "pi-test-cfg");
    await runBash(
      d,
      `. "${AUTH_SH}"
       echo "" | provider_pi_coding_agent_auth "pi-test" "${cfgDir}" "test@example.com" || true`,
    );
    const pinFile = join(cfgDir, ".subctl-pi-home");
    expect(existsSync(pinFile)).toBe(true);
    const pinned = readFileSync(pinFile, "utf8").trim();
    expect(pinned).toBe(join(d.home, ".subctl-pi-aliases", "pi-test"));
  });

  test("auth_status returns ready when auth.json exists in shadow dir", async () => {
    const cfgDir = join(d.root, "pi-test-cfg");
    const shadow = join(d.home, ".subctl-pi-aliases", "pi-test");
    mkdirSync(join(shadow, ".pi", "agent"), { recursive: true });
    writeFileSync(join(shadow, ".pi", "agent", "auth.json"), "{}");
    const r = await runBash(
      d,
      `. "${AUTH_SH}"
       provider_pi_coding_agent_auth "pi-test" "${cfgDir}" "test@example.com"`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already authenticated");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// teams.sh spawn (dry-run + validation)
// ─────────────────────────────────────────────────────────────────────────

describe("teams.sh --dry-run + provider mismatch checks", () => {
  test("--dry-run prints the spawn plan with HOME-shadow info and UNGATED warning", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Starting pi-coding-agent in tmux session: pi-");
    expect(r.stdout).toContain("pi HOME shadow:");
    expect(r.stdout).toContain("UNGATED");
    expect(r.stdout).toContain("(dry run — not launching tmux)");
  });

  test("--dry-run uses the pinned HOME-shadow path when present", async () => {
    const cfgDir = join(d.root, "pi-test-cfg");
    mkdirSync(cfgDir, { recursive: true });
    const customShadow = join(d.root, "custom-pi-home");
    writeFileSync(join(cfgDir, ".subctl-pi-home"), customShadow + "\n");
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(customShadow);
    expect(existsSync(join(customShadow, ".pi", "agent"))).toBe(true);
  });

  test("refuses an account whose provider is claude (not pi-coding-agent)", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a claude-test --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("is provider=claude, not pi-coding-agent");
  });

  test("missing -a flag fails with usage message", async () => {
    const r = await runBash(
      d,
      `. "${TEAMS_SH}"
       provider_pi_coding_agent_teams --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("requires -a <alias>");
  });

  test("-m model is echoed in the dry-run plan", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test -m claude-3-5-sonnet --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Model:");
    expect(r.stdout).toContain("claude-3-5-sonnet");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// signals.sh smoke
// ─────────────────────────────────────────────────────────────────────────

describe("signals.sh JSON shape", () => {
  test("emits provider=pi-coding-agent JSON with the expected keys", async () => {
    const cfgDir = join(d.root, "pi-test-cfg");
    mkdirSync(cfgDir, { recursive: true });
    const shadow = join(d.home, ".subctl-pi-aliases", "pi-test");
    mkdirSync(join(shadow, ".pi", "agent", "sessions"), { recursive: true });
    writeFileSync(join(shadow, ".pi", "agent", "sessions", "s1.jsonl"), "{}\n");
    const r = await runBash(
      d,
      `. "${SIGNALS_SH}"
       provider_pi_coding_agent_signals "pi-test"`,
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout.trim());
    expect(json.alias).toBe("pi-test");
    expect(json.provider).toBe("pi-coding-agent");
    expect(json.auth_status).toBe("ready");
    expect(json.pi_home).toBe(shadow);
    expect(typeof json.active_sessions).toBe("number");
    expect(json.rl_hits_today).toBe(0);
  });

  test("returns error JSON for an unknown alias", async () => {
    const r = await runBash(
      d,
      `. "${SIGNALS_SH}"
       provider_pi_coding_agent_signals "nope" || true`,
    );
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    const json = JSON.parse(lines[lines.length - 1]!);
    expect(json.alias).toBe("nope");
    expect(json.provider).toBe("pi-coding-agent");
    expect(json.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// W6.5 rider #420 — SUBCTL_AGENT_ROLE scoped to spawn type
// ─────────────────────────────────────────────────────────────────────────
//
// Pi sessions are dashboard-spawnable for interactive use, but the stamp
// used to be hardcoded =worker on EVERY spawn. Contract (mirrors
// providers/claude/teams.sh + its spawn-role.test.ts):
//   worker mandate present (-p / -f) → "worker"
//   bare interactive                 → no stamp at all
// Pi has no -o; there is no orchestrator role.

/** Drop a fake `tmux` into the fixture's PATH that records argv and
 * satisfies the spawn flow (no stale session; ready marker on capture). */
function armFakeTmux(f: Fixture): string {
  const tmuxLog = join(f.root, "tmux-invoke.log");
  const tmuxScript = [
    "#!/bin/sh",
    `echo "tmux $*" >> "${tmuxLog}"`,
    'case "$1" in',
    "  has-session) exit 1 ;;",
    '  capture-pane) echo ">" ;;',
    "esac",
    "exit 0",
  ].join("\n");
  writeFileSync(join(f.fakeBin, "tmux"), tmuxScript);
  chmodSync(join(f.fakeBin, "tmux"), 0o755);
  return tmuxLog;
}

function newSessionLine(tmuxLog: string): string {
  const log = readFileSync(tmuxLog, "utf8");
  const line = log.split("\n").find((l) => l.includes("new-session"));
  expect(line).toBeTruthy();
  return line!;
}

describe("agent-role scoping (#420)", () => {
  test("--dry-run banner: -p resolves worker", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test -p "do the task" --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+worker/);
  });

  test("--dry-run banner: bare interactive spawn gets NO role stamp", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Role:\s+none \(operator\/interactive/);
  });

  test("worker spawn (-p) stamps SUBCTL_AGENT_ROLE=worker on new-session, session-scoped", async () => {
    const tmuxLog = armFakeTmux(d);
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test -p "do the task" --no-attach`,
    );
    expect(r.code).toBe(0);
    expect(newSessionLine(tmuxLog)).toContain("SUBCTL_AGENT_ROLE=worker");
    const log = readFileSync(tmuxLog, "utf8");
    // Scrub of any leaked server-global stamp fires on every spawn.
    expect(log).toMatch(/set-environment -gu SUBCTL_AGENT_ROLE/);
  });

  test("bare interactive spawn carries NO SUBCTL_AGENT_ROLE at all", async () => {
    const tmuxLog = armFakeTmux(d);
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_pi_coding_agent_teams -a pi-test --no-attach`,
    );
    expect(r.code).toBe(0);
    const line = newSessionLine(tmuxLog);
    expect(line).not.toContain("SUBCTL_AGENT_ROLE");
    // Other session env still rides along.
    expect(line).toContain("SUBCTL_PI_ACCOUNT=");
  });
});
