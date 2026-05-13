# 0005: Five-tier memory architecture for Evy

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.10 (tier 5 tools), v2.7.12 (tier model declared in SKILL.md), v2.7.13 (tier 3 substrate)

## Context

Subctl's memory story has accumulated over time. Multiple stores exist for different purposes, but they were not organized into a coherent tier model. Operator-Evy chat memory had no automatic continuity across sessions. Workers had no project-local doc folder. claude-mem captured observations but its job was conflated with "Evy's memory" in operator framing.

When the question came up of whether to add a proactive memory framework (memU or Memori), the prerequisite question was: what is the tier model and which tier does the new substrate serve?

Without a tier model, adding memU or Memori risked duplicating claude-mem's job, conflicting with the existing tier 1 MEMORY.md system, or polluting the operator's Obsidian vault with subctl-managed content.

## Decision

Adopt a five-tier memory model. Each tier has a distinct job, substrate, and write/read pattern. Tiers do not compete; they are orthogonal.

| Tier | Job | Substrate | Status |
|---|---|---|---|
| 1 | Operator profile + learned facts | `MEMORY.md` | Shipped |
| 2 | Operator-curated long-term notes | Obsidian vault | Existing, read-only from Evy |
| 3 | Conversational memory (auto-captured, auto-recalled) | Memori BYODB sqlite | Ships v2.7.13 |
| 4 | Cross-session observation corpus | claude-mem | Shipped, role clarified |
| 5 | Per-team project artifacts | `<project>/.subctl/docs/` | Tools ship v2.7.10 |

Hard rules across all tiers:

- **Tier 2 is read-only from Evy** without explicit operator instruction. The vault is the operator's territory.
- **Tier 3 captures and recalls automatically** via Memori SDK interception of the OpenAI-compat client. Evy does not decide to look; the memory is in her context.
- **Tier 4 stays parallel** to tier 3, not subsumed by it. Different job. See [ADR 0010](0010-claude-mem-stays-parallel.md).
- **Tier 5 has path-traversal protection** at the tool level. `..` and absolute paths are rejected.

Filing convention: when Evy names a filing destination, she names the tier. "Filed in claude-mem under HoLaCe billing notes" is unambiguous; "Filed under HoLaCe billing notes" is not.

## Reasoning

- **Different jobs deserve different substrates.** Conflating "facts I always need" (tier 1) with "things I want to look up sometimes" (tier 4) means either over-loading the system prompt or under-using the lookup corpus.
- **Operator owns tier 2.** The vault is where the operator does their own thinking. Letting Evy write there silently would erode that boundary. Tier 2 being read-only from Evy keeps it as the operator's clean workspace.
- **Conversational memory needs proactive recall, not on-demand search.** Tier 3's auto-injection at turn start is the difference between "agent that COULD remember" and "agent that DOES remember." This is the gap memU/Memori solve. See [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md).
- **Project artifacts need to be `cat`-able by workers.** Tier 5 lives in the project root specifically so workers can read it via `cat .subctl/docs/SPEC.md` without TCC issues or path translation.
- **The tier model is for Evy to reason with.** It's not just architecture documentation. The persona prompt teaches Evy the tiers so she can route writes correctly and surface "filed in tier X" provenance to the operator.

## Consequences

### Positive

- Each tier has a clear owner, writer, and reader.
- The "should we add memU?" question reduces to "memU or Memori for tier 3" — much simpler.
- claude-mem's role is preserved without conflict with the new conversational memory layer.
- The Obsidian vault stays operator territory, eliminating accidental contamination.
- Workers can read project artifacts without TCC permissions or vault path translation.

### Negative

- More moving parts. Five tiers means five places memory can live. Operator needs to know which is which.
- Filing convention requires Evy to name the tier on every filing. Adds verbosity to her responses. Worth it for operator clarity.
- Migration from the pre-tier-model state needs care. claude-mem's existing corpus stays; the new tiers don't retroactively reorganize it.

### Open questions

- Cross-host memory sync. M5 and M3 each have their own tier 1 and (will have) their own tier 3. Should they sync? Currently no, but worth a future ADR.
- Tier 3 ⇄ Tier 4 migration. If Memori's structured types prove sufficient for the observation-capture job claude-mem does, tier 4 could collapse into tier 3. Re-evaluate one month after v2.7.13 ships.
- Tier 2 retention. Operator's vault is currently external to subctl. Should subctl back it up or just reference it? Currently: reference only.

## Alternatives considered

### Alternative A: Three tiers

Collapse tiers 1+3 into "all conversational memory in MEMORY.md" and tiers 4+5 into "all artifact memory in claude-mem corpus." Simpler at first glance.

Rejected because: tier 1 has a char budget (must fit in every prompt); conversational memory does not (it's auto-recalled, not always-loaded). Different shape, different substrate.

### Alternative B: Two tiers

"Operator memory" (tier 1) and "everything else" (a single big corpus). Maximally simple.

Rejected because: the operator-curated vault (tier 2) cannot be in the same bucket as agent-written artifacts (tier 5). Mixing them breaks the operator's clean workspace.

### Alternative C: memU as one big tier-3 storage

Replace tier 1 + tier 3 + tier 4 with a single memU instance. memU's "memory as filesystem" model could in principle hold all three.

Rejected because: memU is Python-only (operational cost on M3), requires Postgres + pgvector (more containers), and the proactive-agent subprocess pattern adds a launchd plist. The cost of the dependency exceeds the benefit of consolidation. See [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) for the choice between memU and Memori.

## References

- [memory-architecture.md](../memory-architecture.md) — full tier reference
- [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) — Memori choice
- [ADR 0009](0009-self-hosted-only-no-cloud-memory.md) — privacy floor
- [ADR 0010](0010-claude-mem-stays-parallel.md) — tier 4 role
- [ADR 0003](0003-subctl-docs-folder-convention.md) — tier 5 path
- Decision session: 2026-05-12 with operator
