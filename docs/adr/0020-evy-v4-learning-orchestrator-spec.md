# 0020: Evy v4 — Rust rewrite as a learning orchestrator

- **Status:** Accepted (Phase 0 blueprint freeze)
- **Date:** 2026-05-25
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v4.0.0 (target — repo `webdevtodayjason/subctl-rust`, not yet scaffolded)
- **Supersedes:** none — orthogonal to the v3.3.x TypeScript daemon, which keeps shipping until cutover criteria below are met.

## Context

### What this ADR is

Evy v4 is a from-scratch Rust rewrite of the subctl daemon that today lives at
`components/evy/server.ts` (~20 kloc of TypeScript on Bun). This document is
the blueprint freeze for that rewrite: it locks in *what* Evy v4 is — the
eight primitives she's built out of, the learning loop she runs on, the
language and crate layout — before any Rust code is written.

It does not contain code. It does not contain commit-ready APIs. It does
contain the contract that Phase 1 workers will reference when porting the
load-bearing parts (policy gate, HMAC trust marker, spawn pipeline) and
when building the parts that don't exist today (scheduler, Discord
adapter, TUI, research module, thinking-partner surface, learning loop).

### Why now

Current Evy was built in roughly 22 calendar days, without a blueprint, in
an exploratory mode. The result is mature, working, and contains substantial
load-bearing infrastructure — the spawn pipeline, the policy gate, the HMAC
trust marker, the claude-mem integration shape, the Telegram bridge — that
has been hardened across the v3.3.x patch line.

It also contains substantial speculative infrastructure that was built
*before* the consumers existed: the fitness writer as currently shaped, the
engagement ledger, the pending-asks surface, the verifier-cluster ticker,
most of the v3.3.x dashboard panels. These are not broken — they're
monitoring surfaces for use cases that did not materialize at the level the
infrastructure was designed for. Honest reckoning: out of the ~20 kloc of
current Evy TS, somewhere between 3 and 4 kloc is actually load-bearing
against the daemon's current workload.

Three additional pressures converge on "rewrite now":

1. **Refactor confidence is eroding.** The master→evy rename has been
   leaking bugs across v3.3.2, v3.3.3, and v3.3.4. Each patch fixes a
   rename leftover that the previous release missed (log prefixes, route
   aliases, snapshot writers). The TypeScript surface is too easy to leave
   a half-renamed reference in; the only feedback signal is a runtime
   error a user hits later.
2. **Spawned-child lifetimes need rigorous management.** Evy spawns tmux
   children (`claude-teams`, `codex-teams`) that outlive any single
   request. Bun has good async ergonomics but no real story for
   structured concurrency around long-lived OS children. Rust's
   `tokio::process::Child` plus typed cancellation surfaces give us
   ownership semantics we can verify at compile time.
3. **Evy hasn't been used for a real development project yet.** This is
   the unlock. Every analogous rewrite that's failed (Discord's
   Erlang→Rust voice gateway, Slack's monolith decomposition, every CMS
   that's "redoing v2 in Go") failed because the rewrite raced a
   production deployment. Evy has none. We're iterating on the tool;
   we're not yet using the tool. Migration cost is therefore much lower
   than it looks from outside.

### Honest accounting of the Rust advantage

TypeScript daemons aren't broken. Discord, Slack, Cloudflare Workers all
run on Node/Bun daemons at scale. The Rust advantage on this specific
workload is real but bounded — call it 15–25% on the axes that matter:
resource use under long uptime, refactor safety at scale, latency tails
under load, crash safety around spawned children. Not 10×. Not a
correctness silver bullet. The reason to do it is that we get to *trade*
22 days of TypeScript-built infrastructure for ~3 weeks of Rust
infrastructure that's built against a real spec, with the speculative
parts removed, and which we expect to live considerably longer.

### Operator-stated job description

Evy is, in the operator's words paraphrased: *a dependable super-level
orchestrator. PM with dev skills. She communicates across whatever channel
(web dashboard, TUI, Discord, Telegram). She manages heterogeneous worker
teams autonomously — Claude Code, Codex, DeepSeek V4 Pro, any other
provider that shows up. She pushes them forward without the operator
present: nudges them, re-prompts them, re-routes when they're rate-limited,
escalates when stuck. She does her own online research for the
thinking-partner role. She does NOT code herself. She creates cron-shaped
jobs in the daemon for watchdogs, scheduled checks, periodic status pushes.
She is a thinking-partner for greenfield and brownfield work — drafts
plans, asks hard questions, surfaces unknowns.*

The persona is unchanged: librarian / conductor / master orchestrator
([ADR 0004](0004-evy-persona-librarian-framing.md)). The persona is who
she is; this ADR is what she's built out of.

## Decision

Rewrite Evy from scratch in Rust against a frozen blueprint. The blueprint
is eight primitives plus a seven-layer learning loop. Eight primitives are
the structural decomposition; the learning loop is one of those primitives
expanded because it's the hardest and the most likely to drift if not
nailed down here.

### The eight primitives

Each primitive is a crate-or-module boundary in the workspace. Each one is
provider-agnostic and channel-agnostic at its core, with adapters at the
edge.

#### 1. Project registry

The list of what's active right now: which projects Evy is managing, the
state of each one, who's assigned to it, what the next step is. Keyed by
project ID, persisted to SQLite, mutated by every other primitive that
needs to know "what is going on with project X."

Concrete shape: a project has a name, a working tree path, a current
phase (planning / dispatching / executing / verifying / blocked), a list
of currently-assigned worker handles, a "next step" string written by
the orchestrator, and a last-touched timestamp. The registry is the
single source of truth for "what's Evy doing." Dashboard reads from it.
The thinking-partner surface reads from it before suggesting actions.
The scheduler reads from it before deciding whether to fire a watchdog.

#### 2. Worker pool

Provider-agnostic spawn / supervise / kill. Today's Evy has hard-shaped
adapters for Claude Code and Codex; v4 introduces a real provider trait
that any future provider can implement. The trait surface is:

```
trait Provider {
    fn id(&self) -> ProviderId;
    fn dispatch(&self, mandate: Mandate) -> Result<WorkerHandle>;
    fn nudge(&self, handle: &WorkerHandle, body: &str) -> Result<()>;
    fn kill(&self, handle: WorkerHandle) -> Result<()>;
    fn health(&self, handle: &WorkerHandle) -> Result<WorkerHealth>;
}
```

`Mandate` is the provider-agnostic work order. `WorkerHandle` opaque-types
the provider-specific child reference (a tmux pane ID for Claude Code, a
process ID for Codex, a queue ID for DeepSeek). The pool owns all handles
in a `tokio::sync::RwLock`-protected registry and exposes "find by ID,"
"list all," "list by project," "list by provider."

Critically: providers do *not* share a common message envelope. Each one
gets the mandate translated into its own native envelope by the adapter.
This was an operator-confirmed design point — flattening the envelope to
one shape would force a least-common-denominator that none of the
providers actually want. The trait abstracts dispatch, not wire format.

Initial provider implementations:

- **Claude Code** — port of today's `providers/claude/` spawn pipeline.
  Mature. ~3 kloc of TS to translate.
- **Codex (OpenAI)** — port of today's `providers/openai-codex/`. Mature.
- **DeepSeek V4 Pro** — operator has confirmed this is *not* wired in
  current subctl. Phase 1 ships a stub trait impl that returns
  "unimplemented" plus a documented adapter spec; full implementation is
  Phase 2.

#### 3. Scheduler

Operator-defined cron-shaped jobs. Watchdogs, scheduled status pushes,
periodic checks. Persisted across daemon restart. The current Evy has
hard-coded watchdog tickers in `server.ts`; v4 makes this a first-class
primitive the operator can edit without recompiling.

Job shape:

```
struct Job {
    id: JobId,
    name: String,
    cron: CronExpr,        // standard 5-field cron or "@every 5m"
    handler: HandlerSpec,  // named action, see below
    enabled: bool,
    last_run: Option<Timestamp>,
    last_outcome: Option<Outcome>,
}
```

`HandlerSpec` is an enum over the actions a job can take: send a Telegram
message, post a dashboard notification, check worker health and nudge if
stale, run a research query and file the result, run a named playbook
from the learning-loop layer. The set is closed (no arbitrary code
execution from the scheduler), which is what makes operator-editable
configs safe.

The scheduler tick runs at 10s granularity, persisted state lives in the
shared SQLite. Survives restart; on boot, any job whose `cron` would
have fired during the downtime gets one catch-up invocation if the
downtime was under 5 minutes, otherwise is skipped with a logged note.

#### 4. Comms router

Multi-channel inbound and outbound. The router is channel-agnostic at
the core; adapters at the edge translate to and from each channel's
native shape.

Channels at v4 launch:

- **Web dashboard** — HTTP/SSE over axum. Operator console, live status,
  worker pane views, ask-the-operator surface.
- **TUI** — ratatui-based operator console running over an HTTP/WebSocket
  link to the daemon. Distinct from today's `deck` (which is a tmux
  session manager, not an Evy control surface).
- **Telegram** — port of today's bridge. Reference shape for the router
  contract.
- **Discord** — greenfield. Slash commands plus DM channel for
  ask-the-operator. No reference implementation in TS Evy.

Router contract:

```
enum InboundMessage {
    Operator { channel: ChannelId, body: String, ts: Timestamp },
    Worker { handle: WorkerHandle, kind: WorkerEvent, ts: Timestamp },
    System { kind: SystemEvent, ts: Timestamp },
}

enum OutboundMessage {
    ToOperator { channel: ChannelId, body: OutboundBody },
    ToWorker { handle: WorkerHandle, body: WorkerEnvelope },
}
```

Channel adapters consume `InboundMessage`s onto an internal mpsc channel
and translate `OutboundMessage`s back out. The core decides what to send;
the adapter knows how to send it.

The HMAC trust marker (see primitive 7 / [ADR 0011](0011-trust-marker-hmac-replacement.md))
applies to operator→worker traffic regardless of which inbound channel
the operator used. The router signs once at the boundary; adapters
preserve the signed envelope.

#### 5. Research module

Web fetch and web search, source-cited. Used by the thinking-partner
surface and by scheduled research jobs. Provider-agnostic at the
interface (a `Researcher` trait); initial implementation wraps TinyFish
(see [ADR 0013](0013-tinyfish-browser-api-integration.md)) for browser
automation and a search adapter for live search.

Output shape is always `(claim, source_url, retrieved_at)` tuples, not
free-text summaries. That constraint is on purpose: the thinking-partner
surface should never present a "fact" Evy can't point at a URL for. If
the operator wants a summary, they can ask for one over the structured
output.

The research module is read-only from the perspective of the rest of the
daemon. It does not mutate registry state or dispatch workers. The
thinking-partner surface decides what to do *with* research results;
research itself just retrieves and cites.

#### 6. Thinking-partner surface

Conversational mode for planning. Greenfield and brownfield.

This is the surface where Evy is *not* dispatching workers and *not*
producing operations — she's a thinking partner. Drafts plans. Asks hard
questions. Surfaces unknowns. Pulls research via primitive 5. Reads
project registry state via primitive 1 to ground the conversation.

The surface has its own LLM relationship distinct from worker LLMs. Why:
worker LLMs are dispatched per-task with task-scoped context. The
thinking-partner surface needs continuity across many turns of one
conversation, with cross-conversation memory injected from the learning
loop. The LLM choice here is independent of which providers the worker
pool can dispatch to.

Critical scope discipline: the thinking-partner surface does NOT spawn
workers *during* a conversation. It CAN dispatch workers as an *outcome*
of a conversation, with operator approval. The distinction matters
because the conversation needs to be safe to think out loud in — "what
if we did X" should not silently spawn an X.

UX shape is genuinely undecided as of this ADR (chat-like? structured
forms? proactive interrupts?). Flagged in residual risks. The
primitive-level commitment is: "there is a thinking-partner surface
distinct from the dispatch surface, with its own LLM context, with
research and memory access, and with explicit handoff to dispatch."

#### 7. Policy gate

Port from TS. Same semantics. Same Trusted/Gated/Sealed verdicts. Same
audit log writes. Same test vectors must pass. See
[ADR 0001](0001-bash-gate-policy-floor.md) for the policy floor.

The TS implementation at `components/evy/tools/policy/` is the canonical
spec. The Go binary that exists today is a hot-path port of the same
spec; v4's Rust `evy-policy` crate is the next port. All three must
agree on every test vector.

This is the most security-sensitive of the eight primitives. No new
semantics are introduced in v4 — that would be scope creep into a
finished design. The port is faithful; new semantics happen in their
own ADRs.

#### 8. Learning loop

The hardest primitive and the one most likely to drift. Expanded into
seven layers in the next section. The short version: Evy gets better
at her job over time by observing, remembering, scoring, distilling
playbooks, modeling operator preferences, retrieving priors at decision
time, and ingesting feedback. Without this primitive, she's an
orchestrator. With it, she's a *learning* orchestrator.

### The learning loop — seven layers

| Layer | Job |
|---|---|
| 1. Observation log | Append-only event-sourced record of every action and every outcome. Substrate everything else queries. |
| 2. Episodic memory | Consume `claude-mem` (already exists, 6000+ observations) for cross-session/cross-project recall. Don't reinvent. |
| 3. Worker-effectiveness scoring | Per-provider, per-task-class success/failure/latency stats. Updated continuously. Drives dispatch. |
| 4. Playbooks | Distilled, named procedures. Operator-editable in markdown/yaml. Version-controlled in the repo. |
| 5. Operator-preference model | Explicit and implicit. Evy-owned, self-updating from corrections. Distinct from operator auto-memory. |
| 6. Decision-time retrieval | Pull relevant priors before any dispatch/notification/plan. Sub-100ms, fail-open, cacheable. |
| 7. Feedback ingest | Operator corrections flow back into priors. Without this, she stops learning the moment she's deployed. |

#### Layer 1 — Observation log

Append-only SQLite table. Every dispatch, every worker outcome, every
operator interaction, every scheduler tick. The schema is intentionally
wide and weakly typed (kind, payload-JSON, timestamps, project-ID nullable,
worker-handle nullable, outcome-classification nullable). Strongly typed
querying happens above the log; the log itself is event-sourced substrate.

Retention: forever, modulo a future compaction ADR if size becomes a
concern. Estimated growth: ~10 events/dispatch × ~50 dispatches/day ≈ 500
events/day ≈ ~5MB/year of JSON. Not a problem.

#### Layer 2 — Episodic memory via claude-mem

Evy v4 *consumes* claude-mem; she does not re-implement it.
[ADR 0010](0010-claude-mem-stays-parallel.md) established claude-mem as a
parallel tier-4 corpus. v4 keeps that boundary. The consumer surface is a
thin Rust shim that runs `claude-mem search` / `claude-mem timeline`
subprocesses and parses the JSON output. If the binary isn't available,
the layer fails open (returns no priors) rather than crashing Evy.

This is the cheapest of the seven layers to build because the hard work
is already done in the claude-mem package.

#### Layer 3 — Worker-effectiveness scoring

For each (provider, task-class) pair, maintain rolling-window stats:
success rate, median latency, P95 latency, rate-limit hit frequency. The
dispatch path queries the scoring table before choosing a provider when
the operator-stated requirement allows a choice. ("If the operator said
'use Claude Code,' use Claude Code. If they said 'use whatever's best for
a TS refactor,' use the scoring table.")

Task classes are coarse at v4 launch: `code_change`, `code_review`,
`investigation`, `documentation`, `planning_assist`. Refining the
taxonomy is a future ADR; over-engineering it now would lock in shape
before we have data.

#### Layer 4 — Playbooks

Named procedures Evy can execute. "Cutover-friendly version bump."
"Drain rate-limited worker and re-route." "Investigate flaky test."
Each playbook is a markdown file in the repo (operator-editable,
version-controlled) with a YAML frontmatter declaring inputs, outputs,
and which scheduler / worker actions it can compose.

Playbooks are not magic: they're checklists Evy executes against. The
distillation question — "how do new playbooks get created?" — is
deliberately deferred. Initial playbooks are operator-authored; an
auto-distillation mechanism can be designed once we have enough
observation-log data to know what shape it should take.

#### Layer 5 — Operator-preference model

Distinct from the operator's auto-memory at
`/Users/sem/.claude/projects/-Users-sem-code-subctl/memory/`. That
memory is operator-curated and belongs to the operator. The
preference model lives in Evy's own state and represents Evy's *model
of* operator preferences as updated by corrections.

Concrete examples it would store: "operator prefers smaller, incremental
releases over batched ones" (already exists in operator auto-memory —
the preference model would *also* know this from observation, so it can
score a "shall we batch the next three features?" suggestion as
out-of-preference before asking). "Operator wants the 🚨🚨🚨 idle banner
loud." "Operator prefers Codex for Rust work and Claude Code for TS."

Bilateral maintenance: see [ADR 0018](0018-operator-preferences-bilateral-maintenance.md)
for the v3-era operator-preferences design. The v4 preference model is
the same idea ported into Rust with explicit + implicit signals.

#### Layer 6 — Decision-time retrieval

Before any dispatch, notification, or plan: pull the relevant priors and
*use them*. This is what turns the other six layers from a museum into a
working system.

Performance contract: sub-100ms hot path. Fail-open: if retrieval errors,
the decision proceeds without priors and the error is logged. Cacheable:
identical retrieval requests within 60s return cached results.

The retrieval API is one call:

```
fn retrieve_priors(context: DecisionContext) -> Priors;
```

`DecisionContext` carries enough metadata for the retriever to know what
to look for (project ID, action kind, target provider, etc.).
`Priors` is a struct of relevant playbooks, recent observations, scored
provider stats, and preference flags. The caller decides how much to
weight each one.

#### Layer 7 — Feedback ingest

Operator corrections flow back. Without this, Evy ships and immediately
stops learning. The ingest path is:

- Operator says "no, do it this way" → router classifies as a correction
  → ingest writes a correction event to the observation log → preference
  model updates → next retrieval surfaces the corrected behavior as a
  prior.

The hard part is *classification*. Not every operator message is a
correction; some are clarifications, some are new instructions, some are
status questions. Phase 2 work includes a correction classifier (small,
locally-runnable) that the router consults before triggering ingest.

### Language and runtime

Rust. Tokio as the async runtime. The rationale, in order of how much they
matter to *this* workload:

1. Spawned-child lifetimes. `tokio::process::Child` plus structured
   cancellation gives us OS-child ownership semantics that survive
   refactoring. The master→evy rename leaks are a TS-shape problem; in
   Rust the type system would have caught most of them before runtime.
2. Long-running resource use. The daemon is intended to run for weeks at
   a time. Rust's lack of a GC, predictable allocator behavior, and
   ability to fail loudly on unexpected resource patterns are bigger
   wins at "uptime measured in weeks" than they are at "uptime measured
   in hours."
3. Single-binary distribution. `cargo build --release` produces one
   file. No `bun install`, no Node, no runtime dependency. Install
   reduces to "copy the binary and the plist."
4. Compile-time schema safety at boundaries. `sqlx` with offline mode
   verifies SQL against the schema at build time. Serde validates JSON
   at the boundary. The router's enum-based message types make
   exhaustiveness checking the compiler's job, not the reviewer's.
5. Refactor confidence. The whole class of bugs the v3.3.x patches are
   chasing (a leftover reference to a renamed symbol surviving until a
   user hits it) doesn't compile in Rust.

What Rust does NOT give us on this workload: faster execution speed
that the operator would notice (the bottleneck is LLM-call latency, not
the orchestrator), or any improvement in the parts that talk to humans
(the LLM is still the LLM). We're buying refactor safety and
resource-discipline, not throughput.

### Repo and workspace layout

**Repo:** `webdevtodayjason/subctl-rust`. The `subctl/` GitHub org
referenced in subctl-proxy SPECs is not created and is a separate
decision deferred until needed. The current TS daemon stays in
`webdevtodayjason/subctl` until cutover.

**Workspace:** multi-crate Cargo workspace with seven crates plus the
binary:

```
subctl-rust/
├── Cargo.toml          # workspace manifest
├── crates/
│   ├── evy-core/       # types, traits (Provider, Mandate, Error)
│   ├── evy-policy/     # policy gate, port from TS
│   ├── evy-providers/  # Claude Code, Codex, DeepSeek stub
│   ├── evy-scheduler/  # cron-shaped job runner
│   ├── evy-comms/      # router + web/TUI/Discord/Telegram adapters
│   ├── evy-memory/     # observation log + retrieval + claude-mem consumer
│   └── evy/            # binary: wires everything, owns main()
├── docs/               # operator docs, ported from current subctl/docs/
└── playbooks/          # markdown playbooks (learning-loop layer 4)
```

The split is along primitive boundaries (close to one crate per
primitive, with the router and learning loop being the multi-module
crates). `evy-core` is the serial blocker for Phase 1: every other crate
depends on its trait surface. Once `evy-core` is published as a stable
shape, the rest can develop in parallel.

### Core dependency choices

- **HTTP server:** `axum` (consistent with subctl-proxy SPECs)
- **SQLite:** `sqlx` with offline mode (compile-time-checked SQL)
- **Async runtime:** `tokio`, full features
- **Errors:** `thiserror` in libraries, `anyhow` at the binary boundary
- **Logging:** `tracing` + `tracing-subscriber`, JSON output for ingestion
- **Config:** `figment` with TOML + env layering
- **CLI:** `clap` with derive macros
- **HMAC:** `hmac` + `sha2` for the trust-marker port
- **Cron parsing:** `cron` (the well-maintained one — pin in Cargo.toml)
- **TUI:** `ratatui` + `crossterm` for the operator console

These choices are deliberately mainstream. No experimental async runtime,
no esoteric ORM, no roll-your-own anything. The interesting work in this
rewrite is the architecture, not the dependency picks.

### CLI strategy

Option (c) from Phase 0 planning: **thin Rust `subctl` binary that
handles native subcommands talking to the daemon's HTTP API, and shells
out to the existing bash plumbing for legacy paths during transition.**

The current bash CLI (`bin/subctl`) is ~3000 lines of accumulated plumbing
across many subcommands. Porting it all up front would be a separate
project and would block the daemon work. Instead: subcommands port
incrementally as the underlying primitives stabilize in v4. Anything not
yet ported continues to shell out to the current bash implementation. The
operator sees one `subctl` binary; under the hood it's a hybrid until
cutover completes.

## Reasoning

### Why Rust over staying on TS

TypeScript's actual failure modes on this codebase are: (1) refactor
leftovers compiling cleanly and then leaking bugs at runtime — the v3.3.x
patch line is the evidence — and (2) opaque resource patterns under long
uptime (Bun is good, but not as good as Rust for what we need from
spawned-child lifetimes). Both are addressable in TS with sufficient
discipline. Both go away by construction in Rust.

The Rust win here is bounded and honest: refactor safety, resource
predictability, single-binary distribution. We are not claiming a 10×
improvement in correctness, throughput, or developer velocity. The
realistic gain is in the 15–25% range on the axes that matter, plus a
durable improvement in confidence that's worth paying real time for
exactly once.

### Why a full rewrite rather than incremental extraction

Three arguments for incremental:

- "Extract the policy gate to a Rust sidecar, leave the rest in TS."
- "Build the new primitives in Rust as separate processes, IPC them
  with current Evy."
- "Migrate file-by-file under a stable test suite."

Each is defensible on a *production* codebase. Each is the wrong choice
on this codebase, for the same reason: **Evy hasn't been used for any
real development project yet.** The migration cost that makes
incremental extraction valuable doesn't exist here. There's no user
base to break. There's no production traffic to disrupt. The 22 days
of TS Evy were *exploration time*, not production-hardening time. The
correct response to "we built a lot of speculative infrastructure" is
"we drop the speculative parts and build the real version against a
spec," not "we carefully refactor the speculative parts into a different
language."

There is also a hidden cost to incremental extraction that's
underappreciated: the team spends most of its time on the bridge layer
(IPC, type translation, deploy coordination) rather than on the
architecture. A full rewrite spends that time on the architecture. At
the operator's demonstrated tempo (~30 commits/day, ~10 kloc/day with
AI assistance), with a clean blueprint, three weeks of architecture-time
is much more valuable than three months of bridge-time.

### Why the eight primitives, not seven or nine

The operator-authored job description has five capabilities (communicate,
manage workers, push them forward, do research, plan with the user) and
three substrates (scheduler, policy, learning). Eight primitives is the
direct enumeration: one capability or substrate per primitive. The
learning loop's seven layers are a sub-decomposition of one primitive,
not separate primitives, because they share a single substrate (the
observation log) and a single retrieval point (decision-time retrieval).

Nine would imply splitting the learning loop into a separate "memory"
primitive and a "scoring/playbook" primitive. They share enough substrate
that splitting feels like file-shuffling, not real separation.

Seven would imply collapsing the thinking-partner surface into the comms
router. That would be wrong: the thinking-partner surface has its own
LLM relationship, its own scope-discipline rules, and its own retrieval
patterns. Those don't belong on the router.

### Why provider trait abstracts dispatch, not envelope

The operator was clear: each provider has its own envelope shape, and
they should stay that way. Flattening to a common envelope would force a
least-common-denominator that none of the providers actually want
natively. Claude Code wants pasted text-into-pane. Codex wants a request
to a long-running process. DeepSeek will want whatever DeepSeek wants.

Abstracting at the dispatch level — `dispatch(mandate: Mandate)` —
lets the adapter translate. The trait is honest about what's shared
(every provider can dispatch, supervise, kill, health-check) and
honest about what's not (every provider has its own native shape for
the actual message).

### Why the learning loop is in this ADR, not deferred

The other seven primitives are well-understood patterns. We could write
"scheduler" or "comms router" sections in an hour and not get it
meaningfully wrong. The learning loop is the part most likely to drift —
to be reduced from "the system that makes her better over time" to "a
log we never query." Putting all seven layers in the blueprint, with
explicit ownership for each one, is the cheapest insurance against that
drift.

The mechanism is intentionally not over-specified. Layer 3's scoring
algorithm, layer 4's distillation, layer 7's classifier are all design
work that happens during the build. The blueprint commits to *that they
exist and what their interface is*, not to their internals.

## Consequences

### Positive

- Spawned-child lifetimes become rigorous. The class of bug the master→evy
  rename has been leaking is gone by construction.
- Single-binary distribution. Install reduces to copying the binary and
  the launchd plist. No Bun runtime dependency.
- Compile-time schema safety at every boundary. `sqlx` verifies SQL
  against the schema; serde validates JSON; the router's enums make
  exhaustiveness the compiler's job.
- Refactor confidence at scale. The whole project gets easier to change.
- The speculative infrastructure (fitness writer as currently shaped,
  engagement ledger, pending-asks surface, verifier-cluster ticker, most
  v3.3.x dashboard panels) gets dropped rather than ported. We're not
  carrying the cost of the exploration forward.
- The provider trait gets done right. Adding DeepSeek V4 Pro becomes a
  one-crate change, not surgery across the daemon.
- The learning loop is *in the blueprint* rather than being aspirational
  text in the persona spec. The seven layers each have an owner.
- Cron-shaped jobs become operator-editable without recompilation.
  Today's hard-coded watchdog tickers become first-class scheduler entries.

### Negative

- We carry two daemons during cutover. v3.3.x TS Evy continues to ship
  patches until the cutover criteria are met; v4 Rust Evy is built
  alongside. Operator attention is split.
- Some load-bearing knowledge is currently in the TS code as
  "what-the-code-does" rather than "what-it-should-do." Porting requires
  reading the code carefully and writing the spec on the way. There is
  some risk of subtle behavior loss in the policy gate or HMAC; the
  mitigation is the test-vector contract (every TS policy-gate test
  vector must pass against `evy-policy`).
- Discord adapter is greenfield. No reference implementation. Discord
  gateway lifetime, rate limits, slash command UX — all new.
- The thinking-partner surface's UX shape is genuinely undecided. A
  blueprint that doesn't specify it leaves real design risk for Phase 2.
- The learning loop's mechanism design — distillation, scoring weights,
  correction classification — is research-y work. Plan on 2–3 days of
  iteration. The right initial bar is "she remembers across sessions and
  the operator can edit her playbooks," not "she rewrites her own
  decision policy."
- TypeScript daemons aren't broken. We are choosing to take 3 weeks of
  rewrite cost to buy something whose payoff is gradual rather than
  step-change. The operator should be honest with themselves that this
  is the trade. (See "Why now," above — the operator has been honest
  about this.)

### Open questions

(The `subctl/` GitHub org, DeepSeek wire format, and thinking-partner
LLM choice were previously listed here and have moved to Phase-deferred
items as decided-with-deferred-implementation.)

- Auto-distillation of playbooks (layer 4). Defer until the observation
  log has enough data to know what good distillation looks like.
- Correction classifier (layer 7). Phase 2 work, design open.
- Bash CLI long-term: keep or fully port. Phase 3+ decision.
- Thinking-partner surface UX: chat-only, structured, or hybrid (the
  shape question, distinct from the LLM-choice question that's now
  Phase-deferred). See Residual risks.

## Phase plan

### Phase 0 — Blueprint freeze (now, 1 day calendar)

- This ADR. Lock the blueprint.
- Scaffold `webdevtodayjason/subctl-rust` workspace with the seven crates
  and one binary. Empty crates with `Cargo.toml` and a `lib.rs` that
  exports a `placeholder()` fn. Compiles green; runs green; CI green.
- Bootstrap the Obsidian vault project entry for Evy v4 per the vault
  skill conventions.
- Operator reviewed and accepted the Decisions section below at Phase 0
  closure (2026-05-25). The blueprint is now frozen; subsequent
  revisions become superseding ADRs.

### Phase 1 — Foundation (3–4 days calendar)

- `evy-core` first. Types, traits, error type. Serial blocker. Once
  this is published as v0.1.0 of the workspace crates, Phase 1 fans out.
- In parallel (three worker streams):
  - `evy-policy` — port the policy gate. Test vectors are the contract.
  - `evy-scheduler` — cron job runner with persistence.
  - `evy-providers` — Claude Code and Codex adapters; DeepSeek stub.
- Daemon binary scaffolded with placeholder `main()` that boots the
  scheduler against a stub mandate. Verifiable end-to-end without yet
  doing anything real.
- Phase 1 deliverable: `cargo run --bin evy` boots, exposes a health
  endpoint, runs a no-op scheduled job, can spawn a Claude Code worker
  against a dev mandate and kill it cleanly.

### Phase 2 — Integration (7–14 days calendar)

- `evy-memory`: observation log, retrieval, claude-mem consumer.
- `evy-comms`: full multi-channel router. Web (axum) and Telegram first
  (Telegram has a reference shape); TUI second; Discord third.
- Learning loop layers 1–6 wired up. Layer 7 (feedback ingest) gets the
  correction classifier as a Phase 2.5 line item.
- Research module (TinyFish adapter + search adapter).
- Thinking-partner surface MVP. UX shape decided early in Phase 2 with
  a focused design pass.
- Cutover testing: every item in the cutover criteria (below) must pass
  before v3.3.x can be retired.

### Phase 3+ — Bash CLI porting, dashboard parity, deferred providers

Out of scope for v4.0.0 ship. Scheduled as the daemon stabilizes.

## Decisions (confirmed at Phase 0 closure 2026-05-25)

Operator accepted ADR 0020 at Phase 0 closure on 2026-05-25; the
override window closed at that point. Changes from here require a
superseding ADR.

### Cutover criteria (7 items) — Confirmed 2026-05-25

What v4 must do before v3 retires:

1. `claude-teams` and `codex-teams` spawn works against v4 (functional
   parity with v3).
2. Policy gate behaves identically (all TS Evy test vectors pass against
   `evy-policy`).
3. HMAC trust marker pasting works end-to-end against a v4-spawned
   worker.
4. Dashboard skeleton serves the operator console (read-only project
   registry view at minimum).
5. Scheduler runs at least one real operator-defined cron job, surviving
   one daemon restart.
6. Telegram bridge works for at least the "ask the operator" path
   round-trip.
7. One real workflow has run end-to-end on v4 without falling back to
   v3.

### Repo — Confirmed 2026-05-25

`webdevtodayjason/subctl-rust` (created by operator 2026-05-25). The
`subctl/` GitHub org is a separate, deferred decision.

### Workspace layout — Confirmed 2026-05-25

Multi-crate Cargo workspace, seven crates plus the binary, split along
primitive boundaries: `evy-core`, `evy-policy`, `evy-providers`,
`evy-scheduler`, `evy-comms`, `evy-memory`, and the `evy` binary.

### Core dependency picks — Confirmed 2026-05-25

`axum`, `sqlx` (offline mode), `tokio`, `thiserror`/`anyhow`, `tracing`,
`figment`, `clap` (derive). HMAC via `hmac` + `sha2`. Cron via `cron`.
TUI via `ratatui` + `crossterm`. Provider SDKs are native — no pi-ai
dependency (see References / Hermes): `anthropic-sdk-rust` or
hand-rolled HTTP for Claude, `async-openai` for OpenAI-shape APIs.
No experimental dependencies.

### CLI strategy — Confirmed 2026-05-25

Option (c): thin Rust `subctl` binary handles native subcommands
against the daemon's HTTP API and shells out to existing bash plumbing
for unported legacy paths. Bash CLI ports incrementally.

### Versioning during cutover — Confirmed 2026-05-25

v3.3.x TS Evy continues its existing patch line. v4 starts at v4.0.0
in the new repo. No v3.4.x — per the operator's "version cap on v3.3.x"
preference, v3 stays on v3.3.x until v4 ships.

## Phase-deferred items

Decided to be decided later — concrete deferrals with rationale, not
open questions. Each one has a Phase-2 trigger condition.

### DeepSeek V4 Pro provider wire format — Deferred to Phase 2

**Decision:** Phase 1 ships Claude Code and Codex adapters only. The
DeepSeek stub stays empty in `crates/evy-providers/` at Phase 1 ship;
implementation is a Phase 2 task with its own sibling ADR once the
operator has hands-on wire-format details (envelope, auth, rate-limit).

**Rationale:** Operator confirmed at Phase 0 closure that DeepSeek is
not wired in current subctl and they do not yet have envelope-shape
details. Designing the provider trait against guessed wire format is
worse than against what we know (Claude's pasted-text-into-pane +
Codex's long-running-process shapes). The stub is exercised by the
trait surface from Phase 1 onward, so trait-correctness is tested
cheaply before implementation begins — successfully adding DeepSeek
later is the abstraction's correctness test.

### Thinking-partner LLM choice (local vs cloud) — Deferred to Phase 2

**Decision:** Defer to a Phase 2 sibling ADR. The thinking-partner
surface itself does not ship until Phase 2, so the LLM choice is
in-scope for that phase.

**Rationale:** Making the choice now means choosing without the
design pressure of the surface itself. Local (LM Studio on M3 / DGX
Spark) honors the self-hosted floor from [ADR 0009](0009-self-hosted-only-no-cloud-memory.md),
capacity-bounded by local hardware; cloud (Claude API, OpenAI) trades
quality for the kind of opt-in friction [ADR 0019](0019-no-anthropic-provider-in-master.md)
established, plus a billing-visibility plan. Operator owns the Phase
2 decision; orchestrator drafts the sibling ADR once Phase 2 begins.

## Residual risks

These risks are not eliminated by the blueprint. They are *named* by
the blueprint so they have explicit owners during Phase 1 and Phase 2.

1. **Learning loop is research-y.** The mechanism — how playbooks
   distill, when worker-effectiveness scores are trusted, what counts
   as feedback signal — is design work that happens during the build.
   Plan on 2–3 days of iteration inside Phase 2. The right initial bar:
   "she remembers across sessions and the operator can edit her
   playbooks," not "she rewrites her own decision policy."

2. **Thinking-partner surface UX is undecided.** Spec is clean; UX is
   fuzzy. Chat-like? Structured forms? Proactive interrupts? This
   determines whether Evy needs her own LLM context model (likely yes).
   1–2 days of design risk early in Phase 2.

3. **Discord integration is greenfield.** No TS reference. Discord
   gateway lifecycle, rate limits, slash commands — all new. Phase 2
   work; could slip into Phase 3 without blocking cutover (Telegram is
   the cutover-blocking channel).

4. **Provider trait correctness.** Get the abstraction wrong and adding
   DeepSeek + future providers is surgery. Worth one extra design day
   in Phase 1 to get right. Mitigation: write the DeepSeek stub adapter
   in Phase 1 even though the implementation is Phase 2, so the trait
   gets exercised against three providers (Claude, Codex, DeepSeek-stub)
   from day one.

5. **Cutover risk.** Two production-real things — `claude-teams` spawn
   and the policy gate — must work the day v4 ships. Integration suite
   is planned, not improvised. Test vectors for the policy gate are
   already in the TS codebase and become the v4 contract.

6. **Operator attention is split during cutover.** v3.3.x patches still
   ship while v4 is being built. Mitigation: v3.3.x patches are bounded
   to fixes the operator personally encounters; no v3 features.

7. **Speculative-infrastructure-is-actually-used surprise.** We have
   classified the fitness writer / engagement ledger / pending-asks as
   speculative. If during Phase 1 a load-bearing dependency on one of
   these turns up that the inventory missed, we revisit before
   classification becomes "dropped." Phase 1 worker assigned to spawn
   pipeline owns this check.

## Alternatives considered

### Alternative A — Stay on TypeScript

Keep iterating Evy on Bun. Address the refactor-leak pattern with
stronger TS conventions (branded types for every renamed symbol,
exhaustive switch checking, `noUncheckedIndexedAccess`, etc.). Address
the resource-discipline question with better instrumentation.

Rejected because: the operator has identified this as a strategic
decision, not a tactical one. The Rust advantage is bounded but real,
and the *opportunity cost* of doing this rewrite is unusually low right
now (no production users, no migration cost). The same rewrite in 12
months — when Evy has accumulated real usage — would be substantially
more expensive. The window is open today; we don't expect it to stay
open.

### Alternative B — Incremental extraction (Rust sidecars + TS core)

Extract individual primitives to Rust as separate processes; keep the
core TS daemon; IPC between them. Policy gate becomes a Rust sidecar
first (it already is, as a Go binary). Scheduler becomes a Rust sidecar
second. So on.

Rejected because: the team spends most of its time on the bridge layer
(IPC, type translation, deploy coordination) rather than on the
architecture. The expected payoff of going-to-Rust isn't in any single
primitive; it's in the *whole-system* properties (single binary,
compile-time safety at boundaries, refactor confidence). Sidecars don't
deliver those. And the operator's lack-of-production-users window
removes the usual reason to prefer incremental.

### Alternative C — Different language (Go)

Go was considered. The policy gate's hot path is already a Go binary, so
there's existing Go familiarity. Single binary, fast startup, good
async/IO story, mainstream.

Rejected because: Rust's compile-time guarantees around lifetimes and
exhaustiveness are the specific properties we're buying. Go's type
system is permissive in ways that would let exactly the same class of
refactor leaks recur. The operator-stated priority of "rigorous lifetime
management for spawned tmux children" lands harder in Rust than in Go.
The Go policy gate stays as it is — that's a different scope.

### Alternative D — Full rewrite in Rust (chosen)

What's actually being done. Wins for the reasons outlined under
"Reasoning" above: the architectural gains are whole-system, not
per-primitive; the migration cost is unusually low right now because
Evy has no production users; and the operator's tempo with AI
assistance makes the 3-week realistic estimate achievable.

The honesty floor: this is a 15–25% improvement on axes that matter,
not a 10×. We're choosing to take the cost because the window is open
and the gains are durable, not because the current TS daemon is broken.

## References

### Prior ADRs this one builds on

- [ADR 0001](0001-bash-gate-policy-floor.md) — policy gate floor; v4's
  `evy-policy` crate is a faithful port of the same semantics.
- [ADR 0002](0002-trust-channel-directive-wrapper.md) — superseded
  trust-channel marker; context for ADR 0011.
- [ADR 0004](0004-evy-persona-librarian-framing.md) — Evy persona
  unchanged in v4. The persona is who she is; this ADR is what she's
  built out of.
- [ADR 0005](0005-five-tier-memory-architecture.md) — five-tier memory
  model; v4's `evy-memory` crate inherits this model and ports the
  Tier 3 substrate from TS to Rust.
- [ADR 0006](0006-memori-byodb-sqlite-for-tier-3.md) — superseded
  Memori-SDK decision; context for Tier 3 substrate evolution.
- [ADR 0010](0010-claude-mem-stays-parallel.md) — claude-mem as parallel
  Tier 4 corpus; v4 *consumes* claude-mem, does not reinvent it.
- [ADR 0011](0011-trust-marker-hmac-replacement.md) — HMAC trust marker
  protocol. v4's comms router preserves this contract end-to-end.
- [ADR 0013](0013-tinyfish-browser-api-integration.md) — TinyFish
  integration; basis for the v4 research module's browser adapter.
- [ADR 0014](0014-evy-memory-ts-port-of-memori.md) — Evy Memory TS
  implementation; the spec from which the Rust port draws.
- [ADR 0015](0015-pi-ai-and-pi-agent-as-first-class-upstreams.md) —
  pi-ai upstream commitment. **Scope: v3 only.** v4 does not depend on
  pi-ai; provider integrations are native (`anthropic-sdk-rust` or
  hand-rolled HTTP for Claude, `async-openai` for OpenAI-shape APIs,
  native Rust OAuth modeled after Hermes — see entry below). v4 is an
  orchestrator with one LLM relationship of its own, not a router
  across 20+ providers; pi-ai's abstraction is overhead at this shape,
  and consuming it from Rust would require a TS sidecar or a port.
- **Hermes** (`hermes-agent`, internal repo) — provider integration
  shape v4 follows: native SDKs, exact-pinned deps, provider-extras
  for lazy install. References: `pyproject.toml`, `hermes_cli/auth.py`.
  Hermes runs the same shape of work (multi-provider, OAuth
  subscriptions, ACP-adapter for spawn) with zero pi-ai dependency,
  proving the abstraction is not structurally required.
- [ADR 0018](0018-operator-preferences-bilateral-maintenance.md) —
  operator-preferences design; v4's learning-loop Layer 5 is the Rust
  port of this concept.
- [ADR 0019](0019-no-anthropic-provider-in-master.md) — no-Anthropic-
  provider guard. v4's provider pool inherits this constraint at the
  trait level: the `anthropic` provider is not in the default registry,
  and adding it requires the same explicit OS-level opt-in.

### Documents this ADR commits us to creating

- `subctl-rust/README.md` — repo readme for the new workspace.
- `subctl-rust/docs/architecture.md` — operator-facing architecture
  doc, derived from this ADR's eight-primitives section.
- `subctl-rust/playbooks/*.md` — initial playbooks (learning loop
  Layer 4). Operator-authored, Phase 2.
- `subctl-rust/docs/policy-gate-spec.md` — extracted spec for the
  policy gate port, drawn from current TS implementation. Phase 1
  prerequisite for the `evy-policy` worker.
- `subctl-rust/docs/test-vectors/` — policy-gate test vectors copied
  from current subctl repo; the cutover-criteria contract.

### Implementation hand-off

The implementation hand-off pointer is the new repo:

- **Repo:** `webdevtodayjason/subctl-rust` (not yet created — Phase 0
  scaffolding task)
- **First issue / first PR:** scaffold the workspace with the seven
  crates and one binary. Empty crates that compile and pass `cargo
  test`. CI green. This is the gate for Phase 1 dispatch.
- **Phase 1 worker dispatch:** drawn from this ADR's Phase plan
  section. `evy-core` is the serial blocker; the other three Phase 1
  streams parallelize once it lands.

### Decision context

- Phase 0 Orchestration session, 2026-05-25 (this ADR's authoring
  session, run by the `evy-v4-bootstrap` team).
- Operator job description, transcribed in the Context section, drawn
  from the same session.
- Current Evy honest inventory (load-bearing vs. speculative
  classification) drawn from the same session and recorded in this
  ADR's Context section rather than in a separate inventory doc.
