// notify — push curated notifications to the dashboard's chat sidecar.
//
// The right rail of the Chat tab used to show every raw SSE event (text
// deltas, tool calls, watchdog ticks) which was visually noisy. This
// tool gives master a way to publish a CURATED summary line — one
// per meaningful action — that the dashboard renders as a clean
// notification. Auto-derived events (team_event blocked/done, watchdog
// firings) also flow into the same feed; this tool is for things master
// considers worth flagging that aren't auto-detected.
//
// Examples:
//   notify_dashboard("Spawned dev team auth-rewrite for project foo", "spawn")
//   notify_dashboard("PR #42 ready for your review", "milestone")
//   notify_dashboard("Backed off team billing-fix — they reported they're nearly done", "decision")
//
// The sidecar shows the latest 30, color-coded by kind. The full
// notification log persists to ~/.config/subctl/evy/notifications.jsonl
// for audit + the dashboard's "see all" view.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const NOTIFY_LOG = join(homedir(), ".config", "subctl", "master", "notifications.jsonl");

const ALLOWED_KINDS = new Set([
  "spawn",       // dev team spawned
  "blocked",     // a team blocked
  "done",        // milestone / completion
  "milestone",   // intermediate progress note
  "escalation",  // sent to telegram
  "decision",    // master made a notable decision
  "watchdog",    // watchdog action
  "memory",      // captured something to memory
  "info",        // generic
  "error",       // something failed
]);

// Caller-supplied broadcast hook. Server.ts wires this at boot so the
// tool can publish to the SSE bus without depending on server.ts directly.
let _broadcast: ((eventType: string, payload: unknown) => void) | null = null;

export function bindNotifyBroadcast(fn: (eventType: string, payload: unknown) => void) {
  _broadcast = fn;
}

export const notifyTools = {
  notify_dashboard: {
    description:
      "Publish a curated one-line notification to the dashboard chat sidecar (right rail of Chat tab). Use this when you want operator to SEE a status update without you having to send a full Telegram message — it's the medium-urgency \"FYI\" channel between silent decisions and hard escalations. Examples: \"Spawned code-review team for PR #42\", \"Team auth-rewrite reported done — PR ready\", \"Backed off team billing-fix; they're 90% done\". Don't notify on every tool call — that's noise. Only meaningful state changes the operator should know about.",
    schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One-line notification text. Should fit on one line in the sidecar (~100 chars ideal, 200 max). Lead with the verb (\"Spawned\", \"Reported\", \"Decided\"...).",
        },
        kind: {
          type: "string",
          description: "One of: spawn, blocked, done, milestone, escalation, decision, watchdog, memory, info, error. Drives the color in the sidecar (done=green, blocked=red, escalation=red, decision=cyan, etc.).",
        },
        team: {
          type: "string",
          description: "Optional dev-team name this notification relates to (if any).",
        },
      },
      required: ["summary", "kind"],
    },
    invoke: async ({ summary, kind, team }: { summary: string; kind: string; team?: string }) => {
      const trimmed = (summary ?? "").trim();
      if (!trimmed) return { ok: false, error: "summary required" };
      const k = (kind ?? "info").toLowerCase();
      if (!ALLOWED_KINDS.has(k)) {
        return {
          ok: false,
          error: `kind '${k}' not in allow-list. Permitted: ${Array.from(ALLOWED_KINDS).join(", ")}`,
        };
      }
      const event = {
        ts: new Date().toISOString(),
        kind: k,
        team: team ?? null,
        summary: trimmed.slice(0, 400),
      };
      // Persist
      try {
        mkdirSync(dirname(NOTIFY_LOG), { recursive: true });
        appendFileSync(NOTIFY_LOG, JSON.stringify(event) + "\n");
      } catch { /* don't fail the tool over a log-write blip */ }
      // Broadcast over SSE so the dashboard sidecar updates live
      if (_broadcast) {
        try { _broadcast("notify", event); } catch { /* broadcast failures are non-fatal */ }
      }
      return { ok: true, event, message: "notification published to dashboard sidecar" };
    },
  },
};
