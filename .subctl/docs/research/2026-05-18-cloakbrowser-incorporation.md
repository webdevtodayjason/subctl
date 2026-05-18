# CloakBrowser incorporation research

Date: 2026-05-18
Operator prompt: investigate CloakBrowser and incorporate useful patterns into subCTL.

Sources read:

- https://github.com/CloakHQ/CloakBrowser
- https://cloakbrowser.dev
- https://github.com/CloakHQ/CloakBrowser#test-results

## What CloakBrowser is

CloakBrowser is a drop-in Playwright/Puppeteer replacement backed by a custom Chromium binary with source-level fingerprint patches. The claim is explicitly not JavaScript stealth injection and not config-only flags: they patch Chromium C++ and ship a custom binary.

Core features surfaced in docs:

- Python and JavaScript packages: `pip install cloakbrowser`, `npm install cloakbrowser`.
- First launch downloads a ~200MB custom Chromium binary, cached locally.
- Playwright-compatible API: import swap, then use normal `new_page`, `goto`, context APIs.
- Puppeteer support also exists, though docs recommend Playwright for stronger reCAPTCHA Enterprise behaviour.
- `humanize=True` / `humanize: true` wraps interactions with Bezier mouse movement, typing timing, scroll physics, and small behavioural delays.
- Persistent profile contexts for cookies/localStorage/cache.
- Proxy support, including SOCKS5.
- GeoIP mode to align timezone and locale to proxy exit IP.
- WebRTC IP spoofing via `--fingerprint-webrtc-ip=auto`.
- `cloakserve`: CDP server/multiplexer for connecting external frameworks to stealth Chromium.
- Browser Profile Manager: self-hosted noVNC-ish profile manager as an open-source alternative to Multilogin/GoLogin/AdsPower.

## Claimed test results

The public docs claim live testing against 30+ detection services, last tested Mar/Apr 2026 depending on page:

- reCAPTCHA v3: stock Playwright 0.1, CloakBrowser 0.9.
- Cloudflare Turnstile non-interactive: stock fail, CloakBrowser pass.
- Cloudflare Turnstile managed: stock fail, CloakBrowser pass/single click.
- FingerprintJS bot detection: detected vs pass.
- BrowserScan: detected vs normal.
- CDP detection: detected vs not detected.
- TLS fingerprint: mismatch vs Chrome-equivalent JA3/JA4/Akamai match.

Treat these as vendor/project claims until locally reproduced.

## Relevant implementation patterns for subCTL

1. Browser backend abstraction

SubCTL/TinyFish/browser workflows should not hard-code Playwright Chromium assumptions. Add a browser-provider abstraction with at least:

- `playwright-default`
- `cloakbrowser-local`
- `cloakbrowser-docker`
- possibly `external-cdp`

2. Stealth profile as first-class config

CloakBrowser's useful product insight is that stealth is a coherent profile, not scattered flags. SubCTL should model browser execution profiles:

- headless/headed
- persistent profile path
- fingerprint seed
- proxy
- geoip/timezone/locale
- WebRTC spoof mode
- humanize mode
- storage quota mode
- font-pack expectations for Linux containers

3. Humanized interaction layer

The `humanize=True` flag is probably the most directly useful idea for AI browser agents. SubCTL browser tools should expose a single operator-facing knob like `browser_profile: stealth-human` rather than making agents remember behavioural rules.

4. CDP sidecar mode

`cloakserve` maps cleanly to subCTL architecture: launch a local Docker/container sidecar bound to `127.0.0.1`, then connect tools/agents over CDP. This avoids every worker downloading binaries and keeps policy/audit around one local service.

5. Supply-chain and policy gates

CloakBrowser downloads and runs a custom Chromium binary. Incorporating it requires explicit trust controls:

- verify release signatures/checksums/attestations where possible
- cache under a known directory
- disable auto-update by default in governed mode, or pin versions
- never expose CDP beyond localhost
- document acceptable-use boundaries: authorized browsing/testing only

6. Local verification harness

Before making it a default path, subCTL should add a harness that runs stock Playwright vs CloakBrowser against benign public detector pages and records results. Do not rely purely on README claims.

## Recommended subCTL slices

Slice A: Research/spec

- Inspect subCTL browser surfaces: TinyFish tools, any local browser-use integrations, dashboard agent-browser paths, policy rules.
- Decide where a local browser backend fits without colliding with TinyFish hosted browser.

Slice B: Experimental provider

- Add config-only experimental provider: `browser.backend = cloakbrowser-docker | cloakbrowser-node | playwright`.
- No default switch.
- Add version pin and cache path.

Slice C: CloakBrowser CDP sidecar

- Add a CLI command to start/stop/status a local `cloakserve` container bound to `127.0.0.1`.
- Add port health check and policy audit.

Slice D: Humanized profile

- Add a named browser profile: `stealth-human`, mapping to headed or virtual-headed mode, persistent context, humanize, fixed seed per target, and geoip when proxy is configured.

Slice E: Verification suite

- Add reproducible tests that compare stock Playwright and CloakBrowser on safe detector endpoints.
- Store results under `.subctl/docs/research/` or dashboard diagnostics.

## Immediate recommendation

Do not blindly swap all browser automation to CloakBrowser. Add it as an opt-in experimental backend with a clear profile system and a verification harness. The design win to copy immediately is the operator-facing simplicity: one knob for a coherent browser identity and behaviour profile.
