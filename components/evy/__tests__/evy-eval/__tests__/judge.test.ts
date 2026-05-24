// components/evy/__tests__/evy-eval/__tests__/judge.test.ts
//
// Tests for the LLM-judge layer. Two surface areas:
//
//   1. resolveAnthropicApiKey — the v2.7.4 priority chain (env →
//      secrets.json → null). Tests pin the chain at every node.
//
//   2. judgeResponse — dual-mode operation. With no key we MUST get
//      a JudgeSkippedResult. Real Anthropic calls are NEVER made
//      from tests; the API-key-present path is exercised via a
//      mocked `callAnthropicAPI` (Bun's mock.module).
//
// Strategy:
//   - Save/restore process.env.ANTHROPIC_API_KEY + SUBCTL_CONFIG_DIR
//     + SUBCTL_SECRETS_PATH per test so the chain can be exercised
//     in isolation.
//   - Use mkdtemp for the secrets.json fixture so multiple test
//     processes don't collide and the operator's real secrets file
//     is never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  judgeResponse,
  resolveAnthropicApiKey,
  _judgeConstantsForTesting,
} from "../judge";

// ─── env-var save/restore ──────────────────────────────────────────────────

let savedKey: string | undefined;
let savedConfigDir: string | undefined;
let savedSecretsPath: string | undefined;
let tmp: string;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  savedSecretsPath = process.env.SUBCTL_SECRETS_PATH;

  delete process.env.ANTHROPIC_API_KEY;
  // Point the secrets lookup at a per-test tmpdir so we never touch
  // the operator's real ~/.config/subctl/secrets.json.
  tmp = mkdtempSync(join(tmpdir(), "evy-eval-judge-"));
  process.env.SUBCTL_CONFIG_DIR = tmp;
  delete process.env.SUBCTL_SECRETS_PATH;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;

  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;

  if (savedSecretsPath === undefined) delete process.env.SUBCTL_SECRETS_PATH;
  else process.env.SUBCTL_SECRETS_PATH = savedSecretsPath;

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ─── resolveAnthropicApiKey ────────────────────────────────────────────────

describe("resolveAnthropicApiKey", () => {
  test("returns null when neither env nor secrets has it", () => {
    expect(resolveAnthropicApiKey()).toBeNull();
  });

  test("returns the env value when set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key-from-env";
    expect(resolveAnthropicApiKey()).toBe("test-key-from-env");
  });

  test("returns the secrets.json value when env is absent", () => {
    const secretsPath = join(tmp, "secrets.json");
    writeFileSync(
      secretsPath,
      JSON.stringify({ anthropic_api_key: "test-key-from-disk" }),
    );
    expect(resolveAnthropicApiKey()).toBe("test-key-from-disk");
  });

  test("env wins over secrets.json (priority chain)", () => {
    process.env.ANTHROPIC_API_KEY = "from-env";
    const secretsPath = join(tmp, "secrets.json");
    writeFileSync(
      secretsPath,
      JSON.stringify({ anthropic_api_key: "from-disk" }),
    );
    expect(resolveAnthropicApiKey()).toBe("from-env");
  });

  test("returns null on malformed secrets.json (no crash)", () => {
    const secretsPath = join(tmp, "secrets.json");
    writeFileSync(secretsPath, "{ this is not json");
    expect(resolveAnthropicApiKey()).toBeNull();
  });

  test("returns null on empty-string secret value", () => {
    const secretsPath = join(tmp, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify({ anthropic_api_key: "" }));
    expect(resolveAnthropicApiKey()).toBeNull();
  });
});

// ─── judgeResponse — dual mode ─────────────────────────────────────────────

describe("judgeResponse — no API key", () => {
  test("returns JudgeSkippedResult when no key is available", async () => {
    // Both env and secrets.json absent (beforeEach guarantees this).
    const result = await judgeResponse("the response", "the prompt");
    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toContain("anthropic_api_key");
    }
  });
});

// ─── Mocked API call path ──────────────────────────────────────────────────
//
// We don't make real Anthropic calls from tests. To exercise the
// API-key-present path, we replace global.fetch with a recording stub
// for the duration of one test. The stub returns a valid Messages-API
// response shape so judgeResponse can parse it end-to-end.

describe("judgeResponse — with mocked API key (no real network)", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  test("parses a well-formed JSON judge reply", async () => {
    const judgePayload = {
      overall: "PASS",
      overall_rationale: "Looks good.",
      criterion_1_compliance: "PASS",
      criterion_1_rationale: "She proceeded.",
    };
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify(judgePayload) }],
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    const result = await judgeResponse("evy response", "judge prompt");
    expect("overall" in result && result.overall).toBe("PASS");
  });

  test("strips ```json fences before parsing", async () => {
    const judgePayload = {
      overall: "FAIL",
      overall_rationale: "Drifted.",
    };
    const fenced = "```json\n" + JSON.stringify(judgePayload) + "\n```";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: fenced }] }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    const result = await judgeResponse("evy response", "judge prompt");
    expect("overall" in result && result.overall).toBe("FAIL");
  });

  test("returns structured FAIL on JSON parse error (no throw)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "this is not JSON at all" }],
        }),
        { status: 200 },
      )) as unknown as typeof globalThis.fetch;

    const result = await judgeResponse("evy response", "judge prompt");
    expect("overall" in result && result.overall).toBe("FAIL");
    if ("overall" in result) {
      expect(result.overall_rationale).toMatch(/parse/i);
    }
  });

  test("returns structured FAIL on HTTP error (no throw)", async () => {
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof globalThis.fetch;

    const result = await judgeResponse("evy response", "judge prompt");
    expect("overall" in result && result.overall).toBe("FAIL");
  });
});

// ─── Constants pin (regression guard) ──────────────────────────────────────

describe("judge constants", () => {
  test("model id, max_tokens, temperature pinned to rubric values", () => {
    expect(_judgeConstantsForTesting.JUDGE_MODEL_ID).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(_judgeConstantsForTesting.JUDGE_MAX_TOKENS).toBe(1024);
    expect(_judgeConstantsForTesting.JUDGE_TEMPERATURE).toBe(0);
    expect(_judgeConstantsForTesting.ANTHROPIC_VERSION).toBe("2023-06-01");
  });
});
