# pi-coding-agent provider (v2.7.0, ungated)

First-class subctl provider for [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) — a coding-agent CLI that authenticates via its built-in `/login` slash command against 20+ underlying model providers (Anthropic Pro, ChatGPT Pro, …).

Sits alongside `providers/claude/` and `providers/openai/` in subctl's provider directory layout. Binary expected on `PATH`: `pi`.

> **Status (v2.7.0): UNGATED.** This provider ships *without* a `PreToolUse` policy hook. The policy gate (analogous to the one wired into `providers/claude/teams.sh` in PR 10) lands in v2.7.1 or v2.8 once pi-coding-agent stabilizes a hook surface compatible with subctl's `subctl-policy-check` Go binary. See "Roadmap" below.

## Install

Pi-coding-agent is an npm package; install it globally before adding pi accounts to subctl:

```bash
npm install -g @mariozechner/pi-coding-agent
which pi   # sanity-check: should print a path
```

## Add an account

```bash
subctl accounts add pi-coding-agent pi-personal you@example.com ~/.subctl-pi-personal "Pi personal"
subctl auth pi-coding-agent pi-personal
```

`subctl auth` will launch `pi` inside the per-alias HOME-shadow dir (see below) so the resulting `~/.pi/agent/` state is isolated from any other pi accounts you have on the same machine. Inside the pi session, run `/login` to walk through OAuth.

## Spawn a worker

```bash
subctl teams pi-coding-agent -a pi-personal -p "Refactor src/utils.ts to use async/await"
```

Same shape as `subctl teams claude`, minus a few flags that don't apply (no `--orchestrator`, no `--continue`, no `--template`, no `--mode`).

## HOME-shadowing — why and how

Pi-coding-agent reads `$HOME` at startup to locate `~/.pi/agent/sessions`, `~/.pi/agent/auth.json`, and friends. There is **no documented `PI_CONFIG_DIR` env var** today that would let us redirect just the pi state — anything we do has to operate on `$HOME` itself.

Subctl's workaround:

1. For each pi account `<alias>`, the auth flow creates a HOME-shadow dir at `$HOME/.subctl-pi-aliases/<alias>/`.
2. `subctl auth pi-coding-agent <alias>` launches `pi` with `HOME` set to that shadow dir. OAuth tokens land at `$HOME/.subctl-pi-aliases/<alias>/.pi/agent/auth.json`.
3. `subctl teams pi-coding-agent -a <alias>` launches the worker tmux session with the same `HOME` override (passed through `tmux new-session -e HOME=…`), so the worker sees the alias-scoped state.
4. The shadow path is also pinned in `cfg_dir/.subctl-pi-home` so `signals.sh` and other downstream consumers don't have to re-derive it from the alias.

This is ~10 lines of bash per touchpoint and is fully reversible: deleting `$HOME/.subctl-pi-aliases/` restores a clean slate without touching your real `~/.pi/`.

### Future cleanup

The long-term fix is **upstream**: get `pi-coding-agent` to honor a `PI_CONFIG_DIR` (or similar) env var the way Claude Code honors `CLAUDE_CONFIG_DIR` and Codex honors `CODEX_HOME`. Tracked as a TODO; PR welcome at `@mariozechner/pi-coding-agent` once we've validated the workaround in production.

## Files in this provider

| File | Purpose |
|------|---------|
| `auth.sh` | OAuth setup — launches `pi` in HOME-shadow + tells you to run `/login`. |
| `teams.sh` | tmux worker spawn. UNGATED in v2.7.0. |
| `signals.sh` | Account-state JSON for the dashboard's accounts strip. |
| `statusline.sh` | Minimal one-line status string (parity with claude provider). |
| `__tests__/spawn.test.ts` | Smoke tests for auth + spawn flows with a mocked `pi` binary. |

## Roadmap

- **v2.7.0** (this PR): UNGATED scaffolding. Operator can spawn pi workers; no policy enforcement.
- **v2.7.1 or v2.8**: Policy hook integration. Either a pi-native `PreToolUse`-style hook or a wrapper that intercepts pi's tool-use events from its `--mode rpc` JSONL stream and pipes them through `subctl-policy-check`.
- **v2.8+**: RPC-mode worker variant. Pi's `--mode rpc` (JSONL stdin/stdout) makes it a strong candidate for direct master-daemon orchestration — no tmux required. See HANDOFF_DIGEST.md §3.7.

## Why "pi-coding-agent" and not just "pi"

Subctl already depends on `@earendil-works/pi-agent-core` (different package, different repo) for the master-daemon SDK. The directory name `pi-coding-agent` disambiguates this provider from the SDK to anyone reading the codebase cold.
