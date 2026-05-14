# HANDOFF.md — session 2026-05-13 night → 2026-05-14 early morning

**Operator:** Jason Brashear
**Hosts:** M3 Ultra (Tailscale 100.84.108.16, LAN 192.168.100.98) + local MacBook (this machine)
**Branch:** `main` @ `c633322` · **Repo:** webdevtodayjason/subctl · **Origin:** in sync

Every claim below is marked **[VERIFIED]** (I observed it tonight) or **[ASSUMED]** (likely true but not directly checked). Don't trust [ASSUMED] without re-checking on next session.

---

## 0. Current state (snapshot 2026-05-14 ~00:00 CDT)

- **`main` HEAD:** `c633322` **[VERIFIED]** (`git log --oneline -1`). Origin in sync — `git push origin main` returned `2b2c515..c633322` after each wave.
- **`dashboard/public/app.js`:** 8,122 lines **[VERIFIED]** (`wc -l`). Was 8,955 at session start. **−833 LOC, 9.3% of the monolith gone in 4 waves.**
- **Daily-driver dashboard (M3? no — local Mac):** running on `:8787` from a NEW location, `~/.local/lib/subctl-install/dashboard/` — a git worktree pinned to `main`. **[VERIFIED]** via `ps -ef` + `curl /api/version`. PID 1473 (the old May-12 v2.7.7-in-memory daemon) is **gone**, replaced by the new PID running c633322.
- **Dev tree at `~/code/subctl`:** on `feat/dashboard-decomp-preferences` branch tip (= same SHA as `main`, harmless leftover label). Future work creates a fresh branch from current HEAD.
- **Local feature-branch sandbox:** killed. `PORT=8788 bun run dashboard/server.ts` was running mid-session for the operator to test wave-1 isolated; that process is no longer needed since merges/deploys flowed through.
- **M3 dashboard:** still at v2.8.5 from the previous session. **[ASSUMED]** — I did NOT update M3 tonight. The infra-split that decouples daily-driver from dev-tree was applied to local Mac only. M3 was untouched. See §2 for the recommended next step there.

---

## 1. What this session shipped

### Dashboard decomposition — recommendation #1 of the 2026-05-12 pre-mortem

4 waves of per-tab module extraction. Plain JS native ES modules, no framework, no build step, no new deps. Each wave was a single worker dispatched via `expert-bun-typescript` + `team_name`. Each wave was committed, merged into main (`--ff-only`), deployed to daily-driver via `launchctl kickstart`, pushed to origin.

| Wave | Tab | LOC | Commit | New thing it proved |
|---|---|---|---|---|
| 1 | Logs | 192 (incl. policy chip) | `3f58f03` | Two entry points + per-stream SSE + cross-tab bridge globals (`__subctlGetPolicyTeams` etc.) for Policy-owned `cachedTeams` |
| 2 | Templates | 122 | `b681255` | Fully isolated extraction — zero bridges, zero shared state — proves the clean case |
| 3 | Models | 111 | `2b2c515` | Trivial confidence win; established the pattern is well-grooved |
| 4 | Preferences | 286 | `c633322` | **Listener lifecycle** — `mount()` installs `document.addEventListener` + `window.addEventListener("focus")`; `unmount()` removes them. The pattern Master chat will need at scale. |

**Architecture artifacts now in place:**

- `dashboard/public/bootstrap.js` — ES-module shell loader. Lazy-imports tab modules via dynamic `import("./tabs/<id>.js")`. Mounts on first activation. Listens for `setActiveTab` notifications from app.js via `window.__subctlShellNotifyTabChange`.
- `dashboard/public/tabs/{logs,templates,models,preferences}.js` — 4 extracted modules. All export `{ id, mount, unmount }`. Logs additionally exports nothing publicly; reads `window.__subctlGetPolicyTeams()`, `window.__subctlRefreshPolicyTeams()`, `window.__subctlRenderAuditEntries()` as temporary bridges (retire when Policy tab extracts).
- `dashboard/server.ts:1601+` — `STATIC_FILES` map registers `/bootstrap.js` + 4 `/tabs/*.js` entries with `application/javascript; charset=utf-8` MIME.
- `dashboard/public/app.js` — IIFE shrunk. Patched `setActiveTab` with `window.__subctlShellNotifyTabChange?.(tab)`. Publishes 3 temporary bridge globals near the Policy tab's `refreshPolicyTeamsForDropdowns` definition.
- `DECISIONS.md` — wave-1 entry captures the architectural calls (module interface, loader strategy, state-ownership ruling for `cachedTeams`, migration order). Subsequent waves added shorter closeout entries.
- `ORCHESTRATION.md` — full ledger of each wave's dispatch + verification gates + decision log + infra split.

### Infrastructure split — daily-driver decoupled from dev tree

Discovered mid-session that the local launchd dashboard plist pointed `ProgramArguments` directly at `/Users/sem/code/subctl/dashboard/server.ts` — the dev tree. ANY branch checkout in that path would change what the daemon would serve on next restart. **No separate install copy existed.**

Operator chose Option A via AskUserQuestion: separate install worktree.

**Executed (operator-authorized):**
1. `git worktree add ~/.local/lib/subctl-install main` **[VERIFIED]**
2. `cd ~/.local/lib/subctl-install/dashboard && bun install` — vendor deps in install tree's `node_modules/` **[VERIFIED]**
3. Backed up plist to `~/Library/LaunchAgents/com.subctl.dashboard.plist.bak-20260513-211858` **[VERIFIED]**
4. `/usr/libexec/PlistBuddy -c "Set :ProgramArguments:2 /Users/sem/.local/lib/subctl-install/dashboard/server.ts"` **[VERIFIED]** — plist now points at install tree
5. `launchctl bootout` + `launchctl bootstrap` **[VERIFIED]** — kills old PID 1473, starts fresh PID running install-tree code

**Loss accepted:** PID 1473's in-memory v2.7.7-era account data is gone. Operator authorized this explicitly. HANDOFF (previous session)'s "don't restart" caveat is now retired.

---

## 2. Deploy flow + next-session infrastructure to-do

### Local Mac deploy flow (now established)

```bash
cd ~/.local/lib/subctl-install
git pull origin main                 # or merge a feature branch
launchctl kickstart -k gui/$UID/com.subctl.dashboard
```

That's it. Daily driver at `:8787` adopts the new code.

To test a feature branch WITHOUT deploying:
```bash
cd /Users/sem/code/subctl
git checkout -b feat/dashboard-decomp-<NEXT>  # or just `git checkout feat/whatever`
PORT=8799 bun run dashboard/server.ts          # browse http://localhost:8799
# Daily driver on :8787 is untouched.
```

### M3 Ultra — same split NOT yet applied

M3's `com.subctl.master` + `com.subctl.dashboard` plists **[ASSUMED]** point at a remote checkout of this same repo. If the operator (or any future session) does branch work on M3, the same lock-in risk recurs there. **Recommended next-session step:** apply the same install-worktree split to M3. The pattern is documented in §2 above.

### Parked follow-ups (in priority order)

1. **`subctl dashboard deploy` CLI verb** — wraps the 3-command deploy flow above. ~30 lines in `lib/cli.sh`. One worker can do this in 10 min after wave-5/6.
2. **M3 infra split** — apply the same install-tree pattern to M3. Slightly involved because operator does it via SSH. Probably a focused session of its own.
3. **`install.sh` patch** — bake the install-tree pattern into fresh installs so this isn't a manual surgery for the next operator who runs `install.sh`. ~50 lines.
4. **Worktree cleanup** — `git worktree list` shows 21+ orphan worktrees from prior sessions (`subctl-v2.7.21`, `subctl-v2.7.24-pi-ai`, etc.). All merged. `git worktree remove <path>` for each. 5-minute hygiene task.

---

## 3. Migration progress + what's next

### Done (4 of 17 tabs)

- ✅ Logs
- ✅ Templates
- ✅ Models
- ✅ Preferences

### Remaining (13 tabs, in migration order)

| # | Tab | LOC | Key consideration |
|---|---|---|---|
| 5 | Providers | 269 | No SSE, no cross-tab. Simple. |
| 6 | Vault | 311 | Exposes `window.openVaultDeepLink` — Projects depends on this. Vault must extract before Projects. |
| 7 | Memory | 278 | Tier1 + main + Evy card sub-functions. Three internal entry points. |
| 8 | Skills | 410 | Exposes `window.__skillsClarityRefresh` (no external reader found, may be dead). Two views (main + clarity). |
| 9 | Projects | 468 | Reads `window.openVaultDeepLink`. Reads + writes `window.__policyPresetsCache` (own cache). |
| 10 | Settings | 528 | Many sub-panels: health, keys, secrets, OAuth, telegram, vault config, personality. |
| 11 | Policy | 609 | **Retires the temporary bridges** (`__subctlGetPolicyTeams`, `__subctlRefreshPolicyTeams`, `__subctlRenderAuditEntries`) when it owns `cachedTeams` and `refreshPolicyTeamsForDropdowns` directly. |
| 12 | Teams | 319 | Mild templates/policy interop. |
| 13 | **Orchestration** + Dashboard-tab panel renderers | 987 + 904 = **1,891** | **Must extract TOGETHER.** Orch installs `window.__subctlOpenTmuxPreview`, `__subctlCopyAttachCommand`, `__subctlOpenWebTerminal`, `__subctlWireWebTerminalGate`, `notice`. Dashboard panels CONSUME those. Both belong in the same wave. Probably 2 workers in parallel coordinating via team task list, OR one big serial wave. |
| 14 | **Master chat** | **1,385** | **LAST.** Biggest, deepest SSE entanglement (master events, voice flag, tool-display config, transcript context meter, chat selectors + profile pill). Reuses the listener-lifecycle pattern from wave 4. |

**Total remaining LOC to extract:** ~5,460. Cumulative drop tonight: 833. If the next sessions hit similar per-wave reductions, the monolith would land somewhere around ~2,500–3,000 lines (the shell: transport, render(state), notification tray, lucide chrome, host-label boot, etc.).

### Next-session first actions (in order)

1. **Verify daily-driver still healthy** — hard-refresh `:8787`, click Logs/Templates/Models/Preferences. All should be functional. Confirm `app.js` is at 8122 LOC (`wc -l ~/.local/lib/subctl-install/dashboard/public/app.js`).
2. **Decide wave-5 target.** Default per migration order: **Providers**. Operator may prefer **Vault** instead (unblocks Projects). Both are ~270-310 LOC, similar effort.
3. **Dispatch wave-5 worker** mirroring the pattern from `c633322` (wave-4 commit). Use `expert-bun-typescript` subagent_type + `team_name="dashboard-decomp"`.
4. **EXPECT silent-idle.** See §5 — workers don't SendMessage report-back even when asked. Self-verify via `git log` + the gate-check script.

---

## 4. Pre-existing dashboard bugs — out of scope, but next session will see them

Operator noted during wave-1 testing that several tabs show errors on local Mac:

- **Templates:** `load failed: Unexpected token 'N', "Not Found" is not valid JSON`
- **Memory:** same SyntaxError shape on the search call
- **Upstreams card:** `master unreachable: Unexpected token 'N', "Not Found" is not valid JSON`
- **Skills tab:** completely empty (all 4 category counts = 0)
- **Preferences:** `load failed: HTTP 404`

**Verified [VERIFIED] via curl on 2026-05-13:** all 5 endpoints return identical 404s on both `:8787` (main) and `:8788` (feature branch). **They are NOT regressions from decomposition.** Root cause: every one of these tabs proxies to a master daemon. Local Mac has no master (master runs on M3). On local Mac, anything that hits `/api/master/*` or `/api/team-templates` (which forwards to master) or `/api/preferences` (master-managed file) returns 404.

**Real fix is the host-aware dashboard story** (HANDOFF previous-session §2.2's multi-host theme). Two options:
- (a) Each dashboard knows the master URL of the host that runs master, and proxies cross-host. Requires multi-host config.
- (b) The dashboard you point at IS the host running master. Local Mac's dashboard becomes "view only" or is killed off entirely.

Either way it's v2.9.0+ scope, sequenced AFTER decomposition completes (so the fix lives in one place per tab rather than one place per concern in a monolith). **Don't chase these errors during decomp** — that's how scope creep happens.

---

## 5. Worker silent-idle protocol — important observation

**All 4 workers** dispatched this session (`logs-extract`, `templates-extract`, `models-extract`, `preferences-extract`) — all subagent_type `expert-bun-typescript` — completed their work, committed, and then went idle **without sending the structured SendMessage report-back** that the dispatch spec explicitly demanded.

Verified by:
- Each worker's branch had a clean commit when I checked git log
- Each worker's deliverables passed every verification gate I ran
- The team task list showed tasks as pending (they didn't update via TaskUpdate either)

**This is consistent.** It's not a one-off. Either:
- `expert-bun-typescript` doesn't have SendMessage in its tool list, OR
- The agent body skips SendMessage even when it's available, OR
- Some other systemic reason

**Operational implication:** **assume idle == complete-but-silent.** Always self-verify by `git log` on the feature branch. Run gates directly. Don't wait for a report that won't come.

**Next-session investigation (low priority):**
- Check `~/.claude/agents/expert-bun-typescript.md` for available tools
- Compare to `general-purpose` agent (which presumably does send messages)
- Consider switching dispatch subagent_type to one that reliably sends report-backs, OR
- Just codify "self-verify after idle" as the standing pattern

---

## 6. Loose ends + things I deliberately did NOT do

- **No HANDOFF carry-over of pre-mortem text.** The 2026-05-12 pre-mortem (in git history at HANDOFF.md commit `dd958ba`) identified app.js as the slow-burn risk. That's been actioned — 4 waves done, 13 to go. No need to keep re-quoting it; the migration plan IS the response.
- **No `subctl dashboard deploy` CLI verb yet.** Parked as follow-up §2.
- **No M3 deploy.** M3 daemons remain on previous-session state. Operator authorized push-to-origin so M3 *can* pull, but I didn't issue the M3-side update.
- **No vault update.** The `obsidian-vault` skill triggered earlier but I didn't update `/Users/sem/Documents/Obsidian Vault/Subctl/`. Operator's "stop, write HANDOFF, close" took priority. Vault sits at the previous session's state.
- **No worktree cleanup.** 21+ orphans still on local Mac.
- **No browser UX verification of the merged wave-4 state.** Operator visually tested wave-1 on `:8788` and confirmed Logs worked. For waves 2/3/4 we relied on structural gates + live MIME smoke + curl. The operator should hard-refresh `:8787` and click through Logs/Templates/Models/Preferences at next sit-down to confirm the deployed state is clean.

---

## Surprising facts worth remembering

1. **The local launchd dashboard literally read from `~/code/subctl/dashboard/server.ts`** at session start — the dev tree. Any branch checkout would have changed daily-driver behavior on next restart. The infra split documented in §2 fixes this. **Same pattern almost certainly exists on M3.**
2. **PID 1473's in-memory state is gone.** The "don't restart" caveat from previous HANDOFF was honored until the operator authorized the infra-split switchover. That long-running daemon is no longer a reference; the new daemon at `c633322` is.
3. **The dev tree is currently labeled `feat/dashboard-decomp-preferences`** because git worktree-per-branch enforcement blocked the switch back to `main`. SHA is identical to main; harmless. Next-session can `git checkout -b feat/dashboard-decomp-<NEXT>` from there.
4. **3 temporary `window.__subctl*` bridge globals** live in app.js (the Logs ↔ Policy cross-cut from wave 1). They retire when Policy extracts (wave 11). Don't audit them out before then — they're load-bearing.
5. **`expert-bun-typescript` workers silent-idle after commit.** See §5.
6. **`bun install` in `~/.local/lib/subctl-install/dashboard/` is required** before the install tree can serve. Already done this session. Future deploys via `git pull` will need a re-`bun install` only when `dashboard/package.json` changes.
7. **Cron loop `d7420c37`** (10-min status pings during wave-1) was cancelled mid-session; no active session loops.
8. **Plist backup at** `~/Library/LaunchAgents/com.subctl.dashboard.plist.bak-20260513-211858`. Rollback restores dev-tree-pointing but does NOT restore PID 1473's in-memory state (that's permanently gone).

---

*Generated 2026-05-14 ~00:00 CDT by Claude Opus 4.7. Session length ~4.5 hours. Operator engaged throughout; no autonomous-mode used.*
