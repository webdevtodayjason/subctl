// dashboard/public/tabs/preferences.js
//
// v2.8.6 — Preferences tab (bilateral-maintenance config). Wave 4 of
// dashboard/public/app.js decomposition. Extracted verbatim from
// `initPreferencesTab` @ app.js:8117–8402 (header comment + function body +
// DOMContentLoaded bootstrap block — all in the deletion range).
//
// FIRST module to exercise persistent listener lifecycle:
//   - `subctl:sse:preferences` DOM event → re-render on Evy/CLI writes
//   - `window.focus`                     → refresh-on-return fallback
//
// Both listeners are installed in `mount()` and removed in `unmount()`.
// Handler refs live at module scope (mirrors the `pollTimer` pattern in
// `tabs/models.js`) so unmount can read them — the closure variables they
// rely on (`loaded`, `renderAll`) survive via the function references.
// Bootstrap never calls unmount today, but the pattern is what Master chat
// will need at scale.
//
// Self-contained:
//   - reads/writes /api/preferences (+ /<cat>/<key> POST/DELETE, /reset POST)
//   - no shared state, no window.__subctl* bridges, no cross-tab references
//   - the MutationObserver `data-active-tab` watcher from the original is
//     intentionally dropped — the shell calls mount() on first activation

export const id = "preferences";

// Module-scope listener refs. Assigned inside mount(); cleared inside
// unmount(). Same idiom as `pollTimer` in tabs/models.js — captured outside
// the mount closure so unmount can reach them. Guarded `if (onSseEvent)`
// in unmount handles the `!root` early-return path.
let onSseEvent = null;
let onFocus = null;

export async function mount({ root: _root }) {
  const root = document.getElementById("prefs-list");
  if (!root) return;
  const refreshBtn = document.getElementById("prefs-refresh-btn");
  const addCatBtn = document.getElementById("prefs-add-cat-btn");
  const resetBtn = document.getElementById("prefs-reset-btn");
  let metaCache = null; // {category: {key: {by, at, reason?}}} fetched lazily
  let inflight = false;
  let loaded = false;

  function toast(msg, isError) {
    const el = document.createElement("div");
    el.className = "prefs-toast" + (isError ? " err" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function renderValue(v) {
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (v === "") return "(unset)";
    return String(v);
  }

  function valueInput(currentValue) {
    // booleans → select, others → text input. Numbers get coerced
    // server-side on save (see preferences.ts coerceValue).
    if (typeof currentValue === "boolean") {
      const sel = document.createElement("select");
      for (const opt of ["true", "false"]) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (String(currentValue) === opt) o.selected = true;
        sel.appendChild(o);
      }
      return sel;
    }
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = currentValue == null ? "" : String(currentValue);
    return inp;
  }

  async function fetchPrefs() {
    const r = await fetch("/api/preferences", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    return data && data.preferences ? data.preferences : {};
  }

  async function saveOne(category, key, value, by) {
    const r = await fetch(`/api/preferences/${encodeURIComponent(category)}/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, by: by || "operator" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error(data.error || "save failed");
    }
    return data;
  }

  async function deleteOne(category, key) {
    const r = await fetch(`/api/preferences/${encodeURIComponent(category)}/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error(data.error || "delete failed");
    }
    return data;
  }

  function rowEl(category, key, value, byMeta) {
    const row = document.createElement("div");
    row.className = "prefs-row";

    const keyEl = document.createElement("div");
    keyEl.className = "prefs-key";
    keyEl.textContent = key;

    const valueWrap = document.createElement("div");
    valueWrap.className = "prefs-value";
    const input = valueInput(value);
    valueWrap.appendChild(input);

    const badge = document.createElement("span");
    badge.className = "prefs-setby";
    const by = (byMeta && byMeta.by) || "default";
    badge.dataset.by = by;
    badge.textContent = "set by " + by;
    if (byMeta && byMeta.reason) {
      badge.title = byMeta.reason + (byMeta.at ? ` · ${byMeta.at}` : "");
    } else if (byMeta && byMeta.at) {
      badge.title = byMeta.at;
    }

    const actions = document.createElement("div");
    actions.className = "prefs-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "save";
    saveBtn.addEventListener("click", async () => {
      let raw;
      if (input.tagName === "SELECT") raw = input.value === "true";
      else raw = input.value;
      try {
        saveBtn.disabled = true;
        await saveOne(category, key, raw);
        toast(`${category}.${key} saved`);
        badge.dataset.by = "operator";
        badge.textContent = "set by operator";
      } catch (err) {
        toast(`save failed: ${err.message}`, true);
      } finally {
        saveBtn.disabled = false;
      }
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "prefs-del-btn";
    delBtn.textContent = "delete";
    delBtn.title = "Remove this preference (operator-defined keys only — defaults will reseed on reset)";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete ${category}.${key}?`)) return;
      try {
        await deleteOne(category, key);
        row.remove();
        toast(`${category}.${key} removed`);
      } catch (err) {
        toast(`delete failed: ${err.message}`, true);
      }
    });
    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);

    row.appendChild(keyEl);
    row.appendChild(valueWrap);
    row.appendChild(badge);
    row.appendChild(actions);
    return row;
  }

  function addRowEl(category) {
    // "+ Add new preference" row at the bottom of a category.
    const wrap = document.createElement("div");
    wrap.className = "prefs-add-row";
    const k = document.createElement("input");
    k.placeholder = "new_key";
    const v = document.createElement("input");
    v.placeholder = "value";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-btn";
    btn.textContent = "+ add";
    btn.addEventListener("click", async () => {
      const key = (k.value || "").trim();
      const val = (v.value || "").trim();
      if (!key) { toast("key required", true); return; }
      try {
        await saveOne(category, key, val);
        k.value = ""; v.value = "";
        toast(`${category}.${key} added`);
        renderAll();
      } catch (err) {
        toast(`add failed: ${err.message}`, true);
      }
    });
    wrap.appendChild(k);
    wrap.appendChild(v);
    wrap.appendChild(btn);
    return wrap;
  }

  async function renderAll() {
    if (inflight) return;
    inflight = true;
    try {
      const prefs = await fetchPrefs();
      root.innerHTML = "";
      const cats = Object.keys(prefs).sort();
      if (cats.length === 0) {
        root.textContent = "(no preferences set yet)";
        return;
      }
      for (const cat of cats) {
        const card = document.createElement("section");
        card.className = "prefs-cat";
        const head = document.createElement("header");
        head.className = "prefs-cat-head";
        const h = document.createElement("h3");
        h.textContent = cat;
        const meta = document.createElement("span");
        meta.className = "prefs-cat-meta";
        const count = Object.keys(prefs[cat] || {}).length;
        meta.textContent = `${count} pref${count === 1 ? "" : "s"}`;
        head.appendChild(h);
        head.appendChild(meta);
        head.addEventListener("click", () => {
          const collapsed = card.dataset.collapsed === "true";
          card.dataset.collapsed = collapsed ? "false" : "true";
        });
        const body = document.createElement("div");
        body.className = "prefs-cat-body";
        for (const [key, value] of Object.entries(prefs[cat])) {
          const byMeta = metaCache && metaCache[cat] ? metaCache[cat][key] : null;
          body.appendChild(rowEl(cat, key, value, byMeta));
        }
        body.appendChild(addRowEl(cat));
        card.appendChild(head);
        card.appendChild(body);
        root.appendChild(card);
      }
    } catch (err) {
      root.textContent = "load failed: " + err.message;
    } finally {
      inflight = false;
    }
  }

  if (refreshBtn) refreshBtn.addEventListener("click", renderAll);
  if (addCatBtn) addCatBtn.addEventListener("click", async () => {
    const cat = prompt("New category name (letters/digits/_/-):");
    if (!cat) return;
    const key = prompt(`First key for [${cat}]:`);
    if (!key) return;
    const val = prompt(`Value for ${cat}.${key}:`);
    if (val == null) return;
    try {
      await saveOne(cat.trim(), key.trim(), val);
      toast(`[${cat}].${key} added`);
      renderAll();
    } catch (err) {
      toast(`add failed: ${err.message}`, true);
    }
  });
  if (resetBtn) resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset ALL preferences to seeded defaults? Operator-added categories will be lost.")) return;
    try {
      const r = await fetch("/api/preferences/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) throw new Error(data.error || "reset failed");
      toast("preferences reset to defaults");
      renderAll();
    } catch (err) {
      toast("reset failed: " + err.message, true);
    }
  });

  // SSE `preferences` events fire on file changes (Evy / CLI / Telegram edits).
  // Tied into the existing WS dispatch via document event so we don't have to
  // refactor the central handler — startPolling/connectWS publishes "subctl:sse"
  // events for individual frames; window.focus is the refresh-on-return fallback.
  //
  // Handler refs assigned to module-scope vars so unmount() can remove them.
  onSseEvent = () => { if (loaded) renderAll(); };
  onFocus = () => { if (loaded) renderAll(); };
  document.addEventListener("subctl:sse:preferences", onSseEvent);
  window.addEventListener("focus", onFocus);

  // Shell calls mount() only on tab activation, so load unconditionally
  // (the original `if (active !== "preferences") return;` gate is moot now).
  loaded = true;
  renderAll();
}

export function unmount() {
  // Remove the persistent listeners installed in mount(). Bootstrap never
  // calls this today, but the pattern is what Master chat will need at
  // scale (first module to exercise persistent listener lifecycle).
  // Guards handle the `!root` early-return path where listeners never got
  // installed.
  if (onSseEvent) {
    document.removeEventListener("subctl:sse:preferences", onSseEvent);
    onSseEvent = null;
  }
  if (onFocus) {
    window.removeEventListener("focus", onFocus);
    onFocus = null;
  }
}
