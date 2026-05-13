// dashboard/__tests__/icons.test.ts
//
// v2.7.25 (Scope A, ADR 0016) — Lucide icon helper pins.
//
// dashboard/public/icons.js is a static-SVG helper. Tests assert:
//   1. Known icons round-trip to a non-empty SVG string
//   2. The bell-replacement icon (inbox) is in the catalog
//   3. Severity-glyph icons used by the notification surface are
//      present (info / alert-triangle / alert-octagon)
//   4. listIcons() lists all known names
//   5. Unknown names return '' (so template literals stay safe)
//   6. opts.size / opts.className / opts.strokeWidth take effect
//
// We load the module via the same path the dashboard would: in the
// repo it's an ESM file at dashboard/public/icons.js. bun test
// imports it directly — no DOM needed.

import { describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — JS module, not typed
import { icon, listIcons } from "../public/icons.js";

describe("icon()", () => {
  test('icon("inbox") returns a valid <svg> containing a path', () => {
    const out = icon("inbox");
    expect(out).toContain("<svg");
    expect(out).toContain('class="lucide lucide-inbox');
    // The Lucide inbox icon has a polyline + path.
    expect(out).toContain("<polyline");
    expect(out).toContain("</svg>");
  });

  test('the severity icons used by the notification dropdown are all present', () => {
    for (const name of ["info", "alert-triangle", "alert-octagon"]) {
      const out = icon(name);
      expect(out).toContain("<svg");
      expect(out).toContain("lucide-" + name);
    }
  });

  test('the bell-replacement icon (inbox) is in the catalog', () => {
    expect(listIcons()).toContain("inbox");
  });

  test('icon("x") for dismiss / close buttons returns an X svg', () => {
    const out = icon("x");
    expect(out).toContain("<svg");
    expect(out).toMatch(/M18 6 6 18/);
  });

  test('unknown icon name returns "" so it slots safely into template literals', () => {
    expect(icon("not-a-real-icon")).toBe("");
    expect(icon("")).toBe("");
  });

  test("opts.size scales the outer svg", () => {
    const small = icon("inbox", { size: 12 });
    expect(small).toContain('width="12"');
    expect(small).toContain('height="12"');
    const big = icon("inbox", { size: 24 });
    expect(big).toContain('width="24"');
    expect(big).toContain('height="24"');
  });

  test("opts.className appends after the default class names", () => {
    const out = icon("inbox", { className: "notif-extra" });
    expect(out).toContain('class="lucide lucide-inbox notif-extra"');
  });

  test("opts.strokeWidth overrides the default 2", () => {
    const out = icon("inbox", { strokeWidth: 1.5 });
    expect(out).toContain('stroke-width="1.5"');
  });

  test("the upstream-card uses lucide-package — make sure it's available", () => {
    expect(listIcons()).toContain("package");
    expect(icon("package")).toContain("<svg");
  });

  test('the copy-prompt button uses lucide-clipboard — make sure it is available', () => {
    expect(listIcons()).toContain("clipboard");
    expect(icon("clipboard")).toContain("<svg");
  });

  test('listIcons() returns a non-empty array of strings', () => {
    const names = listIcons();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(typeof n).toBe("string");
  });
});
