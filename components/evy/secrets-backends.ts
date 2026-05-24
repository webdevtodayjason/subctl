// components/evy/secrets-backends.ts
//
// v2.7.31 — Multi-backend secret resolution chain (ADR 0012).
//
// Subctl's master daemon used to look up secrets via a 2-source chain
// (env var > secrets.json). This module generalizes that into an
// N-backend chain whose default order is:
//
//   env  →  onepassword  →  file
//
// Each backend is consulted in turn; the first non-null hit wins.
// Per-key overrides can rearrange the order or disable backends entirely.
//
// 1Password integration shells out to the `op` CLI (`op read op://...`).
// Without `op` in PATH or `OP_SERVICE_ACCOUNT_TOKEN` in env, the
// onepassword backend silently no-ops — so this module never breaks
// existing deploys.
//
// SECURITY CONTRACT (do NOT relax):
//   - Resolved secret values NEVER appear in any log line, error
//     message, audit record, or HTTP response body produced by this
//     module. Only references, key names, and "found / not found"
//     status are surfaced.
//   - `op` is spawned via Bun.spawn with shell=false to avoid any
//     interpolation surface. The op:// ref is passed as an argv
//     entry, not via a shell string.
//   - The audit log lives at ~/.config/subctl/evy/secrets-audit.jsonl
//     and contains only timestamp + key + ref + cache_hit. Append-only.
//   - 1Password results are cached in process memory for 5 minutes
//     keyed by the op:// reference. Cache is cleared on process restart;
//     POST /secrets/cache/flush will clear it at runtime.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { envVarFor, loadSecret } from "./secrets";

// ── Types ────────────────────────────────────────────────────────────

export type SecretBackend = "env" | "onepassword" | "file";

export interface SecretResolveOpts {
  key: string;
  /** Override the default chain. If omitted, uses the configured default. */
  backends?: SecretBackend[];
  /**
   * If true and no backend produces a value, throws. Default false (returns
   * null). Callers that gracefully degrade should leave this false.
   */
  required?: boolean;
}

export interface SecretResolveResult {
  value: string | null;
  /** Which backend produced the value, or null if nothing was found. */
  foundVia: SecretBackend | null;
}

export const DEFAULT_BACKEND_CHAIN: SecretBackend[] = [
  "env",
  "onepassword",
  "file",
];

// ── Backends-config file ─────────────────────────────────────────────

interface BackendsConfig {
  default_chain: SecretBackend[];
  overrides: Record<string, SecretBackend[]>;
  /**
   * Optional explicit op:// reference per key. If present, the onepassword
   * backend uses this reference. Otherwise it falls back to checking
   * whether the file backend's literal value is itself an op:// reference
   * (the ADR's "two storage forms" model — see ADR 0012).
   */
  onepassword_refs: Record<string, string>;
}

const HOME = homedir();
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const BACKENDS_CONFIG_PATH = join(SUBCTL_CONFIG_DIR, "secrets-backends.json");
const AUDIT_LOG_PATH = join(
  SUBCTL_CONFIG_DIR,
  "master",
  "secrets-audit.jsonl",
);

// Test seam — let tests point at a tmpdir.
let _configPathOverride: string | null = null;
let _auditPathOverride: string | null = null;

export function _setConfigPathForTesting(path: string | null): void {
  _configPathOverride = path;
  _configCache = null;
}

export function _setAuditPathForTesting(path: string | null): void {
  _auditPathOverride = path;
}

function configPath(): string {
  return _configPathOverride ?? BACKENDS_CONFIG_PATH;
}

function auditPath(): string {
  return _auditPathOverride ?? AUDIT_LOG_PATH;
}

interface CachedConfig {
  config: BackendsConfig;
  loadedAt: number;
}

const CONFIG_CACHE_TTL_MS = 5_000;
let _configCache: CachedConfig | null = null;

const EMPTY_CONFIG: BackendsConfig = {
  default_chain: DEFAULT_BACKEND_CHAIN.slice(),
  overrides: {},
  onepassword_refs: {},
};

function isBackend(x: unknown): x is SecretBackend {
  return x === "env" || x === "onepassword" || x === "file";
}

function normalizeChain(arr: unknown): SecretBackend[] | null {
  if (!Array.isArray(arr)) return null;
  const out: SecretBackend[] = [];
  for (const x of arr) {
    if (isBackend(x) && !out.includes(x)) out.push(x);
  }
  return out.length > 0 ? out : null;
}

export function loadBackendsConfig(): BackendsConfig {
  const now = Date.now();
  if (_configCache && now - _configCache.loadedAt < CONFIG_CACHE_TTL_MS) {
    return _configCache.config;
  }
  const path = configPath();
  let parsed: unknown = null;
  if (existsSync(path)) {
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(
        `[secrets-backends] WARN ${path} malformed — using defaults: ${
          (err as Error).message
        }`,
      );
      parsed = null;
    }
  }
  const cfg: BackendsConfig = { ...EMPTY_CONFIG };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    const chain = normalizeChain(p.default_chain);
    if (chain) cfg.default_chain = chain;
    if (p.overrides && typeof p.overrides === "object") {
      const o: Record<string, SecretBackend[]> = {};
      for (const [k, v] of Object.entries(
        p.overrides as Record<string, unknown>,
      )) {
        const cn = normalizeChain(v);
        if (cn) o[k] = cn;
      }
      cfg.overrides = o;
    }
    if (p.onepassword_refs && typeof p.onepassword_refs === "object") {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        p.onepassword_refs as Record<string, unknown>,
      )) {
        if (typeof v === "string" && v.startsWith("op://")) r[k] = v;
      }
      cfg.onepassword_refs = r;
    }
  }
  _configCache = { config: cfg, loadedAt: now };
  return cfg;
}

// ── 1Password CLI integration ────────────────────────────────────────

interface CachedOpResult {
  value: string;
  loadedAt: number;
}

const OP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — ADR-mandated freshness
const _opCache: Map<string, CachedOpResult> = new Map();

export function _resetOpCacheForTesting(): void {
  _opCache.clear();
}

/**
 * Module-level flag forced for tests. When null, defer to runtime probe
 * (op in PATH + OP_SERVICE_ACCOUNT_TOKEN set).
 */
let _opAvailableOverride: boolean | null = null;

export function _setOpAvailableForTesting(v: boolean | null): void {
  _opAvailableOverride = v;
}

/**
 * Heuristic: is the onepassword backend usable on this host?
 *   - OP_SERVICE_ACCOUNT_TOKEN must be present (non-empty)
 *   - `op` binary must resolve via Bun.which / PATH lookup
 * Returns false the moment either signal is missing — onepassword
 * backend then silently falls through.
 */
export function isOnePasswordAvailable(): boolean {
  if (_opAvailableOverride !== null) return _opAvailableOverride;
  const tok = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!tok || tok.length === 0) return false;
  try {
    // Bun.which is available under Bun; fall back to PATH probe for tests.
    const bunGlobal = (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun;
    if (bunGlobal?.which) {
      return !!bunGlobal.which("op");
    }
  } catch {
    /* fall through */
  }
  // Last-resort PATH walk.
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    if (existsSync(join(dir, "op"))) return true;
  }
  return false;
}

/**
 * Hook for tests — replaces the actual `op read` spawn with a stub.
 * Production code always uses the real implementation.
 */
let _opReader: ((ref: string) => Promise<string | null>) | null = null;

export function _setOpReaderForTesting(
  fn: ((ref: string) => Promise<string | null>) | null,
): void {
  _opReader = fn;
}

async function readFromOp(ref: string): Promise<string | null> {
  if (_opReader) return _opReader(ref);
  try {
    // We intentionally avoid `shell: true`. The ref is an argv entry; no
    // shell metacharacters can be interpreted.
    const bunGlobal = (globalThis as { Bun?: { spawn?: typeof Bun.spawn } }).Bun;
    if (!bunGlobal?.spawn) return null;
    const proc = bunGlobal.spawn(["op", "read", ref], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return null;
    const trimmed = stdout.replace(/\n$/, "");
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an op:// reference, honoring the 5-minute in-memory cache.
 * Returns null on any failure (op CLI missing, token missing, ref not
 * found, network error). Never throws.
 */
export async function resolveOpReference(
  ref: string,
): Promise<{ value: string | null; cacheHit: boolean }> {
  if (!ref.startsWith("op://")) return { value: null, cacheHit: false };
  if (!isOnePasswordAvailable()) return { value: null, cacheHit: false };
  const now = Date.now();
  const cached = _opCache.get(ref);
  if (cached && now - cached.loadedAt < OP_CACHE_TTL_MS) {
    return { value: cached.value, cacheHit: true };
  }
  const value = await readFromOp(ref);
  if (value !== null) {
    _opCache.set(ref, { value, loadedAt: now });
  }
  return { value, cacheHit: false };
}

// ── Audit log ────────────────────────────────────────────────────────

function recordAudit(entry: {
  key: string;
  ref: string;
  cacheHit: boolean;
}): void {
  const path = auditPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        key: entry.key,
        ref: entry.ref,
        cache_hit: entry.cacheHit,
      }) + "\n";
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Audit failure must not break secret resolution.
  }
}

// ── Chain resolution ─────────────────────────────────────────────────

/**
 * Lookup the op:// ref this key is mapped to, if any. Two sources:
 *   1. secrets-backends.json `onepassword_refs[key]`
 *   2. secrets.json literal that happens to be an op:// reference
 *      (the "embedded ref" form from ADR 0012)
 */
function opRefForKey(key: string): string | null {
  const cfg = loadBackendsConfig();
  const explicit = cfg.onepassword_refs[key];
  if (explicit) return explicit;
  const fromFile = loadSecret(key);
  if (fromFile && fromFile.startsWith("op://")) return fromFile;
  return null;
}

function backendsForKey(key: string, override?: SecretBackend[]): SecretBackend[] {
  if (override && override.length > 0) return override;
  const cfg = loadBackendsConfig();
  return cfg.overrides[key] ?? cfg.default_chain;
}

async function tryBackend(
  backend: SecretBackend,
  key: string,
): Promise<string | null> {
  if (backend === "env") {
    const env = process.env[envVarFor(key)];
    return env && env.length > 0 ? env : null;
  }
  if (backend === "file") {
    const v = loadSecret(key);
    // Hide op:// refs from the file backend — those belong to onepassword.
    if (v && v.startsWith("op://")) return null;
    return v;
  }
  if (backend === "onepassword") {
    const ref = opRefForKey(key);
    if (!ref) return null;
    const { value, cacheHit } = await resolveOpReference(ref);
    if (value !== null) {
      recordAudit({ key, ref, cacheHit });
    }
    return value;
  }
  return null;
}

/**
 * Resolve a secret through the configured backend chain. The first
 * non-null backend wins. Returns both the value and which backend
 * produced it (useful for telemetry / dashboard "where is this stored").
 *
 * NEVER throws unless `required: true` and nothing was found.
 */
export async function resolveSecretChain(
  opts: SecretResolveOpts,
): Promise<SecretResolveResult> {
  const chain = backendsForKey(opts.key, opts.backends);
  for (const backend of chain) {
    const value = await tryBackend(backend, opts.key);
    if (value !== null && value.length > 0) {
      return { value, foundVia: backend };
    }
  }
  if (opts.required) {
    throw new Error(`secret "${opts.key}" not found in any backend`);
  }
  return { value: null, foundVia: null };
}

// ── Status surfaces (safe to expose over HTTP) ───────────────────────

export interface BackendChainStatus {
  default_chain: SecretBackend[];
  overrides: Record<string, SecretBackend[]>;
  onepassword: {
    cli_available: boolean;
    token_set: boolean;
    cache_size: number;
    cache_ttl_ms: number;
  };
  audit_log_path: string;
}

export function describeBackendChain(): BackendChainStatus {
  const cfg = loadBackendsConfig();
  // Re-derive token-set + cli-available independently so the dashboard
  // can tell the operator exactly which one is missing.
  const tokenSet =
    !!process.env.OP_SERVICE_ACCOUNT_TOKEN &&
    process.env.OP_SERVICE_ACCOUNT_TOKEN.length > 0;
  let cliAvailable = false;
  try {
    const bunGlobal = (globalThis as { Bun?: { which?: (n: string) => string | null } }).Bun;
    if (bunGlobal?.which) {
      cliAvailable = !!bunGlobal.which("op");
    } else {
      const path = process.env.PATH ?? "";
      for (const dir of path.split(":")) {
        if (dir && existsSync(join(dir, "op"))) {
          cliAvailable = true;
          break;
        }
      }
    }
  } catch {
    cliAvailable = false;
  }
  return {
    default_chain: cfg.default_chain,
    overrides: cfg.overrides,
    onepassword: {
      cli_available: cliAvailable,
      token_set: tokenSet,
      cache_size: _opCache.size,
      cache_ttl_ms: OP_CACHE_TTL_MS,
    },
    audit_log_path: auditPath(),
  };
}

export interface SecretTestResult {
  key: string;
  exists: boolean;
  found_via: SecretBackend | null;
}

/**
 * Test resolution for a single key WITHOUT returning the value. Used by
 * the dashboard's "is this key wired up?" tester. Never logs the value;
 * never returns it.
 */
export async function testSecret(key: string): Promise<SecretTestResult> {
  const result = await resolveSecretChain({ key });
  return {
    key,
    exists: result.value !== null,
    found_via: result.foundVia,
  };
}

/**
 * Wipe the 1Password resolution cache. Used by POST /secrets/cache/flush
 * (and by the dashboard's "refresh from 1Password" button).
 */
export function flushOnePasswordCache(): number {
  const n = _opCache.size;
  _opCache.clear();
  return n;
}
