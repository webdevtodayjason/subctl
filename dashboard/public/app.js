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

  // ----- Tool-call display config (v2.7.12) -----
  // Maps a tool name → { family, color, icon } so the chat panel can render
  // each tool as a family-colored neon pill instead of a full-width card.
  // Config is fetched once from /tool-display.json (served as a static file
  // by dashboard/server.ts); if the fetch fails (offline, bad deploy, etc.)
  // we fall back to a hardcoded copy so the chat keeps working.
  const TOOL_DISPLAY_FALLBACK = {
    version: 1,
    fallback: { family: "tool", icon: "🔧" },
    families: {
      system:        { color: "#5fd7ff", icon: "🖥" },
      lmstudio:      { color: "#6dd4d4", icon: "🧠" },
      knowledge:     { color: "#d480b8", icon: "📚" },
      memory:        { color: "#b074d6", icon: "💭" },
      network:       { color: "#6cd697", icon: "🌐" },
      orchestration: { color: "#e89a4a", icon: "🎭" },
      docs:          { color: "#7ad4c4", icon: "📝" },
      policy:        { color: "#d6c46c", icon: "🛡" },
      notify:        { color: "#d67aa7", icon: "📣" },
      tool:          { color: "#888888", icon: "🔧" },
    },
    rules: [
      { prefix: "system_lmstudio_",       family: "lmstudio" },
      { exact:  "system_subctl_knowledge", family: "knowledge" },
      { prefix: "system_",                 family: "system" },
      { prefix: "memory_",                 family: "memory" },
      { prefix: "mcp__plugin_claude-mem_", family: "memory" },
      { prefix: "web_",                    family: "network" },
      { prefix: "linear_",                 family: "network" },
      { prefix: "context7_",               family: "network" },
      { prefix: "subctl_orch_",            family: "orchestration" },
      { prefix: "team_doc_",               family: "docs" },
      { exact:  "team_decision_log",       family: "docs" },
      { prefix: "policy_",                 family: "policy" },
      { prefix: "notify_",                 family: "notify" },
      { prefix: "telegram_",               family: "notify" },
    ],
  };
  let _toolDisplayConfig = null;
  let _toolDisplayPromise = null;
  function loadToolDisplay() {
    if (_toolDisplayConfig) return Promise.resolve(_toolDisplayConfig);
    if (_toolDisplayPromise) return _toolDisplayPromise;
    _toolDisplayPromise = fetch("/tool-display.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        _toolDisplayConfig = (j && j.families && j.rules) ? j : TOOL_DISPLAY_FALLBACK;
        return _toolDisplayConfig;
      })
      .catch(() => {
        _toolDisplayConfig = TOOL_DISPLAY_FALLBACK;
        return _toolDisplayConfig;
      });
    return _toolDisplayPromise;
  }
  // Kick off the fetch immediately so the cache is usually warm by the time
  // the first tool call renders. Synchronous lookups fall back if the fetch
  // hasn't resolved yet.
  loadToolDisplay();

  function _toolDisplayConfigSync() {
    return _toolDisplayConfig || TOOL_DISPLAY_FALLBACK;
  }

  // Resolve a tool name → { family, color, icon }. Walks the rules array in
  // order; first match wins. Unmatched → fallback. Matching is case-sensitive
  // because tool names from the LM Studio API are already canonical.
  function resolveToolDisplay(name) {
    const cfg = _toolDisplayConfigSync();
    const safeName = String(name || "");
    for (const rule of cfg.rules || []) {
      if (rule.exact && rule.exact === safeName) {
        const fam = cfg.families[rule.family] || cfg.fallback;
        return { family: rule.family, color: fam.color, icon: fam.icon };
      }
      if (rule.prefix && safeName.startsWith(rule.prefix)) {
        const fam = cfg.families[rule.family] || cfg.fallback;
        return { family: rule.family, color: fam.color, icon: fam.icon };
      }
    }
    const fb = cfg.fallback || { family: "tool", icon: "🔧" };
    const famDef = cfg.families[fb.family] || { color: "#888888", icon: "🔧" };
    return { family: fb.family, color: famDef.color, icon: famDef.icon };
  }

  // Args -> a short single-line preview string. Returns "" when there are
  // no args so callers can hide the preview span entirely (no empty `{}`
  // noise). For one key: `key=value` (value truncated to 24 chars). For 2+:
  // `key1=v1, key2=v2 …` truncated to 40 chars total.
  function formatToolArgsPreview(args) {
    if (args == null) return "";
    let obj = args;
    if (typeof args === "string") {
      const s = args.trim();
      if (!s || s === "{}") return "";
      try { obj = JSON.parse(s); } catch { return s.length > 40 ? s.slice(0, 39) + "…" : s; }
    }
    if (typeof obj !== "object" || Array.isArray(obj)) {
      const s = JSON.stringify(obj);
      return s.length > 40 ? s.slice(0, 39) + "…" : s;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    const fmtVal = (v, max) => {
      let s = (typeof v === "string") ? v : JSON.stringify(v);
      s = String(s).replace(/\s+/g, " ");
      if (s.length > max) s = s.slice(0, max - 1) + "…";
      return s;
    };
    if (keys.length === 1) {
      const k = keys[0];
      return `${k}=${fmtVal(obj[k], 24)}`;
    }
    const parts = keys.slice(0, 4).map((k) => `${k}=${fmtVal(obj[k], 10)}`);
    let out = parts.join(", ");
    if (keys.length > parts.length) out += " …";
    if (out.length > 40) out = out.slice(0, 39) + "…";
    return out;
  }

  // Format the full args + result blob for the click-to-expand panel.
  // Pretty-printed JSON for objects, raw for strings.
  function formatToolDetailBlock(label, value) {
    if (value == null || value === "") return "";
    let body = value;
    if (typeof value !== "string") {
      try { body = JSON.stringify(value, null, 2); } catch { body = String(value); }
    }
    return `${label}:\n${body}`;
  }

  // Render a single tool-call pill. Returns a <button> element ready to be
  // appended into a `.chat-tool-pills` container. `opts.ok` may be true
  // (success), false (error), or undefined (pending — no status glyph yet).
  function renderToolPill(opts) {
    const { name, args, result, ok } = opts || {};
    const disp = resolveToolDisplay(name);
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chat-tool-pill";
    pill.dataset.family = disp.family;
    pill.dataset.toolName = String(name || "");
    pill.style.setProperty("--pill-color", disp.color);

    const iconEl = document.createElement("span");
    iconEl.className = "chat-tool-pill__icon";
    iconEl.textContent = disp.icon;
    pill.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "chat-tool-pill__name";
    nameEl.textContent = String(name || "tool");
    pill.appendChild(nameEl);

    const preview = formatToolArgsPreview(args);
    if (preview) {
      const argsEl = document.createElement("span");
      argsEl.className = "chat-tool-pill__args";
      argsEl.textContent = preview;
      pill.appendChild(argsEl);
    }

    if (ok === true) pill.classList.add("chat-tool-pill--ok");
    else if (ok === false) pill.classList.add("chat-tool-pill--err");

    if (args != null) pill.dataset.args = (typeof args === "string") ? args : JSON.stringify(args);
    if (result != null) pill.dataset.result = (typeof result === "string") ? result : JSON.stringify(result);

    pill.addEventListener("click", () => {
      const a = formatToolDetailBlock("args", pill.dataset.args || "");
      const r = formatToolDetailBlock("result", pill.dataset.result || "");
      const body = [a, r].filter(Boolean).join("\n\n") || "(no details captured)";
      try {
        if (window.notice) window.notice(`tool · ${pill.dataset.toolName}`, body);
        else alert(body);
      } catch { /* swallow */ }
    });

    return pill;
  }

  // Append `pill` into the most recent `.chat-tool-pills` row attached to
  // `logEl`. If the row doesn't exist yet (this is the first pill of an
  // assistant turn), create one and append it to logEl.
  function ensureChatToolPillsRow(logEl) {
    if (!logEl) return null;
    const lastChild = logEl.lastElementChild;
    if (lastChild && lastChild.classList.contains("chat-tool-pills")) {
      return lastChild;
    }
    const row = document.createElement("div");
    row.className = "chat-tool-pills";
    logEl.appendChild(row);
    return row;
  }

  // ----- Thinking indicator (v2.7.12, fix v2.8.1) -----
  // Append a transient "Evy · thinking…" pill while master is processing
  // a chat turn. v2.8.1 fix: the indicator now persists through
  // intermediate events (tool_call, tool_result, message_start without
  // text) and is ONLY removed when an actual text_delta paints into the
  // assistant bubble (appendDelta) or the turn ends (endAssistantBubble,
  // agent_end), or on error/timeout. Previously a tool_call between the
  // operator message and the response text would prematurely hide the
  // indicator, leaving the operator staring at silence — the exact bug
  // the operator surfaced 2026-05-13 ("It says 'thinking', and then it
  // goes away, and it takes a hot second for her to respond").
  //
  // Label switches to "Evy · working" while a tool is mid-flight so the
  // operator gets feedback that something IS happening (the tool pills
  // already render below, but the label-flip closes the visual gap
  // between "thinking dots stopped" → "next event lands"). Reverts to
  // "thinking" if the assistant goes quiet again (e.g. tool_result then
  // waiting for the next reasoning step).
  // ── v2.8.1 chat perf / skill router ──
  function showChatThinking(logEl) {
    if (!logEl) return null;
    hideChatThinking(logEl); // dedup — only one at a time
    const el = document.createElement("div");
    el.className = "chat-thinking";
    el.dataset.role = "thinking";
    el.dataset.state = "thinking";
    el.innerHTML =
      '<span class="chat-thinking__label">Evy · thinking</span>' +
      '<span class="chat-thinking__dots"><span>●</span><span>●</span><span>●</span></span>';
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    return el;
  }
  function hideChatThinking(logEl) {
    if (!logEl) return;
    const existing = logEl.querySelectorAll(".chat-thinking");
    existing.forEach((n) => n.remove());
  }
  // v2.8.1 — flip the label between "thinking" and "working" without
  // removing+re-adding the node (so the CSS dot animation doesn't
  // restart mid-turn). Safe to call when no indicator exists; no-op.
  function setChatThinkingState(logEl, state) {
    if (!logEl) return;
    const el = logEl.querySelector(".chat-thinking");
    if (!el) return;
    if (el.dataset.state === state) return;
    el.dataset.state = state;
    const label = el.querySelector(".chat-thinking__label");
    if (label) {
      label.textContent = state === "working" ? "Evy · working" : "Evy · thinking";
    }
  }

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
  wireProjectsTab();
  wireMemoryTab();
  wireVaultTab();
  wireChatModelSelector();
  wireProfilePill();
  wireOrchestrationCockpit();
  wireOrchCameraGrid();
  // v2.7.21 (ADR 0011 L2): web terminal escape hatch — query the flag-
  // file gate on boot. If disabled, stamp `terminal-disabled` on body so
  // CSS hides every Attach button + the modal entirely.
  wireWebTerminalGate();
  wireSettingsTab();
  wireSkillsTab();
  wireProvidersTab();
  wireTeamsTab();
  // ── v2.8.6 (wave 2): Templates tab extracted to dashboard/public/tabs/templates.js.
  // ── v2.8.6: Logs tab extracted to dashboard/public/tabs/logs.js. The
  // bootstrap.js shell loader mounts the module on first activation. The
  // chip + audit-detail state moved with it. See ORCHESTRATION.md 2026-05-13
  // night session for the state-ownership ruling.
  wirePolicyTab();

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
    // v2.7.24 — cached provider catalog from /api/providers. Populated
    // lazily when openModal() runs the first time, then refreshed each
    // open so newly-added pi-ai upstream providers light up without
    // a page reload.
    let cachedCatalog = null;

    async function populateProviderDropdown(preferredId) {
      const hint = document.getElementById("profile-provider-hint");
      try {
        const r = await fetch("/api/providers");
        const j = await r.json();
        if (!j.ok || !Array.isArray(j.providers)) {
          if (hint) hint.textContent = "could not load catalog";
          return;
        }
        cachedCatalog = j.providers.filter((p) => p.kind === "cloud");
        // Sort: providers with at least one profile first, then alpha
        // by display. Keeps the operator's day-to-day at the top while
        // exposing the long tail.
        cachedCatalog.sort((a, b) => {
          const aHas = (a.profiles || []).length > 0;
          const bHas = (b.profiles || []).length > 0;
          if (aHas !== bHas) return aHas ? -1 : 1;
          return String(a.display || a.id).localeCompare(String(b.display || b.id));
        });
        fProvider.replaceChildren(...cachedCatalog.map((p) => {
          const opt = document.createElement("option");
          // Use the legacy alias (claude, gemini) as the form value
          // when one exists, so accounts.conf rows stay readable for
          // operators that grep by hand. The POST handler resolves
          // either form via SUBCTL_TO_PI_AI.
          const formValue = p.legacy_alias || p.id;
          opt.value = formValue;
          const oauthBadge = p.auth_method === "oauth" ? " (OAuth)" : "";
          const profileBadge = (p.profiles || []).length > 0 ? ` · ${p.profiles.length} profile(s)` : "";
          opt.textContent = `${p.display || p.id}${oauthBadge}${profileBadge}`;
          fProvider.appendChild(opt);
          return opt;
        }));
        if (preferredId) {
          // Try both forms (legacy + canonical) so edit-prefill works.
          const match = cachedCatalog.find((p) => p.id === preferredId || p.legacy_alias === preferredId);
          if (match) fProvider.value = match.legacy_alias || match.id;
        }
        if (hint) hint.textContent = `${cachedCatalog.length} providers in catalog · pi-ai upstream`;
      } catch (err) {
        if (hint) hint.textContent = "catalog fetch failed: " + String(err);
      }
    }

    async function openModal(mode, prefill) {
      editingMode = mode;
      if (titleEl) titleEl.textContent = mode === "edit" ? `Edit profile: ${prefill?.alias || ""}` : "New profile";
      // Always refresh the dropdown so a freshly-added upstream provider
      // is visible without a page reload.
      await populateProviderDropdown(prefill?.provider);
      if (prefill) {
        fAlias.value = prefill.alias || "";
        fAlias.disabled = mode === "edit"; // alias is the key; can't rename mid-edit
        fEmail.value = prefill.email || "";
        fConfigDir.value = prefill.config_dir || "";
        fDescription.value = prefill.description || "";
      } else {
        // Don't form.reset() — that wipes the dropdown we just populated.
        fAlias.value = "";
        fAlias.disabled = false;
        fEmail.value = "";
        fConfigDir.value = "";
        fDescription.value = "";
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

    // ── v2.8.1 skills clarity ──
    // Layer the category-aware view on top of the legacy flat list. Reads
    // /api/skills/categorized + renders the four buckets with promote/delete
    // affordances on evy-authored drafts. Info popovers explain what each
    // category means so operator stops asking "what does this tab actually
    // do?".
    wireSkillsClarityView();
    // ── end v2.8.1 skills clarity ──
  }

  // ── v2.8.1 skills clarity ──
  const SKILLS_INFO_COPY = {
    "evy-loaded":
      "<strong>Evy's loaded skills</strong> are folded into Evy's master system prompt at every turn. They define how she communicates, handles tools, and operates. To change them, edit <code>components/skills/master/SKILL.md</code> (Evy persona) or the persona spec at <code>docs/persona/evy.md</code>.",
    "team-developer":
      "<strong>Team-developer skills</strong> get loaded into dev workers' system prompts at spawn time. A team template's <code>skills = [...]</code> array per developer decides which they get. Edit a template in the <a href=\"#\" data-tab-link=\"templates\">Templates</a> tab to assign skills to workers.",
    "evy-authored":
      "<strong>Evy-authored skills</strong> are drafts Evy created during conversations when she learned a reusable pattern. They start under <code>~/.local/state/subctl/evy-skills/</code>. Operator decides: <em>Promote</em> moves the file into <code>components/skills/</code> (canonical, git-tracked); <em>Delete</em> discards it.",
    "project-local":
      "<strong>Project-local skills</strong> are scoped to one project under <code>&lt;project&gt;/.subctl/skills/</code> per ADR 0003. Loaded only when Claude Code is operating inside that project's directory.",
  };

  function wireSkillsClarityView() {
    const popover = document.getElementById("skills-info-popover");

    document.querySelectorAll(".skills-info-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const key = btn.getAttribute("data-info");
        if (!key || !popover) return;
        popover.innerHTML = SKILLS_INFO_COPY[key] || "";
        // Position just below the clicked [?] button
        const rect = btn.getBoundingClientRect();
        popover.style.top = (window.scrollY + rect.bottom + 6) + "px";
        popover.style.left = Math.max(8, rect.left - 12) + "px";
        popover.hidden = false;
      });
    });
    document.addEventListener("click", (e) => {
      if (!popover || popover.hidden) return;
      if (e.target.closest(".skills-info-popover") || e.target.closest(".skills-info-btn")) return;
      popover.hidden = true;
    });

    async function refreshCategorized() {
      try {
        const r = await fetch("/api/skills/categorized");
        const j = await r.json();
        if (!j.ok) return;
        for (const cat of ["evy-loaded", "team-developer", "evy-authored", "project-local"]) {
          const list = j.categories[cat] || [];
          const countEl = document.getElementById("skills-count-" + cat);
          const listEl = document.getElementById("skills-list-" + cat);
          if (countEl) countEl.textContent = list.length;
          if (!listEl) continue;
          if (!list.length) {
            listEl.innerHTML = `<div class="dim small" style="padding:12px">${emptyCopyForCategory(cat)}</div>`;
            continue;
          }
          listEl.innerHTML = "";
          for (const s of list) {
            listEl.appendChild(renderSkillCard(s, cat, refreshCategorized));
          }
        }
      } catch (err) {
        console.warn("[skills-clarity] refresh failed:", err);
      }
    }

    refreshCategorized();
    // Refresh when the tab becomes visible too; auto-refresh while visible
    // catches Evy authoring or promoting a skill during the session.
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"skills\"]");
      if (panel && getComputedStyle(panel).display !== "none") refreshCategorized();
    }, 15000);
    // Expose for external triggers (e.g. SSE evy-authored-skill events)
    window.__skillsClarityRefresh = refreshCategorized;
  }

  function emptyCopyForCategory(cat) {
    if (cat === "evy-authored") return "no drafts yet — Evy hasn't authored any skills";
    if (cat === "project-local") return "no project-local skills detected (no <code>.subctl/skills/</code> in registered projects)";
    if (cat === "evy-loaded") return "no Evy-loaded skills resolved — check <code>components/skills/master/SKILL.md</code>";
    return "no skills in this bucket";
  }

  function renderSkillCard(s, category, refresh) {
    const card = document.createElement("div");
    card.className = "skill-card";
    const head = document.createElement("div");
    head.className = "skill-card-head";
    const name = document.createElement("div");
    name.className = "skill-card-name";
    name.textContent = s.name;
    head.appendChild(name);
    const scopePill = document.createElement("span");
    scopePill.className = "skill-scope-pill scope-" + (s.scope || "unknown");
    scopePill.textContent = s.scope || "?";
    head.appendChild(scopePill);
    if (s.created_by === "evy") {
      const ev = document.createElement("span");
      ev.className = "skill-scope-pill scope-evy-authored";
      ev.textContent = "by evy";
      head.appendChild(ev);
    }
    card.appendChild(head);

    if (s.description) {
      const desc = document.createElement("div");
      desc.className = "skill-card-desc";
      desc.textContent = s.description;
      card.appendChild(desc);
    }

    // Where-it's-used annotation
    const where = document.createElement("div");
    where.className = "skill-card-where dim small";
    where.innerHTML = whereCopyFor(s, category);
    card.appendChild(where);

    // Templates using this team-developer skill
    if (category === "team-developer" && Array.isArray(s.templates_using) && s.templates_using.length) {
      const tu = document.createElement("div");
      tu.className = "skill-card-templates dim small";
      tu.innerHTML = "Used by: " + s.templates_using
        .map((t) => `<code>${escapeText(t.template)}</code> (${t.roles.join(", ")})`).join(", ");
      card.appendChild(tu);
    }

    // Curation actions (Evy-authored only)
    if (category === "evy-authored") {
      const actions = document.createElement("div");
      actions.className = "skill-card-actions";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "secondary-btn";
      view.textContent = "View";
      view.addEventListener("click", () => showEvySkillBody(s.name));
      const promote = document.createElement("button");
      promote.type = "button";
      promote.className = "primary-btn";
      promote.textContent = "Promote to repo";
      promote.addEventListener("click", async () => {
        if (!confirm(`Promote '${s.name}' to components/skills/${s.name}/?\n\nThis writes the file but does NOT auto-commit — you'll review the diff in git.`)) return;
        promote.disabled = true; promote.textContent = "promoting…";
        try {
          const r = await fetch(`/api/skills/evy/${encodeURIComponent(s.name)}/promote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ promoted_by: "operator" }),
          });
          const j = await r.json();
          if (!j.ok) { alert("Promotion failed: " + (j.error || "unknown")); promote.disabled = false; promote.textContent = "Promote to repo"; return; }
          alert("Promoted → " + (j.to || ""));
          refresh && refresh();
        } catch (err) { alert("Error: " + err); promote.disabled = false; promote.textContent = "Promote to repo"; }
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger-btn";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete draft '${s.name}'? This cannot be undone.`)) return;
        del.disabled = true; del.textContent = "deleting…";
        try {
          const r = await fetch(`/api/skills/evy/${encodeURIComponent(s.name)}/delete`, { method: "POST" });
          const j = await r.json();
          if (!j.ok) { alert("Delete failed: " + (j.error || "unknown")); del.disabled = false; del.textContent = "Delete"; return; }
          refresh && refresh();
        } catch (err) { alert("Error: " + err); del.disabled = false; del.textContent = "Delete"; }
      });
      actions.appendChild(view);
      actions.appendChild(promote);
      actions.appendChild(del);
      card.appendChild(actions);
    }

    return card;
  }

  function whereCopyFor(s, category) {
    if (category === "evy-loaded") return "Loaded into Evy's master system prompt at every turn";
    if (category === "team-developer") return "Available for team templates' developer rosters";
    if (category === "evy-authored") {
      const when = s.created_at ? ` · ${new Date(s.created_at).toLocaleString()}` : "";
      return `Draft under <code>~/.local/state/subctl/evy-skills/${escapeText(s.name)}/</code>${when}`;
    }
    if (category === "project-local") {
      return `Scoped to project <code>${escapeText(s.project || "?")}</code>`;
    }
    return "";
  }

  async function showEvySkillBody(name) {
    try {
      const r = await fetch(`/api/skills/evy/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) { alert("Load failed: " + (j.error || "?")); return; }
      // Reuse a simple alert-style viewer — keeps the diff small. A
      // future iteration can plug into the existing skill-detail pane.
      const win = window.open("", "_blank", "width=720,height=600");
      if (win) {
        win.document.title = "SKILL.md — " + name;
        win.document.body.style.fontFamily = "ui-monospace, monospace";
        win.document.body.style.whiteSpace = "pre-wrap";
        win.document.body.style.padding = "16px";
        win.document.body.textContent = j.content;
      } else {
        alert(j.content);
      }
    } catch (err) { alert("Error: " + err); }
  }
  // ── end v2.8.1 skills clarity ──

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
          // v2.7.4: show both env + secrets.json signals when the row
          // has a secrets-json counterpart. Length is presented as a
          // count so the operator can confirm rotation without leaking
          // any character of the underlying credential.
          const sources = [];
          if (k.env) sources.push("env");
          if (k.secrets_json === true) sources.push("secrets.json");
          const sourceTag = sources.length ? ` [${sources.join(" + ")}]` : "";
          const detail = k.ok
            ? `set (${k.length} chars)${sourceTag}`
            : "unset · " + k.purpose;
          row.innerHTML =
            "<span class=\"mark\">" + (k.ok ? "✓" : "○") + "</span>" +
            "<span class=\"name\">" + escapeText(k.name) + "</span>" +
            "<span class=\"detail\">" + escapeText(detail) + "</span>";
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

    // v2.7.4 — API Tokens panel (secrets.json).
    //
    // SECURITY NOTES:
    //   - GET /api/settings/secrets returns presence flags only; this
    //     function never has the actual values to render or leak.
    //   - The modal's <input> is type="password" + autocomplete="new-password"
    //     so the browser doesn't surface the cleartext from a saved-password
    //     dropdown or autofill from another origin.
    //   - On Save we POST the value to the dashboard's 127.0.0.1-bound
    //     endpoint; nothing crosses the LAN. We do NOT log the value to
    //     the browser console.
    //   - On Remove we POST {value: null}. The server clears the field
    //     and returns the updated presence row.
    //   - On success we close the modal and force-clear the input value
    //     in memory before re-render so a subsequent click on Edit
    //     doesn't show the stale paste.
    async function loadSecrets() {
      const body = $("settings-secrets-body");
      if (!body) return;
      try {
        const r = await fetch("/api/settings/secrets");
        const j = await r.json();
        if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
        const purposes = {
          lmstudio_api_token: "LM Studio API auth (when 'Require API Token' is enabled — v2.7.4)",
          brave_api_key: "Brave AI Search (web_search master tool — v2.7.2)",
          firecrawl_api_key: "Firecrawl scraping (web_fetch master tool — v2.7.2)",
          tinyfish_api_key: "TinyFish search + fetch (tinyfish_* master tools — v2.7.16, free tier)",
          linear_api_key: "Linear API (linear_* master tools — v2.7.2)",
          context7_api_key: "Context7 — up-to-date library docs (master tool + MCP for dev-team Claude leads)",
          openrouter_api_key: "OpenRouter API key for accessing hundreds of models via openrouter.ai. Free tier includes many preview models. Mint at https://openrouter.ai/keys",
        };
        const table = document.createElement("table");
        table.className = "secrets-table";
        table.innerHTML =
          "<thead><tr>" +
          "<th>Key</th><th>Purpose</th><th>Status</th><th>Last modified</th><th></th>" +
          "</tr></thead>";
        const tbody = document.createElement("tbody");
        for (const s of j.secrets) {
          const tr = document.createElement("tr");
          const pillClass = s.isSet ? "pill pill-set" : "pill pill-unset";
          const pillText = s.isSet ? "Set" : "Not set";
          const envBadge = s.envOverride
            ? "<span class=\"pill pill-env\" title=\"env var overrides secrets.json per v2.7.4 priority\">env override</span>"
            : "";
          tr.innerHTML =
            "<td><code>" + escapeText(s.key) + "</code></td>" +
            "<td class=\"dim\">" + escapeText(purposes[s.key] || "") + "</td>" +
            "<td class=\"col-status\"><span class=\"" + pillClass + "\">" + pillText + "</span>" + envBadge + "</td>" +
            "<td class=\"col-modified\">" + escapeText(s.lastModified ? new Date(s.lastModified).toLocaleString() : "—") + "</td>" +
            "<td class=\"col-actions\"></td>";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "secondary-btn";
          btn.textContent = s.isSet ? "Edit" : "Set";
          btn.addEventListener("click", () => openSecretsModal(s.key));
          tr.querySelector(".col-actions").appendChild(btn);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        body.replaceChildren(table);
      } catch (err) {
        body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
      }
    }

    let _currentSecretKey = null;
    function openSecretsModal(key) {
      _currentSecretKey = key;
      const modal = $("secrets-modal");
      const valueEl = $("secrets-modal-value");
      const keyLabel = $("secrets-modal-key-label");
      const result = $("secrets-modal-result");
      if (!modal || !valueEl) return;
      keyLabel.textContent = key;
      valueEl.value = "";
      result.hidden = true;
      result.textContent = "";
      modal.hidden = false;
      // Focus the input immediately — operator just clicked Edit, they
      // want to paste. Use a microtask so the modal is actually visible
      // before we steal focus (some browsers ignore focus on hidden).
      setTimeout(() => valueEl.focus(), 0);
    }

    function closeSecretsModal() {
      const modal = $("secrets-modal");
      const valueEl = $("secrets-modal-value");
      if (modal) modal.hidden = true;
      if (valueEl) valueEl.value = ""; // wipe any pasted token from DOM
      _currentSecretKey = null;
    }

    async function submitSecretsModal(value) {
      if (!_currentSecretKey) return;
      const result = $("secrets-modal-result");
      result.hidden = false;
      result.textContent = "saving…";
      try {
        const r = await fetch(
          "/api/settings/secrets/" + encodeURIComponent(_currentSecretKey),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          },
        );
        const j = await r.json();
        if (!j.ok) {
          result.textContent = "error: " + (j.error || "?");
          return;
        }
        // Wipe input + close, then refresh both panels (the api-keys
        // panel shows the combined env+secrets.json signal and must
        // re-fetch too).
        closeSecretsModal();
        loadSecrets();
        loadKeys();
      } catch (err) {
        result.textContent = "error: " + String(err);
      }
    }

    function wireSecretsModal() {
      const saveBtn = $("secrets-modal-save");
      const cancelBtn = $("secrets-modal-cancel");
      const removeBtn = $("secrets-modal-remove");
      const valueEl = $("secrets-modal-value");
      if (!saveBtn || !cancelBtn || !removeBtn || !valueEl) return;
      // Only bind once. wireSecretsModal is called from the same
      // entry point that calls refreshAll, so the listeners would
      // double-bind on a refresh otherwise.
      if (saveBtn.dataset.wired === "1") return;
      saveBtn.dataset.wired = "1";
      saveBtn.addEventListener("click", () => {
        const v = valueEl.value;
        if (!v) {
          $("secrets-modal-result").hidden = false;
          $("secrets-modal-result").textContent = "value is empty — use Remove to clear";
          return;
        }
        submitSecretsModal(v);
      });
      cancelBtn.addEventListener("click", closeSecretsModal);
      removeBtn.addEventListener("click", () => {
        if (!confirm("Remove this token from secrets.json? Tools relying on it will fall back to the env var (if set) or report 'not configured'.")) return;
        submitSecretsModal(null);
      });
      // Enter on the input → save
      valueEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBtn.click();
        } else if (e.key === "Escape") {
          closeSecretsModal();
        }
      });
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
            cmd.title = `click to copy — run this on ${HOST_LABEL} (ssh ${SSH_HOST_ALIAS})`;
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
            result.textContent = "✓ saved · " + (j.exists ? "vault exists" : `path saved but vault dir doesn't exist yet — create it on ${HOST_LABEL}`);
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

    // ── Personality preset tile (Phase 3k UI, v2.5.7) ──────────────────
    // Hits /api/master/personality (GET = list + active, POST = swap).
    // Hot-swap takes effect on next prompt — no daemon restart.
    async function loadPersonality() {
      const sel = $("personality-select");
      const active = $("settings-personality-active");
      const preview = $("personality-preview");
      if (!sel) return;
      try {
        const r = await fetch("/api/master/personality");
        const j = await r.json();
        if (!j.ok) {
          sel.innerHTML = "<option value=''>master unreachable</option>";
          if (active) active.textContent = "—";
          return;
        }
        sel.innerHTML = (j.presets || []).map((p) =>
          `<option value="${escapeText(p.id)}" ${p.id === j.active ? "selected" : ""}>${escapeText(p.id)}</option>`
        ).join("");
        if (active) active.textContent = `active: ${j.active || "—"}`;
        // Show preview text for the currently-selected preset
        const updatePreview = () => {
          const cur = (j.presets || []).find((p) => p.id === sel.value);
          if (preview) preview.textContent = cur ? cur.preview : "";
        };
        sel.removeEventListener("change", sel._previewHandler);
        sel._previewHandler = updatePreview;
        sel.addEventListener("change", updatePreview);
        updatePreview();
      } catch (err) {
        sel.innerHTML = "<option value=''>error</option>";
        if (active) active.textContent = String(err).slice(0, 60);
      }
    }
    const personalityApply = $("personality-apply");
    if (personalityApply) {
      personalityApply.addEventListener("click", async () => {
        const sel = $("personality-select");
        const pick = sel && sel.value;
        if (!pick) return;
        personalityApply.disabled = true;
        try {
          const r = await fetch("/api/master/personality", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preset: pick }),
          });
          const j = await r.json();
          if (!j.ok) {
            if (window.notice && window.notice.error) {
              window.notice.error("Personality switch failed", j.error || `HTTP ${r.status}`);
            } else {
              alert(j.error || `HTTP ${r.status}`);
            }
            return;
          }
          await loadPersonality();
          if (window.notice) {
            window.notice("Personality applied", `Master voice → ${j.active}. Takes effect on the next prompt.`);
          }
        } finally {
          personalityApply.disabled = false;
        }
      });
    }

    function refreshAll() {
      loadHealth();
      loadKeys();
      loadSecrets();
      loadOAuth();
      loadTelegramStatus();
      loadVault();
      loadPersonality();
    }
    wireSecretsModal();
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
            const wired = p.wired !== false; // default-true for legacy entries
            const state = !wired ? "not yet wired" : (p.available ? "ready" : "not authed");
            const model = p.default_model || "?";
            const value = `${p.id}|${model}`;
            const isCurrent = supervisor === `${p.id}/${model}`;
            const disabledAttr = !wired ? " disabled" : "";
            const noteAttr = !wired && p.wired_note ? ` title="${escapeText(p.wired_note)}"` : "";
            html += `<option value="${escapeText(value)}"${disabledAttr}${noteAttr} ${isCurrent ? "selected" : ""}>${dot}  ${escapeText(p.display)} · ${escapeText(model)} · ${state}</option>`;
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

  // ----- Supervisor profile pill (v2.7.18) -----
  // The pill sits inside .master-chat-header next to the Evy h2 and
  // shows / toggles the active supervisor profile. Two profiles for
  // now: "chat" (gemma — fast, conversational) and "heavy" (qwen —
  // deep reasoning, slower, occasionally loops). Click toggles to the
  // other; POST /api/profile lands on the master daemon's profiles.json
  // and the swap takes effect on the next prompt. We piggyback on the
  // existing SSE stream so the pill updates instantly when something
  // else (Telegram /profile, another tab, manual edit) flips it.
  function wireProfilePill() {
    const pill = $("profile-pill");
    const valueEl = $("profile-pill-value");
    if (!pill || !valueEl) return;
    let known = ["chat", "heavy"];
    let active = null;
    let inFlight = false;

    function paint(next) {
      active = next;
      valueEl.textContent = next;
      pill.dataset.active = next;
      pill.hidden = false;
      pill.removeAttribute("data-error");
    }
    function flashError() {
      pill.dataset.error = "true";
      setTimeout(() => pill.removeAttribute("data-error"), 1500);
    }

    async function refresh() {
      try {
        const r = await fetch("/api/profile");
        const j = await r.json();
        if (j && j.ok) {
          if (Array.isArray(j.profiles) && j.profiles.length) known = j.profiles;
          if (typeof j.active === "string") paint(j.active);
        }
      } catch {
        /* master unreachable — leave pill hidden */
      }
    }

    async function toggle() {
      if (inFlight || !active) return;
      const next = active === "chat" ? "heavy" : "chat";
      inFlight = true;
      pill.dataset.pending = "true";
      // Optimistic update so the click feels immediate. Reconciled
      // below with the server's response.
      const prev = active;
      paint(next);
      try {
        const r = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: next }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j || !j.ok) {
          paint(prev);
          flashError();
          if (window.notice && window.notice.error) {
            window.notice.error("Profile swap failed", (j && j.error) || ("HTTP " + r.status));
          }
        } else if (typeof j.active === "string") {
          paint(j.active);
          if (window.notice) {
            window.notice("Profile swapped", `Master will use the ${j.active} profile on the next prompt.`);
          }
        }
      } catch (err) {
        paint(prev);
        flashError();
        if (window.notice && window.notice.error) {
          window.notice.error("Profile swap error", String(err));
        }
      } finally {
        pill.removeAttribute("data-pending");
        inFlight = false;
      }
    }
    pill.addEventListener("click", toggle);

    // Initial load + 30s poll fallback. We also piggyback on the
    // existing /api/master/events SSE so out-of-band swaps (Telegram
    // /profile, manual file edit, another tab) reflect immediately.
    refresh();
    setInterval(refresh, 30_000);
    try {
      const es = new EventSource("/api/master/events");
      es.addEventListener("profile_swapped", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d && typeof d.to === "string") paint(d.to);
        } catch { /* ignore */ }
      });
      // Don't reconnect on error here — the chat panel's connectSSE()
      // already owns the canonical lifecycle. This is a quiet observer.
    } catch { /* EventSource unavailable; poll-only fallback is fine */ }
  }

  // ----- Vault viewer (Phase 3n) — in-browser Obsidian-flavoured browser ---
  function wireVaultTab() {
    const select = $("vault-root-select");
    const tree = $("vault-tree");
    const content = $("vault-content");
    if (!select || !tree || !content) return;

    let currentVault = null;
    let currentNote = null;        // {path, ...}
    let noteIndex = new Set();     // set of all known note paths for wikilink resolution

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    // Resolve a wikilink target to an actual note path in the vault.
    // Try exact match first ("Down-Time-Arena/decisions" or with .md),
    // then any path whose final segment matches case-insensitively.
    function resolveWikilink(target) {
      const t = target.trim();
      const candidates = [t, `${t}.md`];
      for (const c of candidates) {
        if (noteIndex.has(c)) return c;
      }
      const tLower = t.toLowerCase().replace(/\.md$/, "");
      for (const p of noteIndex) {
        const last = p.replace(/^.*\//, "").replace(/\.md$/, "").toLowerCase();
        if (last === tLower) return p;
      }
      return null; // missing
    }

    function renderTree(nodes, container, depth) {
      for (const n of nodes) {
        if (n.kind === "dir") {
          const div = document.createElement("div");
          div.className = "vault-tree-dir";
          div.innerHTML = `<div class="dir-label">${esc(n.name)}</div><div class="dir-children"></div>`;
          const label = div.querySelector(".dir-label");
          const children = div.querySelector(".dir-children");
          label.addEventListener("click", () => div.classList.toggle("open"));
          renderTree(n.children, children, depth + 1);
          // Auto-open first 2 levels for discoverability.
          if (depth < 2) div.classList.add("open");
          container.appendChild(div);
        } else if (n.kind === "note") {
          const a = document.createElement("a");
          a.className = "vault-tree-note";
          a.textContent = n.name;
          a.setAttribute("data-path", n.path);
          a.addEventListener("click", (e) => {
            e.preventDefault();
            void openNote(n.path);
          });
          container.appendChild(a);
          noteIndex.add(n.path);
        }
      }
    }

    async function loadVaults() {
      try {
        const r = await fetch("/api/vault/roots");
        const j = await r.json();
        if (!j.ok) {
          tree.innerHTML = `<div class="dim small">error: ${esc(j.error || "unknown")}</div>`;
          return;
        }
        const vaults = j.vaults || [];
        select.innerHTML = vaults.length === 0
          ? `<option value="">(no vaults found — run \`subctl install\` to bootstrap)</option>`
          : vaults.map((v) => `<option value="${esc(v.slug)}">${esc(v.name)} · ${v.note_count} notes</option>`).join("");
        if (vaults.length > 0) {
          // Honor #vault?root=...&path=... hash for deep-linking.
          const hashMatch = location.hash.match(/^#vault\?(.*)$/);
          let targetRoot = null;
          let targetPath = null;
          if (hashMatch) {
            const params = new URLSearchParams(hashMatch[1]);
            targetRoot = params.get("root");
            targetPath = params.get("path");
          }
          const pick = vaults.find((v) => v.slug === targetRoot) || vaults[0];
          select.value = pick.slug;
          await openVault(pick.slug);
          if (targetPath) void openNote(targetPath);
        }
      } catch (err) {
        tree.innerHTML = `<div class="dim small">fetch error: ${esc(String(err))}</div>`;
      }
    }

    async function openVault(slug) {
      currentVault = slug;
      currentNote = null;
      noteIndex = new Set();
      tree.innerHTML = `<div class="dim small">loading tree…</div>`;
      try {
        const r = await fetch(`/api/vault/${encodeURIComponent(slug)}/tree`);
        const j = await r.json();
        if (!j.ok) {
          tree.innerHTML = `<div class="dim small">error: ${esc(j.error || "unknown")}</div>`;
          return;
        }
        if (!j.tree || j.tree.length === 0) {
          tree.innerHTML = `<div class="dim small">(empty vault — write a note via the master and refresh)</div>`;
          return;
        }
        tree.innerHTML = "";
        renderTree(j.tree, tree, 0);
      } catch (err) {
        tree.innerHTML = `<div class="dim small">fetch error: ${esc(String(err))}</div>`;
      }
    }

    function setActiveTreeRow(path) {
      for (const el of tree.querySelectorAll(".vault-tree-note.active")) {
        el.classList.remove("active");
      }
      const el = tree.querySelector(`.vault-tree-note[data-path="${CSS.escape(path)}"]`);
      if (el) {
        el.classList.add("active");
        // Expand all ancestor dirs.
        let p = el.parentElement;
        while (p) {
          if (p.classList && p.classList.contains("vault-tree-dir")) p.classList.add("open");
          p = p.parentElement;
        }
      }
    }

    async function openNote(path) {
      if (!currentVault) return;
      currentNote = { path };
      setActiveTreeRow(path);
      // Update the URL hash so the view is bookmarkable / shareable.
      try { history.replaceState(null, "", `#vault?root=${encodeURIComponent(currentVault)}&path=${encodeURIComponent(path)}`); } catch {}
      content.innerHTML = `<div class="dim small">loading…</div>`;
      try {
        const r = await fetch(`/api/vault/${encodeURIComponent(currentVault)}/note?path=${encodeURIComponent(path)}`);
        const j = await r.json();
        if (!j.ok) {
          content.innerHTML = `<div class="vault-empty"><h3>Note not found</h3><p>${esc(j.error || "")}</p></div>`;
          return;
        }
        renderNote(j);
      } catch (err) {
        content.innerHTML = `<div class="vault-empty"><h3>Fetch error</h3><p>${esc(String(err))}</p></div>`;
      }
    }

    function renderNote(noteData) {
      // Pre-render transforms — Obsidian-flavoured syntax that vanilla
      // Marked doesn't know about.
      let md = noteData.body || "";

      // 1. Wikilink + embed placeholders. Replace BEFORE markdown parse so
      //    the parser doesn't mangle the syntax. Use opaque placeholders
      //    that we re-substitute after parse.
      const wikilinks = []; // {placeholder, target, alias, embed}
      md = md.replace(/!?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target, alias) => {
        const embed = _m.startsWith("!");
        const id = `__WL_${wikilinks.length}__`;
        wikilinks.push({ placeholder: id, target: target.trim(), alias: alias?.trim() || null, embed });
        return id;
      });

      // 2. Callout blocks: `> [!note] Title\n> body` → render as styled
      //    blockquote. Detect by leading line then attach a class.
      md = md.replace(/^> \[!(\w+)\]\s*(.*?)$/gm, (_m, kind, title) => {
        return `> ‌ CALLOUT_${kind}_START ${title}`;
      });

      // 3. Render markdown via Marked.
      let html;
      try {
        html = window.marked.parse(md, { breaks: false, gfm: true });
      } catch (err) {
        content.innerHTML = `<div class="vault-empty"><h3>Render error</h3><p>${esc(String(err))}</p></div>`;
        return;
      }

      // 4. Resubstitute wikilinks as anchors.
      for (const wl of wikilinks) {
        const resolved = resolveWikilink(wl.target);
        const label = wl.alias || wl.target;
        let replacement;
        if (wl.embed) {
          // Image embed: if target ends with image ext, use <img>, else fall back to text link.
          const lower = wl.target.toLowerCase();
          if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) {
            const assetUrl = `/api/vault/${encodeURIComponent(currentVault)}/asset?path=${encodeURIComponent(wl.target)}`;
            replacement = `<img src="${esc(assetUrl)}" alt="${esc(wl.target)}">`;
          } else if (resolved) {
            // Embedded note — render placeholder, click to navigate.
            replacement = `<a class="vault-wikilink" href="#" data-target="${esc(resolved)}">${esc(label)} ↵</a>`;
          } else {
            replacement = `<span class="vault-wikilink-missing">![[${esc(wl.target)}]]</span>`;
          }
        } else if (resolved) {
          replacement = `<a class="vault-wikilink" href="#" data-target="${esc(resolved)}">${esc(label)}</a>`;
        } else {
          replacement = `<a class="vault-wikilink vault-wikilink-missing" href="#" data-missing="${esc(wl.target)}">${esc(label)}</a>`;
        }
        html = html.replace(wl.placeholder, replacement);
      }

      // 5. Callout block class fixup.
      html = html.replace(/<blockquote>\s*<p>‌ CALLOUT_(\w+)_START\s*([^<]*)<\/p>([\s\S]*?)<\/blockquote>/g,
        (_m, kind, title, body) => {
          const k = kind.toLowerCase();
          const klass = k === "warning" || k === "warn" || k === "caution"
            ? "vault-callout callout-warning"
            : k === "danger" || k === "error" || k === "fail"
            ? "vault-callout callout-danger"
            : "vault-callout callout-note";
          const titleHtml = title.trim()
            ? `<span class="callout-title">${esc(title.trim())}</span>`
            : `<span class="callout-title">${esc(kind)}</span>`;
          return `<blockquote class="${klass}">${titleHtml}${body}</blockquote>`;
        });

      // 6. Tag rendering: any `#tag` outside code blocks → styled span.
      //    Simple heuristic — replace inside text nodes only via a regex
      //    that avoids URLs and headings.
      html = html.replace(/(^|[\s>])#([a-zA-Z][\w/-]*)/g, (_m, prev, tag) => {
        return `${prev}<span class="vault-tag">#${esc(tag)}</span>`;
      });

      // Render metadata + body.
      const fm = noteData.frontmatter || null;
      const meta = `<div class="vault-note-meta">
        <div class="meta-title">${esc(noteData.path)}</div>
        ${fm
          ? Object.entries(fm).map(([k, v]) => `<span class="meta-kv"><span class="meta-key">${esc(k)}:</span><span class="meta-val">${esc(v)}</span></span>`).join(" ")
          : ""
        }
        <span class="meta-kv"><span class="meta-key">size:</span><span class="meta-val">${noteData.size} B</span></span>
        <span class="meta-kv"><span class="meta-key">mtime:</span><span class="meta-val">${esc(noteData.mtime ? new Date(noteData.mtime).toLocaleString() : "—")}</span></span>
      </div>`;

      content.innerHTML = meta + `<div class="vault-note-body">${html}</div>`;

      // Wire wikilink clicks.
      for (const a of content.querySelectorAll(".vault-wikilink[data-target]")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const target = a.getAttribute("data-target");
          if (target) void openNote(target);
        });
      }
    }

    select.addEventListener("change", () => {
      if (select.value) void openVault(select.value);
    });

    // Wait for marked.js to load before activating.
    function ready() {
      if (window.marked && typeof window.marked.parse === "function") {
        void loadVaults();
      } else {
        setTimeout(ready, 50);
      }
    }
    // Only load when the tab first becomes visible (saves boot cost).
    // ALSO re-checks the hash on every tab activation so deep-links from
    // outside (e.g. Projects → "Open in Vault Viewer") navigate even when
    // the vault is already loaded.
    function checkActive() {
      const isActive = document.body.getAttribute("data-active-tab") === "vault";
      if (!isActive) return;
      if (!currentVault) {
        ready();
        return;
      }
      // Already loaded — honor any new hash deep-link.
      const hashMatch = location.hash.match(/^#vault\?(.*)$/);
      if (!hashMatch) return;
      const params = new URLSearchParams(hashMatch[1]);
      const reqRoot = params.get("root");
      const reqPath = params.get("path");
      if (reqRoot && reqRoot !== currentVault) {
        void openVault(reqRoot).then(() => { if (reqPath) void openNote(reqPath); });
      } else if (reqPath && (!currentNote || currentNote.path !== reqPath)) {
        void openNote(reqPath);
      }
    }
    new MutationObserver(checkActive).observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
    checkActive();

    // Expose a global navigation helper so other tabs (e.g. Projects) can
    // route the user to a specific note. Sets the hash, switches to the
    // Vault tab, lets checkActive() pick up the navigation.
    window.openVaultDeepLink = function(root, path) {
      const r = encodeURIComponent(root || "master");
      const p = encodeURIComponent(path || "");
      try {
        history.replaceState(null, "", `#vault?root=${r}&path=${p}`);
      } catch {}
      const navBtn = document.querySelector('.nav-btn[data-tab="vault"]');
      if (navBtn) navBtn.click();
      else checkActive(); // fallback if nav button isn't found
    };
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
  wireWatchdogPanel();

  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- tmux preview modal ----------
  // Shared between the orchestration cockpit cards and the dashboard
  // Dev Teams panel. Polls /api/orchestration/<name> every 2s while open
  // and renders the captured pane content.
  let _tmuxPollTimer = null;
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
  // Expose for the legacy Dev Teams panel renderer + anything else that
  // wants to surface these affordances on a row.
  window.__subctlOpenTmuxPreview = openTmuxPreview;
  window.__subctlCopyAttachCommand = copyAttachCommand;

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
  window.__subctlOpenWebTerminal = openWebTerminal;

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
  // Hoist for the boot block above (it references this before declaration).
  window.__subctlWireWebTerminalGate = wireWebTerminalGate;

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
      m.innerHTML = `<div class="pd-chat-label">evy</div><div class="pd-chat-body"></div>`;
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
            // v2.7.12: render as a neon pill in the same row as sibling
            // pills from this turn (wraps naturally). No more full-width
            // tool-card eating 60% of the panel.
            const row = ensureChatToolPillsRow(logEl);
            const pill = renderToolPill({ name: tc.name, args: tc.arguments });
            row.appendChild(pill);
            toolBubbles.set(tc.id, pill);
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
      } catch {}
    });
    es.addEventListener("tool_result", (e) => {
      // Attach result + ok/err marker to the pill spawned by toolcall_start.
      if (!active) return;
      try {
        const d = JSON.parse(e.data);
        const pill = toolBubbles.get(d.toolCallId);
        if (!pill) return;
        const ok = !d.error;
        pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
        const result = d.error || (d.content && d.content[0] && d.content[0].text) || d.content;
        if (result != null) {
          pill.dataset.result = (typeof result === "string") ? result : JSON.stringify(result);
        }
      } catch {}
    });
    es.addEventListener("agent_end", () => { cleanup(); });
    es.addEventListener("error", () => { setTimeout(cleanup, 1000); });
    // Safety timeout — if nothing happens within 90s, give up (in case the
    // user never receives an assistant turn for any reason).
    setTimeout(cleanup, 90000);
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
        `<div class="team-row"><strong>${escapeText(t.name)}</strong> <span class="dim small">${t.attached ? "operator attached" : "running · headless"}</span></div>`,
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
              <button type="button" class="secondary-btn" data-action="open-vault">Open in Vault Viewer</button>
              ${p.github_repo ? `<a class="secondary-btn" href="https://github.com/${escapeText(p.github_repo)}" target="_blank">Open on GitHub</a>` : ""}
              <!-- ── v2.7.34 policy UI: per-project Apply-preset dropdown ── -->
              <span class="project-apply-preset" data-action="apply-preset-host">
                <select class="project-apply-preset-select" data-project="${escapeText(p.path)}">
                  <option value="">Apply preset…</option>
                </select>
              </span>
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
        // Project's vault subdir is <vault_root>/master/<project_name>/.
        // Open the Vault tab and try to land on decisions.md by default;
        // if the file doesn't exist yet, the viewer just shows the tree.
        const target = `${p.name}/decisions.md`;
        if (typeof window.openVaultDeepLink === "function") {
          window.openVaultDeepLink("master", target);
        } else {
          // Fallback if vault tab wiring didn't load
          location.hash = `#vault?root=master&path=${encodeURIComponent(target)}`;
          const navBtn = document.querySelector('.nav-btn[data-tab="vault"]');
          if (navBtn) navBtn.click();
        }
      });

      // ── v2.7.34 policy UI: per-project Apply-preset dropdown wiring ──
      const presetSelect = detailEl.querySelector(".project-apply-preset-select");
      if (presetSelect) {
        // Populate options from /api/policy/presets. Cached on window.
        if (!window.__policyPresetsCache) {
          window.__policyPresetsCache = fetch("/api/policy/presets")
            .then((r) => r.json())
            .then((j) => (j && j.ok && Array.isArray(j.presets)) ? j.presets : [])
            .catch(() => []);
        }
        window.__policyPresetsCache.then((presets) => {
          for (const name of presets) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            presetSelect.appendChild(opt);
          }
        });
        presetSelect.addEventListener("change", async () => {
          const preset = presetSelect.value;
          if (!preset) return;
          const ok = confirm(
            `Apply preset "${preset}" to project "${p.name}"?\n\n` +
            `This writes ${p.path}/.subctl/policy.toml with:\n\n  preset = "${preset}"\n\n` +
            `Future workers spawned for this project pick it up on next spawn.`,
          );
          if (!ok) { presetSelect.value = ""; return; }
          try {
            const r = await fetch("/api/policy/preset/" + encodeURIComponent(p.path), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ preset }),
            });
            const j = await r.json();
            if (j && j.ok) {
              alert(`Applied preset "${preset}" to ${p.name}.\nWrote ${j.bytes} bytes to ${j.path}.`);
            } else {
              alert("Apply failed: " + ((j && j.error) || r.status));
            }
          } catch (err) {
            alert("Apply error: " + err);
          } finally {
            presetSelect.value = "";
          }
        });
      }
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
  // Tier-1 memory: user.md + memory.md editors. Master also writes these
  // via memory_remember / memory_user_update tool calls; this is the
  // operator-facing edit surface.
  function wireTier1MemoryCards() {
    const userTa = $("user-md-textarea");
    const memTa = $("memory-md-textarea");
    const userMeta = $("user-md-meta");
    const memMeta = $("memory-md-meta");
    const userResult = $("user-md-result");
    const memResult = $("memory-md-result");
    if (!userTa || !memTa) return;

    function updateMeta(meta, used, limit) {
      if (!meta) return;
      meta.textContent = `${used} / ${limit} chars`;
      meta.classList.toggle("warn", used > limit * 0.7 && used <= limit);
      meta.classList.toggle("crit", used > limit);
    }

    async function load() {
      try {
        const r = await fetch("/api/memory/tier1");
        const j = await r.json();
        if (!j.ok) return;
        userTa.value = j.user_profile?.content || "";
        memTa.value = j.memory?.content || "";
        updateMeta(userMeta, userTa.value.length, j.user_profile?.char_limit || 1375);
        updateMeta(memMeta, memTa.value.length, j.memory?.char_limit || 2200);
      } catch { /* silent — endpoint may not be deployed yet */ }
    }
    load();

    userTa.addEventListener("input", () => updateMeta(userMeta, userTa.value.length, 1375));
    memTa.addEventListener("input", () => updateMeta(memMeta, memTa.value.length, 2200));

    async function save(which) {
      const ta = which === "user" ? userTa : memTa;
      const result = which === "user" ? userResult : memResult;
      try {
        const r = await fetch("/api/memory/tier1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ which, content: ta.value }),
        });
        const j = await r.json();
        if (!j.ok) {
          result.className = "memory-card-result err";
          result.textContent = "✗ " + (j.error || "save failed");
        } else {
          result.className = "memory-card-result ok";
          result.textContent = "✓ saved · master will see it on next prompt";
          setTimeout(() => { result.textContent = ""; }, 4000);
        }
      } catch (err) {
        result.className = "memory-card-result err";
        result.textContent = "✗ " + err;
      }
    }
    document.querySelectorAll("[data-mem-save]").forEach((btn) => {
      btn.addEventListener("click", () => save(btn.dataset.memSave));
    });

    // Refresh from disk every 15s while the Memory tab is visible — picks
    // up master's own memory_remember writes without operator action.
    setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"memory\"]");
      if (panel && getComputedStyle(panel).display !== "none") load();
    }, 15000);
  }

  function wireMemoryTab() {
    const status = $("memory-status");
    const content = $("memory-content");
    if (!content) return;
    wireTier1MemoryCards();

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
              `<h3>Obsidian is not installed on ${escapeForHtml(HOST_LABEL)}</h3>` +
              `<p>The master's long-term memory lives in Obsidian vaults — project portfolios, decisions, RESUME.md per project, references that survive across sessions. Install on ${escapeForHtml(HOST_LABEL)}:</p>` +
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

    // v2.7.23 — wire the Evy Memory (Tier 3) card. Lives in the same Memory
    // tab but pulls from /api/memory/recent + /api/memory/search.
    wireEvyMemoryCard();
  }

  // v2.7.23 — Evy Memory (Tier 3) dashboard wiring. Conversational memory
  // captured at master turn boundaries; queryable via FTS5. See ADR 0014.
  function wireEvyMemoryCard() {
    const card = $("evy-memory-card");
    if (!card) return;
    const list = $("evy-mem-list");
    const meta = $("evy-mem-meta");
    const search = $("evy-mem-search");
    const kindSel = $("evy-mem-kind");
    const searchBtn = $("evy-mem-search-btn");
    const refreshBtn = $("evy-mem-refresh-btn");
    if (!list) return;

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function renderEntries(entries) {
      if (!entries || entries.length === 0) {
        list.innerHTML = "<p class=\"dim\">(no entries)</p>";
        return;
      }
      const rows = entries
        .map((e) => {
          const when = (e.ts || "").slice(0, 10) + " " + (e.ts || "").slice(11, 16);
          const team = e.team_id ? `<span class="evy-mem-team">@${esc(e.team_id)}</span>` : "";
          return (
            `<div class="evy-mem-item" data-id="${esc(e.id)}">` +
              `<div class="evy-mem-head">` +
                `<span class="evy-mem-when">${esc(when)}</span> ` +
                `<span class="evy-mem-role">${esc(e.role)}</span>` +
                `<span class="evy-mem-kind">${esc(e.kind)}</span>` +
                team +
                `<button type="button" class="evy-mem-del" data-id="${esc(e.id)}" title="forget this entry">✕</button>` +
              `</div>` +
              `<div class="evy-mem-body">${esc(e.content)}</div>` +
            `</div>`
          );
        })
        .join("");
      list.innerHTML = rows;
      list.querySelectorAll(".evy-mem-del").forEach((btn) => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const id = btn.getAttribute("data-id");
          if (!id) return;
          if (!confirm("Forget this memory entry?")) return;
          try {
            const r = await fetch(`/api/memory/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
            if (r.ok || r.status === 404) loadRecent();
          } catch (err) {
            console.error("[evy-mem] delete failed", err);
          }
        });
      });
    }

    async function loadStats() {
      try {
        const r = await fetch("/api/memory/stats");
        const j = await r.json();
        if (!j.ok || !j.stats) return;
        const s = j.stats;
        const sizeKb = Math.round((s.bytes || 0) / 1024);
        meta.textContent = `${s.count} entries · ${sizeKb} KB · fts5=${s.fts5 ? "on" : "off"}`;
      } catch {
        meta.textContent = "— entries";
      }
    }

    async function loadRecent() {
      list.innerHTML = "<p class=\"dim\">loading…</p>";
      try {
        const r = await fetch("/api/memory/recent?limit=25");
        const j = await r.json();
        if (!j.ok) {
          list.innerHTML = "<p class=\"dim\">unreachable</p>";
          return;
        }
        renderEntries(j.entries || []);
        loadStats();
      } catch (err) {
        list.innerHTML = `<p class="dim">fetch error: ${esc(err)}</p>`;
      }
    }

    async function runSearch() {
      const q = (search.value || "").trim();
      const k = (kindSel.value || "").trim();
      const params = new URLSearchParams();
      if (q) params.set("query", q);
      if (k) params.set("kind", k);
      params.set("limit", "50");
      list.innerHTML = "<p class=\"dim\">searching…</p>";
      try {
        const r = await fetch(`/api/memory/search?${params.toString()}`);
        const j = await r.json();
        if (!j.ok) {
          list.innerHTML = "<p class=\"dim\">unreachable</p>";
          return;
        }
        renderEntries(j.entries || []);
      } catch (err) {
        list.innerHTML = `<p class="dim">fetch error: ${esc(err)}</p>`;
      }
    }

    if (searchBtn) searchBtn.addEventListener("click", runSearch);
    if (refreshBtn) refreshBtn.addEventListener("click", loadRecent);
    if (search) {
      search.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          runSearch();
        }
      });
    }
    if (kindSel) kindSel.addEventListener("change", runSearch);

    loadRecent();
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
              block.innerHTML = `<div class="master-msg-label">evy</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            }
            // v2.7.12: tool calls render as inline neon pills grouped per
            // assistant turn (one .chat-tool-pills row per turn). Multiple
            // tool calls in the same turn share the row. The toolResult
            // role (next branch) patches in the ✓/✗ marker.
            const toolCalls = (m.content || []).filter((b) => b.type === "toolCall");
            if (toolCalls.length > 0) {
              const row = document.createElement("div");
              row.className = "chat-tool-pills";
              for (const tc of toolCalls) {
                const pill = renderToolPill({ name: tc.name || "tool", args: tc.arguments });
                pill.dataset.tcid = tc.id || "";
                row.appendChild(pill);
              }
              log.appendChild(row);
            }
          } else if (m.role === "toolResult") {
            // Walk back through the log to find the pill with matching id
            // and attach the result marker. Best-effort — old transcripts
            // may have results without a matching pill if the assistant
            // turn was clipped.
            const tcid = m.toolCallId || (m.content && m.content[0] && m.content[0].toolCallId);
            if (tcid) {
              const pill = log.querySelector(`.chat-tool-pill[data-tcid="${cssEscape(String(tcid))}"]`);
              if (pill) {
                const ok = !m.error;
                pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
                const resultText = (m.content || []).map((b) => b.text).filter(Boolean).join("\n");
                if (resultText) pill.dataset.result = resultText;
              }
            }
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
    // v2.7.3: read both /context (for the meter pill) and /transcript/util
    // (for the four-state banner). The banner now reflects the SAME policy
    // the master daemon enforces just-in-time — so we never disagree about
    // when to fire.
    async function refreshContext() {
      try {
        const [ctxR, utilR] = await Promise.all([
          fetch("/api/master/context").then((r) => r.json()).catch(() => null),
          fetch("/api/master/transcript/util").then((r) => r.json()).catch(() => null),
        ]);
        if (ctxR && ctxR.ok && ctxFill && ctxLabel) {
          const pct = ctxR.utilization_pct;
          if (typeof pct === "number") {
            ctxFill.style.width = Math.min(100, pct) + "%";
            ctxFill.classList.toggle("warn", pct >= 60 && pct < 85);
            ctxFill.classList.toggle("crit", pct >= 85);
          }
          const total = ctxR.estimated_total_tokens;
          const cap = ctxR.loaded_context_length;
          ctxLabel.textContent = cap
            ? `ctx ${total.toLocaleString()} / ${cap.toLocaleString()} tok (${pct ?? "?"}%)`
            : `ctx ~${total.toLocaleString()} tok`;
        }
        // ── 4-state banner (v2.7.3) ────────────────────────────────────
        // OK              → banner hidden
        // YELLOW WARN     → between warn_tokens and compact_tokens
        // BLUE COMPACTING → compact event in flight (transient; cleared by SSE)
        // RED OVERFLOW    → past loaded_ctx (should be impossible if JIT
        //                   gate is healthy — kept as fail-safe)
        const banner = $("ctx-overflow-banner");
        if (!banner) return;
        // Don't fight an in-flight compacting state set by the SSE handler.
        if (banner.dataset.state === "compacting") return;
        if (!utilR || !utilR.ok) {
          banner.hidden = true;
          return;
        }
        const decision = utilR.decision || {};
        const action = decision.action;
        const current = utilR.current_tokens || 0;
        const compactAt = utilR.compact_at;
        const warnAt = utilR.warn_at;
        const cap = utilR.loaded_ctx;
        const pct = utilR.util_pct;

        // Real overflow — past loaded_ctx. Should be impossible with JIT
        // working, but if it ever happens we shout the loudest.
        if (cap && typeof pct === "number" && pct >= 100) {
          banner.hidden = false;
          banner.dataset.state = "overflow";
          banner.innerHTML =
            '<strong>Context overflow</strong> — current ~<span>' + current.toLocaleString() + '</span> tok ' +
            'vs loaded ctx <span>' + cap.toLocaleString() + '</span> tok (' + pct + '%). ' +
            'JIT compact gate should have prevented this. <strong>Compact now.</strong>' +
            '<div class="ctx-overflow-actions">' +
            '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
            '</div>';
          rewireBannerButton();
          return;
        }
        if (action === "compact") {
          // Master is about to fire compact (or did, between poll and read).
          banner.hidden = false;
          banner.dataset.state = "warn-compact";
          banner.innerHTML =
            '<strong>Auto-compact firing</strong> — current ~<span>' + current.toLocaleString() + '</span> tok ' +
            'crossed compact threshold <span>' + (compactAt || 0).toLocaleString() + '</span>. ' +
            'The supervisor will compact before the next prompt.';
          return;
        }
        if (action === "warn") {
          banner.hidden = false;
          banner.dataset.state = "warn";
          const compactText = compactAt
            ? compactAt.toLocaleString() + " tok"
            : (cap ? (cap + " tok loaded ctx") : "the compact threshold");
          banner.innerHTML =
            '<strong>Transcript approaching compact threshold</strong> — current ~<span>' + current.toLocaleString() + '</span> tok' +
            (warnAt ? ' (warn at <span>' + warnAt.toLocaleString() + '</span>, ' : ' (') +
            'auto-compact at <span>' + compactText + '</span>). ' +
            'Compact now to keep the supervisor responsive.' +
            '<div class="ctx-overflow-actions">' +
            '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
            '</div>';
          rewireBannerButton();
          return;
        }
        // action === "ok"
        banner.hidden = true;
        banner.dataset.state = "ok";
      } catch { /* silent */ }
    }
    // The compact button inside the banner is rewritten on each render
    // (innerHTML), so the original event binding made at boot is lost when
    // the banner repaints. Rebind it after every render.
    function rewireBannerButton() {
      const btn = $("ctx-overflow-compact");
      if (btn && !btn.dataset.boundCompact) {
        btn.addEventListener("click", () => runCompact("banner"));
        btn.dataset.boundCompact = "1";
      }
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
        // Server returns ok:true with noop:true when there's nothing worth
        // compacting (transcript too short). Show as info, not error.
        if (j.noop) {
          await window.notice("Nothing to compact", j.message || "Transcript is short enough already.");
          return;
        }
        while (log.firstChild) log.removeChild(log.firstChild);
        await rehydrateFromTranscript();
        refreshContext();
        await window.notice("Compact complete", `Archived ${j.archived_count} messages, kept the last ${j.kept_msgs} turns.`);
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

    // v2.7.12: tool calls render as neon-glow pills grouped per assistant
    // turn (one .chat-tool-pills row reused for the whole turn). Pills
    // appear live as SSE toolcall_start events arrive, so the operator
    // SEES master fetching tool after tool. Click a pill → side notice
    // with full args + result.
    function appendToolCall(toolCallId, name, args) {
      clearEmpty();
      // ── v2.8.1 chat perf / skill router ──
      // PRE-FIX (v2.7.12 → v2.8.0): hideChatThinking() ran here, which
      // killed the indicator the moment Evy issued a tool call. If the
      // assistant message then took a few seconds to actually start
      // streaming (LM Studio JIT, tool latency, prompt re-load), the
      // operator stared at silence. POST-FIX: keep the indicator alive
      // through tool calls; flip its label to "working" so the visual
      // changes (operator knows something IS happening) but the dots
      // keep animating. Removed only when actual text streams in via
      // appendDelta() or the turn ends in endAssistantBubble().
      setChatThinkingState(log, "working");
      // Reuse the row the active assistant turn already started, or open a
      // fresh one if the turn hasn't emitted any tool pills yet.
      let row;
      const lastEl = log.lastElementChild;
      if (lastEl && lastEl.classList.contains("chat-tool-pills") && lastEl.dataset.turnOpen === "1") {
        row = lastEl;
      } else {
        row = document.createElement("div");
        row.className = "chat-tool-pills";
        row.dataset.turnOpen = "1";
        log.appendChild(row);
      }
      const pill = renderToolPill({ name, args });
      pill.dataset.tcid = toolCallId;
      row.appendChild(pill);
      log.scrollTop = log.scrollHeight;
      toolCallEls.set(toolCallId, pill);
    }

    function markToolDone(toolCallId, ok, summary) {
      const pill = toolCallEls.get(toolCallId);
      if (!pill) return;
      pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
      if (summary != null) {
        pill.dataset.result = (typeof summary === "string") ? summary : JSON.stringify(summary);
      }
      log.scrollTop = log.scrollHeight;
    }

    // Close any "open" tool-pill row so the NEXT assistant turn opens a
    // fresh row instead of piling pills into the previous turn's row.
    function closeToolPillRow() {
      const lastEl = log.lastElementChild;
      if (lastEl && lastEl.classList.contains("chat-tool-pills")) {
        delete lastEl.dataset.turnOpen;
      }
      // Also clear any stragglers — only the trailing row could still be
      // open, but be defensive.
      log.querySelectorAll('.chat-tool-pills[data-turn-open="1"]').forEach((n) => {
        delete n.dataset.turnOpen;
      });
    }

    function startAssistantBubble() {
      activeAssistantText = "";
      activeAssistantEl = appendMessage("assistant", "", { label: "evy" });
    }

    function appendDelta(delta) {
      // First delta of a turn = master has started speaking. Drop the
      // thinking indicator so it doesn't sit between text and pills.
      hideChatThinking(log);
      if (!activeAssistantEl) startAssistantBubble();
      activeAssistantText += delta;
      activeAssistantEl.textContent = activeAssistantText;
      log.scrollTop = log.scrollHeight;
    }

    function endAssistantBubble() {
      // v2.8.0 — attach a 🔊 button to the just-finished Evy bubble so
      // the operator can click to render+play the text. The button is
      // only added if voice is enabled (cached probe lives on window).
      // The audio renders lazily on first click; subsequent clicks
      // replay the cached audio.
      if (activeAssistantEl && activeAssistantText && window.__subctlVoiceEnabled) {
        attachVoicePlayButton(activeAssistantEl, activeAssistantText);
      }
      activeAssistantEl = null;
      activeAssistantText = "";
      // Seal the tool-pill row so the next assistant turn opens a new one
      // (otherwise consecutive turns' pills would pile into the same row).
      closeToolPillRow();
      // Belt-and-suspenders: thinking indicator should already be hidden by
      // appendDelta / appendToolCall, but if the turn was empty (zero
      // deltas + zero tool calls) clean it up here.
      hideChatThinking(log);
    }

    // v2.8.0 — voice play button injected onto Evy's bubble body.
    // Click → POST /api/voice/render with the text; on success swap a
    // <audio controls autoplay> into the bubble's footer. Errors stay
    // visible inline.
    function attachVoicePlayButton(bubbleBody, text) {
      const footer = document.createElement("div");
      footer.className = "voice-footer";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-play-btn";
      btn.title = "render and play (Evy voice)";
      btn.setAttribute("aria-label", "Play this turn as voice");
      // Lucide volume-2 icon shape — keeps with v2.7.26 icon adoption.
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
        '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' +
        '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>' +
        "</svg>";
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add("voice-play-btn--loading");
        try {
          const r = await fetch("/api/voice/render", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const j = await r.json();
          if (!j.ok) {
            footer.appendChild(renderVoiceError(j.error || "render failed"));
            return;
          }
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.autoplay = true;
          audio.preload = "auto";
          audio.src = j.audio_url.startsWith("/voice/")
            ? "/api" + j.audio_url
            : j.audio_url;
          audio.className = "voice-audio";
          btn.remove();
          footer.appendChild(audio);
        } catch (err) {
          footer.appendChild(renderVoiceError(String(err)));
        } finally {
          btn.classList.remove("voice-play-btn--loading");
        }
      });
      footer.appendChild(btn);
      bubbleBody.appendChild(footer);
    }
    function renderVoiceError(msg) {
      const e = document.createElement("span");
      e.className = "voice-err";
      e.textContent = "voice: " + msg;
      return e;
    }
    // Probe master's voice config once on connect; mirror it on window so
    // endAssistantBubble can decide whether to attach the button. Updates
    // live via the `voice_config` SSE event (master broadcasts on
    // voice.json change).
    function refreshVoiceEnabled() {
      fetch("/api/voice/status", { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          if (j && j.config) window.__subctlVoiceEnabled = !!j.config.enabled;
        })
        .catch(() => { /* leave whatever value was last set */ });
    }
    refreshVoiceEnabled();

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
      // v2.7.3: compact_warning carries the just-in-time decision. When
      // stage="compacting" we paint the transient BLUE banner immediately
      // (before the operator's poll comes around). transcript_compacted
      // clears it. The repaint is best-effort: refreshContext re-renders
      // the banner from /transcript/util anyway.
      es.addEventListener("compact_warning", (e) => {
        try {
          const d = JSON.parse(e.data);
          const banner = $("ctx-overflow-banner");
          if (!banner) return;
          if (d.stage === "compacting") {
            banner.hidden = false;
            banner.dataset.state = "compacting";
            banner.innerHTML =
              '<strong>Compacting transcript…</strong> just-in-time gate fired ' +
              '(current ~<span>' + (d.current_tokens || 0).toLocaleString() + '</span> tok ≥ ' +
              '<span>' + (d.compact_at || 0).toLocaleString() + '</span>). ' +
              'Banner will clear when compact finishes.';
          } else if (d.stage === "warn") {
            banner.hidden = false;
            banner.dataset.state = "warn";
            banner.innerHTML =
              '<strong>Transcript approaching compact threshold</strong> — current ~<span>' +
              (d.current_tokens || 0).toLocaleString() + '</span> tok ≥ warn ' +
              '<span>' + (d.warn_at || 0).toLocaleString() + '</span> ' +
              '(auto-compact at <span>' + (d.compact_at || 0).toLocaleString() + '</span>). ' +
              'Compact now to keep the supervisor responsive.' +
              '<div class="ctx-overflow-actions">' +
              '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
              '</div>';
            rewireBannerButton();
          }
        } catch {}
      });
      es.addEventListener("transcript_compacted", () => {
        const banner = $("ctx-overflow-banner");
        if (banner) {
          banner.hidden = true;
          banner.dataset.state = "ok";
        }
        // The compact mutates the transcript; pull a fresh meter reading.
        try { refreshContext(); } catch {}
      });
      es.addEventListener("inbound", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.source === "watchdog") {
            appendMessage("watchdog", d.text, { label: "watchdog" });
          } else if (d.source === "telegram") {
            // Telegram-sourced messages get a distinct badge so the operator
            // can tell at a glance that a reply belongs to a Telegram thread
            // rather than the dashboard's own input. Bubble also gets the
            // .from-telegram class for accent-border styling.
            const body = appendMessage("user", d.text, { label: "✈ you · telegram" });
            const bubble = body?.parentElement;
            if (bubble) bubble.classList.add("from-telegram");
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
          // ── v2.8.1 chat perf / skill router ──
          // After a tool result lands but BEFORE Evy continues
          // reasoning, the indicator should pulse "thinking" again
          // (not "working") — there's no active tool, we're waiting on
          // the next LLM step. Reverts when appendToolCall runs again
          // or hides when appendDelta paints text.
          setChatThinkingState(log, "thinking");
        } catch {}
      });
      // ── v2.8.1 chat perf / skill router ──
      // Skill router decision pill. Master broadcasts `skill_router`
      // once per turn (right after composeSystemPrompt) with the list
      // of skills it loaded into Evy's prompt. Render as a tiny
      // "[router] x · y" row under the operator's last message — the
      // operator can see in real-time which skills got preloaded for
      // this turn.
      es.addEventListener("skill_router", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (!Array.isArray(d.selected) || d.selected.length === 0) return;
          const pill = document.createElement("div");
          pill.className = "chat-router-pill";
          pill.title = d.reason || "skill router";
          pill.textContent = "[router] " + d.selected.join(" · ");
          // Drop the pill just above the thinking indicator if there
          // is one, otherwise at the tail.
          const thinking = log.querySelector(".chat-thinking");
          if (thinking) {
            log.insertBefore(pill, thinking);
          } else {
            log.appendChild(pill);
          }
          log.scrollTop = log.scrollHeight;
        } catch {}
      });
      // ── v2.8.1 chat perf / skill router ──
      // Latency stages — silent by default; the master logs the full
      // breakdown to stderr. We surface only the "last_token" event
      // as a debug-friendly data attribute on the most recent assistant
      // bubble so curious operators can inspect total turn time via
      // devtools without us painting numbers onto the chat.
      es.addEventListener("latency_stage", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.stage !== "last_token" && d.stage !== "turn_complete") return;
          const bubbles = log.querySelectorAll(".master-msg-assistant");
          const last = bubbles[bubbles.length - 1];
          if (!last) return;
          last.dataset[`latency_${d.stage}_ms`] = String(d.elapsed_ms);
        } catch {}
      });
      es.addEventListener("watchdog_fire", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendMessage("watchdog", d.prompt, { label: "watchdog" });
          if (window.__subctlPushNotification) {
            window.__subctlPushNotification("watchdog", String(d.prompt || "").slice(0, 140));
          }
        } catch {}
      });
      // Curated notifications. Three SSE event types map to sidecar:
      //   "notify"      — master called notify_dashboard explicitly
      //   "team_event"  — auto-derive on blocked/done/error (skip progress/note noise)
      //   "watchdog_fire" — already handled above
      es.addEventListener("notify", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (window.__subctlPushNotification) {
            window.__subctlPushNotification(d.kind || "info", d.summary || "", d.team);
          }
        } catch {}
      });
      // v2.8.0 — master broadcasts on voice.json change so the 🔊 button
      // toggles live without a refresh.
      es.addEventListener("voice_config", (e) => {
        try {
          const d = JSON.parse(e.data);
          window.__subctlVoiceEnabled = !!d.enabled;
        } catch {}
      });
      es.addEventListener("team_event", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (!window.__subctlPushNotification) return;
          // Only auto-publish meaningful state changes — skip progress
          // tick noise (master can choose to notify_dashboard("…", "milestone")
          // for those if it wants to surface them).
          const significant = ["blocked", "done", "error"];
          if (!significant.includes(d.type)) return;
          window.__subctlPushNotification(d.type, String(d.text || "").slice(0, 140), d.team);
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
      `/attach <team>                 — show the SSH command to attach to a team's tmux on ${HOST_LABEL}`,
      "/config                        — show config file paths and what each controls",
      "",
      "How dev teams work:",
      `  • Master spawns tmux sessions on ${HOST_LABEL} via subctl_orch_spawn`,
      "  • The lead Claude Code in pane 0 uses TeamCreate + Agent(team_name=\"…\") to make workers",
      "  • Each lead writes status to ~/.config/subctl/master/inbox/<team>.jsonl",
      "  • Master tails inboxes (2s poll), reacts to blocked/error events, watchdog at 30min",
      `  • Attach manually with: ssh ${SSH_HOST_ALIAS} tmux attach -t <team>`,
      "",
      `Config (all on ${HOST_LABEL}):`,
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
              `master ${j.ok ? "ALL CHECKS PASSED" : "DEGRADED"} · v${j.version || "?"}\n` +
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
            `Attach to dev team "${args}" on ${HOST_LABEL}:\n\n` +
            `  ssh ${SSH_HOST_ALIAS} -t tmux attach -t ${args}\n\n` +
            `Detach with Ctrl-b then d. The master and team keep running after detach.`,
          );
          return;
        }

        case "config":
          appendSystemBlock([
            `config files (all on ${HOST_LABEL} at ~/.config/subctl/master/):`,
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
            `edit the file directly on ${HOST_LABEL}, then restart with:`,
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

    // ── Attachments (Phase 3l) ────────────────────────────────────────────
    // Tracks the attachment ids currently queued for the NEXT outgoing
    // message. Cleared after send. Each entry has the id + minimal metadata
    // for rendering the pill.
    const pendingAttachments = []; // {id, filename, size}
    const attachBar = $("master-attachments");
    const attachBtn = $("master-attach-btn");
    const attachFile = $("master-attach-file");
    // Threshold for auto-paste-as-attachment. Spec §3l default: 4 KB.
    const PASTE_ATTACH_THRESHOLD = 4 * 1024;

    function fmtBytes(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function renderAttachmentBar() {
      if (!attachBar) return;
      if (pendingAttachments.length === 0) {
        attachBar.hidden = true;
        attachBar.innerHTML = "";
        return;
      }
      attachBar.hidden = false;
      attachBar.innerHTML = pendingAttachments.map((a, i) =>
        `<span class="att-pill" data-i="${i}">
          <span class="att-name">${escForHtml(a.filename)}</span>
          <span class="att-size">${fmtBytes(a.size)}</span>
          <button type="button" class="att-x" data-i="${i}" aria-label="remove">×</button>
        </span>`
      ).join("");
      for (const btn of attachBar.querySelectorAll(".att-x")) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const i = parseInt(btn.getAttribute("data-i"), 10);
          if (Number.isInteger(i)) {
            pendingAttachments.splice(i, 1);
            renderAttachmentBar();
          }
        });
      }
    }

    function escForHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" :
        c === '"' ? "&quot;" : "&#39;"
      );
    }

    async function uploadAttachment(blob, filename, source) {
      try {
        const r = await fetch("/api/master/attachments", {
          method: "POST",
          headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(filename),
            "X-Mime": blob.type || "",
            "X-Source": source,
          },
          body: blob,
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
          const msg = (j && (j.error || j.hint)) || `HTTP ${r.status}`;
          if (window.notice && window.notice.error) window.notice.error("Attach failed", msg);
          else appendMessage("error", "attach failed: " + msg, { label: "error" });
          return null;
        }
        pendingAttachments.push({
          id: j.attachment.id,
          filename: j.attachment.filename,
          size: j.attachment.size,
        });
        renderAttachmentBar();
        return j.attachment;
      } catch (err) {
        appendMessage("error", "attach error: " + err, { label: "error" });
        return null;
      }
    }

    // Paperclip → file picker
    if (attachBtn && attachFile) {
      attachBtn.addEventListener("click", () => attachFile.click());
      attachFile.addEventListener("change", async () => {
        const files = Array.from(attachFile.files || []);
        for (const f of files) {
          await uploadAttachment(f, f.name, "upload");
        }
        attachFile.value = "";
      });
    }

    // Drag-and-drop onto the input or anywhere in master-chat panel.
    const dropZone = form && form.closest("section");
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (e) => {
        if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", async (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer?.files || []);
        for (const f of files) {
          await uploadAttachment(f, f.name, "upload");
        }
      });
    }

    // Paste interception — if the pasted text exceeds the threshold, take
    // over the paste event, upload the text as an attachment, and clear
    // the input. Small pastes pass through normally.
    input.addEventListener("paste", async (e) => {
      const clip = e.clipboardData;
      if (!clip) return;
      const pasted = clip.getData("text") || "";
      if (pasted.length < PASTE_ATTACH_THRESHOLD) return; // normal paste
      e.preventDefault();
      // Synthesize a filename from the timestamp + first non-whitespace line.
      const firstLine = pasted.split("\n").find((l) => l.trim()) || "pasted";
      const slug = firstLine
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-|-$/g, "") || "pasted";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `pasted-${stamp}-${slug}.md`;
      const blob = new Blob([pasted], { type: "text/markdown" });
      await uploadAttachment(blob, filename, "paste");
    });

    async function sendChat(text) {
      sendBtn.disabled = true;
      // Build the visible message — include attachment names if any.
      const attachmentIds = pendingAttachments.map((a) => a.id);
      const attachLabels = pendingAttachments.map((a) => `📎 ${a.filename}`).join("  ");
      const visible = attachLabels
        ? (text ? `${attachLabels}\n${text}` : attachLabels)
        : text;
      appendMessage("user", visible, { label: "you" });
      // v2.7.12: paint the live "Evy · thinking" indicator while we wait
      // for the master to start streaming. Removed by appendDelta /
      // appendToolCall on the first SSE event, or below on error/timeout.
      showChatThinking(log);
      // Safety: if no SSE event arrives in 30s, drop the indicator so the
      // operator isn't stuck staring at a forever-pulsing dot.
      const thinkingTimeout = setTimeout(() => hideChatThinking(log), 30000);
      // Clear pending attachments NOW (so the next message starts fresh).
      pendingAttachments.length = 0;
      renderAttachmentBar();
      try {
        const r = await fetch("/api/master/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            source: "chat",
            attachments: attachmentIds,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          clearTimeout(thinkingTimeout);
          hideChatThinking(log);
          appendMessage("error", "send failed: " + (j.error || r.status), { label: "error" });
        }
      } catch (err) {
        clearTimeout(thinkingTimeout);
        hideChatThinking(log);
        appendMessage("error", "send error: " + err, { label: "error" });
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      // Allow send with empty text if attachments exist.
      if (!text && pendingAttachments.length === 0) return;
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
        // ── v2.8.1 accounts data fix ──
        // When the per-account usage payload is missing (fetch failed or
        // upstream didn't return this alias), the verdict module flags
        // `data_missing: true` and the server stamps `usage_state` !== "ok".
        // Render a "no data" pill instead of the normal verdict so the
        // operator stops seeing a false green "dispatches go".
        const dataMissing = a.dispatch?.data_missing === true || (a.usage_state && a.usage_state !== "ok");
        tr.append(
          td(acctPill(a.alias, a.color_class)),
          td(a.provider),
          td(authCell(a.auth_status)),
          td(verdictPill(a.dispatch?.verdict, a.dispatch?.reasons, { dataMissing, usageState: a.usage_state })),
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
    name.textContent = alias;
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

  // ──────────────────────────────────────────────────────────────────────
  // PR 11 (v2.7.0): Live Logs Policy filter chip + Policy sidebar tab
  //
  // v2.8.6: The Logs side (chip + audit detail panel + allowlist modal +
  // its private SSE/filter/last-clicked state) moved to
  // dashboard/public/tabs/logs.js. What stays here is Policy-owned:
  // cachedTeams + refreshPolicyTeamsForDropdowns + renderAuditEntries
  // (shared renderer) + wirePolicyTab.
  // ──────────────────────────────────────────────────────────────────────

  let cachedTeams = []; // populated by /api/policy/teams polling

  function fmtAuditLine(entry) {
    // Compact one-liner per pack 09 §7.1.
    const ts = (entry.ts || "").replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/Z$/, "");
    const team = (entry.team_id || "").padEnd(14, " ").slice(0, 14);
    const decision = (entry.decision || "").toUpperCase().padEnd(5, " ");
    const cmd = entry.event_type === "header"
      ? `(spawn · mode=${entry.mode} · sha=${entry.allowlist_sha})`
      : entry.event_type === "verifier_correction"
        ? `(verifier correction)`
        : (entry.command || "").slice(0, 220);
    return `${ts}  ${team}  ${decision}  ${cmd}`;
  }

  function classifyAuditLine(entry) {
    if (entry.event_type === "verifier_correction") return "audit-verifier";
    if (entry.event_type === "header") return "audit-header";
    if (entry.decision === "deny") return "audit-deny";
    return "audit-allow";
  }

  function renderAuditEntries(view, entries, opts = {}) {
    // sub-filter is owned by the Logs tab module (tabs/logs.js) since v2.8.6;
    // it travels in via opts.subfilter. Default "all" preserves behavior for
    // any future caller that doesn't pass an opts.
    const subfilter = opts.subfilter ?? "all";
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      // sub-filter applied client-side
      if (subfilter === "deny" && !(entry.decision === "deny" && entry.event_type !== "verifier_correction")) continue;
      if (subfilter === "verifier" && entry.event_type !== "verifier_correction") continue;

      const div = document.createElement("div");
      div.className = "log-line " + classifyAuditLine(entry);
      div.textContent = fmtAuditLine(entry);
      div.dataset.clickable = "true";
      // Stash the entry so the detail panel can pick it up on click without
      // serializing back through dataset (lossy for our nested rule_path).
      div._auditEntry = entry;
      frag.appendChild(div);
      // Render the rule line indented underneath the entry for denies/verifier
      if (entry.rule && (entry.decision === "deny" || entry.event_type === "verifier_correction")) {
        const rdiv = document.createElement("div");
        rdiv.className = "log-line audit-rule";
        rdiv.textContent = `  ↳ ${entry.rule}`;
        frag.appendChild(rdiv);
      }
    }
    view.appendChild(frag);
    const MAX = 5000;
    while (view.childElementCount > MAX) view.removeChild(view.firstChild);
    const autoscrollCb = $("logs-autoscroll");
    if (autoscrollCb?.checked !== false) view.scrollTop = view.scrollHeight;
  }

  async function refreshPolicyTeamsForDropdowns() {
    try {
      const r = await fetch("/api/policy/teams");
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.ok) return;
      cachedTeams = j.teams || [];
      // Populate both the Live Logs team selector and the Policy tab selector.
      const targets = [$("logs-policy-team"), $("policy-resolved-team")];
      for (const sel of targets) {
        if (!sel) continue;
        const prev = sel.value;
        sel.innerHTML = "";
        if (cachedTeams.length === 0) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "(no teams spawned)";
          sel.appendChild(opt);
          sel.disabled = true;
        } else {
          sel.disabled = false;
          for (const t of cachedTeams) {
            const opt = document.createElement("option");
            opt.value = t.team_id;
            opt.textContent = `${t.team_id} · ${t.mode || "?"}`;
            sel.appendChild(opt);
          }
          // Preserve selection across refreshes when possible.
          if (prev && cachedTeams.some((t) => t.team_id === prev)) sel.value = prev;
        }
      }
    } catch { /* dashboard idle — fine */ }
  }

  // ── v2.8.6 shell-bridge globals ─────────────────────────────────────────
  // Temporary globals exposed for the extracted Logs tab module
  // (dashboard/public/tabs/logs.js). The chip in that module needs to read
  // `cachedTeams`, trigger a refresh, and call the shared audit renderer
  // without importing app.js internals. These three bridges retire when the
  // Policy tab also extracts and owns its own publishing of team state.
  // See ORCHESTRATION.md 2026-05-13 night session for the state-ownership
  // ruling.
  window.__subctlGetPolicyTeams = () => cachedTeams.slice();
  window.__subctlRefreshPolicyTeams = refreshPolicyTeamsForDropdowns;
  window.__subctlRenderAuditEntries = renderAuditEntries;

  // ────────────────────────────── Policy tab ──────────────────────────────
  function wirePolicyTab() {
    const teamsTbody = $("policy-teams-tbody");
    const denialsTbody = $("policy-denials-tbody");
    const verifierBox = $("policy-verifier-timeline");
    const resolvedView = $("policy-resolved-view");
    const resolvedSel = $("policy-resolved-team");
    const refreshBtn = $("policy-refresh-btn");
    const status = $("policy-status");
    if (!teamsTbody) return;

    function setStatus(s, cls) {
      if (!status) return;
      status.textContent = s;
      status.className = "logs-status " + (cls || "");
    }

    function renderTeams(teams) {
      teamsTbody.innerHTML = "";
      if (!teams || teams.length === 0) {
        teamsTbody.appendChild(emptyRow(6, "no teams spawned"));
        return;
      }
      for (const t of teams) {
        const tr = document.createElement("tr");
        const mode = (t.mode || "").toLowerCase();
        tr.innerHTML = `
          <td>${escapeHtml(t.team_id)}</td>
          <td><span class="policy-mode-chip ${escapeHtml(mode || "")}">${escapeHtml(mode || "?")}</span></td>
          <td>${escapeHtml(t.preset || "—")}</td>
          <td><code>${escapeHtml(t.allowlist_sha || "—")}</code></td>
          <td>${escapeHtml(t.spawned_at || "—")}</td>
          <td>${escapeHtml(t.project_root || "—")}</td>
        `;
        teamsTbody.appendChild(tr);
      }
    }

    function renderDenials(buckets) {
      denialsTbody.innerHTML = "";
      if (!buckets || buckets.length === 0) {
        denialsTbody.appendChild(emptyRow(5, "no denials in the last 24h"));
        return;
      }
      for (const b of buckets) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><code>${escapeHtml(b.rule_path || "")}</code></td>
          <td>${b.count}</td>
          <td>${escapeHtml((b.teams || []).join(", "))}</td>
          <td>${escapeHtml(b.last_ts || "")}</td>
          <td>${escapeHtml(b.rule || "")}</td>
        `;
        denialsTbody.appendChild(tr);
      }
    }

    function renderVerifierTimeline(entries) {
      if (!verifierBox) return;
      verifierBox.innerHTML = "";
      if (!entries || entries.length === 0) {
        const d = document.createElement("div");
        d.className = "dim small";
        d.style.padding = "16px";
        d.textContent = "no verifier corrections recorded";
        verifierBox.appendChild(d);
        return;
      }
      for (const e of entries) {
        const item = document.createElement("div");
        item.className = "policy-verifier-item";
        item.innerHTML = `
          <span class="when">${escapeHtml((e.ts || "").replace("T", " ").replace("Z", ""))}</span>
          <span class="team">${escapeHtml(e.team_id || "")}</span>
          <span class="rule">${escapeHtml(e.rule || "")}</span>
        `;
        verifierBox.appendChild(item);
      }
    }

    // ── v2.7.34 policy UI: chip-list resolved view ──
    // `view` can be "chips" (default) or "json"; toggled via the
    // #policy-resolved-view-toggle button.
    let resolvedViewMode = "chips";
    const viewToggleBtn = $("policy-resolved-view-toggle");
    if (viewToggleBtn) {
      viewToggleBtn.addEventListener("click", () => {
        resolvedViewMode = resolvedViewMode === "chips" ? "json" : "chips";
        viewToggleBtn.textContent = "view: " + resolvedViewMode;
        viewToggleBtn.dataset.view = resolvedViewMode;
        if (resolvedSel && resolvedSel.value) loadResolved(resolvedSel.value);
      });
    }

    function renderResolvedChips(j) {
      resolvedView.classList.add("chips");
      resolvedView.innerHTML = "";
      // Meta header
      const meta = document.createElement("div");
      meta.className = "policy-chip-meta";
      meta.innerHTML = `
        <div><strong>mode</strong> <span class="policy-mode-chip ${escapeHtml(j.mode || "")}">${escapeHtml(j.mode || "?")}</span></div>
        <div><strong>preset</strong> ${escapeHtml(j.preset || "—")}</div>
        <div><strong>sha</strong> <code>${escapeHtml(j.allowlist_sha || "—")}</code></div>
        <div><strong>resolved</strong> ${escapeHtml((j.resolved_at || "—").replace("T", " ").replace("Z", ""))}</div>
        <div><strong>project</strong> <code>${escapeHtml(j.project_root || "—")}</code></div>
      `;
      resolvedView.appendChild(meta);

      const groups = {
        command: { label: "Allowed commands", chips: [] },
        pattern: { label: "Allowed patterns", chips: [] },
        ecosystem: { label: "Ecosystem allowlists", chips: [] },
        deny: { label: "Deny — substrings", chips: [] },
        deny_regex: { label: "Deny — regex", chips: [] },
      };
      for (const c of (j.chips || [])) {
        (groups[c.kind] || groups.command).chips.push(c);
      }
      for (const key of ["command", "pattern", "ecosystem", "deny", "deny_regex"]) {
        const g = groups[key];
        if (!g.chips.length) continue;
        const wrap = document.createElement("div");
        wrap.className = "policy-chip-group";
        wrap.innerHTML = `<h4>${escapeHtml(g.label)} <span class="dim small">(${g.chips.length})</span></h4>`;
        const chipBox = document.createElement("div");
        for (const c of g.chips) {
          const chip = document.createElement("span");
          chip.className = "policy-chip " + key;
          chip.title = `${c.detail}\nfrom: ${c.origin}\npath: ${c.rule_path}`;
          chip.innerHTML = `${escapeHtml(c.label)}<span class="origin">${escapeHtml(c.origin || "")}</span>`;
          chipBox.appendChild(chip);
        }
        wrap.appendChild(chipBox);
        resolvedView.appendChild(wrap);
      }
      if ((j.chips || []).length === 0) {
        const empty = document.createElement("div");
        empty.className = "dim small";
        empty.style.padding = "16px";
        empty.textContent = "resolved policy is empty (no allow rules, no deny rules)";
        resolvedView.appendChild(empty);
      }
    }

    async function loadResolved(team) {
      if (!team) {
        resolvedView.classList.remove("chips");
        resolvedView.innerHTML = "<div class=\"dim small\" style=\"padding:16px\">pick a team to load resolved policy</div>";
        return;
      }
      try {
        const r = await fetch(`/api/policy/resolved/${encodeURIComponent(team)}`);
        const j = await r.json();
        if (!j || !j.ok) {
          resolvedView.classList.remove("chips");
          resolvedView.textContent = `error: ${(j && j.error) || "unknown"}`;
          return;
        }
        if (resolvedViewMode === "json") {
          resolvedView.classList.remove("chips");
          resolvedView.textContent = JSON.stringify(j, null, 2);
        } else {
          renderResolvedChips(j);
        }
      } catch (err) {
        resolvedView.classList.remove("chips");
        resolvedView.textContent = `fetch error: ${err.message || err}`;
      }
    }

    async function refresh() {
      setStatus("loading", "connecting");
      try {
        await refreshPolicyTeamsForDropdowns();
        renderTeams(cachedTeams);
        const ag = await fetch("/api/audit/aggregate?since=24h&top=10").then((r) => r.json());
        if (ag && ag.ok) {
          renderDenials(ag.top || []);
          renderVerifierTimeline(ag.verifier_corrections || []);
        }
        // Refresh resolved view for whatever team is currently selected
        if (resolvedSel && resolvedSel.value) loadResolved(resolvedSel.value);
        setStatus("live", "connected");
      } catch (err) {
        setStatus("error", "error");
      }
    }

    if (refreshBtn) refreshBtn.addEventListener("click", refresh);
    if (resolvedSel) resolvedSel.addEventListener("change", () => loadResolved(resolvedSel.value));

    // Auto-refresh while the Policy tab is visible. Hook the tab-switch
    // event the same way other tabs do.
    let everLoaded = false;
    let pollTimer = null;
    function checkVisible() {
      const active = document.body.getAttribute("data-active-tab") === "policy";
      if (active) {
        if (!everLoaded) { everLoaded = true; refresh(); }
        if (!pollTimer) pollTimer = setInterval(refresh, 5000);
      } else if (pollTimer) {
        clearInterval(pollTimer); pollTimer = null;
      }
    }
    new MutationObserver(checkVisible).observe(document.body, {
      attributes: true, attributeFilter: ["data-active-tab"],
    });
    checkVisible();

    // ── v2.7.34 policy UI: wire the editor sub-panel ──
    wirePolicyEditor();
  }

  // ── v2.7.34 policy UI: form-based editor for user + project policy ──
  // Three sub-tabs: user / project / apply. Each form is a thin shape over
  // the resolved policy doc — top-level scalars (preset, default_mode) plus
  // the gated rule families (allow.commands, allow_pattern, deny_always).
  function wirePolicyEditor() {
    const panel = $("policy-editor-panel");
    if (!panel) return;

    // Tab switching
    panel.querySelectorAll(".policy-editor-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const which = btn.dataset.editor;
        panel.querySelectorAll(".policy-editor-tab").forEach((b) => b.classList.toggle("active", b === btn));
        panel.querySelectorAll(".policy-editor-pane").forEach((p) => p.classList.toggle("active", p.dataset.editor === which));
      });
    });

    wireUserEditor();
    wireProjectEditor();
    wireApplyPresetPane();
  }

  // Render the editor form for a given doc into the host element.
  // Returns a getter that reads the current form state back into a doc.
  function renderPolicyForm(host, doc) {
    host.innerHTML = "";
    const d = (doc && typeof doc === "object" && !Array.isArray(doc)) ? doc : {};
    const mode = (d.mode && typeof d.mode === "object" && !Array.isArray(d.mode)) ? d.mode : {};
    const gated = (mode.gated && typeof mode.gated === "object" && !Array.isArray(mode.gated)) ? mode.gated : {};
    const allowCmds = (gated.allow && Array.isArray(gated.allow.commands)) ? gated.allow.commands.slice() : [];
    const allowPatterns = Array.isArray(gated.allow_pattern) ? gated.allow_pattern.slice() : [];
    const denyAlways = (gated.deny_always && typeof gated.deny_always === "object") ? gated.deny_always : {};
    const denySubs = Array.isArray(denyAlways.substrings) ? denyAlways.substrings.slice() : [];
    const denyRegex = Array.isArray(denyAlways.regex) ? denyAlways.regex.slice() : [];

    // ── top-level scalars ──
    const top = document.createElement("div");
    top.className = "pf-section";
    top.innerHTML = `
      <h5>Top-level</h5>
      <div class="pf-row">
        <label>preset</label>
        <input type="text" class="pf-preset" placeholder="(unset — inherits parent chain)" />
      </div>
      <div class="pf-row">
        <label>default_mode</label>
        <select class="pf-default-mode">
          <option value="">(unset)</option>
          <option value="trusted">trusted</option>
          <option value="gated">gated</option>
          <option value="sealed">sealed</option>
        </select>
      </div>
    `;
    host.appendChild(top);
    top.querySelector(".pf-preset").value = (typeof d.preset === "string") ? d.preset : "";
    top.querySelector(".pf-default-mode").value = (typeof d.default_mode === "string") ? d.default_mode : "";

    // ── allow.commands list ──
    const commandsSection = renderListSection(host, "Allowed commands (gated.allow.commands)", allowCmds, "command name (e.g. ls)");

    // ── allow_pattern list ──
    const patternsSection = document.createElement("div");
    patternsSection.className = "pf-section";
    patternsSection.innerHTML = `<h5>Allowed patterns (gated.allow_pattern)</h5>`;
    const patList = document.createElement("div");
    patList.className = "pf-list";
    patternsSection.appendChild(patList);
    function addPatternRow(p) {
      const row = document.createElement("div");
      row.className = "pf-pattern-row";
      row.innerHTML = `
        <input type="text" class="pf-pat-command" placeholder="command" />
        <input type="text" class="pf-pat-args" placeholder="args (comma-separated, e.g. status,diff,log)" />
        <input type="text" class="pf-pat-deny" placeholder="deny_if_arg_contains (comma)" />
        <button type="button" class="pf-mini-btn danger" data-remove>remove</button>
      `;
      row.querySelector(".pf-pat-command").value = (p && typeof p.command === "string") ? p.command : "";
      row.querySelector(".pf-pat-args").value = (p && Array.isArray(p.args)) ? p.args.join(",") : "";
      row.querySelector(".pf-pat-deny").value = (p && Array.isArray(p.deny_if_arg_contains)) ? p.deny_if_arg_contains.join(",") : "";
      row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
      patList.appendChild(row);
    }
    allowPatterns.forEach(addPatternRow);
    const addPatBtn = document.createElement("button");
    addPatBtn.type = "button";
    addPatBtn.className = "pf-mini-btn";
    addPatBtn.textContent = "+ add pattern";
    addPatBtn.addEventListener("click", () => addPatternRow({}));
    patternsSection.appendChild(addPatBtn);
    host.appendChild(patternsSection);

    // ── deny_always.substrings ──
    const denySubsSection = renderListSection(host, "Deny substrings (gated.deny_always.substrings)", denySubs, "substring (e.g. rm -rf)");
    // ── deny_always.regex ──
    const denyRegexSection = renderListSection(host, "Deny regex (gated.deny_always.regex)", denyRegex, "RE2 regex (e.g. \\bcurl\\b.*\\| sh)");

    return function readDoc() {
      const preset = top.querySelector(".pf-preset").value.trim();
      const defaultMode = top.querySelector(".pf-default-mode").value.trim();
      const cmds = readListSection(commandsSection).filter((s) => s);
      const patterns = [];
      patList.querySelectorAll(".pf-pattern-row").forEach((row) => {
        const command = row.querySelector(".pf-pat-command").value.trim();
        if (!command) return;
        const args = row.querySelector(".pf-pat-args").value.split(",").map((s) => s.trim()).filter((s) => s);
        const deny = row.querySelector(".pf-pat-deny").value.split(",").map((s) => s.trim()).filter((s) => s);
        const obj = { command };
        if (args.length) obj.args = args;
        if (deny.length) obj.deny_if_arg_contains = deny;
        patterns.push(obj);
      });
      const subs = readListSection(denySubsSection).filter((s) => s);
      const regex = readListSection(denyRegexSection).filter((s) => s);

      const out = {};
      if (preset) out.preset = preset;
      if (defaultMode) out.default_mode = defaultMode;
      const gatedOut = {};
      if (cmds.length) gatedOut.allow = { commands: cmds };
      if (patterns.length) gatedOut.allow_pattern = patterns;
      const denyOut = {};
      if (subs.length) denyOut.substrings = subs;
      if (regex.length) denyOut.regex = regex;
      if (Object.keys(denyOut).length) gatedOut.deny_always = denyOut;
      if (Object.keys(gatedOut).length) out.mode = { gated: gatedOut };
      return out;
    };
  }

  function renderListSection(host, title, items, placeholder) {
    const section = document.createElement("div");
    section.className = "pf-section";
    section.innerHTML = `<h5>${escapeHtml(title)}</h5>`;
    const list = document.createElement("div");
    list.className = "pf-list";
    section.appendChild(list);
    function addRow(val) {
      const row = document.createElement("div");
      row.className = "pf-list-row";
      row.innerHTML = `
        <input type="text" class="pf-list-input" placeholder="${escapeHtml(placeholder)}" />
        <button type="button" class="pf-mini-btn danger" data-remove>remove</button>
      `;
      row.querySelector(".pf-list-input").value = val || "";
      row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
      list.appendChild(row);
    }
    (items || []).forEach(addRow);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "pf-mini-btn";
    addBtn.textContent = "+ add";
    addBtn.addEventListener("click", () => addRow(""));
    section.appendChild(addBtn);
    host.appendChild(section);
    return section;
  }
  function readListSection(section) {
    return Array.from(section.querySelectorAll(".pf-list-input")).map((el) => el.value.trim());
  }

  function wireUserEditor() {
    const formHost = $("policy-editor-user-form");
    const status = $("policy-editor-user-status");
    const existsEl = $("policy-editor-user-exists");
    const pathEl = $("policy-editor-user-path");
    const reloadBtn = $("policy-editor-user-reload");
    const saveBtn = $("policy-editor-user-save");
    if (!formHost) return;
    let getDoc = null;

    function setStatus(msg, cls) {
      if (!status) return;
      status.textContent = msg;
      status.className = "policy-editor-status dim small " + (cls || "");
    }

    async function load() {
      setStatus("loading…", "");
      try {
        const r = await fetch("/api/policy/user");
        const j = await r.json();
        if (!j || !j.ok) {
          setStatus("load failed: " + ((j && j.error) || "unknown"), "err");
          return;
        }
        if (pathEl) pathEl.textContent = j.path;
        if (existsEl) existsEl.textContent = j.exists ? "(file exists)" : "(no file yet)";
        getDoc = renderPolicyForm(formHost, j.doc);
        setStatus("loaded", "ok");
      } catch (err) {
        setStatus("error: " + err, "err");
      }
    }
    async function save() {
      if (!getDoc) return;
      const doc = getDoc();
      setStatus("saving…", "");
      try {
        const r = await fetch("/api/policy/user", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc }),
        });
        const j = await r.json();
        if (j && j.ok) setStatus(`saved (${j.bytes} bytes)`, "ok");
        else setStatus("save failed: " + ((j && j.error) || r.status), "err");
      } catch (err) {
        setStatus("error: " + err, "err");
      }
    }
    if (reloadBtn) reloadBtn.addEventListener("click", load);
    if (saveBtn) saveBtn.addEventListener("click", save);
    // Lazy-load when tab becomes active or panel becomes visible.
    let loaded = false;
    const trigger = () => { if (!loaded) { loaded = true; load(); } };
    panelObserveActive("user", trigger);
  }

  function wireProjectEditor() {
    const formHost = $("policy-editor-project-form");
    const status = $("policy-editor-project-status");
    const existsEl = $("policy-editor-project-exists");
    const pathEl = $("policy-editor-project-path");
    const reloadBtn = $("policy-editor-project-reload");
    const saveBtn = $("policy-editor-project-save");
    const select = $("policy-editor-project-select");
    if (!formHost || !select) return;
    let getDoc = null;
    let currentPath = "";

    function setStatus(msg, cls) {
      if (!status) return;
      status.textContent = msg;
      status.className = "policy-editor-status dim small " + (cls || "");
    }

    async function populateProjects() {
      try {
        const r = await fetch("/api/projects");
        const j = await r.json();
        select.innerHTML = "";
        if (!j || !j.ok) {
          select.innerHTML = "<option value=\"\">(load failed)</option>";
          return;
        }
        select.innerHTML = "<option value=\"\">(pick a project)</option>";
        for (const p of (j.projects || [])) {
          const opt = document.createElement("option");
          opt.value = p.path;
          opt.textContent = p.name + (p.in_policy ? " · tracked" : "");
          select.appendChild(opt);
        }
      } catch {
        select.innerHTML = "<option value=\"\">(network error)</option>";
      }
    }
    async function load() {
      const project = select.value;
      if (!project) {
        formHost.innerHTML = "<div class=\"dim small\" style=\"padding:8px\">pick a project</div>";
        currentPath = "";
        if (pathEl) pathEl.textContent = "";
        if (existsEl) existsEl.textContent = "";
        return;
      }
      setStatus("loading…", "");
      try {
        const r = await fetch("/api/policy/project/" + encodeURIComponent(project));
        const j = await r.json();
        if (!j || !j.ok) {
          setStatus("load failed: " + ((j && j.error) || "unknown"), "err");
          return;
        }
        currentPath = project;
        if (pathEl) pathEl.textContent = j.path;
        if (existsEl) existsEl.textContent = j.exists ? "(file exists)" : "(no file yet)";
        getDoc = renderPolicyForm(formHost, j.doc);
        setStatus("loaded", "ok");
      } catch (err) {
        setStatus("error: " + err, "err");
      }
    }
    async function save() {
      if (!getDoc || !currentPath) return;
      const doc = getDoc();
      setStatus("saving…", "");
      try {
        const r = await fetch("/api/policy/project/" + encodeURIComponent(currentPath), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc }),
        });
        const j = await r.json();
        if (j && j.ok) setStatus(`saved (${j.bytes} bytes)`, "ok");
        else setStatus("save failed: " + ((j && j.error) || r.status), "err");
      } catch (err) {
        setStatus("error: " + err, "err");
      }
    }
    select.addEventListener("change", load);
    if (reloadBtn) reloadBtn.addEventListener("click", load);
    if (saveBtn) saveBtn.addEventListener("click", save);
    let loaded = false;
    panelObserveActive("project", () => { if (!loaded) { loaded = true; populateProjects(); } });
  }

  function wireApplyPresetPane() {
    const projSel = $("policy-apply-project-select");
    const presetSel = $("policy-apply-preset-select");
    const btn = $("policy-apply-preset-btn");
    const status = $("policy-apply-status");
    if (!projSel || !presetSel || !btn) return;
    function setStatus(msg, cls) {
      if (!status) return;
      status.textContent = msg;
      status.className = "policy-apply-status dim small " + (cls || "");
    }
    async function populate() {
      try {
        const [projects, presets] = await Promise.all([
          fetch("/api/projects").then((r) => r.json()).catch(() => null),
          fetch("/api/policy/presets").then((r) => r.json()).catch(() => null),
        ]);
        projSel.innerHTML = "<option value=\"\">(pick a project)</option>";
        if (projects && projects.ok) {
          for (const p of (projects.projects || [])) {
            const opt = document.createElement("option");
            opt.value = p.path;
            opt.textContent = p.name + (p.in_policy ? " · tracked" : "");
            projSel.appendChild(opt);
          }
        }
        presetSel.innerHTML = "<option value=\"\">(pick a preset)</option>";
        if (presets && presets.ok) {
          for (const name of (presets.presets || [])) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            presetSel.appendChild(opt);
          }
        }
      } catch (err) {
        setStatus("load error: " + err, "err");
      }
    }
    btn.addEventListener("click", async () => {
      const project = projSel.value;
      const preset = presetSel.value;
      if (!project || !preset) { setStatus("pick a project and a preset first", "err"); return; }
      setStatus("applying…", "");
      try {
        const r = await fetch("/api/policy/preset/" + encodeURIComponent(project), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset }),
        });
        const j = await r.json();
        if (j && j.ok) setStatus(`applied preset "${preset}" to ${j.path} (${j.bytes} bytes)`, "ok");
        else setStatus("apply failed: " + ((j && j.error) || r.status), "err");
      } catch (err) {
        setStatus("error: " + err, "err");
      }
    });
    let loaded = false;
    panelObserveActive("apply", () => { if (!loaded) { loaded = true; populate(); } });
  }

  // Watch for the named editor pane becoming active (clicking the tab) AND
  // for the Policy tab itself becoming visible. Fires the callback once
  // either condition first turns true.
  function panelObserveActive(editor, cb) {
    const pane = document.querySelector(`.policy-editor-pane[data-editor="${editor}"]`);
    const tab = document.querySelector(`.policy-editor-tab[data-editor="${editor}"]`);
    if (!pane || !tab) return;
    // If this is the "user" pane (the default-active), fire immediately when
    // the Policy tab is shown.
    function maybeFire() {
      if (document.body.getAttribute("data-active-tab") !== "policy") return;
      if (!pane.classList.contains("active")) return;
      cb();
    }
    tab.addEventListener("click", () => setTimeout(maybeFire, 50));
    new MutationObserver(maybeFire).observe(document.body, {
      attributes: true, attributeFilter: ["data-active-tab"],
    });
    maybeFire();
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
        return [
          '<div class="' + cls + '" data-notif-id="' + escapeHtml(n.id) + '">',
          '  <div class="notif-item-glyph">' + sevIcon + '</div>',
          '  <div class="notif-item-body">',
          '    <div class="notif-item-title">' + escapeHtml(n.title || "(no title)") + '</div>',
              detail,
          '    <div class="notif-item-meta">',
          '      <span class="notif-item-when" title="' + escapeHtml(n.ts || "") + '">' + escapeHtml(fmtRelative(n.ts)) + '</span>',
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
})();
