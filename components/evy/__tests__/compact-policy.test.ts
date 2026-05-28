// components/evy/__tests__/compact-policy.test.ts
//
// Tests for the v2.7.3 compact-policy module. The decision logic is the
// algorithm that keeps the supervisor from ever seeing an over-budget
// prompt — every branch + edge case is covered here, so server.ts can
// trust the verdict without re-verifying.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_COMPACT_CONFIG,
  decideCompactAction,
  estimateTranscriptTokens,
  loadCompactConfig,
  type CompactConfig,
} from "../compact-policy";

// ---------------------------------------------------------------------------
// decideCompactAction — absolute-token (v2.7.3) mode
// ---------------------------------------------------------------------------

describe("decideCompactAction — absolute thresholds (v2.7.3)", () => {
  const cfg: CompactConfig = {
    auto_compact: true,
    warn_tokens: 25_000,
    compact_tokens: 40_000,
    target_tokens: 30_000,
    keep_recent: 6,
  };

  test("returns ok when below warn_tokens", () => {
    const d = decideCompactAction(10_000, 65_000, cfg);
    expect(d.action).toBe("ok");
    expect(d.threshold_used).toBe("warn_tokens");
    expect(d.current_tokens).toBe(10_000);
  });

  test("returns warn when between warn_tokens and compact_tokens", () => {
    const d = decideCompactAction(30_000, 65_000, cfg);
    expect(d.action).toBe("warn");
    expect(d.threshold_used).toBe("warn_tokens");
    expect(d.reason).toContain("25000");
    expect(d.reason).toContain("40000");
  });

  test("returns compact when at or above compact_tokens", () => {
    const d = decideCompactAction(40_000, 65_000, cfg);
    expect(d.action).toBe("compact");
    expect(d.threshold_used).toBe("compact_tokens");
  });

  test("returns warn exactly AT warn_tokens (boundary inclusive)", () => {
    const d = decideCompactAction(25_000, 65_000, cfg);
    expect(d.action).toBe("warn");
  });

  test("returns compact exactly AT compact_tokens (boundary inclusive)", () => {
    const d = decideCompactAction(40_000, 65_000, cfg);
    expect(d.action).toBe("compact");
  });

  test("loadedCtx is irrelevant when absolute thresholds are set", () => {
    // loadedCtx=0 would normally break percentage mode; absolute mode
    // ignores it entirely.
    const d = decideCompactAction(45_000, 0, cfg);
    expect(d.action).toBe("compact");
  });
});

// ---------------------------------------------------------------------------
// decideCompactAction — back-compat percentage mode
// ---------------------------------------------------------------------------

describe("decideCompactAction — back-compat threshold_pct mode", () => {
  const pctCfg: CompactConfig = {
    auto_compact: true,
    warn_tokens: 0,
    compact_tokens: 0,
    target_tokens: 50_000,
    keep_recent: 6,
    threshold_pct: 90,
  };

  test("warns 10 percentage points below threshold_pct", () => {
    // 80% of 65k = 52,000. At 52,000 we're at 80% → warn (compact at 90%).
    const d = decideCompactAction(52_000, 65_000, pctCfg);
    expect(d.action).toBe("warn");
    expect(d.threshold_used).toBe("threshold_pct_warn");
  });

  test("compacts at or above threshold_pct (90% of loadedCtx)", () => {
    // 90% of 65k = 58,500.
    const d = decideCompactAction(58_500, 65_000, pctCfg);
    expect(d.action).toBe("compact");
    expect(d.threshold_used).toBe("threshold_pct_compact");
  });

  test("returns ok well below warn band (under 80% of loadedCtx)", () => {
    const d = decideCompactAction(30_000, 65_000, pctCfg);
    expect(d.action).toBe("ok");
    expect(d.threshold_used).toBe("threshold_pct_warn");
  });

  test("defaults threshold_pct to 90 when absent in back-compat path", () => {
    const cfg: CompactConfig = {
      auto_compact: true,
      warn_tokens: 0,
      compact_tokens: 0,
      target_tokens: 50_000,
      keep_recent: 6,
    };
    // 90% of 50k = 45,000 → compact at 45k.
    expect(decideCompactAction(45_000, 50_000, cfg).action).toBe("compact");
    // 80% of 50k = 40,000 → warn at 40k.
    expect(decideCompactAction(40_000, 50_000, cfg).action).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// decideCompactAction — edge cases
// ---------------------------------------------------------------------------

describe("decideCompactAction — edge cases", () => {
  test("currentTokens = 0 → ok in absolute mode", () => {
    const d = decideCompactAction(0, 65_000, DEFAULT_COMPACT_CONFIG);
    expect(d.action).toBe("ok");
    expect(d.current_tokens).toBe(0);
  });

  test("loadedCtx = 0 in pct-only mode → ok with threshold_used=none", () => {
    const cfg: CompactConfig = {
      auto_compact: true,
      warn_tokens: 0,
      compact_tokens: 0,
      target_tokens: 50_000,
      keep_recent: 6,
      threshold_pct: 90,
    };
    const d = decideCompactAction(30_000, 0, cfg);
    expect(d.action).toBe("ok");
    expect(d.threshold_used).toBe("none");
  });

  test("negative currentTokens is clamped to 0", () => {
    const d = decideCompactAction(-100, 65_000, DEFAULT_COMPACT_CONFIG);
    expect(d.current_tokens).toBe(0);
    expect(d.action).toBe("ok");
  });

  test("invalid absolute thresholds (compact <= warn) falls back to pct mode", () => {
    const broken: CompactConfig = {
      auto_compact: true,
      warn_tokens: 50_000,
      compact_tokens: 40_000, // inverted!
      target_tokens: 30_000,
      keep_recent: 6,
      threshold_pct: 90,
    };
    const d = decideCompactAction(58_500, 65_000, broken);
    // Falls through to pct path since absolute thresholds are invalid.
    expect(d.action).toBe("compact");
    expect(d.threshold_used).toBe("threshold_pct_compact");
  });
});

// ---------------------------------------------------------------------------
// loadCompactConfig — disk parsing
// ---------------------------------------------------------------------------

describe("loadCompactConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "subctl-compact-policy-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns sensible defaults when file is missing (v3.3.5 — Hermes-bumped)", () => {
    const cfg = loadCompactConfig(join(tmp, "nonexistent.json"));
    expect(cfg.auto_compact).toBe(true);
    expect(cfg.warn_tokens).toBe(55_000);
    expect(cfg.compact_tokens).toBe(70_000);
    expect(cfg.target_tokens).toBe(55_000);
    expect(cfg.keep_recent).toBe(6);
    expect(cfg.threshold_pct).toBeUndefined();
  });

  test("parses the new absolute-threshold shape", () => {
    const p = join(tmp, "compact.json");
    writeFileSync(
      p,
      JSON.stringify({
        auto_compact: true,
        warn_tokens: 20_000,
        compact_tokens: 35_000,
        target_tokens: 28_000,
        keep_recent: 8,
      }),
    );
    const cfg = loadCompactConfig(p);
    expect(cfg.warn_tokens).toBe(20_000);
    expect(cfg.compact_tokens).toBe(35_000);
    expect(cfg.target_tokens).toBe(28_000);
    expect(cfg.keep_recent).toBe(8);
  });

  test("back-compat: file with only threshold_pct keeps warn/compact=0", () => {
    const p = join(tmp, "compact.json");
    writeFileSync(
      p,
      JSON.stringify({
        auto_compact: true,
        threshold_pct: 85,
        target_tokens: 50_000,
        keep_recent: 6,
      }),
    );
    const cfg = loadCompactConfig(p);
    expect(cfg.threshold_pct).toBe(85);
    expect(cfg.warn_tokens).toBe(0);
    expect(cfg.compact_tokens).toBe(0);
    // decideCompactAction routes to pct mode for this config
    const d = decideCompactAction(50_000, 60_000, cfg);
    // util = 50000/60000 = 83.3% → between 75% (warn) and 85% (compact)
    expect(d.action).toBe("warn");
    expect(d.threshold_used).toBe("threshold_pct_warn");
  });

  test("new shape file with threshold_pct present prefers absolute thresholds", () => {
    const p = join(tmp, "compact.json");
    writeFileSync(
      p,
      JSON.stringify({
        auto_compact: true,
        warn_tokens: 25_000,
        compact_tokens: 40_000,
        target_tokens: 30_000,
        keep_recent: 6,
        threshold_pct: 90, // deprecated leftover — should be ignored
      }),
    );
    const cfg = loadCompactConfig(p);
    expect(cfg.warn_tokens).toBe(25_000);
    expect(cfg.threshold_pct).toBe(90); // preserved but not consulted
    const d = decideCompactAction(58_500, 65_000, cfg);
    // In pct mode this would be compact (90% of 65k); in abs mode 58.5k > 40k.
    expect(d.action).toBe("compact");
    expect(d.threshold_used).toBe("compact_tokens");
  });

  test("malformed JSON returns defaults rather than throwing", () => {
    const p = join(tmp, "compact.json");
    writeFileSync(p, "{ this is not json ");
    const cfg = loadCompactConfig(p);
    expect(cfg.warn_tokens).toBe(55_000);
    expect(cfg.compact_tokens).toBe(70_000);
  });

  test("auto_compact=false is respected when present", () => {
    const p = join(tmp, "compact.json");
    writeFileSync(p, JSON.stringify({ auto_compact: false, warn_tokens: 10_000, compact_tokens: 20_000 }));
    const cfg = loadCompactConfig(p);
    expect(cfg.auto_compact).toBe(false);
    expect(cfg.warn_tokens).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// estimateTranscriptTokens — char/4 heuristic
// ---------------------------------------------------------------------------

describe("estimateTranscriptTokens", () => {
  test("empty messages → 0", () => {
    expect(estimateTranscriptTokens([])).toBe(0);
  });

  test("text blocks contribute chars/4", () => {
    const msgs = [
      { content: [{ type: "text", text: "hello world" }] }, // 11 chars
      { content: [{ type: "text", text: "x".repeat(400) }] }, // 400 chars
    ];
    // (11 + 400) / 4 = 102.75 → ceil → 103
    expect(estimateTranscriptTokens(msgs)).toBe(103);
  });

  test("thinking blocks contribute chars/4", () => {
    const msgs = [{ content: [{ type: "thinking", thinking: "x".repeat(80) }] }];
    expect(estimateTranscriptTokens(msgs)).toBe(20);
  });

  test("tool-call arguments contribute serialized chars/4", () => {
    const msgs = [
      {
        content: [
          {
            type: "toolCall",
            name: "subctl_orch_state",
            arguments: { project: "subctl", verbose: true }, // ~40 chars JSON
          },
        ],
      },
    ];
    const out = estimateTranscriptTokens(msgs);
    expect(out).toBeGreaterThan(5);
    expect(out).toBeLessThan(20);
  });

  test("ignores non-array content fields", () => {
    const msgs = [
      { content: "not an array" as unknown },
      { content: undefined },
      {},
    ];
    expect(estimateTranscriptTokens(msgs as Array<{ content?: unknown }>)).toBe(0);
  });

  test("handles circular argument objects without throwing", () => {
    const a: Record<string, unknown> = { a: 1 };
    a.self = a;
    const msgs = [{ content: [{ type: "toolCall", arguments: a }] }];
    // Should not throw; circular skipped, result is 0 (no other content).
    expect(estimateTranscriptTokens(msgs)).toBe(0);
  });
});
