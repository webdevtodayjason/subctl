// tier-1 memory — facts master keeps in-context every turn.
//
// Two files, both small enough to inject into the system prompt without
// blowing the context budget:
//
//   ~/.config/subctl/evy/memory.md
//     "Things master has learned that should always be present" —
//     recurring decisions, project facts, gotchas. Master can edit this
//     itself via memory_remember / memory_forget. Operator can edit via
//     the Memory tab in the dashboard.
//
//   ~/.config/subctl/evy/user.md
//     Operator profile — Jason's role, infrastructure, work style,
//     preferences. Stable across sessions; rarely changes. Master can
//     edit it (memory_user_update) but should be conservative.
//
// Both files are re-read on every dispatchToAgent call (cheap, they're
// tiny), so writes from either side land in the next turn without a
// daemon restart.
//
// Hermes uses 2200/1375 char limits; we adopt the same as a default to
// keep the always-loaded budget bounded. Configurable via env.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import {
  approveCandidate as tier1CandidatesApprove,
  configureWriteTier1 as configureTier1CandidatesWrite,
  listPending as tier1CandidatesListPending,
  rejectCandidate as tier1CandidatesReject,
  type Tier1WriteResult,
  type WriteTier1Opts,
} from "../tier1-candidates";

const MASTER_DIR = join(homedir(), ".config", "subctl", "master");
const MEMORY_PATH = join(MASTER_DIR, "memory.md");
const USER_PATH = join(MASTER_DIR, "user.md");
const MEMORY_LIMIT = parseInt(process.env.SUBCTL_MEMORY_LIMIT ?? "2200", 10);
const USER_LIMIT = parseInt(process.env.SUBCTL_USER_LIMIT ?? "1375", 10);

// Entries in memory.md are delimited by a section break so we can
// add/remove without re-formatting the whole thing. Hermes uses "\n§\n";
// we use the same character — it's rare enough not to collide with
// markdown content.
const ENTRY_DELIMITER = "\n§\n";

// ---------- read helpers ----------

export interface MemoryFileInfo {
  content: string;
  exists: boolean;
  char_count: number;
  char_limit: number;
  entries?: Array<{ index: number; content: string }>;
}

function readSafe(path: string, charLimit: number, splitEntries: boolean): MemoryFileInfo {
  if (!existsSync(path)) {
    return { content: "", exists: false, char_count: 0, char_limit: charLimit, entries: splitEntries ? [] : undefined };
  }
  let content = "";
  try { content = readFileSync(path, "utf8"); } catch { content = ""; }
  const out: MemoryFileInfo = {
    content,
    exists: true,
    char_count: content.length,
    char_limit: charLimit,
  };
  if (splitEntries) {
    out.entries = content
      .split(ENTRY_DELIMITER)
      .map((s, i) => ({ index: i, content: s.trim() }))
      .filter((e) => e.content.length > 0);
  }
  return out;
}

function writeSafe(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// ---------- public API consumed by server.ts at prompt time ----------

export function readMemory(): MemoryFileInfo {
  return readSafe(MEMORY_PATH, MEMORY_LIMIT, true);
}

export function readUser(): MemoryFileInfo {
  return readSafe(USER_PATH, USER_LIMIT, false);
}

/**
 * Build the <memory-context> blocks that get prepended to the agent's
 * system prompt on every turn. Empty string if both files are empty —
 * no point burning tokens on empty fences.
 */
export function buildMemoryBlock(): string {
  const userFile = readUser();
  const memoryFile = readMemory();
  const parts: string[] = [];
  if (userFile.exists && userFile.content.trim()) {
    parts.push(`<memory-context source="user-profile">
${userFile.content.trim()}
</memory-context>`);
  }
  if (memoryFile.exists && memoryFile.content.trim()) {
    parts.push(`<memory-context source="learned-facts">
${memoryFile.content.trim()}
</memory-context>`);
  }
  if (parts.length === 0) return "";
  return parts.join("\n\n") + "\n\n";
}

// ---------- master tools ----------

function serializeEntries(entries: Array<{ content: string }>): string {
  return entries.map((e) => e.content.trim()).filter(Boolean).join(ENTRY_DELIMITER);
}

export const tier1MemoryTools = {
  memory_show: {
    description:
      "**Use this when** you need to see the current contents of Tier 1 memory before remembering, forgetting, or updating — or to recall what's already filed. Returns the user profile (user.md) and the learned-facts list (memory.md), both auto-injected into your system prompt every turn.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const memoryFile = readMemory();
      const userFile = readUser();
      return {
        ok: true,
        memory: {
          path: MEMORY_PATH,
          char_count: memoryFile.char_count,
          char_limit: memoryFile.char_limit,
          entry_count: memoryFile.entries?.length ?? 0,
          entries: memoryFile.entries ?? [],
        },
        user_profile: {
          path: USER_PATH,
          char_count: userFile.char_count,
          char_limit: userFile.char_limit,
          content: userFile.content,
        },
      };
    },
  },

  memory_remember: {
    description:
      "**Use this when** you need to durably commit an operator-asserted fact or learned pattern to Tier 1 (~/.config/subctl/evy/memory.md). Conservative — small char budget, injected every turn. Always declare `source_type` so provenance is recoverable. Refuses on overflow; consolidate or forget old entries first.",
    schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The fact to remember. One sentence to one short paragraph. Be specific and self-contained.",
        },
        source_type: {
          type: "string",
          enum: [
            "operator-asserted",
            "verified-external",
            "self-inferred",
            "agent-reported",
          ],
          description:
            "Required. Provenance tag for this fact: 'operator-asserted' (Jason told me), 'verified-external' (I verified via tool call or external lookup), 'self-inferred' (I reasoned my way to this), 'agent-reported' (a dev-team worker reported it). Stored in the entry's metadata header so it's queryable later.",
        },
      },
      required: ["text", "source_type"],
    },
    invoke: async ({ text, source_type }: { text: string; source_type?: string }) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return { ok: false, error: "text required" };
      const allowedSources = [
        "operator-asserted",
        "verified-external",
        "self-inferred",
        "agent-reported",
      ];
      if (!source_type || !allowedSources.includes(source_type)) {
        return {
          ok: false,
          error: `source_type required (one of: ${allowedSources.join(", ")})`,
        };
      }
      const current = readMemory();
      const entries = current.entries ?? [];
      // Prepend a `[source:<type>]` provenance tag to the stored body so
      // every entry carries its origin. Tier 1 entries live forever in
      // every prompt; without a tag, you can't later distinguish operator-
      // asserted facts from self-inferred ones.
      const tagged = `[source:${source_type}] ${trimmed}`;
      entries.push({ content: tagged });
      const newContent = serializeEntries(entries.map((e, i) => ({ ...e, index: i })));
      if (newContent.length > MEMORY_LIMIT) {
        return {
          ok: false,
          error: `would exceed memory char limit (${newContent.length} > ${MEMORY_LIMIT}). Consolidate older entries with memory_forget before adding new ones.`,
          char_count: newContent.length,
          char_limit: MEMORY_LIMIT,
        };
      }
      writeSafe(MEMORY_PATH, newContent);
      return {
        ok: true,
        appended_index: entries.length - 1,
        source_type,
        char_count: newContent.length,
        char_limit: MEMORY_LIMIT,
        message: `remembered (${entries.length} total entries, ${newContent.length}/${MEMORY_LIMIT} chars used)`,
      };
    },
  },

  memory_forget: {
    description:
      "**Use this when** you need to remove an entry from Tier 1 learned-facts memory by index (consolidate duplicates, drop outdated facts, free char budget). Destructive — requires `confirmation: true` to proceed. Use memory_show first to see indexes.",
    schema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "0-based index of the entry to remove (from memory_show's entries array).",
        },
        confirmation: {
          type: "boolean",
          description:
            "Required. Must be literally `true`. Forces explicit acknowledgement that this entry is being deleted from Tier 1 memory — Evy does not destroy memory without confirmation.",
        },
      },
      required: ["index", "confirmation"],
    },
    invoke: async ({ index, confirmation }: { index: number; confirmation?: boolean }) => {
      if (confirmation !== true) {
        return {
          ok: false,
          error: "memory_forget requires explicit confirmation: true",
        };
      }
      const current = readMemory();
      const entries = current.entries ?? [];
      if (typeof index !== "number" || index < 0 || index >= entries.length) {
        return { ok: false, error: `invalid index ${index} (have ${entries.length} entries)` };
      }
      const removed = entries[index];
      entries.splice(index, 1);
      const newContent = serializeEntries(entries);
      writeSafe(MEMORY_PATH, newContent);
      return {
        ok: true,
        removed_index: index,
        removed_content: removed?.content,
        remaining_entries: entries.length,
        char_count: newContent.length,
        char_limit: MEMORY_LIMIT,
      };
    },
  },

  memory_user_update: {
    description:
      "Replace master's operator profile (~/.config/subctl/evy/user.md) with new content. The operator profile describes Jason — his role, infrastructure, projects, preferences, work style. Use sparingly; this is durable context that should change rarely. Refuses on overflow. Consider asking Jason for a confirmation before overwriting.",
    schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "New full content of user.md. Markdown OK. Will replace the file entirely.",
        },
      },
      required: ["content"],
    },
    invoke: async ({ content }: { content: string }) => {
      const trimmed = (content ?? "").trim();
      if (!trimmed) return { ok: false, error: "content required" };
      if (trimmed.length > USER_LIMIT) {
        return {
          ok: false,
          error: `would exceed user.md char limit (${trimmed.length} > ${USER_LIMIT}). Trim before writing.`,
          char_count: trimmed.length,
          char_limit: USER_LIMIT,
        };
      }
      writeSafe(USER_PATH, trimmed);
      return {
        ok: true,
        path: USER_PATH,
        char_count: trimmed.length,
        char_limit: USER_LIMIT,
      };
    },
  },

  // ─── Memory Init #5 Phase 3 — Tier 1 candidate queue ─────────────────
  // When the memory kernel's reviewer returns `action: "propose_tier1"`,
  // the candidate lands in ~/.config/subctl/evy/tier1-candidates.jsonl
  // for operator (or Evy) review. The three tools below are Evy's surface
  // for listing, approving, and rejecting candidates. Approval routes the
  // proposed fact through memory_remember above so the same char-budget
  // guardrails apply.

  memory_tier1_pending: {
    description:
      "**Use this when** you (Evy) need to see Tier 1 candidates queued for review — facts the memory consciousness cycle has flagged for promotion but is waiting on operator/Evy approval before durably committing. Returns pending candidates only; resolved ones are hidden.",
    schema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max records to return (default 20, max 100).",
        },
      },
      required: [],
    },
    invoke: async ({ limit }: { limit?: number } = {}) => {
      const raw = typeof limit === "number" && limit > 0 ? Math.floor(limit) : 20;
      const cap = Math.min(Math.max(raw, 1), 100);
      const pending = tier1CandidatesListPending();
      return {
        ok: true,
        count: pending.length,
        returned: Math.min(pending.length, cap),
        candidates: pending.slice(0, cap),
      };
    },
  },

  memory_tier1_approve: {
    description:
      "**Use this when** the operator (or you, on the operator's standing instruction) has decided a Tier 1 candidate is worth durably committing. Promotes the candidate's `memory` text through memory_remember — same char-budget guardrails apply, so this may fail and leave the candidate pending for re-try.",
    schema: {
      type: "object",
      properties: {
        candidate_id: {
          type: "string",
          description: "Candidate id from memory_tier1_pending (e.g. 'c_mpan96um_234214ca').",
        },
        note: {
          type: "string",
          description: "Optional resolution note recorded with the approval.",
        },
      },
      required: ["candidate_id"],
    },
    invoke: async ({ candidate_id, note }: { candidate_id: string; note?: string }) => {
      const trimmed = (candidate_id ?? "").trim();
      if (!trimmed) return { ok: false, error: "candidate_id required" };
      return await tier1CandidatesApprove(trimmed, {
        resolved_by: "evy",
        note,
      });
    },
  },

  memory_tier1_reject: {
    description:
      "**Use this when** a Tier 1 candidate isn't worth durable promotion (duplicate, stale, low signal). Resolves the candidate without touching memory.md — does NOT call memory_remember.",
    schema: {
      type: "object",
      properties: {
        candidate_id: {
          type: "string",
          description: "Candidate id from memory_tier1_pending.",
        },
        note: {
          type: "string",
          description: "Optional resolution note recorded with the rejection.",
        },
      },
      required: ["candidate_id"],
    },
    invoke: async ({ candidate_id, note }: { candidate_id: string; note?: string }) => {
      const trimmed = (candidate_id ?? "").trim();
      if (!trimmed) return { ok: false, error: "candidate_id required" };
      return tier1CandidatesReject(trimmed, {
        resolved_by: "evy",
        note,
      });
    },
  },
};

// ─── tier1-candidates writeTier1 wiring ──────────────────────────────────
//
// The tier1-candidates module defers the actual Tier 1 write to an injected
// callback so it doesn't pull this module back (no circular import). We
// wire it once at module load — by the time approveCandidate fires, the
// closure below resolves to the memory_remember tool defined above.
//
// source_type defaults to "operator-asserted": approving a kernel-proposed
// candidate is an explicit human decision (or Evy acting on the operator's
// standing approval), so provenance is operator-asserted, not self-inferred.
//
// v2.9.0 — the Tier 1 Consolidator passes source_type_override via opts so
// the merged entry's `[source:<type>]` tag reflects the highest-trust
// source amongst the candidates it consolidated, instead of being flattened
// to "operator-asserted".
const ALLOWED_OVERRIDE_SOURCES: ReadonlySet<string> = new Set([
  "operator-asserted",
  "verified-external",
  "self-inferred",
  "agent-reported",
]);
configureTier1CandidatesWrite(async (
  text: string,
  _kind: string,
  opts?: WriteTier1Opts,
): Promise<Tier1WriteResult> => {
  const override = opts?.source_type_override;
  const source_type =
    typeof override === "string" && ALLOWED_OVERRIDE_SOURCES.has(override)
      ? override
      : "operator-asserted";
  return (await tier1MemoryTools.memory_remember.invoke({
    text,
    source_type,
  })) as Tier1WriteResult;
});
