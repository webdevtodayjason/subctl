// subctl dashboard frontend
// Connects to /api/live (WebSocket); on failure falls back to polling /api/state.
(() => {
  "use strict";

  const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const VERDICT_TEXT = { green: "GO", yellow: "HOLD", red: "STOP" };
  const VERDICT_DOT  = { green: "green", yellow: "yellow", red: "red" };

  const $ = (id) => document.getElementById(id);

  function fmtAge(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  function sparkline(buckets) {
    if (!buckets || buckets.length === 0) return "";
    const max = Math.max(...buckets);
    if (max === 0) return SPARK_CHARS[0].repeat(buckets.length);
    return buckets.map((v) => {
      if (v === 0) return SPARK_CHARS[0];
      const idx = Math.min(SPARK_CHARS.length - 1,
        Math.max(1, Math.round((v / max) * (SPARK_CHARS.length - 1))));
      return SPARK_CHARS[idx];
    }).join("");
  }

  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  function renderClock() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    setText($("clock"), `${hh}:${mm}:${ss}`);
  }
  setInterval(renderClock, 1000);
  renderClock();

  function setStatus(kind, text) {
    const pill = $("status-pill");
    const dot = pill.querySelector(".dot");
    const label = pill.querySelector(".status-text");
    dot.className = `dot ${kind}`;
    setText(label, text);
  }

  function render(state) {
    if (!state) return;

    setText($("version"), `v${state.version}`);
    setText($("footer-version"), `v${state.version}`);

    // Dispatch verdict
    const verdict = state.dispatch?.verdict ?? "red";
    const verdictEl = $("dispatch-verdict");
    verdictEl.className = `dispatch-verdict ${verdict}`;
    setText(verdictEl, VERDICT_TEXT[verdict] ?? "—");
    const reasons = state.dispatch?.reasons ?? [];
    const reasonsEl = $("dispatch-reasons");
    reasonsEl.replaceChildren(
      ...(reasons.length === 0
        ? [textRow("all systems clear")]
        : reasons.map(textRow))
    );

    // Service status pill
    if (state.service?.running) {
      setStatus(VERDICT_DOT[verdict] ?? "green", `running · ${fmtAge(state.service.uptime_seconds)}`);
    } else {
      setStatus("red", "service down");
    }

    // Accounts table
    const accountsBody = $("accounts-body");
    const accounts = state.accounts ?? [];
    if (accounts.length === 0) {
      accountsBody.replaceChildren(emptyRow(6, "no accounts configured"));
    } else {
      accountsBody.replaceChildren(...accounts.map((a) => {
        const tr = document.createElement("tr");
        tr.append(
          td(a.alias),
          td(a.provider),
          td(authCell(a.auth_status)),
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
    const sessionsBody = $("sessions-body");
    const sessions = state.sessions ?? [];
    if (sessions.length === 0) {
      sessionsBody.replaceChildren(emptyRow(7, "no active sessions"));
    } else {
      sessionsBody.replaceChildren(...sessions.map((s) => {
        const tr = document.createElement("tr");
        tr.append(
          td(s.id),
          td(s.account),
          td(s.repo),
          td(s.branch),
          td(`${s.ctx_pct}%`, "num"),
          td(fmtAge(s.age_seconds), "num"),
          td(s.model),
        );
        return tr;
      }));
    }

    // Rate limits
    const rlBody = $("rate-limits-body");
    const rl = state.rate_limits?.by_account ?? [];
    if (rl.length === 0) {
      rlBody.replaceChildren(textDiv("no data yet", "empty"));
    } else {
      rlBody.replaceChildren(...rl.map((r) => {
        const row = document.createElement("div");
        row.className = "rl-row";
        const acct = document.createElement("span");
        acct.className = "rl-account";
        acct.textContent = r.account;
        const spark = document.createElement("span");
        const spk = sparkline(r.buckets_24h);
        spark.className = "rl-spark" + (r.count_today === 0 ? " zero" : "");
        spark.textContent = spk;
        const count = document.createElement("span");
        count.className = "rl-count" + (r.count_today > 0 ? " hot" : "");
        count.textContent = `${r.count_today} today`;
        row.append(acct, spark, count);
        return row;
      }));
    }
    setText($("rl-total"), `Total today: ${state.rate_limits?.today_total ?? 0}`);
  }

  function td(content, cls) {
    const cell = document.createElement("td");
    if (cls) cell.className = cls;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    return cell;
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

  function emptyRow(cols, msg) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = cols;
    cell.className = "empty";
    cell.textContent = msg;
    tr.appendChild(cell);
    return tr;
  }

  function textRow(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div;
  }
  function textDiv(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    return div;
  }

  // ----- transport: WS with polling fallback -----

  let ws = null;
  let pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    const tick = async () => {
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        render(await r.json());
      } catch (e) {
        setStatus("red", "offline");
      }
    };
    tick();
    pollTimer = setInterval(tick, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/live`);
    } catch {
      startPolling();
      return;
    }
    ws.addEventListener("open",  () => stopPolling());
    ws.addEventListener("message", (ev) => {
      try { render(JSON.parse(ev.data)); } catch { /* ignore malformed */ }
    });
    ws.addEventListener("close", () => {
      // Fall back to polling and try to re-establish WS in 5s.
      startPolling();
      setTimeout(connectWS, 5000);
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* swallow */ }
    });
  }

  connectWS();
})();
