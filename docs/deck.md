# The deck — live session manager

`subctl deck` is a Go + Bubble Tea TUI that shows every tmux session on your machine in a single grid, with status detection, live ANSI preview, and inline new-session creation. It is the fourth pillar of subctl alongside accounts management, radar, and the web dashboard.

## When to use the deck vs other surfaces

| Surface | Use it for |
|---|---|
| `subctl` (bash TUI) | Single-shot menu actions: add an account, enable the service, run doctor. Lives in your terminal as a stateless menu. |
| `subctl deck` | **Continuous** view of every active session. Drill, attach, kill, spawn — without leaving the TUI. |
| `subctl dashboard` | Read-only **web** view, runs as a launchd service, useful as a browser new-tab page. Cross-machine if you forward the port. |

The deck and the dashboard read the same data sources; they're just different presentations.

## Layout

```
╔══════════════════════════════════════════════════════════════════════════╗
║  subctl deck                                            v0.3.0 · 09:42   ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                          ║                                ║
║  ▾ myproject                          ║  ───── claude-work ────── ║
║      ● claude-work  16% ctx  4 panes ║                                ║
║       ├ orchestrator        ctx 65%      ║   > /usage                     ║
║       ├ worker:auth         ctx 12%      ║   Status                       ║
║       ├ worker:tests        ctx 23%      ║     Total cost: $73.19         ║
║       └ worker:docs         ctx 8%       ║     ...                        ║
║      working                              ║                                ║
║                                          ║                                ║
║    holace                                ║                                ║
║      ● claude-jason     7% ctx   2 panes ║                                ║
║      branch: main                        ║                                ║
║      idle 3m                              ║                                ║
║                                          ║                                ║
║  ─                                       ║                                ║
║  [n] new   [k] kill  [a] attach  [r] ↻   ║  ↑↓ scroll preview             ║
║  [s] split  [q] quit                     ║  ←→ switch session             ║
╚══════════════════════════════════════════════════════════════════════════╝
```

**Left rail (~40%):** sessions grouped by project (basename of `tmux session_path`). Each row shows the account, the rolling context %, pane count, branch, status badge, and relative idle time. Worker panes appear as a tree under their parent session.

**Right rail (~60%):** live `tmux capture-pane -p -e` of the focused session's active pane. ANSI colors preserved. Auto-refreshes every 2 seconds.

## Status detection

Each row's status badge comes from parsing the last ~200 lines of pane content:

| Badge | How it's detected |
|---|---|
| `working` | Active spinner glyphs (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) within the last 10 lines, OR `Tool use:` / "thinking…" tells |
| `idle` | A Claude prompt (`> `) is visible at the tail with no recent activity |
| `waiting` | Tail matches a permission prompt: `Do you want to`, `[y/n]`, `Approve`, `(esc to interrupt)` |
| `unknown` | Fallback when no other pattern matches |

Status is recomputed on every refresh tick.

## Account color mapping

Same rule as the bash statusline (so cycling between surfaces keeps your visual cues stable):

| Alias contains | Color |
|---|---|
| `personal` or `jason` | cyan |
| `work` | blue |
| `overflow` | magenta |
| anything else | grey |

## Keymap

| Key | Action |
|---|---|
| `↑` `↓` or `K` `j` | Move selection up/down |
| `space` / `enter` | Toggle expand on a project group |
| `n` | New session modal |
| `k` | Kill the selected session (with confirm) |
| `a` | Attach (suspends the deck, exec `tmux attach`) |
| `r` | Force refresh now |
| `?` | Toggle help |
| `q` | Quit |

The deck refreshes every 2 seconds automatically; `r` is for impatience.

## New session modal

`n` opens an overlay with three text inputs and three checkboxes:

```
╔══════════════════════════════════════════════════╗
║  New session                                      ║
╠══════════════════════════════════════════════════╣
║  Account:  [▾ claude-work]                   ║
║  Folder:   [/Users/you/code/myproject]           ║
║  Name:     [claude-myproject]                    ║
║                                                  ║
║  □ orchestrator prompt                           ║
║  □ continue (-c)                                 ║
║  □ skip permissions (-y)                         ║
║                                                  ║
║  [enter] launch    [esc] cancel                  ║
╚══════════════════════════════════════════════════╝
```

On enter the deck shells out to `subctl teams claude -a <alias>` with the selected flags. That's the same code path the CLI uses, so the launch is identical to typing `claude-teams -a work -o -c -y` in your shell.

## Requirements

- Go 1.21+ at install time (`brew install go`). The binary is built once by `subctl install` and lives at `bin/subctl-deck` (gitignored — source under `deck/` is committed).
- tmux installed (`brew install tmux`). Without tmux the deck shows the empty-state hint and `n` is the only useful key.

## How it relates to the rest of subctl

The deck reads — never writes — the same files the bash CLI uses:

```
~/.config/subctl/accounts.conf       (parsed by deck/accounts/conf.go)
~/.claude*/projects/*.jsonl          (per-session metadata, ctx %)
~/.claude/rate-limit-events.log      (RL hits)
tmux list-sessions / list-panes      (live state)
```

It writes nothing. State changes (new session, kill) are delegated to `subctl teams claude` and `tmux kill-session` respectively. So if the deck has a bug, no data is at risk — worst case you `q` out and use the bash CLI.

## Limitations in v0.3

- macOS and Linux only. Windows (including WSL terminal) untested.
- Sub-pane status detection only runs on the active pane of each session in v0.3 — non-active panes show last-known status until you switch panes. Fixing this is a v0.4 item.
- No worktree integration yet — that's a planned v0.4 feature inspired by [claude-tmux](https://github.com/nielsgroen/claude-tmux).
- No remote management (Telegram bridge à la ccbot) — v0.5+ if there's demand.
