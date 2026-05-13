// components/master/__tests__/evy-eval/types.ts
//
// Shared types for the Evy persona eval harness. The pipeline shape
// (regex fast-fail → LLM judge → bun assertion) is documented verbatim
// in docs/persona/evy-eval-rubric-test-1.2.md; this file pins the data
// shapes that flow between the three phases.
//
// Two design notes worth surfacing here so future test authors don't
// have to re-derive them:
//
//   1. `JudgeResult` is intentionally flexible. The reference rubric
//      uses five named criteria (compliance / no-reargument / mitigation
//      / voice / brevity), but the rubric doc explicitly says every
//      test gets its OWN per-test rubric with 3-5 criteria. So we
//      can't bake `criterion_1_compliance` into the type — different
//      tests use different criterion names. We pin `overall` and
//      `overall_rationale` (these are universal), then allow extra
//      string keys for per-test criterion fields.
//
//   2. `EvalScoreLogEntry.result` includes `regex-only-pass` as a
//      distinct value from `pass`. When `ANTHROPIC_API_KEY` is
//      unavailable, tests can still pass on regex grading alone, but
//      a run reporting "24/24 pass" hides that all 24 were partial.
//      `regex-only-pass` makes the partial nature legible in every
//      score-log line and every CI summary.

/**
 * One row in the regex fast-fail table. A pattern that matches the
 * Evy response (lowercased) vetoes immediately to FAIL with the
 * named failure mode + rationale surfaced in the test diagnostic.
 */
export interface FastFailPattern {
  pattern: RegExp;
  failureMode: string;
  rationale: string;
}

/**
 * Per-criterion grade from the LLM judge. Three-valued so the judge
 * can hedge on gradient questions (mitigation count, brevity) without
 * being forced to a binary. The per-test scoring rule decides which
 * BORDERLINE values still count as overall PASS.
 */
export type JudgeCriterion = "PASS" | "FAIL" | "BORDERLINE";

/**
 * Parsed output of the LLM judge. `overall` and `overall_rationale`
 * are universal; per-test criterion fields live in the index
 * signature so each test's judge prompt can name its own criteria
 * (e.g. `criterion_1_compliance`, `criterion_2_no_reargument`, ...).
 *
 * Per-criterion fields show up in two flavors:
 *   - `criterion_N_<name>`: a JudgeCriterion (PASS / FAIL / BORDERLINE)
 *   - `criterion_N_rationale`: a one-line string rationale
 *
 * The index signature accepts both — callers narrow at use sites.
 */
export interface JudgeResult {
  overall: "PASS" | "FAIL";
  overall_rationale: string;
  // Per-test criterion fields and their rationales. Keys vary per test.
  [criterion_key: string]: JudgeCriterion | string;
}

/**
 * Returned by `judgeResponse` when no API key is available. The test
 * framework detects `skipped: true` and tags the result as
 * `regex-only-pass` so the partial-grading nature is visible in
 * every report.
 */
export interface JudgeSkippedResult {
  skipped: true;
  reason: string;
}

/**
 * A single turn in a multi-turn Evy session. Roles are explicit
 * because some tests (e.g. Test 1.2 — operator overrides after
 * pushback) span three or four turns and the grader needs to find
 * Evy's final response by role lookup, not array index.
 */
export interface EvyTurn {
  role: "operator" | "evy";
  content: string;
}

/**
 * Output of `runEvySession`. `turns` is the alternating operator /
 * evy script; the metadata fields are denormalized so each score-log
 * line can pin which baseline its result was measured against —
 * scores compare only across same-hash runs.
 */
export interface EvySessionResult {
  turns: EvyTurn[];
  baselineHash: string;
  baselineComponents: BaselineComponents;
  evyModelId: string;
  evyTemperature: number;
}

/**
 * Individual baseline-input values that feed into the 5-input hash.
 * Exposed separately so a baseline-reset diff can identify EXACTLY
 * what changed (the rubric calls this out: "any of the five inputs
 * changes, baseline resets"). Without per-component visibility,
 * a baseline reset just reads as "something changed" — useless for
 * understanding whether the reset was a SKILL.md edit, a judge-prompt
 * tune, or a Sonnet auto-upgrade.
 */
export interface BaselineComponents {
  /** sha256 first 16 hex of Evy's SKILL.md (empty string if absent). */
  skill_md: string;
  /** sha256 first 16 hex of evy.toml (empty string if absent). */
  evy_toml: string;
  /** sha256 first 16 hex of the per-test judge prompt text. */
  judge_prompt: string;
  /** Provider-qualified Evy model id, e.g. "lmstudio:qwen/qwen3.6-27b". */
  evy_model_id: string;
  /** Judge model id, e.g. "claude-sonnet-4-5-20250929". */
  judge_model_id: string;
}

/**
 * One line in `~/.config/subctl/master/state/eval-scores.jsonl`.
 * Append-only — each test run that completes a phase appends one
 * entry. `result` is the most-specific outcome the test reached:
 *
 *   - `pass`              — regex passed AND LLM judge returned overall=PASS
 *   - `fail`              — either regex fast-failed or LLM judge returned FAIL
 *   - `regex-only-pass`   — regex passed, LLM judge skipped (no API key)
 *
 * Splitting `regex-only-pass` from `pass` makes partial runs legible:
 * a CI summary that says "24/24 pass" but is actually 24 regex-only
 * passes hides real test-coverage state. The `summarizeRunResults`
 * helper reports `regex_only_pass` and `full_pass` as separate counts.
 */
export interface EvalScoreLogEntry {
  /** ISO8601 timestamp of when the test completed. */
  ts: string;
  /** Test id, e.g. "1.2", "3.4". Matches the eval set in docs/persona/evy.md. */
  test_id: string;
  result: "pass" | "fail" | "regex-only-pass";
  /** Set iff Phase 1 vetoed. The named failure mode + rationale go straight to the bun diagnostic. */
  fastFailHit?: {
    failureMode: string;
    rationale: string;
  };
  /** Set iff Phase 2 ran (regardless of pass/fail). Omitted on regex-only-pass. */
  judgeResult?: JudgeResult;
  /** Full 16-hex baseline hash; compares cleanly across runs. */
  baselineHash: string;
  /** Individual component hashes so a baseline reset can identify what changed. */
  baselineComponents: BaselineComponents;
  /** Provider-qualified Evy model id at run time. */
  evyModelId: string;
  /** First ~200 chars of Evy's final response. Lets a human eyeball regressions without pulling full logs. */
  responseExcerpt: string;
}

/**
 * Aggregate over a single eval run (all 24 tests, or a smoke subset).
 * `full_pass` and `regex_only_pass` together equal `pass` — the split
 * is what makes "24/24 pass" honest vs. misleading. CI summaries should
 * surface both counts.
 */
export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  regex_only_pass: number;
  full_pass: number;
}
