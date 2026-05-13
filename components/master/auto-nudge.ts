// components/master/auto-nudge.ts
//
// v2.7.22 — Auto-nudge state machine for the team-staleness watchdog.
//
// Extracted from server.ts so the decision logic is reachable from unit
// tests without booting the whole master daemon. The watchdog tick in
// server.ts calls runStaleTeamSweep() once per interval; that function
// inspects each team's last-activity timestamp against the configured
// staleness threshold and (per the spec) attempts the cheap remediation
// itself — an HMAC-authenticated subctl_orch_msg directive to the team
// lead — only escalating to the operator (via a `severity: "alert"`
// notification → Telegram push) when the nudge fails to thaw the team
// inside the 30-min retry window.
//
// Spec contract (PR v2.7.22 scope B):
//   1. Stale team detected → first nudge sent, last_nudge_at set,
//      severity:info notification emitted, no Telegram push.
//   2. Nudged team still stale 30 min later → severity:alert notification
//      with kind:"team-unresponsive" emitted; re-nudge sent; last_nudge_at
//      moves forward.
//   3. Nudged team responds before 30 min → nudge state cleared, no
//      escalation; subsequent staleness counts as a fresh first nudge.
//   4. While in "nudged, waiting for reply" (<30 min since last nudge),
//      no re-nudge AND no re-alert — the team gets the chance to reply
//      without the operator being paged.

export interface TeamNudgeState {
  last_nudge_at_ms: number;
}

export interface TeamSnapshot {
  team_id: string;
  /** Date.now()-style ms of the team's most recent observed activity. */
  last_activity_ms: number;
  /** Optional event type label for the notification body ("blocked", "report", …). */
  last_event_type?: string;
}

export interface SweepConfig {
  staleness_threshold_ms: number;
  /** How long to wait after a nudge before re-nudging + escalating. */
  nudge_retry_ms: number;
  now_ms: number;
}

export type SweepActionKind =
  | "fresh"      // team is not stale; clear any prior nudge state
  | "first-nudge"// stale, never nudged: send nudge + info notification
  | "hold"       // stale + nudged within retry window: do nothing
  | "escalate";  // stale + nudged > retry window ago: alert + renudge

export interface SweepAction {
  team_id: string;
  action: SweepActionKind;
  age_min: number;
  last_event_type?: string;
  /** Set on first-nudge + escalate, populated from now_ms; caller writes it back into state. */
  next_nudge_at_ms?: number;
  /** Set on escalate, age of the previous nudge in minutes. */
  prior_nudge_age_min?: number;
}

/**
 * Pure decision for one team given its current state. Returns the action
 * the caller should perform — no side effects here. The caller is
 * responsible for emitting notifications, dispatching the actual nudge,
 * and updating the state map per the returned action.
 */
export function decideTeamAction(
  team: TeamSnapshot,
  state: TeamNudgeState | undefined,
  cfg: SweepConfig,
): SweepAction {
  const age_min = (cfg.now_ms - team.last_activity_ms) / 60_000;

  if (cfg.now_ms - team.last_activity_ms <= cfg.staleness_threshold_ms) {
    return {
      team_id: team.team_id,
      action: "fresh",
      age_min,
      last_event_type: team.last_event_type,
    };
  }

  // Team is stale.
  if (!state) {
    return {
      team_id: team.team_id,
      action: "first-nudge",
      age_min,
      last_event_type: team.last_event_type,
      next_nudge_at_ms: cfg.now_ms,
    };
  }

  const nudge_age_ms = cfg.now_ms - state.last_nudge_at_ms;
  if (nudge_age_ms < cfg.nudge_retry_ms) {
    return {
      team_id: team.team_id,
      action: "hold",
      age_min,
      last_event_type: team.last_event_type,
    };
  }

  return {
    team_id: team.team_id,
    action: "escalate",
    age_min,
    last_event_type: team.last_event_type,
    next_nudge_at_ms: cfg.now_ms,
    prior_nudge_age_min: nudge_age_ms / 60_000,
  };
}

export interface SweepCallbacks {
  /** Send the nudge to the team lead. Implementation in server.ts hits
   *  the dashboard's HMAC-authenticated /api/orchestration/:name/msg route. */
  sendNudge: (team_id: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  /** Emit an operator notification. Implementation calls emitNotification from notifications.ts. */
  emitInfo: (team_id: string, title: string, body: string) => void;
  emitAlert: (team_id: string, title: string, body: string) => void;
  /** Optional decision log hook (server.ts wires this to logDecision). */
  logDecision?: (team_id: string, action: string, rationale: string) => void;
}

/**
 * Sweep every team, run the state machine, perform side effects via the
 * callback object, and return the updated state map. Caller persists the
 * map by reference (a Map<string, TeamNudgeState>) across ticks.
 *
 * Returns the set of actions taken this sweep so the caller can broadcast
 * a summary SSE event without re-computing.
 */
export async function runStaleTeamSweep(opts: {
  teams: ReadonlyArray<TeamSnapshot>;
  state: Map<string, TeamNudgeState>;
  cfg: SweepConfig;
  staleness_threshold_min: number;
  callbacks: SweepCallbacks;
}): Promise<SweepAction[]> {
  const actions: SweepAction[] = [];
  for (const team of opts.teams) {
    const prior = opts.state.get(team.team_id);
    const decision = decideTeamAction(team, prior, opts.cfg);
    actions.push(decision);

    if (decision.action === "fresh") {
      if (prior) opts.state.delete(team.team_id);
      continue;
    }

    if (decision.action === "hold") {
      continue;
    }

    if (decision.action === "first-nudge") {
      const idle = Math.round(decision.age_min);
      const nudgeBody =
        `[auto-nudge] You've been inactive for ${idle} min. ` +
        `Last visible action: ${decision.last_event_type ?? "unknown"}. ` +
        `Reply with current status, or if you're stuck on something operator-facing, say so.`;
      const sendResult = await opts.callbacks.sendNudge(team.team_id, nudgeBody);
      opts.state.set(team.team_id, {
        last_nudge_at_ms: decision.next_nudge_at_ms!,
      });
      const note = sendResult.ok
        ? "auto-nudge dispatched via subctl_orch_msg"
        : `auto-nudge attempted (delivery failed: ${sendResult.error})`;
      const retryMin = Math.round(opts.cfg.nudge_retry_ms / 60_000);
      opts.callbacks.emitInfo(
        team.team_id,
        `auto-nudged ${team.team_id} (${idle}min idle)`,
        `${note}.\n\n` +
          `Team: ${team.team_id}\n` +
          `Idle: ${idle} min\n` +
          `Last event: ${decision.last_event_type ?? "unknown"}\n` +
          `Threshold: ${opts.staleness_threshold_min} min\n` +
          `Re-check in: ${retryMin} min`,
      );
      if (opts.callbacks.logDecision) {
        opts.callbacks.logDecision(
          team.team_id,
          "team_auto_nudge",
          `team idle ${idle}min; ${note}`,
        );
      }
      continue;
    }

    if (decision.action === "escalate") {
      const idle = Math.round(decision.age_min);
      const nudgeAgo = Math.round(decision.prior_nudge_age_min ?? 0);
      const retryMin = Math.round(opts.cfg.nudge_retry_ms / 60_000);
      opts.callbacks.emitAlert(
        team.team_id,
        `${team.team_id} unresponsive (${nudgeAgo}min since nudge)`,
        `Team did not respond to the auto-nudge.\n\n` +
          `Team: ${team.team_id}\n` +
          `Total idle: ${idle} min\n` +
          `Time since last nudge: ${nudgeAgo} min\n` +
          `Last event: ${decision.last_event_type ?? "unknown"}\n\n` +
          `Re-nudging now; will alert again if still stale in ${retryMin} min.`,
      );
      const retryBody =
        `[auto-nudge · escalated] No response for ${nudgeAgo} min. ` +
        `Total idle ${idle} min. Status?`;
      const sendResult = await opts.callbacks.sendNudge(team.team_id, retryBody);
      opts.state.set(team.team_id, {
        last_nudge_at_ms: decision.next_nudge_at_ms!,
      });
      if (opts.callbacks.logDecision) {
        opts.callbacks.logDecision(
          team.team_id,
          "team_unresponsive",
          `team idle ${idle}min, ${nudgeAgo}min since nudge, retry=${sendResult.ok ? "ok" : `failed:${sendResult.error}`}`,
        );
      }
      continue;
    }
  }
  return actions;
}
