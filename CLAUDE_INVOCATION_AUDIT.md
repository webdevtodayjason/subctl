# Claude Invocation Audit — subctl

Audit date: 2026-05-14
Branch: `claude/keen-merkle-46515a`
Scope: every site in this repo that launches Claude, drives a Claude session,
or calls the Anthropic API. Classified against the Max 20× subscription bucket
(INTERACTIVE) vs. the June 15 2026 Agent SDK $200/month credit bucket
(PROGRAMMATIC).

## Summary

| Bucket                                              | Sites |
|-----------------------------------------------------|------:|
| **Interactive** (subscription)                      | 5     |
| **Programmatic** (Agent SDK / API credit)           | 1     |
| **Ambiguous**                                       | 4     |
| **Non-Claude** (appendix, no bucket)                | —     |

Headline:

- This repo's **dominant pattern is interactive**: `subctl teams claude`
  spawns a `command claude` REPL inside a tmux pane. Every claude session
  the operator sees is, technically, an interactive subscription session.
- The **only direct Anthropic API call** in the whole repo is the eval-suite
  LLM judge at `components/master/__tests__/evy-eval/judge.ts` — a raw
  `POST https://api.anthropic.com/v1/messages`. That will count against the
  $200 Agent-SDK credit (or whatever ANTHROPIC_API_KEY is wired to).
- There are **no `@anthropic-ai/claude-agent-sdk` or `claude_agent_sdk`
  imports**, no `claude -p` / `claude --print` invocations, no Anthropic
  SDK usage anywhere else.
- The interesting risk is **automated drivers of interactive sessions**:
  the master daemon (auto-nudge, verifier-cluster, scheduled-followup
  ticker) and the dashboard's `/api/orchestration/:name/msg` endpoint
  push HMAC-authenticated text into running `claude` tmux panes via
  `tmux paste-buffer` + `send-keys Enter`. These sessions count against
  the subscription bucket today, but they are effectively programmatic
  — Anthropic could reclassify the pattern at any time.

---

## Interactive invocations

Each of these drops a human (or appears to drop a human) into a Claude REPL.
All share one mechanism: `command claude` with `CLAUDE_CONFIG_DIR` set, no
`-p` / `--print`, attached to a real TTY (directly or via tmux).

### 1. [providers/claude/auth.sh:44](providers/claude/auth.sh:44)

```
CLAUDE_CONFIG_DIR="$cfg_dir" command claude || true
```

OAuth flow. Spawns bare `claude` so the user can complete the
browser-based login. Pure interactive — there is no flag and no piped
input.

Callers: `subctl auth claude <alias>`, walked across every claude account
by `provider_claude_auth_all` ([providers/claude/auth.sh:59-66](providers/claude/auth.sh:59)).
Caller paths into here: [lib/setup.sh:264,282](lib/setup.sh:264),
[lib/tui.sh:177](lib/tui.sh:177).

### 2. [providers/claude/teams.sh:315-318](providers/claude/teams.sh:315)

```
local CLAUDE_CMD="command claude"
$SKIP_PERMS && CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
$CONTINUE   && CLAUDE_CMD="$CLAUDE_CMD --continue"
[[ -n "$RESUME_SID" ]] && CLAUDE_CMD="$CLAUDE_CMD --resume $RESUME_SID"
```

Builds the interactive command. None of the flag branches (`--dangerously-skip-permissions`,
`--continue`, `--resume`) push the invocation into print mode.

### 3. [providers/claude/teams.sh:497](providers/claude/teams.sh:497)

```
tmux send-keys -t "$SESSION_NAME" "$CLAUDE_CMD" Enter
```

The actual launch site: pastes `command claude …` (built at line 315)
into a tmux pane and presses Enter. The session that follows is a
human-driven REPL. Optional initial prompt (`-p`, `--prompt-file`,
`-o` orchestrator, `--template`) is pasted in afterward via
`tmux paste-buffer` — still interactive (the user reads the assistant
turn and types the next message).

Callers: `subctl teams claude` CLI ([bin/subctl](bin/subctl)), the
`claude-teams` shim ([bin/claude-teams:5](bin/claude-teams:5),
`exec subctl teams claude "$@"`), the TUI's "new claude session"
modal ([deck/tui/newsess.go:206](deck/tui/newsess.go:206) — Bubble Tea
Go binary), [lib/tui.sh:224](lib/tui.sh:224), [lib/projects.sh:143,180](lib/projects.sh:143)
(`subctl restart-projects` bulk launcher), and the dashboard's
`/api/orchestration/spawn` HTTP endpoint
([dashboard/server.ts:5464](dashboard/server.ts:5464)).

### 4. [lib/session-preview.sh:718](lib/session-preview.sh:718)

```
exec env CLAUDE_CONFIG_DIR="$pick_cfg" command claude --resume "$pick_sid"
```

`subctl session-resume` — picker UI that resumes a saved session by id.
Replaces the shell with `claude --resume`, which is the same TUI app the
user would otherwise reach by typing `claude --resume` themselves.
Interactive.

Caller: [bin/claude-resume:4](bin/claude-resume:4)
(`exec subctl session-resume "$@"`).

### 5. [lib/migrate.sh:259](lib/migrate.sh:259) (shell function passthrough)

```
command claude "$@"
```

Installed into the user's `~/.zshrc`/`~/.bashrc` as a wrapper function
that gates the bare-`claude` REPL behind "pick an account first" but
passes through everything else. The passthrough branch on line 258
matches `update|doctor|migrate-installer|setup-token|mcp|config|ultrareview|`
`--version|-v|--help|-h|-p|--print|--resume|--continue|-c|-r`.

This is a shell function the **user** types; subctl never invokes it
itself. It's both interactive AND programmatic depending on what the
user types — see **Ambiguous #1** below. Classified here as Interactive
because every site that calls into it from subctl code does so with
human-input intent.

---

## Programmatic invocations

### 1. [components/master/__tests__/evy-eval/judge.ts:91-133](components/master/__tests__/evy-eval/judge.ts:91)

```ts
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const JUDGE_MODEL_ID = "claude-sonnet-4-5-20250929";
…
const res = await fetch(ANTHROPIC_MESSAGES_URL, {
  method: "POST",
  headers: {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: JUDGE_MODEL_ID,
    max_tokens: 1024, temperature: 0,
    messages: [{ role: "user", content: prompt }],
  }),
});
```

Raw fetch to the Anthropic Messages API. **The only true programmatic
Claude call in the repo.** Used by the Evy persona eval suite (`bun test`
of `components/master/__tests__/evy-eval/**`). Reads `ANTHROPIC_API_KEY`
from env or `~/.config/subctl/secrets.json:anthropic_api_key`. Dual-mode:
if no key, `judgeResponse` returns a `JudgeSkippedResult` and the suite
degrades to regex-only grading.

Estimated frequency: **one-shot**, only when an operator manually runs
`bun test` on the evy-eval suite. Not on a schedule. Not in CI
(`.github/workflows/ci.yml` does not run this suite — only shellcheck +
`bun build dashboard/server.ts` + `go vet` in `deck/`). One eval run
fires one POST per per-test judge invocation (`tests/_helpers.ts:96`,
`await judgeResponse(...)`).

Bucket: **counts against $200 Agent SDK credit** (or whatever the
`ANTHROPIC_API_KEY` is billed against — it's a raw API key, not an
OAuth/Max session).

---

## Ambiguous

### A. [lib/migrate.sh:259](lib/migrate.sh:259) — `claude()` shell function

Installed into the operator's shell rc by `subctl_migrate_generate_aliases`.
Its passthrough whitelist explicitly includes `-p|--print` (line 258),
which would be a PROGRAMMATIC invocation, AND `--resume|--continue` and
the various flags that are INTERACTIVE. Classification depends on what
the operator types at the prompt, not on subctl code.

What would resolve it: a usage telemetry pass on the operator's shell
history. The function itself is correctly written — both call paths
work — but auditing it from the repo can't tell you which way it's
being used in practice.

### B. [components/master/server.ts](components/master/server.ts) — master daemon agent runtime — **RESOLVED 2026-05-14 (ADR 0019)**

The master daemon (`components/master/server.ts`, lines 31-49) is built
on `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, NOT the
Anthropic SDK. The default configuration in
[components/master/providers.json.example:9-19](components/master/providers.json.example:9)
points the supervisor at LM Studio + `qwen/qwen3.6-35b-a3b` — local, no
Anthropic billing.

But [providers.json.example:50-54](components/master/providers.json.example:50)
shows an optional `"fallback"` block with
`"provider": "anthropic"`, `"model": "claude-sonnet-4-6"`,
`"auth": "max-subscription"`. If an operator enables that fallback AND
configures pi-ai's anthropic provider with an API key (rather than the
Max OAuth path), the daemon becomes a programmatic Anthropic caller on
every `agent.prompt()` — and that's a hot loop:

- watchdog ticker every ~60s ([server.ts:3308](components/master/server.ts:3308))
- followup ticker every 60s ([server.ts:3348](components/master/server.ts:3348))
- auto-compact interval ([server.ts:3444](components/master/server.ts:3444))
- inbox poll ([server.ts:1283](components/master/server.ts:1283))
- chat/Telegram inbound prompts (event-driven)

What would resolve it: read the operator's `~/.config/subctl/master/providers.json`
to see whether `fallback.provider == "anthropic"` is wired up and what
auth it's using. With Max-subscription OAuth, the calls go through the
subscription bucket; with a raw `ANTHROPIC_API_KEY` they go through the
SDK credit. Defaults are local — nothing burns either bucket out of the
box.

**RESOLUTION (2026-05-14, ADR 0019):** The `fallback` block was stripped
from `providers.json.example`, and `buildModel()` in
`components/master/server.ts` now hard-fails on any role that resolves
to `provider: "anthropic"` unless `SUBCTL_ALLOW_ANTHROPIC_PROVIDER=1` is
set in the launchd plist. Guard fires loud alerts on four channels
(stderr, dashboard notification, Telegram, decisions.jsonl) on first
trip per boot. See `docs/adr/0019-no-anthropic-provider-in-master.md`.

### C. [dashboard/server.ts:5391+5464](dashboard/server.ts:5391) — `POST /api/orchestration/spawn`

External HTTP callers (ArgentOS, the MCP server, custom scripts) can
POST a JSON body to spawn a `subctl teams claude` session. The session
that gets created is an interactive REPL (case #3 above). But the
*spawn trigger* is fully programmatic.

The MCP server exposes this as a tool the master daemon can call:
[components/mcp/server.ts:103,262](components/mcp/server.ts:103) —
`subctl_orch_spawn`. Master tools at
[components/master/tools/subctl-orch.ts](components/master/tools/subctl-orch.ts)
and [components/master/tools/specforge.ts:168,315](components/master/tools/specforge.ts:168)
reference it as the standard way to dispatch a dev team.

Bucket impact: the spawned session itself counts against the
subscription. The spawn HTTP call doesn't talk to Anthropic. But the
session is being created without a human at the keyboard — a programmatic
launcher of interactive minutes.

### D. [dashboard/server.ts:5604-5615](dashboard/server.ts:5604) + [components/master/tools/policy/verifier-cluster.ts:170-198](components/master/tools/policy/verifier-cluster.ts:170) — automated message injection into running sessions

`POST /api/orchestration/:name/msg` and the master daemon's
`verifier-cluster.defaultDeliverToWorker` both push text into running
claude tmux panes via:

```
tmux set-buffer -b … <wrapped>
tmux paste-buffer -t <session> -b …
tmux send-keys -t <session> Enter
```

Drivers — these are *not* one-shot:

- [components/master/auto-nudge.ts:219](components/master/auto-nudge.ts:219)
  (`sendNudge` callback) — fires on every stale-team-sweep tick that
  detects a worker idle past threshold. Sends `[auto-nudge] You've been
  inactive for N min …`. Re-fires every 30min if still stale.
- [components/master/tools/policy/verifier-cluster.ts:487](components/master/tools/policy/verifier-cluster.ts:487)
  (`setInterval`) — periodic verifier-correction ticker on the master daemon.
- `subctl_orch_msg` MCP tool ([components/mcp/server.ts:120,274](components/mcp/server.ts:120)).
- Master's own self-scheduled followups
  ([components/master/tools/scheduler.ts](components/master/tools/scheduler.ts),
  fired by [server.ts:3348](components/master/server.ts:3348) ticker)
  fire into a synthetic agent prompt that may itself call
  `subctl_orch_msg`.

Bucket impact: every message pasted in causes the worker's claude
session to consume a turn. The session is interactive (counts toward the
subscription bucket), but the trigger is fully programmatic — schedulers
and watchdogs, not a human at the keyboard. Anthropic could plausibly
treat sustained scheduler-driven traffic as Agent SDK use even though
the REPL technically remains interactive today.

What would resolve it: explicit policy from Anthropic on the
"automated keystrokes into an interactive REPL" pattern.

---

## Risk flags

### F1 — Watchdog/scheduler-driven workers (highest reclassification risk)

The auto-nudge → `tmux paste-buffer` → worker REPL pipeline is the
clearest case of an interactive Claude session being driven by an
automated scheduler. Concretely:

- [components/master/auto-nudge.ts:219](components/master/auto-nudge.ts:219)
  → callbacks.sendNudge → `POST /api/orchestration/<team>/msg`
  → [dashboard/server.ts:5604-5615](dashboard/server.ts:5604)
  → tmux paste-buffer into `claude-<team>` session.
- Trigger cadence: `runStaleTeamSweep` runs from the master watchdog
  ticker every ~60s; sends a first nudge once a team crosses staleness
  threshold, re-nudges every `nudge_retry_ms` (30 min default) until the
  team replies or vanishes.
- HMAC-authenticated marker (`[subctl-master directive · ts:<iso> · hmac:<hmac16>]`)
  wrapping each pasted body — see [providers/claude/teams.sh:391-431](providers/claude/teams.sh:391).
  This is exactly the kind of artifact that distinguishes
  "human typing" from "robot driving the TUI."

These will count against the subscription bucket today. If Anthropic
moves the line on what constitutes Agent SDK use, every team running
with a master daemon armed flips overnight.

### F2 — Direct API in the test suite

[components/master/__tests__/evy-eval/judge.ts:91](components/master/__tests__/evy-eval/judge.ts:91)
is the only direct `api.anthropic.com/v1/messages` POST in the repo.
Low risk today (one-shot dev tool, not on CI, dual-mode if no key) but
worth pinning: if anyone wires evy-eval into a cron or scheduled
ralph-loop, it becomes a programmatic burn on the $200 credit. The
caller-counting recipe is one POST per `judgeResponse()` call per test
case per run.

### F3 — Dashboard spawn endpoint exposed to anything that can hit localhost:8787

[dashboard/server.ts:5391](dashboard/server.ts:5391) (`POST /api/orchestration/spawn`)
is gated only by the dashboard auth, which depending on deployment can
be local-only or LAN-reachable. Each spawn creates a real subscription
session. Not a credit-bucket risk, but a subscription-quota risk if an
external caller (ArgentOS, automated cron via `gh workflow run`,
remote tunnel) can rip through `subctl teams claude` spawns. Worth
auditing whether bind host (`SUBCTL_MASTER_HOST`, default 127.0.0.1)
and dashboard listener are aligned.

---

## Non-Claude invocations (appendix)

These are LLM/agent invocations that do NOT count against either the
Anthropic subscription or the Agent SDK credit:

- **Local LLM runtime** — master daemon uses
  `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`, pointed at
  LM Studio (`http://localhost:1234/v1`) running Qwen/Gemma by default
  ([components/master/providers.json.example](components/master/providers.json.example)).
- **Provider stubs** — `providers/gemini/`, `providers/openai/`,
  `providers/minimax/`, `providers/zai/`, `providers/pi-coding-agent/` —
  each has its own teams.sh / signals.sh / auth.sh. The pi-coding-agent
  one spawns a `pi` binary into tmux ([providers/pi-coding-agent/teams.sh:175](providers/pi-coding-agent/teams.sh:175)).
- **OAuth usage telemetry** — [lib/usage.sh:152](lib/usage.sh:152) hits
  `https://api.anthropic.com/api/oauth/usage` with a Bearer token (the
  same endpoint Claude Code uses for `/usage`). This is the existing
  subscription's usage-reporting endpoint, not a generative call — it
  does not consume tokens against either bucket.
- **Other MCP servers** referenced by master/dashboard
  (`context7`, `linear`, `tinyfish`, `coderabbit`, `evy-memory`, etc.)
  — none of them call Anthropic directly from this repo.
