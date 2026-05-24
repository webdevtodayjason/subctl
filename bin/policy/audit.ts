#!/usr/bin/env bun
// bin/policy/audit.ts
//
// `subctl policy audit <team>` — read a team's policy audit log.
//
// Per pack 07 §7. The log itself is written by the Go binary (PR 8 `audit.go`)
// and by `components/evy/tools/policy/audit.ts` (PR 7). This reader honors
// the same SUBCTL_STATE_DIR convention so dev environments and tests can point
// at fixture directories.
//
// Flags:
//   --tail=N            print only the last N entries (default 20)
//   --decisions=allow|deny|all     filter by decision (default all)
//   --since=<duration>  e.g. "1h", "30m", "2d" — only entries newer than that
//   --jsonl             raw passthrough (one JSON object per line)
//   --csv               CSV with ts,decision,rule,command
//
// Exit codes:
//   0 = success (zero or more entries printed)
//   1 = log file not found OR error reading

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

interface Args {
  team: string | null;
  tail: number;
  decisions: "allow" | "deny" | "all";
  sinceMs: number | null;
  format: "human" | "jsonl" | "csv";
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    team: null,
    tail: 20,
    decisions: "all",
    sinceMs: null,
    format: "human",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--jsonl") {
      out.format = "jsonl";
    } else if (a === "--csv") {
      out.format = "csv";
    } else if (a === "--tail") {
      const next = argv[++i];
      out.tail = parsePositiveInt(next, "--tail");
    } else if (a.startsWith("--tail=")) {
      out.tail = parsePositiveInt(a.slice("--tail=".length), "--tail");
    } else if (a === "--decisions") {
      out.decisions = parseDecisionFilter(argv[++i]);
    } else if (a.startsWith("--decisions=")) {
      out.decisions = parseDecisionFilter(a.slice("--decisions=".length));
    } else if (a === "--since") {
      out.sinceMs = parseDurationMs(argv[++i]);
    } else if (a.startsWith("--since=")) {
      out.sinceMs = parseDurationMs(a.slice("--since=".length));
    } else if (!a.startsWith("-")) {
      if (out.team !== null) die(`unexpected positional: ${a}`);
      out.team = a;
    } else {
      die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function parsePositiveInt(s: string | undefined, flag: string): number {
  if (!s) die(`${flag} requires an integer`);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    die(`${flag} must be a positive integer (got: ${s})`);
  }
  return n;
}

function parseDecisionFilter(s: string | undefined): "allow" | "deny" | "all" {
  if (!s) die(`--decisions requires a value (allow|deny|all)`);
  if (s === "allow" || s === "deny" || s === "all") return s;
  die(`--decisions must be allow|deny|all (got: ${s})`);
}

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)$/;
function parseDurationMs(s: string | undefined): number {
  if (!s) die(`--since requires a duration (e.g. 1h, 30m, 2d)`);
  const m = s.match(DURATION_RE);
  if (!m) die(`--since: bad duration "${s}" (use forms like 30s, 5m, 2h, 1d)`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
  }
  die(`--since: unreachable`);
}

function die(msg: string): never {
  process.stderr.write(`subctl policy audit: ${msg}\n`);
  process.exit(1);
}

function help(): void {
  process.stdout.write(`subctl policy audit <team_id> [flags]

Read the policy audit log for a team. Honors SUBCTL_STATE_DIR
(default: ~/.local/state/subctl/audit/<team_id>.jsonl).

Flags:
  --tail=N           print only the last N entries (default 20)
  --decisions=X      filter (allow|deny|all; default all)
  --since=DUR        only entries newer than DUR (e.g. 1h, 30m, 2d)
  --jsonl            raw JSONL passthrough (one row per line)
  --csv              CSV: ts,decision,rule,command
  -h, --help         show this help
`);
}

// ---------------------------------------------------------------------------
// State dir resolution — mirrors components/evy/tools/policy/audit.ts
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  return process.env.SUBCTL_STATE_DIR ?? join(homedir(), ".local", "state", "subctl");
}

function getAuditLogPath(teamId: string): string {
  return join(resolveStateDir(), "audit", `${teamId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Read + filter
// ---------------------------------------------------------------------------

interface RawEntry {
  ts?: string;
  team_id?: string;
  mode?: string;
  command?: string;
  decision?: string;
  rule?: string;
  rule_path?: string;
  event_type?: string;
  allowlist_sha?: string;
}

function readEntries(path: string): RawEntry[] {
  const text = readFileSync(path, "utf8");
  const out: RawEntry[] = [];
  for (const ln of text.split("\n")) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawEntry);
    } catch {
      // Skip malformed lines — better to render the recoverable rows than to
      // bail on a single bad write.
    }
  }
  return out;
}

function filterEntries(rows: RawEntry[], args: Args): RawEntry[] {
  let out = rows;
  if (args.decisions !== "all") {
    out = out.filter((r) => r.decision === args.decisions);
  }
  if (args.sinceMs !== null) {
    const cutoffMs = Date.now() - args.sinceMs;
    out = out.filter((r) => {
      if (!r.ts) return false;
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoffMs;
    });
  }
  // tail
  if (out.length > args.tail) {
    out = out.slice(out.length - args.tail);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderJsonl(rows: RawEntry[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCsv(rows: RawEntry[]): string {
  let out = "ts,decision,rule,command\n";
  for (const r of rows) {
    const parts = [r.ts ?? "", r.decision ?? "", r.rule ?? "", r.command ?? ""].map(csvEscape);
    out += parts.join(",") + "\n";
  }
  return out;
}

function renderHuman(rows: RawEntry[]): string {
  if (rows.length === 0) return "(no entries match)\n";
  let out = "ts                       decision  command\n";
  for (const r of rows) {
    const ts = (r.ts ?? "").replace("T", " ").slice(0, 23);
    const decision = (r.decision ?? "?").padEnd(8, " ");
    const cmd = r.command && r.command.length > 0 ? r.command : `(${r.event_type ?? "event"})`;
    out += `${ts.padEnd(24, " ")} ${decision}  ${cmd}\n`;
    if (r.decision === "deny" && r.rule) {
      out += `                         rule: ${r.rule}\n`;
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
  if (!args.team) {
    process.stderr.write(`subctl policy audit: team_id required (usage: subctl policy audit <team_id>)\n`);
    return 1;
  }
  const path = getAuditLogPath(args.team);
  if (!existsSync(path)) {
    process.stderr.write(`subctl policy audit: no audit log at ${path}\n`);
    return 1;
  }
  let rows: RawEntry[];
  try {
    rows = readEntries(path);
  } catch (err) {
    process.stderr.write(`subctl policy audit: read failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const filtered = filterEntries(rows, args);
  switch (args.format) {
    case "jsonl":
      process.stdout.write(renderJsonl(filtered));
      break;
    case "csv":
      process.stdout.write(renderCsv(filtered));
      break;
    case "human":
      process.stdout.write(renderHuman(filtered));
      break;
  }
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`subctl policy audit: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
