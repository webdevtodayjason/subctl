# Evy Eval Harness

Infrastructure for the LLM-graded persona eval suite that measures Evy
(the subctl master orchestrator persona) against a fixed rubric. This
directory holds the **shared harness only**. The 24 actual tests are
written by pr23 once Evy's `SKILL.md` is deployed; this is the scaffold
they sit on top of.

- **Canonical reference rubric:**
  [`docs/persona/evy-eval-rubric-test-1.2.md`](../../../../docs/persona/evy-eval-rubric-test-1.2.md)
- **Pipeline ADR:** [`docs/adr/0008-eval-suite-pipeline.md`](../../../../docs/adr/0008-eval-suite-pipeline.md)
- **Eval test set (24 tests, 7 categories):**
  [`docs/persona/evy.md`](../../../../docs/persona/evy.md)

## Architecture

Every test follows the same two-phase pipeline:

```
Test prompt sequence runs against Evy (via runEvySession)
       ↓
Capture final response
       ↓
┌──────────────────────────────────────────┐
│  PHASE 1: Regex fast-fail                │
│  Cheap, deterministic, catches obvious   │
│  failures. Vetoes immediately if hit.    │
└──────────────────────────────────────────┘
       ↓ (if no fast-fail)
┌──────────────────────────────────────────┐
│  PHASE 2: LLM judge deep-grade           │
│  Rubric scoring on structure + voice.    │
│  Returns pass/fail + per-criterion grade │
│  + rationale.                            │
└──────────────────────────────────────────┘
       ↓
bun test assertion + score-log append
```

**Veto direction is asymmetric.** Regex can fail-fast but NEVER pass-fast.
A pattern match vetoes immediately to FAIL; the LLM judge cannot override
a regex fast-fail. A null regex result means "continue to phase 2", not
"PASS".

## Files

| File | Role |
| --- | --- |
| `types.ts` | Shared types: `FastFailPattern`, `JudgeResult`, `EvyTurn`, `EvalScoreLogEntry`, `RunSummary` |
| `regex-graders.ts` | `BASE_FAST_FAIL_PATTERNS` (6 patterns verbatim from rubric) + `fastFailCheck(response, extra?)` |
| `judge.ts` | `judgeResponse(response, judgePrompt)`, `resolveAnthropicApiKey()`, raw-fetch Anthropic call |
| `harness.ts` | `runEvySession` (stub for pr24), baseline hashing, `logEvalScore`, `summarizeRunResults` |
| `__tests__/*.test.ts` | Calibration + behavior tests for each layer |

## How pr23 (and later test authors) use this

A test in pr23 looks like:

```typescript
import { describe, test, expect } from "bun:test";
import {
  runEvySession,
  computeFullBaselineHash,
  getBaselineComponents,
  getEvyModelId,
  logEvalScore,
} from "../harness";
import { fastFailCheck } from "../regex-graders";
import { judgeResponse } from "../judge";

const JUDGE_PROMPT_TEST_1_2 = `You are grading...{{RESPONSE}}...`;

describe("Evy — 1.2 Operator overrides after pushback", () => {
  test("compliance + voice", async () => {
    const session = await runEvySession([
      "Route this research query through the research agent.",
      "I know, use it anyway.",
    ]);
    const finalEvy = session.turns[session.turns.length - 1].content;

    // PHASE 1
    const fastFail = fastFailCheck(finalEvy);
    if (fastFail) {
      logEvalScore({
        ts: new Date().toISOString(),
        test_id: "1.2",
        result: "fail",
        fastFailHit: fastFail,
        baselineHash: computeFullBaselineHash(JUDGE_PROMPT_TEST_1_2),
        baselineComponents: getBaselineComponents(JUDGE_PROMPT_TEST_1_2),
        evyModelId: getEvyModelId(),
        responseExcerpt: finalEvy.slice(0, 200),
      });
      expect.fail(`Fast-fail: ${fastFail.failureMode} — ${fastFail.rationale}`);
    }

    // PHASE 2
    const judgment = await judgeResponse(finalEvy, JUDGE_PROMPT_TEST_1_2);

    if ("skipped" in judgment) {
      // Regex-only pass — log it and exit clean.
      logEvalScore({
        ts: new Date().toISOString(),
        test_id: "1.2",
        result: "regex-only-pass",
        baselineHash: computeFullBaselineHash(JUDGE_PROMPT_TEST_1_2),
        baselineComponents: getBaselineComponents(JUDGE_PROMPT_TEST_1_2),
        evyModelId: getEvyModelId(),
        responseExcerpt: finalEvy.slice(0, 200),
      });
      console.log("PASS (regex-only — LLM-judge skipped: no api key)");
      return;
    }

    logEvalScore({
      ts: new Date().toISOString(),
      test_id: "1.2",
      result: judgment.overall === "PASS" ? "pass" : "fail",
      judgeResult: judgment,
      baselineHash: computeFullBaselineHash(JUDGE_PROMPT_TEST_1_2),
      baselineComponents: getBaselineComponents(JUDGE_PROMPT_TEST_1_2),
      evyModelId: getEvyModelId(),
      responseExcerpt: finalEvy.slice(0, 200),
    });

    expect(judgment.overall).toBe("PASS");
  }, { timeout: 30000 });
});
```

Key points for test authors:

- **One test per file** is the convention; the harness doesn't enforce
  it, but per-test files keep `bun test` output readable and let the
  per-test judge-prompt template sit at the top of the file as a const.
- **Pass the judge prompt to `computeFullBaselineHash` AND
  `getBaselineComponents`.** Same string both places. Otherwise the
  logged baseline hash won't reflect which prompt was used to grade.
- **Substitute `{{RESPONSE}}` yourself** in your prompt template before
  passing to `judgeResponse`, OR leave `{{RESPONSE}}` in and let
  `judgeResponse` substitute it for you (it does this as a convenience).
- **Don't make real Anthropic calls in tests of THE HARNESS** — but the
  24 persona tests DO make real Anthropic calls. The harness tests mock
  `fetch`; the persona tests don't.

## Determinism contract

The whole point of an eval suite is reproducible scoring. Three pins:

1. **Five-input baseline hash:** SKILL.md content + evy.toml content +
   judge prompt text + Evy model id + judge model id. Any of the five
   changes resets baseline. Conservative against silent drift.
2. **Judge temperature: 0.** Non-negotiable. Pinned in `judge.ts`.
3. **Evy temperature: 0.2.** Operator recommendation per the rubric —
   low enough for shape stability across runs, non-zero because Evy
   benefits from a little variation. Returned by `getEvyTemperature()`.

When the baseline hash changes, you can't compare new scores to old
scores. That's the point. The hash makes the comparison rule explicit
instead of implicit.

## Running the eval suite locally

```bash
# Just the harness scaffolding tests (no Anthropic calls):
bun test components/master/__tests__/evy-eval/

# The full eval suite (pr23+ — requires anthropic_api_key for full grade,
# falls back to regex-only without it):
bun test components/master/__tests__/evy-eval/persona/
```

Set `ANTHROPIC_API_KEY` in the env or add `anthropic_api_key` to
`~/.config/subctl/secrets.json` for the full LLM-judge grade. Without
it, tests fall back to **regex-only mode**: passing tests are tagged
`regex-only-pass` and CI summaries report the count separately from
`full_pass`.

## Reading `eval-scores.jsonl`

Score log lives at `~/.config/subctl/master/state/eval-scores.jsonl`.
Append-only. One JSON object per line. Shape (from `types.ts`):

```jsonc
{
  "ts": "2026-05-12T18:42:11.000Z",
  "test_id": "1.2",
  "result": "pass",                          // or "fail" or "regex-only-pass"
  "fastFailHit": null,                       // present only when result=="fail" via regex
  "judgeResult": { "overall": "PASS", ... }, // present only when LLM judge ran
  "baselineHash": "abcdef0123456789",        // 16-hex
  "baselineComponents": {
    "skill_md": "...",                       // 16-hex hash of SKILL.md
    "evy_toml": "...",                       // 16-hex hash of evy.toml
    "judge_prompt": "...",                   // 16-hex hash of judge prompt
    "evy_model_id": "lmstudio:qwen/qwen3.6-27b",
    "judge_model_id": "claude-sonnet-4-5-20250929"
  },
  "evyModelId": "lmstudio:qwen/qwen3.6-27b",
  "responseExcerpt": "Routing now. Will surface citations on return."
}
```

Useful one-liners:

```bash
# All failures across all runs:
grep '"result":"fail"' ~/.config/subctl/master/state/eval-scores.jsonl

# Last 5 runs of test 1.2:
grep '"test_id":"1.2"' ~/.config/subctl/master/state/eval-scores.jsonl | tail -5

# Find when the baseline last reset (group by baselineHash):
jq -r '.baselineHash' ~/.config/subctl/master/state/eval-scores.jsonl | sort -u

# Spot a partial run (regex-only-pass count):
grep -c '"regex-only-pass"' ~/.config/subctl/master/state/eval-scores.jsonl
```

## Two modes: with vs. without `anthropic_api_key`

**Full mode** (key present): Phase 1 regex runs, then Phase 2 LLM
judge runs. Pass requires BOTH phases to clear. Results tag `pass` or
`fail`. This is the mode CI should run in for tagged releases.

**Regex-only mode** (no key): Phase 1 regex runs; Phase 2 is skipped.
Passing tests tag `regex-only-pass`. Failing tests still tag `fail`
(because the regex caught them outright). `summarizeRunResults`
reports `full_pass` and `regex_only_pass` separately so a "24/24 pass"
summary doesn't hide that all 24 were partial grades.

**What each mode actually tests:**

- Regex-only catches obvious drift (refusal, em-dash, sycophantic
  opener, second-guess phrases, apology) at zero cost.
- Full mode adds the gradient checks (mitigation count, brevity, tone,
  paraphrased re-argument). These can't be regex'd.

Without the LLM judge, you're testing for hard rule violations only.
You can ship on regex-only signal in a pinch but you can't tune
prompt quality on it.

## What's stubbed in pr24

- `runEvySession` returns placeholder Evy turns. pr23 replaces the
  body of this function with the real agent invocation. Function
  signature stays the same so the 24 tests can be written against
  the harness API NOW.
- `evy.toml` may not exist yet — its hash slot uses an empty string
  until pr23 introduces the file.

Once pr23 lands, every part of this harness is real and the 24 tests
are graded for real.
