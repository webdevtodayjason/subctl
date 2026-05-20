// components/master/__tests__/xai-oauth.test.ts
//
// Phase A coverage for xai-oauth.ts. The host-pin negative case is the
// load-bearing test — it asserts that a discovery response with a
// non-x.ai `token_endpoint` is REJECTED before any credential ever touches
// the wire. Mirror of `_xai_validate_oauth_endpoint`
// (hermes-agent/hermes_cli/auth.py:2997–3035).
//
// Why this matters: the discovery response is cached on disk. A one-time
// MITM at initial login could substitute a malicious token_endpoint, and
// every subsequent refresh would POST the refresh_token to the attacker —
// a permanent credential leak from a one-time intercept. The host-pin
// closes that hole. If this test ever breaks, the security property is
// gone; DO NOT loosen the assertion to make it pass — fix the code.
//
// Network calls are stubbed via the optional `fetchFn` parameter on
// `discoverXaiOauthEndpoints`. No real auth.x.ai round-trip ever happens.

import { describe, expect, test } from "bun:test";

import {
  buildAuthorizeUrl,
  discoverXaiOauthEndpoints,
  validateLoopbackRedirectUri,
  validateXaiOauthEndpoint,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_HOST,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_OAUTH_SCOPE,
  XaiAuthError,
} from "../xai-oauth.ts";

// ─── helpers ────────────────────────────────────────────────────────────────

function stubFetch(body: unknown, status: number = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

// ─── validateXaiOauthEndpoint — the security-critical unit test ─────────────

describe("validateXaiOauthEndpoint (host-pin)", () => {
  test("accepts the canonical issuer", () => {
    const ok = validateXaiOauthEndpoint("https://auth.x.ai/oauth/authorize", "authorization_endpoint");
    expect(ok).toBe("https://auth.x.ai/oauth/authorize");
  });

  test("accepts a *.x.ai subdomain", () => {
    expect(() =>
      validateXaiOauthEndpoint("https://accounts.x.ai/token", "token_endpoint"),
    ).not.toThrow();
  });

  test("accepts the bare x.ai apex", () => {
    expect(() =>
      validateXaiOauthEndpoint("https://x.ai/oauth/token", "token_endpoint"),
    ).not.toThrow();
  });

  test("REJECTS an attacker-controlled host with xai_discovery_invalid", () => {
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("https://evil.example.com/oauth/token", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
    expect((caught as XaiAuthError).provider).toBe("xai-oauth");
  });

  test("REJECTS a look-alike host that ends in .ai but not .x.ai", () => {
    // `evil-x.ai` would pass a naive endsWith('.ai') check but must fail
    // here — the pin is on `.x.ai`, not `.ai`.
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("https://evil-x.ai/oauth/token", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
  });

  test("REJECTS a host that contains 'x.ai' as a substring but not as the suffix", () => {
    // x.ai.attacker.com would have `x.ai` in its name but is clearly not on
    // the xAI origin. Must fail.
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("https://x.ai.attacker.com/oauth/token", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
  });

  test("REJECTS HTTP-on-the-right-host (downgrade attack)", () => {
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("http://auth.x.ai/oauth/token", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
  });

  test("REJECTS an unparseable URL", () => {
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("not a url", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
  });

  test("Error.reloginRequired defaults to false for discovery-time failures", () => {
    let caught: unknown;
    try {
      validateXaiOauthEndpoint("https://evil.example.com/x", "token_endpoint");
    } catch (err) {
      caught = err;
    }
    expect((caught as XaiAuthError).reloginRequired).toBe(false);
  });
});

// ─── discoverXaiOauthEndpoints — host-pin propagates through discovery ──────

describe("discoverXaiOauthEndpoints (host-pin propagation)", () => {
  test("happy path returns both endpoints when xAI-hosted", async () => {
    const fetchFn = stubFetch({
      authorization_endpoint: "https://auth.x.ai/oauth/authorize",
      token_endpoint: "https://auth.x.ai/oauth/token",
    });
    const d = await discoverXaiOauthEndpoints({ fetchFn });
    expect(d.authorization_endpoint).toBe("https://auth.x.ai/oauth/authorize");
    expect(d.token_endpoint).toBe("https://auth.x.ai/oauth/token");
  });

  test("MITM substitutes token_endpoint → discovery throws xai_discovery_invalid", async () => {
    // This is the scenario the host-pin exists for. The auth endpoint looks
    // legit; the token endpoint has been swapped to an attacker URL. Without
    // the pin, every future refresh would POST refresh_token to the attacker.
    const fetchFn = stubFetch({
      authorization_endpoint: "https://auth.x.ai/oauth/authorize",
      token_endpoint: "https://attacker.example.com/oauth/token",
    });
    let caught: unknown;
    try {
      await discoverXaiOauthEndpoints({ fetchFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
    expect((caught as XaiAuthError).message).toContain("token_endpoint");
  });

  test("MITM substitutes authorization_endpoint → discovery throws xai_discovery_invalid", async () => {
    const fetchFn = stubFetch({
      authorization_endpoint: "https://attacker.example.com/oauth/authorize",
      token_endpoint: "https://auth.x.ai/oauth/token",
    });
    let caught: unknown;
    try {
      await discoverXaiOauthEndpoints({ fetchFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid");
    expect((caught as XaiAuthError).message).toContain("authorization_endpoint");
  });

  test("non-200 discovery surfaces xai_discovery_failed", async () => {
    const fetchFn = stubFetch("nope", 503);
    let caught: unknown;
    try {
      await discoverXaiOauthEndpoints({ fetchFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_failed");
  });

  test("invalid JSON surfaces xai_discovery_invalid_json", async () => {
    const fetchFn = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await discoverXaiOauthEndpoints({ fetchFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_invalid_json");
  });

  test("missing endpoints surface xai_discovery_incomplete", async () => {
    const fetchFn = stubFetch({ token_endpoint: "https://auth.x.ai/oauth/token" });
    let caught: unknown;
    try {
      await discoverXaiOauthEndpoints({ fetchFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XaiAuthError);
    expect((caught as XaiAuthError).code).toBe("xai_discovery_incomplete");
  });
});

// ─── validateLoopbackRedirectUri ────────────────────────────────────────────

describe("validateLoopbackRedirectUri", () => {
  test("accepts a well-formed 127.0.0.1 URL", () => {
    const out = validateLoopbackRedirectUri("http://127.0.0.1:56121/callback");
    expect(out.host).toBe(XAI_OAUTH_REDIRECT_HOST);
    expect(out.port).toBe(56121);
    expect(out.path).toBe(XAI_OAUTH_REDIRECT_PATH);
  });

  test("rejects HTTPS scheme (loopback OAuth is plain HTTP)", () => {
    expect(() => validateLoopbackRedirectUri("https://127.0.0.1:56121/callback")).toThrow(XaiAuthError);
  });

  test("rejects localhost hostname (must be 127.0.0.1 literal)", () => {
    expect(() => validateLoopbackRedirectUri("http://localhost:56121/callback")).toThrow(XaiAuthError);
  });

  test("rejects missing port", () => {
    expect(() => validateLoopbackRedirectUri("http://127.0.0.1/callback")).toThrow(XaiAuthError);
  });
});

// ─── buildAuthorizeUrl ──────────────────────────────────────────────────────

describe("buildAuthorizeUrl", () => {
  test("includes plan=generic and referrer=subctl plus PKCE+state+nonce", () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: "https://auth.x.ai/oauth/authorize",
      redirectUri: "http://127.0.0.1:56121/callback",
      codeChallenge: "challenge-base64url",
      state: "state-hex",
      nonce: "nonce-hex",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("scope")).toBe(XAI_OAUTH_SCOPE);
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-base64url");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-hex");
    expect(parsed.searchParams.get("nonce")).toBe("nonce-hex");
    // These two are xAI-specific and load-bearing:
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("subctl");
  });
});
