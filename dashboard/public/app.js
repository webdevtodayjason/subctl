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
  wireSettingsTab();
  wireSkillsTab();
  wireProvidersTab();
  wireTeamsTab();
  wireLogsTab();

  // ----- Logs tab — streaming tail of master + dashboard logs -----
  function wireLogsTab() {
    const sourceSel = $("logs-source");
    const view = $("logs-view");
    const status = $("logs-status");
    const autoscrollCb = $("logs-autoscroll");
    const clearBtn = $("logs-clear-btn");
    const copyBtn = $("logs-copy-btn");
    if (!view || !sourceSel) return;

    let es = null;
    let backoffMs = 1000;
    const MAX_LINES = 5000;

    function setStatus(state) {
      if (!status) return;
      status.textContent = state;
      status.className = "logs-status " + (state === "live" ? "connected" : state === "connecting" || state === "reconnecting" ? "connecting" : state.startsWith("error") ? "error" : "");
    }

    function classify(line) {
      const lc = line.toLowerCase();
      if (/(error|fatal|critical|✗|abort|exception|crashed)/.test(lc)) return "err";
      if (/(warn|warning|degraded)/.test(lc)) return "warn";
      if (/(✓|ok\b|ready|listening|armed)/.test(lc)) return "ok";
      if (/(boot|init|spawn|reload)/.test(lc)) return "info";
      return "";
    }

    function appendLines(lines) {
      const frag = document.createDocumentFragment();
      for (const line of lines) {
        if (!line) continue;
        const div = document.createElement("div");
        div.className = "log-line " + classify(line);
        div.textContent = line;
        frag.appendChild(div);
      }
      view.appendChild(frag);
      // Cap total rendered lines to avoid DOM bloat
      while (view.childElementCount > MAX_LINES) view.removeChild(view.firstChild);
      if (autoscrollCb?.checked !== false) view.scrollTop = view.scrollHeight;
    }

    function clearView() {
      view.innerHTML = "";
    }

    function disconnect() {
      if (es) try { es.close(); } catch {}
      es = null;
    }

    function connect() {
      disconnect();
      const id = sourceSel.value;
      setStatus("connecting");
      clearView();
      es = new EventSource(`/api/logs/${id}/stream`);
      es.addEventListener("snapshot", (e) => {
        try {
          const d = JSON.parse(e.data);
          clearView();
          appendLines(d.lines || []);
          setStatus("live");
        } catch {}
      });
      es.addEventListener("append", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendLines(d.lines || []);
        } catch {}
      });
      es.addEventListener("error", () => {
        setStatus("error · reconnecting");
        try { es.close(); } catch {}
        setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      });
      es.addEventListener("open", () => { backoffMs = 1000; });
    }

    sourceSel.addEventListener("change", () => connect());
    if (clearBtn) clearBtn.addEventListener("click", clearView);
    if (copyBtn) copyBtn.addEventListener("click", () => {
      const text = Array.from(view.querySelectorAll(".log-line")).map((el) => el.textContent).join("\n");
      navigator.clipboard.writeText(text);
      copyBtn.textContent = "copied ✓";
      setTimeout(() => copyBtn.textContent = "copy all", 1500);
    });

    // Connect on first switch into the Logs tab. Don't connect eagerly —
    // SSE keeps a TCP connection open and we don't want to chew connections
    // when the user never visits this view.
    let everConnected = false;
    const observer = new MutationObserver(() => {
      const panel = document.querySelector("section[data-tab=\"logs\"]");
      const visible = panel && getComputedStyle(panel).display !== "none";
      if (visible && !everConnected) {
        everConnected = true;
        connect();
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
    // If logs is the initial tab on load
    const panel = document.querySelector("section[data-tab=\"logs\"]");
    if (panel && getComputedStyle(panel).display !== "none") {
      everConnected = true;
      connect();
    }
  }

  // ----- Teams (dev-team templates) -----
  function wireTeamsTab() {
    const list = $("teams-list");
    const detail = $("team-detail-pane");
    const newBtn = $("team-new-btn");
    const modal = $("team-modal");
    const modalClose = $("team-modal-close");
    const cancelBtn = $("team-cancel");
    const submitBtn = $("team-submit");
    const result = $("team-result");
    const titleEl = $("team-modal-title");
    const fName = $("team-name");
    const fDescription = $("team-description");
    const fPersona = $("team-persona");
    const fAutonomy = $("team-autonomy");
    const fBootPrompt = $("team-boot-prompt");
    const toolsGrid = $("team-tools-grid");
    const skillsList = $("team-skills-list");
    const skillsSelected = $("team-skills-selected");
    const skillsFilter = $("team-skills-filter");
    const form = $("team-form");
    if (!list) return;

    let allSkills = [];
    let toolFamilies = [];
    let editingName = null;
    let selectedSkills = new Set();
    let skillFilterText = "";

    function renderSelectedSkillChips() {
      if (!skillsSelected) return;
      if (selectedSkills.size === 0) {
        skillsSelected.innerHTML = "<div class=\"dim small\">no skills selected</div>";
        return;
      }
      skillsSelected.innerHTML = "";
      for (const id of selectedSkills) {
        const chip = document.createElement("span");
        chip.className = "team-skill-chip";
        chip.innerHTML = escapeText(id) + "<span class=\"x\" title=\"remove\">✕</span>";
        chip.querySelector(".x").addEventListener("click", () => {
          selectedSkills.delete(id);
          renderSelectedSkillChips();
          renderSkillsList();
        });
        skillsSelected.appendChild(chip);
      }
    }

    function renderSkillsList() {
      if (!skillsList) return;
      const q = skillFilterText.toLowerCase();
      const filtered = !q ? allSkills : allSkills.filter((s) =>
        (s.id || "").toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q));
      if (!filtered.length) {
        skillsList.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">no matches</div>";
        return;
      }
      skillsList.replaceChildren(...filtered.map((s) => {
        const row = document.createElement("div");
        row.className = "team-skill-item" + (selectedSkills.has(s.id) ? " selected" : "");
        row.innerHTML = `<span class="check">${selectedSkills.has(s.id) ? "✓" : ""}</span><span>${escapeText(s.id)}</span>`;
        row.title = s.description || "";
        row.addEventListener("click", () => {
          if (selectedSkills.has(s.id)) selectedSkills.delete(s.id);
          else selectedSkills.add(s.id);
          renderSkillsList();
          renderSelectedSkillChips();
        });
        return row;
      }));
    }

    function renderToolsGrid() {
      if (!toolsGrid) return;
      toolsGrid.replaceChildren(...toolFamilies.map((t) => {
        const lbl = document.createElement("label");
        lbl.innerHTML = `<input type="checkbox" data-tool="${escapeText(t.id)}"><div><code>${escapeText(t.id)}</code><span class="desc">${escapeText(t.description)}</span></div>`;
        return lbl;
      }));
    }

    function setSelectedTools(tools) {
      if (!toolsGrid) return;
      const set = new Set(tools || []);
      toolsGrid.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.checked = set.has(cb.dataset.tool);
      });
    }

    function getSelectedTools() {
      if (!toolsGrid) return [];
      return Array.from(toolsGrid.querySelectorAll("input[type=checkbox]"))
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.tool);
    }

    async function loadEditorContext() {
      try {
        const [skillsR, toolsR] = await Promise.all([
          fetch("/api/skills"),
          fetch("/api/teams/tools"),
        ]);
        const skillsJ = await skillsR.json();
        const toolsJ = await toolsR.json();
        if (skillsJ.ok) allSkills = skillsJ.skills || [];
        if (toolsJ.ok) toolFamilies = toolsJ.tool_families || [];
        renderToolsGrid();
        renderSkillsList();
      } catch { /* will render empty */ }
    }

    function openModal(mode, prefill) {
      editingName = mode === "edit" ? prefill?.name : null;
      titleEl.textContent = mode === "edit" ? `Edit Team: ${prefill?.name}` : "New Team Template";
      fName.value = prefill?.name || "";
      fName.disabled = mode === "edit";
      fDescription.value = prefill?.description || "";
      fPersona.value = prefill?.persona || "";
      fAutonomy.value = prefill?.default_autonomy || "ask";
      fBootPrompt.value = prefill?.boot_prompt || "";
      selectedSkills = new Set(prefill?.skills || []);
      result.hidden = true;
      submitBtn.disabled = false;
      submitBtn.textContent = "save";
      modal.hidden = false;
      // Defer skill+tool init so the modal is in the DOM first
      requestAnimationFrame(async () => {
        await loadEditorContext();
        setSelectedTools(prefill?.tools || ["subctl_orch_*", "gh_*", "telegram_*"]);
        renderSelectedSkillChips();
        renderSkillsList();
      });
    }
    function closeModal() {
      modal.hidden = true;
      form.reset();
      fName.disabled = false;
      result.hidden = true;
      selectedSkills = new Set();
    }
    if (newBtn) newBtn.addEventListener("click", () => openModal("create", null));
    if (modalClose) modalClose.addEventListener("click", closeModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    if (skillsFilter) skillsFilter.addEventListener("input", () => { skillFilterText = skillsFilter.value; renderSkillsList(); });

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
          name: fName.value.trim(),
          description: fDescription.value.trim(),
          persona: fPersona.value.trim(),
          default_autonomy: fAutonomy.value,
          boot_prompt: fBootPrompt.value.trim(),
          tools: getSelectedTools(),
          skills: Array.from(selectedSkills),
        };
        if (!payload.name) {
          result.hidden = false;
          result.className = "form-status form-status-err";
          result.textContent = "name required";
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = "saving…";
        try {
          let r;
          if (editingName) {
            r = await fetch("/api/teams/" + encodeURIComponent(editingName), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          } else {
            r = await fetch("/api/teams", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          }
          const j = await r.json();
          result.hidden = false;
          if (!j.ok) {
            result.className = "form-status form-status-err";
            result.textContent = "Failed: " + (j.error || "?");
            submitBtn.disabled = false;
            submitBtn.textContent = "save";
            return;
          }
          result.className = "form-status form-status-ok";
          result.textContent = "✓ saved";
          await refreshList();
          await selectTeam(payload.name);
          setTimeout(closeModal, 900);
        } catch (err) {
          result.hidden = false;
          result.className = "form-status form-status-err";
          result.textContent = "Error: " + err;
          submitBtn.disabled = false;
          submitBtn.textContent = "save";
        }
      });
    }

    async function refreshList() {
      try {
        const r = await fetch("/api/teams");
        const j = await r.json();
        if (!j.ok) {
          list.innerHTML = "<div class=\"dim small\" style=\"padding:18px\">unreachable</div>";
          return;
        }
        const teams = j.teams || [];
        if (!teams.length) {
          list.innerHTML = "<div class=\"dim small\" style=\"padding:18px\">no templates yet — click <strong>+ New Template</strong></div>";
          return;
        }
        list.replaceChildren(...teams.map((t) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "team-row";
          btn.innerHTML = `<div class="name">${escapeText(t.name)}</div>
            <div class="meta"><span class="pill">${escapeText(t.default_autonomy)}</span>${t.skills_count} skills · ${t.tools_count} tools</div>
            <div class="meta">${escapeText((t.description || "(no description)").slice(0, 80))}</div>`;
          btn.addEventListener("click", () => selectTeam(t.name));
          return btn;
        }));
      } catch (err) {
        list.innerHTML = "<div class=\"dim small\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    async function selectTeam(name) {
      Array.from(list.querySelectorAll(".team-row")).forEach((el) => {
        el.classList.toggle("active", el.querySelector(".name")?.textContent === name);
      });
      detail.innerHTML = "<div class=\"dim small\" style=\"padding:24px\">loading…</div>";
      try {
        const r = await fetch("/api/teams/" + encodeURIComponent(name));
        const j = await r.json();
        if (!j.ok) {
          detail.innerHTML = "<div class=\"dim\" style=\"padding:24px\">load failed: " + escapeText(j.error || "?") + "</div>";
          return;
        }
        const t = j.template || {};
        const skillsHtml = (t.skills || []).map((s) =>
          `<span class="team-skill-chip">${escapeText(s)}</span>`).join(" ") || "<span class=\"dim\">none</span>";
        const toolsHtml = (t.tools || []).map((tt) =>
          `<code style="background:#141414; color:#5fd7ff; padding:1px 6px; border-radius:2px; font-size:11.5px; margin-right:4px">${escapeText(tt)}</code>`).join("") || "<span class=\"dim\">none</span>";
        detail.innerHTML = `
          <div class="team-detail">
            <div class="team-detail-actions">
              <button type="button" class="primary-btn" data-action="edit">Edit</button>
              <button type="button" class="secondary-btn" data-action="duplicate">Duplicate</button>
              <button type="button" class="secondary-btn" data-action="delete" style="color:#d66c6c; border-color:#4a1f1f">Delete</button>
            </div>
            <h2>${escapeText(t.name)}</h2>
            <div class="field">
              <div class="field-label">Description</div>
              <div class="field-value">${escapeText(t.description || "(no description)")}</div>
            </div>
            <div class="field">
              <div class="field-label">Default autonomy</div>
              <div class="field-value">${escapeText(t.default_autonomy || "ask")}</div>
            </div>
            <div class="field">
              <div class="field-label">Persona <span class="dim small">(system prompt)</span></div>
              <div class="field-value mono">${escapeText(t.persona || "(empty)")}</div>
            </div>
            <div class="field">
              <div class="field-label">Boot prompt <span class="dim small">(first message after spawn)</span></div>
              <div class="field-value mono">${escapeText(t.boot_prompt || "(empty)")}</div>
            </div>
            <div class="field">
              <div class="field-label">Tool families</div>
              <div class="field-value">${toolsHtml}</div>
            </div>
            <div class="field">
              <div class="field-label">Skills</div>
              <div class="field-value">${skillsHtml}</div>
            </div>
          </div>
        `;
        detail.querySelector('[data-action="edit"]').addEventListener("click", () => openModal("edit", t));
        detail.querySelector('[data-action="duplicate"]').addEventListener("click", () => {
          const newName = prompt("New template name (copy of " + t.name + "):");
          if (!newName) return;
          openModal("create", { ...t, name: newName });
        });
        detail.querySelector('[data-action="delete"]').addEventListener("click", async () => {
          if (!confirm("Delete template '" + t.name + "'?")) return;
          try {
            const r2 = await fetch("/api/teams/" + encodeURIComponent(t.name), { method: "DELETE" });
            const j2 = await r2.json();
            if (!j2.ok) alert("Delete failed: " + (j2.error || "?"));
            await refreshList();
            detail.innerHTML = "<div class=\"dim small\" style=\"padding:24px\">template deleted — select another or create a new one</div>";
          } catch (err) {
            alert("Delete error: " + err);
          }
        });
      } catch (err) {
        detail.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    refreshList();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"teams\"]");
      if (panel && getComputedStyle(panel).display !== "none") refreshList();
    }, 30000);
  }

  // ----- Providers tab — per-provider profile management -----
  function wireProvidersTab() {
    const list = $("providers-list");
    const newBtn = $("provider-new-btn");
    const modal = $("provider-profile-modal");
    const modalClose = $("provider-profile-close");
    const modalCancel = $("provider-profile-cancel");
    const form = $("provider-profile-form");
    const titleEl = $("provider-profile-title");
    const submit = $("provider-profile-submit");
    const result = $("profile-result");
    const fAlias = $("profile-alias");
    const fProvider = $("profile-provider");
    const fEmail = $("profile-email");
    const fConfigDir = $("profile-config-dir");
    const fDescription = $("profile-description");
    if (!list) return;

    let editingMode = "add"; // or "edit"

    function openModal(mode, prefill) {
      editingMode = mode;
      if (titleEl) titleEl.textContent = mode === "edit" ? `Edit profile: ${prefill?.alias || ""}` : "New profile";
      if (prefill) {
        fAlias.value = prefill.alias || "";
        fAlias.disabled = mode === "edit"; // alias is the key; can't rename mid-edit
        fProvider.value = prefill.provider || "claude";
        fEmail.value = prefill.email || "";
        fConfigDir.value = prefill.config_dir || "";
        fDescription.value = prefill.description || "";
      } else {
        form.reset();
        fAlias.disabled = false;
      }
      result.hidden = true;
      submit.disabled = false;
      submit.textContent = "save";
      if (modal) modal.hidden = false;
      setTimeout(() => fAlias && fAlias.focus(), 50);
    }
    function closeModal() {
      if (modal) modal.hidden = true;
      form.reset();
      fAlias.disabled = false;
      result.hidden = true;
    }
    if (newBtn) newBtn.addEventListener("click", () => openModal("add", null));
    if (modalClose) modalClose.addEventListener("click", closeModal);
    if (modalCancel) modalCancel.addEventListener("click", closeModal);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    // Suggest a default config_dir based on provider + alias
    if (fAlias && fProvider && fConfigDir) {
      function suggest() {
        if (fConfigDir.value && !fConfigDir.dataset.fresh) return;
        const a = fAlias.value;
        const p = fProvider.value;
        if (!a) return;
        if (p === "claude") fConfigDir.value = `~/.claude-${a.replace(/^claude-/, "")}`;
        else if (p === "openai") fConfigDir.value = `~/.codex-${a.replace(/^openai-/, "")}`;
        else fConfigDir.value = `~/.${p}-${a}`;
        fConfigDir.dataset.fresh = "1";
      }
      fAlias.addEventListener("input", suggest);
      fProvider.addEventListener("change", suggest);
      fConfigDir.addEventListener("input", () => { fConfigDir.dataset.fresh = ""; });
    }

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
          alias: fAlias.value.trim(),
          provider: fProvider.value,
          email: fEmail.value.trim(),
          config_dir: fConfigDir.value.trim(),
          description: fDescription.value.trim(),
          mode: editingMode,
        };
        if (!payload.alias || !payload.provider || !payload.config_dir) {
          result.hidden = false;
          result.className = "form-status form-status-err";
          result.textContent = "alias + provider + config_dir required";
          return;
        }
        submit.disabled = true;
        submit.textContent = "saving…";
        try {
          const r = await fetch("/api/providers/profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await r.json();
          result.hidden = false;
          if (!j.ok) {
            result.className = "form-status form-status-err";
            result.textContent = "Failed: " + (j.error || "?");
            submit.disabled = false;
            submit.textContent = "save";
            return;
          }
          result.className = "form-status form-status-ok";
          result.textContent = "✓ saved (" + (j.mode || "added") + ")";
          await refresh();
          setTimeout(closeModal, 1100);
        } catch (err) {
          result.hidden = false;
          result.className = "form-status form-status-err";
          result.textContent = "Error: " + err;
          submit.disabled = false;
          submit.textContent = "save";
        }
      });
    }

    async function refresh() {
      try {
        const r = await fetch("/api/providers");
        const j = await r.json();
        if (!j.ok) {
          list.innerHTML = "<div class=\"dim\">unreachable</div>";
          return;
        }
        // Render each provider with kind=cloud (skip lmstudio since it has no profiles)
        const cloud = (j.providers || []).filter((p) => p.kind === "cloud");
        if (!cloud.length) {
          list.innerHTML = "<div class=\"dim\">no cloud providers configured</div>";
          return;
        }
        list.replaceChildren(...cloud.map((p) => {
          const card = document.createElement("section");
          card.className = "provider-card";
          const head = document.createElement("header");
          head.className = "provider-card-head";
          const profiles = p.profiles || [];
          const authedCount = profiles.filter((x) => x.authed).length;
          head.innerHTML =
            `<h3>${escapeText(p.display)} <span class="kind">${escapeText(p.id)}</span></h3>` +
            `<span class="provider-card-meta">${authedCount}/${profiles.length} authenticated</span>`;
          card.appendChild(head);
          const body = document.createElement("div");
          body.className = "provider-card-body";
          if (!profiles.length) {
            body.innerHTML = "<div class=\"dim small\" style=\"padding:8px 0\">no profiles yet — click <strong>+ New Profile</strong> above</div>";
          } else {
            for (const prof of profiles) {
              const row = document.createElement("div");
              row.className = "profile-row " + (prof.authed ? "authed" : "");
              row.innerHTML =
                "<span class=\"mark\">" + (prof.authed ? "✓" : "○") + "</span>" +
                "<span class=\"alias\">" + escapeText(prof.alias) + "</span>" +
                "<span class=\"email\">" + escapeText(prof.email || "—") + "</span>" +
                "<span class=\"config-dir\">" + escapeText(prof.config_dir || "") + "</span>";
              const actions = document.createElement("div");
              actions.className = "actions";
              if (!prof.authed) {
                const auth = document.createElement("button");
                auth.type = "button";
                auth.className = "auth-btn";
                auth.textContent = "auth";
                const cmd = `subctl auth ${prof.provider || (p.id === "anthropic" ? "claude" : "openai")} ${prof.alias}`;
                auth.title = "click to copy: " + cmd;
                auth.addEventListener("click", () => {
                  navigator.clipboard.writeText(cmd);
                  auth.textContent = "copied ✓";
                  setTimeout(() => auth.textContent = "auth", 1500);
                });
                actions.appendChild(auth);
              }
              const editBtn = document.createElement("button");
              editBtn.type = "button";
              editBtn.textContent = "edit";
              editBtn.addEventListener("click", () => openModal("edit", { ...prof, provider: prof.provider || (p.id === "anthropic" ? "claude" : "openai") }));
              actions.appendChild(editBtn);
              const del = document.createElement("button");
              del.type = "button";
              del.className = "delete-btn";
              del.textContent = "delete";
              del.addEventListener("click", async () => {
                if (!confirm(`Remove profile "${prof.alias}" from accounts.conf?\nThis does NOT delete the auth credentials in ${prof.config_dir}; you'd need to wipe that dir manually.`)) return;
                try {
                  const r = await fetch("/api/providers/profiles", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ alias: prof.alias }),
                  });
                  const j = await r.json();
                  if (!j.ok) alert("Delete failed: " + (j.error || "?"));
                  await refresh();
                } catch (err) {
                  alert("Delete error: " + err);
                }
              });
              actions.appendChild(del);
              row.appendChild(actions);
              body.appendChild(row);
            }
          }
          card.appendChild(body);
          return card;
        }));
      } catch (err) {
        list.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    refresh();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"providers\"]");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 30000);
  }

  // ----- Skills tab — catalog + import flow -----
  function wireSkillsTab() {
    const sourcesList = $("skills-sources-list");
    const sourcesCount = $("skills-sources-count");
    const skillsList = $("skills-list");
    const skillsMeta = $("skills-meta");
    const filter = $("skills-filter");
    const detailPane = $("skills-detail-pane");
    const refreshBtn = $("skills-refresh-btn");
    const importBtn = $("skills-import-btn");
    const modal = $("skills-import-modal");
    const importForm = $("skills-import-form");
    const importClose = $("skills-import-close");
    const importCancel = $("skills-import-cancel");
    const importStatus = $("skills-import-status");
    const importSubmit = $("skills-import-submit");
    if (!sourcesList || !skillsList) return;

    let allSkills = [];
    let allSources = [];
    let activeSource = null;
    let activeSkillId = null;
    let filterText = "";

    function applyFilter() {
      const q = filterText.toLowerCase();
      const filtered = allSkills.filter((s) => {
        if (activeSource && s.source !== activeSource) return false;
        if (!q) return true;
        return s.id.toLowerCase().includes(q) ||
               (s.description || "").toLowerCase().includes(q) ||
               (s.name || "").toLowerCase().includes(q);
      });
      skillsMeta.textContent = `${filtered.length} skill${filtered.length === 1 ? "" : "s"}`;
      if (!filtered.length) {
        skillsList.innerHTML = "<div class=\"dim small\" style=\"padding:24px\">no matches</div>";
        return;
      }
      skillsList.replaceChildren(...filtered.map((s) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "skill-row";
        if (s.id === activeSkillId) btn.classList.add("active");
        const id = document.createElement("div");
        id.className = "skill-id";
        // Color-code source / category in the id display
        const segs = s.id.split("/");
        id.innerHTML =
          `<span class="src-tag">${escapeText(segs[0] || "")}</span>` +
          (segs.length > 2 ? ` / <span class="cat-tag">${escapeText(segs[1] || "")}</span>` : "") +
          ` / ${escapeText(segs.slice(segs.length > 2 ? 2 : 1).join("/"))}`;
        btn.appendChild(id);
        if (s.description) {
          const desc = document.createElement("div");
          desc.className = "skill-desc";
          desc.textContent = s.description;
          btn.appendChild(desc);
        }
        btn.addEventListener("click", () => selectSkill(s.id));
        return btn;
      }));
    }

    async function refresh() {
      try {
        const [sR, kR] = await Promise.all([
          fetch("/api/skills/sources"),
          fetch("/api/skills"),
        ]);
        const sJ = await sR.json();
        const kJ = await kR.json();
        if (sJ.ok) {
          allSources = sJ.sources || [];
          sourcesCount.textContent = allSources.length;
          if (!allSources.length) {
            sourcesList.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">no sources imported yet</div>";
          } else {
            const rows = [];
            // "All" row at top
            const all = document.createElement("button");
            all.type = "button";
            all.className = "skills-source-row";
            if (!activeSource) all.classList.add("active");
            all.innerHTML = `<div class="src-name">All sources</div><div class="src-meta">${allSkills.length} skills</div>`;
            all.addEventListener("click", () => { activeSource = null; refresh(); });
            rows.push(all);
            for (const s of allSources) {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "skills-source-row";
              if (activeSource === s.name) btn.classList.add("active");
              btn.innerHTML = `<div class="src-name">${escapeText(s.name)}</div><div class="src-meta">${s.skill_count} skills · ${s.origin ? "git" : "local"}</div>`;
              btn.addEventListener("click", () => { activeSource = s.name; refresh(); });
              rows.push(btn);
            }
            sourcesList.replaceChildren(...rows);
          }
        }
        if (kJ.ok) {
          allSkills = kJ.skills || [];
        }
        applyFilter();
      } catch (err) {
        sourcesList.innerHTML = "<div class=\"dim small\" style=\"padding:12px\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    async function selectSkill(id) {
      activeSkillId = id;
      applyFilter();
      detailPane.textContent = "loading…";
      try {
        const r = await fetch("/api/skills/" + id.split("/").map(encodeURIComponent).join("/"));
        const j = await r.json();
        if (!j.ok) {
          detailPane.textContent = "load failed: " + (j.error || "?");
          return;
        }
        detailPane.textContent = `// ${j.path}\n\n${j.content}`;
      } catch (err) {
        detailPane.textContent = "error: " + err;
      }
    }

    if (filter) {
      filter.addEventListener("input", () => { filterText = filter.value; applyFilter(); });
    }
    if (refreshBtn) refreshBtn.addEventListener("click", refresh);

    // Import modal wiring
    function openImport() { if (modal) modal.hidden = false; }
    function closeImport() {
      if (!modal) return;
      modal.hidden = true;
      importForm.reset();
      importStatus.hidden = true;
      importStatus.textContent = "";
      importStatus.className = "form-status";
      importSubmit.disabled = false;
      importSubmit.textContent = "import";
    }
    if (importBtn) importBtn.addEventListener("click", openImport);
    if (importClose) importClose.addEventListener("click", closeImport);
    if (importCancel) importCancel.addEventListener("click", closeImport);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeImport(); });
    if (importForm) {
      importForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const repo = $("skills-import-repo").value.trim();
        const source = $("skills-import-source").value.trim();
        if (!repo) return;
        importSubmit.disabled = true;
        importSubmit.textContent = "cloning…";
        importStatus.hidden = false;
        importStatus.className = "form-status form-status-info";
        importStatus.textContent = "Cloning " + repo + "…";
        try {
          const r = await fetch("/api/skills/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo, source: source || undefined }),
          });
          const j = await r.json();
          if (!j.ok) {
            importStatus.className = "form-status form-status-err";
            importStatus.textContent = "Failed: " + (j.error || "?");
            importSubmit.disabled = false;
            importSubmit.textContent = "import";
            return;
          }
          importStatus.className = "form-status form-status-ok";
          importStatus.textContent = "✓ " + (j.output || "imported");
          importSubmit.textContent = "done ✓";
          await refresh();
          setTimeout(closeImport, 2200);
        } catch (err) {
          importStatus.className = "form-status form-status-err";
          importStatus.textContent = "Error: " + err;
          importSubmit.disabled = false;
          importSubmit.textContent = "import";
        }
      });
    }

    refresh();
    // Light auto-refresh while the tab is visible (catches CLI imports)
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"skills\"]");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 30000);
  }

  // ----- Settings tab -----
  function wireSettingsTab() {
    const refreshBtn = $("settings-refresh-btn");
    if (!refreshBtn) return;

    async function loadHealth() {
      const body = $("settings-health-body");
      const summary = $("settings-health-summary");
      try {
        const r = await fetch("/api/settings/install-checks");
        const j = await r.json();
        if (!j.ok) { body.innerHTML = "<div class=\"dim\">checks unreachable</div>"; return; }
        if (summary) summary.textContent = j.summary;
        body.replaceChildren(...j.checks.map((c) => {
          const row = document.createElement("div");
          // A missing REQUIRED tool is err; a missing optional tool is just a warning
          const cls = c.ok ? "ok" : (c.required ? "err" : "warn");
          row.className = "health-row " + cls;
          const requiredBadge = c.required ? "<span class=\"req-badge\">required</span>" : "";
          row.innerHTML =
            "<span class=\"mark\">" + (c.ok ? "✓" : (c.required ? "✗" : "○")) + "</span>" +
            "<span class=\"name\">" + escapeText(c.name) + requiredBadge + "</span>" +
            "<span class=\"detail\">" + escapeText(c.ok ? c.version : (c.detail || "not installed")) + "</span>";
          if (!c.ok && c.install) {
            const cmd = document.createElement("code");
            cmd.className = "install-cmd";
            cmd.textContent = c.install;
            cmd.title = "click to copy";
            cmd.addEventListener("click", () => {
              navigator.clipboard.writeText(c.install);
              cmd.textContent = "copied ✓";
              setTimeout(() => cmd.textContent = c.install, 1500);
            });
            row.appendChild(cmd);
          }
          return row;
        }));
      } catch (err) {
        body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    async function loadKeys() {
      const body = $("settings-keys-body");
      try {
        const r = await fetch("/api/settings/keys");
        const j = await r.json();
        if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
        const rows = j.keys.map((k) => {
          const row = document.createElement("div");
          row.className = "key-row " + (k.ok ? "ok" : "warn");
          row.innerHTML =
            "<span class=\"mark\">" + (k.ok ? "✓" : "○") + "</span>" +
            "<span class=\"name\">" + escapeText(k.name) + "</span>" +
            "<span class=\"detail\">" + escapeText(k.ok ? `set (${k.length} chars)` : "unset · " + k.purpose) + "</span>";
          return row;
        });
        const note = document.createElement("div");
        note.className = "dim small";
        note.style.marginTop = "10px";
        note.textContent = j.note;
        body.replaceChildren(...rows, note);
      } catch (err) {
        body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    async function loadOAuth() {
      const body = $("settings-oauth-body");
      try {
        const r = await fetch("/api/settings/oauth");
        const j = await r.json();
        if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
        if (!j.accounts.length) {
          body.innerHTML = "<div class=\"dim\">no accounts in <code>~/.config/subctl/accounts.conf</code></div>";
          return;
        }
        body.replaceChildren(...j.accounts.map((a) => {
          const row = document.createElement("div");
          const ok = a.auth_status === "ready";
          row.className = "oauth-row " + (ok ? "ok" : "err");
          row.innerHTML =
            "<span class=\"mark\">" + (ok ? "✓" : "✗") + "</span>" +
            "<span class=\"name\">" + escapeText(a.alias) + "</span>" +
            "<span class=\"detail\">" + escapeText(a.email + " · " + (ok ? "authed" : "not authenticated")) + "</span>";
          if (!ok) {
            // Use the account's actual provider (claude/openai/gemini) so
            // the copied command lands the user in the right OAuth flow.
            const cmdText = "subctl auth " + a.provider + " " + a.alias;
            const cmd = document.createElement("code");
            cmd.className = "install-cmd";
            cmd.textContent = cmdText;
            cmd.title = "click to copy — run this on the M3 Ultra (ssh argent-m3-ultra-dev)";
            cmd.addEventListener("click", () => {
              navigator.clipboard.writeText(cmdText);
              cmd.textContent = "copied ✓";
              setTimeout(() => cmd.textContent = cmdText, 1500);
            });
            row.appendChild(cmd);
          }
          return row;
        }));
      } catch (err) {
        body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    async function loadTelegramStatus() {
      const status = $("settings-tg-status");
      try {
        const r = await fetch("/api/settings/telegram/test", { method: "POST" });
        const j = await r.json();
        if (j.ok) {
          status.textContent = `@${j.bot_username || "?"} ok · chat ${j.chat_id || "(unset)"}`;
          status.style.color = "#6cd697";
        } else {
          status.textContent = "error: " + (j.error || "?");
          status.style.color = "#d66c6c";
        }
      } catch {
        status.textContent = "unreachable";
        status.style.color = "#d66c6c";
      }
    }

    function wireTelegramForm() {
      const save = $("settings-tg-save");
      const test = $("settings-tg-test");
      const result = $("settings-tg-result");
      const tokenIn = $("settings-tg-token");
      const chatIn = $("settings-tg-chatid");

      function showResult(ok, text) {
        result.hidden = false;
        result.className = "settings-result " + (ok ? "ok" : "err");
        result.textContent = text;
      }

      save?.addEventListener("click", async () => {
        const payload = { bot_token: tokenIn.value, chat_id: chatIn.value };
        if (!payload.bot_token && !payload.chat_id) {
          showResult(false, "nothing to save — provide a token, chat id, or both");
          return;
        }
        save.disabled = true;
        save.textContent = "saving…";
        try {
          const r = await fetch("/api/settings/telegram", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await r.json();
          if (j.ok) {
            showResult(true, `✓ saved + master restarted\n@${j.bot_username || "?"} reachable, chat_id ${j.chat_id_set ? "set" : "unchanged"}`);
            tokenIn.value = "";
            loadTelegramStatus();
          } else {
            showResult(false, "Failed: " + (j.error || "?"));
          }
        } catch (err) {
          showResult(false, "Error: " + err);
        } finally {
          save.disabled = false;
          save.textContent = "save & test";
        }
      });

      test?.addEventListener("click", async () => {
        test.disabled = true;
        test.textContent = "testing…";
        try {
          const r = await fetch("/api/settings/telegram/test", { method: "POST" });
          const j = await r.json();
          showResult(j.ok, j.ok
            ? `✓ @${j.bot_username || "?"} reachable\nchat_id ${j.chat_id || "(unset)"}`
            : "✗ " + (j.error || "test failed"));
        } catch (err) {
          showResult(false, "Error: " + err);
        } finally {
          test.disabled = false;
          test.textContent = "test current";
        }
      });
    }
    wireTelegramForm();

    function wireConfigViewer() {
      const view = $("settings-config-view");
      const tabs = document.querySelectorAll("#settings-config-tabs .config-tab");
      let active = "policy";

      async function load(name) {
        view.textContent = "loading…";
        try {
          const r = await fetch("/api/settings/config/" + name);
          const j = await r.json();
          if (!j.ok) { view.textContent = "error: " + (j.error || "?"); return; }
          view.textContent = `// ${j.path}\n\n${j.content}`;
        } catch (err) {
          view.textContent = "error: " + err;
        }
      }
      tabs.forEach((t) => {
        t.addEventListener("click", () => {
          tabs.forEach((x) => x.classList.toggle("active", x === t));
          active = t.dataset.config;
          load(active);
        });
      });
      load(active);
    }
    wireConfigViewer();

    async function loadVault() {
      const status = $("settings-vault-status");
      const input = $("settings-vault-root");
      try {
        const r = await fetch("/api/settings/obsidian");
        const j = await r.json();
        if (!j.ok) {
          if (status) { status.textContent = "error"; status.style.color = "#d66c6c"; }
          return;
        }
        if (input && !input.value) input.value = j.vault_root || "";
        if (status) {
          const note = j.exists ? (j.configured ? "configured · exists" : "default · exists") : (j.configured ? "configured · MISSING" : "default · missing");
          status.textContent = note;
          status.style.color = j.exists ? "#6cd697" : "#d6c46c";
        }
      } catch {
        if (status) { status.textContent = "unreachable"; status.style.color = "#d66c6c"; }
      }
    }
    function wireVaultForm() {
      const save = $("settings-vault-save");
      const input = $("settings-vault-root");
      const result = $("settings-vault-result");
      if (!save || !input) return;
      save.addEventListener("click", async () => {
        const v = input.value.trim();
        if (!v) {
          result.hidden = false;
          result.className = "settings-result err";
          result.textContent = "vault_root is empty";
          return;
        }
        save.disabled = true;
        save.textContent = "saving…";
        try {
          const r = await fetch("/api/settings/obsidian", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vault_root: v }),
          });
          const j = await r.json();
          result.hidden = false;
          if (!j.ok) {
            result.className = "settings-result err";
            result.textContent = "Failed: " + (j.error || "?");
          } else {
            result.className = "settings-result ok";
            result.textContent = "✓ saved · " + (j.exists ? "vault exists" : "path saved but vault dir doesn't exist yet — create it on the M3 Ultra");
            loadVault();
          }
        } catch (err) {
          result.hidden = false;
          result.className = "settings-result err";
          result.textContent = "Error: " + err;
        } finally {
          save.disabled = false;
          save.textContent = "save";
        }
      });
    }
    wireVaultForm();

    function refreshAll() {
      loadHealth();
      loadKeys();
      loadOAuth();
      loadTelegramStatus();
      loadVault();
    }
    refreshBtn.addEventListener("click", refreshAll);
    refreshAll();
  }

  // ----- Chat model selector (top of Chat screen) -----
  function wireChatModelSelector() {
    const sel = $("chat-model-select");
    const apply = $("chat-model-apply");
    const cur = $("chat-model-current");
    if (!sel || !apply) return;
    let currentSupervisor = null;

    async function refresh() {
      try {
        const [provR, diagR] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/master/diag"),
        ]);
        const provJ = await provR.json();
        const diag = await diagR.json().catch(() => ({}));
        const supervisor = diag.supervisor ?? null;
        currentSupervisor = supervisor;
        if (cur) cur.textContent = supervisor ? "supervisor: " + supervisor : "supervisor: (unknown)";
        if (!provJ.ok) {
          sel.innerHTML = "<option value=''>providers unreachable</option>";
          return;
        }
        // Build optgroups: cloud (always-on, green) first, then LM Studio
        // (per-model loaded indicator). Value format: "<provider>|<model>"
        // so the apply handler can split.
        const groups = [];
        // Cloud first per Jason's "local first" instruction is actually
        // about chat-priority — cloud is always available, but LOCAL is
        // the default we steer toward. Show cloud at the TOP of the
        // dropdown but mark them clearly so they're easy to skip past.
        const cloud = (provJ.providers || []).filter((p) => p.kind === "cloud");
        const local = (provJ.providers || []).filter((p) => p.kind === "local");

        let html = "";
        if (cloud.length) {
          html += "<optgroup label=\"Cloud (always-on)\">";
          for (const p of cloud) {
            const dot = p.available ? "●" : "○";
            const state = p.available ? "ready" : "not authed";
            const model = p.default_model || "?";
            const value = `${p.id}|${model}`;
            const isCurrent = supervisor === `${p.id}/${model}`;
            html += `<option value="${escapeText(value)}" ${isCurrent ? "selected" : ""}>${dot}  ${escapeText(p.display)} · ${escapeText(model)} · ${state}</option>`;
          }
          html += "</optgroup>";
        }
        if (local.length) {
          for (const p of local) {
            const models = (p.models || []).slice().sort((a, b) => {
              if (a.loaded && !b.loaded) return -1;
              if (!a.loaded && b.loaded) return 1;
              return (a.id || "").localeCompare(b.id || "");
            });
            html += `<optgroup label="LM Studio (local · ${models.filter((m) => m.loaded).length}/${models.length} loaded)">`;
            for (const m of models) {
              const dot = m.loaded ? "●" : "○";
              const ctx = m.loaded_context_length ? `ctx ${m.loaded_context_length.toLocaleString()}` : "";
              const value = `${p.id}|${m.id}`;
              const isCurrent = supervisor === `${p.id}/${m.id}`;
              const parts = [
                m.id,
                m.loaded ? "loaded" : "not-loaded",
                m.quantization,
                ctx,
              ].filter(Boolean).join(" · ");
              html += `<option value="${escapeText(value)}" ${isCurrent ? "selected" : ""}>${dot}  ${escapeText(parts)}</option>`;
            }
            html += "</optgroup>";
          }
        }
        sel.innerHTML = html || "<option value=''>(no providers reachable)</option>";
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
      const [provider, ...modelParts] = picked.split("|");
      const model = modelParts.join("|");
      if (!provider || !model) return;
      const ok = await window.notice.confirm(
        "Switch supervisor model",
        `New supervisor: ${provider} / ${model}\n\nThis edits providers.json and restarts the master daemon. Your transcript is preserved.`,
      );
      if (!ok) return;
      apply.disabled = true;
      apply.textContent = "applying…";
      try {
        const r = await fetch("/api/master/supervisor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, model }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) {
          apply.textContent = "failed";
          await window.notice.error("Switch failed", j.error || ("HTTP " + r.status));
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; }, 2000);
        } else {
          apply.textContent = "switched ✓";
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; refresh(); }, 3500);
        }
      } catch (err) {
        apply.textContent = "error";
        await window.notice.error("Switch error", String(err));
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

  // ---------- notice/confirm modal ----------
  // Replaces browser alert() and confirm() so popups match the dashboard
  // theme. Returns a Promise<boolean> for confirm-style usage; resolves
  // true on OK, false on cancel/escape/close.
  //
  // Usage:
  //   await notice("Title", "Plain message")           — info, single OK
  //   await notice.error("Switch failed", err.message) — red header
  //   await notice.confirm("Delete?", "This is permanent.") — returns bool
  //
  // The dashboard already has alert() / confirm() calls scattered through
  // the legacy widgets; we sweep the most user-visible ones (chat,
  // supervisor switch, delete buttons) to use this helper. Background
  // dialogs (e.g. minor errors in low-traffic admin views) can keep
  // alert() until needed.
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
      cancelBtn.hidden = !confirm;
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

  // CSS-escape (subset) — ids in our project chat logs include / : etc. and
  // querySelector chokes on them. Replace anything non-alphanumeric+dash+underscore.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // One-shot SSE listener that captures the next assistant turn (from the
  // first message_start through agent_end) into a target log element. Used
  // by the per-project chat panels — they piggyback on the same master
  // /events stream the main Chat panel consumes, but render only the
  // current turn into their own scoped log.
  function attachOneShotAssistantCapture(logEl) {
    const es = new EventSource("/api/master/events");
    let bubble = null;
    let toolBubbles = new Map();
    let active = false;
    let acc = "";
    const cleanup = () => { try { es.close(); } catch {} };
    const ensureBubble = () => {
      if (bubble) return bubble;
      const m = document.createElement("div");
      m.className = "pd-chat-msg pd-chat-master";
      m.innerHTML = `<div class="pd-chat-label">master</div><div class="pd-chat-body"></div>`;
      logEl.appendChild(m);
      logEl.scrollTop = logEl.scrollHeight;
      bubble = m.querySelector(".pd-chat-body");
      return bubble;
    };
    es.addEventListener("message_start", () => {
      active = true;
      acc = "";
      bubble = null;
    });
    es.addEventListener("message_update", (e) => {
      if (!active) return;
      try {
        const d = JSON.parse(e.data);
        const ev = d.assistantMessageEvent;
        if (!ev) return;
        if (ev.type === "text_delta" && typeof ev.delta === "string") {
          acc += ev.delta;
          ensureBubble().textContent = acc;
          logEl.scrollTop = logEl.scrollHeight;
        } else if (ev.type === "toolcall_start") {
          const tc = ev.partial?.content?.[ev.contentIndex];
          if (tc?.id && tc?.name) {
            const tcEl = document.createElement("div");
            tcEl.className = "pd-chat-msg pd-chat-tool";
            tcEl.innerHTML = `<div class="pd-chat-label">tool · ${escapeText(tc.name)}</div>`;
            logEl.appendChild(tcEl);
            toolBubbles.set(tc.id, tcEl);
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
      } catch {}
    });
    es.addEventListener("agent_end", () => { cleanup(); });
    es.addEventListener("error", () => { setTimeout(cleanup, 1000); });
    // Safety timeout — if nothing happens within 90s, give up (in case the
    // user never receives an assistant turn for any reason).
    setTimeout(cleanup, 90000);
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

            <!-- Per-project chat: scope master to this specific project -->
            <section class="pd-card pd-card-wide pd-chat">
              <h3>Talk to master about this project</h3>
              <div class="pd-chat-log" id="pd-chat-log-${escapeText(p.name)}">
                <div class="dim small">messages here are pre-scoped to <strong>${escapeText(p.name)}</strong> — master gets your text plus project metadata so it can call the right tools without you re-stating context</div>
              </div>
              <form class="pd-chat-form" data-project="${escapeText(p.name)}" data-path="${escapeText(p.path)}">
                <input type="text" class="pd-chat-input" placeholder="ask master about ${escapeText(p.name)}…" autocomplete="off" />
                <button type="submit" class="primary-btn">send</button>
              </form>
            </section>
          </div>
        </div>
      `;
      // Wire per-project chat form
      const pdForm = detailEl.querySelector(".pd-chat-form");
      const pdInput = detailEl.querySelector(".pd-chat-input");
      const pdLog = detailEl.querySelector(`#pd-chat-log-${cssEscape(p.name)}`);
      if (pdForm && pdInput && pdLog) {
        pdForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const text = pdInput.value.trim();
          if (!text) return;
          pdInput.value = "";
          // Append user bubble to the project chat log
          const empty = pdLog.querySelector(".dim");
          if (empty) empty.remove();
          const u = document.createElement("div");
          u.className = "pd-chat-msg pd-chat-user";
          u.innerHTML = `<div class="pd-chat-label">you</div><div class="pd-chat-body"></div>`;
          u.querySelector(".pd-chat-body").textContent = text;
          pdLog.appendChild(u);
          pdLog.scrollTop = pdLog.scrollHeight;
          // Compose a project-scoped directive
          const scopedText =
            `[project: ${p.name} | path: ${p.path}${p.github_repo ? ` | repo: ${p.github_repo}` : ""}${p.branch ? ` | branch: ${p.branch}` : ""}]\n\n${text}`;
          try {
            const r = await fetch("/api/master/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: scopedText, source: "chat" }),
            });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              const err = document.createElement("div");
              err.className = "pd-chat-msg pd-chat-err";
              err.textContent = "send failed: " + (j.error || r.status);
              pdLog.appendChild(err);
            }
            // The master's response streams to /api/master/events. We tap it
            // below via a one-shot SSE listener that watches for the next
            // assistant turn after our submission.
            attachOneShotAssistantCapture(pdLog);
          } catch (err) {
            const e2 = document.createElement("div");
            e2.className = "pd-chat-msg pd-chat-err";
            e2.textContent = "send error: " + err;
            pdLog.appendChild(e2);
          }
        });
      }

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

    // + New Project button — wizard modal
    const newBtn = $("project-new-btn");
    const modal = $("new-project-modal");
    const modalClose = $("new-project-close");
    const modalCancel = $("new-project-cancel");
    const form = $("new-project-form");
    const nameInput = $("np-name");
    const namePreview = $("np-name-preview");
    const submitBtn = $("new-project-submit");
    const statusEl = $("np-status");
    function openModal() {
      if (!modal) return;
      modal.hidden = false;
      setTimeout(() => nameInput && nameInput.focus(), 50);
    }
    function closeModal() {
      if (!modal) return;
      modal.hidden = true;
      if (form) form.reset();
      if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; statusEl.className = "form-status"; }
      if (namePreview) namePreview.textContent = "my-new-project";
      document.querySelectorAll(".np-name-mirror").forEach((el) => el.textContent = "my-new-project");
    }
    if (newBtn) newBtn.addEventListener("click", openModal);
    if (modalClose) modalClose.addEventListener("click", closeModal);
    if (modalCancel) modalCancel.addEventListener("click", closeModal);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.hidden) closeModal();
    });
    // Live-preview the NORMALIZED name (what the server will actually use)
    // — collapses whitespace to dashes + drops other invalid chars. Keeps
    // the input itself raw so the user isn't fighting the field.
    function normalizeNameForPreview(raw) {
      return (raw || "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .replace(/^-+|-+$/g, "") || "my-new-project";
    }
    if (nameInput && namePreview) {
      nameInput.addEventListener("input", () => {
        const v = normalizeNameForPreview(nameInput.value);
        namePreview.textContent = v;
        document.querySelectorAll(".np-name-mirror").forEach((el) => el.textContent = v);
      });
    }
    // Toggle the GitHub visibility row when the create-github checkbox flips.
    // Also disables it visually when a Git URL is set (since gh repo create
    // wouldn't run anyway — we'd be cloning an existing one instead).
    const ghCheck = $("np-create-github");
    const ghVisRow = $("np-github-vis-row");
    const gitUrlIn = $("np-git-url");
    function syncGithubControls() {
      if (!ghCheck || !ghVisRow) return;
      const hasUrl = !!(gitUrlIn?.value?.trim());
      ghCheck.disabled = hasUrl;
      if (hasUrl) {
        ghCheck.checked = false;
        ghVisRow.style.display = "none";
      } else if (ghCheck.checked) {
        ghVisRow.style.display = "";
      } else {
        ghVisRow.style.display = "none";
      }
    }
    if (ghCheck) ghCheck.addEventListener("change", syncGithubControls);
    if (gitUrlIn) gitUrlIn.addEventListener("input", syncGithubControls);

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
          name: nameInput.value.trim(),
          git_url: ($("np-git-url")?.value || "").trim(),
          autonomy_level: $("np-autonomy")?.value || "ask",
          create_vault: $("np-create-vault")?.checked !== false,
          add_to_policy: $("np-add-policy")?.checked !== false,
          create_github_repo: $("np-create-github")?.checked === true,
          github_visibility: $("np-github-vis")?.value || "private",
        };
        if (!payload.name) return;
        submitBtn.disabled = true;
        submitBtn.textContent = "creating…";
        statusEl.hidden = false;
        statusEl.className = "form-status form-status-info";
        statusEl.textContent = payload.git_url
          ? "Cloning " + payload.git_url + " into ~/code/" + payload.name + "…"
          : "Initializing ~/code/" + payload.name + "…";
        try {
          const r = await fetch("/api/projects/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await r.json();
          if (!j.ok) {
            statusEl.className = "form-status form-status-err";
            statusEl.textContent = "Failed: " + (j.error || r.status);
            if (j.steps && j.steps.length) {
              statusEl.textContent += "\n\n" + j.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.step}: ${s.detail || ""}`).join("\n");
            }
            submitBtn.disabled = false;
            submitBtn.textContent = "create";
            return;
          }
          statusEl.className = "form-status form-status-ok";
          statusEl.textContent = "✓ Created.\n" + (j.steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.step}: ${s.detail || ""}`).join("\n");
          submitBtn.textContent = "done ✓";
          // Refresh the project list and select the new one
          await refreshList();
          selectProject(payload.name);
          setTimeout(closeModal, 1800);
        } catch (err) {
          statusEl.className = "form-status form-status-err";
          statusEl.textContent = "Error: " + err;
          submitBtn.disabled = false;
          submitBtn.textContent = "create";
        }
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
    const newBtn = $("chat-new-btn");
    const ctxFill = $("ctx-fill");
    const ctxLabel = $("ctx-label");
    if (!log || !form || !input) return;

    // Rehydrate the chat log from the master daemon's persisted transcript
    // so a browser refresh doesn't wipe what we see. Fetch on mount, render
    // each historic message into the same bubble shape the SSE stream uses.
    async function rehydrateFromTranscript() {
      try {
        const r = await fetch("/api/master/transcript?limit=80");
        const j = await r.json();
        if (!j.ok || !Array.isArray(j.messages) || j.messages.length === 0) return;
        const empty = log.querySelector(".master-log-empty");
        if (empty) empty.remove();
        for (const m of j.messages) {
          if (m.role === "user") {
            // Don't replay synthetic watchdog/team-report prompts — those
            // were the daemon talking to itself, not Jason.
            const text = (m.content || []).map((b) => b.text).filter(Boolean).join("");
            if (text.startsWith("[watchdog]") || text.startsWith("[team-report]")) {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-watchdog";
              block.innerHTML = `<div class="master-msg-label">watchdog</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            } else {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-user";
              block.innerHTML = `<div class="master-msg-label">you</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            }
          } else if (m.role === "assistant") {
            // Render text blocks; tool calls go into their own bubbles.
            const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
            if (text) {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-assistant";
              block.innerHTML = `<div class="master-msg-label">master</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            }
            const toolCalls = (m.content || []).filter((b) => b.type === "toolCall");
            for (const tc of toolCalls) {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-tool";
              block.innerHTML = `<div class="master-msg-label">tool · ${escapeText(tc.name || "?")}</div><div class="master-msg-body master-tool-body"></div>`;
              block.querySelector(".master-tool-body").textContent = tc.arguments ? JSON.stringify(tc.arguments) : "";
              log.appendChild(block);
            }
          } else if (m.role === "toolResult") {
            // Show as a small ✓ next to the most recent tool bubble — keeps
            // log compact. For now skip; SSE will render fresh tool results
            // anyway. Could be enhanced to attach result summary to the
            // matching tool bubble.
          }
        }
        // Defer scroll-to-bottom past two RAFs so layout has fully
        // settled. setting scrollTop synchronously after innerHTML
        // sometimes runs before the browser computes scrollHeight,
        // which leaves the user at the top.
        const stickToBottom = () => { log.scrollTop = log.scrollHeight; };
        requestAnimationFrame(() => requestAnimationFrame(stickToBottom));
      } catch {
        // If the master is unreachable just leave the empty-state alone.
      }
    }
    rehydrateFromTranscript();

    // Also scroll-to-bottom whenever the Chat tab becomes visible — the
    // rehydrate runs once on mount, but if the user lands on Settings
    // first and switches over, the initial scroll has long since fired
    // before the panel had any height.
    const chatPanel = document.querySelector("section[data-tab=\"chat\"]");
    if (chatPanel) {
      const observer = new MutationObserver(() => {
        if (getComputedStyle(chatPanel).display !== "none") {
          requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
        }
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
      // Also handle the very first render where data-active-tab may set BEFORE this code runs
      if (getComputedStyle(chatPanel).display !== "none") {
        requestAnimationFrame(() => requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }));
      }
    }

    // Context window meter — poll every 5s while the chat tab is visible.
    async function refreshContext() {
      try {
        const r = await fetch("/api/master/context");
        const j = await r.json();
        if (!j.ok || !ctxFill || !ctxLabel) return;
        const pct = j.utilization_pct;
        if (typeof pct === "number") {
          ctxFill.style.width = Math.min(100, pct) + "%";
          ctxFill.classList.toggle("warn", pct >= 60 && pct < 85);
          ctxFill.classList.toggle("crit", pct >= 85);
        }
        const total = j.estimated_total_tokens;
        const cap = j.loaded_context_length;
        ctxLabel.textContent = cap
          ? `ctx ${total.toLocaleString()} / ${cap.toLocaleString()} tok (${pct ?? "?"}%)`
          : `ctx ~${total.toLocaleString()} tok`;
        // Show the overflow banner once we're past 100% — the supervisor
        // is silently truncating from this point on, so flag it loudly.
        const banner = $("ctx-overflow-banner");
        if (banner) {
          if (typeof pct === "number" && pct > 100) {
            banner.hidden = false;
            const capEl = $("ctx-overflow-cap");
            const nowEl = $("ctx-overflow-now");
            if (capEl) capEl.textContent = (cap || 0).toLocaleString();
            if (nowEl) nowEl.textContent = (total || 0).toLocaleString();
          } else {
            banner.hidden = true;
          }
        }
      } catch { /* silent */ }
    }
    refreshContext();
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"chat\"]");
      if (panel && getComputedStyle(panel).display !== "none") refreshContext();
    }, 5000);

    // Full-screen toggle: persists via localStorage so the choice survives refresh.
    const fsBtn = $("chat-fullscreen-btn");
    const FS_KEY = "subctl.dashboard.chatFullscreen";
    function setFullscreen(on) {
      document.body.classList.toggle("chat-fullscreen", on);
      try { localStorage.setItem(FS_KEY, on ? "1" : "0"); } catch {}
    }
    if (fsBtn) {
      fsBtn.addEventListener("click", () => {
        setFullscreen(!document.body.classList.contains("chat-fullscreen"));
      });
      // Restore prior state
      try {
        if (localStorage.getItem(FS_KEY) === "1") setFullscreen(true);
      } catch {}
      // Esc exits full-screen
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && document.body.classList.contains("chat-fullscreen")) {
          setFullscreen(false);
        }
      });
    }

    // Compact transcript button: summarize older turns into a single
    // message so the supervisor's prompt window stays manageable.
    async function runCompact(initiator) {
      const ok = await window.notice.confirm(
        "Compact transcript",
        "Master will keep the last 6 messages intact and replace everything before them with a structured summary (your asks + assistant highlights + tools used). The original transcript is archived to ~/.config/subctl/master/agent-state.archive-compact-*.json.",
      );
      if (!ok) return;
      try {
        const r = await fetch("/api/master/transcript/compact", { method: "POST" });
        const j = await r.json();
        if (!j.ok) {
          await window.notice.error("Compact failed", j.error || "unknown");
          return;
        }
        while (log.firstChild) log.removeChild(log.firstChild);
        await rehydrateFromTranscript();
        refreshContext();
      } catch (err) {
        await window.notice.error("Compact error", String(err));
      }
    }
    const compactBtn = $("chat-compact-btn");
    if (compactBtn) compactBtn.addEventListener("click", () => runCompact("toolbar"));
    const bannerCompact = $("ctx-overflow-compact");
    if (bannerCompact) bannerCompact.addEventListener("click", () => runCompact("banner"));

    // New Chat button: archive the transcript and start fresh.
    if (newBtn) {
      newBtn.addEventListener("click", async () => {
        const ok = await window.notice.confirm(
          "Start a fresh conversation",
          "Archive the current transcript and start fresh? Your transcript is saved to ~/.config/subctl/master/agent-state.archive-*.json — nothing is lost. The chat log here will clear and the master daemon's working memory resets.",
        );
        if (!ok) return;
        newBtn.disabled = true;
        newBtn.textContent = "clearing…";
        try {
          const r = await fetch("/api/master/transcript/clear", { method: "POST" });
          const j = await r.json();
          if (!j.ok) {
            await window.notice.error("Clear failed", j.error || "unknown");
          } else {
            // Wipe local UI
            while (log.firstChild) log.removeChild(log.firstChild);
            const empty = document.createElement("div");
            empty.className = "master-log-empty";
            empty.innerHTML = "fresh chat — prior transcript archived to <code>" + j.archive.split("/").slice(-1)[0] + "</code>";
            log.appendChild(empty);
            refreshContext();
          }
        } catch (err) {
          await window.notice.error("Clear error", String(err));
        } finally {
          newBtn.disabled = false;
          newBtn.textContent = "+ new chat";
        }
      });
    }

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
    let reconnectingDebounce = null;

    function connect() {
      // Don't show "connecting" on first paint either — rely on the
      // EventSource open event to flip to connected. Initial state is
      // "connecting" already from the HTML default.
      if (!es) setConnState("connecting");
      es = new EventSource("/api/master/events");
      es.addEventListener("open", () => {
        // Cancel any pending "reconnecting" display — we made it back.
        if (reconnectingDebounce) {
          clearTimeout(reconnectingDebounce);
          reconnectingDebounce = null;
        }
        setConnState("connected");
        backoffMs = 1000;
      });
      es.addEventListener("error", () => {
        try { es.close(); } catch {}
        // Debounce: only show "reconnecting" if we're still trying after
        // 1.5s. Most real reconnects complete in <1s and shouldn't flash
        // the UI.
        if (reconnectingDebounce) clearTimeout(reconnectingDebounce);
        reconnectingDebounce = setTimeout(() => {
          setConnState("reconnecting");
          reconnectingDebounce = null;
        }, 1500);
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

  // Kick off — also try polling immediately so first paint isn't blocked
  // on the WS handshake.
  startPolling();
  connectWS();
})();
