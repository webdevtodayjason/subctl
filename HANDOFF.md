# HANDOFF.md — session 2026-05-23 (v2.9.0 Tier 1 Consolidator)

**Operator:** Jason Brashear
**Repo:** `webdevtodayjason/subctl` @ `/Users/sem/code/subctl`
**Branch:** `main` (no feature branches in flight)
**Main HEAD:** (after this PR merges) v2.9.0 squash-merge of `feat/tier1-consolidator`
**VERSION file:** `2.9.0`
**Last tag:** `v2.9.0` (after tag is pushed)
**Vault:** `/Users/sem/Documents/Obsidian Vault/Subctl/` — refreshed 2026-05-22 21:30 CDT in prior session; new entries for v2.9.0 land at merge time

## Quick verify (run these first on next session)

```bash
cd /Users/sem/code/subctl
git log --oneline -1                                              # expect v2.9.0 squash-merge
git tag -l 'v*' | sort -V | tail -1                               # expect: v2.9.0
cat VERSION                                                       # expect: 2.9.0
curl -s http://127.0.0.1:8787/api/version                         # expect: {"version":"2.9.0"}
curl -s http://127.0.0.1:8788/health | jq .version                # expect: "2.9.0"
curl -s http://127.0.0.1:8745/health | jq .total_memories         # expect: 225 (or higher)
ls ~/Library/LaunchAgents/com.subctl.claude-mem-reaper.plist 2>&1 # expect: file not found (retired)
```

If `main HEAD` doesn't match, fetch + verify before doing anything else.

## Releases (2026-05-22 → 2026-05-23)

| Tag | What | PR | Notes |
|-----|------|-----|-------|
| **v2.8.13** | Phase 4 local backend picker (LM Studio / Ollama / oMLX) + first-boot migration | #13 | 11 CodeRabbit passes |
| **v2.8.14** | Watchdog re-classify on pane-hash change + observability | #14 | Fixes `claude-birdie` false alerts |
| **v2.8.15** | Cognee write path — Tier 3 → Tier 4 promotion ticker | #15 | **Shipped broken** (silent entity_id bug) |
| **v2.8.16** | Cognee entity_id fix | #16 | 222/222 promoted on first tick |
| **v2.8.17** | Chat dropdown enumerates enabled models + bulk toggle | #17 | Worker stalled mid-task; salvaged + finished manually |
| **v2.8.18** | API-key privacy guard + usage resilience | #18 | 8 CodeRabbit passes |
| **v2.9.0** | Tier 1 Consolidator — LLM-driven dedup of pending Tier 1 candidates | (this PR) | New `POST /memory/tier1/consolidate` endpoint + dashboard ⚗ button + modal. `text_override` on approve endpoint so consolidator-merged text wins. Operator-in-the-loop required. |

## Infrastructure work today

- **claude-mem plugin upgraded** 9.0.12 → 13.3.0 via `/plugins` slash command. Manual `bun install` required inside the 13.3.0 cache dir — upstream missing install script. New daemon PID 1317.
- **claude-mem reaper retired** (`com.subctl.claude-mem-reaper` launchd job + scripts removed). Was load-bearing for 9.0.12's retry_count bug; 13.x drops that mechanism.
- **Cognee promotion drained** 3 → 225 memories after v2.8.16 fix.
- **Tier 1 memory budget raised** 2200 → 4000 chars (`SUBCTL_MEMORY_LIMIT=4000` in master plist EnvironmentVariables). Unblocks the 63 pending Tier 1 approvals.
- **System memory recovered** 127 GB → 76 GB used (killed 545 stuck 9.0.12 claude-mem retries + a runaway `--help` loop at 99% CPU).

## Fleet status

| Host | Master | Dashboard | Network |
|------|--------|-----------|---------|
| Local | v2.8.18 ✓ | v2.8.18 ✓ | localhost |
| M3 Ultra | v2.8.18 ✓ | v2.8.18 ✓ | 192.168.100.62 (home), 100.84.108.16 (office Tailscale) |

Cognee sidecar runs LOCAL ONLY (not M3). M3's cognee-promotion stays disarmed as expected.

## Open work (priority order)

### 1. v2.9.0 smoke test — actually run the consolidator

The consolidator endpoint shipped behind operator-in-the-loop. Smoke test path:
1. Open Memory tab in dashboard
2. Click ⚗ Consolidate (LLM) button
3. Modal renders with proposal — review the consolidated set + char budget meter
4. Edit any entries inline, expand the Dropped section to spot-check
5. Click Apply — should iterate through 1 approve per merged group + N rejects for merged-from + N rejects for dropped

If anything's off, file a bug. The 63 pending candidates are the perfect test bed.

### 2. v2.8.19 — per-alias backoff + composite-key cache

Documented in v2.8.18 CHANGELOG as deferred. Lift `_usagePollBackoffUntil` from scalar to `Map<alias, BackoffState>` so a healthy alias keeps polling while a 429'd alias backs off independently. Same for `_usageLastGood` cache key (alias → alias+config_dir composite). ~50 LOC + tests.

### 3. Handoff CLI for model-switch UX

Operator explicitly named this today. `subctl model set <role> <provider> <model>` shells to master `/api/master/supervisor`. ~80 LOC in `lib/cli.sh`. Single worker, 30-45 min.

### 4. AICTX integration retry

`pip install aictx` worked. `aictx install` crashed on RepoMap Tree-sitter EOF prompt. Try `aictx install --help` for a non-interactive flag OR wrap in `script -q /dev/null aictx install` for a real TTY.

### 5. Memory cycle Phase 4 — context slimming

Deferred since 2026-05-17 Memory Init #5 waiting on real reviewer telemetry. With Cognee promotion live (222 curated → graph) the telemetry signal NOW exists. Unblocks. ~200 LOC + test surface. Single worker, 90-120 min.

### 6. Provider Model Catalog Phase 3 — aggregator routing

OpenRouter / Bedrock / Vercel / Cloudflare. ~400 LOC. Lower urgency, matrix completion.

## Known issues operator surfaced today, NOT YET fixed in code

- **M3 accounts.conf has stale openrouter row** — the sk-or-v1-d0ae21be... key was pasted as the alias. v2.8.18 ships the CLI guard + UI redaction so new ones blocked + masked. **Operator said they'd handle via the dashboard** (generate a new openrouter key, add through the web UI Secrets panel).
- **M3 usage data 429-rate-limited** — Anthropic's `/api/oauth/usage` endpoint throttles busy accounts. v2.8.18 ships stale fallback + backoff so the dashboard shows last-known data with "·stale Xm" indicator instead of blanks. Self-heals as the rate-limit lifts. Also: `claude-jason` has no `.credentials.json` on M3 — would need `subctl auth claude claude-jason` run locally on M3 to populate. Not blocking.

## Operator preferences captured this session (saved to memory)

- **Loud idle signal** — at end-of-turn when everything's idle, fire `🚨🚨🚨 ALL HANDS IDLE — AWAITING USER 🚨🚨🚨` so the operator can scan-for-it when returning to the window.
- **IN FLIGHT: framing** when work is pending — surface what's running (worker ID, CodeRabbit pass, etc.) so the operator knows whether to expect a notification or jump in.

## Lessons learned today (read these first if you're picking up cold)

These are in the vault at `/Users/sem/Documents/Obsidian Vault/Subctl/Lessons Learned/`:

1. **`2026-05-22 - Silent ticker bugs need scanned-but-empty signals`** — v2.8.15 ran "successfully" for 8 hours promoting 0 rows because `errors[]` was empty and logs gated on `scanned > 0`. Track work-attempted, not just work-succeeded.
2. **`2026-05-22 - Salvage stalled-worker output before respawning`** — chat-dropdown-fix worker stalled mid-task. `git diff --stat HEAD` showed 4 of 6 deliverables already landed. Killed worker, committed the partial work, finished the gap manually. Saved 60-90 min vs respawn.
3. **`2026-05-22 - Worker SendMessage race with idle notification`** — workers go idle after their first SendMessage, then process the next inbox message as a "status check" instead of new work. Pattern: explicit "NEW WORK — not a status check on your prior commit" framing in the first sentence breaks through.

## Active processes worth knowing

| Process | PID (last check) | Purpose |
|---|---|---|
| `com.subctl.master` (local) | check via `launchctl list \| grep com.subctl.master` | Master daemon (`:8788`) |
| `com.subctl.dashboard` (local) | check via launchctl | Dashboard daemon (`:8787`) |
| `com.subctl.cognee` (local) | check via launchctl | Cognee sidecar (`:8745`) |
| `com.subctl.memori` (local) | check via launchctl | Memori sidecar (`:8746`) |
| claude-mem worker-service daemon | PID 1317 | 13.3.0; auto-spawns when needed |

## Where the canonical docs live

- **Repo root:** this file (`HANDOFF.md`) + `CHANGELOG.md` + `VERSION` + `ORCHESTRATION.md`
- **Vault root:** `/Users/sem/Documents/Obsidian Vault/Subctl/`
  - `01 - Current State.md` (always read first; refreshed today)
  - `04 - Roadmap.md` (refreshed today)
  - `Daily Updates/2026-05-22.md` (detailed wave narrative)
  - `Orchestration Handoffs/2026-05-22-eod.md` (this handoff's vault mirror)
  - `Lessons Learned/2026-05-22 - *.md` (3 lessons, listed above)
  - `Initiatives/Tier 1 Consolidator.md` (new — operator-priority next)

## Memory system

Auto-memory at `/Users/sem/.claude/projects/-Users-sem-code-subctl/memory/`. Includes:
- `feedback_idle_signal.md` (today's addition — the loud idle signal rule)
- `accounts_inventory.md`, `feedback_advisor_first.md`, `feedback_pivot_when_wrong.md`, etc.

Check `MEMORY.md` for the full index.

claude-mem 13.3.0 actively indexing this session's observations into the persistent cross-session memory (use `mcp__plugin_claude-mem_mcp-search__*` tools to query in future sessions).

---

🚨🚨🚨 ALL HANDS IDLE — AWAITING USER 🚨🚨🚨
