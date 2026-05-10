// tier-1 memory — facts master keeps in-context every turn.
//
// Two files, both small enough to inject into the system prompt without
// blowing the context budget:
//
//   ~/.config/subctl/master/memory.md
//     "Things master has learned that should always be present" —
//     recurring decisions, project facts, gotchas. Master can edit this
//     itself via memory_remember / memory_forget. Operator can edit via
//     the Memory tab in the dashboard.
//
//   ~/.config/subctl/master/user.md
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
      "Show the current contents of master's tier-1 memory: the user profile (~/.config/subctl/master/user.md) and the learned-facts list (~/.config/subctl/master/memory.md). These two files are auto-injected into your system prompt every turn so you always have them in context. Use this tool to see what's there before remembering / updating, or to recall what you previously stored.",
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
      "Append a fact to master's learned-facts memory (~/.config/subctl/master/memory.md). Use this when you've learned something durable about a project, decision, gotcha, or pattern that you'll want every future turn to know without having to re-discover it. Keep entries SHORT (1-3 sentences) and self-contained — they get injected into every prompt forever, so they cost tokens. Refuses if the total file would exceed the char limit; consolidate or forget old entries first.",
    schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The fact to remember. One sentence to one short paragraph. Be specific and self-contained.",
        },
      },
      required: ["text"],
    },
    invoke: async ({ text }: { text: string }) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return { ok: false, error: "text required" };
      const current = readMemory();
      const entries = current.entries ?? [];
      entries.push({ content: trimmed });
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
        char_count: newContent.length,
        char_limit: MEMORY_LIMIT,
        message: `remembered (${entries.length} total entries, ${newContent.length}/${MEMORY_LIMIT} chars used)`,
      };
    },
  },

  memory_forget: {
    description:
      "Remove an entry from master's learned-facts memory by index. Use memory_show first to see indexes. Useful for: consolidating duplicates, removing outdated facts, freeing char budget when the file is full.",
    schema: {
      type: "object",
      properties: {
        index: {
          type: "number",
          description: "0-based index of the entry to remove (from memory_show's entries array).",
        },
      },
      required: ["index"],
    },
    invoke: async ({ index }: { index: number }) => {
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
      "Replace master's operator profile (~/.config/subctl/master/user.md) with new content. The operator profile describes Jason — his role, infrastructure, projects, preferences, work style. Use sparingly; this is durable context that should change rarely. Refuses on overflow. Consider asking Jason for a confirmation before overwriting.",
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
};
