// dashboard/public/tabs/skills.js
//
// v2.8.6 — Skills tab (catalog + import flow + v2.8.1 clarity card).
// Wave 8 of dashboard/public/app.js decomposition. Extracted verbatim
// from `wireSkillsTab` and `wireSkillsClarityView` @ app.js:793–1198
// (section header + two function bodies + the four module-scope
// helpers — `emptyCopyForCategory`, `renderSkillCard`, `whereCopyFor`,
// `showEvySkillBody` — and the `SKILLS_INFO_COPY` constant) and the
// boot call at app.js:463.
//
// Biggest tab so far (~406 LOC). Two module-scope entry points in
// app.js collapse into one `mount()`. The original wired up like this:
//   - `wireSkillsTab` boots, renders the catalog + import modal, then
//     calls `wireSkillsClarityView` at the bottom (line 990) to layer
//     the four-category clarity view on top.
// We preserve that ordering but call both setup functions directly
// from `mount()` so the entry points read top-down rather than the
// catalog body chaining into the clarity setup. Same multi-entry
// collapse pattern as wave 7 (`tabs/memory.js`).
//
// **Bridge preservation** — `window.__skillsClarityRefresh` is
// published from inside `mount()` for behavior parity. A
// `grep -rn '__skillsClarityRefresh'` across `dashboard/` and
// `components/master/` finds ZERO readers other than the assignment
// itself — the bridge is effectively dead inside the dashboard. BUT
// external consumers (the master daemon's `/master/skills/*` route, an
// operator bookmarklet, a browser extension) might still call into it,
// and this wave is purely a refactor. Retirement deferred to a
// separate housekeeping pass — see DECISIONS.md "wave 8" for the
// readout. `unmount()` nulls the bridge, same hygiene pattern as
// wave 6 (`window.openVaultDeepLink`).
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/skills
//   GET  /api/skills/<id>
//   GET  /api/skills/sources
//   GET  /api/skills/categorized
//   POST /api/skills/import
//   GET  /api/skills/evy/<name>
//   POST /api/skills/evy/<name>/promote
//   POST /api/skills/evy/<name>/delete
//
// DOM contract (lives in index.html, unchanged):
//   Catalog:  #skills-sources-list, #skills-sources-count, #skills-list,
//             #skills-meta, #skills-filter, #skills-detail-pane,
//             #skills-refresh-btn, #skills-import-btn
//   Modal:    #skills-import-modal, #skills-import-form,
//             #skills-import-close, #skills-import-cancel,
//             #skills-import-status, #skills-import-submit,
//             #skills-import-repo, #skills-import-source
//   Clarity:  #skills-info-popover, .skills-info-btn (popover triggers),
//             #skills-count-<cat>, #skills-list-<cat> for cat in
//             {evy-loaded, team-developer, evy-authored, project-local}
//
// Lifecycle — two `setInterval` handles lifted to module scope:
//   - `pollTimer`: 30s catalog refresh (sources + skills) so CLI-side
//     `subctl skills import` shows up without an operator reload.
//   - `clarityPollTimer`: 15s categorized refresh so Evy authoring or
//     promoting a skill during the session is reflected live.
//   - BOTH original timers had a `getComputedStyle(panel).display`
//     visibility gate (app.js:980–981 and 1057–1058). Bootstrap-
//     mounting is the new gate: tabs only mount on first activation,
//     so the gate is redundant and the interval fires unconditionally.
//     Same call as waves 4–7 made for their pollers.
//   - `unmount()` clears both.
//
// Document-scoped listener: the clarity popover installs
// `document.addEventListener("click", ...)` to close itself when the
// operator clicks outside. Lifted to module scope (`documentClickHandler`)
// so `unmount()` can `removeEventListener`. Bootstrap never calls
// unmount today; forward-looking hygiene, mirrors wave 4's listener
// teardown discipline.
//
// All other listeners (filter input, refresh button, source rows, skill
// rows, the [?] popover-trigger buttons, the import form's submit /
// close / cancel / overlay-click, per-card View/Promote/Delete buttons)
// are element-scoped and die with the panel DOM. The
// `setTimeout(closeImport, 2200)` after a successful import is one-shot
// and self-collecting.

export const id = "skills";

// Module-scope handles so `unmount()` can clear them. Same idiom as
// wave 7 (`tier1PollTimer` + `mainPollTimer` in tabs/memory.js) — first
// module in the decomposition to lift TWO timers AND a document-scoped
// click listener. The bridge global is published from inside `mount()`
// and nulled in `unmount()`, mirroring wave 6 (`window.openVaultDeepLink`).
let pollTimer = null;
let clarityPollTimer = null;
let documentClickHandler = null;

// ── v2.8.1 skills clarity ──
// Copy block for the four [?] popover triggers. Kept at module scope so
// each call to `setupClarityView` reuses the same object rather than
// re-allocating per mount. Verbatim from app.js:995–1004.
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

export async function mount({ root: _root }) {
  // Inlined `$` helper — lived at app.js module scope (line 61). Same
  // idiom as waves 3, 5, 6, 7.
  function $(id) { return document.getElementById(id); }

  // Inlined `escapeText` — lived at app.js module scope (line 2636).
  // Same form (no null-coercion, just text). Kept at mount scope so the
  // catalog renderer and the clarity helpers share one definition.
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ----- Catalog + import flow ------------------------------------
  // Verbatim from app.js:794–992 (`wireSkillsTab` body) minus:
  //   - the trailing `wireSkillsClarityView()` call at line 990 — lifted
  //     to `mount()` so the entry points read top-down,
  //   - the `setInterval` body which gets its timer handle lifted to
  //     the module-scope `pollTimer` and its visibility gate dropped.
  function setupCatalog() {
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
    // Light auto-refresh (catches CLI imports). Visibility gate dropped
    // (mount-on-activate is the new gate). Handle lifted to module
    // scope for unmount.
    pollTimer = setInterval(refresh, 30000);
  }

  // ----- v2.8.1 clarity card --------------------------------------
  // Verbatim from app.js:1006–1062 (`wireSkillsClarityView` body) minus
  // the `setInterval` body which gets its handle lifted to the module-
  // scope `clarityPollTimer` and its visibility gate dropped. The
  // document-scoped click handler (popover close-on-outside-click) is
  // lifted to module scope so `unmount()` can remove it. The bridge
  // assignment (`window.__skillsClarityRefresh = refreshCategorized;`)
  // stays inside this function exactly where the original placed it —
  // see file-top bridge note.
  function setupClarityView() {
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
    // Document-scoped — lifted to module scope (`documentClickHandler`)
    // so unmount can detach it.
    documentClickHandler = (e) => {
      if (!popover || popover.hidden) return;
      if (e.target.closest(".skills-info-popover") || e.target.closest(".skills-info-btn")) return;
      popover.hidden = true;
    };
    document.addEventListener("click", documentClickHandler);

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
    // Auto-refresh while mounted — catches Evy authoring or promoting
    // a skill during the session. Visibility gate dropped (mount-on-
    // activate is the new gate). Handle lifted to module scope for
    // unmount.
    clarityPollTimer = setInterval(refreshCategorized, 15000);
    // **Bridge preservation** — published for behavior parity. No
    // in-file readers but external (master daemon, extensions,
    // bookmarklets) unknown. Nulled in unmount(). See file-top note.
    window.__skillsClarityRefresh = refreshCategorized;
  }

  // The four module-scope helpers from app.js (`emptyCopyForCategory`,
  // `renderSkillCard`, `whereCopyFor`, `showEvySkillBody`) are inlined
  // at mount scope below — verbatim from app.js:1064–1196. They close
  // over the mount-scope `escapeText`. `renderSkillCard` takes a
  // `refresh` callback (`refreshCategorized` from `setupClarityView`)
  // so the Promote/Delete actions can re-render the category buckets.

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

  // Flat top-down orchestration. In the original, `wireSkillsTab`
  // boots the catalog + import flow and chains into
  // `wireSkillsClarityView` at line 990. We preserve the ordering but
  // call both from `mount()` directly so the entry points are visible
  // at the top of the extracted module rather than buried at the
  // bottom of the catalog setup. Same idiom as wave 7's multi-entry
  // collapse.
  setupCatalog();
  setupClarityView();
}

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (clarityPollTimer) { clearInterval(clarityPollTimer); clarityPollTimer = null; }
  if (documentClickHandler) {
    document.removeEventListener("click", documentClickHandler);
    documentClickHandler = null;
  }
  // Bridge teardown — symmetric with the publication in mount(). See
  // file-top bridge note; retirement deferred pending external-reader
  // audit.
  window.__skillsClarityRefresh = null;
}
