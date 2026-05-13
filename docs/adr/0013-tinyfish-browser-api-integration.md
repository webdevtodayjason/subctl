# 0013: TinyFish Browser API integration — dev-team workers drive Playwright, master stays lean

- **Status:** Accepted (implementation queued, no version slot yet — likely v2.7.21 or beyond)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** TBD

## Context

TinyFish ships four API surfaces. Three have a clear shape:

- **Search** — `tinyfish_search` master tool, shipped v2.7.16
- **Fetch** — `tinyfish_fetch` master tool, shipped v2.7.16
- **Agent** — `tinyfish_agent_run` master tool, queued v2.7.18

The fourth is **Browser API** — different shape from the other three. `POST https://api.browser.tinyfish.ai` returns:

```json
{
  "session_id": "br-a1b2c3d4-...",
  "cdp_url": "wss://example.tinyfish.io/cdp",
  "base_url": "https://example.tinyfish.io"
}
```

That's a **handle to a remote browser session**, not a result. To actually use the session, a Chrome DevTools Protocol (CDP) client (Playwright is the canonical one) connects to `cdp_url` and drives the session: navigate, click, fill forms, scroll, screenshot, extract text.

This is fundamentally different from the other three surfaces, which are request → response. Browser API is request → live session → many subsequent requests → eventual teardown.

Subctl's architecture has three places where a CDP client could live, each with different trade-offs:

1. **In master** — master imports Playwright, manages the session lifecycle, exposes high-level tools (`tinyfish_browser_click`, `tinyfish_browser_extract`, etc.) that drive the session under the hood.
2. **In a spawned dev-team worker** — master exposes one thin tool (`tinyfish_browser_create_session`) that returns the cdp_url; a dispatched Claude Code worker runs `pnpm install playwright` and drives the session itself, reports back to Evy.
3. **Nowhere — pure pass-through** — master returns `{session_id, cdp_url}` to whoever called the tool; the operator or another agent figures out what to do with it. No subctl-side CDP code.

The operator dispatched ADR 0013 because the choice has implications for where complexity lives, what dependencies master takes on, and how the feature composes with the rest of subctl.

## Decision

**Master never embeds Playwright. Dev-team workers drive the session.** (Option B in the alternatives below.)

Concretely:

- Master gets ONE thin tool: `tinyfish_browser_create_session({ url? })`
  - Wraps `POST https://api.browser.tinyfish.ai`
  - Returns `{ ok: true, session_id, cdp_url, base_url, expires_at }` (note: `expires_at` is computed locally; TinyFish docs say sessions auto-teardown after 1 hour of CDP inactivity)
  - Auth via existing `tinyfish_api_key` (same key as search + fetch)
- Master gets a complementary tool: `tinyfish_browser_check_session({ session_id })`
  - Polls TinyFish to confirm the session is still alive
  - Returns `{ ok: true, alive: bool, idle_seconds }` so a worker can decide whether to reuse vs spawn fresh
- That's the ENTIRE master-side surface.

To actually drive a session, Evy dispatches a dev-team worker via the existing `subctl_orch_spawn` flow with a mandate that includes:

- The cdp_url
- The high-level task ("scroll the dashboard, click 'Settings → Tokens', screenshot the result, report back")
- Permission to `pnpm install playwright` (the spawn's policy preset allows it — see Scope/Policy below)

The worker:

1. Installs Playwright in its project directory (one time, cached across sessions for the same project)
2. Writes a small JS or TS script that `connect_over_cdp(cdp_url)`s
3. Drives the session via standard Playwright API
4. Captures screenshots, extracted text, or whatever the task needed
5. Writes the result to `.subctl/docs/` (per Tier 5 of the memory architecture)
6. Reports back to Evy via the inbox

Evy sees the result, files it appropriately (Tier 4 claude-mem for the observation, Tier 5 docs for the artifact), and continues.

## Reasoning

Four reasons master stays out of the CDP business:

1. **Master is the librarian, not the workhorse.** The persona spec is explicit: Evy catalogs, routes, verifies, files. She does not write the books. Driving a browser is "writing the book." It belongs in a specialist's hands.

2. **Playwright is a heavy dependency.** Adding `playwright` to `components/master/package.json` pulls down ~500MB of Chromium binaries plus runtime overhead. Master is currently lean (the bun bundle is fast to load, the daemon footprint is bounded). Adding a browser engine to master would meaningfully change its character.

3. **Dev-team workers already have the substrate.** Each spawned worker is a full Claude Code instance with bash access, `pnpm`/`npm`/`bun` available, project filesystem access, and CLAUDE.md context. Playwright lives naturally there. Workers can shell out, install, drive, capture screenshots to their project dir, and report. This is what they're built for.

4. **It composes with the rest of subctl.** A browse task becomes a normal team dispatch: operator (or Evy) describes the goal, a worker spawns, the worker does the work, Evy verifies + files. The orchestration model is reused. The operator's camera-view-of-team-panes (Phase 3m) shows the worker's progress. Decisions get logged via `team_decision_log`. The whole subctl machine works around browser tasks the same way it works around code tasks.

The alternative — master embeds Playwright — would split subctl's architecture: code tasks go through workers, browse tasks go through master. That asymmetry doesn't earn its complexity.

## Consequences

### Positive

- Master stays lean. No Chromium download, no Playwright runtime, no CDP state machine in the supervisor.
- Browse tasks compose with the rest of subctl: spawn, mandate, verify, file. Operator sees them in the orchestration view alongside code tasks.
- Dev-team workers can choose their own Playwright version, write their own scripts, capture exactly what they need. Subctl doesn't constrain them.
- The cdp_url is operator-shareable: the operator can ALSO connect their own Chrome DevTools to the session for debugging. That's a real superpower for `inspect what TinyFish saw`.
- One subctl-side tool (plus a status-check tool) is the entire surface. Easy to maintain.

### Negative

- Higher latency floor for a browse task vs an embedded approach. Each task starts with a worker spawn (~3-5 seconds) plus Playwright install if not cached (~10-30 seconds first time). Embedded master would have ~zero latency to start. For Evy's day-to-day this is fine; she's already running 10-30s tool calls.
- More moving parts per task: master + worker + cdp_url + Playwright + TinyFish browser-session lifecycle. The worker's mandate has to be specific enough that the worker doesn't get lost.
- The 1-hour CDP inactivity timeout (TinyFish-side) is a real constraint. If a worker pauses for operator confirmation mid-task, the session can die. Workers need to keep the session alive with low-cost CDP pings during long pauses.
- For "Evy needs to click ONE thing real fast" use cases, this is the wrong tool. The Agent API (`tinyfish_agent_run`) is. Operators need to know which tool fits which task — documented in the master SKILL.md tool descriptions.

### Open questions

- **Policy preset for browse-task workers.** Workers need `pnpm install playwright` permission and the ability to run Playwright scripts. The current `generic` preset allows `pnpm` (per v2.7.8 ADR 0001). Confirm before the first real browse task that the worker can actually install and run Playwright without policy denials. If not, a new `browse-task` preset (or extension to `node`) is required.
- **Session reuse across workers.** If Evy needs to do three browse tasks on the same site, should they share one session (faster, stateful) or spawn three independent sessions (cleaner, isolated)? Lean: spawn fresh per task by default; allow explicit session reuse via the `session_id` mandate.
- **Result handoff format.** Worker writes results to `.subctl/docs/`. What's the convention? Lean: one markdown file per browse task, frontmatter with `session_id, cdp_url, started_at, completed_at, goal`, body with extracted text + screenshot paths. Filing convention matches Tier 5.
- **Operator observability.** Can the operator literally connect their browser DevTools to the cdp_url to watch a live worker browse? TinyFish docs suggest yes (cdp_url is a public WebSocket). Worth verifying. If yes, that's a strong debugging affordance.

## Alternatives considered

### Alternative A: Master embeds Playwright

Add `playwright` to `components/master/package.json`. Master gets high-level tools: `tinyfish_browser_navigate(url)`, `tinyfish_browser_click(selector)`, `tinyfish_browser_fill(selector, value)`, `tinyfish_browser_extract(selector)`, `tinyfish_browser_screenshot()`. Master manages session state per chat thread or per tool-call series.

Rejected for the four reasons above (master stays lean / Playwright is heavy / workers already have the substrate / composes with subctl). Specifically: master is a 24/7 daemon. The CDP state machine would have to manage connection drops, session expiration, navigation timeouts, etc., as part of the supervisor loop. That's not the supervisor's job.

### Alternative B (CHOSEN): Dev-team workers drive Playwright

Described above. Master exposes session creation + status check. Workers drive.

### Alternative C: Thin pass-through

Master returns `{session_id, cdp_url}`. Evy gets the URL. She figures out what to do with it (probably text-instructs the operator or another agent — "here's a browser session, drive it yourself").

Rejected because it punts the question. Evy ends up with a useful resource and no way to use it autonomously. The whole reason Evy needs the Browser API is to do work that the Agent API can't (sustained sessions with multiple steps). Pass-through doesn't enable that work; it just exposes the primitive.

### Alternative D: Browser-driving MCP server in subctl

Run a separate MCP server (process or library) that exposes browser tools. Master speaks MCP to it. The browser-driving server uses Playwright internally.

Rejected because it adds another running process to monitor (another launchd plist on M3, another health check, another failure mode) for marginal benefit over Option B. Worker-based driving uses processes we already spawn and monitor (tmux dev teams). Don't add new long-running daemons unless absolutely necessary.

### Alternative E: Headless browser as a master tool via curl/wget

Skip Playwright entirely. Master could (with TinyFish's help) drive a session via HTTP-based CDP commands.

Rejected because CDP-over-HTTP is the wrong abstraction for stateful browsing (CDP is WebSocket-native; HTTP transport doesn't compose well with event-driven workflows like navigation completion or DOM-ready events). Playwright wraps these well; replacing it with a hand-rolled HTTP layer is reinventing the wheel poorly.

## Implementation sketch

For when this PR is dispatched:

### Master-side (small)

- **`components/master/tools/tinyfish.ts`** — append two tools to the existing `tinyfishTools` export:
  - `tinyfish_browser_create_session({ url? })` → calls `POST https://api.browser.tinyfish.ai` with `X-API-Key`, returns the response payload + a computed `expires_at` (1 hour from now, per TinyFish's inactivity rule)
  - `tinyfish_browser_check_session({ session_id })` → queries TinyFish's session status endpoint (verify endpoint path on first call; TinyFish docs reference `/pages` for status polling)
- Tool descriptions in Evy's voice: "**Use this when** you need a sustained browser session — multi-step navigation, form filling, watching for events. The tool returns a session_id + cdp_url. Dispatch a dev-team worker with the cdp_url to actually drive the session. For one-shot 'click this button and tell me what's on the page' use `tinyfish_agent_run` (Agent API) instead."

### Worker-side (NEW skill or template)

- **`templates/skills/subctl-browser-task/SKILL.md`** (NEW, ships with v2.7.14's project skeleton work or wherever skills land) — instructions for a worker on how to drive a TinyFish browser session:
  - Install Playwright (`pnpm install playwright`)
  - Connect via `chromium.connectOverCDP(cdp_url)`
  - Standard Playwright operations
  - Keep-alive pings during long pauses (one CDP command every ~50 minutes)
  - Capture screenshots to `.subctl/docs/screenshots/`
  - File results to `.subctl/docs/browse-tasks/<task-name>.md` with frontmatter
- **`templates/agents/browser-driver.md`** (when team-templates land in v2.8.0) — Claude Code subagent type for browse tasks specifically, with the right tool allowlist (Playwright permitted via the policy preset).

### Policy update

- Audit the `generic` and `node` presets to confirm `pnpm install playwright` is allowed (likely already covered by the existing `pnpm` and `npm` allow rules from v2.7.8).
- If a `browse-task` preset is needed (because of Playwright's runtime needing additional Chromium permissions), define it as a v2.7.21-or-later deliverable.

### Tests

- **`components/master/tools/__tests__/tinyfish-browser.test.ts`** (NEW) — mock TinyFish API responses, verify the session-create tool returns correct shape, verify error paths (no api key, 401, 429, 5xx).
- No end-to-end test that actually spawns a worker + Playwright (too heavy for CI). Operator-side smoke test instead.

### Documentation

- `docs/master.md` — add browser-task section explaining the master-vs-worker split.
- `docs/persona/evy.md` — update Evy's tool list to include the two new browser tools with their imperative-voice descriptions.
- `docs/tinyfish-browser-tasks.md` (NEW) — operator-facing guide on what browse tasks look like end-to-end, with example mandates and result formats.

## References

- TinyFish Browser API docs: https://docs.tinyfish.ai (Browser API page)
- TinyFish Agent API docs: same site, Agent API page
- ADR 0004 — Evy persona (librarian framing, "doesn't write the books")
- ADR 0005 — five-tier memory architecture (browse results land in Tier 4 + Tier 5)
- ADR 0008 — eval pipeline (browse tasks should eventually be eval-able once we have enough examples)
- Operator session 2026-05-13 — decision context (Evy noticed her tool registry was incomplete; led to this ADR + the queued Agent API integration)
