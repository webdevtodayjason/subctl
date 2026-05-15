// dashboard/public/tabs/vault.js
//
// v2.8.6 — Vault tab (in-browser Obsidian-flavoured note browser). Wave 6
// of dashboard/public/app.js decomposition. Extracted verbatim from
// `wireVaultTab` @ app.js:1946–2255 (section header + body) and its boot
// call at app.js:455.
//
// FIRST tab to PUBLISH a window bridge global.
//   - `window.openVaultDeepLink` is assigned at the end of `mount()` so
//     other tabs can navigate the user to a specific note. The Projects
//     tab (wave 9, still in app.js at line ~3519) is the current
//     consumer; the fallback path on app.js:3522 fires only when this
//     module hasn't finished mounting yet.
//   - `unmount()` nulls the global. Bootstrap never calls unmount today,
//     so this is forward-looking hygiene that mirrors wave 4's listener
//     teardown discipline.
//   - The bridge STAYS published until Projects extracts (wave 9). At
//     that point we'll evaluate retiring it to a `subctl:vault-deeplink`
//     custom event. See DECISIONS.md "wave 6" entry for the readout.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET /api/vault/roots
//   GET /api/vault/<root>/tree
//   GET /api/vault/<root>/note?path=...
//   GET /api/vault/<root>/asset?path=...   (image embeds inside ![[...]])
//
// External lib: `window.marked` (the marked.js parser, loaded via a
// classic <script> tag in index.html). We wait for it to become ready
// with a `setTimeout` poll — fires once, no cleanup.
//
// Lifecycle:
//   - The original installed a `MutationObserver` on `document.body` for
//     `data-active-tab` changes so deep-link navigation from other tabs
//     re-runs `checkActive` and honors the current hash. Bootstrap-
//     mounting makes the FIRST mount-time `checkActive` redundant, but
//     the observer still has a real job: Projects calls
//     `openVaultDeepLink`, which fires `nav.click()`, which flips
//     `data-active-tab`, which the observer catches → `checkActive`
//     re-reads the hash. The observer handle is lifted to module scope
//     (`activeTabObserver`) so `unmount()` can disconnect it. Same idiom
//     as wave 3 (`tabs/models.js`)'s `pollTimer`.
//   - The `select.change` listener, all `.dir-label` / `.vault-tree-note`
//     / `.vault-wikilink` clicks, and the marked.js ready-poll
//     `setTimeout` are element-scoped or one-shot; they die with the
//     panel DOM (or never re-fire) and don't need explicit removal.

export const id = "vault";

// Module-scope observer handle so `unmount()` can disconnect. Same idiom
// as `pollTimer` in tabs/models.js — captured outside the mount closure
// so unmount can reach it. Bootstrap never calls unmount today; this is
// forward-looking hygiene.
let activeTabObserver = null;

export async function mount({ root: _root }) {
  // Inlined `$` helper — lived at app.js module scope (line 61). Same
  // idiom as wave 3 (tabs/models.js) and wave 5 (tabs/providers.js).
  function $(id) { return document.getElementById(id); }

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
  // Disconnect any previous observer before installing a fresh one —
  // mirrors the `clearInterval(pollTimer)` guard in tabs/models.js, in
  // case mount() ever runs more than once.
  if (activeTabObserver) activeTabObserver.disconnect();
  activeTabObserver = new MutationObserver(checkActive);
  activeTabObserver.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
  checkActive();

  // Expose a global navigation helper so other tabs (e.g. Projects) can
  // route the user to a specific note. Sets the hash, switches to the
  // Vault tab, lets checkActive() pick up the navigation.
  //
  // **Publisher bridge** — this is the first tab to publish a window
  // global. The Projects tab (still in app.js, wave 9) is the consumer.
  // Bridge stays published until Projects extracts; at that point we
  // evaluate retiring to a `subctl:vault-deeplink` custom event.
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

export function unmount() {
  // Bootstrap never calls unmount() today, but the cleanup is forward-
  // looking hygiene — symmetric with the publisher bridge installed in
  // mount(). Future Projects extraction (wave 9) will decide whether
  // this bridge graduates to a custom event.
  if (activeTabObserver) {
    activeTabObserver.disconnect();
    activeTabObserver = null;
  }
  window.openVaultDeepLink = null;
}
