// dashboard/public/tabs/models.js
//
// v2.8.6 — Models tab (LM Studio model catalog). Wave 3 of
// dashboard/public/app.js decomposition. Extracted verbatim from
// `wireModelsTab` @ app.js:3515–3625 (and its leading section header @ 3514).
//
// Self-contained:
//   - reads /api/models  (single endpoint; LM Studio passthrough on master)
//   - no shared state, no window.__subctl* bridges, no cross-tab references
//   - inlines `$` / `td` / `emptyRow` helpers that lived at app.js module
//     scope; same body shape as the original
//
// The trivial case for the {id, mount, unmount} interface — even simpler
// than wave-2 (Templates) since there is exactly one fetch endpoint. See
// DECISIONS.md "wave 3" entry for the readout.

export const id = "models";

// Module-scope poll handle. The 5s interval is kicked off inside mount();
// captured here (not closure-scoped) so unmount() can clear it. Bootstrap
// never calls unmount today, but parity with wave-1 (logs.js) means future
// unmount wiring lands without a refactor.
let pollTimer = null;

export async function mount({ root: _root }) {
  // Per-page-unique IDs — same idiom as waves 1+2 (logs.js, templates.js)
  // and the original wireModelsTab. `$()` in app.js was just a
  // getElementById wrapper.
  const body = document.getElementById("models-body");
  const status = document.getElementById("models-status");
  const summary = document.getElementById("models-summary");
  if (!body) return;

  // Local cell builders — these lived at app.js module scope (lines 6300
  // and 6785). Inlined here to keep the module self-contained. Behavior
  // identical to the originals.
  function td(content, cls) {
    const cell = document.createElement("td");
    if (cls) cell.className = cls;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    return cell;
  }
  function emptyRow(cols, msg) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = cols;
    cell.className = "empty";
    cell.textContent = msg;
    tr.appendChild(cell);
    return tr;
  }

  async function refresh() {
    try {
      const r = await fetch("/api/models");
      const j = await r.json();
      if (!j.ok) {
        // v2.7.7 — surface kind-specific human-language errors.
        // /api/models now returns: kind, message, hint, host (see dashboard/server.ts).
        const statusByKind = {
          missing_token: "no token",
          invalid_token: "token rejected",
          unreachable: "unreachable",
          http_error: "lm studio error",
        };
        const statusText = statusByKind[j.kind] || "unreachable";
        if (status) { status.textContent = statusText; status.dataset.state = "err"; }
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 9;
        td.className = "empty lmstudio-err";
        td.dataset.kind = j.kind || "unknown";
        if (j.message) {
          const line = document.createElement("div");
          line.className = "lmstudio-err-msg";
          line.textContent = j.message;
          td.appendChild(line);
        }
        if (j.hint) {
          const hint = document.createElement("div");
          hint.className = "lmstudio-err-hint";
          hint.textContent = j.hint;
          td.appendChild(hint);
        }
        if (!j.message && !j.hint) {
          td.textContent = j.error || "LM Studio API unreachable";
        }
        tr.appendChild(td);
        body.replaceChildren(tr);
        if (summary) summary.textContent = "";
        return;
      }
      if (status) { status.textContent = "live"; status.dataset.state = "ok"; }
      if (summary) {
        summary.innerHTML =
          `<span><strong>${j.total}</strong> total</span> · ` +
          `<span><strong>${j.loaded_count}</strong> loaded</span> · ` +
          `<span class="dim">host ${j.host}</span> · ` +
          `<span class="dim">refreshed ${new Date(j.ts).toLocaleTimeString()}</span>`;
      }
      const sorted = (j.models || []).slice().sort((a, b) => {
        if (a.state === "loaded" && b.state !== "loaded") return -1;
        if (a.state !== "loaded" && b.state === "loaded") return 1;
        return (a.id || "").localeCompare(b.id || "");
      });
      if (sorted.length === 0) {
        body.replaceChildren(emptyRow(9, "no models"));
        return;
      }
      body.replaceChildren(...sorted.map((m) => {
        const tr = document.createElement("tr");
        if (m.state === "loaded") tr.classList.add("model-loaded");
        tr.appendChild(td(m.id));
        tr.appendChild(td(m.type || "—"));
        const stateCell = document.createElement("td");
        const pill = document.createElement("span");
        pill.className = "model-state-pill model-state-" + (m.state || "unknown");
        pill.textContent = m.state || "?";
        stateCell.appendChild(pill);
        tr.appendChild(stateCell);
        tr.appendChild(td(m.publisher || "—"));
        tr.appendChild(td(m.arch || "—"));
        tr.appendChild(td(m.quantization || "—"));
        tr.appendChild(td(m.max_context_length ? m.max_context_length.toLocaleString() : "—", "num"));
        tr.appendChild(td(m.loaded_context_length ? m.loaded_context_length.toLocaleString() : "—", "num"));
        const capsCell = document.createElement("td");
        (m.capabilities || []).forEach((c) => {
          const cp = document.createElement("span");
          cp.className = "model-cap-pill";
          cp.textContent = c;
          capsCell.appendChild(cp);
        });
        if (!(m.capabilities || []).length) capsCell.textContent = "—";
        tr.appendChild(capsCell);
        return tr;
      }));
    } catch (err) {
      if (status) { status.textContent = "error"; status.dataset.state = "err"; }
      body.replaceChildren(emptyRow(9, "fetch error: " + err));
    }
  }

  // v2.8.9 — refresh every 30s (was 5s) so we don't beat on LM Studio's
  // /api/v0/models endpoint. The dashboard server caches that response for
  // 30s anyway, so polling faster than the cache TTL just generates load
  // without giving the operator any freshness benefit. If a faster update
  // is needed after loading/unloading a model, the Refresh button hits
  // POST /api/models/refresh which busts the cache immediately.
  refresh();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refresh();
  });
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const panel = document.getElementById("models-panel");
    if (panel && getComputedStyle(panel).display !== "none") refresh();
  }, 30000);
}

export function unmount() {
  // Interface parity with wave-1 (logs.js). Bootstrap never calls this
  // today, but clearing the interval keeps us honest if it ever does.
  // The visibilitychange listener is intentionally left untouched — it
  // doesn't have a named ref in the original code, and adding one would
  // be a behavior-adjacent change.
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
