// components/master/tools/watchdogs.ts
//
// v2.7.19 — Evy-callable watchdog list + kill tools.
//
// Backs the watchdog registry in components/master/watchdogs.ts. Evy gets
// these without any persona / SKILL.md edits — the tool list surfaces
// automatically. Use cases the operator described on 2026-05-13:
//
//   "Evy, what watchdogs are running?"          → watchdog_list
//   "Kill the inbox-poll watchdog."             → watchdog_kill { id }
//   "Stale: heavy supervisor's been looping —
//    show me what's alive and what to nuke."    → list, then kill
//
// Both tools are read-only against the rest of subctl state (no audit
// writes here — kill is dramatic enough on its own).

import {
  listWatchdogs,
  killWatchdog,
} from "../watchdogs";

const watchdog_list = {
  description:
    "List every active watchdog / periodic ticker the master daemon is running. Returns id, kind (telegram-listener, inbox-poll, team-staleness, followup-scheduler, auto-compact, verifier-cluster, cli-prompt-poll, …), started_at, last_tick_at, and age_seconds for each. Use this when the operator says 'what's running?', when you suspect a stale watchdog, or before calling watchdog_kill so you have the exact id.",
  schema: { type: "object", properties: {}, required: [] },
  invoke: async () => {
    const watchdogs = listWatchdogs();
    return {
      ok: true,
      count: watchdogs.length,
      watchdogs,
    };
  },
};

const watchdog_kill = {
  description:
    "Kill one watchdog by id. Stops its setInterval / abort-controller-based loop and removes it from the registry. The id must match a watchdog returned by watchdog_list — typo-resistance: unknown ids return { ok: false, error }, never a silent success. Kill is irreversible without a master restart; use it only when you're sure the watchdog is stuck (no last_tick_at advance, or the operator explicitly asked). Killing the telegram-listener severs the operator's last command path from outside the dashboard — confirm with the operator before doing so.",
  schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Watchdog id to kill — must be exactly an id returned by watchdog_list (e.g. 'inbox-poll', 'team-staleness').",
      },
    },
    required: ["id"],
  },
  invoke: async (args: { id?: unknown } = {}) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) {
      return { ok: false, error: "id is required and must be a non-empty string" };
    }
    const result = killWatchdog(id);
    return result;
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const watchdogTools = {
  watchdog_list,
  watchdog_kill,
};
