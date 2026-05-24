// components/master/mcp/auth.ts
//
// MCP-Expose (#24, wave 1) — bearer-token + caller_id verification for the
// in-process MCP server. Every authenticated request must carry BOTH:
//
//   1. `Authorization: Bearer <token>` — matched against
//      secrets.json#subctl_mcp_token (constant-time compare). When the
//      secret is absent the master never instantiates the MCP server in
//      the first place; this module's expected-token argument is always
//      non-empty at call-time.
//
//   2. `X-Caller-Id: <id>` — identifies the upstream caller for
//      provenance (e.g. "claude-desktop", "argentos",
//      "orch-claude-code-<session>"). Constrained to a conservative
//      character set so it threads safely into decisions.jsonl rows.
//
// This module deliberately knows NOTHING about MCP protocol, transports,
// or HTTP servers. It exports pure functions over `Request` so the
// handshake test can exercise it without spinning up Bun.serve.
//
// Failure modes are encoded in a Result<T> shape — callers (HTTP route
// glue + tests) match on the discriminator and choose the HTTP status.
// Nothing throws in this module.

const BEARER_HEADER = "authorization";
const CALLER_ID_HEADER = "x-caller-id";

/**
 * Acceptable `X-Caller-Id` characters. Allow alnum + a small set of
 * separators commonly seen in upstream identifiers
 * ("claude-desktop", "orch-claude-code-abc123", "argentos.v2.7"). No
 * spaces, no quotes, no control bytes — these would be footguns when
 * the id later lands in a JSONL row's `by` field.
 */
const CALLER_ID_RE = /^[A-Za-z0-9._:\-]{1,128}$/;

export interface AuthSuccess {
  ok: true;
  /** The validated, non-empty caller_id verbatim. */
  caller_id: string;
}

export interface AuthFailure {
  ok: false;
  /** HTTP status the caller should return. 400 (bad request) or 401 (auth). */
  status: 400 | 401;
  /** Machine-readable reason — also written to the response body. */
  error:
    | "missing_authorization"
    | "invalid_authorization_scheme"
    | "invalid_token"
    | "missing_caller_id"
    | "invalid_caller_id";
}

export type AuthResult = AuthSuccess | AuthFailure;

/**
 * Constant-time string comparison. JavaScript's `===` short-circuits on
 * first difference, which leaks length + content via timing. Both
 * inputs are converted to UTF-8 bytes first; mismatched lengths still
 * iterate up to the longer side (XOR'd against `1`) so the wall-clock
 * branch is uniform.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const len = Math.max(ea.length, eb.length);
  let mismatch = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) {
    const av = i < ea.length ? ea[i]! : 0;
    const bv = i < eb.length ? eb[i]! : 0;
    mismatch |= av ^ bv;
  }
  return mismatch === 0;
}

/**
 * Extract the bearer token from an `Authorization` header value. Returns
 * `null` when the header is missing or not a `Bearer …` form. Tolerates
 * extra whitespace and case-variant scheme ("bearer" / "BEARER").
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (!m) return null;
  const token = m[1]!.trim();
  return token.length > 0 ? token : null;
}

/**
 * Validate a caller_id against the character set + length envelope.
 * Returns the verbatim string on success, or null on rejection.
 */
export function validateCallerId(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return CALLER_ID_RE.test(value) ? value : null;
}

export interface AuthenticateOptions {
  /** Expected bearer token. Caller has already verified this is non-empty. */
  expectedToken: string;
}

/**
 * Validate that a `Request` carries the right bearer token and a
 * well-formed caller_id. The check order is:
 *
 *   1. Authorization header present AND Bearer scheme → else 401.
 *   2. Token matches expected (constant-time) → else 401.
 *   3. X-Caller-Id present → else 400.
 *   4. X-Caller-Id matches allowed character set → else 400.
 *
 * Step 3/4 returns 400 because the operator's MCP token is correct;
 * the caller violated the calling contract, not the security boundary.
 *
 * NOTE: This function does not read the request body and does not
 * consume any streams.
 */
export function authenticateRequest(
  req: Request,
  opts: AuthenticateOptions,
): AuthResult {
  const authHeader = req.headers.get(BEARER_HEADER);
  if (!authHeader || !authHeader.trim()) {
    return { ok: false, status: 401, error: "missing_authorization" };
  }
  const token = parseBearer(authHeader);
  if (!token) {
    return { ok: false, status: 401, error: "invalid_authorization_scheme" };
  }
  if (!constantTimeEquals(token, opts.expectedToken)) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  const rawCaller = req.headers.get(CALLER_ID_HEADER);
  if (!rawCaller || !rawCaller.trim()) {
    return { ok: false, status: 400, error: "missing_caller_id" };
  }
  const caller = validateCallerId(rawCaller);
  if (!caller) {
    return { ok: false, status: 400, error: "invalid_caller_id" };
  }
  return { ok: true, caller_id: caller };
}

/** Build the JSON body for an auth-failure response. */
export function authErrorResponseBody(failure: AuthFailure): {
  ok: false;
  error: AuthFailure["error"];
} {
  return { ok: false, error: failure.error };
}

export const HEADERS = {
  bearer: BEARER_HEADER,
  callerId: CALLER_ID_HEADER,
} as const;
