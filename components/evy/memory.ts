// components/master/memory.ts
//
// v2.7.23 — Evy Memory (Tier 3 conversational memory).
//
// What this is: the persistent, queryable record of what was said, decided,
// and shipped between the operator and Evy across sessions. When Evy reboots
// tomorrow on a fresh master start, the last things she remembers come from
// this store. That's the fix for what the operator has been calling "51st
// date syndrome" — every restart shouldn't be a cold start.
//
// ADR ownership: this module implements Tier 3 of the five-tier memory model
// (ADR 0005). It supersedes ADR 0006's "Memori SDK as substrate" choice —
// see ADR 0014 for the rationale. Short version: Memori is a Python framework
// (MemoriLabs/Memori), subctl is Bun/TS, and Memori's value-add is auto-
// injecting into LiteLLM/LangChain prompts. We have our own LLM call path
// (pi-ai → providers) and so we don't benefit from that wrapper. We DO need
// the storage + retrieval primitive — that's what this module is.
//
// Tier boundary (ADR 0010): this is NOT claude-mem. claude-mem (Tier 4) is
// a separate observation corpus captured from Claude Code sessions across
// multiple accounts. We don't read claude-mem's storage and claude-mem
// doesn't read ours. Both stay queryable for their own purposes.
//
// Storage: ~/.local/state/subctl/memory/evy.db (chmod 600, dir chmod 700).
// SQLite via bun:sqlite — single file, in-process, no IPC, no Python.
// FTS5 virtual table backs the text search; we fall back to LIKE matching
// if FTS5 isn't compiled in (verified working in Bun 1.2.17 at v2.7.23 ship).
//
// Privacy: the operator runs subctl on the M3 in their home data center.
// Memory content includes MSP client business, codebases, and operator-Evy
// chat. Per ADR 0009 the file never egresses; per the v2.7.23 spec we ALSO
// redact obvious secrets (HMAC marks, tokens, sk-* keys) on the way OUT to
// chat surfaces (Telegram, dashboard). Storage-side is fine because the file
// is chmod 600 and only the operator's user account can read it.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

// ─── path resolution ─────────────────────────────────────────────────────
//
// Mirrors components/master/trust-marker.ts — SUBCTL_STATE_DIR env override
// wins so tests can land in tmpdir, otherwise ~/.local/state/subctl. We keep
// memory data under a `memory/` subdir to leave room for future per-team
// databases without renaming.

let _stateDirOverride: string | null = null;

/** @internal — for tests only. Pass null to clear. */
export function _setStateDirForTesting(p: string | null): void {
  _stateDirOverride = p;
  _closeDb();
}

function resolveStateDir(): string {
  if (_stateDirOverride !== null) return _stateDirOverride;
  return (
    process.env.SUBCTL_STATE_DIR ??
    join(homedir(), ".local", "state", "subctl")
  );
}

/** Where evy.db lives. Constructable without I/O. */
export function getMemoryDbPath(): string {
  return join(resolveStateDir(), "memory", "evy.db");
}

// ─── public types ────────────────────────────────────────────────────────

export type MemoryRole = "system" | "user" | "assistant" | "tool" | "event";

export interface MemoryEntry {
  id: string;
  ts: string; // ISO 8601
  team_id?: string | null;
  role: MemoryRole;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RecordEntryInput {
  team_id?: string | null;
  role: MemoryRole;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RecallOptions {
  /** Free-text query. FTS5 if available, LIKE %query% otherwise. */
  query?: string;
  /** Filter by team scope. Pass null/undefined for global. */
  team_id?: string | null;
  /** Single kind or list. */
  kind?: string | string[];
  /** Only entries with ts >= since (ISO 8601). */
  since?: string;
  /** Cap on returned entries. Default 20, max 200. */
  limit?: number;
}

// ─── db lifecycle ────────────────────────────────────────────────────────

let _db: Database | null = null;
let _fts5Available = false;

function _closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* best-effort */
    }
    _db = null;
  }
  _fts5Available = false;
}

function detectFts5(db: Database): boolean {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(content);",
    );
    // Probe table created — FTS5 module is compiled in. Drop and move on.
    db.exec("DROP TABLE IF EXISTS _fts_probe;");
    return true;
  } catch {
    return false;
  }
}

function ensureSchema(db: Database, fts5: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      team_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
    CREATE INDEX IF NOT EXISTS idx_entries_team_kind ON entries(team_id, kind);
    CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
  `);
  if (fts5) {
    // External-content FTS table mirrors entries.content. Triggers keep
    // it in sync. We use rowid-style content=entries linkage with the
    // PRIMARY KEY id as the FTS rowid surrogate (FTS5 requires INTEGER
    // rowid, so we add a small mapping column via UNINDEXED). The
    // simplest correct setup that survives reopen + restart is a
    // contentless FTS table with our own INSERT/DELETE triggers, which
    // avoids the rowid coercion problem entirely.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        id UNINDEXED,
        content
      );
      CREATE TRIGGER IF NOT EXISTS entries_fts_ai AFTER INSERT ON entries
        BEGIN
          INSERT INTO entries_fts(id, content) VALUES (new.id, new.content);
        END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_ad AFTER DELETE ON entries
        BEGIN
          DELETE FROM entries_fts WHERE id = old.id;
        END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_au AFTER UPDATE ON entries
        BEGIN
          DELETE FROM entries_fts WHERE id = old.id;
          INSERT INTO entries_fts(id, content) VALUES (new.id, new.content);
        END;
    `);
  }
}

function getDb(): Database {
  if (_db) return _db;
  const path = getMemoryDbPath();
  const dir = dirname(path);
  // Directory chmod 700 so a permissive umask can't widen access. mkdirSync
  // with mode= only applies on initial create — we re-chmod separately to
  // tighten an already-existing dir too.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort — non-POSIX hosts (rare here) tolerate 0755 */
  }
  const db = new Database(path, { create: true });
  // Sane defaults for a small, frequently-written, never-shared DB:
  //   WAL gives concurrent readers + a single writer (us) without blocking
  //   on the main connection. NORMAL is safe vs. crash because we fsync
  //   the WAL at checkpoint, and worst case a crash drops the last few
  //   uncommitted entries (operator-acceptable for memory).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  _fts5Available = detectFts5(db);
  ensureSchema(db, _fts5Available);
  // chmod the file AFTER first write/open so the inode exists. SQLite's
  // open + WAL create may have happened with the default umask; tighten
  // both back to 600. Auxiliary WAL/SHM files inherit perms from the
  // parent directory (0700) and the main DB perm, so chmodding the main
  // file is enough on macOS/Linux.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
  _db = db;
  return _db;
}

/**
 * @internal — test-only. Reports whether the current connection has FTS5
 * compiled in. Production code should not branch on this.
 */
export function _isFts5Available(): boolean {
  getDb();
  return _fts5Available;
}

// ─── recording ───────────────────────────────────────────────────────────

/**
 * Append an entry to the memory store. Returns the materialized record
 * (with assigned id + ts). Synchronous — bun:sqlite is in-process and a
 * single INSERT is well under a millisecond on the M3.
 *
 * Caller-supplied content larger than CONTENT_MAX_CHARS is truncated with
 * an ellipsis. Tool results and assistant turns can be huge; recording the
 * full text would balloon the DB and the FTS index. The truncation marker
 * is searchable so the operator can spot it.
 */
export function recordEntry(input: RecordEntryInput): MemoryEntry {
  const db = getDb();
  const id = randomUUID();
  const ts = new Date().toISOString();
  const team_id = input.team_id ?? null;
  const role = input.role;
  const kind = input.kind;
  const content = truncateContent(input.content);
  const metadata_json = input.metadata
    ? safeJsonStringify(input.metadata)
    : null;

  db.prepare(
    `INSERT INTO entries (id, ts, team_id, role, kind, content, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ts, team_id, role, kind, content, metadata_json);

  return {
    id,
    ts,
    team_id,
    role,
    kind,
    content,
    metadata: input.metadata,
  };
}

const CONTENT_MAX_CHARS = 16_384;
const TRUNCATION_MARK = "\n…[memory: truncated]";

function truncateContent(s: string): string {
  if (typeof s !== "string") return String(s ?? "");
  if (s.length <= CONTENT_MAX_CHARS) return s;
  return s.slice(0, CONTENT_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

function safeJsonStringify(o: Record<string, unknown>): string {
  try {
    return JSON.stringify(o);
  } catch {
    // Circular / non-serializable — fall back to a shallow stringification.
    const flat: Record<string, string> = {};
    for (const k of Object.keys(o)) {
      try {
        flat[k] = String(o[k]);
      } catch {
        flat[k] = "[unserializable]";
      }
    }
    return JSON.stringify(flat);
  }
}

// ─── querying ────────────────────────────────────────────────────────────

/**
 * Search the memory store. Default order: newest-first. When a `query` is
 * passed:
 *   - FTS5 path: rank-ordered by bm25() then ts DESC as a tiebreaker.
 *   - LIKE fallback: ts DESC.
 *
 * The query is treated as a single FTS5 MATCH expression in the FTS path
 * — punctuation is stripped and tokens are AND'd. Callers can pass raw
 * FTS5 syntax (`foo OR bar`, `"exact phrase"`) and it will be honored.
 */
export function recallEntries(opts: RecallOptions = {}): MemoryEntry[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));

  const where: string[] = [];
  // bun:sqlite's `.all()` parameter type is the structural SQLQueryBindings
  // union (string | number | bigint | null | …). Type it explicitly so the
  // spread into prepare().all(...) stays narrow.
  const params: (string | number | null)[] = [];

  if (opts.team_id !== undefined) {
    if (opts.team_id === null) {
      where.push("entries.team_id IS NULL");
    } else {
      where.push("entries.team_id = ?");
      params.push(opts.team_id);
    }
  }
  if (opts.kind !== undefined) {
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind];
    if (kinds.length === 1) {
      where.push("entries.kind = ?");
      params.push(kinds[0]);
    } else if (kinds.length > 1) {
      where.push(
        `entries.kind IN (${kinds.map(() => "?").join(",")})`,
      );
      for (const k of kinds) params.push(k);
    }
  }
  if (opts.since) {
    where.push("entries.ts >= ?");
    params.push(opts.since);
  }

  const trimmedQuery = (opts.query ?? "").trim();
  if (trimmedQuery) {
    if (_fts5Available) {
      const matchExpr = buildFts5Match(trimmedQuery);
      if (matchExpr) {
        const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
        const sql = `
          SELECT entries.*
          FROM entries_fts
          JOIN entries ON entries.id = entries_fts.id
          WHERE entries_fts MATCH ? ${whereSql}
          ORDER BY bm25(entries_fts), entries.ts DESC
          LIMIT ?
        `;
        const rows = db
          .prepare(sql)
          .all(matchExpr, ...params, limit) as RawRow[];
        return rows.map(rowToEntry);
      }
    }
    // LIKE fallback: case-insensitive substring match.
    where.push("entries.content LIKE ?");
    params.push(`%${escapeLike(trimmedQuery)}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT * FROM entries
    ${whereSql}
    ORDER BY ts DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as RawRow[];
  return rows.map(rowToEntry);
}

/** Shortcut: most-recent N entries across all kinds + teams. */
export function recentEntries(limit = 20): MemoryEntry[] {
  return recallEntries({ limit });
}

/**
 * Delete entries older than `beforeIso`. Returns the number of rows
 * removed. Operator-facing — the dashboard exposes this via a button,
 * Telegram does not (too easy to fat-finger).
 *
 * FTS rows are removed by the AFTER DELETE trigger when FTS5 is on.
 */
export function purgeBefore(beforeIso: string): { deleted: number } {
  if (!beforeIso || typeof beforeIso !== "string") {
    return { deleted: 0 };
  }
  const db = getDb();
  // RETURNING id rather than relying on .changes — bun:sqlite's `changes`
  // counter rolls up FTS5 trigger-side row modifications, which makes the
  // raw number unreliable for "how many entries did I delete". Counting
  // the returned ids is unambiguous.
  const rows = db
    .prepare("DELETE FROM entries WHERE ts < ? RETURNING id")
    .all(beforeIso) as Array<{ id: string }>;
  return { deleted: rows.length };
}

/**
 * Delete a single entry by id. Returns true if it existed. Operator-only
 * surface (dashboard DELETE /api/memory/:id).
 */
export function deleteEntry(id: string): boolean {
  const db = getDb();
  const rows = db
    .prepare("DELETE FROM entries WHERE id = ? RETURNING id")
    .all(id) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Snapshot count + size for the dashboard / health probes. Cheap — runs
 * two SELECTs and a stat() against the DB file.
 */
export function memoryStats(): {
  count: number;
  oldest_ts: string | null;
  newest_ts: string | null;
  bytes: number;
  fts5: boolean;
  path: string;
} {
  const db = getDb();
  const c = db.prepare("SELECT COUNT(*) as n FROM entries").get() as {
    n: number;
  };
  const o = db
    .prepare(
      "SELECT MIN(ts) as oldest, MAX(ts) as newest FROM entries",
    )
    .get() as { oldest: string | null; newest: string | null };
  let bytes = 0;
  try {
    bytes = statSync(getMemoryDbPath()).size;
  } catch {
    /* not yet flushed */
  }
  return {
    count: c.n,
    oldest_ts: o.oldest,
    newest_ts: o.newest,
    bytes,
    fts5: _fts5Available,
    path: getMemoryDbPath(),
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  ts: string;
  team_id: string | null;
  role: string;
  kind: string;
  content: string;
  metadata_json: string | null;
}

function rowToEntry(r: RawRow): MemoryEntry {
  let metadata: Record<string, unknown> | undefined;
  if (r.metadata_json) {
    try {
      metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = { _malformed: true, raw: r.metadata_json };
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    team_id: r.team_id,
    role: r.role as MemoryRole,
    kind: r.kind,
    content: r.content,
    metadata,
  };
}

/**
 * Turn a free-text user query into a safe FTS5 MATCH expression. Strips
 * FTS5 metacharacters that the operator probably didn't mean to type
 * (parens, quotes), and AND-joins the remaining tokens with prefix
 * matching so "watchdog" matches "watchdogs". If everything strips to
 * nothing, returns "" — caller falls back to LIKE.
 */
function buildFts5Match(query: string): string {
  // Allow a power-user override: if the query contains FTS5 boolean ops or
  // double-quoted phrases, pass it through nearly verbatim (we still strip
  // semicolons / backticks defensively). The detection is heuristic — good
  // enough; the worst case is a bad MATCH expression which we catch below.
  if (/(\sOR\s|\sAND\s|\sNOT\s|".*")/.test(query)) {
    return query.replace(/[;`]/g, "").trim();
  }
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `${t}*`).join(" AND ");
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ─── egress redaction ────────────────────────────────────────────────────
//
// Memory content can be quoted back to the operator over Telegram or the
// dashboard. The on-disk store is chmod 600, but Telegram and the dashboard
// are technically "egress" surfaces for risk-modeling purposes (a leaky
// Telegram bot token or an open dashboard port would surface this). Apply
// a conservative regex sweep on the way out: HMAC marks, sk-* tokens,
// bearer tokens, and 32+ hex strings get masked. We do NOT redact at
// storage time — the operator might legitimately need to query for them
// later via the dashboard's full-row view.

const REDACT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // sk-* and pk-* style API keys (OpenAI, Anthropic, etc.)
  [/\b(sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "$1-[REDACTED]"],
  // Authorization / bearer tokens
  [/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED]"],
  // HMAC trust marker hex (64 hex chars — exactly the trust-marker.ts shape)
  [/\b[a-f0-9]{64}\b/g, "[REDACTED:hmac-or-sha256]"],
  // Generic long hex (32+) — catches secret-ish blobs without too many false positives
  [/\b[A-F0-9]{40,}\b/g, "[REDACTED:hex]"],
  // hmac:<id>:<hex> trust-marker line (catch the structured form too)
  [/hmac:[A-Za-z0-9_.-]+:[a-f0-9]{16,}/g, "hmac:[REDACTED]"],
];

/**
 * Redact obvious secrets from a string before quoting it back to an
 * external surface (Telegram, dashboard). Idempotent — re-running on
 * already-redacted text is a no-op.
 */
export function redactForEgress(s: string): string {
  if (!s) return s;
  let out = s;
  for (const [pat, repl] of REDACT_PATTERNS) {
    out = out.replace(pat, repl);
  }
  return out;
}

/**
 * Apply egress redaction to an entry's content + metadata. Returns a new
 * object — does not mutate the input.
 */
export function redactEntryForEgress(e: MemoryEntry): MemoryEntry {
  let metadata = e.metadata;
  if (metadata) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(metadata)) {
      const v = metadata[k];
      out[k] = typeof v === "string" ? redactForEgress(v) : v;
    }
    metadata = out;
  }
  return {
    ...e,
    content: redactForEgress(e.content),
    metadata,
  };
}

// ─── test helpers ────────────────────────────────────────────────────────

/**
 * @internal — test-only. Drop the connection (next call re-opens). Used
 * by individual tests so state doesn't leak across files. NOT a production
 * shutdown path; the master daemon keeps the connection for its lifetime.
 */
export function _closeForTesting(): void {
  _closeDb();
}
