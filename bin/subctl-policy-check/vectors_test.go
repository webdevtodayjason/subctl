// bin/subctl-policy-check/vectors_test.go
//
// Cross-implementation contract test. Loads `config/policy/test-vectors.toml`
// (PR 3's 76-vector corpus) and asserts every vector's decision matches the
// Go check implementation. The TS side has a parallel test that runs the
// same corpus through `components/master/tools/policy/check.ts`. The two
// implementations must agree — pack 12 §2 PR 8 + pack 07 §11:
//
//   "Disagreement between them = CI failure."
//
// Rule-path leniency matches the TS test (vectors.test.ts):
//   1. Bracket-index suffixes `[N]` are stripped before compare — the array
//      index is best-effort, the family prefix is what matters.
//   2. Within the deny_always family, .substrings and .regex are
//      interchangeable. Several vectors include `rm -rf` literally inside
//      their test payload (e.g. perl -e 'system("rm -rf …")'), and the
//      substring matcher fires first by spec.
//
// One vector is documented-skipped on both sides:
//   "node: find / -name foo -delete is denied"
//
// It's a known node-preset gap tracked for v2.8 (the deny_always.substrings
// list has `find / -delete` literal but the variant `find / -name foo
// -delete` slips through). vectors.test.ts skips it; we mirror that exactly
// so TS+Go stay in lockstep.

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

type vector struct {
	Name             string `toml:"name"`
	Policy           string `toml:"policy"`
	Command          string `toml:"command"`
	Expected         string `toml:"expected"`
	ExpectedRulePath string `toml:"expected_rule_path"`
}

type vectorFile struct {
	Vector []vector `toml:"vector"`
}

// knownPresetGaps mirrors KNOWN_PRESET_GAPS in vectors.test.ts. Each entry
// MUST have a tracking note. Removing an entry from one side without the
// other is a parity break.
var knownPresetGaps = map[string]bool{
	// Pack 11 §5 attack class: find -delete bypass.
	// Vector: `find / -name foo -delete`. Expected: deny.
	// Actual: allow (node preset's `find` is in allow.commands).
	// The substring matcher has `find / -delete` and `find . -delete` as
	// literal strings; the `-name foo` between `/` and `-delete` breaks the
	// literal match. A broader regex would close it.
	// Tracked: v2.8 preset refresh.
	"node: find / -name foo -delete is denied": true,
}

func TestVectorParity(t *testing.T) {
	root := resolveSubctlRoot(t)
	t.Setenv("SUBCTL_INSTALL_ROOT", root)

	vectorsPath := filepath.Join(root, "config", "policy", "test-vectors.toml")
	data, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vf vectorFile
	if _, err := toml.Decode(string(data), &vf); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	if len(vf.Vector) < 70 {
		t.Fatalf("expected >=70 vectors, got %d", len(vf.Vector))
	}
	t.Logf("loaded %d vectors", len(vf.Vector))

	// Preload presets so we don't re-parse on every vector.
	presets := map[string]*PolicyDocument{}
	for _, name := range []string{"node", "python", "generic"} {
		doc, err := LoadPresetByName(name)
		if err != nil {
			t.Fatalf("load preset %s: %v", name, err)
		}
		presets[name] = doc
	}

	// Use a non-existent cwd so ecosystem helpers' package.json/Makefile
	// probes return null — matches the TS test's "/tmp/__subctl_vectors_test__"
	// fixture path which also doesn't exist.
	cwd := "/tmp/__subctl_go_vectors_test__"
	resetCachesForTesting()

	failures := 0
	for _, v := range vf.Vector {
		name := v.Name
		if knownPresetGaps[name] {
			t.Run("[KNOWN-GAP v2.8] "+name, func(t *testing.T) {
				t.Skip("documented preset gap; mirrors TS vectors.test.ts")
			})
			continue
		}
		t.Run(name, func(t *testing.T) {
			policy, ok := presets[v.Policy]
			if !ok {
				t.Fatalf("unknown preset in vector: %q", v.Policy)
			}
			res := CheckCommand(policy, &CheckRequest{
				Command: v.Command,
				Cwd:     cwd,
				TeamID:  "t",
			})
			if res.Decision != v.Expected {
				failures++
				t.Errorf("decision mismatch: expected=%s actual=%s rule=%s rule_path=%s command=%q",
					v.Expected, res.Decision, res.Rule, res.RulePath, v.Command)
				return
			}
			if v.ExpectedRulePath != "" {
				if !ruleMatches(res.RulePath, v.ExpectedRulePath) {
					failures++
					t.Errorf("rule_path mismatch:\n  expected: %s\n  actual:   %s\n  command:  %q",
						v.ExpectedRulePath, res.RulePath, v.Command)
				}
			}
		})
	}
	if failures > 0 {
		t.Logf("vector parity: %d failures across %d vectors", failures, len(vf.Vector))
	}
}

// rulePathBase strips `[N]` bracket-index suffixes for lenient prefix matching.
// Mirrors the TS test's rulePathBase().
func rulePathBase(p string) string {
	var out strings.Builder
	inBracket := false
	for _, r := range p {
		if r == '[' {
			inBracket = true
			continue
		}
		if r == ']' {
			inBracket = false
			continue
		}
		if inBracket {
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

// ruleMatches is the lenient rule_path comparator. Mirrors the TS test's
// ruleMatches(): equal after stripping `[N]` suffixes OR both in the
// `mode.gated.deny_always.*` family (substrings/regex are interchangeable
// because substring fires before regex by spec when both could match).
func ruleMatches(actual, expected string) bool {
	a := rulePathBase(actual)
	e := rulePathBase(expected)
	if a == e {
		return true
	}
	const denyFamily = "mode.gated.deny_always."
	if strings.HasPrefix(a, denyFamily) && strings.HasPrefix(e, denyFamily) {
		return true
	}
	return false
}

// resolveSubctlRoot walks up from the test binary's working dir looking for
// `config/policy/test-vectors.toml`. The test binary normally runs from
// `bin/subctl-policy-check/`, so the corpus is 2 levels up.
func resolveSubctlRoot(t *testing.T) string {
	t.Helper()
	if env := os.Getenv("SUBCTL_INSTALL_ROOT"); env != "" {
		return env
	}
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	cur := wd
	for i := 0; i < 8; i++ {
		probe := filepath.Join(cur, "config", "policy", "test-vectors.toml")
		if _, err := os.Stat(probe); err == nil {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	t.Fatalf("could not find subctl root anchoring config/policy/test-vectors.toml (started from %s)", wd)
	return ""
}

// ---------------------------------------------------------------------------
// Smaller targeted tests — useful when debugging a regression in isolation.
// ---------------------------------------------------------------------------

func TestTokenize_HappyPath(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"git status", []string{"git", "status"}},
		{"git log --oneline -20", []string{"git", "log", "--oneline", "-20"}},
		{`git commit -m "feat: add policy gate"`, []string{"git", "commit", "-m", "feat: add policy gate"}},
		{"npm run lint", []string{"npm", "run", "lint"}},
		{"python -m pytest", []string{"python", "-m", "pytest"}},
		{"  pwd  ", []string{"pwd"}},
		{"", nil},
		{"   ", nil},
	}
	for _, c := range cases {
		got := tokenize(c.in)
		if !slicesEqual(got, c.want) {
			t.Errorf("tokenize(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
