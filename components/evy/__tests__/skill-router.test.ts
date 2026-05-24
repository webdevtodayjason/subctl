// components/evy/__tests__/skill-router.test.ts
//
// v2.8.1 — Pin the skill-router contract. Tests cover:
//   1. Frontmatter parsing (folded scalars, inline arrays, hyphen lists)
//   2. Tokenization + stopword filtering
//   3. selectSkills with router DISABLED → empty selection
//   4. selectSkills with router ENABLED → always-load floor + top-K
//      + ecosystem-routed domain skill
//   5. Short-message fast-path → floor only
//   6. Cache invalidation on SKILL.md mtime bump

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _clearCacheForTesting,
  detectEcosystem,
  isRouterEnabled,
  loadCatalog,
  parseFrontmatter,
  renderSelected,
  selectSkills,
  tokenize,
} from "../skill-router";

let tmpDir: string;
let skillsRoot: string;
let flagPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "skill-router-test-"));
  skillsRoot = join(tmpDir, "skills");
  flagPath = join(tmpDir, "skill-router.enabled");
  mkdirSync(skillsRoot, { recursive: true });
  _clearCacheForTesting();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeSkill(name: string, fm: string, body = "skill body for " + name) {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n${body}\n`);
}

describe("parseFrontmatter", () => {
  test("parses inline scalars", () => {
    const { fm } = parseFrontmatter(
      `---\nname: foo\ndescription: a bar baz skill\n---\nbody`,
    );
    expect(fm.name).toBe("foo");
    expect(fm.description).toBe("a bar baz skill");
  });

  test("parses folded (>-) descriptions", () => {
    const raw =
      "---\nname: subctl\ndescription: >-\n  Subscription Central — multi-account\n  AI subscription orchestration toolkit.\nkeywords: [team, spawn, dispatch]\n---\nbody";
    const { fm, body } = parseFrontmatter(raw);
    expect(fm.name).toBe("subctl");
    expect(fm.description).toContain("Subscription Central");
    expect(fm.description).toContain("orchestration toolkit");
    expect(fm.keywords).toEqual(["team", "spawn", "dispatch"]);
    expect(body.trim()).toBe("body");
  });

  test("parses hyphen-list keywords", () => {
    const raw =
      "---\nname: x\ndescription: y\nkeywords:\n  - alpha\n  - beta gamma\n  - delta\n---\nbody";
    const { fm } = parseFrontmatter(raw);
    expect(fm.keywords).toEqual(["alpha", "beta gamma", "delta"]);
  });

  test("handles missing frontmatter gracefully", () => {
    const { fm, body } = parseFrontmatter("no frontmatter here");
    expect(fm.name).toBe("");
    expect(body).toBe("no frontmatter here");
  });
});

describe("tokenize", () => {
  test("lowercases + splits on non-alphanumerics", () => {
    const t = tokenize("Spawn a Node team for Server.TS");
    expect(t.has("spawn")).toBe(true);
    expect(t.has("node")).toBe(true);
    expect(t.has("team")).toBe(true);
    expect(t.has("server")).toBe(true);
    expect(t.has("ts")).toBe(true);
  });

  test("strips stopwords + short tokens", () => {
    const t = tokenize("the a of about evy subctl is here");
    expect(t.has("the")).toBe(false);
    expect(t.has("a")).toBe(false);
    expect(t.has("evy")).toBe(false); // explicit stopword (operator says it a lot)
    expect(t.has("here")).toBe(true);
  });
});

describe("detectEcosystem", () => {
  test("node from package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    expect(detectEcosystem(tmpDir)).toBe("node");
  });

  test("python from pyproject.toml", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "");
    expect(detectEcosystem(tmpDir)).toBe("python");
  });

  test("rust from Cargo.toml", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "");
    expect(detectEcosystem(tmpDir)).toBe("rust");
  });

  test("null when no markers", () => {
    expect(detectEcosystem(tmpDir)).toBeNull();
  });
});

describe("isRouterEnabled", () => {
  test("false when flag absent", () => {
    expect(isRouterEnabled(flagPath)).toBe(false);
  });

  test("true when flag present (any content)", () => {
    writeFileSync(flagPath, "");
    expect(isRouterEnabled(flagPath)).toBe(true);
  });
});

describe("selectSkills", () => {
  beforeEach(() => {
    writeSkill(
      "subctl-team-protocol",
      `name: subctl-team-protocol\ndescription: wire protocol for spawned workers`,
    );
    writeSkill(
      "handoff-protocol",
      `name: handoff-protocol\ndescription: how to hand off mid-flight`,
    );
    writeSkill(
      "node-conventions",
      `name: node-conventions\ndescription: node bun typescript house style\nkeywords: [node, bun, typescript]`,
    );
    writeSkill(
      "python-conventions",
      `name: python-conventions\ndescription: python tooling uv ruff pytest\nkeywords: [python, uv, ruff, pytest]`,
    );
    writeSkill(
      "rust-conventions",
      `name: rust-conventions\ndescription: rust tooling cargo clippy thiserror\nkeywords: [rust, cargo, clippy]`,
    );
    writeSkill(
      "spec-driven-dev",
      `name: spec-driven-dev\ndescription: execute against a written specification\nkeywords: [spec, specification, requirements, plan]`,
    );
    writeSkill(
      "orchestrator-mode",
      `name: orchestrator-mode\ndescription: switch claude into multi-pane orchestrator workflow\nkeywords: [orchestrator, panes, tmux, workers]`,
    );
  });

  test("disabled router returns empty selection", () => {
    const d = selectSkills("anything", { skillsRoot, flagPath });
    expect(d.enabled).toBe(false);
    expect(d.selected).toEqual([]);
  });

  test("enabled router loads always-load floor + top-K", () => {
    writeFileSync(flagPath, "");
    const d = selectSkills(
      "please write a specification for the new feature plan",
      { skillsRoot, flagPath, cwd: tmpDir },
    );
    expect(d.enabled).toBe(true);
    const names = d.selected.map((s) => s.name);
    expect(names).toContain("subctl-team-protocol");
    expect(names).toContain("handoff-protocol");
    expect(names).toContain("spec-driven-dev");
  });

  test("enabled router routes domain skill by cwd ecosystem", () => {
    writeFileSync(flagPath, "");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    const d = selectSkills("hello there friend", {
      skillsRoot,
      flagPath,
      cwd: tmpDir,
    });
    const names = d.selected.map((s) => s.name);
    expect(names).toContain("node-conventions");
    expect(names).not.toContain("python-conventions");
    expect(names).not.toContain("rust-conventions");
  });

  test("enabled router skips domain skill when no ecosystem marker", () => {
    writeFileSync(flagPath, "");
    const d = selectSkills("hello there friend", {
      skillsRoot,
      flagPath,
      cwd: tmpDir,
    });
    const names = d.selected.map((s) => s.name);
    expect(names).not.toContain("node-conventions");
    expect(names).not.toContain("python-conventions");
    expect(names).not.toContain("rust-conventions");
  });

  test("short-message fast-path returns floor only", () => {
    writeFileSync(flagPath, "");
    const d = selectSkills("hi", { skillsRoot, flagPath, cwd: tmpDir });
    expect(d.enabled).toBe(true);
    expect(d.reason).toContain("short message");
    const names = d.selected.map((s) => s.name);
    expect(names).toContain("subctl-team-protocol");
    expect(names).toContain("handoff-protocol");
    expect(names).not.toContain("spec-driven-dev");
  });

  test("scoring trace is sorted by score descending", () => {
    writeFileSync(flagPath, "");
    const d = selectSkills(
      "I need an orchestrator with tmux panes to coordinate workers",
      { skillsRoot, flagPath, cwd: tmpDir },
    );
    for (let i = 1; i < d.trace.length; i++) {
      expect(d.trace[i - 1]!.score).toBeGreaterThanOrEqual(d.trace[i]!.score);
    }
    // orchestrator-mode should score above spec-driven-dev for this msg
    const orchTrace = d.trace.find((t) => t.skill === "orchestrator-mode");
    const specTrace = d.trace.find((t) => t.skill === "spec-driven-dev");
    expect(orchTrace).toBeDefined();
    expect(specTrace).toBeDefined();
    expect(orchTrace!.score).toBeGreaterThan(specTrace!.score);
  });

  test("renders selected skills as fenced <skill> blocks", () => {
    writeFileSync(flagPath, "");
    const d = selectSkills(
      "spec workflow please",
      { skillsRoot, flagPath, cwd: tmpDir },
    );
    const rendered = renderSelected(d.selected);
    expect(rendered).toContain("<skill name=\"subctl-team-protocol\">");
    expect(rendered).toContain("</skill>");
    expect(rendered.endsWith("\n\n")).toBe(true);
  });

  test("empty selected → empty render", () => {
    expect(renderSelected([])).toBe("");
  });
});

describe("catalog cache", () => {
  test("loadCatalog re-reads SKILL.md when mtime bumps", () => {
    writeSkill("foo", "name: foo\ndescription: original desc");
    let entries = loadCatalog(skillsRoot);
    expect(entries.find((e) => e.name === "foo")?.description).toBe(
      "original desc",
    );
    // Rewrite with a future mtime to force cache miss.
    writeSkill("foo", "name: foo\ndescription: updated desc");
    const future = (Date.now() + 5_000) / 1000;
    utimesSync(join(skillsRoot, "foo", "SKILL.md"), future, future);
    entries = loadCatalog(skillsRoot);
    expect(entries.find((e) => e.name === "foo")?.description).toBe(
      "updated desc",
    );
  });

  test("excludes subctl-evy from catalog (Evy loads its own SKILL.md)", () => {
    writeSkill(
      "evy",
      "name: subctl-evy\ndescription: evy persona loaded separately",
    );
    const entries = loadCatalog(skillsRoot);
    expect(entries.find((e) => e.name === "subctl-evy")).toBeUndefined();
  });
});
