# subctl roadmap

> **Status as of v2.6.0 (2026-05-10).** This file tracks **provider expansion** — the multi-provider dispatch substrate. For the agentic harness / master daemon / dev-team orchestration roadmap, see [`docs/master.md`](docs/master.md) §4. The 2.x series sits on top of the v1.x provider plumbing; both layers ship together.

## Vision

Every coding subscription you pay for, on one agentic control plane.

The unit of work is _the subscription you already pay every month_, not _the API account someone gave you keys for_. subctl's job is to (a) surface the same dispatch signals across all of them — which account is active, how close to rate limit, cost vs API list price, sessions in flight — and (b) run a persistent conversational orchestrator (`subctl master`) on top that drives projects forward across whichever subscription is healthiest at the moment.

**Today:** Claude (shipping) + OpenAI Codex via OAuth (shipping). Anthropic API as escalation fallback. The master daemon talks to local LM Studio (qwen, gpt-oss, etc.) by default and routes to cloud only when explicitly needed.

## The plugin model

A provider is a directory under `providers/` implementing three required scripts:

```
providers/<name>/
├── auth.sh       # provider_auth   <alias> <config_dir>
├── signals.sh    # provider_signals <alias>
└── teams.sh      # provider_teams  [opts]
```

Plus optional `statusline.sh`, `hooks/`, `commands/`. Full contract at [docs/adding-a-provider.md](docs/adding-a-provider.md). Each provider must respect its tool's official isolation knob (e.g. `CLAUDE_CONFIG_DIR` for Claude Code) so multiple accounts coexist without log-out / log-in dances.

## Provider roadmap

| Provider               | CLI / surface           | Target | Status         |
|------------------------|-------------------------|--------|----------------|
| Claude Code            | `claude` (Anthropic)    | v1.0   | **shipping**   |
| OpenAI Codex           | `codex` (OpenAI)        | v2.0+  | **shipping**   |
| Gemini Code Assist     | `gemini` (Google)       | v1.2   | planned        |
| Z.AI Coding (GLM)      | tbd — likely IDE+API    | v1.3   | investigating  |
| Minimax Coder          | tbd — likely IDE+API    | v1.4   | investigating  |

Versions are intent, not contract. Whichever provider's CLI surface stabilizes first ships first.

---

### v1.1 — OpenAI Codex (next up)

OpenAI's Codex CLI authenticates via OAuth against a ChatGPT plan (Plus, Pro, Team, Enterprise). Same model as Claude Code: per-account isolation, plan-level rate limits, locally-stored credentials. The earlier `providers/openai/README.md` claim of "API key based" is stale — Codex is the OAuth-via-subscription surface this project cares about.

**Per-account isolation knob:** `CODEX_HOME` (`~/.codex` by default). Verify this against the current `codex` CLI before locking in.

**Auth flow:** `codex login` opens a browser; credentials land under `$CODEX_HOME`. `provider_openai_auth` will do that with `CODEX_HOME` set per-alias.

**Rate-limit signal source:** Codex surfaces rate-limit info via its own daemon and HTTP responses; need to map to the `signals.sh` interface (parallel sessions, ctx %, hits today). May involve parsing Codex's local state files much like the Claude provider parses `~/.claude/projects/<id>/transcript.jsonl`.

**Open questions:**
- Confirm exact env var name for config-dir override
- Identify the equivalent of Claude's transcript files for parallel-session counting
- Decide whether Codex's `/api/usage` or equivalent is reachable for plan-level usage data, the way the dashboard already pulls Claude's `/api/oauth/usage`

**Cross-cutting changes when this lands:**
- Dashboard cost view extends to OpenAI list-pricing
- Statusline gains a `provider_openai/statusline.sh` (or unified provider-aware variant)
- Dispatch-check radar learns to weight openai-account signals next to claude

---

### v1.2 — Gemini Code Assist

Google's `gemini` CLI authenticates via Google OAuth and works against either the free Gemini Code Assist tier or paid AI Studio / Vertex tiers. Mature CLI; the integration shape mostly mirrors Claude.

**Per-account isolation knob:** `GEMINI_HOME` or equivalent. Gemini CLI's config-dir convention needs confirmation against current upstream.

**Auth flow:** `gemini auth login`. `provider_gemini_auth` runs that with the per-alias home set.

**Rate-limit signal source:** Gemini's free tier has generous limits but they exist; paid tiers are quota-based. Need to read whatever local-state file the CLI uses for usage accounting.

**Open questions:**
- Free vs paid tier handling — should the dashboard differentiate, given they have wildly different cost models
- Whether Gemini Code Assist exposes a usage endpoint similar to Anthropic's

---

### v1.3 — Z.AI Coding Plan (GLM)

Z.AI (Zhipu) ships a Coding Plan subscription powering GLM-4.5/4.6 in IDE plugins and a CLI. OAuth-via-subscription is the relevant surface. CLI maturity is the biggest unknown.

**Per-account isolation knob:** TBD — needs investigation.

**Auth flow:** TBD — likely OAuth via z.ai, but the CLI integration story may still be IDE-plugin-led at the time of writing.

**Open questions:**
- Does z.ai ship a CLI suitable for `provider_zai_teams` to spawn in tmux?
- Where do credentials and session state land on disk?
- Does the Coding Plan expose a usage / quota endpoint comparable to Anthropic's?

**Risk:** if Z.AI's CLI surface isn't ready, this provider waits. We don't ship a half-integration that needs the user to keep a browser tab open.

---

### v1.4 — Minimax Coder

Minimax's M1-Coder Plan is the youngest of the four and has the least mature CLI ecosystem at the time of writing. OAuth subscription support is plausible but not yet confirmed.

**Open questions:**
- Is there an official CLI? Anything beyond IDE plugins and direct API key usage?
- OAuth status — confirmed or roadmap?
- Quota / rate-limit endpoints?

**Risk:** if Minimax stays API-key-only, it falls outside subctl's scope (subctl is about _subscriptions_, not API keys). If they ship OAuth-via-subscription, it slots in under the same plugin model as the others.

---

## Cross-cutting work that lights up with each new provider

- **Dashboard cost view** — currently Claude-only; needs per-provider list-price tables and a unified savings-vs-subscription calculation.
- **Radar / dispatch-check** — currently parses Claude transcripts and rate-limit logs; needs a generalized signal-aggregation layer so the verdict (`green / yellow / red`) reflects all accounts across all providers.
- **Statusline** — currently looks up the alias by matching `CLAUDE_CONFIG_DIR` against `accounts.conf`. Needs to widen to the analogous env vars for other providers (`CODEX_HOME`, `GEMINI_HOME`, etc.) and pick the right provider's statusline data source.
- **Sessions / projects** — `subctl sessions` and `subctl projects` walk Claude's transcript and project-binding files. Each new provider adds its own transcript convention; the iteration logic generalizes.
- **`subctl teams`** — currently spawns the orchestrator + workers in tmux pinned to a Claude account. Each new provider gets its own `teams.sh` that knows the right CLI invocation; the tmux scaffolding stays shared.

## Voice layer (TTS)

| State | Version | Notes |
|---|---|---|
| **Currently shipping** | **v2.8.0** | Self-hosted TTS, opt-in (`voice.json#enabled`), redacted at the tool boundary. Three backends: `mock` (default, 1s silent WAV — used in install for first-run), `voxcpm` (operator's primary lean, ~0.5B Apple-Silicon-capable), `kokoro` (CPU-friendly fallback). Surfaces: master `voice_render` tool, dashboard 🔊 button per Evy turn, Telegram `telegram_send_voice` + `/say` + `/voice`, CLI `subctl voice [status\|test\|render\|on\|off]`. See [ADR 0017](docs/adr/0017-voice-layer-tts.md) and [docs/persona/voice-future.md](docs/persona/voice-future.md). |

The voice layer is a **delivery channel**, not a persona change. Evy's
voice rules (no padding, no em dashes, dry/precise register — [ADR
0004](docs/adr/0004-evy-persona-librarian-framing.md)) operate on the
text she produces; the TTS layer reads that text aloud after egress
redaction. The character voice anchor is Rachel Weisz as Evy Carnahan
(reference clip stays operator-sourced under
`services/tts/voices/<voice_id>/`).

Self-hosted-only per [ADR 0009](docs/adr/0009-self-hosted-only-no-cloud-memory.md). No
ElevenLabs / OpenAI TTS / Azure egress for synthesized audio.

## Plugin SDK (post-1.x)

Once a third provider ships, the duplicated patterns across `providers/*` become extractable into a small SDK:

- A shared bash library for OAuth-token storage, config-dir isolation, and tmux pane scaffolding.
- A schema for `accounts.conf` extensions per provider (e.g. plan tier, region).
- A documented contribution path for community providers (Cursor, Continue, Cline, Aider, others) that don't ship from this repo.

This is intentionally _after_ the first non-Claude provider lands — the SDK should crystallize from real shapes, not from speculative ones.

## How to follow / contribute

- Per-release notes: [CHANGELOG.md](./CHANGELOG.md)
- Provider implementation contract: [docs/adding-a-provider.md](docs/adding-a-provider.md)
- Provider stubs (one README per planned provider): `providers/<name>/README.md`
- Issues: https://github.com/webdevtodayjason/subctl/issues
