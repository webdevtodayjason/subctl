# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
