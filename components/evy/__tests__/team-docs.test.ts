// components/evy/__tests__/team-docs.test.ts
//
// v2.7.10 — tests for the team-docs tool family. The four tools manage
// project-local docs at <project_root>/.subctl/docs/:
//   - team_doc_write     write a doc (optionally with YAML frontmatter)
//   - team_doc_read      read one back, parsing frontmatter
//   - team_doc_list      enumerate files + subdirs
//   - team_decision_log  append to decisions.jsonl
//
// Strategy:
//   - mkdtemp a fresh project root per test so tests are order-independent
//     and can run in parallel under bun.
//   - rm -rf in afterEach so we don't pollute /tmp across runs.
//   - Cover the happy paths, the security paths (path traversal,
//     absolute path), the "folder doesn't exist" path on list, and the
//     append-twice path on decision_log to confirm running totals.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  teamDocsTools,
  emitFrontmatter,
  parseFrontmatter,
} from "../tools/team-docs";

const { team_doc_write, team_doc_read, team_doc_list, team_decision_log } =
  teamDocsTools;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "subctl-team-docs-"));
});

afterEach(() => {
  try {
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// team_doc_write — happy paths
// ---------------------------------------------------------------------------

describe("team_doc_write — happy paths", () => {
  test("writes SPEC.md at the expected path with matching content", async () => {
    const r = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
      content: "# SPEC\n\nThis is the spec.\n",
    })) as { ok: boolean; path: string; bytes_written: number; frontmatter_keys: string[] };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(join(projectRoot, ".subctl", "docs", "SPEC.md"));
    expect(r.frontmatter_keys).toEqual([]);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, "utf8")).toBe("# SPEC\n\nThis is the spec.\n");
    expect(r.bytes_written).toBeGreaterThan(0);
  });

  test("with frontmatter: emits `---` block that round-trips through team_doc_read", async () => {
    const fm = {
      operator: "jason",
      account: "claude-jason",
      phase: "baseline",
      kind: "spec",
    };
    const body = "# osint-cve-monitor SPEC\n\nDetect new CVEs.\n";
    const w = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
      content: body,
      frontmatter: fm,
    })) as { ok: boolean; path: string; frontmatter_keys: string[] };
    expect(w.ok).toBe(true);
    expect(w.frontmatter_keys).toEqual(["operator", "account", "phase", "kind"]);

    // Verify on-disk file starts with the YAML fence and ends with the body.
    const raw = readFileSync(w.path, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);

    // Round-trip via team_doc_read.
    const r = (await team_doc_read.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
    })) as {
      ok: boolean;
      has_frontmatter: boolean;
      frontmatter: Record<string, unknown>;
      content: string;
    };
    expect(r.ok).toBe(true);
    expect(r.has_frontmatter).toBe(true);
    expect(r.frontmatter).toEqual(fm);
    expect(r.content).toBe(body);
  });

  test("to a handoffs/ subdir creates the subdir", async () => {
    const r = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "handoffs/2026-05-12-baseline.md",
      content: "handoff body",
    })) as { ok: boolean; path: string };
    expect(r.ok).toBe(true);
    const expected = join(
      projectRoot,
      ".subctl",
      "docs",
      "handoffs",
      "2026-05-12-baseline.md",
    );
    expect(r.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  test("overwrites an existing file", async () => {
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
      content: "first",
    });
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
      content: "second",
    });
    const path = join(projectRoot, ".subctl", "docs", "SPEC.md");
    expect(readFileSync(path, "utf8")).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// team_doc_write — security & validation
// ---------------------------------------------------------------------------

describe("team_doc_write — security & validation", () => {
  test("rejects path traversal via '..' segments", async () => {
    const r = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "../../etc/passwd",
      content: "pwned",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\.\./);
    // And nothing should have been written to /etc/passwd or anywhere outside
    // the project — best we can do is assert the file isn't under projectRoot.
    expect(existsSync(join(projectRoot, ".subctl", "docs", "..", "..", "etc", "passwd"))).toBe(false);
  });

  test("rejects absolute relative_path", async () => {
    const r = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "/etc/passwd",
      content: "pwned",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute/);
  });

  test("rejects empty relative_path", async () => {
    const r = (await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "",
      content: "x",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
  });

  test("rejects nonexistent project_root", async () => {
    const r = (await team_doc_write.invoke({
      project_root: "/this/path/definitely/does/not/exist/subctl-test",
      relative_path: "SPEC.md",
      content: "x",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not exist|not a directory/);
  });

  test("rejects project_root that's a file, not a directory", async () => {
    const filePath = join(projectRoot, "imafile");
    writeFileSync(filePath, "hi");
    const r = (await team_doc_write.invoke({
      project_root: filePath,
      relative_path: "SPEC.md",
      content: "x",
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// team_doc_read
// ---------------------------------------------------------------------------

describe("team_doc_read", () => {
  test("reads a plain file with no frontmatter", async () => {
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "plain.md",
      content: "just text",
    });
    const r = (await team_doc_read.invoke({
      project_root: projectRoot,
      relative_path: "plain.md",
    })) as { ok: boolean; has_frontmatter: boolean; content: string };
    expect(r.ok).toBe(true);
    expect(r.has_frontmatter).toBe(false);
    expect(r.content).toBe("just text");
  });

  test("returns ok:false with sane error for missing file", async () => {
    const r = (await team_doc_read.invoke({
      project_root: projectRoot,
      relative_path: "nope.md",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such file/);
  });

  test("rejects path traversal on read too", async () => {
    const r = (await team_doc_read.invoke({
      project_root: projectRoot,
      relative_path: "../../etc/passwd",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\.\./);
  });
});

// ---------------------------------------------------------------------------
// team_doc_list
// ---------------------------------------------------------------------------

describe("team_doc_list", () => {
  test("returns empty entries when the docs folder doesn't exist (not an error)", async () => {
    const r = (await team_doc_list.invoke({
      project_root: projectRoot,
    })) as { ok: boolean; entries: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
  });

  test("enumerates files and subdirs correctly with stable sort", async () => {
    // Lay down: SPEC.md, PRD.md, handoffs/one.md, decisions.jsonl
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "SPEC.md",
      content: "spec",
    });
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "PRD.md",
      content: "prd",
    });
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "handoffs/one.md",
      content: "handoff one",
    });
    await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "spawned baseline team",
    });

    const r = (await team_doc_list.invoke({
      project_root: projectRoot,
    })) as {
      ok: boolean;
      root: string;
      entries: Array<{ path: string; kind: "file" | "dir"; size: number }>;
    };
    expect(r.ok).toBe(true);
    // Top-level should have: handoffs/ (dir), PRD.md, SPEC.md, decisions.jsonl (files).
    // Sort contract: dirs first, then files by locale-aware path compare.
    // We don't pin the exact order of the files because localeCompare is
    // locale-sensitive on case (e.g. lowercase 'd' may sort before
    // uppercase 'P' in some locales). What we DO pin: dir-before-file
    // grouping, and the set of names returned.
    expect(r.entries.length).toBe(4);
    expect(r.entries[0]!.kind).toBe("dir");
    expect(r.entries[0]!.path.endsWith("handoffs")).toBe(true);
    const fileEntries = r.entries.slice(1);
    expect(fileEntries.every((e) => e.kind === "file")).toBe(true);
    const fileNames = fileEntries.map((e) => e.path.split("/").pop()!).sort();
    expect(fileNames).toEqual(["PRD.md", "SPEC.md", "decisions.jsonl"].sort());
  });

  test("respects subdir argument", async () => {
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "handoffs/a.md",
      content: "a",
    });
    await team_doc_write.invoke({
      project_root: projectRoot,
      relative_path: "handoffs/b.md",
      content: "b",
    });
    const r = (await team_doc_list.invoke({
      project_root: projectRoot,
      subdir: "handoffs",
    })) as { ok: boolean; entries: Array<{ path: string }> };
    expect(r.ok).toBe(true);
    expect(r.entries.length).toBe(2);
    expect(r.entries.every((e) => e.path.includes("/handoffs/"))).toBe(true);
  });

  test("rejects subdir traversal", async () => {
    const r = (await team_doc_list.invoke({
      project_root: projectRoot,
      subdir: "../../etc",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\.\./);
  });
});

// ---------------------------------------------------------------------------
// team_decision_log
// ---------------------------------------------------------------------------

describe("team_decision_log", () => {
  test("creates .subctl/docs/ if missing and appends one JSON line", async () => {
    expect(existsSync(join(projectRoot, ".subctl", "docs"))).toBe(false);
    const r = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "swapped supervisor to qwen3.6",
      detail: "M3 hit RAM pressure; qwen3.6 is leaner.",
    })) as { ok: boolean; path: string; total_decisions: number; ts: string };
    expect(r.ok).toBe(true);
    expect(r.total_decisions).toBe(1);
    expect(existsSync(r.path)).toBe(true);
    const raw = readFileSync(r.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.summary).toBe("swapped supervisor to qwen3.6");
    expect(parsed.detail).toBe("M3 hit RAM pressure; qwen3.6 is leaner.");
    expect(parsed.by).toBe("master");
    expect(typeof parsed.ts).toBe("string");
    // ts should be ISO-shaped.
    expect(parsed.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("second call appends a second line (total goes 1 → 2)", async () => {
    const first = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "decision one",
    })) as { total_decisions: number };
    const second = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "decision two",
    })) as { total_decisions: number; path: string };
    expect(first.total_decisions).toBe(1);
    expect(second.total_decisions).toBe(2);
    const raw = readFileSync(second.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);
    expect((JSON.parse(lines[0]!) as { summary: string }).summary).toBe(
      "decision one",
    );
    expect((JSON.parse(lines[1]!) as { summary: string }).summary).toBe(
      "decision two",
    );
  });

  test("by defaults to 'master', honors override", async () => {
    const r1 = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "default actor",
    })) as { ok: boolean; path: string };
    const r2 = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "explicit actor",
      by: "operator",
    })) as { ok: boolean };
    expect(r1.ok && r2.ok).toBe(true);
    const raw = readFileSync(r1.path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect((JSON.parse(lines[0]!) as { by: string }).by).toBe("master");
    expect((JSON.parse(lines[1]!) as { by: string }).by).toBe("operator");
  });

  test("rejects nonexistent project_root", async () => {
    const r = (await team_decision_log.invoke({
      project_root: "/no/such/path/subctl",
      summary: "boom",
    })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
  });

  test("rejects empty summary", async () => {
    const r = (await team_decision_log.invoke({
      project_root: projectRoot,
      summary: "",
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// frontmatter parser sanity
// ---------------------------------------------------------------------------

describe("frontmatter emit/parse", () => {
  test("emits valid YAML-ish block for typical mandate", () => {
    const out = emitFrontmatter({
      operator: "jason",
      account: "claude-jason",
      phase: "baseline",
      kind: "spec",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("\n---")).toBe(true);
    expect(out).toContain("operator: jason");
  });

  test("quotes values that contain colons", () => {
    const out = emitFrontmatter({ note: "value: with colon" });
    expect(out).toContain(`note: "value: with colon"`);
  });

  test("quotes values that look like reserved literals", () => {
    const out = emitFrontmatter({ name: "true", count: "42" });
    expect(out).toContain(`name: "true"`);
    expect(out).toContain(`count: "42"`);
  });

  test("emits booleans and numbers untokenized", () => {
    const out = emitFrontmatter({ live: true, retries: 3 });
    expect(out).toContain(`live: true`);
    expect(out).toContain(`retries: 3`);
  });

  test("parse returns null when no frontmatter fence is present", () => {
    expect(parseFrontmatter("# just a markdown title\n")).toBeNull();
  });

  test("parse round-trips emit() output", () => {
    const fm = { a: "hello", b: 7, c: true, d: null };
    const raw = emitFrontmatter(fm) + "\n\nbody\n";
    const parsed = parseFrontmatter(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter).toEqual(fm);
    expect(parsed!.body).toBe("body\n");
  });
});
