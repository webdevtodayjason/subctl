# START HERE — subctl install prompt for Claude Code

**This document is a prompt.** Open Claude Code in a fresh terminal on the
Mac you want to set up, paste this entire file as your first message, and
Claude will walk you through the install end to end.

Humans skimming: jump to the "Quick install" section below for the same
steps, just in shell form.

---

## You are Claude Code installing subctl on this Mac

I am the user. You are a fresh Claude Code session, and I want you to install
[subctl](https://github.com/webdevtodayjason/subctl) on this machine, set up
the accounts I'm about to tell you about, and verify everything works. Treat
this as a multi-step operation that you'll execute by running shell commands
through your `Bash` tool. Be conservative: confirm before any irreversible
step (especially anything that edits `~/.zshrc`).

### What subctl is and why it exists

subctl is a CLI + dashboard for managing multiple Claude Max-plan accounts
on one machine without the sign-out/sign-in dance. It uses each provider's
official isolation knob — for Claude that's the `CLAUDE_CONFIG_DIR` env var.
Each account gets its own config dir like `~/.claude-jason/`, `~/.claude-work/`,
etc. Auth, sessions, plugins, settings, and rate-limit history stay
per-account. Customizations (agents, hooks, commands, output-styles, scripts,
CLAUDE.md) are symlinked from `~/.claude/` so they're shared.

It also ships a localhost dashboard (`http://127.0.0.1:8787`) showing
per-account dispatch readiness (GO/HOLD/STOP), 24h utilization sparklines,
weekly/5h reset countdowns, cost analysis (API list-price savings vs
subscription), and a /help docs page. And a tmux teams launcher: one session
per project, each pinned to a specific account, all running in parallel.

### Steps you should walk me through, in order

1. **Verify prerequisites are installed.** Required: `git`, `jq`, `tmux`,
   `bun`. Optional but recommended: `gum` (TUI), `go` (deck binary). Show me
   what's already there with `command -v <tool>` and tell me which ones I
   need to `brew install`. If `bun` is missing, the install command is
   `curl -fsSL https://bun.sh/install | bash` (it's not on Homebrew by
   default).

2. **Clone or update the repo.** Check whether `~/code/subctl` already
   exists. If yes, `cd` in and `git pull`. If no, `git clone
   https://github.com/webdevtodayjason/subctl ~/code/subctl`. Confirm the
   repo path with me before cloning anywhere else.

3. **Run the installer.** From the repo root:
   ```
   cd ~/code/subctl && ./install.sh
   ```
   The installer:
   - links the `subctl` binary + shim scripts (`claude-teams`, `claude-radar`,
     `claude-dash`, `claude-deck`, `claude-kill`) into `/usr/local/bin` (or
     `~/bin` if `/usr/local/bin` isn't writable)
   - drops a Claude Code statusline + `Stop` hook + `/dispatch-check` slash
     command into `~/.claude/`
   - generates `~/.config/subctl/shell-aliases.sh` and adds a `source`
     line to `~/.zshrc` between marker comments
   - builds the Go deck TUI (if `go` is installed)
   - asks me whether to enable the dashboard launchd service. Say yes if
     I plan to use the web UI.

   Tell me before running it. Run with `--dry-run` first if I want a
   preview.

4. **Reload my shell.** After install, run `source ~/.zshrc` (or tell me
   to open a new terminal) so the per-account aliases (`claude-<alias>`,
   `claude-use`, `claude-whoami`) become available.

5. **Add my Claude accounts.** Ask me how many accounts I want to set up
   and what to call each one. For each account, run:
   ```
   subctl accounts add claude <alias> <email> [<config-dir>] [<description>]
   ```
   Defaults: config dir = `~/.<provider>-<short-alias>`, description = blank.
   The alias should be short and shell-friendly — I'll likely type it daily
   (e.g., `claude-jason`, `claude-work`). Show me the resulting
   `~/.config/subctl/accounts.conf` after.

6. **Authenticate each account.** For each alias, run:
   ```
   subctl auth claude <alias>
   ```
   This launches Claude Code with `CLAUDE_CONFIG_DIR` set to that account's
   dir. I'll complete OAuth in my browser, then type `/exit` to return to
   you. Confirm with `subctl accounts` that each shows `ready` after.

7. **Share the customization layer.** Run:
   ```
   subctl share
   ```
   This symlinks `~/.claude/{agents,commands,hooks,output-styles,scripts,
   CLAUDE.md}` into each per-account dir so my custom agents/hooks/commands
   work under every account.

8. **Health check.** Run `subctl doctor` and walk me through the output.
   Anything yellow or red, propose a fix. The `Keychain bearers:` section
   in particular should show ✓ for every account I just authenticated.

9. **Set up project bindings (optional but useful).** If I've told you I
   work on multiple projects with different accounts, edit
   `~/.config/subctl/projects.conf` so each project lives on the right
   account:
   ```
   subctl projects edit
   ```
   Format:
   ```
   name | account_alias | project_dir | description
   ```
   Then `subctl projects status` shows them.

10. **Verify the dashboard.** If the dashboard service is enabled, open
    `http://127.0.0.1:8787` in my browser. Talk me through what each
    section shows; the **📖 Docs** link in the topbar opens the full
    reference at `/help`.

### Things to be careful about

- **Never edit `~/.zshrc` without showing me the diff first.** The
  installer writes a marker block; if you need to add something else,
  add it outside that block.
- **Don't `rm -rf` anything.** If a previous install or a stale config
  is in the way, move it aside (`mv x x.bak.$(date +%s)`) — never delete.
- **Don't commit my OAuth tokens.** They live in macOS Keychain. The
  config dirs (`~/.claude-*/`) contain `.claude.json` which has account
  metadata but no tokens, so they're safe to inspect but should not be
  pushed anywhere public.
- **If something fails partway**, run `subctl doctor` and read the
  output back to me before suggesting a fix.

### When you're done

Tell me:
- which accounts I've configured + their cfg_dirs
- whether the dashboard service is running
- the URL for the dashboard
- whether I have any pending action items (e.g., "set up projects.conf for
  the workflow you mentioned")
- the name of the help page I should bookmark (`http://127.0.0.1:8787/help`)

Then ask me what I want to work on first.

---

## Quick install (humans, no Claude needed)

If you'd rather not paste this into Claude:

```bash
# 1. prerequisites
command -v git tmux jq bun || echo "missing — brew install jq tmux git, then https://bun.sh/install"

# 2. clone + install
git clone https://github.com/webdevtodayjason/subctl ~/code/subctl
cd ~/code/subctl
./install.sh

# 3. reload shell
source ~/.zshrc

# 4. add an account (repeat per account)
subctl accounts add claude personal you@example.com
subctl auth claude personal

# 5. share customization layer + health check
subctl share
subctl doctor

# 6. (optional) declare your projects
subctl projects edit       # add: name|account|project_dir|description rows
subctl projects status

# 7. dashboard
subctl service enable      # if not already enabled by install
open http://127.0.0.1:8787
```
