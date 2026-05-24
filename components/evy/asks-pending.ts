// components/evy/asks-pending.ts
//
// v3.2.0 — pending-asks surface for the subctl-buddy bridge.
//
// What this module is for
// -----------------------
// `subctl notify ask-yesno|ask-choice|ask-text` posts an inline-keyboard
// Telegram message and (optionally) blocks on `--wait` until the reply
// shows up in `~/.config/subctl/inbox.jsonl`. Until v3.2.0 the question
// id was kept in master-daemon memory only — nothing on disk, nothing
// over HTTP. That blocked any external consumer (subctl-buddy bridge,
// custom dashboards, audit tooling) from seeing what's outstanding.
//
// This module captures every outstanding ask in a single JSONL file at
// `<config>/evy/asks-pending.jsonl` and exposes load/persist/remove
// helpers. It is the canonical source of truth for "what asks are
// currently waiting on an operator answer".
//
// Lifecycle:
//
//   1. `subctl notify ask-* …` → bash appends a record to the file
//      (atomic O_APPEND write of one JSON line).
//   2. The reply arrives via Telegram (callback_query / text-answer) OR
//      via `subctl notify reply …` (the buddy bridge's surface) OR via
//      `POST /api/notify/reply`. The consume path calls
//      `removePendingAsk(id)` here.
//   3. Read paths: `GET /api/asks/pending` (HTTP), `subctl notify
//      asks-pending` (CLI), or any external tool that wants to enumerate
//      in-flight asks for display.
//
// Concurrency
// -----------
// Two writers can append concurrently (the bash sender + this module's
// removal path running in the dashboard Bun process). POSIX O_APPEND
// guarantees atomicity for writes ≤ PIPE_BUF (4096B) so single-line
// appends from bash never tear. The risky operation is the rewrite path
// (read-all → filter → write-temp → rename). To prevent a concurrent
// bash append from being lost during that window, both sides take a
// portable mkdir-based lock on `<path>.lockd`.
//
// Schema
// ------
// One JSON object per line, canonical form:
//
//   {
//     "id":          "BUDDY-1",
//     "kind":        "ask-yesno" | "ask-choice" | "ask-text",
//     "question":    "Deploy?",
//     "default":     "yes" | "no" | null,        // yesno only
//     "options":     [{id, label}] | null,        // ask-choice only
//     "created_at":  "ISO-8601",
//     "timeout_at":  "ISO-8601" | null,
//     "source_tool": "notify",
//     "channels":    ["telegram"] | ["buddy"] | ["telegram","buddy"] | …
//   }
//
// `channels` is metadata for downstream consumers — the bridge filters
// on `record.channels.includes("buddy")` to decide whether to surface a
// given ask on the M5Stack device. Pending-asks records are written
// regardless of channel routing so operators have a single debug view.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── public types ──────────────────────────────────────────────────────────

export type AskKind = "ask-yesno" | "ask-choice" | "ask-text";

export interface AskChoiceOption {
  id: string;
  label: string;
}

export interface PendingAsk {
  /** Operator-visible question id (Q42-style or arbitrary). */
  id: string;
  /** Which ask-* verb originated this record. */
  kind: AskKind;
  /** Question prompt as displayed to the operator. */
  question: string;
  /** Default answer if the ask times out (ask-yesno only). */
  default: string | null;
  /** Option list for ask-choice (null otherwise). */
  options: AskChoiceOption[] | null;
  /** Wall-clock UTC ISO-8601 of when the ask was sent. */
  created_at: string;
  /** Optional deadline (ISO-8601) for `--wait`/`--timeout`. */
  timeout_at: string | null;
  /** Origin tool — `"notify"` for CLI; reserved for future MCP/tooling. */
  source_tool: string;
  /** Delivery channels (e.g. `["telegram"]`, `["buddy"]`). */
  channels: string[];
}

// ─── path resolution ───────────────────────────────────────────────────────

function defaultAsksPath(): string {
  const cfg =
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(cfg, "evy", "asks-pending.jsonl");
}

let _asksPath: string = defaultAsksPath();

/**
 * Test-only path override. Production code MUST NOT use this; the
 * canonical path is the one returned by `getAsksPendingPath()` with no
 * override applied. Pass `null` to restore the default.
 */
export function setAsksPendingPathForTesting(path: string | null): void {
  _asksPath = path ?? defaultAsksPath();
}

/** Returns the absolute path the pending-asks file lives at. */
export function getAsksPendingPath(): string {
  return _asksPath;
}

function ensureDir(): void {
  mkdirSync(dirname(_asksPath), { recursive: true });
}

// ─── mkdir-based file lock ────────────────────────────────────────────────
//
// Portable, atomic, no external deps. `mkdir` is the POSIX-blessed
// primitive for cross-process locking when both sides agree on the lock
// directory name. We use `<asksPath>.lockd`. Stale-lock handling is
// best-effort: any lock dir older than STALE_MS is assumed crashed and
// forcibly removed. Operations here all complete in milliseconds;
// STALE_MS=10s is generous.

const LOCK_SUFFIX = ".lockd";
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_MS = 10_000;

function lockPath(): string {
  return `${_asksPath}${LOCK_SUFFIX}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireLock(): Promise<void> {
  const lp = lockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lp);
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Stale-lock check — if the lock dir's mtime is ancient, the
      // previous holder almost certainly crashed.
      try {
        const ageMs = Date.now() - statSync(lp).mtimeMs;
        if (ageMs > STALE_MS) {
          try { rmdirSync(lp); } catch { /* race; loop */ }
          continue;
        }
      } catch { /* ignore stat errors */ }
      if (Date.now() > deadline) {
        throw new Error(
          `asks-pending: failed to acquire lock at ${lp} within ${LOCK_TIMEOUT_MS}ms`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseLock(): void {
  try { rmdirSync(lockPath()); } catch { /* best-effort */ }
}

async function withLock<T>(fn: () => T): Promise<T> {
  await acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ─── public API ───────────────────────────────────────────────────────────

/**
 * Append a pending ask. O_APPEND-atomic for single-line writes < 4KB
 * (every line in our schema is well under that limit — the question
 * field is the dominant size and ask prompts are short).
 *
 * Caller is responsible for ensuring `id` is unique; this function does
 * not de-dupe (duplicates would be removed together on `removePendingAsk`).
 */
export async function appendPendingAsk(rec: PendingAsk): Promise<void> {
  ensureDir();
  const line = JSON.stringify(rec) + "\n";
  await withLock(() => {
    appendFileSync(_asksPath, line);
  });
}

/**
 * Remove every record whose `id` matches. Idempotent — returns the
 * count of records removed (0 if id wasn't pending). Uses
 * read-filter-write-rename so concurrent readers via `listPendingAsks`
 * never see a partial file.
 */
export async function removePendingAsk(id: string): Promise<number> {
  return withLock(() => {
    if (!existsSync(_asksPath)) return 0;
    const lines = readFileSync(_asksPath, "utf8").split("\n");
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as PendingAsk;
        if (rec.id === id) {
          removed += 1;
          continue;
        }
        kept.push(line);
      } catch {
        // Garbage line — drop on rewrite (we already have the lock).
      }
    }
    if (removed === 0) return 0;
    // Atomic rename — write to temp + mv. Same pattern as the existing
    // `*.jsonl.offset` files elsewhere in the codebase.
    const tmp = `${_asksPath}.tmp.${process.pid}`;
    const payload = kept.length > 0 ? kept.join("\n") + "\n" : "";
    writeFileSync(tmp, payload);
    renameSync(tmp, _asksPath);
    return removed;
  });
}

/**
 * Read every pending ask, in append order (oldest first). Returns an
 * empty array if the file doesn't exist. Lines that fail to parse are
 * silently skipped. Read does NOT acquire the lock — concurrent
 * appends are atomic at the syscall level, and a concurrent rewrite
 * (which IS locked) replaces the file atomically via rename, so readers
 * always see a self-consistent snapshot.
 */
export function listPendingAsks(): PendingAsk[] {
  if (!existsSync(_asksPath)) return [];
  const lines = readFileSync(_asksPath, "utf8").split("\n");
  const out: PendingAsk[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as PendingAsk);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Return the first record whose `id` matches, or `null`. (Records
 * should be unique by id; if multiple match, the earliest is returned.)
 */
export function getPendingAsk(id: string): PendingAsk | null {
  for (const rec of listPendingAsks()) {
    if (rec.id === id) return rec;
  }
  return null;
}

/**
 * Truncate the file. Test-only convenience — do not use in production
 * code (the only correct way to remove an ask is via `removePendingAsk`,
 * which preserves other in-flight records).
 */
export function clearPendingAsksForTesting(): void {
  if (existsSync(_asksPath)) {
    try { unlinkSync(_asksPath); } catch { /* ignore */ }
  }
  try { rmdirSync(lockPath()); } catch { /* ignore */ }
}
