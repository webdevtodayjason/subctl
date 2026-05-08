# subctl MCP server

Exposes subctl as a Claude Code MCP tool surface. After install, any Claude
session has access to:

- `mcp__subctl__stats` — dashboard state (verdict, accounts, RL, savings)
- `mcp__subctl__orch_list` / `_spawn` / `_status` / `_msg` / `_kill`
- `mcp__subctl__notify_send` / `_ask_yesno` / `_ask_choice`
- `mcp__subctl__notify_inbox` / `_inbox_ack`
- `mcp__subctl__session_list`

## Install

`subctl install` does both steps automatically. To do them manually:

```bash
# 1. Install the SDK dependency
cd ~/code/subctl/components/mcp
bun install

# 2. Register the MCP server in ~/.claude/settings.json (or per-account)
#    Adds an entry like:
#    "mcpServers": {
#      "subctl": {
#        "command": "bun",
#        "args": ["run", "/Users/you/code/subctl/components/mcp/server.ts"]
#      }
#    }
subctl install   # adds it for you
```

## Why MCP

`subctl orch spawn` etc. are CLI commands. Without MCP, every Claude
session that wants to use them has to shell out via Bash. That's:
- noisier in tool-call logs
- slower (subprocess startup per call)
- less discoverable (Claude has to *know* the bash command exists)

With MCP, Claude sees `subctl_orch_spawn` as a first-class tool with
typed inputs and structured outputs. Discovery is automatic; calls are
single round-trips through stdio.

## Architecture

```
Claude Code session
       ↓ (MCP stdio)
subctl-mcp (Bun process)
       ↓ (HTTP)
Dashboard service @ 127.0.0.1:8787
       ↓
tmux + Telegram + filesystem
```

Each MCP tool is a thin wrapper. No new state lives in the MCP server;
the dashboard is the single source of truth.

## Configuration

The MCP server reads:

- `SUBCTL_API` (default `http://127.0.0.1:8787`) — dashboard URL
- `SUBCTL_BIN` (default `~/code/subctl/bin/subctl`) — for shell-outs to
  notify-send / ask-protocol (the only verbs without HTTP equivalents
  yet — they shell out to the bash CLI)

These can be customized via env vars in the `mcpServers` entry if you
need to.

## Troubleshooting

**Tools don't appear in Claude Code's tool list:**
- Confirm the `mcpServers` entry exists in `~/.claude/settings.json`
- Restart Claude Code (settings.json is read at session start)
- Check `bun install` ran in `components/mcp/` (look for node_modules/)

**Tools appear but every call fails:**
- Dashboard service must be running: `subctl service status`
- Start it: `subctl service start`

**`subctl_notify_send` works but `_ask_yesno` doesn't:**
- The MCP server shells out to `bin/subctl` for these. Check `SUBCTL_BIN`
  env var or that the binary exists at the default location.
