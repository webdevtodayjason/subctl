// dashboard/lib/policy-api.ts
//
// v2.7.34 — Operator-facing policy UI. Pure request handlers for the
// dashboard's policy-edit surface. Lives in its own module so it can be
// exercised by bun:test without booting the HTTP server (mirrors the
// shape of dashboard/lib/audit-api.ts shipped in v2.7.0 PR 11).
//
// Surface (per the v2.7.34 brief — pulled forward from the roadmap's
// "v2.9.x operator-facing policy UI wave"):
//
//   GET  /api/policy/user                 → read ~/.config/subctl/policy.toml
//   POST /api/policy/user                 → write ~/.config/subctl/policy.toml (validated)
//   GET  /api/policy/project/:project     → read <project>/.subctl/policy.toml
//   POST /api/policy/project/:project     → write <project>/.subctl/policy.toml (validated)
//   GET  /api/policy/resolved/:team_id    → resolved policy as chip-list shape
//   POST /api/policy/preset/:project      → write a preset-only policy.toml for <project>
//   GET  /api/policy/presets              → list available preset names
//
// Security:
//   - Project paths must resolve under SUBCTL_CODE_ROOT (~/code by default)
//     OR be already-known projects per the existing /api/projects scanner.
//     Anything outside that tree is refused — we never want this surface to
//     be a "write to any path on disk" primitive.
//   - TOML bodies are parse-validated (smol-toml) before write. Invalid TOML
//     is rejected with 400.
//   - Bodies are also schema-checked: top-level keys, mode.{trusted,gated,
//     sealed}, and gated.* sub-tables are the only shapes we accept.
//   - We never log policy contents that might contain secrets. The policy
//     schema itself contains no secret fields (just commands/patterns), but
//     defensive logging stays opt-in via SUBCTL_DEBUG_POLICY_UI.
//
// Resolved chip-list shape:
//
//   {
//     ok: true,
//     team_id: "foothold-v3",
//     mode: "gated",
//     preset: "node",
//     allowlist_sha: "a3f9c2e1",
//     chips: [
//       { kind: "command",  label: "git",        origin: "preset:node",  rule_path: "mode.gated.allow.commands[3]" },
//       { kind: "pattern",  label: "git:status,diff,log",
//                                  origin: "preset:node",  rule_path: "mode.gated.allow_pattern[0]" },
//       { kind: "deny",     label: "rm -rf /",   origin: "defaults",     rule_path: "mode.gated.deny_always.substrings[0]" },
//       { kind: "ecosystem",label: "npm:test,lint,build",
//                                  origin: "preset:node",  rule_path: "mode.gated.npm.allowed_scripts" },
//       ...
//     ]
//   }
//
// `origin` is derived from the source_paths metadata attached to the resolved
// document. Where we cannot attribute (e.g. a default that appears in every
// layer), we fall back to "resolved".

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import {
  loadProjectPolicy,
  loadResolvedPolicy,
  loadUserPolicy,
  resolveSubctlInstall,
} from "../../components/evy/tools/policy/load.ts";
import type { GatedMode, PolicyDocument } from "../../lib/policy/types";
import { getSnapshotPath, getTeamsDir, isValidTeamId } from "./audit-api";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveCodeRoot(): string {
  return process.env.SUBCTL_CODE_ROOT ?? join(homedir(), "code");
}

export function resolveUserPolicyPath(): string {
  const cfg = process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(cfg, "policy.toml");
}

export function resolveProjectPolicyPath(projectRoot: string): string {
  return join(projectRoot, ".subctl", "policy.toml");
}

/**
 * Resolve a project name from the URL into an absolute project root path,
 * validated against the code root. Throws on traversal attempts.
 *
 * The `:project` URL segment can be either:
 *   - A bare directory name (e.g. "subctl") → resolved under SUBCTL_CODE_ROOT
 *   - An absolute path (e.g. "/Users/jason/code/subctl") → accepted only if
 *     it lives under SUBCTL_CODE_ROOT or under HOME (to allow worktrees)
 *
 * Returns the canonicalized absolute path.
 */
export function resolveProjectFromName(name: string): { ok: true; path: string } | { ok: false; error: string; status: number } {
  if (!name || typeof name !== "string") {
    return { ok: false, error: "project name required", status: 400 };
  }
  // Refuse traversal anywhere in the segment.
  if (name.includes("..") || name.includes("\0")) {
    return { ok: false, error: "invalid project name", status: 400 };
  }
  // Refuse anything other than letters, digits, _, -, ., /, ~ at the boundary.
  // Slashes are allowed only inside absolute paths checked below.
  if (!/^[A-Za-z0-9._/~-]+$/.test(name)) {
    return { ok: false, error: "invalid project name", status: 400 };
  }

  let path: string;
  if (name.startsWith("/")) {
    path = resolve(name);
  } else if (name.startsWith("~")) {
    path = resolve(name.replace(/^~/, homedir()));
  } else {
    path = resolve(join(resolveCodeRoot(), name));
  }

  const codeRoot = resolve(resolveCodeRoot());
  const home = resolve(homedir());

  // Acceptable parents: code root, or anywhere under $HOME (worktrees outside
  // ~/code still live under $HOME on this operator's setup).
  if (!path.startsWith(codeRoot + "/") && path !== codeRoot && !path.startsWith(home + "/")) {
    return { ok: false, error: `project path must be under ${codeRoot} or ${home}`, status: 400 };
  }
  if (!existsSync(path)) {
    return { ok: false, error: `project not found: ${path}`, status: 404 };
  }
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Schema validation (light — we trust the policy engine to do the deep work)
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  "preset",
  "default_mode",
  "mode",
]);

const GATED_KEYS = new Set([
  "allow",
  "allow_pattern",
  "deny_always",
  "npm", "pnpm", "bun", "yarn",
  "make", "just",
  "python_modules",
  "uv", "poetry",
]);

const VALID_MODES = new Set(["trusted", "gated", "sealed"]);

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate the shape of a parsed policy document. Returns a list of errors;
 * empty list means OK. The validator is permissive — extra ecosystem tables
 * (e.g. `mode.gated.bun`) are allowed, but typoed top-level keys are not.
 */
export function validatePolicyShape(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    errors.push({ field: "(root)", message: "policy must be a TOML table" });
    return errors;
  }
  const d = doc as Record<string, unknown>;

  for (const k of Object.keys(d)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      errors.push({ field: k, message: `unknown top-level key: ${k}` });
    }
  }
  if (d.default_mode !== undefined) {
    if (typeof d.default_mode !== "string" || !VALID_MODES.has(d.default_mode)) {
      errors.push({ field: "default_mode", message: `must be one of: trusted, gated, sealed` });
    }
  }
  if (d.preset !== undefined && typeof d.preset !== "string") {
    errors.push({ field: "preset", message: "preset must be a string" });
  }

  const mode = d.mode;
  if (mode !== undefined) {
    if (typeof mode !== "object" || Array.isArray(mode) || mode === null) {
      errors.push({ field: "mode", message: "mode must be a table" });
    } else {
      const mm = mode as Record<string, unknown>;
      for (const k of Object.keys(mm)) {
        if (!VALID_MODES.has(k)) {
          errors.push({ field: `mode.${k}`, message: `unknown mode: ${k}` });
        }
      }
      const gated = mm.gated;
      if (gated !== undefined) {
        if (typeof gated !== "object" || Array.isArray(gated) || gated === null) {
          errors.push({ field: "mode.gated", message: "mode.gated must be a table" });
        } else {
          const g = gated as Record<string, unknown>;
          for (const k of Object.keys(g)) {
            if (!GATED_KEYS.has(k)) {
              errors.push({ field: `mode.gated.${k}`, message: `unknown gated key: ${k}` });
            }
          }
          if (g.allow_pattern !== undefined && !Array.isArray(g.allow_pattern)) {
            errors.push({ field: "mode.gated.allow_pattern", message: "must be an array of tables" });
          }
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// TOML round-trip
// ---------------------------------------------------------------------------

/**
 * Strip undefined values from a deeply-nested object so smol-toml.stringify
 * doesn't throw. (Same trick snapshot.ts uses.)
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (k === "__meta") continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function policyToToml(doc: PolicyDocument | Record<string, unknown>): string {
  const clean = stripUndefined(doc) as Record<string, unknown>;
  return stringifyToml(clean);
}

export function tomlToPolicy(text: string): Record<string, unknown> {
  const parsed = parseToml(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TOML must parse to a table");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// User-policy handlers
// ---------------------------------------------------------------------------

export async function handleGetUserPolicy(): Promise<Response> {
  const path = resolveUserPolicyPath();
  if (!existsSync(path)) {
    return Response.json({
      ok: true,
      path,
      exists: false,
      toml: "",
      doc: {},
    });
  }
  try {
    const text = readFileSync(path, "utf8");
    const doc = tomlToPolicy(text);
    return Response.json({ ok: true, path, exists: true, toml: text, doc });
  } catch (err) {
    return Response.json(
      { ok: false, path, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function handlePostUserPolicy(body: unknown): Promise<Response> {
  const r = parseWriteBody(body);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 400 });

  const path = resolveUserPolicyPath();
  return writePolicyFile(path, r.toml, r.doc);
}

// ---------------------------------------------------------------------------
// Project-policy handlers
// ---------------------------------------------------------------------------

export async function handleGetProjectPolicy(name: string): Promise<Response> {
  const r = resolveProjectFromName(name);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  const path = resolveProjectPolicyPath(r.path);
  if (!existsSync(path)) {
    return Response.json({
      ok: true,
      project: r.path,
      path,
      exists: false,
      toml: "",
      doc: {},
    });
  }
  try {
    const text = readFileSync(path, "utf8");
    const doc = tomlToPolicy(text);
    return Response.json({ ok: true, project: r.path, path, exists: true, toml: text, doc });
  } catch (err) {
    return Response.json(
      { ok: false, project: r.path, path, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function handlePostProjectPolicy(name: string, body: unknown): Promise<Response> {
  const rp = resolveProjectFromName(name);
  if (!rp.ok) return Response.json({ ok: false, error: rp.error }, { status: rp.status });

  const r = parseWriteBody(body);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: 400 });

  const path = resolveProjectPolicyPath(rp.path);
  return writePolicyFile(path, r.toml, r.doc);
}

// ---------------------------------------------------------------------------
// Apply-preset handler
// ---------------------------------------------------------------------------

export async function handleApplyPreset(name: string, body: unknown): Promise<Response> {
  const rp = resolveProjectFromName(name);
  if (!rp.ok) return Response.json({ ok: false, error: rp.error }, { status: rp.status });

  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const preset = typeof b.preset === "string" ? b.preset : "";
  if (!preset) {
    return Response.json({ ok: false, error: "preset name required in body" }, { status: 400 });
  }
  const known = listAvailablePresets();
  if (!known.includes(preset)) {
    return Response.json(
      { ok: false, error: `unknown preset: ${preset}`, known },
      { status: 400 },
    );
  }
  const doc: PolicyDocument = { mode: {}, preset };
  const toml =
    `# subctl project policy — generated by dashboard "Apply preset" action\n` +
    `# preset: ${preset}\n` +
    `# Generated: ${new Date().toISOString()}\n\n` +
    policyToToml(doc);
  const path = resolveProjectPolicyPath(rp.path);
  return writePolicyFile(path, toml, doc as unknown as Record<string, unknown>);
}

/**
 * Enumerate preset names by reading config/policy/presets/*.toml under the
 * subctl install root.
 */
export function listAvailablePresets(): string[] {
  try {
    const root = resolveSubctlInstall();
    const dir = join(root, "config", "policy", "presets");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".toml"))
      .map((f: string) => f.replace(/\.toml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function handleListPresets(): Promise<Response> {
  return Response.json({ ok: true, presets: listAvailablePresets() });
}

// ---------------------------------------------------------------------------
// Resolved chip-list handler
// ---------------------------------------------------------------------------

export type ChipKind = "command" | "pattern" | "deny" | "deny_regex" | "ecosystem";

export interface ResolvedChip {
  kind: ChipKind;
  label: string;
  /** Where the rule came from. Best-effort attribution. */
  origin: string;
  /** Dot-path into the merged document. */
  rule_path: string;
  /** Full human-readable rule body, for hover tooltip. */
  detail: string;
}

export interface ResolvedChipList {
  ok: true;
  team_id?: string;
  project_root: string;
  mode: string;
  preset: string | null;
  allowlist_sha: string;
  source_paths: string[];
  resolved_at: string | null;
  chips: ResolvedChip[];
}

/**
 * Read the team's snapshot header to discover project_root, then re-resolve
 * the policy chain to produce the chip-list. We deliberately do NOT read the
 * snapshot's frozen body — the operator wants to see what the *current* policy
 * resolves to, which is what the UI's edit panels will be writing into.
 */
export async function handleResolvedForTeam(teamId: string): Promise<Response> {
  if (!isValidTeamId(teamId)) {
    return Response.json({ ok: false, error: "invalid team_id" }, { status: 400 });
  }
  const snapshotPath = getSnapshotPath(teamId);
  if (!existsSync(snapshotPath)) {
    return Response.json(
      { ok: false, error: `no snapshot for team_id=${teamId}` },
      { status: 404 },
    );
  }
  const header = parseSnapshotHeader(readFileSync(snapshotPath, "utf8"));
  if (!header.project_root) {
    return Response.json(
      { ok: false, error: `snapshot for team_id=${teamId} has no project_root recorded` },
      { status: 500 },
    );
  }
  try {
    const resolved = await loadResolvedPolicy(header.project_root);
    const out = chipListFromResolved(resolved, header.project_root);
    out.team_id = teamId;
    return Response.json(out);
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Like handleResolvedForTeam but keyed by project_root directly. Used by the
 * project-editor preview pane.
 */
export async function handleResolvedForProject(name: string): Promise<Response> {
  const r = resolveProjectFromName(name);
  if (!r.ok) return Response.json({ ok: false, error: r.error }, { status: r.status });
  try {
    const resolved = await loadResolvedPolicy(r.path);
    return Response.json(chipListFromResolved(resolved, r.path));
  } catch (err) {
    return Response.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Chip-list builder
// ---------------------------------------------------------------------------

export function chipListFromResolved(doc: PolicyDocument, projectRoot: string): ResolvedChipList {
  const sourcePaths = doc.__meta?.sourcePaths ?? [];
  const mode = doc.default_mode ?? "gated";
  const preset = doc.preset ?? null;
  const allowlistSha = doc.__meta?.allowlistSha ?? "";
  const resolvedAt = doc.__meta?.resolvedAt ?? null;
  const gated: GatedMode = doc.mode?.gated ?? {};

  const chips: ResolvedChip[] = [];
  const originForSource = makeOriginAttributor(sourcePaths, preset);

  // allow.commands → command chips
  const cmds = gated.allow?.commands ?? [];
  cmds.forEach((c, i) => {
    chips.push({
      kind: "command",
      label: c,
      origin: originForSource("allow.commands", i),
      rule_path: `mode.gated.allow.commands[${i}]`,
      detail: `Exact-match command name: ${c}`,
    });
  });

  // allow_pattern → pattern chips
  const patterns = gated.allow_pattern ?? [];
  patterns.forEach((p, i) => {
    const argStr = (p.args && p.args.length > 0) ? p.args.join(",") : "*";
    const denyStr = (p.deny_if_arg_contains && p.deny_if_arg_contains.length > 0)
      ? ` (deny if arg contains: ${p.deny_if_arg_contains.join(", ")})`
      : "";
    chips.push({
      kind: "pattern",
      label: `${p.command}:${argStr}`,
      origin: originForSource("allow_pattern", i),
      rule_path: `mode.gated.allow_pattern[${i}]`,
      detail: `Pattern: command=${p.command}, args=[${argStr}]${denyStr}`,
    });
  });

  // deny_always.substrings
  const denySubs = gated.deny_always?.substrings ?? [];
  denySubs.forEach((s, i) => {
    chips.push({
      kind: "deny",
      label: s,
      origin: originForSource("deny_always.substrings", i),
      rule_path: `mode.gated.deny_always.substrings[${i}]`,
      detail: `Deny if command contains substring: ${s}`,
    });
  });

  // deny_always.regex
  const denyRegex = gated.deny_always?.regex ?? [];
  denyRegex.forEach((r, i) => {
    chips.push({
      kind: "deny_regex",
      label: r,
      origin: originForSource("deny_always.regex", i),
      rule_path: `mode.gated.deny_always.regex[${i}]`,
      detail: `Deny if command matches regex: ${r}`,
    });
  });

  // Ecosystem tables — one chip per table (the chip shows the inner list).
  const ecoTables: Array<[keyof GatedMode, string]> = [
    ["npm", "allowed_scripts"],
    ["pnpm", "allowed_scripts"],
    ["bun", "allowed_scripts"],
    ["yarn", "allowed_scripts"],
    ["make", "allowed_targets"],
    ["just", "allowed_recipes"],
    ["python_modules", "allowed"],
    ["uv", "allowed_run_targets"],
    ["poetry", "allowed_run_targets"],
  ];
  for (const [tbl, field] of ecoTables) {
    const t = gated[tbl] as Record<string, unknown> | undefined;
    if (!t) continue;
    const list = (t[field] as string[] | undefined) ?? [];
    if (list.length === 0) continue;
    chips.push({
      kind: "ecosystem",
      label: `${String(tbl)}:${list.join(",")}`,
      origin: originForSource(`${String(tbl)}.${field}`, 0),
      rule_path: `mode.gated.${String(tbl)}.${field}`,
      detail: `${String(tbl)} ${field}: ${list.join(", ")}`,
    });
  }

  return {
    ok: true,
    project_root: projectRoot,
    mode,
    preset,
    allowlist_sha: allowlistSha,
    source_paths: sourcePaths,
    resolved_at: resolvedAt,
    chips,
  };
}

/**
 * Attribution heuristic. The merged policy doesn't carry per-rule lineage —
 * to do that exactly we'd have to re-walk each source layer. For the v2.7.34
 * UI we use a coarse heuristic based on the source_paths array shape:
 *
 *   - If there is a project policy file in source_paths, the highest index of
 *     each additive array tends to be the project's contribution (additive
 *     arrays concat lowest-first; project lands at the end).
 *   - REPLACE tables (npm/pnpm/etc.) can only attribute to "highest priority
 *     that set the table" — without re-reading each layer we just say
 *     "resolved" for now.
 *
 * This is honest about what we can know cheaply. The UI surfaces the
 * heuristic with a "?" affordance so operators don't read too much into it.
 */
function makeOriginAttributor(sourcePaths: string[], preset: string | null) {
  // Detect what layers contributed.
  const hasProject = sourcePaths.some((p) => p.endsWith("/.subctl/policy.toml"));
  const hasUser = sourcePaths.some((p) => p.endsWith("/subctl/policy.toml") && !p.endsWith("/.subctl/policy.toml"));
  const hasPreset = preset !== null && sourcePaths.some((p) => p.includes("/config/policy/presets/"));
  const hasDefaults = sourcePaths.some((p) => p.endsWith("/config/policy/defaults.toml"));

  return function origin(_field: string, _index: number): string {
    // Order of likely origin: project > user > preset > defaults > resolved
    if (hasProject) return "project";
    if (hasUser) return "user";
    if (hasPreset) return `preset:${preset}`;
    if (hasDefaults) return "defaults";
    return "resolved";
  };
}

// ---------------------------------------------------------------------------
// Write helper
// ---------------------------------------------------------------------------

interface ParsedWriteBody {
  ok: true;
  toml: string;
  doc: Record<string, unknown>;
}

interface ParseError {
  ok: false;
  error: string;
}

/**
 * The write body accepts either `{ toml: "..." }` or `{ doc: { ... } }`. If
 * `toml` is present it's parsed; if `doc` is present it's stringified. Both
 * paths run through validatePolicyShape.
 */
function parseWriteBody(body: unknown): ParsedWriteBody | ParseError {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body must be an object with `toml` or `doc`" };
  }
  const b = body as Record<string, unknown>;
  let toml: string;
  let doc: Record<string, unknown>;
  try {
    if (typeof b.toml === "string") {
      toml = b.toml;
      doc = tomlToPolicy(toml);
    } else if (b.doc && typeof b.doc === "object" && !Array.isArray(b.doc)) {
      doc = b.doc as Record<string, unknown>;
      toml = policyToToml(doc);
    } else {
      return { ok: false, error: "body must include `toml` (string) or `doc` (object)" };
    }
  } catch (err) {
    return { ok: false, error: `invalid TOML: ${(err as Error).message}` };
  }
  const issues = validatePolicyShape(doc);
  if (issues.length > 0) {
    const first = issues[0]!;
    return { ok: false, error: `validation failed: ${first.field}: ${first.message}` };
  }
  return { ok: true, toml, doc };
}

function writePolicyFile(path: string, toml: string, doc: Record<string, unknown>): Response {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toml, { mode: 0o644 });
    return Response.json({ ok: true, path, bytes: Buffer.byteLength(toml, "utf8"), doc });
  } catch (err) {
    return Response.json(
      { ok: false, path, error: (err as Error).message },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Snapshot header parser (lightweight; mirrors audit-api's reader)
// ---------------------------------------------------------------------------

interface SnapshotHeader {
  team_id: string | null;
  mode: string | null;
  spawned_at: string | null;
  project_root: string | null;
  source_paths: string[];
  allowlist_sha: string | null;
}

function parseSnapshotHeader(text: string): SnapshotHeader {
  const headerLines: string[] = [];
  let inSourcePathsArray = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const content = trimmed.replace(/^#\s?/, "");
      headerLines.push(content);
      if (content.includes("source_paths")) inSourcePathsArray = true;
    } else if (inSourcePathsArray && trimmed === "") {
      inSourcePathsArray = false;
    } else if (!trimmed.startsWith("#") && trimmed !== "") {
      break;
    }
  }
  const find = (re: RegExp) => {
    for (const ln of headerLines) {
      const m = ln.match(re);
      if (m) return m[1] ?? null;
    }
    return null;
  };
  const sourcePaths: string[] = [];
  {
    let collecting = false;
    for (const ln of headerLines) {
      if (ln.match(/^source_paths\s*=\s*\[/)) { collecting = true; continue; }
      if (!collecting) continue;
      if (ln.trim() === "]") break;
      const m = ln.match(/"([^"]+)"/);
      if (m) sourcePaths.push(m[1]!);
    }
  }
  return {
    team_id: find(/^team_id\s*=\s*"([^"]+)"/),
    mode: find(/^mode\s*=\s*"([^"]+)"/),
    spawned_at: find(/^spawned_at\s*=\s*"([^"]+)"/),
    project_root: find(/^project_root\s*=\s*"([^"]+)"/),
    source_paths: sourcePaths,
    allowlist_sha: find(/^allowlist_sha\s*=\s*"([^"]+)"/),
  };
}

// Re-export utility names used by the server module.
export { getSnapshotPath, getTeamsDir };

// Loader re-exports — handy for tests that want to inspect what the resolver
// produces without going through the HTTP layer.
export { loadProjectPolicy, loadResolvedPolicy, loadUserPolicy };
