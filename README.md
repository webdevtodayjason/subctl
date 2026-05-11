# subctl

**An agentic harness for the AI subscriptions you already pay for.**

A persistent conversational orchestrator that runs on your hardware, talks to you through a dashboard chat panel or Telegram, spawns dev-team tmux sessions on demand, watches them for staleness, gates its own claims with a runtime verifier, and pushes projects forward — with your laptop closed and your subscriptions on auto-rotate.

```
                                     ┌─────────────────────────┐
                                     │  subctl master          │
   you ─────────────┐                │  (persistent daemon)    │
                    │                │                         │
   dashboard chat ──┼──────────────► │   • SKILL + tier-1 mem  │
   Telegram     ────┘                │   • 50+ tools           │
                                     │   • Verifier + watchdog │
                                     │   • Personality presets │
                                     │   • Scheduler           │
                                     └─────────┬───────────────┘
                                               │  spawn / msg / kill
                                               ▼
                                     ┌─────────────────────────┐
                                     │  dev teams (tmux)       │
                                     │   • Claude Code workers │
                                     │   • per-account isolate │
                                     │   • own SKILL + tools   │
                                     └─────────────────────────┘
```

> **v2.6.0 shipping.** Full per-release history in [CHANGELOG.md](./CHANGELOG.md). The 1.x series was the multi-account dispatch substrate; the 2.x series is the agentic harness layered on top.

> 🚀 **First time on a new Mac?** Open a fresh Claude Code session and paste [`START-HERE.md`](./START-HERE.md). It walks you clone → install → account auth → master daemon enable, asking before any irreversible step.

---

## What you actually get

- **Conversational dev-team orchestrator** — talk to `subctl master` in the dashboard chat or Telegram. It spawns Claude Code workers in tmux sessions on the right accounts, watches them for staleness, nudges or escalates as needed. Responses route back to whichever channel you used.

- **Multi-account dispatch** — run multiple Claude accounts + an OpenAI Codex OAuth account on one machine without log-out/log-in dances. The dispatcher picks the healthiest account (lowest rate-limit pressure) at spawn time.

- **Three-tier memory:**
  - **Tier 1:** `user.md` + `memory.md` always injected into the master's system prompt (~3500 char budget — fast, durable, operator-editable)
  - **Tier 2:** [claude-mem](https://github.com/thedotmack/claude-mem) semantic search over every dev-team observation
  - **Tier 3:** Obsidian vault for long-form decisions, specs, RESUME files — browse in-page via the built-in viewer with `[[wikilinks]]`, embeds, callouts, and tag rendering

- **Runtime claim verifier (Argent-style)** — after every assistant turn the runtime scans for "claim triggers" (specific future check-in times, asserted team statuses, host facts, sent-message claims, decision-logged claims). Any claim not backed by a tool call this turn fires a synthetic `[verifier]` correction prompt. Capped at 2 corrections; on giveup the gap lands in `decisions.jsonl` so you can grep chronic offenders.

- **Self-scheduling** — when the master says "I'll check in 15 minutes" it MUST call `schedule_followup` first or the verifier catches the unbacked promise. The followup record survives daemon restarts.

- **Multi-team camera view** — NVR-style grid of every active dev-team tmux pane in the Orchestration tab, polling at 2 Hz. Click a tile to expand to full pane.

- **Document attachments in chat** — drag-drop a file, click the paperclip, or paste >4 KB to auto-attach. The chat surface stays readable (pill chips) while the model sees full inline content. After auto-compaction the master can re-read via the `read_attachment` tool.

- **Personality presets** — hot-swap the master's voice (`straight-shooter`, `witty`, `sarcastic`, `robotic`, `arnold-inspired`, `elon-inspired`, `hilarious`) without touching its persona contract. CLI + dashboard tile.

- **Watchdog + auto-compact** — master ticks every 3 min; if any team has gone silent past the staleness threshold (15 min default), it synthesizes a corrective prompt. Auto-compact runs every 5 min, compacting transcript history when it crosses 90 % of the supervisor's loaded context window.

- **Dashboard** — live ops view at `http://<host>:8787` with 12 sidebar tabs (Chat, Orchestration, Dashboard, Projects, Teams, Claude Sessions, Models, Providers, Memory, Vault, Skills, Live Logs, Settings).

- **Multi-channel I/O** — dashboard chat (SSE), Telegram (bidirectional with auto-relay), CLI prompt, scheduled self-prompts, inbox events from workers.

---

## Install

```bash
git clone https://github.com/webdevtodayjason/subctl.git
cd subctl
bash install.sh
```

The installer:
1. Symlinks `bin/subctl` into your PATH (default `~/bin/`)
2. Wires the Claude statusline + Stop hook into every Claude config dir
3. Symlinks the baseline skills (`subctl`, `autonomy`, `orchestrator-mode`) into every Claude config dir's `skills/` so dev-team workers boot with the right protocol baked in
4. Drops launchd plists for the master daemon + dashboard
5. Runs `subctl doctor` to surface any missing tools

Required (checked by doctor): `git`, `tmux`, `bun`, `jq`, `gh`, `claude`, `codex`, `coderabbit`, `docker`, `claude-mem` (plugin). Recommended: `lms` (LM Studio CLI for the supervisor model), Obsidian (vault), a Telegram bot via `BotFather`.

Add accounts to `~/.config/subctl/accounts.conf` then run `subctl install` again — per-account isolation model is documented in [`docs/multi-account.md`](docs/multi-account.md).

---

## Daily ops

```bash
# Bring up the master + dashboard (launchd; auto-start at login)
subctl master enable
subctl install                            # also installs dashboard service

# Talk to master from the CLI
subctl master prompt "spec the foothold-v3 polish and spawn a team for it"

# Or just open the dashboard
open http://127.0.0.1:8787

# Spawn a dev team directly (bypass master)
subctl teams claude -a claude-jason -c ~/code/myproject -o -y

# Switch master's voice
subctl master personality set sarcastic

# Bounce the daemon if it got wedged
subctl master restart
subctl master kick                        # recover from launchd throttle (local TTY only)

# Pull latest + restart services
subctl update

# Status
subctl status                              # global verdict + accounts table
subctl doctor                              # tools + credentials + paths
subctl master status                       # daemon health + tools loaded + supervisor
subctl orch list                           # running dev-team tmux sessions
```

Full CLI surface: `subctl help`. Cheat sheet at `http://<host>:8787/cheat`. Full reference at `http://<host>:8787/help`.

---

## Architecture

The canonical architecture document is [`docs/master.md`](docs/master.md):

- §1 Mental model — master as a conversational dev-team orchestrator
- §2 Components & file layout — daemon, dashboard, skills, templates, inbox
- §3 Memory architecture — the three tiers
- §4 Roadmap — every shipped phase + what's queued
- §5 Operational reference — restart cookbook, LM Studio config, accounts
- §6 Glossary
- §7 Decision log

Provider plugin model (how new AI subscriptions get wired in): [`docs/adding-a-provider.md`](docs/adding-a-provider.md).
Release / bump policy: [`docs/release-workflow.md`](docs/release-workflow.md).

---

## Repo layout

```
.
├── bin/subctl                     CLI entry point
├── components/master/             master daemon (Bun + pi-agent-core)
│   ├── server.ts                  HTTP, SSE, ticker scaffolding
│   ├── tools/                     50+ tools across 13 families
│   ├── personalities/             voice presets
│   ├── verifier.ts                runtime claim verifier
│   ├── attachments.ts             chat attachment storage
│   └── personality.ts             preset loader
├── components/skills/             baseline + master skills
│   ├── master/SKILL.md            master's own system prompt
│   ├── subctl/SKILL.md            worker-facing subctl skill
│   ├── autonomy/SKILL.md          worker autonomy doctrine
│   └── orchestrator-mode/SKILL.md anti-deadlock activation guard
├── dashboard/                     web UI (Bun static + SSE proxy; no build step)
│   ├── server.ts                  HTTP + WS + SSE + auto-proxy /api/master/*
│   ├── public/                    HTML/CSS/JS
│   └── help.md                    /help page source
├── providers/claude/              Claude Code provider (auth, teams, hooks, skills)
├── providers/openai/              OpenAI Codex provider (OAuth + device-auth)
├── lib/                           shell helpers (accounts, install, update,
│                                   master, plugins, settings, …)
├── docs/                          design docs (master.md, multi-account.md,
│                                   release-workflow.md, foothold links)
└── VERSION                        single source of truth for version
```

---

## Roadmap

Per-phase status lives in [`docs/master.md`](docs/master.md) §4. Headline:

- **Phase 3a–3j** (v2.0.0) — master daemon, 13 tool families, 3-tier memory, dashboard, verifier, auto-compact
- **Phase 3k** (v2.2.0) — personality presets
- **Phase 3l** (v2.4.0) — document attachments in chat
- **Phase 3m** (v2.3.0) — multi-team camera view
- **Phase 3n** (v2.5.0) — in-browser Obsidian vault viewer
- **Phase 3o** — baseline Claude config in repo (skills shipped in v2.1.0; permissions defaults + sub-agents still need sanitization pass)
- **Phase 3p** — Personal Skills System (ArgentOS-style operator UI)
- **Phase 3q** — Vault editor (CodeMirror 6 + Excalidraw canvas)

Provider expansion (Phase 4+): Gemini, Z.AI GLM, Minimax — see [`ROADMAP.md`](./ROADMAP.md).

---

## Contributing

PRs welcome. To add a new provider, read [`docs/adding-a-provider.md`](docs/adding-a-provider.md). For master daemon changes, read [`docs/master.md`](docs/master.md) first — it has 3+ months of decision history baked in. For everything else, open an issue first so we can agree on shape.

Bump policy in [`docs/release-workflow.md`](docs/release-workflow.md): patch (Z) is the default; minor (Y) only for genuine new user-visible features; major (X) only for breaking changes. Single source of truth for the version is [`VERSION`](./VERSION).

## License

MIT — see [LICENSE](LICENSE).
