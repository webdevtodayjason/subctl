// dashboard/public/icons.js
//
// v2.7.25 — Lucide icon library, baked into static SVG strings.
//
// Why a string-returning helper (not the lucide runtime web component):
//
//   The dashboard frontend has no build step — index.html + app.js are
//   served verbatim from /Users/sem/code/subctl/dashboard/public/. The
//   existing code uses `element.innerHTML = template + …` and
//   `escapeHtml()` to render lists, dropdowns, and badges. A helper that
//   returns an SVG string drops straight into those template literals
//   without DOM-walking + replace_with passes (which is what
//   `lucide.createIcons()` does for `<i data-lucide="…">` placeholders).
//
//   The `lucide` npm package is still a real dependency of dashboard/ —
//   see dashboard/package.json. The SVG paths below are copied verbatim
//   from the published lucide v0.474.0 ESM build (MIT licensed). Adding
//   an icon means: import the file in dashboard/node_modules/lucide/
//   dist/esm/icons/<name>.js, copy the `<path …>` content into ICONS
//   below, ship.
//
// USAGE
// ─────
//
//   import { icon } from "/icons.js"; // module-style
//   // — or, in a non-module context (app.js currently isn't a module),
//   // the script tag at the top of index.html exposes window.subctlIcon.
//
//   icon("inbox")
//     → '<svg class="lucide lucide-inbox" …><polyline …/>…</svg>'
//
//   icon("inbox", { size: 20 })
//     → 20×20 instead of the 16×16 default
//
//   icon("x", { className: "notif-close", strokeWidth: 1.5 })
//     → adds class + thinner stroke
//
//   icon("not-a-real-icon")
//     → '' (empty string; safe in template literals)
//
// All icons inherit `currentColor` so a parent CSS rule like
// `.notif-item-glyph { color: var(--red); }` re-tints them without any
// per-icon override.
//
// ─────────────────────────────────────────────────────────────────────

// Inner SVG bodies (each is everything that sits inside the outer <svg>).
// Copied from lucide v0.474.0 / dist/esm/icons/*.js. If you bump the
// lucide pin and an icon changes, re-copy the body — no other file in
// this dashboard pulls these paths.
const ICONS = Object.freeze({
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  x:
    '<path d="M18 6 6 18"/>' +
    '<path d="m6 6 12 12"/>',
  clipboard:
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  "clipboard-check":
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<path d="m9 14 2 2 4-4"/>',
  info:
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M12 16v-4"/>' +
    '<path d="M12 8h.01"/>',
  "alert-triangle":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/>' +
    '<path d="M12 17h.01"/>',
  "alert-octagon":
    '<path d="M12.27 2.05a1 1 0 0 1 .69-.05l8 2a1 1 0 0 1 .73.84l1 8a1 1 0 0 1-.27.83l-8 8a1 1 0 0 1-1.42 0l-8-8a1 1 0 0 1-.27-.83l1-8a1 1 0 0 1 .73-.84l8-2Z"/>' +
    '<path d="M12 8v4"/>' +
    '<path d="M12 16h.01"/>',
  check:
    '<path d="M20 6 9 17l-5-5"/>',
  package:
    '<path d="m7.5 4.27 9 5.15"/>' +
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>' +
    '<path d="m3.3 7 8.7 5 8.7-5"/>' +
    '<path d="M12 22V12"/>',
  "refresh-cw":
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>' +
    '<path d="M8 16H3v5"/>',
  paperclip:
    '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.57 8.57a2 2 0 1 1-2.83-2.83l8.49-8.48"/>',
  bell:
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
});

// Default stroke for outline-style Lucide icons. lucide uses 2 by default.
const DEFAULT_STROKE = 2;

/**
 * Render a Lucide icon as an SVG string.
 *
 * @param {keyof typeof ICONS} name — icon id (kebab-case, matches Lucide
 *   docs at https://lucide.dev/icons)
 * @param {object} [opts]
 * @param {number} [opts.size=16] — outer SVG width/height in px
 * @param {string} [opts.className] — extra class names appended after
 *   the default `lucide lucide-<name>` pair
 * @param {number} [opts.strokeWidth] — override 2 for thinner/thicker
 * @param {string} [opts.color] — override `currentColor` (rare; pass a
 *   CSS class instead when you can)
 * @returns {string} SVG markup, or '' for unknown names
 */
function icon(name, opts) {
  const body = ICONS[name];
  if (!body) return "";
  const size = (opts && opts.size) || 16;
  const stroke = (opts && opts.strokeWidth) || DEFAULT_STROKE;
  const color = (opts && opts.color) || "currentColor";
  const extra = opts && opts.className ? " " + String(opts.className) : "";
  // viewBox 0 0 24 24 is the Lucide native canvas; we resize via the
  // outer width/height attributes so the strokes scale crisply.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" ' +
    'width="' + size + '" height="' + size + '" ' +
    'viewBox="0 0 24 24" fill="none" stroke="' + color + '" ' +
    'stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" ' +
    'class="lucide lucide-' + name + extra + '" aria-hidden="true">' +
    body +
    "</svg>"
  );
}

/**
 * List the known icon names — handy in tests and the rare runtime
 * "is X available" check.
 */
function listIcons() {
  return Object.keys(ICONS);
}

// app.js currently runs as a classic (non-module) script via
// <script src="/app.js"></script>, so we expose a small global handle.
// New code can `import { icon } from "/icons.js"` if it opts into
// modules; existing code reaches for `subctlIcon(...)`.
if (typeof window !== "undefined") {
  window.subctlIcon = icon;
  window.subctlListIcons = listIcons;
}

export { icon, listIcons };
