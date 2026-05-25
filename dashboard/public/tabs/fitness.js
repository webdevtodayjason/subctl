// dashboard/public/tabs/fitness.js
//
// v3.3.1 — Kernel Fitness Phase 3: dashboard fitness panel.
//
// Surfaces the metrics from Phase 1 (engagement ledger, v3.1.0) and
// Phase 2 (fitness writer, v3.3.0). Pure read-only observability —
// no writes back to either ledger from this tab.
//
// Panels:
//   1. Now             — latest stall_composite + engagement_rate with sparklines
//   2. Recent surfaces — last 30 surface_emitted events with outcomes
//   3. 7-day trend     — inline SVG line chart (no Chart.js dep)
//   4. Health          — red/yellow/green verdict from /api/evy/fitness/health
//
// HTTP endpoints consumed:
//   GET /api/evy/fitness/ledger[?window=24h|7d|30d]
//   GET /api/evy/engagement/ledger[?window=Nh|Nd][?type=...]
//   GET /api/evy/fitness/health
//
// Negative criterion: this tab is structurally OK to read the ledgers —
// the dashboard is a separate process from Evy. The criterion guards the
// supervisor-prompt assembly path inside the daemon. See
// components/evy/__tests__/fitness-ledger-isolation.test.ts for the
// red-team test that enforces it.
//
// Poll cadence: 60s (the writer emits hourly, so polling more often is wasted).

export const id = "fitness";

let pollTimer = null;
let rootEl = null;

export async function mount({ root }) {
  rootEl = root;
  root.innerHTML = renderShell();
  await refresh();
  pollTimer = setInterval(refresh, 60_000);
}

export function unmount() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  rootEl = null;
}

// ─── data fetch ───────────────────────────────────────────────────────────

async function fetchJson(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

async function refresh() {
  if (!rootEl) return;
  const [fitness7d, fitness24h, engage24h, health] = await Promise.all([
    fetchJson("/api/evy/fitness/ledger?window=7d", { entries: [] }),
    fetchJson("/api/evy/fitness/ledger?window=24h", { entries: [] }),
    fetchJson("/api/evy/engagement/ledger?window=24h", { entries: [] }),
    fetchJson("/api/evy/fitness/health", {
      health: "red",
      reason: "dashboard could not reach /api/evy/fitness/health",
      latest_window: null,
    }),
  ]);

  renderNow(fitness24h.entries || [], engage24h.entries || []);
  renderSurfaces(engage24h.entries || []);
  renderTrend(fitness7d.entries || []);
  renderHealth(health);
}

// ─── shell ────────────────────────────────────────────────────────────────

function renderShell() {
  return `
    <div class="fitness-screen-inner" style="padding:1rem;display:flex;flex-direction:column;gap:1.5rem;">
      <header style="display:flex;align-items:center;justify-content:space-between;">
        <h2 style="margin:0;">Fitness — is Evy learning?</h2>
        <span id="fitness-health-pill" class="fitness-health-pill" style="padding:.25rem .75rem;border-radius:1rem;font-size:.85rem;font-weight:600;">…</span>
      </header>

      <section id="fitness-now-panel" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
        <div id="fitness-now-stall" style="padding:1rem;border:1px solid var(--border,#333);border-radius:8px;"></div>
        <div id="fitness-now-engage" style="padding:1rem;border:1px solid var(--border,#333);border-radius:8px;"></div>
      </section>

      <section id="fitness-trend-panel" style="padding:1rem;border:1px solid var(--border,#333);border-radius:8px;">
        <h3 style="margin:0 0 .75rem 0;font-size:1rem;">7-day trend</h3>
        <div id="fitness-trend-chart"></div>
      </section>

      <section id="fitness-surfaces-panel" style="padding:1rem;border:1px solid var(--border,#333);border-radius:8px;">
        <h3 style="margin:0 0 .75rem 0;font-size:1rem;">Recent surfaces (last 24h)</h3>
        <div id="fitness-surfaces-list" style="display:flex;flex-direction:column;gap:.25rem;font-family:var(--mono,monospace);font-size:.85rem;"></div>
      </section>

      <section id="fitness-meta-panel" style="padding:1rem;border:1px solid var(--border,#333);border-radius:8px;font-size:.85rem;color:var(--muted,#888);">
        <strong>Scaffold version:</strong> <span id="fitness-scaffold-version">…</span>
        &nbsp;·&nbsp;
        <strong>Last refresh:</strong> <span id="fitness-last-refresh">…</span>
      </section>
    </div>
  `;
}

// ─── Now panel ────────────────────────────────────────────────────────────

function renderNow(fitness24h, engage24h) {
  const stallEl = document.getElementById("fitness-now-stall");
  const engageEl = document.getElementById("fitness-now-engage");
  if (!stallEl || !engageEl) return;

  // Latest non-null stall_composite
  const sorted = [...fitness24h].sort(
    (a, b) => Date.parse(a.window_start) - Date.parse(b.window_start),
  );
  const latest = sorted[sorted.length - 1] || null;
  const stallVal =
    latest && typeof latest.stall_composite === "number"
      ? latest.stall_composite
      : null;
  const engVal =
    latest && typeof latest.engagement_rate === "number"
      ? latest.engagement_rate
      : null;

  const stallSeries = sorted.map((e) => e.stall_composite);
  const engSeries = sorted.map((e) => e.engagement_rate);

  stallEl.innerHTML = `
    <div style="font-size:.75rem;color:var(--muted,#888);">Stall composite (lower = better)</div>
    <div style="font-size:2rem;font-weight:600;margin:.25rem 0;">
      ${stallVal === null ? '<span style="color:#888;">—</span>' : fmtMetric(stallVal)}
    </div>
    <div style="font-size:.7rem;color:var(--muted,#888);">${
      latest?.missing_data_reason ? "missing: " + latest.missing_data_reason : "24h window"
    }</div>
    <div style="margin-top:.5rem;">${renderSparkline(stallSeries, { invert: true })}</div>
  `;

  // Engagement counts from the engagement ledger (more accurate than the
  // fitness window summary because the engagement ledger has the per-event
  // grain).
  const counts = countOutcomes(engage24h);
  engageEl.innerHTML = `
    <div style="font-size:.75rem;color:var(--muted,#888);">Engagement rate (higher = better)</div>
    <div style="font-size:2rem;font-weight:600;margin:.25rem 0;">
      ${engVal === null ? '<span style="color:#888;">—</span>' : (engVal * 100).toFixed(0) + "%"}
    </div>
    <div style="font-size:.7rem;color:var(--muted,#888);">
      24h · ${counts.acted} acted · ${counts.acked} acked · ${counts.ignored} ignored
    </div>
    <div style="margin-top:.5rem;">${renderSparkline(engSeries, { invert: false })}</div>
  `;
}

function fmtMetric(v) {
  if (v === null || v === undefined) return "—";
  return v.toFixed(2);
}

function countOutcomes(engage) {
  const c = { acted: 0, acked: 0, ignored: 0 };
  for (const e of engage) {
    if (e.type === "engagement" && c[e.outcome] !== undefined) c[e.outcome]++;
  }
  return c;
}

// ─── Sparkline ─────────────────────────────────────────────────────────────

function renderSparkline(values, { invert = false } = {}) {
  const cleaned = values.filter((v) => typeof v === "number");
  if (cleaned.length < 2) {
    return `<div style="font-size:.7rem;color:var(--muted,#888);">insufficient data</div>`;
  }
  const w = 200;
  const h = 30;
  const min = Math.min(...cleaned);
  const max = Math.max(...cleaned);
  const range = max - min || 1;
  const step = w / (cleaned.length - 1);
  const points = cleaned
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // Color: green if trend favorable (down for invert=true stall, up otherwise)
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  const favorable = invert ? last < first : last > first;
  const color = favorable ? "#4ade80" : "#f87171";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

// ─── 7-day trend chart ────────────────────────────────────────────────────

function renderTrend(fitness7d) {
  const el = document.getElementById("fitness-trend-chart");
  if (!el) return;
  const sorted = [...fitness7d].sort(
    (a, b) => Date.parse(a.window_start) - Date.parse(b.window_start),
  );
  if (sorted.length < 2) {
    el.innerHTML = `<div style="font-size:.85rem;color:var(--muted,#888);padding:1rem;text-align:center;">
      Need at least 2 fitness windows to render a 7-day trend. The writer emits hourly — check back in an hour or two.
    </div>`;
    return;
  }
  const w = 800;
  const h = 200;
  const padL = 40;
  const padR = 40;
  const padT = 20;
  const padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const stallVals = sorted.map((e) => e.stall_composite).filter((v) => typeof v === "number");
  const engVals = sorted.map((e) => e.engagement_rate).filter((v) => typeof v === "number");

  // Both metrics are bounded [0,1] so we can use the same y-axis.
  const stallPoints = sorted
    .map((e, i) => {
      if (typeof e.stall_composite !== "number") return null;
      const x = padL + (i / (sorted.length - 1)) * innerW;
      const y = padT + (1 - e.stall_composite) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean);

  const engPoints = sorted
    .map((e, i) => {
      if (typeof e.engagement_rate !== "number") return null;
      const x = padL + (i / (sorted.length - 1)) * innerW;
      const y = padT + (1 - e.engagement_rate) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean);

  const firstTs = sorted[0]?.window_start || "";
  const lastTs = sorted[sorted.length - 1]?.window_start || "";

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="background:rgba(0,0,0,0.1);border-radius:4px;">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="#444" stroke-width="1" />
      <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#444" stroke-width="1" />
      <text x="${padL - 6}" y="${padT + 4}" fill="#888" font-size="10" text-anchor="end">1.0</text>
      <text x="${padL - 6}" y="${h - padB + 4}" fill="#888" font-size="10" text-anchor="end">0.0</text>
      <polyline points="${stallPoints.join(" ")}" fill="none" stroke="#f87171" stroke-width="1.5" />
      <polyline points="${engPoints.join(" ")}" fill="none" stroke="#4ade80" stroke-width="1.5" />
      <text x="${padL}" y="${h - 8}" fill="#888" font-size="10">${formatTs(firstTs)}</text>
      <text x="${w - padR}" y="${h - 8}" fill="#888" font-size="10" text-anchor="end">${formatTs(lastTs)}</text>
      <g transform="translate(${w - padR - 200}, ${padT + 4})">
        <rect width="10" height="2" fill="#f87171" y="6" />
        <text x="14" y="10" fill="#888" font-size="10">stall (lower better)</text>
        <rect width="10" height="2" fill="#4ade80" y="20" />
        <text x="14" y="24" fill="#888" font-size="10">engagement (higher better)</text>
      </g>
    </svg>
    <div style="font-size:.75rem;color:var(--muted,#888);margin-top:.25rem;">
      ${sorted.length} window(s) · stall valid: ${stallVals.length} · engagement valid: ${engVals.length}
    </div>
  `;
}

function formatTs(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

// ─── Recent surfaces ──────────────────────────────────────────────────────

function renderSurfaces(engage24h) {
  const el = document.getElementById("fitness-surfaces-list");
  if (!el) return;

  // Build a map: surface_id → { emitted, outcome }
  const surfaces = new Map();
  for (const e of engage24h) {
    if (e.type === "surface_emitted") {
      if (!surfaces.has(e.surface_id)) {
        surfaces.set(e.surface_id, { emitted: e, outcome: null });
      } else {
        surfaces.get(e.surface_id).emitted = e;
      }
    } else if (e.type === "engagement") {
      if (!surfaces.has(e.surface_id)) {
        surfaces.set(e.surface_id, { emitted: null, outcome: e });
      } else {
        surfaces.get(e.surface_id).outcome = e;
      }
    }
  }

  const rows = [...surfaces.values()]
    .filter((s) => s.emitted)
    .sort((a, b) => Date.parse(b.emitted.ts) - Date.parse(a.emitted.ts))
    .slice(0, 30);

  if (rows.length === 0) {
    el.innerHTML = `<div style="color:var(--muted,#888);">No surfaces emitted in the last 24h.</div>`;
    return;
  }

  el.innerHTML = rows
    .map((s) => {
      const symbol = s.outcome
        ? s.outcome.outcome === "acted"
          ? "✓"
          : s.outcome.outcome === "acked"
            ? "•"
            : "⊘"
        : "⏳";
      const color = s.outcome
        ? s.outcome.outcome === "acted"
          ? "#4ade80"
          : s.outcome.outcome === "acked"
            ? "#fbbf24"
            : "#f87171"
        : "#888";
      const age = ageString(s.emitted.ts);
      const short = s.emitted.surface_id.slice(0, 12);
      return `<div style="display:grid;grid-template-columns:1.5rem 1fr auto auto;gap:.5rem;align-items:center;padding:.15rem 0;border-bottom:1px solid rgba(127,127,127,0.1);">
        <span style="color:${color};font-weight:bold;text-align:center;">${symbol}</span>
        <span>${escapeHtml(s.emitted.surface_type)}</span>
        <span style="color:var(--muted,#888);">${short}</span>
        <span style="color:var(--muted,#888);">${age}</span>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ageString(iso) {
  if (!iso) return "";
  try {
    const ms = Date.now() - Date.parse(iso);
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  } catch {
    return "";
  }
}

// ─── Health verdict ────────────────────────────────────────────────────────

function renderHealth(health) {
  const pill = document.getElementById("fitness-health-pill");
  if (!pill) return;
  const verdict = health.health || "red";
  const reason = health.reason || "";
  const colors = {
    green: { bg: "rgba(74,222,128,0.2)", text: "#4ade80", border: "#4ade80" },
    yellow: { bg: "rgba(251,191,36,0.2)", text: "#fbbf24", border: "#fbbf24" },
    red: { bg: "rgba(248,113,113,0.2)", text: "#f87171", border: "#f87171" },
  };
  const c = colors[verdict] || colors.red;
  pill.style.background = c.bg;
  pill.style.color = c.text;
  pill.style.border = `1px solid ${c.border}`;
  pill.title = reason;
  pill.textContent = "● " + verdict.toUpperCase();

  // Update scaffold version + last refresh in the meta panel
  const sv = document.getElementById("fitness-scaffold-version");
  if (sv) {
    sv.textContent = health.latest_window?.scaffold_version || "—";
  }
  const lr = document.getElementById("fitness-last-refresh");
  if (lr) {
    lr.textContent = new Date().toLocaleTimeString();
  }
}
