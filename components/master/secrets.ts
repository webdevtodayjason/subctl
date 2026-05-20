// components/master/secrets.ts
//
// v2.7.4 — small secrets-on-disk layer.
//
// The master daemon needs a few credentials at runtime: LM Studio API
// token (the immediate driver — LM Studio added a "Require API Token"
// toggle), Brave AI Search, Firecrawl, Linear, Context7. Before this
// module the only path was environment variables threaded through the
// launchd plist — workable for CI / power users, but plist editing is
// friction the operator shouldn't need every time a key rotates.
//
// This module adds a second source: `~/.config/subctl/secrets.json`,
// chmod 600, written atomically. The resolution priority every caller
// uses is:
//
//   1. Process env var (e.g. LMSTUDIO_API_TOKEN) — power users / CI
//      where the operator wants the launchd-managed env to remain the
//      source of truth.
//   2. secrets.json field (e.g. lmstudio_api_token) — dashboard-driven
//      operator workflow.
//   3. Absent — caller behaves as today (e.g. lmstudioAuthHeader()
//      returns {} and pi-ai gets the "not-needed" sentinel).
//
// SECURITY CONTRACT (do NOT relax):
//   - secrets.json values NEVER appear in any HTTP response body or
//     log message produced by THIS module. Callers further up are
//     trusted to honor the same rule; listSecrets() is the only
//     external API that's safe to surface to the dashboard panel.
//   - Every write is chmod 600 and lands via tmp-file + rename so a
//     partial write is impossible.
//   - File is read at most once per 5 seconds (in-memory cache),
//     invalidated on mtime change — keeps callers cheap.
//   - On malformed JSON the module logs a single console.error and
//     returns an empty map; it does NOT throw. A bad secrets.json
//     must not crash the daemon.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
const DEFAULT_SECRETS_PATH = join(DEFAULT_SUBCTL_CONFIG_DIR, "secrets.json");

// The set of known keys. Listing them up front gives `listSecrets()` a
// stable answer when the file is absent or empty — the dashboard panel
// can render "Not set" rows for the operator to fill in. Adding a new
// secret is a one-line append here.
export const SECRET_KEYS = [
  "lmstudio_api_token",
  "brave_api_key",
  "firecrawl_api_key",
  "linear_api_key",
  "context7_api_key",
  "tinyfish_api_key",
  "openrouter_api_key",
  // v2.8.10 — memory substrate migration. Cognee = local HTTP service
  // shared with ArgentOS (knowledge graph + semantic recall). Memori =
  // Tier 3 conversation/event substrate (BYODB sqlite). Both auth tokens
  // here so the operator can rotate via the dashboard secrets panel.
  "cognee_auth_token",
  "memori_api_key",
  // MCP-Expose (#24, wave 1) — bearer token for the in-process MCP server
  // exposed at /mcp/* on the master daemon. When absent, the MCP server
  // boots DISABLED (no auto-generation — secrets are operator-managed).
  // Threaded through to decisions.jsonl provenance as `mcp:<caller_id>`.
  "subctl_mcp_token",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

// Test seam — override the on-disk path. Tests use a per-test tmpdir
// so they can exercise read/write/round-trip without touching the
// operator's real ~/.config/subctl/secrets.json.
let _pathOverride: string | null = null;

function secretsPath(): string {
  return _pathOverride ?? DEFAULT_SECRETS_PATH;
}

export function getSecretsPath(): string {
  return secretsPath();
}

interface CachedSecrets {
  values: Record<string, string | null>;
  mtimeMs: number;
  loadedAt: number;
  path: string;
}

const CACHE_TTL_MS = 5_000;
let _cache: CachedSecrets | null = null;

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readSecretsFromDisk(): Record<string, string | null> {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `[secrets] WARN could not read ${path}: ${(err as Error).message}`,
    );
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(
        `[secrets] WARN secrets.json is not a JSON object — ignoring`,
      );
      return {};
    }
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null) out[k] = null;
      else if (typeof v === "string") out[k] = v;
      // silently drop non-string / non-null values — never crash on
      // unexpected shapes, just ignore them.
    }
    return out;
  } catch (err) {
    console.error(
      `[secrets] WARN secrets.json malformed JSON, treating as empty: ${
        (err as Error).message
      }`,
    );
    return {};
  }
}

function getCached(): Record<string, string | null> {
  const now = Date.now();
  const path = secretsPath();
  const mtime = statMtimeMs(path);
  if (
    _cache &&
    _cache.path === path &&
    now - _cache.loadedAt < CACHE_TTL_MS &&
    _cache.mtimeMs === mtime
  ) {
    return _cache.values;
  }
  const values = readSecretsFromDisk();
  _cache = { values, mtimeMs: mtime, loadedAt: now, path };
  return values;
}

/**
 * Look up a secret by key. Returns the stored value, or null if absent /
 * empty. Caller is responsible for combining with `process.env.*` per
 * the v2.7.4 priority order — this module deliberately does NOT consult
 * the environment so it can be tested in isolation.
 */
export function loadSecret(key: string): string | null {
  const all = getCached();
  const v = all[key];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Atomically write a secret. `value === null` clears the field. The
 * file is created with mode 0600 (read/write for owner only); we
 * re-apply chmod on every write so a misconfigured umask can't widen
 * permissions on a subsequent edit.
 */
export async function setSecret(
  key: string,
  value: string | null,
): Promise<void> {
  const path = secretsPath();
  // Read existing — preserve sibling keys.
  const current = readSecretsFromDisk();
  if (value === null || value === "") {
    delete current[key];
  } else {
    current[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  // Sort keys so the on-disk shape is stable & diffable. The known
  // SECRET_KEYS go first in declaration order; any unknown keys (e.g.
  // a hand-edited future addition) trail alphabetically.
  const ordered: Record<string, string | null> = {};
  for (const k of SECRET_KEYS) {
    if (k in current) ordered[k] = current[k];
  }
  for (const k of Object.keys(current).sort()) {
    if (!(k in ordered)) ordered[k] = current[k];
  }
  writeFileSync(tmpPath, JSON.stringify(ordered, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* non-fatal — write still succeeded */
  }
  renameSync(tmpPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-fatal */
  }
  // Invalidate cache so the next loadSecret() reads the new value.
  _cache = null;
}

export interface SecretStatus {
  key: string;
  /** True iff secrets.json has a non-empty string under this key. */
  isSet: boolean;
  /** True iff the matching env var is set (priority-1 source). */
  envOverride: boolean;
  /** mtime of secrets.json as ISO8601, or null if the file doesn't exist. */
  lastModified: string | null;
}

/**
 * Per-key presence flags — names only, NEVER values. Safe to surface
 * over HTTP. Includes both the secrets.json signal and an env-override
 * signal so the dashboard panel can show the operator both paths and
 * make the v2.7.4 priority chain transparent.
 */
export function listSecrets(): SecretStatus[] {
  const all = getCached();
  const path = secretsPath();
  const exists = existsSync(path);
  let lastModified: string | null = null;
  if (exists) {
    try {
      lastModified = new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      /* leave null */
    }
  }
  return SECRET_KEYS.map((key) => {
    const v = all[key];
    return {
      key,
      isSet: typeof v === "string" && v.length > 0,
      envOverride: !!process.env[envVarFor(key)],
      lastModified,
    };
  });
}

/**
 * Map secrets.json keys to their canonical env-var names. Centralized so
 * `lmstudioAuthHeader()`, `getApiKeyForProvider()`, and the dashboard's
 * `/api/settings/keys` row map all agree.
 */
export function envVarFor(key: string): string {
  switch (key) {
    case "lmstudio_api_token":
      return "LMSTUDIO_API_TOKEN";
    case "brave_api_key":
      return "BRAVE_API_KEY";
    case "firecrawl_api_key":
      return "FIRECRAWL_API_KEY";
    case "linear_api_key":
      return "LINEAR_API_KEY";
    case "context7_api_key":
      return "CONTEXT7_API_KEY";
    case "tinyfish_api_key":
      return "TINYFISH_API_KEY";
    case "openrouter_api_key":
      return "OPENROUTER_API_KEY";
    case "cognee_auth_token":
      return "COGNEE_AUTH_TOKEN";
    case "memori_api_key":
      return "MEMORI_API_KEY";
    default:
      // Best-effort uppercase fallback so a hand-added secret name still
      // resolves predictably (`foo_api_key` → `FOO_API_KEY`).
      return key.toUpperCase();
  }
}

/**
 * The v2.7.4 priority chain: env var beats secrets.json beats absent.
 * Used by lmstudioAuthHeader(), getApiKeyForProvider(), and the tool
 * adapters in tools/web.ts, tools/linear.ts, tools/context7.ts.
 *
 * v2.7.31 (ADR 0012): synchronous shape preserved for back-compat —
 * existing callers expect a non-async lookup so a tool dispatch isn't
 * blocked on a 1Password roundtrip. For full multi-backend resolution
 * (including 1Password), call `resolveSecretChain` from
 * `secrets-backends.ts`. This wrapper consults env + file synchronously
 * and ignores the onepassword backend, matching its v2.7.4 behavior.
 */
export function resolveSecret(key: string): string | null {
  const env = process.env[envVarFor(key)];
  if (env && env.length > 0) return env;
  const v = loadSecret(key);
  // Hide raw op:// refs from sync callers — those are resolved by the
  // multi-backend chain. A caller that gets back "op://Personal/..." as
  // a literal would treat it as the secret value and call APIs with it.
  if (v && v.startsWith("op://")) return null;
  return v;
}

// Test seams.

export function _resetCacheForTesting(): void {
  _cache = null;
}

export function _setPathForTesting(path: string | null): void {
  _pathOverride = path;
  _cache = null;
}
