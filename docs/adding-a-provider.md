# Adding a provider

A provider in `subctl` is a directory under `providers/`. To add one, create the directory and implement three required functions plus any optional integration files.

This document spells out the interface and walks through a worked example: a stub `ollama` provider.

---

## The interface

A provider directory must look like this:

```
providers/<name>/
├── auth.sh       # required — exposes provider_auth
├── signals.sh    # required — exposes provider_signals
├── teams.sh      # required — exposes provider_teams
├── statusline.sh # optional
├── hooks/        # optional, one *.sh per event
└── commands/     # optional, one *.md per slash command
```

### Required functions

#### `provider_auth <alias> <config_dir>`

Lives in `auth.sh`. Runs the provider's login flow with isolation, writing credentials into `<config_dir>`.

Contract:

- Must be idempotent. Calling it again on an already-logged-in account either does nothing or prompts to re-login.
- Must respect the provider's official isolation knob (env var, config flag, profile name).
- Must exit non-zero on failure with a useful error on stderr.

#### `provider_signals <alias>`

Lives in `signals.sh`. Prints kv pairs (or JSON) describing live state for that account. Called frequently — must be cheap.

Required keys:

| Key                 | Type    | Meaning                                          |
|---------------------|---------|--------------------------------------------------|
| `parallel_sessions` | int     | Live process count for this account              |
| `ctx_pct`           | int 0–100 | Context window % used in active session, or 0   |
| `session_age_min`   | int     | Active session age in minutes, or 0              |
| `rl_today`          | int     | Rate-limit hits today                            |
| `auth_status`       | string  | `ready`, `expired`, `missing`                    |

Output format (kv, newline-separated):

```
parallel_sessions=2
ctx_pct=11
session_age_min=27
rl_today=0
auth_status=ready
```

Or JSON if your provider needs nested data.

#### `provider_teams [...args]`

Lives in `teams.sh`. Launches a tmux session pinned to a specific account.

Standard flags `subctl` will pass through:

| Flag         | Meaning                                          |
|--------------|--------------------------------------------------|
| `-a <alias>` | Account alias from `accounts.conf`               |
| `-o`         | Open orchestrator pane                           |
| `-c <n>`     | Open `n` worker panes                            |
| `-y`         | Skip "are you sure?" prompts                     |

Provider-specific flags can be added as long as they don't collide with the standard ones.

### Optional files

| Path                        | Purpose                                                 | Installed where                                    |
|-----------------------------|---------------------------------------------------------|----------------------------------------------------|
| `statusline.sh`             | Printed by the provider's CLI on every prompt           | provider's settings, e.g. `~/.claude/settings.json` |
| `hooks/<event>.sh`          | Hook scripts for events the provider's CLI defines      | e.g. `~/.claude/hooks/`                            |
| `commands/<name>.md`        | Slash-command definitions                               | e.g. `~/.claude/commands/`                         |

`subctl install` reads these from `providers/<name>/` and copies / symlinks them into the provider's expected paths.

---

## Worked example: `ollama` provider stub

Suppose you want `subctl` to know about local Ollama models. Ollama doesn't have rate limits in the API sense, but it has GPU contention — call that the analogue.

### `providers/ollama/auth.sh`

```sh
#!/usr/bin/env bash
# provider_auth <alias> <config_dir>
# For Ollama there's no auth — but the contract still requires the function.

provider_auth() {
  local alias="$1"
  local config_dir="$2"

  mkdir -p "$config_dir"
  echo "ollama: no auth required for $alias (config_dir=$config_dir)"
  return 0
}
```

### `providers/ollama/signals.sh`

```sh
#!/usr/bin/env bash
# provider_signals <alias>

provider_signals() {
  local alias="$1"

  # Count active ollama runs (proxy for "parallel sessions")
  local parallel
  parallel=$(pgrep -f "ollama run" | wc -l | tr -d ' ')

  # GPU memory pressure as the rate-limit analogue
  local gpu_pct=0
  if command -v nvidia-smi >/dev/null 2>&1; then
    gpu_pct=$(nvidia-smi --query-gpu=utilization.memory --format=csv,noheader,nounits | head -1)
  fi

  cat <<EOF
parallel_sessions=$parallel
ctx_pct=$gpu_pct
session_age_min=0
rl_today=0
auth_status=ready
EOF
}
```

### `providers/ollama/teams.sh`

```sh
#!/usr/bin/env bash
# provider_teams [...args]

provider_teams() {
  local alias="default"
  local model="llama3"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -a) alias="$2"; shift 2 ;;
      -m) model="$2"; shift 2 ;;
      *)  shift ;;
    esac
  done

  tmux new-session -d -s "ollama-$alias" "ollama run $model"
  tmux attach -t "ollama-$alias"
}
```

### Wiring it in

Add an entry to `~/.config/subctl/accounts.conf`:

```
# alias            provider   config_dir
ollama-default     ollama     ~/.ollama
```

Now:

```
$ subctl auth ollama default          # → providers/ollama/auth.sh
$ subctl teams ollama -a default -m llama3
```

The TUI's "Sessions (radar)" view will show the `ollama-default` account with `parallel_sessions` and `ctx_pct` populated from `nvidia-smi`. The dashboard will render a card for it. No core changes needed — the provider directory is the entire integration.

---

## Submitting a provider

1. Fork `https://github.com/webdevtodayjason/subctl`.
2. Create `providers/<name>/` with at minimum `auth.sh`, `signals.sh`, `teams.sh`.
3. Add an entry to `config/accounts.conf.example` showing the format.
4. Add a short section to `README.md`'s roadmap table.
5. Open a PR. Include `subctl doctor` output proving the new provider loads cleanly.

Providers should be self-contained — no edits required to `lib/*.sh` or `bin/subctl` to add a new one. If your provider needs core changes, open an issue first to discuss the interface gap.
