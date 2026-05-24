// components/evy/__tests__/idle-pane-watchdog.test.ts
//
// Acceptance suite for the idle-pane watchdog. Real tmux is replaced
// with a fake PaneProviders implementation; tests drive the watchdog
// tick-by-tick and assert what shape of notifications, audits, and
// Enter-presses come out.
//
// Required coverage (per the 2026-05-19 handoff):
//   - disabled config → no watchdog registered
//   - stable trailing line for >= threshold ticks → notification fires
//   - changing pane content → no notification
//   - empty trailing buffer → no notification
//   - matched directive + auto_retry_enabled → Enter is sent, audit + meta show it
//   - matched directive + auto_retry_enabled=false → notify only, NO Enter
//   - notification suppression within window
//   - path safety on the audit file (write succeeds inside SUBCTL_CONFIG_DIR)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IDLE_PANE_CONFIG,
  IDLE_PANE_WATCHDOG_ID,
  extractTrailingPromptLine,
  loadIdlePaneConfig,
  matchesRecentDirective,
  registerSentDirective,
  startIdlePaneWatchdog,
  runIdlePaneTick,
  emptyIdlePaneState,
  _resetRecentDirectives,
  type IdlePaneWatchdogConfig,
  type PaneProviders,
} from "../idle-pane-watchdog";

let tmpRoot: string;
const originalConfigDir = process.env.SUBCTL_CONFIG_DIR;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "idle-pane-"));
  process.env.SUBCTL_CONFIG_DIR = tmpRoot;
  _resetRecentDirectives();
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = originalConfigDir;
});

function makeConfig(overrides: Partial<IdlePaneWatchdogConfig> = {}): IdlePaneWatchdogConfig {
  return {
    ...DEFAULT_IDLE_PANE_CONFIG,
    enabled: true,
    interval_ms: 60_000,
    idle_threshold_ticks: 3,
    audit_path: join(tmpRoot, "idle-pane.audit.jsonl"),
    ...overrides,
  };
}

interface FakePaneState {
  sessions: string[];
  paneContent: Map<string, string>;
  sendKeysCalls: { session: string; keys: string[] }[];
  notifications: Array<{
    kind: string;
    severity: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }>;
}

function makeFakeProviders(fixture: FakePaneState): PaneProviders {
  return {
    listSessions: () => fixture.sessions.slice(),
    capturePane: (session) => fixture.paneContent.get(session) ?? null,
    sendKeys: (session, keys) => {
      fixture.sendKeysCalls.push({ session, keys: keys.slice() });
      return true;
    },
    notify: (n) => fixture.notifications.push(n),
  };
}

function emptyFixture(): FakePaneState {
  return {
    sessions: [],
    paneContent: new Map(),
    sendKeysCalls: [],
    notifications: [],
  };
}

function makeRegistry() {
  const registrations: Array<{ id: string; kind: string; kill: () => void }> = [];
  const touches: string[] = [];
  return {
    registrations,
    touches,
    hooks: {
      register: (e: { id: string; kind: string; kill: () => void }) => { registrations.push(e); },
      touch: (id: string) => { touches.push(id); },
    },
  };
}

// ─── disabled by default ───────────────────────────────────────────────────

describe("disabled-by-default", () => {
  test("DEFAULT_IDLE_PANE_CONFIG.enabled is false", () => {
    expect(DEFAULT_IDLE_PANE_CONFIG.enabled).toBe(false);
  });

  test("loadIdlePaneConfig with no file returns disabled config", () => {
    const cfg = loadIdlePaneConfig(join(tmpRoot, "no-such.json"));
    expect(cfg.enabled).toBe(false);
  });

  test("start() with disabled config does not register a watchdog", () => {
    const reg = makeRegistry();
    const res = startIdlePaneWatchdog({
      configOverride: makeConfig({ enabled: false }),
      registry: reg.hooks,
      providers: makeFakeProviders(emptyFixture()),
    });
    expect(res.armed).toBe(false);
    expect(reg.registrations).toEqual([]);
    res.kill();
  });
});

describe("enabled config arms idle-pane watchdog", () => {
  test("start() with enabled config registers id=idle-pane", () => {
    const reg = makeRegistry();
    const res = startIdlePaneWatchdog({
      configOverride: makeConfig({ enabled: true, interval_ms: 10 * 60_000 }),
      registry: reg.hooks,
      providers: makeFakeProviders(emptyFixture()),
    });
    expect(res.armed).toBe(true);
    expect(reg.registrations).toHaveLength(1);
    expect(reg.registrations[0].id).toBe(IDLE_PANE_WATCHDOG_ID);
    res.kill();
  });
});

// ─── detection ─────────────────────────────────────────────────────────────

describe("extractTrailingPromptLine", () => {
  test("returns the cleaned trailing line", () => {
    const got = extractTrailingPromptLine("some prior output\n❯ wire start() into server.ts now", {
      min_trailing_chars: 4, max_trailing_chars: 1000,
    });
    expect(got).toBe("wire start() into server.ts now");
  });

  test("returns null for empty / whitespace trailing", () => {
    expect(extractTrailingPromptLine("foo\n\n   \n", {
      min_trailing_chars: 4, max_trailing_chars: 1000,
    })).toBeNull();
  });

  test("returns null when trailing is shorter than min_trailing_chars", () => {
    expect(extractTrailingPromptLine("foo\n❯ ok", {
      min_trailing_chars: 5, max_trailing_chars: 1000,
    })).toBeNull();
  });

  test("truncates at max_trailing_chars", () => {
    const long = "x".repeat(2000);
    const got = extractTrailingPromptLine(`prev\n❯ ${long}`, {
      min_trailing_chars: 4, max_trailing_chars: 100,
    });
    expect(got).not.toBeNull();
    expect(got!.length).toBe(100);
  });
});

// ─── matched-directive check ───────────────────────────────────────────────

describe("matchesRecentDirective", () => {
  test("exact text match within window returns true", () => {
    const now = Date.now();
    expect(matchesRecentDirective("wire start() into server.ts", [
      { ts: now - 5_000, text: "wire start() into server.ts" },
    ], 60_000, now)).toBe(true);
  });

  test("suffix match (sent ⊋ trailing) returns true", () => {
    const now = Date.now();
    expect(matchesRecentDirective("ts now. keep config disabled by default.", [
      { ts: now - 1_000, text: "wire start into server.ts now. keep config disabled by default." },
    ], 60_000, now)).toBe(true);
  });

  test("too-old entry returns false", () => {
    const now = Date.now();
    expect(matchesRecentDirective("wire start() into server.ts", [
      { ts: now - 10 * 60_000, text: "wire start() into server.ts" },
    ], 60_000, now)).toBe(false);
  });

  test("unrelated trailing returns false", () => {
    const now = Date.now();
    expect(matchesRecentDirective("rm -rf /", [
      { ts: now, text: "do something safe" },
    ], 60_000, now)).toBe(false);
  });

  test("short trailing avoids accidental suffix match", () => {
    const now = Date.now();
    expect(matchesRecentDirective("ok", [
      { ts: now, text: "do something that happens to end in ok" },
    ], 60_000, now)).toBe(false);
  });
});

// ─── tick behavior ─────────────────────────────────────────────────────────

describe("runIdlePaneTick — stable trailing triggers flag at threshold", () => {
  test("notification fires only after idle_threshold_ticks", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "prior output\n❯ wire start() into server.ts now");

    const config = makeConfig({ idle_threshold_ticks: 3 });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    // Tick 1 — first observation, no flag.
    let res = runIdlePaneTick(state, config, providers, new Date("2026-05-19T17:00:00Z"));
    expect(res[0].unchanged_ticks).toBe(1);
    expect(res[0].flagged).toBe(false);

    // Tick 2 — still no flag.
    res = runIdlePaneTick(state, config, providers, new Date("2026-05-19T17:01:00Z"));
    expect(res[0].unchanged_ticks).toBe(2);
    expect(res[0].flagged).toBe(false);

    // Tick 3 — threshold hit, flag + notify.
    res = runIdlePaneTick(state, config, providers, new Date("2026-05-19T17:02:00Z"));
    expect(res[0].unchanged_ticks).toBe(3);
    expect(res[0].flagged).toBe(true);
    expect(res[0].notified).toBe(true);
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0].kind).toBe("idle-pane");
    expect(fixture.notifications[0].severity).toBe("warn");
  });

  test("pane content changing between ticks resets the counter", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    const config = makeConfig({ idle_threshold_ticks: 3 });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    fixture.paneContent.set("claude-w1", "x\n❯ first text");
    runIdlePaneTick(state, config, providers, new Date());
    fixture.paneContent.set("claude-w1", "x\n❯ second text");
    runIdlePaneTick(state, config, providers, new Date());
    fixture.paneContent.set("claude-w1", "x\n❯ third text");
    const res = runIdlePaneTick(state, config, providers, new Date());

    expect(res[0].unchanged_ticks).toBe(1);
    expect(res[0].flagged).toBe(false);
    expect(fixture.notifications).toHaveLength(0);
  });

  test("empty trailing buffer produces no notification ever", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "lots of output\n\n   \n");
    const config = makeConfig({ idle_threshold_ticks: 2 });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    for (let i = 0; i < 5; i++) {
      runIdlePaneTick(state, config, providers, new Date());
    }
    expect(fixture.notifications).toHaveLength(0);
  });
});

// ─── auto-retry path ───────────────────────────────────────────────────────

describe("auto-retry safety", () => {
  test("matched directive + auto_retry_enabled=false → notify only, no Enter", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "x\n❯ approved-directive-payload");

    registerSentDirective("approved-directive-payload");

    const config = makeConfig({ idle_threshold_ticks: 1, auto_retry_enabled: false });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    runIdlePaneTick(state, config, providers, new Date());
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0].metadata?.matched_directive).toBe(true);
    expect(fixture.notifications[0].metadata?.attempted_enter).toBe(false);
    expect(fixture.sendKeysCalls).toEqual([]);
  });

  test("matched directive + auto_retry_enabled=true → Enter is sent", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "x\n❯ approved-directive-payload");

    registerSentDirective("approved-directive-payload");

    const config = makeConfig({ idle_threshold_ticks: 1, auto_retry_enabled: true });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    runIdlePaneTick(state, config, providers, new Date());
    expect(fixture.sendKeysCalls).toHaveLength(1);
    expect(fixture.sendKeysCalls[0]).toEqual({ session: "claude-w1", keys: ["Enter"] });
    expect(fixture.notifications[0].metadata?.attempted_enter).toBe(true);
  });

  test("UNMATCHED arbitrary text + auto_retry_enabled=true → still NO Enter (safety pin)", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "x\n❯ rm -rf / # not from master");

    // Registry intentionally empty.
    const config = makeConfig({ idle_threshold_ticks: 1, auto_retry_enabled: true });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    runIdlePaneTick(state, config, providers, new Date());
    expect(fixture.notifications).toHaveLength(1);
    expect(fixture.notifications[0].metadata?.matched_directive).toBe(false);
    expect(fixture.notifications[0].metadata?.attempted_enter).toBe(false);
    expect(fixture.sendKeysCalls).toEqual([]);
  });
});

// ─── suppression ────────────────────────────────────────────────────────────

describe("notification suppression", () => {
  test("same (session, trailing) inside suppression_window stays quiet after first notify", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1"];
    fixture.paneContent.set("claude-w1", "x\n❯ idle-line-text");

    const config = makeConfig({
      idle_threshold_ticks: 1,
      suppression_window_ms: 10 * 60_000,
    });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    const t0 = new Date("2026-05-19T17:00:00Z");
    runIdlePaneTick(state, config, providers, t0);
    expect(fixture.notifications).toHaveLength(1);

    // Re-tick at +1s, +30s, +5m — still same trailing → all suppressed.
    runIdlePaneTick(state, config, providers, new Date(t0.getTime() + 1_000));
    runIdlePaneTick(state, config, providers, new Date(t0.getTime() + 30_000));
    runIdlePaneTick(state, config, providers, new Date(t0.getTime() + 5 * 60_000));
    expect(fixture.notifications).toHaveLength(1);

    // After window — fires again.
    runIdlePaneTick(state, config, providers, new Date(t0.getTime() + 10 * 60_001));
    expect(fixture.notifications).toHaveLength(2);
  });
});

// ─── audit ─────────────────────────────────────────────────────────────────

describe("audit JSONL", () => {
  test("each tick appends one audit entry per session", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1", "claude-w2"];
    fixture.paneContent.set("claude-w1", "x\n❯ stable line 1");
    fixture.paneContent.set("claude-w2", "x\n❯ stable line 2");

    const auditPath = join(tmpRoot, "audit-test.jsonl");
    const config = makeConfig({ idle_threshold_ticks: 5, audit_path: auditPath });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    runIdlePaneTick(state, config, providers, new Date());
    runIdlePaneTick(state, config, providers, new Date());

    const lines = readFileSync(auditPath, "utf8").split("\n").filter((l) => l.length);
    expect(lines).toHaveLength(4); // 2 sessions × 2 ticks
    for (const line of lines) {
      const e = JSON.parse(line);
      expect(typeof e.session).toBe("string");
      expect(typeof e.trailing_line).toBe("string");
      expect(typeof e.unchanged_for_ticks).toBe("number");
    }
  });

  test("audit path resolves under SUBCTL_CONFIG_DIR by default", () => {
    const cfg = loadIdlePaneConfig();
    expect(cfg.audit_path).toBeNull();
    // The default-path helper anchors at SUBCTL_CONFIG_DIR.
    const { defaultIdlePaneAuditPath } = require("../idle-pane-watchdog") as typeof import("../idle-pane-watchdog");
    const p = defaultIdlePaneAuditPath();
    expect(p.startsWith(tmpRoot)).toBe(true);
  });
});

// ─── GC ─────────────────────────────────────────────────────────────────────

describe("session GC", () => {
  test("vanished sessions get their pane state dropped", () => {
    const fixture = emptyFixture();
    fixture.sessions = ["claude-w1", "claude-w2"];
    fixture.paneContent.set("claude-w1", "x\n❯ trailing line w1");
    fixture.paneContent.set("claude-w2", "x\n❯ trailing line w2");

    const config = makeConfig({ idle_threshold_ticks: 5 });
    const state = emptyIdlePaneState();
    const providers = makeFakeProviders(fixture);

    runIdlePaneTick(state, config, providers, new Date());
    expect(state.panes.has("claude-w1")).toBe(true);
    expect(state.panes.has("claude-w2")).toBe(true);

    // w2 vanishes.
    fixture.sessions = ["claude-w1"];
    runIdlePaneTick(state, config, providers, new Date());
    expect(state.panes.has("claude-w2")).toBe(false);
    expect(state.panes.has("claude-w1")).toBe(true);
  });
});
