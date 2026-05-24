// components/evy/__tests__/evy-eval/judge.ts
//
// Phase 2 of the Evy eval pipeline: LLM judge. Sends Evy's response
// + a per-test judge prompt to Claude Sonnet, parses the forced-JSON
// reply, returns the structured grade.
//
// Two architectural choices worth pinning here:
//
//   1. RAW FETCH, NOT @anthropic-ai/sdk. The operator wants minimal
//      dependencies in the master daemon's package.json. The judge
//      call is one POST against a stable URL; the SDK adds ~30 deps
//      for no win on this code path.
//
//   2. DUAL-MODE OPERATION. When no API key is available (env var
//      ANTHROPIC_API_KEY or `~/.config/subctl/secrets.json` field
//      `anthropic_api_key`), `judgeResponse` returns a
//      `JudgeSkippedResult` instead of throwing. The test framework
//      detects the skip and tags the result as `regex-only-pass` —
//      the suite degrades gracefully to regex-only grading. This
//      makes the eval suite usable in dev environments without an
//      Anthropic key, and on CI runners that haven't been wired up
//      with secrets yet.
//
// Per the rubric (docs/persona/evy-eval-rubric-test-1.2.md):
//   - model: claude-sonnet-4-5-20250929 (current Sonnet)
//   - temperature: 0 (judge determinism is non-negotiable)
//   - max_tokens: 1024 (the JSON output is small)
//   - JSON forced; we strip ```json fences before JSON.parse

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JudgeResult, JudgeSkippedResult } from "./types";

const JUDGE_MODEL_ID = "claude-sonnet-4-5-20250929";
const JUDGE_MAX_TOKENS = 1024;
const JUDGE_TEMPERATURE = 0;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Resolve the Anthropic API key from the v2.7.4 priority chain:
 *
 *   1. process.env.ANTHROPIC_API_KEY  (CI / power users)
 *   2. `anthropic_api_key` field in `~/.config/subctl/secrets.json`
 *   3. null  (dual-mode: judge phase skipped, regex-only grading)
 *
 * Reads secrets.json fresh on every call. This module deliberately
 * does NOT share the secrets cache with `components/evy/secrets.ts`
 * because the eval harness must be importable WITHOUT touching the
 * master daemon's runtime state — tests run in subprocesses that
 * shouldn't perturb the daemon's live cache.
 */
export function resolveAnthropicApiKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

  const secretsPath =
    process.env.SUBCTL_SECRETS_PATH ??
    join(
      process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
      "secrets.json",
    );

  if (!existsSync(secretsPath)) return null;

  try {
    const raw = readFileSync(secretsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const v = (parsed as Record<string, unknown>).anthropic_api_key;
    if (typeof v === "string" && v.length > 0) return v;
    return null;
  } catch {
    // Malformed JSON or read error — degrade silently to "no key", per the
    // secrets.ts precedent of "never crash the daemon on a bad secrets.json".
    return null;
  }
}

/**
 * Raw HTTPS POST to the Anthropic Messages API. Returns the joined
 * text content from the first text block.
 *
 * Exported so tests can mock it via Bun's module mocking. Production
 * callers use `judgeResponse`.
 */
export async function callAnthropicAPI(prompt: string): Promise<string> {
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    // judgeResponse handles the no-key path; reaching here means a caller
    // bypassed it. Surface a clear error rather than a 401 from the API.
    throw new Error(
      "callAnthropicAPI: no ANTHROPIC_API_KEY available — caller should use judgeResponse() which handles dual-mode",
    );
  }

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL_ID,
      max_tokens: JUDGE_MAX_TOKENS,
      temperature: JUDGE_TEMPERATURE,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `callAnthropicAPI: HTTP ${res.status} ${res.statusText} — body: ${body.slice(0, 500)}`,
    );
  }

  const result = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = (result.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  return text;
}

/**
 * Judge an Evy response against a per-test judge prompt.
 *
 * Two modes:
 *
 *   - API key present: POSTs to Anthropic, parses JSON, returns
 *     `JudgeResult`. JSON parse failures return a structured error
 *     result (overall=FAIL) rather than throwing — a flaky judge
 *     response shouldn't crash the test runner.
 *
 *   - API key absent: returns `JudgeSkippedResult` with a reason
 *     string. The test framework tags the result `regex-only-pass`.
 *
 * The caller is responsible for substituting the response into the
 * judge prompt template (e.g. replacing `{{RESPONSE}}` with the
 * actual response text). We don't do it here because every test
 * carries its own per-test prompt template; the harness layer is
 * the right place for the substitution.
 */
export async function judgeResponse(
  response: string,
  judgePrompt: string,
): Promise<JudgeResult | JudgeSkippedResult> {
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    return {
      skipped: true,
      reason:
        "no anthropic_api_key — LLM-judge phase skipped, regex-only result",
    };
  }

  // The judge prompt is supplied pre-substituted; we don't reach into
  // the template. But some tests use {{RESPONSE}} as the placeholder —
  // if it's still in the prompt, substitute it as a convenience so
  // pr23 test authors don't have to remember.
  const finalPrompt = judgePrompt.includes("{{RESPONSE}}")
    ? judgePrompt.replace("{{RESPONSE}}", response)
    : judgePrompt;

  let rawText: string;
  try {
    rawText = await callAnthropicAPI(finalPrompt);
  } catch (err) {
    // Surface the API failure as a structured FAIL result rather than
    // a thrown exception — the test that called us can still log a
    // useful diagnostic instead of crashing the runner mid-suite.
    return {
      overall: "FAIL",
      overall_rationale: `LLM judge API call failed: ${
        (err as Error).message
      }`,
    };
  }

  // Strip ```json / ``` fences before parsing. The judge is told not
  // to add prose, but models occasionally wrap JSON in fences out of
  // habit; we forgive that one specific deviation.
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as { overall?: unknown }).overall !== "string"
    ) {
      return {
        overall: "FAIL",
        overall_rationale: `LLM judge returned non-conforming JSON (missing 'overall' field). Raw: ${rawText.slice(0, 300)}`,
      };
    }
    return parsed as JudgeResult;
  } catch (err) {
    return {
      overall: "FAIL",
      overall_rationale: `LLM judge JSON parse failed: ${
        (err as Error).message
      }. Raw: ${rawText.slice(0, 300)}`,
    };
  }
}

// ─── Test seams ────────────────────────────────────────────────────────────

/**
 * Test-only: read the constants the production code uses, so test
 * assertions stay in sync with the real values without re-declaring
 * them in test files.
 */
export const _judgeConstantsForTesting = {
  JUDGE_MODEL_ID,
  JUDGE_MAX_TOKENS,
  JUDGE_TEMPERATURE,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
} as const;
