// Self-scheduling tool for the master daemon. Backs the master's "I'll
// check in 15 minutes" promises with actual timer state instead of
// hallucinated cadence.
//
// State lives at ~/.config/subctl/master/followups.jsonl (append-only).
// Each entry is one followup:
//
//   { "id": "fu_1715380000000_a1b2c3", "fire_at": "2026-05-10T20:30:00Z",
//     "summary": "Check FOOTHOLD Milestone C progress",
//     "prompt": "[scheduled] Check the claude-Down-Time-Arena team —
//                you promised the operator a Milestone C progress
//                update around now. Run subctl_orch_status, capture
//                the pane, decide if it needs nudging.",
//     "created_at": "2026-05-10T20:15:00Z",
//     "fired_at": null }
//
// A ticker in server.ts polls this file every 60s; entries whose
// fire_at <= now get dispatched as synthetic agent prompts (source
// "scheduled") and marked fired_at. Unfired entries persist across
// daemon restarts so promises survive bounces.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
const FOLLOWUPS_PATH = join(SUBCTL_CONFIG_DIR, "master", "followups.jsonl");

export interface Followup {
  id: string;
  fire_at: string;       // ISO 8601
  summary: string;
  prompt: string;
  created_at: string;
  fired_at: string | null;
}

function ensureFile(): void {
  const dir = join(SUBCTL_CONFIG_DIR, "master");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(FOLLOWUPS_PATH)) writeFileSync(FOLLOWUPS_PATH, "");
}

function readAll(): Followup[] {
  ensureFile();
  const raw = readFileSync(FOLLOWUPS_PATH, "utf8");
  const out: Followup[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Followup);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function rewriteAll(entries: Followup[]): void {
  ensureFile();
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(FOLLOWUPS_PATH, body + (body ? "\n" : ""));
}

export function listPendingFollowups(): Followup[] {
  return readAll().filter((e) => e.fired_at === null);
}

// Returns followups whose fire_at has passed. Marks them fired and
// rewrites the file. Caller is responsible for actually dispatching
// the prompts (we keep state and dispatch decoupled so the dispatcher
// can de-duplicate or rate-limit).
export function popDueFollowups(now: Date = new Date()): Followup[] {
  const all = readAll();
  const due: Followup[] = [];
  const nowMs = now.getTime();
  let mutated = false;
  for (const e of all) {
    if (e.fired_at !== null) continue;
    if (Date.parse(e.fire_at) <= nowMs) {
      e.fired_at = now.toISOString();
      due.push(e);
      mutated = true;
    }
  }
  if (mutated) rewriteAll(all);
  return due;
}

function makeId(): string {
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `fu_${now}_${rand}`;
}

export const schedulerTools = {
  schedule_followup: {
    description:
      "Schedule a future self-prompt. Use this whenever you tell the operator something like \"I'll check on this in 15 minutes\" — it backs the promise with real timer state. The runtime will wake the agent at fire_at with a synthetic prompt containing your `prompt` text. Don't hallucinate cadence — if you say you'll do something at a specific time, schedule it. The watchdog (every 3 min) is the floor; this tool gives you arbitrary granularity.",
    schema: {
      type: "object",
      properties: {
        in_minutes: {
          type: "number",
          description:
            "How many minutes from now to fire. Use this OR fire_at_iso, not both. Range 1–1440 (1 day). Most followups should be 5–60 min.",
        },
        fire_at_iso: {
          type: "string",
          description:
            "Absolute ISO-8601 timestamp to fire. Use this OR in_minutes, not both. Useful when the operator gave you a specific clock time.",
        },
        summary: {
          type: "string",
          description:
            "One-line label for the followup (shown in /api/master/followups list). e.g. \"Check FOOTHOLD Milestone C progress\".",
        },
        prompt: {
          type: "string",
          description:
            "The prompt you want to receive when this followup fires. Write it as if instructing yourself: what to check, what tools to call, what to decide. The runtime prefixes it with [scheduled] before dispatching.",
        },
      },
      required: ["summary", "prompt"],
    },
    invoke: async (args: {
      in_minutes?: number;
      fire_at_iso?: string;
      summary: string;
      prompt: string;
    }) => {
      let fireAt: Date;
      if (args.fire_at_iso) {
        const t = Date.parse(args.fire_at_iso);
        if (Number.isNaN(t)) {
          return { ok: false, error: `unparsable fire_at_iso: ${args.fire_at_iso}` };
        }
        fireAt = new Date(t);
      } else if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
        const m = Math.min(Math.max(args.in_minutes, 1), 1440);
        fireAt = new Date(Date.now() + m * 60_000);
      } else {
        return { ok: false, error: "must provide in_minutes (1..1440) or fire_at_iso" };
      }
      const summary = (args.summary ?? "").trim();
      const prompt = (args.prompt ?? "").trim();
      if (!summary) return { ok: false, error: "summary required" };
      if (!prompt) return { ok: false, error: "prompt required" };

      const entry: Followup = {
        id: makeId(),
        fire_at: fireAt.toISOString(),
        summary,
        prompt,
        created_at: new Date().toISOString(),
        fired_at: null,
      };
      ensureFile();
      appendFileSync(FOLLOWUPS_PATH, JSON.stringify(entry) + "\n");
      return {
        ok: true,
        id: entry.id,
        fire_at: entry.fire_at,
        in_minutes: Math.round((fireAt.getTime() - Date.now()) / 60_000),
        summary,
      };
    },
  },

  list_followups: {
    description:
      "List currently scheduled (unfired) followups. Useful to verify a promise was actually scheduled, or to find an id to cancel.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const pending = listPendingFollowups();
      return {
        ok: true,
        count: pending.length,
        followups: pending.map((e) => ({
          id: e.id,
          fire_at: e.fire_at,
          minutes_remaining: Math.max(
            0,
            Math.round((Date.parse(e.fire_at) - Date.now()) / 60_000),
          ),
          summary: e.summary,
        })),
      };
    },
  },

  cancel_followup: {
    description:
      "Cancel a pending followup by id. Use when the situation has resolved before the followup was due to fire.",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "followup id from list_followups" } },
      required: ["id"],
    },
    invoke: async (args: { id: string }) => {
      const all = readAll();
      const before = all.length;
      const filtered = all.filter((e) => !(e.id === args.id && e.fired_at === null));
      if (filtered.length === before) {
        return { ok: false, error: `no pending followup with id=${args.id}` };
      }
      rewriteAll(filtered);
      return { ok: true, cancelled: args.id };
    },
  },
};
