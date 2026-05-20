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

/**
 * v2.8.8 — WEB-216 reply classification. The team-staleness watchdog
 * uses staleness as a *necessary* condition for escalation, but it is
 * not *sufficient*: a worker that explicitly says "I'm done, awaiting
 * shutdown" is idle by design, not unresponsive. The classifier maps
 * the most-recent worker reply text to a discrete state so the sweep
 * can short-circuit escalation on terminal states.
 */
export type WorkerReplyKind =
  | "working" // default — no terminal/blocking signal in the reply
  | "completed_idle" // worker explicitly said the task is done
  | "awaiting_input" // worker is waiting on the operator to answer
  | "blocked"; // worker is blocked on an external constraint

export interface ClassifiedReply {
  kind: WorkerReplyKind;
  /** Short text snippet around the matched phrase for alert bodies. */
  snippet: string;
}

/**
 * Classify a worker reply text into a WorkerReplyKind. The classifier is
 * intentionally permissive — phrases are matched case-insensitively and
 * surrounded by word-boundary tolerances rather than exact equality, so
 * paraphrases ("I'm idle by design", "task complete") match. False
 * positives degrade gracefully (a "working" team still escalates after
 * the staleness threshold); false negatives are the dangerous case
 * because they cause the WEB-216 alert spam, so we err toward matching.
 */
export function classifyWorkerReply(text: string | null | undefined): ClassifiedReply {
  if (!text || !text.trim()) {
    return { kind: "working", snippet: "" };
  }
  const lower = text.toLowerCase();

  const completedPatterns: RegExp[] = [
    /idle by design/,
    /awaiting (?:next directive|shutdown|further instructions|further direction)/,
    /(?:task|work|checklist|redeploy-prep) (?:is )?complete[d]?\b/,
    /(?:all items|all tasks) complete[d]?/,
    /\bdone with (?:the |my )?(?:task|work|checklist|prep|redeploy-prep)\b/,
    /not stuck,? not working\.?\s*idle/,
    /nothing (?:more )?to do/,
  ];
  for (const p of completedPatterns) {
    const idx = lower.search(p);
    if (idx >= 0) {
      return { kind: "completed_idle", snippet: snippetAround(text, idx) };
    }
  }

  const blockedPatterns: RegExp[] = [
    /(?:i'?m |currently )?(?:stuck on|blocked on|blocked by)/,
    /can'?t proceed/,
    /\bneed .{0,40} before (?:i can|continuing|proceeding)/,
  ];
  for (const p of blockedPatterns) {
    const idx = lower.search(p);
    if (idx >= 0) {
      return { kind: "blocked", snippet: snippetAround(text, idx) };
    }
  }

  const awaitingPatterns: RegExp[] = [
    /(?:i'?m )?(?:asking|waiting) for (?:your |operator)/,
    /need clarification/,
    /awaiting your /,
    /\bwhat should i\b/,
    /\bhow should i\b/,
  ];
  for (const p of awaitingPatterns) {
    const idx = lower.search(p);
    if (idx >= 0) {
      return { kind: "awaiting_input", snippet: snippetAround(text, idx) };
    }
  }

  return { kind: "working", snippet: text.slice(0, 200) };
}

function snippetAround(text: string, idx: number): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 120);
  let s = text.slice(start, end);
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

export interface TeamSnapshot {
  team_id: string;
  /** Date.now()-style ms of the team's most recent observed activity. */
  last_activity_ms: number;
  /** Optional event type label for the notification body ("blocked", "report", …). */
  last_event_type?: string;
  /**
   * v2.8.8 — classification of the most recent worker reply. When set to
   * "completed_idle" or "awaiting_input", the sweep skips escalation
   * even if the team's last_activity_ms is past the staleness threshold:
   * those teams are idle by design, not unresponsive. (WEB-216)
   */
  classification?: ClassifiedReply;
}

export interface SweepConfig {
  staleness_threshold_ms: number;
  /** How long to wait after a nudge before re-nudging + escalating. */
  nudge_retry_ms: number;
  now_ms: number;
}

export type SweepActionKind =
  | "fresh"           // team is not stale; clear any prior nudge state
  | "first-nudge"     // stale, never nudged: send nudge + info notification
  | "hold"            // stale + nudged within retry window: do nothing
  | "escalate"        // stale + nudged > retry window ago: alert + renudge
  | "vanished"        // team registry dir is gone — one-time alert + caller removes from tracker
  | "completed_idle"  // v2.8.8 — worker explicitly said done/idle; suppress escalation (WEB-216)
  | "awaiting_input"; // v2.8.8 — worker explicitly waiting on operator; suppress escalation (WEB-216)

export interface SweepAction {
  team_id: string;
  action: SweepActionKind;
  age_min: number;
  last_event_type?: string;
  /** Set on first-nudge + escalate, populated from now_ms; caller writes it back into state. */
  next_nudge_at_ms?: number;
  /** Set on escalate, age of the previous nudge in minutes. */
  prior_nudge_age_min?: number;
  /** v2.8.8 — classification carried through for alert-body context. */
  classification?: ClassifiedReply;
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
      classification: team.classification,
    };
  }

  // v2.8.8 — WEB-216: a stale team that has explicitly self-classified
  // as completed_idle or awaiting_input is idle by design, not
  // unresponsive. Short-circuit BEFORE the nudge/escalate logic so we
  // never page the operator on a team that already told us it's done.
  // The classifier (classifyWorkerReply) runs over the worker's most
  // recent reply text in server.ts when the inbox event arrives.
  if (team.classification?.kind === "completed_idle") {
    return {
      team_id: team.team_id,
      action: "completed_idle",
      age_min,
      last_event_type: team.last_event_type,
      classification: team.classification,
    };
  }
  if (team.classification?.kind === "awaiting_input") {
    return {
      team_id: team.team_id,
      action: "awaiting_input",
      age_min,
      last_event_type: team.last_event_type,
      classification: team.classification,
    };
  }

  // Team is stale.
  if (!state) {
    return {
      team_id: team.team_id,
      action: "first-nudge",
      age_min,
      last_event_type: team.last_event_type,
      classification: team.classification,
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
      classification: team.classification,
    };
  }

  return {
    team_id: team.team_id,
    action: "escalate",
    age_min,
    last_event_type: team.last_event_type,
    classification: team.classification,
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
  /**
   * v2.7.32 — Emit a `kind:"team-vanished"` alert. Fires when the team's
   * registry dir has been removed/archived (e.g. moved to teams/.killed/)
   * but the watchdog was still tracking it via teamLastActivity. Caller is
   * expected to also drop the team from its in-memory trackers so the
   * alert is one-shot — see SweepAction.action="vanished" handling.
   */
  emitVanished?: (team_id: string, title: string, body: string) => void;
  /**
   * v2.7.32 — Optional reconciliation predicate. When provided, the sweep
   * checks each team before deciding nudge/alert; if the predicate returns
   * false the team is treated as vanished. When omitted the sweep behaves
   * exactly as it did in v2.7.22–v2.7.31 (no reconciliation).
   */
  teamRegistryExists?: (team_id: string) => boolean;
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
    // v2.7.32 — reconcile against the on-disk registry BEFORE deciding
    // nudge/alert. The team-staleness tracker is seeded from tmux session
    // signals and the inbox; if an operator archives a team's registry
    // (e.g. mv ~/.local/state/subctl/teams/<id> ~/.local/state/subctl/teams/.killed/),
    // the in-memory tracker would keep nudging/alerting on a team that no
    // longer exists. Predicate is opt-in via callbacks.teamRegistryExists;
    // omitting it preserves pre-v2.7.32 behavior for any test fixture that
    // doesn't care about reconciliation.
    if (
      opts.callbacks.teamRegistryExists &&
      !opts.callbacks.teamRegistryExists(team.team_id)
    ) {
      const age_min = (opts.cfg.now_ms - team.last_activity_ms) / 60_000;
      actions.push({
        team_id: team.team_id,
        action: "vanished",
        age_min,
        last_event_type: team.last_event_type,
      });
      opts.state.delete(team.team_id);
      const title = `team ${team.team_id} vanished from registry`;
      const body =
        `The team-staleness watchdog was tracking ${team.team_id} but its ` +
        `registry directory (~/.local/state/subctl/teams/${team.team_id}/) ` +
        `is no longer on disk — it was likely archived to teams/.killed/ or ` +
        `removed by the operator. Dropping from the staleness tracker; no ` +
        `further alerts will fire for this team unless it's re-spawned.`;
      if (opts.callbacks.emitVanished) {
        opts.callbacks.emitVanished(team.team_id, title, body);
      }
      if (opts.callbacks.logDecision) {
        opts.callbacks.logDecision(
          team.team_id,
          "team_vanished",
          `team registry dir absent; removed from staleness tracker (age=${Math.round(age_min)}min)`,
        );
      }
      continue;
    }

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

    // v2.8.8 — WEB-216: completed/awaiting teams are NOT unresponsive.
    // Clear any prior nudge state (so a future genuine staleness signal
    // starts fresh) and log a low-severity decision instead of paging.
    if (
      decision.action === "completed_idle" ||
      decision.action === "awaiting_input"
    ) {
      if (prior) opts.state.delete(team.team_id);
      if (opts.callbacks.logDecision) {
        const snippet = decision.classification?.snippet ?? "";
        opts.callbacks.logDecision(
          team.team_id,
          `team_${decision.action}`,
          `team idle ${Math.round(decision.age_min)}min but classified as ` +
            `${decision.action} from reply text${snippet ? `: "${snippet}"` : ""}`,
        );
      }
      continue;
    }

    if (decision.action === "first-nudge") {
      const idle = Math.round(decision.age_min);
      const nudgeBody =
        `[auto-nudge] You've been inactive for ${idle} min. ` +
        `Last visible action: ${decision.last_event_type ?? "unknown"}. ` +
        `Reply with current status, or if you're stuck on something operator-facing, say so.`;
      const sendResult = await opts.callbacks.sendNudge(team.team_id, nudgeBody);
      // WEB-216 fix: only advance last_nudge_at_ms when the nudge actually
      // landed. If sendNudge returned a delivery failure (e.g. Claude API
      // 529, dashboard 5xx), the worker never received the nudge — the
      // sweep cadence IS the backoff, so the next tick will retry as
      // another first-nudge instead of escalating to "unresponsive" on a
      // worker that wasn't given the chance to respond.
      if (sendResult.ok) {
        opts.state.set(team.team_id, {
          last_nudge_at_ms: decision.next_nudge_at_ms!,
        });
      }
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
      // v2.8.8 — WEB-216: include classification + reply snippet so the
      // Telegram body shows what we DID see, instead of the stale
      // "Last event: unknown". If the classifier returned "working" or
      // had no text to classify we fall back to the prior shape.
      const classificationLine = decision.classification
        ? `Reply classification: ${decision.classification.kind}` +
          (decision.classification.snippet
            ? `\nLast reply snippet: ${decision.classification.snippet}`
            : "")
        : `Last event: ${decision.last_event_type ?? "unknown"}`;
      opts.callbacks.emitAlert(
        team.team_id,
        `${team.team_id} unresponsive (${nudgeAgo}min since nudge)`,
        `Team did not respond to the auto-nudge.\n\n` +
          `Team: ${team.team_id}\n` +
          `Total idle: ${idle} min\n` +
          `Time since last nudge: ${nudgeAgo} min\n` +
          `${classificationLine}\n\n` +
          `Re-nudging now; will alert again if still stale in ${retryMin} min.`,
      );
      const retryBody =
        `[auto-nudge · escalated] No response for ${nudgeAgo} min. ` +
        `Total idle ${idle} min. Status?`;
      const sendResult = await opts.callbacks.sendNudge(team.team_id, retryBody);
      // WEB-216 fix: only advance last_nudge_at_ms when the escalation
      // nudge actually landed. If delivery fails, leave the prior
      // last_nudge_at_ms so the next sweep recognizes the team is still
      // in "escalation pending" mode rather than starting a fresh retry
      // window on a nudge the worker never saw.
      if (sendResult.ok) {
        opts.state.set(team.team_id, {
          last_nudge_at_ms: decision.next_nudge_at_ms!,
        });
      }
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
