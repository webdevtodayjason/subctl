# Migration

`subctl` consolidates three predecessor projects:

- `claude-dispatch-radar` — the rate-limit awareness piece.
- `claude-multi-account` — the account isolation piece.
- `claude-teams` — the tmux launcher.

If you were running any of them, this document tells you exactly what `subctl install --migrate` will change.

---

## TL;DR

```
$ subctl install --migrate
```

That command is idempotent. It detects which predecessor projects are present and rewrites their integration points into `subctl`'s. Re-running it does nothing if there's nothing left to migrate.

Run it once. Read the diffs below to know what to expect.

---

## Migrating from `claude-dispatch-radar`

`claude-dispatch-radar` installs a statusline script and a Stop hook into your `~/.claude/settings.json`. `subctl` replaces both.

**`~/.claude/settings.json` — before:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/scripts/dispatch-radar-statusline.sh"
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/dispatch-radar-stop.sh"
          }
        ]
      }
    ]
  }
}
```

**`~/.claude/settings.json` — after:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/scripts/subctl-statusline.sh"
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/subctl-stop.sh"
          }
        ]
      }
    ]
  }
}
```

The migrator:

1. Reads `~/.claude/settings.json`.
2. Replaces any `dispatch-radar-statusline.sh` reference with `subctl-statusline.sh`.
3. Replaces any `dispatch-radar-stop.sh` reference with `subctl-stop.sh`.
4. Leaves all other settings untouched.
5. Writes the new files into `~/.claude/scripts/` and `~/.claude/hooks/`.
6. Leaves the old files in place (you can delete them yourself once you've verified the migration).

Per-day RL counters from `claude-dispatch-radar` are imported into `~/.config/subctl/state/` so your "RL hits today" doesn't reset to 0 on migration day.

---

## Migrating from `claude-multi-account`

`claude-multi-account` keeps an `accounts.conf` and writes an alias block into your shell rc. `subctl` does both. The migrator imports the file and rewrites the rc block.

**`~/.config/claude-multi-account/accounts.conf` — example before:**

```
claude-personal    ~/.claude-personal
claude-work        ~/.claude-work
claude-overflow    ~/.claude-overflow
```

**`~/.config/subctl/accounts.conf` — after:**

```
# alias            provider   config_dir
claude-personal    claude     ~/.claude-personal
claude-work        claude     ~/.claude-work
claude-overflow    claude     ~/.claude-overflow
```

Provider column is added (always `claude` for migrated rows). All other state is preserved.

**`~/.zshrc` — before:**

```
# >>> claude-multi-account >>>
source ~/.claude-multi-account/lib/aliases.sh
# <<< claude-multi-account <<<
```

**`~/.zshrc` — after:**

```
# >>> subctl >>>
source ~/.subctl/lib/aliases.sh
# <<< subctl <<<
```

The aliases themselves (`claude-personal`, `claude-work`, …) keep working. They're regenerated from `accounts.conf` and produce the same shell functions. No retraining of muscle memory.

---

## Migrating from `claude-teams`

`claude-teams` was a standalone script at `/usr/local/bin/claude-teams`. `subctl` replaces it with `subctl teams claude` and keeps a thin shim so you don't have to retrain your fingers.

**`/usr/local/bin/claude-teams` — after migration:**

```sh
#!/usr/bin/env bash
# Shim — forwards to subctl. Kept for muscle memory.
exec subctl teams claude "$@"
```

If you'd rather drop the shim entirely:

```
$ subctl install --migrate --no-shim
```

That deletes the old `claude-teams` script (after a confirmation prompt) instead of replacing it.

All flags `claude-teams` accepted (`-a`, `-o`, `-c`, `-y`, etc.) are accepted by `subctl teams claude` unchanged.

---

## After migration

Run:

```
$ subctl doctor
```

That prints a checklist of what migrated, what's still in place, and anything that looks off. If it's all green, you're done. If anything is yellow or red, the output points at the file or path that needs attention.

You can keep the old project directories around for a while as a safety net. Once you're confident everything works, `rm -rf` them at your leisure — `subctl` doesn't depend on any of them being present.
