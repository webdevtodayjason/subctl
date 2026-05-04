// subctl dashboard frontend
//
// Connects to /api/live (WebSocket); on failure falls back to polling /api/state.
// On WebSocket message, flashes the refresh pulse dot.
// If WS is closed > 5 seconds, surfaces a RECONNECTING… pill in the header.

(() => {
  "use strict";

  const VERDICT_TEXT     = { green: "GO",   yellow: "HOLD",  red: "STOP"  };
  const VERDICT_TAGLINE  = {
    green:  "all clear — dispatch normally",
    yellow: "proceed with caution",
    red:    "do not dispatch this wave",
  };
  const VERDICT_GLYPH    = { green: "🟢", yellow: "🟡", red: "🔴" };
  const VERDICT_DOT      = { green: "green", yellow: "yellow", red: "red" };

  const $ = (id) => document.getElementById(id);

  // ----- Manual refresh button -----
  // Calls /api/refresh which clears the in-process + on-disk usage caches and
  // pushes a fresh state to all open WebSocket clients. Disabled briefly after
  // each click to discourage rapid mashing (auto-poll runs every 5min).
  function wireRefreshButton() {
    const btn = $("refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("spinning");
      try {
        const r = await fetch("/api/refresh", { method: "POST" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // The server pushes the fresh state via WS; nothing else to do.
      } catch (err) {
        // Visual nudge on failure: brief red flash via title.
        btn.title = `refresh failed: ${err}; will retry on next 5-min poll`;
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove("spinning");
        }, 1500);
      }
    });
  }

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

  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }

  // ----- Clock -----

  function renderClock() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    setText($("clock"), `${hh}:${mm}:${ss}`);
  }
  setInterval(renderClock, 1000);
  renderClock();
  wireRefreshButton();

  // ----- Status pill -----

  let reconnectingTimer = null;

  function setStatus(kind, text) {
    const pill = $("status-pill");
    const dot = pill.querySelector(".dot");
    const label = pill.querySelector(".status-text");
    pill.classList.remove("reconnecting");
    dot.className = `dot ${kind}`;
    setText(label, text);
  }

  function setReconnecting() {
    const pill = $("status-pill");
    pill.classList.add("reconnecting");
    const dot = pill.querySelector(".dot");
    const label = pill.querySelector(".status-text");
    dot.className = "dot yellow";
    setText(label, "reconnecting…");
  }

  // Refresh pulse — flash on every WS message.
  let pulseClearTimer = null;
  function flashPulse() {
    const dot = $("pulse-dot");
    if (!dot) return;
    dot.classList.add("flash");
    if (pulseClearTimer) clearTimeout(pulseClearTimer);
    pulseClearTimer = setTimeout(() => dot.classList.remove("flash"), 200);
  }

  // ----- Render -----

  // Track expanded sessions across renders so toggling state survives re-paints.
  const expandedSessions = new Set();

  function render(state) {
    if (!state) return;

    setText($("version"), `v${state.version}`);
    setText($("footer-version"), `v${state.version}`);

    // Header uptime
    if (state.service?.uptime_seconds != null) {
      setText($("uptime"), `running ${fmtAge(state.service.uptime_seconds)}`);
    }

    // Info strip totals
    const totals = state.totals ?? {};
    setText($("info-tmux"),  String(totals.tmux_sessions   ?? 0));
    setText($("info-ready"), String(totals.ready_accounts  ?? 0));
    setText($("info-rl"),    String(totals.rl_today        ?? 0));

    // Dispatch verdict
    const verdict = state.dispatch?.verdict ?? "red";
    const verdictEl = $("dispatch-verdict");
    verdictEl.className = `dispatch-verdict ${verdict}`;
    setText(verdictEl, `${VERDICT_GLYPH[verdict] ?? ""} ${VERDICT_TEXT[verdict] ?? "—"}`.trim());
    setText($("dispatch-tagline"), VERDICT_TAGLINE[verdict] ?? "");

    const reasons = state.dispatch?.reasons ?? [];
    const reasonsEl = $("dispatch-reasons");
    if (reasons.length === 0) {
      const li = document.createElement("li");
      li.className = "clear";
      li.textContent = "all systems clear";
      reasonsEl.replaceChildren(li);
    } else {
      reasonsEl.replaceChildren(...reasons.map(r => {
        const li = document.createElement("li");
        li.textContent = r;
        return li;
      }));
    }

    // Service status pill (only if not currently in reconnecting state)
    if (state.service?.running) {
      const pill = $("status-pill");
      if (!pill.classList.contains("reconnecting")) {
        setStatus(VERDICT_DOT[verdict] ?? "green",
                  `live · ${fmtAge(state.service.uptime_seconds)}`);
      }
    }

    // Accounts table
    const accountsBody = $("accounts-body");
    const accounts = state.accounts ?? [];
    if (accounts.length === 0) {
      accountsBody.replaceChildren(emptyRow(9, "no accounts configured"));
    } else {
      accountsBody.replaceChildren(...accounts.map((a) => {
        const tr = document.createElement("tr");
        const fiveH = a.usage?.five_hour?.utilization;
        const sevenD = a.usage?.seven_day?.utilization;
        const sonnetD = a.usage?.seven_day_sonnet?.utilization;
        tr.append(
          td(acctPill(a.alias, a.color_class)),
          td(a.provider),
          td(authCell(a.auth_status)),
          td(verdictPill(a.dispatch?.verdict, a.dispatch?.reasons)),
          td(usagePctCell(fiveH, [80, 95]), "num"),
          td(usageBarCell(sevenD, sonnetD), "num"),
          td(String(a.active_sessions), "num"),
          td(String(a.rl_hits_today), "num"),
          td(fmtAge(a.last_activity_seconds_ago)),
        );
        return tr;
      }));
    }
    const warnEl = $("accounts-warning");
    if (state.warning) {
      setText(warnEl, state.warning);
      warnEl.hidden = false;
    } else {
      warnEl.hidden = true;
    }

    // Sessions table
    renderSessions(state.sessions ?? []);

    // Rate limits
    renderRateLimits(state.rate_limits ?? { today_total: 0, by_account: [] });
    renderEvents(state.rate_limits?.events_today ?? []);
  }

  function renderSessions(sessions) {
    const sessionsBody = $("sessions-body");
    if (sessions.length === 0) {
      sessionsBody.replaceChildren(emptyRow(9, "no tmux sessions"));
      return;
    }

    const rows = [];
    for (const s of sessions) {
      const isOpen = expandedSessions.has(s.name);

      // Session main row
      const tr = document.createElement("tr");
      tr.className = "session-row" + (isOpen ? " open" : "");
      tr.dataset.session = s.name;
      tr.addEventListener("click", () => toggleSession(s.name));

      const exp = document.createElement("span");
      exp.className = "expander";
      exp.textContent = "▶";

      tr.append(
        td(exp),
        td(sessionNameCell(s)),
        td(acctPill(s.account, s.color_class)),
        td(s.project),
        td(s.branch),
        td(ctxCell(s.ctx_pct, s.ctx_color), "num"),
        td(ageCell(s.age_seconds, s.age_color), "num"),
        td(statusCell(s.status)),
        td(s.command || "—"),
      );
      rows.push(tr);

      // Preview row (always present, hidden by default)
      const prevTr = document.createElement("tr");
      prevTr.className = "preview-row" + (isOpen ? " open" : "");
      const prevTd = document.createElement("td");
      prevTd.colSpan = 9;
      const meta = document.createElement("div");
      meta.className = "preview-meta";
      meta.append(
        metaItem("session", s.name),
        metaItem("path", s.path || "—"),
        metaItem("panes", `${s.panes}${s.attached ? " (attached)" : ""}`),
        metaItem("RL today", String(s.rl_today)),
        metaItem("email", s.account_email || "—"),
      );
      const pre = document.createElement("pre");
      pre.className = "preview-block";
      pre.textContent = s.preview && s.preview.trim().length > 0
        ? s.preview
        : "(no recent output captured)";
      prevTd.append(meta, pre);
      prevTr.appendChild(prevTd);
      rows.push(prevTr);
    }
    sessionsBody.replaceChildren(...rows);
  }

  function toggleSession(name) {
    if (expandedSessions.has(name)) expandedSessions.delete(name);
    else expandedSessions.add(name);
    // Targeted DOM update to avoid full re-render flicker.
    const rows = document.querySelectorAll(
      `.session-row[data-session="${CSS.escape(name)}"]`
    );
    rows.forEach(r => {
      r.classList.toggle("open");
      const next = r.nextElementSibling;
      if (next && next.classList.contains("preview-row")) next.classList.toggle("open");
    });
  }

  function renderRateLimits(rl) {
    const rlBody = $("rate-limits-body");
    const rows = rl.by_account ?? [];
    if (rows.length === 0) {
      rlBody.replaceChildren(textDiv("no accounts to track", "empty"));
    } else {
      rlBody.replaceChildren(...rows.map((r) => {
        const row = document.createElement("div");
        row.className = "rl-row";

        const acct = acctPill(r.account, r.color_class);
        acct.classList.add("rl-account");

        const bars = document.createElement("div");
        bars.className = "rl-bars";

        // Each cell = 1 hour of trailing 24h, oldest → newest.
        // Height/color = max five_hour utilization observed that hour from
        // /api/oauth/usage polling. Empty hours render dim. A 429 event in
        // an hour overlays a small red dot on top of that hour's cell.
        const hist = r.usage_history_24h ?? new Array(24).fill({ five_hour_max: null, samples: 0 });
        const events = r.buckets_24h ?? new Array(24).fill(0);
        for (let i = 0; i < 24; i++) {
          const slot = hist[i] ?? { five_hour_max: null, samples: 0 };
          const evCount = events[i] ?? 0;
          const cell = document.createElement("div");
          cell.className = "rl-bar";
          let pct = 0;
          let cls = "zero";
          if (typeof slot.five_hour_max === "number") {
            pct = Math.max(8, Math.min(100, Math.round(slot.five_hour_max)));
            if (slot.five_hour_max >= 95)      cls = "red";
            else if (slot.five_hour_max >= 80) cls = "yellow";
            else if (slot.five_hour_max >= 50) cls = "warm";
            else                               cls = "ok";
          }
          cell.classList.add(cls);
          const bar = document.createElement("span");
          bar.style.height = `${pct}%`;
          cell.appendChild(bar);
          if (evCount > 0) {
            const dot = document.createElement("span");
            dot.className = "rl-event-dot";
            cell.appendChild(dot);
          }
          if (typeof slot.five_hour_max === "number") {
            cell.title = `5h util max: ${slot.five_hour_max}%${evCount > 0 ? `  ·  ${evCount} RL event${evCount === 1 ? "" : "s"}` : ""}  ·  ${slot.samples} sample${slot.samples === 1 ? "" : "s"}`;
          } else {
            cell.title = evCount > 0 ? `${evCount} RL event${evCount === 1 ? "" : "s"} (no util sample)` : "no data";
          }
          bars.appendChild(cell);
        }

        const count = document.createElement("span");
        count.className = "rl-count" + (r.count_today > 0 ? " hot" : "");
        count.textContent = `${r.count_today} today`;

        row.append(acct, bars, count);
        return row;
      }));
    }
    const recent429 = rl.recent_429_count ?? 0;
    const total = rl.today_total ?? 0;
    let label = `Total today: ${total}`;
    if (total > 0) {
      label += `  ·  ${recent429} actionable in last 2h (429s only — 529s are server overload, informational)`;
    }
    setText($("rl-total"), label);
  }

  function renderEvents(events) {
    const tbody = $("events-body");
    if (!events || events.length === 0) {
      tbody.replaceChildren(rowEmpty(5, "no rate-limit events today"));
      return;
    }
    tbody.replaceChildren(...events.map(ev => {
      const tr = document.createElement("tr");
      tr.className = "event-row";

      // WHEN — relative time, with ISO on hover.
      const whenCell = td(formatAge(ev.age_seconds) + " ago", "ev-when");
      whenCell.title = ev.ts || "";
      tr.appendChild(whenCell);

      // TYPE
      tr.appendChild(td(ev.type || "unknown", "ev-type"));

      // SEVERITY badge
      const sevCell = document.createElement("td");
      const sev = document.createElement("span");
      if (ev.is_user_rate_limit) {
        sev.className = "ev-sev sev-warn";
        sev.textContent = "your limit";
        sev.title = "429 — your account hit a per-minute or daily cap. Worth slowing down.";
      } else {
        sev.className = "ev-sev sev-info";
        sev.textContent = "server overload";
        sev.title = "529 — Anthropic's servers were temporarily at capacity. Not your fault, retry usually succeeds.";
      }
      sevCell.appendChild(sev);
      tr.appendChild(sevCell);

      // ACCOUNT (color-coded)
      const acctCell = document.createElement("td");
      acctCell.className = "ev-account";
      if (ev.account) {
        acctCell.appendChild(acctPill(ev.account, ev.account_color_class || "grey"));
      } else {
        acctCell.appendChild(textDiv("(unknown — older event)", "ev-account-unknown"));
      }
      tr.appendChild(acctCell);

      // SESSION — short hash, full on hover
      const sidCell = td((ev.session || "").slice(0, 8), "ev-session");
      sidCell.title = ev.session || "";
      tr.appendChild(sidCell);

      return tr;
    }));
  }

  function rowEmpty(cols, text) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = cols;
    cell.className = "empty";
    cell.textContent = text;
    tr.appendChild(cell);
    return tr;
  }

  function formatAge(s) {
    if (!s) return "just now";
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? h + "h" + (m < 10 ? "0" : "") + m + "m" : h + "h";
  }

  // ----- Cell builders -----

  function td(content, cls) {
    const cell = document.createElement("td");
    if (cls) cell.className = cls;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    return cell;
  }

  function acctPill(alias, colorClass) {
    const span = document.createElement("span");
    span.className = `acct-pill acct-${colorClass || "grey"}`;
    const dot = document.createElement("span");
    dot.className = "acct-dot";
    const name = document.createElement("span");
    name.textContent = alias;
    span.append(dot, name);
    return span;
  }

  function verdictPill(verdict, reasons) {
    const span = document.createElement("span");
    const v = verdict || "red";
    span.className = `verdict-pill verdict-${v}`;
    span.textContent = `${VERDICT_GLYPH[v] || ""} ${VERDICT_TEXT[v] || "—"}`.trim();
    if (Array.isArray(reasons) && reasons.length > 0) span.title = reasons.join("\n");
    return span;
  }

  function usagePctCell(pct, [yellow, red]) {
    const span = document.createElement("span");
    if (typeof pct !== "number") { span.className = "usage-na"; span.textContent = "—"; return span; }
    let cls = "green";
    if (pct >= red) cls = "red";
    else if (pct >= yellow) cls = "yellow";
    span.className = `usage-cell ${cls}`;
    span.textContent = `${pct}%`;
    return span;
  }

  // Weekly bar with primary (all-models) fill plus a dim overlay marking
  // the Sonnet-only slice. Mirrors the visual language of `/usage` in Claude
  // Code's TUI.
  function usageBarCell(pctAll, pctSonnet) {
    if (typeof pctAll !== "number") {
      const s = document.createElement("span");
      s.className = "usage-na";
      s.textContent = "—";
      return s;
    }
    const wrap = document.createElement("span");
    wrap.className = "usage-bar-wrap";
    let cls = "green";
    if (pctAll >= 90) cls = "red";
    else if (pctAll >= 70) cls = "yellow";
    const bar = document.createElement("span");
    bar.className = `usage-bar usage-bar-${cls}`;
    bar.style.width = `${Math.min(100, pctAll)}%`;
    const txt = document.createElement("span");
    txt.className = "usage-bar-text";
    if (typeof pctSonnet === "number" && pctSonnet > 0) {
      txt.textContent = `${pctAll}% (S ${pctSonnet}%)`;
    } else {
      txt.textContent = `${pctAll}%`;
    }
    wrap.append(bar, txt);
    return wrap;
  }

  function authCell(status) {
    const span = document.createElement("span");
    if (status === "ready") {
      span.className = "auth-ready";
      span.textContent = "✓ ready";
    } else {
      span.className = "auth-not";
      span.textContent = "⚠ not authenticated";
    }
    return span;
  }

  function ctxCell(pct, color) {
    const span = document.createElement("span");
    span.className = `ctx-cell ${color || "green"}`;
    span.textContent = `${pct}%`;
    return span;
  }

  function ageCell(seconds, color) {
    const span = document.createElement("span");
    span.className = `age-cell ${color || "green"}`;
    span.textContent = fmtAge(seconds);
    return span;
  }

  function statusCell(status) {
    const span = document.createElement("span");
    span.className = `status-cell ${status || "unknown"}`;
    const glyph = status === "working" ? "● " : status === "waiting" ? "◔ " : status === "idle" ? "◌ " : "· ";
    span.textContent = `${glyph}${status || "unknown"}`;
    return span;
  }

  function sessionNameCell(s) {
    const span = document.createElement("span");
    span.textContent = s.name;
    if (s.attached) {
      const a = document.createElement("span");
      a.className = "attached-mark";
      a.textContent = "•";
      a.title = "attached";
      span.appendChild(a);
    }
    return span;
  }

  function metaItem(label, value) {
    const s = document.createElement("span");
    const k = document.createElement("strong");
    k.textContent = `${label}: `;
    s.appendChild(k);
    s.appendChild(document.createTextNode(value));
    return s;
  }

  function emptyRow(cols, msg) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = cols;
    cell.className = "empty";
    cell.textContent = msg;
    tr.appendChild(cell);
    return tr;
  }

  function textDiv(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    return div;
  }

  // ----- transport: WS with polling fallback + reconnect -----

  let ws = null;
  let pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    const tick = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        flashPulse();
        render(await r.json());
      } catch {
        if (!$("status-pill").classList.contains("reconnecting")) {
          setStatus("red", "offline");
        }
      }
    };
    tick();
    pollTimer = setInterval(tick, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function scheduleReconnectingBadge() {
    if (reconnectingTimer) clearTimeout(reconnectingTimer);
    reconnectingTimer = setTimeout(() => {
      // Only show if WS still hasn't reconnected.
      if (!ws || ws.readyState !== 1) setReconnecting();
    }, 5000);
  }

  function clearReconnectingBadge() {
    if (reconnectingTimer) { clearTimeout(reconnectingTimer); reconnectingTimer = null; }
    $("status-pill").classList.remove("reconnecting");
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/live`);
    } catch {
      startPolling();
      scheduleReconnectingBadge();
      return;
    }
    ws.addEventListener("open", () => {
      stopPolling();
      clearReconnectingBadge();
    });
    ws.addEventListener("message", (ev) => {
      flashPulse();
      try { render(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
    });
    ws.addEventListener("close", () => {
      // Fall back to polling and try to re-establish WS in 3s.
      startPolling();
      scheduleReconnectingBadge();
      setTimeout(connectWS, 3000);
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* swallow */ }
    });
  }

  // Kick off — also try polling immediately so first paint isn't blocked
  // on the WS handshake.
  startPolling();
  connectWS();
})();
