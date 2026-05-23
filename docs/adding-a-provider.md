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

---

## Codex worker provider (v3.0 Phase 2)

The `openai-codex` provider is the reference implementation of a **non-Claude worker CLI** that speaks the subctl SPEC-block + HMAC wire contract. Use it as the template for any future TUI-driven worker (DeepSeek, pi-coder, etc.).

Anatomy: `providers/openai-codex/`

| File | Role |
|---|---|
| `auth.sh` | `provider_openai_codex_auth` — first-class OAuth device-code flow (no `codex login` shell-out). Mints `<config_dir>/auth.json` directly. |
| `teams.sh` | `provider_openai_codex_teams` — tmux launcher. Per-alias isolation via `CODEX_HOME`. Bakes the HMAC team-contract preamble + reporting vocabulary into the spawn-time prompt. |
| `__tests__/spawn.test.ts` | Dispatcher routing, arg parsing, HMAC secret on-disk shape, refusal of Claude-only flags. |

### Spawn contract (what a Codex worker MUST do)

1. **Per-alias isolation.** Codex reads its per-user state from the `CODEX_HOME` env var (analogous to Claude Code's `CLAUDE_CONFIG_DIR`). `teams.sh` sets it via tmux `-e` so the pane inherits the right `auth.json` + `config.toml` + plugin set without any HOME-shadow hack.

2. **HMAC-authenticated team contract.** Before launching codex, `teams.sh` generates (or reuses) a 32-byte secret at `~/.local/state/subctl/teams/<team_id>/hmac.secret` (chmod 600) and bakes it into a 250-line preamble that wraps the operator's mandate. The preamble teaches the worker:
   - the SPEC-block wire format (every directive carries `[subctl-master directive · phase=<x> · ts:<iso> · hmac:<16hex>]` + `SPEC:\n  <body>`),
   - the verification recipe (`node -e` with `crypto.createHmac("sha256", secret).update(phase + "\n" + ts + "\n" + body).digest("hex").slice(0,16)`),
   - the bit-exact self-test value (`4adef968060ec740` for the canonical input — drift means the channel is broken).

3. **Reporting vocabulary.** Claude workers pick up phrases like "task complete, idle by design" emergently from team-template prompts; gpt-5.5 does not. The preamble teaches Codex EXACTLY the words `auto-nudge.ts:classifyWorkerReply` matches for `completed_idle` / `blocked` / `awaiting_input` so the staleness watchdog can short-circuit nudges on a done team. Without this, the operator gets paged every 30 minutes on a worker that already said it was done.

4. **Inbox events.** The contract preamble teaches the worker to append progress / blocked / done / error events via `subctl team report --type <kind> --text <text>`. `SUBCTL_TEAM_NAME=$SESSION_NAME` is set in the tmux session env so the worker doesn't have to type `--team` every time. Events land at `~/.config/subctl/master/inbox/<team>.jsonl`, which the master daemon tails for SSE → dashboard + Telegram surface.

5. **Watchdog classification.** No code changes — the watchdog is content-based on text patterns. Teaching the vocabulary in step 3 is what makes classification work.

### TUI dance (provider-specific gotchas)

- **Trust-level modal.** Codex pops a "Do you trust this directory?" modal on first run in a new cwd. Bypass via `-c projects."<cwd>".trust_level="trusted"` (TOML key with a string-literal path segment — printf %q the value before embedding so bash + TOML quoting interact correctly).
- **Update modal.** A periodic "Update available!" modal blocks the input prompt and requires keypress dismissal. `teams.sh` watches the pane capture for the modal copy and sends `2` + `Enter` (the "Skip" option) once per spawn.
- **Ready marker.** Codex's TUI signals fully-booted state by rendering `Context <pct>% left` in the bottom status line. `teams.sh` polls for that substring (60s ceiling) before pasting the contract preamble + mandate. Analogous to Claude's `^❯` ready check.

### Flags that don't translate from Claude

Codex CLI lacks several of Claude Code's surfaces. `teams.sh` accepts the boolean flags as info-warned no-ops so HTTP-spawn callers + the dashboard can pass uniform argv to every provider; the template flag (which takes a NAMED argument) is rejected because silently eating the argument would surprise:

| Claude flag | Codex behavior |
|---|---|
| `--orchestrator` / `-o` | No-op with info-warn. Codex has no `Team*` / `SendMessage` tool surface — workers are spec-driven single agents. |
| `--continue` / `-c` | No-op with info-warn. Codex uses `codex resume <id>` as a subcommand (not a flag); wrap it later if needed. |
| `--template <name>` / `-t` | Rejected. Dev-team JSON/TOML templates encode Claude-specific skills + persona paths. Codex template support lands later. |

### Skip-perms mapping

`-y` / `--yes` translates to `--dangerously-bypass-approvals-and-sandbox` (Codex's YOLO mode). Only enabled on explicit operator opt-in.

### Smoke recipe

```bash
# Spawn a worker pinned to the openai-jason account, on a project,
# detached (no TUI attach), with skip-perms on.
subctl teams codex -a openai-jason -p "explore this codebase" -y --no-attach

# Tail its inbox (worker should emit a 'spawned' event ~immediately,
# then 'progress' as it works).
tail -f ~/.config/subctl/master/inbox/codex-<basename>.jsonl

# Inspect the pane.
tmux attach -t codex-<basename>
```

If you see `missing field 'id_token'` from codex on boot, the alias's `auth.json` was minted by subctl's device-code flow which currently omits `id_token`. Re-auth via the official `codex login` with `CODEX_HOME=<cfg_dir>` as a workaround until subctl's mint flow learns to persist `id_token` (separate issue).
