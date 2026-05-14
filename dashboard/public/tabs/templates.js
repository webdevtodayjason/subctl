// dashboard/public/tabs/templates.js
//
// v2.8.6 — Team Templates tab. Wave 2 of dashboard/public/app.js
// decomposition. Extracted verbatim from `wireV2TemplatesTab` @
// app.js:797–916 (and its leading comment block @ 793–796).
//
// Self-contained:
//   - reads  /api/team-templates           (list)
//   - reads  /api/team-templates/<name>    (detail)
//   - writes /api/orchestration/spawn      (POST)
//   - three browser prompts + alerts for the "use template" dialog
//
// Zero window.__subctl* bridges, zero shared state with app.js — proof
// point that the {id, mount, unmount} module interface scales to fully
// isolated tabs. See DECISIONS.md "wave 2" entry for the architectural
// readout.

export const id = "templates";

export async function mount({ root: _root }) {
  // Page-unique IDs — same idiom as wave-1 (logs.js) and the original
  // wireV2TemplatesTab. `$()` in app.js was just a getElementById wrapper.
  const list = document.getElementById("v2-template-list");
  const detail = document.getElementById("v2-template-detail");
  const refreshBtn = document.getElementById("v2-template-refresh-btn");
  if (!list || !detail) return;

  async function refresh() {
    list.innerHTML = '<div class="dim small" style="padding:18px">loading…</div>';
    try {
      const r = await fetch("/api/team-templates", { headers: { Accept: "application/json" } });
      const j = await r.json();
      if (!j.ok && (!j.templates || j.templates.length === 0)) {
        list.innerHTML = `<div class="dim small" style="padding:18px">no templates (${(j.errors || []).map((e) => e.name + ": " + e.error).join("; ") || "directory empty"})</div>`;
        return;
      }
      const rows = (j.templates || []).map((t) => {
        const devCount = (t.developers || []).length;
        return `<div class="team-row" data-name="${t.name}"><div class="team-row-name">${t.name}</div><div class="team-row-meta dim small">${devCount} dev${devCount === 1 ? "" : "s"} · ${(t.description || "").slice(0, 70)}</div></div>`;
      }).join("");
      list.innerHTML = rows || '<div class="dim small" style="padding:18px">(no templates)</div>';
      list.querySelectorAll(".team-row").forEach((row) => {
        row.addEventListener("click", () => showTemplate(row.getAttribute("data-name")));
      });
      if (j.errors && j.errors.length) {
        const errBox = document.createElement("div");
        errBox.className = "dim small";
        errBox.style.padding = "10px";
        errBox.style.color = "#f88";
        errBox.textContent = "errors: " + j.errors.map((e) => `${e.name}: ${e.error}`).join("; ");
        list.appendChild(errBox);
      }
    } catch (e) {
      list.innerHTML = `<div class="dim small" style="padding:18px;color:#f88">load failed: ${e.message}</div>`;
    }
  }

  async function showTemplate(name) {
    if (!name) return;
    detail.innerHTML = '<div class="dim small" style="padding:24px">loading…</div>';
    try {
      const r = await fetch(`/api/team-templates/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) {
        detail.innerHTML = `<div class="dim small" style="padding:24px;color:#f88">${j.error}</div>`;
        return;
      }
      const t = j.template;
      const devList = (t.developers || []).map((d) => {
        const skills = (d.skills || []).join(", ") || "(none)";
        const tools = (d.tools || []).join(", ") || "(none)";
        return `<div class="team-row" style="padding:10px;border-top:1px solid #222"><div><strong>${d.name}</strong> <span class="dim small">(${d.persona})</span></div><div class="dim small">skills: ${skills}</div><div class="dim small">tools: ${tools}</div></div>`;
      }).join("");
      const leadSkills = (t.lead.skills || []).join(", ") || "(none)";
      const useBtn = `<button class="primary-btn" id="v2-template-use-btn" data-name="${t.name}">Use this template…</button>`;
      detail.innerHTML = `
        <div style="padding:20px">
          <header style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div><h3 style="margin:0">${t.name}</h3><div class="dim small">${t.description || ""}</div></div>
            ${useBtn}
          </header>
          <section style="margin-bottom:18px">
            <h4 style="margin:0 0 6px 0">Lead</h4>
            <div class="dim small">persona: <code>${t.lead.persona}</code></div>
            <div class="dim small">skills: ${leadSkills}</div>
            <div class="dim small">autonomy: ${t.lead.autonomy || "ask"}</div>
          </section>
          <section>
            <h4 style="margin:0 0 6px 0">Developers (${(t.developers || []).length})</h4>
            <div>${devList}</div>
          </section>
          <details style="margin-top:18px">
            <summary class="dim small">Raw TOML</summary>
            <pre style="max-height:400px;overflow:auto;background:#0a0a0a;padding:10px;border:1px solid #222;border-radius:4px">${(t.source || "").replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c])}</pre>
          </details>
        </div>`;
      const useEl = document.getElementById("v2-template-use-btn");
      if (useEl) useEl.addEventListener("click", () => promptUseTemplate(t.name));
    } catch (e) {
      detail.innerHTML = `<div class="dim small" style="padding:24px;color:#f88">load failed: ${e.message}</div>`;
    }
  }

  function promptUseTemplate(name) {
    const project = window.prompt(`Spawn team from template "${name}".\nProject path (absolute):`, "");
    if (!project) return;
    const account = window.prompt("Account alias (e.g. claude-titanium):", "");
    if (!account) return;
    const prompt = window.prompt("Optional operator scope to append (leave blank for none):", "") || "";
    fetch("/api/orchestration/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account,
        project,
        team_template: name,
        prompt,
        skip_perms: true,
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          alert(`Spawned ${j.session_name || name}`);
        } else {
          alert(`Spawn failed: ${j.error || "unknown"}`);
        }
      })
      .catch((e) => alert(`Spawn failed: ${e.message}`));
  }

  if (refreshBtn) refreshBtn.addEventListener("click", refresh);

  // Preserve the original behavior: clicking the Templates nav-btn re-refreshes
  // the list. The bootstrap loader memoizes mount(), so without this listener
  // re-clicks would no longer trigger a re-fetch.
  document.querySelectorAll('[data-tab="templates"]').forEach((el) => {
    if (el.classList.contains("nav-btn")) {
      el.addEventListener("click", () => refresh());
    }
  });

  // Refresh once at mount so the list is warm before the operator clicks.
  refresh();
}

export function unmount() {
  // No long-lived resources to release (no SSE / timers / observers). The
  // export exists for interface parity with wave-1 and future tabs.
}
