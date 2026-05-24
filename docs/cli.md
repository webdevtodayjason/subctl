# subctl CLI reference (v2.7.28+, expanded v2.7.36)

`bin/subctl` is the bash dispatcher shipped at `/usr/local/bin/subctl` (or
`~/.local/bin/subctl` if `/usr/local/bin` isn't writable). It's how the
operator drives Evy + the dashboard daemon from any terminal. (Some CLI subcommands still use the word `master` — e.g. `subctl master`, `subctl logs --master` — these are legacy code-level identifiers; future: `subctl evy`.) The TUI
you get by running `subctl` with no arguments is the same dispatcher with
a different default branch.

This doc covers the **eight HTTP-backed verbs** the v2.7.28/v2.7.36 work
landed: `status`, `logs`, `deploy`, `notif`, `memory` (v2.7.28) and
`team`, `config`, `profile` (v2.7.36). All eight share the same shape:
text-by-default, plain stdout, exit 0 on success / 1 on failure, all
output color-friendly under TTY and stripped when `NO_COLOR=1` is set.
For account / auth / template / orchestration verbs see the inline
`subctl help` table and [docs/master.md](./master.md).

## Quick reference

```
subctl status [--json]
subctl logs [--master | --dashboard] [--tail N] [--follow|-f]
subctl deploy [--no-pull] [--dry-run]
subctl notif [recent | list <N> | mark-all-read]
subctl memory [recent <N> | search <query> | remember <text>]
subctl team list
subctl team kill <name>
subctl team exec <name> <command...>
subctl team logs <name> [--tail N] [--follow|-f]
subctl config show [section]
subctl config edit  [section | path]
subctl config validate
subctl profile show
subctl profile switch <chat|heavy>
subctl profile list
```

All five exit 0 on success, 1 on failure, with errors going to stderr.
Output is plain-text by default, color-friendly under TTY, suppressed
when `NO_COLOR=1` is set. No spinners or progress bars.

## Environment variables

| Variable | Default | What it does |
|----------|---------|--------------|
| `SUBCTL_MASTER_PORT` | `8788` | Where `subctl status` looks for Evy. <!-- env var name is a legacy code identifier — renamed in Phase 3 --> |
| `SUBCTL_SERVICE_PORT` | `8787` | Where `subctl status` / `notif` / `memory` look for the dashboard. |
| `SUBCTL_LOG_DIR` | `~/Library/Logs/subctl` | What `subctl logs` tails. |
| `NO_COLOR` | unset | Set to `1` to strip ANSI escapes. |

## `subctl status`

One-shot probe against the two daemons. The text path prints two
human-readable lines; `--json` emits a single combined doc for scripts.

```
$ subctl status
subctl v2.7.28
  ✓ master      v2.7.28    uptime=12345s  subs=3  profile=chat  telegram=polling
  ✓ dashboard   v2.7.28    url=http://127.0.0.1:8787

$ subctl status --json
{
  "ok": true,
  "cli_version": "2.7.28",
  "master":    { "ok": true, "version": "2.7.28", "uptime_s": 12345, ... },
  "dashboard": { "version": "2.7.28" }
}
```

Exit codes: `0` if both daemons responded; `1` if either is unreachable.

## `subctl logs`

Tails the launchd log files. Default: last 50 lines of all three
(`master.log`, `dashboard.out.log`, `dashboard.err.log`) with a banner
separating each. Use `--master` or `--dashboard` to narrow, `--tail N`
to change the line count, `--follow` (`-f`) to stream live.

```
$ subctl logs --master --tail 10
... last 10 lines of master.log ...

$ subctl logs --dashboard -f
══ ~/Library/Logs/subctl/dashboard.out.log ══
... last 50 lines, then streaming ...
^C
```

Exits 1 with a friendly error if no log files exist (the service
hasn't started yet).

## `subctl deploy`

Fast-path deploy: `git pull --ff-only` then `launchctl kickstart -k`
for both services. Use when you've already merged on the box and want
a fast bounce.

```
$ subctl deploy
==> git pull (repo: ~/code/subctl)
Already up to date.
==> kickstart -k gui/501/com.subctl.master
==> kickstart -k gui/501/com.subctl.dashboard
 ✓ deploy complete
```

Flags:

- `--no-pull` skip `git pull` (just restart services)
- `--dry-run` print what would run, execute nothing

For the careful upgrade path (auto-stash, version bracket pre/post,
doctor on the way out, rollback on failure) keep using `subctl
update`. `deploy` is the bash-and-go alternative.

## `subctl notif`

Reads Evy's operator notification ring buffer via the
dashboard's `/api/notifications` proxy. The ring buffer holds
team-staleness auto-nudges, auto-compact errors, and anything else
written by `notifications.ts`.

```
$ subctl notif recent
2026-05-13 11:02:14  alert  *  team_stale            Team idle 47m: v2.7.28-cli
2026-05-13 10:58:00  info   ·  auto_compact          Compact ok
```

Status glyph in column 3: `*` = unread, `·` = already marked read.

```
$ subctl notif list 25            # last 25
$ subctl notif mark-all-read      # POST /api/notifications/read-all
 ✓ marked 7 notifications as read
```

## `subctl memory`

Operator-facing surface on Evy's Tier 3 memory store. Goes through
the dashboard's `/api/memory/*` proxy → Evy's SQLite-backed
`recallMemoryEntries` / append path. Egress is redacted by Evy
(HMAC marks, `sk-*`, bearer tokens are stripped) before the
CLI ever sees the body.

```
$ subctl memory recent 5
2026-05-13 11:00:00  note      -            operator: deploy looks clean
2026-05-13 10:30:00  decision  v2.7.28-cli  shipping CLI bootstrap

$ subctl memory search "deploy looks"
... matching entries ...

$ subctl memory remember "v2.7.28 CLI shipped on this box"
 ✓ remembered as id=01H...
```

`search` URL-encodes the query string via `jq -sRr @uri`, so
multi-word and punctuated queries work without manual quoting beyond
what your shell already requires.

## `subctl team`

Operator-from-anywhere management of active orchestrator sessions. All
verbs go through the dashboard's `/api/orchestration/*` surface — same
endpoints the dashboard UI uses, same HMAC trust-marker enforcement on
`exec`.

```
$ subctl team list
NAME                             ATTACHED WINDOWS AGE        EVENT      TEXT
v2.7.36-cli-expansion            yes      2       12         progress   branch created
v2.7.36-stuck                    no       1       3600       blocked    lint failing on foo.ts

$ subctl team kill v2.7.36-stuck
 ✓ killed team 'v2.7.36-stuck' — archived inbox → ~/.config/subctl/master/inbox/.killed/v2.7.36-stuck.20260513-110200.jsonl

$ subctl team exec v2.7.36-cli-expansion "report progress"
 ✓ exec → v2.7.36-cli-expansion: report progress

$ subctl team logs v2.7.36-cli-expansion --tail 5
2026-05-13T11:00:00Z  PROGRESS  branch created
2026-05-13T11:02:30Z  PROGRESS  tests passing
2026-05-13T11:05:00Z  DONE      PR ready
```

`kill` does two things atomically: POSTs `/api/orchestration/<name>/kill`
(which terminates the tmux session via `subctl session-kill`) and moves
`~/.config/subctl/master/inbox/<name>.jsonl` into `inbox/.killed/` with
a timestamp suffix. The on-disk archive means a future team spawned
under the same name doesn't inherit stale events.

`exec` is the one-off equivalent of `subctl orch msg` — the payload
gets wrapped in Evy's HMAC trust marker (ADR 0011 L1) before the
tmux paste, so workers refuse it unless their spawn-time secret on disk
matches. **Do not** use `exec` to ferry untrusted prompts; the worker
contract treats anything inside the marker as authorized operator input.

The legacy dev-team-lead verbs (`subctl team report`, `subctl team
inbox`) still work — they're delegated to `components/team/team.sh` for
back-compat. `subctl team logs <name>` is the new alias of
`team inbox <name>`.

## `subctl config`

Inspect / edit / validate the operator's config files under
`$XDG_CONFIG_HOME/subctl`. The known files are:

| Section          | Path                                          | Format |
|------------------|-----------------------------------------------|--------|
| `accounts`         | `accounts.conf`                               | text |
| `projects`         | `projects.conf`                               | text |
| `config`           | `config.toml`                                 | toml |
| `notify`           | `notify.json`                                 | json |
| `master-notify`    | `master-notify.json`                          | json |
| `profiles`         | `profiles.json`                               | json |
| `providers`        | `master/providers.json`                       | json |
| `secrets`          | `master/secrets.json`                         | json |
| `secrets-backends` | `secrets-backends.json`                       | json |
| `policy`           | `master/policy.json`                          | json |

```
$ subctl config show notify
══ notify (~/.config/subctl/notify.json) ══
{
  "telegram_bot_token": "***redacted***",
  "telegram_chat_id": "1234567890"
}

$ subctl config edit providers
... opens $EDITOR on ~/.config/subctl/master/providers.json

$ subctl config validate
  ✓ accounts             ~/.config/subctl/accounts.conf       (text/pipe-form)
  ✓ notify               ~/.config/subctl/notify.json         (valid JSON)
  ✗ providers            ~/.config/subctl/master/providers.json (invalid JSON)
  ...
```

**Secret hygiene.** `show` runs every value through a two-pass redactor:

1. **Structural pass** (JSON only): walks the document with `jq` and
   replaces any value whose key name matches
   `token|secret|password|credential|bearer|apikey|api_?key|access_?token|refresh_?token|private_?key|client_?secret|hmac`
   (case-insensitive) with `"***redacted***"`.
2. **Textual pass** (every format): strips `sk-*`, `sk-ant-*`,
   `Bearer …`, `OP_*=…`, Telegram bot tokens
   (`\d{8,12}:[A-Za-z0-9_-]{30,}`), JWTs, and 64-hex blobs.

The two-pass design is conservative — over-redaction is fine; the goal
is "never print a usable token to stdout." Reach a redacted field via
`subctl config edit` if you need to inspect or rotate it.

## `subctl profile`

Read / switch Evy's active supervisor profile (v2.7.18). The
source of truth is `~/.config/subctl/profiles.json`; Evy
`fs.watch`es it and applies the swap on the start of the next prompt
(no daemon restart needed).

```
$ subctl profile show
active: chat
  supervisor: google/gemma-4-31b
  host:       http://localhost:1234/v1

$ subctl profile list
PROFILE    SUPERVISOR                               HOST
* chat     google/gemma-4-31b                       http://localhost:1234/v1
  heavy    qwen/qwen3.6-35b-a3b                     http://localhost:1234/v1

$ subctl profile switch heavy
 ✓ active profile → heavy
  takes effect on the next prompt — no restart needed
```

`show` and `switch` go through the dashboard's `/api/profile`
pass-through. `list` falls back to reading `profiles.json` directly when
the dashboard is unreachable, so you can inspect the on-disk config even
with the daemon off.

## Auth in v1

There is no auth. Evy and the dashboard listen on `127.0.0.1`
only; reaching them requires shell access on the host. If we ever
expose the dashboard to LAN or Tailscale, the CLI will grow a
`~/.config/subctl/cli-token` reader and the dashboard will enforce
`Authorization: Bearer …` on the same routes. Until that happens the
CLI talks to the proxy as a peer.

## Install path

`install.sh` symlinks `bin/subctl` into:

1. `/usr/local/bin/subctl` if writable (no sudo prompt), else
2. `$HOME/.local/bin/subctl` (XDG-standard user bin). The installer
   creates the dir if missing and probes the current shell's `$PATH`
   for it; if absent it prints the exact `export` line to add to
   `~/.zshrc` (or `~/.bashrc`).

> **v2.7.32:** the fallback target moved from `$HOME/bin` to
> `$HOME/.local/bin` so that recent zsh/bash/macOS setups (where
> `~/.local/bin` is auto-included) work out of the box. Operators
> upgrading from a pre-v2.7.32 install should remove the stale
> `$HOME/bin/subctl` symlink — `subctl deploy` will pick the new
> path on the next run.

### PATH requirement

If you fell back to `$HOME/.local/bin/`, the dispatcher won't be found
until that directory is on `$PATH`. Add to your shell rc:

```bash
# ~/.zshrc (zsh) or ~/.bashrc (bash)
export PATH="$HOME/.local/bin:$PATH"
```

Then `source ~/.zshrc` (or open a new shell) and verify with
`command -v subctl` — it should print the symlinked target.

The same install path covers the shorthand shims (`claude-teams`,
`claude-dash`, `claude-radar`, etc). `subctl install --migrate`
re-runs the symlink step idempotently.

## Tests

```
bun test lib/__tests__/cli.test.ts
```

45 tests as of v2.7.36 (25 v2.7.28 + 20 v2.7.36), each spawning the bash
dispatcher as a subprocess. Network tests stand up `Bun.serve` fakes on
ephemeral ports — the suite runs green without a live Evy or
dashboard. Config tests use `mkdtempSync`-scoped `$SUBCTL_CONFIG_DIR`
fixtures so no real `~/.config/subctl` files are touched.
