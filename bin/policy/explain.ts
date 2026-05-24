#!/usr/bin/env bun
// bin/policy/explain.ts
//
// `subctl policy explain '<command>'` — the trace renderer. Per pack 07 §6:
// "the single most useful debugging tool for users who hit a denial and want
// to understand why."
//
// IMPLEMENTATION CHOICE — REPLICATION, not extension.
//
// The brief offered two paths: (a) extend `check.ts` with an optional trace
// collector (additive, never altering the decision), or (b) replicate the
// algorithm here with verbose tracing built in. We picked (b). Reasons:
//
//   1. check.ts is on the hot path: the `PreToolUse` hook calls it on every
//      bash invocation. Adding optional-but-always-checked code, even cheap
//      branches, risks a latency regression in a path that's already
//      tightly budgeted (pack 06 §4: <20ms p99 warm).
//   2. The PR 8 Go port mirrors check.ts byte-for-byte against the shared
//      test vector corpus. A trace param in check.ts would have to either
//      be added to the Go port (doubles the surface area + parity risk) or
//      explicitly left out of parity tests (decay risk).
//   3. The trace renderer's logic is what we want to inspect anyway — it's
//      not a separate algorithm, it's "the algorithm with annotations." A
//      one-file replica reads like the spec.
//
// THE TRADEOFF: this file must stay in lockstep with check.ts. If check.ts
// changes (a new rule class, a new ecosystem helper, a kill-semantic flip),
// this file must update too. We mitigate via:
//   - The same `tokenize` import as check.ts (no re-implementation of the
//     tokenizer).
//   - The same type definitions.
//   - The same rule_path strings as check.ts so the trace lines up with the
//     audit log + dashboard renderings.
//   - The cli.test.ts smoke test asserts trace output for a few canonical
//     allow/deny commands; if check.ts diverges, that test catches it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { loadResolvedPolicy } from "../../components/evy/tools/policy/load";
import { tokenize } from "../../components/evy/tools/policy/tokenize";
import type {
  AllowPattern,
  GatedMode,
  PolicyDocument,
} from "../../components/evy/tools/policy/types";

interface Args {
  command: string | null;
  projectRoot: string;
  mode: "trusted" | "gated" | "sealed" | null;
  help: boolean;
}

interface TraceStep {
  // ✓ check that passed without firing a rule (informational)
  // ✗ check that fired and produced a decision
  // ·  ecosystem-style sub-step (indented)
  marker: "ok" | "fail" | "info";
  text: string;
  indent: number;
}

interface ExplainResult {
  decision: "allow" | "deny";
  rule: string;
  rule_path: string;
  steps: TraceStep[];
  suggestion?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { command: null, projectRoot: process.cwd(), mode: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--project-root") {
      const next = argv[++i];
      if (!next) die(`${a} requires an argument`);
      out.projectRoot = next;
    } else if (a.startsWith("--project-root=")) {
      out.projectRoot = a.slice("--project-root=".length);
    } else if (a === "--mode") {
      const next = argv[++i];
      if (!next) die(`${a} requires an argument`);
      assertMode(next);
      out.mode = next;
    } else if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length);
      assertMode(v);
      out.mode = v;
    } else if (!a.startsWith("-")) {
      if (out.command !== null) {
        // Allow space-containing commands as a single positional via quoting,
        // OR as the join of remaining argv (matches the pack 07 §6 example
        // `subctl policy explain 'npm run deploy:prod'`).
        out.command = `${out.command} ${a}`;
      } else {
        out.command = a;
      }
    } else {
      die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function assertMode(s: string): asserts s is "trusted" | "gated" | "sealed" {
  if (s !== "trusted" && s !== "gated" && s !== "sealed") {
    die(`--mode must be trusted|gated|sealed (got: ${s})`);
  }
}

function die(msg: string): never {
  process.stderr.write(`subctl policy explain: ${msg}\n`);
  process.exit(1);
}

function help(): void {
  process.stdout.write(`subctl policy explain '<command>' [--project-root=<dir>] [--mode=<mode>]

Show the evaluation trace for a command against the resolved policy.

  --project-root <dir>   Path to project root (defaults to cwd).
  --mode <mode>          Override the resolved default_mode (trusted|gated|sealed).
  -h, --help             Show this help.

Examples:
  subctl policy explain 'git status'
  subctl policy explain 'rm -rf /tmp/foo'
  subctl policy explain 'npm run deploy:prod' --project-root=$HOME/code/foothold
`);
}

// ---------------------------------------------------------------------------
// Replicated algorithm with tracing
// ---------------------------------------------------------------------------

function explainCommand(
  policy: PolicyDocument,
  command: string,
  modeOverride: "trusted" | "gated" | "sealed" | null,
  cwd: string,
): ExplainResult {
  const steps: TraceStep[] = [];
  const mode = modeOverride ?? policy.default_mode ?? "gated";

  steps.push({ marker: "info", text: `resolving against mode: ${mode}`, indent: 0 });

  if (mode === "trusted") {
    steps.push({ marker: "fail", text: "trusted_mode: blanket allow (model is the only gate)", indent: 0 });
    return { decision: "allow", rule: "trusted_mode", rule_path: "mode.trusted", steps };
  }

  if (mode === "sealed") {
    steps.push({
      marker: "fail",
      text: "sealed_mode: Bash is in disabledTools upstream; blanket deny (fail-safe)",
      indent: 0,
    });
    return {
      decision: "deny",
      rule: "sealed_mode_bash_disabled",
      rule_path: "mode.sealed",
      steps,
      suggestion: "Sealed-mode workers do not have a Bash tool. Use the configured MCP tools instead, or respawn the worker with --mode=gated to use the policy allowlist.",
    };
  }

  const g = policy.mode?.gated;
  if (!g) {
    steps.push({
      marker: "fail",
      text: "gated mode declared with no [mode.gated] table — fail closed",
      indent: 0,
    });
    return {
      decision: "deny",
      rule: "gated_mode_missing_config",
      rule_path: "mode.gated.default_deny",
      steps,
      suggestion: "Add a [mode.gated] table to your .subctl/policy.toml, or set preset = 'node' / 'python' / 'generic' to inherit a shipped one.",
    };
  }

  const cmd = command.trim();

  // 1. deny_always.substrings (raw command string)
  const subs = g.deny_always?.substrings ?? [];
  let subHit: string | null = null;
  for (const s of subs) {
    if (cmd.includes(s)) {
      subHit = s;
      break;
    }
  }
  if (subHit !== null) {
    steps.push({ marker: "fail", text: `deny_always.substrings  matched "${subHit}"`, indent: 0 });
    return {
      decision: "deny",
      rule: `deny_always.substrings: "${subHit}"`,
      rule_path: "mode.gated.deny_always.substrings",
      steps,
      suggestion: `'${subHit}' is in deny_always.substrings — this is intentional (catastrophic patterns). If you must allow it for this project, remove the substring from your inherited preset by setting preset = "none" and declaring a custom [mode.gated.deny_always] that omits it.`,
    };
  }
  steps.push({ marker: "ok", text: `deny_always.substrings  no match (${subs.length} checked)`, indent: 0 });

  // 2. deny_always.regex
  const regex = g.deny_always?.regex ?? [];
  let regexHit: string | null = null;
  for (const pat of regex) {
    try {
      const re = new RegExp(pat);
      if (re.test(cmd)) {
        regexHit = pat;
        break;
      }
    } catch {
      // Invalid regex — same fail-open semantics as check.ts (skip).
    }
  }
  if (regexHit !== null) {
    steps.push({ marker: "fail", text: `deny_always.regex       matched /${regexHit}/`, indent: 0 });
    return {
      decision: "deny",
      rule: `deny_always.regex: ${regexHit}`,
      rule_path: "mode.gated.deny_always.regex",
      steps,
      suggestion: `Pattern /${regexHit}/ is in deny_always.regex — typically these catch interpreter-as-payload forms (python -c, node -e, curl|sh). To remove it, set preset = "none" and redeclare deny_always.regex with the patterns you want.`,
    };
  }
  steps.push({ marker: "ok", text: `deny_always.regex       no match (${regex.length} checked)`, indent: 0 });

  // 3. Tokenize
  const tokens = tokenize(cmd);
  if (tokens.length === 0) {
    steps.push({ marker: "fail", text: "tokenizer produced no tokens — empty command", indent: 0 });
    return {
      decision: "deny",
      rule: "empty_command",
      rule_path: "mode.gated.default_deny",
      steps,
    };
  }
  const head = tokens[0];
  const rest = tokens.slice(1);
  const firstNonFlag = rest.find((t) => !t.startsWith("-"));
  steps.push({
    marker: "info",
    text: `tokenized: head="${head}", rest=[${rest.map((r) => JSON.stringify(r)).join(", ")}]`,
    indent: 0,
  });

  // 4. Ecosystem-specific
  const eco = explainEcosystem(g, head, rest, firstNonFlag, cwd, steps);
  if (eco) return eco;

  // 5. allow_pattern walk
  if (g.allow_pattern && g.allow_pattern.length > 0) {
    steps.push({
      marker: "info",
      text: `allow_pattern walk (${g.allow_pattern.length} entries; first match wins)`,
      indent: 0,
    });
    for (let i = 0; i < g.allow_pattern.length; i++) {
      const ap = g.allow_pattern[i];
      if (ap.command !== head) {
        steps.push({
          marker: "ok",
          text: `allow_pattern[${i}] command="${ap.command}"  head mismatch`,
          indent: 2,
        });
        continue;
      }
      const argsOk =
        !ap.args ||
        ap.args.length === 0 ||
        (firstNonFlag !== undefined && ap.args.includes(firstNonFlag));
      if (!argsOk) {
        steps.push({
          marker: "ok",
          text: `allow_pattern[${i}] command="${ap.command}"  head OK, first-arg "${firstNonFlag ?? "(none)"}" not in args [${(ap.args ?? []).join(", ")}]`,
          indent: 2,
        });
        continue;
      }

      if (ap.deny_if_arg_contains) {
        for (const needle of ap.deny_if_arg_contains) {
          if (tokens.some((t) => t.includes(needle))) {
            steps.push({
              marker: "fail",
              text: `allow_pattern[${i}].deny_if_arg_contains "${needle}" matched a token`,
              indent: 2,
            });
            return {
              decision: "deny",
              rule: `deny_if_arg_contains: "${needle}"`,
              rule_path: `mode.gated.allow_pattern[${i}].deny_if_arg_contains`,
              steps,
              suggestion: `Token "${needle}" tripped the deny_if_arg_contains second-pass filter on allow_pattern[${i}]. Rephrase the command to avoid the substring, or remove the needle from deny_if_arg_contains in your policy.toml.`,
            };
          }
        }
      }

      steps.push({
        marker: "fail",
        text: `allow_pattern[${i}] command="${ap.command}"  ✓ matched`,
        indent: 2,
      });
      return {
        decision: "allow",
        rule: `allow_pattern: ${ap.command} ${(ap.args ?? []).join("|")}`,
        rule_path: `mode.gated.allow_pattern[${i}]`,
        steps,
      };
    }
  }

  // 6. allow.commands exact-match (head)
  if (g.allow?.commands?.includes(head)) {
    steps.push({ marker: "fail", text: `allow.commands matched head "${head}"`, indent: 0 });
    return {
      decision: "allow",
      rule: `allow.commands: ${head}`,
      rule_path: "mode.gated.allow.commands",
      steps,
    };
  }
  steps.push({
    marker: "ok",
    text: `allow.commands  no exact match for head "${head}" (${(g.allow?.commands ?? []).length} entries)`,
    indent: 0,
  });

  // 7. Default deny
  steps.push({ marker: "fail", text: `default-deny — no rule allowed "${head}"`, indent: 0 });
  return {
    decision: "deny",
    rule: "no_match_default_deny",
    rule_path: "mode.gated.default_deny",
    steps,
    suggestion: buildDefaultDenySuggestion(head, command),
  };
}

function explainEcosystem(
  g: GatedMode,
  head: string,
  rest: string[],
  firstNonFlag: string | undefined,
  cwd: string,
  steps: TraceStep[],
): ExplainResult | null {
  // Script runners (npm/pnpm/yarn/bun) only kill-route when the first arg is
  // "run" or "run-script". Otherwise we fall through to allow_pattern.
  type R = "npm" | "pnpm" | "yarn" | "bun";
  const runners: R[] = ["npm", "pnpm", "yarn", "bun"];
  for (const r of runners) {
    if (head === r && g[r]) {
      if (rest[0] !== "run" && rest[0] !== "run-script") {
        steps.push({
          marker: "info",
          text: `${r}: not 'run' / 'run-script' — fall through to allow_pattern`,
          indent: 0,
        });
        return null;
      }
      const scriptName = rest.find((t, i) => i >= 1 && !t.startsWith("-"));
      if (!scriptName) {
        steps.push({ marker: "info", text: `${r} run: no script name — fall through`, indent: 0 });
        return null;
      }
      // package.json existence check (best effort — same as check.ts).
      const pkgPath = join(cwd, "package.json");
      let pkgScripts: Record<string, string> | null = null;
      if (existsSync(pkgPath)) {
        try {
          const doc = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
          pkgScripts = doc.scripts ?? null;
        } catch {
          pkgScripts = null;
        }
      }
      if (pkgScripts && !(scriptName in pkgScripts)) {
        steps.push({
          marker: "fail",
          text: `${r}.allowed_scripts: "${scriptName}" not declared in ${pkgPath}`,
          indent: 0,
        });
        return {
          decision: "deny",
          rule: `${r}.allowed_scripts: "${scriptName}" not declared in package.json`,
          rule_path: `mode.gated.${r}.allowed_scripts`,
          steps,
          suggestion: `'${scriptName}' is not a script in ${pkgPath}. Add it there first, then add it to allowed_scripts.`,
        };
      }
      const allowed = g[r]?.allowed_scripts ?? [];
      if (!allowed.includes(scriptName)) {
        steps.push({
          marker: "fail",
          text: `${r}.allowed_scripts: "${scriptName}" not in [${allowed.join(", ")}]`,
          indent: 0,
        });
        return {
          decision: "deny",
          rule: `${r}.allowed_scripts: "${scriptName}" not allowlisted`,
          rule_path: `mode.gated.${r}.allowed_scripts`,
          steps,
          suggestion: buildAllowedScriptsSuggestion(r, allowed, scriptName, cwd),
        };
      }
      steps.push({
        marker: "fail",
        text: `${r}.allowed_scripts: "${scriptName}" ✓ matched`,
        indent: 0,
      });
      return {
        decision: "allow",
        rule: `${r}.allowed_scripts: "${scriptName}"`,
        rule_path: `mode.gated.${r}.allowed_scripts`,
        steps,
      };
    }
  }

  // python -m <module>
  if ((head === "python" || head === "python3") && g.python_modules) {
    const dashM = rest.indexOf("-m");
    if (dashM < 0) {
      steps.push({ marker: "info", text: `python: no -m flag — fall through`, indent: 0 });
      return null;
    }
    const mod = rest[dashM + 1];
    if (!mod) {
      steps.push({ marker: "info", text: `python -m with no module — fall through`, indent: 0 });
      return null;
    }
    const allowed = g.python_modules.allowed ?? [];
    if (allowed.includes(mod)) {
      steps.push({ marker: "fail", text: `python_modules.allowed "${mod}" ✓ matched`, indent: 0 });
      return {
        decision: "allow",
        rule: `python_modules.allowed: "${mod}"`,
        rule_path: "mode.gated.python_modules.allowed",
        steps,
      };
    }
    steps.push({ marker: "fail", text: `python_modules.allowed "${mod}" not in [${allowed.join(", ")}]`, indent: 0 });
    return {
      decision: "deny",
      rule: `python_modules.allowed: "${mod}" not allowlisted`,
      rule_path: "mode.gated.python_modules.allowed",
      steps,
      suggestion: `Add "${mod}" to mode.gated.python_modules.allowed in your .subctl/policy.toml (REPLACE semantics — include the full current list).`,
    };
  }

  // uv run <target> + poetry run <target>
  for (const [name, table] of [
    ["uv", g.uv?.allowed_run_targets],
    ["poetry", g.poetry?.allowed_run_targets],
  ] as Array<[string, string[] | undefined]>) {
    if (head !== name || !table) continue;
    if (rest[0] !== "run") {
      steps.push({ marker: "info", text: `${name}: not 'run' — fall through`, indent: 0 });
      return null;
    }
    const target = rest.find((t, i) => i >= 1 && !t.startsWith("-"));
    if (!target) {
      steps.push({ marker: "info", text: `${name} run: no target — fall through`, indent: 0 });
      return null;
    }
    if (table.includes(target)) {
      steps.push({ marker: "fail", text: `${name}.allowed_run_targets "${target}" ✓ matched`, indent: 0 });
      return {
        decision: "allow",
        rule: `${name}.allowed_run_targets: "${target}"`,
        rule_path: `mode.gated.${name}.allowed_run_targets`,
        steps,
      };
    }
    steps.push({ marker: "fail", text: `${name}.allowed_run_targets "${target}" not in [${table.join(", ")}]`, indent: 0 });
    return {
      decision: "deny",
      rule: `${name}.allowed_run_targets: "${target}" not allowlisted`,
      rule_path: `mode.gated.${name}.allowed_run_targets`,
      steps,
    };
  }

  // make <target>
  if (head === "make" && g.make) {
    const target = rest.find((t) => !t.startsWith("-"));
    if (!target) {
      steps.push({ marker: "info", text: `make: bare invocation — fall through`, indent: 0 });
      return null;
    }
    const allowed = g.make.allowed_targets ?? [];
    if (allowed.includes(target)) {
      steps.push({ marker: "fail", text: `make.allowed_targets "${target}" ✓ matched`, indent: 0 });
      return {
        decision: "allow",
        rule: `make.allowed_targets: "${target}"`,
        rule_path: "mode.gated.make.allowed_targets",
        steps,
      };
    }
    steps.push({ marker: "fail", text: `make.allowed_targets "${target}" not in [${allowed.join(", ")}]`, indent: 0 });
    return {
      decision: "deny",
      rule: `make.allowed_targets: "${target}" not allowlisted`,
      rule_path: "mode.gated.make.allowed_targets",
      steps,
    };
  }

  // just <recipe>
  if (head === "just" && g.just) {
    const recipe = rest.find((t) => !t.startsWith("-"));
    if (!recipe) {
      steps.push({ marker: "info", text: `just: no recipe — fall through`, indent: 0 });
      return null;
    }
    const allowed = g.just.allowed_recipes ?? [];
    if (allowed.includes(recipe)) {
      steps.push({ marker: "fail", text: `just.allowed_recipes "${recipe}" ✓ matched`, indent: 0 });
      return {
        decision: "allow",
        rule: `just.allowed_recipes: "${recipe}"`,
        rule_path: "mode.gated.just.allowed_recipes",
        steps,
      };
    }
    steps.push({ marker: "fail", text: `just.allowed_recipes "${recipe}" not in [${allowed.join(", ")}]`, indent: 0 });
    return {
      decision: "deny",
      rule: `just.allowed_recipes: "${recipe}" not allowlisted`,
      rule_path: "mode.gated.just.allowed_recipes",
      steps,
    };
  }

  // unused suppressions for forward-compat
  void firstNonFlag;
  return null;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function buildAllowedScriptsSuggestion(
  runner: "npm" | "pnpm" | "yarn" | "bun",
  current: string[],
  toAdd: string,
  cwd: string,
): string {
  const list = [...current, toAdd]
    .map((s) => `    "${s}",`)
    .join("\n");
  return [
    `Add "${toAdd}" to mode.gated.${runner}.allowed_scripts.`,
    `Note: allowed_scripts is REPLACE-not-EXTEND when overridden — include the full list, not just the addition.`,
    ``,
    `Add to ${join(cwd, ".subctl", "policy.toml")}:`,
    ``,
    `  [mode.gated.${runner}]`,
    `  allowed_scripts = [`,
    list,
    `  ]`,
  ].join("\n");
}

function buildDefaultDenySuggestion(head: string, command: string): string {
  // Conservative: suggest adding to allow.commands when the head is a single
  // command with no obvious arg constraints. Otherwise, suggest allow_pattern.
  if (/^[A-Za-z0-9_.\-]+$/.test(head)) {
    return [
      `No rule matched. To allow this command, add to your .subctl/policy.toml:`,
      ``,
      `  [mode.gated.allow]`,
      `  commands = ["${head}"]   # plus any others you want to allowlist`,
      ``,
      `Or, with arg-level filtering:`,
      ``,
      `  [[mode.gated.allow_pattern]]`,
      `  command = "${head}"`,
      `  args = []   # populate to constrain the first non-flag argument`,
    ].join("\n");
  }
  return `No rule matched for ${JSON.stringify(command)}. Inspect the command shape — the head token "${head}" is unusual; check for typos.`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderTrace(result: ExplainResult, projectRoot: string, command: string, mode: string): string {
  let out = "";
  out += `project:      ${projectRoot}\n`;
  out += `mode:         ${mode}\n`;
  out += `command:      ${command}\n`;
  out += `\nevaluation trace:\n`;
  for (const s of result.steps) {
    const indent = "  ".repeat(s.indent / 2 + 1);
    let prefix = "  ";
    if (s.marker === "ok") prefix = "✓ ";
    else if (s.marker === "fail") prefix = "✗ ";
    else prefix = "· ";
    out += `${indent}${prefix}${s.text}\n`;
  }
  out += `  → ${result.decision.toUpperCase()}: ${result.rule} (${result.rule_path})\n`;
  if (result.suggestion) {
    out += `\nsuggestion:\n`;
    for (const line of result.suggestion.split("\n")) {
      out += `  ${line}\n`;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return 0;
  }
  if (!args.command) {
    process.stderr.write(`subctl policy explain: command required (usage: subctl policy explain '<command>')\n`);
    return 1;
  }

  let policy: PolicyDocument;
  try {
    policy = await loadResolvedPolicy(args.projectRoot);
  } catch (err) {
    process.stderr.write(`subctl policy explain: policy load failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const modeUsed = args.mode ?? policy.default_mode ?? "gated";
  const result = explainCommand(policy, args.command, args.mode, args.projectRoot);
  process.stdout.write(renderTrace(result, args.projectRoot, args.command, modeUsed));
  return result.decision === "allow" ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`subctl policy explain: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// AllowPattern reference kept so the import line stays useful as a documented
// dependency even though the algorithm uses g.allow_pattern[] directly.
void (null as unknown as AllowPattern | null);
