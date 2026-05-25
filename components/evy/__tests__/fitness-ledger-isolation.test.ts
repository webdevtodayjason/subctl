// components/evy/__tests__/fitness-ledger-isolation.test.ts
//
// v3.3.0 — Kernel Fitness Phase 2 negative-criterion red-team test.
//
// LOAD-BEARING: the fitness-ledger MUST be write-only from Evy's
// perspective. The fitness signal must NOT enter the supervisor
// prompt at any point. Evy reflects without knowing she's being
// judged. If this test fails, the whole Kernel Fitness design is
// broken — back out the offending change before merging.
//
// Two layers of defense, both asserted here:
//
//   1. **Export-shape guard.** `fitness-writer.ts` MUST NOT expose
//      any read API (no `readLedger`, no `getEntries`, no
//      `listFitness`, etc.). The only fitness-walking functions are
//      internal (windowAlreadyWritten + rollup helpers) and return
//      counts or booleans, never raw entries.
//   2. **Surgical body grep.** The function bodies of the
//      supervisor-prompt-assembly functions (`composeSystemPrompt`,
//      `buildMemoryBlock`, `buildPersonalityFragment`,
//      `hydrateContext`, `buildReviewerSystemPrompt`) MUST NOT
//      reference the fitness-writer module, the fitness-ledger
//      path, or any writer symbol. Defense-in-depth in case someone
//      adds a reader API in a moment of forgetfulness.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as writer from "../fitness-writer";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const SUPERVISOR_PROMPT_PATH_FILES: Array<{
  file: string;
  /** Function names whose BODIES must be free of writer references. */
  fns: string[];
}> = [
  {
    file: "components/evy/server.ts",
    // composeSystemPrompt is the assembler; it CALLS the helpers below
    // (from other files) and stitches their output. Keeping its body
    // writer-free is the primary defense.
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
 * by counting braces. Pattern matches what
 * `engagement-ledger-isolation.test.ts` uses; kept here verbatim so
 * the two red-team tests stay structurally identical.
 */
function extractFunctionBody(src: string, fnName: string): string | null {
  const re = new RegExp(
    "(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+" +
      fnName +
      "\\s*[<(][\\s\\S]*?\\{",
    "m",
  );
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
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
  "fitness-writer",
  "fitness-ledger",
  "fitnessLedger",
  "fitnessWriter",
  "writeFitnessWindow",
  "runFitnessWriter",
  "runFitnessWindow",
  "fitness-config",
  "fitness-types",
];

describe("fitness ledger isolation (load-bearing negative criterion)", () => {
  test("fitness-writer exports NO reader API", () => {
    // Allowlist of legitimate exports. Anything else is a red flag.
    const ALLOWED = new Set([
      "writeFitnessWindow",
      "runFitnessWriter",
      "getLedgerPath",
      "setLedgerPathForTesting",
      "_setSourcePathsForTesting",
      "_resetForTesting",
    ]);
    // Patterns are PREFIX-shaped: a function whose name STARTS with
    // one of these is a reader by convention. Same prefix list the
    // engagement-tracker isolation test uses, with `get` exempting
    // the path introspector explicitly.
    const READER_PATTERNS = [
      /^read/i,
      /^load/i,
      /^list/i,
      /^scan/i,
      /^fetch/i,
      /^query/i,
      /^find/i,
      /^all$/i,
      /^get(?!LedgerPath$)/,
    ];

    const exportNames = Object.keys(writer);
    for (const name of exportNames) {
      if (ALLOWED.has(name)) continue;
      throw new Error(
        `fitness-writer exports unknown symbol "${name}" — update the allowlist explicitly after auditing it for read intent`,
      );
    }
    // Belt-and-suspenders: assert no reader-shaped name slipped through.
    for (const name of exportNames) {
      if (!ALLOWED.has(name)) continue;
      if (name === "getLedgerPath") continue;
      for (const pat of READER_PATTERNS) {
        if (pat.test(name)) {
          throw new Error(
            `fitness-writer export "${name}" matches reader-shaped pattern ${pat} — fitness ledger must be write-only from Evy's perspective`,
          );
        }
      }
    }
  });

  test("supervisor-prompt-path functions do not reference the fitness writer", () => {
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
        "Fitness ledger leaked into supervisor-prompt path:\n  " +
          violations.join("\n  "),
      );
    }
  });

  test("fitness-writer module body has no fitness ↔ supervisor coupling", () => {
    // Additional safety net: scan the writer source itself for any
    // import from the supervisor-prompt assembly modules. If the
    // writer started importing supervisor pieces, that's a smell —
    // the writer should stay one-way (it READS data-plane artifacts,
    // not supervisor internals).
    const writerSrc = readFileSync(
      join(REPO_ROOT, "components/evy/fitness-writer.ts"),
      "utf8",
    );
    const FORBIDDEN_IMPORTS = [
      "./personality",
      "./context-hydration",
      "./memory-kernel-reviewer",
      "./tools/tier1-memory",
      "pi-agent-core",
    ];
    for (const sym of FORBIDDEN_IMPORTS) {
      // Match `from "<sym>"` or `from '<sym>'`.
      const re = new RegExp(`from\\s+['"]${sym.replace(/\//g, "\\/")}['"]`);
      if (re.test(writerSrc)) {
        throw new Error(
          `fitness-writer imports from "${sym}" — writer must not depend on supervisor-prompt assembly`,
        );
      }
    }
  });
});
