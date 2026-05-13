// components/master/__tests__/upstream-check.test.ts
//
// v2.7.25 — pins for the upstream-check watchdog.
//
// Coverage:
//   1. parseSemver + classifyBump + preserveCaret pure helpers
//   2. runUpstreamCheck against a mocked npm registry — emits the
//      right notification when latest > pinned, none when equal
//   3. auto-update gate gating — without the flag file, no
//      autoUpdateRunner call; with the flag set, the runner is
//      invoked and a follow-up notification fires
//   4. Test runner success ↔ failure paths emit info ↔ alert

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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
  _resetForTesting as resetUpstream,
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
});

afterEach(() => {
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
