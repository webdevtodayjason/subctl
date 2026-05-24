// dashboard/public/tabs/chat.js
//
// v2.8.6 — Master chat + chat-adjacent helpers. Wave 14 of
// dashboard/public/app.js decomposition. **FINAL extraction.**
//
// Extracted from app.js across 4 non-contiguous chat-zone blocks plus
// the chat-only helper bands at the top of the IIFE:
//   - 63–258:  Tool-call display config (TOOL_DISPLAY_FALLBACK + state +
//              loadToolDisplay + resolveToolDisplay + formatToolArgsPreview +
//              formatToolDetailBlock + renderToolPill +
//              ensureChatToolPillsRow). Grep at extraction time showed
//              zero non-chat-zone callers in app.js or any other tabs/*.js
//              module — these are chat-only helpers, moved en bloc.
//   - 259–310: Thinking indicator (showChatThinking / hideChatThinking /
//              setChatThinkingState). Same chat-only grep result.
//   - 491–609: Chat model selector (top of Chat screen).
//   - 611–710: Supervisor profile pill (v2.7.18).
//   - 722–796: attachOneShotAssistantCapture (one-shot SSE listener used
//              by tabs/projects.js wave 9 for per-project chat panels).
//   - 798–1930: Master chat — the biggest single function in the codebase
//              (~1,133 LOC: SSE-backed conversation with the master daemon,
//              transcript context meter, tool-display rendering, voice
//              flag, master events stream, compact/clear commands).
//
// PUBLISHES window.__subctlAttachOneShotAssistantCapture from mount() —
// consumed by tabs/projects.js (wave 9) for per-project chat panels.
// Published at mount end, nulled in unmount.
//
// CONSUMER of:
//   - window.notice / .error / .confirm  (published by tabs/orch.js wave 13)
//   - window.__subctlPushNotification    (still in app.js shell — notification tray)
//   - window.__subctlHostLabel           (NEW bridge for wave 14, published by
//                                         app.js so this module reads the live
//                                         host label inside slash commands)
//   - window.__subctlVoiceEnabled        (this module writes it; app.js doesn't
//                                         touch it — staying on window for namespace
//                                         stability)
//
// Routing key is "chat" (matches HTML data-tab="chat" — the default-active
// tab at page load, so bootstrap mounts this immediately via boot-tab
// catch-up. The bridge global is published as soon as that mount() body
// runs, so the Projects tab — which the operator can only reach AFTER
// the boot catch-up has fired — always sees a live bridge).
//
// Listener lifecycle: extends wave-4 (Preferences) pattern at scale.
// Multiple SSE streams + window listeners + transcript-context state +
// timer-driven polling are all lifted to module scope; unmount closes
// everything. bootstrap.js never calls unmount() today; this is
// forward-looking hygiene that matches the prior thirteen waves.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/providers
//   GET  /api/master/diag
//   POST /api/master/supervisor
//   GET  /api/profile
//   POST /api/profile
//   GET  /api/master/transcript?limit=N
//   POST /api/master/transcript/compact
//   POST /api/master/transcript/clear
//   GET  /api/master/context
//   GET  /api/master/transcript/util
//   GET  /api/master/events                  (SSE — long-lived)
//   POST /api/master/chat
//   POST /api/master/attachments
//   GET  /api/master/health
//   GET  /api/master/teams
//   GET  /api/voice/status
//   POST /api/voice/render

export const id = "chat";

// ---- Module-scope handles for unmount() ----
//
// Three EventSource categories survive across closures:
//   1. masterEventSource           — Master chat's long-lived SSE stream.
//      `connect()` reassigns this on each reconnect; we always close the
//      latest one in unmount().
//   2. profilePillEventSource      — Profile-pill's quiet observer SSE.
//      Single instance; created once in wireProfilePill().
//   3. oneShotEventSources         — per-call EventSource handles from
//      attachOneShotAssistantCapture (Projects tab uses this for each
//      project chat panel). Tracked in a Set so individual instances
//      can self-remove on natural close.
let masterEventSource = null;
let profilePillEventSource = null;
const oneShotEventSources = new Set();

// Timers + intervals lifted out so unmount() can clear them. Each is
// initialized to null and assigned inside the wirer that owns it.
let chatModelSelectorPollTimer = null;
let profilePillPollTimer = null;
let contextMeterPollTimer = null;
let reconnectingDebounce = null;
let connectBackoffTimer = null;

// Other long-lived listeners / observers.
let chatPanelObserver = null;
let chatFullscreenEscHandler = null;

export async function mount({ root: _root }) {
  // ── Inlined helpers (verbatim from app.js IIFE scope; same idiom as
  //    every prior wave). `$` is the IIFE shorthand at app.js:61.
  function $(id) { return document.getElementById(id); }
  // `escapeText` is the IIFE-scope helper at app.js:712. The HANDOFF
  // asks us to keep the original where it is (orphaned after this wave
  // until a future cleanup). We carry a local copy here so chat.js
  // stays self-contained — same pattern as orch.js (wave 13),
  // providers.js (wave 5), teams.js (wave 12), and every other module
  // that needed it.
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // CSS-escape (subset) — project-chat log ids include "/" and ":" and
  // querySelector chokes on them. Replace anything non-alphanumeric +
  // dash + underscore. Verbatim from app.js:718.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
  }
  // SSH host alias — verbatim from app.js:22. The master daemon may
  // live on a different machine than the dashboard; the /attach SSH
  // command needs the REMOTE host. Until a per-host setting lands in
  // policy.json (TODO already tracked upstream), the alias stays
  // hardcoded — same idiom orch.js inlined in wave 13.
  const SSH_HOST_ALIAS = "argent-m3-ultra-dev";
  // Read the live host label from the app.js-published bridge. The
  // value MUTATES at app.js side after `/api/host` resolves; we snapshot
  // it at SLASH_HELP-build time which mirrors today's wireMasterChat
  // semantics (HOST_LABEL was captured into the closure at wirer-call
  // time before this wave). Bridge falls back to the same "this Mac"
  // default app.js uses.
  function currentHostLabel() {
    return (typeof window !== "undefined" && typeof window.__subctlHostLabel === "string" && window.__subctlHostLabel)
      ? window.__subctlHostLabel
      : "this Mac";
  }

  // ----- Tool-call display config (v2.7.12) -----
  // Maps a tool name → { family, color, icon } so the chat panel can render
  // each tool as a family-colored neon pill instead of a full-width card.
  // Config is fetched once from /tool-display.json (served as a static file
  // by dashboard/server.ts); if the fetch fails (offline, bad deploy, etc.)
  // we fall back to a hardcoded copy so the chat keeps working.
  const TOOL_DISPLAY_FALLBACK = {
    version: 1,
    fallback: { family: "tool", icon: "🔧" },
    families: {
      system:        { color: "#5fd7ff", icon: "🖥" },
      lmstudio:      { color: "#6dd4d4", icon: "🧠" },
      knowledge:     { color: "#d480b8", icon: "📚" },
      memory:        { color: "#b074d6", icon: "💭" },
      network:       { color: "#6cd697", icon: "🌐" },
      orchestration: { color: "#e89a4a", icon: "🎭" },
      docs:          { color: "#7ad4c4", icon: "📝" },
      policy:        { color: "#d6c46c", icon: "🛡" },
      notify:        { color: "#d67aa7", icon: "📣" },
      tool:          { color: "#888888", icon: "🔧" },
    },
    rules: [
      { prefix: "system_lmstudio_",       family: "lmstudio" },
      { exact:  "system_subctl_knowledge", family: "knowledge" },
      { prefix: "system_",                 family: "system" },
      { prefix: "memory_",                 family: "memory" },
      { prefix: "mcp__plugin_claude-mem_", family: "memory" },
      { prefix: "web_",                    family: "network" },
      { prefix: "linear_",                 family: "network" },
      { prefix: "context7_",               family: "network" },
      { prefix: "subctl_orch_",            family: "orchestration" },
      { prefix: "team_doc_",               family: "docs" },
      { exact:  "team_decision_log",       family: "docs" },
      { prefix: "policy_",                 family: "policy" },
      { prefix: "notify_",                 family: "notify" },
      { prefix: "telegram_",               family: "notify" },
    ],
  };
  let _toolDisplayConfig = null;
  let _toolDisplayPromise = null;
  function loadToolDisplay() {
    if (_toolDisplayConfig) return Promise.resolve(_toolDisplayConfig);
    if (_toolDisplayPromise) return _toolDisplayPromise;
    _toolDisplayPromise = fetch("/tool-display.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        _toolDisplayConfig = (j && j.families && j.rules) ? j : TOOL_DISPLAY_FALLBACK;
        return _toolDisplayConfig;
      })
      .catch(() => {
        _toolDisplayConfig = TOOL_DISPLAY_FALLBACK;
        return _toolDisplayConfig;
      });
    return _toolDisplayPromise;
  }
  // Kick off the fetch immediately so the cache is usually warm by the time
  // the first tool call renders. Synchronous lookups fall back if the fetch
  // hasn't resolved yet.
  loadToolDisplay();

  function _toolDisplayConfigSync() {
    return _toolDisplayConfig || TOOL_DISPLAY_FALLBACK;
  }

  // Resolve a tool name → { family, color, icon }. Walks the rules array in
  // order; first match wins. Unmatched → fallback. Matching is case-sensitive
  // because tool names from the LM Studio API are already canonical.
  function resolveToolDisplay(name) {
    const cfg = _toolDisplayConfigSync();
    const safeName = String(name || "");
    for (const rule of cfg.rules || []) {
      if (rule.exact && rule.exact === safeName) {
        const fam = cfg.families[rule.family] || cfg.fallback;
        return { family: rule.family, color: fam.color, icon: fam.icon };
      }
      if (rule.prefix && safeName.startsWith(rule.prefix)) {
        const fam = cfg.families[rule.family] || cfg.fallback;
        return { family: rule.family, color: fam.color, icon: fam.icon };
      }
    }
    const fb = cfg.fallback || { family: "tool", icon: "🔧" };
    const famDef = cfg.families[fb.family] || { color: "#888888", icon: "🔧" };
    return { family: fb.family, color: famDef.color, icon: famDef.icon };
  }

  // Args -> a short single-line preview string. Returns "" when there are
  // no args so callers can hide the preview span entirely (no empty `{}`
  // noise). For one key: `key=value` (value truncated to 24 chars). For 2+:
  // `key1=v1, key2=v2 …` truncated to 40 chars total.
  function formatToolArgsPreview(args) {
    if (args == null) return "";
    let obj = args;
    if (typeof args === "string") {
      const s = args.trim();
      if (!s || s === "{}") return "";
      try { obj = JSON.parse(s); } catch { return s.length > 40 ? s.slice(0, 39) + "…" : s; }
    }
    if (typeof obj !== "object" || Array.isArray(obj)) {
      const s = JSON.stringify(obj);
      return s.length > 40 ? s.slice(0, 39) + "…" : s;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    const fmtVal = (v, max) => {
      let s = (typeof v === "string") ? v : JSON.stringify(v);
      s = String(s).replace(/\s+/g, " ");
      if (s.length > max) s = s.slice(0, max - 1) + "…";
      return s;
    };
    if (keys.length === 1) {
      const k = keys[0];
      return `${k}=${fmtVal(obj[k], 24)}`;
    }
    const parts = keys.slice(0, 4).map((k) => `${k}=${fmtVal(obj[k], 10)}`);
    let out = parts.join(", ");
    if (keys.length > parts.length) out += " …";
    if (out.length > 40) out = out.slice(0, 39) + "…";
    return out;
  }

  // Format the full args + result blob for the click-to-expand panel.
  // Pretty-printed JSON for objects, raw for strings.
  function formatToolDetailBlock(label, value) {
    if (value == null || value === "") return "";
    let body = value;
    if (typeof value !== "string") {
      try { body = JSON.stringify(value, null, 2); } catch { body = String(value); }
    }
    return `${label}:\n${body}`;
  }

  // Render a single tool-call pill. Returns a <button> element ready to be
  // appended into a `.chat-tool-pills` container. `opts.ok` may be true
  // (success), false (error), or undefined (pending — no status glyph yet).
  function renderToolPill(opts) {
    const { name, args, result, ok } = opts || {};
    const disp = resolveToolDisplay(name);
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chat-tool-pill";
    pill.dataset.family = disp.family;
    pill.dataset.toolName = String(name || "");
    pill.style.setProperty("--pill-color", disp.color);

    const iconEl = document.createElement("span");
    iconEl.className = "chat-tool-pill__icon";
    iconEl.textContent = disp.icon;
    pill.appendChild(iconEl);

    const nameEl = document.createElement("span");
    nameEl.className = "chat-tool-pill__name";
    nameEl.textContent = String(name || "tool");
    pill.appendChild(nameEl);

    const preview = formatToolArgsPreview(args);
    if (preview) {
      const argsEl = document.createElement("span");
      argsEl.className = "chat-tool-pill__args";
      argsEl.textContent = preview;
      pill.appendChild(argsEl);
    }

    if (ok === true) pill.classList.add("chat-tool-pill--ok");
    else if (ok === false) pill.classList.add("chat-tool-pill--err");

    if (args != null) pill.dataset.args = (typeof args === "string") ? args : JSON.stringify(args);
    if (result != null) pill.dataset.result = (typeof result === "string") ? result : JSON.stringify(result);

    pill.addEventListener("click", () => {
      const a = formatToolDetailBlock("args", pill.dataset.args || "");
      const r = formatToolDetailBlock("result", pill.dataset.result || "");
      const body = [a, r].filter(Boolean).join("\n\n") || "(no details captured)";
      try {
        if (window.notice) window.notice(`tool · ${pill.dataset.toolName}`, body);
        else alert(body);
      } catch { /* swallow */ }
    });

    return pill;
  }

  // Append `pill` into the most recent `.chat-tool-pills` row attached to
  // `logEl`. If the row doesn't exist yet (this is the first pill of an
  // assistant turn), create one and append it to logEl.
  function ensureChatToolPillsRow(logEl) {
    if (!logEl) return null;
    const lastChild = logEl.lastElementChild;
    if (lastChild && lastChild.classList.contains("chat-tool-pills")) {
      return lastChild;
    }
    const row = document.createElement("div");
    row.className = "chat-tool-pills";
    logEl.appendChild(row);
    return row;
  }

  // Append a tool-call pill into `row`, collapsing into the previous pill
  // when it has the same `name`. Returns the resulting pill — either the
  // existing same-name pill (with count bumped) or a freshly created one.
  //
  // Why collapse: master sometimes hammers the same tool repeatedly
  // (e.g. polling `subctl_orch_status` to wait for a job — operator saw
  // 7 identical pills flooding the chat 2026-05-19 13:46 CDT). Collapsing
  // consecutive same-name pills into ONE pill with an `×N` badge keeps
  // the sidecar readable.
  //
  // Punt on the "break run when ok state changes" rule: we always collapse
  // by name regardless of state, and let the LATEST result win (latest
  // args, latest ok/err glyph). This matches the operator's "click on
  // collapsed pill: show LATEST call's args/result — pick what's cleanest"
  // instruction. Mixed-result runs show as a single pill with the most
  // recent state; click for details.
  function appendOrCollapseToolPill(row, opts) {
    if (!row) return null;
    const { name, args } = opts || {};
    const safeName = String(name || "");
    const lastPill = row.lastElementChild;
    if (
      lastPill &&
      lastPill.classList &&
      lastPill.classList.contains("chat-tool-pill") &&
      lastPill.dataset.toolName === safeName
    ) {
      // Same name as the immediately-prior pill — collapse into it.
      const count = (Number(lastPill.dataset.count) || 1) + 1;
      lastPill.dataset.count = String(count);

      // Update args preview + dataset to the LATEST call.
      if (args != null) {
        const serial = (typeof args === "string") ? args : JSON.stringify(args);
        lastPill.dataset.args = serial;
        const preview = formatToolArgsPreview(args);
        let argsEl = lastPill.querySelector(".chat-tool-pill__args");
        if (preview) {
          if (argsEl) {
            argsEl.textContent = preview;
          } else {
            argsEl = document.createElement("span");
            argsEl.className = "chat-tool-pill__args";
            argsEl.textContent = preview;
            // Insert before the count badge if one exists, so the badge
            // stays at the tail (right next to the ok/err ::after glyph).
            const existingBadge = lastPill.querySelector(".chat-tool-pill__count");
            if (existingBadge) lastPill.insertBefore(argsEl, existingBadge);
            else lastPill.appendChild(argsEl);
          }
        } else if (argsEl) {
          argsEl.remove();
        }
      }

      // Refresh (or create) the ×N count badge — always tail-positioned
      // so the ok/err ::after glyph follows naturally.
      let badge = lastPill.querySelector(".chat-tool-pill__count");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "chat-tool-pill__count";
        lastPill.appendChild(badge);
      }
      badge.textContent = "×" + count;

      return lastPill;
    }

    // Different name (or empty row) — render a fresh pill.
    const pill = renderToolPill(opts);
    row.appendChild(pill);
    return pill;
  }

  // ----- Thinking indicator (v2.7.12, fix v2.8.1) -----
  // Append a transient "Evy · thinking…" pill while master is processing
  // a chat turn. v2.8.1 fix: the indicator now persists through
  // intermediate events (tool_call, tool_result, message_start without
  // text) and is ONLY removed when an actual text_delta paints into the
  // assistant bubble (appendDelta) or the turn ends (endAssistantBubble,
  // agent_end), or on error/timeout. Previously a tool_call between the
  // operator message and the response text would prematurely hide the
  // indicator, leaving the operator staring at silence — the exact bug
  // the operator surfaced 2026-05-13 ("It says 'thinking', and then it
  // goes away, and it takes a hot second for her to respond").
  //
  // Label switches to "Evy · working" while a tool is mid-flight so the
  // operator gets feedback that something IS happening (the tool pills
  // already render below, but the label-flip closes the visual gap
  // between "thinking dots stopped" → "next event lands"). Reverts to
  // "thinking" if the assistant goes quiet again (e.g. tool_result then
  // waiting for the next reasoning step).
  // ── v2.8.1 chat perf / skill router ──
  function showChatThinking(logEl) {
    if (!logEl) return null;
    hideChatThinking(logEl); // dedup — only one at a time
    const el = document.createElement("div");
    el.className = "chat-thinking";
    el.dataset.role = "thinking";
    el.dataset.state = "thinking";
    el.innerHTML =
      '<span class="chat-thinking__label">Evy · thinking</span>' +
      '<span class="chat-thinking__dots"><span>●</span><span>●</span><span>●</span></span>';
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
    return el;
  }
  function hideChatThinking(logEl) {
    if (!logEl) return;
    const existing = logEl.querySelectorAll(".chat-thinking");
    existing.forEach((n) => n.remove());
  }
  // v2.8.1 — flip the label between "thinking" and "working" without
  // removing+re-adding the node (so the CSS dot animation doesn't
  // restart mid-turn). Safe to call when no indicator exists; no-op.
  function setChatThinkingState(logEl, state) {
    if (!logEl) return;
    const el = logEl.querySelector(".chat-thinking");
    if (!el) return;
    if (el.dataset.state === state) return;
    el.dataset.state = state;
    const label = el.querySelector(".chat-thinking__label");
    if (label) {
      label.textContent = state === "working" ? "Evy · working" : "Evy · thinking";
    }
  }

  // ----- Chat model selector (top of Chat screen) -----
  function wireChatModelSelector() {
    const sel = $("chat-model-select");
    const apply = $("chat-model-apply");
    const cur = $("chat-model-current");
    if (!sel || !apply) return;
    // (unused, but preserves the original closure — never read after
    // assignment in the source. Left for shape-fidelity.)
    let _currentSupervisor = null; // eslint-disable-line no-unused-vars

    async function refresh() {
      try {
        const [provR, diagR] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/master/diag"),
        ]);
        const provJ = await provR.json();
        const diag = await diagR.json().catch(() => ({}));
        const supervisor = diag.supervisor ?? null;
        _currentSupervisor = supervisor;
        if (cur) cur.textContent = supervisor ? "supervisor: " + supervisor : "supervisor: (unknown)";
        if (!provJ.ok) {
          sel.innerHTML = "<option value=''>providers unreachable</option>";
          return;
        }
        // Build optgroups: cloud (always-on, green) first, then LM Studio
        // (per-model loaded indicator). Value format: "<provider>|<model>"
        // so the apply handler can split.
        // Cloud first per Jason's "local first" instruction is actually
        // about chat-priority — cloud is always available, but LOCAL is
        // the default we steer toward. Show cloud at the TOP of the
        // dropdown but mark them clearly so they're easy to skip past.
        // Only show cloud providers the operator has actually configured (≥ 1
        // profile). The full catalog stays available in the Providers tab's
        // "+ New Profile" modal dropdown.
        const cloud = (provJ.providers || []).filter(
          (p) => p.kind === "cloud" && (p.profiles || []).length > 0,
        );
        const local = (provJ.providers || []).filter((p) => p.kind === "local");

        let html = "";
        if (cloud.length) {
          html += "<optgroup label=\"Cloud (always-on)\">";
          for (const p of cloud) {
            const dot = p.available ? "●" : "○";
            const wired = p.wired !== false; // default-true for legacy entries
            const hasDefault = !!p.default_model;
            const noteAttr = !wired && p.wired_note ? ` title="${escapeText(p.wired_note)}"` : "";
            // v2.8.17 — enumerate one <option> per catalog-enabled model.
            // The Providers-tab model table's "on" column has always been
            // documented "enabled — appears in chat dropdown"; before this
            // the dropdown only ever rendered each provider's single
            // default_model, so an operator who enabled GPT-5.5 couldn't
            // pick it. `enabled_models` comes from /api/providers.
            const enabledModels = Array.isArray(p.enabled_models) ? p.enabled_models : [];
            if (wired && hasDefault && enabledModels.length) {
              // Sort the provider's default model FIRST (★-marked), the
              // rest by id. The whole provider is authed-or-not, so the
              // per-provider `available` flag drives the state text.
              const sorted = enabledModels.slice().sort((a, b) => {
                if (a.id === p.default_model) return -1;
                if (b.id === p.default_model) return 1;
                return (a.id || "").localeCompare(b.id || "");
              });
              const state = p.available ? "ready" : "not authed";
              for (const m of sorted) {
                const isDefault = m.id === p.default_model;
                const value = `${p.id}|${m.id}`;
                const isCurrent = supervisor === `${p.id}/${m.id}`;
                const label = `${dot}  ${escapeText(p.display)} · ${escapeText(m.id)}${isDefault ? " ★" : ""} · ${state}`;
                html += `<option value="${escapeText(value)}" ${isCurrent ? "selected" : ""}>${label}</option>`;
              }
            } else {
              // Fallback: no catalog fetched yet (or catalog has no enabled
              // models). Render the single default_model row — same logic
              // as pre-v2.8.17.
              //
              // v2.8.8 Phase 1c — disable cloud options that have no shipped
              // default_model. Previously these rendered as "<provider>|?"
              // which POSTed model="?" and wrote garbage into providers.json.
              //
              // v2.8.9 — also disable when the current default_model has been
              // toggled off in the catalog. `default_model_enabled` comes
              // from /api/providers.
              const defaultEnabled = p.default_model_enabled !== false; // default true
              const model = p.default_model || "(no default)";
              const value = (hasDefault && defaultEnabled) ? `${p.id}|${p.default_model}` : "";
              const state = !wired
                ? "not yet wired"
                : !hasDefault
                  ? "no default model — pick via + New Profile"
                  : !defaultEnabled
                    ? "default disabled — re-enable in Providers tab"
                    : p.available
                      ? "ready"
                      : "not authed";
              const isCurrent = hasDefault && defaultEnabled && supervisor === `${p.id}/${p.default_model}`;
              const disabledAttr = (!wired || !hasDefault || !defaultEnabled) ? " disabled" : "";
              html += `<option value="${escapeText(value)}"${disabledAttr}${noteAttr} ${isCurrent ? "selected" : ""}>${dot}  ${escapeText(p.display)} · ${escapeText(model)} · ${state}</option>`;
            }
          }
          html += "</optgroup>";
        }
        if (local.length) {
          for (const p of local) {
            const models = (p.models || []).slice().sort((a, b) => {
              if (a.loaded && !b.loaded) return -1;
              if (!a.loaded && b.loaded) return 1;
              return (a.id || "").localeCompare(b.id || "");
            });
            html += `<optgroup label="LM Studio (local · ${models.filter((m) => m.loaded).length}/${models.length} loaded)">`;
            for (const m of models) {
              const dot = m.loaded ? "●" : "○";
              const ctx = m.loaded_context_length ? `ctx ${m.loaded_context_length.toLocaleString()}` : "";
              const value = `${p.id}|${m.id}`;
              const isCurrent = supervisor === `${p.id}/${m.id}`;
              const parts = [
                m.id,
                m.loaded ? "loaded" : "not-loaded",
                m.quantization,
                ctx,
              ].filter(Boolean).join(" · ");
              html += `<option value="${escapeText(value)}" ${isCurrent ? "selected" : ""}>${dot}  ${escapeText(parts)}</option>`;
            }
            html += "</optgroup>";
          }
        }
        sel.innerHTML = html || "<option value=''>(no providers reachable)</option>";
      } catch (err) {
        sel.innerHTML = "<option value=''>error: " + escapeText(String(err)) + "</option>";
      }
    }
    refresh();
    chatModelSelectorPollTimer = setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"chat\"]");
      if (panel && getComputedStyle(panel).display !== "none") refresh();
    }, 10000);

    apply.addEventListener("click", async () => {
      const picked = sel.value;
      if (!picked) return;
      const [provider, ...modelParts] = picked.split("|");
      const model = modelParts.join("|");
      if (!provider || !model) return;
      const ok = await window.notice.confirm(
        "Switch supervisor model",
        `New supervisor: ${provider} / ${model}\n\nThis edits providers.json and restarts Evy. Your transcript is preserved.`,
      );
      if (!ok) return;
      apply.disabled = true;
      apply.textContent = "applying…";
      try {
        const r = await fetch("/api/master/supervisor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, model }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) {
          apply.textContent = "failed";
          await window.notice.error("Switch failed", j.error || ("HTTP " + r.status));
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; }, 2000);
        } else {
          apply.textContent = "switched ✓";
          setTimeout(() => { apply.disabled = false; apply.textContent = "apply"; refresh(); }, 3500);
        }
      } catch (err) {
        apply.textContent = "error";
        await window.notice.error("Switch error", String(err));
      }
    });
  }

  // ----- Supervisor profile pill (v2.7.18) -----
  // The pill sits inside .master-chat-header next to the Evy h2 and
  // shows / toggles the active supervisor profile. Two profiles for
  // now: "chat" (gemma — fast, conversational) and "heavy" (qwen —
  // deep reasoning, slower, occasionally loops). Click toggles to the
  // other; POST /api/profile lands on the master daemon's profiles.json
  // and the swap takes effect on the next prompt. We piggyback on the
  // existing SSE stream so the pill updates instantly when something
  // else (Telegram /profile, another tab, manual edit) flips it.
  function wireProfilePill() {
    const pill = $("profile-pill");
    const valueEl = $("profile-pill-value");
    if (!pill || !valueEl) return;
    let known = ["chat", "heavy"]; // eslint-disable-line no-unused-vars
    let active = null;
    let inFlight = false;

    function paint(next) {
      active = next;
      valueEl.textContent = next;
      pill.dataset.active = next;
      pill.hidden = false;
      pill.removeAttribute("data-error");
    }
    function flashError() {
      pill.dataset.error = "true";
      setTimeout(() => pill.removeAttribute("data-error"), 1500);
    }

    async function refresh() {
      try {
        const r = await fetch("/api/profile");
        const j = await r.json();
        if (j && j.ok) {
          if (Array.isArray(j.profiles) && j.profiles.length) known = j.profiles;
          if (typeof j.active === "string") paint(j.active);
        }
      } catch {
        /* master unreachable — leave pill hidden */
      }
    }

    async function toggle() {
      if (inFlight || !active) return;
      const next = active === "chat" ? "heavy" : "chat";
      inFlight = true;
      pill.dataset.pending = "true";
      // Optimistic update so the click feels immediate. Reconciled
      // below with the server's response.
      const prev = active;
      paint(next);
      try {
        const r = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: next }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j || !j.ok) {
          paint(prev);
          flashError();
          if (window.notice && window.notice.error) {
            window.notice.error("Profile swap failed", (j && j.error) || ("HTTP " + r.status));
          }
        } else if (typeof j.active === "string") {
          paint(j.active);
          if (window.notice) {
            window.notice("Profile swapped", `Evy will use the ${j.active} profile on the next prompt.`);
          }
        }
      } catch (err) {
        paint(prev);
        flashError();
        if (window.notice && window.notice.error) {
          window.notice.error("Profile swap error", String(err));
        }
      } finally {
        pill.removeAttribute("data-pending");
        inFlight = false;
      }
    }
    pill.addEventListener("click", toggle);

    // Initial load + 30s poll fallback. We also piggyback on the
    // existing /api/master/events SSE so out-of-band swaps (Telegram
    // /profile, manual file edit, another tab) reflect immediately.
    refresh();
    profilePillPollTimer = setInterval(refresh, 30_000);
    try {
      profilePillEventSource = new EventSource("/api/master/events");
      profilePillEventSource.addEventListener("profile_swapped", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d && typeof d.to === "string") paint(d.to);
        } catch { /* ignore */ }
      });
      // Don't reconnect on error here — the chat panel's connectSSE()
      // already owns the canonical lifecycle. This is a quiet observer.
    } catch { /* EventSource unavailable; poll-only fallback is fine */ }
  }

  // One-shot SSE listener that captures the next assistant turn (from the
  // first message_start through agent_end) into a target log element. Used
  // by the per-project chat panels — they piggyback on the same master
  // /events stream the main Chat panel consumes, but render only the
  // current turn into their own scoped log.
  function attachOneShotAssistantCapture(logEl) {
    const es = new EventSource("/api/master/events");
    oneShotEventSources.add(es);
    let bubble = null;
    let toolBubbles = new Map();
    let active = false;
    let acc = "";
    const cleanup = () => {
      try { es.close(); } catch {}
      oneShotEventSources.delete(es);
    };
    const ensureBubble = () => {
      if (bubble) return bubble;
      const m = document.createElement("div");
      m.className = "pd-chat-msg pd-chat-master";
      m.innerHTML = `<div class="pd-chat-label">evy</div><div class="pd-chat-body"></div>`;
      logEl.appendChild(m);
      logEl.scrollTop = logEl.scrollHeight;
      bubble = m.querySelector(".pd-chat-body");
      return bubble;
    };
    es.addEventListener("message_start", () => {
      active = true;
      acc = "";
      bubble = null;
    });
    es.addEventListener("message_update", (e) => {
      if (!active) return;
      try {
        const d = JSON.parse(e.data);
        const ev = d.assistantMessageEvent;
        if (!ev) return;
        if (ev.type === "text_delta" && typeof ev.delta === "string") {
          acc += ev.delta;
          ensureBubble().textContent = acc;
          logEl.scrollTop = logEl.scrollHeight;
        } else if (ev.type === "toolcall_start") {
          const tc = ev.partial?.content?.[ev.contentIndex];
          if (tc?.id && tc?.name) {
            // v2.7.12: render as a neon pill in the same row as sibling
            // pills from this turn (wraps naturally). No more full-width
            // tool-card eating 60% of the panel.
            // 2026-05-19: consecutive same-name pills collapse into ×N.
            const row = ensureChatToolPillsRow(logEl);
            const pill = appendOrCollapseToolPill(row, { name: tc.name, args: tc.arguments });
            toolBubbles.set(tc.id, pill);
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
      } catch {}
    });
    es.addEventListener("tool_result", (e) => {
      // Attach result + ok/err marker to the pill spawned by toolcall_start.
      // When same-name pills have been collapsed into one, multiple tcids
      // resolve onto the same pill — strip any prior ok/err class first so
      // we don't end up with both glyphs rendering via ::after.
      if (!active) return;
      try {
        const d = JSON.parse(e.data);
        const pill = toolBubbles.get(d.toolCallId);
        if (!pill) return;
        const ok = !d.error;
        pill.classList.remove("chat-tool-pill--ok", "chat-tool-pill--err");
        pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
        const result = d.error || (d.content && d.content[0] && d.content[0].text) || d.content;
        if (result != null) {
          pill.dataset.result = (typeof result === "string") ? result : JSON.stringify(result);
        }
      } catch {}
    });
    es.addEventListener("agent_end", () => { cleanup(); });
    es.addEventListener("error", () => { setTimeout(cleanup, 1000); });
    // Safety timeout — if nothing happens within 90s, give up (in case the
    // user never receives an assistant turn for any reason).
    setTimeout(cleanup, 90000);
  }

  // ----- Master chat (SSE-backed conversation with the master daemon) -----
  function wireMasterChat() {
    const log = $("master-log");
    const form = $("master-input-form");
    const input = $("master-input");
    const sendBtn = $("master-send");
    const connState = $("master-conn-state");
    const newBtn = $("chat-new-btn");
    const ctxFill = $("ctx-fill");
    const ctxLabel = $("ctx-label");
    if (!log || !form || !input) return;

    // Rehydrate the chat log from the master daemon's persisted transcript
    // so a browser refresh doesn't wipe what we see. Fetch on mount, render
    // each historic message into the same bubble shape the SSE stream uses.
    async function rehydrateFromTranscript() {
      try {
        const r = await fetch("/api/master/transcript?limit=80");
        const j = await r.json();
        if (!j.ok || !Array.isArray(j.messages) || j.messages.length === 0) return;
        const empty = log.querySelector(".master-log-empty");
        if (empty) empty.remove();
        // 2026-05-19: with consecutive same-name pill collapse, multiple
        // tcids share a single pill element. A querySelector lookup by
        // data-tcid would only find the LAST tcid stored on the pill, so
        // we build a tcid → pill map as the assistant branch renders and
        // use it from the toolResult branch instead.
        const tcidToPill = new Map();
        for (const m of j.messages) {
          if (m.role === "user") {
            // Don't replay synthetic watchdog/team-report prompts — those
            // were the daemon talking to itself, not Jason.
            const text = (m.content || []).map((b) => b.text).filter(Boolean).join("");
            if (text.startsWith("[watchdog]") || text.startsWith("[team-report]")) {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-watchdog";
              block.innerHTML = `<div class="master-msg-label">watchdog</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            } else {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-user";
              block.innerHTML = `<div class="master-msg-label">you</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            }
          } else if (m.role === "assistant") {
            // Render text blocks; tool calls go into their own bubbles.
            const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
            if (text) {
              const block = document.createElement("div");
              block.className = "master-msg master-msg-assistant";
              block.innerHTML = `<div class="master-msg-label">evy</div><div class="master-msg-body"></div>`;
              block.querySelector(".master-msg-body").textContent = text;
              log.appendChild(block);
            }
            // v2.7.12: tool calls render as inline neon pills grouped per
            // assistant turn (one .chat-tool-pills row per turn). Multiple
            // tool calls in the same turn share the row. The toolResult
            // role (next branch) patches in the ✓/✗ marker.
            // 2026-05-19: consecutive same-name pills collapse into ×N.
            const toolCalls = (m.content || []).filter((b) => b.type === "toolCall");
            if (toolCalls.length > 0) {
              const row = document.createElement("div");
              row.className = "chat-tool-pills";
              log.appendChild(row);
              for (const tc of toolCalls) {
                const pill = appendOrCollapseToolPill(row, { name: tc.name || "tool", args: tc.arguments });
                if (tc.id) tcidToPill.set(String(tc.id), pill);
              }
            }
          } else if (m.role === "toolResult") {
            // Find the pill whose tcid matches via the rehydrate map.
            // Best-effort — old transcripts may have results without a
            // matching pill if the assistant turn was clipped.
            const tcid = m.toolCallId || (m.content && m.content[0] && m.content[0].toolCallId);
            if (tcid) {
              const pill = tcidToPill.get(String(tcid));
              if (pill) {
                const ok = !m.error;
                // Clear opposite class so multiple tcids landing on the
                // same collapsed pill don't render both ✓ and ✗.
                pill.classList.remove("chat-tool-pill--ok", "chat-tool-pill--err");
                pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
                const resultText = (m.content || []).map((b) => b.text).filter(Boolean).join("\n");
                if (resultText) pill.dataset.result = resultText;
              }
            }
          }
        }
        // Defer scroll-to-bottom past two RAFs so layout has fully
        // settled. setting scrollTop synchronously after innerHTML
        // sometimes runs before the browser computes scrollHeight,
        // which leaves the user at the top.
        const stickToBottom = () => { log.scrollTop = log.scrollHeight; };
        requestAnimationFrame(() => requestAnimationFrame(stickToBottom));
      } catch {
        // If the master is unreachable just leave the empty-state alone.
      }
    }
    rehydrateFromTranscript();

    // Also scroll-to-bottom whenever the Chat tab becomes visible — the
    // rehydrate runs once on mount, but if the user lands on Settings
    // first and switches over, the initial scroll has long since fired
    // before the panel had any height.
    const chatPanel = document.querySelector("section[data-tab=\"chat\"]");
    if (chatPanel) {
      chatPanelObserver = new MutationObserver(() => {
        if (getComputedStyle(chatPanel).display !== "none") {
          requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
        }
      });
      chatPanelObserver.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab"] });
      // Also handle the very first render where data-active-tab may set BEFORE this code runs
      if (getComputedStyle(chatPanel).display !== "none") {
        requestAnimationFrame(() => requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; }));
      }
    }

    // Context window meter — poll every 5s while the chat tab is visible.
    // v2.7.3: read both /context (for the meter pill) and /transcript/util
    // (for the four-state banner). The banner now reflects the SAME policy
    // the master daemon enforces just-in-time — so we never disagree about
    // when to fire.
    async function refreshContext() {
      try {
        const [ctxR, utilR] = await Promise.all([
          fetch("/api/master/context").then((r) => r.json()).catch(() => null),
          fetch("/api/master/transcript/util").then((r) => r.json()).catch(() => null),
        ]);
        if (ctxR && ctxR.ok && ctxFill && ctxLabel) {
          const pct = ctxR.utilization_pct;
          if (typeof pct === "number") {
            ctxFill.style.width = Math.min(100, pct) + "%";
            ctxFill.classList.toggle("warn", pct >= 60 && pct < 85);
            ctxFill.classList.toggle("crit", pct >= 85);
          }
          const total = ctxR.estimated_total_tokens;
          const cap = ctxR.loaded_context_length;
          ctxLabel.textContent = cap
            ? `ctx ${total.toLocaleString()} / ${cap.toLocaleString()} tok (${pct ?? "?"}%)`
            : `ctx ~${total.toLocaleString()} tok`;
        }
        // ── 4-state banner (v2.7.3) ────────────────────────────────────
        // OK              → banner hidden
        // YELLOW WARN     → between warn_tokens and compact_tokens
        // BLUE COMPACTING → compact event in flight (transient; cleared by SSE)
        // RED OVERFLOW    → past loaded_ctx (should be impossible if JIT
        //                   gate is healthy — kept as fail-safe)
        const banner = $("ctx-overflow-banner");
        if (!banner) return;
        // Don't fight an in-flight compacting state set by the SSE handler.
        if (banner.dataset.state === "compacting") return;
        if (!utilR || !utilR.ok) {
          banner.hidden = true;
          return;
        }
        const decision = utilR.decision || {};
        const action = decision.action;
        const current = utilR.current_tokens || 0;
        const compactAt = utilR.compact_at;
        const warnAt = utilR.warn_at;
        const cap = utilR.loaded_ctx;
        const pct = utilR.util_pct;

        // Real overflow — past loaded_ctx. Should be impossible with JIT
        // working, but if it ever happens we shout the loudest.
        if (cap && typeof pct === "number" && pct >= 100) {
          banner.hidden = false;
          banner.dataset.state = "overflow";
          banner.innerHTML =
            '<strong>Context overflow</strong> — current ~<span>' + current.toLocaleString() + '</span> tok ' +
            'vs loaded ctx <span>' + cap.toLocaleString() + '</span> tok (' + pct + '%). ' +
            'JIT compact gate should have prevented this. <strong>Compact now.</strong>' +
            '<div class="ctx-overflow-actions">' +
            '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
            '</div>';
          rewireBannerButton();
          return;
        }
        if (action === "compact") {
          // Master is about to fire compact (or did, between poll and read).
          banner.hidden = false;
          banner.dataset.state = "warn-compact";
          banner.innerHTML =
            '<strong>Auto-compact firing</strong> — current ~<span>' + current.toLocaleString() + '</span> tok ' +
            'crossed compact threshold <span>' + (compactAt || 0).toLocaleString() + '</span>. ' +
            'The supervisor will compact before the next prompt.';
          return;
        }
        if (action === "warn") {
          banner.hidden = false;
          banner.dataset.state = "warn";
          const compactText = compactAt
            ? compactAt.toLocaleString() + " tok"
            : (cap ? (cap + " tok loaded ctx") : "the compact threshold");
          banner.innerHTML =
            '<strong>Transcript approaching compact threshold</strong> — current ~<span>' + current.toLocaleString() + '</span> tok' +
            (warnAt ? ' (warn at <span>' + warnAt.toLocaleString() + '</span>, ' : ' (') +
            'auto-compact at <span>' + compactText + '</span>). ' +
            'Compact now to keep the supervisor responsive.' +
            '<div class="ctx-overflow-actions">' +
            '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
            '</div>';
          rewireBannerButton();
          return;
        }
        // action === "ok"
        banner.hidden = true;
        banner.dataset.state = "ok";
      } catch { /* silent */ }
    }
    // The compact button inside the banner is rewritten on each render
    // (innerHTML), so the original event binding made at boot is lost when
    // the banner repaints. Rebind it after every render.
    function rewireBannerButton() {
      const btn = $("ctx-overflow-compact");
      if (btn && !btn.dataset.boundCompact) {
        btn.addEventListener("click", () => runCompact("banner"));
        btn.dataset.boundCompact = "1";
      }
    }
    refreshContext();
    contextMeterPollTimer = setInterval(() => {
      const panel = document.querySelector("section[data-tab=\"chat\"]");
      if (panel && getComputedStyle(panel).display !== "none") refreshContext();
    }, 5000);

    // Full-screen toggle: persists via localStorage so the choice survives refresh.
    const fsBtn = $("chat-fullscreen-btn");
    const FS_KEY = "subctl.dashboard.chatFullscreen";
    function setFullscreen(on) {
      document.body.classList.toggle("chat-fullscreen", on);
      try { localStorage.setItem(FS_KEY, on ? "1" : "0"); } catch {}
    }
    if (fsBtn) {
      fsBtn.addEventListener("click", () => {
        setFullscreen(!document.body.classList.contains("chat-fullscreen"));
      });
      // Restore prior state
      try {
        if (localStorage.getItem(FS_KEY) === "1") setFullscreen(true);
      } catch {}
      // Esc exits full-screen
      chatFullscreenEscHandler = (e) => {
        if (e.key === "Escape" && document.body.classList.contains("chat-fullscreen")) {
          setFullscreen(false);
        }
      };
      document.addEventListener("keydown", chatFullscreenEscHandler);
    }

    // Compact transcript button: summarize older turns into a single
    // message so the supervisor's prompt window stays manageable.
    async function runCompact(_initiator) {
      try {
        const r = await fetch("/api/master/transcript/compact", { method: "POST" });
        const j = await r.json();
        if (!j.ok) {
          await window.notice.error("Compact failed", j.error || "unknown");
          return;
        }
        // Server returns ok:true with noop:true when there's nothing worth
        // compacting (transcript too short). Show as info, not error.
        if (j.noop) {
          await window.notice("Nothing to compact", j.message || "Transcript is short enough already.");
          return;
        }
        while (log.firstChild) log.removeChild(log.firstChild);
        await rehydrateFromTranscript();
        refreshContext();
        await window.notice("Compact complete", `Archived ${j.archived_count} messages, kept the last ${j.kept_msgs} turns.`);
      } catch (err) {
        await window.notice.error("Compact error", String(err));
      }
    }
    const compactBtn = $("chat-compact-btn");
    if (compactBtn) compactBtn.addEventListener("click", () => runCompact("toolbar"));
    const bannerCompact = $("ctx-overflow-compact");
    if (bannerCompact) bannerCompact.addEventListener("click", () => runCompact("banner"));

    // v2.8.10 — Voice on/off toggle in chat header. Source-of-truth is
    // master's voice.json (read via /api/voice/status, hot-reloaded via
    // SSE `voice_config`). Click flips `enabled` via POST /api/voice/config;
    // the per-bubble 🔊 play button keys off window.__subctlVoiceEnabled
    // so the audio button only appears when voice is on.
    const voiceBtn = $("chat-voice-toggle-btn");
    function renderVoiceBtnState(enabled) {
      if (!voiceBtn) return;
      if (enabled) {
        voiceBtn.textContent = "🔊 voice on";
        voiceBtn.classList.add("chat-toolbar-btn--active");
      } else {
        voiceBtn.textContent = "🔇 voice off";
        voiceBtn.classList.remove("chat-toolbar-btn--active");
      }
    }
    // Initial paint — refreshVoiceEnabled() sets the global a few lines
    // down; mirror onto the button as soon as the global lands.
    fetch("/api/voice/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.config) {
          window.__subctlVoiceEnabled = !!j.config.enabled;
          renderVoiceBtnState(!!j.config.enabled);
        }
      })
      .catch(() => {});
    if (voiceBtn) {
      voiceBtn.addEventListener("click", async () => {
        voiceBtn.disabled = true;
        const current = !!window.__subctlVoiceEnabled;
        const next = !current;
        try {
          const r = await fetch("/api/voice/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          const j = await r.json();
          if (!j.ok) {
            await window.notice.error("voice toggle failed", j.error || "unknown");
          } else {
            // Optimistic — the SSE voice_config event will also fire and
            // confirm. Update the button now so the click feels instant.
            window.__subctlVoiceEnabled = !!j.config?.enabled;
            renderVoiceBtnState(!!j.config?.enabled);
          }
        } catch (err) {
          await window.notice.error("voice toggle error", String(err));
        } finally {
          voiceBtn.disabled = false;
        }
      });
    }

    // v2.8.9 — Restart master button. POSTs /api/master/restart which does
    // launchctl kickstart -k. Master's SIGTERM handler saves the transcript
    // before exit, so no chat state is lost. Polls /api/master/health until
    // it returns ok so the operator sees feedback.
    const restartBtn = $("chat-restart-master-btn");
    if (restartBtn) {
      restartBtn.addEventListener("click", async () => {
        const orig = restartBtn.textContent;
        restartBtn.disabled = true;
        restartBtn.textContent = "restarting…";
        try {
          const r = await fetch("/api/master/restart", { method: "POST" });
          const j = await r.json();
          if (!j.ok) {
            restartBtn.textContent = "failed";
            await window.notice.error("Restart failed", j.error || "unknown");
            setTimeout(() => { restartBtn.disabled = false; restartBtn.textContent = orig; }, 2500);
            return;
          }
          // Poll /api/master/health until master is back. Max 30s.
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 500));
            try {
              const hr = await fetch("/api/master/health");
              const hj = await hr.json();
              if (hj.ok && hj.uptime_s !== undefined && hj.uptime_s < 30) {
                // Fresh boot detected (uptime < 30s means we hit the new instance).
                restartBtn.textContent = "back ✓";
                refreshContext();
                setTimeout(() => { restartBtn.disabled = false; restartBtn.textContent = orig; }, 1500);
                return;
              }
            } catch { /* master not back yet, keep polling */ }
          }
          restartBtn.textContent = "timed out";
          setTimeout(() => { restartBtn.disabled = false; restartBtn.textContent = orig; }, 2500);
        } catch (err) {
          restartBtn.textContent = "error";
          await window.notice.error("Restart error", String(err));
          setTimeout(() => { restartBtn.disabled = false; restartBtn.textContent = orig; }, 2500);
        }
      });
    }

    // New Chat button: archive the transcript and start fresh.
    if (newBtn) {
      newBtn.addEventListener("click", async () => {
        newBtn.disabled = true;
        newBtn.textContent = "clearing…";
        try {
          const r = await fetch("/api/master/transcript/clear", { method: "POST" });
          const j = await r.json();
          if (!j.ok) {
            await window.notice.error("Clear failed", j.error || "unknown");
          } else {
            // Wipe local UI
            while (log.firstChild) log.removeChild(log.firstChild);
            const empty = document.createElement("div");
            empty.className = "master-log-empty";
            empty.innerHTML = "fresh chat — prior transcript archived to <code>" + j.archive.split("/").slice(-1)[0] + "</code>";
            log.appendChild(empty);
            refreshContext();
          }
        } catch (err) {
          await window.notice.error("Clear error", String(err));
        } finally {
          newBtn.disabled = false;
          newBtn.textContent = "+ new chat";
        }
      });
    }

    // Track the in-flight assistant message so streaming text-deltas append
    // into one bubble instead of creating a new bubble per token.
    let activeAssistantEl = null;
    let activeAssistantText = "";
    let toolCallEls = new Map(); // toolCallId -> element

    function setConnState(state) {
      if (!connState) return;
      connState.textContent = state;
      connState.dataset.state = state;
    }

    function clearEmpty() {
      const empty = log.querySelector(".master-log-empty");
      if (empty) empty.remove();
    }

    function appendMessage(role, text, opts) {
      clearEmpty();
      const el = document.createElement("div");
      el.className = `master-msg master-msg-${role}`;
      const label = document.createElement("div");
      label.className = "master-msg-label";
      label.textContent = (opts && opts.label) || role;
      const body = document.createElement("div");
      body.className = "master-msg-body";
      body.textContent = text || "";
      el.appendChild(label);
      el.appendChild(body);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return body;
    }

    // v2.7.12: tool calls render as neon-glow pills grouped per assistant
    // turn (one .chat-tool-pills row reused for the whole turn). Pills
    // appear live as SSE toolcall_start events arrive, so the operator
    // SEES master fetching tool after tool. Click a pill → side notice
    // with full args + result.
    function appendToolCall(toolCallId, name, args) {
      clearEmpty();
      // ── v2.8.1 chat perf / skill router ──
      // PRE-FIX (v2.7.12 → v2.8.0): hideChatThinking() ran here, which
      // killed the indicator the moment Evy issued a tool call. If the
      // assistant message then took a few seconds to actually start
      // streaming (LM Studio JIT, tool latency, prompt re-load), the
      // operator stared at silence. POST-FIX: keep the indicator alive
      // through tool calls; flip its label to "working" so the visual
      // changes (operator knows something IS happening) but the dots
      // keep animating. Removed only when actual text streams in via
      // appendDelta() or the turn ends in endAssistantBubble().
      setChatThinkingState(log, "working");
      // Reuse the row the active assistant turn already started, or open a
      // fresh one if the turn hasn't emitted any tool pills yet.
      let row;
      const lastEl = log.lastElementChild;
      if (lastEl && lastEl.classList.contains("chat-tool-pills") && lastEl.dataset.turnOpen === "1") {
        row = lastEl;
      } else {
        row = document.createElement("div");
        row.className = "chat-tool-pills";
        row.dataset.turnOpen = "1";
        log.appendChild(row);
      }
      // 2026-05-19: consecutive same-name pills collapse into ×N. Multiple
      // tcids can resolve onto the same collapsed pill via toolCallEls.
      const pill = appendOrCollapseToolPill(row, { name, args });
      pill.dataset.tcid = toolCallId;
      log.scrollTop = log.scrollHeight;
      toolCallEls.set(toolCallId, pill);
    }

    function markToolDone(toolCallId, ok, summary) {
      const pill = toolCallEls.get(toolCallId);
      if (!pill) return;
      // Clear opposite class so multiple tcids landing on the same
      // collapsed pill don't render both ✓ and ✗ via ::after.
      pill.classList.remove("chat-tool-pill--ok", "chat-tool-pill--err");
      pill.classList.add(ok ? "chat-tool-pill--ok" : "chat-tool-pill--err");
      if (summary != null) {
        pill.dataset.result = (typeof summary === "string") ? summary : JSON.stringify(summary);
      }
      log.scrollTop = log.scrollHeight;
    }

    // Close any "open" tool-pill row so the NEXT assistant turn opens a
    // fresh row instead of piling pills into the previous turn's row.
    function closeToolPillRow() {
      const lastEl = log.lastElementChild;
      if (lastEl && lastEl.classList.contains("chat-tool-pills")) {
        delete lastEl.dataset.turnOpen;
      }
      // Also clear any stragglers — only the trailing row could still be
      // open, but be defensive.
      log.querySelectorAll('.chat-tool-pills[data-turn-open="1"]').forEach((n) => {
        delete n.dataset.turnOpen;
      });
    }

    function startAssistantBubble() {
      activeAssistantText = "";
      activeAssistantEl = appendMessage("assistant", "", { label: "evy" });
    }

    // Some local models (notably gemma-4-26b-a4b-it MLX 4-bit) leak malformed
    // reasoning-channel markers — <|channel>thought\n<channel|> — into the
    // assistant text. Strip on every render so the live stream stays clean;
    // master also strips on persistence so re-renders from transcript match.
    const CHANNEL_MARKER_RE = /<\|?channel\|?>[\s\S]*?<\|?channel\|?>/g;
    function appendDelta(delta) {
      // First delta of a turn = master has started speaking. Drop the
      // thinking indicator so it doesn't sit between text and pills.
      hideChatThinking(log);
      if (!activeAssistantEl) startAssistantBubble();
      activeAssistantText += delta;
      activeAssistantEl.textContent = activeAssistantText.replace(CHANNEL_MARKER_RE, "");
      log.scrollTop = log.scrollHeight;
    }

    function endAssistantBubble() {
      // v2.8.0 — attach a 🔊 button to the just-finished Evy bubble so
      // the operator can click to render+play the text. The button is
      // only added if voice is enabled (cached probe lives on window).
      // The audio renders lazily on first click; subsequent clicks
      // replay the cached audio.
      if (activeAssistantEl && activeAssistantText && window.__subctlVoiceEnabled) {
        attachVoicePlayButton(activeAssistantEl, activeAssistantText);
      }
      activeAssistantEl = null;
      activeAssistantText = "";
      // Seal the tool-pill row so the next assistant turn opens a new one
      // (otherwise consecutive turns' pills would pile into the same row).
      closeToolPillRow();
      // Belt-and-suspenders: thinking indicator should already be hidden by
      // appendDelta / appendToolCall, but if the turn was empty (zero
      // deltas + zero tool calls) clean it up here.
      hideChatThinking(log);
    }

    // v2.8.0 — voice play button injected onto Evy's bubble body.
    // Click → POST /api/voice/render with the text; on success swap a
    // <audio controls autoplay> into the bubble's footer. Errors stay
    // visible inline.
    function attachVoicePlayButton(bubbleBody, text) {
      const footer = document.createElement("div");
      footer.className = "voice-footer";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "voice-play-btn";
      btn.title = "render and play (Evy voice)";
      btn.setAttribute("aria-label", "Play this turn as voice");
      // Lucide volume-2 icon shape — keeps with v2.7.26 icon adoption.
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
        '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>' +
        '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>' +
        "</svg>";
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.classList.add("voice-play-btn--loading");
        try {
          const r = await fetch("/api/voice/render", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const j = await r.json();
          if (!j.ok) {
            footer.appendChild(renderVoiceError(j.error || "render failed"));
            return;
          }
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.autoplay = true;
          audio.preload = "auto";
          audio.src = j.audio_url.startsWith("/voice/")
            ? "/api" + j.audio_url
            : j.audio_url;
          audio.className = "voice-audio";
          btn.remove();
          footer.appendChild(audio);
        } catch (err) {
          footer.appendChild(renderVoiceError(String(err)));
        } finally {
          btn.classList.remove("voice-play-btn--loading");
        }
      });
      footer.appendChild(btn);
      bubbleBody.appendChild(footer);
    }
    function renderVoiceError(msg) {
      const e = document.createElement("span");
      e.className = "voice-err";
      e.textContent = "voice: " + msg;
      return e;
    }
    // Probe master's voice config once on connect; mirror it on window so
    // endAssistantBubble can decide whether to attach the button. Updates
    // live via the `voice_config` SSE event (master broadcasts on
    // voice.json change).
    function refreshVoiceEnabled() {
      fetch("/api/voice/status", { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((j) => {
          if (j && j.config) window.__subctlVoiceEnabled = !!j.config.enabled;
        })
        .catch(() => { /* leave whatever value was last set */ });
    }
    refreshVoiceEnabled();

    let backoffMs = 1000;

    function connect() {
      // Don't show "connecting" on first paint either — rely on the
      // EventSource open event to flip to connected. Initial state is
      // "connecting" already from the HTML default.
      if (!masterEventSource) setConnState("connecting");
      masterEventSource = new EventSource("/api/master/events");
      const es = masterEventSource;
      es.addEventListener("open", () => {
        // Cancel any pending "reconnecting" display — we made it back.
        if (reconnectingDebounce) {
          clearTimeout(reconnectingDebounce);
          reconnectingDebounce = null;
        }
        setConnState("connected");
        backoffMs = 1000;
      });
      es.addEventListener("error", () => {
        try { es.close(); } catch {}
        // Debounce: only show "reconnecting" if we're still trying after
        // 1.5s. Most real reconnects complete in <1s and shouldn't flash
        // the UI.
        if (reconnectingDebounce) clearTimeout(reconnectingDebounce);
        reconnectingDebounce = setTimeout(() => {
          setConnState("reconnecting");
          reconnectingDebounce = null;
        }, 1500);
        if (connectBackoffTimer) clearTimeout(connectBackoffTimer);
        connectBackoffTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      });
      es.addEventListener("connected", () => setConnState("connected"));
      // v2.7.3: compact_warning carries the just-in-time decision. When
      // stage="compacting" we paint the transient BLUE banner immediately
      // (before the operator's poll comes around). transcript_compacted
      // clears it. The repaint is best-effort: refreshContext re-renders
      // the banner from /transcript/util anyway.
      es.addEventListener("compact_warning", (e) => {
        try {
          const d = JSON.parse(e.data);
          const banner = $("ctx-overflow-banner");
          if (!banner) return;
          if (d.stage === "compacting") {
            banner.hidden = false;
            banner.dataset.state = "compacting";
            banner.innerHTML =
              '<strong>Compacting transcript…</strong> just-in-time gate fired ' +
              '(current ~<span>' + (d.current_tokens || 0).toLocaleString() + '</span> tok ≥ ' +
              '<span>' + (d.compact_at || 0).toLocaleString() + '</span>). ' +
              'Banner will clear when compact finishes.';
          } else if (d.stage === "warn") {
            banner.hidden = false;
            banner.dataset.state = "warn";
            banner.innerHTML =
              '<strong>Transcript approaching compact threshold</strong> — current ~<span>' +
              (d.current_tokens || 0).toLocaleString() + '</span> tok ≥ warn ' +
              '<span>' + (d.warn_at || 0).toLocaleString() + '</span> ' +
              '(auto-compact at <span>' + (d.compact_at || 0).toLocaleString() + '</span>). ' +
              'Compact now to keep the supervisor responsive.' +
              '<div class="ctx-overflow-actions">' +
              '  <button type="button" class="ctx-overflow-fix-1" id="ctx-overflow-compact">compact transcript now</button>' +
              '</div>';
            rewireBannerButton();
          }
        } catch {}
      });
      es.addEventListener("transcript_compacted", () => {
        const banner = $("ctx-overflow-banner");
        if (banner) {
          banner.hidden = true;
          banner.dataset.state = "ok";
        }
        // The compact mutates the transcript; pull a fresh meter reading.
        try { refreshContext(); } catch {}
      });
      es.addEventListener("inbound", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.source === "watchdog") {
            appendMessage("watchdog", d.text, { label: "watchdog" });
          } else if (d.source === "telegram") {
            // Telegram-sourced messages get a distinct badge so the operator
            // can tell at a glance that a reply belongs to a Telegram thread
            // rather than the dashboard's own input. Bubble also gets the
            // .from-telegram class for accent-border styling.
            const body = appendMessage("user", d.text, { label: "✈ you · telegram" });
            const bubble = body?.parentElement;
            if (bubble) bubble.classList.add("from-telegram");
          }
          // chat-source inbounds are echoed by our own POST below; skip duplicate
        } catch {}
      });
      // NOTE: do NOT eagerly create a bubble on message_start. The agent
      // sometimes emits a message-shell event before any text_delta arrives,
      // and if the assistant turn ends up being purely a tool call (no text),
      // we'd have orphan empty bubbles. Instead let appendDelta below
      // lazy-create the bubble on the FIRST text_delta. Side-effect: also
      // stops the "empty bubble + filled bubble" doubling that showed up
      // when a turn included both a tool-call message and a text message.
      es.addEventListener("message_update", (e) => {
        try {
          const d = JSON.parse(e.data);
          const ev = d.assistantMessageEvent;
          if (!ev) return;
          if (ev.type === "text_delta" && typeof ev.delta === "string") {
            appendDelta(ev.delta);
          } else if (ev.type === "toolcall_start") {
            appendToolCall(ev.partial?.content?.[ev.contentIndex]?.id ?? "?", ev.partial?.content?.[ev.contentIndex]?.name ?? "tool", ev.partial?.content?.[ev.contentIndex]?.arguments);
          }
        } catch {}
      });
      es.addEventListener("message_end", () => {
        endAssistantBubble();
      });
      es.addEventListener("tool_result", (e) => {
        try {
          const d = JSON.parse(e.data);
          markToolDone(d.toolCallId ?? "?", !d.error, d.error || (d.content && d.content[0] && d.content[0].text));
          // ── v2.8.1 chat perf / skill router ──
          // After a tool result lands but BEFORE Evy continues
          // reasoning, the indicator should pulse "thinking" again
          // (not "working") — there's no active tool, we're waiting on
          // the next LLM step. Reverts when appendToolCall runs again
          // or hides when appendDelta paints text.
          setChatThinkingState(log, "thinking");
        } catch {}
      });
      // ── v2.8.1 chat perf / skill router ──
      // Skill router decision pill. Master broadcasts `skill_router`
      // once per turn (right after composeSystemPrompt) with the list
      // of skills it loaded into Evy's prompt. Render as a tiny
      // "[router] x · y" row under the operator's last message — the
      // operator can see in real-time which skills got preloaded for
      // this turn.
      es.addEventListener("skill_router", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (!Array.isArray(d.selected) || d.selected.length === 0) return;
          const pill = document.createElement("div");
          pill.className = "chat-router-pill";
          pill.title = d.reason || "skill router";
          pill.textContent = "[router] " + d.selected.join(" · ");
          // Drop the pill just above the thinking indicator if there
          // is one, otherwise at the tail.
          const thinking = log.querySelector(".chat-thinking");
          if (thinking) {
            log.insertBefore(pill, thinking);
          } else {
            log.appendChild(pill);
          }
          log.scrollTop = log.scrollHeight;
        } catch {}
      });
      // ── v2.8.1 chat perf / skill router ──
      // Latency stages — silent by default; the master logs the full
      // breakdown to stderr. We surface only the "last_token" event
      // as a debug-friendly data attribute on the most recent assistant
      // bubble so curious operators can inspect total turn time via
      // devtools without us painting numbers onto the chat.
      es.addEventListener("latency_stage", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.stage !== "last_token" && d.stage !== "turn_complete") return;
          const bubbles = log.querySelectorAll(".master-msg-assistant");
          const last = bubbles[bubbles.length - 1];
          if (!last) return;
          last.dataset[`latency_${d.stage}_ms`] = String(d.elapsed_ms);
        } catch {}
      });
      es.addEventListener("watchdog_fire", (e) => {
        try {
          const d = JSON.parse(e.data);
          appendMessage("watchdog", d.prompt, { label: "watchdog" });
          if (window.__subctlPushNotification) {
            window.__subctlPushNotification("watchdog", String(d.prompt || "").slice(0, 140));
          }
        } catch {}
      });
      // Curated notifications. Three SSE event types map to sidecar:
      //   "notify"      — master called notify_dashboard explicitly
      //   "team_event"  — auto-derive on blocked/done/error (skip progress/note noise)
      //   "watchdog_fire" — already handled above
      es.addEventListener("notify", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (window.__subctlPushNotification) {
            window.__subctlPushNotification(d.kind || "info", d.summary || "", d.team);
          }
        } catch {}
      });
      // v2.8.0 — master broadcasts on voice.json change so the 🔊 button
      // toggles live without a refresh.
      es.addEventListener("voice_config", (e) => {
        try {
          const d = JSON.parse(e.data);
          window.__subctlVoiceEnabled = !!d.enabled;
          // v2.8.10 — keep header toggle in sync with file changes
          // (master's fs.watch on voice.json or another tab flipping it).
          renderVoiceBtnState(!!d.enabled);
        } catch {}
      });
      es.addEventListener("team_event", (e) => {
        try {
          const d = JSON.parse(e.data);
          if (!window.__subctlPushNotification) return;
          // Only auto-publish meaningful state changes — skip progress
          // tick noise (master can choose to notify_dashboard("…", "milestone")
          // for those if it wants to surface them).
          const significant = ["blocked", "done", "error"];
          if (!significant.includes(d.type)) return;
          window.__subctlPushNotification(d.type, String(d.text || "").slice(0, 140), d.team);
        } catch {}
      });
    }
    connect();

    // Slash commands: a thin client-side layer on top of natural-language
    // chat. Most commands translate to a directive prompt for the master
    // (so the agent stays in the loop and tool-calls flow normally). A few
    // are pure client-side (/clear, /help, /attach) — those don't round-trip.
    // Host label captured at SLASH_HELP-build time mirrors today's app.js
    // semantics (HOST_LABEL was closed-over at wirer-call time before this
    // wave; /api/host has typically resolved by then, but if it hasn't,
    // we get the "this Mac" default — exact same behavior).
    const HOST_LABEL = currentHostLabel();
    const SLASH_HELP = [
      "/help                          — this help",
      "/clear                         — clear the chat log (client-side only)",
      "/status                        — quick health check (uptime, transcript, subscribers)",
      "/diag                          — full diagnostic: LM Studio, Telegram, coderabbit, gh, tmux",
      "/teams                         — list dev teams Evy is tracking",
      "/spawn <account> <project> [prompt]",
      "                                 ask Evy to spawn a dev team",
      "/kill <team>                   — ask Evy to kill a dev team session",
      `/attach <team>                 — show the SSH command to attach to a team's tmux on ${HOST_LABEL}`,
      "/config                        — show config file paths and what each controls",
      "",
      "How dev teams work:",
      `  • Evy spawns tmux sessions on ${HOST_LABEL} via subctl_orch_spawn`,
      "  • The lead Claude Code in pane 0 uses TeamCreate + Agent(team_name=\"…\") to make workers",
      "  • Each lead writes status to ~/.config/subctl/evy/inbox/<team>.jsonl",
      "  • Evy tails inboxes (2s poll), reacts to blocked/error events, watchdog at 30min",
      `  • Attach manually with: ssh ${SSH_HOST_ALIAS} tmux attach -t <team>`,
      "",
      `Config (all on ${HOST_LABEL}):`,
      "  ~/.config/subctl/evy/policy.json     operator + projects + autonomy + intervals",
      "  ~/.config/subctl/evy/providers.json  model routing (router/supervisor/reviewer/embeddings/escalate/fallback)",
      "  ~/.config/subctl/evy-notify.json     Telegram bot token + chat_id",
    ].join("\n");

    function appendSystemBlock(text) {
      clearEmpty();
      const el = document.createElement("div");
      el.className = "master-msg master-msg-system";
      const label = document.createElement("div");
      label.className = "master-msg-label";
      label.textContent = "system";
      const body = document.createElement("div");
      body.className = "master-msg-body";
      body.textContent = text;
      body.style.fontFamily = "ui-monospace, 'SF Mono', Menlo, monospace";
      body.style.fontSize = "11.5px";
      el.appendChild(label);
      el.appendChild(body);
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    async function fetchAndRenderJSON(url, label, formatter) {
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (!r.ok || j.ok === false) {
          appendMessage("error", `${label} failed: ${j.error || r.status}`, { label: "error" });
          return;
        }
        appendSystemBlock(formatter(j));
      } catch (err) {
        appendMessage("error", `${label} error: ${err}`, { label: "error" });
      }
    }

    function fmtSecsAgo(s) {
      if (s == null) return "never";
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m ago";
    }

    async function handleSlashCommand(line) {
      const parts = line.match(/^\/(\w+)(?:\s+(.*))?$/);
      if (!parts) {
        appendMessage("error", "malformed slash command — try /help", { label: "error" });
        return;
      }
      const cmd = parts[1].toLowerCase();
      const args = (parts[2] || "").trim();

      switch (cmd) {
        case "help":
          appendSystemBlock(SLASH_HELP);
          return;

        case "clear": {
          // Pure client-side — server transcript is preserved.
          while (log.firstChild) log.removeChild(log.firstChild);
          const empty = document.createElement("div");
          empty.className = "master-log-empty";
          empty.innerHTML = "cleared (client-side; Evy's transcript still intact) — try <code>/help</code>";
          log.appendChild(empty);
          return;
        }

        case "status":
          await fetchAndRenderJSON("/api/master/health", "status", (j) =>
            `Evy ${j.ok ? "OK" : "DEGRADED"}  v${j.version}\n` +
            `  uptime          ${j.uptime_s}s\n` +
            `  transcript      ${j.transcript_msgs} messages\n` +
            `  SSE subscribers ${j.subscribers}\n` +
            `  teams tracked   ${j.teams_tracked}\n` +
            `  prompt in flight ${j.prompt_in_flight ? "yes" : "no"}`,
          );
          return;

        case "diag":
          appendSystemBlock("running diagnostics (LM Studio + Telegram + coderabbit + gh + tmux)…");
          await fetchAndRenderJSON("/api/master/diag", "diag", (j) => {
            const header =
              `Evy ${j.ok ? "ALL CHECKS PASSED" : "DEGRADED"} · v${j.version || "?"}\n` +
              `  supervisor      ${j.supervisor}\n` +
              `  uptime          ${j.uptime_s}s\n` +
              `  tools loaded    ${j.tools_loaded}\n` +
              `  transcript      ${j.transcript_msgs} msgs\n` +
              `  subscribers     ${j.subscribers}\n` +
              `  teams tracked   ${j.teams_tracked}\n\n` +
              `checks:`;
            const rows = (j.checks || []).map((c) => {
              const mark = c.ok ? "✓" : "✗";
              return `  ${mark}  ${c.name.padEnd(12)} ${c.detail}`;
            });
            return [header, ...rows].join("\n");
          });
          return;

        case "teams":
          await fetchAndRenderJSON("/api/master/teams", "teams", (j) => {
            if (!j.teams || j.teams.length === 0) return "no dev teams tracked yet";
            const rows = j.teams.map((t) => {
              const ev = t.last_event ? `${t.last_event.type}: ${(t.last_event.text || "").slice(0, 60)}` : "—";
              return `  ${t.name.padEnd(28)} ${fmtSecsAgo(t.last_activity_seconds_ago).padEnd(10)} ${ev}`;
            });
            return `${j.teams.length} team(s) tracked:\n` + rows.join("\n");
          });
          return;

        case "attach": {
          if (!args) {
            appendMessage("error", "usage: /attach <team>", { label: "error" });
            return;
          }
          appendSystemBlock(
            `Attach to dev team "${args}" on ${HOST_LABEL}:\n\n` +
            `  ssh ${SSH_HOST_ALIAS} -t tmux attach -t ${args}\n\n` +
            `Detach with Ctrl-b then d. Evy and the team keep running after detach.`,
          );
          return;
        }

        case "config":
          appendSystemBlock([
            `config files (all on ${HOST_LABEL} at ~/.config/subctl/evy/):`,
            "",
            "  policy.json",
            "    operator info, project portfolio, autonomy levels (drive/ask/shadow),",
            "    review_interval_minutes, stall_detection_minutes, max_concurrent_workers,",
            "    escalation_triggers. Evy reads at boot.",
            "",
            "  providers.json",
            "    model routing per role: router (cheap dispatch), supervisor (the brain),",
            "    reviewer (PR review), embeddings, escalate (cloud), fallback. switch via",
            "    .models.<role>.{provider, model, host} fields.",
            "",
            "  evy-notify.json (one level up at ~/.config/subctl/evy-notify.json)",
            "    bot_token + chat_id for Evy's Telegram bot.",
            "",
            "  inbox/ (auto-created)",
            "    one .jsonl per dev team. Evy tails for status events.",
            "",
            `edit the file directly on ${HOST_LABEL}, then restart with:`,
            "  launchctl unload  ~/Library/LaunchAgents/com.subctl.evy.plist",
            "  launchctl load    ~/Library/LaunchAgents/com.subctl.evy.plist",
          ].join("\n"));
          return;

        case "spawn": {
          if (!args) {
            appendMessage("error", "usage: /spawn <account> <project_path> [prompt]", { label: "error" });
            return;
          }
          // Translate to natural-language directive for the master agent.
          const m = args.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
          if (!m) {
            appendMessage("error", "usage: /spawn <account> <project_path> [prompt]", { label: "error" });
            return;
          }
          const [, account, project, prompt] = m;
          const directive = `Spawn a dev team using subctl_orch_spawn with account="${account}", project="${project}"${prompt ? `, and an initial prompt: ${prompt}` : ""}. Confirm the team name once spawned, and tell me how to attach.`;
          await sendChat(directive);
          return;
        }

        case "kill": {
          if (!args) {
            appendMessage("error", "usage: /kill <team>", { label: "error" });
            return;
          }
          const directive = `Kill the dev-team tmux session named "${args}" using subctl_orch_kill, and confirm.`;
          await sendChat(directive);
          return;
        }

        default:
          appendMessage("error", `unknown command: /${cmd} — try /help`, { label: "error" });
      }
    }

    // ── Attachments (Phase 3l) ────────────────────────────────────────────
    // Tracks the attachment ids currently queued for the NEXT outgoing
    // message. Cleared after send. Each entry has the id + minimal metadata
    // for rendering the pill.
    const pendingAttachments = []; // {id, filename, size}
    const attachBar = $("master-attachments");
    const attachBtn = $("master-attach-btn");
    const attachFile = $("master-attach-file");
    // Threshold for auto-paste-as-attachment. Spec §3l default: 4 KB.
    const PASTE_ATTACH_THRESHOLD = 4 * 1024;

    function fmtBytes(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function renderAttachmentBar() {
      if (!attachBar) return;
      if (pendingAttachments.length === 0) {
        attachBar.hidden = true;
        attachBar.innerHTML = "";
        return;
      }
      attachBar.hidden = false;
      attachBar.innerHTML = pendingAttachments.map((a, i) =>
        `<span class="att-pill" data-i="${i}">
          <span class="att-name">${escForHtml(a.filename)}</span>
          <span class="att-size">${fmtBytes(a.size)}</span>
          <button type="button" class="att-x" data-i="${i}" aria-label="remove">×</button>
        </span>`
      ).join("");
      for (const btn of attachBar.querySelectorAll(".att-x")) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const i = parseInt(btn.getAttribute("data-i"), 10);
          if (Number.isInteger(i)) {
            pendingAttachments.splice(i, 1);
            renderAttachmentBar();
          }
        });
      }
    }

    function escForHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) =>
        c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" :
        c === '"' ? "&quot;" : "&#39;"
      );
    }

    async function uploadAttachment(blob, filename, source) {
      try {
        const r = await fetch("/api/master/attachments", {
          method: "POST",
          headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(filename),
            "X-Mime": blob.type || "",
            "X-Source": source,
          },
          body: blob,
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
          const msg = (j && (j.error || j.hint)) || `HTTP ${r.status}`;
          if (window.notice && window.notice.error) window.notice.error("Attach failed", msg);
          else appendMessage("error", "attach failed: " + msg, { label: "error" });
          return null;
        }
        pendingAttachments.push({
          id: j.attachment.id,
          filename: j.attachment.filename,
          size: j.attachment.size,
        });
        renderAttachmentBar();
        return j.attachment;
      } catch (err) {
        appendMessage("error", "attach error: " + err, { label: "error" });
        return null;
      }
    }

    // Paperclip → file picker
    if (attachBtn && attachFile) {
      attachBtn.addEventListener("click", () => attachFile.click());
      attachFile.addEventListener("change", async () => {
        const files = Array.from(attachFile.files || []);
        for (const f of files) {
          await uploadAttachment(f, f.name, "upload");
        }
        attachFile.value = "";
      });
    }

    // Drag-and-drop onto the input or anywhere in master-chat panel.
    const dropZone = form && form.closest("section");
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (e) => {
        if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", async (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer?.files || []);
        for (const f of files) {
          await uploadAttachment(f, f.name, "upload");
        }
      });
    }

    // Paste interception — if the pasted text exceeds the threshold, take
    // over the paste event, upload the text as an attachment, and clear
    // the input. Small pastes pass through normally.
    input.addEventListener("paste", async (e) => {
      const clip = e.clipboardData;
      if (!clip) return;
      const pasted = clip.getData("text") || "";
      if (pasted.length < PASTE_ATTACH_THRESHOLD) return; // normal paste
      e.preventDefault();
      // Synthesize a filename from the timestamp + first non-whitespace line.
      const firstLine = pasted.split("\n").find((l) => l.trim()) || "pasted";
      const slug = firstLine
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)
        .replace(/^-|-$/g, "") || "pasted";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `pasted-${stamp}-${slug}.md`;
      const blob = new Blob([pasted], { type: "text/markdown" });
      await uploadAttachment(blob, filename, "paste");
    });

    async function sendChat(text) {
      sendBtn.disabled = true;
      // Build the visible message — include attachment names if any.
      const attachmentIds = pendingAttachments.map((a) => a.id);
      const attachLabels = pendingAttachments.map((a) => `📎 ${a.filename}`).join("  ");
      const visible = attachLabels
        ? (text ? `${attachLabels}\n${text}` : attachLabels)
        : text;
      appendMessage("user", visible, { label: "you" });
      // v2.7.12: paint the live "Evy · thinking" indicator while we wait
      // for the master to start streaming. Removed by appendDelta /
      // appendToolCall on the first SSE event, or below on error/timeout.
      showChatThinking(log);
      // Safety: if no SSE event arrives in 30s, drop the indicator so the
      // operator isn't stuck staring at a forever-pulsing dot.
      const thinkingTimeout = setTimeout(() => hideChatThinking(log), 30000);
      // Clear pending attachments NOW (so the next message starts fresh).
      pendingAttachments.length = 0;
      renderAttachmentBar();
      try {
        const r = await fetch("/api/master/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            source: "chat",
            attachments: attachmentIds,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          clearTimeout(thinkingTimeout);
          hideChatThinking(log);
          appendMessage("error", "send failed: " + (j.error || r.status), { label: "error" });
        }
      } catch (err) {
        clearTimeout(thinkingTimeout);
        hideChatThinking(log);
        appendMessage("error", "send error: " + err, { label: "error" });
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      // Allow send with empty text if attachments exist.
      if (!text && pendingAttachments.length === 0) return;
      input.value = "";
      if (text.startsWith("/")) {
        await handleSlashCommand(text);
        input.focus();
      } else {
        await sendChat(text);
      }
    });
  }

  // ── Boot wirers — mirror app.js boot order (452, 453, 454). Master
  //    chat first so the SSE connection is in flight before the
  //    profile pill opens its own quiet observer. ──
  wireMasterChat();
  wireChatModelSelector();
  wireProfilePill();

  // ── Publish the bridge global for tabs/projects.js (wave 9) consumer.
  //    Verbatim from app.js:796 (the only window-published symbol from
  //    this zone before extraction). Other window-attached state used
  //    by chat (`window.__subctlVoiceEnabled`) is owned internally by
  //    this module — kept on window for namespace stability, but no
  //    external readers. ──
  window.__subctlAttachOneShotAssistantCapture = attachOneShotAssistantCapture;
}

export function unmount() {
  // Close every SSE stream this module ever opened.
  if (masterEventSource) { try { masterEventSource.close(); } catch {} masterEventSource = null; }
  if (profilePillEventSource) { try { profilePillEventSource.close(); } catch {} profilePillEventSource = null; }
  for (const es of oneShotEventSources) { try { es.close(); } catch {} }
  oneShotEventSources.clear();

  // Clear all the timer handles we lifted to module scope.
  if (chatModelSelectorPollTimer) { clearInterval(chatModelSelectorPollTimer); chatModelSelectorPollTimer = null; }
  if (profilePillPollTimer) { clearInterval(profilePillPollTimer); profilePillPollTimer = null; }
  if (contextMeterPollTimer) { clearInterval(contextMeterPollTimer); contextMeterPollTimer = null; }
  if (reconnectingDebounce) { clearTimeout(reconnectingDebounce); reconnectingDebounce = null; }
  if (connectBackoffTimer) { clearTimeout(connectBackoffTimer); connectBackoffTimer = null; }

  // Disconnect the long-lived observer + document keydown listener.
  if (chatPanelObserver) { try { chatPanelObserver.disconnect(); } catch {} chatPanelObserver = null; }
  if (chatFullscreenEscHandler) {
    try { document.removeEventListener("keydown", chatFullscreenEscHandler); } catch {}
    chatFullscreenEscHandler = null;
  }

  // Null the bridge. tabs/projects.js consumers null-check before invoking.
  window.__subctlAttachOneShotAssistantCapture = null;
}
