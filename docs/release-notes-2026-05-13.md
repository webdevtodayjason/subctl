# Release notes — 2026-05-13 session

## Session frame

What started as a 90-minute Telegram hang ended ~6 hours later with the entire v2.7.x sequence shipped (v2.7.18 → v2.7.32, fourteen releases including one hotfix) and a major v2.8.0 release planned. This document captures both: the v2.7.x story end-to-end, and the v2.8.0 plan (team templates + TinyFish Browser API + voice/TTS layer).

## What kicked it off

Evy (running heavy supervisor `qwen3.6-35b-a3b`) stopped responding to operator's Telegram messages for ~90 minutes during a drive home from the office. Diagnostic showed Evy was in an infinite tool-call loop, calling some listener-poll tool that returned `{ entries: [], listener: { running: false } }` over and over. Reasoning-model trap: keep checking, never conclude the listener is dead. A `launchctl kickstart -k` broke the loop. Transcript preserved across the restart.

Three architectural threads emerged from that incident, and each became its own release wave:

1. **Make Evy operationally responsive** — supervisor profile switching (chat vs heavy), watchdog kill controls, circuit breaker for dead-listener tool loops.
2. **Make the trust channel between Evy and workers cryptographic** — the plaintext directive marker was correctly identified as gameable by a worker earlier in the day (osint-cve-monitor paranoia loop). HMAC marker + web terminal escape hatch close ADR 0011.
3. **Build the substrate everything else stacks on** — Tier 3 conversational memory (Evy Memory), dynamic provider catalog (pi-ai upstream), 1Password-driven secret resolution, real `subctl` CLI, plan-approval workflow surfacing operator-facing.

## v2.7.x — fourteen releases

### v2.7.18 — Supervisor profiles
**Commit:** `e6f7a3b` · **Lines:** 1,031 / 11 files

Two named profiles (`chat`: gemma-4-31b · `heavy`: qwen3.6-35b-a3b) stored at `~/.config/subctl/profiles.json`. Operator switches via dashboard pill (sticky header), Telegram `/profile chat|heavy`, or by editing the file directly. Hot-swap on next prompt — no Evy restart, transcript continues across the swap.

Directly addresses tonight's incident: heavy reasoning models can deadlock; chat profile is a safe fallback.

### v2.7.19 — Watchdog kill controls + empty-listener circuit breaker
**Commit:** `a94954e` · **Lines:** 1,492 / 15 files

Two reliability fixes:
- **Watchdog registry**: every periodic probe (telegram-listener, inbox-poll, team-staleness, verifier-cluster, auto-compact, etc.) registers through `components/master/watchdogs.ts`. Operator and Evy can list + kill via dashboard panel, Evy tools (`watchdog_list` / `watchdog_kill`), or Telegram `/watchdogs [kill <id>|killall]`.
- **Circuit breaker**: `components/master/circuit-breaker.ts` watches every tool-call result. If a tool returns `{ entries: [], listener: { running: false } }` three times consecutively, the fourth call is refused with a synthesized error telling the model the listener is dead. Resets on the next operator turn. Direct fix for tonight's 90-min hang.

### v2.7.20 — HMAC trust marker — ADR 0011 Layer 1
**Commit:** `b4d6b04` · **Lines:** 1,000 / 10 files

Per-team HMAC-SHA256 secret stored at `~/.local/state/subctl/teams/<id>/hmac.secret` (chmod 600). Injected into the worker's spawn-time system prompt; signed marker format is `[subctl-master directive · phase=<phase> · ts:<iso> · hmac:<16hex>]`. Centralized helper at `components/master/trust-marker.ts`. Fail-loud if secret missing on disk (no plaintext fallback).

Supersedes ADR 0002's plaintext marker, which a worker had correctly broken earlier in the day.

### v2.7.21 — Web terminal escape hatch — ADR 0011 Layer 2 (complete)
**Commit:** `46f93b6` · **Lines:** 1,531 / 18 files

xterm.js + node-pty wrapping a per-team tmux attach. Operator opens an in-browser terminal from the dashboard; types directly into the worker's pane as themselves, bypassing Evy and HMAC entirely. Default-OFF behind `~/.config/subctl/terminal.enabled` (Telegram `/terminal on|status|off`).

Closes ADR 0011 — three layers shipped (HMAC + escape hatch + style matching, which was already in the Evy persona since v2.7.15).

### Hotfix `0d3ba69` — Dashboard reads VERSION on every render
**Lines:** 10 / 1 file

The dashboard process cached VERSION at startup. Evy got restarted on each deploy; dashboard didn't. Result: operator saw v2.7.17 in the UI while Evy correctly reported v2.7.20. Hotfix replaced the const with a function call at every render site. Deploy template updated to restart both services on every `git pull`.

### v2.7.22 — Notification channel + auto-nudge + auto-compact fix
**Commit:** `e418467` · **Lines:** 1,721 / 14 files

Three coupled fixes:
- **Notification channel separation**. Watchdog ticks no longer wake Evy's LLM. Notifications live in their own queue (`components/master/notifications.ts`), surface via dashboard tray + Telegram push for `severity: "alert"` only.
- **Auto-nudge**. When team-staleness detects an idle team, Evy first sends `subctl_orch_msg` to the team lead with an authenticated HMAC ("are you stuck?") before paging operator. Operator only gets paged when the team fails to respond within 30 min.
- **auto-compact watchdog fix**. The watchdog had `last_tick_at: null` since boot — never fired. Was the cause of Evy's transcript stuck at ~19 messages despite the conversation continuing.

### v2.7.23 — Evy Memory (Tier 3) — Memori-substrate TS port
**Commit:** `686f168` · **Lines:** 1,983 / 16 files

Persistent conversational memory. `~/.local/state/subctl/memory/evy.db` — SQLite via `bun:sqlite` + FTS5 full-text search. Evy captures at turn boundaries: user messages, assistant responses, tool calls, notifications, shipped events. Evy gets `evy_recall(query)` and `evy_remember(content)` as Evy tools. Dashboard Memory tab, Telegram `/memory <query>` / `/memory recent` / `/remember <text>`. Egress redaction masks `sk-*`, `Bearer`, 64-hex, `hmac:*` strings when leaving via chat surfaces.

ADR 0014 supersedes ADR 0006. Memori (Python framework) was named in the original ADR; implementation revealed Python interop with Bun would require a sidecar service, and Memori's value-add (auto-inject into LiteLLM prompts) is moot since subctl's LLM path is pi-ai, not LiteLLM. We took Memori's schema concept and ported it native to TS.

Fixes the "51st date syndrome" — every Evy restart was a cold start before this.

### v2.7.24 — pi-ai + pi-agent first-class upstreams; dynamic provider catalog
**Commit:** `f79f87b` · **Lines:** 1,052 / 10 files

Replaces the hand-curated 5-entry provider dropdown ("openai, claude, gemini (future), zai (future), minimax (future)") with a dynamic catalog backed by `@earendil-works/pi-ai`. The dashboard "New profile" dropdown now shows **31 providers** including groq, cerebras, openrouter, xai, bedrock, openai-codex, github-copilot, deepseek, fireworks, vercel-ai-gateway, plus the OpenAI-compatible escape hatch (Ollama, vLLM, LM Studio).

ADR 0015 codifies the dual-upstream policy: `@earendil-works/pi-agent-core` is the agent runtime (untouched); `@earendil-works/pi-ai` is the catalog (added). Both first-class, both tracked at `^latest` per the always-latest dependency policy. The github URL `mitsuhiko/pi-mono` that surfaced briefly during dispatch turned out to be a downstream fork; `earendil-works/pi-mono` (Mario Zechner) is the canonical source.

### v2.7.25 — Lucide icons + notification UX polish + upstream-tracker watchdog
**Commit:** `9dea0ed` · **Lines:** 2,311 / 17 files

Three bundled scopes:
- **Lucide icon library** adoption (`dashboard/public/icons.js`). Replaces emoji across all dashboard surfaces — operator's words on the old approach: *"wingdings, crappy things."*
- **Notification UX**. Bell → Lucide `inbox`. Incoming notifications toast in the top-right (slide-in, hold ~5s, slide-out). Click inbox icon → dropdown menu showing last 20 stored notifications with per-item `[×]` and "Mark all as read." Error-class notifications get a `[📋 Copy prompt]` button that formats the error context into an AI-pasteable prompt.
- **Upstream-tracker** watchdog (`components/master/upstream-check.ts`, 699 lines). Ticks every 6 hours, polls npm registry for `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`. Newer version detected → notification. Optional auto-update mode (gated by `~/.config/subctl/auto-update-upstreams.enabled` flag) runs `bun install` + tests and only ships if green.

ADR 0016 documents Lucide adoption.

### v2.7.27 — tinyfish_agent (third TinyFish surface)
**Commit:** `20ea378` · **Lines:** 1,140 / 7 files

Third surface in TinyFish integration: hosted browser automation. Evy calls `tinyfish_agent({ task, starting_url, timeout_seconds })`; TinyFish runs a headless browser in their cloud, executes the task in natural language, returns extracted result + run metadata. Joins `tinyfish_search` (semantic web search, v2.7.16) and `tinyfish_fetch` (URL → markdown, v2.7.16).

The fourth surface (operator-driven Playwright via CDP, ADR 0013) remains v2.8.0 scope.

> Versions 2.7.26 was conceptually allocated but the worker assigned to it (`onepw-impl`) went silent for 25+ minutes with no progress and was declared dead. The redispatched worker (`onepw-impl-v2`) shipped under v2.7.31. The 2.7.26 number itself was retired to avoid implying ordering between parallel ships.

### v2.7.28 — subctl CLI bootstrap
**Commit:** `d4e83c0`

First-class command-line interface. `bin/subctl` (Bun script) + `lib/cli.sh`. Subcommands: `status` (both services + active profile + telegram listener), `logs` (tail Evy/dashboard log streams via `--master`/`--dashboard`; flag names stay until Phase 3 code rename), `deploy` (git pull + restart both launchd services), `notif` (recent / list / mark-all-read), `memory` (search / recent / remember), `--version`, `--help`. JSON output flag for machine consumption. `docs/cli.md` reference page.

Foundational; more subcommands (team mgmt, config, profile switch) can follow without re-architecting.

### v2.7.29 — Plan-approval workflow (dashboard + Telegram)
**Commit:** `f03ddcc`

Workers' `plan_approval_request` messages now surface to the operator. `components/master/plan-approvals.ts` maintains a pending queue (persisted to `~/.local/state/subctl/plan-approvals.jsonl`); dashboard Plans tab shows pending plans with approve/reject (feedback textarea on reject); Telegram `/plans`, `/plans approve <id>`, `/plans reject <id> <feedback>`. Auto-expires pending plans after 60 minutes (operator can re-request from the worker if needed).

### v2.7.30 — Evy eval suite refresh
**Commit:** `c542961`

16 new test cases across 7 categories covering v2.7.18 → v2.7.24 features that had no eval coverage: supervisor-profiles, watchdog-controls, trust-marker, web-terminal, notifications, evy-memory, provider-catalog. Total Evy eval suite: **40 tests** (24 original from v2.7.15 + 16 new). Regex fast-fail mode passes; LLM judge runs are operator-triggered.

### v2.7.31 — 1Password Service Accounts (multi-backend secret resolution)
**Commit:** `cabf5a7` · **Lines:** 978 / 9 files

`components/master/secrets-backends.ts` resolves secrets in chain order: env → 1Password (`op` CLI shell-out, gated on `OP_SERVICE_ACCOUNT_TOKEN`) → file (`~/.config/subctl/secrets.json`). Per-key overrides via `~/.config/subctl/secrets-backends.json` with `op://vault/item/field` references. Cache 5 minutes to respect 1Password's rate limits. Fail-soft if `op` not installed.

Dashboard `/api/secrets/backends` + `/api/secrets/test` (never returns secret VALUES, only `found_via`). Telegram `/secrets` shows backend chain status. ADR 0012 marked "Accepted (shipped v2.7.31)."

Operator's MSP context — multiple business clients, can't hardcode secret paths — drives this. Each client gets their own 1Password vault; subctl pulls credentials at request time without leaving them on disk.

### v2.7.32 — Cleanup bundle (in flight, may be promoted to v2.8.0 — see below)
**Status:** dispatched, mid-implementation

Six small fixes bundled:
1. **Watchdog reconciliation** — team-staleness watchdog kept reporting the archived `claude-osint-cve-monitor` team as stale tonight. Fix: verify team dir exists on disk before alerting; emit one-time `team-vanished` notification + remove from tracker.
2. **subctl CLI install path** — `bin/subctl` shipped in v2.7.28 but isn't in `PATH` after install. Extends `install.sh` to symlink to `/usr/local/bin/` or `~/.local/bin/` fallback.
3. **`tmux` PATH for SSH** — homebrew tmux isn't in non-login PATH. Either document the `.zshenv` fix or wrap invocations with explicit `/opt/homebrew/bin/tmux`.
4. **`supervisor_model` field in `/health`** — was returning `null` since v2.7.18 replaced it with `active_profile`. Remove or rewire to current profile's supervisor.
5. **Stale team-dir gc** — `policy-fix-verify` and `ship-verify-test` from May 12 still parked. Auto-archive any dir >14 days old with no audit-log activity in 7 days.
6. **CHANGELOG ordering pass** — tonight's parallel-merge auto-resolution produced out-of-order entries. Audit + sort.

## v2.8.0 — major release plan

**Theme:** team templates · TinyFish Browser API · voice layer for Evy.

This is the first major release of subctl. The v2.7.x series brought the platform from "operationally fragile under heavy reasoning models" to "comprehensively instrumented, dynamically provisioned, persistently memoryful." v2.8.0 adds the surfaces that operator interaction will lean on for daily use.

### Three primary scopes

**1. Team templates** (long-queued for v2.8.0)

Spawn-time template system for dev-team workers. Currently a worker dispatch goes through `providers/claude/teams.sh` which knows the canonical worker prompt; team-templates would let the operator define alternate spawn templates per team type (e.g., a `bash-gate-pr-sequence` template vs a `osint-monitoring` template vs a `client-X-deploy` template). Carries through to `.subctl/docs/` project-local team artifacts (ADR 0003) — each template names its docs directory.

**2. TinyFish Browser API** (ADR 0013)

The fourth TinyFish surface. Unlike `tinyfish_agent` (TinyFish operates the browser in their cloud), the Browser API gives subctl raw Chrome DevTools Protocol access via Playwright-over-CDP. Dev-team workers can drive Playwright locally on M3; Evy stays lean (doesn't embed Playwright itself). Per ADR 0013, this needs team-templates as a prerequisite — the Playwright-driving worker needs a dedicated team template type.

**3. Voice layer for Evy (TTS)**

This is the new addition for v2.8.0 per tonight's operator direction. Previously deferred to v2.9.x / v3.x in `docs/persona/voice-future.md`; promoted because text-Evy is now stable (40 eval tests passing across 14 versions of features).

#### Voice layer architecture

Per the parking-lot doc, the voice layer is **downstream of the persona**, not part of it. The text response Evy generates flows through TTS at delivery time. Memory model unchanged; persona unchanged; only the output channel widens to audio.

Components:

- **`components/master/tools/voice-render.ts`** — new Evy tool `voice_render({ text, voice_id })` that POSTs to a local TTS HTTP server.
- **TTS server** — separate launchd service on M3 (`com.subctl.tts`), runs the chosen TTS model. Pattern mirrors how Evy + dashboard + LM Studio are separate launchd jobs.
- **Dashboard chat panel** — "🔊 Play audio" affordance per Evy turn. Click → POST to Evy's `voice_render`, get back audio URL, play in browser.
- **Telegram integration** — voice notes for routine status messages (operator's chosen async check-in mode). `severity: "alert"` notifications can ride this channel.
- **Voice profile config** — `~/.config/subctl/voice.json` selects TTS model + voice_id. Operator can swap voices without restart (file-watch pattern from v2.7.18).

#### Voice model decision

Per `docs/persona/voice-future.md`, candidates are ranked by self-hosting feasibility + cloning fidelity + latency + license. Operator's lean: **VoxCPM2** or the **VoxCPM 0.5B variant** (smaller footprint than 2B base, retains quality + cloning + multilingual + streaming).

The Evy voice anchor (per the persona spec) is *Rachel Weisz as Evy Carnahan* — cloning fidelity matters. VoxCPM-family and Chatterbox / CosyVoice2 are the strong contenders.

Final model selection deferred to dispatch time after a brief evaluation pass on M3 hardware.

#### Constraints

- Self-hosted only (ADR 0009). No cloud TTS egress.
- Apache 2.0 / MIT preferred; Fish Speech specifically flagged for license-check before adoption.
- Streaming-native preferred (sub-second time-to-first-audio) for back-and-forth conversation.

### Scope decision pending operator confirmation

**Question for operator**: should the in-flight cleanup work (currently v2.7.32) ship as v2.7.32 (last v2.7.x release, small/cleanup), then v2.8.0 dispatches separately with the three major scopes above? Or should the cleanup work be folded into v2.8.0?

Recommend the former (separate ships) — it keeps the v2.8.0 PR clean and high-signal, and v2.7.32 acts as a "v2.7.x complete" marker.

## Aggregate

| Metric | Value |
|---|---|
| Releases shipped tonight | **14** (v2.7.18–25, 27–31, 32-in-flight, + hotfix `0d3ba69`) |
| Lines added (estimate) | **~17,200** |
| Tests added | **~3,200 lines** across 13+ test suites |
| ADRs written or closed | 4 written (0011 Layer 2, 0014, 0015, 0016) · 3 superseded/closed (0002, 0006, 0011 Layer 1+2 fully shipped) |
| Workers dispatched | 14 (1 redispatch — `onepw-impl` declared dead at 25min, `onepw-impl-v2` shipped in 10) |
| Peak parallel workers | 6 simultaneously |
| Deploys to M3 | 9 (each restarted both Evy and dashboard) |
| Total scoped queue cleared | yes — 1Password, TinyFish Agent, Memori (as Evy Memory), CLI, plan-approval, eval refresh, Lucide, notification UX, upstream-tracker, watchdog kill, HMAC, web terminal, supervisor profiles |

## References

- [docs/persona/voice-future.md](persona/voice-future.md) — voice/TTS candidate model survey
- [docs/persona/evy.md](persona/evy.md) — Evy identity spec (voice anchor: Rachel Weisz as Evy Carnahan)
- [docs/roadmap.md](roadmap.md) — line 66 first mention of voice layer as v2.9.x or v3.x (now elevated)
- [docs/adr/0009-self-hosted-only-no-cloud-memory.md](adr/0009-self-hosted-only-no-cloud-memory.md) — self-hosted-only constraint applies to TTS
- [docs/adr/0013-tinyfish-browser-api-integration.md](adr/0013-tinyfish-browser-api-integration.md) — TinyFish Browser API spec
- [docs/adr/0011-trust-marker-hmac-replacement.md](adr/0011-trust-marker-hmac-replacement.md) — the trust-channel architecture that motivated several v2.7.x releases
