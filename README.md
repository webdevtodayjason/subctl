# subctl

**Subscription Central for AI subscriptions you're paying for.**

One CLI + TUI + dashboard for the AI subscriptions you already pay for. Today it speaks Claude. Gemini and OpenAI are next.

> **v1.0 is here.** See [CHANGELOG.md](./CHANGELOG.md) for what shipped. The 0.x series stabilized into a single coherent control plane for accounts, auth, sessions, projects, teams launcher, dashboard, radar, and statusline.

> 🚀 **First time setting up on a new Mac?** Open a fresh Claude Code session
> and paste [`START-HERE.md`](./START-HERE.md) as your first message. Claude
> will walk you through clone → install → account auth → projects.conf
> end-to-end, asking before any irreversible step.

---

## Why subctl exists

If you pay for more than one Claude account — or you share a Max plan with a teammate, or you keep a "personal" account separate from a "work" account — you have probably hit at least one of these:

- You sign out of Claude Code, sign back in with the other account, and lose your project context.
- You hit a rate limit at 9pm and can't tell whether it was the daily quota, the per-minute window, or the token-per-minute ceiling.
- You have three terminals open, two of them are silently rate-limited, and the third still works because it picked up a different account from a half-remembered alias in your `.zshrc`.
- You wrote a tmux helper to launch "Claude in this directory with this account" once, six months ago, and you can no longer find it.

`subctl` consolidates the tribal knowledge you accumulated solving those problems into one tool. It does three things, all on the same engine:

1. **Multi-account isolation.** Run multiple Claude accounts (and soon Gemini, OpenAI) on one machine without log-out / log-in dances. Uses each provider's official isolation knob — for Claude that's `CLAUDE_CONFIG_DIR`.
2. **Rate-limit awareness ("radar").** Surface parallel session pressure, context %, session age, RL hits today, and dispatch readiness. The `claude-dispatch-radar` project lives here now.
3. **Tmux team launcher.** `subctl teams claude -a personal -o -c -y` opens a tmux session pinned to a specific account, with the orchestrator + worker layout you use every day.

Plus a dashboard (`localhost:8787`) that runs as a launchd service and is useful as a browser new-tab page.

---

## What you get

- **TUI menu** — type `subctl` and pick from a menu. No flag-memorizing.
- **Flat commands** — `subctl service start`, `subctl auth claude personal`, etc. Scriptable.
- **Per-provider account isolation** — Claude today; Gemini and OpenAI on the roadmap.
- **Statusline** — terminal-friendly bar showing repo, branch, model, ctx %, parallel sessions, rate-limit hits today.
- **Dispatch readiness check** — answers "should I fire off another agent right now?" with a single verdict.
- **Stop hook** — scans transcripts for real rate-limit / overloaded literals (not bare 429/529 numbers — too noisy).
- **Dashboard** — Bun-served HTTP+WS at `localhost:8787`. Set it as your new-tab page if you like.
- **launchd integration** — service starts at login, lives in the background.
- **Tmux teams** — launch orchestrator + worker panes pinned to a specific account.
- **Provider plugin model** — drop a directory under `providers/` to add a new one.

---

## TUI main menu

```
╔══════════════════════════════════════════════════════════════════╗
║  subctl                                       2026-05-04 09:42   ║
║  Subscription Central                                             ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  ▸ 1. Accounts                  3 claude · 0 gemini · 0 openai   ║
║    2. Authentication            2 ready · 1 needs login          ║
║    3. Sessions (radar)          ⚡ 2 active · ⚠ 0 RL today       ║
║    4. Teams launcher            tmux: 3 running                  ║
║    5. Web service / dashboard   ● running on :8787               ║
║    6. Settings & config                                          ║
║    7. Doctor / health check                                      ║
║    8. Logs                                                       ║
║    ─                                                             ║
║    9. About                                                      ║
║    q. Quit                                                       ║
║                                                                  ║
║  ↑↓ navigate · enter select · q quit · ? help                    ║
╚══════════════════════════════════════════════════════════════════╝
```

Each line shows live state on the right — accounts configured, auth status, parallel sessions, tmux state, service health. Nothing is stale; the menu repaints from filesystem state on entry.

---

## Statusline

This is what Claude Code shows at the bottom of the terminal once `subctl install` has wired up `~/.claude/settings.json`:

```
 myrepo │  feat/x*+ │  Opus 4.7 │ ctx 11% │ ⚡ 2 ses │ ⏱ 27m │ ↑42K ↓21K │ ⚠ 3 RL today
```

Segments and color thresholds:

| Segment        | Meaning                                  | Green     | Yellow      | Orange    | Red        |
|----------------|------------------------------------------|-----------|-------------|-----------|------------|
| `myrepo`       | Repo name (basename of git toplevel)     | always    | —           | —         | —          |
| `feat/x*+`     | Branch + dirty / staged markers          | clean     | dirty       | —         | conflict   |
| `Opus 4.7`     | Active model                             | always    | —           | —         | —          |
| `ctx 11%`      | Transcript context window used           | <30       | 30–60       | 60–80     | ≥80        |
| `⚡ 2 ses`      | Parallel Claude Code sessions running    | 1         | 2–3         | —         | ≥4         |
| `⏱ 27m`        | Age of current session                   | <2h       | 2–6h        | —         | ≥6h        |
| `↑42K ↓21K`    | Tokens sent / received this session      | always    | —           | —         | —          |
| `⚠ 3 RL today` | Rate-limit / overloaded hits today       | 0         | 1–2         | —         | ≥3         |

The statusline reads only from filesystem state (`~/.claude/projects/<id>/transcript.jsonl`, `~/.config/subctl/state/`), so it's safe to call on every prompt without touching the network.

---

## Quick start

```
$ git clone https://github.com/webdevtodayjason/subctl.git ~/.subctl
$ cd ~/.subctl && ./install.sh
$ subctl auth claude personal           # one-time browser login for the "personal" account
$ subctl service enable                 # starts the dashboard at http://localhost:8787
$ subctl                                # opens the TUI
```

---

## Convenience shims

Every subctl install drops short-form binaries alongside `subctl` itself, for muscle-memory parity with how you've probably been working:

| Shim          | Equivalent           | What it does |
|---------------|----------------------|--------------|
| `claude-teams [opts]` | `subctl teams claude [opts]` | Launch a tmux session pinned to a specific Claude account. |
| `claude-radar`        | `subctl radar`              | Print the dispatch-readiness verdict + cross-account signals. |
| `claude-dash`         | `subctl dashboard`          | Ensure the dashboard service is running, open the browser. |

All four binaries (`subctl`, `claude-teams`, `claude-radar`, `claude-dash`) are symlinks into the repo, so `git pull && ./install.sh` is the only update path.

If `claude-teams` already exists at `/usr/local/bin/claude-teams` (e.g. a hand-rolled script you wrote previously), the installer backs it up to `~/code/claude-teams.pre-subctl.<timestamp>.bak` before replacing it. Uninstall restores the backup.

> **Pickers, two of them.** subctl ships both [`subctl-deck`](docs/deck.md) (a Go + Bubble Tea live session manager) and [`sesh` integration](docs/sesh-integration.md) (`subctl session-preview` / `subctl session-list` plug into sesh's preview pane). Use whichever fits your workflow; they read the same filesystem state. The dashboard at `localhost:8787` remains the panoramic web view.

---

## Session navigation via sesh

Rather than ship our own picker, subctl integrates with [`sesh`](https://github.com/joshmedeski/sesh) — a fuzzy tmux session navigator. Two new commands plug in:

```bash
subctl session-list [--format plain|sesh|json]    # all tmux sessions enriched with account + ctx
subctl session-preview <name>                      # multi-line metadata block + recent activity tail
```

Wire it in `~/.config/sesh/sesh.toml`:

```toml
[default_session]
preview_command = "subctl session-preview {}"
```

Then `sesh connect` shows every session with subctl's account + ctx % + status + RL hits in the preview pane. Full setup including suggested tmux keybindings: [docs/sesh-integration.md](docs/sesh-integration.md).

---

## Autonomy doctrine + Telegram escalation

By default, `subctl install` flips `defaultMode: "bypassPermissions"` on every
configured Claude account and drops an **autonomy skill** at
`~/.claude/skills/autonomy/SKILL.md` that activates whenever
`CLAUDE_AUTONOMY=full` is set (which the install also sets).

### What the autonomy skill enforces

When an orchestrator is running with autonomy mode active:

- **Idle is failure** — if backlog is non-empty and no worker is dispatched,
  the orchestrator dispatches the next item. No "should I proceed?"
- **Bus consumer protocol** — reading a teammate's bus message MUST trigger
  an action: take the next dependent task, clear the block, or escalate.
  Read-then-idle is a doctrine violation.
- **Stop conditions** — STOP only when the backlog is empty AND all workers
  done AND no bus traffic, OR when an irreversible decision is needed.
- **Memory + Vault required** — query `claude-mem` on session start; read
  `~/Documents/Obsidian Vault/<Project>/Portfolio.md` before proposing a
  plan; write decisions to vault and ledger.

Full doctrine: see [`components/skills/autonomy/SKILL.md`](components/skills/autonomy/SKILL.md).

### Telegram escalation: `subctl notify`

The autonomy skill names `subctl notify` as the escalation channel for
when the orchestrator hits an irreversible decision and the operator is
AFK. Pure bash + curl, standalone (no Python deps, no external connector
frameworks).

```bash
subctl notify --setup                    # one-time: store bot token + chat id
subctl notify --test                     # send a test message
subctl notify "Stuck on prisma migration — drop FK or backfill?"
```

To create a Telegram bot:

1. Open Telegram, search `@BotFather`, send `/start` then `/newbot`
2. Follow prompts, copy the token
3. Send any message to your new bot
4. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find your `chat.id`

Stored at `~/.config/subctl/notify.json` (mode 600). Falls back to
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars if not configured.

Always logs every call to `~/.claude/notification.log` regardless of
send outcome — auditable even if the bot is unreachable.

---

## Orchestration control plane (v1.3.0+)

Manage multiple tmux orchestrator sessions over HTTP. Any process can
spawn, control, or kill a session — useful for external orchestration
managers (e.g. ArgentOS), automation scripts, or your phone via
Telegram bot commands.

### CLI

```bash
subctl orch list                        # show all running orchestrator sessions
subctl orch spawn -a claude-personal \
                  -c ~/code/myproject \
                  -o -y \
                  -p "build feature X per ORCHESTRATION.md"
subctl orch status claude-myproject     # live pane preview
subctl orch msg claude-myproject "stop and commit current state"
subctl orch kill claude-myproject
```

### HTTP endpoints

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/orchestration/spawn` | `{account, project, prompt?, orchestrator?, continue?, skip_perms?, resume?}` |
| `GET`  | `/api/orchestration` | (list) |
| `GET`  | `/api/orchestration/:name` | (status + preview) |
| `POST` | `/api/orchestration/:name/msg` | `{text}` |
| `POST` | `/api/orchestration/:name/kill` | (kill) |

All endpoints bound to `127.0.0.1:8787` (no auth — localhost-only).

### Telegram bot (mobile control)

After `subctl notify --setup`, your phone can manage sessions too:

```
/sessions              list running orchestrators
/msg <name> <text>     inject text
/kill <name>           kill
/stats                 verdict + accounts + 5h%/week% + RL + savings
/inbox                 last 5 unacked replies
```

All sessions are name-addressable. Run 7 orchestrators at once and
target each individually by name from CLI, HTTP, or Telegram.

### How it routes

When you spawn a session via `subctl orch spawn`, it uses the same code
path as `claude-teams -a <account> -c <path>` but with `--no-attach`
so the dashboard process doesn't get stuck in tmux. The session runs
detached; the orchestrator does its work; reach it via:

- `tmux attach -t <name>` from any terminal
- `subctl orch status <name>` for non-attaching preview
- Telegram `/sessions` from anywhere

The orchestrator itself can `subctl notify ask-yesno`, etc., to escalate
back to you. Bidirectional, async-by-default.

---

## Pruning transcript history

Heavy orchestrator-mode users accumulate thousands of Claude Code session
JSONLs — every team-agent worker spawned by `Team*`/`SendMessage` writes
its own transcript file. The orchestrator's `tool_result` blocks already
contain the synthesized worker output, so the worker JSONLs are
functionally redundant past a few days and safe to delete.

```bash
# Default: workers older than 30 days, with confirmation
subctl prune-transcripts

# Preview only — see what would go, no changes
subctl prune-transcripts --dry-run

# Aggressive: workers >7 days, no prompt
subctl prune-transcripts --older-than 7d --yes

# Include OPERATOR sessions, not just workers (CAREFUL — these may be
# resume-worthy)
subctl prune-transcripts --all --older-than 90d

# Move instead of delete — keep an off-disk archive you can restore from
subctl prune-transcripts --archive ~/.claude-archive/
```

Worker detection: a session is classified as a worker if its first user
message starts with `<teammate-message teammate_id="…">`. The dashboard's
Session Browser hides workers by default for the same reason — toggle
the *show team-agent workers* checkbox to include them.

Typical numbers on a heavy machine: ~4,700 total session JSONLs becomes
~280 operator sessions after the worker filter. A 30-day prune typically
reclaims a few hundred MB.

---

## Concepts

**Accounts.** An account is a `(provider, alias)` pair plus a `CLAUDE_CONFIG_DIR`-style isolation root. Configured in `~/.config/subctl/accounts.conf`. Aliases (`claude-personal`, `claude-work`) are generated into your shell's rc file so `claude-personal` always means the same account regardless of which directory you're in.

**Radar.** The rate-limit awareness layer. Watches parallel sessions, session age, ctx %, and rate-limit hits today, and produces a dispatch verdict (green / yellow / red). Originally a separate project named `claude-dispatch-radar`; now folded in.

**Service.** A launchd-managed background process running the dashboard. `subctl service enable` installs the plist; `subctl service start` runs it now; `subctl service disable` removes it. State is read-only — the service does not mutate your accounts or settings.

**Dashboard.** A Bun HTTP+WS server bound to `127.0.0.1:8787`. Reads filesystem state directly, broadcasts updates over WebSocket. No auth, because it's localhost-only. Make it your browser's new-tab page if you want a glance-able view.

---

## Install

```
$ git clone https://github.com/webdevtodayjason/subctl.git ~/.subctl
$ cd ~/.subctl
$ ./install.sh
```

`install.sh` will:

- Symlink `bin/subctl` into `/usr/local/bin/`.
- Copy `config/accounts.conf.example` to `~/.config/subctl/accounts.conf` if absent.
- Append a managed block to your `~/.zshrc` (or `~/.bashrc`) that sources `lib/aliases.sh`.
- Populate `~/.claude/scripts/`, `~/.claude/hooks/`, `~/.claude/commands/` for the Claude provider's statusline, Stop hook, and `/dispatch-check` slash command.
- Optionally call `subctl install --migrate` if it detects `claude-dispatch-radar` or `claude-multi-account` in your environment. See [docs/migration.md](docs/migration.md).

## Uninstall

```
$ ~/.subctl/uninstall.sh
```

Removes the symlink, the managed shell block, and the launchd plist. Leaves `~/.config/subctl/accounts.conf` and `~/.claude/` alone — those are yours.

---

## Migrating from existing tools

If you already use any of the predecessor projects, see [docs/migration.md](docs/migration.md) for the exact diffs to expect:

- `claude-dispatch-radar` — auto-detected; its `statusLine` entry in `settings.json` is replaced and the Stop hook is moved.
- `claude-multi-account` — `accounts.conf` is imported and the alias block in `.zshrc` is replaced.
- `claude-teams` — replaced by `subctl teams claude`. A thin shim keeps the old name working.

---

## Roadmap

| Provider           | CLI / surface           | Target | Status         |
|--------------------|-------------------------|--------|----------------|
| Claude Code        | `claude` (Anthropic)    | v1.0   | **shipping**   |
| OpenAI Codex       | `codex` (OpenAI)        | v1.1   | planned (next) |
| Gemini Code Assist | `gemini` (Google)       | v1.2   | planned        |
| Z.AI Coding (GLM)  | tbd — likely IDE+API    | v1.3   | investigating  |
| Minimax Coder      | tbd — likely IDE+API    | v1.4   | investigating  |

Full per-provider plan with auth flows, isolation knobs, and open questions: [ROADMAP.md](./ROADMAP.md). Plugin model is the shape going forward — a provider is a directory under `providers/` implementing `auth.sh`, `signals.sh`, `teams.sh`. See [docs/adding-a-provider.md](docs/adding-a-provider.md). Per-release notes live in [CHANGELOG.md](./CHANGELOG.md).

---

## Contributing

PRs welcome. To add a new provider, read [docs/adding-a-provider.md](docs/adding-a-provider.md). For everything else, open an issue first so we can agree on shape before you write code.

## License

MIT — see [LICENSE](LICENSE).
