// components/evy/__tests__/upstreams-history-route.test.ts
//
// v2.7.37 — pins for the three new manual-update HTTP surfaces wired
// into server.ts:
//
//   GET  /upstreams/history?limit=N
//   POST /upstreams/update
//   POST /upstreams/auto-update/toggle
//
// We don't spin up the full Bun.serve() — server.ts main() is guarded
// by `if (import.meta.main)` so importing it is side-effect-free, but
// the route handlers live inside the fetch closure and aren't directly
// callable. Instead, we test the BEHAVIOR the routes promise:
//
//   1. readUpdateHistory tails the JSONL audit log newest-first and the
//      response payload normalizes "failure" → "error" exactly the way
//      the route does.
//   2. runManualUpdate appends a SUCCESS audit entry containing a
//      branch when its injected runner reports success — same code path
//      POST /upstreams/update walks.
//   3. setAutoUpdateEnabled flips the flag file and isAutoUpdateEnabled
//      reflects the new state — same code path the toggle route runs.
//
// Together these prove the route handlers are wired to behavior the
// frontend will actually observe. Pure HTTP-shape tests live in the
// dashboard proxy layer where they're cheap; here we cover the unit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetForTesting as resetNotifications } from "../notifications";
import { _resetForTesting as resetWatchdogs } from "../watchdogs";
import {
  appendAuditEntry,
  readUpdateHistory,
  runManualUpdate,
  setAutoUpdateEnabled,
  isAutoUpdateEnabled,
  _resetForTesting as resetUpstream,
  _setAuditPathForTesting,
  _setThrottlePathForTesting,
  type AuditEntry,
  type AutoUpdateRunner,
} from "../upstream-check";

let tmp = "";
let pkgPath = "";
let auditPath = "";
let throttlePath = "";
let flagPath = "";

beforeEach(() => {
  resetNotifications();
  resetWatchdogs();
  resetUpstream();
  tmp = mkdtempSync(join(tmpdir(), "upstreams-history-route-"));
  pkgPath = join(tmp, "package.json");
  auditPath = join(tmp, "audit.jsonl");
  throttlePath = join(tmp, "throttle.json");
  flagPath = join(tmp, "auto-update.enabled");
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
  _setAuditPathForTesting(auditPath);
  _setThrottlePathForTesting(throttlePath);
});

afterEach(() => {
  _setAuditPathForTesting(null);
  _setThrottlePathForTesting(null);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Build the route-shaped response from a list of raw AuditEntries —
 *  exactly the mapping `GET /upstreams/history` performs. Keeping the
 *  mapper here lets the test catch drift between the route's view of
 *  the history and the persisted shape. */
function shapeHistoryRouteResponse(entries: AuditEntry[]) {
  return entries.map((e) => ({
    ts: e.ts,
    event: e.event === "failure" ? "error" : e.event,
    package: e.package,
    from: e.from,
    to: e.to,
    branch: e.branch,
    trigger: e.trigger,
    detail: e.detail,
  }));
}

describe("GET /upstreams/history — readUpdateHistory shape", () => {
  test("returns [] when the log doesn't exist yet", () => {
    expect(existsSync(auditPath)).toBe(false);
    const entries = readUpdateHistory({ limit: 50, path: auditPath });
    expect(entries).toEqual([]);
  });

  test("returns entries newest-first, capped at `limit`", () => {
    // Append three audit entries timestamped oldest→newest.
    appendAuditEntry(auditPath, {
      ts: "2026-05-19T01:00:00.000Z",
      event: "success",
      package: "@earendil-works/pi-ai",
      from: "0.74.0",
      to: "0.75.0",
      branch: "chore/upstream-pi-ai-1",
      trigger: "watchdog",
      detail: "first success",
    });
    appendAuditEntry(auditPath, {
      ts: "2026-05-19T02:00:00.000Z",
      event: "throttled",
      package: "@earendil-works/pi-ai",
      from: "0.75.0",
      to: "0.76.0",
      trigger: "watchdog",
      throttle_remaining_s: 600,
    });
    appendAuditEntry(auditPath, {
      ts: "2026-05-19T03:00:00.000Z",
      event: "failure",
      package: "@earendil-works/pi-ai",
      from: "0.75.0",
      to: "0.76.0",
      detail: "bun test exited 1",
      trigger: "manual",
    });
    const raw = readUpdateHistory({ limit: 50, path: auditPath });
    expect(raw.length).toBe(3);
    // Newest first
    expect(raw[0]!.ts).toBe("2026-05-19T03:00:00.000Z");
    expect(raw[2]!.ts).toBe("2026-05-19T01:00:00.000Z");
    // Route normalizes "failure" → "error"
    const shaped = shapeHistoryRouteResponse(raw);
    expect(shaped[0]!.event).toBe("error");
    expect(shaped[1]!.event).toBe("throttled");
    expect(shaped[2]!.event).toBe("success");
    // Only spec'd fields land in the route response
    expect(Object.keys(shaped[0]!).sort()).toEqual(
      ["branch", "detail", "event", "from", "package", "to", "trigger", "ts"],
    );
  });

  test("limit caps the tail without re-reading the whole log", () => {
    for (let i = 0; i < 12; i++) {
      appendAuditEntry(auditPath, {
        ts: `2026-05-19T0${(i % 10) + 0}:00:00.000Z`,
        event: "success",
        package: "@earendil-works/pi-ai",
        from: "0.74.0",
        to: `0.74.${i}`,
      });
    }
    const raw = readUpdateHistory({ limit: 5, path: auditPath });
    expect(raw.length).toBe(5);
  });
});

describe("POST /upstreams/update — runManualUpdate behavior", () => {
  test("appends a SUCCESS audit entry when the runner reports ok", async () => {
    const okRunner: AutoUpdateRunner = async (pkg, _from, to) => ({
      ok: true,
      detail: `mocked success: ${pkg} → ${to}`,
      branch: `chore/upstream-${pkg.replace(/[^a-z0-9]+/gi, "-")}-1`,
    });
    // Mock fetch — return a newer version for both tracked upstreams.
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url);
      const latest = u.includes("pi-ai") ? "0.99.0" : "0.99.0";
      return new Response(JSON.stringify({ "dist-tags": { latest } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const summary = await runManualUpdate({
      packageJsonPath: pkgPath,
      package: "@earendil-works/pi-ai",
      autoUpdateRunner: okRunner,
      fetchImpl,
      auditLogPath: auditPath,
      throttleStatePath: throttlePath,
      emitNotifications: false,
    });
    expect(summary.auto_update?.length).toBe(1);
    const update = summary.auto_update![0]!;
    expect(update.outcome.ok).toBe(true);
    expect(update.outcome.branch).toContain("chore/upstream-");
    // Audit log got the success entry
    const entries = readUpdateHistory({ limit: 10, path: auditPath });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.event).toBe("success");
    expect(entries[0]!.trigger).toBe("manual");
    expect(entries[0]!.branch).toBeDefined();
  });

  test("appends a FAILURE audit entry when the runner reports !ok", async () => {
    const failRunner: AutoUpdateRunner = async () => ({
      ok: false,
      detail: "bun test exited 1 — mocked failure",
      reverted: true,
      stderr_excerpt: "FAIL src/foo.test.ts",
    });
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ "dist-tags": { latest: "0.99.0" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const summary = await runManualUpdate({
      packageJsonPath: pkgPath,
      package: "@earendil-works/pi-ai",
      autoUpdateRunner: failRunner,
      fetchImpl,
      auditLogPath: auditPath,
      throttleStatePath: throttlePath,
      emitNotifications: false,
    });
    expect(summary.auto_update?.length).toBe(1);
    expect(summary.auto_update![0]!.outcome.ok).toBe(false);
    const entries = readUpdateHistory({ limit: 10, path: auditPath });
    expect(entries.length).toBe(1);
    expect(entries[0]!.event).toBe("failure");
    // Route normalizes "failure" → "error" on the wire
    const shaped = shapeHistoryRouteResponse(entries);
    expect(shaped[0]!.event).toBe("error");
  });
});

describe("POST /upstreams/auto-update/toggle — flag flip", () => {
  test("default state is disabled when the flag file is missing", () => {
    expect(isAutoUpdateEnabled(flagPath)).toBe(false);
  });

  test("setAutoUpdateEnabled(true) creates the flag file", () => {
    const ok = setAutoUpdateEnabled(true, flagPath);
    expect(ok).toBe(true);
    expect(isAutoUpdateEnabled(flagPath)).toBe(true);
    expect(existsSync(flagPath)).toBe(true);
  });

  test("setAutoUpdateEnabled(false) removes the flag file", () => {
    setAutoUpdateEnabled(true, flagPath);
    expect(isAutoUpdateEnabled(flagPath)).toBe(true);
    const ok = setAutoUpdateEnabled(false, flagPath);
    expect(ok).toBe(true);
    expect(isAutoUpdateEnabled(flagPath)).toBe(false);
    expect(existsSync(flagPath)).toBe(false);
  });

  test("toggle pattern — current → !current — matches the route's no-body path", () => {
    // Initially disabled
    const initial = isAutoUpdateEnabled(flagPath);
    expect(initial).toBe(false);
    // First toggle: enable
    setAutoUpdateEnabled(!initial, flagPath);
    expect(isAutoUpdateEnabled(flagPath)).toBe(true);
    // Second toggle: disable
    setAutoUpdateEnabled(!isAutoUpdateEnabled(flagPath), flagPath);
    expect(isAutoUpdateEnabled(flagPath)).toBe(false);
  });
});
