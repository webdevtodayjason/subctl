# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical version source is the `VERSION` file at the repo root. `lib/core.sh`, `bin/subctl`, the dashboard, and the master daemon all derive their version string from it. To bump: edit `VERSION`, append a CHANGELOG entry, commit, push — `subctl update` on every host pulls the new version automatically.

## [2.1.5] — 2026-05-10

Patch — three dogfood-driven fixes.

### Fixed

- **Chat panel no longer overlaps the toolbar when conversation grows.** `.orchestration-screen` was using `min-height` instead of `height`, so as the chat history grew the screen container got taller than the viewport and the body scrolled — pushing the MODEL/APPLY/COMPACT/+NEW CHAT toolbar above the visible area. Switched to a fixed `height: calc(100vh - 56px - 48px)` + `overflow: hidden` on the parent, removed the now-redundant `max-height` magic-number on `.master-chat`, and let the `.master-log` flex bound itself with `overflow-y: auto`. Toolbar stays anchored at the top regardless of chat length.
- **Team activity now refreshes from real pane content, not tmux's window-focus signal.** v2.1.2 used `tmux #{window_activity}` which only updates on user-attach interactions — useless for a detached worker pane spewing output. The dashboard kept showing `1h05m ago` while the worker had clearly written 13 files in the last 30 minutes. Replaced with `tmux capture-pane -p` + content hashing per session: if the hash changed since the last watchdog tick, we bump `teamLastActivity` to now. Reliable signal regardless of attach state.

### Changed

- **Master SKILL gains rule #6: publish to `notify_dashboard` on meaningful events.** The dashboard's NOTIFICATIONS feed has been empty during the entire FOOTHOLD dogfood because the master only narrated progress in chat — never published. Rule #6 specifies the kinds (`spawn`, `milestone`, `blocked`, `escalation`, `decision`, `error`, `watchdog`) and the contract: ≤120-char summary, paired with chat messaging not in place of it. The verifier's `message-sent-claim` rule already partially enforces it; rule #6 names it explicitly.

## [2.1.4] — 2026-05-10

Patch — runtime claim-verification gate, Argent-style.

### Added

- **Post-turn claim verifier** (`components/master/verifier.ts`). After the master settles a turn, the runtime scans the assistant text for "claim triggers" (specific future check-in times, asserted team status, host-fact claims, message-sent claims, decision-logged claims) and checks each against tool calls made IN THE SAME TURN. If a claim isn't backed by the corresponding tool, the runtime feeds a synthetic `[verifier]` correction prompt and re-runs the turn. Capped at 2 corrections per original prompt to prevent loops; on giveup, the gap is logged to `decisions.jsonl` (`verifier_giveup`) and the response ships with the gap on record.
- **Five initial verification rules:**
  - `future-checkin-time` — "I'll check in N minutes" / "I'll follow up at T" → must have called `schedule_followup`
  - `team-status-claim` — "the team is making progress" / "team is stuck" → must have called `subctl_orch_status` or `subctl_orch_list`
  - `host-fact-claim` — "qwen is loaded" / "Docker is running" → must have called `system_lmstudio_models` or `system_tmux_sessions` etc.
  - `message-sent-claim` — "I sent a message to Jason" / "I nudged the team" → must have called `telegram_send` / `subctl_orch_msg` / `notify_dashboard`
  - `decision-logged-claim` — "I logged this to the vault" → must have called `vault_append` or `memory_remember`
- **`verifier_gap` SSE event** — broadcast when a gap is detected, surfacing in real time which rule fired and what the unbacked phrase was. Visible in `/api/master/events` and the dashboard's live activity feed.
- **`verifier_resolved` / `verifier_giveup` decision-log entries** — operator can grep `decisions.jsonl` to see how often the verifier had to intervene and which rules trip most.

### Why this exists

Operator pattern from ArgentOS, paraphrased 2026-05-10: *"If Argent tries to say something and can't prove it or back it up with actual tool use proof, Argent is looped back and gated. You'll hear her say 'oh you're right' and then the turn gets blocked."*

v2.1.3 added the `schedule_followup` tool + SKILL guidance — that's the polite layer ("please don't lie"). v2.1.4 adds the runtime gate ("you literally can't ship a lie without us catching it"). They reinforce each other. SKILL alone wasn't enough during dogfood — model produced a 15-min-checkin promise without scheduling. Verifier catches that pattern at the runtime level and re-runs the turn until backed by tool use OR explicitly logged as unverified.

### Notes

- The verifier skips itself for `[verifier]`, `[watchdog]`, `[scheduled]`, `[team-report]` prefixed prompts — those are runtime-internal, not operator-facing claims.
- Iteration cap is 2 — i.e., one correction loop maximum. If the model can't get its own claim backed after one pointed retry, the response ships with a `verifier_giveup` log entry rather than looping forever. Operator can grep that to see chronic offenders.
- Rules are extensible — add to `VERIFICATION_RULES` in `verifier.ts`. Keep `requires_any_tool` honest; over-strict rules (requiring tools that don't actually verify the claim) cause friction without quality gain.

## [2.1.3] — 2026-05-10

Patch — anti-hallucination scaffolding for the master daemon.

### Added

- **`schedule_followup` tool family** (`components/master/tools/scheduler.ts`). Three new master tools: `schedule_followup({in_minutes, summary, prompt})` writes a future self-prompt to `~/.config/subctl/master/followups.jsonl`; `list_followups` shows pending; `cancel_followup({id})` removes one. A new ticker in the master daemon polls every 60s, fires due followups as synthetic `[scheduled]` agent prompts. Survives daemon restarts (state is on disk).
- **Anti-hallucination rules section in master SKILL.md.** Five non-negotiable rules: (1) never promise a check-in time without first calling `schedule_followup`; (2) don't claim capabilities you don't have (no "background monitoring"); (3) verify host facts via `system_*` tools, don't recall; (4) keep workers moving through checkpoint questions instead of bouncing them back to the operator; (5) say "I don't know" rather than fabricating status. These override the rest of the SKILL when in conflict.

### Why this exists

Surfaced 2026-05-10 during the FOOTHOLD dogfood. After 39 minutes of silence, the master told the operator "I'll check in on it in 15 minutes" — but had no underlying timer behind that promise. The watchdog would have fired regardless, but the specific 15-minute commitment was hallucinated. Operator caught it: "It needs to be gated. The master shouldn't be able to lie even if it's just trying to keep me happy."

The fix gates the lie at the mechanism level. The master now has a real tool that backs timed promises with file-on-disk state. The SKILL update tells it to use the tool and not fabricate cadence. Future "I'll check at T" sentences are tied to a specific followup record the operator can inspect via `list_followups` — no record, no promise.

## [2.1.2] — 2026-05-10

Patch — watchdog cadence + activity signal.

### Changed

- **Watchdog defaults tightened.** Default `review_interval_minutes` 5 → 3, default `stall_detection_minutes` 60 → 15. Operators expect the master to notice within minutes when a worker goes silent; the previous 5/60 defaults were "check in once every 5 minutes, escalate after an hour" — too coarse for an active dogfood loop. The new defaults align with the dashboard's row-colour thresholds (yellow at 15min, red at 30min) — the master now catches a team transitioning into "yellow" rather than waiting for red. Operator can still override via `policy.global_defaults`.

### Added

- **Tmux window-activity as a fallback liveness signal.** Previously `teamLastActivity` was only updated by the inbox tailer, which meant a worker that was productively writing files but never self-reporting via inbox looked stale. Diagnosed during FOOTHOLD when the worker built `server-foothold/` over 25 min while the inbox stayed pinned at the spawn-seed timestamp from 14:13 — dashboard reported `30m ago` and a red staleness dot even though the worker had just paused waiting for the operator's `go`. The watchdog tick now calls `tmux list-windows -a -F '#{session_name}|#{window_activity}'` first and bumps `teamLastActivity` to the latest tmux activity timestamp for any session whose window has been touched more recently. Inbox events still take precedence when present; tmux only fills the gap.

## [2.1.1] — 2026-05-10

Patch — chat-toolbar overflow into right sidecar.

### Fixed

- **Chat toolbar no longer spills into the dev-teams panel.** The toolbar's `display: flex` had no `flex-wrap`, and the child min-widths (model selector 280px, ctx meter 220px) summed to more than the chat column on typical viewports. With no wrap, no overflow clip, the ctx pill `ctx 33,422 / 65,536 tok (51%)` rendered on top of the team name `claude-Down-Time-Arena` in the right sidecar. Added `flex-wrap: wrap` + `overflow: hidden` on the toolbar, and reduced `chat-model-select` min-width from 280px → 220px so the row fits on a single line at most viewport widths and wraps gracefully when it can't.

## [2.1.0] — 2026-05-10

Minor — close the dogfood-exposed gap where the subctl-built skills and slash commands lived only on the operator's laptop. Fresh installs now get them automatically. New: `orchestrator-mode` skill in repo, `/team` slash command in repo, and `subctl install` symlinks all repo skills + commands into every per-account cfg_dir.

### Added

- **`components/skills/orchestrator-mode/SKILL.md`** — the multi-pane orchestrator + team-agent protocol. Critical: it includes the `SUBCTL_AGENT_ROLE=worker` activation guard that prevents the orchestrator-mode-deadlock pattern (workers self-loading the orchestrator role and waiting forever for approval to dispatch sub-workers they have no right to dispatch). Diagnosed and solved 2026-05-09 in the master/lead-deadlock incident.
- **`providers/claude/commands/team.md`** — the `/team` slash command. Routes to the `orchestrator-mode` skill.
- **`subctl_settings_install_claude_dir` now symlinks the repo's full skill + command catalog into every Claude cfg_dir.** Iterates every directory in `components/skills/` (excluding `master`, which is the daemon's own system prompt and would confuse workers) and every `.md` in `providers/claude/commands/`. Idempotent — symlinks overwrite cleanly, operator-personal skills/commands not in the repo are untouched. Each per-account cfg_dir now has `subctl`, `autonomy`, and `orchestrator-mode` available the moment it's created.

### Notes

- Only ships content I created for subctl. Sub-agents like `bug-analyzer` / `code-reviewer` / `dev-planner` (dated 2026-01-30, pre-subctl) and slash commands like `/commit` / `/code-review` / `/security-review` are operator-personal — they stay in `~/.claude/` and don't get pulled into the repo.
- Workers spawned via `subctl orch spawn` on a fresh install (e.g., the M3 Ultra) will now have `subctl`, `autonomy`, and `orchestrator-mode` in their skill catalog. Verifiable via "what skills do you have?" in a worker's chat.
- The master daemon's own SKILL (`components/skills/master/`) is intentionally excluded from the worker symlink loop — only the daemon process loads it via `components/master/server.ts`, never a worker. A worker that thought it was the master would loop into bad coordination patterns.

## [2.0.5] — 2026-05-10

Patch — three operator-reported bugs from continued FOOTHOLD dogfood, plus a roadmap entry that captures the bigger gap they exposed.

### Fixed

- **Stop hook self-heals stale paths.** `subctl_settings_install_claude_dir` previously merged a new Stop hook entry into `settings.json` only if no entry already pointed at the expected path — but didn't *rewrite* entries pointing at OTHER `log-rate-limits.sh` paths. The result, on systems migrated from older alias names (`claude-personal`, `claude-work`, `claude-overflow`), was Stop hooks pointing at non-existent scripts in the old alias dirs, generating "No such file or directory" errors after every Claude Code turn. The merge now rewrites any `log-rate-limits.sh` command path to the current cfg_dir before deciding whether to append a new entry. Idempotent — a re-run on a clean install is a no-op.
- **Chat-panel right sidecar no longer truncates.** The `1fr 320px` grid let the chat toolbar's wide content (model selector + apply + compact + new chat + fullscreen + ctx meter + supervisor label) push the sidecar past the viewport edge, clipping "ACTIVE DEV TEAMS", "claude-Down-Time-Arena", and the Notifications header. Bumped the sidecar to 360px, set `minmax(0, 1fr)` on the main track, added `min-width: 0` on master-chat and the sidecar, and added `word-break: break-word` to team rows so long session names wrap rather than overflow.
- **Live-fix on M3 Ultra:** rewrote the three per-account `settings.json` Stop hook paths from the stale alias dirs to the actual cfg_dirs. The next `subctl install` run will keep them correct via the self-heal logic above.

### Notes

- The hook-path bug exposed a much bigger gap, captured as Phase 3o in `docs/master.md`: a chunk of the operator's `~/.claude/` baseline (skills, slash commands, sub-agents, default permissions) is on the laptop but not in the repo, so fresh installs miss it. Audit complete in the doc; no code shipped — sanitizing operator-specific content before committing skills like `subctl` and `orchestrator-mode` requires manual review.

## [2.0.4] — 2026-05-10

Patch — Docker becomes a first-class hard requirement. Surfaced during the FOOTHOLD dogfood when the worker hit the dockerode hello-world step, found Docker Desktop wasn't running, and correctly stopped to ask the operator instead of failing silently.

### Added

- **Docker check in master `/diag`.** New 6th component check. Distinguishes binary-missing (`docker --version` non-zero) from daemon-not-running (`docker info` non-zero) so the suggested action is actionable: install Docker Desktop vs. `open -a Docker`. Surfaces both in the dashboard's diagnostics panel.
- **Docker in dashboard install-checks.** Added to `/api/settings/install-checks` as a required tool with `brew install --cask docker` as the install command, and fallback paths covering Docker Desktop's bundled binary location (`/Applications/Docker.app/Contents/Resources/bin/docker`).

### Notes

- The check intentionally splits "installed" (install-checks tile) from "running" (/diag tile). After a reboot, Docker Desktop is typically installed but not auto-started; the install-checks tile stays green while /diag flips red. This is the right shape — install state is durable, daemon state is transient.
- A dev team that needs Docker should call out the dependency in its boot prompt or first task. The FOOTHOLD spec already does this in §8 and §13. Future templates that involve containerized workers should follow suit.

## [2.0.3] — 2026-05-10

Patch — fix `subctl usage` and the dashboard's per-account 5h/week columns for Claude Code 2.x. Diagnosed during the FOOTHOLD dogfood when every account row in the Accounts table showed `—` for utilization despite all dispatch verdicts saying GO and a worker actively running on `claude-jason`.

### Fixed

- **`subctl_usage_bearer` now reads Claude Code 2.x file-based credentials.** Claude Code 2.x writes per-account OAuth tokens to `<cfg_dir>/.credentials.json` (mode 600) instead of the macOS Keychain. The previous implementation only knew the 1.x scheme — sha256(cfg_dir)[0:8] as a suffix on `Claude Code-credentials-<hash>` — so it found nothing for any account, `subctl usage --json` returned `ok: false` everywhere, and the dashboard's polling loop logged empty snapshots. The bearer lookup is now ordered: (1) `<cfg_dir>/.credentials.json`, (2) hashed Keychain entry (1.x), (3) unsuffixed Keychain entry (1.x default cfg_dir). First match wins.
- **`subctl doctor` reports the new credential path correctly.** The "Keychain bearers" section is renamed "Credentials" and reports `file=...` for 2.x entries, `keychain=...` (with a "legacy 1.x" tag) for old entries, and a clearer "re-run subctl auth" hint when neither is present.

### Notes

- No re-auth required. Claude Code 2.x has been writing `.credentials.json` for every alias all along; subctl just wasn't reading it.
- The Anthropic `/api/oauth/usage` endpoint hasn't changed — only the bearer lookup did. After updating, expect 5h and weekly utilization columns to populate within ~5 min (next dashboard poll cycle) or immediately after clicking the ↻ refresh button on the Accounts header.

## [2.0.2] — 2026-05-10

Patch — two operator-reported bugs from the FOOTHOLD dogfood test, both around observability of the master's own actions.

### Fixed

- **Spawned teams now register in `teamLastActivity` immediately.** Previously `subctl_orch_spawn` and `subctl_orch_spawn_template` created the tmux session and returned, but the master's tracking map was only populated by inbox events written by the worker itself. A worker that booted into Claude Code and sat at an empty prompt never wrote to its inbox, so `/health` reported `teams_tracked: 0` and the dashboard's Orchestration tab showed "no dev teams running" despite a live tmux session with the worker visible to `subctl orch list`. Both spawn tools now seed the inbox with a synthetic `{kind: "spawned"}` event on success — the existing inbox tailer picks it up and the team appears in the master's tracking on the next file-watch tick.
- **Setting the Obsidian vault root from Settings now auto-bootstraps the vault structure.** Previously, saving `~/Documents/Obsidian Vault` as the vault root just wrote `obsidian.json` and left the directory empty. The Memory tab then reported "Obsidian installed, no vault detected" and asked the operator to mkdir `.obsidian/` manually. The POST /api/settings/obsidian endpoint now creates `<root>/master/.obsidian/` plus a `welcome.md` introducing the vault — Obsidian-the-app and the dashboard both recognize it as a real vault on first save. Pass `{bootstrap: false}` if you want the legacy "config-only" behavior.

### Notes

- The team-registration fix is defense-in-depth alongside the master's own self-correction loop (`subctl_orch_status` + `subctl_orch_msg`). The master can already nudge a stuck worker via msg(); now `/health` and the Orchestration tab also reflect that team's existence rather than reporting zero teams.
- Watchdog visibility (showing last-tick timestamps even when no team is stale) is queued as a separate observability improvement — see Phase 3m design.

## [2.0.1] — 2026-05-10

Patch — guards the supervisor switch so users can't pick a provider that pi-ai doesn't have an api factory for. Reported by Jason after switching the chat panel's supervisor to "OpenAI Codex (ChatGPT)" and getting silent empty responses on every prompt.

### Fixed

- **`/api/master/supervisor` no longer accepts unwired providers.** The chat panel previously offered `openai-codex` as a supervisor option, but no provider package implements it (`providers/openai/README.md` flags it as v1.1 work). Selecting it wrote the value to `providers.json` and bounced the daemon, after which every chat turn returned empty assistant content because pi-ai's stream factory found no api in the registry. The endpoint now rejects with `400 { ok: false, error: "provider X is not wired into pi-ai yet", hint: "<list of wired providers>" }` for any provider outside the wired allowlist.
- **Chat-model selector marks unwired cloud providers disabled.** The dropdown still lists them (so users see what's coming) but the `<option>` is `disabled` with a `title` attribute pointing at the README. Wired providers render normally.

### Notes for the operator

- If the chat panel ever silently produces empty responses again, check `~/.config/subctl/master/decisions.jsonl` for `prompt_error_chat: No API key for provider: …`. That's the canary — it means pi-ai fell through the api lookup.
- The `WIRED_PROVIDERS` allowlist in `dashboard/server.ts` must stay in sync with `PROVIDER_API` in `components/master/server.ts`. Changes to one require changes to the other.

## [2.0.0] — 2026-05-10

Phase 3 — the master daemon goes live. subctl is no longer just a control plane for Claude accounts; it now hosts a persistent conversational orchestrator that spawns dev teams, talks to you over the dashboard chat panel and Telegram, and curates its own memory across three tiers. The dashboard navigation collapses from a tab strip into a 12-item sidebar.

This is a major bump because the architecture, not just the surface, changed: a new daemon, a new persistent agent, a new memory model, a new plugin contract, and a new conversational UI. Subscription accounting (the original 1.x scope) still works exactly the same.

### Added

- **`subctl master` daemon** — pi-agent-core-based persistent orchestrator on `127.0.0.1:8788`. Loads `providers.json` + `policy.json` + the master SKILL prompt, exposes HTTP/SSE so the dashboard chat tab and Telegram listener share a single agent transcript. Auto-started by `com.subctl.master.plist`.
- **44 master tools across 13 families** — `subctl_orch_*` (spawn/list/preview/attach/send), `gh_*`, `coderabbit_*`, `telegram_*`, `system_*` (host introspection), `project_*` (vault-bound project + spec scaffolding), `memory_*` (claude-mem worker queries), `context7_*` (docs RPC), tier-1 `memory_*` (always-in-context user.md + memory.md curators), `skill_*` (master-source skill authoring with category allow-list), `notify_dashboard` (curated event feed), `specforge` (5-stage intake state machine).
- **Three-tier memory architecture** — tier-1 always-in-context (`<memory-context>` blocks built from `user.md` + `memory.md`, ~3500 chars), tier-2 semantic (claude-mem worker at `localhost:37701`), tier-3 long-form (Obsidian vault). System prompt is composed per-prompt via `composeSystemPrompt()` so memory edits land on the very next agent turn.
- **Spec Forge** — 5-stage state machine (`project_type_gate → intake_interview → draft_review → awaiting_approval → approved_execution`) mirroring ArgentOS's specforge-conductor. Persists state to `~/.config/subctl/master/specforge/<key>.json` and writes approved specs to `<vault>/<project_name>/SPEC.md`.
- **Dashboard sidebar UI** — `Chat / Orchestration / Dashboard / Projects / Teams / Claude Sessions / Models / Providers / Memory / Skills / Live Logs / Settings`. Persistent chat panel with rehydrate, ctx meter, compact button, new-chat, fullscreen mode, model selector (cloud + LM Studio optgroups, ●/○ availability dots).
- **Team templates** — JSON manifests under `~/.config/subctl/teams/<name>.json` defining persona + skills + tools + autonomy + boot_prompt. `subctl teams claude --template <name>` and `subctl orch spawn` both honor templates; `_provider_claude_apply_template` copies skills into the worker's `cfg_dir`.
- **Personal skill authoring** — `skill_create` / `skill_revise` / `skill_remove` constrained to the master skill source with a category allow-list (`team-coordination`, `escalation-patterns`, `code-review-synthesis`, etc.) and a description-keyword filter. All writes audited to `decisions.jsonl`.
- **Plugin system** — `subctl plugins {list,install,remove,status,show}` with manifest `subctl.plugin.json` (id, kind, configSchema, tools, skills, tabs, verbs). Mirrors ArgentOS's manifest pattern. Plugins live under `~/.config/subctl/plugins/<id>/`.
- **Notifications sidecar** — curated event feed (`spawn`, `blocked`, `done`, `milestone`, `escalation`, `decision`, `watchdog`, `memory`) replacing raw activity logs. `notify_dashboard` tool persists to `notifications.jsonl` and broadcasts over SSE.
- **Codex provider** — first-class auth via `subctl auth openai`. Detects SSH (`SSH_CONNECTION` / `SSH_CLIENT`) and routes to `codex login --device-auth` so headless installs don't deadlock on a browser flow.
- **Context7 integration** — docs RPC against `mcp.context7.com/mcp` with `CONTEXT7_API_KEY`. `_provider_claude_drop_mcp_config` writes per-team `.mcp.json` so dev workers get docs out of the box.
- **`subctl update`** — canonical pull-and-restart workflow (`lib/update.sh`). Verifies clean tree, fast-forwards origin/<branch>, runs `bun install` where `package.json` changed, bounces launchd services, runs `subctl doctor`. `--force` stashes; `--no-restart` leaves services alone. Shows `vOLD → vNEW` delta + summary of incoming commits.
- **`VERSION` file** — single source of truth at repo root. `lib/core.sh`, `bin/subctl`, dashboard, and master daemon all read from it. `subctl version` now also prints the git branch + short SHA + dirty flag.
- **Tmux preview + ssh attach** — `subctl orch view <team>` captures a tmux pane, dashboard renders it in a modal. Attach button shells into the same session.
- **LM Studio context auto-pin** — `ensureModelLoaded()` calls `/api/v1/models/load` with explicit `context_length` at boot, on supervisor switch, and via `/reload-supervisor`. Stops the recurring "context resets to 4K on JIT load" failure mode.
- **Auto-compact watchdog** — 5-minute interval (configurable via `compact.json`). Compacts via `/transcript/compact` with `target_tokens` + `keep_recent` params; returns `noop:true` for short transcripts so the UI shows an info notice instead of an error.
- **Telegram bidirectional** — outbound via `telegram_*` tools, inbound via the master notify listener. Single transcript, two surfaces.
- **`docs/master.md`** — canonical architecture document (mental model, components, memory architecture, roadmap, operational reference, glossary, decision log).

### Changed

- **Deploy workflow is canonical-git only.** Previously, in-flight iterations sometimes shipped via `rsync` to remote hosts; this is no longer supported. The only path is: commit + push → `subctl update` on each host. Branches are tracked properly; the M3 Ultra and laptop checkouts now diverge only via committed history.
- **`/health` and state.json** report the live `SUBCTL_VERSION` instead of the hardcoded `"0.1.0"` placeholder.
- **Dashboard `Bun.serve` `idleTimeout: 0`** — previously the default 10 s was killing SSE proxy connections, causing the connection pill to flap CONNECTED ↔ RECONNECTING when chat was idle.
- **Notice modal** replaces browser `alert()` / `confirm()` in the chat and orchestration surfaces; cancel button is hidden via both `hidden` attribute and `display: none` (belt-and-braces, since some browsers honor only one).
- **install-checks PATH** extended with `~/.bun/bin`, `~/.local/bin`, `~/.lmstudio/bin`, `~/.cargo/bin` plus per-tool `fallback_paths`, so launchd-launched dashboards find user-installed binaries.
- **`accounts.conf` parser** switched from tab-delimited to pipe-delimited to match the actual file format.

### Fixed

- **`pi-ai` empty responses** — diagnosed 2026-05-09: built-in providers are NOT registered as a side effect of `import`; `registerBuiltInApiProviders()` must be called explicitly at boot. Without it, every `agent.prompt()` returned an empty content array because the stream factory found no api in the registry.
- **`writeFileSync` ReferenceError** in `/api/master/supervisor` (missing require fixed).
- **`lms --version` ANSI banner** stripped via `stripAnsi()` helper.
- **claude-mem detection via CLI probe** replaced with plugin-dir presence check at `~/.claude/plugins/marketplaces/thedotmack`.
- **OAuth row hardcoded `subctl auth claude`** for all providers — now uses each account's actual provider field.
- **Pulse-dot blinking on every WS message** — only flashes when state signature actually changes.
- **Chat doesn't auto-scroll to bottom on load** — fixed via double-`requestAnimationFrame` + `MutationObserver` on tab switch.

### Removed

- **rsync-based deploy paths.** No more out-of-band file shipping to remote subctl installs. Use `subctl update`.

## [1.0.0] — 2026-05-05

First stable release. The 0.x series stabilized into a single coherent multi-account control plane for Claude Code, covering accounts, auth, sessions, projects, teams launcher, dashboard, radar, and statusline — all integrated against the same filesystem-derived state model.

### Added

- **`subctl projects`** — declarative per-account project bindings + bulk launcher.
- **`subctl sessions`** — list and adopt orphaned Claude transcripts across every configured `cfg_dir`.
- **`subctl session-kill` / `subctl session-prune` / `claude-kill` shim** — surgical session cleanup.
- **Cost analysis** — API list-price savings vs subscription cost, surfaced in the dashboard.
- **24-hour utilization history** with per-account event attribution.
- **Per-account dispatch readiness** via `/api/oauth/usage`.
- **Dashboard polish bundle** — Mintlify-style docs, kill button, countdowns, notifications, best-account hint, copy `claude-use`, expanded doctor output, `$1,234.56` currency formatting, `/help` reference docs page.
- **Per-account experimental teams runtime** — `subctl_settings_ensure_teams` seeds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode=tmux` into each account's `settings.json`, and the tmux session env now carries the experimental flag. `Team*` / `SendMessage` tools and `Agent(team_name=…)` now surface no matter how the account is launched.
- **Defensive tmux ergonomics in `provider_claude_teams`** — ensures `mouse on` and idempotent `WheelUpPane` / `WheelDownPane` bindings on the tmux server, so two-finger trackpad scroll reaches tmux's scrollback even from inside a Claude Code TUI pane. Idempotent — only writes bindings if not already present.
- **`START-HERE.md`** — one-shot Claude-Code-pasteable install prompt for new Macs.

### Changed

- **`subctl install` now wires statusline + Stop hook into every Claude config dir**, not just `~/.claude`. Each per-account `settings.json` gets its own `statusLine` pointing at its own per-dir scripts. Previously only the default `~/.claude` was patched, so the radar bar never appeared under `claude-use <alias>` because Claude Code reads from the per-account config dir.
- **`subctl accounts add`** wires the new account's config dir immediately; no `subctl install` re-run required.
- **`subctl doctor`** iterates every Claude config dir and reports per-dir statusLine state + symlink integrity.
- **Usage cache TTL bumped to 5 min**, with a manual `POST /api/refresh` for force-refresh.

### Fixed

- **Statusline missing in alias-launched sessions** — see "Changed" above.
- **`claude()` shell guard** now passes through subcommands and non-interactive flags, so `claude --version`, `claude doctor`, etc. work uninterrupted.
- **Dashboard ctx %** auto-detects 1M-context model variants instead of assuming 200k.
- **Dashboard rate-limit verdict** reflects honest signal rather than aggregate noise; events table cleaner.

## [0.4.2] — 2026-05-04

Dashboard rebuild + tmux PATH fix.

## [0.4.1] — 2026-05-04

`deck` (Go + Bubble Tea TUI) restored after the v0.4.0 rip-out turned out to be premature.

## [0.4.0] — 2026-05-04

Dropped the Go-based deck TUI in favor of `sesh` integration. Reverted in 0.4.1.

## [0.3.0] — 2026-05-04

`subctl deck` — Go + Bubble Tea live session manager TUI.

## [0.2.0] — 2026-05-04

First-class shims for `claude-teams`, `claude-radar`, `claude-dash`.

## [0.1.0]

Initial multi-account isolation, statusline, and Stop hook for Claude Code.
