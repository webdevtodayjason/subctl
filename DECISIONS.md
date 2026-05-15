# DECISIONS.md — durable record of architectural calls + deferred work

Chat is ephemeral. This file is where decisions, deferrals, and "we explicitly didn't do this" items live so the next session inherits them.

Sorted newest-first within each section.

---

## Deferred (queued, not done)

### 2026-05-13 — Frontend framework choice deferred
- **What:** Don't pick Svelte/React/HTMX or migrate the dashboard frontend yet. Stay on Bun + vanilla JS + vanilla CSS for now.
- **Why:** The pre-mortem in HANDOFF.md (this morning, 2026-05-13 ~6:30 PM CDT) identified `app.js` at 8,955 lines as the slow-burn risk, but a framework migration is irreversible and cascades across every tab. Operator chose to defer.
- **Sequencing rule:** "Recommendation #1 (split `app.js` per tab in plain JS) comes before any framework decision." Whenever architecture work resumes, that split is the first move, framework comes later.
- **When to revisit:** When the per-tab vanilla-JS split is done and we can evaluate whether splitting alone is enough, or whether a framework's component model would meaningfully help.

### 2026-05-13 — `app.js` per-tab split deferred to a focused session
- **What:** No structural refactor of `dashboard/public/app.js` this session.
- **Why:** Last night's session shipped 30+ versions and the operator-pain was bug fatigue, not architecture. Don't introduce a new risk surface while three open bugs are still hot.
- **Sequencing:** After the three open issues from HANDOFF.md (2.1, 2.2, 2.3) are closed, the per-tab split is the next architecture topic.

### 2026-05-13 — Voice-layer refinement is a separate v2.8.x patch line
- **What:** VoxCPM2-cloned voice was shipped in v2.8.0 and works end-to-end. Quality/pitch tuning is queued separately.
- **Why:** Doesn't intersect with the dashboard work. Treating it as an independent track per HANDOFF.md §6.

---

## Architectural calls

### 2026-05-13 night — dashboard decomposition wave 1 (Logs extracted; loader pattern established)

**Decision:** Begin splitting `dashboard/public/app.js` (8,955 LOC) into per-tab plain-JS ES modules served verbatim by Bun's existing static handler. No framework, no build step, no new deps, no `shared/` directory. Wave 1 extracts the Logs tab as the pattern-setter. App.js shrinks to 8,646 LOC; the rest of the monolith is unchanged.

**Why now:** Pre-mortem 2026-05-12 night flagged `app.js` size as the slow-burn risk; Recommendation #1 (per-tab split in plain JS) must come before any framework decision. Operator approved wave 1 as a single feature-branch PR.

**Module interface** — every extracted tab exports:

```js
export const id;                          // string, matches data-tab attr
export async function mount({ root });    // mandatory — wire DOM + subscriptions
export function unmount(/* ctx */);       // optional — close SSE / timers
// later, optional: refresh(ctx), onState(slice)
```

**Loader pattern** (`dashboard/public/bootstrap.js`):
- Classic `app.js` runs first (script tag is non-module → blocks parser); its IIFE calls `setActiveTab(initial)` during boot, and `setActiveTab` ends with `window.__subctlShellNotifyTabChange?.(tab)` (optional-chain because the loader hasn't evaluated yet on boot).
- `<script type="module" src="/bootstrap.js">` runs after the parser is done. On startup it checks `document.body.dataset.activeTab` and mounts the initial tab if it's in the loader's registry (catches the boot-tab case the notifier missed). After that, every `setActiveTab` call routes through the notifier.
- `Map<id, () => Promise<Module>>` registry holds dynamic-import closures. The first activation per tab kicks off `mod.mount({ root })`. The promise is memoized so a tab mounts exactly once per page. On mount failure: `console.error` + drop the entry so the next activation can retry. Nothing throws — other tabs keep working.

**No `shared/` directory in PR 1:** With only one extracted tab there's no second importer to motivate it. Adding `shared/` now would silently touch every other tab and defeat the "single PR, one tab" discipline. When the second tab extracts and needs the same helper, that's when `shared/` arrives.

**State-ownership ruling — `cachedTeams` stays Policy-owned:**
- The Logs policy filter chip and the Policy tab both read `cachedTeams` (populated by `refreshPolicyTeamsForDropdowns`). Today it's an `app.js` module-scope local.
- The state semantically belongs to Policy — Logs only consumes it for the chip's team selector and meta line.
- To keep Policy as the owner without forcing Logs to depend on `app.js` internals, `app.js` publishes three temporary window bridges immediately after `refreshPolicyTeamsForDropdowns` is defined:
  - `window.__subctlGetPolicyTeams = () => cachedTeams.slice();`
  - `window.__subctlRefreshPolicyTeams = refreshPolicyTeamsForDropdowns;`
  - `window.__subctlRenderAuditEntries = renderAuditEntries;` (renderer is genuinely shared — the sessions tab inventory flagged it as a future consumer)
- These retire when the Policy tab extracts. At that point Policy owns its own publishing (likely a `teamsUpdated` custom event Logs subscribes to), the bidirectional DOM cross-write (`refreshPolicyTeamsForDropdowns` populates both `#logs-policy-team` AND `#policy-resolved-team`) collapses to one side, and the bridges go.
- `renderAuditEntries` gained a single line: it now reads `opts.subfilter ?? "all"` instead of closing over the (now-departed) `policySubfilter` module local. The subfilter belongs to the chip — it travels with Logs.

**Migration order:** Logs → Templates → Models → Preferences → Providers/Vault/Memory/Skills → Projects/Settings/Policy → Teams → Orchestration + Dashboard panels (together) → Master chat (last). Vault must extract before Projects (deep-link dep). Master chat last because it's the biggest tab (1,385 LOC) and most entangled with the SSE/notification chrome.

**What we explicitly did NOT do this PR:**
- Did not introduce a framework, build step, or bundler.
- Did not extract any tab other than Logs.
- Did not touch master chat, orchestration, dashboard panels, or notification tray.
- Did not change Policy ownership of `cachedTeams` or `refreshPolicyTeamsForDropdowns`.
- Did not leave stubs or "TODO hook later" comments in app.js — the deletion is permanent and the loader replaces it.

### 2026-05-13 night — dashboard decomposition wave 2 (Templates extracted)

**Decision:** Extract the Templates tab from `dashboard/public/app.js` into `dashboard/public/tabs/templates.js`, mirroring the wave-1 module interface (`{ id, mount, unmount }`) and the `TAB_LOADERS` registry pattern established in `bootstrap.js`. App.js shrinks from 8,646 → 8,520 LOC (126 lines removed: 1 call site + 125 lines for the function body and its leading comment block).

**Why now:** Templates was identified as the next target in the wave-1 migration order (Logs → **Templates** → Models → …). The pre-extraction inventory showed it was a clean, self-contained tab — the ideal "proof point" candidate to validate that the wave-1 interface holds for a tab that needs *no* state-ownership negotiation.

**Proof point — zero bridges, fully self-contained:**

- Talks only to three HTTP endpoints — `GET /api/team-templates`, `GET /api/team-templates/<name>`, `POST /api/orchestration/spawn`. All keep their server-side handlers untouched.
- Reads no `cachedTeams`-style shared state, dispatches no events, calls no `window.__subctl*` helper. The Logs extraction needed three temporary bridges to keep Policy as the owner of `cachedTeams`; Templates needed zero.
- Uses three `window.prompt(...)` + two `alert(...)` calls for the "Use this template" dialog. Kept as-is — modal replacement is out of scope for the decomposition (would be a separate UX change).
- Behavior preserved verbatim, including the nav-click re-refresh listener. The bootstrap loader memoizes `mount()`, so without re-wiring the `[data-tab="templates"].nav-btn` click handler inside `mount()` itself, subsequent tab clicks would no longer refresh the list — a regression the wave-2 module guards against by re-attaching that listener at mount time.

**What this teaches the migration:** The `{ id, mount, unmount }` interface scales cleanly to fully-isolated tabs without introducing a `shared/` directory or a bridge layer. Tabs that consume cross-tab state (Logs ↔ Policy) need the temporary `window.__subctl*` pattern; tabs that don't can land as drop-in modules. We can move faster on the next batch (Models, Preferences) by sorting them on this axis: isolated-first to reduce churn in `app.js`'s remaining surface.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (this entry)
- ⏭ Next — Models, per the wave-1 ordering. (Models, Preferences, Providers/Vault/Memory/Skills remain on the queue.)

**What we explicitly did NOT do this PR:**
- Did not modify `wave-1` files (`tabs/logs.js`, the bridge globals, `setActiveTab` notify hook) — wave-1 stays untouched.
- Did not touch any tab other than Templates.
- Did not replace the `window.prompt` / `alert` dialogs (UX change, separate concern).
- Did not introduce a `shared/` directory — still nothing to share.

### 2026-05-13 night — dashboard decomposition wave 3 (Models extracted)

**Decision:** Extract the Models tab from `dashboard/public/app.js` into `dashboard/public/tabs/models.js`, mirroring waves 1+2 (commits `3f58f03`, `b681255`). App.js shrinks from 8,520 → 8,408 LOC (-112: 1 call site, 111 function-body lines, plus the orphan `// ----- Models tab — LM Studio model catalog -----` section header that fell out of scope when the body left; mirrors wave-2's leading-comment removal).

**Why now:** Models was the next target in the wave-1 migration order (Logs → Templates → **Models** → …). The trivial case — one fetch endpoint (`GET /api/models`), no shared state, no `window.__subctl*` bridges, no nav-click reattachment quirk. Cleaner than Templates.

**Proof point — even simpler than wave 2:**
- Talks to exactly one HTTP endpoint (`GET /api/models`). Server-side handler untouched.
- Reads no cross-tab state; dispatches no events. Zero bridge layer.
- Three app.js module-scope helpers (`$`, `td`, `emptyRow`) were used; inlined as local declarations inside `mount()` to keep the module self-contained. Behavior identical.
- `setInterval` (5 s poll) + `visibilitychange` listener preserved verbatim. `pollTimer` lifted to module scope so `unmount()` can `clearInterval` for interface parity with wave-1 (logs.js); bootstrap doesn't call unmount today, so this is forward-looking hygiene, not behavior change.

**What this confirms:** The `{ id, mount, unmount }` interface continues to scale; "self-contained tab" is the typical case, not the exception. Three of seventeen tabs now extracted; the remaining queue (Preferences, Providers, Vault, Memory, Skills, …) can follow this same pattern unless they read shared state.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (this entry)
- ⏭ Next — Preferences, per the wave-1 ordering.

**What we explicitly did NOT do this PR:**
- Did not modify wave-1 or wave-2 files (`tabs/logs.js`, `tabs/templates.js`, the bridge globals, `setActiveTab` notify hook).
- Did not touch any tab other than Models.
- Did not replace `setInterval` with a per-mount handle abstraction (a forward refactor when more tabs share polling patterns).
- Did not introduce a `shared/` directory — still nothing to share.

### 2026-05-14 — dashboard decomposition wave 4 (Preferences extracted; listener-lifecycle pattern proven)

**Decision:** Extract the Preferences tab from `dashboard/public/app.js` into `dashboard/public/tabs/preferences.js`, mirroring waves 1–3 (commits `3f58f03`, `b681255`, `2b2c515`). App.js shrinks from 8,408 → 8,122 LOC (-286: header comment block + `initPreferencesTab` body + the DOMContentLoaded bootstrap pair).

**Why now:** Preferences was the next target in the wave-1 migration order (Logs → Templates → Models → **Preferences** → …). Bilateral-maintenance config (operator + Evy both write to `~/.config/subctl/preferences.toml`) — moderately complex but still self-contained on the HTTP boundary.

**Proof point — first module with persistent listener lifecycle:**
- Two persistent listeners are required so Evy-side / CLI / Telegram edits show up live: `document.addEventListener("subctl:sse:preferences", …)` and `window.addEventListener("focus", …)`. In app.js they were installed inside `initPreferencesTab()` with anonymous arrow functions and never removed (acceptable when the module is a singleton that lives for the page's lifetime).
- The module version lifts the handler refs to module scope (`let onSseEvent = null; let onFocus = null;` — mirrors `tabs/models.js`'s `pollTimer` idiom) so `unmount()` can pass them to `removeEventListener`. Bootstrap never calls unmount today; the cleanup is forward-looking hygiene that Master chat will need at scale.
- 4 fetch endpoints (`GET /api/preferences`, `POST` and `DELETE /api/preferences/<cat>/<key>`, `POST /api/preferences/reset`) kept verbatim. Server-side handlers untouched.
- The old `MutationObserver(maybeLoad)` watching `data-active-tab` is intentionally dropped — the shell only calls `mount()` when the tab activates, so the gate is moot. `maybeLoad`'s `if (active !== "preferences") return;` short-circuit goes with it.

**What this teaches the migration:** The `{ id, mount, unmount }` interface accommodates persistent DOM listeners cleanly — captured refs at module scope + symmetric add/remove in mount/unmount. This is the pattern Master chat (and any future tab that subscribes to SSE) will follow.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (this entry)
- ⏭ Next — Providers, per the wave-1 ordering. (Vault, Memory, Skills, … remain on the queue.)

**What we explicitly did NOT do this PR:**
- Did not modify wave-1/2/3 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, bridge globals, `setActiveTab` notify hook).
- Did not touch any tab other than Preferences.
- Did not fix the pre-existing master-routing breakage that makes Preferences flaky on local-Mac dashboards (out of scope; behavior parity with the old code is the goal).
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–3.

### 2026-05-14 — dashboard decomposition wave 5 (Providers extracted)

**Decision:** Extract the Providers tab from `dashboard/public/app.js` into `dashboard/public/tabs/providers.js`, mirroring waves 1–4 (commits `3f58f03`, `b681255`, `2b2c515`, `c633322`). App.js shrinks from 8,122 → 7,853 LOC (-269: section header + 267-line `wireProvidersTab` body + the boot-time call site at app.js:466, offset by +1 for the wave-5 breadcrumb dropped into the existing comment block).

**Why now:** Providers was the next target in the wave-1 migration order (Logs → Templates → Models → Preferences → **Providers** → …). Per-provider profile management UI — modal + form + per-card auth/edit/delete buttons + 30 s background poll. Moderate size; trivially self-contained on the HTTP boundary.

**Proof point — fully self-contained, no bridge layer:**
- Talks to exactly three HTTP endpoints (`GET /api/providers`, `POST` and `DELETE /api/providers/profiles`). Server-side handlers untouched.
- Reads no cross-tab state, dispatches no events, makes no `window.__subctl*` references. Confirmed by grep.
- Two app.js module-scope helpers (`$` @ app.js:61, `escapeText` @ app.js:3214) were used; inlined as local declarations inside `mount()` to keep the module self-contained — same idiom as wave 3 (`tabs/models.js`) inlining `$ / td / emptyRow`. Behavior identical.
- All per-element listeners (`newBtn` click, modal close + cancel + backdrop, form submit, `fAlias`/`fProvider` suggest, per-row auth/edit/delete buttons) stay inline inside `mount()`; they die with the panel DOM and don't need explicit removal in `unmount()`. Transient `setTimeout` calls (focus, close-after-save) also stay inline — they're one-shots, not pollers.
- The 30 s background poll moves to a module-scope `pollTimer` so `unmount()` can `clearInterval` — parity with wave 1 (logs.js) / wave 3 (models.js) / wave 4 (preferences.js). Bootstrap doesn't call `unmount` today; this is forward-looking hygiene.

**What this teaches the migration:** The old `setInterval` callback gated the 30 s refresh on `getComputedStyle(panel).display !== "none"`. Dropped here because the bootstrap loader only mounts modules when their tab activates — the visibility test is now redundant. Mirrors wave 4's dropping of the `MutationObserver` watching `data-active-tab`. The pattern that's emerging: bootstrap-mounting *is* the visibility contract, and per-tab visibility re-checks inside polling loops can retire as each tab extracts. Future tabs (Vault, Memory, Skills, Settings) should follow the same simplification when their bodies move.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (this entry)
- ⏭ Next — Vault, per the wave-1 ordering. (Memory, Skills, Settings, … remain on the queue.)

**What we explicitly did NOT do this PR:**
- Did not modify wave-1/2/3/4 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, bridge globals, `setActiveTab` notify hook).
- Did not touch any tab other than Providers.
- Did not replace the inline `confirm(...)` (delete) or the indirect `alert(...)` paths with a modal/toast layer — behavior parity is the goal, UX-modal replacement is a separate change.
- Did not change any server-side `/api/providers*` handler — only the client moved.
- Did not introduce a `shared/` directory — still nothing to share (each tab inlines its tiny helper budget).
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–4.

### 2026-05-14 — dashboard decomposition wave 6 (Vault extracted; publisher bridge pattern proven)

**Decision:** Extract the Vault tab from `dashboard/public/app.js` into `dashboard/public/tabs/vault.js`, mirroring waves 1–5 (commits `3f58f03`, `b681255`, `2b2c515`, `c633322`, `edc0b73`). App.js shrinks from 7,853 → 7,544 LOC (-309: 1 boot call site, the `// ----- Vault viewer (Phase 3n) ---` section header + 308 lines of `wireVaultTab` body, offset by +3 for the wave-6 breadcrumb dropped into the existing comment block).

The new module continues to **publish** `window.openVaultDeepLink` from `mount()` — making this the FIRST tab in the decomposition to expose a window bridge. Wave 1 (Logs) only consumed bridges (`__subctlGetPolicyTeams`, etc.); wave 6 is the symmetric publisher side. The Projects tab (wave 9, still in app.js at the relocated lines ~3210) reads the global to deep-link into specific notes.

**Why now:** Vault was the next target in the wave-1 migration order (Logs → Templates → Models → Preferences → Providers → **Vault** → …). It also had a hard sequencing constraint: Vault must extract **before** Projects so the publisher half of the deep-link bridge moves first. Memory and Skills remain on the queue after this.

**Bridge pattern — publisher side:**
- `mount()` ends by assigning `window.openVaultDeepLink = function(root, path) { … }`. Verbatim body from the original lines 2246–2253; the function closes over the mount-scope `checkActive` so navigation re-runs deep-link parsing when the tab nav button is missing.
- `unmount()` sets `window.openVaultDeepLink = null` (symmetric with the publisher install). Bootstrap never calls `unmount` today, so this is forward-looking hygiene — same parity stance as waves 1–5's `pollTimer` / listener teardown.
- The bridge **stays published** until Projects extracts in wave 9. We DID NOT replace it with a `CustomEvent` or `EventTarget` channel this wave. The consumer at app.js:3210 reads the global directly and a switch would force a parallel edit in a tab we explicitly are not touching this wave.
- When Projects extracts, we'll evaluate retiring this bridge to a `subctl:vault-deeplink` custom event. The decision criterion will be: is there ≥1 additional consumer beyond Projects (e.g. master-chat tool calls suggesting "open this note") that would benefit from the looser coupling? If yes → custom event. If no → keep the global (simpler, same shape as `window.__subctlGetPolicyTeams` until Policy extracts).

**Lifecycle — first tab to lift a `MutationObserver` handle:**
- The original installed `new MutationObserver(checkActive).observe(document.body, …)` inline at line 2239 with no captured handle. Bootstrap-mounting makes the first mount-time `checkActive` redundant, but the observer still has real work: when Projects fires `openVaultDeepLink`, the resulting `nav.click()` flips `data-active-tab`, the observer catches it, `checkActive` re-reads the hash. We can't drop the observer the way wave 4 dropped the Preferences `MutationObserver`.
- Lifted to a module-scope `let activeTabObserver = null;` so `unmount()` can `.disconnect()` it. Same idiom as wave 3 (`tabs/models.js`)'s `pollTimer` and wave 5's identical pattern. First tab in the migration to use this pattern for an observer rather than a timer.
- `select.change`, `.dir-label` / `.vault-tree-note` / `.vault-wikilink` click listeners, and the `setTimeout` marked.js ready-poll are element-scoped or one-shot; they don't need explicit removal. Only the observer + the bridge null-out are in `unmount()`.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (this entry)
- ⏭ Next — Memory, per the wave-1 ordering (278 LOC, no shared state by current inventory).

**What we explicitly did NOT do this PR:**
- Did not modify wave-1/2/3/4/5 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, bridge globals, `setActiveTab` notify hook).
- Did not touch any tab other than Vault. The Projects-tab consumer at app.js:3210 (typeof guard + invocation) is preserved verbatim — it stays as-is until wave 9.
- Did not retire the `window.openVaultDeepLink` bridge. Did not introduce a `subctl:vault-deeplink` custom event yet. Did not refactor the consumer.
- Did not touch the Settings tab's vault-config form (lives BEFORE the Vault tab body; outside the deletion range).
- Did not change any server-side `/api/vault/*` handler — only the client moved.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–5.

### 2026-05-14 — dashboard decomposition wave 7 (Memory extracted; multi-entry collapse)

**Decision:** Extract the Memory tab from `dashboard/public/app.js` into `dashboard/public/tabs/memory.js`, mirroring waves 1–6 (commits `3f58f03`, `b681255`, `2b2c515`, `c633322`, `edc0b73`, `27000b5`). App.js shrinks from 7,544 → 7,263 LOC (-281: 1 boot call site, the `// ----- Memory tab — Obsidian vault status -----` section header + 280 lines covering three function bodies, offset by +1 for the wave-7 breadcrumb dropped into the existing comment block).

This is the FIRST tab in the decomposition with multiple module-scope entry points in app.js. `wireTier1MemoryCards`, `wireMemoryTab`, and `wireEvyMemoryCard` were three independent functions; the boot called `wireMemoryTab`, which in turn called the other two (tier-1 at the top, Evy at the bottom). All three collapse into one `mount()` in the new module.

**Why now:** Memory was next in the wave-1 migration order (Logs → Templates → Models → Preferences → Providers → Vault → **Memory** → …). It introduces no new patterns beyond the multi-entry collapse — no window bridges, no cross-tab state, no SSE — so it's the lowest-risk slot to validate the multi-entry pattern before Skills (~410 LOC) and Projects (~468 LOC) which are bigger payloads.

**Multi-entry collapse pattern:**
- Three function declarations inline inside `mount()` as `setupTier1Cards`, `setupMainPanel`, `setupEvyCard`. Same body verbatim minus the cross-helper calls and the deduplicated `esc` helper.
- `mount()` calls all three directly at the bottom — flat orchestration. Considered keeping `setupMainPanel` as the orchestrator that calls the other two (matches the original control flow exactly), but the flat form makes the entry points visible at the top of the module instead of buried inside the main-panel body. The semantic ordering (tier-1 first, main second, Evy last) is preserved.
- Two `escapeForHtml` / `esc` helpers consolidated to one mount-scope `esc`. The Evy version was strictly broader (null-safe), so the unified form adopts that variant — never narrower.

**Lifecycle — first tab to lift TWO timer handles:**
- Both original `setInterval`s had `getComputedStyle(panel).display !== "none"` visibility gates (app.js:3466–3468 for the 15s tier-1 refresh, app.js:3545–3548 for the 30s main refresh). Both gates dropped — bootstrap-mounting is the new gate. Same call as waves 4–6.
- `tier1PollTimer` and `mainPollTimer` lifted to module scope. `unmount()` clears both. Bootstrap never calls `unmount` today; forward-looking hygiene, mirroring waves 1–6.
- All other listeners (textarea inputs, `[data-mem-save]` clicks, search/refresh/kind controls, per-entry forget buttons inside `.evy-mem-del`) are element-scoped or one-shot; they die with the panel DOM and don't need explicit removal.

**HOST_LABEL drift accepted:** app.js has a module-scope `let HOST_LABEL` that `/api/host` patches asynchronously. The Memory tab's only consumer is the Obsidian-not-installed onboarding card. Rather than re-derive the async path inside the module (or set up a cross-tab broadcast), the new module hardcodes `const HOST_LABEL = "this Mac";` matching the same default as `app.js:14`. Acceptable drift: the onboarding string may say "this Mac" even after the operator has set a custom host_label, until they reload the dashboard. The `.host-label` spans elsewhere in the dashboard still repaint correctly — only this onboarding paragraph is affected, and it's already a one-shot install prompt.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (this entry; 7/17 tabs)
- ⏭ Next — Skills (~410 LOC), then Projects (~468 LOC).

**What we explicitly did NOT do this PR:**
- Did not modify wave-1/2/3/4/5/6 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, `tabs/vault.js`, bridge globals, `setActiveTab` notify hook).
- Did not touch any tab other than Memory.
- Did not change any server-side `/api/memory/*` handler — only the client moved.
- Did not modify the FTS5 schema, Obsidian vault paths, or Tier-1 character limits.
- Did not change Evy backend behavior (search, recent, stats, delete endpoints all unchanged).
- Did not retire the per-mount `confirm()` in the Evy "forget" path. Behavior preserved verbatim from the original.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–6.

### 2026-05-13 — Account usage on multi-host is by-design partial, no operator-side fix this session (closes HANDOFF.md §2.2)

**Decision:** Accept that the dashboard shows different account usage numbers on different hosts. Not a regression; not fixing this session.

**Evidence (M3, 2026-05-13 ~7:00 PM CDT):**
- `subctl usage --json` returns valid JSON with `ok: false` for every claude-* alias.
- `claude-jason`: creds file `~/.claude-jason/.credentials.json` does NOT exist on M3 (operator's Claude Code logs in on local Mac; creds stay there). Architectural: host-locality of OAuth creds.
- `claude-titanium`, `claude-semfreak`: creds exist on M3 (May 10), but Anthropic returns HTTP 429 from `/api/oauth/usage`. Cause: local Mac and M3 both run dashboards polling that endpoint every 5 min for the same user-level account → Anthropic sees double the rate → 429s land on whichever caller is second.
- `dashboard/server.ts:406-409` (`usageForAlias`) silently returns `null` for any account where `ok: false`, regardless of *why*. Operator sees zeros, cannot distinguish "not authed here" from "rate-limited transiently."

**Why we didn't fix it:**
- Operator explicitly capped scope: do not expand into multi-host architecture this session. ✓ following.
- A real fix needs either (a) credential sharing across hosts, (b) a single-poller arrangement where only one subctl instance per user calls the usage API and the others read from a shared store, or (c) longer polling intervals + per-account backoff. All of those are v2.9.x+ scope.

**What we DID do:**
- Documented the per-account failure categorization (above) so any future session knows the symptom is real but understood.
- Filed a follow-up task for the small observability win: surface per-account `error_kind` ("missing creds on this host" / "rate-limited" / "other") in the dashboard so operators can see *why* each account is zero rather than seeing a generic null.

**When to revisit:** When fleet management work begins (multi-Mac orchestration, "the dashboard you look at" routing). The follow-up observability task can ship independently.

### 2026-05-13 — OSINT alert loop closed via inbox archive + master restart (closes HANDOFF.md §2.3)

**Decision:** Silenced the recurring Telegram alerts by archiving the dead team's inbox file + restarting master. Permanent fix queued as a separate task.

**Root cause:** master's tmux pruner at `components/master/server.ts:3148-3158` silently no-ops because (a) `tmux` is not in launchd's PATH on M3, AND (b) tmux server itself wasn't running. So orphan teams in `teamLastActivity` never get pruned, keep tripping the staleness threshold every watchdog tick. The handoff's `teamRegistryExists`-missing-callback hypothesis (server.ts:3268) is correct as a contributing factor but was not the proximate cause.

**Permanent-fix gaps captured as TaskList #5:**
1. Tmux pruner should log when it gives up (not silent).
2. Wire `teamRegistryExists` callback at the auto-nudge call site.
3. Add master HTTP route for orphan-team eviction (`DELETE /teams/:name`) + `subctl team forget <name>` CLI verb. Today, the only way to evict a team with no live tmux session is master restart.
4. `subctl team kill` archives inbox but not the audit log at `~/.local/state/subctl/audit/<name>.jsonl`. Either archive both or document the separation prominently.

---

## Explicitly NOT done this session
- Framework migration (Svelte / React / HTMX / SvelteKit).
- `app.js` per-tab split.
- ADR 0019 dashboard-migration doc — depends on framework choice we're not making.
- Skills tab redesign / Orchestration redesign / new tab features.
- Voice-layer refinement (separate track).
- Worktree cleanup (housekeeping; not a primary deliverable).
- Multi-host credential or usage-polling rework (HANDOFF §2.2 accepted as "by design, deferred").
