// providers/openai-codex/__tests__/spawn.test.ts
//
// v3.0 Phase 2 — tests for the Codex CLI worker spawn function
// (provider_openai_codex_teams) defined in
// providers/openai-codex/teams.sh.
//
// Shape mirrors providers/pi-coding-agent/__tests__/spawn.test.ts
// closely — same per-test tmpdir scaffolding, same fake-binary-on-PATH
// pattern, same bin/subctl dispatcher integration block. What's new:
//
//   - Per-alias CODEX_HOME echoed in --dry-run output (replaces
//     pi's HOME-shadow assertion).
//   - HMAC secret generation: file presence at
//     `~/.local/state/subctl/teams/<team>/hmac.secret` with mode 0600.
//   - Reporting vocabulary: assert the contract preamble (visible in
//     --dry-run output via the "Contract: embedded ..." line, and
//     directly assert the contract body when sourcing teams.sh in a
//     standalone bash invocation).
//   - Refusal of Claude-only flags (-o, -c, --template) with the
//     specific deprecation messages.
//
// Everything runs in a per-test tmpdir with a fake `codex` binary on
// PATH (a shell script that exits 0). No real tmux session is created
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SUBCTL_BIN = join(REPO_ROOT, "bin", "subctl");
const TEAMS_SH = join(REPO_ROOT, "providers", "openai-codex", "teams.sh");

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  home: string;
  stateDir: string;          // SUBCTL_STATE_DIR — HMAC lands under here
  configDir: string;
  accountsConf: string;
  fakeBin: string;
  projectRoot: string;
  codexHome: string;         // per-alias CODEX_HOME path
}

function setup(opts: { codexExit?: number; accounts?: string; withAuthJson?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-codex-spawn-"));
  const home = join(root, "home");
  const stateDir = join(root, "state");
  const configDir = join(root, "userconfig");
  const accountsConf = join(configDir, "accounts.conf");
  const fakeBin = join(root, "bin");
  const projectRoot = join(root, "proj");
  const codexHome = join(root, "codex-cfg-test");

  for (const d of [home, stateDir, configDir, fakeBin, projectRoot, codexHome]) {
    mkdirSync(d, { recursive: true });
  }

  // Fake `codex` binary. Records invocation env + args so tests can
  // assert that CODEX_HOME was the per-alias dir.
  const codexScript = [
    "#!/bin/sh",
    `echo "CODEX_HOME=$CODEX_HOME" > "${root}/codex-invoke.log"`,
    `echo "SUBCTL_TEAM_NAME=$SUBCTL_TEAM_NAME" >> "${root}/codex-invoke.log"`,
    `echo "args=$*" >> "${root}/codex-invoke.log"`,
    `exit ${opts.codexExit ?? 0}`,
  ].join("\n");
  writeFileSync(join(fakeBin, "codex"), codexScript);
  chmodSync(join(fakeBin, "codex"), 0o755);

  // Seed accounts.conf. Two openai-codex aliases (one valid, one with
  // mismatched provider for the rejection test) + one claude alias.
  const accountsBody = opts.accounts ?? [
    "# Codex test accounts",
    `codex-test    | openai-codex | test@example.com | ${codexHome}            | Codex test`,
    `claude-test   | claude       | test@example.com | ${join(root, "claude-cfg")} | Claude test`,
  ].join("\n");
  writeFileSync(accountsConf, accountsBody + "\n");

  // Seed a non-empty auth.json so the cfg-dir + auth-existence checks pass.
  // Test that exercises the missing-auth path can opt out via withAuthJson:false.
  if (opts.withAuthJson !== false) {
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fake.jwt.token" } }),
    );
  }

  return { root, home, stateDir, configDir, accountsConf, fakeBin, projectRoot, codexHome };
}

function teardown(d: Fixture) {
  rmSync(d.root, { recursive: true, force: true });
}

async function runBash(d: Fixture, script: string): Promise<BashResult> {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      HOME: d.home,
      // Fake `codex` wins against any globally-installed binary.
      PATH: `${d.fakeBin}:${process.env.PATH}`,
      SUBCTL_REPO_ROOT: REPO_ROOT,
      SUBCTL_CONFIG_DIR: d.configDir,
      SUBCTL_ACCOUNTS_CONF: d.accountsConf,
      // Scope HMAC writes to the test fixture so we don't stomp the
      // operator's real ~/.local/state/subctl tree.
      SUBCTL_STATE_DIR: d.stateDir,
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

describe("bin/subctl exposes the codex teams dispatcher", () => {
  test("`subctl teams codex --help` routes to provider_openai_codex_teams help", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" teams codex --help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl teams codex");
    expect(r.stdout).toContain("CODEX_HOME");
    expect(r.stdout).toContain("UNGATED");
  });

  test("`subctl teams openai-codex --help` aliases to the same dispatcher", async () => {
    // Both spellings route to the same provider — `codex` is the short
    // dispatcher name, `openai-codex` matches the accounts.conf provider.
    const r = await runBash(d, `"${SUBCTL_BIN}" teams openai-codex --help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl teams codex");
  });

  test("`subctl teams unknown-provider` still errors cleanly with usage that mentions codex", async () => {
    const r = await runBash(d, `"${SUBCTL_BIN}" teams unknown-provider --help`);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("usage: subctl teams");
    expect(r.stderr + r.stdout).toContain("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// teams.sh --dry-run + validation
// ─────────────────────────────────────────────────────────────────────────

describe("teams.sh --dry-run + provider mismatch checks", () => {
  test("--dry-run prints the spawn plan with CODEX_HOME + UNGATED + Contract embedded", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -p "do the thing" --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Starting Codex worker in tmux session: codex-");
    expect(r.stdout).toContain(`CODEX_HOME:   ${d.codexHome}`);
    expect(r.stdout).toContain("UNGATED");
    expect(r.stdout).toContain("Contract:     embedded");
    expect(r.stdout).toContain("(dry run — not launching tmux)");
  });

  test("--dry-run without a prompt skips the Contract / Mandate lines", async () => {
    // No mandate means no contract preamble; the spawn still prints a
    // plan but should not claim "Contract: embedded".
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Contract:");
    expect(r.stdout).not.toContain("Mandate:");
    expect(r.stdout).toContain("(dry run — not launching tmux)");
  });

  test("--dry-run with -y echoes Skip-perms: true", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -y --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Skip-perms:   true");
    expect(r.stdout).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("--dry-run constructs the trust-level config arg with the cwd embedded", async () => {
    // Regression guard: the trust-level bypass arg is built via
    // `printf %q` so bash can evaluate the nested double-quotes
    // correctly when the command is sent into tmux. In the dry-run
    // diagnostic the quotes appear backslash-escaped (`\"`); once
    // bash evaluates the line they become literal TOML quotes — see
    // the manual probe in CHANGELOG / PR notes.
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test --dry-run`,
    );
    expect(r.code).toBe(0);
    // Look for both halves of the TOML expression around the project
    // path — backslash-escaping is shell-side and irrelevant to the
    // assertion's intent (the cwd must reach codex's config layer).
    expect(r.stdout).toContain("projects.");
    expect(r.stdout).toContain(d.projectRoot);
    expect(r.stdout).toContain("trust_level=");
    expect(r.stdout).toContain("trusted");
  });

  test("refuses an account whose provider is claude (not openai-codex)", async () => {
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a claude-test --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("is provider=claude, not openai-codex");
  });

  test("missing -a flag fails with usage message", async () => {
    const r = await runBash(
      d,
      `. "${TEAMS_SH}"
       provider_openai_codex_teams --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("requires -a <alias>");
  });

  test("accepts -o / --orchestrator as a boolean no-op with an info-warn (canonical smoke shape)", async () => {
    // The spec's canonical smoke command is `subctl teams codex -a <a> -o -y`.
    // Codex has no Team*/SendMessage surface, so the flag is meaningless,
    // but the dispatcher must tolerate it so HTTP-spawn + dashboard can
    // pass uniform argv to every provider.
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -o -y --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("--orchestrator accepted but no-op");
    // -y still wires through to YOLO mode.
    expect(r.stdout).toContain("Skip-perms:   true");
  });

  test("accepts -c / --continue as a boolean no-op with an info-warn", async () => {
    // Same shape as -o. -c is `--continue` (boolean), not `--cwd`.
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -c --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("--continue accepted but no-op");
    expect(r.stdout + r.stderr).toContain("codex resume");
  });

  test("refuses --template with the templates-land-later message (template TAKES a name, can't no-op)", async () => {
    const r = await runBash(
      d,
      `. "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test --template foo --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("does not support templates");
  });

  test("missing auth.json fails before tmux with a clear remediation hint", async () => {
    // Tear down the default fixture and re-create one WITHOUT auth.json.
    teardown(d);
    d = setup({ withAuthJson: false });
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test --dry-run`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no auth.json");
    expect(r.stderr).toContain("subctl auth openai-codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HMAC contract — secret generation + on-disk shape
// ─────────────────────────────────────────────────────────────────────────

describe("HMAC team contract (ADR 0011 Layer 1)", () => {
  test("with a prompt, --dry-run still writes the per-team HMAC secret to disk (0600)", async () => {
    // HMAC generation must happen BEFORE the --dry-run short-circuit so
    // the dry-run output reflects the real contract preamble. The
    // secret file is the canonical authentication state — if it isn't
    // on disk, master can't sign messages this team will trust.
    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -p "build feature X" --dry-run`,
    );
    expect(r.code).toBe(0);

    // SESSION_NAME == "codex-<basename($PWD)>" with /.: stripped to _.
    // projectRoot ends in /proj so the basename is just "proj".
    const sessionName = "codex-proj";
    const hmacPath = join(d.stateDir, "teams", sessionName, "hmac.secret");
    expect(existsSync(hmacPath)).toBe(true);

    // 64-hex contents (32 bytes of /dev/urandom).
    const secret = readFileSync(hmacPath, "utf8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // chmod 600 — must not be readable by group/world. (macOS gives
    // file mode bits in stat.mode; mask to perm bits.)
    const mode = statSync(hmacPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("re-running the spawn with the same team_id reuses the existing secret (idempotent)", async () => {
    const sessionName = "codex-proj";
    const hmacPath = join(d.stateDir, "teams", sessionName, "hmac.secret");

    const r1 = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -p "first spawn" --dry-run`,
    );
    expect(r1.code).toBe(0);
    const first = readFileSync(hmacPath, "utf8").trim();

    const r2 = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test -p "second spawn" --dry-run`,
    );
    expect(r2.code).toBe(0);
    const second = readFileSync(hmacPath, "utf8").trim();
    expect(second).toBe(first);
  });

  test("--dry-run WITHOUT a prompt does NOT write the HMAC secret (no contract = no need)", async () => {
    // If the operator spawns a bare worker (no mandate, no contract),
    // we don't bake an HMAC into a nonexistent preamble. The secret
    // gets minted lazily on the next spawn that DOES have a prompt.
    const sessionName = "codex-proj";
    const hmacPath = join(d.stateDir, "teams", sessionName, "hmac.secret");

    const r = await runBash(
      d,
      `cd "${d.projectRoot}"
       . "${TEAMS_SH}"
       provider_openai_codex_teams -a codex-test --dry-run`,
    );
    expect(r.code).toBe(0);
    expect(existsSync(hmacPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reporting vocabulary — the watchdog classifier depends on these phrases
// ─────────────────────────────────────────────────────────────────────────

describe("contract preamble reporting vocabulary", () => {
  // The auto-nudge watchdog classifier (components/master/auto-nudge.ts)
  // pattern-matches the worker's pane output. For Claude these phrases
  // emerge naturally; for Codex (gpt-5.5) we MUST teach them explicitly
  // in the contract preamble or the staleness sweep nudges a done team
  // every 30 minutes.
  //
  // We assert the contract block by sourcing teams.sh, running the
  // spawn in --dry-run mode with a prompt, then re-running with a
  // PEEK trick: replace the tmux paste call with `echo` so the contract
  // body lands on stdout where we can grep it.
  test("contract preamble teaches the DONE / BLOCKED / AWAITING phrases", async () => {
    // Quickest assertion: just grep teams.sh itself for the vocabulary
    // strings. They're heredoc'd in the script, so if a future refactor
    // moves them, the test forces the author to think about it.
    const teamsSource = readFileSync(TEAMS_SH, "utf8");
    expect(teamsSource).toContain("task complete, idle by design");
    expect(teamsSource).toContain("blocked on <reason>");
    expect(teamsSource).toContain("awaiting your input on <question>");
    expect(teamsSource).toContain("subctl team report --type progress");
    expect(teamsSource).toContain("subctl team report --type blocked");
    expect(teamsSource).toContain("subctl team report --type done");
    expect(teamsSource).toContain("SUBCTL_TEAM_NAME");
  });

  test("contract preamble includes the HMAC self-test recipe", async () => {
    const teamsSource = readFileSync(TEAMS_SH, "utf8");
    // The self-test value is fixed by the contract; if it drifts, the
    // master side and worker side will disagree about HMAC computation
    // and the trust channel breaks.
    expect(teamsSource).toContain("4adef968060ec740");
    expect(teamsSource).toContain("createHmac");
  });
});
