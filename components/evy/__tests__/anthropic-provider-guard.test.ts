// components/evy/__tests__/anthropic-provider-guard.test.ts
//
// ADR 0019 (2026-05-14) — Anthropic provider guard.
//
// buildModel() refuses to construct a Model<anthropic/*> unless the
// operator has set SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1. Even when allowed,
// the first construction per (provider, model, verdict) per boot fires
// a loud alert on four channels (stderr, notification ring, Telegram,
// decisions.jsonl).
//
// These tests pin:
//   1. Default = blocked. buildModel({provider: "anthropic"}) throws.
//   2. Opt-in = allowed. Setting env=1 lets construction succeed.
//   3. Dedup. Repeated calls with the same key produce one notification
//      and one log line, not a flood.
//   4. Other providers are unaffected (lmstudio, openrouter, openai).
//
// External side effects (Telegram push + decisions.jsonl append) are
// suppressed via SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS=1, set in beforeEach.
// CRITICAL: without that env var, running this test file on a machine
// where ~/.config/subctl/evy-notify.json is configured will fire real
// Telegram messages to the operator and pollute the operator's real
// decisions.jsonl. Don't remove the gate.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { buildModel } from "../server";
import { listNotifications } from "../notifications";

let savedEnv: string | undefined;
let savedSkipEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER;
  delete process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER;
  // Gate the guard's external side effects (Telegram + decisions.jsonl)
  // so this test suite never touches the operator's real Telegram bot or
  // real audit log. The in-process notification ring is unaffected and
  // remains the source of truth for the assertions below.
  savedSkipEnv = process.env.SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS;
  process.env.SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS = "1";
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER;
  } else {
    process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER = savedEnv;
  }
  if (savedSkipEnv === undefined) {
    delete process.env.SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS;
  } else {
    process.env.SUBCTL_GUARD_SKIP_EXTERNAL_EFFECTS = savedSkipEnv;
  }
});

describe("buildModel anthropic guard — default blocked", () => {
  test("throws when SUBCTL_ALLOW_ANTHROPIC_PROVIDER is unset", () => {
    expect(() =>
      buildModel({
        provider: "anthropic",
        // Use a distinctive model id per test so the dedup Set doesn't
        // suppress this test's alert if some prior test fired first.
        model: "claude-sonnet-4-6-guard-default",
      }),
    ).toThrow(/Anthropic provider blocked/);
  });

  test("throws when SUBCTL_ALLOW_ANTHROPIC_PROVIDER is set to anything but '1'", () => {
    process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER = "true"; // truthy string, NOT "1"
    expect(() =>
      buildModel({
        provider: "anthropic",
        model: "claude-sonnet-4-6-guard-true",
      }),
    ).toThrow(/Anthropic provider blocked/);
  });

  test("error message names ADR 0019 and the env-var override", () => {
    let err: Error | null = null;
    try {
      buildModel({
        provider: "anthropic",
        model: "claude-sonnet-4-6-guard-msg",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("ADR 0019");
    expect(err!.message).toContain("SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1");
  });

  test("fires a dashboard notification with kind=anthropic-provider-blocked", () => {
    try {
      buildModel({
        provider: "anthropic",
        model: "claude-sonnet-4-6-guard-notif",
      });
    } catch {
      // Expected. We're checking the side-effect, not the throw.
    }
    const recent = listNotifications({ limit: 50 });
    const blocked = recent.find(
      (n) =>
        n.kind === "anthropic-provider-blocked" &&
        typeof n.body === "string" &&
        n.body.includes("claude-sonnet-4-6-guard-notif"),
    );
    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe("alert");
  });
});

describe("buildModel anthropic guard — opt-in allowed", () => {
  test("constructs the Model when env=1", () => {
    process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER = "1";
    const m = buildModel({
      provider: "anthropic",
      model: "claude-sonnet-4-6-guard-armed",
    });
    expect(m.provider).toBe("anthropic");
    expect(m.id).toBe("claude-sonnet-4-6-guard-armed");
    // api dispatch: anthropic → anthropic-messages (per PROVIDER_API).
    expect(m.api).toBe("anthropic-messages");
  });

  test("still fires an alert notification when armed (kind=anthropic-provider-armed)", () => {
    process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER = "1";
    buildModel({
      provider: "anthropic",
      model: "claude-sonnet-4-6-guard-armed-notif",
    });
    const recent = listNotifications({ limit: 50 });
    const armed = recent.find(
      (n) =>
        n.kind === "anthropic-provider-armed" &&
        typeof n.body === "string" &&
        n.body.includes("claude-sonnet-4-6-guard-armed-notif"),
    );
    expect(armed).toBeDefined();
    expect(armed!.severity).toBe("alert");
  });
});

describe("buildModel anthropic guard — dedup", () => {
  test("repeated calls with the same (provider, model, verdict) emit a single notification", () => {
    // Use a unique model id so prior tests' notifications don't pollute the count.
    const uniq = `claude-sonnet-4-6-guard-dedup-${Date.now()}`;
    const before = listNotifications({ limit: 200 }).filter(
      (n) =>
        n.kind === "anthropic-provider-blocked" &&
        typeof n.body === "string" &&
        n.body.includes(uniq),
    ).length;

    for (let i = 0; i < 5; i++) {
      try {
        buildModel({ provider: "anthropic", model: uniq });
      } catch {
        /* expected */
      }
    }

    const after = listNotifications({ limit: 200 }).filter(
      (n) =>
        n.kind === "anthropic-provider-blocked" &&
        typeof n.body === "string" &&
        n.body.includes(uniq),
    ).length;
    // 5 calls but only one notification: the dedup Set keys on
    // provider:model:verdict per boot.
    expect(after - before).toBe(1);
  });
});

describe("buildModel anthropic guard — other providers are unaffected", () => {
  test("lmstudio constructs normally with no Anthropic-related side effects", () => {
    // Snapshot notification count of the kinds we care about.
    const before = listNotifications({ limit: 200 }).filter((n) =>
      n.kind.startsWith("anthropic-provider"),
    ).length;
    const m = buildModel({
      provider: "lmstudio",
      model: "qwen/qwen3.6-35b-a3b",
      host: "http://localhost:1234/v1",
    });
    expect(m.provider).toBe("lmstudio");
    const after = listNotifications({ limit: 200 }).filter((n) =>
      n.kind.startsWith("anthropic-provider"),
    ).length;
    expect(after).toBe(before);
  });

  test("openrouter with anthropic/* model id does NOT trip the guard", () => {
    // The OpenRouter example in providers.json.example uses
    // "anthropic/claude-sonnet-4" as the model — provider is openrouter,
    // billing flows through OpenRouter's marketplace, not Anthropic.
    // Guard keys on provider only, not on model substring.
    const before = listNotifications({ limit: 200 }).filter((n) =>
      n.kind.startsWith("anthropic-provider"),
    ).length;
    const m = buildModel({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(m.provider).toBe("openrouter");
    const after = listNotifications({ limit: 200 }).filter((n) =>
      n.kind.startsWith("anthropic-provider"),
    ).length;
    expect(after).toBe(before);
  });
});
