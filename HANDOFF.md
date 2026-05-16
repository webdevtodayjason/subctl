# HANDOFF.md — session 2026-05-15 / 2026-05-16

**Operator:** Jason Brashear
**Hosts:** M3 Ultra (Tailscale `100.84.108.16`, LAN `192.168.100.98`) + local MacBook Pro (this machine, 128 GB)
**Branch:** `main` @ `68058e4` (Evy broad eval rubric) · **Repo:** webdevtodayjason/subctl
**VERSION file:** `2.8.6`
**Next phase:** operator returns from mowing, runs broad eval rubric smoke test, decides whether to act on tool registry audit findings

## Autonomous session summary (2026-05-16)

Operator authorized full autonomous mode at ~07:15. After an early "you stopped too fast" callout, the autonomous session ran for another extended block. The following commits landed without per-step approval across the full window:

### Block 1 (initial autonomous burst)
| SHA | Title |
|---|---|
| `b9bd182` | fix(catalog): lazy-eval SUBCTL_CONFIG_DIR — prevents future test pollution |
| `aa3046e` | perf(master): cache_prompt: true for LM Studio via pi-ai onPayload hook (~55% faster warm turns expected) |
| `7ad012d` | feat(catalog): Phase 2d — live refresh for openai, google, mistral |
| `68058e4` | docs(persona): broad eval rubric — 20 lightweight tests across 5 categories |
| `9b80c97` | docs(handoff): autonomous session summary (this section's predecessor) |

### Block 2 (after operator's call-out + continuation)
| SHA | Title |
|---|---|
| `2d2f262` | fix(status): widen PROVIDER column 9→13 for openai-codex alignment |
| `8e564fa` | perf(tools): Tier-2 lazy registration — gate 7 tool families on env/config (88→65 tools) |
| `6ef1cd9` | test: cover text-sanitize, codex-oauth, catalogs modules (39 tests, all passing) |
| `af6318e` | test(cli): read VERSION dynamically — stop hardcoding 2.7.36 |
| `f418b3f` | feat(catalog): per-model enabled toggle in Models panel |
| `24e0d1e` | feat(chat): chat dropdown honors default_model's enabled flag |
| `818c823` | docs(knowledge): refresh subctl.toon — v2.7.7 → v2.8.9 sweep |

### Vault updates (autonomous)
- `Daily Updates/2026-05-16.md` (new)
- `Audits/2026-05-16 — Tool Registry Audit.md` (new)
- `01 - Current State.md` (refreshed)
- `05 - Decisions Log.md` (appended 6 architectural decisions)
- `07 - Initiative History.md` (entry for today's work)
- `Lessons Learned/2026-05-16 - Tmux argv lies.md` (new)
- `Lessons Learned/2026-05-16 - Lazy-eval env vars in path helpers.md` (new)
- `Lessons Learned/2026-05-16 - Centralise text sanitisation when N outbound surfaces exist.md` (new)

### Communications
Four Telegram updates to @Semfreakbot (msg_ids 65-68) across the autonomous window.

### Pollution cleanup
The accidentally-set `anthropic → claude-opus-4-7` from my smoke test was cleared mid-session. `provider-defaults.json` contains only the operator's actual choice: `openai-codex: gpt-5.5`.

### Tests
- 39 new tests pass cleanly (text-sanitize 10 + codex-oauth 14 + catalogs 15)
- Full suite: **1247 passing**, 23 pre-existing failures (CLI integration tests requiring running infrastructure — not regressions from this session)

### Tool registry impact
- Pre-Tier-2: 88 tools registered every turn
- Post-Tier-2: **65 tools live** for current operator config
- Boot log: `[master] tool gates: gh=on, coderabbit=off, context7=off, linear=off, tinyfish=off, voice=off, skillRouter=off`
- ~4600 prompt-prefix tokens saved per turn

### Things deliberately NOT done in autonomous mode
- No tool removals (only gating — operator judgment required for full removals per the audit doc)
- No VERSION bump or git tag (operator should pick when to ship a release)
- No CodeRabbit review (manual operator-triggered)
- No GitHub PR creation (per the "explicit auth required" rule that's saved as a feedback memory)

---

**Previous handoff context preserved below.**

Every claim below is marked **[VERIFIED]** (observed/curl'd this session) or **[ASSUMED]** (likely true but not directly checked at handoff time). Don't trust [ASSUMED] without re-checking.

---

## 0. Read first

If you're a fresh Claude Code session, your fastest ramp is:

1. This file (you're here)
2. Run the health-check block in §1 below to verify nothing drifted
3. Greet the operator with "what did you find?" — this phase is operator-driven

The Obsidian vault at `/Users/sem/Documents/Obsidian Vault/Subctl/` is the deeper reference:
- `01 - Current State.md` — live snapshot (parallel to this file, refreshed same time)
- `03 - Architecture.md` — module ownership map (where does X live)
- `07 - Initiative History.md` — wave-by-wave decomposition ledger
- `Lessons Learned/` — judgment-level takeaways from the decomposition

---

## 1. State at handoff (snapshot 2026-05-15 ~6:15 AM CDT)

### Quick health-check (run this first)

```bash
cd /Users/sem/code/subctl
git log --oneline -5
cat VERSION                         # 2.8.6
curl -sS http://127.0.0.1:8787/api/version   # local dashboard
ssh sem@100.84.108.16 'curl -sS http://127.0.0.1:8787/api/version'   # M3 dashboard
ssh sem@100.84.108.16 '/usr/bin/curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8788/health'   # M3 master
```

Expected: top commit `6e1ce0d`, VERSION `2.8.6`, both dashboards return `{"version":"2.8.6"}`, M3 master `/health` returns `200`.

### Daemons at handoff

| Host | Service | Version (reported) | Code source | PID notes |
|---|---|---|---|---|
| Local Mac | `com.subctl.dashboard` | `2.8.6` | `~/.local/lib/subctl-install/dashboard/server.ts` | Kickstarted post-bugfix at `6e1ce0d`. **[VERIFIED]** |
| M3 Ultra | `com.subctl.dashboard` | `2.8.6` | `~/.local/lib/subctl-install/dashboard/server.ts` | Kickstarted this morning at `6e1ce0d`. **[VERIFIED]** |
| M3 Ultra | `com.subctl.master` | `2.8.5` in memory | `~/.local/lib/subctl-install/components/master/server.ts` on disk | Daemon hasn't been kickstarted since the VERSION bump. PID 27432 (or successor). `/health` returns 200. **[VERIFIED]** — restart to converge when convenient |
| M3 Ultra | `com.subctl.tts` | running (VoxCPM2) | `~/code/subctl/services/tts/server.py` | **[VERIFIED]** still dev-tree-locked; out of scope this session |
| Local Mac | `com.subctl.tts` | n/a | n/a | Local Mac doesn't run TTS |

### Plist backups for rollback (M3)

```
~/Library/LaunchAgents/com.subctl.dashboard.plist.bak-20260515-055638
~/Library/LaunchAgents/com.subctl.master.plist.bak-20260515-055638
```

Restoring is the symmetric procedure: `mv .bak* .plist; launchctl bootout && launchctl bootstrap`.

### Repo state

- `main` @ `6e1ce0d` (origin in sync)
- Working tree: dev tree on `feat/dashboard-decomp-master` branch label (same SHA as main, harmless leftover from the decomposition session; cleanup blocked because dev tree has it checked out)
- Local Mac install tree (`~/.local/lib/subctl-install`) on `main` at `6e1ce0d`
- M3 install tree (`~/.local/lib/subctl-install` on `sem@100.84.108.16`) on `main` at `6e1ce0d`
- M3 dev tree (`/Users/sem/code/subctl` on `sem@100.84.108.16`) on `dev` branch (label at `6e1ce0d`)

---

## 2. What this session shipped

### Dashboard decomposition (waves 1–14, complete)

Decomposed `dashboard/public/app.js` from **8,955 LOC** (pre-decomposition) to **2,280 LOC** (post-decomposition) — a **74.5% reduction** — across 14 waves over 1.5 days. Each tab now lives in its own ES module under `dashboard/public/tabs/` with a uniform `{ id, mount, unmount }` interface. The `dashboard/public/bootstrap.js` shell loader lazy-imports modules on first tab activation.

Full wave ledger is in Obsidian `Subctl/07 - Initiative History.md`. Summary:

| Wave | Tab | Commit | LOC delta | Pattern proven |
|---|---|---|---|---|
| 1–4 | Logs, Templates, Models, Preferences | (prior session) | −715 | Interface + lazy-loader + listener-lifecycle |
| 5 | Providers | `edc0b73` | −269 | Self-contained extraction |
| 6 | Vault | `27000b5` | −309 | **Window-global publisher pattern** (`window.openVaultDeepLink`) |
| 7 | Memory | `6597668` | −281 | Multi-entry function collapse (3 sub-fns → 1 mount). **75-min outlier.** |
| 8 | Skills | `d926d58` | −403 | Dead-bridge preservation |
| 9 | Projects | `52e2ae2` | −462 | Dual-role: consumes Vault's bridge + owns its own cache |
| 10 | Settings | `44aa618` | −528 | Operator-driven refresh (no pollTimer) |
| 11 | Policy | `e8bbd30` | −709 | **Inter-module DOM event contract** retires wave-1 `window.__subctl*` bridges. First wave to modify a shipped module (`tabs/logs.js`). |
| 12 | Teams | `7236f34` | −316 | Simple isolated extraction |
| 13 | Orch | `9368ccf` | −900 | **5-globals batch publishing** (modal helpers). HANDOFF "joint with Dashboard panels" plan deviated — Dashboard panels are shell rendering infrastructure, not a tab. |
| 14 | Chat | `3cc7757` | −1,665 | **FINAL** — Master chat + chat-adjacent helpers. 4 non-contiguous blocks. Biggest module (`tabs/chat.js` = 1,862 lines). |

### Morning sweep (2026-05-15)

| # | Item | Commit | What landed |
|---|---|---|---|
| 2a | `subctl dashboard deploy` CLI verb | `c25018a` | `lib/dashboard.sh` + `bin/subctl` subverb dispatch. Idempotent. `bun install` only when `dashboard/package.json` differs. |
| 2b | M3 install-worktree split | (operational + `c384d7b` docs) | Both M3 daemons (`com.subctl.dashboard` + `com.subctl.master`) now reading from install tree. |
| 2c | `install.sh` install-worktree pattern | `5d5749e` | Fresh installs create `~/.local/lib/subctl-install/` automatically. Dashboard plist points at install tree. `SUBCTL_INSTALL_TREE` env var in `lib/core.sh`. |
| 2d | Worktree branch cleanup | (direct) | 10 of 11 dashboard-decomp feature branches deleted. |
| — | VERSION bump | `dd28286` | 2.8.5 → 2.8.6 to match module headers. |

### Emergent bugfix wave (2026-05-15)

Three bugs surfaced when operator started live-testing v2.8.6:

| Bug | Cause | Fix |
|---|---|---|
| Chat tab apply button did nothing | `window.notice` null at page boot (wave-13 regression — was published from `tabs/orch.js` which doesn't mount until Orchestration tab is clicked) | `8e33f3c` — reclaimed `_showNotice` + `window.notice` publication to `app.js` shell |
| Chat dropdown showed 31 cloud providers | Filter was `kind === "cloud"` only | `6e1ce0d` — added profile-count filter |
| Provider TAB showed 31 cards, 29 empty | Same root cause | `6e1ce0d` — same filter; full catalog stays in "+ New Profile" modal |

---

## 3. The next phase — live testing + enhancement

Operator's framing: "**working with the operator, Jason, to debug and enhance from live testing.**"

The decomposition is shipped. Tonight's bugfix wave was the first live-test pass. The next session is interactive: operator clicks around, identifies issues or enhancement opportunities, and the next Claude session works with them.

### How to handle the first ~5 minutes

1. Run the health check from §1
2. Read `Subctl/01 - Current State.md` in the Obsidian vault
3. Greet the operator with **"what did you find?"** — let them drive
4. For each issue:
   - Identify which module owns the affected functionality (see Obsidian `03 - Architecture.md` for the map)
   - Read that module before touching anything
   - Reproduce the bug if you can (curl against `/api/...` endpoints, grep the rendering logic)
   - One-commit fixes preferred — keep rollback granularity
5. Deploy after each fix: `git push origin main` then `subctl dashboard deploy`

### Likely areas operator may surface issues

Given the decomposition just finished, the most-likely-problematic surfaces are:

- **Tabs that use multi-entry collapse** (Memory, Skills, Settings) — sub-helpers became locals inside mount, so any cross-function scoping subtlety could surface as a bug
- **The wave-11 event contract** (Logs ↔ Policy via `subctl:policy-teams-updated`) — first use of this pattern, could expose race conditions or one-shot ordering quirks
- **Chat tab SSE handling** (Master chat is the biggest module + has multiple EventSources) — listener lifecycle was scaled up significantly
- **Project deep-links** (Projects consumes Vault's `openVaultDeepLink`) — first dual-role tab; worth testing the chain: Projects → "Open in Vault Viewer" → Vault tab activates → hash deep-link routes correctly
- **Master-routed UIs on local Mac** (Memory, Templates, Upstreams, Skills, Preferences) — local Mac has no master daemon, so these proxy 404s. Pre-existing, not a regression. Don't chase those.

---

## 4. Outstanding work (low priority)

### Infra polish

1. **Master plist install.sh wiring** — `install.sh:ensure_install_tree` only handles the dashboard plist's `ProgramArguments`. The master plist still bakes in `$SUBCTL_REPO_ROOT/components/master/server.ts` on fresh installs. Manual M3 surgery this morning fixed it on M3 specifically, but install.sh should match the pattern. ~20 lines.
2. **`com.subctl.tts` plist on M3** — still dev-tree-locked at `~/code/subctl/services/tts/server.py`. Vulnerable to same checkout-changes-running-daemon bug. Either apply the install-tree pattern OR document explicitly that TTS is intentionally pinned to dev tree.
3. **21 orphan worktrees on local Mac** — `subctl-v2.7.21` through `subctl-v2.8.6-skills-redesign`. All branches merged. `git worktree remove <path>` each. 5-minute hygiene.
4. **`feat/dashboard-decomp-master` branch label** on dev tree (same SHA as main; blocks `git branch -d`). Switch dev tree to `dev` label like we did on M3 to delete this leftover.
5. **Master daemon kickstart on M3** — currently running v2.8.5 code in memory; files on disk are at v2.8.6. `launchctl kickstart -k gui/$UID/com.subctl.master` on M3 to converge.
6. **v2.8.6 git tag** — operator's call when ready to mark the formal release.

### Code cleanup

7. **`window.__skillsClarityRefresh` retirement** — confirmed zero in-codebase readers via grep. 3-line delete in `tabs/skills.js` (assignment in mount, null in unmount, top-of-file doc comment line). Tiny worker dispatch.

### Investigations queued

8. **Worker-visibility integration** — the orchestrator-mode skill promises iTerm2 panes when using `Agent` + `team_name`. They never appeared during the 10-wave session. The skill defers to "the Claude Code iTerm2 integration when team_name is set" — meaning an external helper that isn't installed on this Mac. Diagnostic plan in `Subctl/Lessons Learned/2026-05-15 - Worker visibility gap.md`.

### Auth status

- `claude-jason` — **EXPIRED** (`401 Invalid authentication credentials`). Re-auth needed before subctl orch can use it.
- `claude-titanium` — last known ready
- `claude-semfreak` — last known ready (currently leading a paypunch_io orch session)
- `openai-jason` — last known ready
- `openai-titanium` — last known ready

If you need to dispatch a visible-pane worker via `subctl orch spawn`, use `claude-titanium`. Don't burn `claude-semfreak` (busy elsewhere).

---

## 5. Worker silent-idle protocol (still consistent across 12 workers this session)

All 12 workers dispatched this session (10 decomposition + 2 morning-sweep) completed cleanly. None of them sent the structured `SendMessage` report-back the dispatch spec asked for. The "silent-idle" pattern is consistent: verify completion via `git log` on the feature branch + the gate-check commands in the spec.

**Operational implication for next session:** **assume idle == complete-but-silent.** Always self-verify by reading git log and running structural gates. Don't wait for SendMessage that won't come. The wave-7 outlier (75 min) was the only deviation from the 7-22 min envelope; recovery path was `subctl orch spawn` with a known-good account.

---

## 6. Deploy flow (refresher)

### Standard cycle after a feature lands

```bash
# Push origin main (assumes you've already ff-merged into install tree or pushed first)
git push origin main

# Local Mac
subctl dashboard deploy        # idempotent — kickstarts only if origin/main is ahead

# M3
ssh sem@100.84.108.16 'subctl dashboard deploy'    # same idempotent path
```

### Edge case to remember

If you ff-merge directly INTO `~/.local/lib/subctl-install` (instead of pushing to origin first), `subctl dashboard deploy` will detect "already up to date" and skip the kickstart — but the running daemon hasn't loaded the new code. **In that case, manually kickstart:**

```bash
launchctl kickstart -k gui/$UID/com.subctl.dashboard
```

This is documented in Obsidian `Subctl/06 - Known Gotchas.md`.

### Test a feature branch WITHOUT deploying

```bash
cd /Users/sem/code/subctl
git checkout -b feat/<NEW_BRANCH>
PORT=8799 bun run dashboard/server.ts    # browse http://localhost:8799
# Daily driver on :8787 is untouched.
```

---

## 7. Architecture quick reference

`dashboard/public/`:
- `app.js` — shell: state polling, WS transport, render dispatcher, cell builders, notification tray (`_showNotice` + `window.notice`), status pill, lucide chrome, host-label boot, tab nav, upstreams card init. **2,280 LOC.**
- `bootstrap.js` — ES-module shell loader. `TAB_LOADERS` registers 14 tabs. Lazy-imports + memoizes mount per tab.
- `tabs/` — 14 modules, each `{ id, mount, unmount }`.

`dashboard/server.ts`:
- `STATIC_FILES` map registers each `/tabs/*.js` with `application/javascript; charset=utf-8` MIME.

Cross-tab communication (in priority order):
1. **Self-contained** — most tabs
2. **Window-global publisher** — `window.openVaultDeepLink`, `window.__subctlAttachOneShotAssistantCapture`, `window.__subctlOpenTmuxPreview`, etc.
3. **Document-level custom event** — `subctl:policy-teams-updated`, `subctl:policy-teams-refresh-request`

Full ownership map is in Obsidian `Subctl/03 - Architecture.md`.

---

## 8. Files of interest

- `dashboard/public/bootstrap.js` — 14-entry `TAB_LOADERS`
- `dashboard/public/tabs/chat.js` — 1,862 lines, biggest module, master chat + 3 chat-adjacent helpers
- `dashboard/public/tabs/orch.js` — 1,039 lines, modal subsystems + camera/cockpit/watchdog
- `dashboard/public/tabs/policy.js` — 758 lines, event contract publisher
- `dashboard/public/tabs/logs.js` — 504 lines, event contract subscriber + audit renderers
- `dashboard/public/app.js` — 2,280-line shell
- `lib/dashboard.sh` — `subctl dashboard deploy` implementation
- `install.sh:ensure_install_tree` — install-worktree pattern for fresh installs
- `lib/core.sh:SUBCTL_INSTALL_TREE` — env var (override at install time)

---

## 9. Surprising facts worth remembering

1. **Local dashboard's master-routed UIs (Memory, Templates, Upstreams, Skills, Preferences) return 404** because local Mac has no master daemon. NOT a decomposition regression — pre-existing. Don't chase those bugs.
2. **The wave-7 75-minute worker** was a one-off in an otherwise tight 7-22 min envelope. Cause unknown. Don't assume slow == hung.
3. **Wave-13 grouping `window.notice` with modal helpers was an authoring-history artifact, not architecture.** This bit us within 12 hours via the chat-apply silent-fail bug. Lesson saved in `Subctl/Lessons Learned/2026-05-15 - Shell concerns belong in the shell.md`.
4. **Dev tree on local Mac is labeled `feat/dashboard-decomp-master`** but at SHA `6e1ce0d` = same as main. Harmless. Cleanup blocked by worktree-on-branch.
5. **M3 dev tree is on `dev` branch** (also same SHA as main). Created this morning so the install tree could take `main` — same pattern as locally.
6. **Master plist on M3 was manually patched this morning to install tree.** Same install-tree pattern as the dashboard plist. install.sh DOESN'T bake this for fresh installs yet (only dashboard plist is automated). Future cleanup.
7. **`claude-jason` account auth is expired.** Don't use it for `subctl orch spawn` until re-authed.
8. **The decomposition shipped 14 commits + 10 orchestration-log commits + various morning-sweep/bugfix commits over 1.5 days.** All on `main`. No PR opened to GitHub — this was an internal solo-operator initiative; the operator chose direct-to-main with detailed `DECISIONS.md` + `ORCHESTRATION.md` durables.

---

*Generated 2026-05-15 ~11:30 AM CDT by Claude Opus 4.7 (1M context). Session length ~17h wall-clock (operator slept ~6h of that). 12 workers dispatched, 12 clean landings, 0 rollbacks. Decomposition: complete.*
