// components/evy/xai-oauth-auth.ts
//
// v2.x — pi-ai resolver shim for xAI Grok OAuth (SuperGrok Subscription).
//
// Companion to xai-oauth.ts (which owns the discovery/refresh/login plumbing).
// This module is the surface server.ts wires into pi-agent-core's getApiKey
// hook. Because pi-ai's getApiKey is synchronous, the returned function
// MUST be sync — but a refresh-on-near-expiry has to be async. We square
// the circle the same way openai-codex-auth.ts does:
//
//   - return the still-valid current token RIGHT NOW (sync)
//   - kick a background refresh as a side effect when the token is within
//     XAI_REFRESH_SKEW_SECONDS (120s) of `exp`
//   - dedup background refreshes via a module-level in-flight Map keyed
//     by auth.json absolute path, so N concurrent chat turns inside the
//     skew window all share ONE refresh fetch
//   - the next chat turn after the refresh lands picks up the new token
//     off disk; the operator never sees a stale-401 round-trip
//
// Storage. Subctl owns its own auth.json under either:
//   1. `<accounts.conf row's configDir>/auth.json` when a row with
//      provider="xai-oauth" exists, OR
//   2. `~/.config/subctl/evy/oauth/xai-oauth/auth.json` as the fallback.
// Do NOT read Hermes's `~/.hermes/auth.json` from here — that bypasses
// Hermes's _auth_store_lock and races with concurrent refreshes.
//
// On-disk shape matches Hermes's _save_xai_oauth_tokens (auth.py:2956–2976),
// so a future operator-driven copy from one project to the other is a
// straight `cp`. See completeXaiOauthLogin in xai-oauth.ts for the writer.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadAccountsConf } from "./openai-codex-auth.ts";
import {
  atomicWriteAuthFile,
  isAccessTokenExpiring,
  refreshXaiTokens,
  validateXaiOauthEndpoint,
  XaiAuthError,
  XAI_OAUTH_BASE_URL,
  XAI_REFRESH_SKEW_SECONDS,
  type FetchFn,
  type XaiRefreshedTokens,
} from "./xai-oauth.ts";

// ─── fallback path resolution ───────────────────────────────────────────────

const FALLBACK_XAI_OAUTH_HOME = join(
  homedir(),
  ".config",
  "subctl",
  "master",
  "oauth",
  "xai-oauth",
);

/** Compute the absolute path to the xai-oauth auth.json subctl should read.
 *
 *  Resolution order, matching the codex pattern:
 *    1. First accounts.conf row with `provider === "xai-oauth"` wins; its
 *       `configDir` field is the directory containing auth.json.
 *    2. Fallback: `~/.config/subctl/evy/oauth/xai-oauth/auth.json`.
 *
 *  Returns null only if neither path can be derived (no accounts.conf row
 *  AND the fallback dir does not exist). The caller treats null as
 *  "operator hasn't logged in yet — run `subctl auth xai-oauth <alias>`".
 */
export function resolveActiveXaiOauthAuthPath(): string | null {
  const rows = loadAccountsConf();
  const match = rows.find((r) => r.provider === "xai-oauth");
  if (match) return join(match.configDir, "auth.json");
  // Fallback exists if the operator's run a CLI login before (the
  // completeXaiOauthLogin writer creates the parent dir on first write).
  if (existsSync(FALLBACK_XAI_OAUTH_HOME)) {
    return join(FALLBACK_XAI_OAUTH_HOME, "auth.json");
  }
  return null;
}

/** Same as resolveActiveXaiOauthAuthPath but never returns null — it
 *  always returns the fallback path even when the file doesn't exist yet.
 *  The CLI login flow uses this to know WHERE to write a new file. */
export function resolveXaiOauthWritePath(): string {
  const rows = loadAccountsConf();
  const match = rows.find((r) => r.provider === "xai-oauth");
  if (match) return join(match.configDir, "auth.json");
  return join(FALLBACK_XAI_OAUTH_HOME, "auth.json");
}

// ─── auth.json shape (mirror of Hermes _save_xai_oauth_tokens) ──────────────

export interface XaiOauthTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface XaiOauthAuthJson {
  tokens?: XaiOauthTokens;
  last_refresh?: string;
  auth_mode?: string;
  discovery?: {
    authorization_endpoint?: string;
    token_endpoint?: string;
  };
  redirect_uri?: string;
  _subctl?: {
    alias?: string | null;
    minted_by?: string;
    minted_at?: string;
  };
}

/** Read + JSON.parse `<path>`. Returns null on missing, unreadable, or
 *  invalid JSON. Never throws — failure modes are reported through the
 *  caller-visible log lines in getXaiOauthAccessToken. */
export function readXaiOauthAuth(path: string): XaiOauthAuthJson | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `[xai-oauth-auth] auth.json read failed at ${path}: ${(err as Error).message}`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as XaiOauthAuthJson;
    }
    return null;
  } catch (err) {
    console.error(
      `[xai-oauth-auth] auth.json parse failed at ${path}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── in-flight refresh dedup ────────────────────────────────────────────────

/** Module-scope map of in-flight refreshes, keyed by auth.json absolute path.
 *  N concurrent chat turns inside the near-expiry window each call
 *  getXaiOauthAccessToken; only the first kicks an actual refresh fetch.
 *  Cleared in the `finally` of the refresh job. */
const _inFlightRefresh: Map<string, Promise<void>> = new Map();

/** Test-only escape hatch. Forget any in-flight refresh state so a new
 *  test case starts from a clean slate. NEVER call from production code. */
export function _clearInFlightRefreshForTesting(): void {
  _inFlightRefresh.clear();
}

/** Test-only accessor: is there a refresh in-flight for `authJsonPath`? */
export function _hasInFlightRefreshForTesting(authJsonPath: string): boolean {
  return _inFlightRefresh.has(authJsonPath);
}

// ─── main resolver (the function server.ts will call sync from getApiKey) ───

export interface ResolveOptions {
  /** Override path for tests. Production code lets the resolver decide. */
  authJsonPath?: string;
  /** Pretend `now` is this epoch-seconds (for tests). */
  now?: number;
  /** Override the refresh function (for tests). Production hits xai-oauth.ts
   *  refreshXaiTokens directly. */
  refreshFn?: (params: {
    refreshToken: string;
    tokenEndpoint?: string;
    fetchFn?: FetchFn;
  }) => Promise<XaiRefreshedTokens>;
  /** Optional fetch override piped through to refreshFn. */
  fetchFn?: FetchFn;
  /** Skew window override. Production uses XAI_REFRESH_SKEW_SECONDS=120. */
  skewSeconds?: number;
}

/** Resolve the OAuth access_token to hand pi-ai for the next Grok API call.
 *
 *  Returns undefined (NOT a sentinel string) when:
 *    - no xai-oauth account is configured AND fallback file is missing
 *    - auth.json is missing / malformed / has no tokens.access_token
 *    - the access_token JWT is past its `exp` claim
 *
 *  Logs loudly in every failure branch so evy.log shows WHY the chat
 *  turn is about to fail before pi-ai itself throws. Log strings echo
 *  Hermes's error-message conventions where practical — operators
 *  grepping both logs see the same string for the same condition.
 *
 *  Side effects (sync return, async refresh):
 *    - near-expiry (within skewSeconds of exp): kicks ONE background
 *      refresh per authJsonPath; returns the still-valid current token
 *    - post-expiry with refresh_token: kicks ONE background refresh per
 *      authJsonPath; returns undefined so pi-ai surfaces a clear "no API
 *      key" — the operator's next message picks up the rotated token
 *    - post-expiry without refresh_token: returns undefined; only fix
 *      is `subctl auth xai-oauth <alias>` (no auto-recovery possible)
 */
export function getXaiOauthAccessToken(opts: ResolveOptions = {}): string | undefined {
  const authJsonPath = opts.authJsonPath ?? resolveActiveXaiOauthAuthPath();
  if (!authJsonPath) {
    console.error(
      "[xai-oauth-auth] no xai-oauth account configured in accounts.conf and " +
        `${FALLBACK_XAI_OAUTH_HOME}/auth.json does not exist — chat turn will ` +
        "fail until the operator runs `subctl auth xai-oauth <alias>`",
    );
    return undefined;
  }
  const auth = readXaiOauthAuth(authJsonPath);
  if (!auth) {
    console.error(
      `[xai-oauth-auth] auth.json missing or unreadable at ${authJsonPath} — ` +
        "operator may need to re-run `subctl auth xai-oauth <alias>`",
    );
    return undefined;
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object") {
    console.error(
      `[xai-oauth-auth] auth.json at ${authJsonPath} is missing tokens block ` +
        `(xai_auth_invalid_shape) — re-run \`subctl auth xai-oauth <alias>\``,
    );
    return undefined;
  }
  const accessToken = typeof tokens.access_token === "string"
    ? tokens.access_token.trim()
    : "";
  if (!accessToken) {
    console.error(
      `[xai-oauth-auth] auth.json at ${authJsonPath} has no tokens.access_token ` +
        `(xai_auth_missing_access_token) — re-run \`subctl auth xai-oauth <alias>\``,
    );
    return undefined;
  }
  const refreshToken = typeof tokens.refresh_token === "string"
    ? tokens.refresh_token.trim()
    : "";
  // Refresh_token absent is recoverable for the CURRENT turn (the access
  // token might still be valid) but blocks any auto-refresh later. Log
  // once, then proceed to expiry check.
  if (!refreshToken) {
    console.error(
      `[xai-oauth-auth] auth.json at ${authJsonPath} has no tokens.refresh_token ` +
        `(xai_auth_missing_refresh_token) — token cannot be auto-refreshed; ` +
        `re-run \`subctl auth xai-oauth <alias>\` before it expires`,
    );
  }

  const skewSeconds = opts.skewSeconds ?? XAI_REFRESH_SKEW_SECONDS;
  const nowSeconds = opts.now ?? Math.floor(Date.now() / 1000);
  // Use the shared JWT-exp inspector. Returns false on malformed/missing-exp
  // tokens — in that case we let the call through; the upstream API will
  // emit a clear 401 if the token is actually bad.
  const isPastExp = isAccessTokenExpiring(accessToken, 0, nowSeconds);
  const isNearExp = isAccessTokenExpiring(accessToken, skewSeconds, nowSeconds);

  if (isPastExp) {
    // Token is already expired. We can't use it for THIS turn. If we have a
    // refresh_token, kick a background refresh so the operator's NEXT chat
    // turn picks up a freshly-minted token without re-running login.
    if (refreshToken && !_inFlightRefresh.has(authJsonPath)) {
      console.error(
        `[xai-oauth-auth] access_token at ${authJsonPath} is EXPIRED — ` +
          "kicking background refresh; current turn fails, retry your next " +
          "message after a few seconds.",
      );
      _kickRefresh(authJsonPath, auth, refreshToken, opts);
    } else {
      console.error(
        `[xai-oauth-auth] access_token at ${authJsonPath} is EXPIRED and ` +
          `${refreshToken ? "refresh is already in flight" : "no refresh_token in auth.json"} — ` +
          "chat turn will fail until operator runs login.",
      );
    }
    return undefined;
  }

  if (isNearExp && refreshToken && !_inFlightRefresh.has(authJsonPath)) {
    // Within skew window. Return the still-valid current token NOW, kick
    // a refresh in the background so next turn picks up the rotated token.
    console.error(
      `[xai-oauth-auth] access_token at ${authJsonPath} is near expiry — ` +
        "kicking background refresh (current turn uses still-valid token)",
    );
    _kickRefresh(authJsonPath, auth, refreshToken, opts);
  }

  return accessToken;
}

// ─── background refresh helper ──────────────────────────────────────────────

function _kickRefresh(
  authJsonPath: string,
  currentAuth: XaiOauthAuthJson,
  refreshToken: string,
  opts: ResolveOptions,
): void {
  const cachedTokenEndpoint = (() => {
    const ep = currentAuth.discovery?.token_endpoint;
    if (typeof ep !== "string" || !ep.trim()) return undefined;
    // Re-validate the cached endpoint BEFORE handing it to the refresh
    // function. If auth.json was hand-edited or written by an older
    // subctl/Hermes, the cached endpoint might point off-origin; the
    // host-pin re-check stops that here, before refresh_token leaves
    // the process.
    try {
      validateXaiOauthEndpoint(ep.trim(), "token_endpoint");
      return ep.trim();
    } catch (err) {
      console.error(
        `[xai-oauth-auth] cached token_endpoint in ${authJsonPath} failed ` +
          `host-pin re-check: ${(err as Error).message} — falling back to ` +
          "fresh discovery for this refresh.",
      );
      return undefined;
    }
  })();

  const refreshFn = opts.refreshFn ?? refreshXaiTokens;
  const fetchFn = opts.fetchFn;

  const job = (async () => {
    try {
      const fresh = await refreshFn({
        refreshToken,
        tokenEndpoint: cachedTokenEndpoint,
        fetchFn,
      });
      // Read-modify-write to preserve any operator-added fields (alias,
      // minted_at, etc). Re-read from disk in case another process touched
      // the file (unlikely but cheap).
      const current = readXaiOauthAuth(authJsonPath) ?? ({} as XaiOauthAuthJson);
      const updated: XaiOauthAuthJson = {
        ...current,
        tokens: {
          ...(current.tokens ?? {}),
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
          id_token: fresh.id_token ?? current.tokens?.id_token,
          expires_in: fresh.expires_in ?? current.tokens?.expires_in,
          token_type: fresh.token_type ?? current.tokens?.token_type ?? "Bearer",
        },
        last_refresh: fresh.last_refresh,
        auth_mode: current.auth_mode ?? "oauth_pkce",
      };
      atomicWriteAuthFile(authJsonPath, updated);
      console.error(
        `[xai-oauth-auth] refresh succeeded for ${authJsonPath} — next turn uses new token`,
      );
    } catch (err) {
      const xaiErr = err instanceof XaiAuthError ? err : undefined;
      const code = xaiErr?.code ?? "unknown";
      const relogin = xaiErr?.reloginRequired ? " (operator must re-login)" : "";
      console.error(
        `[xai-oauth-auth] background refresh FAILED for ${authJsonPath} ` +
          `(${code})${relogin}: ${(err as Error).message ?? String(err)} — ` +
          "current token still valid until exp; operator may need to re-run " +
          "`subctl auth xai-oauth <alias>` if it actually expires",
      );
    } finally {
      _inFlightRefresh.delete(authJsonPath);
    }
  })();
  _inFlightRefresh.set(authJsonPath, job);
}

// ─── base URL helper (so server.ts can wire pi-ai consistently) ─────────────

/** Resolve the inference base URL for the xai-oauth provider. Env overrides
 *  match Hermes's `HERMES_XAI_BASE_URL` / `XAI_BASE_URL` (auth.py:3234–3236)
 *  plus a subctl-prefixed variant for namespace clarity. */
export function getXaiOauthBaseUrl(): string {
  const env = (process.env.SUBCTL_XAI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (env) return env;
  const generic = (process.env.XAI_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (generic) return generic;
  return XAI_OAUTH_BASE_URL;
}
