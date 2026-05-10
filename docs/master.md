# subctl master — architecture, memory, roadmap

Canonical reference for the subctl master daemon, the conversational
dev-team orchestrator on the M3 Ultra. **Source of truth for what we've
shipped + what's next.** Update this file when designs change; do not
let architectural choices live only in commit messages or chat history.

---

## 1. Mental model

subctl master is a **conversational, always-on dev-team orchestrator**.
You talk to it. It spawns tmux dev teams. Each team is led by a Claude
Code instance that subdivides work into workers. Leads report back to
master; master surfaces signal to you (dashboard, Telegram).

**KPI: keep projects moving forward.** Master is reactive (chat + Telegram +
watchdog) — not an autonomous walker that runs on a 30-min review tick.

```
You ──chat──┐
            ├──> master daemon (M3 Ultra, qwen 3.5 / 3.6 35b-a3b)
Telegram ───┘         │
                      │  uses tools to:
                      │  - spawn tmux dev teams
                      │  - query GitHub, run code reviews
                      │  - notify operator
                      │  - introspect host, write to vault
                      ↓
         tmux session: dev-team-<name>
              │
              ├── pane 0: team lead (Claude Code session)
              ├── pane 1..N: workers (TeamCreate + Agent)
              ↓
         lead writes status to ~/.config/subctl/master/inbox/<team>.jsonl
              ↓
         master tails inbox (2s poll) →
              broadcasts SSE to dashboard;
              auto-prompts itself on `blocked`/`error` events;
              escalates to operator when needed
```

**Channels:** Dashboard chat (primary), Telegram (mobile), CLI prompts via
`subctl master prompt` (less common). All three feed into the same agent
prompt queue — no double-dispatch, no missed messages.

---

## 2. Components & file layout

### 2.1 Master daemon

| File | Purpose |
|---|---|
| `components/master/server.ts` | Entry. `Bun.serve` on `127.0.0.1:8788`. Endpoints: `/chat`, `/events` (SSE), `/health`, `/diag`, `/teams`, `/transcript`, `/transcript/compact`, `/transcript/clear`, `/context` |
| `components/master/master-notify-listener.ts` | Telegram long-poll. Routes inbound messages into the agent's prompt queue with `source="telegram"` |
| `components/master/tools/subctl-orch.ts` | Spawn/list/status/msg/kill dev-team tmux sessions |
| `components/master/tools/gh.ts` | GitHub PR / issue / check tools |
| `components/master/tools/coderabbit.ts` | AI code-review tools |
| `components/master/tools/telegram.ts` | Push to operator's Telegram |
| `components/master/tools/system.ts` | Host introspection (8 tools): hardware / load / disk / lmstudio_models / tmux_sessions / process_top / projects_dir / daemon_self |
| `components/master/tools/project.ts` | `project_create` (clone/init + vault + policy), `vault_append` (sandboxed markdown writes) |
| `components/master/tools/memory.ts` | `memory_search`, `memory_timeline`, `memory_observations`, `memory_health` — query the claude-mem worker on `localhost:37701` |
| `components/skills/master/SKILL.md` | System prompt loaded at boot. Defines master's persona, tool catalog, stop-on-irreversible rules, anti-hallucination gates |

**Process model:** launchd-managed via `~/Library/LaunchAgents/com.subctl.master.plist`. Restart-survivable — transcript persists to `~/.config/subctl/master/agent-state.json`. `subctl update` bounces it after a `git pull`.

**Tool count:** 30 (5 orch + 4 gh + 3 coderabbit + 2 telegram + 8 system + 4 memory + 2 project + 2 misc). Use `subctl` chat slash-command `/diag` or `curl :8788/diag | jq .tools_loaded` to verify.

### 2.2 Dashboard

| File | Purpose |
|---|---|
| `dashboard/server.ts` | `Bun.serve` on `${SUBCTL_DASHBOARD_HOST}:8787` (default `127.0.0.1`, set `0.0.0.0` for LAN/Tailscale). Serves SPA + REST + WebSocket |
| `dashboard/public/index.html` | Single-page shell. Sidebar nav + per-tab `<section data-tab="...">` panels |
| `dashboard/public/app.js` | All client logic. Notable functions: `wireMasterChat`, `wireOrchestrationCockpit`, `wireProvidersTab`, `wireTeamsTab`, `wireSkillsTab`, `wireSettingsTab`, `wireProjectsTab`, `wireLogsTab` |
| `dashboard/public/style.css` | Theme + per-screen styling. Dark, monospace headers, color-coded by event kind |
| `dashboard/notify-listener.ts` | Separate from master — handles the legacy operator-notify flow (subctl notify ask-yesno etc.) |

**Sidebar tabs** (top to bottom):
1. **Chat** — full-height conversation with master + model picker + sidecar (active dev teams + recent activity)
2. **Orchestration** — live ops cockpit: dev-team cards, watchdog state, live activity feed, master-daemon vitals, on-demand /diag
3. **Dashboard** — overview: dispatch verdict, accounts, sessions, conversations, RL timeline, dev teams panel
4. **Projects** — master/detail; project list + drill-down with PRs/issues/CI/decisions/per-project chat; **+ New Project** wizard with `gh repo create`, vault subtree, policy entry
5. **Teams** — dev-team templates CRUD: persona + skills picker + tool whitelist + autonomy + boot prompt
6. **Claude Sessions** — search every Claude Code session across accounts; copy resume command
7. **Models** — LM Studio catalog (read-only)
8. **Providers** — OAuth profile management per provider (claude/openai/gemini/zai/minimax). Add/edit/delete + auth-command copy
9. **Memory** — Obsidian vault status (configurable root path)
10. **Skills** — imported skill catalog; **+ Import from GitHub**
11. **Live Logs** — streaming tail of master.log / dashboard.out.log / dashboard.err.log / decisions.jsonl
12. **Settings** — system health install-checks, Telegram channel config, API key status, Obsidian vault root, OAuth, raw config viewer

### 2.3 Skill catalog

`~/.config/subctl/skills/<source>/skills/<category>/<name>/SKILL.md` (Claude Code skill format). Imported via `subctl skills import owner/repo`. Currently shipping with `mattpocock/skills` (27 skills) optional + the master's own SKILL.md.

### 2.4 Team templates

`~/.config/subctl/master/team-templates/<name>.json`. Each template:

```jsonc
{
  "name": "code-review",
  "description": "AI code review team that synthesizes coderabbit findings",
  "persona": "You are an AI code reviewer. ...",      // system prompt for the lead
  "skills": ["mattpocock/engineering/triage", ...],   // skill IDs from catalog
  "tools": ["subctl_orch_*", "gh_*", "coderabbit_*", "telegram_*"],
  "default_autonomy": "ask",
  "boot_prompt": "Read CLAUDE.md and any RESUME.md..." // first message to lead
}
```

CRUD via `subctl templates ...` or the dashboard Teams tab. Currently inert (Phase 3c will wire `subctl orch spawn --template <name>` to actually use them).

### 2.5 Inbox channel (lead → master)

`~/.config/subctl/master/inbox/<team>.jsonl`. Lead appends one JSON event per status report:

```jsonc
{"ts": "2026-05-10T01:00:00Z", "type": "progress|blocked|done|error|note", "text": "..."}
```

Master tails the dir (2s poll, plus `fs.watch` opportunistic), broadcasts a `team_event` SSE, and **auto-prompts itself on `blocked`/`error`** so it can decide whether to ping the lead or escalate to operator. `subctl team report --team <t> --type <kind> --text "..."` is the lead-side helper.

### 2.6 Config files

| Path | Purpose |
|---|---|
| `~/.config/subctl/accounts.conf` | Pipe-delimited `alias \| provider \| email \| config_dir \| description` per OAuth profile |
| `~/.config/subctl/master/policy.json` | Operator info, project portfolio, autonomy levels, watchdog interval, max concurrent workers |
| `~/.config/subctl/master/providers.json` | Model routing per role (router/supervisor/reviewer/embeddings/escalate/fallback) |
| `~/.config/subctl/master-notify.json` | Telegram bot token + chat_id |
| `~/.config/subctl/master/compact.json` | Auto-compact config (`auto_compact`, `threshold_pct`, `target_tokens`, `keep_recent`) |
| `~/.config/subctl/master/obsidian.json` | Configured Obsidian vault root |
| `~/.config/subctl/master/agent-state.json` | Persisted transcript |
| `~/.config/subctl/master/decisions.jsonl` | Append-only decision log |

---

## 3. Memory architecture

This is where the Hermes Agent core's design genuinely advances ours.
We adopt the **tiered memory model** Hermes uses, with our specific
backends.

### 3.1 The three tiers

| Tier | Latency | Capacity | What | Backend |
|---|---|---|---|---|
| **Tier 1 — always-in-context** | 0 (always loaded) | ~600 tokens | "Things master must remember every turn" — facts, operator profile, recurring decisions | `~/.config/subctl/master/memory.md` + `user.md` |
| **Tier 2 — on-demand recall** | ~100ms | unbounded | Semantic search over past observations from dev-team Claude Code sessions | claude-mem worker (`localhost:37701`) |
| **Tier 3 — compactable transcript** | 0 | bounded by LM Studio loaded context window | Working conversation memory for the current session | `agent.state.messages`, auto-compacted to ~50K tokens at 90% utilization |

### 3.2 Tier 1 — always-in-context (planned)

Hermes's `MEMORY.md` (2200 char limit) and `USER.md` (1375 char limit) are **always injected into the system prompt**. Two small markdown files. Master can read/edit them via tool calls; operator can edit them via the dashboard Memory tab.

**Why we want this:** master currently re-learns everything every session. Things like "Jason's M3 Ultra has 256GB RAM and a 400Gbps backbone", "Down-Time-Arena's primary branch is `main`, repo is `webdevtodayjason/Downtime-Arena-`", "operator prefers FREE/open-source first", or "max_concurrent_workers is 3" — these don't change between turns and shouldn't depend on tool calls to recall.

**Proposed tools** (Phase 3e):
- `memory_remember(text)` — append a fact to `master/memory.md`. Subject to char limit; rejects on overflow with a hint to consolidate.
- `memory_forget(index)` — remove an entry by index.
- `memory_user_update(text)` — full overwrite of `master/user.md` (operator profile).

System prompt assembly at boot becomes:
```
SKILL.md (master persona + tool catalog + rules)
↓
<memory-context source="user-profile">
{contents of user.md}
</memory-context>
↓
<memory-context source="learned-facts">
{contents of memory.md}
</memory-context>
↓
{tool schemas}
```

Hermes uses literal `<memory-context>` tags + a `StreamingContextScrubber` to ensure these blocks don't leak to the user's chat view. We adopt the same fencing.

### 3.3 Tier 2 — claude-mem (shipped)

**Already wired.** Master has `memory_search` / `memory_timeline` / `memory_observations` / `memory_health` tools that query the claude-mem worker at `localhost:37701`. Captures observations from every Claude Code session (which our dev-team leads ARE), so master can recall:

- "What was decided about Down-Time-Arena's auth flow?"
- "Have we hit this lint error before?"
- "What did the team working on billing do last week?"

**What it doesn't capture:** master's own conversations (it's pi-agent-core, not Claude Code). For that we have agent.state.messages + decisions.jsonl.

### 3.4 Tier 3 — compactable transcript (shipped)

`agent.state.messages` persisted to `~/.config/subctl/master/agent-state.json`. Auto-compacted by a watchdog every 5 min:

- Reads `~/.config/subctl/master/compact.json` for thresholds (default: fire when estimated tokens > 90% of LM Studio's `loaded_context_length`, target 50K, keep last 6 turns intact)
- Calls `POST /transcript/compact` on itself with target_tokens
- Compaction is **deterministic, non-LLM**: extracts user texts + assistant text highlights + tools used into a single structured summary message, archives originals to disk, replaces transcript with `{summary} + {last 6 turns}`

Manual triggers: chat toolbar `compact` button, banner action when `>100%`, `POST /api/master/transcript/compact`.

### 3.5 Provider abstraction (future, Phase 3f+)

Hermes separates `MemoryProvider` (tier 2) from `ContextEngine` (tier 3 compaction). We've conflated them. If/when we want pluggable memory backends (Honcho, Mem0, Supermemory), we should split:

- `MemoryProvider` interface: `prefetch(query)`, `sync_turn(user, asst)`, `system_prompt_block()`, `get_tool_schemas()`, `handle_tool_call()`
- `ContextEngine` interface: `should_compress()`, `compress(messages, target)` — already implicitly the case in our compact.json + watchdog

For now: claude-mem is hardcoded as the tier-2 provider. No pluggability needed yet.

### 3.6 Personal skills authoring (Phase 3d, planned)

Hermes lets the agent **add its own skills** under `optional-skills/<category>/<name>/SKILL.md`. We adopt the same with constraints:

- Master can write to `~/.config/subctl/skills/master/skills/<category>/<name>/SKILL.md` only
- Categories restricted to an allow-list: `team-coordination`, `escalation-patterns`, `code-review-synthesis`, `project-bootstrap`, `incident-response`, `notifications`
- Each new skill must include a `description` frontmatter that mentions one of: orchestration, dev-team, team-lead, escalation, review, or watchdog (sanity check against role drift)
- Tool: `skill_create(name, category, description, content)` + `skill_revise(id, content)`
- All writes logged to `decisions.jsonl` so operator can audit
- Skills appear in the dashboard Skills tab under source = `master`, distinguishable from imported sources

This is how master "gets smarter at its job" without drifting outside its lane.

---

## 4. Roadmap

Ordered by priority. Each phase ends with a commit + push to `main`.

### Phase 3c — Template-driven spawn (next)

Wire team templates into the actual spawn flow. Today templates exist
but are inert — nothing reads them when spawning.

- `subctl orch spawn --template <name> --account <a> --project <p>`
  reads the template, copies its skills into the worker's
  `CLAUDE_CONFIG_DIR/.claude/skills/`, sets persona + boot_prompt as
  the lead's first messages, optionally restricts tool surface
- New master tool `subctl_orch_spawn_template` so master can use it
  from chat ("spawn a code-review team for PR foo/bar#42")
- End-to-end test: spawn a code-review team on a real PR, verify
  the lead boots with the right skills + persona, reports back

### Phase 3c.1 — Context7 integration (today)

Operator has a Context7 API key. Three layers, all need wiring:

1. **Settings:** Settings → API keys card tracks `CONTEXT7_API_KEY`
   (presence-only — never leaks the value to the browser). Set in
   master plist's `EnvironmentVariables` for launchd inheritance.
2. **Master tool:** `context7_query(library, topic, max_tokens?)` —
   hits the Context7 MCP HTTP gateway with the configured key. Lets
   master cite up-to-date library docs in its planning ("what's the
   current API for X?") instead of guessing from cached training data.
3. **Dev-team integration:** when `subctl orch spawn` lands a Claude
   Code session, drop an MCP config snippet into that worker's
   `CLAUDE_CONFIG_DIR` so leads + workers can call Context7 directly
   during work. Folds into Phase 3c's spawn flow.

### Phase 3c.2 — Tmux pane preview + attach affordance

Per operator: "be able to attach to TMUX sessions so I can check in
on all the other dev teams." The /attach slash command exists but only
prints the SSH command. Two adds:

- Dev Teams panel cards get a "view" button → opens an in-page
  preview pane that polls `tmux capture-pane -p` every 2s. Read-only,
  monospace, dim background — pure observation, no interaction.
- "+ attach via ssh" copy-button surfaces the full SSH+tmux command
  on the card itself (no need to hop to Chat for /attach).

Stretch goal (deferred): xterm.js + WebSocket bridge for read/write
in-browser. Not today.

### Phase 3d — Personal skills authoring

Master can author `master/skills/<category>/<name>/SKILL.md` (see §3.6).

- `skill_create` + `skill_revise` tools with category allow-list
- Dashboard Skills tab shows the `master` source distinctly
- Decision log entry per write
- Test: ask master to capture a recurring orchestration pattern as a skill

### Phase 3e — Tier 1 always-in-context memory

`memory.md` + `user.md` files injected into system prompt every turn.

- Three tools: `memory_remember`, `memory_forget`, `memory_user_update`
- Char-limit enforcement (Hermes uses 2200/1375; tune for our use case)
- `<memory-context>` fencing + streaming scrubber so blocks don't leak
- Dashboard Memory tab gets edit affordances for both files
- Reload-on-edit (master picks up changes without restart)

### Phase 3f — Notifications-style chat sidecar refactor

Right rail of the Chat tab currently shows raw event-stream noise.
Curate to summary-style notifications:

- "Spawned dev team `auth-rewrite` for project X"
- "Team `auth-rewrite` reported blocked: 'lint failing on src/x.ts'"
- "Master decided: ping team-lead via subctl_orch_msg"
- "Sent Telegram digest"

Backed by a new master tool `notify_dashboard(summary, kind)` plus
auto-derivation from team_event + watchdog_fire SSE events.

### Phase 3g — Pluggable MemoryProvider abstraction

Optional. Only if/when we want Honcho/Mem0/Supermemory as alternates
to claude-mem.

### Phase 3h — End-to-end live test on real project

Dogfood on Down-Time-Arena. Operator (Jason) wants to spawn a dev team
to build a new cybersecurity game inside the existing arena (Speartip
sponsorship lined up; need to expand beyond the current single game).
Watch the full loop: master → spawn → lead works → reports → master
nudges/escalates → operator gets summary. Validate every link.

### Phase 3j — Plugin system (CLI-anything, AOS-style)

Operator's strong preference: plug-anything pattern over baking
integrations into core. Reference: ArgentOS's three-tier plugin system
on this Mac:

- `~/argentos/tools/aos/aos-<service>/` — CLI-anything connectors.
  Each is its own self-contained CLI binary (60+ shipping: anthropic,
  slack, github, asana, calendar, etc.) with a uniform argv surface.
  Discoverable; no central registration.
- `~/argentos/extensions/<name>/` — heavier integrations with their
  own `package.json` manifest (matrix, signal, whatsapp, voice-call).
- `~/argentos/plugins/<name>/` — drop-in feature packs with manifest.

Mirror for subctl:
- `~/.config/subctl/plugins/<name>/` discovered at master + dashboard
  boot. Manifest declares: master tools to register, dashboard sidebar
  tabs to add, slash commands, CLI subverbs, dev-team skills to merge
  into the catalog under a `<plugin-name>` source. Permission model
  TBD — start with operator-installed-only; signed plugin marketplace
  can come later.
- `~/.config/subctl/connectors/subctl-<service>/` for CLI-anything
  connectors. Master tools auto-bind them as `connector_<service>`.

Reference files (local): `~/argentos/docs/plugins/{building-plugins.md,
manifest.md}`. Read those before designing our manifest format.

### Phase 3i — Spec Forge mode (greenfield / brownfield)

Mirror ArgentOS's spec-forge pattern. Operator opens a spec-forge
session for a project; master conducts a structured interview
(domain → constraints → success criteria → high-level architecture
→ work breakdown → risks). Output is a plan saved to
`<vault>/<project>/SPEC.md` plus per-decision ADRs under
`<vault>/<project>/design/`. The plan becomes the canonical reference
that dev-team templates spawn off — instead of "spawn a feature-dev
team for project X with a freeform prompt," it's "spawn off Step 4
of <project>/SPEC.md."

Two entry modes:
- **Greenfield**: "what should we build?" Master starts from product/
  market/risk questions, drafts a vision, then converges to scope.
- **Brownfield**: "what should we extend?" Master reads the existing
  codebase + RESUME.md, then proposes incremental scope.

**Pattern to mirror** (from ArgentOS at `~/argentos/src/infra/specforge-conductor.ts`):

5-stage state machine:
1. `project_type_gate` — classify GREENFIELD vs BROWNFIELD
2. `intake_interview` — collect problem / users / success criteria /
   constraints / scope / non-scope / technical context
3. `draft_review` — draft or revise the PRD/spec
4. `awaiting_approval` — wait for explicit operator approval
5. `approved_execution` — implementation handoff unlocked; templates
   spawn off the saved SPEC.md

Tool surface mirrors ArgentOS's: a single `specforge` tool with
actions `handle` / `status` / `exit`. State persists to
`~/.config/subctl/master/specforge/<session>.json`. On
`approved_execution`, master copies the final SPEC into
`<vault>/<project>/SPEC.md` and ADRs to `<vault>/<project>/design/`.

Reference files (local, on this Mac):
- `~/argentos/src/infra/specforge-conductor.ts` — the conductor
- `~/argentos/src/agents/tools/specforge-tool.ts` — agent tool surface
- `~/argentos/skills/specforge-project/` — the skill that primes the
  agent to call specforge before any project-build work
- `~/argentos/docs/tools/specforge.md` — design doc

### Phase 3k — Personality presets

Operator request 2026-05-10: pick the master's *personality* (tone,
vocab, mannerisms) without changing its *persona* (who it is — a
dev-team orchestrator that spawns workers, escalates, watches
projects). Personality is voice; persona is job.

**Design:**

- New file: `~/.config/subctl/master/personality.json`
  ```json
  { "preset": "straight-shooter", "intensity": 0.6 }
  ```
- Preset library at `components/master/personalities/<slug>.md`.
  Each is a short fragment (~150–400 chars) that gets injected into
  the system prompt **after** SKILL.md and **before** the tier-1
  memory block. Personality only affects voice — it must not
  override SKILL.md's behavioral contract.
- `composeSystemPrompt()` already concatenates layers; add the
  personality fragment as a new layer between SKILL.md and tier-1
  memory.

**Built-in presets (initial set):**

- `straight-shooter` — current default. Terse, factual, no fluff.
  No change to today's behavior.
- `witty` — dry humor, the occasional callback, never cute.
- `sarcastic` — pointed, slightly impatient. Useful when operator
  wants pushback without it feeling like a tool error.
- `robotic` — clinical, monotone, no contractions, low affect.
- `arnold` — short declarative sentences, action-verb forward.
  Inspired by, not a likeness of.
- `elon` — punchy, contrarian one-liners, willing to be wrong out
  loud. Inspired by, not a likeness of.
- `hilarious` — leans into absurdity. Use sparingly.

**Constraints (must not be relaxable per preset):**

- Tool-call accuracy unchanged. Personality cannot make the master
  fabricate tool names or skip required arguments.
- Decision-log entries stay in straight-shooter voice (these are
  audit records, not vibes).
- Refusal behavior unchanged. Don't let "sarcastic" mode soften a
  refusal or "hilarious" mode make a joke of one.
- Telegram outbound and notification-sidecar messages may use the
  preset's voice; status banners and error toasts may not.

**Hot-swap:**

- New endpoint `POST /api/master/personality` writes
  `personality.json` and triggers `composeSystemPrompt()` on the
  next prompt. No daemon restart. No transcript bounce.
- New dashboard tile under Settings → Master → Personality.
  Single-select dropdown with each preset's one-line description.
  Optional intensity slider (0.0–1.0) for "how much."
- New CLI verb: `subctl master personality {list,show,set}`.

**File layout this adds:**

```
components/master/personalities/
├── README.md                  ← what this is, how to add one
├── straight-shooter.md
├── witty.md
├── sarcastic.md
├── robotic.md
├── arnold.md
├── elon.md
└── hilarious.md
```

**Out of scope for first cut:**

- Per-channel personality (different voice on Telegram vs chat
  panel). Solve later if requested.
- User-authored personality presets at runtime via the dashboard.
  Phase 1 ships built-ins only; community-contributed presets land
  via the plugin system (§3j).
- Voice/audio personality (TTS). Different problem.

**Acceptance:** flip the preset in the dashboard, send a chat
message, watch the response style change without bouncing the
daemon and without any tool-call regression.

### Backlog (non-blocking)

- Sweep remaining `alert()` / `confirm()` calls in Projects + Teams + Skills tabs to use `window.notice` (the Chat tab is done)
- `lms --version` ANSI banner stripping is imperfect — first line with a digit picks up an ASCII-art fragment
- Master's tool list in chat ("subctl_orch_state", "subctl_orch_inbox" etc.) doesn't match the actual tool names (master is hallucinating; system_lmstudio_models was right but state/inbox aren't real). Need a `system_my_tools` introspection so master always reports accurate names from the registry rather than memory.
- Persistent-skills SKILL.md test for master: when claude-mem captures a recurring pattern, master should propose a skill via `notify_dashboard` and let operator approve before writing.
- `subctl update` end-to-end test: pull, rebuild, restart launchd jobs, doctor on the way out.

---

## 5. Operational reference

### 5.1 Restart cookbook

```bash
ssh argent-m3-ultra-dev
launchctl unload ~/Library/LaunchAgents/com.subctl.master.plist
launchctl unload ~/Library/LaunchAgents/com.subctl.dashboard.plist
sleep 2
launchctl load ~/Library/LaunchAgents/com.subctl.master.plist
launchctl load ~/Library/LaunchAgents/com.subctl.dashboard.plist
```

Or pull-and-restart in one command (after dev pushes a change):

```bash
ssh argent-m3-ultra-dev subctl update
```

### 5.2 Required CLI tools (system health checks)

`git`, `tmux`, `bun`, `jq`, `gh` (authed), `claude`, `claude-mem`, `codex`,
`coderabbit`. Optional: `obsidian`, `lms`. Settings → System health
shows install commands; click any line to copy.

### 5.3 LM Studio configuration

**Master auto-pins the supervisor's context window on boot.** The
recurring 4K JIT trap (LM Studio quietly evicts a model under memory
pressure and reloads it at default 4K) is solved as of Phase 3c.3:
master calls `POST /api/v1/models/load` with an explicit
`context_length` from `providers.json` at boot, on supervisor switch,
and via the `/reload-supervisor` HTTP endpoint.

Configure context per role in `~/.config/subctl/master/providers.json`:

```jsonc
{
  "models": {
    "supervisor": {
      "provider": "lmstudio",
      "model": "qwen/qwen3.6-35b-a3b",
      "host": "http://localhost:1234/v1",
      "context_length": 65536
    },
    "reviewer":   { "...": "...", "context_length": 32768 },
    "router":     { "...": "...", "context_length": 8192 },
    "embeddings": { "...": "..." }
  }
}
```

Defaults if `context_length` is omitted: supervisor 65536, reviewer
32768, router 8192, embeddings unenforced.

**Manual reload** (after editing providers.json):

```bash
curl -sS -X POST http://localhost:8788/reload-supervisor \
  -H 'Content-Type: application/json' \
  -d '{"role":"all"}'
```

Or restart master via `subctl update` / `launchctl unload+load`.

**Other config points:**
- Loaded model should have `tool_use` capability (qwen3.5/3.6 a3b
  variants do; gemma-4-e4b does not — use it for router only)
- LM Studio's "Always-on Local LLM Service" must be enabled
- For programmatic per-model defaults, set Context Length in the
  LM Studio UI's gear icon — these are honored by `lms load` even
  without the `--context-length` flag, useful as a backstop in case
  master's force-load misses (e.g. LM Studio API regression)
- Auto-compact at 90% utilization is the second line of defense once
  the working transcript fills the window

### 5.4 Adding a new account

```bash
# Edit accounts.conf manually OR use the dashboard's Providers tab
# (+ New Profile button)

# Then authenticate:
ssh argent-m3-ultra-dev
subctl auth claude <alias>             # browser flow
subctl auth openai <alias>             # device-code flow if SSH'd in
                                       # (auto-detected via SSH_CONNECTION)
```

### 5.5 Spawning a dev team manually (pre Phase 3c)

```bash
subctl orch spawn --account claude-jason \
                  --project ~/code/my-project \
                  --orchestrator \
                  --skip-perms \
                  --prompt "Read CLAUDE.md and pick the next ticket"
```

After Phase 3c lands:

```bash
subctl orch spawn --template feature-dev \
                  --account claude-jason \
                  --project ~/code/my-project
```

---

## 6. Glossary

- **Master** — the persistent dev-team orchestrator daemon
- **Dev team** — a tmux session with a Claude Code lead in pane 0 + workers in pane 1..N
- **Lead** — the head Claude Code instance in a dev team that subdivides work
- **Worker** — Claude Code sub-agent spawned by the lead via `TeamCreate`+`Agent`
- **Profile** — an OAuth account (e.g. `claude-jason`, `openai-titanium`)
- **Template** — a named bundle of persona + skills + tools + autonomy that defines how a dev team boots
- **Skill** — a SKILL.md file defining a focused agent capability (Claude Code skill format)
- **Inbox** — `~/.config/subctl/master/inbox/<team>.jsonl` where leads write status events
- **Vault** — `~/Documents/Obsidian Vault/` (configurable). Long-term operator-curated docs
- **Watchdog** — periodic master-daemon scan that fires synthetic prompts when work goes stale
- **Context engine** — the auto-compaction system that keeps the transcript fitting LM Studio's loaded window

---

## 7. Decision log (this doc)

- 2026-05-10: Adopt Hermes Agent core's tiered memory architecture (§3). Three tiers, claude-mem stays as tier-2 provider, tier-1 (memory.md/user.md) is the next near-term build (Phase 3e).
- 2026-05-10: Personal skill authoring constrained to `master` source + category allow-list (§3.6) — ship after template-driven spawn lands so we can dogfood with real teams.
- 2026-05-10: Document is the source of truth. Update this file when designs change; do not let architectural choices live only in commit messages.
