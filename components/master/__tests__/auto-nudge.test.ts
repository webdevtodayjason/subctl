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
  classifyWorkerReply,
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

describe("runStaleTeamSweep — vanished team reconciliation (v2.7.32)", () => {
  test("stale team whose registry dir is absent → vanished alert + state cleared + no nudge", async () => {
    const now = 100 * T_MIN;
    // Team had been nudged before; registry dir is now gone.
    const state = new Map<string, TeamNudgeState>([
      ["claude-osint-cve-monitor", { last_nudge_at_ms: now - 31 * T_MIN }],
    ]);
    const nudges: Array<{ team_id: string; body: string }> = [];
    const alerts: Array<{ team_id: string; title: string; body: string }> = [];
    const infos: Array<{ team_id: string; title: string; body: string }> = [];
    const vanished: Array<{ team_id: string; title: string; body: string }> = [];
    const decisions: Array<{ team_id: string; action: string; rationale: string }> = [];

    const actions = await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-osint-cve-monitor",
          last_activity_ms: now - 60 * T_MIN,
          last_event_type: "report",
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async (team_id, body) => {
          nudges.push({ team_id, body });
          return { ok: true as const };
        },
        emitInfo: (team_id, title, body) => infos.push({ team_id, title, body }),
        emitAlert: (team_id, title, body) => alerts.push({ team_id, title, body }),
        emitVanished: (team_id, title, body) => vanished.push({ team_id, title, body }),
        teamRegistryExists: () => false, // dir vanished
        logDecision: (team_id, action, rationale) =>
          decisions.push({ team_id, action, rationale }),
      },
    });

    expect(actions.length).toBe(1);
    expect(actions[0]?.action).toBe("vanished");
    expect(vanished.length).toBe(1);
    expect(vanished[0]?.team_id).toBe("claude-osint-cve-monitor");
    expect(vanished[0]?.title).toContain("vanished");
    expect(vanished[0]?.body).toContain("teams/.killed/");
    // No nudge/info/regular-alert when the team is vanished
    expect(nudges.length).toBe(0);
    expect(infos.length).toBe(0);
    expect(alerts.length).toBe(0);
    // State entry cleared so subsequent sweeps don't re-process
    expect(state.has("claude-osint-cve-monitor")).toBe(false);
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.action).toBe("team_vanished");
  });

  test("second sweep with same vanished team produces no second vanished alert (caller drops it)", async () => {
    // Simulates server.ts behavior: after the first vanished action, the
    // caller drops the team from teamLastActivity. The second sweep
    // receives no teams entry for that id, so nothing fires.
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>();
    const vanished: Array<{ team_id: string; title: string; body: string }> = [];

    // First sweep — team is in the list, dir is gone, vanished fires.
    const liveTeams: Array<{ team_id: string; last_activity_ms: number }> = [
      { team_id: "claude-gone", last_activity_ms: now - 60 * T_MIN },
    ];
    const actions1 = await runStaleTeamSweep({
      teams: liveTeams,
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async () => ({ ok: true as const }),
        emitInfo: () => {},
        emitAlert: () => {},
        emitVanished: (team_id, title, body) => vanished.push({ team_id, title, body }),
        teamRegistryExists: () => false,
      },
    });
    expect(actions1[0]?.action).toBe("vanished");
    expect(vanished.length).toBe(1);

    // Caller's responsibility: remove the team from its tracker. Simulate.
    const idx = liveTeams.findIndex((t) => t.team_id === "claude-gone");
    if (idx >= 0) liveTeams.splice(idx, 1);

    // Second sweep — team is no longer in the list. Nothing should fire.
    const actions2 = await runStaleTeamSweep({
      teams: liveTeams,
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now + 5 * T_MIN },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async () => ({ ok: true as const }),
        emitInfo: () => {},
        emitAlert: () => {},
        emitVanished: (team_id, title, body) => vanished.push({ team_id, title, body }),
        teamRegistryExists: () => false,
      },
    });
    expect(actions2.length).toBe(0);
    // Still exactly one vanished alert across both sweeps — no spam.
    expect(vanished.length).toBe(1);
  });

  test("teamRegistryExists omitted → behavior unchanged (pre-v2.7.32 path)", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>();
    const c = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        { team_id: "claude-x", last_activity_ms: now - 20 * T_MIN, last_event_type: "report" },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks, // no teamRegistryExists, no emitVanished
    });
    expect(c.nudges.length).toBe(1); // first-nudge fires as before
  });

  test("teamRegistryExists returns true → normal sweep path", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>();
    const c = makeCallbacks();
    let predicateCalls = 0;
    await runStaleTeamSweep({
      teams: [
        { team_id: "claude-alive", last_activity_ms: now - 20 * T_MIN },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        ...c.callbacks,
        teamRegistryExists: () => {
          predicateCalls++;
          return true;
        },
        emitVanished: () => {
          throw new Error("emitVanished should not be called when dir exists");
        },
      },
    });
    expect(predicateCalls).toBe(1);
    expect(c.nudges.length).toBe(1); // normal first-nudge still fires
  });
});

describe("runStaleTeamSweep — server.ts integration pattern (v2.8.1)", () => {
  // These tests mirror the wiring added to components/master/server.ts in
  // v2.8.1 — a stateful `vanishedTeams` Set memoizes "we already alerted
  // on this team" so the alert is one-shot across ticks, even if the
  // caller's tracker (teamLastActivity) somehow re-seeds the team between
  // sweeps (e.g. a tmux zombie pane survives the registry archive). The
  // v2.7.32 fix added the predicate to auto-nudge.ts but the operator's
  // 2026-05-13 screenshot proved the wiring was missing in server.ts.
  function makeServerLikeCallbacks(opts: {
    registryExists: (id: string) => boolean;
    vanishedTeams: Set<string>;
  }) {
    const vanishedAlerts: Array<{ team_id: string; title: string }> = [];
    const sweepInfos: Array<{ team_id: string; title: string }> = [];
    const sweepAlerts: Array<{ team_id: string; title: string }> = [];
    const nudges: Array<{ team_id: string; body: string }> = [];
    return {
      vanishedAlerts,
      sweepInfos,
      sweepAlerts,
      nudges,
      callbacks: {
        sendNudge: async (team_id: string, body: string) => {
          nudges.push({ team_id, body });
          return { ok: true as const };
        },
        emitInfo: (team_id: string, title: string) => sweepInfos.push({ team_id, title }),
        emitAlert: (team_id: string, title: string) => sweepAlerts.push({ team_id, title }),
        teamRegistryExists: opts.registryExists,
        emitVanished: (team_id: string, title: string) => {
          // One-shot guard — exactly what server.ts does.
          if (opts.vanishedTeams.has(team_id)) return;
          opts.vanishedTeams.add(team_id);
          vanishedAlerts.push({ team_id, title });
        },
      },
    };
  }

  test("operator archives a stale team mid-flight — exactly one vanished alert", async () => {
    const now = 100 * T_MIN;
    const state = new Map<string, TeamNudgeState>([
      ["claude-osint-cve-monitor", { last_nudge_at_ms: now - 31 * T_MIN }],
    ]);
    const vanishedTeams = new Set<string>();
    // Caller's tracker — server.ts's teamLastActivity.
    const tracker = new Set(["claude-osint-cve-monitor"]);

    const c = makeServerLikeCallbacks({
      registryExists: () => false, // dir was archived to .killed/
      vanishedTeams,
    });

    // Tick 1 — predicate fires, vanished alert emitted, server-side caller
    // drops the team from the tracker.
    const actions1 = await runStaleTeamSweep({
      teams: [...tracker].map((team_id) => ({
        team_id,
        last_activity_ms: now - 60 * T_MIN,
        last_event_type: "report",
      })),
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });
    for (const a of actions1) if (a.action === "vanished") tracker.delete(a.team_id);

    expect(c.vanishedAlerts.length).toBe(1);
    expect(c.nudges.length).toBe(0);
    expect(c.sweepAlerts.length).toBe(0); // not a regular team-unresponsive
    expect(vanishedTeams.has("claude-osint-cve-monitor")).toBe(true);

    // Tick 2 — pretend the inbox tailer or a tmux zombie re-seeded the
    // team into the tracker. The registry is still absent. server.ts's
    // isStillVanished() guard should normally block this, but even if it
    // doesn't (paranoia), the emitVanished memoization keeps the alert
    // one-shot.
    tracker.add("claude-osint-cve-monitor");
    const actions2 = await runStaleTeamSweep({
      teams: [...tracker].map((team_id) => ({
        team_id,
        last_activity_ms: now - 90 * T_MIN,
        last_event_type: "report",
      })),
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now + 5 * T_MIN },
      staleness_threshold_min: 15,
      callbacks: c.callbacks,
    });
    for (const a of actions2) if (a.action === "vanished") tracker.delete(a.team_id);

    expect(c.vanishedAlerts.length).toBe(1); // still one — no spam
    expect(c.nudges.length).toBe(0);
    expect(c.sweepAlerts.length).toBe(0);
  });

  test("registry dir comes back (operator re-spawn) — vanishedTeams flag is cleared by the wrapper", async () => {
    // server.ts's isStillVanished() helper: if the team is in the set
    // AND the registry dir came back, clear from the set and permit
    // tracking. This test simulates that wrapper logic directly.
    const vanishedTeams = new Set<string>(["claude-comeback"]);
    let registryPresent = false;
    function isStillVanished(team_id: string): boolean {
      if (!vanishedTeams.has(team_id)) return false;
      if (registryPresent) {
        vanishedTeams.delete(team_id);
        return false;
      }
      return true;
    }

    // Before re-spawn — still blocked.
    expect(isStillVanished("claude-comeback")).toBe(true);
    expect(vanishedTeams.has("claude-comeback")).toBe(true);

    // Operator re-spawns; registry dir reappears.
    registryPresent = true;

    // First call sees the registry, clears the flag, allows tracking.
    expect(isStillVanished("claude-comeback")).toBe(false);
    expect(vanishedTeams.has("claude-comeback")).toBe(false);

    // Subsequent calls are also unblocked.
    expect(isStillVanished("claude-comeback")).toBe(false);
  });
});

describe("runStaleTeamSweep — failed delivery does NOT advance state (WEB-216)", () => {
  test("send failure → info notification BUT last_nudge_at_ms stays absent (retry naturally)", async () => {
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
    // WEB-216 fix: state remains empty so the next sweep retries as
    // first-nudge instead of advancing to "unresponsive" 30 min later
    // on a worker that never received the nudge.
    expect(state.has("claude-down")).toBe(false);
  });

  test("two consecutive 529-failed first-nudges → both classified as first-nudge, never escalate", async () => {
    const state = new Map<string, TeamNudgeState>();
    const alerts: Array<{ team_id: string; title: string; body: string }> = [];
    const infos: Array<{ team_id: string; title: string; body: string }> = [];
    const sendNudge = async () => ({ ok: false, error: "Claude API 529 Overloaded" });

    // First sweep: stale team, send fails.
    let now = 100 * T_MIN;
    const r1 = await runStaleTeamSweep({
      teams: [{ team_id: "claude-richard-dash", last_activity_ms: now - 20 * T_MIN }],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge,
        emitInfo: (team_id, title, body) => infos.push({ team_id, title, body }),
        emitAlert: (team_id, title, body) => alerts.push({ team_id, title, body }),
      },
    });
    expect(r1[0]?.action).toBe("first-nudge");

    // Second sweep, 31 min later: send fails again. Without the WEB-216
    // fix this would escalate; with the fix, state.has(team) is still
    // false so it counts as first-nudge again.
    now = 131 * T_MIN;
    const r2 = await runStaleTeamSweep({
      teams: [{ team_id: "claude-richard-dash", last_activity_ms: 80 * T_MIN }],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge,
        emitInfo: (team_id, title, body) => infos.push({ team_id, title, body }),
        emitAlert: (team_id, title, body) => alerts.push({ team_id, title, body }),
      },
    });
    expect(r2[0]?.action).toBe("first-nudge");
    expect(alerts.length).toBe(0);
  });
});

describe("classifyWorkerReply — text → WorkerReplyKind (WEB-216)", () => {
  test("'Not stuck, not working. Idle by design.' → completed_idle", () => {
    const r = classifyWorkerReply("Not stuck, not working. Idle by design.");
    expect(r.kind).toBe("completed_idle");
    expect(r.snippet).toContain("Idle by design");
  });

  test("'redeploy-prep checklist complete, awaiting next directive' → completed_idle", () => {
    const r = classifyWorkerReply(
      "I've finished the redeploy-prep checklist complete, awaiting next directive or shutdown.",
    );
    expect(r.kind).toBe("completed_idle");
  });

  test("'awaiting shutdown' → completed_idle", () => {
    const r = classifyWorkerReply("All items complete. Awaiting shutdown.");
    expect(r.kind).toBe("completed_idle");
  });

  test("'I'm stuck on X waiting for Y' → blocked", () => {
    const r = classifyWorkerReply("I'm stuck on the migration step; waiting for Y.");
    expect(r.kind).toBe("blocked");
  });

  test("'What should I do next?' → awaiting_input", () => {
    const r = classifyWorkerReply("Almost done with the form. What should I do next?");
    expect(r.kind).toBe("awaiting_input");
  });

  test("regular working text → working", () => {
    const r = classifyWorkerReply("Implemented the parser. Running tests.");
    expect(r.kind).toBe("working");
  });

  test("empty/null/undefined → working with empty snippet", () => {
    expect(classifyWorkerReply("").kind).toBe("working");
    expect(classifyWorkerReply(null).kind).toBe("working");
    expect(classifyWorkerReply(undefined).kind).toBe("working");
  });
});

describe("runStaleTeamSweep — classification suppresses escalation (WEB-216)", () => {
  test("completed_idle classification on stale team → no nudge, no alert, state cleared", async () => {
    const now = 200 * T_MIN;
    const state = new Map<string, TeamNudgeState>([
      // Team was previously nudged.
      ["claude-richard-dash", { last_nudge_at_ms: now - 35 * T_MIN }],
    ]);
    const { callbacks, alerts, nudges, decisions } = makeCallbacks();
    const actions = await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-richard-dash",
          last_activity_ms: now - 90 * T_MIN, // very stale
          last_event_type: "report",
          classification: {
            kind: "completed_idle",
            snippet: "Not stuck, not working. Idle by design.",
          },
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks,
    });
    expect(actions[0]?.action).toBe("completed_idle");
    expect(alerts.length).toBe(0);
    expect(nudges.length).toBe(0);
    expect(state.has("claude-richard-dash")).toBe(false);
    expect(decisions[0]?.action).toBe("team_completed_idle");
    expect(decisions[0]?.rationale).toContain("Idle by design");
  });

  test("WEB-216 acceptance: 529 first nudge → later HMAC-valid reply 'idle by design' → never escalates", async () => {
    const state = new Map<string, TeamNudgeState>();

    // Sweep 1: stale, first nudge attempted, API returns 529.
    let now = 100 * T_MIN;
    const r1 = await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-richard-dash",
          last_activity_ms: now - 20 * T_MIN,
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async () => ({ ok: false, error: "Claude API 529 Overloaded" }),
        emitInfo: () => {},
        emitAlert: () => {},
      },
    });
    expect(r1[0]?.action).toBe("first-nudge");
    expect(state.has("claude-richard-dash")).toBe(false); // 529 → state NOT advanced

    // Sweep 2 (30 min later): worker has since replied "idle by design"
    // via the inbox — classifier ran and set classification on the team.
    now = 130 * T_MIN;
    const alerts: Array<{ title: string; body: string }> = [];
    const nudges: Array<{ team_id: string; body: string }> = [];
    const r2 = await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-richard-dash",
          last_activity_ms: 80 * T_MIN, // still well past threshold
          last_event_type: "report",
          classification: {
            kind: "completed_idle",
            snippet: "Not stuck, not working. Idle by design.",
          },
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks: {
        sendNudge: async (team_id, body) => {
          nudges.push({ team_id, body });
          return { ok: true };
        },
        emitInfo: () => {},
        emitAlert: (_id, title, body) => alerts.push({ title, body }),
      },
    });
    expect(r2[0]?.action).toBe("completed_idle");
    // No 🚨 unresponsive alert. No additional nudge.
    expect(alerts.length).toBe(0);
    expect(nudges.length).toBe(0);
  });

  test("classification surfaces in escalate alert body (not 'Last event: unknown')", async () => {
    const now = 200 * T_MIN;
    const state = new Map<string, TeamNudgeState>([
      ["claude-busy", { last_nudge_at_ms: now - 35 * T_MIN }],
    ]);
    const { callbacks, alerts } = makeCallbacks();
    await runStaleTeamSweep({
      teams: [
        {
          team_id: "claude-busy",
          last_activity_ms: now - 90 * T_MIN,
          classification: {
            kind: "working",
            snippet: "Running migrations…",
          },
        },
      ],
      state,
      cfg: { staleness_threshold_ms: STALENESS, nudge_retry_ms: RETRY, now_ms: now },
      staleness_threshold_min: 15,
      callbacks,
    });
    expect(alerts[0]?.body).toContain("Reply classification: working");
    expect(alerts[0]?.body).toContain("Last reply snippet: Running migrations…");
    expect(alerts[0]?.body).not.toContain("Last event: unknown");
  });
});
