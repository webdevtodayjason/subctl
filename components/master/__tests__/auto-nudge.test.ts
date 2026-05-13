// components/master/__tests__/auto-nudge.test.ts
//
// v2.7.22 — Auto-nudge state machine for the team-staleness watchdog.
//
// Spec contract (pinned per scope B):
//   1. Stale team detected → first nudge sent, last_nudge_at set,
//      severity:info notification emitted, no alert.
//   2. Nudged team still stale 30 min later → severity:alert with
//      kind:"team-unresponsive" + re-nudge.
//   3. Nudged team responds before 30 min → nudge state cleared.
//   4. Within the 30-min retry window (still stale): no re-nudge, no
//      re-alert (de-dup).

import { describe, expect, test } from "bun:test";
import {
  decideTeamAction,
  runStaleTeamSweep,
  type TeamNudgeState,
} from "../auto-nudge";

const T_MIN = 60_000;
const STALENESS = 15 * T_MIN;
const RETRY = 30 * T_MIN;

function makeCallbacks() {
  const nudges: Array<{ team_id: string; body: string }> = [];
  const infos: Array<{ team_id: string; title: string; body: string }> = [];
  const alerts: Array<{ team_id: string; title: string; body: string }> = [];
  const decisions: Array<{ team_id: string; action: string; rationale: string }> = [];
  return {
    nudges,
    infos,
    alerts,
    decisions,
    callbacks: {
      sendNudge: async (team_id: string, body: string) => {
        nudges.push({ team_id, body });
        return { ok: true as const };
      },
      emitInfo: (team_id: string, title: string, body: string) => {
        infos.push({ team_id, title, body });
      },
      emitAlert: (team_id: string, title: string, body: string) => {
        alerts.push({ team_id, title, body });
      },
      logDecision: (team_id: string, action: string, rationale: string) => {
        decisions.push({ team_id, action, rationale });
      },
    },
  };
}

describe("decideTeamAction — pure", () => {
  test("fresh team returns 'fresh'", () => {
    const now = 100 * T_MIN;
    const a = decideTeamAction(
      { team_id: "t1", last_activity_ms: now - 5 * T_MIN },
      undefined,
      { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
    );
    expect(a.action).toBe("fresh");
  });

  test("stale + never nudged returns 'first-nudge' with next_nudge_at_ms=now", () => {
    const now = 100 * T_MIN;
    const a = decideTeamAction(
      { team_id: "t1", last_activity_ms: now - 20 * T_MIN },
      undefined,
      { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
    );
    expect(a.action).toBe("first-nudge");
    expect(a.next_nudge_at_ms).toBe(now);
  });

  test("stale + nudged within retry window returns 'hold'", () => {
    const now = 100 * T_MIN;
    const a = decideTeamAction(
      { team_id: "t1", last_activity_ms: now - 25 * T_MIN },
      { last_nudge_at_ms: now - 10 * T_MIN },
      { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
    );
    expect(a.action).toBe("hold");
  });

  test("stale + nudge older than retry returns 'escalate'", () => {
    const now = 100 * T_MIN;
    const a = decideTeamAction(
      { team_id: "t1", last_activity_ms: now - 60 * T_MIN },
      { last_nudge_at_ms: now - 31 * T_MIN },
      { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
    );
    expect(a.action).toBe("escalate");
    expect(a.next_nudge_at_ms).toBe(now);
    expect(a.prior_nudge_age_min).toBeGreaterThanOrEqual(31);
  });
});

describe("runStaleTeamSweep — first-nudge contract", () => {
  test("stale team detected → nudge sent + info notification + state set, no alert", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>();
    const c = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-osint-cve-monitor",
          last_activity_ms: now - 20 * T_MIN,
          last_event_type: "report",
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });

    expect(c.nudges.length).toBe(1);
    expect(c.nudges[0]?.team_id).toBe("claude-osint-cve-monitor");
    expect(c.nudges[0]?.body).toContain("[auto-nudge]");
    expect(c.infos.length).toBe(1);
    expect(c.infos[0]?.title).toContain("auto-nudged");
    expect(c.alerts.length).toBe(0); // No Telegram push for first nudge
    expect(state.get("claude-osint-cve-monitor")?.last_nudge_at_ms).toBe(now);
    expect(c.decisions[0]?.action).toBe("team_auto_nudge");
  });
});

describe("runStaleTeamSweep — escalation contract", () => {
  test("nudged team still stale 30min later → alert + re-nudge, state moves forward", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>([
      ["claude-osint", { last_nudge_at_ms: now - 31 * T_MIN }],
    ]);
    const c = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-osint",
          last_activity_ms: now - 60 * T_MIN,
          last_event_type: "report",
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });

    expect(c.alerts.length).toBe(1);
    expect(c.alerts[0]?.title).toContain("unresponsive");
    expect(c.nudges.length).toBe(1); // The re-nudge
    expect(c.nudges[0]?.body).toContain("escalated");
    // state.last_nudge_at_ms moves forward to now
    expect(state.get("claude-osint")?.last_nudge_at_ms).toBe(now);
    expect(c.decisions[0]?.action).toBe("team_unresponsive");
  });
});

describe("runStaleTeamSweep — response resets state", () => {
  test("nudged team responds before 30min → state cleared, no escalation", async () => {
    const now = 100 * T_MIN;
    // Team was nudged 10 min ago, then activity bumped 1 min ago.
    const state = new Map<string, TeamNudgeState>([
      ["claude-foo", { last_nudge_at_ms: now - 10 * T_MIN }],
    ]);
    const c = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-foo",
          last_activity_ms: now - 1 * T_MIN, // fresh
          last_event_type: "report",
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });

    expect(state.has("claude-foo")).toBe(false);
    expect(c.alerts.length).toBe(0);
    expect(c.nudges.length).toBe(0);
    expect(c.infos.length).toBe(0);
  });
});

describe("runStaleTeamSweep — dedup hold window", () => {
  test("within 30-min retry window, no re-nudge and no re-alert", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>([
      // Nudged 5 min ago, well within the 30-min hold window.
      ["claude-bar", { last_nudge_at_ms: now - 5 * T_MIN }],
    ]);
    const c = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-bar",
          last_activity_ms: now - 25 * T_MIN, // still stale
          last_event_type: "report",
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });

    expect(c.nudges.length).toBe(0);
    expect(c.alerts.length).toBe(0);
    expect(c.infos.length).toBe(0);
    // State unchanged
    expect(state.get("claude-bar")?.last_nudge_at_ms).toBe(now - 5 * T_MIN);
  });
});

describe("runStaleTeamSweep — send failure recorded but state advances", () => {
  test("failed delivery still sets last_nudge_at and emits an info notification", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>();
    const infos: Array<{ team_id: string; title: string; body: string }> = [];
    const alerts: Array<{ team_id: string; title: string; body: string }> = [];
    await runStaleTeamSweep({
      teams: [
        { team_id: "claude-down", last_activity_ms: now - 20 * T_MIN },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async () => ({ ok: false, error: "dashboard unreachable" }),
        emitInfo: (team_id, title, body) => infos.push({ team_id, title, body }),
        emitAlert: (team_id, title, body) => alerts.push({ team_id, title, body }),
      },
    });
    expect(infos.length).toBe(1);
    expect(infos[0]?.body).toContain("delivery failed: dashboard unreachable");
    expect(alerts.length).toBe(0);
    expect(state.get("claude-down")?.last_nudge_at_ms).toBe(now);
  });
});
