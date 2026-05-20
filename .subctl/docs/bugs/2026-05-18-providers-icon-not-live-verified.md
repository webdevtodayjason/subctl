# Bug: providers/accounts list green check is file-presence only, not live-verified

Date: 2026-05-18
Project: subctl
Severity: medium — operator + Evy both make routing decisions from a signal that doesn't mean what it appears to mean.

## Trigger

Operator (Jason) observed that the dashboard's Providers / Accounts list shows `claude-jason`, `claude-titanium`, and `claude-semfreak` all with green `✓ authenticated` checkmarks ("Anthropic Claude anthropic — 3/3 authenticated"). Evy then attempted a team spawn against one of those accounts (separate from this bug — see `bugs/2026-05-18-policy-snapshot-smol-toml-spawn-blocker.md` for that incident) and the operator's intuition was that an account might have been silently broken upstream while still displaying green.

Operator asked the natural question: *does the green check actually verify the auth is currently working with Anthropic?*

## Observed behaviour

The green check is **purely a disk-state heuristic** — it does NOT make any upstream call to Anthropic, does NOT read the macOS keychain, does NOT check token expiry, does NOT check rate-limit headroom.

For a Claude account, `dashboard/server.ts:4780–4798` walks the account's `<config_dir>` and looks for either `.claude.json` or `.credentials.json` with `size > 100 bytes`. If found, the account is marked `authed: true` and renders with the green checkmark. That's the entire test.

The in-code comment is candid:

> "Keychain-only detection would require shelling out to `security find-generic-password`, which is too invasive for a hot /api/providers handler."

For an OpenAI/Codex account (`dashboard/server.ts:4799–4811`), it checks `auth.json` for a populated `tokens` object. Same shape of weakness: file presence vs. live token validity.

## Failure modes

The icon lies (false-positive green) when:

1. Token revoked or expired upstream at Anthropic, but `.claude.json` still on disk.
2. macOS keychain entry corrupted or missing while `.credentials.json` cache survives. Claude Code can sometimes recover via re-OAuth in-pane, but a spawned worker's first turn errors out.
3. Account hit a hard 5h or 7d rate-limit quota. Green icon; team spawns successfully (because tmux doesn't need Anthropic); worker boots; first real turn returns rate-limit error; from outside this looks like "spawn worked, team broken."
4. Account password changed on Anthropic side. OAuth session may be nominally valid (so the file persists) but first session-create call fails.
5. Plan downgrade or billing issue. Green; first turn returns billing-rejection.

In every case Evy (or the operator) sees a healthy-looking account, makes a routing or dispatch decision against it, and discovers the rot only at the moment of failure.

## Expected behaviour

The icon should reflect a *recent live verification* — within the last 60s — of whether the account's credentials would actually succeed against the upstream provider. Specifically:

- **Green**: live-verified successful upstream call within the last 60s. Token works, rate-limit headroom is healthy (e.g. > 50% remaining on the tightest window).
- **Yellow**: live-verified successful within the last 60s, BUT headroom is tight (e.g. 5h or 7d window between 20–50%) OR the verification is stale (60–300s old).
- **Red**: live verification failed (token rejected, account suspended, plan downgraded, etc.) OR verification has not succeeded in over 300s.

## What infrastructure already exists

The dashboard already has a real live-verification surface — `dashboard/lib/account-verdict.ts` — that computes yellow/red/green based on actual Anthropic rate-limit data fetched via `subctl usage --json`. This is what powers the Accounts tab verdict column.

The provider-list checkmark is *not* wired to it. The two surfaces disagree, and the operator (rightly) reads the checkmark as the more prominent signal.

## Suggested fix

1. **Background verification ticker** in subctl master: every 60s, for every alias in `accounts.conf`, shell out to `subctl usage --account <alias>` (or use the existing in-process pi-ai catalog probe — TBD by impl team). Record the result in master state as `account_live_check: { <alias>: { last_ok_at, last_fail_at, last_status, last_headroom_pct } }`.

2. **Dashboard `/api/providers` handler** reads from this state field instead of (or in addition to) the file-presence heuristic. The icon flips:
   - green: `now - last_ok_at < 60s` AND `last_headroom_pct > 50`
   - yellow: `now - last_ok_at < 300s` AND (`last_headroom_pct in [20,50]` OR `now - last_ok_at > 60`)
   - red: `last_fail_at > last_ok_at` OR `now - last_ok_at > 300s` OR `last_headroom_pct < 20`

3. **Tooltip on hover** showing the last check timestamp + headroom + last error if any. So the operator can see *why* an account is yellow/red without having to grep logs.

4. **Reuse account-verdict.ts logic** so the provider-list icon and the Accounts-tab verdict tell the same story. One source of truth.

## Out of scope

- Per-account session probes (spawning a real claude-code turn) — too expensive for a 60s ticker. The `subctl usage` HTTP call to Anthropic is the right granularity.
- Caching live results across master restarts — not necessary; restart re-checks within 60s.
- Multi-provider abstraction — fix Claude first, then mirror for openai-codex / xai-supergrok / etc.

## Regression coverage

- Account with valid token + healthy headroom → green.
- Account with valid token + tight headroom → yellow.
- Account with revoked token (simulate by mutating `.credentials.json` to invalid) → red.
- Account where `subctl usage` returns 429 → yellow ("verifier rate-limited"; do not mark account as failed).
- Account where the verifier ticker hasn't run yet (cold start, < 60s since boot) → yellow with explicit "verifying…" tooltip.

## Relationship to other 2026-05-18 work

- Operator (Jason) approved investigation 2026-05-18 ~20:45 local while reviewing today's spawn-blocker incident.
- Same operator-trust gap as the spawn-blocker bug (`bugs/2026-05-18-policy-snapshot-smol-toml-spawn-blocker.md`): Evy made a dispatch decision against a surface (account-authed icon / spawn endpoint) that did not surface its real state, then hit an opaque failure at execution time.
- The `team-staleness` fix (commit `4cf03ef`) addresses the dead-team side of the same class of bug. This is the dead-token / dead-quota side.

## Estimated slice size

~150–200 lines:
- ~50 lines in `components/master/server.ts` for the verifier ticker + state field.
- ~30 lines in `dashboard/server.ts` `/api/providers` handler to consume the state and apply thresholds.
- ~50 lines in `dashboard/lib/account-verdict.ts` to share logic with the existing Accounts-tab verdict path.
- ~50 lines of regression tests across the three files.
