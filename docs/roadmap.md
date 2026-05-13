# Roadmap

- **Status:** Living document
- **Last revised:** 2026-05-12
- **Cadence:** Updated when waves are planned or shipped

This document tracks subctl's near-term release waves. Shipped versions appear in [CHANGELOG.md](../CHANGELOG.md); this is the forward plan.

## Currently shipping

### v2.7.x — "bash gate stabilization + Evy persona + memory architecture" wave

The active wave. Bug fixes from the bash-gate landing, the orchestrator persona named Evy, and the foundation for proactive memory.

| Version | Theme | Status |
|---|---|---|
| 2.7.5 | argent-inspired update polish (status, --channel, --json, --yes, --timeout) | Shipped |
| 2.7.6 | (folded into 2.7.5 retrospectively) | n/a |
| 2.7.7 | system_subctl_knowledge tool (TOON breakdown) + baseUrl default fix + dashboard logo | Shipped |
| 2.7.8 | policy floor (`preset = "generic"`) + bun path fallback + msg race fix | Shipped |
| 2.7.9 | snapshot.project_root + trust-channel directive wrapper | In flight (pr20) |
| 2.7.10 | team-docs master tools (`team_doc_*`, `team_decision_log`) | In flight (pr21) |
| 2.7.11 | chat tool-badges (neon glow) + thinking indicator | In flight (pr22) |
| 2.7.12 | Evy persona rewrite + autonomous skills + proactive memory + eval harness | Queued |
| 2.7.13 | Memori (BYODB sqlite) integration for Tier 3 conversational memory | Queued |
| 2.7.14 | Project skeleton at spawn + ship subctl-team-protocol / handoff-protocol / spec-driven-dev skills | Queued |
| 2.7.15 | Ecosystem skill bundles (node-conventions, python-conventions, rust-conventions) + agent definitions baseline | Queued |
| 2.7.16 | Phase 3s capability bridge groundwork | Queued |

### v2.8.0 — "team templates" wave

The architectural feature subctl was built for: actual multi-agent teams with declared rosters, skills, and tool scoping per role. Builds on top of the v2.7.x foundation.

| Theme | Description |
|---|---|
| Team template format | TOML schema for declaring a team: lead persona, developer roster, per-role skills, per-role tool allowlists |
| Template loader | Reads templates, renders into a spawn-time package |
| Lead-side roster injection | The lead's system prompt knows its team at spawn time |
| Developer personas | Each developer in `<project>/.claude/agents/<name>.md` with persona + skills baked in |
| Per-developer tool scoping | Each developer constrained to their declared tools |
| `subctl_team_dispatch` master tool | Lead dispatches by developer name, not generic Task() |
| Stock templates | Ship 4-5: `full-stack-web`, `rust-api`, `data-pipeline`, `ml-research`, `infrastructure` |
| Phase 3s capability bridge | Adopts Claude Code's agent-view substrate for visibility |

Open: panel-deliberation template (the Think Tank concept dropped in [ADR 0007](adr/0007-think-tank-concept-dropped.md)) may land as a stock template here.

## Beyond v2.8.0

### v2.9.x — "operator-facing policy UI" wave

The work originally queued as v2.7.9-13 before the persona/memory work took priority. Operator can author and edit policy without TOML knowledge.

| Theme | Description |
|---|---|
| Dashboard "Apply preset" button per project | Writes `.subctl/policy.toml` with chosen preset; no TOML editing required |
| Resolved-policy chip-list view | Click a team in the dashboard Policy tab, see the allowlist as readable chips |
| User-level policy editor | Form-based editor for `~/.config/subctl/policy.toml` |
| Project policy editor | Same shape, for `<project>/.subctl/policy.toml` |

### Later (not yet versioned)

- **Per-developer policy snapshots.** Each developer in a team gets a scoped snapshot. Frontend dev can't run terraform; DevOps dev can't edit React components. Reduces blast radius of mistakes.
- **Per-developer account routing.** Templates declare which account each developer runs on. Lets a single team use multiple accounts (claude-jason, claude-titanium, claude-semfreak) in parallel.
- **Dashboard team-template editor.** GUI for defining custom templates.
- **Watchdog dashboard surface.** Watchdog data is in `/diag` today but doesn't render on the Orchestration tab. Worth a small PR.
- **Voice layer.** [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) or equivalent. Spoken Evy. Likely a v2.9.x or v3.x feature; deferred until text-Evy is stable.
- **SIS / autonomous prompt iteration.** Evy's system prompt evolves based on eval-score trends, with operator approval gating every change. Eval-score infrastructure ships in v2.7.12; the autonomous-iteration loop is much later.
- **Cross-host memory sync.** M5 and M3 maintaining synchronized Tier 1 / Tier 3 stores.

## Sequencing principles

A few rules that shape how the waves are ordered:

1. **One shape change per wave.** Don't bundle a persona change with a memory backend change. If something breaks, you want to know which one broke it.
2. **No phantom capabilities in prompts.** If a feature isn't shipped, Evy doesn't pretend it is. See [ADR 0007](adr/0007-think-tank-concept-dropped.md).
3. **Hard rules in tool schemas, soft behavior in prompts.** Anything load-bearing (provenance, agent naming, destructive-action confirmation) gets enforced by tool signatures, not by trusting the prompt.
4. **Docs before code for load-bearing decisions.** The ADRs that gate a wave's correctness ship before the code does. Future maintainers should be able to trace any line of code back to its decision.
5. **Eval harness before the persona.** The 24-test eval suite scaffolding ships with v2.7.12. The persona only ships after we can grade it.

## How this document gets updated

When a wave ships, move its row to "Shipped" status in the table above. When a new wave is planned, append it.

If a future ADR supersedes a planned version's theme (e.g., we decide v2.7.16 doesn't make sense after all), update this document in the same commit as the ADR.

Do not rewrite history. If a version was planned and then dropped, mark it as `Dropped` with a link to the ADR explaining why.
