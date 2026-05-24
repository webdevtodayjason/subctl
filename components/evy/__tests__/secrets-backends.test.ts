// components/evy/__tests__/secrets-backends.test.ts
//
// v2.7.31 — multi-backend secret resolution chain (ADR 0012).
//
// Coverage:
//   - Default chain order (env → onepassword → file)
//   - Per-key override config
//   - 1Password backend silently no-ops when CLI/token are missing
//   - 1Password resolution caches for 5 minutes
//   - File backend hides op:// references (they're onepassword's domain)
//   - Audit log writes one JSONL line per successful op resolution
//   - testSecret never returns the value
//   - Cache flush clears every entry
//   - Malformed secrets-backends.json doesn't crash; defaults apply

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setConfigPathForTesting,
  _setAuditPathForTesting,
  _setOpAvailableForTesting,
  _setOpReaderForTesting,
  _resetOpCacheForTesting,
  describeBackendChain,
  flushOnePasswordCache,
  loadBackendsConfig,
  resolveSecretChain,
  testSecret,
} from "../secrets-backends";
import { _setPathForTesting, _resetCacheForTesting } from "../secrets";

let workDir: string;
let secretsPath: string;
let backendsPath: string;
let auditPath: string;

// Snapshot env so per-test env mutations don't leak.
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
  "LINEAR_API_KEY",
  "LMSTUDIO_API_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  workDir = mkdtempSync(join(tmpdir(), "subctl-secrets-backends-"));
  secretsPath = join(workDir, "secrets.json");
  backendsPath = join(workDir, "secrets-backends.json");
  auditPath = join(workDir, "evy", "secrets-audit.jsonl");
  _setPathForTesting(secretsPath);
  _setConfigPathForTesting(backendsPath);
  _setAuditPathForTesting(auditPath);
  _setOpAvailableForTesting(null);
  _setOpReaderForTesting(null);
  _resetOpCacheForTesting();
  _resetCacheForTesting();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _setPathForTesting(null);
  _setConfigPathForTesting(null);
  _setAuditPathForTesting(null);
  _setOpAvailableForTesting(null);
  _setOpReaderForTesting(null);
  _resetOpCacheForTesting();
  _resetCacheForTesting();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeBackendsConfig(cfg: object): void {
  writeFileSync(backendsPath, JSON.stringify(cfg, null, 2));
}

function writeSecretsFile(obj: object): void {
  writeFileSync(secretsPath, JSON.stringify(obj, null, 2));
}

// ── default chain ────────────────────────────────────────────────────

describe("default backend chain", () => {
  test("env wins over file when both set", async () => {
    process.env.LINEAR_API_KEY = "from-env";
    writeSecretsFile({ linear_api_key: "from-file" });
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBe("from-env");
    expect(r.foundVia).toBe("env");
  });

  test("falls through to file when env unset and onepassword inactive", async () => {
    _setOpAvailableForTesting(false);
    writeSecretsFile({ linear_api_key: "from-file" });
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBe("from-file");
    expect(r.foundVia).toBe("file");
  });

  test("returns null and foundVia=null when no backend has the key", async () => {
    _setOpAvailableForTesting(false);
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBeNull();
    expect(r.foundVia).toBeNull();
  });

  test("required:true throws on missing key", async () => {
    _setOpAvailableForTesting(false);
    await expect(
      resolveSecretChain({ key: "anthropic_api_key", required: true }),
    ).rejects.toThrow(/not found in any backend/);
  });
});

// ── per-key override ─────────────────────────────────────────────────

describe("per-key override", () => {
  test("override pins a different order", async () => {
    process.env.LINEAR_API_KEY = "from-env";
    writeSecretsFile({ linear_api_key: "from-file" });
    writeBackendsConfig({
      default_chain: ["env", "onepassword", "file"],
      overrides: { linear_api_key: ["file", "env"] },
      onepassword_refs: {},
    });
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBe("from-file");
    expect(r.foundVia).toBe("file");
  });

  test("explicit backends arg supersedes config override", async () => {
    process.env.LINEAR_API_KEY = "from-env";
    writeSecretsFile({ linear_api_key: "from-file" });
    writeBackendsConfig({
      default_chain: ["env", "onepassword", "file"],
      overrides: { linear_api_key: ["file"] },
      onepassword_refs: {},
    });
    const r = await resolveSecretChain({
      key: "linear_api_key",
      backends: ["env"],
    });
    expect(r.value).toBe("from-env");
    expect(r.foundVia).toBe("env");
  });
});

// ── 1Password backend ────────────────────────────────────────────────

describe("onepassword backend", () => {
  test("silently no-ops when op CLI unavailable", async () => {
    _setOpAvailableForTesting(false);
    writeBackendsConfig({
      default_chain: ["onepassword", "file"],
      overrides: {},
      onepassword_refs: { linear_api_key: "op://Personal/Linear/api" },
    });
    writeSecretsFile({ linear_api_key: "from-file" });
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBe("from-file");
    expect(r.foundVia).toBe("file");
  });

  test("returns op-resolved value when available + caches subsequent reads", async () => {
    _setOpAvailableForTesting(true);
    let opCalls = 0;
    _setOpReaderForTesting(async (ref: string) => {
      opCalls += 1;
      expect(ref).toBe("op://Personal/Linear/api");
      return "lin_op_secret_xxx";
    });
    writeBackendsConfig({
      default_chain: ["onepassword", "file"],
      overrides: {},
      onepassword_refs: { linear_api_key: "op://Personal/Linear/api" },
    });
    const r1 = await resolveSecretChain({ key: "linear_api_key" });
    expect(r1.value).toBe("lin_op_secret_xxx");
    expect(r1.foundVia).toBe("onepassword");
    expect(opCalls).toBe(1);
    // Second call must hit cache, not the reader.
    const r2 = await resolveSecretChain({ key: "linear_api_key" });
    expect(r2.value).toBe("lin_op_secret_xxx");
    expect(opCalls).toBe(1);
  });

  test("op:// reference stored as literal in secrets.json is also resolved", async () => {
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async (ref: string) => {
      expect(ref).toBe("op://Personal/Brave/key");
      return "brv-secret-abc";
    });
    writeSecretsFile({ brave_api_key: "op://Personal/Brave/key" });
    const r = await resolveSecretChain({ key: "brave_api_key" });
    expect(r.value).toBe("brv-secret-abc");
    expect(r.foundVia).toBe("onepassword");
  });

  test("audit log appends one JSONL line per successful op resolution", async () => {
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async () => "lin_op_secret_xxx");
    writeBackendsConfig({
      default_chain: ["onepassword", "file"],
      overrides: {},
      onepassword_refs: { linear_api_key: "op://Personal/Linear/api" },
    });
    await resolveSecretChain({ key: "linear_api_key" });
    expect(existsSync(auditPath)).toBe(true);
    const raw = readFileSync(auditPath, "utf8");
    expect(raw.split("\n").filter(Boolean).length).toBe(1);
    const entry = JSON.parse(raw.trim());
    expect(entry.key).toBe("linear_api_key");
    expect(entry.ref).toBe("op://Personal/Linear/api");
    expect(entry.cache_hit).toBe(false);
    // CRITICAL: value MUST NOT appear in the audit line.
    expect(raw).not.toContain("lin_op_secret_xxx");
  });

  test("cache hit emits a cache_hit:true audit entry", async () => {
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async () => "v");
    writeBackendsConfig({
      default_chain: ["onepassword"],
      overrides: {},
      onepassword_refs: { x: "op://a/b/c" },
    });
    await resolveSecretChain({ key: "x" });
    await resolveSecretChain({ key: "x" });
    const lines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).cache_hit).toBe(false);
    expect(JSON.parse(lines[1]!).cache_hit).toBe(true);
  });

  test("reader returning null leaves cache untouched, falls through to next backend", async () => {
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async () => null);
    writeBackendsConfig({
      default_chain: ["onepassword", "file"],
      overrides: {},
      onepassword_refs: { linear_api_key: "op://does/not/exist" },
    });
    writeSecretsFile({ linear_api_key: "fallback-from-file" });
    const r = await resolveSecretChain({ key: "linear_api_key" });
    expect(r.value).toBe("fallback-from-file");
    expect(r.foundVia).toBe("file");
  });
});

// ── file backend hides op:// refs ───────────────────────────────────

describe("file backend op:// hygiene", () => {
  test("file backend does NOT return a literal op:// value as the secret", async () => {
    _setOpAvailableForTesting(false);
    writeSecretsFile({ linear_api_key: "op://Personal/Linear/api" });
    const r = await resolveSecretChain({
      key: "linear_api_key",
      backends: ["file"],
    });
    // op:// refs are onepassword's domain; file backend must skip them
    // so a caller never sees an op:// URI as if it were the secret value.
    expect(r.value).toBeNull();
  });
});

// ── flush + describe + test surfaces ────────────────────────────────

describe("status surfaces", () => {
  test("describeBackendChain reflects config + cache state", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_tok";
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async () => "v");
    writeBackendsConfig({
      default_chain: ["env", "file"],
      overrides: { brave_api_key: ["onepassword", "file"] },
      onepassword_refs: { brave_api_key: "op://X/Y/Z" },
    });
    await resolveSecretChain({ key: "brave_api_key" });
    const s = describeBackendChain();
    expect(s.default_chain).toEqual(["env", "file"]);
    expect(s.overrides.brave_api_key).toEqual(["onepassword", "file"]);
    expect(s.onepassword.token_set).toBe(true);
    expect(s.onepassword.cli_available).toBe(true);
    expect(s.onepassword.cache_size).toBe(1);
  });

  test("flushOnePasswordCache wipes every entry and returns the count", async () => {
    _setOpAvailableForTesting(true);
    _setOpReaderForTesting(async () => "v");
    writeBackendsConfig({
      default_chain: ["onepassword"],
      overrides: {},
      onepassword_refs: { a: "op://A/A/A", b: "op://B/B/B" },
    });
    await resolveSecretChain({ key: "a" });
    await resolveSecretChain({ key: "b" });
    expect(describeBackendChain().onepassword.cache_size).toBe(2);
    expect(flushOnePasswordCache()).toBe(2);
    expect(describeBackendChain().onepassword.cache_size).toBe(0);
  });

  test("testSecret returns exists + found_via, never the value", async () => {
    process.env.LINEAR_API_KEY = "secret-value";
    const r = await testSecret("linear_api_key");
    expect(r.exists).toBe(true);
    expect(r.found_via).toBe("env");
    // Shape MUST NOT include a `value` field; type-level guarantee.
    expect(Object.keys(r).sort()).toEqual(["exists", "found_via", "key"]);
  });

  test("testSecret reports exists:false on missing key", async () => {
    _setOpAvailableForTesting(false);
    const r = await testSecret("anthropic_api_key");
    expect(r.exists).toBe(false);
    expect(r.found_via).toBeNull();
  });
});

// ── config robustness ────────────────────────────────────────────────

describe("config robustness", () => {
  test("missing config file → defaults apply", () => {
    const cfg = loadBackendsConfig();
    expect(cfg.default_chain).toEqual(["env", "onepassword", "file"]);
    expect(cfg.overrides).toEqual({});
    expect(cfg.onepassword_refs).toEqual({});
  });

  test("malformed JSON → defaults apply, daemon does not crash", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(backendsPath, "{ not valid json");
    const cfg = loadBackendsConfig();
    expect(cfg.default_chain).toEqual(["env", "onepassword", "file"]);
  });

  test("unknown backend names are filtered out of default_chain", () => {
    writeBackendsConfig({
      default_chain: ["env", "magic", "file"],
      overrides: {},
      onepassword_refs: {},
    });
    const cfg = loadBackendsConfig();
    expect(cfg.default_chain).toEqual(["env", "file"]);
  });
});
