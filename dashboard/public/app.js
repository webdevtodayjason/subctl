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

  // Live countdown: "1d 16h 22m" or "2h 14m" or "47s". Negative or invalid → "—".
  function fmtCountdown(targetMs) {
    if (!Number.isFinite(targetMs)) return "—";
    const diff = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
    if (diff <= 0) return "now";
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }

  // Format absolute reset time as a friendly local string: "May 6, 8:59am"
  function fmtResetAbs(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "—";
    const month = d.toLocaleString("en-US", { month: "short" });
    const day = d.getDate();
    let h = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12; if (h === 0) h = 12;
    return `${month} ${day}, ${h}:${mins}${ampm}`;
  }

  // Two-line cell: utilization % on top, "resets in 2h 14m" countdown beneath.
  // The countdown auto-updates every second via the global timer.
  function usagePctCellWithReset(pct, resetIso, [yellow, red]) {
    const wrap = document.createElement("span");
    wrap.className = "usage-cell-stack";
    const top = document.createElement("span");
    if (typeof pct !== "number") {
      top.className = "usage-na";
      top.textContent = "—";
    } else {
      let cls = "green";
      if (pct >= red) cls = "red";
      else if (pct >= yellow) cls = "yellow";
      top.className = `usage-cell ${cls}`;
      top.textContent = `${pct}%`;
    }
    wrap.appendChild(top);
    if (resetIso) {
      const t = Date.parse(resetIso);
      if (Number.isFinite(t)) {
        const sub = document.createElement("span");
        sub.className = "reset-countdown";
        sub.dataset.resetMs = String(t);
        sub.textContent = fmtCountdown(t);
        sub.title = `Resets ${fmtResetAbs(resetIso)}`;
        wrap.appendChild(sub);
      }
    }
    return wrap;
  }

  function usageBarCellWithReset(pctAll, pctSonnet, resetIso) {
    const wrap = document.createElement("span");
    wrap.className = "usage-cell-stack";
    wrap.appendChild(usageBarCell(pctAll, pctSonnet));
    if (resetIso) {
      const t = Date.parse(resetIso);
      if (Number.isFinite(t)) {
        const sub = document.createElement("span");
        sub.className = "reset-countdown";
        sub.dataset.resetMs = String(t);
        sub.textContent = fmtCountdown(t);
        sub.title = `Resets ${fmtResetAbs(resetIso)}`;
        wrap.appendChild(sub);
      }
    }
    return wrap;
  }

  // Per-second tick that updates every visible reset-countdown element.
  setInterval(() => {
    const els = document.querySelectorAll(".reset-countdown");
    for (const el of els) {
      const t = Number(el.dataset.resetMs);
      if (Number.isFinite(t)) el.textContent = fmtCountdown(t);
    }
  }, 1000);

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

  // ----- Verdict-transition notifications -----
  // Track the previous global + per-account verdicts. When any flip from green
  // to yellow/red (or vice-versa), fire a desktop notification so the user
  // knows even with the tab in the background. Permission is requested once
  // on first state arrival.

  let _notifyAsked = false;
  let _prevGlobalVerdict = null;
  const _prevAccountVerdicts = new Map();

  function maybeRequestNotifyPermission() {
    if (_notifyAsked) return;
    _notifyAsked = true;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }
  function fireNotify(title, body) {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try { new Notification(`subctl · ${title}`, { body, silent: false, tag: "subctl-verdict" }); } catch { /* ignore */ }
  }
  function severity(v) { return ({ green: 0, yellow: 1, red: 2 }[v] ?? -1); }
  function notifyOnVerdictChange(state) {
    maybeRequestNotifyPermission();
    const newGlobal = state?.dispatch?.verdict;
    if (newGlobal && _prevGlobalVerdict && newGlobal !== _prevGlobalVerdict) {
      const worse = severity(newGlobal) > severity(_prevGlobalVerdict);
      fireNotify(
        `${_prevGlobalVerdict.toUpperCase()} → ${newGlobal.toUpperCase()}`,
        worse ? "Dispatch readiness degraded — check the dashboard."
              : "Dispatch readiness recovered — clear to dispatch.",
      );
    }
    _prevGlobalVerdict = newGlobal ?? _prevGlobalVerdict;
    for (const a of (state?.accounts ?? [])) {
      const newV = a.dispatch?.verdict;
      if (!newV) continue;
      const prevV = _prevAccountVerdicts.get(a.alias);
      if (prevV && newV !== prevV) {
        const worse = severity(newV) > severity(prevV);
        fireNotify(
          `${a.alias}: ${prevV.toUpperCase()} → ${newV.toUpperCase()}`,
          worse
            ? `Account ${a.alias} entered ${newV}. ${(a.dispatch.reasons || []).join("; ")}`
            : `Account ${a.alias} recovered to ${newV}.`,
        );
      }
      _prevAccountVerdicts.set(a.alias, newV);
    }
  }

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

    // Verdict transition notifications (no-op until permission granted).
    notifyOnVerdictChange(state);

    // Dispatch verdict
    const verdict = state.dispatch?.verdict ?? "red";
    const verdictEl = $("dispatch-verdict");
    verdictEl.className = `dispatch-verdict ${verdict}`;
    setText(verdictEl, `${VERDICT_GLYPH[verdict] ?? ""} ${VERDICT_TEXT[verdict] ?? "—"}`.trim());

    // Best-account hint when the global verdict is GO: surface which account
    // has the most headroom so the user doesn't have to scan the table.
    let tagline = VERDICT_TAGLINE[verdict] ?? "";
    if (verdict === "green") {
      const greenAccts = (state.accounts ?? []).filter(a => a.dispatch?.verdict === "green");
      if (greenAccts.length > 0) {
        const best = greenAccts.reduce((b, a) => {
          const bw = b.usage?.seven_day?.utilization ?? 0;
          const aw = a.usage?.seven_day?.utilization ?? 0;
          return aw < bw ? a : b;
        });
        const bw = best.usage?.seven_day?.utilization;
        const wkly = (typeof bw === "number") ? `${bw}% weekly` : "wide open";
        tagline = `all clear · ${best.alias} has the most headroom (${wkly})`;
      }
    }
    setText($("dispatch-tagline"), tagline);

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
      accountsBody.replaceChildren(emptyRow(10, "no accounts configured"));
    } else {
      accountsBody.replaceChildren(...accounts.map((a) => {
        const tr = document.createElement("tr");
        const fiveH = a.usage?.five_hour?.utilization;
        const sevenD = a.usage?.seven_day?.utilization;
        const sonnetD = a.usage?.seven_day_sonnet?.utilization;
        const fiveResetIso = a.usage?.five_hour?.resets_at;
        const weekResetIso = a.usage?.seven_day?.resets_at;
        tr.append(
          td(acctPill(a.alias, a.color_class)),
          td(a.provider),
          td(authCell(a.auth_status)),
          td(verdictPill(a.dispatch?.verdict, a.dispatch?.reasons)),
          td(copyAliasButton(a.alias)),
          td(usagePctCellWithReset(fiveH, fiveResetIso, [80, 95]), "num"),
          td(usageBarCellWithReset(sevenD, sonnetD, weekResetIso), "num"),
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
    renderCost(state.cost ?? { this_month: [], totals: { api_cost_month_usd: 0, subscription_total_usd: 0, savings_month_usd: 0 } });
    renderRateLimits(state.rate_limits ?? { today_total: 0, by_account: [] });
    renderEvents(state.rate_limits?.events_today ?? []);
    renderConversations(state.active_conversations ?? []);
    populateSearchAccountFilter(state.accounts ?? []);
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

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  function fmtTokens(n) {
    if (!Number.isFinite(n) || n === 0) return "0";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  function renderCost(cost) {
    const summary = $("cost-summary");
    const tbody = $("cost-body");
    const totals = cost.totals ?? {};
    const rows = cost.this_month ?? [];

    // Headline summary: big "you saved $X" number with subscription/API cost backing it up.
    const apiCost = totals.api_cost_month_usd ?? 0;
    const subTotal = totals.subscription_total_usd ?? 0;
    const savings = totals.savings_month_usd ?? 0;
    summary.replaceChildren();
    if (rows.length === 0) {
      summary.appendChild(textDiv("no transcript data yet", "empty"));
    } else {
      const head = document.createElement("div");
      head.className = "cost-headline";
      const big = document.createElement("span");
      big.className = "cost-savings " + (savings >= 0 ? "positive" : "negative");
      big.textContent = (savings >= 0 ? "+" : "") + fmtUsd(savings);
      const label = document.createElement("span");
      label.className = "cost-savings-label";
      label.textContent = savings >= 0
        ? "saved this month vs paying API list price"
        : "subscription is more than retail this month — light usage";
      head.append(big, label);
      summary.appendChild(head);

      const detail = document.createElement("div");
      detail.className = "cost-detail";
      detail.textContent = `${fmtUsd(apiCost)} retail · ${fmtUsd(subTotal)} subscription`;
      summary.appendChild(detail);
    }

    // Per-account breakdown.
    if (rows.length === 0) {
      tbody.replaceChildren(emptyRow(8, "no transcript data yet"));
      return;
    }
    tbody.replaceChildren(...rows.map(r => {
      const tr = document.createElement("tr");
      const isDefault = r.alias.startsWith("default");
      const t = r.total_tokens ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      const cacheRW = `${fmtTokens(t.cache_read)} / ${fmtTokens(t.cache_write)}`;
      const aliasCell = isDefault
        ? td(textDiv(r.alias, "ev-account-unknown"))
        : td(acctPill(r.alias, "magenta"));
      const savingsCell = (() => {
        const span = document.createElement("span");
        if (isDefault) {
          span.className = "usage-na";
          span.textContent = "—";
          return span;
        }
        const v = r.savings_usd ?? 0;
        span.className = "cost-cell-savings " + (v >= 0 ? "positive" : "negative");
        span.textContent = (v >= 0 ? "+" : "") + fmtUsd(v);
        return span;
      })();
      tr.append(
        aliasCell,
        td(String(r.total_turns ?? 0), "num"),
        td(fmtTokens(t.input), "num"),
        td(fmtTokens(t.output), "num"),
        td(cacheRW, "num"),
        td(fmtUsd(r.total_cost_usd), "num"),
        td(isDefault ? "—" : fmtUsd(r.subscription_usd ?? 0), "num"),
        td(savingsCell, "num"),
      );
      return tr;
    }));
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

  // Small "copy claude-use <alias>" button per account row. Clicking puts the
  // shell command on the clipboard so the user can paste it into a terminal.
  function copyAliasButton(alias) {
    const btn = document.createElement("button");
    btn.className = "copy-alias-btn";
    btn.type = "button";
    const cmd = `claude-use ${alias.replace(/^claude-/, "")}`;
    btn.title = `Copy "${cmd}" to clipboard`;
    btn.textContent = "⧉";
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        await navigator.clipboard.writeText(cmd);
        const original = btn.textContent;
        btn.textContent = "✓";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1200);
      } catch {
        btn.title = "clipboard write blocked — copy manually: " + cmd;
      }
    });
    return btn;
  }

  // Per-session kill button. POST /api/sessions/<name>/kill, dashboard refreshes
  // via WebSocket on success.
  function killSessionButton(sessionName) {
    const btn = document.createElement("button");
    btn.className = "kill-btn";
    btn.type = "button";
    btn.title = `Kill tmux session "${sessionName}" (subctl session-kill ${sessionName})`;
    btn.textContent = "✕";
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Kill tmux session "${sessionName}"?\n\nThis runs: subctl session-kill ${sessionName}`)) return;
      btn.disabled = true;
      btn.classList.add("loading");
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/kill`, { method: "POST" });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status} ${body}`);
        }
      } catch (err) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.title = "kill failed: " + (err && err.message ? err.message : err);
      }
      // On success, the next WebSocket state push removes the row anyway.
    });
    return btn;
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
    span.className = "session-name-cell";
    const name = document.createElement("span");
    name.textContent = s.name;
    span.appendChild(name);
    if (s.attached) {
      const a = document.createElement("span");
      a.className = "attached-mark";
      a.textContent = "•";
      a.title = "attached";
      span.appendChild(a);
    }
    span.appendChild(killSessionButton(s.name));
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

  // ----- Active conversations (jsonl mtime within last 5min, including non-tmux) -----

  function renderConversations(convs) {
    const tbody = $("conversations-body");
    if (!tbody) return;
    if (!convs || convs.length === 0) {
      tbody.replaceChildren(emptyRow(8, "no active conversations"));
      return;
    }
    tbody.replaceChildren(...convs.map(c => {
      const tr = document.createElement("tr");
      tr.appendChild(td(acctPill(c.account, c.account_color_class), "account"));
      tr.appendChild(td(c.project));
      tr.appendChild(td(fmtAge(c.last_activity_seconds_ago) + " ago"));
      tr.appendChild(td(fmtAge(c.age_seconds), "num"));
      tr.appendChild(td(c.size_kb + " KB", "num"));
      const sidShort = (c.sid || "").slice(0, 8);
      const sidCell = td(sidShort);
      sidCell.title = c.sid || "";
      sidCell.classList.add("ev-session");
      tr.appendChild(sidCell);
      const previewCell = td(c.first_message_preview || "");
      previewCell.classList.add("conv-preview");
      previewCell.title = c.first_message_preview || "";
      tr.appendChild(previewCell);
      tr.appendChild(td(resumeButton(c)));
      return tr;
    }));
  }

  function resumeButton(conv) {
    const wrap = document.createElement("div");
    wrap.className = "resume-actions";
    const cmd = `CLAUDE_CONFIG_DIR=${conv.config_dir} command claude --resume ${conv.sid}`;

    // copy
    const btnCopy = document.createElement("button");
    btnCopy.className = "btn-resume";
    btnCopy.textContent = "copy";
    btnCopy.title = cmd;
    btnCopy.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(cmd);
        btnCopy.textContent = "✓ copied";
        setTimeout(() => { btnCopy.textContent = "copy"; }, 1500);
      } catch {
        btnCopy.textContent = "copy failed";
      }
    });
    wrap.appendChild(btnCopy);

    // open in iTerm (macOS only — server handles platform detection)
    const btnITerm = document.createElement("button");
    btnITerm.className = "btn-resume btn-iterm";
    btnITerm.textContent = "open in iTerm";
    btnITerm.title = "Spawn a new iTerm window with the resume command (macOS, requires Automation permission first time)";
    btnITerm.addEventListener("click", async (e) => {
      e.stopPropagation();
      btnITerm.disabled = true;
      btnITerm.textContent = "opening…";
      try {
        const r = await fetch("/api/sessions/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: conv.account, sid: conv.sid, cwd: conv.cwd ?? "" }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok) {
          btnITerm.textContent = "✓ opened";
        } else {
          btnITerm.textContent = "✗ failed (see console)";
          if (j.error) console.warn("iTerm spawn failed:", j.error);
          if (j.fallback) console.info("Fallback command:", j.fallback);
        }
      } catch (err) {
        btnITerm.textContent = "✗ error";
        console.warn(err);
      }
      setTimeout(() => {
        btnITerm.textContent = "open in iTerm";
        btnITerm.disabled = false;
      }, 2200);
    });
    wrap.appendChild(btnITerm);
    return wrap;
  }

  // Lazy-load preview for a Session Browser row when user hovers/focuses it.
  // Caches per-session so re-hover is instant. Preview text replaces the
  // empty cell content in place.
  const previewCache = new Map();
  async function fetchPreview(account, sid) {
    const key = `${account}:${sid}`;
    if (previewCache.has(key)) return previewCache.get(key);
    try {
      const r = await fetch(`/api/sessions/preview?account=${encodeURIComponent(account)}&sid=${encodeURIComponent(sid)}`);
      const j = await r.json();
      const txt = j?.preview || "(no user message)";
      previewCache.set(key, txt);
      return txt;
    } catch {
      return "(load failed)";
    }
  }
  function attachLazyPreview(cell, account, sid) {
    let loaded = false;
    const load = async () => {
      if (loaded) return;
      loaded = true;
      cell.classList.add("preview-loading");
      const txt = await fetchPreview(account, sid);
      cell.textContent = txt;
      cell.title = txt;
      cell.classList.remove("preview-loading");
    };
    cell.addEventListener("mouseenter", load, { once: false });
    cell.addEventListener("focus", load, { once: false });
    cell.tabIndex = 0;
  }

  // ----- Session browser (search across all sessions, all accounts) -----

  let allSessionsCache = null;
  let allSessionsCacheTs = 0;

  // Cache key includes workers flag — switching the toggle invalidates.
  let allSessionsCacheKey = null;
  async function loadAllSessions(force, includeWorkers) {
    const SIX_MIN = 6 * 60 * 1000;
    const key = includeWorkers ? "with-workers" : "no-workers";
    if (!force && allSessionsCache && allSessionsCacheKey === key && (Date.now() - allSessionsCacheTs) < SIX_MIN) {
      return allSessionsCache;
    }
    try {
      const params = new URLSearchParams({ limit: "1500" });
      if (includeWorkers) params.set("workers", "1");
      const r = await fetch(`/api/sessions/list?${params}`, { cache: "no-store" });
      if (!r.ok) return [];
      const j = await r.json();
      allSessionsCache = j.sessions || [];
      allSessionsCacheKey = key;
      allSessionsCacheTs = Date.now();
      return allSessionsCache;
    } catch {
      return [];
    }
  }

  function populateSearchAccountFilter(accounts) {
    const sel = $("search-account");
    if (!sel) return;
    const current = sel.value;
    sel.replaceChildren();
    const all = document.createElement("option");
    all.value = ""; all.textContent = "all accounts";
    sel.appendChild(all);
    sel.appendChild(makeOpt("default", "default (~/.claude)"));
    for (const a of accounts) sel.appendChild(makeOpt(a.alias, a.alias));
    sel.value = current;
  }
  function makeOpt(v, label) {
    const o = document.createElement("option"); o.value = v; o.textContent = label; return o;
  }

  function wireSearchUI() {
    const input = $("search-input"), accSel = $("search-account"), workersCb = $("search-show-workers");
    if (!input || !accSel) return;
    let debounce = null;
    const trigger = async (forceReload) => {
      const includeWorkers = workersCb && workersCb.checked;
      const sessions = await loadAllSessions(forceReload, includeWorkers);
      const q = input.value.trim().toLowerCase();
      const acc = accSel.value;
      const filtered = sessions.filter(s => {
        if (acc && s.account !== acc) return false;
        if (!q) return true;
        return (s.project || "").toLowerCase().includes(q)
            || (s.account || "").toLowerCase().includes(q)
            || (s.sid || "").toLowerCase().includes(q)
            || (s.first_message_preview || "").toLowerCase().includes(q);
      });
      renderSearchResults(filtered.slice(0, 200), filtered.length);
    };
    input.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => trigger(false), 150); });
    accSel.addEventListener("change", () => trigger(false));
    if (workersCb) workersCb.addEventListener("change", () => trigger(true)); // forceReload — different cache key
    // Auto-load on first interaction. Also try once after first state.
    setTimeout(() => trigger(false), 800);
  }

  function renderSearchResults(rows, totalMatching) {
    const tbody = $("search-body");
    if (!tbody) return;
    setText($("search-count"), `${rows.length} of ${totalMatching || rows.length} shown`);
    if (!rows.length) {
      tbody.replaceChildren(emptyRow(7, "no matches"));
      return;
    }
    tbody.replaceChildren(...rows.map(s => {
      const tr = document.createElement("tr");
      tr.appendChild(td(acctPill(s.account, s.account_color_class), "account"));
      tr.appendChild(td(s.project || "—"));
      const mtime = td(fmtRelative(s.mtime_ts) + " ago", "num");
      mtime.title = new Date(s.mtime_ts).toLocaleString();
      tr.appendChild(mtime);
      tr.appendChild(td(s.size_kb + " KB", "num"));
      const sidCell = td((s.sid || "").slice(0, 8));
      sidCell.title = s.sid || "";
      sidCell.classList.add("ev-session");
      tr.appendChild(sidCell);
      // Bulk list now includes preview for free (we read it server-side
      // for is_worker detection anyway). Fall back to lazy load if the
      // server returned an empty preview (e.g. unreadable file).
      const prev = td(s.first_message_preview || "(hover to load)");
      prev.classList.add("conv-preview");
      prev.title = s.first_message_preview || "";
      if (!s.first_message_preview) {
        attachLazyPreview(prev, s.account, s.sid);
      }
      tr.appendChild(prev);
      tr.appendChild(td(resumeButton({ sid: s.sid, account: s.account, config_dir: s.config_dir, cwd: s.cwd })));
      return tr;
    }));
  }

  function fmtRelative(tsMs) {
    if (!tsMs) return "?";
    const sec = Math.floor((Date.now() - tsMs) / 1000);
    return fmtAge(sec);
  }

  // wire search UI on load
  wireSearchUI();

  // ----- Tab nav (Dashboard | Sessions | Docs) -----

  function wireTabs() {
    const TAB_STORAGE_KEY = "subctl.dashboard.tab";
    const initial = (() => {
      try { return localStorage.getItem(TAB_STORAGE_KEY) || "dashboard"; }
      catch { return "dashboard"; }
    })();
    setActiveTab(initial);
    const buttons = document.querySelectorAll(".tab-nav .tab-btn[data-tab]");
    buttons.forEach(b => {
      b.addEventListener("click", () => {
        const tab = b.dataset.tab;
        if (!tab) return;
        setActiveTab(tab);
        try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* no localStorage */ }
      });
    });
  }
  function setActiveTab(tab) {
    document.body.dataset.activeTab = tab;
    document.querySelectorAll(".tab-nav .tab-btn[data-tab]").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
  }
  wireTabs();

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
