// components/master/__tests__/trust-marker.test.ts
//
// v2.7.20 — HMAC-authenticated trust marker (ADR 0011 Layer 1). Pins
// the contract between providers/claude/teams.sh (which generates the
// per-team secret and bakes it into the worker's prompt) and the
// dashboard /api/orchestration/:name/msg route (which reads the same
// secret from disk and signs the marker).
//
// What we test:
//   1. ensureSecret creates a 64-hex secret on disk at the expected path,
//      with chmod 600. Idempotent — re-calling returns the same value.
//   2. generateSecret produces 64 hex chars of cryptographic randomness.
//   3. buildDirectiveMarker emits a marker matching the documented shape
//      (with and without the phase field).
//   4. verifyDirectiveMarker returns true for a marker round-tripped
//      from the same secret/phase/ts/body — the happy path.
//   5. verifyDirectiveMarker returns false for tampering on each input:
//      wrong secret (different team), modified body, modified phase,
//      modified ts, missing hmac field, malformed hmac, truncated hmac.
//   6. buildDirectiveMarker throws a descriptive error when the team's
//      hmac.secret file is missing. The error message names the team
//      and points at the rekey path so the operator can self-recover.
//
// Tests are tmpdir-scoped via _setStateDirForTesting so they don't
// touch ~/.local/state/subctl on the developer's machine.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setStateDirForTesting,
  buildDirectiveMarker,
  computeHmac,
  ensureSecret,
  generateSecret,
  getSecretPath,
  parseDirectiveMarker,
  readSecret,
  verifyDirectiveMarker,
} from "../trust-marker";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "subctl-trust-marker-test-"));
  _setStateDirForTesting(stateDir);
});

afterEach(() => {
  _setStateDirForTesting(null);
  rmSync(stateDir, { recursive: true, force: true });
});

// ─── secret lifecycle ────────────────────────────────────────────────────

describe("generateSecret", () => {
  test("returns 64 lowercase hex chars", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls return different values (cryptographic randomness)", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});

describe("ensureSecret", () => {
  test("creates the file at the expected path with chmod 600 on first call", () => {
    const teamId = "claude-foo";
    const path = getSecretPath(teamId);
    expect(existsSync(path)).toBe(false);

    const secret = ensureSecret(teamId);

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(secret);

    // chmod 600 — mode bits 0o777 == owner-only read/write
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("is idempotent — re-calling returns the same secret", () => {
    const teamId = "claude-bar";
    const a = ensureSecret(teamId);
    const b = ensureSecret(teamId);
    expect(b).toBe(a);
  });

  test("regenerates if existing file is corrupted (non-hex contents)", () => {
    const teamId = "claude-corrupt";
    const path = getSecretPath(teamId);
    // Seed a bogus file
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    });
    writeFileSync(path, "this is not a 64-hex secret\n");

    const secret = ensureSecret(teamId);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe("this is not a 64-hex secret");
    expect(readFileSync(path, "utf8").trim()).toBe(secret);
  });
});

describe("readSecret", () => {
  test("returns the on-disk value when present", () => {
    const teamId = "claude-team-readable";
    const seeded = ensureSecret(teamId);
    expect(readSecret(teamId)).toBe(seeded);
  });

  test("throws a descriptive error when the file is missing", () => {
    expect(() => readSecret("claude-never-spawned")).toThrow(
      /HMAC secret missing for team claude-never-spawned/,
    );
    expect(() => readSecret("claude-never-spawned")).toThrow(
      /Run \/subctl team rekey claude-never-spawned to regenerate/,
    );
  });

  test("throws a descriptive error when the file is malformed", () => {
    const teamId = "claude-malformed";
    const path = getSecretPath(teamId);
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    });
    writeFileSync(path, "not-a-secret\n");
    expect(() => readSecret(teamId)).toThrow(/malformed/);
  });
});

// ─── buildDirectiveMarker ────────────────────────────────────────────────

describe("buildDirectiveMarker", () => {
  test("emits a well-formed marker with phase (HMAC is 16 hex chars)", () => {
    const teamId = "claude-team-a";
    ensureSecret(teamId);

    const { marker, phase, ts, hmac } = buildDirectiveMarker({
      teamId,
      phase: "baseline-verification",
      body: "stop work and commit current state",
      ts: "2026-05-13T10:00:00.000Z",
    });

    expect(phase).toBe("baseline-verification");
    expect(ts).toBe("2026-05-13T10:00:00.000Z");
    expect(hmac).toMatch(/^[0-9a-f]{16}$/);
    expect(marker).toBe(
      `[subctl-master directive · phase=baseline-verification · ts:2026-05-13T10:00:00.000Z · hmac:${hmac}]`,
    );
  });

  test("emits a no-phase marker shape when phase is null/empty/whitespace", () => {
    const teamId = "claude-team-b";
    ensureSecret(teamId);

    for (const phaseInput of [null, undefined, "", "   "]) {
      const { marker, phase, hmac } = buildDirectiveMarker({
        teamId,
        phase: phaseInput,
        body: "go",
        ts: "2026-05-13T11:00:00.000Z",
      });
      expect(phase).toBeNull();
      expect(marker).toBe(
        `[subctl-master directive · ts:2026-05-13T11:00:00.000Z · hmac:${hmac}]`,
      );
    }
  });

  test("HMAC is deterministic for fixed (secret, phase, ts, body) — verified externally", () => {
    const teamId = "claude-team-c";
    const secret = "a".repeat(64);
    // Seed a deterministic secret rather than ensureSecret() so we can
    // recompute outside the helper.
    const path = getSecretPath(teamId);
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    });
    writeFileSync(path, secret + "\n");

    const ts = "2026-05-13T12:00:00.000Z";
    const phase = "ph-1";
    const body = "the body";

    const { marker } = buildDirectiveMarker({ teamId, phase, body, ts });

    // Recompute independently
    const expected = computeHmac(secret, phase, ts, body);
    expect(marker).toContain(`hmac:${expected}`);

    // Same inputs → same marker (timestamps held constant)
    const second = buildDirectiveMarker({ teamId, phase, body, ts });
    expect(second.marker).toBe(marker);
  });

  test("throws the documented error when hmac.secret is missing", () => {
    expect(() =>
      buildDirectiveMarker({
        teamId: "claude-team-no-secret",
        phase: "x",
        body: "y",
      }),
    ).toThrow(
      /HMAC secret missing for team claude-team-no-secret\. Cannot send authenticated directive\. Run \/subctl team rekey claude-team-no-secret to regenerate\./,
    );
  });

  test("defaults `ts` to current time when omitted", () => {
    const teamId = "claude-team-tsless";
    ensureSecret(teamId);
    const before = Date.now();
    const { ts } = buildDirectiveMarker({ teamId, body: "x" });
    const after = Date.now();
    const parsed = Date.parse(ts);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});

// ─── parseDirectiveMarker ────────────────────────────────────────────────

describe("parseDirectiveMarker", () => {
  test("parses a phase-bearing marker", () => {
    const m = parseDirectiveMarker(
      "[subctl-master directive · phase=alpha · ts:2026-05-13T10:00:00.000Z · hmac:0123456789abcdef]",
    );
    expect(m).not.toBeNull();
    expect(m!.phase).toBe("alpha");
    expect(m!.ts).toBe("2026-05-13T10:00:00.000Z");
    expect(m!.hmac).toBe("0123456789abcdef");
  });

  test("parses a no-phase marker", () => {
    const m = parseDirectiveMarker(
      "[subctl-master directive · ts:2026-05-13T10:00:00.000Z · hmac:0123456789abcdef]",
    );
    expect(m).not.toBeNull();
    expect(m!.phase).toBeNull();
    expect(m!.ts).toBe("2026-05-13T10:00:00.000Z");
    expect(m!.hmac).toBe("0123456789abcdef");
  });

  test("returns null for missing hmac field (pre-v2.7.20 marker shape)", () => {
    expect(
      parseDirectiveMarker(
        "[subctl-master directive · phase=alpha · ts:2026-05-13T10:00:00.000Z]",
      ),
    ).toBeNull();
  });

  test("returns null for malformed hmac (non-hex)", () => {
    expect(
      parseDirectiveMarker(
        "[subctl-master directive · phase=alpha · ts:2026-05-13T10:00:00.000Z · hmac:NOT_HEX_GARBAGE]",
      ),
    ).toBeNull();
  });

  test("returns null for truncated hmac (<16 hex chars)", () => {
    expect(
      parseDirectiveMarker(
        "[subctl-master directive · phase=alpha · ts:2026-05-13T10:00:00.000Z · hmac:0123456789ab]",
      ),
    ).toBeNull();
  });

  test("returns null for over-long hmac (>16 hex chars)", () => {
    expect(
      parseDirectiveMarker(
        "[subctl-master directive · phase=alpha · ts:2026-05-13T10:00:00.000Z · hmac:0123456789abcdef0123]",
      ),
    ).toBeNull();
  });

  test("returns null for completely bogus input", () => {
    expect(parseDirectiveMarker("hello world")).toBeNull();
    expect(parseDirectiveMarker("")).toBeNull();
    expect(parseDirectiveMarker("[subctl-master directive]")).toBeNull();
  });
});

// ─── verifyDirectiveMarker (happy + tamper paths) ────────────────────────

describe("verifyDirectiveMarker", () => {
  const teamId = "claude-verify";
  const phase = "phase-x";
  const ts = "2026-05-13T13:00:00.000Z";
  const body = "stop and commit current state";

  function buildFixture(): string {
    ensureSecret(teamId);
    const { marker } = buildDirectiveMarker({ teamId, phase, body, ts });
    return marker;
  }

  test("returns true for a marker built from the same secret/phase/ts/body", () => {
    const marker = buildFixture();
    expect(verifyDirectiveMarker({ teamId, marker, body })).toBe(true);
  });

  test("returns true for a no-phase marker round-trip", () => {
    ensureSecret(teamId);
    const { marker } = buildDirectiveMarker({ teamId, body, ts });
    expect(verifyDirectiveMarker({ teamId, marker, body })).toBe(true);
  });

  test("returns FALSE when the body is modified", () => {
    const marker = buildFixture();
    expect(
      verifyDirectiveMarker({ teamId, marker, body: body + "X" }),
    ).toBe(false);
  });

  test("returns FALSE when the marker's phase is tampered (re-signed nowhere)", () => {
    const marker = buildFixture();
    const tampered = marker.replace(
      `phase=${phase}`,
      `phase=different-phase`,
    );
    expect(verifyDirectiveMarker({ teamId, marker: tampered, body })).toBe(
      false,
    );
  });

  test("returns FALSE when the marker's ts is tampered", () => {
    const marker = buildFixture();
    const tampered = marker.replace(ts, "2026-05-13T99:99:99.999Z");
    expect(verifyDirectiveMarker({ teamId, marker: tampered, body })).toBe(
      false,
    );
  });

  test("returns FALSE when the hmac field is missing entirely (pre-v2.7.20 shape)", () => {
    ensureSecret(teamId);
    const legacy = `[subctl-master directive · phase=${phase} · ts:${ts}]`;
    expect(verifyDirectiveMarker({ teamId, marker: legacy, body })).toBe(
      false,
    );
  });

  test("returns FALSE when the hmac field is malformed (non-hex)", () => {
    ensureSecret(teamId);
    const garbage = `[subctl-master directive · phase=${phase} · ts:${ts} · hmac:NOTHEXGARBAGE!!]`;
    expect(verifyDirectiveMarker({ teamId, marker: garbage, body })).toBe(
      false,
    );
  });

  test("returns FALSE when the hmac is truncated (<16 chars)", () => {
    const marker = buildFixture();
    // Slice the last 4 hex chars off the hmac:<...>] tail. The regex
    // requires exactly 16 chars, so parseDirectiveMarker returns null
    // and verify returns false even before HMAC recomputation.
    const truncated = marker.replace(/hmac:([0-9a-f]{12})[0-9a-f]{4}\]$/, "hmac:$1]");
    expect(truncated).not.toBe(marker);
    expect(verifyDirectiveMarker({ teamId, marker: truncated, body })).toBe(
      false,
    );
  });

  test("returns FALSE when the secret is rotated under our feet (wrong key)", () => {
    const marker = buildFixture();
    // Overwrite the on-disk secret with a different one — simulates
    // operator rekey between sign + verify, or a stale captured marker
    // being replayed against a fresh team that happens to share the id.
    const path = getSecretPath(teamId);
    writeFileSync(path, generateSecret() + "\n");
    expect(verifyDirectiveMarker({ teamId, marker, body })).toBe(false);
  });

  test("returns FALSE when the team_id has no secret on disk", () => {
    const marker = buildFixture();
    // Verify against a different team_id that has no secret file.
    expect(
      verifyDirectiveMarker({
        teamId: "claude-unrelated-team",
        marker,
        body,
      }),
    ).toBe(false);
  });
});

// ─── computeHmac (low-level primitive sanity) ────────────────────────────

describe("computeHmac", () => {
  test("matches a known HMAC-SHA256 first-16-hex vector", () => {
    // Verifies the spec: HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body),
    // first 16 hex chars. Concrete fixture so any refactor that changes the
    // construction (e.g. dropping a separator, swapping the digest algo)
    // breaks loudly.
    const secret = "0123456789abcdef".repeat(4); // 64 hex chars
    const phase = "ph";
    const ts = "T";
    const body = "B";
    const out = computeHmac(secret, phase, ts, body);
    // Recompute via the standard library inline (independent path).
    const expected = require("node:crypto")
      .createHmac("sha256", secret)
      .update("ph\nT\nB")
      .digest("hex")
      .slice(0, 16);
    expect(out).toBe(expected);
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  test("changes when ANY of (secret, phase, ts, body) changes", () => {
    const base = computeHmac("a".repeat(64), "p", "t", "b");
    expect(computeHmac("b".repeat(64), "p", "t", "b")).not.toBe(base);
    expect(computeHmac("a".repeat(64), "p2", "t", "b")).not.toBe(base);
    expect(computeHmac("a".repeat(64), "p", "t2", "b")).not.toBe(base);
    expect(computeHmac("a".repeat(64), "p", "t", "b2")).not.toBe(base);
  });
});
