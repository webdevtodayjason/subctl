// components/evy/team-templates.ts — v2.8.0 team-template foundation.
//
// A team template is a TOML document declaring a multi-developer dev team:
// the lead persona + skills, plus a roster of developers, each with their
// own persona, skills, and tool allowlist. This is the architectural feature
// subctl was built for — actual multi-agent teams with declared rosters
// rather than the v2.7.x single-lead-with-freeform-Agent()-spawn model.
//
// Storage:        ~/.config/subctl/team-templates/<name>.toml
// Built-ins:      seeded into the dir on first listTemplates() call so
//                 operators have working starting points without manual
//                 file authoring.
// Cache:          in-memory map keyed by template name, invalidated by
//                 fs.watch on the templates dir (debounced 250ms).
// Validation:     enforced on load; invalid templates are surfaced with
//                 a precise error so the dashboard / CLI / spawn flow
//                 can render the failure clearly.
//
// Distinct from the v2.7.x single-persona JSON templates at
// ~/.config/subctl/evy/team-templates/<name>.json (still consumed by
// subctl_orch_spawn_template). The TOML format here is roster-shaped
// and consumed by the new subctl_team_dispatch flow.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

// ─── types ──────────────────────────────────────────────────────────────────

/** Lead block — drives the team-lead Claude Code session in pane 0. */
export interface TeamTemplateLead {
  /** Persona name. References a master personality preset OR a freeform string baked into the lead's boot prompt. */
  persona: string;
  /** Skill IDs (source/skill-name) copied into the lead's .claude/skills/ at spawn. */
  skills: string[];
  /** Optional override boot prompt; if empty, the persona's default boot prompt is used. */
  boot_prompt?: string;
  /** Optional autonomy override: "drive" | "ask" | "shadow". */
  autonomy?: "drive" | "ask" | "shadow";
}

/** Developer block — one worker the lead can dispatch to. */
export interface TeamTemplateDeveloper {
  /** Logical name. Used as the developer_name in subctl_team_dispatch. Stable across spawns. */
  name: string;
  /** Persona name. Same shape as lead.persona. */
  persona: string;
  /** Skill IDs copied into this developer's .claude/skills/ at first dispatch. */
  skills: string[];
  /**
   * Tool allowlist. Used both as Claude Code permission baseline (Read, Edit,
   * Write, etc.) and as bash-gate input — entries of the form
   *   "Bash:cmd1,cmd2"
   * narrow the bash-gate allowlist to the listed commands when this developer
   * is spawned. Entries without a colon are treated as plain Claude Code
   * permission names.
   */
  tools: string[];
}

/** Parsed + validated template. */
export interface TeamTemplate {
  /** Bare template name (filename without .toml). */
  name: string;
  /** Operator-facing description. */
  description: string;
  /** Filesystem path the template was loaded from. */
  path: string;
  /** Raw TOML source (for the dashboard "Show" view). */
  source: string;
  lead: TeamTemplateLead;
  developers: TeamTemplateDeveloper[];
}

/** Result of validateTemplate(). */
export interface TemplateValidation {
  ok: boolean;
  errors: string[];
}

// ─── paths ──────────────────────────────────────────────────────────────────

/**
 * Resolve the team-templates directory. Operator-overridable via env so
 * tests can scope to a tmpdir.
 *
 * NOTE: distinct from the v2.7.x single-persona JSON dir
 * (~/.config/subctl/evy/team-templates/) — that one is consumed by the
 * legacy `subctl_orch_spawn_template` flow and stays for backward compat.
 */
export function teamTemplatesDir(): string {
  return (
    process.env.SUBCTL_V2_TEAM_TEMPLATES_DIR ??
    join(
      process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
      "team-templates",
    )
  );
}

// ─── built-in stock templates ───────────────────────────────────────────────
//
// Seeded into the templates dir on first listTemplates() call so the
// operator has working starting points immediately. Files are only
// written if they don't already exist — operators can edit them freely
// and our seed pass won't stomp their changes.

const STOCK_TEMPLATES: Record<string, string> = {
  "full-stack-web": `# Full-stack web team — frontend + backend + QA.
# Lead coordinates feature work across the three developers.

[template]
name = "full-stack-web"
description = "Frontend (React/TS) + backend (Bun/TS API) + QA tester"

[lead]
persona = "evy"
skills = ["subctl-team-protocol", "handoff-protocol"]
autonomy = "ask"

[[developers]]
name = "frontend-dev"
persona = "expert-react-typescript"
skills = ["node-conventions", "react-patterns"]
tools = ["Read", "Edit", "Write", "Bash:bun,npm,git,node"]

[[developers]]
name = "backend-dev"
persona = "expert-bun-typescript"
skills = ["node-conventions", "bun-runtime"]
tools = ["Read", "Edit", "Write", "Bash:bun,git,curl,jq"]

[[developers]]
name = "qa-tester"
persona = "expert-test-engineer"
skills = ["spec-driven-dev", "test-strategy"]
tools = ["Read", "Bash:bun,npm,git,curl"]
`,
  "rust-api": `# Rust API team — API dev + DB dev + tests dev.

[template]
name = "rust-api"
description = "Rust backend: API handlers + database migrations + integration tests"

[lead]
persona = "evy"
skills = ["subctl-team-protocol", "handoff-protocol"]
autonomy = "ask"

[[developers]]
name = "api-dev"
persona = "expert-rust"
skills = ["rust-conventions", "axum-patterns"]
tools = ["Read", "Edit", "Write", "Bash:cargo,git,curl"]

[[developers]]
name = "db-dev"
persona = "expert-rust-databases"
skills = ["rust-conventions", "sqlx-patterns"]
tools = ["Read", "Edit", "Write", "Bash:cargo,git,psql,sqlx"]

[[developers]]
name = "tests-dev"
persona = "expert-test-engineer"
skills = ["spec-driven-dev"]
tools = ["Read", "Bash:cargo,git"]
`,
  "data-pipeline": `# Data pipeline team — ingestion + transform + storage.

[template]
name = "data-pipeline"
description = "ETL pipeline: ingestion + transformation + storage layer"

[lead]
persona = "evy"
skills = ["subctl-team-protocol", "handoff-protocol"]
autonomy = "ask"

[[developers]]
name = "ingestion-dev"
persona = "expert-python-data"
skills = ["python-conventions"]
tools = ["Read", "Edit", "Write", "Bash:python,uv,git,curl"]

[[developers]]
name = "transform-dev"
persona = "expert-python-data"
skills = ["python-conventions", "pandas-patterns"]
tools = ["Read", "Edit", "Write", "Bash:python,uv,git"]

[[developers]]
name = "storage-dev"
persona = "expert-python-databases"
skills = ["python-conventions"]
tools = ["Read", "Edit", "Write", "Bash:python,uv,git,psql"]
`,
  "ml-research": `# ML research team — research + experiments + writeup.

[template]
name = "ml-research"
description = "ML research workflow: literature + experiment runners + paper drafts"

[lead]
persona = "evy"
skills = ["subctl-team-protocol", "handoff-protocol"]
autonomy = "ask"

[[developers]]
name = "research-dev"
persona = "expert-ml-researcher"
skills = ["python-conventions"]
tools = ["Read", "Edit", "Write", "Bash:python,uv,git,curl"]

[[developers]]
name = "experiments-dev"
persona = "expert-ml-engineer"
skills = ["python-conventions", "pytorch-patterns"]
tools = ["Read", "Edit", "Write", "Bash:python,uv,git,nvidia-smi"]

[[developers]]
name = "writeup-dev"
persona = "expert-technical-writer"
skills = ["technical-writing"]
tools = ["Read", "Edit", "Write", "Bash:git,pandoc"]
`,
  infrastructure: `# Infrastructure team — terraform + docker + monitoring.

[template]
name = "infrastructure"
description = "Infra-as-code: terraform + docker compose + observability"

[lead]
persona = "evy"
skills = ["subctl-team-protocol", "handoff-protocol"]
autonomy = "ask"

[[developers]]
name = "terraform-dev"
persona = "expert-terraform"
skills = ["infra-conventions", "terraform-patterns"]
tools = ["Read", "Edit", "Write", "Bash:terraform,git,aws,gcloud"]

[[developers]]
name = "docker-dev"
persona = "expert-docker"
skills = ["infra-conventions", "container-patterns"]
tools = ["Read", "Edit", "Write", "Bash:docker,git,curl"]

[[developers]]
name = "monitoring-dev"
persona = "expert-observability"
skills = ["infra-conventions"]
tools = ["Read", "Edit", "Write", "Bash:git,curl,promtool"]
`,
};

/** Write the stock templates into the templates dir IF they're not present. Idempotent. */
export function seedStockTemplates(): void {
  const dir = teamTemplatesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(STOCK_TEMPLATES)) {
    const path = join(dir, `${name}.toml`);
    if (!existsSync(path)) {
      writeFileSync(path, body, "utf-8");
    }
  }
}

// ─── validation ─────────────────────────────────────────────────────────────

const TEMPLATE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const DEV_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate the shape of a parsed-and-cast template. Errors are returned
 * accumulated so the dashboard/CLI can render all problems at once.
 */
export function validateTemplate(
  parsed: unknown,
  source: { name: string; path?: string },
): TemplateValidation {
  const errors: string[] = [];

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["template root must be a TOML table"] };
  }
  const root = parsed as Record<string, unknown>;

  const tmpl = root.template as Record<string, unknown> | undefined;
  if (!tmpl || typeof tmpl !== "object") {
    errors.push("[template] block is required");
  } else {
    if (typeof tmpl.name !== "string" || !tmpl.name) {
      errors.push("[template].name must be a non-empty string");
    } else if (!TEMPLATE_NAME_RE.test(tmpl.name)) {
      errors.push(
        `[template].name "${tmpl.name}" must match ${TEMPLATE_NAME_RE} (alphanumerics, . _ -)`,
      );
    } else if (tmpl.name !== source.name) {
      errors.push(
        `[template].name "${tmpl.name}" does not match filename "${source.name}"`,
      );
    }
    if (tmpl.description != null && typeof tmpl.description !== "string") {
      errors.push("[template].description must be a string when present");
    }
  }

  const lead = root.lead as Record<string, unknown> | undefined;
  if (!lead || typeof lead !== "object") {
    errors.push("[lead] block is required");
  } else {
    if (typeof lead.persona !== "string" || !lead.persona) {
      errors.push("[lead].persona must be a non-empty string");
    }
    if (lead.skills != null) {
      if (!Array.isArray(lead.skills) || lead.skills.some((s) => typeof s !== "string")) {
        errors.push("[lead].skills must be an array of strings");
      }
    }
    if (lead.boot_prompt != null && typeof lead.boot_prompt !== "string") {
      errors.push("[lead].boot_prompt must be a string when present");
    }
    if (lead.autonomy != null) {
      if (!["drive", "ask", "shadow"].includes(lead.autonomy as string)) {
        errors.push(`[lead].autonomy must be one of drive | ask | shadow (got "${lead.autonomy}")`);
      }
    }
  }

  const devs = root.developers as unknown;
  if (!Array.isArray(devs) || devs.length === 0) {
    errors.push("[[developers]] must contain at least one developer entry");
  } else {
    const seen = new Set<string>();
    devs.forEach((d, i) => {
      if (!d || typeof d !== "object" || Array.isArray(d)) {
        errors.push(`developers[${i}] must be a table`);
        return;
      }
      const dev = d as Record<string, unknown>;
      if (typeof dev.name !== "string" || !dev.name) {
        errors.push(`developers[${i}].name must be a non-empty string`);
      } else if (!DEV_NAME_RE.test(dev.name)) {
        errors.push(
          `developers[${i}].name "${dev.name}" must match ${DEV_NAME_RE}`,
        );
      } else if (seen.has(dev.name)) {
        errors.push(`developer name "${dev.name}" appears more than once`);
      } else {
        seen.add(dev.name);
      }
      if (typeof dev.persona !== "string" || !dev.persona) {
        errors.push(`developers[${i}].persona must be a non-empty string`);
      }
      if (dev.skills != null) {
        if (
          !Array.isArray(dev.skills) ||
          dev.skills.some((s) => typeof s !== "string")
        ) {
          errors.push(`developers[${i}].skills must be an array of strings`);
        }
      }
      if (dev.tools != null) {
        if (
          !Array.isArray(dev.tools) ||
          dev.tools.some((s) => typeof s !== "string")
        ) {
          errors.push(`developers[${i}].tools must be an array of strings`);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

// ─── parse + load ───────────────────────────────────────────────────────────

/**
 * Parse a raw TOML string into a TeamTemplate. Throws on parse / validation
 * failure with a single human-readable error string. The thrown error has
 * a `.validationErrors` array attached when validation (not parse) failed,
 * so callers can render structured feedback.
 */
export function parseTemplate(
  rawToml: string,
  source: { name: string; path?: string },
): TeamTemplate {
  let parsed: unknown;
  try {
    parsed = parseToml(rawToml);
  } catch (err) {
    throw new Error(
      `failed to parse template "${source.name}.toml": ${(err as Error).message}`,
    );
  }
  const v = validateTemplate(parsed, source);
  if (!v.ok) {
    const e = new Error(
      `invalid template "${source.name}": ${v.errors.join("; ")}`,
    );
    (e as Error & { validationErrors?: string[] }).validationErrors = v.errors;
    throw e;
  }

  const root = parsed as Record<string, unknown>;
  const tmpl = root.template as Record<string, unknown>;
  const lead = root.lead as Record<string, unknown>;
  const devs = root.developers as Record<string, unknown>[];

  return {
    name: String(tmpl.name),
    description: typeof tmpl.description === "string" ? tmpl.description : "",
    path: source.path ?? "",
    source: rawToml,
    lead: {
      persona: String(lead.persona),
      skills: Array.isArray(lead.skills) ? (lead.skills as string[]).slice() : [],
      boot_prompt:
        typeof lead.boot_prompt === "string" ? lead.boot_prompt : undefined,
      autonomy:
        lead.autonomy === "drive" || lead.autonomy === "ask" || lead.autonomy === "shadow"
          ? (lead.autonomy as "drive" | "ask" | "shadow")
          : undefined,
    },
    developers: devs.map((d) => ({
      name: String(d.name),
      persona: String(d.persona),
      skills: Array.isArray(d.skills) ? (d.skills as string[]).slice() : [],
      tools: Array.isArray(d.tools) ? (d.tools as string[]).slice() : [],
    })),
  };
}

// ─── cache + hot-reload ─────────────────────────────────────────────────────

interface CacheEntry {
  template: TeamTemplate;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();
let watcher: FSWatcher | null = null;
let watcherDir: string | null = null;
let watcherDebounce: ReturnType<typeof setTimeout> | null = null;

/** Drop the in-memory cache. Test helper + invoked by the fs.watch handler. */
export function invalidateCache(): void {
  cache.clear();
}

/** Stop watching (test helper / shutdown). */
export function stopWatching(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
    watcherDir = null;
  }
  if (watcherDebounce) {
    clearTimeout(watcherDebounce);
    watcherDebounce = null;
  }
}

function ensureWatcher(dir: string): void {
  if (watcher && watcherDir === dir) return;
  stopWatching();
  if (!existsSync(dir)) return;
  watcherDir = dir;
  try {
    watcher = fsWatch(dir, { persistent: false }, () => {
      // Debounce so a rapid burst of save events from an editor flushes
      // the cache exactly once.
      if (watcherDebounce) clearTimeout(watcherDebounce);
      watcherDebounce = setTimeout(() => {
        invalidateCache();
        watcherDebounce = null;
      }, 250);
    });
  } catch {
    // fs.watch isn't supported in every environment (e.g. some sandboxes).
    // The cache just won't hot-reload; loadTemplate's mtime check below
    // still catches changes on the next call.
    watcher = null;
    watcherDir = null;
  }
}

/**
 * Load one template by name. Reads from disk on cache miss or mtime change;
 * otherwise returns the cached entry. Throws on parse/validation failure.
 */
export function loadTemplate(name: string): TeamTemplate {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new Error(`invalid template name: "${name}" (must match ${TEMPLATE_NAME_RE})`);
  }
  const dir = teamTemplatesDir();
  ensureWatcher(dir);
  const path = join(dir, `${name}.toml`);
  if (!existsSync(path)) {
    throw new Error(`team template not found: ${path}`);
  }
  // Stat for mtime; if mtime hasn't moved and the cache hit, return.
  const stat = require("node:fs").statSync(path) as { mtimeMs: number };
  const cached = cache.get(name);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.template;

  const raw = readFileSync(path, "utf-8");
  const template = parseTemplate(raw, { name, path });
  cache.set(name, { template, mtimeMs: stat.mtimeMs });
  return template;
}

/**
 * List all templates in the dir. Seeds the stock templates on first call
 * if they're missing. Returns the parsed templates that loaded cleanly;
 * unparseable entries appear in the `errors` array so the dashboard can
 * surface them without breaking the whole listing.
 */
export function listTemplates(): {
  templates: TeamTemplate[];
  errors: { name: string; error: string }[];
} {
  seedStockTemplates();
  const dir = teamTemplatesDir();
  ensureWatcher(dir);
  const templates: TeamTemplate[] = [];
  const errors: { name: string; error: string }[] = [];
  if (!existsSync(dir)) return { templates, errors };
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".toml")) continue;
    const name = entry.slice(0, -".toml".length);
    if (!TEMPLATE_NAME_RE.test(name)) {
      errors.push({ name, error: `invalid filename "${entry}" (must match ${TEMPLATE_NAME_RE}.toml)` });
      continue;
    }
    try {
      templates.push(loadTemplate(name));
    } catch (err) {
      errors.push({ name, error: (err as Error).message });
    }
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return { templates, errors };
}

// ─── roster injection ──────────────────────────────────────────────────────

/**
 * Render the lead-side roster preamble. Injected into the lead's spawn-time
 * prompt so it knows the developers it has access to and the right tool name
 * to dispatch with.
 */
export function renderRosterPreamble(t: TeamTemplate): string {
  const devLines = t.developers
    .map((d) => `  - ${d.name} (${d.persona})`)
    .join("\n");
  const exampleDev = t.developers[0]?.name ?? "frontend-dev";
  return `[subctl team roster · template=${t.name}]
You are the team lead of a subctl-orchestrated dev team. Your team has the
following developers:

${devLines}

Use the master tool \`subctl_team_dispatch({ team, developer_name, task_description })\`
to assign work. Each developer is scoped to its own persona + skills + tool
allowlist (set by the template), so route work to the developer whose role
best fits the task. Example:

  subctl_team_dispatch({
    team: "<your team-id>",
    developer_name: "${exampleDev}",
    task_description: "<concrete task with file paths + acceptance criteria>"
  })

Developers are spawned on first dispatch (lazy). Re-dispatching to a live
developer injects the new task into its existing pane — it doesn't restart
the worker.
[/subctl team roster]
`;
}

// ─── per-developer tool scoping ─────────────────────────────────────────────

export interface DeveloperToolScope {
  /** Bash-gate allowlist for shell commands. Empty array = no Bash. */
  bashAllowlist: string[];
  /** Non-Bash Claude Code permissions (Read, Edit, Write, …). */
  permissions: string[];
}

/**
 * Project a developer's tools[] declaration into a usable spawn-time scope.
 * Entries of the form "Bash:cmd1,cmd2" contribute to bashAllowlist; everything
 * else becomes a Claude Code permission name. If the developer declares no
 * Bash entry, the bash allowlist is empty — i.e. the developer can't shell
 * out, which is the safe default.
 */
export function projectDeveloperToolScope(
  dev: TeamTemplateDeveloper,
): DeveloperToolScope {
  const bash: string[] = [];
  const perms: string[] = [];
  for (const entry of dev.tools) {
    if (entry.startsWith("Bash:")) {
      const cmds = entry
        .slice("Bash:".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      bash.push(...cmds);
    } else if (entry === "Bash") {
      // Bare "Bash" = unconstrained shell — equivalent to the trusted-mode
      // baseline. Encoded as the sentinel "*".
      bash.push("*");
    } else {
      perms.push(entry);
    }
  }
  // De-dup while preserving order
  const dedup = (a: string[]) => Array.from(new Set(a));
  return { bashAllowlist: dedup(bash), permissions: dedup(perms) };
}
