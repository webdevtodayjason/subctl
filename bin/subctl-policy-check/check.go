// bin/subctl-policy-check/check.go
//
// Hot-path policy check. Port of `components/master/tools/policy/check.ts`
// for the v2.7.0 policy engine. The TS impl is the spec; this file is the
// faithful Go translation.
//
// Vector parity (pack 12 §2 PR 8 acceptance + pack 07 §11): every vector in
// `config/policy/test-vectors.toml` must produce identical `decision` and
// `rule_path` in both implementations. `vectors_test.go` asserts that.
//
// Performance budget (pack 07 §3 + pack 06 §4): <50ms cold, <10ms warm. Go
// startup is sub-millisecond, regex compile is cached, and there are zero
// network calls or filesystem walks in the hot path. The only per-check I/O
// is the audit append, which is a single O_APPEND write.
//
// Algorithm (pack 06 §4):
//   1. mode == "trusted" → allow.
//   2. mode == "sealed"  → deny (Bash is disabled upstream; this is a
//      belt-and-suspenders fail-safe).
//   3. mode == "gated" but `mode.gated` table missing → deny (misconfig, fail
//      closed per pack 11 §8).
//   4. Gated path:
//      a. deny_always.substrings on RAW command (untokenized) — heredocs,
//         pipelines, embedded interpreters all visible to substring matcher.
//      b. tokenize; empty → deny.
//      c. deny_always.regex on RAW command (cached compiles).
//         Note: TS scans substrings then regex sequentially inside
//         checkDenyAlways. We replicate that exact precedence so rule_path
//         lands on the same family.
//      d. ecosystem-specific (npm/pnpm/bun/yarn/python_modules/uv/poetry/
//         make/just) — kill semantics: if a config table applies, helper
//         returns final allow/deny rather than falling through.
//      e. allow_pattern walk (first match wins).
//      f. allow.commands exact match.
//      g. default deny with rule_path "mode.gated.default_deny".

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// ---------------------------------------------------------------------------
// Types — mirrors of `lib/policy/types.ts`.
//
// Pointer-typed ecosystem tables so an absent table is `nil`, matching the
// TS semantics where `g.npm` is `undefined` if the policy doc didn't declare
// it. BurntSushi/toml populates these as nil when the table is absent.
// ---------------------------------------------------------------------------

type AllowedScripts struct {
	AllowedScripts []string `toml:"allowed_scripts"`
}

type AllowedTargets struct {
	AllowedTargets []string `toml:"allowed_targets"`
}

type AllowedRecipes struct {
	AllowedRecipes []string `toml:"allowed_recipes"`
}

type AllowedRunTargets struct {
	AllowedRunTargets []string `toml:"allowed_run_targets"`
}

type PythonAllowed struct {
	Allowed []string `toml:"allowed"`
}

type AllowBlock struct {
	Commands []string `toml:"commands"`
}

type DenyAlways struct {
	Substrings []string `toml:"substrings"`
	Regex      []string `toml:"regex"`
}

type AllowPattern struct {
	Command           string   `toml:"command"`
	Args              []string `toml:"args"`
	DenyIfArgContains []string `toml:"deny_if_arg_contains"`
}

type GatedMode struct {
	Allow         AllowBlock         `toml:"allow"`
	AllowPattern  []AllowPattern     `toml:"allow_pattern"`
	DenyAlways    DenyAlways         `toml:"deny_always"`
	Npm           *AllowedScripts    `toml:"npm"`
	Pnpm          *AllowedScripts    `toml:"pnpm"`
	Bun           *AllowedScripts    `toml:"bun"`
	Yarn          *AllowedScripts    `toml:"yarn"`
	Make          *AllowedTargets    `toml:"make"`
	Just          *AllowedRecipes    `toml:"just"`
	PythonModules *PythonAllowed     `toml:"python_modules"`
	UV            *AllowedRunTargets `toml:"uv"`
	Poetry        *AllowedRunTargets `toml:"poetry"`
}

type ModeBlock struct {
	Gated *GatedMode `toml:"gated"`
	// trusted and sealed have no body the check function consumes; the mode
	// string on the document carries the routing.
}

type PolicyDocument struct {
	Preset      string    `toml:"preset"`
	DefaultMode string    `toml:"default_mode"`
	Mode        ModeBlock `toml:"mode"`
}

// CheckRequest mirrors `lib/policy/types.ts:CheckRequest`.
type CheckRequest struct {
	Command        string
	Cwd            string
	TeamID         string
	AgentSessionID string
}

// CheckResult mirrors `lib/policy/types.ts:CheckResult`.
type CheckResult struct {
	Decision string // "allow" | "deny"
	Rule     string
	RulePath string
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// CheckCommand decides whether `req.Command` is allowed under `policy`.
// Pure function over the inputs (modulo internal caches that are deterministic
// functions of seen inputs).
func CheckCommand(policy *PolicyDocument, req *CheckRequest) CheckResult {
	mode := policy.DefaultMode
	if mode == "" {
		mode = "gated"
	}

	switch mode {
	case "trusted":
		return CheckResult{Decision: "allow", Rule: "trusted_mode", RulePath: "mode.trusted"}
	case "sealed":
		// Sealed mode disables Bash upstream; if the hook is somehow still
		// wired to call us, deny as fail-safe (pack 06 §4).
		return CheckResult{Decision: "deny", Rule: "sealed_mode_bash_disabled", RulePath: "mode.sealed"}
	}

	if policy.Mode.Gated == nil {
		// Gated mode declared with no gated table is a misconfiguration. Per
		// pack 11 §8 ("the system fails closed"), deny.
		return CheckResult{
			Decision: "deny",
			Rule:     "gated_mode_missing_config",
			RulePath: "mode.gated.default_deny",
		}
	}

	return checkGated(policy.Mode.Gated, req)
}

func checkGated(g *GatedMode, req *CheckRequest) CheckResult {
	cmd := strings.TrimSpace(req.Command)

	// 1. deny_always wins over everything. Runs on the RAW command line
	//    (untokenized) so heredocs, pipeline operators, and embedded
	//    interpreters are all visible to the substring/regex matchers.
	if r := checkDenyAlways(g, cmd); r != nil {
		return *r
	}

	// 2. Tokenize. Determinism contract shared with tokenize.ts.
	tokens := tokenize(cmd)
	if len(tokens) == 0 {
		return CheckResult{
			Decision: "deny",
			Rule:     "empty_command",
			RulePath: "mode.gated.default_deny",
		}
	}

	head := tokens[0]
	rest := tokens[1:]

	// First non-flag arg after the head, per pack 02 §3.2. Flags before the
	// first positional are skipped. Simple `strings.HasPrefix("-")` mirrors
	// the TS impl (which has the same known limitation on `--` end-of-options
	// markers — pack 11 §5.1).
	firstNonFlag := ""
	firstNonFlagFound := false
	for _, t := range rest {
		if !strings.HasPrefix(t, "-") {
			firstNonFlag = t
			firstNonFlagFound = true
			break
		}
	}

	// 3. Ecosystem-specific checks. Kill semantics: if a config table applies,
	//    the helper returns a final allow/deny rather than falling through.
	if r := checkEcosystemSpecific(g, head, rest, req.Cwd); r != nil {
		return *r
	}

	// 4. allow_pattern walk. First match wins.
	for i, ap := range g.AllowPattern {
		if ap.Command != head {
			continue
		}
		argsOk := len(ap.Args) == 0 || (firstNonFlagFound && containsString(ap.Args, firstNonFlag))
		if !argsOk {
			continue
		}
		// deny_if_arg_contains is a second-pass substring check against ANY
		// token. If any token contains any needle, the matched pattern flips
		// to deny.
		for _, needle := range ap.DenyIfArgContains {
			for _, t := range tokens {
				if strings.Contains(t, needle) {
					return CheckResult{
						Decision: "deny",
						Rule:     fmt.Sprintf("deny_if_arg_contains: %q", needle),
						RulePath: fmt.Sprintf("mode.gated.allow_pattern[%d].deny_if_arg_contains", i),
					}
				}
			}
		}
		return CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("allow_pattern: %s %s", ap.Command, strings.Join(ap.Args, "|")),
			RulePath: fmt.Sprintf("mode.gated.allow_pattern[%d]", i),
		}
	}

	// 5. allow.commands exact match (head only).
	if containsString(g.Allow.Commands, head) {
		return CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("allow.commands: %s", head),
			RulePath: "mode.gated.allow.commands",
		}
	}

	// 6. Default deny.
	return CheckResult{
		Decision: "deny",
		Rule:     "no_match_default_deny",
		RulePath: "mode.gated.default_deny",
	}
}

// ---------------------------------------------------------------------------
// deny_always
// ---------------------------------------------------------------------------

func checkDenyAlways(g *GatedMode, cmd string) *CheckResult {
	// Substrings first — literal `strings.Contains`, ~ns each, covers the
	// bulk of catastrophic patterns. Case-sensitive substring match on the
	// raw command line per pack 02 §3.4.
	for _, sub := range g.DenyAlways.Substrings {
		if strings.Contains(cmd, sub) {
			return &CheckResult{
				Decision: "deny",
				Rule:     fmt.Sprintf("deny_always.substrings: %q", sub),
				RulePath: "mode.gated.deny_always.substrings",
			}
		}
	}

	for _, pat := range g.DenyAlways.Regex {
		re := tryCompileRegex(pat)
		if re != nil && re.MatchString(cmd) {
			return &CheckResult{
				Decision: "deny",
				Rule:     fmt.Sprintf("deny_always.regex: %s", pat),
				RulePath: "mode.gated.deny_always.regex",
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Ecosystem-specific helpers
// ---------------------------------------------------------------------------

func checkEcosystemSpecific(g *GatedMode, head string, rest []string, cwd string) *CheckResult {
	switch head {
	case "npm":
		if g.Npm != nil {
			return checkScriptRunner(g, "npm", rest, cwd)
		}
	case "pnpm":
		if g.Pnpm != nil {
			return checkScriptRunner(g, "pnpm", rest, cwd)
		}
	case "yarn":
		if g.Yarn != nil {
			return checkScriptRunner(g, "yarn", rest, cwd)
		}
	case "bun":
		if g.Bun != nil {
			return checkScriptRunner(g, "bun", rest, cwd)
		}
	case "python", "python3":
		if g.PythonModules != nil {
			return checkPythonModule(g, rest)
		}
	case "uv":
		if g.UV != nil {
			return checkUvRun(g, rest)
		}
	case "poetry":
		if g.Poetry != nil {
			return checkPoetryRun(g, rest)
		}
	case "make":
		if g.Make != nil {
			return checkMakeTarget(g, rest, cwd)
		}
	case "just":
		if g.Just != nil {
			return checkJustRecipe(g, rest)
		}
	}
	return nil
}

// `<runner> run <script>` and `<runner> run-script <script>` go through the
// allowed_scripts gate. Anything else (e.g. `npm install`) returns nil so the
// generic allow_pattern walk handles it.
//
// NOTE on `npm test` (pack 02 §3.5 nuance): the canonical `npm test` is NOT
// routed through allowed_scripts here — it matches `args=[..., "test", ...]`
// in the allow_pattern. The IndyDevDan attack `npm run evil-script` IS gated.
func checkScriptRunner(g *GatedMode, runner string, rest []string, cwd string) *CheckResult {
	if len(rest) == 0 {
		return nil
	}
	if rest[0] != "run" && rest[0] != "run-script" {
		return nil
	}

	scriptName := ""
	for i := 1; i < len(rest); i++ {
		if !strings.HasPrefix(rest[i], "-") {
			scriptName = rest[i]
			break
		}
	}
	if scriptName == "" {
		return nil
	}

	// If package.json is present, the script must also be declared there.
	// Absence (e.g. master daemon introspection, vector tests with no fixture
	// cwd) skips this layer and relies on allowed_scripts alone.
	if pkg := readPackageJSONCached(cwd); pkg != nil && pkg.Scripts != nil {
		if _, ok := pkg.Scripts[scriptName]; !ok {
			return &CheckResult{
				Decision: "deny",
				Rule:     fmt.Sprintf("%s.allowed_scripts: %q not declared in package.json", runner, scriptName),
				RulePath: fmt.Sprintf("mode.gated.%s.allowed_scripts", runner),
			}
		}
	}

	var allowed []string
	switch runner {
	case "npm":
		allowed = g.Npm.AllowedScripts
	case "pnpm":
		allowed = g.Pnpm.AllowedScripts
	case "yarn":
		allowed = g.Yarn.AllowedScripts
	case "bun":
		allowed = g.Bun.AllowedScripts
	}
	if !containsString(allowed, scriptName) {
		return &CheckResult{
			Decision: "deny",
			Rule:     fmt.Sprintf("%s.allowed_scripts: %q not allowlisted", runner, scriptName),
			RulePath: fmt.Sprintf("mode.gated.%s.allowed_scripts", runner),
		}
	}
	return &CheckResult{
		Decision: "allow",
		Rule:     fmt.Sprintf("%s.allowed_scripts: %q", runner, scriptName),
		RulePath: fmt.Sprintf("mode.gated.%s.allowed_scripts", runner),
	}
}

func checkPythonModule(g *GatedMode, rest []string) *CheckResult {
	dashM := -1
	for i, t := range rest {
		if t == "-m" {
			dashM = i
			break
		}
	}
	if dashM < 0 {
		return nil
	}
	if dashM+1 >= len(rest) {
		return nil
	}
	module := rest[dashM+1]
	if module == "" {
		return nil
	}

	if containsString(g.PythonModules.Allowed, module) {
		return &CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("python_modules.allowed: %q", module),
			RulePath: "mode.gated.python_modules.allowed",
		}
	}
	return &CheckResult{
		Decision: "deny",
		Rule:     fmt.Sprintf("python_modules.allowed: %q not allowlisted", module),
		RulePath: "mode.gated.python_modules.allowed",
	}
}

func checkUvRun(g *GatedMode, rest []string) *CheckResult {
	if len(rest) == 0 || rest[0] != "run" {
		return nil
	}
	target := ""
	for i := 1; i < len(rest); i++ {
		if !strings.HasPrefix(rest[i], "-") {
			target = rest[i]
			break
		}
	}
	if target == "" {
		return nil
	}
	if containsString(g.UV.AllowedRunTargets, target) {
		return &CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("uv.allowed_run_targets: %q", target),
			RulePath: "mode.gated.uv.allowed_run_targets",
		}
	}
	return &CheckResult{
		Decision: "deny",
		Rule:     fmt.Sprintf("uv.allowed_run_targets: %q not allowlisted", target),
		RulePath: "mode.gated.uv.allowed_run_targets",
	}
}

func checkPoetryRun(g *GatedMode, rest []string) *CheckResult {
	if len(rest) == 0 || rest[0] != "run" {
		return nil
	}
	target := ""
	for i := 1; i < len(rest); i++ {
		if !strings.HasPrefix(rest[i], "-") {
			target = rest[i]
			break
		}
	}
	if target == "" {
		return nil
	}
	if containsString(g.Poetry.AllowedRunTargets, target) {
		return &CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("poetry.allowed_run_targets: %q", target),
			RulePath: "mode.gated.poetry.allowed_run_targets",
		}
	}
	return &CheckResult{
		Decision: "deny",
		Rule:     fmt.Sprintf("poetry.allowed_run_targets: %q not allowlisted", target),
		RulePath: "mode.gated.poetry.allowed_run_targets",
	}
}

func checkMakeTarget(g *GatedMode, rest []string, cwd string) *CheckResult {
	target := ""
	for _, t := range rest {
		if !strings.HasPrefix(t, "-") {
			target = t
			break
		}
	}
	if target == "" {
		return nil
	}
	// Mirror TS: best-effort Makefile-presence check, value ignored. The cache
	// just keeps the cwd from re-statting on every check inside a worker's
	// lifetime.
	_ = readMakefilePresenceCached(cwd)

	if containsString(g.Make.AllowedTargets, target) {
		return &CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("make.allowed_targets: %q", target),
			RulePath: "mode.gated.make.allowed_targets",
		}
	}
	return &CheckResult{
		Decision: "deny",
		Rule:     fmt.Sprintf("make.allowed_targets: %q not allowlisted", target),
		RulePath: "mode.gated.make.allowed_targets",
	}
}

func checkJustRecipe(g *GatedMode, rest []string) *CheckResult {
	recipe := ""
	for _, t := range rest {
		if !strings.HasPrefix(t, "-") {
			recipe = t
			break
		}
	}
	if recipe == "" {
		return nil
	}
	if containsString(g.Just.AllowedRecipes, recipe) {
		return &CheckResult{
			Decision: "allow",
			Rule:     fmt.Sprintf("just.allowed_recipes: %q", recipe),
			RulePath: "mode.gated.just.allowed_recipes",
		}
	}
	return &CheckResult{
		Decision: "deny",
		Rule:     fmt.Sprintf("just.allowed_recipes: %q not allowlisted", recipe),
		RulePath: "mode.gated.just.allowed_recipes",
	}
}

// ---------------------------------------------------------------------------
// Caches (regex + package.json + Makefile presence)
//
// Mirrors check.ts's three caches. All deterministic functions of inputs the
// process has already seen, so the binary's behavior is reproducible.
// ---------------------------------------------------------------------------

var (
	regexCacheMu sync.Mutex
	regexCache   = map[string]*regexp.Regexp{}
	regexFailed  = map[string]struct{}{}
)

func tryCompileRegex(pat string) *regexp.Regexp {
	regexCacheMu.Lock()
	defer regexCacheMu.Unlock()
	if re, ok := regexCache[pat]; ok {
		return re
	}
	if _, fail := regexFailed[pat]; fail {
		return nil
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		regexFailed[pat] = struct{}{}
		return nil
	}
	regexCache[pat] = re
	return re
}

type packageJSONShape struct {
	Scripts map[string]string `json:"scripts"`
}

type packageJSONCacheEntry struct {
	mtimeNS int64
	doc     *packageJSONShape
}

var (
	pkgJSONMu    sync.Mutex
	pkgJSONCache = map[string]packageJSONCacheEntry{}
)

func readPackageJSONCached(cwd string) *packageJSONShape {
	if cwd == "" {
		return nil
	}
	path := filepath.Join(cwd, "package.json")

	info, err := os.Stat(path)
	if err != nil {
		// Missing or unreadable: cache the negative result so we don't keep
		// stat'ing on every check.
		pkgJSONMu.Lock()
		pkgJSONCache[path] = packageJSONCacheEntry{mtimeNS: -1, doc: nil}
		pkgJSONMu.Unlock()
		return nil
	}
	mtimeNS := info.ModTime().UnixNano()

	pkgJSONMu.Lock()
	if cached, ok := pkgJSONCache[path]; ok && cached.mtimeNS == mtimeNS {
		pkgJSONMu.Unlock()
		return cached.doc
	}
	pkgJSONMu.Unlock()

	data, err := os.ReadFile(path)
	if err != nil {
		pkgJSONMu.Lock()
		pkgJSONCache[path] = packageJSONCacheEntry{mtimeNS: mtimeNS, doc: nil}
		pkgJSONMu.Unlock()
		return nil
	}
	var doc packageJSONShape
	if err := json.Unmarshal(data, &doc); err != nil {
		pkgJSONMu.Lock()
		pkgJSONCache[path] = packageJSONCacheEntry{mtimeNS: mtimeNS, doc: nil}
		pkgJSONMu.Unlock()
		return nil
	}
	pkgJSONMu.Lock()
	pkgJSONCache[path] = packageJSONCacheEntry{mtimeNS: mtimeNS, doc: &doc}
	pkgJSONMu.Unlock()
	return &doc
}

var (
	makefilePresenceMu    sync.Mutex
	makefilePresenceCache = map[string]bool{}
)

func readMakefilePresenceCached(cwd string) bool {
	if cwd == "" {
		return false
	}
	makefilePresenceMu.Lock()
	if cached, ok := makefilePresenceCache[cwd]; ok {
		makefilePresenceMu.Unlock()
		return cached
	}
	makefilePresenceMu.Unlock()
	present := fileExists(filepath.Join(cwd, "Makefile")) || fileExists(filepath.Join(cwd, "GNUmakefile"))
	makefilePresenceMu.Lock()
	makefilePresenceCache[cwd] = present
	makefilePresenceMu.Unlock()
	return present
}

// resetCachesForTesting clears every internal cache. NOT part of the
// production API; exists so test isolation works between cases that need
// different cwd fixtures.
func resetCachesForTesting() {
	regexCacheMu.Lock()
	regexCache = map[string]*regexp.Regexp{}
	regexFailed = map[string]struct{}{}
	regexCacheMu.Unlock()

	pkgJSONMu.Lock()
	pkgJSONCache = map[string]packageJSONCacheEntry{}
	pkgJSONMu.Unlock()

	makefilePresenceMu.Lock()
	makefilePresenceCache = map[string]bool{}
	makefilePresenceMu.Unlock()
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

func containsString(xs []string, target string) bool {
	for _, x := range xs {
		if x == target {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
