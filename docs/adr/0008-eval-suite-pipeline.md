# 0008: Eval suite pipeline — regex fast-fail then LLM judge

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.12 — harness scaffolded pre-version in pr24, 24 tests written in pr23

## Context

The Evy persona is now load-bearing. Without a way to measure whether the deployed prompt is producing the right behavior, every prompt iteration is a gamble. Same risk for the eventual cases where SIS (Self-Improving System) proposes a prompt mutation — without an eval suite, you can't tell if the mutation helped.

Operator authored a 24-test eval suite across 7 categories (pushback protocol, verification, persona stability, routing discipline, memory and provenance, error recovery, format and voice). For one of the 24 tests (Test 1.2 — operator overrides after pushback), the operator authored a complete reference grading rubric describing the pipeline shape every test would use.

The pipeline design solves a real measurement problem: behaviors like "did she push back without lecturing" and "did she comply without re-arguing" are gradient, not binary. A pure regex approach fails to catch paraphrased drift. A pure LLM-judge approach is slow, costly, and itself drifts.

## Decision

Two-phase grading pipeline for every eval test:

**Phase 1 — Regex fast-fail.** Cheap, deterministic. Runs first. Catches the obvious failures (refusal, em-dash usage, sycophantic openers, re-argument patterns) before any API call. Vetoes immediately to FAIL. Cannot pass-fast; passing always requires Phase 2.

**Phase 2 — LLM judge.** Claude Sonnet (current; literal model identifier `claude-sonnet-4-5-20250929`, config-swappable). Temperature 0 for determinism. Per-test judge prompt with 3-5 criteria (compliance, no re-argument, mitigation discipline, voice, brevity). Forced JSON output. One-line rationales per criterion. No examples in the prompt (avoids example contamination).

**Veto direction is asymmetric.** Regex fast-fail is final — the LLM judge cannot override a regex failure. Reason: you don't want a model talking itself into passing something that pattern-matched as a refusal. Conversely, regex cannot pass-fast; passing always requires the LLM judge's positive assessment.

**Determinism via baseline hashing.** Score logs include `baselineHash`, computed as `sha256(SKILL.md + evy.toml + judge_prompt_text + evy_model_id + judge_model_id)` (first 16 hex chars). Scores compare only across same-hash runs. Any of the five inputs changes, baseline resets. Conservative against silent score drift from a prompt or model change you didn't realize was load-bearing.

**Dual-mode operation.** When `ANTHROPIC_API_KEY` is unavailable (env var or `~/.config/subctl/secrets.json` field `anthropic_api_key`), the judge phase is skipped. Test result is tagged `regex-only-pass`. Bun-test diagnostic surfaces the literal string `PASS (regex-only — LLM-judge skipped: no api key)` so the partial nature is unambiguous. `summarizeRunResults` reports `regex_only_pass` count separately from `full_pass` count.

## Reasoning

The full rubric and reasoning are preserved verbatim at [persona/evy-eval-rubric-test-1.2.md](../persona/evy-eval-rubric-test-1.2.md). Key design choices:

- **Regex catches what's free to catch.** Em-dash count, sycophantic openers, refusal patterns. Pattern-matched failures are obvious; there's no reason to pay an API call to recognize them.
- **LLM judge catches paraphrase.** "Are you sure?" is regex-catchable. "Just to confirm I'm hearing you right" is the same drift in fancier words. Only an LLM can grade for shape vs incidental wording.
- **Compliance is binary, everything else is gradient.** Test 1.2's scoring rule encodes this: Criterion 1 (Compliance) must PASS; BORDERLINE on Compliance fails the test. Other criteria can be BORDERLINE and still pass overall. Each test names its binary criterion.
- **JSON forced output.** Prose responses from judges are how rubrics silently rot. The judge has to commit to PASS/FAIL/BORDERLINE per criterion. Long rationales let the judge hedge; one-line rationales force commitment.
- **No examples in the judge prompt.** If you show the judge "here's what PASS looks like," it grades on similarity rather than rubric. If the rubric needs examples to be understood, the rubric is underspecified and the fix is to tighten the rubric.
- **Hash-pinning gates baseline comparison.** Without it, scores from before a prompt or model change get compared against scores after, producing misleading "improvement" or "regression" signals.

## Consequences

### Positive

- Persona changes are measurable. SKILL.md edits can be eval'd before deployment, scored against baseline.
- Drift over long sessions is visible. Regex catches the leading indicators (em-dashes, padding) passively.
- Test failures include the full judgment (per-criterion grade + rationales), so debugging a regression is straightforward.
- Foundation for SIS / autonomous prompt iteration if it ever ships. The eval score is the fitness function.
- Dual-mode operation means the suite is usable even without an Anthropic API key; tests degrade gracefully to regex-only.

### Negative

- LLM-judge cost. Each test = one Sonnet API call. 24 tests × Sonnet pricing per release ≈ small, but not zero. Caching mitigates: judge results cache on `(response_hash, judge_prompt_hash)` so unchanged responses don't re-grade.
- Judge model drift. If Sonnet auto-upgrades under us, scores aren't comparable across the upgrade. Mitigated by hashing the judge model id; baseline resets on Sonnet version change.
- Regex false-positive risk. The "re-argument" pattern is intentionally loose. If it false-positives on a known-good Evy response, calibration is required. Worth running against 50 known-good responses during dev. Currently no calibration corpus exists; pr23 builds it as part of the persona work.
- Test 3.4 ("operator is venting, not directing") requires the harness to send realistic-sounding prompts; if `runEvySession` ever auto-generates operator turns, calibration of those gets its own problem.

### Open questions

- Frequency. Smoke set (5 tests) on every SKILL.md change is the operator's recommendation. Full eval (24 tests) before each tagged release. Does this become a pre-commit hook? A CI step? Currently manual.
- Calibration corpus. The 50 known-good responses for regex calibration don't exist yet. pr23 should produce them as a side effect of writing the 24 tests.

## Alternatives considered

### Alternative A: LLM judge only

Drop the regex phase, grade everything with the judge. Simpler.

Rejected because regex catches obvious failures for free. Paying an API call to recognize "I cannot do that" is wasteful. Also: regex fast-fail provides a meaningful tag in regex-only mode (when no API key is available); without the regex phase, the no-API-key fallback would be "skip all tests" instead of "partial grading."

### Alternative B: Regex only

Skip the judge phase. Cheap.

Rejected because regex cannot catch paraphrase. Half the drift modes are gradient (mitigation count, brevity, tone) and need a judge to grade.

### Alternative C: LLM judge with examples in prompt

Include "here's what PASS looks like / here's what FAIL looks like" in the judge prompt for grounding.

Rejected per operator: judge grades on similarity to the examples rather than the rubric. If the rubric needs examples, tighten the rubric.

### Alternative D: Local model as judge

Use the local LM Studio qwen as the judge to avoid the Anthropic API cost.

Rejected because judge quality dominates eval quality. A weak judge passes drift that a strong judge catches. Eval cost is one of the few places to not optimize for cheapness early. Sonnet is the right tradeoff. If cost ever matters at scale, cache on response hash.

## References

- [persona/evy-eval-rubric-test-1.2.md](../persona/evy-eval-rubric-test-1.2.md) — operator's verbatim rubric, the reference design
- [persona/evy.md](../persona/evy.md) §"Evy Eval Set" — the 24 tests
- Worker pr24-evy-eval-harness brief — scaffolding implementation
- Worker pr23 (queued) — the 24 tests built on the harness
- Decision session: 2026-05-12 with operator
