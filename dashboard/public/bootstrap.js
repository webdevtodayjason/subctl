// dashboard/public/bootstrap.js
//
// v2.8.6 — Wave 1 of dashboard/public/app.js decomposition. ES-module shell
// loader. Lazy-imports a per-tab module the first time each tab activates,
// then calls `mod.mount({ root })`.
//
// Loading model:
//   - Classic `app.js` runs first (script src="/app.js" is non-module and
//     blocks the parser). It calls `setActiveTab(initial)` during its boot,
//     and `setActiveTab` ends with `window.__subctlShellNotifyTabChange?.(tab)`.
//   - This module is `type="module"` so it executes after the parser is done.
//     On its first run we check `document.body.dataset.activeTab` to catch
//     the boot tab (where the notifier call landed before we existed).
//
// Registry of extracted tabs. As each tab migrates out of app.js, add an
// entry here. Waves so far: Logs (1), Templates (2), Models (3),
// Preferences (4), Providers (5), Vault (6), Memory (7), Skills (8),
// Projects (9), Settings (10), Policy (11), Teams (12),
// Orchestration (13), Chat (14) — final.
//
// Map keys are the DOM `data-tab` attribute value (the routing contract —
// mountTab() does `Map.get(b.dataset.tab)`). For wave 13 the file is
// `tabs/orch.js` but the routing key MUST be `"orchestration"` so that
// `setActiveTab("orchestration")` triggers the dynamic import. Wave 14
// follows the standard rule — file `tabs/chat.js`, routing key `"chat"`
// (the default-active tab on first page paint, so bootstrap mounts it
// immediately via boot-tab catch-up).

const TAB_LOADERS = new Map([
  ["logs", () => import("./tabs/logs.js")],
  ["templates", () => import("./tabs/templates.js")],
  ["models", () => import("./tabs/models.js")],
  ["preferences", () => import("./tabs/preferences.js")],
  ["providers", () => import("./tabs/providers.js")],
  ["vault", () => import("./tabs/vault.js")],
  ["memory", () => import("./tabs/memory.js")],
  ["skills", () => import("./tabs/skills.js")],
  ["projects", () => import("./tabs/projects.js")],
  ["settings", () => import("./tabs/settings.js")],
  ["policy", () => import("./tabs/policy.js")],
  ["teams", () => import("./tabs/teams.js")],
  ["orchestration", () => import("./tabs/orch.js")],
  ["chat", () => import("./tabs/chat.js")],
]);

// id -> Promise<module>. Memoizes the dynamic import + mount so a tab is
// only ever mounted once. On mount failure we drop the entry so the next
// activation gets a clean retry.
const mounted = new Map();

async function mountTab(tab) {
  const loader = TAB_LOADERS.get(tab);
  if (!loader) return; // tab not extracted yet — app.js still owns it
  if (mounted.has(tab)) return;

  const root = document.querySelector(`section[data-tab="${tab}"]`);
  if (!root) {
    console.error(`[bootstrap] no <section data-tab="${tab}"> in DOM`);
    return;
  }

  const promise = (async () => {
    const mod = await loader();
    await mod.mount({ root });
    return mod;
  })();
  mounted.set(tab, promise);

  try {
    await promise;
  } catch (err) {
    console.error(`[bootstrap] mount failed for tab "${tab}":`, err);
    mounted.delete(tab);
  }
}

window.__subctlShellNotifyTabChange = (tab) => {
  if (!tab) return;
  void mountTab(tab);
};

// Boot tab catch-up: by the time this module body runs, app.js's
// `setActiveTab(initial)` has already fired (and our notifier didn't exist
// yet). Re-check `body.dataset.activeTab` once to mount the initial tab if
// it's extracted.
const initial = document.body?.dataset?.activeTab;
if (initial) void mountTab(initial);
