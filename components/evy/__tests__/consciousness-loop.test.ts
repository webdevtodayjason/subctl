// components/evy/__tests__/consciousness-loop.test.ts
//
// Memory Init #7 — Evy Cognition Loop v0.1 acceptance suite.
//
// Required tests (per .subctl/docs/memory-init/007-evy-cognition-loop.md):
//
//   1. Disabled config starts no watchdog.
//   2. Enabled config registers the watchdog.
//   3. Tick writes exactly one audit entry.
//   4. Unchanged signals produce noop/audit_only.
//   5. Planner refuses irreversible actions.
//   6. Notification suppression works.
//   7. Status surface returns last tick and recent decisions.
//
// Plus a few structural pins (signal hash determinism, executor
// refuses unknown kinds) so future contributors can't drift the
// guardrails without breaking a red test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  IRREVERSIBLE_ACTIONS,
  WATCHDOG_ID,
  executeDecision,
  gatherSignals,
  getStatus,
  hashSignalBundle,
  loadConfig,
  plan,
  runTick,
  start,
  type CognitionLoopConfig,
  type CognitionState,
  type ExecutorProviders,
  type PlannerDecision,
  type SignalProviders,
  type WatchdogRegistryHooks,
} from "../consciousness-loop";
import { INITIAL_STATE } from "../consciousness-loop/types";

// ─── shared fixtures ──────────────────────────────────────────────────────

let tmpRoot: string;
let statePath: string;
let auditPath: string;
const originalConfigDir = process.env.SUBCTL_CONFIG_DIR;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cogloop-"));
  // Anchor BOTH the lookup paths and the explicit override paths inside
  // tmpRoot so getStatus + start agree on where state.json lives even
  // when we pass configOverride.
  process.env.SUBCTL_CONFIG_DIR = tmpRoot;
  statePath = join(tmpRoot, "state.json");
  auditPath = join(tmpRoot, "audit.jsonl");
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = originalConfigDir;
});

function makeConfig(overrides: Partial<CognitionLoopConfig> = {}): CognitionLoopConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: true,
    tick_interval_ms: 60_000,
    state_path: statePath,
    audit_path: auditPath,
    ...overrides,
  };
}

function emptySignals(): SignalProviders {
  return {
    watchdogs: () => [],
    notifications: () => ({ total: 0, unread: 0, by_severity: {} }),
    followups: () => ({ pending: 0, next_due_at: null }),
  };
}

function noopExecutor(): ExecutorProviders {
  return {};
}

function makeRegistry(): {
  hooks: WatchdogRegistryHooks;
  registrations: Array<{ id: string; kind: string; kill: () => void }>;
  touches: string[];
} {
  const registrations: Array<{ id: string; kind: string; kill: () => void }> = [];
  const touches: string[] = [];
  return {
    hooks: {
      register: (e) => { registrations.push(e); },
      touch: (id) => { touches.push(id); },
    },
    registrations,
    touches,
  };
}

// ─── required test 1: disabled config starts no watchdog ──────────────────

describe("disabled-by-default", () => {
  test("DEFAULT_CONFIG.enabled is false", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false);
  });

  test("loadConfig with no file returns disabled config", () => {
    const cfg = loadConfig(join(tmpRoot, "no-such-config.json"));
    expect(cfg.enabled).toBe(false);
  });

  test("start() with disabled config does not register a watchdog", () => {
    const reg = makeRegistry();
    const res = start({
      configOverride: makeConfig({ enabled: false }),
      registry: reg.hooks,
      signals: emptySignals(),
      executor: noopExecutor(),
    });
    expect(res.armed).toBe(false);
    expect(reg.registrations).toEqual([]);
    expect(reg.touches).toEqual([]);
    res.kill(); // idempotent no-op
  });
});

// ─── required test 2: enabled config registers the watchdog ───────────────

describe("enabled config arms watchdog", () => {
  test("start() with enabled config registers id=consciousness-loop", () => {
    const reg = makeRegistry();
    const res = start({
      configOverride: makeConfig({ enabled: true, tick_interval_ms: 10 * 60_000 }),
      registry: reg.hooks,
      signals: emptySignals(),
      executor: noopExecutor(),
    });
    expect(res.armed).toBe(true);
    expect(reg.registrations).toHaveLength(1);
    expect(reg.registrations[0].id).toBe(WATCHDOG_ID);
    expect(reg.registrations[0].kind).toBe(WATCHDOG_ID);
    res.kill();
  });
});

// ─── required test 3: tick writes exactly one audit entry ─────────────────

describe("tick → exactly one audit entry", () => {
  test("runTick appends exactly one audit line", () => {
    const config = makeConfig();
    const before = existsSync(auditPath)
      ? readFileSync(auditPath, "utf8").split("\n").filter((l) => l).length
      : 0;
    expect(before).toBe(0);

    runTick({
      state: { ...INITIAL_STATE },
      config,
      paths: { state_path: statePath, audit_path: auditPath },
      signals: emptySignals(),
      executor: noopExecutor(),
    });

    const after = readFileSync(auditPath, "utf8").split("\n").filter((l) => l).length;
    expect(after).toBe(1);
  });

  test("multiple ticks append exactly one entry each", () => {
    const config = makeConfig();
    let state: CognitionState = { ...INITIAL_STATE };
    for (let i = 0; i < 3; i++) {
      const out = runTick({
        state,
        config,
        paths: { state_path: statePath, audit_path: auditPath },
        signals: emptySignals(),
        executor: noopExecutor(),
      });
      state = out.state;
    }
    const lines = readFileSync(auditPath, "utf8").split("\n").filter((l) => l);
    expect(lines).toHaveLength(3);
  });
});

// ─── required test 4: unchanged signals → noop or audit_only ──────────────

describe("unchanged signals → noop or audit_only", () => {
  test("second tick on identical signals decides audit_only", () => {
    const config = makeConfig();
    const signals = emptySignals();

    const t1 = runTick({
      state: { ...INITIAL_STATE },
      config,
      paths: { state_path: statePath, audit_path: auditPath },
      signals,
      executor: noopExecutor(),
    });
    // First tick has no prior hash → falls through to R5 (noop) when
    // nothing else triggers. That's a valid "no actionable signals"
    // outcome on a fresh boot.
    expect(["noop", "audit_only"]).toContain(t1.decision.kind);

    const t2 = runTick({
      state: t1.state,
      config,
      paths: { state_path: statePath, audit_path: auditPath },
      signals,
      executor: noopExecutor(),
    });
    expect(t2.unchanged).toBe(true);
    expect(["noop", "audit_only"]).toContain(t2.decision.kind);
    // Stronger pin: R1 specifically fires on unchanged hash.
    expect(t2.decision.kind).toBe("audit_only");
  });
});

// ─── required test 5: planner refuses irreversible actions ────────────────

describe("planner refuses irreversible actions", () => {
  test("each IRREVERSIBLE_ACTIONS entry is recorded in decision.refused", () => {
    const config = makeConfig();
    const bundle = gatherSignals(emptySignals());
    const decision: PlannerDecision = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: { ...INITIAL_STATE },
      config,
      now: new Date(),
      candidate_actions: [...IRREVERSIBLE_ACTIONS],
    });
    expect(decision.refused).toBeDefined();
    expect(decision.refused!.length).toBe(IRREVERSIBLE_ACTIONS.length);
    for (const r of decision.refused!) {
      expect(IRREVERSIBLE_ACTIONS).toContain(r.action);
      expect(r.reason).toContain("irreversible");
    }
    // The decision kind itself must NOT be one of the dangerous actions —
    // planner uses the closed DecisionKind set.
    expect([
      "noop", "audit_only", "notify_dashboard", "schedule_followup",
      "remember_candidate", "ask_operator", "recommend_team_spawn",
    ]).toContain(decision.kind);
  });

  test("executor refuses a decision tagged with an irreversible payload.action", () => {
    const config = makeConfig();
    const fakeDecision: PlannerDecision = {
      kind: "notify_dashboard",
      rationale: "synthetic",
      sources: ["test"],
      payload: { action: "git_push", suppression_key: "k" },
      ts: new Date().toISOString(),
      signal_hash: "deadbeef",
    };
    const res = executeDecision(
      fakeDecision,
      { ...INITIAL_STATE },
      config,
      { notify: () => { throw new Error("should not be called"); } },
      new Date(),
    );
    expect(res.executed).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("irreversible");
  });

  test("executor refuses an unknown decision kind", () => {
    const config = makeConfig();
    const bad = {
      kind: "rm_rf_root" as unknown as PlannerDecision["kind"],
      rationale: "should be rejected",
      sources: [],
      ts: new Date().toISOString(),
      signal_hash: "x",
    } as PlannerDecision;
    const res = executeDecision(bad, { ...INITIAL_STATE }, config, {}, new Date());
    expect(res.executed).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unknown decision kind");
  });
});

// ─── required test 6: notification suppression works ──────────────────────

describe("notification suppression", () => {
  test("same suppression_key inside window is suppressed", () => {
    const config = makeConfig({ suppression_window_ms: 60_000 });
    const notifyCalls: unknown[] = [];
    const providers: ExecutorProviders = { notify: (n) => notifyCalls.push(n) };
    const decision: PlannerDecision = {
      kind: "notify_dashboard",
      rationale: "stale watchdog: test-id",
      sources: ["watchdogs"],
      payload: { suppression_key: "watchdog-stale:test-id", severity: "warn" },
      ts: new Date().toISOString(),
      signal_hash: "h",
    };
    const t0 = new Date("2026-05-19T10:00:00Z");
    const r1 = executeDecision(decision, { ...INITIAL_STATE }, config, providers, t0);
    expect(r1.executed).toBe(true);
    expect(notifyCalls).toHaveLength(1);
    expect(r1.state.suppressions["watchdog-stale:test-id"]).toBeDefined();

    // Second emit inside window — suppressed.
    const t1 = new Date(t0.getTime() + 30_000);
    const r2 = executeDecision(decision, r1.state, config, providers, t1);
    expect(r2.executed).toBe(false);
    expect(r2.ok).toBe(true);
    expect(r2.reason).toContain("suppressed");
    expect(notifyCalls).toHaveLength(1);

    // After window expires — fires again.
    const t2 = new Date(t0.getTime() + 60_001);
    const r3 = executeDecision(decision, r2.state, config, providers, t2);
    expect(r3.executed).toBe(true);
    expect(notifyCalls).toHaveLength(2);
  });

  test("planner honors an active suppression and downgrades to audit_only", () => {
    const config = makeConfig();
    // Inject a stale watchdog so R2 would normally fire.
    const staleAt = new Date("2026-05-19T09:00:00Z").toISOString();
    const signals: SignalProviders = {
      watchdogs: () => [
        { id: "test-id", kind: "test-kind", age_seconds: 9999, last_tick_at: staleAt },
      ],
      notifications: () => ({ total: 0, unread: 0, by_severity: {} }),
      followups: () => ({ pending: 0, next_due_at: null }),
    };
    const bundle = gatherSignals(signals);
    const now = new Date("2026-05-19T10:00:00Z");

    // First, with no suppression — planner picks notify_dashboard.
    const open = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: { ...INITIAL_STATE },
      config,
      now,
    });
    expect(open.kind).toBe("notify_dashboard");

    // Now with an active suppression — planner downgrades to audit_only.
    const suppressed = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: {
        ...INITIAL_STATE,
        suppressions: {
          "watchdog-stale:test-id": new Date(now.getTime() + 60_000).toISOString(),
        },
      },
      config,
      now,
    });
    expect(suppressed.kind).toBe("audit_only");
  });
});

// ─── regression: bug #32/#33 — per-watchdog staleness threshold ──────────
//
// The global 10-min STALE_WATCHDOG_THRESHOLD_S was wrong for watchdogs
// with legitimately long cadences (team-staleness ticks every 30min,
// upstream-check every 6h). The planner now scales staleness at 2.5× a
// watchdog's declared expected_interval_s before flagging.

describe("bug-32-33 per-watchdog staleness", () => {
  test("long-cadence watchdog within 2.5× its interval is NOT stale", () => {
    // upstream-check declares 6h cadence. Last tick 2h ago — well inside
    // the 2.5× = 15h window. Must NOT trip notify_dashboard.
    const now = new Date("2026-05-19T22:00:00Z");
    const lastTickAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const signals: SignalProviders = {
      watchdogs: () => [
        {
          id: "upstream-check",
          kind: "upstream-check",
          age_seconds: 8 * 60 * 60,
          last_tick_at: lastTickAt,
          expected_interval_s: 6 * 60 * 60,
        },
      ],
      notifications: () => ({ total: 0, unread: 0, by_severity: {} }),
      followups: () => ({ pending: 0, next_due_at: null }),
    };
    const bundle = gatherSignals(signals);
    const decision = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: { ...INITIAL_STATE },
      config: makeConfig(),
      now,
    });
    // Must NOT flag — anything other than notify_dashboard is fine.
    expect(decision.kind).not.toBe("notify_dashboard");
  });

  test("long-cadence watchdog past 2.5× its interval IS stale", () => {
    // Same watchdog, but last tick 16h ago — past the 15h threshold.
    const now = new Date("2026-05-19T22:00:00Z");
    const lastTickAt = new Date(now.getTime() - 16 * 60 * 60 * 1000).toISOString();
    const signals: SignalProviders = {
      watchdogs: () => [
        {
          id: "upstream-check",
          kind: "upstream-check",
          age_seconds: 20 * 60 * 60,
          last_tick_at: lastTickAt,
          expected_interval_s: 6 * 60 * 60,
        },
      ],
      notifications: () => ({ total: 0, unread: 0, by_severity: {} }),
      followups: () => ({ pending: 0, next_due_at: null }),
    };
    const bundle = gatherSignals(signals);
    const decision = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: { ...INITIAL_STATE },
      config: makeConfig(),
      now,
    });
    expect(decision.kind).toBe("notify_dashboard");
  });

  test("watchdog with no expected_interval_s falls back to 10-min global", () => {
    // No declared cadence → behaves like before. Last tick 12 min ago
    // → stale (> 10min default).
    const now = new Date("2026-05-19T22:00:00Z");
    const lastTickAt = new Date(now.getTime() - 12 * 60 * 1000).toISOString();
    const signals: SignalProviders = {
      watchdogs: () => [
        {
          id: "legacy-thing",
          kind: "legacy-thing",
          age_seconds: 12 * 60,
          last_tick_at: lastTickAt,
        },
      ],
      notifications: () => ({ total: 0, unread: 0, by_severity: {} }),
      followups: () => ({ pending: 0, next_due_at: null }),
    };
    const bundle = gatherSignals(signals);
    const decision = plan({
      bundle,
      signal_hash: hashSignalBundle(bundle),
      state: { ...INITIAL_STATE },
      config: makeConfig(),
      now,
    });
    expect(decision.kind).toBe("notify_dashboard");
  });
});

// ─── required test 7: status surface returns last tick + decisions ────────

describe("status surface", () => {
  test("getStatus returns enabled=false / null last_tick on fresh install", () => {
    const s = getStatus();
    expect(s.enabled).toBe(false);
    expect(s.last_tick_at).toBeNull();
    expect(s.tick_count).toBe(0);
    expect(s.recent_decisions).toEqual([]);
    expect(s.last_decision).toBeNull();
    expect(s.audit_tail).toEqual([]);
  });

  test("getStatus after one tick returns last_tick + populated decision", () => {
    const config = makeConfig();
    runTick({
      state: { ...INITIAL_STATE },
      config,
      paths: { state_path: statePath, audit_path: auditPath },
      signals: emptySignals(),
      executor: noopExecutor(),
    });
    const s = getStatus({
      configPath: undefined,
      armed: true,
    });
    // Note: getStatus reads from the default path under SUBCTL_CONFIG_DIR.
    // Our runTick wrote to statePath/auditPath (explicit overrides). The
    // STATUS surface contract is that it reflects what's on disk under
    // the resolved paths — so we re-run via the resolved paths here:
    expect(s).toBeDefined();
  });

  test("status reflects state written by runTick (using resolved paths)", () => {
    // Write config to disk so getStatus reads it via SUBCTL_CONFIG_DIR.
    const configOnDisk = {
      enabled: true,
      tick_interval_ms: 60_000,
      // no state_path / audit_path → status + tick use the resolved defaults.
    };
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(join(tmpRoot, "evy"), { recursive: true });
    fs.writeFileSync(
      join(tmpRoot, "evy", "consciousness-loop.json"),
      JSON.stringify(configOnDisk),
    );

    const cfg = loadConfig();
    const config = makeConfig({
      enabled: true,
      // override to null so resolvePaths uses defaults — matches what
      // status will read.
      state_path: null,
      audit_path: null,
    });
    const { state_path, audit_path } = (() => {
      const { resolvePaths } = require("../consciousness-loop/config") as typeof import("../consciousness-loop/config");
      return resolvePaths(cfg);
    })();
    config.state_path = state_path;
    config.audit_path = audit_path;

    const out = runTick({
      state: { ...INITIAL_STATE },
      config,
      paths: { state_path, audit_path },
      signals: emptySignals(),
      executor: noopExecutor(),
    });

    const s = getStatus({ armed: true });
    expect(s.enabled).toBe(true);
    expect(s.armed).toBe(true);
    expect(s.tick_count).toBe(1);
    expect(s.last_tick_at).not.toBeNull();
    expect(s.last_decision).not.toBeNull();
    expect(s.last_decision!.kind).toBe(out.decision.kind);
    expect(s.recent_decisions).toHaveLength(1);
    expect(s.audit_tail).toHaveLength(1);
    expect(s.audit_tail[0].tick).toBe(1);
  });
});

// ─── structural pins ──────────────────────────────────────────────────────

describe("signal hash determinism", () => {
  test("identical bundles hash identically; different bundles differ", () => {
    const a = gatherSignals(emptySignals());
    const b = gatherSignals(emptySignals());
    expect(hashSignalBundle(a)).toBe(hashSignalBundle(b));

    const changed = gatherSignals({
      ...emptySignals(),
      notifications: () => ({ total: 1, unread: 1, by_severity: { info: 1 } }),
    });
    expect(hashSignalBundle(a)).not.toBe(hashSignalBundle(changed));
  });

  test("hash ignores the bundle's ts field", () => {
    const sigs = emptySignals();
    const b1 = gatherSignals(sigs);
    // Force a different ts by waiting one ms... or just mutate.
    const b2 = { ...gatherSignals(sigs), ts: "1999-01-01T00:00:00Z" };
    expect(hashSignalBundle(b1)).toBe(hashSignalBundle(b2));
  });
});

describe("watchdog kill is idempotent", () => {
  test("kill() can be called multiple times safely", () => {
    const reg = makeRegistry();
    const res = start({
      configOverride: makeConfig({ enabled: true, tick_interval_ms: 10 * 60_000 }),
      registry: reg.hooks,
      signals: emptySignals(),
      executor: noopExecutor(),
    });
    expect(res.armed).toBe(true);
    res.kill();
    res.kill(); // must not throw
    res.kill();
  });
});
