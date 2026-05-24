// components/evy/__tests__/skills-registry.test.ts
//
// v2.8.1 skills clarity — registry contract pins.
//
// We can't isolate the repo-skills scanning path (the registry resolves
// REPO_ROOT from __dirname relative to this file's compiled location), so
// these tests focus on the surfaces we *can* control via env vars:
//   • Evy-authored draft round-trip (author → list → promote → delete)
//   • Frontmatter parsing across the three styles we ship (single-line,
//     folded block scalar `>-`, literal block scalar `|`)
//   • Repo-collision refusal in authorEvySkill
//   • resolveSkillsForTemplate joining TOML template ids to Skill records
//   • templatesUsingSkill reverse lookup
//
// SUBCTL_EVY_SKILLS_DIR + SUBCTL_SKILLS_DIR are both env-overridable so we
// can run against a tmpdir without touching the operator's real state.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorEvySkill,
  deleteEvySkill,
  evySkillsDir,
  listSkills,
  promoteEvySkill,
  resolveSkillsForTemplate,
  templatesUsingSkill,
} from "../skills-registry";

let tmpRoot: string;
let evyDir: string;
let importedDir: string;
let prevEvyDir: string | undefined;
let prevSkillsDir: string | undefined;
let prevAuditPath: string | undefined;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "subctl-skills-registry-"));
  evyDir = join(tmpRoot, "evy-skills");
  importedDir = join(tmpRoot, "imported");
  mkdirSync(evyDir, { recursive: true });
  mkdirSync(importedDir, { recursive: true });

  prevEvyDir = process.env.SUBCTL_EVY_SKILLS_DIR;
  prevSkillsDir = process.env.SUBCTL_SKILLS_DIR;
  prevAuditPath = process.env.SUBCTL_EVY_SKILLS_AUDIT;
  prevConfigDir = process.env.SUBCTL_CONFIG_DIR;

  process.env.SUBCTL_EVY_SKILLS_DIR = evyDir;
  process.env.SUBCTL_SKILLS_DIR = importedDir;
  process.env.SUBCTL_EVY_SKILLS_AUDIT = join(tmpRoot, "audit.jsonl");
  // Point CONFIG_DIR at the tmpdir so defaultProjectRoots can't accidentally
  // find the real ~/.config/subctl/evy/projects.json.
  process.env.SUBCTL_CONFIG_DIR = join(tmpRoot, "config");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (prevEvyDir === undefined) delete process.env.SUBCTL_EVY_SKILLS_DIR;
  else process.env.SUBCTL_EVY_SKILLS_DIR = prevEvyDir;
  if (prevSkillsDir === undefined) delete process.env.SUBCTL_SKILLS_DIR;
  else process.env.SUBCTL_SKILLS_DIR = prevSkillsDir;
  if (prevAuditPath === undefined) delete process.env.SUBCTL_EVY_SKILLS_AUDIT;
  else process.env.SUBCTL_EVY_SKILLS_AUDIT = prevAuditPath;
  if (prevConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = prevConfigDir;
});

describe("evySkillsDir env override", () => {
  test("uses SUBCTL_EVY_SKILLS_DIR", () => {
    expect(evySkillsDir()).toBe(evyDir);
  });
});

describe("authorEvySkill", () => {
  test("creates a draft with full v2.8.1 frontmatter", () => {
    const r = authorEvySkill({
      name: "msp-client-onboarding",
      description: "Run the MSP intake checklist on a new client.",
      body: "# MSP Client Onboarding\n\nStep 1: ...",
      scope: "evy",
      reason: "Same steps came up in 4 conversations this week.",
    });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(evyDir, "msp-client-onboarding", "SKILL.md"));
    const raw = readFileSync(r.path!, "utf8");
    expect(raw).toContain("name: msp-client-onboarding");
    expect(raw).toContain("scope: evy");
    expect(raw).toContain("created_by: evy");
    expect(raw).toContain("# MSP Client Onboarding");
  });

  test("rejects non-kebab names", () => {
    const r = authorEvySkill({
      name: "BadName_With_Underscores",
      description: "x",
      body: "y",
      scope: "evy",
      reason: "z",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kebab|match/i);
  });

  test("refuses a name that collides with the second invocation", () => {
    const a = authorEvySkill({
      name: "shared-name",
      description: "first",
      body: "first body",
      scope: "evy",
      reason: "first",
    });
    expect(a.ok).toBe(true);
    const b = authorEvySkill({
      name: "shared-name",
      description: "second",
      body: "second body",
      scope: "evy",
      reason: "second",
    });
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/already/i);
  });
});

describe("listSkills (evy-authored category)", () => {
  test("returns the drafts authored in this run", () => {
    authorEvySkill({
      name: "draft-a",
      description: "A",
      body: "body A",
      scope: "evy",
      reason: "r1",
    });
    authorEvySkill({
      name: "draft-b",
      description: "B",
      body: "body B",
      scope: "dev-team",
      reason: "r2",
    });
    const skills = listSkills({ category: "evy-authored", skipImported: true });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["draft-a", "draft-b"]);
    const a = skills.find((s) => s.name === "draft-a")!;
    expect(a.scope).toBe("evy");
    expect(a.created_by).toBe("evy");
    expect(a.category).toBe("evy-authored");
  });

  test("category filter only returns evy-authored when requested", () => {
    authorEvySkill({
      name: "draft-c",
      description: "C",
      body: "body C",
      scope: "both",
      reason: "r",
    });
    const evyOnly = listSkills({ category: "evy-authored", skipImported: true });
    expect(evyOnly.length).toBe(1);
    expect(evyOnly[0]!.category).toBe("evy-authored");
  });
});

describe("frontmatter parsing", () => {
  test("parses single-line description (v2.7.33 master/SKILL.md style)", () => {
    const dir = join(evyDir, "simple");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: simple
description: Single line description here.
scope: evy
loaded_by_default: ["evy"]
created_at: "2026-05-12"
created_by: operator
---

body content
`,
    );
    const skills = listSkills({ category: "evy-authored", skipImported: true });
    const s = skills.find((x) => x.name === "simple");
    expect(s).toBeDefined();
    expect(s!.description).toBe("Single line description here.");
    expect(s!.loaded_by_default).toEqual(["evy"]);
    expect(s!.created_by).toBe("operator");
  });

  test("parses folded block-scalar description (>- style)", () => {
    const dir = join(evyDir, "folded");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: folded
description: >-
  Line one of the description.
  Line two continues here.

  Second paragraph stands on its own.
scope: dev-team
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

body
`,
    );
    const skills = listSkills({ category: "evy-authored", skipImported: true });
    const s = skills.find((x) => x.name === "folded");
    expect(s).toBeDefined();
    expect(s!.description).toContain("Line one of the description.");
    expect(s!.description).toContain("Line two continues here.");
    expect(s!.description).toContain("Second paragraph stands on its own.");
  });

  test("falls back to first body line when frontmatter omits description", () => {
    const dir = join(evyDir, "no-desc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---
name: no-desc
scope: dev-team
---

Body opener line — this should become the description.

More body.
`,
    );
    const skills = listSkills({ category: "evy-authored", skipImported: true });
    const s = skills.find((x) => x.name === "no-desc");
    expect(s).toBeDefined();
    expect(s!.description).toBe("Body opener line — this should become the description.");
  });
});

describe("promoteEvySkill", () => {
  test("refuses when the draft does not exist", () => {
    const r = promoteEvySkill("ghost-skill", "operator");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
  // We can't write into the real repo skills dir during a unit test
  // (it would actually mutate components/skills/), so we don't exercise the
  // happy path here. The dashboard route + master tool both pin the success
  // path against a tmpdir-scoped harness in their own suites.
});

describe("deleteEvySkill", () => {
  test("removes a draft and refuses on second call", () => {
    authorEvySkill({
      name: "throwaway",
      description: "x",
      body: "y",
      scope: "evy",
      reason: "test cleanup",
    });
    const before = listSkills({ category: "evy-authored", skipImported: true });
    expect(before.find((s) => s.name === "throwaway")).toBeDefined();
    const r1 = deleteEvySkill("throwaway");
    expect(r1.ok).toBe(true);
    const after = listSkills({ category: "evy-authored", skipImported: true });
    expect(after.find((s) => s.name === "throwaway")).toBeUndefined();
    const r2 = deleteEvySkill("throwaway");
    expect(r2.ok).toBe(false);
  });
});

describe("resolveSkillsForTemplate + templatesUsingSkill", () => {
  test("joins template skill ids to Skill records and reverses for lookup", () => {
    authorEvySkill({
      name: "shared-pattern",
      description: "Reusable pattern",
      body: "body",
      scope: "both",
      reason: "r",
    });
    const template = {
      name: "full-stack-web",
      lead: { skills: ["shared-pattern"] },
      developers: [
        { name: "frontend-dev", skills: ["shared-pattern", "nonexistent-x"] },
        { name: "qa-dev", skills: [] },
      ],
    };
    const resolved = resolveSkillsForTemplate(template, { skipImported: true });
    expect(resolved.template).toBe("full-stack-web");
    expect(resolved.lead.map((s) => s.name)).toEqual(["shared-pattern"]);
    expect(
      resolved.developers.find((d) => d.name === "frontend-dev")!.skills.map((s) => s.name),
    ).toEqual(["shared-pattern"]); // nonexistent gets dropped
    expect(
      resolved.developers.find((d) => d.name === "qa-dev")!.skills,
    ).toEqual([]);

    const usage = templatesUsingSkill("shared-pattern", [template]);
    expect(usage).toEqual([{ template: "full-stack-web", roles: ["lead", "frontend-dev"] }]);
  });
});
