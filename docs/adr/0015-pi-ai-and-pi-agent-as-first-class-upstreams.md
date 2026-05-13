# 0015: Pi-ai + pi-agent as first-class upstreams (always-latest)

- **Status:** Accepted (ships v2.7.24)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.24

## Context

Subctl depends on two packages from mitsuhiko / earendil-works's
`pi-mono` monorepo. They serve different roles, but **both are
first-class upstreams** that subctl must track on `latest`:

| pi-mono dir | npm package | role in subctl | dep status before v2.7.24 |
|---|---|---|---|
| `packages/agent` | `@earendil-works/pi-agent-core` | **agent runtime** — drives master's `Agent` loop, tool registry, streaming, attachment handling | already a dep of `components/master/package.json` |
| `packages/ai` | `@earendil-works/pi-ai` | **provider catalog** — what LLM providers exist, their factory/auth shapes, generated per-provider model lists | already a dep of `components/master/package.json` (used by the master's stream factory), but the **catalog half wasn't consumed by the dashboard** |

(The deprecated `@mariozechner/*` namespace from before the
earendil-works re-publish redirects to these same packages; we pin
to the `@earendil-works/*` names.)

The v2.7.24 trigger was a gap on the **provider-catalog** side: the
dashboard's `New profile` modal shipped a hand-curated dropdown of 5
entries — `claude`, `openai` plus `gemini/zai/minimax` flagged
`(future)` — even though pi-ai's catalog already enumerated ~31
providers (Anthropic, OpenAI, OpenAI Codex, Azure OpenAI, Google,
Vertex AI, Mistral, Groq, Cerebras, Cloudflare AI Gateway + Workers
AI, xAI, OpenRouter, Vercel AI Gateway, MiniMax (+CN), GitHub
Copilot, Amazon Bedrock, OpenCode Zen + Go, Fireworks, Kimi,
Moonshot (+CN), DeepSeek, Hugging Face, Xiaomi variants, Z.ai). The
master daemon was already importing pi-ai for stream dispatch;
subctl's UI just wasn't consuming the catalog half.

Hand-maintenance of the dropdown was producing real friction (the
sixth subctl provider directory, `pi-coding-agent`, wasn't even
listed). Operator surfaced this 2026-05-13: *"Those two separate
projects. PI AI is not the same thing. We're going to keep the
other. This is going to give us support for providers."* — drawing
the line between the agent runtime (pi-agent-core, retained) and
the catalog (pi-ai, now consumed by the dashboard).

The framing the operator emphasised in the spec correction: subctl
treats **both** pi-mono packages as first-class upstreams. Neither
is "optional" or "advisory" — they're load-bearing dependencies
subctl rises and falls with.

## Decision

**Pi-ai and pi-agent-core are first-class upstreams.** Both stay on
`latest` via `^x.y.z` pins in `components/master/package.json`.
Subctl's release process MUST refresh both to their most-recent
published versions on every minor/patch release. v2.7.25 will add
an auto-tracker watchdog that surfaces upstream bumps as
notifications.

Concretely for v2.7.24:

1. **Dependency pinning** — `components/master/package.json` already
   carries:
   ```json
   "@earendil-works/pi-agent-core": "^0.74.0",
   "@earendil-works/pi-ai":         "^0.74.0",
   ```
   The `^` allows `bun install` to resolve to the most-recent
   `0.x.y` on each deploy. The install path (`install.sh` + each
   component's `bun install`) pulls latest automatically when
   subctl is deployed or upgraded.

2. **Catalog adapter** — new `components/master/pi-ai-catalog.ts`
   wraps pi-ai's `getProviders()` + `getModels()` into a stable
   `CatalogProvider` shape (id, display_name, kind, auth_method,
   model_count, notes) the dashboard can consume. Holds an alias
   table (`SUBCTL_TO_PI_AI`) so subctl's historical provider ids
   (`claude`, `gemini`, `pi-coding-agent`) keep resolving even
   though pi-ai uses canonical names (`anthropic`, `google`,
   `anthropic`).

3. **`/api/providers` GET** (dashboard/server.ts) replaces its
   hand-curated `CLOUD` array with `listCatalogProviders()`,
   attaches `accounts.conf` profiles via the alias map, surfaces
   `auth_method` / `model_count` / `legacy_alias` to the UI.

4. **`/api/providers/profiles` POST** validates the requested
   provider against the catalog (after alias resolution). Stale
   references fail at write time with a 400 + hint.

5. **Dashboard dropdown** (`<select id="profile-provider">`) is
   populated dynamically from `/api/providers` whenever the modal
   opens. The `(future)` tags disappear; OAuth providers get an
   `(OAuth)` badge; providers with profiles sort to the top.

6. **Agent-runtime path** (pi-agent-core) is **unchanged**. The
   master daemon still imports `Agent` from
   `@earendil-works/pi-agent-core`, still drives the agent loop,
   still routes tool calls. v2.7.24 doesn't restructure that
   surface — it just formalises pi-agent-core's status as one of
   two first-class upstreams.

## Mapping table (subctl ↔ pi-ai)

Subctl's `accounts.conf` predates pi-ai. The historical names live
on for backwards compat. Direction: legacy subctl id → pi-ai
canonical id.

| subctl legacy id | pi-ai canonical id | Notes |
|---|---|---|
| `claude` | `anthropic` | Claude Code OAuth profiles use `claude`; pi-ai calls the API `anthropic` |
| `gemini` | `google` | Google AI Studio API (Vertex is `google-vertex`, no legacy alias) |
| `pi-coding-agent` | `anthropic` | Subctl-side wrapper dir; underlying LLM is Anthropic |
| `openai` | `openai` | Same name |
| `zai` | `zai` | Same name |
| `minimax` | `minimax` | Same name |

The dashboard accepts EITHER form on POST and resolves to the pi-ai
canonical via `resolveProviderId()`. The form field uses the legacy
alias as `<option value>` when one exists so `accounts.conf` stays
human-readable for operators that grep by hand.

## Dependency-update policy

**Always-latest.** Subctl's release process MUST update
`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to
their latest published versions on every minor/patch release. The
mechanism today is the `^` pin in
`components/master/package.json` plus the fact that subctl's
install / deploy path runs `bun install` (which resolves `^x.y.z`
to the most-recent compatible). A `bun install` in the master
component during deploy ensures latest pi-mono lands on the host.

Operator-facing rule:

- Cutting a subctl release? Bump pi-ai + pi-agent-core to whatever
  was published most recently. Note the upstream versions in the
  CHANGELOG entry for the subctl release.
- Master / dashboard daemons should reload after the bump so
  `process.versions` and the catalog reflect upstream state.
- If a pi-mono major bump lands (`0.x → 1.0`, etc.) the `^` pin
  WON'T cross the major boundary — that's intentional. Major
  bumps go through a manual review (read the upstream changelog,
  test the catalog shape, ship a subctl release that intentionally
  consumes the major).

**Why on every release.** Pi-mono is moving fast (pi-ai's catalog
generation pulls upstream provider lists; pi-agent-core gets
streaming + tool-handling improvements). Falling more than one
release behind means subctl's catalog stops reflecting reality and
master's agent loop misses fixes. Tying the bump to subctl's own
release cadence keeps drift bounded by a release cycle.

## Reasoning

Four reasons to anchor on pi-mono as a load-bearing pair:

1. **Pi-ai's catalog is generated from upstream provider docs.**
   Maintaining a parallel hand-curated list in subctl is pure
   busywork that produces real friction (the v2.7.23 dropdown
   missed `pi-coding-agent` and tagged half its entries as
   `(future)`).

2. **Pi-agent-core is already our agent runtime.** It runs master's
   `Agent` loop today; replacing it would be a near-total rewrite
   for no benefit. Formalising it as a first-class upstream
   acknowledges the dependency we already have.

3. **Single ecosystem anchors complexity in one place.** We picked
   pi-mono when we adopted pi-agent-core. Pulling pi-ai from the
   same monorepo doesn't add a dependency category — it formalises
   a dependency we already carry transitively.

4. **Always-latest costs less than batch-bumping.** Each pi-mono
   release is small (catalog patch, provider addition, streaming
   bugfix). Bumping per-subctl-release keeps the integration
   surface predictable. Letting drift accumulate would force a
   big-bang upgrade with a hard-to-review surface change.

## Consequences

### Positive

- Dropdown stops lying about provider availability. Every entry is
  real; every entry is available; operators add profiles for whichever
  they have accounts for.
- New providers light up automatically on pi-ai bumps. Groq,
  Cerebras, Bedrock, xAI, OpenRouter, Vercel AI Gateway, DeepSeek,
  Fireworks, Kimi-coding, Cloudflare AI Gateway / Workers AI,
  openai-codex, etc., all appear in v2.7.24 without further code.
- `/api/providers` payload gains structural fields (`auth_method`,
  `model_count`, `legacy_alias`) that the UI can use for richer
  rendering without further server work.
- Validation on POST prevents typo'd providers from landing in
  `accounts.conf` — a small but real win for self-healing.
- Pi-agent-core stays on latest by the same mechanism, so master's
  agent runtime tracks upstream fixes without a separate process.

### Negative

- Display names + auth-method hints are still hand-maintained in
  `PROVIDER_META` inside `pi-ai-catalog.ts`. Pi-ai exposes the id
  but not a presentable name. Brand-new pi-ai providers get a
  kebab-case → Title Case fallback until we add an entry. Failure
  mode is "name looks generic," not "feature broken."
- Pi-ai's `findEnvKeys` is currently env-var-set-gated (returns
  `undefined` when nothing is set) so we can't dynamically discover
  the canonical env var per provider at runtime. The auth-method
  hint table inside `pi-ai-catalog.ts` mirrors pi-ai's internal map
  by hand. If pi-ai later exposes the canonical env-var list, we
  can drop the local table.
- We do NOT add OAuth flows for newly-surfaced providers (xAI,
  Groq, GitHub Copilot beyond what already works). Operators
  authenticate via API keys (env var or `secrets.json`). The
  `(OAuth)` badge in the dropdown only appears for providers where
  subctl already has a working OAuth shim (Anthropic / OpenAI
  Codex).
- Always-latest exposes subctl to upstream regressions. Mitigation:
  v2.7.25 auto-tracker (below) will surface bumps as
  notifications, and the eval suite (ADR 0008) catches behavioural
  regressions before they reach the operator.

### Open questions

- **Auto-tracker watchdog (v2.7.25).** v2.7.24 keeps the
  always-latest policy as a *process commitment*; v2.7.25 will add
  a watchdog that polls npm for new pi-ai + pi-agent-core releases,
  surfaces them as `severity:"info"` notifications, and gives the
  operator a one-click `bun install --latest` action. The watchdog
  was scoped out of v2.7.24 to keep the catalog work shippable in
  isolation.

- **OAuth flows for new providers.** GitHub Copilot, xAI —
  `@earendil-works/pi-ai/oauth` exposes helpers; wiring
  `subctl auth github-copilot <alias>` through them is a
  follow-up. Out of scope for this ADR; flagged in the CHANGELOG
  v2.7.24 entry.

- **`WIRED_PROVIDERS` set inside `/api/master/supervisor`** stays
  hand-maintained. That set gates *what the supervisor daemon can
  actually run* (vs. *what the dashboard shows in the list*). The
  two concerns are separate but related; a follow-up could derive
  `WIRED_PROVIDERS` from pi-ai's `registerBuiltInApiProviders`
  registry. Not done in this ADR's scope.

- **Pi-mono major version.** Pi-ai + pi-agent-core are pre-1.0.
  When a 1.0 lands the `^` pin won't cross the boundary
  automatically — the operator will need to consciously decide
  the subctl release that consumes the major. The v2.7.25
  auto-tracker should distinguish patch / minor / major bumps in
  its notification text so the operator knows which.

## Alternatives considered

### Alternative A (CHOSEN): both pi-mono packages are first-class, always-latest

Described above. Pi-ai for the catalog, pi-agent-core for the agent
runtime, both pinned with `^` so install resolves to latest, both
bumped per subctl release, v2.7.25 adds an auto-tracker.

### Alternative B: pi-ai only (pi-agent-core stays an implementation detail)

The original v2.7.24 framing. Treat pi-agent-core as an
implementation detail of the master daemon, document only pi-ai as
the upstream.

Rejected — operator clarified that **both** pi-mono packages are
first-class. Pi-agent-core is too load-bearing (drives the agent
loop) to leave undocumented as a tracked upstream. If we don't say
"always-latest" applies to it too, drift accumulates silently and
the next agent-runtime bug we hit will be against a stale runtime.

### Alternative C: vendor a snapshot of both

Copy the pi-mono source into subctl and maintain it locally.

Rejected. Defeats the always-latest policy. We'd be re-deriving
mitsuhiko's work and absorbing the maintenance.

### Alternative D: pin to exact versions instead of `^`

Replace `^0.74.0` with `0.74.0` (exact). Bump explicitly on every
subctl release.

Rejected — same end result as `^` for our cadence (since we plan
to bump per release anyway) but loses the `bun install` → latest
property that keeps fresh installs / deploys current. The `^`
behaviour matches the always-latest policy mechanically; exact
pinning would require every developer to remember to bump
manually.

## References

- `@earendil-works/pi-ai` on npm: latest 0.74.0 (deprecated
  `@mariozechner/pi-ai` redirects)
- `@earendil-works/pi-agent-core` on npm: latest 0.74.0
- pi-mono monorepo: https://github.com/mitsuhiko/pi-mono (the
  earendil-works publish mirrors `main`)
- Subctl integration glue dirs (unchanged): `providers/{claude,
  gemini, minimax, openai, pi-coding-agent, zai}/`
- ADR 0011 — trust-marker HMAC (separate; mentioned only as the
  prior pattern of "subctl-side glue layer on top of an external
  dependency")
- Operator session 2026-05-13 — surfaced the catalog gap, drew the
  catalog/runtime distinction, and clarified the always-latest
  dual-upstream framing.
