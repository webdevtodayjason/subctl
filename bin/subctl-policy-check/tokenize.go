// bin/subctl-policy-check/tokenize.go
//
// Deterministic shell-aware tokenizer for the policy engine's Go port.
//
// Spec: `components/master/tools/policy/tokenize.ts`. The TS implementation
// wraps the npm `shell-quote` library; this file ports the relevant subset of
// shell-quote's behavior. Determinism contract (pack 11 §2.1): tokenize(s) is
// a pure function of `s`; the same input produces byte-identical token arrays
// across both implementations.
//
// Expansion contract (pack 06 §4 "no shell expansion"):
//   - `$VAR` / `${VAR}` → kept LITERALLY as `$VAR` / `${VAR}`.
//   - `~/foo` → kept LITERALLY as `~/foo`.
//   - `*.txt` / `?` globs → kept LITERALLY as the source pattern.
//   - The whole point is that `rm -rf $HOME` still has the substring
//     `rm -rf`, so deny_always.substrings can catch it. Decisions are made
//     on the raw command line as well, so even if tokenization differs at
//     the margins, substring-level denies fire first.
//
// Operator preservation (pack 11 §2.1):
//   - `|`, `||`, `&&`, `&`, `;`, `>`, `>>`, `<`, `<<<` → emitted as their
//     literal string in their own token slot.
//   - Heredoc: shell-quote splits `<<EOF` into two `<` ops plus the tag
//     string. tokenize.ts merges them to a single `<<EOF` token. We do the
//     same so the regex denies fire on the merged form.

package main

import "strings"

// tokenize converts a raw command line into a flat slice of literal-string
// tokens. Empty input and whitespace-only input both return nil.
//
// Behavior summary:
//   - whitespace separates tokens
//   - single quotes preserve everything literally
//   - double quotes preserve everything except `\\`, `\"`, `\$`, `` \` ``
//     (which collapse to the escaped char). This matches shell-quote's
//     escape handling in JS.
//   - backslash outside quotes escapes the next character (including space)
//   - `|`, `||`, `&`, `&&`, `;`, `>`, `>>`, `<` are emitted as their own tokens
//   - `<<<` is emitted as `<<<`
//   - `<<TAG` is emitted as a single `<<TAG` token (heredoc merge)
//
// The function never panics; malformed input (e.g. unterminated quote) is
// handled best-effort by consuming what's there and emitting it.
func tokenize(cmd string) []string {
	if strings.TrimSpace(cmd) == "" {
		return nil
	}

	var tokens []string
	var cur strings.Builder
	// hasToken tracks whether the current token-in-progress is "real" — i.e.
	// the cursor entered a quote or wrote a char — so an empty `""` token
	// flushes correctly. We don't currently rely on it for our 76 vectors but
	// it keeps the contract honest.
	hasToken := false

	flush := func() {
		if hasToken {
			tokens = append(tokens, cur.String())
			cur.Reset()
			hasToken = false
		}
	}

	runes := []rune(cmd)
	n := len(runes)

	for i := 0; i < n; {
		c := runes[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			flush()
			i++

		case c == '\'':
			// Single quote: literal everything until next single quote. No
			// escapes are recognized inside (matches shell + shell-quote).
			hasToken = true
			i++
			for i < n && runes[i] != '\'' {
				cur.WriteRune(runes[i])
				i++
			}
			if i < n {
				i++ // skip closing '
			}

		case c == '"':
			// Double quote: literal except for `\\`, `\"`, `\$`, `` \` ``
			// (shell-quote's recognized escapes). Unrecognized backslash
			// sequences pass through with the backslash.
			hasToken = true
			i++
			for i < n && runes[i] != '"' {
				if runes[i] == '\\' && i+1 < n {
					next := runes[i+1]
					switch next {
					case '\\', '"', '$', '`':
						cur.WriteRune(next)
						i += 2
						continue
					}
				}
				cur.WriteRune(runes[i])
				i++
			}
			if i < n {
				i++ // skip closing "
			}

		case c == '\\':
			// Backslash outside quotes: literal next char (incl. whitespace).
			if i+1 < n {
				cur.WriteRune(runes[i+1])
				hasToken = true
				i += 2
			} else {
				// Trailing backslash with no follow — drop it.
				i++
			}

		case c == '|':
			flush()
			if i+1 < n && runes[i+1] == '|' {
				tokens = append(tokens, "||")
				i += 2
			} else {
				tokens = append(tokens, "|")
				i++
			}

		case c == '&':
			flush()
			if i+1 < n && runes[i+1] == '&' {
				tokens = append(tokens, "&&")
				i += 2
			} else {
				tokens = append(tokens, "&")
				i++
			}

		case c == ';':
			flush()
			tokens = append(tokens, ";")
			i++

		case c == '>':
			flush()
			if i+1 < n && runes[i+1] == '>' {
				tokens = append(tokens, ">>")
				i += 2
			} else {
				tokens = append(tokens, ">")
				i++
			}

		case c == '<':
			flush()
			// `<<<` is here-string.
			if i+2 < n && runes[i+1] == '<' && runes[i+2] == '<' {
				tokens = append(tokens, "<<<")
				i += 3
				break
			}
			// `<<TAG` is a heredoc start. shell-quote splits this into two
			// `<` ops + a string tag; tokenize.ts merges them. We emit the
			// already-merged form so the regex denies (`python3?\s*<<\s*EOF`)
			// still fire against the raw command line, and so the token list
			// carries a meaningful `<<EOF` slot.
			if i+1 < n && runes[i+1] == '<' {
				i += 2
				// shell-quote merges only when a string tag immediately
				// follows (no whitespace). We mirror that.
				var tag strings.Builder
				for i < n {
					ch := runes[i]
					if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
						break
					}
					if ch == '|' || ch == '&' || ch == ';' || ch == '<' || ch == '>' {
						break
					}
					tag.WriteRune(ch)
					i++
				}
				if tag.Len() > 0 {
					tokens = append(tokens, "<<"+tag.String())
				} else {
					tokens = append(tokens, "<<")
				}
				break
			}
			tokens = append(tokens, "<")
			i++

		default:
			cur.WriteRune(c)
			hasToken = true
			i++
		}
	}
	flush()
	return tokens
}
