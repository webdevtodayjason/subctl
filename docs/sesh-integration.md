# sesh integration

`subctl` doesn't ship its own session navigator. Instead, it provides two commands that plug into [`sesh`](https://github.com/joshmedeski/sesh) — a mature, fast tmux session picker built on `fzf` — to give you a session list with **subctl's account + rate-limit metadata** layered on top.

If you don't already use sesh, install it:

```bash
brew install joshmedeski/sesh/sesh
brew install junegunn/fzf/fzf       # if you don't have fzf
```

## What you get

When you run `sesh connect` (or your shortcut for it), you see all tmux sessions in a fuzzy picker. With subctl's preview_command wired in, the right-hand sesh preview pane shows:

```
claude-work · you@company.com
─────────────────────────────────────────────
ctx        16%
status     working
branch     feat/your-branch*+
panes      1 active / 4 total
RL today   0
path       /Users/you/code/myproject
─────────────────────────────────────────────
[last 8 lines of the active pane, ANSI-colored]
```

Account label is color-coded the same way as the subctl statusline (cyan = personal, blue = work, magenta = overflow). Status is detected from the pane content (`working` / `idle` / `waiting`).

## One-time wiring

Edit `~/.config/sesh/sesh.toml` (create if missing):

```toml
[default_session]
preview_command = "subctl session-preview {}"

# Optional: tighten the picker to just session names
# preview_app    = "less"
```

That's it. Next time you run `sesh connect`, the preview pane is enriched.

## Suggested keybindings

In your `~/.tmux.conf`:

```tmux
# `prefix s` opens sesh
bind-key s display-popup -E -w 80% -h 70% "sesh connect $(sesh list -t -c | fzf-tmux -p 80%,70% \
  --no-border \
  --bind 'tab:down,btab:up' \
  --preview 'subctl session-preview {}' \
  --preview-window 'right:60%')"

# `prefix S` jumps directly to subctl-managed accounts (claude-* sessions)
bind-key S display-popup -E -w 60% -h 50% "subctl session-list --format sesh | fzf-tmux -p \
  --preview 'subctl session-preview {}' \
  | xargs -I{} tmux switch-client -t {}"
```

## How it works under the hood

`subctl session-preview <name>` does a single tmux capture + a few file reads:

| Data | Source |
|---|---|
| Account alias | `tmux show-environment -t <name> CLAUDE_CONFIG_DIR` → matched against `~/.config/subctl/accounts.conf` |
| ctx % | Latest `usage` block in `~/.claude*/projects/<sid>.jsonl` |
| status | Pattern-match against the last 10 lines of `tmux capture-pane` |
| branch + dirty/untracked | `git -C <session_path> branch --show-current` etc. |
| RL today | `~/.claude/rate-limit-events.log` filtered by today's date and the session's UUID |
| Path / pane count | `tmux display-message -p` and `tmux list-panes` |

Total runtime: ~80-150 ms per preview. Fast enough for sesh's interactive flow.

## `subctl session-list` formats

```bash
subctl session-list                    # plain (one line each, human-readable)
subctl session-list --format sesh      # session names only — sesh-friendly
subctl session-list --format json      # one JSON object per line — for scripting
```

Plain format example:

```
myproject     ●claude-work     ctx 16%  feat/your-branch  myproject
otherproject  ●claude-personal ctx 7%   main              otherproject
scratch       ●(none)          ctx 0%   main              scratch
```

JSON format example (one object per line):

```json
{"session":"myproject","path":"/Users/you/code/...","account":"claude-work","ctx_pct":16}
```

## Why we did it this way

The previous v0.3 release shipped a Go-based TUI session manager (`subctl deck`). After honest evaluation, it was **reinventing what sesh already does well** — fuzzy filtering, instant switching, mature UX — for ~2200 lines of code.

By integrating with sesh instead, we:

- Delete the maintenance burden of building a session picker
- Get sesh's polished UX for free (filtering, mouse, keyboard nav, terminal compat)
- Focus subctl on its actually-unique value: **the metadata layer** (account isolation, rate-limit-aware signals, dispatch readiness, multi-provider roadmap)
- Stay composable — if you don't like sesh, the same `subctl session-preview` works as a preview for any picker (`fzf` directly, `tmuxinator`, custom scripts)
