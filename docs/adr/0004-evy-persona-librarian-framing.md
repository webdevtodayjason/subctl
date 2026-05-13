# 0004: Evy persona — librarian framing for the master orchestrator

- **Status:** Accepted (ships v2.7.12)
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.12 (pr23, queued)

## Context

The master daemon is the subctl orchestrator: a long-running agent that runs on M3 Ultra, talks to the operator through the dashboard and Telegram, dispatches dev teams in tmux, watches stale work, and surfaces decisions that need operator input.

Pre-v2.7.12, the master's identity was declared as "You are subctl master" in `components/skills/master/SKILL.md`. Generic. The operator-observed effect: master had no consistent voice, drifted into generic-AI-assistant phrasing ("Great question!", "Let me check on that for you!"), and the operator was forced to nudge through repeated long sessions to keep it on task.

Two observable behaviors revealed the persona gap:

1. Master had self-named as "the librarian" during multiple sessions without that identity being declared. It was reaching for an archetype on its own. The archetype was a good fit but wasn't backed by a coherent voice spec.
2. Workers (dev teams) refused legitimate master directives because they looked like prompt injection. This was diagnosed as a trust-channel issue (see [ADR 0002](0002-trust-channel-directive-wrapper.md)) but also as a master-side framing problem: directives without anchored authority looked like noise.

Operator authored a complete persona specification for the orchestrator on 2026-05-12, naming it Evy (short for Evelyn — Evy Carnahan from The Mummy, "I am a librarian!"). The librarian framing is operationally honest: the orchestrator catalogs, routes, verifies, and files. It doesn't write the books.

## Decision

Adopt the Evy persona as the canonical identity for the master daemon. Rewrite `components/skills/master/SKILL.md` per the spec at [persona/evy.md](../persona/evy.md), adapted to subctl's actual backends (see Subctl-Specific Adaptations in that doc).

Key persona elements:

- **Name:** Evy. ("subctl" is what she is technically; Evy is what she answers to.)
- **Framing:** Librarian. She runs the desk. She catalogs, routes, verifies, files.
- **Voice register:** Dry, precise, slightly impatient with hand-holding. No padding, no em dashes, no apology for being thorough.
- **Operating stance:** CATALOG → ROUTE → VERIFY → FILE for every meaningful request.
- **Pushback protocol:** "State, recommend, Your call, wait." One pushback per decision. No re-arguing after override.
- **Hard rules:** No fabrication. No dispatching what she doesn't understand. No hiding failure. No unnecessary fan-out. No padding. No disappearing into long tasks without checkpointing.

## Reasoning

- **Librarian framing is operationally honest.** Orchestrators sound like they're conducting symphonies; librarians sound like they're keeping the building from collapsing. The second describes the work more accurately and sets correct operator expectations.
- **Coherent voice reduces drift.** A specific persona with specific voice rules is more robust over long sessions than a generic "AI assistant" identity. The model has shape to anchor on.
- **Hard rules in the spec reduce hallucination.** "No fabrication. No fan-out. No padding." Repeated as enforceable rules in the prompt. The anti-hallucination floor stays the same as pre-v2.7.12 SKILL.md; Evy inherits it.
- **Pushback protocol is the highest-drift area.** "State, recommend, Your call, wait" is rigid by design. Catches the two failure modes orchestrators most often slip into: pass-through laundering and moralizing.
- **Character anchor.** Evy Carnahan is a precise reference: librarian-trained, brave when needed, owns her mistakes plainly. Not cosplay — a personality shape the model can inhabit consistently.

## Consequences

### Positive

- Master has a consistent voice across sessions.
- Operator-Evy interaction becomes faster because Evy doesn't pad, doesn't re-state, doesn't ask redundant questions.
- The "What you will not do" rules are enforceable in eval (see [ADR 0008](0008-eval-suite-pipeline.md)).
- Persona drift becomes measurable: passive checks on em-dash count, padding patterns, repeated pushbacks.
- Hard rules (no fabrication, destructive-action confirmation) are also enforced at tool-schema level for the most important cases.

### Negative

- The persona is now load-bearing. Changes to SKILL.md need to re-run the eval suite to confirm no regression.
- Voice preset architecture gains a new default (`evy.toml`). Existing presets (straight-shooter, witty, etc.) remain available but are no longer the default.
- Some legacy SKILL.md content gets removed; the new prompt is a near-full rewrite, not a delta. Risk: missing an existing constraint. Mitigation: the eval suite covers the most important behaviors explicitly.

### Open questions

- How often should the persona prompt itself be iterated? Currently the answer is "weekly during early deployment, monthly once stable" per the spec. The SIS / autonomous-prompt-iteration concept is parked.
- Should sub-agents (dev teams) get persona names too? Operator suggested yes (frontend-architect, backend-architect, etc. via team templates). Deferred to v2.8.0.

## Alternatives considered

### Alternative A: Keep "subctl master" as generic identity

Don't pick a name or a character anchor; just tighten the existing anti-hallucination rules and add a voice section.

Rejected because the operator-observed drift wasn't fixable by tightening generic rules. Generic identity means generic voice. The model needs an anchor.

### Alternative B: Different character anchor

Considered briefly. The librarian framing came from master's own self-naming pattern (which fit Evy Carnahan exactly). No alternative was seriously evaluated because the fit was good and the operator had already done the design work.

### Alternative C: No persona, just rules

Skip the character framing entirely; just publish "rules of conduct." Rejected because rules alone don't shape voice. The spec deliberately mixes identity ("You are a librarian") and rules ("You will not fabricate") to give the model both shape and constraint.

## References

- [persona/evy.md](../persona/evy.md) — the full persona spec
- [ADR 0007](0007-think-tank-concept-dropped.md) — subctl-specific adaptation
- [ADR 0008](0008-eval-suite-pipeline.md) — how the persona gets measured
- Decision session: 2026-05-12 with operator
- Character reference: Evelyn "Evy" Carnahan, *The Mummy* (1999)
