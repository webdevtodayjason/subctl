# 0006: Memori (BYODB sqlite) for Tier 3 conversational memory

- **Status:** Accepted (ships v2.7.13)
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.13 (queued)

## Context

Tier 3 of the [five-tier memory model](0005-five-tier-memory-architecture.md) is conversational memory: operator-Evy chat content, captured automatically and recalled automatically at the start of each new turn. The point is to make Evy actually remember her conversations across sessions, without requiring her to "decide to look at memory" on every turn.

Pre-decision, subctl had no tier 3 substrate. Operator-Evy chat persisted only in the master's agent-state.json (the raw transcript) and was lost on compaction or session boundary. claude-mem (tier 4) captured observations but not conversational content with structured types.

Two open-source frameworks were evaluated as candidates:

- **memU** (NevaMind-AI/memU): two-agent pattern, "memory as filesystem" hierarchy, Python 3.13+, Postgres+pgvector required, separate proactive subprocess.
- **Memori** (memorilabs/memori): SDK-wraps-OpenAI-client pattern, BYODB option, TypeScript SDK ships natively (`@memorilabs/memori` on npm), structured types (preferences, rules, skills, etc.), MCP server option.

Operator constraint: **self-hosting only**. No cloud egress. See [ADR 0009](0009-self-hosted-only-no-cloud-memory.md).

## Decision

Use Memori as the Tier 3 substrate, in BYODB self-hosted mode, backed by sqlite at `~/.local/state/subctl/memori.db`.

Implementation shape:

- `npm install @memorilabs/memori` adds the TypeScript SDK to `components/master/package.json`.
- Master's boot path constructs Memori before the pi-agent Agent constructor and registers it against the OpenAI-compat client:
  ```ts
  const mem = new Memori({ db: { path: "~/.local/state/subctl/memori.db" } });
  mem.llm.register(openAiClient);
  mem.attribution("jason", "evy");
  ```
- Configuration lives in `~/.config/subctl/master/memori.json` (mode = byodb, db path, attribution defaults, scope rules).
- No cloud API key required. If the operator chooses to enable cloud mode in the future, that becomes its own ADR.

## Reasoning

Self-hosting eliminates cloud from both candidates. The comparison becomes:

| Concern | memU self-hosted | Memori BYODB |
|---|---|---|
| Stack | Python 3.13 venv + Postgres + pgvector container | npm install + sqlite file |
| Process model | Second subprocess (memU Bot) under launchd | Embedded in master's Bun runtime |
| New launchd plist | Yes | No |
| Python ⇄ Bun bridge | HTTP IPC required | None (TS-native) |
| Capture/recall hook | Manual `composeSystemPrompt` rewrite | SDK wraps the OpenAI client, automatic |
| M3 operational surface added | Python runtime + pg container + IPC + plist + monitoring | sqlite file |
| Memory model | Filesystem metaphor (Resource → Item → Category) | Structured types (attributes, events, facts, people, preferences, relationships, rules, skills) |
| Benchmark | Not cited in README | LoCoMo 81.95% accuracy at 1,294 tokens/query |
| License | Apache 2.0 | Apache 2.0 |

Memori wins on:

- **Integration cost.** Subctl is pure Bun/TS. TypeScript SDK collapses the dependency to `npm install`. memU's Python + Postgres + IPC bridge is roughly a week of glue work plus permanent ops overhead.
- **No new subprocess.** memU's proactive-agent pattern requires a second launchd plist on M3. Given M3 has already given us PATH, launchd, and supervisor config issues this week, adding less operational surface is meaningfully better.
- **SDK-wraps-client pattern fits pi-agent-core architecture.** pi-agent-core speaks OpenAI Chat Completions to LM Studio. Memori's SDK registers against that client and intercepts every call. No `composeSystemPrompt` rewrite, no manual top-K injection logic, no TS bridge to a Python service.
- **Structured types align with Evy's spec.** Memori extracts preferences, rules, relationships, skills as first-class types in the background. Evy's persona spec talks about filing with provenance and remembering specialist reliability — Memori's types map directly. claude-mem captures raw observations; Memori captures structured memory.
- **MCP escape hatch.** If full SDK integration ever feels too coupled, Memori runs as an MCP server. Master dispatches recall via tool calls instead of SDK interception. Same data, lower coupling. Means we can A/B without committing.
- **Benchmark.** LoCoMo at 81.95% with 1,294 tokens/query (4.97% of full-context) matches the operator's "cuts long-running token costs" requirement. memU doesn't cite a comparable benchmark in its README.

## Consequences

### Positive

- Evy remembers operator-Evy chat automatically across sessions, with no explicit search call required.
- Structured types (preferences, rules) match what Evy needs to track about the operator and the work.
- No new subprocess; no Python runtime; no Postgres container.
- sqlite backing means the entire conversational memory is one file the operator can back up, inspect, or move.
- The integration can be tested incrementally: ship the SDK wiring, observe captures, then enable recall.

### Negative

- Vendor schema lock-in. Memori's structured types are its own format. Migrating off later would require reformatting.
- BYODB maturity is less documented than cloud. The cloud is Memori's headline; BYODB is the secondary path. Worth confirming the BYODB feature set covers what we need before shipping.
- TypeScript SDK is on npm but the project itself is younger than memU. Maintenance trajectory unclear.
- claude-mem stays parallel for now (see [ADR 0010](0010-claude-mem-stays-parallel.md)). Running two memory systems means two backup/restore stories.

### Open questions

- Should the Memori BYODB sqlite file be backed up automatically as part of `subctl backup` (if/when that exists)?
- Cross-host sync. M5 and M3 each get their own Memori instance. Should they sync? Currently no.
- Migration path if we ever switch substrates. Operator's preference is to track this if it becomes likely; for now, vendor lock-in is accepted cost.

## Alternatives considered

### Alternative A: memU self-hosted

Best-in-class proactive-agent pattern, knowledge-graph-adjacent. Rejected because the operational cost (Python runtime + Postgres container + second subprocess + IPC bridge) exceeds the benefit of the proactive-agent subprocess pattern. We have enough operational surface on M3 already.

### Alternative B: Memori cloud

Faster to evaluate (zero ops). Rejected because of the cloud privacy floor: MSP client data, operator-Evy chat, business strategy all egress to api.memorilabs.ai. Non-starter. See [ADR 0009](0009-self-hosted-only-no-cloud-memory.md).

### Alternative C: Build subctl-native injection using claude-mem

Modify `composeSystemPrompt()` to query claude-mem for relevant context per turn, prepend top-K results. No new dependency.

Considered seriously and was the original v2.7.13 plan before Memori was evaluated. Rejected because:
- claude-mem captures raw observations, not structured types. Evy's persona uses structured types throughout.
- The injection logic would be entirely homegrown; Memori has benchmarked retrieval quality.
- claude-mem isn't designed for conversational continuity (it's designed for cross-session observation capture).
- The work to build a proper injection layer would be comparable to integrating Memori, with worse results.

### Alternative D: Mem0 / Zep / LangMem

Other memory frameworks. Not seriously evaluated; Memori's LoCoMo benchmark explicitly outperformed Zep, LangMem, and Mem0 (per Memori README), and the integration shape was the deciding factor over benchmark differences.

## References

- [memorilabs/memori](https://github.com/memorilabs/memori) — the SDK
- [Memori BYODB docs](https://memorilabs.ai/docs/memori-byodb/) — self-hosting guide
- [memory-architecture.md](../memory-architecture.md) — tier model
- [ADR 0005](0005-five-tier-memory-architecture.md) — the tier model decision
- [ADR 0009](0009-self-hosted-only-no-cloud-memory.md) — privacy floor
- [ADR 0010](0010-claude-mem-stays-parallel.md) — claude-mem role split
- Decision session: 2026-05-12 with operator
