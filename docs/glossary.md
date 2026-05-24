# Glossary

Canonical taxonomy for subctl. Mirror of the project's Obsidian vault glossary at `<vault>/Subctl/10 - Glossary.md`. Update both together — this is the source of truth for code-readers; the vault copy is the source of truth for human reviewers. Either way, when this doc and the vault disagree, the vault wins for taxonomy decisions and this doc gets resynced.

**Spelling note:** the persona name is **Evy** (E-V-Y). "Eevee" appears when voice-to-text (Wispr Flow) misspells it — treat as same entity, normalize to Evy in writing.

## Core entities

### Evy

The persistent Bun daemon AND the persona. They are one thing.

- **Process:** `bun run components/master/server.ts` under launchd plist `com.subctl.master` (these code-level identifiers are scheduled for rename — see the v3.0 Initiative).
- **Identity:** the "librarian" persona contract defined in `components/skills/master/SKILL.md`.
- **Surface:** chat (dashboard SSE, `http://127.0.0.1:8787`), Telegram, voice notes, MCP server at `/mcp`, CLI prompt via `subctl master prompt` (future: `subctl evy prompt`).
- **Role:** orchestrate dev-team work. **Evy does not code.** She spawns workers, watches them, classifies their state, escalates blockers, persists decisions, curates memory, talks to the operator.
- **Autonomy:** ticks every 3 min (watchdog scan), every 5 min (auto-compact gate), every 10 min (Cognee promotion), reacts to inbox events from workers.

> Use "Evy" everywhere user-facing. "Master daemon" is legacy code-level vocabulary that v3.0 retires.

### Supervisor LLM

The model Evy calls (via [pi-agent-core](https://github.com/earendil-works/pi-agent-core)) to generate her responses each turn.

- **Today:** OpenAI Codex (`gpt-5.5`) via OAuth on a ChatGPT Pro account.
- **Not Claude.** ADR 0019 (in the vault `05 - Decisions Log`) explicitly blocks Anthropic API in the supervisor role; it would bill against the $200/mo Agent SDK credit instead of Max 20×.
- **Configurable** via `~/.config/subctl/master/providers.json`. Operator changes via `/reload-supervisor` in chat or the dashboard Models tab.
- **Fallback:** `anthropic / claude-sonnet-4-6` via Max subscription auth, used only when the primary supervisor is unreachable.

### Reviewer LLM

The model called for memory-kernel review tasks (curating Tier 2 → Tier 3, scoring observation candidates).

- **Today:** local `gemma-4-26b-a4b-it-mlx` via the local backend at `http://127.0.0.1:8000/v1`.
- Separate from supervisor so curation work can run on a different cost/latency profile than user-facing chat.

### Worker team

A coordinated group of worker sessions Evy spawns for a single task.

- One tmux session per team. Named (e.g., `subctl-v2816-fix`, `floq-v2`).
- Scoped to a project directory (`-c <cwd>` at spawn).
- One **lead** worker per team — coordinates the rest via TeamCreate + Agent dispatch inside the lead's session.
- Has an **inbox** (`~/.local/state/subctl/teams/<team>/inbox.jsonl`) workers write progress/blocked/done events to; Evy tails the inbox.

### Worker session

A single tmux pane inside a worker team. One AI agent per pane.

### Worker CLI / worker agent

The runtime inside a worker session.

| Status | CLI | Provides | Auth |
|---|---|---|---|
| ✓ shipped | `claude` (Claude Code) | Claude Sonnet/Opus 4.6–4.7 | OAuth on Claude Max accounts (one per `-a <alias>`) |
| 🚧 v3.0 target | `codex` (OpenAI Codex CLI) | GPT-5.x via Codex | OAuth on ChatGPT Pro accounts |
| 🚧 v3.0+ target | `codewhale` (CodeWhale, formerly DeepSeek-TUI — [Hmbown/DeepSeek-TUI](https://github.com/Hmbown/DeepSeek-TUI)) | DeepSeek V4, 1M ctx, parallel sub-agents | API key |
| 🔬 spike-only | `pi-coder` (subctl-spawned pi-agent-core Bun process) | Any chat-API-compatible provider (ZAI/GLM, Minimax, OpenRouter routes, local) | per-provider API key / OAuth |

The pi-coder pattern is a SPIKE (research item) for v3.0 — it would let us spawn workers against subscriptions that don't ship a native TUI.

## Supporting entities

### subctl

The overall harness — CLI + Evy + dashboard + skills + provider plugins + memory tiers + policy engine.

### Dashboard

The web UI at `http://<host>:8787`. Bun-served static + SSE proxy + WebSocket. 17 sidebar tabs. Decomposed into ES modules.

### Tier 1 / Tier 2 / Tier 3 / Tier 4 / Tier 5 (memory)

See [memory-architecture.md](memory-architecture.md) for the full spec. Short version:

- **Tier 1** — `user.md` + `memory.md` always-injected operator profile facts. Budget ~4000 chars.
- **Tier 2** — claude-mem semantic search across raw observations.
- **Tier 3** — Memori curated durable facts (bun:sqlite + FTS5).
- **Tier 4** — Cognee graph + lexical store, cross-session semantic recall.
- **Tier 5** — Obsidian vault (durable long-form decisions).

### SPEC-block directive

The HMAC-signed message contract for all Evy→worker communication. Two-layer trust:

- **HMAC signature** proves WHO sent the directive (Evy, not a prompt injection in the worker's transcript).
- **Embedded `SPEC:` block** proves WHAT the directive contains (task body inlined, never relies on a prior paste).

Workers refuse markers missing either layer.

### Policy mode (Trusted / Gated / Sealed)

Per-spawn policy applied to a worker's bash gate.

- **Trusted** — model decides what's safe. Opt-in, warning printed.
- **Gated** — policy allowlist (subctl-managed). **Default.**
- **Sealed** — no shell at all, explicit tools only.

### Watchdog classifier

Pane-hash + reply-classification system that decides if a quiet worker is `working` / `completed_idle` / `awaiting_input` / `blocked`. Only `blocked` workers get a corrective prompt — `completed_idle` ones are left alone.

### Memory kernel reviewer

The background loop that promotes raw observations (Tier 2) → curated entries (Tier 3) → graph hits (Tier 4). Uses the Reviewer LLM. Operator-in-the-loop for Tier 1 promotions via the Memory tab's `⚗ Consolidate` flow.

## Legacy code identifiers (Phase 3 rename targets)

These tokens still appear in the codebase as of v3.0-rc1 because the language rename (Phase 1) ships before the code rename (Phase 3):

| Code identifier | What it refers to | Phase 3 target |
|---|---|---|
| `components/master/` | Evy daemon source tree | `components/evy/` |
| `lib/master.sh` | Evy CLI dispatcher | `lib/evy.sh` |
| `subctl master <verb>` | Evy CLI subcommand | `subctl evy <verb>` (compat shim retains `subctl master` for one minor cycle) |
| `com.subctl.master` | launchd plist label | `com.subctl.evy` |
| `~/.config/subctl/master/` | Evy state directory | `~/.config/subctl/evy/` |
| `master.log` | launchd log file name | `evy.log` |
| `/api/master/*` | dashboard ↔ Evy proxy routes | `/api/evy/*` |
| `master-notify.json` | Telegram bot config | `evy-notify.json` |
| `master:8788` | host:port label in CLI/help output | `evy:8788` |
| `master persona` enum value (skills source = "master") | code-level enum tag for Evy-authored skills | enum value renamed |

When you see one of these in docs, treat it as a citation to the file/identifier as it exists today — don't rephrase the path itself, but rephrase surrounding prose to refer to "Evy" rather than "the master."

## Cross-references

- Vault: `<vault>/Subctl/10 - Glossary.md` — human-readable mirror with wikilinks
- Vault: `<vault>/Subctl/Initiatives/v3.0 — Evy rename + multi-worker providers.md` — the rename initiative + phase plan
- [memory-architecture.md](memory-architecture.md) — deep spec on Tier 1–5
- [master.md](master.md) — Evy's architecture, tool surface, operating model (filename is a legacy identifier — renamed Phase 3)
- [persona/evy.md](persona/evy.md) — Evy persona spec
- [policy.md](policy.md) — policy engine overview
- ADR 0019 (vault `05 - Decisions Log`) — why supervisor isn't Anthropic API
