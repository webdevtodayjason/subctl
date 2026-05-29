# Resume Notes

> 30-second cold-start helper. Update on every pause so future-Jason (or a fresh Claude) can pick up without re-reading the world. Keep it short and CURRENT.

**Last paused:** 2026-05-28 evening CDT — Jason + Claude (Opus 4.8)
**Updated:** 2026-05-28

## The one thing to understand: TWO tracks

- **v3 — `~/code/subctl`** (bash + TypeScript): the SHIPPING line, **stable at v3.3.12**. Runs your fleet today.
- **v4 — `~/code/subctl-rust`** (Rust): the active REWRITE of Evy (ADR 0020). Feature-complete through **Phase 6 / v0.8.0**, NOT yet cut over. **Your real forward work is here.**

Two separate issues got firefought this session, don't conflate them:
- **CLI breakage** = the PATH collision: v4's Ink TUI installed at `~/.local/bin/subctl` shadows v3's `~/bin/subctl`. Fixed in v3.3.12.
- **Whole-machine hard-reboots** = NOT claude-mem, NOT RAM (swap stayed 0). Root cause: **too many concurrent LOCAL-GPU model engines on the M5 Max laptop** — oMLX (cognee's 26B) + LM Studio reload-thrash + Cotypist's per-keystroke model + Grok (new today). A year of 8–16 Claude terminals never crashed because those are cloud-API (zero GPU); the new thing was heavy local MLX inference. See "Local-AI stack" below.

## State (running / deployed / broken)

- **v3 dev tree:** VERSION 3.3.12, `main` @ `59d9302` (incl. #48 claude-use PATH fix, #49 secret-gate green).
- **v3 install tree** (`~/.local/lib/subctl-install`, serves your interactive `subctl`): @ `6aa6d6d` = **v3.3.11 — ONE release behind main.** CLI works anyway (live `~/.config/subctl/shell-aliases.sh` was regenerated directly). Sync with `subctl dashboard deploy`.
- **v4 rust:** `main` @ `0d66aa0`, tag **v0.8.0** — but **v0.5.0 / v0.7.0 / v0.8.0 are LOCAL-ONLY** (origin at v0.6.0). Owe a push.
- **Local-AI stack — CONSOLIDATED 2026-05-28 to LM Studio ONLY (single local endpoint `:1234`):**
  - **oMLX: STOPPED + DISABLED** (`brew services stop omlx`) — was a 2nd MLX engine (16 GB) on `:8000`, auto-respawning; a prime crash contributor. Don't re-enable as a standalone service.
  - **cognee:** repointed off oMLX → LM Studio `:1234`, model now **`qwen/qwen3.5-9b`** (was 26B). Durable default set in `lib/cognee.sh`.
  - **LM Studio reload-thrash DISABLED:** `unloadPreviousJITModelOnLoad`/`unloadPreviousModelOnSelect` → false in `~/.lmstudio/settings.json` (was thrash-reloading big models → cold-start hangs; Argent's own docs flag this).
  - **Cotypist: quit** (3rd local engine). Still need to flip its "Launch automatically at login" OFF.
  - **claude-mem:** on **Haiku** + `MAX_CONCURRENT_AGENTS=1` (a side-tweak; uses cloud API, was not the GPU cause).
- **Rule going forward:** LM Studio is the one local engine. Keep only the few models you need resident (cognee 9B + Argent's MiniMax when its gateway runs). Don't stack multiple big local models / engines at once. Grok is cloud — fine.
- **Daemons up:** evy-v4, evy(v3), cognee, memori, subctl dashboard, argent fleet (dashboard-api/ui, redis, db-backup — gateway was killed), tts, subctl-buddy.
- **Fleet:** local on v3.3.12 (install tree deploy pending). M3 Ultra (192.168.100.62, reachable) — version UNVERIFIED. **Offload idea for crash-proofing: run heavy local models on the M3 Studio / DGX, not the laptop.**

## Next action when you come back

**Polish the rough edges, then start web integration.** The live test PASSED (2026-05-28) — `subctl` chatted with v4 end-to-end (lm-studio backend, session persisted). Top rough edge to smooth: the **thinking-partner persona is too rigid** (replies to "hello" with "provide a topic, I can't start Phase 1") — that's the system prompt in `evy-thinking`, not a TUI bug. Then the cosmetic nits below.

## The v4 plan (agreed with operator)

1. **Finish the Ink TUI** — DONE (Tier 1+2, ~2,360 LOC on stock Ink).
2. **Test the v4 Rust daemon through it — ✅ VALIDATED 2026-05-28** — `subctl` launched, connected to daemon v0.1.0, chatted live (lm-studio, session `e055b430`, msgs persisted). The assembled loop works.
3. **Integrate it into the web frontend ← NEXT (after polish).**
4. Cut Evy over to run **solely** on v4.

### Polish list (post-validation)
- **Persona/prompt (biggest):** Evy can't hold a casual exchange — over-anchored on "give me a topic / Phase 1." Tune the thinking-partner system prompt in `evy-thinking`.
- Visual: daemon status renders twice (a `──` rule + a `· connected` line) — dedupe.
- `≤5` skill meta-block never fires (daemon sends 94/turn) — show a count or drop it.
- No markdown rendering in replies (plain `<Text>`).
- React duplicate-`key` warning at mount (`ui/chat-tui/src/chat/messages.tsx`).
- (The non-TTY "daemon: unknown" worry was a probe artifact — real run shows "daemon: running" correctly. Not a bug.)

### Post-live-test nits (known, small, do AFTER the live turn confirms the loop)
- Surface daemon errors instead of suppressing them (`ui/chat-tui/src/daemon/autostart.ts`) — assessment saw a "daemon: unknown / backend: default" first-paint despite `/health` 200.
- Fix a React duplicate-`key` warning during mount (`ui/chat-tui/src/chat/messages.tsx`, likely the 94-event skill_loaded `.map`).
- Verify the 94-skill `skill_loaded` preamble doesn't delay the first visible token.
- OUT OF SCOPE: the full Hermes UI spec (`subctl-rust-hermes-uitui/docs/hermes-uitui-spec.md`, 860 lines) is a PORT TARGET for upstream Hermes's 52k-LOC TUI — virtualization, overlay suite, tool-trail, grapheme editor, markdown render, theming, WebSocket transport. Current TUI is a deliberate subset; sufficient for testing. Don't build the spec to "finish."

## Decisions you owe

- **v3→v4 cutover:** how does v4 own `subctl` without breaking the v3 `claude-*` shims? (v3.3.12 patched the collision; the real fix is finishing the cutover.)
- Push v4 tags `v0.5.0` / `v0.7.0` / `v0.8.0` to origin?
- Deploy v3.3.12 to the install tree + M3?
- Confirm claude-mem on Haiku is good enough vs Sonnet for summaries.

## Files to open first (max 3)

1. `~/code/subctl-rust/` — Ink TUI source + Phase 6 commits (the active work).
2. `~/code/subctl-rust-hermes-uitui/` — worktree on `chore/hermes-ui-deep-research`, the Hermes UI-TUI design spec.
3. `~/.claude/projects/-Users-sem-code-subctl/memory/project_two_session_lockup.md` — tonight's lockup diagnosis + claude-mem/cognee facts.

## Anything urgent?

No P0. The hard-reboots are addressed by the local-AI consolidation above (one engine = LM Studio, oMLX off, Cotypist off, thrash off). If it recurs: it's local-GPU saturation, not RAM/claude-mem — check how many local models/engines are loaded at once (`curl -s 127.0.0.1:1234/api/v0/models`), and don't run multiple big local models concurrently. To catch it live, watch GPU from a 2nd machine over SSH: `sudo powermetrics --samplers gpu_power,thermal -i1000`. **cognee uses oMLX→now LM Studio; do NOT re-enable oMLX as a standalone service.** ArgentOS still depends on cognee, so keep cognee itself running (just on LM Studio now).

---
*This file exists because of the Floq postmortem (2026-05-07): high cold-start cost is what kills momentum on paused projects. Keep it short and current — update on every pause.*
