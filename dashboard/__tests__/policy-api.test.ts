// dashboard/__tests__/policy-api.test.ts
//
// v2.7.34 — coverage for the operator-facing Policy UI handlers. We hit the
// pure handlers from dashboard/lib/policy-api.ts directly. No HTTP server is
// booted. SUBCTL_CODE_ROOT, SUBCTL_CONFIG_DIR, SUBCTL_STATE_DIR, and
// SUBCTL_INSTALL_ROOT are overridden per-test so the operator's real disk is
// never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  chipListFromResolved,
  handleApplyPreset,
  handleGetProjectPolicy,
  handleGetUserPolicy,
  handleListPresets,
  handlePostProjectPolicy,
  handlePostUserPolicy,
  handleResolvedForProject,
  listAvailablePresets,
  resolveProjectFromName,
  validatePolicyShape,
  tomlToPolicy,
  policyToToml,
} from "../lib/policy-api";

const ORIG_ENV = { ...process.env };

let rootDir: string;
let codeDir: string;
let cfgDir: string;
let installDir: string;
let stateDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "subctl-policy-ui-"));
  codeDir = join(rootDir, "code");
  cfgDir = join(rootDir, "config");
  installDir = join(rootDir, "install");
  stateDir = join(rootDir, "state");
  mkdirSync(codeDir, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Lay down a shipped defaults.toml + a couple of presets in the install
  // tree so resolveSubctlInstall passes its sentinel check.
  const presetsDir = join(installDir, "config", "policy", "presets");
  mkdirSync(presetsDir, { recursive: true });
  writeFileSync(
    join(installDir, "config", "policy", "defaults.toml"),
    `default_mode = "gated"
preset = "generic"

[mode.gated]
[mode.gated.deny_always]
substrings = ["rm -rf /"]
`,
  );
  writeFileSync(
    join(presetsDir, "generic.toml"),
    `[mode.gated]
[mode.gated.allow]
commands = ["ls", "cat", "pwd"]
`,
  );
  writeFileSync(
    join(presetsDir, "node.toml"),
    `[mode.gated]
[mode.gated.allow]
commands = ["node", "npm"]

[mode.gated.npm]
allowed_scripts = ["test", "build"]
`,
  );

  process.env.SUBCTL_CODE_ROOT = codeDir;
  process.env.SUBCTL_CONFIG_DIR = cfgDir;
  process.env.SUBCTL_INSTALL_ROOT = installDir;
  process.env.SUBCTL_STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
  for (const k of ["SUBCTL_CODE_ROOT", "SUBCTL_CONFIG_DIR", "SUBCTL_INSTALL_ROOT", "SUBCTL_STATE_DIR"]) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k]!;
  }
});

// ---------------------------------------------------------------------------
// validatePolicyShape
// ---------------------------------------------------------------------------

describe("validatePolicyShape", () => {
  test("accepts an empty doc", () => {
    expect(validatePolicyShape({})).toEqual([]);
  });
  test("accepts a minimal valid doc", () => {
    expect(validatePolicyShape({
      preset: "node",
      default_mode: "gated",
      mode: { gated: { allow: { commands: ["ls"] } } },
    })).toEqual([]);
  });
  test("rejects unknown top-level keys", () => {
    const issues = validatePolicyShape({ rogue: 1 });
    expect(issues.length).toBe(1);
    expect(issues[0]!.field).toBe("rogue");
  });
  test("rejects invalid default_mode value", () => {
    const issues = validatePolicyShape({ default_mode: "bogus" });
    expect(issues.length).toBe(1);
    expect(issues[0]!.field).toBe("default_mode");
  });
  test("rejects array allow_pattern containing non-table (caught at depth)", () => {
    // The validator only walks one level into mode.gated and checks that
    // allow_pattern is an array; deeper-level invalidity is the engine's job.
    const issues = validatePolicyShape({ mode: { gated: { allow_pattern: "not-an-array" } } });
    expect(issues.length).toBe(1);
    expect(issues[0]!.field).toBe("mode.gated.allow_pattern");
  });
  test("rejects unknown gated keys", () => {
    const issues = validatePolicyShape({ mode: { gated: { rogue: 1 } } });
    expect(issues.length).toBe(1);
    expect(issues[0]!.field).toBe("mode.gated.rogue");
  });
});

// ---------------------------------------------------------------------------
// resolveProjectFromName
// ---------------------------------------------------------------------------

describe("resolveProjectFromName", () => {
  test("resolves a bare name to a path under SUBCTL_CODE_ROOT", () => {
    const projDir = join(codeDir, "foothold");
    mkdirSync(projDir);
    const r = resolveProjectFromName("foothold");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(projDir);
  });
  test("refuses .. traversal", () => {
    const r = resolveProjectFromName("../etc/passwd");
    expect(r.ok).toBe(false);
  });
  test("refuses paths outside code root + home", () => {
    const r = resolveProjectFromName("/var/log");
    expect(r.ok).toBe(false);
  });
  test("404s on missing project", () => {
    const r = resolveProjectFromName("does-not-exist");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// User policy round-trip
// ---------------------------------------------------------------------------

describe("user policy round-trip", () => {
  test("GET returns empty doc when file is missing", async () => {
    const res = await handleGetUserPolicy();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.exists).toBe(false);
    expect(j.doc).toEqual({});
  });

  test("POST then GET round-trips the doc", async () => {
    const post = await handlePostUserPolicy({
      doc: { preset: "node", default_mode: "gated", mode: { gated: { allow: { commands: ["ls"] } } } },
    });
    const jp = await post.json();
    expect(jp.ok).toBe(true);
    expect(jp.bytes).toBeGreaterThan(0);

    const get = await handleGetUserPolicy();
    const jg = await get.json();
    expect(jg.ok).toBe(true);
    expect(jg.exists).toBe(true);
    expect(jg.doc.preset).toBe("node");
    expect(jg.doc.default_mode).toBe("gated");
    expect(jg.doc.mode.gated.allow.commands).toEqual(["ls"]);
  });

  test("POST rejects invalid TOML body", async () => {
    const res = await handlePostUserPolicy({ toml: "preset = =" });
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  test("POST rejects schema-invalid doc", async () => {
    const res = await handlePostUserPolicy({ doc: { default_mode: "bogus" } });
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/default_mode/);
  });
});

// ---------------------------------------------------------------------------
// Project policy round-trip
// ---------------------------------------------------------------------------

describe("project policy round-trip", () => {
  test("GET returns empty when project has no policy", async () => {
    mkdirSync(join(codeDir, "myproj"));
    const res = await handleGetProjectPolicy("myproj");
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.exists).toBe(false);
  });

  test("POST writes to <project>/.subctl/policy.toml", async () => {
    mkdirSync(join(codeDir, "myproj"));
    const post = await handlePostProjectPolicy("myproj", {
      doc: { mode: { gated: { allow: { commands: ["pwd"] } } } },
    });
    const jp = await post.json();
    expect(jp.ok).toBe(true);
    expect(jp.path).toBe(join(codeDir, "myproj", ".subctl", "policy.toml"));
    // Verify the file was actually written.
    const text = readFileSync(jp.path, "utf8");
    expect(text).toContain("commands");
  });

  test("POST refuses traversal", async () => {
    const res = await handlePostProjectPolicy("../etc", { doc: {} });
    const j = await res.json();
    expect(j.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Apply preset
// ---------------------------------------------------------------------------

describe("apply preset", () => {
  test("writes preset = '<name>' to the project policy", async () => {
    mkdirSync(join(codeDir, "myproj"));
    const res = await handleApplyPreset("myproj", { preset: "node" });
    const j = await res.json();
    expect(j.ok).toBe(true);
    const path = join(codeDir, "myproj", ".subctl", "policy.toml");
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/preset\s*=\s*"node"/);
  });

  test("rejects unknown preset", async () => {
    mkdirSync(join(codeDir, "myproj"));
    const res = await handleApplyPreset("myproj", { preset: "rust" });
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/unknown preset/);
    expect(j.known).toEqual(expect.arrayContaining(["generic", "node"]));
  });

  test("missing preset name → 400", async () => {
    mkdirSync(join(codeDir, "myproj"));
    const res = await handleApplyPreset("myproj", {});
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// List presets
// ---------------------------------------------------------------------------

describe("list presets", () => {
  test("enumerates *.toml files under config/policy/presets", () => {
    const list = listAvailablePresets();
    expect(list.sort()).toEqual(["generic", "node"]);
  });
  test("handler returns the same list", async () => {
    const res = await handleListPresets();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.presets).toEqual(["generic", "node"]);
  });
});

// ---------------------------------------------------------------------------
// Resolved chip list
// ---------------------------------------------------------------------------

describe("chipListFromResolved", () => {
  test("emits command + pattern + deny + ecosystem chips", () => {
    const doc = {
      mode: {
        gated: {
          allow: { commands: ["ls", "cat"] },
          allow_pattern: [
            { command: "git", args: ["status", "diff"] },
            { command: "npm", args: ["install"], deny_if_arg_contains: ["--ignore-scripts=false"] },
          ],
          deny_always: {
            substrings: ["rm -rf /"],
            regex: ["\\bnode\\s+-e\\b"],
          },
          npm: { allowed_scripts: ["test", "build"] },
        },
      },
      preset: "node",
      __meta: {
        sourcePaths: [
          "/tmp/proj/.subctl/policy.toml",
          "/tmp/install/config/policy/presets/node.toml",
          "/tmp/install/config/policy/defaults.toml",
        ],
        allowlistSha: "abc12345",
        resolvedAt: "2026-05-13T00:00:00.000Z",
      },
    } as any;
    const chips = chipListFromResolved(doc, "/tmp/proj");
    expect(chips.ok).toBe(true);
    expect(chips.mode).toBe("gated");
    expect(chips.preset).toBe("node");
    expect(chips.allowlist_sha).toBe("abc12345");
    const kinds = chips.chips.map((c) => c.kind);
    expect(kinds.filter((k) => k === "command").length).toBe(2);
    expect(kinds.filter((k) => k === "pattern").length).toBe(2);
    expect(kinds.filter((k) => k === "deny").length).toBe(1);
    expect(kinds.filter((k) => k === "deny_regex").length).toBe(1);
    expect(kinds.filter((k) => k === "ecosystem").length).toBe(1);
    // Pattern label sanity
    const gitPat = chips.chips.find((c) => c.label.startsWith("git:"));
    expect(gitPat?.label).toBe("git:status,diff");
    // Ecosystem label sanity
    const npmEco = chips.chips.find((c) => c.kind === "ecosystem");
    expect(npmEco?.label).toBe("npm:test,build");
    // Rule path on the second pattern reflects array index.
    const npmPat = chips.chips.find((c) => c.label.startsWith("npm:install"));
    expect(npmPat?.rule_path).toBe("mode.gated.allow_pattern[1]");
  });

  test("returns empty chip list when policy is empty", () => {
    const chips = chipListFromResolved({ mode: {} } as any, "/tmp/proj");
    expect(chips.chips.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resolved-for-project end-to-end
// ---------------------------------------------------------------------------

describe("handleResolvedForProject", () => {
  test("resolves a project and returns chip-list shape", async () => {
    const proj = join(codeDir, "myproj");
    mkdirSync(join(proj, ".subctl"), { recursive: true });
    writeFileSync(
      join(proj, ".subctl", "policy.toml"),
      `preset = "node"
[mode.gated]
[mode.gated.allow]
commands = ["fd"]
`,
    );
    const res = await handleResolvedForProject("myproj");
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.preset).toBe("node");
    // Should include the project's "fd" + the node preset commands + defaults
    // deny.
    const labels = j.chips.map((c: any) => c.label);
    expect(labels).toContain("fd");
    expect(labels).toContain("node");
    expect(labels).toContain("npm");
    // Deny chip from defaults preset chain.
    expect(labels).toContain("rm -rf /");
    // Ecosystem chip from preset.
    expect(labels.some((l: string) => l.startsWith("npm:"))).toBe(true);
  });

  test("400s on bad project name", async () => {
    const res = await handleResolvedForProject("../escape");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// TOML round-trip helpers
// ---------------------------------------------------------------------------

describe("TOML helpers", () => {
  test("tomlToPolicy parses an empty doc", () => {
    const doc = tomlToPolicy("");
    expect(doc).toEqual({});
  });
  test("policyToToml + tomlToPolicy round-trip a non-trivial doc", () => {
    const doc = {
      preset: "node",
      default_mode: "gated",
      mode: { gated: { allow: { commands: ["ls"] }, allow_pattern: [{ command: "git", args: ["status"] }] } },
    };
    const toml = policyToToml(doc);
    const back = tomlToPolicy(toml);
    expect(back.preset).toBe("node");
    expect(back.default_mode).toBe("gated");
    expect((back as any).mode.gated.allow.commands).toEqual(["ls"]);
    expect((back as any).mode.gated.allow_pattern[0].command).toBe("git");
  });
  test("policyToToml strips __meta", () => {
    const toml = policyToToml({ preset: "node", __meta: { sourcePaths: [], allowlistSha: "x", resolvedAt: "" } } as any);
    expect(toml).not.toContain("__meta");
  });
});
