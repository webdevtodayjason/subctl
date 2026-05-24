// components/evy/handoff-directive.ts
//
// #29 — Handoff-file directive transport (control-plane reliability fix).
//
// Operator-observed bug, 2026-05-19: long supervisor-to-worker
// directives sent through raw tmux `send-keys` exhibit body-shape
// drift — newlines wrap, embedded characters get mangled, the HMAC
// computed on the master side stops matching the body the worker
// reads. Auto-nudges (short, single-line, well-known shape) verified
// fine; longer manual directives failed mac repeatedly.
//
// The fix is to STOP routing long payloads through raw tmux input.
// Instead:
//
//   1. Master writes the full directive body to a handoff file under
//      .subctl/docs/handoffs/YYYY-MM-DD-<slug>.md, with frontmatter
//      identifying phase, slug, intended worker session, and the
//      original master ts/hmac.
//   2. Master sends the worker a SHORT, single-line directive only:
//      "read handoff <relative-path> and proceed". That short
//      directive can carry an HMAC just like any other auto-nudge
//      and survives the tmux transport because it's short + simple.
//   3. Worker reads the file from disk locally — exact bytes,
//      newlines, embedded quotes all preserved without going through
//      a shell input layer.
//
// This module exposes the master-side helpers. The worker-side
// reading is just "Read tool on the file" — no special wiring
// required.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// ─── path conventions ──────────────────────────────────────────────────────

const HANDOFFS_REL_DIR = join(".subctl", "docs", "handoffs");
const AUDIT_FILENAME = ".audit.jsonl";

export interface HandoffPaths {
  /** Absolute path to the handoffs directory. */
  dir: string;
  /** Absolute path to the audit JSONL. */
  audit_path: string;
  /** Repo root used to resolve relative paths back. */
  repo_root: string;
}

/**
 * Resolve canonical handoff paths under a repo root. Defaults to
 * `process.cwd()`. Tests pass an explicit root.
 */
export function resolveHandoffPaths(repoRoot?: string): HandoffPaths {
  const root = repoRoot ?? process.cwd();
  return {
    dir: join(root, HANDOFFS_REL_DIR),
    audit_path: join(root, HANDOFFS_REL_DIR, AUDIT_FILENAME),
    repo_root: root,
  };
}

// ─── slug + path safety ────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate a slug. Allowed: lowercase alnum + hyphens, 1–64 chars,
 * cannot start with a hyphen. Anything else throws — `..`, slashes,
 * spaces, uppercase, etc. all fail. The slug becomes a path
 * component, so the regex is the only sanitization that matters.
 */
export function assertValidSlug(slug: unknown): asserts slug is string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new Error(
      `invalid handoff slug: ${JSON.stringify(slug)} — must match ${SLUG_RE.source}`,
    );
  }
}

/**
 * Sanity-check that a resolved absolute path is INSIDE the handoffs
 * directory. Guards against any future code that builds paths from
 * partially-trusted inputs.
 */
export function assertInsideHandoffsDir(absPath: string, paths: HandoffPaths): void {
  const resolved = resolve(absPath);
  const dir = resolve(paths.dir) + sep;
  if (!(resolved + sep).startsWith(dir)) {
    throw new Error(
      `handoff path escapes the handoffs dir: ${absPath} not under ${paths.dir}`,
    );
  }
}

// ─── frontmatter shape ─────────────────────────────────────────────────────

export interface HandoffFrontmatter {
  /** ISO datestamp baked into the filename. */
  date: string;
  /** Kebab-case slug, must match SLUG_RE. */
  slug: string;
  /** Phase the directive carries. */
  phase: string;
  /** Worker session the directive is aimed at. */
  worker_session?: string;
  /** ISO timestamp the file was written. */
  ts: string;
  /** Optional original master HMAC (for traceability, NOT used for re-verification). */
  origin_hmac?: string;
  /** Optional reason / why-line. */
  why?: string;
  /** Free-form key/value bag for forward-compat. */
  extra?: Record<string, string | number | boolean>;
}

function renderFrontmatter(fm: HandoffFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`date: ${fm.date}`);
  lines.push(`slug: ${fm.slug}`);
  lines.push(`phase: ${fm.phase}`);
  if (fm.worker_session) lines.push(`worker_session: ${fm.worker_session}`);
  lines.push(`ts: ${fm.ts}`);
  if (fm.origin_hmac) lines.push(`origin_hmac: ${fm.origin_hmac}`);
  if (fm.why) lines.push(`why: ${JSON.stringify(fm.why)}`);
  if (fm.extra) {
    for (const [k, v] of Object.entries(fm.extra)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

// ─── write ─────────────────────────────────────────────────────────────────

export interface WriteHandoffInput {
  slug: string;
  phase: string;
  body: string;
  worker_session?: string;
  origin_hmac?: string;
  why?: string;
  extra?: HandoffFrontmatter["extra"];
  /** Override the date prefix (UTC YYYY-MM-DD). Default: today UTC. */
  date?: string;
  /** Override resolved paths (tests). */
  paths?: HandoffPaths;
  /** ISO timestamp override (tests). Default: now. */
  ts?: string;
}

export interface WriteHandoffResult {
  /** Absolute path of the written file. */
  path_absolute: string;
  /** Repo-relative path — what the short directive references. */
  path_relative: string;
  slug: string;
  date: string;
  ts: string;
  bytes: number;
}

function todayUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Write a handoff file. Filename pattern: `YYYY-MM-DD-<slug>.md`. If a
 * file with that name already exists the function appends `-N` to the
 * slug until it finds a free name — never overwrites. Returns the
 * absolute + repo-relative paths so the caller can plug the relative
 * path into the short directive.
 */
export function writeHandoff(input: WriteHandoffInput): WriteHandoffResult {
  assertValidSlug(input.slug);
  if (typeof input.phase !== "string" || input.phase.length === 0) {
    throw new Error("handoff phase required");
  }
  if (typeof input.body !== "string") {
    throw new Error("handoff body must be a string");
  }
  const paths = input.paths ?? resolveHandoffPaths();
  const date = input.date ?? todayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid handoff date: ${date} (need YYYY-MM-DD)`);
  }
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true });

  let candidate = `${date}-${input.slug}`;
  let abs = join(paths.dir, candidate + ".md");
  let n = 1;
  while (existsSync(abs)) {
    candidate = `${date}-${input.slug}-${n++}`;
    abs = join(paths.dir, candidate + ".md");
    if (n > 999) throw new Error("could not find a free handoff filename");
  }
  assertInsideHandoffsDir(abs, paths);

  const ts = input.ts ?? new Date().toISOString();
  const fm: HandoffFrontmatter = {
    date,
    slug: candidate,
    phase: input.phase,
    worker_session: input.worker_session,
    ts,
    origin_hmac: input.origin_hmac,
    why: input.why,
    extra: input.extra,
  };
  const content = renderFrontmatter(fm) + (input.body.endsWith("\n") ? input.body : input.body + "\n");
  writeFileSync(abs, content);

  const rel = relative(paths.repo_root, abs);
  return {
    path_absolute: abs,
    path_relative: rel,
    slug: candidate,
    date,
    ts,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

// ─── short directive ───────────────────────────────────────────────────────

/**
 * Build the short, transport-safe directive that points the worker at
 * a handoff file. Single line. Stable shape so HMAC signing and
 * idle-pane registry matching both work cleanly.
 */
export function buildShortDirective(handoffPathRelative: string): string {
  if (typeof handoffPathRelative !== "string" || handoffPathRelative.length === 0) {
    throw new Error("buildShortDirective: empty path");
  }
  if (isAbsolute(handoffPathRelative)) {
    throw new Error("buildShortDirective: path must be repo-relative, got absolute");
  }
  // Never break the line — wrapping is exactly the bug this avoids.
  return `read handoff ${handoffPathRelative} and proceed`;
}

// ─── audit ─────────────────────────────────────────────────────────────────

export interface HandoffAuditEntry {
  ts: string;
  slug: string;
  path: string;
  phase: string;
  worker_session?: string;
  body_bytes: number;
  status: "written" | "dispatched" | "failed";
  short_directive: string;
  transport_error?: string;
}

export function appendHandoffAudit(
  entry: HandoffAuditEntry,
  paths?: HandoffPaths,
): void {
  const p = paths ?? resolveHandoffPaths();
  if (!existsSync(dirname(p.audit_path))) mkdirSync(dirname(p.audit_path), { recursive: true });
  appendFileSync(p.audit_path, JSON.stringify(entry) + "\n");
}

export function tailHandoffAudit(n = 50, paths?: HandoffPaths): HandoffAuditEntry[] {
  const p = paths ?? resolveHandoffPaths();
  if (!existsSync(p.audit_path)) return [];
  let text: string;
  try { text = readFileSync(p.audit_path, "utf8"); } catch { return []; }
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out: HandoffAuditEntry[] = [];
  for (const line of lines.slice(-n)) {
    try { out.push(JSON.parse(line) as HandoffAuditEntry); } catch { /* skip */ }
  }
  return out;
}

// ─── listing ───────────────────────────────────────────────────────────────

export interface HandoffSummary {
  slug: string;
  path_relative: string;
  bytes: number;
  mtime: string;
}

/** Enumerate handoff files (excluding the audit log). Newest mtime first. */
export function listHandoffs(paths?: HandoffPaths): HandoffSummary[] {
  const p = paths ?? resolveHandoffPaths();
  if (!existsSync(p.dir)) return [];
  const entries: HandoffSummary[] = [];
  for (const name of readdirSync(p.dir)) {
    if (name === AUDIT_FILENAME) continue;
    if (!name.endsWith(".md")) continue;
    const abs = join(p.dir, name);
    try {
      const st = statSync(abs);
      entries.push({
        slug: name.replace(/\.md$/, ""),
        path_relative: relative(p.repo_root, abs),
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      });
    } catch { /* skip */ }
  }
  entries.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return entries;
}

// ─── one-shot dispatcher ───────────────────────────────────────────────────

export interface HandoffTransport {
  /**
   * Deliver the short directive to a worker. Implementations: tmux
   * send-keys, a stub that just records the call, etc. Should return
   * { ok: true } on successful delivery or { ok: false, error } on
   * failure. NEVER throw — failure must be recorded in audit.
   */
  send: (input: { worker_session: string; short_directive: string }) =>
    Promise<{ ok: true } | { ok: false; error: string }> |
    { ok: true } | { ok: false; error: string };
}

export interface SendHandoffInput extends Omit<WriteHandoffInput, "worker_session"> {
  worker_session: string;
  transport: HandoffTransport;
}

export interface SendHandoffResult {
  written: WriteHandoffResult;
  short_directive: string;
  dispatched: boolean;
  error?: string;
}

/**
 * End-to-end: write the handoff file, build the short directive,
 * dispatch through the injected transport, append audit. The transport
 * is the only piece that touches tmux — keeping it injectable means
 * tests can verify the dispatch contract without spinning up a real
 * worker.
 */
export async function sendHandoffDirective(
  input: SendHandoffInput,
): Promise<SendHandoffResult> {
  const written = writeHandoff({
    slug: input.slug,
    phase: input.phase,
    body: input.body,
    worker_session: input.worker_session,
    origin_hmac: input.origin_hmac,
    why: input.why,
    extra: input.extra,
    date: input.date,
    paths: input.paths,
    ts: input.ts,
  });
  const short = buildShortDirective(written.path_relative);

  const baseAudit: HandoffAuditEntry = {
    ts: written.ts,
    slug: written.slug,
    path: written.path_relative,
    phase: input.phase,
    worker_session: input.worker_session,
    body_bytes: written.bytes,
    status: "written",
    short_directive: short,
  };
  try { appendHandoffAudit(baseAudit, input.paths); } catch { /* best-effort */ }

  let result: { ok: true } | { ok: false; error: string };
  try {
    result = await Promise.resolve(input.transport.send({
      worker_session: input.worker_session,
      short_directive: short,
    }));
  } catch (err) {
    result = { ok: false, error: (err as Error).message ?? String(err) };
  }

  const dispatched = result.ok === true;
  const finalAudit: HandoffAuditEntry = {
    ...baseAudit,
    ts: new Date().toISOString(),
    status: dispatched ? "dispatched" : "failed",
    ...(dispatched ? {} : { transport_error: (result as { ok: false; error: string }).error }),
  };
  try { appendHandoffAudit(finalAudit, input.paths); } catch { /* best-effort */ }

  return {
    written,
    short_directive: short,
    dispatched,
    ...(dispatched ? {} : { error: (result as { ok: false; error: string }).error }),
  };
}
