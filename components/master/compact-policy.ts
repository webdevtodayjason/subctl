// components/master/compact-policy.ts
//
// Pure compaction-decision module for the supervisor daemon (v2.7.3).
//
// Background: the supervisor is a local LM Studio model with a finite
// loaded context window. Once its prompt budget overflows the window the
// model silently truncates and hallucinates "Standing by" non-answers. A
// 5-minute auto-compact ticker is too coarse — by the time it fires the
// supervisor can already be past 100% util on its NEXT prompt. v2.7.3
// fixes that by performing a just-in-time check at prompt-composition
// time, with two stages:
//
//   warn_tokens    — emit YELLOW warning (banner + log + SSE event)
//   compact_tokens — AUTO-COMPACT synchronously before the next prompt
//                    is composed and dispatched to the agent
//   target_tokens  — post-compact estimated transcript size
//
// The 5-minute ticker is retained as a safety net for transcripts that
// grow due to tool outputs generated AFTER the prompt was composed.
//
// Back-compat: if a deployed compact.json still uses threshold_pct (the
// v2.7.2 shape), the decision falls back to percentage mode — compact at
// threshold_pct of loaded_ctx, warn 10 percentage points below. New
// installs ship with absolute thresholds (warn=25k, compact=40k).
//
// This module is deliberately pure: no broadcasts, no agent state, no
// side effects beyond reading the config file. The caller decides what
// to DO with the decision (log, broadcast, compact, prompt-inject).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CompactConfig {
  auto_compact: boolean;
  /**
   * Absolute token threshold. When the estimated current prompt size
   * crosses `warn_tokens` the daemon emits a YELLOW warning event but
   * does NOT compact yet — operators get a chance to close out gracefully.
   * 0 means "no absolute warn threshold; fall back to threshold_pct".
   */
  warn_tokens: number;
  /**
   * Absolute token threshold. When the estimated current prompt size
   * crosses `compact_tokens` the daemon runs auto-compact synchronously
   * before composing the next prompt. 0 means "fall back to threshold_pct".
   */
  compact_tokens: number;
  /**
   * Target size after compaction. The compactor expands the "kept recent"
   * window backwards until the remaining transcript fits this budget.
   */
  target_tokens: number;
  /**
   * Minimum number of recent turns the compactor must preserve intact.
   */
  keep_recent: number;
  /**
   * @deprecated v2.7.2-and-prior config shape. The daemon still reads it
   * for back-compat when warn_tokens / compact_tokens are absent (0).
   * Preferred shape is absolute tokens. New deploys SHOULD NOT set
   * threshold_pct.
   */
  threshold_pct?: number;
}

export interface CompactDecision {
  /** What to do with the next prompt: "ok" (proceed), "warn" (banner + proceed), "compact" (compact first, then proceed). */
  action: "ok" | "warn" | "compact";
  current_tokens: number;
  /** Which rule fired. "none" means we couldn't decide (no thresholds and no loaded_ctx). */
  threshold_used:
    | "warn_tokens"
    | "compact_tokens"
    | "threshold_pct_warn"
    | "threshold_pct_compact"
    | "none";
  reason: string;
}

/**
 * Default compaction config. Encodes v2.7.3's locked operator policy:
 *   warn at 25k, compact at 40k, target 30k, keep 6 recent.
 *
 * These numbers come from the empirical context-overflow incident on the
 * M3 Ultra (2026-05-12): the supervisor's 65k window started hallucinating
 * around 40k of transcript tokens once SKILL + tool schemas were added on
 * top. 25k gives the operator ~5 minutes of advance warning at typical
 * conversational pace.
 */
export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  auto_compact: true,
  warn_tokens: 25_000,
  compact_tokens: 40_000,
  target_tokens: 30_000,
  keep_recent: 6,
};

function defaultConfigPath(): string {
  return join(
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
    "master",
    "compact.json",
  );
}

/**
 * Read the compact policy config from disk. Returns sensible defaults on
 * missing file or parse error — the daemon must never fail to boot just
 * because the operator hasn't written this file.
 *
 * Field-level fallback semantics:
 *   - auto_compact, target_tokens, keep_recent — always default-filled
 *     because they have no mode-distinguishing meaning.
 *   - warn_tokens / compact_tokens — only default-filled when the file
 *     authored AT LEAST ONE of them. If the file authored NEITHER (the
 *     v2.7.2 shape where only threshold_pct exists), they stay at 0 so
 *     decideCompactAction routes to the back-compat percentage path.
 *   - threshold_pct — passed through if present in the file.
 */
export function loadCompactConfig(path?: string): CompactConfig {
  const p = path ?? defaultConfigPath();
  if (!existsSync(p)) {
    return { ...DEFAULT_COMPACT_CONFIG };
  }
  let raw: Partial<CompactConfig>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Partial<CompactConfig>;
  } catch {
    return { ...DEFAULT_COMPACT_CONFIG };
  }

  const sawAbs =
    typeof raw.warn_tokens === "number" || typeof raw.compact_tokens === "number";

  const merged: CompactConfig = {
    auto_compact:
      typeof raw.auto_compact === "boolean"
        ? raw.auto_compact
        : DEFAULT_COMPACT_CONFIG.auto_compact,
    warn_tokens: sawAbs
      ? typeof raw.warn_tokens === "number"
        ? raw.warn_tokens
        : DEFAULT_COMPACT_CONFIG.warn_tokens
      : 0,
    compact_tokens: sawAbs
      ? typeof raw.compact_tokens === "number"
        ? raw.compact_tokens
        : DEFAULT_COMPACT_CONFIG.compact_tokens
      : 0,
    target_tokens:
      typeof raw.target_tokens === "number"
        ? raw.target_tokens
        : DEFAULT_COMPACT_CONFIG.target_tokens,
    keep_recent:
      typeof raw.keep_recent === "number"
        ? raw.keep_recent
        : DEFAULT_COMPACT_CONFIG.keep_recent,
  };
  if (typeof raw.threshold_pct === "number") {
    merged.threshold_pct = raw.threshold_pct;
  }
  return merged;
}

/**
 * Decide whether to warn, compact, or proceed before composing the next
 * supervisor prompt.
 *
 * Algorithm:
 *   1. If cfg has valid absolute thresholds (warn_tokens>0, compact_tokens>0,
 *      compact_tokens>warn_tokens): use them. This is the canonical v2.7.3
 *      path. Predictable regardless of what model is loaded.
 *   2. Otherwise fall back to percentage mode against loadedCtx using
 *      threshold_pct (defaulting to 90 if absent). Warn at 10pp below.
 *      If loadedCtx is unknown (0 / null / cloud supervisor), return "ok"
 *      — we can't compute util without it.
 */
export function decideCompactAction(
  currentTokens: number,
  loadedCtx: number,
  cfg: CompactConfig,
): CompactDecision {
  const safeCurrent = Math.max(0, Math.floor(currentTokens || 0));

  const hasAbs =
    typeof cfg.warn_tokens === "number" &&
    typeof cfg.compact_tokens === "number" &&
    cfg.warn_tokens > 0 &&
    cfg.compact_tokens > 0 &&
    cfg.compact_tokens > cfg.warn_tokens;

  if (hasAbs) {
    if (safeCurrent >= cfg.compact_tokens) {
      return {
        action: "compact",
        current_tokens: safeCurrent,
        threshold_used: "compact_tokens",
        reason: `current ${safeCurrent} tok >= compact_tokens ${cfg.compact_tokens}`,
      };
    }
    if (safeCurrent >= cfg.warn_tokens) {
      return {
        action: "warn",
        current_tokens: safeCurrent,
        threshold_used: "warn_tokens",
        reason: `current ${safeCurrent} tok >= warn_tokens ${cfg.warn_tokens} (auto-compact fires at ${cfg.compact_tokens})`,
      };
    }
    return {
      action: "ok",
      current_tokens: safeCurrent,
      threshold_used: "warn_tokens",
      reason: `current ${safeCurrent} tok < warn_tokens ${cfg.warn_tokens}`,
    };
  }

  // Back-compat: threshold_pct against loadedCtx.
  if (!loadedCtx || loadedCtx <= 0) {
    return {
      action: "ok",
      current_tokens: safeCurrent,
      threshold_used: "none",
      reason: `no loaded_ctx and no absolute thresholds — cannot decide, defaulting to ok`,
    };
  }
  const pct = typeof cfg.threshold_pct === "number" ? cfg.threshold_pct : 90;
  const util = safeCurrent / loadedCtx;
  const compactAt = pct / 100;
  const warnAt = Math.max(0, (pct - 10) / 100);
  const utilPct = Math.round(util * 100);
  if (util >= compactAt) {
    return {
      action: "compact",
      current_tokens: safeCurrent,
      threshold_used: "threshold_pct_compact",
      reason: `util ${utilPct}% >= ${pct}% (loaded_ctx=${loadedCtx} tok)`,
    };
  }
  if (util >= warnAt) {
    return {
      action: "warn",
      current_tokens: safeCurrent,
      threshold_used: "threshold_pct_warn",
      reason: `util ${utilPct}% >= ${Math.round(warnAt * 100)}% (compact fires at ${pct}%)`,
    };
  }
  return {
    action: "ok",
    current_tokens: safeCurrent,
    threshold_used: "threshold_pct_warn",
    reason: `util ${utilPct}% < ${Math.round(warnAt * 100)}%`,
  };
}

export interface MinimalMessage {
  content?: unknown;
}

/**
 * Estimate transcript tokens via the char/4 heuristic. Matches the
 * algorithm inside /context and the legacy auto-compact ticker so the
 * JIT check and the dashboard meter agree on the number.
 *
 * Does NOT add fixed system+tool overhead — callers add that themselves
 * (typically +2500 for SKILL.md + tool schemas) to keep this function
 * pure and easy to test.
 */
export function estimateTranscriptTokens(
  messages: ReadonlyArray<MinimalMessage>,
): number {
  let chars = 0;
  for (const m of messages) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") chars += b.text.length;
      if (typeof b.thinking === "string") chars += b.thinking.length;
      if (b.arguments && typeof b.arguments === "object") {
        try {
          chars += JSON.stringify(b.arguments).length;
        } catch {
          /* circular / non-serializable — skip */
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
