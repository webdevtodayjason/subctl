// dashboard/public/tabs/memory.js
//
// v2.8.7 — Memory tab rebuild. Six panels surface the full v2.8.7 memory
// stack: Memori sidecar, Cognee sidecar, consciousness cycle, Tier 1
// candidate queue, curated memories browser, backfill controls, cognify
// trigger. Replaces the previous single-pane Tier 1 / Tier 3 / Obsidian
// layout (which lived in the pre-rebuild memory.js).
//
// The previous Tier 1 editors + Obsidian vault status + Evy memory
// list are preserved by re-rendering them inside the new panels with
// their original IDs, so the rest of the dashboard (handlers, tests,
// search) keeps working without modification.
//
// HTTP endpoints consumed:
//   GET    /api/memory/tier1                      — Tier 1 user.md + memory.md
//   POST   /api/memory/tier1                      — save Tier 1
//   GET    /api/memory                            — Obsidian vault status
//   GET    /api/memory/recent                     — Tier 3 recent entries
//   GET    /api/memory/search                     — Tier 3 search
//   GET    /api/memory/stats                      — Tier 3 stats
//   DELETE /api/memory/entries/<id>               — Tier 3 forget
//   GET    /api/master/memory/kernel/status       — consciousness cycle state
//   POST   /api/master/memory/kernel/run-now      — force one cycle
//   POST   /api/master/memory/kernel/pause        — pause auto-cycle
//   POST   /api/master/memory/kernel/resume       — resume auto-cycle
//   GET    /api/master/memory/tier1/pending       — Tier 1 candidate queue
//   POST   /api/master/memory/tier1/approve       — approve candidate
//   POST   /api/master/memory/tier1/reject        — reject candidate
//   POST   /api/master/memory/backfill/evy-to-memori
//   POST   /api/master/memory/backfill/claude-mem-to-cognee
//   POST   /api/master/memory/backfill/obsidian-to-cognee
//   GET    /api/cognee/health                     — Cognee sidecar status
//   POST   /api/cognee/cognify                    — graph extraction
//   GET    /api/memori/health                     — Memori sidecar status
//   POST   /api/memori/recall                     — curated Tier 3 search
//
// DOM contract (lives in index.html):
//   #mem-tier-health, #mem-cycle, #mem-candidates, #mem-curated,
//   #mem-backfill, #mem-cognify — empty containers JS fills on mount.
//
// IDs preserved for back-compat (re-rendered inside the new panels):
//   #user-md-textarea, #memory-md-textarea, #user-md-meta, #memory-md-meta,
//   #user-md-result, #memory-md-result, [data-mem-save],
//   #memory-status, #memory-content,
//   #evy-memory-card, #evy-mem-list, #evy-mem-meta, #evy-mem-search,
//   #evy-mem-kind, #evy-mem-search-btn, #evy-mem-refresh-btn
//
// Polling timers (lifted to module scope so unmount() can clear them):
//   tier1PollTimer       — 15s, refreshes Tier 1 textareas from disk
//   mainPollTimer        — 30s, refreshes Obsidian vault status
//   kernelPollTimer      — 30s, refreshes consciousness cycle state
//   candidatePollTimer   — 30s, refreshes Tier 1 candidate queue
//   healthPollTimer      — 30s, refreshes Memori/Cognee health pills

export const id = "memory";

let tier1PollTimer = null;
let mainPollTimer = null;
let kernelPollTimer = null;
let candidatePollTimer = null;
let healthPollTimer = null;

// Persisted across mounts so the Cognify panel can show "last run" stats
// without a master-side cache. /api/cognee/health doesn't expose
// node_count/edge_count today, so we stash the last cognify response and
// fall back to total_memories for the "has stuff been ingested?" signal.
let lastCognifyResult = null;
try {
  const raw = localStorage.getItem("mem.lastCognify");
  if (raw) lastCognifyResult = JSON.parse(raw);
} catch { /* ignore — non-critical persistence */ }

export async function mount({ root: _root }) {
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtAgo(iso) {
    if (!iso) return "never";
    const t = new Date(iso).getTime();
    if (!t) return "—";
    const ageSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (ageSec < 5) return "just now";
    if (ageSec < 60) return ageSec + "s ago";
    if (ageSec < 3600) return Math.floor(ageSec / 60) + " min ago";
    if (ageSec < 86400) return Math.floor(ageSec / 3600) + "h ago";
    return Math.floor(ageSec / 86400) + "d ago";
  }
  function fmtMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }
  function pill(state, label) {
    return `<span class="mem-pill mem-pill-${esc(state)}">${esc(label)}</span>`;
  }
  const HOST_LABEL = "this Mac";

  // ──────────────────────────────────────────────────────────────────
  // Panel A — Tier health strip (Tier 1 + Memori + Cognee, side-by-side)
  // ──────────────────────────────────────────────────────────────────
  function renderTierHealth() {
    const host = $("mem-tier-health");
    if (!host) return;
    host.innerHTML =
      `<section class="mem-card mem-card-tier1" id="mem-tier1-card">
         <header class="mem-card-head">
           <h3>Tier 1 <span class="mem-card-sub">always-in-context · operator + master memory</span></h3>
           <span class="mem-card-meta" id="mem-tier1-overall">—</span>
         </header>
         <div class="mem-card-body">
           <div class="mem-tier1-row">
             <div class="mem-tier1-col">
               <label>Operator profile <code>user.md</code> <span class="mem-card-meta" id="user-md-meta">— / 1375 chars</span></label>
               <textarea id="user-md-textarea" rows="6" placeholder="Jason — MSP owner, AI application developer. Runs subctl on this Mac (256GB RAM, 400Gbps backbone). Deeply technical (30+ yrs IT). Prefers FREE/open-source first..."></textarea>
               <div class="mem-actions">
                 <button type="button" class="primary-btn" data-mem-save="user">save</button>
                 <span class="memory-card-result" id="user-md-result"></span>
               </div>
             </div>
             <div class="mem-tier1-col">
               <label>Learned facts <code>memory.md</code> <span class="mem-card-meta" id="memory-md-meta">— / 2200 chars</span></label>
               <textarea id="memory-md-textarea" rows="6" placeholder="Down-Time-Arena's primary branch is \`main\`; Speartip is the prospective sponsor.&#10;§&#10;LM Studio's loaded_context_length resets to 4K on JIT — auto-pin via /api/v1/models/load handles this; if drift happens, hit /reload-supervisor."></textarea>
               <div class="mem-actions">
                 <button type="button" class="primary-btn" data-mem-save="memory">save</button>
                 <span class="memory-card-result" id="memory-md-result"></span>
               </div>
             </div>
           </div>
         </div>
       </section>

       <section class="mem-card mem-card-memori" id="mem-memori-card">
         <header class="mem-card-head">
           <h3>Memori <span class="mem-card-sub">tier 3 sidecar · 127.0.0.1:8746</span></h3>
           <span class="mem-card-meta" id="mem-memori-pill">${pill("muted", "checking…")}</span>
         </header>
         <div class="mem-card-body" id="mem-memori-body">
           <div class="mem-stat-grid">
             <div class="mem-stat"><span class="mem-stat-label">total</span><span class="mem-stat-value" id="mem-memori-total">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">unreviewed</span><span class="mem-stat-value" id="mem-memori-unreviewed">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">curated</span><span class="mem-stat-value" id="mem-memori-curated">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">augment</span><span class="mem-stat-value" id="mem-memori-aug">—</span></div>
           </div>
           <div class="mem-stat-meta" id="mem-memori-llm"></div>
         </div>
       </section>

       <section class="mem-card mem-card-cognee" id="mem-cognee-card">
         <header class="mem-card-head">
           <h3>Cognee <span class="mem-card-sub">tier 4 graph sidecar · 127.0.0.1:8745</span></h3>
           <span class="mem-card-meta" id="mem-cognee-pill">${pill("muted", "checking…")}</span>
         </header>
         <div class="mem-card-body" id="mem-cognee-body">
           <div class="mem-stat-grid">
             <div class="mem-stat"><span class="mem-stat-label">memories</span><span class="mem-stat-value" id="mem-cognee-total">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">graph</span><span class="mem-stat-value" id="mem-cognee-graph">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">embeddings</span><span class="mem-stat-value" id="mem-cognee-emb">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">augment</span><span class="mem-stat-value" id="mem-cognee-aug">—</span></div>
           </div>
           <div class="mem-stat-meta" id="mem-cognee-llm"></div>
         </div>
       </section>`;
  }

  function setupTier1Editors() {
    const userTa = $("user-md-textarea");
    const memTa = $("memory-md-textarea");
    const userMeta = $("user-md-meta");
    const memMeta = $("memory-md-meta");
    const userResult = $("user-md-result");
    const memResult = $("memory-md-result");
    const overall = $("mem-tier1-overall");
    if (!userTa || !memTa) return;

    function updateMeta(meta, used, limit) {
      if (!meta) return;
      meta.textContent = `${used} / ${limit} chars`;
      meta.classList.toggle("warn", used > limit * 0.7 && used <= limit);
      meta.classList.toggle("crit", used > limit);
    }
    function updateOverall() {
      if (!overall) return;
      const total = userTa.value.length + memTa.value.length;
      overall.textContent = `${total} chars combined`;
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
        updateOverall();
      } catch { /* silent */ }
    }
    load();

    userTa.addEventListener("input", () => { updateMeta(userMeta, userTa.value.length, 1375); updateOverall(); });
    memTa.addEventListener("input", () => { updateMeta(memMeta, memTa.value.length, 2200); updateOverall(); });

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

    if (tier1PollTimer) clearInterval(tier1PollTimer);
    tier1PollTimer = setInterval(load, 15000);
  }

  // Gate the Backfill panel + Cognify panel buttons on sidecar reachability:
  // evy-to-memori needs Memori; claude-mem-to-cognee and obsidian-to-cognee
  // (and the Cognify run button) need Cognee. Per spec CONSTRAINTS: "Disable
  // buttons when underlying sidecar unreachable."
  function applySidecarGating(memoriUp, cogneeUp) {
    const set = (id, up, reason) => {
      const btn = document.querySelector(`[data-bf-run="${id}"]`);
      if (!btn) return;
      btn.disabled = !up;
      btn.title = up ? "" : reason;
      const row = btn.closest(".mem-backfill-row");
      if (row) row.classList.toggle("mem-backfill-row-disabled", !up);
    };
    set("evy-to-memori", memoriUp, "memori sidecar unreachable");
    set("claude-mem-to-cognee", cogneeUp, "cognee sidecar unreachable");
    set("obsidian-to-cognee", cogneeUp, "cognee sidecar unreachable");
    const cog = $("mem-cognify-run");
    if (cog) {
      cog.disabled = !cogneeUp;
      cog.title = cogneeUp ? "" : "cognee sidecar unreachable";
    }
  }

  async function refreshSidecarHealth() {
    let memoriUp = false;
    let cogneeUp = false;

    // Memori
    try {
      const r = await fetch("/api/memori/health");
      const j = await r.json();
      const pillEl = $("mem-memori-pill");
      if (!j || !j.ok) {
        if (pillEl) pillEl.innerHTML = pill("err", "unreachable");
      } else {
        memoriUp = true;
        if (pillEl) pillEl.innerHTML = pill("ok", j.using_real_sdk ? "live · sdk" : "live · fallback");
        const t = $("mem-memori-total"); if (t) t.textContent = (j.total_memories ?? 0).toLocaleString();
        const u = $("mem-memori-unreviewed"); if (u) u.textContent = (j.total_unreviewed ?? 0).toLocaleString();
        const c = $("mem-memori-curated"); if (c) c.textContent = (j.total_curated ?? 0).toLocaleString();
        const a = $("mem-memori-aug");
        if (a) {
          const aug = j.augmentation === true || j.augmentation === "on";
          a.innerHTML = aug
            ? `<span class="mem-pill mem-pill-warn">cloud</span>`
            : `<span class="mem-pill mem-pill-ok">local</span>`;
        }
        const llm = $("mem-memori-llm");
        if (llm) llm.textContent = `db=${j.database ?? "?"} · v${j.version ?? "?"}`;
      }
    } catch {
      const pillEl = $("mem-memori-pill");
      if (pillEl) pillEl.innerHTML = pill("err", "unreachable");
    }

    // Cognee
    try {
      const r = await fetch("/api/cognee/health");
      const j = await r.json();
      const pillEl = $("mem-cognee-pill");
      if (!j || !j.ok) {
        if (pillEl) pillEl.innerHTML = pill("err", "unreachable");
      } else {
        cogneeUp = true;
        if (pillEl) pillEl.innerHTML = pill("ok", j.using_real_sdk ? "live · sdk" : "live · stub");
        const total = $("mem-cognee-total");
        if (total) total.textContent = (j.total_memories ?? 0).toLocaleString();
        const graph = $("mem-cognee-graph");
        if (graph) {
          const nodes = lastCognifyResult?.node_count_after ?? null;
          const edges = lastCognifyResult?.edge_count_after ?? null;
          if (nodes != null) {
            graph.textContent = `${nodes.toLocaleString()} / ${edges?.toLocaleString() ?? "?"}`;
            graph.title = "nodes / edges (from last cognify run)";
          } else {
            graph.textContent = "—";
            graph.title = "run cognify to populate";
          }
        }
        const emb = $("mem-cognee-emb");
        if (emb) emb.textContent = j.embeddings_provider || "—";
        const a = $("mem-cognee-aug");
        if (a) {
          const aug = j.augmentation === true || j.augmentation === "on";
          a.innerHTML = aug
            ? `<span class="mem-pill mem-pill-warn">cloud</span>`
            : `<span class="mem-pill mem-pill-ok">local</span>`;
        }
        const llm = $("mem-cognee-llm");
        if (llm) {
          const model = j.llm_model || "—";
          const base = j.llm_base || "—";
          llm.textContent = `${j.llm_provider ?? "default"} · ${model} @ ${base}`;
        }
      }
    } catch {
      const pillEl = $("mem-cognee-pill");
      if (pillEl) pillEl.innerHTML = pill("err", "unreachable");
    }

    applySidecarGating(memoriUp, cogneeUp);
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel B — Consciousness cycle
  // ──────────────────────────────────────────────────────────────────
  function renderCyclePanel() {
    const host = $("mem-cycle");
    if (!host) return;
    host.innerHTML =
      `<details class="mem-section" open>
         <summary>
           <span class="mem-section-title">Consciousness Cycle</span>
           <span class="mem-section-meta" id="mem-cycle-meta">checking…</span>
         </summary>
         <div class="mem-section-body">
           <div class="mem-cycle-stats">
             <div class="mem-stat"><span class="mem-stat-label">last cycle</span><span class="mem-stat-value" id="mem-cycle-last">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">total cycles</span><span class="mem-stat-value" id="mem-cycle-total">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">promotions</span><span class="mem-stat-value" id="mem-cycle-promotions">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">state</span><span class="mem-stat-value" id="mem-cycle-state">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">last decisions</span><span class="mem-stat-value" id="mem-cycle-decisions">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">errors</span><span class="mem-stat-value" id="mem-cycle-errors">—</span></div>
           </div>
           <div class="mem-actions mem-cycle-actions">
             <button type="button" class="primary-btn" id="mem-cycle-run">run cycle now</button>
             <button type="button" class="secondary-btn" id="mem-cycle-toggle">pause</button>
             <span class="memory-card-result" id="mem-cycle-result"></span>
           </div>
           <div class="mem-cycle-decisions">
             <h4>Latest decisions <span class="dim small">(from last cycle)</span></h4>
             <div id="mem-cycle-table">—</div>
           </div>
         </div>
       </details>`;
    $("mem-cycle-run").addEventListener("click", runCycleNow);
    $("mem-cycle-toggle").addEventListener("click", toggleCycle);
  }

  let kernelPaused = false;

  async function refreshKernelStatus() {
    try {
      const r = await fetch("/api/master/memory/kernel/status");
      const j = await r.json();
      if (!j.ok) {
        const meta = $("mem-cycle-meta"); if (meta) meta.textContent = "unreachable";
        return;
      }
      const s = j.state || {};
      kernelPaused = !!s.paused;
      const meta = $("mem-cycle-meta");
      if (meta) {
        meta.innerHTML = j.armed
          ? (s.paused ? pill("warn", "paused") : pill("ok", "armed"))
          : pill("err", "off (memori not loaded)");
      }
      const last = $("mem-cycle-last"); if (last) last.textContent = fmtAgo(s.last_cycle_at);
      const total = $("mem-cycle-total"); if (total) total.textContent = (s.total_cycles ?? 0).toLocaleString();
      const prom = $("mem-cycle-promotions"); if (prom) prom.textContent = (s.total_promotions ?? 0).toLocaleString();
      const state = $("mem-cycle-state"); if (state) state.textContent = s.paused ? "paused" : (j.armed ? "armed" : "off");
      const dec = $("mem-cycle-decisions"); if (dec) dec.textContent = (s.last_cycle_decisions ?? 0).toLocaleString();
      const err = $("mem-cycle-errors"); if (err) err.textContent = (s.last_cycle_errors ?? 0).toLocaleString();
      const toggle = $("mem-cycle-toggle");
      if (toggle) toggle.textContent = s.paused ? "resume" : "pause";

      const table = $("mem-cycle-table");
      if (table) {
        const decs = j.last_decisions || [];
        if (!decs.length) {
          table.innerHTML = `<div class="dim small">no decisions in the last cycle</div>`;
        } else {
          const rows = decs.map((d) =>
            `<tr>
               <td>${esc(d.action ?? "—")}</td>
               <td>${esc(d.kind ?? "—")}</td>
               <td class="num">${d.confidence != null ? Number(d.confidence).toFixed(2) : "—"}</td>
               <td>${esc(d.reason ?? "")}</td>
               <td class="num">${(d.source_event_ids || []).length}</td>
             </tr>`).join("");
          table.innerHTML =
            `<table class="data-table mem-decisions-table">
               <thead><tr><th>action</th><th>kind</th><th class="num">conf</th><th>reason</th><th class="num">sources</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`;
        }
      }
    } catch (err) {
      const meta = $("mem-cycle-meta");
      if (meta) meta.textContent = "fetch error";
      console.error("[memory] kernel status failed", err);
    }
  }

  async function runCycleNow() {
    const btn = $("mem-cycle-run");
    const result = $("mem-cycle-result");
    if (btn) { btn.disabled = true; btn.textContent = "running…"; }
    if (result) { result.className = "memory-card-result"; result.textContent = ""; }
    try {
      const r = await fetch("/api/master/memory/kernel/run-now", { method: "POST" });
      const j = await r.json();
      if (!j.ok) {
        if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + (j.error || "run failed"); }
      } else {
        if (result) {
          result.className = "memory-card-result ok";
          const promoted = j.result?.promoted ?? j.result?.decisions?.length ?? 0;
          result.textContent = `✓ cycle complete · ${promoted} decision(s)`;
        }
        refreshKernelStatus();
        refreshSidecarHealth();
        refreshCandidates();
      }
    } catch (err) {
      if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + err; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "run cycle now"; }
    }
  }

  async function toggleCycle() {
    const btn = $("mem-cycle-toggle");
    if (btn) btn.disabled = true;
    try {
      const path = kernelPaused ? "/api/master/memory/kernel/resume" : "/api/master/memory/kernel/pause";
      const r = await fetch(path, { method: "POST" });
      const j = await r.json();
      if (j.ok) refreshKernelStatus();
    } catch (err) {
      console.error("[memory] kernel toggle failed", err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel C — Tier 1 candidate queue
  // ──────────────────────────────────────────────────────────────────
  function renderCandidatesPanel() {
    const host = $("mem-candidates");
    if (!host) return;
    host.innerHTML =
      `<details class="mem-section" open>
         <summary>
           <span class="mem-section-title">Tier 1 Candidates</span>
           <span class="mem-section-meta" id="mem-candidates-meta">checking…</span>
         </summary>
         <div class="mem-section-body">
           <p class="mem-section-doc">Memories the reviewer proposed for promotion into <code>memory.md</code>. Approve to write through the char-budget guardrails; reject to dismiss.</p>
           <div id="mem-candidates-list" class="mem-candidates-list">loading…</div>
         </div>
       </details>`;
  }

  async function refreshCandidates() {
    const meta = $("mem-candidates-meta");
    const list = $("mem-candidates-list");
    if (!list) return;
    try {
      const r = await fetch("/api/master/memory/tier1/pending");
      const j = await r.json();
      if (!j.ok) {
        list.innerHTML = `<div class="dim small">unreachable</div>`;
        if (meta) meta.textContent = "unreachable";
        return;
      }
      const items = j.candidates || [];
      if (meta) meta.innerHTML = items.length
        ? pill("warn", `${items.length} pending`)
        : pill("ok", "none pending");
      if (!items.length) {
        list.innerHTML = `<div class="dim small">no pending candidates</div>`;
        return;
      }
      list.innerHTML = items.map((c) =>
        `<div class="mem-candidate" data-id="${esc(c.id)}">
           <div class="mem-candidate-head">
             <span class="mem-candidate-kind">${esc(c.kind || "—")}</span>
             <span class="mem-candidate-conf" title="confidence">${c.confidence != null ? Number(c.confidence).toFixed(2) : "—"}</span>
             <span class="mem-candidate-when" title="${esc(c.proposed_at || "")}">${fmtAgo(c.proposed_at)}</span>
             <span class="mem-candidate-model dim small">${esc(c.reviewer_model || "")}</span>
           </div>
           <div class="mem-candidate-text">${esc(c.memory || "")}</div>
           <div class="mem-candidate-reason dim small">${esc(c.reason || "")}</div>
           <div class="mem-candidate-actions">
             <input type="text" class="mem-candidate-note" placeholder="optional note…" />
             <button type="button" class="primary-btn" data-cand-approve="${esc(c.id)}">✓ approve</button>
             <button type="button" class="secondary-btn" data-cand-reject="${esc(c.id)}">✗ reject</button>
             <span class="memory-card-result" data-cand-result="${esc(c.id)}"></span>
           </div>
         </div>`).join("");

      list.querySelectorAll("[data-cand-approve]").forEach((btn) => {
        btn.addEventListener("click", () => actOnCandidate(btn, "approve"));
      });
      list.querySelectorAll("[data-cand-reject]").forEach((btn) => {
        btn.addEventListener("click", () => actOnCandidate(btn, "reject"));
      });
    } catch (err) {
      list.innerHTML = `<div class="dim small">fetch error: ${esc(err)}</div>`;
      if (meta) meta.textContent = "fetch error";
    }
  }

  async function actOnCandidate(btn, verb) {
    const id = btn.getAttribute(verb === "approve" ? "data-cand-approve" : "data-cand-reject");
    const card = btn.closest(".mem-candidate");
    const noteInput = card?.querySelector(".mem-candidate-note");
    const result = card?.querySelector(`[data-cand-result="${id}"]`);
    const peer = card?.querySelector(verb === "approve" ? "[data-cand-reject]" : "[data-cand-approve]");
    btn.disabled = true; if (peer) peer.disabled = true;
    if (result) { result.className = "memory-card-result"; result.textContent = "…"; }
    try {
      const r = await fetch(`/api/master/memory/tier1/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: id, note: noteInput?.value || undefined }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + (j.error || "failed"); }
        btn.disabled = false; if (peer) peer.disabled = false;
        return;
      }
      if (result) {
        result.className = "memory-card-result ok";
        result.textContent = verb === "approve" ? "✓ approved · written to memory.md" : "✓ rejected";
      }
      setTimeout(() => { refreshCandidates(); refreshKernelStatus(); }, 400);
    } catch (err) {
      if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + err; }
      btn.disabled = false; if (peer) peer.disabled = false;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel D — Curated Tier 3 browser (Memori /recall + Obsidian vault status
  //           + legacy Evy Memory list for back-compat)
  // ──────────────────────────────────────────────────────────────────
  function renderCuratedPanel() {
    const host = $("mem-curated");
    if (!host) return;
    host.innerHTML =
      `<details class="mem-section" open>
         <summary>
           <span class="mem-section-title">Curated Tier 3</span>
           <span class="mem-section-meta" id="mem-curated-meta">—</span>
         </summary>
         <div class="mem-section-body">
           <p class="mem-section-doc">Memories the consciousness cycle endorsed for long-term recall, served by Memori's <code>/recall</code>. The legacy Evy Memory raw-turn store stays underneath as a fallback browser.</p>
           <div class="mem-curated-controls">
             <input type="search" id="mem-curated-q" placeholder="search curated memori… (prefix entity:&lt;name&gt; to override)" />
             <button type="button" class="primary-btn" id="mem-curated-search">search</button>
             <button type="button" class="secondary-btn" id="mem-curated-clear">recent</button>
           </div>
           <div id="mem-curated-list" class="mem-curated-list">loading…</div>

           <details class="mem-subsection">
             <summary>Obsidian vault <span class="dim small">tier 2 · long-form notes</span> · <span class="memory-status" id="memory-status">checking…</span></summary>
             <div id="memory-content" class="mem-obsidian-body">loading…</div>
           </details>

           <details class="mem-subsection" id="evy-memory-card">
             <summary>Evy Memory (raw) <span class="dim small">tier 3 fallback · sqlite</span> · <span class="memory-card-meta" id="evy-mem-meta">— entries</span></summary>
             <div class="evy-mem-controls">
               <input type="search" id="evy-mem-search" placeholder="search memory (FTS5)…" />
               <select id="evy-mem-kind">
                 <option value="">all kinds</option>
                 <option value="message">message</option>
                 <option value="tool-call">tool-call</option>
                 <option value="notification">notification</option>
                 <option value="shipped">shipped</option>
                 <option value="evy-note">evy-note</option>
                 <option value="operator-note">operator-note</option>
                 <option value="synthetic-prompt">synthetic-prompt</option>
               </select>
               <button type="button" class="primary-btn" id="evy-mem-search-btn">search</button>
               <button type="button" class="secondary-btn" id="evy-mem-refresh-btn">recent</button>
             </div>
             <div class="evy-mem-list" id="evy-mem-list">loading…</div>
           </details>
         </div>
       </details>`;

    const q = $("mem-curated-q");
    if (q) q.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); runCuratedSearch(); }
    });
    const sb = $("mem-curated-search"); if (sb) sb.addEventListener("click", runCuratedSearch);
    const cl = $("mem-curated-clear");
    if (cl) cl.addEventListener("click", () => { if (q) q.value = ""; runCuratedSearch(); });
  }

  // Curated memories are keyed by the master's `policy.operator.name`
  // lowercased (components/master/server.ts:3181). The dashboard doesn't
  // expose that name today, so default to "jason" (the operator's actual
  // name on this install — see CLAUDE.md) and fall back to "operator" if
  // empty. Operators on other installs can override by typing
  // `entity:<name>` as a prefix in the search box.
  async function runCuratedSearch() {
    let q = ($("mem-curated-q")?.value || "").trim();
    let entityId = "jason";
    const entityMatch = q.match(/^entity:([\w.-]+)\s*(.*)$/i);
    if (entityMatch) {
      entityId = entityMatch[1].toLowerCase();
      q = entityMatch[2].trim();
    }
    const list = $("mem-curated-list");
    const meta = $("mem-curated-meta");
    if (!list) return;
    list.innerHTML = `<div class="dim small">${q ? "searching…" : "loading recent curated…"}</div>`;
    try {
      let r = await fetch("/api/memori/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, top_k: 25, entity_id: entityId }),
      });
      let j = await r.json();
      // First-try fallback: if the operator's actual name has no hits AND
      // the operator didn't override the entity_id, try "operator". This
      // catches installs that haven't renamed the policy operator.
      if (j.ok && (!j.hits || j.hits.length === 0) && entityId === "jason" && !entityMatch) {
        r = await fetch("/api/memori/recall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, top_k: 25, entity_id: "operator" }),
        });
        j = await r.json();
        if (j.ok && j.hits?.length) entityId = "operator";
      }
      if (!j.ok) {
        list.innerHTML = `<div class="dim small">unreachable: ${esc(j.error || "")}</div>`;
        if (meta) meta.textContent = "unreachable";
        return;
      }
      const hits = j.hits || [];
      if (meta) meta.textContent = `${hits.length} hit${hits.length === 1 ? "" : "s"} · entity:${entityId}`;
      if (!hits.length) {
        list.innerHTML = `<div class="dim small">no matches</div>`;
        return;
      }
      list.innerHTML = `<table class="data-table mem-curated-table">
         <thead><tr><th>when</th><th>kind</th><th>text</th><th class="num">score</th></tr></thead>
         <tbody>${hits.map((h) =>
           `<tr>
             <td class="dim small" title="${esc(h.ts || "")}">${fmtAgo(h.ts)}</td>
             <td><span class="mem-pill mem-pill-muted">${esc(h.kind || "fact")}</span></td>
             <td class="mem-curated-text">${esc(h.text || "")}</td>
             <td class="num">${h.score != null ? Number(h.score).toFixed(2) : "—"}</td>
            </tr>`).join("")}</tbody>
       </table>`;
    } catch (err) {
      list.innerHTML = `<div class="dim small">fetch error: ${esc(err)}</div>`;
      if (meta) meta.textContent = "error";
    }
  }

  // Obsidian vault status — preserved from the previous memory.js. Uses
  // the existing #memory-status + #memory-content IDs (now nested inside
  // the curated panel's sub-disclosure).
  function setupObsidianPanel() {
    const status = $("memory-status");
    const content = $("memory-content");
    if (!content) return;
    async function refresh() {
      try {
        const r = await fetch("/api/memory");
        const j = await r.json();
        if (!j.ok) {
          content.innerHTML = `<p class="dim">memory API unreachable</p>`;
          if (status) { status.textContent = "error"; status.dataset.state = "err"; }
          return;
        }
        if (!j.obsidian_installed) {
          if (status) { status.textContent = "obsidian not installed"; status.dataset.state = "warn"; }
          content.innerHTML =
            `<div class="memory-block">
               <h3>Obsidian is not installed on ${esc(HOST_LABEL)}</h3>
               <p>Install:</p>
               <pre class="memory-cmd">brew install --cask obsidian</pre>
               <p>Then create a vault at:</p>
               <pre class="memory-cmd">${esc(j.suggested_vault_path)}</pre>
             </div>`;
          return;
        }
        if (status) { status.textContent = (j.vaults || []).length + " vault(s)"; status.dataset.state = "ok"; }
        if (!(j.vaults || []).length) {
          content.innerHTML =
            `<div class="memory-block">
               <h3>Obsidian installed, no vault detected</h3>
               <p>Create one at <code>${esc(j.suggested_vault_path)}</code>.</p>
             </div>`;
          return;
        }
        const rows = j.vaults.map((v) =>
          `<tr><td><code>${esc(v.path)}</code></td><td class="num">${v.note_count}</td><td>${v.last_modified ? new Date(v.last_modified).toLocaleString() : "—"}</td></tr>`
        ).join("");
        content.innerHTML =
          `<table class="data-table"><thead><tr><th>vault</th><th class="num">notes</th><th>last modified</th></tr></thead><tbody>${rows}</tbody></table>`;
      } catch (err) {
        content.innerHTML = `<p class="dim">fetch error: ${esc(String(err))}</p>`;
        if (status) { status.textContent = "error"; status.dataset.state = "err"; }
      }
    }
    refresh();
    if (mainPollTimer) clearInterval(mainPollTimer);
    mainPollTimer = setInterval(refresh, 30000);
  }

  // Evy Memory card — preserved from the previous memory.js. Uses the
  // existing IDs now living inside the curated panel's evy sub-disclosure.
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
        list.innerHTML = `<p class="dim">(no entries)</p>`;
        return;
      }
      const rows = entries.map((e) => {
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
      }).join("");
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
        if (meta) meta.textContent = `${s.count} entries · ${sizeKb} KB · fts5=${s.fts5 ? "on" : "off"}`;
      } catch {
        if (meta) meta.textContent = "— entries";
      }
    }
    async function loadRecent() {
      list.innerHTML = `<p class="dim">loading…</p>`;
      try {
        const r = await fetch("/api/memory/recent?limit=25");
        const j = await r.json();
        if (!j.ok) { list.innerHTML = `<p class="dim">unreachable</p>`; return; }
        renderEntries(j.entries || []);
        loadStats();
      } catch (err) {
        list.innerHTML = `<p class="dim">fetch error: ${esc(err)}</p>`;
      }
    }
    async function runSearch() {
      const q = (search?.value || "").trim();
      const k = (kindSel?.value || "").trim();
      const params = new URLSearchParams();
      if (q) params.set("query", q);
      if (k) params.set("kind", k);
      params.set("limit", "50");
      list.innerHTML = `<p class="dim">searching…</p>`;
      try {
        const r = await fetch(`/api/memory/search?${params.toString()}`);
        const j = await r.json();
        if (!j.ok) { list.innerHTML = `<p class="dim">unreachable</p>`; return; }
        renderEntries(j.entries || []);
      } catch (err) {
        list.innerHTML = `<p class="dim">fetch error: ${esc(err)}</p>`;
      }
    }
    if (searchBtn) searchBtn.addEventListener("click", runSearch);
    if (refreshBtn) refreshBtn.addEventListener("click", loadRecent);
    if (search) {
      search.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); runSearch(); }
      });
    }
    if (kindSel) kindSel.addEventListener("change", runSearch);
    loadRecent();
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel E — Backfill
  // ──────────────────────────────────────────────────────────────────
  function renderBackfillPanel() {
    const host = $("mem-backfill");
    if (!host) return;
    const row = (id, title, doc, target) =>
      `<section class="mem-backfill-row" data-bf-id="${esc(id)}">
         <header class="mem-backfill-head">
           <h4>${esc(title)}</h4>
           <span class="dim small">${esc(target)}</span>
         </header>
         <p class="dim small">${esc(doc)}</p>
         <div class="mem-backfill-controls">
           <label class="mem-backfill-dryrun">
             <input type="checkbox" data-bf-dryrun="${esc(id)}" checked />
             <span>dry-run</span>
           </label>
           <label class="mem-backfill-limit">
             <span>limit</span>
             <input type="number" min="1" max="100000" data-bf-limit="${esc(id)}" placeholder="all" />
           </label>
           <button type="button" class="primary-btn" data-bf-run="${esc(id)}">run</button>
           <span class="memory-card-result" data-bf-result="${esc(id)}"></span>
         </div>
         <div class="mem-backfill-output dim small" data-bf-output="${esc(id)}"></div>
       </section>`;
    host.innerHTML =
      `<details class="mem-section">
         <summary>
           <span class="mem-section-title">Backfill</span>
           <span class="mem-section-meta" id="mem-backfill-meta">3 sources</span>
         </summary>
         <div class="mem-section-body">
           <p class="mem-section-doc">Operator-invoked. Dry-run first to see what would be ingested. Re-running is idempotent (markers prevent duplicates).</p>
           ${row("evy-to-memori", "evy → Memori", "Promote raw evy.db conversational turns into Memori for the consciousness cycle to review.", "/api/master/memory/backfill/evy-to-memori")}
           ${row("claude-mem-to-cognee", "claude-mem → Cognee", "Ingest claude-mem observation jsonl into the Cognee graph layer.", "/api/master/memory/backfill/claude-mem-to-cognee")}
           ${row("obsidian-to-cognee", "Obsidian → Cognee", "Ingest the Obsidian vault into the Cognee graph layer.", "/api/master/memory/backfill/obsidian-to-cognee")}
         </div>
       </details>`;
    host.querySelectorAll("[data-bf-run]").forEach((btn) => {
      btn.addEventListener("click", () => runBackfill(btn.getAttribute("data-bf-run")));
    });
  }

  async function runBackfill(id) {
    const dryEl = document.querySelector(`[data-bf-dryrun="${id}"]`);
    const limitEl = document.querySelector(`[data-bf-limit="${id}"]`);
    const runBtn = document.querySelector(`[data-bf-run="${id}"]`);
    const result = document.querySelector(`[data-bf-result="${id}"]`);
    const out = document.querySelector(`[data-bf-output="${id}"]`);
    const dryRun = !!dryEl?.checked;
    const rawLimit = limitEl?.value?.trim();
    const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

    if (runBtn) { runBtn.disabled = true; runBtn.textContent = "running…"; }
    if (result) { result.className = "memory-card-result"; result.textContent = ""; }
    if (out) out.textContent = "";

    const t0 = performance.now();
    try {
      const body = { dryRun };
      if (limit && Number.isFinite(limit) && limit > 0) body.limit = limit;
      const r = await fetch(`/api/master/memory/backfill/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      const dur = fmtMs(performance.now() - t0);
      if (!j.ok && j.ok !== undefined) {
        if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + (j.error || "failed"); }
        if (out) out.textContent = `error in ${dur}`;
      } else {
        if (result) {
          result.className = "memory-card-result ok";
          result.textContent = `✓ ${dryRun ? "dry-run " : ""}done · ${dur}`;
        }
        if (out) {
          const planned = j.planned ?? 0, written = j.written ?? 0, skipped = j.skipped ?? 0, errors = j.errors ?? 0;
          out.innerHTML =
            `planned <strong>${planned}</strong> · written <strong>${written}</strong> · ` +
            `skipped <strong>${skipped}</strong> · errors <strong>${errors}</strong>` +
            (Array.isArray(j.details) && j.details.length
              ? ` <span class="dim">· first ${Math.min(j.details.length, 5)} of ${j.details.length}: ` +
                esc(j.details.slice(0, 5).map((d) => d.action || d.reason || "?").join(", ")) +
                `</span>`
              : "");
        }
      }
    } catch (err) {
      if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + err; }
      if (out) out.textContent = "transport error";
    } finally {
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = "run"; }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel F — Graph Extraction (cognify)
  // ──────────────────────────────────────────────────────────────────
  function renderCognifyPanel() {
    const host = $("mem-cognify");
    if (!host) return;
    host.innerHTML =
      `<details class="mem-section">
         <summary>
           <span class="mem-section-title">Graph Extraction (Cognify)</span>
           <span class="mem-section-meta" id="mem-cognify-meta">—</span>
         </summary>
         <div class="mem-section-body">
           <p class="mem-section-doc">Builds / refreshes the Cognee knowledge graph from ingested text. Heavy LLM-driven step — expect minutes per dataset. Operator-invoked only; master never auto-cognifies.</p>
           <div class="mem-stat-grid">
             <div class="mem-stat"><span class="mem-stat-label">nodes</span><span class="mem-stat-value" id="mem-cognify-nodes">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">edges</span><span class="mem-stat-value" id="mem-cognify-edges">—</span></div>
             <div class="mem-stat"><span class="mem-stat-label">last run</span><span class="mem-stat-value" id="mem-cognify-last">never</span></div>
             <div class="mem-stat"><span class="mem-stat-label">last duration</span><span class="mem-stat-value" id="mem-cognify-dur">—</span></div>
           </div>
           <div class="mem-actions">
             <button type="button" class="primary-btn" id="mem-cognify-run">run cognify</button>
             <span class="memory-card-result" id="mem-cognify-result"></span>
           </div>
         </div>
       </details>`;
    refreshCognifyStats();
    $("mem-cognify-run").addEventListener("click", runCognify);
  }

  function refreshCognifyStats() {
    const meta = $("mem-cognify-meta");
    const nodes = $("mem-cognify-nodes");
    const edges = $("mem-cognify-edges");
    const last = $("mem-cognify-last");
    const dur = $("mem-cognify-dur");
    const r = lastCognifyResult;
    if (!r) {
      if (meta) meta.innerHTML = pill("muted", "never run");
      if (nodes) nodes.textContent = "—";
      if (edges) edges.textContent = "—";
      if (last) last.textContent = "never";
      if (dur) dur.textContent = "—";
      return;
    }
    if (meta) meta.innerHTML = pill(r.ok ? "ok" : "err", r.ok ? "ready" : "errored");
    if (nodes) nodes.textContent = (r.node_count_after ?? 0).toLocaleString();
    if (edges) edges.textContent = (r.edge_count_after ?? 0).toLocaleString();
    if (last) last.textContent = fmtAgo(r.ran_at);
    if (dur) dur.textContent = fmtMs(r.duration_ms);
  }

  async function runCognify() {
    const btn = $("mem-cognify-run");
    const result = $("mem-cognify-result");
    if (btn) { btn.disabled = true; btn.textContent = "running…"; }
    if (result) { result.className = "memory-card-result"; result.textContent = "this may take minutes…"; }
    const t0 = performance.now();
    try {
      const r = await fetch("/api/cognee/cognify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      const wall = performance.now() - t0;
      lastCognifyResult = {
        ok: !!j.ok,
        node_count_after: j.node_count_after ?? null,
        edge_count_after: j.edge_count_after ?? null,
        duration_ms: j.duration_ms ?? wall,
        ran_at: new Date().toISOString(),
        error: j.error ?? null,
      };
      try { localStorage.setItem("mem.lastCognify", JSON.stringify(lastCognifyResult)); } catch { /* ignore */ }
      refreshCognifyStats();
      refreshSidecarHealth();
      if (result) {
        if (j.ok) {
          result.className = "memory-card-result ok";
          result.textContent = `✓ cognify complete · ${fmtMs(lastCognifyResult.duration_ms)}`;
        } else {
          result.className = "memory-card-result err";
          result.textContent = "✗ " + (j.error || "failed");
        }
      }
    } catch (err) {
      if (result) { result.className = "memory-card-result err"; result.textContent = "✗ " + err; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "run cognify"; }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Mount sequence
  // ──────────────────────────────────────────────────────────────────
  renderTierHealth();
  setupTier1Editors();
  renderCyclePanel();
  renderCandidatesPanel();
  renderCuratedPanel();
  setupObsidianPanel();
  setupEvyCard();
  renderBackfillPanel();
  renderCognifyPanel();

  // Initial fetches + polling.
  refreshSidecarHealth();
  refreshKernelStatus();
  refreshCandidates();
  runCuratedSearch();

  if (healthPollTimer) clearInterval(healthPollTimer);
  healthPollTimer = setInterval(refreshSidecarHealth, 30000);

  if (kernelPollTimer) clearInterval(kernelPollTimer);
  kernelPollTimer = setInterval(refreshKernelStatus, 30000);

  if (candidatePollTimer) clearInterval(candidatePollTimer);
  candidatePollTimer = setInterval(refreshCandidates, 30000);
}

export function unmount() {
  if (tier1PollTimer) { clearInterval(tier1PollTimer); tier1PollTimer = null; }
  if (mainPollTimer) { clearInterval(mainPollTimer); mainPollTimer = null; }
  if (kernelPollTimer) { clearInterval(kernelPollTimer); kernelPollTimer = null; }
  if (candidatePollTimer) { clearInterval(candidatePollTimer); candidatePollTimer = null; }
  if (healthPollTimer) { clearInterval(healthPollTimer); healthPollTimer = null; }
}
