#!/usr/bin/env bun
// bin/policy/snapshot.ts
//
// `subctl policy snapshot <team> --show | --verify | --rewrite`
//
// Per pack 07 §8.
//   --show     prints the snapshot file verbatim
//   --verify   re-computes the allowlist sha + compares against the header
//              (use case: detect snapshot tampering or stale-after-edit)
//   --rewrite  re-resolves the current policy chain for the team's project
//              and rewrites the snapshot. Rare; useful after a policy edit
//              when re-spawning the worker is undesirable.
//
// We use the existing writers/readers in `components/master/tools/policy/snapshot.ts`
// so the path resolution + header format stay in lockstep.

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { computeAllowlistSha } from "../../components/master/tools/policy/load";
import {
  getSnapshotPath,
  readPolicySnapshot,
  writePolicySnapshot,
} from "../../components/master/tools/policy/snapshot";

type Action = "show" | "verify" | "rewrite";

interface Args {
  team: string | null;
  action: Action | null;
  projectRoot: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { team: null, action: null, projectRoot: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--show") {
      setAction(out, "show");
    } else if (a === "--verify") {
      setAction(out, "verify");
    } else if (a === "--rewrite") {
      setAction(out, "rewrite");
    } else if (a === "--project-root") {
      const next = argv[++i];
      if (!next) die(`${a} requires an argument`);
      out.projectRoot = next;
    } else if (a.startsWith("--project-root=")) {
      out.projectRoot = a.slice("--project-root=".length);
    } else if (!a.startsWith("-")) {
      if (out.team !== null) die(`unexpected positional: ${a}`);
      out.team = a;
    } else {
      die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function setAction(out: Args, action: Action): void {
  if (out.action !== null && out.action !== action) {
    die(`only one of --show / --verify / --rewrite may be used`);
  }
  out.action = action;
}

function die(msg: string): never {
  process.stderr.write(`subctl policy snapshot: ${msg}\n`);
  process.exit(1);
}

function help(): void {
  process.stdout.write(`subctl policy snapshot <team_id> [--show | --verify | --rewrite] [--project-root=<dir>]

Inspect or rewrite a team's policy snapshot at
~/.local/state/subctl/teams/<team_id>/policy.snapshot.toml
(honors SUBCTL_STATE_DIR).

Actions:
  --show       print the current snapshot file verbatim (default)
  --verify     re-compute the allowlist sha against the body, compare to header
  --rewrite    re-resolve the policy for --project-root, rewrite the snapshot
               (rare; preserves the team's current mode)

  --project-root <dir>   required with --rewrite; the project to re-resolve
                         policy for

Exit codes:
  0   success (or --verify match)
  1   error / snapshot missing / --verify mismatch
`);
}

async function doShow(team: string): Promise<number> {
  const path = getSnapshotPath(team);
  if (!existsSync(path)) {
    process.stderr.write(`subctl policy snapshot: no snapshot at ${path}\n`);
    return 1;
  }
  try {
    process.stdout.write(readFileSync(path, "utf8"));
  } catch (err) {
    process.stderr.write(`subctl policy snapshot: read failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return 0;
}

async function doVerify(team: string): Promise<number> {
  const path = getSnapshotPath(team);
  if (!existsSync(path)) {
    process.stderr.write(`subctl policy snapshot: no snapshot at ${path}\n`);
    return 1;
  }
  let parsed: Awaited<ReturnType<typeof readPolicySnapshot>>;
  try {
    parsed = await readPolicySnapshot(team);
  } catch (err) {
    process.stderr.write(`subctl policy snapshot: parse failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!parsed) {
    process.stderr.write(`subctl policy snapshot: snapshot not found\n`);
    return 1;
  }
  // Apply the snapshot's recorded mode override so the recomputed sha
  // matches the exact override the writer used (see snapshot.ts:107-115).
  const overridden = { ...parsed.policy, default_mode: parsed.meta.mode };
  const recomputed = computeAllowlistSha(overridden);
  if (recomputed !== parsed.meta.allowlistSha) {
    process.stderr.write(
      `subctl policy snapshot: VERIFY FAILED — header says allowlist_sha=${parsed.meta.allowlistSha} but body re-hashes to ${recomputed}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `OK — ${parsed.meta.snapshotPath}\n  team_id=${parsed.meta.teamId}\n  mode=${parsed.meta.mode}\n  spawned_at=${parsed.meta.spawnedAt}\n  allowlist_sha=${parsed.meta.allowlistSha} (matches body hash)\n`,
  );
  return 0;
}

async function doRewrite(team: string, projectRoot: string | null): Promise<number> {
  // Mode is preserved from the existing snapshot (the spawn-time mode is
  // immutable for the life of the worker; rewriting must not silently change
  // it). Re-resolve project root from existing snapshot's source_paths[0]
  // when no --project-root was provided.
  const existing = await readPolicySnapshot(team).catch(() => null);
  if (!existing) {
    process.stderr.write(`subctl policy snapshot: cannot --rewrite (no existing snapshot for team "${team}")\n`);
    return 1;
  }
  let root = projectRoot;
  if (!root) {
    const first = existing.meta.sourcePaths.find((p) => p.endsWith("/.subctl/policy.toml") || p.endsWith("/.subctl/policy.local.toml"));
    if (first) {
      // strip "/.subctl/policy(.local)?.toml"
      root = first.replace(/\/\.subctl\/policy(\.local)?\.toml$/, "");
    }
  }
  if (!root) {
    process.stderr.write(`subctl policy snapshot: --rewrite needs --project-root (no project policy file in existing snapshot's source_paths)\n`);
    return 1;
  }
  try {
    const meta = await writePolicySnapshot(team, root, existing.meta.mode);
    process.stdout.write(
      `OK — rewrote ${meta.snapshotPath}\n  mode=${meta.mode}\n  allowlist_sha=${meta.allowlistSha}\n  prior snapshot moved to ${meta.snapshotPath}.old\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`subctl policy snapshot: rewrite failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return 0;
  }
  if (!args.team) {
    process.stderr.write(`subctl policy snapshot: team_id required\n`);
    return 1;
  }
  const action: Action = args.action ?? "show";
  switch (action) {
    case "show":    return doShow(args.team);
    case "verify":  return doVerify(args.team);
    case "rewrite": return doRewrite(args.team, args.projectRoot);
  }
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`subctl policy snapshot: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
