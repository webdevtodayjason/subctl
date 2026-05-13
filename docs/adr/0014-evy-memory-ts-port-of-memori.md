# 0014: Evy Memory — TS port of Memori for Tier 3 conversational memory

- **Status:** Accepted (ships v2.7.23)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Supersedes:** [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md)
- **Implemented in:** v2.7.23

## Context

ADR 0006 selected Memori (memorilabs/memori, now MemoriLabs/Memori) as the Tier 3 substrate for conversational memory, in BYODB self-hosted mode, citing a documented TypeScript SDK on npm and a clean SDK-wraps-OpenAI-client integration shape. That ADR has been the reference for the v2.7.13 implementation slot.

When v2.7.23 came up for actual implementation, two facts surfaced:

1. **Memori is Python-only.** The repo is `MemoriLabs/Memori` (Python; uses `_rust_core.py` for the hot path). There is no first-class TypeScript SDK. The `@memorilabs/memori` npm package referenced in ADR 0006 doesn't exist as a maintained surface — that section of ADR 0006 was based on outdated/aspirational marketing.
2. **Memori's value-add is auto-injecting captured memory into LLM prompts via wrappers around LiteLLM/LangChain.** Subctl's LLM call path is `pi-ai → providers` — completely custom. We don't speak LiteLLM. Memori's framework-aware injection layer would be unused.

The actual primitive we need is **storage + retrieval**: append entries at turn boundaries, query them later, with text search. The structured-types layer (entities, facts, knowledge graph subject/predicate/object triples — confirmed by reading `memori/storage/migrations/_sqlite.py`) requires an LLM extraction pipeline running on every turn, which we don't want and which Python-only Memori couldn't run inside the Bun master process anyway.

Three integration options were considered:

- **A. Python sidecar service.** Stand up `memori` as a separate process, talk to it over HTTP/Unix socket. Full Memori capabilities for free, but adds a Python runtime + launchd plist + IPC + a new failure mode.
- **B. TS port using `bun:sqlite`.** Take the storage + retrieval shape as design inspiration, implement directly in TypeScript using Bun's native SQLite. No Python dependency, no IPC, runs in-process.
- **C. Memori as installed CLI, master shells out.** Subprocess per call. Brittle, slow, doesn't fit the daemon model.

## Decision

**Option B — TS port using `bun:sqlite`.** Implement Tier 3 as a native TypeScript module (`components/master/memory.ts`) backed by Bun's built-in SQLite with FTS5 full-text search. Expose `recordEntry` / `recallEntries` / `recentEntries` / `purgeBefore` / `deleteEntry` / `memoryStats` plus an egress redaction helper. Wrap as **Evy Memory** — subctl/Evy-aware integration layer, not vanilla Memori — so the module knows about subctl's roles (`user` / `assistant` / `tool` / `event`), subctl's team scoping (`team_id`), and subctl's egress surfaces (Telegram + dashboard, both with secret redaction).

This module ships v2.7.23 wired into:

- master's turn boundary (user + assistant + tool-call entries land automatically),
- the notifications subscriber (every emitted notification is also a memory entry),
- two Evy-callable tools (`evy_recall`, `evy_remember`),
- the dashboard Memory tab (Tier 3 panel next to the Tier 1 MEMORY.md cards),
- Telegram commands (`/memory <query>`, `/memory recent`, `/remember <text>`).

ADR 0006 is marked Superseded.

## Reasoning

**Memori's storage layer is its commodity layer.** Reading `memori/storage/migrations/_sqlite.py` confirmed Memori uses ~8 tables: `memori_entity`, `memori_process`, `memori_session`, `memori_conversation`, `memori_conversation_message`, `memori_entity_fact`, `memori_process_attribute`, plus subject/predicate/object triples for a knowledge graph (`memori_knowledge_graph`). The conversation_message table (id, uuid, conversation_id, role, type, content, dates) is the load-bearing primitive — everything else is on top, requires LLM extraction, and would be inert without Memori's Python agent pipeline. We picked up the shape (role + content + timestamps + scope) and dropped the extraction layer for v1. The schema we ship (`entries(id, ts, team_id, role, kind, content, metadata_json)` + `entries_fts` virtual table) is invented for subctl's actual surfaces, with Memori's conversation_message structure as design inspiration.

**Bun's sqlite supports FTS5.** Verified empirically on Bun 1.2.17 (the version this M3 is running) — `CREATE VIRTUAL TABLE … USING fts5(…)` works, `MATCH` queries return results. We ship FTS5 with a LIKE fallback in the retrieval path so a future Bun build without FTS5 degrades to substring search rather than crashing. The fallback path is unit-tested.

**Self-hosted constraint (ADR 0009) is preserved.** The DB file lives at `~/.local/state/subctl/memory/evy.db` with directory chmod 700 and file chmod 600. Nothing egresses without operator action. The redaction helper applied at Telegram + dashboard egress surfaces is defence-in-depth, not a relaxation of the privacy posture.

**Tier 4 boundary (ADR 0010) is preserved.** This module does not read or write claude-mem's storage. Confirmed by grep: zero references to claude-mem state paths in `components/master/memory.ts` or `components/master/tools/evy-memory.ts`. The existing `components/master/tools/memory.ts` continues to query the claude-mem worker at `localhost:37701` unchanged (`memory_search`, `memory_timeline`, etc.). Two tools for two tiers, named distinctly: `evy_recall` (Tier 3) vs `memory_search` (Tier 4).

**Why not Option A (Python sidecar):** the value we would have bought is Memori's framework-aware auto-injection, which we cannot use because our LLM call path is not LiteLLM. The IPC + Python runtime cost would have been pure overhead. The structured types (facts, KG triples) need LLM extraction, which we can add later as a v2 enhancement to this same module without changing the storage shape.

**Why not Option C (shell out per call):** every call would spawn a Python process — at master's tick cadence this would be wasteful; at the turn-boundary rate it would slow Evy's responses noticeably. Wrong shape for a daemon.

## Consequences

### Positive

- Single source for Tier 3 storage in subctl-native TypeScript. No Python dependency, no new launchd plist, no new failure mode.
- Bun's in-process SQLite + FTS5 is fast (sub-ms inserts on the M3) and atomic.
- Evy's persona doesn't need to change — the tool surface is additive (`evy_recall`, `evy_remember`); the existing `memory_search` (claude-mem) still works.
- The schema is small enough to evolve. Adding embedding columns or per-team databases later is a migration, not a rewrite.
- The redaction helper covers both Telegram and dashboard egress surfaces uniformly, so future surfaces inherit the same posture.

### Negative

- We're maintaining storage + retrieval logic ourselves. Memori upstream improvements (e.g., schema tweaks, FTS heuristics) won't flow in automatically.
- No structured-types extraction in v1 — Memori's "preferences/rules/facts/skills" categorization isn't there. v1 is unstructured-text + kind tags. Operator's "Evy remembers the conversation" baseline is met; richer typing is v2.
- No vector/semantic search in v1. FTS5 is keyword-only with prefix matching. For "I'm thinking of the conversation about deploying watchdogs" the operator needs to remember a recognizable token. Embedding-backed search is an open v2 question.
- Egress redaction is regex-based and conservative — false negatives are possible. The on-disk file is chmod 600, so the worst case is a leaked-into-chat secret, not a leaked-to-network one.

### Open questions

- **Embeddings for semantic search (v2).** Reasonable next step: add `content_embedding` BLOB column, generate vectors via a local embedding model, support cosine ranking alongside FTS5. Memori's `memori_entity_fact.content_embedding` is the analogous column.
- **Per-team databases (v2).** Currently one DB with a `team_id` column. If MSP client data isolation requires file-level separation ("export tenant alpha's memory, delete it cleanly"), this becomes a migration. Defer until an operator scenario forces it.
- **Migration story (v2).** Adding columns is straightforward with `ALTER TABLE`. The FTS5 table is rebuilt by drop-and-recreate (cheap at our volume). Document a `subctl memory migrate` command when the first migration ships.
- **Cross-host sync.** M5 and M3 each have their own evy.db. Not synced by design — same posture as claude-mem and MEMORY.md. Revisit if multi-host operator workflows surface a need.
- **Compaction interaction.** Master compacts the transcript at high water; we don't compact Evy Memory. The DB grows linearly with turns. At observed turn rate this is fine for years, but a TTL-based `purgeBefore` cron is worth wiring if memory growth becomes operator-visible.

## Alternatives considered

### Alternative A: Python sidecar running Memori

Stand up `memori` as a separate Python process under a launchd plist; master talks to it over Unix socket. Pros: full Memori semantics for free. Cons: Python runtime dep, IPC overhead, new failure mode, second supervisor target — and the killer one, Memori's value-add (LiteLLM auto-inject) is unused by our pi-ai-based call path, so we pay all the cost for none of the headline feature.

### Alternative C: Memori as CLI, master shells out

`pip install memorisdk` + `subprocess.run` per call. Pros: minimal code. Cons: per-call process spawn at turn cadence is unacceptable latency; brittle to environment drift; doesn't fit a long-running daemon.

### Alternative D: Defer Tier 3 entirely, lean on claude-mem (Tier 4) for v1

claude-mem captures every Claude Code session via observation hooks. We could let operator-Evy chat surface there indirectly.

Rejected because (a) master is NOT a Claude Code session — it's pi-agent-core — so claude-mem doesn't capture master's turns; (b) ADR 0010 already pinned claude-mem as a parallel Tier 4 corpus with a different access pattern (semantic search on demand vs. structured query). Conflating them would break both jobs.

## References

- [memori/storage/migrations/_sqlite.py](https://github.com/MemoriLabs/Memori/blob/main/memori/storage/migrations/_sqlite.py) — the Memori schema we read to confirm the framework's actual storage shape
- [components/master/memory.ts](../../components/master/memory.ts) — the ship vehicle
- [components/master/tools/evy-memory.ts](../../components/master/tools/evy-memory.ts) — Evy's recall + remember tools
- [components/master/__tests__/memory.test.ts](../../components/master/__tests__/memory.test.ts) — storage + retrieval + redaction tests
- [ADR 0005](0005-five-tier-memory-architecture.md) — the parent tier model
- [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) — the substrate decision this ADR supersedes
- [ADR 0009](0009-self-hosted-only-no-cloud-memory.md) — the privacy floor (preserved)
- [ADR 0010](0010-claude-mem-stays-parallel.md) — the Tier 4 boundary (preserved)
- Decision session: 2026-05-13 with operator (worker dispatched by team-lead)
