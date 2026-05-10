# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical version source is the `VERSION` file at the repo root. `lib/core.sh`, `bin/subctl`, the dashboard, and the master daemon all derive their version string from it. To bump: edit `VERSION`, append a CHANGELOG entry, commit, push — `subctl update` on every host pulls the new version automatically.

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
