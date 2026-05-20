# HANDOFF.md — session 2026-05-20 (SPEC contract + WEB-216 watchdog fix)

**Operator:** Jason Brashear
**Repo:** webdevtodayjason/subctl @ `/Users/sem/code/subctl`
**Branch:** `feat/ctxpin-respect-loaded`
**Branch HEAD:** `71d6766` (WEB-216 watchdog fix)
**Branch state:** 18 commits ahead of `main`, 5 behind. **NOT pushed.**
**Master daemon:** PID 19015, restarted 21:14:23 UTC tonight with new code loaded
**Vault:** see `/Users/sem/Documents/Obsidian Vault/Subctl/` (handoffs, decisions, lessons all updated 2026-05-20)

---

## What shipped this session

| SHA | Title | Net | Tests |
|---|---|---|---|
| `a6cb6e6` | feat(directives): require SPEC block in worker directives | 4 files +143/−12 | +3 trust-marker (38/38 pass) |
| `71d6766` | fix(watchdog): WEB-216 false unresponsive alerts after worker completes | 3 files +428/−19 | +11 auto-nudge, 1 rewritten (26/26 pass) |

Both commits are local-only on `feat/ctxpin-respect-loaded`. The operator's standing rule is no push without explicit OK.

### SPEC directive contract (`a6cb6e6`)

The HMAC-signed directive marker now requires a `SPEC:` block in the body. New helper `buildSignedDirective()` in `components/master/trust-marker.ts` wraps the body with `"SPEC:\n  <indented>"` BEFORE the HMAC is computed; dashboard `/api/orchestration/<name>/msg` is the single emitter and uses it. Worker contract template in `providers/claude/teams.sh` updated to refuse markers without SPEC with the exact reply `"directive missing SPEC block; re-send with embedded spec"`.

Triggered by an in-flight observation: the `richard-dashboard-search` worker correctly refused a "submit the pasted prompt and start" directive because the paste-then-start delivery dropped the body. HMAC proves WHO; SPEC proves WHAT. A signed marker with no SPEC is a contract violation, not a hint.

### WEB-216 watchdog fix (`71d6766`)

Linear: https://linear.app/webdevtoday/issue/WEB-216

Three bugs, one symptom — `claude-richard-dash` was answering nudges but watchdog kept firing 🚨 unresponsive alerts at 61 and 91 min idle.

1. `if (sendResult.ok) state.set(...)` in `runStaleTeamSweep` — don't advance `last_nudge_at_ms` when nudge delivery fails (Claude API 529 / dashboard 5xx). Sweep cadence IS the backoff.
2. New `classifyWorkerReply(text)` in `auto-nudge.ts` → `{ kind: "working" | "completed_idle" | "awaiting_input" | "blocked", snippet }`. Phrases: `idle by design`, `awaiting next directive`, `awaiting shutdown`, `checklist complete`, `done with the task`, etc.
3. `decideTeamAction` short-circuits stale teams classified `completed_idle` or `awaiting_input` BEFORE the first-nudge/escalate branches. New `SweepActionKind` entries with same names. `runStaleTeamSweep` clears any prior nudge state and `logDecision`s at low severity instead of paging Telegram.
4. Inbox tail + boot-scan + pane-bump in `components/master/server.ts` all wire classification through. `TeamSnapshot.classification?: ClassifiedReply` carries to the sweep.
5. Alert body shows `Reply classification: <kind>` + `Last reply snippet: <snippet>` instead of `Last event: unknown`.

**Live-validated.** The 22:14:23 UTC watchdog sweep on `claude-richard-dash` wrote the first `team_completed_idle` decision in production:

```json
{
  "ts": "2026-05-20T22:14:23.247Z",
  "project": "claude-richard-dash",
  "action": "team_completed_idle",
  "rationale": "team idle 39min but classified as completed_idle from reply text: \"…Not stuck, not working. Idle by design. The redeploy-prep checklist is complete; awaiting next directive or shutdown.\""
}
```

The same team had been firing `team_unresponsive` every ~30 min for 4 hours before tonight's restart. Linear comment posted with full AC mapping; awaiting Evy review before close.

---

## Master daemon status

| Service | Status |
|---|---|
| `com.subctl.master` PID 19015 | up since 21:14:23 UTC, new code loaded |
| MCP server | armed at `:8788/mcp`, discovery `/.well-known/mcp`, tools = ping + state_snapshot + notify |
| team-staleness watchdog | armed, 30m interval, 15m threshold |
| upstream-check watchdog | armed, 6h interval |
| cognition-loop watchdog | armed, 60s interval (Memory Init #7, live since 2026-05-19) |
| idle-pane watchdog | armed, 30s interval, notify-only |
| memory-kernel reviewer | armed, 5min interval, model=lmstudio/gemma-4-26b-a4b-it-mlx |
| cognee sidecar :8745 | reachable (v0.2.0-subctl) |
| memori sidecar :8746 | reachable (v0.1.0-subctl, sqlite) |
| Telegram bot | @Semfreakbot listening |

Restart command for next time (already used tonight):

```bash
launchctl kickstart -k gui/$(id -u)/com.subctl.master
```

---

## Where to pick up next session

### Immediate (operator-blocked)

1. **Evy's review on WEB-216.** Once she signs off, close the Linear issue.
2. **Push `feat/ctxpin-respect-loaded` to origin** — requires explicit operator OK per the standing "no push without auth" rule. 18 commits locally, including tonight's two.
3. **Merge `main` into the branch.** Branch is 5 commits behind. Resolve any conflicts before PR.

### Loose ends (uncommitted in the working tree)

1. **xAI OAuth feature — ~1,493 LOC + 4 test files + decision doc, all uncommitted.** Files in tree:
   - `components/master/xai-oauth.ts` (894 LOC)
   - `components/master/xai-oauth-auth.ts` (386 LOC)
   - `components/master/cli/xai-oauth-login.ts` (112 LOC)
   - `providers/xai-oauth/auth.sh` (101 LOC)
   - 4 test files in `components/master/__tests__/`
   - `.subctl/docs/decisions/xai-supergrok-impl.md`

   Already wired into `pi-ai-catalog.ts` (`SUBCTL_ONLY_PROVIDERS = ["xai-oauth"]`). Needs a dedicated commit session: probably 1-2 logical commits (feature + tests + CLI + decision doc + manifest).

2. **`dashboard/public/update-modal.js` (343 LOC, untracked).** Task #17 (`be323fe`) is marked done. Either this was shipped as inline-script and the file is unrelated, or it was accidentally never staged. Verify.

3. **Doc files untracked alongside their features:**
   - `.subctl/docs/consciousness-loop/SPEC.md`
   - `.subctl/docs/decisions/subctl-proxy-v0.1.md`
   - `.subctl/docs/decisions/xai-supergrok-impl.md`
   - `.subctl/docs/handoffs/2026-05-19-idle-pane-watchdog-and-29.md`
   - `.subctl/docs/incidents/2026-05-18-hmac-directive-refusal.md`
   - `.subctl/docs/memory-init/007-evy-cognition-loop.md`
   - `.subctl/docs/bugs/2026-05-18-providers-icon-not-live-verified.md`

4. **Modified files awaiting decision:** `HANDOFF.md` (this file — about to land), `bin/subctl`, `lib/cli.sh`, `install.sh`, `lib/dep-manifest.json`, `components/master/pi-ai-catalog.ts`, `.subctl/docs/decisions.jsonl`. Most appear xAI-related.

### Open tasks (in tracker)

| # | Task |
|---|---|
| 12 | AICTX worker continuity integration. AICTX installed globally via `pip install aictx`; `aictx install` crashed on RepoMap Tree-sitter interactive prompt with EOF. Retry interactively or find the bypass flag. |
| 13 | Handoff CLI integration for model-switch UX |
| 23 | Memory hygiene pass — Evy's v2.8.7 audit findings (Evy-owned) |
| 26 | MCP-Expose #3 — resources + subscriptions (transcript, decisions, kernel cycles, teams, notifications) |
| 27 | MCP-Expose #4 — operator setup docs (Claude Desktop + ArgentOS + dev session) |

### Strategic input from Hermes/GPT-5.5

The operator brought back outside positioning feedback. Captured in `/Users/sem/Documents/Obsidian Vault/Subctl/design/2026-05-20-hermes-strategic-feedback.md`. Headline: subctl is "product-shaped" now, the next move is polish over more features.

Top six (Hermes's prioritization):
1. Fix docs/version drift (site / README / CHANGELOG / install output / VERSION file all agree)
2. Sharpen landing page (one-liner / pain / demo / install / why local-subscription-based)
3. First-10-min magic install → auth → spawn → see worker → message
4. Canonical "3 agents overnight" hero demo
5. Name the primitives publicly (Master / Workers / Memory / Verifier / Watchdog / Provider accounts)
6. Memori/Cognee internals BEHIND advanced docs, not in headlines

This is a separate work track from the feature backlog. Interleave or prioritize as operator wishes.

---

## Test status

| Suite | Status |
|---|---|
| `components/master/__tests__/trust-marker.test.ts` | 38/38 pass |
| `components/master/__tests__/auto-nudge.test.ts` | 26/26 pass |
| Full master suite | 1358 pass / 11 fail / 2 skip — the 11 fails are pre-existing env-pollution (`LMSTUDIO_API_TOKEN` / `TINYFISH_API_KEY` / `LINEAR_API_KEY` / `FIRECRAWL_API_KEY` are set in shell when tests expect them unset). NOT subctl-master code bugs. |

---

## How to refresh this handoff

```bash
cd /Users/sem/code/subctl
git status --short                                                  # what's modified
git log --oneline -3                                                # last 3 commits on branch
git log --oneline main..HEAD                                        # how far ahead of main
launchctl print gui/$(id -u)/com.subctl.master | head -5            # daemon state
curl -s http://127.0.0.1:8788/health | jq                           # master health
tail -3 ~/.config/subctl/master/decisions.jsonl                     # latest watchdog decisions
```

For the vault:

```bash
cd "/Users/sem/Documents/Obsidian Vault/Subctl"
cat "01 - Current State.md"                                         # source of truth
ls "Daily Updates/" | tail -3                                       # most recent days
ls "Orchestration Handoffs/" | tail -3                              # most recent handoffs
```

---

## Cross-references (vault)

- `01 - Current State.md` — refreshed snapshot
- `Daily Updates/2026-05-20.md` — full per-fix breakdown
- `Orchestration Handoffs/2026-05-20-spec-contract-and-web216.md` — next-session handoff (vault copy)
- `05 - Decisions Log.md` — two new entries for tonight
- `07 - Initiative History.md` — wave entry added
- `Lessons Learned/2026-05-20 - HMAC proves who SPEC proves what.md`
- `Lessons Learned/2026-05-20 - Restart daemon to load code changes.md`
- `design/2026-05-20-hermes-strategic-feedback.md`

## Memory (claude-mem)

New memory saved tonight at `/Users/sem/.claude/projects/-Users-sem-code-subctl/memory/feedback_directive_embed_spec.md` (indexed in `MEMORY.md`): Evy's HMAC-signed directives must embed the SPEC body inline, never rely on a prior paste landing.
