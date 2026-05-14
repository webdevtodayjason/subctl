# Orchestration Log — subctl

Most recent session at top. Older sessions retained below as historical record.

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
/Users/sem/code/subctl                              feat/codex-provider          (orchestrator)
/Users/sem/code/subctl-s2a-sdk-wiring               feat/master-stage2-sdk-wiring (S2-A worker)
/Users/sem/code/subctl-s2b-cli-listener             feat/master-stage2-cli-listener (S2-B worker)
/Users/sem/code/subctl-s2c-install-wiring           feat/master-stage2-install-wiring (S2-C worker)
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
