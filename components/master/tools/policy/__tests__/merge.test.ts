// components/master/tools/policy/__tests__/merge.test.ts
//
// Pure-function tests for `mergePolicies()`. Stays clear of I/O (load.test.ts
// owns that surface) and exercises the merge semantics directly:
//   - additive arrays (pack 02 §6)
//   - REPLACE ecosystem-specific arrays (pack 03 §5)
//   - REPLACE scalars (preset, default_mode)
//   - end-to-end resolved chain with preset = "none" via loadResolvedPolicy

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadResolvedPolicy, mergePolicies } from "../load";
import type { PolicyDocument } from "../types";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const ORIG_SUBCTL_CONFIG_DIR = process.env.SUBCTL_CONFIG_DIR;

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `subctl-policy-merge-${prefix}-`));
}

function withFile(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
}

// ---------------------------------------------------------------------------
// Pure mergePolicies() — no I/O
// ---------------------------------------------------------------------------

describe("mergePolicies — pure", () => {
  test("empty project + preset → preset wins all", () => {
    const project: Partial<PolicyDocument> = { preset: "node" };
    const preset: Partial<PolicyDocument> = {
      mode: {
        gated: {
          allow: { commands: ["git", "ls"] },
          allow_pattern: [{ command: "npm", args: ["install"] }],
          npm: { allowed_scripts: ["test", "build"] },
        },
      },
    };

    // mergePolicies is documented as "highest-priority first"
    const merged = mergePolicies(project, preset);
    expect(merged.preset).toBe("node");
    expect(merged.mode.gated?.allow?.commands).toEqual(["git", "ls"]);
    expect(merged.mode.gated?.allow_pattern).toEqual([{ command: "npm", args: ["install"] }]);
    expect(merged.mode.gated?.npm?.allowed_scripts).toEqual(["test", "build"]);
  });

  test("project adds allow_pattern → preset + project appended (order preserved, project last)", () => {
    const project: Partial<PolicyDocument> = {
      mode: {
        gated: {
          allow_pattern: [{ command: "gh", args: ["issue"] }],
        },
      },
    };
    const preset: Partial<PolicyDocument> = {
      mode: {
        gated: {
          allow_pattern: [
            { command: "npm", args: ["install"] },
            { command: "git", args: ["status"] },
          ],
        },
      },
    };

    const merged = mergePolicies(project, preset);
    // Lower-priority (preset) first, project last.
    expect(merged.mode.gated?.allow_pattern).toEqual([
      { command: "npm", args: ["install"] },
      { command: "git", args: ["status"] },
      { command: "gh", args: ["issue"] },
    ]);
  });

  test("project overrides npm.allowed_scripts → project's list ONLY (REPLACE, not extend)", () => {
    const project: Partial<PolicyDocument> = {
      mode: {
        gated: { npm: { allowed_scripts: ["deploy:staging", "migrate:up"] } },
      },
    };
    const preset: Partial<PolicyDocument> = {
      mode: {
        gated: {
          npm: { allowed_scripts: ["test", "build", "lint", "format", "dev"] },
        },
      },
    };

    const merged = mergePolicies(project, preset);
    expect(merged.mode.gated?.npm?.allowed_scripts).toEqual(["deploy:staging", "migrate:up"]);
    expect(merged.mode.gated?.npm?.allowed_scripts.length).toBe(2);
  });

  test("user default_mode='trusted' + project default_mode='gated' → project wins (priority 1 vs 3)", () => {
    const project: Partial<PolicyDocument> = { default_mode: "gated" };
    const user: Partial<PolicyDocument> = { default_mode: "trusted" };
    const defaults: Partial<PolicyDocument> = { default_mode: "gated" };

    // chain order: project (highest), user, defaults
    const merged = mergePolicies(project, user, defaults);
    expect(merged.default_mode).toBe("gated");
  });

  test("deny_always.substrings accumulates additively across the full chain", () => {
    const project: Partial<PolicyDocument> = {
      mode: { gated: { deny_always: { substrings: ["aws "] } } },
    };
    const user: Partial<PolicyDocument> = {
      mode: { gated: { deny_always: { substrings: ["kubectl delete "] } } },
    };
    const preset: Partial<PolicyDocument> = {
      mode: { gated: { deny_always: { substrings: ["rm -rf"] } } },
    };
    const defaults: Partial<PolicyDocument> = {
      mode: { gated: { deny_always: { substrings: [":(){:|:&};:"] } } },
    };

    const merged = mergePolicies(project, user, preset, defaults);
    expect(merged.mode.gated?.deny_always?.substrings).toEqual([
      ":(){:|:&};:",        // defaults — lowest priority, comes first
      "rm -rf",             // preset
      "kubectl delete ",    // user
      "aws ",               // project — highest priority, lands LAST
    ]);
  });

  test("REPLACE applies to every ecosystem-specific table independently", () => {
    const project: Partial<PolicyDocument> = {
      mode: {
        gated: {
          // Only override pnpm; preset's npm/bun/yarn/etc. should survive.
          pnpm: { allowed_scripts: ["custom"] },
        },
      },
    };
    const preset: Partial<PolicyDocument> = {
      mode: {
        gated: {
          npm: { allowed_scripts: ["test"] },
          pnpm: { allowed_scripts: ["test", "build"] },
          bun: { allowed_scripts: ["test"] },
          make: { allowed_targets: ["test"] },
          just: { allowed_recipes: ["test"] },
          python_modules: { allowed: ["pytest"] },
          uv: { allowed_run_targets: ["pytest"] },
          poetry: { allowed_run_targets: ["pytest"] },
        },
      },
    };

    const merged = mergePolicies(project, preset);
    // pnpm REPLACED to ["custom"].
    expect(merged.mode.gated?.pnpm?.allowed_scripts).toEqual(["custom"]);
    // All the other ecosystem tables come from preset untouched.
    expect(merged.mode.gated?.npm?.allowed_scripts).toEqual(["test"]);
    expect(merged.mode.gated?.bun?.allowed_scripts).toEqual(["test"]);
    expect(merged.mode.gated?.make?.allowed_targets).toEqual(["test"]);
    expect(merged.mode.gated?.just?.allowed_recipes).toEqual(["test"]);
    expect(merged.mode.gated?.python_modules?.allowed).toEqual(["pytest"]);
    expect(merged.mode.gated?.uv?.allowed_run_targets).toEqual(["pytest"]);
    expect(merged.mode.gated?.poetry?.allowed_run_targets).toEqual(["pytest"]);
  });

  test("allow.commands additive (preset + project), preserves order", () => {
    const project: Partial<PolicyDocument> = {
      mode: { gated: { allow: { commands: ["tree"] } } },
    };
    const preset: Partial<PolicyDocument> = {
      mode: { gated: { allow: { commands: ["pwd", "ls"] } } },
    };
    const merged = mergePolicies(project, preset);
    expect(merged.mode.gated?.allow?.commands).toEqual(["pwd", "ls", "tree"]);
  });

  test("sealed and trusted scalar replace — last (highest-priority) doc with the field wins", () => {
    const project: Partial<PolicyDocument> = {
      mode: { sealed: { mcp_tools: ["fs_read"], test_command: "npm test" } },
    };
    const preset: Partial<PolicyDocument> = {
      mode: { sealed: { mcp_tools: ["whatever"], test_command: "pytest" } },
    };
    const merged = mergePolicies(project, preset);
    // Sealed is a per-mode block; highest-priority wins wholesale.
    expect(merged.mode.sealed?.mcp_tools).toEqual(["fs_read"]);
    expect(merged.mode.sealed?.test_command).toBe("npm test");
  });
});

// ---------------------------------------------------------------------------
// End-to-end via loadResolvedPolicy — preset = "none" branch
// ---------------------------------------------------------------------------

describe("merge — preset = 'none' end-to-end via fixtures", () => {
  let project: string;
  let cfg: string;
  beforeEach(() => {
    project = tempRoot("none");
    cfg = tempRoot("noneCfg");
    process.env.SUBCTL_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
    if (ORIG_SUBCTL_CONFIG_DIR === undefined) delete process.env.SUBCTL_CONFIG_DIR;
    else process.env.SUBCTL_CONFIG_DIR = ORIG_SUBCTL_CONFIG_DIR;
  });

  test("preset='none' → no preset inheritance, no shipped-defaults inheritance, only project inline", async () => {
    withFile(
      project,
      ".subctl/policy.toml",
      readFileSync(join(FIXTURE_DIR, "project-preset-none.toml"), "utf8"),
    );

    const resolved = await loadResolvedPolicy(project);

    // Just the project's two allow.commands — no preset list, no defaults list.
    expect(resolved.mode.gated?.allow?.commands).toEqual(["pwd", "echo"]);

    // Just one allow_pattern entry — the project's git status.
    expect(resolved.mode.gated?.allow_pattern).toEqual([{ command: "git", args: ["status"] }]);

    // deny_always.substrings is ONLY the project's "sudo " — defaults' nuke list absent.
    expect(resolved.mode.gated?.deny_always?.substrings).toEqual(["sudo "]);

    // defaults' regex inline-interpreter rules are absent.
    expect(resolved.mode.gated?.deny_always?.regex ?? []).toEqual([]);

    // No ecosystem-specific tables (project didn't declare any; defaults doesn't have any).
    expect(resolved.mode.gated?.npm).toBeUndefined();
    expect(resolved.mode.gated?.pnpm).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end via loadResolvedPolicy — REPLACE on real shipped node preset
// ---------------------------------------------------------------------------

describe("merge — REPLACE applies through the real shipped node preset", () => {
  let project: string;
  let cfg: string;
  beforeEach(() => {
    project = tempRoot("realnode");
    cfg = tempRoot("realnodeCfg");
    process.env.SUBCTL_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
    if (ORIG_SUBCTL_CONFIG_DIR === undefined) delete process.env.SUBCTL_CONFIG_DIR;
    else process.env.SUBCTL_CONFIG_DIR = ORIG_SUBCTL_CONFIG_DIR;
  });

  test("project's npm.allowed_scripts wholly replaces the node preset's larger list", async () => {
    withFile(
      project,
      ".subctl/policy.toml",
      readFileSync(join(FIXTURE_DIR, "project-overrides-npm-scripts.toml"), "utf8"),
    );

    const resolved = await loadResolvedPolicy(project);
    expect(resolved.mode.gated?.npm?.allowed_scripts).toEqual([
      "deploy:staging",
      "migrate:up",
    ]);
    // Other arrays (allow_pattern) remain inherited from the node preset and accumulate.
    const allowPatterns = resolved.mode.gated?.allow_pattern ?? [];
    expect(allowPatterns.some((p) => p.command === "npm")).toBe(true);
    expect(allowPatterns.some((p) => p.command === "git")).toBe(true);
  });
});
