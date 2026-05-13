# Architecture Decision Records

This directory captures load-bearing decisions about subctl's design.

## What lives here

A decision goes in `docs/adr/` when:

- It commits the project to a specific path for a non-trivial scope.
- The reasoning behind it would otherwise live in someone's head and be lost when they're gone or forget.
- A future maintainer or contributor would need to know *why* this was the call, not just *what* the code does.

Implementation details, runtime behavior, and API surface live in other docs (`docs/master.md`, `docs/policy.md`, `docs/policy-schema.md`, etc.). ADRs are for the decisions those docs reflect.

## What does NOT live here

- Tactical choices ("rename this variable", "extract this helper") — those live in commit messages and PR descriptions.
- Reversible experiments — try them, write them up if they stick.
- Documentation of code that already exists and is self-explanatory — read the code.

## Format

Each ADR is a markdown file named `NNNN-kebab-case-slug.md` where `NNNN` is a four-digit zero-padded sequence number. Use `0000-template.md` as the template.

The numbering is permanent. Don't renumber when a decision is superseded; mark the old ADR as `Superseded by NNNN` and let the history stand.

## Status values

- **Proposed** — under discussion, not yet committed.
- **Accepted** — decision made; the system reflects it (or will reflect it once the linked work ships).
- **Superseded** — replaced by a later ADR. The doc stays in the index for history.
- **Deprecated** — the decision no longer applies, but no successor exists. Rare.

## Index

Most recent first. When adding a new ADR, append to this list.

| # | Title | Status |
|---|---|---|
| [0014](0014-evy-memory-ts-port-of-memori.md) | Evy Memory — TS port of Memori for Tier 3 conversational memory | Accepted (ships v2.7.23) |
| [0013](0013-tinyfish-browser-api-integration.md) | TinyFish Browser API — dev-team workers drive Playwright, master stays lean | Accepted (queued, no version slot yet) |
| [0012](0012-1password-service-accounts-multibackend.md) | Multi-backend secret resolution with 1Password Service Accounts as first-class option | Accepted (queued v2.7.19 — shifted) |
| [0011](0011-trust-marker-hmac-replacement.md) | Replace trust-channel marker with HMAC + operator escape hatch | Accepted (complete — L1 v2.7.20, L2 v2.7.21) |
| [0010](0010-claude-mem-stays-parallel.md) | claude-mem stays parallel as Tier 4 observation corpus | Accepted |
| [0009](0009-self-hosted-only-no-cloud-memory.md) | Self-hosted only for any memory backend | Accepted |
| [0008](0008-eval-suite-pipeline.md) | Eval suite: regex fast-fail then LLM judge | Accepted |
| [0007](0007-think-tank-concept-dropped.md) | Drop the Think Tank concept from Evy's prompt | Accepted |
| [0006](0006-memori-byodb-sqlite-for-tier-3.md) | Memori (BYODB sqlite) for Tier 3 conversational memory | Superseded by [0014](0014-evy-memory-ts-port-of-memori.md) |
| [0005](0005-five-tier-memory-architecture.md) | Five-tier memory architecture | Accepted |
| [0004](0004-evy-persona-librarian-framing.md) | Evy persona, librarian framing | Accepted |
| [0003](0003-subctl-docs-folder-convention.md) | `.subctl/docs/` for project-local team artifacts | Accepted (ships v2.7.10) |
| [0002](0002-trust-channel-directive-wrapper.md) | Trust-channel directive wrapper for `subctl_orch_msg` | Accepted (ships v2.7.9) |
| [0001](0001-bash-gate-policy-floor.md) | `preset = "generic"` floor for bash-gate policy | Accepted (shipped v2.7.8) |

## How to write a new ADR

1. Pick the next number. Check the index.
2. Copy `0000-template.md` to `NNNN-your-slug.md`.
3. Fill in the sections. Be honest about alternatives considered and why they were rejected — that's the part future maintainers actually need.
4. Add to the index in this README.
5. Commit with the rest of the work, or as a standalone "docs(adr): ..." commit.
