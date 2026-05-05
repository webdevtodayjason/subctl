# Gemini provider — planned (v1.2)

Targets Google's `gemini` CLI, which authenticates via Google OAuth and works against either the free Gemini Code Assist tier or paid AI Studio / Vertex tiers. The integration shape mostly mirrors the Claude provider — mature CLI, well-defined config dir, OAuth flow.

## Required scope

- `auth.sh` — drive `gemini auth login` with the per-alias config dir set.
- `signals.sh` — read whatever local state the Gemini CLI uses for usage accounting; map it to the subctl signal interface (parallel sessions, ctx %, hits today, session age).
- `teams.sh` — spawn the orchestrator + worker tmux layout pinned to a specific Gemini account.

## Open questions to resolve before implementation

1. Confirm the env var or flag that overrides Gemini CLI's per-user config dir.
2. Determine the local file shape the CLI writes per session and per usage event.
3. Decide on free-tier vs paid-tier handling — they have very different cost models, and the dashboard needs to differentiate honestly.
4. Identify whether Gemini Code Assist exposes a usage endpoint comparable to Anthropic's so plan-level quota can be surfaced.

See [../../ROADMAP.md](../../ROADMAP.md#v12--gemini-code-assist) for the full per-provider plan and [../../docs/adding-a-provider.md](../../docs/adding-a-provider.md) for the interface contract.
