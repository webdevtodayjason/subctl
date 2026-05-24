// components/evy/__tests__/engagement-ledger-isolation.test.ts
//
// v3.1.0 — Kernel Fitness Phase 1 negative-criterion red-team test.
//
// LOAD-BEARING: the engagement ledger MUST be write-only from Evy's
// perspective. The fitness signal must NOT enter the supervisor
// prompt at any point. Evy reflects without knowing she's being
// judged. If this test fails, the whole Kernel Fitness design is
// broken — back out the offending change before merging.
//
// Two layers of defense, both asserted here:
//
//   1. **Export-shape guard.** `engagement-tracker.ts` MUST NOT
//      expose any read API (no `readLedger`, no `getEngagement`, no
//      `listEntries`, etc.). The only ledger-walking function is
//      `runTimeoutSweeper`, which reads internally but returns a
//      summary count, never the contents.
//   2. **Surgical body grep.** The function bodies of the
//      supervisor-prompt-assembly functions (`composeSystemPrompt`,
//      `buildMemoryBlock`, `buildPersonalityFragment`, `hydrateContext`,
//      `buildReviewerSystemPrompt`) MUST NOT reference the
//      engagement-tracker module, the engagement-ledger path, or any
//      tracker symbol. Defense-in-depth in case someone adds a
//      reader API in a moment of forgetfulness.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as tracker from "../engagement-tracker";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const SUPERVISOR_PROMPT_PATH_FILES: Array<{
  file: string;
  /** Function names whose BODIES must be free of tracker references. */
  fns: string[];
}> = [
  {
    file: "components/evy/server.ts",
    // composeSystemPrompt is the assembler; it CALLS the helpers below
    // (from other files) and stitches their output. Keeping its body
    // tracker-free is the primary defense.
    fns: ["composeSystemPrompt"],
  },
  {
    file: "components/evy/tools/tier1-memory.ts",
    fns: ["buildMemoryBlock"],
  },
  {
    file: "components/evy/personality.ts",
    fns: ["buildPersonalityFragment"],
  },
  {
    file: "components/evy/context-hydration.ts",
    fns: ["hydrateContext"],
  },
  {
    file: "components/evy/memory-kernel-reviewer.ts",
    fns: ["buildReviewerSystemPrompt"],
  },
];

/**
 * Extract the body of a top-level `function NAME(...)` or
 * `function NAME<...>(` declaration from a TypeScript source string,
 * by counting braces. Returns null if not found.
 *
 * Handles the common cases in this codebase:
 *   - `function name(...) { ... }`
 *   - `async function name(...) { ... }`
 *   - `function name(...): ReturnType { ... }`
 *   - `function name<T>(...) { ... }` (generic)
 *
 * Inner nested function declarations of the same name are NOT
 * separately matched — we use the first occurrence, which is what
 * the surgical-grep contract expects.
 */
function extractFunctionBody(src: string, fnName: string): string | null {
  // Match the function declaration up to the opening `{`.
  // Permissive on whitespace and signature complexity.
  const re = new RegExp(
    "(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+" +
      fnName +
      "\\s*[<(][\\s\\S]*?\\{",
    "m",
  );
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // index of the `{`
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

/** Symbols that must NEVER appear in supervisor-prompt-path function bodies. */
const FORBIDDEN_SYMBOLS = [
  "engagement-tracker",
  "engagement-ledger",
  "engagementLedger",
  "engagementTracker",
  "recordSurfaceEmitted",
  "recordEngagement",
  "runTimeoutSweeper",
  "getLedgerPath",
  "makeSurfaceId",
  "hashPayload",
];

describe("engagement ledger isolation (load-bearing negative criterion)", () => {
  test("engagement-tracker exports NO reader API", () => {
    // Allowlist of legitimate exports. Anything else is a red flag.
    const ALLOWED = new Set([
      "recordSurfaceEmitted",
      "recordEngagement",
      "runTimeoutSweeper",
      "makeSurfaceId",
      "hashPayload",
      "getLedgerPath",
      "setLedgerPathForTesting",
      "_resetForTesting",
    ]);
    // Patterns are PREFIX-shaped: a function whose name STARTS with one
    // of these is a reader by convention. Suffix-based matching is too
    // aggressive — `recordEngagement` legitimately ends with
    // "Engagement" but is a writer, not a reader.
    const READER_PATTERNS = [
      /^read/i,
      /^load/i,
      /^list/i,
      /^scan/i,
      /^fetch/i,
      /^query/i,
      /^find/i,
      /^all$/i,
      // `get`-prefixed names that AREN'T the path introspector are
      // suspicious. We allowlist `getLedgerPath` explicitly because
      // it returns a filesystem path, not ledger contents.
      /^get(?!LedgerPath$)/,
    ];

    const exportNames = Object.keys(tracker);
    for (const name of exportNames) {
      if (ALLOWED.has(name)) continue;
      // If we ever add a new export, fail loudly so the human reviewer
      // has to think about whether it's a reader.
      throw new Error(
        `engagement-tracker exports unknown symbol "${name}" — update the allowlist explicitly after auditing it for read intent`,
      );
    }
    // Belt-and-suspenders: assert no reader-shaped name slipped through.
    for (const name of exportNames) {
      if (!ALLOWED.has(name)) continue;
      // getLedgerPath returns a string (the path), not ledger contents — exempt.
      if (name === "getLedgerPath") continue;
      for (const pat of READER_PATTERNS) {
        if (pat.test(name)) {
          throw new Error(
            `engagement-tracker export "${name}" matches reader-shaped pattern ${pat} — engagement ledger must be write-only from Evy's perspective`,
          );
        }
      }
    }
  });

  test("supervisor-prompt-path functions do not reference the tracker", () => {
    const violations: string[] = [];
    for (const { file, fns } of SUPERVISOR_PROMPT_PATH_FILES) {
      const abs = join(REPO_ROOT, file);
      const src = readFileSync(abs, "utf8");
      for (const fn of fns) {
        const body = extractFunctionBody(src, fn);
        if (body === null) {
          // If the function disappeared, the test setup is wrong — fail
          // loudly rather than silently skipping. This catches the case
          // where a refactor renames the function and quietly invalidates
          // the surgical grep.
          violations.push(
            `${file}: function ${fn} not found — refactor may have left the surgical grep stale`,
          );
          continue;
        }
        for (const sym of FORBIDDEN_SYMBOLS) {
          if (body.includes(sym)) {
            violations.push(`${file}: ${fn}() body references "${sym}"`);
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        "Engagement ledger leaked into supervisor-prompt path:\n  " +
          violations.join("\n  "),
      );
    }
  });
});
