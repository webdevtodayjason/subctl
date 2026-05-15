// dashboard/public/tabs/teams.js
//
// v2.8.6 — Teams tab (dev-team templates). Wave 12 of dashboard/public/app.js
// decomposition. Extracted verbatim from `wireTeamsTab` @ app.js:488–803
// (section header + body) and its boot call at app.js:461.
//
// Self-contained:
//   - reads   /api/skills              (catalog of skill IDs for the editor)
//   - reads   /api/teams/tools         (tool-family catalog for the editor)
//   - reads   /api/teams               (list dev-team templates)
//   - reads   /api/teams/<name>        (load template detail for view/edit)
//   - writes  /api/teams        (POST) (create template)
//   - writes  /api/teams/<name> (PUT)  (edit template)
//   - writes  /api/teams/<name> (DELETE) (delete template)
//   - no shared state, no window.__subctl* bridges, no cross-tab references
//   - inlines `$` / `escapeText` helpers that lived at app.js module scope;
//     same idiom as wave 5 (providers.js) and wave 10 (settings.js).
//
// NOTE on dispatch-spec drift: the wave-12 brief listed endpoints as
// `/api/team-templates` and a `POST /api/orchestration/spawn` call. Neither
// matches the actual code. The endpoints are `/api/teams[...]` and there is
// NO `/api/orchestration/spawn` call inside this section. This docstring
// reflects what the module actually does. See DECISIONS.md "wave 12" for
// the readout.
//
// Lifecycle:
//   - 30 s poll handle lifted to module scope (`pollTimer`) so unmount()
//     can clearInterval — parity with wave 5 (providers.js).
//   - The original setInterval body had a `getComputedStyle(panel).display
//     !== "none"` visibility gate; dropped here because the bootstrap
//     loader only mounts modules when the tab activates, making the gate
//     moot. Same simplification as waves 4–11.
//   - One-shot `setTimeout(closeModal, 900)` after a successful save —
//     left verbatim, no handle tracked (self-collecting).
//   - All other handlers (modal open/close, form submit, skills filter,
//     per-row buttons, edit/duplicate/delete actions inside the detail
//     pane) are element-scoped and die with the panel DOM. Only the
//     interval needs explicit teardown.
//   - Browser dialogs (`prompt` for duplicate-rename, `confirm` for delete,
//     `alert` for failure paths) are preserved verbatim; replacing them
//     with the dashboard's notification system is out of scope this wave.

export const id = "teams";

// Module-scope poll handle so unmount() can clear it. Parity with
// wave-5 (providers.js) — bootstrap never calls unmount today, but the
// hygiene is forward-looking.
let pollTimer = null;

export async function mount({ root: _root }) {
  // Inlined helpers — these lived at app.js module scope:
  //   `$` @ app.js:61, `escapeText` @ app.js (one of the duplicated copies).
  //   Same idiom as waves 3/5/10.
  function $(id) { return document.getElementById(id); }
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshList, 30000);
}

export function unmount() {
  // Interface parity with waves 1/3/4/5/etc. Bootstrap never calls this
  // today, but clearing the interval keeps us honest if it ever does.
  // All per-element listeners die with the panel DOM; only the
  // module-scope timer needs explicit teardown.
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
