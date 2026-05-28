// components/evy/compression-policy.ts
//
// v3.3.6 — Literal Hermes-spec compression policy module for v3 Evy.
//
// This module implements the threshold formula and config surface described
// verbatim in `.subctl/docs/hermes-compact-and-skills-findings.md` §1.1:
//
//   threshold_tokens = max(threshold_pct × model_context_length,
//                          MINIMUM_CONTEXT_LENGTH = 64_000)
//
// Where `threshold_pct` defaults to 0.50 and is operator-tunable via
// `compression.threshold` in `~/.config/subctl/master/config.yaml`.
//
// It coexists with the v2.7.3 absolute-token decision module
// (`compact-policy.ts`) — the older module remains the canonical surface
// for back-compat configs that set `warn_tokens` / `compact_tokens` /
// `threshold_pct`. This new module is consulted FIRST (when config.yaml is
// present) and falls through to the legacy module otherwise.
//
// Reasons for the split rather than an in-place rewrite:
//   1. v3.3.5 already shipped operator-visible behaviour changes
//      (warn-now-summarises) keyed off the legacy decision shape. Tearing
//      that out mid-release is needlessly invasive.
//   2. The legacy module's two-stage (warn / compact) shape is consumed by
//      the dashboard SSE timeline; a single-threshold Hermes-style decision
//      keeps producing the same `compact_warning` event so the dashboard
//      contract is preserved.
//   3. The literal spec asks for `compression.threshold` in YAML; the
//      legacy module reads JSON. A new file makes the surface separation
//      explicit and lets `bun test` cover each independently.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hermes constant — `agent/model_metadata.py:133`. The compression threshold
 * is clamped to never go below this floor regardless of how small the model
 * context window is, because compaction below 64K wastes the LLM-summariser
 * call on payloads that already fit in any usable model.
 */
export const MINIMUM_CONTEXT_LENGTH = 64_000;

/**
 * Hermes constant — `agent/agent_init.py:1220`. Operator can override via
 * `compression.threshold` in config.yaml; the value is a float in [0, 1]
 * representing the fraction of the model context window at which
 * compression fires.
 */
export const DEFAULT_THRESHOLD_PCT = 0.50;

export interface CompressionConfig {
  /** Compression on/off kill switch. Hermes `compression.enabled`. Default true. */
  enabled: boolean;
  /** Fraction of ctx_window above which compression fires. Hermes `compression.threshold`. Default 0.50. */
  threshold: number;
  /**
   * Optional: hard absolute floor override. When set, used in place of
   * `MINIMUM_CONTEXT_LENGTH`. Hermes also exposes per-model thresholds
   * (`auxiliary_client.py:227-239`); v3 Evy keeps it global for v3.3.6.
   */
  minimum_context_length?: number;
  /**
   * Hermes `compression.protect_first_n`. Head preservation count.
   * Default 3 (applied at compactor invocation, not here).
   */
  protect_first_n?: number;
  /** Hermes `compression.protect_last_n`. Tail-minimum count. Default 20. */
  protect_last_n?: number;
  /** Hermes `compression.target_ratio`. Tail token budget as fraction of threshold. Default 0.20. */
  target_ratio?: number;
  /** Hermes `compression.abort_on_summary_failure`. Default false. */
  abort_on_summary_failure?: boolean;
  /**
   * Optional auxiliary model override. Hermes `auxiliary.compression.model`.
   * When unset, the compactor uses the active supervisor. Shape:
   *   provider: 'openai-codex' | 'lmstudio' | …
   *   model: model name string
   *   base_url: optional override
   */
  auxiliary_model?: {
    provider: string;
    model: string;
    base_url?: string;
  };
}

/**
 * Hermes formula: `max(int(ctx * threshold_percent), MINIMUM_CONTEXT_LENGTH)`.
 * See `agent/context_compressor.py:553-556` in hermes-agent.
 *
 * @param ctxWindow Model context window in tokens (e.g. 200_000 for a
 *   200K-window model). When 0 or negative, returns the floor.
 * @param cfg CompressionConfig (use `loadCompressionConfig()` to populate).
 */
export function computeThresholdTokens(
  ctxWindow: number,
  cfg: CompressionConfig,
): number {
  const floor = cfg.minimum_context_length ?? MINIMUM_CONTEXT_LENGTH;
  if (!Number.isFinite(ctxWindow) || ctxWindow <= 0) return floor;
  const pct = Number.isFinite(cfg.threshold) ? cfg.threshold : DEFAULT_THRESHOLD_PCT;
  const clampedPct = Math.max(0, Math.min(1, pct));
  return Math.max(Math.floor(ctxWindow * clampedPct), floor);
}

/**
 * Hermes decision algorithm (`agent/context_compressor.py:614-634`):
 *   should_compress = (real_prompt_tokens >= threshold_tokens)
 *
 * Real prompt_tokens means the value returned by the most recent supervisor
 * API response's `usage.prompt_tokens` — NOT the synthetic char/4
 * estimator. The estimator is used as a fallback only when usage data is
 * missing (e.g. first turn pre-call, or a provider that doesn't surface
 * usage).
 *
 * Returns `false` immediately when `cfg.enabled === false` (kill switch).
 */
export function shouldCompress(
  realPromptTokens: number,
  ctxWindow: number,
  cfg: CompressionConfig,
): boolean {
  if (!cfg.enabled) return false;
  const t = computeThresholdTokens(ctxWindow, cfg);
  return Math.max(0, Math.floor(realPromptTokens || 0)) >= t;
}

export function defaultCompressionConfig(): CompressionConfig {
  return { enabled: true, threshold: DEFAULT_THRESHOLD_PCT };
}

function defaultConfigPath(): string {
  return join(
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
    "master",
    "config.yaml",
  );
}

/**
 * Read `compression.*` keys from `~/.config/subctl/master/config.yaml`.
 *
 * Missing file or parse error → sensible defaults (the daemon must never
 * fail to boot just because the operator hasn't authored config.yaml yet,
 * which is the common case immediately after upgrading to v3.3.6).
 *
 * YAML shape:
 *   compression:
 *     enabled: true              # optional, default true
 *     threshold: 0.50            # optional, default 0.50
 *     minimum_context_length: 64000  # optional, default 64_000
 */
export function loadCompressionConfig(path?: string): CompressionConfig {
  const p = path ?? defaultConfigPath();
  if (!existsSync(p)) return defaultCompressionConfig();
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(p, "utf8"));
  } catch {
    return defaultCompressionConfig();
  }
  if (!raw || typeof raw !== "object") return defaultCompressionConfig();
  const root = raw as Record<string, unknown>;
  const cmp = root.compression;
  if (!cmp || typeof cmp !== "object") return defaultCompressionConfig();
  const c = cmp as Record<string, unknown>;
  const cfg: CompressionConfig = {
    enabled: typeof c.enabled === "boolean" ? c.enabled : true,
    threshold:
      typeof c.threshold === "number" && Number.isFinite(c.threshold)
        ? c.threshold
        : DEFAULT_THRESHOLD_PCT,
  };
  if (
    typeof c.minimum_context_length === "number" &&
    Number.isFinite(c.minimum_context_length) &&
    c.minimum_context_length > 0
  ) {
    cfg.minimum_context_length = Math.floor(c.minimum_context_length);
  }
  if (typeof c.protect_first_n === "number" && c.protect_first_n >= 0) {
    cfg.protect_first_n = Math.floor(c.protect_first_n);
  }
  if (typeof c.protect_last_n === "number" && c.protect_last_n >= 0) {
    cfg.protect_last_n = Math.floor(c.protect_last_n);
  }
  if (
    typeof c.target_ratio === "number" &&
    c.target_ratio > 0 &&
    c.target_ratio <= 1
  ) {
    cfg.target_ratio = c.target_ratio;
  }
  if (typeof c.abort_on_summary_failure === "boolean") {
    cfg.abort_on_summary_failure = c.abort_on_summary_failure;
  }
  const aux = c.auxiliary_model;
  if (aux && typeof aux === "object") {
    const a = aux as Record<string, unknown>;
    if (typeof a.provider === "string" && typeof a.model === "string") {
      cfg.auxiliary_model = {
        provider: a.provider,
        model: a.model,
        base_url: typeof a.base_url === "string" ? a.base_url : undefined,
      };
    }
  }
  return cfg;
}
