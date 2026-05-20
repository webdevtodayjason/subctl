// lib/__tests__/team-baseline.test.ts
//
// Memory Init #6 — coverage for the `subctl team baseline {init,ensure,status}`
// verb added in lib/cli.sh + wired into bin/subctl.
//
// Approach mirrors lib/__tests__/cli.test.ts: Bun.spawnSync against the real
// bash dispatcher. The claude-layers submodule at
// components/agents/claude-layers/ is read from the repo as-is — we don't
// stub the installer, we exercise the real one against a fresh tmpdir each
// test so we know the end-to-end wrap works.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SUBCTL = join(REPO_ROOT, "bin", "subctl");
const SUBMODULE_INSTALLER = join(
  REPO_ROOT,
  "components",
  "agents",
  "claude-layers",
  "install.sh",
);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string): RunResult {
  const proc = Bun.spawnSync([SUBCTL, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("subctl team baseline", () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), "subctl-baseline-test-"));
  });

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test("help text lists init / ensure / status verbs", () => {
    const r = run(["team", "baseline", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("ensure");
    expect(r.stdout).toContain("status");
    // Memory Init #6 should be acknowledged in help so operators trace the
    // verb back to the spec it implements.
    expect(r.stdout).toContain("Memory Init #6");
  });

  test("unknown verb errors with non-zero exit", () => {
    const r = run(["team", "baseline", "bogus"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown team baseline verb");
  });

  test("status against a clean tempdir reports all floor files missing", () => {
    const clean = mkdtempSync(join(tmpdir(), "subctl-baseline-clean-"));
    try {
      const r = run(["team", "baseline", "status", clean]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`baseline status: ${clean}`);
      // Clean dir → "0 present" appears in the summary line.
      expect(r.stdout).toMatch(/0 present, \d+ missing/);
      // No CLAUDE.md → version line surfaces the absence rather than blanking.
      expect(r.stdout).toContain("no CLAUDE.md or no version header");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  test("status against a missing dir errors cleanly", () => {
    const ghost = join(tmpdir(), "subctl-baseline-ghost-does-not-exist");
    const r = run(["team", "baseline", "status", ghost]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("target directory not found");
  });

  // The init + ensure flow exercises the real submodule installer. Skipped
  // gracefully when the submodule isn't checked out (e.g. fresh clone
  // without `--recurse-submodules`) so this file doesn't fail in CI before
  // the submodule init has run.
  const haveInstaller = existsSync(SUBMODULE_INSTALLER);

  test.if(haveInstaller)(
    "init materializes CLAUDE.md + .claude/ into target",
    () => {
      const dir = join(workdir, "init-target");
      Bun.spawnSync(["mkdir", "-p", dir]);
      const r = run(["team", "baseline", "init", dir]);
      expect(r.code).toBe(0);
      // The installer's own "Done." trailer is our happy-path signal.
      expect(r.stdout).toContain("Done.");
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(dir, ".claude", "agents", "FORGE.md"))).toBe(true);
      expect(existsSync(join(dir, ".claude", "projects", "PROJECT_TEMPLATE.md"))).toBe(true);
      expect(existsSync(join(dir, ".claude", "orchestrator", "ARGENT.md"))).toBe(true);
    },
  );

  test.if(haveInstaller)(
    "status against an installed dir shows all floor files present + version",
    () => {
      const dir = join(workdir, "init-target");
      // init was run by the previous test; this verifies the read side
      // sees what the write side produced.
      const r = run(["team", "baseline", "status", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/installed:\s+v\d+\.\d+\.\d+/);
      // 7 floor files defined in _subctl_cli_team_baseline_floor_files;
      // post-init they should all be present.
      expect(r.stdout).toContain("7 present, 0 missing");
    },
  );

  test.if(haveInstaller)(
    "ensure is a no-op when the baseline is already installed",
    () => {
      const dir = join(workdir, "init-target");
      const r = run(["team", "baseline", "ensure", dir]);
      expect(r.code).toBe(0);
      // Idempotent no-op signal — no installer banner, just the "ok" line.
      expect(r.stdout).toContain("baseline ok at");
      expect(r.stdout).not.toContain("Installing...");
    },
  );

  test.if(haveInstaller)(
    "ensure on an empty dir runs init",
    () => {
      const dir = join(workdir, "ensure-target");
      Bun.spawnSync(["mkdir", "-p", dir]);
      const r = run(["team", "baseline", "ensure", dir]);
      expect(r.code).toBe(0);
      // installer ran → CLAUDE.md exists afterward.
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    },
  );
});
