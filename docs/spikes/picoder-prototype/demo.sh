#!/usr/bin/env bash
# docs/spikes/picoder-prototype/demo.sh
#
# SPIKE PROTOTYPE — end-to-end demo of the pi-coder pattern.
# NOT PRODUCT CODE. Lives under docs/spikes/, not destined to ship.
#
# Wires up picoder-worker.ts + evy-emit.ts in a temp dir, sends one
# signed directive, and shows that:
#
#   Q1. The worker verified the HMAC and processed the SPEC body.
#   Q2. The worker emitted classifier-friendly pane text.
#   Q4. The worker wrote a progress + done event to the inbox.
#
# After the run we ALSO try a tampered directive to prove the worker
# refuses it. That's the empirical answer to "can the channel be gamed?"
# — if our prototype refuses a bad-HMAC directive, the structural answer
# is no.
#
# Run:
#   cd docs/spikes/picoder-prototype && bash demo.sh
#
# Output lives in /tmp/picoder-demo. Inspect:
#   cat /tmp/picoder-demo/master-state/inbox/picoder-demo.jsonl
#   cat /tmp/picoder-demo/teams/picoder-demo/directives.jsonl
#   cat /tmp/picoder-demo/worker.log

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR=/tmp/picoder-demo
TEAM_ID=picoder-demo

rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

export SUBCTL_STATE_DIR="$DEMO_DIR"
export SUBCTL_TEAM_INBOX_DIR="$DEMO_DIR/master-state/inbox"
export SUBCTL_TEAM_ID="$TEAM_ID"

echo "==> SUBCTL_STATE_DIR=$SUBCTL_STATE_DIR"
echo "==> SUBCTL_TEAM_INBOX_DIR=$SUBCTL_TEAM_INBOX_DIR"
echo "==> TEAM_ID=$TEAM_ID"

# Bootstrap the team's HMAC secret BEFORE starting the worker so verify
# can resolve it on the first directive. Production does this in
# providers/<provider>/teams.sh at spawn time.
echo
echo "==> seeding HMAC secret via ensureSecret(\"$TEAM_ID\")"
bun -e "
import { ensureSecret } from '$HERE/../../../components/master/trust-marker';
const s = ensureSecret('$TEAM_ID');
console.log('  secret length =', s.length, '(64 hex chars expected)');
"

# Start the worker in the background, redirecting its output to a log
# the demo can inspect afterwards. In production this would be in a
# tmux pane that the operator (or watchdog's capture-pane) can read.
echo
echo "==> starting picoder-worker.ts in background"
bun run "$HERE/picoder-worker.ts" > "$DEMO_DIR/worker.log" 2>&1 &
WORKER_PID=$!
trap 'kill $WORKER_PID 2>/dev/null || true' EXIT

# Give it a beat to attach fs.watch.
sleep 0.5

echo
echo "==> Q1 + Q2 + Q4: emit one good directive and watch what happens"
bun run "$HERE/evy-emit.ts" "$TEAM_ID" "investigate" \
  "Audit token usage in components/master/server.ts and report top 3 hotspots"

# Wait for the worker to process. 1.5s is enough for the 200ms simulated
# work + the inbox write + a heartbeat tick or two.
sleep 1.5

echo
echo "==> Q1 negative case: emit a TAMPERED directive and prove the worker refuses"
# Build a valid directive, then mutate one character of the body so the
# HMAC no longer covers what arrived. This is the canonical man-in-the-middle
# attack the trust-marker exists to defeat.
bun -e "
import { ensureSecret, buildSignedDirective } from '$HERE/../../../components/master/trust-marker';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
ensureSecret('$TEAM_ID');
const signed = buildSignedDirective({
  teamId: '$TEAM_ID',
  phase: 'tamper-test',
  body: 'original body bytes that master signed',
});
const teamDir = join('$DEMO_DIR', 'teams', '$TEAM_ID');
mkdirSync(teamDir, { recursive: true });
// Substitute a different body — master never signed THIS one.
const tamperedBody = signed.signedBody.replace('original', 'TAMPERED');
appendFileSync(join(teamDir, 'directives.jsonl'),
  JSON.stringify({ marker: signed.marker, body: tamperedBody }) + '\n');
console.log('  tampered directive emitted (marker valid; body altered post-sign)');
"

sleep 1.5

echo
echo "==> worker.log ──────────────────────────────────────────────────────────"
cat "$DEMO_DIR/worker.log"

echo
echo "==> inbox.jsonl ─────────────────────────────────────────────────────────"
cat "$SUBCTL_TEAM_INBOX_DIR/$TEAM_ID.jsonl"

echo
echo "==> classifier sanity check (run the real classifier over the pane text)"
bun -e "
import { classifyWorkerReply } from '$HERE/../../../components/master/auto-nudge';
import { readFileSync } from 'node:fs';
const text = readFileSync('$DEMO_DIR/worker.log', 'utf8');
// Take last 50 lines (mirror master's capture-pane window).
const tail = text.split('\n').slice(-50).join('\n');
const c = classifyWorkerReply(tail);
console.log('  classification.kind   =', c.kind);
console.log('  classification.snippet=', JSON.stringify(c.snippet.slice(0, 120)));
"

echo
echo "==> done. Demo dir preserved at $DEMO_DIR for inspection."
