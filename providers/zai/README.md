# Z.AI (Zhipu / GLM) provider — investigating (v1.3)

Targets Z.AI's Coding Plan subscription, which powers GLM-4.5 / 4.6 in IDE plugins and (presumably) a CLI. OAuth-via-subscription is the relevant surface.

## Status

**Investigating.** CLI maturity is the biggest unknown. If Z.AI's primary surface remains IDE plugins without a tmux-spawnable CLI, this provider waits — subctl is a control plane for command-line workflows, and we don't ship a half-integration that needs a browser tab open.

## Required scope (once viable)

- `auth.sh` — drive z.ai's OAuth login with the per-alias config dir set.
- `signals.sh` — surface parallel sessions, ctx %, hits today from local state.
- `teams.sh` — spawn the orchestrator + worker tmux layout pinned to a Z.AI account, _if_ a CLI exists that supports being launched in a non-interactive shell.

## Open questions to resolve before scoping

1. Does Z.AI ship a CLI suitable for `provider_zai_teams` to spawn in tmux? If yes, what's the binary name, env var for config dir, and auth flow?
2. Where do credentials and active-session state land on disk?
3. Does the Coding Plan expose a usage / quota endpoint comparable to Anthropic's `/api/oauth/usage`?
4. Is there an analogue of Claude's transcript file that subctl can read for ctx % and session age?

See [../../ROADMAP.md](../../ROADMAP.md#v13--zai-coding-plan-glm) for the per-provider plan and [../../docs/adding-a-provider.md](../../docs/adding-a-provider.md) for the interface contract.
