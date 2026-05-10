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

### Phase 3l — Document attachments in chat

Operator request 2026-05-10, prompted by the FOOTHOLD dogfood test:
pasting the 21-KB spec into the chat panel filled the visible chat
with wall-of-text and pushed ctx from ~5K to ~26K instantly. We need
a way to attach documents that doesn't bloat the chat surface.

Two entry points, same backend:

1. **Explicit upload** — paperclip / file-picker / drag-drop. Local
   files attach as-is.
2. **Auto-paste interception** — paste handler measures the
   clipboard payload; if it crosses a threshold (default 4 KB), the
   pasted text is intercepted, written to disk as an attachment,
   and the chat input shows a pill (`pasted-2026-05-10-1342.md ·
   8.4 KB`) instead of the raw text. User can still click the pill
   to inline-paste the original if they really want it visible.

**Storage:**

```
~/.config/subctl/master/attachments/
├── 2026-05-10/
│   ├── a1b2c3d4-foothold-spec.md
│   └── e5f6a7b8-pasted-fragment.md
└── index.jsonl   # {id, filename, sha256, size, mime, source, created_at, deleted_at?}
```

- Attachments live indefinitely. They're cheap on disk and someone
  may want to refer back to one ("re-read FOOTHOLD_SPEC.md and
  build me a worker prompt").
- `subctl master attachments {list,show,gc}` for cleanup. `gc`
  drops attachments older than 90 days that no transcript message
  references.

**How the master sees an attachment:**

Two layers, both available simultaneously:

- **Inline injection (default)** — at send time, the chat server
  resolves attachment ids → reads file → wraps each in
  `<attachment id="..." filename="..." size="...">…contents…</attachment>`
  blocks → prepends them to the user message in the prompt sent to
  the model. The browser-visible transcript shows only the pill, so
  the chat surface stays readable but the model sees full content.
- **Tool-mediated** — new master tool `read_attachment(id, range?)`
  for after compaction. Once the auto-compactor drops the inline
  content, the master can re-fetch on demand without forcing the
  operator to re-paste.

**Auto-paste threshold:**

- Default: 4 KB or 50 lines, whichever is smaller. Configurable in
  `~/.config/subctl/master/chat.json`.
- Threshold matters: too low and quoting a stack trace gets
  awkwardly attachment-ified; too high and a 20-KB spec slips
  through. 4 KB is roughly "more than I'd want to read inline."

**API surface:**

```
POST   /api/master/attachments        (multipart/form-data)
         → { id, filename, sha256, size, mime, created_at }

GET    /api/master/attachments        (auth required)
         → [{ id, filename, size, source, created_at, refs }]

GET    /api/master/attachments/<id>
         → file bytes with proper Content-Type

DELETE /api/master/attachments/<id>
         → 204

POST   /chat
         body now accepts: { text, attachments: [<id>...], source }
```

**Chat-send flow with attachments:**

1. User uploads or pastes large text → `POST /api/master/attachments`
   returns `{id}`. Browser stores `[id, ...]` against the input box.
2. User hits send → browser does `POST /chat { text, attachments: [...] }`.
3. Master server reads each attachment's bytes, wraps in fenced
   `<attachment>` blocks, prepends to the user message before
   invoking `agent.prompt()`.
4. Transcript message records the user text + an `attachments` array
   of `{id, filename, size}` (NOT the inline content). Browser
   renders the pill chip; model saw the full content during the call.
5. After auto-compaction drops the prompt, the next time the master
   needs that attachment it calls `read_attachment(id)` and gets it
   back.

**UI:**

- Paperclip icon next to the SEND button. Click → file picker.
- Drop zone: dragging a file anywhere on the chat panel highlights
  the input area; drop attaches.
- Pill chip(s) appear above the input field showing attached
  filenames and sizes; X to remove before send.
- Paste interception with toast: *"Captured 21.4 KB as
  pasted-2026-05-10-1342.md — sent as attachment. [show inline]"*

**Constraints:**

- File size cap: 5 MB per attachment for MVP. Anything bigger
  refuses with a clear error pointing at vault tier-3 instead.
- Mime-type allowlist: text/* (any), application/json, application/yaml,
  application/x-yaml, image/png, image/jpeg, application/pdf. Reject
  binaries we can't read (executables, archives) by default —
  master can't reason about them anyway.
- For images: phase 1 stores them but does NOT inline them in the
  prompt unless the supervisor model has vision. The pill shows
  thumbnail-only for now; full vision-prompt integration is a
  follow-up after we have a vision-capable supervisor wired (qwen
  has VL variants; LM Studio supports them).
- For PDFs: phase 1 extracts text via `pdftotext` (poppler) at
  upload time, stores both the original PDF and the extracted text;
  the inline injection uses the extracted text. The original PDF
  stays for download but doesn't go into the prompt.

**Out of scope for first cut:**

- Per-attachment ACLs (everyone with master access sees everything).
- OCR for scanned PDFs.
- Inline-editing or annotation of attachments inside chat.
- Sharing attachments out-bound (e.g., into a dev-team's worker
  prompt). Phase 2 — workers should be able to fetch attachments by
  id when their prompt references them.

**Acceptance:** drop a 50-KB markdown file onto the chat panel,
see a pill, hit send, master responds with full awareness of the
file's contents, transcript stays readable, and re-asking after a
compaction still works because the master re-reads via
`read_attachment`.

### Phase 3m — Multi-team camera view (NVR-style team grid)

Operator request 2026-05-10: a single dashboard view that shows
every active dev team's tmux pane simultaneously, NVR-style. Like
"Camera 1, Camera 2, Camera 3" on a security DVR but each feed is
a live tmux session — `Team X1`, `Team X2`. Click a tile to expand
to full-pane; click expanded tile to collapse back to the grid.

This is the replacement for today's Orchestration cockpit. The
current per-team card layout is fine for one team; with three or
more in flight, you can't see them all without clicking back and
forth. Camera view is the right primitive for "what's everyone
doing right now."

**Layout:**

- Auto-grid sizing based on team count:
  - 1 team:  full pane (no grid)
  - 2 teams: 2×1 (side-by-side)
  - 3–4:     2×2
  - 5–9:     3×3
  - 10–16:   4×4
  - 17+:     4×4 with horizontal scroll, sorted by recency
- Each tile is fixed aspect-ratio (terminal-shaped, ~80×24).
- Header strip: team name on the left, status pill on the right,
  uptime + last-activity timestamp underneath.
- Click anywhere on a tile → expand to full main area; the grid
  collapses to a mini strip on the side. Click expanded tile or
  hit Esc → return to grid.

**Status pill colors (per-team):**

- 🟢 active   — pane content changed in the last 60 s
- 🟡 idle     — pane unchanged for 60 s – 15 min
- 🟠 stale    — pane unchanged for >15 min (master watchdog
                threshold) — should already be triggering an
                escalation
- 🔴 error    — last captured frame contains a known error
                pattern (`error:`, `failed`, `Error:`, etc.)
- ⚫ ended    — session no longer in `subctl orch list`; tile
                shows last frame + "ended" overlay until removed

**Tile content rendering options:**

- **MVP**: ANSI-stripped tmux capture in a `<pre>` tile. Polled
  every 2 s. Loses color, terminal box drawing rendered as best-
  effort monospace. Simple, cheap.
- **Phase 2**: each tile hosts an `xterm.js` instance with a
  read-only attach to the tmux session via WebSocket. True
  terminal rendering, color, ligatures. Expensive in DOM but
  accurate. Switch to this once camera view ships and grid sizing
  is settled.

**API:**

```
GET /api/orchestration/captures
    ?lines=24                     # default 24 (one terminal screen)
    → { teams: [{
        name, status, last_activity_ts,
        capture: "string with ansi or stripped",
        cwd, account, uptime_s
      }, ...] }

GET /api/orchestration/captures/stream     (SSE)
    Pushes per-team frame updates as deltas. Each event:
    { team, ts, frame: "...", status }

GET /api/orchestration/<name>/attach       (read-only WS)
    For Phase 2 xterm.js tiles. Bi-directional disabled by default;
    write access gated by a separate "attach for input" toggle.
```

**Hot-keys (when expanded view is open):**

- `Esc` — collapse to grid
- `←/→` — cycle through teams (next/prev expanded)
- `↑` — scroll terminal scrollback
- `s` — toggle "send a message to this team" inline composer
        (calls `subctl orch send <name> "..."`)

**Sub-feature: a tile can be "pinned":**

Pinned tiles always render at the top-left of the grid even when
the team is idle. Useful when the operator wants to keep a specific
team in view while sorting others by recency.

**Polling cost:**

`tmux capture-pane` is essentially free server-side. The wire cost
is `lines × ~80 chars × team_count` per poll. 16 teams × 24 lines
× 80 chars × 0.5 Hz = ~15 KB/s — fine. SSE delta-only push would
cut that to <1 KB/s steady-state.

**Out of scope for first cut:**

- Audio "alerts" when a tile flashes 🔴. (Cute. Defer.)
- Per-tile resize / drag-rearrange of grid. Default order is
  recency-first; pinning handles most cases.
- Recording / replay of a tile (capturing frames over time and
  scrubbing back). High-value but separate feature; depends on
  Phase 2 xterm.js rendering being stable.
- Cross-team highlighting / "show me which tiles touched the same
  file in the last 5 min." Belongs in a different surface
  (dashboard ledger?), not the camera view.

**Acceptance:** with three teams running, navigate to the
Orchestration tab and see all three tiles updating roughly in
sync. Click one — it expands. Hit Esc — back to grid. Stop one of
the teams — its tile transitions to ⚫ ended within ~2 s.

### Phase 3n — In-browser Obsidian vault viewer (Perlite-inspired)

Operator request 2026-05-10: the "Open Vault Path" button on the
Projects tab spawns Obsidian locally, which is useless when subctl
is being driven remotely (dashboard + Telegram). Need an
in-browser vault viewer so any note in any vault is reachable from
the dashboard without ever opening a desktop app.

Reference: [Perlite](https://github.com/secure-77/Perlite) — a
PHP-based Obsidian vault viewer that's been stagnant ~2 years but
captured the right design pattern (server-rendered Markdown with
Obsidian-flavoured extensions: `[[wikilinks]]`, `![[embeds]]`,
callouts, tags, backlinks). Reimplement the *concept* with the
modern stack subctl already uses; don't fork the PHP.

**Stack (matches existing subctl conventions — no build step):**

- Backend: extend `dashboard/server.ts` (Bun + TypeScript). New
  endpoints under `/api/vault/`:
  ```
  GET  /api/vault/roots                  → configured roots from obsidian.json
  GET  /api/vault/<root>/tree            → folder tree, file index
  GET  /api/vault/<root>/note?path=…     → rendered HTML + frontmatter + backlinks
  GET  /api/vault/<root>/search?q=…      → full-text + filename + tag matches
  GET  /api/vault/<root>/backlinks?path  → notes linking TO this note
  GET  /api/vault/<root>/graph           → nodes + edges for graph view
  GET  /api/vault/<root>/asset?path=…    → image/pdf passthrough
  GET  /api/vault/<root>/stream          → SSE: vault file-watch events
  ```
- Markdown rendering server-side via `markdown-it` + small set of
  Obsidian-syntax plugins (rolled here, not pulled — Obsidian's
  markdown is documented and the surface is small):
  - `[[wikilink]]` and `[[wikilink|alias]]` → `<a href="?path=…">`
  - `![[embed.png]]` and `![[note]]` → inline image / inline note
  - `> [!note] Title` callouts → styled `<aside>` with theme class
  - `#tag` → `<span class="tag">` with click-to-search
  - `^block-id` → anchored fragment
  - YAML frontmatter parsed and surfaced as a metadata header
- Frontend: vanilla JS module under `dashboard/public/vault/`,
  loaded inside the dashboard's existing single-page shell. Three
  panes: file tree (left), rendered note (center), backlinks +
  outgoing-links + tag list (right). Resizeable splits.
- Search: server-side index built on first request per root,
  cached in-process, invalidated by SSE file-watch events.

**Where it slots into the dashboard:**

- "Memory" tab gets a sub-tab "Browse" showing the viewer pinned
  to the master's default vault root. Existing Memory stats stay.
- "Projects" tab's `Open Vault Path` button becomes
  `Open in Vault Viewer` → routes to
  `/dashboard#vault?root=<root>&path=<project>/decisions.md`.
- New top-level "Vault" tab when more than one vault root is
  configured. Switches roots via dropdown.

**Master integration:**

- New tool `vault_link(note_path: string, root?: string) → url`.
  Returns a deep-linkable dashboard URL the master can include in
  chat or Telegram messages. "I logged the decision — see
  https://192.168.100.98:8787/dashboard#vault?root=master&path=Down-Time-Arena/decisions.md".
- Existing `vault_append` is unchanged.

**URL contract (deep-linkable, Telegram-friendly):**

```
/dashboard#vault?root=<root-slug>&path=<rel-path>
/dashboard#vault?root=<root-slug>&path=<rel-path>&q=<search>
/dashboard#vault?root=<root-slug>&view=graph
```

The `#vault` hash route + query-string variant lets Telegram's
inline browser open it without round-tripping through subctl auth
(the dashboard's existing auth posture applies).

**Out of scope for first cut:**

- **Editing.** Read-only viewer. The master writes via
  `vault_append`; humans edit via the Obsidian desktop app
  whenever they're at the M3 Ultra. Don't dual-source edits.
- **Plugin parity.** Obsidian-specific plugins (Excalidraw,
  DataView, Templater) are not rendered. If a note relies on
  them, render the source as code-fenced and note that the
  preview is partial.
- **Live collaboration.** This is a viewer, not a doc editor.
- **Auth separate from the dashboard.** Anyone who can reach the
  dashboard sees every vault subctl knows about — same posture as
  every other dashboard tab. ACLs are a Phase 4+ feature.

**Acceptance:**

- Click "Open in Vault Viewer" on the Down-Time-Arena project →
  see `Down-Time-Arena/decisions.md` rendered in-page with
  wikilinks navigating to other notes, backlinks panel populated,
  tag list interactive.
- Edit a file in Obsidian on the M3 Ultra → SSE event fires →
  the open viewer refreshes the tree and (if the open note is
  the edited one) re-renders within 2 s.
- Master sends a Telegram message with a `vault_link()` URL → the
  recipient taps it → Telegram in-app browser shows the note.

**Why this also unblocks Phase 3l (attachments) UX:**

The attachments feature needs a place to *show* uploaded
documents. This viewer is that place. Attachments become
first-class notes in the master's vault when the operator wants
them durable.

### Phase 3o — Bake the operator's Claude config baseline into the repo

Operator request 2026-05-10 during the FOOTHOLD dogfood: a chunk
of the customizations subctl actually depends on live in the
operator's `~/.claude/` and have never made it into the repo. New
subctl installs (e.g., the M3 Ultra) get the worker scaffolding
but miss the operator's hooks, skills, sub-agents, slash commands,
and crucial settings. Audit confirms the gap.

**What ships TODAY (already in repo, installed via `subctl install`):**

- `providers/claude/statusline.sh` — radar bar
- `providers/claude/dispatch-check.sh` — pre-prompt readiness gate
- `providers/claude/hooks/log-rate-limits.sh` — Stop hook (rate-limit
  event detection)
- `providers/claude/commands/dispatch-check.md` — the `/dispatch-check`
  slash command
- `lib/radar.sh` (linked as `signals.sh`) — radar signal source
- settings.json keys: `statusLine`, `hooks.Stop`,
  `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
  per-account team-pane wiring

**What's on the operator's laptop and SHOULD ship in repo
(per-account install material):**

- **Skills (critical for worker behaviour)** — `subctl`,
  `orchestrator-mode`, `autonomy`, `damage-control`, `tdd`,
  `triage`, `to-issues`, `to-prd`, `diagnose`, `find-docs`,
  `context-audit`, `improve-codebase-architecture`. The first two
  especially: a worker spawned via subctl that doesn't have the
  `subctl` skill or `orchestrator-mode` skill won't understand the
  team protocol it's running inside.
- **Slash commands** — `/commit`, `/code-review`, `/security-review`,
  `/ai-slop-cleaner`, `/team`. Workers actively invoke these.
- **Sub-agents** — `bug-analyzer`, `code-reviewer`, `dev-planner`,
  `story-generator`, `ui-sketcher`. The agent definitions for
  parallel-decomposition work.
- **Settings defaults**:
  - `permissions.defaultMode: "bypassPermissions"` (autonomous
    workers must not prompt for every tool call)
  - `permissions.deny: [Read(**/node_modules/**), Read(**/.next/**), …]`
    (prevents context blow-up from indexing build artefacts)
  - `env.CLAUDE_AUTONOMY: "full"` for worker accounts
  - `env.PATH: …` extension so workers find the tools subctl
    installs (bun, lms, codex, coderabbit) without relying on
    inheritance from a login shell

**What stays user-personal (NEVER ships in repo):**

- `~/.claude/CLAUDE.md` — the operator's personal instructions,
  domain knowledge, infra description. Per-operator. Never.
- `~/.claude/scripts/switch-claude-token` — the operator's token
  rotation tool. Out of scope.
- Operator-specific skills like `caveman`, `llm-council`,
  `prod-db-surgical`, `setup-matt-pocock-skills`. Personal toolkit.
- API keys, OAuth credentials, MCP endpoint configs. Never.

**Where the shipped material lives in the repo:**

```
providers/claude/baseline/
├── skills/
│   ├── subctl/SKILL.md
│   ├── orchestrator-mode/SKILL.md
│   ├── autonomy/SKILL.md
│   ├── damage-control/SKILL.md
│   ├── tdd/SKILL.md
│   ├── triage/SKILL.md
│   ├── to-issues/SKILL.md
│   ├── to-prd/SKILL.md
│   ├── diagnose/SKILL.md
│   ├── find-docs/SKILL.md
│   ├── context-audit/SKILL.md
│   └── improve-codebase-architecture/SKILL.md
├── commands/
│   ├── commit.md
│   ├── code-review.md
│   ├── security-review.md
│   ├── ai-slop-cleaner.md
│   └── team.md
└── agents/
    ├── bug-analyzer.md
    ├── code-reviewer.md
    ├── dev-planner.md
    ├── story-generator.md
    └── ui-sketcher.md
```

**`subctl_settings_install_claude_dir` extended to:**

1. Symlink each `providers/claude/baseline/skills/<name>/SKILL.md`
   into `<cfg_dir>/skills/<name>/SKILL.md`
2. Same for `commands/` and `agents/`
3. Merge the new settings keys into `<cfg_dir>/settings.json`:
   - `permissions.defaultMode = "bypassPermissions"` (only if not
     already set — don't override operator preference)
   - `permissions.deny` — append the deny patterns the operator
     hasn't already added (set-difference union, not replace)
   - `env.CLAUDE_AUTONOMY = "full"` (only for non-default cfg dirs;
     `~/.claude` keeps whatever the operator put there)

**`subctl doctor` extended to:**

- New section "Skills installed" — tally of which baseline skills
  are present in each cfg_dir. Yellow if any are missing; suggests
  `subctl install` to repair.

**Audit step before shipping (must do before committing baseline):**

For each candidate skill / command / agent in the operator's
laptop ~/.claude/, manually inspect:

- Does it contain operator-specific paths or accounts?
  → Generalize before shipping.
- Does it reference secrets, internal hostnames, real customer
  names?
  → Strip before shipping or refuse to ship.
- Does it contain content the operator would not want public?
  → Refuse to ship; flag for reuse-with-edits.

This is NOT an automated dump. Each file gets read, sanitized,
and approved before it lands in the repo.

**Acceptance:**

- Fresh subctl install on a clean Mac → `subctl install` runs →
  every Claude cfg_dir has the baseline skills/commands/agents
  symlinked + the settings keys merged.
- Worker spawned via the master on the new install correctly
  invokes the `subctl` skill (verifiable: ask the worker "what
  skills do you have" and `subctl` appears in its reply).
- Operator's personal customizations on the existing laptop
  remain untouched (no destructive overwrites).
- `subctl doctor` reports skills-installed tally per cfg_dir.

**Out of scope for first cut:**

- A "user can opt out per-skill" UI. Phase 1 ships the full
  baseline; opt-out via deleting the symlink locally.
- Versioned skill upgrades. Phase 1 ships static content; if a
  baseline skill changes upstream, `subctl install` overwrites
  the symlink (fine — they're symlinks, no destructive edits).
- Pulling in the `~/.claude/plugins/` marketplace state. Plugins
  are managed by `npx claude-mem install` and similar; subctl
  doesn't replicate that surface.

### Backlog (non-blocking)

- Rename the dashboard's `detached` team-status label to
  `running · headless` or similar. Operators interpret "detached"
  as broken when it actually means "no terminal is currently
  attached, work continues fine" — flagged 2026-05-10.
- Master skill needs an explicit nudge to call `notify_dashboard`
  on milestone events. The notifications sidecar in the chat
  panel is empty during real dogfood runs because the master
  never publishes — diagnosed 2026-05-10. Add to master SKILL.md
  the rule: "On Milestone-X-complete, call notify_dashboard with
  kind=milestone."

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
