// dashboard/terminal.ts — v2.7.21 (ADR 0011 Layer 2)
//
// Web terminal escape hatch. Renders an xterm.js terminal in the browser,
// proxied via WebSocket through a node-pty sidecar running
// `tmux attach -t <session>`. Lets the operator break out of any worker
// paranoia loop or stuck state directly from the dashboard, without
// needing to SSH to another machine. See ADR 0011 § "Layer 2".
//
// Security model:
//   - Default OFF. The endpoints check for the existence of
//     `~/.config/subctl/terminal.enabled` (a flag file, file presence = on,
//     absent = off). The Telegram `/terminal on|off` command and the
//     `subctl terminal on|off` CLI both touch/remove this file.
//   - Localhost-bind reuse. The dashboard binds 127.0.0.1 by default
//     (SUBCTL_DASHBOARD_HOST env override). When bound to localhost we
//     additionally reject WS upgrades whose Host header isn't a localhost
//     variant — defence-in-depth against DNS rebinding. When the operator
//     deliberately opens the dashboard to LAN (SUBCTL_DASHBOARD_HOST=
//     0.0.0.0 or similar) we trust the listener config and skip the Host
//     check — same posture as the rest of /api/*.
//   - No new auth surface. The dashboard has no auth middleware today;
//     adding one here would be inventing new policy. The flag file is the
//     opt-in.
//
// Wire protocol with the browser (one WS connection per attached session):
//   client → server  JSON text frames only:
//     {"type":"data","b64":"<base64 of stdin bytes>"}
//     {"type":"resize","cols":120,"rows":40}
//   server → client  binary frames carrying raw pty bytes (xterm.js handles
//                    them natively). The server never sends JSON to the
//                    client — xterm.js doesn't need it.
//
// We picked base64 in the data frame (over raw bytes in a separate WS
// binary direction) so the browser→server side is plain JSON and trivially
// inspectable in browser devtools. Bandwidth for keystrokes is negligible.
// PTY → browser is binary because it can be hundreds of KB on a tmux
// redraw and base64 inflates by 33 %.

import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

const FRAME_DATA = 0x01;
const FRAME_RESIZE = 0x02;
const FRAME_CLOSE = 0x03;
const FRAME_EXIT = 0xfe;
const FRAME_ERROR = 0xff;

const HELPER_PATH = join(import.meta.dir, "lib", "pty-helper.cjs");
const TMUX_BIN = process.env.SUBCTL_TMUX_BIN || "tmux";

// ---------- flag file ----------

/** Path to the enable-flag. Override via env for tests. */
export function terminalFlagPath(): string {
  if (process.env.SUBCTL_TERMINAL_FLAG_FILE) return process.env.SUBCTL_TERMINAL_FLAG_FILE;
  const cfgDir = process.env.SUBCTL_CONFIG_DIR
    ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/", ".config"), "subctl");
  return join(cfgDir, "terminal.enabled");
}

/** True if the operator has opted into the web-terminal surface. */
export function terminalEnabled(): boolean {
  try {
    return existsSync(terminalFlagPath());
  } catch {
    return false;
  }
}

// ---------- attachable sessions ----------

export interface AttachableTeam {
  name: string;
  session: string;
  attached: boolean;
}

/**
 * Inject point for tmux session enumeration. Defaults to the real `tmux
 * list-sessions` call; tests can pass a fake. The team-to-session mapping
 * is identity — `providers/claude/teams.sh` sets `SESSION_NAME` to the
 * `team_id` (the tmux session name) directly. No translation needed.
 */
export type TmuxSessionLister = () => AttachableTeam[];

export function defaultTmuxLister(): AttachableTeam[] {
  const proc = Bun.spawnSync([TMUX_BIN, "list-sessions", "-F", "#{session_name}\t#{session_attached}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return [];
  const out = new TextDecoder().decode(proc.stdout);
  const rows: AttachableTeam[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [name, attached] = t.split("\t");
    if (!name) continue;
    rows.push({ name, session: name, attached: attached !== "0" });
  }
  return rows;
}

// ---------- HTTP handlers (pure for testing) ----------

export function handleEnabled(): Response {
  const enabled = terminalEnabled();
  return Response.json({ ok: true, enabled, flag_path: terminalFlagPath() });
}

export function handleTeams(lister: TmuxSessionLister = defaultTmuxLister): Response {
  if (!terminalEnabled()) {
    return Response.json({ ok: false, error: "terminal disabled" }, { status: 403 });
  }
  const teams = lister();
  return Response.json({ ok: true, count: teams.length, teams });
}

// ---------- host check ----------

/**
 * If the dashboard is bound to a localhost address, refuse WS upgrades
 * whose Host header doesn't look local — defends against DNS rebinding
 * tricks where a remote site causes the browser to open ws://attacker.com:8787
 * resolving to 127.0.0.1.  When the operator binds 0.0.0.0 deliberately we
 * trust them.
 */
export function originAllowed(req: Request, bindHost: string): boolean {
  const isLocalhostBind = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
  if (!isLocalhostBind) return true;
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0]!.trim();
  if (!host) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

// ---------- WebSocket gate ----------

export interface UpgradeDecision {
  ok: boolean;
  status?: number;
  reason?: string;
  /** session_name to attach when ok=true */
  session?: string;
}

/**
 * Pre-upgrade gate. Verifies the flag file, the host header, and that the
 * requested team exists as an attachable tmux session. Returns the
 * resolved session name on success so the caller can hand it off to the
 * upgrade data.
 */
export function evaluateUpgrade(args: {
  req: Request;
  url: URL;
  bindHost: string;
  lister?: TmuxSessionLister;
}): UpgradeDecision {
  if (!terminalEnabled()) {
    return { ok: false, status: 403, reason: "terminal disabled" };
  }
  if (!originAllowed(args.req, args.bindHost)) {
    return { ok: false, status: 403, reason: "host header rejected (dns-rebind defence)" };
  }
  const team = args.url.searchParams.get("team");
  if (!team || team.length === 0) {
    return { ok: false, status: 400, reason: "team query parameter required" };
  }
  // Tmux session names are operator-controlled; reject anything that
  // doesn't look like a sane identifier. providers/claude/teams.sh maps
  // `claude-<basename>` so the realistic character set is
  // [A-Za-z0-9._-]. We also clamp length so a flood of nonsense names
  // doesn't keep the helper spinning.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(team)) {
    return { ok: false, status: 400, reason: "team name has invalid characters" };
  }
  const sessions = (args.lister ?? defaultTmuxLister)();
  const hit = sessions.find((s) => s.name === team);
  if (!hit) {
    return { ok: false, status: 404, reason: `tmux session not found: ${team}` };
  }
  return { ok: true, session: hit.session };
}

// ---------- helper subprocess wiring ----------

export interface PtyBridge {
  /** Send a JSON message originating from the browser. */
  onClientMessage(msg: string | ArrayBufferLike | Uint8Array): void;
  /** Tear down the bridge. Safe to call multiple times. */
  close(): void;
}

export interface PtyBridgeSinks {
  sendBinary: (chunk: Uint8Array) => void;
  closeSocket: () => void;
}

/**
 * Spawn the node sidecar (`lib/pty-helper.cjs`) running
 * `tmux attach -t <session>`, parse its framed stdout, push pty bytes to
 * `sinks.sendBinary`. Returns a controller that the WS layer uses to push
 * client→pty bytes and resize events back through to the helper.
 *
 * On helper exit, calls `sinks.closeSocket()`. On WS close, the caller
 * invokes `controller.close()` which sends a CLOSE frame and SIGHUPs the
 * subprocess.
 */
export function spawnPtyBridge(args: {
  session: string;
  cols: number;
  rows: number;
  sinks: PtyBridgeSinks;
  nodeBin?: string;
  helperPath?: string;
  tmuxBin?: string;
  /** Test seam: stub the spawn for unit tests. */
  spawnImpl?: typeof spawn;
}): PtyBridge {
  const nodeBin = args.nodeBin ?? process.env.SUBCTL_NODE_BIN ?? "node";
  const helperPath = args.helperPath ?? HELPER_PATH;
  const tmuxBin = args.tmuxBin ?? TMUX_BIN;
  const spawnFn = args.spawnImpl ?? spawn;

  const child: ChildProcessWithoutNullStreams = spawnFn(
    nodeBin,
    [helperPath, tmuxBin, "attach", "-t", args.session],
    {
      env: {
        ...process.env,
        SUBCTL_PTY_COLS: String(args.cols),
        SUBCTL_PTY_ROWS: String(args.rows),
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams;

  // Two flags so that "operator-initiated WS close" and "helper subprocess
  // exit" both correctly trigger socket teardown exactly once each. Without
  // separation, a manual bridge.close() suppresses the closeSocket() that
  // should fire when the helper actually exits.
  let closed = false;
  let socketClosed = false;
  function fireCloseSocket(): void {
    if (socketClosed) return;
    socketClosed = true;
    try { args.sinks.closeSocket(); } catch {}
  }

  // Frame parser for helper STDOUT.
  let inbuf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    inbuf = Buffer.concat([inbuf, chunk]);
    while (inbuf.length >= 5) {
      const type = inbuf[0];
      const len = inbuf.readUInt32BE(1);
      if (inbuf.length < 5 + len) break;
      const payload = inbuf.subarray(5, 5 + len);
      inbuf = inbuf.subarray(5 + len);
      if (type === FRAME_DATA) {
        try { args.sinks.sendBinary(new Uint8Array(payload)); } catch { /* socket likely closed */ }
      } else if (type === FRAME_EXIT) {
        // Helper announced clean exit. Close the socket after a beat to
        // let final output land. fireCloseSocket() is idempotent.
        setTimeout(() => fireCloseSocket(), 50);
      } else if (type === FRAME_ERROR) {
        const msg = payload.toString("utf8");
        // Surface error to the browser as a textual line in the terminal.
        const banner = `\r\n[subctl-terminal] helper error: ${msg}\r\n`;
        try { args.sinks.sendBinary(new TextEncoder().encode(banner)); } catch {}
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    // Helper diagnostics — surface to dashboard log.
    const s = chunk.toString("utf8").trimEnd();
    if (s) console.log(`[terminal] helper: ${s}`);
  });

  child.on("exit", (code, signal) => {
    console.log(`[terminal] helper exit code=${code ?? "null"} signal=${signal ?? "null"}`);
    closed = true;
    fireCloseSocket();
  });

  child.on("error", (err) => {
    console.log(`[terminal] helper spawn error: ${err.message}`);
    closed = true;
    fireCloseSocket();
  });

  function writeFrame(type: number, payload: Uint8Array): void {
    if (closed || child.killed) return;
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(payload.length, 1);
    try {
      child.stdin.write(header);
      if (payload.length > 0) child.stdin.write(payload);
    } catch {
      // helper likely exited; the exit handler will close the socket
    }
  }

  return {
    onClientMessage(raw) {
      let s: string;
      if (typeof raw === "string") s = raw;
      else if (raw instanceof Uint8Array) s = new TextDecoder().decode(raw);
      else if (raw instanceof ArrayBuffer) s = new TextDecoder().decode(new Uint8Array(raw));
      else return;
      let msg: any;
      try { msg = JSON.parse(s); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "data" && typeof msg.b64 === "string") {
        let bytes: Buffer;
        try { bytes = Buffer.from(msg.b64, "base64"); } catch { return; }
        writeFrame(FRAME_DATA, bytes);
      } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        const cols = Math.max(2, Math.min(500, Math.floor(msg.cols)));
        const rows = Math.max(2, Math.min(500, Math.floor(msg.rows)));
        const payload = new TextEncoder().encode(`${cols},${rows}`);
        writeFrame(FRAME_RESIZE, payload);
      }
    },
    close() {
      if (closed) return;
      // Send the CLOSE frame BEFORE flipping `closed` (writeFrame is a no-op
      // once closed=true). This gives the helper a chance to drain its pty
      // before we SIGHUP it below.
      writeFrame(FRAME_CLOSE, new Uint8Array(0));
      closed = true;
      // Force kill if the helper doesn't honour the close request quickly.
      setTimeout(() => { try { child.kill("SIGHUP"); } catch {} }, 250);
    },
  };
}
