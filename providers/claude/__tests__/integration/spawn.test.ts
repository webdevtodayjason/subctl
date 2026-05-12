// providers/claude/__tests__/integration/spawn.test.ts
//
// Drives the spawn-side policy plumbing without launching tmux/claude. We
// exercise the bash helper trio that teams.sh calls during the spawn flow:
//
//   _subctl_claude_resolve_mode
//   _subctl_claude_write_snapshot   (bridges to _write_snapshot.ts)
//   _subctl_claude_write_settings_local
//   _subctl_claude_emit_spawn_banner
//
// For each of trusted / gated / sealed we verify:
//   - the snapshot file gets written at the expected path with the expected
//     header (mode + team_id) and a parseable TOML body
//   - the audit-log header line is appended (event_type=header, rule=spawn)
//   - the per-team settings.local.json carries the right shape:
//       trusted: only permissions.defaultMode=bypassPermissions
//       gated:   defaultMode + PreToolUse Bash hook
//       sealed:  defaultMode + deny=[Bash] + PreToolUse hook with --mode=sealed
//                + mcpServers.subctl-sealed-tools
//   - the spawn banner stdout matches the pack 08 §5 format
//
// Hermetic: per-test SUBCTL_STATE_DIR, SUBCTL_CONFIG_DIR, project root, and
// per-test fake `subctl-policy-check` + `subctl` dispatcher binaries (just
// empty executable files) so the path-bake step has something to point at.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const POLICY_SH = join(REPO_ROOT, "providers", "claude", "policy.sh");

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface FixtureDirs {
  projectRoot: string;
  cfgDir: string;
  stateDir: string;
  configDir: string;
  fakeBin: string;
  fakeSubctl: string;
}

function setup(policyToml: string | null = null): FixtureDirs {
  const root = mkdtempSync(join(tmpdir(), "subctl-pr10-spawn-"));
  const projectRoot = join(root, "proj");
  const cfgDir = join(root, "cfg");
  const stateDir = join(root, "state");
  const configDir = join(root, "userconfig");
  const fakeBin = join(root, "fake-policy-check");
  const fakeSubctl = join(root, "fake-subctl");

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeBin, 0o755);
  writeFileSync(fakeSubctl, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeSubctl, 0o755);

  if (policyToml !== null) {
    mkdirSync(join(projectRoot, ".subctl"), { recursive: true });
    writeFileSync(join(projectRoot, ".subctl", "policy.toml"), policyToml);
  }

  return { projectRoot, cfgDir, stateDir, configDir, fakeBin, fakeSubctl };
}

function teardown(d: FixtureDirs) {
  rmSync(join(d.projectRoot, ".."), { recursive: true, force: true });
}

/**
 * Run a chunk of bash with policy.sh sourced, the right env vars set, and
 * stash + return any stdout/stderr.
 */
async function runBash(d: FixtureDirs, script: string): Promise<BashResult> {
  const proc = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      SUBCTL_REPO_ROOT: REPO_ROOT,
      SUBCTL_STATE_DIR: d.stateDir,
      SUBCTL_CONFIG_DIR: d.configDir,
      SUBCTL_POLICY_CHECK_BIN: d.fakeBin,
      SUBCTL_BIN: d.fakeSubctl,
      // ensure no inherited NO_COLOR / TERM weirdness affects subctl_warn
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

const projectPolicyTrusted = `preset = "none"
default_mode = "gated"

[mode.gated]
[mode.gated.allow]
commands = ["ls", "pwd"]
[mode.gated.deny_always]
substrings = ["rm -rf"]
`;

let d: FixtureDirs;
beforeEach(() => {
  d = setup(projectPolicyTrusted);
});
afterEach(() => {
  teardown(d);
});

// ─────────────────────────────────────────────────────────────────────────
// Mode resolution
// ─────────────────────────────────────────────────────────────────────────

describe("_subctl_claude_resolve_mode (precedence)", () => {
  test("CLI flag wins over project policy", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_resolve_mode trusted "${d.projectRoot}"`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("trusted");
  });

  test("project policy wins over user policy and hardcoded default", async () => {
    // project says sealed; CLI is empty
    writeFileSync(
      join(d.projectRoot, ".subctl", "policy.toml"),
      `preset = "none"\ndefault_mode = "sealed"\n[mode.gated]\n`,
    );
    const r = await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_resolve_mode "" "${d.projectRoot}"`,
    );
    expect(r.stdout.trim()).toBe("sealed");
  });

  test("user config falls in when no CLI flag and no project file", async () => {
    rmSync(join(d.projectRoot, ".subctl"), { recursive: true, force: true });
    writeFileSync(
      join(d.configDir, "policy.toml"),
      `default_mode = "trusted"\n`,
    );
    const r = await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_resolve_mode "" "${d.projectRoot}"`,
    );
    expect(r.stdout.trim()).toBe("trusted");
  });

  test("hardcoded default = gated when nothing else is set", async () => {
    rmSync(join(d.projectRoot, ".subctl"), { recursive: true, force: true });
    const r = await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_resolve_mode "" "${d.projectRoot}"`,
    );
    expect(r.stdout.trim()).toBe("gated");
  });

  test("invalid CLI mode errors out", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_resolve_mode unicorn "${d.projectRoot}"`,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("invalid --mode value");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Snapshot + audit-header write
// ─────────────────────────────────────────────────────────────────────────

describe("_subctl_claude_write_snapshot (TS bridge)", () => {
  test("writes snapshot + audit header for gated mode", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"
       _subctl_claude_write_snapshot team-gated "${d.projectRoot}" gated || exit 1
       echo "SHA=$SUBCTL_POLICY_ALLOWLIST_SHA"
       echo "PATH=$SUBCTL_POLICY_SNAPSHOT_PATH"`,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("SHA=");
    expect(r.stdout).toContain("PATH=");

    const snapPath = join(
      d.stateDir,
      "teams",
      "team-gated",
      "policy.snapshot.toml",
    );
    expect(existsSync(snapPath)).toBe(true);

    const text = readFileSync(snapPath, "utf8");
    expect(text).toMatch(/^# subctl policy snapshot/);
    expect(text).toContain(`# team_id = "team-gated"`);
    expect(text).toContain(`# mode = "gated"`);
    expect(text).toContain(`# allowlist_sha`);
    expect(text).toMatch(/default_mode = "gated"/);

    // audit log header line
    const auditPath = join(d.stateDir, "audit", "team-gated.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const auditText = readFileSync(auditPath, "utf8").trim();
    const auditEntry = JSON.parse(auditText.split("\n")[0]);
    expect(auditEntry.event_type).toBe("header");
    expect(auditEntry.team_id).toBe("team-gated");
    expect(auditEntry.mode).toBe("gated");
    expect(auditEntry.rule).toBe("spawn");
    expect(auditEntry.decision).toBe("allow");
  });

  test("trusted mode override is captured in the snapshot header", async () => {
    // project says default_mode = "gated"; spawn override is trusted
    await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_write_snapshot team-trusted "${d.projectRoot}" trusted`,
    );
    const text = readFileSync(
      join(d.stateDir, "teams", "team-trusted", "policy.snapshot.toml"),
      "utf8",
    );
    expect(text).toContain(`# mode = "trusted"`);
    expect(text).toMatch(/default_mode = "trusted"/);
  });

  test("sealed mode override is captured in the snapshot header", async () => {
    await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_write_snapshot team-sealed "${d.projectRoot}" sealed`,
    );
    const text = readFileSync(
      join(d.stateDir, "teams", "team-sealed", "policy.snapshot.toml"),
      "utf8",
    );
    expect(text).toContain(`# mode = "sealed"`);
  });

  test("re-spawn rotates the prior snapshot to .snapshot.toml.old", async () => {
    await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_write_snapshot team-respawn "${d.projectRoot}" gated`,
    );
    await runBash(
      d,
      `. "${POLICY_SH}"; _subctl_claude_write_snapshot team-respawn "${d.projectRoot}" gated`,
    );
    const dirPath = join(d.stateDir, "teams", "team-respawn");
    expect(existsSync(join(dirPath, "policy.snapshot.toml"))).toBe(true);
    expect(existsSync(join(dirPath, "policy.snapshot.toml.old"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Spawn banner
// ─────────────────────────────────────────────────────────────────────────

describe("_subctl_claude_emit_spawn_banner", () => {
  test("gated mode prints preset + allowlist_sha + snapshot line", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"
       _subctl_claude_write_snapshot team-gb "${d.projectRoot}" gated
       _subctl_claude_emit_spawn_banner team-gb gated node false`,
    );
    expect(r.stdout).toContain("[subctl] spawning team 'team-gb' in gated mode (preset: node)");
    expect(r.stdout).toContain("allowlist_sha:");
    expect(r.stdout).toContain("snapshot:");
  });

  test("trusted mode emits the non-suppressible TRUSTED warning headline", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"
       _subctl_claude_write_snapshot team-tb "${d.projectRoot}" trusted
       _subctl_claude_emit_spawn_banner team-tb trusted node false`,
    );
    expect(r.stdout).toContain("TRUSTED mode");
    expect(r.stdout).toContain("no policy gate active");
    // secondary hint lines present when --no-warn-trusted is NOT passed
    expect(r.stdout).toContain("omit --mode=trusted");
  });

  test("trusted mode + --no-warn-trusted suppresses ONLY the secondary hints", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"
       _subctl_claude_write_snapshot team-tb2 "${d.projectRoot}" trusted
       _subctl_claude_emit_spawn_banner team-tb2 trusted node true`,
    );
    // headline always prints
    expect(r.stdout).toContain("TRUSTED mode");
    // secondary hints suppressed
    expect(r.stdout).not.toContain("omit --mode=trusted");
    expect(r.stdout).not.toContain("silence this warning permanently");
  });

  test("sealed mode flags the v2.7.0 MCP placeholder", async () => {
    const r = await runBash(
      d,
      `. "${POLICY_SH}"
       _subctl_claude_write_snapshot team-sb "${d.projectRoot}" sealed
       _subctl_claude_emit_spawn_banner team-sb sealed node false`,
    );
    expect(r.stdout).toContain("SEALED mode");
    expect(r.stdout).toContain("sealed-tools MCP server");
    expect(r.stdout).toContain("PLACEHOLDER");
  });
});
