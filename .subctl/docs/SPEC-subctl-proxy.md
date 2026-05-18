# SPEC: `subctl-proxy` — OpenAI-compatible OAuth-subscription proxy

## Status

Draft v0.1 · 2026-05-18 · operator-approved direction.

This SPEC governs the **subctl-proxy** project: a standalone Rust binary
that turns operator-authed subscription seats (Claude Pro, ChatGPT Pro,
SuperGrok, Codex) into an OpenAI-compatible local endpoint that any
OpenAI-API client can hit. Three primary consumers (subCTL master,
ArgentOS, agent-qa) plus the long tail of dev tools (Codex CLI, Aider,
Cline, Continue, Claude Code itself).

Sibling docs:

- Research that motivated this: `.subctl/docs/research/2026-05-18-hermes-compaction-skill-loading.md` §4
- Decision log entry: `.subctl/docs/decisions.jsonl` (to be appended on this SPEC's approval)

## 1 · Intent

Replace metered-API spend with mediated subscription spend, fleet-wide.

Concretely: Jason (and any MSP client paying for Claude Pro / ChatGPT
Plus / SuperGrok / Codex) holds a fixed-cost subscription seat. Today
those seats only work inside the vendor's chat UI. `subctl-proxy`
mints short-lived credentials against each seat and presents them
behind a unified OpenAI-compatible HTTP endpoint, so any tool that
speaks the OpenAI API can use the subscription seat instead of paying
metered API rates.

Secondary intent: be the **shared substrate** for the Task Master for
Programming five-pillar architecture — every dispatched team, every
agent-qa verification run, every ArgentOS call goes through one
proxy. One place to enforce policy, observe spend, route by account.

## 2 · Non-goals

- Not a load balancer across multiple metered API keys.
- Not a caching layer (prompt caching belongs upstream at the vendor; cf. v0.14.0 Anthropic 1h prefix cache).
- Not a model abstraction layer (we don't translate prompts between provider formats — passthrough only).
- Not a UI. Dashboard surfaces live in the main subctl repo.
- Not an OAuth flow runner. Per §7 we read state that subctl master writes; we do not duplicate device-code dances.

## 3 · Consumers

Each consumer hits `http://127.0.0.1:8642/v1/...` (default port) with an OpenAI-API request and an `Authorization: Bearer <api_key>` header that the proxy uses ONLY for tenancy auth (per §8), then forwards upstream with the appropriate mediated bearer.

| Consumer | How it's wired | Notes |
|---|---|---|
| **subctl master** (Bun) | `SUPERVISOR_BASE_URL=http://127.0.0.1:8642/v1` in launchd plist | already calls OpenAI-compatible endpoints internally |
| **ArgentOS** | env or config file | language-agnostic; just needs OpenAI client lib |
| **agent-qa** (Node/Turbo monorepo) | env `OPENAI_BASE_URL=http://127.0.0.1:8642/v1` | uses for natural-language test interpretation |
| **Codex CLI** | `~/.codex/config.toml` → `model_providers.subctl.base_url` | already supports custom base_url |
| **Aider / Cline / Continue** | per-tool config | OpenAI-compat means it just works |
| **Claude Code** (this tool) | not a primary consumer — Claude Code talks to Anthropic direct on the operator's OAuth | reserved for future |

## 4 · Architecture

Single Rust binary. axum HTTP server, hyper transport, reqwest for upstream calls. Tokio runtime. Zero external services other than upstream provider APIs.

```
subctl-proxy (one process, one port)
├── HTTP server (axum)
├── tenancy layer    ← per-client API key auth
├── router            ← request → adapter selection
├── adapter trait
│   ├── claude-pro
│   ├── chatgpt-pro
│   ├── supergrok
│   └── codex
├── state reader      ← shared state with subctl master (read-only by default)
├── rate-limit cache  ← per-account headroom snapshot
└── audit log         ← every request gets a line
```

### 4.1 Crate layout

```
subctl-proxy/
├── Cargo.toml
├── README.md            # → links to this SPEC
├── src/
│   ├── main.rs          # tokio runtime + axum bind
│   ├── server.rs        # router, middleware
│   ├── config.rs        # TOML config + env override
│   ├── tenancy.rs       # api_key → tenant resolution
│   ├── routing.rs       # adapter selection from request
│   ├── state.rs         # shared-state-dir reader
│   ├── adapters/
│   │   ├── mod.rs       # trait + registry
│   │   ├── base.rs      # common helpers (token freshness, refresh-lock)
│   │   ├── claude_pro.rs
│   │   ├── chatgpt_pro.rs
│   │   ├── supergrok.rs
│   │   └── codex.rs
│   ├── streaming.rs     # SSE passthrough
│   ├── models.rs        # /v1/models aggregator
│   ├── audit.rs         # append-only JSONL
│   ├── health.rs        # /health endpoint
│   └── error.rs         # typed errors → HTTP mapping
└── tests/
    ├── integration_smoke.rs
    └── fixtures/
```

Workspace optional (`Cargo.toml [workspace]`) if we split `adapters/*` into per-provider crates later; v1 is one crate.

## 5 · HTTP API surface

All endpoints under `/v1` mirror OpenAI's contract verbatim. Non-OpenAI endpoints (health, admin) live outside `/v1`.

### 5.1 OpenAI-compatible (forwarded to adapter)

- `POST /v1/chat/completions` — streaming + non-streaming, tool-use passthrough.
- `POST /v1/completions` — legacy, supported if adapter supports it.
- `POST /v1/embeddings` — passthrough.
- `GET  /v1/models` — **aggregated** across all configured adapters with model IDs namespaced as `<adapter>/<model>` (e.g. `claude-pro/claude-sonnet-4-6`, `supergrok/grok-4.3`). When the caller asks for an unnamespaced ID, route to the adapter that declares it; if multiple do, prefer the explicit `X-Subctl-Account` header; else 409 with the conflicting list.

### 5.2 Routing / tenancy headers

Request-time headers the proxy honors:

| Header | Purpose | Required? |
|---|---|---|
| `Authorization: Bearer <api_key>` | Tenancy auth (per §8). Does NOT carry upstream. | yes |
| `X-Subctl-Account: <alias>` | Pin a specific account (e.g. `claude-jason`). Overrides routing defaults. | optional |
| `X-Subctl-Adapter: <name>` | Pin a specific adapter without an account (e.g. `chatgpt-pro`). The proxy picks any seat under that adapter. | optional |
| `X-Subctl-Reason: <free text>` | Recorded in the audit log; useful for "which run consumed this request?" | optional |

Account/adapter resolution order:

1. Explicit `X-Subctl-Account`. Resolve via shared state's `accounts.conf`. 404 if unknown to the tenant.
2. Explicit `X-Subctl-Adapter`. Pick the first healthy account under that adapter on the tenant's allowlist.
3. Model-name implies adapter (e.g. `claude-sonnet-4-6` → `claude-pro`). Pick first healthy account.
4. Tenant's configured default (per-tenant `default_account`).
5. Else 400.

### 5.3 Admin (not under `/v1`)

- `GET  /health` → `{status: "ok", adapters: [...], started_at: ..., version: ...}`. Open by default; tenancy-gated if `health_auth_required = true` in config.
- `GET  /admin/state` → tenant-scoped snapshot of accounts, headroom, recent audit (gated by tenant API key with `scope: admin`).
- `POST /admin/account/:alias/pause` → temporarily exclude an account from routing (e.g. operator-decided cooldown). Idempotent. Audit-logged.
- `POST /admin/account/:alias/resume`.

## 6 · Adapter trait

```rust
#[async_trait]
pub trait Adapter: Send + Sync + 'static {
    /// Stable name used in routing + models namespacing.
    fn name(&self) -> &'static str;

    /// Models this adapter can serve, keyed by stable ID. Updated on
    /// refresh ticks; consumed by /v1/models aggregator.
    async fn list_models(&self, ctx: &RequestCtx) -> Result<Vec<ModelDescriptor>>;

    /// Resolve credentials for a given account alias. Reads shared state,
    /// refreshes if stale, returns short-lived bearer + upstream base URL.
    /// Returns Err(AccountUnconfigured) for accounts this adapter can't serve.
    async fn credential_for(&self, account: &AccountAlias)
        -> Result<UpstreamCredential>;

    /// Forward a request. Default impl reads the credential and uses the
    /// proxy's shared HTTP client; adapters override only when upstream
    /// requires non-OpenAI request shape (rare).
    async fn forward(&self, req: ProxyRequest, cred: &UpstreamCredential)
        -> Result<ProxyResponse>;

    /// Health check called every 60s. Cheap call against upstream's
    /// own /models or equivalent. Used to flag accounts as unhealthy
    /// pre-routing so we don't burn a turn discovering them dead.
    async fn health_check(&self, account: &AccountAlias) -> AccountHealth;
}
```

`UpstreamCredential` is the same shape Hermes uses (`hermes_cli/proxy/adapters/base.py:21–36`): `{bearer, base_url, token_type, expires_at}`. Stripped of any provider-specific fields; we'll add them as `extra: serde_json::Value` if some adapter needs them.

### 6.1 Initial adapters (priority order)

1. **`claude-pro`** — first because subctl master's per-account Claude config-dir OAuth is the ground truth pattern in this codebase. Mints a session credential, refreshes on near-expiry. Models: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5.
2. **`codex`** — second because `components/master/codex-oauth.ts` + `openai-codex-auth.ts` already do the device-code flow. Port the refresh + classification logic. Models: gpt-5.5, gpt-5.3-codex-spark.
3. **`supergrok`** — third, depends on `xai-supergrok-auth.ts` slice from the research report §5 (which doesn't exist yet — proxy adapter blocks on that). Models: grok-4.3, grok-4.20 variants. **Flag the 1M context window** so the model registry sets `context_window: 1_000_000`.
4. **`chatgpt-pro`** — fourth. Reverse-engineered OAuth surface; ChatGPT's auth dance is the trickiest. Plan to lift Hermes' implementation once they ship the adapter (per §4 risk in the research report, Hermes claims it but v0.14.0 only ships `nous`).

Optional v0.2 adapter: **`nous-portal`** — operator already has Nous OAuth state via Hermes; ship parity so subctl-proxy is a superset.

## 7 · Shared state with subctl master

The proxy reads OAuth state that subctl master owns. The master keeps owning OAuth flows (device-code, browser callbacks, token refresh writes); the proxy is read-only by default and reaches into the same files.

### 7.1 State directory layout (canonical)

```
~/.config/subctl/
├── accounts.conf                              # source of truth for aliases + providers
├── master/
│   ├── oauth/
│   │   ├── codex-<alias>.json                # device-code tokens
│   │   ├── chatgpt-pro-<alias>.json
│   │   ├── supergrok-<alias>.json
│   │   └── claude-pro-<alias>.json
│   └── ...
├── claude-config-dirs/<alias>/                # claude-pro per-alias dir (already exists)
│   └── ...standard Claude Code state...
└── proxy/                                     # NEW — proxy's own writeable state
    ├── tenants.toml                           # per-client API keys + scopes (per §8)
    ├── audit.jsonl                            # append-only request log
    ├── account-health.json                    # last health-check result per account
    └── locks/
        └── refresh-<alias>.lock               # advisory lock during token refresh
```

### 7.2 Token-refresh coordination

Both subctl master and subctl-proxy may notice a token is stale at the same time. Coordination via advisory file lock:

```
~/.config/subctl/proxy/locks/refresh-<alias>.lock
```

- Acquire with `flock(LOCK_EX | LOCK_NB)`.
- If acquire fails, sleep 50ms and re-read the token file — the other process is refreshing.
- If acquire succeeds, run the refresh, write the new token, release.
- 5-second timeout on the whole dance; on timeout, return a 503 to the caller with retry-after hint.

Subctl master's existing refresh paths get the same lock dance added — small patch.

### 7.3 What the proxy NEVER writes to

- `~/.config/subctl/accounts.conf`
- `~/.config/subctl/master/oauth/*` (except via the refresh-with-lock path above)
- Any Claude-config-dir content

Audit log + tenant config + account-health snapshot are the proxy's only owned writeable surfaces.

## 8 · Tenancy + per-client API keys

Why this matters: the proxy will be exposed beyond localhost the moment an MSP client wants to point their dev tools at it from another machine. Per-client API keys make that safe; tenancy makes it sellable.

### 8.1 Tenant config (`~/.config/subctl/proxy/tenants.toml`)

```toml
# Each [[tenant]] is one MSP client / one environment.
# Local development tenant always exists; operator can add more.

[[tenant]]
name = "local"
api_key_sha256 = "..."          # bcrypt or sha256-of-key; raw never persisted
allowed_accounts = ["*"]        # glob; "*" = every account in accounts.conf
allowed_adapters = ["*"]
default_account = "claude-jason"
scopes = ["chat", "embeddings", "models", "admin"]
rate_limit = { rps = 10, burst = 30 }
notes = "Operator-local. Used by subctl master, ArgentOS, agent-qa."

[[tenant]]
name = "client-acme"
api_key_sha256 = "..."
allowed_accounts = ["claude-acme-1", "claude-acme-2", "codex-acme"]
allowed_adapters = ["claude-pro", "codex"]
default_account = "claude-acme-1"
scopes = ["chat", "embeddings", "models"]
rate_limit = { rps = 3, burst = 10 }
```

API key minting: `subctl-proxy tenant create --name <n> --scopes chat,models` prints the key once, persists only the hash.

### 8.2 Request flow

1. Extract `Authorization: Bearer <key>`. If missing → 401.
2. Lookup tenant by hash. If unknown → 401.
3. Check scope for the requested endpoint (e.g. `/v1/chat/completions` needs `chat`). If denied → 403.
4. Resolve account/adapter (per §5.2). Confirm tenant's `allowed_accounts` / `allowed_adapters` permit it. If not → 403.
5. Check rate-limit (token-bucket per tenant). If exceeded → 429 with `Retry-After`.
6. Pass through to adapter.

### 8.3 Localhost-default, opt-in remote

Config flag `bind = "127.0.0.1:8642"` (default) vs `bind = "100.64.0.5:8642"` (tailnet) vs `bind = "0.0.0.0:8642"` (anywhere). Binding non-loopback **requires** at least one non-`local` tenant to exist; the proxy refuses to start otherwise.

TLS optional; if `tls.cert_file` is set, axum uses rustls. For tailnet binds we'd document Tailscale-as-transport-security as the standard pattern.

## 9 · Rate-limit awareness

The proxy knows which accounts are hot/cold via:

1. **Hermes-style upstream headers** — every adapter parses `x-ratelimit-*` headers from upstream responses and updates a per-account snapshot in memory.
2. **subctl master's existing usage data** — read `~/.config/subctl/master/state/usage.json` (or whatever the canonical path is — TBD on master-side schema audit) every 30s for the master's broader view.

Routing implication: when a request resolves to "any account under adapter X," the proxy picks the account with the most headroom. When the operator pinned `X-Subctl-Account` explicitly, the proxy honors it but **logs a warning to audit** if the account is over 80% utilized.

## 10 · Configuration

Layered (later wins):

1. Built-in defaults.
2. `~/.config/subctl/proxy/config.toml`.
3. Env vars (`SUBCTL_PROXY_BIND`, `SUBCTL_PROXY_STATE_DIR`, etc.).
4. CLI flags.

```toml
# config.toml example
bind = "127.0.0.1:8642"
state_dir = "~/.config/subctl"             # rooted so it can read master state
log_level = "info"
audit_path = "~/.config/subctl/proxy/audit.jsonl"
health_check_interval_secs = 60
refresh_lock_timeout_secs = 5

[adapters.claude-pro]
enabled = true
[adapters.codex]
enabled = true
[adapters.supergrok]
enabled = false                              # off until §5 lands
[adapters.chatgpt-pro]
enabled = false                              # off until v0.2

[health]
auth_required = false

[tls]
# cert_file = "/etc/subctl-proxy/cert.pem"
# key_file  = "/etc/subctl-proxy/key.pem"
```

## 11 · Operational surface

- **macOS launchd** plist at `/Library/LaunchDaemons/com.subctl.proxy.plist` (system) or `~/Library/LaunchAgents/com.subctl.proxy.plist` (user). Match subctl master's existing pattern.
- **Linux systemd** unit at `/etc/systemd/system/subctl-proxy.service`.
- **Docker** image published to GHCR for ArgentOS / agent-qa deployments that prefer containers. State dir mounted as volume.
- **Homebrew tap**: `brew install subctl-proxy` for local Mac devs.
- **Logs** to stdout; operator wraps with launchd/journalctl. Audit log is separate (`audit.jsonl`).
- **Metrics**: `/metrics` Prometheus endpoint (feature-flagged, off by default) for fleets that want it.
- **Health**: subctl master's existing dashboard polls `GET /health` and surfaces in the dashboard's Accounts tab as "proxy: ok (4 adapters, 7 accounts healthy)".

## 12 · Security

- **Secret hygiene**: tenant API keys hashed (never raw on disk after mint). Upstream bearers never logged. Audit log records account alias + scope, not credentials.
- **Refresh atomicity**: token files written via tmpfile + rename to avoid half-written tokens on disk.
- **Privilege**: runs as the operator's user, NOT root. No setuid.
- **Default localhost bind** — see §8.3.
- **Refuses to forward** if the upstream-bearer is expired and refresh failed (returns 503 with cause).
- **Sanitizes error strings** before returning to client (no leaked file paths, no upstream stacktraces). Same pattern as Hermes' v0.14.0 #26823.
- **Audit immutable** — `audit.jsonl` is append-only; rotation via `subctl-proxy audit rotate` (writes to dated file, never deletes).

## 13 · Testing strategy

- **Unit tests**: adapter trait implementations against mocked upstream (wiremock).
- **Integration tests**: spin the full proxy on a random port with mock upstreams, exercise tenancy + routing + streaming.
- **Smoke tests** (manual / CI nightly): hit the live Claude Pro endpoint with a tiny prompt, verify roundtrip + audit log shape.
- **Cross-consumer tests**: agent-qa run that uses the proxy as `OPENAI_BASE_URL`, confirms natural-language test interpretation works through the mediated path.

## 14 · Repo + release process

- **Repo**: `github.com/<jason-or-org>/subctl-proxy` — separate from main subctl repo for release-cadence independence.
- **License**: MIT or Apache-2 (operator call). Probably MIT to match Rust ecosystem norms.
- **CI**: GitHub Actions matrix on macOS-13, macOS-14, ubuntu-22.04. Cargo fmt + clippy + test on every PR. Release builds on tag push.
- **Releases**: `cargo release` → tag → GitHub release with prebuilt binaries (macos-aarch64, macos-x86_64, linux-x86_64, linux-aarch64). Homebrew formula auto-updated.
- **Versioning**: SemVer. Pre-1.0 (`0.x`) until the adapter trait stabilizes.
- **In-repo docs**: `README.md` (quickstart), `docs/adapters.md` (writing a new adapter), `docs/tenancy.md` (MSP tenancy guide). The canonical SPEC stays in the main subctl repo.

## 15 · Cross-repo coordination

- **Subctl master** gets a small PR adding the refresh-lock dance to its existing OAuth refresh paths (per §7.2). Until that lands, proxy can run but tokens may occasionally race-refresh; both writes are atomic-rename so no corruption, just wasted upstream calls.
- **Subctl dashboard** gets new tabs: Proxy Status (live health) and Proxy Audit (paginated tail of audit.jsonl). Out of scope for v1 of the proxy itself.
- **ArgentOS docs** update with a one-paragraph "point at subctl-proxy" guide.
- **agent-qa docs** same.

## 16 · Phasing

**v0.1 — Local single-tenant** (target: 2 weeks)

- Server, tenancy, routing, claude-pro adapter, codex adapter, audit log, health endpoint.
- Localhost-only.
- Manually-created `tenants.toml` with one `local` tenant.
- Operator wires subctl master to use it as supervisor base URL.
- Smoke test: Codex CLI hits the proxy and successfully invokes a turn.

**v0.2 — Multi-account routing + supergrok** (target: +1 week after §5 lands)

- supergrok adapter using the xai-supergrok-auth slice.
- Account-pinning via header.
- Health-aware routing (skip unhealthy, prefer high-headroom).
- Dashboard Proxy Status tab.

**v0.3 — MSP tenancy** (target: when first client engages)

- Multi-tenant config + scopes + per-tenant rate limits.
- Bind to tailnet / 0.0.0.0 with TLS option.
- Per-tenant audit views.
- `subctl-proxy tenant <create|list|revoke>` CLI subcommand.

**v0.4 — ChatGPT Pro** (target: when Hermes' adapter lands and stabilizes, or when we have time to reverse-engineer)

- chatgpt-pro adapter.

**v0.5+** — Prometheus metrics, Docker image polish, Homebrew tap, supply-chain advisory checker on releases.

## 17 · Out of scope

- Prompt caching (vendor handles it).
- Cross-provider model translation.
- Vision/multimodal-specific transforms (passthrough only).
- Tool-use translation.
- A UI of any kind (dashboard belongs in main subctl repo).
- OAuth device-code flows (master keeps owning these).
- Anything related to the dispatched-team execution (subctl master's job).

## 18 · Open questions

1. **Which Rust HTTP server framework — axum vs actix vs warp?** Leaning axum (tokio-native, Tower ecosystem, hyper-based). Operator preference?
2. **Should `claude-pro` adapter consume the per-account Claude config-dir** (existing pattern that subctl master already maintains), **or a separate `~/.config/subctl/master/oauth/claude-pro-<alias>.json`** (consistent with codex/supergrok shape)? Leaning the former because no migration needed; means the adapter has to read `.credentials.json` inside each claude-config-dir which is a private Claude Code surface that may change.
3. **Audit log retention policy**: rotate at N MB? Daily? Operator-controlled? Defaulting to daily rotation with 30-day retention; revisit.
4. **Health-check frequency**: 60s default per §10, but heavily-loaded accounts may want 15s. Per-adapter override?
5. **TLS auto-provisioning** (rustls-acme for tailnet binds with Tailscale TLS certs)? Probably out of scope for v0.1 — Tailscale already provides transport security on the tailnet.
6. **License pick**: MIT vs Apache-2.
7. **Repo home**: under your personal `webdevtodayjason` org or a new `subctl` org? Implies same for the proxy's GitHub Actions secrets, Docker image namespace, Homebrew tap.

## 19 · Definition of done (v0.1)

- `cargo install --git https://github.com/.../subctl-proxy` produces a working binary.
- `subctl-proxy serve` boots, reads `~/.config/subctl/proxy/config.toml`, binds 127.0.0.1:8642.
- `curl http://127.0.0.1:8642/health` returns `{status: "ok", adapters: [...]}`.
- `OPENAI_BASE_URL=http://127.0.0.1:8642/v1 codex chat` works — Codex CLI sends a real turn through the proxy, gets a real Claude or GPT response, audit log captures it.
- `bun run components/master/server.ts` with `SUPERVISOR_BASE_URL` pointed at the proxy boots normally; Evy's turns go through it.
- Token refresh races with subctl master don't corrupt token files.
- 90% test coverage on adapters + tenancy modules.
