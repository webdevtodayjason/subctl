// v2.8.10 — background_run / background_status / background_cancel tests
//
// These hit the tools' invoke() surface directly, with a stub registry
// injected via bindBackgroundToolRegistry. The runtime itself is covered
// by background-runs.test.ts — these tests focus on the tool-layer
// behavior: arg validation, registry resolution, recursion guard,
// status filtering.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  backgroundTools,
  bindBackgroundToolRegistry,
  type ToolEntry,
} from "../tools/background";
import {
  _resetStateForTesting,
  _setDepsForTesting,
  _resetDepsForTesting,
} from "../background-runs";

interface FakeSidecar {
  store: unknown;
}

let fakeSidecar: FakeSidecar;
let registry: Record<string, ToolEntry>;

beforeEach(() => {
  _resetStateForTesting();
  fakeSidecar = { store: null };
  _setDepsForTesting({
    now: () => 1_700_000_000_000,
    saveSidecar: async (s) => {
      fakeSidecar.store = JSON.parse(JSON.stringify(s));
    },
    loadSidecar: async () =>
      (fakeSidecar.store ?? null) as { version: 1; runs: [] } | null,
    emitNotification: () => {},
  });
  registry = {
    echo: {
      description: "echoes back",
      schema: {},
      invoke: async (args) => ({ ok: true, echo: args }),
    },
    fail: {
      description: "always fails",
      schema: {},
      invoke: async () => ({ ok: false, error: "no-good" }),
    },
    throw: {
      description: "throws",
      schema: {},
      invoke: async () => {
        throw new Error("kaboom");
      },
    },
  };
  bindBackgroundToolRegistry(registry);
});

afterEach(() => {
  _resetDepsForTesting();
  _resetStateForTesting();
});

describe("background_run", () => {
  test("rejects missing tool_name", async () => {
    const out = await backgroundTools.background_run.invoke({});
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/tool_name is required/);
  });

  test("rejects unknown tool", async () => {
    const out = await backgroundTools.background_run.invoke({
      tool_name: "does_not_exist",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/not in the registry/);
  });

  test("refuses to dispatch a background_* tool (recursion guard)", async () => {
    const out = await backgroundTools.background_run.invoke({
      tool_name: "background_run",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/recurse/);
  });

  test("dispatches a registered tool and returns run_id", async () => {
    const out = await backgroundTools.background_run.invoke({
      tool_name: "echo",
      tool_args: { hello: "world" },
      label: "smoke",
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect((out as { run_id: string }).run_id).toMatch(/^bg_/);
    expect((out as { label: string | null }).label).toBe("smoke");
    // Let executor complete.
    await new Promise((r) => setTimeout(r, 5));
    // Confirm status surfaces completion via background_status.
    const status = await backgroundTools.background_status.invoke({
      run_id: (out as { run_id: string }).run_id,
    });
    expect((status as { ok: boolean }).ok).toBe(true);
    expect(
      (status as { run: { status: string } }).run.status,
    ).toBe("completed");
  });

  test("propagates underlying tool's ok:false envelope as a failure", async () => {
    const out = await backgroundTools.background_run.invoke({
      tool_name: "fail",
    });
    const runId = (out as { run_id: string }).run_id;
    await new Promise((r) => setTimeout(r, 5));
    const status = await backgroundTools.background_status.invoke({
      run_id: runId,
    });
    const run = (status as { run: { status: string; error: string } }).run;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("no-good");
  });

  test("catches a thrown executor and surfaces error", async () => {
    const out = await backgroundTools.background_run.invoke({
      tool_name: "throw",
    });
    const runId = (out as { run_id: string }).run_id;
    await new Promise((r) => setTimeout(r, 5));
    const status = await backgroundTools.background_status.invoke({
      run_id: runId,
    });
    const run = (status as { run: { status: string; error: string } }).run;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("kaboom");
  });
});

describe("background_status", () => {
  test("returns one run by id", async () => {
    const dispatched = (await backgroundTools.background_run.invoke({
      tool_name: "echo",
      tool_args: { x: 1 },
    })) as { run_id: string };
    await new Promise((r) => setTimeout(r, 5));
    const out = await backgroundTools.background_status.invoke({
      run_id: dispatched.run_id,
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect((out as { run: { id: string } }).run.id).toBe(dispatched.run_id);
  });

  test("errors on unknown id", async () => {
    const out = await backgroundTools.background_status.invoke({
      run_id: "bg_nope_00000000",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
  });

  test("lists newest-first when no id", async () => {
    // Advance the fake clock between dispatches so `started_at` strictly
    // differs — the sort is on ISO timestamps and ties otherwise.
    let t = 1_700_000_000_000;
    _setDepsForTesting({
      now: () => t,
      saveSidecar: async (s) => {
        fakeSidecar.store = JSON.parse(JSON.stringify(s));
      },
      loadSidecar: async () =>
        (fakeSidecar.store ?? null) as { version: 1; runs: [] } | null,
      emitNotification: () => {},
    });
    await backgroundTools.background_run.invoke({
      tool_name: "echo",
      tool_args: { i: 1 },
    });
    await new Promise((r) => setTimeout(r, 5));
    t = 1_700_000_001_000;
    await backgroundTools.background_run.invoke({
      tool_name: "echo",
      tool_args: { i: 2 },
    });
    await new Promise((r) => setTimeout(r, 5));
    const out = (await backgroundTools.background_status.invoke({
      limit: 5,
    })) as { ok: boolean; count: number; runs: Array<{ args_summary: string }> };
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    // Most recent first.
    expect(out.runs[0].args_summary).toContain('"i":2');
  });

  test("filters by status", async () => {
    await backgroundTools.background_run.invoke({
      tool_name: "echo",
      tool_args: {},
    });
    await backgroundTools.background_run.invoke({
      tool_name: "fail",
      tool_args: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const failed = (await backgroundTools.background_status.invoke({
      status: "failed",
    })) as { count: number };
    expect(failed.count).toBe(1);
    const completed = (await backgroundTools.background_status.invoke({
      status: "completed",
    })) as { count: number };
    expect(completed.count).toBe(1);
  });
});

describe("background_cancel", () => {
  test("requires run_id", async () => {
    const out = await backgroundTools.background_cancel.invoke({});
    expect((out as { ok: boolean }).ok).toBe(false);
  });

  test("returns descriptive error for unknown id", async () => {
    const out = await backgroundTools.background_cancel.invoke({
      run_id: "bg_unknown_xxxxxxxx",
    });
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/no run with id/);
  });

  test("refuses to cancel a terminal run", async () => {
    const dispatched = (await backgroundTools.background_run.invoke({
      tool_name: "echo",
    })) as { run_id: string };
    await new Promise((r) => setTimeout(r, 5));
    const out = await backgroundTools.background_cancel.invoke({
      run_id: dispatched.run_id,
    });
    expect((out as { ok: boolean }).ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/already completed/);
  });

  test("cancels a running run", async () => {
    // Register a hanging tool just for this test.
    let resolveExec: (v: unknown) => void = () => {};
    registry.hangs = {
      description: "hangs",
      schema: {},
      invoke: async () =>
        new Promise((res) => {
          resolveExec = res;
        }),
    };
    const dispatched = (await backgroundTools.background_run.invoke({
      tool_name: "hangs",
    })) as { run_id: string };
    const out = await backgroundTools.background_cancel.invoke({
      run_id: dispatched.run_id,
    });
    expect((out as { ok: boolean }).ok).toBe(true);
    // Unblock so the test exits cleanly.
    resolveExec({ ok: true });
    await new Promise((r) => setTimeout(r, 5));
    const status = await backgroundTools.background_status.invoke({
      run_id: dispatched.run_id,
    });
    expect((status as { run: { status: string } }).run.status).toBe(
      "cancelled",
    );
  });
});
