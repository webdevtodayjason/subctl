// lib/__tests__/directive-verify.test.ts
//
// W6.5 ③ — `subctl directive verify <envelope-or-file>`: the worker-side
// mechanical check that an HMAC directive envelope is daemon-minted.
//
// Envelopes are minted by the REAL v3 signer (components/evy/
// trust-marker.ts buildSignedDirective) so the suite proves the bash verb
// computes byte-identically to what production emits — same MAC input
// (phase + "\n" + ts + "\n" + signedBody), same ASCII-hex key semantics.
// The v4 Rust signer (crates/evy-providers/src/hmac.rs) is fixture-pinned
// byte-compatible with this one, so passing here covers both daemons.
//
// Locked-contract minimum: accepts daemon-minted; rejects tampered body;
// rejects wrong key. Plus: no-phase form, trailing-newline tolerance,
// key auto-resolution from CLAUDE_CONFIG_DIR / CODEX_HOME, and the
// no-key error path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  _setStateDirForTesting,
  buildSignedDirective,
  ensureSecret,
} from "../../components/evy/trust-marker";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SUBCTL_BIN = join(REPO_ROOT, "bin", "subctl");
const TEAM_ID = "w65-verify-test";

interface Fixture {
  root: string;
  stateDir: string;
  secret: string; // 64-hex — the daemon-side signing key
  keyFile: string;
}

let d: Fixture;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "subctl-directive-verify-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  _setStateDirForTesting(stateDir);
  const secret = ensureSecret(TEAM_ID);
  const keyFile = join(stateDir, "teams", TEAM_ID, "hmac.secret");
  d = { root, stateDir, secret, keyFile };
});

afterEach(() => {
  _setStateDirForTesting(null);
  rmSync(d.root, { recursive: true, force: true });
});

interface VerifyResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `subctl directive verify` through the real bin/subctl dispatcher. */
async function runVerify(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<VerifyResult> {
  const proc = Bun.spawn([SUBCTL_BIN, "directive", "verify", ...args], {
    env: {
      ...process.env,
      SUBCTL_REPO_ROOT: REPO_ROOT,
      NO_COLOR: "1",
      // Isolate from the developer's real session env — tests opt back
      // in per-case.
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      SUBCTL_DIRECTIVE_KEY_FILE: "",
      SUBCTL_TEAM_NAME: "",
      ...env,
    },
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

function mintEnvelope(body: string, phase?: string): string {
  return buildSignedDirective({ teamId: TEAM_ID, phase, body }).wireFormat;
}

describe("subctl directive verify — accepts daemon-minted envelopes", () => {
  test("valid envelope with phase → VERIFIED, exit 0", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("Goal: ship the slice\nDone when: tests green", "w65"));
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
    expect(r.stdout).toContain("phase=w65");
  });

  test("no-phase envelope verifies (empty phase contributes a leading newline)", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("no-phase body"));
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("phase=<none>");
  });

  test("a single trailing newline (editor/redirect artifact) is tolerated", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("body line", "p") + "\n");
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
  });

  test("reads the envelope from stdin via `-`", async () => {
    const r = await runVerify(
      ["-", "--key-file", d.keyFile],
      {},
      mintEnvelope("stdin body", "p"),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
  });

  test("multi-line body with indentation-sensitive content verifies byte-exactly", async () => {
    const body = "line one\n  pre-indented\n\ntrailing-spaces line  ";
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope(body, "w65"));
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(0);
  });
});

describe("subctl directive verify — rejects forgery and tamper", () => {
  test("tampered body → FAILED, exit 1", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("Goal: ship the slice", "w65").replace("ship", "sink"));
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HMAC mismatch");
  });

  test("wrong key → FAILED, exit 1", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("Goal: ship the slice", "w65"));
    const wrongKey = join(d.root, "wrong.key");
    writeFileSync(wrongKey, "ab".repeat(32) + "\n");
    const r = await runVerify([file, "--key-file", wrongKey]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HMAC mismatch");
  });

  test("tampered phase field → FAILED (phase is part of the MAC input)", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(
      file,
      mintEnvelope("body", "w65").replace("phase=w65", "phase=other"),
    );
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(1);
  });

  test("marker without a SPEC body → FAILED (envelope must carry the body)", async () => {
    const markerOnly = mintEnvelope("body", "p").split("\n")[0];
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, markerOnly);
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SPEC");
  });

  test("non-marker first line → FAILED, not a crash", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, "hello there\nSPEC:\n  body");
    const r = await runVerify([file, "--key-file", d.keyFile]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a subctl-master directive marker");
  });
});

describe("subctl directive verify — key resolution (spawn-provisioned files)", () => {
  test("auto-resolves $CLAUDE_CONFIG_DIR/.subctl-directive-key", async () => {
    const cfgDir = join(d.root, "claude-cfg");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, ".subctl-directive-key"), d.secret + "\n");
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("claude worker body", "p"));
    const r = await runVerify([file], { CLAUDE_CONFIG_DIR: cfgDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
  });

  test("auto-resolves $CODEX_HOME/.subctl-directive-key", async () => {
    const codexHome = join(d.root, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, ".subctl-directive-key"), d.secret + "\n");
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("codex worker body", "p"));
    const r = await runVerify([file], { CODEX_HOME: codexHome });
    expect(r.code).toBe(0);
  });

  test("legacy fallback: team state hmac.secret via $SUBCTL_TEAM_NAME", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("legacy worker body", "p"));
    const r = await runVerify([file], {
      SUBCTL_TEAM_NAME: TEAM_ID,
      SUBCTL_STATE_DIR: d.stateDir,
    });
    expect(r.code).toBe(0);
  });

  test("no key anywhere → exit 2 with a usable hint, never a false VERIFIED", async () => {
    const file = join(d.root, "envelope.txt");
    writeFileSync(file, mintEnvelope("body", "p"));
    const r = await runVerify([file]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no verification key found");
    expect(r.stdout).not.toContain("VERIFIED");
  });
});
