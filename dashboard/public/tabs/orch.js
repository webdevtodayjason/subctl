// dashboard/public/tabs/orch.js
//
// v2.8.6 — Orchestration zone. Wave 13 of dashboard/public/app.js
// decomposition. Largest single extraction (~906 LOC).
//
// Extracted from app.js:709–1614 (five contiguous blocks):
//   1. Camera grid (NVR-style tmux pane viewer)        — app.js:709–828
//   2. Orchestration cockpit + watchdog history shim   — app.js:830–1098
//   3. Watchdogs panel (v2.7.19 + v2.7.35 rich diag)   — app.js:1101–1394
//   4. TMux preview modal                              — app.js:1401–1484
//   5. Web terminal modal driver + boot gate           — app.js:1490–1540
//
// The notice/confirm modal (originally a sixth block here) lives in
// app.js — it's a shell-level notification system, not tab-scoped, and
// every consumer fires before this module mounts. See app.js for the
// `_showNotice` definition + `window.notice` publications.
//
// PUBLISHES 4 window globals from `mount()` for the consumers that
// still read them (across app.js shell + the extracted tabs/*.js
// modules):
//   - window.__subctlOpenTmuxPreview        (consumed at app.js:3278)
//   - window.__subctlCopyAttachCommand      (consumed at app.js:3288)
//   - window.__subctlOpenWebTerminal        (no remaining external consumers
//                                            after Teams extracted; published
//                                            for symmetry + legacy panels)
//   - window.__subctlWireWebTerminalGate    (hoist for boot block, harmless
//                                            now that Orch owns its own boot)
//
// Bridge retirement is DEFERRED for this wave — these globals are
// consumed across the shell, the chat panel, the Dashboard panel attach
// buttons, etc. Following the wave-6 (Vault) publisher pattern:
// publish at the end of `mount()`, null in `unmount()`. A future
// event-based migration (per the wave-11 Policy precedent) can land
// after wave 14 (Master chat) removes its own publishers.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/orchestration/captures?lines=N
//   GET  /api/orchestration/<name>
//   GET  /api/master/teams
//   GET  /api/master/health
//   GET  /api/master/diag
//   GET  /api/master/events                  (SSE)
//   GET  /api/watchdogs/diag
//   POST /api/watchdogs/<id>/restart
//   POST /api/watchdogs/<id>/kill
//   GET  /api/terminal/enabled
//
// Lifecycle:
//   `mount({ root })` wires all six blocks, kicks off the four boot
//   wirers (mirrors app.js:455–456, 460, 1395 in their original order),
//   then publishes the five globals.
//
//   `unmount()` clears the module-scope tmux poll timer and nulls all
//   five published globals. Bootstrap never calls unmount() today; this
//   is forward-looking hygiene matching the prior twelve waves.

export const id = "orch";

// Module-scope timer for the tmux-preview modal poll (originally a
// `let _tmuxPollTimer = null;` inside the IIFE at app.js:1405). Lifted
// here so `unmount()` can reach it across closures. `_tmuxCurrent` and
// `_termModalKeyHandler` stay local to `mount()` — they're transient
// per-open-modal state that dies with the close() callback and don't
// need to survive unmount.
let _tmuxPollTimer = null;

export async function mount({ root: _root }) {
  // Inlined `$` helper — the IIFE-scope shorthand from app.js:61. Same
  // pattern as every prior wave (vault.js, providers.js, etc.).
  function $(id) { return document.getElementById(id); }

  // Inlined from app.js:22. SSH alias used by the per-team "copy ssh
  // attach" button + the tmux modal's onAttach callback. TODO already
  // tracked in the original (wire from policy.json/host_label).
  const SSH_HOST_ALIAS = "argent-m3-ultra-dev";

  // Inlined from app.js:339. Module-scope `fmtAge` reader used by the
  // orchestration cockpit (`refreshTeams` formats per-card staleness)
  // and `refreshHealth` (daemon uptime). The camera-grid block below
  // declares its OWN local `fmtAge` with different formatting ("Xs ago"
  // suffix); that intentionally shadows this one within its scope.
  function fmtAge(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
    }
    return `${Math.floor(seconds / 86400)}d`;
  }

  // Local copy of `escapeText` from app.js:1397. The original STAYS in
  // app.js (used widely outside the Orch zone — search "escapeText("
  // in app.js for the call sites). Duplicating the 3-line helper here
  // keeps this module self-contained.
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ----- Camera View — NVR grid of dev-team tmux panes (Phase 3m) -----
  function wireOrchCameraGrid() {
    const grid = $("orch-camera-grid");
    const countEl = $("orch-camera-count");
    const exp = $("orch-camera-expanded");
    const expName = $("orch-camera-expanded-name");
    const expStatus = $("orch-camera-expanded-status");
    const expPane = $("orch-camera-expanded-pane");
    const expClose = $("orch-camera-expanded-close");
    if (!grid) return;

    let expandedName = null;        // currently expanded session, or null
    let pollTimer = null;

    function escForHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function fmtAge(secAgo) {
      if (typeof secAgo !== "number") return "";
      if (secAgo < 60) return `${Math.round(secAgo)}s ago`;
      if (secAgo < 3600) return `${Math.round(secAgo / 60)}m ago`;
      return `${Math.round(secAgo / 3600)}h ago`;
    }

    function openExpanded(name) {
      expandedName = name;
      exp.hidden = false;
      // Force an immediate refresh so the expanded pane shows fresh content.
      void refresh();
    }
    function closeExpanded() {
      expandedName = null;
      exp.hidden = true;
    }

    expClose.addEventListener("click", closeExpanded);
    exp.addEventListener("click", (e) => {
      // Click on the overlay backdrop (not the inner pane) closes.
      if (e.target === exp) closeExpanded();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !exp.hidden) closeExpanded();
    });

    async function refresh() {
      try {
        const r = await fetch("/api/orchestration/captures?lines=60");
        const j = await r.json();
        if (!j.ok) {
          grid.innerHTML = `<div class="orch-empty">error: ${escForHtml(j.error || "unknown")}</div>`;
          return;
        }
        const caps = j.captures || [];
        countEl.textContent = `${caps.length} team${caps.length === 1 ? "" : "s"}`;
        if (caps.length === 0) {
          grid.innerHTML = `<div class="orch-empty">no dev teams running — chat with master to spawn one</div>`;
          if (!exp.hidden) closeExpanded();
          return;
        }
        // Render tiles (idempotent — replace whole grid each tick; cheap at
        // typical team counts, lets us avoid manual diffing).
        const html = caps.map((c) => {
          const meta = fmtAge(c.last_activity_seconds_ago);
          return `<div class="orch-camera-tile status-${c.status}" data-team="${escForHtml(c.name)}">
            <div class="tile-head">
              <span class="tile-name">${escForHtml(c.name)}</span>
              <span class="tile-status">${c.status}</span>
              ${meta ? `<span class="tile-meta">${meta}</span>` : ""}
            </div>
            <pre class="tile-pane">${escForHtml(c.capture || "(empty)")}</pre>
          </div>`;
        }).join("");
        grid.innerHTML = html;
        // Wire tile click → expand. Listeners attach per render; cheap.
        for (const tile of grid.querySelectorAll(".orch-camera-tile")) {
          tile.addEventListener("click", () => openExpanded(tile.getAttribute("data-team")));
        }
        // If currently expanded, refresh that pane too.
        if (expandedName) {
          const cur = caps.find((c) => c.name === expandedName);
          if (!cur) {
            // Session ended while expanded — close.
            closeExpanded();
          } else {
            expName.textContent = cur.name;
            expStatus.textContent = cur.status;
            expStatus.className = `orch-camera-status status-${cur.status}`;
            expPane.textContent = cur.capture || "(empty)";
          }
        }
      } catch (err) {
        // Network failure — leave the previous render in place rather than
        // wiping; user gets stale-but-readable instead of a blank panel.
        console.warn("[camera-grid] poll error:", err);
      }
    }

    function startPolling() {
      if (pollTimer) return;
      void refresh();
      pollTimer = setInterval(() => void refresh(), 2000);
    }
    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // Only poll while the Orchestration tab is visible. Saves network +
    // tmux capture cost when the operator is on another tab.
    function checkActive() {
      const isActive = document.body.getAttribute("data-active-tab") === "orchestration";
      if (isActive) startPolling(); else stopPolling();
    }
    new MutationObserver(checkActive).observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
    checkActive();
  }

  // ----- Orchestration cockpit -----
  // ── Watchdog panel renderer (Phase 3 finish-up) ─────────────────────────
  // Shared module-level renderer used by the wireMasterChat SSE handlers AND
  // the wireOrchestrationCockpit setup. Tracks the last N ticks (default 8)
  // so the operator sees the watchdog IS alive even when nothing's stale —
  // previously the panel showed "no recent watchdog firings" forever, which
  // looked broken. Now: last tick timestamp + status pill + collapsible
  // history of recent ticks.
  const _watchdogHistory = []; // newest last
  const WATCHDOG_HISTORY_MAX = 8;
  function fmtTimeShort(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    } catch { return "—"; }
  }
  function renderWatchdogPanel(tick) {
    _watchdogHistory.push(tick);
    if (_watchdogHistory.length > WATCHDOG_HISTORY_MAX) _watchdogHistory.shift();
    const body = document.getElementById("orch-watchdog-body");
    const meta = document.getElementById("orch-watchdog-meta");
    if (!body) return;
    const latest = _watchdogHistory[_watchdogHistory.length - 1];
    if (meta) {
      meta.textContent = `last tick · ${fmtTimeShort(latest.ts)}`;
    }
    const rows = _watchdogHistory.slice().reverse().map((t) => {
      const cls = t.kind === "fire" ? "watchdog-row-fire" : "watchdog-row-ok";
      const pill = t.kind === "fire"
        ? `<span class="watchdog-pill fire">FIRE</span>`
        : `<span class="watchdog-pill ok">OK</span>`;
      const detail = t.kind === "fire"
        ? `<span class="watchdog-detail">${t.stale ?? "?"} stale</span><span class="watchdog-summary">${escForWatchdog(t.summary || "")}</span>`
        : `<span class="watchdog-detail">${t.teams ?? 0} teams, ${t.stale ?? 0} stale</span>`;
      return `<div class="watchdog-row ${cls}">
        <span class="watchdog-when">${fmtTimeShort(t.ts)}</span>
        ${pill}
        ${detail}
      </div>`;
    }).join("");
    body.innerHTML = rows;
  }
  function escForWatchdog(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function wireOrchestrationCockpit() {
    const activeBody = $("orch-active-body");
    const activeCount = $("orch-active-count");
    const activeMeta = $("orch-active-meta");
    const watchdogBody = $("orch-watchdog-body");
    const watchdogMeta = $("orch-watchdog-meta");
    const liveFeed = $("orch-live-activity");
    const clearBtn = $("orch-activity-clear");
    const daemonMeta = $("orch-daemon-meta");
    const diagRefresh = $("orch-diag-refresh");
    const diagBody = $("orch-diag-body");
    if (!activeBody) return;

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        liveFeed.innerHTML = "<div class=\"orch-empty\">cleared</div>";
      });
    }

    async function refreshTeams() {
      try {
        const r = await fetch("/api/master/teams");
        const j = await r.json();
        const teams = j.teams || [];
        activeCount.textContent = teams.length;
        if (!teams.length) {
          activeBody.innerHTML = "<div class=\"orch-empty\">no dev teams running — chat with master to spawn one</div>";
          activeMeta.textContent = "—";
          return;
        }
        activeMeta.textContent = teams.length + " tracked";
        activeBody.replaceChildren(...teams.map((t) => {
          const card = document.createElement("div");
          card.className = "orch-team-card";
          const ageS = t.last_activity_seconds_ago;
          if (typeof ageS === "number") {
            if (ageS > 1800) card.classList.add("stale-red");
            else if (ageS > 900) card.classList.add("stale-yellow");
            else card.classList.add("fresh");
          }
          const head = document.createElement("div");
          head.className = "head";
          const name = document.createElement("span");
          name.className = "name";
          name.textContent = t.name;
          const age = document.createElement("span");
          age.className = "age";
          age.textContent = typeof ageS === "number" ? fmtAge(ageS) + " ago" : "—";
          head.appendChild(name);
          head.appendChild(age);
          card.appendChild(head);
          if (t.last_event) {
            // Synthetic spawn-seed events use `kind` (not `type`) and have no
            // `text` field — earlier code rendered them as "undefined: (no text)".
            // Render gracefully by falling back to kind/detail/by fields.
            const ev = document.createElement("div");
            ev.className = "last-event";
            const label = t.last_event.type
                       || t.last_event.kind
                       || (t.last_event.by ? `by ${t.last_event.by}` : "report");
            const body = t.last_event.text || t.last_event.detail || "";
            ev.textContent = body ? `${label}: ${body}` : label;
            card.appendChild(ev);
          } else {
            const meta = document.createElement("div");
            meta.className = "meta";
            meta.textContent = "no reports yet";
            card.appendChild(meta);
          }
          // Per-team actions: view live tmux + web-attach + copy ssh attach
          const actions = document.createElement("div");
          actions.className = "actions";
          const viewBtn = document.createElement("button");
          viewBtn.className = "view-btn";
          viewBtn.textContent = "view";
          viewBtn.title = "Live read-only preview of this team's tmux pane (polled every 2s)";
          viewBtn.addEventListener("click", () => openTmuxPreview(t.name));
          // v2.7.21 (ADR 0011 L2): in-browser tmux attach. Hidden by CSS
          // whenever /api/terminal/enabled returned false (body has
          // .terminal-disabled). Bypasses master + HMAC — the operator
          // types directly into the worker's pane as themselves.
          const webAttachBtn = document.createElement("button");
          webAttachBtn.className = "attach-web-btn";
          webAttachBtn.textContent = "attach";
          webAttachBtn.title = "Open in-browser terminal attached to this team's tmux session (operator escape hatch, v2.7.21)";
          webAttachBtn.addEventListener("click", () => openWebTerminal(t.name));
          const attachBtn = document.createElement("button");
          attachBtn.textContent = "copy ssh attach";
          attachBtn.title = "Copy SSH command to attach to this team's tmux directly";
          attachBtn.addEventListener("click", () => copyAttachCommand(t.name, attachBtn));
          actions.appendChild(viewBtn);
          actions.appendChild(webAttachBtn);
          actions.appendChild(attachBtn);
          card.appendChild(actions);
          return card;
        }));
      } catch {
        activeBody.innerHTML = "<div class=\"orch-empty\">/api/master/teams unreachable</div>";
      }
    }

    async function refreshHealth() {
      try {
        const r = await fetch("/api/master/health");
        const j = await r.json();
        const setT = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        setT("orch-daemon-uptime", j.uptime_s != null ? fmtAge(j.uptime_s) : "—");
        setT("orch-daemon-transcript", (j.transcript_msgs ?? "—") + " msgs");
        setT("orch-daemon-queue", j.prompt_in_flight ? "in-flight" : "idle");
        setT("orch-daemon-subs", j.subscribers ?? "—");
        const tg = j.telegram_listener || {};
        setT("orch-daemon-tg", tg.running ? `polling @${tg.bot_username || "?"} (q=${tg.queue_size ?? 0})` : "not running");
        if (daemonMeta) daemonMeta.textContent = j.ok ? "ok" : "degraded";

        // Read diag for watchdog interval + supervisor
        try {
          const diagR = await fetch("/api/master/diag");
          const diag = await diagR.json();
          setT("orch-daemon-sup", diag.supervisor || "—");
        } catch {}
      } catch {}
    }

    async function runDiag() {
      diagBody.innerHTML = "<div class=\"dim small\">running diagnostics…</div>";
      try {
        const r = await fetch("/api/master/diag");
        const j = await r.json();
        if (!j.ok && !j.checks) {
          diagBody.innerHTML = "<div class=\"orch-empty\">diag unreachable</div>";
          return;
        }
        const rows = (j.checks || []).map((c) => {
          const row = document.createElement("div");
          row.className = "diag-row " + (c.ok ? "ok" : "err");
          row.innerHTML =
            "<span class=\"mark\">" + (c.ok ? "✓" : "✗") + "</span>" +
            "<span class=\"name\">" + escapeText(c.name) + "</span>" +
            "<span class=\"detail\">" + escapeText(c.detail || "") + "</span>";
          return row;
        });
        diagBody.replaceChildren(...rows);
      } catch (err) {
        diagBody.innerHTML = "<div class=\"orch-empty\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    if (diagRefresh) diagRefresh.addEventListener("click", runDiag);

    function appendLiveRow(kind, label, text) {
      if (!liveFeed) return;
      const empty = liveFeed.querySelector(".orch-empty");
      if (empty) empty.remove();
      const row = document.createElement("div");
      row.className = "row kind-" + kind;
      row.innerHTML =
        "<span class=\"ts\">" + new Date().toLocaleTimeString() + "</span>" +
        "<span class=\"label\">" + escapeText(label) + "</span>" +
        escapeText(text);
      liveFeed.insertBefore(row, liveFeed.firstChild);
      while (liveFeed.children.length > 50) liveFeed.removeChild(liveFeed.lastChild);
    }
    // Independent SSE connection for the cockpit so it works without the
    // chat panel mounted (browser EventSource handles dedup behind one HTTP
    // connection automatically when same URL).
    function connectSSE() {
      const es = new EventSource("/api/master/events");
      es.addEventListener("inbound", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLiveRow("inbound", d.source || "in", String(d.text || "").slice(0, 160));
        } catch {}
      });
      es.addEventListener("team_event", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLiveRow("team", d.team + " " + (d.type || ""), String(d.text || "").slice(0, 160));
        } catch {}
      });
      es.addEventListener("watchdog_fire", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLiveRow("watchdog", "fired", String(d.prompt || "").slice(0, 160));
          renderWatchdogPanel({ ts: d.ts, kind: "fire", stale: (d.stale || []).length, summary: String(d.prompt || "").slice(0, 220) });
        } catch {}
      });
      es.addEventListener("watchdog_ok", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLiveRow("watchdog", "ok", `${d.teams_tracked ?? 0} teams, ${d.stale ?? 0} stale`);
          renderWatchdogPanel({ ts: d.ts, kind: "ok", teams: d.teams_tracked ?? 0, stale: d.stale ?? 0 });
        } catch {}
      });
      es.addEventListener("message_update", (e) => {
        try {
          const d = JSON.parse(e.data);
          const ev = d.assistantMessageEvent;
          if (ev && ev.type === "toolcall_start") {
            const tc = ev.partial?.content?.[ev.contentIndex];
            if (tc && tc.name) appendLiveRow("tool", tc.name, "");
          }
        } catch {}
      });
      es.addEventListener("error", () => {
        try { es.close(); } catch {}
        setTimeout(connectSSE, 3000);
      });
    }
    connectSSE();

    // Polling refresh while the Orchestration tab is visible.
    refreshTeams();
    refreshHealth();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"orchestration\"]");
      if (panel && getComputedStyle(panel).display !== "none") {
        refreshTeams();
        refreshHealth();
      }
    }, 5000);
  }

  // ── Watchdogs panel (v2.7.19 + v2.7.35 rich diag) ─────────────────────
  // Collapsible card on the Orchestration tab. v2.7.35 swapped the
  // bare /api/watchdogs poll for /api/watchdogs/diag so each row carries
  // status (healthy/degraded/dead), tick history, recent notifications,
  // and last error. Each row gets a Details toggle that expands inline
  // to a sparkline + notification list + error box.
  //
  // Polls /api/watchdogs/diag every 10s while open. Kill stays
  // optimistic (row removes immediately, server reconciles on next
  // poll). Restart bounces the kill+re-arm round-trip and is only
  // enabled when the master reports `can_restart: true` for the row.
  function wireWatchdogPanel() {
    const panel = document.getElementById("watchdog-panel");
    const tbody = document.getElementById("watchdog-tbody");
    const table = document.getElementById("watchdog-table");
    const empty = document.getElementById("watchdog-empty");
    const countEl = document.getElementById("watchdog-count");
    const metaEl = document.getElementById("watchdog-meta");
    if (!panel || !tbody) return;

    let pollTimer = null;
    // Track which rows are expanded so refresh() preserves disclosure
    // state across polls. (Re-rendering the entire tbody is simpler than
    // diffing; the cost is one Set membership check per row.)
    const expandedIds = new Set();

    function fmtAgeSec(s) {
      if (typeof s !== "number" || !isFinite(s)) return "—";
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      return `${(s / 3600).toFixed(1)}h`;
    }

    function fmtLastTick(iso) {
      if (!iso) return "—";
      try {
        const ms = Date.parse(iso);
        if (!isFinite(ms)) return "—";
        const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
        return `${fmtAgeSec(ageSec)} ago`;
      } catch { return "—"; }
    }

    function escWd(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // Map status → { icon, label } pair. Icons are Lucide glyphs.
    function statusBadge(status) {
      const iconFn = (typeof window !== "undefined" && typeof window.subctlIcon === "function")
        ? window.subctlIcon : () => "";
      if (status === "healthy") {
        return { iconHtml: iconFn("heart-pulse", { size: 12 }), label: "healthy", cls: "watchdog-status-healthy" };
      }
      if (status === "degraded") {
        return { iconHtml: iconFn("alert-triangle", { size: 12 }), label: "degraded", cls: "watchdog-status-degraded" };
      }
      if (status === "dead") {
        return { iconHtml: iconFn("x-circle", { size: 12 }), label: "dead", cls: "watchdog-status-dead" };
      }
      return { iconHtml: iconFn("info", { size: 12 }), label: "unknown", cls: "watchdog-status-unknown" };
    }

    // Render the inline expand row (sparkline + notifications + error).
    // Width matches the table header (6 cols).
    function renderDetailRow(w) {
      const ticks = Array.isArray(w.tick_history) ? w.tick_history : [];
      const expected = typeof w.expected_interval_seconds === "number" ? w.expected_interval_seconds : null;
      // Sparkline: each tick = a bar whose colour reflects how late it
      // was vs the expected interval. Bar height encodes the delta in
      // relative terms (clamped). When expected is null/-1 (long-poll
      // or unknown), every bar gets the neutral healthy colour.
      const sparkBars = ticks.length === 0
        ? `<div class="watchdog-sparkline-empty">no ticks observed yet — observer polls every 500ms</div>`
        : (() => {
            // Compute max delta for height scaling; if all delta_ms are
            // null (only one tick) fall back to a uniform short bar.
            const deltas = ticks.map((t) => (typeof t.delta_ms === "number" ? t.delta_ms : 0));
            const maxDelta = Math.max(1, ...deltas);
            const bars = ticks.map((t, i) => {
              const dms = typeof t.delta_ms === "number" ? t.delta_ms : null;
              let cls = "";
              if (expected && expected > 0 && dms !== null) {
                const ratio = dms / (expected * 1000);
                if (ratio >= 5) cls = "very-late";
                else if (ratio >= 2) cls = "late";
              }
              const heightPct = dms === null ? 30 : Math.max(10, Math.min(100, (dms / maxDelta) * 100));
              const title = dms === null
                ? `first tick @ ${t.ts}`
                : `tick ${i + 1}/${ticks.length}: +${(dms / 1000).toFixed(2)}s @ ${t.ts}`;
              return `<div class="watchdog-sparkline-bar ${cls}" style="height:${heightPct}%" title="${escWd(title)}"></div>`;
            });
            return `<div class="watchdog-sparkline">${bars.join("")}</div>`;
          })();

      const notifs = Array.isArray(w.recent_notifications) ? w.recent_notifications : [];
      const notifList = notifs.length === 0
        ? `<div class="dim small">no notifications attributed to this watchdog</div>`
        : `<ul class="watchdog-notif-list">${notifs.slice().reverse().map((n) => `
            <li>
              <span class="watchdog-notif-sev ${escWd(n.severity || "info")}">${escWd(n.severity || "info")}</span>
              <span class="watchdog-notif-ts">${fmtLastTick(n.ts)}</span>
              <span class="watchdog-notif-title">${escWd(n.title || n.kind || "(no title)")}</span>
            </li>`).join("")}</ul>`;

      const errBlock = w.last_error
        ? `<div class="watchdog-detail-section">
             <h4>Last error · ${escWd(fmtLastTick(w.last_error.ts))}</h4>
             <div class="watchdog-error-box">${escWd(w.last_error.message || "(no message)")}${w.last_error.stack ? "\n\n" + escWd(w.last_error.stack) : ""}</div>
           </div>`
        : "";

      const expectedLabel = expected === null
        ? "unknown"
        : expected < 0
          ? "long-poll (no fixed cadence)"
          : `${expected}s`;

      return `
        <tr class="watchdog-detail-row" data-detail-for="${escWd(w.id)}">
          <td colspan="6">
            <div class="watchdog-detail-box">
              <div class="watchdog-detail-section">
                <h4>Metadata</h4>
                <dl class="watchdog-meta-kv">
                  <dt>started_at</dt><dd>${escWd(w.started_at || "—")}</dd>
                  <dt>last_tick_at</dt><dd>${escWd(w.last_tick_at || "—")}</dd>
                  <dt>expected interval</dt><dd>${escWd(expectedLabel)}</dd>
                  <dt>last tick ago</dt><dd>${w.last_tick_ago_seconds == null ? "—" : fmtAgeSec(w.last_tick_ago_seconds)}</dd>
                  <dt>can restart</dt><dd>${w.can_restart ? "yes" : "no (bounce master to re-arm)"}</dd>
                </dl>
              </div>
              <div class="watchdog-detail-section">
                <h4>Tick history (last ${ticks.length} of 20)</h4>
                ${sparkBars}
              </div>
              <div class="watchdog-detail-section">
                <h4>Recent notifications (last ${notifs.length} of 10)</h4>
                ${notifList}
              </div>
              ${errBlock}
            </div>
          </td>
        </tr>`;
    }

    async function refresh() {
      try {
        const r = await fetch("/api/watchdogs/diag", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const list = Array.isArray(j.watchdogs) ? j.watchdogs : [];
        if (countEl) {
          const dead = list.filter((w) => w.status === "dead").length;
          const degraded = list.filter((w) => w.status === "degraded").length;
          const tag = dead > 0 ? `${list.length} active · ${dead} dead`
            : degraded > 0 ? `${list.length} active · ${degraded} degraded`
            : `${list.length} active`;
          countEl.textContent = tag;
        }
        if (metaEl) metaEl.textContent = `polled ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
        if (list.length === 0) {
          if (empty) empty.style.display = "";
          if (empty) empty.textContent = "no watchdogs registered";
          if (table) table.hidden = true;
          tbody.innerHTML = "";
          return;
        }
        if (empty) empty.style.display = "none";
        if (table) table.hidden = false;
        // Master already sorts dead-first; preserve that order. Garbage
        // collect any expandedIds that no longer exist (killed
        // watchdogs).
        const liveIds = new Set(list.map((w) => w.id));
        for (const id of [...expandedIds]) {
          if (!liveIds.has(id)) expandedIds.delete(id);
        }
        tbody.innerHTML = list.map((w) => {
          const sb = statusBadge(w.status);
          const expanded = expandedIds.has(w.id);
          const restartDisabled = w.can_restart ? "" : "disabled title=\"this watchdog kind doesn't support hot-restart\"";
          const summaryRow = `
            <tr data-watchdog-id="${escWd(w.id)}" data-watchdog-status="${escWd(w.status)}">
              <td><code>${escWd(w.id)}</code></td>
              <td>${escWd(w.kind)}</td>
              <td><span class="watchdog-status-badge ${sb.cls}">${sb.iconHtml} ${escWd(sb.label)}</span></td>
              <td>${fmtAgeSec(w.age_seconds)}</td>
              <td>${fmtLastTick(w.last_tick_at)}</td>
              <td>
                <div class="watchdog-row-actions">
                  <button type="button" class="watchdog-expand-btn" data-expand-id="${escWd(w.id)}">${expanded ? "Hide" : "Details"}</button>
                  <button type="button" class="watchdog-restart-btn" data-restart-id="${escWd(w.id)}" ${restartDisabled}>Restart</button>
                  <button type="button" class="watchdog-kill-btn" data-kill-id="${escWd(w.id)}">Kill</button>
                </div>
              </td>
            </tr>`;
          const detailRow = expanded ? renderDetailRow(w) : "";
          return summaryRow + detailRow;
        }).join("");

        // Bind expand toggles. Cheaper to re-render the whole panel on
        // toggle (matches the refresh flow exactly) than to surgically
        // insert/remove the detail row.
        for (const btn of tbody.querySelectorAll("button[data-expand-id]")) {
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-expand-id");
            if (!id) return;
            if (expandedIds.has(id)) expandedIds.delete(id);
            else expandedIds.add(id);
            refresh();
          });
        }

        // Bind restart buttons. Server returns 404 when no factory is
        // registered — that should already be reflected by the disabled
        // attribute, but we surface any unexpected error to the user.
        for (const btn of tbody.querySelectorAll("button[data-restart-id]:not([disabled])")) {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-restart-id");
            if (!id) return;
            btn.disabled = true;
            btn.textContent = "restarting…";
            try {
              const r = await fetch(`/api/watchdogs/${encodeURIComponent(id)}/restart`, { method: "POST" });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || j.ok === false) {
                throw new Error(j && j.error ? j.error : `HTTP ${r.status}`);
              }
              setTimeout(refresh, 300);
            } catch (err) {
              btn.disabled = false;
              btn.textContent = "Restart";
              alert(`restart failed: ${err && err.message ? err.message : err}`);
            }
          });
        }

        // Bind kill buttons. Optimistic removal — server reconciles on
        // the next 10s tick. Catches a network failure and re-shows the
        // row by triggering an immediate refresh.
        for (const btn of tbody.querySelectorAll("button[data-kill-id]")) {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-kill-id");
            if (!id) return;
            const ok = window.confirm(`Kill watchdog "${id}"? Use Restart instead if you want to bounce + re-arm.`);
            if (!ok) return;
            btn.disabled = true;
            btn.textContent = "killing…";
            const row = btn.closest("tr");
            if (row) row.style.opacity = "0.5";
            try {
              const r = await fetch(`/api/watchdogs/${encodeURIComponent(id)}/kill`, { method: "POST" });
              if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
              expandedIds.delete(id);
              // Optimistic remove; refresh confirms.
              if (row) row.remove();
              setTimeout(refresh, 200);
            } catch (err) {
              btn.disabled = false;
              btn.textContent = "Kill";
              if (row) row.style.opacity = "1";
              alert(`kill failed: ${err && err.message ? err.message : err}`);
            }
          });
        }
      } catch (err) {
        if (empty) {
          empty.style.display = "";
          empty.textContent = `master unreachable: ${err && err.message ? err.message : err}`;
        }
        if (table) table.hidden = true;
        if (countEl) countEl.textContent = "—";
      }
    }

    function startPoll() {
      if (pollTimer) return;
      refresh();
      pollTimer = setInterval(refresh, 10_000);
    }
    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // The <details> element fires `toggle` when the user opens or closes.
    panel.addEventListener("toggle", () => {
      if (panel.open) startPoll();
      else stopPoll();
    });
    // If panel starts open (browser remembered state), kick off poll now.
    if (panel.open) startPoll();
  }

  // ---------- tmux preview modal ----------
  // Shared between the orchestration cockpit cards and the dashboard
  // Dev Teams panel. Polls /api/orchestration/<name> every 2s while open
  // and renders the captured pane content.
  // NOTE: `_tmuxPollTimer` was originally a sibling `let` to `_tmuxCurrent`
  // (app.js:1405–1406). It's been lifted to module scope above so
  // `unmount()` can clear it; `_tmuxCurrent` stays local — it's transient
  // per-modal state that the close() callback already nulls.
  let _tmuxCurrent = null;
  function openTmuxPreview(name) {
    const modal = document.getElementById("tmux-preview-modal");
    const nameEl = document.getElementById("tmux-preview-name");
    const statusEl = document.getElementById("tmux-preview-status");
    const metaEl = document.getElementById("tmux-preview-meta");
    const paneEl = document.getElementById("tmux-preview-pane");
    const closeBtn = document.getElementById("tmux-preview-close");
    const attachBtn = document.getElementById("tmux-preview-attach");
    if (!modal || !paneEl) return;
    _tmuxCurrent = name;
    nameEl.textContent = name;
    statusEl.textContent = "connecting…";
    statusEl.className = "tmux-preview-status";
    metaEl.textContent = "—";
    paneEl.textContent = "loading…";
    modal.hidden = false;

    async function tick() {
      if (_tmuxCurrent !== name) return; // stale, modal moved on
      try {
        const r = await fetch("/api/orchestration/" + encodeURIComponent(name));
        const j = await r.json();
        if (!j.ok) {
          statusEl.textContent = "error";
          statusEl.className = "tmux-preview-status err";
          paneEl.textContent = "load failed: " + (j.error || "?");
          return;
        }
        const s = j.session || {};
        statusEl.textContent = "live";
        statusEl.className = "tmux-preview-status live";
        const ageMin = s.created ? Math.floor((Date.now() / 1000 - s.created) / 60) : null;
        metaEl.textContent = `${s.path || "?"}  ·  ${s.attached ? "operator attached" : "running · headless"}  ·  ${s.windows ?? "?"} windows  ·  ${s.panes?.length ?? "?"} panes${ageMin !== null ? `  ·  ${ageMin}min old` : ""}`;
        paneEl.textContent = s.preview || "(empty pane)";
      } catch (err) {
        statusEl.textContent = "error";
        statusEl.className = "tmux-preview-status err";
        paneEl.textContent = "fetch error: " + err;
      }
    }
    tick();
    if (_tmuxPollTimer) clearInterval(_tmuxPollTimer);
    _tmuxPollTimer = setInterval(tick, 2000);

    function close() {
      if (_tmuxPollTimer) { clearInterval(_tmuxPollTimer); _tmuxPollTimer = null; }
      _tmuxCurrent = null;
      modal.hidden = true;
      closeBtn.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      attachBtn.removeEventListener("click", onAttach);
    }
    function onBackdrop(e) { if (e.target === modal) close(); }
    function onKey(e) { if (e.key === "Escape") close(); }
    function onAttach() {
      // TODO(v2.7): SSH_HOST_ALIAS is hardcoded; the master daemon may live on
      // a different host than the dashboard. Wire from policy.json/host_label.
      const cmd = `ssh ${SSH_HOST_ALIAS} -t tmux attach -t ${name}`;
      navigator.clipboard.writeText(cmd);
      attachBtn.textContent = "copied ✓";
      setTimeout(() => { attachBtn.textContent = "copy ssh attach command"; }, 1500);
    }
    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    attachBtn.addEventListener("click", onAttach);
  }
  function copyAttachCommand(name, btn) {
    // TODO(v2.7): see onAttach() — same SSH-host hardcoding caveat.
    const cmd = `ssh ${SSH_HOST_ALIAS} -t tmux attach -t ${name}`;
    navigator.clipboard.writeText(cmd);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = "copied ✓";
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  }

  // ---------- v2.7.21 (ADR 0011 L2): web terminal modal driver ----------
  // The Attach (web terminal) button per team card calls openWebTerminal,
  // which mounts xterm.js (via window.subctlTerminal.mount from
  // /terminal.js) into #terminal-host and shows the modal.
  let _termModalKeyHandler = null;
  function openWebTerminal(teamName) {
    const modal = document.getElementById("terminal-modal");
    const host = document.getElementById("terminal-host");
    const nameEl = document.getElementById("terminal-modal-name");
    const closeBtn = document.getElementById("terminal-modal-close");
    if (!modal || !host || !window.subctlTerminal) return;
    nameEl.textContent = teamName;
    modal.hidden = false;
    // Wait one frame so the host element has its final size, then mount.
    requestAnimationFrame(() => {
      window.subctlTerminal.mount(host, teamName);
    });
    function close() {
      try { window.subctlTerminal.close(); } catch (_) {}
      modal.hidden = true;
      closeBtn.removeEventListener("click", close);
      modal.removeEventListener("click", onBackdrop);
      if (_termModalKeyHandler) {
        document.removeEventListener("keydown", _termModalKeyHandler);
        _termModalKeyHandler = null;
      }
    }
    function onBackdrop(e) { if (e.target === modal) close(); }
    _termModalKeyHandler = (e) => { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", _termModalKeyHandler);
  }

  // Gate: hit /api/terminal/enabled once on boot. If the flag file is
  // absent (default OFF), apply body.terminal-disabled so CSS hides
  // every Attach button + the modal.
  async function wireWebTerminalGate() {
    const apply = (enabled) => {
      document.body.classList.toggle("terminal-disabled", !enabled);
    };
    apply(false); // start hidden, flip on if the server says yes
    try {
      const r = await fetch("/api/terminal/enabled");
      const j = await r.json();
      apply(Boolean(j && j.ok && j.enabled));
    } catch (_) {
      // Fail closed — leave the disabled class on.
    }
  }

  // ── Boot wirers — mirror app.js boot order (455, 456, 460, 1395). The
  //    original web-terminal gate was fire-and-forget at line 460 inside
  //    a synchronous IIFE block, so we preserve that semantic with `void`
  //    rather than `await` (the gate flips a body class once /api/
  //    terminal/enabled resolves; nothing downstream needs to block).
  wireOrchestrationCockpit();
  wireOrchCameraGrid();
  void wireWebTerminalGate();
  wireWatchdogPanel();

  // ── Publish 4 globals — verbatim from app.js:1487, 1488, 1523, 1542.
  //    Consumers (app.js shell + extracted tabs) read these directly
  //    off `window`. See top-of-file note for the deferred-retirement
  //    reasoning. The fifth global previously published here
  //    (window.notice) was reclaimed to app.js — it's a shell-level
  //    notification system, not tab-scoped.
  window.__subctlOpenTmuxPreview = openTmuxPreview;
  window.__subctlCopyAttachCommand = copyAttachCommand;
  window.__subctlOpenWebTerminal = openWebTerminal;
  window.__subctlWireWebTerminalGate = wireWebTerminalGate;
}

export function unmount() {
  if (_tmuxPollTimer) { clearInterval(_tmuxPollTimer); _tmuxPollTimer = null; }
  window.__subctlOpenTmuxPreview = null;
  window.__subctlCopyAttachCommand = null;
  window.__subctlOpenWebTerminal = null;
  window.__subctlWireWebTerminalGate = null;
}
