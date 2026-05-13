# 0007: Drop the Think Tank concept from Evy's prompt

- **Status:** Accepted
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.12 (persona prompt rewrite)

## Context

Operator authored a complete persona spec for Evy that was originally written in the ArgentOS context. The ArgentOS family includes a "Think Tank" concept: a panel of four named AI executives (Dario, Sam, Elon, Jensen) convened for strategic-trade-off questions. Evy in Argent dispatches to the Think Tank when a question is too consequential to decide alone.

Subctl does not have a Think Tank. It has dev teams in tmux and direct tools at the desk, but no panel-deliberation mechanism. The question arose during the persona adoption: keep the Think Tank reference in Evy's prompt as a forward-looking capability, drop it entirely, or build a subctl-shaped version now.

Three options were laid out:

- **(a)** Drop entirely. Evy doesn't pretend a capability she doesn't have. When strategic-trade-off questions arrive, she follows her standard pushback/escalation protocol.
- **(b)** Keep as forward-looking. Evy says "this is Think-Tank-shaped; we don't have that team yet, planned for v2.8.0."
- **(c)** Build a subctl Think Tank now. Team-template that spawns 4 specialist sessions to deliberate. Bumps v2.7.12 scope.

## Decision

**Drop the Think Tank reference from Evy's prompt entirely.**

When a strategic-trade-off-shaped question arrives, Evy follows her standard protocol: surface the trade-off nature, list the options, recommend one, end with "Your call." Wait. No reference to a Think Tank that doesn't exist.

If panel deliberation lands as a team template in v2.8.0 or later, one paragraph gets added back to the Family section at that time: "For strategic-trade-off-shaped questions, the panel deliberation team is available." That's the entire change. No retroactive scaffolding needed now.

## Reasoning

Operator's reasoning, recorded verbatim during the decision session:

> "(a) is right because of Evy's first principle. 'She doesn't fabricate' extends past citations. If she references a capability she doesn't have, she's lying to the operator in a structural way — every time it comes up, you have to remember 'oh right, that doesn't exist yet.' That's exactly the kind of phantom feature that turns an orchestrator into a thing you route around instead of through.
>
> (b) sounds disciplined but isn't. 'This is Think-Tank-shaped; we don't have that team yet' is performative competence. It's the orchestrator telling the operator about a feature in a way that doesn't help the operator. If the capability isn't there, the right move is for Evy to do what she'd do anyway — surface the strategic-tradeoff nature, give her recommendation, list the tradeoffs, and wait. The behavior is what matters; the label 'Think Tank' is just the Argent-side branding for it.
>
> (c) is a real option but not for v2.7.12. Spawning four Claude Code sessions to deliberate a question is genuinely useful, but it's a team-template feature, not a persona feature. Bundling it into the same release as Evy muddies what you're shipping. Evy is 'the orchestrator has a coherent voice.' A panel deliberation template is 'subctl can convene specialist juries on demand.' Both good. Ship them separately so when something breaks, you know which one broke it."

This establishes a general principle worth pinning beyond this specific decision: **no phantom capabilities in Evy's prompt.** If a feature isn't shipped, Evy doesn't pretend it is. Performative references to absent capabilities ("planned for vX.Y.Z") are structurally dishonest because they suggest the capability exists in some form when it doesn't.

## Consequences

### Positive

- Evy's prompt doesn't claim capabilities subctl lacks. The "no fabrication" rule extends past citations to feature references.
- Operator doesn't have to mentally translate "Evy would call the Think Tank" into "Evy would escalate to me with a recommendation" on every relevant question.
- Releases stay focused. Persona work in v2.7.12 ships as persona work. Panel-deliberation, if it lands, ships as its own feature.

### Negative

- When v2.8.0 or later does add a panel-deliberation template, the persona prompt needs a one-paragraph addition. Minor.
- The original spec at [persona/evy.md](../persona/evy.md) still references the Think Tank because the spec is preserved verbatim. The subctl-specific adaptations section at the bottom of that document explains the drop. Future contributors reading the spec without reading the adaptations could be confused. Mitigated by the adaptation section being clearly labeled.

### Open questions

- When (if) panel deliberation lands as a team template, what's it called? "Think Tank" is the Argent-side branding. Subctl might want a different name to avoid implying a port of Argent's concept. Open until that work is scheduled.

## Alternatives considered

### Alternative A: Keep reference, mark as forward-looking

Treated above. Rejected as performative competence.

### Alternative B: Build the subctl Think Tank now

Treated above. Rejected because it muddies the v2.7.12 release. Will be considered for v2.8.0+ team templates.

## References

- [persona/evy.md](../persona/evy.md) — full spec, includes verbatim Think Tank references + the adaptations section that documents the drop
- [ADR 0004](0004-evy-persona-librarian-framing.md) — adoption of the persona
- [roadmap.md](../roadmap.md) — v2.8.0 team templates may add panel deliberation
- Decision session: 2026-05-12 with operator
