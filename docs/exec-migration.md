# Exec migration status (v2.7.0 / PR 8.5)

Tracking the migration of subctl's ~70 exec call sites to the centralized
helpers introduced in PR 8.5.

## Helpers

| Surface | Module | Functions |
|---|---|---|
| TypeScript (master daemon + dashboard) | `components/master/policy/exec.ts` (re-exported via `components/master/policy/index.ts`) | `execCommand`, `execCommandGated`, `PolicyDenied` |
| Bash (CLI + lib scripts) | `lib/exec.sh` | `subctl_exec`, `subctl_exec_gated` |

The TS gated path calls `checkCommand` in-process (no subprocess). The bash
gated path shells out to the Go `subctl-policy-check` binary built by PR 8;
both code paths share the test vector corpus from PR 5.

## Migrated — TS

| Site | Variant | Reason |
|---|---|---|
| `dashboard/server.ts:2845` (`/api/skills/import`) | `execCommand` (ungated) | EXEC_SURFACE §4e — operator-supplied repo URL goes into `subctl skills import`. Gate point belongs upstream of the spawn (URL allowlist), not at the binary call. |
| `dashboard/server.ts:3338` (`/api/projects/create` git clone) | `execCommand` (ungated) | EXEC_SURFACE §4f — operator-supplied `gitUrl`. Already argv-safe; helper adds consistent timeout/capture. |
| `dashboard/server.ts:4485` (`/api/sessions/spawn` osascript) | `execCommand` (ungated) | EXEC_SURFACE §4d — 2-layer-escape risk (osascript -e with interpolated fallbackCmd). Migration does not fix the escape concern; tracked as separate follow-up. |
| `dashboard/server.ts:4583` (`/api/orchestration/spawn`) | `execCommand` (ungated) | EXEC_SURFACE §4b — operator prompt eventually pastes into a Claude Code session. The actual gate lands in PR 10 (provider hook injection); this migration centralizes the dashboard-side spawn. |
| `dashboard/server.ts:4753` (`/api/orchestration/:name/kill`) | `execCommand` (ungated) | Session name pre-validated against live tmux. Migration is for chokepoint consistency. |

## Migrated — Bash

| Site | Variant | Reason |
|---|---|---|
| `lib/master.sh` — `launchctl bootout "$target"` | `subctl_exec` | Master daemon kick. Operator-typed CLI verb. |
| `lib/master.sh` — `launchctl bootstrap "gui/$uid" "$plist"` | `subctl_exec` | Master daemon kick (paired with bootout). |
| `lib/service.sh` — `launchctl unload` / `launchctl load -w` | `subctl_exec` | Dashboard service enable. |
| `lib/session-preview.sh` — `tmux kill-session -t "$name"` | `subctl_exec` | `subctl session-kill`. Session name pre-validated against `tmux has-session`. |

## Pending — TS (highest-value gate points)

Per EXEC_SURFACE.md §7 recommendations. Owner suggestions are PR numbers
in the v2.7.x sequence; rough sizing in (LOC).

- `dashboard/server.ts:303` — `subctl usage --json` 5-min cache refill. Sync call inside `subctlUsageFetchAll`; requires plumbing async upward. (PR 12 follow-up) (~30 LOC)
- `dashboard/server.ts:540` — `tmuxRun()` helper (the in-module tmux multiplexer). Wraps every `list-sessions`, `list-panes`, `capture-pane`, `set-buffer`, `paste-buffer`, `send-keys`. Migration must preserve the helper signature. (PR 11 dashboard work) (~120 LOC)
- `dashboard/server.ts:653/2390/2396/2775/3470/3494` — `git -C <path>` reads for project rows. Static argv; ungated. (Mechanical batch — any volunteer)
- `dashboard/server.ts:3357-3359` — `git init/add/commit` for new-project bootstrap. Ungated. (PR 11.5 alongside multi-provider HTTP refactor)
- `dashboard/server.ts:3380` — `gh repo create`. Operator-supplied name (regex-validated). Ungated. (PR 11.5)
- `dashboard/server.ts:3176/3178/3182/3433/3435/3439/4209/4211/4215` — `launchctl unload/load/start` + `pgrep` for master daemon bounce. Static. (PR 11.5)
- `dashboard/server.ts:4679-4681` — `tmux set-buffer / paste-buffer / send-keys` for `/api/orchestration/:name/msg`. EXEC_SURFACE §4c — operator text into Claude session. The right answer is a separate "tmux-prompt-into-agent" gate (HANDOFF_DIGEST §3.8); flagged for v2.8.0+.
- `components/master/server.ts:1370/1390/1407/1422/1431` — diag health probes (`coderabbit --version`, `gh auth status`, etc.). Internal. (Mechanical batch)
- `components/master/server.ts:1780/1789` — watchdog `tmux list-sessions` + `capture-pane`. Internal. (Mechanical batch)
- `components/master/tools/system.ts:22` — the lone `execSync` in master daemon. EXEC_SURFACE §4h — shell-interpolated `name`/`path`/`codeRoot`. Highest-priority migration target; needs `execSync` → `execCommand` AND argv-array refactor in the same change. (PR 11 or its own PR)
- `components/master/tools/coderabbit.ts:23` — `spawnSync(CODERABBIT_BIN, args)`. Mechanical.
- `components/master/tools/gh.ts:13` — `spawnSync("gh", args)`. Mechanical.
- `components/mcp/server.ts:57` — `spawn(SUBCTL_BIN, args)` in `subctlExec()`. MCP bridge for notify family. Mechanical.

## Pending — Bash

- `bin/subctl:411/414/417` (doctor) — `eval` of manifest argv. Out-of-scope for v2.7.0 per HANDOFF_DIGEST §3.9 (install-time, not agent-runtime). Tracked for v2.8 install-rewriter hygiene wave.
- `install.sh:62/110/124/137` — `run() { eval "$@"; }` + 3 more `eval` sites. Same out-of-scope reason.
- `lib/setup.sh:41/47/75/79` — 4× `eval` for dep-manifest. Same out-of-scope reason.
- `lib/master.sh:112/117` — `lsof | awk` + `kill -TERM/-KILL $p`. Operator-typed CLI verb only. Mechanical.
- `lib/master.sh:129-415` — many `curl` calls to master HTTP. Internal HTTP, not exec.
- `lib/update.sh:92-208` — many `git` + `bun install` + `launchctl` for self-update. (PR 12 alongside CHANGELOG bump)
- `lib/service.sh:101/115-116/122/150` — `launchctl start/stop/restart`, `exec bun`. (Mechanical)
- `lib/session-preview.sh:138/188/196` — `tmux list-sessions / has-session / display-message` read paths. (Mechanical)
- `providers/claude/auth.sh:44`, `providers/openai/auth.sh:36-212` — OAuth helper paths. Internal.
- `providers/claude/teams.sh:*` — **reserved for PR 10** (provider hook injection). Do not migrate from this side.

## Notes

- `execCommand` and `subctl_exec` are NOT a security boundary on their own.
  They are the chokepoint where future policy gating attaches. Each helper
  call still relies on the argv-array form (no `shell:true`) for shell-meta
  defense.
- `execCommandGated` / `subctl_exec_gated` ARE the security boundary. Use
  them at any site where (a) the command or a major component comes from
  operator/agent input AND (b) the site is reached by a worker that runs
  under Gated mode (per HANDOFF_DIGEST §3.1).
- New code MUST use the helpers from day one. The `spawnSync` import in
  `dashboard/server.ts` stays only because the migration is incremental;
  once the ledger is empty, remove the import.
