// components/evy/engagement-types.ts
//
// v3.1.0 — Kernel Fitness Phase 1: engagement instrumentation types.
//
// The engagement ledger is the foundation of the fitness signal Phases
// 2–6 will build on. Each surface Evy emits to the operator (a chat
// response, a Telegram message, a plan-approval request) produces a
// `surface_emitted` entry. The operator's later interaction with that
// surface (typing a reply, tapping a button, hitting dismiss, or simply
// letting 24h pass without engaging) produces a follow-on `engagement`
// entry with one of three outcomes: `acted`, `acked`, or `ignored`.
//
// The shapes here are deliberately minimal and serialisable to JSONL.
// Multi-process append safety relies on POSIX O_APPEND atomicity for
// writes under PIPE_BUF (4096B), which all entries here easily fit
// under since payloads are SHA-256 hashes, not the actual content.

/**
 * What kind of surface Evy emitted to the operator. Phase 1 covers the
 * three surface types the operator actually interacts with today. New
 * surface types (e.g. `worker_dispatch`, `memory_promotion`) may be
 * added in a Phase 1.5 if the engagement signal there proves useful.
 */
export type SurfaceType =
  | "chat_response"
  | "telegram_message"
  | "plan_approval_request";

/**
 * How the operator engaged with a surface (or didn't).
 *
 *   - `acted`: operator took the prompted action — replied, approved a
 *     plan, tapped a button. The strongest positive signal.
 *   - `acked`: operator acknowledged without acting — rejected a plan,
 *     hit dismiss on a chat bubble, muted a Telegram thread. The
 *     surface registered but didn't earn follow-through.
 *   - `ignored`: operator never engaged within the 24h timeout window.
 *     The weakest positive signal — written by the timeout sweeper.
 */
export type Outcome = "acted" | "acked" | "ignored";

/**
 * Where the engagement signal came from. Used by the fitness writer
 * (Phase 2) to weight different sources differently if needed (e.g. a
 * Telegram inline-button tap is a more deliberate signal than the
 * heuristic "any inbound on this thread counts").
 *
 *   - `dashboard_click`: operator interacted with the dashboard chat
 *     panel (typed a reply or hit a dismiss button).
 *   - `telegram_reply`: operator sent a free-text reply via Telegram.
 *   - `telegram_button`: operator tapped an inline keyboard button.
 *     Reserved for forward compatibility — Phase 1 doesn't send inline
 *     buttons yet.
 *   - `plan_approval_decision`: operator approved or rejected a plan
 *     via the dashboard's Plans tab or the master-bot's `/plans` command.
 *   - `timeout_sweep`: written by `runTimeoutSweeper` for surfaces with
 *     no outcome after the 24h floor.
 */
export type Source =
  | "dashboard_click"
  | "telegram_reply"
  | "telegram_button"
  | "plan_approval_decision"
  | "timeout_sweep";

/**
 * One ledger line emitted when a surface is shown to the operator.
 *
 * IMPORTANT: we DO NOT store the original payload — only its SHA-256
 * hash. Two reasons: (1) payloads can carry secrets or PII that the
 * fitness signal has no business retaining, (2) keeping lines small
 * preserves POSIX append-atomicity (< PIPE_BUF).
 */
export interface SurfaceEmittedEntry {
  type: "surface_emitted";
  /** ISO-8601 timestamp of emission. */
  ts: string;
  /** Stable, opaque 16-hex identifier for this surface instance. */
  surface_id: string;
  surface_type: SurfaceType;
  /** SHA-256 hex digest of the payload that was shown. Audit-only. */
  payload_hash: string;
}

/**
 * One ledger line emitted when the operator engages (or the sweeper
 * declares the surface ignored). `latency_ms` measures emission → outcome
 * wall-clock time when the tracker can compute it cheaply; it's optional
 * because not every caller has the emission timestamp on hand.
 */
export interface EngagementEntry {
  type: "engagement";
  ts: string;
  surface_id: string;
  outcome: Outcome;
  source: Source;
  /** Optional: emission → outcome wall-clock latency, in milliseconds. */
  latency_ms?: number;
}

/** Discriminated union of all ledger entry shapes. */
export type LedgerEntry = SurfaceEmittedEntry | EngagementEntry;
