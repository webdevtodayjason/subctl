#!/usr/bin/env bun
// bin/policy/validate.ts
//
// `subctl policy validate` — lint a policy.toml file against the schema +
// invariants. Per pack 07 §5, the 7 checks are (in order):
//
//   1. TOML is parseable
//   2. Document matches the JSON schema (config/policy/schema.json)
//   3. Every regex in deny_always.regex compiles (RE2-style; we use JS RegExp
//      which is a superset — patterns that pass here may still fail in the
//      Go binary's RE2, but the Go validator runs at install time)
//   4. Every preset name resolves to a shipped file
//   5. No `allow_pattern.command` appears verbatim as a `deny_always.substring`
//      (those would be unreachable — always-deny via substring, never via
//      allow_pattern walk)
//   6. test_command is a single command (no &&, |, ;, ||)
//   7. mcp_tools names exist in the (currently curated) registry
//
// Exit codes:
//   0 = clean (zero errors, zero warnings)
//   1 = errors found (printed to stderr)
//   2 = warnings only (still successful from CI perspective, but flagged)
//
// This is the same exit-code contract as `bun run` / lint tools and matches
// what `bash check_run.sh && echo OK` style harnesses expect.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import process from "node:process";

// smol-toml is installed under components/evy/node_modules (Evy is the
// only TS workspace at v3.0; the bin/ tree has no node_modules of its own).
// Resolving "smol-toml" via the standard node_modules walk fails from this
// file's location, so we import via Evy's installed copy. Pinned to
// the same version as components/evy/package.json so the parser stays in
// lockstep with what the Evy daemon uses.
//
// IMPORTANT v3.0 rename: this path was previously components/master/...;
// after the Phase 3 rename + first install (bun install in components/evy/),
// the dir is regenerated. If you see a "Cannot find module" error here
// during upgrade, run `cd components/evy && bun install` to re-vendor.
import { parse as parseToml } from "../../components/evy/node_modules/smol-toml/dist/index.js";

import { resolveSubctlInstall } from "../../components/evy/tools/policy/load";

interface Args {
  path: string | null;
  preset: string | null;
  help: boolean;
}

interface Finding {
  level: "error" | "warning";
  message: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { path: null, preset: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--preset") {
      const next = argv[++i];
      if (!next) die(`${a} requires an argument`);
      out.preset = next;
    } else if (a.startsWith("--preset=")) {
      out.preset = a.slice("--preset=".length);
    } else if (!a.startsWith("-")) {
      if (out.path !== null) die(`unexpected positional: ${a}`);
      out.path = a;
    } else {
      die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function help(): void {
  process.stdout.write(`subctl policy validate [path] [--preset=<name>]

Validate a policy.toml file. Defaults to ./.subctl/policy.toml when no path
or preset is given.

Flags:
  --preset=<name>    Validate the shipped preset config/policy/presets/<name>.toml
  -h, --help         Show this help.

Exit codes:
  0   clean
  1   errors found
  2   warnings only
`);
}

function die(msg: string): never {
  process.stderr.write(`subctl policy validate: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Schema validation (hand-rolled, minimal — keyed off schema.json)
// ---------------------------------------------------------------------------

interface SchemaCtx {
  schema: any;
  defs: Record<string, any>;
  findings: Finding[];
}

function validateAgainstSchema(doc: unknown, schemaPath: string, findings: Finding[]): void {
  let schemaText: string;
  try {
    schemaText = readFileSync(schemaPath, "utf8");
  } catch (err) {
    findings.push({
      level: "warning",
      message: `schema file ${schemaPath} not readable; skipping schema check`,
    });
    return;
  }
  let schema: any;
  try {
    schema = JSON.parse(schemaText);
  } catch (err) {
    findings.push({
      level: "warning",
      message: `schema file ${schemaPath} not valid JSON; skipping schema check`,
    });
    return;
  }
  const defs = (schema.$defs ?? {}) as Record<string, any>;
  const ctx: SchemaCtx = { schema, defs, findings };
  walk(doc, schema, "$", ctx);
}

function resolveRef(ref: string, ctx: SchemaCtx): any {
  // Only handles "#/$defs/X" — the shape used in our schema.
  const prefix = "#/$defs/";
  if (!ref.startsWith(prefix)) return null;
  const key = ref.slice(prefix.length);
  return ctx.defs[key] ?? null;
}

function walk(value: unknown, schema: any, path: string, ctx: SchemaCtx): void {
  if (!schema) return;

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, ctx);
    if (resolved) walk(value, resolved, path, ctx);
    return;
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      ctx.findings.push({
        level: "error",
        message: `${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`,
      });
      return;
    }
  }

  // type checks
  const expected = schema.type as string | string[] | undefined;
  if (expected) {
    const types = Array.isArray(expected) ? expected : [expected];
    if (!matchesType(value, types)) {
      ctx.findings.push({
        level: "error",
        message: `${path}: expected ${types.join("|")}, got ${jsType(value)}`,
      });
      return;
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], schema.items, `${path}[${i}]`, ctx);
      }
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      ctx.findings.push({
        level: "warning",
        message: `${path}: array entries are not unique`,
      });
    }
    return;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, any>;

    // required
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (!(r in obj)) {
          ctx.findings.push({
            level: "error",
            message: `${path}.${r}: required field missing`,
          });
        }
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          ctx.findings.push({
            level: "error",
            message: `${path}.${k}: unknown property (additionalProperties: false)`,
          });
        }
      }
    }

    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) walk(obj[k], sub, `${path}.${k}`, ctx);
    }
  }

  if (typeof value === "string" && typeof schema.minLength === "number") {
    if (value.length < schema.minLength) {
      ctx.findings.push({
        level: "error",
        message: `${path}: string shorter than minLength=${schema.minLength}`,
      });
    }
  }
}

function matchesType(v: unknown, types: string[]): boolean {
  for (const t of types) {
    if (t === "object" && v && typeof v === "object" && !Array.isArray(v)) return true;
    if (t === "array" && Array.isArray(v)) return true;
    if (t === "string" && typeof v === "string") return true;
    if (t === "integer" && typeof v === "number" && Number.isInteger(v)) return true;
    if (t === "number" && typeof v === "number") return true;
    if (t === "boolean" && typeof v === "boolean") return true;
    if (t === "null" && v === null) return true;
  }
  return false;
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// Invariant checks (3 / 4 / 5 / 6 / 7)
// ---------------------------------------------------------------------------

function checkRegexCompiles(doc: any, findings: Finding[]): void {
  const regexList = doc?.mode?.gated?.deny_always?.regex;
  if (!Array.isArray(regexList)) return;
  for (let i = 0; i < regexList.length; i++) {
    const pat = regexList[i];
    if (typeof pat !== "string") continue;
    try {
      new RegExp(pat);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        level: "error",
        message: `mode.gated.deny_always.regex[${i}]: regex does not compile — ${msg} (pattern: ${pat})`,
      });
    }
  }
}

function checkPresetExists(doc: any, installRoot: string, findings: Finding[]): void {
  const preset = doc?.preset;
  if (typeof preset !== "string") return;
  if (preset === "none") return;
  const path = join(installRoot, "config", "policy", "presets", `${preset}.toml`);
  if (!existsSync(path)) {
    findings.push({
      level: "error",
      message: `preset "${preset}" does not resolve to a shipped file (expected ${path})`,
    });
  }
}

function checkAllowVsDenyConflict(doc: any, findings: Finding[]): void {
  const aps: any[] = doc?.mode?.gated?.allow_pattern ?? [];
  const subs: string[] = doc?.mode?.gated?.deny_always?.substrings ?? [];
  if (aps.length === 0 || subs.length === 0) return;
  const subSet = new Set(subs);
  for (let i = 0; i < aps.length; i++) {
    const ap = aps[i];
    if (!ap || typeof ap.command !== "string") continue;
    if (subSet.has(ap.command)) {
      findings.push({
        level: "error",
        message: `allow_pattern[${i}].command="${ap.command}" is also in deny_always.substrings — the deny_always substring always wins, making this allow_pattern unreachable`,
      });
    }
  }
}

const PIPELINE_RE = /(&&|\|\||;|\|)/;

function checkTestCommandSingle(doc: any, findings: Finding[]): void {
  const tc = doc?.mode?.sealed?.test_command;
  if (typeof tc !== "string") return;
  if (PIPELINE_RE.test(tc)) {
    findings.push({
      level: "error",
      message: `mode.sealed.test_command must be a single command (no &&, |, ;, ||); got: ${tc}`,
    });
  }
}

// Curated MCP tool registry — pack 07 §5 #7. Until the master daemon exposes
// a discoverable registry endpoint we hand-maintain the v1 set per pack 06
// §6 + docs/policy.md §5. Names not in this set produce WARNINGS, not errors,
// because user-installed MCP servers can legitimately add new tools and we
// don't want the validator to be the bottleneck.
const KNOWN_MCP_TOOLS = new Set([
  "fs_read",
  "fs_write",
  "fs_list",
  "fs_search",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "test_run",
  "policy_request",
  "ask_operator",
  "complete",
]);

function checkMcpTools(doc: any, findings: Finding[]): void {
  const tools: unknown = doc?.mode?.sealed?.mcp_tools;
  if (!Array.isArray(tools)) return;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (typeof t !== "string") continue;
    if (!KNOWN_MCP_TOOLS.has(t)) {
      findings.push({
        level: "warning",
        message: `mode.sealed.mcp_tools[${i}]="${t}" is not in the curated v1 set; treat as a custom MCP server tool`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveTargetPath(args: Args): { path: string; label: string } {
  if (args.preset) {
    const root = resolveSubctlInstall();
    const p = join(root, "config", "policy", "presets", `${args.preset}.toml`);
    return { path: p, label: `preset "${args.preset}"` };
  }
  if (args.path) {
    return { path: resolve(args.path), label: args.path };
  }
  return { path: join(process.cwd(), ".subctl", "policy.toml"), label: "./.subctl/policy.toml" };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return 0;
  }
  const target = resolveTargetPath(args);
  const findings: Finding[] = [];

  if (!existsSync(target.path)) {
    process.stderr.write(`subctl policy validate: ${target.label} does not exist (looked at ${target.path})\n`);
    return 1;
  }

  // 1. TOML parses
  let text: string;
  try {
    text = readFileSync(target.path, "utf8");
  } catch (err) {
    process.stderr.write(`subctl policy validate: read failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  let doc: any;
  try {
    doc = parseToml(text);
  } catch (err) {
    process.stderr.write(`subctl policy validate: TOML parse failed in ${target.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 2. Schema
  const installRoot = resolveSubctlInstall();
  const schemaPath = join(installRoot, "config", "policy", "schema.json");
  validateAgainstSchema(doc, schemaPath, findings);

  // 3. regex compiles
  checkRegexCompiles(doc, findings);
  // 4. preset resolves (skip if validating a preset itself — presets don't carry the preset= field)
  if (!args.preset) checkPresetExists(doc, installRoot, findings);
  // 5. allow vs deny conflict
  checkAllowVsDenyConflict(doc, findings);
  // 6. test_command single command
  checkTestCommandSingle(doc, findings);
  // 7. mcp_tools warnings
  checkMcpTools(doc, findings);

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");

  if (errors.length === 0 && warnings.length === 0) {
    process.stdout.write(`OK — ${target.label} validates clean\n`);
    return 0;
  }

  for (const f of findings) {
    const tag = f.level === "error" ? "ERROR" : "WARN ";
    process.stderr.write(`  ${tag}  ${f.message}\n`);
  }
  process.stderr.write(`\n${errors.length} error(s), ${warnings.length} warning(s) in ${target.label}\n`);

  if (errors.length > 0) return 1;
  return 2;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`subctl policy validate: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Silence the unused import warning if any. Kept the dirname import for
// potential relative-path resolution we'll need when the schema lookup grows.
void dirname;
void homedir;
