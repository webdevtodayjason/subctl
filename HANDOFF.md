# HANDOFF — subctl / Evy

**Session:** 2026-05-29 (Fri) → 2026-06-01 (Mon), ~87-hour multi-day window.
**Theme:** Recover from the CodeGraph crash → clean up *how subctl runs Claude* → ship conversational Evy → repair the Telegram push-to-talk bridge.
**Companion doc:** `RESUME.md` (30-second cold-start). Vault: `Subctl-Rust/Orchestration Handoffs/2026-06-01 - Claude orchestration + conversational Evy.md`.

> Read this first if you're a fresh session. Everything below is verified as of 2026-06-01.

---

## TL;DR — what shipped

| Area | What | State |
|---|---|---|
| **Conversational Evy** (v4) | `/api/evy/chat` defaults to a natural conversation (was robotic "give me a topic / Phase 1"); `SessionMode {Conversational, Planning}`; `/plan <topic>` opens planning | **merged** subctl-rust `main` |
| **A2 — PATH-proof workers** (v4) | daemon launches `claude` workers by absolute `claude_bin`, not `command claude` | **merged** subctl-rust `main` |
| **Voice trim** (v4) | conversational prompt = ~620-token `persona/evy-voice.md`, not the full 7.3k `evy.md` | **merged** subctl-rust `main` |
| **A1 — Claude launchers** (v3) | `CLAUDE_BIN` + `~/.local/bin` wrapper scripts for `claude-jason/titanium/semfreak`; guard launches the `claude-use` account | committed on a branch + **deployed live**, NOT on main |
| **Claude install cleanup** (system) | native-only, `installMethod=native`, `~/.local/bin` first in Claude's pinned PATH; `claude update` clean | **live** |
| **Telegram bridge** (system) | `subctl-buddy` can reach `subctl` again (push-to-talk device) | **live** — operator owes a device test |
| **Shell setup** | Starship + eza + autosuggestions + syntax-highlighting + Meslo Nerd Font | **live** |

---

## Git state

- **subctl-rust** — `main` @ `5397b1a`. Worktree `~/code/subctl-rust-evy-chat` is on `main`. Branches `feat/evy-conversational-chat`, `feat/claude-bin-absolute-path`, `feat/evy-voice-trim` all merged. Local-only tags v0.5/0.7/0.8 owe a push.
- **subctl (v3, this repo)** — on `feat/claude-bin-launchers` @ `7651ffd` (`12fb595` A1 + `7651ffd` guard fix). **Local `main` is stale** (`6aa6d6d`/#47, missing #48/#49 + the LM-Studio consolidation, which live on `chore/local-ai-consolidation`). A1/guard are deployed live so there's no revert risk, but they're **not on main** — reconcile with origin via PR when fresh.

## ⚠️ The running v4 daemon is behind `main`

`com.subctl.evy-v4` (launchd, `127.0.0.1:8797`) runs the conversational-Evy **debug** binary swapped in mid-session — it has conversational mode but **not A2 or the voice trim**.

**To deploy current `main`:**
```bash
cd ~/code/subctl-rust && cargo build --release -p evy
cp ~/.local/lib/subctl-rust/evy ~/.local/lib/subctl-rust/evy.bak-$(date +%s)
cp target/release/evy ~/.local/lib/subctl-rust/evy.new && mv -f ~/.local/lib/subctl-rust/evy.new ~/.local/lib/subctl-rust/evy
launchctl kickstart -k gui/$(id -u)/com.subctl.evy-v4
```
Sessions are in-memory (Phase 7) → a restart drops them. Backup of the pre-conversational binary: `~/.local/lib/subctl-rust/evy.bak-pre-conversational`.

---

## Pick up here (priority)

1. **Conversational-Evy speed.** The trim did NOT fix the ~20s reply — that's **qwen3.5-9b's hidden `<think>` reasoning chain**, not prompt size (proven: warm tiny-prompt curl = 0.45s). Route the **conversational** SessionMode to a fast **non-reasoning** model (e.g. a Gemma instruct); keep qwen3.5-9b for **planning**. `/no_think` + `enable_thinking:false` are ignored by LM Studio for this model.
2. **Redeploy the v4 daemon** from `main` (gets A2 + trim live).
3. **Reconcile v3 `main`** + land A1/guard via the PR flow.
4. **Operator: test the push-to-talk device** (`subctl-E4C1`) to confirm Evy's back on the hardware.

Full backlog: `~/Obsidian Vault/Follow-Ups & To-Dos.md` → **Subctl / Evy (v4)** section.

---

## How to run Claude now (operator UX)

- Launch as an account: `claude-jason` · `claude-titanium` · `claude-semfreak` (wrapper scripts in `~/.local/bin`).
- Stick an account to a shell: `claude-use jason` → then plain `claude` launches as jason. `claude-use default` → master; bare `claude` then guards.
- `claude-whoami` / `claude-accounts`. `claude-teams [args]` → `subctl teams claude`.

## Gotchas / watch-outs

- **npm-global `claude` recurs** on Claude version bumps (the native auto-updater re-creates it). `npm -g uninstall @anthropic-ai/claude-code` clears it; cosmetic. `claude migrate-installer` is **removed** — use `claude install` to reconcile.
- **V3/V4 `subctl` collision**: `~/.local/bin/subctl` = V4 chat TUI (no `status`); `~/bin/subctl` = V3 (has `status --json`). Order PATH accordingly for V3 callers (subctl-buddy needs `~/bin` first).
- **Launchd daemons run on a bare PATH** (no `~/.local/bin`/`~/bin`) — declare `EnvironmentVariables.PATH` or call by absolute path. This bit `subctl-buddy` after the reboot.
- **Any total freeze → first check** `sysctl kern.num_files kern.maxfiles` (FD exhaustion). CodeGraph is **per-project only**; never launch Claude from `~/code`.

## Backups left this session (all reversible)
`~/.claude/settings.json.bak-pre-pathfix` · `~/.claude.json.bak-pre-installmethod` · `~/.zshrc.bak-pre-localbin-dedupe` · `~/.zshrc.bak-pre-starship` · `~/.config/subctl/shell-aliases.sh.bak-pre-claude-bin` · `~/Library/LaunchAgents/com.jbrashear.subctl-buddy.plist.bak-pre-pathfix` · `~/.local/lib/subctl-rust/evy.bak-pre-conversational` · per-profile `.claude.json.bak-*`.
