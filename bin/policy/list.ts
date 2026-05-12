#!/usr/bin/env bun
// bin/policy/list.ts
//
// `subctl policy list` — show the resolved policy for a project.
//
// Per pack 07 §4. Two output modes:
//   - default human-readable summary (table-ish with section headers)
//   - `--json` returns the full PolicyDocument as JSON (consumed by the
//     dashboard's Policy panel per PR 11)
//
// The resolution work is done by `loadResolvedPolicy` (PR 4). This file is
// just a presentation layer + argv parser.

import process from "node:process";

import { loadResolvedPolicy } from "../../components/master/tools/policy/load";
import type { GatedMode, PolicyDocument, SealedMode } from "../../components/master/tools/policy/types";

interface Args {
  projectRoot: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    projectRoot: process.cwd(),
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--project-root" || a === "--project") {
      const next = argv[++i];
      if (!next) die(`${a} requires an argument`);
      out.projectRoot = next;
    } else if (a.startsWith("--project-root=")) {
      out.projectRoot = a.slice("--project-root=".length);
    } else if (!a.startsWith("-")) {
      // Bare positional: treat as project root.
      out.projectRoot = a;
    } else {
      die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function help(): void {
  process.stdout.write(`subctl policy list [path] [--json]

Show the fully resolved policy for a project (merged from .subctl/policy.toml,
~/.config/subctl/policy.toml, the named preset, and shipped defaults).

Flags:
  --project-root <dir>   Path to the project root. Defaults to cwd.
  --json                 Emit full PolicyDocument as JSON (dashboard format).
  -h, --help             Show this help.

A bare positional arg is treated as the project root.
`);
}

function die(msg: string): never {
  process.stderr.write(`subctl policy list: ${msg}\n`);
  process.exit(1);
}

function renderJson(policy: PolicyDocument, projectRoot: string): string {
  // The dashboard consumes this verbatim (per pack 07 §4 + PR 11).
  // Field names match policy_list master tool output for forward-compat.
  const out = {
    project_root: projectRoot,
    preset: policy.preset,
    default_mode: policy.default_mode ?? "gated",
    source_paths: policy.__meta?.sourcePaths ?? [],
    allowlist_sha: policy.__meta?.allowlistSha ?? "",
    resolved_at: policy.__meta?.resolvedAt,
    mode: {
      gated: policy.mode?.gated,
      sealed: policy.mode?.sealed,
    },
  };
  return JSON.stringify(out, null, 2) + "\n";
}

function fmtList(items: string[] | undefined, indent = "    "): string {
  if (!items || items.length === 0) return `${indent}(none)\n`;
  // Soft-wrap at ~70 chars per line so long lists stay readable.
  const lines: string[] = [];
  let current = indent;
  for (let i = 0; i < items.length; i++) {
    const piece = items[i] + (i < items.length - 1 ? ", " : "");
    if (current.length + piece.length > 78 && current.trim().length > 0) {
      lines.push(current.trimEnd());
      current = indent;
    }
    current += piece;
  }
  if (current.trim().length > 0) lines.push(current.trimEnd());
  return lines.join("\n") + "\n";
}

function renderGated(g: GatedMode | undefined): string {
  if (!g) return "  (not configured)\n";
  let out = "";

  const cmds = g.allow?.commands;
  out += `  allow.commands (${cmds?.length ?? 0}):\n`;
  out += fmtList(cmds);

  const aps = g.allow_pattern ?? [];
  out += `  allow_pattern (${aps.length}):\n`;
  if (aps.length === 0) {
    out += "    (none)\n";
  } else {
    for (let i = 0; i < aps.length; i++) {
      const ap = aps[i];
      const args = ap.args && ap.args.length > 0 ? ap.args.join("|") : "(any)";
      let line = `    [${String(i).padStart(2, " ")}] ${ap.command}  ${args}`;
      if (ap.deny_if_arg_contains && ap.deny_if_arg_contains.length > 0) {
        line += `   (deny_if: ${ap.deny_if_arg_contains.join(", ")})`;
      }
      out += line + "\n";
    }
  }

  const subs = g.deny_always?.substrings;
  out += `  deny_always.substrings (${subs?.length ?? 0}):\n`;
  out += fmtList(subs);

  const regex = g.deny_always?.regex;
  out += `  deny_always.regex (${regex?.length ?? 0}):\n`;
  out += fmtList(regex);

  // Ecosystem tables: only render those that are set.
  const ecoRows: Array<[string, string[] | undefined]> = [
    ["npm.allowed_scripts", g.npm?.allowed_scripts],
    ["pnpm.allowed_scripts", g.pnpm?.allowed_scripts],
    ["bun.allowed_scripts", g.bun?.allowed_scripts],
    ["yarn.allowed_scripts", g.yarn?.allowed_scripts],
    ["make.allowed_targets", g.make?.allowed_targets],
    ["just.allowed_recipes", g.just?.allowed_recipes],
    ["python_modules.allowed", g.python_modules?.allowed],
    ["uv.allowed_run_targets", g.uv?.allowed_run_targets],
    ["poetry.allowed_run_targets", g.poetry?.allowed_run_targets],
  ];
  for (const [name, items] of ecoRows) {
    if (!items) continue;
    out += `  ${name} (${items.length}):\n`;
    out += fmtList(items);
  }
  return out;
}

function renderSealed(s: SealedMode | undefined): string {
  if (!s) return "  (not configured)\n";
  let out = "";
  out += `  mcp_tools (${s.mcp_tools?.length ?? 0}):\n`;
  out += fmtList(s.mcp_tools);
  if (s.test_command) {
    out += `  test_command:    ${JSON.stringify(s.test_command)}\n`;
  }
  if (s.escalation) {
    out += `  escalation:      target=${s.escalation.target} require_approval=${s.escalation.require_approval} timeout_seconds=${s.escalation.timeout_seconds}\n`;
  }
  return out;
}

function renderHuman(policy: PolicyDocument, projectRoot: string): string {
  let out = "";
  out += `project:       ${projectRoot}\n`;
  out += `preset:        ${policy.preset ?? "(none)"}\n`;
  out += `default_mode:  ${policy.default_mode ?? "gated"}\n`;
  out += `allowlist_sha: ${policy.__meta?.allowlistSha ?? "(unset)"}\n`;
  out += `\nsource paths (highest priority first):\n`;
  const paths = policy.__meta?.sourcePaths ?? [];
  if (paths.length === 0) {
    out += "  (none)\n";
  } else {
    for (const p of paths) out += `  ${p}\n`;
  }
  out += `\nmode.gated:\n`;
  out += renderGated(policy.mode?.gated);
  out += `\nmode.sealed:\n`;
  out += renderSealed(policy.mode?.sealed);
  // Trusted has no per-mode config (intentional empty interface).
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return 0;
  }

  let policy: PolicyDocument;
  try {
    policy = await loadResolvedPolicy(args.projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`subctl policy list: ${msg}\n`);
    return 1;
  }

  if (args.json) {
    process.stdout.write(renderJson(policy, args.projectRoot));
  } else {
    process.stdout.write(renderHuman(policy, args.projectRoot));
  }
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`subctl policy list: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
