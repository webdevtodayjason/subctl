// dashboard/lib/account-verdict.ts
//
// ── v2.8.1 accounts data fix ──
//
// Per-account dispatch verdict — extracted from dashboard/server.ts so the
// logic is unit-testable. The classic surface (`green` / `yellow` / `red`)
// is preserved because the frontend CSS + WS notifier keys off those exact
// strings (see app.js: `verdictPill`, `notifyOnVerdictChange`,
// `flashPulse`, `.dispatch-verdict.{green,yellow,red}` rules in style.css).
//
// The bug we are fixing here (operator report 2026-05-13):
//
//   "The dashboard is broken under Accounts. It shows that every one of
//    the accounts is ready and dispatches go when I know that one of
//    them is 98% and some other ones have percentages used, so this
//    information is not real."
//
// Root cause: when `usage` is `null` (because `subctl usage --json`
// failed, timed out, or the account didn't appear in the result set),
// the previous implementation fell through every threshold check and
// returned `{ verdict: "green", reasons: [] }` — i.e. an authed account
// with NO usage data silently rendered as "all clear, dispatches go".
//
// Fix: treat missing usage data as an explicit signal — `yellow` with a
// human-readable reason — so the operator sees a CAUTION badge instead
// of a false-positive green.
//
// Threshold semantics (aligned with the team-lead spec for v2.8.1):
//
//   go         → under 80% usage         (green)
//   caution    → 80–95% usage            (yellow)
//   throttle   → 95–100% usage           (red — dispatch urgent only)
//   over       → past hard limit         (red — no dispatch)
//
// Color mapping stays green/yellow/red (load-bearing for UI), but the
// thresholds match the spec above. 7-day-window thresholds previously
// bumped yellow at 70% and red at 90%; both are tightened so the
// 80%/95% line is the single number the operator memorizes.

export type VerdictColor = "green" | "yellow" | "red";

export interface UsageEntry {
  five_hour?:        { utilization: number; resets_at: string | null } | null;
  seven_day?:        { utilization: number; resets_at: string | null } | null;
  seven_day_sonnet?: { utilization: number; resets_at: string | null } | null;
  seven_day_opus?:   { utilization: number; resets_at: string | null } | null;
  extra_usage?:      { is_enabled: boolean; monthly_limit?: number; used_credits?: number; currency?: string } | null;
  [key: string]: unknown;
}

export interface AccountVerdict {
  verdict: VerdictColor;
  reasons: string[];
  /**
   * When true, the verdict reflects MISSING usage data, not a real signal.
   * The frontend uses this to render a distinctive "no data" badge instead
   * of the normal pill, and to suppress the percentage bars (they would be
   * 0% otherwise and falsely imply low usage).
   */
  data_missing?: boolean;
}

// Yellow/red percentage thresholds.
// 80/95 matches the team-lead spec: go < 80, caution 80–95, throttle ≥ 95.
export const THRESH_YELLOW = 80;
export const THRESH_RED    = 95;

export interface ComputeArgs {
  alias: string;
  authReady: boolean;
  usage: UsageEntry | null;
  recent429: number;
  parallelOnAccount: number;
  /**
   * Whether the upstream usage fetch was attempted at all and produced data
   * for this alias. When `false`, the verdict is forced to yellow with a
   * "data unavailable" reason — we do NOT default to green just because
   * thresholds were never compared.
   */
  usageFetchOk?: boolean;
}

export function computeAccountVerdict(args: ComputeArgs): AccountVerdict {
  const reasons: string[] = [];
  let level: VerdictColor = "green";
  const bump = (l: "yellow" | "red") => {
    if (l === "red") level = "red";
    else if (level !== "red") level = "yellow";
  };

  if (!args.authReady) {
    return { verdict: "red", reasons: ["account not authenticated"] };
  }

  // ── v2.8.1 accounts data fix ──
  // No usage payload for this account → yellow with explicit reason.
  // This is what fixes the "every account shows green" symptom: previously
  // every authed account with a null `usage` fell through to green.
  if (!args.usage) {
    const why = args.usageFetchOk === false
      ? "usage fetch failed — check `subctl usage`"
      : "usage data unavailable — has Anthropic OAuth been re-authed?";
    return { verdict: "yellow", reasons: [why], data_missing: true };
  }

  const wkly = args.usage.seven_day?.utilization;
  if (typeof wkly === "number") {
    if (wkly >= THRESH_RED)         { bump("red");    reasons.push(`weekly ${wkly}% (throttle ≥${THRESH_RED}%)`); }
    else if (wkly >= THRESH_YELLOW) { bump("yellow"); reasons.push(`weekly ${wkly}% (caution ≥${THRESH_YELLOW}%)`); }
  }

  const sess = args.usage.five_hour?.utilization;
  if (typeof sess === "number") {
    if (sess >= THRESH_RED)         { bump("red");    reasons.push(`5h ${sess}% (throttle ≥${THRESH_RED}%)`); }
    else if (sess >= THRESH_YELLOW) { bump("yellow"); reasons.push(`5h ${sess}% (caution ≥${THRESH_YELLOW}%)`); }
  }

  // Sonnet-specific weekly window — Claude Max plans now meter Sonnet
  // separately, so an account can be 60% on the all-models window but
  // already at 95% on Sonnet alone. Surface it.
  const sonW = args.usage.seven_day_sonnet?.utilization;
  if (typeof sonW === "number") {
    if (sonW >= THRESH_RED)         { bump("red");    reasons.push(`weekly Sonnet ${sonW}% (throttle ≥${THRESH_RED}%)`); }
    else if (sonW >= THRESH_YELLOW) { bump("yellow"); reasons.push(`weekly Sonnet ${sonW}% (caution ≥${THRESH_YELLOW}%)`); }
  }

  // Extra-usage (paid credit) over-limit — if the operator has enabled
  // pay-as-you-go top-up AND the monthly limit is set AND consumed credits
  // have crossed it, that's the "over" state.
  const eu = args.usage.extra_usage;
  if (eu && eu.is_enabled && typeof eu.monthly_limit === "number" && typeof eu.used_credits === "number") {
    if (eu.used_credits >= eu.monthly_limit) {
      bump("red");
      reasons.push(`extra-usage over limit (${eu.used_credits}/${eu.monthly_limit} ${eu.currency ?? ""})`.trim());
    }
  }

  if (args.recent429 >= 3)      { bump("red");    reasons.push(`${args.recent429} RL hits today`); }
  else if (args.recent429 >= 1) { bump("yellow"); reasons.push(`${args.recent429} RL hit${args.recent429 === 1 ? "" : "s"} today`); }

  if (args.parallelOnAccount >= 5)      { bump("red");    reasons.push(`${args.parallelOnAccount} parallel sessions on this account`); }
  else if (args.parallelOnAccount >= 3) { bump("yellow"); reasons.push(`${args.parallelOnAccount} parallel sessions on this account`); }

  return { verdict: level, reasons };
}

/**
 * Human label for the verdict — matches the team-lead's dispatch model:
 *   green   → "go"
 *   yellow  → "caution"
 *   red     → "throttle" (95-100%) or "over" (past hard limit)
 * We don't try to distinguish throttle vs over here — the reasons already
 * carry that nuance, and the UI renders a single pill per row.
 */
export function dispatchLabel(v: VerdictColor): "go" | "caution" | "throttle" {
  switch (v) {
    case "green":  return "go";
    case "yellow": return "caution";
    case "red":    return "throttle";
  }
}
