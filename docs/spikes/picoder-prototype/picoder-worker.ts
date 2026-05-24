// docs/spikes/picoder-prototype/picoder-worker.ts
//
// SPIKE PROTOTYPE — pi-coder worker pattern (Phase 5, v3.0).
// NOT PRODUCT CODE. Throwaway, lives under docs/spikes/, exists to answer
// the v3.0 Initiative's "Phase 5 — pi-coder spike" open questions Q1/Q2/Q4
// in a runnable form.
//
// This script demonstrates that a single Bun process — the kind we'd spawn
// for a chat-API-compatible subscription like ZAI/GLM, Minimax, OpenRouter
// routes, or local LM Studio — can:
//
//   Q1. RECEIVE HMAC-signed directives from Evy using subctl's EXISTING
//       trust-marker contract (no new auth surface).
//   Q2. EMIT pane output that subctl's EXISTING regex classifier reads
//       (classifyWorkerReply in components/evy/auto-nudge.ts).
//   Q4. WRITE inbox events DIRECTLY to the team inbox.jsonl using the
//       SAME shape Claude Code workers produce via the team_inbox tool.
//
// The script reuses subctl's trust-marker module by relative import so
// the wire format stays byte-identical to what master emits today. If
// pi-coder ever ships as a real worker type, this file is the seed.
//
// USAGE (see demo.sh for the full end-to-end run):
//   SUBCTL_STATE_DIR=/tmp/picoder-demo \
//   SUBCTL_TEAM_ID=picoder-demo \
//   SUBCTL_TEAM_INBOX_DIR=/tmp/picoder-demo/master-state/inbox \
//   bun run picoder-worker.ts
//
// The worker watches $SUBCTL_STATE_DIR/teams/<team_id>/directives.jsonl
// for new lines. Each line is {marker: "...", body: "..."} as JSON.
// Lines that verify are processed; lines that don't are logged to stderr
// and discarded (in production, would be escalated via the inbox).
//
// Why JSONL on disk instead of stdin?
//   - tmux already owns the pane's stdin; piping over it would require a
//     control-pane setup that competes with the operator attaching for
//     debugging. A file is observable from outside the pane (operator
//     can `cat` it) and survives worker restarts.
//   - fs.watch + a deterministic offset on the file gives us at-most-once
//     delivery without a queue daemon.
//   - The directives file lives under SUBCTL_STATE_DIR/teams/<team_id>/
//     next to the existing hmac.secret — same dir, same chmod 600 perms,
//     same GC sweep (components/evy/team-gc.ts).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  statSync,
  watch,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// Relative-path import into the real trust-marker module. NOT a new
// dependency — we want the byte-identical verification logic. In a real
// pi-coder worker this would become an import from a shared subctl
// SDK package or a copy-vendored module; for the spike, the relative
// import proves the surfaces are compatible.
import {
  verifyDirectiveMarker,
  parseDirectiveMarker,
} from "../../../components/evy/trust-marker";

// ─── env + paths ─────────────────────────────────────────────────────────

const TEAM_ID = process.env.SUBCTL_TEAM_ID;
if (!TEAM_ID || !TEAM_ID.trim()) {
  console.error("[picoder] SUBCTL_TEAM_ID is required");
  process.exit(2);
}

const STATE_DIR =
  process.env.SUBCTL_STATE_DIR ??
  join(homedir(), ".local", "state", "subctl");
const TEAM_STATE_DIR = join(STATE_DIR, "teams", TEAM_ID);
const DIRECTIVES_PATH = join(TEAM_STATE_DIR, "directives.jsonl");

const INBOX_DIR =
  process.env.SUBCTL_TEAM_INBOX_DIR ??
  join(
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
    "evy",
    "state",
    "inbox",
  );
const INBOX_PATH = join(INBOX_DIR, `${TEAM_ID}.jsonl`);

mkdirSync(TEAM_STATE_DIR, { recursive: true });
mkdirSync(INBOX_DIR, { recursive: true });

// Touch directives file so fs.watch has something to attach to from boot.
if (!existsSync(DIRECTIVES_PATH)) {
  appendFileSync(DIRECTIVES_PATH, "");
}

// ─── Q2: classifier-friendly status output ────────────────────────────────
//
// classifyWorkerReply (components/evy/auto-nudge.ts) is a regex sweep
// over prose. The phrases that hit each kind are documented there:
//   completed_idle: /idle by design/, /task complete/, /done with task/...
//   blocked:        /stuck on/, /blocked on/, /can't proceed/
//   awaiting_input: /awaiting your/, /need clarification/, /what should i/
//   working:        anything else
//
// pi-coder needs to print these phrases verbatim for the watchdog to
// classify it correctly. We expose helpers that wrap the classification
// claim in human-readable language the regex matches.

function emitStatus(kind: "working" | "completed_idle" | "blocked" | "awaiting_input", detail: string) {
  switch (kind) {
    case "working":
      console.log(`[picoder] working on: ${detail}`);
      break;
    case "completed_idle":
      // Triggers /task complete/ AND /idle by design/.
      console.log(`[picoder] task complete — idle by design. ${detail}`);
      break;
    case "blocked":
      // Triggers /blocked on/.
      console.log(`[picoder] blocked on: ${detail}`);
      break;
    case "awaiting_input":
      // Triggers /awaiting your/.
      console.log(`[picoder] awaiting your decision: ${detail}`);
      break;
  }
}

// ─── Q4: inbox event emission ────────────────────────────────────────────
//
// Same shape master expects (server.ts:1874 TeamEvent + mcp/tools.ts:151):
//   { ts: ISO, type: "progress"|"blocked"|"done"|"error"|"note", text?: ... }
// Direct fs.appendFileSync — at the worker-side the JSONL append IS the
// SDK. The watchdog tails this file independently.

function emitInbox(type: "progress" | "blocked" | "done" | "error" | "note", text: string, extra: Record<string, unknown> = {}) {
  const ev = {
    ts: new Date().toISOString(),
    type,
    text,
    ...extra,
  };
  appendFileSync(INBOX_PATH, JSON.stringify(ev) + "\n");
}

// ─── Q1: directive intake + HMAC verification ────────────────────────────

let readOffset = 0;

interface DirectiveLine {
  marker: string;
  body: string;
}

function ingestPendingDirectives() {
  let stat;
  try {
    stat = statSync(DIRECTIVES_PATH);
  } catch {
    return;
  }
  if (stat.size <= readOffset) return;

  const fh = require("node:fs").openSync(DIRECTIVES_PATH, "r");
  const len = stat.size - readOffset;
  const buf = Buffer.allocUnsafe(len);
  require("node:fs").readSync(fh, buf, 0, len, readOffset);
  require("node:fs").closeSync(fh);
  readOffset = stat.size;

  const chunk = buf.toString("utf8");
  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: DirectiveLine;
    try {
      parsed = JSON.parse(line) as DirectiveLine;
    } catch (err) {
      console.error(`[picoder] discarding malformed directive line: ${(err as Error).message}`);
      continue;
    }
    handleDirective(parsed);
  }
}

function handleDirective(d: DirectiveLine) {
  if (typeof d.marker !== "string" || typeof d.body !== "string") {
    console.error(`[picoder] directive missing marker/body fields; discarding`);
    return;
  }
  // Reuse subctl's parser + verifier — byte-identical to what master signs.
  const parsedMarker = parseDirectiveMarker(d.marker);
  if (!parsedMarker) {
    console.error(`[picoder] directive marker malformed; discarding`);
    return;
  }
  const ok = verifyDirectiveMarker({
    teamId: TEAM_ID!,
    marker: d.marker,
    body: d.body,
  });
  if (!ok) {
    console.error(`[picoder] HMAC verification FAILED for ts=${parsedMarker.ts}; refusing`);
    emitInbox("error", "HMAC verification failed; refused directive", { ts_of_refused: parsedMarker.ts });
    return;
  }
  // Require SPEC block — identical contract to providers/claude/teams.sh:451.
  if (!/^SPEC:\n {2}/.test(d.body)) {
    console.error(`[picoder] directive missing SPEC block; refusing`);
    emitInbox("error", "directive missing SPEC block; refused", { ts_of_refused: parsedMarker.ts });
    return;
  }
  console.log(`[picoder] received signed directive (phase=${parsedMarker.phase ?? "(none)"} ts=${parsedMarker.ts})`);
  executeSpec(d.body, parsedMarker.phase);
}

function executeSpec(body: string, phase: string | null) {
  // In real life pi-coder would hand `body` to pi-agent-core's Agent.
  // For the spike, we just emit a progress event, "work" briefly, then
  // emit a completion. This proves the round-trip without dragging in
  // pi-agent-core's Agent + provider config.
  emitInbox("progress", `executing SPEC (phase=${phase ?? "(none)"})`);
  emitStatus("working", `phase=${phase ?? "(none)"}`);

  // Simulated work.
  setTimeout(() => {
    emitStatus("completed_idle", "no further directives pending");
    emitInbox("done", "SPEC executed successfully", { phase, body_chars: body.length });
  }, 200);
}

// ─── boot ────────────────────────────────────────────────────────────────

console.log(`[picoder] starting — team=${TEAM_ID}`);
console.log(`[picoder] watching directives: ${DIRECTIVES_PATH}`);
console.log(`[picoder] writing inbox to:   ${INBOX_PATH}`);
emitInbox("note", "picoder worker started", { team: TEAM_ID });

// On boot, jump past any pre-existing content (mirrors master's first-scan
// rule at server.ts:2720 — pre-existing content is HISTORICAL, not live).
readOffset = statSync(DIRECTIVES_PATH).size;

// fs.watch + poll fallback. fs.watch on macOS sometimes drops events on
// APFS, so we also poll every 2s as a safety net (mirrors master's inbox
// poll at server.ts:2895).
watch(DIRECTIVES_PATH, { persistent: true }, () => {
  ingestPendingDirectives();
});
setInterval(ingestPendingDirectives, 2000);

// Idle heartbeat so a stuck worker still shows up in pane capture.
setInterval(() => {
  // No-op log — keeps the pane from going completely silent so the
  // operator can tell the process is alive when attached.
  console.log(`[picoder] heartbeat ${new Date().toISOString()}`);
}, 30_000);
