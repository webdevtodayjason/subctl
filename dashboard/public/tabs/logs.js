// dashboard/public/tabs/logs.js
//
// v2.8.6 — Live Logs tab. Wave 1 of dashboard/public/app.js decomposition.
// Extracted from `wireLogsTab` @ app.js:477 and `wireLogsPolicyChip` @
// app.js:7283.
//
// Owns its SSE handles (the launchd-log stream and the per-team audit
// stream), plus the audit-detail panel + allowlist-modal state. Reads
// `cachedTeams` and triggers `refreshPolicyTeamsForDropdowns` through
// temporary `window.__subctl*` bridges exposed by app.js — see
// ORCHESTRATION.md 2026-05-13 night session for the state-ownership ruling.
// Those bridges retire when the Policy tab also extracts in a later wave.

export const id = "logs";

// ── Module-scope state ────────────────────────────────────────────────────
//
// Two of these (policyAuditTeam, policyEventSource) lived at app.js module
// scope per the spec. The other two (policySubfilter, lastClickedAuditEntry)
// were also at app.js module scope but are only touched by code that lives
// here now (the chip + showAuditDetail/hideAuditDetail), so they travel with
// the chip — see the team-lead report for the discrepancy notice against
// the spec's literal "lines 7139-7280 STAY" wording.
let policyAuditTeam = null;
let policyEventSource = null;
let policySubfilter = "all";        // "all" | "deny" | "verifier"
let lastClickedAuditEntry = null;

// Launchd-log stream handle. Captured here (not closure-scoped to mount) so
// unmount() can close it.
let logsEventSource = null;
let logsBackoffMs = 1000;
const MAX_LINES = 5000;

// ──────────────────────────────────────────────────────────────────────────
//                          Lifecycle: mount + unmount
// ──────────────────────────────────────────────────────────────────────────

export async function mount({ root: _root }) {
  // Per-page-unique IDs — using document.getElementById keeps parity with
  // the original `$()` callsites and means a stray `root` mistype can't
  // silently break us during the extraction.
  const view = document.getElementById("logs-view");
  const sourceSel = document.getElementById("logs-source");
  const status = document.getElementById("logs-status");
  const autoscrollCb = document.getElementById("logs-autoscroll");
  const clearBtn = document.getElementById("logs-clear-btn");
  const copyBtn = document.getElementById("logs-copy-btn");
  if (!view || !sourceSel) return;

  function setStatus(state) {
    if (!status) return;
    status.textContent = state;
    status.className = "logs-status " + (state === "live" ? "connected" : state === "connecting" || state === "reconnecting" ? "connecting" : state.startsWith("error") ? "error" : "");
  }

  function classify(line) {
    const lc = line.toLowerCase();
    if (/(error|fatal|critical|✗|abort|exception|crashed)/.test(lc)) return "err";
    if (/(warn|warning|degraded)/.test(lc)) return "warn";
    if (/(✓|ok\b|ready|listening|armed)/.test(lc)) return "ok";
    if (/(boot|init|spawn|reload)/.test(lc)) return "info";
    return "";
  }

  function appendLines(lines) {
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      if (!line) continue;
      const div = document.createElement("div");
      div.className = "log-line " + classify(line);
      div.textContent = line;
      frag.appendChild(div);
    }
    view.appendChild(frag);
    // Cap total rendered lines to avoid DOM bloat
    while (view.childElementCount > MAX_LINES) view.removeChild(view.firstChild);
    if (autoscrollCb?.checked !== false) view.scrollTop = view.scrollHeight;
  }

  function clearView() {
    view.innerHTML = "";
  }

  function disconnect() {
    if (logsEventSource) try { logsEventSource.close(); } catch {}
    logsEventSource = null;
  }

  function connect() {
    disconnect();
    const src = sourceSel.value;
    setStatus("connecting");
    clearView();
    const es = new EventSource(`/api/logs/${src}/stream`);
    logsEventSource = es;
    es.addEventListener("snapshot", (e) => {
      try {
        const d = JSON.parse(e.data);
        clearView();
        appendLines(d.lines || []);
        setStatus("live");
      } catch {}
    });
    es.addEventListener("append", (e) => {
      try {
        const d = JSON.parse(e.data);
        appendLines(d.lines || []);
      } catch {}
    });
    es.addEventListener("error", () => {
      setStatus("error · reconnecting");
      try { es.close(); } catch {}
      setTimeout(connect, logsBackoffMs);
      logsBackoffMs = Math.min(logsBackoffMs * 2, 15000);
    });
    es.addEventListener("open", () => { logsBackoffMs = 1000; });
  }

  sourceSel.addEventListener("change", () => connect());
  if (clearBtn) clearBtn.addEventListener("click", clearView);
  if (copyBtn) copyBtn.addEventListener("click", () => {
    const text = Array.from(view.querySelectorAll(".log-line")).map((el) => el.textContent).join("\n");
    navigator.clipboard.writeText(text);
    copyBtn.textContent = "copied ✓";
    setTimeout(() => copyBtn.textContent = "copy all", 1500);
  });

  // mount() is only invoked when the tab is first activated, so no need for
  // the MutationObserver / lazy-connect dance the classic app.js used.
  connect();

  mountPolicyChip();
}

export function unmount() {
  if (logsEventSource) {
    try { logsEventSource.close(); } catch {}
    logsEventSource = null;
  }
  if (policyEventSource) {
    try { policyEventSource.close(); } catch {}
    policyEventSource = null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//        Audit detail panel + allowlist-modal helpers (chip-only)
// ──────────────────────────────────────────────────────────────────────────

function showAuditDetail(entry) {
  lastClickedAuditEntry = entry;
  const panel = document.getElementById("logs-detail");
  const json = document.getElementById("logs-detail-json");
  const title = document.getElementById("logs-detail-title");
  if (!panel || !json || !title) return;
  title.textContent = `${entry.decision || ""} · ${entry.team_id || ""} · ${entry.ts || ""}`;
  json.textContent = JSON.stringify(entry, null, 2);
  panel.hidden = false;
  // Only enable the suggest button for denials with a real command.
  const sugg = document.getElementById("logs-detail-suggest");
  if (sugg) {
    const isDenyWithCmd = entry.decision === "deny" && entry.command;
    sugg.disabled = !isDenyWithCmd;
    sugg.style.opacity = isDenyWithCmd ? "1" : "0.5";
  }
}

function hideAuditDetail() {
  const panel = document.getElementById("logs-detail");
  if (panel) panel.hidden = true;
  lastClickedAuditEntry = null;
}

// Conservative client-side TOML snippet generator (mirrors the server
// helper in dashboard/lib/audit-api.ts; doing it client-side keeps the
// modal open instantly without a roundtrip).
function buildAllowlistSnippet(entry) {
  if (!entry || entry.decision !== "deny") return "# Entry was already allowed — no addition needed.\n";
  const cmd = (entry.command || "").trim();
  if (!cmd) return "# No command captured on this entry; cannot generate a TOML snippet.\n";
  const parts = cmd.split(/\s+/);
  const head = JSON.stringify(parts[0]);
  const rest = parts.slice(1).join(" ");
  if (entry.rule_path && entry.rule_path.includes("deny_always")) {
    return [
      "# This denial fired on a deny_always rule:",
      `#   rule_path = ${JSON.stringify(entry.rule_path)}`,
      `#   rule      = ${JSON.stringify(entry.rule || "")}`,
      "#",
      "# deny_always wins over allow_pattern. To permit:",
      "#   1. Edit the deny_always.substrings / deny_always.regex list to remove",
      "#      the matching entry, OR",
      "#   2. Override at the project layer with an empty list (disables that",
      "#      family of denials for this project):",
      "#",
      "#      [mode.gated.deny_always]",
      "#      substrings = []",
      "#",
      "# (We do NOT generate option 2 automatically — it's a deliberate act.)",
      "",
    ].join("\n");
  }
  return [
    "# Suggested addition to <project>/.subctl/policy.toml",
    `# Generated from a denial at ${entry.ts} (rule_path=${JSON.stringify(entry.rule_path || "")}).`,
    "# Review carefully before applying — widening the gate is permanent.",
    "",
    "[[mode.gated.allow_pattern]]",
    `command = ${head}`,
    `args = [${rest ? JSON.stringify(rest) : "# any"}]`,
    "",
  ].join("\n");
}

function openAllowlistModal(entry) {
  const modal = document.getElementById("allowlist-modal");
  const pre = document.getElementById("allowlist-snippet");
  if (!modal || !pre) return;
  pre.textContent = buildAllowlistSnippet(entry);
  modal.hidden = false;
  const status = document.getElementById("allowlist-status");
  if (status) { status.hidden = true; status.textContent = ""; }
}

function closeAllowlistModal() {
  const modal = document.getElementById("allowlist-modal");
  if (modal) modal.hidden = true;
}

// ──────────────────────────────────────────────────────────────────────────
//                       Policy filter chip (PR 11)
// ──────────────────────────────────────────────────────────────────────────

function mountPolicyChip() {
  const chip = document.getElementById("logs-chip-policy");
  const teamSel = document.getElementById("logs-policy-team");
  const subchipBox = document.getElementById("logs-subchips");
  const meta = document.getElementById("logs-policy-meta");
  const view = document.getElementById("logs-view");
  const status = document.getElementById("logs-status");
  if (!chip || !teamSel || !view) return;

  function setStatus(s, cls) {
    if (!status) return;
    status.textContent = s;
    status.className = "logs-status " + (cls || "");
  }

  function disconnectPolicy() {
    if (policyEventSource) {
      try { policyEventSource.close(); } catch {}
      policyEventSource = null;
    }
  }

  function connectPolicy() {
    disconnectPolicy();
    const team = teamSel.value;
    if (!team) { setStatus("no team selected", ""); return; }
    policyAuditTeam = team;
    view.innerHTML = "";
    setStatus("connecting", "connecting");
    const es = new EventSource(`/api/audit/${encodeURIComponent(team)}/stream`);
    policyEventSource = es;
    es.addEventListener("snapshot", (e) => {
      try {
        const d = JSON.parse(e.data);
        view.innerHTML = "";
        // server sends most-recent-first in the list endpoint; for the
        // SSE snapshot we use the list endpoint internally, so reverse
        // to chronological for natural top-to-bottom flow.
        const ents = (d.entries || []).slice().reverse();
        window.__subctlRenderAuditEntries?.(view, ents, { subfilter: policySubfilter });
        setStatus("live · policy", "connected");
        if (meta) {
          const teams = window.__subctlGetPolicyTeams?.() || [];
          const row = teams.find((t) => t.team_id === team);
          meta.textContent = row
            ? `mode=${row.mode || "?"}  preset=${row.preset || "?"}  sha=${row.allowlist_sha || "?"}`
            : "";
        }
      } catch {}
    });
    es.addEventListener("append", (e) => {
      try {
        const d = JSON.parse(e.data);
        window.__subctlRenderAuditEntries?.(view, d.entries || [], { subfilter: policySubfilter });
      } catch {}
    });
    es.addEventListener("error", () => {
      setStatus("error · reconnecting", "error");
    });
  }

  chip.addEventListener("click", () => {
    const active = chip.dataset.active === "true";
    chip.dataset.active = active ? "false" : "true";
    if (subchipBox) subchipBox.hidden = active;
    if (!active) {
      // turning ON
      const refresh = window.__subctlRefreshPolicyTeams?.() ?? Promise.resolve();
      refresh.then(() => {
        const teams = window.__subctlGetPolicyTeams?.() || [];
        if (!teamSel.value && teams[0]) teamSel.value = teams[0].team_id;
        connectPolicy();
      });
    } else {
      // turning OFF — reconnect the launchd log stream the normal way
      disconnectPolicy();
      policyAuditTeam = null;
      view.innerHTML = "";
      setStatus("disconnected", "");
      if (meta) meta.textContent = "";
      // Re-fire the source select to reconnect to whatever was selected
      const src = document.getElementById("logs-source");
      if (src) src.dispatchEvent(new Event("change"));
    }
  });

  teamSel.addEventListener("change", () => {
    if (chip.dataset.active === "true") connectPolicy();
  });

  // Sub-chips
  if (subchipBox) {
    subchipBox.querySelectorAll(".logs-subchip").forEach((b) => {
      b.addEventListener("click", () => {
        subchipBox.querySelectorAll(".logs-subchip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        policySubfilter = b.dataset.subfilter || "all";
        // Re-snapshot so the filter takes effect immediately
        if (chip.dataset.active === "true") connectPolicy();
      });
    });
  }

  // Click handler for audit lines → detail panel
  view.addEventListener("click", (ev) => {
    const target = ev.target.closest(".log-line[data-clickable=\"true\"]");
    if (!target || !target._auditEntry) return;
    showAuditDetail(target._auditEntry);
  });

  const closeBtn = document.getElementById("logs-detail-close");
  if (closeBtn) closeBtn.addEventListener("click", hideAuditDetail);

  const suggestBtn = document.getElementById("logs-detail-suggest");
  if (suggestBtn) {
    suggestBtn.addEventListener("click", () => {
      if (lastClickedAuditEntry) openAllowlistModal(lastClickedAuditEntry);
    });
  }

  // Modal
  const modal = document.getElementById("allowlist-modal");
  const modalClose = document.getElementById("allowlist-modal-close");
  const copyBtn = document.getElementById("allowlist-copy");
  if (modalClose) modalClose.addEventListener("click", closeAllowlistModal);
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeAllowlistModal(); });
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = (document.getElementById("allowlist-snippet")?.textContent) || "";
      try {
        await navigator.clipboard.writeText(text);
        const s = document.getElementById("allowlist-status");
        if (s) { s.hidden = false; s.textContent = "copied ✓"; }
      } catch {
        const s = document.getElementById("allowlist-status");
        if (s) { s.hidden = false; s.textContent = "clipboard unavailable — select & ⌘C the snippet above"; }
      }
    });
  }
}
