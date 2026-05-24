// components/master/tools/policy/snapshot.ts
//
// Per-team policy snapshot writer + reader. Pack 02 §8 + HANDOFF_DIGEST D7.
//
// At spawn time we resolve the project's policy chain (PR 4's `loadResolvedPolicy`),
// freeze it to TOML, and write it to:
//
//   ~/.local/state/subctl/teams/<team_id>/policy.snapshot.toml
//
// The snapshot is IMMUTABLE post-write (HANDOFF_DIGEST §5 D7 Q2). Downstream
// readers — the PreToolUse hook, the audit emitter, the dashboard — read
// exclusively from this file. The single mutation we permit is moving a prior
// generation to `.snapshot.toml.old` when a team respawns (pack 02 §8: "one
// generation of forensics").
//
// The file format is two layers:
//
//   1. A header comment block carrying out-of-band metadata that wouldn't
//      otherwise survive a stringify(parse(...)) round-trip — team_id,
//      spawned_at, mode, source_paths, allowlist_sha.
//   2. The serialized resolved PolicyDocument body, with its `__meta` stripped
//      (the header captures everything `__meta` carried + more).
//
// Path resolution uses SUBCTL_STATE_DIR exactly the way PR 6's
// `policy_audit_tail` does — env override wins, otherwise `~/.local/state/subctl`.
// The two writers and the reader must agree because the dashboard / hook will
// resolve paths against the same env.

import { existsSync, renameSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { computeAllowlistSha, loadResolvedPolicy } from "./load";
import type { Mode, PolicyDocument } from "./types";

// ---------------------------------------------------------------------------
// Path resolution — same convention as PR 6's policy_audit_tail.ts
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const override = process.env.SUBCTL_STATE_DIR;
  return override ?? join(homedir(), ".local", "state", "subctl");
}

/**
 * Deterministic path to a team's snapshot file. Constructable without I/O so
 * the hook + audit emitter can resolve it cheaply at every check.
 */
export function getSnapshotPath(teamId: string): string {
  return join(resolveStateDir(), "teams", teamId, "policy.snapshot.toml");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SnapshotMetadata {
  teamId: string;
  /**
   * Absolute path to the team's project root. Round-trips through the header
   * so the dashboard's Policy tab can re-resolve the policy chain without
   * stashing it elsewhere. Added in v2.7.9; snapshots written by ≤v2.7.8
   * lack this line and read back as `""` (see `parseHeader`).
   */
  projectRoot: string;
  mode: Mode;
  /** ISO 8601 UTC with millisecond precision. */
  spawnedAt: string;
  /** From the resolved policy's `__meta.sourcePaths`. Listed in priority order. */
  sourcePaths: string[];
  /** First 8 hex chars of sha256(canonical(policy)). Same as `__meta.allowlistSha`. */
  allowlistSha: string;
  /** Absolute path the snapshot was written to. */
  snapshotPath: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Resolve + freeze policy for a team. Idempotent for the same inputs in the
 * sense that the resulting policy body is deterministic; the header timestamp
 * naturally differs per call.
 *
 * Steps (per pack 02 §8 + the PR 7 brief):
 *   1. Resolve policy via PR 4's `loadResolvedPolicy(projectRoot)`.
 *   2. Override `default_mode` with the spawn-time `mode` (the spawn wins per
 *      HANDOFF_DIGEST §5 D3 — command-tier only further restricts/specifies).
 *   3. Recompute allowlist_sha against the override (will only differ from
 *      `__meta.allowlistSha` if mode actually changed default_mode).
 *   4. Serialize policy to TOML — `__meta` and `undefined` keys stripped so
 *      smol-toml.stringify doesn't choke.
 *   5. Prepend the header comment block.
 *   6. If a prior snapshot exists, atomic-rename it to `.snapshot.toml.old`
 *      (keeps one generation of forensics).
 *   7. Write the new file at mode 0644.
 */
export async function writePolicySnapshot(
  teamId: string,
  projectRoot: string,
  mode: Mode,
): Promise<SnapshotMetadata> {
  if (!teamId) throw new Error("writePolicySnapshot: teamId is required");
  if (!projectRoot) throw new Error("writePolicySnapshot: projectRoot is required");
  if (mode !== "trusted" && mode !== "gated" && mode !== "sealed") {
    throw new Error(`writePolicySnapshot: invalid mode "${mode}"`);
  }

  const resolved = await loadResolvedPolicy(projectRoot);

  // Apply the spawn-time mode override. The snapshot's default_mode reflects
  // what this team was *actually* spawned with, not the merged-file preference.
  const overridden: PolicyDocument = {
    ...resolved,
    default_mode: mode,
  };

  const allowlistSha = computeAllowlistSha(overridden);
  const sourcePaths = resolved.__meta?.sourcePaths ?? [];
  const spawnedAt = new Date().toISOString();
  const snapshotPath = getSnapshotPath(teamId);

  const body = stringifyToml(stripForToml(overridden) as Record<string, unknown>);
  const header = buildHeader({
    teamId,
    projectRoot,
    spawnedAt,
    mode,
    sourcePaths,
    allowlistSha,
  });
  const fileContents = `${header}\n${body}`;

  // Ensure the team's state dir exists.
  await mkdir(join(resolveStateDir(), "teams", teamId), { recursive: true, mode: 0o755 });

  // Rotate prior snapshot if present. Use renameSync — it's atomic on POSIX
  // and we don't want to race a partially-renamed state between an unlink and
  // a rename, which is what a fs.unlink + writeFile sequence would risk.
  if (existsSync(snapshotPath)) {
    renameSync(snapshotPath, `${snapshotPath}.old`);
  }

  await writeFile(snapshotPath, fileContents, { encoding: "utf8", mode: 0o644 });
  // writeFile honors mode only on create; chmod the existing file too to be
  // safe in the case where it was created via a different path.
  await chmod(snapshotPath, 0o644);

  return {
    teamId,
    projectRoot,
    mode,
    spawnedAt,
    sourcePaths,
    allowlistSha,
    snapshotPath,
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Parse a snapshot file (both header + body). Returns null if the file does
 * not exist. Throws if the file exists but is malformed (we'd rather hard-
 * fail an explicit read than silently return partial state).
 */
export async function readPolicySnapshot(
  teamId: string,
): Promise<{ policy: PolicyDocument; meta: SnapshotMetadata } | null> {
  const snapshotPath = getSnapshotPath(teamId);
  if (!existsSync(snapshotPath)) return null;

  const text = await readFile(snapshotPath, "utf8");
  const { headerLines, bodyText } = splitHeader(text);
  const headerMeta = parseHeader(headerLines, snapshotPath);

  let policy: PolicyDocument;
  try {
    const parsed = parseToml(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body did not parse to an object");
    }
    policy = parsed as PolicyDocument;
    if (!policy.mode) policy.mode = {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`readPolicySnapshot: failed to parse body of ${snapshotPath}: ${msg}`);
  }

  return {
    policy,
    meta: { ...headerMeta, snapshotPath },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * smol-toml.stringify chokes on `undefined` values and on the `__meta` field
 * (a) because TOML has no null/undefined and (b) because we deliberately keep
 * `__meta` out of the body — the header carries it. This recursive cleaner
 * strips both. Arrays of primitives pass through; nested objects are
 * recursed; pure-empty objects (after cleaning) are also stripped.
 */
function stripForToml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(stripForToml)
      .filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "__meta") continue;
      if (v === undefined) continue;
      const cleaned = stripForToml(v);
      if (cleaned === undefined) continue;
      // Strip pure-empty objects so TOML doesn't emit `[empty.table]` headers.
      if (
        cleaned !== null &&
        typeof cleaned === "object" &&
        !Array.isArray(cleaned) &&
        Object.keys(cleaned as Record<string, unknown>).length === 0
      ) {
        continue;
      }
      out[k] = cleaned;
    }
    return out;
  }
  return value;
}

interface HeaderMetaInput {
  teamId: string;
  projectRoot: string;
  spawnedAt: string;
  mode: Mode;
  sourcePaths: string[];
  allowlistSha: string;
}

/**
 * Build the comment-prefixed header block. The first line is the literal
 * banner; subsequent lines are `# key = value` TOML-ish so a reader can strip
 * the `# ` prefix and parse the rest as TOML.
 */
function buildHeader(meta: HeaderMetaInput): string {
  const lines = [
    `# subctl policy snapshot`,
    `# team_id = ${JSON.stringify(meta.teamId)}`,
    `# project_root = ${JSON.stringify(meta.projectRoot)}`,
    `# spawned_at = ${JSON.stringify(meta.spawnedAt)}`,
    `# mode = ${JSON.stringify(meta.mode)}`,
  ];
  if (meta.sourcePaths.length === 0) {
    lines.push(`# source_paths = []`);
  } else {
    lines.push(`# source_paths = [`);
    for (const p of meta.sourcePaths) {
      lines.push(`#   ${JSON.stringify(p)},`);
    }
    lines.push(`# ]`);
  }
  lines.push(`# allowlist_sha = ${JSON.stringify(meta.allowlistSha)}`);
  return lines.join("\n");
}

interface SplitResult {
  headerLines: string[];
  bodyText: string;
}

/**
 * Walk from the top of the file collecting consecutive comment lines until
 * the first non-comment, non-empty line. The header is contiguous and at the
 * top — we don't try to parse comments scattered through the body.
 */
function splitHeader(text: string): SplitResult {
  const lines = text.split(/\r?\n/);
  const headerLines: string[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const trimmed = ln.trim();
    if (trimmed.startsWith("#")) {
      headerLines.push(ln);
      bodyStart = i + 1;
      continue;
    }
    if (trimmed === "" && headerLines.length > 0 && headerLines.length < 50) {
      // Allow a single blank separator between header and body without
      // bailing out of the header pass.
      bodyStart = i + 1;
      continue;
    }
    break;
  }
  return { headerLines, bodyText: lines.slice(bodyStart).join("\n") };
}

/**
 * Convert the comment-prefixed header into a TOML doc, then validate that the
 * required fields are present and well-typed.
 *
 * Strategy: strip the leading `# ` (or `#`) from each line, drop the banner
 * "subctl policy snapshot" line, and pass the rest through smol-toml's parser.
 * That gets us `source_paths` array parsing for free.
 */
function parseHeader(headerLines: string[], path: string): Omit<SnapshotMetadata, "snapshotPath"> {
  const stripped: string[] = [];
  for (const line of headerLines) {
    // remove one leading "#" then one optional space
    const m = line.match(/^\s*#\s?(.*)$/);
    if (!m) continue;
    const content = m[1];
    // Skip banners — any line that isn't a key=value or a continuation
    // bracket "]" / "[" / "  \"path\","
    if (content.trim() === "subctl policy snapshot") continue;
    stripped.push(content);
  }
  const headerToml = stripped.join("\n");

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(headerToml) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`readPolicySnapshot: malformed header in ${path}: ${msg}`);
  }

  const teamId = expectString(parsed.team_id, "team_id", path);
  const spawnedAt = expectString(parsed.spawned_at, "spawned_at", path);
  const mode = expectString(parsed.mode, "mode", path);
  if (mode !== "trusted" && mode !== "gated" && mode !== "sealed") {
    throw new Error(`readPolicySnapshot: bad mode "${mode}" in ${path}`);
  }
  const allowlistSha = expectString(parsed.allowlist_sha, "allowlist_sha", path);
  const sourcePaths = expectStringArray(parsed.source_paths, "source_paths", path);

  // v2.7.9: project_root added so the dashboard's Policy tab can re-resolve
  // policy without an out-of-band stash. Snapshots written by ≤v2.7.8 don't
  // have this line — fall back to empty string and log a deprecation note
  // (don't throw; back-compat is the entire point of this branch).
  let projectRoot = "";
  if (typeof parsed.project_root === "string") {
    projectRoot = parsed.project_root;
  } else if (parsed.project_root !== undefined) {
    throw new Error(`readPolicySnapshot: header field "project_root" present but not a string in ${path}`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `readPolicySnapshot: ${path} predates v2.7.9 (no project_root in header). ` +
      `Returning projectRoot:"" — dashboard policy re-resolve will be skipped for this team. ` +
      `Respawn the team to refresh the snapshot.`,
    );
  }

  return {
    teamId,
    projectRoot,
    spawnedAt,
    mode: mode as Mode,
    sourcePaths,
    allowlistSha,
  };
}

function expectString(v: unknown, field: string, path: string): string {
  if (typeof v !== "string") {
    throw new Error(`readPolicySnapshot: header field "${field}" missing or not a string in ${path}`);
  }
  return v;
}

function expectStringArray(v: unknown, field: string, path: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`readPolicySnapshot: header field "${field}" missing or not an array in ${path}`);
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new Error(`readPolicySnapshot: header field "${field}" has non-string entry in ${path}`);
    }
  }
  return v as string[];
}
