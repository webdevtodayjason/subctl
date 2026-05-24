// components/evy/__tests__/xai-oauth-cli.test.ts
//
// Phase D coverage — the CLI auth path.
//
// We don't unit-test the bash wrapper (providers/xai-oauth/auth.sh) or the
// CLI script entrypoint (cli/xai-oauth-login.ts) directly — those are
// glue around Phase A's completeXaiOauthLogin. Instead we lock down:
//
//   1. completeXaiOauthLogin end-to-end (the seam the CLI script calls):
//      mocks fetch for discovery + token exchange, drives the real
//      loopback HTTP server programmatically via onAuthorizeUrl, and
//      asserts auth.json is written with the Hermes-compatible shape.
//   2. The CLI script + provider shim are present and executable on disk.
//   3. bin/subctl exposes the xai-oauth dispatch (help text + case branch).
//
// The end-to-end test is the integration-test slot the impl plan called
// for: it exercises discovery → redirect bind → state echo → token
// exchange → atomicWriteAuthFile → readback as one continuous flow.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  completeXaiOauthLogin,
  type FetchFn,
} from "../xai-oauth.ts";

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-xai-oauth-cli-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

/** Build a fetch mock that responds to discovery + token-exchange. The
 *  callback hit to the redirect_uri uses the REAL globalThis.fetch (it
 *  must — it's actually hitting our loopback server bound on 127.0.0.1). */
function buildFetchMock(opts: {
  accessToken: string;
  refreshToken: string;
  onTokenExchange?: (body: URLSearchParams) => void;
}): FetchFn {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          authorization_endpoint: "https://auth.x.ai/oauth/authorize",
          token_endpoint: "https://auth.x.ai/oauth/token",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://auth.x.ai/oauth/token") {
      const body = init?.body;
      if (body instanceof URLSearchParams && opts.onTokenExchange) {
        opts.onTokenExchange(body);
      }
      return new Response(
        JSON.stringify({
          access_token: opts.accessToken,
          refresh_token: opts.refreshToken,
          id_token: "id-token-fresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`fetch mock: unexpected URL ${url}`);
  }) as unknown as FetchFn;
}

// ─── (1) end-to-end loopback login + persist ────────────────────────────────

describe("completeXaiOauthLogin (end-to-end)", () => {
  test("PKCE-loopback flow writes a Hermes-shaped auth.json", async () => {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = makeJwt({ exp: now + 3600 });
    const authJsonPath = join(tmpDir, "xai-jason", "auth.json");

    let observedCodeVerifier: string | undefined;
    let observedCode: string | undefined;
    let observedRedirectUri: string | undefined;
    let observedClientId: string | undefined;

    const fetchFn = buildFetchMock({
      accessToken,
      refreshToken: "rt-initial",
      onTokenExchange: (body) => {
        observedCode = body.get("code") ?? undefined;
        observedCodeVerifier = body.get("code_verifier") ?? undefined;
        observedRedirectUri = body.get("redirect_uri") ?? undefined;
        observedClientId = body.get("client_id") ?? undefined;
      },
    });

    const result = await completeXaiOauthLogin({
      authJsonPath,
      alias: "xai-jason",
      preferredPort: 0, // OS-assigned, so we don't collide with anything
      fetchFn,
      callbackTimeoutMs: 5000,
      onAuthorizeUrl: async ({ authorizeUrl, redirectUri }) => {
        // The whole point of this seam: drive the callback programmatically
        // by parsing state from the authorize URL and POSTing to the
        // redirect_uri. This is what a real browser would do.
        const url = new URL(authorizeUrl);
        const state = url.searchParams.get("state");
        expect(state).toBeTruthy();
        expect(url.searchParams.get("plan")).toBe("generic");
        expect(url.searchParams.get("referrer")).toBe("subctl");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        // Use the REAL fetch — we're actually hitting the loopback server.
        const callbackResp = await globalThis.fetch(
          `${redirectUri}?code=test-auth-code&state=${state}`,
        );
        expect(callbackResp.status).toBe(200);
      },
    });

    // Result shape
    expect(result.authPath).toBe(authJsonPath);
    expect(result.base_url).toBe("https://api.x.ai/v1");
    expect(typeof result.last_refresh).toBe("string");

    // The token-exchange POST was driven with our PKCE verifier + code.
    expect(observedCode).toBe("test-auth-code");
    expect(observedCodeVerifier).toBeTruthy();
    expect(observedCodeVerifier!.length).toBeGreaterThanOrEqual(40); // 32 bytes b64url ≈ 43 chars
    expect(observedClientId).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(observedRedirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // auth.json on disk matches Hermes's _save_xai_oauth_tokens shape.
    expect(existsSync(authJsonPath)).toBe(true);
    const st = statSync(authJsonPath);
    expect(st.mode & 0o777).toBe(0o600);

    const persisted = JSON.parse(readFileSync(authJsonPath, "utf8"));
    expect(persisted.tokens.access_token).toBe(accessToken);
    expect(persisted.tokens.refresh_token).toBe("rt-initial");
    expect(persisted.tokens.id_token).toBe("id-token-fresh");
    expect(persisted.tokens.token_type).toBe("Bearer");
    expect(persisted.tokens.expires_in).toBe(3600);
    expect(persisted.auth_mode).toBe("oauth_pkce");
    expect(persisted.discovery.authorization_endpoint).toBe("https://auth.x.ai/oauth/authorize");
    expect(persisted.discovery.token_endpoint).toBe("https://auth.x.ai/oauth/token");
    expect(persisted.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(persisted._subctl.alias).toBe("xai-jason");
    expect(persisted._subctl.minted_by).toBe("subctl auth xai-oauth");
  });

  test("state mismatch in callback throws xai_state_mismatch", async () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchFn = buildFetchMock({ accessToken, refreshToken: "rt" });

    let caught: unknown;
    try {
      await completeXaiOauthLogin({
        authJsonPath: join(tmpDir, "no-write", "auth.json"),
        alias: "x",
        preferredPort: 0,
        fetchFn,
        callbackTimeoutMs: 5000,
        onAuthorizeUrl: async ({ redirectUri }) => {
          // Submit a state that does NOT match what was minted.
          await globalThis.fetch(
            `${redirectUri}?code=test-auth-code&state=WRONG-STATE`,
          );
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/state mismatch/);
    // No auth.json should have been written.
    expect(existsSync(join(tmpDir, "no-write", "auth.json"))).toBe(false);
  });

  test("callback delivering error=access_denied surfaces xai_authorization_failed", async () => {
    const accessToken = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchFn = buildFetchMock({ accessToken, refreshToken: "rt" });

    let caught: unknown;
    try {
      await completeXaiOauthLogin({
        authJsonPath: join(tmpDir, "denied", "auth.json"),
        alias: "x",
        preferredPort: 0,
        fetchFn,
        callbackTimeoutMs: 5000,
        onAuthorizeUrl: async ({ redirectUri }) => {
          await globalThis.fetch(
            `${redirectUri}?error=access_denied&error_description=Operator+declined`,
          );
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/authorization failed/);
    expect((caught as Error).message).toMatch(/Operator declined/);
  });

  test("token-exchange returning no access_token surfaces xai_token_exchange_invalid", async () => {
    const partialFetchFn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.x.ai/oauth/authorize",
            token_endpoint: "https://auth.x.ai/oauth/token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Token exchange returns a 200 with the access_token field missing.
      return new Response(
        JSON.stringify({ refresh_token: "rt-but-no-access" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as FetchFn;

    let caught: unknown;
    try {
      await completeXaiOauthLogin({
        authJsonPath: join(tmpDir, "broken", "auth.json"),
        alias: "x",
        preferredPort: 0,
        fetchFn: partialFetchFn,
        callbackTimeoutMs: 5000,
        onAuthorizeUrl: async ({ authorizeUrl, redirectUri }) => {
          const state = new URL(authorizeUrl).searchParams.get("state");
          await globalThis.fetch(`${redirectUri}?code=x&state=${state}`);
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/access_token/);
  });
});

// ─── (2) on-disk artifacts (CLI + provider shim) ────────────────────────────

describe("Phase D on-disk artifacts", () => {
  test("cli/xai-oauth-login.ts exists and is executable", () => {
    const path = join(import.meta.dir, "..", "cli", "xai-oauth-login.ts");
    expect(existsSync(path)).toBe(true);
    const st = statSync(path);
    // Owner-executable bit set.
    expect(st.mode & 0o100).toBeTruthy();
  });

  test("providers/xai-oauth/auth.sh exists and is executable", () => {
    const path = join(import.meta.dir, "..", "..", "..", "providers", "xai-oauth", "auth.sh");
    expect(existsSync(path)).toBe(true);
    const st = statSync(path);
    expect(st.mode & 0o100).toBeTruthy();
  });

  test("CLI script declares the expected usage line", () => {
    const path = join(import.meta.dir, "..", "cli", "xai-oauth-login.ts");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("xai-oauth-login.ts <alias> <configDir>");
    expect(text).toContain("completeXaiOauthLogin");
    expect(text).toContain("Press Ctrl-C to cancel");
  });

  test("provider shim declares the expected dispatch function", () => {
    const path = join(import.meta.dir, "..", "..", "..", "providers", "xai-oauth", "auth.sh");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("provider_xai_oauth_auth()");
    expect(text).toContain("provider_xai_oauth_auth_all()");
    expect(text).toContain("xai-oauth-login.ts");
  });
});

// ─── (3) bin/subctl wiring ──────────────────────────────────────────────────

describe("bin/subctl wiring", () => {
  test("bin/subctl has an xai-oauth case in the auth dispatcher", () => {
    const path = join(import.meta.dir, "..", "..", "..", "bin", "subctl");
    const text = readFileSync(path, "utf8");
    // Dispatch branch:
    expect(text).toContain("xai-oauth)");
    expect(text).toContain("provider_xai_oauth_auth ");
    // auth_all walk includes the new provider:
    expect(text).toContain("provider_xai_oauth_auth_all");
    // Usage error string lists xai-oauth:
    expect(text).toMatch(/usage:\s*subctl auth.*xai-oauth/);
  });

  test("usage() help text mentions xai-oauth", () => {
    const path = join(import.meta.dir, "..", "..", "..", "bin", "subctl");
    const text = readFileSync(path, "utf8");
    // Hits the help block, not just the dispatch.
    const usageMatch = text.match(/usage\(\) \{[\s\S]+?\}\n/);
    expect(usageMatch).toBeTruthy();
    expect(usageMatch![0]).toContain("xai-oauth");
  });
});
