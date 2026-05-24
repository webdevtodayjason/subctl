# Subctl Memory Architecture

- **Status:** Canonical
- **Last revised:** 2026-05-12
- **Related ADRs:** [0005](adr/0005-five-tier-memory-architecture.md), [0006](adr/0006-memori-byodb-sqlite-for-tier-3.md), [0009](adr/0009-self-hosted-only-no-cloud-memory.md), [0010](adr/0010-claude-mem-stays-parallel.md)

This document describes how subctl's Evy daemon stores, retrieves, and uses memory across sessions. Five tiers, each with a distinct job. Tiers are not strictly ordered by priority; they're ordered by lifetime / scope / who-writes-them.

> **Terminology.** "Evy" is the canonical name for the persistent daemon (and her persona). Some code-level paths in this doc still use `master/` — see [glossary.md](glossary.md). Code identifier rename ships in Phase 3.

## The five tiers at a glance

| # | Name | Scope | Who writes | Who reads | Substrate |
|---|---|---|---|---|---|
| 1 | MEMORY.md | Operator profile + learned facts | Evy via `memory_remember` / `memory_user_update`; operator via dashboard Memory tab | Evy at every turn (always in prompt) | File: `~/.config/subctl/master/MEMORY.md` |
| 2 | Obsidian vault | Operator-curated long-term notes | **Operator only.** Evy reads, does not write without explicit operator instruction. | Evy on demand | Filesystem path in `policy.json` |
| 3 | Memori | Conversational memory, auto-captured operator-Evy chat, structured types (preferences, rules, relationships, skills) | Memori SDK background process (auto) | Evy automatically at turn start; explicit recall via SDK on demand | sqlite at `~/.local/state/subctl/memori.db` (BYODB) |
| 4 | claude-mem | Cross-session observation corpus for debug, audit, pattern detection | claude-mem hook (auto, on every relevant tool call) | Evy via `memory_search` / `memory_timeline` (explicit) | claude-mem's MCP corpus |
| 5 | `.subctl/docs/` | Per-team project artifacts (mandate, SPEC, PRD, ARCH, handoffs, decisions) | Evy via `team_doc_*` tools | Workers read directly; Evy reads via `team_doc_read` | Project filesystem: `<project>/.subctl/docs/` |

## Detailed tier reference

### Tier 1 — MEMORY.md

**Purpose.** The operator's profile and the small set of operator-asserted facts Evy needs at all times. Things like "Jason runs an MSP, partner is Richard, M3 Ultra is the primary host, prefers free/open-source where quality permits."

**Substrate.** Single markdown file at `~/.config/subctl/master/MEMORY.md`.

**Read pattern.** Always loaded into the system prompt via `composeSystemPrompt()`. Hot-swappable: writes take effect on the next turn.

**Write pattern.** Conservative. Evy uses `memory_remember` only for facts the operator has explicitly asserted as durable. She uses `memory_forget` only with explicit operator confirmation (enforced by tool schema in v2.7.12).

**Limits.** Char-budgeted. Evy refuses writes that would exceed the budget without first consolidating older entries via `memory_forget`.

**Operator-facing.** Dashboard Memory tab provides direct editing.

### Tier 2 — Obsidian vault

**Purpose.** Long-term curated notes the operator owns. Project context, meeting notes, design sketches, anything the operator wants to keep across systems (Obsidian is the operator's primary notes tool, not subctl's).

**Substrate.** Operator's Obsidian vault. Path configured in `~/.config/subctl/master/policy.json`.

**Read pattern.** Evy reads on demand when she has reason to consult the vault (operator references a past project, or the vault's structure tells her something is filed there). She does not pre-load the vault into context.

**Write pattern.** **Evy does not write to the vault without explicit operator instruction.** This is a hard rule. The vault is the operator's territory; Evy is a guest. When the operator says "save this to my vault under X," Evy writes. Otherwise, no.

This is the cleanest constraint in the architecture and the easiest to enforce. The persona prompt pins it; the `team_doc_write` tool doesn't have a vault-write code path at all.

**Permissions caveat.** macOS TCC blocks access to `~/Documents/` by default. The terminal process running Evy needs Full Disk Access for vault reads to work. If TCC blocks, Evy reports it cleanly and the operator decides whether to grant access.

### Tier 3 — Memori

**Purpose.** The conversational memory layer. Operator-Evy chat is auto-captured by Memori in the background; relevant past memory is auto-recalled at the start of each new turn. The mechanism that makes Evy *remember her conversations with the operator* across sessions without needing explicit search calls.

**Substrate.** Memori BYODB self-hosted, sqlite backing at `~/.local/state/subctl/memori.db`. No cloud egress.

**Memory model.** Structured types via Memori's Advanced Augmentation:

- **attributes** — properties of entities (e.g., "Jason prefers terse responses")
- **events** — things that happened (e.g., "deployed v2.7.8 with policy floor fix")
- **facts** — operator-asserted or extracted (e.g., "Richard is the business partner")
- **people** — entities involved (e.g., "Dustin works on HoLaCe billing")
- **preferences** — operator preferences (e.g., "no em dashes, no padding")
- **relationships** — between entities (e.g., "claude-jason account belongs to Jason")
- **rules** — operator-stated rules (e.g., "shut down idle workers")
- **skills** — capabilities or expertise (e.g., "Jason has 30+ years IT experience")

**Read pattern.** Automatic. Memori SDK wraps the OpenAI-compat client; relevant memory is recalled and prepended to context before each LLM call. Evy doesn't decide whether to look; she just sees the memory in her context.

**Write pattern.** Automatic. Every operator-Evy exchange is captured. Memori extracts structured types in the background. No tool calls required.

**Explicit access.** When Evy needs historical specifics outside the recall window, she calls Memori's explicit recall tools (provided by the SDK or exposed as Evy tools).

**Status.** Ships in v2.7.13.

### Tier 4 — claude-mem corpus

**Purpose.** Cross-session observation capture for debug, audit, pattern detection. Different job than Memori: claude-mem captures *observations from work* (tool calls, error patterns, decisions made), not conversational turns. Used to answer "what was I working on last Tuesday" and "did we already solve this kind of bug."

**Substrate.** claude-mem's MCP corpus, indexed semantically.

**Read pattern.** Explicit via `memory_search`, `memory_timeline`, `memory_observations`. Not auto-injected into the system prompt.

**Write pattern.** Hook-based, automatic. claude-mem's hooks capture tool calls and decisions from active Claude Code sessions across multiple `CLAUDE_CONFIG_DIR` roots.

**Why it stays after Memori lands.** Different job, different scope, different consumer. Memori is for "what did Evy and I talk about." claude-mem is for "what work happened across all my sessions, including ones Evy wasn't in." Not duplicates. See [ADR 0010](adr/0010-claude-mem-stays-parallel.md).

### Tier 5 — `.subctl/docs/`

**Purpose.** Per-team project-local artifacts. The mandate that started the team, the SPEC they're working from, handoff documents between agents, the decisions log. Workers can `cat` these directly; Evy can read and write them; everything is gitable and tracked.

**Substrate.** Filesystem under `<project_root>/.subctl/docs/`.

**Structure.**

```
<project>/.subctl/docs/
├── mandate.md                       # operator's first prompt + frontmatter
├── SPEC.md                          # the spec
├── PRD.md                           # product requirements
├── ARCH.md                          # architecture
├── decisions.jsonl                  # append-only decision log
└── handoffs/
    ├── 2026-05-12-baseline.md
    └── 2026-05-12-feature-slice.md
```

**Read pattern.** Workers read directly via `cat`. Evy reads via `team_doc_read`.

**Write pattern.** Evy uses `team_doc_write` and `team_decision_log`. Workers can also write via standard file tools (Edit/Write).

**Status.** Tools ship in v2.7.10. Spawn integration (auto-write `mandate.md` at spawn time, drop CLAUDE.md skeleton, install team skills) ships in a later v2.7.x.

## How a request flows through the tiers

When the operator sends Evy a message:

1. **Memori recall** runs automatically. Relevant past conversational context is prepended to the LLM call.
2. **Tier 1 MEMORY.md** is already in the system prompt (composed every turn).
3. **Tier 2 Obsidian** is NOT loaded by default. Evy reaches for it only when she has explicit reason.
4. **Tier 4 claude-mem** is NOT loaded by default. Evy calls `memory_search` when she needs historical specifics.
5. **Tier 5 `.subctl/docs/`** is read when Evy is operating on a specific team's project (via `team_doc_read`).

When Evy commits something to memory:

- Operator-asserted facts → tier 1 via `memory_remember`.
- Conversational content → tier 3 automatic capture (no tool call).
- Project artifacts → tier 5 via `team_doc_write`.
- Operator-curated notes → tier 2, but only via explicit operator instruction.
- Observations from work → tier 4 automatic capture by claude-mem hooks (no tool call).

## Why this shape

The five tiers don't compete. They have orthogonal jobs:

- Tier 1 is for facts the system needs to know at every turn.
- Tier 2 is for content the operator owns and curates.
- Tier 3 is for conversational continuity (Evy remembering her chats).
- Tier 4 is for cross-session work history (audit, debug, pattern).
- Tier 5 is for per-team project context.

Collapsing any two of these into one tier produces a worse system. Tier 1+3 collapsed would put conversational content in MEMORY.md and blow the char budget. Tier 2+5 collapsed would put project artifacts in the operator's personal vault and pollute it. Tier 3+4 collapsed (using one of memU or Memori for everything) would either lose the structured conversational types or fail to capture non-conversational observations.

## Filing convention

When Evy says she's filing something, she names the tier. "Filed under HoLaCe billing notes" is ambiguous across four of the five tiers. "Filed in claude-mem under HoLaCe billing notes" is not.

The retrieval phrase the operator gets in response to a filing message is the phrase that, passed to the right tier's search, will retrieve the content.

## Future considerations

- **VoxCPM voice layer.** When subctl gains a voice synthesis layer (likely via [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)), the spoken output is generated FROM Evy's text response; it does not change the memory model. The memory tiers store text, not audio. Audio is rendered at delivery time.
- **Cross-machine memory sync.** Currently each subctl host has its own tier 1 / tier 3 / tier 4 stores. A future ADR may consider whether tier 3 (Memori) should sync between operator's M5 and M3.
- **Memori → claude-mem migration.** Not planned currently. If Memori's structured types prove sufficient for the observation-capture job that claude-mem does, tier 4 could collapse into tier 3. This is a one-month decision after Memori ships in v2.7.13.
