# subctl-proxy v0.1 — Pinned Decisions

**Phase:** subctl-proxy-step-1-resume-after-login
**Date:** 2026-05-18
**Source SPEC:** `.subctl/docs/SPEC-subctl-proxy.md` (Draft v0.1, 2026-05-18)
**Scope:** Pins the seven open questions enumerated in SPEC §18. No scaffolding, no implementation. Locks the v0.1 design surface so Phase A (server + tenancy + claude-pro adapter + codex adapter + audit log + health endpoint, per §16) can be cut without re-litigating these choices.

Each entry below: **Question (verbatim from §18) → Decision → Rationale → Revisit trigger**.

---

## D1. Rust HTTP server framework

> **§18.1:** Which Rust HTTP server framework — axum vs actix vs warp?

**Decision: axum.**

Rationale:
- Tokio-native; the SPEC's runtime choice (§4) is already tokio, so axum imposes no extra runtime affinity tax.
- Tower middleware ecosystem gives tenancy, rate-limit, and audit interceptors as composable layers — directly maps onto §5.2 / §8.2.
- hyper underneath is the same transport reqwest uses for upstream calls (§4), so request/response types share types and avoid extra conversions on the proxy hot path.
- Largest active community of the three in 2026; staffing/maintenance risk is lowest.
- actix's separate runtime story and warp's filter-combinator type complexity both add friction for the multi-adapter routing surface in §5.

**Revisit trigger:** If first streaming-passthrough latency benchmarks (§5.1 SSE for `/v1/chat/completions`) show >5 ms p99 axum overhead vs a hyper-direct baseline. No other reason to revisit.

---

## D2. `claude-pro` adapter — credential source

> **§18.2:** Should `claude-pro` adapter consume the per-account Claude config-dir (existing pattern that subctl master already maintains), or a separate `~/.config/subctl/master/oauth/claude-pro-<alias>.json` (consistent with codex/supergrok shape)?

**Decision: read the per-account Claude config-dir.** No migration; no parallel write path. Adapter treats `<claude-config-dir>/.credentials.json` as a read-only input.

Rationale:
- The per-account config-dir pattern is the ground truth that master already maintains (`~/.config/subctl/claude-config-dirs/<alias>/`, SPEC §7.1). Duplicating tokens into a second file would create a sync invariant the proxy has to defend forever.
- The "private Claude Code surface that may change" risk called out in §18.2 is real but bounded: master is already coupled to that file, so any breaking change to it already breaks master — proxy adopting the same coupling adds zero net surface area for upstream-Anthropic-breaks-us blast radius.
- Codex and supergrok adapters keep their `~/.config/subctl/master/oauth/<provider>-<alias>.json` shape (SPEC §7.1) — they're tokens master itself wrote and owns. claude-pro is structurally different because the tokens live inside a Claude Code state dir master is maintaining for a separate purpose. Treating them differently is honest, not inconsistent.
- The refresh-lock dance in §7.2 still applies symmetrically — proxy and master both flock(`~/.config/subctl/proxy/locks/refresh-<alias>.lock`) regardless of which file they're writing.

**Revisit trigger:** If Anthropic ships a breaking change to `.credentials.json` shape that master has to ship a migration for. At that point, evaluate whether centralizing tokens in `master/oauth/claude-pro-<alias>.json` would have been cheaper.

---

## D3. Audit log retention

> **§18.3:** Rotate at N MB? Daily? Operator-controlled? Defaulting to daily rotation with 30-day retention; revisit.

**Decision: daily rotation, 30-day retention, both operator-overridable in `config.toml`.**

Concrete config (added to SPEC §10 example on implementation):

```toml
[audit]
rotate = "daily"               # "daily" | "size:<N>MB" | "never"
retention_days = 30            # 0 = keep forever
```

Rationale:
- Daily rotation gives the dashboard's "Proxy Audit" tab (SPEC §15) a clean paginate-by-day surface for free.
- 30 days covers post-incident forensics + the typical billing-month review cadence without ballooning disk on idle MSP tenants.
- Size-based rotation is supported as an override for high-volume tenants but not the default — operators picking it explicitly opt into a manual housekeeping posture.
- "Append-only, rotation never deletes" remains the §12 invariant: rotation writes `audit-YYYY-MM-DD.jsonl` and starts a fresh `audit.jsonl`; deletion past `retention_days` is a separate `subctl-proxy audit prune` command, never automatic.

**Revisit trigger:** First MSP tenant exceeds 100 MB/day audit volume, or the dashboard "Proxy Audit" tab page-load exceeds 500 ms p50.

---

## D4. Health-check frequency

> **§18.4:** 60s default per §10, but heavily-loaded accounts may want 15s. Per-adapter override?

**Decision: 60s global default, per-account override (not per-adapter). Floor at 5s to avoid self-DoS of upstream `/models` endpoints.**

Concrete config:

```toml
health_check_interval_secs = 60      # global default

[adapters.claude-pro.accounts.claude-jason]
health_check_interval_secs = 15       # operator opt-in for hot accounts
```

Rationale:
- Per-account, not per-adapter — because "hot" is a property of one operator's specific seat usage, not the adapter contract.
- 60s default matches Hermes's pattern and is cheap on every adapter's `/models`-equivalent endpoint.
- 5s floor protects accounts from being deranked by their own health-checker burning rate-limit budget.
- No exponential backoff layer in v0.1 — if an account is unhealthy, it's marked unhealthy and re-checked at its configured interval. Backoff during outage windows is v0.2+.

**Revisit trigger:** First account that genuinely needs <5s health visibility. Likely never for subscription-mediated seats.

---

## D5. TLS auto-provisioning

> **§18.5:** TLS auto-provisioning (rustls-acme for tailnet binds with Tailscale TLS certs)? Probably out of scope for v0.1 — Tailscale already provides transport security on the tailnet.

**Decision: out of scope for v0.1.** Keep the existing `[tls] cert_file / key_file` config knob (SPEC §10) for operators who want to BYO certs. No automatic provisioning, no rustls-acme dep.

Rationale:
- Default localhost bind (§8.3) means most v0.1 deployments do not touch TLS at all.
- Tailnet binds are SPEC-blessed (§8.3) to lean on Tailscale TLS — the transport is already encrypted by the substrate.
- rustls-acme adds a non-trivial dep, an ACME state machine, and a renewal scheduler. None of that is on the v0.1 critical path (§16 phasing). v0.3 (MSP tenancy / public binds) is the right moment.
- For `0.0.0.0` binds today, operators who actually need TLS-from-the-public-internet point a reverse proxy (Caddy / nginx) at the proxy. Documented; not automated.

**Revisit trigger:** v0.3 MSP-tenancy phase, when public binds become a normal posture.

---

## D6. License

> **§18.6:** MIT vs Apache-2.

**Decision: MIT.**

Rationale:
- Matches Rust ecosystem norms (the majority of crates the proxy will depend on are MIT/dual MIT-Apache).
- Lower friction for downstream MSP clients embedding the binary into their own tooling.
- Apache-2's patent-grant clause is not load-bearing for a subscription-mediation proxy — no novel inventive surface here.
- Consistent with operator preference for free/open-source and minimal license-compliance overhead.
- Dual-licensing (MIT OR Apache-2) is a reasonable v0.x upgrade if a contributor or downstream specifically asks; not worth the dual-license boilerplate in v0.1.

**Revisit trigger:** A material contributor or MSP-client legal review explicitly requests Apache-2 (patent grant). Switching MIT → MIT-OR-Apache-2 later is mechanical.

---

## D7. Repo home

> **§18.7:** Under your personal `webdevtodayjason` org or a new `subctl` org? Implies same for the proxy's GitHub Actions secrets, Docker image namespace, Homebrew tap.

**Decision: new `subctl` GitHub org. Proxy repo at `github.com/subctl/subctl-proxy`. GHCR namespace `ghcr.io/subctl/*`. Homebrew tap `subctl/tap`.**

Rationale:
- The SPEC's §2 secondary intent — proxy as **shared substrate** for the Task Master for Programming five-pillar architecture (subctl master, ArgentOS, agent-qa, plus the long-tail tools) — is an explicit org-of-projects, not a personal-account project. Putting it under `webdevtodayjason` semantically caps it at "Jason's side project" forever.
- The main subctl repo's release-cadence-independence rationale (§14) is the same rationale that says "and not co-mingled with personal-account release toil."
- GHCR + Homebrew namespacing under `subctl/*` reads correctly to MSP clients ("subctl/subctl-proxy"); `webdevtodayjason/subctl-proxy` does not.
- Migration cost from personal → org is significant after the first npm/cargo/brew release. Picking the org now avoids it.
- The main `subctl` repo (today under `webdevtodayjason`) should also move to the new org as a follow-up — out of scope here, but the proxy decision pins the org's existence.

**Revisit trigger:** None on the proxy itself. Main-subctl-repo transfer is a separate piece of work (call it out in the v0.1 release notes as "subctl-proxy is the first repo in the new `subctl/` org").

---

## Decisions deferred (not in §18, surfaced during this pin)

These are NOT v0.1 blockers; recording them so the next phase doesn't re-discover them as questions.

- **DEFER-1: `accounts.conf` schema.** SPEC §7.1 references `accounts.conf` as the "source of truth for aliases + providers" but does not enumerate fields. Resolve when Phase A's `state.rs` reader lands — likely mirror master's existing parser (`openai-codex-auth.ts:103 loadAccountsConf` is the reference, per `.subctl/docs/decisions/xai-supergrok-impl.md:159`).
- **DEFER-2: master's `usage.json` schema audit.** SPEC §9 cites it with a "TBD on master-side schema audit." Block on Phase A integration; mock the headroom snapshot until master's path is confirmed.
- **DEFER-3: per-tenant rate-limit storage.** SPEC §8.1 declares `rate_limit = { rps, burst }` in tenants.toml but doesn't specify whether the token bucket is in-memory only or persisted across restarts. v0.1 → in-memory (simpler; restart drops the bucket which is operator-tolerable). v0.3 MSP-tenancy phase → persist if any client complains.
- **DEFER-4: `/v1/models` aggregation 409 surface.** §5.1 says "if multiple adapters declare the same model id, prefer `X-Subctl-Account`; else 409 with the conflicting list." Confirm response body shape (OpenAI's `/v1/models` returns a list, not an error envelope) — likely return 409 with `{error: {type: "ambiguous_model", conflicts: [...]}}` and document.

---

## Step-2 hand-off

Next concrete deliverable, with §18 unblocked: **Phase A scaffold of `subctl-proxy` repo per SPEC §4.1 layout.** Open the new `subctl` GitHub org (D7), create the repo with MIT LICENSE (D6), wire axum (D1), and stub the adapter trait (§6). Claude-pro adapter reads the per-account claude-config-dir (D2). Audit log writes `~/.config/subctl/proxy/audit.jsonl` with daily rotation (D3). Health checks default 60s (D4). No TLS auto-provisioning (D5).

Phase A done-when from §19 remains the canonical v0.1 acceptance gate.

When step-2 begins, re-read this doc for the seven D-IDs and the four DEFER-IDs before opening any PR. If a §18 leaning was flipped here (none currently), the diff should call out the D-ID.
