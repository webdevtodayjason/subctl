// components/master/__tests__/templates-loader.test.ts
//
// Covers the in-tree team-template registry loader. Two-layered coverage:
//
//   1. Real registry — exercise the shipped templates under components/templates/
//      so a malformed baseline template breaks CI before it can break a spawn.
//
//   2. Synthetic registry in a tmpdir — exercise edge cases (missing files,
//      bad role, name/folder mismatch, unknown {{var}}, etc.) without
//      polluting the in-tree registry.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listTemplates,
  getTemplate,
  renderBootPrompt,
  templatesRegistryDir,
  type TemplateRole,
} from "../templates-loader";

// ─── real registry: shipped baselines ───────────────────────────────────────

describe("in-tree registry (real)", () => {
  test("registry dir resolves to components/templates", () => {
    const dir = templatesRegistryDir();
    expect(dir).toContain("components");
    expect(dir).toContain("templates");
  });

  test("listTemplates() returns the 4 baseline templates with no errors", () => {
    const { templates, errors } = listTemplates();
    expect(errors).toEqual([]);
    const names = templates.map((t) => t.metadata.name).sort();
    expect(names).toEqual([
      "bug-investigation",
      "code-review",
      "docs",
      "feature-dev",
    ]);
  });

  test("each baseline has a valid role", () => {
    const { templates } = listTemplates();
    const allowed: TemplateRole[] = ["forge", "sentry", "scout", "quill"];
    for (const t of templates) {
      expect(allowed).toContain(t.metadata.role);
    }
  });

  test("getTemplate('feature-dev') returns forge role", () => {
    const t = getTemplate("feature-dev");
    expect(t.metadata.role).toBe("forge");
    expect(t.metadata.description.length).toBeGreaterThan(0);
    expect(t.bootPromptRaw).toContain("FORGE");
  });

  test("role-to-template mapping is correct", () => {
    expect(getTemplate("feature-dev").metadata.role).toBe("forge");
    expect(getTemplate("code-review").metadata.role).toBe("sentry");
    expect(getTemplate("bug-investigation").metadata.role).toBe("scout");
    expect(getTemplate("docs").metadata.role).toBe("quill");
  });

  test("each baseline boot prompt mentions the role-layer-load directive", () => {
    // The directive shape is "<ROLE>: read <ROLE>.md and …" — without this,
    // workers won't pull in the claude-layers role overlay at boot.
    expect(getTemplate("feature-dev").bootPromptRaw).toMatch(/FORGE: read FORGE\.md/);
    expect(getTemplate("code-review").bootPromptRaw).toMatch(/SENTRY: read SENTRY\.md/);
    expect(getTemplate("bug-investigation").bootPromptRaw).toMatch(/SCOUT: read SCOUT\.md/);
    expect(getTemplate("docs").bootPromptRaw).toMatch(/QUILL: read QUILL\.md/);
  });

  test("renderBootPrompt substitutes the required vars", () => {
    const out = renderBootPrompt("feature-dev", {
      project_path: "/tmp/my-proj",
      account: "claude-jason",
      additional_scope: "fix #29",
    });
    expect(out).toContain("/tmp/my-proj");
    expect(out).toContain("claude-jason");
    expect(out).toContain("fix #29");
    // No leftover unsubstituted vars.
    expect(out).not.toMatch(/\{\{\s*(project_path|account|additional_scope)\s*\}\}/);
  });

  test("renderBootPrompt with empty additional_scope renders empty (no crash)", () => {
    const out = renderBootPrompt("feature-dev", {
      project_path: "/tmp/p",
      account: "claude-jason",
    });
    expect(out).toContain("/tmp/p");
    expect(out).toContain("claude-jason");
  });

  test("getTemplate on unknown name throws a clear error", () => {
    expect(() => getTemplate("nonexistent-template")).toThrow(
      /team template not found.*nonexistent-template/,
    );
  });

  test("getTemplate on invalid name throws", () => {
    expect(() => getTemplate("../etc/passwd")).toThrow(/invalid template name/);
    expect(() => getTemplate("Some Spaces")).toThrow(/invalid template name/);
  });

  test("renderBootPrompt requires project_path and account", () => {
    expect(() =>
      renderBootPrompt("feature-dev", {
        // @ts-expect-error — intentional missing field
        project_path: undefined,
        account: "claude-jason",
      }),
    ).toThrow(/project_path is required/);

    expect(() =>
      renderBootPrompt("feature-dev", {
        project_path: "/tmp/p",
        // @ts-expect-error — intentional missing field
        account: undefined,
      }),
    ).toThrow(/account is required/);
  });
});

// ─── synthetic registry: edge cases ─────────────────────────────────────────

describe("synthetic registry (tmpdir)", () => {
  const ORIG = process.env.SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR;
  let tmpRoot = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "subctl-tpl-"));
    process.env.SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR = tmpRoot;
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR;
    else process.env.SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR = ORIG;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  function seed(
    name: string,
    metaJson: Record<string, unknown> | string,
    bootBody: string | null,
  ): void {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    const metaText =
      typeof metaJson === "string" ? metaJson : JSON.stringify(metaJson);
    writeFileSync(join(dir, "template.json"), metaText);
    if (bootBody !== null) {
      writeFileSync(join(dir, "boot_prompt.md"), bootBody);
    }
  }

  test("listTemplates on empty dir returns empty arrays", () => {
    const r = listTemplates();
    expect(r.templates).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("missing boot_prompt.md is captured as an error, not a crash", () => {
    seed(
      "broken-one",
      {
        name: "broken-one",
        role: "forge",
        description: "no boot prompt",
      },
      null,
    );
    const r = listTemplates();
    expect(r.templates).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toMatch(/missing boot_prompt\.md/);
  });

  test("name/folder mismatch is rejected", () => {
    seed(
      "real-folder",
      {
        name: "wrong-name",
        role: "forge",
        description: "x",
      },
      "FORGE: read FORGE.md",
    );
    const r = listTemplates();
    expect(r.errors[0]!.error).toMatch(/must equal folder name/);
  });

  test("unknown role is rejected", () => {
    seed(
      "bad-role",
      {
        name: "bad-role",
        role: "warden",
        description: "x",
      },
      "x",
    );
    const r = listTemplates();
    expect(r.errors[0]!.error).toMatch(/role must be one of forge\|sentry\|scout\|quill/);
  });

  test("unknown {{var}} in boot_prompt is rejected at load time", () => {
    seed(
      "typo-var",
      { name: "typo-var", role: "forge", description: "x" },
      "Hello {{projectpath}} (typo)",
    );
    const r = listTemplates();
    expect(r.errors[0]!.error).toMatch(/unknown variable.*projectpath/);
  });

  test("valid synthetic template loads + renders end-to-end", () => {
    seed(
      "ok-team",
      {
        name: "ok-team",
        role: "scout",
        description: "synthetic",
        default_account_hint: "claude-test",
      },
      "Project: {{project_path}}\nAccount: {{account}}\nScope: {{additional_scope}}",
    );
    const t = getTemplate("ok-team");
    expect(t.metadata.role).toBe("scout");
    expect(t.metadata.default_account_hint).toBe("claude-test");
    const out = renderBootPrompt("ok-team", {
      project_path: "/p",
      account: "claude-a",
      additional_scope: "S",
    });
    expect(out).toBe("Project: /p\nAccount: claude-a\nScope: S");
  });

  test("malformed JSON is surfaced cleanly", () => {
    seed("bad-json", "{ not valid json", "x");
    const r = listTemplates();
    expect(r.errors[0]!.error).toMatch(/failed to parse template\.json/);
  });

  test("default_account_hint is optional", () => {
    seed(
      "no-hint",
      { name: "no-hint", role: "quill", description: "x" },
      "QUILL: read QUILL.md\n",
    );
    const t = getTemplate("no-hint");
    expect(t.metadata.default_account_hint).toBeUndefined();
  });
});
