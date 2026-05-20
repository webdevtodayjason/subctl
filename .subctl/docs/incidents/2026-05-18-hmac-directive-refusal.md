# 2026-05-18 HMAC directive refusal incident

## Summary
A recovered worker session `claude-subctl-proxy` refused two `subctl_orch_msg` supervisor directives because the worker-side HMAC contract did not match the master-emitted directive marker. The worker correctly treated the directives as untrusted and refused to inspect the worktree or run commands.

## Impact
- `subctl-proxy` Phase B recovery was blocked.
- Re-sending directives made the situation worse because the worker contract explicitly treats repeated "fresh authenticated retry" messages as suspicious.
- The safety layer prevented blind execution, but liveness failed because master and worker did not have a preflight compatibility check.

## Immediate operator-approved recovery procedure
1. Stop sending `subctl_orch_msg` directives to the refusing worker.
2. Mark the session poisoned for supervisor-message purposes.
3. Kill the poisoned session after verifying no useful unsaved work was performed.
4. Spawn a fresh worker with the required mandate in the boot prompt rather than relying on a follow-up directive.
5. Continue the project from the clean worker.

## Developer follow-up requirements
- Add a startup trust-marker self-test: master emits a harmless signed directive and the worker verifies it before real work begins.
- Include signer/canonicalization metadata in every directive marker, e.g. `trust=v2 scheme=hmac-sha256 canonical=phase-ts-body`.
- Version-lock worker templates against the runtime signer version.
- Add master-side detection: two HMAC refusals from the same worker should mark the session poisoned, notify dashboard/Telegram, and suppress further retries.
- Add a diagnostic command/tool that prints master signer version, canonicalization, and safe non-secret key fingerprint so workers can compare contracts without exposing secrets.
- Update worker contract wording to distinguish "security refusal" from "contract mismatch" and route the latter to master repair instead of indefinite idle.

## Do not do
- Do not bypass HMAC as the default recovery path.
- Do not send a third normal directive into a refusing session.
- Do not ask the worker to reveal or compare raw secrets.
