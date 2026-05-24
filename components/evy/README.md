# subctl master — the dev-team conductor

> Persistent supervisor daemon. Drives subctl orchestrators across the operator's code projects, routes across local + remote LLMs, keeps the operator in the loop via a dedicated Telegram bot.

**Status:** shipping in subctl v2.0.0. pi-agent-core wired, 13 tool families registered, three-tier memory online, dashboard chat panel + Telegram listener share a single transcript. See `../../docs/master.md` for the canonical architecture document.

---

## What this is

The "master orchestrator" sitting above subctl's worker layer. While `subctl orch spawn` creates one-shot worker sessions, **subctl master is always running** — walking the portfolio, deciding what to advance next, watching for stalled workers, and talking to the operator over its own Telegram channel.

```
                    Operator (Jason)
                         ↕ Telegram (master-bot, dedicated)
                ┌────────────────┐
                │     subctl master      │   Node daemon, pi-agent-core SDK
                │  (always on)   │   Runs on M3 Studio Ultra
                │                │   Routes: local MLX (default) → Codex (escalate) → Sonnet (fallback)
                └────────┬───────┘
                         │ tools: subctl_orch_*, gh_*, coderabbit_*, telegram_*
                         ↓
                ┌────────┴───────┐
                │    Workers     │   Claude Code in tmux, spawned via subctl
                │ (one per task) │   Account-routed, autonomy SKILL active
                └────────┬───────┘
                         ↕ Telegram (notify-bot, existing)
                    Operator (tactical escalations)
```

**Two Telegram bots** — strategic (master) vs. tactical (worker escalations) get separate channels.

---

## Architecture

| Layer | Role | Where |
|---|---|---|
| Daemon entry | Boot, config load, heartbeat, signal handling | `server.ts` |
| Master SKILL | The CEO/CFO mandate (system prompt for the agent) | `../skills/master/SKILL.md` |
| Tool registry | What subctl master can invoke | `tools/{subctl-orch,gh,coderabbit,telegram}.ts` |
| Multi-model routing | Operator-editable provider config | `providers.json.example` → `~/.config/subctl/evy/providers.json` |
| Per-project autonomy | What subctl master can drive vs. ask vs. shadow | `policy.json.example` → `~/.config/subctl/evy/policy.json` |
| State / decisions | Persistent working memory + audit trail | `~/.config/subctl/evy/{state.json,decisions.jsonl}` |
| Master Telegram bot | Strategic conversation channel | `evy-notify-listener.ts` (TODO stage 2) |
| Worker notify bot | Tactical escalation (existing subctl notify) | `../../dashboard/notify-listener.ts` |

---

## Multi-model routing (M3 Ultra, 256GB unified)

Default `providers.json.example` lineup:

| Role | Model | Quant | Resident | Use case |
|---|---|---|---|---|
| `router` | Gemma 4 E4B | MLX 4bit | ~3GB | Tool dispatch, simple decisions |
| `supervisor` | Gemma 4 31B | MLX 8bit | ~32GB | Portfolio walks, planning, digests |
| `reviewer` | Qwen 3.6 27B | MLX 4bit | ~14GB | PR diff review, code synthesis |
| `embeddings` | Nomic ModernBERT | MLX bf16 | ~150MB | Memory + vault search |
| `escalate` | OpenAI Codex (gpt-5.2) | OAuth | n/a | Hard reasoning, multi-repo plans |
| `fallback` | Anthropic Sonnet 4.6 | API | n/a | Local stack offline |

Total local resident: ~50GB. Plenty of headroom on 256GB.

The master self-elevates per-task based on `routing_policy` in `providers.json` — code review goes to `reviewer`, irreversible decisions to `escalate`, etc.

---

## Per-project autonomy

`policy.json` declares per-project autonomy levels:

- **drive** — subctl master decides + acts. Used for projects you trust the system to push forward.
- **ask** — subctl master proposes + waits for operator yes/no. Used for high-stakes projects (AMP Cortex, anything with regulatory/financial exposure).
- **shadow** — subctl master observes + reports, never acts. Used for projects in moratorium (e.g. argent-core during a refactor).

`must_escalate` is additive: even drive-tier projects can require operator approval for specific actions like `push_to_main`, `merge_pr`, `apply_migration`.

---

## Setup (when v0.2 ships — currently scaffold only)

```bash
# 1. Install master deps
cd ~/code/subctl/components/master
bun install

# 2. Configure routing + policy (seeded from .example on first boot)
$EDITOR ~/.config/subctl/evy/providers.json
$EDITOR ~/.config/subctl/evy/policy.json

# 3. Configure subctl master's Telegram bot (separate from notify-bot)
echo '{"bot_token": "YOUR_NEW_BOT_TOKEN", "chat_id": "YOUR_TELEGRAM_CHAT_ID"}' > ~/.config/subctl/evy-notify.json
chmod 600 ~/.config/subctl/evy-notify.json

# 4. Enable the launchd service
subctl master enable

# 5. Verify
subctl master status
subctl master logs --follow
```

---

## CLI surface (planned)

```
subctl master enable           # boot the persistent daemon (launchd plist)
subctl master disable          # tear down + unregister from launchd
subctl master status            # dashboard pane: providers, policy, last review, recent decisions
subctl master logs [--follow]   # tail master.log
subctl master prompt "..."      # send a one-shot message to subctl master from CLI
subctl master providers         # inspect active routing config
subctl master policy            # inspect active policy
subctl master pause             # halt autonomous review loop (manual mode only)
subctl master resume            # resume after pause
```

---

## Boundaries subctl master doesn't cross

Built into the master SKILL:

- No `git push origin main` without operator approval
- No `gh pr merge` without operator approval
- No production migrations
- No infra mutations (Coolify, Docker on the data-center machines)
- No exceeding `max_concurrent_workers`
- No modifying `ops/rules/*` in any project
- No removing tmux sessions with unsaved working state
- No speaking-as-Jason on GitHub (no PR/issue comments unless operator drafts the text)

---

## Stage map

**Stage 1 (this scaffold):** ✅ shipped
- Tool catalog
- Config + policy templates
- Master SKILL
- Daemon boot path with config validation
- Decision log

**Stage 2 (next):**
- Wire pi-agent-core SDK (replace TODO in `server.ts`)
- Master Telegram bot listener (`evy-notify-listener.ts`)
- launchd plist + `subctl master {enable,disable,status,logs,prompt}` CLI verbs
- Drift / stall detection

**Stage 3:**
- Dashboard merge (orchestration + master config pages added to existing subctl dashboard)
- Cross-worker awareness (master subscribes to all workers' inboxes)
- Cost tracking per master action (token spend per session)

---

## Why this isn't ArgentOS

Argent is broad-purpose: calendar, email, knowledge work, agents-on-everything. subctl master is **code-dev only** — narrower scope, deeper specialization. One workflow vocabulary (git, GitHub, CI, branches, PRs, project portfolios), one integration surface (subctl + GitHub + Telegram). Lives in subctl, not in argent-core, and never tries to grow into Argent's footprint.

Per the operator's instruction: *"Argent is awesome but serves a different purpose."*
