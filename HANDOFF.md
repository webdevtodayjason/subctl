# HANDOFF.md — session 2026-05-23 evening (v2.10.0 Memory Cycle Phase 4)

**Operator:** Jason Brashear
**Repo:** `webdevtodayjason/subctl` @ `/Users/sem/code/subctl`
**Branch:** `main` (no feature branches in flight)
**Main HEAD:** `54f7398` — v2.10.0 squash-merge of `feat/memory-phase4-context-slimming`
**VERSION file:** `2.10.0`
**Last tag:** `v2.10.0`
**Vault:** `/Users/sem/Documents/Obsidian Vault/Subctl/` — refreshed 2026-05-23 with v2.10.0 entries

## Quick verify (run these first on next session)

```bash
cd /Users/sem/code/subctl
git log --oneline -1                                              # expect: 54f7398 v2.10.0
git tag -l 'v*' | sort -V | tail -1                               # expect: v2.10.0
cat VERSION                                                       # expect: 2.10.0
curl -s http://127.0.0.1:8787/api/version                         # expect: {"version":"2.10.0"}
curl -s http://127.0.0.1:8788/health | jq .version                # expect: "2.10.0"
curl -s http://127.0.0.1:8745/health | jq .total_memories         # expect: 225+ (Cognee graph)
ssh sem@192.168.100.62 'curl -s http://127.0.0.1:8788/health | jq .version'  # M3 expect: "2.10.0"
```

## Three-release wave (2026-05-23)

| Tag | What | PR |
|-----|------|-----|
| **v2.9.0** | Tier 1 Consolidator — LLM-driven dedup of pending Memori candidates with operator-in-the-loop modal | #19 |
| **v2.9.1** | Provider Model Catalog Phase 3 — aggregator routing UX (OpenRouter / Bedrock-stub / Vercel / Cloudflare-stub) | #20 |
| **v2.10.0** | Memory Cycle Phase 4 — context slimming on boot + post-compact via curated Memori + Cognee graph hydration | #21 |

## v2.10.0 highlights

- New `components/master/context-hydration.ts` (461 LOC pure module): `hydrateContext` / `formatHydrationPayload` / `loadContextHydrationConfig`. Returns `{ ok: true, payload }` or `{ ok: false, error }` — Cognee failures absorbed, Memori failures surfaced with retry budget.
- `server.ts` scheduler additions: `_pendingHydrationPayload` + `_lastHydrationReqSeq` at closure scope, `scheduleHydration(reason)` helper, monotonic seq guard for async race (fast post-compact wins over slow boot). Hydration injection happens once on first prompt post-boot AND once after every `/compact` event.
- `applyHydrationOutcome(deps)` pure reducer exported from server.ts — unit-testable without standing up the daemon. Decision matrix covers ok/failed/threw × superseded/not-superseded.
- Ephemeral message guard: `_ephemeral: true` flag + `dropEphemeralMessages` / `stripEphemeralInPlace` helpers so the hydration payload doesn't persist to `agent-state.json`.
- `[memory-context-hydration]` block prepended as synthetic `role:"user"` message — visible in dashboard transcript for operator audit.
- Config at `~/.config/subctl/master/context-hydration.json` (`enabled`, `recent_curated_limit`, `cognee_limit`, `cognee_relevance_query`). Env override: `SUBCTL_CONTEXT_SLIMMING_ENABLED=0`.
- 32 tests in `context-hydration.test.ts` (22 hydrator + 10 reducer race cases). 6 CodeRabbit passes to converge.

## Fleet state

| Host | Master | Dashboard | Notes |
|---|---|---|---|
| Local Mac | v2.10.0 | v2.10.0 | Master plist now points at dev tree `/Users/sem/code/subctl` (dev tree reset to origin/main this session); dashboard at install worktree |
| M3 Ultra | v2.10.0 | v2.10.0 | Master + dashboard both at install worktree `/Users/sem/.local/lib/subctl-install`; reached via 192.168.100.62 (home) / 100.84.108.16 (Tailscale) |

## Standing rules (carry forward)

- **No public PR/merge/push** without explicit operator authorization in chat.
- **Never kill tmux by PID** — argv lies. Use `subctl team` surfaces or `tmux kill-session -t <name>`.
- **Internal tool names** (Hermes, Evy, the council) NEVER appear in user-facing marketing.
- **Cognee + Memori sidecars** bind 127.0.0.1 only.
- **HMAC secrets** never logged.
- **API keys** at `~/.api_keys` — NEVER USE WITHOUT PERMISSION.
- **Loud idle signal** at true end-of-turn: `🚨🚨🚨 ALL HANDS IDLE — AWAITING USER 🚨🚨🚨`.

## Open follow-ups (priority order)

1. **`/workflow` non-appearance investigation.** `CLAUDE_CODE_WORKFLOWS=1` rolled out via plist + zshenv + per-account profile, claude binary at 2.1.150 on both Macs, but operator does not see `/workflow` slash command on session restart. Hypothesis: feature surfaces as panel/supervisor concept (not slash command) in Claude Code 2.1.147+. Vault note `AI Docs/2026-05-23 - Claude Code workflows discovery.md` has the verification matrix.
2. **v2.10.x — per-alias 429 backoff + composite-key cache.** Deferred from v2.8.18. ~50 LOC; refactor global backoff state to `Map<alias, BackoffState>`.
3. **File `claude agents --json` bugs with Anthropic.** Ghost session + over-coarse `kind` classification (interactive vs sdk). Vault note `AI Docs/2026-05-23 - claude agents json bugs to file.md` ready-to-file body.
4. **Handoff CLI for model-switch UX.** Operator-facing model swap from CLI without dashboard. Not started.
5. **AICTX integration retry.** `pip install aictx` worked but `aictx install` crashed on RepoMap Tree-sitter EOF prompt. Needs non-interactive flag.
6. **Argus phase-decomposition architecture commit.** Vault `Argus/Architecture.md` has the appended candidate; awaits operator review.

## Cross-references

- Vault state: [[Subctl/01 - Current State]] · [[Subctl/04 - Roadmap]] · [[Subctl/07 - Initiative History]]
- Today's deliverables: [[Subctl/AI Docs/Subctl design philosophy alignment]] · [[Subctl/AI Docs/2026-05-23 - Claude Code 2.1.139 to 2.1.150 orchestration arc]] · [[Subctl/AI Docs/2026-05-23 - Claude Code workflows discovery]] · [[Subctl/AI Docs/2026-05-23 - claude agents json bugs to file]]
