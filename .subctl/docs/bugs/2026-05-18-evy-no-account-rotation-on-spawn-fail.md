# Bug: Evy passively reports blocked instead of rotating accounts on spawn auth failure

Date: 2026-05-18
Project: subctl
Severity: medium — operator-experience regression, blocks dispatch until manual intervention.

## Trigger

Operator (Jason) assigned Evy two parallel projects to manage with two
spawned teams (`subctl-proxy-team` on `claude-jason`; `xai-supergrok-team`
on a second claude account). Mid-execution, `claude-jason` hit an
auth-shaped failure (Anthropic OAuth needed re-completion via browser
flow — `Build something great` / `You're all set up for Claude Code`).

## Observed

Evy detected the spawn failure on `claude-jason`, correctly reported it
to the operator, and **stopped**. She did not attempt to spawn the
blocked team on `claude-titanium` or `claude-semfreak` — the other two
fully-configured claude accounts in the same provider pool. Team 2
sat blocked until the operator manually re-authed `claude-jason` and
prompted Evy to retry.

Operator's framing:

> "Evy should have gone 'oh, let me try a different account,' but she
>  didn't. She just sits there and reports that they're blocked."

## Expected behaviour

On auth-shaped spawn failures (`account_unconfigured`, `auth_expired`,
`token_revoked`, `quota_exceeded`), Evy rotates through other accounts
in the same provider pool — ordered by rate-limit headroom — before
escalating. Escalation only fires when the entire pool is exhausted,
and includes a per-account error map so the operator sees the failure
pattern, not just `blocked`.

Infrastructure failures (`spawn_failed`, `spawn_timeout`,
`policy_failure`, `template_not_found`, `missing_prompt_file`) do NOT
trigger rotation — rotating won't help those.

## Root cause

Behavioral gap, not a code bug. Evy's persona SKILL
(`components/skills/master/SKILL.md`) didn't codify an account-rotation
policy. The orchestrator-mode skill governs multi-pane coordination,
not spawn-failure recovery. Result: Evy treats the operator-specified
account as the only option and reports blocked when it fails — which
is literally correct ("the team you told me to spawn on this account
failed to spawn") but practically wrong (other accounts in the same
pool would have worked).

This compounds with two adjacent bugs:

1. **`bugs/2026-05-18-providers-icon-not-live-verified.md`** — the
   dashboard's green check is file-presence only, not live-verified.
   So Evy can't trust the icon to pre-filter the pool by which accounts
   actually work right now.
2. **`bugs/2026-05-18-policy-snapshot-smol-toml-spawn-blocker.md`**
   (fixed) — earlier incident where spawn failed for a completely
   different reason but Evy's response shape was the same: report,
   wait, don't try alternatives.

Pattern: when subctl's surface returns a structured failure, Evy's
default is *stop and report*. That's correct for some failure classes
and wrong for others. The skill update teaches her the distinction.

## Fix

Three layers — A landed in this same commit, B and C are separate slices.

### A. SKILL update (this commit)

Added `## Account-pool rotation on spawn failure` section to
`components/skills/master/SKILL.md`. Codifies:

- Which `error_kind` values trigger rotation (auth-shaped) vs do not
  (infra-shaped).
- The rotation algorithm: build pool → order by headroom → try each →
  stop on first success → escalate with structured per-account map when
  exhausted.
- Three explicit exceptions where rotation is wrong and Evy must
  escalate immediately: operator-pinned account, pool-of-one,
  cross-pool fallover.

Takes effect on Evy's next session boot (skill is in
`loaded_by_default: ["evy"]`).

### B. Spawn-handler rotation primitive (next slice, ~200 lines)

Dashboard's `/api/orchestration/spawn` grows an optional `pool: "claude"`
mode. When set, it tries the requested account first, then walks
remaining accounts in the same provider pool on auth/quota failures,
returning the eventual success OR a structured `{ok: false, attempted: [...]}`
payload describing every attempt + its `error_kind`. Evy calls it once,
gets either a healthy session or a complete failure map — no looping
logic lives in her head.

This makes (A) less necessary: when the routing is at the platform
layer, Evy's discretion isn't load-bearing. (A) becomes a fallback
narrative for the times Evy still calls plain `subctl_orch_spawn`
without the `pool` flag.

### C. Live providers-icon (separate bug doc, already filed)

`bugs/2026-05-18-providers-icon-not-live-verified.md` — once the icon
reflects live upstream verification, both (A) and (B) get truthful input
data and can pick the right account up-front instead of discovering rot
at spawn time.

## Regression coverage to add when (B) lands

- spawn pool=claude, first account hits `auth_expired`, second account
  succeeds → spawn returns success with `account: <second-alias>`.
- spawn pool=claude, all accounts hit `auth_expired` → returns
  `{ok: false, attempted: [{alias, error_kind}, ...]}`.
- spawn pool=claude, first account hits `policy_failure` (infra) →
  return immediately, do NOT rotate.
- spawn pool=claude, operator pinned via `X-Subctl-Account` and that
  account fails auth → return failure, do NOT silently rotate (rotation
  would violate the operator's explicit pin).
- spawn pool=claude, one account configured → fails → returns
  `{ok: false, attempted: [{alias, error_kind}], reason: "pool of one"}`.
