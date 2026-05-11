// components/master/__tests__/ctx-pin.test.ts
//
// Unit tests for decideCtxPinReload — the pure helper extracted from
// ensureModelLoaded that decides whether the master daemon should evict
// and reload an LM Studio model on boot or accept whatever's currently
// loaded.
//
// Regression context (v2.6.2): the prior check was strict equality on the
// upper bound (loaded >= desired). LM Studio rounds the requested context
// down (observed: ask 65,536, get 65,023 → a 513-token shortfall), so the
// supervisor role triggered a slow reload on EVERY restart, never reached
// stable state, and accumulated duplicate model instances in LM Studio.
//
// Fixes covered here:
//   • Tolerance window absorbs LM Studio's rounding-down quirk
//   • max_context_length check accepts models that physically can't hit desired
//   • Genuine shortfalls (> tolerance) still trigger reload — no over-tolerance

import { describe, expect, test } from "bun:test";

import { decideCtxPinReload } from "../server";

describe("decideCtxPinReload — happy path", () => {
  test("loaded exactly equals desired → skip", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 65536, max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("≥ desired");
  });

  test("loaded comfortably exceeds desired → skip", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 131072, max_context_length: 262144 },
      32768,
      "qwen/qwen3.6-27b",
      "reviewer",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("131,072");
  });
});

describe("decideCtxPinReload — LM Studio rounding-down quirk (regression for v2.6.2 supervisor reload loop)", () => {
  test("65,023 loaded vs 65,536 desired (513 tokens short) → skip via tolerance", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 65023, max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("within");
    expect(d.detail).toContain("65,023");
  });

  test("63,489 loaded vs 65,536 desired (within 2k tolerance) → skip", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 63489, max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("within");
  });

  test("63,000 loaded vs 65,536 desired (2,536 gap, just past tolerance) → reload", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 63000, max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(false);
    expect(d.detail).toContain("reloading");
  });

  test("32,768 loaded vs 65,536 desired (huge gap) → reload", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 32768, max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(false);
    expect(d.detail).toContain("reloading");
  });
});

describe("decideCtxPinReload — model max < desired (unreachable target)", () => {
  test("model max 8,192 vs desired 65,536 → skip, accept what's loaded", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 8192, max_context_length: 8192 },
      65536,
      "tiny/some-8k-model",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("model max=");
    expect(d.detail).toContain("unreachable");
  });

  test("model max equals desired → standard ≥ path (no special message)", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 65536, max_context_length: 65536 },
      65536,
      "exact/match-model",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("≥ desired");
    expect(d.detail).not.toContain("unreachable");
  });

  test("max-check still applies when loaded is far below desired but at model max", () => {
    // Desired 65,536, model can only do 32k, loaded at 32k. Accept it —
    // reloading won't get us closer to desired.
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 32768, max_context_length: 32768 },
      65536,
      "midsize/32k-model",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("unreachable");
  });
});

describe("decideCtxPinReload — not loaded / missing snapshot", () => {
  test("undefined current → reload (model isn't loaded at all)", () => {
    const d = decideCtxPinReload(undefined, 65536, "qwen/qwen3.6-27b", "supervisor");
    expect(d.skip).toBe(false);
    expect(d.detail).toContain("not currently loaded");
  });

  test('state="not-loaded" → reload', () => {
    const d = decideCtxPinReload(
      { state: "not-loaded", max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(false);
  });

  test("loaded but loaded_context_length missing → reload (can't compare)", () => {
    const d = decideCtxPinReload(
      { state: "loaded", max_context_length: 262144 },
      65536,
      "qwen/qwen3.6-27b",
      "supervisor",
    );
    expect(d.skip).toBe(false);
  });
});

describe("decideCtxPinReload — missing max_context_length", () => {
  test("no max field, loaded within tolerance → still skip", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 65023 },
      65536,
      "old/lmstudio-no-max-field",
      "supervisor",
    );
    expect(d.skip).toBe(true);
    expect(d.detail).toContain("within");
  });

  test("no max field, loaded far below desired → reload", () => {
    const d = decideCtxPinReload(
      { state: "loaded", loaded_context_length: 4096 },
      65536,
      "old/lmstudio-no-max-field",
      "supervisor",
    );
    expect(d.skip).toBe(false);
  });
});
