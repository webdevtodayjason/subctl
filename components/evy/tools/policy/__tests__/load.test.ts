// components/master/tools/policy/__tests__/load.test.ts
//
// End-to-end load + resolve tests. Stays clear of `mergePolicies` purity
// tests (those live in merge.test.ts) and focuses on the I/O contract:
//   - what happens when files are missing
//   - what happens when files are malformed
//   - what happens when files are real (smoke against the shipped presets)
//   - what happens end-to-end with fixtures on disk
//
// Bun's `test.ts` runner picks this up via `bun test` (we don't introduce
// vitest/jest per the PR 4 brief).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeAllowlistSha,
  loadPreset,
  loadProjectPolicy,
  loadResolvedPolicy,
  loadShippedDefaults,
  loadUserPolicy,
  resolveSubctlInstall,
} from "../load";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

// Snapshot envs so we can mutate them per-test then restore.
const ORIG_SUBCTL_CONFIG_DIR = process.env.SUBCTL_CONFIG_DIR;
const ORIG_SUBCTL_INSTALL_ROOT = process.env.SUBCTL_INSTALL_ROOT;

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `subctl-policy-${prefix}-`));
}

function withFile(root: string, rel: string, body: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
}

describe("loadProjectPolicy", () => {
  let project: string;
  beforeEach(() => {
    project = makeTempRoot("loadProject");
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("returns null when neither policy.toml nor policy.local.toml exists", async () => {
    const doc = await loadProjectPolicy(project);
    expect(doc).toBeNull();
  });

  test("reads policy.toml when only committed file is present", async () => {
    withFile(project, ".subctl/policy.toml", `preset = "node"\n`);
    const doc = await loadProjectPolicy(project);
    expect(doc).not.toBeNull();
    expect(doc?.preset).toBe("node");
  });

  test("merges policy.toml over policy.local.toml — committed wins", async () => {
    withFile(project, ".subctl/policy.toml", `default_mode = "gated"\n`);
    withFile(project, ".subctl/policy.local.toml", `default_mode = "trusted"\n`);
    const doc = await loadProjectPolicy(project);
    // priority 1 (committed) wins over priority 2 (local).
    expect(doc?.default_mode).toBe("gated");
  });
});

describe("loadUserPolicy", () => {
  let cfg: string;
  beforeEach(() => {
    cfg = makeTempRoot("userCfg");
    process.env.SUBCTL_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    if (ORIG_SUBCTL_CONFIG_DIR === undefined) delete process.env.SUBCTL_CONFIG_DIR;
    else process.env.SUBCTL_CONFIG_DIR = ORIG_SUBCTL_CONFIG_DIR;
  });

  test("returns null when ~/.config/subctl/policy.toml is missing", async () => {
    const doc = await loadUserPolicy();
    expect(doc).toBeNull();
  });

  test("returns the parsed doc when the user config file exists", async () => {
    // Copy the shipped fixture into the temp user config dir.
    const body = readFileSync(join(FIXTURE_DIR, "user-config-example.toml"), "utf8");
    writeFileSync(join(cfg, "policy.toml"), body, "utf8");
    const doc = await loadUserPolicy();
    expect(doc).not.toBeNull();
    expect(doc?.default_mode).toBe("trusted");
  });
});

describe("loadShippedDefaults + loadPreset", () => {
  test("shipped defaults are always present and well-formed (smoke)", async () => {
    const doc = await loadShippedDefaults();
    expect(doc).toBeDefined();
    expect(doc.default_mode).toBe("gated");
    expect(doc.mode.gated).toBeDefined();
    expect(Array.isArray(doc.mode.gated?.deny_always?.regex)).toBe(true);
  });

  test("loadPreset('node') reads the real preset and has expected shape", async () => {
    const doc = await loadPreset("node");
    expect(doc.mode?.gated).toBeDefined();
    // The node preset's allow_pattern array carries the npm entry.
    const patterns = doc.mode?.gated?.allow_pattern ?? [];
    const npmEntry = patterns.find((p) => p.command === "npm");
    expect(npmEntry).toBeDefined();
    expect(npmEntry?.args).toContain("install");
    // And the ecosystem-specific npm.allowed_scripts list is populated.
    expect(doc.mode?.gated?.npm?.allowed_scripts).toContain("test");
  });

  test("loadPreset('none') throws — caller must skip the preset chain", async () => {
    await expect(loadPreset("none")).rejects.toThrow(/preset "none"/);
  });

  test("loadPreset of a non-existent name throws a descriptive error", async () => {
    await expect(loadPreset("not-a-real-preset")).rejects.toThrow(/not found/);
  });
});

describe("malformed input", () => {
  let project: string;
  beforeEach(() => {
    project = makeTempRoot("malformed");
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  test("invalid TOML in a project policy file surfaces a descriptive error", async () => {
    withFile(project, ".subctl/policy.toml", `this is = not = valid toml\n`);
    await expect(loadProjectPolicy(project)).rejects.toThrow(/invalid TOML/);
  });
});

describe("resolveSubctlInstall", () => {
  test("anchors to the real subctl repo by default", () => {
    delete process.env.SUBCTL_INSTALL_ROOT;
    const root = resolveSubctlInstall();
    // We're inside <subctl>/components/master/tools/policy/__tests__/, so the
    // resolved root must contain config/policy/defaults.toml.
    const defaultsExists = readFileSync(
      join(root, "config", "policy", "defaults.toml"),
      "utf8",
    );
    expect(defaultsExists).toContain("default_mode");
    if (ORIG_SUBCTL_INSTALL_ROOT !== undefined) {
      process.env.SUBCTL_INSTALL_ROOT = ORIG_SUBCTL_INSTALL_ROOT;
    }
  });

  test("respects SUBCTL_INSTALL_ROOT override when set", () => {
    process.env.SUBCTL_INSTALL_ROOT = "/some/fake/path";
    expect(resolveSubctlInstall()).toBe("/some/fake/path");
    if (ORIG_SUBCTL_INSTALL_ROOT === undefined) delete process.env.SUBCTL_INSTALL_ROOT;
    else process.env.SUBCTL_INSTALL_ROOT = ORIG_SUBCTL_INSTALL_ROOT;
  });
});

describe("loadResolvedPolicy (end-to-end)", () => {
  let project: string;
  let cfg: string;
  beforeEach(() => {
    project = makeTempRoot("resolved");
    cfg = makeTempRoot("resolvedCfg");
    process.env.SUBCTL_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
    if (ORIG_SUBCTL_CONFIG_DIR === undefined) delete process.env.SUBCTL_CONFIG_DIR;
    else process.env.SUBCTL_CONFIG_DIR = ORIG_SUBCTL_CONFIG_DIR;
  });

  test("empty project + no user → shipped defaults + (no) preset only", async () => {
    // empty.toml has no preset, no default_mode override
    withFile(
      project,
      ".subctl/policy.toml",
      readFileSync(join(FIXTURE_DIR, "empty.toml"), "utf8"),
    );
    const resolved = await loadResolvedPolicy(project);
    // defaults.toml sets default_mode = "gated"; nothing else in the chain
    expect(resolved.default_mode).toBe("gated");
    expect(resolved.__meta).toBeDefined();
    expect(resolved.__meta?.allowlistSha).toMatch(/^[0-9a-f]{8}$/);
    expect(resolved.__meta?.sourcePaths.length).toBeGreaterThan(0);
    // The default deny_always.regex from defaults.toml is present.
    expect(resolved.mode.gated?.deny_always?.regex ?? []).toContain('\\bnode\\s+-e\\b');
  });

  test("project with extra allow_pattern → preset + project both present, project last", async () => {
    withFile(
      project,
      ".subctl/policy.toml",
      readFileSync(join(FIXTURE_DIR, "project-with-extra-allow.toml"), "utf8"),
    );
    const resolved = await loadResolvedPolicy(project);
    // The node preset's `gh repo|pr|issue|release|...` allow_pattern must be present.
    const allPatterns = resolved.mode.gated?.allow_pattern ?? [];
    expect(allPatterns.length).toBeGreaterThan(5);
    // Project's specific entry — command=gh, args=["issue"] — must be the LAST one.
    const last = allPatterns[allPatterns.length - 1];
    expect(last?.command).toBe("gh");
    expect(last?.args).toEqual(["issue"]);
    // sourcePaths includes the project file + preset + defaults.
    expect(resolved.__meta?.sourcePaths.some((p) => p.endsWith(".subctl/policy.toml"))).toBe(true);
    expect(resolved.__meta?.sourcePaths.some((p) => p.endsWith("presets/node.toml"))).toBe(true);
    expect(resolved.__meta?.sourcePaths.some((p) => p.endsWith("defaults.toml"))).toBe(true);
  });

  test("preset = 'none' skips preset AND defaults — only project's inline content", async () => {
    withFile(
      project,
      ".subctl/policy.toml",
      readFileSync(join(FIXTURE_DIR, "project-preset-none.toml"), "utf8"),
    );
    const resolved = await loadResolvedPolicy(project);
    // Project's only patterns survive; no preset's npm entry, no defaults' regex.
    const patterns = resolved.mode.gated?.allow_pattern ?? [];
    expect(patterns).toEqual([{ command: "git", args: ["status"] }]);
    // defaults' regex deny set must NOT be present.
    expect(resolved.mode.gated?.deny_always?.regex ?? []).toEqual([]);
    // Project's deny substring IS present.
    expect(resolved.mode.gated?.deny_always?.substrings ?? []).toEqual(["sudo "]);
    // The literal "none" preset value is stripped before snapshot.
    expect(resolved.preset).toBeUndefined();
    // sourcePaths references only the project file.
    expect(resolved.__meta?.sourcePaths.length).toBe(1);
    expect(resolved.__meta?.sourcePaths[0]).toMatch(/policy\.toml$/);
  });

  test("__meta.resolvedAt is a valid ISO 8601 string", async () => {
    withFile(project, ".subctl/policy.toml", `preset = "node"\n`);
    const resolved = await loadResolvedPolicy(project);
    const ts = resolved.__meta?.resolvedAt ?? "";
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // and Date.parse round-trips
    expect(Number.isFinite(Date.parse(ts))).toBe(true);
  });

  test("computeAllowlistSha is deterministic and excludes __meta", async () => {
    withFile(project, ".subctl/policy.toml", `preset = "node"\n`);
    const a = await loadResolvedPolicy(project);
    const b = await loadResolvedPolicy(project);
    // Same content → same sha even though resolvedAt differs.
    expect(a.__meta?.allowlistSha).toBe(b.__meta?.allowlistSha);
    // Recompute manually without the __meta — must agree.
    const stripped = { ...a, __meta: undefined } as typeof a;
    delete (stripped as { __meta?: unknown }).__meta;
    expect(computeAllowlistSha(stripped)).toBe(a.__meta?.allowlistSha);
  });
});
