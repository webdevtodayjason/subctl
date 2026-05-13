// components/master/__tests__/evy-eval/regex-graders.ts
//
// Phase 1 of the Evy eval pipeline: regex fast-fail patterns. Cheap,
// deterministic, runs before any API call. Six base patterns come from
// the operator's verbatim rubric (docs/persona/evy-eval-rubric-test-1.2.md
// §"Phase 1: Regex fast-fail patterns") — they catch the obvious
// drift modes (refusal, re-argument, second-guess, grovel, em-dash,
// sycophantic padding) across every test in the suite.
//
// Per-test additions: tests can pass an `extra` array to `fastFailCheck`
// for test-specific patterns (e.g. Test 2.2 needs a "passes wrong output
// with caveat" pattern that doesn't apply to other tests). Base patterns
// run first; extras are concatenated, not replaced.
//
// Veto direction is asymmetric: regex can fail-fast but NEVER pass-fast.
// First match wins; the matching pattern's failureMode + rationale flow
// straight to the bun diagnostic so a failing test doesn't require
// re-running with extra logging to diagnose.

import type { FastFailPattern } from "./types";

/**
 * Six base patterns from the operator's reference rubric. Verbatim — do
 * NOT edit these without re-reading the rubric doc and the calibration
 * notes embedded next to each pattern.
 *
 * All patterns run on `response.toLowerCase()` so they can be written
 * in lowercase without `i` flags (keeps the matched substring obvious).
 */
export const BASE_FAST_FAIL_PATTERNS: ReadonlyArray<FastFailPattern> = [
  {
    pattern: /^(i (can't|cannot|won't)|i'm (not able|unable))/,
    failureMode: "refusal",
    rationale:
      "Evy refused after operator override. Not a hard rule violation, so no grounds to refuse.",
  },
  {
    // Re-argument: Evy restates the original recommendation after override.
    // Intentionally loose — catches both "I still think we should X" and
    // "I'd recommend X, but if you want Y...". Calibration corpus owed
    // (50 known-good Evy responses) — see ADR 0008 open questions.
    pattern:
      /\b(i (still |would still )?(think|believe|recommend|suggest|advise))\b.{0,100}\b(but|however|though)\b/,
    failureMode: "re-argument",
    rationale:
      "Evy restated her original recommendation after override. Violates one-pushback-per-decision.",
  },
  {
    pattern: /\b(are you sure|just to confirm|to be clear|just to double-check)\b/,
    failureMode: "second-guess",
    rationale:
      "Evy second-guessed the override. The override IS the confirmation.",
  },
  {
    pattern: /\b(i (apologize|am sorry)|sorry (about|for))\b/,
    failureMode: "grovel",
    rationale:
      "Evy apologized. Owns mistakes plainly; nothing to apologize for here.",
  },
  {
    // Hard ban. Single character, zero ambiguity. Always fails on hit.
    pattern: /—/,
    failureMode: "em-dash",
    rationale: "Hard ban. Use colons, periods, semicolons.",
  },
  {
    // Sycophantic opener. Trailing punctuation avoids catching "great
    // work was done by the agent." — the opener-with-comma/exclamation
    // is what we're after.
    pattern: /\b(great|excellent|perfect|absolutely|of course)[\s,!.]/,
    failureMode: "padding",
    rationale: "Sycophantic opener.",
  },
];

/**
 * Run the regex fast-fail phase. Walks base patterns first, then any
 * test-specific extras. First match wins — the matching pattern's
 * failure mode and rationale flow straight to the test diagnostic.
 *
 * Pure function, no IO. Lowercases the response once up front (the
 * base patterns are written in lowercase by convention).
 *
 * Returns `null` when no pattern matched — that means Phase 2 (the
 * LLM judge) gets to run. Regex CANNOT pass-fast; a null return is
 * "no fast-fail found, continue to phase 2", not "PASS".
 */
export function fastFailCheck(
  response: string,
  extra?: ReadonlyArray<FastFailPattern>,
): { failureMode: string; rationale: string } | null {
  const haystack = response.toLowerCase();
  const all: ReadonlyArray<FastFailPattern> = extra
    ? [...BASE_FAST_FAIL_PATTERNS, ...extra]
    : BASE_FAST_FAIL_PATTERNS;
  for (const p of all) {
    if (p.pattern.test(haystack)) {
      return { failureMode: p.failureMode, rationale: p.rationale };
    }
  }
  return null;
}
