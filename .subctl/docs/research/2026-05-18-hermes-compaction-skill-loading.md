# Hermes ↔ subCTL: compaction, skills, scheduling, proxy

Date: 2026-05-18
Author: claude-subctl (worker, dispatched by master)
Source release: **Hermes Agent v0.14.0 (v2026.5.16)** — "The Foundation Release"
Source repo: `/Users/you/code/hermes-agent` @ `55c9f3206` (main)
Handoff: `.subctl/docs/handoffs/2026-05-18-hermes-compaction-skill-loading-research.md`

## TL;DR

Hermes solves four problems subCTL solves differently or not at all. Each is worth borrowing, in this order:

1. **Cron scheduler** — Hermes ships durable, recurring jobs with stable IDs, `[SILENT]` filtering, and per-job delivery routing. subCTL has one-shot self-prompts only. Highest leverage / smallest blast radius.
2. **Skill-as-lazy-context** — Hermes keeps a compact skill *index* in the system prompt and lazy-loads bodies via a `skill_view(name)` tool call. subCTL eagerly folds every `loaded_by_default: [evy]` skill body into Evy's system prompt at every turn. Adopting the index pattern reclaims thousands of tokens.
3. **Model-aware compaction with summary preamble** — Hermes' threshold is a fraction of the loaded model's context window (default 50%, model-override to 75%), summarization is an LLM call into a structured template that names the active task / goal / pending asks, and the summary is fenced with `[CONTEXT COMPACTION — REFERENCE ONLY]`. subCTL's fixed 25k/40k absolute thresholds break the moment we change supervisor models.
4. **OpenAI-compatible local proxy** for OAuth subscriptions — *less mature than the release notes imply* (only one adapter ships in v0.14.0). Worth adopting Hermes' contract; not worth re-implementing.

Plus two **operator-requested adds** that ride along with this work: a Hermes-Proxy integration for subscription-mediated OpenAI access, and **xAI Grok via SuperGrok OAuth** with `grok-4.3`'s 1M-token window — both treated as new subCTL provider slices, not as Hermes-internal features.

---

## 1 · Compaction

### Hermes (`hermes-agent/agent/context_compressor.py`, `agent/context_engine.py`)

- **Trigger**: post-response check, not prompt-composition JIT. After every API turn `should_compress(prompt_tokens)` evaluates the *last observed* prompt-token count from the API response against a dynamic threshold (`context_compressor.py:493–513`).
- **Threshold**: `int(context_length × threshold_percent)` with floor `MINIMUM_CONTEXT_LENGTH` (`context_compressor.py:439–441`). Default `threshold_percent = 0.50` (`run_agent.py:2119`). Model-aware overrides exist (e.g. Arcee Trinity thinking → 0.75 at `auxiliary_client.py:227–239`). The Hermes session you observed compacting at "153,281 tokens vs 136,000 threshold" is consistent with a ~272K model at 50%.
- **Anti-thrashing**: if the last two compactions each saved <10%, the next one is skipped (`context_compressor.py:503–512`).
- **What survives verbatim**:
  - System prompt (always).
  - First `protect_first_n` non-system messages (default 3) — `context_compressor.py:1188–1206`.
  - A *token-budgeted* tail (~20% of threshold) selected by `_find_tail_cut_by_tokens()` — `context_compressor.py:1426`. Not a fixed message count.
  - Tool definitions + skill *registrations*: unchanged, because they live in the system prompt.
- **Summarization**: structured LLM call against a cheap/fast auxiliary model (Haiku / Flash). The summarizer preamble (`context_compressor.py:825–836`) treats prior turns as "source material for a compact record" and redacts secrets. Output template (`:840–892`) is sectioned: Active Task, Goal, Constraints, Completed Actions, Active State, In Progress, Blocked, Key Decisions, Resolved Questions, Pending User Asks, Relevant Files, Remaining Work, Critical Context. On re-compaction it edits the *prior* summary rather than starting fresh (`_previous_summary` at `:799`).
- **Cheap pre-pass**: before the LLM call, old tool results are replaced with one-line summaries like `[read_file] read config.py from line 1 (3,400 chars)` — `:519–538`. Often this alone gets the budget under control.
- **Summary fencing**: prefixed with `[CONTEXT COMPACTION — REFERENCE ONLY]` and explicit "memory.md / user.md remain ALWAYS authoritative" (`:37–50`, `:45–47`). The model treats it as passive handoff, not active instructions.
- **Skill state after compaction**: NOT carried in the summary. Skills are stateless across compactions — the system-prompt index remains, and the model re-pulls bodies on demand. (See §2.)
- **User-visible signal**: console emits `⟳ compacting context…` (`run_agent.py:15236`); TUI tracks a `compressions?: number` counter (`gatewayTypes.ts:167`).

### subCTL today (`components/master/compact-policy.ts`)

- **Trigger**: JIT at prompt composition (`decideCompactAction` at `:179`). Also a safety-net ticker for tool outputs generated *after* composition.
- **Thresholds**: absolute tokens by default — `warn_tokens: 25_000`, `compact_tokens: 40_000`, `target_tokens: 30_000`, `keep_recent: 6` (`:91–97`). Numbers come from the 2026-05-12 M3 Ultra overflow incident on a 65k window.
- **Back-compat path**: if the operator's `compact.json` still uses `threshold_pct` (v2.7.2 shape), the daemon falls back to percentage mode against `loaded_ctx`, warning 10pp below compact threshold (`:218–254`).
- **Preserve**: caller-defined `keep_recent` last turns.
- **Summarize**: caller's job; this module is pure decision-only.
- **Skill state after compaction**: subCTL re-injects skills at every prompt composition (skills are part of the system prompt build), so they survive automatically — but at the cost of recomputing their tokens every turn.

### Gap

| Dimension | Hermes | subCTL | Adopt? |
|---|---|---|---|
| Threshold source | model-aware fraction (`% × loaded_ctx`) | absolute tokens, drifting from model size | **YES** — make the default percent-of-loaded, keep absolutes as override |
| Trigger timing | post-response | JIT pre-compose | tied — subCTL's pre-compose is arguably safer (prevents overflow on next turn) |
| What summarizes | LLM call w/ structured template | caller-responsibility (no canonical template in subCTL) | **YES** — port the Active Task / Pending Asks template |
| Cheap pre-pass (tool-result shrinking) | yes | no | **YES** — biggest immediate win, no LLM cost |
| Anti-thrash skip | yes (last 2 compactions <10%) | no | **YES** |
| Summary fencing | `[CONTEXT COMPACTION — REFERENCE ONLY]` + "memory.md authoritative" | n/a | **YES** — reduces post-compact confusion |
| Visible signal | console + TUI counter | dashboard SSE on compact event | parity, just verify both surface it |

### Recommended slice: **compact-v2**

Files to touch (~250 lines net):

- `components/master/compact-policy.ts` — add `threshold_percent` to `CompactConfig`; new resolution order is `model_threshold_percent → cfg.compact_tokens → cfg.threshold_pct → default 0.50`. Add `recently_saved_pct` to `CompactDecision` so the caller can wire anti-thrash.
- `components/master/compactor.ts` (new) — pure summarization module. Pre-pass shrinker over tool results. LLM-call template literal. Wraps output in the `[CONTEXT COMPACTION — REFERENCE ONLY]` fence. Reuses `callSupervisor` from `memory-kernel-reviewer.ts` so we don't couple to a specific provider.
- `components/master/server.ts` — wire the new compactor into the existing JIT decision path. Keep the safety-net ticker but route both through `compactor.ts`.
- Tests: drop-in for current `compact-policy.test.ts` plus new `compactor.test.ts` covering the shrinker + template.

**Risk**: low. Pure logic, additive. Worst case the structured summary is too rigid for a given turn — model just narrates the gap.

---

## 2 · Skill loading

### Hermes (`hermes-agent/agent/skill_commands.py`, `agent/prompt_builder.py`, `tools/skills_tool.py`)

- **Discovery**: filesystem walk over `~/.hermes/skills/` plus configured `skills.external_dirs` (`skills_tool.py:550–624`). Format: `category/skill-name/SKILL.md` with YAML frontmatter. Two-layer cache (LRU + disk snapshot at `~/.skills_prompt_snapshot.json`, indexed by mtime/size) — `prompt_builder.py:854–1110`.
- **Index in system prompt**: `build_skills_system_prompt()` (`prompt_builder.py:988–1219`) renders only category → name + ~100-char description, wrapped in `<available_skills>` with instructions to call `skill_view(name)` to pull full content. **Static — rebuilt only at session start or after compaction.** Never mid-turn.
- **Lazy load**: model calls `skill_view(name)`; `_build_skill_message()` (`skill_commands.py:138–238`) injects the full SKILL.md body as a **user/assistant message into the conversation**, not into the system prompt. Wrapped in an `activation_note` block: `[IMPORTANT: The user has invoked the "X" skill ...]`. Supporting files (templates, scripts) are listed with paths so the model can re-`skill_view(name, file_path=…)` on demand.
- **Trigger selection**: model-driven from the index. Frontmatter `requires_toolsets / requires_tools / fallback_for_*` gate visibility before the model even sees the entry.
- **Visible "📚 skill X" event** (`display.py:948–949`) is BOTH UI feedback AND genuine context injection — the skill body really does land in `messages` and is visible on the next turn. Not theater.
- **Platform filtering**: `platforms:` frontmatter restricts skills to specific OS targets.

### subCTL today (`components/master/skills-registry.ts`)

- **Discovery**: four sources unified — repo (`components/skills/`), imported (`~/.config/subctl/skills/<source>/skills/…/SKILL.md`), evy-authored (`~/.local/state/subctl/evy-skills/`), project-local (`<project>/.subctl/skills/`). Pure functions, no cache.
- **Categories**: `evy-loaded` (scope=evy or `loaded_by_default` includes "evy"), `team-developer`, `evy-authored`, `project-local`.
- **Injection**: every skill whose category resolves to `evy-loaded` is folded into Evy's master system prompt **at every prompt composition**. Full body, not index. The compose path lives at `server.ts:1350` (`composeSystemPrompt()` call) and `:2224` (`(agent.state as any).systemPrompt = newPrompt`).
- **Lazy load**: none. There is no `skill_view` analog. Skills are either always-on (evy-loaded) or unreachable from the supervisor's turn.
- **Authoring**: `authorEvySkill / promoteEvySkill / deleteEvySkill` let Evy draft skills under `~/.local/state/subctl/evy-skills/` and the operator promotes into the repo. Solid; no Hermes equivalent.

### Gap

The big one is **eager vs lazy**. Every evy-loaded skill body lives in Evy's system prompt every turn. At ~600 tokens average per skill and 5+ evy-loaded skills today, that's 3k+ tokens spent on instructions Evy may not need this turn. Hermes pays ~80 tokens (one index entry) per available skill and ~600 only when actually invoked.

| Dimension | Hermes | subCTL | Adopt? |
|---|---|---|---|
| System-prompt footprint per available skill | ~80 tok (index entry) | ~600 tok (full body, if evy-loaded) | **YES** — switch to index + lazy load |
| Loading trigger | `skill_view(name)` tool call | always-on | **YES** — add `skill_load(name)` tool |
| Discovery cache | LRU + disk snapshot indexed by mtime/size | none | **NICE-TO-HAVE** — current cost low; revisit if registry grows |
| Visible event | `📚 skill X` in TUI | dashboard skills tab + SSE | parity |
| Platform filter in frontmatter | yes | no | **NO** — subCTL fleet is uniform macOS |
| Authoring loop | n/a | `authorEvySkill / promoteEvySkill` | keep (Hermes loses here) |

### Recommended slice: **skills-lazy**

Files to touch (~400 lines net):

- `components/master/skills-registry.ts` — add `renderSkillIndex(category)` → string of category → name + truncated description, wrapped in `<available_skills>` tag matching Hermes' contract.
- `components/master/tools/skill-load.ts` (new) — `skill_load(name)` master tool. On invoke, reads the SKILL.md body, returns it as the tool result (Evy receives it as content on her next turn — exactly how Hermes does it).
- `components/master/server.ts` (`composeSystemPrompt()`) — replace the current "fold every evy-loaded body" with the index. Keep a small allowlist (e.g. `core: true` frontmatter flag) for skills that genuinely need to be always-on — currently 1–2 skills qualify.
- Migration: add `core: true` to whichever skill bodies are too foundational to lazy-load (likely `orchestrator-mode`'s activation guard and the team-contract preamble). Everything else loses always-on by default; operator can flip it back per-skill.
- Tests: snapshot test for the rendered index; integration test that `skill_load("foo")` returns the right body.

**Risk**: medium. Some skills today rely on always-on injection to mediate Evy's behavior (e.g. memory-handling instructions). Migration needs an audit pass — likely 30 min of operator review per skill. Suggest dry-running with one skill flipped lazy before the broader cutover.

---

## 3 · Scheduling / cron

### Hermes (`hermes-agent/cron/jobs.py`, `cron/scheduler.py`, `tools/cronjob_tools.py`)

- **Implementation**: first-class Hermes feature. No system cron / launchd. In-process 60s tick from the gateway (`gateway/run.py` `_start_cron_ticker`) on a background thread.
- **Store**: JSON file at `~/.hermes/cron/jobs.json` with a `threading.Lock` for concurrent writes (`jobs.py:39,44`).
- **Job IDs**: `uuid.uuid4().hex[:12]` — 12-char hex, stable, persisted (`jobs.py:561,598`).
- **Lifecycle tool**: single unified `cronjob` action-based tool (`tools/cronjob_tools.py:287–538`) — `create / list / update / pause / resume / remove / run / trigger`. CLI mirrors at `hermes_cli/cron.py`.
- **Schedule formats**: cron expressions (`{kind: "cron", expr: "0 9 * * *"}`) and other interval/one-shot kinds.
- **Per-job fields**: `prompt`, `skills[]` (preloads named skills before the job's turn), `deliver` (one or many of `origin / local / telegram[:CHAT[:THREAD]]`), `repeat: {times, completed}`, `next_run_at`, `last_run_at`, `last_status`, `state`, `enabled`.
- **Silent-unless-interesting**: `_build_job_prompt()` (`scheduler.py:933–943`) instructs the agent to respond with literal `[SILENT]` if nothing's worth reporting. `tick()` scans for `SILENT_MARKER = "[SILENT]"` (`scheduler.py:130`) and suppresses delivery. **Designed, not emergent.**
- **Delivery routing**: `_resolve_single_delivery_target` (`scheduler.py:259–342`) parses the `deliver` string; `_deliver_result` (`:489–667`) prefers a live adapter when the gateway is running (E2EE-aware), falls back to a standalone HTTP send. Configurable metadata wrapping (`cron.wrap_response`).
- **`no_agent: true`**: jobs can run pure scripts without an agent turn at all (`tests/cron/test_cron_no_agent.py`).

### subCTL today (`components/master/tools/scheduler.ts`)

- **One-shot self-prompts only** — `schedule_followup / list_followups / cancel_followup`.
- Append-only JSONL at `~/.config/subctl/master/followups.jsonl`. 60s ticker in `server.ts:4097–4133`.
- IDs: `fu_<ms>_<random6>` — unique but not human-recognisable across replay.
- **No recurrence, no cron expressions, no skill attachment, no delivery routing, no pause/resume, no silent filter, no script-only mode.** Followups always dispatch as synthetic agent prompts into Evy.
- Use case Hermes covers and subCTL doesn't: "every weekday at 0830, summarize overnight account-rate changes and Telegram-deliver only if anything is yellow-or-worse."

### Gap

This is the largest functional gap. subCTL has one tool; Hermes has a small orchestration platform on top of the same tick. Watching for Jason's morning briefing + 2h silent watcher pattern, both of those are impossible to express in subCTL today without manually re-arming `schedule_followup` each fire.

### Recommended slice: **cron-followups**

Files to touch (~600 lines net):

- `components/master/tools/scheduler.ts` — extend `Followup` schema with optional `schedule: {kind: "cron"|"interval"|"once", expr?: string}`, `repeat: {times: number|null, completed: number}`, `skills: string[]`, `deliver: string[]`, `silent_marker: string` (default `[SILENT]`), `enabled: boolean`, `paused_at?: string`.
- `components/master/tools/scheduler.ts` — split the monolithic tool into `schedule_create / schedule_list / schedule_update / schedule_pause / schedule_resume / schedule_remove / schedule_trigger` to mirror Hermes' action surface. Keep `schedule_followup` as a thin wrapper for back-compat.
- `components/master/cron-parser.ts` (new) — small cron-expression evaluator for `next_run_at`. Existing `cron-parser` npm packages are fine if we want to skip writing it ourselves.
- `components/master/server.ts:4097–4133` — the existing 60s ticker grows a `[SILENT]`-aware delivery path and a per-job `next_run_at` computer.
- New: `components/master/delivery-router.ts` for `telegram / dashboard-sse / inbox / no-op`.
- Skill preload: when a job has `skills: [foo]`, the synthetic prompt prepends `skill_load("foo")` calls — depends on the §2 slice landing first if we want the lazy path; if §2 is delayed, fall back to "include skill body inline."
- Tests: `scheduler.test.ts` grows recurrence + silent-marker cases; `delivery-router.test.ts` new.

**Risk**: medium. State migration from the existing JSONL is straightforward (older entries map to `{kind: "once"}`). Hardest part is `[SILENT]` parsing — needs to be robust against models that emit `[SILENT]` mid-prose or wrap it in markdown.

---

## 4 · OpenAI-compatible proxy *(operator-requested addition)*

### What v0.14.0 actually ships (`hermes_cli/proxy/`)

- aiohttp server, default `127.0.0.1:8645` (`server.py:52–53,85–209`).
- Endpoints: `GET /health` and `ALL /v1/{tail:.*}` catch-all forwarder (`:205,207`). Allowed paths are adapter-declared (Nous Portal exposes `/chat/completions`, `/completions`, `/embeddings`, `/models` — `nous_portal.py:32–39`).
- Adapter registry at `hermes_cli/proxy/adapters/__init__.py:15-17` — **`{"nous": NousPortalAdapter}` and only that.** Despite the release notes' claim of "Claude Pro, ChatGPT Pro, SuperGrok," v0.14.0 ships a single adapter. The OAuth state for those other providers exists in `~/.hermes/auth.json` but no proxy adapter consumes them yet.
- One process = one upstream. `hermes proxy start --provider nous`. No per-request account selection. Client's `Authorization` header is stripped and replaced with the adapter's freshly-minted bearer (`server.py:66,151`).
- Token storage: `~/.hermes/auth.json` w/ cross-process file lock (`auth.py:6,963–1000`).
- Streaming: transparent — `iter_any()` chunks pass straight through, SSE preserved (`server.py:192–194`).
- No tool-use translation, no aggregation, no rate-limit awareness, no dashboard.
- Auth-check before start: `is_authenticated()` must return true (`cli.py:46–52`).

### What "single source proxy for Subscriptions OpenAI API" means in subCTL terms

Reading the operator's intent against Hermes' actual surface: the goal is for any OpenAI-compatible *client* (Codex, Aider, Cline, Continue, the master daemon itself) to hit one local endpoint and have the proxy decide which OAuth-authed subscription seat to consume. Hermes' proxy is *almost* that, but only for Nous and only one account per process.

### Two adoption paths

**Option A — "Use Hermes-as-upstream" (low effort, ships now)**

- subCTL starts `hermes proxy start --provider nous` as a managed launchd job.
- Master's `supervisor.providers.nous_via_hermes_proxy` points at `http://127.0.0.1:8645/v1`.
- subCTL gains Nous Portal as a supervisor option immediately, gated by the operator's existing Hermes OAuth state.
- No code in subCTL except provider-table entry + launchd plist.

**Option B — "Mirror Hermes' adapter shape in subCTL" (higher effort, future-proof)**

- New `components/master/proxy/` mirroring `hermes_cli/proxy/`:
  - `server.ts` — Bun http server on (say) 8645.
  - `adapters/{base,openai_codex,claude_pro,supergrok}.ts` — each wraps an OAuth state under `~/.config/subctl/master/oauth/<provider>.json` (where we already store the codex one).
- subCTL gets multi-account routing via header (`X-Subctl-Account: claude-jason`) and the proxy resolves the seat from accounts.conf.
- Aider / Cline / Continue / Claude Code itself become first-class subCTL clients.
- This is the version that actually delivers "single source proxy for *all* OAuth subscriptions" — Hermes hasn't built it yet.

### Recommended slice: **proxy-hub** (Option A now, Option B as Phase 2)

- **Phase 1** (Option A, ~50 lines + plist): treat Hermes proxy as a pinned dependency. Document the boot order (Hermes proxy must be up before master tries to use the upstream). Add a `pi-ai-catalog.ts` entry for "Nous via Hermes proxy." Surface in the dashboard accounts tab.
- **Phase 2** (Option B, ~800 lines): only if and when we want multi-account routing, ChatGPT Pro / Claude Pro / SuperGrok seats, or to remove the Hermes dependency. The shape is well-known from Hermes; the work is mostly OAuth flows per provider and a router.

**Risk**: Phase 1 — low (we depend on a v0.14.0 surface that may shift; pin the version). Phase 2 — medium-high (OAuth flows for ChatGPT Pro / Claude Pro are reverse-engineered and have historically been fragile).

---

## 5 · xAI Grok via SuperGrok OAuth *(operator-requested addition)*

### What v0.14.0 ships in Hermes

- Provider id `xai-oauth` registered as "xAI Grok OAuth (SuperGrok Subscription)" — `hermes_cli/models.py:932`.
- Top model `grok-4.3` (`models.py:126`, `_XAI_TOP_MODEL`); also registered as `x-ai/grok-4.3` (`models.py:58,186`).
- Older grok-4 family models (grok-4, grok-4-0709, grok-4-fast variants, grok-4-1-fast variants, grok-code-fast-1) all alias up to `grok-4.3` per the comment at `models.py:116–117`.
- OAuth provider implementation at `hermes_cli/auth.py` (search keys: `supergrok`, `xai_oauth`, etc.).
- Release notes (Jason, paste 2026-05-18): "xAI Grok lands as a SuperGrok OAuth provider with grok-4.3 bumped to a 1M context window."
- Hermes also has free-tier xAI plugins for image_gen / video_gen but those are separate from the OAuth-subscription seat.

### subCTL today

- `pi-ai-catalog.ts:176` registers `xai` as `{ display: "xAI (Grok)", auth: "api-key", notes: "XAI_API_KEY" }` — API-key only, no OAuth, no SuperGrok seat handling.
- pi-ai's `KnownProvider` union includes `xai` and `groq` but not `xai-oauth`.
- Models registry has the grok-3 / grok-4 family via pi-ai's generated models file but no 1M-context flag for grok-4.3 (`node_modules/@earendil-works/pi-ai/dist/models.generated.d.ts`).

### Gap

- No OAuth flow → no SuperGrok seat — operator pays metered API instead of using the existing subscription.
- No first-class `grok-4.3` provider in subCTL — pi-ai surfaces the model, but the catalog calls it API-key only and the compaction defaults assume 65k windows, not 1M.

### Recommended slice: **xai-supergrok**

Files to touch (~350 lines net):

- `components/master/xai-supergrok-auth.ts` (new) — mirrors `openai-codex-auth.ts:1–143`. OAuth device-code flow (assume so; Hermes' `auth.py` is the reference). Token storage at `~/.config/subctl/master/oauth/xai-supergrok-<account>.json` to match the existing codex layout.
- `components/master/pi-ai-catalog.ts:176` — split `xai` (api-key) from new `xai-oauth` (SuperGrok). Mark `grok-4.3` with `context_window: 1_000_000` so model-aware compaction (§1) computes the right threshold.
- `components/master/openai-codex-auth.ts` — refactor the codex-specific bits into a shared `oauth-provider.ts` helper if patterns repeat. (Likely worth it; defer until both are in flight.)
- `bin/subctl auth xai-supergrok <alias>` — CLI verb mirroring `bin/subctl auth claude <alias>` / `bin/subctl auth codex <alias>`.
- Dashboard accounts tab — extend the account-verdict rules to understand SuperGrok's rate-limit response shape (Hermes' `nous_subscription.py` / equivalent has the reference for what the rate-limit headers look like).
- Tests: auth fixture + provider-resolution + verdict-classification.

**Risk**: medium. SuperGrok OAuth surface may not be fully public — Hermes' implementation is the operative ground truth and may have undocumented quirks. The 1M context is a marketing claim that needs verification under load (Hermes' compaction kicks in at 50% of declared `context_length`, so we'd be compacting at 500k tokens; want to confirm the supervisor doesn't degrade much earlier).

---

## 6 · Comprehensive v0.14.0 feature triage

Full pass through the v0.14.0 release notes. Format: **feature** (Hermes PR refs) — what it is. **subCTL:** verdict + slice tag if recommended.

Anchor: items already covered as primary slices are §1 compact-v2, §2 skills-lazy, §3 cron-followups, §4 proxy-hub, §5 xai-supergrok. Those are not repeated below.

### 6.1 · Providers + supervisor plumbing

- **Codex app-server runtime for OpenAI/Codex models** (#24182, #25769) — drives OpenAI Codex CLI under the hood with session reuse, automatic retirement of wedged sessions, OAuth refresh classification. **subCTL:** partial coverage already in `components/master/openai-codex-auth.ts` + `codex-oauth.ts`. Worth a diff-pass against Hermes' implementation to lift the session-retirement + refresh-classification patterns. Candidate slice **codex-runtime-parity** — ~200 lines, lands resilience to long-run wedges.
- **OpenRouter Pareto Code router with `min_coding_score` knob** (#22838) — auto-pick cheapest model that meets a coding-quality floor. **subCTL:** Evy already routes through OpenRouter for some paths; the Pareto router is a config knob, not new infra. Candidate slice **pareto-routing** — ~50 lines (config + dashboard surface). Pairs with §5 nicely (Grok-4.3 becomes a Pareto candidate).
- **NovitaAI as a new model provider** (#25507) — open-source model host (Llama / Qwen / DeepSeek) with their own pricing. **subCTL:** one-line add to `pi-ai-catalog.ts` if pi-ai already supports it (does — `KnownProvider` lacks `novita` so likely needs catalog patch). Low priority unless Jason wants Novita as a fallback tier.
- **Provider rename Alibaba → Qwen Cloud** (#24835) — cosmetic. **subCTL:** ensure `pi-ai-catalog.ts` display strings match if/when we surface it.

### 6.2 · Performance + caching

- **Cold-start perf wave (~19s off `hermes` launch)** (#22138, #22120, #22681, #22790, #22808, #22831, #22859, #22904, #22766, #25341) — deferred heavy adapter imports, disk-cached model catalogs, parallel doctor checks, `chat -q` skips welcome banner. Tools All-Platforms screen 14s → 1.5s. **subCTL:** master daemon boot today is Bun startup + memori sidecar handshake + initial tmux-state walk. Same patterns map directly. Candidate slice **master-cold-start** — measure first (`time bun run components/master/server.ts --healthcheck`), then port the lowest-hanging wins. ~300 lines.
- **Cross-session 1h Claude prompt cache** (#23828, #25434, #24778) — system prompt + skills + memory cached for an hour across `/new` sessions on Anthropic / OpenRouter / Nous Portal. Background memory review hits the cache too. **subCTL:** the supervisor's prefix is stable IF compaction (§1) lands a deterministic ordering. Anthropic's prompt cache is opt-in via API headers. Candidate slice **supervisor-prompt-cache** — depends on §1; ~100 lines after that lands. Direct $$ saving.
- **180x faster `browser_console` evaluations** (#23226) — persistent CDP connection vs. spinning a new DevTools session per call. **subCTL:** NA today (no browser automation). Relevant the moment CloakBrowser/browser work lands per the parallel research thread.

### 6.3 · Notification + messaging surfaces

- **Native button UI for `clarify` on Telegram and Discord** (#24199, #25485) — multiple-choice → inline buttons, tap-to-answer. **subCTL:** **already in this report as slice telegram-buttons** (see below "carried over"). ~150 lines, no auth churn.
- **Microsoft Teams end-to-end** (#21922, #21969, #22007, #22024) — Graph auth + webhook listener + pipeline runtime + outbound delivery. **subCTL:** notification target gap — Jason currently only gets Telegram alerts. Teams would matter for MSP-client-facing notifications. Candidate slice **teams-notifications** — ~600 lines (OAuth + webhook + delivery), only build if Jason wants client-facing channels.
- **Discord channel history backfill (default on)** (#25984) — on join, read recent history so the agent has context. **subCTL:** subCTL doesn't run on Discord, but the *pattern* matters — when Evy walks into a new project mid-stream she has no history. Candidate slice **project-history-backfill** — ~200 lines, walks recent git log + recent dashboard SSE events on first interaction with a new project.
- **LINE + SimpleX Chat (now 22 platforms total)** (#23197, #26232) — new messaging adapters. **subCTL:** NA — Telegram + dashboard is enough; revisit only if Jason wants a specific channel.

### 6.4 · Agent capabilities

- **`x_search` — first-class X/Twitter search** (#26763) — search timeline, find threads, OAuth-or-API-key. **subCTL:** Evy has no X surface. Candidate slice **x-search-tool** — one master-tool file (`components/master/tools/x-search.ts`), reuses Hermes' OAuth helper pattern. ~150 lines.
- **`vision_analyze` returns pixels to vision-capable models** (#22955) — when the active model can see (GPT-5 / Claude / Gemini / Grok-vision), Hermes passes raw pixels instead of text-summarizing first. **subCTL:** Evy has no vision tool. Candidate slice **vision-analyze-tool** — ~200 lines, must wait until §5 lands so Grok-4.3-vision is reachable. Useful for dashboard-screenshot-driven debugging.
- **Per-turn file-mutation verifier footer** (#24498) — after every turn that wrote/edited files, the agent gets a footer listing paths + line counts + actual delta. Catches "claimed to write but didn't" failures. **subCTL:** strongly relevant — Evy occasionally claims an edit landed when it didn't. Candidate slice **post-turn-file-verifier** — ~250 lines (snapshot fs hashes pre-turn, diff post-turn, append footer to model context). Pairs naturally with the existing verifier cluster (`components/master/verifier.ts`).
- **LSP semantic diagnostics on every write** (#24168, #25978) — write_file / patch runs a real language server, surfaces type errors / undefined symbols / missing imports back to the agent. **subCTL:** big quality lift for Evy editing TS in the subctl repo itself. Candidate slice **lsp-write-diagnostics** — depends on the post-turn-file-verifier slot; ~400 lines (LSP client + write-hook + footer injection). Tier-2 dependency on TypeScript LSP being available (typescript-language-server).
- **`computer_use` cua-driver backend** — works with non-Anthropic models (#21967, #24063) — Hermes' computer-use is no longer Anthropic-SDK-locked. Works with any vision-capable model. **subCTL:** NA today (no GUI driving). Relevant if Evy ever needs to drive the dashboard UI for screenshot QA.
- **Unified `video_generate` w/ pluggable provider backends** (#25126) — one tool, any video model. **subCTL:** NA.
- **Clickable URLs in any terminal (OSC8)** (#25071, #24013) — agent output's links become real hyperlinks in iTerm2 / Kitty / Ghostty / Windows Terminal. **subCTL:** dashboard already renders links; CLI output (`subctl status`, `subctl orch list`) does not. Candidate slice **osc8-cli-links** — ~30 lines, one-line emit-helper in `lib/core.sh`. Trivial quality-of-life.

### 6.5 · Loops + supervision

- **`/handoff` — live session transfer** (#23395) — moves an active session (messages, tool calls, context) to a different model / persona / profile without dropping anything. **subCTL:** subCTL hands off via .md files today (see this report's sibling handoffs). Hermes hands off live. Candidate slice **live-handoff** — ~400 lines, depends on §1's compactor (handoff payload = compaction summary + recent tail). Relevant for the "supervisor swap mid-task" case Jason has hit.
- **`/goal` + `/subgoal` — persistent agent loop with appendable success criteria** (#25449) — already in slice **persistent-goals** below (see "carried over"). ~500 lines, rides §3's tick infrastructure.
- **API server exposes run approval events** (#21899) — long-running HTTP-API runs no longer silently hang on approval-required commands; the approval surfaces on the API stream. **subCTL:** dashboard's spawn/operate API already returns approval state for some flows but lacks a unified "in-flight approval queue" the operator can poll. Candidate slice **approval-event-stream** — ~150 lines, SSE event on the existing dashboard stream when a tool wants approval.

### 6.6 · Skills + plugins

- **`huggingface/skills` as a trusted default tap** (#26219) — community skills index wired into the Skills Hub by default. **subCTL:** subctl has `subctl skills import` for catalog sources (operator-controlled). Candidate slice **hf-skills-tap** — ~50 lines, add huggingface/skills to the default catalog list. Trivial.
- **9 new optional skills** (#23582, #23583, #23590, #25299, #26760, #26729, #26765, #21881, #26612):
  - **Hyperliquid** (perp + spot trading) — irrelevant to subctl scope.
  - **Yahoo Finance** (live market data) — irrelevant.
  - **api-testing** (REST + GraphQL debug recipes) — useful for Evy when debugging subctl's HTTP surfaces.
  - **unified EVM multi-chain** (Ethereum + L2s + Base) — irrelevant.
  - **darwinian-evolver** (evolutionary prompt/skill tuning) — meta-interesting; could evolve subctl's own skills. Tier-3 curiosity.
  - **osint-investigation** (people/domains/orgs) — useful for callscrub.io or silver-intel work, less for subctl itself.
  - **pinggy-tunnel** (expose local services publicly) — useful for the subctl dashboard if Jason ever wants temporary remote access.
  - **watchers** (RSS / HTTP JSON / GitHub polls via cron no_agent mode) — **directly pairs with §3's cron-followups slice**. Adopt as part of the cron rollout.
  - **Notion overhaul** (May 2026 Developer Platform) — useful if Jason migrates more docs to Notion.
  - Candidate slice **skill-imports** — `subctl skills import huggingface/skills/api-testing huggingface/skills/watchers huggingface/skills/pinggy-tunnel`. Operator-driven, not code.
- **Plugins: `ctx.llm` + `tool_override`** (#23194, #26759) — Hermes plugins can make LLM calls through active provider/credentials, and swap built-in tools cleanly. **subCTL:** subCTL doesn't have a plugin runtime today — skills are markdown only. This would be a meaningful architectural addition (`components/master/plugins/`). Candidate slice **master-plugin-runtime** — ~800 lines, only build if Jason wants third-party extension story. Tier-2 priority.
- **Brave Search + DDGS as web-search providers** (#21337) — two new free web-search backends. **subCTL:** Evy uses TinyFish for web search (per CLAUDE.md). Candidate slice **brave-ddgs-fallback** — ~100 lines, useful as a free-tier fallback when TinyFish quota is exhausted.

### 6.7 · Packaging + safety

- **`pip install hermes-agent`** (#26593, #26148) — Hermes is now a real PyPI package. Wheel ships TUI + shell launcher. **subCTL:** subctl ships via `install.sh` (operator-controlled). The PyPI analog would be a Homebrew tap or `npm install -g @subctl/cli`. Candidate slice **subctl-installable** — ~200 lines + tap setup, depends on how widely Jason wants distribution.
- **Debloating wave** (#24220, #24515, #25014, #25038, #25766, #21818) — lazy-install heavy backends (Slack / Matrix / Feishu / DingTalk / Pixverse / Camofox / image-gen / voice/TTS), `[all]` extras drop what's lazy-covered, tiered install falls back when wheels reject, supply-chain advisory checker. **subCTL:** subctl's install is already lighter (Bun + a few CLIs). The supply-chain-advisory pattern is interesting — Candidate slice **install-advisory-checker** — ~150 lines, run `npm audit --audit-level=high` (or bun equivalent) post-install + Telegram-alert on findings.
- **Sudo brute-force block + 3 dangerous-command bypasses closed + tool-error sanitization** (#23736, #26829, #26823) — approval gate blocks `sudo -S` brute-force, classifies stdin-fed / askpass-stripped sudo as DANGEROUS, three known bypasses closed (inspired by Claude Code's command-detection), tool error strings sanitized before re-injection so a malicious file or remote service can't pass instructions through error output. **subCTL:** bash-gate policy (`components/master/policy/`) already handles approval. Tool-error sanitization is the new addition — Candidate slice **tool-error-sanitization** — ~120 lines, strip control sequences + likely-prompt-injection patterns from error strings before they re-enter Evy's context. Pairs with the verifier cluster.

### 6.8 · Platform + misc

- **Native Windows support (early beta)** (#21561) — cmd.exe + PowerShell, no WSL needed. **subCTL:** macOS-only fleet; NA.
- **Zed ACP Registry — uvx install** (#26079, #26120, #26234) — Hermes listed in Zed's Agent Client Protocol registry; one-click install. **subCTL:** IDE plumbing; revisit only if Jason runs subctl from Zed.

### 6.9 · Patterns from the detailed PR-level changelog

These didn't make the headline release notes but show up in the per-PR detail. Architectural patterns subCTL could borrow:

- **`/sessions` — browse + resume previous sessions** (#20805, @austinpickett) — TUI command lists past sessions and lets you resume one. **subCTL:** `subctl orch list` shows currently-live tmux sessions; there is no "browse past" surface. Candidate slice **session-browser** — ~250 lines, indexes Claude config dirs' `~/.claude*/projects/*/sessions/*.jsonl` files, shows project + account + last-activity + transcript-length, supports `subctl session resume <id>`.
- **Kanban-style multi-agent orchestration** (#21435, #23012, #23578, #23550, #21541) — Hermes' `specify` lets an auxiliary LLM flesh out triage tasks; `kanban_unblock` detects stranded tasks; `stranded_in_ready` diagnostic surfaces blocked-but-claimable work. **subCTL:** team-templates currently dispatch via `subctl_team_dispatch` (one-shot, no board state). Kanban-style board state is a meaningful upgrade for tracking parallel team work. Candidate slice **team-kanban** — ~700 lines, board state at `~/.config/subctl/master/kanban.jsonl`, dashboard tab, master tools `kanban_create / kanban_claim / kanban_unblock / kanban_list`. Hermes' `specify` is the killer feature — operator drops a one-line task, auxiliary LLM expands into a structured spec, then dispatch.
- **Stream-retry diagnostics** (#23005) — log inner cause + upstream headers + bytes/elapsed on every supervisor stream drop. **subCTL:** when the supervisor's stream drops, we currently log a generic error. The detailed observability matters when debugging Codex/Anthropic intermittent failures. Candidate slice **stream-retry-diag** — ~80 lines, instrument the supervisor call sites in `server.ts`.
- **Confirm prompt for destructive slash commands** (#4069, #22687) — Hermes adds a "are you sure?" prompt for destructive verbs. **subCTL:** `subctl_orch_kill` already enforces `confirmation: true` + ≥10-char reason. Worth extending the same pattern to `subctl session-kill`, `subctl auth remove`, `subctl accounts forget`, and any other terminal verbs. Candidate slice **destructive-confirm-uniform** — ~120 lines (extract the confirmation guard into a helper, apply across CLI + tools).
- **Shareable profile distributions via git** (#20831) — Hermes profiles can be installed from a git URL. **subCTL:** subctl skills already do this (`subctl skills import <source>`); team-templates currently don't. Candidate slice **shareable-team-templates** — ~150 lines, extend `subctl templates import <git-url>` mirroring the skill-import pattern. Lets Jason publish his team rosters.
- **Scan assembled prompt (including skill content) for prompt injection in cron** (#3968) — Hermes' cron path scans synthetic prompts including injected skill content for prompt-injection markers. **subCTL:** §3 cron-followups + §6.5 persistent-goals synthesize prompts at fire time. Same scan applies. Candidate slice **synthetic-prompt-injection-scan** — ~150 lines, regex-based pattern check (the patterns Hermes uses are the reference); pairs with §3 / persistent-goals.
- **Per-platform circuit breaker + `/platform` command** (#26600) — keeps the gateway running when one platform fails; surfaces health per platform. **subCTL:** if §6.3 teams-notifications lands, the same circuit-breaker pattern prevents one bad channel from breaking notifications across the board. Candidate slice **notify-circuit-breaker** — ~200 lines, dependent on multi-channel notifications existing.
- **`HERMES_SESSION_ID` env var to agent tools** (#23847, @alt-glitch) — tools can introspect "which session am I in?" via env. **subCTL:** subctl spawned workers already get `SUBCTL_AGENT_ROLE=worker` and `SUBCTL_SPAWN_TS=<ts>` env vars; adding `SUBCTL_SESSION_ID=<tmux-session-name>` would let worker-side tools route deterministically. Trivial — Candidate slice **session-id-env** — ~10 lines in `providers/claude/teams.sh`.
- **`protect_first_n` configurable** (#25447) — Hermes' compaction lets you configure how many opening turns to preserve verbatim. **subCTL:** add to compact-v2 (§1) — `CompactConfig.protect_first_n: number` defaulting to 3. ~10 lines, fold into the §1 slice.
- **TUI: transcript scroll + Esc during approval/clarify prompts** (#26414, @OutThisLife) — operator can scroll back through context while a blocking prompt is up. **subCTL:** dashboard's prompt-modal currently blocks scroll. Candidate slice **scrollable-blocking-prompts** — ~100 lines, dashboard UI work.
- **Width-aware markdown table rendering w/ vertical fallback** (#26195, @alt-glitch) — narrow terminals fall back to vertical (`key:` `value`) instead of mangled tables. **subCTL:** `subctl orch list` and friends emit fixed-width tables that break in narrow panes. Candidate slice **responsive-cli-tables** — ~80 lines in `lib/cli.sh` print helpers.
- **YOLO-mode banner warning + status bar** (#26238) — Hermes surfaces YOLO mode prominently. **subCTL:** subctl's autonomy modes (`--dangerously-skip-permissions`, the policy gate's resolved mode) are surfaced in the spawn banner but not persistently in the status bar. Candidate slice **autonomy-status-line** — ~60 lines (dashboard + CLI). Reduces "I forgot I was in skip-perms mode" footguns.
- **Delegate tool: show user's actual concurrency / spawn-depth limits in description** (#22694) — Hermes' delegate tool's description includes the runtime-resolved limits. **subCTL:** `subctl_orch_spawn` could surface the policy's spawn-depth / per-account rate-limit headroom in its description, so the supervisor's planning is grounded. Candidate slice **dynamic-tool-descriptions** — ~150 lines, generator function that injects current limits when registering tools. Tricky because tool descriptions are usually static; needs a per-turn refresh.
- **Hide token/cost analytics behind config flag (default off)** (#25438) — privacy / clutter reduction. **subCTL:** dashboard's account cost display is already opt-in (operator-controlled by env). No-op for subctl.
- **Telegram: split-and-deliver oversized edits** (#23576) — avoids silent truncation on long bot replies. **subCTL:** subctl's notify-listener can emit large status dumps. Candidate slice **telegram-message-splitter** — ~80 lines, paginates `>4096-char` messages across multiple sends.
- **`deliver=all` fan-out in cron** (#21495) — one cron job can fan out to every connected channel. **subCTL:** fold into §3 cron-followups slice — the `deliver: string[]` field already accepts multiple targets per my design; add `"all"` as a literal that expands at fire time.
- **Cron: name-based lookup for job ops** (#26231) — operator can `cronjob pause <human-name>` instead of `cronjob pause <12-char-hex-id>`. **subCTL:** fold into §3 cron-followups — make `name` field unique-per-account-and-stable, accept either id-or-name in lookups.
- **SQLite journal_mode fallback for NFS/SMB/FUSE** (#22043, @kshitijk4poor) — `/resume` worked on network mounts after the fallback landed. **subCTL:** memori sidecar uses SQLite (`services/memori/`); if Jason ever runs subctl out of a network-mounted home (he might, fleet has shared NFS), this fallback matters. File as a tier-3 robustness improvement.
- **Codex-runtime hardenings** (#25769, #26250) — retire wedged sessions + post-tool watchdog + OAuth refresh classification + de-dup `[plugins.X]` tables + stop leaking `HERMES_HOME` into config. **subCTL:** the wedge-detection + post-tool watchdog patterns map directly onto subctl's existing codex auth path (`components/master/openai-codex-auth.ts` / `codex-oauth.ts`). Fold into the §6.1 **codex-runtime-parity** slice.

That's the floor of net-new patterns from the detailed changelog. Anything not enumerated above (i18n, Docker bootstrap, Nix flake updates, Hermes-internal CI work, MiniMax OAuth specifics, Google Workspace Drive writes, Daytona sandbox migration, Hindsight optional dep, Feishu/Slack/WhatsApp-specific tweaks) is Hermes-internal and not adopt-able for subctl's scope.

---

## 7 · Risks / open questions

1. **Compaction-summary fidelity under structured templates.** Hermes' template names 13 sections. Evy's turns often don't have content for half of them (e.g. no `Blocked` items, no `Pending User Asks`). The model may invent rather than leave sections empty. Need a "preserve [N/A]" instruction in the summarizer preamble — Hermes seems to (`context_compressor.py:825–836`) but worth verifying with a couple of dry runs before cutting subCTL over.
2. **Lazy skills + memory commands.** Some of Evy's skills (`memory-handling`, `compaction-handoff`) are load-bearing — if they go lazy, Evy may forget to call them at the moments they matter. The `core: true` allowlist mitigates this but the audit needs care.
3. **Cron silent-marker robustness.** If a model emits `> [SILENT]` inside a code block or quotes the marker, the naive `startswith` Hermes uses (`scheduler.py:130`) would over-suppress. Worth tightening for subCTL: only honor the marker as the *entire* response, not as a prefix.
4. **Hermes proxy adapter coverage vs. release-note claims.** v0.14.0 ships only `nous`. If we adopt Option A above, we're tying ourselves to a single upstream that Hermes' roadmap may or may not extend. Phase 2 is the safer long-term home for "subscription mediation."
5. **SuperGrok OAuth flow stability.** xAI may change the device-code flow without notice. Pin Hermes' `auth.py` version we mirrored, and add a smoke test that runs against the live endpoint in CI on a cadence.
6. **Discrepancy between Hermes' release-note framing and shipped code.** The "any OAuth-authed Hermes provider — Claude Pro, ChatGPT Pro, SuperGrok" line in the v0.14.0 notes is aspirational. Worth a quick ping to the Hermes team to confirm before committing subCTL roadmap to it.

---

## 8 · Suggested ordering

If picking only one: **cron-followups (§3)**. Biggest functional gap, lowest risk, immediately unlocks Jason's morning-briefing pattern in subCTL.

If picking two: add **compact-v2 (§1)** — cheap pre-pass alone is worth the slice, and model-aware thresholds unblock supervisor-model swaps.

If picking three: **xai-supergrok (§5)** before **skills-lazy (§2)** — Grok lands rate-limit headroom, skills-lazy needs an audit pass per skill.

Proxy work (§4) is the only one I'd hold until v0.14.x clarifies its adapter roadmap. Phase 1 (Hermes-as-upstream) is fine to add the moment we want Nous Portal access; Phase 2 (subCTL-owned hub) is a v3 feature.

— end —
