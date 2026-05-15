// dashboard/public/tabs/projects.js
//
// v2.8.6 — Projects tab (master/detail with drill-down + new-project
// wizard). Wave 9 of dashboard/public/app.js decomposition. Extracted
// verbatim from `wireProjectsTab` @ app.js:2532–2996 (section header +
// function body) and its boot call at app.js:453.
//
// FIRST tab to BOTH consume someone else's bridge AND own a
// window-prefixed cache of its own.
//
// **Consumes** (read-only references to globals published by other modules):
//   - `window.openVaultDeepLink` — published by tabs/vault.js (wave 6).
//     Used by the "Open in Vault Viewer" action button to deep-link to
//     `<project_name>/decisions.md` inside the master vault. The typeof
//     guard + `location.hash` / `nav.click()` fallback is preserved
//     verbatim because Vault might not have mounted yet — bootstrap-
//     mounting makes that case more likely (tabs are inert until first
//     activation). The fallback fires `nav.click()`, which flips
//     `data-active-tab`, which bootstrap.js's notifier catches → mounts
//     Vault → Vault's `MutationObserver` re-reads the hash and lands on
//     the requested note. See ORCHESTRATION.md wave-9 entry for the
//     architectural call on keeping this as a window global rather
//     than retiring to a `subctl:vault-deeplink` custom event.
//
//   - `window.__subctlAttachOneShotAssistantCapture` — published by
//     app.js right after `attachOneShotAssistantCapture` (line ~2530).
//     Used by the per-project chat form to capture the next assistant
//     turn into the project-scoped chat log after the operator submits
//     a project-scoped directive. Same `window.__subctl*` bridge idiom
//     as `tabs/logs.js` (wave 1, app.js helpers consumed via
//     `?.()` optional-chained calls). Bridge stays published as long
//     as Master chat lives in app.js — it'll retire when Master chat
//     extracts.
//
// **Owns** (window-prefixed cache published by this module):
//   - `window.__policyPresetsCache` — Projects-only lazy-memoized
//     fetch promise for `/api/policy/presets`. The cache is created
//     inside the per-project-detail render path (only when an operator
//     opens a project that has the Apply-preset dropdown) and reused
//     across every subsequent project open. A grep confirms ZERO
//     readers outside Projects, BUT the `window.`-prefix is the cheap
//     memoization that survives across the (theoretical) unmount/
//     remount cycle. Behavior parity > stylistic preference — we keep
//     it `window.`-prefixed verbatim instead of lifting to module
//     scope, and `unmount()` does NOT null it (it's a fetch promise,
//     no resources to release, and re-fetching on re-mount would
//     defeat the cache). See DECISIONS.md "wave 9" for the readout.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/projects
//   GET  /api/projects/<name>
//   POST /api/projects/create
//   GET  /api/policy/presets
//   POST /api/policy/preset/<encoded_path>
//   POST /api/master/chat                    (for spawn-team + pd-chat)
//   GET  /api/master/events                  (consumed via the
//                                             attachOneShotAssistantCapture
//                                             bridge — not a direct fetch)
//
// DOM contract (lives in index.html, unchanged):
//   List:   #projects-list, #project-list-filter, #projects-root,
//           #project-new-btn
//   Detail: #project-detail-pane, #project-detail-empty
//   Modal:  #new-project-modal, #new-project-close, #new-project-cancel,
//           #new-project-form, #new-project-submit, #np-name,
//           #np-name-preview, #np-status, #np-git-url, #np-autonomy,
//           #np-create-vault, #np-add-policy, #np-create-github,
//           #np-github-vis, #np-github-vis-row
//
// Lifecycle — ONE `setInterval` handle lifted to module scope:
//   - `pollTimer`: 30s refresh of the project list + reselection of
//     the currently-open project (so external changes — new git
//     clones, `subctl new-project` runs, policy updates — show up
//     without an operator reload).
//   - The original had a `getComputedStyle(panel).display` visibility
//     gate (app.js:2867–2868). Bootstrap-mounting is the new gate:
//     tabs only mount on first activation, so the gate is redundant
//     and the interval fires unconditionally. Same call as waves 4–8
//     made for their pollers.
//   - `unmount()` clears it.
//
// Document-scoped listener — the new-project modal installs
// `document.addEventListener("keydown", ...)` to close on Escape.
// Lifted to module scope (`documentKeydownHandler`) so `unmount()`
// can `removeEventListener`. Bootstrap never calls unmount today;
// forward-looking hygiene, mirrors wave 4 / wave 8's listener
// teardown discipline. (The lead's section-bounds notes flagged this
// as "no document listeners observed" — there IS one; this module
// handles it the same way every other wave has.)

export const id = "projects";

// Module-scope handles so `unmount()` can release them. Same idiom as
// wave 3 (`tabs/models.js`)'s `pollTimer` and wave 8 (`tabs/skills.js`)'s
// `documentClickHandler`. Bootstrap never calls unmount today; this is
// forward-looking hygiene.
let pollTimer = null;
let documentKeydownHandler = null;

export async function mount({ root: _root }) {
  // Inlined `$` helper — lived at app.js module scope (line 61). Same
  // idiom as every prior wave.
  function $(id) { return document.getElementById(id); }

  // Inlined `escapeText` helper — lived at app.js:2233. Used heavily
  // inside the detail render. Verbatim copy; app.js's original stays
  // put for the rest of app.js's consumers.
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Inlined `cssEscape` helper — lived at app.js:2454. Used by the
  // per-project chat log selector. One-line duplicate; chat code in
  // app.js still uses its own copy at line 3069.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

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
          // assistant turn after our submission. Helper lives in app.js
          // (still owns chat/tool-pill rendering) and is published on
          // window as `__subctlAttachOneShotAssistantCapture`. Same
          // `window.__subctl*` bridge idiom as wave-1 tabs/logs.js.
          window.__subctlAttachOneShotAssistantCapture?.(pdLog);
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
  // Bootstrap-mounting is the new visibility gate (tabs only mount on
  // first activation), so the original's `getComputedStyle(panel).display`
  // gate is dropped. Handle lifted to module scope so `unmount()` can
  // clear it. Same call as waves 4–8 made for their pollers.
  pollTimer = setInterval(() => {
    refreshList();
    if (selectedName) selectProject(selectedName);
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
  // Document-scoped Escape listener for the modal. Lifted to module
  // scope so `unmount()` can `removeEventListener`. Bootstrap never
  // calls unmount today; forward-looking hygiene, mirrors wave 4 /
  // wave 8's listener teardown discipline.
  documentKeydownHandler = (e) => {
    if (e.key === "Escape" && modal && !modal.hidden) closeModal();
  };
  document.addEventListener("keydown", documentKeydownHandler);
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

export function unmount() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (documentKeydownHandler) {
    document.removeEventListener("keydown", documentKeydownHandler);
    documentKeydownHandler = null;
  }
  // Intentionally do NOT null window.__policyPresetsCache — keep cache
  // alive across the (theoretical) unmount/remount cycle. It's a fetch
  // promise, no resources to release, and re-fetching on re-mount would
  // defeat the cache. See DECISIONS.md "wave 9" for the readout.
  //
  // Intentionally do NOT touch window.openVaultDeepLink (owned by
  // tabs/vault.js, wave 6) or window.__subctlAttachOneShotAssistantCapture
  // (owned by app.js's chat module). We only CONSUME those; nulling them
  // would break other consumers.
}
