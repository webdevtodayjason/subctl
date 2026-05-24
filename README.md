<p align="center">
  <img src="./docs/images/og-card.png" alt="subctl — the cross-cutting orchestration layer over every AI subscription you pay for" width="720" />
</p>

# subctl

**The cross-cutting orchestration layer over every AI subscription you pay for.**

You hold Claude Max × N, ChatGPT Pro for Codex, DeepSeek, GLM, Minimax. The frontier-model companies are competing to own the harness layer on top of each of those — `claude agents`, `/workflows`, the Workflow tool, Codex's own session manager. Each one is a silo. Subctl is the layer above all of them: one operator surface, one daemon, one memory pipeline, one notifications fabric, one fleet view — composing whichever provider has headroom for the work at hand.

> **v3.0 in flight.** Last shipped release: **v2.10.0** (Phase 4 context slimming on boot + post-compact). v3.0 is the rebrand to **Evy** + first-class Codex and DeepSeek worker CLIs alongside Claude Code and pi-coding-agent. Per-phase status in [`docs/roadmap.md`](docs/roadmap.md); strategy in [the v3.0 Initiative](#roadmap). The 1.x series was the multi-account dispatch substrate; the 2.x series layered the agentic harness on top; 3.x makes the worker fleet provider-plural at the native CLI level — but the provider plugin model has shipped since v2.7.0 and `providers/` is already eight directories deep.

---

## Terminology

The persistent Bun daemon AND the persona are one thing. The persona's name is **Evy** (E-V-Y). Code-level identifiers (`components/master/`, `com.subctl.master`, `~/.config/subctl/master/`) are scheduled for rename in v3.0 Phase 3 — until then, `master` in code paths and `Evy` in user-facing copy refer to the same process.

| Term | What it is |
|------|------------|
| **Evy** | The persistent Bun daemon + the persona — orchestrates workers, watches state, curates memory, talks to you. **Evy does not code.** |
| **Supervisor LLM** | The model Evy calls each turn to generate her response. Today: **OpenAI Codex `gpt-5.5`** via OAuth on a ChatGPT Pro account. Configurable per profile. |
| **Reviewer LLM** | Local model (gemma-4-26b-a4b-it-mlx via MLX backend) used by the memory kernel to score Tier 2 → Tier 3 promotions. |
| **Worker CLI** | The coding agent that runs inside a worker pane. Shipped today: `claude` (Claude Code) and `pi` (pi-coding-agent — itself a router to 20+ underlying model providers via `/login`). v3.0 targets: `codex` (native), `deepseek-tui`. Spike: `pi-coder` (Bun + pi-agent-core direct, separate from pi-coding-agent). |
| **Worker team** | A coordinated group of worker sessions Evy spawned for one task. One tmux session per team, one inbox JSONL per team. |
| **Worker session** | A single tmux pane inside a team. One agent per pane. |
| **Dashboard** | Web UI at `http://127.0.0.1:8787`. 17 sidebar tabs. Bun-served, no build step. |

A `docs/glossary.md` mirror of the full taxonomy is being staged in a parallel PR.

---

## What it actually does — capabilities matrix

### Worker CLIs

`providers/` already contains eight directories. State per directory:

| Provider directory | Status | Auth | Worker spawn (`teams.sh`) | Notes |
|---|---|---|---|---|
| `providers/claude/` | ✅ shipped | OAuth on Claude Max (per-alias `CLAUDE_CONFIG_DIR`) | ✅ (`subctl teams claude`) | Daily driver. Full auth + teams + signals + statusline + tests + policy hook. |
| `providers/pi-coding-agent/` | ✅ shipped v2.7.0 (UNGATED) | OAuth via `pi /login` inside HOME-shadow dir | ✅ (`subctl teams pi-coding-agent`) | One CLI, 20+ underlying providers (Anthropic Pro, ChatGPT Pro, GLM, others routed by pi). No policy hook yet — pi-coding-agent's hook surface stabilization pending. |
| `providers/openai-codex/` | ✅ shipped (OAuth only) | Device-code flow direct to `auth.openai.com` (no `codex` CLI needed) | — (v3.0 Phase 2) | Token minting is first-class today; native Codex CLI worker spawn lands in v3.0. |
| `providers/openai/` | 🟡 legacy | Shells out to `codex login` | — | Being superseded by `openai-codex/`. |
| `providers/xai-oauth/` | ✅ shipped (OAuth only) | PKCE-loopback against `auth.x.ai` (no external `grok` CLI needed) | — | xAI SuperGrok Subscription token minting; worker spawn not yet wired. |
| `providers/gemini/` | 📝 scaffold | planned v1.2 | — | README-only design notes; CLI integration unverified. |
| `providers/zai/` | 📝 scaffold | investigating v1.3 | — | Pending CLI maturity at Z.AI. |
| `providers/minimax/` | 📝 scaffold | investigating v1.4 | — | Pending OAuth-via-subscription path at Minimax. |
| `providers/deepseek/` (new) | 🚧 v3.0 Phase 4 | API key in `accounts.conf` | 🚧 native worker | DeepSeek-TUI; lands in v3.0 conservative cut as v3.0.x. |

So **today**, an operator with a healthy install can spawn workers on Claude Max accounts AND on pi-coding-agent accounts (which themselves multiplex into Anthropic Pro / ChatGPT Pro / GLM / etc. through pi's own auth). They can also mint OAuth tokens for Codex and xAI Grok via `subctl auth` even before the matching `teams.sh` lands. **v3.0** adds native `subctl teams codex` (no longer needing pi-coding-agent as the indirection) and native `subctl teams deepseek`.

### Daemon, dashboard, fleet

| Capability | Status |
|---|---|
| Multi-account orchestration (Claude Max × N) | ✅ |
| Supervisor LLM decoupled from worker LLM (today: Codex `gpt-5.5` supervisor → Claude / pi workers) | ✅ |
| Per-account isolated config dirs (OAuth bearers in Keychain) | ✅ |
| Per-spawn policy mode (Trusted / **Gated** / Sealed) — claude provider gated, pi provider currently ungated | ✅ |
| HMAC-signed + SPEC-block directives (`Evy → worker`) | ✅ |
| Watchdog reply classifier (working / completed_idle / awaiting_input / blocked) | ✅ |
| Plan-approval workflow (dashboard + Telegram approve / reject) | ✅ |
| Tiered memory (Tier 1 profile / Tier 2 claude-mem / Tier 3 Memori curated / Tier 4 Cognee graph / Tier 5 Obsidian vault) | ✅ |
| Post-compact + boot context hydration from Tier 3 + Tier 4 | ✅ v2.10 |
| Dashboard chat + Telegram + voice + MCP server (14 tools) + CLI prompt | ✅ |
| Multi-team camera view (2 Hz tmux grid) | ✅ |
| In-browser Obsidian vault viewer (wikilinks, embeds, callouts) | ✅ read-only (edit + canvas Phase 3q) |
| Dynamic model catalog (~30+ providers — OpenRouter / Bedrock / Vercel / Cloudflare aggregators) | ✅ |
| `subctl launch <provider>` (account-aware interactive REPL launcher) | 🗓 v3.x |
| Anthropic `/workflows` integration (Statsig-gated upstream) | scripts pre-staged at `.claude/workflows/`; adapter when Statsig flips |
| Multi-tenant / multi-operator host | not planned |

`✅` = shipped on a real operator's daily-driver. `🚧` = active v3.0 work. `📝` = scaffold / design notes only. `🗓` = planned v3.x.

---

## Why subctl exists

The frontier-model companies have stopped being "LLM providers." They are now competing to own the harness layer itself — Anthropic shipped `claude agents`, background sessions, `claude agents --json`, OTEL parent-child tracing, `/workflows` and the Workflow tool across the 2.1.139 → 2.1.150 release arc. OpenAI's Codex CLI is on the same trajectory. Each provider's harness is a silo: it sees one account, on one provider, with one set of credentials.

Subctl sits one layer above all of them.

**The concrete instance, today:** Evy's supervisor LLM is **OpenAI Codex `gpt-5.5`** via OAuth on a ChatGPT Pro account. The workers she spawns include **Claude Code** sessions on three different Claude Max accounts AND **pi-coding-agent** sessions that themselves route to whatever underlying provider the operator's `pi /login` selected (Anthropic Pro, ChatGPT Pro, GLM, and 17+ other backends). Subctl has been using OpenAI to drive Claude (and pi-routed everything-else) since v2.7.0. v3.0 makes native Codex and DeepSeek workers first-class on top — same daemon, same memory pipeline, same notifications fabric, cross-provider arbitrage on rate-limit pressure across the whole fleet.

The lock-in story bites anyone integrating naïvely with a single provider's harness. The defensive shape is:

- **tmux is the substrate, not the vendor's daemon.** Operator-attachable, auditable via `capture-pane`, durable across CLI restarts.
- **Every vendor surface goes through a subctl-owned adapter.** No bare `claude agents --json` in product code. If Anthropic flips a Statsig flag tomorrow, an adapter goes thin, not a release path.
- **Mirror, don't depend.** Subctl's session view polls `claude agents --json` AND its own watchdog. If the schema drifts, fall back, don't go blank.

Full strategy in [`docs/master.md`](docs/master.md) § 1; the design-philosophy alignment doc (vault) is the long form.

---

## 5-minute install

```bash
git clone https://github.com/webdevtodayjason/subctl.git
cd subctl

# See what's missing without touching anything
bash install.sh --check-only

# Run the full installer (preflight → install → verify → wire)
bash install.sh
```

Three phases:

1. **Preflight** — prints a status table of every hard + soft dep, no side effects. Reads `lib/dep-manifest.json` (single source of truth shared with `subctl doctor`, `subctl setup --check`, and the dashboard's Install Checks panel).
2. **Install** — topologically ordered: Homebrew → brew packages (jq, tmux, gh, gum, go, node) → bun → claude CLI → codex CLI → coderabbit → docker (cask, confirm) → claude-mem (npx) → Telegram bot walkthrough. Every step confirm-gated unless `--yes`.
3. **Verify** — re-runs preflight, prints a final go/no-go table, wires the Claude statusline + Stop hook + skills + MCP server + both launchd plists (`com.subctl.master`, `com.subctl.dashboard`) + seeded operator configs.

Useful flags:

```bash
bash install.sh --check-only          # preflight + verify; NO installs
bash install.sh --skip-deps           # jump to component wiring
bash install.sh --yes                 # non-interactive
bash install.sh --botfather           # JUST the Telegram walkthrough
bash install.sh --dry-run             # show what would happen
```

Re-running on a fully-installed machine is a no-op (the ✓ table prints, install phase is skipped).

**Install tree vs. dev tree.** `install.sh` creates a separate git worktree at `~/.local/lib/subctl-install` pinned to `main`. The launchd dashboard plist points at THAT tree, not at your clone. Feature-branch checkouts in `~/code/subctl` (or wherever you cloned) don't silently change what the daily-driver dashboard serves on next restart. Roll `main` into the running dashboard:

```bash
cd ~/.local/lib/subctl-install && git pull origin main
launchctl kickstart -k gui/$UID/com.subctl.dashboard
# (or: subctl dashboard deploy)
```

Then add accounts to `~/.config/subctl/accounts.conf` and re-run `subctl install`. Per-account isolation model lives in [`docs/multi-account.md`](docs/multi-account.md).

---

## Daily ops

What an operator actually does, in narrative order.

**Morning.** Open the dashboard at `http://127.0.0.1:8787`. Five panels visible on the Dashboard tab: dispatch verdict banner (`GO` / `HOLD` / `STOP`), accounts table (per-account 5h + week utilization, RL hits, active sessions), active sessions table, 24h utilization strip with red dots for 429/529 events, recent events list. If the banner is yellow, the reasons list under it tells you which alias has headroom; if red, hold off.

**Spawn a worker team.** Either describe the task in the Chat tab and let Evy spawn the team for you (she'll pick an account based on rate-limit pressure, choose policy mode, write the SPEC-block directive, wait for plan approval), or spawn manually from the CLI:

```bash
subctl team spawn --template lead-and-2 --project ~/code/myproject --account claude-jason
# or: subctl teams claude -a claude-jason -c ~/code/myproject -o -y
```

**Watch it work.** Two ways: the Orchestration tab's NVR-style camera grid (every active tmux pane, polls 2 Hz, click a tile to expand), or `tmux attach -t <team-name>` to steer mid-flight. Workers report progress / blocked / done events to `~/.local/state/subctl/teams/<team>/inbox.jsonl`; Evy tails the inbox and reacts.

**Approve or reject plans.** A worker that emits `plan_approval_request` surfaces as a high-severity notification on the dashboard tray AND Telegram. Approve or reject from either — Evy forwards the decision back to the worker over the HMAC-signed `/msg` route.

**Talk to Evy.** Chat panel for streamed responses with attachment support (paperclip, drag-drop, paste-as-attach >4 KB). Telegram bidirectional with auto-relay. CLI prompt:

```bash
subctl master prompt "spec the foothold-v3 polish and spawn a team for it"
```

The CLI prompt, Telegram message, and dashboard chat all hit the same daemon turn — Evy doesn't care which channel you used; the reply routes back the same way it came in.

**End of day.** Close the laptop. Evy keeps ticking — every 3 min (watchdog scan), every 5 min (auto-compact gate), every 10 min (Cognee promotion). If a worker goes stale past the 15-min threshold, the classifier inspects its last reply and only synthesizes a nudge if it's genuinely `blocked` (not `completed_idle`). If Evy needs you and you're AFK, she escalates to Telegram.

**The next morning.** Same dashboard. The Memory tab shows what Evy decided in your absence, what was promoted from Tier 2 → Tier 3 by the consciousness loop overnight, what landed in the vault.

---

## Starting an interactive Claude session outside subctl

You have multiple Claude accounts (Claude Max × N). The installer wires a `claude-use` shell function into your `~/.zshrc` (or `~/.bashrc`) that enforces "pick an account first" for the bare interactive REPL.

The guard fires **only** on `claude` with no arguments and no recognized flag — the case where you'd be starting a fresh interactive REPL without specifying which account. Three escape routes:

```bash
# Route 1: switch this shell's account persistently
claude-use jason          # short form
claude-use claude-jason   # full alias
claude-use default        # back to ~/.claude (unset CLAUDE_CONFIG_DIR)
claude                    # now opens jason's account

# Route 2: one-off per-command env (alias-style)
claude-jason              # opens jason's REPL without changing the shell
claude-titanium           # opens titanium's REPL once

# Route 3: bypass the guard entirely
command claude            # raw binary, runs against whatever CLAUDE_CONFIG_DIR is set (or default)
```

The following pass-through cleanly without the guard firing — they don't open a fresh interactive session, so the "pick an account first" check would be noise:

```text
claude update          claude doctor          claude mcp
claude config          claude ultrareview     claude --version
claude --help          claude -p "..."        claude --print
claude --resume <id>   claude --continue      claude -c
claude -r              claude migrate-installer
claude setup-token
```

`claude-use` (with no args) prints the current account + a list of available aliases.

**Planned for v3.x:** a `subctl launch claude|codex|deepseek` sub-command that handles account selection + per-provider config + dispatch in one step, so the muscle memory generalizes across providers instead of being Claude-specific.

---

## CLI surface

Live help: `subctl help`. Cheat sheet at `http://127.0.0.1:8787/cheat`. Full reference at [`docs/cli.md`](docs/cli.md).

The CLI is a bash dispatcher (`bin/subctl`, symlinked to `/usr/local/bin/subctl` or `~/.local/bin/subctl`). Verbs are grouped by surface area.

### Account + auth

```bash
subctl accounts                                  # status table
subctl accounts add <provider> <alias> <email> [config_dir] [description]
subctl accounts remove <alias> [--purge]
subctl auth <provider> <alias>                   # OAuth into the account's config dir
subctl auth all                                  # walk every account that needs auth
subctl whoami                                    # current shell's CLAUDE_CONFIG_DIR → alias
subctl share [alias|all]                         # symlink ~/.claude/{agents,commands,hooks,…} into account dirs
```

Providers today: `claude`, `openai`, `openai-codex`, `xai-oauth`, `pi-coding-agent`, `gemini`.

### Worker teams

```bash
subctl teams claude -a <alias> [-c -o -y -p TEXT -f FILE --dry-run]
subctl teams pi-coding-agent -a <alias> [-p TEXT -f FILE -m MODEL --dry-run]
subctl team spawn --template <name> --project <path> [--account <alias>]
subctl team list
subctl team kill <name>
subctl team exec <name> <command...>             # HMAC-signed one-off directive
subctl team logs <name> [--tail N] [--follow]
subctl team report --team <t> --type <kind> --text "..."
subctl team inbox <team> [--tail N]
subctl team baseline init|ensure|status [path]   # install claude-layers baseline
```

### Sessions (tmux + Claude transcripts)

```bash
subctl session-list [--format plain|sesh|json]
subctl session-preview <name>
subctl session-kill <name> [name...]
subctl session-prune [--older-than 6h] [--yes]
subctl session-resume [--cwd PATH] [--account ALIAS] [--latest] [--list]
subctl prune-transcripts [--older-than 30d] [--workers|--all] [--archive PATH] [--yes] [--dry-run]
subctl sessions list [--orphans|--account <alias>]
subctl sessions adopt <alias> <sid>
subctl sessions adopt-latest <alias>
subctl sessions pick <alias>
```

### Evy daemon + dashboard

```bash
subctl master enable                             # install + load launchd plist
subctl master prompt "<text>"                    # CLI prompt to Evy (same turn surface as Chat)
subctl master restart                            # bounce the daemon
subctl master kick                               # recover from launchd throttle (local TTY only)
subctl master personality set <preset>           # straight-shooter | witty | sarcastic | robotic | arnold-inspired | elon-inspired | hilarious
subctl service enable|start|stop|restart|logs    # dashboard service
subctl dashboard [open]                          # ensure service running, open browser
subctl dashboard deploy                          # pull origin/main into install tree, kickstart
```

### Operator-from-anywhere (HTTP-backed)

These talk to the running daemons via the dashboard's `/api/master/*` proxy, so they work from any terminal on the host:

```bash
subctl status [--json]                           # one-shot probe — versions, uptime, profile, telegram
subctl logs [--master|--dashboard] [--tail N] [--follow]
subctl deploy [--no-pull] [--dry-run]            # git pull + kickstart -k (bash-and-go)
subctl notif [recent | list <N> | mark-all-read]
subctl memory recent <N>                         # Tier 3 (Memori curated)
subctl memory search "<query>"
subctl memory remember "<text>"
subctl config show|edit|validate [section]       # auto-redacts secrets on show
subctl profile show|switch <name>|list           # active supervisor profile (chat | heavy | …)
subctl voice status|test|render <text>|on|off
subctl prefs show|get|set|edit|reset
```

### Radar, usage, cost

```bash
subctl radar                                     # CLI version of the dispatch verdict
subctl radar log [--tail]
subctl usage [alias|all|--json]                  # per-account Claude Max 5h / 7d / 7d-Sonnet / 7d-Opus
subctl cost [alias|all] [--window today|week|month|all] [--json]
```

### Notifications + structured Q&A

```bash
subctl notify <msg>                              # send a Telegram message (escalation channel when operator is AFK)
subctl notify --setup                            # one-time bot token + chat id
subctl notify --test
subctl notify ask-yesno "q" --id Q42             # Yes/No buttons; reply lands in inbox
subctl notify ask-choice "q" -o A:label -o B:label
subctl notify ask-text "q" --id Q42
subctl notify inbox [--id Q42]
subctl notify inbox-ack Q42
```

### Templates, skills, plugins, policy

```bash
subctl templates list|show|create|duplicate|delete
subctl skills import <repo>                      # e.g. mattpocock/skills
subctl skills list|info|sources
subctl skills router-trace "<msg>"               # which skills Evy's router would preload
subctl plugins list|install|remove|status
subctl policy check|list|validate|explain|audit|snapshot
```

`policy check` is the hot-path gate called from hooks; the others are operator-facing. See [`docs/policy.md`](docs/policy.md) for the schema and threat model.

### Doctor + version + install

```bash
subctl doctor
subctl install [--migrate]
subctl setup [--wizard | --check | --botfather]
subctl update
subctl uninstall
subctl version
```

---

## Scripting model

Three layers of "how to make a worker do work the way you want."

### Directives (HMAC + SPEC)

The wire contract between Evy and every worker she spawns. Two layers of trust on every message:

- **HMAC signature** proves WHO sent the directive (Evy, not a prompt injection landing in the worker's transcript).
- **Embedded `SPEC:` block** proves WHAT the directive contains (task body inlined, never relies on a prior paste landing). Workers refuse markers missing either layer.

`subctl team exec <name> "<command>"` is the one-off operator-facing form — your text gets wrapped in the marker before tmux pastes it. Don't ferry untrusted prompts through `exec`; the worker contract treats anything inside the marker as authorized operator input.

### Workflows

Anthropic's `/workflows` feature (Statsig-gated upstream as of 2026-05-23) is the code-as-orchestrator pattern for a single Claude Code session — code decides the flow, the LLM runs inside phases with scoped context. Subctl pre-stages two scripts at `.claude/workflows/` ready for the day Statsig flips for your account.

Subctl's position on `/workflows`: treat it as one provider's orchestration primitive, not THE substrate. When it lands, subctl will dispatch workflows (the `workflow.js` becomes a payload Evy ships to a Claude session) — but Evy's own orchestration (tmux teams, watchdog, inbox events, multi-account routing) stays in subctl. The Claude Code stack is one optional integration, not the runtime.

### Skills

Worker skills live at `components/skills/<name>/SKILL.md` and the operator catalog at `~/.config/subctl/skills/`. Workers auto-load relevant skills via Evy's router; the dashboard's Skills tab is the import/inspect surface. `subctl skills router-trace "<msg>"` shows you which skills would preload for a given message before you spawn the worker.

### Hooks

Claude Code hooks (Stop, SessionStart, PreToolUse, etc.) are wired into every account's config dir by `subctl install` and `subctl share`. The Stop hook is what powers the rate-limit attribution in the dashboard's Recent Events panel.

---

## Defaults — the policy engine

Subctl spawns workers in **Gated** mode by default. Every other harness defaults to **Trusted**. This is the single biggest behavioral difference.

| Mode | Trust gate | When |
|------|-----------|------|
| **Trusted** | The model itself | Throwaway sandboxes. Opt-in. Subctl warns at spawn. |
| **Gated** | Policy allowlist (subctl-managed) | **Default.** All real work. |
| **Sealed** | No shell at all; explicit tools only | Production-adjacent. Long-running unattended tasks. |

```bash
subctl teams claude                              # Gated (default), preset auto-detected
subctl teams claude --mode=sealed                # No shell. Explicit tools only.
subctl teams claude --mode=trusted               # Raw. Warning printed.
```

Per-project policy lives in `<project>/.subctl/policy.toml`. Shipped presets cover Node, Python, and a restrictive generic baseline.

**What Gated mode prevents:** `rm -rf` and indirect variants, `curl|sh` / `wget|sh` drive-by, `python -c '...'` / `node -e '...'` inline-code escape hatches (denied across every interpreter), `npm run <undeclared-script>` (closes the package.json-rewrite attack), writing to shell init files, fork bombs, `dd` to block devices, `chmod -R 777`, `chown -R`.

**What Gated mode does NOT prevent:** a worker overwriting a file with bad content (reversible via git, which is why we accept it); a worker doing legitimate damage with a legitimate command (no allowlist fixes this); prompt injection that convinces Evy to spawn in Trusted mode (separate concern — see [`docs/policy.md`](docs/policy.md) § threat model).

Every check writes a line to `~/.local/state/subctl/audit/<team>.jsonl`. The dashboard's Live Logs tab has a Policy filter. Denials surface in real time; Evy watches for denial clusters and steers the worker away from fighting the gate.

Full reference: [`docs/policy.md`](docs/policy.md).

---

## What subctl does NOT do

- **Subctl does not code.** Evy orchestrates; workers code. The supervisor LLM that drives Evy is explicitly configured to call tools and spawn workers, not to write source files itself.
- **Subctl is not multi-tenant.** Single-operator-per-host. There is no cross-host federation, no team accounts, no shared dashboard. Three Macs running agents = three dashboards. (Cost model: subscriptions, not seats.)
- **Subctl does not bundle a model.** It uses whatever you've authenticated against — Claude Max, ChatGPT Pro, DeepSeek API key, local backend via LM Studio / Ollama / MLX. Inference happens at the provider; subctl just routes.
- **Subctl does not yet ship `subctl launch`** — the planned per-provider interactive REPL launcher. Until v3.x, see the [`command claude` section](#starting-an-interactive-claude-session-outside-subctl) for how operators bridge the gap.
- **Subctl does not depend on Anthropic's `/workflows`.** Scripts pre-staged at `.claude/workflows/`; the feature is gated by Statsig upstream and could be pulled at any time. Treated as an opportunistic integration, not a critical path.
- **Subctl does not run on Windows or Linux.** macOS only — Keychain integration uses `security`, fleet management uses launchd plists, voice layer uses `say`/CoreAudio. Porting is possible but not on the roadmap.
- **Subctl does not auto-update.** `subctl update` is operator-driven (`git pull` + rebuild + restart + doctor). The agentic harness owning its own upgrade path is a footgun we explicitly avoid.

---

## Architecture

```
   You (operator)
         │
         ├── dashboard chat (SSE)  ┐
         ├── Telegram             ├─►  Evy daemon  ◄────  Supervisor LLM
         ├── voice notes          │   (persistent      │   (Codex gpt-5.5 today;
         ├── CLI: subctl prompt   │    Bun process,    │    fallback: Sonnet 4.6)
         ├── MCP client (/mcp)    │    launchd-managed)│
         └── scheduled self-prompt┘                    └─►  Reviewer LLM
                                       │                    (local gemma-4-26b-a4b-it-mlx)
                                       │
                                       │  spawn / msg / kill
                                       │  (HMAC + SPEC contract)
                                       ▼
                       ┌───────────────────────────────────────────────┐
                       │  Worker teams (one tmux session per team)     │
                       ├───────────────────────────────────────────────┤
                       │                                               │
                       │  ✅ Claude Code         ✅ Claude Code        │
                       │  (acct: jason)         (acct: titanium)       │
                       │       ↑                       ↑               │
                       │  CLAUDE_CONFIG_DIR=    CLAUDE_CONFIG_DIR=     │
                       │  ~/.claude-jason       ~/.claude-titanium     │
                       │                                               │
                       │  ✅ pi-coding-agent (acct: pi-personal)       │
                       │     HOME-shadow dir; pi /login routes to 20+  │
                       │     underlying providers (ChatGPT, GLM, …)    │
                       │                                               │
                       │  🚧 Codex CLI (v3.0)   🚧 DeepSeek-TUI (v3.0+)│
                       │     OAuth: ChatGPT        API key             │
                       │                                               │
                       │  🔬 pi-coder (Bun + pi-agent-core)  [spike]   │
                       │     any chat-API provider, direct (no tmux    │
                       │     REPL — see v3.0 Phase 5 in roadmap)       │
                       │                                               │
                       └───────────────────────┬───────────────────────┘
                                               │
                                               │  inbox events:
                                               │  progress / blocked / done / error
                                               ▼
                       ┌───────────────────────────────────────────────┐
                       │  Memory pipeline                              │
                       ├───────────────────────────────────────────────┤
                       │  Tier 1  user.md + memory.md  (always-on)     │
                       │  Tier 2  claude-mem semantic search           │
                       │  Tier 3  Memori curated facts (bun:sqlite)    │
                       │  Tier 4  Cognee graph + lexical store         │
                       │  Tier 5  Obsidian vault (long-form decisions) │
                       └───────────────────────────────────────────────┘
```

The substrate is **tmux**, not any vendor's daemon. tmux is auditable (`capture-pane`), operator-attachable (`attach -t <team>`), and durable across CLI restarts. Vendor harnesses (Anthropic's `claude agents`, OpenAI's session manager) ride on top as one integration each — none of them are in the critical path for a subctl release.

Canonical architecture doc with decision history: [`docs/master.md`](docs/master.md). Per-provider wiring: [`docs/adding-a-provider.md`](docs/adding-a-provider.md). Memory tiers in depth: [`docs/memory-architecture.md`](docs/memory-architecture.md).

---

## Repo layout

```
.
├── bin/subctl                     CLI entry point (bash dispatcher)
├── components/master/             Evy daemon (Bun + pi-agent-core)
│   ├── server.ts                  HTTP, SSE, ticker scaffolding
│   ├── tools/                     50+ tools across 13 families
│   ├── personalities/             voice presets
│   ├── verifier.ts                runtime claim verifier
│   └── attachments.ts             chat attachment storage
├── components/skills/             baseline + Evy skills
│   ├── master/SKILL.md            Evy's own system prompt
│   ├── subctl/SKILL.md            worker-facing subctl skill
│   └── orchestrator-mode/         anti-deadlock activation guard
├── dashboard/                     web UI (Bun static + SSE proxy; no build step)
│   ├── server.ts                  HTTP + WS + SSE + /api/master/* proxy
│   ├── public/                    HTML/CSS/JS, ES modules
│   └── help.md                    /help page source
├── providers/claude/              Claude Code provider (auth, teams, hooks, skills)
├── providers/openai/              OpenAI Codex provider (OAuth + device-auth)
├── lib/                           shell helpers (accounts, install, update,
│                                   master, plugins, settings, …)
├── docs/                          design docs (master.md, multi-account.md,
│                                   policy.md, cli.md, roadmap.md, …)
├── .claude/workflows/             pre-staged Anthropic /workflows scripts
└── VERSION                        single source of truth for version
```

---

## Roadmap

Per-phase status lives in [`docs/roadmap.md`](docs/roadmap.md). v3.0 is the active initiative — Evy rename + multi-provider workers — landing across six phases:

- **Phase 0 — Glossary lock.** ✅ shipped (vault canonical).
- **Phase 1 — Language rename, non-breaking.** README, dashboard chrome, CLI help, docs say "Evy." Code paths unchanged. *(this PR is Phase 1's README piece)*
- **Phase 2 — Codex worker CLI.** `subctl teams codex` spawns native Codex workers honoring the SPEC/HMAC directive contract.
- **Phase 3 — Code rename + compat shim.** `components/master/` → `components/evy/`, `com.subctl.master` → `com.subctl.evy`, `~/.config/subctl/master/` → `~/.config/subctl/evy/`. `subctl master <verb>` keeps working with a deprecation warning through v3.x.
- **Phase 4 — DeepSeek-TUI worker CLI.** Same contract as Phase 2, different runtime.
- **Phase 5 — pi-coder spike.** Time-boxed research: can a Bun process running pi-agent-core look like a worker to Evy? Deliverable is a design doc, not shipped code.

The conservative v3.0 cut is Phases 0–3; Phases 4–5 ship as v3.0.x / v3.1.

Provider expansion beyond v3.0 (Gemini native, Z.AI GLM, Minimax): see [`docs/roadmap.md`](docs/roadmap.md).

---

## Contributing

PRs welcome. To add a new provider, read [`docs/adding-a-provider.md`](docs/adding-a-provider.md). For Evy daemon changes, read [`docs/master.md`](docs/master.md) first — it has three months of decision history baked in. For everything else, open an issue first so we can agree on shape.

Bump policy in [`docs/release-workflow.md`](docs/release-workflow.md): patch (Z) is the default; minor (Y) only for genuine new user-visible features; major (X) only for breaking changes. Single source of truth for the version is [`VERSION`](./VERSION).

## License

MIT — see [LICENSE](LICENSE).
