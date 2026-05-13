// v2.8.0 — team-template loader + dispatch routing tests.
//
// Covers:
//   - parse + validate (happy + 6 error paths)
//   - list / load with cache + mtime-driven invalidation
//   - stock templates seed on first list, no overwrite on subsequent list
//   - renderRosterPreamble shape
//   - projectDeveloperToolScope splits Bash:foo,bar correctly
//   - resolveDispatchTarget routing (no-meta, unknown-dev, happy)
//   - buildDeveloperBootPrompt embeds scope + task

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listTemplates,
  loadTemplate,
  parseTemplate,
  validateTemplate,
  projectDeveloperToolScope,
  renderRosterPreamble,
  seedStockTemplates,
  invalidateCache,
  stopWatching,
  teamTemplatesDir,
} from "../team-templates";

import {
  recordTemplateSpawn,
  recordDeveloperPane,
  readTeamMeta,
  resolveDispatchTarget,
  tmuxWindowForDeveloper,
  buildDeveloperBootPrompt,
} from "../../../dashboard/lib/team-dispatch";

const ORIG_TEMPLATES = process.env.SUBCTL_V2_TEAM_TEMPLATES_DIR;
const ORIG_STATE = process.env.SUBCTL_STATE_DIR;
let tmpRoot = "";
let templatesDir = "";
let stateDir = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "subctl-v2-tpl-"));
  templatesDir = join(tmpRoot, "templates");
  stateDir = join(tmpRoot, "state");
  process.env.SUBCTL_V2_TEAM_TEMPLATES_DIR = templatesDir;
  process.env.SUBCTL_STATE_DIR = stateDir;
  invalidateCache();
  stopWatching();
});

afterEach(() => {
  stopWatching();
  if (ORIG_TEMPLATES === undefined) delete process.env.SUBCTL_V2_TEAM_TEMPLATES_DIR;
  else process.env.SUBCTL_V2_TEAM_TEMPLATES_DIR = ORIG_TEMPLATES;
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ─── parse + validate ──────────────────────────────────────────────────────

const GOOD_TOML = `
[template]
name = "good-team"
description = "demo"

[lead]
persona = "evy"
skills = ["foo", "bar"]
autonomy = "ask"

[[developers]]
name = "frontend-dev"
persona = "expert-react"
skills = ["react-patterns"]
tools = ["Read", "Edit", "Bash:bun,git"]

[[developers]]
name = "backend-dev"
persona = "expert-bun"
skills = []
tools = ["Read", "Edit", "Write", "Bash:bun"]
`;

describe("parseTemplate (happy)", () => {
  test("parses a valid TOML template", () => {
    const t = parseTemplate(GOOD_TOML, { name: "good-team" });
    expect(t.name).toBe("good-team");
    expect(t.description).toBe("demo");
    expect(t.lead.persona).toBe("evy");
    expect(t.lead.autonomy).toBe("ask");
    expect(t.developers).toHaveLength(2);
    expect(t.developers[0].name).toBe("frontend-dev");
    expect(t.developers[1].tools).toContain("Bash:bun");
  });
});

describe("validateTemplate", () => {
  test("missing [template] block", () => {
    const v = validateTemplate({ lead: { persona: "x" }, developers: [{ name: "a", persona: "p" }] }, { name: "x" });
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toMatch(/\[template\] block is required/);
  });

  test("filename mismatch", () => {
    expect(() => parseTemplate(GOOD_TOML, { name: "wrong-name" })).toThrow(/does not match filename/);
  });

  test("missing [lead].persona", () => {
    const bad = `[template]\nname="t"\n[lead]\nskills=[]\n[[developers]]\nname="d"\npersona="p"\n`;
    expect(() => parseTemplate(bad, { name: "t" })).toThrow(/lead\]\.persona/);
  });

  test("no developers", () => {
    const bad = `[template]\nname="t"\n[lead]\npersona="evy"\ndevelopers=[]\n`;
    // smol-toml treats a top-level `developers=[]` as ok structurally; we
    // need the validator to reject it. Build it as a real empty array.
    expect(() => parseTemplate(`[template]\nname="t"\n[lead]\npersona="evy"\n`, { name: "t" })).toThrow(/developers/);
  });

  test("duplicate developer names", () => {
    const bad = `${GOOD_TOML}\n[[developers]]\nname="frontend-dev"\npersona="x"\nskills=[]\ntools=[]\n`;
    expect(() => parseTemplate(bad, { name: "good-team" })).toThrow(/more than once/);
  });

  test("invalid autonomy", () => {
    const bad = GOOD_TOML.replace('autonomy = "ask"', 'autonomy = "yolo"');
    expect(() => parseTemplate(bad, { name: "good-team" })).toThrow(/autonomy/);
  });

  test("malformed name with /", () => {
    const bad = GOOD_TOML.replace('name = "good-team"', 'name = "bad/name"');
    expect(() => parseTemplate(bad, { name: "good-team" })).toThrow(/must match/);
  });
});

// ─── tool scope projection ─────────────────────────────────────────────────

describe("projectDeveloperToolScope", () => {
  test("splits Bash:cmd1,cmd2 entries into the allowlist", () => {
    const scope = projectDeveloperToolScope({
      name: "d", persona: "p", skills: [],
      tools: ["Read", "Edit", "Bash:bun,git,curl", "Bash:jq"],
    });
    expect(scope.permissions).toEqual(["Read", "Edit"]);
    expect(scope.bashAllowlist).toEqual(["bun", "git", "curl", "jq"]);
  });

  test("bare Bash becomes wildcard", () => {
    const scope = projectDeveloperToolScope({
      name: "d", persona: "p", skills: [], tools: ["Bash"],
    });
    expect(scope.bashAllowlist).toEqual(["*"]);
  });

  test("empty tools means no shell", () => {
    const scope = projectDeveloperToolScope({
      name: "d", persona: "p", skills: [], tools: [],
    });
    expect(scope.bashAllowlist).toEqual([]);
    expect(scope.permissions).toEqual([]);
  });
});

// ─── list + load + cache ───────────────────────────────────────────────────

describe("listTemplates", () => {
  test("seeds stock templates on first call (idempotent)", () => {
    const { templates } = listTemplates();
    const names = templates.map((t) => t.name);
    expect(names).toContain("full-stack-web");
    expect(names).toContain("rust-api");
    expect(names).toContain("data-pipeline");
    expect(names).toContain("ml-research");
    expect(names).toContain("infrastructure");
    // Second call doesn't error and returns the same set.
    const r2 = listTemplates();
    expect(r2.templates.map((t) => t.name)).toEqual(names);
  });

  test("surfaces broken templates in errors[] without breaking listing", () => {
    seedStockTemplates();
    writeFileSync(join(templatesDir, "broken.toml"), "this is not toml [[[", "utf-8");
    const { templates, errors } = listTemplates();
    expect(templates.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.name === "broken")).toBe(true);
  });
});

describe("loadTemplate caching", () => {
  test("returns cached entry on second call without mtime change", () => {
    const path = join(templatesDir, "alpha.toml");
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
    writeFileSync(path, GOOD_TOML.replace("good-team", "alpha"), "utf-8");
    const t1 = loadTemplate("alpha");
    const t2 = loadTemplate("alpha");
    expect(t1).toBe(t2); // identity — cache hit
  });

  test("re-reads when mtime moves", async () => {
    const path = join(templatesDir, "beta.toml");
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
    writeFileSync(path, GOOD_TOML.replace("good-team", "beta"), "utf-8");
    const t1 = loadTemplate("beta");
    // Bump mtime forward by 1s and rewrite content.
    const future = (statSync(path).mtimeMs + 1500) / 1000;
    writeFileSync(path, GOOD_TOML.replace("good-team", "beta").replace("demo", "demo2"), "utf-8");
    utimesSync(path, future, future);
    const t2 = loadTemplate("beta");
    expect(t2).not.toBe(t1);
    expect(t2.description).toBe("demo2");
  });
});

// ─── roster preamble ───────────────────────────────────────────────────────

describe("renderRosterPreamble", () => {
  test("lists every developer + example dispatch", () => {
    const t = parseTemplate(GOOD_TOML, { name: "good-team" });
    const preamble = renderRosterPreamble(t);
    expect(preamble).toMatch(/template=good-team/);
    expect(preamble).toMatch(/frontend-dev \(expert-react\)/);
    expect(preamble).toMatch(/backend-dev \(expert-bun\)/);
    expect(preamble).toMatch(/subctl_team_dispatch/);
  });
});

// ─── dispatch routing ──────────────────────────────────────────────────────

describe("resolveDispatchTarget", () => {
  test("rejects when team has no meta", () => {
    const r = resolveDispatchTarget("nonexistent-team", "frontend-dev");
    expect((r as { ok: boolean }).ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not spawned from a v2\.8\.0 team template/);
    expect((r as { recoverable: boolean }).recoverable).toBe(true);
  });

  test("rejects unknown developer name with helpful list", () => {
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "demo.toml"), GOOD_TOML.replace("good-team", "demo"), "utf-8");
    recordTemplateSpawn("claude-demo", "demo");
    const r = resolveDispatchTarget("claude-demo", "no-such-dev");
    expect((r as { ok: boolean }).ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/frontend-dev, backend-dev/);
  });

  test("happy path returns routable target with alreadySpawned=false on first dispatch", () => {
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "demo.toml"), GOOD_TOML.replace("good-team", "demo"), "utf-8");
    recordTemplateSpawn("claude-demo", "demo");
    const r = resolveDispatchTarget("claude-demo", "frontend-dev") as {
      team: string; developer: { name: string }; alreadySpawned: boolean;
      windowName: string; tmuxTarget: string;
    };
    expect(r.team).toBe("claude-demo");
    expect(r.developer.name).toBe("frontend-dev");
    expect(r.alreadySpawned).toBe(false);
    expect(r.windowName).toBe("dev-frontend-dev");
    expect(r.tmuxTarget).toBe("claude-demo:dev-frontend-dev");
  });

  test("alreadySpawned=true after recordDeveloperPane", () => {
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "demo.toml"), GOOD_TOML.replace("good-team", "demo"), "utf-8");
    recordTemplateSpawn("claude-demo", "demo");
    recordDeveloperPane("claude-demo", "frontend-dev", tmuxWindowForDeveloper("frontend-dev"));
    const r = resolveDispatchTarget("claude-demo", "frontend-dev") as { alreadySpawned: boolean };
    expect(r.alreadySpawned).toBe(true);
  });
});

describe("buildDeveloperBootPrompt", () => {
  test("embeds persona, skills, scope, and the task body", () => {
    const t = parseTemplate(GOOD_TOML, { name: "good-team" });
    const prompt = buildDeveloperBootPrompt(t, t.developers[0], "Implement /login page with form validation.");
    expect(prompt).toMatch(/developer role/);
    expect(prompt).toMatch(/expert-react/);
    expect(prompt).toMatch(/react-patterns/);
    expect(prompt).toMatch(/bun, git/);
    expect(prompt).toMatch(/Implement \/login page/);
  });
});

describe("team_meta round-trip", () => {
  test("recordTemplateSpawn → readTeamMeta returns same template name", () => {
    recordTemplateSpawn("team-1", "full-stack-web");
    const meta = readTeamMeta("team-1");
    expect(meta?.template).toBe("full-stack-web");
    expect(meta?.developer_panes).toEqual({});
  });

  test("recordDeveloperPane updates the map", () => {
    recordTemplateSpawn("team-2", "rust-api");
    recordDeveloperPane("team-2", "api-dev", "dev-api-dev");
    const meta = readTeamMeta("team-2");
    expect(meta?.developer_panes?.["api-dev"]).toBe("dev-api-dev");
  });
});
