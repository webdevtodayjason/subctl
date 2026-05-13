# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical version source is the `VERSION` file at the repo root. `lib/core.sh`, `bin/subctl`, the dashboard, and the master daemon all derive their version string from it. To bump: edit `VERSION`, append a CHANGELOG entry, commit, push — `subctl update` on every host pulls the new version automatically.

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
