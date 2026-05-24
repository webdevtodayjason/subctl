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

## DeepSeek-TUI / CodeWhale worker provider (v3.0.0-rc1, ungated)

> **Doc-vs-code drift note.** The "Worked example: ollama" section above describes an older shape (unprefixed `provider_auth`/`provider_signals`/`provider_teams`, and a claim that no `bin/subctl` edits are needed). The actual provider convention as of v2.7.0+ uses **provider-prefixed** function names (e.g. `provider_pi_coding_agent_auth`, `provider_deepseek_teams`) and DOES require small `bin/subctl` dispatch additions (auth + teams + the `all)` arm). The DeepSeek-TUI section below is accurate to the current codebase; future cleanup of the ollama example into the prefixed form is welcome.

[CodeWhale](https://github.com/Hmbown/CodeWhale) (formerly `DeepSeek-TUI`) is Hunter Bown's Rust-native coding-agent TUI for DeepSeek V4 (and ~10 other DeepSeek-compatible providers). It's the second non-Claude worker CLI subctl supports natively, after `pi-coding-agent`, and the first **API-key-only** auth shape (Claude/Codex use OAuth; pi uses OAuth via `/login`).

### What makes this provider different

- **Auth shape**: API key, not OAuth. Stored in CodeWhale's own `~/.deepseek/config.toml` (mode 0600, codewhale-managed) via the binary's first-class `codewhale auth set --provider deepseek` command. No subctl-side keychain shim — CodeWhale already implements a layered `config -> file-based secret store -> env` lookup natively.
- **Project rename**: GitHub redirects `Hmbown/DeepSeek-TUI` → `Hmbown/CodeWhale`. Binary is `codewhale`. **Homebrew formula** kept the old `deepseek-tui` name, so `brew install deepseek-tui` still works. We standardize on `codewhale` everywhere else in subctl code.
- **Isolation**: HOME-shadow (same approach as `providers/pi-coding-agent/`). There's no documented `CODEWHALE_HOME` env var; HOME-shadow is the smallest reversible workaround that gives full isolation across aliases (config, secrets, sessions, audit log).
- **Status — UNGATED in v3.0.0-rc1**: No SPEC-block HMAC, no `PreToolUse` policy hook. CodeWhale doesn't expose a hook surface analogous to Claude Code's PreToolUse contract yet. Trust-marker integration is roadmapped for v3.0.0-rc2, likely via interception of `codewhale exec --output-format stream-json` events.

### Files

```
providers/deepseek/
├── auth.sh                       # provider_deepseek_auth + _auth_all
├── teams.sh                      # provider_deepseek_teams
├── signals.sh                    # provider_deepseek_signals
├── statusline.sh                 # one-line pane status (parity)
├── README.md                     # operator-facing docs
└── __tests__/spawn.test.ts       # bun:test smoke coverage (auth + spawn + signals + dispatcher)
```

### `bin/subctl` wiring

Three minimal additions, mirroring the existing pi-coding-agent arms:

1. `auth)` dispatch — new `deepseek)` arm sourcing `providers/deepseek/auth.sh` and calling `provider_deepseek_auth`.
2. `auth all)` arm — sources `providers/deepseek/auth.sh` and calls `provider_deepseek_auth_all` (so `subctl auth all` walks deepseek accounts too).
3. `teams)` dispatch — new `deepseek)` arm sourcing `providers/deepseek/teams.sh` and calling `provider_deepseek_teams`.

Also add `deepseek` to the provider allowlist in `lib/accounts.sh::subctl_accounts_add` so `subctl accounts add deepseek <alias>` isn't rejected.

### `lib/dep-manifest.json` entry

CodeWhale is registered as a `tier: "soft"`, `do_not_auto_install: true` dependency. `subctl doctor` reports missing-vs-present; operator installs it manually via the `install_cmd` (`npm install -g codewhale`, `cargo install codewhale-cli --locked`, or `brew install deepseek-tui`).

The `detect` block accepts EITHER the modern `codewhale` binary OR the legacy `deepseek-tui` alias for operators who already have it via Homebrew:

```json
"detect": ["sh", "-c", "command -v codewhale >/dev/null 2>&1 || command -v deepseek-tui >/dev/null 2>&1"]
```

### Spawn semantics

```bash
subctl teams deepseek -a <alias> [-y -c -o -p TEXT -f FILE -m MODEL --dry-run]
```

Flags map to CodeWhale features as follows:

| subctl flag           | CodeWhale equivalent                                  |
|-----------------------|-------------------------------------------------------|
| `-a, --account`       | (subctl-level, selects accounts.conf alias)           |
| `-p, --prompt`        | Pasted via tmux paste-buffer after TUI ready          |
| `-f, --prompt-file`   | Same as above, source from file                       |
| `-m, --model`         | `codewhale --model <name>`                            |
| `-y, --yes`           | `codewhale --yolo` (auto-approve tools)               |
| `-c, --continue`      | `codewhale resume --last` (replaces full launch cmd)  |
| `-o, --orchestrator`  | Accepted as no-op in v3.0.0-rc1 (reserved)            |
| `--no-attach`         | Detached spawn (HTTP-spawn callers)                   |
| `--dry-run`           | Print plan; don't launch tmux                         |

`-o` is accepted as a no-op for forward-compat with the spec's smoke-test invocation. The orchestrator concept is meaningful for Claude Code workers (it gates which subctl tools are available) but has no analog in CodeWhale's UNGATED rollout. The flag will gain semantics in v3.0.0-rc2 alongside the HMAC work.

### Inbox events / watchdog

UNGATED — no `~/.local/state/subctl/teams/<team>/inbox.jsonl` writes from this provider in v3.0.0-rc1, mirroring `pi-coding-agent`. The watchdog classifier reads tmux pane output and CodeWhale's session-file mtimes (`~/.deepseek/sessions/` inside the HOME-shadow) — same shape as the pi signals path.

### Why "deepseek" and not "codewhale" as the provider directory name

The model API (DeepSeek) is the stable identity; the CLI brand (CodeWhale) was DeepSeek-TUI two months ago. CodeWhale supports ~10 DeepSeek-compatible providers (openai, openrouter, novita, fireworks, …); a future subctl provider routing CodeWhale to OpenRouter would live under `providers/openrouter/`, not `providers/codewhale-2/`. Conventional naming matches `providers/claude/` (Anthropic's API, not "claude-code-cli") and `providers/openai/` (the API, not the specific CLI surface).

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
