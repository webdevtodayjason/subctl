# HANDOFF.md — session 2026-05-12 night → 2026-05-13 evening

**Operator:** Jason Brashear
**Hosts:** M3 Ultra (Tailscale 100.84.108.16, LAN 192.168.100.98) + local Mac (this machine)
**Branch:** main · **Last tag:** `v2.8.5` · **Repo:** webdevtodayjason/subctl

Every claim below is marked **[VERIFIED]** (I observed it tonight) or **[ASSUMED]** (likely true but not directly checked). Don't trust [ASSUMED] without re-checking on next session.

---

## 1. Repo + deployment state

### Versions shipped tonight

23 versions plus a hotfix. All on `main`, all tagged, all pushed to `origin`. **[VERIFIED]** via `git tag -l 'v2.7.*' 'v2.8.*'`.

| Tag | Subject |
|---|---|
| v2.7.18 | Supervisor profiles (chat/heavy) — TOML config, dashboard pill, Telegram `/profile`, hot-swap on next prompt |
| v2.7.19 | Watchdog kill controls + empty-listener circuit breaker (the fix for the 90-min Telegram hang) |
| v2.7.20 | HMAC trust marker — ADR 0011 Layer 1 |
| v2.7.21 | Web terminal escape hatch — ADR 0011 Layer 2 (xterm.js + node-pty) |
| `0d3ba69` | hotfix: dashboard reads VERSION on every render |
| v2.7.22 | Notification channel + auto-nudge + auto-compact fix |
| v2.7.23 | Evy Memory (Tier 3) — SQLite + FTS5 |
| v2.7.24 | pi-ai + pi-agent first-class upstreams; dynamic provider catalog (32 providers) |
| v2.7.25 | Lucide icons + notification UX (broken — see §2.1) + upstream-tracker watchdog |
| v2.7.27 | tinyfish_agent — third TinyFish surface |
| v2.7.28 | subctl CLI bootstrap (status / logs / deploy / notif / memory) |
| v2.7.29 | Plan-approval workflow (dashboard + telegram) |
| v2.7.30 | Evy eval suite refresh — 40 tests total |
| v2.7.31 | 1Password Service Accounts (multi-backend secret resolution) |
| v2.7.32 | Cleanup bundle — watchdog reconciliation, CLI PATH, tmux SSH, /health cleanup, stale-team gc, CHANGELOG sort |
| v2.7.33 | Skill bundles + agent definitions baseline (5 SKILL.md + 5 agent personas) |
| v2.7.34 | Operator-facing Policy UI (preset button, chip-list, editors) |
| v2.7.35 | Watchdog dashboard surface (full /diag integration) |
| v2.7.36 | CLI expansion — team / config / profile subcommands |
| v2.7.37 | Upstream auto-update automation (gated behind flag file) |
| **v2.8.0** | **MAJOR**: team templates + voice/TTS layer (VoxCPM2) |
| v2.8.1 | Templates tab route fix |
| v2.8.2 | Notification UX + watchdog reconciliation + complete team-kill flow + operator preferences + chat latency telemetry + skill router + thinking-indicator |
| v2.8.3 | Accounts surface regression fix (incomplete — see §2.2) |
| v2.8.4 | Skills tab clarity + Evy-authored skills visibility + live-log reverse |
| v2.8.5 | **CSS fix** for notification dropdown — adds `.notif-tray[hidden] { display: none }` (the JS handlers were correct since v2.7.25; CSS specificity was the actual bug) |

Plus voice-layer fixes after v2.8.0: `2262168` (real VoxCPM 2.x API), `7bc5ddf` (v1 vs v2 model dispatch), `5c2298f` (macOS `say` system backend), `861057c` (48kHz WAV header for VoxCPM2 output).

### Deployment

| Host | Service | Version | Notes |
|---|---|---|---|
| M3 | `com.subctl.master` | **v2.8.4** | uptime ~4.3h as of 6:05 PM CDT. **[VERIFIED]** via `/health`. Did NOT restart for v2.8.5 (CSS-only) since master code didn't change. |
| M3 | `com.subctl.dashboard` | **v2.8.5** | restarted at end of session for CSS fix. **[VERIFIED]** via `/api/version`. |
| M3 | `com.subctl.tts` | running (voxcpm backend) | port 8789, VoxCPM2 model + reference WAV in place. Cloned voice synthesis verified working end-to-end. **[VERIFIED]** by listening to `/Users/sem/code/subctl/tmp/evy-cloned-http.wav`. |
| Local Mac | `com.subctl.dashboard` PID 1473 | **shows v2.8.0 from disk, but in-memory code is from when daemon started 2026-05-12 1:45 PM (pre-v2.7.18 generation)** | Operator's screenshots of "real account data" came from this daemon. Don't restart it — it's the only working reference for what the dashboard SHOULD look like. **[VERIFIED]** via local `launchctl list` + `ps -ef`. |

### Worktrees on local Mac

```
/Users/sem/code/subctl                                  → main (v2.8.5)
/Users/sem/code/subctl-v2.7.21                          → feat/v2.7.21-web-terminal (orphan — predates ship pattern)
/Users/sem/code/subctl-v2.7.24-pi-ai                    → v2.7.24-pi-ai-catalog (orphan)
/Users/sem/code/subctl-v2.7.27-tinyfish-agent           → orphan
/Users/sem/code/subctl-v2.7.28-cli                      → orphan
/Users/sem/code/subctl-v2.7.29-plan-approval            → orphan
/Users/sem/code/subctl-v2.7.30-eval-refresh             → orphan
/Users/sem/code/subctl-v2.7.31-1password                → orphan
/Users/sem/code/subctl-v2.7.32-cleanup                  → orphan
/Users/sem/code/subctl-v2.7.33-skills                   → orphan
/Users/sem/code/subctl-v2.7.34-policy-ui                → orphan
/Users/sem/code/subctl-v2.7.35-watchdog-dashboard       → orphan
/Users/sem/code/subctl-v2.7.36-cli-expansion            → orphan
/Users/sem/code/subctl-v2.7.37-upstream-auto            → orphan
/Users/sem/code/subctl-v2.8.0-team-templates            → orphan
/Users/sem/code/subctl-v2.8.0-voice                     → orphan
/Users/sem/code/subctl-v2.8.1-accounts-data-fix         → orphan
/Users/sem/code/subctl-v2.8.1-chat-perf                 → orphan
/Users/sem/code/subctl-v2.8.1-notif-watchdog-fix        → orphan
/Users/sem/code/subctl-v2.8.1-prefs                     → orphan
/Users/sem/code/subctl-v2.8.1-skills-clarity            → orphan
/Users/sem/code/subctl-v2.8.1-templates-route           → orphan
```

**[VERIFIED]** via `git worktree list`. All shipped + tagged + merged. Next session should clean these up with `git worktree remove` before they accumulate.

Two workers were SHUTDOWN mid-flight at end of session due to the architecture pivot:
- `path-routing-impl` on `v2.8.6-path-routing` — never committed, no worktree to clean
- `skills-redesign-impl` on `v2.8.6-skills-redesign` — never committed, no worktree to clean

---

## 2. Three open issues

### 2.1 Notification dropdown — STATE UNCERTAIN

- **What was supposed to happen:** v2.7.25 shipped a dropdown with X buttons, mark-all-read, click-outside, ESC handling. JS handlers were correct (**[VERIFIED]** by reading lines 7975-8024 of app.js).
- **What actually happened:** CSS rule `.notif-tray { display: flex }` (line 4381 of style.css) had higher specificity than the UA default `[hidden] { display: none }`. So setting `tray.hidden = true` did nothing visually. **[VERIFIED]** by inspection.
- **The v2.8.5 fix:** Added `.notif-tray[hidden] { display: none }` at higher specificity. **[VERIFIED]** the rule is now in the served CSS on M3 via `curl /style.css | grep`.
- **[ASSUMED]** — hard-refresh in operator's browser will pick up the new CSS and the dropdown will behave correctly. Operator hadn't confirmed this at end of session.
- **If still broken:** the JS may be removing the `hidden` attribute somewhere unintentionally, OR there's another CSS rule overriding. Check first: in DevTools, inspect `#notif-tray`, see whether the `hidden` attribute is present and what the computed `display` value is.

### 2.2 Accounts shows all zeros on M3 — UNFIXED, ARCHITECTURALLY UNCLEAR

- **The v2.8.3 worker SHIPPED** what they claimed was a fix (`fix(dashboard,master): v2.8.1 Accounts surface — real per-account usage + correct dispatch verdict`). **[VERIFIED]** their commit is on main.
- **The fix did not actually fix it.** **[VERIFIED]** by inspecting M3's `/api/state` response — every account returns `usage: null`, `active_sessions: 0`, `last_activity_seconds_ago: null`, `dispatch: green`.
- **Partial data IS present**: `usage_history_24h` is populated with samples per hour (`five_hour_max: 5, samples: 12` for claude-jason). **[VERIFIED]** in the same response.
- **[ASSUMED] hypothesis:** Account usage tracking happens on the host where Claude Code is actually run. M3 hosts master + dashboard daemons but doesn't run Claude Code itself — that's local Mac. So M3 sees no `usage` because no usage happens on M3 against those accounts. **This is unconfirmed** — need to check where the dashboard actually reads `usage` from (`subctlUsageFetchAll`, `readUsageHistory24h`, etc., in dashboard/server.ts lines 1495-1497). I started reading `buildState()` at end of session but didn't trace the data source.
- **If hypothesis correct:** Multi-host dashboard is required. Operator runs subctl across M3 + local + Mac Minis + Studio + DGX. Each host has partial truth. Dashboard needs aggregation. This is a v2.9.0+ feature, not a quick fix.
- **If hypothesis wrong:** There's a regression in the usage-fetch path. Diff `v2.7.7..main` on `dashboard/server.ts` `subctlUsageFetchAll`-related code.

### 2.3 OSINT alerts firing every 30 min on Telegram — UNFIXED, CALLBACK NOT WIRED

- **The v2.8.2 reconciliation logic exists** in `components/master/auto-nudge.ts` lines 168-198. **[VERIFIED]** by reading the file.
- **It's opt-in.** The reconciliation only runs if `opts.callbacks.teamRegistryExists` is passed. Comment on line 165: *"Predicate is opt-in via callbacks.teamRegistryExists; omitting it preserves pre-v2.7.32 behavior."* **[VERIFIED]**.
- **`server.ts` may not be passing the callback.** I grep'd for `teamRegistryExists` and didn't find a usage in server.ts. **[ASSUMED] but high-confidence — this is almost certainly why OSINT alerts keep firing.** Did NOT verify the server.ts call site directly because the session pivoted to the pre-mortem.
- **Operator force-cleared** at 1:34 PM CDT today by moving `~/.local/state/subctl/audit/claude-osint-cve-monitor.jsonl` → `audit/.killed/`. **[VERIFIED]** by `ls` showing it in `.killed/`. But Telegram alerts continued to fire afterward (4:23 PM, 4:53 PM, 5:23 PM, 5:53 PM screenshots **[VERIFIED]** by operator) — meaning either the data source isn't the audit log, OR master is reading from somewhere else.
- **`killed-teams.json` does NOT exist** at `~/.local/state/subctl/master/killed-teams.json` despite the v2.8.2 worker's spec saying it would. **[VERIFIED]** via `ls`. So the persistent "killed teams set" the worker spec described was never created. Either the worker didn't implement that part, OR the path is different, OR it's created lazily and was never triggered.
- **Fix for next session:** trace where the team-staleness tracker is seeded from in master. Likely from tmux sessions OR inbox JSONL files at `~/.config/subctl/master/inbox/<team>.jsonl`. If from inbox, archive THAT path too. AND wire the `teamRegistryExists` callback through the server.ts → sweep() call site.

---

## 3. Pre-mortem findings (verbatim from session)

> **Scenario**: It's 6 months from now. The dashboard has been declared unmaintainable and you're rewriting it from scratch. Looking backwards, here's what killed it.

**1. `app.js` crossed 15,000 lines and Cmd+F became the IDE.** Already at 8,955. Three workers add features → it grows fast. By month 2 nobody (operator, you, or any AI worker) can hold the architecture in their head. New features start regressing old ones because workers can't read the whole file before editing. *Tonight already showed symptoms*: notification dropdown CSS issue went undetected for 5+ ship attempts because the bug spanned JS + HTML + CSS in three different sections.

**2. State management collapse.** Every tab fetches `/api/state` (which builds the entire fleet snapshot). When operator opens Accounts + Skills + Orchestration tabs in quick succession, three concurrent fetches race. Results get rendered out-of-order. Numbers flicker. Worse: localStorage / sessionStorage / window globals all hold state independently. By month 3 you have stale read-after-write bugs you can't reproduce.

**3. CSS specificity wars.** `style.css` is ~5,000 lines. Every new feature adds rules. By month 4, adding a button somewhere creates a CSS conflict with three other elements. Workers add `!important` to "fix" it. The whole stylesheet becomes a `!important` graveyard. The notification dropdown bug (`display: flex` beating `[hidden]` UA default) is exactly this category, just earlier in the cycle.

**4. The "32-provider list" mistake replicates everywhere.** Pattern: render the universe, let the user filter mentally. Skills tab: 4 sections of loading lists. Providers: 32 cards. Templates: every stock template. Settings: every key. Each new feature ships in this same anti-pattern because there's no design system saying "use cards, not lists" — so workers default to `<ul>` because it's faster. By month 5 the dashboard is "Bun-rendered Wikipedia."

**5. Tab-switching is a JS-level lie.** `data-tab` attribute toggling means: refresh resets to default, can't bookmark, can't share a screen URL with a teammate, can't right-click → open in new tab. Operator hit this tonight. Workaround attempts pile up (vault tab's `#vault?...` hash routing) creating internal inconsistency.

**6. "Evy says X, dashboard shows Y" trust collapse.** Operator just saw it tonight: Evy claimed to have authored skills. Dashboard correctly shows zero. Audit log shows no `evy_author_skill` calls. **The dashboard is more truthful than Evy.** That's a feature — but it means the dashboard becomes the source of truth, which makes its bugs catastrophic. If "Accounts shows zero" stays unfixed, operator stops trusting *all* numbers. Once trust is gone, the dashboard is just decoration.

**7. The local-vs-M3 dashboard fork.** Operator's local dashboard (v2.7.7-era code, running 24h continuously) shows real account data. M3 dashboard (v2.8.5) shows zeros. *Same code, different machines, different truth.* This is because account usage is tracked where the work happens, and M3 isn't where it happens. The dashboard wasn't designed multi-host. Eventually operator runs `subctl` on 3+ machines (M3, M2 Studio, MacBook, DGX) and each shows partial truth. Architecture didn't anticipate it. Now it has to.

**8. Migrations get blocked by "works for now."** Every time someone says "this is getting bad, let's restructure" the answer is "but it works, let's just add this one more thing first." Tonight already shipped 30+ versions. Every patch makes the monolith heavier and the eventual migration harder. The cost compounds.

**9. Workers can't help anymore.** Tonight's notif-watchdog-fix worker shipped a "fix" that had architectural gaps because they didn't read every relevant file (CSS specificity was missed despite being the bug). At 8,955 lines, even careful workers regress things. Solution becomes "more careful workers" which doesn't scale. The real solution is smaller files.

**10. Single-process Bun crash takes everything down.** Dashboard, master, TTS are three launchd processes. Good. But the dashboard itself is one process. A bad render path crashes it → operator sees "offline" → restart launchd. Tonight already happened ("status: offline" in screenshot was probably this — though master was alive on `/health` recheck, so likely a render-side fetch failure, not a crash).

> ### What it didn't kill
>
> - **Bun choice is fine.** Fast, integrates well, good DX. Don't rewrite the server runtime.
> - **TS choice is fine.** Type system catches bugs.
> - **Vanilla-frontend choice was probably right at the start.** No framework lock-in. But the cost is now real.

---

## 4. The architectural decision we did NOT make tonight

**Frontend technology** for the migration. Options on the table:

- Svelte + SvelteKit (component model, small bundle, file-based routing)
- HTMX + server-rendered partials (smallest, keeps Bun-server-side authority)
- React + Vite (most ubiquitous, more workers can write it)
- Stay vanilla but split per-tab (least leap, most discipline cost)

**Why we deferred:** Operator chose "B — kill both workers, re-plan everything" then interrupted before approving a framework. The pivot from "ship monolith fixes" to "plan the migration" happened ~6:15 PM. Pre-mortem was the last meaningful work of the session. Framework choice + migration strategy decisions cascade hard — choosing wrong locks subctl into a long migration. Operator (correctly) wanted to think rather than answer it tired.

**What was queued but not chosen:**

| Decision | Options not selected |
|---|---|
| Migration strategy | Strangler fig (recommended in proposal) / Big bang rewrite / Per-tab branch+ship |
| Server-side approach | Keep Bun + split routes (recommended) / Keep monolith server.ts / Move to Hono or Elysia |
| First session output | Just the migration ADR / ADR + first scaffolding PR / ADR + one tab migrated as reference |

These all need answers next session before any migration code is written.

---

## 5. What next session should do FIRST

In order. Don't skip.

### Step 1: settle the framework choice (15 min)

Ask the 4 questions from the AskUserQuestion that was queued at end of session. Operator was ready to answer 2 of 4 (path routing over hash) before the pivot — the remaining 2 (framework + migration strategy + server-side + tonight's scope) need fresh answers. Spend the time before writing any code.

### Step 2: write ADR for the migration

Numbering follows the existing ADR index (`docs/adr/README.md` — last one used was 0018 for operator preferences). Title: `ADR 0019 — dashboard monolith migration to <framework>`. Document:
- Pre-mortem findings (link to this HANDOFF.md or copy verbatim)
- Framework choice with rationale
- Strangler-fig phases: which tab moves first, in what order, what stays in old monolith
- File-layout decision (`dashboard/v2/...`? `dashboard/web/...`?)
- Routing decision (path vs. hash)
- Build/dev-server decisions
- How old-monolith + new-stack coexist in production (port? path prefix?)

### Step 3: pick ONE tab to migrate as the reference implementation

Recommend Skills (it's broken anyway, operator was about to redesign it tonight, simpler than Orchestration). Migrate end-to-end including server-side. This becomes the template every other tab migration copies.

### Step 4: BEFORE step 3 actually starts, address the three open issues

The dashboard is being used right now. Operator will encounter the three issues during normal use. Address them so the migration isn't competing with active bug pain:

- **2.1 notification dropdown:** confirm v2.8.5 hard-refresh resolves it. If not, deeper bug.
- **2.2 accounts zeros:** trace the usage-fetch path in `buildState()` (dashboard/server.ts:1476+). Identify whether it's a regression OR architectural (multi-host). Tell operator the truth before they re-experience it.
- **2.3 OSINT alerts:** trace where master seeds the team-staleness tracker. Wire `teamRegistryExists` callback. Add `claude-osint-cve-monitor` to a persistent killed set so the alerts stop on the next master restart.

### Step 5: housekeeping

- Clean up 20+ orphan worktrees with `git worktree remove`. **[VERIFIED]** all branches merged.
- Verify M3 + local both on the latest version
- Consider rotating LM Studio token (operator said it was disabled earlier today — verify)

### Step 6: separate but adjacent

The session shipped a real working voice clone (v2.8.0 voice layer). Operator confirmed audio "sounds okay" but the voice quality / pitch wasn't dialed in beyond that. If operator wants to refine the cloning (different reference WAV, different model settings, denoise, etc.), that's a separate v2.8.x patch line — not part of the dashboard migration.

---

## Surprising facts worth remembering

1. **VoxCPM2 emits 48kHz audio**, not 16kHz. The reference WAV must be 16kHz mono. The OUTPUT WAV header must be 48kHz. We learned this the hard way when first cloned audio played 3× slow.
2. **`@earendil-works/pi-ai` and `@mariozechner/pi-ai` are forks of the same project** by Mario Zechner. earendil-works is the canonical upstream we follow; mitsuhiko/pi-mono was a red herring (separate fork by a different author, unrelated).
3. **Master is on v2.8.4, dashboard is on v2.8.5** — they're separate processes. CSS-only fixes ship by restarting the dashboard service only.
4. **`subctl team kill` (v2.7.36) does NOT archive the audit log** — only the team registry dir. This is why OSINT alerts persisted: archiving the dir wasn't enough.
5. **Evy can claim things in chat that the dashboard knows are false.** The audit log is more truthful than her replies. When operator says "Evy said X", verify against `/api/state` or audit JSONL before believing.
6. **The `evy_author_skill` master tool exists** at `components/master/tools/skill-author.ts` but Evy has NOT actually invoked it tonight. The path `~/.config/subctl/skills/master/skills/` doesn't exist on M3 — there are zero Evy-authored skills despite her conversational claims.
7. **24 hours of dashboard daemon uptime on local Mac** — the in-memory code is from BEFORE this session's work started. That dashboard is showing v2.7.7-era data flow which is why operator's local-screenshot accounts data is "real" while M3's is zero.

---

*Generated 2026-05-13 ~6:30 PM CDT by Claude Opus 4.7. Operator interrupted before final framework choice — see §4 for what was on the table.*
