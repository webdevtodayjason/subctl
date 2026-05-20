// subctl — update modal (v2.8.8)
//
// Lazy-loaded from app.js when the #version-chip is first clicked. Renders a
// modal with three options matching the existing CLI verbs:
//   dashboard-deploy → `subctl dashboard deploy`    (fastest, UI-only refresh)
//   fast-deploy      → `subctl deploy`              (pulls + restarts daemons)
//   full-update      → `subctl update`              (full ceremony + doctor)
//
// Subscribes to /api/update/events (EventSource) for live `update_progress`
// + `update_finished` events. Tears down the EventSource on close so it
// doesn't leak a long-poll handle past the modal lifetime.

const MODES = [
  {
    id: "dashboard-deploy",
    title: "Dashboard refresh",
    eta: "~5s",
    desc: "Pulls origin/main into the install tree and bounces the dashboard. UI changes only — master daemon stays up.",
    confirm: "Restart the dashboard now? Chat tab will reconnect when it comes back.",
  },
  {
    id: "fast-deploy",
    title: "Fast deploy",
    eta: "~30s",
    desc: "Pulls origin/main and restarts master + dashboard. Picks up backend changes too.",
    confirm: "Restart master + dashboard now? Active chat transcripts are preserved.",
  },
  {
    id: "full-update",
    title: "Full update",
    eta: "~2–5 min",
    desc: "The careful path: working-tree check, git fetch+ff, bun install for changed deps, restart all daemons, then `subctl doctor`.",
    confirm: "Run the full update flow? This restarts every subctl daemon and may pause work for several minutes.",
  },
];

let _instance = null;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function setChipState(state) {
  const chip = document.getElementById("version-chip");
  if (chip) chip.dataset.updateState = state;
}

function tsLocal(ms) {
  try { return new Date(ms).toLocaleTimeString(); } catch { return String(ms); }
}

function buildModal(opts) {
  // opts: { runningVersion, latestTag, hasUpdate }
  const optionsPane = el("div", { class: "update-modal-options" },
    MODES.map((m) => el("button", {
      type: "button",
      class: "update-option-card",
      "data-mode": m.id,
    }, [
      el("div", { class: "update-option-card-head" }, [
        el("span", { class: "update-option-card-title" }, [m.title]),
        el("span", { class: "update-option-card-eta" }, [m.eta]),
      ]),
      el("div", { class: "update-option-card-desc" }, [m.desc]),
    ])),
  );

  const progressLog = el("pre", { class: "update-progress-log", id: "update-progress-log" });
  const progressStatus = el("span", { id: "update-progress-status", class: "update-progress-status-running" }, ["—"]);
  const progressMeta = el("div", { class: "update-progress-meta", id: "update-progress-meta" });
  const progressPane = el("div", { class: "update-progress-pane", hidden: true, id: "update-progress-pane" }, [
    el("div", { class: "update-progress-header" }, [
      el("strong", { id: "update-progress-mode" }, ["—"]),
      progressStatus,
    ]),
    progressLog,
    progressMeta,
  ]);

  const versionLine = el("div", { class: "update-modal-versions", id: "update-modal-versions" }, [
    el("span", {}, ["Running: ", el("code", {}, [`v${String(opts.runningVersion || "").replace(/^v/, "")}`])]),
    opts.latestTag
      ? el("span", { class: opts.hasUpdate ? "available" : "" }, [
          "Latest: ", el("code", {}, [opts.latestTag]),
          opts.hasUpdate ? " · update available" : " · up to date",
        ])
      : el("span", {}, ["Latest: ", el("code", {}, ["—"])]),
  ]);

  const hint = el("p", { class: "update-modal-hint" }, [
    "Pick one. All three pull origin/main first — they differ only in how much else they restart and verify.",
  ]);

  const closeBtn = el("button", {
    type: "button",
    class: "modal-close",
    "aria-label": "close",
    id: "update-modal-close",
  }, ["✕"]);

  const backdrop = el("div", {
    class: "modal-backdrop",
    id: "update-modal-backdrop",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "update-modal-title",
  }, [
    el("div", { class: "modal update-modal" }, [
      el("header", { class: "modal-header" }, [
        el("h3", { id: "update-modal-title" }, ["Update subctl"]),
        closeBtn,
      ]),
      el("div", { class: "modal-body" }, [
        versionLine,
        hint,
        optionsPane,
        progressPane,
      ]),
    ]),
  ]);

  return { backdrop, optionsPane, progressPane, progressLog, progressStatus, progressMeta, versionLine };
}

function appendProgressLine(logEl, payload) {
  const lineEl = document.createElement("span");
  if (payload.stream === "stderr") lineEl.className = "line-err";
  lineEl.textContent = String(payload.line ?? "") + "\n";
  logEl.appendChild(lineEl);
  // Cap to last ~500 lines to keep DOM size bounded on long runs.
  while (logEl.childNodes.length > 500) {
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function close() {
  if (!_instance) return;
  try { _instance.eventSource?.close(); } catch {}
  document.removeEventListener("keydown", _instance.escHandler);
  _instance.backdrop.remove();
  _instance = null;
}

function attachEventSource(refs) {
  // Single EventSource per modal session. We listen for both
  // update_progress (line streaming) and update_finished (terminal state).
  const es = new EventSource("/api/update/events");
  es.addEventListener("update_running", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      // A run was already in flight when modal opened — switch to progress view.
      refs.showProgress(data.mode);
    } catch {}
  });
  es.addEventListener("update_progress", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      appendProgressLine(refs.progressLog, data);
    } catch {}
  });
  es.addEventListener("update_finished", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const status = refs.progressStatus;
      status.textContent = data.ok
        ? "✓ complete"
        : (data.timeout ? "⏱ timed out" : `✗ failed (exit ${data.exitCode})`);
      status.className = data.ok
        ? "update-progress-status-ok"
        : "update-progress-status-err";
      const dur = data.finished_at && data.started_at
        ? `${((data.finished_at - data.started_at) / 1000).toFixed(1)}s`
        : "?";
      refs.progressMeta.textContent = `finished at ${tsLocal(data.finished_at)} · duration ${dur}`;
      setChipState(data.ok ? "done" : "available");
      // Refresh the version line in case VERSION changed.
      fetch("/api/version").then((r) => r.json()).then((j) => {
        const versions = document.getElementById("update-modal-versions");
        if (versions && j && j.version) {
          const codeEl = versions.querySelector("code");
          if (codeEl) codeEl.textContent = `v${String(j.version).replace(/^v/, "")}`;
        }
      }).catch(() => {});
    } catch {}
  });
  es.addEventListener("update_available", () => {
    // Future-proof: keep wiggle going if a newer tag arrives mid-run.
    setChipState("available");
  });
  es.onerror = () => {
    // Browser will auto-reconnect; nothing to do unless we want a UI cue.
  };
  return es;
}

async function runMode(mode, refs) {
  const spec = MODES.find((m) => m.id === mode);
  if (!spec) return;
  // window.confirm is a blocking dialog. The CLAUDE.md guidance about
  // dialogs applies to Chrome MCP automation, not real users — but we use
  // a non-blocking inline confirmation just to be safe and so SSE keeps
  // flowing while the operator decides. Inline confirm replaces the
  // options pane until they choose.
  const proceed = await inlineConfirm(refs, spec.confirm);
  if (!proceed) return;

  refs.showProgress(mode);
  setChipState("updating");

  try {
    const r = await fetch("/api/update/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!r.ok && r.status !== 408) {
      const body = await r.text();
      const status = refs.progressStatus;
      status.textContent = `✗ HTTP ${r.status}`;
      status.className = "update-progress-status-err";
      appendProgressLine(refs.progressLog, { stream: "stderr", line: body });
      setChipState("available");
    }
    // Success/failure painting is driven by the update_finished SSE event
    // (handled in attachEventSource). The fetch resolves at the same time
    // as the event arrives.
  } catch (err) {
    const status = refs.progressStatus;
    status.textContent = `✗ ${err.message || err}`;
    status.className = "update-progress-status-err";
    setChipState("available");
  }
}

function inlineConfirm(refs, message) {
  return new Promise((resolve) => {
    // Replace options with a confirm prompt — keeps the modal cohesive
    // and avoids triggering a browser-modal which would freeze SSE pumps.
    const original = refs.optionsPane.innerHTML;
    refs.optionsPane.innerHTML = "";
    const wrap = el("div", { class: "update-option-card", style: "cursor: default;" }, [
      el("div", { class: "update-option-card-desc", style: "margin-bottom: 12px;" }, [message]),
      el("div", { style: "display: flex; gap: 8px; justify-content: flex-end;" }, [
        el("button", {
          type: "button",
          class: "update-option-card",
          style: "flex: 0 0 auto; padding: 6px 14px;",
          onclick: () => { refs.optionsPane.innerHTML = original; bindCards(refs); resolve(false); },
        }, ["Cancel"]),
        el("button", {
          type: "button",
          class: "update-option-card",
          style: "flex: 0 0 auto; padding: 6px 14px; border-color: #6aa9ff; color: #6aa9ff;",
          onclick: () => resolve(true),
        }, ["Run"]),
      ]),
    ]);
    refs.optionsPane.appendChild(wrap);
  });
}

function bindCards(refs) {
  for (const card of refs.optionsPane.querySelectorAll("[data-mode]")) {
    card.addEventListener("click", () => runMode(card.dataset.mode, refs));
  }
}

export async function openUpdateModal() {
  if (_instance) return; // already open

  // Pull the freshest check result so versions render correctly even if
  // the polling cycle hasn't tripped yet.
  let info = { running_version: "unknown", latest_tag: null, has_update: false };
  try {
    const r = await fetch("/api/update/check");
    if (r.ok) info = await r.json();
  } catch {}

  const built = buildModal({
    runningVersion: info.running_version,
    latestTag: info.latest_tag,
    hasUpdate: info.has_update,
  });
  document.body.appendChild(built.backdrop);

  const refs = {
    backdrop: built.backdrop,
    optionsPane: built.optionsPane,
    progressPane: built.progressPane,
    progressLog: built.progressLog,
    progressStatus: built.progressStatus,
    progressMeta: built.progressMeta,
    showProgress(mode) {
      built.optionsPane.hidden = true;
      built.progressPane.hidden = false;
      const head = document.getElementById("update-progress-mode");
      if (head) head.textContent = `subctl ${MODES.find((m) => m.id === mode)?.title ?? mode}`;
      const status = built.progressStatus;
      status.textContent = "running…";
      status.className = "update-progress-status-running";
    },
  };

  bindCards(refs);

  const escHandler = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", escHandler);

  // Click outside the modal panel closes it. Inside-the-modal clicks bubble
  // to the backdrop, so we check that the actual target IS the backdrop.
  built.backdrop.addEventListener("click", (e) => {
    if (e.target === built.backdrop) close();
  });
  document.getElementById("update-modal-close").addEventListener("click", close);

  const eventSource = attachEventSource(refs);

  _instance = { backdrop: built.backdrop, escHandler, eventSource };
}

export function closeUpdateModal() {
  close();
}

// Expose on window for the lazy-loader in app.js.
if (typeof window !== "undefined") {
  window.__subctlUpdateModal = { open: openUpdateModal, close: closeUpdateModal };
}
