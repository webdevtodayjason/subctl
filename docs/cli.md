# subctl CLI reference (v2.7.28+)

`bin/subctl` is the bash dispatcher shipped at `/usr/local/bin/subctl` (or
`~/bin/subctl` if `/usr/local/bin` isn't writable). It's how the operator
drives the master + dashboard daemons from any terminal. The TUI you get
by running `subctl` with no arguments is the same dispatcher with a
different default branch.

This doc covers the **five v2.7.28 commands** that talk to the localhost
HTTP surface: `status`, `logs`, `deploy`, `notif`, `memory`. For
account / auth / template / orchestration verbs see the inline `subctl
help` table and [docs/master.md](./master.md).

## Quick reference

```
subctl status [--json]
subctl logs [--master | --dashboard] [--tail N] [--follow|-f]
subctl deploy [--no-pull] [--dry-run]
subctl notif [recent | list <N> | mark-all-read]
subctl memory [recent <N> | search <query> | remember <text>]
```

All five exit 0 on success, 1 on failure, with errors going to stderr.
Output is plain-text by default, color-friendly under TTY, suppressed
when `NO_COLOR=1` is set. No spinners or progress bars.

## Environment variables

| Variable | Default | What it does |
|----------|---------|--------------|
| `SUBCTL_MASTER_PORT` | `8788` | Where `subctl status` looks for the master daemon. |
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

Reads the master's operator notification ring buffer via the
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
the dashboard's `/api/memory/*` proxy → master's SQLite-backed
`recallMemoryEntries` / append path. Egress is redacted by the
master (HMAC marks, `sk-*`, bearer tokens are stripped) before the
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

## Auth in v1

There is no auth. The master and dashboard listen on `127.0.0.1`
only; reaching them requires shell access on the host. If we ever
expose the dashboard to LAN or Tailscale, the CLI will grow a
`~/.config/subctl/cli-token` reader and the dashboard will enforce
`Authorization: Bearer …` on the same routes. Until that happens the
CLI talks to the proxy as a peer.

## Install path

`install.sh` symlinks `bin/subctl` into:

1. `/usr/local/bin/subctl` if writable, else
2. `$HOME/bin/subctl` (and prints a `export PATH=…` reminder).

The same install path covers the shorthand shims (`claude-teams`,
`claude-dash`, `claude-radar`, etc). `subctl install --migrate`
re-runs the symlink step idempotently.

## Tests

```
bun test lib/__tests__/cli.test.ts
```

25 tests, each spawning the bash dispatcher as a subprocess. Network
tests stand up `Bun.serve` fakes on ephemeral ports — the suite runs
green without a live master or dashboard.
