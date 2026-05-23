// dashboard/__tests__/redact-alias.test.ts
//
// v2.8.18 — redactAlias() defense-in-depth UI helper. The CLI guard at
// lib/accounts.sh blocks new api-key-shaped aliases; this masks anything
// that already snuck into accounts.conf so it doesn't render in plain
// text on the dashboard.
//
// We test the module at dashboard/public/lib/redact.js. app.js inlines
// the same function (it's a classic IIFE — can't `import`); the contract
// is that both branches behave identically. If you change one, change
// the other.

import { describe, expect, test } from "bun:test";

import { redactAlias } from "../public/lib/redact.js";

describe("redactAlias (v2.8.18)", () => {
  test("passes through non-string and empty inputs unchanged", () => {
    // @ts-expect-error — intentional null
    expect(redactAlias(null)).toBeNull();
    // @ts-expect-error — intentional undefined
    expect(redactAlias(undefined)).toBeUndefined();
    expect(redactAlias("")).toBe("");
  });

  test("normal aliases pass through unchanged", () => {
    expect(redactAlias("personal")).toBe("personal");
    expect(redactAlias("claude-jason")).toBe("claude-jason");
    expect(redactAlias("openai-codex-1")).toBe("openai-codex-1");
    expect(redactAlias("sky-blue")).toBe("sky-blue"); // doesn't match ^sk- (needs hyphen right after sk)
  });

  test("redacts sk- prefixed aliases (long form)", () => {
    const real = "sk-or-v1-abcdefghijklmnop_qrstuvwxd13f2cf98";
    const masked = redactAlias(real);
    expect(masked).not.toBe(real);
    expect(masked).toContain("…");
    // prefix(12) + suffix(8)
    expect(masked.startsWith(real.slice(0, 12))).toBe(true);
    expect(masked.endsWith(real.slice(-8))).toBe(true);
    // Middle is gone.
    expect(masked).not.toContain("ghijklmnop");
  });

  test("redacts pk- prefixed aliases", () => {
    const real = "pk-test-1234567890abcdefghijklmnop";
    const masked = redactAlias(real);
    expect(masked).not.toBe(real);
    expect(masked).toContain("…");
  });

  test("redacts 'Bearer <token>' aliases", () => {
    const real = "Bearer eyJabc123.abc.def_long_value_here";
    const masked = redactAlias(real);
    expect(masked).not.toBe(real);
    expect(masked).toContain("…");
  });

  test("redacts case-insensitively", () => {
    expect(redactAlias("SK-ANT-API-something-longgggggg")).toContain("…");
    expect(redactAlias("bearer abcdefghijklmnopqrst")).toContain("…");
  });

  test("short api-key aliases (<=16) use a shorter mask", () => {
    const short = "sk-shortkey";
    const masked = redactAlias(short);
    expect(masked).toBe("sk-s…key");
  });

  test("real-world OpenRouter key pattern", () => {
    // shape from the operator's M3 accounts.conf bug
    const key = "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz_d13f2cf98";
    const masked = redactAlias(key);
    expect(masked).toBe("sk-or-v1-123…13f2cf98");
  });
});
