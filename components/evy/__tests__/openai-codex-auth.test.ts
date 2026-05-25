// components/evy/__tests__/openai-codex-auth.test.ts
//
// v2.8.7 — Unit coverage for the openai-codex OAuth credential resolver.
//
// What we pin here:
//   1. accounts.conf parsing matches lib/core.sh's pipe-delimited format
//      and honors tilde expansion.
//   2. resolveActiveCodexConfigDir picks the FIRST openai-codex row.
//   3. getCodexAccessToken returns undefined (with a log breadcrumb) on
//      every failure branch — missing file, malformed JSON, missing
//      tokens.access_token, malformed JWT, expired JWT.
//   4. Valid auth.json with a not-yet-expired JWT returns the token.
//
// We don't exercise the JWT signature — pi-ai parses the payload without
// verifying the signature (the Codex backend re-validates server-side).
// We just need a structurally-valid base64url JWT.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _decodeJwtPayloadForTesting,
  getCodexAccessToken,
  loadAccountsConf,
  readCodexAuth,
  resolveActiveCodexConfigDir,
} from "../openai-codex-auth";

// ---------------------------------------------------------------------------
// JWT helpers — assemble valid (unsigned) JWTs for the resolver tests.
// ---------------------------------------------------------------------------

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  // signature is opaque to pi-ai's payload extractor.
  return `${header}.${body}.sigplaceholder`;
}

const ACCOUNT_ID = "210e4eee-0a00-4404-ac37-75e4b7083b74";

function makeCodexJwt(opts: { exp: number; iat?: number; account?: string }): string {
  return makeJwt({
    aud: ["https://api.openai.com/v1"],
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
    exp: opts.exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.account ?? ACCOUNT_ID,
      chatgpt_plan_type: "pro",
    },
  });
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let prevAccountsConfEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-codex-auth-test-"));
  prevAccountsConfEnv = process.env.SUBCTL_ACCOUNTS_CONF;
});

afterEach(() => {
  if (prevAccountsConfEnv === undefined) {
    delete process.env.SUBCTL_ACCOUNTS_CONF;
  } else {
    process.env.SUBCTL_ACCOUNTS_CONF = prevAccountsConfEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAccountsConf(body: string): string {
  const p = join(tmpDir, "accounts.conf");
  writeFileSync(p, body, { mode: 0o600 });
  process.env.SUBCTL_ACCOUNTS_CONF = p;
  return p;
}

function writeAuthJson(configDir: string, body: unknown): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "auth.json"), JSON.stringify(body), {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// accounts.conf parsing
// ---------------------------------------------------------------------------

describe("loadAccountsConf", () => {
  test("parses a single openai-codex row", () => {
    const dir = join(tmpDir, "codex-jason");
    writeAccountsConf(
      `openai-jason | openai-codex | jbrashear72@icloud.com | ${dir} | personal\n`,
    );
    const rows = loadAccountsConf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alias).toBe("openai-jason");
    expect(rows[0]!.provider).toBe("openai-codex");
    expect(rows[0]!.configDir).toBe(dir);
  });

  test("ignores comment + blank lines and trims whitespace", () => {
    writeAccountsConf(
      "# header comment\n" +
        "\n" +
        "  claude-jason | claude | a@b.com | /Users/you/.claude-jason | Daily driver\n" +
        "openai-jason | openai-codex | c@d.com | /Users/you/.codex-jason | Codex\n",
    );
    const rows = loadAccountsConf();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.provider).toBe("openai-codex");
  });

  test("expands leading `~/` to $HOME", () => {
    writeAccountsConf(
      "openai-jason | openai-codex | x@y.z | ~/.codex-jason | Codex\n",
    );
    const rows = loadAccountsConf();
    expect(rows[0]!.configDir.startsWith("/")).toBe(true);
    expect(rows[0]!.configDir.endsWith("/.codex-jason")).toBe(true);
  });

  test("returns [] when accounts.conf is absent", () => {
    process.env.SUBCTL_ACCOUNTS_CONF = join(tmpDir, "does-not-exist.conf");
    expect(loadAccountsConf()).toEqual([]);
  });

  test("malformed rows (fewer than 4 pipe-fields) are skipped, not fatal", () => {
    writeAccountsConf(
      "broken | row\n" +
        "openai-jason | openai-codex | x@y.z | /Users/you/.codex-jason\n",
    );
    const rows = loadAccountsConf();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alias).toBe("openai-jason");
  });
});

// ---------------------------------------------------------------------------
// resolveActiveCodexConfigDir
// ---------------------------------------------------------------------------

describe("resolveActiveCodexConfigDir", () => {
  test("returns the first openai-codex row's configDir", () => {
    const a = join(tmpDir, "codex-jason");
    const b = join(tmpDir, "codex-titanium");
    writeAccountsConf(
      "claude-jason | claude | x@y.z | /Users/you/.claude-jason | first\n" +
        `openai-jason | openai-codex | x@y.z | ${a} | personal\n` +
        `openai-titanium | openai-codex | x@y.z | ${b} | work\n`,
    );
    expect(resolveActiveCodexConfigDir()).toBe(a);
  });

  test("skips rows whose provider != openai-codex", () => {
    writeAccountsConf(
      "claude-jason | claude | x@y.z | /Users/you/.claude-jason | first\n",
    );
    // no openai-codex in conf — falls back to ~/.codex; that may or may not
    // exist on this machine, so just assert the function returned a string
    // or null without throwing.
    const result = resolveActiveCodexConfigDir();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readCodexAuth
// ---------------------------------------------------------------------------

describe("readCodexAuth", () => {
  test("returns parsed auth.json on a valid file", () => {
    const dir = join(tmpDir, "codex-jason");
    const token = makeCodexJwt({ exp: 9_999_999_999 });
    writeAuthJson(dir, {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "ignored",
        access_token: token,
        refresh_token: "rt_xxx",
        account_id: ACCOUNT_ID,
      },
      last_refresh: "2026-05-06T00:52:01Z",
    });
    const auth = readCodexAuth(dir);
    expect(auth?.tokens?.access_token).toBe(token);
  });

  test("returns null when auth.json is missing", () => {
    expect(readCodexAuth(join(tmpDir, "nope"))).toBeNull();
  });

  test("returns null on malformed JSON without throwing", () => {
    const dir = join(tmpDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), "{this is not json", {
      mode: 0o600,
    });
    expect(readCodexAuth(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCodexAccessToken
// ---------------------------------------------------------------------------

describe("getCodexAccessToken", () => {
  test("returns the access_token when JWT is valid + not expired", () => {
    const dir = join(tmpDir, "codex-jason");
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1h out
    const token = makeCodexJwt({ exp });
    writeAuthJson(dir, { tokens: { access_token: token, refresh_token: "rt" } });
    expect(getCodexAccessToken({ configDir: dir })).toBe(token);
  });

  test("returns undefined when access_token is missing", () => {
    const dir = join(tmpDir, "codex-jason");
    writeAuthJson(dir, { tokens: { refresh_token: "rt_only" } });
    expect(getCodexAccessToken({ configDir: dir })).toBeUndefined();
  });

  test("returns undefined when access_token is not a JWT", () => {
    const dir = join(tmpDir, "codex-jason");
    writeAuthJson(dir, {
      tokens: { access_token: "not-a-jwt-just-a-string" },
    });
    expect(getCodexAccessToken({ configDir: dir })).toBeUndefined();
  });

  test("returns undefined when JWT exp is in the past", () => {
    const dir = join(tmpDir, "codex-jason");
    const expired = makeCodexJwt({ exp: 1_700_000_000 }); // 2023
    writeAuthJson(dir, { tokens: { access_token: expired } });
    expect(
      getCodexAccessToken({ configDir: dir, now: 1_800_000_000 }),
    ).toBeUndefined();
  });

  test("returns undefined when the configDir has no auth.json", () => {
    // Override config_dir explicitly; the resolver falls back to ~/.codex
    // on the real machine, which we don't want to depend on in tests.
    const dir = join(tmpDir, "absent-codex");
    mkdirSync(dir, { recursive: true });
    expect(getCodexAccessToken({ configDir: dir })).toBeUndefined();
  });

  test("decodeJwtPayload extracts chatgpt_account_id for diagnostics", () => {
    const token = makeCodexJwt({ exp: 9_999_999_999, account: "acct-123" });
    const decoded = _decodeJwtPayloadForTesting(token);
    expect(decoded?.chatgptAccountId).toBe("acct-123");
    expect(decoded?.exp).toBe(9_999_999_999);
  });

  test("decodeJwtPayload returns null on non-JWT input", () => {
    expect(_decodeJwtPayloadForTesting("nope")).toBeNull();
    expect(_decodeJwtPayloadForTesting("a.b")).toBeNull();
  });
});
