# deepseek provider (v3.0.0-rc1, ungated)

First-class subctl provider for [CodeWhale](https://github.com/Hmbown/CodeWhale) (formerly DeepSeek-TUI) — Hunter Bown's Rust-native coding-agent TUI that talks to DeepSeek V4 (and ~10 other DeepSeek-compatible providers). Binary expected on `PATH`: `codewhale`.

Sits alongside `providers/claude/`, `providers/openai/`, `providers/openai-codex/`, `providers/xai-oauth/`, `providers/pi-coding-agent/`, and friends in subctl's provider directory layout.

> **Status (v3.0.0-rc1): UNGATED.** This provider ships *without* a SPEC-block HMAC / `PreToolUse` policy hook. The policy gate (analogous to the trust-marker wiring in `providers/claude/teams.sh`) lands in v3.0.0-rc2 once CodeWhale stabilizes a hook surface — currently exploring whether `codewhale exec --output-format stream-json` can be intercepted for trust-marker verification. See "Roadmap" below.

## Project rename

CodeWhale was previously published as `DeepSeek-TUI`. The GitHub repo redirects (`Hmbown/DeepSeek-TUI` → `Hmbown/CodeWhale`), the binary is `codewhale`, but the **Homebrew formula name** is still `deepseek-tui`. We standardize on `codewhale` in code and docs; the brew install line is the one place the old name leaks through.

## Install CodeWhale

Pick one:

```bash
npm install -g codewhale
# or
cargo install codewhale-cli --locked
# or
brew install deepseek-tui   # formula name kept the old project name

which codewhale   # sanity-check: should print a path
```

## Add an account

```bash
subctl accounts add deepseek deepseek-personal you@example.com ~/.subctl-deepseek-personal "DeepSeek personal"
subctl auth deepseek deepseek-personal
```

`subctl auth` will launch `codewhale auth set --provider deepseek` inside the per-alias HOME-shadow dir (see below) so the resulting `~/.deepseek/config.toml` is isolated from any other DeepSeek/CodeWhale accounts you have on the same machine. CodeWhale prompts for the API key on stdin and **does not echo it**. Get a key from <https://platform.deepseek.com/>.

## Spawn a worker

```bash
subctl teams deepseek -a deepseek-personal -p "Refactor src/utils.ts to use async/await"
```

Same shape as `subctl teams claude` and `subctl teams pi-coding-agent`. Flags:

| Flag                  | Meaning                                                    |
|-----------------------|------------------------------------------------------------|
| `-a, --account`       | Required. Alias from `accounts.conf`.                      |
| `-p, --prompt`        | Initial prompt to paste after launch.                      |
| `-f, --prompt-file`   | Read initial prompt from file.                             |
| `-m, --model`         | Sets `--model` on `codewhale`.                             |
| `-y, --yes`           | Maps to `codewhale --yolo` (auto-approve tools).           |
| `-c, --continue`      | Resume most recent session (`codewhale resume --last`).    |
| `-o, --orchestrator`  | Accepted as no-op in v3.0.0-rc1. Reserved for v3.0.0-rc2.  |
| `--no-attach`         | Detached spawn (HTTP-spawn callers).                       |
| `--dry-run`           | Print the spawn plan; don't launch tmux.                   |

## HOME-shadowing — why and how

CodeWhale reads `$HOME` at startup to locate `~/.deepseek/config.toml`, `~/.deepseek/secrets/`, `~/.deepseek/sessions/`, `~/.deepseek/audit.log`. There is no documented `CODEWHALE_HOME` / `DEEPSEEK_HOME` env var that would let us redirect just the codewhale state — anything we do has to operate on `$HOME` itself.

Subctl's workaround:

1. For each deepseek account `<alias>`, the auth flow creates a HOME-shadow dir at `$HOME/.subctl-deepseek-aliases/<alias>/`.
2. `subctl auth deepseek <alias>` launches `codewhale auth set --provider deepseek` with `HOME` set to that shadow dir. API key lands at `$HOME/.subctl-deepseek-aliases/<alias>/.deepseek/config.toml` (mode 0600, codewhale-managed).
3. `subctl teams deepseek -a <alias>` launches the worker tmux session with the same `HOME` override (`tmux new-session -e HOME=…`), so the worker sees the alias-scoped state. No `DEEPSEEK_API_KEY` env injection — codewhale's own `config -> secret store -> env` lookup finds the key in the shadow config.
4. The shadow path is pinned in `cfg_dir/.subctl-deepseek-home` so `signals.sh` and other downstream consumers don't have to re-derive it from the alias.

This is ~10 lines of bash per touchpoint, fully reversible (deleting `$HOME/.subctl-deepseek-aliases/` restores a clean slate without touching your real `~/.deepseek/`), and **does not require a keychain shim** — CodeWhale already implements secret-store separation natively.

### Why not the macOS Keychain?

Earlier design rounds considered storing keys in macOS Keychain via the `security` command. CodeWhale's own layered `config -> secret store -> env` auth surface obviates this — keys are stored in mode-0600 files codewhale already manages, and HOME-shadow gives per-alias isolation for free. Migrating to Keychain (or 1Password) is a v3.x follow-up if the operator wants stronger at-rest protection than codewhale's file-based secret store.

### Future cleanup

The long-term fix is **upstream**: get CodeWhale to honor a `CODEWHALE_HOME` (or similar) env var the way Claude Code honors `CLAUDE_CONFIG_DIR` and Codex honors `CODEX_HOME`. Tracked as a TODO; PR welcome at `Hmbown/CodeWhale` once we've validated the workaround in production.

## Files in this provider

| File                          | Purpose                                                                            |
|-------------------------------|------------------------------------------------------------------------------------|
| `auth.sh`                     | API-key setup — launches `codewhale auth set` in HOME-shadow.                      |
| `teams.sh`                    | tmux worker spawn. UNGATED in v3.0.0-rc1.                                          |
| `signals.sh`                  | Account-state JSON for the dashboard's accounts strip.                             |
| `statusline.sh`               | Minimal one-line status string (parity with claude/pi providers).                  |
| `__tests__/spawn.test.ts`     | Smoke tests for auth + spawn flows with a mocked `codewhale` binary.               |

## Roadmap

- **v3.0.0-rc1** (this PR): UNGATED scaffolding. Operator can spawn codewhale workers via `subctl teams deepseek`; no SPEC-block HMAC enforcement.
- **v3.0.0-rc2**: SPEC-block HMAC + trust-marker integration. Either an upstream CodeWhale `PreToolUse`-style hook or a wrapper that intercepts `codewhale exec --output-format stream-json` events and pipes them through subctl's trust-marker verifier (`components/master/trust-marker.ts`).
- **v3.x+**: Headless / `--mode rpc` worker variant via `codewhale exec --auto --output-format stream-json` — strong candidate for direct master-daemon orchestration, no tmux required.
- **v3.x+**: Migrate API-key at-rest storage from codewhale's file-based secret store to macOS Keychain or 1Password if operator demand surfaces.

## Why "deepseek" and not "codewhale"

The provider directory name keys off the **model API** (DeepSeek) rather than the **CLI brand** (CodeWhale). Rationale:

1. CodeWhale was DeepSeek-TUI two months ago; the model API is the stable identity.
2. CodeWhale supports ~10 DeepSeek-compatible providers (openai, openrouter, novita, fireworks, …). If subctl later adds a different CodeWhale account routed to OpenRouter rather than DeepSeek, it lives under `providers/openrouter/` (or similar), not `providers/codewhale-2/`.
3. The CLI brand is mutable upstream. The model API is what subctl users actually pay for.

Conventional naming matches `providers/claude/` (Anthropic's API, not "claude-code-cli") and `providers/openai/` (the API, not the specific CLI surface).
