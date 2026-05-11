# Changelog

All notable changes to subctl are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical version source is the `VERSION` file at the repo root. `lib/core.sh`, `bin/subctl`, the dashboard, and the master daemon all derive their version string from it. To bump: edit `VERSION`, append a CHANGELOG entry, commit, push — `subctl update` on every host pulls the new version automatically.

## [2.5.7] — 2026-05-10

Patch — three operator-reported fixes from the post-shutdown playtest.

### Fixed

- **Watchdog no longer fires on dead tmux sessions.** `refreshTeamActivityFromTmux` now PRUNES entries whose tmux session is no longer alive. Diagnosed live during operator playtest: "Looks like your watchdog is kicking off even though you closed the tab out." Was caused by `teamLastActivity` keeping the spawn-seed event in memory after `tmux kill-session` ran — the team's `last_activity` aged forever, watchdog flagged stale every tick, master tool-called `subctl_orch_status` and got HTTP 404 each time. New behavior: any `claude-*` entry missing from the live tmux session list gets dropped, plus a `team_pruned` SSE event + `watchdog_pruned` decisions.jsonl line for audit. Guarded against false positives — only prunes when the tmux query succeeded.
- **Dev-team card no longer renders "undefined: (no text)".** Synthetic spawn-seed events use `kind`/`detail`/`by` fields; the renderer was expecting `type`/`text`. Fallback chain added so seed events render as `spawned: retroactive seed for live team …` instead of `undefined: (no text)`.

### Changed

- **Master SKILL nudges `claude-mem` usage more aggressively.** Operator noted the master was relying solely on `memory.md` (tier-1) and rarely calling `memory_search` / `memory_timeline`. New rule in the system prompt: call claude-mem proactively when (a) operator references a past project/decision/incident, (b) about to assert a fact from loose recall, (c) spawning into a project worked on before, (d) transcript was auto-compacted. Plus an explicit boundary call-out: `memory.md` is operator notes; claude-mem is project/incident history.

## [2.5.6] — 2026-05-10

Patch — watchdog observability. Backlog item shipped.

### Changed

- **Watchdog panel in Orchestration tab renders every tick, not just firings.** Previously the panel showed "no recent watchdog firings" indefinitely — true but useless, looked like the watchdog was broken. Now: the master's existing `watchdog_ok` SSE event populates a rolling history of the last 8 ticks with timestamp + `OK` pill + team/stale counts. `watchdog_fire` events show with a red `FIRE` pill and a summary of the synthesized prompt. The card header surfaces `last tick · HH:MM:SS` so the operator can see when the watchdog last ran without scrolling.
- **Empty-state copy** updated from "no recent watchdog firings" to "armed — first tick lands within the configured interval (default 3 min)" so a fresh-loaded dashboard tells the truth.

### Architecture note

The renderer (`renderWatchdogPanel`) lives at module scope in `app.js`, called from the SSE event handlers. Module-level placement was deliberate so the function is reachable from the wireMasterChat listeners without rewiring `wireOrchestrationCockpit`'s closure scope.

## [2.5.5] — 2026-05-10

Patch — launchd resilience after today's death spiral.

### Changed

- **Master plist `KeepAlive` is now conditional.** Was `<true/>` (restart unconditionally). Now `{SuccessfulExit: false, Crashed: true}` — launchd restarts on crash but NOT after a clean operator stop. Prevents `subctl master disable` from being instantly undone by KeepAlive.
- **Master plist `ThrottleInterval` 10s → 30s.** Today's failure mode: LM Studio crashed → master ctx-pin hung 60s → daemon exited → launchd respawned within 10s → master hung 60s again. macOS's internal respawn-limit detector flagged the job as failing and gave up. 30s gives the environment breathing room and resets the failure counter more aggressively. (Combined with v2.5.3's 2s LM Studio reachability probe, master now boots fast even when LM Studio is dead.)
- **Master plist `ExitTimeOut` added (20s).** SIGTERM → wait 20s → SIGKILL. Stops zombie processes when a shutdown path hangs.
- **Dashboard plist mirrors the same `ThrottleInterval` (30) + `ExitTimeOut` (20)** for consistency.

### Added

- **`subctl master kick`** — force-recover when launchd has thrown up its hands. Bootouts the stale job, kills any orphan master process squatting on the port, bootstraps a fresh launchd entry. Must be run from a local TTY (Terminal.app on the machine) because `launchctl bootstrap` targets `gui/$UID` which isn't reachable from a vanilla SSH session. Falls back to a printed `tmux new-session` recovery command if bootstrap fails.

### To apply on an existing install

```
subctl master disable && subctl master enable    # re-renders the plist
```

Or from local Terminal.app on the M3 Ultra:

```
subctl master kick
```

## [2.5.4] — 2026-05-10

Patch — three operator-reported issues from the post-recovery playtest.

### Fixed

- **Chat toolbar now sticky-anchored at the top of the chat panel.** Operator reported (third occurrence) that scrolling chat content visually overlapped the toolbar AND made the MODEL dropdown unclickable. Root cause was the toolbar living in flex flow with no z-stacking — scrolled content rendered over it under certain content lengths. Fixed via `position: sticky; top: 0; z-index: 5; background: var(--bg-1)` on `.chat-toolbar`. The toolbar now anchors at the top of the panel regardless of scroll position, content scrolls under it, clicks always land.
- **Vault tab now finds vaults even without a `.obsidian/` marker.** v2.5.0's detection required every subdirectory of `vault_root` to have a `.obsidian/` dir to count as a vault — strict but brittle. The master's `vault_append` tool creates project subdirs WITHOUT a `.obsidian/`, so any vault populated only by the master would show empty in the viewer. New detection: (a) treat `vault_root` itself as a vault if it has `.obsidian/`, (b) treat each subdir with EITHER `.obsidian/` OR ≥1 `.md` file as a vault. Existing canonical Obsidian vaults still detected correctly; master-only project dirs now visible.
- **Live fix on M3 Ultra:** dropped `.obsidian/` markers into `Down-Time-Arena/` and a fresh `master/` subdirectory inside the vault root so the operator can see both vaults immediately without waiting for a fresh install.

### Added

- **Telegram source badge + auto-relay.** Two-part fix for "I sent from Telegram but the master replied in the dashboard, not Telegram":
  - **Frontend:** Telegram-sourced messages in the chat panel get a `from-telegram` class with purple left-border + the label `✈ you · telegram` so the operator can see at a glance which channel a message arrived from.
  - **Master daemon:** after the assistant settles a turn, if `source: "telegram"`, the response text is now automatically relayed back to the Telegram chat via the existing `sendTelegramOutbound` helper. No tool call required by the model. Truncates to 3900 chars (Telegram's 4096 cap minus padding) with `…[truncated; full reply in dashboard chat]` if longer. Skipped for internal synth prompts (`[verifier]` / `[watchdog]` / `[scheduled]`).

## [2.5.3] — 2026-05-10

Patch — master daemon survives LM Studio crashes cleanly.

### Why

Surfaced during today's session: LM Studio crashed under memory pressure (probably from the day's camera-view polling stacking duplicate qwen instances). Master daemon then entered a death spiral — ctx-pin for the reviewer hung 60 s on `/api/v1/models/load`, daemon eventually crashed, launchd hit its restart-throttle limit and gave up retrying. Both subctl services were down. The recurring symptom: `ctx-pin FAILED reviewer: load error: The operation timed out.`

### Fixed

- **`ensureModelLoaded` short-circuits when LM Studio is unreachable.** Tight 2 s timeout on the initial `/api/v0/models` reachability check; if it doesn't respond we skip the pin entirely and let JIT-on-first-prompt handle it. Old code charged into a 60 s `/load` request even when LM Studio was clearly dead.
- **Treat "already loaded at ≥ desired context" as a hit.** When the supervisor pins at 65 K and the reviewer also points at the same model but wants 32 K, the reviewer no longer triggers an unload+reload — it accepts the already-loaded 65 K instance. Avoids the recurring "supervisor succeeds, reviewer evicts + reloads + hangs" cascade.
- **Role pins run in parallel.** Wrapped supervisor + reviewer ctx-pins in `Promise.allSettled`. Boot is now bounded by the SLOWEST single role, not the sum. Previously a hung reviewer pin would block the supervisor's pin output for a minute even though they're independent.
- **Load fetch timeout 60 s → 20 s.** If LM Studio can't load in 20 s the daemon shouldn't block boot — first user prompt will JIT it. The 60 s cap was inherited from the original force-pin patch where we wanted to ride out a slow model load; in retrospect the supervisor's pin succeeds in ~2 s when LM Studio is healthy, and 20 s is plenty even for the worst cold-start case we've actually observed.

### Notes for the operator

- **No re-auth or config changes needed.** Code-only fix.
- If you've had providers.json with both supervisor + reviewer pointing at the same model with different `context_length` values, v2.5.3 will gracefully share one loaded instance instead of trying to double-load. Removing the reviewer block entirely is also fine — supervisor handles everything.
- **launchd recovery on the M3 Ultra:** today's death spiral exhausted launchd's restart-throttle and `launchctl bootstrap` failed via SSH (GUI domain unreachable from a non-attached session). Recovery path: open Terminal locally on the M3 Ultra and run `launchctl load ~/Library/LaunchAgents/com.subctl.master.plist`. Or keep using the detached-tmux daemons set up today (`tmux ls` — sessions `subctl-master` and `subctl-dashboard`).

## [2.5.2] — 2026-05-10

Patch — three v2.5.0 bugs surfaced by operator the moment the Vault tab landed.

### Fixed

- **Vault tab now hides other tabs.** Missed adding the `body[data-active-tab="vault"] section[data-tab]:not([data-tab="vault"]) { display: none; }` rule in v2.5.0. Result: clicking Vault left the body in "no rule matched" state, every section rendered stacked + scrollable. Fixed by adding the missing rule.
- **Projects → "Open Vault Path" button now actually opens the Vault viewer.** Was renamed to **"Open in Vault Viewer"** and rewired: clicks now call `window.openVaultDeepLink("master", "<project>/decisions.md")` which sets the hash + clicks the sidebar Vault button. Old behavior copied the path to clipboard (which was the placeholder before Phase 3n existed).
- **Chat toolbar padding bumped from 22 → 28px top.** Defensive fix — operators kept reporting the chat toolbar buttons appearing clipped against the panel's rounded top edge. Likely a stale-CSS-cache + flex-wrap interaction, but extra top breathing room makes it impossible regardless.

### Added (helper for cross-tab navigation)

- **`window.openVaultDeepLink(root, path)`** — exposed by the Vault tab module so other tabs (Projects, future ones) can route the user to a specific note: sets the URL hash, programmatically clicks the Vault sidebar button, lets the existing tab-activation logic + hash-aware `checkActive()` pick up the navigation. The Vault tab's `checkActive()` was extended to re-evaluate the hash on every activation (not just first load) so deep-links from outside work even when the vault is already loaded.

## [2.5.1] — 2026-05-10

Patch — three backlog cleanups.

### Changed

- **`detached` label renamed to `running · headless`** in dashboard team rows + tmux preview meta. Operators read "detached" as "broken/disconnected"; it actually means "no operator terminal currently attached, work continues." New wording matches expectation. (One of two backlog items called out 2026-05-10.)
- **`lms version` parser now extracts a real semver instead of a banner line.** Previously the dashboard's install-checks tile picked the first line containing a digit, which in `lms`'s ASCII-art banner output (box-drawing chars + version inside a frame) ended up being a line like `│ Version 1.4.1 │`. Now: strip ANSI → strip box-drawing/block chars → match `/\b\d+\.\d+(?:\.\d+)?(?:[-+]\w+)?\b/` per line → return the first hit. Falls back to first non-empty line if no semver shape found.

### Added

- **`system_my_tools(filter?)`** — master tool that introspects the live tool registry. Use case: when Jason asks "what tools do you have?" or "what can you do?", master can answer accurately from the registry instead of recall. SKILL updated to mandate calling this for capability questions (reinforces anti-hallucination rule #2). Optional `filter` arg does case-insensitive substring match — e.g. `system_my_tools({filter: "subctl_orch"})` returns just the orchestration tools.
- **Late-binder pattern in `tools/system.ts`** — `bindToolRegistry(reg)` exposed by the module, called once by `server.ts` after the registry is built. Avoids a circular import (system → server → systemTools).

## [2.5.0] — 2026-05-10

Minor — Phase 3n ships (MVP): **in-browser Obsidian vault viewer.**

### Added

- **New "Vault" sidebar tab** with two-pane layout: file tree (left, 280 px) + rendered note (center). Auto-opens the first two levels of the tree for discoverability.
- **Backend endpoints** in `dashboard/server.ts`:
  - `GET /api/vault/roots` — every sub-directory of `vault_root` with a `.obsidian/` dir is enumerated as a discrete vault.
  - `GET /api/vault/<vault>/tree` — full folder tree of `.md` files, dirs sorted before notes alphabetical.
  - `GET /api/vault/<vault>/note?path=…` — raw markdown + parsed YAML frontmatter + file stats.
  - `GET /api/vault/<vault>/asset?path=…` — passthrough for images (png/jpg/gif/svg/webp/pdf), with caching headers.
  - All paths sanitised via `safeJoinUnder()` — rejects `..`, absolute paths, null bytes.
- **Frontend renderer** uses Marked.js 13.0.0 from CDN (no build step). Pre-render transforms cover the Obsidian-specific syntax Marked doesn't know about:
  - `[[wikilink]]` and `[[wikilink|alias]]` → click-navigable anchors (purple). Resolver matches exact path first, then any note whose final segment matches case-insensitively. Missing targets render with a red dashed underline.
  - `![[embed.png]]` → `<img>` via the asset endpoint. Non-image embeds become click-to-open links.
  - `> [!note]` / `> [!warning]` / `> [!danger]` callouts → styled blockquotes with coloured left borders and uppercase titles.
  - `#tag` (in body text, not headings or URLs) → coloured pill spans.
  - YAML frontmatter parsed and rendered as a metadata header above the note.
- **Deep-linkable URLs:** `/dashboard#vault?root=<slug>&path=<rel-path>` opens straight to a specific note. History is updated on every navigation so back/forward work.
- **New master tool `vault_link(note_path, root?)`** — returns the deep-link URL the master can include in chat or Telegram messages. Defaults `root` to `master` (the daemon's own vault). Reports whether the note actually exists at the resolved path.

### Out of scope for v2.5.0 (deferred per spec §3n)

- **Right-pane backlinks + outgoing-links panel.**
- **Search** (full-text + filename + tag filter).
- **Graph view.**
- **File-watching SSE** for live tree/note updates — currently refresh-on-click.
- **Edit-in-browser** — Vault viewer is read-only by design. The master writes via `vault_append`; humans edit via the Obsidian desktop app.

### Try it

```
# Sidebar → Vault. Pick the auto-created "master" vault.
# Browse the tree, click a note. Wikilinks navigate.
# Or jump directly:
#   http://192.168.100.98:8787/dashboard#vault?root=master&path=Down-Time-Arena/decisions.md
```

## [2.4.0] — 2026-05-10

Minor — Phase 3l ships (MVP): **document attachments in chat.**

### Added

- **Attachment storage layer** (`components/master/attachments.ts`): on-disk files under `~/.config/subctl/master/attachments/<date>/<id>-<filename>` plus an append-only `index.jsonl` of metadata. Each entry tracks id, filename, sha256, size, mime, source (`upload` / `paste` / `tool`), created/deleted timestamps. Soft-delete in index, hard-delete the file. 5 MiB per-attachment cap; mime allowlist covers text/* + JSON/YAML/TOML/XML/script types (PDF + images deferred to Phase 2).
- **Master HTTP endpoints**:
  - `POST /attachments` (raw bytes; metadata via `X-Filename` / `X-Mime` / `X-Source` headers) → `{id, filename, size, mime, sha256}`
  - `GET /attachments` → list metadata
  - `GET /attachments/<id>` → file bytes with proper mime
  - `DELETE /attachments/<id>` → soft-delete + remove on-disk file
- **`POST /chat` now accepts `attachments: [id…]`**. Server resolves each id, wraps content in fenced `<attachment id="…" filename="…" size="…" mime="…">…</attachment>` blocks, prepends to the prompt the model sees. Empty `text` is fine if at least one attachment is present.
- **Two new master tools** (`components/master/tools/attachments.ts`):
  - `read_attachment(id, start?, end?)` — re-read an attachment by id, with optional byte-range chunking. Use case: auto-compaction has dropped the original turn's inline content; this tool lets the master re-fetch without forcing the operator to re-upload.
  - `list_attachments(filter_filename?, limit?)` — find an attachment id by filename substring when the operator references a document by name.

### Frontend

- **Paperclip button** next to the chat input opens a multi-file picker.
- **Drag-and-drop** anywhere on the chat panel highlights the input area and attaches dropped files.
- **Paste interception**: pasted text ≥ 4 KB is automatically uploaded as `paste-<timestamp>-<slug>.md` instead of going into the input. Smaller pastes pass through as normal.
- **Pill chips** above the input show each queued attachment (filename + size) with a × to remove before send. Cleared automatically after send.
- **Visible chat history** records each attachment as `📎 filename` plus any user text, so the transcript stays readable even though the model received the full inline content.

### Out of scope for v2.4.0

- PDF text extraction (`pdftotext`) — deferred. PDF mime not yet in the allowlist; ship after wiring extraction.
- Image vision — deferred until a vision-capable supervisor is wired (qwen-VL via LM Studio is the obvious path).
- `subctl master attachments gc` CLI verb — `gc()` exists in the module; wiring deferred.
- Subctl-side worker prompt augmentation (handing attachments to dev-team workers).

### Try it

```
# Drop a markdown file on the chat panel.
# Or paste a long block (>4KB) — auto-attaches.
# Or click 📎 → pick a file.
# Send. Master sees the content; transcript shows just the pill.
```

## [2.3.0] — 2026-05-10

Minor — Phase 3m ships (MVP): **multi-team camera view** in the Orchestration tab.

### Added

- **NVR-style grid of every active dev team's tmux pane** at the top of the Orchestration tab. Polls `/api/orchestration/captures` every 2 s while the tab is visible, renders ~22-row tiles per team in monospace. Tiles auto-fit via `grid-template-columns: repeat(auto-fit, minmax(420px, 1fr))` — 1 team gets a full-row tile, 2 sit side-by-side, 4 form a 2×2, etc.
- **Status pill per tile** — `active` (green, last activity <60 s), `idle` (gray, <15 min), `stale` (yellow, >15 min), `error` (red, last 10 lines match `/error|failed|fatal:/i`), `ended` (faded, session disappeared). Left border colour mirrors the pill so the grid is glanceable.
- **Click a tile to expand** — fills the viewport with a single team's pane content, larger font, full capture height. Esc / click-backdrop / ✕ closes. Polling continues on the expanded view so it stays live.
- **`GET /api/orchestration/captures`** bulk endpoint in dashboard: returns ANSI-stripped capture content for every tracked session in one call. `?lines=N` (default 40, clamped 8..200). Backed by a new `tmuxCaptureFrame(session, lines)` helper.
- **Tab-aware polling** — the grid only fetches while the Orchestration tab is visible (watched via `MutationObserver` on `body[data-active-tab]`). Saves network + tmux-capture cost when the operator is on Chat or any other tab.

### Out of scope for MVP (deferred per spec §3m)

- xterm.js per tile (real ANSI colour + ligatures) — Phase 2; current tiles use plain `<pre>` with ANSI stripped.
- SSE delta streaming — current implementation is plain polling at 2 Hz.
- Pinning, sound alerts, recording/replay, audio overlay.

## [2.2.0] — 2026-05-10

Minor — Phase 3k ships: **personality presets for the master daemon.**

### Added

- **Seven built-in voice presets**, each a short fragment (`components/master/personalities/<slug>.md`) describing the master's voice (tone, cadence, mannerisms). Persona — *what* the master is — stays fixed; personality is *how* it speaks. Built-ins: `straight-shooter` (default, current behavior), `witty`, `sarcastic`, `robotic`, `arnold` (inspired by, not a likeness), `elon` (inspired by, not a likeness), `hilarious`.
- **`components/master/personality.ts`** loader module. `readActivePreset()`, `buildPersonalityFragment()`, `setPreset()`, `describePresets()`. State at `~/.config/subctl/master/personality.json` — single key `preset`. `composeSystemPrompt()` reads on every turn so the change hot-swaps with no daemon restart.
- **Master HTTP endpoints:** `GET /personality` returns the active preset + catalog with previews. `POST /personality { preset }` swaps the active preset, logs to `decisions.jsonl`, broadcasts `personality_set` over SSE. Dashboard's existing `/api/master/*` auto-proxy makes both reachable at `/api/master/personality` for the browser.
- **CLI verb:** `subctl master personality {list,show,set}`. Goes through the daemon's HTTP endpoint so the change is audited and SSE-broadcast.

### Constraints (non-relaxable per preset)

Every preset fragment explicitly preserves the anti-hallucination rules from v2.1.3/v2.1.4. The runtime claim verifier still gates claims regardless of voice; the master SKILL's behavioral contract still applies. Personality changes *delivery*, not *behavior* — a sarcastic refusal is still a refusal, a witty one-liner about a tool call still needs the actual tool call.

### Out of scope for v2.2.0

- Dashboard Settings tile UI for personality picking — backend wired, UI lands in a follow-up patch.
- Per-channel personality (different voice on Telegram vs chat panel).
- User-authored / runtime-editable presets via the dashboard — Phase 1 ships built-ins only; community-contributed presets land via the plugin system (§3j).

### Try it

```
subctl master personality list
subctl master personality set sarcastic
# next chat message will come back in the new voice
subctl master personality set straight-shooter   # back to default
```

## [2.1.9] — 2026-05-10

Patch — dev-team tmux sessions spawn at 220×50 instead of default 80×24.

### Changed

- **`tmux new-session` in `providers/claude/teams.sh` now passes `-x 220 -y 50`.** Without these flags, detached tmux sessions default to 80×24 because the spawning shell has no controlling terminal. Claude Code's TUI lays out at 80 columns, which renders fine for an attached user but looks half-empty in the dashboard's wide tmux-preview modal — the right ~50% of the (now letterboxed) modal stayed blank because the captured content was genuinely 80 cols. 220×50 gives Claude Code enough horizontal room for tool-call blocks to render on single lines, plus 50 rows of scrollback context.

### Live fix applied on M3 Ultra

- The `claude-Down-Time-Arena` session was resized from 80×24 → 220×50 via `tmux resize-window`. Claude Code repaints on SIGWINCH so no work was lost; the next dashboard capture will show the wider layout. Future spawns pick up the change automatically from v2.1.9.

## [2.1.8] — 2026-05-10

Patch — modal width-variant CSS specificity fix.

### Fixed

- **`.modal-wide`, `.modal-narrow`, `.tmux-preview` were silently no-op'd by `.modal`.** All three modal size variants set `max-width` (and `tmux-preview` set `width`) but appeared *earlier* in the stylesheet than the base `.modal { width: 90%; max-width: 580px }` rule. Same selector specificity (single class) → source-order tiebreaker → `.modal` won → every modal stayed at 580px regardless of which variant class was applied. v2.1.7 attempted to widen the tmux-preview modal but the override silently lost, so the modal frame stayed narrow while the inner pane font/padding bumps from v2.1.7 made the pane wider than its container — caused horizontal-scroll overflow. Fixed with compound selectors `.modal.modal-wide`, `.modal.modal-narrow`, `.modal.tmux-preview` — one extra class bump in specificity, source order no longer matters.

### Notes

- Side benefit: the notice/confirm modal (uses `.modal-narrow`) was also rendering at 580px instead of 460px. Now it'll be the intended narrower size on the next reload.

## [2.1.7] — 2026-05-10

Patch — quality-of-life: tmux-preview modal is now bigger + letterboxed.

### Changed

- **tmux-preview modal width 1100px → 95vw (cap 1900px).** Operator request 2026-05-10: the View button on dev-team rows opens a captured-pane viewer; at the old 1100px width long lines wrapped awkwardly while the rest of the screen sat empty. Now the modal fills nearly the full viewport horizontally, capped at 1900px for ultrawide screens.
- **Pane area font 11.5px → 13px, min-height 360 → 520, max-height stays at 75vh.** Captures of 30+ rows of terminal output fit comfortably without scrolling, and the larger font reads cleanly at the wider modal size. Letterbox feel — wide and short, like a real terminal multiplexer view.

## [2.1.6] — 2026-05-10

Patch — modal stacking context fix.

### Fixed

- **Modals no longer get rendered behind the chat panel.** Operator inspector dive 2026-05-10: the tmux-preview modal's header was being overlapped by the chat input form below it in the DOM. The `.modal-backdrop` had `position: fixed; z-index: 1000` which *should* have layered it above, but some other paint context was pinning that layer behind the rest of the page. Two-layer fix: bumped the backdrop to `z-index: 9999` (safely above any other element in the document), and gave the inner `.modal` its own stacking context via `position: relative; z-index: 1` so its descendants always render above non-modal siblings regardless of DOM order.

## [2.1.5] — 2026-05-10

Patch — three dogfood-driven fixes.

### Fixed

- **Chat panel no longer overlaps the toolbar when conversation grows.** `.orchestration-screen` was using `min-height` instead of `height`, so as the chat history grew the screen container got taller than the viewport and the body scrolled — pushing the MODEL/APPLY/COMPACT/+NEW CHAT toolbar above the visible area. Switched to a fixed `height: calc(100vh - 56px - 48px)` + `overflow: hidden` on the parent, removed the now-redundant `max-height` magic-number on `.master-chat`, and let the `.master-log` flex bound itself with `overflow-y: auto`. Toolbar stays anchored at the top regardless of chat length.
- **Team activity now refreshes from real pane content, not tmux's window-focus signal.** v2.1.2 used `tmux #{window_activity}` which only updates on user-attach interactions — useless for a detached worker pane spewing output. The dashboard kept showing `1h05m ago` while the worker had clearly written 13 files in the last 30 minutes. Replaced with `tmux capture-pane -p` + content hashing per session: if the hash changed since the last watchdog tick, we bump `teamLastActivity` to now. Reliable signal regardless of attach state.

### Changed

- **Master SKILL gains rule #6: publish to `notify_dashboard` on meaningful events.** The dashboard's NOTIFICATIONS feed has been empty during the entire FOOTHOLD dogfood because the master only narrated progress in chat — never published. Rule #6 specifies the kinds (`spawn`, `milestone`, `blocked`, `escalation`, `decision`, `error`, `watchdog`) and the contract: ≤120-char summary, paired with chat messaging not in place of it. The verifier's `message-sent-claim` rule already partially enforces it; rule #6 names it explicitly.

## [2.1.4] — 2026-05-10

Patch — runtime claim-verification gate, Argent-style.

### Added

- **Post-turn claim verifier** (`components/master/verifier.ts`). After the master settles a turn, the runtime scans the assistant text for "claim triggers" (specific future check-in times, asserted team status, host-fact claims, message-sent claims, decision-logged claims) and checks each against tool calls made IN THE SAME TURN. If a claim isn't backed by the corresponding tool, the runtime feeds a synthetic `[verifier]` correction prompt and re-runs the turn. Capped at 2 corrections per original prompt to prevent loops; on giveup, the gap is logged to `decisions.jsonl` (`verifier_giveup`) and the response ships with the gap on record.
- **Five initial verification rules:**
  - `future-checkin-time` — "I'll check in N minutes" / "I'll follow up at T" → must have called `schedule_followup`
  - `team-status-claim` — "the team is making progress" / "team is stuck" → must have called `subctl_orch_status` or `subctl_orch_list`
  - `host-fact-claim` — "qwen is loaded" / "Docker is running" → must have called `system_lmstudio_models` or `system_tmux_sessions` etc.
  - `message-sent-claim` — "I sent a message to Jason" / "I nudged the team" → must have called `telegram_send` / `subctl_orch_msg` / `notify_dashboard`
  - `decision-logged-claim` — "I logged this to the vault" → must have called `vault_append` or `memory_remember`
- **`verifier_gap` SSE event** — broadcast when a gap is detected, surfacing in real time which rule fired and what the unbacked phrase was. Visible in `/api/master/events` and the dashboard's live activity feed.
- **`verifier_resolved` / `verifier_giveup` decision-log entries** — operator can grep `decisions.jsonl` to see how often the verifier had to intervene and which rules trip most.

### Why this exists

Operator pattern from ArgentOS, paraphrased 2026-05-10: *"If Argent tries to say something and can't prove it or back it up with actual tool use proof, Argent is looped back and gated. You'll hear her say 'oh you're right' and then the turn gets blocked."*

v2.1.3 added the `schedule_followup` tool + SKILL guidance — that's the polite layer ("please don't lie"). v2.1.4 adds the runtime gate ("you literally can't ship a lie without us catching it"). They reinforce each other. SKILL alone wasn't enough during dogfood — model produced a 15-min-checkin promise without scheduling. Verifier catches that pattern at the runtime level and re-runs the turn until backed by tool use OR explicitly logged as unverified.

### Notes

- The verifier skips itself for `[verifier]`, `[watchdog]`, `[scheduled]`, `[team-report]` prefixed prompts — those are runtime-internal, not operator-facing claims.
- Iteration cap is 2 — i.e., one correction loop maximum. If the model can't get its own claim backed after one pointed retry, the response ships with a `verifier_giveup` log entry rather than looping forever. Operator can grep that to see chronic offenders.
- Rules are extensible — add to `VERIFICATION_RULES` in `verifier.ts`. Keep `requires_any_tool` honest; over-strict rules (requiring tools that don't actually verify the claim) cause friction without quality gain.

## [2.1.3] — 2026-05-10

Patch — anti-hallucination scaffolding for the master daemon.

### Added

- **`schedule_followup` tool family** (`components/master/tools/scheduler.ts`). Three new master tools: `schedule_followup({in_minutes, summary, prompt})` writes a future self-prompt to `~/.config/subctl/master/followups.jsonl`; `list_followups` shows pending; `cancel_followup({id})` removes one. A new ticker in the master daemon polls every 60s, fires due followups as synthetic `[scheduled]` agent prompts. Survives daemon restarts (state is on disk).
- **Anti-hallucination rules section in master SKILL.md.** Five non-negotiable rules: (1) never promise a check-in time without first calling `schedule_followup`; (2) don't claim capabilities you don't have (no "background monitoring"); (3) verify host facts via `system_*` tools, don't recall; (4) keep workers moving through checkpoint questions instead of bouncing them back to the operator; (5) say "I don't know" rather than fabricating status. These override the rest of the SKILL when in conflict.

### Why this exists

Surfaced 2026-05-10 during the FOOTHOLD dogfood. After 39 minutes of silence, the master told the operator "I'll check in on it in 15 minutes" — but had no underlying timer behind that promise. The watchdog would have fired regardless, but the specific 15-minute commitment was hallucinated. Operator caught it: "It needs to be gated. The master shouldn't be able to lie even if it's just trying to keep me happy."

The fix gates the lie at the mechanism level. The master now has a real tool that backs timed promises with file-on-disk state. The SKILL update tells it to use the tool and not fabricate cadence. Future "I'll check at T" sentences are tied to a specific followup record the operator can inspect via `list_followups` — no record, no promise.

## [2.1.2] — 2026-05-10

Patch — watchdog cadence + activity signal.

### Changed

- **Watchdog defaults tightened.** Default `review_interval_minutes` 5 → 3, default `stall_detection_minutes` 60 → 15. Operators expect the master to notice within minutes when a worker goes silent; the previous 5/60 defaults were "check in once every 5 minutes, escalate after an hour" — too coarse for an active dogfood loop. The new defaults align with the dashboard's row-colour thresholds (yellow at 15min, red at 30min) — the master now catches a team transitioning into "yellow" rather than waiting for red. Operator can still override via `policy.global_defaults`.

### Added

- **Tmux window-activity as a fallback liveness signal.** Previously `teamLastActivity` was only updated by the inbox tailer, which meant a worker that was productively writing files but never self-reporting via inbox looked stale. Diagnosed during FOOTHOLD when the worker built `server-foothold/` over 25 min while the inbox stayed pinned at the spawn-seed timestamp from 14:13 — dashboard reported `30m ago` and a red staleness dot even though the worker had just paused waiting for the operator's `go`. The watchdog tick now calls `tmux list-windows -a -F '#{session_name}|#{window_activity}'` first and bumps `teamLastActivity` to the latest tmux activity timestamp for any session whose window has been touched more recently. Inbox events still take precedence when present; tmux only fills the gap.

## [2.1.1] — 2026-05-10

Patch — chat-toolbar overflow into right sidecar.

### Fixed

- **Chat toolbar no longer spills into the dev-teams panel.** The toolbar's `display: flex` had no `flex-wrap`, and the child min-widths (model selector 280px, ctx meter 220px) summed to more than the chat column on typical viewports. With no wrap, no overflow clip, the ctx pill `ctx 33,422 / 65,536 tok (51%)` rendered on top of the team name `claude-Down-Time-Arena` in the right sidecar. Added `flex-wrap: wrap` + `overflow: hidden` on the toolbar, and reduced `chat-model-select` min-width from 280px → 220px so the row fits on a single line at most viewport widths and wraps gracefully when it can't.

## [2.1.0] — 2026-05-10

Minor — close the dogfood-exposed gap where the subctl-built skills and slash commands lived only on the operator's laptop. Fresh installs now get them automatically. New: `orchestrator-mode` skill in repo, `/team` slash command in repo, and `subctl install` symlinks all repo skills + commands into every per-account cfg_dir.

### Added

- **`components/skills/orchestrator-mode/SKILL.md`** — the multi-pane orchestrator + team-agent protocol. Critical: it includes the `SUBCTL_AGENT_ROLE=worker` activation guard that prevents the orchestrator-mode-deadlock pattern (workers self-loading the orchestrator role and waiting forever for approval to dispatch sub-workers they have no right to dispatch). Diagnosed and solved 2026-05-09 in the master/lead-deadlock incident.
- **`providers/claude/commands/team.md`** — the `/team` slash command. Routes to the `orchestrator-mode` skill.
- **`subctl_settings_install_claude_dir` now symlinks the repo's full skill + command catalog into every Claude cfg_dir.** Iterates every directory in `components/skills/` (excluding `master`, which is the daemon's own system prompt and would confuse workers) and every `.md` in `providers/claude/commands/`. Idempotent — symlinks overwrite cleanly, operator-personal skills/commands not in the repo are untouched. Each per-account cfg_dir now has `subctl`, `autonomy`, and `orchestrator-mode` available the moment it's created.

### Notes

- Only ships content I created for subctl. Sub-agents like `bug-analyzer` / `code-reviewer` / `dev-planner` (dated 2026-01-30, pre-subctl) and slash commands like `/commit` / `/code-review` / `/security-review` are operator-personal — they stay in `~/.claude/` and don't get pulled into the repo.
- Workers spawned via `subctl orch spawn` on a fresh install (e.g., the M3 Ultra) will now have `subctl`, `autonomy`, and `orchestrator-mode` in their skill catalog. Verifiable via "what skills do you have?" in a worker's chat.
- The master daemon's own SKILL (`components/skills/master/`) is intentionally excluded from the worker symlink loop — only the daemon process loads it via `components/master/server.ts`, never a worker. A worker that thought it was the master would loop into bad coordination patterns.

## [2.0.5] — 2026-05-10

Patch — three operator-reported bugs from continued FOOTHOLD dogfood, plus a roadmap entry that captures the bigger gap they exposed.

### Fixed

- **Stop hook self-heals stale paths.** `subctl_settings_install_claude_dir` previously merged a new Stop hook entry into `settings.json` only if no entry already pointed at the expected path — but didn't *rewrite* entries pointing at OTHER `log-rate-limits.sh` paths. The result, on systems migrated from older alias names (`claude-personal`, `claude-work`, `claude-overflow`), was Stop hooks pointing at non-existent scripts in the old alias dirs, generating "No such file or directory" errors after every Claude Code turn. The merge now rewrites any `log-rate-limits.sh` command path to the current cfg_dir before deciding whether to append a new entry. Idempotent — a re-run on a clean install is a no-op.
- **Chat-panel right sidecar no longer truncates.** The `1fr 320px` grid let the chat toolbar's wide content (model selector + apply + compact + new chat + fullscreen + ctx meter + supervisor label) push the sidecar past the viewport edge, clipping "ACTIVE DEV TEAMS", "claude-Down-Time-Arena", and the Notifications header. Bumped the sidecar to 360px, set `minmax(0, 1fr)` on the main track, added `min-width: 0` on master-chat and the sidecar, and added `word-break: break-word` to team rows so long session names wrap rather than overflow.
- **Live-fix on M3 Ultra:** rewrote the three per-account `settings.json` Stop hook paths from the stale alias dirs to the actual cfg_dirs. The next `subctl install` run will keep them correct via the self-heal logic above.

### Notes

- The hook-path bug exposed a much bigger gap, captured as Phase 3o in `docs/master.md`: a chunk of the operator's `~/.claude/` baseline (skills, slash commands, sub-agents, default permissions) is on the laptop but not in the repo, so fresh installs miss it. Audit complete in the doc; no code shipped — sanitizing operator-specific content before committing skills like `subctl` and `orchestrator-mode` requires manual review.

## [2.0.4] — 2026-05-10

Patch — Docker becomes a first-class hard requirement. Surfaced during the FOOTHOLD dogfood when the worker hit the dockerode hello-world step, found Docker Desktop wasn't running, and correctly stopped to ask the operator instead of failing silently.

### Added

- **Docker check in master `/diag`.** New 6th component check. Distinguishes binary-missing (`docker --version` non-zero) from daemon-not-running (`docker info` non-zero) so the suggested action is actionable: install Docker Desktop vs. `open -a Docker`. Surfaces both in the dashboard's diagnostics panel.
- **Docker in dashboard install-checks.** Added to `/api/settings/install-checks` as a required tool with `brew install --cask docker` as the install command, and fallback paths covering Docker Desktop's bundled binary location (`/Applications/Docker.app/Contents/Resources/bin/docker`).

### Notes

- The check intentionally splits "installed" (install-checks tile) from "running" (/diag tile). After a reboot, Docker Desktop is typically installed but not auto-started; the install-checks tile stays green while /diag flips red. This is the right shape — install state is durable, daemon state is transient.
- A dev team that needs Docker should call out the dependency in its boot prompt or first task. The FOOTHOLD spec already does this in §8 and §13. Future templates that involve containerized workers should follow suit.

## [2.0.3] — 2026-05-10

Patch — fix `subctl usage` and the dashboard's per-account 5h/week columns for Claude Code 2.x. Diagnosed during the FOOTHOLD dogfood when every account row in the Accounts table showed `—` for utilization despite all dispatch verdicts saying GO and a worker actively running on `claude-jason`.

### Fixed

- **`subctl_usage_bearer` now reads Claude Code 2.x file-based credentials.** Claude Code 2.x writes per-account OAuth tokens to `<cfg_dir>/.credentials.json` (mode 600) instead of the macOS Keychain. The previous implementation only knew the 1.x scheme — sha256(cfg_dir)[0:8] as a suffix on `Claude Code-credentials-<hash>` — so it found nothing for any account, `subctl usage --json` returned `ok: false` everywhere, and the dashboard's polling loop logged empty snapshots. The bearer lookup is now ordered: (1) `<cfg_dir>/.credentials.json`, (2) hashed Keychain entry (1.x), (3) unsuffixed Keychain entry (1.x default cfg_dir). First match wins.
- **`subctl doctor` reports the new credential path correctly.** The "Keychain bearers" section is renamed "Credentials" and reports `file=...` for 2.x entries, `keychain=...` (with a "legacy 1.x" tag) for old entries, and a clearer "re-run subctl auth" hint when neither is present.

### Notes

- No re-auth required. Claude Code 2.x has been writing `.credentials.json` for every alias all along; subctl just wasn't reading it.
- The Anthropic `/api/oauth/usage` endpoint hasn't changed — only the bearer lookup did. After updating, expect 5h and weekly utilization columns to populate within ~5 min (next dashboard poll cycle) or immediately after clicking the ↻ refresh button on the Accounts header.

## [2.0.2] — 2026-05-10

Patch — two operator-reported bugs from the FOOTHOLD dogfood test, both around observability of the master's own actions.

### Fixed

- **Spawned teams now register in `teamLastActivity` immediately.** Previously `subctl_orch_spawn` and `subctl_orch_spawn_template` created the tmux session and returned, but the master's tracking map was only populated by inbox events written by the worker itself. A worker that booted into Claude Code and sat at an empty prompt never wrote to its inbox, so `/health` reported `teams_tracked: 0` and the dashboard's Orchestration tab showed "no dev teams running" despite a live tmux session with the worker visible to `subctl orch list`. Both spawn tools now seed the inbox with a synthetic `{kind: "spawned"}` event on success — the existing inbox tailer picks it up and the team appears in the master's tracking on the next file-watch tick.
- **Setting the Obsidian vault root from Settings now auto-bootstraps the vault structure.** Previously, saving `~/Documents/Obsidian Vault` as the vault root just wrote `obsidian.json` and left the directory empty. The Memory tab then reported "Obsidian installed, no vault detected" and asked the operator to mkdir `.obsidian/` manually. The POST /api/settings/obsidian endpoint now creates `<root>/master/.obsidian/` plus a `welcome.md` introducing the vault — Obsidian-the-app and the dashboard both recognize it as a real vault on first save. Pass `{bootstrap: false}` if you want the legacy "config-only" behavior.

### Notes

- The team-registration fix is defense-in-depth alongside the master's own self-correction loop (`subctl_orch_status` + `subctl_orch_msg`). The master can already nudge a stuck worker via msg(); now `/health` and the Orchestration tab also reflect that team's existence rather than reporting zero teams.
- Watchdog visibility (showing last-tick timestamps even when no team is stale) is queued as a separate observability improvement — see Phase 3m design.

## [2.0.1] — 2026-05-10

Patch — guards the supervisor switch so users can't pick a provider that pi-ai doesn't have an api factory for. Reported by Jason after switching the chat panel's supervisor to "OpenAI Codex (ChatGPT)" and getting silent empty responses on every prompt.

### Fixed

- **`/api/master/supervisor` no longer accepts unwired providers.** The chat panel previously offered `openai-codex` as a supervisor option, but no provider package implements it (`providers/openai/README.md` flags it as v1.1 work). Selecting it wrote the value to `providers.json` and bounced the daemon, after which every chat turn returned empty assistant content because pi-ai's stream factory found no api in the registry. The endpoint now rejects with `400 { ok: false, error: "provider X is not wired into pi-ai yet", hint: "<list of wired providers>" }` for any provider outside the wired allowlist.
- **Chat-model selector marks unwired cloud providers disabled.** The dropdown still lists them (so users see what's coming) but the `<option>` is `disabled` with a `title` attribute pointing at the README. Wired providers render normally.

### Notes for the operator

- If the chat panel ever silently produces empty responses again, check `~/.config/subctl/master/decisions.jsonl` for `prompt_error_chat: No API key for provider: …`. That's the canary — it means pi-ai fell through the api lookup.
- The `WIRED_PROVIDERS` allowlist in `dashboard/server.ts` must stay in sync with `PROVIDER_API` in `components/master/server.ts`. Changes to one require changes to the other.

## [2.0.0] — 2026-05-10

Phase 3 — the master daemon goes live. subctl is no longer just a control plane for Claude accounts; it now hosts a persistent conversational orchestrator that spawns dev teams, talks to you over the dashboard chat panel and Telegram, and curates its own memory across three tiers. The dashboard navigation collapses from a tab strip into a 12-item sidebar.

This is a major bump because the architecture, not just the surface, changed: a new daemon, a new persistent agent, a new memory model, a new plugin contract, and a new conversational UI. Subscription accounting (the original 1.x scope) still works exactly the same.

### Added

- **`subctl master` daemon** — pi-agent-core-based persistent orchestrator on `127.0.0.1:8788`. Loads `providers.json` + `policy.json` + the master SKILL prompt, exposes HTTP/SSE so the dashboard chat tab and Telegram listener share a single agent transcript. Auto-started by `com.subctl.master.plist`.
- **44 master tools across 13 families** — `subctl_orch_*` (spawn/list/preview/attach/send), `gh_*`, `coderabbit_*`, `telegram_*`, `system_*` (host introspection), `project_*` (vault-bound project + spec scaffolding), `memory_*` (claude-mem worker queries), `context7_*` (docs RPC), tier-1 `memory_*` (always-in-context user.md + memory.md curators), `skill_*` (master-source skill authoring with category allow-list), `notify_dashboard` (curated event feed), `specforge` (5-stage intake state machine).
- **Three-tier memory architecture** — tier-1 always-in-context (`<memory-context>` blocks built from `user.md` + `memory.md`, ~3500 chars), tier-2 semantic (claude-mem worker at `localhost:37701`), tier-3 long-form (Obsidian vault). System prompt is composed per-prompt via `composeSystemPrompt()` so memory edits land on the very next agent turn.
- **Spec Forge** — 5-stage state machine (`project_type_gate → intake_interview → draft_review → awaiting_approval → approved_execution`) mirroring ArgentOS's specforge-conductor. Persists state to `~/.config/subctl/master/specforge/<key>.json` and writes approved specs to `<vault>/<project_name>/SPEC.md`.
- **Dashboard sidebar UI** — `Chat / Orchestration / Dashboard / Projects / Teams / Claude Sessions / Models / Providers / Memory / Skills / Live Logs / Settings`. Persistent chat panel with rehydrate, ctx meter, compact button, new-chat, fullscreen mode, model selector (cloud + LM Studio optgroups, ●/○ availability dots).
- **Team templates** — JSON manifests under `~/.config/subctl/teams/<name>.json` defining persona + skills + tools + autonomy + boot_prompt. `subctl teams claude --template <name>` and `subctl orch spawn` both honor templates; `_provider_claude_apply_template` copies skills into the worker's `cfg_dir`.
- **Personal skill authoring** — `skill_create` / `skill_revise` / `skill_remove` constrained to the master skill source with a category allow-list (`team-coordination`, `escalation-patterns`, `code-review-synthesis`, etc.) and a description-keyword filter. All writes audited to `decisions.jsonl`.
- **Plugin system** — `subctl plugins {list,install,remove,status,show}` with manifest `subctl.plugin.json` (id, kind, configSchema, tools, skills, tabs, verbs). Mirrors ArgentOS's manifest pattern. Plugins live under `~/.config/subctl/plugins/<id>/`.
- **Notifications sidecar** — curated event feed (`spawn`, `blocked`, `done`, `milestone`, `escalation`, `decision`, `watchdog`, `memory`) replacing raw activity logs. `notify_dashboard` tool persists to `notifications.jsonl` and broadcasts over SSE.
- **Codex provider** — first-class auth via `subctl auth openai`. Detects SSH (`SSH_CONNECTION` / `SSH_CLIENT`) and routes to `codex login --device-auth` so headless installs don't deadlock on a browser flow.
- **Context7 integration** — docs RPC against `mcp.context7.com/mcp` with `CONTEXT7_API_KEY`. `_provider_claude_drop_mcp_config` writes per-team `.mcp.json` so dev workers get docs out of the box.
- **`subctl update`** — canonical pull-and-restart workflow (`lib/update.sh`). Verifies clean tree, fast-forwards origin/<branch>, runs `bun install` where `package.json` changed, bounces launchd services, runs `subctl doctor`. `--force` stashes; `--no-restart` leaves services alone. Shows `vOLD → vNEW` delta + summary of incoming commits.
- **`VERSION` file** — single source of truth at repo root. `lib/core.sh`, `bin/subctl`, dashboard, and master daemon all read from it. `subctl version` now also prints the git branch + short SHA + dirty flag.
- **Tmux preview + ssh attach** — `subctl orch view <team>` captures a tmux pane, dashboard renders it in a modal. Attach button shells into the same session.
- **LM Studio context auto-pin** — `ensureModelLoaded()` calls `/api/v1/models/load` with explicit `context_length` at boot, on supervisor switch, and via `/reload-supervisor`. Stops the recurring "context resets to 4K on JIT load" failure mode.
- **Auto-compact watchdog** — 5-minute interval (configurable via `compact.json`). Compacts via `/transcript/compact` with `target_tokens` + `keep_recent` params; returns `noop:true` for short transcripts so the UI shows an info notice instead of an error.
- **Telegram bidirectional** — outbound via `telegram_*` tools, inbound via the master notify listener. Single transcript, two surfaces.
- **`docs/master.md`** — canonical architecture document (mental model, components, memory architecture, roadmap, operational reference, glossary, decision log).

### Changed

- **Deploy workflow is canonical-git only.** Previously, in-flight iterations sometimes shipped via `rsync` to remote hosts; this is no longer supported. The only path is: commit + push → `subctl update` on each host. Branches are tracked properly; the M3 Ultra and laptop checkouts now diverge only via committed history.
- **`/health` and state.json** report the live `SUBCTL_VERSION` instead of the hardcoded `"0.1.0"` placeholder.
- **Dashboard `Bun.serve` `idleTimeout: 0`** — previously the default 10 s was killing SSE proxy connections, causing the connection pill to flap CONNECTED ↔ RECONNECTING when chat was idle.
- **Notice modal** replaces browser `alert()` / `confirm()` in the chat and orchestration surfaces; cancel button is hidden via both `hidden` attribute and `display: none` (belt-and-braces, since some browsers honor only one).
- **install-checks PATH** extended with `~/.bun/bin`, `~/.local/bin`, `~/.lmstudio/bin`, `~/.cargo/bin` plus per-tool `fallback_paths`, so launchd-launched dashboards find user-installed binaries.
- **`accounts.conf` parser** switched from tab-delimited to pipe-delimited to match the actual file format.

### Fixed

- **`pi-ai` empty responses** — diagnosed 2026-05-09: built-in providers are NOT registered as a side effect of `import`; `registerBuiltInApiProviders()` must be called explicitly at boot. Without it, every `agent.prompt()` returned an empty content array because the stream factory found no api in the registry.
- **`writeFileSync` ReferenceError** in `/api/master/supervisor` (missing require fixed).
- **`lms --version` ANSI banner** stripped via `stripAnsi()` helper.
- **claude-mem detection via CLI probe** replaced with plugin-dir presence check at `~/.claude/plugins/marketplaces/thedotmack`.
- **OAuth row hardcoded `subctl auth claude`** for all providers — now uses each account's actual provider field.
- **Pulse-dot blinking on every WS message** — only flashes when state signature actually changes.
- **Chat doesn't auto-scroll to bottom on load** — fixed via double-`requestAnimationFrame` + `MutationObserver` on tab switch.

### Removed

- **rsync-based deploy paths.** No more out-of-band file shipping to remote subctl installs. Use `subctl update`.

## [1.0.0] — 2026-05-05

First stable release. The 0.x series stabilized into a single coherent multi-account control plane for Claude Code, covering accounts, auth, sessions, projects, teams launcher, dashboard, radar, and statusline — all integrated against the same filesystem-derived state model.

### Added

- **`subctl projects`** — declarative per-account project bindings + bulk launcher.
- **`subctl sessions`** — list and adopt orphaned Claude transcripts across every configured `cfg_dir`.
- **`subctl session-kill` / `subctl session-prune` / `claude-kill` shim** — surgical session cleanup.
- **Cost analysis** — API list-price savings vs subscription cost, surfaced in the dashboard.
- **24-hour utilization history** with per-account event attribution.
- **Per-account dispatch readiness** via `/api/oauth/usage`.
- **Dashboard polish bundle** — Mintlify-style docs, kill button, countdowns, notifications, best-account hint, copy `claude-use`, expanded doctor output, `$1,234.56` currency formatting, `/help` reference docs page.
- **Per-account experimental teams runtime** — `subctl_settings_ensure_teams` seeds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and `teammateMode=tmux` into each account's `settings.json`, and the tmux session env now carries the experimental flag. `Team*` / `SendMessage` tools and `Agent(team_name=…)` now surface no matter how the account is launched.
- **Defensive tmux ergonomics in `provider_claude_teams`** — ensures `mouse on` and idempotent `WheelUpPane` / `WheelDownPane` bindings on the tmux server, so two-finger trackpad scroll reaches tmux's scrollback even from inside a Claude Code TUI pane. Idempotent — only writes bindings if not already present.
- **`START-HERE.md`** — one-shot Claude-Code-pasteable install prompt for new Macs.

### Changed

- **`subctl install` now wires statusline + Stop hook into every Claude config dir**, not just `~/.claude`. Each per-account `settings.json` gets its own `statusLine` pointing at its own per-dir scripts. Previously only the default `~/.claude` was patched, so the radar bar never appeared under `claude-use <alias>` because Claude Code reads from the per-account config dir.
- **`subctl accounts add`** wires the new account's config dir immediately; no `subctl install` re-run required.
- **`subctl doctor`** iterates every Claude config dir and reports per-dir statusLine state + symlink integrity.
- **Usage cache TTL bumped to 5 min**, with a manual `POST /api/refresh` for force-refresh.

### Fixed

- **Statusline missing in alias-launched sessions** — see "Changed" above.
- **`claude()` shell guard** now passes through subcommands and non-interactive flags, so `claude --version`, `claude doctor`, etc. work uninterrupted.
- **Dashboard ctx %** auto-detects 1M-context model variants instead of assuming 200k.
- **Dashboard rate-limit verdict** reflects honest signal rather than aggregate noise; events table cleaner.

## [0.4.2] — 2026-05-04

Dashboard rebuild + tmux PATH fix.

## [0.4.1] — 2026-05-04

`deck` (Go + Bubble Tea TUI) restored after the v0.4.0 rip-out turned out to be premature.

## [0.4.0] — 2026-05-04

Dropped the Go-based deck TUI in favor of `sesh` integration. Reverted in 0.4.1.

## [0.3.0] — 2026-05-04

`subctl deck` — Go + Bubble Tea live session manager TUI.

## [0.2.0] — 2026-05-04

First-class shims for `claude-teams`, `claude-radar`, `claude-dash`.

## [0.1.0]

Initial multi-account isolation, statusline, and Stop hook for Claude Code.
