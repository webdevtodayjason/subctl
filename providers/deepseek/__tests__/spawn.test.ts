// providers/deepseek/__tests__/spawn.test.ts
//
// Smoke tests for the deepseek provider scaffolding (Phase 4 — v3.0.0-rc1).
// Validates:
//   - bin/subctl exposes `teams deepseek` and `auth deepseek`
//   - auth.sh launches `codewhale auth set --provider deepseek` with HOME
//     shadowed and pins the shadow path in cfg_dir/.subctl-deepseek-home
//   - teams.sh --dry-run prints the spawn plan without launching tmux
//   - teams.sh refuses --account whose provider is not deepseek
//   - teams.sh flag parsing: -y/-c/-o accepted, -m model echoed
//   - signals.sh emits the expected JSON shape
//
// Everything runs in a per-test tmpdir, with a fake `codewhale` binary on
// PATH (a shell script that records its invocation and exits 0). No real
// tmux session is ever created because every test uses --dry-run on the
// spawn path or relies on argument-parsing failures that exit before tmux
// is touched.
//
// Mirrors providers/pi-coding-agent/__tests__/spawn.test.ts shape.

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
const AUTH_SH = join(REPO_ROOT, "providers", "deepseek", "auth.sh");
const TEAMS_SH = join(REPO_ROOT, "providers", "deepseek", "teams.sh");
const SIGNALS_SH = join(REPO_ROOT, "providers", "deepseek", "signals.sh");

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
  fakeBin: string;     // dir containing fake `codewhale`
  projectRoot: string;
}

function setup(opts: { codewhaleExit?: number; accounts?: string; writeKeyOnAuth?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-deepseek-"));
  const home = join(root, "home");
  const configDir = join(root, "userconfig");
  const accountsConf = join(configDir, "accounts.conf");
  const fakeBin = join(root, "bin");
  const projectRoot = join(root, "proj");

  for (const d of [home, configDir, fakeBin, projectRoot]) {
    mkdirSync(d, { recursive: true });
  }

  // Fake `codewhale` binary. Records its invocation env + args to a known
  // file so tests can assert that HOME was shadowed. If writeKeyOnAuth is
  // true, also synthesize a config.toml with an api_key line to simulate
  // a successful `auth set` — that way _provider_deepseek_auth_status
  // returns "ready" after the call.
  const writeKey = opts.writeKeyOnAuth ?? false;
  const codewhaleScript = [
    "#!/bin/sh",
    `echo "HOME=$HOME" > "${root}/codewhale-invoke.log"`,
    `echo "args=$*" >> "${root}/codewhale-invoke.log"`,
    // Simulate `codewhale auth set --provider deepseek` writing the key.
    writeKey
      ? `if [ "$1" = "auth" ] && [ "$2" = "set" ]; then
           mkdir -p "$HOME/.deepseek"
           printf 'provider = deepseek\\napi_key = sk-test1234abcd\\n' > "$HOME/.deepseek/config.toml"
           chmod 600 "$HOME/.deepseek/config.toml"
         fi`
      : "",
    `exit ${opts.codewhaleExit ?? 0}`,
  ].filter(Boolean).join("\n");
  writeFileSync(join(fakeBin, "codewhale"), codewhaleScript);
  chmodSync(join(fakeBin, "codewhale"), 0o755);

  // Seed accounts.conf — note the `|`-with-padding format that
  // subctl_accounts_add writes (mirrors what's in production accounts.conf).
  const accountsBody = opts.accounts ?? [
    "# deepseek test accounts",
    `dsk-test        | deepseek | test@example.com           | ${join(root, "dsk-test-cfg")}     | Deepseek test`,
    `claude-test     | claude   | test@example.com           | ${join(root, "claude-cfg")}       | Claude test`,
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
      // Make the fake `codewhale` win against any globally-installed binary.
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
afterEach(() => { teardown(d); });

// ─────────────────────────────────────────────────────────────────────────
// bin/subctl dispatcher integration
// ─────────────────────────────────────────────────────────────────────────

describe("bin/subctl exposes deepseek", () => {
  beforeEach(() => { d = setup(); });

  test("`subctl help` mentions deepseek", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("deepseek");
  });

  test("`subctl teams` dispatcher accepts deepseek (--help path)", async () => {
    // -h short-circuits before any real work, so this exercises the
    // dispatcher case clause without needing tmux.
    const r = await runBash(d, `"${SUBCTL_BIN}" teams deepseek --help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl teams deepseek");
    expect(r.stdout).toContain("UNGATED");
  });

  test("`subctl teams unknown-provider` still errors cleanly", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" teams unknown-provider --help`);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("usage: subctl teams");
  });

  test("`subctl auth` dispatcher missing alias produces usage error for deepseek", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" auth deepseek`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("usage: subctl auth deepseek");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// auth.sh HOME-shadowing + pin
// ─────────────────────────────────────────────────────────────────────────

describe("auth.sh HOME-shadow + pin", () => {
  beforeEach(() => { d = setup({ writeKeyOnAuth: true }); });

  test("invocation launches `codewhale` with HOME pointed at the per-alias shadow dir", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    const r = await runBash(
      d,
      `set -e
       . "${AUTH_SH}"
       # auto-press Enter at the prompt
       echo "" | provider_deepseek_auth "dsk-test" "${cfgDir}" "test@example.com"
       echo "EXIT=$?"`,
    );
    const invokeLog = join(d.root, "codewhale-invoke.log");
    expect(existsSync(invokeLog)).toBe(true);
    const text = readFileSync(invokeLog, "utf8");
    const expectedHome = join(d.home, ".subctl-deepseek-aliases", "dsk-test");
    expect(text).toContain(`HOME=${expectedHome}`);
    // Confirm the args echo `auth set --provider deepseek` shape:
    expect(text).toContain("auth set --provider deepseek");
    // Combined stdout: code path output should not have crashed bash.
    expect(r.stdout + r.stderr).not.toContain("command not found");
  });

  test("the HOME-shadow path is pinned in cfg_dir/.subctl-deepseek-home", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    await runBash(
      d,
      `. "${AUTH_SH}"
       echo "" | provider_deepseek_auth "dsk-test" "${cfgDir}" "test@example.com" || true`,
    );
    const pinFile = join(cfgDir, ".subctl-deepseek-home");
    expect(existsSync(pinFile)).toBe(true);
    const pinned = readFileSync(pinFile, "utf8").trim();
    expect(pinned).toBe(join(d.home, ".subctl-deepseek-aliases", "dsk-test"));
  });

  test("auth_status returns ready when config.toml has api_key in shadow dir", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    const shadow = join(d.home, ".subctl-deepseek-aliases", "dsk-test");
    mkdirSync(join(shadow, ".deepseek"), { recursive: true });
    writeFileSync(
      join(shadow, ".deepseek", "config.toml"),
      "provider = deepseek\napi_key = sk-precanned1234\n",
    );
    const r = await runBash(
      d,
      `. "${AUTH_SH}"
       provider_deepseek_auth "dsk-test" "${cfgDir}" "test@example.com"`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already authenticated");
  });

  test("auth_status returns ready when file-based secret store has entries", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    const shadow = join(d.home, ".subctl-deepseek-aliases", "dsk-test");
    mkdirSync(join(shadow, ".deepseek", "secrets"), { recursive: true });
    writeFileSync(join(shadow, ".deepseek", "secrets", "deepseek"), "sk-precanned1234");
    const r = await runBash(
      d,
      `. "${AUTH_SH}"
       provider_deepseek_auth "dsk-test" "${cfgDir}" "test@example.com"`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already authenticated");
  });

  test("config.toml WITHOUT api_key line is NOT ready", async () => {
    // Codewhale writes non-secret config (provider, default model, project
    // trust levels) into config.toml. An api_key-less config must not
    // falsely register as authenticated.
    const cfgDir = join(d.root, "dsk-test-cfg");
    const shadow = join(d.home, ".subctl-deepseek-aliases", "dsk-test");
    mkdirSync(join(shadow, ".deepseek"), { recursive: true });
    writeFileSync(
      join(shadow, ".deepseek", "config.toml"),
      'provider = deepseek\nreasoning_effort = "auto"\n',
    );
    const r = await runBash(
      d,
      `. "${AUTH_SH}"
       echo "" | provider_deepseek_auth "dsk-test" "${cfgDir}" "test@example.com"`,
    );
    // Should fall through to the launch path (which uses our fake codewhale
    // that DOES write a real key), not short-circuit on "already auth'd".
    expect(r.stdout).not.toContain("already authenticated");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// teams.sh spawn (dry-run + validation)
// ─────────────────────────────────────────────────────────────────────────

describe("teams.sh --dry-run + provider mismatch checks", () => {
  beforeEach(() => { d = setup(); });

  test("--dry-run prints the spawn plan with HOME-shadow info and UNGATED warning", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Starting CodeWhale in tmux session: dsk-");
    expect(r.stdout).toContain("codewhale HOME shadow:");
    expect(r.stdout).toContain("UNGATED");
    expect(r.stdout).toContain("(dry run — not launching tmux)");
  });

  test("--dry-run uses the pinned HOME-shadow path when present", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    mkdirSync(cfgDir, { recursive: true });
    const customShadow = join(d.root, "custom-deepseek-home");
    writeFileSync(join(cfgDir, ".subctl-deepseek-home"), customShadow + "\n");
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(customShadow);
    expect(existsSync(join(customShadow, ".deepseek"))).toBe(true);
  });

  test("refuses an account whose provider is claude (not deepseek)", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a claude-test --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("is provider=claude, not deepseek");
  });

  test("missing -a flag fails with usage message", async () => {
    const r = await runBash(
      d,
      `. "${TEAMS_SH}"
       provider_deepseek_teams --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("requires -a <alias>");
  });

  test("-m model is echoed in the dry-run plan + added to command", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test -m deepseek-v4-pro --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Model:");
    expect(r.stdout).toContain("deepseek-v4-pro");
    expect(r.stdout).toMatch(/Command:.*--model deepseek-v4-pro/);
  });

  test("-y maps to codewhale --yolo", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test -y --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("YOLO");
    expect(r.stdout).toMatch(/Command:.*--yolo/);
  });

  test("-c maps to `codewhale resume --last`", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test -c --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("resume --last");
    expect(r.stdout).toMatch(/Command:.*codewhale resume --last/);
  });

  test("-o is accepted as a no-op in v3.0.0-rc1", async () => {
    // Spec smoke test uses -o; it should parse cleanly and not affect
    // the spawn command, with a visible "no-op" notice.
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test -o -y --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no-op in v3.0.0-rc1");
  });

  test("unknown flag fails cleanly", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_deepseek_teams -a dsk-test --not-a-real-flag --dry-run || true`,
    );
    expect(r.stderr).toContain("unknown teams option");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// signals.sh smoke
// ─────────────────────────────────────────────────────────────────────────

describe("signals.sh JSON shape", () => {
  beforeEach(() => { d = setup(); });

  test("emits provider=deepseek JSON with the expected keys", async () => {
    const cfgDir = join(d.root, "dsk-test-cfg");
    mkdirSync(cfgDir, { recursive: true });
    const shadow = join(d.home, ".subctl-deepseek-aliases", "dsk-test");
    mkdirSync(join(shadow, ".deepseek", "sessions"), { recursive: true });
    writeFileSync(
      join(shadow, ".deepseek", "config.toml"),
      "provider = deepseek\napi_key = sk-precanned\n",
    );
    writeFileSync(join(shadow, ".deepseek", "sessions", "s1.jsonl"), "{}\n");
    const r = await runBash(
      d,
      `. "${SIGNALS_SH}"
       provider_deepseek_signals "dsk-test"`,
    );
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout.trim());
    expect(json.alias).toBe("dsk-test");
    expect(json.provider).toBe("deepseek");
    expect(json.auth_status).toBe("ready");
    expect(json.deepseek_home).toBe(shadow);
    expect(typeof json.active_sessions).toBe("number");
    expect(json.rl_hits_today).toBe(0);
  });

  test("returns error JSON for an unknown alias", async () => {
    const r = await runBash(
      d,
      `. "${SIGNALS_SH}"
       provider_deepseek_signals "nope" || true`,
    );
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    const json = JSON.parse(lines[lines.length - 1]!);
    expect(json.alias).toBe("nope");
    expect(json.provider).toBe("deepseek");
    expect(json.error).toBeTruthy();
  });
});
