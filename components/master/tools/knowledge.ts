// knowledge tools — self-introspection over the TOON knowledge breakdown.
//
// v2.7.7 — operator already uses TOON heavily in Argent and asked for
// the same pattern here. The master answers "how does X work in subctl?"
// or "what's in the secrets file?" by reading from a single canonical
// TOON file (components/master/knowledge/subctl.toon) instead of either
// (a) hallucinating from training data or (b) doing a sub-agent file
// crawl every time.
//
// Tool: system_subctl_knowledge({ section?: string })
//   - no section → list every section with a one-line summary +
//     instructions to call again with { section: "<name>" }.
//   - with section → return that section's TOON content verbatim.
//   - unknown section → ok:false with available_sections populated.
//
// Loading strategy: read the .toon file ONCE at module-load time and
// cache. The file is part of the deployed bundle; it does not change
// between daemon restarts, so cache-forever is correct. Subctl updates
// the file and bounces the daemon as part of the normal release flow
// (subctl update → launchctl unload + load). No file-watch needed.
//
// Section parsing rule: a "section" is a top-level key — a line at column 0
// matching /^([a-z_][a-z0-9_]*):\s*$/. Section content = every line up to
// (but not including) the next top-level key (or EOF). Section summary =
// the first comment line ("# ...") under the key, with the "#" stripped.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve relative to this module so the path is stable whether the
// daemon is launched via `bun run`, launchd, or `subctl master` — all
// three execute server.ts at the same components/master/ root, but a
// process.cwd()-relative path would break if a future launchctl entry
// set a different working directory.
const KNOWLEDGE_PATH = resolve(
  import.meta.dir,
  "..",
  "knowledge",
  "subctl.toon",
);

interface Section {
  name: string;
  summary: string;
  content: string;
}

interface KnowledgeIndex {
  sections: Map<string, Section>;
  order: string[];
  path: string;
}

let _cache: KnowledgeIndex | null = null;
// Test seam — counts how many times the .toon file is actually read from
// disk. Useful for asserting the module-load cache works (one read across
// many invocations). Not exported for production callers; the underscore
// prefix matches the existing _resetCacheForTesting / _setPathForTesting
// convention in secrets.ts.
let _diskReadCount = 0;
export function _getDiskReadCountForTesting(): number {
  return _diskReadCount;
}

// Top-level key matcher — column-0, lowercase identifier, trailing colon
// with optional whitespace, no value on the same line. Comments start with
// "#" and are not TOON-spec, but the operator uses them throughout for
// inline annotations and we extract them as section summaries.
const TOP_LEVEL_KEY = /^([a-z_][a-z0-9_]*):\s*$/;

function parseKnowledge(raw: string): KnowledgeIndex {
  const lines = raw.split("\n");
  const sections = new Map<string, Section>();
  const order: string[] = [];

  let currentName: string | null = null;
  let currentBuffer: string[] = [];
  let currentSummary: string | null = null;

  const flush = () => {
    if (currentName === null) return;
    sections.set(currentName, {
      name: currentName,
      summary: currentSummary ?? "(no summary)",
      content: currentBuffer.join("\n").replace(/\s+$/, ""),
    });
    order.push(currentName);
  };

  for (const line of lines) {
    const m = line.match(TOP_LEVEL_KEY);
    if (m) {
      flush();
      currentName = m[1];
      currentBuffer = [line];
      currentSummary = null;
      continue;
    }
    if (currentName === null) {
      // pre-first-section (file header comments) — ignored.
      continue;
    }
    currentBuffer.push(line);
    if (currentSummary === null) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        currentSummary = trimmed.replace(/^#\s*/, "").trim() || "(empty summary)";
      }
    }
  }
  flush();

  return { sections, order, path: KNOWLEDGE_PATH };
}

function loadKnowledge(): KnowledgeIndex {
  if (_cache) return _cache;
  const raw = readFileSync(KNOWLEDGE_PATH, "utf8");
  _diskReadCount += 1;
  _cache = parseKnowledge(raw);
  return _cache;
}

// Test seam — lets the test file force a fresh load without process restart.
export function _resetKnowledgeCacheForTesting(): void {
  _cache = null;
  _diskReadCount = 0;
}

export function _getKnowledgePath(): string {
  return KNOWLEDGE_PATH;
}

export const knowledgeTools = {
  system_subctl_knowledge: {
    description:
      "Master self-introspection over a TOON-formatted breakdown of the entire subctl system. Call with no args to list available sections (overview, architecture, components, providers, tools, http_routes, config, policy, cli_surface, update_workflow, secrets, supervisor, telegram, orchestration, claude_mem, compact_policy, diagnostic_tools, version_history, phase_3s_preview, file_index). Call with { section: '<name>' } to get the full TOON content for that section. Use when the operator asks how a subctl component works, when you need to verify an architectural claim before stating it, or when you need to answer 'what's in the secrets file' / 'what tools exist' / 'how does the policy engine work' from first-party docs instead of memory.",
    schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Optional section name to fetch. Omit to list all sections with summaries.",
        },
      },
      required: [],
    },
    invoke: async (args: { section?: string } = {}) => {
      const idx = loadKnowledge();
      const section = (args.section ?? "").trim();

      if (!section) {
        return {
          ok: true,
          sections: idx.order.map((name) => {
            const s = idx.sections.get(name)!;
            return { name: s.name, summary: s.summary };
          }),
          note: "call again with { section: '<name>' } for full content",
          path: idx.path,
        };
      }

      const found = idx.sections.get(section);
      if (!found) {
        return {
          ok: false,
          error: `unknown section: ${section}`,
          available_sections: idx.order,
        };
      }

      return {
        ok: true,
        section: found.name,
        summary: found.summary,
        content: found.content,
      };
    },
  },
};
