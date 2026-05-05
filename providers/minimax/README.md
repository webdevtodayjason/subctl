# Minimax (M1 Coder) provider — investigating (v1.4)

Targets Minimax's M1 Coder subscription. The youngest of the four planned providers and the one with the most CLI-ecosystem unknowns.

## Status

**Investigating.** Two questions decide whether this provider lands at all:

1. Does Minimax ship (or commit to ship) an OAuth-via-subscription CLI? If they stay API-key-only, this provider falls outside subctl's scope — subctl is for _subscriptions_, not API keys.
2. Is the CLI tmux-spawnable, or is the surface IDE-plugin-led only?

If both answers are "yes," Minimax slots into the same plugin model as Claude / OpenAI / Gemini.

## Required scope (once viable)

- `auth.sh` — drive Minimax's OAuth login with per-alias config dir.
- `signals.sh` — surface parallel sessions, ctx %, hits today.
- `teams.sh` — orchestrator + worker tmux layout pinned to a Minimax account.

## Open questions to resolve before scoping

1. Does Minimax have an official CLI today? If so, what's the binary name, env var for config dir, and auth flow?
2. Is OAuth subscription confirmed, or is the announced plan still API-key-gated under the hood?
3. Where do credentials and session state land on disk?
4. Quota / rate-limit endpoint?

See [../../ROADMAP.md](../../ROADMAP.md#v14--minimax-coder) for the per-provider plan and [../../docs/adding-a-provider.md](../../docs/adding-a-provider.md) for the interface contract.
