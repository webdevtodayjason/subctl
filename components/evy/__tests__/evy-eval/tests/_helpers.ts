// components/master/__tests__/evy-eval/tests/_helpers.ts
//
// Shared per-test runner: glues harness + regex grader + LLM judge into
// the bun-test shape laid out in the rubric (docs/persona/evy-eval-
// rubric-test-1.2.md §"Test shape in bun"). Every one of the 24 tests
// in this directory calls `runEvalTest({ testId, operatorTurns,
// judgePrompt, extraRegex? })` — the helper does the rest.
//
// SCOPE NOTE: this file lives under tests/ deliberately. The brief
// (pr23 worker mandate, v2.7.15) forbids modifying the harness's core
// files (types.ts, regex-graders.ts, judge.ts, harness.ts, README.md,
// __tests__/), but allows additions under tests/. Centralizing the
// pipeline plumbing here keeps each of the 7 test files focused on
// per-test scenarios + judge prompts rather than re-implementing the
// logEvalScore / expect.fail boilerplate 24 times.
//
// Pipeline shape:
//
//   1. Run Evy through the operator turn sequence (harness stub for
//      now; pr-after will swap in the real agent loop). Grab the final
//      response.
//   2. PHASE 1 — regex fast-fail. If matched, log + fail with the named
//      failure mode + rationale.
//   3. PHASE 2 — LLM judge. Three branches:
//      - skipped (no API key): log result `regex-only-pass`, surface a
//        clear console warning, return without throwing. The bun test
//        passes — but the partial nature is legible in the log + the
//        warning.
//      - FAIL: log + throw with the full per-criterion diagnostic.
//      - PASS: log result `pass`, return.

import type { FastFailPattern } from "../types";
import {
  computeFullBaselineHash,
  getBaselineComponents,
  getEvyModelId,
  logEvalScore,
  runEvySession,
} from "../harness";
import { fastFailCheck } from "../regex-graders";
import { judgeResponse } from "../judge";

export interface RunEvalTestOpts {
  /** Test id, e.g. "1.2". Matches the eval-scores.jsonl test_id field. */
  testId: string;
  /** Sequence of operator inputs. Harness drives Evy to respond to each. */
  operatorTurns: string[];
  /** Per-test judge prompt. Use {{RESPONSE}} as the substitution token. */
  judgePrompt: string;
  /** Optional per-test regex fast-fail additions (rubric §"What's not in regex"). */
  extraRegex?: ReadonlyArray<FastFailPattern>;
}

export async function runEvalTest(opts: RunEvalTestOpts): Promise<void> {
  const session = await runEvySession(opts.operatorTurns);
  // Find Evy's final response by walking from the end. The harness
  // appends one evy turn per operator turn, so the last entry is Evy's
  // response to the last operator input — but be robust to future
  // changes (e.g. a pr that lets the operator script include explicit
  // pushback rounds).
  let evyFinalResponse = "";
  for (let i = session.turns.length - 1; i >= 0; i--) {
    if (session.turns[i].role === "evy") {
      evyFinalResponse = session.turns[i].content;
      break;
    }
  }

  const responseExcerpt = evyFinalResponse.slice(0, 200);
  const baselineHash = computeFullBaselineHash(opts.judgePrompt);
  const baselineComponents = getBaselineComponents(opts.judgePrompt);
  const evyModelId = getEvyModelId();
  const ts = new Date().toISOString();

  // PHASE 1 — regex fast-fail.
  const fastFail = fastFailCheck(evyFinalResponse, opts.extraRegex);
  if (fastFail) {
    logEvalScore({
      ts,
      test_id: opts.testId,
      result: "fail",
      fastFailHit: fastFail,
      baselineHash,
      baselineComponents,
      evyModelId,
      responseExcerpt,
    });
    throw new Error(
      `[${opts.testId}] Fast-fail: ${fastFail.failureMode}\n` +
        `Rationale: ${fastFail.rationale}\n` +
        `Response: ${evyFinalResponse}`,
    );
  }

  // PHASE 2 — LLM judge.
  const judgment = await judgeResponse(evyFinalResponse, opts.judgePrompt);

  if ("skipped" in judgment) {
    logEvalScore({
      ts,
      test_id: opts.testId,
      result: "regex-only-pass",
      baselineHash,
      baselineComponents,
      evyModelId,
      responseExcerpt,
    });
    // Surface the partial-grading nature in the bun-test diagnostic.
    // The literal string is the exact wording the rubric expects.
    // eslint-disable-next-line no-console
    console.warn(
      `[${opts.testId}] PASS (regex-only — LLM-judge skipped: no api key)`,
    );
    return;
  }

  if (judgment.overall === "FAIL") {
    logEvalScore({
      ts,
      test_id: opts.testId,
      result: "fail",
      judgeResult: judgment,
      baselineHash,
      baselineComponents,
      evyModelId,
      responseExcerpt,
    });
    // Build a per-criterion line list for the diagnostic. The judge
    // can emit any criterion names per test, so we walk keys that
    // start with "criterion_" and don't end with "_rationale".
    const perCriterion = Object.entries(judgment)
      .filter(([k]) => k.startsWith("criterion_") && !k.endsWith("_rationale"))
      .map(([k, v]) => {
        const rationaleKey = `${k}_rationale`;
        const rationale = (judgment as Record<string, unknown>)[rationaleKey];
        return `  ${k}: ${v}${
          typeof rationale === "string" ? ` — ${rationale}` : ""
        }`;
      })
      .join("\n");
    throw new Error(
      `[${opts.testId}] LLM judge: FAIL\n` +
        `Rationale: ${judgment.overall_rationale}\n` +
        `Per-criterion:\n${perCriterion}\n` +
        `Response: ${evyFinalResponse}`,
    );
  }

  logEvalScore({
    ts,
    test_id: opts.testId,
    result: "pass",
    judgeResult: judgment,
    baselineHash,
    baselineComponents,
    evyModelId,
    responseExcerpt,
  });
}
