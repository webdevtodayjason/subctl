// providers/claude/__tests__/integration/hook.test.ts
//
// Verifies the per-team `settings.local.json` body that
// _subctl_claude_write_settings_local stages in the worker's cfg_dir.
// Coverage matches pack 08 §2.3 (Gated) and §2.5 (Sealed) + the Trusted-mode
// behavior (no hook, defang stays).
//
// Defang preservation (HANDOFF_DIGEST §3.1 D9) is asserted EXPLICITLY for
// every mode — if a future edit accidentally removes
// `permissions.defaultMode = "bypassPermissions"` these tests fail loud.

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

interface FixtureDirs {
  projectRoot: string;
  cfgDir: string;
  stateDir: string;
  configDir: string;
  fakeBin: string;
  fakeSubctl: string;
}

function setup(): FixtureDirs {
  const root = mkdtempSync(join(tmpdir(), "subctl-pr10-hook-"));
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

  return { projectRoot, cfgDir, stateDir, configDir, fakeBin, fakeSubctl };
}

async function writeSettings(d: FixtureDirs, mode: string, teamId: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `. "${POLICY_SH}"; _subctl_claude_write_settings_local "${d.cfgDir}" "${mode}" "${teamId}" "${d.projectRoot}"`,
    ],
    {
      env: {
        ...process.env,
        SUBCTL_REPO_ROOT: REPO_ROOT,
        SUBCTL_STATE_DIR: d.stateDir,
        SUBCTL_CONFIG_DIR: d.configDir,
        SUBCTL_POLICY_CHECK_BIN: d.fakeBin,
        SUBCTL_BIN: d.fakeSubctl,
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`writeSettings failed (code=${code}): ${err}`);
  }
}

function readSettings(d: FixtureDirs): any {
  const path = join(d.cfgDir, "settings.local.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

let d: FixtureDirs;
beforeEach(() => {
  d = setup();
});
afterEach(() => {
  rmSync(d.projectRoot, { recursive: true, force: true });
  rmSync(d.cfgDir, { recursive: true, force: true });
  rmSync(d.stateDir, { recursive: true, force: true });
  rmSync(d.configDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Trusted mode — defang stays, no hook
// ─────────────────────────────────────────────────────────────────────────

describe("settings.local.json — trusted mode", () => {
  test("writes only permissions.defaultMode (defang) — no hook injected", async () => {
    await writeSettings(d, "trusted", "team-trusted");
    const json = readSettings(d);
    expect(json.permissions.defaultMode).toBe("bypassPermissions");
    expect(json.hooks).toBeUndefined();
    expect(json.mcpServers).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gated mode — defang + hook (this is THE gate)
// ─────────────────────────────────────────────────────────────────────────

describe("settings.local.json — gated mode", () => {
  test("defang preserved + PreToolUse hook injected", async () => {
    await writeSettings(d, "gated", "foothold-v3");
    const json = readSettings(d);

    // Defang (D9) — must still be present
    expect(json.permissions.defaultMode).toBe("bypassPermissions");

    // Hook shape per pack 08 §2.3
    expect(json.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(json.hooks.PreToolUse.length).toBe(1);
    const entry = json.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("Bash");
    expect(entry.hooks).toBeInstanceOf(Array);
    expect(entry.hooks.length).toBe(1);
    expect(entry.hooks[0].type).toBe("command");

    const cmd = entry.hooks[0].command;
    expect(cmd).toContain(d.fakeBin);
    expect(cmd).toContain("--team=foothold-v3");
    expect(cmd).toContain(`--project-root=${d.projectRoot}`);
    // no --mode flag in gated (the binary defaults to gated)
    expect(cmd).not.toContain("--mode=");

    // No sealed-tools MCP server in gated mode
    expect(json.mcpServers).toBeUndefined();
    // permissions.deny must NOT include Bash in gated mode
    expect(json.permissions.deny).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sealed mode — defang + deny + hook with --mode=sealed + MCP server
// ─────────────────────────────────────────────────────────────────────────

describe("settings.local.json — sealed mode", () => {
  test("defang preserved, deny=[Bash], hook with --mode=sealed, MCP server registered", async () => {
    await writeSettings(d, "sealed", "foothold-v3");
    const json = readSettings(d);

    // Defang (D9) — STILL present in sealed mode (per the §3.1 table)
    expect(json.permissions.defaultMode).toBe("bypassPermissions");

    // Sealed-mode bash denial
    expect(json.permissions.deny).toEqual(["Bash"]);

    // Hook shape with --mode=sealed (always-deny)
    const cmd = json.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("--team=foothold-v3");
    expect(cmd).toContain("--mode=sealed");

    // MCP server registration
    expect(json.mcpServers["subctl-sealed-tools"]).toBeDefined();
    expect(json.mcpServers["subctl-sealed-tools"].command).toBe(d.fakeSubctl);
    expect(json.mcpServers["subctl-sealed-tools"].args).toEqual([
      "mcp",
      "sealed-tools",
      "--team=foothold-v3",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Merge semantics — never clobber operator content
// ─────────────────────────────────────────────────────────────────────────

describe("settings.local.json — merge with existing content", () => {
  test("preserves operator-authored mcpServers entries (other servers)", async () => {
    // Operator already has a custom MCP server registered.
    writeFileSync(
      join(d.cfgDir, "settings.local.json"),
      JSON.stringify({
        mcpServers: {
          "my-custom-mcp": { command: "/usr/local/bin/foo", args: ["bar"] },
        },
      }),
    );
    await writeSettings(d, "sealed", "foothold-v3");
    const json = readSettings(d);
    expect(json.mcpServers["my-custom-mcp"]).toEqual({
      command: "/usr/local/bin/foo",
      args: ["bar"],
    });
    expect(json.mcpServers["subctl-sealed-tools"]).toBeDefined();
  });

  test("preserves non-Bash PreToolUse hook entries the operator added", async () => {
    writeFileSync(
      join(d.cfgDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "/usr/local/bin/read-audit.sh" }],
            },
          ],
        },
      }),
    );
    await writeSettings(d, "gated", "foothold-v3");
    const json = readSettings(d);
    // Should have BOTH the operator's Read hook and the subctl Bash hook.
    const matchers = json.hooks.PreToolUse.map((e: any) => e.matcher).sort();
    expect(matchers).toEqual(["Bash", "Read"]);
  });

  test("re-spawn replaces the prior subctl Bash hook (idempotent, no dupes)", async () => {
    await writeSettings(d, "gated", "foothold-v3");
    await writeSettings(d, "gated", "foothold-v3");
    const json = readSettings(d);
    const bashEntries = json.hooks.PreToolUse.filter((e: any) => e.matcher === "Bash");
    expect(bashEntries.length).toBe(1);
  });

  test("re-spawn with different team_id replaces, not appends, the subctl hook", async () => {
    await writeSettings(d, "gated", "team-a");
    await writeSettings(d, "gated", "team-b");
    const json = readSettings(d);
    const bashEntries = json.hooks.PreToolUse.filter((e: any) => e.matcher === "Bash");
    expect(bashEntries.length).toBe(1);
    const cmd = bashEntries[0].hooks[0].command;
    expect(cmd).toContain("--team=team-b");
    expect(cmd).not.toContain("--team=team-a");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Defang preservation — explicit cross-mode invariant
// ─────────────────────────────────────────────────────────────────────────

describe("DEFANG STAYS (HANDOFF_DIGEST §3.1 D9)", () => {
  for (const mode of ["trusted", "gated", "sealed"] as const) {
    test(`${mode} mode: permissions.defaultMode === bypassPermissions`, async () => {
      await writeSettings(d, mode, "defang-team");
      const json = readSettings(d);
      expect(json.permissions.defaultMode).toBe("bypassPermissions");
    });
  }
});
