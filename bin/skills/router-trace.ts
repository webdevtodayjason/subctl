#!/usr/bin/env bun
// bin/skills/router-trace.ts
//
// v2.8.1 — Run the master's skill router against a sample operator
// message and print the scoring breakdown. Useful for tuning the
// keyword + description scoring weights without restarting master.
//
// Usage: subctl skills router-trace "operator message text here"
//
// Reads the in-repo skill catalog (components/skills/*/SKILL.md), runs
// the live router code (so behavior matches master at runtime), and
// dumps a human-readable trace to stdout.

import {
  selectSkills,
  isRouterEnabled,
  _clearCacheForTesting,
} from "../../components/master/skill-router";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log(`subctl skills router-trace <message...>

  Score the in-repo skill catalog against a sample operator message and
  print which skills the router would preload into Evy's system prompt.
  Reports keyword + description token matches per skill.

  Honors the runtime feature flag at ~/.config/subctl/skill-router.enabled.
  When the flag is absent the router is "off" and selectSkills() returns
  an empty set — pass --force to score the catalog anyway.

Options:
  --force      Score even if the runtime flag file is absent.
  --top <K>    Top-K candidates above the always-load floor. Default 2.
  --cwd <dir>  Override cwd for ecosystem detection. Default process.cwd().
`);
  process.exit(args.length === 0 ? 1 : 0);
}

let force = false;
let topK = 2;
let cwd = process.cwd();
const msgParts: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--force") force = true;
  else if (a === "--top") topK = parseInt(args[++i] ?? "2", 10);
  else if (a === "--cwd") cwd = args[++i] ?? process.cwd();
  else msgParts.push(a);
}
const message = msgParts.join(" ").trim();
if (!message) {
  console.error("error: message text required");
  process.exit(1);
}

_clearCacheForTesting();

if (force) {
  // Trick the router into believing the flag exists by pointing it at
  // a tmp file we just touched. Simpler than threading a "force"
  // boolean through the public API.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "skill-router-trace-"));
  const flag = join(dir, "skill-router.enabled");
  writeFileSync(flag, "true");
  const decision = selectSkills(message, { cwd, flagPath: flag }, { topK });
  printDecision(decision);
} else {
  const enabled = isRouterEnabled();
  if (!enabled) {
    console.log("router: DISABLED (no flag file at ~/.config/subctl/skill-router.enabled)");
    console.log("  → master is using the legacy single-skill prompt path");
    console.log("  → re-run with --force to see what routing WOULD pick");
    process.exit(0);
  }
  const decision = selectSkills(message, { cwd }, { topK });
  printDecision(decision);
}

interface Trace { skill: string; score: number; matchedKeywords: string[]; matchedDescTokens: string[]; }
interface Decision { enabled: boolean; selected: Array<{ name: string }>; trace: Trace[]; reason: string; }

function printDecision(d: Decision) {
  console.log(`message:  "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`);
  console.log(`cwd:      ${cwd}`);
  console.log(`enabled:  ${d.enabled}`);
  console.log(`reason:   ${d.reason}`);
  console.log("");
  console.log(`selected (${d.selected.length}):`);
  for (const s of d.selected) console.log(`  + ${s.name}`);
  console.log("");
  console.log(`scoring trace (sorted by score desc):`);
  for (const t of d.trace) {
    const kw = t.matchedKeywords.length > 0 ? ` kw=[${t.matchedKeywords.join(",")}]` : "";
    const dt = t.matchedDescTokens.length > 0 ? ` desc=[${t.matchedDescTokens.slice(0, 5).join(",")}]` : "";
    console.log(`  ${String(t.score).padStart(3)}  ${t.skill}${kw}${dt}`);
  }
}
