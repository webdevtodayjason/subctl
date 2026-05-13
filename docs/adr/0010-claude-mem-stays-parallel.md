# 0010: claude-mem stays parallel as Tier 4 observation corpus

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.13 (when Memori lands at Tier 3)

## Context

Pre-v2.7.13, claude-mem was the only persistent memory system in subctl. It captures observations from active Claude Code sessions across all `CLAUDE_CONFIG_DIR` roots (claude-jason, claude-titanium, claude-semfreak), indexes them semantically, and surfaces them via the `memory_search`, `memory_timeline`, and `memory_observations` master tools.

When Memori was selected as the Tier 3 substrate ([ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md)), an open question surfaced: what happens to claude-mem? Three options:

1. Retire claude-mem after Memori covers conversational memory.
2. Run them in parallel for different jobs.
3. Migrate claude-mem's corpus into Memori and use only Memori going forward.

## Decision

**claude-mem stays parallel.** Memori is Tier 3 (conversational memory: operator-Evy chat, auto-captured, auto-recalled, structured types). claude-mem is Tier 4 (cross-session observation corpus: tool calls, decisions, work patterns across multiple Claude Code sessions and accounts, explicit search via `memory_search`).

They are orthogonal jobs. No retirement, no migration.

This holds for at least one month after Memori ships in v2.7.13. After a month of dual operation, re-evaluate whether Memori's structured types cover the observation-capture job claude-mem does. If yes, consider collapsing Tier 4 into Tier 3 then. If no, keep parallel indefinitely.

## Reasoning

- **Different jobs.** Memori captures *what was said* between operator and Evy. claude-mem captures *what was done* across Claude Code sessions (tool calls, error patterns, work observations). Conflating these into one substrate either bloats Memori with non-conversational content or loses the structured-type richness Memori provides for chat.
- **Different consumers.** Memori auto-injects relevant past chat into Evy's next turn (operator-Evy continuity). claude-mem is searched on demand when Evy or the operator references work history (audit, debug, pattern detection). Different access patterns mean different schemas, different indices, different recall mechanisms.
- **Different lifecycles.** Memori grows with every operator-Evy turn. claude-mem grows with every Claude Code tool invocation across multiple accounts. The volume profiles, retention policies, and consolidation needs differ.
- **Migration cost is real.** Even if Memori could in principle do both jobs, migrating claude-mem's existing corpus into Memori's schema is a project. Not worth doing speculatively.
- **Risk-bounded.** Running both in parallel costs a sqlite file (Memori) plus the existing claude-mem corpus. Not expensive. If Memori turns out to underdeliver on conversational continuity, claude-mem is still there as the fallback.

## Consequences

### Positive

- Both jobs (conversational memory + observation capture) keep working through the v2.7.13 transition. No window where memory is broken.
- The claude-mem corpus stays queryable for historical sessions that predate Memori. The session-start context table operator gets from claude-mem keeps producing useful output.
- Operator gets to compare the two systems in practice over a month before any consolidation decision.
- Tool surface stays familiar. `memory_search`, `memory_timeline`, `memory_observations` keep working unchanged. Tier 3 adds new behavior (automatic recall) without replacing tier 4's surface.

### Negative

- Two memory systems means two backup/restore concerns, two failure modes, two upgrade paths.
- Operator has to know which tier each piece of memory lives in. Mitigated by Evy's filing convention (always name the tier on a filing message — see [memory-architecture.md](../memory-architecture.md)).
- Potential confusion if memory appears to overlap between tiers. E.g., a decision logged in `.subctl/docs/decisions.jsonl` (tier 5) might also be reflected as a structured type in Memori (tier 3) if it was discussed in chat. Currently accepted; if it becomes operator-visible friction, revisit.

### Open questions

- One-month re-evaluation window. Specifically, what would shift the decision toward consolidation? Likely candidates: if Memori's "events" type proves a superset of claude-mem's observations, OR if claude-mem's corpus stops growing because all observation-worthy activity now flows through operator-Evy chat.
- Cross-host claude-mem corpus. M5 and M3 each have their own claude-mem. Sync is currently not supported. Not changed by this ADR; flagged as a separate concern.
- claude-mem MCP server: does it stay enabled in master's config? Currently yes; provides the search tools master uses.

## Alternatives considered

### Alternative A: Retire claude-mem after Memori ships

Decommission once Memori is stable. Reduce to one memory system.

Rejected because Memori is conversational-memory-shaped; claude-mem is observation-corpus-shaped. The retirement would leave the observation-capture job unowned.

### Alternative B: Migrate claude-mem corpus into Memori

Bulk-import existing claude-mem observations into Memori as events. Use Memori for everything going forward.

Rejected because:
- The schema translation is non-trivial. claude-mem's observation shape doesn't map cleanly onto Memori's structured types.
- It commits us to Memori before we know Memori works for our use case. The parallel-run period is exactly the validation we want.
- claude-mem's session-start context-table feature is a useful operator-facing affordance that Memori doesn't replicate.

### Alternative C: One-month parallel, then automatic consolidation

Same parallel approach, but commit now to migrating after a month regardless of outcome.

Rejected because pre-committing to the consolidation removes the option to keep them parallel if both prove useful. The one-month window is for *re-evaluation*, not pre-decided action.

## References

- [memory-architecture.md](../memory-architecture.md) — the full tier model
- [ADR 0005](0005-five-tier-memory-architecture.md) — the tier model decision
- [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) — Memori choice
- Decision session: 2026-05-12 with operator
