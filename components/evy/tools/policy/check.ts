// components/evy/tools/policy/check.ts
//
// Hot-path policy check. The decision function the `PreToolUse` hook calls
// before every Bash invocation in a Gated worker. Pack 06 §4 is the reference
// algorithm; this file is the faithful implementation.
//
// Performance budget (pack 06 §4): <20ms p99 warm-cache, 1000 checks under
// 100ms wall-clock on an M-series Mac. Achieved by:
//   - In-memory regex cache (compiled once per unique pattern, reused forever).
//   - In-memory package.json cache keyed by (path, mtime), shared across
//     checks within the same process.
//   - No filesystem walks. No network. No shell expansion.
//
// Failure modes (pack 11 §8): fail closed. Empty command → deny. Missing
// gated config in a Gated-mode policy → deny. Regex compile failure → skip
// that pattern, others still apply (validator catches before ship).
//
// The hot-path call:
//
//   const policy = await loadResolvedPolicy(project_root);   // PR 4
//   const result = checkCommand(policy, {
//     command: "npm run lint",
//     cwd: project_root,
//     team_id: "...",
//   });
//   if (result.decision === "deny") { ... }
//
// The Go port in PR 8 implements this same algorithm against the shared
// `config/policy/test-vectors.toml` corpus. Divergence between the two
// is the CI gate that catches porting bugs.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { tokenize } from "./tokenize";
import type {
  CheckRequest,
  CheckResult,
  GatedMode,
  PolicyDocument,
} from "./types";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide whether `req.command` is allowed under `policy`. Pure function over
 * the policy doc + request; the only side effects are populating internal
 * caches (regex + package.json), which are deterministic functions of inputs
 * the function has already seen.
 *
 * Per pack 06 §4 + HANDOFF_DIGEST §3.1 D9:
 *   - `trusted` → blanket allow (the model is the only gate; defang stays).
 *   - `sealed`  → blanket deny for Bash (Bash is in disabledTools upstream;
 *                 this is the belt-and-suspenders fail-safe).
 *   - `gated`   → checkGated() walks the resolution order.
 */
export function checkCommand(
  policy: PolicyDocument,
  req: CheckRequest,
): CheckResult {
  const mode = policy.default_mode ?? "gated";

  if (mode === "trusted") {
    return { decision: "allow", rule: "trusted_mode", rule_path: "mode.trusted" };
  }

  if (mode === "sealed") {
    // Sealed mode disables the Bash tool entirely upstream; if the hook is
    // somehow still wired to call us, deny everything as a fail-safe.
    return {
      decision: "deny",
      rule: "sealed_mode_bash_disabled",
      rule_path: "mode.sealed",
    };
  }

  const gated = policy.mode?.gated;
  if (!gated) {
    // Gated mode declared with no gated table is a misconfiguration. Per
    // pack 11 §8 ("the system fails closed"), deny.
    return {
      decision: "deny",
      rule: "gated_mode_missing_config",
      rule_path: "mode.gated.default_deny",
    };
  }

  return checkGated(gated, req);
}

function checkGated(g: GatedMode, req: CheckRequest): CheckResult {
  const cmd = req.command.trim();

  // 1. deny_always wins over everything. Runs against the RAW command line
  //    (untokenized) so multi-line heredocs, pipeline operators, and
  //    embedded interpreters are all visible to the substring/regex matchers.
  //
  //    KNOWN FALSE POSITIVE (pack 11 §5.1):
  //    `git commit -m 'rm -rf old files'` is denied by the substring matcher
  //    because 'rm -rf' literally appears inside the commit message.
  //    Documented in docs/policy.md. The tradeoff: precise word-boundary
  //    matching would make the engine more vulnerable to evasion via
  //    embedded literals, so we accept the false positive.
  const da = checkDenyAlways(g, cmd);
  if (da) return da;

  // 2. Tokenize. shell-quote is deterministic and shared with the Go port
  //    (PR 8) — see tokenize.ts for the determinism contract.
  const tokens = tokenize(cmd);
  if (tokens.length === 0) {
    return {
      decision: "deny",
      rule: "empty_command",
      rule_path: "mode.gated.default_deny",
    };
  }

  const head = tokens[0];
  const rest = tokens.slice(1);
  // First non-flag arg after the head, per pack 02 §3.2. Flags ("-x" or
  // "--foo") before the first positional are skipped. We use a simple
  // startsWith("-") check — this misses `--` end-of-options markers but
  // matches the pack 06 §4 reference. Tracked as a known limitation in
  // docs/policy.md; affects ergonomic cases like `git -C /tmp status`.
  const firstNonFlag = rest.find((t) => !t.startsWith("-"));

  // 3. Ecosystem-specific checks. These fire BEFORE allow_pattern walk and
  //    apply kill semantics: if a config table applies (e.g. `g.npm` is
  //    set and head is "npm"), the ecosystem helper returns a final
  //    allow/deny rather than falling through. This is what prevents the
  //    IndyDevDan-style "npm run evil-script" bypass.
  const eco = checkEcosystemSpecific(g, head, rest, req.cwd);
  if (eco) return eco;

  // 4. allow_pattern walk. First match wins. Pack 06 §4.
  if (g.allow_pattern) {
    for (let i = 0; i < g.allow_pattern.length; i++) {
      const ap = g.allow_pattern[i];
      if (ap.command !== head) continue;

      // Pack 06 §4: an empty/undefined args list means "any first non-flag
      // arg is OK" (i.e. the pattern matches as long as the head matches).
      // A populated args list requires the first non-flag arg to be in it.
      const argsOk =
        !ap.args ||
        ap.args.length === 0 ||
        (firstNonFlag !== undefined && ap.args.includes(firstNonFlag));
      if (!argsOk) continue;

      // Pack 02 §3.3: deny_if_arg_contains is a second-pass substring check
      // against ANY token in the command. If any token contains any listed
      // needle, the otherwise-matched pattern flips to deny.
      if (ap.deny_if_arg_contains) {
        for (const needle of ap.deny_if_arg_contains) {
          if (tokens.some((t) => t.includes(needle))) {
            return {
              decision: "deny",
              rule: `deny_if_arg_contains: "${needle}"`,
              rule_path: `mode.gated.allow_pattern[${i}].deny_if_arg_contains`,
            };
          }
        }
      }

      return {
        decision: "allow",
        rule: `allow_pattern: ${ap.command} ${(ap.args ?? []).join("|")}`,
        rule_path: `mode.gated.allow_pattern[${i}]`,
      };
    }
  }

  // 5. allow.commands exact match (head only, no arg constraints).
  if (g.allow?.commands?.includes(head)) {
    return {
      decision: "allow",
      rule: `allow.commands: ${head}`,
      rule_path: "mode.gated.allow.commands",
    };
  }

  // 6. Default deny. Pack 06 §4 returns an empty rule_path for default deny;
  //    we use "mode.gated.default_deny" to match the test vector corpus
  //    (config/policy/test-vectors.toml §14) and to keep the verifier's
  //    denial-cluster groupings (PR 6.5) coherent.
  return {
    decision: "deny",
    rule: "no_match_default_deny",
    rule_path: "mode.gated.default_deny",
  };
}

// ---------------------------------------------------------------------------
// deny_always
// ---------------------------------------------------------------------------

function checkDenyAlways(g: GatedMode, cmd: string): CheckResult | null {
  // Substrings first — they're a literal `String.includes()`, ~1µs each,
  // and they cover the bulk of catastrophic patterns ("rm -rf", "dd if=",
  // fork bomb literal, etc.). Pack 02 §3.4: case-sensitive substring match
  // on the raw command line.
  if (g.deny_always?.substrings) {
    for (const sub of g.deny_always.substrings) {
      if (cmd.includes(sub)) {
        return {
          decision: "deny",
          rule: `deny_always.substrings: "${sub}"`,
          rule_path: "mode.gated.deny_always.substrings",
        };
      }
    }
  }

  if (g.deny_always?.regex) {
    for (const pat of g.deny_always.regex) {
      const re = tryCompileRegex(pat);
      if (re && re.test(cmd)) {
        return {
          decision: "deny",
          rule: `deny_always.regex: ${pat}`,
          rule_path: "mode.gated.deny_always.regex",
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ecosystem-specific helpers
// ---------------------------------------------------------------------------

/**
 * Route to the per-ecosystem helper if a relevant config table is set and
 * the head command matches. Return `null` to fall through to the generic
 * allow_pattern walk.
 *
 * Pack 06 §4 + pack 02 §3.5: ecosystem helpers apply "kill semantics" — if
 * the config table is present and the command is a script invocation, the
 * helper makes the final decision. This is what makes `npm run evil-script`
 * deny even though `npm` is in `allow_pattern.args = ["run", ...]`.
 *
 * Non-script forms (e.g. `npm install`) return `null` here and fall through
 * to allow_pattern.
 */
function checkEcosystemSpecific(
  g: GatedMode,
  head: string,
  rest: string[],
  cwd: string,
): CheckResult | null {
  if (head === "npm" && g.npm) return checkScriptRunner(g, "npm", rest, cwd);
  if (head === "pnpm" && g.pnpm) return checkScriptRunner(g, "pnpm", rest, cwd);
  if (head === "yarn" && g.yarn) return checkScriptRunner(g, "yarn", rest, cwd);
  if (head === "bun" && g.bun) return checkScriptRunner(g, "bun", rest, cwd);

  if ((head === "python" || head === "python3") && g.python_modules) {
    return checkPythonModule(g, rest);
  }

  if (head === "uv" && g.uv) return checkUvRun(g, rest);
  if (head === "poetry" && g.poetry) return checkPoetryRun(g, rest);
  if (head === "make" && g.make) return checkMakeTarget(g, rest, cwd);
  if (head === "just" && g.just) return checkJustRecipe(g, rest);

  return null;
}

type ScriptRunner = "npm" | "pnpm" | "yarn" | "bun";

/**
 * `<runner> run <script>` and `<runner> run-script <script>` go through the
 * allowed_scripts gate. Anything else (e.g. `npm install`, `pnpm add foo`,
 * `bun test`) returns null so the generic allow_pattern walk handles it.
 *
 * NOTE on `npm test` (pack 02 §3.5 nuance): the canonical `npm test` and
 * `yarn test` invocations are NOT routed through allowed_scripts here.
 * They match the `args = [..., "test", ...]` allow_pattern at the generic
 * walk, which is sufficient since "test" is a fixed entry-point name and
 * the script-content vector is out of scope for this engine (the hook
 * gates the agent's proposed command, not what npm's child process spawns).
 * The IndyDevDan attack is `npm run evil-script` — that one IS gated here.
 * Recorded as the explanation for the `npm test` rule_path in PR 3's
 * test-vectors.toml (where the canonical `npm test` matches allow_pattern[0],
 * not npm.allowed_scripts).
 */
function checkScriptRunner(
  g: GatedMode,
  runner: ScriptRunner,
  rest: string[],
  cwd: string,
): CheckResult | null {
  if (rest[0] !== "run" && rest[0] !== "run-script") return null;

  const scriptName = rest.find((t, i) => i >= 1 && !t.startsWith("-"));
  if (!scriptName) return null;

  // If package.json exists at cwd, the script must also be declared there.
  // Otherwise the agent can't bypass by adding a script we never approved.
  // If package.json is absent (e.g. master daemon introspection, vector
  // tests with no fixture cwd), skip this layer and rely on allowed_scripts
  // alone. Pack 02 §3.5: "deny if not in package.json's scripts OR not in
  // allowed_scripts."
  const pkg = readPackageJsonCached(cwd);
  if (pkg && pkg.scripts && !(scriptName in pkg.scripts)) {
    return {
      decision: "deny",
      rule: `${runner}.allowed_scripts: "${scriptName}" not declared in package.json`,
      rule_path: `mode.gated.${runner}.allowed_scripts`,
    };
  }

  const table = g[runner];
  if (!table?.allowed_scripts?.includes(scriptName)) {
    return {
      decision: "deny",
      rule: `${runner}.allowed_scripts: "${scriptName}" not allowlisted`,
      rule_path: `mode.gated.${runner}.allowed_scripts`,
    };
  }

  return {
    decision: "allow",
    rule: `${runner}.allowed_scripts: "${scriptName}"`,
    rule_path: `mode.gated.${runner}.allowed_scripts`,
  };
}

function checkPythonModule(g: GatedMode, rest: string[]): CheckResult | null {
  const dashM = rest.indexOf("-m");
  if (dashM < 0) return null;
  const module = rest[dashM + 1];
  if (!module) return null;

  const allowed = g.python_modules?.allowed ?? [];
  if (allowed.includes(module)) {
    return {
      decision: "allow",
      rule: `python_modules.allowed: "${module}"`,
      rule_path: "mode.gated.python_modules.allowed",
    };
  }
  return {
    decision: "deny",
    rule: `python_modules.allowed: "${module}" not allowlisted`,
    rule_path: "mode.gated.python_modules.allowed",
  };
}

function checkUvRun(g: GatedMode, rest: string[]): CheckResult | null {
  if (rest[0] !== "run") return null;
  const target = rest.find((t, i) => i >= 1 && !t.startsWith("-"));
  if (!target) return null;

  const allowed = g.uv?.allowed_run_targets ?? [];
  if (allowed.includes(target)) {
    return {
      decision: "allow",
      rule: `uv.allowed_run_targets: "${target}"`,
      rule_path: "mode.gated.uv.allowed_run_targets",
    };
  }
  return {
    decision: "deny",
    rule: `uv.allowed_run_targets: "${target}" not allowlisted`,
    rule_path: "mode.gated.uv.allowed_run_targets",
  };
}

function checkPoetryRun(g: GatedMode, rest: string[]): CheckResult | null {
  if (rest[0] !== "run") return null;
  const target = rest.find((t, i) => i >= 1 && !t.startsWith("-"));
  if (!target) return null;

  const allowed = g.poetry?.allowed_run_targets ?? [];
  if (allowed.includes(target)) {
    return {
      decision: "allow",
      rule: `poetry.allowed_run_targets: "${target}"`,
      rule_path: "mode.gated.poetry.allowed_run_targets",
    };
  }
  return {
    decision: "deny",
    rule: `poetry.allowed_run_targets: "${target}" not allowlisted`,
    rule_path: "mode.gated.poetry.allowed_run_targets",
  };
}

function checkMakeTarget(
  g: GatedMode,
  rest: string[],
  cwd: string,
): CheckResult | null {
  // `make` with no positional → bare default-target invocation. Let the
  // generic allow_pattern walk decide (typically deny by default since
  // `make` is rarely in allow_pattern).
  const target = rest.find((t) => !t.startsWith("-"));
  if (!target) return null;

  // Best-effort Makefile presence check. If a Makefile/GNUmakefile is
  // discoverable at cwd, we trust the allowed_targets list (parsing
  // Makefile targets cleanly across BSD/GNU make is a project of its own;
  // out of scope for v2.7.0 and tracked for v2.8). The cache key includes
  // cwd so repeated checks within a worker don't hit the disk twice.
  void readMakefilePresenceCached(cwd);

  const allowed = g.make?.allowed_targets ?? [];
  if (allowed.includes(target)) {
    return {
      decision: "allow",
      rule: `make.allowed_targets: "${target}"`,
      rule_path: "mode.gated.make.allowed_targets",
    };
  }
  return {
    decision: "deny",
    rule: `make.allowed_targets: "${target}" not allowlisted`,
    rule_path: "mode.gated.make.allowed_targets",
  };
}

function checkJustRecipe(g: GatedMode, rest: string[]): CheckResult | null {
  const recipe = rest.find((t) => !t.startsWith("-"));
  if (!recipe) return null;

  const allowed = g.just?.allowed_recipes ?? [];
  if (allowed.includes(recipe)) {
    return {
      decision: "allow",
      rule: `just.allowed_recipes: "${recipe}"`,
      rule_path: "mode.gated.just.allowed_recipes",
    };
  }
  return {
    decision: "deny",
    rule: `just.allowed_recipes: "${recipe}" not allowlisted`,
    rule_path: "mode.gated.just.allowed_recipes",
  };
}

// ---------------------------------------------------------------------------
// Caches (regex + package.json + Makefile)
// ---------------------------------------------------------------------------

// Regex cache. Pack 06 §4: "Patterns are loaded once at policy-load time and
// reused for the life of the worker. Don't recompile per check." Keyed by
// raw pattern string so two policies sharing a pattern share the compiled
// regex too.
const regexCache = new Map<string, RegExp | null>();

function tryCompileRegex(pat: string): RegExp | null {
  const cached = regexCache.get(pat);
  if (cached !== undefined) return cached;
  try {
    const re = new RegExp(pat);
    regexCache.set(pat, re);
    return re;
  } catch {
    // Invalid regex: cache `null` so we don't keep re-throwing. Validator
    // catches this before ship; runtime treats it as "pattern doesn't apply"
    // (pack 11 §8 "fail closed" applies elsewhere — a broken deny pattern
    // doesn't promote an allow, it just means OTHER deny patterns still
    // get their chance).
    regexCache.set(pat, null);
    return null;
  }
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
}

// package.json cache. Keyed by absolute path + mtime so we automatically
// invalidate when the file changes (rare in a worker's lifetime but cheap
// to handle). Pack 06 §4: "cached per-team for the life of the worker."
const pkgJsonCache = new Map<string, { mtimeMs: number; doc: PackageJsonShape | null }>();

function readPackageJsonCached(cwd: string): PackageJsonShape | null {
  if (!cwd) return null;
  const path = join(cwd, "package.json");

  let mtimeMs = -1;
  try {
    if (!existsSync(path)) {
      pkgJsonCache.set(path, { mtimeMs: -1, doc: null });
      return null;
    }
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }

  const cached = pkgJsonCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.doc;

  try {
    const text = readFileSync(path, "utf8");
    const doc = JSON.parse(text) as PackageJsonShape;
    pkgJsonCache.set(path, { mtimeMs, doc });
    return doc;
  } catch {
    pkgJsonCache.set(path, { mtimeMs, doc: null });
    return null;
  }
}

// Makefile presence cache. Just a "does cwd/Makefile or cwd/GNUmakefile
// exist" boolean; full target parsing is a v2.8 follow-up. The cache key is
// cwd because we never need to invalidate on file-content change for a
// presence check.
const makefilePresenceCache = new Map<string, boolean>();

function readMakefilePresenceCached(cwd: string): boolean {
  if (!cwd) return false;
  const cached = makefilePresenceCache.get(cwd);
  if (cached !== undefined) return cached;
  const present =
    existsSync(join(cwd, "Makefile")) || existsSync(join(cwd, "GNUmakefile"));
  makefilePresenceCache.set(cwd, present);
  return present;
}

/**
 * Test hook: clear every internal cache. NOT part of the production API;
 * exists so test isolation works (e.g. between cases that mock different
 * package.json contents at the same path).
 */
export function _resetCachesForTesting(): void {
  regexCache.clear();
  pkgJsonCache.clear();
  makefilePresenceCache.clear();
}
