// lib/__tests__/install-evy-layout.test.ts
//
// v3.3.x row ④ — install-time coherence for the tier1 evy/ layout.
//
// subctl_migrate_to_evy historically no-op'd on FRESH installs ("no v2.x
// master artifacts"), leaving neither an evy/ dir nor the master→evy compat
// symlink. Modules that still resolve the legacy master/ path would then
// create a real master/ dir on first write, silently splitting tier1 state
// from the evy/ files the dashboard + daemon + v4 read. The fix routes every
// branch of the migration through subctl_ensure_evy_layout.
//
// install.sh executes the installer when run, so we extract just the two
// functions under test (awk over top-level function bodies) into a bash
// harness with HOME shadowed to a tmpdir — same Bun.spawn pattern as the
// provider spawn suites.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "subctl-install-evy-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runMigration(): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `set -e
. "${REPO_ROOT}/lib/core.sh"
DRY_RUN=false
run() { eval "$@"; }
eval "$(awk '/^subctl_ensure_evy_layout\\(\\)/,/^}/' "${INSTALL_SH}")"
eval "$(awk '/^subctl_migrate_to_evy\\(\\)/,/^}/' "${INSTALL_SH}")"
subctl_migrate_to_evy`;
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

const cfg = () => join(home, ".config", "subctl");

describe("fresh install (no v2.x artifacts)", () => {
  test("creates evy/ and the master→evy compat symlink", async () => {
    mkdirSync(cfg(), { recursive: true });
    const r = await runMigration();
    expect(r.code).toBe(0);
    expect(existsSync(join(cfg(), "evy"))).toBe(true);
    expect(lstatSync(join(cfg(), "master")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(cfg(), "master"))).toBe(join(cfg(), "evy"));
  });

  test("a write through the legacy master/ name lands in evy/", async () => {
    mkdirSync(cfg(), { recursive: true });
    await runMigration();
    // What a module still resolving master/ would do on first write:
    writeFileSync(join(cfg(), "master", "memory.md"), "written via legacy path");
    expect(readFileSync(join(cfg(), "evy", "memory.md"), "utf8"))
      .toBe("written via legacy path");
  });
});

describe("already-migrated install", () => {
  test("idempotent when evy/ + symlink already exist", async () => {
    mkdirSync(join(cfg(), "evy"), { recursive: true });
    writeFileSync(join(cfg(), "evy", "memory.md"), "keep me");
    const first = await runMigration();
    expect(first.code).toBe(0);
    const second = await runMigration();
    expect(second.code).toBe(0);
    expect(readFileSync(join(cfg(), "evy", "memory.md"), "utf8")).toBe("keep me");
    expect(lstatSync(join(cfg(), "master")).isSymbolicLink()).toBe(true);
  });

  test("re-creates the symlink if the operator removed it", async () => {
    mkdirSync(join(cfg(), "evy"), { recursive: true });
    const r = await runMigration();
    expect(r.code).toBe(0);
    rmSync(join(cfg(), "master"));
    const again = await runMigration();
    expect(again.code).toBe(0);
    expect(lstatSync(join(cfg(), "master")).isSymbolicLink()).toBe(true);
  });
});

describe("legacy v2.x upgrade (real master/ dir)", () => {
  test("renames master/ → evy/, leaves symlink, preserves content, writes backup", async () => {
    mkdirSync(join(cfg(), "master"), { recursive: true });
    writeFileSync(join(cfg(), "master", "memory.md"), "v2.x era fact");
    const r = await runMigration();
    expect(r.code).toBe(0);
    expect(readFileSync(join(cfg(), "evy", "memory.md"), "utf8")).toBe("v2.x era fact");
    expect(lstatSync(join(cfg(), "master")).isSymbolicLink()).toBe(true);
    // Pre-migration backup tarball exists.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const backups = readdirSync(cfg()).filter((f: string) => f.startsWith("_backup-pre-v3-rename-"));
    expect(backups.length).toBe(1);
  });

  test("refuses (exit 1) when both master/ and evy/ are real dirs", async () => {
    mkdirSync(join(cfg(), "master"), { recursive: true });
    mkdirSync(join(cfg(), "evy"), { recursive: true });
    const r = await runMigration();
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("leaving both alone");
  });
});
