# Handoff: fix `subctl_orch_spawn_template` 500

**Status: RESOLVED** (2026-05-18)

Both layers of the fix landed on `main`:
- `e5fbe34 fix(dashboard): classify subctl orch spawn errors so master can recover`
- `ff245ab test(orch): regression coverage for subctl-orch-tool error surfacing`

Combined: dashboard now returns 4xx with `error_kind` discriminator for user errors (template not found, account unconfigured, missing prompt file); master tool client propagates the structured body instead of opaque `HTTP 500`. 13 regression tests pass.

Live verification confirmed `template not found → HTTP 404 error_kind=template_not_found` (was HTTP 500). No regression on existing 4xx paths.

**Operator action required**: the prod launchd dashboard (`com.subctl.dashboard`) still runs the pre-fix binary at `~/.local/lib/subctl-install/`. Re-run the installer or copy the patched files to make the fix live; restart `com.subctl.dashboard` + `com.subctl.master` to pick up the new behavior.

Detail below preserved for historical record.

---

Date: 2026-05-18
Operator: Jason
Project: `/Users/sem/code/subctl`

## Trigger

Evy attempted to spawn a worker using `subctl_orch_spawn_template` for an installer comparison task. The template spawn returned HTTP 500. Evy fell back to raw `subctl_orch_spawn`, which worked.

Jason requested a fix and a handoff for the other Claude orchestration to see.

## Desired outcome

Fix the `subctl_orch_spawn_template` path so template-based worker creation no longer returns 500. Add a regression test or focused verification path if the repo has an existing test harness for this surface.

Do **not** push or merge without operator approval.

## Known context

- Current subctl repo state from desk check:
  - Path: `/Users/sem/code/subctl`
  - Branch: `feat/ctxpin-respect-loaded`
  - Ahead origin: 10
  - Behind origin: 0
  - Dirty: true
  - Last commit: `8c66176 feat(memori): review-state tracking + curated promotion endpoints (Memory Init #5 Worker A)`
- Rate-limit healthiest account at handoff time: `claude-jason`.
- The raw spawn path worked after the template path failed, so the likely bug is in template resolution, template prompt assembly, request validation, or API handler error handling rather than tmux/session creation generally.

## Log excerpt around the incident

Recent master log did not include the full 500 stack in the last 120 lines, but it does show the surrounding sequence:

```text
[master] telegram inbound from Jason: Yeah, go ahead and spawn a team. I think this is a good exercise for that.
[master] compact-warn (jit): current 39995 tok >= warn_tokens 25000 (auto-compact fires at 40000)
...
[master] caught SIGTERM, shutting down
[master] booting subctl master v2.8.6
...
[master] agent ready — supervisor=openai-codex/gpt-5.5, tools=81, transcript=92 msgs
...
[master] safety-net compact ok — archived 86, kept 7
[master] caught SIGTERM, shutting down
[master] booting subctl master v2.8.6
...
[master] agent ready — supervisor=openai-codex/gpt-5.5, tools=81, transcript=6 msgs
...
[master] telegram inbound from Jason: Is there a way you can create a fix for the 500 error and then create a handoff
```

Also present and likely unrelated unless logs say otherwise:

```text
[memory-kernel-reviewer] llmFetcher failed: callSupervisor: baseUrl is required
```

## Suggested investigation path

1. Reproduce the failing path locally with the same template name used by Evy: likely `code-review` or equivalent saved team template.
2. Find the implementation for the `subctl_orch_spawn_template` tool/route.
3. Confirm template file loading from `~/.config/subctl/master/team-templates/<template>.json`:
   - missing file handling
   - JSON parse errors
   - required fields validation
   - prompt layering
   - account/project propagation
4. Compare against raw `subctl_orch_spawn`, which succeeded.
5. Replace generic 500s with actionable errors where appropriate, but preserve supervisor-facing tool contract.
6. Add regression coverage if there is an existing test pattern for tool handlers or orchestration routes.
7. Leave a short implementation note in this handoff or a sibling note when done.

## Coordination note for installer-comparison orchestra

Another worker may be running a read-only installer comparison between:

- subCTL: `/Users/sem/code/subctl`
- Hermes: `/Users/sem/code/hermes-agent`

This 500 fix is separate. Avoid disturbing their working tree if they are in the same repo. Check `git status` before editing and preserve existing uncommitted changes.

---

## Resolution (2026-05-18, claude-subctl worker)

> **Convergence note.** A parallel session (`mem-kernel-integration`) independently
> diagnosed and fixed this issue mid-investigation and committed `e5fbe34
> fix(dashboard): classify subctl orch spawn errors so master can recover`
> at 22:04 local. I arrived at byte-identical fixes in the same three files
> (`dashboard/lib/spawn-errors.ts`, `dashboard/server.ts`,
> `components/master/tools/subctl-orch.ts`) plus the same 10-case
> classifier test. Two independent paths converging on the same design is
> strong signal the diagnosis below is correct. My *additional* contribution
> on top of `e5fbe34`: `components/master/__tests__/subctl-orch-tool.test.ts`
> — 3 cases pinning that the master tool client propagates the dashboard's
> structured error body, falls back to raw text for non-JSON, and doesn't
> throw on success. The parallel commit only covered the dashboard side.

### Reproduction

```
$ curl -sS -X POST http://127.0.0.1:8787/api/orchestration/spawn \
    -H 'Content-Type: application/json' \
    -d '{"template":"code-review","account":"claude-jason","project":"/Users/sem/code/subctl","prompt":""}'
{"ok":false,"error":" ✗ team template not found: /Users/sem/.config/subctl/master/team-templates/code-review.json\n"}
[HTTP 500]
```

`~/.config/subctl/master/team-templates/` doesn't even exist on this host — so *any* template name produces this failure path. But that's the trigger, not the bug.

### Root cause (two layers)

1. **Dashboard maps every non-zero `subctl teams claude` exit to HTTP 500** (`dashboard/server.ts` `/api/orchestration/spawn` handler). User errors that the bash script flags via `subctl_die` (template missing, account unconfigured, prompt file missing) are indistinguishable from genuine infra failures. The supervisor (Evy) can't tell "fix your input" apart from "server is broken" and reasonably abandons the path.
2. **Master tool client throws away the response body.** `apiPost`/`apiGet` in `components/master/tools/subctl-orch.ts` only included `HTTP <status>` in their thrown error. Even when the dashboard returned a useful JSON body, the supervisor never saw it.

Net effect: `subctl_orch_spawn_template` looked like a generic server crash for what was actually a config-shaped error ("you haven't installed any templates yet" or "you typo'd the template name"). The supervisor fell back to raw spawn and the template surface stayed dark.

### Fix

- **New module `dashboard/lib/spawn-errors.ts`** — pure `classifySpawnError({stderr, stdout, timedOut})` → `{status, kind, error}`. Recognizes:
  - `team template not found` → `404 template_not_found`
  - `unknown account` / `not in accounts.conf` → `404 unknown_account`
  - `has no config directory` → `412 account_unconfigured`
  - `prompt file not found` → `404 missing_prompt_file`
  - `policy: …` → `500 policy_failure` (kept as 500 — it's our infra)
  - timed out → `504 spawn_timeout`
  - everything else → `500 spawn_failed`
- **`dashboard/server.ts`** `/api/orchestration/spawn` handler now calls the classifier on non-zero exit and returns `{ok, error, error_kind}` with the right status code.
- **`components/master/tools/subctl-orch.ts`** `apiPost`/`apiGet` now read the response body on failure and include it in the thrown error: `subctl /api/orchestration/spawn → HTTP 404: template_not_found: ✗ team template not found: …`. The supervisor sees the kind tag and the cause and can route accordingly (escalate to operator vs. fix input vs. retry).

### Files changed

Already on HEAD via `e5fbe34` (parallel session):

- `dashboard/lib/spawn-errors.ts` — new
- `dashboard/server.ts` — `+5 -2` (import + 5-line handler swap at the 500 site)
- `components/master/tools/subctl-orch.ts` — `+35 -2` (added `describeFailure`, swapped both throw sites)
- `dashboard/__tests__/spawn-errors.test.ts` — new, 10 cases

Net-new from this session (untracked, awaiting operator review before commit):

- `components/master/__tests__/subctl-orch-tool.test.ts` — 3 cases pinning the master-tool client side of the fix.

### Tests

```
$ bun test components/master/__tests__/subctl-orch-tool.test.ts dashboard/__tests__/spawn-errors.test.ts
13 pass / 0 fail / 30 expect() calls
```

- `dashboard/__tests__/spawn-errors.test.ts` (HEAD) — every pattern + case-insensitivity + truncation + timeout shortcircuit + empty-output fallback. 10/10 pass.
- `components/master/__tests__/subctl-orch-tool.test.ts` (untracked) — stubs `fetch`: JSON error body propagates with `error_kind`; non-JSON body falls back to raw text; 200 still returns cleanly. 3/3 pass.

### Verification

Booted the repo dashboard on port 18799 (the prod launchd job runs the installed copy at `~/.local/lib/subctl-install/dashboard/server.ts` — left untouched per "no push") with the post-fix code and re-ran the original failing curl:

```
template not found     → HTTP 404, error_kind=template_not_found  (was HTTP 500)
unknown account        → HTTP 404, "unknown account: nobody-here" (unchanged — pre-shellout gate)
missing project dir    → HTTP 404, "project dir not found: …"     (unchanged)
missing required field → HTTP 400, "account + project required"   (unchanged)
```

Live body for the template-not-found path now carries the discriminator the supervisor needs:

```json
{
  "ok": false,
  "error": "✗ team template not found: /Users/sem/.config/subctl/master/team-templates/code-review.json\n…",
  "error_kind": "template_not_found"
}
```

No regression on the existing 4xx paths. The 500 is gone for the template-not-found case.

### Out of scope (deliberately)

- **Seeding default templates.** `~/.config/subctl/master/team-templates/` is empty on this host. The right fix is `subctl templates init` or similar, not silently fabricating templates inside this handler. The 404 + descriptive body should make the operator/supervisor want to fix that.
- **Master server dirty changes.** `components/master/server.ts`, `lib/cli.sh`, `ORCHESTRATION.md`, the memory-kernel untracked files — all preserved untouched.
- **Pushing to the installed dashboard.** Per "no push", the launchd job at `com.subctl.dashboard` still runs the pre-fix binary. Once Jason green-lights, deploy the repo copy or kill+restart launchd; until then, the prod surface is unchanged.

### Operator action item

After approval: copy `dashboard/lib/spawn-errors.ts`, the `dashboard/server.ts` patch, and the master-tool patch into the installed `~/.local/lib/subctl-install/` tree (or re-run the installer) and restart `com.subctl.dashboard`. The master daemon (`com.subctl.master`) also needs a restart to pick up the new `subctl-orch.ts` apiPost behavior.
