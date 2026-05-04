# Multi-account isolation

This document explains how `subctl` runs multiple Claude accounts on the same machine without log-out / log-in dances, why the mechanism is the right one, and how to configure it.

---

## The mechanism: `CLAUDE_CONFIG_DIR`

Claude Code reads its credentials, project list, settings, and hooks from a single directory. By default that's `~/.claude`. But Claude Code respects the `CLAUDE_CONFIG_DIR` environment variable, and **whatever directory you point that variable at becomes the root**:

```
$ CLAUDE_CONFIG_DIR=~/.claude-personal claude
$ CLAUDE_CONFIG_DIR=~/.claude-work claude
```

Each directory holds an independent set of credentials, projects, and settings. There is no global "current account" — there is just whichever directory the running `claude` process is reading from. That is the right design: it's the same pattern as `KUBECONFIG`, `GOPATH`, `npm --prefix`, `git --git-dir`. The official, supported, env-var-based isolation knob.

`subctl` does nothing magic on top of this. It just makes the env-var dance ergonomic.

---

## How `subctl` makes it ergonomic

### `accounts.conf`

The user's `~/.config/subctl/accounts.conf` is a plain config file:

```
# alias            provider   config_dir
claude-personal    claude     ~/.claude-personal
claude-work        claude     ~/.claude-work
claude-overflow    claude     ~/.claude-overflow
```

`subctl` parses this on every alias regen and on every TUI load.

### Generated aliases

`lib/aliases.sh` is sourced by your shell rc. It loops over `accounts.conf` and emits one shell function per account:

```sh
claude-personal() {
  CLAUDE_CONFIG_DIR="$HOME/.claude-personal" command claude "$@"
}
claude-work() {
  CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@"
}
```

Now `claude-personal` always means the personal account. Always. From any directory.

### The bare `claude` guard

The dangerous case: you type bare `claude` from a directory where you *thought* you had set the env var, and you didn't, and you accidentally run the wrong account against a sensitive project.

`subctl install` adds a function shadow on bare `claude`:

```sh
claude() {
  if [[ -z "${CLAUDE_CONFIG_DIR:-}" ]] && [[ -z "${SUBCTL_ALLOW_BARE_CLAUDE:-}" ]]; then
    echo "subctl: bare 'claude' invocation with no CLAUDE_CONFIG_DIR set." >&2
    echo "  Use one of: claude-personal, claude-work, ..." >&2
    echo "  Or: SUBCTL_ALLOW_BARE_CLAUDE=1 claude  (to override once)" >&2
    return 2
  fi
  command claude "$@"
}
```

That's the safety guard. It refuses to launch a Claude session unless you've been explicit about which account.

### Per-project defaults via direnv

For projects where you always want a specific account, drop a `.envrc` into the project:

```sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-work"
```

`direnv allow` once. Now `cd`-ing into the project sets the env var, the bare-`claude` guard sees it set, and you get the right account without thinking. This is the recommended pattern for client repos.

---

## Adding an account

```
$ subctl auth claude work
```

That command:

1. Adds a `claude-work` line to `~/.config/subctl/accounts.conf` if absent.
2. Creates `~/.claude-work/` as the isolation root.
3. Runs the Claude Code login flow with `CLAUDE_CONFIG_DIR=~/.claude-work`, which writes the credentials into that directory.
4. Regenerates `lib/aliases.sh` so the next shell sees the new alias.
5. Prints "run `source ~/.zshrc`" or equivalent.

---

## Removing an account

```
$ subctl auth claude work --remove
```

Removes the `claude-work` line from `accounts.conf` and regenerates aliases. It does **not** delete `~/.claude-work/` — you're trusted to `rm -rf` that yourself if you want the credentials gone. (We don't `rm -rf` directories on your behalf. If you typo'd the alias, you'd never forgive us.)

---

## What about `.zshrc` clutter?

Everything `subctl` writes to your shell rc goes between markers:

```
# >>> subctl >>>
source ~/.subctl/lib/aliases.sh
# <<< subctl <<<
```

`subctl uninstall` removes the block cleanly. Outside the markers is yours; inside is ours.

---

## FAQ

**Q: Can I just symlink `~/.claude` to switch accounts?**
That works for one terminal at a time, but it breaks the moment you have two terminals open. Env-var-per-process isolation is the only sane answer.

**Q: Can I share `~/.claude/projects/` across accounts?**
No. Projects live inside the config dir and contain transcripts tied to a specific account's API access. Cross-account project sharing is not supported by Claude Code itself.

**Q: What about Gemini / OpenAI?**
Each provider has its own isolation knob. Gemini uses `GOOGLE_APPLICATION_CREDENTIALS` and a per-account directory; OpenAI uses `OPENAI_API_KEY` plus a config directory. The same `accounts.conf` schema covers them — provider field tells `subctl` which env var family to set.
