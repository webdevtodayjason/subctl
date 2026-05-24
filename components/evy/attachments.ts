// Phase 3l — Document attachments in chat.
//
// Storage layout:
//   ~/.config/subctl/master/attachments/
//   ├── 2026-05-10/
//   │   ├── a1b2c3d4-foothold-spec.md
//   │   └── e5f6a7b8-pasted-2026-05-10-1342.md
//   └── index.jsonl
//
// One JSONL line per attachment in index.jsonl:
//   {id, filename, sha256, size, mime, source, created_at, deleted_at?}
//
// The master daemon's /chat endpoint accepts {text, attachments: [id…]}.
// When a body has attachments, server resolves each id → reads file bytes
// → prepends an <attachment id="…" filename="…" size="…">…</attachment>
// block to the prompt text. The chat transcript records the user text +
// an `attachments: [{id, filename, size}]` array (NOT inline content);
// after auto-compaction drops the inline content, the master can re-fetch
// via the `read_attachment(id)` tool.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
const ROOT = join(SUBCTL_CONFIG_DIR, "master", "attachments");
const INDEX_PATH = join(ROOT, "index.jsonl");

// Phase 1 mime allowlist. Anything outside this set is refused — operator
// can still drop a binary into the vault directly if they have a specific
// reason. Spec §3l: text/* + JSON/YAML inline; PDF/image stored but only
// referenced (deferred to phase 2). Phase 1 ships text-family only.
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/xml",
  "application/javascript",
  "application/typescript",
]);
// Phase 1 size cap. Anything bigger gets refused with a hint pointing
// at the vault (tier-3 storage) for large documents.
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface Attachment {
  id: string;
  filename: string;
  sha256: string;
  size: number;
  mime: string;
  source: "upload" | "paste" | "tool";
  created_at: string;
  deleted_at: string | null;
  storage_path: string;
}

function ensureRoot(): void {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
  if (!existsSync(INDEX_PATH)) writeFileSync(INDEX_PATH, "");
}

function readIndex(): Attachment[] {
  ensureRoot();
  const raw = readFileSync(INDEX_PATH, "utf8");
  const out: Attachment[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Attachment);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function rewriteIndex(entries: Attachment[]): void {
  ensureRoot();
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(INDEX_PATH, body + (body ? "\n" : ""));
}

function makeId(): string {
  return randomBytes(8).toString("hex");
}

function todayDir(): string {
  return new Date().toISOString().slice(0, 10);
}

function isAllowedMime(mime: string): boolean {
  if (TEXT_MIME_EXACT.has(mime)) return true;
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function inferMime(filename: string, fallback?: string): string {
  if (fallback) return fallback;
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".toml")) return "application/toml";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "application/typescript";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "text/x-shellscript";
  if (lower.endsWith(".py")) return "text/x-python";
  return "text/plain";
}

function sanitizeFilename(name: string): string {
  // Strip path separators and control chars; keep the rest intact.
  return name.replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 200);
}

export interface SaveResult {
  ok: boolean;
  attachment?: Attachment;
  error?: string;
  hint?: string;
}

export function saveAttachment(
  body: Buffer,
  rawFilename: string,
  mimeHint: string | undefined,
  source: "upload" | "paste" | "tool",
): SaveResult {
  if (body.length === 0) {
    return { ok: false, error: "empty body" };
  }
  if (body.length > MAX_BYTES) {
    return {
      ok: false,
      error: `attachment too large: ${body.length} bytes (cap ${MAX_BYTES})`,
      hint: "Phase 1 cap is 5 MiB. For larger documents use the vault directly via vault_append, or split into parts.",
    };
  }
  const filename = sanitizeFilename(rawFilename || "untitled.txt");
  const mime = inferMime(filename, mimeHint);
  if (!isAllowedMime(mime)) {
    return {
      ok: false,
      error: `mime type not allowed: ${mime}`,
      hint: "Phase 1 accepts text/* + JSON/YAML/TOML/XML. PDF + image support deferred to Phase 2 (vision-capable supervisor required).",
    };
  }

  ensureRoot();
  const dateDir = todayDir();
  const dir = join(ROOT, dateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const id = makeId();
  const storagePath = join(dir, `${id}-${filename}`);
  writeFileSync(storagePath, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const entry: Attachment = {
    id,
    filename,
    sha256,
    size: body.length,
    mime,
    source,
    created_at: new Date().toISOString(),
    deleted_at: null,
    storage_path: storagePath,
  };
  appendFileSync(INDEX_PATH, JSON.stringify(entry) + "\n");
  return { ok: true, attachment: entry };
}

export function listAttachments(opts?: { include_deleted?: boolean }): Attachment[] {
  const all = readIndex();
  if (opts?.include_deleted) return all;
  return all.filter((e) => e.deleted_at === null);
}

export function getAttachment(id: string): Attachment | null {
  return readIndex().find((e) => e.id === id && e.deleted_at === null) ?? null;
}

export function readAttachmentContent(
  id: string,
  range?: { start?: number; end?: number },
): { ok: boolean; content?: string; bytes?: number; error?: string; attachment?: Attachment } {
  const att = getAttachment(id);
  if (!att) return { ok: false, error: `no attachment with id=${id}` };
  if (!existsSync(att.storage_path)) {
    return { ok: false, error: `index has id=${id} but file is missing at ${att.storage_path}`, attachment: att };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(att.storage_path);
  } catch (err) {
    return { ok: false, error: (err as Error).message, attachment: att };
  }
  if (range && (typeof range.start === "number" || typeof range.end === "number")) {
    const start = Math.max(0, range.start ?? 0);
    const end = Math.min(buf.length, range.end ?? buf.length);
    buf = buf.slice(start, end);
  }
  return {
    ok: true,
    content: buf.toString("utf8"),
    bytes: buf.length,
    attachment: att,
  };
}

export function deleteAttachment(id: string): { ok: boolean; error?: string } {
  const all = readIndex();
  const idx = all.findIndex((e) => e.id === id && e.deleted_at === null);
  if (idx === -1) return { ok: false, error: `no attachment with id=${id}` };
  const entry = all[idx]!;
  entry.deleted_at = new Date().toISOString();
  // Soft-delete in the index, hard-delete the file on disk to reclaim space.
  try {
    if (existsSync(entry.storage_path)) unlinkSync(entry.storage_path);
  } catch {
    /* ignore — file may be gone already */
  }
  all[idx] = entry;
  rewriteIndex(all);
  return { ok: true };
}

// Build the inline <attachment>…</attachment> blocks the master daemon
// prepends to a chat message that has attachments. Used by /chat when
// the body includes `attachments: [id…]`.
//
// Each block is fenced so the model can clearly distinguish attachment
// content from the user's own text. Block format:
//
//   <attachment id="a1b2c3d4" filename="foothold-spec.md" size="21568">
//   …content…
//   </attachment>
//
// Per spec §3l: chat transcript stores attachment metadata only; the
// model SEES the inline content during the prompt. After compaction the
// inline content goes away; the master re-fetches via `read_attachment`.
export function inlineAttachmentBlocks(
  ids: ReadonlyArray<string>,
): { ok: boolean; text: string; resolved: Array<{ id: string; filename: string; size: number }>; errors: string[] } {
  const blocks: string[] = [];
  const resolved: Array<{ id: string; filename: string; size: number }> = [];
  const errors: string[] = [];
  for (const id of ids) {
    const r = readAttachmentContent(id);
    if (!r.ok) {
      errors.push(`${id}: ${r.error}`);
      continue;
    }
    const att = r.attachment!;
    blocks.push(
      `<attachment id="${att.id}" filename="${att.filename}" size="${att.size}" mime="${att.mime}">\n${r.content}\n</attachment>`,
    );
    resolved.push({ id: att.id, filename: att.filename, size: att.size });
  }
  return {
    ok: errors.length === 0,
    text: blocks.join("\n\n"),
    resolved,
    errors,
  };
}

// Garbage-collection helper. Removes index entries older than `maxAgeDays`
// that haven't been referenced anywhere AND any orphan files on disk that
// the index doesn't know about (defensive, e.g., after partial writes).
// Returns counts. Reference-tracking is operator's job for now — we don't
// scan the transcript automatically. Phase 2 would add that.
export function gc(maxAgeDays: number): { removed_index: number; removed_files: number } {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const all = readIndex();
  let removed_index = 0;
  const kept: Attachment[] = [];
  for (const e of all) {
    const ts = Date.parse(e.deleted_at ?? e.created_at);
    if (e.deleted_at !== null && ts < cutoff) {
      // Already soft-deleted long enough ago — drop from index.
      removed_index++;
      try {
        if (existsSync(e.storage_path)) unlinkSync(e.storage_path);
      } catch { /* ignore */ }
      continue;
    }
    kept.push(e);
  }
  if (removed_index > 0) rewriteIndex(kept);

  // Find orphan files (on disk, not in index).
  let removed_files = 0;
  if (existsSync(ROOT)) {
    const knownPaths = new Set(kept.map((e) => e.storage_path));
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subdir = join(ROOT, entry.name);
      for (const f of readdirSync(subdir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const p = join(subdir, f.name);
        if (knownPaths.has(p)) continue;
        const age = Date.now() - statSync(p).mtimeMs;
        if (age > maxAgeDays * 24 * 60 * 60 * 1000) {
          try {
            unlinkSync(p);
            removed_files++;
          } catch { /* ignore */ }
        }
      }
    }
  }
  return { removed_index, removed_files };
}
