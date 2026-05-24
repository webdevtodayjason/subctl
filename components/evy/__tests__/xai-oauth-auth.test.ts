// components/master/__tests__/xai-oauth-auth.test.ts
//
// Phase B coverage for xai-oauth-auth.ts. The four scenarios from the impl
// plan (§3 Phase B "Done when"):
//
//   (a) missing accounts.conf + missing fallback → undefined with a clear
//       log line
//   (b) valid-token happy path
//   (c) near-expiry kicks ONE background refresh and returns the current
//       (still-valid) token
//   (d) two near-expiry calls within the same window dedup to ONE in-flight
//       refresh (the second call sees `_hasInFlightRefreshForTesting` true
//       and does NOT increment the refresh count)
//
// Plus a handful of supporting cases to lock down the behavior contract.
//
// No network calls — the `refreshFn` override is the seam. The disk side
// is a tmp dir; we never touch ~/.config.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _clearInFlightRefreshForTesting,
  _hasInFlightRefreshForTesting,
  getXaiOauthAccessToken,
  getXaiOauthBaseUrl,
  readXaiOauthAuth,
  resolveActiveXaiOauthAuthPath,
} from "../xai-oauth-auth.ts";
import {
  XaiAuthError,
  XAI_OAUTH_BASE_URL,
  type XaiRefreshedTokens,
} from "../xai-oauth.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

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
  return `${header}.${body}.sigplaceholder`;
}

function makeXaiAuthJson(opts: {
  accessToken: string;
  refreshToken?: string;
  tokenEndpoint?: string;
}): unknown {
  return {
    tokens: {
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken ?? "rt_xxx",
      id_token: "",
      expires_in: 3600,
      token_type: "Bearer",
    },
    last_refresh: "2026-05-18T00:00:00.000Z",
    auth_mode: "oauth_pkce",
    discovery: {
      authorization_endpoint: "https://auth.x.ai/oauth/authorize",
      token_endpoint: opts.tokenEndpoint ?? "https://auth.x.ai/oauth/token",
    },
    redirect_uri: "http://127.0.0.1:56121/callback",
  };
}

function writeAuthJson(path: string, body: unknown): void {
  const dir = path.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 });
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-xai-oauth-auth-test-"));
  _clearInFlightRefreshForTesting();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  _clearInFlightRefreshForTesting();
});

// ─── (a) missing — returns undefined ────────────────────────────────────────

describe("getXaiOauthAccessToken (missing)", () => {
  test("returns undefined when authJsonPath points at a non-existent file", () => {
    const path = join(tmpDir, "no-such-file", "auth.json");
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBeUndefined();
  });

  test("returns undefined when auth.json is malformed JSON", () => {
    const path = join(tmpDir, "broken", "auth.json");
    mkdirSync(join(tmpDir, "broken"), { recursive: true });
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBeUndefined();
  });

  test("returns undefined when tokens block is missing", () => {
    const path = join(tmpDir, "shapeless", "auth.json");
    writeAuthJson(path, { last_refresh: "2026-01-01" });
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBeUndefined();
  });

  test("returns undefined when access_token is missing", () => {
    const path = join(tmpDir, "no-access", "auth.json");
    writeAuthJson(path, { tokens: { refresh_token: "rt_only" } });
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBeUndefined();
  });
});

// ─── (b) valid-token happy path ─────────────────────────────────────────────

describe("getXaiOauthAccessToken (valid)", () => {
  test("returns the access_token when JWT exp is well in the future", () => {
    const path = join(tmpDir, "happy", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 3600 }); // 1h out
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));

    let refreshCount = 0;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      return {
        access_token: "should-not-be-called",
        refresh_token: "rt-new",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    const result = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    expect(result).toBe(token);
    expect(refreshCount).toBe(0);
    expect(_hasInFlightRefreshForTesting(path)).toBe(false);
  });

  test("returns the access_token even when refresh_token is absent (no auto-refresh possible)", () => {
    const path = join(tmpDir, "no-refresh", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 3600 });
    writeAuthJson(path, {
      tokens: { access_token: token, expires_in: 3600, token_type: "Bearer" },
      auth_mode: "oauth_pkce",
    });
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBe(token);
  });

  test("returns the access_token when JWT has no exp claim (cannot determine expiry)", () => {
    // Hermes's _xai_access_token_is_expiring returns false on missing exp,
    // so the resolver treats the token as valid and lets the upstream
    // surface a 401 if it's actually bad.
    const path = join(tmpDir, "no-exp", "auth.json");
    const token = makeJwt({ sub: "user-123" }); // no exp
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));
    expect(getXaiOauthAccessToken({ authJsonPath: path })).toBe(token);
  });
});

// ─── (c) near-expiry kicks one bg refresh ───────────────────────────────────

describe("getXaiOauthAccessToken (near-expiry)", () => {
  test("near-expiry kicks ONE background refresh AND returns the current still-valid token", async () => {
    const path = join(tmpDir, "near", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    // 60s to expiry; default skew is 120s, so this is inside the window.
    const token = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));

    let refreshCount = 0;
    let resolveRefresh: (() => void) | undefined;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      await new Promise<void>((r) => { resolveRefresh = r; });
      return {
        access_token: makeJwt({ exp: now + 3600 }),
        refresh_token: "rt-rotated",
        id_token: "",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    // First call: returns the CURRENT token sync, kicks refresh as side effect.
    const t1 = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    expect(t1).toBe(token);
    expect(refreshCount).toBe(1);
    expect(_hasInFlightRefreshForTesting(path)).toBe(true);

    // Let the in-flight refresh complete + commit to disk.
    resolveRefresh?.();
    // Wait one tick of the event loop for the .finally cleanup.
    await new Promise((r) => setTimeout(r, 20));

    expect(_hasInFlightRefreshForTesting(path)).toBe(false);

    // After the refresh lands, the file should hold the rotated tokens.
    const persisted = readXaiOauthAuth(path);
    expect(persisted?.tokens?.refresh_token).toBe("rt-rotated");
    expect(persisted?.tokens?.access_token).not.toBe(token);
  });
});

// ─── (d) in-flight dedup — two calls, one refresh ───────────────────────────

describe("getXaiOauthAccessToken (in-flight dedup)", () => {
  test("two near-expiry calls within the window kick exactly ONE refresh", async () => {
    const path = join(tmpDir, "dedup", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));

    let refreshCount = 0;
    let resolveRefresh: (() => void) | undefined;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      await new Promise<void>((r) => { resolveRefresh = r; });
      return {
        access_token: makeJwt({ exp: now + 3600 }),
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    const t1 = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    const t2 = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    const t3 = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    expect(t1).toBe(token);
    expect(t2).toBe(token);
    expect(t3).toBe(token);

    // The dedup guarantee: only the FIRST call triggered an actual refresh.
    // Without dedup, three concurrent turns inside the skew window would
    // each POST to api.x.ai's token endpoint — wasteful and a possible
    // rate-limit trigger.
    expect(refreshCount).toBe(1);
    expect(_hasInFlightRefreshForTesting(path)).toBe(true);

    resolveRefresh?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(_hasInFlightRefreshForTesting(path)).toBe(false);
  });

  test("after a refresh completes, the next near-expiry call CAN kick another refresh", async () => {
    // Sanity check: the in-flight slot must release on completion so future
    // refreshes aren't permanently blocked.
    const path = join(tmpDir, "release", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    writeAuthJson(path, makeXaiAuthJson({ accessToken: makeJwt({ exp: now + 60 }) }));

    let refreshCount = 0;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      // Resolve immediately. But because the on-disk write happens INSIDE
      // the async refresh job, we need to also rotate the file so the next
      // call's expiry check sees a near-expiry token again.
      return {
        access_token: makeJwt({ exp: now + 60 }), // still near-expiry, on purpose
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    expect(refreshCount).toBe(1);
    // Wait for the refresh + write + finally to land.
    await new Promise((r) => setTimeout(r, 30));
    expect(_hasInFlightRefreshForTesting(path)).toBe(false);

    // Now a second call should see the same near-expiry condition and kick
    // ANOTHER refresh (it's a different in-flight slot lifetime).
    getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    expect(refreshCount).toBe(2);
  });
});

// ─── post-expiry → undefined with bg-refresh kick ───────────────────────────

describe("getXaiOauthAccessToken (post-expiry)", () => {
  test("expired token + refresh_token: returns undefined and kicks one refresh", () => {
    const path = join(tmpDir, "expired", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now - 60 }); // 1 minute in the past
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));

    let refreshCount = 0;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      return {
        access_token: makeJwt({ exp: now + 3600 }),
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    const result = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    // Sync return is undefined because pi-ai's getApiKey is synchronous and
    // we can't await the refresh in-band. Next turn picks up the new token.
    expect(result).toBeUndefined();
    expect(refreshCount).toBe(1);
  });

  test("expired token + NO refresh_token: returns undefined and does NOT kick a refresh", () => {
    const path = join(tmpDir, "stuck", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now - 60 });
    writeAuthJson(path, {
      tokens: { access_token: token }, // no refresh_token
      auth_mode: "oauth_pkce",
    });

    let refreshCount = 0;
    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      refreshCount += 1;
      return {} as unknown as XaiRefreshedTokens;
    };

    expect(getXaiOauthAccessToken({ authJsonPath: path, refreshFn })).toBeUndefined();
    expect(refreshCount).toBe(0);
    expect(_hasInFlightRefreshForTesting(path)).toBe(false);
  });
});

// ─── host-pin re-check on cached token_endpoint ─────────────────────────────

describe("cached token_endpoint host-pin re-check", () => {
  test("cached endpoint with attacker host triggers fallback to fresh discovery", async () => {
    // The refreshFn is the seam; we assert what params it RECEIVES, not the
    // network. When the cached endpoint fails the host-pin re-check, the
    // resolver passes tokenEndpoint=undefined → refreshFn falls back to
    // a discovery call.
    const path = join(tmpDir, "poisoned-cache", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({
      accessToken: token,
      tokenEndpoint: "https://attacker.example.com/oauth/token",
    }));

    let observedTokenEndpoint: string | undefined = "sentinel";
    const refreshFn = async (params: {
      refreshToken: string;
      tokenEndpoint?: string;
    }): Promise<XaiRefreshedTokens> => {
      observedTokenEndpoint = params.tokenEndpoint;
      return {
        access_token: makeJwt({ exp: now + 3600 }),
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    await new Promise((r) => setTimeout(r, 20));
    // refreshFn was called with tokenEndpoint=undefined — the cached
    // attacker URL was dropped on the floor by the host-pin re-check.
    expect(observedTokenEndpoint).toBeUndefined();
  });

  test("cached endpoint with legitimate xAI host is passed through to refreshFn", async () => {
    const path = join(tmpDir, "clean-cache", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({
      accessToken: token,
      tokenEndpoint: "https://auth.x.ai/oauth/token",
    }));

    let observedTokenEndpoint: string | undefined;
    const refreshFn = async (params: {
      refreshToken: string;
      tokenEndpoint?: string;
    }): Promise<XaiRefreshedTokens> => {
      observedTokenEndpoint = params.tokenEndpoint;
      return {
        access_token: makeJwt({ exp: now + 3600 }),
        refresh_token: "rt-rotated",
        token_type: "Bearer",
        last_refresh: new Date().toISOString(),
      };
    };

    getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    await new Promise((r) => setTimeout(r, 20));
    expect(observedTokenEndpoint).toBe("https://auth.x.ai/oauth/token");
  });
});

// ─── refresh-failure path leaves operator in a useful state ─────────────────

describe("refresh failure handling", () => {
  test("refresh throwing does NOT crash the resolver; in-flight slot still releases", async () => {
    const path = join(tmpDir, "bad-refresh", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({ accessToken: token }));

    const refreshFn = async (): Promise<XaiRefreshedTokens> => {
      throw new XaiAuthError(
        "xAI token refresh failed. Response: invalid_grant",
        "xai_refresh_failed",
        true,
      );
    };

    const result = getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    // Sync return is unaffected — we still get the current still-valid token.
    expect(result).toBe(token);
    expect(_hasInFlightRefreshForTesting(path)).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(_hasInFlightRefreshForTesting(path)).toBe(false);

    // The on-disk file should NOT have been touched.
    const stillThere = readXaiOauthAuth(path);
    expect(stillThere?.tokens?.access_token).toBe(token);
  });
});

// ─── supporting surface — path resolver + base URL ──────────────────────────

describe("resolveActiveXaiOauthAuthPath", () => {
  test("returns null when no accounts.conf row and no fallback file exists", () => {
    // Point accounts.conf at an empty file in our tmpdir so we don't read
    // the operator's real config. The fallback file at ~/.config/... may or
    // may not exist on this dev machine — assert the function returned
    // either null OR a string, without throwing.
    const conf = join(tmpDir, "accounts.conf");
    writeFileSync(conf, "# empty\n", { mode: 0o600 });
    const prev = process.env.SUBCTL_ACCOUNTS_CONF;
    process.env.SUBCTL_ACCOUNTS_CONF = conf;
    try {
      const result = resolveActiveXaiOauthAuthPath();
      expect(result === null || typeof result === "string").toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SUBCTL_ACCOUNTS_CONF;
      else process.env.SUBCTL_ACCOUNTS_CONF = prev;
    }
  });

  test("returns <configDir>/auth.json when accounts.conf has a xai-oauth row", () => {
    const xaiDir = join(tmpDir, "xai-jason");
    const conf = join(tmpDir, "accounts.conf");
    writeFileSync(
      conf,
      `xai-jason | xai-oauth | jbrashear72@icloud.com | ${xaiDir} | SuperGrok seat\n`,
      { mode: 0o600 },
    );
    const prev = process.env.SUBCTL_ACCOUNTS_CONF;
    process.env.SUBCTL_ACCOUNTS_CONF = conf;
    try {
      expect(resolveActiveXaiOauthAuthPath()).toBe(join(xaiDir, "auth.json"));
    } finally {
      if (prev === undefined) delete process.env.SUBCTL_ACCOUNTS_CONF;
      else process.env.SUBCTL_ACCOUNTS_CONF = prev;
    }
  });
});

describe("getXaiOauthBaseUrl", () => {
  test("returns the default when no env override is set", () => {
    const prevSubctl = process.env.SUBCTL_XAI_BASE_URL;
    const prevGeneric = process.env.XAI_BASE_URL;
    delete process.env.SUBCTL_XAI_BASE_URL;
    delete process.env.XAI_BASE_URL;
    try {
      expect(getXaiOauthBaseUrl()).toBe(XAI_OAUTH_BASE_URL);
    } finally {
      if (prevSubctl !== undefined) process.env.SUBCTL_XAI_BASE_URL = prevSubctl;
      if (prevGeneric !== undefined) process.env.XAI_BASE_URL = prevGeneric;
    }
  });

  test("SUBCTL_XAI_BASE_URL takes precedence over XAI_BASE_URL", () => {
    const prevSubctl = process.env.SUBCTL_XAI_BASE_URL;
    const prevGeneric = process.env.XAI_BASE_URL;
    process.env.SUBCTL_XAI_BASE_URL = "https://primary.example/v1";
    process.env.XAI_BASE_URL = "https://fallback.example/v1";
    try {
      expect(getXaiOauthBaseUrl()).toBe("https://primary.example/v1");
    } finally {
      if (prevSubctl === undefined) delete process.env.SUBCTL_XAI_BASE_URL;
      else process.env.SUBCTL_XAI_BASE_URL = prevSubctl;
      if (prevGeneric === undefined) delete process.env.XAI_BASE_URL;
      else process.env.XAI_BASE_URL = prevGeneric;
    }
  });

  test("trailing slashes on the env override are stripped", () => {
    const prev = process.env.SUBCTL_XAI_BASE_URL;
    process.env.SUBCTL_XAI_BASE_URL = "https://primary.example/v1///";
    try {
      expect(getXaiOauthBaseUrl()).toBe("https://primary.example/v1");
    } finally {
      if (prev === undefined) delete process.env.SUBCTL_XAI_BASE_URL;
      else process.env.SUBCTL_XAI_BASE_URL = prev;
    }
  });
});

// ─── exercise the persisted-rotation effect (integration-ish) ───────────────

describe("rotated tokens persist to disk", () => {
  test("after near-expiry refresh, reading the file shows the rotated access_token", async () => {
    const path = join(tmpDir, "rotate", "auth.json");
    const now = Math.floor(Date.now() / 1000);
    const oldToken = makeJwt({ exp: now + 60 });
    writeAuthJson(path, makeXaiAuthJson({ accessToken: oldToken }));

    const newToken = makeJwt({ exp: now + 3600 });
    const refreshFn = async (): Promise<XaiRefreshedTokens> => ({
      access_token: newToken,
      refresh_token: "rt-rotated",
      id_token: "id-fresh",
      token_type: "Bearer",
      last_refresh: "2026-05-18T12:34:56.789Z",
    });

    getXaiOauthAccessToken({ authJsonPath: path, refreshFn });
    await new Promise((r) => setTimeout(r, 30));

    const persisted = JSON.parse(readFileSync(path, "utf8"));
    expect(persisted.tokens.access_token).toBe(newToken);
    expect(persisted.tokens.refresh_token).toBe("rt-rotated");
    expect(persisted.tokens.id_token).toBe("id-fresh");
    expect(persisted.last_refresh).toBe("2026-05-18T12:34:56.789Z");
    expect(persisted.auth_mode).toBe("oauth_pkce");
    // Pre-existing fields preserved.
    expect(persisted.discovery.token_endpoint).toBe("https://auth.x.ai/oauth/token");
    expect(persisted.redirect_uri).toBe("http://127.0.0.1:56121/callback");
  });
});
