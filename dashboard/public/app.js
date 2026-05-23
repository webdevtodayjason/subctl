// subctl dashboard frontend
//
// Connects to /api/live (WebSocket); on failure falls back to polling /api/state.
// On WebSocket message, flashes the refresh pulse dot.
// If WS is closed > 5 seconds, surfaces a RECONNECTING… pill in the header.

(() => {
  "use strict";

  // ---- Host identity (v2.6.x: delabel hardcoded "M3 Ultra" mentions) ----
  // Filled in on boot by GET /api/host. Until that resolves, prose uses
  // "this Mac" so a flash of "M3 Ultra" on a non-M3 host never appears.
  // The operator can override via ~/.config/subctl/host_label (one line of text).
  let HOST_LABEL = "this Mac";
  // v2.8.6 (wave 14): publish HOST_LABEL on window so tabs/chat.js can
  // read the live value at slash-help build time. The bridge mirrors
  // app.js's mutable on every update; chat snapshots at SLASH_HELP-build
  // time which matches the pre-extraction closure-capture semantics.
  window.__subctlHostLabel = HOST_LABEL;
  // TODO(v2.7): make SSH host alias configurable per-host. The dashboard runs
  // on whatever Mac the operator opened it on, but the master daemon may live
  // on a different machine (commonly the M3 Ultra). The /attach SSH command
  // needs the REMOTE host, not the local one. Until that's wired through
  // (probably via a `subctl_master_ssh_alias` setting in policy.json), the
  // attach command stays hardcoded so the operator's existing ~/.ssh/config
  // entry keeps working.
  const SSH_HOST_ALIAS = "argent-m3-ultra-dev";

  function applyHostLabel() {
    try {
      document.querySelectorAll(".host-label").forEach((el) => {
        el.textContent = HOST_LABEL;
      });
    } catch { /* DOM not ready — bootstrap retries after fetch resolves */ }
  }

  // Fire-and-forget; default label is fine if this never resolves.
  fetch("/api/host")
    .then((r) => r.json())
    .then((j) => {
      if (j && j.ok && typeof j.user_label === "string" && j.user_label.length > 0) {
        HOST_LABEL = j.user_label;
        window.__subctlHostLabel = HOST_LABEL;
        applyHostLabel();
      }
    })
    .catch(() => { /* fall back to default */ });
  // Also paint once on DOMContentLoaded in case the static spans render
  // before fetch resolves — keeps them from showing "M3 Ultra" mid-flash
  // (they already say "this Mac" by default, but in case future spans land
  // with different default text).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyHostLabel, { once: true });
  } else {
    applyHostLabel();
  }

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
  // v2.8.18 — usage_error / usage_stale_age_ms surfacing.
  // Returns a short label like "429" / "no auth" / "no data" or null when
  // there's nothing to surface (data is fresh OR cell already shows real
  // numbers via stale fallback).
  function shortUsageErrorLabel(err) {
    if (typeof err !== "string" || err.length === 0) return null;
    if (/\b429\b/.test(err)) return "429";
    if (/no auth|credentials|bearer|unauthor|401|403/i.test(err)) return "no auth";
    if (/timeout|ETIMEDOUT|ENOTFOUND|network/i.test(err)) return "net err";
    return "err";
  }
  function fmtStaleAge(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return "<1m";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }
  // opts: { stale?: boolean, staleAgeMs?: number|null, errorLabel?: string|null }
  function appendStaleOrErrorSub(wrap, opts) {
    if (!opts) return;
    if (opts.stale) {
      const sub = document.createElement("span");
      sub.className = "usage-stale-indicator";
      sub.textContent = `· stale ${fmtStaleAge(opts.staleAgeMs)}`;
      wrap.appendChild(sub);
    } else if (opts.errorLabel) {
      const sub = document.createElement("span");
      sub.className = "usage-error-indicator";
      sub.textContent = `· ${opts.errorLabel}`;
      wrap.appendChild(sub);
    }
  }

  function usagePctCellWithReset(pct, resetIso, [yellow, red], opts) {
    const wrap = document.createElement("span");
    wrap.className = "usage-cell-stack";
    if (opts && opts.stale) wrap.classList.add("usage-stale");
    else if (opts && opts.errorLabel) wrap.classList.add("usage-error");
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
    appendStaleOrErrorSub(wrap, opts);
    return wrap;
  }

  function usageBarCellWithReset(pctAll, pctSonnet, resetIso, opts) {
    const wrap = document.createElement("span");
    wrap.className = "usage-cell-stack";
    if (opts && opts.stale) wrap.classList.add("usage-stale");
    else if (opts && opts.errorLabel) wrap.classList.add("usage-error");
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
    appendStaleOrErrorSub(wrap, opts);
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
  // ── v2.8.6 (wave 14 — FINAL): Master chat + chat-adjacent extracted to
  //    dashboard/public/tabs/chat.js. The three boot wirers
  //    (wireMasterChat, wireChatModelSelector, wireProfilePill) and the
  //    tool-display + thinking helper bands at the old app.js top moved
  //    with chat — grep showed zero non-chat-zone callers. chat.js
  //    publishes window.__subctlAttachOneShotAssistantCapture from mount()
  //    for Projects (wave 9). New bridge published from app.js this wave:
  //    window.__subctlHostLabel (so chat reads the live host label in
  //    slash commands). All 14 decomposition waves complete — app.js is
  //    now the shell (state polling, WS transport, render dispatcher,
  //    cell builders, notification tray, status pill, lucide chrome,
  //    host-label boot, tab nav).
  // ── v2.8.6 (wave 13): Orchestration zone (camera grid + cockpit +
  //    watchdog panel + tmux-preview / web-terminal modals)
  //    extracted to dashboard/public/tabs/orch.js. The boot setup
  //    functions that used to run here are now invoked inside that
  //    module's mount(). Orch publishes 4 globals from mount() for the
  //    cross-module consumers (the three __subctl* helpers + the
  //    boot-gate hoist). See orch.js header for the bridge-retirement
  //    plan.
  //
  //    NOTE: `_showNotice` + `window.notice` / `.error` / `.confirm`
  //    were also moved out in the original wave-13 extraction. That
  //    was wrong — the default-active tab is "chat", so on page boot
  //    window.notice was null until the operator clicked the
  //    Orchestration nav button, and every consumer aborted silently
  //    with `TypeError: Cannot read properties of null`. Reclaimed to
  //    the shell (see the `_showNotice` definition + publications just
  //    above `escapeText`). The notification system is a shell-level
  //    concern, not tab-scoped — the wave-13 grouping with orch's
  //    modal helpers was an authoring-history accident.
  // ── v2.8.6 (wave 12): Teams tab extracted to dashboard/public/tabs/teams.js.
  // ── v2.8.6 (wave 11): Policy zone extracted to dashboard/public/tabs/policy.js.
  //    Bridge retirement: the 3 wave-1 window.__subctl* globals are GONE.
  //    New contract: subctl:policy-teams-updated event (Policy publishes,
  //    Logs subscribes) + subctl:policy-teams-refresh-request (Logs fires,
  //    Policy fulfills). Audit renderers moved from this file into
  //    tabs/logs.js (Logs is the sole consumer).
  // ── v2.8.6 (wave 10): Settings tab extracted to dashboard/public/tabs/settings.js.
  //    Consumes window.notice (notification system still owned by app.js).
  // ── v2.8.6 (wave 9): Projects tab → tabs/projects.js. Consumes window.openVaultDeepLink
  //    + window.__subctlAttachOneShotAssistantCapture; owns window.__policyPresetsCache.
  // ── v2.8.6 (wave 8): Skills tab extracted to dashboard/public/tabs/skills.js.
  //    Still publishes window.__skillsClarityRefresh from mount() pending
  //    confirmation that no external reader uses it.
  // ── v2.8.6 (wave 7): Memory tab extracted to dashboard/public/tabs/memory.js.
  // ── v2.8.6 (wave 6): Vault tab extracted to dashboard/public/tabs/vault.js.
  //    Continues to publish window.openVaultDeepLink from mount() so the
  //    Projects tab (wave 9) can deep-link into notes.
  // ── v2.8.6 (wave 5): Providers tab extracted to dashboard/public/tabs/providers.js.
  // ── v2.8.6 (wave 2): Templates tab extracted to dashboard/public/tabs/templates.js.
  // ── v2.8.6: Logs tab extracted to dashboard/public/tabs/logs.js. The
  // bootstrap.js shell loader mounts the module on first activation. The
  // chip + audit-detail state moved with it. The audit-line render trio
  // now lives in tabs/logs.js too (moved in wave 11 — Logs is the sole
  // consumer). See ORCHESTRATION.md 2026-05-13 night session for the
  // state-ownership ruling.

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // v2.8.18 — defense-in-depth UI redaction for api-key-shaped aliases.
  // Canonical implementation lives in dashboard/public/lib/redact.js
  // (used by the tab modules); inlined here because app.js is a classic
  // script and can't `import` from an ES module. Keep in sync with the
  // module — both branches must apply the same mask rule.
  // Pattern at call sites: `escapeText(redactAlias(alias))`. The COPIED
  // text in copyAliasButton() must still be the FULL alias (only the
  // displayed text is masked).
  function redactAlias(s) {
    if (typeof s !== "string" || s.length === 0) return s;
    // Match common API-key prefixes; redact to prefix(12)…suffix(8).
    // Long enough to disambiguate, short enough that the screenshot
    // doesn't leak credentials.
    if (/^(sk-|pk-|Bearer\s)/i.test(s)) {
      if (s.length <= 16) return s.slice(0, 4) + "…" + s.slice(-3);
      return s.slice(0, 12) + "…" + s.slice(-8);
    }
    return s;
  }

  // CSS-escape (subset) — ids in our project chat logs include / : etc. and
  // querySelector chokes on them. Replace anything non-alphanumeric+dash+underscore.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // ----- notice/confirm modal (shell-owned) -----
  // Replaces browser alert() and confirm() so popups match the dashboard
  // theme. Returns a Promise<boolean> for confirm-style usage; resolves
  // true on OK, false on cancel/escape/close.
  //
  // Usage:
  //   await notice("Title", "Plain message")           — info, single OK
  //   await notice.error("Switch failed", err.message) — red header
  //   await notice.confirm("Delete?", "This is permanent.") — returns bool
  //
  // History: wave 13 moved this into tabs/orch.js along with the
  // tmux-preview + web-terminal modal helpers. That was wrong — the
  // default-active tab is "chat", so window.notice was null until the
  // operator clicked the Orchestration nav button, and every consumer
  // (chat model-selector apply, settings profile swap, etc.) threw
  // `TypeError: Cannot read properties of null (reading 'confirm')` on
  // click and aborted silently. The notification system is a
  // shell-level concern, not orch-scoped, so it lives here now, published
  // before any tab module mounts.
  function _showNotice({ title, body, kind = "info", confirm = false }) {
    return new Promise((resolve) => {
      const modal = document.getElementById("notice-modal");
      const titleEl = document.getElementById("notice-title");
      const bodyEl = document.getElementById("notice-body");
      const okBtn = document.getElementById("notice-ok");
      const cancelBtn = document.getElementById("notice-cancel");
      const closeBtn = document.getElementById("notice-close");
      if (!modal || !titleEl || !bodyEl || !okBtn) {
        // Fallback to native if the modal element somehow isn't in the DOM
        if (confirm) resolve(window.confirm((title ? title + "\n\n" : "") + body));
        else { window.alert((title ? title + "\n\n" : "") + body); resolve(true); }
        return;
      }
      titleEl.textContent = title || "Notice";
      bodyEl.textContent = body || "";
      // Color the header by kind
      titleEl.style.color = kind === "error" ? "#d66c6c"
                          : kind === "warn"  ? "#d6c46c"
                          : kind === "ok"    ? "#6cd697"
                          : "#ffffff";
      // Belt-and-braces visibility — inline display PLUS hidden attr —
      // so the Cancel button never sneaks through on info/error notices
      // even if a CSS rule overrides [hidden].
      cancelBtn.hidden = !confirm;
      cancelBtn.style.display = confirm ? "" : "none";
      okBtn.textContent = confirm ? "Confirm" : "OK";
      modal.hidden = false;
      // Focus management — let Esc and Enter work
      const close = (val) => {
        modal.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        closeBtn.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);
      const onBackdrop = (e) => { if (e.target === modal) close(false); };
      const onKey = (e) => {
        if (e.key === "Escape") close(false);
        else if (e.key === "Enter") close(true);
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      closeBtn.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      setTimeout(() => okBtn.focus(), 50);
    });
  }
  window.notice = (title, body, opts = {}) => _showNotice({ title, body, kind: opts.kind ?? "info", confirm: false });
  window.notice.error = (title, body) => _showNotice({ title, body, kind: "error", confirm: false });
  window.notice.confirm = (title, body) => _showNotice({ title, body, kind: "warn", confirm: true });

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

  // Refresh pulse — used to flash on every WS message (~every 2s) which
  // was visually noisy. Now we only flash on actual state changes that
  // produce a different payload signature (account counts, RL hits,
  // verdict, dev-team count). Cuts the blink rate from "constantly" to
  // "when something interesting happens".
  let pulseClearTimer = null;
  let lastPulseSig = "";
  function flashPulse(state) {
    const dot = $("pulse-dot");
    if (!dot) return;
    if (state) {
      const sig = [
        state.dispatch?.verdict,
        state.totals?.tmux_sessions,
        state.totals?.ready_accounts,
        state.totals?.rl_today,
        (state.orchestrations || []).length,
      ].join("|");
      if (sig === lastPulseSig) return; // no meaningful change → no flash
      lastPulseSig = sig;
    }
    dot.classList.add("flash");
    if (pulseClearTimer) clearTimeout(pulseClearTimer);
    pulseClearTimer = setTimeout(() => dot.classList.remove("flash"), 250);
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

    // Service status pill — encodes SERVICE liveness, not the dispatch
    // verdict. (The verdict gets its own panel; double-encoding it here
    // confused the eye: red dot + "live" text felt broken when accounts
    // weren't authed yet.) Green = service running, dim = stopped.
    if (state.service?.running) {
      const pill = $("status-pill");
      if (!pill.classList.contains("reconnecting")) {
        setStatus("green", `live · ${fmtAge(state.service.uptime_seconds)}`);
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
        // ── v2.8.1 accounts data fix ──
        // When the per-account usage payload is missing (fetch failed or
        // upstream didn't return this alias), the verdict module flags
        // `data_missing: true` and the server stamps `usage_state` !== "ok".
        // Render a "no data" pill instead of the normal verdict so the
        // operator stops seeing a false green "dispatches go".
        const dataMissing = a.dispatch?.data_missing === true || (a.usage_state && a.usage_state !== "ok");
        // v2.8.18 — surface per-row usage status. `usage_stale` → cells
        // show real numbers + "·stale Xm" tag (rendered dim/yellow).
        // `usage_error` + no fallback → cells dim with a short error
        // label ("429" / "no auth" / etc.).
        const usageOpts = {
          stale: a.usage_stale === true,
          staleAgeMs: a.usage_stale_age_ms ?? null,
          errorLabel: !a.usage_stale && a.usage_error ? shortUsageErrorLabel(a.usage_error) : null,
        };
        tr.append(
          td(acctPill(a.alias, a.color_class)),
          td(a.provider),
          td(authCell(a.auth_status)),
          td(verdictPill(a.dispatch?.verdict, a.dispatch?.reasons, { dataMissing, usageState: a.usage_state })),
          td(copyAliasButton(a.alias)),
          td(usagePctCellWithReset(fiveH, fiveResetIso, [80, 95], usageOpts), "num"),
          td(usageBarCellWithReset(sevenD, sonnetD, weekResetIso, usageOpts), "num"),
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
    // ── v2.8.1 accounts data fix ──
    // Surface the upstream usage-fetch state as its own banner so the
    // operator immediately sees "data unavailable" instead of trusting
    // a stale Accounts table. Distinct from `state.warning`
    // (accounts.conf-not-found) which is a config error, not a data error.
    const usageWarnEl = $("usage-fetch-warning");
    if (usageWarnEl) {
      const meta = state.usage_fetch;
      if (meta && meta.ok === false) {
        const ageMin = Math.floor((meta.age_seconds ?? 0) / 60);
        const ageLabel = ageMin > 0 ? ` (last attempt ${ageMin}m ago)` : "";
        const reason = meta.error || "usage data unavailable";
        const stderr = meta.stderr_excerpt ? ` — ${meta.stderr_excerpt.slice(0, 120)}` : "";
        setText(usageWarnEl, `⚠ Accounts table cannot be trusted: ${reason}${ageLabel}${stderr}. Run \`subctl usage\` from a terminal to diagnose; click ↻ to retry.`);
        usageWarnEl.hidden = false;
      } else {
        usageWarnEl.hidden = true;
      }
    }

    // Sessions table
    renderSessions(state.sessions ?? []);

    // Rate limits
    renderCost(state.cost ?? { this_month: [], totals: { api_cost_month_usd: 0, subscription_total_usd: 0, savings_month_usd: 0 } });
    renderRateLimits(state.rate_limits ?? { today_total: 0, by_account: [] });
    renderEvents(state.rate_limits?.events_today ?? []);
    renderOrchestrations(state.orchestrations ?? []);
    renderOrchSidecar(state.orchestrations ?? []);
    renderConversations(state.active_conversations ?? []);
    populateSearchAccountFilter(state.accounts ?? []);
  }

  // ----- Orchestration sidecar (right side of the Orchestration screen) -----
  function renderOrchSidecar(orchs) {
    const list = $("orch-teams-list");
    const count = $("orch-teams-count");
    if (!list || !count) return;
    count.textContent = orchs.length;
    if (!orchs.length) {
      list.innerHTML = "<div class=\"dim small\">no teams running</div>";
      return;
    }
    list.replaceChildren(...orchs.map((o) => {
      const row = document.createElement("div");
      row.className = "orch-team-row";
      const ageS = o.last_activity_seconds_ago;
      if (typeof ageS === "number") {
        if (ageS > 1800) row.classList.add("stale-red");
        else if (ageS > 900) row.classList.add("stale-yellow");
      }
      const name = document.createElement("div");
      name.className = "team-name";
      name.textContent = o.name;
      row.appendChild(name);
      const meta = document.createElement("div");
      meta.className = "team-meta";
      const lastEv = o.last_event_type ? `${o.last_event_type}` : "no reports";
      const ageStr = typeof ageS === "number" ? fmtAge(ageS) + " ago" : "—";
      meta.textContent = `${lastEv} · ${ageStr}`;
      row.appendChild(meta);
      return row;
    }));
  }

  // Curated notification feed (replaces the old raw-event activity ring).
  // The chat sidecar shows summary-style notifications instead of every
  // text-delta and tool-call. Three sources feed it:
  //
  //   1. Master pushes via notify_dashboard tool → "notify" SSE event.
  //   2. Auto-derived from team_event blocked/done/error in the SSE
  //      stream (we don't need master to call notify_dashboard for those).
  //   3. Auto-derived from watchdog_fire SSE events.
  //
  // No tool-call ticker noise, no text-delta replays. If you want raw
  // events the Live Logs tab has them.
  const NOTIFY_LIMIT = 30;
  const KIND_GLYPH = {
    spawn:       "▶",
    blocked:     "⛔",
    done:        "✓",
    milestone:   "◉",
    escalation:  "📡",
    decision:    "→",
    watchdog:    "⏰",
    memory:      "✦",
    info:        "·",
    error:       "✗",
  };
  function pushNotification(kind, summary, team) {
    const list = $("orch-notify-list");
    if (!list) return;
    const empty = list.querySelector(".dim");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "orch-notify-item kind-" + (kind || "info");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date().toLocaleTimeString();
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = KIND_GLYPH[kind] || "·";
    const text = document.createElement("span");
    text.className = "summary";
    if (team) {
      const teamPill = document.createElement("span");
      teamPill.className = "team-pill";
      teamPill.textContent = team;
      text.appendChild(teamPill);
    }
    text.appendChild(document.createTextNode(summary));
    row.appendChild(when);
    row.appendChild(glyph);
    row.appendChild(text);
    list.insertBefore(row, list.firstChild);
    while (list.children.length > NOTIFY_LIMIT) list.removeChild(list.lastChild);
  }
  // Expose so wireMasterChat's SSE handlers can publish into the feed.
  window.__subctlPushNotification = pushNotification;
  const notifyClearBtn = $("notify-clear");
  if (notifyClearBtn) notifyClearBtn.addEventListener("click", () => {
    const list = $("orch-notify-list");
    if (!list) return;
    list.innerHTML = "<div class=\"dim small\">cleared</div>";
  });
  // Backward-compat shim — older code may still call __subctlPushActivity.
  // Map it to a generic "info" notification so we don't lose anything.
  window.__subctlPushActivity = (html) => pushNotification("info", String(html).replace(/<[^>]+>/g, ""));

  // ----- Dev Teams (tmux sessions with CLAUDE_CONFIG_DIR set, enriched with master inbox activity) -----

  function renderOrchestrations(orchs) {
    const tbody = $("orchestrations-body");
    if (!tbody) return;
    if (!orchs || orchs.length === 0) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.colSpan = 7;
      td0.className = "empty";
      td0.innerHTML = "no dev teams running — master will spawn them via <code>subctl_orch_spawn</code> when conversations conclude one is needed";
      tr.appendChild(td0);
      tbody.replaceChildren(tr);
      return;
    }
    tbody.replaceChildren(...orchs.map(o => {
      const tr = document.createElement("tr");

      // Staleness color from last_activity_seconds_ago
      const ageS = o.last_activity_seconds_ago;
      if (typeof ageS === "number") {
        if (ageS > 1800) tr.classList.add("team-stale-red");
        else if (ageS > 900) tr.classList.add("team-stale-yellow");
        else tr.classList.add("team-stale-green");
      }

      // team name
      const nameCell = td(o.name);
      nameCell.classList.add("ev-session");
      tr.appendChild(nameCell);

      // account
      const acctAlias = (o.claude_account_dir || "")
        .replace(/\/$/, "")
        .split("/")
        .pop() || "—";
      const acctPretty = acctAlias.replace(/^\.claude-?/, "") || acctAlias;
      const acctTd = td(acctPretty);
      acctTd.title = o.claude_account_dir || "";
      tr.appendChild(acctTd);

      // project
      const projShort = (o.path || "").split("/").pop() || o.path || "";
      const projTd = td(projShort);
      projTd.title = o.path || "";
      tr.appendChild(projTd);

      tr.appendChild(td(String(o.windows ?? 0), "num"));

      // last activity (with attached indicator inline)
      const actCell = document.createElement("td");
      if (typeof ageS === "number") {
        const dot = document.createElement("span");
        dot.className = "team-dot";
        actCell.appendChild(dot);
        actCell.appendChild(document.createTextNode(" " + fmtAge(ageS) + " ago"));
      } else {
        actCell.textContent = "no reports yet";
        actCell.classList.add("dim");
      }
      if (o.attached) {
        const att = document.createElement("span");
        att.className = "team-attached-pill";
        att.textContent = "attached";
        actCell.appendChild(att);
      }
      tr.appendChild(actCell);

      // last event
      const evCell = document.createElement("td");
      evCell.classList.add("team-last-event");
      if (o.last_event_type) {
        const typePill = document.createElement("span");
        typePill.className = "team-event-pill team-event-" + o.last_event_type;
        typePill.textContent = o.last_event_type;
        evCell.appendChild(typePill);
        if (o.last_event_text) {
          const text = document.createElement("span");
          text.className = "team-event-text";
          text.textContent = " " + o.last_event_text;
          text.title = o.last_event_text;
          evCell.appendChild(text);
        }
      } else {
        evCell.textContent = "—";
        evCell.classList.add("dim");
      }
      tr.appendChild(evCell);

      // actions: view (live tmux preview), copy attach, kill
      const wrap = document.createElement("div");
      wrap.className = "resume-actions";

      const btnView = document.createElement("button");
      btnView.className = "btn-resume";
      btnView.textContent = "view";
      btnView.title = "Live read-only tmux pane preview";
      btnView.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.__subctlOpenTmuxPreview) window.__subctlOpenTmuxPreview(o.name);
      });
      wrap.appendChild(btnView);

      const btnAttach = document.createElement("button");
      btnAttach.className = "btn-resume";
      btnAttach.textContent = "attach";
      btnAttach.title = "Copy SSH command to attach to this team's tmux";
      btnAttach.addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.__subctlCopyAttachCommand) window.__subctlCopyAttachCommand(o.name, btnAttach);
      });
      wrap.appendChild(btnAttach);

      const btnKill = document.createElement("button");
      btnKill.className = "btn-resume";
      btnKill.textContent = "kill";
      btnKill.title = "tmux kill-session -t " + o.name;
      btnKill.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await window.notice.confirm(
          "Kill dev-team session",
          `Kill tmux session "${o.name}"? This stops the lead Claude Code instance and all its workers immediately.`,
        );
        if (!ok) return;
        btnKill.disabled = true;
        btnKill.textContent = "killing…";
        try {
          const r = await fetch("/api/orchestration/" + encodeURIComponent(o.name) + "/kill", { method: "POST" });
          const j = await r.json().catch(() => ({}));
          if (!j.ok) {
            btnKill.textContent = "failed";
            btnKill.title = j.error || "kill failed";
            setTimeout(() => { btnKill.disabled = false; btnKill.textContent = "kill"; }, 2500);
          }
        } catch (err) {
          btnKill.textContent = "error";
          btnKill.title = String(err);
        }
      });
      wrap.appendChild(btnKill);
      tr.appendChild(td(wrap));

      return tr;
    }));
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
    // v2.8.18 — redact api-key-shaped aliases on display. textContent
    // is HTML-safe so no escapeText() needed; redactAlias is enough.
    name.textContent = redactAlias(alias);
    span.append(dot, name);
    return span;
  }

  function verdictPill(verdict, reasons, opts) {
    const span = document.createElement("span");
    const v = verdict || "red";
    const dataMissing = opts && opts.dataMissing === true;
    // ── v2.8.1 accounts data fix ──
    // When usage data is missing (per-account or global fetch failure),
    // render the verdict pill in a distinctive "no-data" style — the
    // verdict colour underneath is still yellow (per the verdict module),
    // but the label reads "no data" instead of "caution" so the operator
    // can tell at a glance whether the yellow is real or a data hole.
    if (dataMissing) {
      span.className = `verdict-pill verdict-${v} verdict-nodata`;
      span.textContent = "⚠ no data";
    } else {
      span.className = `verdict-pill verdict-${v}`;
      span.textContent = `${VERDICT_GLYPH[v] || ""} ${VERDICT_TEXT[v] || "—"}`.trim();
    }
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
  //
  // v2.8.18 — the COPIED text uses the FULL alias (legitimate `subctl auth`
  // / `claude-use` commands need the real value). Only the title/tooltip
  // gets the redacted form so an api-key-shaped legacy alias doesn't
  // leak when the operator hovers the button on a screenshare.
  function copyAliasButton(alias) {
    const btn = document.createElement("button");
    btn.className = "copy-alias-btn";
    btn.type = "button";
    const cmd = `claude-use ${alias.replace(/^claude-/, "")}`;
    const displayCmd = `claude-use ${redactAlias(alias).replace(/^claude-/, "")}`;
    btn.title = `Copy "${displayCmd}" to clipboard`;
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
        btn.title = "clipboard write blocked — copy manually: " + displayCmd;
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
    // v2.8.18 — option VALUE stays the full alias (backend matches on it);
    // only the displayed label is redacted. So api-key-shaped aliases get
    // masked in the dropdown without breaking the search filter.
    for (const a of accounts) sel.appendChild(makeOpt(a.alias, redactAlias(a.alias)));
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
      try {
        const stored = localStorage.getItem(TAB_STORAGE_KEY) || "chat";
        // Migration: the previous default was "orchestration", which used
        // to be the chat. If users had that stored, route them to "chat".
        if (stored === "orchestration" && !document.querySelector("section[data-tab=\"orchestration\"] .orch-grid")) {
          return "chat";
        }
        return stored;
      } catch { return "chat"; }
    })();
    setActiveTab(initial);
    // Sidebar buttons (new layout) and any legacy top-nav buttons (none now,
    // but kept for safety if someone hits an old cached page).
    const buttons = document.querySelectorAll(".sidebar-nav .nav-btn[data-tab], .tab-nav .tab-btn[data-tab]");
    buttons.forEach(b => {
      b.addEventListener("click", () => {
        const tab = b.dataset.tab;
        if (!tab) return;
        setActiveTab(tab);
        try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* no localStorage */ }
      });
    });

    // Sidebar collapse toggle
    const collapseBtn = document.getElementById("sidebar-collapse-btn");
    const sidebar = document.getElementById("sidebar");
    const COLLAPSE_KEY = "subctl.dashboard.sidebar.collapsed";
    if (collapseBtn && sidebar) {
      try {
        if (localStorage.getItem(COLLAPSE_KEY) === "1") sidebar.classList.add("collapsed");
      } catch {}
      collapseBtn.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
        try { localStorage.setItem(COLLAPSE_KEY, sidebar.classList.contains("collapsed") ? "1" : "0"); } catch {}
      });
    }
  }
  function setActiveTab(tab) {
    document.body.dataset.activeTab = tab;
    document.querySelectorAll(".sidebar-nav .nav-btn[data-tab], .tab-nav .tab-btn[data-tab]").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    // v2.8.6: notify the bootstrap.js shell so it can lazy-mount the tab
    // module on first activation. Optional-chained because bootstrap.js is a
    // module and may not have evaluated yet on initial page boot.
    window.__subctlShellNotifyTabChange?.(tab);
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
        const state = await r.json();
        flashPulse(state);
        render(state);
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
      try {
        const state = JSON.parse(ev.data);
        flashPulse(state);
        render(state);
      } catch { /* ignore malformed */ }
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]));
  }

  // ── v2.7.25 notification tray + toasts (rewritten) ───────────────────
  // The v2.7.22 surface rendered a permanent panel — operator's feedback
  // (2026-05-13): "renders always-on, can't be collapsed or dismissed.
  // Notifications pile up, the panel always shows." Re-shipped as:
  //
  //   • An inbox icon (Lucide `inbox`) in the topbar. Click to open a
  //     dropdown showing the last 20 notifications.
  //   • Toasts that slide in from the top-right corner for incoming
  //     notifications, regardless of whether the dropdown is open. Auto
  //     fade-out after ~5s, max 3 visible.
  //   • Severity icons (info / warn / alert) come from Lucide, not
  //     emoji-of-platform-renderer-roulette.
  //   • Warn / alert / error notifications get a [Copy prompt] button
  //     that copies a structured "ask an LLM to fix this" prompt to
  //     clipboard.
  //   • [×] per row dismisses that one notification; "mark all read"
  //     stays in the header. Read entries stay visible at reduced
  //     opacity until explicitly dismissed.
  //
  // Severity → Lucide icon name:
  //   info  → "info"
  //   warn  → "alert-triangle"
  //   alert → "alert-octagon"
  //
  // "Errorish" notification detection (drives the Copy-prompt button):
  //   severity in {warn, alert} OR kind matches one of the patterns in
  //   ERRORISH_KIND_RE. Add new patterns there as new alert kinds land.
  function getIcon(name, opts) {
    // window.subctlIcon is provided by /icons.js (ADR 0016); guard so
    // this file stays usable even if icons.js fails to load.
    return (typeof window !== "undefined" && typeof window.subctlIcon === "function")
      ? window.subctlIcon(name, opts)
      : "";
  }

  const ERRORISH_KIND_RE = /(error|failed|fail|unresponsive|vanished|circuit-breaker|tripped|denied|stuck)/i;

  function isErrorishNotification(n) {
    if (!n) return false;
    if (n.severity === "warn" || n.severity === "alert") return true;
    if (typeof n.kind === "string" && ERRORISH_KIND_RE.test(n.kind)) return true;
    return false;
  }

  function severityIconName(sev) {
    if (sev === "alert") return "alert-octagon";
    if (sev === "warn")  return "alert-triangle";
    return "info";
  }

  function fmtRelative(iso) {
    try {
      const ms = Date.now() - Date.parse(iso);
      if (Number.isNaN(ms) || ms < 0) return "just now";
      if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
      if (ms < 3600_000) return Math.floor(ms / 60_000) + "m ago";
      if (ms < 86_400_000) return Math.floor(ms / 3600_000) + "h ago";
      return Math.floor(ms / 86_400_000) + "d ago";
    } catch { return ""; }
  }

  function truncateBody(s, max) {
    if (!s) return "";
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  // v2.8.8 — per-card "Copy" button. Distinct from the existing
  // "Copy prompt" (which builds an LLM-triage prompt for warn/alert
  // entries). This one is the operator's relay path: copy the raw
  // notification so they can paste it into a chat with devs / Evy /
  // an external tool without retyping. Field order matches the spec
  // (title + body + ts + kind); kind is last because it's the least
  // human-relevant in a paste, more of a footer breadcrumb.
  function buildCardCopyText(n) {
    const title = n.title || "(no title)";
    const body  = n.body || "(no body)";
    const ts    = n.ts || "(unknown time)";
    const kind  = n.kind || "(unknown kind)";
    return [
      title,
      "",
      body,
      "",
      "ts: " + ts,
      "kind: " + kind,
    ].join("\n");
  }

  function buildCopyPrompt(n) {
    // Spec-fixed format. Keeping the field order stable so operators
    // can pattern-match it in chat history if they paste this into the
    // same model multiple times.
    const meta = n.metadata
      ? (() => { try { return JSON.stringify(n.metadata); } catch { return "(unserializable)"; } })()
      : "(none)";
    const sev = n.severity || "info";
    const lines = [
      "Notification (severity: " + sev + "): " + (n.title || "(no title)"),
      "",
      n.body || "(no body)",
      "",
      "Context:",
      "- Team: " + (n.team_id || "(none)"),
      "- Time: " + (n.ts || "(unknown)"),
      "- Kind: " + (n.kind || "(unknown)"),
      "- Metadata: " + meta,
      "",
      "Please suggest a fix or appropriate escalation.",
    ];
    return lines.join("\n");
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    // Fallback for older browsers / non-secure contexts.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  // Shared item store keyed by id. Both the dropdown render and the
  // toast surface read from this — so a notification dismissed via the
  // toast is also gone from the dropdown.
  const _notifItems = new Map(); // id → notification

  function initNotificationTray() {
    const bell = document.getElementById("notif-bell");
    const bellIcon = document.getElementById("notif-bell-icon");
    const badge = document.getElementById("notif-bell-badge");
    const tray = document.getElementById("notif-tray");
    const list = document.getElementById("notif-tray-list");
    const closeBtn = document.getElementById("notif-tray-close");
    const readAllBtn = document.getElementById("notif-tray-readall");
    const toastStack = document.getElementById("notif-toast-stack");
    if (!bell || !badge || !tray || !list) return;

    // Paint the inbox icon into the bell button + close glyph. Done
    // here (not in the static HTML) so a missing /icons.js still leaves
    // the dropdown clickable — getIcon() returns '' and the button is
    // empty but functional.
    if (bellIcon) bellIcon.innerHTML = getIcon("inbox", { size: 16 });
    if (closeBtn) closeBtn.innerHTML = getIcon("x", { size: 14 });

    let trayOpen = false;
    let sse = null;

    function render() {
      const sorted = [..._notifItems.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const unread = sorted.filter((n) => !n.read_at).length;
      const hasAlert = sorted.some((n) => n.severity === "alert" && !n.read_at);
      bell.classList.toggle("has-alert", hasAlert);
      if (unread > 0) {
        badge.hidden = false;
        badge.textContent = unread > 99 ? "99+" : String(unread);
      } else {
        badge.hidden = true;
      }
      if (sorted.length === 0) {
        list.innerHTML = '<div class="notif-tray-empty">No notifications</div>';
        return;
      }
      const top = sorted.slice(0, 20);
      list.innerHTML = top.map((n) => {
        const cls = ["notif-item", "sev-" + (n.severity || "info"), n.read_at ? "read" : "unread"].join(" ");
        const sevIcon = getIcon(severityIconName(n.severity), { size: 14 });
        const detail = n.body
          ? '<div class="notif-item-detail" title="' + escapeHtml(n.body) + '">' + escapeHtml(truncateBody(n.body, 80)) + '</div>'
          : "";
        const dismissBtn =
          '<button type="button" class="notif-item-dismiss" data-notif-dismiss="' +
          escapeHtml(n.id) +
          '" title="Dismiss" aria-label="Dismiss">' +
          getIcon("x", { size: 12 }) +
          '</button>';
        const copyBtn = isErrorishNotification(n)
          ? '<button type="button" class="notif-item-copy" data-notif-copy="' +
            escapeHtml(n.id) +
            '" title="Copy a prompt for an LLM to triage">' +
            getIcon("clipboard", { size: 12 }) +
            ' <span class="notif-item-copy-label">Copy prompt</span></button>'
          : "";
        // v2.8.8 — per-card Copy button (always shown). Lives next to
        // the existing copyBtn so errorish cards get both. Wired in
        // the click delegate below via data-notif-copy-card.
        const copyCardBtn =
          '<button type="button" class="notif-item-copy" data-notif-copy-card="' +
          escapeHtml(n.id) +
          '" title="Copy notification (title + body + time + kind)">' +
          getIcon("copy", { size: 12 }) +
          ' <span class="notif-item-copy-label">Copy</span></button>';
        return [
          '<div class="' + cls + '" data-notif-id="' + escapeHtml(n.id) + '">',
          '  <div class="notif-item-glyph">' + sevIcon + '</div>',
          '  <div class="notif-item-body">',
          '    <div class="notif-item-title">' + escapeHtml(n.title || "(no title)") + '</div>',
              detail,
          '    <div class="notif-item-meta">',
          '      <span class="notif-item-when" title="' + escapeHtml(n.ts || "") + '">' + escapeHtml(fmtRelative(n.ts)) + '</span>',
                copyCardBtn,
                copyBtn,
          '    </div>',
          '  </div>',
              dismissBtn,
          '</div>',
        ].join("");
      }).join("");
    }

    async function loadInitial() {
      try {
        const r = await fetch("/api/notifications?limit=50");
        const j = await r.json();
        if (j && j.ok && Array.isArray(j.notifications)) {
          for (const n of j.notifications) _notifItems.set(n.id, n);
        }
      } catch { /* offline; SSE will pick up live */ }
      render();
    }

    function spawnToast(n) {
      if (!toastStack) return;
      // Cap at 3 visible — remove oldest as new ones arrive.
      while (toastStack.children.length >= 3) {
        toastStack.removeChild(toastStack.firstElementChild);
      }
      const wrap = document.createElement("div");
      wrap.className = "notif-toast sev-" + (n.severity || "info");
      wrap.setAttribute("role", n.severity === "alert" ? "alert" : "status");
      wrap.innerHTML = [
        '<div class="notif-toast-glyph">' + getIcon(severityIconName(n.severity), { size: 14 }) + '</div>',
        '<div class="notif-toast-body">',
        '  <div class="notif-toast-title">' + escapeHtml(n.title || "(no title)") + '</div>',
        n.body ? '<div class="notif-toast-detail">' + escapeHtml(truncateBody(n.body, 120)) + '</div>' : "",
        '</div>',
        '<button type="button" class="notif-toast-close" aria-label="Close">' + getIcon("x", { size: 12 }) + '</button>',
      ].join("");
      toastStack.appendChild(wrap);
      // Trigger the slide-in.
      requestAnimationFrame(() => wrap.classList.add("show"));
      const dismiss = () => {
        wrap.classList.remove("show");
        wrap.classList.add("leaving");
        // 250ms CSS fade-out — drop the node after.
        setTimeout(() => {
          if (wrap.parentNode === toastStack) toastStack.removeChild(wrap);
        }, 250);
      };
      const closeBtnT = wrap.querySelector(".notif-toast-close");
      if (closeBtnT) closeBtnT.addEventListener("click", dismiss);
      // Auto-dismiss after 5s for info/warn; alerts hold 8s.
      const holdMs = n.severity === "alert" ? 8000 : 5000;
      setTimeout(dismiss, holdMs);
    }

    // Spawn a transient "prompt copied" confirmation. Reuses the toast
    // stack so it queues correctly with notification toasts.
    function spawnConfirmToast(label) {
      if (!toastStack) return;
      const wrap = document.createElement("div");
      wrap.className = "notif-toast sev-info notif-toast-confirm";
      wrap.setAttribute("role", "status");
      wrap.innerHTML = [
        '<div class="notif-toast-glyph">' + getIcon("check", { size: 14 }) + '</div>',
        '<div class="notif-toast-body">',
        '  <div class="notif-toast-title">' + escapeHtml(label) + '</div>',
        '</div>',
      ].join("");
      toastStack.appendChild(wrap);
      requestAnimationFrame(() => wrap.classList.add("show"));
      setTimeout(() => {
        wrap.classList.remove("show");
        wrap.classList.add("leaving");
        setTimeout(() => {
          if (wrap.parentNode === toastStack) toastStack.removeChild(wrap);
        }, 250);
      }, 1800);
    }

    function openSse() {
      if (sse) try { sse.close(); } catch {}
      try {
        sse = new EventSource("/api/notifications/stream");
        sse.addEventListener("notification", (ev) => {
          try {
            const n = JSON.parse(ev.data);
            if (!n || !n.id) return;
            const isNew = !_notifItems.has(n.id);
            _notifItems.set(n.id, n);
            render();
            // Only spawn a toast on FIRST sight of a notification — SSE
            // re-deliveries shouldn't re-toast. Also don't toast for
            // entries that arrive already-read (e.g. backfill).
            if (isNew && !n.read_at) spawnToast(n);
          } catch { /* malformed payload — skip */ }
        });
        sse.addEventListener("error", () => {
          // EventSource reconnects automatically; nothing to do here.
        });
      } catch { /* SSE unsupported; REST seed still works */ }
    }

    // v2.8.1 — centralized open/close so bell, [x], ESC, and outside-click
    // all funnel through the same state-mutating helper. The previous
    // wiring scattered `trayOpen = …; tray.hidden = …` across five
    // listeners, which made the regression surface (operator screenshot
    // 2026-05-13: "mailbox click doesn't toggle, [×] doesn't close")
    // harder to reason about. One setter, four callers.
    function setTrayOpen(open) {
      trayOpen = !!open;
      tray.hidden = !trayOpen;
      if (trayOpen) loadInitial();
    }

    bell.addEventListener("click", (ev) => {
      ev.stopPropagation(); // don't let the document outside-click fire
      setTrayOpen(!trayOpen);
    });
    if (closeBtn) closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setTrayOpen(false);
    });
    if (readAllBtn) readAllBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        await fetch("/api/notifications/read-all", { method: "POST" });
      } catch {}
      const now = new Date().toISOString();
      for (const n of _notifItems.values()) if (!n.read_at) n.read_at = now;
      render();
    });

    list.addEventListener("click", async (ev) => {
      // Dismiss → POST /:id/read + mark locally so it fades to "read"
      // (matches mark-all-read semantics). v2.7.25 deleted from the local
      // map, which felt right until you reopened the tray — loadInitial()
      // re-fetches from the master ring and the dismissed item came back
      // as unread, looking like the X had failed. Marking locally + remote
      // gives a stable visual ("this one is done") consistent with reload.
      const dismissBtn = ev.target.closest("button[data-notif-dismiss]");
      if (dismissBtn) {
        ev.stopPropagation();
        const id = dismissBtn.getAttribute("data-notif-dismiss");
        if (!id) return;
        try {
          await fetch("/api/notifications/" + encodeURIComponent(id) + "/read", { method: "POST" });
        } catch {}
        const n = _notifItems.get(id);
        if (n && !n.read_at) n.read_at = new Date().toISOString();
        render();
        return;
      }
      // v2.8.8 Copy (per-card relay) → copy the raw notification so
      // the operator can paste it into chat with devs/Evy/external
      // tools. Distinct from the LLM-triage "Copy prompt" below.
      // The two attributes (`data-notif-copy-card` vs `data-notif-copy`)
      // are disjoint CSS attribute selectors, so handler order is
      // safe — each button only carries one of them.
      const copyCardBtn = ev.target.closest("button[data-notif-copy-card]");
      if (copyCardBtn) {
        ev.stopPropagation();
        const id = copyCardBtn.getAttribute("data-notif-copy-card");
        const n = id ? _notifItems.get(id) : null;
        if (!n) return;
        const ok = await copyTextToClipboard(buildCardCopyText(n));
        spawnConfirmToast(ok ? "Copied ✓" : "Copy failed");
        return;
      }
      // Copy prompt → build prompt string + clipboard + confirm toast.
      const copyBtn = ev.target.closest("button[data-notif-copy]");
      if (copyBtn) {
        ev.stopPropagation();
        const id = copyBtn.getAttribute("data-notif-copy");
        const n = id ? _notifItems.get(id) : null;
        if (!n) return;
        const ok = await copyTextToClipboard(buildCopyPrompt(n));
        spawnConfirmToast(ok ? "Prompt copied" : "Copy failed");
        return;
      }
    });

    // Click outside the tray closes it (but not when clicking the bell).
    // stopPropagation on the bell handler keeps this from racing the
    // bell's toggle on the same click.
    document.addEventListener("click", (ev) => {
      if (!trayOpen) return;
      if (tray.contains(ev.target) || bell.contains(ev.target)) return;
      setTrayOpen(false);
    });

    // v2.8.1 — ESC closes the dropdown. Standard tray UX; the v2.7.25
    // surface only honored the [×] button + outside-click, which felt
    // off when the keyboard had focus.
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!trayOpen) return;
      setTrayOpen(false);
    });

    loadInitial();
    openSse();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNotificationTray, { once: true });
  } else {
    initNotificationTray();
  }

  // ── v2.7.25 chrome icons (ADR 0016) ──────────────────────────────────
  // Replace remaining emoji-as-icon in static chrome with Lucide SVGs.
  // The bell + tray are owned by initNotificationTray() above; this is
  // for the rest of the surface that the audit identified:
  //   • Master chat attach button (📎 → paperclip)
  //
  // Tool-family icons (🔧 🖥 🧠 …) live in /tool-display.json which is
  // operator-editable CONTENT config, not chrome — left alone. Sidebar
  // nav glyphs (◉ ⚙ ▣ …) are unicode geometric shapes, not emoji, and
  // render consistently across platforms — left alone. Verdict glyphs
  // (🟢 🟡 🔴) are operator-facing state indicators rendered into
  // textContent and don't suffer the bell's render-roulette problem —
  // left alone (the surrounding `.dispatch-verdict.green/yellow/red`
  // CSS classes carry the color signal too).
  function initLucideChrome() {
    const attachBtn = document.getElementById("master-attach-btn");
    if (attachBtn && !attachBtn.innerHTML.trim()) {
      attachBtn.innerHTML = getIcon("paperclip", { size: 14 });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLucideChrome, { once: true });
  } else {
    initLucideChrome();
  }

  // ── v2.7.25 + v2.7.37 — Upstreams card ──────────────────────────────
  // Surfaces the master's upstream-check watchdog state in the Memory
  // tab. Loads once when the Memory tab becomes active (cheap GET, no
  // SSE); "Check now" pokes the master's manual-tick endpoint; v2.7.37
  // adds an "Update now" manual-trigger button, an "Auto-update" gate
  // toggle, and an expandable history of the last 20 audit entries.
  function initUpstreamsCard() {
    const card = document.getElementById("upstreams-card");
    if (!card) return;
    const grid = document.getElementById("upstreams-grid");
    const lastChecked = document.getElementById("upstreams-last-checked");
    const status = document.getElementById("upstreams-status");
    const btn = document.getElementById("upstreams-check-btn");
    const updateBtn = document.getElementById("upstreams-update-btn");
    const autoToggle = document.getElementById("upstreams-auto-toggle");
    const historyList = document.getElementById("upstreams-history-list");
    const historyDetails = document.getElementById("upstreams-history-details");
    if (!grid || !btn) return;

    let loaded = false;

    function fmtAgo(iso) {
      if (!iso) return "never checked";
      try {
        const ms = Date.now() - Date.parse(iso);
        if (Number.isNaN(ms) || ms < 0) return "just now";
        if (ms < 60_000) return "checked " + Math.floor(ms / 1000) + "s ago";
        if (ms < 3600_000) return "checked " + Math.floor(ms / 60_000) + "m ago";
        if (ms < 86_400_000) return "checked " + Math.floor(ms / 3600_000) + "h ago";
        return "checked " + Math.floor(ms / 86_400_000) + "d ago";
      } catch { return "never checked"; }
    }

    function render(payload) {
      if (!payload || !Array.isArray(payload.results)) {
        grid.innerHTML = '<div class="dim small">no data yet — click Check now</div>';
        lastChecked.textContent = "never checked";
        return;
      }
      lastChecked.textContent = fmtAgo(payload.checked_at);
      if (payload.results.length === 0) {
        grid.innerHTML = '<div class="dim small">no packages tracked</div>';
        return;
      }
      grid.innerHTML = payload.results.map((r) => {
        const cls = r.has_update ? "upstream-row has-update" : "upstream-row";
        const ver = r.error
          ? '<span class="upstream-version" title="' + escapeHtml(r.error) + '">error</span>'
          : (r.has_update
            ? '<span class="upstream-version" title="bump: ' + escapeHtml(r.bump_kind) + '">' + escapeHtml(r.pinned) + ' → ' + escapeHtml(r.latest) + '</span>'
            : '<span class="upstream-version">' + escapeHtml(r.pinned) + ' (latest)</span>');
        return [
          '<div class="' + cls + '">',
          '  <span class="upstream-icon">' + getIcon("package", { size: 14 }) + '</span>',
          '  <span class="upstream-name">' + escapeHtml(r.package) + '</span>',
              ver,
          '</div>',
        ].join("");
      }).join("");
      const auto = payload.auto_update_enabled
        ? "auto-update gate: ON (" + escapeHtml(payload.auto_update_flag_path || "") + ")"
        : "auto-update gate: OFF";
      status.textContent = auto;
      if (autoToggle) {
        autoToggle.checked = !!payload.auto_update_enabled;
      }
      // v2.7.37 — pre-populate the history list from the snapshot.
      // describeUpstreamState() ships the last 10 entries; the
      // expandable list lazy-loads more if the operator opens it.
      if (historyList && Array.isArray(payload.recent_updates)) {
        renderHistory(payload.recent_updates);
      }
    }

    function renderHistory(entries) {
      if (!historyList) return;
      if (!entries || entries.length === 0) {
        historyList.innerHTML = '<div class="dim small">no history yet</div>';
        return;
      }
      historyList.innerHTML = entries.map((e) => {
        const okIcon = e.event === "success" ? "✓" : (e.event === "throttled" ? "⏳" : "✗");
        const branch = e.branch ? '<span class="dim small"> branch=' + escapeHtml(e.branch) + '</span>' : "";
        const trigger = e.trigger ? '<span class="dim small"> · ' + escapeHtml(e.trigger) + '</span>' : "";
        const detail = e.detail ? '<div class="dim small upstream-history-detail">' + escapeHtml(String(e.detail).slice(0, 240)) + '</div>' : "";
        return [
          '<div class="upstream-history-row">',
          '  <span class="upstream-history-icon">' + okIcon + '</span>',
          '  <span class="upstream-history-pkg">' + escapeHtml(e.package || "?") + '</span>',
          '  <span class="upstream-history-ver">' + escapeHtml(e.from || "?") + ' → ' + escapeHtml(e.to || "?") + '</span>',
          '  <span class="upstream-history-ts dim small">' + escapeHtml(e.ts || "") + '</span>',
          branch, trigger, detail,
          '</div>',
        ].join("");
      }).join("");
    }

    async function loadHistory() {
      if (!historyList) return;
      try {
        const r = await fetch("/api/upstreams/history?limit=20");
        const j = await r.json();
        if (j && j.ok) renderHistory(j.entries || []);
      } catch (err) {
        historyList.innerHTML = '<div class="dim small">history unreachable: ' + escapeHtml(String(err && err.message || err)) + '</div>';
      }
    }

    async function load() {
      try {
        const r = await fetch("/api/upstreams");
        const j = await r.json();
        if (j && j.ok) render(j);
      } catch (err) {
        grid.innerHTML = '<div class="dim small">master unreachable: ' + escapeHtml(String(err && err.message || err)) + '</div>';
      }
    }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "checking…";
      try {
        const r = await fetch("/api/upstreams/check", { method: "POST" });
        const j = await r.json();
        if (j && j.ok) render(j);
      } catch (err) {
        if (status) status.textContent = "check failed: " + String(err && err.message || err);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    if (updateBtn) {
      // v2.7.37 — manual auto-update. Bypasses the 24h throttle. Long-
      // running (worktree + bun install + test + build + typecheck +
      // push); UI just shows a spinner until the master returns.
      updateBtn.addEventListener("click", async () => {
        const ok = window.confirm(
          "Manual upstream update will create a worktree under /tmp, run bun install + test + build + typecheck, " +
          "commit, and push a chore/upstream-* branch (NOT merge). This may take several minutes. Continue?",
        );
        if (!ok) return;
        updateBtn.disabled = true;
        const orig = updateBtn.textContent;
        updateBtn.textContent = "updating…";
        try {
          const r = await fetch("/api/upstreams/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "update failed");
          await load();
          await loadHistory();
        } catch (err) {
          if (status) status.textContent = "update failed: " + String(err && err.message || err);
        } finally {
          updateBtn.disabled = false;
          updateBtn.textContent = orig;
        }
      });
    }

    if (autoToggle) {
      // v2.7.37 — gate flag toggle. Hits the master's
      // /upstreams/auto-update/toggle endpoint, which touches/removes
      // ~/.config/subctl/auto-update-upstreams.enabled.
      autoToggle.addEventListener("change", async () => {
        const desired = !!autoToggle.checked;
        autoToggle.disabled = true;
        try {
          const r = await fetch("/api/upstreams/auto-update/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: desired }),
          });
          const j = await r.json();
          if (!j.ok) {
            // Roll back the visual state — server refused.
            autoToggle.checked = !desired;
            if (status) status.textContent = "toggle failed";
          } else {
            await load();
          }
        } catch (err) {
          autoToggle.checked = !desired;
          if (status) status.textContent = "toggle failed: " + String(err && err.message || err);
        } finally {
          autoToggle.disabled = false;
        }
      });
    }

    if (historyDetails) {
      // Lazy-load the full 20-entry list the first time the
      // operator expands the disclosure widget — the snapshot in
      // /api/upstreams only carries 10 entries.
      let historyLoaded = false;
      historyDetails.addEventListener("toggle", () => {
        if (historyDetails.open && !historyLoaded) {
          historyLoaded = true;
          loadHistory();
        }
      });
    }

    // Lazy-load on Memory tab activation. The tab switcher sets
    // document.body.dataset.activeTab — observe it. If we're already
    // on memory at boot, load immediately.
    function maybeLoad() {
      if (loaded) return;
      const active = document.body && document.body.dataset && document.body.dataset.activeTab;
      if (active !== "memory") return;
      loaded = true;
      load();
    }
    maybeLoad();
    if (typeof MutationObserver === "function") {
      new MutationObserver(maybeLoad).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-active-tab"],
      });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUpstreamsCard, { once: true });
  } else {
    initUpstreamsCard();
  }


  // Kick off — also try polling immediately so first paint isn't blocked
  // on the WS handshake.
  startPolling();
  connectWS();

  // ── v2.8.8: update-flow chip wiring ───────────────────────────────────
  // The brand-version chip is now a <button id="version-chip">. The inner
  // <span id="version"> still gets text-content-updated by render(state),
  // and a CSS pseudo-element on the button renders the dot keyed off
  // data-update-state. We:
  //   1. Poll /api/update/check every 5min — flips data-update-state to
  //      "available" if the running version is behind origin/main.
  //   2. Subscribe to /api/update/events for a real-time `update_available`
  //      push, so the wiggle fires without waiting for the next poll.
  //   3. Lazy-load /update-modal.js on first click — keeps initial JS lean.
  function initUpdateChip() {
    const chip = document.getElementById("version-chip");
    if (!chip) return;

    let modalModule = null;
    async function openModal() {
      if (!modalModule) {
        try {
          modalModule = await import("/update-modal.js");
        } catch (err) {
          console.error("[update] failed to load update-modal.js", err);
          return;
        }
      }
      const api = modalModule.openUpdateModal ?? window.__subctlUpdateModal?.open;
      if (typeof api === "function") api();
    }
    chip.addEventListener("click", openModal);

    async function pollCheck() {
      try {
        const r = await fetch("/api/update/check");
        if (!r.ok) return;
        const j = await r.json();
        if (j && j.has_update === true) {
          // Don't clobber updating/done while a run is in flight.
          const current = chip.dataset.updateState;
          if (current !== "updating") chip.dataset.updateState = "available";
        } else if (chip.dataset.updateState === "available") {
          // Cleared upstream — drop back to idle.
          chip.dataset.updateState = "idle";
        }
      } catch { /* network blip — try again next cycle */ }
    }
    pollCheck();
    setInterval(pollCheck, 5 * 60 * 1000);

    // Real-time push: master/dashboard can broadcast update_available on
    // its own (e.g., from the upstreams watcher). EventSource auto-reconnects
    // on drop so we don't need explicit retry logic.
    try {
      const es = new EventSource("/api/update/events");
      es.addEventListener("update_available", () => {
        if (chip.dataset.updateState !== "updating") {
          chip.dataset.updateState = "available";
        }
      });
      es.addEventListener("update_started", () => {
        chip.dataset.updateState = "updating";
      });
      es.addEventListener("update_finished", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          chip.dataset.updateState = data.ok ? "done" : "available";
          // After a short cool-off, revert to idle so the chip doesn't stay
          // green forever; the next /api/update/check tick will re-paint
          // "available" if a newer tag exists post-update.
          if (data.ok) {
            setTimeout(() => {
              if (chip.dataset.updateState === "done") chip.dataset.updateState = "idle";
              pollCheck();
            }, 5000);
          }
        } catch { /* swallow malformed events */ }
      });
    } catch (err) {
      console.warn("[update] EventSource unavailable", err);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUpdateChip, { once: true });
  } else {
    initUpdateChip();
  }
})();
