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
  wireMasterChat();
  wireModelsTab();
  wireProjectsTab();
  wireMemoryTab();
  wireChatModelSelector();
  wireOrchestrationCockpit();

  // ----- Chat model selector (top of Chat screen) -----
  function wireChatModelSelector() {
    const sel = $("chat-model-select");
    const apply = $("chat-model-apply");
    const cur = $("chat-model-current");
    if (!sel || !apply) return;
    let currentSupervisor = null;

    async function refresh() {
      try {
        const [modelsR, healthR] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/master/health"),
        ]);
        const models = await modelsR.json();
        const health = await healthR.json().catch(() => ({}));
        // Best-effort: pull supervisor model from /diag (which already includes it)
        let supervisor = null;
        try {
          const diagR = await fetch("/api/master/diag");
          const diag = await diagR.json();
          supervisor = diag.supervisor ?? null;
        } catch {}
        currentSupervisor = supervisor;
        if (cur) cur.textContent = supervisor ? "supervisor: " + supervisor : "supervisor: (unknown)";
        if (!models.ok) {
          sel.innerHTML = "<option value=''>LM Studio unreachable</option>";
          return;
        }
        const opts = (models.models || [])
          .filter((m) => m.type === "vlm" || m.type === "llm")
          .sort((a, b) => {
            if (a.state === "loaded" && b.state !== "loaded") return -1;
            if (a.state !== "loaded" && b.state === "loaded") return 1;
            return (a.id || "").localeCompare(b.id || "");
          })
          .map((m) => {
            const id = m.id;
            const fullId = m.publisher ? `${m.publisher}/${id}` : id;
            // currentSupervisor format: "lmstudio/qwen/qwen3.6-35b-a3b"
            const isCurrent = currentSupervisor && currentSupervisor.endsWith("/" + id);
            const label = `${id}  · ${m.state}  · ${m.quantization || "?"}  · ctx ${m.loaded_context_length || "?"}`;
            return `<option value="${id}" ${isCurrent ? "selected" : ""}>${escapeText(label)}</option>`;
          })
          .join("");
        sel.innerHTML = opts || "<option value=''>(no chat models)</option>";
      } catch (err) {
        sel.innerHTML = "<option value=''>error: " + escapeText(String(err)) + "</option>";
      }
    }
    refresh();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"chat\"]");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 10000);

    apply.addEventListener("click", async () => {
      const picked = sel.value;
      if (!picked) return;
      if (!confirm("Switch master supervisor to " + picked + "?\nThis edits providers.json and restarts the master daemon. Transcript is preserved.")) return;
      apply.disabled = true;
      apply.textContent = "applying…";
      try {
        const r = await fetch("/api/master/supervisor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: picked }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) {
          apply.textContent = "failed";
          alert("Switch failed: " + (j.error || r.status));
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; }, 2000);
        } else {
          apply.textContent = "switched ✓";
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; refresh(); }, 3500);
        }
      } catch (err) {
        apply.textContent = "error";
        alert("Switch error: " + err);
      }
    });
  }

  // ----- Orchestration cockpit -----
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
            const ev = document.createElement("div");
            ev.className = "last-event";
            ev.textContent = t.last_event.type + ": " + (t.last_event.text || "(no text)");
            card.appendChild(ev);
          } else {
            const meta = document.createElement("div");
            meta.className = "meta";
            meta.textContent = "no reports yet";
            card.appendChild(meta);
          }
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
        } catch {}
      });
      es.addEventListener("watchdog_ok", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLiveRow("watchdog", "ok", `${d.teams_tracked ?? 0} teams, ${d.stale ?? 0} stale`);
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

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ----- Models tab — LM Studio model catalog -----
  function wireModelsTab() {
    const body = $("models-body");
    const status = $("models-status");
    const summary = $("models-summary");
    if (!body) return;
    let pollTimer = null;

    async function refresh() {
      try {
        const r = await fetch("/api/models");
        const j = await r.json();
        if (!j.ok) {
          if (status) { status.textContent = "unreachable"; status.dataset.state = "err"; }
          body.replaceChildren(emptyRow(9, j.error || "LM Studio API unreachable"));
          if (summary) summary.textContent = "";
          return;
        }
        if (status) { status.textContent = "live"; status.dataset.state = "ok"; }
        if (summary) {
          summary.innerHTML =
            `<span><strong>${j.total}</strong> total</span> · ` +
            `<span><strong>${j.loaded_count}</strong> loaded</span> · ` +
            `<span class="dim">host ${j.host}</span> · ` +
            `<span class="dim">refreshed ${new Date(j.ts).toLocaleTimeString()}</span>`;
        }
        const sorted = (j.models || []).slice().sort((a, b) => {
          if (a.state === "loaded" && b.state !== "loaded") return -1;
          if (a.state !== "loaded" && b.state === "loaded") return 1;
          return (a.id || "").localeCompare(b.id || "");
        });
        if (sorted.length === 0) {
          body.replaceChildren(emptyRow(9, "no models"));
          return;
        }
        body.replaceChildren(...sorted.map((m) => {
          const tr = document.createElement("tr");
          if (m.state === "loaded") tr.classList.add("model-loaded");
          tr.appendChild(td(m.id));
          tr.appendChild(td(m.type || "—"));
          const stateCell = document.createElement("td");
          const pill = document.createElement("span");
          pill.className = "model-state-pill model-state-" + (m.state || "unknown");
          pill.textContent = m.state || "?";
          stateCell.appendChild(pill);
          tr.appendChild(stateCell);
          tr.appendChild(td(m.publisher || "—"));
          tr.appendChild(td(m.arch || "—"));
          tr.appendChild(td(m.quantization || "—"));
          tr.appendChild(td(m.max_context_length ? m.max_context_length.toLocaleString() : "—", "num"));
          tr.appendChild(td(m.loaded_context_length ? m.loaded_context_length.toLocaleString() : "—", "num"));
          const capsCell = document.createElement("td");
          (m.capabilities || []).forEach((c) => {
            const cp = document.createElement("span");
            cp.className = "model-cap-pill";
            cp.textContent = c;
            capsCell.appendChild(cp);
          });
          if (!(m.capabilities || []).length) capsCell.textContent = "—";
          tr.appendChild(capsCell);
          return tr;
        }));
      } catch (err) {
        if (status) { status.textContent = "error"; status.dataset.state = "err"; }
        body.replaceChildren(emptyRow(9, "fetch error: " + err));
      }
    }

    // Refresh once on load + every 5s while the Models tab is visible.
    refresh();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      refresh();
    });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const panel = $("models-panel");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 5000);
  }

  // ----- Projects screen — master/detail with drill-down -----
  function wireProjectsTab() {
    const listEl = $("projects-list");
    const detailEl = $("project-detail-pane");
    const detailEmpty = $("project-detail-empty");
    const filterEl = $("project-list-filter");
    const rootEl = $("projects-root");
    if (!listEl || !detailEl) return;

    let allProjects = [];
    let selectedName = null;
    let filterText = "";

    function applyFilter() {
      const q = filterText.toLowerCase();
      const items = !q
        ? allProjects
        : allProjects.filter((p) => (p.name || "").toLowerCase().includes(q));
      if (!items.length) {
        listEl.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">no matches</div>";
        return;
      }
      listEl.replaceChildren(...items.map((p) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "project-list-item";
        if (p.name === selectedName) item.classList.add("selected");
        if (p.in_policy) item.classList.add("in-policy");
        const name = document.createElement("div");
        name.className = "project-list-name";
        name.textContent = p.name;
        item.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "project-list-meta";
        meta.textContent = (p.branch || "—") + " · " + (p.in_policy ? "tracked" : "untracked");
        item.appendChild(meta);
        item.addEventListener("click", () => selectProject(p.name));
        return item;
      }));
    }

    async function refreshList() {
      try {
        const r = await fetch("/api/projects");
        const j = await r.json();
        if (!j.ok) {
          listEl.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">scan failed: " + escapeText(j.error || "?") + "</div>";
          return;
        }
        if (rootEl) rootEl.textContent = j.code_root;
        allProjects = j.projects || [];
        applyFilter();
      } catch (err) {
        listEl.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    if (filterEl) {
      filterEl.addEventListener("input", () => {
        filterText = filterEl.value;
        applyFilter();
      });
    }

    async function selectProject(name) {
      selectedName = name;
      applyFilter();
      detailEl.innerHTML = "<div class=\"dim small\" style=\"padding:24px\">loading project…</div>";
      try {
        const r = await fetch("/api/projects/" + encodeURIComponent(name));
        const j = await r.json();
        if (!j.ok) {
          detailEl.innerHTML = "<div class=\"dim\" style=\"padding:24px\">load failed: " + escapeText(j.error || "?") + "</div>";
          return;
        }
        renderProjectDetail(j);
      } catch (err) {
        detailEl.innerHTML = "<div class=\"dim\" style=\"padding:24px\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    function fmtCommit(c) {
      if (!c) return "(no commits)";
      const parts = String(c).split("\t");
      return parts.length === 4
        ? `${parts[0]}  ${parts[1]} (${parts[2]} · ${parts[3]})`
        : c;
    }

    function renderProjectDetail(p) {
      const ghLink = p.github_repo
        ? `<a href="https://github.com/${escapeText(p.github_repo)}" target="_blank">github.com/${escapeText(p.github_repo)}</a>`
        : "<span class=\"dim\">no GitHub remote</span>";
      const dirtyPill = p.dirty ? "<span class=\"pill pill-warn\">dirty</span>" : "<span class=\"pill pill-ok\">clean</span>";
      const aheadBehind =
        (p.ahead ? `<span class=\"pill pill-info\">↑ ${p.ahead}</span>` : "") +
        (p.behind ? `<span class=\"pill pill-warn\">↓ ${p.behind}</span>` : "");
      const policyPill = p.in_policy
        ? `<span class=\"pill pill-ok\">tracked · ${escapeText(p.policy?.autonomy_level || "")}</span>`
        : "<span class=\"pill pill-dim\">untracked</span>";

      // PRs
      const prRows = (p.prs || []).map((pr) => {
        const ci = (pr.statusCheckRollup || []).slice(0, 5).map((c) => {
          const cls = c.conclusion === "SUCCESS" ? "ok" : c.conclusion === "FAILURE" ? "err" : "warn";
          return `<span class="ci-pill ci-${cls}" title="${escapeText(c.name || "")}">${escapeText(c.conclusion || c.status || "?")}</span>`;
        }).join("");
        return `<div class="pr-row">
          <a href="${escapeText(pr.url)}" target="_blank">#${pr.number}</a>
          <span class="pr-title">${escapeText(pr.title || "")}</span>
          ${pr.isDraft ? "<span class=\"pill pill-dim\">draft</span>" : ""}
          <span class="ci-stack">${ci}</span>
        </div>`;
      }).join("") || "<div class=\"dim small\">no open PRs</div>";

      // Issues
      const issueRows = (p.issues || []).slice(0, 8).map((iss) =>
        `<div class="issue-row"><a href="${escapeText(iss.url)}" target="_blank">#${iss.number}</a> ${escapeText(iss.title || "")}</div>`,
      ).join("") || "<div class=\"dim small\">no open issues</div>";

      // Recent commits
      const commitRows = (p.recent_commits || []).slice(0, 8).map((c) =>
        `<div class="commit-row"><code>${escapeText(c.sha)}</code> ${escapeText(c.subject)} <span class="dim">· ${escapeText(c.when)} · ${escapeText(c.author)}</span></div>`,
      ).join("") || "<div class=\"dim small\">no commits</div>";

      // Dev teams
      const teamRows = (p.dev_teams || []).map((t) =>
        `<div class="team-row"><strong>${escapeText(t.name)}</strong> <span class="dim small">${t.attached ? "attached" : "detached"}</span></div>`,
      ).join("") || "<div class=\"dim small\">no dev teams running for this project</div>";

      // Decisions
      const decisionRows = (p.decisions || []).slice(0, 10).map((d) =>
        `<div class="decision-row"><span class="dim small">${escapeText(d.ts || "")}</span> <strong>${escapeText(d.action || "")}</strong> — ${escapeText(d.rationale || "")}</div>`,
      ).join("") || "<div class=\"dim small\">no decisions logged for this project yet</div>";

      // Vault
      const vault = p.vault || {};
      const vaultBlock = vault.exists
        ? `<div><code>${escapeText(vault.project_dir)}</code> <span class="pill pill-ok">exists</span></div>`
        : `<div><span class="dim">no vault yet at</span> <code>${escapeText(vault.project_dir)}</code></div>`;

      detailEl.innerHTML = `
        <div class="project-detail">
          <header class="project-detail-header">
            <div class="pdh-title">
              <h2>${escapeText(p.name)}</h2>
              <div class="pdh-pills">
                ${policyPill}
                ${dirtyPill}
                ${aheadBehind}
              </div>
            </div>
            <div class="pdh-meta">
              <div><span class="dim">path</span> <code>${escapeText(p.path)}</code></div>
              <div><span class="dim">branch</span> ${escapeText(p.branch || "—")} · ${ghLink}</div>
            </div>
            <div class="pdh-actions">
              <button type="button" class="primary-btn" data-action="spawn-team">Spawn dev team</button>
              <button type="button" class="secondary-btn" data-action="open-vault">Open vault path</button>
              ${p.github_repo ? `<a class="secondary-btn" href="https://github.com/${escapeText(p.github_repo)}" target="_blank">Open on GitHub</a>` : ""}
            </div>
          </header>

          <div class="project-detail-grid">
            <section class="pd-card">
              <h3>Open PRs <span class="dim small">${(p.prs || []).length}</span></h3>
              ${prRows}
            </section>
            <section class="pd-card">
              <h3>Open Issues <span class="dim small">${(p.issues || []).length}</span></h3>
              ${issueRows}
            </section>
            <section class="pd-card">
              <h3>Dev teams</h3>
              ${teamRows}
            </section>
            <section class="pd-card">
              <h3>Vault</h3>
              ${vaultBlock}
            </section>
            <section class="pd-card pd-card-wide">
              <h3>Recent commits</h3>
              ${commitRows}
            </section>
            <section class="pd-card pd-card-wide">
              <h3>Master decisions <span class="dim small">${(p.decisions || []).length}</span></h3>
              ${decisionRows}
            </section>
          </div>
        </div>
      `;
      // Wire action buttons
      detailEl.querySelector('[data-action="spawn-team"]')?.addEventListener("click", async () => {
        if (!confirm(`Ask master to spawn a dev team for "${p.name}"?`)) return;
        await fetch("/api/master/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `Spawn a dev team for project "${p.name}" at path "${p.path}". Pick the right account, use subctl_orch_spawn, and tell me the team name + how to attach.`,
            source: "chat",
          }),
        });
        alert("Asked master. Switch to Chat to follow the response.");
      });
      detailEl.querySelector('[data-action="open-vault"]')?.addEventListener("click", () => {
        navigator.clipboard.writeText(vault.project_dir);
        alert("Vault path copied: " + vault.project_dir + (vault.exists ? "" : "\n(does not exist yet)"));
      });
    }

    refreshList();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"projects\"]");
      if (panel && getComputedStyle(panel).display !== "none") {
        refreshList();
        if (selectedName) selectProject(selectedName);
      }
    }, 30000);

    // + New Project button — Phase 2c will wire the wizard. For now a stub
    // so the button doesn't look dead.
    const newBtn = $("project-new-btn");
    if (newBtn) {
      newBtn.addEventListener("click", () => {
        alert("Coming next: New Project wizard (clone + Obsidian vault init + policy.json entry).");
      });
    }
  }

  // ----- Memory tab — Obsidian vault status -----
  function wireMemoryTab() {
    const status = $("memory-status");
    const content = $("memory-content");
    if (!content) return;

    async function refresh() {
      try {
        const r = await fetch("/api/memory");
        const j = await r.json();
        if (!j.ok) {
          content.innerHTML = "<p class=\"dim\">memory API unreachable</p>";
          if (status) { status.textContent = "error"; status.dataset.state = "err"; }
          return;
        }
        if (!j.obsidian_installed) {
          if (status) { status.textContent = "obsidian not installed"; status.dataset.state = "warn"; }
          content.innerHTML =
            "<div class=\"memory-block\">" +
              "<h3>Obsidian is not installed on the M3 Ultra</h3>" +
              "<p>The master's long-term memory lives in Obsidian vaults — project portfolios, decisions, RESUME.md per project, references that survive across sessions. Install on the M3 Ultra:</p>" +
              "<pre class=\"memory-cmd\">brew install --cask obsidian</pre>" +
              "<p>Then create a vault at:</p>" +
              "<pre class=\"memory-cmd\">" + escapeForHtml(j.suggested_vault_path) + "</pre>" +
              "<p>Suggested initial structure (one folder per active project, one master/ folder):</p>" +
              "<pre class=\"memory-tree\">" +
                "Obsidian Vault/\n" +
                "├── master/\n" +
                "│   ├── decisions.md       — running log of master-level calls\n" +
                "│   ├── portfolio.md       — every project + status + tier\n" +
                "│   └── people.md          — operators, partners, stakeholders\n" +
                "├── &lt;project-1&gt;/\n" +
                "│   ├── RESUME.md          — current state, what's next\n" +
                "│   ├── design/            — ADRs, sketches, specs\n" +
                "│   ├── reviews/           — coderabbit findings\n" +
                "│   └── postmortems/\n" +
                "└── ..." +
              "</pre>" +
              "<p>Once a vault exists, this tab will list its notes and recent edits, and the master will be able to read/write entries.</p>" +
            "</div>";
          return;
        }
        if (status) { status.textContent = (j.vaults || []).length + " vault(s)"; status.dataset.state = "ok"; }
        if (!(j.vaults || []).length) {
          content.innerHTML =
            "<div class=\"memory-block\">" +
              "<h3>Obsidian installed, no vault detected</h3>" +
              "<p>Create one at <code>" + escapeForHtml(j.suggested_vault_path) + "</code> and add a <code>.obsidian</code> directory (Obsidian creates this automatically when you point it at a folder).</p>" +
            "</div>";
          return;
        }
        const rows = j.vaults.map((v) =>
          "<tr>" +
            "<td><code>" + escapeForHtml(v.path) + "</code></td>" +
            "<td class=\"num\">" + v.note_count + "</td>" +
            "<td>" + (v.last_modified ? new Date(v.last_modified).toLocaleString() : "—") + "</td>" +
          "</tr>",
        ).join("");
        content.innerHTML =
          "<table class=\"data-table\"><thead><tr>" +
            "<th>vault</th><th class=\"num\">notes</th><th>last modified</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table>" +
          "<p class=\"dim\" style=\"margin-top:12px\">Per-vault note browser + master read/write tools coming next.</p>";
      } catch (err) {
        content.innerHTML = "<p class=\"dim\">fetch error: " + escapeForHtml(String(err)) + "</p>";
        if (status) { status.textContent = "error"; status.dataset.state = "err"; }
      }
    }

    function escapeForHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    refresh();
    setInterval(() => {
      const panel = $("memory-panel");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 30000);
  }

  // ----- Master chat (SSE-backed conversation with the master daemon) -----
  function wireMasterChat() {
    const log = $("master-log");
    const form = $("master-input-form");
    const input = $("master-input");
    const sendBtn = $("master-send");
    const connState = $("master-conn-state");
    if (!log || !form || !input) return;

    // Track the in-flight assistant message so streaming text-deltas append
    // into one bubble instead of creating a new bubble per token.
    let activeAssistantEl = null;
    let activeAssistantText = "";
    let toolCallEls = new Map(); // toolCallId -> element

    function setConnState(state) {
      if (!connState) return;
      connState.textContent = state;
      connState.dataset.state = state;
    }

    function clearEmpty() {
      const empty = log.querySelector(".master-log-empty");
      if (empty) empty.remove();
    }

    function appendMessage(role, text, opts) {
      clearEmpty();
      const el = document.createElement("div");
      el.className = `master-msg master-msg-${role}`;
      const label = document.createElement("div");
      label.className = "master-msg-label";
      label.textContent = (opts && opts.label) || role;
      const body = document.createElement("div");
      body.className = "master-msg-body";
      body.textContent = text || "";
      el.appendChild(label);
      el.appendChild(body);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return body;
    }

    function appendToolCall(toolCallId, name, args) {
      clearEmpty();
      const el = document.createElement("div");
      el.className = "master-msg master-msg-tool";
      el.dataset.tcid = toolCallId;
      const label = document.createElement("div");
      label.className = "master-msg-label";
      label.textContent = "tool · " + name;
      const body = document.createElement("div");
      body.className = "master-msg-body master-tool-body";
      body.textContent = args ? JSON.stringify(args) : "";
      el.appendChild(label);
      el.appendChild(body);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      toolCallEls.set(toolCallId, el);
    }

    function markToolDone(toolCallId, ok, summary) {
      const el = toolCallEls.get(toolCallId);
      if (!el) return;
      el.classList.add(ok ? "master-tool-ok" : "master-tool-err");
      if (summary) {
        const result = document.createElement("div");
        result.className = "master-tool-result";
        result.textContent = String(summary).slice(0, 400);
        el.appendChild(result);
      }
      log.scrollTop = log.scrollHeight;
    }

    function startAssistantBubble() {
      activeAssistantText = "";
      activeAssistantEl = appendMessage("assistant", "", { label: "master" });
    }

    function appendDelta(delta) {
      if (!activeAssistantEl) startAssistantBubble();
      activeAssistantText += delta;
      activeAssistantEl.textContent = activeAssistantText;
      log.scrollTop = log.scrollHeight;
    }

    function endAssistantBubble() {
      activeAssistantEl = null;
      activeAssistantText = "";
    }

    let es = null;
    let backoffMs = 1000;

    function connect() {
      setConnState("connecting");
      es = new EventSource("/api/master/events");
      es.addEventListener("open", () => {
        setConnState("connected");
        backoffMs = 1000;
      });
      es.addEventListener("error", () => {
        setConnState("reconnecting");
        try { es.close(); } catch {}
        setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      });
      es.addEventListener("connected", () => setConnState("connected"));
      es.addEventListener("inbound", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.source === "watchdog") {
            appendMessage("watchdog", d.text, { label: "watchdog" });
          } else if (d.source === "telegram") {
            appendMessage("user", d.text, { label: "you · telegram" });
          }
          // chat-source inbounds are echoed by our own POST below; skip duplicate
        } catch {}
      });
      // NOTE: do NOT eagerly create a bubble on message_start. The agent
      // sometimes emits a message-shell event before any text_delta arrives,
      // and if the assistant turn ends up being purely a tool call (no text),
      // we'd have orphan empty bubbles. Instead let appendDelta below
      // lazy-create the bubble on the FIRST text_delta. Side-effect: also
      // stops the "empty bubble + filled bubble" doubling that showed up
      // when a turn included both a tool-call message and a text message.
      es.addEventListener("message_update", (e) => {
        try {
          const d = JSON.parse(e.data);
          const ev = d.assistantMessageEvent;
          if (!ev) return;
          if (ev.type === "text_delta" && typeof ev.delta === "string") {
            appendDelta(ev.delta);
          } else if (ev.type === "toolcall_start") {
            appendToolCall(ev.partial?.content?.[ev.contentIndex]?.id ?? "?", ev.partial?.content?.[ev.contentIndex]?.name ?? "tool", ev.partial?.content?.[ev.contentIndex]?.arguments);
          }
        } catch {}
      });
      es.addEventListener("message_end", () => {
        endAssistantBubble();
      });
      es.addEventListener("tool_result", (e) => {
        try {
          const d = JSON.parse(e.data);
          markToolDone(d.toolCallId ?? "?", !d.error, d.error || (d.content && d.content[0] && d.content[0].text));
        } catch {}
      });
      es.addEventListener("watchdog_fire", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendMessage("watchdog", d.prompt, { label: "watchdog" });
          if (window.__subctlPushActivity) window.__subctlPushActivity(`<strong>watchdog</strong> fired: ${escapeText(String(d.prompt || "").slice(0, 80))}`);
        } catch {}
      });
      // Lightweight activity feed plumbing — surfaces tool calls + team
      // events + inbound messages on the Orchestration sidecar so it's not
      // just a chat box. Avoids re-rendering anything chat-side.
      es.addEventListener("inbound", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (window.__subctlPushActivity) {
            const src = d.source === "telegram" ? "telegram" : d.source === "watchdog" ? "watchdog" : "you";
            window.__subctlPushActivity(`<strong>${src}</strong>: ${escapeText(String(d.text || "").slice(0, 80))}`);
          }
        } catch {}
      });
      es.addEventListener("team_event", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (window.__subctlPushActivity) {
            window.__subctlPushActivity(`team <strong>${escapeText(d.team)}</strong>: ${escapeText(d.type)} · ${escapeText(String(d.text || "").slice(0, 60))}`);
          }
        } catch {}
      });
    }
    function escapeText(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    connect();

    // Slash commands: a thin client-side layer on top of natural-language
    // chat. Most commands translate to a directive prompt for the master
    // (so the agent stays in the loop and tool-calls flow normally). A few
    // are pure client-side (/clear, /help, /attach) — those don't round-trip.
    const SLASH_HELP = [
      "/help                          — this help",
      "/clear                         — clear the chat log (client-side only)",
      "/status                        — quick health check (uptime, transcript, subscribers)",
      "/diag                          — full diagnostic: LM Studio, Telegram, coderabbit, gh, tmux",
      "/teams                         — list dev teams the master is tracking",
      "/spawn <account> <project> [prompt]",
      "                                 ask master to spawn a dev team",
      "/kill <team>                   — ask master to kill a dev team session",
      "/attach <team>                 — show the SSH command to attach to a team's tmux on the M3 Ultra",
      "/config                        — show config file paths and what each controls",
      "",
      "How dev teams work:",
      "  • Master spawns tmux sessions on the M3 Ultra via subctl_orch_spawn",
      "  • The lead Claude Code in pane 0 uses TeamCreate + Agent(team_name=\"…\") to make workers",
      "  • Each lead writes status to ~/.config/subctl/master/inbox/<team>.jsonl",
      "  • Master tails inboxes (2s poll), reacts to blocked/error events, watchdog at 30min",
      "  • Attach manually with: ssh argent-m3-ultra-dev tmux attach -t <team>",
      "",
      "Config (all on the M3 Ultra):",
      "  ~/.config/subctl/master/policy.json     operator + projects + autonomy + intervals",
      "  ~/.config/subctl/master/providers.json  model routing (router/supervisor/reviewer/embeddings/escalate/fallback)",
      "  ~/.config/subctl/master-notify.json     Telegram bot token + chat_id",
    ].join("\n");

    function appendSystemBlock(text) {
      clearEmpty();
      const el = document.createElement("div");
      el.className = "master-msg master-msg-system";
      const label = document.createElement("div");
      label.className = "master-msg-label";
      label.textContent = "system";
      const body = document.createElement("div");
      body.className = "master-msg-body";
      body.textContent = text;
      body.style.fontFamily = "ui-monospace, 'SF Mono', Menlo, monospace";
      body.style.fontSize = "11.5px";
      el.appendChild(label);
      el.appendChild(body);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    async function fetchAndRenderJSON(url, label, formatter) {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok || j.ok === false) {
          appendMessage("error", `${label} failed: ${j.error || r.status}`, { label: "error" });
          return;
        }
        appendSystemBlock(formatter(j));
      } catch (err) {
        appendMessage("error", `${label} error: ${err}`, { label: "error" });
      }
    }

    function fmtSecsAgo(s) {
      if (s == null) return "never";
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m ago";
    }

    async function handleSlashCommand(line) {
      const parts = line.match(/^\/(\w+)(?:\s+(.*))?$/);
      if (!parts) {
        appendMessage("error", "malformed slash command — try /help", { label: "error" });
        return;
      }
      const cmd = parts[1].toLowerCase();
      const args = (parts[2] || "").trim();

      switch (cmd) {
        case "help":
          appendSystemBlock(SLASH_HELP);
          return;

        case "clear": {
          // Pure client-side — server transcript is preserved.
          while (log.firstChild) log.removeChild(log.firstChild);
          const empty = document.createElement("div");
          empty.className = "master-log-empty";
          empty.innerHTML = "cleared (client-side; master's transcript still intact) — try <code>/help</code>";
          log.appendChild(empty);
          return;
        }

        case "status":
          await fetchAndRenderJSON("/api/master/health", "status", (j) =>
            `master ${j.ok ? "OK" : "DEGRADED"}  v${j.version}\n` +
            `  uptime          ${j.uptime_s}s\n` +
            `  transcript      ${j.transcript_msgs} messages\n` +
            `  SSE subscribers ${j.subscribers}\n` +
            `  teams tracked   ${j.teams_tracked}\n` +
            `  prompt in flight ${j.prompt_in_flight ? "yes" : "no"}`,
          );
          return;

        case "diag":
          appendSystemBlock("running diagnostics (LM Studio + Telegram + coderabbit + gh + tmux)…");
          await fetchAndRenderJSON("/api/master/diag", "diag", (j) => {
            const header =
              `master ${j.ok ? "ALL CHECKS PASSED" : "DEGRADED"} · v0.1.0\n` +
              `  supervisor      ${j.supervisor}\n` +
              `  uptime          ${j.uptime_s}s\n` +
              `  tools loaded    ${j.tools_loaded}\n` +
              `  transcript      ${j.transcript_msgs} msgs\n` +
              `  subscribers     ${j.subscribers}\n` +
              `  teams tracked   ${j.teams_tracked}\n\n` +
              `checks:`;
            const rows = (j.checks || []).map((c) => {
              const mark = c.ok ? "✓" : "✗";
              return `  ${mark}  ${c.name.padEnd(12)} ${c.detail}`;
            });
            return [header, ...rows].join("\n");
          });
          return;

        case "teams":
          await fetchAndRenderJSON("/api/master/teams", "teams", (j) => {
            if (!j.teams || j.teams.length === 0) return "no dev teams tracked yet";
            const rows = j.teams.map((t) => {
              const ev = t.last_event ? `${t.last_event.type}: ${(t.last_event.text || "").slice(0, 60)}` : "—";
              return `  ${t.name.padEnd(28)} ${fmtSecsAgo(t.last_activity_seconds_ago).padEnd(10)} ${ev}`;
            });
            return `${j.teams.length} team(s) tracked:\n` + rows.join("\n");
          });
          return;

        case "attach": {
          if (!args) {
            appendMessage("error", "usage: /attach <team>", { label: "error" });
            return;
          }
          appendSystemBlock(
            `Attach to dev team "${args}" on the M3 Ultra:\n\n` +
            `  ssh argent-m3-ultra-dev -t tmux attach -t ${args}\n\n` +
            `Detach with Ctrl-b then d. The master and team keep running after detach.`,
          );
          return;
        }

        case "config":
          appendSystemBlock([
            "config files (all on the M3 Ultra at ~/.config/subctl/master/):",
            "",
            "  policy.json",
            "    operator info, project portfolio, autonomy levels (drive/ask/shadow),",
            "    review_interval_minutes, stall_detection_minutes, max_concurrent_workers,",
            "    escalation_triggers. master reads at boot.",
            "",
            "  providers.json",
            "    model routing per role: router (cheap dispatch), supervisor (the brain),",
            "    reviewer (PR review), embeddings, escalate (cloud), fallback. switch via",
            "    .models.<role>.{provider, model, host} fields.",
            "",
            "  master-notify.json (one level up at ~/.config/subctl/master-notify.json)",
            "    bot_token + chat_id for the master Telegram bot.",
            "",
            "  inbox/ (auto-created)",
            "    one .jsonl per dev team. master tails for status events.",
            "",
            "edit the file directly on the M3 Ultra, then restart with:",
            "  launchctl unload  ~/Library/LaunchAgents/com.subctl.master.plist",
            "  launchctl load    ~/Library/LaunchAgents/com.subctl.master.plist",
          ].join("\n"));
          return;

        case "spawn": {
          if (!args) {
            appendMessage("error", "usage: /spawn <account> <project_path> [prompt]", { label: "error" });
            return;
          }
          // Translate to natural-language directive for the master agent.
          const m = args.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
          if (!m) {
            appendMessage("error", "usage: /spawn <account> <project_path> [prompt]", { label: "error" });
            return;
          }
          const [, account, project, prompt] = m;
          const directive = `Spawn a dev team using subctl_orch_spawn with account="${account}", project="${project}"${prompt ? `, and an initial prompt: ${prompt}` : ""}. Confirm the team name once spawned, and tell me how to attach.`;
          await sendChat(directive);
          return;
        }

        case "kill": {
          if (!args) {
            appendMessage("error", "usage: /kill <team>", { label: "error" });
            return;
          }
          const directive = `Kill the dev-team tmux session named "${args}" using subctl_orch_kill, and confirm.`;
          await sendChat(directive);
          return;
        }

        default:
          appendMessage("error", `unknown command: /${cmd} — try /help`, { label: "error" });
      }
    }

    async function sendChat(text) {
      sendBtn.disabled = true;
      appendMessage("user", text, { label: "you" });
      try {
        const r = await fetch("/api/master/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, source: "chat" }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          appendMessage("error", "send failed: " + (j.error || r.status), { label: "error" });
        }
      } catch (err) {
        appendMessage("error", "send error: " + err, { label: "error" });
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      if (text.startsWith("/")) {
        await handleSlashCommand(text);
        input.focus();
      } else {
        await sendChat(text);
      }
    });
  }

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

  // Activity feed: tap into the same SSE stream the chat panel listens to,
  // append a one-liner per meaningful event (tool calls, watchdog firings,
  // team events, decisions). Keeps a bounded ring of the last 30.
  const ACTIVITY_LIMIT = 30;
  function pushActivity(html) {
    const list = $("orch-activity-list");
    if (!list) return;
    const empty = list.querySelector(".dim");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "orch-activity-item";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date().toLocaleTimeString();
    row.appendChild(when);
    const body = document.createElement("span");
    body.innerHTML = html;
    row.appendChild(body);
    list.insertBefore(row, list.firstChild);
    while (list.children.length > ACTIVITY_LIMIT) list.removeChild(list.lastChild);
  }
  // Expose globally so wireMasterChat can push events into it.
  window.__subctlPushActivity = pushActivity;

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

      // actions: kill button
      const wrap = document.createElement("div");
      wrap.className = "resume-actions";
      const btnKill = document.createElement("button");
      btnKill.className = "btn-resume";
      btnKill.textContent = "kill";
      btnKill.title = "tmux kill-session -t " + o.name;
      btnKill.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Kill dev-team session " + o.name + "?")) return;
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
