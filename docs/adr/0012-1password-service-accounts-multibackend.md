# 0012: Multi-backend secret resolution with 1Password Service Accounts as first-class option

- **Status:** Accepted (implementation queued for v2.7.17)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.17 (after v2.7.16 TinyFish)

## Context

Subctl currently stores every secret in `~/.config/subctl/secrets.json`, chmod 600, gitignored. Operator manages keys via the dashboard Settings → API Tokens panel. The keys we already store:

- `brave_api_key` (Brave Search via `web_search` master tool)
- `firecrawl_api_key` (Firecrawl via `web_fetch` master tool)
- `linear_api_key` (Linear issue tracking)
- `context7_api_key` (Context7 library docs)
- `lmstudio_api_token` (LM Studio OAuth-style bearer when Require API Token is on)
- `tinyfish_oauth_token` (forthcoming in v2.7.16)
- (forthcoming) `anthropic_api_key` for the LLM-judge phase of the eval suite

`secrets.json` is the bootstrap-secret store for the whole subctl daemon. Compromise of that file compromises everything. Today its protection is filesystem permissions only:

- chmod 600 (user-readable only)
- Lives on the operator's machine (M3 Ultra in this case)
- Not encrypted at rest beyond macOS FileVault
- Not rotatable in-place without an outage on master + dashboard
- Not auditable — no record of who/what read which secret when

For solo developer use this is acceptable. For the operator's actual context (MSP, client work flowing through subctl, shared dev environments, multiple machines that all need the same secret) it has known gaps:

1. **Sharing.** Adding a second host (laptop, dev VM, future cloud bridge) requires manually copying the file or re-typing every secret.
2. **Rotation.** Rotating a secret requires editing the file on every host that has it.
3. **Audit.** No record of which tool call accessed which secret. If a key leaks, scope of exposure is unknowable.
4. **Bootstrap on a fresh host.** The operator has to know every key and re-paste each one into the new host's secrets.json. Manual + error-prone.

1Password Service Accounts solve these in a way that fits the MSP context:

- Single source of truth (the 1Password vault).
- Service account token bootstraps the daemon's access. Token itself can rotate.
- Per-secret access is logged on the 1Password side — you can see "this service account read `op://vault/Lm Studio/api token` at HH:MM:SS."
- New hosts only need the service account token; everything else resolves dynamically from the vault.

The HMAC trust marker work (ADR 0011, queued for v2.7.18) will introduce per-team secrets. If those secrets land in `secrets.json`, every host needs the same file. If they land in 1Password (via the v2.7.17 backend introduced here), they're managed in the vault and any subctl host with the service account token can resolve them. That's a stronger sequencing reason to ship 1Password before HMAC.

## Decision

Add a multi-backend resolution chain for secrets. Three providers, configurable order. **Add — not replace.** Operator can keep using `secrets.json` for some or all secrets; can move some or all to 1Password; can use environment variables for CI / override; mix freely.

### Architecture

```
resolveSecret("lmstudio_api_token")
       ↓
  ~/.config/subctl/secrets-config.json defines provider order
       ↓
  Walk providers in order, return first hit:
       ↓
  ┌─────────────────────────────────────────────────────────┐
  │ Provider 1 (default first): env                          │
  │   → process.env.LMSTUDIO_API_TOKEN                       │
  │                                                          │
  │ Provider 2 (default second, NEW in v2.7.17): 1password   │
  │   → If secrets.json holds an op://... reference for this │
  │     key, shell out to `op read op://...` and return the  │
  │     value. Cached for 60s to avoid hammering the CLI.    │
  │   → If 1Password is configured but secrets.json holds a  │
  │     literal value, this provider returns null (literal   │
  │     is handled by Provider 3).                           │
  │                                                          │
  │ Provider 3 (default third): file                         │
  │   → Read literal value from ~/.config/subctl/secrets.json│
  └─────────────────────────────────────────────────────────┘
       ↓
  Return first non-null match, or null
```

### Storage forms

A key in `secrets.json` can take either of two forms:

```json
{
  "lmstudio_api_token": "sk-Lm-XXzNFCvw:Kk9mkfS3JNAE0e8s8UaZ",
  "brave_api_key": "op://Personal/Brave Search/api_key",
  "linear_api_key": "op://Work/Linear/api_token",
  "firecrawl_api_key": "fc-..."
}
```

`lmstudio_api_token` is stored literally — `file` provider returns it. `brave_api_key` and `linear_api_key` are `op://...` references — `1password` provider intercepts, reads from vault, returns the actual value. `firecrawl_api_key` is literal. **Per-key flexibility, no all-or-nothing.**

### Service account bootstrap

The service account token itself is the one secret 1Password cannot resolve (chicken-and-egg). It lives in `OP_SERVICE_ACCOUNT_TOKEN` env var, set by the operator at master + dashboard startup. The launchd plist for both daemons gains an `OP_SERVICE_ACCOUNT_TOKEN` entry pointing to a token the operator pastes once during setup.

If the env var is absent, the `1password` provider silently no-ops and falls through to the next provider. Master keeps working with file-only secrets; existing operators see no change.

### Cache semantics

`op read` is a fork+exec per call. Caching with a 60-second TTL prevents per-tool-call latency from compounding. Cache lives in master's process memory; cleared on restart. Cache is keyed by the full `op://...` reference, not by the subctl key name, so two keys pointing at the same vault item share a cache slot.

Operator can force a refresh by hitting a new master endpoint `POST /api/master/secrets/cache/flush` (which the dashboard exposes as a "refresh secrets" button).

### Audit trail

Every successful 1Password resolution logs one line to `~/.config/subctl/master/secrets-audit.jsonl`:

```json
{"ts": "2026-05-13T...", "key": "brave_api_key", "ref": "op://Personal/Brave Search/api_key", "cache_hit": false}
```

Append-only, machine-readable. Lets the operator answer "which subctl tool read which 1Password secret when." Pairs with 1Password's own server-side audit log for end-to-end traceability.

## Reasoning

- **Multi-backend matches the existing pattern.** Subctl's policy engine has a four-source chain (project / user / preset / defaults). The supervisor model selection has providers (lmstudio / anthropic / openai). Adding the same shape for secrets fits the architecture; it's not a new paradigm to maintain.
- **Operator choice, not migration.** Operator can move secrets one at a time. Some keys (LM Studio bearer, which is local-only) might stay in file. Others (Linear API key shared across team, Brave key billed to a business account) make sense in 1Password. The chain lets the operator decide per key.
- **Bootstrap is solved.** New host = drop the service account token in launchd plist + paste the same `secrets.json` (which is mostly `op://...` references now) + start daemon. No manual key re-entry.
- **Service account model is the right shape for subctl.** Not personal user OAuth (which would require keeping the operator's 1Password session alive forever on a daemon). Not Connect server (which is heavier infrastructure than subctl needs). Service accounts are designed for exactly this use case.
- **Audit closes a real gap.** Today there is NO record of which tool read which secret. With this design, every 1Password-backed read is logged with timestamp + reference + cache-hit status. If a key leaks, scope of exposure is bounded by the audit log.

## Consequences

### Positive

- Operator can centralize sensitive secrets (Linear, Brave, client-billable keys) in 1Password without giving up file-based storage for daemon-internal secrets (LM Studio bearer, HMAC team secrets, etc.).
- New hosts bootstrap from a service account token + the secrets.json with op://... references. No manual key re-entry.
- Audit log for 1Password-backed secrets.
- HMAC marker work (v2.7.18) can store per-team secrets in 1Password vault automatically, with zero additional work.
- The `op://...` URI format is the 1Password-standard reference. If subctl is ever embedded in someone else's tooling, the references travel.

### Negative

- New dependency: `op` CLI must be installed on every host that uses the 1password provider. Operator's M3 has it; M5 has it; future hosts need it installed (one-line via Homebrew / official installer).
- Service account token is now the bootstrap secret. Its compromise = compromise of everything. Mitigated by 1Password's own service-account-revocation flow + the token being narrower than the operator's personal session.
- 60s cache window is a latency-vs-freshness trade. If operator rotates a secret in 1Password, subctl uses the stale value for up to 60s. Acceptable; force-flush endpoint exists for the rare urgent case.
- `op read` adds 100-300ms per cache miss (fork+exec + network roundtrip to 1Password). Acceptable for tool calls that aren't on a tight inner loop.

### Open questions

- **What does the dashboard show for an `op://...` reference?** Lean: show the reference path, NOT the resolved value. Operator can verify "this secret is in 1Password at this path" without exposing the secret in the UI.
- **Rotation workflow.** If operator rotates a key in 1Password, do we surface a "your subctl is using a cached value from X seconds ago" indicator? Currently no — relying on the 60s cache TTL. Worth revisiting if real-world rotation timing demands tighter freshness.
- **Cross-host sync of `secrets.json` itself.** Even with most values as `op://...` references, the `secrets.json` file itself needs to exist on every host with the same key→reference mapping. Could the `secrets.json` ITSELF live in 1Password as an item? Decision: not for v2.7.17. Adds a layer of indirection that complicates bootstrap. Revisit if multi-host management becomes painful.

## Alternatives considered

### Alternative A: Pure 1Password backend (replace secrets.json entirely)

All secrets become `op://...` references. `secrets.json` is deprecated. Every host requires service account token + op CLI.

Rejected because it forces migration. Operator has working file-based setup today; forcing every secret to move to 1Password is a bigger change than necessary. The chain design lets the operator move incrementally.

### Alternative B: 1Password Connect server

1Password offers Connect — a self-hosted server that brokers vault access for automated workflows. Heavier than service accounts.

Rejected because service accounts cover the use case and don't require running another daemon on M3. Connect is appropriate when the workflow is multi-tenant or needs network-level isolation; subctl is single-tenant.

### Alternative C: HashiCorp Vault / AWS Secrets Manager / GCP Secret Manager

Industry-standard secret backends.

Rejected because the operator already runs 1Password as their primary password manager. Adding a second secrets backend just for subctl daemon work doubles the operator's secret-management surface for marginal benefit. 1Password's service account product is mature, fits the threat model, and lives in tooling the operator already uses daily.

### Alternative D: macOS Keychain

Native to the platform. Already used by some Claude Code accounts (per `claude-jason         keychain=Claude Code-credentials-b9df773f`).

Rejected because Keychain doesn't share across hosts. Subctl needs multi-host support. Also, Keychain access from a launchd daemon has historically been finicky (operator has hit this in other contexts). 1Password service accounts work identically across macOS / Linux / future cloud bridge.

### Alternative E: encrypted secrets.json (age, GPG, etc.)

Encrypt the file at rest, decrypt at read time with a master key in env var.

Rejected because it solves the "literal at rest" concern but not the sharing / rotation / audit gaps. Multi-backend with 1Password as one provider is strictly more capable.

## Implementation sketch (for the implementing PR)

Files to add or modify:

- **NEW**: `components/master/secrets-providers/file.ts` — current `secrets.json` reader factored into a provider
- **NEW**: `components/master/secrets-providers/onepassword.ts` — `op read` wrapper with 60s LRU cache + audit log append
- **NEW**: `components/master/secrets-providers/env.ts` — env var lookup, factored from current `resolveSecret`
- **NEW**: `components/master/secrets-providers/index.ts` — chain orchestration, reads `~/.config/subctl/secrets-config.json` for order
- **NEW**: `~/.config/subctl/secrets-config.json` schema — operator-editable. Default: `{"providers": ["env", "1password", "file"]}`
- **MODIFIED**: `components/master/secrets.ts` — `resolveSecret` becomes a thin wrapper over the chain. `getApiKeyForProvider` and `lmstudioAuthHeader` keep their signatures.
- **MODIFIED**: `components/master/server.ts` — new `POST /secrets/cache/flush` endpoint
- **MODIFIED**: `dashboard/server.ts` — new `POST /api/master/secrets/cache/flush` proxy + Settings panel update to show "stored in: file | 1Password (op://...)"
- **MODIFIED**: `dashboard/public/app.js` + `index.html` — Settings → API Tokens panel gains the per-key backend indicator + a "refresh from 1Password" button
- **NEW**: `bin/subctl secrets` subcommand for CLI management (`subctl secrets set lmstudio_api_token op://Personal/...`, `subctl secrets list`, `subctl secrets test`)
- **NEW**: `components/master/__tests__/secrets-providers.test.ts` — chain ordering, cache TTL, op CLI failure modes (mock op), audit log writes

Tests should mock the `op` CLI via spawn-replacement. Real op calls only in operator-side smoke tests.

The launchd plists (`com.subctl.master.plist`, `com.subctl.dashboard.plist`) gain an `OP_SERVICE_ACCOUNT_TOKEN` entry in `EnvironmentVariables`. Operator pastes the token via a one-time CLI: `subctl secrets bootstrap-1password` (interactive — paste token, restart services).

## References

- [1Password Service Accounts documentation](https://developer.1password.com/docs/service-accounts/) — canonical
- [op CLI reference](https://developer.1password.com/docs/cli/) — `op read op://vault/item/field`
- [ADR 0009](0009-self-hosted-only-no-cloud-memory.md) — self-hosted constraint that informed evaluating alternatives B-D
- [ADR 0011](0011-trust-marker-hmac-replacement.md) — HMAC marker work that benefits from this backend
- `components/master/secrets.ts` — current single-backend implementation
- Operator session 2026-05-13 — decision context (TinyFish setup conversation led to broader secret-management discussion)
