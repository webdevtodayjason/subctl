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
        // v2.8.8 Phase 2c — Models panel. Renders a header with model
        // count, last-refreshed timestamp, and a Refresh button. The body
        // is lazily filled on first expand to avoid hammering /api/catalogs
        // for every card on initial render.
        const modelsSection = renderModelsPanel(p.id, p.display);
        body.appendChild(modelsSection);
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

  function renderModelsList(wrap, providerId, catalog, notice) {
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
      parts.push("<table style=\"width:100%;font-size:0.85em;border-collapse:collapse\">");
      parts.push("<thead><tr style=\"text-align:left;border-bottom:1px solid var(--border,#333)\">");
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
        parts.push(`<tr><td style="padding:3px 8px 3px 0;font-family:monospace">${escapeText(m.id)}${reason}</td>`);
        parts.push(`<td style="padding:3px 8px">${escapeText(m.name || "")}</td>`);
        parts.push(`<td style="padding:3px 8px;text-align:right">${ctx}</td>`);
        parts.push(`<td style="padding:3px 0 3px 8px;text-align:right">${costIn} / ${costOut}</td></tr>`);
      }
      parts.push("</tbody></table>");
    }
    body.innerHTML = parts.join("");
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
