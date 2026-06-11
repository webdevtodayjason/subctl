// components/evy/__tests__/tier1-memory-paths.test.ts
//
// v3.3.x row ④ — tier1 path drift regression. tier1-memory.ts used to
// hardcode ~/.config/subctl/master/{memory,user}.md while its own header,
// the dashboard endpoint (/api/memory/tier1), and v4's memory_http.rs all
// use <config>/evy/. That was coherent ONLY on hosts where the install-time
// master→evy symlink exists; a fresh install silently split the files
// (dashboard tier1 edits never reached the agent prompt).
//
// Contract under test:
//   - paths resolve to $SUBCTL_CONFIG_DIR/evy/{memory,user}.md, per call
//     (the daemon re-reads tier1 every turn — env changes must be seen)
//   - default (no env) is ~/.config/subctl/evy/
//   - writes land in evy/ and never create a master/ dir
//   - a file written by the dashboard side (plain write to evy/) is read
//     back by buildMemoryBlock — the per-turn prompt injection
//   - source drift guards: neither tier1-memory.ts nor the dashboard tier1
//     block may reintroduce a master/ join or a $HOME hardcode

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildMemoryBlock,
  memoryPath,
  readMemory,
  readUser,
  tier1MemoryTools,
  userPath,
} from "../tools/tier1-memory";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

let tmpDir: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-tier1-"));
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  process.env.SUBCTL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("path resolution", () => {
  test("resolves under $SUBCTL_CONFIG_DIR/evy/ at call time", () => {
    expect(memoryPath()).toBe(join(tmpDir, "evy", "memory.md"));
    expect(userPath()).toBe(join(tmpDir, "evy", "user.md"));
    // Call-time, not module-load: repoint the env and the paths follow.
    const other = join(tmpDir, "elsewhere");
    process.env.SUBCTL_CONFIG_DIR = other;
    expect(memoryPath()).toBe(join(other, "evy", "memory.md"));
  });

  test("defaults to ~/.config/subctl/evy/ when env is unset", () => {
    delete process.env.SUBCTL_CONFIG_DIR;
    expect(memoryPath()).toBe(join(homedir(), ".config", "subctl", "evy", "memory.md"));
    expect(userPath()).toBe(join(homedir(), ".config", "subctl", "evy", "user.md"));
  });
});

describe("writes land in evy/, never master/", () => {
  test("memory_remember writes evy/memory.md", async () => {
    const r: any = await tier1MemoryTools.memory_remember.invoke({
      text: "the deploy script lives in bin/",
      source_type: "operator-asserted",
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(tmpDir, "evy", "memory.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "master"))).toBe(false);
    expect(readFileSync(join(tmpDir, "evy", "memory.md"), "utf8"))
      .toContain("[source:operator-asserted] the deploy script lives in bin/");
  });

  test("memory_user_update writes evy/user.md and reports the evy path", async () => {
    const r: any = await tier1MemoryTools.memory_user_update.invoke({
      content: "Operator: Jason. Prefers speed over ceremony.",
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(tmpDir, "evy", "user.md"));
    expect(existsSync(join(tmpDir, "master"))).toBe(false);
    expect(readUser().content).toContain("Prefers speed over ceremony");
  });
});

describe("dashboard ↔ daemon coherence (no symlink needed)", () => {
  test("a plain write to evy/ (what the dashboard endpoint does) reaches buildMemoryBlock", () => {
    // Simulate POST /api/memory/tier1 {which:"memory"} — it mkdir-p's
    // <config>/evy and writes the file directly.
    mkdirSync(join(tmpDir, "evy"), { recursive: true });
    writeFileSync(join(tmpDir, "evy", "memory.md"), "dashboard-edited fact");
    writeFileSync(join(tmpDir, "evy", "user.md"), "dashboard-edited profile");
    const block = buildMemoryBlock();
    expect(block).toContain("dashboard-edited fact");
    expect(block).toContain("dashboard-edited profile");
    expect(readMemory().exists).toBe(true);
  });
});

describe("source drift guards", () => {
  test("tier1-memory.ts never joins the legacy master/ dir", () => {
    const src = readFileSync(
      join(REPO_ROOT, "components", "evy", "tools", "tier1-memory.ts"),
      "utf8",
    );
    // Match a path-segment join on "master" (the old MASTER_DIR shape),
    // not prose mentions in comments/descriptions.
    expect(src).not.toMatch(/join\([^)]*["']master["']/);
  });

  test("dashboard tier1 block resolves via SUBCTL_CONFIG_DIR, not $HOME hardcode", () => {
    const src = readFileSync(join(REPO_ROOT, "dashboard", "server.ts"), "utf8");
    const tier1Start = src.indexOf('"/api/memory/tier1"');
    expect(tier1Start).toBeGreaterThan(-1);
    // The two tier1 handlers span well under 3000 chars; the window stops
    // before the next route block (/api/vault).
    const block = src.slice(tier1Start, src.indexOf("/api/vault", tier1Start));
    expect(block).not.toContain('.config/subctl/evy');
    expect(block).toContain('SUBCTL_CONFIG_DIR, "evy"');
  });
});
