# 0009: Self-hosted only for any memory backend

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** Constraint applied to all memory-related ADRs

## Context

Both memory frameworks evaluated for Tier 3 conversational memory (memU and Memori) offer cloud-hosted options. memU has api.memu.so. Memori has api.memorilabs.ai. Cloud options are typically faster to evaluate (zero ops setup, immediate API access) and offer richer features.

Subctl runs on M3 Ultra in Jason's home data center. The operator is an MSP owner with client data flowing through subctl's orchestration: dev work for client codebases, conversations about specific client business, references to project IDs and infrastructure that's not Jason's own.

If conversational memory egresses to a third-party cloud service:

- Every operator-Evy chat ships to that service.
- Every captured directive, decision, and handoff for client projects ships.
- The third-party operator has access to (or at minimum, custody of) MSP client business.

## Decision

**Self-hosted only.** No cloud egress for any memory backend that captures conversational content, observation traces, project artifacts, or operator-Evy chat history.

This constraint applies to:

- Tier 3 — Memori is configured in BYODB self-hosted mode (sqlite at `~/.local/state/subctl/memori.db`). The cloud option (api.memorilabs.ai) is not used. See [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md).
- Tier 4 — claude-mem already self-hosts its observation corpus locally.
- Tiers 1, 2, 5 — file-based on the operator's host, never egress.
- Future voice layer (see [persona/voice-future.md](../persona/voice-future.md)) — same constraint. TTS rendering happens locally, audio does not egress.

External services subctl already uses (Anthropic, OpenAI, Brave Search, Firecrawl, Linear, Context7) are out of scope of this constraint because their purpose is explicit per-request work, not storage. Operator opts in to each per-request egress by configuring the API key. They are not memory backends.

## Reasoning

- **MSP context.** Client data flows through subctl. Egressing client conversations to a third party introduces consent, contractual, and reputational risk that isn't tolerable.
- **Privacy floor on memory is non-negotiable.** Memory is persistent. A one-time API call to an LLM is bounded; a memory backend retains content indefinitely. The risk surface is different.
- **Cloud convenience is not worth the trade.** Setup overhead is real, but BYODB sqlite or local Postgres is a one-time cost. The trade of operational simplicity vs persistent client-data egress is not balanced.
- **Architecture honesty.** Subctl is an "agentic coding harness for the AI subscriptions you already pay for." That positioning implies operator control of their workflow. Routing memory through a third-party cloud service contradicts the positioning.

## Consequences

### Positive

- Operator retains full control of all conversational memory, project artifacts, and observation traces.
- No vendor lock-in at the storage layer beyond what the BYODB substrate enforces.
- Backup and disaster recovery are operator-controlled file operations.
- Migration between backends (memU, Memori, claude-mem, future alternatives) becomes a local-data-rearrangement problem, not a cloud-export problem.
- MSP client risk is bounded to the per-request egress that operator explicitly configures.

### Negative

- Self-hosting adds ops overhead. BYODB sqlite is the cheapest viable substrate but still requires file management.
- Some cloud-only features may be unavailable. Memori cloud has features the BYODB documentation doesn't cover. Worth confirming BYODB feature parity for what we actually use.
- Operator is responsible for backup, recovery, and disaster mitigation of memory stores.
- Cross-host sync (M5 and M3) becomes the operator's problem, not the cloud's.

### Open questions

- Backup strategy. Should subctl auto-backup the Memori sqlite + MEMORY.md + claude-mem corpus? Currently no; operator handles. Worth a future ADR if it becomes a recurring source of data loss.
- Operator-explicit cloud opt-in. If a future use case genuinely benefits from cloud memory (e.g., a published library of expert memories), should there be a mode to opt-in for specific scoped data? Currently no; revisit if a real need surfaces.

## Alternatives considered

### Alternative A: Cloud + local cache

Use cloud as the primary store with a local cache for offline operation. Best of both worlds in theory.

Rejected because the cache doesn't reduce the egress; it just makes it asynchronous. Client data still ships eventually.

### Alternative B: Cloud for non-sensitive scopes, local for sensitive scopes

Operator-tagged scopes determine whether memory egresses. Sounds reasonable.

Rejected because the tagging discipline puts the burden on the operator to remember which scope a given exchange falls under, every time. Easy to slip. The blanket "no cloud" rule is enforced by configuration; the scoped rule is enforced by vigilance.

### Alternative C: Self-host with operator-permitted egress

Default self-hosted, but operator can flip a flag per-conversation to enable cloud capture for that thread.

Rejected on similar grounds to (B). The decision should not be per-conversation; it should be infrastructure-level.

## References

- [ADR 0005](0005-five-tier-memory-architecture.md) — the tier model
- [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) — Memori BYODB choice
- [ADR 0010](0010-claude-mem-stays-parallel.md) — claude-mem's role
- Decision session: 2026-05-12 with operator
