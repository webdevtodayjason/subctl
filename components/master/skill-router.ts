// components/master/skill-router.ts
//
// v2.8.1 — Lightweight skill router. On every operator turn, score the
// installed skill catalog against the inbound message and choose the
// top-K to inject into Evy's system prompt. Mirrors the "skill
// preloading" behavior Hermes (Claude Code) does for its own runtime,
// brought to the master so Evy doesn't have to drag every skill into
// every turn (token weight + cold prompt-cache miss = slow first
// response, especially on local LM Studio).
//
// Scoring is intentionally simple — keyword + description token
// overlap. The router runs inline in composeSystemPrompt() so it has
// to be sub-millisecond on the happy path; no LLM call, no embeddings,
// no IO past the skill-file reads which are themselves memoized.
//
// Feature flag — gated by the presence of a file at
//   ~/.config/subctl/skill-router.enabled
// When absent, selectSkills() returns the legacy set (master SKILL.md
// only, no extras). Once flipped on the router is in-loop for every
// turn.
//
// Always-loaded (when router is on): subctl-team-protocol + handoff-
// protocol. Foundational, no router score required.
//
// Domain conventions (node/python/rust) are routed by cwd-based
// ecosystem detection — package.json → node, pyproject.toml → python,
// Cargo.toml → rust. Default: load none (master daemon lives in the
// repo root; operator may be talking about anything).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Skill catalog source (in-repo). Each SKILL.md has YAML frontmatter
// with name + description + optional keywords.
const COMPONENT_DIR = __dirname;
const SKILLS_ROOT = join(COMPONENT_DIR, "..", "skills");

// Feature flag path. Operator flips this on by creating the file (any
// content); no value parsing — presence == enabled. Removing the file
// reverts to the legacy single-skill prompt on the next turn.
const FLAG_PATH = join(
  process.env.HOME ?? "",
  ".config",
  "subctl",
  "skill-router.enabled",
);

// The master's own SKILL.md (Evy persona) is loaded separately upstream
// in composeSystemPrompt — don't double-load.
const EXCLUDED_FROM_CATALOG = new Set(["subctl-master"]);

// Always-loaded skill names (when router enabled). These are
// foundational and the cost of carrying them on every turn is
// acceptable.
const ALWAYS_LOAD = new Set(["subctl-team-protocol", "handoff-protocol"]);

// Domain skills — only one is loaded per turn based on cwd ecosystem.
const DOMAIN_SKILLS = new Map<string, string>([
  ["node", "node-conventions"],
  ["python", "python-conventions"],
  ["rust", "rust-conventions"],
]);

export interface SkillEntry {
  name: string;
  description: string;
  keywords: string[];
  body: string; // raw markdown body (post-frontmatter)
  path: string;
}

export interface RouterContext {
  // Optional explicit cwd override. If unset, uses process.cwd(). Tests
  // use the override; runtime relies on the daemon's cwd. Domain skill
  // (node/python/rust conventions) is selected from this directory's
  // ecosystem markers.
  cwd?: string;
  // Override for the flag-file path. Tests use this; runtime defaults
  // to ~/.config/subctl/skill-router.enabled.
  flagPath?: string;
  // Override for the skills root directory. Tests use this; runtime
  // defaults to <repo>/components/skills/.
  skillsRoot?: string;
}

export interface RouterOptions {
  // Top-K candidates above the always-loaded floor. Default 2.
  topK?: number;
  // Below this score, candidates are dropped even if they're top-K.
  // Keeps "router preloaded subctl-team-protocol just because"
  // surprises out of the dashboard pill.
  minScore?: number;
  // When the operator message is shorter than this, load every skill
  // — latency on trivial messages is fine and the cost of guessing
  // wrong is annoying.
  fullLoadShortMessageThreshold?: number;
}

export interface RouterTrace {
  skill: string;
  score: number;
  matchedKeywords: string[];
  matchedDescTokens: string[];
}

export interface RouterDecision {
  enabled: boolean;
  selected: SkillEntry[];
  trace: RouterTrace[];
  reason: string; // human-readable, surfaced in CLI router-trace
}

// ── frontmatter parsing ────────────────────────────────────────────
// Minimal YAML reader for the {name, description, keywords} subset we
// care about. Doesn't pull js-yaml; SKILL.md frontmatter is hand-
// written and a full parser is overkill. Folded scalars (>-) join
// lines with spaces; literal blocks (|) keep newlines.

interface Frontmatter {
  name: string;
  description: string;
  keywords: string[];
}

export function parseFrontmatter(raw: string): {
  fm: Frontmatter;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { fm: { name: "", description: "", keywords: [] }, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    return { fm: { name: "", description: "", keywords: [] }, body: raw };
  }
  const header = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");

  let name = "";
  let description = "";
  let keywords: string[] = [];

  // Walk the header line-by-line, supporting "key: value" and folded
  // "key: >-\n  line1\n  line2" and inline "[a, b, c]" arrays.
  const lines = header.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2] ?? "";

    if (value === ">-" || value === ">" || value === "|" || value === "|-") {
      // Folded / literal block. Consume indented continuation lines.
      const folded = value === ">-" || value === ">";
      const collected: string[] = [];
      while (i + 1 < lines.length && /^\s{2,}/.test(lines[i + 1] ?? "")) {
        i++;
        collected.push((lines[i] ?? "").replace(/^\s+/, ""));
      }
      value = folded ? collected.join(" ").trim() : collected.join("\n");
    }

    if (key === "name") name = value.trim().replace(/^["']|["']$/g, "");
    else if (key === "description") {
      description = value.trim().replace(/^["']|["']$/g, "");
    } else if (key === "keywords") {
      // Either inline array [a, b, c] or hyphen-list on subsequent
      // lines. Accept both; coerce to string[].
      const inline = value.trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        keywords = inline
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        const collected: string[] = [];
        while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1] ?? "")) {
          i++;
          const it = (lines[i] ?? "")
            .replace(/^\s+-\s+/, "")
            .trim()
            .replace(/^["']|["']$/g, "");
          if (it) collected.push(it);
        }
        keywords = collected;
      }
    }
  }

  return { fm: { name, description, keywords }, body };
}

// ── catalog loader ─────────────────────────────────────────────────
// Memoize the SKILL.md reads — they're static within a daemon lifetime
// (operator-authored skills come in via a separate worker scope and
// don't share this module). On each call we still stat() to invalidate
// when SKILL.md content changes; sub-ms because we're touching ~9
// files.

interface CacheEntry {
  mtime: number;
  entry: SkillEntry;
}

const cache = new Map<string, CacheEntry>();

export function loadCatalog(skillsRoot: string): SkillEntry[] {
  if (!existsSync(skillsRoot)) return [];
  const out: SkillEntry[] = [];
  const dirs = readdirSync(skillsRoot, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const skillFile = join(skillsRoot, d.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let mtime = 0;
    try {
      mtime = statSync(skillFile).mtimeMs;
    } catch {
      continue;
    }
    const cached = cache.get(skillFile);
    if (cached && cached.mtime === mtime) {
      if (!EXCLUDED_FROM_CATALOG.has(cached.entry.name)) out.push(cached.entry);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const entry: SkillEntry = {
      name: fm.name || d.name,
      description: fm.description,
      keywords: fm.keywords,
      body,
      path: skillFile,
    };
    cache.set(skillFile, { mtime, entry });
    if (!EXCLUDED_FROM_CATALOG.has(entry.name)) out.push(entry);
  }
  return out;
}

// ── ecosystem detection ────────────────────────────────────────────
// Cheap cwd-marker probe. The router calls this once per turn (sub-ms
// stat() lookup). If the operator runs master from a non-project dir,
// no domain skill is selected — that's fine, the always-load floor
// still covers team-protocol + handoff.

export function detectEcosystem(cwd: string): string | null {
  try {
    if (existsSync(join(cwd, "package.json"))) return "node";
    if (
      existsSync(join(cwd, "pyproject.toml")) ||
      existsSync(join(cwd, "requirements.txt"))
    ) {
      return "python";
    }
    if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  } catch {
    /* ignore */
  }
  return null;
}

// ── tokenization ───────────────────────────────────────────────────
// Lowercase + split on non-alphanumerics. Stopwords filtered out
// (small set; not a real NLP pipeline — just enough so "the" doesn't
// dominate). Returns a Set for O(1) overlap math.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "i", "in", "is", "it", "its", "of", "on", "or",
  "that", "the", "this", "to", "was", "we", "what", "when", "where",
  "which", "who", "will", "with", "you", "your", "do", "does", "did",
  "can", "could", "would", "should", "im", "ive", "ill", "evy",
  "subctl", "please", "help", "tell", "me", "us", "about",
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!t || t.length < 2 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

// ── scoring ────────────────────────────────────────────────────────
// Score = (keyword hits × 3) + (description-token hits × 1) + name hit
// bonus. Keyword matches dominate — they're hand-curated. Description
// tokens are the fallback when a skill author hasn't bothered with
// keywords yet. The 3:1 weight is empirical; tune via tests.

function score(
  msgTokens: Set<string>,
  entry: SkillEntry,
): { score: number; matchedKeywords: string[]; matchedDescTokens: string[] } {
  const matchedKeywords: string[] = [];
  for (const kw of entry.keywords) {
    const kwTokens = tokenize(kw);
    let any = false;
    for (const t of kwTokens) {
      if (msgTokens.has(t)) {
        any = true;
        break;
      }
    }
    if (any) matchedKeywords.push(kw);
  }
  const descTokens = tokenize(entry.description);
  const matchedDescTokens: string[] = [];
  for (const t of descTokens) {
    if (msgTokens.has(t)) matchedDescTokens.push(t);
  }
  const nameHit = msgTokens.has(entry.name.toLowerCase()) ||
    msgTokens.has(entry.name.toLowerCase().replace(/-/g, ""));
  const s = matchedKeywords.length * 3 + matchedDescTokens.length * 1 +
    (nameHit ? 2 : 0);
  return { score: s, matchedKeywords, matchedDescTokens };
}

// ── public API ─────────────────────────────────────────────────────

export function isRouterEnabled(flagPath?: string): boolean {
  const p = flagPath ?? FLAG_PATH;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export function selectSkills(
  message: string,
  context: RouterContext = {},
  options: RouterOptions = {},
): RouterDecision {
  const flagPath = context.flagPath ?? FLAG_PATH;
  const skillsRoot = context.skillsRoot ?? SKILLS_ROOT;
  const cwd = context.cwd ?? process.cwd();

  const enabled = isRouterEnabled(flagPath);
  if (!enabled) {
    return {
      enabled: false,
      selected: [],
      trace: [],
      reason: "router disabled (no flag file)",
    };
  }

  const catalog = loadCatalog(skillsRoot);
  const topK = options.topK ?? 2;
  const minScore = options.minScore ?? 1;
  const shortThreshold = options.fullLoadShortMessageThreshold ?? 5;

  const byName = new Map<string, SkillEntry>();
  for (const e of catalog) byName.set(e.name, e);

  // Short-message fast-path: skip routing, return the small "always
  // load" floor (team-protocol + handoff). The supervisor needs almost
  // nothing context-wise to respond to "hi" or "/profile".
  if (message.trim().length < shortThreshold) {
    const floor: SkillEntry[] = [];
    for (const name of ALWAYS_LOAD) {
      const e = byName.get(name);
      if (e) floor.push(e);
    }
    return {
      enabled: true,
      selected: floor,
      trace: floor.map((e) => ({
        skill: e.name,
        score: 0,
        matchedKeywords: [],
        matchedDescTokens: [],
      })),
      reason: `short message (<${shortThreshold} chars) — floor-only`,
    };
  }

  const msgTokens = tokenize(message);
  const traces: RouterTrace[] = [];

  // Score every routable (non-always, non-domain) skill.
  const alwaysSet = new Set(ALWAYS_LOAD);
  const domainSet = new Set(DOMAIN_SKILLS.values());
  const candidates: Array<{ entry: SkillEntry; trace: RouterTrace }> = [];
  for (const e of catalog) {
    if (alwaysSet.has(e.name)) continue;
    if (domainSet.has(e.name)) continue;
    const sc = score(msgTokens, e);
    const trace: RouterTrace = {
      skill: e.name,
      score: sc.score,
      matchedKeywords: sc.matchedKeywords,
      matchedDescTokens: sc.matchedDescTokens,
    };
    traces.push(trace);
    if (sc.score >= minScore) candidates.push({ entry: e, trace });
  }
  candidates.sort((a, b) => b.trace.score - a.trace.score);

  const selected: SkillEntry[] = [];
  const reasons: string[] = [];

  // Always-load floor.
  for (const name of ALWAYS_LOAD) {
    const e = byName.get(name);
    if (e) {
      selected.push(e);
      traces.push({
        skill: name,
        score: 0,
        matchedKeywords: ["(always-load)"],
        matchedDescTokens: [],
      });
    }
  }
  reasons.push(`always-load: ${[...ALWAYS_LOAD].join(", ")}`);

  // Domain skill — cwd ecosystem-routed.
  const eco = detectEcosystem(cwd);
  if (eco) {
    const skillName = DOMAIN_SKILLS.get(eco);
    if (skillName) {
      const e = byName.get(skillName);
      if (e) {
        selected.push(e);
        traces.push({
          skill: skillName,
          score: 0,
          matchedKeywords: [`(domain:${eco})`],
          matchedDescTokens: [],
        });
        reasons.push(`domain: ${skillName} (cwd ${eco})`);
      }
    }
  } else {
    reasons.push("domain: none (no ecosystem markers in cwd)");
  }

  // Top-K from scored candidates.
  const picks = candidates.slice(0, topK).map((c) => c.entry);
  for (const p of picks) selected.push(p);
  if (picks.length > 0) {
    reasons.push(
      `top-${picks.length}: ${picks.map((p) => p.name).join(", ")}`,
    );
  } else {
    reasons.push("top-K: (no candidate scored ≥ minScore)");
  }

  return {
    enabled: true,
    selected,
    trace: traces.sort((a, b) => b.score - a.score),
    reason: reasons.join(" · "),
  };
}

// Render the chosen skill bodies into a single block to prepend onto
// Evy's system prompt. Each skill is fenced so the supervisor can tell
// where one ends and the next begins.
export function renderSelected(selected: SkillEntry[]): string {
  if (selected.length === 0) return "";
  const parts: string[] = [];
  for (const e of selected) {
    parts.push(`<skill name="${e.name}">\n${e.body.trim()}\n</skill>`);
  }
  return parts.join("\n\n") + "\n\n";
}

// Test-only: blow the catalog cache so unit tests can mutate SKILL.md
// files between cases without restart.
export function _clearCacheForTesting(): void {
  cache.clear();
}
