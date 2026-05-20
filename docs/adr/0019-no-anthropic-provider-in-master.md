# 0019: No Anthropic provider in the master daemon

- **Status:** Accepted
- **Date:** 2026-05-14
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.x (unreleased — branch `claude/keen-merkle-46515a`)

## Context

### What we found

A claude-invocation audit of this repo (see `CLAUDE_INVOCATION_AUDIT.md`,
landed on this same branch) catalogued every site where subctl talks to
Claude. The audit was triggered by Anthropic's 2026-05-13 email
announcing that starting 2026-06-15:

> Agent SDK and other programmatic usage will run on this credit, and
> will not impact your subscription limits. This includes third-party
> applications built on the Agent SDK. […] Your subscription usage
> limits don't change. They stay reserved for interactive usage of
> Claude Code, Claude Cowork, and chat.

Every operator with a Max 20× plan gets $200/mo of Agent SDK credit
that does NOT roll over.

The audit's surprise finding was the **`fallback` block in
`components/master/providers.json.example`**:

```json
"fallback": {
  "_comment": "Last-resort if local stack is offline AND escalate provider is unreachable. Uses your Anthropic Max subscription via subctl's account routing.",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "auth": "max-subscription"
}
```

This block was:

1. **Live in the template** — `ensureConfigFiles()` in `server.ts:222-233`
   copies `providers.json.example` to `~/.config/subctl/master/providers.json`
   verbatim on first daemon boot. Any operator copy-pasting "just to keep
   working" during an LM Studio crash spiral would arm this path.
2. **Not currently wired** — `providers.fallback` is declared in the
   `Providers` interface (`server.ts:287`) but is **never read** by any
   call site in the daemon, the dashboard, or any tool. It was a dead
   slot waiting to be wired up.
3. **Misleading about billing**. The `auth: "max-subscription"` field
   suggested the Anthropic calls would come out of the operator's Max
   plan. After 2026-06-15 that's not how Anthropic will classify it:
   pi-agent-core (the master's agent runtime,
   `@earendil-works/pi-agent-core`) is an Agent-SDK-shaped harness — an
   agent loop that POSTs structured messages with tool definitions to a
   chat completions endpoint. By traffic shape alone, Anthropic will
   route this to the $200 Agent SDK credit regardless of any auth hint.

### Why this matters at master's tick cadence

The master daemon runs on `setInterval` loops with several callers of
`agent.prompt()`:

- watchdog ticker every ~60s (`server.ts:3308`)
- scheduled-followup ticker every 60s (`server.ts:3348`)
- auto-compact ticker (`server.ts:3444`)
- inbox poll (`server.ts:1283`)
- inbound Telegram / chat prompts (event-driven)
- worker `team-report` synthesis (`server.ts:1255`)

Each prompt can fan out into several model turns (the agent loop calls
tools, gets results, calls more tools). At a conservative 5-10
agent.prompt() calls/hour averaging 2-4 turns each, with Sonnet 4.6 input
$3 / output $15 per MTok, a single day under load could plausibly burn
the entire monthly $200 credit; subsequent calls then draw from
"extra usage" — billed against the operator's payment method without
any further opt-in.

The risk window was: any future fix that wired `providers.fallback` up
("the daemon should fall back when LM Studio is down"), plus any sleepy
2am operator who copy-pasted the example to keep work moving. Either
flips a switch with no safety net.

### What the audit also surfaced (related but out of scope here)

- The only existing direct Anthropic API call in the repo is the
  evy-eval LLM judge at
  `components/master/__tests__/evy-eval/judge.ts`. One-shot dev tool,
  dual-mode, not on CI. Out of scope for this ADR.
- Automated drivers of interactive Claude sessions (`auto-nudge`,
  `verifier-cluster`, `/api/orchestration/:name/msg`) push HMAC-marked
  text into running `claude` tmux panes. Those count against the
  subscription bucket today, but the traffic shape is the same kind of
  thing Anthropic might reclassify later. Tracked separately.

## Decision

**The master daemon will not initialize an Anthropic-provider Model
under any circumstances unless the operator has explicitly set
`SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1` in the launchd plist.**

Concretely, four changes land together:

1. **`components/master/providers.json.example`** — strip the
   `fallback: { provider: "anthropic", ... }` block entirely. Replace
   with a `_fallback_removed_2026_05_14` comment that documents *why*
   it's gone and points at this ADR.
2. **`components/master/server.ts:buildModel()`** — hard guard at model
   construction. If `cfg.provider === "anthropic"` and
   `process.env.SUBCTL_ALLOW_ANTHROPIC_PROVIDER !== "1"`, throw a
   loud error before pi-ai ever issues a request. The throw kills the
   daemon's boot (or the profile-swap path, whichever was constructing
   the Model) with a message that names this ADR.
3. **Defense-in-depth telemetry** on every guard trip:
   - `console.error` line with the distinctive `[ANTHROPIC-API-GUARD]`
     prefix so grep over `~/Library/Logs/subctl/master.log` finds it
     instantly.
   - `emitNotification({ severity: "alert", kind:
     "anthropic-provider-blocked" | "anthropic-provider-armed" })` so
     the dashboard tray shows the alert.
   - `sendTelegramOutbound()` fire-and-forget Telegram push to the
     operator (uses the existing master-notify bot).
   - `logDecision()` JSONL entry so the audit trail at
     `~/.config/subctl/master/decisions.jsonl` shows when the guard
     fired and which provider+model triggered it.
   - Dedup is per `provider:model:verdict` per boot via a module-level
     Set, so the operator gets one Telegram per first trip, not a flood.
4. **`Providers` interface in `server.ts`** — mark `escalate` and
   `fallback` optional. They were declared required but never read;
   marking them optional preserves backward compatibility for any
   already-deployed `providers.json` that still has those blocks while
   the guard handles the dangerous variant.

The "loud alert even when allowed" rule is deliberate. If a future
operator sets `SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1` and then forgets
about it (or someone else inherits the machine), the next master boot
still emits the loud Telegram + dashboard alert + decisions.jsonl entry.
Accidental arming becomes visible immediately, not at the next billing
cycle.

## Reasoning

### Why a hard guard, not a soft default

The thing we're defending against is "operator at 2am, LM Studio is
dead, daemon is crash-looping, copy-paste the example to keep
working." A *soft* default that just emits a warning would not survive
that workflow — the operator would see the daemon boot, conclude it's
fine, and move on. The throw is the only behavior that forces
deliberate engagement.

### Why a single env var, not a config field

A config field in `providers.json` makes the dangerous setting visible
in the same file the dangerous example lived in — exactly the
copy-paste surface we're trying to defang. An env var in the launchd
plist requires three separate edits (open the plist, set the var,
reload launchd) and lives in a file the operator rarely touches. That
friction is the point.

### Why fire all four alert channels

- `console.error` — guaranteed to land. log file is on disk regardless
  of dashboard / Telegram state.
- `emitNotification` — surfaces in the dashboard tray during normal use.
- Telegram — reaches the operator on their phone, even if the daemon is
  about to crash and they're not at the desk.
- `logDecision` — permanent record in the decisions.jsonl audit trail.

Each channel covers a failure mode of the others. Notifications can be
lost if the dashboard isn't running; Telegram can fail if
`master-notify.json` isn't configured; logs can be missed if the
operator isn't tailing the file. All four firing together gives the
best chance the operator finds out *before* a billing alert.

### Why not also block at pi-ai's request layer

`@earendil-works/pi-ai` is an upstream dependency (ADR 0015). Patching
its dispatch path means owning a vendor fork or upstreaming a flag
that's specific to one consumer's risk profile. The guard at
`buildModel()` runs strictly *before* pi-ai ever sees the Model
object — same effect, no upstream entanglement.

## Consequences

### Positive

- Operator cannot accidentally bill the $200/mo Agent SDK credit by
  copying the example template.
- The dangerous configuration shape (`provider: "anthropic"`) is now
  impossible without an explicit OS-level opt-in. Three independent
  edits required to arm it.
- If the guard ever does trigger — accidentally or deliberately — the
  operator gets four independent alert channels firing within seconds
  of the master boot.
- The audit trail (`decisions.jsonl`) records when and why the guard
  fired, useful for forensics if a billing surprise ever happens.
- `providers.fallback` is no longer a hidden landmine in the type
  definitions — it's optional and documented as deliberately unwired.

### Negative

- The `fallback` field is now formally dead code. If we later decide
  master *should* have a cloud fallback (gpt-5.2 codex, Llama 405B on
  the DGX Spark, etc.), we'll need to re-introduce a wiring path. The
  guard does not block other providers — only `anthropic`. So the
  primary use case for a fallback (local stack down) is still
  achievable via `escalate` (`openai-codex`, already in the example) or
  by pointing `supervisor` at OpenRouter.
- A loud alert on every master boot when the env var is set is
  intentional friction. An operator who legitimately runs with the
  Anthropic provider armed will get a Telegram on every restart.
  That's expected; the friction is the feature.

### Open questions

- **The OpenRouter alternate-supervisor example** in
  `providers.json.example` still shows `"model":
  "anthropic/claude-sonnet-4"`. The provider field there is
  `"openrouter"`, not `"anthropic"`, so it does NOT trip the guard.
  Billing flows through OpenRouter's credit, which is the operator's
  marketplace — separate concern. Worth a note in the OpenRouter
  example comment in a follow-up, but not blocking.
- **Auto-nudge / verifier-cluster / orchestration-msg** push
  HMAC-marked text into running `claude` tmux panes from scheduled
  loops. Those count against the subscription bucket today (interactive
  REPLs). If Anthropic reclassifies "robot driving an interactive
  TUI" as Agent-SDK use, that vector flips overnight. No guard for it
  yet — tracked separately in `CLAUDE_INVOCATION_AUDIT.md` Risk Flag F1.

## Alternatives considered

### Alternative A: Soft warning, no block

Log a warning at boot when `provider: "anthropic"` is detected, but
let pi-ai go ahead and call it. Rejected: doesn't survive the 2am
copy-paste workflow that motivated the ADR.

### Alternative B: Strip the field at config-load time

Have `loadConfig()` delete any `fallback` block whose provider is
`anthropic` and continue. Rejected on two grounds: (1) silent edits to
operator config are the kind of "did you really mean this?" landmine
this ADR exists to prevent, and (2) it doesn't help if a future code
change adds a different call site for the anthropic provider — the
guard at `buildModel()` catches all callers.

### Alternative C: Patch pi-ai upstream to add a `block_providers`
###               list

Add an option to `@earendil-works/pi-ai` to refuse to dispatch to
specific providers regardless of model config. Rejected: takes us out
of vendor parity with ADR 0015's "pi-ai is a first-class upstream"
commitment, and the local guard at `buildModel()` does the job without
an upstream change.

## References

- `CLAUDE_INVOCATION_AUDIT.md` (this branch) — full audit of every
  Claude call site in the repo, including the Risk Flag F1
  (scheduler-driven interactive sessions) tracked for follow-up.
- Anthropic operator email, 2026-05-13:
  *"Starting June 15, Max 20x plan subscribers can claim a $200 monthly
  credit for using the Claude Agent SDK and claude -p, including
  third-party tools built on the Agent SDK. […] Agent SDK and other
  programmatic usage will run on this credit, and will not impact your
  subscription limits."*
- ADR 0015 — `@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`
  as first-class upstreams. Establishes the agent runtime master uses.
- ADR 0011 — Trust-marker HMAC. Context on the auto-nudge /
  orchestration-msg traffic shape mentioned under Open questions.
- DECISIONS.md (2026-05-14 entry) — operator-facing record of this
  decision with a tighter summary.
- Code changes (this branch):
  - `components/master/providers.json.example` — fallback block removed.
  - `components/master/server.ts` — `buildModel()` guard,
    `Providers.escalate` / `Providers.fallback` marked optional.
