// components/master/skills-registry.ts — v2.8.1 skills clarity
//
// Single source of truth for "what skills exist, where they came from, and
// which categorization bucket the dashboard should render them in." The
// Skills tab opaqueness operator-raised on 2026-05-13 was largely because
// every surface was reading skills from a different directory with no
// shared schema — repo skills under components/skills/, imported third-party
// catalog under ~/.config/subctl/skills/, project-local under
// <project>/.subctl/skills/, and now Evy-authored drafts under
// ~/.local/state/subctl/evy-skills/. This module unifies all of them and
// parses the extended YAML frontmatter (scope, loaded_by_default,
// created_at, created_by) added in v2.8.1.
//
// Categorization rules (Skills tab sections):
//   - "evy-loaded"     — repo skill whose `scope` is "evy" or whose
//                        `loaded_by_default` array contains "evy". These
//                        are folded into Evy's master system prompt at
//                        every turn.
//   - "team-developer" — repo skill whose `scope` is "dev-team" or "both".
//                        Available for template authors to reference in a
//                        developer's `skills = [...]` array.
//   - "evy-authored"   — anything under ~/.local/state/subctl/evy-skills/
//                        with frontmatter `created_by: evy`. These are
//                        drafts the operator can review, promote into the
//                        repo, or delete.
//   - "project-local"  — skills under <project>/.subctl/skills/<name>/SKILL.md
//                        per ADR 0003. Loaded only when working inside
//                        that project's context.
//
// Note: a single skill can appear in multiple categorical views via the
// `scope: both` value (it surfaces in both evy-loaded and team-developer
// sections). The registry returns one Skill record per file; UI code
// decides where to render it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";

// ─── types ──────────────────────────────────────────────────────────────────

export type SkillScope = "dev-team" | "evy" | "both" | "project";

export type SkillCategory =
  | "evy-loaded"
  | "team-developer"
  | "evy-authored"
  | "project-local";

export interface Skill {
  /** Canonical name from frontmatter (or directory name as fallback). */
  name: string;
  /** One-line description from frontmatter (or first body line as fallback). */
  description: string;
  /** Operator-declared scope. Defaults to "dev-team" when frontmatter omits it. */
  scope: SkillScope;
  /**
   * Personas / template names that auto-load this skill. Currently only
   * "evy" is meaningful (the master daemon loads any skill whose value
   * includes "evy" into its system prompt).
   */
  loaded_by_default: string[];
  created_at?: string;
  created_by: "operator" | "evy";
  /** Absolute path on disk. */
  path: string;
  /**
   * Where this skill originated:
   *   - "repo"     — components/skills/<name>/
   *   - "evy"      — ~/.local/state/subctl/evy-skills/<name>/
   *   - "imported" — ~/.config/subctl/skills/<source>/skills/.../
   *   - "project"  — <project>/.subctl/skills/<name>/
   */
  source: "repo" | "evy" | "imported" | "project";
  /**
   * Primary UI category. A skill with scope=both lives in "team-developer"
   * by default but the UI is free to render it under "evy-loaded" too.
   */
  category: SkillCategory;
  /**
   * If imported, the catalog source name (e.g. "mattpocock"). Empty for
   * repo / evy / project skills.
   */
  imported_source?: string;
  /** Project this skill belongs to, when source="project". */
  project?: string;
  /**
   * Promotion metadata, set when an operator promoted an evy-authored
   * draft into the repo. Preserved through the promotion edit so the
   * audit trail survives.
   */
  promoted_at?: string;
  promoted_by?: string;
}

// ─── paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..", "..");
const REPO_SKILLS_DIR = join(REPO_ROOT, "components", "skills");
const IMPORTED_SKILLS_DIR =
  process.env.SUBCTL_SKILLS_DIR ??
  join(homedir(), ".config", "subctl", "skills");

/** Where evy_author_skill writes drafts. */
export function evySkillsDir(): string {
  return (
    process.env.SUBCTL_EVY_SKILLS_DIR ??
    join(homedir(), ".local", "state", "subctl", "evy-skills")
  );
}

/** Where evy_author_skill appends an audit line per call. */
export function evySkillsAuditLog(): string {
  return (
    process.env.SUBCTL_EVY_SKILLS_AUDIT ??
    join(homedir(), ".local", "state", "subctl", "audit", "evy-skills.jsonl")
  );
}

/**
 * Resolve the set of project roots to scan for .subctl/skills. The master
 * keeps a registry of known active projects at
 * ~/.config/subctl/master/projects.json — when present, we scan each of
 * those. Tests + callers can also pass an explicit list via opts.
 */
function defaultProjectRoots(): string[] {
  const path = join(
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
    "master",
    "projects.json",
  );
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
    if (raw && typeof raw === "object" && Array.isArray(raw.roots)) {
      return raw.roots.filter((x: unknown) => typeof x === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

// ─── frontmatter parser ─────────────────────────────────────────────────────
//
// We deliberately avoid a YAML dependency and parse just the keys we need.
// SKILL.md frontmatter is conventional enough that this works in practice;
// it also keeps the registry usable from the dashboard's hot path without
// pulling in smol-toml-sized deps.

interface RawFrontmatter {
  name?: string;
  description?: string;
  scope?: string;
  loaded_by_default?: string[];
  created_at?: string;
  created_by?: string;
  promoted_at?: string;
  promoted_by?: string;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "").trim();
}

function parseList(value: string): string[] {
  // Accepts either inline JSON-ish ["a", "b"] or comma-separated.
  const inner = value.trim().replace(/^\[|\]$/g, "");
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}

function parseFrontmatter(raw: string): { fm: RawFrontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fmRaw = m[1] ?? "";
  const body = m[2] ?? "";
  const fm: RawFrontmatter = {};

  const lines = fmRaw.split("\n");
  let activeKey: keyof RawFrontmatter | null = null;
  let blockBuffer: string[] = [];
  let blockStyle: "literal" | "folded" | null = null;

  const flushBlock = () => {
    if (!activeKey || !blockStyle) {
      activeKey = null;
      blockBuffer = [];
      blockStyle = null;
      return;
    }
    let value: string;
    if (blockStyle === "literal") {
      value = blockBuffer.join("\n");
    } else {
      // folded — join with spaces, but treat blank lines as paragraph breaks
      const paragraphs: string[] = [];
      let cur: string[] = [];
      for (const ln of blockBuffer) {
        if (ln.trim() === "") {
          if (cur.length) paragraphs.push(cur.join(" "));
          cur = [];
        } else {
          cur.push(ln.trim());
        }
      }
      if (cur.length) paragraphs.push(cur.join(" "));
      value = paragraphs.join("\n\n");
    }
    (fm as Record<string, unknown>)[activeKey] = value.trim();
    activeKey = null;
    blockBuffer = [];
    blockStyle = null;
  };

  for (const line of lines) {
    if (activeKey && blockStyle) {
      // Continuation of a block-scalar value. Indented (or blank) lines
      // belong to the block; a new top-level key closes it.
      if (line === "" || /^\s/.test(line)) {
        const trimmed = line.replace(/^\s{2}/, "");
        blockBuffer.push(trimmed);
        continue;
      }
      flushBlock();
      // fall through to parse this line as a new key
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2] ?? "";
    if (rest === "|" || rest === "|-") {
      activeKey = key as keyof RawFrontmatter;
      blockStyle = "literal";
      blockBuffer = [];
      continue;
    }
    if (rest === ">" || rest === ">-") {
      activeKey = key as keyof RawFrontmatter;
      blockStyle = "folded";
      blockBuffer = [];
      continue;
    }
    // Single-line value.
    const v = rest.trim();
    switch (key) {
      case "name":
      case "description":
      case "scope":
      case "created_at":
      case "created_by":
      case "promoted_at":
      case "promoted_by":
        (fm as Record<string, string>)[key] = stripQuotes(v);
        break;
      case "loaded_by_default":
        fm.loaded_by_default = parseList(v);
        break;
      default:
        /* ignore unknown keys */
    }
  }
  flushBlock();
  return { fm, body };
}

function inferDescriptionFromBody(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) continue; // skip headings
    return t.length > 200 ? t.slice(0, 197) + "…" : t;
  }
  return "";
}

// ─── core readers ──────────────────────────────────────────────────────────

function readSkillFile(
  path: string,
  source: Skill["source"],
  fallbackName: string,
  extras: Partial<Skill> = {},
): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatter(raw);
  const name = (fm.name && fm.name.trim()) || fallbackName;
  const description =
    (fm.description && fm.description.trim()) || inferDescriptionFromBody(body);
  const scope: SkillScope = ((): SkillScope => {
    const s = (fm.scope ?? "").trim();
    if (s === "evy" || s === "dev-team" || s === "both" || s === "project") return s;
    // Defaults: project-local → "project"; evy drafts → "evy"; otherwise dev-team.
    if (source === "project") return "project";
    if (source === "evy") return "evy";
    return "dev-team";
  })();
  const loaded_by_default = Array.isArray(fm.loaded_by_default)
    ? fm.loaded_by_default
    : [];
  const created_by: "operator" | "evy" =
    fm.created_by === "evy" ? "evy" : "operator";

  const category: SkillCategory = (() => {
    if (source === "evy") return "evy-authored";
    if (source === "project") return "project-local";
    // For repo+imported, scope picks the primary bucket.
    if (scope === "evy") return "evy-loaded";
    if (loaded_by_default.includes("evy")) return "evy-loaded";
    return "team-developer";
  })();

  return {
    name,
    description,
    scope,
    loaded_by_default,
    created_at: fm.created_at,
    created_by,
    path,
    source,
    category,
    promoted_at: fm.promoted_at,
    promoted_by: fm.promoted_by,
    ...extras,
  };
}

function readRepoSkills(): Skill[] {
  const out: Skill[] = [];
  if (!existsSync(REPO_SKILLS_DIR)) return out;
  for (const entry of readdirSync(REPO_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(REPO_SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const s = readSkillFile(skillFile, "repo", entry.name);
    if (s) out.push(s);
  }
  return out;
}

function readEvyAuthoredSkills(): Skill[] {
  const out: Skill[] = [];
  const dir = evySkillsDir();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const s = readSkillFile(skillFile, "evy", entry.name);
    if (s) out.push(s);
  }
  return out;
}

function readImportedSkills(): Skill[] {
  const out: Skill[] = [];
  if (!existsSync(IMPORTED_SKILLS_DIR)) return out;
  // Layout: <root>/<sourceName>/skills/<...nested>/SKILL.md
  for (const sourceEntry of readdirSync(IMPORTED_SKILLS_DIR, {
    withFileTypes: true,
  })) {
    if (!sourceEntry.isDirectory() || sourceEntry.name.startsWith(".")) continue;
    const sourceRoot = join(IMPORTED_SKILLS_DIR, sourceEntry.name, "skills");
    if (!existsSync(sourceRoot)) continue;
    const stack: string[] = [sourceRoot];
    while (stack.length) {
      const cur = stack.pop()!;
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name === "SKILL.md") {
          const s = readSkillFile(p, "imported", basename(cur), {
            imported_source: sourceEntry.name,
          });
          if (s) out.push(s);
        }
      }
    }
  }
  return out;
}

function readProjectSkills(projectRoots: string[]): Skill[] {
  const out: Skill[] = [];
  for (const root of projectRoots) {
    const dir = join(root, ".subctl", "skills");
    if (!existsSync(dir)) continue;
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const s = readSkillFile(skillFile, "project", entry.name, {
        project: basename(root),
      });
      if (s) out.push(s);
    }
  }
  return out;
}

// ─── public API ────────────────────────────────────────────────────────────

export interface ListSkillsOptions {
  category?: SkillCategory;
  /** Explicit list of project roots to scan; defaults to projects.json. */
  projectRoots?: string[];
  /** Skip imported third-party catalog. */
  skipImported?: boolean;
}

export function listSkills(opts: ListSkillsOptions = {}): Skill[] {
  const skills: Skill[] = [];
  skills.push(...readRepoSkills());
  skills.push(...readEvyAuthoredSkills());
  if (!opts.skipImported) skills.push(...readImportedSkills());
  const roots = opts.projectRoots ?? defaultProjectRoots();
  skills.push(...readProjectSkills(roots));

  if (opts.category) {
    return skills.filter((s) => s.category === opts.category);
  }
  return skills;
}

export function getSkill(
  name: string,
  opts: ListSkillsOptions = {},
): Skill | null {
  const all = listSkills(opts);
  // Exact name match takes precedence; then suffix-of-id match for imported
  // skills which often look like "mattpocock/engineering/grill-with-docs".
  for (const s of all) {
    if (s.name === name) return s;
  }
  for (const s of all) {
    if (s.source === "imported" && s.path.includes(`/${name}/SKILL.md`)) return s;
  }
  return null;
}

/**
 * Resolve which Skill records map to a team template's `skills = [...]`
 * arrays. Returns the joined skills for the lead and each developer.
 *
 * Pass an explicit template object (the caller already loaded one via
 * team-templates.ts) so this module stays decoupled from the templates
 * loader and doesn't pull in smol-toml as a transitive dep.
 */
export interface TemplateLike {
  name: string;
  lead: { skills: string[] };
  developers: { name: string; skills: string[] }[];
}

export interface ResolvedTemplateSkills {
  template: string;
  lead: Skill[];
  developers: { name: string; skills: Skill[] }[];
}

export function resolveSkillsForTemplate(
  template: TemplateLike,
  opts: ListSkillsOptions = {},
): ResolvedTemplateSkills {
  const all = listSkills(opts);
  const lookup = new Map<string, Skill>();
  for (const s of all) {
    if (!lookup.has(s.name)) lookup.set(s.name, s);
  }
  const resolve = (ids: string[]): Skill[] =>
    ids
      .map((id) => lookup.get(id) ?? lookup.get(id.split("/").pop() ?? id))
      .filter((s): s is Skill => Boolean(s));

  return {
    template: template.name,
    lead: resolve(template.lead?.skills ?? []),
    developers: (template.developers ?? []).map((d) => ({
      name: d.name,
      skills: resolve(d.skills ?? []),
    })),
  };
}

/**
 * Reverse lookup: given a skill name, which loaded team templates reference
 * it (lead or developer side)? Used by the dashboard Skills tab to annotate
 * each team-developer skill with "used by N templates".
 */
export function templatesUsingSkill(
  skillName: string,
  templates: TemplateLike[],
): { template: string; roles: string[] }[] {
  const out: { template: string; roles: string[] }[] = [];
  for (const t of templates) {
    const roles: string[] = [];
    if (t.lead?.skills?.includes(skillName)) roles.push("lead");
    for (const d of t.developers ?? []) {
      if (d.skills?.includes(skillName)) roles.push(d.name);
    }
    if (roles.length) out.push({ template: t.name, roles });
  }
  return out;
}

// ─── evy-authored skill curation ───────────────────────────────────────────

const EVY_NAME_RE = /^[a-z][a-z0-9-]{1,48}$/;

export interface AuthorSkillInput {
  name: string;
  description: string;
  body: string;
  scope: "evy" | "dev-team" | "both";
  reason: string;
}

export interface AuthorSkillResult {
  ok: boolean;
  path?: string;
  name?: string;
  error?: string;
}

function buildEvySkillContent(
  input: AuthorSkillInput,
  now: string,
): string {
  // Build a properly-fenced SKILL.md with full v2.8.1 frontmatter. We
  // sanitize the description (one line, trimmed) and pass the body
  // through verbatim trimmed.
  const desc = input.description.trim().replace(/\n+/g, " ").slice(0, 400);
  const body = input.body.trim();
  return `---
name: ${input.name}
description: ${JSON.stringify(desc)}
scope: ${input.scope}
loaded_by_default: []
created_at: ${JSON.stringify(now)}
created_by: evy
---

${body}
`;
}

/**
 * Create a new Evy-authored skill draft. Returns ok=false with a reason if
 * the name is invalid, already exists in the repo, or already exists in
 * the evy-skills dir.
 *
 * Caller (the master tool) is responsible for: emitting the
 * `evy-authored-skill` notification + appending to the audit log.
 */
export function authorEvySkill(input: AuthorSkillInput): AuthorSkillResult {
  if (!EVY_NAME_RE.test(input.name)) {
    return {
      ok: false,
      error: `name must match /^[a-z][a-z0-9-]{1,48}$/ — got '${input.name}'`,
    };
  }
  // Collision check against the repo (operator-authored canonical) AND
  // existing evy drafts. We refuse both — operator can rename to disambiguate.
  const repoCollision = join(REPO_SKILLS_DIR, input.name, "SKILL.md");
  if (existsSync(repoCollision)) {
    return {
      ok: false,
      error: `skill '${input.name}' already exists in the repo at ${repoCollision}`,
    };
  }
  const dir = evySkillsDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, input.name, "SKILL.md");
  if (existsSync(target)) {
    return {
      ok: false,
      error: `skill '${input.name}' already drafted at ${target}`,
    };
  }
  try {
    mkdirSync(join(dir, input.name), { recursive: true });
    writeFileSync(target, buildEvySkillContent(input, new Date().toISOString()));
    return { ok: true, path: target, name: input.name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Promote an Evy-authored draft into the repo's components/skills/<name>/
 * dir. Adds promoted_by + promoted_at to the frontmatter so the audit
 * trail survives. Does NOT auto-commit to git — operator reviews the diff
 * in their git client. Returns the new repo path on success.
 */
export interface PromoteResult {
  ok: boolean;
  from?: string;
  to?: string;
  error?: string;
}

export function promoteEvySkill(
  name: string,
  promotedBy: string,
): PromoteResult {
  const src = join(evySkillsDir(), name, "SKILL.md");
  if (!existsSync(src)) {
    return { ok: false, error: `not found: ${src}` };
  }
  const destDir = join(REPO_SKILLS_DIR, name);
  const dest = join(destDir, "SKILL.md");
  if (existsSync(dest)) {
    return {
      ok: false,
      error: `repo already has components/skills/${name}/SKILL.md — refusing overwrite`,
    };
  }
  try {
    const raw = readFileSync(src, "utf8");
    // Rewrite frontmatter: keep all fields, add promoted_at + promoted_by.
    const now = new Date().toISOString();
    let updated: string;
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (fmMatch) {
      const fmLines = fmMatch[1]!.split("\n").filter((l) => {
        // Drop any prior promoted_* lines so we replace, not duplicate.
        return !l.match(/^(promoted_at|promoted_by):/);
      });
      fmLines.push(`promoted_at: ${JSON.stringify(now)}`);
      fmLines.push(`promoted_by: ${JSON.stringify(promotedBy)}`);
      updated = `---\n${fmLines.join("\n")}\n---\n${fmMatch[2] ?? ""}`;
    } else {
      // No frontmatter — wrap the body.
      updated = `---\nname: ${name}\npromoted_at: ${JSON.stringify(now)}\npromoted_by: ${JSON.stringify(promotedBy)}\n---\n${raw}`;
    }
    mkdirSync(destDir, { recursive: true });
    writeFileSync(dest, updated);
    return { ok: true, from: src, to: dest };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Remove an Evy-authored draft. Repo-tracked skills cannot be removed via this path. */
export function deleteEvySkill(name: string): {
  ok: boolean;
  removed?: string;
  error?: string;
} {
  const dir = join(evySkillsDir(), name);
  if (!existsSync(dir)) return { ok: false, error: `not found: ${dir}` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed: dir };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
