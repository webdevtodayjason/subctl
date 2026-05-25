# `feat/codex-oauth-chat` — Where We Landed, What's Next

**Status:** STRUCTURAL FIX SHIPPED. **OPERATOR ACTION REQUIRED to unblock.**

**Branch:** `feat/codex-oauth-chat`  
**Date:** 2026-05-15  
**Commits on this branch:**
- `fb4ec6d` docs(codex-oauth): investigation findings before wiring
- `69773d7` feat(master): wire openai-codex OAuth chat dispatch

## What works now

Master's `openai-codex` chat dispatch is **plumbed end-to-end**. With supervisor
set to `{ provider: "openai-codex", model: "gpt-5.5" }` and profile host
`https://chatgpt.com/backend-api`:

1. `getApiKeyForProvider("openai-codex")` now resolves the access_token from
   the active codex profile's `auth.json` (per `accounts.conf`).
2. Pi-agent-core hands that token to pi-ai's `streamSimpleOpenAICodexResponses`.
3. Pi-ai decodes the JWT, extracts `chatgpt_account_id`, sets the right
   headers, and posts to `wss://chatgpt.com/backend-api/codex/responses`
   (WS) with `https://chatgpt.com/backend-api/codex/responses` (SSE) fallback.

Empirical evidence in master.log from the live test:
```
[codex-auth] using access_token from /Users/you/.codex-jason
  (account=210e4eee-0a00-4404-ac37-75e4b7083b74, exp_in_s=43946)
[latency] turn=mp6wmr9y-k72pqn stage=llm_call_start ms=189
[latency] turn=mp6wmr9y-k72pqn stage=last_token ms=8249
```

The 8-second turn (was 23ms before this branch) is the cloud round-trip to
ChatGPT, NOT a missing-key fastfail. Our auth wiring is correct.

## Why the test prompt didn't produce text

The transcript's assistant turn from the test came back as:
```jsonc
{
  "stopReason": "error",
  "errorMessage": "Your authentication token has been invalidated. " +
                   "Please try signing in again.",
  "diagnostics": [{
    "type": "provider_transport_failure",
    "error": {
      "name": "WebSocketCloseError",
      "message": "WebSocket closed 1002 Expected 101 status code"
    }
  }]
}
```

Both transports failed:
- **WebSocket** got HTTP 1002 from the upgrade handshake → ChatGPT-backend
  rejected the JWT before WS upgrade.
- **SSE fallback** got the explicit message "Your authentication token has
  been invalidated."

I probed the refresh endpoint to see whether we could rotate to a fresh
token automatically:
```bash
$ curl -sS -X POST https://auth.openai.com/oauth/token \
    -H 'Content-Type: application/json' \
    -d '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann",
         "grant_type":"refresh_token",
         "refresh_token":"<rt_…from auth.json>",
         "scope":"openid profile email offline_access"}'
{
  "error": {
    "message": "Your refresh token has been invalidated. " +
                "Please try signing in again.",
    "type": "invalid_request_error",
    "code": "refresh_token_invalidated"
  }
}
```

**Both `access_token` and `refresh_token` for the `openai-jason` profile are
invalidated server-side.** The `exp` claim on the access_token still says
2026-05-16 00:52 UTC (good for ~12h), but ChatGPT has rotated the session out
from under it — likely because the operator signed into ChatGPT/Codex on
another device or revoked the session.

No amount of code can resurrect a server-invalidated token. The operator
must re-auth interactively.

## Operator action required

To make Codex chat work, re-mint OAuth credentials for the `openai-jason`
profile by running the Codex CLI against that profile's CODEX_HOME:

```bash
# 1. Re-authenticate the codex-jason profile against ChatGPT Pro.
CODEX_HOME=/Users/you/.codex-jason codex login

# (Codex CLI opens a browser to https://auth.openai.com/oauth/authorize,
# you sign in with jbrashear72@icloud.com, the CLI catches the callback
# and writes fresh access_token + refresh_token to
# /Users/you/.codex-jason/auth.json with mode 0600.)

# 2. (Optional) Sanity-check the new auth.json:
jq '.tokens | { has_at: (.access_token != null),
                has_rt: (.refresh_token != null),
                account: .account_id }' \
  /Users/you/.codex-jason/auth.json

# 3. Re-stage the test configs and retry — master will pick up the new
#    auth.json on the next prompt with no restart needed (codex-auth
#    re-reads on every call):

cat > /tmp/codex-test-providers.json <<'EOF'
{
  "models": {
    "router": { "provider": "mlx", "model": "lmstudio-community/gemma-4-E4B-it-MLX-4bit", "host": "http://localhost:8080" },
    "supervisor": { "provider": "openai-codex", "model": "gpt-5.5", "auth": "oauth" },
    "reviewer": { "provider": "lmstudio", "model": "qwen/qwen3.6-27b" },
    "embeddings": { "provider": "mlx", "model": "mlx-community/nomicai-modernbert-embed-base-bf16", "host": "http://localhost:8080" }
  },
  "escalate": { "provider": "openai-codex", "model": "gpt-5.2", "auth": "oauth" },
  "fallback": { "provider": "anthropic", "model": "claude-sonnet-4-6", "auth": "max-subscription" },
  "routing_policy": { "default": "supervisor", "code_review": "reviewer", "search_memory": "embeddings", "irreversible_decision": "escalate", "multi_repo_planning": "escalate" },
  "memory_budget_gb": { "target": 50, "ceiling": 80 }
}
EOF
cp ~/.config/subctl/master/providers.json ~/.config/subctl/master/providers.json.bak
cp /tmp/codex-test-providers.json ~/.config/subctl/master/providers.json

cat > /tmp/codex-test-profiles.json <<'EOF'
{ "active": "chat",
  "profiles": {
    "chat":  { "supervisor": "gpt-5.5", "host": "https://chatgpt.com/backend-api" },
    "heavy": { "supervisor": "qwen/qwen3.6-35b-a3b", "host": "http://localhost:1234/v1" }
  }
}
EOF
cp ~/.config/subctl/profiles.json ~/.config/subctl/profiles.json.bak
cp /tmp/codex-test-profiles.json ~/.config/subctl/profiles.json

launchctl kickstart -k gui/$UID/com.subctl.master
sleep 5

# 4. Send the test prompt and inspect:
curl -sS -X POST http://127.0.0.1:8787/api/master/chat \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with exactly: CODEX-WORKING and nothing else."}'

sleep 15
grep '\[codex-auth\]\|\[latency\] turn=.*stage=' ~/Library/Logs/subctl/master.log | tail -10
curl -sS 'http://127.0.0.1:8788/transcript?limit=2' | jq '.messages[-1]'
```

**Expected after re-auth:**

- `[codex-auth] using access_token from /Users/you/.codex-jason` — same line.
- `[latency] turn=… stage=first_token ms=NNN` — present (was absent on the
  invalidated-token run).
- `[latency] turn=… stage=last_token ms=NNN` — present, well after
  `first_token`.
- Transcript's last assistant message has `content: [{ type:"text",
  text:"CODEX-WORKING" }]` and `stopReason: "stop"` (NOT `"error"`).

**Roll back after test:**
```bash
cp ~/.config/subctl/master/providers.json.bak ~/.config/subctl/master/providers.json
cp ~/.config/subctl/profiles.json.bak ~/.config/subctl/profiles.json
launchctl kickstart -k gui/$UID/com.subctl.master
```

## Follow-up work (not blocking)

These can be picked up in a separate branch once the operator confirms the
auth path works end-to-end:

1. **OAuth refresh-on-401 / refresh-on-near-expiry.** The Codex CLI exchanges
   refresh_token for a fresh access_token via:
   ```
   POST https://auth.openai.com/oauth/token
   { client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
     grant_type: "refresh_token",
     refresh_token: "<rt_…>",
     scope: "openid profile email offline_access" }
   ```
   `client_id` comes from the access_token's `client_id` claim (also in
   `id_token.aud[0]`). On success the response is
   `{ access_token, id_token, refresh_token? }`. **If a new refresh_token is
   returned, atomic-write it back to auth.json** (write to `auth.json.tmp`,
   fsync, rename, chmod 0600) — some OAuth providers rotate refresh tokens
   single-use. The existing helper at `components/master/openai-codex-auth.ts`
   already has the read paths and JWT decode; refresh is a new function
   `refreshCodexAuth(configDir, refreshToken)` plus a "near-expiry OR 401"
   call site in `getCodexAccessToken`.

   **Note:** with both tokens currently invalidated on the operator's
   profile we cannot test refresh code end-to-end until step 1 above is
   done. Defer until then.

2. **Multi-account routing.** Today the first `openai-codex` row in
   accounts.conf wins. The operator has `openai-jason` AND `openai-titanium`
   profiles. A `subctl accounts use openai-titanium` (or a `?account=…`
   query param on `/chat`) would let the operator pick which Codex
   subscription handles a given turn.

3. **Sanity: surface pi-ai's `diagnostics[]` array to master.log.** Pi-ai
   already encodes provider transport failures into the assistant
   message's `diagnostics` field, but we don't log them anywhere — the
   operator had to dig through the SQLite transcript to find the
   "WebSocketCloseError 1002" / "token invalidated" messages this session.
   A one-line subscriber that logs `event.message.diagnostics` on
   `agent_end` would catch these on the first turn next time.

4. **WS fallback control.** The `originator: pi` header pi-ai hard-codes may
   eventually be gated server-side. If we see more transport failures, the
   workaround is to force `transport: "sse"` via the agent's StreamOptions
   (no pi-ai change required). Not needed today.

## Files touched this branch

- `feat/codex-oauth-chat-findings.md` (commit 1) — investigation doc.
- `components/master/openai-codex-auth.ts` (commit 2) — new module:
  accounts.conf parser + auth.json reader + JWT decode + resolver.
- `components/master/__tests__/openai-codex-auth.test.ts` (commit 2) —
  17 unit tests, all green.
- `components/master/server.ts` (commit 2) — import + `getApiKeyForProvider`
  branch for `openai-codex`.
- `feat/codex-oauth-chat-next-steps.md` (this commit) — operator hand-off.

Live test configs were reverted to the pre-test lmstudio/qwen state before
this commit; master is running healthily on the lmstudio supervisor.
