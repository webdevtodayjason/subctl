// dashboard/public/tabs/memory.js
//
// v2.8.6 — Memory tab (Obsidian vault status + Tier-1 operator editors +
// Tier-3 conversational memory). Wave 7 of dashboard/public/app.js
// decomposition. Extracted verbatim from `wireTier1MemoryCards`,
// `wireMemoryTab`, and `wireEvyMemoryCard` @ app.js:3400–3680 (the
// section header + three function bodies), plus the boot call at
// app.js:454.
//
// FIRST tab in the decomposition with multiple internal entry points.
// In app.js, `wireMemoryTab` was the single boot call; it called
// `wireTier1MemoryCards` at the top and `wireEvyMemoryCard` at the
// bottom. Three module-scope functions collapse into one `mount()` here,
// inlined as three local declarations preserving the original code
// flow. We flatten the orchestration: `mount()` calls all three
// directly so the entry points read top-down rather than nesting the
// dispatch inside the main-panel setup. See DECISIONS.md "wave 7" for
// the readout.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/memory/tier1
//   POST /api/memory/tier1
//   GET  /api/memory
//   GET  /api/memory/recent
//   GET  /api/memory/search
//   GET  /api/memory/stats
//   DELETE /api/memory/entries/<id>
//
// DOM contract (lives in index.html, unchanged):
//   Tier-1:  #user-md-textarea, #memory-md-textarea, #user-md-meta,
//            #memory-md-meta, #user-md-result, #memory-md-result,
//            [data-mem-save]
//   Main:    #memory-status, #memory-content, #memory-panel,
//            section[data-tab="memory"]
//   Evy:     #evy-memory-card, #evy-mem-list, #evy-mem-meta,
//            #evy-mem-search, #evy-mem-kind, #evy-mem-search-btn,
//            #evy-mem-refresh-btn
//
// Lifecycle — two `setInterval` handles lifted to module scope:
//   - `tier1PollTimer`: 15s refresh of the operator-facing user.md /
//     memory.md editors, so master's own `memory_remember` writes show
//     up without a manual reload.
//   - `mainPollTimer`: 30s refresh of the vault list / onboarding card.
//   - BOTH original timers had a `getComputedStyle(panel).display`
//     visibility gate (lines 3466–3468 and 3545–3548 in app.js).
//     Bootstrap-mounting is the new gate: tabs only mount on first
//     activation, so the gate is now redundant and the interval fires
//     unconditionally. Same call as waves 4–6 made for their pollers.
//   - `unmount()` clears both. Bootstrap never calls `unmount` today;
//     this is forward-looking hygiene, mirroring waves 1–6.
//
// HOST_LABEL handling: app.js has a module-scope `let HOST_LABEL` that
// `/api/host` patches asynchronously. The onboarding string is the only
// consumer here. Per DECISIONS.md "wave 7" we use the same default
// (`"this Mac"`) and DO NOT re-derive the async path — the cost of
// importing/duplicating it for one Obsidian-not-installed onboarding
// render isn't worth the cross-tab coupling. Acceptable drift: the
// onboarding card may say "this Mac" even after the operator has set a
// custom host_label, until they reload the dashboard.
//
// External listeners (element-scoped): textarea inputs, [data-mem-save]
// click handlers, search/refresh/kind controls, per-entry forget
// buttons. All die with the panel DOM; no explicit removal needed in
// unmount.

export const id = "memory";

// Module-scope poll-timer handles so `unmount()` can clear them. Same
// idiom as wave 3 (tabs/models.js)'s `pollTimer` and wave 5
// (tabs/providers.js)'s `pollTimer`. First module in the decomposition
// to lift TWO timers — preserves the original cadences (15s / 30s) and
// matches the original tier-1 vs. main-panel separation of concerns.
let tier1PollTimer = null;
let mainPollTimer = null;

export async function mount({ root: _root }) {
  // Inlined `$` helper — lived at app.js module scope (line 61). Same
  // idiom as waves 3, 5, 6.
  function $(id) { return document.getElementById(id); }

  // Unified `esc` helper. The original code had two near-identical
  // implementations: an `escapeForHtml` inside `wireMemoryTab` (line
  // 3540) and an `esc` inside `wireEvyMemoryCard` (line 3568). Same
  // behavior on `&`, `<`, `>`, `"`; the Evy version also stringified
  // `null`/`undefined` to `""`. We adopt that null-safe form for both
  // call sites — strictly broader, never narrower.
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // See file-top comment on HOST_LABEL. Same default as app.js:14.
  const HOST_LABEL = "this Mac";

  // ----- Tier-1 cards (user.md + memory.md operator editors) ---------
  // Verbatim from app.js:3404–3469 (wireTier1MemoryCards). The 15s
  // refresh interval was visibility-gated; that gate is dropped (mount-
  // on-activate is the new gate). Timer handle lifted to module scope.
  function setupTier1Cards() {
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

    // Refresh from disk every 15s — picks up master's own
    // memory_remember writes without operator action. Visibility gate
    // dropped (see file-top lifecycle note).
    tier1PollTimer = setInterval(load, 15000);
  }

  // ----- Main panel (Obsidian vault status + onboarding) -------------
  // Verbatim from app.js:3471–3553 minus (a) the leading
  // `wireTier1MemoryCards()` call, (b) the trailing `wireEvyMemoryCard()`
  // call — both lifted to `mount()` so the entry points read top-down,
  // (c) the local `escapeForHtml` declaration which is now the
  // mount-scope `esc`, and (d) the 30s interval visibility gate (mount-
  // on-activate replaces it). Timer handle lifted to module scope.
  function setupMainPanel() {
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
              `<h3>Obsidian is not installed on ${esc(HOST_LABEL)}</h3>` +
              `<p>The master's long-term memory lives in Obsidian vaults — project portfolios, decisions, RESUME.md per project, references that survive across sessions. Install on ${esc(HOST_LABEL)}:</p>` +
              "<pre class=\"memory-cmd\">brew install --cask obsidian</pre>" +
              "<p>Then create a vault at:</p>" +
              "<pre class=\"memory-cmd\">" + esc(j.suggested_vault_path) + "</pre>" +
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
              "<p>Create one at <code>" + esc(j.suggested_vault_path) + "</code> and add a <code>.obsidian</code> directory (Obsidian creates this automatically when you point it at a folder).</p>" +
            "</div>";
          return;
        }
        const rows = j.vaults.map((v) =>
          "<tr>" +
            "<td><code>" + esc(v.path) + "</code></td>" +
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
        content.innerHTML = "<p class=\"dim\">fetch error: " + esc(String(err)) + "</p>";
        if (status) { status.textContent = "error"; status.dataset.state = "err"; }
      }
    }

    refresh();
    mainPollTimer = setInterval(refresh, 30000);
  }

  // ----- Evy Memory Tier-3 card (FTS5-backed conversational memory) ---
  // Verbatim from app.js:3557–3679 (wireEvyMemoryCard). The local `esc`
  // helper at the top is now the mount-scope `esc`. All listeners are
  // element-scoped; no timer to lift here.
  function setupEvyCard() {
    const card = $("evy-memory-card");
    if (!card) return;
    const list = $("evy-mem-list");
    const meta = $("evy-mem-meta");
    const search = $("evy-mem-search");
    const kindSel = $("evy-mem-kind");
    const searchBtn = $("evy-mem-search-btn");
    const refreshBtn = $("evy-mem-refresh-btn");
    if (!list) return;

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

  // Flat top-down orchestration. In the original, wireMemoryTab called
  // wireTier1MemoryCards first and wireEvyMemoryCard last with the main
  // panel work in between. We preserve that ordering but call all three
  // from mount() directly so the entry points are visible at the top of
  // the extracted module rather than buried inside setupMainPanel.
  setupTier1Cards();
  setupMainPanel();
  setupEvyCard();
}

export function unmount() {
  if (tier1PollTimer) { clearInterval(tier1PollTimer); tier1PollTimer = null; }
  if (mainPollTimer) { clearInterval(mainPollTimer); mainPollTimer = null; }
}
