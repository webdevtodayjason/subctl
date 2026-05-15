# `openai-codex` OAuth Chat Dispatch — Investigation Findings

**Branch:** `feat/codex-oauth-chat`  
**Date:** 2026-05-15  
**Goal:** Get master's chat dispatch to use Codex / ChatGPT Pro OAuth (from
`~/.codex-jason/auth.json`) when `supervisor.provider = "openai-codex"`.

Empirical failure mode going in: chat POST is accepted; `[latency]` logs show
`process_start → compose_prompt_done → llm_call_start → last_token` in ~23ms
with **no `first_token`**. The stream errored before producing any text.

## 1. How chat dispatch reaches pi-ai today

The path is:

1. `POST /chat` (or dashboard SSE proxy) lands at
   `components/master/server.ts:2701` (`if (url.pathname === "/chat" …)`).
2. Each accepted prompt is appended to a `Promise` chain via
   `dispatchToAgent(p)` which awaits `processOnePrompt(p)` (server.ts:1343,
   1617+).
3. `processOnePrompt` builds the system prompt, records inbound on Tier 3
   memory, instruments the latency-stage subscriber, then calls
   **`await agent.prompt(p.text)`** at server.ts:1757.
4. `agent.prompt` is `Agent.prompt` in
   `@earendil-works/pi-agent-core/dist/agent.js`. It calls
   `runAgentLoop(…, this.streamFn)` (agent.js:261).
5. `runAgentLoop` calls `streamAssistantResponse` in agent-loop.js:151.
6. `streamAssistantResponse` resolves the API key like this
   (**agent-loop.js:167**):
   ```js
   const resolvedApiKey =
     (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined)
     || config.apiKey;
   const response = await streamFunction(config.model, llmContext, {
     ...config,
     apiKey: resolvedApiKey,
     signal,
   });
   ```
   `streamFn` defaults to `streamSimple` from pi-ai; for our supervisor model
   `model.api === "openai-codex-responses"` so the dispatch lands in
   `streamSimpleOpenAICodexResponses`.
7. `streamSimpleOpenAICodexResponses` (pi-ai
   `dist/providers/openai-codex-responses.js:212`) does:
   ```js
   const apiKey = options?.apiKey || getEnvApiKey(model.provider);
   if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
   ```

So pi-ai gets an API key from **exactly two places**:

- `options.apiKey` — which, in pi-agent-core, comes from
  `config.getApiKey(provider)` (the operator-provided callback).
- `getEnvApiKey(provider)` — the env-var fallback.

Master wires `getApiKey` at server.ts:976–977:
```ts
const getApiKey = (provider: string): string | undefined =>
  getApiKeyForProvider(provider);
```
and `getApiKeyForProvider` (server.ts:751) returns `"not-needed"` for
local providers, the OpenRouter secret for OpenRouter, and **`undefined`** for
everything else. For `openai-codex` it falls through to `undefined`.

## 2. Pi-ai's `openai-codex-responses` provider

File:
`node_modules/@earendil-works/pi-ai/dist/providers/openai-codex-responses.js`

Key constants:
- `DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"`
- URL is `<baseUrl>/codex/responses` (line 282 `resolveCodexUrl`)
- Tries **WebSocket** first (`wss://chatgpt.com/backend-api/codex/responses`,
  with `OpenAI-Beta: responses_websockets=2026-02-06`), falls back to SSE on
  transport failure. Both paths share the same auth headers.

Auth flow:
1. Token MUST be a JWT. Pi-ai calls `extractAccountId(token)`
   (line 979–993) which base64-decodes the payload and reads
   `payload["https://api.openai.com/auth"].chatgpt_account_id`. If decode
   fails it throws `"Failed to extract accountId from token"`.
2. Headers set by `buildBaseCodexHeaders` (line 1001–1011):
   ```
   Authorization: Bearer <token>
   chatgpt-account-id: <accountId from JWT>
   originator: pi
   User-Agent: pi (<os.platform> <os.release>; <os.arch>)
   ```
3. SSE adds `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`,
   `content-type: application/json`, plus optional `session_id` and
   `x-client-request-id`.
4. WebSocket variant adds `OpenAI-Beta: responses_websockets=2026-02-06`.

Caveat: `originator: pi` is hard-coded. Codex CLI sends `originator: codex_cli`.
If ChatGPT-backend ever gates OAuth tokens on originator we'd see a 4xx (visible
in master.log as a Codex error event), but ArgentOS uses pi-ai successfully so
this is currently fine.

## 3. Pi-ai's env-var fallback for `openai-codex`

File: `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js`

The `envMap` inside `getApiKeyEnvVars` is provider-keyed. The only entry close
to ours is `openai: "OPENAI_API_KEY"`. **There is no `"openai-codex"` entry.**
Consequence: `getEnvApiKey("openai-codex")` always returns `undefined`. Pi-ai
relies entirely on `options.apiKey` (i.e. the `getApiKey` callback) for the
Codex token.

## 4. Subctl's `auth.json` shape vs what pi-ai expects

`/Users/sem/.codex-jason/auth.json`:
```jsonc
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token":      "eyJ…",          // signed-in identity (audience: app_…)
    "access_token":  "eyJ…",          // audience: https://api.openai.com/v1 ← THIS
    "refresh_token": "rt_…",
    "account_id":    "210e4eee-…"
  },
  "last_refresh": "2026-05-06T00:52:01.152801Z"
}
```

The JWT we need is `tokens.access_token`. Decoded payload includes:
```
aud:    ["https://api.openai.com/v1"]
exp:    1778892721           # 2026-05-16 00:52:01 UTC
iat:    1778028720           # 2026-05-06 00:52:00 UTC
https://api.openai.com/auth:
  chatgpt_account_id:   "210e4eee-0a00-4404-ac37-75e4b7083b74"
  chatgpt_plan_type:    "pro"
  chatgpt_user_id:      "user-1DQJ3wfypWBAMkbTl7s2wwRX"
```

Pi-ai's `extractAccountId` reads exactly `chatgpt_account_id`, so this token
matches pi-ai's expected shape **without any translation**. The on-disk schema
the operator already has IS pi-ai's expected schema — we just need to feed
`access_token` into `options.apiKey`.

(Note: `id_token` looks similar but its audience is the app client ID, not
`api.openai.com/v1`. Pi-ai would parse its account_id claim the same way, but
the Codex backend would reject it as the wrong audience. Use `access_token`.)

As of 2026-05-15 12:31 UTC the current `access_token.exp` is 2026-05-16 00:52
UTC, so the token is **still valid for ~12 hours** and refresh is not on the
critical path for the test.

## 5. Is OAuth refresh present in pi-ai?

**No.** Pi-ai's openai-codex-responses provider never calls a refresh endpoint
and the `getEnvApiKey` fallback is read-only. Refresh has to happen
host-side (i.e. in master, before the token is handed to pi-ai). Codex CLI's
refresh flow (for reference, not implemented yet):
```
POST https://auth.openai.com/oauth/token
  Content-Type: application/json
  { "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
    "grant_type": "refresh_token",
    "refresh_token": "<rt_…>",
    "scope": "openid profile email offline_access" }
```
Response is `{ access_token, id_token, refresh_token? }`. Atomic-write back
to `auth.json` with mode 0600.

## Gap analysis — what subctl is missing

| # | Gap | Impact | Fix scope |
|---|-----|--------|-----------|
| 1 | `getApiKeyForProvider("openai-codex")` returns `undefined`. | pi-ai throws `"No API key for provider: openai-codex"` before pushing the stream `start` event. The agent loop emits `agent_end` ~immediately, no `first_token` → matches the 23ms latency footprint observed. | **Required.** New helper that reads `~/.codex-<alias>/auth.json` and returns `tokens.access_token`. |
| 2 | No mechanism to choose WHICH codex account to use. accounts.conf has `openai-jason` + `openai-titanium`. | Need a deterministic default. | **Required.** Parse `~/.config/subctl/accounts.conf`, pick the first row with `provider="openai-codex"`. Falls back to `~/.codex/auth.json` if no row exists. |
| 3 | `getApiKey` wrapper in master is synchronous. | We want async so we can refresh-on-expiry later, and so we can `await fs.readFile` cleanly. | **Trivial.** pi-agent-core's `getApiKey` signature already allows `Promise<string|undefined>` (types.d.ts:153). Just `async` the wrapper. |
| 4 | No OAuth refresh on near-expiry / 401. | Tokens expire ~10 days after issue. Without refresh, the operator gets a silent-failure mode every ~10 days. | **Deferred.** Wire as Path-C-extension if time allows; otherwise log loudly when `exp < now + 5min` and let the operator re-auth via `codex login` (the same `auth.json` is rewritten). |
| 5 | `OPENAI_CODEX_*` is not in pi-ai's envMap. | We can't fall back to env vars. | Acceptable — the auth.json path is canonical. |

## Chosen path — Path C (minimal)

Plumb the existing `access_token` through; defer refresh. Concretely:

1. New module `components/master/openai-codex-auth.ts`:
   - `resolveActiveCodexConfigDir(): string | null` — parse accounts.conf,
     return the first `openai-codex` row's `config_dir` (or `~/.codex` if
     none configured).
   - `readCodexAuth(configDir): CodexAuthJson | null` — read & JSON-parse.
   - `getCodexAccessToken(): Promise<string | undefined>` — resolve config_dir
     → read auth.json → check JWT exp; if `exp <= now`, log loudly and
     return undefined (so pi-ai's "no API key" path surfaces a recognizable
     error instead of pi-ai's Codex backend returning a generic 401). If
     valid, return `tokens.access_token`.

2. Update `getApiKeyForProvider` to be `Promise<string | undefined>` for the
   openai-codex branch (keep sync return for everything else — TS union is
   `string | undefined | Promise<string | undefined>`).

3. Update master's `getApiKey` wrapper to `async`. pi-agent-core already
   `await`s the result.

Why this works:
- pi-ai will see `options.apiKey = <valid JWT>`, decode the chatgpt_account_id
  claim, build the headers, hit `https://chatgpt.com/backend-api/codex/responses`
  (via WS first, SSE fallback). The stream emits `start` → text deltas
  (`first_token` will fire) → `done` → `last_token`.
- No fork of pi-ai. No edits to its node_modules. No translation of
  `auth.json` on disk.
- Test passes if the operator's `~/.codex-jason/auth.json` is current (it is,
  through May 16 00:52 UTC).

## Test expectations after the fix

```bash
# providers.json supervisor: { provider: "openai-codex", model: "gpt-5.5", auth: "oauth" }
# profiles.json chat:        { supervisor: "gpt-5.5", host: "https://chatgpt.com/backend-api" }

curl -sS -X POST http://127.0.0.1:8787/api/master/chat \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply with exactly: CODEX-WORKING and nothing else."}'
```

Expected master.log latency line:
```
[latency] turn=… stage=first_token ms=NNN       # 500ms–10s, cloud
[latency] turn=… stage=last_token  ms=NNN
[latency] turn=… stage=turn_complete …
```

Expected transcript: an assistant turn containing the text "CODEX-WORKING".

## Out of scope (for this commit)

- OAuth refresh (Path C-extension, only if time remains after green).
- Multi-account routing (using `openai-titanium` instead of `openai-jason`).
- Pi-ai upstream change to honor `originator: codex_cli` or to expose a
  Codex-specific env var.
