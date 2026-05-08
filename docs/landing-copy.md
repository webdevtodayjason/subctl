# subctl.com — Landing-Page Copy

**Audience:** developers, AI power users, agent operators, MSP/agency owners running
multiple Claude/Codex subscriptions at scale.

**Voice:** technical, concrete, no buzzwords. Respect the reader's intelligence.
Show the receipts (numbers, commands, screenshots). No "revolutionize" / "AI-powered"
filler.

**Tone reference:** GitHub README quality, Linear-grade craft, Tailscale-style
"this is what it is, plain English."

---

## Hero section

### Headline (pick one)

**Primary (recommended):**
> **One CLI for every AI subscription you own.**

**Alternates:**
> Stop hitting rate limits. Route Claude across every account you have.
>
> Multi-account Claude. Live rate-limit radar. Operator-in-the-loop from your phone.
>
> The control plane for autonomous AI agents.

### Sub-headline

> subctl runs every Claude Code and Codex account on one machine, in isolated
> tmux sessions, with a live dashboard, a Telegram escalation channel, and
> native MCP tools. Free. Open source. Yours.

### Primary CTA

`curl -fsSL https://subctl.com/install | bash`

(Buttons: **Install** · **Documentation** · **GitHub** ★ stars)

### Hero stats strip (under the fold-line)

> **6+ accounts** managed in parallel · **0 manual switches** · **5-hour & weekly
> limits tracked** in real time · **MIT licensed** · **No telemetry, no SaaS**

---

## The problem (3-column "before subctl")

### "I hit my rate limit at 2pm and lost the rest of the day."

Anthropic's 5-hour and weekly windows aren't visible until you're already
blocked. By the time the error shows up, your session has burned context and
your work is paused.

### "I have four Claude accounts and no idea which one to use."

Switching `CLAUDE_CONFIG_DIR` by hand is a chore. Each shell needs the right
env vars. Nothing tells you which account has headroom and which one is
hours from reset.

### "My orchestrator is running and I have no idea what it's doing."

Long-running agents disappear into tmux. You leave the room, miss the prompt,
come back to find it's been blocked on a yes/no question for two hours.

---

## The solution (what subctl actually does)

> **subctl is one CLI, one dashboard, and one Telegram bot that turn N
> subscriptions and N tmux sessions into a coordinated, observable system.**

A single `subctl` command:

- Picks the freshest account automatically
- Spawns a Claude or Codex session in an isolated config dir
- Tracks the 5-hour + weekly windows live, per account
- Forwards rate-limit warnings to your phone before they bite
- Lets you talk to any running session from Telegram or another agent
- Exposes everything as MCP tools so other Claudes can drive it

---

## Features (the detailed list)

> Each feature should be a card with: **icon · short title · one paragraph ·
> "see it" link to docs**.

### 1. Multi-account isolation

Each Claude or Codex account lives in its own `~/.claude-<alias>/` directory
with its own credentials, projects, MCP config, and history. `subctl use
<alias>` flips your current shell. `subctl one-off <alias> <task>` runs a
single command in another account without touching your session. Credentials
never bleed across accounts.

**Supports:** Claude (Anthropic) · Codex (OpenAI) · easily extensible to others.

### 2. Live rate-limit radar

A persistent dashboard at `127.0.0.1:8787` shows every account's current
5-hour-window usage, weekly-window usage, and time-until-reset.
**Verdict-first design:** at a glance you see GREEN (use this), AMBER
(rotate soon), or RED (blocked, do not route here).

Optional Telegram pings when an account crosses 75% / 90% / 100%.

### 3. Orchestration control plane

`subctl orch spawn --name release-prep --account claude-personal --task "ship 2.4"`

Every session is **name-addressed**. Run seven orchestrators at once and
talk to any one of them by name from CLI, HTTP API, or Telegram:

- `subctl orch list` — see all running sessions
- `subctl orch msg release-prep "status?"` — paste a message into the session
- `subctl orch kill release-prep` — graceful tmux teardown
- `subctl orch status release-prep` — pane preview + last activity

### 4. Bidirectional Telegram channel

Bring your own bot token, run `subctl notify --setup`, and your dashboard
service starts a polling listener on a dedicated bot. From your phone:

- **Receive:** rate-limit alerts, agent questions, completion pings
- **Send:** `/stats`, `/sessions`, `/inbox`, `/msg <name> <text>`,
  `/kill <name>`, `/help`
- **Answer structured questions** with inline keyboard buttons —
  agents block on `subctl notify ask-yesno` or `ask-choice`, you tap
  Yes / No / Option-A from the bus stop.

Full conflict isolation: subctl uses **its own bot token** so it doesn't
collide with any other Telegram listener you run.

### 5. MCP server — drive subctl from inside Claude

`subctl install` registers `mcpServers.subctl` in `~/.claude/settings.json`.
Every Claude Code session — orchestrator or worker — can call:

```
mcp__subctl__stats              mcp__subctl__notify_send
mcp__subctl__orch_list          mcp__subctl__notify_ask_yesno
mcp__subctl__orch_spawn         mcp__subctl__notify_ask_choice
mcp__subctl__orch_status        mcp__subctl__notify_inbox
mcp__subctl__orch_msg           mcp__subctl__notify_inbox_ack
mcp__subctl__orch_kill          mcp__subctl__session_list
```

Twelve native tools. No shell-out, no Bash gymnastics. Agents call subctl
the same way they call any MCP server.

### 6. Autonomy doctrine for long-running agents

The hardest problem with autonomous agents isn't capability — it's knowing
**when to stop and ask** vs. **when to drive forward**.

subctl ships an **autonomy SKILL** that gets symlinked into every account's
`~/.claude/skills/`. It encodes:

- **Drive-forward standing orders** — what reversible work counts as fair game
- **Stop-on-irreversible** — what ALWAYS requires human approval
- **Memory protocol REQUIRED** — every session must read claude-mem before acting
- **Vault protocol REQUIRED** — every project state lives in your Obsidian Vault
- **Ask protocol REQUIRED** — uses `subctl notify ask-*` instead of stalling
- **Decision log format** — atomic, dated, why-not-just-what

Plug it in, your agents work harder *and* safer.

### 7. tmux-native session UX

Every spawn is a real tmux session you can attach to with `tmux a -t <name>`.
No hidden subprocesses, no daemonized work you can't see. The dashboard's
"Live preview" tab shows the last 200 lines of every running pane.

Optional `subctl-deck` Go TUI for keyboard-driven session management.

### 8. Smart defaults, full overrides

- `bun` for the dashboard (single binary, fast, low memory)
- `jq` for idempotent settings.json patches
- `tmux` for sessions
- `gum` (optional) for prettier prompts
- launchd plist auto-installed for service mode
- Everything overridable via env vars: `SUBCTL_API`, `SUBCTL_BIN`,
  `SUBCTL_CONFIG_DIR`, `SUBCTL_NO_ATTACH`, `CLAUDE_CONFIG_DIR`

### 9. Zero telemetry, zero SaaS

Everything runs **on your box, on localhost**. The dashboard binds to
`127.0.0.1:8787`. No phone-home. No account creation. No third-party
collection. Your bot token, your inbox, your data, your machine.

### 10. One-command install, one-command uninstall

```bash
git clone https://github.com/webdevtodayjason/subctl ~/code/subctl
cd ~/code/subctl && ./install.sh
```

`subctl uninstall` reverses every change cleanly.

---

## How it works (architecture diagram caption)

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code session  ──MCP─→  subctl-mcp  ──HTTP─→     │
│  Telegram bot         ──poll──→ notify-listener  ──┐    │
│  CLI / TUI            ──exec─→  bin/subctl  ──┐    │    │
│                                                ↓    ↓    │
│                                  Dashboard service       │
│                                  (Bun, 127.0.0.1:8787)   │
│                                                ↓         │
│  ┌──────────────────────────────────────────────────┐    │
│  │ tmux sessions  ·  ~/.claude-<alias>/  ·  inbox   │    │
│  │ ~/.config/subctl/  ·  rate-limit-events.log      │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

**One Bun process. One tmux server. N isolated Claude/Codex accounts.**

---

## "Built for…" section (3 personas)

### For solo developers running Claude Code daily

You hit your weekly limit and lost a day. subctl shows you the windows
live, routes new work to fresh accounts, and pings you on Telegram before
you ever see "rate_limited."

### For agent operators running 24/7 orchestration

Your agents work overnight, you sleep. They block on a yes/no question?
Your phone vibrates, you tap Yes, they continue. Memory + Vault protocols
keep them coherent across `/clear` and compaction.

### For MSPs and agencies serving multiple clients

One Claude account per client, one isolation boundary, zero credential
mixing. Spawn a session per client by name, audit the inbox, kill on
demand. All from one CLI.

---

## Quick start (3-step demo block)

```bash
# 1 — install
git clone https://github.com/webdevtodayjason/subctl ~/code/subctl
cd ~/code/subctl && ./install.sh

# 2 — set up your accounts
subctl setup --wizard

# 3 — open the dashboard
subctl dash
```

That's it. Telegram setup is optional and prompted later.

---

## Comparison table (vs. doing nothing)

|                              | Manual juggling | subctl |
|------------------------------|:---------------:|:------:|
| Multi-account isolation      | env vars by hand | ✓ automatic |
| Rate-limit visibility        | error-message only | ✓ live, per account |
| Cross-pane orchestrator chat | none | ✓ name-addressed |
| Mobile escalation            | none | ✓ Telegram |
| MCP-native for Claude        | none | ✓ 12 tools |
| Agent autonomy doctrine      | ad-hoc per session | ✓ codified, shared |
| Setup time                   | weeks of yak-shaving | 5 minutes |
| Cost                         | your time | free, MIT |

---

## Numbers / proof points (rotate as new metrics emerge)

- **6+ accounts** routinely managed in production
- **MCP server** with 12 tools, registered in `settings.json` automatically
- **Single Bun process** = ~50MB RAM for the whole control plane
- **0 telemetry, 0 phone-home, 0 third-party services**
- **MIT licensed**, public source on GitHub

---

## FAQ

**Q: Does subctl store my Anthropic / OpenAI credentials?**
No. Credentials live in each account's existing `~/.claude-<alias>/` (or
`~/.codex-<alias>/`) — exactly where the official CLIs put them. subctl
just points the right `*_CONFIG_DIR` env var at the right one.

**Q: Will it conflict with my existing Claude Code setup?**
No. Your default `~/.claude/` is treated as just another account. Existing
sessions, projects, and credentials are untouched.

**Q: Does the Telegram bot have to be the same one as another tool I run?**
No — and shouldn't be. subctl uses **its own dedicated bot token** stored
in `~/.config/subctl/notify.json`. Telegram's API only allows one
`getUpdates` poller per bot, so each automation tool needs its own.

**Q: Can I use this without Telegram?**
Yes. Telegram is opt-in. The dashboard, multi-account, orchestration, and
MCP all work without it.

**Q: Is the dashboard exposed to my LAN?**
No. It binds to `127.0.0.1:8787` only. SSH-tunnel if you want remote access.

**Q: How does subctl know my rate limits?**
It reads Anthropic's response headers + the rate-limit warning hooks
written by Claude Code into `~/.claude/rate-limit-events.log`. No API
key required for tracking.

**Q: Does it work with Claude Code on the web / Claude Desktop / IDE
extensions?**
The dashboard + Telegram surface work regardless. The MCP tools are
specific to Claude Code (CLI). IDE/web Claude reads the same
`~/.claude/settings.json` — when supported, the MCP tools become
available there too.

**Q: What does it cost?**
$0. MIT license. No SaaS, no upsell, no premium tier.

---

## Footer copy

```
subctl is open source under the MIT license.
Built by Jason Brashear · @JasonBrashearTX · jasonbrashear.com
GitHub · Documentation · Changelog · Issues
```

**Tagline candidates for the footer:**

- "Your AI subscriptions, one control plane."
- "Multi-account Claude + Codex, made sane."
- "Run more agents. Hit fewer limits. See everything."

---

## Asset list for design

- **Logo** — wordmark `subctl` (lowercase, monospaced or geometric sans).
  Suggest a small mark resembling a network hub / control surface.
- **Color palette** — terminal-friendly. Suggest:
  - Background: deep charcoal / off-black (#0E1116 or similar)
  - Accent: signal green (#00E08A) for "ready"
  - Warning: amber (#F5A623) for rate-limit pressure
  - Critical: red (#E5484D) for blocked
  - Text: warm white (#E8E8E3)
- **Hero animation** — terminal recording (asciinema-style) of the install
  + first `subctl dash` open. ~12 seconds, looping.
- **Screenshots needed**:
  1. Dashboard home (verdict + accounts grid)
  2. Telegram conversation showing `/stats` reply + ask-yesno keyboard
  3. `subctl orch list` with 4+ named sessions
  4. Claude Code session calling `mcp__subctl__stats`
- **Diagram** — the architecture block above, in actual graphics
- **OG image** — terminal-style 1200×630, "One CLI for every AI
  subscription you own." + `$ curl ... | bash`

---

## Meta tags / SEO

```html
<title>subctl — One CLI for every AI subscription you own</title>
<meta name="description" content="Open-source CLI, dashboard, and Telegram
bot for managing multiple Claude Code and Codex accounts on one machine.
Live rate-limit tracking, name-addressed orchestration, MCP tools for
agents. MIT licensed. Free.">
<meta property="og:title" content="subctl — multi-account control plane
for AI agents">
<meta property="og:description" content="Run more agents. Hit fewer
limits. See everything. Free, MIT, self-hosted.">
```

**Keywords (for content, not stuffing):** Claude Code, Codex, multi-account,
rate-limit, MCP server, autonomous agents, orchestration, tmux, Telegram bot,
self-hosted, MIT license, agent control plane, Anthropic, OpenAI.

---

## Things to NOT say

- "Revolutionary" / "game-changing" / "AI-powered"
- "10x productivity" / "boost your workflow"
- "Enterprise-grade" (let the technical details speak)
- Anything that implies subctl is a service — it's a tool you run
- Anything that suggests it works with non-Claude/Codex models out of
  the box (it doesn't yet, and pretending otherwise burns trust)

---

## One-liner pitches (for social / press)

- **9 words:** *Multi-account Claude. Live rate limits. Tap your phone.*
- **15 words:** *subctl is the open-source control plane for running multiple
  Claude accounts and autonomous agents.*
- **Tweet-length:** *Stop losing afternoons to Claude rate limits. subctl
  routes work across every account you own, shows live windows in a local
  dashboard, and pings your phone before you get blocked. Free, MIT, no
  telemetry. Install: `curl https://subctl.com/install | bash`*

---

## Versioning callout (for changelog page or hero badge)

> Currently shipping **v1.4.0** — MCP server + canonical agent skill.
> Public, MIT, no breaking changes since v1.0.

---

*This copy is the source of truth. If design wants to cut, rephrase, or
restructure, that's expected — but the feature list and FAQ should stay
factually accurate. Diff against this file before pushing copy changes.*
