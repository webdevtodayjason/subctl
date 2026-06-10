# HANDOFF — subctl / Evy

**Session:** 2026-06-09 (gap analysis — supersedes the 06-02 handoff, which predated the Fork A deploy and the Phase 2 push).
**Companion docs:** vault `Subctl-Rust/01 - Current State.md` · `Subctl-Rust/04 - Roadmap.md` (7 cutover criteria) · `Subctl-Rust/Initiatives/2026-06-04 - v4 full cutover (every-panel parity).md` · cutover test report `subctl-rust crates/evy/tests/cutover/REPORT.md`.

> Verified live (curl + git + auth.json inspection) 2026-06-09. Read this first if you're a fresh session.

---

## TL;DR — where we actually are

The launch gate is the **7 cutover criteria** (vault Roadmap). **ALL 7 GREEN as of 2026-06-09 8:24 PM — THE GATE IS PASSED.** v4 is launched as the operator console. Everything through Phase 2 of the full cutover is merged + deployed. Remaining work is the every-panel-parity tail (Phases 3–7), not the gate.

| Criterion | Status (live-verified 06-09) |
|---|---|
| #1 claude+codex spawn | **GREEN both halves.** Claude live (`8fbceb2`). Codex live-verified 06-09 after operator `codex login` ×2: native spawn on openai-jason → authenticated boot (gpt-5.5) → computed `4205` → native captures → native kill → registry drained. Caveat: the automated mandate paste was eaten by codex's directory-trust prompt (manual delivery used for the proof) — small slice open in the closet (`codex.rs` ready/trust handling) |
| #2 policy vectors | **GREEN** — 134 tests + 76 cross-language vectors |
| #3 HMAC trust marker | **GREEN** — byte-for-byte golden fixtures vs v3 |
| #4 dashboard console | **GREEN** — v4 `:8797` is the browser front door (Phase 0), Overview native (Phase 1) |
| #5 scheduler real cron job | **GREEN, live (06-09, `94c4a32`)** — InvokeShell real, `jobs.toml` boot loader landed; `usage-snapshot` job (hourly, min 7 UTC) fired live (run row Succeeded, snapshot artifact) and survived restart (`unchanged: 1`). Nit in closet: replacing a job definition wipes its run history |
| #6 telegram ask path | **GREEN, live (06-09 8:24 PM)** — v3 listener disarmed (creds at `evy-notify.json.v3-disabled`), v4 owns the bot. `POST /api/evy/notify`+`/api/evy/ask` (`ef26db4`); plain-message-resolves-lone-ask fallback (`3b2abef`, live finding: operator types plain messages). Live round-trip: ask → operator typed "Got it!" → `{ok:true, reply}` |
| #7 e2e workflow no-fallback | **GREEN, rigorous** — live worker computed `4321` via native spawn+captures, zero v3 fallback (06-06) |

## Live topology (all healthy as of 06-09)

| Port | Service | Notes |
|---|---|---|
| `:8797` | v4 Rust daemon (`com.subctl.evy-v4`) | browser front door; binary deployed 06-09 = current `main` (`94c4a32`) |
| `:8787` | v3 Bun dashboard (`com.subctl.dashboard`) | BFF/proxy target; Fork A bridge intact |
| `:8788` | v3 master (`com.subctl.evy`) | still authoritative: teams UI data, telegram, providers, voice |
| `:8789` | TTS | v3 |

## Git state

- **subctl:** `origin/main` = local `main` = `feat/v4-web-frontend-integration` = `48123b2` (bridge merged; the feature branch is fully landed — safe to switch back to `main`). VERSION `3.3.12`, last tag `v3.3.12`. Untracked: `.mcp.json`, `CLAUDE.md` (CodeGraph opt-in — intentional, decide whether to commit).
- **subctl-rust:** `main` = `origin/main` = `94c4a32`. Work happens in worktree `~/code/subctl-rust-evy-chat`. ⚠️ The base checkout `~/code/subctl-rust` sits on stale branch `feat/evy-persona-conversational-mode` (ahead 1: `d5554ce` Evy-persona vendor commit — merge or drop). Tag `v0.8.0` local-only.

## Launch sequence (gap-ordered)

1. ~~Operator codex re-auth~~ **DONE 06-09** — criterion #1 fully green (see table). Remaining codex nit: trust-prompt directive delivery (closet).
2. ~~Criterion #5 slice~~ **DONE 06-09** (`94c4a32`, live-verified — see table).
3. ~~Criterion #6 flip~~ **DONE 06-09 evening** (see table) — last step: one live ask round-trip (operator reply). Known cost: v3 alert-pushes dark until something calls v4 `/api/evy/notify` (follow-up #8 remainder, in closet).
4. ~~Declare the gate~~ **GATE PASSED 2026-06-09 8:24 PM** — all 7 criteria live-green. v4 is launched as the operator console.
5. **Full every-panel parity tail (operator's 06-04 expanded scope):** Phase 2 leftovers (projects CRUD, sessions list/preview, watchdog diag — all proxied today, nothing broken) → Phases 3–6 (chat/models/memory panels native, each XL/L) → Phase 7 retire v3 Bun + master.

## Gotchas (carried forward, still true)

- **CI gate for subctl-rust** = `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` (NOT `cargo check`).
- **launchd PATH is bare** — absolute bins only (`tmux_bin()` precedent).
- **If you touch `.github/workflows/ci.yml`** (subctl): keep `bin/subctl` out of the shellcheck `-x` batch; keep the dashboard `bun install` step.
- v4 chat needs the model pin (`gemma-4-26b-a4b-it-mlx` in `~/.config/subctl/v4/config.toml`) — already in place.
- Any total freeze → `sysctl kern.num_files kern.maxfiles` first.

## Closet entries added 2026-06-09

Criterion #5 live-hollow · criterion #6 not-live · stale `~/code/subctl-rust` checkout — see `Follow-Ups & To-Dos.md § subctl-rust v4 cutover`.
