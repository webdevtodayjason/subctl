// components/master/__tests__/upstream-check.test.ts
//
// v2.7.25 — pins for the upstream-check watchdog.
// v2.7.37 — extended for auto-update worktree flow + throttle + audit.
//
// Coverage:
//   1. parseSemver + classifyBump + preserveCaret pure helpers
//   2. runUpstreamCheck against a mocked npm registry — emits the
//      right notification when latest > pinned, none when equal
//   3. auto-update gate gating — without the flag file, no
//      autoUpdateRunner call; with the flag set, the runner is
//      invoked and a follow-up notification fires
//   4. Test runner success ↔ failure paths emit info ↔ alert
//   5. v2.7.37: throttle skips a second tick inside the 24h window;
//      manual trigger (runManualUpdate) bypasses the throttle
//   6. v2.7.37: audit log records success/failure/throttled events;
//      readUpdateHistory returns newest-first
//   7. v2.7.37: worktree runner end-to-end with a mocked spawn that
//      simulates git + bun success and verifies the branch + push
//      commands fire in the right order
//   8. v2.7.37: setAutoUpdateEnabled writes/removes the flag file

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _resetForTesting as resetNotifications,
  listNotifications,
} from "../notifications";
import { _resetForTesting as resetWatchdogs } from "../watchdogs";
import {
  classifyBump,
  parseSemver,
  pinFloor,
  preserveCaret,
  readPinnedVersion,
  writePinnedVersion,
  runUpstreamCheck,
  runManualUpdate,
  worktreeAutoUpdateRunner,
  readUpdateHistory,
  readLastAttempt,
  writeLastAttempt,
  setAutoUpdateEnabled,
  isAutoUpdateEnabled,
  appendAuditEntry,
  _resetForTesting as resetUpstream,
  _setAuditPathForTesting,
  _setThrottlePathForTesting,
  type AutoUpdateRunner,
} from "../upstream-check";

let tmp = "";
let pkgPath = "";

beforeEach(() => {
  resetNotifications();
  resetWatchdogs();
  resetUpstream();
  tmp = mkdtempSync(join(tmpdir(), "upstream-check-"));
  pkgPath = join(tmp, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify(
      {
        name: "test-master",
        dependencies: {
          "@earendil-works/pi-agent-core": "^0.74.0",
          "@earendil-works/pi-ai": "^0.74.0",
        },
      },
      null,
      2,
    ),
  );
  // v2.7.37 — redirect the audit log + throttle state to tmpdir so the
  // tests don't share state with the real daemon (or with each other).
  _setAuditPathForTesting(join(tmp, "audit.jsonl"));
  _setThrottlePathForTesting(join(tmp, "throttle.json"));
});

afterEach(() => {
  _setAuditPathForTesting(null);
  _setThrottlePathForTesting(null);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  resetNotifications();
  resetWatchdogs();
  resetUpstream();
});

describe("semver helpers", () => {
  test("parseSemver handles `^x.y.z`, `~x.y.z`, plain `x.y.z`", () => {
    expect(parseSemver("0.74.0")).toEqual({ major: 0, minor: 74, patch: 0 });
    expect(parseSemver("^0.74.0")).toEqual({ major: 0, minor: 74, patch: 0 });
    expect(parseSemver("~1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("v2.0.1")).toEqual({ major: 2, minor: 0, patch: 1 });
  });

  test("parseSemver tolerates pre-release / build suffixes", () => {
    expect(parseSemver("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("1.2.3+build.7")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("parseSemver returns null for garbage", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });

  test("classifyBump labels patch / minor / major / same", () => {
    expect(classifyBump("0.74.0", "0.74.0")).toBe("same");
    expect(classifyBump("0.74.0", "0.74.1")).toBe("patch");
    expect(classifyBump("0.74.0", "0.75.0")).toBe("minor");
    expect(classifyBump("0.74.0", "1.0.0")).toBe("major");
    expect(classifyBump("0.74.5", "0.74.3")).toBe("same"); // downgrade → same
    expect(classifyBump("abc", "0.74.0")).toBe("unknown");
  });

  test("pinFloor strips operators", () => {
    expect(pinFloor("^0.74.0")).toBe("0.74.0");
    expect(pinFloor("~1.2.3")).toBe("1.2.3");
    expect(pinFloor("=2.0.0")).toBe("2.0.0");
    expect(pinFloor("0.74.0")).toBe("0.74.0");
    expect(pinFloor("")).toBe("");
  });

  test("preserveCaret keeps the operator on the new version", () => {
    expect(preserveCaret("^0.74.0", "0.75.0")).toBe("^0.75.0");
    expect(preserveCaret("~0.74.0", "0.75.0")).toBe("~0.75.0");
    expect(preserveCaret("0.74.0", "0.75.0")).toBe("0.75.0");
  });
});

describe("readPinnedVersion / writePinnedVersion", () => {
  test("reads from dependencies", () => {
    expect(readPinnedVersion(pkgPath, "@earendil-works/pi-ai")).toBe("^0.74.0");
  });

  test("returns empty string when missing", () => {
    expect(readPinnedVersion(pkgPath, "not-installed")).toBe("");
  });

  test("writePinnedVersion round-trips through the file", () => {
    writePinnedVersion(pkgPath, "@earendil-works/pi-ai", "^0.75.0");
    const next = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(next.dependencies["@earendil-works/pi-ai"]).toBe("^0.75.0");
  });

  test("writePinnedVersion throws when the package isn't in any dep section", () => {
    expect(() => writePinnedVersion(pkgPath, "not-installed", "1.0.0")).toThrow();
  });
});

describe("runUpstreamCheck against a mocked registry", () => {
  // Build a fetch impl that returns dist-tags.latest for whichever
  // packages the test wants. URL form: /<pkg>?…  (the module
  // url-encodes the leading @).
  function mockRegistry(latest: Record<string, string>): typeof fetch {
    return (async (input: any) => {
      const url = String(input);
      const slash = url.lastIndexOf("/");
      const pkgEncoded = url.slice(slash + 1);
      const pkg = decodeURIComponent(pkgEncoded);
      // The url path is /<scope>/<name>; we want the full scoped name.
      // Strip the registry base so we get "@earendil-works/pi-ai".
      const lastSegMatch = url.match(/\/(@[^/]+\/[^/?#]+)/);
      const scoped = lastSegMatch ? lastSegMatch[1]! : pkg;
      const v = latest[scoped];
      if (!v) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ "dist-tags": { latest: v } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  test("emits a single info notification for a minor bump", async () => {
    const summary = await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateFlagPath: join(tmp, "no-flag-here"),
    });
    const piAi = summary.results.find((r) => r.package === "@earendil-works/pi-ai");
    expect(piAi).toBeDefined();
    expect(piAi!.has_update).toBe(true);
    expect(piAi!.pinned).toBe("0.74.0");
    expect(piAi!.latest).toBe("0.75.0");
    expect(piAi!.bump_kind).toBe("minor");
    const ns = listNotifications();
    expect(ns.length).toBe(1);
    expect(ns[0]!.kind).toBe("upstream-available");
    expect(ns[0]!.severity).toBe("info");
    expect(ns[0]!.title).toContain("pi-ai 0.74.0 → 0.75.0");
    expect(ns[0]!.metadata?.bump_kind).toBe("minor");
  });

  test("major bump notification has severity=warn", async () => {
    const summary = await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "1.0.0",
      }),
      autoUpdateFlagPath: join(tmp, "no-flag-here"),
    });
    const piAi = summary.results.find((r) => r.package === "@earendil-works/pi-ai");
    expect(piAi!.bump_kind).toBe("major");
    const ns = listNotifications();
    const piAiNotif = ns.find((n) => n.metadata?.package === "@earendil-works/pi-ai");
    expect(piAiNotif!.severity).toBe("warn");
  });

  test("emits NO notification when versions match", async () => {
    await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.74.0",
      }),
      autoUpdateFlagPath: join(tmp, "no-flag-here"),
    });
    expect(listNotifications().length).toBe(0);
  });

  test("emits warn when registry fetch fails — caller continues", async () => {
    const summary = await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
      autoUpdateFlagPath: join(tmp, "no-flag-here"),
    });
    // Both results carry an error; no upstream-available notifications.
    expect(summary.results.every((r) => !!r.error)).toBe(true);
    expect(listNotifications().filter((n) => n.kind === "upstream-available").length).toBe(0);
  });
});

describe("auto-update gate", () => {
  function mockRegistry(latest: Record<string, string>): typeof fetch {
    return (async (input: any) => {
      const url = String(input);
      const lastSegMatch = url.match(/\/(@[^/]+\/[^/?#]+)/);
      const scoped = lastSegMatch ? lastSegMatch[1]! : url;
      const v = latest[scoped];
      if (!v) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ "dist-tags": { latest: v } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  test("without the flag file, autoUpdateRunner is NOT called", async () => {
    let called = false;
    const runner: AutoUpdateRunner = async () => {
      called = true;
      return { ok: true, detail: "should not have been called" };
    };
    await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateFlagPath: join(tmp, "absent-flag"),
      autoUpdateRunner: runner,
    });
    expect(called).toBe(false);
    // The manual-mode "upstream-available" notification fires instead.
    expect(listNotifications().some((n) => n.kind === "upstream-available")).toBe(
      true,
    );
  });

  test("with the flag set, runner runs and package.json is updated on success", async () => {
    const flag = join(tmp, "auto-update-upstreams.enabled");
    writeFileSync(flag, "");
    const runner: AutoUpdateRunner = async (pkg, _from, to, path) => {
      // Simulate the install + test pass + commit-pin step.
      writePinnedVersion(path, pkg, to);
      return { ok: true, detail: "fake install + test pass" };
    };
    const summary = await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateFlagPath: flag,
      autoUpdateRunner: runner,
    });
    expect(summary.auto_update).toBeDefined();
    expect(summary.auto_update!.length).toBe(1);
    expect(summary.auto_update![0]!.outcome.ok).toBe(true);

    // package.json has the new spec.
    const next = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(next.dependencies["@earendil-works/pi-ai"]).toBe("^0.75.0");

    // Notifications: an "upstream-auto-updated" info should fire.
    const auto = listNotifications().find((n) => n.kind === "upstream-auto-updated");
    expect(auto).toBeDefined();
    expect(auto!.severity).toBe("info");
    expect(auto!.title).toContain("auto-updated");
  });

  test("with the flag set, failed tests emit alert and the package.json is reverted by the runner", async () => {
    const flag = join(tmp, "auto-update-upstreams.enabled");
    writeFileSync(flag, "");
    const runner: AutoUpdateRunner = async (pkg, from, to, path) => {
      // Simulate "tests failed; reverted".
      writePinnedVersion(path, pkg, to);
      writePinnedVersion(path, pkg, from);
      return { ok: false, detail: "bun test exited 1", reverted: true };
    };
    await runUpstreamCheck({
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateFlagPath: flag,
      autoUpdateRunner: runner,
      throttleStatePath: join(tmp, "throttle.json"),
      auditLogPath: join(tmp, "audit.jsonl"),
    });
    // package.json is back where it started.
    const next = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(next.dependencies["@earendil-works/pi-ai"]).toBe("^0.74.0");
    // Alert notification fires.
    const failed = listNotifications().find((n) => n.kind === "upstream-update-failed");
    expect(failed).toBeDefined();
    expect(failed!.severity).toBe("alert");
    expect(failed!.metadata?.reverted).toBe(true);
  });
});

// ─── v2.7.37 — throttle ────────────────────────────────────────────────────
describe("v2.7.37 throttle", () => {
  function mockRegistry(latest: Record<string, string>): typeof fetch {
    return (async (input: any) => {
      const url = String(input);
      const lastSegMatch = url.match(/\/(@[^/]+\/[^/?#]+)/);
      const scoped = lastSegMatch ? lastSegMatch[1]! : url;
      const v = latest[scoped];
      if (!v) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ "dist-tags": { latest: v } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  test("second tick within the throttle window does NOT call the runner", async () => {
    const flag = join(tmp, "auto-update.enabled");
    writeFileSync(flag, "");
    const throttleFile = join(tmp, "throttle.json");
    const auditFile = join(tmp, "audit.jsonl");
    let calls = 0;
    const runner: AutoUpdateRunner = async (pkg, _from, to, path) => {
      calls += 1;
      writePinnedVersion(path, pkg, to);
      return { ok: true, detail: "fake success" };
    };
    const opts = {
      packageJsonPath: pkgPath,
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateFlagPath: flag,
      autoUpdateRunner: runner,
      throttleStatePath: throttleFile,
      auditLogPath: auditFile,
    };
    await runUpstreamCheck(opts);
    expect(calls).toBe(1);
    // Revert pkg back so the next tick still sees a "newer available"
    // (otherwise classifyBump=same skips the auto-update branch
    // entirely and the throttle test wouldn't exercise the gate).
    writePinnedVersion(pkgPath, "@earendil-works/pi-ai", "^0.74.0");
    // Second tick — same window, same packages.
    await runUpstreamCheck(opts);
    expect(calls).toBe(1); // still 1 — the throttle skipped it
    // Audit log carries the throttle event for the second tick.
    const history = readUpdateHistory({ path: auditFile, limit: 10 });
    const throttled = history.find((h) => h.event === "throttled");
    expect(throttled).toBeDefined();
    expect(throttled!.package).toBe("@earendil-works/pi-ai");
  });

  test("manual trigger (runManualUpdate) bypasses the throttle", async () => {
    const flag = join(tmp, "auto-update.enabled");
    writeFileSync(flag, "");
    const throttleFile = join(tmp, "throttle.json");
    const auditFile = join(tmp, "audit.jsonl");
    let calls = 0;
    const runner: AutoUpdateRunner = async (pkg, _from, to, path) => {
      calls += 1;
      writePinnedVersion(path, pkg, to);
      return { ok: true, detail: "manual run" };
    };
    // Pre-populate throttle as if we just ran 1m ago.
    writeLastAttempt("@earendil-works/pi-ai", Date.now() - 60_000, throttleFile);
    const summary = await runManualUpdate({
      packageJsonPath: pkgPath,
      package: "@earendil-works/pi-ai",
      fetchImpl: mockRegistry({
        "@earendil-works/pi-agent-core": "0.74.0",
        "@earendil-works/pi-ai": "0.75.0",
      }),
      autoUpdateRunner: runner,
      throttleStatePath: throttleFile,
      auditLogPath: auditFile,
    });
    expect(calls).toBe(1);
    expect(summary.auto_update).toBeDefined();
    expect(summary.auto_update![0]!.outcome.ok).toBe(true);
    const history = readUpdateHistory({ path: auditFile, limit: 10 });
    const manual = history.find((h) => h.trigger === "manual");
    expect(manual).toBeDefined();
  });

  test("readLastAttempt + writeLastAttempt round-trip", () => {
    const f = join(tmp, "throttle-rt.json");
    expect(readLastAttempt("foo", f)).toBeNull();
    writeLastAttempt("foo", 12345, f);
    expect(readLastAttempt("foo", f)).toBe(12345);
    writeLastAttempt("bar", 67890, f);
    expect(readLastAttempt("foo", f)).toBe(12345);
    expect(readLastAttempt("bar", f)).toBe(67890);
  });
});

// ─── v2.7.37 — audit log ───────────────────────────────────────────────────
describe("v2.7.37 audit log", () => {
  test("appendAuditEntry + readUpdateHistory return newest first", () => {
    const p = join(tmp, "audit.jsonl");
    appendAuditEntry(p, {
      ts: "2026-05-13T00:00:00Z",
      event: "success",
      package: "@x/a",
      from: "1.0.0",
      to: "1.0.1",
    });
    appendAuditEntry(p, {
      ts: "2026-05-13T01:00:00Z",
      event: "failure",
      package: "@x/b",
      from: "1.0.0",
      to: "1.0.1",
      detail: "tests broke",
    });
    const h = readUpdateHistory({ path: p, limit: 10 });
    expect(h.length).toBe(2);
    expect(h[0]!.package).toBe("@x/b"); // newest first
    expect(h[1]!.package).toBe("@x/a");
  });

  test("readUpdateHistory tolerates a missing audit file", () => {
    expect(readUpdateHistory({ path: join(tmp, "no-such-file") })).toEqual([]);
  });

  test("readUpdateHistory honors limit", () => {
    const p = join(tmp, "limit.jsonl");
    for (let i = 0; i < 30; i += 1) {
      appendAuditEntry(p, {
        ts: new Date(2026, 0, 1, 0, i).toISOString(),
        event: "success",
        package: "@x/p",
        from: "1.0.0",
        to: "1.0." + (i + 1),
      });
    }
    expect(readUpdateHistory({ path: p, limit: 5 }).length).toBe(5);
    // Newest first → the last appended entry comes back first.
    const top = readUpdateHistory({ path: p, limit: 1 })[0]!;
    expect(top.to).toBe("1.0.30");
  });
});

// ─── v2.7.37 — auto-update flag toggle ─────────────────────────────────────
describe("v2.7.37 auto-update flag", () => {
  test("setAutoUpdateEnabled writes/removes the flag file", () => {
    const flag = join(tmp, "auto-update.enabled");
    expect(isAutoUpdateEnabled(flag)).toBe(false);
    expect(setAutoUpdateEnabled(true, flag)).toBe(true);
    expect(isAutoUpdateEnabled(flag)).toBe(true);
    expect(setAutoUpdateEnabled(false, flag)).toBe(true);
    expect(isAutoUpdateEnabled(flag)).toBe(false);
    // Idempotent — disabling a non-existent flag returns ok.
    expect(setAutoUpdateEnabled(false, flag)).toBe(true);
  });
});

// ─── v2.7.37 — worktree runner end-to-end (mocked spawn) ──────────────────
//
// We can't shell out to a real git + bun in the unit-test sandbox —
// that would hit the real registry and write to the real repo. Mock
// Bun.spawn to a "fake shell" that records every command and returns
// a canned (code, stdout, stderr) for each step. The test then
// verifies the runner walked through worktree-add → write-pin →
// install → test → build → typecheck → add → commit → push in the
// right order, with the right branch name in the push command.
describe("v2.7.37 worktreeAutoUpdateRunner", () => {
  function fakeSpawn(scripted: Array<{
    match: (cmd: string[]) => boolean;
    code: number;
    stdout?: string;
    stderr?: string;
  }>): { spawn: typeof Bun.spawn; calls: string[][] } {
    const calls: string[][] = [];
    const spawn = ((opts: any) => {
      calls.push([...opts.cmd]);
      const hit = scripted.find((s) => s.match(opts.cmd));
      const code = hit ? hit.code : 0;
      const stdout = hit?.stdout ?? "";
      const stderr = hit?.stderr ?? "";
      // Minimal proc shape used by the runner.
      return {
        stdout: new Response(stdout).body!,
        stderr: new Response(stderr).body!,
        exited: Promise.resolve(code),
        kill: () => {},
      } as any;
    }) as unknown as typeof Bun.spawn;
    return { spawn, calls };
  }

  test("success path commits + pushes a chore/upstream-<pkg>-<ts> branch", async () => {
    // Make the worktree dir match the layout the runner expects:
    //   <repoRoot>/components/master/package.json
    const repoRoot = mkdtempSync(join(tmpdir(), "wt-repo-"));
    mkdirSync(join(repoRoot, "components", "master"), { recursive: true });
    const wtPkg = join(repoRoot, "components", "master", "package.json");
    writeFileSync(
      wtPkg,
      JSON.stringify(
        {
          name: "test-master",
          dependencies: {
            "@earendil-works/pi-ai": "^0.74.0",
          },
        },
        null,
        2,
      ),
    );

    const { spawn, calls } = fakeSpawn([
      // worktree add — the runner uses this for both `git rev-parse`
      // and `git worktree add`; both return ok=0.
      { match: (c) => c[0] === "git" && c[1] === "rev-parse", code: 0, stdout: repoRoot + "\n" },
      { match: (c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add", code: 0 },
      { match: (c) => c[0] === "bun" && c[1] === "install", code: 0 },
      { match: (c) => c[0] === "bun" && c[1] === "test", code: 0 },
      { match: (c) => c[0] === "bun" && c[1] === "run" && c[3] === "build", code: 0 },
      { match: (c) => c[0] === "bun" && c[1] === "x" && c[2] === "tsc", code: 0 },
      { match: (c) => c[0] === "git" && c[1] === "add", code: 0 },
      { match: (c) => c[0] === "git" && c[1] === "commit", code: 0 },
      { match: (c) => c[0] === "git" && c[1] === "push", code: 0 },
    ]);
    // Force a writePinnedVersion to actually succeed against the
    // simulated worktree dir — that's where the runner writes.
    // The runner computes `wtPackageJson = join(worktreePath,
    // <componentDir relative to repoRoot>)` and writes there. We
    // need that dir to exist so the write doesn't ENOENT.
    const worktreeBase = mkdtempSync(join(tmpdir(), "wt-base-"));
    // The runner derives the worktree path from `now()`; precreate
    // the target dirs by intercepting the now() and pre-mkdir'ing.
    const fixedNow = 1700000000000;
    const expectedWorktree = join(worktreeBase, "subctl-upstream-update-" + fixedNow);
    mkdirSync(join(expectedWorktree, "components", "master"), { recursive: true });
    writeFileSync(
      join(expectedWorktree, "components", "master", "package.json"),
      JSON.stringify(
        { name: "wt", dependencies: { "@earendil-works/pi-ai": "^0.74.0" } },
        null,
        2,
      ),
    );

    const runner = worktreeAutoUpdateRunner({
      repoRoot,
      worktreeBaseDir: worktreeBase,
      spawn,
      now: () => fixedNow,
    });
    const outcome = await runner(
      "@earendil-works/pi-ai",
      "^0.74.0",
      "^0.75.0",
      wtPkg,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.branch).toMatch(/^chore\/upstream-.*pi-ai.*-1700000000000$/);
    expect(outcome.worktree_path).toBe(expectedWorktree);

    // Verify the command order — at minimum, worktree add must come
    // before bun install, and push must come last.
    const cmdNames = calls.map((c) => c[0] + " " + (c[1] || ""));
    const idxWorktreeAdd = cmdNames.findIndex((s) => s === "git worktree");
    const idxInstall = cmdNames.findIndex((s) => s === "bun install");
    const idxPush = cmdNames.findIndex((s) => s === "git push");
    expect(idxWorktreeAdd).toBeGreaterThanOrEqual(0);
    expect(idxInstall).toBeGreaterThan(idxWorktreeAdd);
    expect(idxPush).toBeGreaterThan(idxInstall);

    // The push command must NOT touch main, must NOT force.
    const pushCmd = calls.find((c) => c[0] === "git" && c[1] === "push")!;
    expect(pushCmd.some((arg) => arg === "--force" || arg === "-f")).toBe(false);
    expect(pushCmd.some((arg) => arg === "main" || arg === "main:main")).toBe(
      false,
    );
    // Cleanup
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeBase, { recursive: true, force: true });
  });

  test("failure during bun test reverts the worktree + propagates stderr_excerpt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wt-repo-fail-"));
    mkdirSync(join(repoRoot, "components", "master"), { recursive: true });
    const wtPkg = join(repoRoot, "components", "master", "package.json");
    writeFileSync(
      wtPkg,
      JSON.stringify(
        {
          name: "test-master",
          dependencies: { "@earendil-works/pi-ai": "^0.74.0" },
        },
        null,
        2,
      ),
    );
    const worktreeBase = mkdtempSync(join(tmpdir(), "wt-base-fail-"));
    const fixedNow = 1700000000001;
    const expectedWorktree = join(worktreeBase, "subctl-upstream-update-" + fixedNow);
    mkdirSync(join(expectedWorktree, "components", "master"), { recursive: true });
    writeFileSync(
      join(expectedWorktree, "components", "master", "package.json"),
      JSON.stringify(
        { name: "wt", dependencies: { "@earendil-works/pi-ai": "^0.74.0" } },
        null,
        2,
      ),
    );
    const { spawn, calls } = fakeSpawn([
      { match: (c) => c[0] === "git" && c[1] === "rev-parse", code: 0, stdout: repoRoot + "\n" },
      { match: (c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add", code: 0 },
      { match: (c) => c[0] === "bun" && c[1] === "install", code: 0 },
      // bun test FAILS with a chunky stderr.
      {
        match: (c) => c[0] === "bun" && c[1] === "test",
        code: 1,
        stderr: "FAIL components/master/__tests__/upstream-check.test.ts\n  expected 0.75.0, received 0.74.0\n",
      },
      { match: (c) => c[0] === "git" && c[1] === "worktree" && c[2] === "remove", code: 0 },
      { match: (c) => c[0] === "git" && c[1] === "branch" && c[2] === "-D", code: 0 },
    ]);
    const runner = worktreeAutoUpdateRunner({
      repoRoot,
      worktreeBaseDir: worktreeBase,
      spawn,
      now: () => fixedNow,
    });
    const outcome = await runner(
      "@earendil-works/pi-ai",
      "^0.74.0",
      "^0.75.0",
      wtPkg,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("bun test exited 1");
    expect(outcome.reverted).toBe(true);
    expect(outcome.stderr_excerpt).toContain("FAIL");
    // The cleanup steps fired.
    const cmdNames = calls.map((c) => c.slice(0, 3).join(" "));
    expect(cmdNames.some((s) => s.startsWith("git worktree remove"))).toBe(true);
    expect(cmdNames.some((s) => s.startsWith("git branch -D"))).toBe(true);
    // And NO push happened.
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktreeBase, { recursive: true, force: true });
  });
});
