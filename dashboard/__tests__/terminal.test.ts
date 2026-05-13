// dashboard/__tests__/terminal.test.ts
//
// v2.7.21 (ADR 0011 Layer 2): tests for the web-terminal escape hatch.
//
// We exercise the pure handlers from dashboard/terminal.ts directly — no
// HTTP server, no port, no real tmux. SUBCTL_TERMINAL_FLAG_FILE is
// overridden per-test so we never touch the operator's real
// ~/.config/subctl/terminal.enabled.
//
// We also exercise the upgrade decision + the helper-sidecar spawn glue.
// node-pty itself is exercised via a tiny shell command (not tmux) to
// keep the test hermetic — we don't depend on a real tmux session being
// present.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateUpgrade,
  handleEnabled,
  handleTeams,
  originAllowed,
  spawnPtyBridge,
  terminalEnabled,
  terminalFlagPath,
} from "../terminal";

const ORIG_FLAG = process.env.SUBCTL_TERMINAL_FLAG_FILE;

let workDir: string;
let flagPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "subctl-term-test-"));
  flagPath = join(workDir, "terminal.enabled");
  process.env.SUBCTL_TERMINAL_FLAG_FILE = flagPath;
});

afterEach(() => {
  if (ORIG_FLAG === undefined) delete process.env.SUBCTL_TERMINAL_FLAG_FILE;
  else process.env.SUBCTL_TERMINAL_FLAG_FILE = ORIG_FLAG;
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

describe("terminalEnabled / handleEnabled", () => {
  test("default OFF — no flag file means terminalEnabled() is false", () => {
    expect(terminalEnabled()).toBe(false);
  });

  test("flag file present flips to ON", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    expect(terminalEnabled()).toBe(true);
  });

  test("handleEnabled returns {enabled:false,flag_path} when off", async () => {
    const resp = handleEnabled();
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.enabled).toBe(false);
    expect(j.flag_path).toBe(flagPath);
  });

  test("handleEnabled returns {enabled:true} when flag file present", async () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const resp = handleEnabled();
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.enabled).toBe(true);
  });

  test("terminalFlagPath respects SUBCTL_TERMINAL_FLAG_FILE override", () => {
    expect(terminalFlagPath()).toBe(flagPath);
  });
});

describe("handleTeams", () => {
  test("403 when terminal disabled", async () => {
    const resp = handleTeams(() => []);
    expect(resp.status).toBe(403);
    const j: any = await resp.json();
    expect(j.ok).toBe(false);
  });

  test("returns list when enabled — lister output is preserved", async () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const fake = [
      { name: "claude-foo", session: "claude-foo", attached: false },
      { name: "claude-bar", session: "claude-bar", attached: true },
    ];
    const resp = handleTeams(() => fake);
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.count).toBe(2);
    expect(j.teams).toEqual(fake);
  });
});

describe("originAllowed (DNS rebind defence)", () => {
  function reqWithHost(host: string): Request {
    return new Request("http://x/y", { headers: { host } });
  }
  test("localhost bind requires localhost host header", () => {
    expect(originAllowed(reqWithHost("localhost:8787"), "127.0.0.1")).toBe(true);
    expect(originAllowed(reqWithHost("127.0.0.1:8787"), "127.0.0.1")).toBe(true);
    expect(originAllowed(reqWithHost("evil.com"), "127.0.0.1")).toBe(false);
    expect(originAllowed(reqWithHost(""), "127.0.0.1")).toBe(false);
  });
  test("non-localhost bind trusts whatever host header — operator opted into LAN", () => {
    expect(originAllowed(reqWithHost("anything.local"), "0.0.0.0")).toBe(true);
    expect(originAllowed(reqWithHost("192.168.1.10"), "10.0.0.1")).toBe(true);
  });
});

describe("evaluateUpgrade (WS gate)", () => {
  function req(host = "localhost:8787"): Request {
    return new Request("http://localhost/api/terminal/attach?team=claude-foo", {
      headers: { host },
    });
  }
  function url(qs = "team=claude-foo"): URL {
    return new URL("http://localhost/api/terminal/attach?" + qs);
  }

  test("403 when terminal disabled", () => {
    const d = evaluateUpgrade({
      req: req(),
      url: url(),
      bindHost: "127.0.0.1",
      lister: () => [{ name: "claude-foo", session: "claude-foo", attached: false }],
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
    expect(d.reason).toMatch(/disabled/);
  });

  test("400 when team query param missing", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const d = evaluateUpgrade({
      req: req(),
      url: new URL("http://localhost/api/terminal/attach"),
      bindHost: "127.0.0.1",
      lister: () => [],
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(400);
  });

  test("400 when team has invalid characters", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const d = evaluateUpgrade({
      req: new Request("http://x/y?team=evil;rm%20-rf", { headers: { host: "localhost" } }),
      url: new URL("http://localhost/api/terminal/attach?team=evil;rm%20-rf"),
      bindHost: "127.0.0.1",
      lister: () => [],
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(400);
  });

  test("403 when host header rejected", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const d = evaluateUpgrade({
      req: new Request("http://x/y?team=claude-foo", { headers: { host: "evil.com" } }),
      url: url(),
      bindHost: "127.0.0.1",
      lister: () => [{ name: "claude-foo", session: "claude-foo", attached: false }],
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(403);
    expect(d.reason).toMatch(/host header/);
  });

  test("404 when tmux session doesn't exist", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const d = evaluateUpgrade({
      req: req(),
      url: url(),
      bindHost: "127.0.0.1",
      lister: () => [{ name: "other-session", session: "other-session", attached: false }],
    });
    expect(d.ok).toBe(false);
    expect(d.status).toBe(404);
  });

  test("ok when flag set + valid team + matching tmux session", () => {
    mkdirSync(workDir, { recursive: true });
    writeFileSync(flagPath, "");
    const d = evaluateUpgrade({
      req: req(),
      url: url(),
      bindHost: "127.0.0.1",
      lister: () => [{ name: "claude-foo", session: "claude-foo", attached: false }],
    });
    expect(d.ok).toBe(true);
    expect(d.session).toBe("claude-foo");
  });
});

describe("spawnPtyBridge — sidecar plumbing", () => {
  // We stub the spawn call so we don't actually fork node. We just want to
  // verify the wire-protocol framing (DATA frames written to stdin on
  // {type:"data",b64}; RESIZE frames on {type:"resize",cols,rows}).
  test("DATA message becomes a 0x01 length-prefixed stdin frame", async () => {
    const writes: Buffer[] = [];
    let onStdinData: ((b: Buffer) => void) | null = null;
    let onStdoutData: ((b: Buffer) => void) | null = null;
    let onExit: ((c: number | null, s: NodeJS.Signals | null) => void) | null = null;

    const fakeChild: any = {
      stdin: {
        write(b: Buffer) {
          // Buffer.concat any sequence — we just push every write for inspection.
          writes.push(Buffer.from(b));
          return true;
        },
      },
      stdout: { on(ev: string, cb: any) { if (ev === "data") onStdoutData = cb; } },
      stderr: { on(_ev: string, _cb: any) {} },
      on(ev: string, cb: any) {
        if (ev === "exit") onExit = cb;
        // we don't need "error" for this test
      },
      kill(_sig?: string) {},
      killed: false,
    };

    const spawnImpl: any = (..._args: any[]) => fakeChild;

    let bridgeClosed = false;
    const binSent: Uint8Array[] = [];
    const bridge = spawnPtyBridge({
      session: "claude-foo",
      cols: 80,
      rows: 24,
      sinks: {
        sendBinary: (c) => binSent.push(c),
        closeSocket: () => { bridgeClosed = true; },
      },
      spawnImpl,
    });
    // Sanity: child wired its handlers.
    expect(onStdoutData).not.toBeNull();

    bridge.onClientMessage(JSON.stringify({ type: "data", b64: Buffer.from("hello").toString("base64") }));
    // Two writes: header + payload. Concat them.
    const sent = Buffer.concat(writes);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent[0]).toBe(0x01); // DATA
    expect(sent.readUInt32BE(1)).toBe(5);
    expect(sent.subarray(5, 10).toString("utf8")).toBe("hello");

    // RESIZE
    writes.length = 0;
    bridge.onClientMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    const r = Buffer.concat(writes);
    expect(r[0]).toBe(0x02); // RESIZE
    expect(r.readUInt32BE(1)).toBe("120,40".length);
    expect(r.subarray(5, 5 + "120,40".length).toString("utf8")).toBe("120,40");

    // Inbound DATA frame from helper -> sendBinary
    const payload = Buffer.from("world", "utf8");
    const header = Buffer.alloc(5);
    header[0] = 0x01;
    header.writeUInt32BE(payload.length, 1);
    onStdoutData!(Buffer.concat([header, payload]));
    expect(binSent.length).toBe(1);
    expect(Buffer.from(binSent[0]!).toString("utf8")).toBe("world");

    // Bridge close pushes a 0x03 CLOSE frame then is idempotent.
    writes.length = 0;
    bridge.close();
    expect(writes[0]![0]).toBe(0x03);
    bridge.close(); // idempotent
    expect(bridgeClosed).toBe(false); // close() doesn't itself close the socket; the helper exit does

    // Simulate helper exit -> socket closes.
    onExit!(0, null);
    expect(bridgeClosed).toBe(true);
  });

  test("ignores malformed client messages without throwing", () => {
    const fakeChild: any = {
      stdin: { write(_b: Buffer) { return true; } },
      stdout: { on(_e: string, _cb: any) {} },
      stderr: { on(_e: string, _cb: any) {} },
      on(_e: string, _cb: any) {},
      kill() {},
      killed: false,
    };
    const bridge = spawnPtyBridge({
      session: "x",
      cols: 80,
      rows: 24,
      sinks: { sendBinary: () => {}, closeSocket: () => {} },
      spawnImpl: (..._a: any[]) => fakeChild,
    });
    // None of these should throw.
    bridge.onClientMessage("not json");
    bridge.onClientMessage(JSON.stringify({ type: "nope" }));
    bridge.onClientMessage(JSON.stringify({ type: "data" })); // no b64
    bridge.onClientMessage(JSON.stringify({ type: "resize", cols: "x" }));
    bridge.close();
  });
});
