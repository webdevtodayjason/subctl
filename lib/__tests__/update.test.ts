// lib/__tests__/update.test.ts
//
// v2.7.5 — covers the two `subctl update` UX improvements landed in
// lib/update.sh:
//   1. version-state block printed BEFORE the working-tree gate
//   2. lockfile-only auto-stash carve-out
//
// Test approach: Option B (Bun.spawn) — sources lib/update.sh in a
// subshell so we can exercise both the pure helpers
// (_subctl_update_is_lockfile, _subctl_update_classify_dirty,
// _subctl_update_pop_stash) and the full subctl_update flow against
// a hermetic temp-dir git repo with a bare origin.
//
// Why Option B over a pure bash test harness: the rest of the repo
// uses bun:test + Bun.spawn (see bin/policy/__tests__/cli.test.ts,
// dashboard/__tests__/audit-api.test.ts), so this slots into the
// existing `bun test` pipeline without adding a second test runner.
//
// Hermetic guarantees:
//   - every test creates its own mkdtempSync repo pair (origin.git + local)
//   - SUBCTL_REPO_ROOT is overridden per-test
//   - --no-restart is always passed (so launchctl never fires)
//   - the temp local repo never contains bin/subctl, so doctor never runs
//   - NO_COLOR=1 strips ANSI escapes so assertions are simple substrings

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const UPDATE_SH = join(REPO_ROOT, "lib", "update.sh");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function bashRun(script: string, env: Record<string, string> = {}, cwd?: string): RunResult {
  const proc = Bun.spawnSync(["bash", "-c", script], {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// Run a bash command capturing its stdout, with the script + porcelain
// passed as positional args so we don't have to escape multi-line input.
function callHelper(funcCall: string, ...positional: string[]): RunResult {
  const proc = Bun.spawnSync(
    [
      "bash",
      "-c",
      `source "$1"; ${funcCall}`,
      "--",
      UPDATE_SH,
      ...positional,
    ],
    {
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function git(repo: string, ...args: string[]): string {
  return execSync(`git -C "${repo}" ${args.map((a) => `"${a}"`).join(" ")}`, {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

interface RepoPair {
  bareRepo: string;   // origin.git
  localRepo: string;  // working clone — this is what subctl_update operates on
  cleanup: () => void;
}

// Build a fresh origin.git + local clone with one seed commit
// (VERSION = seedVersion). Caller can then push more commits to origin.
function setupRepoPair(seedVersion = "2.7.4"): RepoPair {
  const root = mkdtempSync(join(tmpdir(), "subctl-update-test-"));
  const bareRepo = join(root, "origin.git");
  const localRepo = join(root, "local");

  execSync(`git init -q --bare "${bareRepo}"`);
  execSync(`git init -q -b main "${localRepo}"`);
  git(localRepo, "config", "user.email", "test@example.com");
  git(localRepo, "config", "user.name", "Test");
  git(localRepo, "config", "commit.gpgsign", "false");

  writeFileSync(join(localRepo, "VERSION"), `${seedVersion}\n`);
  writeFileSync(join(localRepo, "bun.lock"), 'lockfileVersion = 1\nseed = "v0"\n');
  writeFileSync(
    join(localRepo, "README.md"),
    "test fixture for lib/__tests__/update.test.ts\n",
  );
  git(localRepo, "add", ".");
  git(localRepo, "commit", "-q", "-m", `seed v${seedVersion}`);

  git(localRepo, "remote", "add", "origin", bareRepo);
  git(localRepo, "push", "-q", "-u", "origin", "main");

  return {
    bareRepo,
    localRepo,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Add a commit on origin (via a separate clone) so the local repo is "behind".
function pushRemoteBump(bareRepo: string, newVersion: string, extraFile?: { name: string; content: string }): void {
  const tmp = mkdtempSync(join(tmpdir(), "subctl-update-push-"));
  try {
    execSync(`git clone -q "${bareRepo}" "${tmp}"`);
    git(tmp, "config", "user.email", "test@example.com");
    git(tmp, "config", "user.name", "Test");
    git(tmp, "config", "commit.gpgsign", "false");
    writeFileSync(join(tmp, "VERSION"), `${newVersion}\n`);
    if (extraFile) writeFileSync(join(tmp, extraFile.name), extraFile.content);
    git(tmp, "add", ".");
    git(tmp, "commit", "-q", "-m", `bump v${newVersion}`);
    git(tmp, "push", "-q", "origin", "main");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Run subctl_update against a temp repo with --no-restart (and SUBCTL_REPO_ROOT
// pointed at the local clone so the script doesn't touch the real subctl tree).
function runUpdate(localRepo: string, args: string[] = []): RunResult {
  const argString = args.map((a) => `"${a}"`).join(" ");
  return bashRun(
    `source "${UPDATE_SH}"; subctl_update --no-restart ${argString}`,
    { SUBCTL_REPO_ROOT: localRepo },
  );
}

// ─── pure helper tests ───────────────────────────────────────────────────────

describe("_subctl_update_is_lockfile", () => {
  for (const path of [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "components/master/bun.lock",
    "deeply/nested/path/yarn.lock",
    "./bun.lock",
  ]) {
    test(`${path} → lockfile`, () => {
      const r = callHelper(`_subctl_update_is_lockfile "$2"`, path);
      expect(r.code).toBe(0);
    });
  }

  for (const path of [
    "package.json",
    "components/master/server.ts",
    "lib/update.sh",
    "VERSION",
    "Cargo.lock",       // intentionally NOT in our allow list
    "Gemfile.lock",     // ditto
    "poetry.lock",      // ditto
    "bun.lock.bak",     // basename has trailing junk
  ]) {
    test(`${path} → not a lockfile`, () => {
      const r = callHelper(`_subctl_update_is_lockfile "$2"`, path);
      expect(r.code).toBe(1);
    });
  }
});

describe("_subctl_update_classify_dirty", () => {
  test("empty input → clean", () => {
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, "");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("clean");
  });

  test("only one lockfile → lockfile-only|<path>", () => {
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, " M bun.lock");
    expect(r.stdout).toBe("lockfile-only|bun.lock");
  });

  test("multiple lockfiles → lockfile-only|<csv>", () => {
    const porcelain = " M bun.lock\n M components/master/bun.lock\n M dashboard/package-lock.json";
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, porcelain);
    expect(r.stdout).toBe(
      "lockfile-only|bun.lock|components/master/bun.lock|dashboard/package-lock.json",
    );
  });

  test("untracked lockfile (??) is recognized", () => {
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, "?? bun.lock");
    expect(r.stdout).toBe("lockfile-only|bun.lock");
  });

  test("any non-lockfile → mixed|<count>", () => {
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, " M lib/update.sh");
    expect(r.stdout).toBe("mixed|1");
  });

  test("lockfile + source mix → mixed|<non-lock-count>", () => {
    const porcelain = " M bun.lock\n M lib/update.sh\n M components/master/server.ts";
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, porcelain);
    expect(r.stdout).toBe("mixed|2");
  });

  test("rename rows use the new path", () => {
    // git status --porcelain: "R  old-name -> new-name"
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, "R  old.txt -> bun.lock");
    expect(r.stdout).toBe("lockfile-only|bun.lock");
  });

  test("Cargo.lock is mixed (NOT a carve-out lockfile)", () => {
    const r = callHelper(`_subctl_update_classify_dirty "$2"`, " M Cargo.lock");
    expect(r.stdout).toBe("mixed|1");
  });
});

// ─── integration: version-state block ────────────────────────────────────────

describe("subctl_update — version state block", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("up-to-date: prints 'same — already up to date' and exits 0", () => {
    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl update — version state");
    expect(r.stdout).toContain("current: v2.7.4");
    expect(r.stdout).toContain("branch:  main");
    expect(r.stdout).toContain("remote:  same — already up to date");
    expect(r.stdout).toContain("already up to date (main @");
  });

  test("behind: prints '<N> commits ahead' and proceeds with the update", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("current: v2.7.4");
    expect(r.stdout).toContain("remote:  v2.7.5");
    expect(r.stdout).toContain("1 commits ahead");
    expect(r.stdout).toContain("v2.7.4 → v2.7.5");
  });

  test("ahead: prints 'AHEAD of remote' in the version block", () => {
    // Make a local-only commit so we're strictly ahead of origin.
    writeFileSync(join(pair.localRepo, "VERSION"), "2.7.6-dev\n");
    git(pair.localRepo, "add", "VERSION");
    git(pair.localRepo, "commit", "-q", "-m", "local dev bump");

    const r = runUpdate(pair.localRepo);
    expect(r.stdout).toContain("current: v2.7.6-dev");
    expect(r.stdout).toContain("remote:  v2.7.4");
    expect(r.stdout).toContain("local is 1 commits AHEAD of remote");
    // merge --ff-only against origin/main is a no-op when we're strictly
    // ahead (origin's tip is already an ancestor) — the update succeeds
    // with a 0-commit "no-op" merge. Operator now sees the AHEAD signal
    // up front, which was the whole point of the version block.
    expect(r.code).toBe(0);
  });

  test("diverged: ff-only fails cleanly with version state still shown", () => {
    // Genuine divergence: local has a commit AND origin has a different commit.
    writeFileSync(join(pair.localRepo, "README.md"), "local-side change\n");
    git(pair.localRepo, "add", "README.md");
    git(pair.localRepo, "commit", "-q", "-m", "local-side commit");
    pushRemoteBump(pair.bareRepo, "2.7.5");

    const r = runUpdate(pair.localRepo);
    expect(r.stdout).toContain("current: v2.7.4");
    expect(r.stdout).toContain("remote:  v2.7.5");
    expect(r.stdout).toContain("diverged");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("fast-forward failed");
  });

  test("version-state block is printed BEFORE the dirty-tree abort", () => {
    // Plant a non-lockfile dirty file so update aborts on the cleanliness gate.
    writeFileSync(join(pair.localRepo, "README.md"), "tampered\n");
    pushRemoteBump(pair.bareRepo, "2.7.5");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(1);
    // Version block must appear BEFORE the abort message.
    const versionIdx = r.stdout.indexOf("version state");
    expect(versionIdx).toBeGreaterThanOrEqual(0);
    expect(r.stdout).toContain("current: v2.7.4");
    expect(r.stdout).toContain("remote:  v2.7.5");
    // The abort itself goes to stderr.
    expect(r.stderr).toContain("uncommitted changes");
  });
});

// ─── integration: lockfile-only auto-stash carve-out ─────────────────────────

describe("subctl_update — lockfile auto-stash carve-out", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("lockfile-only drift → auto-stash, no error, restored after update", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    // Drift the local bun.lock the way `bun install` would.
    writeFileSync(join(pair.localRepo, "bun.lock"), 'lockfileVersion = 1\nseed = "v0"\nplatform = "darwin-arm64"\n');

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dirty lockfile detected");
    expect(r.stdout).toContain("auto-stashing: bun.lock");
    expect(r.stdout).toContain("will restore after update");
    expect(r.stdout).toContain("auto-stashed lockfile restored");
    expect(r.stdout).toContain("v2.7.4 → v2.7.5");

    // The drift content survives the stash/pop round-trip.
    const restored = execSync(`cat "${join(pair.localRepo, "bun.lock")}"`, { encoding: "utf8" });
    expect(restored).toContain('platform = "darwin-arm64"');
  });

  test("mixed drift WITHOUT --force → error, no stash created", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    writeFileSync(join(pair.localRepo, "bun.lock"), "drift\n");
    writeFileSync(join(pair.localRepo, "README.md"), "tampered\n");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
    // Confirm no stash was created.
    const stashList = git(pair.localRepo, "stash", "list").trim();
    expect(stashList).toBe("");
    // The README drift remains in the working tree.
    expect(execSync(`cat "${join(pair.localRepo, "README.md")}"`, { encoding: "utf8" })).toContain("tampered");
  });

  test("mixed drift WITH --force → stashes everything, succeeds, restores", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    writeFileSync(join(pair.localRepo, "bun.lock"), "drift\n");
    writeFileSync(join(pair.localRepo, "README.md"), "tampered\n");

    const r = runUpdate(pair.localRepo, ["--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v2.7.4 → v2.7.5");
    // --force path uses the simple "stash restored" message, not the lockfile one.
    expect(r.stdout).toContain("stash restored");
    expect(r.stdout).not.toContain("auto-stashed lockfile restored");
    // README drift survived the round-trip.
    expect(execSync(`cat "${join(pair.localRepo, "README.md")}"`, { encoding: "utf8" })).toContain("tampered");
  });

  test("up-to-date + lockfile-only drift → no-op, no error, drift preserved", () => {
    // No remote bump: local is already up to date.
    writeFileSync(join(pair.localRepo, "bun.lock"), "drift-while-uptodate\n");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already up to date");
    // The fast-exit happens BEFORE the dirty-tree gate, so no stash dance.
    expect(r.stdout).not.toContain("auto-stashing");
    expect(execSync(`cat "${join(pair.localRepo, "bun.lock")}"`, { encoding: "utf8" })).toContain("drift-while-uptodate");
  });

  test("Cargo.lock drift is NOT auto-stashed (carve-out is narrow)", () => {
    // Stage Cargo.lock locally first, push it to origin so origin has it too,
    // THEN bump the remote so we're behind.
    writeFileSync(join(pair.localRepo, "Cargo.lock"), "[[package]]\nname = \"x\"\n");
    git(pair.localRepo, "add", "Cargo.lock");
    git(pair.localRepo, "commit", "-q", "-m", "add cargo lock");
    git(pair.localRepo, "push", "-q", "origin", "main");
    pushRemoteBump(pair.bareRepo, "2.7.5");
    // Now drift the locally-tracked Cargo.lock.
    writeFileSync(join(pair.localRepo, "Cargo.lock"), "[[package]]\nname = \"x\"\nversion = \"1.0\"\n");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
  });

  test("nested lockfile (components/master/bun.lock) auto-stashes correctly", () => {
    // Create a nested lockfile and commit it (so it becomes a tracked file
    // we can then drift).
    mkdirSync(join(pair.localRepo, "components/master"), { recursive: true });
    writeFileSync(join(pair.localRepo, "components/master/bun.lock"), "v1\n");
    git(pair.localRepo, "add", "components/master/bun.lock");
    git(pair.localRepo, "commit", "-q", "-m", "add nested lockfile");
    git(pair.localRepo, "push", "-q", "origin", "main");

    pushRemoteBump(pair.bareRepo, "2.7.5");
    // Drift the nested lockfile.
    writeFileSync(join(pair.localRepo, "components/master/bun.lock"), "v1\nplatform = darwin\n");

    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("auto-stashing: components/master/bun.lock");
    expect(r.stdout).toContain("auto-stashed lockfile restored");
    expect(execSync(`cat "${join(pair.localRepo, "components/master/bun.lock")}"`, { encoding: "utf8" })).toContain("platform = darwin");
  });
});

// ─── integration: --force semantics preserved ────────────────────────────────

describe("subctl_update — --force still works", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("clean tree + --force → still updates (no behavior change)", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");

    const r = runUpdate(pair.localRepo, ["--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v2.7.4 → v2.7.5");
    // --force doesn't trigger a stash when nothing's dirty.
    expect(r.stdout).not.toContain("stash restored");
  });
});

// ─── v2.7.6 — argent-style additions ─────────────────────────────────────────
//
// Each test that touches `~/.config/subctl/config.toml` overrides
// SUBCTL_CONFIG_DIR via mkdtemp so real operator state is never poked.

function mkConfigDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "subctl-update-cfg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Like runUpdate, but allows overriding extra env (e.g. SUBCTL_CONFIG_DIR).
function runUpdateWithEnv(
  localRepo: string,
  args: string[],
  extraEnv: Record<string, string>,
): RunResult {
  const argString = args.map((a) => `"${a}"`).join(" ");
  return bashRun(
    `source "${UPDATE_SH}"; subctl_update --no-restart ${argString}`,
    { SUBCTL_REPO_ROOT: localRepo, ...extraEnv },
  );
}

// Run `subctl update status` (no --no-restart needed — status never restarts).
function runStatus(localRepo: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const argString = args.map((a) => `"${a}"`).join(" ");
  return bashRun(
    `source "${UPDATE_SH}"; subctl_update status ${argString}`,
    { SUBCTL_REPO_ROOT: localRepo, ...extraEnv },
  );
}

describe("subctl update status — read-only", () => {
  let pair: RepoPair;
  let cfg: ReturnType<typeof mkConfigDir>;
  beforeEach(() => {
    pair = setupRepoPair("2.7.4");
    // Always isolate config so last_update reads aren't contaminated by
    // the operator's real ~/.config/subctl/config.toml.
    cfg = mkConfigDir();
  });
  afterEach(() => { pair.cleanup(); cfg.cleanup(); });

  test("clean repo: prints version + channel + remote state, exits 0", () => {
    const r = runStatus(pair.localRepo, [], { SUBCTL_CONFIG_DIR: cfg.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl 2.7.4");
    expect(r.stdout).toContain("branch:   main");
    expect(r.stdout).toContain("channel:  stable (default)");
    expect(r.stdout).toContain("up to date");
    // Status MUST NOT advance to the update flow — no merge/stash log lines.
    expect(r.stdout).not.toContain("updated ");
    expect(r.stdout).not.toContain("auto-stashing");
  });

  test("dirty repo: still exits 0 (status doesn't enforce cleanliness)", () => {
    writeFileSync(join(pair.localRepo, "README.md"), "tampered\n");
    const r = runStatus(pair.localRepo, [], { SUBCTL_CONFIG_DIR: cfg.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("subctl 2.7.4");
    // README drift is still on disk — status didn't touch it.
    expect(execSync(`cat "${join(pair.localRepo, "README.md")}"`, { encoding: "utf8" }))
      .toContain("tampered");
  });

  test("--json: returns parseable JSON with the expected fields", () => {
    const r = runStatus(pair.localRepo, ["--json"], { SUBCTL_CONFIG_DIR: cfg.dir });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.ok).toBe(true);
    expect(doc.version).toBe("2.7.4");
    expect(doc.channel).toBe("stable");
    expect(doc.branch).toBe("main");
    expect(doc.remote.state).toBe("up-to-date");
    expect(doc.last_update).toBeNull();
  });

  test("behind remote: status surfaces 'commits ahead'", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    const r = runStatus(pair.localRepo, [], { SUBCTL_CONFIG_DIR: cfg.dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 commits ahead");
  });
});

describe("subctl_update --channel", () => {
  let pair: RepoPair;
  let cfg: ReturnType<typeof mkConfigDir>;
  beforeEach(() => {
    pair = setupRepoPair("2.7.4");
    cfg = mkConfigDir();
  });
  afterEach(() => { pair.cleanup(); cfg.cleanup(); });

  test("--channel beta persists to config.toml under [update]", () => {
    // No `beta` branch on origin — but persistence happens BEFORE the
    // branch-existence check, so the config write still lands. The
    // fallback-to-main behavior is exercised separately.
    const r = runUpdateWithEnv(pair.localRepo, ["--channel", "beta"], { SUBCTL_CONFIG_DIR: cfg.dir });
    // Whatever the run exit code, the persistence MUST have happened.
    const conf = execSync(`cat "${join(cfg.dir, "config.toml")}"`, { encoding: "utf8" });
    expect(conf).toContain("[update]");
    expect(conf).toContain('channel = "beta"');
    // The persistence log line goes to stdout when not in --json mode.
    expect(r.stdout).toContain("channel set to 'beta'");
  });

  test("--channel invalid → exits 1 with a clear error", () => {
    const r = runUpdateWithEnv(pair.localRepo, ["--channel", "preview"], { SUBCTL_CONFIG_DIR: cfg.dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown channel 'preview'");
    expect(r.stderr).toContain("stable, beta, dev");
  });

  test("config.toml channel value is the default when --channel is omitted", () => {
    // Pre-seed config.toml with channel = "beta".
    writeFileSync(join(cfg.dir, "config.toml"), '[update]\nchannel = "beta"\n');
    const r = runUpdateWithEnv(pair.localRepo, [], { SUBCTL_CONFIG_DIR: cfg.dir });
    // beta branch doesn't exist on origin → fall back to main with a warning,
    // and the version block reflects that fallback.
    expect(r.stdout).toContain("branch 'beta' doesn't exist on origin");
    expect(r.stdout).toContain("channel: beta");
  });
});

describe("subctl_update --json (full update flow)", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("happy path: --json on up-to-date repo emits parseable success doc", () => {
    const r = runUpdate(pair.localRepo, ["--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.ok).toBe(true);
    expect(doc.from.version).toBe("2.7.4");
    expect(doc.to.version).toBe("2.7.4");
    expect(doc.channel).toBe("stable");
    expect(doc.commits_applied).toBe(0);
    expect(doc.lockfile_stashed).toBe(false);
    expect(doc.services_restarted).toEqual([]);
  });

  test("update path: --json reports from→to + commits_applied", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    const r = runUpdate(pair.localRepo, ["--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.ok).toBe(true);
    expect(doc.from.version).toBe("2.7.4");
    expect(doc.to.version).toBe("2.7.5");
    expect(doc.commits_applied).toBe(1);
    expect(doc.lockfile_stashed).toBe(false);
  });

  test("error path: --json on dirty repo emits {ok:false,error,stage}", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    writeFileSync(join(pair.localRepo, "README.md"), "tampered\n");

    const r = runUpdate(pair.localRepo, ["--json"]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.ok).toBe(false);
    expect(doc.error).toContain("uncommitted changes");
    // Dirty-tree gate fires after the fetch stage label is set.
    expect(["preflight", "fetch"]).toContain(doc.stage);
  });

  test("--json suppresses all human output to stdout/stderr", () => {
    const r = runUpdate(pair.localRepo, ["--json"]);
    expect(r.code).toBe(0);
    // The stdout MUST be one line (the JSON doc) and parse cleanly.
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    // No human log markers should leak.
    expect(r.stdout).not.toContain("==>");
    expect(r.stdout).not.toContain("version state");
    expect(r.stderr).toBe("");
  });

  test("lockfile auto-stash is reflected in JSON as lockfile_stashed:true", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    writeFileSync(join(pair.localRepo, "bun.lock"),
      'lockfileVersion = 1\nseed = "v0"\nplatform = "darwin-arm64"\n');

    const r = runUpdate(pair.localRepo, ["--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout.trim());
    expect(doc.ok).toBe(true);
    expect(doc.lockfile_stashed).toBe(true);
  });
});

describe("subctl_update --yes (downgrade confirmation)", () => {
  let pair: RepoPair;
  // Seed the LOCAL repo at v2.7.5 so that origin/main (at v2.7.4) is a downgrade.
  beforeEach(() => {
    pair = setupRepoPair("2.7.4");
    // Bump the local-only version past origin, but DON'T push — origin
    // still has 2.7.4. Adding a commit also makes the local repo strictly
    // ahead, which would normally make ff-only a no-op; reset origin
    // forward with a different commit first so the merge has work to do.
    // Simpler path: push a downgrade commit by rewriting origin's VERSION
    // backwards relative to local. We do that by bumping local first.
    writeFileSync(join(pair.localRepo, "VERSION"), "2.7.6\n");
    git(pair.localRepo, "add", "VERSION");
    git(pair.localRepo, "commit", "-q", "-m", "local bump to 2.7.6");
    // Now push origin to a DIFFERENT commit that drops VERSION back to 2.7.5
    // — diverged, so we need --force on the merge too, BUT the downgrade
    // path runs BEFORE the cleanliness gate so we still hit it.
    pushRemoteBump(pair.bareRepo, "2.7.5");
  });
  afterEach(() => pair.cleanup());

  test("downgrade detected + --yes set + non-interactive → proceeds (or fails later, not at the prompt)", () => {
    const r = runUpdate(pair.localRepo, ["--yes", "--force"]);
    // Whatever happens at the merge stage (the test repos diverge so
    // ff-only may fail), the downgrade was auto-confirmed — we MUST NOT
    // see the non-interactive refusal.
    expect(r.stderr).not.toContain("refusing to downgrade");
    expect(r.stdout).toContain("auto-confirming downgrade");
  });

  test("downgrade detected + no --yes + non-interactive → refuses with stage=preflight-ish", () => {
    const r = runUpdate(pair.localRepo, ["--force"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refusing to downgrade");
  });
});

describe("subctl_update --timeout", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("--timeout 1 with a sleeping git-fetch wrapper → fetch stage times out", () => {
    // Plant a fake `git` in a temp dir that delegates to real git for
    // everything EXCEPT `git fetch`, which sleeps. We prepend it to PATH
    // so subctl_update's preflight (rev-parse, remote, ls-remote) still
    // works — only the timed `git fetch` step trips the alarm.
    const realGit = execSync(`which git`, { encoding: "utf8" }).trim();
    const fakeBin = mkdtempSync(join(tmpdir(), "subctl-update-fakebin-"));
    try {
      writeFileSync(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash
if [[ "$1" == "fetch" ]]; then
  sleep 30
  exit 0
fi
exec "${realGit}" "$@"
`,
      );
      execSync(`chmod +x "${join(fakeBin, "git")}"`);

      const r = bashRun(
        `source "${UPDATE_SH}"; subctl_update --no-restart --timeout 1`,
        {
          SUBCTL_REPO_ROOT: pair.localRepo,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      );
      // Timeout-wrapped fetch must fail (exit 2) and the error must
      // name the failed step ("fetch").
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("timed out after 1s");
      expect(r.stderr).toContain("fetch");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  test("--timeout requires a non-negative integer", () => {
    const r = runUpdate(pair.localRepo, ["--timeout", "abc"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--timeout requires");
  });

  test("--timeout 1200 (default-ish) on up-to-date repo still succeeds", () => {
    // Sanity: a generous timeout doesn't break the happy path.
    const r = runUpdate(pair.localRepo, ["--timeout", "1200"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already up to date");
  });
});

describe("subctl_update --help (v2.7.6 polish)", () => {
  test("--help includes the Notes section", () => {
    const r = bashRun(`source "${UPDATE_SH}"; subctl_update --help`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Notes:");
    expect(r.stdout).toContain("Back-compat");
    expect(r.stdout).toContain("Downgrades");
  });

  test("--help includes the Examples section", () => {
    const r = bashRun(`source "${UPDATE_SH}"; subctl_update --help`);
    expect(r.stdout).toContain("Examples:");
    expect(r.stdout).toContain("subctl update status");
    expect(r.stdout).toContain("subctl update --channel beta");
    expect(r.stdout).toContain("subctl update --json");
  });

  test("--help includes the Docs URL footer", () => {
    const r = bashRun(`source "${UPDATE_SH}"; subctl_update --help`);
    expect(r.stdout).toContain("Docs: https://subctl.com/docs/update");
  });
});

describe("subctl_update — back-compat (sacred)", () => {
  let pair: RepoPair;
  beforeEach(() => { pair = setupRepoPair("2.7.4"); });
  afterEach(() => pair.cleanup());

  test("no flags: behavior matches v2.7.5 (version block, ff-merge, no JSON)", () => {
    pushRemoteBump(pair.bareRepo, "2.7.5");
    const r = runUpdate(pair.localRepo);
    expect(r.code).toBe(0);
    // The v2.7.5 markers still appear.
    expect(r.stdout).toContain("subctl update — version state");
    expect(r.stdout).toContain("v2.7.4 → v2.7.5");
    // No JSON in stdout.
    expect(r.stdout).not.toMatch(/^\{"ok":/m);
    // No channel-persistence log when --channel wasn't passed.
    expect(r.stdout).not.toContain("channel set to");
  });
});
