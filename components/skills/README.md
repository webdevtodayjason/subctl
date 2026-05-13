# Skills

This directory holds subctl's first-party skills — the `SKILL.md` bundles
the master daemon loads at boot and that workers (team-spawned Claude Code
sub-agents) reference by name at spawn time.

Each skill is a directory with a single `SKILL.md` file whose YAML
frontmatter declares `name` and `description`. The body is markdown — the
content the skill actually loads into context when activated.

This is distinct from the imported skill **catalog** at
`~/.config/subctl/skills/` (managed by `subctl skills import …` from
`skills.sh`). First-party skills live here in the repo; imported third-party
skills live in the catalog dir.

## Shipped skills

| Skill | One-line purpose |
|-------|------------------|
| **`master/SKILL.md`** | Evy — the subctl master orchestrator persona. Loaded by the master daemon at boot. Canonical spec: `docs/persona/evy.md`. |
| **`orchestrator-mode/SKILL.md`** | Activate the multi-pane orchestrator + team-agent workflow in Claude Code. Operator-side. |
| **`autonomy/SKILL.md`** | Operator-defined autonomy levels (`auto`, `ask`, `manual`) and how skills should behave under each. |
| **`subctl/SKILL.md`** | The subctl CLI surface — verbs, flags, configuration paths — for any agent that needs to drive subctl programmatically. |
| **`subctl-team-protocol/SKILL.md`** | The wire protocol between a team lead and its workers — `SendMessage`, shutdown_request, plan_approval_request, task lifecycle, idle state. Both sides load this. |
| **`handoff-protocol/SKILL.md`** | How a worker hands off mid-task — context summary, what's done/pending, commit hygiene, escalation thresholds. |
| **`spec-driven-dev/SKILL.md`** | Workflow for executing against a written spec — read it twice, ask one question only for real ambiguity, implement, verify against DONE WHEN, report back. |
| **`node-conventions/SKILL.md`** | Node / Bun / TypeScript house style — runtime choice, imports, naming, errors, async, testing, logging, commits. |
| **`python-conventions/SKILL.md`** | Python house style — uv, ruff, pytest, types, errors, async, packaging. |
| **`rust-conventions/SKILL.md`** | Rust house style — cargo, clippy, rustfmt, `thiserror`/`anyhow`, tokio, testing. |

## How a skill is loaded

Two paths:

1. **At master boot.** The master daemon's system prompt is assembled from
   `master/SKILL.md` (Evy persona) plus operator memory (Tier 1) plus tool
   schemas. See `docs/master.md` §3.2.

2. **At worker spawn time.** When a team template references a skill by
   name (e.g. `skills = ["node-conventions", "spec-driven-dev"]` in a v2.8.0
   team template), the lead injects the named skills' `SKILL.md` content
   into the worker's spawn prompt. The worker receives the skill content as
   part of its system context — no runtime lookup.

The v2.8.0 team-templates wave will be the consumer of these skills' names.
Skill names declared here are the canonical strings template TOML files reference.

## Naming conventions

Skill directory names are `kebab-case` and match the `name:` field in the
SKILL.md frontmatter exactly. Don't introduce a third name (e.g. don't have
`dir: node-style/`, `name: nodejs-conventions`). The match must be 1:1 so
the lookup is unambiguous.

Three families of names:

- **`<area>-protocol`** — message contracts between agents
  (`subctl-team-protocol`, `handoff-protocol`)
- **`<workflow>-dev`** — how to execute work
  (`spec-driven-dev`)
- **`<ecosystem>-conventions`** — house style per language
  (`node-conventions`, `python-conventions`, `rust-conventions`)
- **`<persona>`** — the master daemon's own persona
  (`master`, `orchestrator-mode`, `autonomy`, `subctl`)

## Adding a new skill

1. Create `components/skills/<name>/SKILL.md` with YAML frontmatter
   (`name`, `description`).
2. Body is the actual content — what the agent needs to know when the skill
   activates.
3. Add a row to the table above with a one-line description.
4. If the skill is intended for team templates, mention it in
   `docs/master.md` §2.3.
5. If it deprecates a prior skill, link the deprecation in both directions.

## Agent definitions

Separate but related: `.claude/agents/<name>.md` files declare named
sub-agent personas. Each agent definition has frontmatter listing the
skills it loads at spawn. Shipped in v2.7.33:

| Agent | Purpose |
|-------|---------|
| `expert-bun-typescript` | Bun + TS specialist — master modules, dashboard server routes, CLI scripts. |
| `expert-react-typescript` | React + TS specialist — dashboard frontend, Next.js, hooks, components. |
| `expert-rust-systems` | Rust systems — performance paths, CLI tools, async services with tokio. |
| `expert-devops-mac` | macOS DevOps — launchd, tmux, install.sh, Homebrew, M3 fleet management. |
| `tester-bun` | bun:test specialist — coverage, flakiness diagnosis, contract-shaped tests. |

The v2.8.0 team-templates wave declares which agent personas each template
uses. The lead spawns sub-agents by name; the agent definition tells it
which skills to bundle into the spawn prompt.
