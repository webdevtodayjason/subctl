// components/master/tools/policy/__tests__/snapshot.test.ts
//
// Tests for PR 7's snapshot writer/reader. Exercises the public surface
// (writePolicySnapshot / readPolicySnapshot / getSnapshotPath) against
// per-test temp project fixtures + a per-test SUBCTL_STATE_DIR so we never
// touch the operator's real ~/.local/state tree.
//
// Coverage targets from the PR 7 brief (8 minimum):
//   1. round-trip — write + read → metadata matches
//   2. header format starts with the expected comment block
//   3. TOML body parses cleanly via smol-toml
//   4. spawn-time mode override wins over policy file's default_mode
//   5. allowlist_sha is deterministic for same input
//   6. allowlist_sha changes when policy changes
//   7. re-spawn moves old snapshot to .snapshot.toml.old
//   8. SUBCTL_STATE_DIR env override is honored

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { getSnapshotPath, readPolicySnapshot, writePolicySnapshot } from "../snapshot";

const ORIG_STATE = process.env.SUBCTL_STATE_DIR;
const ORIG_CFG = process.env.SUBCTL_CONFIG_DIR;

function makeProject(extraPolicyToml = ""): string {
  const root = mkdtempSync(join(tmpdir(), "subctl-snap-proj-"));
  mkdirSync(join(root, ".subctl"));
  // Use preset="none" so we don't pick up shipped defaults; that keeps tests
  // hermetic against future preset changes.
  writeFileSync(
    join(root, ".subctl", "policy.toml"),
    `preset = "none"
default_mode = "gated"

[mode.gated]

[mode.gated.allow]
commands = ["ls", "pwd"]

[[mode.gated.allow_pattern]]
command = "git"
args = ["status", "diff", "log"]

[mode.gated.deny_always]
substrings = ["rm -rf"]
${extraPolicyToml}
`,
  );
  return root;
}

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "subctl-snap-state-"));
}

function makeEmptyConfig(): string {
  return mkdtempSync(join(tmpdir(), "subctl-snap-cfg-"));
}

let projectRoot: string;
let stateDir: string;
let cfgDir: string;

beforeEach(() => {
  projectRoot = makeProject();
  stateDir = makeStateDir();
  cfgDir = makeEmptyConfig();
  process.env.SUBCTL_STATE_DIR = stateDir;
  process.env.SUBCTL_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cfgDir, { recursive: true, force: true });
  if (ORIG_STATE === undefined) delete process.env.SUBCTL_STATE_DIR;
  else process.env.SUBCTL_STATE_DIR = ORIG_STATE;
  if (ORIG_CFG === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = ORIG_CFG;
});

describe("getSnapshotPath", () => {
  test("returns ~/.local/state/subctl/teams/<team>/policy.snapshot.toml by default", () => {
    delete process.env.SUBCTL_STATE_DIR;
    const p = getSnapshotPath("foo-team");
    expect(p).toContain("/.local/state/subctl/teams/foo-team/policy.snapshot.toml");
  });

  test("honors SUBCTL_STATE_DIR override", () => {
    const p = getSnapshotPath("foo-team");
    expect(p).toBe(join(stateDir, "teams", "foo-team", "policy.snapshot.toml"));
  });
});

describe("writePolicySnapshot", () => {
  test("round-trip: write + read returns identical metadata", async () => {
    const meta = await writePolicySnapshot("rt-team", projectRoot, "gated");
    const read = await readPolicySnapshot("rt-team");
    expect(read).not.toBeNull();
    expect(read!.meta.teamId).toBe(meta.teamId);
    expect(read!.meta.projectRoot).toBe(meta.projectRoot);
    expect(read!.meta.mode).toBe(meta.mode);
    expect(read!.meta.spawnedAt).toBe(meta.spawnedAt);
    expect(read!.meta.allowlistSha).toBe(meta.allowlistSha);
    expect(read!.meta.sourcePaths).toEqual(meta.sourcePaths);
    expect(read!.meta.snapshotPath).toBe(meta.snapshotPath);
  });

  test("snapshot file begins with the expected header comment block", async () => {
    await writePolicySnapshot("hdr-team", projectRoot, "gated");
    const raw = readFileSync(getSnapshotPath("hdr-team"), "utf8");
    const lines = raw.split("\n");
    expect(lines[0]).toBe("# subctl policy snapshot");
    expect(lines.some((l) => l.startsWith('# team_id = "hdr-team"'))).toBe(true);
    expect(lines.some((l) => l.startsWith('# mode = "gated"'))).toBe(true);
    expect(lines.some((l) => l.startsWith("# spawned_at = "))).toBe(true);
    expect(lines.some((l) => l.startsWith("# allowlist_sha = "))).toBe(true);
    expect(lines.some((l) => l.trim() === "# source_paths = [")).toBe(true);
  });

  test("TOML body (after the header) parses cleanly via smol-toml", async () => {
    await writePolicySnapshot("body-team", projectRoot, "gated");
    const raw = readFileSync(getSnapshotPath("body-team"), "utf8");
    // Drop every leading comment + blank line to isolate the body.
    const lines = raw.split("\n");
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t.startsWith("#") || t === "") { bodyStart = i + 1; continue; }
      break;
    }
    const body = lines.slice(bodyStart).join("\n");
    const parsed = parseToml(body) as Record<string, unknown>;
    expect(parsed.default_mode).toBe("gated");
    // `__meta` must not appear in the body (it's owned by the header)
    expect(parsed.__meta).toBeUndefined();
    expect((parsed.mode as Record<string, unknown>).gated).toBeDefined();
  });

  test("spawn-time mode override wins over policy file's default_mode", async () => {
    // The project policy declares default_mode = "gated"; we spawn with "trusted".
    await writePolicySnapshot("override-team", projectRoot, "trusted");
    const read = await readPolicySnapshot("override-team");
    expect(read).not.toBeNull();
    expect(read!.meta.mode).toBe("trusted");
    expect(read!.policy.default_mode).toBe("trusted");
  });

  test("allowlist_sha is deterministic for identical input", async () => {
    const a = await writePolicySnapshot("det-team-a", projectRoot, "gated");
    // Move the first snapshot out of the way then write again from the same
    // project. The header's spawned_at will differ but allowlist_sha must not.
    const b = await writePolicySnapshot("det-team-b", projectRoot, "gated");
    expect(a.allowlistSha).toBe(b.allowlistSha);
    expect(a.allowlistSha).toMatch(/^[0-9a-f]{8}$/);
  });

  test("allowlist_sha changes when policy content changes", async () => {
    const baseline = await writePolicySnapshot("sha-baseline", projectRoot, "gated");

    // Add a new substring to deny_always.
    writeFileSync(
      join(projectRoot, ".subctl", "policy.toml"),
      `preset = "none"
default_mode = "gated"

[mode.gated]

[mode.gated.allow]
commands = ["ls", "pwd"]

[[mode.gated.allow_pattern]]
command = "git"
args = ["status", "diff", "log"]

[mode.gated.deny_always]
substrings = ["rm -rf", "dd if="]
`,
    );

    const mutated = await writePolicySnapshot("sha-mutated", projectRoot, "gated");
    expect(mutated.allowlistSha).not.toBe(baseline.allowlistSha);
  });

  test("re-spawn: prior snapshot is moved to .snapshot.toml.old", async () => {
    await writePolicySnapshot("respawn-team", projectRoot, "gated");
    const path = getSnapshotPath("respawn-team");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.old`)).toBe(false);

    const firstContent = readFileSync(path, "utf8");
    // Wait a hair so spawned_at differs even on fast machines.
    await new Promise((r) => setTimeout(r, 5));
    await writePolicySnapshot("respawn-team", projectRoot, "gated");

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.old`)).toBe(true);
    const oldContent = readFileSync(`${path}.old`, "utf8");
    expect(oldContent).toBe(firstContent);
  });

  test("SUBCTL_STATE_DIR override is honored end-to-end", async () => {
    const meta = await writePolicySnapshot("env-team", projectRoot, "gated");
    expect(meta.snapshotPath).toContain(stateDir);
    expect(existsSync(meta.snapshotPath)).toBe(true);
  });

  test("readPolicySnapshot returns null when no snapshot exists", async () => {
    const r = await readPolicySnapshot("never-written");
    expect(r).toBeNull();
  });

  test("v2.7.9: project_root round-trips through the header", async () => {
    // The header should record the projectRoot the writer was called with,
    // and the reader should return the same string verbatim.
    const meta = await writePolicySnapshot("pr-team", projectRoot, "gated");
    expect(meta.projectRoot).toBe(projectRoot);
    const raw = readFileSync(getSnapshotPath("pr-team"), "utf8");
    expect(raw).toContain(`# project_root = ${JSON.stringify(projectRoot)}`);
    const read = await readPolicySnapshot("pr-team");
    expect(read).not.toBeNull();
    expect(read!.meta.projectRoot).toBe(projectRoot);
  });

  test("v2.7.9 back-compat: v2.7.8-style snapshot (no project_root) reads as projectRoot=''", async () => {
    // Hand-construct a snapshot exactly as v2.7.8 would have written it —
    // header omits the `# project_root = ...` line. The reader must not
    // throw; it must fall back to "".
    const path = getSnapshotPath("legacy-team");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `# subctl policy snapshot
# team_id = "legacy-team"
# spawned_at = "2026-05-11T00:00:00.000Z"
# mode = "gated"
# source_paths = []
# allowlist_sha = "deadbeef"

default_mode = "gated"

[mode]
[mode.gated]
[mode.gated.allow]
commands = ["ls"]
`,
    );
    // Silence the deprecation console.warn for this test only.
    const origWarn = console.warn;
    console.warn = () => {};
    let read: Awaited<ReturnType<typeof readPolicySnapshot>> = null;
    try {
      read = await readPolicySnapshot("legacy-team");
    } finally {
      console.warn = origWarn;
    }
    expect(read).not.toBeNull();
    expect(read!.meta.projectRoot).toBe("");
    expect(read!.meta.teamId).toBe("legacy-team");
    expect(read!.meta.mode).toBe("gated");
  });

  test("readPolicySnapshot throws on malformed body", async () => {
    // Create a corrupt snapshot manually.
    const path = getSnapshotPath("corrupt-team");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `# subctl policy snapshot
# team_id = "corrupt-team"
# spawned_at = "2026-05-11T00:00:00.000Z"
# mode = "gated"
# source_paths = []
# allowlist_sha = "deadbeef"

this is not [valid toml
`,
    );
    let threw = false;
    try {
      await readPolicySnapshot("corrupt-team");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
