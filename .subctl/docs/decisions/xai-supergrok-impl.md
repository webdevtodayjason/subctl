# xAI SuperGrok OAuth — Implementation Plan

**Phase:** xai-supergrok-step-1
**Date:** 2026-05-18
**Source of truth (upstream):** `/Users/you/code/hermes-agent/hermes_cli/auth.py` (Python, ~6298 lines)
**Mirror target (downstream):** `/Users/you/code/subctl/components/master/openai-codex-auth.ts` + `codex-oauth.ts` (the v2.8.9 codex pattern we are matching)
**Operator assignment (from `.subctl/docs/decisions.jsonl`, 2026-05-18T20:30Z):**
> read Hermes hermes_cli/auth.py and mirror openai-codex-auth.ts

This document is the step-1 deliverable: anchors + a phased TypeScript-port plan + risks. **It does not modify code.**

---

## 1. Hermes upstream — anchored citations

All line numbers refer to `hermes-agent/hermes_cli/auth.py`. Pulled in this session by `Read`/`grep`; cross-check before porting.

### 1.1 Constants

| Concern | Symbol | Line |
| --- | --- | --- |
| Inference base URL | `DEFAULT_XAI_OAUTH_BASE_URL = "https://api.x.ai/v1"` | 75 |
| OIDC issuer | `XAI_OAUTH_ISSUER = "https://auth.x.ai"` | 93 |
| OIDC discovery URL | `XAI_OAUTH_DISCOVERY_URL` | 94 |
| Upstream client_id (impersonates Grok-CLI) | `XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"` | 95 |
| Scopes | `XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"` | 96 |
| Loopback host/port/path | `XAI_OAUTH_REDIRECT_HOST / _PORT / _PATH` (127.0.0.1 / 56121 / /callback) | 97–99 |
| Refresh skew | `XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120` | 100 |
| User docs URL | `XAI_OAUTH_DOCS_URL` | 111 |

### 1.2 Provider registry & alias map

- `ProviderConfig` dataclass — `auth.py:144–158`.
- `xai-oauth` entry, `auth_type="oauth_external"`, name `"xAI Grok OAuth (SuperGrok Subscription)"` — `auth.py:177–182`.
- Sibling api-key provider `"xai"` (driven by `XAI_API_KEY`) — `auth.py:335–341`.
- Alias normalization (`x-ai`/`x.ai`/`grok` → `xai`; `grok-oauth`/`x-ai-oauth`/`xai-grok-oauth` → `xai-oauth`) — `auth.py:1384–1386`.

### 1.3 Loopback callback (PKCE redirect target)

- Redirect-URI shape validator (`http://127.0.0.1:<port>/...`) — `_xai_validate_loopback_redirect_uri`, `auth.py:2062–2083`.
- CORS allowlist (`https://accounts.x.ai`, `https://auth.x.ai` only) — `_xai_callback_cors_origin`, `auth.py:2086–2094`.
- Single-shot handler capturing `code/state/error/error_description` — `_make_xai_callback_handler`, `auth.py:2097–2148`.
- Bind preferred port 56121, fall back to OS-assigned — `_xai_start_callback_server`, `auth.py:2151–2187`.
- Block-and-collect with timeout — `_xai_wait_for_callback`, `auth.py:2190–2211`.

### 1.4 Token storage (`~/.hermes/auth.json`, provider key `"xai-oauth"`)

- Read + validate shape — `_read_xai_oauth_tokens`, `auth.py:2910–2953`. Error codes: `xai_auth_missing`, `xai_auth_invalid_shape`, `xai_auth_missing_access_token`, `xai_auth_missing_refresh_token`. All set `relogin_required=True`.
- Atomic write under `_auth_store_lock` — `_save_xai_oauth_tokens`, `auth.py:2956–2976`. Stamps `auth_mode="oauth_pkce"`, persists `discovery`, `redirect_uri`, `last_refresh`.
- JWT-`exp`-based expiry check — `_xai_access_token_is_expiring`, `auth.py:2979–2994`.

### 1.5 Discovery hardening — SECURITY-CRITICAL

- `_xai_validate_oauth_endpoint` pins both `authorization_endpoint` and `token_endpoint` to **HTTPS on `x.ai` or `*.x.ai`** — `auth.py:2997–3035`.
- Rationale (verbatim from docstring): *"a single MITM during initial login could substitute a malicious token_endpoint; that URL would then receive the refresh_token on every subsequent refresh — a permanent credential leak from a one-time MITM. Validating scheme + host pins the cached endpoint to the xAI auth origin…"*
- Re-validated on every refresh-hot-path call — `auth.py:3108`.
- Discovery fetcher (with strict JSON shape) — `_xai_oauth_discovery`, `auth.py:3038–3084`.

### 1.6 Refresh

- Pure refresh, public client + PKCE (`grant_type=refresh_token`, `client_id=XAI_OAUTH_CLIENT_ID`, NO client_secret) — `refresh_xai_oauth_pure`, `auth.py:3087–3160`. Sets `relogin_required=True` only on 400/401/403.
- Persisting wrapper — `_refresh_xai_oauth_tokens`, `auth.py:3163–3191`.
- Resolver with double-checked expiry under process-wide lock + env overrides (`HERMES_XAI_REFRESH_TIMEOUT_SECONDS`, `HERMES_XAI_BASE_URL`, `XAI_BASE_URL`) — `resolve_xai_oauth_runtime_credentials`, `auth.py:3194–3245`. Return shape: `{provider, base_url, api_key, source, last_refresh, auth_mode}`.

### 1.7 Initial login (PKCE loopback)

- Authorize URL builder — `_xai_oauth_build_authorize_url`, `auth.py:5286–5312`. Two **non-RFC** params that MUST be forwarded:
  - `plan=generic` — required so `accounts.x.ai` does not reject the non-allowlisted client (see in-source comment 5294–5296).
  - `referrer=hermes-agent` — best-effort attribution string; subctl should send `referrer=subctl` instead (see §3 risks).
- Full PKCE-S256 + state + nonce orchestration with code→token exchange — `_xai_oauth_loopback_login`, `auth.py:5315–5469`.
- CLI top-level (offers to reuse existing creds before triggering loopback) — `_login_xai_oauth`, `auth.py:5231–5283`.

### 1.8 Status, dispatcher, lifecycle

- xAI status snapshot (falls back through credential-pool → resolver) — `get_xai_oauth_auth_status`, `auth.py:4598–4637`.
- Generic dispatcher — `get_auth_status`, `auth.py:4701–4723` (routes `xai-oauth` here).
- Logout-fallback recognizes `xai-oauth` — `_logout_default_provider_from_config`, `auth.py:4932`.
- Provider-switch hygiene note (request-time `api_mode` resolution) — `auth.py:4864–4873`.

### 1.9 Error-code surface to mirror

Every error raised in xai-oauth carries `provider="xai-oauth"` and one of:
`xai_redirect_invalid`, `xai_callback_bind_failed`, `xai_callback_timeout`,
`xai_auth_missing`, `xai_auth_invalid_shape`, `xai_auth_missing_access_token`,
`xai_auth_missing_refresh_token`, `xai_discovery_failed`,
`xai_discovery_invalid`, `xai_discovery_invalid_json`,
`xai_discovery_incomplete`, `xai_refresh_failed`, `xai_refresh_invalid_json`,
`xai_refresh_invalid_response`, `xai_refresh_missing_access_token`,
`xai_authorization_failed`, `xai_state_mismatch`, `xai_code_missing`,
`xai_token_exchange_failed`, `xai_token_exchange_invalid`.

Use these strings verbatim in the TS port so operator-facing diagnostics
match across the Hermes and subctl logs.

---

## 2. Subctl mirror target — anchored citations

All line numbers refer to `/Users/you/code/subctl/components/master/`.

### 2.1 Pattern we are reproducing (codex)

- Resolver entrypoint exported to pi-ai — `getCodexAccessToken`, `openai-codex-auth.ts:255–400`. Returns `string | undefined`; pi-ai's `getApiKey` hook is **synchronous** so the in-band path never awaits.
- Background refresh-on-near-expiry with module-level in-flight map (deduplicates concurrent refreshes per configDir) — `openai-codex-auth.ts:59`, refresh kick at `298–339` (post-expiry) and `351–393` (near-expiry).
- Atomic file write + 0600 chmod, JWT-`exp` decode, OAuth refresh wire — `codex-oauth.ts` (`atomicWriteAuthFile`, `isAccessTokenExpiring`, `refreshCodexTokens`, `REFRESH_SKEW_SECONDS=300`).
- Provider→token wiring — `server.ts:939–971` (`getApiKeyForProvider`, branch for `"openai-codex"` at line 954–968).
- Catalog row that today omits OAuth — `pi-ai-catalog.ts:176` (`xai: { display: "xAI (Grok)", auth: "api-key", notes: "XAI_API_KEY" }`). **This is the line that must grow a sibling `xai-oauth` entry.**

### 2.2 Storage layout

- Codex uses `<configDir>/auth.json` selected via `accounts.conf` row (`provider=openai-codex`). Fallback `~/.codex`.
- xAI port should match: read `accounts.conf` for `provider=xai-oauth`, fall back to `~/.config/subctl/master/oauth/xai-oauth.json` (per the research doc's `adapters/supergrok.ts` recommendation). **Do NOT read Hermes's `~/.hermes/auth.json` directly** — that bypasses Hermes's auth-store lock at `hermes_cli/auth.py:3212`.

---

## 3. Phased implementation plan

### Phase A — `xai-oauth.ts` (the credential plumbing module)

Mirror of `codex-oauth.ts`. New file: `components/master/xai-oauth.ts`. Exports:

1. **A.1** Constants block ported verbatim from `auth.py:75,93–100,111`:
   ```ts
   export const XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";
   export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
   export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
   export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
   export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
   export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
   export const XAI_OAUTH_REDIRECT_PORT = 56121;
   export const XAI_OAUTH_REDIRECT_PATH = "/callback";
   export const REFRESH_SKEW_SECONDS = 120; // matches Hermes XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS
   ```

2. **A.2** `discoverXaiOauthEndpoints()` — port of `_xai_oauth_discovery` (auth.py:3038–3084) + `_xai_validate_oauth_endpoint` (auth.py:2997–3035). **The host-pin check (`x.ai` / `*.x.ai` + `https:`) is not optional — it is the entire reason a one-time MITM at login does not become a permanent refresh-token leak.** Apply it both at fetch time and again on every cached-endpoint reuse before POSTing the refresh.

3. **A.3** `refreshXaiTokens(refreshToken, tokenEndpoint)` — port of `refresh_xai_oauth_pure` (auth.py:3087–3160). Form-encoded POST, public client (no secret). 400/401/403 → throw with `relogin_required: true` flag in the error object.

4. **A.4** `atomicWriteAuthFile(path, json)` — reuse the helper from `codex-oauth.ts` (already O_EXCL + 0600). DO NOT duplicate; import.

5. **A.5** `isAccessTokenExpiring(token, skew)` — reuse the codex helper. JWT-`exp` shape is identical to xAI's.

6. **A.6** `loopbackLogin({timeoutSeconds, openBrowser})` — port of `_xai_oauth_loopback_login` + `_xai_oauth_build_authorize_url` + the http-server scaffolding in `auth.py:2097–2211, 5286–5469`. Critical port points:
   - Bind 127.0.0.1:56121, fall back to OS-assigned port if EADDRINUSE (auth.py:2161–2177).
   - PKCE S256 + random `state` + random `nonce`.
   - **Forward `plan=generic`** in the authorize URL — without it `accounts.x.ai` rejects the loopback (auth.py:5294–5296 comment).
   - Change `referrer=hermes-agent` → `referrer=subctl` (attribution only; xAI does not gate on this).
   - Validate redirect_uri shape before sending (auth.py:2062–2083, 5326).
   - Strict `state` echo check (auth.py:5381–5386).

7. **A.7** Mirror the 20-code error taxonomy from §1.9. TS-side use a `class XaiAuthError extends Error { code: string; reloginRequired: boolean; }`.

**Done when:** `bun test components/master/__tests__/xai-oauth.test.ts` covers happy-path token-exchange + a host-pin negative case ("discovery returned `evil.example.com` → throws `xai_discovery_invalid`").

### Phase B — `xai-oauth-auth.ts` (the pi-ai resolver shim)

Mirror of `openai-codex-auth.ts`. New file: `components/master/xai-oauth-auth.ts`. Exports:

1. **B.1** `resolveActiveXaiOauthConfigDir()` — same accounts.conf parser already used by codex (`loadAccountsConf` is exported from `openai-codex-auth.ts:103`); reuse it. First row with `provider === "xai-oauth"` wins. Fallback: `~/.config/subctl/master/oauth/xai-oauth.json` (single file, not a per-account dir; xAI only ships one SuperGrok seat per user today).

2. **B.2** `readXaiOauthAuth(path)` — load & validate the JSON shape (matches what `_save_xai_oauth_tokens` writes in Hermes, auth.py:2956–2976: `{tokens: {access_token, refresh_token, id_token, expires_in, token_type}, last_refresh, discovery, redirect_uri, auth_mode}`).

3. **B.3** `getXaiOauthAccessToken(opts)` — same shape as `getCodexAccessToken` (openai-codex-auth.ts:255). **Sync return** (`string | undefined`). Background-refresh-on-near-expiry replicating the deduped in-flight pattern at `openai-codex-auth.ts:351–393`. Use `REFRESH_SKEW_SECONDS = 120` (Hermes's xAI skew), not 300 (codex skew).

4. **B.4** Log lines: use the exact strings emitted by Hermes when possible, so a `grep` across both daemons' logs reads coherently.

**Done when:** `bun test components/master/__tests__/xai-oauth-auth.test.ts` covers (a) missing accounts.conf → undefined with a clear log line, (b) valid-token happy path, (c) near-expiry kicks one background refresh, (d) two near-expiry calls within the same window only kick one refresh (in-flight dedup).

### Phase C — pi-ai catalog & server.ts wiring

1. **C.1** `pi-ai-catalog.ts:176`: add a sibling row:
   ```ts
   "xai-oauth": { display: "xAI Grok OAuth (SuperGrok)", auth: "oauth", notes: "subctl auth xai-oauth <alias>" },
   ```
   Keep the existing `xai` (api-key) row untouched — they are distinct providers (mirror of Hermes registry split at auth.py:177 vs 335).

2. **C.2** `server.ts:939–971` (`getApiKeyForProvider`): add branch right after the `openai-codex` branch:
   ```ts
   if (provider === "xai-oauth") {
     return getXaiOauthAccessToken();
   }
   ```

3. **C.3** Surface `xai-oauth` in the model-routing config so a chat turn can pick a Grok model. If pi-ai's `KnownProvider` union doesn't list `xai-oauth` (research doc note), declaration-merge or cast at the call site — see how codex handles it.

**Done when:** an integration test that runs a one-shot Grok chat turn through master, against a recorded API fixture, returns 200 and a non-empty assistant message.

### Phase D — CLI (`subctl auth xai-oauth <alias>`)

1. **D.1** Add a CLI subcommand mirroring whatever `subctl auth openai-codex <alias>` does today (find it in `lib/core.sh` or `cli/`). It should call `loopbackLogin()` from A.6 and write the result via `atomicWriteAuthFile()`.

2. **D.2** Manpage / `subctl --help` entry. Reference the upstream docs URL (`XAI_OAUTH_DOCS_URL`, auth.py:111).

**Done when:** running the new CLI on a fresh machine produces a `xai-oauth.json` that the resolver in B.3 successfully reads.

### Phase E — Pool / multi-account (defer)

Hermes already supports multi-credential pools (`agent.credential_pool.load_pool("xai-oauth")`, called at auth.py:4600). Skip in initial port; revisit only if Jason explicitly wants to spread Grok load across multiple SuperGrok seats.

---

## 4. Risks & open questions

1. **`plan=generic` is xAI-server-side magic.** If xAI tightens its consent screen and rejects this value, both Hermes and subctl break simultaneously. No mitigation; monitor upstream.

2. **Impersonated `client_id`** (`b1a00492-…`, the Grok-CLI client). Same blast radius. Long-term fix is convincing xAI to mint a per-tool client_id; out of scope here.

3. **Host pin (`x.ai` / `*.x.ai`)** is load-bearing security. If xAI migrates auth off `x.ai` in future, refresh will fail until users re-login. Mirror Hermes's exact error message so the diagnostic is recognizable.

4. **No client_secret on refresh** — public-client + PKCE only. Confirm xAI hasn't started requiring `client_assertion` since Hermes was written (it hadn't as of `auth.py:3110–3119`).

5. **Loopback port 56121** is a magic number Hermes chose. If subctl is also running, both daemons fighting for 56121 will trigger Hermes's `xai_callback_bind_failed`. Acceptable: one-time during login only; the OS-assigned-port fallback at `auth.py:2161–2163` resolves it.

6. **`accounts.conf` ordering** — first matching row wins, same as codex. Document this when adding the CLI in D.2.

7. **OPEN: Do we coexist with a running Hermes that's also authenticated to xAI on this host?** If yes, two refreshers racing against `auth.x.ai` is fine (the upstream supports concurrent refreshes), but each writes its own `auth.json`. Document that subctl's auth state is independent of Hermes's; operator runs both `hermes model` *and* `subctl auth xai-oauth` if both need access.

8. **OPEN: Encryption at rest.** Hermes writes plaintext JWTs to `~/.hermes/auth.json` (chmod 0600 only). Codex shim does the same. Per the research doc's "no plugin SDK" note, subctl should do the same and defer keychain integration to a separate hardening pass.

---

## 5. Non-goals (explicit)

- Reusing Hermes's Python auth store at runtime. Subctl owns its own JSON.
- Supporting `XAI_API_KEY` here — that's the existing `xai` (api-key) provider at `pi-ai-catalog.ts:176` + `auth.py:335–341`. Out of scope for the SuperGrok-OAuth track.
- Device-code flow. xAI's OAuth uses PKCE-loopback only (no `device_authorization_endpoint` in the discovery response per Hermes's reads).
- Browser-redirect alternative for headless environments. The `_print_loopback_ssh_hint` flow at `auth.py:5344` is the operator's existing workaround.

---

## 6. Step-2 hand-off

Next concrete deliverable: **draft `components/master/xai-oauth.ts` per §3 Phase A**, plus a `__tests__/xai-oauth.test.ts` exercising the host-pin negative case. Discovery + refresh + loopback orchestration land in a single PR; resolver shim (Phase B), catalog wiring (Phase C), and CLI (Phase D) follow as separate PRs to keep review surface small.

When step-2 begins, re-grep `hermes_cli/auth.py` for any drift since 2026-05-18 (upstream is active) before copying constants — particularly the `client_id` and `plan` value, both of which are externally-controlled and can change without notice.
