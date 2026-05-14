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

### 2026-05-14 — No Anthropic provider in master (hard guard, four alert channels)

**Decision:** The master daemon hard-fails at `buildModel()` if any role
resolves to `provider: "anthropic"` unless the operator has explicitly set
`SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1` in the launchd plist EnvironmentVariables.
Even when the env var is set, the first model construction per boot fires a
loud alert across four independent channels (`console.error` with
`[ANTHROPIC-API-GUARD]` prefix, `emitNotification` to the dashboard tray,
`sendTelegramOutbound` to the operator's phone, and `logDecision` to
`decisions.jsonl`).

**Why:** Anthropic's 2026-05-13 operator email confirmed that starting
2026-06-15, "Agent SDK and other programmatic usage" — explicitly including
third-party tools built on the Agent SDK — will bill against the new
$200/mo Agent SDK credit, NOT against the operator's Max 20× subscription.
`@earendil-works/pi-agent-core` (master's agent runtime, ADR 0015) is an
Agent-SDK-shaped harness: an agent loop POSTing structured messages with
tool definitions to a chat completions endpoint. By traffic shape alone,
Anthropic will route master's calls to the credit bucket regardless of any
`auth: "max-subscription"` hint. Under master's tick cadence (60s watchdog
+ 60s followup ticker + auto-compact + inbox poll + chat) a day under
moderate load can plausibly burn the entire $200/mo credit, after which
extra-usage charges flow to the operator's payment method without any
further opt-in.

**What landed:**
1. `components/master/providers.json.example` — `fallback: { provider:
   "anthropic", ... }` block stripped. Replaced with a
   `_fallback_removed_2026_05_14` comment that names the policy and points
   at ADR 0019.
2. `components/master/server.ts:buildModel()` — guard throws before pi-ai
   ever sees a Model<anthropic>. Module-level dedup Set so the loud alert
   fires once per provider:model:verdict per boot, not on every role.
3. `Providers` interface in `server.ts` — `escalate` and `fallback`
   marked optional (they were declared required but never read; verified
   in the audit). Existing operator configs that still have these blocks
   continue to parse.
4. `docs/adr/0019-no-anthropic-provider-in-master.md` — full ADR /
   post-mortem covering the discovery, reasoning, alternatives, and open
   questions (auto-nudge / verifier-cluster traffic still on the
   subscription bucket today, OpenRouter example unchanged).
5. `CLAUDE_INVOCATION_AUDIT.md` — branch-level audit of every Claude
   call site in subctl. The audit is what surfaced the landmine.

**Operator-visible behavior change:** if any future config or code path
sets `provider: "anthropic"` on a master role, the daemon now refuses to
boot the agent for that role until `SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1` is
deliberately set. Existing operator configs that don't use the anthropic
provider are unaffected.

**Open follow-ups (not blocking this decision):**
- The OpenRouter alternate-supervisor example still shows
  `"model": "anthropic/claude-sonnet-4"` with `"provider": "openrouter"` —
  bills OpenRouter's marketplace, not Anthropic directly; doesn't trip the
  guard. Worth tightening the example comment in a follow-up.
- Master's auto-nudge / verifier-cluster / `/api/orchestration/:name/msg`
  push HMAC-marked text into running `claude` tmux panes on scheduler
  ticks. Counts against the subscription bucket today. If Anthropic
  reclassifies "scheduler driving an interactive TUI" as Agent SDK use,
  that vector flips overnight. Tracked as Risk Flag F1 in
  `CLAUDE_INVOCATION_AUDIT.md`.

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
