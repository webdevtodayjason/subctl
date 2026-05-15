// dashboard/public/tabs/policy.js
//
// v2.8.6 — Policy tab. Wave 11 of dashboard/public/app.js decomposition.
// Extracted from `wirePolicyTab` and its sub-editors at app.js:4623–5225
// plus `refreshPolicyTeamsForDropdowns` (4576–4608), `cachedTeams` (4520),
// and the boot call at app.js:479.
//
// ── Bridge retirement ──────────────────────────────────────────────────
// Wave 1 left three temporary `window.__subctl*` globals in app.js:
//   - window.__subctlGetPolicyTeams       (cachedTeams reader)
//   - window.__subctlRefreshPolicyTeams   (team-list refresher)
//   - window.__subctlRenderAuditEntries   (shared audit renderer)
// All three are GONE as of this wave. The new contract is:
//
//   This module PUBLISHES a custom DOM event on `document`:
//     "subctl:policy-teams-updated"
//        detail: { teams: PolicyTeam[] }
//   Dispatched at the end of every successful refresh.
//
//   This module SUBSCRIBES to a custom DOM event on `document`:
//     "subctl:policy-teams-refresh-request"
//        detail: (none)
//   Logs's chip fires this when it activates and needs fresh teams.
//   We fulfill by calling refreshPolicyTeams(), which then publishes the
//   "updated" event the chip is one-shot-listening for.
//
//   The audit-renderer trio (fmtAuditLine / classifyAuditLine /
//   renderAuditEntries) lived next to the team-fetch in app.js but was
//   consumed ONLY by the Logs chip. It moved to tabs/logs.js — Logs owns
//   its own renderers now.
//
//   The DOM cross-write that previously populated BOTH
//   #policy-resolved-team and #logs-policy-team from a single helper has
//   been split: each tab now populates its own selector. Logs populates
//   #logs-policy-team in its event listener; this module populates only
//   #policy-resolved-team here.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/policy/teams
//   GET  /api/policy/resolved/<team>
//   GET  /api/policy/user
//   POST /api/policy/user                        (body: { doc })
//   GET  /api/policy/project/<encoded-path>
//   POST /api/policy/project/<encoded-path>      (body: { doc })
//   POST /api/policy/preset/<encoded-path>       (body: { preset })
//   GET  /api/policy/presets
//   GET  /api/projects
//   GET  /api/audit/aggregate?since=24h&top=10
//
// Lifecycle:
//   mount({ root }) — wires the tab body + editor sub-panels, installs
//     the refresh-request listener, kicks off the initial refresh.
//   unmount()        — removes the refresh-request listener. The
//     MutationObservers + visibility-driven polling timer remain
//     unfreed, matching wave-1-through-10 parity. Bootstrap never calls
//     unmount() today; this is forward-looking hygiene.

export const id = "policy";

// ── Module-scope state ──────────────────────────────────────────────────
// `cachedTeams` lived at app.js IIFE scope (line 4520). It moves here as
// the canonical owner. Logs keeps its own copy in module-scope via the
// teams-updated event payload.
let cachedTeams = [];

// Handle for the document-level "refresh-request" listener so unmount()
// can detach. Null when unmounted.
let onRefreshRequest = null;

export async function mount({ root: _root }) {
  // ── tiny helpers ─────────────────────────────────────────────────────
  // Inlined for parity with app.js's IIFE `$`/`escapeHtml`/`emptyRow`.
  // Each prior wave inlines these so the module is self-contained.
  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]));
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

  // ── Team-list refresher ─────────────────────────────────────────────
  // Was `refreshPolicyTeamsForDropdowns` in app.js. The old impl wrote to
  // BOTH #policy-resolved-team and #logs-policy-team in one pass. The new
  // contract: Policy populates only its own selector here; Logs populates
  // #logs-policy-team in response to the "subctl:policy-teams-updated"
  // event we dispatch at the end.
  async function refreshPolicyTeams() {
    try {
      const r = await fetch("/api/policy/teams");
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.ok) return;
      cachedTeams = j.teams || [];

      const sel = $("policy-resolved-team");
      if (sel) {
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
          if (prev && cachedTeams.some((t) => t.team_id === prev)) sel.value = prev;
        }
      }

      document.dispatchEvent(new CustomEvent("subctl:policy-teams-updated", {
        detail: { teams: cachedTeams.slice() },
      }));
    } catch { /* dashboard idle — fine */ }
  }

  // Subscribe to Logs's refresh request BEFORE the initial refresh so a
  // racing listener never misses an update emitted in the same tick.
  onRefreshRequest = () => { void refreshPolicyTeams(); };
  document.addEventListener("subctl:policy-teams-refresh-request", onRefreshRequest);

  // Kick off the initial population. Any module that subscribed to
  // "subctl:policy-teams-updated" before this resolves will get the
  // first batch when the fetch returns.
  void refreshPolicyTeams();

  // ── Policy tab body ─────────────────────────────────────────────────
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
        await refreshPolicyTeams();
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

  // Fire the original boot call — same shape as `wirePolicyTab();` at
  // app.js:479 before extraction.
  wirePolicyTab();
}

export function unmount() {
  if (onRefreshRequest) {
    document.removeEventListener("subctl:policy-teams-refresh-request", onRefreshRequest);
    onRefreshRequest = null;
  }
}
