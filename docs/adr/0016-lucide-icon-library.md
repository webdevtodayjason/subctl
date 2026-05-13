# 0016: Lucide icon library — replace emoji across dashboard surfaces

- **Status:** Accepted (ships v2.7.25)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.25

## Context

v2.7.22 shipped the notification tray with a 🔔 emoji bell. Operator
reaction during the v2.7.25 spec session (2026-05-13):

> "Wingdings, crappy things like that."

The complaint generalises beyond the bell. Emoji-as-icons are at the
mercy of the operator's renderer:

- The same `🔔` codepoint renders gold + outlined on macOS Apple Color
  Emoji, flat + black on Windows Segoe UI Emoji, vector + colored on
  iOS, and as a glyph-fallback box on Linux without an emoji font.
- Some glyphs we used (`📎`, `🛡`, `📣`, `🎭`) ship as a
  text-presentation variant by default on certain platforms and only
  become "emoji-style" if followed by U+FE0F — which we don't add.
- Cross-platform consistency requires either a vendored emoji font or
  a real icon set.

We were already heading toward inconsistency because:

- `dashboard/public/tool-display.json` carries emoji for tool-family
  icons (🔧 system, 🖥 lmstudio, 🧠 knowledge, …) — operator-editable
  content config.
- `app.js` carries hard-coded emoji for chrome (bell, attach,
  verdict glyphs) — not config, just embedded strings.
- The sidebar nav uses unicode GEOMETRIC SHAPES (`◉ ⚙ ▣ ⌘ ▤ ≡ ◈ ◐ ⊞ ★
  ≣ ⛒ ⚒`) which RENDER consistently as glyphs (they're not emoji), but
  visually they're decoration of last resort.

The operator's complaint is specifically about the emoji-presentation
chrome — the bell, the attach pin, the close glyphs, the severity
indicators in the notification panel. Those are exactly the surfaces a
real icon library covers.

## Decision

Adopt **Lucide** as subctl's icon library. Lucide is the open-source
fork of Feather Icons that's now the de-facto modern choice (shadcn/ui,
Bun Examples, plenty of dashboards we've drawn inspiration from). MIT
licensed, ~1.3k icons, no runtime requirement beyond an SVG renderer.

Concretely for v2.7.25:

1. **Dependency** — `lucide` (NOT `lucide-react` — subctl's frontend is
   plain JS/HTML, no React) added to `dashboard/package.json`.

2. **Helper module** — `dashboard/public/icons.js`. Exports a
   string-returning `icon(name, opts?)` function and a `listIcons()`
   introspector. Module-style ES file, also assigns `window.subctlIcon`
   so the classic-script `app.js` can call it without an import.

3. **Approach: static-baked SVG, not runtime web component.** The
   helper carries the SVG body for each icon we use, with the outer
   `<svg viewBox="0 0 24 24">` wrapper templated around it. This fits
   subctl's existing serving pattern (no build step; files served
   verbatim from `dashboard/public/`) and slots straight into the
   existing `element.innerHTML = template + …` call sites that the
   dashboard uses everywhere. The Lucide runtime web component is a
   DOM-walker that finds `<i data-lucide="…">` placeholders and
   replaces them; that flow would require restructuring every render
   site, with no measurable benefit for a ~10-icon catalog.

   Adding a new icon: copy its SVG path body from
   `dashboard/node_modules/lucide/dist/esm/icons/<name>.js` into the
   `ICONS` table in `icons.js`. The `lucide` npm dependency is the
   source-of-truth checksum, so a future maintainer who needs to
   re-check a path can diff against the installed package.

4. **Audit + replacement (v2.7.25 scope A.3 + B.1)** — emoji used as
   CHROME (not content) replaced with Lucide:

   | Surface | Was | Now |
   |---|---|---|
   | Notification bell (topbar) | 🔔 | `inbox` (Lucide) |
   | Notification dropdown close | ✕ (text) | `x` |
   | Notification severity icons | ● ▲ · | `info` / `alert-triangle` / `alert-octagon` |
   | Notification per-row dismiss | "mark read" text button | `x` icon button |
   | Notification copy-prompt button | (new) | `clipboard` icon button |
   | Toast confirm checkmark | (new) | `check` |
   | Upstream-card row glyph | (new) | `package` |
   | Master chat attach button | 📎 | `paperclip` |

5. **Deliberately NOT replaced.** The audit identified these as
   leave-alone:

   - **Tool-family icons in `tool-display.json`.** This is
     operator-editable CONTENT config, not chrome. Forcing Lucide here
     would create a 2-step add-an-icon workflow (edit the config to
     reference a Lucide name; then make sure that name is in
     `icons.js`'s baked catalog). Out of scope.
   - **Sidebar nav glyphs.** Unicode geometric shapes (`◉ ⚙ ▣ ⌘ ▤ ≡ ◈
     ◐ ⊞ ★ ≣ ⛒ ⚒`) — they render consistently across all platforms
     because they're letters / dingbats, not emoji.
   - **Verdict glyphs.** 🟢 🟡 🔴 — These are colored content
     indicators in a `setText()` chain (the surrounding
     `.dispatch-verdict.green/yellow/red` CSS class already carries
     the color signal). Replacing them would require switching to
     `innerHTML` + escaping; the marginal benefit doesn't justify the
     churn.
   - **Modal close buttons (✕) elsewhere in the app.** Geometric
     unicode; renders consistently. Replacing every modal close would
     be a 40-line diff with no operator-visible improvement.
   - **Result-pill markers (✓ ✗).** Same reasoning — unicode glyphs
     that render consistently. The semantic colour comes from the
     surrounding `.chat-tool-pill--ok / --err` CSS.

## Reasoning

Four reasons to land on Lucide specifically + static-baked SVGs:

1. **Lucide is the modern standard.** shadcn/ui (the React UI kit we
   pattern-match against), Bun's own docs, Tailwind UI ship Lucide by
   default. Operators arriving from any of those ecosystems will
   recognise the style. Picking an obscure pack to differentiate would
   be vanity, not a feature.

2. **Static SVGs match subctl's serving model.** There is no build
   step. The dashboard runs `bun run server.ts` and serves files
   verbatim from `dashboard/public/`. Vendoring Lucide's
   `lucide.min.js` (90 KB) just to walk the DOM for ten icons is
   over-engineering. The baked-string approach adds ~3 KB to the
   icons.js file for the icons we actually use.

3. **No render-roulette across operator hosts.** Same operator opens
   the dashboard on Mac (Apple emoji), Linux (Noto Emoji or fallback
   square), iOS (vector emoji). An SVG icon renders identically.

4. **Trivial to test.** `icon(name)` returns a string. A test asserts
   the string contains `<svg`, the right class name, and a known path
   fragment. No DOM, no JSDOM, no Playwright.

## Consequences

### Positive

- Cross-platform consistency. The bell looks like the bell.
- Caller ergonomics: `innerHTML = "<div>" + icon("inbox") + "</div>"`
  works in the existing render pipeline; no DOM walks required.
- Color inheritance via `stroke="currentColor"` means a CSS class on
  the parent re-tints the icon — no per-icon override.
- Adding an icon is a 1-line patch to `ICONS` in `icons.js`. The
  `lucide` npm dep is the source-of-truth.
- `bun test` covers the helper without spinning up a browser.

### Negative

- Adding a new icon requires copy-pasting an SVG body from
  `node_modules/lucide/dist/esm/icons/<name>.js`. This is mechanical
  but unautomated — a forgetful maintainer might `import` a name in
  app.js that isn't in `ICONS`, and the icon would render as an empty
  string. Mitigation: the `dashboard/__tests__/icons.test.ts` suite
  asserts every name app.js currently uses is in the catalog.
- The `lucide` dep is installed but not loaded at runtime. That's
  intentional (the build-step-free serving model), but a maintainer
  could plausibly think it's vestigial. The doc comment at the top of
  `icons.js` explains.
- The audit deliberately leaves several emoji in place (verdict
  glyphs, tool-family icons, modal closes). A future operator might
  conclude the audit is incomplete. The "Deliberately NOT replaced"
  table above documents the reasoning.

## Alternatives considered

### Alternative A (CHOSEN): Lucide, static-baked SVG strings

Described above.

### Alternative B: Lucide runtime web component (`lucide.createIcons()`)

Replace `lucide` SVG strings with `<i data-lucide="inbox">` markers in
the HTML, load `lucide.min.js` at boot, call `lucide.createIcons()` to
swap markers for SVGs. This is the upstream-recommended flow for
no-build-step sites.

Rejected. (1) Adds a ~90 KB runtime dep for ten icons. (2) Forces every
render site to use DOM markers instead of template strings, which
clashes with the dashboard's existing `innerHTML = template + …`
pattern across `app.js`. (3) Re-running `createIcons()` after every
list re-render adds a DOM walk we don't otherwise need. The static
approach has none of these costs.

### Alternative C: Feather Icons (Lucide's predecessor)

Same look, but Feather has been in maintenance mode since 2021. Lucide
is the actively-maintained fork. No reason to pick the older one.

### Alternative D: An emoji-font shim (Twemoji, etc.)

Force the renderer to use a single emoji font everywhere via a CSS
`font-family` shim or a JS DOM-replace pass.

Rejected. Solves render-roulette but keeps EMOJI semantics — and the
operator's complaint was about emoji-as-icons in the first place.
Doesn't address the visual quality concern.

### Alternative E: Hand-rolled SVG sprite

Vendor a custom subctl-branded SVG sprite, ship a small `<use
href="#icon-inbox">` flow.

Rejected. Solves the same problem as Lucide but with custom artwork.
We don't have a designer; freebie Lucide icons look better than what
we'd draw, and they're consistent with the dashboards operators are
already used to.

## References

- Lucide: https://lucide.dev (MIT)
- `dashboard/public/icons.js` — helper module
- `dashboard/__tests__/icons.test.ts` — test suite
- `dashboard/package.json` — `"lucide": "^0.474.0"` dependency
- ADR 0015 — pi-ai + pi-agent-core first-class upstreams (the v2.7.24
  ADR; v2.7.25 ships this Lucide change + the upstream-tracker
  watchdog from that ADR's "open question" section)
- Operator session 2026-05-13: surfaced the "Wingdings" framing,
  approved a bundled v2.7.25 PR that ships icons + notification UX
  polish + upstream-tracker in a single commit.
