# subctl

**Subscription Central for AI subscriptions you're paying for.**

One CLI + TUI + dashboard for the AI subscriptions you already pay for. Today it speaks Claude. Gemini and OpenAI are next.

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

Every subctl install drops three short-form binaries alongside `subctl` itself, for muscle-memory parity with how you've probably been working:

| Shim          | Equivalent           | What it does |
|---------------|----------------------|--------------|
| `claude-teams [opts]` | `subctl teams claude [opts]` | Launch a tmux session pinned to a specific Claude account. |
| `claude-radar`        | `subctl radar`              | Print the dispatch-readiness verdict + cross-account signals. |
| `claude-dash`         | `subctl dashboard`          | Ensure the dashboard service is running, open the browser. |

All four binaries (`subctl`, `claude-teams`, `claude-radar`, `claude-dash`) are symlinks into the repo, so `git pull && ./install.sh` is the only update path.

If `claude-teams` already exists at `/usr/local/bin/claude-teams` (e.g. a hand-rolled script you wrote previously), the installer backs it up to `~/code/claude-teams.pre-subctl.<timestamp>.bak` before replacing it. Uninstall restores the backup.

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

| Version | Provider     | Status    |
|---------|--------------|-----------|
| 0.1     | Claude       | shipping  |
| 0.2     | Gemini       | planned   |
| 0.3     | OpenAI       | planned   |
| 0.4+    | Plugin model | exploring |

The plugin model: a provider is a directory under `providers/`. See [docs/adding-a-provider.md](docs/adding-a-provider.md).

---

## Contributing

PRs welcome. To add a new provider, read [docs/adding-a-provider.md](docs/adding-a-provider.md). For everything else, open an issue first so we can agree on shape before you write code.

## License

MIT — see [LICENSE](LICENSE).
