# subctl dashboard help

Reference for the `localhost:8787` dashboard. Read top-down — sections are
ordered for mid-flight skimming.

## At a glance

The dashboard answers one question on every glance: **can I dispatch
another agent right now?** The big banner verdict is the answer.

| Verdict | Color  | Meaning |
|---------|--------|---------|
| **GO**   | green  | At least one account is healthy. Fire away. |
| **HOLD** | yellow | All ready accounts are showing pressure (≥70% weekly, ≥80% 5h, recent 429s, or 3+ parallel sessions). Pick a different account or wait. |
| **STOP** | red    | Every account is constrained or unauthenticated. Don't dispatch. |

Per-account badges in the **Accounts** table use the same `GO/HOLD/STOP`
labels but are scoped to that one account. The global banner is the
**best-of** — whichever account is healthiest.

**5h** and **week** meters are colored independently. 5h: yellow ≥80%, red
≥95%. Week: yellow ≥70%, red ≥90%. The bar fill mirrors the percentage so
you can read it at a glance without parsing the number.

The **Utilization 24h** strip shows the 5-hour-window peak per hour for
the last 24 hours, one cell per hour, oldest left → newest right. A small
**red dot** in a cell's top-right corner means a 429/529 event landed in
that hour. Empty cells (no poll, account hadn't auth'd yet) render dim.

## Reading the dashboard

Five panels, top to bottom.

### Top banner — dispatch verdict

Big verdict (`GO` / `HOLD` / `STOP`), one-line tagline, bullet list of
per-account reasons. Below: an info strip with `<n> tmux · <n> ready
accounts · <n> RL today`.

The verdict is computed **per account** (see [Signals](#signals--what-each-metric-measures))
and the global verdict is the best of any account's verdict. If one
account is GO and three are HOLD, the banner says GO — there's somewhere
to dispatch — but the reasons list still surfaces the constrained
accounts so you know which alias to pass to `subctl teams`.

**Act when:** banner is yellow → pick a specific GO account explicitly
with `-a <alias>`. Red → stop, investigate via `subctl radar`.

### Accounts table

One row per configured account. Columns:

| Column        | What it shows |
|---------------|---------------|
| `alias`       | Account alias from `accounts.conf`, with color dot. |
| `provider`    | `claude` (gemini/openai are stubs). |
| `auth`        | `ready` (creds present) or `not_authenticated`. |
| `dispatch`    | Per-account verdict pill: GO / HOLD / STOP. |
| `5h`          | 5-hour rolling window utilization, from `/api/oauth/usage`. Bar + percent. |
| `week`        | 7-day utilization, from `/api/oauth/usage`. Bar + percent. |
| `active`      | Tmux sessions currently bound to this account's `CLAUDE_CONFIG_DIR`. |
| `RL today`    | Count of rate-limit / overload events attributed to this account today. |
| `last activity` | Wall-clock age of the most recent tmux session on this account. |

**Act when:** dispatch is RED → don't send work there. 5h ≥80% → that
account will probably 429 within the next hour; switch. RL today ≥3 →
hook is detecting repeat hits, account is unhappy.

### Active sessions table

One row per **tmux** session. Click a row to expand and see the last
3 lines of the active pane. Columns: session name, account, project
(repo basename), branch, ctx %, age, status (`working` / `idle` /
`waiting` / `unknown`), and current pane command.

`ctx` is filesystem-derived — counted from the most recent `.jsonl` in
the account's `projects/` dir. Yellow ≥30%, orange ≥60%, red ≥80%.

`age` is wall-clock since `tmux session_created`. Yellow ≥2h, red ≥6h.

`status` is heuristic from a tail-3 of `tmux capture-pane`: spinners or
"Tool use:" → working, permission prompts → waiting, visible `❯` prompt
→ idle.

**Act when:** ctx is red → context window almost full, that pane needs
`/compact` or a fresh session. age is red → likely a stale tmux session
you forgot about (`subctl session-prune --older-than 6h`).

### Utilization (24h)

One row per account: alias on the left, 24-cell strip in the middle,
trailing-24h count on the right. Each cell = one hour, oldest → newest.
Color = peak 5-hour-window utilization observed during that hour
(green low → green-warm → yellow → red). A **red dot** overlays any
hour where the local Stop hook recorded a 429/529 event.

This panel is the early-warning view. Walking utilization curves up
across the day means you're approaching the weekly cap; a dot means
Anthropic actually rejected a request in that hour.

### Recent events

Newest-first table of today's rate-limit / overload events as seen by
the local Stop hook. Columns: `WHEN` (HH:MM), `TYPE` (`429
(rate_limit)` or `529 (overload)`), `SEVERITY` (`WARN` for 429 / `INFO`
for 529 — overload isn't your fault), `ACCOUNT`, `SESSION` (UUID).

Older events written before per-account attribution shipped show
`unknown — older event` in the ACCOUNT column. New events carry the
explicit `account` field from the hook.

**Act when:** repeated 429s on one account in a short window → that
account is rate-limited; switch with `subctl teams claude -a
<other-alias>`.

## Setting up an account

Three commands to a working dashboard row:

```bash
subctl accounts add claude foo foo@bar.com    # 1. register the account
subctl auth claude foo                          # 2. browser OAuth
subctl share foo                                # 3. share customization layer
```

That's it. Refresh the dashboard; the new alias shows up.

### What gets stored where

**`~/.config/subctl/accounts.conf`** — pipe-delimited registry. Step 1
appends a row:

```
foo | claude | foo@bar.com | ~/.claude-foo | (description)
```

**`~/.claude-foo/`** — per-account config dir created by step 2. Holds
exactly what `~/.claude` would for a single-account install:

- `.credentials.json` — Claude Code's lookup pointer; the actual bearer
  is in macOS Keychain.
- `projects/<project-id>/<session-uuid>.jsonl` — every Claude Code
  conversation transcript.
- `settings.json` — per-account model / theme.
- `history.jsonl`, `plugins/`, `caches/` — strictly per-account.

**macOS Keychain** — Claude Code stores the OAuth bearer under service
name `Claude Code-credentials-<sha256(cfg_dir)[:8]>`. subctl never
touches passwords; it lets `claude` itself drive the OAuth flow with
`CLAUDE_CONFIG_DIR=~/.claude-foo` set. To inspect:

```bash
security find-generic-password -s "Claude Code-credentials-<hash>"
```

**Symlinked customization layer** — step 3 (`subctl share`) symlinks the
shareable parts of `~/.claude` into the new cfg_dir so your slash
commands, agents, hooks, output styles, and `CLAUDE.md` work identically
across accounts. Symlinked items:

| Item              | What it is |
|-------------------|------------|
| `agents/`         | Sub-agent definitions. |
| `commands/`       | Slash commands like `/dispatch-check`. |
| `hooks/`          | Stop / SessionStart / etc. hooks. |
| `output-styles/`  | Custom output style presets. |
| `scripts/`        | Statusline + dispatch-check helper scripts. |
| `CLAUDE.md`       | Top-level instructions. |

Auth, project transcripts, and settings stay strictly per-account.
Symlinks won't clobber pre-existing real files; safe to re-run.

## CLI reference

Generated from `bin/subctl` usage(). Run `subctl help` to see the live
version on your install.

### Account management

| Command | Description |
|---------|-------------|
| `subctl accounts` | Show account status table. |
| `subctl accounts add <provider> <alias> <email> [config_dir] [description]` | Append a row to `accounts.conf`. |
| `subctl accounts remove <alias> [--purge]` | Drop the row. `--purge` also rm's the config_dir. |
| `subctl accounts edit` | Open `accounts.conf` in `$EDITOR`. |
| `subctl whoami` | Print current shell's `CLAUDE_CONFIG_DIR` → alias. |
| `subctl config [show\|edit\|path]` | Show, edit, or print path to `accounts.conf`. |

Example:

```bash
subctl accounts add claude personal me@example.com
subctl accounts add claude work    me@company.com ~/.claude-work "work account"
```

### Auth

| Command | Description |
|---------|-------------|
| `subctl auth claude <alias>` | OAuth into the account's config dir (browser flow). |
| `subctl auth all` | Walk every account that needs auth. |

Example:

```bash
subctl auth claude personal
```

### Sessions

| Command | Description |
|---------|-------------|
| `subctl session-list [--format plain\|sesh\|json]` | List tmux sessions enriched with account + ctx + RL. |
| `subctl session-preview <name>` | Render the metadata block + last activity for one session. |
| `subctl session-kill <name> [name...]` | Kill one or more tmux sessions. |
| `subctl session-prune [--older-than 6h] [--yes]` | Kill all tmux sessions older than DUR (default 6h). |
| `subctl prune-transcripts [opts]` | Delete OLD CLAUDE CODE TRANSCRIPT JSONLs to reclaim disk. Default: workers >30d. |

Example:

```bash
subctl session-prune --older-than 6h --yes
```

#### Pruning transcript history

Heavy orchestrator-mode users accumulate thousands of transcript JSONLs
(every team-agent worker spawned by the `Team*`/`SendMessage` tools writes
its own session file). These are functionally redundant with the
orchestrator's `tool_result` blocks and can safely be deleted.

```bash
# Defaults: workers older than 30 days, prompts before deleting
subctl prune-transcripts

# Preview only — show what would go, don't touch anything
subctl prune-transcripts --dry-run

# More aggressive: workers older than 7 days, no prompt
subctl prune-transcripts --older-than 7d --yes

# Include OPERATOR sessions, not just workers (CAREFUL — these may be
# resume-worthy)
subctl prune-transcripts --all --older-than 90d

# Move instead of delete — keep an off-disk archive you can restore from
subctl prune-transcripts --archive ~/.claude-archive/
```

Worker detection: a session is classified as a worker if its first user
message begins with `<teammate-message teammate_id="…">` (the marker
`Team*`/`SendMessage` injects when spawning team agents).

### Teams (tmux launcher)

| Command | Description |
|---------|-------------|
| `subctl teams claude -a <alias> [-y -c -o -p TEXT -f FILE --dry-run]` | Launch tmux session pinned to an account, with orchestrator + worker layout. |

Flags: `-a` alias · `-o` orchestrator pane on · `-c` claude in panes ·
`-y` non-interactive (skip prompts) · `-p TEXT` initial prompt · `-f FILE`
prompt-from-file · `--dry-run` print the tmux commands without running.

Example:

```bash
subctl teams claude -a personal -o -c -y
```

### Radar / dispatch

| Command | Description |
|---------|-------------|
| `subctl radar` | `/dispatch-check` verdict + cross-account signals (CLI version of the dashboard banner). |
| `subctl radar log [--tail]` | Tail the rate-limit events log. |

### Usage

| Command | Description |
|---------|-------------|
| `subctl usage` | Per-account 5h / 7d / 7d-Sonnet / 7d-Opus utilization table (60s on-disk cache). |
| `subctl usage <alias>` | Raw `/api/oauth/usage` JSON for one account. |
| `subctl usage --json` | All accounts as a JSON array. The dashboard reads this. |

### Customization sharing

| Command | Description |
|---------|-------------|
| `subctl share [alias\|all]` | Symlink `~/.claude/{agents,commands,hooks,output-styles,scripts,CLAUDE.md}` into account cfg_dirs. Idempotent. |

### Dashboard / service

| Command | Description |
|---------|-------------|
| `subctl service status` | Show service state. |
| `subctl service start \| stop \| restart` | Control the running process. |
| `subctl service enable \| disable` | Install / uninstall the launchd plist (auto-start at login). |
| `subctl service logs [N]` | Last N log lines (default 50). |
| `subctl service foreground` | Run dashboard in current shell (debug). |
| `subctl dashboard` | Ensure service is running, open browser. |

### Doctor / install

| Command | Description |
|---------|-------------|
| `subctl doctor` | Health check: required tools, Claude Code integration symlinks, service state, accounts. |
| `subctl install [--migrate]` | Install / re-install (interactive). |
| `subctl uninstall` | Remove subctl. |
| `subctl version` | Print version. |

## Signals — what each metric measures

Provenance matters. Different signals come from different sources;
treat them with different weights.

| Signal | Source | Authority |
|--------|--------|-----------|
| Weekly % | Anthropic `/api/oauth/usage` (live, on every dashboard tick via 30s in-process cache + 60s disk cache) | authoritative |
| 5h % | same | authoritative |
| 24h utilization cells | subctl's own 5-min poller of `/api/oauth/usage`, max'd per hour | authoritative (sampled) |
| RL events (today + recent) | local Claude Code Stop hook scanning transcripts for `429` / `529` literals | observed-locally |
| Session ctx % | local `.jsonl` scanning — sums input/output tokens vs 200K context window | derived |
| Session age | tmux `session_created` (fallback: first jsonl timestamp) | derived |
| Active session count | `tmux list-sessions` cross-referenced with `CLAUDE_CONFIG_DIR` | derived |

### Per-account verdict thresholds

| Signal | Yellow | Red |
|--------|--------|-----|
| Weekly utilization | ≥70% | ≥90% |
| 5-hour utilization | ≥80% | ≥95% |
| RL hits today | ≥1 | ≥3 |
| Parallel sessions on this account | ≥3 | ≥5 |
| Auth status | — | not authenticated |

Verdict is the **max severity** across all triggered signals. Reasons
list each triggered threshold separately.

### What does NOT drive the verdict

**Session ctx %** and **session age** are per-pane signals shown in the
sessions table. They explicitly do **not** feed the dispatch verdict —
because a fresh dispatch in a different folder doesn't care that some
other tmux session has 78% ctx. If you're about to launch a new agent
in `~/code/foo`, the only question is whether the *account* you're
dispatching to has headroom.

### Forward-looking attribution

Rate-limit events written **before** the per-account attribution patch
(commit on this branch) lack an `account` field. The dashboard tries
to back-attribute them via session UUID, but if the session has been
dropped from tmux, those rows show `unknown — older event` in the
events table. New events carry the field explicitly.

## How it interacts with Anthropic services

```
                 ┌─────────────────────────────────────────────┐
                 │  Anthropic                                  │
                 │                                             │
                 │  ┌──────────────┐    ┌────────────────────┐ │
                 │  │  claude.ai   │    │ api.anthropic.com  │ │
                 │  │  (browser)   │    │  /v1/messages      │ │
                 │  │  OAuth login │    │  /api/oauth/usage  │ │
                 │  └──────┬───────┘    └─────────┬──────────┘ │
                 │         │                      │            │
                 │  ┌──────┴──────────────────────┴──────┐     │
                 │  │  platform.claude.com               │     │
                 │  │  docs · marketing · billing        │     │
                 │  └────────────────────────────────────┘     │
                 └─────────┬────────────────┬──────────────────┘
                           │ OAuth code     │ HTTPS bearer
                           ▼                ▼
                ┌──────────────────────────────────────┐
                │  your Mac                            │
                │                                      │
                │  ┌─────────────────────────────┐    │
                │  │  Claude Code (the CLI)      │    │
                │  │  - drives the OAuth flow    │    │
                │  │  - stores bearer in Keychain│    │
                │  │  - calls api.anthropic.com  │    │
                │  └────────────┬────────────────┘    │
                │               │                     │
                │               │ reads token         │
                │               ▼                     │
                │  ┌─────────────────────────────┐    │
                │  │  macOS Keychain             │    │
                │  │  Claude Code-credentials-   │    │
                │  │   <sha256(cfg_dir)[:8]>     │    │
                │  └────────────┬────────────────┘    │
                │               │                     │
                │               │ piggybacks          │
                │               ▼                     │
                │  ┌─────────────────────────────┐    │
                │  │  subctl                     │    │
                │  │  - sets CLAUDE_CONFIG_DIR   │    │
                │  │  - calls /api/oauth/usage   │    │
                │  │    (with bearer from KC)    │    │
                │  │  - never sees passwords     │    │
                │  └─────────────────────────────┘    │
                └──────────────────────────────────────┘
```

**claude.ai** — where browser-based OAuth login happens. subctl drops
you into Claude Code, which opens this URL.

**api.anthropic.com** — where the API runs. `/v1/messages` for actual
work; `/api/oauth/usage` for the meter. The dashboard polls the
latter every 5 minutes per account.

**platform.claude.com** — docs, marketing, billing. Not on subctl's
hot path.

**Claude Code (the CLI)** — runs OAuth, persists the bearer in macOS
Keychain, refreshes it automatically when it expires. subctl piggybacks
on this — `subctl auth claude foo` is just `CLAUDE_CONFIG_DIR=~/.claude-foo
claude`. No second auth flow.

**subctl** — never touches passwords. Reads the Keychain entry that
`claude` wrote, uses that bearer to hit `/api/oauth/usage`. If the
bearer is stale, Claude Code refreshes it on its next call.

## Troubleshooting

**Q: A new account row says `not_authenticated` in the auth column.**
→ The OAuth flow didn't complete. Re-run `subctl auth claude <alias>`,
finish the browser flow, type `/exit` in the Claude Code prompt to
return.

**Q: The Accounts table shows `5h —` and `week —` for an account that's
clearly authenticated.**
→ `/api/oauth/usage` failed for that bearer. Check `subctl usage
<alias>` from the CLI; if it 401s, the Keychain entry has gone stale —
`security delete-generic-password -s "Claude Code-credentials-<hash>"`
then re-run `subctl auth claude <alias>`.

**Q: Recent events table shows `unknown — older event` in the account
column.**
→ Expected. Events written before per-account attribution shipped
have no `account` field. The dashboard back-attributes via session
UUID where possible; sessions long gone from tmux can't be resolved.
Forward-looking only.

**Q: Dashboard shows nothing / `connecting…` forever.**
→ The service isn't running. `subctl service status`. If stopped:
`subctl service start`. If never installed: `subctl service enable`.

**Q: `subctl service start` fails with `bun: command not found`.**
→ Install Bun: `curl -fsSL https://bun.sh/install | bash`. The
dashboard is a single-file Bun server; no Node, no npm deps.

**Q: `claude-use foo` says command not found.**
→ The shell function isn't in your shell's rc file. Check `~/.zshrc`
(or `~/.bashrc`) for the `# >>> subctl >>>` … `# <<< subctl <<<`
managed block. If missing, re-run `~/.subctl/install.sh`.

**Q: `subctl accounts` shows a config_dir that doesn't exist.**
→ `accounts.conf` row was written before `subctl auth` ran. Either
run `subctl auth claude <alias>` to create it, or `subctl accounts
remove <alias>` to drop the dead row.

**Q: Claude Code says "session expired, please log in".**
→ Claude Code normally refreshes tokens automatically. If it can't
(network glitch during refresh, manually-deleted Keychain entry),
re-run `subctl auth claude <alias>` to redo the OAuth flow.

**Q: `subctl doctor` shows `!` next to a hook/script path saying "not
subctl".**
→ Something else (a previous hand-rolled hook, an older version of
`claude-dispatch-radar`) wrote a real file there. Move it aside and
re-run `subctl install` to re-symlink, or `subctl install --migrate`
which auto-handles the predecessor projects.

**Q: Dashboard pulse dot stops flashing.**
→ WebSocket disconnected. The status pill goes yellow (`reconnecting…`)
within 5s. If it stays there, the server died — `subctl service
logs 200`.

## What's NOT here / future work

- **Multi-machine federation.** Each subctl install only sees its own
  host's tmux sessions and `.jsonl` transcripts. There's no cross-host
  view. If you have agents running on three Macs, you need three
  dashboards.

- **Gemini and OpenAI providers.** Stubs only. The plugin architecture
  exists (`providers/<name>/`) but `auth.sh` / `teams.sh` for those
  providers print "not yet implemented" and exit. Phase 2/3.

- **Old log-entry attribution.** Rate-limit events written before the
  per-account attribution patch lack the `account` field. Best-effort
  back-attribution via session UUID; events whose sessions are gone
  from tmux stay un-attributed forever. Forward-looking fix only.

- **Anthropic `/api/oauth/usage` is undocumented.** It's the same
  endpoint Claude Code itself uses for its `/usage` slash command, but
  it's not part of any documented API surface. Schema or auth shape
  could change without notice. If `subctl usage` starts returning
  errors, this is the first thing to suspect.

- **Cost analysis** — per-account dollar spend, monthly burn-rate
  graphs, extra-credit alerts: see future work (in development on a
  separate branch). Not part of this build.

- **Windows / Linux.** Keychain integration is macOS `security`
  command-only. Linux Secret Service / Windows Credential Manager
  paths exist in Claude Code itself, but subctl's keychain helpers
  (and launchd integration) are macOS-specific.
