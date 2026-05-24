// docs/spikes/picoder-prototype/master-emit.ts
//
// SPIKE PROTOTYPE — synthetic master-side emitter for the pi-coder demo.
// NOT PRODUCT CODE. Throwaway companion to picoder-worker.ts.
//
// Stands in for what Evy would do today via the dashboard's
// /api/orchestration/<team>/msg route: build a signed directive using the
// REAL trust-marker module, then write {marker, body} as a JSONL line into
// the worker's directives file. The worker (picoder-worker.ts) verifies
// HMAC + SPEC and processes.
//
// Differences from production:
//   - Production master pastes the wireFormat into tmux. This emitter
//     writes to a file instead — that IS the Q1 design choice the spike
//     proposes. See docs/spikes/picoder.md §Q1.
//   - Production master reads the team's hmac.secret that providers/...
//     teams.sh wrote at spawn. We call ensureSecret() here so the demo is
//     self-contained.
//
// USAGE:
//   SUBCTL_STATE_DIR=/tmp/picoder-demo \
//   bun run master-emit.ts <team_id> <phase> <body...>
//
// Example:
//   bun run master-emit.ts picoder-demo investigate \
//     "Audit token usage in components/master/server.ts and report top 3 hotspots"

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ensureSecret,
  buildSignedDirective,
} from "../../../components/master/trust-marker";

const [, , teamId, phase, ...bodyParts] = process.argv;
if (!teamId || !phase || bodyParts.length === 0) {
  console.error("usage: bun run master-emit.ts <team_id> <phase> <body...>");
  process.exit(2);
}

const body = bodyParts.join(" ");

// Ensure the secret exists. In production teams.sh does this at spawn.
ensureSecret(teamId);

const signed = buildSignedDirective({ teamId, phase, body });

const stateDir = process.env.SUBCTL_STATE_DIR ?? "";
if (!stateDir) {
  console.error("SUBCTL_STATE_DIR is required for the demo (we don't want to write into ~/.local/state/subctl)");
  process.exit(2);
}

const teamDir = join(stateDir, "teams", teamId);
mkdirSync(teamDir, { recursive: true });
const directivesPath = join(teamDir, "directives.jsonl");

const line = JSON.stringify({
  marker: signed.marker,
  body: signed.signedBody,
}) + "\n";
appendFileSync(directivesPath, line);

console.log(`emitted directive → ${directivesPath}`);
console.log(`  phase=${phase}`);
console.log(`  ts=${signed.ts}`);
console.log(`  hmac=${signed.hmac}`);
console.log(`  body_chars=${signed.signedBody.length}`);
