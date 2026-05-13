// dashboard/public/terminal.js — v2.7.21 (ADR 0011 Layer 2)
//
// xterm.js client for the web-terminal escape hatch. Mounts an xterm into
// the existing #terminal-modal, opens a WebSocket to
// /api/terminal/attach?team=<name>, and shuttles keystrokes + output.
//
// Wire protocol (must match dashboard/terminal.ts):
//   client → server   JSON text frames:
//     {type:"data",b64:"<base64 keystrokes>"}
//     {type:"resize",cols,rows}
//   server → client   raw binary frames (pty bytes) — handed straight to
//                     xterm.write().
//
// Why base64 client→server: keystrokes are tiny (a few bytes), trivial to
// inspect in devtools, and it keeps the stdin direction plain JSON. Output
// direction is binary because tmux redraws routinely emit tens of KB.

(function () {
  "use strict";

  let _term = null;
  let _ws = null;
  let _fitAddon = null;
  let _resizeObserver = null;
  let _onKey = null;
  let _activeTeam = null;

  function $(id) { return document.getElementById(id); }

  /**
   * Mount an xterm in `containerEl` and connect to /api/terminal/attach for `teamName`.
   * Returns nothing — call closeTerminal() to tear down.
   */
  function mountTerminal(containerEl, teamName) {
    closeTerminal(); // dispose any prior session
    if (!containerEl) return;
    if (typeof window.Terminal !== "function") {
      containerEl.textContent = "xterm.js failed to load (vendor missing).";
      return;
    }
    _activeTeam = teamName;

    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon && window.FitAddon.FitAddon;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 13,
      theme: {
        background: "#0b0d10",
        foreground: "#d6d6d6",
        cursor: "#7ad6c8",
        selectionBackground: "#2a3a45",
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    _term = term;

    if (FitAddon) {
      _fitAddon = new FitAddon();
      term.loadAddon(_fitAddon);
    }

    term.open(containerEl);
    try { _fitAddon && _fitAddon.fit(); } catch (_) {}

    const cols = term.cols || 80;
    const rows = term.rows || 24;

    // Build the WS URL on the same origin/scheme as the dashboard.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = proto + "//" + window.location.host + "/api/terminal/attach"
      + "?team=" + encodeURIComponent(teamName)
      + "&cols=" + cols + "&rows=" + rows;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      term.write("\r\n[subctl] failed to open WebSocket: " + err.message + "\r\n");
      return;
    }
    ws.binaryType = "arraybuffer";
    _ws = ws;

    ws.addEventListener("open", () => {
      term.write("\r\n\x1b[1;36m[subctl] attached to " + teamName + "\x1b[0m\r\n");
      // Re-send our current geometry right after open in case xterm settled
      // a different size than we sent in the URL.
      sendResize(term.cols, term.rows);
    });

    ws.addEventListener("message", (ev) => {
      if (!ev.data) return;
      if (typeof ev.data === "string") {
        // No JSON path from the server side currently — render as text.
        term.write(ev.data);
        return;
      }
      // Binary frame (ArrayBuffer)
      const bytes = new Uint8Array(ev.data);
      term.write(bytes);
    });

    ws.addEventListener("close", (ev) => {
      term.write("\r\n\x1b[1;33m[subctl] connection closed (code " + ev.code + ")\x1b[0m\r\n");
    });

    ws.addEventListener("error", () => {
      term.write("\r\n\x1b[1;31m[subctl] WebSocket error\x1b[0m\r\n");
    });

    _onKey = term.onData((data) => {
      if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
      // Use btoa over the bytes — encode utf-8 first for high-codepoint chars.
      const enc = new TextEncoder().encode(data);
      let bin = "";
      for (let i = 0; i < enc.length; i++) bin += String.fromCharCode(enc[i]);
      const b64 = btoa(bin);
      _ws.send(JSON.stringify({ type: "data", b64: b64 }));
    });

    // Resize handling: ResizeObserver on the container + xterm-addon-fit.
    if (typeof ResizeObserver === "function") {
      _resizeObserver = new ResizeObserver(() => {
        try {
          _fitAddon && _fitAddon.fit();
          sendResize(term.cols, term.rows);
        } catch (_) {}
      });
      _resizeObserver.observe(containerEl);
    }
    window.addEventListener("resize", onWindowResize);
  }

  function onWindowResize() {
    try {
      _fitAddon && _fitAddon.fit();
      if (_term) sendResize(_term.cols, _term.rows);
    } catch (_) {}
  }

  function sendResize(cols, rows) {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    try {
      _ws.send(JSON.stringify({ type: "resize", cols: cols, rows: rows }));
    } catch (_) {}
  }

  function closeTerminal() {
    window.removeEventListener("resize", onWindowResize);
    if (_resizeObserver) {
      try { _resizeObserver.disconnect(); } catch (_) {}
      _resizeObserver = null;
    }
    if (_onKey && typeof _onKey.dispose === "function") {
      try { _onKey.dispose(); } catch (_) {}
      _onKey = null;
    }
    if (_ws) {
      try { _ws.close(); } catch (_) {}
      _ws = null;
    }
    if (_term) {
      try { _term.dispose(); } catch (_) {}
      _term = null;
    }
    _fitAddon = null;
    _activeTeam = null;
  }

  function activeTeam() { return _activeTeam; }

  window.subctlTerminal = {
    mount: mountTerminal,
    close: closeTerminal,
    activeTeam: activeTeam,
  };
})();
