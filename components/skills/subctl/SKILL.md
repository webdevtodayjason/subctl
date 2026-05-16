---
name: subctl
description: >-
  Subscription Central — multi-account AI subscription orchestration toolkit.
  Activate this skill whenever you need to: spawn or control tmux orchestrator
  sessions, send Telegram messages or ask the operator a question, look up
  cross-account session state, or read/write the rate-limit radar.

  Trigger phrases: "spawn an orchestrator", "send a message to the operator",
  "ask the user a yes/no", "what's running across all my accounts", "kill that
  tmux session", "what's my rate-limit status", "stats from the dashboard",
  "let the user know we're stuck", "fire and forget on this question".

  Trigger conditions: any time you would otherwise shell out to tmux for
  session control, OR call Telegram's API directly, OR re-read transcripts
  to figure out what's running on another account. subctl is the canonical
  surface for all of these.
scope: both
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

# subctl — Subscription Central

`subctl` is the canonical control plane for AI-subscription orchestration on
this machine. It manages multi-account isolation, tmux orchestrator sessions,
rate-limit awareness, an operator escalation channel (Telegram), and a web
dashboard, all from a single repo at `~/code/subctl`.

## When to invoke this skill

| You want to… | Use… |
|---|---|
| Spawn a new tmux orchestrator session | `subctl orch spawn` (CLI) or `POST /api/orchestration/spawn` |
| List what's running across all accounts | `subctl orch list` or `GET /api/orchestration` |
| Send text into a running orchestrator's pane | `subctl orch msg <name> <text>` |
| Kill a session | `subctl orch kill <name>` |
| Send the operator a status update (no reply expected) | `subctl notify "<message>"` |
| Ask the operator a yes/no question | `subctl notify ask-yesno "<q>" --id Q42` |
| Ask multi-choice (2-8 options) | `subctl notify ask-choice "<q>" -o A:label -o B:label --id Q43` |
| Ask for free-form text | `subctl notify ask-text "<q>" --id Q44` |
| Check operator's reply to an earlier ask | `subctl notify inbox --id Q42` |
| Check stats / rate limits / verdict | `subctl radar` (CLI) or `GET /api/state` (HTTP) |
| Switch the current shell to a different account | `claude-use <alias>` |
| Pick + resume a past session | `subctl session-resume` |
| Find session by project name | `subctl session-list \| grep <project>` |

## Orchestration control plane

### Sessions are name-addressed everywhere

Every tmux orchestrator session has a unique name (`claude-<basename>` by
default). You target sessions by that name on every channel:

- **CLI**: `subctl orch <verb> <name>`
- **HTTP**: `POST /api/orchestration/<name>/msg`
- **Telegram bot**: `/msg <name> <text>`, `/kill <name>`
- **Ask protocol**: each `--id Q<n>` is unique per asker; the lane that
  asked the question polls only its own ids.

Running 7 orchestrator sessions concurrently → no collisions.

### Spawning

```bash
# CLI
subctl orch spawn \
  --account claude-personal \
  --project ~/code/myproject \
  --orchestrator \
  --skip-perms \
  --prompt "build feature X per ORCHESTRATION.md"
```

```bash
# HTTP (callable from any process: ArgentOS, scripts, MCP tools, …)
curl -X POST http://127.0.0.1:8787/api/orchestration/spawn \
  -H "Content-Type: application/json" \
  -d '{
    "account": "claude-personal",
    "project": "/Users/you/code/myproject",
    "prompt": "build feature X per ORCHESTRATION.md",
    "orchestrator": true,
    "skip_perms": true
  }'
```

Both paths shell out to `subctl teams claude --no-attach` so the spawning
process exits cleanly.

### Inspecting + controlling

```bash
subctl orch list                       # tabular display
subctl orch status <name>              # live pane preview + state
subctl orch msg <name> "<text>"        # tmux paste-buffer + Enter
subctl orch kill <name>                # tmux kill-session
```

## Master daemon (subctl master)

A long-running per-machine daemon that owns rate-limit-aware dispatch
across all your accounts. Two-bot model: a **master-bot** runs the
strategic queue + provider routing, a **notify-bot** fields the inbound
Telegram listener (replies, asks, acks). Wired into `subctl install`;
runs under launchd.

### CLI verbs

| Command | Purpose |
|---|---|
| `subctl master enable` | Install + load the launchd plist (master starts at login) |
| `subctl master disable` | Unload + uninstall the launchd plist |
| `subctl master status` | Daemon state, uptime, queue depth, last heartbeat |
| `subctl master logs` | Tail master + notify logs |
| `subctl master prompt "<msg>"` | Inject a strategic prompt into the master queue |
| `subctl master providers` | Show / edit configured providers |
| `subctl master policy` | Show / edit dispatch policy |
| `subctl master pause` / `resume` | Halt or resume dispatch (queue keeps accumulating) |
| `subctl master restart` | Restart the daemon (reloads providers + policy) |

### Config files

| File | What lives here |
|---|---|
| `~/.config/subctl/master/providers.json` | Per-provider routing + cost weights (seeded from `components/master/providers.json.example` on first boot) |
| `~/.config/subctl/master/policy.json` | Dispatch / pause / escalation policy (seeded from `components/master/policy.json.example` on first boot) |
| `~/.config/subctl/master-notify.json` | notify-bot Telegram credentials + chat id |

`subctl install` only places the daemon code. `providers.json` and
`policy.json` are seeded by the daemon itself the first time it boots.

### When NOT to invoke

- Worker sessions don't `subctl master prompt` — that's strategic
  operator surface, not worker-loop traffic. Workers escalate via
  `subctl notify ask-*` exactly as before.
- Don't pipe verbose status into the master from automation; the
  daemon's queue is for human-or-orchestrator strategic intent, not
  log fan-in.

## Telegram escalation channel

### Outbound: notify

Pure fire-and-forget message. Auto-prefixes with the current cwd so the
operator knows which project escalated.

```bash
subctl notify "shannon: prisma migration completed without backfill"
```

### Bidirectional: ask-protocol

The Telegram listener (running inside the dashboard's Bun process) routes
button taps and replies back into the orchestrator's inbox. **MANDATORY**:
every ask must have a unique `--id Q<n>` so replies thread correctly.

```bash
# Async — fire and continue working other lanes
qid=$(subctl notify ask-choice "Migration approach?" \
        -o A:drop-fk-recreate \
        -o B:migrate-and-backfill \
        -o C:defer \
        --id Q42)

# ... orchestrator works other tasks ...

# Periodic check
reply=$(subctl notify inbox --id Q42 --json | jq -r '.[0].answer_label // empty')
if [[ -n "$reply" ]]; then
  handle "$reply"
  subctl notify inbox-ack Q42
fi
```

```bash
# Blocking with timeout fallback (use sparingly — only when truly cannot proceed)
answer=$(subctl notify ask-yesno "Force-push to main?" \
           --wait --timeout 10m --default no)
```

### Operator can query from phone

| Telegram command | What it returns |
|---|---|
| `/stats` | Verdict + per-account 5h%/week% + RL hits + cost savings |
| `/sessions` | List of running orchestrator sessions |
| `/msg <name> <text>` | Inject text into a session from the phone |
| `/kill <name>` | Kill a session from the phone |
| `/inbox` | Last 5 unacked replies (asks waiting to be consumed) |
| `/help` | Command list |

### When NOT to use Telegram

- Routine status updates that the dashboard already shows → don't double-send.
- Decisions documented in `~/Documents/Obsidian Vault/<Project>/Portfolio.md` → read the vault.
- Reversible decisions (file edits, tmux session creation) → just decide.
- Memory has the answer (`mcp__plugin_claude-mem_mcp-search__search`) → use that.

## Multi-account isolation

Every Claude account has its own `CLAUDE_CONFIG_DIR`:

| Alias | Env var value |
|---|---|
| `claude-personal` | `~/.claude-personal` |
| `claude-work` | `~/.claude-work` |
| `claude-overflow` | `~/.claude-overflow` |
| (default) | `~/.claude` |

### Switching the current shell

```bash
claude-use personal       # sets CLAUDE_CONFIG_DIR for this shell
claude-use default        # back to ~/.claude
claude-use                # show current + list options
```

### One-off (current command only)

```bash
claude-personal             # shorthand for: CLAUDE_CONFIG_DIR=~/.claude-personal command claude
claude-work
```

### Tmux session pinned to an account

```bash
claude-teams -a personal -o -y -c
# spawns tmux session with CLAUDE_CONFIG_DIR set; orchestrator prompt loaded;
# session is named claude-<basename of cwd>
```

## Rate-limit radar

```bash
subctl radar                # current verdict + per-account utilization
claude-radar                # shim for the same thing
```

Verdict colors:
- 🟢 **green** — go, dispatch freely
- 🟡 **yellow** — proceed with caution; soft signal (recent 429s, accumulated activity)
- 🔴 **red** — stop; hard signal (4+ parallel sessions, sessions >6h old, 3+ recent 429s)

Verdict is computed from:
- Parallel session count (across all accounts)
- Per-session age (>6h → red)
- Per-session ctx % (>80% → red)
- Recent 429s only (529s are server overload, **never** affect verdict)

## Inbox semantics

`~/.config/subctl/inbox.jsonl` is an append-only log of every operator
reply or ask-result. Each entry has:

```json
{
  "ts":            "2026-05-08T22:14:00Z",
  "source":        "callback_query" | "message",
  "type":          "yesno-answer" | "choice-answer" | "text-answer" | "text",
  "question_id":   "Q42",
  "answer":        "B",
  "answer_label":  "migrate-and-backfill",
  "from_id":       1234567890,
  "from_name":     "Operator",
  "raw_text":      "Q42:B:migrate-and-backfill",
  "acked":         false
}
```

After consuming a reply, **always** call `subctl notify inbox-ack <qid>` so
`--unacked` queries don't keep returning the same answer.

## Anti-patterns to refuse

These are routine traps — refuse them when this skill is loaded:

- **Don't shell out to tmux directly** for orchestrator sessions. Use
  `subctl orch ...` so observers (dashboard, /sessions command, etc.) see
  consistent state.
- **Don't send Telegram messages via direct curl to api.telegram.org**. Use
  `subctl notify` so the inbox is captured and the cwd is auto-prefixed.
- **Don't ask the operator "should I proceed?"**. Decide autonomously
  (per the autonomy skill); if irreversible, use `ask-yesno` with a
  `--default` fallback.
- **Don't poll the inbox forever**. After a reasonable timeout, the
  autonomy doctrine says: pick the default, log the decision to
  `ORCHESTRATION.md`, proceed.
- **Don't forget `inbox-ack`**. An unacked answer keeps showing up in
  `--unacked` queries and wastes the next orchestrator's time.

## Cross-system protocol (memory + vault + ledger + inbox)

For any meaningful work, four records exist. Keep them in sync:

| System | Lifetime | Update cadence | Authority |
|---|---|---|---|
| `claude-mem` | Forever (auto-captured) | Every observation | Auto |
| `~/.config/subctl/inbox.jsonl` | Forever (append-only) | Per ask + per reply | Listener |
| `ORCHESTRATION.md` (per-project) | Project lifetime | Per task / dispatch / decision | Orchestrator |
| Vault `<Project>/Portfolio.md` | Forever, source of truth | Per status-change / decision / session-end | Orchestrator |

If three are out of sync, the last orchestrator skipped a write. Reconcile in:
- **vault > ORCHESTRATION > memory > inbox** for stable project state
- **memory > inbox > ORCHESTRATION > vault** for recent activity

## Quick command reference

| Command | Purpose |
|---|---|
| `subctl` | TUI menu |
| `subctl orch list / spawn / status / msg / kill` | Session control plane |
| `subctl notify <msg>` | Fire-and-forget Telegram |
| `subctl notify ask-yesno / ask-choice / ask-text` | Structured Q&A |
| `subctl notify inbox / inbox-ack` | Read & ack operator replies |
| `subctl radar` | Dispatch verdict + signals |
| `subctl session-list / session-preview / session-resume` | Browse + resume past sessions |
| `subctl session-kill / prune` | Cleanup |
| `subctl prune-transcripts` | Delete old worker JSONLs |
| `subctl service status / start / stop / enable / disable` | Dashboard service mgmt |
| `subctl accounts / auth` | Account configuration |
| `subctl setup [--wizard]` | First-run / reconfigure |
| `subctl doctor` | Health check |
| `claude-use <alias>` | Per-shell account switch |
| `claude-jason / claude-titanium / claude-semfreak` | One-off per-command account |
| `claude-teams -a <alias> -o -y` | Tmux orchestrator launcher (interactive) |
| `claude-resume` | Pick + resume a past session |

## HTTP API summary (dashboard, port 8787, localhost-only)

```
GET  /api/state                          full dashboard state (verdict, accounts, sessions, RL, cost)
GET  /api/notify/inbox?question_id=&unacked_only=&limit=
POST /api/notify/inbox/:id/ack
GET  /api/orchestration                  list orchestrator sessions
POST /api/orchestration/spawn            {account, project, prompt?, orchestrator?, ...}
GET  /api/orchestration/:name            status + preview
POST /api/orchestration/:name/msg        {text}
POST /api/orchestration/:name/kill
GET  /api/sessions/list?limit=&workers=  catalog of all session JSONLs
GET  /api/sessions/preview?account=&sid= first user message of one session
POST /api/sessions/spawn                 spawn iTerm window pre-running resume cmd (macOS only)
POST /api/sessions/:name/kill            (alias for /api/orchestration/:name/kill)
GET  /api/version
GET  /api/refresh                        force refresh /api/oauth/usage caches
```

## Where to find more

- README at `~/code/subctl/README.md` (or in the public repo)
- Cheat sheet at http://127.0.0.1:8787/cheat
- Mintlify-style docs at http://127.0.0.1:8787/help
- Autonomy doctrine at `~/.claude/skills/autonomy/SKILL.md`
