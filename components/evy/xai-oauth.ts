// components/master/xai-oauth.ts
//
// v2.x — xAI Grok OAuth (SuperGrok Subscription) plumbing for subctl.
//
// This module ports Hermes Agent's PKCE-loopback flow from
// `hermes-agent/hermes_cli/auth.py` (Python; ~6298 LOC) into a self-contained
// TypeScript module that the subctl master daemon owns. Both projects use
// xAI's public Grok-CLI OAuth client id (`b1a00492-073a-47ea-816f-4c329264a828`)
// because xAI has not yet minted per-tool client ids. We forward the same
// `plan=generic` consent-screen param Hermes uses (the upstream `accounts.x.ai`
// allowlist rejects loopback OAuth from non-allowlisted clients without it),
// and identify ourselves as `referrer=subctl` for server-log attribution.
//
// What this module DOES:
//   - OIDC discovery against https://auth.x.ai/.well-known/openid-configuration
//     with HARD HOST-PIN validation on both authorization_endpoint and
//     token_endpoint (x.ai or *.x.ai over HTTPS only).
//   - PKCE-S256 loopback login: 127.0.0.1 callback → authorize URL with
//     state+nonce → code → token exchange.
//   - refresh-on-near-expiry: POST token_endpoint grant_type=refresh_token
//     (public client; NO client_secret).
//   - Reuses atomicWriteAuthFile + isAccessTokenExpiring from codex-oauth.ts.
//
// What this module deliberately does NOT do:
//   - Read/write Hermes's `~/.hermes/auth.json`. Subctl owns its own auth
//     store under `~/.config/subctl/master/oauth/xai-oauth.json`. Reading
//     Hermes's store directly would bypass Hermes's _auth_store_lock and
//     race with concurrent refreshes.
//   - Multi-account routing. xAI only ships one SuperGrok seat per user
//     today; one-file storage is sufficient. Multi-account is deferred.
//   - Device-code flow. xAI's OAuth surface is PKCE-loopback only (no
//     `device_authorization_endpoint` in discovery as of Hermes's last read).
//   - Token resolution for pi-ai. That belongs in xai-oauth-auth.ts (Phase B).
//
// ─── Why host-pin matters (DO NOT REMOVE) ────────────────────────────────────
// The OIDC discovery response is a long-lived, low-frequency request whose
// output is cached on disk. A single MITM during initial login could
// substitute a malicious `token_endpoint`; that URL would then receive the
// refresh_token on every subsequent refresh — a permanent credential leak
// from a one-time MITM. Validating scheme + host pins the cached endpoint
// to the xAI auth origin (or any future *.x.ai subdomain), so cache
// poisoning loses its persistence guarantee. RFC 8414 §2 requires the
// issuer to be `https://` and SHOULD-keeps the token_endpoint on the
// same origin; we enforce both. This rationale is lifted verbatim from
// `hermes_cli/auth.py:_xai_validate_oauth_endpoint` (lines 2997–3035).
// ─────────────────────────────────────────────────────────────────────────────

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";

import {
  atomicWriteAuthFile,
  isAccessTokenExpiring,
} from "./codex-oauth.ts";

// ─── constants (verbatim from hermes_cli/auth.py:75,93–100,111) ─────────────

export const XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export const XAI_OAUTH_DOCS_URL =
  "https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth";

// Matches Hermes's XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS (auth.py:100).
// Distinct from codex-oauth.ts's REFRESH_SKEW_SECONDS=300 — xAI rotates more
// aggressively, hence the tighter 2-min window.
export const XAI_REFRESH_SKEW_SECONDS = 120;

// CORS allowlist for the loopback callback. Mirror auth.py:2086–2094.
const XAI_CALLBACK_ALLOWED_ORIGINS = new Set<string>([
  "https://accounts.x.ai",
  "https://auth.x.ai",
]);

// ─── XaiAuthError taxonomy (mirror of auth.py error codes, §1.9 of impl plan) ─

/** Strongly-typed code surface. The string values are stable across
 *  Hermes (Python) and subctl (TypeScript) on purpose — operators
 *  grepping master.log + hermes.log see the same string for the same
 *  condition. Do not rename without updating both projects. */
export type XaiAuthErrorCode =
  | "xai_redirect_invalid"
  | "xai_callback_bind_failed"
  | "xai_callback_timeout"
  | "xai_auth_missing"
  | "xai_auth_invalid_shape"
  | "xai_auth_missing_access_token"
  | "xai_auth_missing_refresh_token"
  | "xai_discovery_failed"
  | "xai_discovery_invalid"
  | "xai_discovery_invalid_json"
  | "xai_discovery_incomplete"
  | "xai_refresh_failed"
  | "xai_refresh_invalid_json"
  | "xai_refresh_invalid_response"
  | "xai_refresh_missing_access_token"
  | "xai_authorization_failed"
  | "xai_state_mismatch"
  | "xai_code_missing"
  | "xai_token_exchange_failed"
  | "xai_token_exchange_invalid";

export class XaiAuthError extends Error {
  readonly code: XaiAuthErrorCode;
  readonly reloginRequired: boolean;
  readonly provider = "xai-oauth" as const;

  constructor(message: string, code: XaiAuthErrorCode, reloginRequired: boolean = false) {
    super(message);
    this.name = "XaiAuthError";
    this.code = code;
    this.reloginRequired = reloginRequired;
  }
}

// ─── small helpers ──────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: code_verifier is 32 bytes of CSPRNG, base64url-encoded; the
 *  code_challenge is SHA-256(verifier), base64url-encoded. Hermes uses the
 *  same shape via `_oauth_pkce_code_verifier` / `_oauth_pkce_code_challenge`. */
function pkceCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

function pkceCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function uuidHex(): string {
  // Hermes uses uuid.uuid4().hex (32 hex chars, no dashes); we mirror that
  // shape so generated state/nonce values are interchangeable in size.
  return randomBytes(16).toString("hex");
}

// ─── endpoint validators ────────────────────────────────────────────────────

/** Refuse any OIDC endpoint that isn't HTTPS on the xAI origin.
 *
 *  Throws XaiAuthError(code='xai_discovery_invalid') on any of:
 *    - non-HTTPS scheme
 *    - missing/empty hostname
 *    - host that is neither 'x.ai' nor a '*.x.ai' suffix
 *
 *  Mirror of `_xai_validate_oauth_endpoint` (auth.py:2997–3035). MUST be
 *  called against BOTH the freshly-fetched discovery endpoints AND any
 *  cached endpoint read from disk before reuse on the refresh hot path.
 */
export function validateXaiOauthEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiAuthError(
      `xAI OIDC discovery returned an unparseable ${field}: ${JSON.stringify(url)}.`,
      "xai_discovery_invalid",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new XaiAuthError(
      `xAI OIDC discovery returned a non-HTTPS ${field}: ${JSON.stringify(url)}.`,
      "xai_discovery_invalid",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new XaiAuthError(
      `xAI OIDC discovery ${field} is missing a hostname: ${JSON.stringify(url)}.`,
      "xai_discovery_invalid",
    );
  }
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new XaiAuthError(
      `xAI OIDC discovery ${field} host ${JSON.stringify(host)} is not on the xAI origin ` +
        `(expected x.ai or a *.x.ai subdomain). Refusing to use a cached endpoint that may ` +
        `have been substituted by a MITM during initial discovery; re-authenticate with ` +
        `\`subctl auth xai-oauth <alias>\` to re-fetch.`,
      "xai_discovery_invalid",
    );
  }
  return url;
}

/** Enforce `http://127.0.0.1:<port>/...` on the loopback redirect URI. Mirror
 *  of `_xai_validate_loopback_redirect_uri` (auth.py:2062–2083). */
export function validateLoopbackRedirectUri(
  redirectUri: string,
): { host: string; port: number; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new XaiAuthError(
      "xAI OAuth redirect_uri must use http://127.0.0.1.",
      "xai_redirect_invalid",
    );
  }
  if (parsed.protocol !== "http:") {
    throw new XaiAuthError(
      "xAI OAuth redirect_uri must use http://127.0.0.1.",
      "xai_redirect_invalid",
    );
  }
  if (parsed.hostname !== XAI_OAUTH_REDIRECT_HOST) {
    throw new XaiAuthError(
      "xAI OAuth redirect_uri must point to 127.0.0.1.",
      "xai_redirect_invalid",
    );
  }
  if (!parsed.port) {
    throw new XaiAuthError(
      "xAI OAuth redirect_uri must include an explicit localhost port.",
      "xai_redirect_invalid",
    );
  }
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port, 10),
    path: parsed.pathname || "/",
  };
}

// ─── discovery ──────────────────────────────────────────────────────────────

export interface XaiOauthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

/** Optional fetch override — exposed for tests so we never have to actually
 *  hit auth.x.ai. Defaults to the global fetch. */
export type FetchFn = typeof fetch;

/** Fetch + validate the OIDC discovery document.
 *  Throws XaiAuthError with one of: xai_discovery_failed,
 *  xai_discovery_invalid_json, xai_discovery_incomplete, xai_discovery_invalid.
 *  Mirror of `_xai_oauth_discovery` (auth.py:3038–3084). */
export async function discoverXaiOauthEndpoints(opts: {
  timeoutMs?: number;
  fetchFn?: FetchFn;
} = {}): Promise<XaiOauthDiscovery> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(XAI_OAUTH_DISCOVERY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new XaiAuthError(
      `xAI OIDC discovery failed: ${(err as Error).message ?? String(err)}`,
      "xai_discovery_failed",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    throw new XaiAuthError(
      `xAI OIDC discovery returned status ${response.status}.`,
      "xai_discovery_failed",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new XaiAuthError(
      `xAI OIDC discovery returned invalid JSON: ${(err as Error).message ?? String(err)}`,
      "xai_discovery_invalid_json",
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new XaiAuthError(
      "xAI OIDC discovery response was not a JSON object.",
      "xai_discovery_incomplete",
    );
  }
  const obj = payload as Record<string, unknown>;
  const authorizationEndpoint = typeof obj.authorization_endpoint === "string"
    ? obj.authorization_endpoint.trim()
    : "";
  const tokenEndpoint = typeof obj.token_endpoint === "string"
    ? obj.token_endpoint.trim()
    : "";
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new XaiAuthError(
      "xAI OIDC discovery response was missing required endpoints.",
      "xai_discovery_incomplete",
    );
  }
  // Host-pin BOTH endpoints. Throws xai_discovery_invalid on any mismatch.
  validateXaiOauthEndpoint(authorizationEndpoint, "authorization_endpoint");
  validateXaiOauthEndpoint(tokenEndpoint, "token_endpoint");
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };
}

// ─── refresh ────────────────────────────────────────────────────────────────

export interface XaiRefreshedTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
  token_type: string;
  last_refresh: string;
}

/** Exchange a refresh_token for a fresh access_token (+ rotated refresh_token).
 *
 *  Mirror of `refresh_xai_oauth_pure` (auth.py:3087–3160). Public client +
 *  PKCE: NO client_secret. The token_endpoint is re-validated on the hot
 *  path here in case the caller passed a cached endpoint that's been
 *  tampered with on disk; trust nothing without re-checking the host pin.
 *
 *  Throws XaiAuthError with reloginRequired=true only on 400/401/403,
 *  matching Hermes's heuristic — transient 5xx or network errors should
 *  retry, not re-login.
 */
export async function refreshXaiTokens(params: {
  refreshToken: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
}): Promise<XaiRefreshedTokens> {
  if (!params.refreshToken || !params.refreshToken.trim()) {
    throw new XaiAuthError(
      "xAI OAuth is missing refresh_token. Re-authenticate with `subctl auth xai-oauth <alias>`.",
      "xai_auth_missing_refresh_token",
      true,
    );
  }
  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? 20_000;

  let endpoint = params.tokenEndpoint?.trim();
  if (!endpoint) {
    const discovery = await discoverXaiOauthEndpoints({
      timeoutMs,
      fetchFn,
    });
    endpoint = discovery.token_endpoint;
  } else {
    // Cached/passed endpoint: still validate before posting credentials to it.
    validateXaiOauthEndpoint(endpoint, "token_endpoint");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: params.refreshToken,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new XaiAuthError(
      `xAI token refresh failed: ${(err as Error).message ?? String(err)}`,
      "xai_refresh_failed",
    );
  }
  clearTimeout(timer);

  if (response.status !== 200) {
    const detail = (await response.text().catch(() => "")).trim();
    const reloginRequired =
      response.status === 400 || response.status === 401 || response.status === 403;
    throw new XaiAuthError(
      `xAI token refresh failed.${detail ? ` Response: ${detail}` : ""}`,
      "xai_refresh_failed",
      reloginRequired,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new XaiAuthError(
      `xAI token refresh returned invalid JSON: ${(err as Error).message ?? String(err)}`,
      "xai_refresh_invalid_json",
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new XaiAuthError(
      "xAI token refresh response was not a JSON object.",
      "xai_refresh_invalid_response",
      true,
    );
  }
  const body = payload as Record<string, unknown>;
  const refreshedAccess = typeof body.access_token === "string"
    ? body.access_token.trim()
    : "";
  if (!refreshedAccess) {
    throw new XaiAuthError(
      "xAI token refresh response was missing access_token.",
      "xai_refresh_missing_access_token",
      true,
    );
  }
  const rotatedRefresh = typeof body.refresh_token === "string" && body.refresh_token.trim()
    ? body.refresh_token.trim()
    : params.refreshToken;
  const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
  const tokenType = typeof body.token_type === "string" && body.token_type.trim()
    ? body.token_type.trim()
    : "Bearer";
  const expiresIn = typeof body.expires_in === "number"
    ? body.expires_in
    : typeof body.expires_in === "string" && /^\d+$/.test(body.expires_in.trim())
      ? parseInt(body.expires_in.trim(), 10)
      : undefined;
  return {
    access_token: refreshedAccess,
    refresh_token: rotatedRefresh,
    id_token: idToken || undefined,
    expires_in: expiresIn,
    token_type: tokenType,
    last_refresh: new Date().toISOString(),
  };
}

// ─── authorize URL builder ──────────────────────────────────────────────────

/** Build the authorize-URL the operator opens in their browser.
 *
 *  Mirror of `_xai_oauth_build_authorize_url` (auth.py:5286–5312). Two
 *  xAI-specific params are non-negotiable:
 *    - `plan=generic` — opts into xAI's generic OAuth tier; without it,
 *      `accounts.x.ai` rejects loopback OAuth from non-allowlisted
 *      clients (the Grok-CLI client_id we impersonate is not on their
 *      allowlist for the default tier).
 *    - `referrer=subctl` — best-effort attribution string in xAI server
 *      logs. We're identifying as subctl rather than impersonating
 *      hermes-agent's referrer.
 */
export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    state: params.state,
    nonce: params.nonce,
    plan: "generic",
    referrer: "subctl",
  });
  url.search = qs.toString();
  return url.toString();
}

// ─── loopback callback server ───────────────────────────────────────────────

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface RunningCallbackServer {
  server: Server;
  redirectUri: string;
  result: CallbackResult;
  /** Resolves when the callback page has been hit (success OR error). */
  waitForCallback: (timeoutMs: number) => Promise<CallbackResult>;
  shutdown: () => Promise<void>;
}

/** Bind a single-shot HTTP server on 127.0.0.1, preferring port 56121 and
 *  falling back to an OS-assigned port if EADDRINUSE.
 *
 *  Mirror of `_xai_start_callback_server` (auth.py:2151–2187) + the
 *  `_make_xai_callback_handler` body at 2097–2148. Returns a handle the
 *  caller drives via `waitForCallback` + `shutdown`. */
async function startCallbackServer(preferredPort: number = XAI_OAUTH_REDIRECT_PORT): Promise<RunningCallbackServer> {
  const result: CallbackResult = {};
  let resolveCallback: ((v: CallbackResult) => void) | undefined;

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    const allowOrigin = typeof origin === "string" && XAI_CALLBACK_ALLOWED_ORIGINS.has(origin)
      ? origin
      : undefined;

    const setCorsHeaders = () => {
      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      }
    };

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      setCorsHeaders();
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Method not allowed.");
      return;
    }

    const reqUrl = new URL(req.url ?? "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
    if (reqUrl.pathname !== XAI_OAUTH_REDIRECT_PATH) {
      res.statusCode = 404;
      res.end("Not found.");
      return;
    }

    const code = reqUrl.searchParams.get("code") ?? undefined;
    const state = reqUrl.searchParams.get("state") ?? undefined;
    const error = reqUrl.searchParams.get("error") ?? undefined;
    const errorDescription = reqUrl.searchParams.get("error_description") ?? undefined;

    result.code = code;
    result.state = state;
    result.error = error;
    result.error_description = errorDescription;

    res.statusCode = 200;
    setCorsHeaders();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const body = error
      ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
      : "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>";
    res.end(body);

    resolveCallback?.(result);
  };

  const server = createServer(onRequest);
  server.on("clientError", (_err, sock) => {
    try { sock.destroy(); } catch { /* ignore */ }
  });

  // Try the preferred port first. If it's busy (Hermes or a previous subctl
  // run is bound to 56121), fall back to OS-assigned via port=0.
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("server.address() returned unexpected value"));
        }
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST);
    });

  let actualPort: number;
  try {
    actualPort = await tryListen(preferredPort);
  } catch (firstErr) {
    try {
      actualPort = await tryListen(0);
    } catch (secondErr) {
      throw new XaiAuthError(
        `Could not bind xAI callback server on ${XAI_OAUTH_REDIRECT_HOST}:${preferredPort}: ` +
          `${(firstErr as Error).message}; fallback also failed: ${(secondErr as Error).message}`,
        "xai_callback_bind_failed",
      );
    }
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${actualPort}${XAI_OAUTH_REDIRECT_PATH}`;

  const waitForCallback = (timeoutMs: number): Promise<CallbackResult> =>
    new Promise((resolve, reject) => {
      resolveCallback = resolve;
      const timer = setTimeout(() => {
        resolveCallback = undefined;
        reject(new XaiAuthError(
          "xAI authorization timed out waiting for the local callback.",
          "xai_callback_timeout",
        ));
      }, timeoutMs);
      // If the callback already landed before waitForCallback was called
      // (effectively impossible because the handler doesn't fire until a
      // request hits us, but harmless to cover), short-circuit.
      if (result.code || result.error) {
        clearTimeout(timer);
        resolve(result);
      }
      // When the resolve fires from onRequest, clear the timer.
      const originalResolve = resolveCallback;
      resolveCallback = (v) => {
        clearTimeout(timer);
        originalResolve?.(v);
      };
    });

  const shutdown = (): Promise<void> =>
    new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

  return { server, redirectUri, result, waitForCallback, shutdown };
}

// ─── full loopback login orchestration ──────────────────────────────────────

export interface LoopbackLoginOptions {
  /** Maximum time to wait for the operator to complete the consent screen.
   *  Defaults to 180s, matching Hermes's default. */
  callbackTimeoutMs?: number;
  /** Discovery + token-exchange request timeout. Defaults to 20s. */
  requestTimeoutMs?: number;
  /** Called once with the authorize URL so the caller can show it (or open
   *  a browser). The orchestrator/CLI uses this to print the URL; the
   *  dashboard SSE flow uses it to push the URL to the operator's modal. */
  onAuthorizeUrl: (params: { authorizeUrl: string; redirectUri: string }) => Promise<void> | void;
  /** Override for tests — never used in production. */
  fetchFn?: FetchFn;
  /** Override the bound port (tests use 0; production uses the default). */
  preferredPort?: number;
}

export interface LoopbackLoginResult {
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in?: number;
    token_type: string;
  };
  discovery: XaiOauthDiscovery;
  redirect_uri: string;
  base_url: string;
  last_refresh: string;
  source: "oauth-loopback";
}

/** End-to-end PKCE-loopback login: discover → bind callback → authorize →
 *  wait for code → exchange → return tokens.
 *
 *  Mirror of `_xai_oauth_loopback_login` (auth.py:5315–5469).
 *  Persisting the returned tokens to disk (atomicWriteAuthFile) is the
 *  caller's job — this function is pure-IO-only, no auth.json writes. */
export async function loopbackLogin(opts: LoopbackLoginOptions): Promise<LoopbackLoginResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  const callbackTimeoutMs = opts.callbackTimeoutMs ?? 180_000;

  const discovery = await discoverXaiOauthEndpoints({ timeoutMs: requestTimeoutMs, fetchFn });

  const callbackServer = await startCallbackServer(opts.preferredPort ?? XAI_OAUTH_REDIRECT_PORT);
  try {
    validateLoopbackRedirectUri(callbackServer.redirectUri);

    const codeVerifier = pkceCodeVerifier();
    const codeChallenge = pkceCodeChallenge(codeVerifier);
    const state = uuidHex();
    const nonce = uuidHex();

    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      redirectUri: callbackServer.redirectUri,
      codeChallenge,
      state,
      nonce,
    });

    await opts.onAuthorizeUrl({
      authorizeUrl,
      redirectUri: callbackServer.redirectUri,
    });

    const callback = await callbackServer.waitForCallback(callbackTimeoutMs);

    if (callback.error) {
      const detail = callback.error_description || callback.error;
      throw new XaiAuthError(
        `xAI authorization failed: ${detail}`,
        "xai_authorization_failed",
      );
    }
    if (callback.state !== state) {
      throw new XaiAuthError(
        "xAI authorization failed: state mismatch.",
        "xai_state_mismatch",
      );
    }
    const code = (callback.code ?? "").trim();
    if (!code) {
      throw new XaiAuthError(
        "xAI authorization failed: missing authorization code.",
        "xai_code_missing",
      );
    }

    // Exchange the authorization code for tokens.
    const exchangeTimeoutMs = Math.max(20_000, requestTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), exchangeTimeoutMs);
    let response: Response;
    try {
      response = await fetchFn(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackServer.redirectUri,
          client_id: XAI_OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new XaiAuthError(
        `xAI token exchange failed: ${(err as Error).message ?? String(err)}`,
        "xai_token_exchange_failed",
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 200) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new XaiAuthError(
        `xAI token exchange failed.${detail ? ` Response: ${detail}` : ""}`,
        "xai_token_exchange_failed",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new XaiAuthError(
        `xAI token exchange returned invalid JSON: ${(err as Error).message ?? String(err)}`,
        "xai_token_exchange_invalid",
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new XaiAuthError(
        "xAI token exchange response was not a JSON object.",
        "xai_token_exchange_invalid",
      );
    }
    const body = payload as Record<string, unknown>;
    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
    if (!accessToken) {
      throw new XaiAuthError(
        "xAI token exchange did not return an access_token.",
        "xai_token_exchange_invalid",
      );
    }
    if (!refreshToken) {
      throw new XaiAuthError(
        "xAI token exchange did not return a refresh_token.",
        "xai_token_exchange_invalid",
      );
    }
    const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
    const expiresIn = typeof body.expires_in === "number"
      ? body.expires_in
      : typeof body.expires_in === "string" && /^\d+$/.test(body.expires_in.trim())
        ? parseInt(body.expires_in.trim(), 10)
        : undefined;
    const tokenType = typeof body.token_type === "string" && body.token_type.trim()
      ? body.token_type.trim()
      : "Bearer";

    const baseUrl =
      (process.env.SUBCTL_XAI_BASE_URL ?? "").trim().replace(/\/+$/, "") ||
      (process.env.XAI_BASE_URL ?? "").trim().replace(/\/+$/, "") ||
      XAI_OAUTH_BASE_URL;

    return {
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken || undefined,
        expires_in: expiresIn,
        token_type: tokenType,
      },
      discovery,
      redirect_uri: callbackServer.redirectUri,
      base_url: baseUrl,
      last_refresh: new Date().toISOString(),
      source: "oauth-loopback",
    };
  } finally {
    await callbackServer.shutdown();
  }
}

// ─── high-level login + persist ─────────────────────────────────────────────

export interface CompleteXaiOauthLoginOptions extends LoopbackLoginOptions {
  /** Where to write the auth.json. Caller passes the absolute path — typically
   *  `~/.config/subctl/master/oauth/xai-oauth.json` (or under the alias's
   *  configDir if subctl ever adds per-account routing for xAI). */
  authJsonPath: string;
  /** Optional alias label baked into the file for provenance. */
  alias?: string;
}

export interface CompletedXaiOauthLogin {
  authPath: string;
  base_url: string;
  last_refresh: string;
}

/** Full PKCE-loopback login + atomic-write of auth.json. The on-disk shape
 *  mirrors Hermes's `_save_xai_oauth_tokens` (auth.py:2956–2976) so a
 *  future migration in either direction is a straight JSON copy. */
export async function completeXaiOauthLogin(
  opts: CompleteXaiOauthLoginOptions,
): Promise<CompletedXaiOauthLogin> {
  const result = await loopbackLogin(opts);
  const authJson = {
    tokens: result.tokens,
    last_refresh: result.last_refresh,
    discovery: result.discovery,
    redirect_uri: result.redirect_uri,
    auth_mode: "oauth_pkce",
    _subctl: {
      alias: opts.alias ?? null,
      minted_by: "subctl auth xai-oauth",
      minted_at: new Date().toISOString(),
    },
  };
  atomicWriteAuthFile(opts.authJsonPath, authJson);
  return {
    authPath: opts.authJsonPath,
    base_url: result.base_url,
    last_refresh: result.last_refresh,
  };
}

// ─── re-exports (Phase B will import these) ─────────────────────────────────

export { atomicWriteAuthFile, isAccessTokenExpiring };
