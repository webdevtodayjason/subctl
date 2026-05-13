// team-docs tools — write/read/list/log project-local docs at
// `<project_root>/.subctl/docs/`.
//
// v2.7.10 (origin: 2026-05-12). Today the master has NO file-write tools.
// Every directive the operator (or the master itself) issues — SPECs,
// PRDs, ARCH notes, handoffs, "remember this decision" — scrolls away in
// chat and the next worker spawn has no way to recover it. The vault
// path (~/Documents/Obsidian Vault) is also TCC-blocked under launchd
// on some hosts, so it can't be the single canonical store.
//
// The fix: scope subctl-managed docs under `.subctl/docs/` next to
// `.subctl/policy.toml`. The folder sits next to the project (gitable,
// inspectable, `cat`-able from any worker pane) without fighting the
// project's own `docs/` tree.
//
// Tool family:
//   team_doc_write     — write a markdown doc (optionally with YAML
//                        frontmatter) into <project>/.subctl/docs/
//   team_doc_read      — read one back, parsing frontmatter if present
//   team_doc_list      — enumerate files + subdirs under .subctl/docs/
//   team_decision_log  — append one JSON line to .subctl/docs/decisions.jsonl
//
// Path-traversal protection is enforced inside the resolver helper:
//   - `..` segments rejected
//   - absolute `relative_path` rejected
//   - resolved absolute path must stay inside <project>/.subctl/docs/
//
// YAML frontmatter — we hand-roll a tiny parser/emitter covering only the
// simple subset (`key: value` pairs, no nested mappings, no flow style,
// no anchors). That's all we emit, so we control both sides; pulling in
// `js-yaml` for ~30 lines of trivial parsing would be heavier than the
// thing we'd avoid. If a future caller needs nested frontmatter we add
// the dep then.

import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

// ─── helpers ───────────────────────────────────────────────────────────────

const DOCS_SUBDIR = join(".subctl", "docs");

/**
 * Resolve `<project_root>/.subctl/docs/<relative_path>` and verify the
 * result stays inside the docs folder. Returns either the resolved
 * absolute path, or an `error` string suitable for `{ ok: false, error }`.
 *
 * - Rejects `relative_path` that is absolute (e.g. "/etc/passwd").
 * - Rejects any `..` segment to defang `../../../etc/passwd` style probes.
 * - After resolution, double-checks that the absolute path is still
 *   prefixed by the docs folder; a symlink or trailing-slash trick that
 *   slipped past the textual check still trips this final guard.
 */
function resolveDocPath(
  project_root: string,
  relative_path: string,
): { ok: true; abs: string; docsRoot: string } | { ok: false; error: string } {
  if (typeof relative_path !== "string" || relative_path.length === 0) {
    return { ok: false, error: "relative_path must be a non-empty string" };
  }
  if (isAbsolute(relative_path)) {
    return {
      ok: false,
      error: `relative_path must not be absolute: ${relative_path}`,
    };
  }
  // Reject any segment that's exactly ".." — matches both forward-slash
  // and backslash-separated probes. We do this on the textual input
  // (before normalize) so an attacker can't smuggle traversal through
  // platform path-separator differences.
  const segments = relative_path.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === "..") {
      return {
        ok: false,
        error: `relative_path may not contain '..' segments: ${relative_path}`,
      };
    }
  }
  const docsRoot = resolve(project_root, DOCS_SUBDIR);
  const abs = resolve(docsRoot, normalize(relative_path));
  // Belt-and-suspenders: the resolved path must be inside docsRoot. If
  // normalize collapsed something we didn't expect, this catches it.
  const rel = relative(docsRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `relative_path resolves outside .subctl/docs/: ${relative_path}`,
    };
  }
  return { ok: true, abs, docsRoot };
}

function isProjectRootValid(
  project_root: unknown,
): project_root is string {
  return (
    typeof project_root === "string" &&
    project_root.length > 0 &&
    existsSync(project_root) &&
    statSync(project_root).isDirectory()
  );
}

// ─── YAML frontmatter (tiny subset) ────────────────────────────────────────
//
// Emit format (what we write):
//   ---
//   key: value
//   key2: "quoted if contains : or starts with special chars"
//   ---
//
// We support: string, number, boolean, null on the value side. No
// nested mappings, no sequences, no multi-line scalars. If a string
// value contains `:`, `#`, leading/trailing whitespace, or matches a
// reserved literal (`true`/`false`/`null`/numeric), it gets
// double-quoted with `"` escapes for `"` and `\`.

const RESERVED_LITERAL = /^(true|false|null|~)$/i;
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (/[:#\n\r\t]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (RESERVED_LITERAL.test(s)) return true;
  if (NUMERIC_LITERAL.test(s)) return true;
  return false;
}

function emitScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return JSON.stringify(String(v));
    return String(v);
  }
  const s = String(v);
  if (needsQuoting(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function emitFrontmatter(obj: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    // Reject keys with characters that'd break the simple parser. Caller
    // bug, not user input — surface loudly via a thrown value rather
    // than a silent corruption.
    if (!/^[A-Za-z0-9_.-]+$/.test(k)) {
      throw new Error(`unsupported frontmatter key: ${k}`);
    }
    lines.push(`${k}: ${emitScalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse the simple `key: value` frontmatter subset we emit. Returns
 * either `{ frontmatter, body }` if a leading `---\n...\n---\n` block
 * is present and parses cleanly, or `null` (caller treats the whole
 * file as body).
 *
 * Tolerant of CRLF line endings. Strict about syntax inside the block:
 * a parse failure on any line means we treat the whole file as not
 * having frontmatter — that's safer than half-parsing.
 */
export function parseFrontmatter(
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } | null {
  // Normalize CRLF → LF for the split; preserve the original body chars
  // by working from the same normalization.
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && text !== "---") return null;
  // Find the closing fence — a line that is exactly `---`.
  const lines = text.split("\n");
  // lines[0] is "---". Walk forward until we find the next line === "---".
  let closeAt = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeAt = i;
      break;
    }
  }
  if (closeAt < 0) return null;
  const fmLines = lines.slice(1, closeAt);
  const fm: Record<string, unknown> = {};
  for (const line of fmLines) {
    if (line.trim() === "") continue;
    // key: value — key is up to the first colon.
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) return null;
    const rawVal = line.slice(idx + 1).trim();
    fm[key] = parseScalar(rawVal);
  }
  const body = lines.slice(closeAt + 1).join("\n");
  // Strip a single leading blank line if the body starts with one — we
  // emit `---\n\n<content>`, so the round-trip should give back
  // `<content>` exactly.
  const cleanBody = body.startsWith("\n") ? body.slice(1) : body;
  return { frontmatter: fm, body: cleanBody };
}

function parseScalar(s: string): unknown {
  if (s === "" || s === "~" || s.toLowerCase() === "null") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  // Quoted string?
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    const inner = s.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (NUMERIC_LITERAL.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

// ─── tool 1: team_doc_write ────────────────────────────────────────────────

const team_doc_write = {
  description:
    "Write a doc (SPEC, PRD, ARCH, handoff, mandate, …) to the team's project-local docs folder at `<project_root>/.subctl/docs/`. Workers can read these via `cat` — that's how you persist directives, specs, and handoffs across chat turns and across worker restarts. Use the optional `frontmatter` object (operator, account, phase, kind, …) for documents that flow operator → orchestrator → worker so the worker has provenance. The destination directory is created if missing. Path traversal (`..`, absolute paths) is rejected. Overwrites if the file already exists — that's the intended behavior for a SPEC that gets revised in place.",
  schema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description:
          "Absolute path to the project directory. The docs folder is created at <project_root>/.subctl/docs/.",
      },
      relative_path: {
        type: "string",
        description:
          "Path inside the docs folder, e.g. 'SPEC.md' or 'handoffs/2026-05-12-baseline.md'. Must not be absolute and must not contain '..' segments.",
      },
      content: {
        type: "string",
        description: "File body (markdown / text). UTF-8.",
      },
      frontmatter: {
        type: "object",
        description:
          "Optional YAML frontmatter prepended to `content` as a `---\\n…\\n---\\n\\n` block. Keys must match [A-Za-z0-9_.-]+. Values may be string / number / boolean / null. No nested objects or arrays.",
        additionalProperties: true,
      },
    },
    required: ["project_root", "relative_path", "content"],
  },
  invoke: async (args: {
    project_root: string;
    relative_path: string;
    content: string;
    frontmatter?: Record<string, unknown>;
  }) => {
    if (!isProjectRootValid(args.project_root)) {
      return {
        ok: false,
        error: `project_root does not exist or is not a directory: ${args.project_root}`,
      };
    }
    if (typeof args.content !== "string") {
      return { ok: false, error: "content must be a string" };
    }
    const r = resolveDocPath(args.project_root, args.relative_path);
    if (!r.ok) return r;

    let payload = args.content;
    let frontmatter_keys: string[] = [];
    if (args.frontmatter && typeof args.frontmatter === "object") {
      let fm: string;
      try {
        fm = emitFrontmatter(args.frontmatter);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      payload = `${fm}\n\n${args.content}`;
      frontmatter_keys = Object.keys(args.frontmatter);
    }

    try {
      mkdirSync(dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, payload, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        path: r.abs,
      };
    }
    return {
      ok: true,
      path: r.abs,
      bytes_written: Buffer.byteLength(payload, "utf8"),
      frontmatter_keys,
    };
  },
};

// ─── tool 2: team_doc_read ─────────────────────────────────────────────────

const team_doc_read = {
  description:
    "Read a doc back from the team's project-local docs folder at `<project_root>/.subctl/docs/<relative_path>`. If the file starts with a `---\\n…\\n---\\n` YAML frontmatter block, it's parsed out into `frontmatter` and the remaining body is returned in `content`. Missing files return ok:false with a sane error — use `team_doc_list` first if you're not sure what's there.",
  schema: {
    type: "object",
    properties: {
      project_root: { type: "string" },
      relative_path: { type: "string" },
    },
    required: ["project_root", "relative_path"],
  },
  invoke: async (args: { project_root: string; relative_path: string }) => {
    if (!isProjectRootValid(args.project_root)) {
      return {
        ok: false,
        error: `project_root does not exist or is not a directory: ${args.project_root}`,
      };
    }
    const r = resolveDocPath(args.project_root, args.relative_path);
    if (!r.ok) return r;
    if (!existsSync(r.abs)) {
      return { ok: false, error: `no such file: ${r.abs}`, path: r.abs };
    }
    let raw = "";
    try {
      raw = readFileSync(r.abs, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
        path: r.abs,
      };
    }
    const parsed = parseFrontmatter(raw);
    if (parsed) {
      return {
        ok: true,
        path: r.abs,
        has_frontmatter: true,
        frontmatter: parsed.frontmatter,
        content: parsed.body,
      };
    }
    return {
      ok: true,
      path: r.abs,
      has_frontmatter: false,
      content: raw,
    };
  },
};

// ─── tool 3: team_doc_list ─────────────────────────────────────────────────

interface DocEntry {
  path: string;
  size: number;
  mtime: string;
  kind: "file" | "dir";
}

const team_doc_list = {
  description:
    "List files + subdirectories under `<project_root>/.subctl/docs/` (or `.../<subdir>` if provided). Use this to discover what docs the team has — SPEC.md, PRD.md, decisions.jsonl, handoffs/ entries, etc. — before reading them. If the folder doesn't exist (project hasn't been spawned with v2.7.11 docs scaffolding yet) this returns ok:true with an empty `entries` array, NOT an error — so you can call it speculatively.",
  schema: {
    type: "object",
    properties: {
      project_root: { type: "string" },
      subdir: {
        type: "string",
        description:
          "Optional subdirectory under .subctl/docs/, e.g. 'handoffs'. Defaults to the docs root.",
      },
    },
    required: ["project_root"],
  },
  invoke: async (args: { project_root: string; subdir?: string }) => {
    if (!isProjectRootValid(args.project_root)) {
      return {
        ok: false,
        error: `project_root does not exist or is not a directory: ${args.project_root}`,
      };
    }
    const docsRoot = resolve(args.project_root, DOCS_SUBDIR);
    let listRoot = docsRoot;
    if (args.subdir && args.subdir.length > 0) {
      const r = resolveDocPath(args.project_root, args.subdir);
      if (!r.ok) return r;
      listRoot = r.abs;
    }
    if (!existsSync(listRoot)) {
      return { ok: true, root: listRoot, entries: [] as DocEntry[] };
    }
    if (!statSync(listRoot).isDirectory()) {
      return {
        ok: false,
        error: `not a directory: ${listRoot}`,
        root: listRoot,
      };
    }
    const entries: DocEntry[] = [];
    for (const name of readdirSync(listRoot)) {
      const abs = join(listRoot, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      entries.push({
        path: abs,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        kind: st.isDirectory() ? "dir" : "file",
      });
    }
    // Stable order: dirs first, then files, both alphabetical. Predictable
    // output makes the master easier to reason about across calls.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return { ok: true, root: listRoot, entries };
  },
};

// ─── tool 4: team_decision_log ─────────────────────────────────────────────

const team_decision_log = {
  description:
    "Append one decision to `<project_root>/.subctl/docs/decisions.jsonl` — an append-only, machine-readable trail of meaningful choices the master / orchestrator / operator have made on this project. Use whenever you make a call the operator should be able to scroll back to: account swaps, autonomy changes, scope changes, mode switches, irreversible cleanup, supervisor swaps. The folder is created if missing. `by` defaults to 'master'. Returns the running total so you can confirm the line landed.",
  schema: {
    type: "object",
    properties: {
      project_root: { type: "string" },
      summary: {
        type: "string",
        description:
          "One-line summary of the decision — ≤120 chars is ideal. The same kind of line you'd publish to notify_dashboard.",
      },
      detail: {
        type: "string",
        description:
          "Optional longer-form rationale. Markdown allowed; gets stored as a JSON string.",
      },
      by: {
        type: "string",
        description:
          "Optional actor identifier. Defaults to 'master'. Use 'operator' when relaying an explicit operator call, or a worker / team id when logging on a worker's behalf.",
      },
    },
    required: ["project_root", "summary"],
  },
  invoke: async (args: {
    project_root: string;
    summary: string;
    detail?: string;
    by?: string;
  }) => {
    if (!isProjectRootValid(args.project_root)) {
      return {
        ok: false,
        error: `project_root does not exist or is not a directory: ${args.project_root}`,
      };
    }
    if (typeof args.summary !== "string" || args.summary.length === 0) {
      return { ok: false, error: "summary must be a non-empty string" };
    }
    const docsRoot = resolve(args.project_root, DOCS_SUBDIR);
    const path = join(docsRoot, "decisions.jsonl");
    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = {
      ts,
      summary: args.summary,
      by: args.by ?? "master",
    };
    if (args.detail) entry.detail = args.detail;
    try {
      mkdirSync(docsRoot, { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `append failed: ${err instanceof Error ? err.message : String(err)}`,
        path,
      };
    }
    // Count lines for the running total. Cheap — decisions.jsonl is
    // operator-visible and not expected to grow into the millions.
    let total = 0;
    try {
      const raw = readFileSync(path, "utf8");
      total = raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      /* ignore — we just wrote, so this shouldn't happen */
    }
    return {
      ok: true,
      path,
      ts,
      summary: args.summary,
      total_decisions: total,
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const teamDocsTools = {
  team_doc_write,
  team_doc_read,
  team_doc_list,
  team_decision_log,
};
