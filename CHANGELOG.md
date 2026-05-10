# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical version source is the `VERSION` file at the repo root. `lib/core.sh`, `bin/subctl`, the dashboard, and the master daemon all derive their version string from it. To bump: edit `VERSION`, append a CHANGELOG entry, commit, push — `subctl update` on every host pulls the new version automatically.

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
