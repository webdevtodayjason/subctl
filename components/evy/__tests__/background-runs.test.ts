// v2.8.10 — background-task runtime tests
//
// Covers: start → complete cycle, start → fail cycle, cancel, drain
// semantics (one-shot, idempotent-after-drain), hydration (orphan
// running → failed), prepend formatter (empty vs populated, status
// mix).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startBackgroundRun,
  getRun,
  listRuns,
  cancelRun,
  drainPendingForNextTurn,
  formatPrependForOperator,
  hydrateFromSidecar,
  _setDepsForTesting,
  _resetDepsForTesting,
  _resetStateForTesting,
  type BackgroundRun,
} from "../background-runs";

interface FakeSidecar {
  store: { version: 1; runs: BackgroundRun[] } | null;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fakeSidecar: FakeSidecar;
let notifications: Array<{
  kind: string;
  severity: string;
  title: string;
  body: string;
}>;

beforeEach(() => {
  _resetStateForTesting();
  fakeSidecar = { store: null };
  notifications = [];
  _setDepsForTesting({
    now: () => 1_700_000_000_000,
    saveSidecar: async (s) => {
      fakeSidecar.store = JSON.parse(JSON.stringify(s));
    },
    loadSidecar: async () => fakeSidecar.store,
    emitNotification: (n) => {
      notifications.push({
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
      });
    },
  });
});

afterEach(() => {
  _resetDepsForTesting();
  _resetStateForTesting();
});

describe("startBackgroundRun → completed", () => {
  test("returns a run_id, runs the executor, transitions to completed, fires notification", async () => {
    const gate = deferred<{ ok: true; result: unknown }>();
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "scrape HN top 10",
      executor: () => gate.promise,
    });

    expect(id).toMatch(/^bg_/);
    let run = getRun(id);
    expect(run?.status).toBe("running");
    expect(run?.tool_name).toBe("tinyfish_agent");

    gate.resolve({ ok: true, result: { stories: 10 } });
    // Let the microtask queue drain so the executor's then/finally land.
    await new Promise((r) => setTimeout(r, 5));

    run = getRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.result).toEqual({ stories: 10 });
    expect(run?.finished_at).toBeTruthy();

    // Notification fired.
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe("background-run");
    expect(notifications[0].severity).toBe("info");
  });
});

describe("startBackgroundRun → failed", () => {
  test("ok:false result transitions to failed with the supplied error", async () => {
    const gate = deferred<{ ok: false; error: string }>();
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "broken task",
      executor: () => gate.promise,
    });
    gate.resolve({ ok: false, error: "page never loaded" });
    await new Promise((r) => setTimeout(r, 5));

    const run = getRun(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("page never loaded");
    expect(notifications[0].severity).toBe("warn");
  });

  test("thrown exception transitions to failed with the error message", async () => {
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "explosive",
      executor: async () => {
        throw new Error("boom");
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    const run = getRun(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("boom");
  });
});

describe("cancelRun", () => {
  test("aborts a running run and marks it cancelled", async () => {
    const sawAbort = deferred<boolean>();
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "long",
      executor: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort.resolve(true);
            resolve({ ok: false, error: "should be overridden by cancel state" });
          });
        }),
    });
    const ok = cancelRun(id);
    expect(ok).toBe(true);
    await sawAbort.promise;
    await new Promise((r) => setTimeout(r, 5));
    const run = getRun(id);
    expect(run?.status).toBe("cancelled");
  });

  test("returns false for unknown id", () => {
    expect(cancelRun("bg_nope_00000000")).toBe(false);
  });

  test("returns false for already-terminal run", async () => {
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "fast",
      executor: async () => ({ ok: true, result: 1 }),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelRun(id)).toBe(false);
  });
});

describe("drainPendingForNextTurn", () => {
  test("returns completions and clears the buffer (one-shot)", async () => {
    const id1 = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "a",
      executor: async () => ({ ok: true, result: "A" }),
    });
    const id2 = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "b",
      executor: async () => ({ ok: false, error: "nope" }),
    });
    await new Promise((r) => setTimeout(r, 10));

    const first = drainPendingForNextTurn();
    expect(first).toHaveLength(2);
    const ids = first.map((r) => r.id).sort();
    expect(ids).toEqual([id1, id2].sort());

    const second = drainPendingForNextTurn();
    expect(second).toHaveLength(0);
  });

  test("returns empty array when no completions are pending", () => {
    expect(drainPendingForNextTurn()).toEqual([]);
  });
});

describe("formatPrependForOperator", () => {
  test("returns null for empty input", () => {
    expect(formatPrependForOperator([])).toBeNull();
  });

  test("renders completed result with elapsed time", async () => {
    const id = startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "scrape",
      executor: async () => ({ ok: true, result: { x: 1 } }),
    });
    await new Promise((r) => setTimeout(r, 5));
    const drained = drainPendingForNextTurn();
    const out = formatPrependForOperator(drained)!;
    expect(out).toContain("background completions");
    expect(out).toContain("1 run finished");
    expect(out).toContain("tinyfish_agent");
    expect(out).toContain(id);
    expect(out).toContain("completed");
    expect(out).toContain('"x":1');
  });

  test("renders failed run with error and 'runs' plural", async () => {
    startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "a",
      executor: async () => ({ ok: true, result: "ok" }),
    });
    startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "b",
      executor: async () => ({ ok: false, error: "boom" }),
    });
    await new Promise((r) => setTimeout(r, 10));
    const out = formatPrependForOperator(drainPendingForNextTurn())!;
    expect(out).toContain("2 runs finished");
    expect(out).toContain("error: boom");
  });
});

describe("listRuns", () => {
  test("returns newest-first, supports status filter and limit", async () => {
    // Advance the fake clock between starts so the second run has a
    // strictly-later started_at — the sort relies on string-comparable
    // ISO timestamps and ties otherwise.
    let t = 1_700_000_000_000;
    _setDepsForTesting({
      now: () => t,
      saveSidecar: async (s) => {
        fakeSidecar.store = JSON.parse(JSON.stringify(s));
      },
      loadSidecar: async () => fakeSidecar.store,
      emitNotification: (n) =>
        notifications.push({
          kind: n.kind,
          severity: n.severity,
          title: n.title,
          body: n.body,
        }),
    });
    startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "a",
      executor: async () => ({ ok: true, result: 1 }),
    });
    await new Promise((r) => setTimeout(r, 5));
    t = 1_700_000_001_000; // +1s
    startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "b",
      executor: () => new Promise(() => {}), // hangs → stays running
    });

    const all = listRuns();
    expect(all).toHaveLength(2);
    // newest-first ordering by started_at descending
    expect(all[0].args_summary).toBe("b");

    const onlyRunning = listRuns({ status: "running" });
    expect(onlyRunning).toHaveLength(1);
    expect(onlyRunning[0].args_summary).toBe("b");

    const limited = listRuns({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describe("hydrateFromSidecar", () => {
  test("orphan running → failed with restart message; pending intact", async () => {
    fakeSidecar.store = {
      version: 1,
      runs: [
        {
          id: "bg_test_orphan",
          tool_name: "tinyfish_agent",
          args_summary: "was running pre-restart",
          status: "running",
          started_at: "2026-05-16T00:00:00.000Z",
        },
        {
          id: "bg_test_completed",
          tool_name: "tinyfish_agent",
          args_summary: "fine",
          status: "completed",
          started_at: "2026-05-16T00:00:00.000Z",
          finished_at: "2026-05-16T00:01:00.000Z",
          result: "done",
        },
      ],
    };
    await hydrateFromSidecar();
    const orphan = getRun("bg_test_orphan");
    expect(orphan?.status).toBe("failed");
    expect(orphan?.error).toContain("lost on master restart");
    expect(orphan?.finished_at).toBeTruthy();

    const ok = getRun("bg_test_completed");
    expect(ok?.status).toBe("completed");
    // Persistence should have been re-written with the orphan fixup.
    expect(fakeSidecar.store?.runs.find((r) => r.id === "bg_test_orphan")?.status).toBe("failed");
  });

  test("no-op when sidecar missing", async () => {
    fakeSidecar.store = null;
    await hydrateFromSidecar();
    expect(listRuns()).toEqual([]);
  });

  test("ignores malformed sidecar without throwing", async () => {
    // @ts-expect-error — intentionally malformed for the test
    fakeSidecar.store = { version: 99, runs: "not-an-array" };
    await hydrateFromSidecar();
    expect(listRuns()).toEqual([]);
  });
});

describe("persistence", () => {
  test("starting and completing a run writes to sidecar", async () => {
    startBackgroundRun({
      tool_name: "tinyfish_agent",
      args_summary: "x",
      executor: async () => ({ ok: true, result: "done" }),
    });
    // After start: sidecar should have the entry (status running).
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeSidecar.store?.runs.length).toBeGreaterThanOrEqual(1);
    // After completion the same record is updated, not duplicated.
    await new Promise((r) => setTimeout(r, 5));
    expect(fakeSidecar.store?.runs.length).toBe(1);
    expect(fakeSidecar.store?.runs[0].status).toBe("completed");
  });
});
