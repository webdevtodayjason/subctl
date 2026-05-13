// components/master/notifications.ts
//
// v2.7.22 — Operator notification channel.
//
// Origin: 2026-05-13. The team-staleness watchdog was synthesizing prompts
// straight into the master agent's transcript ("decide whether to ping the
// lead, escalate, or take corrective action"). Two problems:
//
//   1. Wrong channel — it interleaved with operator conversation in Evy's
//      chat, and every tick woke the LLM just to produce a notification
//      that should be a UI/push event.
//   2. Wrong behavior — it asked Evy to decide instead of attempting the
//      cheap remediation (auto-nudge the lead) first.
//
// This module is the dedicated notification surface: an in-memory ring
// buffer that the dashboard tray + Telegram pusher consume. Watchdogs and
// other periodic checkers call emitNotification() instead of writing to
// the agent's messages array.
//
// Buffer is in-memory only — restart wipes it. That's intentional: every
// "is this still happening?" signal is rebuilt on the next tick. We don't
// want stale "team X was stale 3 days ago" alerts surviving a reboot.

import { randomUUID } from "node:crypto";

export type NotificationSeverity = "info" | "warn" | "alert";

export interface Notification {
  id: string;
  /**
   * Stable kind string so consumers can filter/group. Known values:
   *   - "team-stale"            — first detection of a stale dev team (legacy)
   *   - "team-nudge-sent"       — auto-nudge dispatched to lead (info)
   *   - "team-unresponsive"     — lead failed to reply to nudge (alert)
   *   - "auto-compact-error"    — compaction tick threw (warn)
   *   - "upstream-available"    — pi-ai / pi-agent-core has a newer
   *                                 version on npm (v2.7.25)
   *   - "upstream-auto-updated" — auto-update gate ran successfully (info)
   *   - "upstream-update-failed"— auto-update gate ran but tests failed (alert)
   *   - anything else (forward-compat, unknown kinds render as generic)
   */
  kind: string;
  severity: NotificationSeverity;
  title: string; // <80 chars; the headline shown in the tray
  body: string;  // full details; markdown-ish OK but rendered as text
  /** Optional team_id (tmux session name) so the tray can group by team. */
  team_id?: string;
  ts: string; // ISO 8601 emit time
  /** Marked-read timestamp; null until read. */
  read_at: string | null;
  /**
   * Optional bag of structured fields the dashboard / Telegram / copy-prompt
   * surface can consume verbatim. Keep values JSON-serializable — the tray
   * renders this via JSON.stringify when building the LLM triage prompt.
   * Added v2.7.25 (Scope B copy-prompt + Scope C upstream-check from/to).
   */
  metadata?: Record<string, unknown>;
}

export interface EmitNotificationInput {
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  team_id?: string;
  /** Optional structured payload — see Notification.metadata for usage. */
  metadata?: Record<string, unknown>;
}

export type NotificationSubscriber = (n: Notification) => void;

const RING_LIMIT = 200;
const _ring: Notification[] = [];
const _subscribers: NotificationSubscriber[] = [];

/**
 * Append a notification to the ring + fan it out to subscribers.
 * Subscriber exceptions are swallowed so one bad listener can't poison
 * the dispatch loop. Returns the materialized record (for callers that
 * want the assigned id / ts).
 */
export function emitNotification(input: EmitNotificationInput): Notification {
  const n: Notification = {
    id: randomUUID(),
    kind: input.kind,
    severity: input.severity,
    title: input.title.length > 80 ? input.title.slice(0, 77) + "…" : input.title,
    body: input.body,
    team_id: input.team_id,
    ts: new Date().toISOString(),
    read_at: null,
    metadata: input.metadata,
  };
  _ring.push(n);
  // Cap at RING_LIMIT — drop oldest. The watchdog's heartbeat rate means
  // 200 covers ~16 hours of "everything is fine, team-nudge-sent" at the
  // 5-min tick, which is more than enough for the dashboard tray.
  while (_ring.length > RING_LIMIT) _ring.shift();
  for (const s of _subscribers) {
    try {
      s(n);
    } catch (err) {
      console.error(
        `[notifications] subscriber threw: ${(err as Error).message ?? err}`,
      );
    }
  }
  return n;
}

export interface ListNotificationsOptions {
  /** ISO timestamp — only entries strictly newer than this are returned. */
  since?: string;
  /** Cap on returned entries (newest-first). Default 50. */
  limit?: number;
}

/**
 * Snapshot the ring (newest-first), optionally filtered by `since` and
 * capped by `limit`. Returns shallow copies so callers can't mutate the
 * stored records.
 */
export function listNotifications(
  opts: ListNotificationsOptions = {},
): Notification[] {
  const limit = Math.max(1, Math.min(RING_LIMIT, opts.limit ?? 50));
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const out: Notification[] = [];
  for (let i = _ring.length - 1; i >= 0 && out.length < limit; i--) {
    const n = _ring[i]!;
    if (sinceMs && Date.parse(n.ts) <= sinceMs) continue;
    out.push({ ...n });
  }
  return out;
}

/**
 * Subscribe to new notifications. Returns a disposer. Use for the SSE
 * stream + the Telegram pusher — the dashboard tray uses /api/notifications
 * polling on load AND the SSE stream for live updates.
 */
export function subscribeNotifications(cb: NotificationSubscriber): () => void {
  _subscribers.push(cb);
  return () => {
    const idx = _subscribers.indexOf(cb);
    if (idx !== -1) _subscribers.splice(idx, 1);
  };
}

/**
 * Mark one notification read by id. Returns true if found.
 */
export function markRead(id: string): boolean {
  for (let i = _ring.length - 1; i >= 0; i--) {
    const n = _ring[i]!;
    if (n.id === id) {
      if (!n.read_at) n.read_at = new Date().toISOString();
      return true;
    }
  }
  return false;
}

/**
 * Mark every unread notification read. Returns the number of newly-read
 * entries (useful for the "/notifications read" Telegram reply).
 */
export function markAllRead(): number {
  const now = new Date().toISOString();
  let n = 0;
  for (const entry of _ring) {
    if (!entry.read_at) {
      entry.read_at = now;
      n++;
    }
  }
  return n;
}

/**
 * Unread count — used by the tray badge.
 */
export function unreadCount(): number {
  let n = 0;
  for (const entry of _ring) {
    if (!entry.read_at) n++;
  }
  return n;
}

/**
 * Test/teardown helper. Unconditionally clears ring + subscribers so
 * individual tests don't leak state. NOT used in production.
 */
export function _resetForTesting(): void {
  _ring.length = 0;
  _subscribers.length = 0;
}

/**
 * Exposed for tests that want to introspect the buffer cap without
 * importing the constant separately.
 */
export const NOTIFICATION_RING_LIMIT = RING_LIMIT;
