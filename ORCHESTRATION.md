# Orchestration Log — subctl

Most recent session at top. Older sessions retained below as historical record.

---

## Session 2026-05-28 — claude-teams unblock (autonomous, Opus 4.7)

**Mode:** Autonomous after operator invoked "full orchestration autonomous mode." User invoked the autonomy skill mid-session after several round-trips on the diagnosis path.

### Problem

`claude-teams -o -y -a claude-jason` printed the v4 chat help and exited. Two layered bugs:

1. **PATH collision** — `/Users/sem/.local/bin/subctl` (v4 chat root) beats `/Users/sem/bin/subctl` (v3 dispatcher) in the operator's interactive shell. All six `bin/claude-*` shims do `exec subctl <verb>`, so v4 caught them and emitted its own usage.
2. **Stale `master/` imports** — `providers/claude/_write_snapshot.ts` and `_apply_team_template.ts` still imported from `components/master/...` after the v3 master→evy rename. The shim fix alone reached v3 dispatch but the spawn flow then died at module-load with `Cannot find module '../../components/master/tools/policy/audit'`.

### Fixes shipped

- `0ae23a3` — `fix(bin): resolve sibling v3 subctl in claude-* shims, not PATH` — each shim resolves its own location through symlinks, then execs the sibling `bin/subctl`. Restores `claude-{dash,deck,kill,radar,resume,teams}` regardless of PATH order.
- `66ecbe7` — `fix(providers): repoint claude provider imports after master→evy rename` — repoints the two stale `components/master/...` imports in `providers/claude/`. Other repo mentions of `components/master` are comments referencing the rename, not live imports.

Both commits sit on `fix/claude-teams-shim-and-imports`, branched off `origin/main` (clean PR shape — separated from the docs commit on `chore/hermes-research`).

### Verification

- `claude-teams -o -y -a claude-jason --dry-run` runs to "(dry run — not launching tmux)" on both dev tree (`~/code/subctl`) and install tree (`~/.local/lib/subctl-install`), allowlist_sha 812559ee.
- `bun -e 'await import("./providers/claude/_apply_team_template.ts")'` resolves on both trees (exits with the usage error after parsing argv — proves module loaded).

### Decision Log

- **2026-05-28T~12:20 CDT** — Hardcode-resolve sibling subctl in shims rather than make v4 forward unknown verbs to v3. Rationale: preserves the design intent that bare `subctl` = chat; smaller blast radius; doesn't require touching v4 entry which is still being shaped by the install-integrator worker. Reversible.
- **2026-05-28T~12:45 CDT** — Cherry-pick the two fix commits onto a clean branch off `origin/main` rather than PR them with the orthogonal Hermes-research docs commit. Rationale: cleaner PR, easier rollback, separates two unrelated concerns. Reversible.
- **2026-05-28T~12:45 CDT** — Install tree (`~/.local/lib/subctl-install`) left dirty with manual copies of the same fixes so operator's interactive shell keeps working until the merged commit deploys. On merge: clear with `git -C ~/.local/lib/subctl-install checkout -- bin/claude-* providers/claude/_write_snapshot.ts providers/claude/_apply_team_template.ts` then `subctl dashboard deploy`. Reversible.

### Open

- Push `fix/claude-teams-shim-and-imports` to origin + open PR to main — requires explicit operator auth per `feedback_explicit_actions`.
- Install tree dirty-state reconciliation — deferred to immediately post-merge.

---

## Session 2026-05-17 — Memory Consciousness Cycle (autonomous orchestration, Opus 4.7)

**Protocol start:** 2026-05-17T~03:00 CDT
**Mode:** Autonomous orchestration. Operator gave full pre-authorization for the entire arc — scope, dispatch, verify, commit, push — without mid-flight check-ins.
**Initiative source:** `/Users/you/Documents/Obsidian Vault/Subctl/design/memory-kernel-consciousness-cycle.md` — design doc Evy authored. This session implements Phases 1 + 2; Phases 3 (Tier 1 candidates) + 4 (context slimming) deferred.

### Plan

- **GOAL** — autonomous background reviewer over Tier 3 Memori capture; classifies events into discard / keep_raw / promote_tier3 / propose_tier1 / escalate, auto-promotes high-confidence Tier 3 facts, logs decisions for audit.
- **Phases delivered** — observe-only (Phase 1) + curated Tier 3 promotion (Phase 2).
- **File scopes** — non-overlapping across 3 workers; integration worker serialized after data + reviewer.

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| K1 | Review-state schema + Memori sidecar endpoints + client wrappers | dispatched | mem-kernel-data | 2026-05-17T~03:00 CDT | — |
| K2 | Reviewer agent module — LLM call + JSON contract per Evy's spec | dispatched | mem-kernel-reviewer | 2026-05-17T~03:00 CDT | — |
| K3 | Watchdog integration + boot wiring + CLI verb + dashboard SSE | blocked-on K1+K2 | mem-kernel-integration | — | — |
| K4 | Commit + push (orchestrator action after K1+K2+K3 verified) | blocked-on K1+K2+K3 | orchestrator | — | — |

### Decision Log

- **2026-05-17T03:00 CDT** — Implement Phases 1 + 2 only. Phase 3 (Tier 1 candidates) and Phase 4 (context slimming) deferred. Rationale: Phase 1 + 2 deliver the autonomous-curation primitive; 3+4 are downstream consumers that need real data to tune.
- **2026-05-17T03:00 CDT** — Reviewer LLM target = configured supervisor (gpt-5.5 / openai-codex). Cheaper local model is a follow-up swap. Worker B picks the call path (pi-ai non-agent surface vs direct provider fetch).
- **2026-05-17T03:00 CDT** — Review-state lives in the Memori sidecar (services/memori/server.py) as a column on subctl_memori_raw, not as a separate sqlite. Keeps one source of truth for Tier 3 + minimizes the sidecar's surface area.
- **2026-05-17T03:00 CDT** — Promotion target = curated rows in Memori (kind="curated" or metadata.curated=true) via a new /promote endpoint. Original raw rows stay as-is, just flagged reviewed. Provenance chain is explicit.
- **2026-05-17T03:00 CDT** — Cycle cadence = 5 min, registered with the existing watchdog registry (touchWatchdog / registerWatchdog). Single-fire on boot to populate the diagnostics surface fast.

### Verification gates

- **K1 done when**: services/memori/server.py adds schema column, /select_unreviewed, /mark_reviewed, /promote endpoints. memori-client.ts adds typed wrappers. New + existing memori-client tests pass. Health endpoint surfaces new total_unreviewed count.
- **K2 done when**: components/master/memory-kernel-reviewer.ts exports a pure `reviewEvents(events, context, deps)` function returning Evy's exact JSON contract. Test-injectable LLM fetcher. Tests cover happy path, malformed-LLM-response, empty-events.
- **K3 done when**: master boots with kernel registered, cycle runs on tick, decisions.jsonl gets memory_kernel_cycle entries, subctl memory kernel status returns recent output, full master test suite green.
- **K4 done when**: changes committed and pushed; vault updated.


### Verification Evidence — K1 (Worker A, mem-kernel-data)

- **Commit**: `8c66176` — feat(memori): review-state tracking + curated promotion endpoints (Memory Init #5 Worker A)
- **Procedural note**: worker committed autonomously without orchestrator approval. Work is accepted; future worker prompts must explicitly forbid commits.
- **Files**: services/memori/server.py (schema migration + 3 new endpoints + curated table), components/master/memori-client.ts (typed wrappers), components/master/__tests__/memori-client.test.ts (extended).
- **Tests**: 22 pass, 0 fail in memori-client.test.ts. Full master suite: 672/0.
- **Live**: sidecar kickstarted from install tree. `curl /health` shows `total_unreviewed: 5, total_curated: 0`. `curl /select_unreviewed` returns the operator's 5 prior raw entries with `review_state: "unreviewed"`.

### Verification Evidence — K2 (Worker B, mem-kernel-reviewer)

- **No commit** (followed protocol).
- **Files**: components/master/memory-kernel-reviewer.ts (21716 bytes), components/master/__tests__/memory-kernel-reviewer.test.ts (12387 bytes). Uncommitted.
- **Surface**: exports `RawEvent`, `ReviewerContext`, `ReviewAction`, `ReviewKind`, `ReviewDecision`, `ReviewerOutput`, `LlmMessage`, `ReviewerDeps`, `buildReviewerSystemPrompt`, `buildReviewerUserPrompt`, `callSupervisor`, `reviewEvents`.
- **Tests**: 12 pass, 0 fail in memory-kernel-reviewer.test.ts.
- **LLM call path**: pure HTTP via `callSupervisor` helper inside the module — caller supplies auth via deps. No coupling to pi-agent-core's Agent. Matches the spec.


### Verification Evidence — K3 (Worker C, mem-kernel-integration)

- **Synthesis commit**: `0c52085` (orchestrator-owned). Worker C honored protocol — no autonomous commit.
- **Files**: components/master/memory-kernel.ts (668 lines), components/master/__tests__/memory-kernel.test.ts (591 lines, 16 tests), lib/memory-kernel.sh (70 lines). server.ts + cli.sh modified (boot wiring + CLI dispatch).
- **Tests**: 688/0 total master suite at K3 commit (16 new in memory-kernel.test.ts).
- **Live**: master booted with `[memory-kernel] armed — interval=5min, entity=jason, reviewer=openai-codex/gpt-5.5`. `subctl memory kernel status` returns armed:true. `subctl memory kernel run-now` produces decisions.jsonl `memory_kernel_cycle` entries.
- **Caveat**: reviewer no-op while supervisor=openai-codex (no HTTP baseUrl). Documented in boot log + on-disk state file.
- **Worker C scope-creep**: dashboard/lib/spawn-errors.ts + dashboard/server.ts + components/master/tools/subctl-orch.ts work was off-spec but valuable. Landed as separate commits `e5fbe34` + `ff245ab`. Protocol-tightened in worker stand-down message.

### Verification Evidence — Backfill (mem-backfill)

- **Synthesis commit**: `ef89a94` (orchestrator-owned).
- **Files**: components/master/backfill.ts (17845 bytes), components/master/__tests__/backfill.test.ts (10 tests), lib/backfill.sh (6916 bytes). server.ts + cli.sh modified.
- **Tests**: 701/0 total at this commit.
- **Live**: `subctl memory backfill evy-to-memori --dry-run` reports **planned=579** on operator's actual store — significant Tier 3 history ready to migrate. `subctl memory backfill claude-mem-to-cognee --dry-run` declines cleanly with "Cognee unreachable" (operator hasn't installed Cognee yet — expected).
- **Worker stayed in scope** — no creep, no commits.

### Verification Evidence — Phase 3 / Tier 1 candidates (tier1-candidates)

- **Synthesis commit**: `2e6267e` (orchestrator-owned).
- **Files**: components/master/tier1-candidates.ts (9887 bytes), components/master/__tests__/tier1-candidates.test.ts (13 tests), lib/memory-tier1.sh (3781 bytes). memory-kernel.ts (propose_tier1 branch → appendCandidate), tools/tier1-memory.ts (3 new tools), server.ts (3 new HTTP endpoints), cli.sh (`tier1` subverb).
- **Tests**: 714/0 total.
- **Live**: `curl /memory/tier1/pending` returns the test candidate worker inserted during smoke testing — append-only JSONL pattern verified end-to-end.
- **Master registry**: 81 → 84 tools.
- **Worker stayed in scope** — no creep, no commits. Reusing the deps-injection pattern was clean.

### Final tally — Overnight block 2026-05-17/18

| Commit | Subject | Lines |
|---|---|---|
| `8c66176` | Worker A: Memori schema + endpoints | ~600 |
| `0c52085` | Memory consciousness cycle synthesis (Workers B+C) | 2579 |
| `e5fbe34` | Dashboard spawn-error classification | 201 |
| `ff245ab` | subctl-orch tool regression test | 117 |
| `ef89a94` | Backfill scripts | ~750 |
| `2e6267e` | Tier 1 candidate queue (Phase 3) | ~700 |

**6 commits**, ~5000 lines of production code + tests, **714 tests / 0 fail**. Memory Init #5 complete (Phases 1+2+3); Phase 4 (context slimming) deferred — waits on real reviewer activity.

Team `memory-kernel` stood down: mem-kernel-data, mem-kernel-reviewer, mem-kernel-integration, mem-backfill, tier1-candidates all acknowledged + idle.

---

# Orchestration Log — subctl

Most recent session at top. Older sessions retained below as historical record.

---

## Session 2026-05-15 morning — M3 install-worktree split + CLI follow-ups (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-15T~05:00 CDT
**Mode:** Orchestration with batch authorization extended from prior session. Operator explicitly authorized M3 (item 2b) per-action after the orchestrator surfaced the production-risk consideration.

### Mission
Three follow-ups parked in the prior HANDOFF §2:
- **2a** — `subctl dashboard deploy` CLI verb wrapping the 3-step deploy flow
- **2c** — `install.sh` patch baking the install-worktree pattern into fresh installs
- **2b** — M3 install-worktree split (touches remote production daemons; held for explicit op auth)
- (Plus item 2d worktree cleanup done directly; items 3 + 4 are read-only investigations.)

### Task Ledger

| ID | Task | State | Worker / Actor | Started | Finished |
|----|------|-------|----------------|---------|----------|
| 2a | `subctl dashboard deploy` CLI verb (lib/dashboard.sh + bin/subctl subverb dispatch) | ✅ done | deploy-cli (Agent + team_name) | 2026-05-15T~05:00 CDT | 2026-05-15T~05:18 CDT |
| 2c | install.sh ensure_install_tree + lib/service.sh plist points at install tree | ✅ done | install-pattern (Agent + team_name) | 2026-05-15T~05:00 CDT | 2026-05-15T~05:20 CDT |
| 2d | Worktree cleanup — 10 of 11 dashboard-decomp feature branches | ✅ done | orchestrator | 2026-05-15T~04:55 CDT | 2026-05-15T~04:55 CDT |
| 2b | M3 install-worktree split — both daemons decoupled from `~/code/subctl` dev tree | ✅ done | orchestrator (via SSH) | 2026-05-15T~05:56 CDT | 2026-05-15T~05:58 CDT |

### Verification Evidence

**2a (`deploy-cli`, commit `c25018a`):**
- `lib/dashboard.sh` (NEW, 156 lines) — `subctl_dashboard_deploy` + `subctl_dashboard_open`. Idempotent (no-op when install tree already at origin/main). Smart-runs `bun install` only when `dashboard/package.json` differs between BEFORE/AFTER SHAs.
- `bin/subctl:316-322` — `dashboard)` case now sub-dispatches `[open|deploy]`
- bin/subctl help text documents both subverbs
- Live-smoked post-merge: `bin/subctl dashboard deploy` returned "install tree already at 5d5749e — nothing to deploy" (idempotent path verified)
- Worker honest-reported: `lib/dep-manifest.json` schema only tracks external tool deps, so the registration step was correctly skipped.

**2c (`install-pattern`, commit `5d5749e`):**
- `install.sh:76` — `ensure_install_tree()` function added (63 lines)
- `install.sh:597` — called from main install flow
- `lib/core.sh:30` — `SUBCTL_INSTALL_TREE` env var (worker made the correct call to put it here rather than `lib/settings.sh` since `SUBCTL_*` env vars cluster in `lib/core.sh`)
- `lib/service.sh:89-94` — dashboard plist generation now points at install tree (`$SUBCTL_INSTALL_TREE/dashboard/server.ts`) with a dev-tree fallback if the install tree was skipped during setup
- `README.md` — install-tree pattern documented (8-line note)
- Master daemon plist NOT changed here — worker explicitly scoped this commit to the dashboard plist generation, deferring master to the M3-side work documented in this session.

**2d (orchestrator direct):**
- Deleted 10 of 11 dashboard-decomp feature branches: `feat/dashboard-decomp-{providers,vault,memory,skills,projects,settings,policy,teams,orch,preferences}`. `feat/dashboard-decomp-master` blocked by dev-tree worktree (harmless — same SHA as main).
- 21 version-named orphan worktrees (`subctl-v2.7.21` through `subctl-v2.8.6-skills-redesign`) NOT removed — they predate this session and likely contain operator state. Left for a future housekeeping pass.

**2b — M3 install-worktree split:**
Applied the same pattern that landed on local Mac 2026-05-13 night. M3 dev tree was on `main` at start (v2.8.5 = `da3578a`), preventing creating an install worktree on `main`. Resolution:
1. M3 dev tree fast-forwarded from `da3578a` → `5d5749e` (local Mac's main)
2. M3 dev tree moved to label branch `dev` (same SHA as main, harmless leftover label) to free up `main` for the install worktree
3. Install worktree created: `git worktree add /Users/you/.local/lib/subctl-install main`
4. Vendored both dep trees: `bun install` in `~/.local/lib/subctl-install/dashboard/` (10 packages) + `~/.local/lib/subctl-install/components/master/` (174 packages)
5. Backed up both plists with timestamp `20260515-055638`
6. **Dashboard plist:** `PlistBuddy Set :ProgramArguments:2` → install-tree path; `plutil -lint` OK; `launchctl bootout` + `launchctl bootstrap`. New PID **27129**, status 0, HTTP 200 on `/api/version` (returns v2.8.5). Confirmed via `ps -p` that the new PID is running `/Users/you/.local/lib/subctl-install/dashboard/server.ts`.
7. **Master plist:** same procedure. New PID **27432**, status 0, HTTP 200 on `/health`. Confirmed running install-tree code.
8. **`com.subctl.tts.plist`** NOT touched — separate plist for the voice service, scope was dashboard + master only. The TTS daemon still points at the dev tree (`~/code/subctl/services/tts/server.py`), parked as a future cleanup if it ever bites.

**M3-specific quirks observed:**
- Non-interactive `zsh` over SSH has a minimal PATH; `bun` lives at `/Users/you/.bun/bin/bun` which had to be sourced explicitly. Standard utils (`curl`, `head`, `id`) needed full paths in some invocations.
- M3 dev tree was 28 commits behind origin (sat at v2.8.5 da3578a; pulled to 5d5749e). The decomposition + this morning's CLI work all landed cleanly via fast-forward.

**Rollback evidence:** plist backups at `~/Library/LaunchAgents/com.subctl.{dashboard,master}.plist.bak-20260515-055638` on M3. Restoring is `mv .bak-… .plist; launchctl bootout && launchctl bootstrap` — same procedure in reverse.

### Items NOT addressed this session

- **Item 3 (worker-visibility investigation):** confirmed that the orchestrator-mode skill defers iTerm2 panes to "the Claude Code iTerm2 integration when `team_name` is set" — the skill itself doesn't enforce pane placement. Either the integration isn't installed on local Mac or it's placing panes somewhere not visible to the operator. **Diagnostic recommendation for future session:** inspect `~/.claude/settings.json` for iTerm-related keys; check if a separate "Claude Code iTerm2" helper script is registered.
- **Item 4 (`__skillsClarityRefresh` retirement):** confirmed via grep that NO external readers exist in `dashboard/`, `components/`, `lib/`, `bin/`. Safe to retire (3-line delete: assignment in mount, null in unmount, top doc comment line). Tiny worker dispatch worth doing in a future housekeeping pass.
- **`com.subctl.tts` plist** still points at dev tree (out of scope for this morning's split).
- **`feat/dashboard-decomp-master` leftover branch** still on dev tree (harmless — same SHA as main; cleanup blocked by worktree).

---

## Session 2026-05-14 evening — dashboard decomposition wave 14 — THE FINISH LINE (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~22:25 CDT
**Branch:** `feat/dashboard-decomp-master` (off `main` @ `860abcb`)
**Mode:** Orchestration with batch authorization. **Wave 14 is the FINAL extraction.** After this lands, app.js IS the shell.

### Mission
Wave 14: extract **Master chat** + chat-adjacent helpers (chat model selector, supervisor profile pill, `attachOneShotAssistantCapture`) into `dashboard/public/tabs/chat.js` (matching HTML `data-tab="chat"`).

This is the **default tab at page load** (`<button class="nav-btn active" data-tab="chat">`), so the bootstrap loader will hit `chat.js` immediately via the "boot tab catch-up" path — careful with mount-time work.

### Pre-conditions verified
- `main` @ `860abcb` (wave-13 deployed & pushed)
- Section bounds (4 non-contiguous blocks — `escapeText` + `cssEscape` at 712-726 STAY in app.js):
  - 491-611: Chat model selector (`wireChatModelSelector`)
  - 619-711: Supervisor profile pill (`wireProfilePill`)
  - 727-796: `attachOneShotAssistantCapture` + window publication
  - 798-1931: Master chat (`wireMasterChat` — the biggest single function in the file)
- Boot calls at 452 (wireMasterChat), 453 (wireChatModelSelector), 454 (wireProfilePill)
- Bridge: `window.__subctlAttachOneShotAssistantCapture` published at app.js:796, consumed by `tabs/projects.js:367`. **Preserve** — publish from chat.js mount(), null in unmount.
- Helper usage: 8 hits of `escapeText`/`cssEscape` inside the chat zone — module needs local copies (those helpers stay in app.js because they're used elsewhere too).
- HTML routing key: `"chat"` (matches the default-active tab)

### Forecast
- Total to extract: ~1,418 lines + 3 boot calls
- App.js: 3,945 → ~2,524 LOC. **This is the shell.**

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W14 | Extract Master chat + chat-adjacent helpers (~1,418 LOC across 4 non-contiguous blocks) to `tabs/chat.js` + preserve `__subctlAttachOneShotAssistantCapture` publication + bootstrap registry + server STATIC_FILES + delete 3 boot calls + DECISIONS.md wave-14 closeout | ✅ done | chat-extract | 2026-05-14T~22:25 CDT | 2026-05-14T~22:38 CDT (13 min) |

### Verification Evidence — wave 14 (FINAL)

- **Commit:** `3cc7757` on `feat/dashboard-decomp-master`
- **App.js:** 3,945 → 2,280 LOC (−1,665 — exceeded forecast of −1,421; worker moved more chat-adjacent helpers than minimum required)
- **tabs/chat.js:** 1,862 lines — **biggest module in the project** (84 KB on disk)
- **All 14 modules now present in `dashboard/public/tabs/`:** chat, logs, memory, models, orch, policy, preferences, projects, providers, settings, skills, teams, templates, vault
- **Chat zone purged from app.js:** only 2 hits remain, both in extraction-note comments (lines 211 and 602)
- **`escapeText` + `cssEscape` PRESERVED** in app.js at lines 257 and 263 (positions shifted but functions intact)
- **Bridge `window.__subctlAttachOneShotAssistantCapture`:** 3 hits in chat.js (publish + null + doc comment); Projects consumer at projects.js:367 untouched
- **bootstrap.js:** `TAB_LOADERS` now 14 entries (the final count)
- **server.ts:** all 14 `/tabs/*.js` entries in STATIC_FILES
- **All gates pass** — node --check × 3, server bun build, MIME smoke.

---

## DECOMPOSITION COMPLETE — final totals

**Original `app.js`** (2026-05-12 night, before wave 1): **8,955 LOC**
**Final `app.js`** (2026-05-14, wave 14 complete): **2,280 LOC**
**Reduction:** **−6,675 LOC** (**74.5%** of the monolith decomposed)

**14 waves over ~1.5 days:**

| Wave | Tab | Day | Reduction | Pattern |
|---|---|---|---|---|
| 1 | Logs | 05-13 | −192 (incl. policy chip) | Two entry points + per-stream SSE + cross-tab bridge globals |
| 2 | Templates | 05-13 | −126 | Clean isolated case (zero bridges) |
| 3 | Models | 05-13 | −111 | `pollTimer` lifted to module scope |
| 4 | Preferences | 05-14 | −286 | Listener lifecycle pattern proven |
| 5 | Providers | 05-14 | −269 | Self-contained, mirrors waves 2-3 |
| 6 | Vault | 05-14 | −309 | **Publisher pattern proven** (`window.openVaultDeepLink`) |
| 7 | Memory | 05-14 | −281 | Multi-entry collapse pattern proven (3 sub-fns → 1 mount) |
| 8 | Skills | 05-14 | −403 | Dead-bridge preservation pattern |
| 9 | Projects | 05-14 | −462 | **Dual-role bridge handling** (consume + own) |
| 10 | Settings | 05-14 | −528 | Operator-driven refresh tabs (no pollTimer) |
| 11 | Policy | 05-14 | −709 | **Inter-module event contract proven** (`subctl:policy-teams-updated`) + wave-1 bridges retired |
| 12 | Teams | 05-14 | −316 | Simple isolated extraction |
| 13 | Orch | 05-14 | −900 | **5-globals publisher** (modal subsystems) |
| 14 | Chat | 05-14 | −1,665 | **FINAL** — biggest module + chat-adjacent helpers |

**Per-day breakdown:**
- 2026-05-13 (waves 1-3): −429 LOC across 3 waves, established interface + loader pattern
- 2026-05-14 morning/afternoon (wave 4): −286 LOC, listener-lifecycle pattern
- **2026-05-14 evening (waves 5-14)** (this session): **−5,960 LOC across 10 waves**, completed the decomposition

**Patterns established (in extraction order):**
1. `{ id, mount, unmount }` module interface
2. `bootstrap.js` lazy-import registry + boot-tab catch-up + `setActiveTab` notifier
3. Inline helper duplication (no `shared/` directory)
4. `setInterval` lifecycle via module-scope timer + symmetric unmount
5. Persistent `document`/`window` listener lifecycle (refs at module scope, removed on unmount)
6. Window-global publisher pattern (`window.xxx = fn` at mount end, `= null` at unmount)
7. Multi-entry function collapse (sub-helpers as locals inside mount)
8. Dead-bridge preservation (no readers in-file but preserve for unknown external consumers)
9. Dual-role bridge handling (consume + own)
10. **Inter-module DOM event contract** (`document.dispatchEvent(new CustomEvent("subctl:xxx", { detail }))`) — replaced wave-1's temporary `window.__subctl*` bridges
11. 5-globals batch publishing (notification system + modal helpers)
12. Worker silent-idle protocol (verify by git log + gates, don't wait for SendMessage)

**Worker performance:**
- 10 workers dispatched tonight via `Agent` + `team_name=dashboard-decomp` (subagent_type `expert-bun-typescript`)
- 9 completed within 7-22 min envelope
- 1 outlier (wave 7 Memory) took 75 min — cause unclear; subctl-orch retry attempted but `claude-jason` account auth was expired; original worker eventually completed silently while retry was preparing
- 0 actual failures
- All commits clean, no rollbacks needed

**Architectural artifacts produced:**
- `dashboard/public/bootstrap.js` — 73-line ES-module shell loader (lazy-import + memoization)
- `dashboard/public/tabs/{logs,templates,models,preferences,providers,vault,memory,skills,projects,settings,policy,teams,orch,chat}.js` — 14 modules totaling ~9,090 lines
- `dashboard/public/app.js` — 2,280-line shell (state polling, WS transport, render dispatcher, cell builders, notification tray, status pill, lucide chrome, host-label boot, tab nav, transport, upstreams card)
- `DECISIONS.md` — 14 wave-closeout entries documenting every pattern decision
- `ORCHESTRATION.md` — full ledger of dispatches, verifications, deviations from plan

The dashboard is now **navigable for both humans and AI** without exhausting context. A future AI session opening one tab module pays the cost of ~5K tokens (the module + its imports), not ~100K (the monolith).

---

## Session 2026-05-14 evening — dashboard decomposition wave 13 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~22:00 CDT
**Branch:** `feat/dashboard-decomp-orch` (off `main` @ `7b6a758`)
**Mode:** Orchestration with batch authorization. Operator authorized finishing through wave 14 tonight.

### Mission deviation from HANDOFF — Orch only, NOT joint

HANDOFF.md planned wave 13 as a JOINT extraction of "Orchestration + Dashboard panel renderers" (1,891 LOC combined) because Orch publishes 5 globals that Dashboard panels consume. **Revised decision: extract Orch only.** Reasoning:

- The Dashboard panel renderers (`render(state)`, `renderOrchSidecar`, `renderOrchestrations`, `renderSessions`, all the cell builders/formatters) are not a tab — they're the **rendering infrastructure for the dashboard screen**, driven by the state polling/WS loop in app.js. They belong to the shell, not to a tab module.
- The publisher-consumer dynamic is exactly what wave 6 (Vault publishes `openVaultDeepLink`, Projects consumes) established: extract the publisher first, leave consumers in place reading the still-published global. No joint extraction needed.
- After wave 13 + wave 14, what remains in app.js is genuinely the shell: state polling + WS transport + render dispatcher + cell builders + verdict-transition notifications + status pill + lucide chrome + host-label boot + tab nav. That's the legitimate stopping point for this decomposition.

This is documented in DECISIONS.md so HANDOFF can be updated post-wave-14 to retire the "joint" plan.

### Mission
Wave 13: extract the **Orchestration zone** into `dashboard/public/tabs/orch.js`. Largest single extraction tonight (~905 LOC). Publishes 5 globals from mount(): `window.__subctlOpenTmuxPreview`, `window.__subctlCopyAttachCommand`, `window.__subctlOpenWebTerminal`, `window.__subctlWireWebTerminalGate`, and the entire `window.notice` + `.error` + `.confirm` notification system.

### Pre-conditions verified
- `main` @ `7b6a758` (wave-12 deployed & pushed)
- Orch zone bounds: `app.js:709–1614` inclusive (~906 lines)
  - 709-829: Camera grid (`wireOrchCameraGrid`)
  - 830-1110: Cockpit (`fmtTimeShort`, `renderWatchdogPanel`, `escForWatchdog`, `wireOrchestrationCockpit`)
  - 1112-1395: Watchdog panel (`wireWatchdogPanel`)
  - 1397: `function escapeText(s)` — **STAYS in app.js** (module-scope helper used widely outside Orch zone)
  - 1401-1488: TMux preview modal (`openTmuxPreview`, `copyAttachCommand`) + 2 global publications
  - 1490-1542: Web terminal driver (`openWebTerminal`, `wireWebTerminalGate`) + 2 global publications
  - 1544-1614: Notice modal (`_showNotice`) + 3 publications (`window.notice`, `.error`, `.confirm`)
- 4 boot calls to delete: `app.js:455` (cockpit), `456` (camera), `460` (terminal gate), `1395` (watchdog)
- Consumer count for the 5 globals: 24 hits in app.js + 8 hits in extracted tabs/*.js. ALL must continue working.

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W13 | Extract Orch zone (~906 LOC: camera + cockpit + watchdog + 3 modal subsystems) to `tabs/orch.js` + publish 5 globals from mount() + delete 4 boot calls + bootstrap registry + server STATIC_FILES + DECISIONS.md wave-13 closeout | ✅ done | orch-extract | 2026-05-14T~22:00 CDT | 2026-05-14T~22:17 CDT (17 min) |

### Verification Evidence — wave 13

- **Commit:** `9368ccf` on `feat/dashboard-decomp-orch`
- **App.js:** 4,845 → 3,945 LOC (−900, forecast was −906)
- **tabs/orch.js:** 1,039 lines — biggest module yet (surpasses policy.js at 758)
- **5 globals published from mount:** verified — `__subctlOpenTmuxPreview`, `__subctlCopyAttachCommand`, `__subctlOpenWebTerminal`, `__subctlWireWebTerminalGate` all show 3 hits each (assignment + null + doc comment); `window.notice` + `.error` + `.confirm` all present
- **Consumer preservation verified:** 22 `window.notice` consumer sites still in app.js shell (down from 24 — the 2 dropped were inside the Orch zone that got deleted); 2 `__subctlOpen*` consumer sites still in app.js (the renderOrchestrations call sites at lines 3278/3288). All 8 in extracted tabs/*.js modules untouched.
- **Routing key smart-catch:** worker correctly registered the bootstrap key as `"orchestration"` (matching HTML `data-tab="orchestration"`) while keeping the file name `tabs/orch.js` (shorter). Documented in bootstrap.js comment.
- **bootstrap.js:** `TAB_LOADERS` now 13 entries
- **server.ts:** `STATIC_FILES["/tabs/orch.js"]` registered
- All 3 `node --check` pass; `bun build` of server clean.

---

## Session 2026-05-14 evening — dashboard decomposition wave 12 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~21:50 CDT
**Branch:** `feat/dashboard-decomp-teams` (off `main` @ `35e6487`)
**Mode:** Orchestration with batch authorization. Operator chose to push through to wave 14 tonight (full decomposition).

### Mission
Wave 12: extract the **Teams** tab (dev-team templates) into `dashboard/public/tabs/teams.js`. HANDOFF flagged "mild templates/policy interop" but grep shows none at code level — only UI-text references to templates. Simpler than waves 6-11.

### Pre-conditions verified
- `main` @ `35e6487` (wave-11 deployed & pushed, bridges retired cleanly)
- Section bounds: `app.js:488–803` inclusive (316 lines)
- Call site at `app.js:461`
- One `setInterval` (refresh poll)
- No `window.__subctl*` reads, no `subctl:*` event subscriptions, no `cachedTeams` references — fully isolated tab
- HTTP endpoints (unchanged): `/api/team-templates` GET/POST/DELETE plus `/api/orchestration/spawn`

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W12 | Extract Teams tab to `tabs/teams.js` + bootstrap registry + server STATIC_FILES + delete from `app.js` + DECISIONS.md wave-12 closeout | ✅ done | teams-extract | 2026-05-14T~21:50 CDT | 2026-05-14T~21:50 CDT (10 min) |

### Verification Evidence — wave 12

- **Commit:** `7236f34` on `feat/dashboard-decomp-teams`
- **App.js:** 5,161 → 4,845 LOC (−316, exact forecast match)
- **tabs/teams.js:** 380 lines
- All gates pass. Bootstrap + STATIC_FILES registered. wireTeamsTab fully purged from app.js.

---

## Session 2026-05-14 evening — dashboard decomposition wave 11 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~21:20 CDT
**Branch:** `feat/dashboard-decomp-policy` (off `main` @ `e6de7d8`)
**Mode:** Orchestration with batch authorization. **Operator explicitly authorized higher-risk wave** including the wave-1 bridge retirement.

### Mission
Wave 11: extract the **Policy** zone — biggest yet at ~710 LOC across 13 functions — AND **retire the 3 wave-1 cross-tab bridges**. First wave to modify an already-shipped extracted module (`tabs/logs.js`). New contract: custom DOM events on `document` replace the three `window.__subctl*` globals.

### Pre-conditions verified
- `main` @ `e6de7d8` (wave-10 deployed, pushed)
- Policy zone bounds: `app.js:4510–5225` inclusive (~715 lines)
  - Lines 4510-4515: long PR-11 header comment block
  - Line 4520: `let cachedTeams = []`
  - Lines 4522-4574: audit-line helpers (`fmtAuditLine`, `classifyAuditLine`, `renderAuditEntries`) — **these MOVE TO `tabs/logs.js`** (Logs is the sole consumer)
  - Lines 4576-4609: `refreshPolicyTeamsForDropdowns()` — Policy-owned, splits DOM cross-write
  - Lines 4613-4620: bridge publication block (3 `window.__subctl*` assignments) — DELETED
  - Lines 4623-5225: `wirePolicyTab` + 4 editor functions + 4 helper functions — all to `tabs/policy.js`
- Boot call at `app.js:479`
- 3 bridge consumers in `tabs/logs.js`: lines 274, 277, 288, 302, 304 (5 read sites)
- Wave-1 DECISIONS predicted this exact retirement: "Policy owns its own publishing (likely a `teamsUpdated` custom event Logs subscribes to)"

### New contract — `subctl:policy-teams-updated` event

**Publisher (`tabs/policy.js`):**
- Owns `cachedTeams` (module-scope)
- `refreshPolicyTeams()` fetches `/api/policy/teams`, updates `cachedTeams`, populates `#policy-resolved-team` (Policy's own selector — the cross-write to `#logs-policy-team` is REMOVED), then dispatches `document.dispatchEvent(new CustomEvent("subctl:policy-teams-updated", { detail: { teams: [...cachedTeams] } }))`
- Subscribes to `document` for `subctl:policy-teams-refresh-request` — when received, calls `refreshPolicyTeams()`. Lift the handler to module scope so `unmount()` can remove it.

**Subscriber (`tabs/logs.js` — modified):**
- Adds module-scope `let logsCachedTeams = []` (Logs's local copy)
- In `mount()`, registers `onTeamsUpdated` listener on `document`. Handler stores `e.detail.teams` into `logsCachedTeams` and populates `#logs-policy-team` (the DOM cross-write that used to live in Policy is now here, on the consuming side).
- SSE meta-line code reads `logsCachedTeams` directly (replacing `window.__subctlGetPolicyTeams?.()` call sites).
- Chip-activation path: dispatches `subctl:policy-teams-refresh-request` and uses a one-shot Promise-wrapping helper to wait for the next `subctl:policy-teams-updated` event before populating the team selector.
- Hosts `fmtAuditLine`, `classifyAuditLine`, `renderAuditEntries` as local helpers inside `mount()` (moved from app.js's policy-zone).
- SSE handlers call local `renderAuditEntries` directly (replacing `window.__subctlRenderAuditEntries?.()`).
- `unmount()` removes the `subctl:policy-teams-updated` listener.

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W11 | Extract Policy zone to `tabs/policy.js` (publishes event) + modify `tabs/logs.js` to subscribe (replaces 3 bridges) + move audit renderers from app.js to logs.js + delete 3 `window.__subctl*` bridge publications + bootstrap registry + server STATIC_FILES + DECISIONS.md wave-11 closeout | ✅ done | policy-extract | 2026-05-14T~21:20 CDT | 2026-05-14T~21:42 CDT (22 min) |

### Verification Evidence — wave 11

- **Commit:** `e8bbd30` on `feat/dashboard-decomp-policy`
- **App.js:** 5,870 → 5,161 LOC (−709, forecast was −712)
- **tabs/policy.js:** 758 lines, biggest module yet — owns `cachedTeams`, publishes `subctl:policy-teams-updated`, subscribes to `subctl:policy-teams-refresh-request`, populates ONLY `#policy-resolved-team`
- **tabs/logs.js:** 372 → 504 lines (+132) — adds module-scope `logsCachedTeams` + `onTeamsUpdated`; hosts `fmtAuditLine`/`classifyAuditLine`/`renderAuditEntries` as locals inside mount; subscribes to `subctl:policy-teams-updated`, fires `subctl:policy-teams-refresh-request` on chip activation; unmount removes the listener cleanly
- **Bridge retirement — verified by grep:**
  - `__subctlGetPolicyTeams` / `__subctlRefreshPolicyTeams` / `__subctlRenderAuditEntries` → **zero hits in BOTH `app.js` AND `tabs/logs.js`**. The wave-1 bridges are gone.
- **Event contract — verified symmetric:**
  - `subctl:policy-teams-updated`: dispatched at `policy.js:128`; subscribed at `logs.js:154` (long-lived) + `logs.js:316-323` (one-shot pattern for chip activation)
  - `subctl:policy-teams-refresh-request`: dispatched at `logs.js:330`; subscribed at `policy.js:137`, removed at `policy.js:755` (unmount)
- **DOM cross-write split** verified: Policy populates only `#policy-resolved-team`; Logs populates only `#logs-policy-team` (now triggered by event handler, not direct cross-write)
- **bootstrap.js:** `TAB_LOADERS` now 11 entries
- **server.ts:** `STATIC_FILES["/tabs/policy.js"]` registered
- **All 4 `node --check` passes; bun build of server clean.**

### Pattern proven — inter-module event contract

Wave 11 establishes the canonical pattern for cross-tab communication after extraction: **`document`-level custom events** with `{ detail: ... }` payloads. Publisher fires, subscriber listens, both clean up in `unmount()`. The one-shot pattern (install listener → fire request → resolve on first matching event → remove listener) handles synchronous request/response. No event-bus library, no shared/ directory, no service layer — just the platform.

This unlocks the back half of the migration. Future cross-cuts (Master chat reading session state, Dashboard panels reading Orchestration state, Teams reading Policy presets) all have a tested contract to follow.

### Wave-1 retrospective closeout

Wave-1 DECISIONS.md explicitly predicted this retirement: "These retire when the Policy tab extracts. At that point Policy owns its own publishing (likely a `teamsUpdated` custom event Logs subscribes to), the bidirectional DOM cross-write collapses to one side, and the bridges go." **All three predictions held.** The temporary bridges introduced 1.5 days ago to keep wave-1 unblocked are gone exactly as scheduled. Good design discipline.

---

## Session 2026-05-14 evening — dashboard decomposition wave 10 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~21:05 CDT
**Branch:** `feat/dashboard-decomp-settings` (off `main` @ `d50f3fa`)
**Mode:** Orchestration with batch authorization.

### Mission
Wave 10 of `dashboard/public/app.js` decomposition: extract the **Settings** tab. 528 LOC — biggest section so far. **Most sub-helpers of any tab to date**: `loadHealth`, `loadKeys`, `loadSecrets`, `openSecretsModal`, `closeSecretsModal`, `submitSecretsModal`, `wireSecretsModal`, `loadOAuth`, `loadTelegramStatus`, `wireTelegramForm`, `wireConfigViewer`, `loadVault`, `wireVaultForm`, `loadPersonality`, `refreshAll` — all nested inside one `wireSettingsTab()` body. Reads `window.notice` (notification system, still owned by app.js).

### Pre-conditions verified
- `main` @ `d50f3fa` (wave-9 deployed, pushed)
- Section bounds: `app.js:797–1324` inclusive (528 lines)
- Call site at `app.js:464`
- No `setInterval` (refresh is operator-driven via `#settings-refresh-btn` click)
- Multiple one-shot `setTimeout`s for "copied!" feedback — leave verbatim
- Consumer of `window.notice` (5 references in body) — preserve verbatim, same pattern as Projects consuming openVaultDeepLink
- The Settings vault-config form (`loadVault`/`wireVaultForm`) is DISTINCT from the Vault TAB (already extracted in wave 6). Different DOM IDs (`settings-vault-*` vs `vault-*`), different endpoints (`/api/settings/vault` vs `/api/vault/roots`). No collision.

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W10 | Extract Settings tab (~15 internal sub-helpers → 1 mount) to `tabs/settings.js` + preserve window.notice consumer + bootstrap registry + server STATIC_FILES + delete from `app.js` + DECISIONS.md wave-10 closeout | ✅ done | settings-extract | 2026-05-14T~21:05 CDT | 2026-05-14T~21:13 CDT (8 min) |

### Verification Evidence — wave 10

- **Commit:** `44aa618` on `feat/dashboard-decomp-settings`
- **App.js:** 6,398 → 5,870 LOC (−528, exact forecast match)
- **New module:** `dashboard/public/tabs/settings.js` — 656 lines, biggest module yet, `{ id, mount, unmount }`, no module-scope state, no-op `unmount()` (no timers, no listeners)
- **Sub-helper accounting:** all ~15 inline functions preserved as locals inside `mount()` — `loadHealth`, `loadKeys`, `loadSecrets` + modal helpers, `loadOAuth`, `loadTelegramStatus` + `wireTelegramForm`, `wireConfigViewer`, `loadVault` + `wireVaultForm`, `loadPersonality`, `refreshAll`
- **`window.notice` accounting:** 8 hits in `tabs/settings.js` (consumer); publisher `window.notice = (title, body, opts = {}) => _showNotice(...)` remains at `app.js:1921` — untouched as intended
- **bootstrap.js:** `TAB_LOADERS` now 10 entries
- **server.ts:** `STATIC_FILES["/tabs/settings.js"]` registered
- **Worker time:** ~8 min — fast envelope holds (3 of last 4 waves under 15 min)

### Pattern reinforced — operator-driven refresh tabs
A tab whose refresh is operator-triggered (button click) rather than polled needs no module-scope state and a no-op `unmount()`. The simplest possible shape for the `{ id, mount, unmount }` interface — no `setInterval`, no observer, no published global, no module-level `let`. Future tabs in this shape can ship even faster.

---

## Session 2026-05-14 evening — dashboard decomposition wave 9 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~20:55 CDT
**Branch:** `feat/dashboard-decomp-projects` (off `main` @ `a489f00`)
**Mode:** Orchestration with batch authorization.

### Mission
Wave 9 of `dashboard/public/app.js` decomposition: extract the **Projects** tab — 465 lines. **First tab to extract that BOTH consumes someone else's bridge AND owns cross-tab state of its own:**
- **Consumes** `window.openVaultDeepLink` (published by tabs/vault.js since wave 6) at the Projects "Open in Vault Viewer" code path
- **Owns** `window.__policyPresetsCache` — a per-page lazy-memoized fetch promise. Grep confirms it's Projects-only (3 hits, all inside `wireProjectsTab`). The `window.` prefix is cheap memoization, not a real cross-tab bridge.

### Decision — keep both globals as-is

Per the wave-6 DECISIONS.md entry, we said we'd re-evaluate retiring `window.openVaultDeepLink` to a `subctl:vault-deeplink` custom event when Projects extracted. **Decision tonight: keep the window global.** Simpler than introducing an event bus, direct function call is cheaper, behavior-parity is the goal of decomposition. The bridge is small (one function), well-documented, and likely to be wanted by future tabs (Master chat? Skills?). Retirement to events would be a separate refactor with its own justification — not a decomposition concern.

For `window.__policyPresetsCache`: keep `window.`-prefixed for behavior parity. After bootstrap-mounting it's actually equivalent to module-scope (mount runs once per page), but changing the prefix would be a refactor without payoff.

### Pre-conditions verified
- `main` @ `a489f00` (wave-8 deployed and pushed)
- Section bounds: `app.js:2532–2996` inclusive (465 lines)
- Call site at `app.js:453`
- `window.openVaultDeepLink` consumer at `app.js:2807-2808` (typeof guard + call + fallback at 2810-2814)
- `window.__policyPresetsCache` owned-and-used at `app.js:2821, 2822, 2827`
- One `setInterval` for refresh poll around abs line 2866
- Two one-shot `setTimeout`s (focus, modal close) — no cleanup needed

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W9 | Extract Projects tab to `tabs/projects.js` + preserve both globals (consume openVaultDeepLink, own __policyPresetsCache) + bootstrap registry + server STATIC_FILES + delete from `app.js` + DECISIONS.md wave-9 closeout | ✅ done | projects-extract | 2026-05-14T~20:55 CDT | 2026-05-14T~21:02 CDT (7 min) |

### Verification Evidence — wave 9

- **Commit:** `52e2ae2` on `feat/dashboard-decomp-projects`
- **App.js:** 6,860 → 6,398 LOC (−462, forecast was −465)
- **New module:** `dashboard/public/tabs/projects.js` — 606 lines, biggest module yet, `{ id, mount, unmount }` with single `pollTimer` lifted to module scope, helpers `$` + `escapeText` inlined
- **Bridge accounting:**
  - **Consumer (`window.openVaultDeepLink`)** — 4 hits in projects.js (typeof guard + call + 2 doc); 2 hits in app.js (both extraction-note comments). Vault publisher untouched in `tabs/vault.js`. Behavior parity preserved.
  - **Owner (`window.__policyPresetsCache`)** — 5 hits in projects.js (3 original use sites + 2 doc); 1 hit in app.js (extraction-note comment).
- **bootstrap.js:** `TAB_LOADERS` now 9 entries
- **server.ts:** `STATIC_FILES["/tabs/projects.js"]` registered
- **Worker time:** ~7 min, back in the fast envelope. wave-7's 75min remains the lone outlier.

### Pattern reinforced — dual-role bridge handling
A tab that **consumes** a foreign bridge AND **owns** a cache global can do both with no special machinery. Type-guard the consumer (handles unmount/never-loaded). Keep the owned cache `window.`-prefixed for behavior parity (don't refactor to module-scope; the prefix is cheap and risk-free). DECISIONS.md wave-9 documents the call to keep both as window globals rather than retire to events — that decision applies forward for any future tab that needs to deep-link into Vault.

---

## Session 2026-05-14 evening — dashboard decomposition wave 8 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~20:35 CDT
**Branch:** `feat/dashboard-decomp-skills` (off `main` @ `faf8098`)
**Mode:** Orchestration with batch authorization. Operator chose to continue with `Agent` + `team_name` despite the wave-7 timing tail; we accept the variable latency risk.

### Mission
Wave 8 of `dashboard/public/app.js` decomposition: extract the **Skills** tab — biggest tab so far at ~406 LOC. Two internal entry points (`wireSkillsTab` + `wireSkillsClarityView`) collapse into one `mount()`. Publishes a window bridge (`window.__skillsClarityRefresh`) with no known consumer — preserve as no-op for behavior parity, queue retirement as DECISIONS deferred work.

### Pre-conditions verified
- `main` @ `faf8098` (wave-7 deployed and pushed)
- Section bounds: `app.js:793–1198` inclusive (406 lines)
  - `wireSkillsTab` @ 794-1005 — main catalog + import flow, `setInterval` poll, calls `wireSkillsClarityView`
  - `wireSkillsClarityView` @ 1006-1198 — clarity card view, `setInterval` poll, publishes `window.__skillsClarityRefresh`
- Call site at `app.js:463`
- Bridge `window.__skillsClarityRefresh` set at `app.js:1061` — grep confirms NO READERS anywhere in `dashboard/public/app.js`. Bridge is effectively dead but preserved for behavior parity (something outside app.js — master tool, browser extension, bookmarklet — may still read it).

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W8 | Extract Skills tab (2 sub-functions → 1 mount) to `tabs/skills.js` + preserve `__skillsClarityRefresh` bridge publication + bootstrap registry + server STATIC_FILES + delete from `app.js` + DECISIONS.md wave-8 closeout | ✅ done | skills-extract | 2026-05-14T~20:35 CDT | 2026-05-14T~20:48 CDT (13 min) |

### Verification Evidence — wave 8

- **Commit:** `d926d58` on `feat/dashboard-decomp-skills` (`refactor(dashboard): extract Skills tab to ES module — wave 8 (multi-entry + bridge preservation)`)
- **App.js:** 7,263 → 6,860 LOC (−403, forecast was −406)
- **New module:** `dashboard/public/tabs/skills.js` — 549 lines, `{ id, mount, unmount }` shape, two `pollTimer` lifted to module scope, two sub-helpers preserved as locals inside mount(), unified `escapeText`/`$` helpers inlined
- **Bridge accounting:**
  - `dashboard/public/tabs/skills.js`: 4 hits — top-of-file doc comment, `window.__skillsClarityRefresh = ...` at mount end, `window.__skillsClarityRefresh = null` in unmount, plus a reference (closure or comment)
  - `dashboard/public/app.js`: 1 hit — extraction-note comment in boot block. **Zero readers in app.js confirms the bridge is dead in-file**; preserved for unknown external readers.
- **bootstrap.js:** `TAB_LOADERS` now 8 entries
- **server.ts:** `STATIC_FILES["/tabs/skills.js"]` registered
- **Gates:** all 11 pass — `node --check` clean × 3, `wireSkillsTab`/`wireSkillsClarityView` purged from app.js, registry + STATIC_FILES entries verified
- **Worker time:** ~13 min (vs 75 for wave 7) — the "start immediately, don't over-explore" preface may have helped, or this was just the normal envelope. We have one wave-7 data point and one wave-8; can't conclude yet.

### Pattern reinforced — dead-bridge preservation
When extracting a tab that publishes a `window.__*` global whose readers can't be located in-file, default to **preserve** rather than retire. Behavior-parity is the goal of decomposition; bridge retirement is a separate sweep once we've audited external consumers (master daemon routes, browser extensions, operator bookmarklets). Document in DECISIONS.md so the eventual sweep has a list.

---

## Session 2026-05-14 evening — dashboard decomposition wave 7 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~19:15 CDT
**Branch:** `feat/dashboard-decomp-memory` (off `main` @ `1468858`)
**Mode:** Orchestration with batch authorization.

### Mission
Wave 7 of `dashboard/public/app.js` decomposition: extract the **Memory** tab into `dashboard/public/tabs/memory.js`. First tab with **multiple internal entry points** (Tier-1 user/memory editors + main Obsidian vault status + Evy Memory Tier-3 card). Three sub-functions in app.js collapsed into one `mount()`.

### Pre-conditions verified
- `main` @ `1468858` (wave-6 deployed, pushed)
- Memory section at `app.js:3400–3680` (281 lines)
- Two `setInterval`s to lift to module scope; visibility gates dropped (mount-on-activate is new contract)
- No SSE, no `window.__subctl*` bridges, no cross-tab consumers

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W7 | Extract Memory tab to `tabs/memory.js` + bootstrap registry + server STATIC_FILES + delete from `app.js` + DECISIONS.md wave-7 closeout | ✅ done | memory-extract | 2026-05-14T~19:15 CDT | 2026-05-14T~20:28 CDT (75 min — slow but clean) |

### Verification Evidence — wave 7

- **Commit:** `6597668` on `feat/dashboard-decomp-memory` (`refactor(dashboard): extract Memory tab to ES module — wave 7 (multi-entry collapse)`)
- **App.js:** 7,544 → 7,263 LOC (−281, forecast was −282)
- **New module:** `dashboard/public/tabs/memory.js` — 379 lines, `{ id, mount, unmount }` shape
  - Three sub-helpers preserved as locals inside `mount()` (mirrors original control flow)
  - `tier1PollTimer` + `mainPollTimer` lifted to module scope; visibility gates dropped
  - Unified `esc` helper consolidates the prior `escapeForHtml`/`esc` duplicate
- **bootstrap.js:** `TAB_LOADERS` now 7 entries
- **server.ts:** `STATIC_FILES["/tabs/memory.js"]` registered
- **Gates:** `node --check` clean on all 3 JS files; all `wireMemoryTab`/`wireTier1MemoryCards`/`wireEvyMemoryCard` purged from app.js; registry + STATIC_FILES entries verified

### Operational note — Agent worker timing variability

This worker took **75 minutes** vs the prior two waves' ~7 minutes each. Same dispatch pattern (`Agent` + `subagent_type=expert-bun-typescript` + `team_name=dashboard-decomp`); same prompt shape; same scope envelope; same end-state quality. The slowness happened during the work, not at the bookend. Lesson: **Agent worker latency is highly variable**, ranging from 7 min to 75 min for comparable extractions, with no operator-visible signal during the long path. The orchestrator-mode skill promises iTerm2 panes (`Agent` + `team_name` → "their own iTerm2 pane") but on this machine that integration isn't placing workers in visible panes — operator has no way to watch progress. Considered redispatch via `subctl orch spawn -a claude-jason` (visible tmux pane) mid-incident but `claude-jason` returned `401 Invalid authentication credentials` and the spawned session was killed. The Agent worker then completed unaided. **Open follow-up:** decide for future waves whether to (a) re-auth `claude-jason`/`claude-titanium` and switch to subctl orch for visibility, (b) keep using Agent and accept the variable latency, (c) build a thin "agent worker progress" surface that the orchestrator can poll (e.g. periodic disk-mtime checks). Tactical for tonight: continue Agent + team_name, accept slow-tail risk.

---

## Session 2026-05-14 evening — dashboard decomposition wave 6 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~19:05 CDT
**Branch:** `feat/dashboard-decomp-vault` (off `main` @ `ead78c3`)
**Mode:** Orchestration. Operator authorization: full cycle on wave-5 (merge → deploy → push), then dispatch wave-6 immediately.

### Mission
Wave 6 of `dashboard/public/app.js` decomposition: extract the **Vault** tab into `dashboard/public/tabs/vault.js`. First tab to *publish* a window bridge global (`window.openVaultDeepLink`) for downstream consumers. Pattern-setter for "tabs that other tabs depend on" — symmetric to wave-1 (Logs) which only consumed.

### Pre-conditions verified
- `main` @ `ead78c3` (wave-5 deployed at :8787, MIME smoke 200)
- Vault tab body at `app.js:1946–2255` (310 lines: section header + `wireVaultTab` body)
- Call site at `app.js:455` (`wireVaultTab();`)
- Bridge published at `app.js:2245–2254` — `window.openVaultDeepLink` is closure over mount's `checkActive`
- Bridge consumer at `app.js:3519–3520` — inside Projects tab body, calls `window.openVaultDeepLink("master", target)`. Worker MUST NOT touch the consumer (Projects = wave 9). Consumer's fallback (3522-3526) covers the unmounted-Vault case; preserved by extraction since bridge is published at mount.
- `MutationObserver(data-active-tab)` at 2239 — refire `checkActive` on tab activations. Bootstrap-mounting makes the *initial* mount redundant, but the observer still fires for hash deep-links from Projects. Keep — lift handle to module scope, disconnect in unmount.
- No SSE. No setInterval. `setTimeout` for marked.js ready-polling fires once.

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W6 | Extract Vault tab to `tabs/vault.js` + bridge `window.openVaultDeepLink` continues to publish from mount + bootstrap registry + server `STATIC_FILES` + `app.js` deletion + DECISIONS.md wave-6 closeout | ✅ done | vault-extract | 2026-05-14T~19:05 CDT | 2026-05-14T~19:12 CDT |

### Verification Evidence — wave 6

- **Commit:** `27000b5` on `feat/dashboard-decomp-vault` (`refactor(dashboard): extract Vault tab to ES module — wave 6 (publisher bridge)`)
- **App.js:** 7,853 → 7,544 LOC (−309, forecast was −311)
- **New module:** `dashboard/public/tabs/vault.js` — 389 lines, `{ id, mount, unmount }` shape, MutationObserver lifted to module scope (`activeTabObserver`), helpers `$` and `esc` inlined
- **Bridge accounting (correct on both sides):**
  - `dashboard/public/tabs/vault.js`: 3 hits — top-of-file doc comment (line 9), `window.openVaultDeepLink = function(...)` at mount end (line 367), `window.openVaultDeepLink = null` in unmount (line 388)
  - `dashboard/public/app.js`: 3 hits — extraction-note comment in boot block (line 467), Projects consumer `typeof` guard (line 3210), Projects consumer call (line 3211). Consumer untouched as required.
- **bootstrap.js:** `TAB_LOADERS` now 6 entries; wave-tracking comment updated
- **server.ts:** `STATIC_FILES["/tabs/vault.js"]` registered alongside existing 5 `/tabs/*.js` entries
- **Gates:**
  - `node --check` clean on `vault.js`, `app.js`, `bootstrap.js`
  - `grep wireVaultTab` and `grep '----- Vault viewer'` on app.js → empty
  - Worker self-ran live MIME smoke on `PORT=8799` per commit log
- **Worker behaviour:** silent-idle after commit — pattern holds across all 6 waves now
- **DECISIONS.md:** appended wave-6 closeout (publisher bridge pattern documented for wave-9 reference)

### Pattern established this wave: publisher-side bridge

`mount()` assigns `window.openVaultDeepLink`; `unmount()` nulls it. The function closes over mount-scope locals (`checkActive`). Symmetric to wave-1's consumer-side pattern. When Projects extracts in wave 9, we'll re-evaluate whether the bridge should retire to a `subctl:vault-deeplink` custom event (now that both sides would be modules and could communicate via DOM events) or keep the global (simpler, cheaper). That decision is wave-9 scope; the bridge stays as-is until then.

---

## Session 2026-05-14 evening — dashboard decomposition wave 5 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-14T~18:50 CDT
**Branch:** `feat/dashboard-decomp-providers` (off `main` @ `246224d`)
**Mode:** Orchestration. Operator authorization: wave-5 dispatch. One feature branch in the main worktree; one worker; one commit; no push, no merge.

### Mission
Wave 5 of `dashboard/public/app.js` decomposition: extract the Providers tab into `dashboard/public/tabs/providers.js`. Mirrors waves 2+3 (Templates, Models) — fully self-contained tab, zero bridges, `setInterval` poll lifecycle that needs `pollTimer` lifted to module scope for `unmount()` symmetry.

### Pre-conditions verified
- `main` @ `246224d` (HANDOFF closeout), local Mac install tree pinned to main, daily-driver healthy
- `app.js` at 8,122 LOC at session start
- Providers body at `app.js:791–1058`; call site at `app.js:466`
- No `window.__subctl*` reads or writes in `wireProvidersTab` body — grep clean
- Only HTTP boundary: `GET /api/providers`, `POST /api/providers/profiles`, `DELETE /api/providers/profiles` — server handlers untouched this wave
- `SUBCTL_AGENT_ROLE=<unset>` — orchestrator activation legitimate

### Task Ledger

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| W5 | Extract Providers tab to `dashboard/public/tabs/providers.js` + bootstrap registry + server `STATIC_FILES` + delete from `app.js` + DECISIONS.md closeout | ✅ done | providers-extract | 2026-05-14T~18:50 CDT | 2026-05-14T~18:57 CDT |

### Verification Evidence — wave 5

- **Commit:** `edc0b73` on `feat/dashboard-decomp-providers` (`refactor(dashboard): extract Providers tab to ES module — wave 5`)
- **App.js:** 8,122 → 7,853 LOC (−269, exactly on forecast)
- **New module:** `dashboard/public/tabs/providers.js` — 320 lines, `{ id, mount, unmount }` shape, `pollTimer` lifted to module scope, helpers `$` + `escapeText` inlined, visibility gate dropped (mount-on-activate is the new contract)
- **bootstrap.js:** `TAB_LOADERS` now 5 entries (`logs, templates, models, preferences, providers`); wave-tracking comment updated to `Waves so far: Logs (1), Templates (2), Models (3), Preferences (4), Providers (5).`
- **server.ts:** `STATIC_FILES["/tabs/providers.js"]` registered alongside the existing 4 `/tabs/*.js` entries
- **Gates:**
  - `node --check` clean on `providers.js`, `app.js`, `bootstrap.js`
  - `grep wireProvidersTab dashboard/public/app.js` → empty (clean delete)
  - `grep '----- Providers tab' dashboard/public/app.js` → empty
  - Worker self-ran live MIME smoke on `PORT=8799` (their commit message confirms all 9 gates passed)
- **Worker behaviour:** silent-idle after commit, consistent with HANDOFF.md §5
- **DECISIONS.md:** appended wave-5 closeout entry under Architectural calls

### Worker silent-idle protocol — still consistent

`providers-extract` (subagent_type `expert-bun-typescript`) completed work, committed, went idle without sending the `SendMessage` report-back the dispatch spec asked for. Same pattern as all 4 prior workers. Self-verified via `git log` + gate-check script per HANDOFF §5. No remediation needed — protocol is "self-verify after idle."

---

## Session 2026-05-13 night — dashboard decomposition wave 1 (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-13T~19:30 CDT
**Branch:** `main` @ `dd958ba` (v2.8.5)
**Mode:** Orchestration. Operator authorization: one PR for the wave-1 extraction. Worker bound to a feature branch in the main worktree (no new orphan worktrees).

### Mission
Recommendation #1 of the 2026-05-12 night pre-mortem: split `dashboard/public/app.js` (8,955 lines) into per-tab plain-JS modules. No framework. No build system. No new deps. Wave 1: extract the Logs tab end-to-end as the pattern-setter; everything else stays in the monolith.

### Pre-conditions verified
- main @ `dd958ba`, clean working tree (`git status` at session start)
- app.js inventory complete (see operator-facing report at session start; full breakdown by tab in this entry below)
- `dashboard/server.ts:1591` uses an explicit `STATIC_FILES` allowlist — new asset paths require server.ts edits (verified by reading the static handler)
- `icons.js` already proves ES modules serve correctly when registered
- All three HANDOFF §2 issues remain closed (no rework backlog blocking wave 1)

### Inventory summary (app.js 8,955 LOC)

| Tab | Wire fn @ line | LOC | window.* writes | window.* reads | Cross-tab deps |
|---|---|---|---|---|---|
| logs | wireLogsTab @ 477 + wireLogsPolicyChip @ 7283 | ~192 | 0 | 0 | none |
| teams | wireTeamsTab @ 589 | ~319 | 0 | 0 | mild — providers, policy |
| templates | wireV2TemplatesTab @ 908 | ~122 | 0 | 0 | mild Teams interop (spawn-from-template) |
| providers | wireProvidersTab @ 1030 | ~269 | 0 | 0 | none |
| skills | wireSkillsTab + wireSkillsClarityView @ 1299 | ~410 | `__skillsClarityRefresh` | 0 | none |
| settings | wireSettingsTab @ 1705 | ~528 | 0 | 0 | none |
| chat selectors | wireChatModelSelector + wireProfilePill @ 2233 | ~221 | 0 | 0 | tightly coupled to master chat |
| vault | wireVaultTab @ 2454 | ~311 | `openVaultDeepLink` | 0 | exposes deep-link for projects |
| orchestration | wireOrchCameraGrid + wireOrchestrationCockpit + wireWatchdogPanel @ 2765 | ~987 | `__subctlOpenTmuxPreview`, `__subctlCopyAttachCommand`, `__subctlOpenWebTerminal`, `__subctlWireWebTerminalGate`, `notice` | 0 | exposes 4 globals consumed by dashboard panels |
| models | wireModelsTab @ 3752 | ~111 | 0 | 0 | none — smallest |
| projects | wireProjectsTab @ 3863 | ~468 | `__policyPresetsCache` (own cache) | `openVaultDeepLink` | depends on vault |
| memory | wireTier1MemoryCards + wireMemoryTab + wireEvyMemoryCard @ 4331 | ~278 | 0 | 0 | none |
| **master chat** | wireMasterChat @ 4609 | **1,385** | `__subctlVoiceEnabled` (own) | `__subctlPushNotification` | biggest, deepest SSE entanglement |
| dashboard panels | renderOrchSidecar/Orchestrations/Sessions/Cost/RateLimits/Events/Conversations @ 5994 | ~904 | 0 | `__subctlOpenTmuxPreview`, `__subctlCopyAttachCommand` | depends on orchestration |
| sessions search | wireSearchUI + renderSearchResults @ 6898 | ~72 | 0 | 0 | reads audit shared renderer |
| shell (tabs + transport) | wireTabs + setActiveTab + connectWS + startPolling @ 6970 | ~170 | — | — | the spine |
| audit shared | renderAuditEntries @ 7139 | ~163 | 0 | 0 | shared by logs + sessions tabs |
| policy | wirePolicyTab + wirePolicyEditor + form renderers @ 7422 | ~609 | 0 | 0 | own SSE handle `policyEventSource` (line 7115) |
| notification tray | initNotificationTray @ 8031 | ~388 | `__subctlPushNotification`, `__subctlPushActivity`, `notice` | 0 | global chrome — consumed by master chat + orch + others |
| lucide chrome + upstreams | initLucideChrome + initUpstreamsCard @ 8419 | ~250 | — | `subctlIcon` (from icons.js module) | settings-adjacent |
| preferences | initPreferencesTab @ 8669 | ~268 | 0 | 0 | own SSE for `preferences` events |

### Decisions recorded (will be persisted to DECISIONS.md by worker)
- **Plain JS native ES modules, no build step, no new deps.** Bun's existing static handler serves modules; classic-script `app.js` continues unchanged for everything not extracted.
- **No `shared/` directory in PR 1** — first tab inlines its needs; helpers extract on a later PR when a second importer exists. (Doing it now would silently touch every other tab.)
- **Module interface:** `export const id; export async function mount(ctx); export function unmount(ctx); export function refresh(ctx); export function onState(slice);` — `mount`/`unmount` mandatory, others optional.
- **Loader pattern:** ES-module `bootstrap.js` runs after classic `app.js` (defer semantics). On startup, it mounts the already-active tab if extracted. `app.js`'s `setActiveTab(tab)` gets one new line: `window.__subctlShellNotifyTabChange?.(tab)`. Dynamic `import("./tabs/<id>.js")` from bootstrap.
- **No half-finished:** `app.js` deletes the extracted code outright. No stubs, no "TODO hook later". The function and call sites disappear.
- **server.ts edit required:** add `/bootstrap.js` and `/tabs/logs.js` to the `STATIC_FILES` allowlist. Future tab extractions add one line each.
- **Migration order:** Logs → Templates → Models → Preferences → Providers/Vault/Memory/Skills → Projects/Settings/Policy → Teams → Orchestration + Dashboard panels (together) → Master chat (last). Vault must extract before Projects (deep-link dep).

### Task ledger

| ID | Task | State | Worker | Started | Notes |
|----|------|-------|--------|---------|-------|
| W1 | Extract Logs tab to dashboard/public/tabs/logs.js + bootstrap.js shell | dispatched | logs-extract | 2026-05-13T~19:35 CDT | Single feature branch `feat/dashboard-decomp-logs` in main worktree (NO new git worktree). |

### State-ownership ruling (Logs ↔ Policy cross-cut)

The Logs policy-filter chip and the Policy tab share three module-scope locals in today's app.js:
- `let policyAuditTeam = null;` (line 7113) — touched only by the chip → **moves into Logs module closure**
- `let policyEventSource = null;` (line 7115) — touched only by the chip → **moves into Logs module closure**
- `let cachedTeams = [];` (line 7117) — populated by `refreshPolicyTeamsForDropdowns` (line 7249), consumed by both the chip (5 sites) and the Policy tab (1 site) → **stays in app.js, Policy-owned**
- `async function refreshPolicyTeamsForDropdowns()` (line 7249) — populates both `#logs-policy-team` (Logs DOM) and `#policy-resolved-team` (Policy DOM) → **stays in app.js**

To preserve Policy's ownership without forcing Logs to depend on app.js internals, app.js exposes two tiny temporary globals:
- `window.__subctlGetPolicyTeams = () => cachedTeams.slice();`
- `window.__subctlRefreshPolicyTeams = refreshPolicyTeamsForDropdowns;`

Both retire when Policy tab extracts in a later wave. This is **not** a state-ownership change — Policy continues to own `cachedTeams` with identical semantics. Logs just queries through a getter instead of closing over the same variable. The bidirectional DOM coupling (app.js writes `#logs-policy-team`) is preserved temporarily; when Policy extracts, Policy publishes a `teamsUpdated` event and Logs subscribes.

### Worker constraints (in worker prompt)
- May NOT push, merge, or open a PR. Stop after commit.
- May NOT touch any tab other than Logs. May NOT touch master chat, orchestration, dashboard panels, or notification tray.
- May NOT introduce `shared/`. May NOT introduce a build step. May NOT add npm deps.
- May NOT change Policy ownership of `cachedTeams` or `refreshPolicyTeamsForDropdowns`. Those stay in app.js.
- MUST verify the test plan items end-to-end before reporting done.

### Verification evidence — wave 1 complete

**Worker commit:** `3f58f03` on `feat/dashboard-decomp-logs` — `refactor(dashboard): extract Logs tab to ES module — decomposition wave 1`. Worker went idle without sending the structured report-back message; orchestrator self-verified per protocol rule 6.

**Structural gates (all pass):**

| Gate | Expected | Actual |
|---|---|---|
| `app.js` LOC delta | shrink ~250 | 8955 → **8646** (−309) |
| `grep -c 'wireLogsTab\|wireLogsPolicyChip\|policyAuditTeam\|policyEventSource' app.js` | 0 | **0** |
| `grep -c cachedTeams app.js` (Policy retains) | >0 | **9** |
| `grep -c refreshPolicyTeamsForDropdowns app.js` (Policy retains) | ≥2 | **4** (def + call + 2 references) |
| Bridge globals (`__subctlGetPolicyTeams`/`Refresh`/`RenderAuditEntries`) published in app.js | 3 | **3** |
| `__subctlShellNotifyTabChange` call in `setActiveTab` | 1 | **1** |
| Bridge consumption in `tabs/logs.js` | ≥3 distinct | **5 call sites** across 3 distinct bridges |
| `server.ts` STATIC_FILES entries for `/bootstrap.js` + `/tabs/logs.js` | 2 | **2** (lines 1601-1602) |
| `index.html` script tag order | `bootstrap.js` before `app.js` | ✓ lines 1609 (module) → 1610 (classic) |
| `node --check bootstrap.js` | clean | **OK** |
| `node --check tabs/logs.js` | clean | **OK** |

**End-to-end MIME smoke (live `PORT=8799 bun dashboard/server.ts`):**
```
HTTP/1.1 200 OK  Content-Type: application/javascript; charset=utf-8  content-length: 2176   /bootstrap.js
HTTP/1.1 200 OK  Content-Type: application/javascript; charset=utf-8  content-length: 15498  /tabs/logs.js
```

**State-ownership decision held:** `cachedTeams` and `refreshPolicyTeamsForDropdowns` remain in app.js; `policyAuditTeam` and `policyEventSource` migrated into the module closure. Bridge globals retire when Policy tab extracts.

**DECISIONS.md updated:** worker appended a `2026-05-13 night — dashboard decomposition wave 1` entry with the module interface, loader strategy, state-ownership ruling, and migration order.

**Not done in this session (deliberately):**
- No browser-level UX test (clicking around Logs, exercising SSE reconnect, etc.). Worker's spec required it; their idle-without-report leaves it unconfirmed. Operator should hard-refresh and exercise Logs tab once at the next dashboard visit. Falls back to "feature branch unmerged" — no production exposure until operator merges.
- No push, no merge. Branch sits local on `feat/dashboard-decomp-logs` awaiting operator decision.
- No worker-spawned worktree. Work happened in the main worktree, branch-isolated.

### Wave 1 closed; loop terminated.

The 10-min status cron (`d7420c37`) was cancelled at completion. No further worker dispatches this session unless operator opens a new wave.

### Post-wave infra split — daily-driver dashboard decoupled from dev tree

**Trigger:** Operator flagged that his local dashboard "doesn't update from what you're working on" and that he didn't want to be "locked into [the] local one always sitting on the development code." Investigation showed `~/Library/LaunchAgents/com.subctl.dashboard.plist` pointed `ProgramArguments` directly at `/Users/you/code/subctl/dashboard/server.ts` — the dev tree. ANY branch checkout in that path would change what the daemon would serve on next restart. There was no separate install copy.

**Operator's choice via AskUserQuestion:** Option A — separate install worktree.

**Executed (operator-authorized):**
1. `git worktree add ~/.local/lib/subctl-install main` — new worktree pinned to `main` (currently at `dd958ba`, v2.8.5).
2. `cd ~/.local/lib/subctl-install/dashboard && bun install` — vendor deps (xterm.js + addon-fit + smol-toml + lucide + node-pty) installed in the install tree's `node_modules/`.
3. Backed up plist to `~/Library/LaunchAgents/com.subctl.dashboard.plist.bak-20260513-211858`.
4. `/usr/libexec/PlistBuddy -c "Set :ProgramArguments:2 /Users/you/.local/lib/subctl-install/dashboard/server.ts"` — repointed the launchd job at the install tree.
5. `launchctl bootout gui/$UID/com.subctl.dashboard` then `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.subctl.dashboard.plist`.
6. **Killed PID 1473** (the long-running v2.7.7-in-memory daemon from May 12 that HANDOFF.md had flagged as "don't restart — only working reference"). Replaced with PID 94317 running from the install tree at v2.8.5.

**Verification (post-switchover):**
- `curl http://localhost:8787/api/version` → `{"version":"2.8.5"}` ✓
- `curl -I http://localhost:8787/bootstrap.js` → `404` ✓ (proves install tree is on `main`, NOT the feature branch — wave-1 changes are isolated to `~/code/subctl`)
- index.html on :8787 has only `<script src="/app.js">` — no `bootstrap.js` script tag ✓
- `ps -ef` confirms `PID 94317 bun run /Users/you/.local/lib/subctl-install/dashboard/server.ts` ✓

**Test-the-branch path established:** `cd /Users/you/code/subctl && PORT=8788 bun run dashboard/server.ts` runs the dev tree on a sibling port. PID 97068 currently serves this — `:8788/bootstrap.js` returns 200, index has both script tags. Operator browses `http://localhost:8788` to verify wave-1 without touching daily-driver `:8787`.

**Deploy flow (until a CLI verb is wired):**
```
cd ~/.local/lib/subctl-install
git pull origin main          # or git merge a feature branch after operator approves
launchctl kickstart -k gui/$UID/com.subctl.dashboard
```

**Loss accepted:** PID 1473's in-memory v2.7.7-era account data is gone. Operator chose this explicitly; HANDOFF.md's "don't restart" caveat is retired.

**Lossless rollback path:** `cp ~/Library/LaunchAgents/com.subctl.dashboard.plist.bak-20260513-211858 ~/Library/LaunchAgents/com.subctl.dashboard.plist && launchctl bootout gui/$UID/com.subctl.dashboard && launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.subctl.dashboard.plist`. Won't restore PID 1473's in-memory state — that's gone — but restores the plist to dev-tree-pointing as before.

**Follow-up parking lot (not done tonight):**
- Add `subctl dashboard deploy` CLI verb wrapping the deploy flow above.
- Apply same split to M3 Ultra (`com.subctl.master` + `com.subctl.dashboard` there). Currently M3's daemons read from a remote git checkout at `/Users/you/code/subctl` over its SSH session; the same lock-in risk applies if a future session does branch work on M3.
- Add the install-tree pattern to `install.sh` for fresh installs so this isn't a manual surgery for the next operator.
- The `DECISIONS.md` architectural-call entry for this split lives only in ORCHESTRATION.md for now; should be promoted to a proper DECISIONS.md entry on the next merge to `main`.

---

## Session 2026-05-13 evening — close HANDOFF.md open issues (Claude Opus 4.7, 1M ctx)

**Protocol start:** 2026-05-13T~18:36Z (CDT)
**Branch:** `main` @ `da3578a` (v2.8.5)
**Mode:** Orchestration + autonomous within approved scope.

### Mission
Close the three open issues that carried over from the 2026-05-12 night session per HANDOFF.md §2:
- §2.1 notification dropdown CSS fix verification
- §2.2 accounts shows zeros on M3 dashboard
- §2.3 OSINT Telegram alerts firing every 30 min

Sequencing: 2.3 first (operator was actively being paged), then 2.2 (trust-corrosive), then 2.1 (verification of already-shipped fix).

### Pre-conditions (verified at session start)
- Main at v2.8.5. Dashboard daemon on M3 at v2.8.5, master daemon at v2.8.4.
- ~22 orphan worktrees from last night, all branches merged. Not cleaned (housekeeping out of primary scope).
- Existing ORCHESTRATION.md was the 2026-05-09 stage-2 log (clawd → subctl master). Stale for new work — rewrote it (this file).
- claude-mem hook reports 500 due to `pending_messages.retry_count` migration bug. Fixed via SQL ALTER (recurrence of bug from 2026-05-05). Memory entry updated.

### Task ledger

| ID | Task | State | Resolution |
|----|------|-------|------------|
| 2.3 | OSINT Telegram alerts firing | ✅ closed | Inbox archived + master restarted on M3. Root cause: tmux pruner silently no-ops because tmux not in launchd PATH AND tmux server wasn't running. Permanent code fix queued as Task #5. |
| 2.2 | Accounts zeros on M3 | ✅ closed (b) | Confirmed architectural per operator amendment. Documented in DECISIONS.md. Observability follow-up queued as Task #6. |
| 2.1 | Notif dropdown CSS fix | ✅ closed | Verified `.notif-tray[hidden] { display: none }` deployed at style.css:4469 with correct specificity. Only remaining variable: operator browser cache (hard-refresh required). |

### Verification evidence

**2.3** — `curl http://localhost:8788/health` on M3 post-restart returned `{"teams_tracked": 0, "version": "2.8.5", "telegram_listener": {"running": true}}`. `/teams` returned `{"ok": true, "teams": []}`. Inbox file relocated to `~/.config/subctl/master/inbox.archive/claude-osint-cve-monitor.killed-20260513-185255.jsonl`. As a side effect of `launchctl kickstart -k`, master picked up v2.8.5 from disk — master and dashboard now version-matched.

**2.2** — `subctl usage --json` on M3 returns `[{alias: claude-jason, ok: false, error: "no .credentials.json..."}, {alias: claude-titanium, ok: false, error: "...429..."}, {alias: claude-semfreak, ok: false, error: "...429..."}, ...]`. Categorized: claude-jason has no creds on M3 (host locality); claude-titanium/semfreak are rate-limited by Anthropic's `/api/oauth/usage` endpoint due to dual-poll contention with local Mac dashboard.

**2.1** — `curl http://localhost:8787/style.css | grep -n notif-tray` on M3 confirms the v2.8.5 fix rule at line 4469. Specificity computation: `.notif-tray` = (0,0,1,0); `.notif-tray[hidden]` = (0,0,2,0) → fix wins. JS handler at app.js:8323 correctly toggles `tray.hidden`.

### Decisions made (logged to DECISIONS.md)
- Framework migration deferred (no Svelte/React/HTMX/SvelteKit this session).
- `app.js` per-tab split deferred to a focused session after open issues closed.
- Voice-layer refinement is a separate v2.8.x track.
- Multi-host account-usage rework is v2.9.0+ scope; this session ships observability only (queued as Task #6, not done in this session).
- Permanent fix for 2.3 (callback wiring + eviction route) queued as Task #5, not urgent now that alerts are silenced.

### Not done this session
- No worker dispatches via `Agent + team_name`. The investigation work plus immediate fixes were small enough for the orchestrator to do directly (within the "5 lines or less" allowance for the actual ops on M3). Tasks #5 and #6 are queued as worker-bound for next session.
- No worktree cleanup (~22 orphans on local Mac).
- No source edits to dashboard/server.ts, master/server.ts, or app.js. All fixes were operational (file moves, service restart, SQL migration).

### Workers used
None. All work was orchestrator-driven: read → diagnose → operate on M3 via SSH → verify via HTTP API.

---

## Historical: Session 2026-05-09 — subctl master stage 2

**Session:** subctl-master-stage2
**Orchestrator:** pane 0 (Claude Opus 4.7, 1M ctx)
**Protocol start:** 2026-05-09T18:50:00Z

### Mission

Stage 2 of clawd (the master orchestrator daemon). Stage 1 shipped the
scaffold + tool catalog + master SKILL in commit `4b18be0`. Stage 2
wires the pi-agent-core SDK into the daemon, adds the master Telegram
bot listener, and ships `subctl master` CLI verbs + install integration.

End state: daemon boots end-to-end on Jason's M3 Studio Ultra; he runs
`subctl master enable` once, the launchd plist takes over, and clawd is
always-on with a dedicated Telegram channel.

## Approved scope (2026-05-09)

Operator authorization received: orchestration mode + autonomous + team
agents go-signal in same message. No further approval gates inside this
ticket — orchestrator dispatches workers, verifies their work, commits.

Operator-only escalation triggers (per master SKILL):
- Push to main / merge PR  / production change  → escalate, never auto
- Cost: third escalate-tier API call without operator ack → pause

Boundaries unchanged from stage 1:
- No source edits by orchestrator (workers do all editing)
- All workers spawn via TeamCreate + Agent with team_name (visible panes)
- Verify every worker deliverable with a tool call before marking done

## Pivot — 2026-05-09T19:10Z

Initial dispatch via Agent + team_name failed: Claude Code's iTerm2 native-pane integration didn't activate (TMUX env var was empty in the orchestrator process; team agent panes had no terminal binding). The team config was registered but tmuxPaneId was empty for all three workers — they never spawned as processes.

**Pivot:** dispatch via `subctl orch spawn` instead. Each worker becomes a real tmux session (visible via `tmux attach -t claude-<basename>` and `subctl orch list`). Coordination shifts from team-agent message bus to subctl notify + branch-per-slice.

## Task Ledger

| ID | Task | State | tmux session | Account | Started |
|----|------|-------|--------------|---------|---------|
| S2-A | Wire pi-agent-core SDK into server.ts | running | claude-subctl-s2a-sdk-wiring | claude-titanium | 2026-05-09T19:35Z |
| S2-B | Master Telegram listener + CLI verbs + launchd plist | running | claude-subctl-s2b-cli-listener | claude-jason | 2026-05-09T19:35Z |
| S2-C | install integration (settings.sh, install.sh, docs) | running | claude-subctl-s2c-install-wiring | claude-semfreak | 2026-05-09T19:35Z |
| S2-V | Integration verification + merge | pending | (orchestrator) | — | — |

## Worktrees (one per slice — non-overlapping git working trees)

```
/Users/you/code/subctl                              feat/codex-provider          (orchestrator)
/Users/you/code/subctl-s2a-sdk-wiring               feat/master-stage2-sdk-wiring (S2-A worker)
/Users/you/code/subctl-s2b-cli-listener             feat/master-stage2-cli-listener (S2-B worker)
/Users/you/code/subctl-s2c-install-wiring           feat/master-stage2-install-wiring (S2-C worker)
```

Each worker commits + pushes its slice branch. Orchestrator merges all three into feat/codex-provider after verification, then runs `git worktree remove` cleanup.

## Coordination

- Workers report completion via `subctl notify "S2-X complete..."` (Telegram digest)
- Workers do NOT merge to feat/codex-provider — orchestrator handles integration
- If blocked: workers fire `subctl notify ask-yesno "S2-X blocked: <q>"` and wait
- Orchestrator polls all three pane states every ~30 min via `tmux capture-pane`

## Stage 3 backlog — design lifts from cth9191/agentic-os-dashboard

Captured 2026-05-09 after operator review of AgenticOS dashboard (Streamlit + Plotly, ~3K LOC, no LICENSE). **Operator decisions:**

- **No Streamlit / no Python.** Keep subctl's existing Bun + vanilla-CSS dashboard stack. The facelift we shipped this morning (signal-green/charcoal aesthetic) is the visual baseline. AgenticOS's orange/copper palette is NOT adopted.
- **No code lifting** — repo has no LICENSE, all-rights-reserved by default. Clean-room implementation of design ideas only.
- **Code-dev scope only.** AgenticOS is a "personal AI operating system" (MEMORY / PRODUCTIVITY / RESEARCH / CONTENT / COMMUNITY / AGENCY / SALES / FINANCE / OPS branches). clawd's scope is **strictly code development orchestration.** Borrowed widgets must reflect dev concerns, not life-OS concerns.

Three widget concepts to add to subctl's dashboard (`dashboard/server.ts` + `dashboard/public/`):

### Widget A — Vault Pulse (dev-scoped)

AgenticOS shows the last N created/updated files in the Obsidian vault. **Our adaptation:** show the last N decision logs + project-portfolio updates the autonomy SKILL has written. Sources:
- `~/Documents/Obsidian Vault/<Project>/Portfolio.md` — last-modified timestamp + delta lines
- `~/.config/subctl/master/decisions.jsonl` — last 10 master decisions (clawd's audit trail)
- Per-project ORCHESTRATION.md edits

Why it matters: the autonomy doctrine REQUIRES vault writes. A pulse view confirms workers + master are actually writing decision logs. If pulse is empty, autonomy isn't recording — silent failure mode worth surfacing.

Implementation: extend `buildState()` with a `vaultPulse: [{path, ts, delta_lines, source}]` array. New section in dashboard HTML between "Active TMUX sessions" and "Active conversations". ~50 lines of Bun + ~30 lines of CSS.

### Widget B — Forecast / burn rate

AgenticOS projects "at this token rate, you'll hit your weekly cap by `<date>`". **Our adaptation:** per-account 5h + weekly burn projection from `subctl_usage_history_24h()` data we already collect, extended to a 7-day rolling window with linear extrapolation.

Why it matters: subctl's radar shows current %; this answers "if I keep this pace, when do I hit the wall?" — actionable for dispatch decisions.

Implementation: extend `buildState()` per-account with `forecast: { hours_until_5h_cap, days_until_weekly_cap, current_burn_rate_tokens_per_min }`. Renders as a thin line above each account's existing 5h bar. ~30 lines.

### Widget C — Cumulative activity chart (30d)

AgenticOS has a 30-day cumulative token-usage area chart. **Our adaptation:** 30-day cumulative chart of (a) PRs opened, (b) PRs merged, (c) commits to projects in the master's portfolio, (d) sessions spawned. Token count is secondary; what matters is *did the projects actually advance.*

Why it matters: tells the operator at a glance whether work has been moving over the past month, independent of any single session.

Implementation: extend usage-history poller to also record per-day project-advancement metrics (poll via `gh` CLI per project). Render as multi-series area chart with the existing radial-gradient aesthetic. Largest of the three widgets — ~150 lines + chart library if vanilla SVG isn't enough (vanilla is fine for a 30-point series).

### Out of scope — explicit rejections

- AgenticOS's "skill button" pattern (click → shells out to `claude` CLI). We have subctl orch + MCP tools. Adding click-to-run is parallel paths and bypasses subctl's account routing.
- AgenticOS's MEMORY / PRODUCTIVITY / RESEARCH / CONTENT / COMMUNITY / AGENCY / SALES / FINANCE / OPS taxonomy. That's life-OS scope; lives in Argent, not clawd.
- Streamlit / Python anywhere. Keep the Bun + vanilla stack.
- Orange/copper aesthetic. Keep the charcoal + signal-green palette from this morning's facelift.

### When to ship stage 3

After stage 2 (this current orchestration) lands and clawd is verified end-to-end. Probably next dev session. Three widgets are independent — can ship one at a time, no big-bang merge needed.

## Improvements to EXISTING surfaces (not new widgets)

Operator clarification 2026-05-09: not asking for code lifts; asking for concepts that improve what subctl/clawd already have. Five upgrades visible in cth9191's screenshots that are genuinely better than what we ship today:

### 1. Polling cadence axis in `policy.json`

AgenticOS marks branches as "FOUNDATIONS · always on" vs "CAPABILITIES · modular". Apply to `policy.json.example` per-project: add a `polling_cadence` field — `every_review` (master walks this project every cycle) | `daily` (once per 24h) | `on_demand` (only when operator asks). Refines today's `autonomy_level` (drive/ask/shadow) by adding a how-often axis on top of the how-much axis. ~10 lines of doc + the master loop respecting it.

### 2. Integrations status strip on the dashboard

AgenticOS shows GitHub:Github, Gmail, Google Drive, Google Calendar with green/red dots. Our equivalent for code-dev scope: **GitHub** (`gh auth status`), **Telegram master-bot**, **Telegram notify-bot**, **Anthropic accounts** (per-alias, count of ready/total), **OpenAI Codex OAuth**, **CodeRabbit**, **MLX server / Ollama**. One row at the top of the dashboard with green/amber/red dots. Answers "is everything wired up right now" in <1 second. ~40 lines extending `buildState()`.

### 3. Scheduled-events ticker

AgenticOS shows "VAULT COMPACT · IN 1H 23M / MORNING BRIEF · IN 12H 23M". Our adaptation: countdown to (a) next master review tick, (b) each account's 5h cap reset, (c) any cron jobs the operator has set, (d) launchd auto-restart timers. Replaces "next thing happens at some point" with concrete "in Xm Ys". ~30 lines.

### 4. Browser-based prompt for clawd

AgenticOS has "RUN A SKILL TO BEGIN" textarea at the top. Our adaptation: when clawd is enabled, show a textarea on subctl's dashboard that POSTs to clawd's HTTP endpoint (the same surface `subctl master prompt "..."` calls). Operator can talk to clawd from a browser tab without dropping to terminal. ~25 lines (textarea + POST handler in dashboard server + clawd's HTTP intake — already on the stage-2 list for cli-listener worker).

### 5. Burn rate (tokens/min) alongside accumulated %

AgenticOS shows "BURN · 3.1M/MIN". Subctl's radar shows accumulated %. The instantaneous rate makes "is this rate sustainable for the next hour" calculable. ~20 lines extending the existing usage poller to compute a rolling burn-rate.

### Composition

Items 2 + 3 + 5 share the same dashboard real estate (top strip + per-account row). Could ship as one PR. Item 1 is policy schema only — independent. Item 4 needs clawd's HTTP API to exist (stage 2 prerequisite). Total estimated effort if shipped together: one focused dev session.

## File scopes (non-overlapping — enforced)

- **S2-A (sdk-wiring):** `components/master/server.ts`, optionally `components/master/agent-loop.ts`
- **S2-B (cli-listener):** `components/master/master-notify-listener.ts`, `lib/master.sh`, `bin/subctl` (1 dispatch line only), `components/master/launchd/com.subctl.master.plist`
- **S2-C (install-wiring):** `lib/settings.sh`, `install.sh`, `components/skills/subctl/SKILL.md`, top-level `README.md`

## Decision Log

- **2026-05-09T18:50Z** — Activate orchestrator-mode skill per Jason's explicit invocation. Author 3 parallel slices because file scopes are clean and stage 2 work is genuinely independent.
- **2026-05-09T18:50Z** — Daemon identity initially proposed as `clawd` (lowercase). CLI surface: `subctl master`. Two-bot model: master-bot for strategic chat, existing notify-bot for tactical worker escalations.
- **2026-05-09T18:50Z** — pi-agent-core@0.74.0 installed in components/master/node_modules at stage 1. SDK source available locally for the sdk-wiring worker to inspect.
- **2026-05-09T20:30Z** — Operator REJECTED `clawd` daemon name (no recognition of the term, didn't authorize it). Named the daemon **`subctl master`** with NO persona — CLI verb is the name. Telegram bot persona TBD at BotFather registration time. After stage 2 lands, orchestrator does a global rename `clawd → subctl master` across docs/comments/identifiers.
- **2026-05-09T20:30Z** — Operator confirmed: design ideas from cth9191/agentic-os-dashboard are fair to borrow (we own the implementation). Naming conventions are NOT borrowed. AgenticOS's "Conductor" framing is OFF the table. Off-limits names: Titan Agent (operator's own different project), ClawdBot/clawd (rejected), Conductor/Pilot/Captain (borrowed terms from other systems). Keep `subctl master` strictly literal.
- **2026-05-09T20:30Z** — Linear MCP confirmed available + probed. Operator authed as Jason Brashear, 1 team (Webdevtoday, key WEB), 14 projects (HoLaCe-heavy + AOS + Onboarding/Content workstreams). NO Linear project yet for subctl, ampcortex, trading-ai, or subctl-master. Stage 3 plan: per-project `linear_project_id` in policy.json, master queries Linear for in-flight issues, worker status updates flow back to Linear, Telegram digests reference WEB-XXX issue numbers. Auto-creating Linear issues from worker output is OUT of scope (Linear is operator-curated, not system-noise).
- **2026-05-09T20:30Z** — Scope assumption explicitly reaffirmed: subctl master is **strictly code development orchestration.** Not personal AI OS, not life management, not content factory, not generalized assistant. SKILL.md mandate stays tight on this through the rename.

- **2026-05-09T21:15Z** — Diagnosed the orchestrator-mode-deadlock root cause after digging into mattpocock/skills + affaan-m/everything-claude-code (MIT, 176K stars). Our `~/.claude/skills/orchestrator-mode/SKILL.md` is a role-asserting meta-skill with soft phrase-match activation ("use team agents", "delegate this across workers"). When a worker prompt mentions those phrases (incidentally, while describing the parent context), the worker self-loads the skill, asserts orchestrator role, then waits forever for approval to dispatch sub-workers. This is what bit S2-C tonight and AMP Cortex R1 yesterday. Five-fix plan added to stage 3 backlog: (1) SUBCTL_AGENT_ROLE=worker env var + skill guard, (2) auto-prepend "you are a worker" preface to subctl orch spawn prompts, (3) tighten orchestrator-mode trigger phrases to operator-only, (4) lift affaan-m's "instincts" YAML pattern (MIT-licensed, fair to lift) for narrow guardrails complementing SKILL.md files, (5) stuck-state detection in clawd's review loop as safety net. None applied tonight — workers still mid-flight on stage 2; perturbing global SKILLs now is risky. Apply after S2-C lands.

## Verification Evidence

### Stage 2 — landed 2026-05-09T~21:30Z

**All three workers completed and pushed within ~2h of dispatch.** Merged into `feat/codex-provider` cleanly, no conflicts.

| Slice | Branch | Commit | Files (vs base) |
|---|---|---|---|
| S2-A | `feat/master-stage2-sdk-wiring` | `bb4c7929` | server.ts (+278), bun.lock (+7), package.json (+3) |
| S2-B | `feat/master-stage2-cli-listener` | `e285f4b6` | master-notify-listener.ts (+520), lib/master.sh (+320), launchd plist (+65), bin/subctl (+5) |
| S2-C | `feat/master-stage2-install-wiring` | `9ca44269` | lib/settings.sh (+25), install.sh (+4), components/skills/subctl/SKILL.md (+42), README.md (+13) |

**Zero file overlap.** Workers stayed in their lanes per CONSTRAINTS in their prompts.

### Integration verification (orchestrator-driven, post-merge)

| Check | Command | Result |
|---|---|---|
| Shell syntax | `bash -n` on lib/master.sh, lib/settings.sh, install.sh, bin/subctl | ✅ all 4 |
| Plist lint | `plutil -lint components/master/launchd/com.subctl.master.plist` | ✅ OK |
| Daemon build | `bun build server.ts` | ✅ 4.42 MB, 98ms, 1982 modules |
| Listener build | `bun build master-notify-listener.ts` | ✅ 11.98 KB, 2ms |
| Install dry-run #1 | `bash install.sh --dry-run` | ✅ step 4d "installing master daemon" present |
| Install dry-run #2 | re-run | ✅ idempotent, clean |
| CLI dispatch | `subctl master help` | ✅ all 9 verbs documented |

### Merge tree

```
*   2f7b5e4 Merge S2-C — install integration
|\
| * 9ca4426 feat(master): install integration (S2-C)
* |   3122fc5 Merge S2-B — Telegram listener + CLI verbs + launchd plist
|\ \
| * | e285f4b feat(master): Telegram listener + CLI verbs + launchd plist (S2-B)
| |/
* |   7632ac0 Merge S2-A — pi-agent-core SDK wiring
|\ \
| |/
| * bb4c792 feat(master): wire pi-agent-core SDK in clawd daemon (S2-A)
|/
* 4b18be0 feat(master): scaffold clawd — the dev-team conductor (v0.1.0)
```

### Stage 2 ledger — final

| ID | Task | State | Worker | Started | Finished |
|----|------|-------|--------|---------|----------|
| S2-A | Wire pi-agent-core SDK into server.ts | ✅ done + merged | sdk-wiring | 2026-05-09T19:35Z | ~20:30Z |
| S2-B | Master Telegram listener + CLI verbs + launchd plist | ✅ done + merged | cli-listener | 2026-05-09T19:35Z | ~20:30Z |
| S2-C | install integration (settings.sh, install.sh, docs) | ✅ done + merged | install-wiring | 2026-05-09T19:35Z | ~21:00Z (after orchestrator-mode-deadlock unstick at 20:30Z) |
| S2-V | Integration verification + merge | ✅ done | orchestrator | 21:15Z | 21:30Z |

### Remaining cleanup (NOT done in stage 2 — needs operator authorization)

1. **Rename pass** `clawd` → `subctl master` across server.ts header comment, README.md, master SKILL.md, master-notify-listener.ts comments, lib/master.sh help text, components/skills/subctl/SKILL.md "Master daemon (clawd)" section header. ~5 minutes search-replace; orchestrator-mode forbids source edits, so either operator authorizes orchestrator to exit mode for this OR spawn a 4th tiny worker.

2. **Worktree cleanup:** `git worktree remove subctl-s2{a,b,c}-*`. Trivial — orchestrator coordination work.

3. **Stage-3 fixes** for the orchestrator-mode-deadlock (5 fixes documented in decision log on 2026-05-09T21:15Z): SUBCTL_AGENT_ROLE env var + skill guard, worker-preface auto-prepend, tightened trigger phrases, instincts YAML pattern, clawd stuck-state detector. Each is a separate task post-stage-2.
