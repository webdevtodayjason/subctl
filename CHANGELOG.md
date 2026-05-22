## [2.8.16] — 2026-05-22

### `fix(cognee-promotion): entityId override now reaches listCurated SQL query`

v2.8.15 shipped the Tier 3 → Tier 4 promotion ticker, but post-deploy validation found it silently scanned 0 rows for 8+ hours. Root cause: `_setCogneePromotionDepsForTesting({ entityId: () => "jason" })` in server.ts only overrode `deps.entityId` — but the default `listCurated` closure embedded `_realEntityId()` directly, which falls back to `"operator"` when `SUBCTL_OPERATOR_NAME` env is unset. SQL query ran with `WHERE entity_id = "operator"`, returning 0 of 222 curated rows. No errors recorded (no errors to record), no log lines (only logs when scanned > 0), pure silent no-op.

**Fix:** `listCurated` interface now takes `entityId` in args. `runOneTick` passes `deps.entityId()` so the server-side override actually reaches the SQL query.

**Validation:** new test pins the contract — `listCurated` must receive `entityId` from `deps.entityId()` override, not from any default fallback.

## [2.8.15] — 2026-05-21

### `feat(memory): Cognee write path — Tier 3 → Tier 4 promotion ticker`

Cognee has been running healthy since v2.8.7 but with only 3 memories from a one-time May 18-19 backfill. The cognee-client module exported `remember()` but master never imported it — the read path (memory_search, memory_timeline) was wired through `recall()`, but no code anywhere called `cogneeClient.remember()` to ingest. Result: Tier 4 graph was effectively frozen while Memori (Tier 3) accumulated 1046 observations, 221 marked `total_curated`.

**Fix:** New `cognee-promotion` ticker runs every 10 min, pulls recently-curated Memori entries (post-watermark) directly from `subctl_memori_curated` via a read-only `bun:sqlite` open of `~/.config/subctl/master/memori.db`, and ingests them into Cognee via `cogneeClient.remember()`. Tuple watermark `(last_promoted_ts, last_promoted_id)` + error log persist to `~/.config/subctl/master/cognee-promotion.json` so restarts don't re-ingest. Tuple — not bare-ts — because the curated table is keyed `(id TEXT PRIMARY KEY, ts TEXT)`; multiple promotions in the same millisecond would silently drop with a ts-only watermark.

**Observability:** New diag tool `system_cognee_promotion_self` exposes `last_run_at_ms`, `last_watermark_ts`/`_id`, `total_promoted`, recent errors, configured interval, and armed flag (live runtime state, flipped false on arm failure / shutdown). Each non-empty tick logs `[cognee-promotion] tick — promoted=N errors=M watermark=<id> elapsed=Mms` and broadcasts `cognee_promotion_tick_success` on the SSE bus; ticks that throw broadcast `cognee_promotion_tick_error` plus a warn-severity notification. Boot-time disarms (Cognee unreachable, arm threw) also emit warn notifications.

**Config:** `SUBCTL_COGNEE_PROMOTION_INTERVAL_MIN` (default 10, min clamped to 1 minute).

**Gates:** Ticker arms only when `TOOL_GATES.cognee && memori && memory_kernel` AND both the Memori sidecar AND a live Cognee health probe come back reachable at boot. Failure to reach either at boot → ticker stays disarmed until the next master restart (same shape as the memory-kernel arm gate).

**Backfill path:** The existing `/memory/backfill/claude-mem-to-cognee` endpoint remains for one-shot bulk loads of historic claude-mem observations. The new ticker handles forward flow of curated Memori entries automatically — operators don't need to invoke it.

**Why SQL-direct vs. a new sidecar endpoint:** Adding a `list_curated_since` endpoint would require a Python change in `services/memori/server.py` — out of scope for this hotfix. The curated table lives at a known path, the schema is stable, and we open it `readonly: true` so we can never contend with the sidecar's writes. The HTTP path through memori-client.ts is preserved unchanged.

## [2.8.14] — 2026-05-21

### `fix(watchdog): re-classify on pane-hash change to suppress false completed_idle escalation`

v2.8.13 ships Phase 4. Hours later, the operator caught a watchdog false-positive on
team `claude-birdie`: worker replied twice via tmux pane with "work complete, idle by
design"; watchdog kept escalating every 30 min as if no reply happened.

Root cause: classification only ran on inbox.jsonl arrivals
(`components/master/server.ts:2192`, `:2234`). When a worker replied via the tmux
pane (the auto-nudge response path), `classifyWorkerReply` never re-ran. Pane-hash
bump path at server.ts:5177 preserved the stale `classification` from spawn time
("working"), so `decideTeamAction`'s `completed_idle` short-circuit at
auto-nudge.ts:193 never fired.

**Fix:** When pane-hash changes, capture pane content via `tmux capture-pane` and
re-run `classifyWorkerReply` on the actual text. Falls back to preserved
classification on capture failure.

**Observability:** Watchdog state now exposes per-team `last_nudge_at_ms`,
`last_reply_at_ms`, `reply_classification`, and `completion_flag` so future
false-positives are debuggable from the diag tool.

Repro: spawn team → wait for completion → idle worker replies once → without
this fix, watchdog escalates every 30 min indefinitely. With fix: classification
flips to `completed_idle` on the worker's next pane update, escalation suppressed.

## [2.8.12] — 2026-05-21

### `fix(mcp): send_message actually triggers Evy's drain loop`

v2.8.11 shipped 10 new MCP tools including `send_message`. The wiring in `server.ts` pushed to `promptQueue` and broadcast a `queued` event, but **didn't call `dispatchToAgent`** — the function that owns the drain loop. Net effect: MCP-queued prompts sat in the queue forever; Evy never picked them up. Operator surfaced this minutes after deploy when Claude Desktop's `send_message` → `recent_messages` round-trip returned no Evy reply.

**Fix:** `enqueuePrompt` now calls `dispatchToAgent(text, "mcp")` (fire-and-forget). The dispatch function handles the drain loop, the broadcast, the in-flight guard, and the agent turn. The MCP tool returns the queue depth synchronously; the caller polls `recent_messages` for Evy's reply (rather than blocking through a potentially minutes-long agent turn).

Also:
- `PendingPrompt.source` union extended to include `"mcp"` (was `"chat" | "telegram" | "watchdog"`).
- `dispatchToAgent` signature extended to accept `"mcp"`.
- `processOnePrompt`'s "treat as operator intent" gate (which resets the circuit breaker + drains background completions) now includes `mcp` source alongside `chat` and `telegram`. MCP prompts ARE operator intent — they just arrive via Claude Desktop / ArgentOS / any external MCP client instead of the dashboard or Telegram.

### Repro pre-fix

```
Claude Desktop → send_message("hi Evy") → ok, queue_depth=1
Claude Desktop → recent_messages → no new turn  ← stuck
master /health → uptime growing, no queue progress
master.log → no [agent] turn started entry
```

### Repro post-fix

```
Claude Desktop → send_message("hi Evy") → ok, queue_depth=1
master.log → [agent] turn started — source=mcp
                ← Evy processes through dispatchToAgent
Claude Desktop → recent_messages (a few seconds later) → Evy's reply present
```

---

## [2.8.11] — 2026-05-21

### `feat(mcp): wave-3 tool surface — usable control plane (was a demo)`

v2.8.7 shipped MCP with 3 tools (ping / state_snapshot / notify). Live-testing from Claude Desktop tonight made the gap obvious: you could see basic state and emit a notification, but you couldn't talk to Evy, read what she'd been doing, supervise workers, or recall memory. Per the operator: *"That's a very light, non-usable MCP connection."*

This release adds 10 tools across four tiers, turning MCP into an actual control plane.

### Tier 1 — talk to Evy (write + read)

- **`send_message`** — Posts a prompt into master's `/chat` queue. Evy processes on her next turn just like a dashboard chat message. Returns queue depth so the caller can correlate.
- **`recent_messages`** — Tails master's transcript (last N turns including user prompts, Evy's replies, tool calls). Use after `send_message` to read Evy's response.

### Tier 2 — read state with content

- **`recent_decisions`** — Tails master's append-only `decisions.jsonl`. Last N entries — watchdog actions, memory promotions, sweep classifier outcomes. The audit trail.
- **`list_notifications`** — Actual notification content (not just counts that `state_snapshot` returns). `unread_only` filter + `limit`.
- **`watchdog_state`** — Currently-watched teams + last fire reason + tick/fire timestamps. MCP equivalent of `system_watchdog_self`.

### Tier 3 — supervise worker teams

- **`list_teams`** — Active orch/team tmux sessions (mirrors `subctl team list`).
- **`team_inbox`** — Read a team's `inbox.jsonl` — last N events the team has reported.
- **`team_msg`** — Send an HMAC-signed directive to a team. Body is wrapped in SPEC block per v2.8.8 contract, signed with team's secret, routed via dashboard `/api/orchestration/:name/msg`.
- **`team_kill`** — Archive inbox + tear down tmux session. Mirrors `subctl team kill`.

### Tier 4 — memory recall

- **`memory_search`** — Semantic + lexical recall across cognee (graph) + memori (Tier 3 SQLite). Returns scored hits with `source` attribution per substrate.
- **`memory_timeline`** — Recent observations newest-first.

### Concrete use cases now unlocked

| From Claude Desktop, you can | Tools used |
|---|---|
| "What's Evy been deciding the last hour?" | `recent_decisions(limit=20)` |
| "What teams are running and what's their last event?" | `list_teams` → `team_inbox` for each |
| "Tell Evy to check on the claude-richard-dash team" | `send_message(...)` → wait → `recent_messages` |
| "Search memory for what we decided about the SPEC contract" | `memory_search("SPEC directive contract")` |
| "Send claude-richard-dash a follow-up directive" | `team_msg("claude-richard-dash", "<spec>", phase="follow-up")` |

### Architecture notes

Each provider is a thin shim over an existing master internal: `enqueuePrompt` → `promptQueue.push`; `getRecentMessages` → `agent.state.messages.slice(-limit)`; `getRecentDecisions` → tails `decisions.jsonl` from disk; `getWatchdogState` → reuses the in-process state vars that the diag tool already binds; `listTeams` → shells to `tmux list-sessions`; `sendTeamMsg` / `killTeam` → fetch through the dashboard's existing `/api/orchestration/:name/{msg,kill}` endpoints (which already handle HMAC + SPEC wrap from v2.8.8); memory tools → existing `cognee-client` + `memori-client` recall functions.

All wave-3 providers are optional in the `McpToolProviders` interface. If a provider isn't wired, the corresponding tool isn't registered. Older clients calling tools that aren't there get a clean SDK-level "tool not found" instead of a runtime error.

### Tests

- All 12 prior MCP tests continue to pass (wave-1 + wave-2 + multi-client regression).
- The wave-3 tools were live-validated against the running master:
  - `recent_decisions` returned the 22:14:23Z `team_completed_idle` decision (WEB-216 evidence preserved).
  - `list_teams` correctly enumerated `claude-richard-dash`.

### What's intentionally NOT included

- **MCP resources** (the "right" pattern for read-side state per task #26). Tools work fine for the operator's use case tonight; resources are nicer but a bigger refactor. Deferred to a proper #26 wave.
- **MCP subscriptions** (live state push) — same reasoning.
- **memory_remember / memory_forget** — write-side memory ops. Skipped because Evy already curates memory via the consciousness loop; an external MCP client writing directly would compete with that pipeline. Add later if a real use case appears.

---

## [2.8.10] — 2026-05-21

### `fix(mcp): per-session McpServer + transport — multi-client coexistence`

The MCP server couldn't host two clients at once. First client to initialize "owned" the global `McpServer` instance; second client (e.g. Claude Desktop's mcp-remote bridge connecting after our smoke-test curl) hit `Invalid Request: Server already initialized` (`-32600`) at the SDK's protocol-layer guard and crashed.

**Root cause:** `components/master/mcp/server.ts` had ONE `McpServer` + ONE `WebStandardStreamableHTTPServerTransport` bound globally. The SDK's transport tracks `_initialized` state per transport instance — and rejects subsequent initialize requests on an already-initialized transport. The single-transport pattern only works for single-client scenarios (Cloudflare Workers, Hono one-shot). Multi-client streamable HTTP requires per-session transport + server pairs.

**Fix:** session map keyed by `mcp-session-id`. Each new session spawns its own transport + McpServer + tool registration. The SDK's `onsessioninitialized` callback registers the pair as soon as the session-id is minted; `onsessionclosed` reaps it. Subsequent requests carrying `mcp-session-id` route to the existing session.

Side effect: `McpServerHandle.mcp` removed (there's no longer a single global McpServer to expose). Tool registration happens via the `registerCapabilities` callback per session, which was already the integration contract — no caller used `handle.mcp` directly except a duck-type sanity test that's been updated.

### Tests

- New regression test in `mcp-handshake.test.ts`: two callers (`client-A`, `client-B`) both init successfully, both get distinct session-ids, both can call `tools/list` independently.
- `mcp-handshake.test.ts` and `mcp-tools.test.ts` continue to pass — the public surface is unchanged for the single-client happy path.
- Updated `McpServer handle exposes the underlying SDK server` test to assert the new shape (no `.mcp` field).

### Repro pre-fix

```
$ curl -i /mcp -d '{"method":"initialize",...}'  # → 200, session-id=A
$ curl -i /mcp -d '{"method":"initialize",...}'  # → 400 "Server already initialized"
```

### Repro post-fix

```
$ curl -i /mcp -d '{"method":"initialize",...}'  # → 200, session-id=A
$ curl -i /mcp -d '{"method":"initialize",...}'  # → 200, session-id=B (independent)
```

### Why this matters tonight

Claude Desktop's `mcp-remote` HTTP bridge initialized fine when alone but failed once a second client (test curl, another Desktop session, ArgentOS) shared the master. Without this fix the MCP integration is single-tenant at runtime — defeating the operator-setup use case where multiple Claude Desktop / Claude Code / dev session clients should all be able to connect simultaneously.

---

## [2.8.9] — 2026-05-20

### `fix: subctl deploy and install no longer leave new boxes half-deployed`

The credibility-killer hotfix on the back of v2.8.8. v2.8.8 surfaced the bug, this release closes it.

**The bug.** Local Mac had been the development environment for months; every other Mac (M3 Ultra, future fresh installs) was a guinea pig waiting to crash-loop. v2.8.6 → v2.8.8 added `@modelcontextprotocol/sdk` as a master dep, but `subctl deploy` (the fast-path verb that operators run after `git pull`) only ran `git pull` + `launchctl kickstart -k` — it never reran `bun install`. M3 Ultra pulled the new TS files, kickstarted master, and got `Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'` because `components/master/node_modules/` was still at v2.8.6 state. The same gap would bite any pre-existing install at any future update where master's deps changed.

Separately, three operator-owned config artifacts — cognition loop, idle-pane watchdog, MCP token — were never written by the installer. A fresh `subctl install` on a new box came up with cognition loop disabled, idle-pane watchdog disabled, and MCP server unconfigured. The operator had to manually touch each file to opt in. "First 10 minutes magical" was not magical.

### Fix A — `subctl deploy` runs `bun install` in changed subtrees

`lib/cli.sh subctl_cli_deploy` now captures BEFORE sha, runs git pull, captures AFTER sha, then scans `git diff --name-only BEFORE..AFTER` for any `*/package.json`. For each affected subtree (master, dashboard, future), runs `bun install` BEFORE the launchctl kickstart loop. If bun install fails, deploy aborts with a clear "fix bun install before kickstart — daemon would crash-loop" error rather than restarting into a guaranteed-broken state.

This mirrors the existing `subctl update` ceremony (lines 837–862 in `lib/update.sh`, which already had this logic). The asymmetry between the two verbs was the bug. They now behave identically for deps.

### Fix B — `subctl install` seeds sane defaults

New `subctl_install_seed_operator_configs()` in `install.sh`, invoked from `component_install` right after the master daemon install. Three idempotent seed steps:

1. **Cognition loop config** — writes `~/.config/subctl/master/consciousness-loop.json` with `{"enabled": true}` if missing. Existing configs are NEVER overwritten.
2. **Idle-pane watchdog config** — writes `~/.config/subctl/master/idle-pane-watchdog.json` with `{"enabled": true, "auto_retry_enabled": false}` if missing. Notify-only — the operator opts into auto-retry when matched-directive detection has audit evidence.
3. **MCP token mint** — if `secrets.json` lacks `subctl_mcp_token`, mint a fresh `openssl rand -hex 32` value and merge it in via `jq` (falls back to direct write if jq isn't available). Without this the MCP server stays disabled at boot, which silently breaks Claude Desktop and external MCP-client integrations.

The operator-override contract is preserved exactly: existing configs are left untouched. Re-running the installer is idempotent. The seed only fires for files that don't already exist.

### Why this matters

Without this fix the project's update story was broken in a way that defeated the "supervised, memory-backed local dev team" positioning Hermes flagged in [[design/2026-05-20-hermes-strategic-feedback]]. Any new operator standing up subctl on a fresh box would have to manually mint a token, write two config files, and run `bun install --force` to get the system into the state the docs describe. That was incompatible with "first 10 minutes magical."

### Commit ledger

| SHA | Title |
|---|---|
| _TBD_ | fix(deploy): bun install in changed subtrees + seed sane operator configs |
| _TBD_ | chore(release): VERSION → 2.8.9 + CHANGELOG entry |

### Validation

Before v2.8.9: `ssh m3 && subctl deploy` on a v2.8.6 → v2.8.8 update crashed master with `Cannot find module '@modelcontextprotocol/sdk'`. After v2.8.9: the same flow detects the changed `components/master/package.json`, runs `bun install`, and kickstarts cleanly.

---

## [2.8.8] — 2026-05-20

### `feat: SPEC contract + WEB-216 watchdog fix + cognee CLI + xai-oauth provider`

**~22 commits since v2.8.7.** Two surgical fixes operator-driven this session, plus uncommitted-feature backlog finally landed. Highlights:

**SPEC directive contract.** HMAC-signed worker directives now require an embedded `SPEC:` block in the body. New `buildSignedDirective()` in `components/master/trust-marker.ts` wraps `body` with `"SPEC:\n  <indented>"` BEFORE computing the HMAC; dashboard `/api/orchestration/<name>/msg` is the single emitter. Workers refuse markers without SPEC with the exact reply `"directive missing SPEC block; re-send with embedded spec"`. HMAC proves WHO; SPEC proves WHAT. Triggered by an in-flight observation: a worker correctly refused a "submit the pasted prompt and start" directive because the paste-then-start delivery dropped the body. The friction was the brittle two-step delivery, not over-cautious workers. Closes that false-refusal class permanently.

**WEB-216 — false unresponsive alerts.** Three bugs collapsed to one symptom: failed-nudge advancing `last_nudge_at_ms` on Claude API 529 (worker never received the nudge); worker reply text never classified into states; alert body showing `Last event: unknown` even when pane data was available. Fix: don't advance state on failed delivery (sweep cadence IS the backoff); new `classifyWorkerReply()` returns `working` / `completed_idle` / `awaiting_input` / `blocked` with permissive phrase matching (`idle by design`, `awaiting next directive`, `awaiting shutdown`, etc.); `decideTeamAction` short-circuits stale-but-completed teams BEFORE the escalate branch; alert body surfaces classification + reply snippet. Live-validated 2026-05-20T22:14:23Z — first `team_completed_idle` decision in production on `claude-richard-dash` (same team had been firing `team_unresponsive` every ~30 min for 4 hours before the fix).

**Cognee operator-facing CLI.** New `subctl cognee {status|install|uninstall|ping|cognify}` mirrors the memori CLI shape exactly. The sidecar itself (services/cognee/, lib/cognee.sh) shipped in v2.8.7; this CLI plus the install.sh `service-launchd` install_method + dep-manifest entry close Memory Init #1 to "first-class, self-installing." Operator can `subctl cognee install` on a fresh box and the Tier 4 substrate comes up.

**xAI Grok OAuth (SuperGrok Subscription).** First-class subctl provider — end-to-end port of Hermes Agent's xAI PKCE-loopback flow into self-contained TypeScript owned by the master daemon. OIDC discovery with HARD HOST-PIN validation. PKCE-S256 loopback login. Refresh-on-near-expiry. Public client / no client_secret. pi-ai resolver shim is sync (returns valid token immediately, kicks background refresh inside the 120s skew window with in-flight dedup). New `SUBCTL_ONLY_PROVIDERS` registry in `pi-ai-catalog.ts` for synthetic providers subctl plumbs that pi-ai's `getProviders()` doesn't know about. New CLI: `subctl auth xai-oauth <alias>`.

**Dashboard update modal.** Closes task #17 properly — `be323fe` (v2.8.7) wired the lazy-import on the version chip but never staged the modal file. Modal was silently broken on every chip-click since v2.8.7. This release ships the actual `dashboard/public/update-modal.js` with three modes (dashboard-deploy / fast-deploy / full-update) + live `update_progress` SSE stream.

**Hermes/GPT-5.5 positioning input** captured at `Documents/Obsidian Vault/Subctl/design/2026-05-20-hermes-strategic-feedback.md` — subctl is "product-shaped" now; next move is polish (docs/version drift fix, sharpened landing, magic first 10 min, canonical "3 agents overnight" hero demo, name the primitives publicly, hide Memori/Cognee internals behind advanced docs). Captured as a separate work track from the feature backlog.

### Commit ledger

| SHA | Title |
|---|---|
| `a6cb6e6` | feat(directives): require SPEC block in worker directives |
| `71d6766` | fix(watchdog): WEB-216 — false unresponsive alerts after worker completes |
| `57e6017` | feat(cognee): operator-facing CLI + auto-install for Cognee sidecar |
| `b11d783` | feat(xai-oauth): SuperGrok subscription OAuth as first-class subctl provider |
| `ae55cfd` | feat(dashboard): ship update-modal.js — close task #17 properly |
| `+ docs` | backfill 7 untracked .subctl/docs artifacts from 2026-05-18..-19 |
| `+ chore` | VERSION → 2.8.8 + CHANGELOG entry + HANDOFF refresh + .gitignore |

### Tests

14 new test cases this release (3 trust-marker, 11 auto-nudge) plus 1,334 LOC of xai-oauth coverage across 4 test files. Master suite delta: +68 passing tests.

### Linear

- [WEB-216](https://linear.app/webdevtoday/issue/WEB-216) — fix landed, live-validated, awaiting Evy review for close.

---

## [2.8.7] — 2026-05-19

### `feat: The Memory Release — Evy used to forget, now she remembers`

**123 commits since v2.8.5.** The headline is the memory layer: an autonomous consciousness cycle that watches Evy's conversations, promotes durable signal into a curated layer, and feeds her system prompt at turn time. Add to that: Cognee for graph reasoning over your operator history, Memori for execution audit, a tokenizer adapter so embeddings stay local, a background-task runtime so long-running tools don't block her turn, and ~100 supporting commits in OAuth, install hardening, dashboard UX, and reliability. Master 2.8.6 → 2.8.7.

This was operator-asked verbatim back when we kept hitting "51st date syndrome" — Evy waking up cold every restart, the operator re-pasting context, the same questions twice. v2.8.7 closes that loop:

> "Memori remembers what happened. Cognee understands how it connects."  
> "Replace ad-hoc vector-only recall where it exists. Replace scattered 'memory search but maybe it's in docs' ambiguity. Do not replace Tier 1 profile facts, Obsidian, .subctl/docs/, or raw append-only decision logs."

That framing locked the architecture. Tier 1 (always-injected `memory.md`) stays as-is — it's already operator-curated. Tier 5 source-of-truth surfaces (Obsidian, `.subctl/docs/decisions.jsonl`) stay untouched — they're canonical. Tier 3 gets a Memori-backed substrate with auto-capture. Tier 4/5 semantic recall gets a Cognee-backed substrate with graph traversal. And a new memory-kernel runs the consciousness cycle between them.

**Memori sidecar — Tier 3 substrate.** `services/memori/server.py` is a Python HTTP service that fronts `memorilabs.Memori` with BYODB SQLite at `~/.config/subctl/master/memori.db`. Lives at `127.0.0.1:8746`. Why a sidecar: the npm `@memorilabs/memori` package is cloud-only and the BYODB path is Python-only, so we put Python in a launchd-managed service and have master talk to it via fetch — same pattern as `services/tts/server.py`. The sidecar runs in two modes: `augmentation=off` (default — pure SQLite, lexical recall, **no content leaves the box**) or `augmentation=on` (requires `pip install memori` + `MEMORI_API_KEY`, conversation content flows to memorilabs.ai for LoCoMo-style structured fact extraction; raw records still local). New CLI: `subctl memori [status | install on/off | uninstall]`. New `evy_remember` / `evy_recall` route through Memori with the local evy-memory store as a safety-net fallback so operator data is never lost on sidecar failure.

**Cognee sidecar — Tier 4/5 semantic substrate.** `services/cognee/server.py` is the Python HTTP wrapper around Cognee 1.1. Lives at `127.0.0.1:8745`. Per operator's standalone-first requirement: subctl ships its own Cognee install — not shared with ArgentOS by default. Operator can point at ArgentOS's instance via `COGNEE_SERVICE_URL` if they want the shared-brain pattern. Endpoints: `/health`, `/remember`, `/recall`, `/forget`, `/cognify`, `/graph/neighbors`, `/graph/path`, `/graph/query`. New CLI: `subctl cognee [status | install | uninstall | ping | cognify]`. `memory_search`, `memory_timeline`, `memory_observations` route through Cognee when reachable and fall back to claude-mem otherwise — output gains a `source: "cognee" | "claude-mem" | "both-empty"` field so callers see which substrate answered.

**Tokenizer adapter — the local-embeddings unblock.** `services/cognee/tokenizer_adapter.py` solves a specific Cognee 1.1 compatibility wall: cognify's chunking pipeline calls `tiktoken.encoding_for_model(model_name)` to count tokens before sending to the embedder. tiktoken's registry only knows OpenAI model names, so `text-embedding-nomic-embed-text-v1.5` throws `KeyError`. Our adapter is a registry-based resolver that intercepts the tokenizer lookup at sidecar import time (BEFORE `import cognee`), wraps `transformers.AutoTokenizer.from_pretrained("nomic-ai/nomic-embed-text-v1.5")` to expose tiktoken's `encode/decode/n_vocab` shape, and is idempotent. OpenAI tokenizer behavior is preserved. Adding a new local embedding model (BGE, GTE, E5, whatever) takes a one-line registry entry — no Cognee fork, no monkey-patch sprawl. Vanilla Cognee remains upgradeable. Fails loud on unknown non-OpenAI model with a clear pointer back to the registry; no silent cl100k fallback.

**Memory consciousness cycle — `components/master/memory-kernel.ts` + `memory-kernel-reviewer.ts`.** Watchdog tick every 5 minutes. Each cycle:

1. Pull up to N unreviewed raw events from Memori (`/select_unreviewed`).
2. Hand them to the reviewer along with operator context (Tier 1 profile, recent curated facts, active project).
3. The reviewer calls the configured supervisor LLM with Evy's exact JSON contract:

```json
{
  "decisions": [{
    "source_event_ids": ["..."],
    "action": "discard|keep_raw|promote_tier3|propose_tier1|escalate",
    "memory": "one concise durable sentence, if promoted",
    "kind": "decision|preference|finding|project-state|operator-note|design-note",
    "reason": "short rationale",
    "confidence": 0.0
  }]
}
```

4. Decisions are dispatched per the promotion policy:
   - `discard` → mark_reviewed=discarded.
   - `keep_raw` → mark_reviewed=reviewed.
   - `promote_tier3` AND confidence ≥ 0.7 → call /promote (writes a curated row to `subctl_memori_curated`) then mark source rows as promoted. Confidence < 0.7 → mark reviewed but skip the write (logged as "low-confidence promotion candidate").
   - `propose_tier1` → append to the Tier 1 candidate queue (`~/.config/subctl/master/tier1-candidates.jsonl`) for explicit operator review via `subctl memory tier1 [pending|approve|reject]`.
   - `escalate` → mark_reviewed=escalated, emit a `severity: "warn"` notification so the operator sees the contradiction immediately.

5. Each cycle appends a `memory_kernel_cycle` row to `decisions.jsonl` with N reviewed, P promoted, T tier1-candidates, E escalated.

State persists at `~/.config/subctl/master/memory-kernel-state.json` — pause/resume survives restart. New CLI: `subctl memory kernel [status | run-now | pause | resume]` and HTTP endpoints under `/memory/kernel/*`. Reviewer model is configurable via `providers.json#models.reviewer` — point it at LM Studio gemma, an oMLX endpoint, Ollama, anywhere OpenAI-API-compatible. Reviewer cycles are reentrant-safe (one in flight at a time) and gracefully no-op when the sidecar isn't reachable.

**Phase 4 — prompt hydration.** Worker B1's specific deliverable. `composeSystemPrompt` now prepends the most-recent curated Tier 3 facts to Evy's system prompt header at turn start, budgeted at ~2000 chars with longest-first truncation. Curated recall is cached for 60s so we don't hit the sidecar every turn. This is what closes the loop: instead of carrying a 16k-char compaction summary that gets thinner each cycle, Evy walks into every turn with the operator's durable preferences and recent decisions already in her prompt. Survives `+ new chat` resets. After Phase 4 Evy answers "what did we decide about X?" from curated memory without searching — the difference between "every restart is cold" and "she actually knows you."

**Tier 1 candidate queue — `components/master/tier1-candidates.ts`.** The `propose_tier1` decision branch used to log "tier1-proposal-deferred" and drop the candidate. Now it appends to a JSONL queue file and surfaces three tools: `memory_tier1_pending`, `memory_tier1_approve`, `memory_tier1_reject`. Operator-facing CLI: `subctl memory tier1 pending`. Approval routes through the existing `memory_remember` path so the Tier 1 char-budget guardrails apply. Append-only — approve/reject = new line with `resolution` set, never mutates prior lines. Active when this release ships: 4 candidates queued during boot smoke tests including operator preferences ("more frequent check-ins to prevent agents from sitting idle") and infra facts.

**Backfill scripts.** `subctl memory backfill [evy-to-memori | claude-mem-to-cognee | obsidian-to-cognee]` with `--dry-run` and `--limit`. NOTHING auto-runs at boot. Idempotent via deterministic source-id markers — re-runs skip already-ingested rows. Dry-run on the operator's actual store reported planned=579 evy-memory entries ready to migrate to Memori, claude-mem-to-cognee skipped cleanly when Cognee was unreachable (`{ok:false, error:"Cognee unreachable"}`), obsidian-to-cognee walked the vault and surfaced the entry count.

**`knowledge_graph_*` tool family.** New `knowledge_graph_neighbors`, `knowledge_graph_path`, `knowledge_graph_query` tools wrap Cognee's graph endpoints. Gated on Cognee reachability — they don't show up in Evy's registry until the sidecar is alive, and surface clean errors when graph extraction hasn't run yet. After `subctl cognee cognify` completes against the backfilled obsidian corpus, queries return real structured paths: `subctl` node → "AI subscription orchestrator" → neighbors with `DECIDED_BY`, `TOUCHED_FILE`, etc. relations. This is the multi-hop reasoning layer Evy's research called out as the missing piece.

**Boot-probe retry-with-backoff — the false-UNREACHABLE fix.** `components/master/probe-with-retry.ts` wraps the cognee + memori boot probes in exponential backoff (1.5s → 3 → 6 → 12 → 24, capped 30s total, 6 attempts). Quiet intermediate logs (`[cognee] not yet reachable (attempt 1/6, will retry in 1.5s)`); loud `UNREACHABLE` only on final exhaustion. The Python sidecars take 5–15s to import their SDKs, and master used to log a false UNREACHABLE on every cold boot before the retry pattern. Operator-asked, operator-shipped.

**Background-task runtime — `components/master/background-runs.ts`.** Generic fire-and-forget for tools that take >15s and shouldn't block Evy's turn. State persists at `~/.config/subctl/master/background-runs.json`; orphaned in-flight runs get marked failed on master restart (with the reason `"lost on master restart"`). Three new tools: `background_run` (generic dispatcher — takes a tool name and args), `background_status`, `background_cancel`. Plus `tinyfish_agent_async` as the discoverable named variant. Completion results don't get injected into the transcript (that pattern hits provider-pairing rejects, learned the hard way) — instead they're prepended to the operator's next chat/telegram message. Tray notifications fire alongside. Phase A scope landed in the overnight orchestration block.

**OAuth + provider work.** OpenAI Codex device-code OAuth lands first-class: `subctl auth openai-codex <alias>` mints fresh tokens via in-process device-code flow, dashboard Providers tab has a re-auth modal, master auto-refreshes 5 min before exp. Per-model `enabled` toggle in the dashboard Models panel — chat dropdown honors `models[].enabled`. Operator-selectable default model per provider via `~/.config/subctl/provider-defaults.json`. Live catalog refresh for openai, google, mistral, openrouter. Anthropic-provider hard-fail guard (ADR 0019) — `buildModel(provider="anthropic", ...)` refuses without explicit opt-in to prevent accidental Anthropic API usage when the operator intended a different provider. LM Studio `cache_prompt: true` injected via pi-ai `onPayload` hook for ~55% expected warm-turn speedup on identical system-prompt prefixes. Tier-2 lazy tool registration gates 7 tool families (gh, coderabbit, context7, linear, tinyfish, voice, skillRouter) on env/config presence — registry sized to what's actually configured.

**Workers + MCP propagation.** New `account-pool-rotation` skill teaches Evy to rotate accounts when spawning hits auth failures. HMAC recipe in worker boot prompt is now unambiguous with a self-test vector eliminating a class of worker auth confusion. TinyFish + Ghost MCPs now propagate to spawned Claude Code worker `CLAUDE_CONFIG_DIR`s via `providers/claude/teams.sh _provider_claude_drop_mcp_config()` — workers inherit the same MCP surface their parent runs with.

**Dashboard + UX.** New `↻ restart master` button in the chat toolbar — operator can kickstart the daemon from the UI, polls `/api/master/health` for the new `uptime_s` to confirm. New `🔇/🔊 voice` toggle in the chat toolbar — flips `voice.json#enabled` via `/api/voice/config`; state mirrors the existing `voice_config` SSE event. Catalog dashboard endpoints (`/api/catalogs`, `/api/catalogs/<provider>`, `/api/catalogs/<p>/refresh`, `/api/catalogs/<p>/models/<id>/enabled`). Template-spawn errors now surface structured `{error, error_kind}` so the supervisor can route around user errors instead of treating every 4xx as 500 (`dashboard/lib/spawn-errors.ts`).

**Reliability fixes.** 23 pre-existing test failures cleared in one sweep — `bin/subctl` v2.7.36 verb dispatch restored after a monolith→modules refactor lost it, hardcoded version string replaced with `CURRENT_VERSION`, LM Studio Bearer-header tests rewritten to invariant assertions, `\$EDITOR` here-doc escape bug. Orphan `toolResult` drop on compaction — fixes the Codex `HTTP 400: "No tool call found for function call output with call_id …"` that interrupted operator chat. Two-layer defense: compactor sweeps before save, loader sweeps on every boot. Voice install + uninstall verbs restored in `lib/cli.sh` (lost in monolith refactor). Specforge intake-notes auto-advance (Evy's loop-failure bug — operator caught her getting stuck re-asking for the same dimension). Reasoning-channel markers stripped on Telegram outgoing path. Stale team-staleness watchdog unregisters dead teams. Providers tab `loading…` stuck state fixed (`renderModelsList` was using `await` without being declared `async`). `subctl dashboard deploy` smoke-check added — verifies the redeployed dashboard answers `/api/version` before claiming success.

**Architecture decisions locked in this release.**

- *Knot #1* — Cognee runs as a standalone subctl-owned sidecar. Shared-with-ArgentOS is available via `COGNEE_SERVICE_URL` override but the default install is standalone. Imagined-with-ArgentOS-elsewhere principle.
- *Knot #2* — Memori BYODB starts on SQLite at `~/.config/subctl/master/memori.db`. BYODB interface kept abstract enough to migrate to Postgres later when M3+MacBook+R750 sharing becomes real.
- *Sidecar pattern* — both Cognee and Memori run as local Python HTTP services because their Python SDKs don't fit subctl-master's Bun runtime. Mirrors `services/tts/server.py` and reuses the launchd-plist install path.
- *Tool surface stability across substrate swaps* — `memory_search`, `evy_recall`, etc. keep their names + schemas across the Tier 3/4 substrate migration. Output gains a `source` field so callers see which substrate answered. Evy's persona + SKILL.md don't need rewrites.
- *No conversation content leaves the box* in default install. Cloud augmentation is opt-in.
- *`knowledge_graph_*` is a separate tool family*, not an extension of `memory_*`. Graph traversal is structurally different from relevance recall.

**Test counts.** 127 / 0 in the memory subsuite (10 test files). 808 / 5 overall master suite. The 5 failures are LM Studio Bearer-header back-compat tests that broke when `lmstudio_api_token` got populated with the oMLX key (operator's thermal-preservation swap). Not memory regressions; tracked separately.

**Operator activation paths.**

```bash
# Install the sidecars (one-time per box)
subctl memori install off       # local-only mode, no cloud egress
subctl cognee install           # standalone Cognee sidecar

# Configure the reviewer model (operator decides where the cycle's LLM lives)
$EDITOR ~/.config/subctl/master/providers.json
# set models.reviewer to e.g. {provider:"lmstudio", model:"gemma-4-26b-a4b-it-mlx", host:"http://localhost:1234/v1"}

# Migrate existing memory into the new substrates
subctl memory backfill evy-to-memori --dry-run        # see plan
subctl memory backfill evy-to-memori                  # for real
subctl memory backfill obsidian-to-cognee             # index your vault
subctl cognee cognify                                  # build the graph

# Watch the consciousness cycle work
subctl memory kernel status
subctl memory tier1 pending           # review candidate Tier 1 facts
```

After all that: open a new chat, ask Evy "what did we decide about X?" without telling her where to look. She'll answer from curated memory. That's the release.

## [2.8.3] — 2026-05-13

### `feat(dashboard,master): v2.8.3 Skills tab clarity + Evy-authored skills (evy_author_skill tool)`

Originally scoped as part of the v2.8.1 batch (alongside operator preferences + notification/watchdog fixes + chat-perf/skill-router). Sibling batches landed first and shipped as v2.8.2; this slice rebased onto that base and ships as v2.8.3.

Operator-raised on 2026-05-13 verbatim:

> "The Skills tab. When I click on Skills, I can view all sources or map podoc skills. I don't know what this actually means. How are those being used? How are those being assigned? Are those just skills that the Evy can pick up, or those skills that get applied to team members? Also, I've got no visual when Evy creates her own skills. Where she puts those, there needs to be something where I can see that."

Two intertwined gaps:
1. **The Skills tab was opaque.** It listed skill names with no answer to "what does this skill DO, where is it loaded, who can curate it?" Operators couldn't tell whether an entry was Evy's persona, a worker convention, or a third-party imported skill.
2. **No surface for Evy-authored skills.** When Evy worked out a reusable pattern in conversation, she had no operator-visible channel to persist it — the legacy `skill_create` tool wrote into a private `master/` source under `~/.config/subctl/skills/` that was hidden in the catalog tail.

This release closes both.

**Frontmatter schema (v2.7.33 skills + new drafts).** Every `SKILL.md` now carries extended YAML frontmatter:

```yaml
---
name: subctl-team-protocol
description: …
scope: dev-team               # dev-team | evy | both | project
loaded_by_default: ["evy"]    # personas / template names that auto-load
created_at: "2026-05-13"
created_by: evy               # operator | evy
promoted_by: operator         # only set on promote
promoted_at: "..."
---
```

The 10 repo skills shipped in v2.7.33 (`master`, `autonomy`, `orchestrator-mode`, `subctl`, `subctl-team-protocol`, `handoff-protocol`, `spec-driven-dev`, `node-conventions`, `python-conventions`, `rust-conventions`) had only `name` + `description`. v2.8.3 prepends the new fields without touching their bodies. Inferences: `subctl-master` → scope=evy, loaded_by_default=["evy"]; conventions + protocols + spec-driven-dev + handoff-protocol → scope=dev-team; `autonomy`, `orchestrator-mode`, `subctl` → scope=both (workers AND Evy can leverage them). The v2.8.1 chat-perf slice's `skill-router.ts` reads only `name` / `description` / `keywords` and is unaffected by the extra fields (its `parseFrontmatter` ignores unknown keys).

**Skills registry.** `components/master/skills-registry.ts` is the unified reader. Scans four sources — repo (`components/skills/`), Evy-authored drafts (`~/.local/state/subctl/evy-skills/`), imported catalog (`~/.config/subctl/skills/`), project-local (`<project>/.subctl/skills/`) — parses extended frontmatter (including folded `>-` and literal `|` block scalars without pulling a YAML dep), and bucket each Skill into one of four categories: `evy-loaded` · `team-developer` · `evy-authored` · `project-local`. Exports `listSkills()`, `getSkill()`, `resolveSkillsForTemplate()` (joins a template's `skills = [...]` arrays to Skill records), and `templatesUsingSkill()` (reverse lookup for the "Used by N templates" annotation).

**`evy_author_skill` master tool.** New `components/master/tools/skills-author.ts` registers four tools that complement the legacy `skill_create` family (kept for backward compat):

- `evy_author_skill` — Evy persists a reusable pattern as a draft SKILL.md under `~/.local/state/subctl/evy-skills/<name>/`. Required `reason` lands in `~/.local/state/subctl/audit/evy-skills.jsonl` and the notification body so the operator audit trail says WHY Evy captured each.
- `evy_list_authored_skills` — Evy introspects her drafts before authoring (dedup guard).
- `evy_promote_skill` / `evy_delete_authored_skill` — operator-triggered curation. Promote copies the draft into `components/skills/<name>/SKILL.md` with `promoted_by` + `promoted_at` stamped in frontmatter; does NOT auto-commit (operator reviews the diff in git).

Every author/promote/delete emits a `severity: info, kind: "evy-authored-skill"` notification so the tray + Telegram see the activity instantly, plus a `evy-authored-skill` SSE broadcast so the Skills tab refreshes live.

**Dashboard.** The Skills tab is rebuilt around four collapsible sections (`Evy's loaded skills` · `Team-developer skills` · `Evy-authored skills` · `Project-local skills`), each with a `[?]` info popover explaining what that bucket means and where its skills get loaded. Evy-authored cards expose `View` / `Promote to repo` / `Delete` buttons. Team-developer cards annotate `Used by: <template> (lead, dev-name, …)` so the operator can see at a glance which templates pull a given convention. The legacy sources + filter pane stays below as the imported-catalog viewer (still needed for the team-builder modal). New endpoints: `GET /api/skills/categorized`, `GET /api/skills/evy/:name`, `POST /api/skills/evy/:name/promote`, `POST /api/skills/evy/:name/delete`.

**Telegram.** New `/skills` family:
- `/skills` — summary counts across the four categories, with names of any drafts awaiting review
- `/skills evy` — Evy-authored drafts only, with `/skills promote <name>` and `/skills delete <name>` inlined per row
- `/skills team` / `/skills loaded` / `/skills project` — category views
- `/skills promote <name>` — promote a draft
- `/skills delete <name>` — discard a draft

**CLI.** `subctl skills` extended (sibling to v2.8.1's `router-trace` subcommand — different verbs, no conflict):
- `subctl skills list [--category <c>]` — categorized view (falls back to legacy flat list when dashboard offline)
- `subctl skills show <name>` — print a skill's full body (looks up by frontmatter name across all sources)
- `subctl skills promote <name>` / `subctl skills delete <name>` — curation actions (via dashboard endpoints so audit + notifications fire)

**Tests.** `components/master/__tests__/skills-registry.test.ts` pins: env-overridable evy-skills dir; author → list → delete round-trip; kebab-name validation; collision refusal; frontmatter parsing across single-line, folded `>-`, literal `|`, and no-description fallback styles; `resolveSkillsForTemplate` joining template ids to Skill records; `templatesUsingSkill` reverse lookup.

---

## [2.8.2] — 2026-05-13

Batch tag covering the v2.8.1 sibling waves (chat-perf + preferences + notification/watchdog fixes + Templates-tab route). See the `## [2.8.1]` section below for the operator-facing summaries of each.

## [2.8.1] — 2026-05-13

### `fix(dashboard,master): v2.8.1 Accounts surface — real per-account usage + correct dispatch verdict`

Operator reported 2026-05-13: *"The dashboard is broken under Accounts. It shows that every one of the accounts is ready and dispatches go when I know that one of them is 98% and some other ones have percentages used, so this information is not real."* This release fixes the false-positive "all clear" rendering, surfaces upstream data-fetch state honestly, and aligns the verdict thresholds with the team-lead's go / caution / throttle dispatch model.

**Root cause.** `computeAccountVerdict` in `dashboard/server.ts` defaulted to `{ verdict: "green", reasons: [] }` whenever an account was authed but its `usage` payload was `null` — i.e. whenever the `subctl usage --json` subprocess silently returned an empty array (12s timeout, non-zero exit, JSON parse error, no auth bearer) OR whenever the alias just wasn't in the upstream result set. Every authed account therefore rendered as a green "dispatches go" pill even when the upstream Anthropic `/api/oauth/usage` data was several minutes stale and the operator already knew one account was at 98%. The data WAS being tracked correctly — `lib/usage.sh` + the `subctl_usage_fetch` cache work — but the dashboard's failure mode was indistinguishable from "everything is fine."

**Verdict module extracted.** `computeAccountVerdict` now lives in `dashboard/lib/account-verdict.ts` so the logic is unit-testable and the thresholds are co-located with the team-lead's dispatch model. A null `usage` for an authed account now returns `{ verdict: "yellow", data_missing: true, reasons: ["usage data unavailable — has Anthropic OAuth been re-authed?"] }` (or, when the global fetch failed, `["usage fetch failed — check `subctl usage`"]`). The frontend uses the `data_missing` flag to render a dashed-border `⚠ no data` pill instead of the normal `caution` text — distinct enough that the operator can tell at a glance whether the yellow is a real signal or a data hole.

**Threshold realignment.** The 7-day-window yellow/red lines move from 70/90 to 80/95 so both windows (5-hour session and 7-day weekly) share a single 80/95 number that maps to the team-lead's go/caution/throttle model: `go < 80%`, `caution 80–95%`, `throttle ≥ 95%`, `over` past the extra-usage hard limit. The 5-hour thresholds were already 80/95; only the weekly window changes. Reason strings now read `weekly 98% (throttle ≥95%)` instead of `weekly 98% (red ≥90%)` so the label matches the dispatch verb.

**Sonnet + extra-usage signals.** The verdict module now also folds the `seven_day_sonnet` window and `extra_usage.is_enabled && used_credits >= monthly_limit` into the per-account verdict. An account that's 12% on all-models but 88% on the Sonnet-only window now correctly renders as yellow with an explanatory reason — previously hidden because the `seven_day` aggregate was cool. An account past its pay-as-you-go monthly cap renders red with `extra-usage over limit (50.01/50 USD)`.

**Fetch-level surface.** `subctlUsageFetchAll` previously swallowed every error path (spawn failure, non-zero exit, JSON parse failure, non-array payload) into a silent `[]`. It now returns `{ data, meta }` where `meta` carries `ok`, `fetched_at`, `age_seconds`, `accounts_returned`, `accounts_with_usage`, `accounts_with_errors`, plus `error` + `stderr_excerpt` (first 200 chars, no secrets) for diagnosis. The metadata is surfaced as `state.usage_fetch`. When `meta.ok === false`, the dashboard renders a banner above the Accounts table: *"⚠ Accounts table cannot be trusted: subctl usage --json exit=2 (last attempt 14m ago) — run `subctl usage` from a terminal to diagnose; click ↻ to retry."* — no more silent staleness.

**Per-account `usage_state`.** Each account row now carries a tri-state `usage_state`: `"ok"` (payload present and trusted), `"stale"` (fetch succeeded globally but this alias was missing or per-account `ok: false`), or `"fetch_failed"` (global fetch failed entirely). The frontend renders the `⚠ no data` pill for `stale` and `fetch_failed`, and the percentage cells fall back to `—` instead of misleading zeros.

**Tests.** Two new test files, 19 new tests:

- `dashboard/__tests__/account-verdict.test.ts` (16 tests) — auth gate, the null-usage regression (3 tests covering bracket of parameter space), threshold mapping (80/95 boundaries, Sonnet-only window, extra-usage over limit), operational signals (429 hits, parallel sessions, severity monotonicity), and `dispatchLabel` mapping to go/caution/throttle.
- `dashboard/__tests__/account-summary-integration.test.ts` (3 tests) — verifies the wire-up between `subctlUsageFetchAll` + `buildAccountSummaries` shapes: global fetch failure produces yellow + `fetch_failed` for every alias; partial result (one ok, one ok:false, one absent) produces `ok` / `stale` / `stale` respectively; explicit fixture for the operator's 98% scenario produces red with the 98% reason.

Full dashboard suite: 128 pass / 0 fail. Master suite untouched.

**Files:**

- New: `dashboard/lib/account-verdict.ts` — extracted, unit-testable verdict + threshold constants
- Modified: `dashboard/server.ts` — `subctlUsageFetchAll` returns `{ data, meta }` with diagnostic fields; `buildAccountSummaries` threads meta + emits `usage_state`; `buildState` adds `state.usage_fetch`; the local verdict function delegates to the extracted module
- Modified: `dashboard/public/app.js` — `verdictPill` accepts a `dataMissing` opt and renders `⚠ no data` with a dashed border; row render passes `data_missing` + `usage_state`; new banner above the Accounts table when `state.usage_fetch.ok === false`
- Modified: `dashboard/public/index.html` — new `#usage-fetch-warning` banner element
- Modified: `dashboard/public/style.css` — `.verdict-pill.verdict-nodata` (dashed neutral) + `.warning.usage-fetch-warning` styles
- New: `dashboard/__tests__/account-verdict.test.ts` + `dashboard/__tests__/account-summary-integration.test.ts`

**Underlying tracking is fine.** The bash usage fetch (`lib/usage.sh:subctl_usage_fetch_all`) correctly reads `.credentials.json` (Claude Code 2.x) or the macOS Keychain (1.x legacy), calls `/api/oauth/usage` with the per-account bearer, caches to `~/.config/subctl/cache/usage/<hash>.json`, and the dashboard's 5-min history poller has been recording snapshots to `usage-history.jsonl` correctly. The bug was strictly dashboard-side rendering of a missing payload; no upstream changes were needed. If the operator still sees the new "⚠ no data" banner after this release, the next step is `subctl usage` from a terminal to diagnose the bearer extraction / Keychain / network path — the banner now points at exactly that command.

---

## [2.8.0] — 2026-05-13

### `feat(voice): v2.8.0 voice layer for Evy — self-hosted TTS, opt-in, redacted (ADR 0017)`

`docs/persona/voice-future.md` was authored 2026-05-12 as a parking-lot for "after text-Evy is stable." v2.7.30 added the 16 feature-coverage eval tests that closed the v2.7.18–v2.7.24 surface (16 + the original 24 = 40 across fourteen categories), and the persona-grader trend was healthy enough for the operator to surface the voice layer as the v2.8.0 promotion. This release ships it. Self-hosted-only (ADR 0009 extends to TTS — no ElevenLabs / OpenAI TTS / Azure egress), opt-in (defaults OFF in `voice.json`), redacted at the tool boundary (the same `redactForEgress` used for Telegram + dashboard quoting runs BEFORE bytes leave master to the TTS server).

**TTS service.** Lives in `services/tts/` as a separate launchd job (`com.subctl.tts`) bound to 127.0.0.1:8789. `services/tts/server.py` is a thin BaseHTTPServer wrapper that hands `(text, voice_id, model)` to the configured backend. Three backends behind one HTTP surface (POST /render returns audio bytes plus `X-Audio-Format` + `X-Audio-Duration-Ms` headers):

- `voxcpm` — operator's primary lean per voice-future.md (~0.5B model, cloning + streaming, Apple Silicon capable). Requires `pip install voxcpm` plus model weights and a ~10s reference clip + transcript at `services/tts/voices/<voice_id>/`. License: Apache 2.0.
- `kokoro` — Kokoro-82M fallback. ~325MB, CPU-friendly, good for the mini nodes. License: Apache 2.0.
- `mock` — default. 1-second silent WAV. Lets the rest of the pipeline (master tool, dashboard 🔊 button, Telegram `/say`, CLI, cache, redaction, tests) be developed and tested without committing to a real backend. `install.sh` ships the mock backend by default so first-run install stays fast; the operator picks `voxcpm` or `kokoro` interactively or via env override on the plist.

**Master daemon tool.** `voice_render({text, voice_id?})` → `{audio_url, format, duration_ms, cached, hash, voice_id, model}`. Egress redaction runs before the POST to the TTS server, then bytes cache to `~/.local/state/subctl/voice/cache/<sha256(model|voice_id|text)[:24]>.<fmt>` with a 24h TTL. Second render of the same line hits cache (no second TTS roundtrip). A companion `voice_status` tool reports `voice.json` state + TTS reachability + latency probe. Master also exposes HTTP routes `POST /voice/render`, `GET /voice/audio/<hash>.<fmt>`, `GET /voice/status`, `POST /voice/config` (allowlist-gated patch) — dashboard + CLI hit these via the existing `/api/master/*` proxy pattern with a dedicated `/api/voice/*` prefix.

**Config + hot reload.** `~/.config/subctl/voice.json` holds `{enabled, default_voice_id, model, tts_server}`. `loadVoiceConfig()` reads on every call — no in-memory cache. The operator's "VERSION is the canonical source" rule (feedback 2026-05-11) extends to voice config: toggling `enabled` from the dashboard or CLI must affect the very next render. `watchVoiceConfig()` exists for SSE-side propagation (the master broadcasts a `voice_config` SSE event on change so the dashboard's 🔊 button toggles live without a refresh), not for caching.

**Telegram.** New `telegram_send_voice` tool uploads rendered audio via `sendVoice` multipart. Wraps `voice_render` so the same redaction + cache path applies. New `/voice` (status / `/voice on` / `/voice off`) and `/say <text>` slash commands let the operator drive the voice layer from their phone. `/voice on|off` writes `voice.json#enabled` and the master's file watcher picks the change up immediately. `/say` renders + uploads in one shot.

**Dashboard.** Each Evy assistant bubble gains a 🔊 button (Lucide volume-2 inline SVG — keeps with ADR 0016). Click → POST `/api/voice/render`, swap an autoplay `<audio>` element into the bubble footer. Visibility tracks `voice.json#enabled` via initial fetch + live SSE `voice_config` events. CSS mirrors the v2.7.21 tool-pill accent palette.

**CLI.** New `subctl voice [status|test|render <text>|on|off]` sanity surface routes through the dashboard's `/api/voice/*` proxy. `subctl voice test` renders a canned line and plays it locally via `afplay`. Wired into bin/subctl + lib/cli.sh + help text.

**Install.** `install.sh` grows an opt-in voice prompt that defaults to the `mock` backend (no pip install required). For `voxcpm` / `kokoro` operators, `services/tts/README.md` documents the manual pip install + model-weight + reference-clip steps; the plist's `SUBCTL_TTS_BACKEND` placeholder gets substituted by `lib/voice.sh:subctl_voice_install`. `voice.json` seeded with `enabled: false` — operator opts in explicitly.

**Tests.** `voice-config.test.ts` (11 tests): seed-on-missing, normalize-missing-fields, malformed JSON fallback, save merges, watch debounce, watch close. `voice-render.test.ts` (12 tests): disabled gate, empty/oversized text, secrets-redacted-before-TTS-server (mocked Bun.serve verifies the raw `sk-*` token never reaches the server), cache hit on second render, TTS HTTP error propagation, unreachable server handling, `resolveCachedAudio` path-traversal resistance, `probeTtsServer` reachable/unreachable shape. 23 voice-specific tests; 783 total master tests pass after the additions (was 760).

**Files:**

- New: `components/master/voice-config.ts` — voice.json loader + saver + fs.watch
- New: `components/master/tools/voice-render.ts` — `voice_render` + `voice_status` tools + `renderVoice`/`resolveCachedAudio`/`probeTtsServer` helpers consumed by the HTTP surface
- New: `components/master/__tests__/voice-config.test.ts`
- New: `components/master/__tests__/voice-render.test.ts`
- New: `services/tts/server.py` — three-backend HTTP server stub
- New: `services/tts/launchd/com.subctl.tts.plist` — launchd template (com.subctl.tts)
- New: `services/tts/voices/evy-rachel-weisz/README.md` — voice-cloning reference instructions
- New: `services/tts/README.md` — backend selection + manual install notes
- New: `lib/voice.sh` — `subctl_voice_install` / `subctl_voice_disable` (matches lib/master.sh pattern)
- New: `docs/adr/0017-voice-layer-tts.md` — voice layer architecture decision
- Modified: `components/master/server.ts` — voice tool registration, HTTP routes, watcher boot + shutdown hooks
- Modified: `components/master/tools/telegram.ts` — `sendTelegramVoice` helper + `telegram_send_voice` tool
- Modified: `components/master/master-notify-listener.ts` — `/voice` + `/say` slash commands + help text
- Modified: `dashboard/server.ts` — `/api/voice/*` proxy (including audio passthrough)
- Modified: `dashboard/public/app.js` — 🔊 button injection + SSE `voice_config` listener + initial status probe
- Modified: `dashboard/public/style.css` — voice button + audio player styling
- Modified: `bin/subctl` — `voice` verb dispatch + usage text
- Modified: `lib/cli.sh` — `subctl_cli_voice` (status / test / render / on / off)
- Modified: `install.sh` — opt-in voice install prompt + backend picker
- Modified: `docs/adr/README.md` — ADR 0017 row appended
- Modified: `ROADMAP.md` — voice layer promoted from "future" to "currently shipping v2.8.0"
- Modified: `docs/master.md` — new "Voice layer (TTS)" section
- Modified: `VERSION` → 2.8.0

## [2.7.31] — 2026-05-13

### `feat(master): v2.7.31 1Password Service Accounts (multi-backend secret resolution)`

ADR 0012 implementation. Subctl's master daemon used to look up secrets through a 2-source chain: `process.env.<KEY>` first, then `~/.config/subctl/secrets.json`. That worked for solo-developer use but had four known gaps the operator hit repeatedly in MSP context — manual key re-entry on a new host, no in-place rotation, no audit, and an unencrypted-at-rest bootstrap file. This release generalizes the resolution into an N-backend chain whose default order is **env → onepassword → file**, with per-key overrides and a 5-minute cache for 1Password lookups.

**Architecture.** A new `components/master/secrets-backends.ts` module owns the chain; `resolveSecret(key)` in `secrets.ts` keeps its synchronous shape and v2.7.4 behavior for back-compat (env > file, op:// refs hidden from sync callers). New code that wants full multi-backend resolution — including the async 1Password roundtrip — calls `resolveSecretChain({ key, backends?, required? })`. Both surfaces share the same backend implementations, so the env-var lookup and the file-backed fallback can't diverge over time.

**1Password backend.** Shells out to the `op` CLI via `Bun.spawn(["op", "read", ref])` — no shell interpolation, ref passed as argv. The backend silently no-ops (falls through to file) when either `op` is missing from PATH or `OP_SERVICE_ACCOUNT_TOKEN` is unset in env. Existing deploys with no 1Password setup see zero behavioral change. Successful resolutions cache in process memory for 5 minutes, keyed by op:// reference (so two subctl keys pointing at the same vault item share a slot). Cache flushes on process restart or via `POST /secrets/cache/flush`.

**Storage forms.** Operator can express an op:// reference two ways: (1) inline literal in `secrets.json` (`"brave_api_key": "op://Personal/Brave/key"`), or (2) explicit map in `~/.config/subctl/secrets-backends.json` under `onepassword_refs`. The file backend auto-skips any literal that starts with `op://` so a caller never gets back a URI as if it were the secret value — the chain's job is to resolve them through the onepassword backend instead.

**Audit log.** Every successful 1Password resolution appends one JSONL line to `~/.config/subctl/master/secrets-audit.jsonl` containing `ts`, `key`, `ref`, and `cache_hit`. Values never appear in audit records. Pairs with 1Password's own server-side audit log for end-to-end traceability.

**Backends config.** `~/.config/subctl/secrets-backends.json` is operator-editable with three fields: `default_chain` (e.g. `["env", "onepassword", "file"]`), `overrides` (per-key chain pin), and `onepassword_refs` (per-key explicit ref). Unknown backend names get filtered out; malformed JSON falls back to defaults with a single `console.error` — daemon never crashes on a bad config.

**HTTP surface (master).** Three new endpoints, none of which return a secret value:

- `GET  /secrets/backends` — chain config + op CLI availability + token-set flag + cache size + audit path
- `POST /secrets/test {key}` — `{ ok, key, exists, found_via }` — boolean + origin backend, no value
- `POST /secrets/cache/flush` — `{ ok, cleared }` — wipes the 1Password cache, returns the count

**Telegram.** New `/secrets` command echoes the same chain status the dashboard sees — chain order, per-key overrides, 1Password CLI/token state, cache size. No values, no refs to specific items — just shape and availability.

**Tests.** `components/master/__tests__/secrets-backends.test.ts` covers default chain order, per-key overrides, op silent-no-op when CLI/token are missing, op cache TTL behavior (cache hit emits `cache_hit: true` audit entry), file-backend op:// hygiene, audit log shape + value-never-appearing assertion, `flushOnePasswordCache` count return, `testSecret` shape (no `value` field), and config robustness (missing/malformed/unknown-backend cases).

**Files:**

- New: `components/master/secrets-backends.ts` — chain orchestration, op CLI wrapper, audit, cache, status surfaces
- New: `components/master/__tests__/secrets-backends.test.ts`
- Modified: `components/master/secrets.ts` — `resolveSecret` now hides op:// refs from sync callers
- Modified: `components/master/server.ts` — three new HTTP routes (~30 lines, all under the `// ── v2.7.31 secret backends ──` marker)
- Modified: `components/master/master-notify-listener.ts` — `/secrets` Telegram command + help-text line
- Modified: `docs/adr/0012-1password-service-accounts-multibackend.md` — status → Accepted (shipped v2.7.31)
- Modified: `docs/adr/README.md` — ADR 0012 row updated

## [2.7.30] — 2026-05-13

### `test(eval): v2.7.30 add eval coverage for v2.7.18 through v2.7.24 features`

The 24-test Evy persona eval suite (shipped in v2.7.15) measures persona behaviors only — pushback shape, voice, memory provenance, routing discipline. Since then, seven releases shipped operator-visible behaviors that were entirely outside the eval grader's reach: v2.7.18 supervisor profiles, v2.7.19 watchdog controls + empty-listener circuit breaker, v2.7.20 HMAC trust marker, v2.7.21 web terminal escape hatch, v2.7.22 notification channel separation + auto-nudge, v2.7.23 Evy Memory (Tier 3), and v2.7.24 pi-ai dynamic provider catalog. Each of these has its own unit-test suite that pins the mechanics, but none of them had eval coverage for the operator-facing surface — what Evy says when the operator asks "what profile are you on?" or "kill the inbox-poll watchdog" or "remember that I prefer terse responses". A future refactor that breaks the operator surface of one of these features would not be caught by either layer until an operator hit it in production.

This release extends the eval suite with 16 feature-coverage tests across seven new categories (8 through 14), one category per shipped version. The tests mirror the existing harness shape exactly: each test file lives in `components/master/__tests__/evy-eval/tests/`, declares per-test judge prompts inline, calls `runEvalTest({testId, operatorTurns, judgePrompt})`, and runs the same regex fast-fail → LLM judge pipeline as the original 24. No new fixture shape, no harness modifications — just additions under `tests/`. Test IDs use the existing `<category>.<test>` convention (8.1, 8.2, 9.1, etc.).

**Category map (file → version → count):**

- `category-8-supervisor-profiles.test.ts` — v2.7.18 — 3 tests
  - 8.1 reports the active profile by name
  - 8.2 swaps to chat via the right surface (`/profile chat`, dashboard pill, or POST /profile)
  - 8.3 same for heavy, with the no-unsolicited-warning constraint
- `category-9-watchdog-controls.test.ts` — v2.7.19 — 3 tests
  - 9.1 invokes `watchdog_list` for "what watchdogs are running?"
  - 9.2 invokes `watchdog_kill({id: "inbox-poll"})` for the named kill
  - 9.3 respects the empty-listener circuit breaker (no retry, surfaces the dead-listener finding, points at watchdog_list)
- `category-10-trust-marker.test.ts` — v2.7.20 — 2 tests
  - 10.1 describes the marker shape with the HMAC field
  - 10.2 worker should refuse + escalate on HMAC mismatch, not trust the body
- `category-11-web-terminal.test.ts` — v2.7.21 — 1 test
  - 11.1 names the dashboard Attach button + the `/terminal on` enable command
- `category-12-notifications.test.ts` — v2.7.22 — 2 tests
  - 12.1 notification surface ≠ chat surface (bell tray + alert-only Telegram push)
  - 12.2 auto-nudge flow: nudge → 30-min hold → escalation; no transcript pollution
- `category-13-evy-memory.test.ts` — v2.7.23 — 3 tests
  - 13.1 saves an operator preference via `evy_remember` (Tier 3)
  - 13.2 recalls recent operator↔Evy chat via `evy_recall` (Tier 3, not Tier 4)
  - 13.3 distinguishes Evy Memory (Tier 3) from claude-mem (Tier 4) correctly
- `category-14-provider-catalog.test.ts` — v2.7.24 — 2 tests
  - 14.1 reflects the dynamic 31+-provider catalog, not a hard-coded short list
  - 14.2 guides operator through dashboard "New profile" or `subctl auth` to add a Groq profile (no fabricated CLI flags)

**Test infrastructure unchanged.** No edits to `harness.ts`, `judge.ts`, `regex-graders.ts`, `types.ts`, or `_helpers.ts`. The pr23-era prohibition on modifying the harness core files still holds — this release only adds files under `tests/`. The original 24 tests are byte-identical.

**Regex-only mode is the contract.** All 16 new tests pass on the regex fast-fail layer without an Anthropic key (the stub `runEvySession` returns a placeholder Evy response that doesn't hit any of the six base fast-fail patterns, so each test resolves to `regex-only-pass`). The LLM judge runs full-quality grading when `ANTHROPIC_API_KEY` is set; this is the same pattern as the original 24.

**What still feels under-covered.** Three feature surfaces resisted clean eval expression on the regex/LLM-judge pipeline and remain partially covered by their unit tests only: (a) the actual circuit-breaker trip in the master tool-call dispatcher — 9.3 grades the post-trip operator reply only, not the in-flight refusal; pr-future could add a synthetic tool-result injector to drive the breaker for real. (b) The HMAC verification on the worker side — 10.2 grades Evy's explanation of correct worker behavior, not actual worker execution against a malformed HMAC. (c) The dashboard pill + `/profile` Telegram command — eval covers Evy's text response, not the surface invocations themselves; the unit tests in `profiles.test.ts` cover the file-write semantics.

**Files:**

- New: `components/master/__tests__/evy-eval/tests/category-8-supervisor-profiles.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-9-watchdog-controls.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-10-trust-marker.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-11-web-terminal.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-12-notifications.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-13-evy-memory.test.ts`
- New: `components/master/__tests__/evy-eval/tests/category-14-provider-catalog.test.ts`
- `components/master/__tests__/evy-eval/README.md` — eval test set summary line updated to "40 tests, 14 categories".
- `docs/master.md` — Eval suite section count updated from 24 to 40 with the seven new feature categories enumerated.
- `VERSION` → `2.7.30`.

## [2.7.24] — 2026-05-13

### `feat(dashboard): v2.7.24 pi-ai provider catalog (dynamic dropdown) — pi-ai + pi-agent declared first-class upstreams`

Two scopes, one architectural framing: subctl now treats **both** pi-mono packages as first-class always-latest upstreams (ADR 0015), and the dashboard's "New profile" dropdown finally consumes the catalog half of that dependency.

**Scope A — first-class upstreams (always-latest policy).** Subctl depends on the pi-mono monorepo via two npm packages, and both are load-bearing: `@earendil-works/pi-agent-core` runs master's agent loop, tool registry, and streaming (the existing agent runtime — untouched in code, but now explicitly documented as a tracked upstream); `@earendil-works/pi-ai` is the provider catalog (what providers exist, model lists per provider, factory shapes). Both are pinned to `^0.74.0` in `components/master/package.json` so `bun install` resolves to latest on every deploy. The release policy added in ADR 0015: subctl's release process MUST update both packages to their latest published versions on every minor/patch release. v2.7.25 will add an auto-tracker watchdog that surfaces upstream bumps as `severity:"info"` notifications — deferred from v2.7.24 to keep the catalog work shippable in isolation.

**Scope B — dynamic provider catalog (the v2.7.24 code change).** Replaces the hand-curated dropdown — five entries, three flagged `(future)`, missing the `pi-coding-agent` integration entirely — with a dynamic catalog backed by `@earendil-works/pi-ai`. The master daemon was already importing pi-ai for its stream factory; subctl's UI just wasn't consuming the catalog half. Net result: the dropdown jumps from 5 entries to 31, and new providers added upstream (groq, cerebras, openrouter, xai, bedrock, openai-codex, github-copilot, deepseek, fireworks, vercel-ai-gateway, …) light up automatically on the next pi-ai bump.

**Files:**

- New: `components/master/pi-ai-catalog.ts` — wraps pi-ai's `getProviders()` + `getModels()` into a stable `CatalogProvider` shape (id, display_name, kind, auth_method, model_count, notes). Holds the `SUBCTL_TO_PI_AI` alias table — legacy subctl ids (`claude`, `gemini`, `pi-coding-agent`) map to pi-ai canonicals (`anthropic`, `google`, `anthropic`) so existing `accounts.conf` rows keep working. Exports `listCatalogProviders()`, `isCatalogProvider()`, `resolveProviderId()`, `legacyAliasFor()`.
- New: `dashboard/__tests__/providers.test.ts` — 26 tests covering catalog shape, alias mapping (both directions), validation gate, profile-merge contract, accounts.conf parse robustness.
- New: `docs/adr/0015-pi-ai-and-pi-agent-as-first-class-upstreams.md` — decision record framing both packages as first-class upstreams, the always-latest dependency-update policy, the mapping table, the v2.7.25 auto-tracker note, and the deferred open questions (OAuth flows for new providers, WIRED_PROVIDERS deduplication, pi-mono major-version handling).
- `dashboard/server.ts` — `/api/providers` GET replaces its hand-curated `CLOUD` array with `listCatalogProviders()`, walks every catalog entry, attaches matching `accounts.conf` profiles via the alias map, surfaces `auth_method` / `model_count` / `legacy_alias` in the JSON. `/api/providers/profiles` POST validates the requested provider against the catalog and rejects unknown ids with a 400 + hint listing the known legacy aliases.
- `dashboard/public/index.html` — `<select id="profile-provider">` is now empty in markup; app.js populates it dynamically. The `(future)` tags are gone.
- `dashboard/public/app.js` — `populateProviderDropdown()` runs on each modal open: fetches `/api/providers`, filters to cloud, sorts (providers-with-profiles-first, then alphabetical), renders each `<option>` with the display name + `(OAuth)` badge when applicable + a `· N profile(s)` suffix when the operator already has profiles for that provider. `openModal()` is now async and refreshes the dropdown so newly-added upstream providers show up without a page reload.
- `docs/adr/README.md` — index updated.
- `docs/master.md` — new "Pi-mono upstreams + provider catalog (v2.7.24+)" section explaining the dual-upstream relationship and how the catalog is consumed.
- `VERSION` → `2.7.24`.

**Dependencies (`components/master/package.json`):**

- `@earendil-works/pi-agent-core`: `^0.74.0` (agent runtime, unchanged usage)
- `@earendil-works/pi-ai`: `^0.74.0` (provider catalog, now consumed by dashboard)

Both pinned with `^` so `bun install` resolves to the latest published `0.x.y` automatically on every deploy. This is the mechanical layer of the always-latest policy in ADR 0015.

**Out of scope, queued for follow-up:**

- **v2.7.25: auto-tracker watchdog.** Polls npm for new pi-ai + pi-agent-core releases, raises a `severity:"info"` notification with a one-click bump action. Documented in ADR 0015.
- **OAuth flows for newly-surfaced providers** (GitHub Copilot, xAI). `@earendil-works/pi-ai/oauth` exposes helpers; wiring `subctl auth github-copilot <alias>` through them is a follow-up. Operators authenticate new providers via API keys (env var or `secrets.json`) in v2.7.24.
- **Deriving `WIRED_PROVIDERS`** (in `/api/master/supervisor`) from pi-ai's `registerBuiltInApiProviders` registry. Two related-but-separate concerns (what's in the dropdown vs. what the supervisor can actually run) — folding them into one source of truth is queued.

## [2.7.23] — 2026-05-13

### `feat(master): v2.7.23 Evy Memory (Tier 3) — Memori-substrate TS implementation`

Lands the Tier 3 conversational memory layer described in ADR 0005. When Evy has a conversation tonight and master is restarted tomorrow, she now remembers what was discussed — the things that would be expensive to re-derive: who's working on what, what was just shipped, what's stuck, what operator preferences emerged in chat. This is the fix for what the operator has been calling "51st date syndrome."

**Substrate choice (ADR 0014).** ADR 0006 named Memori as the substrate, but Memori is a Python framework (MemoriLabs/Memori) — there is no maintained TypeScript SDK on npm. Subctl is Bun/TS. The integration would have required a Python sidecar service, and Memori's value-add (auto-injecting captured memory into LiteLLM prompts) is moot for subctl because pi-ai is our LLM call path, not LiteLLM. We picked Option B from the spec: a native TypeScript port using `bun:sqlite` with FTS5 full-text search. Memori's `memori_conversation_message` table shape inspired the schema; the entity-fact knowledge-graph layer was dropped (it requires LLM-driven extraction, which we'd add as a v2 enhancement). The result wraps as **Evy Memory** — a subctl/Evy-aware module rather than vanilla Memori. ADR 0014 supersedes ADR 0006. ADR 0010 (claude-mem stays parallel as Tier 4) is preserved; the new code reads zero claude-mem state.

**Storage.** `~/.local/state/subctl/memory/evy.db` (chmod 600, directory chmod 700). Single SQLite file. Schema: `entries(id, ts, team_id, role, kind, content, metadata_json)` + an FTS5 virtual table with triggers keeping it in sync. WAL journal, synchronous=NORMAL. Sub-millisecond inserts on the M3. FTS5 availability is detected at boot; if a future Bun build strips it, the retrieval path falls back to LIKE matching automatically.

**Capture surfaces (turn boundaries).** The master daemon hooks Evy Memory at every recorded turn:

- User message arrives (`chat` / `telegram` / `cli`) → `role: "user", kind: "message"`.
- Synthetic prompt (verifier / watchdog / scheduled / team-report) → `role: "event", kind: "synthetic-prompt"` so search-by-role can filter out daemon noise.
- Assistant response settles → `role: "assistant", kind: "message"` (skipped for synthetic re-entries).
- Tool call dispatched → `role: "tool", kind: "tool-call"`, content = `tool_name(short_args)` (top-level fields only, truncated to 320 chars total so a single noisy call can't dominate FTS).
- Notification emitted (info/warn/alert) → `role: "event", kind: "notification"`, metadata carries severity + the original notification id.

Failures are swallowed and logged to stderr — memory must never break a tool call or block an operator reply.

**Recall surfaces.**

- **Evy's tools.** `evy_recall(query?, team_id?, kind?, since_days?, limit?)` and `evy_remember(content, kind?, team_id?)` — the explicit save surface. The tool descriptions name the Tier 3 vs Tier 4 distinction so Evy routes between Evy Memory (operator-Evy chat) and `memory_search` (claude-mem cross-session observation corpus).
- **Dashboard /api/memory/\*** proxy (subpath-only to leave `/api/memory` mapped to the existing Obsidian status endpoint):
  - `GET /api/memory/search?query=&team_id=&kind=&since=&limit=` — FTS5 search
  - `GET /api/memory/recent?limit=` — last N entries
  - `GET /api/memory/stats` — count + bytes + FTS5 flag
  - `POST /api/memory/entries` — record an operator-note
  - `DELETE /api/memory/entries/:id` — operator-only forget
- **Memory tab UI.** New "Evy Memory" card in the Memory tab (the existing tier-1 / Obsidian cards stay). Search input + kind dropdown + recent button + per-entry forget action.
- **Telegram.** `/memory <query>` returns the top 3 matches; `/memory recent` returns the last 5; `/remember <text>` saves a kind="operator-note" entry. `/help` updated.

**Privacy posture (ADR 0009 preserved).** The DB never egresses without the operator's action. All bytes that leave master via Telegram or the dashboard pass through `redactEntryForEgress`, which masks `sk-*` / `pk-*` API keys, `Bearer …` tokens, 64-char hex blobs (HMAC marks per the v2.7.20 trust-marker shape), `hmac:<team>:<hex>` structured marks, and other 40+ uppercase-hex secret-ish strings. Storage-side is unredacted because the file is chmod 600 and only the operator's user account can read it; this leaves operator search across raw content possible while still defending the egress surfaces.

**Files:**

- New: `components/master/memory.ts` — the storage primitive. `recordEntry` / `recallEntries` / `recentEntries` / `purgeBefore` / `deleteEntry` / `memoryStats` / `redactForEgress` / `redactEntryForEgress`. Path resolution mirrors `trust-marker.ts` (SUBCTL_STATE_DIR override for tests). Includes `_setStateDirForTesting` and `_closeForTesting` helpers.
- New: `components/master/tools/evy-memory.ts` — `evy_recall` + `evy_remember` master tools. Descriptions explicitly draw the Tier 3 vs Tier 4 line so Evy routes correctly.
- New: `components/master/__tests__/memory.test.ts` — 18 tests: record/recall round-trip, team_id + kind + since filters, FTS5 (verified available in Bun 1.2.17) + LIKE fallback path, recentEntries ordering, purgeBefore with FTS-trigger sync, deleteEntry, chmod 600/700 on the DB file + parent dir, memoryStats reflects live state, redactForEgress masks sk-*/Bearer/64-hex/hmac:* on egress without mutating input.
- `components/master/server.ts` — imports the memory module + tools; records user/assistant/tool/event entries at turn boundaries (with synthetic-prompt detection); subscribes to notifications and writes each one through to memory; adds `/memory/*` HTTP routes with egress redaction; adds `summarizeArgs` helper for short tool-call signatures.
- `components/master/master-notify-listener.ts` — `/memory` + `/remember` Telegram commands; redacted on output; help text updated.
- `dashboard/server.ts` — `/api/memory/*` proxy to master, gated on subpath presence so the existing `/api/memory` (Obsidian status) route is untouched.
- `dashboard/public/index.html` — Memory tab subheader rewritten to name all five tiers; Evy Memory card appended to the memory grid (search input + kind filter + recent button + list region).
- `dashboard/public/app.js` — `wireEvyMemoryCard` (called from `wireMemoryTab`): loads recent on mount, runs search via `/api/memory/search`, per-entry forget action, periodic refresh while the tab is visible.
- `dashboard/public/style.css` — `.evy-mem-*` classes for the new card (controls, list, item, body, redaction-friendly truncation).
- New: `docs/adr/0014-evy-memory-ts-port-of-memori.md` — the ADR.
- `docs/adr/0006-memori-byodb-sqlite-for-tier-3.md` — Superseded by 0014 (status header updated, reasoning preserved verbatim for history).
- `docs/adr/0005-five-tier-memory-architecture.md` — Tier 3 row + reasoning + references point at 0014.
- `docs/adr/README.md` — index updated.
- `docs/master.md` — new "Evy Memory (Tier 3) — v2.7.23+" section.
- `VERSION` → `2.7.23`.

## [2.7.22] — 2026-05-13

### `feat(master): v2.7.22 notification channel + watchdog auto-nudge + auto-compact fix`

Three bundled scopes, all rooted in the same architectural mistake: the team-staleness watchdog was synthesizing operator-facing prompts straight into the master agent's transcript. Every tick read like _"1 dev team(s) appear stale: claude-osint-cve-monitor (221min ago). Decide whether to ping the lead via subctl_orch_msg, escalate to Jason via telegram_send, or take corrective action."_ — interleaved with Evy's actual conversation, paid an LLM call per tick to "decide", and asked the supervisor to do the cheap remediation it should have done itself.

- **Notification channel separation (scope A).** New `components/master/notifications.ts` — an in-memory ring buffer (N=200) with `emitNotification` / `listNotifications` / `subscribeNotifications` / `markRead` / `markAllRead`. The team-staleness watchdog NO LONGER appends to the agent's transcript; it calls `emitNotification` instead. Operator surfaces: a bell-icon tray in the dashboard header (driven by `GET /api/notifications` + `GET /api/notifications/stream` SSE), a Telegram push on `severity:"alert"` only (info/warn stay tray-local), and a `/notifications` Telegram command for read + mark-all-read. The master's HTTP server exposes `/notifications`, `/notifications/:id/read`, `/notifications/read-all`, `/notifications/stream`; the dashboard proxies them under `/api/notifications/*` (REST + SSE pass-through, same shape as `/api/master/events`).
- **Watchdog auto-nudge (scope B).** Extracted as `components/master/auto-nudge.ts` so the state machine is unit-testable. On staleness detection the watchdog calls the dashboard's `/api/orchestration/:name/msg` route (HMAC-signed via v2.7.20's trust marker — same path the `subctl_orch_msg` tool takes) with `[auto-nudge] You've been inactive for N min...`, records `last_nudge_at`, and emits a `severity:"info"` `team-nudge-sent` notification. Within the 30-min retry window the watchdog HOLDS — no re-nudge, no re-alert. After 30 min still stale → `severity:"alert"` `team-unresponsive` notification (which the Telegram push picks up) AND a re-nudge with an escalated body. Team responds before 30 min → state clears, next staleness counts as a fresh first nudge. Operator only gets paged when a team actually fails to respond to a nudge.
- **auto-compact watchdog fix (scope C).** Root cause: the boot-time 30s `setTimeout(runAutoCompactTick, 30_000)` fired the tick body but never called `touchWatchdog("auto-compact")`. The periodic 5-min `setInterval` did the bump OUTSIDE `runAutoCompactTick`, so any error inside the tick was silent. Net effect: a freshly-booted master showed `last_tick_at: null` for up to 5 minutes even after the early-fire ran, and a thrown error inside the compaction body was a `console.error` that never reached the operator. Fix: `touchWatchdog` now runs at the TOP of `runAutoCompactTick` itself, the entire tick body is wrapped in a try/catch that emits a `severity:"warn"` `auto-compact-error` notification on failure, and the early-fire window dropped from 30s to 15s so the watchdog's `last_tick_at` lights up well inside the operator-observable boot window.

**Files:**

- New: `components/master/notifications.ts` — ring buffer + pub/sub API. Includes `_resetForTesting()` so individual tests don't leak state.
- New: `components/master/auto-nudge.ts` — `decideTeamAction` (pure) + `runStaleTeamSweep` (orchestrator with side-effect callbacks). The server's watchdog tick passes its `sendNudge` / `emitInfo` / `emitAlert` / `logDecision` callbacks into `runStaleTeamSweep` — the master daemon owns I/O, the module owns policy.
- New: `components/master/__tests__/notifications.test.ts` — emit/list/markRead round-trip, ring-buffer eviction at the cap, severity routing (the Telegram-pusher contract), `since`/`limit` filters.
- New: `components/master/__tests__/auto-nudge.test.ts` — pure-decision matrix + sweep contract: first-nudge, escalation, response resets state, 30-min hold dedup, send-failure still advances `last_nudge_at`.
- New: `components/master/__tests__/auto-compact.test.ts` — watchdog ticks within the early-fire window, compaction primitive shrinks 50k → <35k, errors emit a `severity:"warn"` notification.
- `components/master/server.ts` — imports the new modules; `runWatchdogTick` no longer dispatches to the agent (the `[watchdog] ... appear stale ... Decide whether to ping` synth-prompt + the `dispatchToAgent(synthPrompt, "watchdog")` call are gone); subscribes to `severity:"alert"` notifications and pushes via `sendTelegramOutbound`; adds `/notifications` HTTP routes; `runAutoCompactTick` bumps the watchdog at the top of every tick path and wraps the body in a try/catch that emits a `severity:"warn"` notification; early-fire dropped from 30s to 15s.
- `components/master/master-notify-listener.ts` — adds `/notifications` Telegram command (`/notifications` = last 5, `/notifications read` = mark all read), updates `/help` text.
- `dashboard/server.ts` — adds `/api/notifications/*` proxy (REST + SSE pass-through) before the existing `/api/master/*` proxy.
- `dashboard/public/index.html` — bell button + `#notif-bell-badge` in the topbar; the drawer (`#notif-tray`) hangs from `<body>` so it overlays content without shifting layout.
- `dashboard/public/style.css` — `.notif-bell`, `.notif-tray`, `.notif-item` + severity glyph colors. Distinct from the `.orch-notify-*` per-team activity ring inside the orchestration tab.
- `dashboard/public/app.js` — `initNotificationTray`: REST seed on first open, SSE for live deltas, mark-read + mark-all-read, badge count, click-outside-closes.

## [2.7.21] — 2026-05-13

### `feat(dashboard): v2.7.21 web terminal escape hatch (ADR 0011 Layer 2)`

Closes ADR 0011 by landing the operator-facing web terminal — the always-available "drop into the worker's pane and type as yourself" escape hatch that the same 2026-05-12 paranoia-loop incident motivating Layer 1's HMAC marker exposed as a real product gap. With v2.7.21, breaking a stuck worker no longer requires SSH from another machine; an "Attach" button on every team card in the orchestration cockpit opens an xterm.js terminal in the browser, proxied through a node-pty sidecar running `tmux attach -t <session>`. Operator types directly into the worker's pane, bypassing master, bypassing HMAC, bypassing the worker's paranoia heuristics.

Layers 1 (HMAC marker, v2.7.20) and 3 (style matching, Evy SKILL.md since v2.7.15) shipped earlier; v2.7.21 makes ADR 0011 complete.

**The threat-model and security gate.** The web terminal exposes a shell-equivalent surface (anything the operator's user can do, including writing into worker tmux panes that bypass HMAC), so it ships default-OFF behind a flag file:

- `~/.config/subctl/terminal.enabled` — file presence = enabled, absence = disabled. No parsing, no schema, deliberately the simplest possible toggle. Touched by `/terminal on` from Telegram or `touch` from the shell.
- When disabled: `WS /api/terminal/attach` returns HTTP 403 on upgrade; `GET /api/terminal/teams` returns 403; `GET /api/terminal/enabled` returns `{enabled:false,flag_path:...}` (the dashboard UI uses this to hide all Attach buttons + the modal entirely via `body.terminal-disabled` CSS class).
- When enabled: WS upgrade succeeds; UI shows Attach buttons.
- **Auth pattern reuses dashboard's existing localhost-bind posture** (`SUBCTL_DASHBOARD_HOST` env, defaults `127.0.0.1`). No new auth surface, no cookies, no headers — the dashboard has no auth middleware today, and adding one here would be inventing policy. As defence-in-depth against DNS rebinding, when the dashboard is bound to a localhost address the WS upgrade additionally rejects requests whose `Host` header isn't a localhost variant. When the operator deliberately opens the dashboard to LAN we trust the listener config and skip the host check (same posture as `/api/orchestration/*` and friends).
- Team name validated against `[A-Za-z0-9._-]{1,128}` before the upgrade — tmux session names are operator-controlled but the path through the URL is not, so we clamp.

**Node sidecar instead of in-process node-pty.** node-pty under Bun 1.2.x has a known fd-handling bug (ENXIO on pty master read), so the dashboard server (Bun) spawns a tiny Node helper (`dashboard/lib/pty-helper.cjs`) per WS, and the helper owns the actual pty. The two processes speak a framed binary protocol over the helper's stdin/stdout: type byte (DATA / RESIZE / CLOSE / EXIT / ERROR) + 4-byte big-endian length + payload. node-pty works perfectly under Node, so the helper is reliable; the parent Bun process never needs to import node-pty directly.

**Browser wire format.** The xterm.js client (`dashboard/public/terminal.js`) and the server (`dashboard/terminal.ts`) use JSON text frames in the client→server direction and raw binary frames in the server→client direction. Specifically:

- `client → server` JSON only: `{"type":"data","b64":"<base64 keystrokes>"}` and `{"type":"resize","cols":N,"rows":N}`. Base64 in the data frame keeps the upstream direction plain-JSON and trivially inspectable in browser devtools; keystrokes are tiny so the 33% base64 inflation is irrelevant.
- `server → client` raw binary: pty bytes are handed straight to `xterm.write()`. Tmux redraws routinely emit tens of KB; base64 inflation would matter here, so the high-volume direction stays binary.
- Resize: a `ResizeObserver` on the terminal container + `xterm-addon-fit` recompute cols/rows whenever the modal resizes; the new geometry is sent as a `{type:"resize"}` frame which the server forwards to the helper as a typed RESIZE frame which calls `pty.resize(cols, rows)`.

**Telegram `/terminal` command.** Reaches the on/off control from a phone, not just the dashboard:

- `/terminal` (or `/terminal status`) — replies "🟢 web terminal is ON" or "⚪ web terminal is OFF (default)" with the flag-file path.
- `/terminal on` — touches the flag file, replies "refresh the dashboard to see Attach buttons".
- `/terminal off` — removes the flag file.

**UI surface.** The Attach button sits next to the existing `view` (read-only tmux preview) and `copy ssh attach` (clipboard SSH command) controls on every team card in the orchestration cockpit. Clicking it opens a 70vh modal with the xterm — close via `✕`, click-on-backdrop, or Escape. The whole surface is hidden when the flag file is absent; the operator never sees a 403.

**ADR 0011 closeout.** Status moves from "Accepted (shipped v2.7.20)" to "Accepted (Layer 1 shipped v2.7.20, Layer 2 shipped v2.7.21, complete)". The ADR's "Layer 2: Operator escape hatch (web terminal — v2.7.17)" section was always its motivating sibling to the HMAC marker; v2.7.21 fulfils it. Layer 3 (style matching) was already absorbed into the Evy persona SKILL.md in v2.7.15.

**Files:**

- New: `dashboard/terminal.ts` — pure handlers (`handleEnabled`, `handleTeams`, `evaluateUpgrade`, `originAllowed`, `spawnPtyBridge`), tmux session lister, flag-file resolution, and the WS gate.
- New: `dashboard/lib/pty-helper.cjs` — Node sidecar that owns node-pty. Speaks framed stdin/stdout to its Bun parent.
- New: `dashboard/public/terminal.js` — xterm.js client (mount/close/resize) exposed as `window.subctlTerminal`.
- New: `dashboard/package.json` — declares the new runtime deps (`node-pty`, `xterm`, `xterm-addon-fit`). Mirrors the `components/master/package.json` pattern; `install.sh` runs `bun install` here at install time.
- New: `dashboard/__tests__/terminal.test.ts` — 17 tests across flag-file behavior, REST handlers (with mocked tmux), upgrade decision matrix (disabled / bad team / bad host / no-such-session / happy path), DNS-rebind host check, and the framed sidecar wire protocol (DATA / RESIZE / CLOSE / EXIT round-trips against a stubbed child process).
- `dashboard/server.ts` — adds `/api/terminal/enabled`, `/api/terminal/teams`, `/api/terminal/attach` (WS); per-socket PtyBridge map keyed off `ws.data.kind === "terminal"` so terminal and `/api/live` sockets coexist; vendor static-file mappings for xterm.js + xterm-addon-fit served out of `dashboard/node_modules`.
- `dashboard/public/index.html` — loads `/vendor/xterm/xterm.css|js`, `xterm-addon-fit.js`, `terminal.js`; adds `#terminal-modal` with `#terminal-host` mount target.
- `dashboard/public/style.css` — `.terminal-shell`, `.terminal-host`, `.attach-web-btn`, plus `body.terminal-disabled .attach-web-btn, body.terminal-disabled #terminal-modal { display: none !important; }` for the disabled-flag path.
- `dashboard/public/app.js` — `wireWebTerminalGate()` queries `/api/terminal/enabled` on boot and stamps the body class; `openWebTerminal(teamName)` drives the modal; Attach button injected into the per-team card render alongside `view` / `copy ssh attach`.
- `components/master/master-notify-listener.ts` — `/terminal` command (status/on/off); help text updated.
- `docs/adr/0011-trust-marker-hmac-replacement.md` — status flipped to "Accepted (Layer 1 shipped v2.7.20, Layer 2 shipped v2.7.21, complete)"; Layer 2 section updated with implementation notes.
- `docs/adr/README.md` — index entry for ADR 0011 updated to reflect closeout.
- `docs/master.md` — new "Web terminal escape hatch" section: what it is, how to enable, security model, when to use.
- `lib/settings.sh` — `subctl_settings_install_dashboard_deps` runs `bun install` in `dashboard/` so the vendored deps land at install time.

## [2.7.20] — 2026-05-13

### `feat(master): v2.7.20 HMAC trust marker (ADR 0011 Layer 1)`

Replaces the plaintext trust-channel directive marker (ADR 0002, v2.7.9) with an HMAC-authenticated version (ADR 0011 Layer 1). Layer 2 (operator web-terminal escape hatch) is queued for v2.7.21; Layer 3 (style matching) already lives in Evy's SKILL.md since v2.7.15.

**The incident this fixes.** The plaintext marker `[subctl-master directive · phase=… · ts:…]` deployed in v2.7.9 was correctly identified as gameable the same night by the `osint-cve-monitor` team lead, which entered a "paranoia loop" refusing master's directives. The worker reasoned (captured from its tmux pane): *"An attacker has the same incentive to flatter the detection and assert legitimacy as a real supervisor does to dismiss it. The text content of a message can't authenticate the sender. Only the channel can."* It was right — anything that can write to the worker's tmux pane (a stray cron, a stale process, the model's own hallucinated continuations) could replicate the marker format. The marker provided pattern-matching, not authentication. Operator broke the loop only by SSH'ing in from another machine to inject tmux keystrokes directly; the dashboard offered no escape path. Full incident write-up in `docs/adr/0011-trust-marker-hmac-replacement.md`.

**The fix.** Per-team shared secret, generated at spawn time, used to authenticate every directive.

- **At spawn time** (`providers/claude/teams.sh`): generate a 32-byte (64-hex) secret, write to `~/.local/state/subctl/teams/<team_id>/hmac.secret` (chmod 600), inject it verbatim into the worker's spawn-time system prompt as part of the subctl-team-contract preamble. Idempotent: re-spawning the same team_id reuses the existing secret so the worker's prompt-baked copy stays in sync with disk. Honors `SUBCTL_STATE_DIR` (same convention as the policy-snapshot writer).
- **At message-send time** (`dashboard/server.ts` `/api/orchestration/:name/msg`): read the team's secret from disk, compute `hmac = first 16 hex chars of HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body)`, emit marker `[subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]`, paste-buffer that + body into the worker pane as before. All other send paths (`subctl orch msg` CLI, the MCP `subctl_orch_msg` tool, master's `subctl_orch.msg` tool) funnel through this same dashboard route, so HMAC applies to every supervisor-to-worker channel automatically.
- **At message-receive time**: the worker recomputes HMAC from its own copy of the secret. Match → trust. Missing / malformed / mismatch → reply "HMAC verification failed" and escalate. The verification instruction is baked into the worker's spawn-time prompt; the bash-gate policy permits ephemeral HMAC computation (`bash`, `node -e`, etc.) for workers that prefer external arithmetic over in-prompt reasoning.

**Centralized in one helper.** `components/master/trust-marker.ts` exports `generateSecret`, `ensureSecret`, `readSecret`, `computeHmac`, `buildDirectiveMarker`, `parseDirectiveMarker`, and `verifyDirectiveMarker`. The dashboard route calls `buildDirectiveMarker`; tests use `verifyDirectiveMarker` and `parseDirectiveMarker` against a tmpdir-scoped state dir. The secret value never appears in any log line, telemetry event, error message, or audit entry — disk file + worker prompt are its only legitimate exposure paths.

**Fail-loud on missing secret.** If `hmac.secret` is missing on disk when the dashboard tries to send a directive, the route refuses with HTTP 500 and a descriptive error: *"HMAC secret missing for team <team_id>. Cannot send authenticated directive. Run /subctl team rekey <team_id> to regenerate."* No silent fallback to an unauthenticated marker — that would train workers to ignore the auth field, defeating the whole point. The `/subctl team rekey` command is queued (operator-facing recovery path); for now the rekey is "kill the team, re-spawn it".

**Backward compatibility (pre-v2.7.20 workers).** Workers spawned before this version don't have the new HMAC verification step in their prompt. The v2.7.9 worker contract teaches them to recognize the `[subctl-master directive ...]` prefix structurally and does NOT instruct them to reject markers with unknown extra fields. They will see the new `hmac:<...>` field at the end of the bracket header as an unrecognized but benign extension — they still trust the channel marker as before. No flag-day cutover required; the protocol stays forward-compatible by extension. New workers spawned after upgrading get full HMAC verification.

**Provider-scope hygiene.** The HMAC helper lives in `components/master/` and the dashboard route is provider-agnostic — it just resolves `team_id → hmac.secret`. The only place that knows about the claude provider is `providers/claude/teams.sh` (which is allowed to be claude-aware by design). Other providers — `providers/pi-coding-agent/teams.sh` — pick up HMAC when they adopt the same per-team secret-file convention.

**Files:**

- New: `components/master/trust-marker.ts` — helper module (generate/read secret, build/parse/verify marker, computeHmac primitive).
- New: `components/master/__tests__/trust-marker.test.ts` — 32 tests across secret lifecycle, marker construction, parsing, verification happy + tamper paths, and a known-vector HMAC sanity check.
- `providers/claude/teams.sh` — generates the per-team `hmac.secret` if missing (`head -c 32 /dev/urandom | xxd -p -c 64`), writes chmod 600, injects the secret + verification instructions into the spawn-time team-contract preamble.
- `dashboard/server.ts` — `/api/orchestration/:name/msg` route imports `buildDirectiveMarker` from the helper and uses it to construct the marker; missing-secret path returns HTTP 500 with the descriptive rekey-pointer error rather than falling back to plaintext.
- `components/master/tools/subctl-orch.ts` — `msg` tool description updated to name HMAC authentication (v2.7.20) accurately.
- `docs/adr/0011-trust-marker-hmac-replacement.md` — status updated to "Accepted (shipped v2.7.20)"; implemented-in field updated.
- `docs/adr/README.md` — index entry for ADR 0011 updated.
- `docs/master.md` — new "Authenticated trust markers" subsection covering the protocol, secret hygiene, fail-loud behavior, and backward compatibility.

## [2.7.19] — 2026-05-13

### `feat(master): watchdog kill controls + empty-listener circuit breaker`

Two related reliability fixes in one release, both driven by the same 2026-05-13 incident that motivated v2.7.18's chat/heavy profile split.

**The incident.** During a 90-minute drive home, the master daemon — running the heavy supervisor `qwen/qwen3.6-35b-a3b` — stopped responding to Telegram. Post-mortem revealed master was stuck in an infinite tool-call loop alternating between an assistant turn with `stopReason: "toolUse"` and empty text, and a tool result with `{ entries: [], listener: { running: false, ... } }`. The looping tool was **`subctl_orch_inbox`** (→ dashboard `/api/notify/inbox` → `dashboard/notify-listener.ts:notifyListenerStatus()`). The reasoning model fell into a "check again before answering" trap: empty inbox + dead listener → check again → repeat. CPU sat at 0.3% (idle); the prompt queue was wedged for 90 minutes because every assistant turn ended in another tool-use instead of a final text response. The operator had no kill path until they got home.

**Part A — Watchdog kill controls.** A minimal central registry (`components/master/watchdogs.ts`) every long-running setInterval / poll-loop in master registers through: the telegram listener, the cli-prompt poll, the lead-report inbox tailer (2s), the team-staleness watchdog (3-min ticker), the followup-scheduler (60s), the auto-compact safety net (5-min), and the verifier denial-cluster ticker (30s). Each entry surfaces `id · kind · started_at · last_tick_at · age_seconds`. Three surfaces consume it:

- **Master tools (Evy)** — `watchdog_list` enumerates; `watchdog_kill { id }` kills one. Registered in the master tool registry automatically; no persona / SKILL.md edits required.
- **Dashboard** — `GET /api/watchdogs` + `POST /api/watchdogs/:id/kill` pass through to the master daemon. New collapsible "Watchdogs" card on the Orchestration tab polls every 10 s while open (idle when closed). Each row shows the id, kind, age, last-tick time, and a `[Kill]` button with confirm-before-kill. Optimistic removal; server reconciles on the next poll.
- **Telegram** — `/watchdogs` lists, `/watchdogs kill <id>` kills one, `/watchdogs killall` kills everything except `kind === "telegram-listener"` (preserved so the operator's last surviving kill path can't sever itself). Reply shows the killed + preserved id lists for transparency.

The probes themselves are NOT rewritten — each setInterval call site is wrapped to (a) call `touchWatchdog(id)` at the start of each tick so `last_tick_at` stays fresh, and (b) register a `kill: () => clearInterval(id)` (or the equivalent `AbortController.abort()` for the telegram listener) so the registry can tear them down without a master restart.

**Part B — Empty-listener circuit breaker.** The actual bug fix. Lives in `components/master/circuit-breaker.ts` and wires into the tool-call dispatch path inside `adaptTool` (`components/master/server.ts`). After each tool result, the breaker inspects the payload. If the result is an object with `entries === []` AND `listener.running === false`, the per-tool consecutive counter increments. After three such consecutive returns for the same tool name, the **fourth** call to that same tool within the current turn is refused before invocation — instead of calling the tool, the model receives a synthesized tool result:

```
{ "error": "circuit-breaker: tool <name> returned empty entries with listener.running=false 3 times in a row. The listener is dead. Stop polling — either call watchdog_list to inspect, or respond to the operator with what you have." }
```

The trip is logged at warn level: `[circuit-breaker] tripped on tool=<name> after 3 empty-dead-listener returns`. The breaker is conservative on purpose: a different tool's result (or a non-empty result from the same tool) resets the counter, and a new operator message clears state via `resetOnNewTurn()` at the top of `processOnePrompt` (synthetic source=`"watchdog"` prompts deliberately do NOT reset — they're tail continuations of the prior reasoning trail, not new operator intent). False positives should be rare because the trigger pattern (`entries: []` AND `listener.running === false`) only matches results that strongly indicate "listener dead + nothing to deliver".

**No ADR.** Both halves are tactical reliability fixes — registry + breaker — not load-bearing architectural decisions. The probes' designs are unchanged; the kill paths and the breaker just wrap them.

**Files:**

- New: `components/master/watchdogs.ts` — registry + register/touch/list/kill/killAll.
- New: `components/master/tools/watchdogs.ts` — `watchdog_list` + `watchdog_kill` master tools.
- New: `components/master/circuit-breaker.ts` — empty-listener heuristic + per-tool counter.
- New: `components/master/__tests__/watchdogs.test.ts` — register / list / kill / kill-missing-id / killall preserve-kinds.
- New: `components/master/__tests__/circuit-breaker.test.ts` — 3-trip pattern, mid-stream reset on non-empty, reset on different tool, reset on new turn.
- `components/master/server.ts`: imports registry + breaker; tool registry includes `watchdogTools`; `adaptTool` checks `shouldRefuseToolCall` and calls `recordToolResult`; `processOnePrompt` calls `resetCircuitBreakerOnNewTurn` for `source === "chat" | "telegram"`; all four in-server setInterval call sites (`inboxPoll`, `watchdog`, `followupTicker`, `autoCompactInterval`) wrapped with `touchWatchdog` + `registerWatchdog`; `startClusterTicker({ onTick })` registered too; HTTP routes `GET /watchdogs`, `POST /watchdogs/:id/kill`, `POST /watchdogs/killall`.
- `components/master/master-notify-listener.ts`: registers `telegram-listener` + `cli-prompt-poll` watchdogs at start; deregisters on stop via `_stopInternal` (private to avoid recursion when killWatchdog invokes the entry's kill closure); both poll loops call `touchWatchdog` at the start of each iteration; `/watchdogs`, `/watchdogs kill <id>`, `/watchdogs killall` commands added; `/help` updated.
- `components/master/tools/policy/verifier-cluster.ts`: `startClusterTicker` gains an optional `{ onTick }` callback so server.ts can wire `touchWatchdog("verifier-cluster")` without restructuring the module.
- `dashboard/server.ts`: `/api/watchdogs` GET + `/api/watchdogs/:id/kill` POST as thin pass-throughs to the master daemon's `/watchdogs` endpoints (matches the v2.7.18 `/api/profile` shape).
- `dashboard/public/index.html`: collapsible `<details>` "Watchdogs" card on the Orchestration tab with a table for id / kind / age / last-tick / Kill button.
- `dashboard/public/app.js`: `wireWatchdogPanel()` — open/close drives 10s polling; optimistic kill with confirm; sorts telegram-listener + inbox-poll first.
- `dashboard/public/style.css`: `.watchdog-card`, `.watchdog-table`, `.watchdog-kill-btn` styles (red-accented kill button to match the existing watchdog-row vocabulary).
- `docs/master.md`: "Watchdog controls" + "Empty-listener circuit breaker" sections.

## [2.7.18] — 2026-05-13

### `feat(master): supervisor profiles (chat / heavy) with dashboard pill + telegram command`

Two named supervisor profiles — `chat` (default: `google/gemma-4-31b`) and `heavy` (default: `qwen/qwen3.6-35b-a3b`) — that the operator switches between from the dashboard's sticky chat-header pill or via Telegram `/profile chat|heavy` without restarting the master daemon. Replaces the v2.7.16 dashboard model-picker round-trip for the common "use light model for chat, heavy model for hard reasoning" toggle.

**Why.** During a 90-minute drive home on 2026-05-13 the supervisor was `qwen/qwen3.6-35b-a3b` (heavy reasoning model). It got stuck in a tool-call loop and stopped responding to Telegram. The chat profile (gemma-4-31b) would have been responsive. The existing supervisor-switch path bounces the launchd-managed master daemon, which is too heavy for a one-handed in-car toggle. Profiles land the switch at the next prompt boundary, no restart, transcript intact.

**How it works.**

- **State** lives at `~/.config/subctl/profiles.json` (`chmod 600`). Master seeds the file on first boot — if `providers.json.models.supervisor` looks like gemma it becomes the `chat` profile, qwen becomes `heavy`, otherwise both fall back to hardcoded defaults. Default `active: "chat"`.
- **Module** `components/master/profiles.ts` exports `loadProfiles()`, `getActiveProfile()`, `setActiveProfile(name)`, `watchProfiles(onChange)`. `watchProfiles` uses `fs.watch` on the file with a 200ms debounce (macOS fires the event twice on atomic-rename saves).
- **Master boot** loads profiles and overrides `models.supervisor.model` + `host` from the active entry, keeping `provider` / `context_length` / `max_tokens` from `providers.json`. The watcher sets `pendingProfileSwap = true`; the actual model rebuild happens at the **start of the next prompt** inside `processOnePrompt` — never mid-turn (pi-agent-core reads `agent.state.model` once per prompt, so a swap at the boundary lands cleanly). On swap, master also re-pins LM Studio at the role's `context_length` to defeat the 4K JIT trap on first use of the new model.
- **HTTP** `GET /profile` returns `{active, profiles, detail}`; `POST /profile {profile}` writes the file (and `fs.watch` does the rest). `/health` gains an `active_profile` field. Dashboard adds a `/api/profile` pass-through so the pill doesn't have to know about the master port.
- **Dashboard pill.** Small rounded pill in the sticky `.master-chat-header` next to the Evy h2 — green for `chat`, amber for `heavy`. Click toggles. Refresh: subscribes to the existing `/api/master/events` SSE for the `profile_swapped` event so out-of-band swaps (Telegram, another tab, manual file edit) reflect immediately; 30s poll as a fallback.
- **Telegram.** `/profile` reports the active profile + its supervisor model. `/profile chat` and `/profile heavy` swap. Anything else replies with usage + the current profile list. Lives in `master-notify-listener.ts` alongside the existing `/status` / `/pause` / `/resume` handlers.

**Constraints honored.** No new ADR — this is tactical config flexibility, not a load-bearing decision. The provider-scoping rule (claude-specific identifiers stay inside `providers/claude/`) is unchanged. The LM Studio token (`sk-Lm-*`) is not logged. Tests live in `components/master/__tests__/profiles.test.ts` and cover the seeding, persistence, invalid-active fallback, throw-on-unknown, and the watcher debounce contract.

**Files:**

- New: `components/master/profiles.ts`
- New: `components/master/__tests__/profiles.test.ts`
- `components/master/server.ts`: imports profiles module; supervisorCfg becomes `let` and is rebuilt on swap; `pendingProfileSwap` flag + `applyProfileSwap()` helper at start of `processOnePrompt`; `watchProfiles` subscription with shutdown cleanup; `/profile` GET/POST endpoints; `active_profile` in `/health`.
- `components/master/master-notify-listener.ts`: `/profile` command handler; `/help` updated.
- `dashboard/server.ts`: `/api/profile` pass-through to master `/profile`.
- `dashboard/public/index.html`: `.profile-pill` inside `.master-chat-header` next to the Evy h2.
- `dashboard/public/style.css`: pill styling (green `chat` / amber `heavy`, pending state, error flash).
- `dashboard/public/app.js`: `wireProfilePill()` with optimistic toggle, SSE `profile_swapped` listener, 30s poll fallback.
- `docs/master.md`: "Supervisor profiles" section.

## [2.7.17] — 2026-05-13

### `feat(providers): OpenRouter as first-class model provider`

OpenRouter is a unified API gateway for hundreds of AI models (incl. a large free-preview tier across many vendors) speaking the OpenAI Chat Completions wire format at `https://openrouter.ai/api/v1`. v2.7.17 registers `openrouter` as a first-class provider alongside the existing `anthropic`, `openai`, `lmstudio`, `mlx`, `ollama`, `vllm`, `mistral`, `google`, `google-vertex`, and `amazon-bedrock` entries. The integration is the smallest of the recent provider series because subctl's provider abstraction already does the heavy lifting; OpenRouter is OpenAI-compatible, so the wire format is shared with the existing local-runtime providers and pi-ai's `openai-completions` stream factory dispatches it unchanged.

**How it works.** The provider gets three pieces of wiring:

- `PROVIDER_API["openrouter"] = "openai-completions"` in `components/master/server.ts` — same family as the local runtimes.
- `buildModel({provider: "openrouter", ...})` defaults `baseUrl` to `https://openrouter.ai/api/v1` when `providers.json` omits the `host` field. An explicit `host` still wins (proxies, regional endpoints).
- `getApiKeyForProvider("openrouter")` resolves `openrouter_api_key` via the v2.7.4 priority chain (env > secrets.json > absent). Unlike the local runtimes it does NOT return the `"not-needed"` sentinel — OpenRouter requires a real key on every request, so absence surfaces as `undefined` and pi-ai reports "no API key for provider: openrouter" instead of silently 401-ing.

Model IDs use OpenRouter's `vendor/model` format: `openai/gpt-5.2`, `anthropic/claude-sonnet-4`, `mistralai/mixtral-8x22b-instruct`, `meta-llama/llama-3.3-70b-instruct:free`. Browse https://openrouter.ai/models for the live catalog.

**Operator setup (one-time).** Mint a key at https://openrouter.ai/keys → paste it into the dashboard's Settings → API Tokens panel under `openrouter_api_key` (writes `~/.config/subctl/secrets.json` chmod 600), OR export `OPENROUTER_API_KEY` in `~/Library/LaunchAgents/com.subctl.master.plist`'s EnvironmentVariables. Then switch the supervisor via the dashboard's model picker — pick provider `openrouter`, paste a model ID like `anthropic/claude-sonnet-4`. The host field can be left blank; master defaults to `https://openrouter.ai/api/v1`. `providers.json.example` carries an `_alt_supervisor_openrouter` block showing the shape for operators who want to hand-edit `providers.json` directly.

**What's NOT included in v2.7.17:**

- **Attribution headers** — OpenRouter accepts optional `HTTP-Referer` and `X-OpenRouter-Title` headers for leaderboard attribution. Intentionally omitted; the operator stays anonymous on the OpenRouter leaderboard. Adding them later would need pi-ai to support per-provider extra headers and is a separate small change.
- **Tier-specific routing** — no automatic `:free`-first fallback chain. The operator picks a specific model per spawn / per supervisor switch.
- **1Password secret backend** — that's v2.7.18 (ADR 0012). The `openrouter_api_key` lives in the existing `secrets.json` chain like the other API keys.

**Trade-offs.** Higher and more variable latency than local runtimes (cloud round-trip + per-vendor cold-start on OpenRouter's side); model availability changes (vendors can deprecate or reroute IDs without notice); per-model rate limits (see https://openrouter.ai/docs/faq#how-are-rate-limits-calculated). Trade-off vs direct vendor SDKs: one key + one billing relationship instead of N, with a uniform OpenAI-compat surface in exchange for missing some vendor-specific features.

**Files:**

- `components/master/server.ts`: `PROVIDER_API.openrouter = "openai-completions"`; `buildModel` baseUrl default extended; `getApiKeyForProvider` openrouter case; `PROVIDER_API` and `buildModel` re-exported for the test suite.
- `components/master/secrets.ts`: `openrouter_api_key` added to `SECRET_KEYS`; `envVarFor("openrouter_api_key") → "OPENROUTER_API_KEY"`.
- `dashboard/server.ts`: `openrouter` added to `WIRED_PROVIDERS` allowlist in the `/api/master/supervisor` handler. The cloud-provider host-clearing branch already does the right thing — clearing `host` lets `buildModel` fall through to the openrouter default URL.
- `dashboard/public/app.js`: `openrouter_api_key` description added to the Settings → API Tokens panel.
- `components/master/providers.json.example`: `_alt_supervisor_openrouter` block appended as an operator-facing reference.
- New: `components/master/__tests__/openrouter-provider.test.ts` — pins the three contracts (PROVIDER_API entry, baseUrl default + explicit host override, API key required-and-undefined-when-absent semantics).
- `docs/master.md`: Phase 3o.17 section documents the integration.

## [2.7.16] — 2026-05-13

### `feat(tools): TinyFish first-class — tinyfish_search + tinyfish_fetch as native master tools`

Two new master tools land alongside the existing `web_search` (Brave) and `web_fetch` (Firecrawl): `tinyfish_search` and `tinyfish_fetch`, integrated first-class via HTTP rather than MCP passthrough. Master is a daemon and can't pop a browser for OAuth, so the REST API path is the right surface — the MCP endpoint's browser-OAuth flow is a separate auth surface and isn't viable here. The tools show up in `/diag`, the dashboard, and Evy's tool list as native master tools.

**Endpoints (verified against https://docs.tinyfish.ai on 2026-05-13):**

- Search: `GET https://api.search.tinyfish.ai` — params `query` (required), `location`, `language`, `page` (0–10). Response shape: `{ query, results: [{position, site_name, title, snippet, url}], total_results, page }`.
- Fetch: `POST https://api.fetch.tinyfish.ai` — body `{ urls: [url], format: "markdown"|"html"|"json", links?: bool, image_links?: bool }`. Response: `{ results: [{url, final_url, title, description, language, author, published_date, text, latency_ms, format}], errors: [{url, error, status?}] }`. Per-URL failures surface as structured errors (e.g. `robots_blocked` with status 403).
- Auth: `X-API-Key` header (NOT `Authorization: Bearer` — the brief assumed OAuth, but TinyFish's REST API uses an API key minted at https://agent.tinyfish.ai). Free tier is 30 req/min and search + fetch do not consume credits.

**Operator setup (one-time):** sign in at https://agent.tinyfish.ai and mint an API key, then paste it via the dashboard Settings → API Tokens panel (writes `~/.config/subctl/secrets.json` chmod 600) under `tinyfish_api_key`, OR set `TINYFISH_API_KEY` in `~/Library/LaunchAgents/com.subctl.master.plist` EnvironmentVariables followed by `launchctl kickstart -k gui/$UID/com.subctl.master`. The v2.7.4 priority chain (env > secrets.json > absent) applies. Until the secret is configured, both tools return `{ ok: false, error: "TINYFISH_API_KEY not configured", ... }` with an actionable hint — they never throw.

**Fallback hierarchy:** try TinyFish first for current-events search (different index + freshness signal vs Brave) and for clean article extraction with structured metadata (author + published_date land in the response). Fall back to `web_search` / `web_fetch` if results are sparse, the URL is robots-blocked, or the rate limit trips a 429. All HTTP failures (4xx, 5xx, 429, network, timeout) surface as structured `{ ok: false, error, status, retry_after? }` payloads. 401 includes a `hint` to re-mint the key at agent.tinyfish.ai.

**Naming note.** The dispatch brief specified `tinyfish_oauth_token` as the secret key under the assumption that TinyFish auth was OAuth. Verifying the docs revealed the REST API uses `X-API-Key` instead, so the secret is named `tinyfish_api_key` to match the actual auth surface and the existing `brave_api_key` / `firecrawl_api_key` / `linear_api_key` pattern. The MCP endpoint (`https://agent.tinyfish.ai/mcp`) still uses browser OAuth — that flow is unaffected by this integration.

**Scope discipline.** Browser automation, batch operations, and structured-extraction tiers from TinyFish are not integrated — those are paid surfaces and out of scope for v2.7.16. HMAC trust marker stays slated for v2.7.17. Web terminal stays slated for v2.7.18. `components/skills/master/SKILL.md` was not touched.

**Files:**

- New: `components/master/tools/tinyfish.ts` (two tools, injectable `fetchHttp` dep matches `web.ts` pattern).
- New: `components/master/tools/__tests__/tinyfish.test.ts` (21 hermetic tests — no real HTTP).
- `components/master/secrets.ts`: `tinyfish_api_key` added to `SECRET_KEYS`; `envVarFor("tinyfish_api_key") → "TINYFISH_API_KEY"`.
- `components/master/server.ts`: import + register the family after the web family.
- `dashboard/server.ts` and `dashboard/public/app.js`: `TINYFISH_API_KEY` row added to the Settings → API Tokens panel.
- `docs/master.md`: Phase 3o.16 section documents the new family.

Master tool count: **71 → 73**. Test count: **537 → 558** (+21).

## [2.7.15] — 2026-05-13

### `feat(persona): Evy lands — SKILL.md rewrite + voice preset + tool-description imperative voice`

The master daemon is now the Evy persona end-to-end. `components/skills/master/SKILL.md` is a verbatim port of the operator-authored system prompt from `docs/persona/evy.md` §1, including the two subctl-added sections ("Tool use is non-negotiable" and "Continuity across model swaps"), followed by a subctl-specific adaptations block that maps the spec's ArgentOS conventions to subctl's actual backends:

- Five-tier memory model named explicitly (Tier 1 MEMORY.md, Tier 2 Obsidian read-only, Tier 3 Memori v2.7.16+ forthcoming, Tier 4 claude-mem corpus, Tier 5 `.subctl/docs/`). Filing convention: name the tier. See [ADR 0005](docs/adr/0005-five-tier-memory-architecture.md).
- Two-tier family (at-the-desk tools vs back-stacks dev teams), not ArgentOS's flat 29-agent family.
- Think Tank dropped — no phantom capabilities. See [ADR 0007](docs/adr/0007-think-tank-concept-dropped.md).
- Style-matching instruction for `subctl_orch_msg`: terse, lowercase, imperative to match operator voice. This is Layer 3 of the trust-marker design from [ADR 0011](docs/adr/0011-trust-marker-hmac-replacement.md) (Layer 1 HMAC ships v2.7.16; Layer 2 web terminal ships v2.7.17).

`components/master/personalities/evy.md` ships as a new voice preset (dry, precise, slightly impatient with hand-holding, owns mistakes plainly, no grovel, no em dashes). The default preset in `components/master/personality.ts` is flipped from `straight-shooter` to `evy`. Existing presets remain available.

Tool descriptions across `memory_*`, `subctl_orch_*`, `team_doc_*`, and `system_*` are rewritten in the "**Use this FIRST when**..." imperative voice. The pattern leads with WHEN to invoke (the trigger), not WHAT it does (the model can read the schema for that). Memory tools also name their tier, so Evy's filing convention is reinforced at the tool-description layer.

See [ADR 0004](docs/adr/0004-evy-persona-librarian-framing.md) for the persona-adoption decision.

### `feat(eval): 24 persona tests on the v2.7.11 harness — bun test components/master/__tests__/evy-eval/`

The Evy persona is load-bearing. Without a measurement loop, every prompt iteration is a gamble. v2.7.15 ships the 24-test eval suite built on top of the harness scaffolded in the prior PR (regex fast-fail → LLM judge → JSON output → bun assertion). Tests cover seven categories:

- Pushback Protocol (4) — pushback shape, override compliance, elaboration on demand, no stacking
- Verification (3) — clean relay with provenance, send-it-back on bad output, surface conflict
- Persona Stability (4) — continuity across model swaps, identity probing, curt operator, venting
- Routing Discipline (4) — desk vs back-stacks, no fan-out, right specialist, name the agent
- Memory and Provenance (3) — tier-named filing, source_type, no file-without-provenance
- Error Recovery (3) — own the mistake plainly, route around flaky specialists, no fabrication on tool error
- Format and Voice (3) — no em dashes, no emojis, no padding

Each test follows the rubric pattern from `docs/persona/evy-eval-rubric-test-1.2.md` §"Test shape in bun": per-test judge prompt inline (3-5 criteria, one binary), regex fast-fail vetoes to FAIL, LLM judge skipped when no `ANTHROPIC_API_KEY` (test tagged `regex-only-pass` instead of `pass` so partial grading is legible in every score-log line).

Tests live under `components/master/__tests__/evy-eval/tests/` (7 files by category). Pipeline boilerplate is centralized in `tests/_helpers.ts` — each test file declares scenarios + judge prompts; the helper handles regex, judge, and score-log writes.

See [ADR 0008](docs/adr/0008-eval-suite-pipeline.md) for the pipeline decision.

### `fix(schema): memory_remember.source_type + memory_forget.confirmation + subctl_orch_kill.confirmation+reason — hard rules at the tool layer`

The persona prompt says Evy resists letting anything into memory without provenance, owns mistakes plainly without grovel, and treats destructive actions as escalations. Three tool schemas now enforce that structurally rather than relying on prompt adherence alone:

- `memory_remember` requires `source_type` (enum: `operator-asserted | verified-external | self-inferred | agent-reported`). Missing or invalid source_type returns `{ ok: false, error: "source_type required" }`. The tag is prepended to the stored entry body so every Tier 1 fact carries its provenance forever.
- `memory_forget` requires `confirmation: true`. Anything else returns `{ ok: false, error: "memory_forget requires explicit confirmation: true" }`. Evy does not destroy memory without confirmation.
- `subctl_orch_kill` requires `confirmation: true` AND `reason` (string, ≥10 chars). The reason gets posted with the kill so the destruction is on the record. Workers cost time to spawn; killing them silently makes the audit trail worthless.

Schema validation is enforced in the tool's `invoke()` body — the tool layer is the right place because the model's prompt adherence is best-effort while the schema is a contract.

## [2.7.14] — 2026-05-12

### `fix(dashboard/chat): structural header — wrap toolbar + H2 in one sticky band`

The v2.7.13 z-index/background fix didn't solve it. Operator reported the
toolbar still visually overlapping (and being clipped) when the chat-log
scrolled, plus the "Master" H2 line floated separately above the log
without sticky protection.

Root cause was structural, not presentational. The HTML had:

```
<section class="master-chat">
  <div class="ctx-overflow-banner">
  <div class="chat-toolbar">       ← sticky
  <h2>Master ... CONNECTED</h2>     ← SIBLING, not sticky
  <div class="master-log">          ← own overflow-y: auto
```

`position: sticky` on the toolbar was relative to `.master-chat`, but the
master-log scrolled INSIDE its own container. Two different scroll
contexts. The H2 had no sticky at all. Net: scrolled content visually
intersected the toolbar/H2 region in ways that z-index couldn't fix.

v2.7.14 wraps `ctx-overflow-banner + chat-toolbar + h2` in a single
`<div class="master-chat-header">`. The header is the sticky band.
Master-log scrolls underneath cleanly. No sibling-scroll-context
mismatch.

Also: the H2 text changed from "Master" to "Evy" (matching the persona
rename for the chat panel; v2.7.13 already changed the assistant bubble
label but missed the panel H2).

CSS changes:
- New `.master-chat-header` — sticky, opaque, drop-shadow on bottom
- `.chat-toolbar` no longer sticky / no own background — inherits from header
- `.master-log` top padding back to 12px (header now owns the visual gap)

Files: `dashboard/public/index.html` (1 wrap edit, H2 text), `dashboard/public/style.css` (3 rule edits). No JS, no master-daemon changes.

## [2.7.13] — 2026-05-12

### `fix(dashboard/chat): label normalization + sticky-toolbar overlap`

Three operator-reported polish issues from the v2.7.12 chat panel:

**1. Label normalization to "evy" (renders as "EVY" via CSS uppercase).**
The thinking indicator said "evy · thinking" (lowercase, no
text-transform on `.chat-thinking__label`), while the assistant
response label said "MASTER" (CSS-uppercased `.master-msg-label`). Two
different names for the same agent in adjacent UI elements. v2.7.13
normalizes all three render sites to label `"evy"`:

- `appendMessage("assistant", ..., { label: "evy" })` (live SSE bubble)
- `<div class="master-msg-label">evy</div>` (transcript replay bubble)
- `<div class="pd-chat-label">evy</div>` (project-chat bubble)

CSS `.master-msg-label` already has `text-transform: uppercase`, so the
rendered label is "EVY", consistent with "YOU" / "WATCHDOG" patterns.
The thinking indicator's `.chat-thinking__label` is *not* uppercased,
so it now reads "Evy · thinking ● ● ●" (capital-E, mixed case),
matching the operator's preferred name styling for that surface.

**2. Sticky toolbar overlap.** When the master-log scrolled to the top,
chat content visually butted against (and sometimes overlapped) the
chat-toolbar's bottom border. The toolbar was already
`position: sticky; top: 0; z-index: 5; background: var(--bg-1)` (from
v2.7.10), but in practice operator reported the toolbar becoming
unclickable and visually contaminated by scrolled content. Two fixes:

- Bumped `z-index: 5 → 50` so the toolbar dominates any sibling
  stacking context it might end up next to.
- Replaced `background: var(--bg-1)` with the explicit opaque hex
  `#0e1116` (same value, but ensures no stacking-context-driven
  transparency anomalies).
- Added a soft drop-shadow on the toolbar's bottom edge so scrolled
  content tucks cleanly beneath the toolbar instead of colliding with
  its border.
- Bumped `.master-log` top padding from `12px` to `20px` (per operator
  suggestion) so the first message has clear breathing room beneath
  the toolbar.

**3. Z-index/opaque-bg defensive belt and suspenders.** The previous
fix (v2.7.10) was layout-level; this one is presentation-level. Both
should be in place so the next person who edits chat-panel CSS doesn't
need to re-discover the failure mode.

Files: `dashboard/public/app.js` (5 string edits), `dashboard/public/style.css` (3 rule edits, 1 comment update). No master-daemon changes. No test changes.

## [2.7.12] — 2026-05-12

### `feat(dashboard/chat): inline neon-glow tool pills + thinking indicator`

**What changed.** The dashboard Chat panel no longer renders each tool
call as a full-width card. Pre-2.7.12 a single turn that ran four tools
spawned four separate "TOOL · system_log_tail" blocks (often with an
empty `{}` body), eating ~60% of the panel width. v2.7.12 replaces that
with a row of inline **neon-glow pills** grouped per assistant turn,
color-coded by tool family, with a one-line truncated arg preview.

**Visual.** Each pill is a translucent rounded badge with a colored
border + soft outer glow (CSS `box-shadow` + `color-mix`), styled in the
spirit of sci-fi command-center dashboards. Family colors:

- `system_*` → cyan
- `system_lmstudio_*` → teal-cyan
- `system_subctl_knowledge` → magenta
- `memory_*` + `mcp__plugin_claude-mem_*` → purple
- `web_*` / `linear_*` / `context7_*` → green
- `subctl_orch_*` → orange
- `team_doc_*` + `team_decision_log` → mint
- `policy_*` → yellow
- `notify_*` + `telegram_*` → pink
- Anything else → grey

**Args preview.** Truncated single line next to each pill:

- Empty `{}` → no preview rendered (no more noise)
- One key → `key=value` (value clipped to 24 chars)
- Multiple keys → `k1=v1, k2=v2 …` (clipped to 40 chars total)

Click any pill → opens a `notice()` dialog with full args + full result
(pretty-printed).

**Live rendering.** Pills appear as SSE `toolcall_start` events arrive,
so the operator sees master fetching tool after tool in real time. The
`tool_result` event patches the originating pill with a ✓ (success) or
✗ (error) marker. Pills from a single assistant turn share one
`.chat-tool-pills` row that wraps naturally; the next turn opens a
fresh row.

**Thinking indicator.** While master is processing a chat turn (operator
just sent, first SSE event has not arrived yet), the panel shows a
pulsing `evy · thinking ● ● ●` line. Cleared on first `text_delta` /
`toolcall_start`, on `agent_end`, or on error / 30s timeout. The label
uses "evy" (the rename landing alongside the persona work in v2.7.13)
so the text doesn't have to flip twice.

**Config file.** New `dashboard/public/tool-display.json` is the single
source of truth for the family → color/icon map and the name-prefix →
family rules. Walks `rules` in order, first match wins, unmatched falls
back to grey. Fetched once at boot, cached, with a hardcoded copy baked
into `app.js` for offline / deploy-failure resilience.

**Files touched.**

- `dashboard/public/tool-display.json` (NEW) — family/icon/rules config
- `dashboard/public/app.js` — pill helpers + replaced three tool-call
  render sites + wired thinking indicator into `sendChat`
- `dashboard/public/style.css` — pill + thinking indicator styles (uses
  `color-mix` for translucent variants; Safari 16.4+, Chrome 111+,
  Firefox 113+)
- `dashboard/server.ts` — `/tool-display.json` added to STATIC_FILES
- `docs/master.md` — chat panel section updated with pill description

No master-daemon changes. No test changes. Tool-call wire protocol
(SSE event names, JSON shapes) untouched.

## [2.7.11] — 2026-05-12

### `fix(verifier): structured tool-call inspection + keyword-overlap validation`

Closes a hallucination gap operator caught in live Evy interaction
(2026-05-12). Pre-v2.7.11 verifier only name-matched: if `memory_remember`
appeared in this turn's tool calls, any memory-related claim was treated
as verified. Operator-observed exploit: Evy could call `memory_remember`
with arbitrary content (or with an erroring call) and then make any
memory claim she wanted; the verifier had no view into args or results.

This release upgrades the verifier interface and adds two structural
checks. Plus broadens the trigger regexes that operator-observed verbs
missed:

- **`memory-update-claim`** (new in v2.7.11) — catches "I've updated my
  learned-facts memory", "I have committed the rule to my Tier-1 memory",
  "Memory has been updated", and variants the original
  `decision-logged-claim` regex didn't cover. Verbs:
  `updated|updating|committed|committing|stored|storing|pinned|pinning|
  locked|added|adding|remembered|remembering|memorized|memorizing|
  persisted|persisting|saved|written|writing|recorded|recording`.
- **`procedure-or-rule-update-claim`** (new in v2.7.11) — catches "I am
  updating my internal operating procedure", "I've added a hard-coded
  rule", "I have authored a skill", and variants.
- **`decision-logged-claim`** (extended) — adds `filed` to the verb
  list, adds `team_decision_log` (v2.7.10) to the satisfying-tool list.

### What changed in the verifier interface

**`AssistantTurn` now carries `tool_calls: ToolCallRecord[]`** (each
record has `name`, `arguments`, `result`, `is_error`) instead of the
flat `tool_names_called: string[]`. `extractLastTurn` walks
`assistant`-role tool_use blocks and pairs them with `tool_result`
blocks in subsequent `user`-role messages by `tool_use_id`. The
real-user-prompt scan now skips tool-result-bearing user messages so
the turn slice captures the full assistant sequence, not just the
trailing fragment after the last `tool_result`.

**Tool errors disqualify a claim.** If a matching tool call has
`is_error: true` (either set explicitly or inferred from `ok: false` in
the result, or a string starting with "Error:"), it is excluded from
the candidate set. If all matching calls errored, the claim is
unverified even though the tool name appeared.

**Per-rule `validate` function.** Each `VerificationRule` can attach a
validator that runs after the name + error filter. Default validator
returns ok (name-match-only, back-compat for older rules). The new
rules attach `keywordOverlapValidate(2)`, which:

1. Extracts significant tokens from the matched claim text (lowercased,
   stop-words removed, 4-char minimum).
2. Stringifies each candidate tool call's arguments.
3. Requires `min(2, ceil(claim_keywords / 2))` of the claim keywords to
   appear in the args (substring match, with loose stem matching for
   plural/tense variation).
4. If no candidate call's args meet the threshold, gap is recorded
   with the specific reason ("tool was called but its arguments don't
   reference the claim's significant terms").

This raises the cost of cheating from "call any tool" to "call the
right tool with content that lexically matches what you claimed."

### Correction prompt now includes the reason

`VerificationGap` now carries `reason: string`. The correction prompt
fed back to the agent surfaces the specific failure mode per gap
("no matching tool call this turn" / "matching tool call(s) all
errored" / "tool was called but its arguments don't reference..."), so
the agent has actionable signal instead of a generic hint.

### Tests

`components/master/__tests__/verifier.test.ts` — 27 tests covering
regex coverage, the cheat case (call any tool with unrelated args),
errored tool calls, tool_use ↔ tool_result pairing in real-shaped
message threads, and back-compat for the pre-v2.7.11 rules.
Master suite: **444 pass / 0 fail / 2 known-gap skips**.

### Operator-visible benefit

When Evy says "I've stored the Promise rule in Tier-1 memory," the
verifier now checks (a) that `memory_remember` was called this turn,
(b) that the call did not error, and (c) that its `content` argument
contains words like "Promise" and "rule." Any of those failing means
the claim is unverified and the correction loop re-enters with a
specific reason. Cheating now requires deliberately matching content
to claim text, which is much harder to do accidentally than calling
any tool with any args.

## [2.7.10] — 2026-05-12

### `feat(team-docs): master tools to read/write/list/log project-local docs at .subctl/docs/`

**What's new.** Four new master tools that let the orchestrator
persist project-scoped artifacts to `<project_root>/.subctl/docs/`:

- `team_doc_write({ project_root, relative_path, content, frontmatter? })`
  — write a SPEC / PRD / ARCH / handoff / mandate doc, optionally
  prepending a YAML frontmatter block (operator, account, phase,
  kind, …). Creates the docs folder + any intermediate subdirs.
- `team_doc_read({ project_root, relative_path })` — read it back.
  Parses out the frontmatter (if any) into a structured `frontmatter`
  field; returns the body in `content`.
- `team_doc_list({ project_root, subdir? })` — enumerate files +
  subdirs. Returns an empty list (not an error) when the folder
  doesn't exist yet — so callers can probe speculatively.
- `team_decision_log({ project_root, summary, detail?, by? })` —
  append one JSON line to `<project>/.subctl/docs/decisions.jsonl`.
  Append-only, machine-readable, every line `{ ts, summary, detail?,
  by }`. `by` defaults to `"master"`.

**Folder convention.** Subctl-managed docs live under
`<project>/.subctl/docs/`, next to the existing
`<project>/.subctl/policy.toml`. This keeps subctl out of the
project's own `docs/` tree, makes the artifacts trivially
`cat`-able from any worker pane, and avoids the TCC-blocked vault
path under `~/Documents/Obsidian Vault/` that doesn't work under
launchd on some hosts.

**Why it matters.** Today every directive — SPEC, PRD, ARCH note,
handoff, "remember this decision" — scrolls away in chat. The next
worker spawn has no recovery path. With these tools, the master can
write a SPEC.md the operator dictates, hand it to a worker, and the
worker can `cat .subctl/docs/SPEC.md` to read it back faithfully
even after a transcript compact. Decisions become a queryable
JSONL log instead of a chat-history search. Handoffs become files
the operator can inspect and `git add`.

**Path safety.** `team_doc_write` rejects `..` segments, absolute
`relative_path` values, and any resolved path that escapes
`<project>/.subctl/docs/`. The `subdir` argument on
`team_doc_list` is held to the same contract.

**Scope discipline.** This PR ships the TOOL SURFACE ONLY. The
spawn-time integration (every team-create writes a `mandate.md`
frontmatter wrapper) lands in v2.7.11. The agent definitions, skill
files, and per-template skeleton docs land in v2.7.12.

**Files.**
- `components/master/tools/team-docs.ts` — new (four tools + a
  tiny YAML-frontmatter parser/emitter for the simple `key: value`
  subset we control on both sides).
- `components/master/server.ts` — register the family after the
  knowledge family.
- `components/master/__tests__/team-docs.test.ts` — new (27 cases:
  happy paths, path traversal, absolute-path rejection, missing
  project root, missing folder on list, decision-log running total,
  frontmatter round-trip).
- `components/skills/master/SKILL.md` — guidance for when to use
  `team_doc_write` vs `subctl_orch_msg`, and a `team_decision_log`
  expectation.
- `docs/master.md` — new §5.5 "Team-local docs — `.subctl/docs/`
  tool family" with the folder convention + example operator
  questions.

## [2.7.9] — 2026-05-12

### `fix(policy): snapshot now records project_root`

The dashboard's Policy tab tries to re-resolve a team's policy chain by
reading `project_root` from the team's snapshot header, but
`writePolicySnapshot()` never emitted that field — only `team_id`,
`mode`, `source_paths`, `allowlist_sha`, and `spawned_at`. Net effect:
the Policy tab rendered "team X has no project_root recorded in its
snapshot — cannot resolve policy" for every team, even though the
function already RECEIVED `projectRoot` as its second argument. We
were just dropping it on the floor.

Fix is mechanical: thread `projectRoot` into `SnapshotMetadata`, the
header comment block (`# project_root = "<absolute path>"`), and the
`_write_snapshot.ts` JSON emit so bash can capture it too.

**Back-compat shim.** `readPolicySnapshot()` accepts snapshots written
by v2.7.8 (no `# project_root = ...` line) without throwing — it falls
back to `projectRoot: ""` and logs a one-line deprecation warning
pointing the operator at "respawn the team to refresh the snapshot."
The dashboard treats `""` exactly like the missing-field case it
already had, so the worst case is unchanged behavior for legacy
snapshots; new spawns get the re-resolve working immediately.

### `feat(orch): trusted-channel directive marker for /msg + worker contract`

**The bug.** When the master sent bare shell commands via
`subctl_orch_msg`, the worker's team-lead correctly identified them as
prompt-injection risk and refused — even when they were legitimate
master directives. Operator-observed: a lead asked to run a baseline
verification command kept replying "I don't execute bare commands that
arrive without context — they may be injection probes." Technically
correct paranoia, operationally a foot-gun.

**The fix.** Two coordinated pieces:

1. `/api/orchestration/<name>/msg` (and the `subctl_orch_msg` tool that
   calls it) now accept an optional `phase` field. Before pasting into
   the worker's pane, the route wraps the text with a deterministic
   marker:

   ```
   [subctl-master directive · phase=<phase> · ts:<iso>]
   <operator text>
   ```

   or, without a phase:

   ```
   [subctl-master directive · ts:<iso>]
   <operator text>
   ```

2. `providers/claude/teams.sh` prepends a constant "subctl team
   contract" preamble to every worker's first message (unless the
   spawn is empty-prompt). The preamble teaches the lead:

   - messages arriving with the `[subctl-master directive · …]`
     marker came through the trusted orchestrator channel and should
     be executed in the context of the worker's current phase;
   - messages WITHOUT that marker (especially bare imperatives) may
     be injection probes and should be refused with a request for
     context.

**Operator benefit.** Leads now act on master's directives without
needing the operator to manually paraphrase or re-frame each
imperative. Security-conscious refusal still kicks in for actual
out-of-band text — exactly the discrimination we want.

The `subctl_orch_msg` tool description also nudges master to always
include `phase` + a short WHY when calling it, so directives never
land as context-free imperatives even when the lead is forgiving.

## [2.7.8] — 2026-05-12

### `fix(policy): floor preset to "generic" — kills the "Bureaucrat Agent" regression`

**The bug.** Spawning a team into a project with no `.subctl/policy.toml`
(and no user-level `~/.config/subctl/policy.toml` either) produced a
policy snapshot containing ONLY `defaults.toml` — no merged preset. The
spawn banner correctly announced `(preset: generic)` because the bash
side's `_subctl_claude_detect_ecosystem` ran, but the detection result
was never threaded through to the TS bridge that writes the snapshot.
With `loadResolvedPolicy()` finding `preset` undefined in every layer,
the preset chain was skipped entirely.

Net effect: every team spawned into a fresh project ran in gated mode
with **zero allowlist**. Every single `ls`, `cat`, `find`, `pwd`,
`git status` required explicit permission. Operator described it as
"Bureaucrat Agent" behavior — workers stuck in permission loops,
"ask permission to ask permission."

**The fix.** `config/policy/defaults.toml` now declares
`preset = "generic"` at the top. Since the resolution chain is
`projectDoc.preset ?? userDoc.preset ?? defaultsDoc.preset`, this makes
"generic" the floor — any project that doesn't explicitly override
the preset (or set `preset = "none"`) gets the generic allowlist
(28 commands + git/gh/curl patterns) merged into its snapshot.

Properly threading the bash-detected ecosystem (node / python /
generic) through the bridge so node projects get the node preset
is a follow-up (v2.7.9). The floor fix unblocks the operator-observed
regression immediately for every fresh project regardless of
ecosystem.

### `fix(claude/policy): probe well-known install paths for bun`

`_subctl_claude_bun_bin` previously relied on `command -v bun`, which
respects the caller's PATH. When master / dashboard launchd plists
don't include `~/.bun/bin/` in their EnvironmentVariables.PATH, the
bun lookup fails and `subctl_orch_spawn` 500s with "bun not found
— policy snapshot bridge requires bun." Now probes `$HOME/.bun/bin/bun`,
`/opt/homebrew/bin/bun`, and `/usr/local/bin/bun` as fallbacks after
PATH lookup. Operator can still override with `SUBCTL_BUN_BIN=...` in
the plist.

### `fix(dashboard): 200ms breath between paste-buffer and Enter on /msg`

`/api/orchestration/<name>/msg` issues three tmux subprocesses
back-to-back: `set-buffer`, `paste-buffer`, `send-keys Enter`. Claude
Code's TUI sometimes hadn't ingested the paste before Enter arrived,
leaving the message sitting in the input box and never submitted.
Operator-visible: master had to send "EXECUTE NOW." or re-invoke
`subctl_orch_msg` multiple times to actually trigger the worker.
Added a 200ms `setTimeout` between paste and Enter — well below
human noticeability, well above paste-event latency in profiling.

## [2.7.7] — 2026-05-12

### `feat(knowledge): system_subctl_knowledge tool — TOON breakdown for master self-introspection (v2.7.7)`

The master daemon now ships a canonical, TOON-formatted breakdown of
the entire subctl system at
`components/master/knowledge/subctl.toon` (~40 KB, 19 sections), and a
new master tool `system_subctl_knowledge({ section? })` that reads
from it. The operator already uses TOON heavily in Argent and asked
for the same pattern here: token-efficient, LLM-friendly, single
source of truth for "how does X work in subctl?" instead of either
hallucinating from training data or doing a sub-agent file crawl on
every question.

### What's new

- **`components/master/knowledge/subctl.toon`** — the breakdown. 19
  top-level sections: `overview`, `architecture`, `components`,
  `providers`, `tools`, `http_routes`, `config`, `policy`,
  `cli_surface`, `update_workflow`, `secrets`, `supervisor`,
  `telegram`, `orchestration`, `claude_mem`, `compact_policy`,
  `diagnostic_tools`, `version_history`, `phase_3s_preview`,
  `file_index`. Tools, routes, files, and version history use
  TOON's tabular array form (`items[N]{f1,f2}:` + one row per line)
  for token efficiency.
- **`components/master/tools/knowledge.ts`** — new tool family with
  one entry, `system_subctl_knowledge`. No-section call returns the
  sections list with one-line summaries (extracted from each
  section's leading `#` comment). With a section arg, returns the
  full TOON content verbatim. Unknown section returns
  `ok:false` + `available_sections` populated.
- **`components/master/server.ts`** — `knowledgeTools` imported and
  spread into `toolRegistry` after the linear family (the convention
  is "append in feature-wave order"; this is the v2.7.7 addition so
  it lands at the bottom).
- **`components/skills/master/SKILL.md`** — added one-line guidance
  pointing the master at `system_subctl_knowledge` when the operator
  asks how a subctl component works.

### Operator-visible benefit

- Asking "how does the policy engine work?" / "what's in secrets.json?"
  / "what tools do you have?" now triggers a single tool call that
  pulls verified info from a file shipped with the daemon, instead of
  the model recalling from possibly-stale training data.
- The TOON file is part of every `subctl update` so the breakdown
  always matches the deployed version. Module-load caching means the
  daemon reads the file exactly once per restart.

### Test coverage

`components/master/__tests__/knowledge.test.ts` — **8 tests / 21
assertions** (~15 ms):

- Default call returns ≥10 sections with summaries; names unique.
- `section="policy"` content contains the canonical mode names
  (Trusted/Gated/Sealed); `section="tools"` includes a known tool
  family prefix.
- Unknown section returns `ok:false` with `available_sections`
  populated and the rejected name echoed in the error.
- The `.toon` file exists at the resolved path AND parses (regex
  sanity check for ≥10 top-level section headers).
- Caching: across five invocations (default, known section, unknown
  section, another known section, default again) the file is read
  from disk **exactly once** via an exported read-counter test seam.

Full master suite: **388 pass / 0 fail / 2 pre-existing skips** (the
two `find / -name foo -delete` v2.8 known-gap vectors).

### Canonical references

- `components/master/knowledge/subctl.toon` — the breakdown itself.
- `components/master/tools/knowledge.ts` — tool + parser + cache +
  test seam.
- `components/master/__tests__/knowledge.test.ts` — 8 tests.
- `docs/master.md` §5.4 — operator-facing description of the new
  tool with example questions it answers.

### Also in v2.7.7

#### `fix(master): default baseUrl for local providers`

When `providers.json` omitted the optional `host` field on
`supervisor` (or `router`/`embeddings`/`reviewer`), `buildModel()`
fell back to `baseUrl: ""` and pi-ai's OpenAI client defaulted to
`api.openai.com`. The master then sent the local LM Studio token to
real OpenAI, which returned `401 Incorrect API key provided` —
correctly! The error message even included the "find your API key at
platform.openai.com" template, which made the bug look auth-side
when it was actually a misrouting bug.

`components/master/server.ts` now defaults `baseUrl` to
`http://localhost:1234/v1` whenever `cfg.provider` is in
`LOCAL_PROVIDERS` (`mlx`, `ollama`, `lmstudio`, `vllm`). Cloud
providers still get `""` and pull their real URL from the SDK.

#### `feat(dashboard): use marketing-site logo in topbar + favicon`

The dashboard topbar used to render a placeholder mark (a gradient
square with a green status dot via `.brand::before` + `::after`).
Swapped to the canonical logo from subctl.com — same file the
marketing site uses (`SubCTLlogo.png`, copied to
`dashboard/public/logo.png`). The pulse-style status dot was
redundant with the existing `.pulse-dot` in the topbar-right and
was removed.

Also wires `<link rel="icon">` to the same file so the browser
tab gets the brand mark too.

## [2.7.6] — 2026-05-12

### `subctl update` — argent-style polish

Operator review of `argent update --help` set the bar: a polished update
flow has a read-only status probe, a persisted channel concept, a JSON
output mode for automation, distinct knobs for "auto-confirm" vs
"auto-stash", per-step timeouts, and a `--help` that reads like docs
instead of a flag dump. v2.7.6 adds all of those to `subctl update`
without disturbing the v2.7.5 version-state block or lockfile auto-stash.

### What's new

**`subctl update status`** — read-only subcommand. Runs the same
fetch + version-block logic as `update`, prints the operator's current
version / channel / branch / remote state, then exits without touching
the working tree. Works even with a dirty tree (where `update` would
abort), so it's the right first move when you're not sure what state
you're in.

```
$ subctl update status
subctl 2.7.5 (ff262d0c)
  branch:   main
  channel:  stable (default)
  remote:   v2.7.5 (ff262d0c) — up to date
  last update: 2026-05-12T17:37:23Z
```

**`--channel stable|beta|dev`** — persists the operator's channel
preference under `[update].channel` in `~/.config/subctl/config.toml`
(grep/awk-based TOML parsing; no extra dependency). Mapping is the
boring obvious one: `stable → main`, `beta → beta`, `dev → dev`.
Passing `--channel` both persists the value AND uses it for the
current run; subsequent runs without the flag pick it up from disk.
Unknown values fail fast with `unknown channel 'X' — pick one of:
stable, beta, dev` (exit 1). `-b/--branch` still wins for one-off
branch tests.

**`--json`** — emits a single document at end-of-run, suppresses every
human log line to /dev/null:

```json
{
  "ok": true,
  "from": {"version": "2.7.4", "sha": "74ae7ae7"},
  "to":   {"version": "2.7.5", "sha": "ff262d0c"},
  "channel": "stable",
  "commits_applied": 1,
  "lockfile_stashed": false,
  "services_restarted": ["com.subctl.master", "com.subctl.dashboard"],
  "doctor_warnings": 0
}
```

On error: `{"ok":false,"error":"…","stage":"preflight|fetch|merge|deps|restart|doctor"}`.
The stage string tells CI exactly where the run stopped, so log
collection can scope itself.

**`--yes`** (independent of `--force`). Auto-confirms interactive
prompts; today the only prompt is the downgrade gate (introduced in
v2.7.6 — `remote_version < current_version` asks "proceed with
downgrade? [y/N]"). Non-interactive shells without `--yes` now refuse
downgrades rather than silently regressing. `--force` keeps its v2.7.5
meaning: stash anything dirty that isn't lockfile-only.

**`--timeout <secs>`** (default 1200). Wraps `git fetch`, `git merge`,
and `bun install` with a portable timer (real `timeout` / `gtimeout`
when present, else a perl-based SIGALRM fallback). Timeouts return
the GNU-conventional 124 internally; user-facing message names the
step that timed out (e.g., `git fetch timed out after 60s`) so the
operator doesn't have to guess. Default of 1200s matches the slowest
historical `bun install` we've seen on a cold cache.

**Friendly `--help`**. Restructured along argent's pattern:
Usage → Options → What this does → Switch channels → Non-interactive
→ Examples (6 lines) → Notes (4 bullets) → Exit codes → Docs URL
footer (`Docs: https://subctl.com/docs/update`). Operators who want
the answer to "what does `--yes` do vs `--force`?" find it in the
Notes block without reading the full `Options` list.

**`update wizard` stub** — reserved for the future interactive setup
flow. Today it prints a one-liner pointing at `status` + `--channel`
and exits 0. Wiring it in now means we don't have to bump the major
version when the wizard ships.

### Back-compat (sacred)

`subctl update` with **no flags** behaves identically to v2.7.5: same
version-state block, same lockfile auto-stash, same `--force` gate,
same exit codes. The new flow paths are strictly additive — none of
them fires unless the operator opts in via flag.

### Test coverage

`lib/__tests__/update.test.ts` — **57 tests / 157 assertions** in
~14 s (up from 36 / 79 in v2.7.5). The v2.7.5 tests are intact; the
new ones cover:

- **`update status` (4 tests)**: clean repo prints version+channel+state
  and exits 0; dirty repo still exits 0 (status doesn't enforce
  cleanliness); `--json` returns parseable JSON; behind-remote
  surfaces `<N> commits ahead`.
- **`--channel` (3 tests)**: `--channel beta` persists to
  `config.toml` under `[update]`; invalid channel fails with a clear
  error; pre-seeded `config.toml` is honored when `--channel` is
  omitted.
- **`--json` (5 tests)**: happy path emits success doc; update path
  reports from→to + `commits_applied`; error path emits
  `{ok:false,error,stage}`; suppresses ALL human stdout/stderr (single
  parseable line); lockfile auto-stash surfaces as
  `lockfile_stashed: true`.
- **`--yes` downgrade (2 tests)**: with `--yes`, non-interactive
  downgrade proceeds (no refusal); without `--yes`, non-interactive
  downgrade refuses with a clear message.
- **`--timeout` (3 tests)**: `--timeout 1` against a `sleep 30` fake
  git wrapper trips the timeout and the error names the `fetch`
  stage; non-integer values fail fast; default-ish 1200s on an
  up-to-date repo still no-ops cleanly.
- **`--help` (3 tests)**: presence of Notes section, Examples
  section, and Docs URL footer.
- **Back-compat (1 test)**: `subctl update` with no flags still shows
  the v2.7.5 markers, no JSON leakage, no channel-persistence log.

All new tests isolate `SUBCTL_CONFIG_DIR` per-test via `mkdtempSync`
so config writes never touch the operator's real
`~/.config/subctl/config.toml`. The `--timeout` test plants a fake
`git` in a temp dir that delegates to real git for everything except
`git fetch`, so preflight rev-parse/remote/ls-remote still work and
only the bounded step trips the alarm.

### Canonical references

- `lib/update.sh` — subcommand dispatch + new flag parsing + JSON
  redirect dance at the top; `_subctl_update_status`,
  `_subctl_update_with_timeout`, `_subctl_update_load_channel`,
  `_subctl_update_persist_channel`, `_subctl_update_version_cmp`,
  `_subctl_update_emit_json` helpers below the v2.7.5 originals.
- `lib/__tests__/update.test.ts` — 57 tests / 157 assertions.
- `docs/master.md` Phase 3o.6 — the story.

## [2.7.5] — 2026-05-12

### `subctl update` UX — version state up front, lockfile drift auto-stashes

Two narrow operator-facing improvements to `lib/update.sh`. Both came out of dogfooding v2.7.4 across the M3 Ultra / M5 / Mac Studio fleet: operators were typing `subctl update`, hitting "working tree has uncommitted changes" with no version context, then re-typing `subctl update --force` only to discover the dirt was a `bun.lock` rewrite they didn't make. v2.7.5 fixes both.

### What's new

**Version-state block printed BEFORE the working-tree gate.** Today the dirty-tree abort hides the very thing the operator wants to know: what version they're on and what's available remotely. v2.7.5 runs `git fetch` (read-only at the working-tree level — only updates remote-tracking refs) up front and prints a compact 4-line status block before any cleanliness gate fires:

```
==> subctl update — version state
    current: v2.7.4 (74ae7ae7)
    branch:  main
    remote:  v2.7.5 (abcd1234) — 1 commits ahead
```

Three render modes: `same — already up to date` (fast-exit 0); `<N> commits ahead` (behind remote, proceed); `local is <N> commits AHEAD of remote` (operator dev branch, ff-only no-ops); `diverged (<X> ahead / <Y> behind)` (genuine divergence, ff-only fails cleanly). Even when the dirty-tree gate aborts the run, the version block is already on screen.

**Lockfile-only auto-stash.** `bun.lock` rewrites itself with platform-specific hashes on every `bun install`. Operators were typing `--force` repeatedly across machines for what is genuinely expected drift. v2.7.5 introduces a NARROW carve-out: when EVERY dirty file is a known package-manager lockfile (`bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` — and only those, not `Cargo.lock` / `Gemfile.lock` / `poetry.lock`), the update auto-stashes those files silently and restores after.

```
==> dirty lockfile detected (bun lockfile drift is normal across machines)
    auto-stashing: components/master/bun.lock
    will restore after update
```

After the update completes:

```
==> auto-stashed lockfile restored
```

If `git stash pop` collides with a lockfile rewritten by the new commit, the operator gets a structured guidance block (inspect / abandon / accept-theirs) instead of the cryptic git default.

**`--force` semantics preserved.** `--force` still stashes ANY dirty file (lockfile or not) and proceeds. The auto-stash is strictly additive — it removes a `--force` requirement for the lockfile case only.

**New helpers (extracted so they're testable in isolation):**

- `_subctl_update_is_lockfile <path>` — basename match against the 5-entry allow-list.
- `_subctl_update_classify_dirty "<porcelain>"` — emits one of `clean` / `lockfile-only|<csv>` / `mixed|<count>`.
- `_subctl_update_pop_stash <kind>` — pops with kind-aware messaging (`auto-stashed lockfile restored` vs `stash restored`) and structured conflict guidance.

### Test coverage

`lib/__tests__/update.test.ts` — **36 tests / 79 assertions** in ~6.6 s.

- **Pure helpers (16 tests)**: `_subctl_update_is_lockfile` covers all 5 allow-listed lockfiles + nested paths + `./bun.lock`, plus negative cases for `Cargo.lock` / `Gemfile.lock` / `poetry.lock` / `bun.lock.bak` (basename trailing junk) / source files.
- **Classify-dirty (8 tests)**: empty → clean; single + multiple lockfile → `lockfile-only|<csv>`; untracked (`?? bun.lock`); rename rows (`R old -> bun.lock`); any non-lockfile → `mixed|<n>`; lockfile + source mix → mixed; Cargo.lock → mixed.
- **Version-state block (5 integration tests)**: up-to-date prints `same — already up to date` and exits 0; behind prints `<N> commits ahead` and proceeds; ahead prints `AHEAD of remote` and the ff-only no-op succeeds; diverged prints `diverged` and exits 2 with `fast-forward failed`; the version block always appears on screen BEFORE the dirty-tree abort.
- **Lockfile carve-out (6 integration tests)**: lockfile-only drift auto-stashes + restores (drift content survives the round-trip); mixed without `--force` errors with no stash created and source drift preserved; mixed WITH `--force` stashes everything and uses the simple `stash restored` message; up-to-date + lockfile-only drift no-ops with drift preserved (no stash dance); `Cargo.lock` drift fails the cleanliness gate (carve-out is narrow); nested `components/master/bun.lock` auto-stashes correctly.
- **`--force` regression (1 test)**: clean tree + `--force` still updates with no spurious stash message.

Hermetic: every integration test creates its own `mkdtempSync` repo pair (`origin.git` + local clone), `SUBCTL_REPO_ROOT` is overridden per-test, `--no-restart` always passes (launchctl never fires), the temp local repo never contains `bin/subctl` so `doctor` never runs, and `NO_COLOR=1` strips ANSI for simple substring assertions.

### Operator deploy step

`subctl update` on every host. The new version block prints automatically. The next time `bun.lock` drift accumulates, `subctl update` (no flag) will auto-stash through it instead of demanding `--force`.

### Canonical references

- `lib/update.sh` — version-state block at lines ~165–207, lockfile carve-out at ~218–263, helpers at ~16–86.
- `lib/__tests__/update.test.ts` — 36 tests / 79 assertions.
- `docs/master.md` Phase 3o.5 — the story.

## [2.7.4] — 2026-05-12

### LM Studio token support + dashboard-managed secrets layer

LM Studio recently shipped an optional **"Require API Token"** server setting. Operators who enable it get a `sk-lm-XXXXXXXX:YYYYYYYYYYYY`-shaped bearer that every request — OpenAI-compatible `/v1/*` AND LM Studio's native `/api/v0/*` / `/api/v1/models/load` — must carry as `Authorization: Bearer <token>` or the server 401s. Before v2.7.4, subctl sent a `"not-needed"` sentinel for local providers and hit 401 the moment the operator flipped the toggle.

v2.7.4 closes that gap **and** generalizes the fix: a new on-disk secrets layer at `~/.config/subctl/secrets.json` (chmod 600, atomic writes, dashboard-editable) holds LM Studio + Brave + Firecrawl + Linear + Context7 credentials, with an env-var override on top so power users / CI keep the launchd plist as source-of-truth. The operator no longer has to edit a plist every time a key rotates.

### What's new

**Priority chain.** Every credential resolves through:

1. Process env var (e.g. `LMSTUDIO_API_TOKEN` from the launchd plist `EnvironmentVariables`).
2. `~/.config/subctl/secrets.json` field (e.g. `lmstudio_api_token`) — managed via the dashboard.
3. Absent → caller behaves as today (e.g. `lmstudioAuthHeader()` returns `{}`, pi-ai gets the `"not-needed"` sentinel).

**`components/master/secrets.ts`** (NEW) — pure module exporting `loadSecret(key)`, `setSecret(key, value | null)`, `listSecrets()`, `resolveSecret(key)`, `envVarFor(key)`, plus a `SECRET_KEYS` allow-list. Atomic writes (tmp-file + rename), `chmod 0600` on every write, 5-second in-memory read cache invalidated on mtime change. Malformed JSON / missing file / wrong-type fields all fall back to an empty map without throwing — a bad `secrets.json` MUST NOT crash the daemon.

**`lmstudioAuthHeader()`** (in `components/master/server.ts`, mirrored in `components/master/tools/diag.ts` and `dashboard/server.ts`) now routes through `resolveSecret("lmstudio_api_token")`. Behavior identical for env-only deploys; new deploys can manage the same token via the dashboard.

**`getApiKeyForProvider()`** in `components/master/server.ts` returns `resolveSecret("lmstudio_api_token") ?? "not-needed"` for `provider === "lmstudio"`. Other local providers (`mlx`, `ollama`, `vllm`) still return `"not-needed"` unconditionally. The LM Studio token never leaks across providers.

**Tool key resolution updated.** `components/master/tools/web.ts` (`web_search` → `brave_api_key`, `web_fetch` → `firecrawl_api_key`), `components/master/tools/linear.ts` (`linear_api_key`), and `components/master/tools/context7.ts` (`context7_api_key`) all flip from `process.env.*` to `resolveSecret(<key>)`. Error messages now point operators at BOTH paths (dashboard panel OR plist).

**LM Studio HTTP call sites — 11 total** thread the bearer header through `lmstudioAuthHeader()`:

- `components/master/server.ts` (6): `ensureModelLoaded` probe + unload + load, `getSupervisorLoadedCtx`, the `/transcript/util` inline probe.
- `components/master/tools/diag.ts` (3): `system_lmstudio_health` `/v1/models` + `/v1/chat/completions`, `system_supervisor_info` `/api/v0/models`.
- `dashboard/server.ts` (2): `/api/models`, `/api/providers`.

**Dashboard endpoints.**

- `GET /api/settings/secrets` — returns `{ ok, secrets: [{ key, isSet, envOverride, lastModified }], priority }`. Presence flags only; **values never appear** in this response.
- `POST /api/settings/secrets/:key` — body `{ value: string | null }`. Allow-listed against `SECRET_KEYS`. Returns `{ ok: true, secret: <updated-row-from-listSecrets> }` — the value is **not** echoed back. `null` (or empty string) clears the field.
- `GET /api/settings/keys` extended — each row now carries `env` (boolean) + `secrets_json` (boolean or null), and `ok` is `env || secrets_json`. Note string mentions both paths and the priority order. The CRITICAL invariant — never serialize the value — is preserved.

**Dashboard UI.** New "API tokens" card above the existing "API keys (cloud providers)" card. Renders a table: key, purpose, status pill (`Set` / `Not set` plus `env override` chip when the env var is present), last-modified, and an `Edit` / `Set` button. Clicking opens a modal with a `type="password"` input + Save / Cancel / Remove buttons. On save the value goes over the dashboard's `127.0.0.1`-bound HTTP (never crosses the LAN), the input is wiped from the DOM on close, and both panels re-render from the presence-only endpoints. Backed by new `.danger-btn` + `.secrets-table` CSS in `dashboard/public/style.css`.

**`.gitignore`** now explicitly blocks `secrets.json` by name in addition to the canonical `~/.config/subctl/secrets.json` location being outside the repo entirely.

**`fetchText` deps in diag.ts** gained an optional `headers` field. Tests can swap in a recording fetchText stub and assert the captured header, mirroring the `_setDepsForTesting` pattern.

**Boot guard.** `components/master/server.ts` now wraps its bottom-of-file `main()` invocation in `if (import.meta.main)` so the test suite can import the helpers without booting the full daemon.

### Test coverage

`components/master/__tests__/secrets.test.ts` (renamed from the WIP `lmstudio-token.test.ts`) — **39 tests / 89 assertions** in 62 ms — covers:

- **Secrets module:** read/write/round-trip; `setSecret(null)` and `setSecret("")` both clear; siblings preserved; `listSecrets` never serializes values (asserted by `JSON.stringify(rows).not.toContain("VERY-SENSITIVE-TOKEN-VALUE")`); `envVarFor` mapping incl. uppercase fallback.
- **Defensive parsing:** missing file → null; malformed JSON → empty + no throw; array-shaped JSON → empty; non-string values silently dropped; empty-string field treated as unset.
- **File permissions:** `statSync(secretsFile).mode & 0o777 === 0o600` after first write AND after a second write.
- **Priority chain:** env wins; file wins when env unset; both absent → null; empty-string env treated as unset (file wins); works for every key in `SECRET_KEYS`.
- **`listSecrets envOverride` flag:** true when env set; false when only file populated.
- **`lmstudioAuthHeader`:** `{}` baseline; bearer from env; bearer from file; env wins.
- **`getApiKeyForProvider`:** lmstudio resolves file token; env wins; nothing → `"not-needed"` (back-compat trip wire); `mlx`/`ollama`/`vllm` never get the token; cloud providers always undefined.
- **`ensureModelLoaded`:** bearer on all 3 calls (probe + unload + load) regardless of which source supplied the token; no Authorization on any call when both layers are absent (the back-compat trip wire).
- **`diagTools.system_lmstudio_health`:** bearer threaded into `fetchText.headers` on both `/v1/models` and `/v1/chat/completions`; omitted when neither layer has it.
- **Cache invalidation:** `setSecret` clears the cache; external file edits picked up after `_resetCacheForTesting`.

All env vars touched are snapshot-and-restored in beforeEach/afterEach. The on-disk path is overridden to a per-suite tmpdir via `_setPathForTesting` so tests never touch the operator's real `~/.config/subctl/secrets.json`. Full master suite remains green: **65 tests / 147 assertions / 67 ms** (39 new secrets + 26 existing compact-policy).

### Security contract

Non-negotiable rules — broken by any single counterexample:

- `secrets.json` values NEVER appear in any HTTP response body emitted by `dashboard/server.ts`. The `POST /api/settings/secrets/:key` handler returns the updated `listSecrets()` row, not the value.
- `listSecrets()` returns presence flags only — pinned by a test that asserts the literal token bytes don't appear in `JSON.stringify(rows)`.
- Every write goes through `setSecret`, which `chmod 0600`'s both the tmp file and the final path. Two tests assert the mode on first write AND after a subsequent write.
- The dashboard `<input>` is `type="password" + autocomplete="new-password" + spellcheck="false"`, and is wiped from the DOM on modal close. The dashboard request stays on `127.0.0.1` (dashboard is localhost-bound).
- `.gitignore` blocks `secrets.json` by name. The canonical path is `~/.config/subctl/secrets.json`, outside the repo.
- Error messages around missing keys say "not configured" rather than echoing any envvar or filesystem state that could surprise an operator.

### Back-compat

Existing v2.7.3 deploys with `LMSTUDIO_API_TOKEN` already in their launchd plist behave identically — the env var is priority 1, so the resolution chain returns the same bytes. Deploys with no token configured anywhere return `{}` from `lmstudioAuthHeader()` and `"not-needed"` from `getApiKeyForProvider("lmstudio")`, just like v2.7.3. Both paths are pinned by tests.

### Operator deploy step

Easiest path: open the dashboard's **Settings → API tokens** panel, click **Set** next to a row, paste the token, click **Save**. The daemon picks it up on the next call (5s cache TTL). Power-user path (CI / immutable infra): keep the env var in the launchd plist — it still wins over the on-disk file.

### Canonical references

- `components/master/secrets.ts` — read/write/atomic + chmod 600 + 5s cache + priority chain.
- `components/master/server.ts` `lmstudioAuthHeader()` + `getApiKeyForProvider()` — exported, used by tests.
- `components/master/tools/{diag,web,linear,context7}.ts` — all flipped to `resolveSecret(<key>)`.
- `dashboard/server.ts` `GET/POST /api/settings/secrets[/:key]`, extended `/api/settings/keys`.
- `dashboard/public/index.html` "API tokens" card + edit modal; `dashboard/public/app.js` `loadSecrets() + openSecretsModal() + wireSecretsModal()`; `dashboard/public/style.css` `.secrets-table` + `.danger-btn`.
- `components/master/__tests__/secrets.test.ts` — 39 tests / 89 assertions.
- `docs/master.md` Phase 3o.4 — the story.

## [2.7.3] — 2026-05-12

### Compact correctness — the ticker was the wrong design

A few hours after v2.7.2 shipped, the operator caught the master daemon hallucinating "Standing by" responses to questions it couldn't see. The diagnosis: the 5-minute auto-compact ticker had fired AFTER the supervisor was already past 100% util on its next prompt. By the time the ticker noticed the bloat and compacted, the model had already been served a truncated transcript and produced ghosts. The ticker was architecturally wrong — a polling watchdog can't keep a synchronous prompt-composition pipeline under budget. v2.7.3 fixes it by moving the compact decision to **just-in-time** at the prompt-composition site, with a **two-stage warning policy** so the operator gets a heads-up before auto-compact fires.

### What's new

**Just-in-time compact gate.** `runJitCompactCheck()` runs at the top of `processOnePrompt()` in `components/master/server.ts` (around line 922) — BEFORE `composeSystemPrompt()` and BEFORE `agent.prompt()`. It estimates current transcript tokens, queries LM Studio's `loaded_context_length` for the supervisor, and applies the v2.7.3 policy decision. If the decision is `compact`, the daemon compacts synchronously before the next prompt is composed. The supervisor never sees an over-budget window during normal operation.

**Two-stage warning policy** (absolute tokens, not percentages — predictable regardless of which model is loaded):

- `warn_tokens = 25000` — YELLOW banner + `compact_warning` SSE event. No compact yet; operator gets a heads-up.
- `compact_tokens = 40000` — AUTO-COMPACT fires synchronously. Banner flips BLUE during compaction, clears on `transcript_compacted`.
- `target_tokens = 30000` — post-compact estimated transcript size.
- `keep_recent = 6` — minimum recent turns the compactor preserves intact.

Compaction target moved from 50k → 30k so the post-compact transcript has comfortable headroom against the 40k auto-compact threshold.

**Compact-policy as a pure module.** `components/master/compact-policy.ts` (NEW) extracts the decision logic into a testable algorithm. `decideCompactAction(currentTokens, loadedCtx, cfg)` returns `{ action: "ok" | "warn" | "compact", current_tokens, threshold_used, reason }`. `loadCompactConfig()` handles file IO + back-compat. `estimateTranscriptTokens()` is the same char/4 heuristic used everywhere so JIT, ticker, and `/context` agree on the number.

**Back-compat for `threshold_pct`.** Deployed `compact.json` files in the wild still carry the v2.7.2 shape (`{ threshold_pct: 90, target_tokens: 50000, ... }`). `decideCompactAction` honors them: when absolute thresholds are absent it falls back to percentage-of-loaded-ctx mode (compact at `threshold_pct`, warn 10pp below). New deploys ship with absolute thresholds. No migration script — the code handles both shapes gracefully.

**5-min ticker demoted to safety-net.** The `auto-compact` ticker still runs every 5 minutes, but its job is now only to catch transcripts that grow due to tool outputs landing AFTER prompt composition (the JIT gate can't see those). It uses the same `decideCompactAction` algorithm so the two paths can never disagree.

**Master daemon endpoint:** `GET /transcript/util` — pure read returning `{ current_tokens, transcript_tokens, overhead_tokens, loaded_ctx, util_pct, warn_at, compact_at, target_tokens, config_mode, decision }`. The dashboard banner reads this to render the 4-state model server-side instead of recomputing thresholds in the browser. Surfaced through the existing `/api/master/*` proxy.

**Dashboard 4-state banner.** `ctx-overflow-banner` in `dashboard/public/index.html` now has four explicit states keyed off `data-state`:

- `ok` — banner hidden.
- `warn` — YELLOW. Current tokens past `warn_tokens` but below `compact_tokens`. Operator sees "Transcript approaching compact threshold" with a manual compact button.
- `compacting` / `warn-compact` — BLUE. Transient — auto-compact fired and is running. Clears on `transcript_compacted` SSE event.
- `overflow` — RED. Past `loaded_ctx` (should be impossible with JIT working; kept as fail-safe).

The banner now consumes `/api/master/transcript/util` rather than recomputing `pct > 100` heuristics in JS, and also listens for the SSE `compact_warning` and `transcript_compacted` events so the YELLOW → BLUE → cleared sequence renders without waiting for the 5s poll.

### Test coverage

`components/master/__tests__/compact-policy.test.ts` — 26 tests / 58 assertions covering:

- Absolute-threshold mode: returns ok/warn/compact at the right boundaries (including exact-equality), and ignores `loadedCtx` when absolute thresholds are set.
- Back-compat percentage mode: warns 10pp below `threshold_pct`, compacts at/above `threshold_pct`, defaults `threshold_pct` to 90 when absent, returns ok with `threshold_used: "none"` when `loadedCtx` is unknown.
- Edge cases: `currentTokens = 0`, `loadedCtx = 0` in pct-only mode, negative `currentTokens` is clamped, invalid absolute thresholds (`compact_tokens <= warn_tokens`) falls back to pct mode.
- `loadCompactConfig`: parses new shape, falls back to defaults on missing file, preserves back-compat shape when file authors only `threshold_pct`, prefers absolute when new shape is present even alongside legacy `threshold_pct`, returns defaults on malformed JSON.
- `estimateTranscriptTokens`: empty → 0, text + thinking + arguments contribute chars/4, ignores non-array content, handles circular argument objects without throwing.

### Operator deploy step

The daemon reads `~/.config/subctl/master/compact.json` automatically. If the file is missing the new v2.7.3 defaults apply (`warn=25k`, `compact=40k`, `target=30k`). To switch an existing M3 deployment onto absolute thresholds, edit the file in place — no migration script ships in this PR because the code handles both shapes gracefully.

### Canonical references

- `components/master/compact-policy.ts` — pure decision module.
- `components/master/server.ts` `runJitCompactCheck()` — primary gate at prompt-composition time.
- `components/master/server.ts` `runAutoCompactTick()` — demoted safety-net ticker.
- `docs/master.md` Phase 3o.3 — the story behind v2.7.3.

## [2.7.2] — 2026-05-12

### Web + self-introspection + Linear — three capability gaps, one PR

Operator and agent went back and forth over Telegram the morning of 2026-05-12. v2.7.1's self-diagnostic family had landed the night before. Over the course of an hour the agent named three live capability gaps: it couldn't search the web for current docs, it didn't know its own model + context budget, and it couldn't see (let alone update) the Linear board the operator was driving subctl development from. The operator funded all three on the spot — Brave AI Search + Firecrawl for the web side, LM Studio's existing `/api/v0/models` for the introspection side, Linear API for the issue side — and they all land in v2.7.2 as **seven new master tools** across two new files and one extension to the diag family.

### What's new

**Web family** at `components/master/tools/web.ts` (read-only):

- **`web_search`** — Brave AI Search. Query → top results (title + URL + snippet). Useful for current docs, news, API references, or verifying claims that may have changed since the model was trained. Defaults to 10 results, capped at 20. `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token` auth.
- **`web_fetch`** — Firecrawl scrape. URL → clean markdown. Use when you need to read a specific page's content (docs, articles, GitHub READMEs). Strips nav/footer/sidebar by default. `POST https://api.firecrawl.dev/v0/scrape` with `Authorization: Bearer` auth.

**Self-introspection** added to `components/master/tools/diag.ts`:

- **`system_supervisor_info`** — reads `~/.config/subctl/master/providers.json` for the configured supervisor (provider + model_id + host), queries LM Studio's `/api/v0/models` for that model's `state` / `loaded_context_length` / `max_context_length` / `quantization` / `arch`, and surfaces the auto-compact policy from `~/.config/subctl/master/compact.json` (with documented daemon defaults if the file is missing). The agent uses this to reason about its own context budget — "do I have room for a 30K-token tool result?" — without having to ask the operator.

**Linear family** at `components/master/tools/linear.ts` — Linear's GraphQL at `https://api.linear.app/graphql`, authed with the raw `LINEAR_API_KEY` (no "Bearer" prefix — Linear's convention):

- **`linear_list_issues`** *(read)* — filter by `team_key` (e.g. `ENG`), state name, assignee email. Returns normalized `{identifier, title, state, assignee, priority, url}` shape.
- **`linear_search`** *(read)* — text search across issue titles + descriptions via `searchIssues`.
- **`linear_create_issue`** *(WRITE)* — resolves `team_key` → team UUID via a `teams(filter: { key: { eq } })` query, then `issueCreate` mutation. Supports markdown description + Linear priority 0–4.
- **`linear_update_issue`** *(WRITE)* — accepts an `issue_id` as either identifier (`ENG-123`) or UUID. Optional `state` (human-readable name like "In Progress" / "Done"; tool resolves it to `stateId` via `workflowStates`) and/or `comment` (markdown body via `commentCreate`). Either or both can be passed per call.

### Implementation notes

- All seven new tools are routed through an injectable `Deps.fetchHttp` so the test suites never reach Brave, Firecrawl, Linear, or LM Studio for real — hermetic.
- API keys live in the master daemon process environment (`BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `LINEAR_API_KEY`). Missing keys return a structured `{ ok: false, error: "..." }` with an actionable plist + `launchctl kickstart` hint — never throws.
- HTTP failure modes (network, 4xx, 5xx, 429 with `retry-after`, timeout) all surface as structured errors. The 429 branch carries `retry_after` for intelligent back-off.
- Timeouts: 30s for `web_search`, 60s for `web_fetch`, 20s for Linear reads, 30s for Linear mutations.
- The two **write** tools (`linear_create_issue`, `linear_update_issue`) are documented as mutating in their tool descriptions so the agent uses them deliberately.
- Dashboard `/api/settings/keys` gains `BRAVE_API_KEY` + `FIRECRAWL_API_KEY` + `LINEAR_API_KEY` rows so the operator can see at a glance whether the master can use the new tools.
- `system_supervisor_info` uses the same `_setDepsForTesting` pattern as the rest of the diag family; no change to existing tools.

### Test coverage

- `components/master/tools/__tests__/web.test.ts` — 18 tests / 78 assertions (Brave + Firecrawl happy paths, missing keys, invalid URLs, network / timeout / 429 / 4xx / 5xx / malformed JSON / `success=false`).
- `components/master/tools/__tests__/diag.test.ts` — extended with 5 new `system_supervisor_info` tests (happy path, LM Studio unreachable, providers.json missing, compact.json defaults fallback, model not in catalog) on top of the existing 22.
- `components/master/tools/__tests__/linear.test.ts` — 14 tests / 89 assertions covering all four tools' happy paths plus missing key / 4xx / 429 / unknown team / unknown state / no-op update.

### Deploy step

After pulling v2.7.2, paste the three keys into `~/Library/LaunchAgents/com.subctl.master.plist` `EnvironmentVariables`, then `launchctl kickstart -k gui/$UID/com.subctl.master`. Master log will show **`tools=69`** (up from 62 in v2.7.1) once the three new tool registrations land.

### Canonical references

- `components/master/tools/web.ts` — Brave + Firecrawl.
- `components/master/tools/linear.ts` — Linear GraphQL family.
- `components/master/tools/diag.ts` — `system_supervisor_info` joins the v2.7.1 diag family.
- `docs/master.md` Phase 3o.2 — the story behind v2.7.2.

## [2.7.1] — 2026-05-11

### Self-diagnostic tools — the agent asked, the capability shipped

Hours after v2.7.0 tagged, the M3's master daemon hit a watchdog bug firing on a stale tmux session. After the issue was resolved, the M3 agent reflected on what would have caught the bug and proposed seven self-diagnostic tools via Telegram. The operator accepted plus added an eighth (version awareness). All eight ship in v2.7.1. This is the persistent-supervisor loop working as designed: agent hits a failure mode, asks for capability, capability ships.

### What's new

A new master tool family at `components/master/tools/diag.ts` registers eight read-only introspection tools under the `system_*` namespace:

- **`system_watchdog_self`** — surfaces watchdog state: which teams it's tracking, when it last ticked, when it last fired and why, and (critically) which tracked tmux sessions no longer exist on the host. Would have caught today's stale-session bug at first invocation.
- **`system_port_check`** — wraps `lsof` to report which TCP ports are bound and by whom. Defaults to subctl's own ports (8787 dashboard, 8788 master, 1234 LM Studio). Catches the orphaned-bun-vs-launchd class of conflict.
- **`system_lmstudio_health`** — independent LM Studio reachability probe: hits `/v1/models` and a tiny `/v1/chat/completions` ping, reports both latencies + last error. Distinct signal from `system_lmstudio_models` (which only lists known models without proving the API responds).
- **`system_log_tail`** — tail the master, dashboard, lmstudio, or tmux log (1–500 lines). Closes the gap the agent named explicitly: "I can only point to the log path, not read it."
- **`system_rate_limit_status`** — per-account 5h / 7d utilization summary read from subctl's local usage cache (no remote call). Lighter than `subctl_orch_state` for spawn-decision use; returns `healthiest_alias` directly.
- **`system_git_status`** — one-level walk over `~/code` (capped at 50 repos) reporting branch, ahead/behind origin, dirty flag, last fetch time per repo. Catches drift before spawning a team that would push to a divergent branch.
- **`system_network_health`** — LAN gateway ping + tailscale status + DNS resolution for github.com / api.anthropic.com + external TCP reach (1.1.1.1:443).
- **`system_version_status`** *(operator-added)* — current VERSION + commit + recent tags + count of commits behind `origin/main`. Mirrors the safe-fetch pattern from `lib/update.sh`. The agent should know its own version.

### Implementation notes

- All eight tools are read-only — none mutate subctl state.
- Watchdog state is exposed via the same late-binder pattern used by `bindToolRegistry` (no circular import; `startMaster()` calls `bindWatchdogState(getter)` at boot).
- Side-effecting calls (`shell`, `fetch`, file IO) are routed through an injectable `Deps` object so the test suite swaps in canned responses without touching the host.
- Server.ts diff is ~25 lines: one import, one registration block, three lines of watchdog-state tracking inside `runWatchdogTick()`, and the binder call.
- `docs/master.md` Phase 3o.1 records the M3-agent-requested origin.

### Test coverage

`components/master/tools/__tests__/diag.test.ts` ships with happy-path + degraded-path coverage per tool. The suite is hermetic — no network, no real `lsof`, no real `git`.

### Canonical references

- `components/master/tools/diag.ts` — the tool family.
- `docs/master.md` Phase 3o.1 — the story behind v2.7.1.

## [2.7.0] — 2026-05-11

### Trusted / Gated / Sealed — the policy engine

Subctl now spawns workers in **Gated** mode by default. Every other coding-agent harness in the field ships with bash effectively trusted; the model is the gate. As model capability scales, that trust model breaks — agents persistent enough to recover from a refusal by writing inline code, a custom npm script, or piping curl into sh. v2.7.0 moves the trust decision to subctl, the spawn point, where every worker inherits a TOML allowlist enforced by a `PreToolUse` hook against a deterministic Go-backed checker. The defang (`bypassPermissions` + `--dangerously-skip-permissions` + `CLAUDE_AUTONOMY=full`) stays in all three modes; the hook is additive, never replacement.

### What's new

- **Three execution modes per worker, decided at spawn time.**
  - **Trusted** — unrestricted bash. Opt-in via `--mode=trusted`; subctl prints a non-suppressible warning at spawn.
  - **Gated** — every `Bash` call routes through `subctl-policy-check` against a TOML allowlist. Allowed commands run silently; denials return a stderr error the agent self-corrects from. **Default for `subctl teams claude`.**
  - **Sealed** — no bash at all. `permissions.deny: ["Bash"]` + MCP-only tool set for production-adjacent work.
- **Three shipped ecosystem presets** at `config/policy/presets/` — `node.toml`, `python.toml`, `generic.toml`. Auto-detected via marker files (`package.json` → node, `pyproject.toml`/`requirements.txt` → python, fallback → generic). Per-project override at `<project>/.subctl/policy.toml`.
- **`subctl policy` CLI subcommand family** — `list`, `validate`, `explain <cmd>`, `audit <team>`, `snapshot <team>`. `explain` renders the deny/allow trace; `validate` checks TOML against the JSON schema with helpful errors; `audit` tails the JSONL log per team.
- **New master tool family** (`policy_check`, `policy_list`, `policy_audit_tail`) so the master daemon can introspect policy decisions and surface them through the chat surface.
- **Verifier denial-cluster detection** — when a worker hits ≥N denials of the same root command in a rolling window, the runtime claim verifier fires a `[verifier]` correction prompt steering the agent away from fighting the gate, and posts a one-time notification to the dashboard chat panel. Prevents the "agent rewrites the script three times trying to find a workaround" loop.
- **JSONL audit log** at `~/.local/state/subctl/audit/<team_id>.jsonl` — every check writes one line (allow or deny) with decision, reason, command tokens, allowlist SHA. 50 MiB rotation, 3 generations kept, concurrent-write-safe.
- **Dashboard Live Logs → Policy filter chip** + dedicated **Policy sidebar tab** showing per-team mode, preset, allowlist SHA, and a live SSE stream of denials. "Suggest allowlist addition" modal generates valid TOML from a denial trace.
- **Go binary `subctl-policy-check`** — compiled from `bin/subctl-policy-check/` for darwin/linux × amd64/arm64. Cold-start <50ms. Shares the test-vector corpus with the TS impl; CI fails on any divergence. Installed by `bash install.sh` alongside the `subctl` binary.
- **pi-coding-agent as a first-class provider** — `providers/pi-coding-agent/` ships with auth + teams scaffolding parallel to the Claude provider, plus dashboard HTTP spawn dispatch refactor so the endpoint is no longer hardcoded to `subctl teams claude`. Ungated for v2.7.0; policy hook lands in a follow-up.
- **`--no-telegram` flag for `subctl master enable`** — skip the BotFather walkthrough on hosts where Telegram isn't wanted. Same flag honored by `install.sh`.
- **Dashboard "M3 Ultra" hardcoded host label removed** — the host badge now reads from `/api/host` (hostname-driven) so dashboards on every machine show the right name without per-host patching.

### Breaking changes

- **`subctl teams claude` now defaults to Gated mode.** Existing workflows that depended on raw bash access need either `--mode=trusted` per spawn (with the non-suppressible warning) or a persisted `default_mode = "trusted"` in `~/.config/subctl/config.toml` or `<project>/.subctl/policy.toml`. The first time a worker hits a denial, the master daemon posts a one-time notification to the dashboard chat panel so the operator knows the new default is active.

### Migration notes

- Existing teams continue to work — the new default only applies to spawns AFTER v2.7.0. Already-running tmux sessions are unaffected.
- Run `bash install.sh` to compile and place the new Go binary (`subctl-policy-check`). Without it, Gated mode falls back to deny-all (intentional fail-closed).
- Per-project policy is opt-in. The shipped presets are the floor; project `.subctl/policy.toml` extends or relaxes.
- Audit log path: `~/.local/state/subctl/audit/<team_id>.jsonl`. Rotation is automatic at 50 MiB, 3 generations.

### Beyond the policy engine

- **`--no-telegram`** on `subctl master enable` and `install.sh` for headless installs that don't want the BotFather walkthrough.
- **Dashboard host label** now hostname-driven via `/api/host` instead of the hardcoded "M3 Ultra" string.
- **pi-coding-agent provider scaffolding** in `providers/pi-coding-agent/` — auth + teams.sh parallel to the Claude provider. Ungated for v2.7.0 (policy hook follows in a later release).

### Canonical references

- `docs/policy.md` — the policy spec (modes, schema, ecosystem detection, audit format, threat model).
- `docs/policy-schema.md` — TOML schema with examples and merging semantics.
- `docs/master.md` §4 — Phase 3o marked complete.

## [2.6.2] — 2026-05-10

Patch — `subctl update` survives local-only branches.

### Fixed

- **`subctl update` no longer dies with "couldn't find remote ref"** when the local checkout is on a branch that doesn't exist on origin. Reproduced 2026-05-10: the dev-team worker on the M3 Ultra had created a local-only `fix/watchdog-skip-dead-sessions` branch; the operator's next `subctl update` aborted because `git fetch origin fix/watchdog-skip-dead-sessions` failed. New behavior: `lib/update.sh` probes the remote with `git ls-remote --exit-code --heads origin <branch>` before fetching; if the branch isn't there, warns and automatically falls back to `main` (`git checkout main` + retry). Local-only branches are preserved as plain local branches the operator can return to.

### Notes

- Live-fixed on M3 Ultra: switched the checkout back to `main`, fast-forwarded 4 commits to v2.6.1, bounced tmux daemons. Master + dashboard now running v2.6.1.

## [2.6.1] — 2026-05-10

Patch — doc overhaul: README + dashboard `/cheat` + `/help` + ROADMAP all reframed for the v2.x agentic-harness scope.

### Changed

- **README.md** — full rewrite. Was framed as "multi-account dispatch tool for Claude" (v1.0 scope) when the project's actual scope is now "agentic harness for AI subscriptions" with the master daemon as the centerpiece. New structure: tagline → ASCII arch diagram → 12 capability bullets → install → daily ops → architecture pointer (`docs/master.md`) → repo layout → roadmap pointer → contributing.
- **`/cheat` page** (`renderCheatsheetPage` in `dashboard/server.ts`) — added 8 new sections covering features that shipped in v2.x: Master daemon control, Master personality presets, Document attachments in chat, Vault viewer, Multi-team camera view, Update + versioning, Skills catalog, Team templates, Plugin system. "Web dashboard UI" section was 2 rows; now it's 13 (one per sidebar tab) plus a separate Interactions section.
- **`/help` page** (`dashboard/help.md`) — header rewritten to lead with "front-end for subctl master." Added a 12-row tab table at the top + dedicated sections on Chat (attachments, personality, Telegram bidirectional), Orchestration (camera view, watchdog history), and Vault (rendering rules + deep-link URL pattern + master integration).
- **`ROADMAP.md`** — preamble now correctly scopes this file to **provider expansion** (multi-provider dispatch substrate), with the agentic-harness roadmap pointed at `docs/master.md` §4. OpenAI Codex marked **shipping** (was "planned next" — already shipped in 2.x).

### Why

Operator playthrough revealed the docs were a release behind reality. New operator landing on the README would see "Subscription Central CLI" pitch and miss the actual product (conversational orchestrator with 50+ tools and a 12-tab dashboard). Cheat sheet didn't mention `subctl master`, personality, attachments, vault viewer, or camera view. The /help page led with "verdict banner" — true but no longer the headline.

### Out of scope for this patch

- `docs/multi-account.md`, `docs/master.md`, `docs/release-workflow.md` already current (master.md was rewritten through Phase 3o; release-workflow.md got the 3-digit bump policy in v2.1.x).
- `START-HERE.md` (separate clean-Mac install copy) — covered briefly in README but not rewritten; still valid for fresh installs.

## [2.6.0] — 2026-05-10

Minor — personality picker in the dashboard UI + roadmap (Phase 3p Personal Skills System, Phase 3q Vault Canvas Editor).

### Added

- **Settings → Master personality tile** with dropdown picker + Apply button. Hits the existing `/api/master/personality` endpoints (GET catalog, POST swap). Shows the currently-active preset, the seven built-ins (`straight-shooter`, `witty`, `sarcastic`, `robotic`, `arnold`, `elon`, `hilarious`), and a one-line preview of the selected preset. Hot-swap takes effect on the next prompt; no restart. Closes the gap reported 2026-05-10: "I don't see personas yet. Where would I get to that?" — answer: CLI worked since v2.2.0, dashboard UI lands now.

### Roadmap (docs/master.md)

- **Phase 3p — Personal Skills System (ArgentOS-style).** Operator-facing skill authoring UI: editor pane with frontmatter validation, multi-source targeting (master / dev-team templates / specific Claude accounts / global `~/.claude/`), per-skill enable-disable, bundle export/import. Design block sketches backend endpoints (`POST /api/skills/author`, `POST /api/skills/toggle`, `GET /api/skills/bundle/export`, `POST /api/skills/bundle/import`) plus a `skill_propose` master tool that surfaces recurring-pattern claude-mem observations as click-to-author drafts.
- **Phase 3q — Vault editor (canvas).** Make the Phase 3n vault viewer writable. CodeMirror 6 from CDN for markdown editing (matches the "no build step" convention), `[ Edit ]` toggle on the rendered-note pane, conflict-detect on save via expected_mtime, optional Excalidraw-style freeform canvas mode for diagrams stored as `<note>.excalidraw.json`. New file-watch SSE so master writes via `vault_append` show up in real time in the viewer.

## [2.5.7] — 2026-05-10

Patch — three operator-reported fixes from the post-shutdown playtest.

### Fixed

- **Watchdog no longer fires on dead tmux sessions.** `refreshTeamActivityFromTmux` now PRUNES entries whose tmux session is no longer alive. Diagnosed live during operator playtest: "Looks like your watchdog is kicking off even though you closed the tab out." Was caused by `teamLastActivity` keeping the spawn-seed event in memory after `tmux kill-session` ran — the team's `last_activity` aged forever, watchdog flagged stale every tick, master tool-called `subctl_orch_status` and got HTTP 404 each time. New behavior: any `claude-*` entry missing from the live tmux session list gets dropped, plus a `team_pruned` SSE event + `watchdog_pruned` decisions.jsonl line for audit. Guarded against false positives — only prunes when the tmux query succeeded.
- **Dev-team card no longer renders "undefined: (no text)".** Synthetic spawn-seed events use `kind`/`detail`/`by` fields; the renderer was expecting `type`/`text`. Fallback chain added so seed events render as `spawned: retroactive seed for live team …` instead of `undefined: (no text)`.

### Changed

- **Master SKILL nudges `claude-mem` usage more aggressively.** Operator noted the master was relying solely on `memory.md` (tier-1) and rarely calling `memory_search` / `memory_timeline`. New rule in the system prompt: call claude-mem proactively when (a) operator references a past project/decision/incident, (b) about to assert a fact from loose recall, (c) spawning into a project worked on before, (d) transcript was auto-compacted. Plus an explicit boundary call-out: `memory.md` is operator notes; claude-mem is project/incident history.

## [2.5.6] — 2026-05-10

Patch — watchdog observability. Backlog item shipped.

### Changed

- **Watchdog panel in Orchestration tab renders every tick, not just firings.** Previously the panel showed "no recent watchdog firings" indefinitely — true but useless, looked like the watchdog was broken. Now: the master's existing `watchdog_ok` SSE event populates a rolling history of the last 8 ticks with timestamp + `OK` pill + team/stale counts. `watchdog_fire` events show with a red `FIRE` pill and a summary of the synthesized prompt. The card header surfaces `last tick · HH:MM:SS` so the operator can see when the watchdog last ran without scrolling.
- **Empty-state copy** updated from "no recent watchdog firings" to "armed — first tick lands within the configured interval (default 3 min)" so a fresh-loaded dashboard tells the truth.

### Architecture note

The renderer (`renderWatchdogPanel`) lives at module scope in `app.js`, called from the SSE event handlers. Module-level placement was deliberate so the function is reachable from the wireMasterChat listeners without rewiring `wireOrchestrationCockpit`'s closure scope.

## [2.5.5] — 2026-05-10

Patch — launchd resilience after today's death spiral.

### Changed

- **Master plist `KeepAlive` is now conditional.** Was `<true/>` (restart unconditionally). Now `{SuccessfulExit: false, Crashed: true}` — launchd restarts on crash but NOT after a clean operator stop. Prevents `subctl master disable` from being instantly undone by KeepAlive.
- **Master plist `ThrottleInterval` 10s → 30s.** Today's failure mode: LM Studio crashed → master ctx-pin hung 60s → daemon exited → launchd respawned within 10s → master hung 60s again. macOS's internal respawn-limit detector flagged the job as failing and gave up. 30s gives the environment breathing room and resets the failure counter more aggressively. (Combined with v2.5.3's 2s LM Studio reachability probe, master now boots fast even when LM Studio is dead.)
- **Master plist `ExitTimeOut` added (20s).** SIGTERM → wait 20s → SIGKILL. Stops zombie processes when a shutdown path hangs.
- **Dashboard plist mirrors the same `ThrottleInterval` (30) + `ExitTimeOut` (20)** for consistency.

### Added

- **`subctl master kick`** — force-recover when launchd has thrown up its hands. Bootouts the stale job, kills any orphan master process squatting on the port, bootstraps a fresh launchd entry. Must be run from a local TTY (Terminal.app on the machine) because `launchctl bootstrap` targets `gui/$UID` which isn't reachable from a vanilla SSH session. Falls back to a printed `tmux new-session` recovery command if bootstrap fails.

### To apply on an existing install

```
subctl master disable && subctl master enable    # re-renders the plist
```

Or from local Terminal.app on the M3 Ultra:

```
subctl master kick
```

## [2.5.4] — 2026-05-10

Patch — three operator-reported issues from the post-recovery playtest.

### Fixed

- **Chat toolbar now sticky-anchored at the top of the chat panel.** Operator reported (third occurrence) that scrolling chat content visually overlapped the toolbar AND made the MODEL dropdown unclickable. Root cause was the toolbar living in flex flow with no z-stacking — scrolled content rendered over it under certain content lengths. Fixed via `position: sticky; top: 0; z-index: 5; background: var(--bg-1)` on `.chat-toolbar`. The toolbar now anchors at the top of the panel regardless of scroll position, content scrolls under it, clicks always land.
- **Vault tab now finds vaults even without a `.obsidian/` marker.** v2.5.0's detection required every subdirectory of `vault_root` to have a `.obsidian/` dir to count as a vault — strict but brittle. The master's `vault_append` tool creates project subdirs WITHOUT a `.obsidian/`, so any vault populated only by the master would show empty in the viewer. New detection: (a) treat `vault_root` itself as a vault if it has `.obsidian/`, (b) treat each subdir with EITHER `.obsidian/` OR ≥1 `.md` file as a vault. Existing canonical Obsidian vaults still detected correctly; master-only project dirs now visible.
- **Live fix on M3 Ultra:** dropped `.obsidian/` markers into `Down-Time-Arena/` and a fresh `master/` subdirectory inside the vault root so the operator can see both vaults immediately without waiting for a fresh install.

### Added

- **Telegram source badge + auto-relay.** Two-part fix for "I sent from Telegram but the master replied in the dashboard, not Telegram":
  - **Frontend:** Telegram-sourced messages in the chat panel get a `from-telegram` class with purple left-border + the label `✈ you · telegram` so the operator can see at a glance which channel a message arrived from.
  - **Master daemon:** after the assistant settles a turn, if `source: "telegram"`, the response text is now automatically relayed back to the Telegram chat via the existing `sendTelegramOutbound` helper. No tool call required by the model. Truncates to 3900 chars (Telegram's 4096 cap minus padding) with `…[truncated; full reply in dashboard chat]` if longer. Skipped for internal synth prompts (`[verifier]` / `[watchdog]` / `[scheduled]`).

## [2.5.3] — 2026-05-10

Patch — master daemon survives LM Studio crashes cleanly.

### Why

Surfaced during today's session: LM Studio crashed under memory pressure (probably from the day's camera-view polling stacking duplicate qwen instances). Master daemon then entered a death spiral — ctx-pin for the reviewer hung 60 s on `/api/v1/models/load`, daemon eventually crashed, launchd hit its restart-throttle limit and gave up retrying. Both subctl services were down. The recurring symptom: `ctx-pin FAILED reviewer: load error: The operation timed out.`

### Fixed

- **`ensureModelLoaded` short-circuits when LM Studio is unreachable.** Tight 2 s timeout on the initial `/api/v0/models` reachability check; if it doesn't respond we skip the pin entirely and let JIT-on-first-prompt handle it. Old code charged into a 60 s `/load` request even when LM Studio was clearly dead.
- **Treat "already loaded at ≥ desired context" as a hit.** When the supervisor pins at 65 K and the reviewer also points at the same model but wants 32 K, the reviewer no longer triggers an unload+reload — it accepts the already-loaded 65 K instance. Avoids the recurring "supervisor succeeds, reviewer evicts + reloads + hangs" cascade.
- **Role pins run in parallel.** Wrapped supervisor + reviewer ctx-pins in `Promise.allSettled`. Boot is now bounded by the SLOWEST single role, not the sum. Previously a hung reviewer pin would block the supervisor's pin output for a minute even though they're independent.
- **Load fetch timeout 60 s → 20 s.** If LM Studio can't load in 20 s the daemon shouldn't block boot — first user prompt will JIT it. The 60 s cap was inherited from the original force-pin patch where we wanted to ride out a slow model load; in retrospect the supervisor's pin succeeds in ~2 s when LM Studio is healthy, and 20 s is plenty even for the worst cold-start case we've actually observed.

### Notes for the operator

- **No re-auth or config changes needed.** Code-only fix.
- If you've had providers.json with both supervisor + reviewer pointing at the same model with different `context_length` values, v2.5.3 will gracefully share one loaded instance instead of trying to double-load. Removing the reviewer block entirely is also fine — supervisor handles everything.
- **launchd recovery on the M3 Ultra:** today's death spiral exhausted launchd's restart-throttle and `launchctl bootstrap` failed via SSH (GUI domain unreachable from a non-attached session). Recovery path: open Terminal locally on the M3 Ultra and run `launchctl load ~/Library/LaunchAgents/com.subctl.master.plist`. Or keep using the detached-tmux daemons set up today (`tmux ls` — sessions `subctl-master` and `subctl-dashboard`).

## [2.5.2] — 2026-05-10

Patch — three v2.5.0 bugs surfaced by operator the moment the Vault tab landed.

### Fixed

- **Vault tab now hides other tabs.** Missed adding the `body[data-active-tab="vault"] section[data-tab]:not([data-tab="vault"]) { display: none; }` rule in v2.5.0. Result: clicking Vault left the body in "no rule matched" state, every section rendered stacked + scrollable. Fixed by adding the missing rule.
- **Projects → "Open Vault Path" button now actually opens the Vault viewer.** Was renamed to **"Open in Vault Viewer"** and rewired: clicks now call `window.openVaultDeepLink("master", "<project>/decisions.md")` which sets the hash + clicks the sidebar Vault button. Old behavior copied the path to clipboard (which was the placeholder before Phase 3n existed).
- **Chat toolbar padding bumped from 22 → 28px top.** Defensive fix — operators kept reporting the chat toolbar buttons appearing clipped against the panel's rounded top edge. Likely a stale-CSS-cache + flex-wrap interaction, but extra top breathing room makes it impossible regardless.

### Added (helper for cross-tab navigation)

- **`window.openVaultDeepLink(root, path)`** — exposed by the Vault tab module so other tabs (Projects, future ones) can route the user to a specific note: sets the URL hash, programmatically clicks the Vault sidebar button, lets the existing tab-activation logic + hash-aware `checkActive()` pick up the navigation. The Vault tab's `checkActive()` was extended to re-evaluate the hash on every activation (not just first load) so deep-links from outside work even when the vault is already loaded.

## [2.5.1] — 2026-05-10

Patch — three backlog cleanups.

### Changed

- **`detached` label renamed to `running · headless`** in dashboard team rows + tmux preview meta. Operators read "detached" as "broken/disconnected"; it actually means "no operator terminal currently attached, work continues." New wording matches expectation. (One of two backlog items called out 2026-05-10.)
- **`lms version` parser now extracts a real semver instead of a banner line.** Previously the dashboard's install-checks tile picked the first line containing a digit, which in `lms`'s ASCII-art banner output (box-drawing chars + version inside a frame) ended up being a line like `│ Version 1.4.1 │`. Now: strip ANSI → strip box-drawing/block chars → match `/\b\d+\.\d+(?:\.\d+)?(?:[-+]\w+)?\b/` per line → return the first hit. Falls back to first non-empty line if no semver shape found.

### Added

- **`system_my_tools(filter?)`** — master tool that introspects the live tool registry. Use case: when Jason asks "what tools do you have?" or "what can you do?", master can answer accurately from the registry instead of recall. SKILL updated to mandate calling this for capability questions (reinforces anti-hallucination rule #2). Optional `filter` arg does case-insensitive substring match — e.g. `system_my_tools({filter: "subctl_orch"})` returns just the orchestration tools.
- **Late-binder pattern in `tools/system.ts`** — `bindToolRegistry(reg)` exposed by the module, called once by `server.ts` after the registry is built. Avoids a circular import (system → server → systemTools).

## [2.5.0] — 2026-05-10

Minor — Phase 3n ships (MVP): **in-browser Obsidian vault viewer.**

### Added

- **New "Vault" sidebar tab** with two-pane layout: file tree (left, 280 px) + rendered note (center). Auto-opens the first two levels of the tree for discoverability.
- **Backend endpoints** in `dashboard/server.ts`:
  - `GET /api/vault/roots` — every sub-directory of `vault_root` with a `.obsidian/` dir is enumerated as a discrete vault.
  - `GET /api/vault/<vault>/tree` — full folder tree of `.md` files, dirs sorted before notes alphabetical.
  - `GET /api/vault/<vault>/note?path=…` — raw markdown + parsed YAML frontmatter + file stats.
  - `GET /api/vault/<vault>/asset?path=…` — passthrough for images (png/jpg/gif/svg/webp/pdf), with caching headers.
  - All paths sanitised via `safeJoinUnder()` — rejects `..`, absolute paths, null bytes.
- **Frontend renderer** uses Marked.js 13.0.0 from CDN (no build step). Pre-render transforms cover the Obsidian-specific syntax Marked doesn't know about:
  - `[[wikilink]]` and `[[wikilink|alias]]` → click-navigable anchors (purple). Resolver matches exact path first, then any note whose final segment matches case-insensitively. Missing targets render with a red dashed underline.
  - `![[embed.png]]` → `<img>` via the asset endpoint. Non-image embeds become click-to-open links.
  - `> [!note]` / `> [!warning]` / `> [!danger]` callouts → styled blockquotes with coloured left borders and uppercase titles.
  - `#tag` (in body text, not headings or URLs) → coloured pill spans.
  - YAML frontmatter parsed and rendered as a metadata header above the note.
- **Deep-linkable URLs:** `/dashboard#vault?root=<slug>&path=<rel-path>` opens straight to a specific note. History is updated on every navigation so back/forward work.
- **New master tool `vault_link(note_path, root?)`** — returns the deep-link URL the master can include in chat or Telegram messages. Defaults `root` to `master` (the daemon's own vault). Reports whether the note actually exists at the resolved path.

### Out of scope for v2.5.0 (deferred per spec §3n)

- **Right-pane backlinks + outgoing-links panel.**
- **Search** (full-text + filename + tag filter).
- **Graph view.**
- **File-watching SSE** for live tree/note updates — currently refresh-on-click.
- **Edit-in-browser** — Vault viewer is read-only by design. The master writes via `vault_append`; humans edit via the Obsidian desktop app.

### Try it

```
# Sidebar → Vault. Pick the auto-created "master" vault.
# Browse the tree, click a note. Wikilinks navigate.
# Or jump directly:
#   http://192.168.100.98:8787/dashboard#vault?root=master&path=Down-Time-Arena/decisions.md
```

## [2.4.0] — 2026-05-10

Minor — Phase 3l ships (MVP): **document attachments in chat.**

### Added

- **Attachment storage layer** (`components/master/attachments.ts`): on-disk files under `~/.config/subctl/master/attachments/<date>/<id>-<filename>` plus an append-only `index.jsonl` of metadata. Each entry tracks id, filename, sha256, size, mime, source (`upload` / `paste` / `tool`), created/deleted timestamps. Soft-delete in index, hard-delete the file. 5 MiB per-attachment cap; mime allowlist covers text/* + JSON/YAML/TOML/XML/script types (PDF + images deferred to Phase 2).
- **Master HTTP endpoints**:
  - `POST /attachments` (raw bytes; metadata via `X-Filename` / `X-Mime` / `X-Source` headers) → `{id, filename, size, mime, sha256}`
  - `GET /attachments` → list metadata
  - `GET /attachments/<id>` → file bytes with proper mime
  - `DELETE /attachments/<id>` → soft-delete + remove on-disk file
- **`POST /chat` now accepts `attachments: [id…]`**. Server resolves each id, wraps content in fenced `<attachment id="…" filename="…" size="…" mime="…">…</attachment>` blocks, prepends to the prompt the model sees. Empty `text` is fine if at least one attachment is present.
- **Two new master tools** (`components/master/tools/attachments.ts`):
  - `read_attachment(id, start?, end?)` — re-read an attachment by id, with optional byte-range chunking. Use case: auto-compaction has dropped the original turn's inline content; this tool lets the master re-fetch without forcing the operator to re-upload.
  - `list_attachments(filter_filename?, limit?)` — find an attachment id by filename substring when the operator references a document by name.

### Frontend

- **Paperclip button** next to the chat input opens a multi-file picker.
- **Drag-and-drop** anywhere on the chat panel highlights the input area and attaches dropped files.
- **Paste interception**: pasted text ≥ 4 KB is automatically uploaded as `paste-<timestamp>-<slug>.md` instead of going into the input. Smaller pastes pass through as normal.
- **Pill chips** above the input show each queued attachment (filename + size) with a × to remove before send. Cleared automatically after send.
- **Visible chat history** records each attachment as `📎 filename` plus any user text, so the transcript stays readable even though the model received the full inline content.

### Out of scope for v2.4.0

- PDF text extraction (`pdftotext`) — deferred. PDF mime not yet in the allowlist; ship after wiring extraction.
- Image vision — deferred until a vision-capable supervisor is wired (qwen-VL via LM Studio is the obvious path).
- `subctl master attachments gc` CLI verb — `gc()` exists in the module; wiring deferred.
- Subctl-side worker prompt augmentation (handing attachments to dev-team workers).

### Try it

```
# Drop a markdown file on the chat panel.
# Or paste a long block (>4KB) — auto-attaches.
# Or click 📎 → pick a file.
# Send. Master sees the content; transcript shows just the pill.
```

## [2.3.0] — 2026-05-10

Minor — Phase 3m ships (MVP): **multi-team camera view** in the Orchestration tab.

### Added

- **NVR-style grid of every active dev team's tmux pane** at the top of the Orchestration tab. Polls `/api/orchestration/captures` every 2 s while the tab is visible, renders ~22-row tiles per team in monospace. Tiles auto-fit via `grid-template-columns: repeat(auto-fit, minmax(420px, 1fr))` — 1 team gets a full-row tile, 2 sit side-by-side, 4 form a 2×2, etc.
- **Status pill per tile** — `active` (green, last activity <60 s), `idle` (gray, <15 min), `stale` (yellow, >15 min), `error` (red, last 10 lines match `/error|failed|fatal:/i`), `ended` (faded, session disappeared). Left border colour mirrors the pill so the grid is glanceable.
- **Click a tile to expand** — fills the viewport with a single team's pane content, larger font, full capture height. Esc / click-backdrop / ✕ closes. Polling continues on the expanded view so it stays live.
- **`GET /api/orchestration/captures`** bulk endpoint in dashboard: returns ANSI-stripped capture content for every tracked session in one call. `?lines=N` (default 40, clamped 8..200). Backed by a new `tmuxCaptureFrame(session, lines)` helper.
- **Tab-aware polling** — the grid only fetches while the Orchestration tab is visible (watched via `MutationObserver` on `body[data-active-tab]`). Saves network + tmux-capture cost when the operator is on Chat or any other tab.

### Out of scope for MVP (deferred per spec §3m)

- xterm.js per tile (real ANSI colour + ligatures) — Phase 2; current tiles use plain `<pre>` with ANSI stripped.
- SSE delta streaming — current implementation is plain polling at 2 Hz.
- Pinning, sound alerts, recording/replay, audio overlay.

## [2.2.0] — 2026-05-10

Minor — Phase 3k ships: **personality presets for the master daemon.**

### Added

- **Seven built-in voice presets**, each a short fragment (`components/master/personalities/<slug>.md`) describing the master's voice (tone, cadence, mannerisms). Persona — *what* the master is — stays fixed; personality is *how* it speaks. Built-ins: `straight-shooter` (default, current behavior), `witty`, `sarcastic`, `robotic`, `arnold` (inspired by, not a likeness), `elon` (inspired by, not a likeness), `hilarious`.
- **`components/master/personality.ts`** loader module. `readActivePreset()`, `buildPersonalityFragment()`, `setPreset()`, `describePresets()`. State at `~/.config/subctl/master/personality.json` — single key `preset`. `composeSystemPrompt()` reads on every turn so the change hot-swaps with no daemon restart.
- **Master HTTP endpoints:** `GET /personality` returns the active preset + catalog with previews. `POST /personality { preset }` swaps the active preset, logs to `decisions.jsonl`, broadcasts `personality_set` over SSE. Dashboard's existing `/api/master/*` auto-proxy makes both reachable at `/api/master/personality` for the browser.
- **CLI verb:** `subctl master personality {list,show,set}`. Goes through the daemon's HTTP endpoint so the change is audited and SSE-broadcast.

### Constraints (non-relaxable per preset)

Every preset fragment explicitly preserves the anti-hallucination rules from v2.1.3/v2.1.4. The runtime claim verifier still gates claims regardless of voice; the master SKILL's behavioral contract still applies. Personality changes *delivery*, not *behavior* — a sarcastic refusal is still a refusal, a witty one-liner about a tool call still needs the actual tool call.

### Out of scope for v2.2.0

- Dashboard Settings tile UI for personality picking — backend wired, UI lands in a follow-up patch.
- Per-channel personality (different voice on Telegram vs chat panel).
- User-authored / runtime-editable presets via the dashboard — Phase 1 ships built-ins only; community-contributed presets land via the plugin system (§3j).

### Try it

```
subctl master personality list
subctl master personality set sarcastic
# next chat message will come back in the new voice
subctl master personality set straight-shooter   # back to default
```

## [2.1.9] — 2026-05-10

Patch — dev-team tmux sessions spawn at 220×50 instead of default 80×24.

### Changed

- **`tmux new-session` in `providers/claude/teams.sh` now passes `-x 220 -y 50`.** Without these flags, detached tmux sessions default to 80×24 because the spawning shell has no controlling terminal. Claude Code's TUI lays out at 80 columns, which renders fine for an attached user but looks half-empty in the dashboard's wide tmux-preview modal — the right ~50% of the (now letterboxed) modal stayed blank because the captured content was genuinely 80 cols. 220×50 gives Claude Code enough horizontal room for tool-call blocks to render on single lines, plus 50 rows of scrollback context.

### Live fix applied on M3 Ultra

- The `claude-Down-Time-Arena` session was resized from 80×24 → 220×50 via `tmux resize-window`. Claude Code repaints on SIGWINCH so no work was lost; the next dashboard capture will show the wider layout. Future spawns pick up the change automatically from v2.1.9.

## [2.1.8] — 2026-05-10

Patch — modal width-variant CSS specificity fix.

### Fixed

- **`.modal-wide`, `.modal-narrow`, `.tmux-preview` were silently no-op'd by `.modal`.** All three modal size variants set `max-width` (and `tmux-preview` set `width`) but appeared *earlier* in the stylesheet than the base `.modal { width: 90%; max-width: 580px }` rule. Same selector specificity (single class) → source-order tiebreaker → `.modal` won → every modal stayed at 580px regardless of which variant class was applied. v2.1.7 attempted to widen the tmux-preview modal but the override silently lost, so the modal frame stayed narrow while the inner pane font/padding bumps from v2.1.7 made the pane wider than its container — caused horizontal-scroll overflow. Fixed with compound selectors `.modal.modal-wide`, `.modal.modal-narrow`, `.modal.tmux-preview` — one extra class bump in specificity, source order no longer matters.

### Notes

- Side benefit: the notice/confirm modal (uses `.modal-narrow`) was also rendering at 580px instead of 460px. Now it'll be the intended narrower size on the next reload.

## [2.1.7] — 2026-05-10

Patch — quality-of-life: tmux-preview modal is now bigger + letterboxed.

### Changed

- **tmux-preview modal width 1100px → 95vw (cap 1900px).** Operator request 2026-05-10: the View button on dev-team rows opens a captured-pane viewer; at the old 1100px width long lines wrapped awkwardly while the rest of the screen sat empty. Now the modal fills nearly the full viewport horizontally, capped at 1900px for ultrawide screens.
- **Pane area font 11.5px → 13px, min-height 360 → 520, max-height stays at 75vh.** Captures of 30+ rows of terminal output fit comfortably without scrolling, and the larger font reads cleanly at the wider modal size. Letterbox feel — wide and short, like a real terminal multiplexer view.

## [2.1.6] — 2026-05-10

Patch — modal stacking context fix.

### Fixed

- **Modals no longer get rendered behind the chat panel.** Operator inspector dive 2026-05-10: the tmux-preview modal's header was being overlapped by the chat input form below it in the DOM. The `.modal-backdrop` had `position: fixed; z-index: 1000` which *should* have layered it above, but some other paint context was pinning that layer behind the rest of the page. Two-layer fix: bumped the backdrop to `z-index: 9999` (safely above any other element in the document), and gave the inner `.modal` its own stacking context via `position: relative; z-index: 1` so its descendants always render above non-modal siblings regardless of DOM order.

## [2.1.5] — 2026-05-10

Patch — three dogfood-driven fixes.

### Fixed

- **Chat panel no longer overlaps the toolbar when conversation grows.** `.orchestration-screen` was using `min-height` instead of `height`, so as the chat history grew the screen container got taller than the viewport and the body scrolled — pushing the MODEL/APPLY/COMPACT/+NEW CHAT toolbar above the visible area. Switched to a fixed `height: calc(100vh - 56px - 48px)` + `overflow: hidden` on the parent, removed the now-redundant `max-height` magic-number on `.master-chat`, and let the `.master-log` flex bound itself with `overflow-y: auto`. Toolbar stays anchored at the top regardless of chat length.
- **Team activity now refreshes from real pane content, not tmux's window-focus signal.** v2.1.2 used `tmux #{window_activity}` which only updates on user-attach interactions — useless for a detached worker pane spewing output. The dashboard kept showing `1h05m ago` while the worker had clearly written 13 files in the last 30 minutes. Replaced with `tmux capture-pane -p` + content hashing per session: if the hash changed since the last watchdog tick, we bump `teamLastActivity` to now. Reliable signal regardless of attach state.

### Changed

- **Master SKILL gains rule #6: publish to `notify_dashboard` on meaningful events.** The dashboard's NOTIFICATIONS feed has been empty during the entire FOOTHOLD dogfood because the master only narrated progress in chat — never published. Rule #6 specifies the kinds (`spawn`, `milestone`, `blocked`, `escalation`, `decision`, `error`, `watchdog`) and the contract: ≤120-char summary, paired with chat messaging not in place of it. The verifier's `message-sent-claim` rule already partially enforces it; rule #6 names it explicitly.

## [2.1.4] — 2026-05-10

Patch — runtime claim-verification gate, Argent-style.

### Added

- **Post-turn claim verifier** (`components/master/verifier.ts`). After the master settles a turn, the runtime scans the assistant text for "claim triggers" (specific future check-in times, asserted team status, host-fact claims, message-sent claims, decision-logged claims) and checks each against tool calls made IN THE SAME TURN. If a claim isn't backed by the corresponding tool, the runtime feeds a synthetic `[verifier]` correction prompt and re-runs the turn. Capped at 2 corrections per original prompt to prevent loops; on giveup, the gap is logged to `decisions.jsonl` (`verifier_giveup`) and the response ships with the gap on record.
- **Five initial verification rules:**
  - `future-checkin-time` — "I'll check in N minutes" / "I'll follow up at T" → must have called `schedule_followup`
  - `team-status-claim` — "the team is making progress" / "team is stuck" → must have called `subctl_orch_status` or `subctl_orch_list`
  - `host-fact-claim` — "qwen is loaded" / "Docker is running" → must have called `system_lmstudio_models` or `system_tmux_sessions` etc.
  - `message-sent-claim` — "I sent a message to Jason" / "I nudged the team" → must have called `telegram_send` / `subctl_orch_msg` / `notify_dashboard`
  - `decision-logged-claim` — "I logged this to the vault" → must have called `vault_append` or `memory_remember`
- **`verifier_gap` SSE event** — broadcast when a gap is detected, surfacing in real time which rule fired and what the unbacked phrase was. Visible in `/api/master/events` and the dashboard's live activity feed.
- **`verifier_resolved` / `verifier_giveup` decision-log entries** — operator can grep `decisions.jsonl` to see how often the verifier had to intervene and which rules trip most.

### Why this exists

Operator pattern from ArgentOS, paraphrased 2026-05-10: *"If Argent tries to say something and can't prove it or back it up with actual tool use proof, Argent is looped back and gated. You'll hear her say 'oh you're right' and then the turn gets blocked."*

v2.1.3 added the `schedule_followup` tool + SKILL guidance — that's the polite layer ("please don't lie"). v2.1.4 adds the runtime gate ("you literally can't ship a lie without us catching it"). They reinforce each other. SKILL alone wasn't enough during dogfood — model produced a 15-min-checkin promise without scheduling. Verifier catches that pattern at the runtime level and re-runs the turn until backed by tool use OR explicitly logged as unverified.

### Notes

- The verifier skips itself for `[verifier]`, `[watchdog]`, `[scheduled]`, `[team-report]` prefixed prompts — those are runtime-internal, not operator-facing claims.
- Iteration cap is 2 — i.e., one correction loop maximum. If the model can't get its own claim backed after one pointed retry, the response ships with a `verifier_giveup` log entry rather than looping forever. Operator can grep that to see chronic offenders.
- Rules are extensible — add to `VERIFICATION_RULES` in `verifier.ts`. Keep `requires_any_tool` honest; over-strict rules (requiring tools that don't actually verify the claim) cause friction without quality gain.

## [2.1.3] — 2026-05-10

Patch — anti-hallucination scaffolding for the master daemon.

### Added

- **`schedule_followup` tool family** (`components/master/tools/scheduler.ts`). Three new master tools: `schedule_followup({in_minutes, summary, prompt})` writes a future self-prompt to `~/.config/subctl/master/followups.jsonl`; `list_followups` shows pending; `cancel_followup({id})` removes one. A new ticker in the master daemon polls every 60s, fires due followups as synthetic `[scheduled]` agent prompts. Survives daemon restarts (state is on disk).
- **Anti-hallucination rules section in master SKILL.md.** Five non-negotiable rules: (1) never promise a check-in time without first calling `schedule_followup`; (2) don't claim capabilities you don't have (no "background monitoring"); (3) verify host facts via `system_*` tools, don't recall; (4) keep workers moving through checkpoint questions instead of bouncing them back to the operator; (5) say "I don't know" rather than fabricating status. These override the rest of the SKILL when in conflict.

### Why this exists

Surfaced 2026-05-10 during the FOOTHOLD dogfood. After 39 minutes of silence, the master told the operator "I'll check in on it in 15 minutes" — but had no underlying timer behind that promise. The watchdog would have fired regardless, but the specific 15-minute commitment was hallucinated. Operator caught it: "It needs to be gated. The master shouldn't be able to lie even if it's just trying to keep me happy."

The fix gates the lie at the mechanism level. The master now has a real tool that backs timed promises with file-on-disk state. The SKILL update tells it to use the tool and not fabricate cadence. Future "I'll check at T" sentences are tied to a specific followup record the operator can inspect via `list_followups` — no record, no promise.

## [2.1.2] — 2026-05-10

Patch — watchdog cadence + activity signal.

### Changed

- **Watchdog defaults tightened.** Default `review_interval_minutes` 5 → 3, default `stall_detection_minutes` 60 → 15. Operators expect the master to notice within minutes when a worker goes silent; the previous 5/60 defaults were "check in once every 5 minutes, escalate after an hour" — too coarse for an active dogfood loop. The new defaults align with the dashboard's row-colour thresholds (yellow at 15min, red at 30min) — the master now catches a team transitioning into "yellow" rather than waiting for red. Operator can still override via `policy.global_defaults`.

### Added

- **Tmux window-activity as a fallback liveness signal.** Previously `teamLastActivity` was only updated by the inbox tailer, which meant a worker that was productively writing files but never self-reporting via inbox looked stale. Diagnosed during FOOTHOLD when the worker built `server-foothold/` over 25 min while the inbox stayed pinned at the spawn-seed timestamp from 14:13 — dashboard reported `30m ago` and a red staleness dot even though the worker had just paused waiting for the operator's `go`. The watchdog tick now calls `tmux list-windows -a -F '#{session_name}|#{window_activity}'` first and bumps `teamLastActivity` to the latest tmux activity timestamp for any session whose window has been touched more recently. Inbox events still take precedence when present; tmux only fills the gap.

## [2.1.1] — 2026-05-10

Patch — chat-toolbar overflow into right sidecar.

### Fixed

- **Chat toolbar no longer spills into the dev-teams panel.** The toolbar's `display: flex` had no `flex-wrap`, and the child min-widths (model selector 280px, ctx meter 220px) summed to more than the chat column on typical viewports. With no wrap, no overflow clip, the ctx pill `ctx 33,422 / 65,536 tok (51%)` rendered on top of the team name `claude-Down-Time-Arena` in the right sidecar. Added `flex-wrap: wrap` + `overflow: hidden` on the toolbar, and reduced `chat-model-select` min-width from 280px → 220px so the row fits on a single line at most viewport widths and wraps gracefully when it can't.

## [2.1.0] — 2026-05-10

Minor — close the dogfood-exposed gap where the subctl-built skills and slash commands lived only on the operator's laptop. Fresh installs now get them automatically. New: `orchestrator-mode` skill in repo, `/team` slash command in repo, and `subctl install` symlinks all repo skills + commands into every per-account cfg_dir.

### Added

- **`components/skills/orchestrator-mode/SKILL.md`** — the multi-pane orchestrator + team-agent protocol. Critical: it includes the `SUBCTL_AGENT_ROLE=worker` activation guard that prevents the orchestrator-mode-deadlock pattern (workers self-loading the orchestrator role and waiting forever for approval to dispatch sub-workers they have no right to dispatch). Diagnosed and solved 2026-05-09 in the master/lead-deadlock incident.
- **`providers/claude/commands/team.md`** — the `/team` slash command. Routes to the `orchestrator-mode` skill.
- **`subctl_settings_install_claude_dir` now symlinks the repo's full skill + command catalog into every Claude cfg_dir.** Iterates every directory in `components/skills/` (excluding `master`, which is the daemon's own system prompt and would confuse workers) and every `.md` in `providers/claude/commands/`. Idempotent — symlinks overwrite cleanly, operator-personal skills/commands not in the repo are untouched. Each per-account cfg_dir now has `subctl`, `autonomy`, and `orchestrator-mode` available the moment it's created.

### Notes

- Only ships content I created for subctl. Sub-agents like `bug-analyzer` / `code-reviewer` / `dev-planner` (dated 2026-01-30, pre-subctl) and slash commands like `/commit` / `/code-review` / `/security-review` are operator-personal — they stay in `~/.claude/` and don't get pulled into the repo.
- Workers spawned via `subctl orch spawn` on a fresh install (e.g., the M3 Ultra) will now have `subctl`, `autonomy`, and `orchestrator-mode` in their skill catalog. Verifiable via "what skills do you have?" in a worker's chat.
- The master daemon's own SKILL (`components/skills/master/`) is intentionally excluded from the worker symlink loop — only the daemon process loads it via `components/master/server.ts`, never a worker. A worker that thought it was the master would loop into bad coordination patterns.

## [2.0.5] — 2026-05-10

Patch — three operator-reported bugs from continued FOOTHOLD dogfood, plus a roadmap entry that captures the bigger gap they exposed.

### Fixed

- **Stop hook self-heals stale paths.** `subctl_settings_install_claude_dir` previously merged a new Stop hook entry into `settings.json` only if no entry already pointed at the expected path — but didn't *rewrite* entries pointing at OTHER `log-rate-limits.sh` paths. The result, on systems migrated from older alias names (`claude-personal`, `claude-work`, `claude-overflow`), was Stop hooks pointing at non-existent scripts in the old alias dirs, generating "No such file or directory" errors after every Claude Code turn. The merge now rewrites any `log-rate-limits.sh` command path to the current cfg_dir before deciding whether to append a new entry. Idempotent — a re-run on a clean install is a no-op.
- **Chat-panel right sidecar no longer truncates.** The `1fr 320px` grid let the chat toolbar's wide content (model selector + apply + compact + new chat + fullscreen + ctx meter + supervisor label) push the sidecar past the viewport edge, clipping "ACTIVE DEV TEAMS", "claude-Down-Time-Arena", and the Notifications header. Bumped the sidecar to 360px, set `minmax(0, 1fr)` on the main track, added `min-width: 0` on master-chat and the sidecar, and added `word-break: break-word` to team rows so long session names wrap rather than overflow.
- **Live-fix on M3 Ultra:** rewrote the three per-account `settings.json` Stop hook paths from the stale alias dirs to the actual cfg_dirs. The next `subctl install` run will keep them correct via the self-heal logic above.

### Notes

- The hook-path bug exposed a much bigger gap, captured as Phase 3o in `docs/master.md`: a chunk of the operator's `~/.claude/` baseline (skills, slash commands, sub-agents, default permissions) is on the laptop but not in the repo, so fresh installs miss it. Audit complete in the doc; no code shipped — sanitizing operator-specific content before committing skills like `subctl` and `orchestrator-mode` requires manual review.

## [2.0.4] — 2026-05-10

Patch — Docker becomes a first-class hard requirement. Surfaced during the FOOTHOLD dogfood when the worker hit the dockerode hello-world step, found Docker Desktop wasn't running, and correctly stopped to ask the operator instead of failing silently.

### Added

- **Docker check in master `/diag`.** New 6th component check. Distinguishes binary-missing (`docker --version` non-zero) from daemon-not-running (`docker info` non-zero) so the suggested action is actionable: install Docker Desktop vs. `open -a Docker`. Surfaces both in the dashboard's diagnostics panel.
- **Docker in dashboard install-checks.** Added to `/api/settings/install-checks` as a required tool with `brew install --cask docker` as the install command, and fallback paths covering Docker Desktop's bundled binary location (`/Applications/Docker.app/Contents/Resources/bin/docker`).

### Notes

- The check intentionally splits "installed" (install-checks tile) from "running" (/diag tile). After a reboot, Docker Desktop is typically installed but not auto-started; the install-checks tile stays green while /diag flips red. This is the right shape — install state is durable, daemon state is transient.
- A dev team that needs Docker should call out the dependency in its boot prompt or first task. The FOOTHOLD spec already does this in §8 and §13. Future templates that involve containerized workers should follow suit.

## [2.0.3] — 2026-05-10

Patch — fix `subctl usage` and the dashboard's per-account 5h/week columns for Claude Code 2.x. Diagnosed during the FOOTHOLD dogfood when every account row in the Accounts table showed `—` for utilization despite all dispatch verdicts saying GO and a worker actively running on `claude-jason`.

### Fixed

- **`subctl_usage_bearer` now reads Claude Code 2.x file-based credentials.** Claude Code 2.x writes per-account OAuth tokens to `<cfg_dir>/.credentials.json` (mode 600) instead of the macOS Keychain. The previous implementation only knew the 1.x scheme — sha256(cfg_dir)[0:8] as a suffix on `Claude Code-credentials-<hash>` — so it found nothing for any account, `subctl usage --json` returned `ok: false` everywhere, and the dashboard's polling loop logged empty snapshots. The bearer lookup is now ordered: (1) `<cfg_dir>/.credentials.json`, (2) hashed Keychain entry (1.x), (3) unsuffixed Keychain entry (1.x default cfg_dir). First match wins.
- **`subctl doctor` reports the new credential path correctly.** The "Keychain bearers" section is renamed "Credentials" and reports `file=...` for 2.x entries, `keychain=...` (with a "legacy 1.x" tag) for old entries, and a clearer "re-run subctl auth" hint when neither is present.

### Notes

- No re-auth required. Claude Code 2.x has been writing `.credentials.json` for every alias all along; subctl just wasn't reading it.
- The Anthropic `/api/oauth/usage` endpoint hasn't changed — only the bearer lookup did. After updating, expect 5h and weekly utilization columns to populate within ~5 min (next dashboard poll cycle) or immediately after clicking the ↻ refresh button on the Accounts header.

## [2.0.2] — 2026-05-10

Patch — two operator-reported bugs from the FOOTHOLD dogfood test, both around observability of the master's own actions.

### Fixed

- **Spawned teams now register in `teamLastActivity` immediately.** Previously `subctl_orch_spawn` and `subctl_orch_spawn_template` created the tmux session and returned, but the master's tracking map was only populated by inbox events written by the worker itself. A worker that booted into Claude Code and sat at an empty prompt never wrote to its inbox, so `/health` reported `teams_tracked: 0` and the dashboard's Orchestration tab showed "no dev teams running" despite a live tmux session with the worker visible to `subctl orch list`. Both spawn tools now seed the inbox with a synthetic `{kind: "spawned"}` event on success — the existing inbox tailer picks it up and the team appears in the master's tracking on the next file-watch tick.
- **Setting the Obsidian vault root from Settings now auto-bootstraps the vault structure.** Previously, saving `~/Documents/Obsidian Vault` as the vault root just wrote `obsidian.json` and left the directory empty. The Memory tab then reported "Obsidian installed, no vault detected" and asked the operator to mkdir `.obsidian/` manually. The POST /api/settings/obsidian endpoint now creates `<root>/master/.obsidian/` plus a `welcome.md` introducing the vault — Obsidian-the-app and the dashboard both recognize it as a real vault on first save. Pass `{bootstrap: false}` if you want the legacy "config-only" behavior.

### Notes

- The team-registration fix is defense-in-depth alongside the master's own self-correction loop (`subctl_orch_status` + `subctl_orch_msg`). The master can already nudge a stuck worker via msg(); now `/health` and the Orchestration tab also reflect that team's existence rather than reporting zero teams.
- Watchdog visibility (showing last-tick timestamps even when no team is stale) is queued as a separate observability improvement — see Phase 3m design.

## [2.0.1] — 2026-05-10

Patch — guards the supervisor switch so users can't pick a provider that pi-ai doesn't have an api factory for. Reported by Jason after switching the chat panel's supervisor to "OpenAI Codex (ChatGPT)" and getting silent empty responses on every prompt.

### Fixed

- **`/api/master/supervisor` no longer accepts unwired providers.** The chat panel previously offered `openai-codex` as a supervisor option, but no provider package implements it (`providers/openai/README.md` flags it as v1.1 work). Selecting it wrote the value to `providers.json` and bounced the daemon, after which every chat turn returned empty assistant content because pi-ai's stream factory found no api in the registry. The endpoint now rejects with `400 { ok: false, error: "provider X is not wired into pi-ai yet", hint: "<list of wired providers>" }` for any provider outside the wired allowlist.
- **Chat-model selector marks unwired cloud providers disabled.** The dropdown still lists them (so users see what's coming) but the `<option>` is `disabled` with a `title` attribute pointing at the README. Wired providers render normally.

### Notes for the operator

- If the chat panel ever silently produces empty responses again, check `~/.config/subctl/master/decisions.jsonl` for `prompt_error_chat: No API key for provider: …`. That's the canary — it means pi-ai fell through the api lookup.
- The `WIRED_PROVIDERS` allowlist in `dashboard/server.ts` must stay in sync with `PROVIDER_API` in `components/master/server.ts`. Changes to one require changes to the other.

## [2.0.0] — 2026-05-10

Phase 3 — the master daemon goes live. subctl is no longer just a control plane for Claude accounts; it now hosts a persistent conversational orchestrator that spawns dev teams, talks to you over the dashboard chat panel and Telegram, and curates its own memory across three tiers. The dashboard navigation collapses from a tab strip into a 12-item sidebar.

This is a major bump because the architecture, not just the surface, changed: a new daemon, a new persistent agent, a new memory model, a new plugin contract, and a new conversational UI. Subscription accounting (the original 1.x scope) still works exactly the same.

### Added

- **`subctl master` daemon** — pi-agent-core-based persistent orchestrator on `127.0.0.1:8788`. Loads `providers.json` + `policy.json` + the master SKILL prompt, exposes HTTP/SSE so the dashboard chat tab and Telegram listener share a single agent transcript. Auto-started by `com.subctl.master.plist`.
- **44 master tools across 13 families** — `subctl_orch_*` (spawn/list/preview/attach/send), `gh_*`, `coderabbit_*`, `telegram_*`, `system_*` (host introspection), `project_*` (vault-bound project + spec scaffolding), `memory_*` (claude-mem worker queries), `context7_*` (docs RPC), tier-1 `memory_*` (always-in-context user.md + memory.md curators), `skill_*` (master-source skill authoring with category allow-list), `notify_dashboard` (curated event feed), `specforge` (5-stage intake state machine).
- **Three-tier memory architecture** — tier-1 always-in-context (`<memory-context>` blocks built from `user.md` + `memory.md`, ~3500 chars), tier-2 semantic (claude-mem worker at `localhost:37701`), tier-3 long-form (Obsidian vault). System prompt is composed per-prompt via `composeSystemPrompt()` so memory edits land on the very next agent turn.
- **Spec Forge** — 5-stage state machine (`project_type_gate → intake_interview → draft_review → awaiting_approval → approved_execution`) mirroring ArgentOS's specforge-conductor. Persists state to `~/.config/subctl/master/specforge/<key>.json` and writes approved specs to `<vault>/<project_name>/SPEC.md`.
- **Dashboard sidebar UI** — `Chat / Orchestration / Dashboard / Projects / Teams / Claude Sessions / Models / Providers / Memory / Skills / Live Logs / Settings`. Persistent chat panel with rehydrate, ctx meter, compact button, new-chat, fullscreen mode, model selector (cloud + LM Studio optgroups, ●/○ availability dots).
- **Team templates** — JSON manifests under `~/.config/subctl/teams/<name>.json` defining persona + skills + tools + autonomy + boot_prompt. `subctl teams claude --template <name>` and `subctl orch spawn` both honor templates; `_provider_claude_apply_template` copies skills into the worker's `cfg_dir`.
- **Personal skill authoring** — `skill_create` / `skill_revise` / `skill_remove` constrained to the master skill source with a category allow-list (`team-coordination`, `escalation-patterns`, `code-review-synthesis`, etc.) and a description-keyword filter. All writes audited to `decisions.jsonl`.
- **Plugin system** — `subctl plugins {list,install,remove,status,show}` with manifest `subctl.plugin.json` (id, kind, configSchema, tools, skills, tabs, verbs). Mirrors ArgentOS's manifest pattern. Plugins live under `~/.config/subctl/plugins/<id>/`.
- **Notifications sidecar** — curated event feed (`spawn`, `blocked`, `done`, `milestone`, `escalation`, `decision`, `watchdog`, `memory`) replacing raw activity logs. `notify_dashboard` tool persists to `notifications.jsonl` and broadcasts over SSE.
- **Codex provider** — first-class auth via `subctl auth openai`. Detects SSH (`SSH_CONNECTION` / `SSH_CLIENT`) and routes to `codex login --device-auth` so headless installs don't deadlock on a browser flow.
- **Context7 integration** — docs RPC against `mcp.context7.com/mcp` with `CONTEXT7_API_KEY`. `_provider_claude_drop_mcp_config` writes per-team `.mcp.json` so dev workers get docs out of the box.
- **`subctl update`** — canonical pull-and-restart workflow (`lib/update.sh`). Verifies clean tree, fast-forwards origin/<branch>, runs `bun install` where `package.json` changed, bounces launchd services, runs `subctl doctor`. `--force` stashes; `--no-restart` leaves services alone. Shows `vOLD → vNEW` delta + summary of incoming commits.
- **`VERSION` file** — single source of truth at repo root. `lib/core.sh`, `bin/subctl`, dashboard, and master daemon all read from it. `subctl version` now also prints the git branch + short SHA + dirty flag.
- **Tmux preview + ssh attach** — `subctl orch view <team>` captures a tmux pane, dashboard renders it in a modal. Attach button shells into the same session.
- **LM Studio context auto-pin** — `ensureModelLoaded()` calls `/api/v1/models/load` with explicit `context_length` at boot, on supervisor switch, and via `/reload-supervisor`. Stops the recurring "context resets to 4K on JIT load" failure mode.
- **Auto-compact watchdog** — 5-minute interval (configurable via `compact.json`). Compacts via `/transcript/compact` with `target_tokens` + `keep_recent` params; returns `noop:true` for short transcripts so the UI shows an info notice instead of an error.
- **Telegram bidirectional** — outbound via `telegram_*` tools, inbound via the master notify listener. Single transcript, two surfaces.
- **`docs/master.md`** — canonical architecture document (mental model, components, memory architecture, roadmap, operational reference, glossary, decision log).

### Changed

- **Deploy workflow is canonical-git only.** Previously, in-flight iterations sometimes shipped via `rsync` to remote hosts; this is no longer supported. The only path is: commit + push → `subctl update` on each host. Branches are tracked properly; the M3 Ultra and laptop checkouts now diverge only via committed history.
- **`/health` and state.json** report the live `SUBCTL_VERSION` instead of the hardcoded `"0.1.0"` placeholder.
- **Dashboard `Bun.serve` `idleTimeout: 0`** — previously the default 10 s was killing SSE proxy connections, causing the connection pill to flap CONNECTED ↔ RECONNECTING when chat was idle.
- **Notice modal** replaces browser `alert()` / `confirm()` in the chat and orchestration surfaces; cancel button is hidden via both `hidden` attribute and `display: none` (belt-and-braces, since some browsers honor only one).
- **install-checks PATH** extended with `~/.bun/bin`, `~/.local/bin`, `~/.lmstudio/bin`, `~/.cargo/bin` plus per-tool `fallback_paths`, so launchd-launched dashboards find user-installed binaries.
- **`accounts.conf` parser** switched from tab-delimited to pipe-delimited to match the actual file format.

### Fixed

- **`pi-ai` empty responses** — diagnosed 2026-05-09: built-in providers are NOT registered as a side effect of `import`; `registerBuiltInApiProviders()` must be called explicitly at boot. Without it, every `agent.prompt()` returned an empty content array because the stream factory found no api in the registry.
- **`writeFileSync` ReferenceError** in `/api/master/supervisor` (missing require fixed).
- **`lms --version` ANSI banner** stripped via `stripAnsi()` helper.
- **claude-mem detection via CLI probe** replaced with plugin-dir presence check at `~/.claude/plugins/marketplaces/thedotmack`.
- **OAuth row hardcoded `subctl auth claude`** for all providers — now uses each account's actual provider field.
- **Pulse-dot blinking on every WS message** — only flashes when state signature actually changes.
- **Chat doesn't auto-scroll to bottom on load** — fixed via double-`requestAnimationFrame` + `MutationObserver` on tab switch.

### Removed

- **rsync-based deploy paths.** No more out-of-band file shipping to remote subctl installs. Use `subctl update`.

## [1.0.0] — 2026-05-05

First stable release. The 0.x series stabilized into a single coherent multi-account control plane for Claude Code, covering accounts, auth, sessions, projects, teams launcher, dashboard, radar, and statusline — all integrated against the same filesystem-derived state model.

### Added

- **`subctl projects`** — declarative per-account project bindings + bulk launcher.
- **`subctl sessions`** — list and adopt orphaned Claude transcripts across every configured `cfg_dir`.
- **`subctl session-kill` / `subctl session-prune` / `claude-kill` shim** — surgical session cleanup.
- **Cost analysis** — API list-price savings vs subscription cost, surfaced in the dashboard.
- **24-hour utilization history** with per-account event attribution.
- **Per-account dispatch readiness** via `/api/oauth/usage`.
- **Dashboard polish bundle** — Mintlify-style docs, kill button, countdowns, notifications, best-account hint, copy `claude-use`, expanded doctor output, `$1,234.56` currency formatting, `/help` reference docs page.
- **Per-account experimental teams runtime** — `subctl_settings_ensure_teams` seeds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode=tmux` into each account's `settings.json`, and the tmux session env now carries the experimental flag. `Team*` / `SendMessage` tools and `Agent(team_name=…)` now surface no matter how the account is launched.
- **Defensive tmux ergonomics in `provider_claude_teams`** — ensures `mouse on` and idempotent `WheelUpPane` / `WheelDownPane` bindings on the tmux server, so two-finger trackpad scroll reaches tmux's scrollback even from inside a Claude Code TUI pane. Idempotent — only writes bindings if not already present.
- **`START-HERE.md`** — one-shot Claude-Code-pasteable install prompt for new Macs.

### Changed

- **`subctl install` now wires statusline + Stop hook into every Claude config dir**, not just `~/.claude`. Each per-account `settings.json` gets its own `statusLine` pointing at its own per-dir scripts. Previously only the default `~/.claude` was patched, so the radar bar never appeared under `claude-use <alias>` because Claude Code reads from the per-account config dir.
- **`subctl accounts add`** wires the new account's config dir immediately; no `subctl install` re-run required.
- **`subctl doctor`** iterates every Claude config dir and reports per-dir statusLine state + symlink integrity.
- **Usage cache TTL bumped to 5 min**, with a manual `POST /api/refresh` for force-refresh.

### Fixed

- **Statusline missing in alias-launched sessions** — see "Changed" above.
- **`claude()` shell guard** now passes through subcommands and non-interactive flags, so `claude --version`, `claude doctor`, etc. work uninterrupted.
- **Dashboard ctx %** auto-detects 1M-context model variants instead of assuming 200k.
- **Dashboard rate-limit verdict** reflects honest signal rather than aggregate noise; events table cleaner.

## [0.4.2] — 2026-05-04

Dashboard rebuild + tmux PATH fix.

## [0.4.1] — 2026-05-04

`deck` (Go + Bubble Tea TUI) restored after the v0.4.0 rip-out turned out to be premature.

## [0.4.0] — 2026-05-04

Dropped the Go-based deck TUI in favor of `sesh` integration. Reverted in 0.4.1.

## [0.3.0] — 2026-05-04

`subctl deck` — Go + Bubble Tea live session manager TUI.

## [0.2.0] — 2026-05-04

First-class shims for `claude-teams`, `claude-radar`, `claude-dash`.

## [0.1.0]

Initial multi-account isolation, statusline, and Stop hook for Claude Code.
## [2.7.27] — 2026-05-13

### `feat(master): v2.7.27 tinyfish_agent — third TinyFish surface`

Adds the **TinyFish Agent API** as the third surface of the TinyFish integration (after `tinyfish_search` + `tinyfish_fetch` shipped in v2.7.16). Evy now has a hosted-browser-automation-as-a-service tool: describe a task in natural language, supply a starting URL, get back the extracted result + run metadata. Useful when she needs to fill a form, click a multi-step flow, or scrape dynamic content that requires interaction — without spinning up Playwright locally (that's the v2.8.0 Browser API route, ADR 0013, still out of scope for this PR).

**Endpoint (verified against https://docs.tinyfish.ai on 2026-05-13):**

- `POST https://agent.tinyfish.ai/v1/automation/run`
- `X-API-Key` header (reuses the existing `tinyfish_api_key` secret — same key as search + fetch)
- Body: `{ url (req), goal (req), agent_config: { max_duration_seconds, max_steps? }, browser_profile? }`
- Response: `{ run_id, status: "COMPLETED"|"FAILED", started_at, finished_at, num_of_steps, result, error }`

**Tool parameters (LLM-facing names follow the operator's v2.7.27 spec; wire shape follows TinyFish):**

- `task` (required) → `goal`
- `starting_url` (required, http(s) only) → `url`. NOTE: the original spec called this optional, but the Agent API enforces `url` as required (does not free-pick from the task description). Tool surfaces a structured error when omitted.
- `timeout_seconds` (default 120, clamped to [1, 600]) → `agent_config.max_duration_seconds`
- `max_steps` (optional, 1–500) → `agent_config.max_steps`
- `browser_profile` (`"lite"` default | `"stealth"`)

**Reliability:** 5xx + transport-level network errors retry up to 3 attempts with exponential backoff (500ms → 1500ms). 4xx (401 auth, 402 billing, 429 rate-limit, 400 invalid) surfaces immediately — operator-actionable, never retried. Agent-side `status: "FAILED"` surfaces as `{ ok: false, error, run_id, retry_after, hint }` with the SYSTEM_FAILURE / AGENT_FAILURE / BILLING_FAILURE / UNKNOWN category preserved.

**Files:**

- `components/master/tools/tinyfish.ts` — adds `tinyfish_agent` to the `tinyfishTools` family export, plus a public `callTinyfishAgent` named export for direct callers. Adds `sleep` to the injectable `Deps` interface so retry backoff is testable. Header comment expanded to cover the third surface.
- `components/master/tools/__tests__/tinyfish-agent.test.ts` — NEW, 20 hermetic tests covering: happy path + wire shape, optional `max_steps` / `browser_profile` / `timeout_seconds` forwarding, timeout clamping, validation (missing task, missing starting_url, invalid URL, missing API key), 4xx (401/402/429/400 — no retry, no sleep), 5xx retry success + retry exhaustion + retries[] log, network error retry, HTTP timeout headroom on every attempt, agent-side `FAILED` status, unexpected status string, malformed JSON, registry wiring.
- `components/master/tools/__tests__/tinyfish.test.ts` — family-export sanity test updated to expect three tools.
- `dashboard/server.ts` — `/api/settings/keys` TINYFISH_API_KEY purpose string extended to mention `tinyfish_agent` (paid, v2.7.27). No new operator-facing UI; Evy invokes the tool inline.
- `docs/master.md` — extends the existing TinyFish section with a v2.7.27 addendum.
- `VERSION` → `2.7.27`.

**No new ADR.** This is a mechanical extension of an integration whose architecture was already decided (v2.7.16). ADR 0013 covers the separate Browser API route (v2.8.0); the Agent API's request/response shape fits the existing single-tool pattern without architectural changes.

**Server registration:** automatic — `tinyfishTools` is iterated by `components/master/server.ts`. The new tool appears in the registry, `/diag`, and Evy's tool list on next master restart with no edits to server.ts.

**Master is the only surface.** No new Telegram commands. No watchdog. No notifications. Single tool, single test file, single doc section.

## [2.7.29] — 2026-05-13

### `feat(master): v2.7.29 plan-approval workflow (dashboard + telegram)`

Worker-proposed plans now surface to the operator instead of dying silently in tmux panes. The subctl orchestrator team protocol already supported `plan_approval_request` / `plan_approval_response` between workers and the team lead, but the OPERATOR-facing layer — where Jason actually sees the plan and approves or rejects from anywhere — didn't exist. v2.7.29 closes that loop end-to-end.

**Flow:**

1. Worker emits `plan_approval_request` to its team lead.
2. Team lead forwards it into the master daemon by appending a JSONL line to `~/.config/subctl/master/inbox/<team>.jsonl` with `{"type":"plan-approval-request", "request_id":..., "worker_name":..., "plan_summary":..., "plan_body":...}`.
3. Master records the request in the pending-approvals queue (persisted JSONL log at `~/.local/state/subctl/plan-approvals.jsonl`) and emits a `severity:"alert"` notification — which fans out to the dashboard tray AND the operator's Telegram via the existing notification channel.
4. Operator decides from anywhere:
   - **Dashboard Plans tab:** card per pending plan, expandable body, `[Approve]` / `[Reject]` (modal feedback) buttons.
   - **Telegram:** `/plans`, `/plans approve <id>`, `/plans reject <id> <feedback>`.
5. Master forwards the `plan_approval_response` back to the team lead via the HMAC-authenticated dashboard `/msg` route — same trust path the auto-nudge uses.
6. Anything sitting in `pending` >60 minutes auto-rejects with feedback `"auto-expired"`; operator can re-request from the worker if they still want the work.

**Files (new):**

- `components/master/plan-approvals.ts` — queue module: `recordApprovalRequest()`, `listPending()`, `listDecided()`, `approveRequest()`, `rejectRequest()`, `expireOldRequests()`. Append-only JSONL log + in-memory state. Concurrency-safe (second writer hits `ApprovalError /not-pending`). plan_body is never written to stderr at default logging level (may contain secrets).
- `components/master/__tests__/plan-approvals.test.ts` — 10 pins: record/list/approve/reject round-trips, concurrent approve race, expire threshold, persistence replay, summary truncation, race-after-reject.

**Files (modified):**

- `components/master/server.ts` — imports the queue, handles `plan-approval-request` events in `tailInboxFile()`, exposes `/plan-approvals` REST (list, approve, reject, expire), and registers a 5-min watchdog ticker that calls `expireOldRequests()`. The approve/reject paths emit a `severity:"info"` notification on each decision so the operator sees the action landed, and forward the response back to the team via `/api/orchestration/:name/msg`.
- `components/master/master-notify-listener.ts` — adds `/plans`, `/plans approve <id-prefix>`, `/plans reject <id-prefix> <feedback>` Telegram commands. Prefix-match against pending ids so operators don't have to paste a full uuid; ambiguous prefixes return an error listing the matches.
- `dashboard/server.ts` — `/api/plan-approvals/*` proxy to master (mirrors the `/api/notifications` shape; localhost only).
- `dashboard/public/index.html` — new sidebar nav button with pending-count badge, new `<section data-tab="plans">` with pending/decided cards + reject-feedback modal.
- `dashboard/public/app.js` — `initPlansTab()`: renders the queue, wires approve/reject buttons, refreshes on tab activation + every notification SSE event + 30s poll.
- `dashboard/public/style.css` — `.plan-card-*` styling: pending = amber left-border, approved = green, rejected = red, expired = grey. Expandable plan body (`<details>`).
- `docs/master.md` — new "Plan approvals (v2.7.29)" section documenting the contract.
- `VERSION` → `2.7.29`.

**Security / safety notes:**

- The plan_body field is NEVER logged to stderr by default — workers may paste secrets, partial commits, or unredacted snippets. Master truncates to a 60-char summary in any console output.
- `~/.local/state/subctl/plan-approvals.jsonl` lives under XDG_STATE_HOME (or `~/.local/state`); inherits the operator's umask. Operators on shared boxes should chmod 600 manually until the next pass.
- The `/msg` delivery path back to the worker reuses the v2.7.20 HMAC trust marker — workers verify the response as a legitimate supervisor directive.

---

## [2.7.25] — 2026-05-13

### `feat(dashboard): v2.7.25 Lucide icons + notification UX polish + upstream-tracker watchdog`

Three bundled scopes, one PR (operator's explicit request). All three were surfaced after v2.7.22 + v2.7.24 shipped: the notification panel had stayed always-on with no dismiss path, the emoji-as-icon chrome was producing platform-rendering-roulette ("Wingdings, crappy things like that"), and ADR 0015's "always-latest" policy had no enforcement mechanism beyond a process commitment.

**Scope A — Lucide icon library (ADR 0016).** New `dashboard/public/icons.js` exposes `icon(name, opts?)` returning an SVG string. Static-baked from Lucide v0.474.0 (MIT) — `lucide` added to `dashboard/package.json` as the source-of-truth dep, but the runtime serving model stays build-step-free (the dashboard serves `public/*` verbatim). The bell `🔔` becomes Lucide `inbox`; the master chat attach button `📎` becomes `paperclip`; notification severity icons become `info` / `alert-triangle` / `alert-octagon`; the dropdown's dismiss and close glyphs become `x`; the copy-prompt button uses `clipboard`; the upstream card uses `package`. ADR 0016 documents what's deliberately NOT replaced (tool-family icons in `tool-display.json` — content config, not chrome; sidebar nav glyphs — unicode geometric shapes, not emoji; verdict 🟢🟡🔴 — colored content indicators rendered via `setText()`, surrounding CSS class carries the color signal anyway).

**Scope B — Notification UX polish.** The v2.7.22 panel rendered always-on with no collapse or dismiss — notifications piled up, the panel always showed. Rewritten as:

- The inbox icon in the topbar is the only persistent surface. Click → dropdown showing the last 20 notifications. Empty state: "No notifications".
- New live-arrival **toast** stack in the top-right corner. Slides in from right, holds ~5s (8s for `severity:"alert"`), fades out + slides back. Max 3 visible — older ones drop as new ones arrive. Driven by the same SSE stream the dropdown subscribes to.
- Each dropdown row carries a severity icon (info / alert-triangle / alert-octagon), title, body (truncated to ~80 chars with the full body in the title-attribute tooltip), relative timestamp ("3min ago"), per-row `[×]` dismiss button, and (for `severity:"warn"` / `"alert"` / kinds matching `error|failed|fail|unresponsive|vanished|circuit-breaker|tripped|denied|stuck`) a `[clipboard] Copy prompt` button.
- The copy-prompt button assembles a structured "ask an LLM to triage this" prompt (severity / title / body / team_id / ts / kind / metadata) and writes it to clipboard. Brief "Prompt copied" toast confirms.
- Read notifications stay visible at 0.55 opacity until explicitly dismissed via `[×]`. The badge count reflects unread only. "Mark all read" stays in the dropdown header.
- `Notification.metadata` field added to `components/master/notifications.ts` — optional structured payload that flows through to the dropdown's copy-prompt builder. Used by Scope C's upstream-available notifications to carry `{package, from, to, bump_kind}`.

**Scope C — Upstream-tracking watchdog (`upstream-check`).** Closes the enforcement gap on ADR 0015's always-latest policy. New `components/master/upstream-check.ts`:

- Registers a watchdog `id: "upstream-check"`, `kind: "upstream-check"` (registry — same `components/master/watchdogs.ts` surface the operator's `/watchdogs` kill command sees). Ticks every 6h (`SUBCTL_UPSTREAM_CHECK_INTERVAL_MIN` env override). Fires once at boot + 20s so `/api/upstreams` returns real data on the first dashboard visit.
- Reads `components/master/package.json` for the floor-pinned `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` versions, fetches each package's `dist-tags.latest` from `https://registry.npmjs.org/<package>`, compares via a small semver parser, classifies the bump as `same` / `patch` / `minor` / `major`.
- Newer → notification. `severity:"info"` for patch/minor bumps, `severity:"warn"` for major (the `^` pin won't cross the boundary on its own per ADR 0015). Title: `pi-ai 0.74.0 → 0.75.0 available`. Metadata: `{package, from, to, bump_kind}` flows into the dropdown's copy-prompt format.
- **Auto-update gate (default OFF).** Manual operator action is the default — notification only. Setting `~/.config/subctl/auto-update-upstreams.enabled` (any file at that path is sufficient — `touch` is the canonical activation) promotes the watchdog to ADDITIONALLY:
  1. Write the new pin (preserving `^` / `~`) into `components/master/package.json`
  2. `bun install` in `components/master/`
  3. `bun test` in `components/master/`
  4. Pass → `severity:"info"` notification "pi-ai auto-updated 0.74.0 → 0.75.0 (tests passing)"; review the diff and commit/push manually.
  5. Fail → revert `package.json` + `severity:"alert"` notification "pi-ai auto-update 0.74.0 → 0.75.0 failed tests; reverted".
- The watchdog **never auto-commits** and **never auto-pushes**. The operator's eyeball on the diff is the explicit gate.
- New `/upstreams` (GET) + `/upstreams/check` (POST) master routes; dashboard proxy at `/api/upstreams` + `/api/upstreams/check`.
- New "Upstreams" card in the dashboard Memory tab — current pinned versions, last-checked timestamp, "Check now" button.
- New `/upstreams` Telegram command — replies with the latest tick state + auto-update-gate flag location.

**Files:**

- New: `dashboard/public/icons.js` — Lucide-backed `icon(name, opts)` helper. ~10 baked icons (`inbox`, `x`, `clipboard`, `clipboard-check`, `info`, `alert-triangle`, `alert-octagon`, `check`, `package`, `refresh-cw`, `paperclip`, `bell`). Also exposes `window.subctlIcon` for the classic-script `app.js`.
- New: `dashboard/__tests__/icons.test.ts` — 10 tests covering catalog membership, SVG shape, size/className/strokeWidth options, the empty-string fallback for unknown names.
- New: `components/master/upstream-check.ts` — `runUpstreamCheck`, `startUpstreamWatchdog`, `defaultAutoUpdateRunner`, `describeUpstreamState`, plus pure helpers (`parseSemver`, `classifyBump`, `pinFloor`, `preserveCaret`, `readPinnedVersion`, `writePinnedVersion`).
- New: `components/master/__tests__/upstream-check.test.ts` — covers the pure helpers, a mocked-registry round-trip (info for minor bump, warn for major, no notification when versions match), and the auto-update gate (off by default → runner not called; on + success → package.json rewritten + info notif; on + fail → revert + alert notif).
- New: `docs/adr/0016-lucide-icon-library.md` — the decision record. Index updated.
- `components/master/notifications.ts` — `Notification.metadata?` field added; `EmitNotificationInput.metadata?` plumbs through `emitNotification()`.
- `components/master/server.ts` — imports `startUpstreamWatchdog` + `describeUpstreamState`, arms the watchdog after the verifier-cluster ticker, adds `/upstreams` GET + `/upstreams/check` POST routes, hooks shutdown.
- `components/master/master-notify-listener.ts` — adds `/upstreams` Telegram command + help-line entry; "Unknown command" hint updated.
- `dashboard/server.ts` — `/api/upstreams` and `/api/upstreams/check` proxy routes; `/icons.js` registered in `STATIC_FILES`.
- `dashboard/public/index.html` — bell icon span gets an id (filled by JS); old emoji `🔔` removed; tray drawer + toast stack restructured; attach button is now icon-driven; new "Upstreams" card section in the Memory tab; `<script type="module" src="/icons.js">` loaded ahead of `app.js`.
- `dashboard/public/app.js` — full rewrite of `initNotificationTray` (dropdown + toast stack + copy-prompt + dismiss + read-stays-visible); new `initLucideChrome` (paperclip swap); new `initUpstreamsCard` (lazy-loads on Memory tab activation).
- `dashboard/public/style.css` — v2.7.22 panel rules replaced with v2.7.25 dropdown + toast styles; `.upstreams-card` styles added.
- `dashboard/package.json` — `"lucide": "^0.474.0"` dep added.
- `docs/master.md` — new sections "Notification system (v2.7.25 UX)", "Icon library (ADR 0016)", "Upstream tracking (v2.7.25 Scope C)".
- `VERSION` → `2.7.25`.

**Notification kinds added (forward-compat with the v2.7.22 ring):**

- `upstream-available` — newer pi-ai or pi-agent-core on npm (info patch/minor, warn major)
- `upstream-auto-updated` — auto-update gate ran successfully (info)
- `upstream-update-failed` — auto-update gate ran but tests failed; reverted (alert)
- `upstream-check-error` — watchdog tick threw (warn, swallowed so the daemon keeps running)

**Out of scope, deferred:**

- Replacing tool-family emoji icons in `tool-display.json` and the verdict glyphs in the dispatcher (see ADR 0016 § Deliberately NOT replaced for reasoning).
- An automated `subctl auth github-copilot <alias>` OAuth wiring (deferred from v2.7.24 per ADR 0015's open questions).

## [2.7.24] — 2026-05-13

### `feat(dashboard): v2.7.24 pi-ai provider catalog (dynamic dropdown) — pi-ai + pi-agent declared first-class upstreams`

Two scopes, one architectural framing: subctl now treats **both** pi-mono packages as first-class always-latest upstreams (ADR 0015), and the dashboard's "New profile" dropdown finally consumes the catalog half of that dependency.

**Scope A — first-class upstreams (always-latest policy).** Subctl depends on the pi-mono monorepo via two npm packages, and both are load-bearing: `@earendil-works/pi-agent-core` runs master's agent loop, tool registry, and streaming (the existing agent runtime — untouched in code, but now explicitly documented as a tracked upstream); `@earendil-works/pi-ai` is the provider catalog (what providers exist, model lists per provider, factory shapes). Both are pinned to `^0.74.0` in `components/master/package.json` so `bun install` resolves to latest on every deploy. The release policy added in ADR 0015: subctl's release process MUST update both packages to their latest published versions on every minor/patch release. v2.7.25 will add an auto-tracker watchdog that surfaces upstream bumps as `severity:"info"` notifications — deferred from v2.7.24 to keep the catalog work shippable in isolation.

**Scope B — dynamic provider catalog (the v2.7.24 code change).** Replaces the hand-curated dropdown — five entries, three flagged `(future)`, missing the `pi-coding-agent` integration entirely — with a dynamic catalog backed by `@earendil-works/pi-ai`. The master daemon was already importing pi-ai for its stream factory; subctl's UI just wasn't consuming the catalog half. Net result: the dropdown jumps from 5 entries to 31, and new providers added upstream (groq, cerebras, openrouter, xai, bedrock, openai-codex, github-copilot, deepseek, fireworks, vercel-ai-gateway, …) light up automatically on the next pi-ai bump.

**Files:**

- New: `components/master/pi-ai-catalog.ts` — wraps pi-ai's `getProviders()` + `getModels()` into a stable `CatalogProvider` shape (id, display_name, kind, auth_method, model_count, notes). Holds the `SUBCTL_TO_PI_AI` alias table — legacy subctl ids (`claude`, `gemini`, `pi-coding-agent`) map to pi-ai canonicals (`anthropic`, `google`, `anthropic`) so existing `accounts.conf` rows keep working. Exports `listCatalogProviders()`, `isCatalogProvider()`, `resolveProviderId()`, `legacyAliasFor()`.
- New: `dashboard/__tests__/providers.test.ts` — 26 tests covering catalog shape, alias mapping (both directions), validation gate, profile-merge contract, accounts.conf parse robustness.
- New: `docs/adr/0015-pi-ai-and-pi-agent-as-first-class-upstreams.md` — decision record framing both packages as first-class upstreams, the always-latest dependency-update policy, the mapping table, the v2.7.25 auto-tracker note, and the deferred open questions (OAuth flows for new providers, WIRED_PROVIDERS deduplication, pi-mono major-version handling).
- `dashboard/server.ts` — `/api/providers` GET replaces its hand-curated `CLOUD` array with `listCatalogProviders()`, walks every catalog entry, attaches matching `accounts.conf` profiles via the alias map, surfaces `auth_method` / `model_count` / `legacy_alias` in the JSON. `/api/providers/profiles` POST validates the requested provider against the catalog and rejects unknown ids with a 400 + hint listing the known legacy aliases.
- `dashboard/public/index.html` — `<select id="profile-provider">` is now empty in markup; app.js populates it dynamically. The `(future)` tags are gone.
- `dashboard/public/app.js` — `populateProviderDropdown()` runs on each modal open: fetches `/api/providers`, filters to cloud, sorts (providers-with-profiles-first, then alphabetical), renders each `<option>` with the display name + `(OAuth)` badge when applicable + a `· N profile(s)` suffix when the operator already has profiles for that provider. `openModal()` is now async and refreshes the dropdown so newly-added upstream providers show up without a page reload.
- `docs/adr/README.md` — index updated.
- `docs/master.md` — new "Pi-mono upstreams + provider catalog (v2.7.24+)" section explaining the dual-upstream relationship and how the catalog is consumed.
- `VERSION` → `2.7.24`.

**Dependencies (`components/master/package.json`):**

- `@earendil-works/pi-agent-core`: `^0.74.0` (agent runtime, unchanged usage)
- `@earendil-works/pi-ai`: `^0.74.0` (provider catalog, now consumed by dashboard)

Both pinned with `^` so `bun install` resolves to the latest published `0.x.y` automatically on every deploy. This is the mechanical layer of the always-latest policy in ADR 0015.

**Out of scope, queued for follow-up:**

- **v2.7.25: auto-tracker watchdog.** Polls npm for new pi-ai + pi-agent-core releases, raises a `severity:"info"` notification with a one-click bump action. Documented in ADR 0015.
- **OAuth flows for newly-surfaced providers** (GitHub Copilot, xAI). `@earendil-works/pi-ai/oauth` exposes helpers; wiring `subctl auth github-copilot <alias>` through them is a follow-up. Operators authenticate new providers via API keys (env var or `secrets.json`) in v2.7.24.
- **Deriving `WIRED_PROVIDERS`** (in `/api/master/supervisor`) from pi-ai's `registerBuiltInApiProviders` registry. Two related-but-separate concerns (what's in the dropdown vs. what the supervisor can actually run) — folding them into one source of truth is queued.

## [2.7.23] — 2026-05-13

### `feat(master): v2.7.23 Evy Memory (Tier 3) — Memori-substrate TS implementation`

Lands the Tier 3 conversational memory layer described in ADR 0005. When Evy has a conversation tonight and master is restarted tomorrow, she now remembers what was discussed — the things that would be expensive to re-derive: who's working on what, what was just shipped, what's stuck, what operator preferences emerged in chat. This is the fix for what the operator has been calling "51st date syndrome."

**Substrate choice (ADR 0014).** ADR 0006 named Memori as the substrate, but Memori is a Python framework (MemoriLabs/Memori) — there is no maintained TypeScript SDK on npm. Subctl is Bun/TS. The integration would have required a Python sidecar service, and Memori's value-add (auto-injecting captured memory into LiteLLM prompts) is moot for subctl because pi-ai is our LLM call path, not LiteLLM. We picked Option B from the spec: a native TypeScript port using `bun:sqlite` with FTS5 full-text search. Memori's `memori_conversation_message` table shape inspired the schema; the entity-fact knowledge-graph layer was dropped (it requires LLM-driven extraction, which we'd add as a v2 enhancement). The result wraps as **Evy Memory** — a subctl/Evy-aware module rather than vanilla Memori. ADR 0014 supersedes ADR 0006. ADR 0010 (claude-mem stays parallel as Tier 4) is preserved; the new code reads zero claude-mem state.

**Storage.** `~/.local/state/subctl/memory/evy.db` (chmod 600, directory chmod 700). Single SQLite file. Schema: `entries(id, ts, team_id, role, kind, content, metadata_json)` + an FTS5 virtual table with triggers keeping it in sync. WAL journal, synchronous=NORMAL. Sub-millisecond inserts on the M3. FTS5 availability is detected at boot; if a future Bun build strips it, the retrieval path falls back to LIKE matching automatically.

**Capture surfaces (turn boundaries).** The master daemon hooks Evy Memory at every recorded turn:

- User message arrives (`chat` / `telegram` / `cli`) → `role: "user", kind: "message"`.
- Synthetic prompt (verifier / watchdog / scheduled / team-report) → `role: "event", kind: "synthetic-prompt"` so search-by-role can filter out daemon noise.
- Assistant response settles → `role: "assistant", kind: "message"` (skipped for synthetic re-entries).
- Tool call dispatched → `role: "tool", kind: "tool-call"`, content = `tool_name(short_args)` (top-level fields only, truncated to 320 chars total so a single noisy call can't dominate FTS).
- Notification emitted (info/warn/alert) → `role: "event", kind: "notification"`, metadata carries severity + the original notification id.

Failures are swallowed and logged to stderr — memory must never break a tool call or block an operator reply.

**Recall surfaces.**

- **Evy's tools.** `evy_recall(query?, team_id?, kind?, since_days?, limit?)` and `evy_remember(content, kind?, team_id?)` — the explicit save surface. The tool descriptions name the Tier 3 vs Tier 4 distinction so Evy routes between Evy Memory (operator-Evy chat) and `memory_search` (claude-mem cross-session observation corpus).
- **Dashboard /api/memory/\*** proxy (subpath-only to leave `/api/memory` mapped to the existing Obsidian status endpoint):
  - `GET /api/memory/search?query=&team_id=&kind=&since=&limit=` — FTS5 search
  - `GET /api/memory/recent?limit=` — last N entries
  - `GET /api/memory/stats` — count + bytes + FTS5 flag
  - `POST /api/memory/entries` — record an operator-note
  - `DELETE /api/memory/entries/:id` — operator-only forget
- **Memory tab UI.** New "Evy Memory" card in the Memory tab (the existing tier-1 / Obsidian cards stay). Search input + kind dropdown + recent button + per-entry forget action.
- **Telegram.** `/memory <query>` returns the top 3 matches; `/memory recent` returns the last 5; `/remember <text>` saves a kind="operator-note" entry. `/help` updated.

**Privacy posture (ADR 0009 preserved).** The DB never egresses without the operator's action. All bytes that leave master via Telegram or the dashboard pass through `redactEntryForEgress`, which masks `sk-*` / `pk-*` API keys, `Bearer …` tokens, 64-char hex blobs (HMAC marks per the v2.7.20 trust-marker shape), `hmac:<team>:<hex>` structured marks, and other 40+ uppercase-hex secret-ish strings. Storage-side is unredacted because the file is chmod 600 and only the operator's user account can read it; this leaves operator search across raw content possible while still defending the egress surfaces.

**Files:**

- New: `components/master/memory.ts` — the storage primitive. `recordEntry` / `recallEntries` / `recentEntries` / `purgeBefore` / `deleteEntry` / `memoryStats` / `redactForEgress` / `redactEntryForEgress`. Path resolution mirrors `trust-marker.ts` (SUBCTL_STATE_DIR override for tests). Includes `_setStateDirForTesting` and `_closeForTesting` helpers.
- New: `components/master/tools/evy-memory.ts` — `evy_recall` + `evy_remember` master tools. Descriptions explicitly draw the Tier 3 vs Tier 4 line so Evy routes correctly.
- New: `components/master/__tests__/memory.test.ts` — 18 tests: record/recall round-trip, team_id + kind + since filters, FTS5 (verified available in Bun 1.2.17) + LIKE fallback path, recentEntries ordering, purgeBefore with FTS-trigger sync, deleteEntry, chmod 600/700 on the DB file + parent dir, memoryStats reflects live state, redactForEgress masks sk-*/Bearer/64-hex/hmac:* on egress without mutating input.
- `components/master/server.ts` — imports the memory module + tools; records user/assistant/tool/event entries at turn boundaries (with synthetic-prompt detection); subscribes to notifications and writes each one through to memory; adds `/memory/*` HTTP routes with egress redaction; adds `summarizeArgs` helper for short tool-call signatures.
- `components/master/master-notify-listener.ts` — `/memory` + `/remember` Telegram commands; redacted on output; help text updated.
- `dashboard/server.ts` — `/api/memory/*` proxy to master, gated on subpath presence so the existing `/api/memory` (Obsidian status) route is untouched.
- `dashboard/public/index.html` — Memory tab subheader rewritten to name all five tiers; Evy Memory card appended to the memory grid (search input + kind filter + recent button + list region).
- `dashboard/public/app.js` — `wireEvyMemoryCard` (called from `wireMemoryTab`): loads recent on mount, runs search via `/api/memory/search`, per-entry forget action, periodic refresh while the tab is visible.
- `dashboard/public/style.css` — `.evy-mem-*` classes for the new card (controls, list, item, body, redaction-friendly truncation).
- New: `docs/adr/0014-evy-memory-ts-port-of-memori.md` — the ADR.
- `docs/adr/0006-memori-byodb-sqlite-for-tier-3.md` — Superseded by 0014 (status header updated, reasoning preserved verbatim for history).
- `docs/adr/0005-five-tier-memory-architecture.md` — Tier 3 row + reasoning + references point at 0014.
- `docs/adr/README.md` — index updated.
- `docs/master.md` — new "Evy Memory (Tier 3) — v2.7.23+" section.
- `VERSION` → `2.7.23`.

## [2.7.22] — 2026-05-13

### `feat(master): v2.7.22 notification channel + watchdog auto-nudge + auto-compact fix`

Three bundled scopes, all rooted in the same architectural mistake: the team-staleness watchdog was synthesizing operator-facing prompts straight into the master agent's transcript. Every tick read like _"1 dev team(s) appear stale: claude-osint-cve-monitor (221min ago). Decide whether to ping the lead via subctl_orch_msg, escalate to Jason via telegram_send, or take corrective action."_ — interleaved with Evy's actual conversation, paid an LLM call per tick to "decide", and asked the supervisor to do the cheap remediation it should have done itself.

- **Notification channel separation (scope A).** New `components/master/notifications.ts` — an in-memory ring buffer (N=200) with `emitNotification` / `listNotifications` / `subscribeNotifications` / `markRead` / `markAllRead`. The team-staleness watchdog NO LONGER appends to the agent's transcript; it calls `emitNotification` instead. Operator surfaces: a bell-icon tray in the dashboard header (driven by `GET /api/notifications` + `GET /api/notifications/stream` SSE), a Telegram push on `severity:"alert"` only (info/warn stay tray-local), and a `/notifications` Telegram command for read + mark-all-read. The master's HTTP server exposes `/notifications`, `/notifications/:id/read`, `/notifications/read-all`, `/notifications/stream`; the dashboard proxies them under `/api/notifications/*` (REST + SSE pass-through, same shape as `/api/master/events`).
- **Watchdog auto-nudge (scope B).** Extracted as `components/master/auto-nudge.ts` so the state machine is unit-testable. On staleness detection the watchdog calls the dashboard's `/api/orchestration/:name/msg` route (HMAC-signed via v2.7.20's trust marker — same path the `subctl_orch_msg` tool takes) with `[auto-nudge] You've been inactive for N min...`, records `last_nudge_at`, and emits a `severity:"info"` `team-nudge-sent` notification. Within the 30-min retry window the watchdog HOLDS — no re-nudge, no re-alert. After 30 min still stale → `severity:"alert"` `team-unresponsive` notification (which the Telegram push picks up) AND a re-nudge with an escalated body. Team responds before 30 min → state clears, next staleness counts as a fresh first nudge. Operator only gets paged when a team actually fails to respond to a nudge.
- **auto-compact watchdog fix (scope C).** Root cause: the boot-time 30s `setTimeout(runAutoCompactTick, 30_000)` fired the tick body but never called `touchWatchdog("auto-compact")`. The periodic 5-min `setInterval` did the bump OUTSIDE `runAutoCompactTick`, so any error inside the tick was silent. Net effect: a freshly-booted master showed `last_tick_at: null` for up to 5 minutes even after the early-fire ran, and a thrown error inside the compaction body was a `console.error` that never reached the operator. Fix: `touchWatchdog` now runs at the TOP of `runAutoCompactTick` itself, the entire tick body is wrapped in a try/catch that emits a `severity:"warn"` `auto-compact-error` notification on failure, and the early-fire window dropped from 30s to 15s so the watchdog's `last_tick_at` lights up well inside the operator-observable boot window.

**Files:**

- New: `components/master/notifications.ts` — ring buffer + pub/sub API. Includes `_resetForTesting()` so individual tests don't leak state.
- New: `components/master/auto-nudge.ts` — `decideTeamAction` (pure) + `runStaleTeamSweep` (orchestrator with side-effect callbacks). The server's watchdog tick passes its `sendNudge` / `emitInfo` / `emitAlert` / `logDecision` callbacks into `runStaleTeamSweep` — the master daemon owns I/O, the module owns policy.
- New: `components/master/__tests__/notifications.test.ts` — emit/list/markRead round-trip, ring-buffer eviction at the cap, severity routing (the Telegram-pusher contract), `since`/`limit` filters.
- New: `components/master/__tests__/auto-nudge.test.ts` — pure-decision matrix + sweep contract: first-nudge, escalation, response resets state, 30-min hold dedup, send-failure still advances `last_nudge_at`.
- New: `components/master/__tests__/auto-compact.test.ts` — watchdog ticks within the early-fire window, compaction primitive shrinks 50k → <35k, errors emit a `severity:"warn"` notification.
- `components/master/server.ts` — imports the new modules; `runWatchdogTick` no longer dispatches to the agent (the `[watchdog] ... appear stale ... Decide whether to ping` synth-prompt + the `dispatchToAgent(synthPrompt, "watchdog")` call are gone); subscribes to `severity:"alert"` notifications and pushes via `sendTelegramOutbound`; adds `/notifications` HTTP routes; `runAutoCompactTick` bumps the watchdog at the top of every tick path and wraps the body in a try/catch that emits a `severity:"warn"` notification; early-fire dropped from 30s to 15s.
- `components/master/master-notify-listener.ts` — adds `/notifications` Telegram command (`/notifications` = last 5, `/notifications read` = mark all read), updates `/help` text.
- `dashboard/server.ts` — adds `/api/notifications/*` proxy (REST + SSE pass-through) before the existing `/api/master/*` proxy.
- `dashboard/public/index.html` — bell button + `#notif-bell-badge` in the topbar; the drawer (`#notif-tray`) hangs from `<body>` so it overlays content without shifting layout.
- `dashboard/public/style.css` — `.notif-bell`, `.notif-tray`, `.notif-item` + severity glyph colors. Distinct from the `.orch-notify-*` per-team activity ring inside the orchestration tab.
- `dashboard/public/app.js` — `initNotificationTray`: REST seed on first open, SSE for live deltas, mark-read + mark-all-read, badge count, click-outside-closes.

## [2.7.21] — 2026-05-13

### `feat(dashboard): v2.7.21 web terminal escape hatch (ADR 0011 Layer 2)`

Closes ADR 0011 by landing the operator-facing web terminal — the always-available "drop into the worker's pane and type as yourself" escape hatch that the same 2026-05-12 paranoia-loop incident motivating Layer 1's HMAC marker exposed as a real product gap. With v2.7.21, breaking a stuck worker no longer requires SSH from another machine; an "Attach" button on every team card in the orchestration cockpit opens an xterm.js terminal in the browser, proxied through a node-pty sidecar running `tmux attach -t <session>`. Operator types directly into the worker's pane, bypassing master, bypassing HMAC, bypassing the worker's paranoia heuristics.

Layers 1 (HMAC marker, v2.7.20) and 3 (style matching, Evy SKILL.md since v2.7.15) shipped earlier; v2.7.21 makes ADR 0011 complete.

**The threat-model and security gate.** The web terminal exposes a shell-equivalent surface (anything the operator's user can do, including writing into worker tmux panes that bypass HMAC), so it ships default-OFF behind a flag file:

- `~/.config/subctl/terminal.enabled` — file presence = enabled, absence = disabled. No parsing, no schema, deliberately the simplest possible toggle. Touched by `/terminal on` from Telegram or `touch` from the shell.
- When disabled: `WS /api/terminal/attach` returns HTTP 403 on upgrade; `GET /api/terminal/teams` returns 403; `GET /api/terminal/enabled` returns `{enabled:false,flag_path:...}` (the dashboard UI uses this to hide all Attach buttons + the modal entirely via `body.terminal-disabled` CSS class).
- When enabled: WS upgrade succeeds; UI shows Attach buttons.
- **Auth pattern reuses dashboard's existing localhost-bind posture** (`SUBCTL_DASHBOARD_HOST` env, defaults `127.0.0.1`). No new auth surface, no cookies, no headers — the dashboard has no auth middleware today, and adding one here would be inventing policy. As defence-in-depth against DNS rebinding, when the dashboard is bound to a localhost address the WS upgrade additionally rejects requests whose `Host` header isn't a localhost variant. When the operator deliberately opens the dashboard to LAN we trust the listener config and skip the host check (same posture as `/api/orchestration/*` and friends).
- Team name validated against `[A-Za-z0-9._-]{1,128}` before the upgrade — tmux session names are operator-controlled but the path through the URL is not, so we clamp.

**Node sidecar instead of in-process node-pty.** node-pty under Bun 1.2.x has a known fd-handling bug (ENXIO on pty master read), so the dashboard server (Bun) spawns a tiny Node helper (`dashboard/lib/pty-helper.cjs`) per WS, and the helper owns the actual pty. The two processes speak a framed binary protocol over the helper's stdin/stdout: type byte (DATA / RESIZE / CLOSE / EXIT / ERROR) + 4-byte big-endian length + payload. node-pty works perfectly under Node, so the helper is reliable; the parent Bun process never needs to import node-pty directly.

**Browser wire format.** The xterm.js client (`dashboard/public/terminal.js`) and the server (`dashboard/terminal.ts`) use JSON text frames in the client→server direction and raw binary frames in the server→client direction. Specifically:

- `client → server` JSON only: `{"type":"data","b64":"<base64 keystrokes>"}` and `{"type":"resize","cols":N,"rows":N}`. Base64 in the data frame keeps the upstream direction plain-JSON and trivially inspectable in browser devtools; keystrokes are tiny so the 33% base64 inflation is irrelevant.
- `server → client` raw binary: pty bytes are handed straight to `xterm.write()`. Tmux redraws routinely emit tens of KB; base64 inflation would matter here, so the high-volume direction stays binary.
- Resize: a `ResizeObserver` on the terminal container + `xterm-addon-fit` recompute cols/rows whenever the modal resizes; the new geometry is sent as a `{type:"resize"}` frame which the server forwards to the helper as a typed RESIZE frame which calls `pty.resize(cols, rows)`.

**Telegram `/terminal` command.** Reaches the on/off control from a phone, not just the dashboard:

- `/terminal` (or `/terminal status`) — replies "🟢 web terminal is ON" or "⚪ web terminal is OFF (default)" with the flag-file path.
- `/terminal on` — touches the flag file, replies "refresh the dashboard to see Attach buttons".
- `/terminal off` — removes the flag file.

**UI surface.** The Attach button sits next to the existing `view` (read-only tmux preview) and `copy ssh attach` (clipboard SSH command) controls on every team card in the orchestration cockpit. Clicking it opens a 70vh modal with the xterm — close via `✕`, click-on-backdrop, or Escape. The whole surface is hidden when the flag file is absent; the operator never sees a 403.

**ADR 0011 closeout.** Status moves from "Accepted (shipped v2.7.20)" to "Accepted (Layer 1 shipped v2.7.20, Layer 2 shipped v2.7.21, complete)". The ADR's "Layer 2: Operator escape hatch (web terminal — v2.7.17)" section was always its motivating sibling to the HMAC marker; v2.7.21 fulfils it. Layer 3 (style matching) was already absorbed into the Evy persona SKILL.md in v2.7.15.

**Files:**

- New: `dashboard/terminal.ts` — pure handlers (`handleEnabled`, `handleTeams`, `evaluateUpgrade`, `originAllowed`, `spawnPtyBridge`), tmux session lister, flag-file resolution, and the WS gate.
- New: `dashboard/lib/pty-helper.cjs` — Node sidecar that owns node-pty. Speaks framed stdin/stdout to its Bun parent.
- New: `dashboard/public/terminal.js` — xterm.js client (mount/close/resize) exposed as `window.subctlTerminal`.
- New: `dashboard/package.json` — declares the new runtime deps (`node-pty`, `xterm`, `xterm-addon-fit`). Mirrors the `components/master/package.json` pattern; `install.sh` runs `bun install` here at install time.
- New: `dashboard/__tests__/terminal.test.ts` — 17 tests across flag-file behavior, REST handlers (with mocked tmux), upgrade decision matrix (disabled / bad team / bad host / no-such-session / happy path), DNS-rebind host check, and the framed sidecar wire protocol (DATA / RESIZE / CLOSE / EXIT round-trips against a stubbed child process).
- `dashboard/server.ts` — adds `/api/terminal/enabled`, `/api/terminal/teams`, `/api/terminal/attach` (WS); per-socket PtyBridge map keyed off `ws.data.kind === "terminal"` so terminal and `/api/live` sockets coexist; vendor static-file mappings for xterm.js + xterm-addon-fit served out of `dashboard/node_modules`.
- `dashboard/public/index.html` — loads `/vendor/xterm/xterm.css|js`, `xterm-addon-fit.js`, `terminal.js`; adds `#terminal-modal` with `#terminal-host` mount target.
- `dashboard/public/style.css` — `.terminal-shell`, `.terminal-host`, `.attach-web-btn`, plus `body.terminal-disabled .attach-web-btn, body.terminal-disabled #terminal-modal { display: none !important; }` for the disabled-flag path.
- `dashboard/public/app.js` — `wireWebTerminalGate()` queries `/api/terminal/enabled` on boot and stamps the body class; `openWebTerminal(teamName)` drives the modal; Attach button injected into the per-team card render alongside `view` / `copy ssh attach`.
- `components/master/master-notify-listener.ts` — `/terminal` command (status/on/off); help text updated.
- `docs/adr/0011-trust-marker-hmac-replacement.md` — status flipped to "Accepted (Layer 1 shipped v2.7.20, Layer 2 shipped v2.7.21, complete)"; Layer 2 section updated with implementation notes.
- `docs/adr/README.md` — index entry for ADR 0011 updated to reflect closeout.
- `docs/master.md` — new "Web terminal escape hatch" section: what it is, how to enable, security model, when to use.
- `lib/settings.sh` — `subctl_settings_install_dashboard_deps` runs `bun install` in `dashboard/` so the vendored deps land at install time.

## [2.7.20] — 2026-05-13

### `feat(master): v2.7.20 HMAC trust marker (ADR 0011 Layer 1)`

Replaces the plaintext trust-channel directive marker (ADR 0002, v2.7.9) with an HMAC-authenticated version (ADR 0011 Layer 1). Layer 2 (operator web-terminal escape hatch) is queued for v2.7.21; Layer 3 (style matching) already lives in Evy's SKILL.md since v2.7.15.

**The incident this fixes.** The plaintext marker `[subctl-master directive · phase=… · ts:…]` deployed in v2.7.9 was correctly identified as gameable the same night by the `osint-cve-monitor` team lead, which entered a "paranoia loop" refusing master's directives. The worker reasoned (captured from its tmux pane): *"An attacker has the same incentive to flatter the detection and assert legitimacy as a real supervisor does to dismiss it. The text content of a message can't authenticate the sender. Only the channel can."* It was right — anything that can write to the worker's tmux pane (a stray cron, a stale process, the model's own hallucinated continuations) could replicate the marker format. The marker provided pattern-matching, not authentication. Operator broke the loop only by SSH'ing in from another machine to inject tmux keystrokes directly; the dashboard offered no escape path. Full incident write-up in `docs/adr/0011-trust-marker-hmac-replacement.md`.

**The fix.** Per-team shared secret, generated at spawn time, used to authenticate every directive.

- **At spawn time** (`providers/claude/teams.sh`): generate a 32-byte (64-hex) secret, write to `~/.local/state/subctl/teams/<team_id>/hmac.secret` (chmod 600), inject it verbatim into the worker's spawn-time system prompt as part of the subctl-team-contract preamble. Idempotent: re-spawning the same team_id reuses the existing secret so the worker's prompt-baked copy stays in sync with disk. Honors `SUBCTL_STATE_DIR` (same convention as the policy-snapshot writer).
- **At message-send time** (`dashboard/server.ts` `/api/orchestration/:name/msg`): read the team's secret from disk, compute `hmac = first 16 hex chars of HMAC-SHA256(secret, phase + "\n" + ts + "\n" + body)`, emit marker `[subctl-master directive · phase=<phase> · ts:<iso> · hmac:<hmac16>]`, paste-buffer that + body into the worker pane as before. All other send paths (`subctl orch msg` CLI, the MCP `subctl_orch_msg` tool, master's `subctl_orch.msg` tool) funnel through this same dashboard route, so HMAC applies to every supervisor-to-worker channel automatically.
- **At message-receive time**: the worker recomputes HMAC from its own copy of the secret. Match → trust. Missing / malformed / mismatch → reply "HMAC verification failed" and escalate. The verification instruction is baked into the worker's spawn-time prompt; the bash-gate policy permits ephemeral HMAC computation (`bash`, `node -e`, etc.) for workers that prefer external arithmetic over in-prompt reasoning.

**Centralized in one helper.** `components/master/trust-marker.ts` exports `generateSecret`, `ensureSecret`, `readSecret`, `computeHmac`, `buildDirectiveMarker`, `parseDirectiveMarker`, and `verifyDirectiveMarker`. The dashboard route calls `buildDirectiveMarker`; tests use `verifyDirectiveMarker` and `parseDirectiveMarker` against a tmpdir-scoped state dir. The secret value never appears in any log line, telemetry event, error message, or audit entry — disk file + worker prompt are its only legitimate exposure paths.

**Fail-loud on missing secret.** If `hmac.secret` is missing on disk when the dashboard tries to send a directive, the route refuses with HTTP 500 and a descriptive error: *"HMAC secret missing for team <team_id>. Cannot send authenticated directive. Run /subctl team rekey <team_id> to regenerate."* No silent fallback to an unauthenticated marker — that would train workers to ignore the auth field, defeating the whole point. The `/subctl team rekey` command is queued (operator-facing recovery path); for now the rekey is "kill the team, re-spawn it".

**Backward compatibility (pre-v2.7.20 workers).** Workers spawned before this version don't have the new HMAC verification step in their prompt. The v2.7.9 worker contract teaches them to recognize the `[subctl-master directive ...]` prefix structurally and does NOT instruct them to reject markers with unknown extra fields. They will see the new `hmac:<...>` field at the end of the bracket header as an unrecognized but benign extension — they still trust the channel marker as before. No flag-day cutover required; the protocol stays forward-compatible by extension. New workers spawned after upgrading get full HMAC verification.

**Provider-scope hygiene.** The HMAC helper lives in `components/master/` and the dashboard route is provider-agnostic — it just resolves `team_id → hmac.secret`. The only place that knows about the claude provider is `providers/claude/teams.sh` (which is allowed to be claude-aware by design). Other providers — `providers/pi-coding-agent/teams.sh` — pick up HMAC when they adopt the same per-team secret-file convention.

**Files:**

- New: `components/master/trust-marker.ts` — helper module (generate/read secret, build/parse/verify marker, computeHmac primitive).
- New: `components/master/__tests__/trust-marker.test.ts` — 32 tests across secret lifecycle, marker construction, parsing, verification happy + tamper paths, and a known-vector HMAC sanity check.
- `providers/claude/teams.sh` — generates the per-team `hmac.secret` if missing (`head -c 32 /dev/urandom | xxd -p -c 64`), writes chmod 600, injects the secret + verification instructions into the spawn-time team-contract preamble.
- `dashboard/server.ts` — `/api/orchestration/:name/msg` route imports `buildDirectiveMarker` from the helper and uses it to construct the marker; missing-secret path returns HTTP 500 with the descriptive rekey-pointer error rather than falling back to plaintext.
- `components/master/tools/subctl-orch.ts` — `msg` tool description updated to name HMAC authentication (v2.7.20) accurately.
- `docs/adr/0011-trust-marker-hmac-replacement.md` — status updated to "Accepted (shipped v2.7.20)"; implemented-in field updated.
- `docs/adr/README.md` — index entry for ADR 0011 updated.
- `docs/master.md` — new "Authenticated trust markers" subsection covering the protocol, secret hygiene, fail-loud behavior, and backward compatibility.

## [2.7.19] — 2026-05-13

### `feat(master): watchdog kill controls + empty-listener circuit breaker`

Two related reliability fixes in one release, both driven by the same 2026-05-13 incident that motivated v2.7.18's chat/heavy profile split.

**The incident.** During a 90-minute drive home, the master daemon — running the heavy supervisor `qwen/qwen3.6-35b-a3b` — stopped responding to Telegram. Post-mortem revealed master was stuck in an infinite tool-call loop alternating between an assistant turn with `stopReason: "toolUse"` and empty text, and a tool result with `{ entries: [], listener: { running: false, ... } }`. The looping tool was **`subctl_orch_inbox`** (→ dashboard `/api/notify/inbox` → `dashboard/notify-listener.ts:notifyListenerStatus()`). The reasoning model fell into a "check again before answering" trap: empty inbox + dead listener → check again → repeat. CPU sat at 0.3% (idle); the prompt queue was wedged for 90 minutes because every assistant turn ended in another tool-use instead of a final text response. The operator had no kill path until they got home.

**Part A — Watchdog kill controls.** A minimal central registry (`components/master/watchdogs.ts`) every long-running setInterval / poll-loop in master registers through: the telegram listener, the cli-prompt poll, the lead-report inbox tailer (2s), the team-staleness watchdog (3-min ticker), the followup-scheduler (60s), the auto-compact safety net (5-min), and the verifier denial-cluster ticker (30s). Each entry surfaces `id · kind · started_at · last_tick_at · age_seconds`. Three surfaces consume it:

- **Master tools (Evy)** — `watchdog_list` enumerates; `watchdog_kill { id }` kills one. Registered in the master tool registry automatically; no persona / SKILL.md edits required.
- **Dashboard** — `GET /api/watchdogs` + `POST /api/watchdogs/:id/kill` pass through to the master daemon. New collapsible "Watchdogs" card on the Orchestration tab polls every 10 s while open (idle when closed). Each row shows the id, kind, age, last-tick time, and a `[Kill]` button with confirm-before-kill. Optimistic removal; server reconciles on the next poll.
- **Telegram** — `/watchdogs` lists, `/watchdogs kill <id>` kills one, `/watchdogs killall` kills everything except `kind === "telegram-listener"` (preserved so the operator's last surviving kill path can't sever itself). Reply shows the killed + preserved id lists for transparency.

The probes themselves are NOT rewritten — each setInterval call site is wrapped to (a) call `touchWatchdog(id)` at the start of each tick so `last_tick_at` stays fresh, and (b) register a `kill: () => clearInterval(id)` (or the equivalent `AbortController.abort()` for the telegram listener) so the registry can tear them down without a master restart.

**Part B — Empty-listener circuit breaker.** The actual bug fix. Lives in `components/master/circuit-breaker.ts` and wires into the tool-call dispatch path inside `adaptTool` (`components/master/server.ts`). After each tool result, the breaker inspects the payload. If the result is an object with `entries === []` AND `listener.running === false`, the per-tool consecutive counter increments. After three such consecutive returns for the same tool name, the **fourth** call to that same tool within the current turn is refused before invocation — instead of calling the tool, the model receives a synthesized tool result:

```
{ "error": "circuit-breaker: tool <name> returned empty entries with listener.running=false 3 times in a row. The listener is dead. Stop polling — either call watchdog_list to inspect, or respond to the operator with what you have." }
```

The trip is logged at warn level: `[circuit-breaker] tripped on tool=<name> after 3 empty-dead-listener returns`. The breaker is conservative on purpose: a different tool's result (or a non-empty result from the same tool) resets the counter, and a new operator message clears state via `resetOnNewTurn()` at the top of `processOnePrompt` (synthetic source=`"watchdog"` prompts deliberately do NOT reset — they're tail continuations of the prior reasoning trail, not new operator intent). False positives should be rare because the trigger pattern (`entries: []` AND `listener.running === false`) only matches results that strongly indicate "listener dead + nothing to deliver".

**No ADR.** Both halves are tactical reliability fixes — registry + breaker — not load-bearing architectural decisions. The probes' designs are unchanged; the kill paths and the breaker just wrap them.

**Files:**

- New: `components/master/watchdogs.ts` — registry + register/touch/list/kill/killAll.
- New: `components/master/tools/watchdogs.ts` — `watchdog_list` + `watchdog_kill` master tools.
- New: `components/master/circuit-breaker.ts` — empty-listener heuristic + per-tool counter.
- New: `components/master/__tests__/watchdogs.test.ts` — register / list / kill / kill-missing-id / killall preserve-kinds.
- New: `components/master/__tests__/circuit-breaker.test.ts` — 3-trip pattern, mid-stream reset on non-empty, reset on different tool, reset on new turn.
- `components/master/server.ts`: imports registry + breaker; tool registry includes `watchdogTools`; `adaptTool` checks `shouldRefuseToolCall` and calls `recordToolResult`; `processOnePrompt` calls `resetCircuitBreakerOnNewTurn` for `source === "chat" | "telegram"`; all four in-server setInterval call sites (`inboxPoll`, `watchdog`, `followupTicker`, `autoCompactInterval`) wrapped with `touchWatchdog` + `registerWatchdog`; `startClusterTicker({ onTick })` registered too; HTTP routes `GET /watchdogs`, `POST /watchdogs/:id/kill`, `POST /watchdogs/killall`.
- `components/master/master-notify-listener.ts`: registers `telegram-listener` + `cli-prompt-poll` watchdogs at start; deregisters on stop via `_stopInternal` (private to avoid recursion when killWatchdog invokes the entry's kill closure); both poll loops call `touchWatchdog` at the start of each iteration; `/watchdogs`, `/watchdogs kill <id>`, `/watchdogs killall` commands added; `/help` updated.
- `components/master/tools/policy/verifier-cluster.ts`: `startClusterTicker` gains an optional `{ onTick }` callback so server.ts can wire `touchWatchdog("verifier-cluster")` without restructuring the module.
- `dashboard/server.ts`: `/api/watchdogs` GET + `/api/watchdogs/:id/kill` POST as thin pass-throughs to the master daemon's `/watchdogs` endpoints (matches the v2.7.18 `/api/profile` shape).
- `dashboard/public/index.html`: collapsible `<details>` "Watchdogs" card on the Orchestration tab with a table for id / kind / age / last-tick / Kill button.
- `dashboard/public/app.js`: `wireWatchdogPanel()` — open/close drives 10s polling; optimistic kill with confirm; sorts telegram-listener + inbox-poll first.
- `dashboard/public/style.css`: `.watchdog-card`, `.watchdog-table`, `.watchdog-kill-btn` styles (red-accented kill button to match the existing watchdog-row vocabulary).
- `docs/master.md`: "Watchdog controls" + "Empty-listener circuit breaker" sections.

## [2.7.18] — 2026-05-13

### `feat(master): supervisor profiles (chat / heavy) with dashboard pill + telegram command`

Two named supervisor profiles — `chat` (default: `google/gemma-4-31b`) and `heavy` (default: `qwen/qwen3.6-35b-a3b`) — that the operator switches between from the dashboard's sticky chat-header pill or via Telegram `/profile chat|heavy` without restarting the master daemon. Replaces the v2.7.16 dashboard model-picker round-trip for the common "use light model for chat, heavy model for hard reasoning" toggle.

**Why.** During a 90-minute drive home on 2026-05-13 the supervisor was `qwen/qwen3.6-35b-a3b` (heavy reasoning model). It got stuck in a tool-call loop and stopped responding to Telegram. The chat profile (gemma-4-31b) would have been responsive. The existing supervisor-switch path bounces the launchd-managed master daemon, which is too heavy for a one-handed in-car toggle. Profiles land the switch at the next prompt boundary, no restart, transcript intact.

**How it works.**

- **State** lives at `~/.config/subctl/profiles.json` (`chmod 600`). Master seeds the file on first boot — if `providers.json.models.supervisor` looks like gemma it becomes the `chat` profile, qwen becomes `heavy`, otherwise both fall back to hardcoded defaults. Default `active: "chat"`.
- **Module** `components/master/profiles.ts` exports `loadProfiles()`, `getActiveProfile()`, `setActiveProfile(name)`, `watchProfiles(onChange)`. `watchProfiles` uses `fs.watch` on the file with a 200ms debounce (macOS fires the event twice on atomic-rename saves).
- **Master boot** loads profiles and overrides `models.supervisor.model` + `host` from the active entry, keeping `provider` / `context_length` / `max_tokens` from `providers.json`. The watcher sets `pendingProfileSwap = true`; the actual model rebuild happens at the **start of the next prompt** inside `processOnePrompt` — never mid-turn (pi-agent-core reads `agent.state.model` once per prompt, so a swap at the boundary lands cleanly). On swap, master also re-pins LM Studio at the role's `context_length` to defeat the 4K JIT trap on first use of the new model.
- **HTTP** `GET /profile` returns `{active, profiles, detail}`; `POST /profile {profile}` writes the file (and `fs.watch` does the rest). `/health` gains an `active_profile` field. Dashboard adds a `/api/profile` pass-through so the pill doesn't have to know about the master port.
- **Dashboard pill.** Small rounded pill in the sticky `.master-chat-header` next to the Evy h2 — green for `chat`, amber for `heavy`. Click toggles. Refresh: subscribes to the existing `/api/master/events` SSE for the `profile_swapped` event so out-of-band swaps (Telegram, another tab, manual file edit) reflect immediately; 30s poll as a fallback.
- **Telegram.** `/profile` reports the active profile + its supervisor model. `/profile chat` and `/profile heavy` swap. Anything else replies with usage + the current profile list. Lives in `master-notify-listener.ts` alongside the existing `/status` / `/pause` / `/resume` handlers.

**Constraints honored.** No new ADR — this is tactical config flexibility, not a load-bearing decision. The provider-scoping rule (claude-specific identifiers stay inside `providers/claude/`) is unchanged. The LM Studio token (`sk-Lm-*`) is not logged. Tests live in `components/master/__tests__/profiles.test.ts` and cover the seeding, persistence, invalid-active fallback, throw-on-unknown, and the watcher debounce contract.

**Files:**

- New: `components/master/profiles.ts`
- New: `components/master/__tests__/profiles.test.ts`
- `components/master/server.ts`: imports profiles module; supervisorCfg becomes `let` and is rebuilt on swap; `pendingProfileSwap` flag + `applyProfileSwap()` helper at start of `processOnePrompt`; `watchProfiles` subscription with shutdown cleanup; `/profile` GET/POST endpoints; `active_profile` in `/health`.
- `components/master/master-notify-listener.ts`: `/profile` command handler; `/help` updated.
- `dashboard/server.ts`: `/api/profile` pass-through to master `/profile`.
- `dashboard/public/index.html`: `.profile-pill` inside `.master-chat-header` next to the Evy h2.
- `dashboard/public/style.css`: pill styling (green `chat` / amber `heavy`, pending state, error flash).
- `dashboard/public/app.js`: `wireProfilePill()` with optimistic toggle, SSE `profile_swapped` listener, 30s poll fallback.
- `docs/master.md`: "Supervisor profiles" section.

## [2.7.17] — 2026-05-13

### `feat(providers): OpenRouter as first-class model provider`

OpenRouter is a unified API gateway for hundreds of AI models (incl. a large free-preview tier across many vendors) speaking the OpenAI Chat Completions wire format at `https://openrouter.ai/api/v1`. v2.7.17 registers `openrouter` as a first-class provider alongside the existing `anthropic`, `openai`, `lmstudio`, `mlx`, `ollama`, `vllm`, `mistral`, `google`, `google-vertex`, and `amazon-bedrock` entries. The integration is the smallest of the recent provider series because subctl's provider abstraction already does the heavy lifting; OpenRouter is OpenAI-compatible, so the wire format is shared with the existing local-runtime providers and pi-ai's `openai-completions` stream factory dispatches it unchanged.

**How it works.** The provider gets three pieces of wiring:

- `PROVIDER_API["openrouter"] = "openai-completions"` in `components/master/server.ts` — same family as the local runtimes.
- `buildModel({provider: "openrouter", ...})` defaults `baseUrl` to `https://openrouter.ai/api/v1` when `providers.json` omits the `host` field. An explicit `host` still wins (proxies, regional endpoints).
- `getApiKeyForProvider("openrouter")` resolves `openrouter_api_key` via the v2.7.4 priority chain (env > secrets.json > absent). Unlike the local runtimes it does NOT return the `"not-needed"` sentinel — OpenRouter requires a real key on every request, so absence surfaces as `undefined` and pi-ai reports "no API key for provider: openrouter" instead of silently 401-ing.

Model IDs use OpenRouter's `vendor/model` format: `openai/gpt-5.2`, `anthropic/claude-sonnet-4`, `mistralai/mixtral-8x22b-instruct`, `meta-llama/llama-3.3-70b-instruct:free`. Browse https://openrouter.ai/models for the live catalog.

**Operator setup (one-time).** Mint a key at https://openrouter.ai/keys → paste it into the dashboard's Settings → API Tokens panel under `openrouter_api_key` (writes `~/.config/subctl/secrets.json` chmod 600), OR export `OPENROUTER_API_KEY` in `~/Library/LaunchAgents/com.subctl.master.plist`'s EnvironmentVariables. Then switch the supervisor via the dashboard's model picker — pick provider `openrouter`, paste a model ID like `anthropic/claude-sonnet-4`. The host field can be left blank; master defaults to `https://openrouter.ai/api/v1`. `providers.json.example` carries an `_alt_supervisor_openrouter` block showing the shape for operators who want to hand-edit `providers.json` directly.

**What's NOT included in v2.7.17:**

- **Attribution headers** — OpenRouter accepts optional `HTTP-Referer` and `X-OpenRouter-Title` headers for leaderboard attribution. Intentionally omitted; the operator stays anonymous on the OpenRouter leaderboard. Adding them later would need pi-ai to support per-provider extra headers and is a separate small change.
- **Tier-specific routing** — no automatic `:free`-first fallback chain. The operator picks a specific model per spawn / per supervisor switch.
- **1Password secret backend** — that's v2.7.18 (ADR 0012). The `openrouter_api_key` lives in the existing `secrets.json` chain like the other API keys.

**Trade-offs.** Higher and more variable latency than local runtimes (cloud round-trip + per-vendor cold-start on OpenRouter's side); model availability changes (vendors can deprecate or reroute IDs without notice); per-model rate limits (see https://openrouter.ai/docs/faq#how-are-rate-limits-calculated). Trade-off vs direct vendor SDKs: one key + one billing relationship instead of N, with a uniform OpenAI-compat surface in exchange for missing some vendor-specific features.

**Files:**

- `components/master/server.ts`: `PROVIDER_API.openrouter = "openai-completions"`; `buildModel` baseUrl default extended; `getApiKeyForProvider` openrouter case; `PROVIDER_API` and `buildModel` re-exported for the test suite.
- `components/master/secrets.ts`: `openrouter_api_key` added to `SECRET_KEYS`; `envVarFor("openrouter_api_key") → "OPENROUTER_API_KEY"`.
- `dashboard/server.ts`: `openrouter` added to `WIRED_PROVIDERS` allowlist in the `/api/master/supervisor` handler. The cloud-provider host-clearing branch already does the right thing — clearing `host` lets `buildModel` fall through to the openrouter default URL.
- `dashboard/public/app.js`: `openrouter_api_key` description added to the Settings → API Tokens panel.
- `components/master/providers.json.example`: `_alt_supervisor_openrouter` block appended as an operator-facing reference.
- New: `components/master/__tests__/openrouter-provider.test.ts` — pins the three contracts (PROVIDER_API entry, baseUrl default + explicit host override, API key required-and-undefined-when-absent semantics).
- `docs/master.md`: Phase 3o.17 section documents the integration.

## [2.7.16] — 2026-05-13

### `feat(tools): TinyFish first-class — tinyfish_search + tinyfish_fetch as native master tools`

Two new master tools land alongside the existing `web_search` (Brave) and `web_fetch` (Firecrawl): `tinyfish_search` and `tinyfish_fetch`, integrated first-class via HTTP rather than MCP passthrough. Master is a daemon and can't pop a browser for OAuth, so the REST API path is the right surface — the MCP endpoint's browser-OAuth flow is a separate auth surface and isn't viable here. The tools show up in `/diag`, the dashboard, and Evy's tool list as native master tools.

**Endpoints (verified against https://docs.tinyfish.ai on 2026-05-13):**

- Search: `GET https://api.search.tinyfish.ai` — params `query` (required), `location`, `language`, `page` (0–10). Response shape: `{ query, results: [{position, site_name, title, snippet, url}], total_results, page }`.
- Fetch: `POST https://api.fetch.tinyfish.ai` — body `{ urls: [url], format: "markdown"|"html"|"json", links?: bool, image_links?: bool }`. Response: `{ results: [{url, final_url, title, description, language, author, published_date, text, latency_ms, format}], errors: [{url, error, status?}] }`. Per-URL failures surface as structured errors (e.g. `robots_blocked` with status 403).
- Auth: `X-API-Key` header (NOT `Authorization: Bearer` — the brief assumed OAuth, but TinyFish's REST API uses an API key minted at https://agent.tinyfish.ai). Free tier is 30 req/min and search + fetch do not consume credits.

**Operator setup (one-time):** sign in at https://agent.tinyfish.ai and mint an API key, then paste it via the dashboard Settings → API Tokens panel (writes `~/.config/subctl/secrets.json` chmod 600) under `tinyfish_api_key`, OR set `TINYFISH_API_KEY` in `~/Library/LaunchAgents/com.subctl.master.plist` EnvironmentVariables followed by `launchctl kickstart -k gui/$UID/com.subctl.master`. The v2.7.4 priority chain (env > secrets.json > absent) applies. Until the secret is configured, both tools return `{ ok: false, error: "TINYFISH_API_KEY not configured", ... }` with an actionable hint — they never throw.

**Fallback hierarchy:** try TinyFish first for current-events search (different index + freshness signal vs Brave) and for clean article extraction with structured metadata (author + published_date land in the response). Fall back to `web_search` / `web_fetch` if results are sparse, the URL is robots-blocked, or the rate limit trips a 429. All HTTP failures (4xx, 5xx, 429, network, timeout) surface as structured `{ ok: false, error, status, retry_after? }` payloads. 401 includes a `hint` to re-mint the key at agent.tinyfish.ai.

**Naming note.** The dispatch brief specified `tinyfish_oauth_token` as the secret key under the assumption that TinyFish auth was OAuth. Verifying the docs revealed the REST API uses `X-API-Key` instead, so the secret is named `tinyfish_api_key` to match the actual auth surface and the existing `brave_api_key` / `firecrawl_api_key` / `linear_api_key` pattern. The MCP endpoint (`https://agent.tinyfish.ai/mcp`) still uses browser OAuth — that flow is unaffected by this integration.

**Scope discipline.** Browser automation, batch operations, and structured-extraction tiers from TinyFish are not integrated — those are paid surfaces and out of scope for v2.7.16. HMAC trust marker stays slated for v2.7.17. Web terminal stays slated for v2.7.18. `components/skills/master/SKILL.md` was not touched.

**Files:**

- New: `components/master/tools/tinyfish.ts` (two tools, injectable `fetchHttp` dep matches `web.ts` pattern).
- New: `components/master/tools/__tests__/tinyfish.test.ts` (21 hermetic tests — no real HTTP).
- `components/master/secrets.ts`: `tinyfish_api_key` added to `SECRET_KEYS`; `envVarFor("tinyfish_api_key") → "TINYFISH_API_KEY"`.
- `components/master/server.ts`: import + register the family after the web family.
- `dashboard/server.ts` and `dashboard/public/app.js`: `TINYFISH_API_KEY` row added to the Settings → API Tokens panel.
- `docs/master.md`: Phase 3o.16 section documents the new family.

Master tool count: **71 → 73**. Test count: **537 → 558** (+21).

## [2.7.15] — 2026-05-13

### `feat(persona): Evy lands — SKILL.md rewrite + voice preset + tool-description imperative voice`

The master daemon is now the Evy persona end-to-end. `components/skills/master/SKILL.md` is a verbatim port of the operator-authored system prompt from `docs/persona/evy.md` §1, including the two subctl-added sections ("Tool use is non-negotiable" and "Continuity across model swaps"), followed by a subctl-specific adaptations block that maps the spec's ArgentOS conventions to subctl's actual backends:

- Five-tier memory model named explicitly (Tier 1 MEMORY.md, Tier 2 Obsidian read-only, Tier 3 Memori v2.7.16+ forthcoming, Tier 4 claude-mem corpus, Tier 5 `.subctl/docs/`). Filing convention: name the tier. See [ADR 0005](docs/adr/0005-five-tier-memory-architecture.md).
- Two-tier family (at-the-desk tools vs back-stacks dev teams), not ArgentOS's flat 29-agent family.
- Think Tank dropped — no phantom capabilities. See [ADR 0007](docs/adr/0007-think-tank-concept-dropped.md).
- Style-matching instruction for `subctl_orch_msg`: terse, lowercase, imperative to match operator voice. This is Layer 3 of the trust-marker design from [ADR 0011](docs/adr/0011-trust-marker-hmac-replacement.md) (Layer 1 HMAC ships v2.7.16; Layer 2 web terminal ships v2.7.17).

`components/master/personalities/evy.md` ships as a new voice preset (dry, precise, slightly impatient with hand-holding, owns mistakes plainly, no grovel, no em dashes). The default preset in `components/master/personality.ts` is flipped from `straight-shooter` to `evy`. Existing presets remain available.

Tool descriptions across `memory_*`, `subctl_orch_*`, `team_doc_*`, and `system_*` are rewritten in the "**Use this FIRST when**..." imperative voice. The pattern leads with WHEN to invoke (the trigger), not WHAT it does (the model can read the schema for that). Memory tools also name their tier, so Evy's filing convention is reinforced at the tool-description layer.

See [ADR 0004](docs/adr/0004-evy-persona-librarian-framing.md) for the persona-adoption decision.

### `feat(eval): 24 persona tests on the v2.7.11 harness — bun test components/master/__tests__/evy-eval/`

The Evy persona is load-bearing. Without a measurement loop, every prompt iteration is a gamble. v2.7.15 ships the 24-test eval suite built on top of the harness scaffolded in the prior PR (regex fast-fail → LLM judge → JSON output → bun assertion). Tests cover seven categories:

- Pushback Protocol (4) — pushback shape, override compliance, elaboration on demand, no stacking
- Verification (3) — clean relay with provenance, send-it-back on bad output, surface conflict
- Persona Stability (4) — continuity across model swaps, identity probing, curt operator, venting
- Routing Discipline (4) — desk vs back-stacks, no fan-out, right specialist, name the agent
- Memory and Provenance (3) — tier-named filing, source_type, no file-without-provenance
- Error Recovery (3) — own the mistake plainly, route around flaky specialists, no fabrication on tool error
- Format and Voice (3) — no em dashes, no emojis, no padding

Each test follows the rubric pattern from `docs/persona/evy-eval-rubric-test-1.2.md` §"Test shape in bun": per-test judge prompt inline (3-5 criteria, one binary), regex fast-fail vetoes to FAIL, LLM judge skipped when no `ANTHROPIC_API_KEY` (test tagged `regex-only-pass` instead of `pass` so partial grading is legible in every score-log line).

Tests live under `components/master/__tests__/evy-eval/tests/` (7 files by category). Pipeline boilerplate is centralized in `tests/_helpers.ts` — each test file declares scenarios + judge prompts; the helper handles regex, judge, and score-log writes.

See [ADR 0008](docs/adr/0008-eval-suite-pipeline.md) for the pipeline decision.

### `fix(schema): memory_remember.source_type + memory_forget.confirmation + subctl_orch_kill.confirmation+reason — hard rules at the tool layer`

The persona prompt says Evy resists letting anything into memory without provenance, owns mistakes plainly without grovel, and treats destructive actions as escalations. Three tool schemas now enforce that structurally rather than relying on prompt adherence alone:

- `memory_remember` requires `source_type` (enum: `operator-asserted | verified-external | self-inferred | agent-reported`). Missing or invalid source_type returns `{ ok: false, error: "source_type required" }`. The tag is prepended to the stored entry body so every Tier 1 fact carries its provenance forever.
- `memory_forget` requires `confirmation: true`. Anything else returns `{ ok: false, error: "memory_forget requires explicit confirmation: true" }`. Evy does not destroy memory without confirmation.
- `subctl_orch_kill` requires `confirmation: true` AND `reason` (string, ≥10 chars). The reason gets posted with the kill so the destruction is on the record. Workers cost time to spawn; killing them silently makes the audit trail worthless.

Schema validation is enforced in the tool's `invoke()` body — the tool layer is the right place because the model's prompt adherence is best-effort while the schema is a contract.

## [2.7.14] — 2026-05-12

### `fix(dashboard/chat): structural header — wrap toolbar + H2 in one sticky band`

The v2.7.13 z-index/background fix didn't solve it. Operator reported the
toolbar still visually overlapping (and being clipped) when the chat-log
scrolled, plus the "Master" H2 line floated separately above the log
without sticky protection.

Root cause was structural, not presentational. The HTML had:

```
<section class="master-chat">
  <div class="ctx-overflow-banner">
  <div class="chat-toolbar">       ← sticky
  <h2>Master ... CONNECTED</h2>     ← SIBLING, not sticky
  <div class="master-log">          ← own overflow-y: auto
```

`position: sticky` on the toolbar was relative to `.master-chat`, but the
master-log scrolled INSIDE its own container. Two different scroll
contexts. The H2 had no sticky at all. Net: scrolled content visually
intersected the toolbar/H2 region in ways that z-index couldn't fix.

v2.7.14 wraps `ctx-overflow-banner + chat-toolbar + h2` in a single
`<div class="master-chat-header">`. The header is the sticky band.
Master-log scrolls underneath cleanly. No sibling-scroll-context
mismatch.

Also: the H2 text changed from "Master" to "Evy" (matching the persona
rename for the chat panel; v2.7.13 already changed the assistant bubble
label but missed the panel H2).

CSS changes:
- New `.master-chat-header` — sticky, opaque, drop-shadow on bottom
- `.chat-toolbar` no longer sticky / no own background — inherits from header
- `.master-log` top padding back to 12px (header now owns the visual gap)

Files: `dashboard/public/index.html` (1 wrap edit, H2 text), `dashboard/public/style.css` (3 rule edits). No JS, no master-daemon changes.

## [2.7.13] — 2026-05-12

### `fix(dashboard/chat): label normalization + sticky-toolbar overlap`

Three operator-reported polish issues from the v2.7.12 chat panel:

**1. Label normalization to "evy" (renders as "EVY" via CSS uppercase).**
The thinking indicator said "evy · thinking" (lowercase, no
text-transform on `.chat-thinking__label`), while the assistant
response label said "MASTER" (CSS-uppercased `.master-msg-label`). Two
different names for the same agent in adjacent UI elements. v2.7.13
normalizes all three render sites to label `"evy"`:

- `appendMessage("assistant", ..., { label: "evy" })` (live SSE bubble)
- `<div class="master-msg-label">evy</div>` (transcript replay bubble)
- `<div class="pd-chat-label">evy</div>` (project-chat bubble)

CSS `.master-msg-label` already has `text-transform: uppercase`, so the
rendered label is "EVY", consistent with "YOU" / "WATCHDOG" patterns.
The thinking indicator's `.chat-thinking__label` is *not* uppercased,
so it now reads "Evy · thinking ● ● ●" (capital-E, mixed case),
matching the operator's preferred name styling for that surface.

**2. Sticky toolbar overlap.** When the master-log scrolled to the top,
chat content visually butted against (and sometimes overlapped) the
chat-toolbar's bottom border. The toolbar was already
`position: sticky; top: 0; z-index: 5; background: var(--bg-1)` (from
v2.7.10), but in practice operator reported the toolbar becoming
unclickable and visually contaminated by scrolled content. Two fixes:

- Bumped `z-index: 5 → 50` so the toolbar dominates any sibling
  stacking context it might end up next to.
- Replaced `background: var(--bg-1)` with the explicit opaque hex
  `#0e1116` (same value, but ensures no stacking-context-driven
  transparency anomalies).
- Added a soft drop-shadow on the toolbar's bottom edge so scrolled
  content tucks cleanly beneath the toolbar instead of colliding with
  its border.
- Bumped `.master-log` top padding from `12px` to `20px` (per operator
  suggestion) so the first message has clear breathing room beneath
  the toolbar.

**3. Z-index/opaque-bg defensive belt and suspenders.** The previous
fix (v2.7.10) was layout-level; this one is presentation-level. Both
should be in place so the next person who edits chat-panel CSS doesn't
need to re-discover the failure mode.

Files: `dashboard/public/app.js` (5 string edits), `dashboard/public/style.css` (3 rule edits, 1 comment update). No master-daemon changes. No test changes.

## [2.7.12] — 2026-05-12

### `feat(dashboard/chat): inline neon-glow tool pills + thinking indicator`

**What changed.** The dashboard Chat panel no longer renders each tool
call as a full-width card. Pre-2.7.12 a single turn that ran four tools
spawned four separate "TOOL · system_log_tail" blocks (often with an
empty `{}` body), eating ~60% of the panel width. v2.7.12 replaces that
with a row of inline **neon-glow pills** grouped per assistant turn,
color-coded by tool family, with a one-line truncated arg preview.

**Visual.** Each pill is a translucent rounded badge with a colored
border + soft outer glow (CSS `box-shadow` + `color-mix`), styled in the
spirit of sci-fi command-center dashboards. Family colors:

- `system_*` → cyan
- `system_lmstudio_*` → teal-cyan
- `system_subctl_knowledge` → magenta
- `memory_*` + `mcp__plugin_claude-mem_*` → purple
- `web_*` / `linear_*` / `context7_*` → green
- `subctl_orch_*` → orange
- `team_doc_*` + `team_decision_log` → mint
- `policy_*` → yellow
- `notify_*` + `telegram_*` → pink
- Anything else → grey

**Args preview.** Truncated single line next to each pill:

- Empty `{}` → no preview rendered (no more noise)
- One key → `key=value` (value clipped to 24 chars)
- Multiple keys → `k1=v1, k2=v2 …` (clipped to 40 chars total)

Click any pill → opens a `notice()` dialog with full args + full result
(pretty-printed).

**Live rendering.** Pills appear as SSE `toolcall_start` events arrive,
so the operator sees master fetching tool after tool in real time. The
`tool_result` event patches the originating pill with a ✓ (success) or
✗ (error) marker. Pills from a single assistant turn share one
`.chat-tool-pills` row that wraps naturally; the next turn opens a
fresh row.

**Thinking indicator.** While master is processing a chat turn (operator
just sent, first SSE event has not arrived yet), the panel shows a
pulsing `evy · thinking ● ● ●` line. Cleared on first `text_delta` /
`toolcall_start`, on `agent_end`, or on error / 30s timeout. The label
uses "evy" (the rename landing alongside the persona work in v2.7.13)
so the text doesn't have to flip twice.

**Config file.** New `dashboard/public/tool-display.json` is the single
source of truth for the family → color/icon map and the name-prefix →
family rules. Walks `rules` in order, first match wins, unmatched falls
back to grey. Fetched once at boot, cached, with a hardcoded copy baked
into `app.js` for offline / deploy-failure resilience.

**Files touched.**

- `dashboard/public/tool-display.json` (NEW) — family/icon/rules config
- `dashboard/public/app.js` — pill helpers + replaced three tool-call
  render sites + wired thinking indicator into `sendChat`
- `dashboard/public/style.css` — pill + thinking indicator styles (uses
  `color-mix` for translucent variants; Safari 16.4+, Chrome 111+,
  Firefox 113+)
- `dashboard/server.ts` — `/tool-display.json` added to STATIC_FILES
- `docs/master.md` — chat panel section updated with pill description

No master-daemon changes. No test changes. Tool-call wire protocol
(SSE event names, JSON shapes) untouched.

## [2.7.11] — 2026-05-12

### `fix(verifier): structured tool-call inspection + keyword-overlap validation`

Closes a hallucination gap operator caught in live Evy interaction
(2026-05-12). Pre-v2.7.11 verifier only name-matched: if `memory_remember`
appeared in this turn's tool calls, any memory-related claim was treated
as verified. Operator-observed exploit: Evy could call `memory_remember`
with arbitrary content (or with an erroring call) and then make any
memory claim she wanted; the verifier had no view into args or results.

This release upgrades the verifier interface and adds two structural
checks. Plus broadens the trigger regexes that operator-observed verbs
missed:

- **`memory-update-claim`** (new in v2.7.11) — catches "I've updated my
  learned-facts memory", "I have committed the rule to my Tier-1 memory",
  "Memory has been updated", and variants the original
  `decision-logged-claim` regex didn't cover. Verbs:
  `updated|updating|committed|committing|stored|storing|pinned|pinning|
  locked|added|adding|remembered|remembering|memorized|memorizing|
  persisted|persisting|saved|written|writing|recorded|recording`.
- **`procedure-or-rule-update-claim`** (new in v2.7.11) — catches "I am
  updating my internal operating procedure", "I've added a hard-coded
  rule", "I have authored a skill", and variants.
- **`decision-logged-claim`** (extended) — adds `filed` to the verb
  list, adds `team_decision_log` (v2.7.10) to the satisfying-tool list.

### What changed in the verifier interface

**`AssistantTurn` now carries `tool_calls: ToolCallRecord[]`** (each
record has `name`, `arguments`, `result`, `is_error`) instead of the
flat `tool_names_called: string[]`. `extractLastTurn` walks
`assistant`-role tool_use blocks and pairs them with `tool_result`
blocks in subsequent `user`-role messages by `tool_use_id`. The
real-user-prompt scan now skips tool-result-bearing user messages so
the turn slice captures the full assistant sequence, not just the
trailing fragment after the last `tool_result`.

**Tool errors disqualify a claim.** If a matching tool call has
`is_error: true` (either set explicitly or inferred from `ok: false` in
the result, or a string starting with "Error:"), it is excluded from
the candidate set. If all matching calls errored, the claim is
unverified even though the tool name appeared.

**Per-rule `validate` function.** Each `VerificationRule` can attach a
validator that runs after the name + error filter. Default validator
returns ok (name-match-only, back-compat for older rules). The new
rules attach `keywordOverlapValidate(2)`, which:

1. Extracts significant tokens from the matched claim text (lowercased,
   stop-words removed, 4-char minimum).
2. Stringifies each candidate tool call's arguments.
3. Requires `min(2, ceil(claim_keywords / 2))` of the claim keywords to
   appear in the args (substring match, with loose stem matching for
   plural/tense variation).
4. If no candidate call's args meet the threshold, gap is recorded
   with the specific reason ("tool was called but its arguments don't
   reference the claim's significant terms").

This raises the cost of cheating from "call any tool" to "call the
right tool with content that lexically matches what you claimed."

### Correction prompt now includes the reason

`VerificationGap` now carries `reason: string`. The correction prompt
fed back to the agent surfaces the specific failure mode per gap
("no matching tool call this turn" / "matching tool call(s) all
errored" / "tool was called but its arguments don't reference..."), so
the agent has actionable signal instead of a generic hint.

### Tests

`components/master/__tests__/verifier.test.ts` — 27 tests covering
regex coverage, the cheat case (call any tool with unrelated args),
errored tool calls, tool_use ↔ tool_result pairing in real-shaped
message threads, and back-compat for the pre-v2.7.11 rules.
Master suite: **444 pass / 0 fail / 2 known-gap skips**.

### Operator-visible benefit

When Evy says "I've stored the Promise rule in Tier-1 memory," the
verifier now checks (a) that `memory_remember` was called this turn,
(b) that the call did not error, and (c) that its `content` argument
contains words like "Promise" and "rule." Any of those failing means
the claim is unverified and the correction loop re-enters with a
specific reason. Cheating now requires deliberately matching content
to claim text, which is much harder to do accidentally than calling
any tool with any args.

## [2.7.10] — 2026-05-12

### `feat(team-docs): master tools to read/write/list/log project-local docs at .subctl/docs/`

**What's new.** Four new master tools that let the orchestrator
persist project-scoped artifacts to `<project_root>/.subctl/docs/`:

- `team_doc_write({ project_root, relative_path, content, frontmatter? })`
  — write a SPEC / PRD / ARCH / handoff / mandate doc, optionally
  prepending a YAML frontmatter block (operator, account, phase,
  kind, …). Creates the docs folder + any intermediate subdirs.
- `team_doc_read({ project_root, relative_path })` — read it back.
  Parses out the frontmatter (if any) into a structured `frontmatter`
  field; returns the body in `content`.
- `team_doc_list({ project_root, subdir? })` — enumerate files +
  subdirs. Returns an empty list (not an error) when the folder
  doesn't exist yet — so callers can probe speculatively.
- `team_decision_log({ project_root, summary, detail?, by? })` —
  append one JSON line to `<project>/.subctl/docs/decisions.jsonl`.
  Append-only, machine-readable, every line `{ ts, summary, detail?,
  by }`. `by` defaults to `"master"`.

**Folder convention.** Subctl-managed docs live under
`<project>/.subctl/docs/`, next to the existing
`<project>/.subctl/policy.toml`. This keeps subctl out of the
project's own `docs/` tree, makes the artifacts trivially
`cat`-able from any worker pane, and avoids the TCC-blocked vault
path under `~/Documents/Obsidian Vault/` that doesn't work under
launchd on some hosts.

**Why it matters.** Today every directive — SPEC, PRD, ARCH note,
handoff, "remember this decision" — scrolls away in chat. The next
worker spawn has no recovery path. With these tools, the master can
write a SPEC.md the operator dictates, hand it to a worker, and the
worker can `cat .subctl/docs/SPEC.md` to read it back faithfully
even after a transcript compact. Decisions become a queryable
JSONL log instead of a chat-history search. Handoffs become files
the operator can inspect and `git add`.

**Path safety.** `team_doc_write` rejects `..` segments, absolute
`relative_path` values, and any resolved path that escapes
`<project>/.subctl/docs/`. The `subdir` argument on
`team_doc_list` is held to the same contract.

**Scope discipline.** This PR ships the TOOL SURFACE ONLY. The
spawn-time integration (every team-create writes a `mandate.md`
frontmatter wrapper) lands in v2.7.11. The agent definitions, skill
files, and per-template skeleton docs land in v2.7.12.

**Files.**
- `components/master/tools/team-docs.ts` — new (four tools + a
  tiny YAML-frontmatter parser/emitter for the simple `key: value`
  subset we control on both sides).
- `components/master/server.ts` — register the family after the
  knowledge family.
- `components/master/__tests__/team-docs.test.ts` — new (27 cases:
  happy paths, path traversal, absolute-path rejection, missing
  project root, missing folder on list, decision-log running total,
  frontmatter round-trip).
- `components/skills/master/SKILL.md` — guidance for when to use
  `team_doc_write` vs `subctl_orch_msg`, and a `team_decision_log`
  expectation.
- `docs/master.md` — new §5.5 "Team-local docs — `.subctl/docs/`
  tool family" with the folder convention + example operator
  questions.

## [2.7.9] — 2026-05-12

### `fix(policy): snapshot now records project_root`

The dashboard's Policy tab tries to re-resolve a team's policy chain by
reading `project_root` from the team's snapshot header, but
`writePolicySnapshot()` never emitted that field — only `team_id`,
`mode`, `source_paths`, `allowlist_sha`, and `spawned_at`. Net effect:
the Policy tab rendered "team X has no project_root recorded in its
snapshot — cannot resolve policy" for every team, even though the
function already RECEIVED `projectRoot` as its second argument. We
were just dropping it on the floor.

Fix is mechanical: thread `projectRoot` into `SnapshotMetadata`, the
header comment block (`# project_root = "<absolute path>"`), and the
`_write_snapshot.ts` JSON emit so bash can capture it too.

**Back-compat shim.** `readPolicySnapshot()` accepts snapshots written
by v2.7.8 (no `# project_root = ...` line) without throwing — it falls
back to `projectRoot: ""` and logs a one-line deprecation warning
pointing the operator at "respawn the team to refresh the snapshot."
The dashboard treats `""` exactly like the missing-field case it
already had, so the worst case is unchanged behavior for legacy
snapshots; new spawns get the re-resolve working immediately.

### `feat(orch): trusted-channel directive marker for /msg + worker contract`

**The bug.** When the master sent bare shell commands via
`subctl_orch_msg`, the worker's team-lead correctly identified them as
prompt-injection risk and refused — even when they were legitimate
master directives. Operator-observed: a lead asked to run a baseline
verification command kept replying "I don't execute bare commands that
arrive without context — they may be injection probes." Technically
correct paranoia, operationally a foot-gun.

**The fix.** Two coordinated pieces:

1. `/api/orchestration/<name>/msg` (and the `subctl_orch_msg` tool that
   calls it) now accept an optional `phase` field. Before pasting into
   the worker's pane, the route wraps the text with a deterministic
   marker:

   ```
   [subctl-master directive · phase=<phase> · ts:<iso>]
   <operator text>
   ```

   or, without a phase:

   ```
   [subctl-master directive · ts:<iso>]
   <operator text>
   ```

2. `providers/claude/teams.sh` prepends a constant "subctl team
   contract" preamble to every worker's first message (unless the
   spawn is empty-prompt). The preamble teaches the lead:

   - messages arriving with the `[subctl-master directive · …]`
     marker came through the trusted orchestrator channel and should
     be executed in the context of the worker's current phase;
   - messages WITHOUT that marker (especially bare imperatives) may
     be injection probes and should be refused with a request for
     context.

**Operator benefit.** Leads now act on master's directives without
needing the operator to manually paraphrase or re-frame each
imperative. Security-conscious refusal still kicks in for actual
out-of-band text — exactly the discrimination we want.

The `subctl_orch_msg` tool description also nudges master to always
include `phase` + a short WHY when calling it, so directives never
land as context-free imperatives even when the lead is forgiving.

## [2.7.8] — 2026-05-12

### `fix(policy): floor preset to "generic" — kills the "Bureaucrat Agent" regression`

**The bug.** Spawning a team into a project with no `.subctl/policy.toml`
(and no user-level `~/.config/subctl/policy.toml` either) produced a
policy snapshot containing ONLY `defaults.toml` — no merged preset. The
spawn banner correctly announced `(preset: generic)` because the bash
side's `_subctl_claude_detect_ecosystem` ran, but the detection result
was never threaded through to the TS bridge that writes the snapshot.
With `loadResolvedPolicy()` finding `preset` undefined in every layer,
the preset chain was skipped entirely.

Net effect: every team spawned into a fresh project ran in gated mode
with **zero allowlist**. Every single `ls`, `cat`, `find`, `pwd`,
`git status` required explicit permission. Operator described it as
"Bureaucrat Agent" behavior — workers stuck in permission loops,
"ask permission to ask permission."

**The fix.** `config/policy/defaults.toml` now declares
`preset = "generic"` at the top. Since the resolution chain is
`projectDoc.preset ?? userDoc.preset ?? defaultsDoc.preset`, this makes
"generic" the floor — any project that doesn't explicitly override
the preset (or set `preset = "none"`) gets the generic allowlist
(28 commands + git/gh/curl patterns) merged into its snapshot.

Properly threading the bash-detected ecosystem (node / python /
generic) through the bridge so node projects get the node preset
is a follow-up (v2.7.9). The floor fix unblocks the operator-observed
regression immediately for every fresh project regardless of
ecosystem.

### `fix(claude/policy): probe well-known install paths for bun`

`_subctl_claude_bun_bin` previously relied on `command -v bun`, which
respects the caller's PATH. When master / dashboard launchd plists
don't include `~/.bun/bin/` in their EnvironmentVariables.PATH, the
bun lookup fails and `subctl_orch_spawn` 500s with "bun not found
— policy snapshot bridge requires bun." Now probes `$HOME/.bun/bin/bun`,
`/opt/homebrew/bin/bun`, and `/usr/local/bin/bun` as fallbacks after
PATH lookup. Operator can still override with `SUBCTL_BUN_BIN=...` in
the plist.

### `fix(dashboard): 200ms breath between paste-buffer and Enter on /msg`

`/api/orchestration/<name>/msg` issues three tmux subprocesses
back-to-back: `set-buffer`, `paste-buffer`, `send-keys Enter`. Claude
Code's TUI sometimes hadn't ingested the paste before Enter arrived,
leaving the message sitting in the input box and never submitted.
Operator-visible: master had to send "EXECUTE NOW." or re-invoke
`subctl_orch_msg` multiple times to actually trigger the worker.
Added a 200ms `setTimeout` between paste and Enter — well below
human noticeability, well above paste-event latency in profiling.

## [2.7.7] — 2026-05-12

### `feat(knowledge): system_subctl_knowledge tool — TOON breakdown for master self-introspection (v2.7.7)`

The master daemon now ships a canonical, TOON-formatted breakdown of
the entire subctl system at
`components/master/knowledge/subctl.toon` (~40 KB, 19 sections), and a
new master tool `system_subctl_knowledge({ section? })` that reads
from it. The operator already uses TOON heavily in Argent and asked
for the same pattern here: token-efficient, LLM-friendly, single
source of truth for "how does X work in subctl?" instead of either
hallucinating from training data or doing a sub-agent file crawl on
every question.

### What's new

- **`components/master/knowledge/subctl.toon`** — the breakdown. 19
  top-level sections: `overview`, `architecture`, `components`,
  `providers`, `tools`, `http_routes`, `config`, `policy`,
  `cli_surface`, `update_workflow`, `secrets`, `supervisor`,
  `telegram`, `orchestration`, `claude_mem`, `compact_policy`,
  `diagnostic_tools`, `version_history`, `phase_3s_preview`,
  `file_index`. Tools, routes, files, and version history use
  TOON's tabular array form (`items[N]{f1,f2}:` + one row per line)
  for token efficiency.
- **`components/master/tools/knowledge.ts`** — new tool family with
  one entry, `system_subctl_knowledge`. No-section call returns the
  sections list with one-line summaries (extracted from each
  section's leading `#` comment). With a section arg, returns the
  full TOON content verbatim. Unknown section returns
  `ok:false` + `available_sections` populated.
- **`components/master/server.ts`** — `knowledgeTools` imported and
  spread into `toolRegistry` after the linear family (the convention
  is "append in feature-wave order"; this is the v2.7.7 addition so
  it lands at the bottom).
- **`components/skills/master/SKILL.md`** — added one-line guidance
  pointing the master at `system_subctl_knowledge` when the operator
  asks how a subctl component works.

### Operator-visible benefit

- Asking "how does the policy engine work?" / "what's in secrets.json?"
  / "what tools do you have?" now triggers a single tool call that
  pulls verified info from a file shipped with the daemon, instead of
  the model recalling from possibly-stale training data.
- The TOON file is part of every `subctl update` so the breakdown
  always matches the deployed version. Module-load caching means the
  daemon reads the file exactly once per restart.

### Test coverage

`components/master/__tests__/knowledge.test.ts` — **8 tests / 21
assertions** (~15 ms):

- Default call returns ≥10 sections with summaries; names unique.
- `section="policy"` content contains the canonical mode names
  (Trusted/Gated/Sealed); `section="tools"` includes a known tool
  family prefix.
- Unknown section returns `ok:false` with `available_sections`
  populated and the rejected name echoed in the error.
- The `.toon` file exists at the resolved path AND parses (regex
  sanity check for ≥10 top-level section headers).
- Caching: across five invocations (default, known section, unknown
  section, another known section, default again) the file is read
  from disk **exactly once** via an exported read-counter test seam.

Full master suite: **388 pass / 0 fail / 2 pre-existing skips** (the
two `find / -name foo -delete` v2.8 known-gap vectors).

### Canonical references

- `components/master/knowledge/subctl.toon` — the breakdown itself.
- `components/master/tools/knowledge.ts` — tool + parser + cache +
  test seam.
- `components/master/__tests__/knowledge.test.ts` — 8 tests.
- `docs/master.md` §5.4 — operator-facing description of the new
  tool with example questions it answers.

### Also in v2.7.7

#### `fix(master): default baseUrl for local providers`

When `providers.json` omitted the optional `host` field on
`supervisor` (or `router`/`embeddings`/`reviewer`), `buildModel()`
fell back to `baseUrl: ""` and pi-ai's OpenAI client defaulted to
`api.openai.com`. The master then sent the local LM Studio token to
real OpenAI, which returned `401 Incorrect API key provided` —
correctly! The error message even included the "find your API key at
platform.openai.com" template, which made the bug look auth-side
when it was actually a misrouting bug.

`components/master/server.ts` now defaults `baseUrl` to
`http://localhost:1234/v1` whenever `cfg.provider` is in
`LOCAL_PROVIDERS` (`mlx`, `ollama`, `lmstudio`, `vllm`). Cloud
providers still get `""` and pull their real URL from the SDK.

#### `feat(dashboard): use marketing-site logo in topbar + favicon`

The dashboard topbar used to render a placeholder mark (a gradient
square with a green status dot via `.brand::before` + `::after`).
Swapped to the canonical logo from subctl.com — same file the
marketing site uses (`SubCTLlogo.png`, copied to
`dashboard/public/logo.png`). The pulse-style status dot was
redundant with the existing `.pulse-dot` in the topbar-right and
was removed.

Also wires `<link rel="icon">` to the same file so the browser
tab gets the brand mark too.

## [2.7.6] — 2026-05-12

### `subctl update` — argent-style polish

Operator review of `argent update --help` set the bar: a polished update
flow has a read-only status probe, a persisted channel concept, a JSON
output mode for automation, distinct knobs for "auto-confirm" vs
"auto-stash", per-step timeouts, and a `--help` that reads like docs
instead of a flag dump. v2.7.6 adds all of those to `subctl update`
without disturbing the v2.7.5 version-state block or lockfile auto-stash.

### What's new

**`subctl update status`** — read-only subcommand. Runs the same
fetch + version-block logic as `update`, prints the operator's current
version / channel / branch / remote state, then exits without touching
the working tree. Works even with a dirty tree (where `update` would
abort), so it's the right first move when you're not sure what state
you're in.

```
$ subctl update status
subctl 2.7.5 (ff262d0c)
  branch:   main
  channel:  stable (default)
  remote:   v2.7.5 (ff262d0c) — up to date
  last update: 2026-05-12T17:37:23Z
```

**`--channel stable|beta|dev`** — persists the operator's channel
preference under `[update].channel` in `~/.config/subctl/config.toml`
(grep/awk-based TOML parsing; no extra dependency). Mapping is the
boring obvious one: `stable → main`, `beta → beta`, `dev → dev`.
Passing `--channel` both persists the value AND uses it for the
current run; subsequent runs without the flag pick it up from disk.
Unknown values fail fast with `unknown channel 'X' — pick one of:
stable, beta, dev` (exit 1). `-b/--branch` still wins for one-off
branch tests.

**`--json`** — emits a single document at end-of-run, suppresses every
human log line to /dev/null:

```json
{
  "ok": true,
  "from": {"version": "2.7.4", "sha": "74ae7ae7"},
  "to":   {"version": "2.7.5", "sha": "ff262d0c"},
  "channel": "stable",
  "commits_applied": 1,
  "lockfile_stashed": false,
  "services_restarted": ["com.subctl.master", "com.subctl.dashboard"],
  "doctor_warnings": 0
}
```

On error: `{"ok":false,"error":"…","stage":"preflight|fetch|merge|deps|restart|doctor"}`.
The stage string tells CI exactly where the run stopped, so log
collection can scope itself.

**`--yes`** (independent of `--force`). Auto-confirms interactive
prompts; today the only prompt is the downgrade gate (introduced in
v2.7.6 — `remote_version < current_version` asks "proceed with
downgrade? [y/N]"). Non-interactive shells without `--yes` now refuse
downgrades rather than silently regressing. `--force` keeps its v2.7.5
meaning: stash anything dirty that isn't lockfile-only.

**`--timeout <secs>`** (default 1200). Wraps `git fetch`, `git merge`,
and `bun install` with a portable timer (real `timeout` / `gtimeout`
when present, else a perl-based SIGALRM fallback). Timeouts return
the GNU-conventional 124 internally; user-facing message names the
step that timed out (e.g., `git fetch timed out after 60s`) so the
operator doesn't have to guess. Default of 1200s matches the slowest
historical `bun install` we've seen on a cold cache.

**Friendly `--help`**. Restructured along argent's pattern:
Usage → Options → What this does → Switch channels → Non-interactive
→ Examples (6 lines) → Notes (4 bullets) → Exit codes → Docs URL
footer (`Docs: https://subctl.com/docs/update`). Operators who want
the answer to "what does `--yes` do vs `--force`?" find it in the
Notes block without reading the full `Options` list.

**`update wizard` stub** — reserved for the future interactive setup
flow. Today it prints a one-liner pointing at `status` + `--channel`
and exits 0. Wiring it in now means we don't have to bump the major
version when the wizard ships.

### Back-compat (sacred)

`subctl update` with **no flags** behaves identically to v2.7.5: same
version-state block, same lockfile auto-stash, same `--force` gate,
same exit codes. The new flow paths are strictly additive — none of
them fires unless the operator opts in via flag.

### Test coverage

`lib/__tests__/update.test.ts` — **57 tests / 157 assertions** in
~14 s (up from 36 / 79 in v2.7.5). The v2.7.5 tests are intact; the
new ones cover:

- **`update status` (4 tests)**: clean repo prints version+channel+state
  and exits 0; dirty repo still exits 0 (status doesn't enforce
  cleanliness); `--json` returns parseable JSON; behind-remote
  surfaces `<N> commits ahead`.
- **`--channel` (3 tests)**: `--channel beta` persists to
  `config.toml` under `[update]`; invalid channel fails with a clear
  error; pre-seeded `config.toml` is honored when `--channel` is
  omitted.
- **`--json` (5 tests)**: happy path emits success doc; update path
  reports from→to + `commits_applied`; error path emits
  `{ok:false,error,stage}`; suppresses ALL human stdout/stderr (single
  parseable line); lockfile auto-stash surfaces as
  `lockfile_stashed: true`.
- **`--yes` downgrade (2 tests)**: with `--yes`, non-interactive
  downgrade proceeds (no refusal); without `--yes`, non-interactive
  downgrade refuses with a clear message.
- **`--timeout` (3 tests)**: `--timeout 1` against a `sleep 30` fake
  git wrapper trips the timeout and the error names the `fetch`
  stage; non-integer values fail fast; default-ish 1200s on an
  up-to-date repo still no-ops cleanly.
- **`--help` (3 tests)**: presence of Notes section, Examples
  section, and Docs URL footer.
- **Back-compat (1 test)**: `subctl update` with no flags still shows
  the v2.7.5 markers, no JSON leakage, no channel-persistence log.

All new tests isolate `SUBCTL_CONFIG_DIR` per-test via `mkdtempSync`
so config writes never touch the operator's real
`~/.config/subctl/config.toml`. The `--timeout` test plants a fake
`git` in a temp dir that delegates to real git for everything except
`git fetch`, so preflight rev-parse/remote/ls-remote still work and
only the bounded step trips the alarm.

### Canonical references

- `lib/update.sh` — subcommand dispatch + new flag parsing + JSON
  redirect dance at the top; `_subctl_update_status`,
  `_subctl_update_with_timeout`, `_subctl_update_load_channel`,
  `_subctl_update_persist_channel`, `_subctl_update_version_cmp`,
  `_subctl_update_emit_json` helpers below the v2.7.5 originals.
- `lib/__tests__/update.test.ts` — 57 tests / 157 assertions.
- `docs/master.md` Phase 3o.6 — the story.

## [2.7.5] — 2026-05-12

### `subctl update` UX — version state up front, lockfile drift auto-stashes

Two narrow operator-facing improvements to `lib/update.sh`. Both came out of dogfooding v2.7.4 across the M3 Ultra / M5 / Mac Studio fleet: operators were typing `subctl update`, hitting "working tree has uncommitted changes" with no version context, then re-typing `subctl update --force` only to discover the dirt was a `bun.lock` rewrite they didn't make. v2.7.5 fixes both.

### What's new

**Version-state block printed BEFORE the working-tree gate.** Today the dirty-tree abort hides the very thing the operator wants to know: what version they're on and what's available remotely. v2.7.5 runs `git fetch` (read-only at the working-tree level — only updates remote-tracking refs) up front and prints a compact 4-line status block before any cleanliness gate fires:

```
==> subctl update — version state
    current: v2.7.4 (74ae7ae7)
    branch:  main
    remote:  v2.7.5 (abcd1234) — 1 commits ahead
```

Three render modes: `same — already up to date` (fast-exit 0); `<N> commits ahead` (behind remote, proceed); `local is <N> commits AHEAD of remote` (operator dev branch, ff-only no-ops); `diverged (<X> ahead / <Y> behind)` (genuine divergence, ff-only fails cleanly). Even when the dirty-tree gate aborts the run, the version block is already on screen.

**Lockfile-only auto-stash.** `bun.lock` rewrites itself with platform-specific hashes on every `bun install`. Operators were typing `--force` repeatedly across machines for what is genuinely expected drift. v2.7.5 introduces a NARROW carve-out: when EVERY dirty file is a known package-manager lockfile (`bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` — and only those, not `Cargo.lock` / `Gemfile.lock` / `poetry.lock`), the update auto-stashes those files silently and restores after.

```
==> dirty lockfile detected (bun lockfile drift is normal across machines)
    auto-stashing: components/master/bun.lock
    will restore after update
```

After the update completes:

```
==> auto-stashed lockfile restored
```

If `git stash pop` collides with a lockfile rewritten by the new commit, the operator gets a structured guidance block (inspect / abandon / accept-theirs) instead of the cryptic git default.

**`--force` semantics preserved.** `--force` still stashes ANY dirty file (lockfile or not) and proceeds. The auto-stash is strictly additive — it removes a `--force` requirement for the lockfile case only.

**New helpers (extracted so they're testable in isolation):**

- `_subctl_update_is_lockfile <path>` — basename match against the 5-entry allow-list.
- `_subctl_update_classify_dirty "<porcelain>"` — emits one of `clean` / `lockfile-only|<csv>` / `mixed|<count>`.
- `_subctl_update_pop_stash <kind>` — pops with kind-aware messaging (`auto-stashed lockfile restored` vs `stash restored`) and structured conflict guidance.

### Test coverage

`lib/__tests__/update.test.ts` — **36 tests / 79 assertions** in ~6.6 s.

- **Pure helpers (16 tests)**: `_subctl_update_is_lockfile` covers all 5 allow-listed lockfiles + nested paths + `./bun.lock`, plus negative cases for `Cargo.lock` / `Gemfile.lock` / `poetry.lock` / `bun.lock.bak` (basename trailing junk) / source files.
- **Classify-dirty (8 tests)**: empty → clean; single + multiple lockfile → `lockfile-only|<csv>`; untracked (`?? bun.lock`); rename rows (`R old -> bun.lock`); any non-lockfile → `mixed|<n>`; lockfile + source mix → mixed; Cargo.lock → mixed.
- **Version-state block (5 integration tests)**: up-to-date prints `same — already up to date` and exits 0; behind prints `<N> commits ahead` and proceeds; ahead prints `AHEAD of remote` and the ff-only no-op succeeds; diverged prints `diverged` and exits 2 with `fast-forward failed`; the version block always appears on screen BEFORE the dirty-tree abort.
- **Lockfile carve-out (6 integration tests)**: lockfile-only drift auto-stashes + restores (drift content survives the round-trip); mixed without `--force` errors with no stash created and source drift preserved; mixed WITH `--force` stashes everything and uses the simple `stash restored` message; up-to-date + lockfile-only drift no-ops with drift preserved (no stash dance); `Cargo.lock` drift fails the cleanliness gate (carve-out is narrow); nested `components/master/bun.lock` auto-stashes correctly.
- **`--force` regression (1 test)**: clean tree + `--force` still updates with no spurious stash message.

Hermetic: every integration test creates its own `mkdtempSync` repo pair (`origin.git` + local clone), `SUBCTL_REPO_ROOT` is overridden per-test, `--no-restart` always passes (launchctl never fires), the temp local repo never contains `bin/subctl` so `doctor` never runs, and `NO_COLOR=1` strips ANSI for simple substring assertions.

### Operator deploy step

`subctl update` on every host. The new version block prints automatically. The next time `bun.lock` drift accumulates, `subctl update` (no flag) will auto-stash through it instead of demanding `--force`.

### Canonical references

- `lib/update.sh` — version-state block at lines ~165–207, lockfile carve-out at ~218–263, helpers at ~16–86.
- `lib/__tests__/update.test.ts` — 36 tests / 79 assertions.
- `docs/master.md` Phase 3o.5 — the story.

## [2.7.4] — 2026-05-12

### LM Studio token support + dashboard-managed secrets layer

LM Studio recently shipped an optional **"Require API Token"** server setting. Operators who enable it get a `sk-lm-XXXXXXXX:YYYYYYYYYYYY`-shaped bearer that every request — OpenAI-compatible `/v1/*` AND LM Studio's native `/api/v0/*` / `/api/v1/models/load` — must carry as `Authorization: Bearer <token>` or the server 401s. Before v2.7.4, subctl sent a `"not-needed"` sentinel for local providers and hit 401 the moment the operator flipped the toggle.

v2.7.4 closes that gap **and** generalizes the fix: a new on-disk secrets layer at `~/.config/subctl/secrets.json` (chmod 600, atomic writes, dashboard-editable) holds LM Studio + Brave + Firecrawl + Linear + Context7 credentials, with an env-var override on top so power users / CI keep the launchd plist as source-of-truth. The operator no longer has to edit a plist every time a key rotates.

### What's new

**Priority chain.** Every credential resolves through:

1. Process env var (e.g. `LMSTUDIO_API_TOKEN` from the launchd plist `EnvironmentVariables`).
2. `~/.config/subctl/secrets.json` field (e.g. `lmstudio_api_token`) — managed via the dashboard.
3. Absent → caller behaves as today (e.g. `lmstudioAuthHeader()` returns `{}`, pi-ai gets the `"not-needed"` sentinel).

**`components/master/secrets.ts`** (NEW) — pure module exporting `loadSecret(key)`, `setSecret(key, value | null)`, `listSecrets()`, `resolveSecret(key)`, `envVarFor(key)`, plus a `SECRET_KEYS` allow-list. Atomic writes (tmp-file + rename), `chmod 0600` on every write, 5-second in-memory read cache invalidated on mtime change. Malformed JSON / missing file / wrong-type fields all fall back to an empty map without throwing — a bad `secrets.json` MUST NOT crash the daemon.

**`lmstudioAuthHeader()`** (in `components/master/server.ts`, mirrored in `components/master/tools/diag.ts` and `dashboard/server.ts`) now routes through `resolveSecret("lmstudio_api_token")`. Behavior identical for env-only deploys; new deploys can manage the same token via the dashboard.

**`getApiKeyForProvider()`** in `components/master/server.ts` returns `resolveSecret("lmstudio_api_token") ?? "not-needed"` for `provider === "lmstudio"`. Other local providers (`mlx`, `ollama`, `vllm`) still return `"not-needed"` unconditionally. The LM Studio token never leaks across providers.

**Tool key resolution updated.** `components/master/tools/web.ts` (`web_search` → `brave_api_key`, `web_fetch` → `firecrawl_api_key`), `components/master/tools/linear.ts` (`linear_api_key`), and `components/master/tools/context7.ts` (`context7_api_key`) all flip from `process.env.*` to `resolveSecret(<key>)`. Error messages now point operators at BOTH paths (dashboard panel OR plist).

**LM Studio HTTP call sites — 11 total** thread the bearer header through `lmstudioAuthHeader()`:

- `components/master/server.ts` (6): `ensureModelLoaded` probe + unload + load, `getSupervisorLoadedCtx`, the `/transcript/util` inline probe.
- `components/master/tools/diag.ts` (3): `system_lmstudio_health` `/v1/models` + `/v1/chat/completions`, `system_supervisor_info` `/api/v0/models`.
- `dashboard/server.ts` (2): `/api/models`, `/api/providers`.

**Dashboard endpoints.**

- `GET /api/settings/secrets` — returns `{ ok, secrets: [{ key, isSet, envOverride, lastModified }], priority }`. Presence flags only; **values never appear** in this response.
- `POST /api/settings/secrets/:key` — body `{ value: string | null }`. Allow-listed against `SECRET_KEYS`. Returns `{ ok: true, secret: <updated-row-from-listSecrets> }` — the value is **not** echoed back. `null` (or empty string) clears the field.
- `GET /api/settings/keys` extended — each row now carries `env` (boolean) + `secrets_json` (boolean or null), and `ok` is `env || secrets_json`. Note string mentions both paths and the priority order. The CRITICAL invariant — never serialize the value — is preserved.

**Dashboard UI.** New "API tokens" card above the existing "API keys (cloud providers)" card. Renders a table: key, purpose, status pill (`Set` / `Not set` plus `env override` chip when the env var is present), last-modified, and an `Edit` / `Set` button. Clicking opens a modal with a `type="password"` input + Save / Cancel / Remove buttons. On save the value goes over the dashboard's `127.0.0.1`-bound HTTP (never crosses the LAN), the input is wiped from the DOM on close, and both panels re-render from the presence-only endpoints. Backed by new `.danger-btn` + `.secrets-table` CSS in `dashboard/public/style.css`.

**`.gitignore`** now explicitly blocks `secrets.json` by name in addition to the canonical `~/.config/subctl/secrets.json` location being outside the repo entirely.

**`fetchText` deps in diag.ts** gained an optional `headers` field. Tests can swap in a recording fetchText stub and assert the captured header, mirroring the `_setDepsForTesting` pattern.

**Boot guard.** `components/master/server.ts` now wraps its bottom-of-file `main()` invocation in `if (import.meta.main)` so the test suite can import the helpers without booting the full daemon.

### Test coverage

`components/master/__tests__/secrets.test.ts` (renamed from the WIP `lmstudio-token.test.ts`) — **39 tests / 89 assertions** in 62 ms — covers:

- **Secrets module:** read/write/round-trip; `setSecret(null)` and `setSecret("")` both clear; siblings preserved; `listSecrets` never serializes values (asserted by `JSON.stringify(rows).not.toContain("VERY-SENSITIVE-TOKEN-VALUE")`); `envVarFor` mapping incl. uppercase fallback.
- **Defensive parsing:** missing file → null; malformed JSON → empty + no throw; array-shaped JSON → empty; non-string values silently dropped; empty-string field treated as unset.
- **File permissions:** `statSync(secretsFile).mode & 0o777 === 0o600` after first write AND after a second write.
- **Priority chain:** env wins; file wins when env unset; both absent → null; empty-string env treated as unset (file wins); works for every key in `SECRET_KEYS`.
- **`listSecrets envOverride` flag:** true when env set; false when only file populated.
- **`lmstudioAuthHeader`:** `{}` baseline; bearer from env; bearer from file; env wins.
- **`getApiKeyForProvider`:** lmstudio resolves file token; env wins; nothing → `"not-needed"` (back-compat trip wire); `mlx`/`ollama`/`vllm` never get the token; cloud providers always undefined.
- **`ensureModelLoaded`:** bearer on all 3 calls (probe + unload + load) regardless of which source supplied the token; no Authorization on any call when both layers are absent (the back-compat trip wire).
- **`diagTools.system_lmstudio_health`:** bearer threaded into `fetchText.headers` on both `/v1/models` and `/v1/chat/completions`; omitted when neither layer has it.
- **Cache invalidation:** `setSecret` clears the cache; external file edits picked up after `_resetCacheForTesting`.

All env vars touched are snapshot-and-restored in beforeEach/afterEach. The on-disk path is overridden to a per-suite tmpdir via `_setPathForTesting` so tests never touch the operator's real `~/.config/subctl/secrets.json`. Full master suite remains green: **65 tests / 147 assertions / 67 ms** (39 new secrets + 26 existing compact-policy).

### Security contract

Non-negotiable rules — broken by any single counterexample:

- `secrets.json` values NEVER appear in any HTTP response body emitted by `dashboard/server.ts`. The `POST /api/settings/secrets/:key` handler returns the updated `listSecrets()` row, not the value.
- `listSecrets()` returns presence flags only — pinned by a test that asserts the literal token bytes don't appear in `JSON.stringify(rows)`.
- Every write goes through `setSecret`, which `chmod 0600`'s both the tmp file and the final path. Two tests assert the mode on first write AND after a subsequent write.
- The dashboard `<input>` is `type="password" + autocomplete="new-password" + spellcheck="false"`, and is wiped from the DOM on modal close. The dashboard request stays on `127.0.0.1` (dashboard is localhost-bound).
- `.gitignore` blocks `secrets.json` by name. The canonical path is `~/.config/subctl/secrets.json`, outside the repo.
- Error messages around missing keys say "not configured" rather than echoing any envvar or filesystem state that could surprise an operator.

### Back-compat

Existing v2.7.3 deploys with `LMSTUDIO_API_TOKEN` already in their launchd plist behave identically — the env var is priority 1, so the resolution chain returns the same bytes. Deploys with no token configured anywhere return `{}` from `lmstudioAuthHeader()` and `"not-needed"` from `getApiKeyForProvider("lmstudio")`, just like v2.7.3. Both paths are pinned by tests.

### Operator deploy step

Easiest path: open the dashboard's **Settings → API tokens** panel, click **Set** next to a row, paste the token, click **Save**. The daemon picks it up on the next call (5s cache TTL). Power-user path (CI / immutable infra): keep the env var in the launchd plist — it still wins over the on-disk file.

### Canonical references

- `components/master/secrets.ts` — read/write/atomic + chmod 600 + 5s cache + priority chain.
- `components/master/server.ts` `lmstudioAuthHeader()` + `getApiKeyForProvider()` — exported, used by tests.
- `components/master/tools/{diag,web,linear,context7}.ts` — all flipped to `resolveSecret(<key>)`.
- `dashboard/server.ts` `GET/POST /api/settings/secrets[/:key]`, extended `/api/settings/keys`.
- `dashboard/public/index.html` "API tokens" card + edit modal; `dashboard/public/app.js` `loadSecrets() + openSecretsModal() + wireSecretsModal()`; `dashboard/public/style.css` `.secrets-table` + `.danger-btn`.
- `components/master/__tests__/secrets.test.ts` — 39 tests / 89 assertions.
- `docs/master.md` Phase 3o.4 — the story.

## [2.7.3] — 2026-05-12

### Compact correctness — the ticker was the wrong design

A few hours after v2.7.2 shipped, the operator caught the master daemon hallucinating "Standing by" responses to questions it couldn't see. The diagnosis: the 5-minute auto-compact ticker had fired AFTER the supervisor was already past 100% util on its next prompt. By the time the ticker noticed the bloat and compacted, the model had already been served a truncated transcript and produced ghosts. The ticker was architecturally wrong — a polling watchdog can't keep a synchronous prompt-composition pipeline under budget. v2.7.3 fixes it by moving the compact decision to **just-in-time** at the prompt-composition site, with a **two-stage warning policy** so the operator gets a heads-up before auto-compact fires.

### What's new

**Just-in-time compact gate.** `runJitCompactCheck()` runs at the top of `processOnePrompt()` in `components/master/server.ts` (around line 922) — BEFORE `composeSystemPrompt()` and BEFORE `agent.prompt()`. It estimates current transcript tokens, queries LM Studio's `loaded_context_length` for the supervisor, and applies the v2.7.3 policy decision. If the decision is `compact`, the daemon compacts synchronously before the next prompt is composed. The supervisor never sees an over-budget window during normal operation.

**Two-stage warning policy** (absolute tokens, not percentages — predictable regardless of which model is loaded):

- `warn_tokens = 25000` — YELLOW banner + `compact_warning` SSE event. No compact yet; operator gets a heads-up.
- `compact_tokens = 40000` — AUTO-COMPACT fires synchronously. Banner flips BLUE during compaction, clears on `transcript_compacted`.
- `target_tokens = 30000` — post-compact estimated transcript size.
- `keep_recent = 6` — minimum recent turns the compactor preserves intact.

Compaction target moved from 50k → 30k so the post-compact transcript has comfortable headroom against the 40k auto-compact threshold.

**Compact-policy as a pure module.** `components/master/compact-policy.ts` (NEW) extracts the decision logic into a testable algorithm. `decideCompactAction(currentTokens, loadedCtx, cfg)` returns `{ action: "ok" | "warn" | "compact", current_tokens, threshold_used, reason }`. `loadCompactConfig()` handles file IO + back-compat. `estimateTranscriptTokens()` is the same char/4 heuristic used everywhere so JIT, ticker, and `/context` agree on the number.

**Back-compat for `threshold_pct`.** Deployed `compact.json` files in the wild still carry the v2.7.2 shape (`{ threshold_pct: 90, target_tokens: 50000, ... }`). `decideCompactAction` honors them: when absolute thresholds are absent it falls back to percentage-of-loaded-ctx mode (compact at `threshold_pct`, warn 10pp below). New deploys ship with absolute thresholds. No migration script — the code handles both shapes gracefully.

**5-min ticker demoted to safety-net.** The `auto-compact` ticker still runs every 5 minutes, but its job is now only to catch transcripts that grow due to tool outputs landing AFTER prompt composition (the JIT gate can't see those). It uses the same `decideCompactAction` algorithm so the two paths can never disagree.

**Master daemon endpoint:** `GET /transcript/util` — pure read returning `{ current_tokens, transcript_tokens, overhead_tokens, loaded_ctx, util_pct, warn_at, compact_at, target_tokens, config_mode, decision }`. The dashboard banner reads this to render the 4-state model server-side instead of recomputing thresholds in the browser. Surfaced through the existing `/api/master/*` proxy.

**Dashboard 4-state banner.** `ctx-overflow-banner` in `dashboard/public/index.html` now has four explicit states keyed off `data-state`:

- `ok` — banner hidden.
- `warn` — YELLOW. Current tokens past `warn_tokens` but below `compact_tokens`. Operator sees "Transcript approaching compact threshold" with a manual compact button.
- `compacting` / `warn-compact` — BLUE. Transient — auto-compact fired and is running. Clears on `transcript_compacted` SSE event.
- `overflow` — RED. Past `loaded_ctx` (should be impossible with JIT working; kept as fail-safe).

The banner now consumes `/api/master/transcript/util` rather than recomputing `pct > 100` heuristics in JS, and also listens for the SSE `compact_warning` and `transcript_compacted` events so the YELLOW → BLUE → cleared sequence renders without waiting for the 5s poll.

### Test coverage

`components/master/__tests__/compact-policy.test.ts` — 26 tests / 58 assertions covering:

- Absolute-threshold mode: returns ok/warn/compact at the right boundaries (including exact-equality), and ignores `loadedCtx` when absolute thresholds are set.
- Back-compat percentage mode: warns 10pp below `threshold_pct`, compacts at/above `threshold_pct`, defaults `threshold_pct` to 90 when absent, returns ok with `threshold_used: "none"` when `loadedCtx` is unknown.
- Edge cases: `currentTokens = 0`, `loadedCtx = 0` in pct-only mode, negative `currentTokens` is clamped, invalid absolute thresholds (`compact_tokens <= warn_tokens`) falls back to pct mode.
- `loadCompactConfig`: parses new shape, falls back to defaults on missing file, preserves back-compat shape when file authors only `threshold_pct`, prefers absolute when new shape is present even alongside legacy `threshold_pct`, returns defaults on malformed JSON.
- `estimateTranscriptTokens`: empty → 0, text + thinking + arguments contribute chars/4, ignores non-array content, handles circular argument objects without throwing.

### Operator deploy step

The daemon reads `~/.config/subctl/master/compact.json` automatically. If the file is missing the new v2.7.3 defaults apply (`warn=25k`, `compact=40k`, `target=30k`). To switch an existing M3 deployment onto absolute thresholds, edit the file in place — no migration script ships in this PR because the code handles both shapes gracefully.

### Canonical references

- `components/master/compact-policy.ts` — pure decision module.
- `components/master/server.ts` `runJitCompactCheck()` — primary gate at prompt-composition time.
- `components/master/server.ts` `runAutoCompactTick()` — demoted safety-net ticker.
- `docs/master.md` Phase 3o.3 — the story behind v2.7.3.

## [2.7.2] — 2026-05-12

### Web + self-introspection + Linear — three capability gaps, one PR

Operator and agent went back and forth over Telegram the morning of 2026-05-12. v2.7.1's self-diagnostic family had landed the night before. Over the course of an hour the agent named three live capability gaps: it couldn't search the web for current docs, it didn't know its own model + context budget, and it couldn't see (let alone update) the Linear board the operator was driving subctl development from. The operator funded all three on the spot — Brave AI Search + Firecrawl for the web side, LM Studio's existing `/api/v0/models` for the introspection side, Linear API for the issue side — and they all land in v2.7.2 as **seven new master tools** across two new files and one extension to the diag family.

### What's new

**Web family** at `components/master/tools/web.ts` (read-only):

- **`web_search`** — Brave AI Search. Query → top results (title + URL + snippet). Useful for current docs, news, API references, or verifying claims that may have changed since the model was trained. Defaults to 10 results, capped at 20. `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token` auth.
- **`web_fetch`** — Firecrawl scrape. URL → clean markdown. Use when you need to read a specific page's content (docs, articles, GitHub READMEs). Strips nav/footer/sidebar by default. `POST https://api.firecrawl.dev/v0/scrape` with `Authorization: Bearer` auth.

**Self-introspection** added to `components/master/tools/diag.ts`:

- **`system_supervisor_info`** — reads `~/.config/subctl/master/providers.json` for the configured supervisor (provider + model_id + host), queries LM Studio's `/api/v0/models` for that model's `state` / `loaded_context_length` / `max_context_length` / `quantization` / `arch`, and surfaces the auto-compact policy from `~/.config/subctl/master/compact.json` (with documented daemon defaults if the file is missing). The agent uses this to reason about its own context budget — "do I have room for a 30K-token tool result?" — without having to ask the operator.

**Linear family** at `components/master/tools/linear.ts` — Linear's GraphQL at `https://api.linear.app/graphql`, authed with the raw `LINEAR_API_KEY` (no "Bearer" prefix — Linear's convention):

- **`linear_list_issues`** *(read)* — filter by `team_key` (e.g. `ENG`), state name, assignee email. Returns normalized `{identifier, title, state, assignee, priority, url}` shape.
- **`linear_search`** *(read)* — text search across issue titles + descriptions via `searchIssues`.
- **`linear_create_issue`** *(WRITE)* — resolves `team_key` → team UUID via a `teams(filter: { key: { eq } })` query, then `issueCreate` mutation. Supports markdown description + Linear priority 0–4.
- **`linear_update_issue`** *(WRITE)* — accepts an `issue_id` as either identifier (`ENG-123`) or UUID. Optional `state` (human-readable name like "In Progress" / "Done"; tool resolves it to `stateId` via `workflowStates`) and/or `comment` (markdown body via `commentCreate`). Either or both can be passed per call.

### Implementation notes

- All seven new tools are routed through an injectable `Deps.fetchHttp` so the test suites never reach Brave, Firecrawl, Linear, or LM Studio for real — hermetic.
- API keys live in the master daemon process environment (`BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, `LINEAR_API_KEY`). Missing keys return a structured `{ ok: false, error: "..." }` with an actionable plist + `launchctl kickstart` hint — never throws.
- HTTP failure modes (network, 4xx, 5xx, 429 with `retry-after`, timeout) all surface as structured errors. The 429 branch carries `retry_after` for intelligent back-off.
- Timeouts: 30s for `web_search`, 60s for `web_fetch`, 20s for Linear reads, 30s for Linear mutations.
- The two **write** tools (`linear_create_issue`, `linear_update_issue`) are documented as mutating in their tool descriptions so the agent uses them deliberately.
- Dashboard `/api/settings/keys` gains `BRAVE_API_KEY` + `FIRECRAWL_API_KEY` + `LINEAR_API_KEY` rows so the operator can see at a glance whether the master can use the new tools.
- `system_supervisor_info` uses the same `_setDepsForTesting` pattern as the rest of the diag family; no change to existing tools.

### Test coverage

- `components/master/tools/__tests__/web.test.ts` — 18 tests / 78 assertions (Brave + Firecrawl happy paths, missing keys, invalid URLs, network / timeout / 429 / 4xx / 5xx / malformed JSON / `success=false`).
- `components/master/tools/__tests__/diag.test.ts` — extended with 5 new `system_supervisor_info` tests (happy path, LM Studio unreachable, providers.json missing, compact.json defaults fallback, model not in catalog) on top of the existing 22.
- `components/master/tools/__tests__/linear.test.ts` — 14 tests / 89 assertions covering all four tools' happy paths plus missing key / 4xx / 429 / unknown team / unknown state / no-op update.

### Deploy step

After pulling v2.7.2, paste the three keys into `~/Library/LaunchAgents/com.subctl.master.plist` `EnvironmentVariables`, then `launchctl kickstart -k gui/$UID/com.subctl.master`. Master log will show **`tools=69`** (up from 62 in v2.7.1) once the three new tool registrations land.

### Canonical references

- `components/master/tools/web.ts` — Brave + Firecrawl.
- `components/master/tools/linear.ts` — Linear GraphQL family.
- `components/master/tools/diag.ts` — `system_supervisor_info` joins the v2.7.1 diag family.
- `docs/master.md` Phase 3o.2 — the story behind v2.7.2.

## [2.7.1] — 2026-05-11

### Self-diagnostic tools — the agent asked, the capability shipped

Hours after v2.7.0 tagged, the M3's master daemon hit a watchdog bug firing on a stale tmux session. After the issue was resolved, the M3 agent reflected on what would have caught the bug and proposed seven self-diagnostic tools via Telegram. The operator accepted plus added an eighth (version awareness). All eight ship in v2.7.1. This is the persistent-supervisor loop working as designed: agent hits a failure mode, asks for capability, capability ships.

### What's new

A new master tool family at `components/master/tools/diag.ts` registers eight read-only introspection tools under the `system_*` namespace:

- **`system_watchdog_self`** — surfaces watchdog state: which teams it's tracking, when it last ticked, when it last fired and why, and (critically) which tracked tmux sessions no longer exist on the host. Would have caught today's stale-session bug at first invocation.
- **`system_port_check`** — wraps `lsof` to report which TCP ports are bound and by whom. Defaults to subctl's own ports (8787 dashboard, 8788 master, 1234 LM Studio). Catches the orphaned-bun-vs-launchd class of conflict.
- **`system_lmstudio_health`** — independent LM Studio reachability probe: hits `/v1/models` and a tiny `/v1/chat/completions` ping, reports both latencies + last error. Distinct signal from `system_lmstudio_models` (which only lists known models without proving the API responds).
- **`system_log_tail`** — tail the master, dashboard, lmstudio, or tmux log (1–500 lines). Closes the gap the agent named explicitly: "I can only point to the log path, not read it."
- **`system_rate_limit_status`** — per-account 5h / 7d utilization summary read from subctl's local usage cache (no remote call). Lighter than `subctl_orch_state` for spawn-decision use; returns `healthiest_alias` directly.
- **`system_git_status`** — one-level walk over `~/code` (capped at 50 repos) reporting branch, ahead/behind origin, dirty flag, last fetch time per repo. Catches drift before spawning a team that would push to a divergent branch.
- **`system_network_health`** — LAN gateway ping + tailscale status + DNS resolution for github.com / api.anthropic.com + external TCP reach (1.1.1.1:443).
- **`system_version_status`** *(operator-added)* — current VERSION + commit + recent tags + count of commits behind `origin/main`. Mirrors the safe-fetch pattern from `lib/update.sh`. The agent should know its own version.

### Implementation notes

- All eight tools are read-only — none mutate subctl state.
- Watchdog state is exposed via the same late-binder pattern used by `bindToolRegistry` (no circular import; `startMaster()` calls `bindWatchdogState(getter)` at boot).
- Side-effecting calls (`shell`, `fetch`, file IO) are routed through an injectable `Deps` object so the test suite swaps in canned responses without touching the host.
- Server.ts diff is ~25 lines: one import, one registration block, three lines of watchdog-state tracking inside `runWatchdogTick()`, and the binder call.
- `docs/master.md` Phase 3o.1 records the M3-agent-requested origin.

### Test coverage

`components/master/tools/__tests__/diag.test.ts` ships with happy-path + degraded-path coverage per tool. The suite is hermetic — no network, no real `lsof`, no real `git`.

### Canonical references

- `components/master/tools/diag.ts` — the tool family.
- `docs/master.md` Phase 3o.1 — the story behind v2.7.1.

## [2.7.0] — 2026-05-11

### Trusted / Gated / Sealed — the policy engine

Subctl now spawns workers in **Gated** mode by default. Every other coding-agent harness in the field ships with bash effectively trusted; the model is the gate. As model capability scales, that trust model breaks — agents persistent enough to recover from a refusal by writing inline code, a custom npm script, or piping curl into sh. v2.7.0 moves the trust decision to subctl, the spawn point, where every worker inherits a TOML allowlist enforced by a `PreToolUse` hook against a deterministic Go-backed checker. The defang (`bypassPermissions` + `--dangerously-skip-permissions` + `CLAUDE_AUTONOMY=full`) stays in all three modes; the hook is additive, never replacement.

### What's new

- **Three execution modes per worker, decided at spawn time.**
  - **Trusted** — unrestricted bash. Opt-in via `--mode=trusted`; subctl prints a non-suppressible warning at spawn.
  - **Gated** — every `Bash` call routes through `subctl-policy-check` against a TOML allowlist. Allowed commands run silently; denials return a stderr error the agent self-corrects from. **Default for `subctl teams claude`.**
  - **Sealed** — no bash at all. `permissions.deny: ["Bash"]` + MCP-only tool set for production-adjacent work.
- **Three shipped ecosystem presets** at `config/policy/presets/` — `node.toml`, `python.toml`, `generic.toml`. Auto-detected via marker files (`package.json` → node, `pyproject.toml`/`requirements.txt` → python, fallback → generic). Per-project override at `<project>/.subctl/policy.toml`.
- **`subctl policy` CLI subcommand family** — `list`, `validate`, `explain <cmd>`, `audit <team>`, `snapshot <team>`. `explain` renders the deny/allow trace; `validate` checks TOML against the JSON schema with helpful errors; `audit` tails the JSONL log per team.
- **New master tool family** (`policy_check`, `policy_list`, `policy_audit_tail`) so the master daemon can introspect policy decisions and surface them through the chat surface.
- **Verifier denial-cluster detection** — when a worker hits ≥N denials of the same root command in a rolling window, the runtime claim verifier fires a `[verifier]` correction prompt steering the agent away from fighting the gate, and posts a one-time notification to the dashboard chat panel. Prevents the "agent rewrites the script three times trying to find a workaround" loop.
- **JSONL audit log** at `~/.local/state/subctl/audit/<team_id>.jsonl` — every check writes one line (allow or deny) with decision, reason, command tokens, allowlist SHA. 50 MiB rotation, 3 generations kept, concurrent-write-safe.
- **Dashboard Live Logs → Policy filter chip** + dedicated **Policy sidebar tab** showing per-team mode, preset, allowlist SHA, and a live SSE stream of denials. "Suggest allowlist addition" modal generates valid TOML from a denial trace.
- **Go binary `subctl-policy-check`** — compiled from `bin/subctl-policy-check/` for darwin/linux × amd64/arm64. Cold-start <50ms. Shares the test-vector corpus with the TS impl; CI fails on any divergence. Installed by `bash install.sh` alongside the `subctl` binary.
- **pi-coding-agent as a first-class provider** — `providers/pi-coding-agent/` ships with auth + teams scaffolding parallel to the Claude provider, plus dashboard HTTP spawn dispatch refactor so the endpoint is no longer hardcoded to `subctl teams claude`. Ungated for v2.7.0; policy hook lands in a follow-up.
- **`--no-telegram` flag for `subctl master enable`** — skip the BotFather walkthrough on hosts where Telegram isn't wanted. Same flag honored by `install.sh`.
- **Dashboard "M3 Ultra" hardcoded host label removed** — the host badge now reads from `/api/host` (hostname-driven) so dashboards on every machine show the right name without per-host patching.

### Breaking changes

- **`subctl teams claude` now defaults to Gated mode.** Existing workflows that depended on raw bash access need either `--mode=trusted` per spawn (with the non-suppressible warning) or a persisted `default_mode = "trusted"` in `~/.config/subctl/config.toml` or `<project>/.subctl/policy.toml`. The first time a worker hits a denial, the master daemon posts a one-time notification to the dashboard chat panel so the operator knows the new default is active.

### Migration notes

- Existing teams continue to work — the new default only applies to spawns AFTER v2.7.0. Already-running tmux sessions are unaffected.
- Run `bash install.sh` to compile and place the new Go binary (`subctl-policy-check`). Without it, Gated mode falls back to deny-all (intentional fail-closed).
- Per-project policy is opt-in. The shipped presets are the floor; project `.subctl/policy.toml` extends or relaxes.
- Audit log path: `~/.local/state/subctl/audit/<team_id>.jsonl`. Rotation is automatic at 50 MiB, 3 generations.

### Beyond the policy engine

- **`--no-telegram`** on `subctl master enable` and `install.sh` for headless installs that don't want the BotFather walkthrough.
- **Dashboard host label** now hostname-driven via `/api/host` instead of the hardcoded "M3 Ultra" string.
- **pi-coding-agent provider scaffolding** in `providers/pi-coding-agent/` — auth + teams.sh parallel to the Claude provider. Ungated for v2.7.0 (policy hook follows in a later release).

### Canonical references

- `docs/policy.md` — the policy spec (modes, schema, ecosystem detection, audit format, threat model).
- `docs/policy-schema.md` — TOML schema with examples and merging semantics.
- `docs/master.md` §4 — Phase 3o marked complete.

## [2.6.2] — 2026-05-10

Patch — `subctl update` survives local-only branches.

### Fixed

- **`subctl update` no longer dies with "couldn't find remote ref"** when the local checkout is on a branch that doesn't exist on origin. Reproduced 2026-05-10: the dev-team worker on the M3 Ultra had created a local-only `fix/watchdog-skip-dead-sessions` branch; the operator's next `subctl update` aborted because `git fetch origin fix/watchdog-skip-dead-sessions` failed. New behavior: `lib/update.sh` probes the remote with `git ls-remote --exit-code --heads origin <branch>` before fetching; if the branch isn't there, warns and automatically falls back to `main` (`git checkout main` + retry). Local-only branches are preserved as plain local branches the operator can return to.

### Notes

- Live-fixed on M3 Ultra: switched the checkout back to `main`, fast-forwarded 4 commits to v2.6.1, bounced tmux daemons. Master + dashboard now running v2.6.1.

## [2.6.1] — 2026-05-10

Patch — doc overhaul: README + dashboard `/cheat` + `/help` + ROADMAP all reframed for the v2.x agentic-harness scope.

### Changed

- **README.md** — full rewrite. Was framed as "multi-account dispatch tool for Claude" (v1.0 scope) when the project's actual scope is now "agentic harness for AI subscriptions" with the master daemon as the centerpiece. New structure: tagline → ASCII arch diagram → 12 capability bullets → install → daily ops → architecture pointer (`docs/master.md`) → repo layout → roadmap pointer → contributing.
- **`/cheat` page** (`renderCheatsheetPage` in `dashboard/server.ts`) — added 8 new sections covering features that shipped in v2.x: Master daemon control, Master personality presets, Document attachments in chat, Vault viewer, Multi-team camera view, Update + versioning, Skills catalog, Team templates, Plugin system. "Web dashboard UI" section was 2 rows; now it's 13 (one per sidebar tab) plus a separate Interactions section.
- **`/help` page** (`dashboard/help.md`) — header rewritten to lead with "front-end for subctl master." Added a 12-row tab table at the top + dedicated sections on Chat (attachments, personality, Telegram bidirectional), Orchestration (camera view, watchdog history), and Vault (rendering rules + deep-link URL pattern + master integration).
- **`ROADMAP.md`** — preamble now correctly scopes this file to **provider expansion** (multi-provider dispatch substrate), with the agentic-harness roadmap pointed at `docs/master.md` §4. OpenAI Codex marked **shipping** (was "planned next" — already shipped in 2.x).

### Why

Operator playthrough revealed the docs were a release behind reality. New operator landing on the README would see "Subscription Central CLI" pitch and miss the actual product (conversational orchestrator with 50+ tools and a 12-tab dashboard). Cheat sheet didn't mention `subctl master`, personality, attachments, vault viewer, or camera view. The /help page led with "verdict banner" — true but no longer the headline.

### Out of scope for this patch

- `docs/multi-account.md`, `docs/master.md`, `docs/release-workflow.md` already current (master.md was rewritten through Phase 3o; release-workflow.md got the 3-digit bump policy in v2.1.x).
- `START-HERE.md` (separate clean-Mac install copy) — covered briefly in README but not rewritten; still valid for fresh installs.

## [2.6.0] — 2026-05-10

Minor — personality picker in the dashboard UI + roadmap (Phase 3p Personal Skills System, Phase 3q Vault Canvas Editor).

### Added

- **Settings → Master personality tile** with dropdown picker + Apply button. Hits the existing `/api/master/personality` endpoints (GET catalog, POST swap). Shows the currently-active preset, the seven built-ins (`straight-shooter`, `witty`, `sarcastic`, `robotic`, `arnold`, `elon`, `hilarious`), and a one-line preview of the selected preset. Hot-swap takes effect on the next prompt; no restart. Closes the gap reported 2026-05-10: "I don't see personas yet. Where would I get to that?" — answer: CLI worked since v2.2.0, dashboard UI lands now.

### Roadmap (docs/master.md)

- **Phase 3p — Personal Skills System (ArgentOS-style).** Operator-facing skill authoring UI: editor pane with frontmatter validation, multi-source targeting (master / dev-team templates / specific Claude accounts / global `~/.claude/`), per-skill enable-disable, bundle export/import. Design block sketches backend endpoints (`POST /api/skills/author`, `POST /api/skills/toggle`, `GET /api/skills/bundle/export`, `POST /api/skills/bundle/import`) plus a `skill_propose` master tool that surfaces recurring-pattern claude-mem observations as click-to-author drafts.
- **Phase 3q — Vault editor (canvas).** Make the Phase 3n vault viewer writable. CodeMirror 6 from CDN for markdown editing (matches the "no build step" convention), `[ Edit ]` toggle on the rendered-note pane, conflict-detect on save via expected_mtime, optional Excalidraw-style freeform canvas mode for diagrams stored as `<note>.excalidraw.json`. New file-watch SSE so master writes via `vault_append` show up in real time in the viewer.

## [2.5.7] — 2026-05-10

Patch — three operator-reported fixes from the post-shutdown playtest.

### Fixed

- **Watchdog no longer fires on dead tmux sessions.** `refreshTeamActivityFromTmux` now PRUNES entries whose tmux session is no longer alive. Diagnosed live during operator playtest: "Looks like your watchdog is kicking off even though you closed the tab out." Was caused by `teamLastActivity` keeping the spawn-seed event in memory after `tmux kill-session` ran — the team's `last_activity` aged forever, watchdog flagged stale every tick, master tool-called `subctl_orch_status` and got HTTP 404 each time. New behavior: any `claude-*` entry missing from the live tmux session list gets dropped, plus a `team_pruned` SSE event + `watchdog_pruned` decisions.jsonl line for audit. Guarded against false positives — only prunes when the tmux query succeeded.
- **Dev-team card no longer renders "undefined: (no text)".** Synthetic spawn-seed events use `kind`/`detail`/`by` fields; the renderer was expecting `type`/`text`. Fallback chain added so seed events render as `spawned: retroactive seed for live team …` instead of `undefined: (no text)`.

### Changed

- **Master SKILL nudges `claude-mem` usage more aggressively.** Operator noted the master was relying solely on `memory.md` (tier-1) and rarely calling `memory_search` / `memory_timeline`. New rule in the system prompt: call claude-mem proactively when (a) operator references a past project/decision/incident, (b) about to assert a fact from loose recall, (c) spawning into a project worked on before, (d) transcript was auto-compacted. Plus an explicit boundary call-out: `memory.md` is operator notes; claude-mem is project/incident history.

## [2.5.6] — 2026-05-10

Patch — watchdog observability. Backlog item shipped.

### Changed

- **Watchdog panel in Orchestration tab renders every tick, not just firings.** Previously the panel showed "no recent watchdog firings" indefinitely — true but useless, looked like the watchdog was broken. Now: the master's existing `watchdog_ok` SSE event populates a rolling history of the last 8 ticks with timestamp + `OK` pill + team/stale counts. `watchdog_fire` events show with a red `FIRE` pill and a summary of the synthesized prompt. The card header surfaces `last tick · HH:MM:SS` so the operator can see when the watchdog last ran without scrolling.
- **Empty-state copy** updated from "no recent watchdog firings" to "armed — first tick lands within the configured interval (default 3 min)" so a fresh-loaded dashboard tells the truth.

### Architecture note

The renderer (`renderWatchdogPanel`) lives at module scope in `app.js`, called from the SSE event handlers. Module-level placement was deliberate so the function is reachable from the wireMasterChat listeners without rewiring `wireOrchestrationCockpit`'s closure scope.

## [2.5.5] — 2026-05-10

Patch — launchd resilience after today's death spiral.

### Changed

- **Master plist `KeepAlive` is now conditional.** Was `<true/>` (restart unconditionally). Now `{SuccessfulExit: false, Crashed: true}` — launchd restarts on crash but NOT after a clean operator stop. Prevents `subctl master disable` from being instantly undone by KeepAlive.
- **Master plist `ThrottleInterval` 10s → 30s.** Today's failure mode: LM Studio crashed → master ctx-pin hung 60s → daemon exited → launchd respawned within 10s → master hung 60s again. macOS's internal respawn-limit detector flagged the job as failing and gave up. 30s gives the environment breathing room and resets the failure counter more aggressively. (Combined with v2.5.3's 2s LM Studio reachability probe, master now boots fast even when LM Studio is dead.)
- **Master plist `ExitTimeOut` added (20s).** SIGTERM → wait 20s → SIGKILL. Stops zombie processes when a shutdown path hangs.
- **Dashboard plist mirrors the same `ThrottleInterval` (30) + `ExitTimeOut` (20)** for consistency.

### Added

- **`subctl master kick`** — force-recover when launchd has thrown up its hands. Bootouts the stale job, kills any orphan master process squatting on the port, bootstraps a fresh launchd entry. Must be run from a local TTY (Terminal.app on the machine) because `launchctl bootstrap` targets `gui/$UID` which isn't reachable from a vanilla SSH session. Falls back to a printed `tmux new-session` recovery command if bootstrap fails.

### To apply on an existing install

```
subctl master disable && subctl master enable    # re-renders the plist
```

Or from local Terminal.app on the M3 Ultra:

```
subctl master kick
```

## [2.5.4] — 2026-05-10

Patch — three operator-reported issues from the post-recovery playtest.

### Fixed

- **Chat toolbar now sticky-anchored at the top of the chat panel.** Operator reported (third occurrence) that scrolling chat content visually overlapped the toolbar AND made the MODEL dropdown unclickable. Root cause was the toolbar living in flex flow with no z-stacking — scrolled content rendered over it under certain content lengths. Fixed via `position: sticky; top: 0; z-index: 5; background: var(--bg-1)` on `.chat-toolbar`. The toolbar now anchors at the top of the panel regardless of scroll position, content scrolls under it, clicks always land.
- **Vault tab now finds vaults even without a `.obsidian/` marker.** v2.5.0's detection required every subdirectory of `vault_root` to have a `.obsidian/` dir to count as a vault — strict but brittle. The master's `vault_append` tool creates project subdirs WITHOUT a `.obsidian/`, so any vault populated only by the master would show empty in the viewer. New detection: (a) treat `vault_root` itself as a vault if it has `.obsidian/`, (b) treat each subdir with EITHER `.obsidian/` OR ≥1 `.md` file as a vault. Existing canonical Obsidian vaults still detected correctly; master-only project dirs now visible.
- **Live fix on M3 Ultra:** dropped `.obsidian/` markers into `Down-Time-Arena/` and a fresh `master/` subdirectory inside the vault root so the operator can see both vaults immediately without waiting for a fresh install.

### Added

- **Telegram source badge + auto-relay.** Two-part fix for "I sent from Telegram but the master replied in the dashboard, not Telegram":
  - **Frontend:** Telegram-sourced messages in the chat panel get a `from-telegram` class with purple left-border + the label `✈ you · telegram` so the operator can see at a glance which channel a message arrived from.
  - **Master daemon:** after the assistant settles a turn, if `source: "telegram"`, the response text is now automatically relayed back to the Telegram chat via the existing `sendTelegramOutbound` helper. No tool call required by the model. Truncates to 3900 chars (Telegram's 4096 cap minus padding) with `…[truncated; full reply in dashboard chat]` if longer. Skipped for internal synth prompts (`[verifier]` / `[watchdog]` / `[scheduled]`).

## [2.5.3] — 2026-05-10

Patch — master daemon survives LM Studio crashes cleanly.

### Why

Surfaced during today's session: LM Studio crashed under memory pressure (probably from the day's camera-view polling stacking duplicate qwen instances). Master daemon then entered a death spiral — ctx-pin for the reviewer hung 60 s on `/api/v1/models/load`, daemon eventually crashed, launchd hit its restart-throttle limit and gave up retrying. Both subctl services were down. The recurring symptom: `ctx-pin FAILED reviewer: load error: The operation timed out.`

### Fixed

- **`ensureModelLoaded` short-circuits when LM Studio is unreachable.** Tight 2 s timeout on the initial `/api/v0/models` reachability check; if it doesn't respond we skip the pin entirely and let JIT-on-first-prompt handle it. Old code charged into a 60 s `/load` request even when LM Studio was clearly dead.
- **Treat "already loaded at ≥ desired context" as a hit.** When the supervisor pins at 65 K and the reviewer also points at the same model but wants 32 K, the reviewer no longer triggers an unload+reload — it accepts the already-loaded 65 K instance. Avoids the recurring "supervisor succeeds, reviewer evicts + reloads + hangs" cascade.
- **Role pins run in parallel.** Wrapped supervisor + reviewer ctx-pins in `Promise.allSettled`. Boot is now bounded by the SLOWEST single role, not the sum. Previously a hung reviewer pin would block the supervisor's pin output for a minute even though they're independent.
- **Load fetch timeout 60 s → 20 s.** If LM Studio can't load in 20 s the daemon shouldn't block boot — first user prompt will JIT it. The 60 s cap was inherited from the original force-pin patch where we wanted to ride out a slow model load; in retrospect the supervisor's pin succeeds in ~2 s when LM Studio is healthy, and 20 s is plenty even for the worst cold-start case we've actually observed.

### Notes for the operator

- **No re-auth or config changes needed.** Code-only fix.
- If you've had providers.json with both supervisor + reviewer pointing at the same model with different `context_length` values, v2.5.3 will gracefully share one loaded instance instead of trying to double-load. Removing the reviewer block entirely is also fine — supervisor handles everything.
- **launchd recovery on the M3 Ultra:** today's death spiral exhausted launchd's restart-throttle and `launchctl bootstrap` failed via SSH (GUI domain unreachable from a non-attached session). Recovery path: open Terminal locally on the M3 Ultra and run `launchctl load ~/Library/LaunchAgents/com.subctl.master.plist`. Or keep using the detached-tmux daemons set up today (`tmux ls` — sessions `subctl-master` and `subctl-dashboard`).

## [2.5.2] — 2026-05-10

Patch — three v2.5.0 bugs surfaced by operator the moment the Vault tab landed.

### Fixed

- **Vault tab now hides other tabs.** Missed adding the `body[data-active-tab="vault"] section[data-tab]:not([data-tab="vault"]) { display: none; }` rule in v2.5.0. Result: clicking Vault left the body in "no rule matched" state, every section rendered stacked + scrollable. Fixed by adding the missing rule.
- **Projects → "Open Vault Path" button now actually opens the Vault viewer.** Was renamed to **"Open in Vault Viewer"** and rewired: clicks now call `window.openVaultDeepLink("master", "<project>/decisions.md")` which sets the hash + clicks the sidebar Vault button. Old behavior copied the path to clipboard (which was the placeholder before Phase 3n existed).
- **Chat toolbar padding bumped from 22 → 28px top.** Defensive fix — operators kept reporting the chat toolbar buttons appearing clipped against the panel's rounded top edge. Likely a stale-CSS-cache + flex-wrap interaction, but extra top breathing room makes it impossible regardless.

### Added (helper for cross-tab navigation)

- **`window.openVaultDeepLink(root, path)`** — exposed by the Vault tab module so other tabs (Projects, future ones) can route the user to a specific note: sets the URL hash, programmatically clicks the Vault sidebar button, lets the existing tab-activation logic + hash-aware `checkActive()` pick up the navigation. The Vault tab's `checkActive()` was extended to re-evaluate the hash on every activation (not just first load) so deep-links from outside work even when the vault is already loaded.

## [2.5.1] — 2026-05-10

Patch — three backlog cleanups.

### Changed

- **`detached` label renamed to `running · headless`** in dashboard team rows + tmux preview meta. Operators read "detached" as "broken/disconnected"; it actually means "no operator terminal currently attached, work continues." New wording matches expectation. (One of two backlog items called out 2026-05-10.)
- **`lms version` parser now extracts a real semver instead of a banner line.** Previously the dashboard's install-checks tile picked the first line containing a digit, which in `lms`'s ASCII-art banner output (box-drawing chars + version inside a frame) ended up being a line like `│ Version 1.4.1 │`. Now: strip ANSI → strip box-drawing/block chars → match `/\b\d+\.\d+(?:\.\d+)?(?:[-+]\w+)?\b/` per line → return the first hit. Falls back to first non-empty line if no semver shape found.

### Added

- **`system_my_tools(filter?)`** — master tool that introspects the live tool registry. Use case: when Jason asks "what tools do you have?" or "what can you do?", master can answer accurately from the registry instead of recall. SKILL updated to mandate calling this for capability questions (reinforces anti-hallucination rule #2). Optional `filter` arg does case-insensitive substring match — e.g. `system_my_tools({filter: "subctl_orch"})` returns just the orchestration tools.
- **Late-binder pattern in `tools/system.ts`** — `bindToolRegistry(reg)` exposed by the module, called once by `server.ts` after the registry is built. Avoids a circular import (system → server → systemTools).

## [2.5.0] — 2026-05-10

Minor — Phase 3n ships (MVP): **in-browser Obsidian vault viewer.**

### Added

- **New "Vault" sidebar tab** with two-pane layout: file tree (left, 280 px) + rendered note (center). Auto-opens the first two levels of the tree for discoverability.
- **Backend endpoints** in `dashboard/server.ts`:
  - `GET /api/vault/roots` — every sub-directory of `vault_root` with a `.obsidian/` dir is enumerated as a discrete vault.
  - `GET /api/vault/<vault>/tree` — full folder tree of `.md` files, dirs sorted before notes alphabetical.
  - `GET /api/vault/<vault>/note?path=…` — raw markdown + parsed YAML frontmatter + file stats.
  - `GET /api/vault/<vault>/asset?path=…` — passthrough for images (png/jpg/gif/svg/webp/pdf), with caching headers.
  - All paths sanitised via `safeJoinUnder()` — rejects `..`, absolute paths, null bytes.
- **Frontend renderer** uses Marked.js 13.0.0 from CDN (no build step). Pre-render transforms cover the Obsidian-specific syntax Marked doesn't know about:
  - `[[wikilink]]` and `[[wikilink|alias]]` → click-navigable anchors (purple). Resolver matches exact path first, then any note whose final segment matches case-insensitively. Missing targets render with a red dashed underline.
  - `![[embed.png]]` → `<img>` via the asset endpoint. Non-image embeds become click-to-open links.
  - `> [!note]` / `> [!warning]` / `> [!danger]` callouts → styled blockquotes with coloured left borders and uppercase titles.
  - `#tag` (in body text, not headings or URLs) → coloured pill spans.
  - YAML frontmatter parsed and rendered as a metadata header above the note.
- **Deep-linkable URLs:** `/dashboard#vault?root=<slug>&path=<rel-path>` opens straight to a specific note. History is updated on every navigation so back/forward work.
- **New master tool `vault_link(note_path, root?)`** — returns the deep-link URL the master can include in chat or Telegram messages. Defaults `root` to `master` (the daemon's own vault). Reports whether the note actually exists at the resolved path.

### Out of scope for v2.5.0 (deferred per spec §3n)

- **Right-pane backlinks + outgoing-links panel.**
- **Search** (full-text + filename + tag filter).
- **Graph view.**
- **File-watching SSE** for live tree/note updates — currently refresh-on-click.
- **Edit-in-browser** — Vault viewer is read-only by design. The master writes via `vault_append`; humans edit via the Obsidian desktop app.

### Try it

```
# Sidebar → Vault. Pick the auto-created "master" vault.
# Browse the tree, click a note. Wikilinks navigate.
# Or jump directly:
#   http://192.168.100.98:8787/dashboard#vault?root=master&path=Down-Time-Arena/decisions.md
```

## [2.4.0] — 2026-05-10

Minor — Phase 3l ships (MVP): **document attachments in chat.**

### Added

- **Attachment storage layer** (`components/master/attachments.ts`): on-disk files under `~/.config/subctl/master/attachments/<date>/<id>-<filename>` plus an append-only `index.jsonl` of metadata. Each entry tracks id, filename, sha256, size, mime, source (`upload` / `paste` / `tool`), created/deleted timestamps. Soft-delete in index, hard-delete the file. 5 MiB per-attachment cap; mime allowlist covers text/* + JSON/YAML/TOML/XML/script types (PDF + images deferred to Phase 2).
- **Master HTTP endpoints**:
  - `POST /attachments` (raw bytes; metadata via `X-Filename` / `X-Mime` / `X-Source` headers) → `{id, filename, size, mime, sha256}`
  - `GET /attachments` → list metadata
  - `GET /attachments/<id>` → file bytes with proper mime
  - `DELETE /attachments/<id>` → soft-delete + remove on-disk file
- **`POST /chat` now accepts `attachments: [id…]`**. Server resolves each id, wraps content in fenced `<attachment id="…" filename="…" size="…" mime="…">…</attachment>` blocks, prepends to the prompt the model sees. Empty `text` is fine if at least one attachment is present.
- **Two new master tools** (`components/master/tools/attachments.ts`):
  - `read_attachment(id, start?, end?)` — re-read an attachment by id, with optional byte-range chunking. Use case: auto-compaction has dropped the original turn's inline content; this tool lets the master re-fetch without forcing the operator to re-upload.
  - `list_attachments(filter_filename?, limit?)` — find an attachment id by filename substring when the operator references a document by name.

### Frontend

- **Paperclip button** next to the chat input opens a multi-file picker.
- **Drag-and-drop** anywhere on the chat panel highlights the input area and attaches dropped files.
- **Paste interception**: pasted text ≥ 4 KB is automatically uploaded as `paste-<timestamp>-<slug>.md` instead of going into the input. Smaller pastes pass through as normal.
- **Pill chips** above the input show each queued attachment (filename + size) with a × to remove before send. Cleared automatically after send.
- **Visible chat history** records each attachment as `📎 filename` plus any user text, so the transcript stays readable even though the model received the full inline content.

### Out of scope for v2.4.0

- PDF text extraction (`pdftotext`) — deferred. PDF mime not yet in the allowlist; ship after wiring extraction.
- Image vision — deferred until a vision-capable supervisor is wired (qwen-VL via LM Studio is the obvious path).
- `subctl master attachments gc` CLI verb — `gc()` exists in the module; wiring deferred.
- Subctl-side worker prompt augmentation (handing attachments to dev-team workers).

### Try it

```
# Drop a markdown file on the chat panel.
# Or paste a long block (>4KB) — auto-attaches.
# Or click 📎 → pick a file.
# Send. Master sees the content; transcript shows just the pill.
```

## [2.3.0] — 2026-05-10

Minor — Phase 3m ships (MVP): **multi-team camera view** in the Orchestration tab.

### Added

- **NVR-style grid of every active dev team's tmux pane** at the top of the Orchestration tab. Polls `/api/orchestration/captures` every 2 s while the tab is visible, renders ~22-row tiles per team in monospace. Tiles auto-fit via `grid-template-columns: repeat(auto-fit, minmax(420px, 1fr))` — 1 team gets a full-row tile, 2 sit side-by-side, 4 form a 2×2, etc.
- **Status pill per tile** — `active` (green, last activity <60 s), `idle` (gray, <15 min), `stale` (yellow, >15 min), `error` (red, last 10 lines match `/error|failed|fatal:/i`), `ended` (faded, session disappeared). Left border colour mirrors the pill so the grid is glanceable.
- **Click a tile to expand** — fills the viewport with a single team's pane content, larger font, full capture height. Esc / click-backdrop / ✕ closes. Polling continues on the expanded view so it stays live.
- **`GET /api/orchestration/captures`** bulk endpoint in dashboard: returns ANSI-stripped capture content for every tracked session in one call. `?lines=N` (default 40, clamped 8..200). Backed by a new `tmuxCaptureFrame(session, lines)` helper.
- **Tab-aware polling** — the grid only fetches while the Orchestration tab is visible (watched via `MutationObserver` on `body[data-active-tab]`). Saves network + tmux-capture cost when the operator is on Chat or any other tab.

### Out of scope for MVP (deferred per spec §3m)

- xterm.js per tile (real ANSI colour + ligatures) — Phase 2; current tiles use plain `<pre>` with ANSI stripped.
- SSE delta streaming — current implementation is plain polling at 2 Hz.
- Pinning, sound alerts, recording/replay, audio overlay.

## [2.2.0] — 2026-05-10

Minor — Phase 3k ships: **personality presets for the master daemon.**

### Added

- **Seven built-in voice presets**, each a short fragment (`components/master/personalities/<slug>.md`) describing the master's voice (tone, cadence, mannerisms). Persona — *what* the master is — stays fixed; personality is *how* it speaks. Built-ins: `straight-shooter` (default, current behavior), `witty`, `sarcastic`, `robotic`, `arnold` (inspired by, not a likeness), `elon` (inspired by, not a likeness), `hilarious`.
- **`components/master/personality.ts`** loader module. `readActivePreset()`, `buildPersonalityFragment()`, `setPreset()`, `describePresets()`. State at `~/.config/subctl/master/personality.json` — single key `preset`. `composeSystemPrompt()` reads on every turn so the change hot-swaps with no daemon restart.
- **Master HTTP endpoints:** `GET /personality` returns the active preset + catalog with previews. `POST /personality { preset }` swaps the active preset, logs to `decisions.jsonl`, broadcasts `personality_set` over SSE. Dashboard's existing `/api/master/*` auto-proxy makes both reachable at `/api/master/personality` for the browser.
- **CLI verb:** `subctl master personality {list,show,set}`. Goes through the daemon's HTTP endpoint so the change is audited and SSE-broadcast.

### Constraints (non-relaxable per preset)

Every preset fragment explicitly preserves the anti-hallucination rules from v2.1.3/v2.1.4. The runtime claim verifier still gates claims regardless of voice; the master SKILL's behavioral contract still applies. Personality changes *delivery*, not *behavior* — a sarcastic refusal is still a refusal, a witty one-liner about a tool call still needs the actual tool call.

### Out of scope for v2.2.0

- Dashboard Settings tile UI for personality picking — backend wired, UI lands in a follow-up patch.
- Per-channel personality (different voice on Telegram vs chat panel).
- User-authored / runtime-editable presets via the dashboard — Phase 1 ships built-ins only; community-contributed presets land via the plugin system (§3j).

### Try it

```
subctl master personality list
subctl master personality set sarcastic
# next chat message will come back in the new voice
subctl master personality set straight-shooter   # back to default
```

## [2.1.9] — 2026-05-10

Patch — dev-team tmux sessions spawn at 220×50 instead of default 80×24.

### Changed

- **`tmux new-session` in `providers/claude/teams.sh` now passes `-x 220 -y 50`.** Without these flags, detached tmux sessions default to 80×24 because the spawning shell has no controlling terminal. Claude Code's TUI lays out at 80 columns, which renders fine for an attached user but looks half-empty in the dashboard's wide tmux-preview modal — the right ~50% of the (now letterboxed) modal stayed blank because the captured content was genuinely 80 cols. 220×50 gives Claude Code enough horizontal room for tool-call blocks to render on single lines, plus 50 rows of scrollback context.

### Live fix applied on M3 Ultra

- The `claude-Down-Time-Arena` session was resized from 80×24 → 220×50 via `tmux resize-window`. Claude Code repaints on SIGWINCH so no work was lost; the next dashboard capture will show the wider layout. Future spawns pick up the change automatically from v2.1.9.

## [2.1.8] — 2026-05-10

Patch — modal width-variant CSS specificity fix.

### Fixed

- **`.modal-wide`, `.modal-narrow`, `.tmux-preview` were silently no-op'd by `.modal`.** All three modal size variants set `max-width` (and `tmux-preview` set `width`) but appeared *earlier* in the stylesheet than the base `.modal { width: 90%; max-width: 580px }` rule. Same selector specificity (single class) → source-order tiebreaker → `.modal` won → every modal stayed at 580px regardless of which variant class was applied. v2.1.7 attempted to widen the tmux-preview modal but the override silently lost, so the modal frame stayed narrow while the inner pane font/padding bumps from v2.1.7 made the pane wider than its container — caused horizontal-scroll overflow. Fixed with compound selectors `.modal.modal-wide`, `.modal.modal-narrow`, `.modal.tmux-preview` — one extra class bump in specificity, source order no longer matters.

### Notes

- Side benefit: the notice/confirm modal (uses `.modal-narrow`) was also rendering at 580px instead of 460px. Now it'll be the intended narrower size on the next reload.

## [2.1.7] — 2026-05-10

Patch — quality-of-life: tmux-preview modal is now bigger + letterboxed.

### Changed

- **tmux-preview modal width 1100px → 95vw (cap 1900px).** Operator request 2026-05-10: the View button on dev-team rows opens a captured-pane viewer; at the old 1100px width long lines wrapped awkwardly while the rest of the screen sat empty. Now the modal fills nearly the full viewport horizontally, capped at 1900px for ultrawide screens.
- **Pane area font 11.5px → 13px, min-height 360 → 520, max-height stays at 75vh.** Captures of 30+ rows of terminal output fit comfortably without scrolling, and the larger font reads cleanly at the wider modal size. Letterbox feel — wide and short, like a real terminal multiplexer view.

## [2.1.6] — 2026-05-10

Patch — modal stacking context fix.

### Fixed

- **Modals no longer get rendered behind the chat panel.** Operator inspector dive 2026-05-10: the tmux-preview modal's header was being overlapped by the chat input form below it in the DOM. The `.modal-backdrop` had `position: fixed; z-index: 1000` which *should* have layered it above, but some other paint context was pinning that layer behind the rest of the page. Two-layer fix: bumped the backdrop to `z-index: 9999` (safely above any other element in the document), and gave the inner `.modal` its own stacking context via `position: relative; z-index: 1` so its descendants always render above non-modal siblings regardless of DOM order.

## [2.1.5] — 2026-05-10

Patch — three dogfood-driven fixes.

### Fixed

- **Chat panel no longer overlaps the toolbar when conversation grows.** `.orchestration-screen` was using `min-height` instead of `height`, so as the chat history grew the screen container got taller than the viewport and the body scrolled — pushing the MODEL/APPLY/COMPACT/+NEW CHAT toolbar above the visible area. Switched to a fixed `height: calc(100vh - 56px - 48px)` + `overflow: hidden` on the parent, removed the now-redundant `max-height` magic-number on `.master-chat`, and let the `.master-log` flex bound itself with `overflow-y: auto`. Toolbar stays anchored at the top regardless of chat length.
- **Team activity now refreshes from real pane content, not tmux's window-focus signal.** v2.1.2 used `tmux #{window_activity}` which only updates on user-attach interactions — useless for a detached worker pane spewing output. The dashboard kept showing `1h05m ago` while the worker had clearly written 13 files in the last 30 minutes. Replaced with `tmux capture-pane -p` + content hashing per session: if the hash changed since the last watchdog tick, we bump `teamLastActivity` to now. Reliable signal regardless of attach state.

### Changed

- **Master SKILL gains rule #6: publish to `notify_dashboard` on meaningful events.** The dashboard's NOTIFICATIONS feed has been empty during the entire FOOTHOLD dogfood because the master only narrated progress in chat — never published. Rule #6 specifies the kinds (`spawn`, `milestone`, `blocked`, `escalation`, `decision`, `error`, `watchdog`) and the contract: ≤120-char summary, paired with chat messaging not in place of it. The verifier's `message-sent-claim` rule already partially enforces it; rule #6 names it explicitly.

## [2.1.4] — 2026-05-10

Patch — runtime claim-verification gate, Argent-style.

### Added

- **Post-turn claim verifier** (`components/master/verifier.ts`). After the master settles a turn, the runtime scans the assistant text for "claim triggers" (specific future check-in times, asserted team status, host-fact claims, message-sent claims, decision-logged claims) and checks each against tool calls made IN THE SAME TURN. If a claim isn't backed by the corresponding tool, the runtime feeds a synthetic `[verifier]` correction prompt and re-runs the turn. Capped at 2 corrections per original prompt to prevent loops; on giveup, the gap is logged to `decisions.jsonl` (`verifier_giveup`) and the response ships with the gap on record.
- **Five initial verification rules:**
  - `future-checkin-time` — "I'll check in N minutes" / "I'll follow up at T" → must have called `schedule_followup`
  - `team-status-claim` — "the team is making progress" / "team is stuck" → must have called `subctl_orch_status` or `subctl_orch_list`
  - `host-fact-claim` — "qwen is loaded" / "Docker is running" → must have called `system_lmstudio_models` or `system_tmux_sessions` etc.
  - `message-sent-claim` — "I sent a message to Jason" / "I nudged the team" → must have called `telegram_send` / `subctl_orch_msg` / `notify_dashboard`
  - `decision-logged-claim` — "I logged this to the vault" → must have called `vault_append` or `memory_remember`
- **`verifier_gap` SSE event** — broadcast when a gap is detected, surfacing in real time which rule fired and what the unbacked phrase was. Visible in `/api/master/events` and the dashboard's live activity feed.
- **`verifier_resolved` / `verifier_giveup` decision-log entries** — operator can grep `decisions.jsonl` to see how often the verifier had to intervene and which rules trip most.

### Why this exists

Operator pattern from ArgentOS, paraphrased 2026-05-10: *"If Argent tries to say something and can't prove it or back it up with actual tool use proof, Argent is looped back and gated. You'll hear her say 'oh you're right' and then the turn gets blocked."*

v2.1.3 added the `schedule_followup` tool + SKILL guidance — that's the polite layer ("please don't lie"). v2.1.4 adds the runtime gate ("you literally can't ship a lie without us catching it"). They reinforce each other. SKILL alone wasn't enough during dogfood — model produced a 15-min-checkin promise without scheduling. Verifier catches that pattern at the runtime level and re-runs the turn until backed by tool use OR explicitly logged as unverified.

### Notes

- The verifier skips itself for `[verifier]`, `[watchdog]`, `[scheduled]`, `[team-report]` prefixed prompts — those are runtime-internal, not operator-facing claims.
- Iteration cap is 2 — i.e., one correction loop maximum. If the model can't get its own claim backed after one pointed retry, the response ships with a `verifier_giveup` log entry rather than looping forever. Operator can grep that to see chronic offenders.
- Rules are extensible — add to `VERIFICATION_RULES` in `verifier.ts`. Keep `requires_any_tool` honest; over-strict rules (requiring tools that don't actually verify the claim) cause friction without quality gain.

## [2.1.3] — 2026-05-10

Patch — anti-hallucination scaffolding for the master daemon.

### Added

- **`schedule_followup` tool family** (`components/master/tools/scheduler.ts`). Three new master tools: `schedule_followup({in_minutes, summary, prompt})` writes a future self-prompt to `~/.config/subctl/master/followups.jsonl`; `list_followups` shows pending; `cancel_followup({id})` removes one. A new ticker in the master daemon polls every 60s, fires due followups as synthetic `[scheduled]` agent prompts. Survives daemon restarts (state is on disk).
- **Anti-hallucination rules section in master SKILL.md.** Five non-negotiable rules: (1) never promise a check-in time without first calling `schedule_followup`; (2) don't claim capabilities you don't have (no "background monitoring"); (3) verify host facts via `system_*` tools, don't recall; (4) keep workers moving through checkpoint questions instead of bouncing them back to the operator; (5) say "I don't know" rather than fabricating status. These override the rest of the SKILL when in conflict.

### Why this exists

Surfaced 2026-05-10 during the FOOTHOLD dogfood. After 39 minutes of silence, the master told the operator "I'll check in on it in 15 minutes" — but had no underlying timer behind that promise. The watchdog would have fired regardless, but the specific 15-minute commitment was hallucinated. Operator caught it: "It needs to be gated. The master shouldn't be able to lie even if it's just trying to keep me happy."

The fix gates the lie at the mechanism level. The master now has a real tool that backs timed promises with file-on-disk state. The SKILL update tells it to use the tool and not fabricate cadence. Future "I'll check at T" sentences are tied to a specific followup record the operator can inspect via `list_followups` — no record, no promise.

## [2.1.2] — 2026-05-10

Patch — watchdog cadence + activity signal.

### Changed

- **Watchdog defaults tightened.** Default `review_interval_minutes` 5 → 3, default `stall_detection_minutes` 60 → 15. Operators expect the master to notice within minutes when a worker goes silent; the previous 5/60 defaults were "check in once every 5 minutes, escalate after an hour" — too coarse for an active dogfood loop. The new defaults align with the dashboard's row-colour thresholds (yellow at 15min, red at 30min) — the master now catches a team transitioning into "yellow" rather than waiting for red. Operator can still override via `policy.global_defaults`.

### Added

- **Tmux window-activity as a fallback liveness signal.** Previously `teamLastActivity` was only updated by the inbox tailer, which meant a worker that was productively writing files but never self-reporting via inbox looked stale. Diagnosed during FOOTHOLD when the worker built `server-foothold/` over 25 min while the inbox stayed pinned at the spawn-seed timestamp from 14:13 — dashboard reported `30m ago` and a red staleness dot even though the worker had just paused waiting for the operator's `go`. The watchdog tick now calls `tmux list-windows -a -F '#{session_name}|#{window_activity}'` first and bumps `teamLastActivity` to the latest tmux activity timestamp for any session whose window has been touched more recently. Inbox events still take precedence when present; tmux only fills the gap.

## [2.1.1] — 2026-05-10

Patch — chat-toolbar overflow into right sidecar.

### Fixed

- **Chat toolbar no longer spills into the dev-teams panel.** The toolbar's `display: flex` had no `flex-wrap`, and the child min-widths (model selector 280px, ctx meter 220px) summed to more than the chat column on typical viewports. With no wrap, no overflow clip, the ctx pill `ctx 33,422 / 65,536 tok (51%)` rendered on top of the team name `claude-Down-Time-Arena` in the right sidecar. Added `flex-wrap: wrap` + `overflow: hidden` on the toolbar, and reduced `chat-model-select` min-width from 280px → 220px so the row fits on a single line at most viewport widths and wraps gracefully when it can't.

## [2.1.0] — 2026-05-10

Minor — close the dogfood-exposed gap where the subctl-built skills and slash commands lived only on the operator's laptop. Fresh installs now get them automatically. New: `orchestrator-mode` skill in repo, `/team` slash command in repo, and `subctl install` symlinks all repo skills + commands into every per-account cfg_dir.

### Added

- **`components/skills/orchestrator-mode/SKILL.md`** — the multi-pane orchestrator + team-agent protocol. Critical: it includes the `SUBCTL_AGENT_ROLE=worker` activation guard that prevents the orchestrator-mode-deadlock pattern (workers self-loading the orchestrator role and waiting forever for approval to dispatch sub-workers they have no right to dispatch). Diagnosed and solved 2026-05-09 in the master/lead-deadlock incident.
- **`providers/claude/commands/team.md`** — the `/team` slash command. Routes to the `orchestrator-mode` skill.
- **`subctl_settings_install_claude_dir` now symlinks the repo's full skill + command catalog into every Claude cfg_dir.** Iterates every directory in `components/skills/` (excluding `master`, which is the daemon's own system prompt and would confuse workers) and every `.md` in `providers/claude/commands/`. Idempotent — symlinks overwrite cleanly, operator-personal skills/commands not in the repo are untouched. Each per-account cfg_dir now has `subctl`, `autonomy`, and `orchestrator-mode` available the moment it's created.

### Notes

- Only ships content I created for subctl. Sub-agents like `bug-analyzer` / `code-reviewer` / `dev-planner` (dated 2026-01-30, pre-subctl) and slash commands like `/commit` / `/code-review` / `/security-review` are operator-personal — they stay in `~/.claude/` and don't get pulled into the repo.
- Workers spawned via `subctl orch spawn` on a fresh install (e.g., the M3 Ultra) will now have `subctl`, `autonomy`, and `orchestrator-mode` in their skill catalog. Verifiable via "what skills do you have?" in a worker's chat.
- The master daemon's own SKILL (`components/skills/master/`) is intentionally excluded from the worker symlink loop — only the daemon process loads it via `components/master/server.ts`, never a worker. A worker that thought it was the master would loop into bad coordination patterns.

## [2.0.5] — 2026-05-10

Patch — three operator-reported bugs from continued FOOTHOLD dogfood, plus a roadmap entry that captures the bigger gap they exposed.

### Fixed

- **Stop hook self-heals stale paths.** `subctl_settings_install_claude_dir` previously merged a new Stop hook entry into `settings.json` only if no entry already pointed at the expected path — but didn't *rewrite* entries pointing at OTHER `log-rate-limits.sh` paths. The result, on systems migrated from older alias names (`claude-personal`, `claude-work`, `claude-overflow`), was Stop hooks pointing at non-existent scripts in the old alias dirs, generating "No such file or directory" errors after every Claude Code turn. The merge now rewrites any `log-rate-limits.sh` command path to the current cfg_dir before deciding whether to append a new entry. Idempotent — a re-run on a clean install is a no-op.
- **Chat-panel right sidecar no longer truncates.** The `1fr 320px` grid let the chat toolbar's wide content (model selector + apply + compact + new chat + fullscreen + ctx meter + supervisor label) push the sidecar past the viewport edge, clipping "ACTIVE DEV TEAMS", "claude-Down-Time-Arena", and the Notifications header. Bumped the sidecar to 360px, set `minmax(0, 1fr)` on the main track, added `min-width: 0` on master-chat and the sidecar, and added `word-break: break-word` to team rows so long session names wrap rather than overflow.
- **Live-fix on M3 Ultra:** rewrote the three per-account `settings.json` Stop hook paths from the stale alias dirs to the actual cfg_dirs. The next `subctl install` run will keep them correct via the self-heal logic above.

### Notes

- The hook-path bug exposed a much bigger gap, captured as Phase 3o in `docs/master.md`: a chunk of the operator's `~/.claude/` baseline (skills, slash commands, sub-agents, default permissions) is on the laptop but not in the repo, so fresh installs miss it. Audit complete in the doc; no code shipped — sanitizing operator-specific content before committing skills like `subctl` and `orchestrator-mode` requires manual review.

## [2.0.4] — 2026-05-10

Patch — Docker becomes a first-class hard requirement. Surfaced during the FOOTHOLD dogfood when the worker hit the dockerode hello-world step, found Docker Desktop wasn't running, and correctly stopped to ask the operator instead of failing silently.

### Added

- **Docker check in master `/diag`.** New 6th component check. Distinguishes binary-missing (`docker --version` non-zero) from daemon-not-running (`docker info` non-zero) so the suggested action is actionable: install Docker Desktop vs. `open -a Docker`. Surfaces both in the dashboard's diagnostics panel.
- **Docker in dashboard install-checks.** Added to `/api/settings/install-checks` as a required tool with `brew install --cask docker` as the install command, and fallback paths covering Docker Desktop's bundled binary location (`/Applications/Docker.app/Contents/Resources/bin/docker`).

### Notes

- The check intentionally splits "installed" (install-checks tile) from "running" (/diag tile). After a reboot, Docker Desktop is typically installed but not auto-started; the install-checks tile stays green while /diag flips red. This is the right shape — install state is durable, daemon state is transient.
- A dev team that needs Docker should call out the dependency in its boot prompt or first task. The FOOTHOLD spec already does this in §8 and §13. Future templates that involve containerized workers should follow suit.

## [2.0.3] — 2026-05-10

Patch — fix `subctl usage` and the dashboard's per-account 5h/week columns for Claude Code 2.x. Diagnosed during the FOOTHOLD dogfood when every account row in the Accounts table showed `—` for utilization despite all dispatch verdicts saying GO and a worker actively running on `claude-jason`.

### Fixed

- **`subctl_usage_bearer` now reads Claude Code 2.x file-based credentials.** Claude Code 2.x writes per-account OAuth tokens to `<cfg_dir>/.credentials.json` (mode 600) instead of the macOS Keychain. The previous implementation only knew the 1.x scheme — sha256(cfg_dir)[0:8] as a suffix on `Claude Code-credentials-<hash>` — so it found nothing for any account, `subctl usage --json` returned `ok: false` everywhere, and the dashboard's polling loop logged empty snapshots. The bearer lookup is now ordered: (1) `<cfg_dir>/.credentials.json`, (2) hashed Keychain entry (1.x), (3) unsuffixed Keychain entry (1.x default cfg_dir). First match wins.
- **`subctl doctor` reports the new credential path correctly.** The "Keychain bearers" section is renamed "Credentials" and reports `file=...` for 2.x entries, `keychain=...` (with a "legacy 1.x" tag) for old entries, and a clearer "re-run subctl auth" hint when neither is present.

### Notes

- No re-auth required. Claude Code 2.x has been writing `.credentials.json` for every alias all along; subctl just wasn't reading it.
- The Anthropic `/api/oauth/usage` endpoint hasn't changed — only the bearer lookup did. After updating, expect 5h and weekly utilization columns to populate within ~5 min (next dashboard poll cycle) or immediately after clicking the ↻ refresh button on the Accounts header.

## [2.0.2] — 2026-05-10

Patch — two operator-reported bugs from the FOOTHOLD dogfood test, both around observability of the master's own actions.

### Fixed

- **Spawned teams now register in `teamLastActivity` immediately.** Previously `subctl_orch_spawn` and `subctl_orch_spawn_template` created the tmux session and returned, but the master's tracking map was only populated by inbox events written by the worker itself. A worker that booted into Claude Code and sat at an empty prompt never wrote to its inbox, so `/health` reported `teams_tracked: 0` and the dashboard's Orchestration tab showed "no dev teams running" despite a live tmux session with the worker visible to `subctl orch list`. Both spawn tools now seed the inbox with a synthetic `{kind: "spawned"}` event on success — the existing inbox tailer picks it up and the team appears in the master's tracking on the next file-watch tick.
- **Setting the Obsidian vault root from Settings now auto-bootstraps the vault structure.** Previously, saving `~/Documents/Obsidian Vault` as the vault root just wrote `obsidian.json` and left the directory empty. The Memory tab then reported "Obsidian installed, no vault detected" and asked the operator to mkdir `.obsidian/` manually. The POST /api/settings/obsidian endpoint now creates `<root>/master/.obsidian/` plus a `welcome.md` introducing the vault — Obsidian-the-app and the dashboard both recognize it as a real vault on first save. Pass `{bootstrap: false}` if you want the legacy "config-only" behavior.

### Notes

- The team-registration fix is defense-in-depth alongside the master's own self-correction loop (`subctl_orch_status` + `subctl_orch_msg`). The master can already nudge a stuck worker via msg(); now `/health` and the Orchestration tab also reflect that team's existence rather than reporting zero teams.
- Watchdog visibility (showing last-tick timestamps even when no team is stale) is queued as a separate observability improvement — see Phase 3m design.

## [2.0.1] — 2026-05-10

Patch — guards the supervisor switch so users can't pick a provider that pi-ai doesn't have an api factory for. Reported by Jason after switching the chat panel's supervisor to "OpenAI Codex (ChatGPT)" and getting silent empty responses on every prompt.

### Fixed

- **`/api/master/supervisor` no longer accepts unwired providers.** The chat panel previously offered `openai-codex` as a supervisor option, but no provider package implements it (`providers/openai/README.md` flags it as v1.1 work). Selecting it wrote the value to `providers.json` and bounced the daemon, after which every chat turn returned empty assistant content because pi-ai's stream factory found no api in the registry. The endpoint now rejects with `400 { ok: false, error: "provider X is not wired into pi-ai yet", hint: "<list of wired providers>" }` for any provider outside the wired allowlist.
- **Chat-model selector marks unwired cloud providers disabled.** The dropdown still lists them (so users see what's coming) but the `<option>` is `disabled` with a `title` attribute pointing at the README. Wired providers render normally.

### Notes for the operator

- If the chat panel ever silently produces empty responses again, check `~/.config/subctl/master/decisions.jsonl` for `prompt_error_chat: No API key for provider: …`. That's the canary — it means pi-ai fell through the api lookup.
- The `WIRED_PROVIDERS` allowlist in `dashboard/server.ts` must stay in sync with `PROVIDER_API` in `components/master/server.ts`. Changes to one require changes to the other.

## [2.0.0] — 2026-05-10

Phase 3 — the master daemon goes live. subctl is no longer just a control plane for Claude accounts; it now hosts a persistent conversational orchestrator that spawns dev teams, talks to you over the dashboard chat panel and Telegram, and curates its own memory across three tiers. The dashboard navigation collapses from a tab strip into a 12-item sidebar.

This is a major bump because the architecture, not just the surface, changed: a new daemon, a new persistent agent, a new memory model, a new plugin contract, and a new conversational UI. Subscription accounting (the original 1.x scope) still works exactly the same.

### Added

- **`subctl master` daemon** — pi-agent-core-based persistent orchestrator on `127.0.0.1:8788`. Loads `providers.json` + `policy.json` + the master SKILL prompt, exposes HTTP/SSE so the dashboard chat tab and Telegram listener share a single agent transcript. Auto-started by `com.subctl.master.plist`.
- **44 master tools across 13 families** — `subctl_orch_*` (spawn/list/preview/attach/send), `gh_*`, `coderabbit_*`, `telegram_*`, `system_*` (host introspection), `project_*` (vault-bound project + spec scaffolding), `memory_*` (claude-mem worker queries), `context7_*` (docs RPC), tier-1 `memory_*` (always-in-context user.md + memory.md curators), `skill_*` (master-source skill authoring with category allow-list), `notify_dashboard` (curated event feed), `specforge` (5-stage intake state machine).
- **Three-tier memory architecture** — tier-1 always-in-context (`<memory-context>` blocks built from `user.md` + `memory.md`, ~3500 chars), tier-2 semantic (claude-mem worker at `localhost:37701`), tier-3 long-form (Obsidian vault). System prompt is composed per-prompt via `composeSystemPrompt()` so memory edits land on the very next agent turn.
- **Spec Forge** — 5-stage state machine (`project_type_gate → intake_interview → draft_review → awaiting_approval → approved_execution`) mirroring ArgentOS's specforge-conductor. Persists state to `~/.config/subctl/master/specforge/<key>.json` and writes approved specs to `<vault>/<project_name>/SPEC.md`.
- **Dashboard sidebar UI** — `Chat / Orchestration / Dashboard / Projects / Teams / Claude Sessions / Models / Providers / Memory / Skills / Live Logs / Settings`. Persistent chat panel with rehydrate, ctx meter, compact button, new-chat, fullscreen mode, model selector (cloud + LM Studio optgroups, ●/○ availability dots).
- **Team templates** — JSON manifests under `~/.config/subctl/teams/<name>.json` defining persona + skills + tools + autonomy + boot_prompt. `subctl teams claude --template <name>` and `subctl orch spawn` both honor templates; `_provider_claude_apply_template` copies skills into the worker's `cfg_dir`.
- **Personal skill authoring** — `skill_create` / `skill_revise` / `skill_remove` constrained to the master skill source with a category allow-list (`team-coordination`, `escalation-patterns`, `code-review-synthesis`, etc.) and a description-keyword filter. All writes audited to `decisions.jsonl`.
- **Plugin system** — `subctl plugins {list,install,remove,status,show}` with manifest `subctl.plugin.json` (id, kind, configSchema, tools, skills, tabs, verbs). Mirrors ArgentOS's manifest pattern. Plugins live under `~/.config/subctl/plugins/<id>/`.
- **Notifications sidecar** — curated event feed (`spawn`, `blocked`, `done`, `milestone`, `escalation`, `decision`, `watchdog`, `memory`) replacing raw activity logs. `notify_dashboard` tool persists to `notifications.jsonl` and broadcasts over SSE.
- **Codex provider** — first-class auth via `subctl auth openai`. Detects SSH (`SSH_CONNECTION` / `SSH_CLIENT`) and routes to `codex login --device-auth` so headless installs don't deadlock on a browser flow.
- **Context7 integration** — docs RPC against `mcp.context7.com/mcp` with `CONTEXT7_API_KEY`. `_provider_claude_drop_mcp_config` writes per-team `.mcp.json` so dev workers get docs out of the box.
- **`subctl update`** — canonical pull-and-restart workflow (`lib/update.sh`). Verifies clean tree, fast-forwards origin/<branch>, runs `bun install` where `package.json` changed, bounces launchd services, runs `subctl doctor`. `--force` stashes; `--no-restart` leaves services alone. Shows `vOLD → vNEW` delta + summary of incoming commits.
- **`VERSION` file** — single source of truth at repo root. `lib/core.sh`, `bin/subctl`, dashboard, and master daemon all read from it. `subctl version` now also prints the git branch + short SHA + dirty flag.
- **Tmux preview + ssh attach** — `subctl orch view <team>` captures a tmux pane, dashboard renders it in a modal. Attach button shells into the same session.
- **LM Studio context auto-pin** — `ensureModelLoaded()` calls `/api/v1/models/load` with explicit `context_length` at boot, on supervisor switch, and via `/reload-supervisor`. Stops the recurring "context resets to 4K on JIT load" failure mode.
- **Auto-compact watchdog** — 5-minute interval (configurable via `compact.json`). Compacts via `/transcript/compact` with `target_tokens` + `keep_recent` params; returns `noop:true` for short transcripts so the UI shows an info notice instead of an error.
- **Telegram bidirectional** — outbound via `telegram_*` tools, inbound via the master notify listener. Single transcript, two surfaces.
- **`docs/master.md`** — canonical architecture document (mental model, components, memory architecture, roadmap, operational reference, glossary, decision log).

### Changed

- **Deploy workflow is canonical-git only.** Previously, in-flight iterations sometimes shipped via `rsync` to remote hosts; this is no longer supported. The only path is: commit + push → `subctl update` on each host. Branches are tracked properly; the M3 Ultra and laptop checkouts now diverge only via committed history.
- **`/health` and state.json** report the live `SUBCTL_VERSION` instead of the hardcoded `"0.1.0"` placeholder.
- **Dashboard `Bun.serve` `idleTimeout: 0`** — previously the default 10 s was killing SSE proxy connections, causing the connection pill to flap CONNECTED ↔ RECONNECTING when chat was idle.
- **Notice modal** replaces browser `alert()` / `confirm()` in the chat and orchestration surfaces; cancel button is hidden via both `hidden` attribute and `display: none` (belt-and-braces, since some browsers honor only one).
- **install-checks PATH** extended with `~/.bun/bin`, `~/.local/bin`, `~/.lmstudio/bin`, `~/.cargo/bin` plus per-tool `fallback_paths`, so launchd-launched dashboards find user-installed binaries.
- **`accounts.conf` parser** switched from tab-delimited to pipe-delimited to match the actual file format.

### Fixed

- **`pi-ai` empty responses** — diagnosed 2026-05-09: built-in providers are NOT registered as a side effect of `import`; `registerBuiltInApiProviders()` must be called explicitly at boot. Without it, every `agent.prompt()` returned an empty content array because the stream factory found no api in the registry.
- **`writeFileSync` ReferenceError** in `/api/master/supervisor` (missing require fixed).
- **`lms --version` ANSI banner** stripped via `stripAnsi()` helper.
- **claude-mem detection via CLI probe** replaced with plugin-dir presence check at `~/.claude/plugins/marketplaces/thedotmack`.
- **OAuth row hardcoded `subctl auth claude`** for all providers — now uses each account's actual provider field.
- **Pulse-dot blinking on every WS message** — only flashes when state signature actually changes.
- **Chat doesn't auto-scroll to bottom on load** — fixed via double-`requestAnimationFrame` + `MutationObserver` on tab switch.

### Removed

- **rsync-based deploy paths.** No more out-of-band file shipping to remote subctl installs. Use `subctl update`.

## [1.0.0] — 2026-05-05

First stable release. The 0.x series stabilized into a single coherent multi-account control plane for Claude Code, covering accounts, auth, sessions, projects, teams launcher, dashboard, radar, and statusline — all integrated against the same filesystem-derived state model.

### Added

- **`subctl projects`** — declarative per-account project bindings + bulk launcher.
- **`subctl sessions`** — list and adopt orphaned Claude transcripts across every configured `cfg_dir`.
- **`subctl session-kill` / `subctl session-prune` / `claude-kill` shim** — surgical session cleanup.
- **Cost analysis** — API list-price savings vs subscription cost, surfaced in the dashboard.
- **24-hour utilization history** with per-account event attribution.
- **Per-account dispatch readiness** via `/api/oauth/usage`.
- **Dashboard polish bundle** — Mintlify-style docs, kill button, countdowns, notifications, best-account hint, copy `claude-use`, expanded doctor output, `$1,234.56` currency formatting, `/help` reference docs page.
- **Per-account experimental teams runtime** — `subctl_settings_ensure_teams` seeds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode=tmux` into each account's `settings.json`, and the tmux session env now carries the experimental flag. `Team*` / `SendMessage` tools and `Agent(team_name=…)` now surface no matter how the account is launched.
- **Defensive tmux ergonomics in `provider_claude_teams`** — ensures `mouse on` and idempotent `WheelUpPane` / `WheelDownPane` bindings on the tmux server, so two-finger trackpad scroll reaches tmux's scrollback even from inside a Claude Code TUI pane. Idempotent — only writes bindings if not already present.
- **`START-HERE.md`** — one-shot Claude-Code-pasteable install prompt for new Macs.

### Changed

- **`subctl install` now wires statusline + Stop hook into every Claude config dir**, not just `~/.claude`. Each per-account `settings.json` gets its own `statusLine` pointing at its own per-dir scripts. Previously only the default `~/.claude` was patched, so the radar bar never appeared under `claude-use <alias>` because Claude Code reads from the per-account config dir.
- **`subctl accounts add`** wires the new account's config dir immediately; no `subctl install` re-run required.
- **`subctl doctor`** iterates every Claude config dir and reports per-dir statusLine state + symlink integrity.
- **Usage cache TTL bumped to 5 min**, with a manual `POST /api/refresh` for force-refresh.

### Fixed

- **Statusline missing in alias-launched sessions** — see "Changed" above.
- **`claude()` shell guard** now passes through subcommands and non-interactive flags, so `claude --version`, `claude doctor`, etc. work uninterrupted.
- **Dashboard ctx %** auto-detects 1M-context model variants instead of assuming 200k.
- **Dashboard rate-limit verdict** reflects honest signal rather than aggregate noise; events table cleaner.

## [0.4.2] — 2026-05-04

Dashboard rebuild + tmux PATH fix.

## [0.4.1] — 2026-05-04

`deck` (Go + Bubble Tea TUI) restored after the v0.4.0 rip-out turned out to be premature.

## [0.4.0] — 2026-05-04

Dropped the Go-based deck TUI in favor of `sesh` integration. Reverted in 0.4.1.

## [0.3.0] — 2026-05-04

`subctl deck` — Go + Bubble Tea live session manager TUI.

## [0.2.0] — 2026-05-04

First-class shims for `claude-teams`, `claude-radar`, `claude-dash`.

## [0.1.0]

Initial multi-account isolation, statusline, and Stop hook for Claude Code.
