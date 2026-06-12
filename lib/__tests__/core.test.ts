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

// ─────────────────────────────────────────────────────────────────────────
// W6.5 — SIGPIPE immunity under bin/subctl's `set -uo pipefail`
// ─────────────────────────────────────────────────────────────────────────
//
// Regression for the 2026-06-11 resolver failure: subctl_list_accounts is
// slow (5 _subctl_trim command substitutions per row), and piping it
// straight into an early-exit awk closed the pipe mid-write. The producer
// took SIGPIPE, pipefail turned the pipeline status into 141, and
// `resolved=$(subctl_resolve_alias …) || subctl_die "unknown account"`
// died even though the alias had already been printed and captured.
// Position-dependent: an alias EARLY in a long accounts.conf always lost
// the race (reproduced 5/5 on the pre-fix code with this exact fixture),
// while last-row aliases always won. These tests run the helpers under
// the same shell options bin/subctl sets, with the target on row 1 of a
// 50-row roster so the race is deterministic, and repeat each lookup to
// catch flaky scheduling.

function setupWideRoster(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "subctl-core-sigpipe-"));
  const configDir = join(root, "userconfig");
  mkdirSync(configDir, { recursive: true });
  const accountsConf = join(configDir, "accounts.conf");
  const rows = [
    "# 50-row roster — target EARLY so an early-exit awk races the producer",
    "openai-jason    | openai-codex | oj@example.com    | ~/.codex-jason     | the row that lost the race",
  ];
  for (let i = 1; i <= 49; i++) {
    rows.push(
      `claude-filler${i}  | claude       | f${i}@example.com   | ~/.claude-f${i}      | filler row ${i}`,
    );
  }
  writeFileSync(accountsConf, rows.join("\n") + "\n");
  return { root, accountsConf };
}

/** Run a core.sh snippet under bin/subctl's exact shell options. */
async function runUnderPipefail(d: Fixture, snippet: string): Promise<BashResult> {
  const proc = Bun.spawn(
    ["bash", "-c", `set -uo pipefail; source "${CORE_SH}"; ${snippet}`],
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

test("pipefail: early-row alias resolves with exit 0, every time (5/5)", async () => {
  d = setupWideRoster();
  for (let run = 1; run <= 5; run++) {
    const r = await runUnderPipefail(d, `subctl_resolve_alias openai-jason`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("openai-jason");
  }
});

test("pipefail: early-row field lookup returns the field with exit 0 (5/5)", async () => {
  d = setupWideRoster();
  for (let run = 1; run <= 5; run++) {
    const r = await runUnderPipefail(d, `subctl_account_field openai-jason 2`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("openai-codex");
  }
});

test("pipefail: the bin/subctl caller shape (capture || die) survives", async () => {
  d = setupWideRoster();
  // The exact consumption pattern that produced "unknown account": a
  // command substitution followed by `|| die`.
  const r = await runUnderPipefail(
    d,
    `resolved=$(subctl_resolve_alias openai-jason) || subctl_die "unknown account: openai-jason"; printf '%s\\n' "$resolved"`,
  );
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("openai-jason");
  expect(r.stderr).not.toContain("unknown account");
});

test("pipefail: bare→prefixed and prefixed→bare passes stay intact on the wide roster", async () => {
  d = setupWideRoster();
  // Bare → prefixed: filler1 → claude-filler1 (pass 2).
  const bare = await runUnderPipefail(d, `subctl_resolve_alias filler1`);
  expect(bare.code).toBe(0);
  expect(bare.stdout.trim()).toBe("claude-filler1");
  // No match still exits 1 with empty stdout (pass 3 falls through).
  const miss = await runUnderPipefail(d, `subctl_resolve_alias nope-never`);
  expect(miss.code).toBe(1);
  expect(miss.stdout.trim()).toBe("");
});
