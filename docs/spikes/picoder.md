# Spike: pi-coder worker pattern

**Phase 5 of the v3.0 Initiative** ([[Initiatives/v3.0 — Evy rename + multi-worker providers]]).
Time-boxed 36h research. NOT product code. Output is a written design
decision plus a runnable prototype at `docs/spikes/picoder-prototype/`.

## Status

**RECOMMENDED — but not in v3.0.** Integrate in v3.1 as a single ~5–8d
piece of work after the rename + Codex + DeepSeek workers ship. The four
open questions all have concrete answers; the structural risks (Q1 HMAC,
Q2 classification) reduce to existing subctl machinery without new auth
surface. Story-point estimate: **5 SP (~5–8 calendar days)** for a single
worker building it.

> **What this is NOT.** Subctl already ships a provider directory
> called `providers/pi-coding-agent/` — that wraps the `pi` CLI binary
> (Mario Zechner's `@mariozechner/pi-coding-agent` npm package) as a
> TUI worker. THIS spike is a DIFFERENT thing: spawn a Bun process
> that uses the `@earendil-works/pi-agent-core` SDK (the same one Evy
> uses for supervisor calls) configured for any chat-API-compatible
> provider — ZAI/GLM, Minimax, OpenRouter routes, local LM Studio.
> The name "pi-coder" comes from the Initiative; the prototype calls
> it `picoder` to keep search-grep distinguishable from `pi-coding-agent`.
> If we ship it, propose a name that doesn't collide further (e.g.
> `bun-worker`, `chat-api-worker`, or `evy-worker`).

## Summary

The four questions reduce to four already-solved problems if pi-coder
treats subctl's existing on-disk surfaces as its API: the team's HMAC
secret at `~/.local/state/subctl/teams/<team_id>/hmac.secret`, the
inbox JSONL at `<MASTER_STATE_DIR>/inbox/<team_id>.jsonl`, the
classifier's regex sweep over `tmux capture-pane`, and `accounts.conf`'s
existing `alias|provider|email|config_dir|description` row shape.
No new auth surface, no schema migration, no classifier rewrite. The
prototype proves three of the four (Q1, Q2, Q4) end-to-end against the
real `trust-marker` + `auto-nudge` modules.

The remaining cost is integration work — wiring `subctl teams picoder`,
generating per-provider Bun launcher scripts, and accommodating
`pi-agent-core`'s prompt-loop semantics inside the tmux pane. That's
v3.1 territory, not "don't do it" territory.

## Q1 — HMAC directive delivery channel

**Decision: file-based directives queue at
`$SUBCTL_STATE_DIR/teams/<team_id>/directives.jsonl`. The worker
fs.watches + tails it; Evy writes JSONL lines of
`{marker, body}`. Verification reuses
`verifyDirectiveMarker({teamId, marker, body})` from
`components/master/trust-marker.ts` byte-identically.**

### Why a file, not stdin or polling-a-dir

| Option | Verdict | Why |
|---|---|---|
| Pipe-to-stdin | ✗ | tmux owns the pane's stdin. A control pipe competes with the operator's attached debug session and gets lost on detach/reattach. |
| Polling a directory of `<ts>.json` files | ✗ | Race conditions on partial writes, harder GC, ordering surprises when the FS reorders inode birth times. |
| Watching an inbox file | ✗ | Inbox is worker → Evy. Reusing it for the reverse direction conflates traffic the watchdog already classifies. |
| **JSONL file with offset tracking** | ✓ | Same dir as `hmac.secret`, observable from outside the pane (`cat`), survives restarts because the offset lives in worker memory + the next-line discipline. Mirrors Evy's own inbox tail logic at `server.ts:2720`. |

### Wire format

Each line is a single JSON object:

```jsonc
{ "marker": "[subctl-master directive · phase=investigate · ts:2026-05-23T22:57:35.455Z · hmac:37b4b976677a4d42]",
  "body":   "SPEC:\n  Audit token usage in components/master/server.ts and report top 3 hotspots" }
```

`marker` and `body` are passed verbatim to `verifyDirectiveMarker` — the
bytes are exactly what `buildSignedDirective` produced Evy-side. The
existing SPEC-block contract from `providers/claude/teams.sh:451` applies
unchanged: a verified marker with no SPEC block (or SPEC without the
two-space indent) is refused.

### Empirical evidence (from prototype)

```
==> Q1 negative case: emit a TAMPERED directive and prove the worker refuses
  tampered directive emitted (marker valid; body altered post-sign)
…
[picoder] HMAC verification FAILED for ts=2026-05-23T22:57:36.990Z; refusing
```

The worker uses `verifyDirectiveMarker` directly — no new HMAC code, no
new auth surface. Forging a directive requires the per-team secret, which
lives only on disk (chmod 600) and in the worker's spawn-time environment.

### Risks

- **fs.watch on macOS APFS can drop events.** Mitigation: the prototype
  pairs `fs.watch` with a 2s `setInterval` poll, mirroring `server.ts:2895`.
- **At-least-once delivery is implicit.** If Evy writes the same line
  twice (network retry path), the worker processes it twice. Mitigation:
  the directive ts is monotonic and can dedupe via an in-memory ring. Not
  done in the prototype — flag for the production implementation.
- **Worker reading stale offset after restart.** Mitigated by the
  "first-scan jumps to EOF" rule (mirrors `server.ts:2720`); pre-restart
  directives are HISTORICAL.

## Q2 — Watchdog classifier on a non-TUI Bun process

**Decision: pi-coder emits human-readable status lines that match the
existing regex classifier in `components/master/auto-nudge.ts`. NO
per-worker-type adapter. The classifier stays single-implementation;
pi-coder is responsible for printing prose the classifier can read.**

### Why no adapter

Today's `classifyWorkerReply` is a regex sweep over pane prose:

```ts
// From components/master/auto-nudge.ts:66
/idle by design/                       // → completed_idle
/(?:task|work) (?:is )?complete[d]?\b/ // → completed_idle
/(?:i'?m |currently )?(?:stuck on|blocked on|blocked by)/  // → blocked
/awaiting your /                       // → awaiting_input
…
```

Pi-coder controls its own stdout. Emitting `"task complete — idle by
design"` is one `console.log` away. Adding a "structured marker" path
(e.g. `[picoder:state] kind=completed_idle`) requires touching the
classifier (~5 LOC short-circuit at the top of `classifyWorkerReply`)
AND every other worker type stays on prose, so we'd then have two
classifier paths to maintain.

> **Counter-argument** (worth recording): structured markers are more
> robust against future classifier regex drift. If we ever rewrite the
> classifier to be LLM-judged, pi-coder's prose still works; if we
> rewrite it to be marker-driven, every worker type has to migrate. The
> recommendation here is biased toward "fewer paths today"; revisit if
> we ever have a third worker type that doesn't naturally emit prose.

### Empirical evidence (from prototype)

The prototype's worker emits exactly the strings above. The demo runs
the real `classifyWorkerReply` over the captured pane log and the
result is:

```
classification.kind   = completed_idle
classification.snippet= "…e=investigate\n[picoder] task complete — idle by design. …"
```

No classifier modifications. Zero-LOC integration on the watchdog side.

### What capture-pane actually shows

`bun run` in a tmux pane writes line-buffered text exactly like any
other process. The prototype's worker prints:

```
[picoder] starting — team=picoder-demo
[picoder] watching directives: /tmp/picoder-demo/teams/picoder-demo/directives.jsonl
[picoder] writing inbox to:   /tmp/picoder-demo/master-state/inbox/picoder-demo.jsonl
[picoder] received signed directive (phase=investigate ts=2026-05-23T22:57:35.455Z)
[picoder] working on: phase=investigate
[picoder] task complete — idle by design. no further directives pending
```

`tmux capture-pane` on a real spawned pane would return exactly this
content (last N lines, ANSI-stripped if the pane wasn't started with
`-e CLICOLOR_FORCE`). Classifier reads it. Done.

### Risks

- **Real pi-agent-core output may be conversational and trigger
  classifier false positives.** If the supervisor model says "I am
  done with this task" mid-execution, the classifier may flip to
  `completed_idle` while real work is in flight. Mitigation: the worker
  wrapper script (NOT pi-agent-core itself) is responsible for the
  "external" status markers; the inner agent's prose is sandwiched
  between explicit `[picoder] working` and `[picoder] task complete`
  banners that the wrapper emits.
- **Heartbeat needed for genuinely idle workers.** A Bun process that
  has processed its directives and is sleeping shows no new pane lines.
  The prototype emits a 30s heartbeat to keep the pane non-silent. In
  production this also helps the operator confirm the worker is alive
  on attach.

## Q3 — Per-account isolation shape

**Decision: extend `accounts.conf` by convention, not by schema. Existing
columns are unchanged; the `provider` field accepts a namespaced
provider id like `picoder-zai` or `picoder-openrouter`; `config_dir`
points at the per-alias state dir; API keys live in
`~/.config/subctl/secrets.json` under existing-shape keys
(`zai_api_key`, `openrouter_api_key`, etc.). NO separate
`pi-accounts.conf`.**

### Why no schema change

Today's `accounts.conf` shape (per `lib/accounts.sh` + the operator's
real file at `~/.config/subctl/accounts.conf`):

```
alias|provider|email|config_dir|description
```

```
claude-jason    | claude        | jason@webdevtoday.com  | ~/.claude-jason       | Daily driver
openai-jason    | openai-codex  | jbrashear72@icloud.com | ~/.codex-jason        | Personal Codex
```

Pi-coder rows fit:

```
picoder-zai-jason     | picoder-zai        | n/a | ~/.config/subctl/picoder/zai-jason     | ZAI GLM-4-Plus via subscription
picoder-or-deepseek   | picoder-openrouter | n/a | ~/.config/subctl/picoder/or-deepseek   | DeepSeek V4 via OpenRouter
picoder-lmstudio      | picoder-local      | n/a | ~/.config/subctl/picoder/lmstudio      | Local llama 405B
```

`email` is informational only — for API-key providers it's "n/a". This
is already the convention for the existing `pi-coding-agent` rows.
`config_dir` becomes a per-alias scratch + transcript dir, not a CLI
config dir (pi-coder has no CLI to configure — it's a Bun script).

### Where the API key lives

`~/.config/subctl/secrets.json` already follows this shape (see
`components/master/secrets.ts:57`):

```jsonc
{
  "openrouter_api_key": "sk-or-v1-...",
  "lmstudio_api_token": "lm-studio-..."
}
```

Adding a new provider means appending one entry to `SECRET_KEYS` in
`secrets.ts`:

```ts
export const SECRET_KEYS = [
  …existing…,
  "zai_api_key",       // new for picoder-zai
  "minimax_api_key",   // new for picoder-minimax
] as const;
```

The dashboard's secrets panel auto-renders new entries. No schema
migration needed; rotation is operator-driven via the panel just as
today's keys are.

### Provider namespace registry

Pi-coder providers should live under `providers/picoder/<provider>/`
or as a single `providers/picoder/` with a JSON registry that maps
`provider_id` → `{api_base_url, model, secret_key_name}`. The latter
is cheaper — adding a new chat-API provider becomes one JSON-entry
PR, not a directory.

Sketch:

```jsonc
// providers/picoder/registry.json (proposed; NOT created in this spike)
{
  "picoder-zai": {
    "api_base_url": "https://api.z.ai/api/paas/v4",
    "model": "glm-4-plus",
    "secret_key": "zai_api_key",
    "auth_header": "Authorization: Bearer ${secret}"
  },
  "picoder-openrouter": {
    "api_base_url": "https://openrouter.ai/api/v1",
    "model": "deepseek/deepseek-chat",
    "secret_key": "openrouter_api_key",
    "auth_header": "Authorization: Bearer ${secret}"
  },
  "picoder-local": {
    "api_base_url": "http://127.0.0.1:1234/v1",
    "model": "llama-3.3-70b",
    "secret_key": "lmstudio_api_token",
    "auth_header": "Authorization: Bearer ${secret}"
  }
}
```

This sits next to `accounts.conf`, not inside it — the registry is
provider definitions; `accounts.conf` is the operator's choice of
which-account-talks-to-which-provider.

### Risks

- **Two providers wanting the same API key.** E.g. `picoder-openrouter`
  and a hypothetical future `picoder-or-direct` both want
  `openrouter_api_key`. That's fine — keys are shared by their *provider*,
  not by their account. Multiple aliases can route through the same
  `picoder-openrouter` provider.
- **Operator confusion: when does an alias get its own key vs share?**
  Document in `docs/multi-account.md` (out-of-spike work) that pi-coder
  aliases are per-provider not per-key.

## Q4 — Inbox event reporting

**Decision: direct `appendFileSync` to
`<MASTER_STATE_DIR>/inbox/<team_id>.jsonl` with the existing
`{ts, type, text, ...}` shape. No SDK call. A ~30-line helper module
(name TBD; the prototype inlines the function in `picoder-worker.ts`)
encapsulates `team_id` resolution from env and the file path.**

### Why direct JSONL, not an SDK

The Claude Code worker uses the `team_inbox` MCP tool (`components/master/
mcp/tools.ts:468`) because it has no other way to write to a host file
from inside the Claude Code TUI sandbox. Pi-coder runs as a regular Bun
process with full filesystem access — calling an SDK is strictly worse:
adds a dependency, adds an in-process HTTP client, adds latency.

The append target is already a tail-watched file with a documented event
shape. Writing directly is the path of least resistance.

### Event shape (from prototype run)

```jsonl
{"ts":"2026-05-23T22:57:34.947Z","type":"note","text":"picoder worker started","team":"picoder-demo"}
{"ts":"2026-05-23T22:57:35.456Z","type":"progress","text":"executing SPEC (phase=investigate)"}
{"ts":"2026-05-23T22:57:35.657Z","type":"done","text":"SPEC executed successfully","phase":"investigate","body_chars":82}
{"ts":"2026-05-23T22:57:36.991Z","type":"error","text":"HMAC verification failed; refused directive","ts_of_refused":"2026-05-23T22:57:36.990Z"}
```

The `type` values (`note`, `progress`, `done`, `error`, `blocked`)
match what Evy's `TeamEvent` consumer expects (see `server.ts:1874`
and `mcp/tools.ts:151`). Extra fields (`phase`, `team`, `body_chars`,
`ts_of_refused`) ride through Evy's `[k: string]: unknown` extension
slot — the prototype validates the round-trip.

### The proposed helper API

In a single Bun module dropped at `lib/picoder-inbox.ts` (or wherever
the shared util lands):

```ts
// Proposed — NOT in this spike. Sketch only.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type EventType = "progress" | "blocked" | "done" | "error" | "note";

export function reportEvent(type: EventType, text: string, extra: Record<string, unknown> = {}) {
  const teamId = process.env.SUBCTL_TEAM_ID;
  const inboxDir =
    process.env.SUBCTL_TEAM_INBOX_DIR ??
    join(process.env.SUBCTL_CONFIG_DIR ?? `${process.env.HOME}/.config/subctl`, "master", "state", "inbox");
  if (!teamId) throw new Error("SUBCTL_TEAM_ID not set");
  mkdirSync(inboxDir, { recursive: true });
  appendFileSync(
    join(inboxDir, `${teamId}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), type, text, ...extra }) + "\n",
  );
}
```

That's the whole "SDK." Future pi-coder workers `import { reportEvent }`
and call it. Same module can later add a small validator (event type
enum check, max-length cap, attachment-by-reference shape) without
breaking callers — additive.

### Risks

- **Concurrent appends from multiple worker processes for the same
  team.** POSIX `O_APPEND` is atomic for writes under PIPE_BUF (4KB),
  which covers every reasonable single-line event. Larger payloads
  need `flock` — but pi-coder events are small. Flag for production:
  cap `text` at 2KB and put binary attachments behind a reference path.
- **Inbox files get pruned by team-gc.ts.** Same lifecycle as Claude
  Code's inbox; no special handling needed.

## Open risks (things this 36h spike couldn't answer)

1. **pi-agent-core in a worker role, not a supervisor role.** Evy uses
   it as a chat-style supervisor. A pi-coder worker is more like a
   code-generation agent — different tool registry, different system
   prompt shape, different transcript semantics. The prototype short-
   circuits this entirely by simulating "work" with a setTimeout; real
   integration needs to confirm pi-agent-core's `Agent.prompt()` loop
   tolerates being driven from a directives file rather than a chat
   stream.
2. **The supervisor-vs-worker billing question.** ADR 0019 explicitly
   blocks `anthropic` provider in pi-agent-core (would bill the Agent
   SDK credit). The same hard rule may apply to other chat-API
   providers in unforeseen ways; needs a pre-flight check per provider.
3. **Multi-pane teams.** Claude Code workers spawn additional panes
   via `TeamCreate + Agent(team_name)`. Pi-coder has no equivalent.
   For v3.1 a single pi-coder worker == single pane is sufficient;
   if/when we want pi-coder teams of N, the team coordinator has to
   be Evy herself (which she already is via the orch tools).
4. **Provider rate-limit awareness.** Subctl's `radar` tracks Claude
   per-account utilization via specific upstreams. Pi-coder providers
   are diverse; some have no rate-limit metadata at all. Either degrade
   gracefully (radar ignores pi-coder providers) or add a generic
   "429-counter" surface. Out-of-scope for this spike.
5. **Worker shutdown semantics.** The prototype runs until killed.
   Production needs a `done-and-exit` mode (after one directive),
   a `daemon-mode` (until killed), and a clean SIGTERM handler that
   writes a `note: shutting down` inbox event. Trivial to add.

## Estimated cost to integrate

**5 SP / ~5–8 calendar days** for a single worker building it in v3.1.

| Slice | Effort | Notes |
|---|---|---|
| `providers/picoder/` directory + `registry.json` | 0.5 d | Mirrors `providers/pi-coding-agent/` layout. |
| `providers/picoder/teams.sh` (tmux spawn) | 1 d | Copy claude/teams.sh, replace `command claude` with `bun run worker.ts`. HMAC secret generation already there. |
| `providers/picoder/worker.ts` (real, not prototype) | 2 d | Wire pi-agent-core's Agent into the spike's skeleton. The 4 questions are already answered; this is wiring. |
| `lib/picoder-inbox.ts` helper | 0.25 d | The 30-line module above. |
| `secrets.ts` `SECRET_KEYS` additions | 0.25 d | Per provider. |
| `subctl teams picoder` CLI dispatch + `accounts add picoder-…` | 0.5 d | Same shape as existing providers. |
| Tests (spawn + auth + HMAC roundtrip) | 1 d | Adapted from `providers/claude/__tests__/`. |
| Dashboard secrets panel auto-renders new keys | 0 d | Already does. |
| Operator docs (`docs/multi-account.md`, `docs/adding-a-provider.md` updates) | 0.5 d | |

Total: **~6 days** of focused work. The 5 SP rounds up to allow for
the integration surprises noted in the Open Risks section above.

## What to do NEXT (post-v3.0)

1. Ship v3.0 with Phases 0–3 (rename + Codex).
2. Ship Phase 4 (DeepSeek-TUI) — separate work already in flight on
   `feat/v3-deepseek-worker` (see another teammate's tasks).
3. Slot pi-coder integration into v3.1 alongside (or after) the
   DeepSeek work, since DeepSeek's `accounts.conf` extension will
   already have settled the "non-config-dir provider rows" pattern.
4. Reuse the prototype's `picoder-worker.ts` shape as the seed for
   `providers/picoder/worker.ts`.

## Cross-references

- [Initiative v3.0](../../../../Documents/Obsidian%20Vault/Subctl/Initiatives/v3.0%20%E2%80%94%20Evy%20rename%20%2B%20multi-worker%20providers.md) (vault, source of truth for the 4 questions)
- [Glossary](../../../../Documents/Obsidian%20Vault/Subctl/10%20-%20Glossary.md) (vault, the pi-coder row)
- `components/master/trust-marker.ts` (the HMAC contract reused here)
- `components/master/auto-nudge.ts` (the classifier reused here)
- `components/master/secrets.ts` (the secrets shape reused here)
- `providers/pi-coding-agent/README.md` (the DIFFERENT, already-shipped
  pi-CLI provider — read this first to keep the two names straight)
- `docs/spikes/picoder-prototype/` (the runnable evidence for this doc)
