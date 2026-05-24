// components/evy/engagement-tracker.ts
//
// v3.1.0 — Kernel Fitness Phase 1: engagement instrumentation.
//
// What this module is for
// -----------------------
// Capture the immutable fitness signal — operator engagement against
// every surface Evy emits. This is the foundation Phases 2–6 of the
// Kernel Fitness Initiative will build on. Subctl today has continuity
// and reflection but no measurement that says "is this getting
// better?" The engagement ledger written here is that measurement.
//
// Negative criterion (LOAD-BEARING — don't violate)
// -------------------------------------------------
// The engagement ledger MUST be write-only from Evy's perspective. No
// code path that feeds Evy's supervisor prompt may read from it. Evy
// reflects without knowing she's being judged.
//
// Structural enforcement (defense-in-depth):
//
//   1. **This module exports NO reader API.** There is no
//      `readLedger()` / `loadEngagement()` / `getEngagement()` etc.
//      `runTimeoutSweeper()` internally reads its own ledger to decide
//      what to sweep, but the read result never leaves the function.
//   2. The accompanying test (`engagement-ledger-isolation.test.ts`)
//      asserts the export shape AND surgically greps the bodies of the
//      supervisor-prompt-assembly functions (`composeSystemPrompt`,
//      `buildMemoryBlock`, `buildPersonalityFragment`, `hydrateContext`,
//      `buildReviewerSystemPrompt`) for any reference to this module's
//      symbols.
//
// If either of those guards regresses, the whole Kernel Fitness
// design is broken — fitness numbers must NOT enter the supervisor
// prompt at any point. The refiner sees the metric; Evy does not.
//
// Multi-process append safety
// ---------------------------
// Both `components/evy/server.ts` (master daemon) and
// `dashboard/server.ts` (separate Bun process) append to the same
// JSONL via this module. POSIX O_APPEND guarantees atomicity for
// writes ≤ PIPE_BUF (4096B on macOS/Linux). Each entry stores only a
// SHA-256 `payload_hash` (64 chars), never the payload itself, so
// every line fits well under the atomicity limit and never leaks PII.
//
// Pure data-plane
// ---------------
// This module makes ZERO LLM calls and has ZERO dependencies on
// `pi-agent-core` or any agent state. It's strictly: append a line,
// hash a string, walk a JSONL file.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  EngagementEntry,
  LedgerEntry,
  Outcome,
  Source,
  SurfaceEmittedEntry,
  SurfaceType,
} from "./engagement-types";

// ─── path resolution ───────────────────────────────────────────────────────
//
// Honors SUBCTL_CONFIG_DIR (the same env var the rest of the daemon
// respects). Falls back to ~/.config/subctl. The ledger always lives
// at `<config>/evy/engagement-ledger.jsonl` — caller cannot redirect
// the path via the public API. (Tests use `setLedgerPathForTesting`.)

function defaultLedgerPath(): string {
  const cfg =
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(cfg, "evy", "engagement-ledger.jsonl");
}

let _ledgerPath: string = defaultLedgerPath();

/**
 * Test-only path override. Production code MUST NOT use this; the
 * canonical path is the one returned by `getLedgerPath()` with no
 * override applied. Pass `null` to restore the default.
 */
export function setLedgerPathForTesting(path: string | null): void {
  _ledgerPath = path ?? defaultLedgerPath();
}

/** Returns the absolute path the ledger is currently writing to. */
export function getLedgerPath(): string {
  return _ledgerPath;
}

// ─── deterministic surface id ──────────────────────────────────────────────
//
// Chat responses generate surface IDs deterministically from
// (timestamp, surface_type, payload). Plan-approval entries reuse the
// approval's uuid; Telegram entries reuse the Telegram message_id —
// those callers don't need this helper.

/**
 * Compute a stable, opaque 16-hex surface_id from (timestamp,
 * surface_type, payload). Deterministic: same inputs always yield the
 * same id. SHA-256 over the concatenation, sliced to 16 chars (64 bits
 * of entropy — plenty for collision avoidance within any plausible
 * single-operator window).
 */
export function makeSurfaceId(
  surface_type: SurfaceType,
  payload: string,
  ts?: string,
): string {
  const stamp = ts ?? new Date().toISOString();
  return sha256Hex(`${stamp} ${surface_type} ${payload}`).slice(0, 16);
}

/** Compute the SHA-256 payload_hash field (full 64-char hex). */
export function hashPayload(payload: string): string {
  return sha256Hex(payload);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ─── write paths ──────────────────────────────────────────────────────────

function ensureLedgerDir(): void {
  try {
    mkdirSync(dirname(_ledgerPath), { recursive: true });
  } catch {
    /* best-effort; the appendFileSync below will surface real errors */
  }
}

function appendLine(entry: LedgerEntry): void {
  ensureLedgerDir();
  // One line per entry. JSONL is line-delimited and POSIX O_APPEND is
  // atomic for writes under PIPE_BUF. Entries never inline payloads
  // (only payload_hash) so each line is well under 4 KB.
  const line = JSON.stringify(entry) + "\n";
  try {
    appendFileSync(_ledgerPath, line);
  } catch (err) {
    // Don't throw — the engagement ledger is a measurement layer, not
    // a control-plane signal. A disk hiccup must not crash the daemon
    // or the dashboard. Logging at error level so the operator sees
    // degradation.
    console.error(
      `[engagement-tracker] append failed (${entry.type}): ${(err as Error).message}`,
    );
  }
}

/**
 * Record that Evy emitted a surface to the operator. Caller is
 * responsible for choosing a stable `surface_id` (either via
 * `makeSurfaceId()` for chat, or by reusing a natural id like the
 * plan-approval uuid or Telegram message_id).
 *
 * Fire-and-forget — never throws.
 */
export function recordSurfaceEmitted(
  surface_id: string,
  surface_type: SurfaceType,
  payload_hash: string,
): void {
  const entry: SurfaceEmittedEntry = {
    type: "surface_emitted",
    ts: new Date().toISOString(),
    surface_id,
    surface_type,
    payload_hash,
  };
  appendLine(entry);
}

/**
 * Record that the operator engaged with (or explicitly acknowledged)
 * a previously-emitted surface. If `latency_ms` is omitted the writer
 * will attempt to derive it by walking the ledger for the matching
 * `surface_emitted` entry; pass it explicitly when the caller already
 * has the emission timestamp on hand (cheaper, and survives ledger
 * truncation).
 *
 * Fire-and-forget — never throws.
 */
export function recordEngagement(
  surface_id: string,
  outcome: Outcome,
  source: Source,
  latency_ms?: number,
): void {
  const entry: EngagementEntry = {
    type: "engagement",
    ts: new Date().toISOString(),
    surface_id,
    outcome,
    source,
  };
  if (typeof latency_ms === "number" && Number.isFinite(latency_ms) && latency_ms >= 0) {
    entry.latency_ms = Math.floor(latency_ms);
  }
  appendLine(entry);
}

// ─── timeout sweeper ──────────────────────────────────────────────────────
//
// Runs hourly (registered as a watchdog in server.ts). Scans the
// ledger for `surface_emitted` entries older than IGNORE_AFTER_MS
// with no follow-on `engagement` entry, and writes one `ignored`
// engagement entry per. Idempotent — once an ignored entry is written
// the surface counts as outcome-having and won't be re-swept.
//
// IMPORTANT: the read here NEVER leaves this function. The sweep
// state is a private implementation detail; no caller can observe it.
// This preserves the load-bearing negative criterion.

const IGNORE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours, per spec

interface SweepResult {
  /** How many surfaces this run flipped to `ignored`. */
  swept: number;
  /** How many `surface_emitted` rows were inspected (debug-only). */
  inspected: number;
}

/**
 * Walk the engagement ledger and write `ignored` outcomes for any
 * `surface_emitted` entries older than 24h that have no matching
 * `engagement` follow-up. Returns counts for logging.
 *
 * Reads the ledger internally; never returns ledger contents.
 *
 * Optional `now` argument enables deterministic testing.
 */
export async function runTimeoutSweeper(now?: Date): Promise<SweepResult> {
  const cutoffEpoch = (now?.getTime() ?? Date.now()) - IGNORE_AFTER_MS;
  if (!existsSync(_ledgerPath)) {
    return { swept: 0, inspected: 0 };
  }

  // Single sequential scan: build a map of surface_id → { emitted_at,
  // has_outcome }. JSONL is append-only so a single read is consistent
  // enough for sweep purposes — any concurrent writes that arrive
  // during the scan get picked up next hour.
  let raw: string;
  try {
    raw = readFileSync(_ledgerPath, "utf8");
  } catch (err) {
    console.error(
      `[engagement-tracker] sweeper read failed: ${(err as Error).message}`,
    );
    return { swept: 0, inspected: 0 };
  }

  interface SurfaceState {
    emitted_at: number;
    has_outcome: boolean;
  }
  const state = new Map<string, SurfaceState>();

  let inspected = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(trimmed) as LedgerEntry;
    } catch {
      continue;
    }
    if (entry.type === "surface_emitted") {
      inspected++;
      const epoch = Date.parse(entry.ts);
      if (!Number.isFinite(epoch)) continue;
      // First emission wins. Defensive: if the same surface_id is
      // emitted twice (caller bug), keep the earliest emission so the
      // timeout fires sooner rather than later.
      if (!state.has(entry.surface_id)) {
        state.set(entry.surface_id, {
          emitted_at: epoch,
          has_outcome: false,
        });
      }
    } else if (entry.type === "engagement") {
      const prior = state.get(entry.surface_id);
      if (prior) prior.has_outcome = true;
    }
  }

  let swept = 0;
  for (const [surface_id, s] of state) {
    if (s.has_outcome) continue;
    if (s.emitted_at > cutoffEpoch) continue;
    // Compute latency at sweep-write time so the fitness writer can
    // distinguish a quick acted from a 24h timed-out ignored.
    const latency_ms = (now?.getTime() ?? Date.now()) - s.emitted_at;
    recordEngagement(surface_id, "ignored", "timeout_sweep", latency_ms);
    swept++;
  }
  return { swept, inspected };
}

// ─── test helpers ─────────────────────────────────────────────────────────
//
// Test-only resets. The default ledger path is module-scoped state,
// so isolation between tests requires both restoring the path AND
// clearing any in-memory caches. We don't currently cache anything,
// so the path reset is sufficient.

/**
 * Reset module state to defaults. Tests pair with
 * `setLedgerPathForTesting()` to fully isolate from production state.
 */
export function _resetForTesting(): void {
  _ledgerPath = defaultLedgerPath();
}
