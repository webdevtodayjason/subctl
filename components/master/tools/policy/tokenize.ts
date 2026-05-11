// components/master/tools/policy/tokenize.ts
//
// Deterministic shell-aware tokenizer for the subctl policy engine (v2.7.0).
//
// Per `.orchestration/handoff-pack/06-tool-family-policy.md` §4 + pack 11 §2.1:
//
//   "The tokenizer is the single most important piece of correctness in this
//    file. The exact same tokenization must happen in the master daemon AND
//    in the CLI hook, or denials and allows will diverge. Use one shared
//    module imported by both call sites. Recommended: `shell-quote` from npm,
//    which is small and battle-tested. Pin the version."
//
// This file is the SPEC for PR 8's Go port (`bin/subctl-policy-check`). Every
// vector in `config/policy/test-vectors.toml` must produce identical token
// streams in both implementations. If you change anything here, also update
// the Go side or `vectors.test.ts` will diverge.
//
// Determinism contract:
//   - tokenize(s) is a pure function of `s`.
//   - 1000 trials on the same input produce byte-identical arrays
//     (`tokenize.test.ts` asserts this explicitly).
//   - No process-time, no random, no `Date.now()`, no env reads.
//
// Expansion contract (pack 06 §4 "no shell expansion"):
//   - `$VAR` / `${VAR}` → kept LITERALLY as `$VAR`.
//   - `~/foo` → kept LITERALLY as `~/foo`.
//   - `*.txt` / `?` globs → kept LITERALLY as the source pattern.
//   - The whole point is that `rm -rf $HOME` still has the substring
//     `rm -rf`, so deny_always.substrings can catch it.
//
// Operator preservation (pack 11 §2.1):
//   - `|`, `||`, `&&`, `&`, `;`, `>`, `>>`, `<`, `<<<` etc. are emitted as
//     their literal string. They appear as separate tokens so check.ts can
//     reason about pipelines (though deny_always.regex on the RAW command
//     string is the dominant pipeline-deny path; see check.ts).
//   - Heredoc: shell-quote splits `<<EOF` into two `<` ops followed by the
//     tag string `EOF`. We merge them into a single `<<EOF` token so that
//     `python <<EOF` tokenizes as `["python", "<<EOF", …]` per pack 11 §2.1.

import { parse } from "shell-quote";

/**
 * Tokenize a shell command line into an array of literal-string tokens.
 *
 * Empty input and whitespace-only input both return `[]`. shell-quote errors
 * (which are rare; the parser is permissive) collapse to `[]` so the hot path
 * falls into default_deny rather than crashing the worker.
 *
 * NOTE: This function does NOT decide allow/deny; that's check.ts. It only
 * converts a raw command string into an array of string tokens. The literal-
 * string contract means `tokens.some(t => t.includes(substring))` and
 * `firstNonFlag = tokens.find(t => !t.startsWith("-"))` work the way pack 06
 * §4 expects.
 */
export function tokenize(cmd: string): string[] {
  if (!cmd) return [];
  // shell-quote returns [] for an all-whitespace input on its own, but we
  // short-circuit so the function has a deterministic fast path.
  if (cmd.trim() === "") return [];

  // Tell shell-quote to keep variables literal. Without this, `$HOME` would
  // become "" (empty token) — fatal, because then `rm -rf $HOME` would
  // tokenize as `["rm", "-rf", ""]` and the empty token would silently pass
  // the deny check. Passing this lambda makes `$HOME` stay as the literal
  // string "$HOME" — exactly what pack 06 §4 mandates.
  const keepLiteral = (name: string) => `$${name}`;

  let parsed: unknown[];
  try {
    parsed = parse(cmd, keepLiteral as unknown as Record<string, string>);
  } catch {
    return [];
  }

  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item && typeof item === "object" && "op" in item) {
      const op = String((item as { op: string }).op);

      // Glob entries arrive as `{ op: 'glob', pattern: '*.txt' }`. The
      // expansion contract says we keep the literal pattern.
      if (op === "glob") {
        const pat = (item as { pattern?: string }).pattern;
        if (typeof pat === "string") out.push(pat);
        continue;
      }

      // Heredoc handling: shell-quote splits `<<` into two consecutive
      // `{op:'<'}` entries. Combine them with the following tag string into
      // a single token like `<<EOF`, per pack 11 §2.1 ("Heredocs: python
      // <<EOF\n…EOF → tokenized as python, <<EOF, …").
      const nextItem = parsed[i + 1];
      const isNextLT =
        nextItem != null &&
        typeof nextItem === "object" &&
        "op" in nextItem &&
        (nextItem as { op?: string }).op === "<";
      if (op === "<" && isNextLT) {
        const tagItem = parsed[i + 2];
        if (typeof tagItem === "string") {
          out.push(`<<${tagItem}`);
          i += 2;
          continue;
        }
        // No tag string after the `<<`: emit as bare `<<` and continue.
        out.push("<<");
        i += 1;
        continue;
      }

      // Every other operator: emit as a single literal-string token
      // (`|` → "|", `&&` → "&&", `<<<` → "<<<", etc.).
      out.push(op);
    }
    // Anything else (e.g. shell-quote's `{ comment: "..." }`): drop silently.
  }
  return out;
}
