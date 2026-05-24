// components/evy/tools/policy/load.ts
//
// TOML loader + four-source merger for the subctl policy engine (v2.7.0 / PR 4).
//
// Resolves the policy that applies to a project by walking the priority chain
// defined in `.orchestration/handoff-pack/02-policy-schema.md` §1:
//
//   1 (highest) <project_root>/.subctl/policy.toml
//   2           <project_root>/.subctl/policy.local.toml
//   3           ~/.config/subctl/policy.toml
//   4 (lowest)  <subctl_install>/config/policy/defaults.toml
//
// Plus the named preset resolved from <subctl_install>/config/policy/presets/<name>.toml
// (between levels 2 and 3 in spirit, but the merge treats it as one more lower-
// priority layer). If a project sets `preset = "none"`, the preset chain AND
// the shipped defaults are skipped entirely — the project must declare its full
// policy inline.
//
// Merge semantics (pack 02 §6 + pack 03 §5):
//   - ADDITIVE  : allow.commands, allow_pattern, deny_always.substrings,
//                 deny_always.regex. Lower-priority entries first, higher-
//                 priority entries appended at the end.
//   - REPLACE   : every ecosystem-specific table (npm.allowed_scripts,
//                 pnpm.allowed_scripts, bun.allowed_scripts,
//                 yarn.allowed_scripts, make.allowed_targets,
//                 just.allowed_recipes, python_modules.allowed,
//                 uv.allowed_run_targets, poetry.allowed_run_targets) — the
//                 highest-priority document that sets the table wins and its
//                 list replaces, not extends, the lower lists.
//   - REPLACE   : every scalar (preset, default_mode, test_command, ...).
//
// This file produces a `PolicyDocument` only; it does NOT touch hook config
// (PR 10), does NOT write the snapshot file (PR 7), and does NOT make any
// allow/deny decisions (PR 5). It also does NOT mutate the defang —
// HANDOFF_DIGEST §3.1 D9 keeps that orthogonal.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

import type { GatedMode, PolicyDocument } from "./types";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the subctl install root from this file's location.
 *
 * `import.meta.dir` for this module is
 * `<subctl>/components/evy/tools/policy/`, so four `..` segments take us
 * back to `<subctl>/`. We verify by checking for `config/policy/defaults.toml`
 * existence — if that's missing, throw a clear error rather than silently
 * resolving against the wrong tree.
 *
 * Other components in the master daemon resolve in the same style: see
 * `components/evy/server.ts:90` (`join(COMPONENT_DIR, "..", "..", "VERSION")`)
 * — that's two levels up from `components/evy/`; this file is two levels
 * deeper, so four levels up lands at the same root.
 */
export function resolveSubctlInstall(): string {
  // Allow tests to override via env var so they can point at a fixture tree.
  const override = process.env.SUBCTL_INSTALL_ROOT;
  if (override) return override;

  const here = import.meta.dir;
  const root = resolve(here, "..", "..", "..", "..");
  const sentinel = join(root, "config", "policy", "defaults.toml");
  if (!existsSync(sentinel)) {
    throw new Error(
      `resolveSubctlInstall: expected ${sentinel} to exist (anchored from ${here}). ` +
        `If this file moved, update the relative-segment count.`,
    );
  }
  return root;
}

function userConfigPath(): string {
  // Same convention as `components/evy/server.ts:84-85`.
  const cfg = process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(cfg, "policy.toml");
}

// ---------------------------------------------------------------------------
// TOML I/O
// ---------------------------------------------------------------------------

async function readTomlIfExists(path: string): Promise<Partial<PolicyDocument> | null> {
  if (!existsSync(path)) return null;
  return readTomlOrThrow(path);
}

async function readTomlOrThrow(path: string): Promise<Partial<PolicyDocument>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`policy/load: failed to read ${path}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`policy/load: invalid TOML in ${path}: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`policy/load: ${path} did not parse to an object`);
  }
  // Trust the shape; types_test.ts in PR 2 gives the structural contract.
  // A schema-validated load.ts would belong in PR 9 (`policy validate`).
  return parsed as Partial<PolicyDocument>;
}

// ---------------------------------------------------------------------------
// Source-specific loaders
// ---------------------------------------------------------------------------

/**
 * Read `<project_root>/.subctl/policy.toml` (priority 1) and
 * `<project_root>/.subctl/policy.local.toml` (priority 2), merge them so the
 * committed file wins, and return the merged Partial. Returns null if neither
 * file exists.
 *
 * Per the operator's PR 4 spec: this function exists so callers can ask
 * "what does this project itself declare?" without re-implementing the
 * two-file merge.
 */
export async function loadProjectPolicy(
  project_root: string,
): Promise<Partial<PolicyDocument> | null> {
  const committed = join(project_root, ".subctl", "policy.toml");
  const local = join(project_root, ".subctl", "policy.local.toml");
  const committedDoc = await readTomlIfExists(committed);
  const localDoc = await readTomlIfExists(local);
  if (!committedDoc && !localDoc) return null;
  if (committedDoc && !localDoc) return committedDoc;
  if (!committedDoc && localDoc) return localDoc;
  // Both present → committed (priority 1) wins over local (priority 2).
  return mergePartials(committedDoc!, localDoc!);
}

/**
 * Read `~/.config/subctl/policy.toml` (priority 3). Null if missing.
 */
export async function loadUserPolicy(): Promise<Partial<PolicyDocument> | null> {
  return readTomlIfExists(userConfigPath());
}

/**
 * Read `<subctl_install>/config/policy/defaults.toml` (priority 4). Always
 * returns a `PolicyDocument` (with at minimum a `default_mode` set); throws
 * if the shipped file is missing or malformed since that is a packaging bug.
 */
export async function loadShippedDefaults(): Promise<PolicyDocument> {
  const root = resolveSubctlInstall();
  const path = join(root, "config", "policy", "defaults.toml");
  const doc = await readTomlOrThrow(path);
  // Coerce to full doc shape — defaults.toml always declares mode.gated.
  return {
    ...doc,
    mode: doc.mode ?? {},
  } as PolicyDocument;
}

/**
 * Read a named preset from `<subctl_install>/config/policy/presets/<name>.toml`.
 * Throws if `name === "none"` (caller is expected to handle that branch
 * upstream and skip the preset layer). Throws if the preset file is missing.
 */
export async function loadPreset(name: string): Promise<Partial<PolicyDocument>> {
  if (name === "none") {
    throw new Error(
      'preset "none" means no inheritance — call sites should skip',
    );
  }
  const root = resolveSubctlInstall();
  const path = join(root, "config", "policy", "presets", `${name}.toml`);
  if (!existsSync(path)) {
    throw new Error(`policy/load: preset "${name}" not found at ${path}`);
  }
  return readTomlOrThrow(path);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge a list of policy documents, ordered highest-priority first.
 *
 * - Scalars (preset, default_mode, test_command, etc.) — the first defined
 *   value (highest priority) wins.
 * - Additive arrays (allow.commands, allow_pattern, deny_always.substrings,
 *   deny_always.regex) — concat in priority-reverse so lowest-priority entries
 *   appear first and the highest-priority entries land at the END of the list.
 *   This matches the "project pattern appears last" worked example in pack 02
 *   §6 and the test contract `merge.test.ts` carries.
 * - REPLACE arrays (every ecosystem-specific table: npm/pnpm/bun/yarn/
 *   make/just/python_modules/uv/poetry) — the highest-priority document that
 *   sets the table wins, and its inner list replaces any lower-priority list
 *   verbatim. Per pack 03 §5 — "opting in to a custom script set should be a
 *   clear inventory."
 *
 * Documents may be Partials at any level. The returned document is shaped as
 * a `PolicyDocument` (always has `mode: {}`) but the `__meta` field is NOT
 * set here; that's the loader's job in `loadResolvedPolicy`.
 */
export function mergePolicies(...docs: Partial<PolicyDocument>[]): PolicyDocument {
  // Walk from lowest priority to highest so:
  //   - scalar assignments naturally get overwritten by higher-priority later
  //   - additive arrays concat in the right order (lower first, higher last)
  //   - REPLACE arrays naturally pick the last (= highest) writer
  const lowestFirst = [...docs].reverse();

  const out: PolicyDocument = { mode: {} };

  for (const doc of lowestFirst) {
    if (doc.preset !== undefined) out.preset = doc.preset;
    if (doc.default_mode !== undefined) out.default_mode = doc.default_mode;

    if (doc.mode?.trusted !== undefined) out.mode.trusted = doc.mode.trusted;
    if (doc.mode?.sealed !== undefined) out.mode.sealed = doc.mode.sealed;

    const g = doc.mode?.gated;
    if (g) {
      out.mode.gated = mergeGatedLayer(out.mode.gated, g);
    }
  }

  return out;
}

/**
 * Apply one Gated-mode layer on top of an accumulator. Called in
 * lowest-first order, so `next` always represents a higher-priority document
 * than what's currently in `acc`.
 */
function mergeGatedLayer(
  acc: GatedMode | undefined,
  next: GatedMode,
): GatedMode {
  const merged: GatedMode = { ...(acc ?? {}) };

  // --- additive: allow.commands ---
  if (next.allow?.commands) {
    const prev = merged.allow?.commands ?? [];
    merged.allow = { ...(merged.allow ?? {}), commands: [...prev, ...next.allow.commands] };
  } else if (next.allow) {
    // allow object present but no commands key — preserve other allow.* keys
    // (forward-compat for fields not yet in types.ts).
    merged.allow = { ...(merged.allow ?? {}), ...next.allow };
  }

  // --- additive: allow_pattern ---
  if (next.allow_pattern) {
    merged.allow_pattern = [...(merged.allow_pattern ?? []), ...next.allow_pattern];
  }

  // --- additive: deny_always.substrings + deny_always.regex ---
  if (next.deny_always) {
    const accSubs = merged.deny_always?.substrings ?? [];
    const accRegex = merged.deny_always?.regex ?? [];
    merged.deny_always = {
      ...(merged.deny_always ?? {}),
      ...(next.deny_always.substrings
        ? { substrings: [...accSubs, ...next.deny_always.substrings] }
        : merged.deny_always?.substrings
          ? { substrings: accSubs }
          : {}),
      ...(next.deny_always.regex
        ? { regex: [...accRegex, ...next.deny_always.regex] }
        : merged.deny_always?.regex
          ? { regex: accRegex }
          : {}),
    };
  }

  // --- REPLACE: ecosystem-specific tables (pack 03 §5) ---
  // For each, the higher-priority document's value replaces wholesale.
  if (next.npm !== undefined) merged.npm = next.npm;
  if (next.pnpm !== undefined) merged.pnpm = next.pnpm;
  if (next.bun !== undefined) merged.bun = next.bun;
  if (next.yarn !== undefined) merged.yarn = next.yarn;
  if (next.make !== undefined) merged.make = next.make;
  if (next.just !== undefined) merged.just = next.just;
  if (next.python_modules !== undefined) merged.python_modules = next.python_modules;
  if (next.uv !== undefined) merged.uv = next.uv;
  if (next.poetry !== undefined) merged.poetry = next.poetry;

  return merged;
}

/**
 * Internal helper used by `loadProjectPolicy` to merge committed + local
 * project files. Both are Partials. Output is a Partial (no __meta).
 */
function mergePartials(
  ...docs: Partial<PolicyDocument>[]
): Partial<PolicyDocument> {
  const merged = mergePolicies(...docs);
  // Strip the always-present `mode: {}` if there was nothing in there, so the
  // result reads like a true Partial.
  if (
    merged.mode &&
    merged.mode.trusted === undefined &&
    merged.mode.gated === undefined &&
    merged.mode.sealed === undefined
  ) {
    const { mode: _omit, ...rest } = merged;
    return rest;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Resolution (the public entry point)
// ---------------------------------------------------------------------------

/**
 * Walk the four-source chain + preset, merge per pack 02 §6 + pack 03 §5
 * semantics, attach `__meta`, return the final resolved document.
 *
 * Pipeline:
 *   1. Read project policy (merge of committed + local).
 *   2. Read user policy.
 *   3. Read shipped defaults (always — packaging guarantees they exist).
 *   4. Determine preset name from highest-priority document that sets it
 *      (project > user > defaults). If the winner is "none", skip the preset
 *      layer AND the shipped defaults layer (per the operator's spec for
 *      `project-preset-none.toml`).
 *   5. Load the preset by name, if applicable.
 *   6. Merge with mergePolicies() in priority order [project, user, preset,
 *      defaults], highest first.
 *   7. Compute allowlist sha + attach __meta.
 */
export async function loadResolvedPolicy(project_root: string): Promise<PolicyDocument> {
  const projectDoc = await loadProjectPolicy(project_root);
  const userDoc = await loadUserPolicy();
  const defaultsDoc = await loadShippedDefaults();

  // Determine which preset name applies. Highest priority wins.
  const presetName =
    projectDoc?.preset ??
    userDoc?.preset ??
    defaultsDoc.preset ??
    undefined;

  const skipBaselines = presetName === "none";

  // Build the merge chain, highest priority first.
  const layers: Partial<PolicyDocument>[] = [];
  if (projectDoc) layers.push(projectDoc);
  if (userDoc) layers.push(userDoc);
  if (!skipBaselines) {
    if (presetName && presetName !== "none") {
      // Per pack 02 §6, the preset sits between user config and defaults.
      const presetDoc = await loadPreset(presetName);
      layers.push(presetDoc);
    }
    layers.push(defaultsDoc);
  }

  const merged = mergePolicies(...layers);

  // Strip the literal sentinel "none" from the resolved doc — that's a
  // directive, not a real preset name to surface downstream.
  if (merged.preset === "none") {
    delete merged.preset;
  }

  // Compute audit-trail metadata.
  const sourcePaths = collectSourcePaths(project_root, projectDoc, userDoc, presetName, skipBaselines);
  const allowlistSha = computeAllowlistSha(merged);
  const resolvedAt = new Date().toISOString();

  merged.__meta = { sourcePaths, allowlistSha, resolvedAt };
  return merged;
}

function collectSourcePaths(
  project_root: string,
  projectDoc: Partial<PolicyDocument> | null,
  userDoc: Partial<PolicyDocument> | null,
  presetName: string | undefined,
  skipBaselines: boolean,
): string[] {
  const paths: string[] = [];
  const committed = join(project_root, ".subctl", "policy.toml");
  const local = join(project_root, ".subctl", "policy.local.toml");
  if (existsSync(committed)) paths.push(committed);
  if (existsSync(local)) paths.push(local);
  if (userDoc) paths.push(userConfigPath());
  // suppress unused warning while keeping the param meaningful for future use
  void projectDoc;
  if (!skipBaselines) {
    const root = resolveSubctlInstall();
    if (presetName && presetName !== "none") {
      paths.push(join(root, "config", "policy", "presets", `${presetName}.toml`));
    }
    paths.push(join(root, "config", "policy", "defaults.toml"));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Allowlist SHA
// ---------------------------------------------------------------------------

/**
 * Compute a stable short hash of the resolved policy document for audit logs
 * and snapshot headers. The `__meta` field is intentionally excluded so that
 * the same policy resolved at two different times produces the same sha.
 *
 * Algorithm (pack 09 §3 / pack 02 §8):
 *   canonicalize (sorted keys, recursive) → JSON.stringify → sha256 hex →
 *   first 8 hex chars.
 *
 * Arrays are NOT sorted; their order is semantically meaningful (e.g.
 * `allow_pattern` matches first-hit, additive merge order encodes priority).
 */
export function computeAllowlistSha(doc: PolicyDocument): string {
  const canonical = JSON.stringify(canonicalize(doc));
  const full = createHash("sha256").update(canonical, "utf8").digest("hex");
  return full.slice(0, 8);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      if (k === "__meta") continue;
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

// Re-export types as a convenience so call sites only have one import path.
export type {
  AllowPattern,
  AuditEntry,
  CheckRequest,
  CheckResult,
  GatedMode,
  Mode,
  PolicyDocument,
  SealedMode,
  TrustedMode,
} from "./types";
