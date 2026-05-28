// components/evy/__tests__/compression-policy.test.ts
//
// v3.3.6 — tests for the Hermes-literal compression policy module
// (.subctl/docs/hermes-compact-and-skills-findings.md §1.1).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_THRESHOLD_PCT,
  MINIMUM_CONTEXT_LENGTH,
  computeThresholdTokens,
  defaultCompressionConfig,
  loadCompressionConfig,
  shouldCompress,
  type CompressionConfig,
} from "../compression-policy";

// ---------------------------------------------------------------------------
// computeThresholdTokens — Hermes formula: max(pct × ctx, 64K)
// ---------------------------------------------------------------------------

describe("computeThresholdTokens — Hermes formula", () => {
  const cfg = defaultCompressionConfig();

  test("200K-window model with default 0.50 threshold → 100K", () => {
    // max(0.50 × 200_000, 64_000) = max(100_000, 64_000) = 100_000
    expect(computeThresholdTokens(200_000, cfg)).toBe(100_000);
  });

  test("64K-window model with default 0.50 threshold → 64K (floor wins)", () => {
    // max(0.50 × 64_000, 64_000) = max(32_000, 64_000) = 64_000
    expect(computeThresholdTokens(64_000, cfg)).toBe(64_000);
  });

  test("128K-window model with default 0.50 threshold → 64K (floor wins)", () => {
    // max(0.50 × 128_000, 64_000) = max(64_000, 64_000) = 64_000
    expect(computeThresholdTokens(128_000, cfg)).toBe(64_000);
  });

  test("128K-window model with custom 0.75 threshold → 96K (Trinity Thinking model bump)", () => {
    const trinity: CompressionConfig = { enabled: true, threshold: 0.75 };
    // max(0.75 × 128_000, 64_000) = max(96_000, 64_000) = 96_000
    expect(computeThresholdTokens(128_000, trinity)).toBe(96_000);
  });

  test("minimum_context_length override raises the floor", () => {
    const overridden: CompressionConfig = {
      enabled: true,
      threshold: 0.50,
      minimum_context_length: 128_000,
    };
    // max(0.50 × 200_000, 128_000) = max(100_000, 128_000) = 128_000
    expect(computeThresholdTokens(200_000, overridden)).toBe(128_000);
  });

  test("ctxWindow=0 → floor returned", () => {
    expect(computeThresholdTokens(0, cfg)).toBe(MINIMUM_CONTEXT_LENGTH);
  });

  test("negative ctxWindow → floor returned", () => {
    expect(computeThresholdTokens(-1, cfg)).toBe(MINIMUM_CONTEXT_LENGTH);
  });

  test("NaN ctxWindow → floor returned", () => {
    expect(computeThresholdTokens(Number.NaN, cfg)).toBe(MINIMUM_CONTEXT_LENGTH);
  });

  test("threshold > 1 is clamped to 1", () => {
    const bad: CompressionConfig = { enabled: true, threshold: 5.0 };
    // clamped to 1.0 → max(1.0 × 200_000, 64_000) = 200_000
    expect(computeThresholdTokens(200_000, bad)).toBe(200_000);
  });

  test("threshold < 0 is clamped to 0 → floor wins", () => {
    const bad: CompressionConfig = { enabled: true, threshold: -0.5 };
    // clamped to 0 → max(0, 64_000) = 64_000
    expect(computeThresholdTokens(200_000, bad)).toBe(MINIMUM_CONTEXT_LENGTH);
  });

  test("NaN threshold falls back to DEFAULT_THRESHOLD_PCT", () => {
    const bad: CompressionConfig = { enabled: true, threshold: Number.NaN };
    // Falls back to 0.50: max(0.50 × 200_000, 64_000) = 100_000
    expect(computeThresholdTokens(200_000, bad)).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// shouldCompress — decision algorithm
// ---------------------------------------------------------------------------

describe("shouldCompress — Hermes decision algorithm", () => {
  const cfg = defaultCompressionConfig();

  test("returns true at exactly the threshold (boundary inclusive)", () => {
    // 200K × 0.50 = 100K threshold; at 100K we compress.
    expect(shouldCompress(100_000, 200_000, cfg)).toBe(true);
  });

  test("returns false just under the threshold", () => {
    expect(shouldCompress(99_999, 200_000, cfg)).toBe(false);
  });

  test("returns true above the threshold", () => {
    expect(shouldCompress(150_000, 200_000, cfg)).toBe(true);
  });

  test("returns false when enabled=false (kill switch)", () => {
    const disabled: CompressionConfig = { enabled: false, threshold: 0.50 };
    expect(shouldCompress(150_000, 200_000, disabled)).toBe(false);
  });

  test("negative realPromptTokens is clamped to 0 → false at any reasonable threshold", () => {
    expect(shouldCompress(-1000, 200_000, cfg)).toBe(false);
  });

  test("floor kicks in on small windows: at 64K threshold floor, 64K tokens compresses", () => {
    // 64K window × 0.50 = 32K, but floor is 64K → effective threshold 64K
    expect(shouldCompress(64_000, 64_000, cfg)).toBe(true);
  });

  test("floor kicks in on small windows: at 63K tokens we don't compress yet", () => {
    expect(shouldCompress(63_999, 64_000, cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadCompressionConfig — config.yaml parsing
// ---------------------------------------------------------------------------

describe("loadCompressionConfig — config.yaml parsing", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "subctl-compression-config-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing file → default config (enabled, threshold=0.50)", () => {
    const cfg = loadCompressionConfig(join(tmp, "nonexistent.yaml"));
    expect(cfg.enabled).toBe(true);
    expect(cfg.threshold).toBe(DEFAULT_THRESHOLD_PCT);
    expect(cfg.minimum_context_length).toBeUndefined();
  });

  test("YAML with compression.threshold override", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, "compression:\n  threshold: 0.75\n");
    const cfg = loadCompressionConfig(p);
    expect(cfg.threshold).toBe(0.75);
    expect(cfg.enabled).toBe(true);
  });

  test("YAML with compression.enabled: false (kill switch)", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, "compression:\n  enabled: false\n");
    const cfg = loadCompressionConfig(p);
    expect(cfg.enabled).toBe(false);
  });

  test("YAML with full compression block (threshold + minimum_context_length + protect_n + ratio)", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(
      p,
      `compression:
  enabled: true
  threshold: 0.60
  minimum_context_length: 100000
  protect_first_n: 5
  protect_last_n: 30
  target_ratio: 0.25
  abort_on_summary_failure: true
`,
    );
    const cfg = loadCompressionConfig(p);
    expect(cfg.threshold).toBe(0.60);
    expect(cfg.minimum_context_length).toBe(100_000);
    expect(cfg.protect_first_n).toBe(5);
    expect(cfg.protect_last_n).toBe(30);
    expect(cfg.target_ratio).toBe(0.25);
    expect(cfg.abort_on_summary_failure).toBe(true);
  });

  test("YAML with auxiliary_model block populates the override", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(
      p,
      `compression:
  auxiliary_model:
    provider: lmstudio
    model: qwen2.5-7b-instruct
    base_url: http://127.0.0.1:1234
`,
    );
    const cfg = loadCompressionConfig(p);
    expect(cfg.auxiliary_model).toEqual({
      provider: "lmstudio",
      model: "qwen2.5-7b-instruct",
      base_url: "http://127.0.0.1:1234",
    });
  });

  test("malformed YAML → defaults (no throw)", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, "this is: { not [ valid yaml ]");
    const cfg = loadCompressionConfig(p);
    expect(cfg.enabled).toBe(true);
    expect(cfg.threshold).toBe(DEFAULT_THRESHOLD_PCT);
  });

  test("YAML without compression block → defaults", () => {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, "supervisor:\n  model: gpt-5.5\n");
    const cfg = loadCompressionConfig(p);
    expect(cfg.enabled).toBe(true);
    expect(cfg.threshold).toBe(DEFAULT_THRESHOLD_PCT);
  });
});
