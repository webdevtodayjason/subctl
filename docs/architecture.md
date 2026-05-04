# Architecture

`subctl` is a thin orchestration layer on top of three things:

1. Each provider's official multi-account isolation knob (e.g. `CLAUDE_CONFIG_DIR`).
2. Filesystem state that already exists (Claude Code transcripts, settings, hooks).
3. A small shell engine that exposes the same operations as both a TUI menu and flat commands.

This document explains the layout and where new code should go.

---

## Repository layout

```
subctl/
├── bin/
│   └── subctl                   # dispatcher (bash). No args → TUI; with args → flat command.
├── lib/
│   ├── core.sh                  # shared helpers: logging, paths, JSON read, locking
│   ├── tui.sh                   # gum-based menus
│   ├── accounts.sh              # accounts.conf parser, alias generator
│   ├── service.sh               # launchd plist install / start / stop
│   ├── radar.sh                 # parallel sessions, ctx %, RL hits today
│   └── aliases.sh               # sourced by user's shell rc
├── providers/
│   ├── claude/
│   │   ├── auth.sh              # provider_auth <alias> <config_dir>
│   │   ├── signals.sh           # provider_signals <alias> → kv pairs
│   │   ├── teams.sh             # provider_teams [...args]
│   │   ├── statusline.sh        # printed by Claude Code's statusLine setting
│   │   ├── hooks/
│   │   │   └── stop.sh          # Stop hook — scans transcript for RL literals
│   │   └── commands/
│   │       └── dispatch-check.md
│   ├── gemini/                  # planned, v0.2
│   └── openai/                  # planned, v0.3
├── dashboard/
│   ├── server.ts                # Bun HTTP+WS server
│   ├── public/
│   └── tsconfig.json
├── config/
│   └── accounts.conf.example    # template — committed
├── scripts/
│   ├── check-no-secrets.sh      # CI gate
│   └── ...
├── install.sh
├── uninstall.sh
├── docs/
└── .github/workflows/ci.yml
```

---

## The dispatcher

`bin/subctl` is plain bash. With no args it sources `lib/tui.sh` and shows the gum menu. With args it dispatches to the matching flat command:

```
$ subctl                              # TUI
$ subctl auth claude personal         # flat: providers/claude/auth.sh provider_auth personal …
$ subctl service start                # flat: lib/service.sh
$ subctl teams claude -a personal -o  # flat: providers/claude/teams.sh
```

Both paths source the same `lib/*.sh` files. The TUI is a wrapper around the same functions, not a duplicate implementation.

---

## Provider interface

Each provider directory implements three required functions:

| Function          | Where           | Contract                                                                |
|-------------------|-----------------|-------------------------------------------------------------------------|
| `provider_auth`   | `auth.sh`       | `provider_auth <alias> <config_dir>` — runs the provider's login flow with isolation. |
| `provider_signals`| `signals.sh`    | `provider_signals <alias>` — prints kv pairs (or JSON) about live state. |
| `provider_teams`  | `teams.sh`      | `provider_teams [...args]` — launches a tmux session pinned to an account. |

Optional:

| Path                        | Purpose                                              |
|-----------------------------|------------------------------------------------------|
| `statusline.sh`             | Printed by the provider's CLI as a statusline.       |
| `hooks/<event>.sh`          | Hook scripts the provider's CLI invokes.             |
| `commands/<name>.md`        | Slash-command definitions for the provider's CLI.    |

`subctl install` installs the optional bits to the right path for that provider. For Claude that means `~/.claude/scripts/`, `~/.claude/hooks/`, `~/.claude/commands/`, plus a `statusLine` and `hooks` entry in `~/.claude/settings.json`.

Adding a new provider is "make a new directory under `providers/`". See [adding-a-provider.md](adding-a-provider.md).

---

## Configuration

| Path                                       | What                                              | In repo? |
|--------------------------------------------|---------------------------------------------------|----------|
| `config/accounts.conf.example`             | Template, ships with the repo                     | yes      |
| `~/.config/subctl/accounts.conf`           | The user's real accounts                          | no       |
| `~/.config/subctl/state/`                  | Cached signal data, last-seen RL counters         | no       |
| `~/.claude/scripts/subctl-statusline.sh`   | Installed by `subctl install`                     | no (installed) |
| `~/.claude/hooks/subctl-stop.sh`           | Installed by `subctl install`                     | no (installed) |
| `~/.claude/commands/dispatch-check.md`     | Installed by `subctl install`                     | no (installed) |
| `~/.claude/settings.json`                  | Owned by Claude Code; subctl edits a managed block | no      |

The "managed block" pattern: `subctl install` writes its additions between `# >>> subctl >>>` and `# <<< subctl <<<` markers in `~/.zshrc` and `~/.claude/settings.json`. Outside those markers is yours; inside is `subctl`'s.

---

## Dashboard

`dashboard/server.ts` is a Bun program. It:

- Binds to `127.0.0.1:8787`.
- Serves static files from `dashboard/public/`.
- Reads filesystem state directly — `~/.claude/projects/*/transcript.jsonl`, `~/.config/subctl/state/`.
- Pushes updates over a WebSocket on the same port.

The dashboard is **independent of CLI invocation**. The TUI does not need to be open. The launchd plist runs `bun dashboard/server.ts` at login, and the dashboard stays up. If you kill it, the TUI/CLI keep working — the dashboard is a *view*, not the source of truth.

---

## Why bash + Bun

Bash for the engine because the operations are 90% "read JSON, fork a process, edit a config file". The Bun dashboard is in TypeScript because long-running HTTP+WS in bash would be misery. The boundary is clean: bash writes filesystem state, Bun reads it.
