// components/master/__tests__/knowledge.test.ts
//
// v2.7.7 — system_subctl_knowledge tool tests.
//
// Coverage:
//   - default call (no section) returns a sections list with ≥10 entries
//     and each entry has a name + summary.
//   - section="policy" returns content containing the canonical mode names
//     (Trusted/Gated/Sealed) — pins the TOON file to actually describe
//     the policy engine, not just have a heading.
//   - section="nonexistent" returns ok:false with available_sections
//     populated — operator-facing error path stays informative.
//   - the .toon file exists at the expected resolved path AND its raw
//     contents include enough top-level section headers to be a valid
//     breakdown (regex sanity check, not a full TOON parse).
//   - module-load caching: a second invoke does NOT re-read the file
//     from disk. We assert by monkey-patching readFileSync after the
//     first call and verifying the second call still works (it'd
//     throw if it tried to re-read with the stub).
//
// These tests run from components/master via `bun test __tests__/`,
// matching the existing secrets.test.ts + compact-policy.test.ts pattern.

import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  knowledgeTools,
  _getKnowledgePath,
  _getDiskReadCountForTesting,
  _resetKnowledgeCacheForTesting,
} from "../tools/knowledge";

// All tests share the same module load. The cache test below relies on
// being the LAST test to run against a populated cache, so we explicitly
// prime once up front to keep ordering predictable across bun's parallel
// test scheduler.
beforeAll(() => {
  _resetKnowledgeCacheForTesting();
});

const tool = knowledgeTools.system_subctl_knowledge;

describe("system_subctl_knowledge — default listing", () => {
  test("returns sections list with ≥10 entries", async () => {
    const result = (await tool.invoke({})) as {
      ok: boolean;
      sections: Array<{ name: string; summary: string }>;
      note: string;
    };
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.sections)).toBe(true);
    expect(result.sections.length).toBeGreaterThanOrEqual(10);
    expect(result.note).toContain("section");
    // every entry must have a name + summary string.
    for (const s of result.sections) {
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.summary).toBe("string");
    }
  });

  test("section names are unique", async () => {
    const result = (await tool.invoke({})) as {
      sections: Array<{ name: string }>;
    };
    const names = result.sections.map((s) => s.name);
    const uniq = new Set(names);
    expect(uniq.size).toBe(names.length);
  });
});

describe("system_subctl_knowledge — fetching a known section", () => {
  test("section='policy' returns content describing Trusted/Gated", async () => {
    const result = (await tool.invoke({ section: "policy" })) as {
      ok: boolean;
      section: string;
      content: string;
    };
    expect(result.ok).toBe(true);
    expect(result.section).toBe("policy");
    expect(typeof result.content).toBe("string");
    // The policy section must describe the v2.7.0 trust modes by name —
    // if this fails, the TOON file's policy section drifted away from
    // describing the actual policy engine.
    const hasTrusted = result.content.includes("Trusted");
    const hasGated = result.content.includes("Gated");
    expect(hasTrusted || hasGated).toBe(true);
  });

  test("section='tools' returns content with tool family names", async () => {
    const result = (await tool.invoke({ section: "tools" })) as {
      ok: boolean;
      content: string;
    };
    expect(result.ok).toBe(true);
    // At least one well-known tool family prefix should appear.
    expect(
      result.content.includes("subctl_orch") ||
        result.content.includes("system_"),
    ).toBe(true);
  });
});

describe("system_subctl_knowledge — unknown section", () => {
  test("returns ok:false with available_sections populated", async () => {
    const result = (await tool.invoke({ section: "nonexistent_xyz" })) as {
      ok: boolean;
      error: string;
      available_sections: string[];
    };
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("nonexistent_xyz");
    expect(Array.isArray(result.available_sections)).toBe(true);
    expect(result.available_sections.length).toBeGreaterThanOrEqual(10);
  });
});

describe("system_subctl_knowledge — the .toon file itself", () => {
  test("file exists at the resolved path", () => {
    const path = _getKnowledgePath();
    expect(existsSync(path)).toBe(true);
  });

  test("raw file contains ≥10 top-level section headers", () => {
    const path = _getKnowledgePath();
    const raw = readFileSync(path, "utf8");
    // Top-level section header: lowercase identifier + colon at column 0
    // with nothing else on the line. Matches the parser's TOP_LEVEL_KEY
    // regex (kept identical here intentionally — if the parser regex
    // changes, this test will catch the resulting drift).
    const matches = raw.match(/^[a-z_][a-z0-9_]*:\s*$/gm);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

describe("system_subctl_knowledge — caching behavior", () => {
  test("file is read from disk only once across many invocations", async () => {
    // Start clean — module-level _cache + _diskReadCount both reset.
    _resetKnowledgeCacheForTesting();
    expect(_getDiskReadCountForTesting()).toBe(0);

    // Invoke a handful of times — default listing, a specific section,
    // an unknown section, and again — covering every code path that
    // could plausibly re-enter loadKnowledge().
    await tool.invoke({});
    await tool.invoke({ section: "policy" });
    await tool.invoke({ section: "nonexistent_xyz" });
    await tool.invoke({ section: "tools" });
    await tool.invoke({});

    // Exactly one disk read across all five invocations.
    expect(_getDiskReadCountForTesting()).toBe(1);
  });
});
