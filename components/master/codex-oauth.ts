// components/master/codex-oauth.ts
//
// v2.8.9 — first-class OpenAI Codex OAuth for subctl.
//
// This module ports the device-code flow from OpenClaw's
// `extensions/openai/openai-codex-device-code.ts` (TypeScript) and the
// refresh-on-near-expiry pattern from Hermes Agent's
// `hermes_cli/auth.py` (Python) into a single self-contained module that
// subctl owns. Both upstreams use OpenAI's public Codex CLI OAuth client
// id (`app_EMoamEEZ73f0CkXaXp7hrann`) against `https://auth.openai.com`.
// We use the same client id; subctl identifies itself via `originator:
// subctl` + `User-Agent: subctl/<version>` headers, matching OpenClaw's
// pattern (their headers say `originator: openclaw`).
//
// What this module DOES:
//   - device-code login flow: requestDeviceCode → poll → exchange
//   - refresh-on-near-expiry: POST /oauth/token grant_type=refresh_token
//   - atomic auth.json write (Hermes pattern: O_EXCL + 0o600)
//   - JWT expiry inspection (re-uses decodeJwtPayload from openai-codex-auth.ts)
//
// What this module deliberately does NOT do:
//   - browser-redirect PKCE OAuth (OpenClaw has a second path,
//     `loginOpenAICodexOAuth`, for environments where device-code is
//     disabled; revisit if subctl ever sees that 404). The 404 response
//     here mirrors OpenClaw's error message so the operator gets the
//     same "use ChatGPT OAuth instead" hint.
//   - plugin SDK / pluggable storage backends — auth.json on disk in the
//     account's configDir, period. Subctl isn't yet a plugin platform.
//   - account-id extraction — pi-ai still decodes the JWT and pulls
//     `chatgpt_account_id` for the `chatgpt-account-id` header. We just
//     hand pi-ai the access_token; pi-ai does the rest.

import { existsSync, readFileSync } from "node:fs";
import { openSync, writeSync, closeSync, renameSync, unlinkSync, mkdirSync, constants as fsConstants } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── constants ──────────────────────────────────────────────────────────────

export const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;

// Polling tuning — mirrors OpenClaw's exact values. Don't tune these without
// understanding why (Peter's at OpenAI; these reflect server-side reality).
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
export const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
export const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;

// Refresh threshold: refresh in the background when access_token is within
// this many seconds of expiry. 5 minutes is the same skew Hermes defaults to.
export const REFRESH_SKEW_SECONDS = 300;

// ─── header helpers ─────────────────────────────────────────────────────────

/** Compute the subctl version header value. Reads VERSION at the repo root
 *  the same way server.ts does — kept local here so this module has no
 *  cross-dependency on master/server.ts. */
function readSubctlVersion(): string {
  try {
    // codex-oauth.ts lives in components/master/ — repo root is two parents up.
    const versionPath = join(import.meta.dir, "..", "..", "VERSION");
    return readFileSync(versionPath, "utf8").trim();
  } catch {
    return "0.0.0-dev";
  }
}

/** Build the standard request headers subctl sends to OpenAI's auth backend.
 *  Mirrors OpenClaw's pattern (originator + User-Agent + version) so we
 *  identify cleanly without impersonating another tool. */
export function buildAuthHeaders(contentType: string): Record<string, string> {
  const version = readSubctlVersion();
  return {
    "Content-Type": contentType,
    originator: "subctl",
    "User-Agent": `subctl/${version}`,
    version,
  };
}

// ─── error sanitization (verbatim from OpenClaw) ────────────────────────────

/** Strip ANSI CSI escapes, OSC8 hyperlinks, and C0/C1 control chars from
 *  text the OpenAI auth backend returns in error bodies. Some failure modes
 *  include terminal control sequences that would corrupt master.log. */
function sanitizeErrorText(value: string): string {
  const esc = String.fromCharCode(0x1b);
  const ansiCsiRegex = new RegExp(`${esc}\\[[\\u0020-\\u003f]*[\\u0040-\\u007e]`, "g");
  const osc8Regex = new RegExp(`${esc}\\]8;;.*?${esc}\\\\|${esc}\\]8;;${esc}\\\\`, "g");
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g");
  return value
    .replace(osc8Regex, "")
    .replace(ansiCsiRegex, "")
    .replace(controlCharsRegex, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function formatAuthError(params: {
  prefix: string;
  status: number;
  bodyText: string;
}): string {
  const body = parseJsonObject(params.bodyText);
  const error = trimNonEmpty(body?.error);
  const description = trimNonEmpty(body?.error_description);
  const safeError = error ? sanitizeErrorText(error) : undefined;
  const safeDescription = description ? sanitizeErrorText(description) : undefined;
  if (safeError && safeDescription) {
    return `${params.prefix}: ${safeError} (${safeDescription})`;
  }
  if (safeError) {
    return `${params.prefix}: ${safeError}`;
  }
  const bodyText = sanitizeErrorText(params.bodyText);
  return bodyText
    ? `${params.prefix}: HTTP ${params.status} ${bodyText}`
    : `${params.prefix}: HTTP ${params.status}`;
}

// ─── atomic file write (Hermes pattern) ─────────────────────────────────────

/** Write JSON contents to `path` atomically with restrictive perms (0o600).
 *  Uses O_EXCL on a randomly-suffixed temp file so concurrent writers can't
 *  collide, then renames into place (atomic on same filesystem). The temp
 *  file is created with 0o600 directly — no TOCTOU window where the secret
 *  is briefly readable by group/world. Mirrors Hermes's _save_codex_tokens. */
export function atomicWriteAuthFile(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const contents = JSON.stringify(data, null, 2);
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = join(dir, `${basename(path)}.tmp.${process.pid}.${suffix}`);
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    writeSync(fd, contents);
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ─── JWT helpers ────────────────────────────────────────────────────────────

interface DecodedJwt {
  exp?: number;
  iat?: number;
}

/** Decode the payload section of a JWT. Returns null on any failure
 *  (unsigned tokens, wrong segment count, malformed base64, non-JSON payload).
 *  We only need `exp` here; the existing decodeJwtPayload in
 *  openai-codex-auth.ts pulls more fields for diagnostics. */
function decodeJwtExp(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(json) as DecodedJwt;
    return typeof obj.exp === "number" ? obj.exp : undefined;
  } catch {
    return undefined;
  }
}

/** True iff the access_token's `exp` claim is within `skewSeconds` of now.
 *  Tokens that don't have an exp claim (malformed, opaque) return false
 *  here — the caller should treat absence as "don't speculatively refresh,
 *  let the 401 path handle it". */
export function isAccessTokenExpiring(
  accessToken: string,
  skewSeconds: number = REFRESH_SKEW_SECONDS,
  nowSeconds?: number,
): boolean {
  const exp = decodeJwtExp(accessToken);
  if (typeof exp !== "number") return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return exp <= now + skewSeconds;
}

// ─── refresh (POST /oauth/token grant_type=refresh_token) ───────────────────

export interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_in_ms?: number;
}

/** Exchange a refresh_token for a new access_token (+ rotated refresh_token).
 *  Throws AuthError-shaped Error on any failure with a sanitized message.
 *  Successful return guarantees both tokens are non-empty strings. */
export async function refreshCodexTokens(refreshToken: string): Promise<RefreshedTokens> {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: buildAuthHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatAuthError({
        prefix: "OpenAI Codex token refresh failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const access = trimNonEmpty(body?.access_token);
  // Refresh rotates: prefer the new refresh_token if returned, else keep the
  // one we sent. Both behaviours are RFC-6749 compliant; OpenAI rotates today.
  const refresh = trimNonEmpty(body?.refresh_token) ?? refreshToken;
  if (!access) {
    throw new Error("OpenAI Codex token refresh succeeded but returned no access_token");
  }
  const expiresInSeconds =
    typeof body?.expires_in === "number"
      ? body.expires_in as number
      : typeof body?.expires_in === "string" && /^\d+$/.test((body.expires_in as string).trim())
        ? parseInt((body.expires_in as string).trim(), 10)
        : undefined;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in_ms: typeof expiresInSeconds === "number" ? expiresInSeconds * 1000 : undefined,
  };
}

// ─── device-code login flow (three-step) ────────────────────────────────────

export interface DeviceCodePrompt {
  /** URL the operator opens in their browser. */
  verificationUrl: string;
  /** Short code shown on screen, typed into the verification page. */
  userCode: string;
  /** How long the prompt is valid in milliseconds. */
  expiresInMs: number;
}

export interface DeviceCodeCredentials {
  access_token: string;
  refresh_token: string;
  /** Absolute unix-ms when the access_token expires. */
  expires_at_ms: number;
}

interface RequestedDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}

interface DeviceCodeAuthorization {
  authorizationCode: string;
  codeVerifier: string;
}

function clampPollDelay(intervalMs: number, deadlineMs: number): number {
  const remaining = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, DEVICE_CODE_MIN_INTERVAL_MS), remaining);
}

async function requestDeviceCode(): Promise<RequestedDeviceCode> {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: buildAuthHeaders("application/json"),
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    // OpenClaw's 404 handling — server side knows about a non-device-code
    // OAuth path. We don't implement it yet; surface the same hint so the
    // operator can decide whether to escalate.
    if (response.status === 404) {
      throw new Error(
        "OpenAI Codex device code login is not enabled for this server. " +
          "Use ChatGPT OAuth instead (subctl doesn't yet implement that fallback).",
      );
    }
    throw new Error(
      formatAuthError({
        prefix: "OpenAI device code request failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const deviceAuthId = trimNonEmpty(body?.device_auth_id);
  const userCode = trimNonEmpty(body?.user_code) ?? trimNonEmpty(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }
  const intervalRaw = body?.interval;
  let intervalMs = DEVICE_CODE_DEFAULT_INTERVAL_MS;
  if (typeof intervalRaw === "number" && Number.isFinite(intervalRaw) && intervalRaw > 0) {
    intervalMs = Math.trunc(intervalRaw * 1000);
  } else if (typeof intervalRaw === "string" && /^\d+$/.test(intervalRaw.trim())) {
    intervalMs = parseInt(intervalRaw.trim(), 10) * 1000;
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalMs,
  };
}

async function pollDeviceCode(params: {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}): Promise<DeviceCodeAuthorization> {
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: buildAuthHeaders("application/json"),
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
    });
    const bodyText = await response.text();
    if (response.ok) {
      const body = parseJsonObject(bodyText);
      const authorizationCode = trimNonEmpty(body?.authorization_code);
      const codeVerifier = trimNonEmpty(body?.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("OpenAI device authorization response was missing the exchange code.");
      }
      return { authorizationCode, codeVerifier };
    }
    // 403/404 = user hasn't completed the prompt yet; keep polling.
    if (response.status === 403 || response.status === 404) {
      await new Promise((r) => setTimeout(r, clampPollDelay(params.intervalMs, deadline)));
      continue;
    }
    throw new Error(
      formatAuthError({
        prefix: "OpenAI device authorization failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  throw new Error("OpenAI device authorization timed out after 15 minutes.");
}

async function exchangeDeviceCode(params: {
  authorizationCode: string;
  codeVerifier: string;
}): Promise<DeviceCodeCredentials> {
  const response = await fetch(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: buildAuthHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatAuthError({
        prefix: "OpenAI device token exchange failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const access = trimNonEmpty(body?.access_token);
  const refresh = trimNonEmpty(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange succeeded but did not return both access and refresh tokens.");
  }
  const expiresInSeconds =
    typeof body?.expires_in === "number"
      ? body.expires_in as number
      : typeof body?.expires_in === "string" && /^\d+$/.test((body.expires_in as string).trim())
        ? parseInt((body.expires_in as string).trim(), 10)
        : undefined;
  const expiresAtMs =
    typeof expiresInSeconds === "number"
      ? Date.now() + expiresInSeconds * 1000
      : (() => {
          // Fall back to JWT exp claim when expires_in is missing.
          const exp = decodeJwtExp(access);
          return typeof exp === "number" ? exp * 1000 : Date.now();
        })();
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at_ms: expiresAtMs,
  };
}

export interface DeviceCodeLoginOptions {
  /** Called once after the device code is requested. Receives the URL and
   *  user code so the caller can show them to the operator (console print,
   *  dashboard banner, QR code, etc.). Must not throw. */
  onVerification: (prompt: DeviceCodePrompt) => Promise<void> | void;
  /** Optional progress callback for log/CLI prints. */
  onProgress?: (message: string) => void;
}

/** Run the full device-code login: request → wait for browser confirm →
 *  exchange. Returns the freshly-minted credentials. Caller is responsible
 *  for persisting them (use atomicWriteAuthFile). */
export async function loginCodexDeviceCode(
  opts: DeviceCodeLoginOptions,
): Promise<DeviceCodeCredentials> {
  opts.onProgress?.("Requesting device code…");
  const deviceCode = await requestDeviceCode();
  await opts.onVerification({
    verificationUrl: deviceCode.verificationUrl,
    userCode: deviceCode.userCode,
    expiresInMs: DEVICE_CODE_TIMEOUT_MS,
  });
  opts.onProgress?.("Waiting for device authorization…");
  const authorization = await pollDeviceCode({
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    intervalMs: deviceCode.intervalMs,
  });
  opts.onProgress?.("Exchanging device code…");
  return await exchangeDeviceCode(authorization);
}
