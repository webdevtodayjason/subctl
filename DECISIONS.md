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

### 2026-05-14 — dashboard decomposition wave 8 (Skills extracted; dead-bridge preservation)

**Decision:** Extract the Skills tab from `dashboard/public/app.js` into `dashboard/public/tabs/skills.js`, mirroring waves 1–7 (commits `3f58f03`, `b681255`, `2b2c515`, `c633322`, `edc0b73`, `27000b5`, `6597668`). App.js shrinks from 7,263 → 6,860 LOC (-403: 1 boot call site + the `// ----- Skills tab — catalog + import flow -----` section header through the closing `// ── end v2.8.1 skills clarity ──` comment, offset by +3 for the wave-8 breadcrumb dropped into the existing comment block).

This is the biggest tab in the migration so far. Two module-scope entry points in app.js (`wireSkillsTab` and `wireSkillsClarityView`) plus four module-scope helpers (`emptyCopyForCategory`, `renderSkillCard`, `whereCopyFor`, `showEvySkillBody`) and the `SKILLS_INFO_COPY` constant all collapse into one module. Same multi-entry collapse pattern as wave 7 (Memory).

**Why now:** Skills was next in the wave-1 migration order after Memory. It exercises three patterns at once — multi-entry collapse (proven in wave 7), two `setInterval` handles with visibility gates (proven in wave 7), and a window-bridge publication (proven in wave 6). No single new pattern, just the densest combination so far. Validates that the wave-5/6/7 lifecycle idioms generalize to the largest payloads before Projects (~468 LOC).

**Bridge preservation rationale:** The original `wireSkillsClarityView` publishes `window.__skillsClarityRefresh = refreshCategorized` so external triggers (SSE evy-authored-skill events per the original comment) can force a categorized re-render. A `grep -rn '__skillsClarityRefresh' dashboard/ components/master/` finds ZERO readers other than the assignment itself — the bridge is effectively dead inside the dashboard codebase. BUT external consumers might still call into it: the master daemon's `/master/skills/*` route, an operator bookmarklet, or a browser extension Jason has set up. Wave 8 is a refactor, not a behavior-change. The bridge stays published from `mount()` exactly where the original placed it; `unmount()` nulls it (same hygiene as wave 6's `window.openVaultDeepLink`). **Retirement deferred to a separate housekeeping task** once we audit external readers — at that point the bridge graduates to a `subctl:skills-clarity-refresh` custom event, or just gets removed.

**Lifecycle — two timers + a document-scoped click handler:**
- `pollTimer` (30s catalog refresh): app.js:979 had a `getComputedStyle(panel).display !== "none"` visibility gate; dropped. Bootstrap-mounting is the new gate.
- `clarityPollTimer` (15s categorized refresh): app.js:1056 had the same gate; dropped.
- `documentClickHandler`: the clarity popover installs `document.addEventListener("click", ...)` to close itself when the operator clicks outside the popover or its trigger. Genuinely document-scoped (not element-scoped), so if `mount()` ever runs twice without an intervening `unmount()`, two handlers would stack. Lifted to module scope and `removeEventListener`'d in `unmount()`. First module in the decomposition to lift a `document.addEventListener` handler — wave 4's listener-lifecycle pattern proven at panel scope, this wave extends it to document scope.
- All other listeners (filter input, refresh button, source rows, skill rows, [?] popover-trigger buttons, the import form's submit/close/cancel/overlay-click, per-card View/Promote/Delete buttons) are element-scoped and die with the panel DOM. The `setTimeout(closeImport, 2200)` after a successful import is one-shot and self-collecting.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (this entry; 8/17 tabs)
- ⏭ Next — Projects (~468 LOC).

**What we explicitly did NOT do this PR:**
- Did not retire the `window.__skillsClarityRefresh` bridge. Preserved verbatim from inside `mount()` pending an external-reader audit (deferred housekeeping pass).
- Did not refactor the clarity view's category model, popover positioning, or `SKILLS_INFO_COPY` content.
- Did not change the import modal UX (form layout, close-on-overlay-click behavior, the `setTimeout(closeImport, 2200)` post-success delay).
- Did not modify wave-1/2/3/4/5/6/7 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, `tabs/vault.js`, `tabs/memory.js`, bridge globals, `setActiveTab` notify hook).
- Did not touch any server-side `/api/skills/*` handler — only the client moved.
- Did not change the Skills router, categorized backend, evy-skills directory layout, or the promote/delete endpoints.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–7.

### 2026-05-14 — dashboard decomposition wave 9 (Projects extracted; dual-role bridge handling)

**Decision:** Extract the Projects tab from `dashboard/public/app.js` into `dashboard/public/tabs/projects.js`, mirroring waves 1–8. App.js shrinks from 6,860 → 6,398 LOC (-462: section header + `wireProjectsTab` body (`app.js:2532–2996`, 465 lines) + the boot call site (`app.js:453`), offset by +4 lines for the wave-9 breadcrumb in the boot comment block AND a one-line `window.__subctlAttachOneShotAssistantCapture` bridge published right after the helper's declaration).

Projects is the **first tab that both CONSUMES someone else's bridge AND OWNS a window-prefixed cache of its own.** Previous waves established each pattern independently — wave 6 (Vault) was the first publisher; wave 8 (Skills) preserved a dead bridge; waves 1–5/7 either had no bridges or only consumed. Projects exercises both directions at once and pins the playbook.

**Why now:** Projects was next in the wave-1 migration order. The dual-role pattern is what made it interesting beyond pure size: every remaining wave will be exercising some mix of CONSUME / OWN / PUBLISH, and getting the dual-role conventions right here keeps Settings (528 LOC, next), Policy (609 LOC, after that), Master chat, and Orchestration cockpit from each re-inventing the convention.

**Bridge handling decision — keep both as window globals; do NOT retire to events:**

1. **CONSUMES `window.openVaultDeepLink`** (published by `tabs/vault.js`, wave 6). Used by the "Open in Vault Viewer" action button to deep-link a project's `decisions.md` inside the master vault. The original's `typeof window.openVaultDeepLink === "function"` guard + `location.hash` / `nav.click()` fallback is preserved verbatim. Why keep the window global instead of retiring to a `subctl:vault-deeplink` custom event? Two reasons:
   - The current shape (function-on-window + typeof guard + fallback) handles the not-yet-mounted case cleanly. Bootstrap-mounting makes the not-mounted case MORE likely (tabs are inert until first activation), and the `nav.click()` fallback path fires `data-active-tab` flip → bootstrap notifier → Vault mount → Vault's `MutationObserver` re-reads the hash. That dance already works.
   - A custom event would require Vault to listen on `document` for `subctl:vault-deeplink`, which means Vault has to be mounted first. Same not-mounted problem, different syntax. The window global is the simpler contract.

2. **CONSUMES `window.__subctlAttachOneShotAssistantCapture`** (newly published by app.js right after the `attachOneShotAssistantCapture` declaration). Same `window.__subctl*` bridge idiom as wave 1's `tabs/logs.js` (`__subctlRenderAuditEntries`, `__subctlGetPolicyTeams`, `__subctlRefreshPolicyTeams`). The lead's section bounds for wave 9 (`app.js:2532–2996`) excluded the helper at `app.js:2463–2530` because `attachOneShotAssistantCapture` co-lives with Chat (its only call sites are Projects today, but its `renderToolPill` / `ensureChatToolPillsRow` dependencies are still chat-owned at `app.js:197` and `app.js:247`). Three alternatives considered:
   - **Move the helper into `tabs/projects.js`:** rejected. Forces us to also bridge `renderToolPill` + `ensureChatToolPillsRow` (still needed by Chat at `app.js:3056` and `app.js:3372`), which inverts the dependency from "Projects depends on Chat" to "Chat depends on Projects" without any architectural reason.
   - **Inline duplicate copies of all three helpers into `tabs/projects.js`:** rejected. ~60 LOC of duplication, two divergence vectors when Chat's tool-pill model evolves.
   - **Publish the helper on window (chosen):** 1 line of app.js, 1 line of consumer-side optional-chained call. Established precedent in wave 1. Bridge retires naturally when Master chat extracts (probably wave 12+ once Settings/Policy are out).

3. **OWNS `window.__policyPresetsCache`** — Projects-only lazy-memoized fetch promise for `/api/policy/presets`. Created on the first time a project-detail render reaches the Apply-preset dropdown wiring; reused for every subsequent project open. A `grep -rn '__policyPresetsCache' dashboard/ components/master/` confirms ZERO readers outside Projects (it's not really a "bridge" — it's an instance cache that happens to live on window). Why keep `window.`-prefixed instead of lifting to module scope?
   - **Behavior parity > stylistic preference.** The point of this wave is to move code without changing what it does. Lifting to module scope would change identity semantics across the (theoretical) unmount/remount cycle.
   - **Cache survives unmount.** `unmount()` does NOT null `window.__policyPresetsCache`. It's a fetch promise; no resources to release; re-fetching on re-mount would defeat the cache. The bridge globals owned-by-other-modules (`window.openVaultDeepLink`, `window.__subctlAttachOneShotAssistantCapture`) are also left alone in `unmount()` for the same reason — they're not ours to null.

**Lifecycle — one timer + one document-scoped listener:**
- `pollTimer` (30s refresh of project list + reselection): `app.js:2867–2868` had a `getComputedStyle(panel).display !== "none"` visibility gate; dropped (bootstrap-mounting is the new gate).
- `documentKeydownHandler`: the new-project modal installs `document.addEventListener("keydown", ...)` to close on Escape. Genuinely document-scoped — if `mount()` ever runs twice without an intervening `unmount()`, two handlers would stack. Lifted to module scope and `removeEventListener`'d in `unmount()`. The lead's worker brief flagged "no document listeners observed" — there IS one; this module handles it the same way wave 8 handled its popover click handler.
- All other listeners (filter input, list-item clicks, per-detail action buttons, modal close/cancel/overlay-click, name-input preview, GitHub controls, the form submit) are element-scoped and die with the panel DOM. The `setTimeout(focus, 50)` after opening the modal and `setTimeout(closeModal, 1800)` after a successful create are one-shot and self-collecting.

**Helpers inlined at mount-scope (not bridged) for behavior parity:**
- `$` — `id => document.getElementById(id)` (one-liner, every prior wave inlines it).
- `escapeText` — used heavily inside `renderProjectDetail`. App.js's copy at `app.js:2233` stays put for the rest of app.js's consumers.
- `cssEscape` — used at one site to address the per-project chat log via `querySelector`. App.js's copy at `app.js:2454` stays put for chat at `app.js:3069`.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (this entry; 9/17 tabs)
- ⏭ Next — Settings (~528 LOC), then Policy (~609 LOC).

**What we explicitly did NOT do this PR:**
- Did not retire `window.openVaultDeepLink` to a `subctl:vault-deeplink` custom event. Kept the function-on-window contract for the reasons in §1 above. Re-evaluate after Master chat extracts and we see how many publisher/consumer pairs survive in window-bridge form.
- Did not refactor the consumer of `window.openVaultDeepLink` inside Projects. The `typeof` guard + `location.hash` / `nav.click()` fallback ships verbatim.
- Did not modify any `/api/projects/*`, `/api/policy/presets`, `/api/policy/preset/<path>`, or `/api/master/chat` server-side handler. Only the client moved.
- Did not move `attachOneShotAssistantCapture` (or its `renderToolPill` / `ensureChatToolPillsRow` deps) into `tabs/projects.js`. Kept in app.js, published on window — see §2 above.
- Did not lift `window.__policyPresetsCache` to module scope. Behavior parity wins over stylistic preference until we have a reason to break the cache identity contract — see §3 above.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–8.
- Did not modify wave-1/2/3/4/5/6/7/8 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, `tabs/vault.js`, `tabs/memory.js`, `tabs/skills.js`).

### 2026-05-14 — dashboard decomposition wave 10 (Settings extracted; biggest single function collapse)

**Decision:** Extract the Settings tab from `dashboard/public/app.js` into `dashboard/public/tabs/settings.js`, mirroring waves 1–9. App.js shrinks from 6,398 → 5,870 LOC (-528: section header + `wireSettingsTab` body (`app.js:797–1324`, 528 lines) + the boot call site (`app.js:461`), offset by +2 lines for the wave-10 breadcrumb in the boot comment block — net -527 with adjacent-blank cleanup landing the final delta at -528).

Settings is the **biggest single-function collapse in the migration so far.** Unlike wave 7 (Memory) and wave 8 (Skills) — which each had 2–3 sibling top-level functions in app.js to fold together — Settings is a single 528-line `wireSettingsTab` whose body contains ~15 nested sub-helpers as closures. The extraction is a one-for-one verbatim copy: outer function → `mount()`, every inner sub-helper → local declaration. No structural rearrangement, no behavior delta.

**Why now:** Settings was next in the wave-1 migration order after Projects. It validates that the wave-1-through-9 idioms scale to a single function with this many inline closures, and it isolates the `window.notice` consumer pattern before Policy (wave 11, 609 LOC) and Master chat (which will exercise consumer + publisher both).

**Sub-helper accounting — all 15 collapse into mount() locals:**
- `loadHealth` (install-checks panel)
- `loadKeys` (env-derived API key presence)
- `loadSecrets` (secrets.json presence + Edit/Set buttons)
- `openSecretsModal`, `closeSecretsModal`, `submitSecretsModal`, `wireSecretsModal` (modal lifecycle)
- `loadOAuth` (provider account auth status)
- `loadTelegramStatus`, `wireTelegramForm` (Telegram bot config + test)
- `wireConfigViewer` (read-only config-file tabs)
- `loadVault`, `wireVaultForm` (Obsidian vault-root configuration)
- `loadPersonality` (+ inline `personalityApply` button handler, not enumerated as a named function but lives in the same body)
- `refreshAll` (manual operator-driven fan-out)

Plus one piece of closure-shared mutable state: `let _currentSecretKey = null` between `openSecretsModal` / `closeSecretsModal` / `submitSecretsModal`. Lifted from function scope to mount-body scope — same shape, same identity semantics across a single mount call. NOT lifted to module scope (no remount today, but parity with the original function-scoped `let` is the goal).

**`window.notice` handling — keep as a CONSUMER bridge, do NOT extract the notification system this wave:**
The personality-apply flow inside `wireSettingsTab` consumes `window.notice` and `window.notice.error` (and falls back to `alert(...)` if the publisher hasn't run yet). The publisher is `window.notice = (title, body, opts) => _showNotice(...)` at `app.js:1921` (was 2449 pre-decomp). It lives next to its render helpers (`_showNotice`, toast DOM machinery) and is consumed by **at least seven other sites in app.js** (`grep -c 'window\.notice' dashboard/public/app.js` returns 19 hits across 12 call sites). Three alternatives considered:

1. **Extract the notification system to a sibling module now (e.g. `tabs/_notice.js` or `lib/notice.js`):** rejected. The publisher is consumed from chat, orchestration, attach-team, policy-team — all still in app.js. Extracting it before those readers move means publishing a new bridge for each of them, which is the *opposite* of the migration's direction (we're trying to *retire* `window.*` bridges, not invent new ones).
2. **Move just the consumer-side personality-apply block, leaving the publisher in place:** chosen. Same pattern as wave 9 (Projects) consuming `window.openVaultDeepLink` published by wave 6 (Vault). The `typeof` guard (`if (window.notice && window.notice.error)`) and the `alert(...)` fallback are both preserved verbatim — they handle the case where the publisher hasn't yet executed (notice is wired further down in app.js's boot at line 1921, well after `wireSettingsTab` would have been called by `boot()` had we not extracted it).
3. **Pre-bind `window.notice` into a local `const` at mount-time:** rejected. Would break the late-binding semantics — Settings can mount before `window.notice` is published (bootstrap activates tabs on first user click, which may precede the rest of app.js's boot if the operator is fast). The current shape with the `if (window.notice)` guard at call-site is correct as-is.

Bridge retires when app.js's notification system gets its own module (post-decomp cleanup phase, probably wave 13+ after Settings/Policy/Master-chat/Orchestration are out).

**Settings vault-config form vs. Vault tab (wave 6) — different concerns, different DOM, different endpoints:**
Easy point of confusion to flag at the README level. The Settings tab's vault-form (`loadVault` + `wireVaultForm` in `tabs/settings.js`) writes `/api/settings/obsidian` and targets `#settings-vault-status`, `#settings-vault-root`, `#settings-vault-save`, `#settings-vault-result`. That's the operator-facing single-string vault-root *configuration* surface. The **Vault tab** in `tabs/vault.js` (wave 6) is a separate browser surface that reads `/api/vault/roots` and renders the multi-root file tree under `#vault-*` IDs. Same domain noun ("vault"), separate concerns — the Settings vault-form sets *where* the vault lives; the Vault tab navigates *inside* it. We did NOT merge or unify them this wave.

**Lifecycle:**
- No `setInterval`. Refresh is operator-driven via `#settings-refresh-btn` → `refreshAll()`. The original had no Settings-specific polling either, so we removed the visibility-gate template that waves 4–8 wrote (it has nothing to gate).
- Multiple `setTimeout`s for "copied!" feedback on install-cmd and oauth-cmd `<code>` elements (1500ms label restore). One-shot and self-collecting — no handles tracked.
- No `document` or `window` event listeners. All other handlers (modal save/cancel/remove, telegram save/test, vault save, personality-apply, config-tab clicks, per-secret-row edit buttons) are element-scoped and die with the panel DOM.
- `unmount()` is a **no-op**. Interface parity with waves 1–9; no timers, no document/window listeners, no window-prefixed globals owned by this module. The `window.notice` bridge is consumer-only — not ours to null.

**Helpers inlined at mount-scope (not bridged) for behavior parity:**
- `$` — `id => document.getElementById(id)` (one-liner, every prior wave inlines it).
- `escapeText` — used in health / keys / secrets / oauth renders. App.js's copy at `app.js:1706` stays put for the rest of app.js's consumers.
- `HOST_LABEL` — defaulted to `"this Mac"`, matching app.js:14's initializer. Consumed in the oauth-row install-cmd tooltip and the vault-form success message. Same call as wave 7 (Memory) — we use the static default and DO NOT re-derive the `/api/host` async patch path. Acceptable drift: the tooltip and success message may read "this Mac" even after the operator has set a custom host label, until they reload.
- `SSH_HOST_ALIAS` — defaulted to `"argent-m3-ultra-dev"`, matching app.js:22. Same hardcoded value the original used; the long-standing TODO at app.js:2300 to de-hardcode this is not a wave-10 concern.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (commit `52e2ae2`)
- ✅ Wave 10 — Settings (this entry; 10/17 tabs)
- ⏭ Next — Policy (~609 LOC), then Master chat / Orchestration cockpit.

**What we explicitly did NOT do this PR:**
- Did not refactor or restructure any of the 15 inline sub-helpers. The extraction is verbatim: outer function → `mount()`, every inner closure → local declaration. Same identity, same shape, same wiring order.
- Did not introduce a notification module / extract the `window.notice` publisher. The publisher stays at `app.js:1921` with `_showNotice` and its associated toast DOM helpers. Settings reads it as a CONSUMER only — same pattern as wave 9 (Projects) consuming `window.openVaultDeepLink`.
- Did not change any endpoint contract (`/api/settings/*`, `/api/master/personality`). Only the client moved.
- Did not unify the Settings vault-config form with the Vault tab. Different DOM, different endpoints — they remain independent.
- Did not de-hardcode `SSH_HOST_ALIAS`. The TODO at the original app.js:2300 outlives this wave.
- Did not lift `_currentSecretKey` to module scope. Kept as a `let` inside `mount()` for behavior parity with the original function-scoped state.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–9.
- Did not modify wave-1/2/3/4/5/6/7/8/9 files (`tabs/logs.js`, `tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, `tabs/vault.js`, `tabs/memory.js`, `tabs/skills.js`, `tabs/projects.js`).

### 2026-05-14 — dashboard decomposition wave 11 (Policy extracted; wave-1 bridges retired)

**Decision:** Extract the Policy zone from `dashboard/public/app.js` into `dashboard/public/tabs/policy.js` (the **biggest extraction yet at ~717 LOC deleted from app.js**) AND retire the three temporary `window.__subctl*` bridges wave 1 introduced. App.js shrinks from 5,870 → 5,161 LOC (-709 net: -717 from the Policy zone deletion + 8 lines added for the wave-11 breadcrumb in the boot comment block and the rewording of an adjacent comment).

This is the **first wave to modify an already-shipped extracted module** (`tabs/logs.js`). Logs was wave 1; it consumed three `window.__subctl*` bridges that app.js owned. Wave 11 retires those bridges and replaces them with a custom-DOM-event contract — Logs is no longer a bridge consumer, it's an event subscriber.

**Why now:** Policy was the last of the migration's "wave 1 bridge dependents." With Policy extracted, both publishers and consumers of the wave-1 bridges live in modules, so the temporary `window.__subctl*` globals can be retired in the same PR. Waiting longer would mean carrying three dead bridges through the remaining 6 tab extractions.

**Event contract — publisher (Policy) + subscriber (Logs):**
```
PUBLISHER  tabs/policy.js
  emits  document → "subctl:policy-teams-updated"
         detail: { teams: PolicyTeam[] }      // full list, copy of cachedTeams
  fires on: end of every successful refreshPolicyTeams() call (initial mount,
            5-second visibility-gated poll, manual #policy-refresh-btn click,
            and whenever Logs sends a refresh-request).

SUBSCRIBER tabs/logs.js
  listens document ← "subctl:policy-teams-updated"
  on receipt:
    1. updates `logsCachedTeams` (module-scope) with a copy of detail.teams
    2. repopulates #logs-policy-team, preserving the prior selection
       across refreshes (the same DOM cross-write logic that previously
       lived in Policy's refreshPolicyTeamsForDropdowns)

SUBSCRIBER tabs/policy.js  (back-channel for Logs's chip-activation flow)
  listens document ← "subctl:policy-teams-refresh-request"
  on receipt: calls refreshPolicyTeams() → which publishes the
              teams-updated event Logs is waiting on.

PUBLISHER  tabs/logs.js  (only fires from the chip-activation branch)
  emits   document → "subctl:policy-teams-refresh-request"  (no detail)
  pattern: one-shot listener on teams-updated + 1500ms fallback timer
           (see "One-shot pattern + defensive fallback" below).
```

The publisher emits the full teams array via `event.detail.teams`. Each subscriber slices to keep its own copy — no shared mutable state.

**One-shot pattern + defensive fallback (deviation from spec):** The spec's bare one-shot example listens for `subctl:policy-teams-updated` indefinitely after firing a refresh-request. That works only if the Policy module is already mounted. But Policy is **lazy-loaded** by `bootstrap.js` on first activation of the Policy tab; an operator who lands on the Logs tab and clicks the Policy chip without first visiting Policy hits a scenario where no listener exists to fulfill the request → the chip would hang in "connecting" forever.

To prevent this regression, the chip-activation branch in `tabs/logs.js` wraps the one-shot with a 1500ms fallback `setTimeout`. If the teams-updated event arrives first (the happy path once Policy mounts), the timer is cleared. If the timer fires first, we remove the one-shot listener and call `connectPolicy()` anyway — using whatever `logsCachedTeams` we have. With an empty list, `connectPolicy` naturally degrades to status "no team selected" (its existing empty-team branch). This is **graceful** rather than the pre-wave-11 default-active bridge behavior, but it cleanly avoids the hang. Documented inline in `tabs/logs.js`.

**First inter-module modification — care taken:** Touching `tabs/logs.js` (wave 1, shipped 2026-05-13) for the first time required:
- Preserving every existing module-scope handle (`policyAuditTeam`, `policyEventSource`, `policySubfilter`, `lastClickedAuditEntry`, `logsEventSource`, `logsBackoffMs`) — no renames, no rescoping of state that's already settled.
- A structural shuffle: `mountPolicyChip` was a module-scope function in wave 1, calling the bridges. To give it access to the audit renderers (now local to `mount()`), it was lifted INSIDE `mount()` as a nested function declaration. The chip's helper functions that don't need renderers (`showAuditDetail`, `hideAuditDetail`, `buildAllowlistSnippet`, `openAllowlistModal`, `closeAllowlistModal`) STAY at module scope — they only touch `lastClickedAuditEntry` which is module-scope, so no change of scope was needed.
- Re-naming a local `view`/`status`/`copyBtn` inside the nested chip to `chipView`/`chipStatus`/`allowCopyBtn` to avoid shadowing the outer `mount()` locals of the same names — the nested chip used to be at module scope where no shadowing existed.
- A `function setChipStatus` replaced the chip's old local `setStatus` for the same reason (the outer `setStatus` for launchd-log status lives in `mount()` now).

**DOM cross-write split rationale (each tab owns its own selector):** Pre-wave-11, `refreshPolicyTeamsForDropdowns` in app.js populated BOTH `#policy-resolved-team` and `#logs-policy-team` from a single helper. Wave 11 splits this: `tabs/policy.js` populates only `#policy-resolved-team` from `refreshPolicyTeams`; `tabs/logs.js` populates only `#logs-policy-team` from inside the teams-updated event listener. Same DOM behavior, same preserve-prev-selection logic on both sides — but each tab now owns the DOM it cares about, with no cross-module reach. The event payload is the single source of truth.

**Audit renderer move — Logs is the sole consumer:** The trio (`fmtAuditLine`, `classifyAuditLine`, `renderAuditEntries`) sat in app.js's Policy zone solely because that's where `refreshPolicyTeamsForDropdowns` was — they were called via the `window.__subctlRenderAuditEntries` bridge from inside `tabs/logs.js`'s `mountPolicyChip` only. With the bridge retired, the cleanest home is inside `mount()` in `tabs/logs.js` as function declarations (so the nested `mountPolicyChip`'s `connectPolicy` can call them without explicit parameter passing). Hoisting via `function` (not `const`) means statement-order inside `mount()` is irrelevant — matches the wave-1 original's reliance on function-declaration hoisting.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (commit `52e2ae2`)
- ✅ Wave 10 — Settings (commit `44aa618`)
- ✅ Wave 11 — Policy + bridge retirement (this entry; 11/17 tabs)
- ⏭ Next — Teams (~319 LOC), then Master chat / Orchestration cockpit.

**Bridge retirement scoreboard:** Of the original wave-1 `window.__subctl*` bridges, ALL THREE are retired this wave:
- `window.__subctlGetPolicyTeams` — gone
- `window.__subctlRefreshPolicyTeams` — gone
- `window.__subctlRenderAuditEntries` — gone

Other inter-tab bridges that are still live (NOT touched this wave):
- `window.openVaultDeepLink` — published by tabs/vault.js (wave 6), consumed by tabs/projects.js (wave 9). Stays until both modules can negotiate via event.
- `window.__subctlAttachOneShotAssistantCapture` — wave 9. Stays.
- `window.__skillsClarityRefresh` — wave 8 dead bridge (no known reader). Stays pending confirmation.
- `window.__policyPresetsCache` — wave 9. Stays.
- `window.notice` / `window.notice.error` — published by `_showNotice` still in app.js; consumed by wave-10 Settings and many in-app.js callers. Stays until the notification surface itself extracts.

**Helpers inlined at mount-scope (not bridged) for behavior parity:**
- `$` — `id => document.getElementById(id)` (one-liner, every prior wave inlines it).
- `escapeHtml` — used in renderTeams / renderDenials / renderVerifierTimeline / renderResolvedChips / renderListSection. App.js's copy (now at app.js:4516) stays for the notification + upstream-history renderers that continue to use it.
- `emptyRow(cols, msg)` — used in renderTeams / renderDenials. App.js's copy at `emptyRow` (still in app.js, called from accounts + sessions + transcript renderers) stays.

**Lifecycle:**
- `mount({ root })` wires the editor sub-panels, installs the refresh-request listener, kicks off the initial `refreshPolicyTeams()` (which seeds both the local cachedTeams and any subscribers via the teams-updated event).
- `unmount()` detaches the refresh-request listener. The MutationObserver inside `wirePolicyTab`'s `checkVisible` (visibility-driven polling) and the four MutationObservers inside `panelObserveActive` (one per editor pane) remain unfreed — matches wave-1-through-10 parity; bootstrap never calls unmount today.
- `refreshPolicyTeams` is `async` and re-entrant-safe — the only state it writes is `cachedTeams` and the `#policy-resolved-team` selector. A racing call from the 5s poll and a Logs refresh-request both produce idempotent results.

**What we explicitly did NOT do this PR:**
- Did not introduce an event-bus library or a shared/ directory — two stylistic `document.addEventListener` calls on namespaced event names is sufficient for this contract.
- Did not change the `/api/policy/teams` endpoint contract — same response shape (`{ ok, teams: [...] }`), same fields per team row (`team_id`, `mode`, `preset`, `allowlist_sha`, etc.). Server side is unchanged.
- Did not refactor wave-1's chip/SSE state (`policyAuditTeam`, `policyEventSource`, `policySubfilter`, `lastClickedAuditEntry` stay at module scope in `tabs/logs.js`). Beyond the bridge swap + the structural shuffle to nest `mountPolicyChip` inside `mount()`, wave-1's chip is untouched.
- Did not push the cached-teams cache to a service layer — each tab keeps its own copy fed by the event payload. Single source of truth is the server's `/api/policy/teams` response; subscribers receive a slice on every Policy refresh.
- Did not modify the wave-6 Vault bridge (`window.openVaultDeepLink`). Retiring it requires both Vault and Projects to negotiate via event — separate work, separate wave.
- Did not modify the `_showNotice` notification publisher (still in app.js with `window.notice` exposed). Out of scope; retires when the notification surface itself extracts.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–10.
- Did not modify wave-2/3/4/5/6/7/8/9/10 files (`tabs/templates.js`, `tabs/models.js`, `tabs/preferences.js`, `tabs/providers.js`, `tabs/vault.js`, `tabs/memory.js`, `tabs/skills.js`, `tabs/projects.js`, `tabs/settings.js`). Only `tabs/logs.js` was modified — and only for the bridge-retirement scope spelled out above.

### 2026-05-14 — dashboard decomposition wave 12 (Teams extracted)

**Decision:** Extract the Teams tab (dev-team templates) from `dashboard/public/app.js` into `dashboard/public/tabs/teams.js`. App.js shrinks 5,161 → 4,845 LOC (-316: section header + `wireTeamsTab` body at `app.js:488–803` (316 lines) and the boot call site at `app.js:461`, offset by +1 line for the wave-12 breadcrumb in the boot comment block — net -316).

Teams is the **simple case** of the decomposition. After the wave-9/10/11 sequence handled cross-tab bridges, dual-role data sharing, and a 717-LOC structural shuffle with bridge retirement, wave 12 is one isolated function with one timer and zero cross-module surface. Same idiom as wave 5 (Providers): outer function → `mount()`, inline closures stay closures, single `setInterval` lifted to a module-scope `pollTimer` for `unmount()` hygiene.

**Why now:** Teams was the next sequential tab after Policy (wave 11). It's a clean single-function extraction with no shared state to negotiate, so it slots in between the structurally-heavy wave 11 and the structurally-heavy wave 13 (joint Orchestration cockpit + Dashboard panels at ~1,891 LOC). Doing it now keeps the cadence and frees up app.js's call site for the wave-13 entry.

**Lifecycle:**
- One `setInterval(refreshList, 30000)` lifted to module-scope `pollTimer`. Original wrapped the call in a `getComputedStyle(panel).display !== "none"` visibility gate — dropped, same as waves 4–11, because bootstrap only mounts on tab activation. Gate is moot.
- One `setTimeout(closeModal, 900)` after a successful save — left verbatim, no handle tracked (self-collecting).
- All other listeners (modal open/close, form submit, skills filter, per-row buttons, edit/duplicate/delete actions inside the detail pane) are element-scoped and die with the panel DOM.
- `unmount()` clears `pollTimer` only. Interface parity with waves 1–11; bootstrap never calls unmount today.
- No `window.__subctl*` reads, no `subctl:*` event subscriptions, no shared cache. Fully isolated tab.

**Helpers inlined at mount-scope (not bridged) for behavior parity:**
- `$` — `id => document.getElementById(id)` (one-liner, every prior wave inlines it).
- `escapeText` — used heavily in `refreshList` / `selectTeam` / `renderToolsGrid` / `renderSkillsList` renders. App.js's copy stays put for the rest of app.js's consumers.

**Spec-vs-code drift (logged for next dispatch):** The wave-12 brief listed HTTP endpoints as `/api/team-templates` (GET/POST/DELETE) plus a `POST /api/orchestration/spawn` call. Neither matches the actual code. The section actually calls `/api/teams` (GET, POST), `/api/teams/<name>` (GET, PUT, DELETE), `/api/skills`, `/api/teams/tools`. No `/api/orchestration/spawn` is invoked. The module's docstring documents the real endpoints; the brief was not amended in source. Server handlers were not modified (and were never going to be — they were out of scope), so this drift is a documentation-only issue that affected nothing structural.

**Migration progress:**
- ✅ Wave 1 — Logs (commit `3f58f03`)
- ✅ Wave 2 — Templates (commit `b681255`)
- ✅ Wave 3 — Models (commit `2b2c515`)
- ✅ Wave 4 — Preferences (commit `c633322`)
- ✅ Wave 5 — Providers (commit `edc0b73`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (commit `52e2ae2`)
- ✅ Wave 10 — Settings (commit `44aa618`)
- ✅ Wave 11 — Policy + bridge retirement (commit `e8bbd30`)
- ✅ Wave 12 — Teams (this entry; 12/17 tabs)
- ⏭ Next — joint wave 13: Orchestration cockpit + Dashboard panels (~1,891 LOC).

**What we explicitly did NOT do this PR:**
- Did not refactor or restructure any of the inline sub-helpers (`renderSelectedSkillChips`, `renderSkillsList`, `renderToolsGrid`, `setSelectedTools`, `getSelectedTools`, `loadEditorContext`, `openModal`, `closeModal`, `refreshList`, `selectTeam`). Verbatim copy: outer function → `mount()`, every inner closure → local declaration. Same identity, same shape, same wiring order.
- Did not replace the browser dialogs (`prompt` for duplicate-rename, `confirm` for delete, `alert` for failure paths). Out of scope this wave; would require coordination with the notification surface that's still owned by app.js.
- Did not change any endpoint contract or modify any server handler. `/api/teams[*]`, `/api/skills`, `/api/teams/tools` all unchanged.
- Did not introduce or retire any cross-module bridge — Teams owns nothing on `window` and consumes nothing from `window.__subctl*`. The wave-9 `window.openVaultDeepLink`, wave-9 `window.__subctlAttachOneShotAssistantCapture`, wave-8 `window.__skillsClarityRefresh`, wave-9 `window.__policyPresetsCache`, and `window.notice` consumer surfaces all stand exactly as they did after wave 11.
- Did not wire `unmount()` into the bootstrap — same parity stance as waves 1–11.
- Did not modify wave-1/2/3/4/5/6/7/8/9/10/11 files. Only the new `tabs/teams.js`, `bootstrap.js` (+1 entry), `dashboard/server.ts` (+1 STATIC_FILES entry), and `app.js` (deletion + breadcrumb) were touched.

### 2026-05-14 — dashboard decomposition wave 13 (Orch zone extracted; deviated from HANDOFF's joint plan)

**Decision:** Extract the Orchestration zone — six contiguous blocks at `app.js:709–1614` (camera grid + cockpit + watchdog history shim + watchdog panel + tmux-preview modal + web-terminal driver + notice/confirm modal) — into `dashboard/public/tabs/orch.js`. App.js shrinks from 4,845 → 3,945 LOC (-900 net: -906 for the zone deletion, offset by +6 lines for the wave-13 breadcrumb in the boot comment block and the rewording of the adjacent v2.7.21 web-terminal commentary). Single largest extraction across all 13 waves.

**Why now:** Orchestration was next in the wave-1 migration order. After waves 1–12, the remaining big chunks in app.js are Orchestration (this wave, ~906 LOC), Master chat (~1,385 LOC, wave 14), Dashboard panels (~985 LOC, wave 15+), Chat/SSE plumbing (~600 LOC, wave 16), and the Projects-chat sub-system (~?LOC, wave 17). Doing Orch now keeps the cadence and lands the entire watchdog/cockpit/notice subsystem in one module before the chat extraction depends on `window.notice`.

**HANDOFF deviation — joint with Dashboard panels was reduced to Orch only:**

The wave-12 closeout (above) telegraphed wave 13 as a JOINT extraction with Dashboard panels (~1,891 LOC combined). The lead retracted that join when dispatching this wave. Reasons:

- **Dashboard panels are shell infrastructure, not a tab module.** The Dashboard zone is driven by the global WS/polling loop and renders into `<section data-tab="dashboard">` from app.js's render functions. It doesn't fit the `mount({ root })` per-tab module shape that bootstrap.js drives. A future extraction will need a different surface (a dedicated `panels/dashboard.js` consumed by app.js, or a tab module that registers via a different mechanism). That's wave 15+ design work, not parity work.
- **The wave-6 publisher pattern handles cross-tab globals at the unit of a tab.** Orch needs to publish 5 globals (`window.notice` + 4 `__subctl*` helpers) for the 32 consumers across the shell and the extracted modules. Joint extraction wasn't required for that — the publisher idiom works on its own.
- **Single-wave risk:** 906 LOC is already the largest single extraction across all 13 waves. Adding Dashboard panels on top would compound the risk window. Keeping waves narrow is consistent with the wave-11 lesson (bridge retirement was already enough additional surface for one wave).

The Dashboard panels remain in app.js for a future wave (15+) when their architecture pivot is designed.

**Routing-key correction (also a deviation from HANDOFF):** The HANDOFF specified registering the module under `TAB_LOADERS` key `"orch"` (matching the file basename `tabs/orch.js`). On verification this would silently no-op: `mountTab(tab)` does `Map.get(b.dataset.tab)`, and the DOM data-tab attribute for the Orchestration nav is `"orchestration"`. Every other extracted tab uses its `data-tab` value as the Map key (`logs`, `templates`, `policy`, …), so registering `"orch"` would break the invariant and the dynamic import would never fire — leaving the 5 globals unpublished and the 21+ no-null-check consumers throwing on first use. Corrected to `"orchestration"` and documented the contract in the `TAB_LOADERS` comment block. File path stays `tabs/orch.js`; only the routing key needed correcting.

**5-globals publishing accounting:**

```
PUBLISHED at end of mount() (5 + 2 sub-method assigns):
  window.__subctlOpenTmuxPreview      = openTmuxPreview;
  window.__subctlCopyAttachCommand    = copyAttachCommand;
  window.__subctlOpenWebTerminal      = openWebTerminal;
  window.__subctlWireWebTerminalGate  = wireWebTerminalGate;
  window.notice                       = (title, body, opts) => _showNotice({…});
  window.notice.error                 = (title, body) => _showNotice({…, kind:"error"});
  window.notice.confirm               = (title, body) => _showNotice({…, kind:"warn", confirm:true});

NULLED in unmount():
  window.__subctlOpenTmuxPreview      = null;
  window.__subctlCopyAttachCommand    = null;
  window.__subctlOpenWebTerminal      = null;
  window.__subctlWireWebTerminalGate  = null;
  window.notice                       = null;   (cascades to .error/.confirm)

CONSUMERS (32 total) — all unchanged in this wave:
  app.js (in-shell, 24 sites):
    - 21× window.notice / .error / .confirm     (chat tool pill, supervisor switch,
                                                 profile pill, compact, clear,
                                                 attach-failure, project hooks)
    - 1× window.__subctlOpenTmuxPreview         (Dashboard panel row, line ~3278)
    - 1× window.__subctlCopyAttachCommand       (Dashboard panel row, line ~3288)
    - 1× window.__subctlOpenWebTerminal         (none after Teams extracted —
                                                 kept published for legacy
                                                 panels + symmetry)
    - 1× window.__subctlWireWebTerminalGate     (hoist for boot; no live
                                                 consumer now that Orch owns
                                                 its own boot wiring)

  extracted tabs/*.js (8 sites):
    - 8× window.notice / window.notice.error    (settings.js, mostly the
                                                 personality-switch flow)
```

**Lifecycle: `_tmuxPollTimer` lifted to module scope (only state lifted).** The original IIFE used three `let` bindings at this top level: `_tmuxPollTimer`, `_tmuxCurrent`, `_termModalKeyHandler`. Only `_tmuxPollTimer` is genuinely cross-call state that needs survive-until-unmount semantics; the other two are transient per-modal handles that the `close()` callback already nulls. So `_tmuxPollTimer` lives at module scope; the other two stay local to `mount()`. Same idiom as wave 3's `pollTimer` and wave 6's `activeTabObserver`.

**Accepted no-null-check risk for `window.notice` consumers (documented, not fixed):** The 21 in-app.js `window.notice` consumers do NOT null-check before calling. If the operator triggers a flow that reads `window.notice` BEFORE this module mounts (e.g. profile-pill confirm on a first page load that lands on `chat` and never activates `orchestration`), the call throws. Mitigation surface:

- Most consumers fire on user interaction, not boot, so the window is the gap between page-load and first Orchestration nav activation.
- The wave-9 precedent for `window.openVaultDeepLink` had no-op fallbacks at consumer sites; the `window.notice` consumers do not. Adding fallbacks would touch 21 sites; out of scope this wave.
- Real fix is wave 14 (Master chat) lifting notification surface ownership OR a dedicated wave-15 notification module mounted at boot from bootstrap.js (sibling to TAB_LOADERS). Documented as follow-up.

**Migration progress (13 of 17 dashboard zones now extracted):**
- ✅ Wave 1 — Logs zone scaffold + ES-module bridge (commit `81a1a47`)
- ✅ Wave 2 — Templates (commit `f10d2ce`)
- ✅ Wave 3 — Models (commit `b09224c`)
- ✅ Wave 4 — Preferences (commit `c5a3eef`)
- ✅ Wave 5 — Providers (commit `2c9c9d2`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (commit `52e2ae2`)
- ✅ Wave 10 — Settings (commit `44aa618`)
- ✅ Wave 11 — Policy + bridge retirement (commit `e8bbd30`)
- ✅ Wave 12 — Teams (commit `7236f34`)
- ✅ Wave 13 — Orchestration zone (this entry; 13/17 — single-largest extraction)
- ⏭ Next — wave 14: Master chat (~1,385 LOC). Wave 14 is the natural retirement opportunity for `window.notice` if we design the chat module to own a `notice` event surface that other modules publish to (instead of reading a window-attached function). That's the right wave for the notification subsystem refactor, not this one.

**What we explicitly did NOT do this PR:**
- Did not joint-extract with Dashboard panels (rationale above).
- Did not retire any of the 5 published globals; all 32 consumers stand exactly as they did after wave 12. Bridge retirement is wave 14+ work.
- Did not refactor the notice subsystem (modal layout, kind colors, OK/Cancel/Esc/Enter handling, focus management, native-fallback path). Verbatim copy of `_showNotice` from app.js.
- Did not modify or replace `function escapeText(s)` at app.js:1397 — it stays in app.js because it's also used outside the Orch zone (search "escapeText(" in app.js for the call sites). orch.js has its own LOCAL copy of the 3-line helper to stay self-contained.
- Did not modify `function cssEscape(s)` at app.js:1618 or `function attachOneShotAssistantCapture(logEl)` at app.js:1627 — these are adjacent to the Orch zone but used outside it (project chat panels). Both stay in app.js.
- Did not touch server handlers for `/api/orchestration/*`, `/api/watchdog/*`, `/api/master/*`, or `/api/web-terminal/*`. Pure client-side restructure.
- Did not add `unmount()` invocation in bootstrap — same parity stance as waves 1–12.
- Did not modify any wave-1-through-12 tab module.

### 2026-05-14 — dashboard decomposition wave 14 (Master chat extracted; DECOMPOSITION COMPLETE)

**Decision:** Extract the Master-chat zone — four non-contiguous blocks at `app.js` (chat model selector, supervisor profile pill, `attachOneShotAssistantCapture`, and `wireMasterChat`) plus the chat-only helper bands (tool-display config + thinking indicator) — into `dashboard/public/tabs/chat.js`. App.js shrinks from 3,945 → 2,280 LOC (-1,665 net: -1,683 lines deleted, offset by +12 lines for the wave-14 breadcrumb in the boot comment block, +5 lines for the `window.__subctlHostLabel` bridge introduction in app.js's host-label boot, and +1 line in the existing `applyHostLabel` mirror). Final-wave extraction; the largest tab module ever created (1,862 LOC), built around the codebase's single biggest function (`wireMasterChat` at ~1,133 LOC).

**Why now / finish-line context:** Master chat was always the last item on the wave-1 migration order (HANDOFF 2026-05-13 night: "Logs → Templates → Models → Preferences → Providers/Vault/Memory/Skills → Projects/Settings/Policy → Teams → Orchestration + Dashboard panels (together) → Master chat (last)"). After wave 13 retired `window.notice` ownership to Orch, Master chat could land cleanly as a consumer of `window.notice` instead of a co-owner. Two days of focused decomposition sessions (2026-05-13 night → 2026-05-14 night) extracted all 14 zones in sequence; app.js is now ~58% smaller than the original 8,955 LOC baseline (3,945 → 2,280 here; ~75% smaller than the 8,955 starting point).

**Helper-relocation analysis — which app.js-internal helpers moved with chat vs got new bridges vs stayed orphaned:**

The pre-extraction grep was decisive on every helper. Two scopes mattered:
  (a) other uses *inside app.js* (the shell), and
  (b) other uses *across the 13 prior `tabs/*.js` modules*.

| Helper | Old location | Decision | Rationale |
|---|---|---|---|
| `TOOL_DISPLAY_FALLBACK` + `_toolDisplayConfig` + `loadToolDisplay` + `_toolDisplayConfigSync` + `resolveToolDisplay` + `formatToolArgsPreview` + `formatToolDetailBlock` + `renderToolPill` + `ensureChatToolPillsRow` | app.js:63–258 | **Moved into chat.js** | Grep returned zero non-chat-zone callers in app.js AND zero callers in any `tabs/*.js` module. These are chat-only helpers that were defined at IIFE top by historical accident, not because they're shared. Moving them with chat reduces app.js further and keeps the helper close to the code that uses it. The eager `loadToolDisplay()` warmup call at the old app.js:121 moved with the function definition — preserves the "cache-warm-before-first-tool-call" behavior. |
| `showChatThinking` + `hideChatThinking` + `setChatThinkingState` | app.js:259–310 | **Moved into chat.js** | Same grep result — zero non-chat callers anywhere. Chat-only. |
| `escapeText(s)` | app.js:712 | **Stayed in app.js (orphaned), inlined into chat.js as a local** | HANDOFF directive: "STAYS in app.js". Empirically the helper had zero non-chat callers in app.js at extraction time (every other shell-side caller had previously moved out as part of waves 1–13, and every extracted module inlined its own local copy). Honored the directive conservatively — the standalone is now orphaned, available for a future cleanup wave. chat.js gets its own local inline copy following the same pattern orch.js (wave 13), providers.js (wave 5), teams.js (wave 12), settings.js (wave 10), and projects.js (wave 9) established. |
| `cssEscape(s)` | app.js:718 | **Stayed in app.js (orphaned), inlined into chat.js as a local** | Same idiom as `escapeText`. Used only at app.js:870 (rehydrateFromTranscript) inside the chat zone before extraction. After chat moved, it's orphaned in app.js. Future cleanup. |
| `SSH_HOST_ALIAS` | app.js:22 | **Stayed in app.js (orphaned), inlined into chat.js as a const** | Same conservative stance — not strictly named in the HANDOFF as protected, but matches the surrounding helpers' pattern. Two old callers (lines 1556, 1676 inside slash commands) moved with chat; the const is now orphaned. orch.js (wave 13) inlined the same string verbatim. |
| `HOST_LABEL` (mutable `let` at app.js:14, updated by `/api/host` fetch) | app.js:14 | **Stayed in app.js; new bridge `window.__subctlHostLabel` published from app.js, read by chat.js at SLASH_HELP-build time** | HOST_LABEL is mutated by an async fetch and consumed by app.js's `applyHostLabel()` DOM painter (still in app.js — paints `.host-label` spans across the shell chrome). Moving the variable would break the painter; leaving it static would freeze chat's slash help. New bridge: app.js writes `window.__subctlHostLabel` on every HOST_LABEL update; chat.js reads `window.__subctlHostLabel \|\| "this Mac"` at the moment SLASH_HELP is built inside wireMasterChat(). The capture-at-build-time semantic is identical to today's closure-capture-at-wirer-call-time semantic (the original closed-over HOST_LABEL in the SLASH_HELP array literal — same effective freshness). |
| `window.__subctlPushNotification` | app.js (notification tray, ~line 2273 post-wave) | **Stays in app.js shell** | Chat is a consumer. App.js still owns the notification tray. No change. |
| `window.__subctlVoiceEnabled` | written in chat zone | **Kept on `window`** | Owned entirely by chat (set by `refreshVoiceEnabled` and the `voice_config` SSE handler; read by `endAssistantBubble` for the play-button gate). No external readers, but kept on `window` for namespace stability matching the wave-9 / wave-13 idiom. |

**`__subctlAttachOneShotAssistantCapture` bridge preserved:** Published from `chat.js` mount() (verbatim from app.js:802 pre-wave). Consumed at `tabs/projects.js:367` for the per-project chat panels. The mount-time publication is fine: bootstrap mounts the default-active tab (which is `chat` per HTML `<button class="nav-btn active" data-tab="chat">`) immediately via boot-tab catch-up, so the bridge is live by the time the operator can navigate to Projects.

**Lifecycle (forward-looking; bootstrap doesn't call unmount today):**

Module-scope handles lifted in chat.js for unmount():
- `masterEventSource` — Master chat's long-lived SSE stream. `connect()` reassigns on each reconnect; unmount closes the current one.
- `profilePillEventSource` — quiet observer SSE for `profile_swapped`.
- `oneShotEventSources` — Set of per-call `EventSource` from `attachOneShotAssistantCapture`. Each instance self-removes from the Set on natural close or 90 s safety timeout; unmount closes any remaining.
- `chatModelSelectorPollTimer`, `profilePillPollTimer`, `contextMeterPollTimer` — three intervals for visibility-gated polling.
- `reconnectingDebounce`, `connectBackoffTimer` — two timeout handles inside the SSE reconnect lifecycle (lifted because they reassign on each error).
- `chatPanelObserver` — `MutationObserver` watching `body.dataset.activeTab` for re-scroll on Chat re-show.
- `chatFullscreenEscHandler` — `document` keydown listener for Esc-exits-fullscreen.

**What remains in app.js (the shell, ~2,280 LOC):**

Legitimate shell infrastructure that doesn't fit the per-tab `mount({ root })` model:
- Sessions browser + Dashboard panel renderers (state-driven render functions, fed by the WS/polling loop).
- State polling + WebSocket transport (`/api/live`) + render dispatcher.
- Cell builders + verdict pills + util-bar helpers.
- Notification tray (the `__subctlPushNotification` owner + its modal/badge surface).
- Header status pill + manual refresh button.
- Lucide chrome icons (post-boot icon swap for static chrome).
- Host-label boot (`/api/host` fetch + `applyHostLabel` painter + new `window.__subctlHostLabel` bridge).
- Tab nav (`setActiveTab` + `__subctlShellNotifyTabChange` notifier — the bootstrap loader's contract).
- Two orphaned helpers (`escapeText`, `cssEscape`) and one orphaned const (`SSH_HOST_ALIAS`) preserved per HANDOFF for a future cleanup wave.
- Verdict-transition desktop notifications.

**Migration table — all 14 waves complete:**

- ✅ Wave 1 — Logs zone scaffold + ES-module bridge (commit `81a1a47`)
- ✅ Wave 2 — Templates (commit `f10d2ce`)
- ✅ Wave 3 — Models (commit `b09224c`)
- ✅ Wave 4 — Preferences (commit `c5a3eef`)
- ✅ Wave 5 — Providers (commit `2c9c9d2`)
- ✅ Wave 6 — Vault (commit `27000b5`)
- ✅ Wave 7 — Memory (commit `6597668`)
- ✅ Wave 8 — Skills (commit `d926d58`)
- ✅ Wave 9 — Projects (commit `52e2ae2`)
- ✅ Wave 10 — Settings (commit `44aa618`)
- ✅ Wave 11 — Policy + bridge retirement (commit `e8bbd30`)
- ✅ Wave 12 — Teams (commit `7236f34`)
- ✅ Wave 13 — Orchestration zone (commit `9368ccf`)
- ✅ Wave 14 — **Master chat + chat-adjacent + tool-display + thinking helpers** (this entry; DECOMPOSITION COMPLETE)

**Closing the initiative:** The pre-mortem of 2026-05-12 night flagged `app.js` at 8,955 LOC as the slow-burn risk. Two days of focused waves cut that to 2,280 LOC and produced 14 standalone tab modules (16,016 LOC total across `tabs/*.js`) — each independently testable, each with a clear `{ id, mount, unmount }` interface, each ready for a framework migration if/when one is chosen (HANDOFF 2026-05-13 deferred the framework decision until the per-tab split was done; the split is now done). The decomposition initiative is officially closed; further app.js work is shell-level (state polling, notification tray, Dashboard panel renderers) and tracks separately.

**What we explicitly did NOT do this PR:**
- Did not retire any window bridge. `window.__subctlAttachOneShotAssistantCapture` continues to be the Projects-tab consumer contract; `window.__subctlPushNotification` continues to be the app.js-shell-published notification entry. Bridge retirement is a separate refactor (post-decomp event-bus migration along the wave-11 Policy precedent).
- Did not move `escapeText`, `cssEscape`, or `SSH_HOST_ALIAS` out of app.js even though grep showed they're orphaned post-wave. HANDOFF directive ("STAYS in app.js") honored conservatively; future cleanup wave handles the orphans.
- Did not modify any of waves 1–13's tab modules. `tabs/projects.js`'s read of `window.__subctlAttachOneShotAssistantCapture` is unchanged.
- Did not touch server handlers for `/api/master/*`, `/api/profile`, `/api/master/personality`, `/api/master/events` (SSE), `/api/voice/*`, or `/api/host`. Pure client-side restructure.
- Did not add `unmount()` invocation in bootstrap — same parity stance as waves 1–13.
- Did not split `wireMasterChat` into smaller functions. It's ~1,133 LOC but the contract surface (one SSE consumer + one transcript meter + one slash-command dispatcher + one attachments UI) is genuinely cohesive. A future architectural pass can extract sub-components if the cost feels right; for this wave, fidelity > restructure.

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
