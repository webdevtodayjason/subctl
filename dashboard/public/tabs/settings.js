// dashboard/public/tabs/settings.js
//
// v2.8.6 — Settings tab (install-checks health, API keys panel,
// secrets.json editor + modal, OAuth account status, Telegram
// configure/test, config-file viewer, Obsidian vault-config form,
// personality preset tile). Wave 10 of dashboard/public/app.js
// decomposition. Extracted verbatim from `wireSettingsTab` @
// app.js:797–1324 (the section header + function body, 528 LOC) and
// its boot call at app.js:461.
//
// **Biggest single-function collapse in the migration so far.** ~15
// inline sub-helpers (`loadHealth`, `loadKeys`, `loadSecrets`,
// `openSecretsModal`, `closeSecretsModal`, `submitSecretsModal`,
// `wireSecretsModal`, `loadOAuth`, `loadTelegramStatus`,
// `wireTelegramForm`, `wireConfigViewer`, `loadVault`,
// `wireVaultForm`, `loadPersonality`, `refreshAll`) plus a top-of-body
// `personalityApply` listener block all collapse into one `mount()`
// body as local declarations. No top-down orchestration change — the
// extraction is mechanical, behavior is verbatim.
//
// **Consumes** (read-only references to globals published elsewhere):
//   - `window.notice` / `window.notice.error` — toast/notice publisher
//     that still lives in app.js (`window.notice = (title, body, opts)
//     => _showNotice(...)` @ app.js:2449). Used by the personality-
//     apply flow to surface success/error to the operator. Preserved
//     **verbatim** including the `if (window.notice && window.notice
//     .error)` typeof guard and the `alert(...)` fallback — guards
//     handle the case where the publisher hasn't run yet (notice
//     module is loaded later in app.js's boot). When app.js's notice
//     system extracts into its own module (post-decomp), this becomes
//     a regular import; until then it stays as a `window.*` consumer
//     same as wave-9 Projects consuming `window.openVaultDeepLink`.
//
// **NOTE — Settings vault-config form vs. Vault tab (wave 6):**
// `loadVault` + `wireVaultForm` in this module read/write
// `/api/settings/obsidian` and target `#settings-vault-status`,
// `#settings-vault-root`, `#settings-vault-save`, `#settings-vault-
// result`. That's the operator-facing vault-root *configuration*
// surface. The **Vault tab** in `tabs/vault.js` (wave 6) reads
// `/api/vault/roots` and renders the multi-root file browser. Same
// domain noun, different concerns — don't conflate them. The two
// modules don't share DOM or endpoints.
//
// HTTP endpoints (server-side handlers untouched this wave):
//   GET  /api/settings/install-checks
//   GET  /api/settings/keys
//   GET  /api/settings/secrets
//   POST /api/settings/secrets/<key>
//   GET  /api/settings/oauth
//   POST /api/settings/telegram
//   POST /api/settings/telegram/test
//   GET  /api/settings/config/<name>
//   GET  /api/settings/obsidian
//   POST /api/settings/obsidian
//   GET  /api/master/personality
//   POST /api/master/personality
//
// DOM contract (lives in index.html, unchanged):
//   Top bar:     #settings-refresh-btn
//   Health:      #settings-health-body, #settings-health-summary
//   API keys:    #settings-keys-body
//   Secrets:     #settings-secrets-body, #secrets-modal,
//                #secrets-modal-value, #secrets-modal-key-label,
//                #secrets-modal-result, #secrets-modal-save,
//                #secrets-modal-cancel, #secrets-modal-remove
//   OAuth:       #settings-oauth-body
//   Telegram:    #settings-tg-status, #settings-tg-save,
//                #settings-tg-test, #settings-tg-result,
//                #settings-tg-token, #settings-tg-chatid
//   Config:      #settings-config-view,
//                #settings-config-tabs .config-tab
//   Vault cfg:   #settings-vault-status, #settings-vault-root,
//                #settings-vault-save, #settings-vault-result
//   Personality: #personality-select, #settings-personality-active,
//                #personality-preview, #personality-apply
//
// Lifecycle:
//   - No `setInterval`. Refresh is operator-driven (the top-of-panel
//     `#settings-refresh-btn` click handler calls `refreshAll()`,
//     which fans out to the seven `load*` helpers).
//   - Multiple short-lived `setTimeout`s for "copied!" feedback
//     (1500ms restores on the install-cmd + oauth-cmd <code>
//     elements). One-shot and self-collecting.
//   - No `document` or `window` event listeners.
//   - All other listeners (modal save/cancel/remove, telegram
//     save/test, vault save, personality-apply, config-tab clicks,
//     per-secret-row edit buttons, install-cmd / oauth-cmd copy
//     handlers) are element-scoped and die with the panel DOM.
//   - `unmount()` is a **no-op**. Interface parity with waves 1–9; no
//     timers to clear, no document/window listeners to remove, no
//     window-prefixed globals owned by this module. The notification
//     system bridge is a CONSUMER, not OWNER — we don't null it.
//
// HOST_LABEL / SSH_HOST_ALIAS handling: app.js has a module-scope
// `let HOST_LABEL = "this Mac"` (line 14) that `/api/host` patches
// async, and `const SSH_HOST_ALIAS = "argent-m3-ultra-dev"` (line
// 22). Settings consumes HOST_LABEL twice (oauth-row install-cmd
// tooltip @ app.js:1060 and the vault-form success message @
// app.js:1230) and SSH_HOST_ALIAS once (in the oauth-row tooltip).
// Same call as wave 7 (Memory): we use the static defaults and DO
// NOT re-derive the async path. Acceptable drift — both strings may
// say "this Mac" / "argent-m3-ultra-dev" even after the operator has
// patched the host label, until they reload the dashboard. See
// DECISIONS.md "wave 10" for the readout.

export const id = "settings";

export async function mount({ root: _root }) {
  // Inlined `$` helper — lived at app.js module scope (line 61). Same
  // idiom as every prior wave.
  function $(id) { return document.getElementById(id); }

  // Inlined `escapeText` helper — lived at app.js:2234. Used heavily
  // in the health / keys / secrets / oauth renders. Verbatim copy;
  // app.js's original stays put for the rest of app.js's consumers.
  function escapeText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // See file-top comment on HOST_LABEL / SSH_HOST_ALIAS. Same defaults
  // as app.js:14 / app.js:22.
  const HOST_LABEL = "this Mac";
  const SSH_HOST_ALIAS = "argent-m3-ultra-dev";

  const refreshBtn = $("settings-refresh-btn");
  if (!refreshBtn) return;

  async function loadHealth() {
    const body = $("settings-health-body");
    const summary = $("settings-health-summary");
    try {
      const r = await fetch("/api/settings/install-checks");
      const j = await r.json();
      if (!j.ok) { body.innerHTML = "<div class=\"dim\">checks unreachable</div>"; return; }
      if (summary) summary.textContent = j.summary;
      body.replaceChildren(...j.checks.map((c) => {
        const row = document.createElement("div");
        // A missing REQUIRED tool is err; a missing optional tool is just a warning
        const cls = c.ok ? "ok" : (c.required ? "err" : "warn");
        row.className = "health-row " + cls;
        const requiredBadge = c.required ? "<span class=\"req-badge\">required</span>" : "";
        row.innerHTML =
          "<span class=\"mark\">" + (c.ok ? "✓" : (c.required ? "✗" : "○")) + "</span>" +
          "<span class=\"name\">" + escapeText(c.name) + requiredBadge + "</span>" +
          "<span class=\"detail\">" + escapeText(c.ok ? c.version : (c.detail || "not installed")) + "</span>";
        if (!c.ok && c.install) {
          const cmd = document.createElement("code");
          cmd.className = "install-cmd";
          cmd.textContent = c.install;
          cmd.title = "click to copy";
          cmd.addEventListener("click", () => {
            navigator.clipboard.writeText(c.install);
            cmd.textContent = "copied ✓";
            setTimeout(() => cmd.textContent = c.install, 1500);
          });
          row.appendChild(cmd);
        }
        return row;
      }));
    } catch (err) {
      body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
    }
  }

  async function loadKeys() {
    const body = $("settings-keys-body");
    try {
      const r = await fetch("/api/settings/keys");
      const j = await r.json();
      if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
      const rows = j.keys.map((k) => {
        const row = document.createElement("div");
        row.className = "key-row " + (k.ok ? "ok" : "warn");
        // v2.7.4: show both env + secrets.json signals when the row
        // has a secrets-json counterpart. Length is presented as a
        // count so the operator can confirm rotation without leaking
        // any character of the underlying credential.
        const sources = [];
        if (k.env) sources.push("env");
        if (k.secrets_json === true) sources.push("secrets.json");
        const sourceTag = sources.length ? ` [${sources.join(" + ")}]` : "";
        const detail = k.ok
          ? `set (${k.length} chars)${sourceTag}`
          : "unset · " + k.purpose;
        row.innerHTML =
          "<span class=\"mark\">" + (k.ok ? "✓" : "○") + "</span>" +
          "<span class=\"name\">" + escapeText(k.name) + "</span>" +
          "<span class=\"detail\">" + escapeText(detail) + "</span>";
        return row;
      });
      const note = document.createElement("div");
      note.className = "dim small";
      note.style.marginTop = "10px";
      note.textContent = j.note;
      body.replaceChildren(...rows, note);
    } catch (err) {
      body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
    }
  }

  // v2.7.4 — API Tokens panel (secrets.json).
  //
  // SECURITY NOTES:
  //   - GET /api/settings/secrets returns presence flags only; this
  //     function never has the actual values to render or leak.
  //   - The modal's <input> is type="password" + autocomplete="new-password"
  //     so the browser doesn't surface the cleartext from a saved-password
  //     dropdown or autofill from another origin.
  //   - On Save we POST the value to the dashboard's 127.0.0.1-bound
  //     endpoint; nothing crosses the LAN. We do NOT log the value to
  //     the browser console.
  //   - On Remove we POST {value: null}. The server clears the field
  //     and returns the updated presence row.
  //   - On success we close the modal and force-clear the input value
  //     in memory before re-render so a subsequent click on Edit
  //     doesn't show the stale paste.
  async function loadSecrets() {
    const body = $("settings-secrets-body");
    if (!body) return;
    try {
      const r = await fetch("/api/settings/secrets");
      const j = await r.json();
      if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
      const purposes = {
        lmstudio_api_token: "LM Studio API auth (when 'Require API Token' is enabled — v2.7.4)",
        brave_api_key: "Brave AI Search (web_search master tool — v2.7.2)",
        firecrawl_api_key: "Firecrawl scraping (web_fetch master tool — v2.7.2)",
        tinyfish_api_key: "TinyFish search + fetch (tinyfish_* master tools — v2.7.16, free tier)",
        linear_api_key: "Linear API (linear_* master tools — v2.7.2)",
        context7_api_key: "Context7 — up-to-date library docs (master tool + MCP for dev-team Claude leads)",
        openrouter_api_key: "OpenRouter API key for accessing hundreds of models via openrouter.ai. Free tier includes many preview models. Mint at https://openrouter.ai/keys",
      };
      const table = document.createElement("table");
      table.className = "secrets-table";
      table.innerHTML =
        "<thead><tr>" +
        "<th>Key</th><th>Purpose</th><th>Status</th><th>Last modified</th><th></th>" +
        "</tr></thead>";
      const tbody = document.createElement("tbody");
      for (const s of j.secrets) {
        const tr = document.createElement("tr");
        const pillClass = s.isSet ? "pill pill-set" : "pill pill-unset";
        const pillText = s.isSet ? "Set" : "Not set";
        const envBadge = s.envOverride
          ? "<span class=\"pill pill-env\" title=\"env var overrides secrets.json per v2.7.4 priority\">env override</span>"
          : "";
        tr.innerHTML =
          "<td><code>" + escapeText(s.key) + "</code></td>" +
          "<td class=\"dim\">" + escapeText(purposes[s.key] || "") + "</td>" +
          "<td class=\"col-status\"><span class=\"" + pillClass + "\">" + pillText + "</span>" + envBadge + "</td>" +
          "<td class=\"col-modified\">" + escapeText(s.lastModified ? new Date(s.lastModified).toLocaleString() : "—") + "</td>" +
          "<td class=\"col-actions\"></td>";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "secondary-btn";
        btn.textContent = s.isSet ? "Edit" : "Set";
        btn.addEventListener("click", () => openSecretsModal(s.key));
        tr.querySelector(".col-actions").appendChild(btn);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.replaceChildren(table);
    } catch (err) {
      body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
    }
  }

  let _currentSecretKey = null;
  function openSecretsModal(key) {
    _currentSecretKey = key;
    const modal = $("secrets-modal");
    const valueEl = $("secrets-modal-value");
    const keyLabel = $("secrets-modal-key-label");
    const result = $("secrets-modal-result");
    if (!modal || !valueEl) return;
    keyLabel.textContent = key;
    valueEl.value = "";
    result.hidden = true;
    result.textContent = "";
    modal.hidden = false;
    // Focus the input immediately — operator just clicked Edit, they
    // want to paste. Use a microtask so the modal is actually visible
    // before we steal focus (some browsers ignore focus on hidden).
    setTimeout(() => valueEl.focus(), 0);
  }

  function closeSecretsModal() {
    const modal = $("secrets-modal");
    const valueEl = $("secrets-modal-value");
    if (modal) modal.hidden = true;
    if (valueEl) valueEl.value = ""; // wipe any pasted token from DOM
    _currentSecretKey = null;
  }

  async function submitSecretsModal(value) {
    if (!_currentSecretKey) return;
    const result = $("secrets-modal-result");
    result.hidden = false;
    result.textContent = "saving…";
    try {
      const r = await fetch(
        "/api/settings/secrets/" + encodeURIComponent(_currentSecretKey),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );
      const j = await r.json();
      if (!j.ok) {
        result.textContent = "error: " + (j.error || "?");
        return;
      }
      // Wipe input + close, then refresh both panels (the api-keys
      // panel shows the combined env+secrets.json signal and must
      // re-fetch too).
      closeSecretsModal();
      loadSecrets();
      loadKeys();
    } catch (err) {
      result.textContent = "error: " + String(err);
    }
  }

  function wireSecretsModal() {
    const saveBtn = $("secrets-modal-save");
    const cancelBtn = $("secrets-modal-cancel");
    const removeBtn = $("secrets-modal-remove");
    const valueEl = $("secrets-modal-value");
    if (!saveBtn || !cancelBtn || !removeBtn || !valueEl) return;
    // Only bind once. wireSecretsModal is called from the same
    // entry point that calls refreshAll, so the listeners would
    // double-bind on a refresh otherwise.
    if (saveBtn.dataset.wired === "1") return;
    saveBtn.dataset.wired = "1";
    saveBtn.addEventListener("click", () => {
      const v = valueEl.value;
      if (!v) {
        $("secrets-modal-result").hidden = false;
        $("secrets-modal-result").textContent = "value is empty — use Remove to clear";
        return;
      }
      submitSecretsModal(v);
    });
    cancelBtn.addEventListener("click", closeSecretsModal);
    removeBtn.addEventListener("click", () => {
      if (!confirm("Remove this token from secrets.json? Tools relying on it will fall back to the env var (if set) or report 'not configured'.")) return;
      submitSecretsModal(null);
    });
    // Enter on the input → save
    valueEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      } else if (e.key === "Escape") {
        closeSecretsModal();
      }
    });
  }

  async function loadOAuth() {
    const body = $("settings-oauth-body");
    try {
      const r = await fetch("/api/settings/oauth");
      const j = await r.json();
      if (!j.ok) { body.innerHTML = "<div class=\"dim\">unreachable</div>"; return; }
      if (!j.accounts.length) {
        body.innerHTML = "<div class=\"dim\">no accounts in <code>~/.config/subctl/accounts.conf</code></div>";
        return;
      }
      body.replaceChildren(...j.accounts.map((a) => {
        const row = document.createElement("div");
        const ok = a.auth_status === "ready";
        row.className = "oauth-row " + (ok ? "ok" : "err");
        row.innerHTML =
          "<span class=\"mark\">" + (ok ? "✓" : "✗") + "</span>" +
          "<span class=\"name\">" + escapeText(a.alias) + "</span>" +
          "<span class=\"detail\">" + escapeText(a.email + " · " + (ok ? "authed" : "not authenticated")) + "</span>";
        if (!ok) {
          // Use the account's actual provider (claude/openai/gemini) so
          // the copied command lands the user in the right OAuth flow.
          const cmdText = "subctl auth " + a.provider + " " + a.alias;
          const cmd = document.createElement("code");
          cmd.className = "install-cmd";
          cmd.textContent = cmdText;
          cmd.title = `click to copy — run this on ${HOST_LABEL} (ssh ${SSH_HOST_ALIAS})`;
          cmd.addEventListener("click", () => {
            navigator.clipboard.writeText(cmdText);
            cmd.textContent = "copied ✓";
            setTimeout(() => cmd.textContent = cmdText, 1500);
          });
          row.appendChild(cmd);
        }
        return row;
      }));
    } catch (err) {
      body.innerHTML = "<div class=\"dim\">error: " + escapeText(String(err)) + "</div>";
    }
  }

  async function loadTelegramStatus() {
    const status = $("settings-tg-status");
    try {
      const r = await fetch("/api/settings/telegram/test", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        status.textContent = `@${j.bot_username || "?"} ok · chat ${j.chat_id || "(unset)"}`;
        status.style.color = "#6cd697";
      } else {
        status.textContent = "error: " + (j.error || "?");
        status.style.color = "#d66c6c";
      }
    } catch {
      status.textContent = "unreachable";
      status.style.color = "#d66c6c";
    }
  }

  function wireTelegramForm() {
    const save = $("settings-tg-save");
    const test = $("settings-tg-test");
    const result = $("settings-tg-result");
    const tokenIn = $("settings-tg-token");
    const chatIn = $("settings-tg-chatid");

    function showResult(ok, text) {
      result.hidden = false;
      result.className = "settings-result " + (ok ? "ok" : "err");
      result.textContent = text;
    }

    save?.addEventListener("click", async () => {
      const payload = { bot_token: tokenIn.value, chat_id: chatIn.value };
      if (!payload.bot_token && !payload.chat_id) {
        showResult(false, "nothing to save — provide a token, chat id, or both");
        return;
      }
      save.disabled = true;
      save.textContent = "saving…";
      try {
        const r = await fetch("/api/settings/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (j.ok) {
          showResult(true, `✓ saved + master restarted\n@${j.bot_username || "?"} reachable, chat_id ${j.chat_id_set ? "set" : "unchanged"}`);
          tokenIn.value = "";
          loadTelegramStatus();
        } else {
          showResult(false, "Failed: " + (j.error || "?"));
        }
      } catch (err) {
        showResult(false, "Error: " + err);
      } finally {
        save.disabled = false;
        save.textContent = "save & test";
      }
    });

    test?.addEventListener("click", async () => {
      test.disabled = true;
      test.textContent = "testing…";
      try {
        const r = await fetch("/api/settings/telegram/test", { method: "POST" });
        const j = await r.json();
        showResult(j.ok, j.ok
          ? `✓ @${j.bot_username || "?"} reachable\nchat_id ${j.chat_id || "(unset)"}`
          : "✗ " + (j.error || "test failed"));
      } catch (err) {
        showResult(false, "Error: " + err);
      } finally {
        test.disabled = false;
        test.textContent = "test current";
      }
    });
  }
  wireTelegramForm();

  function wireConfigViewer() {
    const view = $("settings-config-view");
    const tabs = document.querySelectorAll("#settings-config-tabs .config-tab");
    let active = "policy";

    async function load(name) {
      view.textContent = "loading…";
      try {
        const r = await fetch("/api/settings/config/" + name);
        const j = await r.json();
        if (!j.ok) { view.textContent = "error: " + (j.error || "?"); return; }
        view.textContent = `// ${j.path}\n\n${j.content}`;
      } catch (err) {
        view.textContent = "error: " + err;
      }
    }
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        active = t.dataset.config;
        load(active);
      });
    });
    load(active);
  }
  wireConfigViewer();

  async function loadVault() {
    const status = $("settings-vault-status");
    const input = $("settings-vault-root");
    try {
      const r = await fetch("/api/settings/obsidian");
      const j = await r.json();
      if (!j.ok) {
        if (status) { status.textContent = "error"; status.style.color = "#d66c6c"; }
        return;
      }
      if (input && !input.value) input.value = j.vault_root || "";
      if (status) {
        const note = j.exists ? (j.configured ? "configured · exists" : "default · exists") : (j.configured ? "configured · MISSING" : "default · missing");
        status.textContent = note;
        status.style.color = j.exists ? "#6cd697" : "#d6c46c";
      }
    } catch {
      if (status) { status.textContent = "unreachable"; status.style.color = "#d66c6c"; }
    }
  }
  function wireVaultForm() {
    const save = $("settings-vault-save");
    const input = $("settings-vault-root");
    const result = $("settings-vault-result");
    if (!save || !input) return;
    save.addEventListener("click", async () => {
      const v = input.value.trim();
      if (!v) {
        result.hidden = false;
        result.className = "settings-result err";
        result.textContent = "vault_root is empty";
        return;
      }
      save.disabled = true;
      save.textContent = "saving…";
      try {
        const r = await fetch("/api/settings/obsidian", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vault_root: v }),
        });
        const j = await r.json();
        result.hidden = false;
        if (!j.ok) {
          result.className = "settings-result err";
          result.textContent = "Failed: " + (j.error || "?");
        } else {
          result.className = "settings-result ok";
          result.textContent = "✓ saved · " + (j.exists ? "vault exists" : `path saved but vault dir doesn't exist yet — create it on ${HOST_LABEL}`);
          loadVault();
        }
      } catch (err) {
        result.hidden = false;
        result.className = "settings-result err";
        result.textContent = "Error: " + err;
      } finally {
        save.disabled = false;
        save.textContent = "save";
      }
    });
  }
  wireVaultForm();

  // ── Personality preset tile (Phase 3k UI, v2.5.7) ──────────────────
  // Hits /api/master/personality (GET = list + active, POST = swap).
  // Hot-swap takes effect on next prompt — no daemon restart.
  async function loadPersonality() {
    const sel = $("personality-select");
    const active = $("settings-personality-active");
    const preview = $("personality-preview");
    if (!sel) return;
    try {
      const r = await fetch("/api/master/personality");
      const j = await r.json();
      if (!j.ok) {
        sel.innerHTML = "<option value=''>master unreachable</option>";
        if (active) active.textContent = "—";
        return;
      }
      sel.innerHTML = (j.presets || []).map((p) =>
        `<option value="${escapeText(p.id)}" ${p.id === j.active ? "selected" : ""}>${escapeText(p.id)}</option>`
      ).join("");
      if (active) active.textContent = `active: ${j.active || "—"}`;
      // Show preview text for the currently-selected preset
      const updatePreview = () => {
        const cur = (j.presets || []).find((p) => p.id === sel.value);
        if (preview) preview.textContent = cur ? cur.preview : "";
      };
      sel.removeEventListener("change", sel._previewHandler);
      sel._previewHandler = updatePreview;
      sel.addEventListener("change", updatePreview);
      updatePreview();
    } catch (err) {
      sel.innerHTML = "<option value=''>error</option>";
      if (active) active.textContent = String(err).slice(0, 60);
    }
  }
  const personalityApply = $("personality-apply");
  if (personalityApply) {
    personalityApply.addEventListener("click", async () => {
      const sel = $("personality-select");
      const pick = sel && sel.value;
      if (!pick) return;
      personalityApply.disabled = true;
      try {
        const r = await fetch("/api/master/personality", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset: pick }),
        });
        const j = await r.json();
        if (!j.ok) {
          if (window.notice && window.notice.error) {
            window.notice.error("Personality switch failed", j.error || `HTTP ${r.status}`);
          } else {
            alert(j.error || `HTTP ${r.status}`);
          }
          return;
        }
        await loadPersonality();
        if (window.notice) {
          window.notice("Personality applied", `Master voice → ${j.active}. Takes effect on the next prompt.`);
        }
      } finally {
        personalityApply.disabled = false;
      }
    });
  }

  function refreshAll() {
    loadHealth();
    loadKeys();
    loadSecrets();
    loadOAuth();
    loadTelegramStatus();
    loadVault();
    loadPersonality();
  }
  wireSecretsModal();
  refreshBtn.addEventListener("click", refreshAll);
  refreshAll();
}

export function unmount() {
  // No-op. No setInterval, no document/window listeners, no window-
  // prefixed globals owned by this module. The `window.notice`
  // bridge is a CONSUMER (publisher still lives in app.js) — not
  // ours to null. Interface parity with waves 1–9.
}
