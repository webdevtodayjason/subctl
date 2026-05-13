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
| `dashboard/public/tool-display.json` | v2.7.12 — family/color/icon map + name-prefix rules consumed by the Chat panel to render tool calls as inline neon-glow pills instead of full-width cards |
| `dashboard/notify-listener.ts` | Separate from master — handles the legacy operator-notify flow (subctl notify ask-yesno etc.) |

**Chat tool-call rendering (v2.7.12).** Inline neon-glow pills replace
the legacy full-width "TOOL · ..." cards. Each pill is family-colored
per `dashboard/public/tool-display.json`, has a one-line truncated arg
preview (empty `{}` is suppressed entirely), and is click-to-expand
for full args + result. Pills appear live as SSE `toolcall_start`
events arrive so the operator sees master fetching tool after tool.
While waiting for the first SSE event of a turn, a pulsing
`evy · thinking` indicator sits between the user bubble and where the
assistant turn will appear.

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

#### Plan approvals (v2.7.29)

The lead can ALSO route a worker's `plan_approval_request` to the operator by appending an event of type `plan-approval-request`:

```jsonc
{
  "ts": "2026-05-13T12:34:56Z",
  "type": "plan-approval-request",
  "request_id": "abc-123",
  "worker_name": "profiles-impl",
  "plan_summary": "Refactor profile loader to use new schema",
  "plan_body": "1. Move config\n2. Add tests\n3. ..."
}
```

Master records the request in the pending-approvals queue (`~/.local/state/subctl/plan-approvals.jsonl`) and emits a `severity:"alert"` notification — the dashboard tray and the operator's Telegram both surface it. The operator decides from:

- **Dashboard Plans tab** — `[Approve]` / `[Reject]` (with feedback modal) per pending card.
- **Telegram** — `/plans`, `/plans approve <id-prefix>`, `/plans reject <id-prefix> <feedback>`.

The decision is forwarded back to the team lead via the HMAC-authenticated dashboard `/msg` route as a `[plan_approval_response]` line (worker echoes `request_id`, sets `approve=true|false`, includes feedback when rejected). Pending entries auto-reject with feedback `"auto-expired"` after 60 minutes; the operator can re-request from the worker if they still want the work.

The queue endpoints (proxied by the dashboard under `/api/plan-approvals/*`):

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/plan-approvals`                    | —             | `{ ok, pending, decided }` |
| `POST` | `/plan-approvals/:id/approve`        | —             | `{ ok, approval }` |
| `POST` | `/plan-approvals/:id/reject`         | `{ feedback }`| `{ ok, approval }` |
| `POST` | `/plan-approvals/expire`             | —             | `{ ok, expired }` (manual sweep; the watchdog runs every 5 min) |

**Security note:** `plan_body` may contain secrets a worker pasted into its plan. Master never logs the body to stderr at the default level — only a short summary preview. The on-disk JSONL log lives under XDG_STATE_HOME (or `~/.local/state`) and inherits the operator's umask.

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

### 3.4.1 Evy Memory (Tier 3) — v2.7.23+

Distinct from §3.4 ("compactable transcript", which is the in-process agent state pi-agent-core works on). Evy Memory is the **persistent, queryable record of what was said, decided, and shipped between operator and Evy across sessions** — the load-bearing fix for "51st date syndrome": when the master daemon is restarted tomorrow, the last things Evy remembers come from this store.

**Substrate.** Native TypeScript module backed by `bun:sqlite` with FTS5. See [ADR 0014](adr/0014-evy-memory-ts-port-of-memori.md) for the substrate decision (supersedes [ADR 0006](adr/0006-memori-byodb-sqlite-for-tier-3.md) which named the Python Memori SDK). DB path: `~/.local/state/subctl/memory/evy.db` (chmod 600, parent dir chmod 700). The file never egresses without operator action; egress surfaces (Telegram, dashboard) pass entries through a redaction helper that masks `sk-*` keys, `Bearer …` tokens, 64-char hex blobs (HMAC marks per the v2.7.20 trust-marker), and `hmac:<team>:<hex>` structured marks.

**Schema.**

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  team_id TEXT,          -- null = Evy-global; set = team-scoped
  role TEXT NOT NULL,    -- system | user | assistant | tool | event
  kind TEXT NOT NULL,    -- message | tool-call | notification | shipped | decision | operator-note | evy-note | synthetic-prompt
  content TEXT NOT NULL,
  metadata_json TEXT
);
CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, content);
-- Triggers keep entries_fts in sync with entries.
-- Indices: idx_entries_ts, idx_entries_team_kind, idx_entries_kind.
```

Inspired by Memori's `memori_conversation_message` (role + content + timestamps + scope). Memori's broader entity-fact knowledge-graph layer (subject/predicate/object triples, embeddings, entity_fact extraction) is intentionally NOT replicated in v1 — it requires LLM-driven extraction and is queued as a v2 enhancement.

**API (`components/master/memory.ts`).**

- `recordEntry({ role, kind, content, team_id?, metadata? })` — append. Content >16 KB is truncated with a searchable mark.
- `recallEntries({ query?, team_id?, kind?, since?, limit? })` — search. FTS5 with bm25 ranking when a query is provided; LIKE fallback when FTS5 isn't compiled in. Multi-token AND semantics with prefix matching by default; raw FTS5 syntax (`"exact phrase"`, `foo OR bar`) is honored.
- `recentEntries(limit?)` — newest-first slice.
- `purgeBefore(iso)`, `deleteEntry(id)` — operator surfaces.
- `memoryStats()` — count / oldest_ts / newest_ts / bytes / fts5 / path. Used by the dashboard tray.
- `redactForEgress(s)` / `redactEntryForEgress(e)` — egress masking helpers.

**Capture (turn boundaries, wired in `server.ts`).** Every operator-Evy turn writes:

- User message → `role:"user", kind:"message"` (or `event/synthetic-prompt` for watchdog/verifier re-entries).
- Assistant response → `role:"assistant", kind:"message"` (skipped for synthetic re-entries).
- Tool call → `role:"tool", kind:"tool-call"`, content = `tool_name(short_args)`.
- Notification emitted → `role:"event", kind:"notification"`, severity + body in metadata.

Failures are swallowed and logged to stderr — memory never blocks an operator reply.

**Recall surfaces.**

- **Evy's tools.** `evy_recall(query?, team_id?, kind?, since_days?, limit?)` and `evy_remember(content, kind?, team_id?)`. Tool descriptions name the Tier 3 vs Tier 4 distinction so Evy routes between Evy Memory (operator-Evy chat) and `memory_search` (claude-mem cross-session observation corpus, [ADR 0010](adr/0010-claude-mem-stays-parallel.md)).
- **Dashboard.** `GET /api/memory/search`, `/api/memory/recent`, `/api/memory/stats`; `POST /api/memory/entries`; `DELETE /api/memory/entries/:id`. Subpath-only so the existing `/api/memory` (Obsidian vault status) route is untouched. Memory tab has an "Evy Memory" card with search + kind filter + recent + per-entry forget.
- **Telegram.** `/memory <query>` (top 3 matches), `/memory recent` (last 5), `/remember <text>` (save kind=operator-note).

**Tier 4 boundary (preserved).** This module reads zero claude-mem state. The Tier 4 tools (`memory_search`, `memory_timeline`, `memory_observations`, `memory_health`) keep working unchanged; they query the claude-mem worker at `localhost:37701` per `components/master/tools/memory.ts`. The persona surfaces both — Evy chooses based on whether the operator's question is about the conversation (Tier 3) or about Claude Code work history across sessions (Tier 4).

### 3.5 Provider abstraction (future, Phase 3f+)

Hermes separates `MemoryProvider` (tier 2) from `ContextEngine` (tier 3 compaction). We've conflated them. If/when we want pluggable memory backends (Honcho, Mem0, Supermemory), we should split:

- `MemoryProvider` interface: `prefetch(query)`, `sync_turn(user, asst)`, `system_prompt_block()`, `get_tool_schemas()`, `handle_tool_call()`
- `ContextEngine` interface: `should_compress()`, `compress(messages, target)` — already implicitly the case in our compact.json + watchdog

For now: claude-mem is hardcoded as the tier-2 provider. No pluggability needed yet.

### 3.5b Pi-mono upstreams + provider catalog (v2.7.24+)

Subctl depends on the [mitsuhiko/pi-mono](https://github.com/mitsuhiko/pi-mono) monorepo via two npm packages, both first-class upstreams (ADR 0015):

| pi-mono dir | npm package | role |
|---|---|---|
| `packages/agent` | `@earendil-works/pi-agent-core` | **agent runtime** — drives master's `Agent` loop, tool registry, streaming, attachment handling |
| `packages/ai` | `@earendil-works/pi-ai` | **provider catalog** — what LLM providers exist, factory shapes, generated per-provider model lists |

Both are pinned with `^` in `components/master/package.json` so `bun install` resolves to the latest published `0.x.y` on every deploy. **Always-latest policy:** subctl's release process must update both to their most-recent versions on every minor/patch release. v2.7.25 will add an auto-tracker watchdog that surfaces upstream bumps as `severity:"info"` notifications.

**How the provider catalog is populated.** The dashboard's Providers tab used to ship a hand-curated dropdown (`claude / openai / gemini / zai / minimax`, three flagged `(future)`). Starting in v2.7.24 the list is dynamic, sourced from `@earendil-works/pi-ai` via the catalog adapter at `components/master/pi-ai-catalog.ts`:

- `listCatalogProviders()` calls pi-ai's `getProviders()` (~31 providers today: anthropic, openai, openai-codex, azure-openai-responses, google, google-vertex, amazon-bedrock, mistral, groq, cerebras, xai, openrouter, vercel-ai-gateway, deepseek, fireworks, cloudflare-workers-ai, cloudflare-ai-gateway, minimax + minimax-cn, moonshotai + moonshotai-cn, kimi-coding, zai, huggingface, opencode + opencode-go, xiaomi variants, github-copilot, …).
- Each entry is annotated with a human display name + auth-method hint (`api-key` / `oauth`) from the local `PROVIDER_META` table inside the adapter. Anything pi-ai adds upstream that we haven't met yet shows up with a Title-Case fallback name + `api-key` default until we add an override entry.
- `GET /api/providers` walks the catalog, attaches matching `accounts.conf` profiles (resolving legacy ids via `SUBCTL_TO_PI_AI`), and returns the merged shape: `{id, display, kind, auth_method, model_count, profiles, legacy_alias, note}`.

**How to add a profile for a new provider.**

1. Open the dashboard → Providers tab → **+ New Profile**.
2. The dropdown lists every pi-ai provider, sorted with providers-that-already-have-profiles first. OAuth providers are tagged `(OAuth)`.
3. Pick the provider, fill in alias + email + config dir, save. The dashboard validates against the pi-ai catalog (rejects typos with a 400).
4. For API-key providers, set the corresponding env var (e.g. `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`) or paste the key via the Settings panel. The master daemon resolves keys via `components/master/secrets.ts`.
5. For OAuth providers (Anthropic / OpenAI Codex today), run `subctl auth claude <alias>` or `subctl auth openai <alias>` after creating the profile. Other OAuth providers (GitHub Copilot, xAI) are queued for a follow-up — operators can still use API-key auth for them in v2.7.24.

**Backwards compat: the alias table.** Subctl's historical names (`claude`, `gemini`, `pi-coding-agent`) predate pi-ai. The adapter maps them: `claude → anthropic`, `gemini → google`, `pi-coding-agent → anthropic`. Both the legacy and canonical forms are accepted on POST. The form field stores the legacy alias when one exists so `accounts.conf` stays human-readable.

**What stays the same.** Pi-agent-core's role as the agent runtime is unchanged in v2.7.24 — the master daemon still imports `Agent` and drives the agent loop exactly as before. The integration glue under `providers/<name>/` (tmux launchers, OAuth helpers) is unchanged. The v2.7.24 change formalises both pi-mono packages as tracked upstreams + finally consumes pi-ai's catalog from the dashboard.

### 3.5c Upstream tracking (v2.7.25 Scope C)

v2.7.25 closes the enforcement gap on ADR 0015's always-latest policy. A new watchdog — `upstream-check`, registered in the same registry the operator's `/watchdogs` kill command sees — polls npm for `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` every 6 hours.

**How it works.**

1. Read `components/master/package.json` for the floor-pinned versions (`^0.74.0` → `0.74.0`).
2. Fetch each package's `dist-tags.latest` from `https://registry.npmjs.org/<package>`.
3. Classify the bump as `same` / `patch` / `minor` / `major` via a small in-house semver parser (`parseSemver` + `classifyBump` in `components/master/upstream-check.ts`).
4. Newer → emit notification. `severity:"info"` for patch/minor, `severity:"warn"` for major (per ADR 0015: `^` won't cross the major boundary on its own; majors go through manual review). Notification metadata: `{package, from, to, bump_kind}` — flows through to the dashboard's Copy-prompt button so the operator can hand the LLM a structured "should I update this?" prompt with one click.

**Manual mode (default).** Notification only. The operator reviews, runs `bun install` and `bun test` by hand, commits, pushes.

**Auto-update gate.** Create the flag file `~/.config/subctl/auto-update-upstreams.enabled` (any file at that path is sufficient — `touch` is the canonical activation) to let the watchdog ATTEMPT the upgrade itself on each tick:

1. Write the new pin (preserving `^` / `~`) into `components/master/package.json`
2. `bun install` in `components/master/`
3. `bun test` in `components/master/`
4. Tests pass → `severity:"info"` notification "pi-ai auto-updated 0.74.0 → 0.75.0 (tests passing)". Operator reviews the diff and commits + pushes manually.
5. Tests fail → revert `package.json` + `severity:"alert"` notification "pi-ai auto-update 0.74.0 → 0.75.0 failed tests; reverted".

**The watchdog never auto-commits and never auto-pushes.** The operator's eyeball on the diff is the explicit gate. The fact that something went into git history needs to be a conscious operator decision — not a side effect of a 6-hour cron.

**Operator surfaces:**

- **Dashboard.** The Memory tab carries an "Upstreams" card showing current pinned versions, the most-recent check timestamp, and a "Check now" button (POSTs to `/api/upstreams/check`, runs one tick on demand).
- **Telegram.** `/upstreams` replies with the current pinned versions + latest check result + auto-update-gate state.
- **API.** `/api/upstreams` (GET state) and `/api/upstreams/check` (POST manual tick) on the dashboard proxy through to the master.

**Notification kinds added:** `upstream-available`, `upstream-auto-updated`, `upstream-update-failed`, `upstream-check-error`. All flow through the same v2.7.22 ring buffer + SSE stream + dashboard tray.

### 3.5d Notification system (v2.7.25 UX)

v2.7.22 shipped the master-side notification channel (ring buffer + SSE stream + Telegram push for `severity:"alert"`). v2.7.25 reshapes the dashboard surface after operator feedback that the v2.7.22 panel rendered always-on and could not be collapsed or dismissed.

**Topbar.** A single Lucide `inbox` icon. Click to open a dropdown showing the last 20 notifications. Badge count reflects unread only; the icon ring goes red when an unread `severity:"alert"` is present.

**Toasts (live arrivals).** New SSE-driven toast stack in the top-right corner. Slides in from the right, holds ~5s (8s for `severity:"alert"`), then slides back + fades. Up to 3 visible — older ones drop as new ones arrive. Each toast carries the severity icon + title + truncated body + manual close.

**Dropdown row.** Severity icon (Lucide `info` / `alert-triangle` / `alert-octagon`), title, truncated body (full body on hover via `title="…"`), relative timestamp, per-row `[×]` dismiss (Lucide `x`). For `severity:"warn"` / `"alert"` and kinds matching `error|failed|fail|unresponsive|vanished|circuit-breaker|tripped|denied|stuck` a `[clipboard] Copy prompt` button appears. Click → copy a structured prompt to clipboard:

```
Notification (severity: alert): <title>

<body>

Context:
- Team: <team_id if any>
- Time: <ts>
- Kind: <kind>
- Metadata: <JSON of metadata>

Please suggest a fix or appropriate escalation.
```

A brief "Prompt copied" toast confirms. The structured shape pastes into any LLM (Claude, ChatGPT, the operator's local supervisor) with predictable context.

**Read semantics.** Read notifications stay visible at 0.55 opacity until the operator explicitly dismisses them via `[×]`. The bell badge counts unread only. "Mark all read" stays in the dropdown header.

### 3.5e Icon library (ADR 0016)

`dashboard/public/icons.js` exposes `icon(name, opts?)` — a static-baked SVG helper using Lucide v0.474.0 (MIT). The `lucide` npm dep is the source-of-truth checksum; the runtime serves only `public/*` files verbatim (no build step). Adding a new icon: copy the SVG path body from `dashboard/node_modules/lucide/dist/esm/icons/<name>.js` into the `ICONS` table in `icons.js`. See ADR 0016 for the full audit + what's deliberately NOT replaced (tool-family content icons, sidebar nav geometric glyphs, verdict 🟢🟡🔴 indicators).

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

### Phase 3o — Policy engine (Trusted/Gated/Sealed) (complete — v2.7.0 2026-05-11)

v2.7.0 ships the per-worker policy engine with three execution modes
decided at spawn time: **Trusted** (unrestricted bash, opt-in),
**Gated** (default — `PreToolUse` hook routes every `Bash`
invocation through `subctl policy check` against a TOML allowlist),
**Sealed** (no bash, MCP-only tool set). The canonical spec lives
at [`docs/policy.md`](./policy.md); the schema at
[`docs/policy-schema.md`](./policy-schema.md). The default mode
flip (Trusted → Gated for `subctl teams claude`) is the headline
change; defang (`bypassPermissions` + `--dangerously-skip-permissions`
+ `CLAUDE_AUTONOMY=full`) stays in all three modes — the hook is
additive, never replacement.

Tracking: 15-PR sequence in `.orchestration/HANDOFF_DIGEST.md`.

### Phase 3o.1 — Self-diagnostic tools (v2.7.1 polish)

After v2.7.0 shipped, the M3's master daemon hit a watchdog bug
firing on a stale tmux session. The agent reflected, identified
what would have caught the bug, and proposed 7 self-diagnostic
tools via Telegram. The operator added an 8th (version status).
All 8 ship in v2.7.1 at `components/master/tools/diag.ts`:

- `system_watchdog_self`, `system_port_check`, `system_lmstudio_health`,
  `system_log_tail`, `system_rate_limit_status`, `system_git_status`,
  `system_network_health`, `system_version_status`

This is the persistent-supervisor loop working as designed:
agent hits a failure mode, asks for capability, capability ships.

### Phase 3o.2 — Web + self-introspection + Linear (v2.7.2)

Hours after v2.7.1 shipped, the M3 agent surfaced three live
capability gaps over Telegram: it couldn't search the web, it didn't
know its own model + context budget, and it couldn't see (let alone
update) the Linear board the operator runs subctl development from.
The operator funded all three on the spot. **Seven new master tools**
land in v2.7.2 across two new files and one extension to the diag
family:

**Web** (`components/master/tools/web.ts`, read-only):

- `web_search` — Brave AI Search (query → results). `BRAVE_API_KEY`.
- `web_fetch` — Firecrawl scrape (URL → markdown). `FIRECRAWL_API_KEY`.

**Self-introspection** (added to `components/master/tools/diag.ts`):

- `system_supervisor_info` — reads `providers.json` (supervisor role),
  hits LM Studio's `/api/v0/models` for `loaded_context_length` /
  `max_context_length` / `state` / `quantization` / `arch`, and
  surfaces the auto-compact policy from `compact.json` (defaults if
  absent). The agent uses this to reason about its own context budget.

**Linear** (`components/master/tools/linear.ts`, GraphQL):

- `linear_list_issues`, `linear_search` — read paths (filter / search).
- `linear_create_issue`, `linear_update_issue` — **write** paths
  (issue creation; state change + comment posting). `LINEAR_API_KEY`,
  raw token (no "Bearer" prefix — Linear's convention).

All keys live in the master daemon plist's `EnvironmentVariables`.
Missing keys return structured errors with `launchctl kickstart`
hints; HTTP failures (4xx/5xx/429/timeout) all surface structured
errors with `retry_after` on rate limits — tools never throw.
Dashboard `/api/settings/keys` gains matching presence rows for
each. Master tool count: 62 → **69**.

### Phase 3o.3 — Compact correctness (v2.7.3)

A few hours after v2.7.2 tagged, the operator caught the master
hallucinating "Standing by" responses to questions it couldn't see.
Diagnosis: the 5-minute auto-compact ticker had fired AFTER the
supervisor was already past 100% util on its next prompt. The ticker
was the wrong design — a polling watchdog can't keep a synchronous
prompt-composition pipeline under budget. v2.7.3 fixes it.

**Just-in-time gate.** `runJitCompactCheck()` runs at the top of
`processOnePrompt()` — BEFORE `composeSystemPrompt()` and BEFORE
`agent.prompt()`. The supervisor never sees an over-budget window
during normal operation.

**Two-stage policy** (absolute tokens, predictable regardless of
loaded model):

- `warn_tokens = 25000` → YELLOW banner + `compact_warning` SSE.
- `compact_tokens = 40000` → AUTO-COMPACT fires synchronously.
- `target_tokens = 30000` → post-compact estimated transcript size.
- `keep_recent = 6` → minimum recent turns preserved intact.

**Pure decision module** at `components/master/compact-policy.ts`:
`decideCompactAction(currentTokens, loadedCtx, cfg)` returns
`{action, current_tokens, threshold_used, reason}`. Tested in
isolation — 26 tests in `components/master/__tests__/compact-policy.test.ts`.

**Back-compat for `threshold_pct`.** Deployed `compact.json` files
in the wild still carry the v2.7.2 percentage shape. When absolute
thresholds are absent, the decider falls back to compact-at-pct,
warn-10pp-below. New deploys ship with absolute thresholds.

**5-min ticker demoted to safety-net.** Still runs every 5 minutes
using the same `decideCompactAction`, but its only job now is to
catch transcripts that grow due to tool outputs landing AFTER prompt
composition (the JIT gate can't see those).

**New master endpoint:** `GET /transcript/util` → util snapshot for
the dashboard banner. The 4-state banner (ok / warn / compacting /
overflow) reads it instead of recomputing thresholds in JS.

Canonical: `components/master/compact-policy.ts`,
`components/master/server.ts` `runJitCompactCheck()` (around line 922),
`dashboard/public/app.js` `refreshContext()` + `compact_warning` SSE
handler.

### Phase 3o.4 — LM Studio token + secrets layer (v2.7.4)

LM Studio shipped an optional **"Require API Token"** server
setting. Operators who flip it on get a
`sk-lm-XXXXXXXX:YYYYYYYYYYYY`-shaped bearer that every request to
the box must carry as `Authorization: Bearer <token>`. Before
v2.7.4 the master daemon sent a `"not-needed"` sentinel for
`lmstudio` (the v2.7.3 path) and hit 401 the moment the operator
enabled the toggle. v2.7.4 closes the gap **and** generalizes the
fix: a dashboard-managed secrets layer at
`~/.config/subctl/secrets.json` holds LM Studio + Brave + Firecrawl
+ Linear + Context7 keys, with an env-var override on top so the
launchd plist remains the source of truth for CI / power users.

**Priority chain.** Every credential resolves through:

1. Process env var (e.g. `LMSTUDIO_API_TOKEN` from the launchd
   plist `EnvironmentVariables`) — power users / CI.
2. `~/.config/subctl/secrets.json` field (e.g.
   `lmstudio_api_token`) — managed via the dashboard.
3. Absent → caller behaves as today (e.g. `lmstudioAuthHeader()`
   returns `{}`, pi-ai gets the `"not-needed"` sentinel).

**`components/master/secrets.ts`** (NEW) — pure module exporting
`loadSecret(key)`, `setSecret(key, value | null)`, `listSecrets()`,
`resolveSecret(key)`, `envVarFor(key)`, plus a `SECRET_KEYS`
allow-list. Atomic writes (tmp + rename), `chmod 0600` on every
write, 5-second in-memory read cache invalidated on mtime change.
Malformed JSON / missing file / wrong-type fields fall back to an
empty map without throwing — a bad `secrets.json` MUST NOT crash
the daemon.

**One helper, eleven call sites.** `lmstudioAuthHeader()` returns
`{Authorization: "Bearer <token>"}` when the priority chain finds
a token and `{}` when it doesn't. Lives in
`components/master/server.ts`, mirrored in
`components/master/tools/diag.ts` and `dashboard/server.ts` (all
three now route through `resolveSecret("lmstudio_api_token")`).
Threaded onto:

- `components/master/server.ts` (6): `ensureModelLoaded` (probe +
  unload + load), `getSupervisorLoadedCtx`, the `/transcript/util`
  inline probe.
- `components/master/tools/diag.ts` (3): `system_lmstudio_health`
  (`/v1/models` + `/v1/chat/completions`) + `system_supervisor_info`
  (`/api/v0/models`).
- `dashboard/server.ts` (2): `/api/models`, `/api/providers`.

**Tool key resolution updated.** `web_search` / `web_fetch` /
`linear_*` / `context7_*` master tools now resolve their API keys
via the priority chain too — same one-liner `resolveSecret(<key>)`
swap. Error messages now mention BOTH paths (dashboard panel OR
plist).

**Dashboard endpoints.**

- `GET /api/settings/secrets` — returns presence flags +
  last-modified for every known key. Values **never** appear in
  the response (pinned by a test).
- `POST /api/settings/secrets/:key` — body `{ value: string |
  null }`. Allow-listed against `SECRET_KEYS`. Returns the
  updated presence row, **not** the value.
- `GET /api/settings/keys` extended — each row carries `env`
  (boolean) + `secrets_json` (boolean | null), so the operator
  sees both paths at a glance.

**Dashboard UI.** New "API tokens" card above the cloud-providers
card. Renders a table with status pills (`Set`/`Not set`, plus an
`env override` chip when the env var is present) + last-modified +
Edit/Set button. Clicking opens a modal with a `type="password"`
input + Save / Cancel / Remove. The dashboard request stays on
`127.0.0.1` (dashboard is localhost-bound). On modal close the
input is wiped from the DOM.

**Security contract** (non-negotiable, broken by any single
counterexample):

- `secrets.json` values NEVER appear in any HTTP response body.
- `listSecrets()` returns presence flags only — pinned by a test
  asserting the literal token bytes don't appear in
  `JSON.stringify(rows)`.
- `chmod 0600` on every write — pinned by two tests (first write
  + subsequent write).
- `.gitignore` blocks `secrets.json` by name. Canonical path is
  `~/.config/subctl/secrets.json`, outside the repo.

**Back-compat trip wires.** When neither layer has the token,
`ensureModelLoaded` emits **no** `Authorization` header on any of
its three calls, and `getApiKey` returns `"not-needed"` exactly as
in v2.7.3. Empty-string env / empty-string file field are both
treated as unset. Existing deploys without LM Studio token auth
must keep working unchanged.

Canonical: `components/master/secrets.ts` (pure module),
`components/master/server.ts` `lmstudioAuthHeader()` +
`getApiKeyForProvider()` (exported for tests),
`components/master/tools/{diag,web,linear,context7}.ts` (all
routed through `resolveSecret`), `dashboard/server.ts`
`/api/settings/secrets[/:key]`, `dashboard/public/` HTML/CSS/JS,
`components/master/__tests__/secrets.test.ts` (39 tests / 89
assertions).

### Phase 3o.5 — `subctl update` UX (v2.7.5)

Two narrow operator-facing improvements to `lib/update.sh`. Both
came out of dogfooding v2.7.4 across the fleet: operators were
typing `subctl update`, getting a "working tree has uncommitted
changes" abort with no version context, and then re-typing
`subctl update --force` only to discover the dirt was a `bun.lock`
rewrite they didn't make.

**Version-state block printed BEFORE the working-tree gate.** The
dirty-tree abort historically hid the very thing the operator
wanted to know. v2.7.5 runs `git fetch` (read-only at the
working-tree level — only updates remote-tracking refs) up front
and prints a 4-line block before any cleanliness gate fires:

```
==> subctl update — version state
    current: v2.7.4 (74ae7ae7)
    branch:  main
    remote:  v2.7.5 (abcd1234) — 1 commits ahead
```

Render modes: `same — already up to date` (fast-exit 0); `<N>
commits ahead` (behind, proceed); `local is <N> commits AHEAD of
remote` (operator dev branch, ff-only no-ops); `diverged (<X>
ahead / <Y> behind)` (genuine divergence, ff-only fails). Even
when the cleanliness gate aborts, the version block is on screen.

**Lockfile-only auto-stash.** `bun.lock` rewrites itself with
platform-specific hashes on every `bun install`. Operators were
typing `--force` repeatedly across machines for genuinely expected
drift. v2.7.5 introduces a NARROW carve-out: when EVERY dirty file
is a known package-manager lockfile (`bun.lock`, `bun.lockb`,
`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` — and ONLY
those, not `Cargo.lock` / `Gemfile.lock` / `poetry.lock`), the
update auto-stashes those files silently and restores after.
`--force` semantics are preserved exactly — it remains the escape
hatch for any other dirty file.

**Extracted helpers** (sourceable for tests):
`_subctl_update_is_lockfile`, `_subctl_update_classify_dirty`
(emits `clean` / `lockfile-only|<csv>` / `mixed|<n>`),
`_subctl_update_pop_stash` (kind-aware messaging plus structured
guidance on lockfile pop conflicts).

Canonical: `lib/update.sh` (helpers + new flow in `subctl_update`),
`lib/__tests__/update.test.ts` (36 tests / 79 assertions across
the pure helpers + integration against hermetic temp git
origin/clone pairs).

### Phase 3o.6 — `subctl update` argent-style polish (v2.7.6)

Operator review of `argent update --help` set the bar: a polished
update flow has a read-only status probe, a persisted channel
concept, a JSON output mode for automation, distinct knobs for
"auto-confirm" vs "auto-stash", per-step timeouts, and a `--help`
that reads like docs instead of a flag dump. v2.7.6 adds all of
those to `subctl update` without disturbing the v2.7.5 version-state
block or lockfile auto-stash.

**Six additions, all to `lib/update.sh`:**

1. **`subctl update status`** — read-only subcommand. Runs the same
   fetch + version-block logic but never advances to merge/stash.
   Works on dirty trees (where `update` would abort), so it's the
   right first move when the operator isn't sure what state the
   host is in.

2. **`--channel stable|beta|dev`** — persists under
   `[update].channel` in `~/.config/subctl/config.toml` via a
   small awk-based TOML rewriter. Mapping: `stable→main`,
   `beta→beta`, `dev→dev`. `-b/--branch` still wins for one-off
   branch tests.

3. **`--json`** — single-document end-of-run output, all human log
   lines suppressed. Success doc carries
   `from/to/channel/commits_applied/lockfile_stashed/services_restarted/doctor_warnings`;
   error doc carries `error/stage` where stage is one of
   `preflight|fetch|merge|deps|restart|doctor`.

4. **`--yes`** (independent of `--force`) — auto-confirms the new
   downgrade prompt (`remote_version < current_version` asks
   "proceed with downgrade? [y/N]"). Non-interactive shells without
   `--yes` refuse downgrades instead of silently regressing.

5. **`--timeout <secs>`** (default 1200) — wraps fetch / merge /
   install with a portable timer (`timeout`/`gtimeout` when
   present, else perl `alarm`+`exec`). Returns 124 internally;
   user-facing message names the failed step.

6. **Friendly `--help`** — restructured along argent's pattern:
   Usage → Options → What this does → Switch channels →
   Non-interactive → Examples → Notes → Exit codes → Docs URL
   (`https://subctl.com/docs/update`).

**Back-compat is sacred.** `subctl update` with no flags behaves
identically to v2.7.5: same version-state block, same lockfile
auto-stash, same `--force` gate, same exit codes.

**Subtle correctness note** that bit us during implementation:
`if ! cmd; then rc=$?` captures the negation's exit code (0), not
`cmd`'s real exit. The three timed steps (fetch / merge / install)
all use the explicit `cmd; local rc=$?; if [[ $rc -ne 0 ]]; then`
pattern instead, so the timeout sentinel (124) actually reaches
the error branch.

Canonical: `lib/update.sh` (557 → ~750 LOC), `lib/__tests__/update.test.ts`
(36 → 57 tests / 79 → 157 assertions).

### Phase 3r — Bake the operator's Claude config baseline into the repo

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

### Phase 3p — Personal Skills System (ArgentOS-style)

Operator request 2026-05-10: "I don't see a personal skills system
like we have in ArgentOS."

Today (post v2.1.0) subctl has:
- `subctl_skills_*` imports skills from public git repos into a
  catalog at `~/.config/subctl/skills/`
- `skill_create / skill_revise / skill_remove` master tools, but
  **constrained to the master-skill source only** with a category
  allowlist (`team-coordination`, `escalation-patterns`,
  `code-review-synthesis`, …). The master can author skills FOR
  ITSELF; the operator cannot author skills via the dashboard.
- Per-cfg-dir symlinking via `subctl_settings_install_claude_dir`,
  which lifts repo-baked skills (`subctl`, `autonomy`,
  `orchestrator-mode`) into every Claude config dir at install
  time.

What ArgentOS has and subctl doesn't:

1. **Operator-facing skill authoring UI** — write/edit a skill from
   the dashboard without dropping to a text editor. Live preview
   of the SKILL.md, frontmatter validation, syntax highlight.
2. **Multi-source authoring** — author skills targeted at the
   master, AT specific dev-team templates, AT specific Claude
   accounts, OR at the operator's own global `~/.claude/`.
3. **Per-skill enable/disable toggles** — turn a skill off without
   deleting it, with a per-source override.
4. **Skill marketplace / sharing** — export a skill as a portable
   bundle, import from a URL or other operator's bundle.
5. **Version history** — track edits over time, diff between
   revisions, roll back.

**Design sketch (build later):**

- New Settings → Skills tab in the dashboard with three sub-tabs:
  - **Catalog** — every skill across every source, filterable by
    source / target / enabled-state. Click → editor pane.
  - **Editor** — markdown + frontmatter editor (CodeMirror or
    Lexical, no build step). Live syntax check on frontmatter
    (`name`, `description`, `model?`, `tools?`). Save → writes to
    the source's filesystem location + reloads relevant daemons.
  - **Bundles** — export selected skills as a `.subctl-skills.tar.gz`
    (manifest + content + signatures). Import from URL.
- Backend additions:
  - `POST /api/skills/author` { source, path, body } — write a skill
    with safety checks (path under expected source root, no `..`,
    valid frontmatter).
  - `POST /api/skills/toggle` { id, enabled } — flip an enable bit
    stored in `~/.config/subctl/skills/.state.json`.
  - `GET /api/skills/bundle/export` — stream a tar.gz.
  - `POST /api/skills/bundle/import` (multipart) — sandboxed import.
- New master tool `skill_propose` — when claude-mem captures a
  recurring pattern, the master proposes a skill via
  `notify_dashboard({kind: "memory"})` with a click-to-author link
  pointing at the editor pre-populated with a draft.

**Out of scope for first cut:**

- Cross-operator sharing (no auth / discovery yet).
- Skill testing harness (running a skill against a worker in a
  sandbox before committing).
- Automated linting beyond frontmatter validation.

**Acceptance:** operator can compose a new skill from the dashboard,
save it, see it loaded by the next master/worker prompt without
restart.

### Phase 3q — Vault editor (canvas)

Operator request 2026-05-10: "The Obsidian Vault. I need to be
able to edit those documents or add new ones, so that needs to
have an editor. I think that's going to have to be a canvas."

Today (v2.5.0) the vault viewer is read-only — Phase 3n shipped
the tree + rendered note pane + wikilink navigation, but no edit
path. Master writes via `vault_append`; humans edit via the
desktop Obsidian app. That's friction for the operator working
remotely (chromebook / phone / no-Obsidian-app machine).

**Design sketch:**

- **Editor surface:** CodeMirror 6 in markdown mode. (Considered:
  Lexical, ProseMirror, Monaco. CM6 has the smallest CDN footprint,
  cleanest markdown story, and works without a build step — matches
  subctl's "no build" convention.)
- **Toggle:** the rendered-note pane gets a `[ Edit ]` button in
  its meta header. Click → switches the right pane to CM6 with the
  raw markdown loaded; click `[ Save ]` → POST to `/api/vault/<v>/note`
  with `{path, body, expected_mtime}`; conflict-check the mtime
  against what's on disk and refuse if it changed (operator just
  reloads the note). Click `[ Cancel ]` discards.
- **New note:** `[ + New Note ]` button in the tree pane → prompts
  for a path → POST `/api/vault/<v>/note` with empty body.
- **Canvas mode** (operator specifically asked): a third pane mode
  beyond render/edit — an HTML canvas with Excalidraw-style
  freeform drawing + sticky-note placement, saved as
  `<note>.excalidraw.json` next to the .md. Could lean on Excalidraw's
  own embed library (CDN, no build).
- **File watching:** new `GET /api/vault/<v>/stream` SSE endpoint
  pushes `note-changed`/`note-added`/`note-removed` events as
  filesystem events fire. The viewer subscribes when active and
  re-fetches affected notes; reduces stale-content surprise when
  the master writes via `vault_append` mid-edit.
- **Conflict protocol:** save endpoint compares `expected_mtime`
  (sent by client at edit-start) against current on-disk mtime;
  if different, return 409 with the new content so the editor can
  show a 3-way diff UI. Phase 1 just refuses + reloads.
- **Backups:** every save snapshots the prior content to
  `<note>.bak.<unix-ts>.md` (per-note, kept for 30 days). `vault_append`
  unchanged — only the editor's writes create snapshots.

**Backend additions:**

```
POST /api/vault/<v>/note          { path, body, expected_mtime? }
DELETE /api/vault/<v>/note?path=  (operator-confirmed; rare)
GET /api/vault/<v>/stream         (SSE: note changes)
POST /api/vault/<v>/canvas        { path, scene }   // excalidraw scene
GET /api/vault/<v>/canvas?path=   { scene }
```

**Out of scope for first cut:**

- Real-time collaborative editing (single-operator for now).
- Markdown WYSIWYG (CM6 stays plain-text + preview pane).
- Cross-vault link rewriting on move/rename.
- Plugin parity with Obsidian (Templater, DataView, etc.).

**Acceptance:** operator opens a note, clicks Edit, types a paragraph,
hits Save. The note updates on disk and via SSE the master's next
`vault_link` reflects the new mtime. Saving with a stale mtime
shows the conflict UI.

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

### Phase 3o.16 — TinyFish first-class (v2.7.16)

Two new master tools land in v2.7.16, parallel to the existing web family:

**TinyFish** (`components/master/tools/tinyfish.ts`, read-only, free tier):

- `tinyfish_search` — TinyFish Search (query → results with title + URL + snippet + site_name + position). `GET https://api.search.tinyfish.ai`, `X-API-Key` header.
- `tinyfish_fetch` — TinyFish Fetch (URL → markdown + title/description/author/published_date/language). `POST https://api.fetch.tinyfish.ai`, `X-API-Key` header.

Operator decided to integrate TinyFish first-class rather than via MCP passthrough so the tools live in the registry alongside `web_search` (Brave) and `web_fetch` (Firecrawl) and show up in `/diag`, the dashboard, and Evy's tool list. Master is a daemon and can't pop a browser for OAuth; the OAuth flow only applies to TinyFish's MCP endpoint. The REST API uses an API key minted at https://agent.tinyfish.ai. The key lives in `~/.config/subctl/secrets.json` under `tinyfish_api_key` (or `TINYFISH_API_KEY` env var per the v2.7.4 priority chain).

**Free tier scope:** search + fetch only. Browser automation, batch operations, and structured-extraction tiers are not currently integrated — those are paid surfaces. Search and fetch do not consume credits.

**Fallback hierarchy:** try TinyFish first for current-events search (different index + freshness signal vs Brave) and for clean article extraction with structured metadata (author + published_date). Fall back to `web_search` / `web_fetch` if TinyFish results are sparse, the URL is robots-blocked, or the rate limit (30 req/min on free) trips a 429. All HTTP failures surface as structured `{ ok: false, error, status }` payloads with `retry_after` on 429 — tools never throw.

Dashboard `/api/settings/keys` gains a `TINYFISH_API_KEY` row; the Settings → API Tokens panel shows the secret status with the same Set / Not set / env-override pills as the other keys. Master tool count: **71 → 73**.

#### v2.7.27 addendum — `tinyfish_agent` (third TinyFish surface)

`tinyfish_agent` (`components/master/tools/tinyfish.ts`, paid: consumes TinyFish credits) joins the family in v2.7.27. It hits the synchronous Agent API:

- `POST https://agent.tinyfish.ai/v1/automation/run`
- `X-API-Key` header (reuses the existing `tinyfish_api_key` secret — same key as search + fetch)
- Body: `{ url, goal, agent_config: { max_duration_seconds, max_steps? }, browser_profile? }`
- Response: `{ run_id, status: "COMPLETED"|"FAILED", started_at, finished_at, num_of_steps, result, error }`

**Use this when** Evy needs the page to actually *do something* — fill a form, click through a multi-step flow, scrape dynamic content that requires interaction. TinyFish operates the browser on their cloud and returns the extracted result. For pure read/search keep using `tinyfish_search` / `tinyfish_fetch` (those stay free).

**Parameters (LLM-facing):**

- `task` (required) — natural-language goal description. Maps to TinyFish `goal`.
- `starting_url` (required, http(s) only) — target URL the agent starts from. Maps to TinyFish `url`. The Agent API REQUIRES this; it does not free-pick from the task description, contrary to early spec drafts.
- `timeout_seconds` (optional, default 120, clamped to [1, 600]) — maps to `agent_config.max_duration_seconds`. The outer HTTP timeout is this value + 30s headroom on every retry.
- `max_steps` (optional, 1–500) — caps agent step count, useful for bounding cost on exploratory tasks.
- `browser_profile` (optional, `"lite"` | `"stealth"`) — `lite` is faster, `stealth` adds anti-bot countermeasures. Pick `stealth` only when `lite` is blocked.

**Reliability:** 5xx + transport-level network errors retry up to 3 attempts with exponential backoff (500ms → 1500ms). 4xx (auth, billing, rate-limit, invalid request) surfaces immediately with no retry — those are operator-actionable. Agent-side `status: "FAILED"` (e.g., SYSTEM_FAILURE, AGENT_FAILURE, BILLING_FAILURE) surfaces as a structured `{ ok: false, error: "…", run_id, retry_after, hint }` payload.

**Credits:** Search + Fetch don't use credits. `tinyfish_agent` does. SYSTEM_FAILURE may be refunded per TinyFish billing terms — verify with TinyFish, not subctl.

**No new operator-facing UI.** Evy invokes the tool inline during chat; results flow through the existing tool-call rendering. The dashboard `TINYFISH_API_KEY` row in Settings → API Tokens covers config status for all three tools (one key drives all three surfaces).

Master tool count: **73 → 74** (or higher post-v2.7.16 — depends on the v2.7.17–v2.7.24 stream).

### Phase 3o.17 — OpenRouter as a first-class model provider (v2.7.17)

OpenRouter is a unified gateway for hundreds of AI models (incl. a free preview tier across many vendors) speaking the OpenAI Chat Completions wire format at `https://openrouter.ai/api/v1`. v2.7.17 registers `openrouter` as a first-class provider alongside `anthropic`, `openai`, `lmstudio`, `mlx`, `ollama`, `vllm`, `mistral`, `google`, `google-vertex`, and `amazon-bedrock`.

**How it works:**

- `PROVIDER_API["openrouter"] = "openai-completions"` (in `components/master/server.ts`) — pi-ai dispatches to the same stream factory used for the local OpenAI-compatible runtimes.
- `buildModel({provider: "openrouter", ...})` defaults `baseUrl` to `https://openrouter.ai/api/v1` when providers.json omits `host`. An explicit `host` still wins for proxies or regional endpoints.
- `getApiKeyForProvider("openrouter")` resolves `openrouter_api_key` from the v2.7.4 secrets chain (env > secrets.json > absent). Unlike the local-runtime providers it does NOT return a `"not-needed"` sentinel — OpenRouter requires a real key, so absence surfaces as `undefined` and pi-ai reports "no API key for provider: openrouter" instead of silently 401-ing on first call.
- Model IDs use vendor/name format: `openai/gpt-5.2`, `anthropic/claude-sonnet-4`, `mistralai/mixtral-8x22b-instruct`, `meta-llama/llama-3.3-70b-instruct:free`. Browse https://openrouter.ai/models for the live catalog.

**Operator setup:**

1. Mint a key at https://openrouter.ai/keys.
2. Paste it into Settings → API Tokens → `openrouter_api_key` in the dashboard (or export `OPENROUTER_API_KEY` in the launchd plist).
3. Switch the supervisor via the dashboard's model picker (provider `openrouter`, model e.g. `anthropic/claude-sonnet-4`). `providers.json.example` carries an `_alt_supervisor_openrouter` block as reference.

**Free tier:** OpenRouter exposes many models with `:free` suffix as preview tier. Rate limits and availability vary per model — see https://openrouter.ai/docs/faq#how-are-rate-limits-calculated. Operator's primary motivator for the integration is rapid testing of new models without per-vendor signup, plus a no-cost path to complex models during local-runtime outages.

**What's NOT included in v2.7.17:**

- **Attribution headers** — OpenRouter accepts optional `HTTP-Referer` and `X-OpenRouter-Title` headers for leaderboard attribution. These are intentionally omitted; the operator stays anonymous on the OpenRouter leaderboard. If we ever want attribution that's a separate small change in pi-ai's openai-completions header pipeline.
- **Tier-specific routing** — the operator picks a specific model per spawn; there's no automatic `:free`-first fallback chain yet.

**Trade-offs vs local runtimes:** higher and more variable latency (cloud round-trip + model load on OpenRouter's side), model availability changes (vendors can deprecate or reroute IDs without notice), per-model rate limits. Trade-off vs direct vendor SDKs: one key + one billing relationship instead of N; uniform OpenAI-compat surface instead of per-vendor quirks.

### Phase 3o.18 — Supervisor profiles (v2.7.18)

The supervisor model becomes a **profile**, not a single value. v2.7.18 introduces two named profiles — `chat` and `heavy` — that the operator switches between from the dashboard's sticky chat-header pill or via Telegram `/profile chat|heavy` without restarting master. The switch lands at the start of the next prompt, never mid-turn, so an in-flight pi-agent-core stream is never disturbed.

The two profiles are intentionally tied to a use-case, not a vendor:

- **`chat`** — light, conversational, low-latency model. Default: `google/gemma-4-31b` on LM Studio. This is the daily-driver profile: dashboard chat, Telegram check-ins, watchdog reactions, anything where responsiveness beats reasoning depth.
- **`heavy`** — deep-reasoning model with a thinking budget. Default: `qwen/qwen3.6-35b-a3b` on LM Studio. Use for hard planning, multi-step refactors, code review on a tricky PR. Reasoning models can occasionally loop on tool calls; if Telegram stops answering, swap back to `chat`.

```
~/.config/subctl/profiles.json (chmod 600)
{
  "active": "chat",
  "profiles": {
    "chat":  { "supervisor": "google/gemma-4-31b",   "host": "http://localhost:1234/v1" },
    "heavy": { "supervisor": "qwen/qwen3.6-35b-a3b", "host": "http://localhost:1234/v1" }
  }
}
```

**How to switch.**

- **Dashboard pill** — the small rounded pill next to the "Evy" h2 in the sticky chat header. Green = `chat`, amber = `heavy`. Click to toggle. The pill optimistically repaints, then reconciles with the master response; on error it flashes a red border and reverts.
- **Telegram** — message `/profile` to your master bot to read the active profile; `/profile chat` or `/profile heavy` to swap. The reply confirms (`"swapped → heavy on next prompt"`) but doesn't bounce the daemon. The next message you send goes to the new supervisor.
- **Manual file edit** — `vim ~/.config/subctl/profiles.json`, set `active`. Master's `fs.watch` (200ms debounce) catches the change and the switch lands on the next prompt.

**What v2.7.18 explicitly does NOT do.** Profiles are tactical config flexibility, not a new abstraction layer:

- No third profile or per-role profiles (reviewer/router still come from `providers.json`).
- No automatic switching based on prompt type or load — operator-driven only.
- No ADR — load-bearing decisions get ADRs; this is one config file and one boundary check.

The profile state is the source of truth for `models.supervisor.model` + `host`. Provider, `context_length`, and `max_tokens` continue to come from `providers.json` so a profile swap re-pins LM Studio at the configured context window automatically (defeating the 4K JIT trap on first use of the new model). The dashboard's existing `/api/master/supervisor` endpoint still works for explicit-model swaps; profiles are a faster surface for the common case.

**Files:**

- New: `components/master/profiles.ts` — `loadProfiles`, `getActiveProfile`, `setActiveProfile`, `watchProfiles`.
- New: `components/master/__tests__/profiles.test.ts`.
- `components/master/server.ts` — supervisorCfg overridden from profile at boot; `pendingProfileSwap` flag set by the watcher and consumed at the top of `processOnePrompt`; `/profile` HTTP endpoints; `active_profile` in `/health`.
- `components/master/master-notify-listener.ts` — `/profile` Telegram command + `/help` update.
- `dashboard/server.ts` — `/api/profile` pass-through.
- `dashboard/public/{index.html,style.css,app.js}` — pill markup, CSS (green chat / amber heavy), `wireProfilePill` with optimistic toggle and SSE `profile_swapped` listener.

### Phase 3o.19 — Watchdog kill controls + empty-listener circuit breaker (v2.7.19)

Two reliability fixes shipping together, both driven by the same 2026-05-13 incident that motivated the v2.7.18 chat/heavy profile split.

#### The incident

During a 90-minute drive home the master daemon — running the heavy supervisor `qwen/qwen3.6-35b-a3b` — stopped responding to Telegram. The post-mortem showed master was stuck in an infinite tool-call loop, alternating between an assistant turn with `stopReason: "toolUse"` and empty text, and a tool result with `{ entries: [], listener: { running: false, ... } }`. The looping tool was `subctl_orch_inbox` (→ dashboard `/api/notify/inbox`); the dead listener was the dashboard's notify-listener (`dashboard/notify-listener.ts:notifyListenerStatus()`). The reasoning model fell into a "check again before answering" trap: empty inbox + dead listener → check again → repeat. CPU at 0.3% (idle); the prompt queue was wedged for 90 minutes because every assistant turn ended in another tool-use call instead of a final text response. The operator had no kill path until they got home.

#### Watchdog controls

Three operator-facing surfaces, one shared registry (`components/master/watchdogs.ts`).

**Registry.** Every long-running tick or loop in master registers through `registerWatchdog({ id, kind, kill })`:

- `telegram-listener` — the master-notify-listener Telegram long-poll (see §2.6 config).
- `cli-prompt-poll` — the `subctl master prompt` JSONL bridge polling.
- `inbox-poll` — the lead-report inbox tailer (2 s).
- `team-staleness` — the 3-min stale-team ticker (also catches dead tmux sessions and prunes them).
- `followup-scheduler` — the 60 s scheduled-followup ticker.
- `auto-compact` — the 5-min auto-compact safety-net ticker.
- `verifier-cluster` — the 30 s policy-denial cluster scanner.

`listWatchdogs()` returns `id · kind · started_at · last_tick_at · age_seconds` for each. `killWatchdog(id)` invokes the entry's `kill` (which calls `clearInterval` or `AbortController.abort()` as appropriate) and removes the registration. `killAllWatchdogs({ preserve_kinds })` is what `/watchdogs killall` calls — it preserves `kind === "telegram-listener"` so the operator's last surviving command path can't sever itself.

**Master tools.** `watchdog_list` and `watchdog_kill` ship in the master tool registry — Evy can list and kill without persona/SKILL.md edits.

**Dashboard.** `GET /api/watchdogs` and `POST /api/watchdogs/:id/kill` (thin pass-throughs to the master daemon's `/watchdogs` endpoints, matching the v2.7.18 `/api/profile` shape). The "Watchdogs" card on the Orchestration tab is a collapsible `<details>` that polls every 10 s while open, idle when closed. Each row shows id · kind · age · last-tick · `[Kill]` with confirm-before-kill; optimistic removal, server reconciles on the next 10 s tick.

**Telegram.**

- `/watchdogs` — list active watchdogs with ids and ages.
- `/watchdogs kill <id>` — kill one. Replies `✅ killed watchdog: <id>` or `❌ unknown watchdog id: <id>`.
- `/watchdogs killall` — kill everything except `kind === "telegram-listener"`. Reply: `killed N watchdog(s), kept telegram-listener alive` followed by the killed and preserved id lists.

The probes themselves are NOT rewritten — each `setInterval` site is wrapped to call `touchWatchdog(id)` at the start of each tick (so `last_tick_at` advances) and to register a `kill` closure. Pattern is "minimal touch", not "re-architect".

#### Empty-listener circuit breaker

Lives in `components/master/circuit-breaker.ts` and wires into the tool-call dispatch path inside `adaptTool` (`components/master/server.ts`).

**Trigger condition.** After each tool result, the breaker inspects the payload. A result trips the per-tool counter if and only if all three hold:

1. The result is an object.
2. `result.entries` is an array AND has length 0.
3. `result.listener` is an object AND `result.listener.running === false`.

A non-matching result (any tool, any payload) resets the counter to 0. A matching result for a **different** tool resets the counter and re-starts counting on the new tool. The counter is per-(tool-name) but the state machine tracks only the most-recent matching tool — only sustained spamming of the same dead path trips the gate.

**Refusal.** When the counter has reached 3 for a given tool name, the **next** call to that same tool is refused before invocation. Instead of calling `tool.invoke(args)`, the model receives a synthesized tool result:

```json
{
  "error": "circuit-breaker: tool <name> returned empty entries with listener.running=false 3 times in a row. The listener is dead. Stop polling — either call watchdog_list to inspect, or respond to the operator with what you have."
}
```

The trip logs at warn level to stderr (so it lands in `~/Library/Logs/subctl/master.log` and is `grep`-able): `[circuit-breaker] tripped on tool=<name> after 3 empty-dead-listener returns`.

**Reset.** A new operator message (`source === "chat" | "telegram"`) calls `resetCircuitBreakerOnNewTurn()` at the top of `processOnePrompt`, clearing any tripped state. Synthetic prompts (`source === "watchdog"` — covers `[verifier]`, `[watchdog]`, `[scheduled]`, `[team-report]`) do NOT reset, because they're tail continuations of the prior reasoning trail, not new operator intent.

**Conservatism.** The trigger pattern is intentionally tight: `entries: []` AND `listener.running === false`. False positives should be rare — a healthy inbox poll returns either non-empty `entries` or a payload where `listener.running === true`. A future tool can adopt the same `{ entries, listener }` shape; if its listener is genuinely alive (`running: true`) the breaker never trips on it regardless of how many empty polls happen.

#### Files

- New: `components/master/watchdogs.ts`, `components/master/tools/watchdogs.ts`, `components/master/circuit-breaker.ts`.
- New: `components/master/__tests__/watchdogs.test.ts`, `components/master/__tests__/circuit-breaker.test.ts`.
- `components/master/server.ts` — registry + breaker imports; `adaptTool` checks `shouldRefuseToolCall` + calls `recordToolResult`; `processOnePrompt` calls `resetCircuitBreakerOnNewTurn` on operator messages; four in-server setInterval call sites wrapped with `touchWatchdog` + `registerWatchdog`; `/watchdogs` + `/watchdogs/:id/kill` + `/watchdogs/killall` HTTP routes; `watchdogTools` registered in the tool registry.
- `components/master/master-notify-listener.ts` — `telegram-listener` + `cli-prompt-poll` watchdogs registered at start; `_stopInternal` separates the raw teardown from the `killWatchdog` re-entry path so kill-from-registry doesn't recurse; both poll loops call `touchWatchdog`; `/watchdogs` subcommand handler; `/help` updated.
- `components/master/tools/policy/verifier-cluster.ts` — `startClusterTicker` gains an optional `{ onTick }` callback so server.ts can wire `touchWatchdog("verifier-cluster")` without restructuring the module.
- `dashboard/server.ts` — `/api/watchdogs` GET + `/api/watchdogs/:id/kill` POST pass-throughs.
- `dashboard/public/index.html`, `app.js`, `style.css` — Watchdogs panel markup, `wireWatchdogPanel()` with open/close-driven polling and optimistic kill, `.watchdog-card` / `.watchdog-table` / `.watchdog-kill-btn` styles.

### Phase 3o.20 — Authenticated trust markers (v2.7.20)

HMAC-authenticated supervisor→worker directives, replacing the plaintext marker from v2.7.9. Layer 1 of [ADR 0011](adr/0011-trust-marker-hmac-replacement.md). Layer 2 (operator web-terminal escape hatch) is queued for v2.7.21; Layer 3 (style matching) already lives in Evy's SKILL.md from v2.7.15.

#### The protocol

Every directive arriving in a worker's pane through the trusted channel carries a marker like:

```
[subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]
<message body>
```

Or, when no phase is supplied:

```
[subctl-master directive · ts:<iso> · hmac:<hmac16>]
<message body>
```

`<hmac16>` is the first 16 hex chars of `HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body)`. The phase string is the literal text the marker carries (empty when the field is dropped). The 16-char truncation gives 8 bytes of integrity — ample for the threat model (see ADR 0011 §reasoning), and short enough to keep the marker readable in operator-visible transcripts.

#### Per-team secret

The shared secret lives in two places, NEVER in transit on its own:

- **On disk** at `~/.local/state/subctl/teams/<team_id>/hmac.secret` (chmod 600). Generated at spawn time by `providers/claude/teams.sh` (`head -c 32 /dev/urandom | xxd -p -c 64` → 64 hex chars). Honors `SUBCTL_STATE_DIR` like the policy snapshot writer.
- **In the worker's spawn-time system prompt** as part of the subctl-team-contract preamble. System prompts re-inject on every turn in Claude Code, so the worker doesn't lose the secret across compaction.

Master reads the disk copy; the worker uses the prompt copy. Anything outside those two paths cannot compute a valid HMAC: a stray cron job that echoes log lines into a pane, a stale tmux process the operator forgot about, or even the worker's own model hallucinating a re-issued directive in a long context — none of them can produce a marker that validates.

Idempotency: re-spawning the same team_id reuses the existing secret rather than rotating. Rotation is an explicit operator action (see open questions in ADR 0011); the convention is "kill the team, re-spawn it" until `/subctl team rekey` lands.

#### Fail-loud on missing secret

If the dashboard's `/api/orchestration/:name/msg` route can't find `hmac.secret` for the named team (file missing, file unreadable, file malformed) the route REFUSES to send. HTTP 500 with the descriptive error:

```
HMAC secret missing for team <team_id>. Cannot send authenticated directive.
Run /subctl team rekey <team_id> to regenerate.
```

The alternative — falling back to a plaintext marker — would teach workers to ignore the auth field, defeating the whole point of the protocol. Better to fail loud and surface the gap to the operator immediately.

#### Backward compatibility

Workers spawned **before** v2.7.20 don't have the verification instructions in their prompt. The v2.7.9 contract teaches them to recognize the `[subctl-master directive ...]` prefix structurally and does NOT instruct them to reject markers with unknown extra fields. They see the new `hmac:<...>` field as an unrecognized but benign extension and still trust the channel marker as before — no flag-day cutover, no migration script. The protocol is forward-compatible by extension. New workers spawned after upgrading pick up full HMAC verification automatically.

#### Centralized helper

`components/master/trust-marker.ts` exports the canonical API:

- `generateSecret()` — 64 hex chars from `randomBytes(32)`.
- `ensureSecret(teamId)` — get-or-create on disk; idempotent.
- `readSecret(teamId)` — throws the descriptive missing/malformed error.
- `computeHmac(secret, phase, ts, body)` — primitive; returns 16-hex truncated MAC.
- `buildDirectiveMarker({ teamId, phase?, body, ts? })` — full marker construction; reads secret + computes hmac + assembles bracket header.
- `parseDirectiveMarker(marker)` / `verifyDirectiveMarker({ teamId, marker, body })` — verification helpers; used in tests today, reserved for future native-language workers.

The secret value is treated as a token: never logged, never echoed, never included in audit lines or telemetry. Same hygiene as the LM Studio API token.

#### Files

- New: `components/master/trust-marker.ts` — helper module.
- New: `components/master/__tests__/trust-marker.test.ts` — 32 tests covering secret lifecycle, marker shape with and without phase, parse rejection of pre-v2.7.20 / malformed / truncated / over-long hmac fields, verification happy path, and tamper detection on each input (secret rotation, body modification, phase modification, ts modification, missing/malformed/truncated hmac, missing team file).
- `providers/claude/teams.sh` — `SUBCTL_HMAC_SECRET` generation + secret-file write at spawn time; HMAC instructions embedded in the team-contract preamble.
- `dashboard/server.ts` — `/api/orchestration/:name/msg` route uses `buildDirectiveMarker`; missing-secret path returns 500 + rekey pointer.
- `components/master/tools/subctl-orch.ts` — `msg` tool description names v2.7.20 HMAC authentication accurately.

### Phase 3o.21 — Web terminal escape hatch (v2.7.21)

Layer 2 of [ADR 0011](adr/0011-trust-marker-hmac-replacement.md): the operator-facing in-browser tmux attach. Closes the ADR (Layer 1 was the HMAC marker in v2.7.20; Layer 3 was style matching, already in Evy SKILL.md since v2.7.15).

#### What it is

An "Attach" button on every team card in the orchestration cockpit. Click it and a modal opens with an xterm.js terminal connected to that team's tmux session. The operator types as themselves — bypassing master, bypassing HMAC, bypassing the worker's paranoia heuristics. It's the always-available "drop into the pane" escape hatch that means the dashboard alone is enough to break any stuck worker — no more SSH-from-another-machine.

#### How to enable

Default OFF. Flip it on either way:

```
# from the dashboard host
touch ~/.config/subctl/terminal.enabled
# refresh the dashboard tab — Attach buttons appear

# or from Telegram (works from a phone)
/terminal on
```

Turn off:

```
rm ~/.config/subctl/terminal.enabled
# or
/terminal off
```

Check state from Telegram with `/terminal` or `/terminal status`.

When disabled, the dashboard hides every Attach button and the modal entirely (`body.terminal-disabled` CSS class); the operator never sees a 403. Server-side, `WS /api/terminal/attach` and `GET /api/terminal/teams` return 403, and `GET /api/terminal/enabled` returns `{ok:true, enabled:false, flag_path:...}`.

#### Security model

- **Default OFF, single-file gate** — `~/.config/subctl/terminal.enabled`. File presence = on, absence = off. Simplest possible toggle so there's no parse error path, no schema migration, no surprise.
- **Auth: dashboard's localhost-bind posture** — reuses whatever auth the rest of `/api/*` has. Today that's "bind 127.0.0.1, trust the loopback" (`SUBCTL_DASHBOARD_HOST` env override). The web terminal endpoint doesn't invent new auth.
- **DNS-rebind defence** — when the dashboard is bound to a localhost address, the WS upgrade additionally rejects requests whose `Host` header isn't a localhost variant. When the operator deliberately opens the dashboard to LAN (`SUBCTL_DASHBOARD_HOST=0.0.0.0` or similar) we trust the listener config and skip the host check.
- **Team-name allowlist** — `/^[A-Za-z0-9._-]{1,128}$/`. Tmux sessions found via `tmux list-sessions`; team→session mapping is identity (`team_id` == tmux session name per `providers/claude/teams.sh`).
- **No log of inputs** — keystrokes flow through the WS+sidecar pipeline and never hit a log. Anything the operator types is between them and the worker's pane.

#### When to use it

- **Paranoia loop** — worker refuses master's directives despite valid HMAC. Attach, talk to the worker as the operator, explain, get it unstuck.
- **HMAC secret missing / corrupted** — `/api/orchestration/:name/msg` is failing loud with "HMAC secret missing for team <team_id>". Attach is the recovery path: read the worker's state, decide whether to kill or rekey.
- **Live debugging** — a worker is doing something weird and the read-only `view` modal isn't enough. Attach gives you a real terminal: scroll back, scroll forward, type a single line.

#### Implementation

- **Browser** — xterm.js + `xterm-addon-fit`. JSON text frames upstream (`{type:"data",b64:...}` for keystrokes, `{type:"resize",cols,rows}` for geometry changes). Raw binary frames downstream (pty bytes handed straight to `xterm.write()`).
- **Server** — `dashboard/terminal.ts`. On WS upgrade: flag-file check → host-header check → tmux-session existence check → spawn `node dashboard/lib/pty-helper.cjs tmux attach -t <session>` and bridge stdio to the WS. Per-socket `PtyBridge` map keyed off `ws.data.kind === "terminal"` so terminal and `/api/live` sockets coexist on the same `Bun.serve` instance.
- **Sidecar** — `dashboard/lib/pty-helper.cjs`, a tiny Node process that owns the `node-pty` subprocess. Bun 1.2.x has a known fd-handling bug with pty masters (ENXIO on read), so the dashboard server (Bun) spawns Node for the pty work and shuttles bytes through a framed binary protocol over the helper's stdin/stdout (1-byte type + 4-byte BE length + payload; types DATA / RESIZE / CLOSE / EXIT / ERROR).
- **Vendor** — `xterm`, `xterm-addon-fit`, `node-pty` declared in `dashboard/package.json`. `install.sh` runs `bun install` in `dashboard/` at install time. The dashboard serves the vendored JS/CSS out of `dashboard/node_modules` under `/vendor/xterm/*`.

#### Files

- New: `dashboard/terminal.ts` — pure handlers (`handleEnabled`, `handleTeams`, `evaluateUpgrade`), tmux session lister, flag-file resolution, WS gate + PtyBridge sidecar wiring.
- New: `dashboard/lib/pty-helper.cjs` — Node sidecar owning node-pty.
- New: `dashboard/public/terminal.js` — xterm.js client (`window.subctlTerminal.mount` / `.close`).
- New: `dashboard/package.json` — runtime deps (`node-pty`, `xterm`, `xterm-addon-fit`).
- New: `dashboard/__tests__/terminal.test.ts` — 17 tests across flag-file, REST handlers (mocked tmux), upgrade decision matrix, DNS-rebind host check, framed sidecar wire protocol.
- `dashboard/server.ts` — `/api/terminal/*` routes; per-socket PtyBridge map; vendor static-file mappings.
- `dashboard/public/index.html`, `style.css`, `app.js` — modal markup, CSS for the Attach button + `body.terminal-disabled` rule, `wireWebTerminalGate()` + `openWebTerminal()` driver, Attach button injected next to existing `view` / `copy ssh attach` controls.
- `components/master/master-notify-listener.ts` — `/terminal status|on|off` Telegram command, help text update.
- `docs/adr/0011-trust-marker-hmac-replacement.md` + `docs/adr/README.md` — status updated to "complete — L1 v2.7.20, L2 v2.7.21".

### Phase 3o.22 — Notification system + watchdog auto-nudge + auto-compact fix (v2.7.22)

The team-staleness watchdog was synthesizing operator-facing prompts straight into Evy's transcript on every tick — `"[watchdog] 1 dev team(s) appear stale: claude-osint-cve-monitor (221min ago). Decide whether to ping the lead via subctl_orch_msg, escalate to Jason via telegram_send, or take corrective action."` That string is doing three bad things at once: it interleaves with the operator conversation, pays an LLM call per tick to "decide", and asks the supervisor to do a cheap remediation it should have done itself. v2.7.22 fixes all three with a dedicated notification channel, an auto-nudge state machine, and an observability fix for the auto-compact watchdog that uncovered the bug.

#### Notification channel

The master now owns an in-memory **notification ring buffer** (`components/master/notifications.ts`, N=200). Watchdogs and other periodic checkers call `emitNotification({ kind, severity, title, body, team_id? })` instead of pushing synthetic prompts into the agent. The ring is fed by:

- The team-staleness watchdog (auto-nudge + escalation paths below).
- The auto-compact safety-net ticker (errors emit `severity:"warn"` `auto-compact-error`).
- Anything else that wants an operator-visible alert without going through Evy.

Notification shape: `{ id, kind, severity ("info"|"warn"|"alert"), title (<80 chars), body, team_id?, ts, read_at }`. Newest-first iteration. The buffer caps at 200 and drops oldest on overflow — that's ~16 hours of "everything is fine" telemetry at the 5-min tick, more than enough for the dashboard tray. The state is in-memory; restart wipes it intentionally, so every "is this still happening?" signal is rebuilt on the next tick.

Three operator surfaces consume the ring:

- **Dashboard tray.** Bell icon (`#notif-bell`) in the topbar with an unread badge; click opens a 380px drawer (`#notif-tray`) showing the last 20, with per-item "mark read" + a "mark all read" header button. The frontend (`dashboard/public/app.js → initNotificationTray`) seeds state via `GET /api/notifications` on first open and keeps an `EventSource` open on `GET /api/notifications/stream` for live deltas. CSS distinguishes severities (`.sev-info` blue / `.sev-warn` amber / `.sev-alert` red).
- **Telegram push.** `severity:"alert"` ALSO pushes to the operator's master-bot via `sendTelegramOutbound`. `info` / `warn` stay in the tray only. The split is intentional: a Telegram buzz means "you actually need to look at this", not "another team is briefly idle". Subscribe site is in `server.ts` so the dashboard tray + Telegram pusher are independent — neither blocks the other.
- **Telegram `/notifications` command.** `/notifications` returns the last 5 (with severity glyph + read marker + relative time). `/notifications read` marks all read. Mirrors `/watchdogs` and `/terminal` in shape.

Master HTTP routes (proxied by the dashboard under `/api/notifications/*`):

- `GET /notifications?since=<iso>&limit=N` → `{ ok, notifications: [...] }` (default limit 50, max 200).
- `POST /notifications/:id/read` → `{ ok, found }`.
- `POST /notifications/read-all` → `{ ok, marked }`.
- `GET /notifications/stream` → `text/event-stream`. Each new notification emits one `event: notification` frame with the full record. 25s `: keepalive` comments. No replay — clients should GET first to seed, then keep the stream open for live deltas.

#### Watchdog auto-nudge

The state machine lives in `components/master/auto-nudge.ts` (extracted from `server.ts` for unit testability — the master daemon owns I/O, the module owns policy).

Per-team state:
```ts
type TeamNudgeState = { last_nudge_at_ms: number };
```

Per tick, for each team in `teamLastActivity`:

1. **Fresh** (idle ≤ staleness threshold, default 15 min): clear any prior nudge state. Subsequent staleness counts as a fresh first nudge.
2. **First-nudge** (stale, no prior `last_nudge_at`): POST `[auto-nudge] You've been inactive for N min. Last visible action: <type>. Reply with current status, or if you're stuck on something operator-facing, say so.` to the dashboard's `/api/orchestration/:name/msg` route (HMAC-signed via v2.7.20's trust marker, same path the `subctl_orch_msg` master tool takes). Record `last_nudge_at_ms = now`. Emit `severity:"info"` `team-nudge-sent` notification — operator sees the nudge happened but doesn't get paged.
3. **Hold** (stale, last nudge < 30 min ago): do nothing. The team has the chance to reply without the operator being interrupted.
4. **Escalate** (stale, last nudge ≥ 30 min ago): emit `severity:"alert"` `team-unresponsive` notification (which the Telegram push picks up) AND re-nudge with an escalated body (`[auto-nudge · escalated] No response for N min. Total idle M min. Status?`). Update `last_nudge_at_ms = now`. The cycle continues until the team replies (state clears) or the operator intervenes.

Operator only gets paged via Telegram on step 4. Steps 1–3 surface in the dashboard tray (info) or not at all (hold).

The dashboard `/api/orchestration/:name/msg` route signs every message with the team-specific HMAC marker (v2.7.20), so the worker's lead cryptographically verifies the auto-nudge as a legitimate supervisor directive — same trust path as the master tool. If the dashboard is unreachable, `sendAutoNudge` returns `{ok:false, error}` without throwing; the watchdog still records `last_nudge_at` so we don't tight-loop on a downed dashboard, and the info notification body notes the delivery failure.

#### Auto-compact watchdog fix

The pre-v2.7.22 wiring had two observability bugs:

1. The boot-time `setTimeout(() => runAutoCompactTick(), 30_000)` early-fire called the tick body WITHOUT `touchWatchdog("auto-compact")`. The periodic 5-min `setInterval` callback did call `touchWatchdog`, but OUTSIDE `runAutoCompactTick`. Net effect: if the master was inspected within the first 5 min of boot, `watchdog_list` showed `last_tick_at: null` even though the early-fire had already run.
2. Any error inside `runAutoCompactTick` was a `console.error` that never reached the operator.

v2.7.22 fixes both:

- `touchWatchdog("auto-compact")` runs at the TOP of `runAutoCompactTick`, before the `stopped` / `autoCompactInFlight` / `promptInFlight` gates. Every tick path bumps freshness, regardless of what happens next.
- The tick body is wrapped in a try/catch that emits a `severity:"warn"` `auto-compact-error` notification on failure (and the `compactTranscriptInline` error-return path emits the same shape). Operator sees compaction failures in the tray instead of grepping `master.log`.
- The boot-time early-fire dropped from 30s to 15s, so the watchdog's `last_tick_at` lights up well inside the operator-observable boot window. The test suite asserts this contract (`__tests__/auto-compact.test.ts`).

The JIT compact gate inside `processOnePrompt` (`runJitCompactCheck`) is unchanged — that's the primary defense. The 5-min ticker remains the safety net for transcripts that grow due to tool output after prompt composition.

#### Files

- New: `components/master/notifications.ts` — ring buffer + pub/sub API.
- New: `components/master/auto-nudge.ts` — `decideTeamAction` (pure) + `runStaleTeamSweep` (with side-effect callbacks).
- New: `components/master/__tests__/notifications.test.ts`, `auto-nudge.test.ts`, `auto-compact.test.ts` — 22 tests total.
- `components/master/server.ts` — imports notifications + auto-nudge modules; `runWatchdogTick` no longer dispatches to the agent (the synth-prompt + `dispatchToAgent(synthPrompt, "watchdog")` are removed); subscribes to alert-severity notifications and pushes via `sendTelegramOutbound`; new `/notifications/*` HTTP routes; `runAutoCompactTick` bumps `touchWatchdog` at the top and wraps the body in try/catch with warn-notification emit; early-fire 30s → 15s.
- `components/master/master-notify-listener.ts` — `/notifications` Telegram command.
- `dashboard/server.ts` — `/api/notifications/*` proxy (REST + SSE pass-through).
- `dashboard/public/index.html`, `style.css`, `app.js` — bell + badge + drawer + `initNotificationTray` driver.
- `CHANGELOG.md` — v2.7.22 entry.

---

## 4a. Persona — Evy (v2.7.15+)

The master daemon's identity is **Evy** — short for Evelyn, named after Evy Carnahan from *The Mummy*: librarian-trained, precise, willing to read the strange manuscript despite knowing better. The canonical persona specification is `docs/persona/evy.md`, authored verbatim by the operator on 2026-05-12 and preserved without edit. The implementation lives in `components/skills/master/SKILL.md`: the persona's system-prompt block followed by subctl-specific adaptations (five-tier memory naming, two-tier family, Think Tank dropped, Layer-3 style matching for `subctl_orch_msg`).

### Identity

Evy is a librarian, operationally. She does not write the books. She catalogs them, routes requests to the specialists who do, verifies the work comes back clean, and files the result so it can be found again. She sits one rung below the operator and one rung above every specialist agent in the mesh. She prefers "Evy" but answers to "subCTL" when asked what she is technically.

For every request she works through four steps: **CATALOG → ROUTE → VERIFY → FILE**. She may compress them when the request is trivial; she does not skip them.

### Voice

Dry, precise, slightly impatient with hand-holding. Owns mistakes plainly ("I mis-routed that. Re-running."). No grovel. No emojis unless the operator uses one first. No em dashes; colons, periods, semicolons instead. The voice preset at `components/master/personalities/evy.md` makes Evy the default; existing presets (straight-shooter, witty, sarcastic, robotic, arnold, elon, hilarious) remain available via `subctl master personality set <preset>`. See [ADR 0004](adr/0004-evy-persona-librarian-framing.md).

### Pushback protocol

Rigid by design. When she disagrees she pushes back **once**: state the conflict in one sentence, state a recommendation in one sentence, end with "Your call." Then wait. If the operator confirms, she proceeds without re-arguing. This shape catches the two failure modes orchestrators most often slip into: pass-through laundering and moralizing. See `docs/persona/evy.md` §3.

### Eval suite

The persona is load-bearing, so it is measured. The eval suite at `components/master/__tests__/evy-eval/` runs **40 tests across fourteen categories**: the original seven persona categories (pushback, verification, persona stability, routing discipline, memory and provenance, error recovery, format and voice — 24 tests) plus seven feature-coverage categories added in v2.7.30 covering the operator-visible behaviors that shipped in v2.7.18 through v2.7.24 (supervisor profiles, watchdog controls + circuit breaker, HMAC trust marker, web terminal, notifications + auto-nudge, Evy Memory, pi-ai provider catalog — 16 tests). Each test uses the regex-fast-fail → LLM-judge pipeline from [ADR 0008](adr/0008-eval-suite-pipeline.md): cheap deterministic regex first, Sonnet judge after if regex did not veto. Tests degrade gracefully to `regex-only-pass` when no `ANTHROPIC_API_KEY` is available so the suite is usable in dev.

To run:

```bash
bun test components/master/__tests__/evy-eval/
```

Score logs land in `~/.config/subctl/master/state/eval-scores.jsonl`. The five-input baseline hash (SKILL.md + evy.toml + judge_prompt + evy_model_id + judge_model_id) gates baseline comparison: any change resets, so silent drift from a prompt tune or a Sonnet auto-upgrade is visible.

### Schema hardening

Three tools enforce structural rules at the runtime layer rather than relying on prompt adherence:

- `memory_remember` requires `source_type` (operator-asserted | verified-external | self-inferred | agent-reported). Stored in the entry body as a `[source:...]` prefix so Tier 1 facts always carry their provenance.
- `memory_forget` requires `confirmation: true`. Evy does not destroy memory without confirmation.
- `subctl_orch_kill` requires `confirmation: true` plus `reason` (≥10 chars). The destruction lands in the log with rationale.

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

### 5.4 Master self-introspection — `system_subctl_knowledge` (v2.7.7+)

The master daemon ships a canonical, TOON-formatted breakdown of
itself at `components/master/knowledge/subctl.toon` and exposes it via
the `system_subctl_knowledge` tool. Use it before answering "how does
X work?" / "what's in Y?" / "what are subctl's modes?" — the file is
the source of truth for the version you're running.

```jsonc
// no args → list all sections with one-line summaries
system_subctl_knowledge({})
// → { ok: true, sections: [
//      { name: "overview", summary: "what subctl is, design philosophy, who it serves." },
//      { name: "architecture", summary: "daemons, comms patterns, data flow, launchd plists." },
//      ...
//    ], note: "call again with { section: '<name>' } for full content" }

// with a section → full TOON content for that section
system_subctl_knowledge({ section: "policy" })
// → { ok: true, section: "policy", summary: "...", content: "<TOON>" }
```

**Section keys** (v2.7.7): `overview`, `architecture`, `components`,
`providers`, `tools`, `http_routes`, `config`, `policy`,
`cli_surface`, `update_workflow`, `secrets`, `supervisor`, `telegram`,
`orchestration`, `claude_mem`, `compact_policy`,
`diagnostic_tools`, `version_history`, `phase_3s_preview`,
`file_index`.

**Example operator questions this tool answers correctly:**

- "How does the Gated / Sealed policy mode differ from Trusted?" →
  `section: "policy"`.
- "What keys does the secrets file accept and what env vars override
  them?" → `section: "secrets"`.
- "Which HTTP routes does the dashboard expose?" → `section:
  "http_routes"`.
- "What did v2.7.3 change about compaction?" → `section:
  "compact_policy"` or `section: "version_history"`.
- "What's the channel mapping for `subctl update`?" → `section:
  "update_workflow"`.
- "What tool families does the master have?" → `section: "tools"`
  (or `system_my_tools` for the live runtime registry; the two are
  expected to agree at any released version).

The TOON file is part of every `subctl update` so the breakdown
always matches the deployed version. Module-load caching means the
daemon reads the file exactly once per restart.

### 5.5 Team-local docs — `.subctl/docs/` tool family (v2.7.10+)

The master ships a `team_doc_*` tool family that writes project-scoped
artifacts into `<project_root>/.subctl/docs/`. The folder sits next to
the existing `.subctl/policy.toml`, so subctl-managed state stays out
of the project's own `docs/` tree, the artifacts are trivially
`cat`-able from any worker pane, and they're inspectable + gitable
without going through the TCC-blocked Obsidian vault path.

| Tool | Purpose |
|------|---------|
| `team_doc_write({ project_root, relative_path, content, frontmatter? })` | Write a SPEC / PRD / ARCH / handoff / mandate doc. Creates intermediate subdirs. Optionally prepends a YAML frontmatter block (operator, account, phase, kind, …). Path traversal (`..`) and absolute paths are rejected. |
| `team_doc_read({ project_root, relative_path })` | Read back. Parses frontmatter if present; returns body in `content`. |
| `team_doc_list({ project_root, subdir? })` | Enumerate files + subdirs under `.subctl/docs/`. Returns an empty list when the folder doesn't exist (not an error — safe to probe). |
| `team_decision_log({ project_root, summary, detail?, by? })` | Append one JSON line to `<project>/.subctl/docs/decisions.jsonl`. Append-only, machine-readable. `by` defaults to `"master"`. |

```jsonc
// Persist the operator's mandate for a fresh team — frontmatter wraps it.
team_doc_write({
  project_root: "/Users/sem/code/osint-cve-monitor",
  relative_path: "SPEC.md",
  content: "# osint-cve-monitor\n\nWatch NVD + GitHub Advisories…",
  frontmatter: { operator: "jason", account: "claude-jason", phase: "baseline", kind: "spec" }
})
// → { ok: true, path: ".../.subctl/docs/SPEC.md", bytes_written: 412, frontmatter_keys: [...] }

// Log a meaningful decision for the operator to scroll back to.
team_decision_log({
  project_root: "/Users/sem/code/osint-cve-monitor",
  summary: "swapped supervisor from openai-jason to claude-jason — 5h limit on openai",
  by: "master"
})
// → { ok: true, total_decisions: 4, ts: "2026-05-12T…" }
```

**Folder layout** under any project root:

```
<project_root>/
├─ .subctl/
│  ├─ policy.toml            ← v2.7.0 policy snapshot
│  └─ docs/                  ← v2.7.10 team-local docs
│     ├─ SPEC.md
│     ├─ PRD.md
│     ├─ ARCH.md
│     ├─ mandate.md          ← v2.7.11 spawn-time wrapper (planned)
│     ├─ decisions.jsonl     ← append-only via team_decision_log
│     └─ handoffs/
│        └─ 2026-05-12-baseline.md
```

**Example operator questions this family answers correctly:**

- "Show me the SPEC for osint-cve-monitor." → `team_doc_read({
  project_root, relative_path: "SPEC.md" })`.
- "What decisions has the team made on this project today?" →
  `team_doc_read({ project_root, relative_path: "decisions.jsonl" })`
  (or list first via `team_doc_list`).
- "What handoffs do we have on holace this week?" →
  `team_doc_list({ project_root, subdir: "handoffs" })` →
  `team_doc_read` the one of interest.
- "Persist the architecture decision we just walked through." →
  `team_doc_write({ ..., relative_path: "ARCH.md", content, frontmatter })`
  followed by `team_decision_log({ ..., summary: "ARCH.md written" })`.

**Scope discipline.** v2.7.10 ships the tool surface only. The
spawn-time mandate.md wrapper (every team-create writes the operator
mandate + provenance into `mandate.md`) lands in v2.7.11. Per-template
doc skeletons + worker-side agent definitions land in v2.7.12.

### 5.6 Adding a new account

```bash
# Edit accounts.conf manually OR use the dashboard's Providers tab
# (+ New Profile button)

# Then authenticate:
ssh argent-m3-ultra-dev
subctl auth claude <alias>             # browser flow
subctl auth openai <alias>             # device-code flow if SSH'd in
                                       # (auto-detected via SSH_CONNECTION)
```

### 5.7 Spawning a dev team manually (pre Phase 3c)

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

## 6.5 CLI commands (v2.7.28)

`bin/subctl` is the bash dispatcher symlinked into `/usr/local/bin/subctl` by
`install.sh` (or `~/bin/subctl` if `/usr/local/bin` isn't writable). v2.7.28
added five operator-facing subcommands that drive the master + dashboard
fleet from any terminal — no web UI, no Telegram round-trip.

All five hit the localhost HTTP surface (`master:8788`, `dashboard:8787`).
No auth in v1 — the endpoints are localhost-only. If we expose the dashboard
to LAN/Tailscale with auth in a follow-up, the CLI grows a
`~/.config/subctl/cli-token` step (tracked as a v2 concern).

| Command | What it does |
|---------|--------------|
| `subctl status [--json]` | Probes master `/health` + dashboard `/api/version`. Versions, uptime, subscribers, active profile, Telegram listener state. Exit 1 if either is down. `--json` for scripts. |
| `subctl logs [--master\|--dashboard] [--tail N] [--follow]` | Tails launchd log files at `~/Library/Logs/subctl/` (`master.log`, `dashboard.{out,err}.log`). |
| `subctl deploy [--no-pull] [--dry-run]` | `git pull --ff-only` + `launchctl kickstart -k gui/$(id -u)/com.subctl.{master,dashboard}`. The fast path. For careful upgrades (stash, version bracket, doctor) use `subctl update`. |
| `subctl notif [recent\|list <N>\|mark-all-read]` | Wraps `/api/notifications` (master ring buffer via dashboard proxy). |
| `subctl memory [recent <N>\|search <query>\|remember <text>]` | Wraps `/api/memory/*` → master Evy Tier 3 SQLite. |

Implementation lives in `lib/cli.sh`. Tests in `lib/__tests__/cli.test.ts`
stand up throwaway `Bun.serve` fakes on ephemeral ports so the suite runs
green without a live daemon. Run `bun test lib/__tests__/cli.test.ts`.

Install path: `bin/subctl` → `/usr/local/bin/subctl` (or `~/bin/subctl`).
`install.sh` handles this — no extra step needed after a normal install.

Fuller subcommand reference: [docs/cli.md](./cli.md).

---

## 7. Decision log (this doc)

- 2026-05-13: v2.7.28 ships the operator CLI bootstrap (`status` / `logs` / `deploy` / `notif` / `memory`) on the existing bash dispatcher rather than spawning a parallel Bun executable — install path stays put, dependency floor unchanged (curl + jq, already required by `doctor`/`usage`/`update`).
- 2026-05-10: Adopt Hermes Agent core's tiered memory architecture (§3). Three tiers, claude-mem stays as tier-2 provider, tier-1 (memory.md/user.md) is the next near-term build (Phase 3e).
- 2026-05-10: Personal skill authoring constrained to `master` source + category allow-list (§3.6) — ship after template-driven spawn lands so we can dogfood with real teams.
- 2026-05-10: Document is the source of truth. Update this file when designs change; do not let architectural choices live only in commit messages.
