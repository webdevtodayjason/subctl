// components/master/policy/__tests__/exec.test.ts
//
// Unit tests for the central exec helper. Covers:
//   - execCommand: happy-path spawn, stdout/stderr capture, exit codes
//   - execCommand: timeout enforcement + timedOut flag
//   - execCommand: stdin piping
//   - execCommand: concurrent execs (no shared state bleed)
//   - execCommandGated: deny on deny_always pattern
//   - execCommandGated: allow on a normal command
//   - PolicyDenied: rule + rulePath surface intact
//
// These tests intentionally do NOT exercise the policy engine's correctness
// itself — that's the job of `components/master/tools/policy/__tests__/`.
// Here we only verify the wiring: that execCommandGated calls the engine,
// honors its decisions, and that PolicyDenied carries the data callsites
// will route into audit logs.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  execCommand,
  execCommandGated,
  PolicyDenied,
  _clearPolicyCacheForTesting,
} from "../exec";

// ---------------------------------------------------------------------------
// execCommand — ungated
// ---------------------------------------------------------------------------

describe("execCommand (ungated)", () => {
  test("spawns + returns ExecResult with stdout, stderr, exitCode, durationMs", async () => {
    const r = await execCommand("/bin/echo", ["hello world"]);
    expect(r.stdout.trim()).toBe("hello world");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.timedOut).toBe(false);
  });

  test("captures non-zero exit codes", async () => {
    // `false` is POSIX-mandated and returns 1.
    const r = await execCommand("/usr/bin/false", []);
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  test("captures stderr separately from stdout", async () => {
    // sh -c 'echo OUT; echo ERR >&2' splits the streams. Use /bin/sh -c
    // (NOT shell:true; we're spawning sh as the binary with -c as an arg).
    const r = await execCommand("/bin/sh", ["-c", "echo OUT; echo ERR >&2"]);
    expect(r.stdout.trim()).toBe("OUT");
    expect(r.stderr.trim()).toBe("ERR");
    expect(r.exitCode).toBe(0);
  });

  test("respects cwd option", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subctl-exec-cwd-"));
    try {
      const r = await execCommand("/bin/pwd", [], { cwd: dir });
      // macOS may prefix /private to /var-style tmpdirs in pwd output.
      // realpath would be more robust, but for the test we just need to
      // confirm the cwd took effect — checking that the suffix matches the
      // dir name is enough.
      expect(r.stdout).toContain(dir.split("/").pop()!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pipes stdin to the child", async () => {
    // /bin/cat with stdin echoes back. Confirms the stdin Blob path.
    const r = await execCommand("/bin/cat", [], { stdin: "piped-input-payload" });
    expect(r.stdout).toBe("piped-input-payload");
    expect(r.exitCode).toBe(0);
  });

  test("enforces timeout and sets timedOut=true", async () => {
    // `sleep 5` with a 100ms timeout. We expect timedOut=true and the
    // process to be killed. The exit code will be null (signal-killed) or
    // non-zero depending on Bun's reporting; we just assert timedOut.
    const start = performance.now();
    const r = await execCommand("/bin/sleep", ["5"], { timeout: 100 });
    const elapsed = performance.now() - start;
    expect(r.timedOut).toBe(true);
    // Should NOT have waited the full 5s.
    expect(elapsed).toBeLessThan(2000);
  });

  test("timeout=0 disables the timer", async () => {
    // Trivial short-running command with no timer. Just confirms no crash
    // and a clean exit; we're not exercising any long-running path because
    // that would slow down the test suite.
    const r = await execCommand("/bin/echo", ["no-timer"], { timeout: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("concurrent execs do not share state (independent stdout)", async () => {
    // Spawn three echos in parallel. If the helper had shared state
    // (e.g. a module-level stdout buffer), outputs would interleave or
    // overwrite. Each must come back with its own payload.
    const [a, b, c] = await Promise.all([
      execCommand("/bin/echo", ["one"]),
      execCommand("/bin/echo", ["two"]),
      execCommand("/bin/echo", ["three"]),
    ]);
    expect(a.stdout.trim()).toBe("one");
    expect(b.stdout.trim()).toBe("two");
    expect(c.stdout.trim()).toBe("three");
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
  });

  test("custom env overrides parent env", async () => {
    // `env` with a sparse set means the child sees ONLY these vars (per
    // Bun.spawn semantics). Verify the override by reading FOO inside sh.
    const r = await execCommand("/bin/sh", ["-c", 'echo "FOO=$FOO"'], {
      env: { FOO: "bar", PATH: "/usr/bin:/bin" },
    });
    expect(r.stdout.trim()).toBe("FOO=bar");
  });
});

// ---------------------------------------------------------------------------
// execCommandGated — policy-gated
// ---------------------------------------------------------------------------

// Test fixture: a project_root with a .subctl/policy.toml that DENIES `rm
// -rf` via deny_always.substrings and ALLOWS `echo` via allow.commands.
// This isolates the test from whatever real project policy the operator
// has on disk and exercises both decision branches deterministically.

let fixtureRoot: string;

function writeFixturePolicy(toml: string): void {
  const dir = join(fixtureRoot, ".subctl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "policy.toml"), toml, "utf8");
}

beforeEach(() => {
  _clearPolicyCacheForTesting();
  fixtureRoot = mkdtempSync(join(tmpdir(), "subctl-exec-gated-"));
});

afterEach(() => {
  _clearPolicyCacheForTesting();
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe("execCommandGated (gated)", () => {
  test("denies on deny_always substring → throws PolicyDenied", async () => {
    writeFixturePolicy(`
preset = "none"
default_mode = "gated"

[mode.gated.deny_always]
substrings = ["rm -rf"]

[mode.gated.allow]
commands = ["echo"]
`);

    let thrown: unknown = null;
    try {
      await execCommandGated("rm", ["-rf", "/some/path"], {
        policy: { teamId: "test-team", projectRoot: fixtureRoot },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PolicyDenied);
    const denied = thrown as PolicyDenied;
    expect(denied.rule).toContain("rm -rf");
    expect(denied.rulePath).toBe("mode.gated.deny_always.substrings");
    expect(denied.command).toBe("rm -rf /some/path");
    expect(denied.message).toMatch(/policy denied/);
  });

  test("allows on a normal command and returns ExecResult", async () => {
    writeFixturePolicy(`
preset = "none"
default_mode = "gated"

[mode.gated.allow]
commands = ["echo"]
`);

    const r = await execCommandGated("echo", ["allowed"], {
      policy: { teamId: "test-team", projectRoot: fixtureRoot },
    });
    expect(r.stdout.trim()).toBe("allowed");
    expect(r.exitCode).toBe(0);
  });

  test("trusted mode override → blanket allow even for dangerous commands", async () => {
    writeFixturePolicy(`
preset = "none"
default_mode = "gated"

[mode.gated.deny_always]
substrings = ["echo"]
`);

    // Without override: this would deny (echo is in deny_always). With
    // mode="trusted" override: blanket allow (D3 semantics — note: this
    // direction technically relaxes, which D3 says shouldn't happen at the
    // command tier; but the override IS the explicit caller-side request,
    // so the helper passes it through. Policy on the spawn side enforces
    // D3 — exec.ts is dumb infrastructure).
    const r = await execCommandGated("echo", ["trusted-bypass"], {
      policy: {
        teamId: "test-team",
        mode: "trusted",
        projectRoot: fixtureRoot,
      },
    });
    expect(r.stdout.trim()).toBe("trusted-bypass");
    expect(r.exitCode).toBe(0);
  });

  test("PolicyDenied has correct name, rule, rulePath, command", async () => {
    writeFixturePolicy(`
preset = "none"
default_mode = "gated"

[mode.gated.deny_always]
substrings = [":(){ :|:& };:"]
`);

    let denied: PolicyDenied | null = null;
    try {
      await execCommandGated("sh", ["-c", ":(){ :|:& };:"], {
        policy: { teamId: "tid", projectRoot: fixtureRoot },
      });
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied).not.toBeNull();
    expect(denied!.name).toBe("PolicyDenied");
    expect(denied!.rulePath).toBe("mode.gated.deny_always.substrings");
    expect(denied!.command).toContain(":(){ :|:& };:");
    // Standard Error instance check — callers should be able to catch as
    // both PolicyDenied and Error.
    expect(denied!).toBeInstanceOf(Error);
  });

  test("default-deny path → PolicyDenied with mode.gated.default_deny", async () => {
    // Empty gated config (no allow rules at all) → default deny.
    writeFixturePolicy(`
preset = "none"
default_mode = "gated"

[mode.gated]
`);

    let denied: PolicyDenied | null = null;
    try {
      await execCommandGated("ls", ["-la"], {
        policy: { teamId: "tid", projectRoot: fixtureRoot },
      });
    } catch (err) {
      denied = err as PolicyDenied;
    }
    expect(denied).not.toBeNull();
    expect(denied!.rulePath).toBe("mode.gated.default_deny");
  });
});

// ---------------------------------------------------------------------------
// PolicyDenied class shape
// ---------------------------------------------------------------------------

describe("PolicyDenied", () => {
  test("constructs with rule, rulePath, command and proper message", () => {
    const err = new PolicyDenied("test_rule", "mode.gated.test", "cmd arg1");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PolicyDenied);
    expect(err.name).toBe("PolicyDenied");
    expect(err.rule).toBe("test_rule");
    expect(err.rulePath).toBe("mode.gated.test");
    expect(err.command).toBe("cmd arg1");
    expect(err.message).toBe("policy denied: test_rule (mode.gated.test)");
  });
});
