// components/evy/trust-marker.ts
//
// v2.7.20 — HMAC-authenticated trust marker (ADR 0011 Layer 1).
//
// THE PROBLEM IT FIXES
// ────────────────────
// v2.7.9 (ADR 0002) introduced a plaintext directive marker that the
// dashboard's /api/orchestration/<n>/msg route prepended to every
// supervisor message:
//
//   [subctl-master directive · phase=<phase> · ts:<iso>]
//
// It was correctly identified as gameable the same night it shipped. The
// osint-cve-monitor team lead refused master's directives despite the
// marker because — as it observed in its own captured reasoning — "the
// text content of a message can't authenticate the sender. Only the
// channel can." Anything that can write to the worker's tmux pane can
// forge the marker; the model has no way to tell forgeries from the
// real thing.
//
// THE FIX
// ───────
// Per-team shared secret. At spawn time `providers/claude/teams.sh`
// generates a 32-byte random secret, writes it to
// `~/.local/state/subctl/teams/<team_id>/hmac.secret` (chmod 600), and
// injects it into the worker's spawn-time system prompt as part of the
// subctl team contract. Anything outside those two locations — disk
// file (master can read) and worker system prompt (the worker's model
// can read) — cannot compute a valid HMAC.
//
// When master sends a directive, it computes
//
//   hmac = first 16 hex chars of HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body)
//
// and emits
//
//   [subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]
//
// The worker recomputes from its own copy of the secret and trusts the
// directive only if the values match. Old workers (spawned pre-v2.7.20)
// don't have the secret in their prompt; they continue to recognize the
// bracket structure as before and ignore the `hmac:` field as an
// unrecognized extension — see "Backward compatibility" below.
//
// HARD RULE — secret hygiene
// ──────────────────────────
// The secret value MUST NOT appear in logs, telemetry, audit lines, or
// stderr — anywhere outside the disk file and the spawn-time system
// prompt. If you find yourself adding a console.log here that would
// include `secret`, redact instead. Same rule as the LM Studio token.
//
// Backward compatibility (old workers spawned pre-v2.7.20)
// ────────────────────────────────────────────────────────
// The v2.7.9 worker contract teaches workers to recognize the
// `[subctl-master directive ...]` prefix structurally — it does not
// instruct them to reject markers with unknown extra fields. Pre-v2.7.20
// workers see the new `hmac:<...>` field at the end of the bracket
// header as an unrecognized but benign extension; they still recognize
// the directive as trusted by the channel marker. The protocol stays
// forward-compatible by extension. New workers (post-v2.7.20) get the
// hmac:<...> requirement baked into their contract and refuse markers
// without a valid mac.

import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── path resolution ─────────────────────────────────────────────────────
//
// Same convention as components/evy/tools/policy/snapshot.ts —
// SUBCTL_STATE_DIR env override wins, otherwise ~/.local/state/subctl.
// Tests inject a tmpdir-scoped path via _setStateDirForTesting().

let _stateDirOverride: string | null = null;

/** @internal — for tests only. Pass null to clear. */
export function _setStateDirForTesting(p: string | null): void {
  _stateDirOverride = p;
}

function resolveStateDir(): string {
  if (_stateDirOverride !== null) return _stateDirOverride;
  return process.env.SUBCTL_STATE_DIR ?? join(homedir(), ".local", "state", "subctl");
}

/**
 * Deterministic on-disk path for a team's HMAC secret. Constructable
 * without I/O so callers can decide whether to touch the disk.
 */
export function getSecretPath(teamId: string): string {
  return join(resolveStateDir(), "teams", teamId, "hmac.secret");
}

// ─── secret lifecycle ────────────────────────────────────────────────────

/** Generate a fresh 64-hex-char (32-byte) secret. Cryptographically random. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Ensure a team has an HMAC secret on disk, creating it if missing. Returns
 * the secret value. Used at team-spawn time. The file is chmod 600 and the
 * containing directory is created if needed.
 *
 * Idempotent: if a secret already exists at the path we read and return
 * it unchanged — re-spawning a team with the same id doesn't rotate the
 * secret (rotation is an explicit operator action, see ADR 0011's open
 * questions section).
 *
 * NOTE: This function returns the secret to a single caller (teams.sh at
 * spawn time, which embeds it in the worker's prompt). Callers MUST NOT
 * log or echo the return value — the disk file and the prompt are the
 * only legitimate exposure paths.
 */
export function ensureSecret(teamId: string): string {
  const path = getSecretPath(teamId);
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(value)) return value;
    // Corrupted file — overwrite with a fresh secret rather than crash.
    // The old worker is already running with whatever was in its prompt;
    // if the disk file was somehow truncated, the next directive will
    // mismatch and fail loud, which is the correct behavior.
  }
  const secret = generateSecret();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, secret + "\n");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort — non-POSIX hosts (rare in this codebase) tolerate 0644 */
  }
  return secret;
}

/**
 * Read a team's HMAC secret from disk. Throws a descriptive error if the
 * file does not exist — callers (the dashboard /msg route, the master's
 * orch_msg path) must propagate this as a fail-loud error rather than
 * fall back to an unauthenticated marker. See ADR 0011 §"Secret missing
 * handling".
 */
export function readSecret(teamId: string): string {
  const path = getSecretPath(teamId);
  if (!existsSync(path)) {
    throw new Error(
      `HMAC secret missing for team ${teamId}. Cannot send authenticated directive. ` +
        `Run /subctl team rekey ${teamId} to regenerate.`,
    );
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `HMAC secret for team ${teamId} is malformed (expected 64 hex chars). ` +
        `Cannot send authenticated directive. Run /subctl team rekey ${teamId} to regenerate.`,
    );
  }
  return value;
}

// ─── marker construction + verification ──────────────────────────────────

const HMAC_TRUNCATE_HEX = 16; // 8 bytes — see ADR 0011 reasoning section

/**
 * Compute the truncated HMAC tag over `phase + "\n" + ts + "\n" + body`.
 * Exported separately from buildDirectiveMarker so callers that want to
 * verify on the wire (tests, future audit replay) can do it without a
 * round-trip through the disk + parser.
 *
 * `phase` may be the empty string when no phase is supplied — the contract
 * is "the literal string used in the marker" which is "" when the marker
 * format drops the phase field.
 */
export function computeHmac(
  secret: string,
  phase: string,
  ts: string,
  body: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(phase + "\n" + ts + "\n" + body)
    .digest("hex");
  return mac.slice(0, HMAC_TRUNCATE_HEX);
}

export interface BuildDirectiveMarkerArgs {
  /** team_id, used to locate the team's HMAC secret on disk. */
  teamId: string;
  /** Optional phase string. Empty string and null/undefined behave identically. */
  phase?: string | null;
  /** Message body (the operator's text). Goes into the HMAC; not embedded in the marker itself. */
  body: string;
  /**
   * Optional ISO timestamp. Mostly here for deterministic tests; in
   * production callers should let it default to "now".
   */
  ts?: string;
}

export interface DirectiveMarker {
  /** The exact marker string to prepend (no trailing newline). */
  marker: string;
  /** The phase the marker carries (normalized: null when no phase). */
  phase: string | null;
  /** The exact `ts` string baked into the marker. */
  ts: string;
  /** The 16-hex truncated mac baked into the marker. */
  hmac: string;
}

/**
 * Build the HMAC-authenticated marker for a team directive. Reads the
 * team's secret from disk (throws if missing — see readSecret). Does NOT
 * log the secret or any portion of the body — the return value is the
 * only thing the caller should hand off.
 *
 * The marker carries `phase`, `ts`, and `hmac:<16hex>` fields in that
 * order, matching the contract embedded in the worker's spawn-time prompt:
 *
 *     [subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]
 *     [subctl-master directive · ts:<iso> · hmac:<hmac16>]    (no phase)
 *
 * The body itself is NOT embedded in the marker — the caller prepends
 * the marker + "\n" + body when delivering to the worker pane.
 */
export function buildDirectiveMarker(
  args: BuildDirectiveMarkerArgs,
): DirectiveMarker {
  const secret = readSecret(args.teamId);
  const phase =
    typeof args.phase === "string" && args.phase.trim().length > 0
      ? args.phase.trim()
      : null;
  const ts = args.ts ?? new Date().toISOString();
  const hmac = computeHmac(secret, phase ?? "", ts, args.body);
  const marker = phase
    ? `[subctl-master directive · phase=${phase} · ts:${ts} · hmac:${hmac}]`
    : `[subctl-master directive · ts:${ts} · hmac:${hmac}]`;
  return { marker, phase, ts, hmac };
}

// ─── signed-directive helper (SPEC-wrapped wire format) ─────────────────
//
// Adds a required SPEC block to the body BEFORE the HMAC is computed.
// The wire format becomes:
//
//     [subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]
//     SPEC:
//       <body, every line indented by two spaces>
//
// The HMAC is computed over `phase + "\n" + ts + "\n" + signedBody` where
// `signedBody = "SPEC:\n  " + body.split("\n").join("\n  ")`. Workers see
// the SPEC: prefix immediately after the marker and refuse directives
// that arrive without it (contract enforced in providers/claude/teams.sh).
//
// Centralizing the SPEC wrap here means every emitter that goes through
// the dashboard's /api/orchestration/:name/msg route inherits the
// requirement for free — no caller has to remember to prepend "SPEC:".
// The HMAC mechanism proves WHO; the SPEC block proves WHAT. A signed
// marker with an empty/missing SPEC is a contract violation, not a hint
// to look elsewhere for the task body.

export interface SignedDirective extends DirectiveMarker {
  /** The wrapped body (SPEC: + indented), which is what gets signed. */
  signedBody: string;
  /** The full wire format: marker + "\n" + signedBody. */
  wireFormat: string;
}

/**
 * Build a signed directive in the SPEC-wrapped wire format. This is the
 * canonical emit path for v2.8.8+ — supersedes raw buildDirectiveMarker
 * calls for new code. Existing callers that need only the marker line
 * (without the wire-format wrap) can keep using buildDirectiveMarker
 * directly; the SPEC requirement is enforced where the wire bytes are
 * assembled, not in the marker line itself.
 */
export function buildSignedDirective(
  args: BuildDirectiveMarkerArgs,
): SignedDirective {
  // Indent every line of the operator's body by two spaces so the SPEC
  // block reads as a block-scalar under the marker. Indentation is part
  // of the signed bytes — the worker MUST receive the same bytes master
  // signed, including indentation.
  const indentedBody = args.body.split("\n").join("\n  ");
  const signedBody = `SPEC:\n  ${indentedBody}`;
  const marker = buildDirectiveMarker({ ...args, body: signedBody });
  return {
    ...marker,
    signedBody,
    wireFormat: `${marker.marker}\n${signedBody}`,
  };
}

// ─── verification (used by tests; reserved for future worker-side checks) ─

/**
 * Tight regex matching the marker shape. Designed so that:
 *   - the bracket structure is required
 *   - the `phase=…` middle is optional (matches the no-phase form)
 *   - the `ts:` field comes before `hmac:` (matches buildDirectiveMarker output)
 *   - the `hmac:` field is exactly 16 lowercase hex chars (truncated form)
 *
 * Wire protocol identifier — DO NOT rename `subctl-master` without
 * version negotiation. Workers in-flight when the daemon restarts
 * would reject new directives if this string changes. The v3.0
 * master → Evy rename deliberately keeps this prefix as legacy
 * wire identity; a future PR can introduce a `subctl-evy` variant
 * with version-negotiated rollout.
 */
const MARKER_RE =
  /^\[subctl-master directive(?: · phase=([^·\]]+?))? · ts:([^ ·\]]+) · hmac:([0-9a-f]{16})\]$/;

export interface ParsedMarker {
  phase: string | null;
  ts: string;
  hmac: string;
}

/**
 * Parse a marker line into its constituent fields. Returns null if the
 * shape doesn't match (missing hmac, malformed hex, wrong field order,
 * etc.) — callers should treat null as "this marker is not authenticated"
 * and refuse the directive.
 */
export function parseDirectiveMarker(marker: string): ParsedMarker | null {
  const m = marker.match(MARKER_RE);
  if (!m) return null;
  const phaseRaw = m[1];
  return {
    phase: typeof phaseRaw === "string" && phaseRaw.length > 0 ? phaseRaw.trim() : null,
    ts: m[2]!,
    hmac: m[3]!,
  };
}

export interface VerifyDirectiveMarkerArgs {
  /** team_id, used to locate the team's HMAC secret on disk. */
  teamId: string;
  /** The marker line (no trailing newline). */
  marker: string;
  /** The body that followed the marker — must match exactly what was signed. */
  body: string;
}

/**
 * Recompute the marker's HMAC from `(secret, phase, ts, body)` and
 * compare to the value baked into the marker. Returns true on match,
 * false on any mismatch or malformed-marker condition.
 *
 * Used by tests today; reserved as the canonical worker-side check for
 * future native-language workers (the current Claude Code worker
 * performs the check via in-prompt model reasoning).
 */
export function verifyDirectiveMarker(args: VerifyDirectiveMarkerArgs): boolean {
  const parsed = parseDirectiveMarker(args.marker);
  if (!parsed) return false;
  let secret: string;
  try {
    secret = readSecret(args.teamId);
  } catch {
    return false;
  }
  const expected = computeHmac(secret, parsed.phase ?? "", parsed.ts, args.body);
  return constantTimeEqual(expected, parsed.hmac);
}

/**
 * Constant-time string compare. Avoids leaking timing information about
 * partial matches when the verifier runs in a hostile environment.
 * Operates on equal-length hex strings (asymmetric lengths short-circuit
 * to false, which is fine — the marker regex pins the length to 16).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
