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
