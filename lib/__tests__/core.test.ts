// lib/__tests__/core.test.ts
//
// Unit tests for lib/core.sh account-registry helpers — specifically
// subctl_resolve_alias, whose contract is:
//   - exact alias match wins
//   - bare → prefixed: `personal` resolves to `claude-personal`
//   - prefixed → bare: `claude-dfox` resolves to alias `dfox` whose
//     provider is `claude` (dashboard-created profiles carry bare aliases;
//     operator muscle memory types provider-prefixed ones)
//   - no match → exit 1, so callers die with "unknown account: <name>"
//     instead of threading an empty alias into downstream field lookups
//     (the empty-alias leak produced the opaque error
//     "✗ account  is provider=, not claude" — 2026-06-11)
//
// Mirrors the providers/*/__tests__ harness shape: each test runs bash in a
// tmpdir with SUBCTL_ACCOUNTS_CONF pointed at a fixture accounts.conf.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CORE_SH = join(REPO_ROOT, "lib", "core.sh");

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  accountsConf: string;
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-core-"));
  const configDir = join(root, "userconfig");
  mkdirSync(configDir, { recursive: true });
  const accountsConf = join(configDir, "accounts.conf");
  // `|`-with-padding format, mirroring production accounts.conf.
  writeFileSync(
    accountsConf,
    [
      "# test accounts",
      "claude-jason    | claude       | jason@example.com | ~/.claude-jason    | prefixed alias",
      "dfox            | claude       | dfox@example.com  | ~/.claude-dfox     | bare alias (dashboard-created)",
      "openai-jason    | openai-codex | oj@example.com    | ~/.codex-jason     | codex account",
      "",
    ].join("\n"),
  );
  return { root, accountsConf };
}

async function resolveAlias(d: Fixture, want: string): Promise<BashResult> {
  const proc = Bun.spawn(
    ["bash", "-c", `source "${CORE_SH}"; subctl_resolve_alias "$1"`, "--", want],
    {
      env: {
        ...process.env,
        SUBCTL_REPO_ROOT: REPO_ROOT,
        SUBCTL_CONFIG_DIR: join(d.root, "userconfig"),
        SUBCTL_ACCOUNTS_CONF: d.accountsConf,
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

let d: Fixture;
afterEach(() => {
  rmSync(d.root, { recursive: true, force: true });
});

test("exact alias match resolves to itself", async () => {
  d = setup();
  const r = await resolveAlias(d, "claude-jason");
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("claude-jason");
});

test("bare name resolves to provider-prefixed alias", async () => {
  d = setup();
  const r = await resolveAlias(d, "jason");
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("claude-jason");
});

test("provider-prefixed name resolves to bare alias", async () => {
  d = setup();
  const r = await resolveAlias(d, "claude-dfox");
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("dfox");
});

test("prefixed → bare requires the provider to match", async () => {
  d = setup();
  // `openai-codex-dfox` would be provider openai-codex + alias dfox, but
  // dfox's provider is claude — must not resolve.
  const r = await resolveAlias(d, "openai-codex-dfox");
  expect(r.code).toBe(1);
  expect(r.stdout.trim()).toBe("");
});

test("unknown alias exits 1 with empty stdout", async () => {
  d = setup();
  const r = await resolveAlias(d, "claude-nope");
  expect(r.code).toBe(1);
  expect(r.stdout.trim()).toBe("");
});
