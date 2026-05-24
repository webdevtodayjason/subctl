# subctl docs

Canonical documentation for the subctl project. Source of truth for architecture, persona, memory, policy, and decisions.

## Start here

- [glossary.md](glossary.md) — canonical taxonomy (Evy, supervisor LLM, worker team, …)
- [master.md](master.md) — Evy's architecture, tool surface, and operating model <!-- "master" in filename is a legacy code identifier — renamed in Phase 3 -->
- [persona/evy.md](persona/evy.md) — Evy, the orchestrator persona
- [roadmap.md](roadmap.md) — what's shipping next, what's queued, what's deferred
- [memory-architecture.md](memory-architecture.md) — five-tier memory model

## Decisions (ADRs)

[`adr/`](adr/) holds Architecture Decision Records. Read the [index](adr/README.md). Most recent first; ADR 0010 down to ADR 0001.

## Persona

[`persona/`](persona/) holds canonical persona docs.

- [evy.md](persona/evy.md) — the full persona spec, preserved verbatim
- [evy-eval-rubric-test-1.2.md](persona/evy-eval-rubric-test-1.2.md) — the reference grading rubric for the eval suite
- [voice-future.md](persona/voice-future.md) — TTS candidates for a future voice layer

## Operational reference

- [architecture.md](architecture.md) — high-level system architecture
- [adding-a-provider.md](adding-a-provider.md) — how to add a new model/account provider
- [multi-account.md](multi-account.md) — multi-account usage patterns
- [policy.md](policy.md) — policy engine overview
- [policy-schema.md](policy-schema.md) — policy TOML schema reference
- [release-workflow.md](release-workflow.md) — how to bump VERSION + CHANGELOG + tag

## Specific subsystems

- [sesh-integration.md](sesh-integration.md) — sesh terminal multiplexer integration
- [radar.md](radar.md) — usage / rate-limit radar
- [service.md](service.md) — launchd service management
- [migration.md](migration.md) — migration guidance
- [exec-migration.md](exec-migration.md) — exec-path migration notes
- [deck.md](deck.md) — legacy deck integration (deprecated)
- [landing-copy.md](landing-copy.md) — marketing copy for subctl.com

## How to maintain

- New decisions: write an ADR. See [adr/0000-template.md](adr/0000-template.md) and update [adr/README.md](adr/README.md) with the entry.
- New persona spec: add to [persona/](persona/) and link from the index above.
- Roadmap changes: edit [roadmap.md](roadmap.md) in the same commit as the work.
- Architecture changes: update the relevant doc and reference the ADR that drove the change.

Documentation is not optional. Decisions documented in commit messages or chat transcripts only count as tribal knowledge. If a decision is load-bearing, it lives here.
