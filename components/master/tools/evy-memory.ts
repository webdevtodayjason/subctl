// components/master/tools/evy-memory.ts
//
// v2.7.23 — Evy-callable Tier 3 memory tools.
//
// Backs ../memory.ts (Evy Memory store). Evy gets these without any persona
// edits — the tool registry surfaces them automatically. Two tools:
//
//   evy_recall   — query past entries (the operator-Evy chat history,
//                  decisions, shipped events, captured notifications)
//   evy_remember — explicit "save this" tool so Evy can mark something
//                  durable when she encounters it mid-turn (a decision,
//                  a preference, a non-obvious finding)
//
// Tier boundary: this is NOT the same as memory_search (Tier 4, claude-mem).
// claude-mem captures observations from Claude Code sessions across multiple
// accounts. evy_recall reads the operator-Evy conversational memory captured
// at turn boundaries by master itself. Both are queryable; they don't
// overlap. The tool descriptions are explicit about that so Evy can route
// the right query to the right surface.
//
// Egress redaction: tool results are JSON-ified into the assistant transcript
// and shown to the supervisor LLM. We don't redact at this surface — the
// supervisor is local (LM Studio on M3) and the assistant text it then
// emits goes to the operator's authenticated channels. Redaction happens
// at the actual external egress points (Telegram, dashboard /api/memory).

import {
  recordEntry,
  recallEntries,
  type MemoryEntry,
} from "../memory";

// Cap tool-call results at a sane size — the supervisor doesn't need to
// re-read 200 entries to answer "what did we discuss last week?". 25 is
// enough for context window economy while still surfacing meaningful range.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function clampLimit(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function projectEntry(e: MemoryEntry): {
  id: string;
  ts: string;
  team_id: string | null;
  role: string;
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
} {
  return {
    id: e.id,
    ts: e.ts,
    team_id: e.team_id ?? null,
    role: e.role,
    kind: e.kind,
    content: e.content,
    metadata: e.metadata,
  };
}

const evy_recall = {
  description:
    "**Use this FIRST when** the operator references a past operator-Evy conversation, asks 'did we already decide X?', 'what did I just ship?', or you need to recall structured memory that you captured yourself in earlier turns. This is Tier 3 (Evy Memory) — operator-Evy chat, decisions, shipped events, captured notifications — distinct from memory_search (Tier 4, claude-mem observation corpus across Claude Code sessions). If the operator's question is about cross-session Claude Code work history, prefer memory_search. If it's about your own conversation, decisions, or what you've watched ship, use this. Returns top-N most-relevant entries newest-first (or rank-ordered when query is set).",
  schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search. FTS5 if available, LIKE fallback otherwise. Multi-token AND semantics; quotes and OR/AND/NOT are honored. Omit for the most recent overall.",
      },
      team_id: {
        type: "string",
        description:
          "Optional team scope filter — e.g. 'claude-watchdog-v2'. Pass when the question is about a specific dev team's history.",
      },
      kind: {
        type: "string",
        description:
          "Optional kind filter: 'message' (operator-Evy chat), 'tool-call', 'notification', 'shipped', 'decision', 'operator-feedback', 'operator-note'. Omit for all kinds.",
      },
      since_days: {
        type: "number",
        description:
          "Only entries from the last N days. Default unbounded.",
      },
      limit: {
        type: "number",
        description: `Max results to return. Default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}.`,
      },
    },
    required: [],
  },
  invoke: async (args: {
    query?: unknown;
    team_id?: unknown;
    kind?: unknown;
    since_days?: unknown;
    limit?: unknown;
  } = {}) => {
    const query =
      typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
    const team_id =
      typeof args.team_id === "string" && args.team_id.trim() ? args.team_id.trim() : undefined;
    const kind =
      typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : undefined;
    const limit = clampLimit(args.limit);

    let since: string | undefined;
    if (typeof args.since_days === "number" && args.since_days > 0) {
      since = new Date(
        Date.now() - args.since_days * 86_400_000,
      ).toISOString();
    }

    const items = recallEntries({ query, team_id, kind, since, limit });
    return {
      ok: true,
      query: query ?? null,
      count: items.length,
      items: items.map(projectEntry),
    };
  },
};

const evy_remember = {
  description:
    "**Use this when** you encounter something durable mid-conversation that you'd want to recall next session: a decision the operator just made, a preference they expressed, a non-obvious finding you derived, a fact about a team that would be expensive to re-derive. This is the explicit 'save this' surface for Evy Memory (Tier 3) — distinct from the automatic turn-boundary capture that the master daemon does on every message. Prefer concise, single-fact content; the operator will see these surface in evy_recall results later. Returns the new entry's id + timestamp.",
  schema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "What to remember. 1-3 sentences ideal. Avoid quoting back operator text verbatim — paraphrase the durable signal.",
      },
      kind: {
        type: "string",
        description:
          "Optional kind label. Default 'evy-note'. Suggested: 'decision', 'preference', 'finding'. Use 'operator-note' only when explicitly relaying an operator instruction.",
      },
      team_id: {
        type: "string",
        description:
          "Optional team scope. Default unscoped (global to operator-Evy).",
      },
    },
    required: ["content"],
  },
  invoke: async (args: {
    content?: unknown;
    kind?: unknown;
    team_id?: unknown;
  } = {}) => {
    const content =
      typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return {
        ok: false,
        error: "content is required and must be a non-empty string",
      };
    }
    const kind =
      typeof args.kind === "string" && args.kind.trim()
        ? args.kind.trim()
        : "evy-note";
    const team_id =
      typeof args.team_id === "string" && args.team_id.trim()
        ? args.team_id.trim()
        : null;
    const entry = recordEntry({
      role: "assistant",
      kind,
      content,
      team_id,
    });
    return {
      ok: true,
      entry: projectEntry(entry),
    };
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const evyMemoryTools = {
  evy_recall,
  evy_remember,
};
