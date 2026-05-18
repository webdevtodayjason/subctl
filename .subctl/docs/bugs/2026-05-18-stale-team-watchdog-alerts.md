# BUG: team-staleness watchdog keeps alerting on deleted tmux sessions

## Status
Open

## Severity
Medium. Produces noisy repeated Telegram alerts and wastes operator attention. Could also waste rate-limit if auto-nudges target dead sessions.

## Observed
After `claude-hermes-agent` and `claude-subctl` tmux sessions were gone, Telegram still emitted unresponsive alerts:

- `claude-hermes-agent unresponsive (30min since nudge)`
- `claude-subctl unresponsive (30min since nudge)`

`subctl_orch_list` showed no active orchestrations.

`system_watchdog_self` showed `team-staleness` still watching both teams with `tmux_session_exists: false`:

- `claude-hermes-agent`, last_seen `2026-05-18T03:23:54.117Z`
- `claude-subctl`, last_seen `2026-05-18T02:56:43.975Z`

Last fire reason:

```text
claude-hermes-agent (614min, action=escalate), claude-subctl (641min, action=escalate)
```

## Immediate mitigation applied
Killed watchdog id `team-staleness` via `watchdog_kill` to stop the stale alert loop.

## Expected behaviour
The team-staleness watchdog should stop watching a team when its tmux session no longer exists, or mark it terminal and stop escalating.

It should not send unresponsive alerts for missing sessions.

When a team is intentionally shut down via `subctl_orch_kill`, watchdog tracking for that team must be removed as part of the same teardown path. The operator expectation is: if the team is shut down, that team's watchdog/nudge loop shuts down too.

If the system supports per-team watchdog registration in the future, spawning a team may register that team for monitoring, but killing the team must unregister it in the same lifecycle transaction.

## Suggested fix
In the team-staleness watchdog and orchestration lifecycle:

1. On team spawn:
   - register the team for staleness monitoring only if the `team-staleness` watchdog is running.
   - ensure missing watchdog state is visible, not silently assumed.
2. On `subctl_orch_kill` / intentional teardown:
   - remove that team from the watched set immediately.
   - suppress any pending nudge/escalation for that team.
3. On each watchdog tick:
   - check whether the watched tmux session exists before nudging/escalating.
   - if missing, remove it from the watched set or mark terminal/missing and suppress future alerts.
4. Emit one low-noise dashboard event such as:
   - `Stopped watching claude-subctl: tmux session no longer exists`.
5. Do not Telegram-alert repeatedly for already-missing sessions.
6. Add regression coverage for:
   - watched team exists and is stale: alert/nudge as today
   - watched team tmux missing: remove/suppress
   - killed team does not remain in watcher registry after `subctl_orch_kill`
   - team lifecycle unregister happens even if tmux kill succeeds but state cleanup partially fails
   - spawn does not falsely imply staleness monitoring if the watchdog interval is not running

## Reproduction sketch

1. Start a dev-team session.
2. Let the team-staleness watchdog register it.
3. Kill/destroy the tmux session.
4. Wait for next staleness tick.
5. Observe whether watchdog still emits unresponsive Telegram alerts.

## Relevant tools/results

- `subctl_orch_list`: returned `orchestrations: []`
- `system_watchdog_self`: returned `watching_count: 2`, both with `tmux_session_exists: false`
- `watchdog_kill({ id: "team-staleness" })`: mitigation succeeded
