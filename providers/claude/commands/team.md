---
description: Activate orchestrator + team-agent mode — delegate parallel work to worker panes
---

# /team — Orchestrator Mode

Invoke the `orchestrator-mode` skill to switch this session into multi-pane orchestrator + team-agent workflow.

Instructions for Claude:

1. Load and activate the `orchestrator-mode` skill at `~/.claude/skills/orchestrator-mode/SKILL.md`.
2. Follow the protocol in that skill file exactly — do not improvise.
3. Respond with the activation block specified in the skill (Protocol in effect, Current session state, Awaiting first task).
4. Do NOT start any work until the user gives the first task AND approves the plan.

Key reminders baked into the skill:
- Every worker dispatch uses `TeamCreate` + `Agent` with `team_name` (never plain sub-agents).
- Orchestrator never writes source code — only coordinates.
- `ORCHESTRATION.md` ledger must be maintained at the repo root.
- Verify every worker deliverable before marking it done.
