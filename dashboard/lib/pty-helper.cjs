// dashboard/lib/pty-helper.cjs — v2.7.21 (ADR 0011 Layer 2)
//
// Sidecar process that owns the node-pty subprocess. The dashboard server
// (Bun) spawns this helper as a Node child for each WebSocket terminal
// session and shuttles bytes between the WS and the helper's stdio.
//
// Why a sidecar instead of using node-pty directly in Bun? Bun 1.2.x has a
// known fd-handling bug where read() on the pty master fd returns ENXIO
// even after a successful spawn (the prebuilt spawn-helper fork works, but
// the master-side read path doesn't). node-pty works perfectly under Node,
// so we run it there and use a Bun.spawn pipe to bridge to the WS.
//
// Wire format (helper STDIN, written by the parent Bun process):
//   Each frame is: 1 byte type | 4 bytes BE length | payload
//     type 0x01  DATA      payload = bytes the user typed (pty.write)
//     type 0x02  RESIZE    payload = ASCII "cols,rows" (e.g. "80,24")
//     type 0x03  CLOSE     payload empty — request graceful shutdown
//
// Wire format (helper STDOUT, read by the parent Bun process):
//   Each frame is: 1 byte type | 4 bytes BE length | payload
//     type 0x01  DATA      payload = bytes from the pty
//     type 0xFE  EXIT      payload = JSON {"exitCode":n,"signal":n}
//     type 0xFF  ERROR     payload = utf-8 string (fatal helper error)
//
// STDERR is plain text diagnostics for the parent to log.
//
// Args:
//   pty-helper.cjs <command> [arg ...]
//   environment:
//     SUBCTL_PTY_COLS  initial cols (defaults 80)
//     SUBCTL_PTY_ROWS  initial rows (defaults 24)
//
// SECURITY: this script does not enforce any access control. The parent
// dashboard server has already gated the spawn behind the
// `~/.config/subctl/terminal.enabled` flag + localhost-bind. The helper
// trusts whatever command its parent passes.

"use strict";

const FRAME_DATA = 0x01;
const FRAME_RESIZE = 0x02;
const FRAME_CLOSE = 0x03;
const FRAME_EXIT = 0xfe;
const FRAME_ERROR = 0xff;

let pty;
try {
  pty = require("node-pty");
} catch (err) {
  process.stderr.write("[pty-helper] failed to require node-pty: " + err.message + "\n");
  writeErrorFrame("node-pty not installed in dashboard/");
  process.exit(2);
}

const command = process.argv[2];
const cmdArgs = process.argv.slice(3);
if (!command) {
  writeErrorFrame("pty-helper: missing command argument");
  process.exit(2);
}

const initialCols = Math.max(2, Math.min(500, parseInt(process.env.SUBCTL_PTY_COLS || "80", 10)));
const initialRows = Math.max(2, Math.min(500, parseInt(process.env.SUBCTL_PTY_ROWS || "24", 10)));

let term;
try {
  term = pty.spawn(command, cmdArgs, {
    name: "xterm-256color",
    cols: initialCols,
    rows: initialRows,
    cwd: process.env.HOME || "/",
    env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
  });
} catch (err) {
  writeErrorFrame("pty-helper: spawn failed: " + (err && err.message ? err.message : String(err)));
  process.exit(3);
}

// Push pty output to parent as DATA frames.
term.onData((chunk) => {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  writeFrame(FRAME_DATA, buf);
});

term.onExit(({ exitCode, signal }) => {
  const payload = Buffer.from(JSON.stringify({ exitCode, signal }), "utf8");
  writeFrame(FRAME_EXIT, payload);
  // Give the parent a beat to flush, then bail.
  setTimeout(() => process.exit(0), 50);
});

// Parse framed stdin from parent.
let inbuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 5) {
    const type = inbuf[0];
    const len = inbuf.readUInt32BE(1);
    if (inbuf.length < 5 + len) break;
    const payload = inbuf.subarray(5, 5 + len);
    inbuf = inbuf.subarray(5 + len);
    handleFrame(type, payload);
  }
});

process.stdin.on("end", () => {
  // Parent closed the pipe — tear down the pty.
  try { term.kill("SIGHUP"); } catch (_) {}
});

function handleFrame(type, payload) {
  switch (type) {
    case FRAME_DATA:
      try {
        term.write(payload.toString("utf8"));
      } catch (err) {
        process.stderr.write("[pty-helper] write failed: " + err.message + "\n");
      }
      break;
    case FRAME_RESIZE: {
      const s = payload.toString("utf8");
      const m = /^(\d+),(\d+)$/.exec(s);
      if (!m) {
        process.stderr.write("[pty-helper] bad resize payload: " + JSON.stringify(s) + "\n");
        return;
      }
      const cols = Math.max(2, Math.min(500, parseInt(m[1], 10)));
      const rows = Math.max(2, Math.min(500, parseInt(m[2], 10)));
      try { term.resize(cols, rows); } catch (err) {
        process.stderr.write("[pty-helper] resize failed: " + err.message + "\n");
      }
      break;
    }
    case FRAME_CLOSE:
      try { term.kill("SIGHUP"); } catch (_) {}
      break;
    default:
      process.stderr.write("[pty-helper] unknown frame type 0x" + type.toString(16) + "\n");
  }
}

function writeFrame(type, payload) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  try {
    process.stdout.write(header);
    if (payload.length > 0) process.stdout.write(payload);
  } catch (_) {
    // parent went away; nothing we can do
  }
}

function writeErrorFrame(msg) {
  const payload = Buffer.from(msg, "utf8");
  writeFrame(FRAME_ERROR, payload);
}

process.on("SIGTERM", () => { try { term && term.kill("SIGHUP"); } catch (_) {} process.exit(0); });
process.on("SIGINT",  () => { try { term && term.kill("SIGHUP"); } catch (_) {} process.exit(0); });
