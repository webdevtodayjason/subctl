#!/usr/bin/env bun
// providers/claude/_write_snapshot.ts
//
// Tiny CLI bridge invoked by `providers/claude/policy.sh` at spawn time.
// Calls PR 7's `writePolicySnapshot` + `writeAuditHeader` and prints the
// resulting metadata as a single JSON object on stdout, which bash captures
// and parses with jq.
//
// Why a separate script instead of an inline `bun -e`:
//   1. Argument quoting through `bun -e` is fragile for absolute paths with
//      spaces. A file-backed script with explicit --flag=value parsing is
//      robust.
//   2. The bash spawn flow is already paying the bun-startup cost once for
//      this step; folding the audit-header write into the same invocation
//      avoids a second cold-start.
//   3. Testable in isolation via `bun run` — the integration suite invokes it
//      directly to verify metadata round-trip.
//
// This script is OUT of the policy gate's critical path at runtime — it runs
// once at spawn time, before tmux. Latency targets here are operator-facing
// (sub-second), not hot-path. Per pack 08 §2.4 the snapshot is "load-bearing"
// — the hook reads from it on every command — so we fail loud (non-zero exit
// + stderr) if anything goes wrong rather than silently producing a worker
// with no snapshot file.

import process from "node:process";

import { writeAuditHeader } from "../../components/master/tools/policy/audit";
import { writePolicySnapshot } from "../../components/master/tools/policy/snapshot";

interface ParsedArgs {
  team: string;
  projectRoot: string;
  mode: "trusted" | "gated" | "sealed";
}

function die(msg: string): never {
  process.stderr.write(`_write_snapshot: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  let team: string | null = null;
  let projectRoot: string | null = null;
  let mode: string | null = null;

  for (const raw of argv) {
    const eq = raw.indexOf("=");
    if (eq < 0) die(`unexpected argument: ${raw}`);
    const key = raw.slice(0, eq);
    const val = raw.slice(eq + 1);
    switch (key) {
      case "--team":          team = val; break;
      case "--project-root":  projectRoot = val; break;
      case "--mode":          mode = val; break;
      default:                die(`unknown flag: ${key}`);
    }
  }

  if (!team) die("--team=<id> is required");
  if (!projectRoot) die("--project-root=<dir> is required");
  if (!mode) die("--mode=<trusted|gated|sealed> is required");
  if (mode !== "trusted" && mode !== "gated" && mode !== "sealed") {
    die(`invalid --mode value: ${mode}`);
  }

  return { team, projectRoot, mode };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Write the immutable policy snapshot. This rotates any prior snapshot
  //    to `.snapshot.toml.old` (one generation of forensics per pack 02 §8).
  const meta = await writePolicySnapshot(args.team, args.projectRoot, args.mode);

  // 2. Emit the audit-log header line so readers can group entries by spawn
  //    boundary (pack 09 §3.1). `appendAuditEntry` is fail-open per pack 09
  //    §4 — if the audit dir is unwritable the header write quietly bumps a
  //    counter rather than failing the spawn. The snapshot is what's
  //    load-bearing for the gate; the audit log is supplementary.
  await writeAuditHeader(args.team, args.mode, meta.allowlistSha);

  // 3. Emit metadata for bash to consume. Single-line JSON on stdout so the
  //    consumer can pipe through jq without worrying about pretty-printing.
  process.stdout.write(
    JSON.stringify({
      team_id: meta.teamId,
      project_root: meta.projectRoot,
      mode: meta.mode,
      spawned_at: meta.spawnedAt,
      source_paths: meta.sourcePaths,
      allowlist_sha: meta.allowlistSha,
      snapshot_path: meta.snapshotPath,
    }) + "\n",
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  process.stderr.write(`_write_snapshot: ${msg}\n`);
  process.exit(1);
});
