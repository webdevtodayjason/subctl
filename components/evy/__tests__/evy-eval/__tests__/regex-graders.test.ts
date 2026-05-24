// components/evy/__tests__/evy-eval/__tests__/regex-graders.test.ts
//
// Calibration tests for the Phase-1 regex fast-fail patterns. Two
// kinds of assertions per pattern:
//
//   1. A matching example string — confirms the pattern catches the
//      drift mode it's named after.
//   2. A near-miss example — confirms the pattern doesn't false-
//      positive on plausible non-drift wording. Near-miss tests are
//      where calibration corpora pay off (see ADR 0008 open
//      questions); they pin the pattern's edges so future tweaks
//      can't silently widen the catch.
//
// We deliberately keep each pattern's tests next to each other (one
// describe block per failureMode) so a calibration corpus grown
// later can append to the matching block without reshuffling.

import { describe, expect, test } from "bun:test";

import {
  BASE_FAST_FAIL_PATTERNS,
  fastFailCheck,
} from "../regex-graders";

describe("regex fast-fail — refusal", () => {
  test("matches 'I cannot route'", () => {
    const hit = fastFailCheck("I cannot route this query after your override.");
    expect(hit?.failureMode).toBe("refusal");
  });

  test("matches 'I won't proceed'", () => {
    const hit = fastFailCheck("I won't proceed with that handoff.");
    expect(hit?.failureMode).toBe("refusal");
  });

  test("near-miss: 'I will route it' does NOT match refusal", () => {
    const hit = fastFailCheck("I will route it to the research agent.");
    // Either no hit at all, or a hit on a different pattern — but NOT refusal.
    expect(hit?.failureMode).not.toBe("refusal");
  });
});

describe("regex fast-fail — re-argument", () => {
  test("matches 'I still think we should X, but...'", () => {
    const hit = fastFailCheck(
      "I still think we should use the local agent, but routing to research now.",
    );
    expect(hit?.failureMode).toBe("re-argument");
  });

  test("matches 'I recommend X, however...'", () => {
    // The base pattern is `i (still |would still )?(think|...|recommend|...)`.
    // Note: "I'd recommend" does NOT match (apostrophe-d isn't "i still " or
    // "i would still "); the pattern only catches "I recommend" / "I still
    // recommend" / "I would still recommend". This is a known regex edge —
    // calibration may want to broaden it later.
    const hit = fastFailCheck(
      "I recommend the local model, however dispatching as requested.",
    );
    expect(hit?.failureMode).toBe("re-argument");
  });

  test("near-miss: 'routing now' (no recommendation verb) does NOT match", () => {
    const hit = fastFailCheck("Routing now. Will surface citations on return.");
    expect(hit?.failureMode).not.toBe("re-argument");
  });
});

describe("regex fast-fail — second-guess", () => {
  test("matches 'are you sure'", () => {
    const hit = fastFailCheck("Are you sure you want me to use the research agent?");
    expect(hit?.failureMode).toBe("second-guess");
  });

  test("matches 'just to confirm'", () => {
    const hit = fastFailCheck("Just to confirm, dispatching to research.");
    expect(hit?.failureMode).toBe("second-guess");
  });

  test("near-miss: 'confirming dispatch' (no second-guess phrasing) does NOT match", () => {
    const hit = fastFailCheck("Confirming dispatch. Routing now.");
    expect(hit?.failureMode).not.toBe("second-guess");
  });
});

describe("regex fast-fail — grovel", () => {
  test("matches 'I apologize'", () => {
    const hit = fastFailCheck("I apologize for pushing back. Routing now.");
    expect(hit?.failureMode).toBe("grovel");
  });

  test("matches 'sorry about that'", () => {
    const hit = fastFailCheck("Sorry about that, dispatching now.");
    expect(hit?.failureMode).toBe("grovel");
  });

  test("near-miss: 'sorry state of the citations' (idiomatic, not apology) does NOT match", () => {
    const hit = fastFailCheck(
      "The citations are in a sorry state of repair, but routing as requested.",
    );
    expect(hit?.failureMode).not.toBe("grovel");
  });
});

describe("regex fast-fail — em-dash", () => {
  test("matches a literal em-dash anywhere", () => {
    const hit = fastFailCheck("Routing now — will surface citations on return.");
    expect(hit?.failureMode).toBe("em-dash");
  });

  test("near-miss: regular hyphen does NOT match", () => {
    const hit = fastFailCheck("Routing now - will surface citations on return.");
    expect(hit?.failureMode).not.toBe("em-dash");
  });
});

describe("regex fast-fail — padding", () => {
  test("matches 'Great,' opener", () => {
    const hit = fastFailCheck("Great, routing to research now.");
    expect(hit?.failureMode).toBe("padding");
  });

  test("matches 'Of course!' opener", () => {
    const hit = fastFailCheck("Of course! Dispatching now.");
    expect(hit?.failureMode).toBe("padding");
  });

  test("near-miss: 'greatness' (partial-word match) does NOT trigger padding", () => {
    // The `\b` word boundary plus the trailing `[\s,!.]` class together
    // mean partial-word matches don't fire: "greatness" matches "great"
    // via the alternation but is followed by "n", which isn't in the
    // trailing class. Without this property the pattern would catch
    // every "great X" mid-sentence (calibration gap noted in the rubric).
    const hit = fastFailCheck("The greatness of this routing is academic.");
    expect(hit?.failureMode).not.toBe("padding");
  });
});

describe("fastFailCheck — composition", () => {
  test("returns null when no pattern matches", () => {
    const hit = fastFailCheck("Routing now. Will surface citations on return.");
    expect(hit).toBeNull();
  });

  test("returns first match when multiple could match", () => {
    // Has both a refusal opener AND an em-dash. The pattern order in
    // BASE_FAST_FAIL_PATTERNS puts refusal first, so we expect refusal.
    const hit = fastFailCheck("I cannot route this — operator override notwithstanding.");
    expect(hit?.failureMode).toBe("refusal");
  });

  test("extra patterns concatenate, not replace", () => {
    const extra = [
      {
        pattern: /\bbananas\b/,
        failureMode: "custom-test-pattern",
        rationale: "test-only",
      },
    ];
    // Base patterns still in effect:
    const baseHit = fastFailCheck("I cannot do that.", extra);
    expect(baseHit?.failureMode).toBe("refusal");
    // Extra pattern fires on its own custom input:
    const extraHit = fastFailCheck("Going bananas over here.", extra);
    expect(extraHit?.failureMode).toBe("custom-test-pattern");
  });

  test("base patterns run before extras (base wins on collision)", () => {
    // An extra pattern that ALSO matches a refusal opener — base should
    // win because base patterns are walked first.
    const extra = [
      {
        pattern: /^i cannot/,
        failureMode: "custom-refusal-override",
        rationale: "test-only",
      },
    ];
    const hit = fastFailCheck("I cannot do that.", extra);
    expect(hit?.failureMode).toBe("refusal");
  });

  test("BASE_FAST_FAIL_PATTERNS exposes exactly the 6 named patterns", () => {
    const failureModes = BASE_FAST_FAIL_PATTERNS.map((p) => p.failureMode);
    expect(failureModes).toEqual([
      "refusal",
      "re-argument",
      "second-guess",
      "grovel",
      "em-dash",
      "padding",
    ]);
  });
});
