// dashboard/public/tabs/providers.js
//
// v2.8.6 — Providers tab (per-provider profile management). Wave 5 of
// dashboard/public/app.js decomposition. Extracted verbatim from
// `wireProvidersTab` @ app.js:791–1058 (section header + body) and its
// boot call at app.js:466.
//
// Self-contained:
//   - reads   /api/providers                  (list cloud providers + profiles)
//   - writes  /api/providers/profiles  (POST) (add/edit profile in accounts.conf)
//   - writes  /api/providers/profiles  (DELETE) (remove profile from accounts.conf)
//   - no shared state, no window.__subctl* bridges, no cross-tab references
//   - inlines `$` / `escapeText` helpers that lived at app.js module scope;
//     same idiom as wave 3 (tabs/models.js) inlining `$ / td / emptyRow`
//
// Lifecycle:
//   - 30 s poll handle lifted to module scope (`pollTimer`) so unmount()
//     can clearInterval — parity with wave 1 (logs.js) / wave 3 (models.js).
//   - The original setInterval body had a `getComputedStyle(panel).display
//     !== "none"` visibility gate; dropped here because the bootstrap
//     loader only mounts modules when the tab activates, making the gate
//     moot. Mirrors the wave-4 dropping of the `MutationObserver` /
//     `data-active-tab` gate in Preferences.
//   - Modal close handlers, the form submit, the +New click, the fAlias/
//     fProvider suggest listeners, and the per-row auth/edit/delete
//     buttons are all attached to elements INSIDE the panel root and do
//     not need explicit removal in unmount(). Only the interval needs
//     teardown. See DECISIONS.md "wave 5" entry for the readout.

import { redactAlias } from "../lib/redact.js";

export const id = "providers";

// Module-scope poll handle so unmount() can clear it. Parity with
// wave-3 (models.js) — bootstrap never calls unmount today, but the
// hygiene is forward-looking.
let pollTimer = null;

export async function mount({ root: _root }) {
  // Inlined helpers — these lived at app.js module scope:
  //   `$` @ app.js:61, `escapeText` @ app.js:3214. Same idiom as wave 3
  //   (tabs/models.js) inlining `$ / td / emptyRow`.
  function $(id) { return document.getElementById(id); }
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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
      // Only render cards for providers with at least one configured profile.
      // The full catalog stays in the "+ New Profile" modal dropdown.
      const cloud = (j.providers || []).filter(
        (p) => p.kind === "cloud" && (p.profiles || []).length > 0,
      );
      if (!cloud.length) {
        list.innerHTML = "<div class=\"dim\">no profiles configured yet — click <strong>+ New Profile</strong> above to add one</div>";
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
              // v2.8.18 — alias is rendered through redactAlias() so an
              // api-key-shaped legacy alias (sk-/pk-/Bearer) doesn't leak.
              "<span class=\"alias\">" + escapeText(redactAlias(prof.alias)) + "</span>" +
              "<span class=\"email\">" + escapeText(prof.email || "—") + "</span>" +
              "<span class=\"config-dir\">" + escapeText(prof.config_dir || "") + "</span>";
            const actions = document.createElement("div");
            actions.className = "actions";
            // v2.8.9 — openai-codex aliases get an inline "Sign in" button
            // that drives the device-code flow from the dashboard instead
            // of copying a CLI command. Always shown (not gated on !authed)
            // so the operator can re-auth at any time.
            if (p.id === "openai-codex") {
              const signIn = document.createElement("button");
              signIn.type = "button";
              signIn.className = "auth-btn";
              signIn.textContent = prof.authed ? "re-auth" : "sign in";
              signIn.title = "open device-code login modal";
              signIn.addEventListener("click", () => openCodexAuthModal(prof.alias));
              actions.appendChild(signIn);
            } else if (!prof.authed) {
              // Other providers keep the existing "copy CLI command" UX
              // for now — Claude / Gemini have their own auth surfaces.
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
        // v2.8.8 Phase 2c — Models panel. Renders a header with model
        // count, last-refreshed timestamp, and a Refresh button. The body
        // is lazily filled on first expand to avoid hammering /api/catalogs
        // for every card on initial render.
        const modelsSection = renderModelsPanel(p.id, p.display);
        body.appendChild(modelsSection);
        // v2.9.1 Phase 3 — Browse Upstream Catalog button for aggregator
        // providers (OpenRouter, Bedrock, Vercel, Cloudflare). Opens a
        // modal sourced from /api/master/providers/<id>/upstream-catalog
        // with capability filters and a per-model enable checkbox that
        // flows through the existing /api/catalogs/<p>/models/<id>/enabled
        // endpoint. Non-aggregator providers (anthropic, openai, …) skip
        // this — their full catalog is enumerated in the Models panel
        // above and there's no upstream layer to browse.
        if (p.is_aggregator) {
          body.appendChild(renderUpstreamBrowseRow(p.id, p.display));
        }
        card.appendChild(body);
        return card;
      }));
    } catch (err) {
      list.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
    }
  }

  // Format a relative timestamp like "2m ago", "just now", "3h ago".
  // Used by the Models panel header for the "last refreshed" badge.
  function relativeTime(iso) {
    if (!iso) return "never";
    const t = new Date(iso).getTime();
    if (!t) return "—";
    const ageSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (ageSec < 5) return "just now";
    if (ageSec < 60) return ageSec + "s ago";
    if (ageSec < 3600) return Math.floor(ageSec / 60) + "m ago";
    if (ageSec < 86400) return Math.floor(ageSec / 3600) + "h ago";
    return Math.floor(ageSec / 86400) + "d ago";
  }

  // Build the Models panel for a given provider. Returns a <details>
  // element that the caller appends to the provider card. Lazy-fetches
  // the catalog on first expand.
  function renderModelsPanel(providerId, providerDisplay) {
    const wrap = document.createElement("details");
    wrap.className = "provider-card-models";
    wrap.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid var(--border,#333)";
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;font-size:0.9em;display:flex;align-items:center;gap:8px;list-style:none";
    summary.innerHTML = "<span class=\"models-summary-label\">Models · click to load</span>";
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.textContent = "↻ refresh";
    refreshBtn.style.cssText = "margin-left:auto;font-size:0.85em;padding:2px 8px";
    refreshBtn.addEventListener("click", async (e) => {
      // Don't toggle the <details> when clicking the refresh button.
      e.preventDefault();
      e.stopPropagation();
      refreshBtn.disabled = true;
      refreshBtn.textContent = "refreshing…";
      try {
        const r = await fetch(`/api/catalogs/${providerId}/refresh`, { method: "POST" });
        const j = await r.json();
        if (!j.ok) {
          refreshBtn.textContent = "failed";
          alert(`Refresh failed: ${j.error || "unknown"}`);
        } else {
          renderModelsList(wrap, providerId, j.catalog, j.notice);
          refreshBtn.textContent = "refreshed ✓";
        }
      } catch (err) {
        refreshBtn.textContent = "error";
        alert(`Refresh error: ${String(err)}`);
      } finally {
        setTimeout(() => { refreshBtn.disabled = false; refreshBtn.textContent = "↻ refresh"; }, 2000);
      }
    });
    summary.appendChild(refreshBtn);
    wrap.appendChild(summary);
    // Lazy load on first expand. Subsequent toggles use the cached DOM.
    let loaded = false;
    wrap.addEventListener("toggle", async () => {
      if (!wrap.open || loaded) return;
      loaded = true;
      try {
        const r = await fetch(`/api/catalogs/${providerId}`);
        const j = await r.json();
        if (!j.ok) {
          renderModelsListError(wrap, j.error || "unknown");
          return;
        }
        renderModelsList(wrap, providerId, j.catalog, null);
      } catch (err) {
        renderModelsListError(wrap, String(err));
      }
    });
    return wrap;
  }

  // v2.9.1 Phase 3 — Browse Upstream Catalog button for aggregator
  // providers. Returns a div that gets appended below the Models panel
  // on each aggregator card.
  function renderUpstreamBrowseRow(providerId, providerDisplay) {
    const row = document.createElement("div");
    row.className = "provider-card-upstream";
    row.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px dashed var(--border,#333);display:flex;align-items:center;gap:8px;font-size:0.85em";
    const label = document.createElement("span");
    label.className = "dim";
    label.textContent = `${providerDisplay} routes through an upstream catalog (~30 providers under namespaced ids)`;
    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.textContent = "Browse Upstream Catalog";
    browseBtn.style.cssText = "margin-left:auto;font-size:0.9em;padding:4px 12px;cursor:pointer";
    browseBtn.addEventListener("click", () => openUpstreamCatalogModal(providerId, providerDisplay));
    row.appendChild(label);
    row.appendChild(browseBtn);
    return row;
  }

  // v2.9.1 Phase 3 — Upstream Catalog modal. Lists every model the
  // aggregator's catalog endpoint returns, with cost / context /
  // capability columns plus filter controls. Per-row checkbox toggles
  // enable/disable via the existing /api/catalogs/<p>/models/<id>/enabled
  // endpoint shipped in v2.8.17.
  function openUpstreamCatalogModal(providerId, providerDisplay) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.6);" +
      "display:flex;align-items:center;justify-content:center;z-index:1000;" +
      "font-family:inherit";
    const dialog = document.createElement("div");
    dialog.style.cssText =
      "background:var(--bg,#1a1a1a);border:1px solid var(--border,#444);" +
      "border-radius:8px;padding:20px;max-width:1100px;width:95%;max-height:90vh;" +
      "color:var(--fg,#ddd);box-shadow:0 10px 40px rgba(0,0,0,0.5);" +
      "display:flex;flex-direction:column;gap:12px";
    overlay.appendChild(dialog);

    let allModels = [];   // last fetched UpstreamModel[]
    let filterState = { q: "", minCtx: 0, maxIn: Infinity, maxOut: Infinity, tools: false, vision: false, reasoning: false };

    function close() {
      document.removeEventListener("keydown", escListener);
      overlay.remove();
    }
    const escListener = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", escListener);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    // Header.
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border,#333);padding-bottom:8px";
    header.innerHTML =
      `<h2 style="margin:0;font-size:1.1em;flex:1">Upstream Catalog · ${escapeText(providerDisplay)}</h2>` +
      `<span class="upstream-source dim small"></span>` +
      `<button type="button" class="upstream-refresh" style="font-size:0.85em;padding:4px 10px">↻ refresh from upstream</button>` +
      `<button type="button" class="upstream-close" style="font-size:0.85em;padding:4px 10px">close</button>`;
    dialog.appendChild(header);
    header.querySelector(".upstream-close").addEventListener("click", close);

    // Filter bar.
    const filters = document.createElement("div");
    filters.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:0.85em;padding-bottom:4px";
    filters.innerHTML =
      `<input type="text" class="f-q" placeholder="search id or name" style="padding:4px 8px;min-width:200px;flex:1" />` +
      `<label>min ctx (k): <input type="number" class="f-ctx" min="0" step="8" value="0" style="width:70px;padding:2px 6px" /></label>` +
      `<label>max $in/M: <input type="number" class="f-in" min="0" step="0.5" placeholder="∞" style="width:80px;padding:2px 6px" /></label>` +
      `<label>max $out/M: <input type="number" class="f-out" min="0" step="0.5" placeholder="∞" style="width:80px;padding:2px 6px" /></label>` +
      `<label><input type="checkbox" class="f-tools" /> tools</label>` +
      `<label><input type="checkbox" class="f-vision" /> vision</label>` +
      `<label><input type="checkbox" class="f-reasoning" /> reasoning</label>` +
      `<span class="dim f-counts" style="margin-left:auto"></span>`;
    dialog.appendChild(filters);

    // Result body (scrollable).
    const body = document.createElement("div");
    body.style.cssText = "overflow-y:auto;flex:1;min-height:200px";
    body.innerHTML = `<div class="dim" style="padding:24px;text-align:center">loading upstream catalog…</div>`;
    dialog.appendChild(body);

    document.body.appendChild(overlay);

    function applyFilters() {
      filterState = {
        q: (filters.querySelector(".f-q").value || "").trim().toLowerCase(),
        minCtx: Number(filters.querySelector(".f-ctx").value) * 1000 || 0,
        maxIn: Number(filters.querySelector(".f-in").value) || Infinity,
        maxOut: Number(filters.querySelector(".f-out").value) || Infinity,
        tools: filters.querySelector(".f-tools").checked,
        vision: filters.querySelector(".f-vision").checked,
        reasoning: filters.querySelector(".f-reasoning").checked,
      };
      renderRows();
    }
    for (const sel of [".f-q", ".f-ctx", ".f-in", ".f-out"]) {
      filters.querySelector(sel).addEventListener("input", applyFilters);
    }
    for (const sel of [".f-tools", ".f-vision", ".f-reasoning"]) {
      filters.querySelector(sel).addEventListener("change", applyFilters);
    }

    async function loadCatalog(forceLive) {
      body.innerHTML = `<div class="dim" style="padding:24px;text-align:center">${forceLive ? "fetching from upstream…" : "loading…"}</div>`;
      const sourceLabel = header.querySelector(".upstream-source");
      try {
        const url = forceLive
          ? `/api/master/providers/${encodeURIComponent(providerId)}/upstream-catalog/refresh`
          : `/api/master/providers/${encodeURIComponent(providerId)}/upstream-catalog`;
        const r = await fetch(url, { method: forceLive ? "POST" : "GET" });
        const j = await r.json();
        if (!j.ok) {
          body.innerHTML =
            `<div style="padding:24px">` +
              `<div style="color:#c66;margin-bottom:8px">✗ ${escapeText(j.error || "unknown error")}</div>` +
              (j.hint ? `<div class="dim small">${escapeText(j.hint)}</div>` : "") +
            `</div>`;
          sourceLabel.textContent = "";
          return;
        }
        allModels = j.models || [];
        sourceLabel.textContent = `${j.source} · ${relativeTime(j.fetched_at)} · ${allModels.length} models`;
        // Also fetch the existing catalog so we know which are currently enabled.
        try {
          const catRes = await fetch(`/api/catalogs/${encodeURIComponent(providerId)}`);
          const catJson = await catRes.json();
          if (catJson.ok && Array.isArray(catJson.catalog?.models)) {
            const enabledSet = new Set(
              catJson.catalog.models.filter((m) => m.enabled !== false).map((m) => m.id),
            );
            for (const m of allModels) m._enabled = enabledSet.has(m.id);
          }
        } catch { /* enabled state lookup is best-effort */ }
        renderRows();
      } catch (err) {
        body.innerHTML = `<div style="color:#c66;padding:24px">fetch error: ${escapeText(String(err))}</div>`;
      }
    }

    function renderRows() {
      const filtered = allModels.filter((m) => {
        if (filterState.q) {
          const hay = ((m.id || "") + " " + (m.name || "")).toLowerCase();
          if (!hay.includes(filterState.q)) return false;
        }
        if (filterState.minCtx && (m.context_length || 0) < filterState.minCtx) return false;
        if (filterState.maxIn !== Infinity && (m.pricing_per_1m_input ?? Infinity) > filterState.maxIn) return false;
        if (filterState.maxOut !== Infinity && (m.pricing_per_1m_output ?? Infinity) > filterState.maxOut) return false;
        if (filterState.tools && !m.supports_tools) return false;
        if (filterState.vision && !m.supports_vision) return false;
        if (filterState.reasoning && !m.supports_reasoning) return false;
        return true;
      });
      const enabledCount = filtered.filter((m) => m._enabled).length;
      filters.querySelector(".f-counts").textContent = `${enabledCount}/${filtered.length} enabled · ${allModels.length} total`;

      if (!filtered.length) {
        body.innerHTML = `<div class="dim" style="padding:24px;text-align:center">no models match the current filters</div>`;
        return;
      }
      const parts = [];
      parts.push(`<table style="width:100%;font-size:0.85em;border-collapse:collapse">`);
      parts.push(`<thead><tr style="text-align:left;border-bottom:1px solid var(--border,#333);position:sticky;top:0;background:var(--bg,#1a1a1a)">`);
      parts.push(`<th style="padding:6px 4px 6px 0;width:32px" title="enabled — appears in chat dropdown">on</th>`);
      parts.push(`<th style="padding:6px 6px">id</th>`);
      parts.push(`<th style="padding:6px 6px">name</th>`);
      parts.push(`<th style="padding:6px 6px;text-align:right">ctx</th>`);
      parts.push(`<th style="padding:6px 6px;text-align:right">$in/M</th>`);
      parts.push(`<th style="padding:6px 6px;text-align:right">$out/M</th>`);
      parts.push(`<th style="padding:6px 0 6px 6px">caps</th>`);
      parts.push(`</tr></thead><tbody>`);
      for (const m of filtered) {
        const ctx = m.context_length ? (m.context_length / 1000).toFixed(0) + "k" : "—";
        const inC = m.pricing_per_1m_input != null ? "$" + m.pricing_per_1m_input.toFixed(2) : "—";
        const outC = m.pricing_per_1m_output != null ? "$" + m.pricing_per_1m_output.toFixed(2) : "—";
        const caps = [];
        if (m.supports_tools) caps.push(`<span title="tools" style="padding:1px 5px;background:rgba(120,180,255,0.2);border-radius:3px">🔧</span>`);
        if (m.supports_vision) caps.push(`<span title="vision" style="padding:1px 5px;background:rgba(120,255,180,0.2);border-radius:3px">👁</span>`);
        if (m.supports_reasoning) caps.push(`<span title="reasoning" style="padding:1px 5px;background:rgba(255,200,120,0.2);border-radius:3px">🧠</span>`);
        if (m.deprecated) caps.push(`<span title="deprecated" style="padding:1px 5px;background:rgba(255,120,120,0.2);border-radius:3px">⚠</span>`);
        parts.push(`<tr>`);
        parts.push(`<td style="padding:3px 4px 3px 0;text-align:center"><input type="checkbox" class="upstream-toggle" data-model="${escapeText(m.id)}" ${m._enabled ? "checked" : ""} title="enable for chat dropdown" style="cursor:pointer" /></td>`);
        parts.push(`<td style="padding:3px 6px;font-family:monospace">${escapeText(m.id)}</td>`);
        parts.push(`<td style="padding:3px 6px">${escapeText(m.name || "")}</td>`);
        parts.push(`<td style="padding:3px 6px;text-align:right">${ctx}</td>`);
        parts.push(`<td style="padding:3px 6px;text-align:right">${inC}</td>`);
        parts.push(`<td style="padding:3px 6px;text-align:right">${outC}</td>`);
        parts.push(`<td style="padding:3px 0 3px 6px">${caps.join(" ")}</td>`);
        parts.push(`</tr>`);
      }
      parts.push(`</tbody></table>`);
      body.innerHTML = parts.join("");
      // Wire enable-toggle checkboxes.
      for (const cb of body.querySelectorAll(".upstream-toggle")) {
        cb.addEventListener("change", async (e) => {
          const target = e.currentTarget;
          const modelId = target.getAttribute("data-model");
          const enabled = target.checked;
          target.disabled = true;
          try {
            const res = await fetch(
              `/api/catalogs/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/enabled`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled }),
              },
            );
            const j = await res.json();
            if (!j.ok) {
              alert(`Toggle failed: ${j.error || "unknown"}`);
              target.checked = !enabled;
            } else {
              const m = allModels.find((x) => x.id === modelId);
              if (m) m._enabled = enabled;
              // Update the counter without a full re-render.
              const cnt = filters.querySelector(".f-counts");
              if (cnt) {
                const enabledCount = allModels.filter((x) => x._enabled && shouldShowInFilter(x)).length;
                const totalFiltered = allModels.filter(shouldShowInFilter).length;
                cnt.textContent = `${enabledCount}/${totalFiltered} enabled · ${allModels.length} total`;
              }
            }
          } catch (err) {
            alert(`Toggle error: ${String(err)}`);
            target.checked = !enabled;
          } finally {
            target.disabled = false;
          }
        });
      }
    }

    // Filter predicate, broken out so the post-toggle counter update can
    // reuse the same logic without re-rendering everything.
    function shouldShowInFilter(m) {
      if (filterState.q) {
        const hay = ((m.id || "") + " " + (m.name || "")).toLowerCase();
        if (!hay.includes(filterState.q)) return false;
      }
      if (filterState.minCtx && (m.context_length || 0) < filterState.minCtx) return false;
      if (filterState.maxIn !== Infinity && (m.pricing_per_1m_input ?? Infinity) > filterState.maxIn) return false;
      if (filterState.maxOut !== Infinity && (m.pricing_per_1m_output ?? Infinity) > filterState.maxOut) return false;
      if (filterState.tools && !m.supports_tools) return false;
      if (filterState.vision && !m.supports_vision) return false;
      if (filterState.reasoning && !m.supports_reasoning) return false;
      return true;
    }

    header.querySelector(".upstream-refresh").addEventListener("click", () => loadCatalog(true));
    loadCatalog(false);
  }

  function renderModelsListError(wrap, msg) {
    let body = wrap.querySelector(".models-body");
    if (!body) {
      body = document.createElement("div");
      body.className = "models-body";
      body.style.cssText = "padding:8px 0";
      wrap.appendChild(body);
    }
    body.innerHTML = `<div class="dim small">error: ${escapeText(msg)}</div>`;
  }

  async function renderModelsList(wrap, providerId, catalog, notice) {
    // Update the summary label with model count + freshness.
    const label = wrap.querySelector(".models-summary-label");
    if (label) {
      const src = catalog.source === "live-fetch" ? "live" : "bundled";
      label.textContent = `Models (${catalog.models.length}) · ${src} · ${relativeTime(catalog.fetched_at)}`;
    }
    // Build or replace the body section.
    let body = wrap.querySelector(".models-body");
    if (!body) {
      body = document.createElement("div");
      body.className = "models-body";
      body.style.cssText = "padding:8px 0";
      wrap.appendChild(body);
    }
    const parts = [];
    if (notice) {
      parts.push(`<div class="dim small" style="padding:4px 0;font-style:italic">${escapeText(notice)}</div>`);
    }
    if (!catalog.models.length) {
      parts.push(`<div class="dim small">no models in catalog</div>`);
    } else {
      // v2.8.9 — fetch the effective default + source so we can render
      // the ★ radio next to the right model. /api/catalogs/<p> doesn't
      // include this today; hit the dedicated endpoint instead.
      let currentDefault = null;
      let defaultSource = "none";
      try {
        const dmRes = await fetch(`/api/providers/${encodeURIComponent(providerId)}/default-model`);
        const dmJson = await dmRes.json();
        if (dmJson.ok) {
          currentDefault = dmJson.default_model;
          defaultSource = dmJson.source;
        }
      } catch { /* best effort — radio just won't be filled */ }
      // v2.8.17 — bulk toggle toolbar. POSTs /api/catalogs/<p>/models/enabled-all
      // then re-renders the whole table via renderModelsList by re-fetching.
      const enabledCount = catalog.models.filter((m) => m.enabled !== false).length;
      parts.push(
        `<div class="models-bulk-toolbar" style="padding:6px 0 8px;display:flex;gap:6px;align-items:center;font-size:0.8em">` +
          `<span class="dim">${enabledCount}/${catalog.models.length} enabled</span>` +
          `<button type="button" class="codex-models-enable-all" data-provider="${escapeText(providerId)}" style="font-size:0.85em;padding:2px 8px;cursor:pointer">Enable all</button>` +
          `<button type="button" class="codex-models-disable-all" data-provider="${escapeText(providerId)}" style="font-size:0.85em;padding:2px 8px;cursor:pointer">Disable all</button>` +
        `</div>`,
      );
      parts.push("<table style=\"width:100%;font-size:0.85em;border-collapse:collapse\">");
      parts.push("<thead><tr style=\"text-align:left;border-bottom:1px solid var(--border,#333)\">");
      parts.push("<th style=\"padding:4px 4px 4px 0;width:28px\" title=\"enabled — appears in chat dropdown\">on</th>");
      parts.push("<th style=\"padding:4px 6px 4px 0;width:32px\" title=\"set as default for this provider\">★</th>");
      parts.push("<th style=\"padding:4px 8px 4px 0\">id</th>");
      parts.push("<th style=\"padding:4px 8px\">name</th>");
      parts.push("<th style=\"padding:4px 8px;text-align:right\">ctx</th>");
      parts.push("<th style=\"padding:4px 0 4px 8px;text-align:right\">$/M in/out</th>");
      parts.push("</tr></thead><tbody>");
      // Sort: reasoning models first (often the picks), then by id.
      const sorted = catalog.models.slice().sort((a, b) => {
        if (a.reasoning && !b.reasoning) return -1;
        if (!a.reasoning && b.reasoning) return 1;
        return (a.id || "").localeCompare(b.id || "");
      });
      for (const m of sorted) {
        const ctx = m.context_window ? m.context_window.toLocaleString() : "—";
        const costIn = m.cost?.input != null ? `$${m.cost.input.toFixed(2)}` : "—";
        const costOut = m.cost?.output != null ? `$${m.cost.output.toFixed(2)}` : "—";
        const reason = m.reasoning ? " 🧠" : "";
        const isDefault = currentDefault === m.id;
        const starIcon = isDefault
          ? (defaultSource === "operator" ? "★" : "☆")
          : "·";
        const starTitle = isDefault
          ? (defaultSource === "operator" ? "operator-chosen default — click to clear" : "shipped default (no operator override) — click to lock in")
          : "click to set as this provider's default";
        const starColor = isDefault && defaultSource === "operator"
          ? "color:#f5c518;font-weight:bold"
          : "color:var(--dim,#666)";
        const enabledChecked = m.enabled !== false; // default true if absent
        parts.push(`<tr data-default-model-id="${escapeText(m.id)}">`);
        parts.push(`<td style="padding:3px 4px 3px 0;text-align:center"><input type="checkbox" class="codex-model-enabled" data-provider="${escapeText(providerId)}" data-model="${escapeText(m.id)}" ${enabledChecked ? "checked" : ""} title="enable/disable this model" style="cursor:pointer" /></td>`);
        parts.push(`<td style="padding:3px 6px 3px 0;text-align:center"><button type="button" class="codex-default-radio" data-provider="${escapeText(providerId)}" data-model="${escapeText(m.id)}" data-is-default="${isDefault ? "1" : "0"}" data-source="${escapeText(defaultSource)}" title="${escapeText(starTitle)}" style="background:none;border:none;cursor:pointer;font-size:1.1em;padding:0;${starColor}">${starIcon}</button></td>`);
        parts.push(`<td style="padding:3px 8px 3px 0;font-family:monospace">${escapeText(m.id)}${reason}</td>`);
        parts.push(`<td style="padding:3px 8px">${escapeText(m.name || "")}</td>`);
        parts.push(`<td style="padding:3px 8px;text-align:right">${ctx}</td>`);
        parts.push(`<td style="padding:3px 0 3px 8px;text-align:right">${costIn} / ${costOut}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }
    body.innerHTML = parts.join("");
    // v2.8.9 — wire per-model enabled checkbox handlers. Flip the model's
    // enabled flag in the cached catalog file; the catalog re-renders below
    // so the new state is reflected.
    for (const cb of body.querySelectorAll(".codex-model-enabled")) {
      cb.addEventListener("change", async (e) => {
        const target = e.currentTarget;
        const provider = target.getAttribute("data-provider");
        const model = target.getAttribute("data-model");
        const enabled = target.checked;
        target.disabled = true;
        try {
          const res = await fetch(
            `/api/catalogs/${encodeURIComponent(provider)}/models/${encodeURIComponent(model)}/enabled`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled }),
            },
          );
          const j = await res.json();
          if (!j.ok) {
            alert(`Toggle failed: ${j.error || "unknown"}`);
            target.checked = !enabled; // revert visual
          }
        } catch (err) {
          alert(`Toggle error: ${String(err)}`);
          target.checked = !enabled;
        } finally {
          target.disabled = false;
        }
      });
    }
    // v2.8.17 — wire bulk Enable-all / Disable-all buttons. POSTs the bulk
    // endpoint, then re-fetches the catalog and re-renders the table so the
    // new state is reflected (checkboxes, count badge, everything in sync).
    async function bulkSetEnabled(provider, enabled, button) {
      button.disabled = true;
      const otherBtns = body.querySelectorAll(".codex-models-enable-all, .codex-models-disable-all");
      for (const b of otherBtns) b.disabled = true;
      try {
        const res = await fetch(
          `/api/catalogs/${encodeURIComponent(provider)}/models/enabled-all`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          },
        );
        const j = await res.json();
        if (!j.ok) {
          alert(`Bulk ${enabled ? "enable" : "disable"} failed: ${j.error || "unknown"}`);
          return;
        }
        const re = await fetch(`/api/catalogs/${encodeURIComponent(provider)}`);
        const reJ = await re.json();
        if (reJ.ok) {
          await renderModelsList(wrap, providerId, reJ.catalog, null);
        } else {
          alert(`Bulk ${enabled ? "enable" : "disable"} succeeded but catalog re-fetch failed (${reJ.error || "unknown"}). Click Refresh to update the view.`);
        }
      } catch (err) {
        alert(`Bulk toggle error: ${String(err)}`);
      } finally {
        for (const b of otherBtns) b.disabled = false;
      }
    }
    for (const b of body.querySelectorAll(".codex-models-enable-all")) {
      b.addEventListener("click", (e) => bulkSetEnabled(e.currentTarget.getAttribute("data-provider"), true, e.currentTarget));
    }
    for (const b of body.querySelectorAll(".codex-models-disable-all")) {
      b.addEventListener("click", (e) => bulkSetEnabled(e.currentTarget.getAttribute("data-provider"), false, e.currentTarget));
    }
    // v2.8.9 — wire star-click handlers AFTER innerHTML is set. Each click
    // toggles the operator override: if already-operator-default → DELETE
    // to clear; else POST to set as default.
    for (const btn of body.querySelectorAll(".codex-default-radio")) {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetBtn = e.currentTarget;
        const provider = targetBtn.getAttribute("data-provider");
        const model = targetBtn.getAttribute("data-model");
        const isOperatorDefault = targetBtn.getAttribute("data-is-default") === "1"
          && targetBtn.getAttribute("data-source") === "operator";
        const original = targetBtn.textContent;
        targetBtn.disabled = true;
        targetBtn.textContent = "…";
        try {
          let res;
          if (isOperatorDefault) {
            res = await fetch(`/api/providers/${encodeURIComponent(provider)}/default-model`, { method: "DELETE" });
          } else {
            res = await fetch(`/api/providers/${encodeURIComponent(provider)}/default-model`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model }),
            });
          }
          const j = await res.json();
          if (!j.ok) {
            alert(`Default-model update failed: ${j.error || "unknown"}`);
            targetBtn.textContent = original;
            return;
          }
          // Re-render the table by re-fetching the catalog.
          const catRes = await fetch(`/api/catalogs/${encodeURIComponent(providerId)}`);
          const catJson = await catRes.json();
          if (catJson.ok) {
            renderModelsList(wrap, providerId, catJson.catalog, null);
          }
        } catch (err) {
          alert(`Default-model update error: ${String(err)}`);
          targetBtn.textContent = original;
        } finally {
          targetBtn.disabled = false;
        }
      });
    }
  }

  // v2.8.9 — Codex OAuth modal. Opens when the operator clicks "sign in"
  // on an openai-codex profile row. POSTs /start to begin the device-code
  // flow, opens an EventSource on /events, renders the verification URL +
  // user code, and auto-closes on success.
  function openCodexAuthModal(alias) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.6);" +
      "display:flex;align-items:center;justify-content:center;z-index:1000;" +
      "font-family:inherit";
    const dialog = document.createElement("div");
    dialog.style.cssText =
      "background:var(--bg,#1a1a1a);border:1px solid var(--border,#444);" +
      "border-radius:8px;padding:24px;max-width:500px;width:90%;" +
      "color:var(--fg,#ddd);box-shadow:0 10px 40px rgba(0,0,0,0.5)";
    overlay.appendChild(dialog);

    let evtSource = null;
    let cancelled = false;
    const close = async () => {
      try { if (evtSource) evtSource.close(); } catch { /* ignore */ }
      if (!cancelled) {
        // Best-effort cancel on server so the poll loop stops.
        try {
          await fetch(`/api/auth/openai-codex/${encodeURIComponent(alias)}/cancel`, {
            method: "POST",
          });
        } catch { /* ignore */ }
      }
      overlay.remove();
    };

    function render(content) {
      dialog.innerHTML = content;
      // Hook up close button if present.
      const closeBtn = dialog.querySelector("[data-codex-close]");
      if (closeBtn) closeBtn.addEventListener("click", close);
    }

    function renderStatus(title, message, allowClose = true) {
      render(
        `<h2 style="margin:0 0 12px;font-size:1.1em">${escapeText(title)}</h2>` +
          `<p style="margin:0 0 16px;color:var(--dim,#999)">${escapeText(message)}</p>` +
          (allowClose
            ? `<div style="text-align:right"><button type="button" data-codex-close style="padding:6px 14px">close</button></div>`
            : ""),
      );
    }

    function renderVerification(verificationUrl, userCode, expiresInMs) {
      const mins = Math.floor(expiresInMs / 60_000);
      render(
        `<h2 style="margin:0 0 12px;font-size:1.1em">Sign in to ChatGPT — ${escapeText(redactAlias(alias))}</h2>` +
          `<p style="margin:0 0 8px;color:var(--dim,#999);font-size:0.9em">In another tab, open this URL:</p>` +
          `<div style="margin:0 0 16px"><a href="${escapeText(verificationUrl)}" target="_blank" style="font-family:monospace;color:var(--accent,#88f);word-break:break-all">${escapeText(verificationUrl)}</a></div>` +
          `<p style="margin:0 0 8px;color:var(--dim,#999);font-size:0.9em">and enter this code:</p>` +
          `<div style="margin:0 0 16px;padding:16px;background:rgba(255,255,255,0.05);border-radius:4px;text-align:center"><span style="font-family:monospace;font-size:1.6em;font-weight:bold;letter-spacing:0.15em">${escapeText(userCode)}</span></div>` +
          `<p style="margin:0 0 8px;color:var(--dim,#999);font-size:0.85em">⏱ expires in ${mins} min · waiting for browser confirm…</p>` +
          `<p id="codex-modal-status" style="margin:8px 0 16px;color:var(--dim,#999);font-size:0.85em;font-style:italic"></p>` +
          `<div style="text-align:right"><button type="button" data-codex-close style="padding:6px 14px">cancel</button></div>`,
      );
    }

    function renderSuccess(authPath, expiresAt, accountId) {
      const expDate = new Date(expiresAt);
      render(
        `<h2 style="margin:0 0 12px;font-size:1.1em;color:#6c6">✓ signed in — ${escapeText(redactAlias(alias))}</h2>` +
          `<dl style="margin:0 0 16px;font-size:0.9em">` +
          `<dt style="color:var(--dim,#999)">tokens written to</dt>` +
          `<dd style="margin:4px 0 8px;font-family:monospace">${escapeText(authPath)}</dd>` +
          `<dt style="color:var(--dim,#999)">expires</dt>` +
          `<dd style="margin:4px 0 8px">${escapeText(expDate.toLocaleString())} (master will auto-refresh)</dd>` +
          (accountId
            ? `<dt style="color:var(--dim,#999)">chatgpt account</dt>` +
              `<dd style="margin:4px 0 8px;font-family:monospace;font-size:0.85em">${escapeText(accountId)}</dd>`
            : "") +
          `</dl>` +
          `<div style="text-align:right"><button type="button" data-codex-close style="padding:6px 14px">done</button></div>`,
      );
    }

    function renderFailed(message) {
      render(
        `<h2 style="margin:0 0 12px;font-size:1.1em;color:#c66">✗ sign-in failed</h2>` +
          `<p style="margin:0 0 16px;font-family:monospace;font-size:0.85em;background:rgba(255,255,255,0.05);padding:8px;border-radius:4px">${escapeText(message)}</p>` +
          `<div style="text-align:right"><button type="button" data-codex-close style="padding:6px 14px">close</button></div>`,
      );
    }

    renderStatus("Connecting…", `Starting device-code flow for ${alias}.`);

    // Allow Escape to cancel.
    const escListener = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", escListener);
    overlay.addEventListener("remove", () =>
      document.removeEventListener("keydown", escListener),
    );

    document.body.appendChild(overlay);

    // POST /start, then open EventSource.
    (async () => {
      try {
        const startRes = await fetch(
          `/api/auth/openai-codex/${encodeURIComponent(alias)}/start`,
          { method: "POST" },
        );
        const startJson = await startRes.json();
        if (!startJson.ok) {
          renderFailed(startJson.error || "failed to start auth session");
          cancelled = true;
          return;
        }
      } catch (err) {
        renderFailed(String(err));
        cancelled = true;
        return;
      }
      evtSource = new EventSource(
        `/api/auth/openai-codex/${encodeURIComponent(alias)}/events`,
      );
      evtSource.addEventListener("verification", (e) => {
        const d = JSON.parse(e.data);
        renderVerification(d.verification_url, d.user_code, d.expires_in_ms);
      });
      evtSource.addEventListener("progress", (e) => {
        const d = JSON.parse(e.data);
        const status = document.getElementById("codex-modal-status");
        if (status) status.textContent = d.message || "";
      });
      evtSource.addEventListener("success", (e) => {
        const d = JSON.parse(e.data);
        renderSuccess(d.auth_path, d.expires_at, d.chatgpt_account_id);
        cancelled = true; // no need to send cancel — flow already done
        try { evtSource.close(); } catch { /* ignore */ }
        // Refresh the provider card so the alias's authed badge updates.
        setTimeout(() => refresh(), 500);
      });
      evtSource.addEventListener("failed", (e) => {
        const d = JSON.parse(e.data);
        renderFailed(d.error || "unknown failure");
        cancelled = true;
        try { evtSource.close(); } catch { /* ignore */ }
      });
      evtSource.addEventListener("closed", () => {
        try { evtSource.close(); } catch { /* ignore */ }
      });
      evtSource.onerror = () => {
        // EventSource auto-reconnects; only surface if no verification
        // has been seen yet.
        if (!dialog.querySelector("[data-codex-close]")) {
          renderFailed("event stream error — server may be unreachable");
        }
      };
    })();
  }

  refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 30000);
}

export function unmount() {
  // Interface parity with waves 1+3+4 (logs.js, models.js, preferences.js).
  // Bootstrap never calls this today, but clearing the interval keeps us
  // honest if it ever does. All per-element listeners die with the panel
  // DOM; only the module-scope timer needs explicit teardown.
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
