# HANDOFF.md — session 2026-05-24/25 (v3.3.1 → v3.3.3 wave)

**Operator:** Jason Brashear
**Repo:** `webdevtodayjason/subctl` @ `/Users/you/code/subctl`
**Branch:** `main` (no feature branches in flight)
**Main HEAD:** `194b521` — `chore(v3.3.3): drain no-secrets gate of pre-existing false positives (#35)`
**VERSION file:** `3.3.3`
**Last tag:** `v3.3.3` (pushed to origin)
**Fleet status:** Local Mac + M3 Studio both on v3.3.3
**Vault:** `/Users/you/Documents/Obsidian Vault/Subctl/` — fully refreshed 2026-05-25 morning. `01 - Current State.md`, `Daily Updates/2026-05-25.md`, `07 - Initiative History.md`, `05 - Decisions Log.md`, `Initiatives/Kernel Fitness...md` all up to date. Two new Lessons Learned files (`2026-05-25 - Self-referential gate failure.md`, `2026-05-25 - Auto-merge plus admin-override is a deliberate workflow.md`).

---

## Quick verify (run these first on next session)

```bash
cd /Users/you/code/subctl
git log --oneline -1                                  # expect: 194b521 chore(v3.3.3): ...
git tag -l 'v*' | sort -V | tail -3                   # expect: v3.3.1 v3.3.2 v3.3.3
cat VERSION                                           # expect: 3.3.3
curl -s http://127.0.0.1:8787/api/version             # expect: {"version":"3.3.3"}
curl -s http://127.0.0.1:8787/api/evy/health | jq .ok # expect: true (v3.3.2 canonical alias)
curl -s http://127.0.0.1:8787/api/master/health | jq .ok # expect: true (legacy alias still works)
bash scripts/check-no-secrets.sh 2>&1 | tail -2       # expect: ✓ secret scan clean (modulo .orchestration/)
```

---

## What landed this session

Three patches, all shipped end-to-end (PR → merge → tag → fleet deploy → smoke test):

| Tag | PR | Story | Hits |
|---|---|---|---|
| **v3.3.1** | #33 | Kernel Fitness Phase 3 — dashboard fitness panel | +1,177 LOC: new Fitness tab, 3 read-only endpoints, fitness-api.ts + 28 tests |
| **v3.3.2** | #34 | Final v3 rename leftovers | 69 `[master]` log prefixes → `[evy]`; `/api/master/*` → `/api/evy/*` with transparent back-compat alias |
| **v3.3.3** | #35 | Drain no-secrets gate of false positives | 79 hits across 27 files swept; scanner hardened; **CI's no-secrets gate passed for the first time in months** |

---

## Important state — read before doing anything

### 1. Kernel Fitness initiative is on 30-day soak

Phase 3 (v3.3.1) shipped 2026-05-24. **Do NOT dispatch Phase 4 (scaffold extraction = v3.3.2 in the original plan, now renumbered) before 2026-06-24.** The soak lets baseline fitness data accumulate before any optimization pressure is applied — that's the whole point of the negative criterion (writer + dashboard must NOT influence the supervisor prompt path).

Reference: `Initiatives/Kernel Fitness — engagement + refiner + judge.md` in the Obsidian vault.

### 2. Version cap holds — v3.3.x patch line only

Per operator's standing rule (in memory at `feedback_version_cap.md`): all releases stay on the v3.3.x patch line (3.3.4, 3.3.5, ...) until the operator explicitly says v4. No more v3.4.0 / v3.5.0 / etc. proposals.

### 3. CI's no-secrets gate now works

After v3.3.3, the gate is clean signal. Future PRs that trip it are real findings worth investigating — **NOT** something to `--admin` merge through. If a PR fails the no-secrets gate, fix it, don't bypass it.

### 4. The `[master]` → `[evy]` rename is fully complete

Language, code identifiers, log prefixes, HTTP routes — all done. `/api/master/*` still works as a transparent alias to `/api/evy/*` (will be removed in v4.x). External consumers don't need to change anything; internal new work uses `/api/evy/*`.

### 5. CI infrastructure is occasionally slow

PR #35 spent 40+ minutes stuck on `brew install shellcheck` step (runner infrastructure issue, not code). If a future CI run looks hung past ~15 min on a non-code step, it's safe to admin-merge if the relevant checks (no-secrets, build, tests) have already passed.

---

## Open queue

| # | Work | Size | Why now |
|---|---|---|---|
| 1 | HMAC marker version negotiation | M | Worker→Evy directive HMAC needs versioning for partial-fleet upgrades. **Needs ~1 design discussion before code.** |
| 2 | OpenCode worker addition | M | Add OpenCode as worker provider alongside Claude/Codex/DeepSeek. Pattern follows existing workers. |
| 3 | gemini/minimax/zai/xai-oauth provider expansion | L | Bigger surface — multiple providers. Belongs after #2 since it shares pattern work. |
| 4 | Memory hygiene pass (task #23) | S | Address Evy's v2.8.7 audit findings. |
| 5 | v2.8.16 cognee-promotion entity_id propagation (task #41) | S | Older carry-over bug. |
| 6 | `.orchestration/` to scanner exclude list | XS | Local-only QoL — gitignored dir trips scanner locally (not in CI). Tiny one-liner patch. |
| 7 | cli.test.ts subprocess flakiness | S | Pre-existing 15-fail subprocess-timeout issue surfaced during v3.3.3 testing. Same 30/15 profile on main. |

**My recommendation:** start with #6 (literal one-liner — adds `.orchestration` to scanner's exclude-dir list, locally-clean scanner makes next dev cycle smoother), then #4 or #5 (small, mechanical). Save #1 (HMAC) for when you can sit down for the design discussion — it's not mechanical.

---

## Standing rules in effect (from memory)

These are loaded automatically but worth surfacing because they shaped a lot of this session:

- **Auto-merge validated work** — orchestrator merges PRs without asking once tests/scanner/build are green. CI no-secrets gate false positives are pre-authorized for `--admin` override; after v3.3.3 ships, this shouldn't be needed for that reason anymore.
- **Incremental releases** — one story per tag, not bundled.
- **Verify worker rebase against main numerically** — `git diff --stat origin/main..feature` before merging worker output; workers can ship regressions against stale main.
- **Monitor every worker dispatch** — workers ship silently; SendMessage replies don't reliably land. Arm a Monitor for PR-open after every dispatch.
- **Never kill tmux by PID** — argv preserved from spawning command can take down the operator's attached server.
- **Loud idle signal** — fire 🚨🚨🚨 ALL HANDS IDLE — AWAITING USER 🚨🚨🚨 at end-of-turn when truly idle; surface IN FLIGHT lines when work is pending.
- **Master plist paths** — local plist reads dev tree (`/Users/sem/code/subctl`), M3 plist reads install worktree. Deploys must update both sources on local.

---

## How to pick up where I left off

If you're starting fresh:

1. **Sanity check the fleet:** run the Quick Verify block above. If anything is off, something drifted overnight.
2. **Decide queue ordering:** #6 (scanner exclude `.orchestration`) is the lowest-friction next ship. If the operator wants a bigger story, #2 (OpenCode worker) is the next substantive feature.
3. **Don't start Phase 4 of Kernel Fitness yet** — soak window doesn't end until ~2026-06-24.

If the operator gives a specific task: just do it. The auto-merge + incremental-release pattern is humming; lean into it.

---

## Memory state

Auto-memory at `~/.claude/projects/-Users-sem-code-subctl/memory/`. New memories created/updated this session:

- `feedback_explicit_actions.md` — rewritten: orchestrator auto-merges validated work
- `feedback_incremental_releases.md` — smaller-releases rule
- `feedback_parallel_worker_rebase.md` — diff-stat verification gate
- `feedback_monitor_worker_pr.md` — workers ship silently; arm monitor
- `feedback_version_cap.md` — v3.3.x patch line only until v4

The Obsidian vault at `/Users/you/Documents/Obsidian Vault/Subctl/` has the Kernel Fitness initiative doc, but `01 - Current State.md` may be stale — refresh it from git on next session if asked for a project TLDR.

---

## Open questions (none blocking)

- None right now. Three patches shipped clean; queue is clear of dependencies; soak is just calendar time.

If anything in the Quick Verify fails on the next session start, that's the first signal to investigate — likely a daemon restart didn't take or a plist points at the wrong tree.
