// components/evy/templates-loader.ts — in-tree team-template registry.
//
// A "team template" here is a folder under components/templates/<name>/
// containing two files:
//
//   template.json       metadata: { name, role, description, default_account_hint }
//   boot_prompt.md      the worker's initial mandate (with {{var}} substitution)
//
// This is the registry consulted by `subctl_orch_spawn_template`. It is
// distinct from the two legacy registries:
//
//   - ~/.config/subctl/evy/team-templates/<name>.json  (v2.7.x persona JSON,
//     loaded by providers/claude/teams.sh _provider_claude_apply_template)
//   - ~/.config/subctl/team-templates/<name>.toml         (v2.8.0 multi-developer
//     rosters, loaded by components/evy/team-templates.ts)
//
// The in-tree registry is versioned with the repo and ships baseline templates
// out of the box, so `subctl_orch_spawn_template feature-dev` works on a fresh
// install with no operator setup.
//
// Boot prompts are rendered with a minimal substitution scheme:
//
//   {{project_path}}       absolute path to the worker's project
//   {{account}}            account alias the worker is spawned on
//   {{additional_scope}}   optional extra mandate layered on the template's
//                          boot prompt (empty string if omitted)
//
// Unknown {{vars}} in a boot prompt throw at render time so a typo can't
// silently leak the literal `{{projectpath}}` into a worker's pane.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ─── types ──────────────────────────────────────────────────────────────────

/** Roles supported by the claude-layers role-overlay system. */
export type TemplateRole = "forge" | "sentry" | "scout" | "quill";

/** Parsed metadata block (template.json). */
export interface TemplateMetadata {
  /** Bare template name. Must match the folder name. */
  name: string;
  /** Claude-layers role overlay this template targets. */
  role: TemplateRole;
  /** Operator-facing description. */
  description: string;
  /** Suggested account alias from accounts.conf. Operator can override at spawn. */
  default_account_hint?: string;
}

/** Fully loaded template (metadata + raw boot prompt body). */
export interface TeamTemplateEntry {
  metadata: TemplateMetadata;
  /** Absolute path to the template folder. */
  path: string;
  /** Raw boot_prompt.md contents — un-rendered, variables still as `{{foo}}`. */
  bootPromptRaw: string;
}

/** Variable bag accepted by renderBootPrompt. */
export interface BootPromptVars {
  project_path: string;
  account: string;
  /** Optional operator-added scope; rendered as empty string when undefined. */
  additional_scope?: string;
}

// ─── paths ──────────────────────────────────────────────────────────────────

const VALID_ROLES: ReadonlySet<TemplateRole> = new Set([
  "forge",
  "sentry",
  "scout",
  "quill",
]);

const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const ALLOWED_VARS: ReadonlySet<string> = new Set([
  "project_path",
  "account",
  "additional_scope",
]);

/**
 * Resolve the registry directory. Defaults to `<repo>/components/templates`
 * (computed from this file's location so it works regardless of the caller's
 * cwd). Overridable via `SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR` so tests can
 * scope to a tmpdir.
 */
export function templatesRegistryDir(): string {
  const override = process.env.SUBCTL_TEAM_TEMPLATES_REGISTRY_DIR;
  if (override) return override;
  // __dirname equivalent for ES modules under Bun.
  const here = dirname(fileURLToPath(import.meta.url));
  // components/evy/templates-loader.ts → components/templates
  return join(here, "..", "templates");
}

// ─── load + parse ───────────────────────────────────────────────────────────

/**
 * Parse template.json into a TemplateMetadata. Throws with a precise error
 * on missing fields, unknown role, or name/folder mismatch.
 */
function parseMetadata(
  raw: string,
  folderName: string,
  path: string,
): TemplateMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `template "${folderName}": failed to parse template.json: ${(err as Error).message}`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`template "${folderName}": template.json must be an object`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name) {
    throw new Error(`template "${folderName}": template.json missing 'name'`);
  }
  if (!TEMPLATE_NAME_RE.test(m.name)) {
    throw new Error(
      `template "${folderName}": name "${m.name}" must match ${TEMPLATE_NAME_RE}`,
    );
  }
  if (m.name !== folderName) {
    throw new Error(
      `template "${folderName}": template.json name "${m.name}" must equal folder name`,
    );
  }
  if (typeof m.role !== "string" || !VALID_ROLES.has(m.role as TemplateRole)) {
    throw new Error(
      `template "${folderName}": role must be one of forge|sentry|scout|quill (got "${String(m.role)}")`,
    );
  }
  if (typeof m.description !== "string" || !m.description) {
    throw new Error(`template "${folderName}": description must be a non-empty string`);
  }
  if (
    m.default_account_hint != null &&
    typeof m.default_account_hint !== "string"
  ) {
    throw new Error(
      `template "${folderName}": default_account_hint must be a string when present`,
    );
  }
  return {
    name: m.name,
    role: m.role as TemplateRole,
    description: m.description,
    default_account_hint:
      typeof m.default_account_hint === "string" && m.default_account_hint
        ? m.default_account_hint
        : undefined,
  };
}

/** Internal: load one template folder from disk. */
function loadFromFolder(folder: string, base: string): TeamTemplateEntry {
  const dir = join(base, folder);
  const metaPath = join(dir, "template.json");
  const bootPath = join(dir, "boot_prompt.md");
  if (!existsSync(metaPath)) {
    throw new Error(`template "${folder}": missing template.json at ${metaPath}`);
  }
  if (!existsSync(bootPath)) {
    throw new Error(`template "${folder}": missing boot_prompt.md at ${bootPath}`);
  }
  const metaRaw = readFileSync(metaPath, "utf-8");
  const metadata = parseMetadata(metaRaw, folder, metaPath);
  const bootPromptRaw = readFileSync(bootPath, "utf-8");
  // Validate boot prompt only references allowed vars — surfaces typos
  // (`{{projectpath}}`) at load time rather than at render time.
  for (const match of bootPromptRaw.matchAll(VAR_RE)) {
    const v = match[1];
    if (!v || !ALLOWED_VARS.has(v)) {
      throw new Error(
        `template "${folder}": boot_prompt.md references unknown variable "{{${v}}}". Allowed: ${[...ALLOWED_VARS].join(", ")}`,
      );
    }
  }
  return { metadata, path: dir, bootPromptRaw };
}

/**
 * List every template in the registry. Folders that fail to parse are
 * collected in `errors` so the caller (dashboard, tool) can surface them
 * without breaking the whole listing.
 */
export function listTemplates(): {
  templates: TeamTemplateEntry[];
  errors: { name: string; error: string }[];
} {
  const dir = templatesRegistryDir();
  const templates: TeamTemplateEntry[] = [];
  const errors: { name: string; error: string }[] = [];
  if (!existsSync(dir)) return { templates, errors };
  for (const entry of readdirSync(dir)) {
    // Skip files; we only care about template folders.
    let isDir = false;
    try {
      isDir = statSync(join(dir, entry)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!TEMPLATE_NAME_RE.test(entry)) {
      errors.push({
        name: entry,
        error: `invalid template folder name "${entry}" (must match ${TEMPLATE_NAME_RE})`,
      });
      continue;
    }
    try {
      templates.push(loadFromFolder(entry, dir));
    } catch (err) {
      errors.push({ name: entry, error: (err as Error).message });
    }
  }
  templates.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  return { templates, errors };
}

/**
 * Load one template by name. Throws on missing folder, missing files, or
 * validation failure.
 */
export function getTemplate(name: string): TeamTemplateEntry {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new Error(
      `invalid template name "${name}" (must match ${TEMPLATE_NAME_RE})`,
    );
  }
  const dir = templatesRegistryDir();
  const folder = join(dir, name);
  if (!existsSync(folder)) {
    throw new Error(
      `team template not found: "${name}" (looked in ${dir}). Run \`subctl templates list\` to see available templates.`,
    );
  }
  return loadFromFolder(name, dir);
}

// ─── render ─────────────────────────────────────────────────────────────────

/**
 * Substitute {{project_path}}, {{account}}, {{additional_scope}} into the
 * template's boot_prompt.md and return the rendered string. Errors loudly if
 * a required variable (project_path, account) is missing — these are the
 * minimum the worker needs to know where it is and who it's logged in as.
 *
 * `additional_scope` is optional; an absent value renders as the empty
 * string. The template author should fence it so an empty value doesn't
 * leave a dangling header — recommended pattern:
 *
 *     ## Additional scope
 *     {{additional_scope}}
 *
 * is fine because the section header reads as empty-but-present; or omit the
 * header from the template body and rely on the spawn-time prompt to add it.
 */
export function renderBootPrompt(
  name: string,
  vars: BootPromptVars,
): string {
  if (typeof vars.project_path !== "string" || !vars.project_path) {
    throw new Error(
      `renderBootPrompt("${name}"): project_path is required`,
    );
  }
  if (typeof vars.account !== "string" || !vars.account) {
    throw new Error(`renderBootPrompt("${name}"): account is required`);
  }
  const tpl = getTemplate(name);
  const additional =
    typeof vars.additional_scope === "string" ? vars.additional_scope : "";
  return tpl.bootPromptRaw.replace(VAR_RE, (_full, key: string) => {
    switch (key) {
      case "project_path":
        return vars.project_path;
      case "account":
        return vars.account;
      case "additional_scope":
        return additional;
      default:
        // Unreachable in practice — loadFromFolder rejects unknown vars at
        // load time. Defensive throw kept so a stale cached template can't
        // bypass the guard.
        throw new Error(
          `renderBootPrompt("${name}"): unknown variable "{{${key}}}" in boot_prompt.md`,
        );
    }
  });
}
