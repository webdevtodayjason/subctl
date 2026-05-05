# OpenAI provider — planned (v1.1)

Targets the OpenAI Codex CLI, which authenticates via OAuth against a ChatGPT plan (Plus / Pro / Team / Enterprise). _Not_ API-key-based — this provider exists for the OAuth-via-subscription surface, which is what subctl's whole model is about.

## Required scope

- `auth.sh` — drive `codex login` with `CODEX_HOME` (verify name) set per-alias.
- `signals.sh` — surface parallel sessions, ctx %, session age, rate-limit hits today, by reading whatever local state the Codex CLI writes (analogous to Claude's `~/.claude/projects/<id>/transcript.jsonl`).
- `teams.sh` — spawn an orchestrator + worker tmux layout pinned to a specific Codex account, mirroring the Claude implementation's shape.

## Open questions to resolve before implementation

1. Confirm the env var that overrides Codex's per-user config dir.
2. Identify the file(s) the CLI writes for active-session and quota state.
3. Determine whether Codex exposes a usage endpoint comparable to Anthropic's `/api/oauth/usage` so the dashboard can show plan-level quota.

See [../../ROADMAP.md](../../ROADMAP.md#v11--openai-codex-next-up) for the full per-provider plan and [../../docs/adding-a-provider.md](../../docs/adding-a-provider.md) for the interface contract.
