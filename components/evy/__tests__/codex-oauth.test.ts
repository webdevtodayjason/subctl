// components/evy/__tests__/codex-oauth.test.ts
//
// v2.8.9 — Pure-function coverage for the OpenAI Codex OAuth module.
// Network-dependent paths (loginCodexDeviceCode, refreshCodexTokens,
// completeCodexLogin) are NOT exercised here — they require a real
// auth.openai.com round-trip and would burn live device-code slots
// per test run. We cover the pieces that have deterministic outputs:
//
//   1. buildAuthHeaders shape — Content-Type, originator=subctl, UA, version
//   2. atomicWriteAuthFile — file exists at 0o600 after write
//   3. atomicWriteAuthFile — content round-trips
//   4. atomicWriteAuthFile — overwrites cleanly (no temp-file leak)
//   5. isAccessTokenExpiring — within skew window
//   6. isAccessTokenExpiring — past exp
//   7. isAccessTokenExpiring — well outside skew (returns false)
//   8. isAccessTokenExpiring — malformed JWT (returns false, no throw)
//   9. isAccessTokenExpiring — missing exp claim (returns false)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  atomicWriteAuthFile,
  buildAuthHeaders,
  isAccessTokenExpiring,
  REFRESH_SKEW_SECONDS,
  OPENAI_AUTH_BASE_URL,
  OPENAI_CODEX_CLIENT_ID,
} from "../codex-oauth.ts";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "subctl-codex-oauth-test-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// Build a fake JWT with the given exp claim (no real signature — we never
// validate signatures, only decode the payload).
function fakeJwtWithExp(expSeconds: number | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(expSeconds === undefined ? {} : { exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

describe("buildAuthHeaders", () => {
  test("includes Content-Type, originator=subctl, User-Agent, version", () => {
    const h = buildAuthHeaders("application/json");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h.originator).toBe("subctl");
    expect(h["User-Agent"]).toMatch(/^subctl\//);
    expect(typeof h.version).toBe("string");
    expect(h.version.length).toBeGreaterThan(0);
  });

  test("respects different content types", () => {
    const json = buildAuthHeaders("application/json");
    const form = buildAuthHeaders("application/x-www-form-urlencoded");
    expect(json["Content-Type"]).toBe("application/json");
    expect(form["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // originator/UA/version match across content types
    expect(json.originator).toBe(form.originator);
  });
});

describe("atomicWriteAuthFile", () => {
  test("creates file at mode 0o600", () => {
    const path = join(scratchDir, "auth.json");
    atomicWriteAuthFile(path, { tokens: { access_token: "a", refresh_token: "b" } });
    expect(existsSync(path)).toBe(true);
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("content round-trips correctly", () => {
    const path = join(scratchDir, "auth.json");
    const payload = {
      OPENAI_API_KEY: null,
      tokens: { access_token: "abc", refresh_token: "def" },
      last_refresh: "2026-05-16T00:00:00.000Z",
    };
    atomicWriteAuthFile(path, payload);
    const readBack = JSON.parse(readFileSync(path, "utf8"));
    expect(readBack).toEqual(payload);
  });

  test("overwrites cleanly without leaving temp files", () => {
    const path = join(scratchDir, "auth.json");
    atomicWriteAuthFile(path, { v: 1 });
    atomicWriteAuthFile(path, { v: 2 });
    atomicWriteAuthFile(path, { v: 3 });
    // After three writes only the target file should exist — no .tmp.* leftover.
    const entries = readdirSync(scratchDir);
    expect(entries).toEqual(["auth.json"]);
    const final = JSON.parse(readFileSync(path, "utf8"));
    expect(final).toEqual({ v: 3 });
  });

  test("creates parent dir if absent (recursive mkdir 0o700)", () => {
    const nestedPath = join(scratchDir, "fresh", "deeper", "auth.json");
    atomicWriteAuthFile(nestedPath, { ok: true });
    expect(existsSync(nestedPath)).toBe(true);
  });
});

describe("isAccessTokenExpiring", () => {
  const now = Math.floor(Date.now() / 1000);

  test("returns true when token expires within skew window", () => {
    // expiring in 60s — well within the 300s default skew
    expect(isAccessTokenExpiring(fakeJwtWithExp(now + 60), REFRESH_SKEW_SECONDS, now)).toBe(true);
  });

  test("returns true when token is already past exp", () => {
    expect(isAccessTokenExpiring(fakeJwtWithExp(now - 100), REFRESH_SKEW_SECONDS, now)).toBe(true);
  });

  test("returns false when token has plenty of life left", () => {
    expect(isAccessTokenExpiring(fakeJwtWithExp(now + 86_400), REFRESH_SKEW_SECONDS, now)).toBe(false);
  });

  test("returns false for malformed JWT (not three dot-separated parts)", () => {
    expect(isAccessTokenExpiring("not-a-jwt", REFRESH_SKEW_SECONDS, now)).toBe(false);
    expect(isAccessTokenExpiring("only.two", REFRESH_SKEW_SECONDS, now)).toBe(false);
  });

  test("returns false when JWT payload has no exp claim", () => {
    expect(isAccessTokenExpiring(fakeJwtWithExp(undefined), REFRESH_SKEW_SECONDS, now)).toBe(false);
  });

  test("respects custom skewSeconds parameter", () => {
    // expiring in 60s
    const tok = fakeJwtWithExp(now + 60);
    // skew of 30s → 60 > 30 → not expiring yet
    expect(isAccessTokenExpiring(tok, 30, now)).toBe(false);
    // skew of 120s → 60 <= 120 → IS expiring
    expect(isAccessTokenExpiring(tok, 120, now)).toBe(true);
  });
});

describe("module constants", () => {
  test("OAuth client id matches OpenAI's public codex CLI client", () => {
    // This is the public client id baked into the OFFICIAL codex CLI and
    // mirrored by openclaw + hermes. Hardcoded value, immutable across
    // installs. Pin it here so a future "oops let's change the client id"
    // change requires explicit test update.
    expect(OPENAI_CODEX_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  test("auth base URL points at auth.openai.com (production)", () => {
    expect(OPENAI_AUTH_BASE_URL).toBe("https://auth.openai.com");
  });
});
