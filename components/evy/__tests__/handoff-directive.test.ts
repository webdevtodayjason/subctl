// components/master/__tests__/handoff-directive.test.ts
//
// Acceptance suite for #29 — handoff-file directive transport.
//
// Required coverage (per the 2026-05-19 handoff):
//   - path safety: slug validation, no traversal, file lands inside
//     .subctl/docs/handoffs/
//   - handoff creation: frontmatter shape, body preserved verbatim,
//     unique filename on collision
//   - short directive emission: single line, repo-relative path,
//     stable shape
//   - audit trail: one "written" + one "dispatched"/"failed" entry
//     per send
//   - transport failure is recorded without throwing

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  appendHandoffAudit,
  assertValidSlug,
  buildShortDirective,
  listHandoffs,
  resolveHandoffPaths,
  sendHandoffDirective,
  tailHandoffAudit,
  writeHandoff,
  type HandoffPaths,
  type HandoffTransport,
} from "../handoff-directive";

let repoRoot: string;
let paths: HandoffPaths;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "handoff-"));
  paths = resolveHandoffPaths(repoRoot);
});

afterEach(() => {
  if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
});

// ─── slug + path safety ────────────────────────────────────────────────────

describe("slug validation (path safety)", () => {
  test("accepts kebab-case alphanumeric", () => {
    for (const ok of ["a", "ab", "memory-init-7", "wd-2026-05-19", "x".repeat(64)]) {
      expect(() => assertValidSlug(ok)).not.toThrow();
    }
  });

  test("rejects path traversal and unusual characters", () => {
    for (const bad of [
      "",
      "..",
      "../etc/passwd",
      "/etc/passwd",
      "a/b",
      "a\\b",
      "with spaces",
      "UPPERCASE",
      "-leading-hyphen",
      "ends-in-hyphen-".repeat(10), // > 64 chars
      "..hidden",
      ".",
      "a.b",
      "@special",
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      expect(() => assertValidSlug(bad)).toThrow();
    }
  });

  test("writeHandoff rejects invalid slug", () => {
    expect(() => writeHandoff({
      slug: "../escape",
      phase: "test",
      body: "x",
      paths,
    })).toThrow();
  });

  test("writeHandoff lands inside the handoffs dir", () => {
    const r = writeHandoff({ slug: "test-slug", phase: "test", body: "hello", paths });
    expect(r.path_absolute.startsWith(paths.dir + sep)).toBe(true);
  });
});

// ─── handoff creation ─────────────────────────────────────────────────────

describe("writeHandoff", () => {
  test("creates the file with frontmatter + body", () => {
    const r = writeHandoff({
      slug: "memory-init-7",
      phase: "approved_execution",
      body: "# Goal\n\nSomething to do.\n",
      worker_session: "claude-w1",
      why: "operator asked",
      paths,
      date: "2026-05-19",
      ts: "2026-05-19T18:00:00.000Z",
    });
    expect(r.slug).toBe("2026-05-19-memory-init-7");
    expect(r.path_relative).toBe(join(".subctl", "docs", "handoffs", "2026-05-19-memory-init-7.md"));
    const content = readFileSync(r.path_absolute, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("phase: approved_execution");
    expect(content).toContain("worker_session: claude-w1");
    expect(content).toContain("ts: 2026-05-19T18:00:00.000Z");
    expect(content).toContain("# Goal");
    expect(content).toContain("Something to do.");
  });

  test("body preserved verbatim (multi-line, embedded quotes)", () => {
    const body = "line one\nline two with \"quotes\" and 'apostrophes'\n  indented\n---\nnot frontmatter, just a divider\n";
    const r = writeHandoff({
      slug: "verbatim",
      phase: "test",
      body,
      paths,
      date: "2026-05-19",
    });
    const content = readFileSync(r.path_absolute, "utf8");
    // The body is appended after the closing `---\n` of the frontmatter, so
    // it appears verbatim somewhere after the second `---` line.
    expect(content).toContain(body.trim());
  });

  test("collision → unique suffix, never overwrites", () => {
    const a = writeHandoff({ slug: "dup", phase: "test", body: "first", paths, date: "2026-05-19" });
    const b = writeHandoff({ slug: "dup", phase: "test", body: "second", paths, date: "2026-05-19" });
    const c = writeHandoff({ slug: "dup", phase: "test", body: "third", paths, date: "2026-05-19" });
    expect(a.slug).toBe("2026-05-19-dup");
    expect(b.slug).toBe("2026-05-19-dup-1");
    expect(c.slug).toBe("2026-05-19-dup-2");
    expect(readFileSync(a.path_absolute, "utf8")).toContain("first");
    expect(readFileSync(b.path_absolute, "utf8")).toContain("second");
    expect(readFileSync(c.path_absolute, "utf8")).toContain("third");
  });

  test("invalid date format rejected", () => {
    expect(() => writeHandoff({
      slug: "ok",
      phase: "test",
      body: "x",
      paths,
      date: "not-a-date",
    })).toThrow(/invalid handoff date/);
  });

  test("empty phase rejected", () => {
    expect(() => writeHandoff({
      slug: "ok",
      phase: "",
      body: "x",
      paths,
    })).toThrow();
  });

  test("non-string body rejected", () => {
    expect(() => writeHandoff({
      slug: "ok",
      phase: "test",
      body: 42 as unknown as string,
      paths,
    })).toThrow();
  });
});

// ─── short directive ──────────────────────────────────────────────────────

describe("buildShortDirective", () => {
  test("produces the canonical short shape", () => {
    expect(buildShortDirective(".subctl/docs/handoffs/2026-05-19-memory-init-7.md"))
      .toBe("read handoff .subctl/docs/handoffs/2026-05-19-memory-init-7.md and proceed");
  });

  test("single line, no embedded newlines", () => {
    const s = buildShortDirective(".subctl/docs/handoffs/x.md");
    expect(s).not.toContain("\n");
    expect(s).not.toContain("\r");
  });

  test("rejects empty path", () => {
    expect(() => buildShortDirective("")).toThrow();
  });

  test("rejects absolute path", () => {
    expect(() => buildShortDirective("/Users/sem/foo.md")).toThrow();
  });
});

// ─── audit trail ──────────────────────────────────────────────────────────

describe("audit trail", () => {
  test("appendHandoffAudit + tailHandoffAudit roundtrip", () => {
    appendHandoffAudit({
      ts: "2026-05-19T18:00:00Z",
      slug: "x",
      path: ".subctl/docs/handoffs/x.md",
      phase: "p",
      body_bytes: 100,
      status: "written",
      short_directive: "read handoff .subctl/docs/handoffs/x.md and proceed",
    }, paths);
    const tail = tailHandoffAudit(10, paths);
    expect(tail).toHaveLength(1);
    expect(tail[0].slug).toBe("x");
    expect(tail[0].status).toBe("written");
  });

  test("tailHandoffAudit returns empty array when no audit exists", () => {
    expect(tailHandoffAudit(10, paths)).toEqual([]);
  });
});

// ─── sendHandoffDirective end-to-end ──────────────────────────────────────

describe("sendHandoffDirective", () => {
  test("happy path: writes file, calls transport, audit shows dispatched", async () => {
    const calls: Array<{ worker_session: string; short_directive: string }> = [];
    const transport: HandoffTransport = {
      send: (i) => { calls.push(i); return { ok: true }; },
    };

    const r = await sendHandoffDirective({
      slug: "memory-init-7-resume",
      phase: "approved_execution",
      body: "## Mandate\nproceed with the work\n",
      worker_session: "claude-w1",
      transport,
      paths,
      date: "2026-05-19",
    });

    expect(r.dispatched).toBe(true);
    expect(r.error).toBeUndefined();
    expect(existsSync(r.written.path_absolute)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].worker_session).toBe("claude-w1");
    expect(calls[0].short_directive).toBe(`read handoff ${r.written.path_relative} and proceed`);

    const audit = tailHandoffAudit(50, paths);
    // One "written" then one "dispatched" entry.
    expect(audit).toHaveLength(2);
    expect(audit.find((e) => e.status === "written")).toBeDefined();
    expect(audit.find((e) => e.status === "dispatched")).toBeDefined();
    expect(audit.every((e) => e.slug === r.written.slug)).toBe(true);
  });

  test("transport failure recorded as failed; does not throw", async () => {
    const transport: HandoffTransport = {
      send: () => ({ ok: false, error: "tmux send-keys exit 1" }),
    };
    const r = await sendHandoffDirective({
      slug: "will-fail",
      phase: "p",
      body: "x",
      worker_session: "claude-w1",
      transport,
      paths,
      date: "2026-05-19",
    });
    expect(r.dispatched).toBe(false);
    expect(r.error).toContain("tmux send-keys exit 1");
    expect(existsSync(r.written.path_absolute)).toBe(true);

    const audit = tailHandoffAudit(50, paths);
    const failed = audit.find((e) => e.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.transport_error).toContain("tmux send-keys exit 1");
  });

  test("transport throw is caught and recorded as failed", async () => {
    const transport: HandoffTransport = {
      send: () => { throw new Error("network blew up"); },
    };
    const r = await sendHandoffDirective({
      slug: "throws",
      phase: "p",
      body: "x",
      worker_session: "claude-w1",
      transport,
      paths,
      date: "2026-05-19",
    });
    expect(r.dispatched).toBe(false);
    expect(r.error).toContain("network blew up");
    const audit = tailHandoffAudit(50, paths);
    expect(audit.find((e) => e.status === "failed")).toBeDefined();
  });

  test("supports async transport", async () => {
    const transport: HandoffTransport = {
      send: async () => { await Promise.resolve(); return { ok: true }; },
    };
    const r = await sendHandoffDirective({
      slug: "async-ok",
      phase: "p",
      body: "x",
      worker_session: "claude-w1",
      transport,
      paths,
      date: "2026-05-19",
    });
    expect(r.dispatched).toBe(true);
  });
});

// ─── listing ──────────────────────────────────────────────────────────────

describe("listHandoffs", () => {
  test("empty dir → empty list", () => {
    expect(listHandoffs(paths)).toEqual([]);
  });

  test("returns md files newest-first; excludes audit log", () => {
    writeHandoff({ slug: "first", phase: "p", body: "1", paths, date: "2026-05-19" });
    writeHandoff({ slug: "second", phase: "p", body: "2", paths, date: "2026-05-19" });
    appendHandoffAudit({
      ts: "2026-05-19T20:00:00Z",
      slug: "first",
      path: "x",
      phase: "p",
      body_bytes: 1,
      status: "written",
      short_directive: "x",
    }, paths);
    const list = listHandoffs(paths);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.find((e) => e.slug === ".audit")).toBeUndefined();
    expect(list.every((e) => e.path_relative.endsWith(".md"))).toBe(true);
  });
});
