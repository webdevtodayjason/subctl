// dashboard/__tests__/catalogs.test.ts
//
// v2.8.9 — Pure-function coverage for the catalog data layer. Live-fetch
// paths (refreshAnthropic, refreshOpenAI, refreshGoogle, refreshMistral,
// refreshOpenRouter) are NOT exercised here — they hit real provider APIs.
// We cover:
//
//   1. fromPiAiBundle — materialises a CatalogFile from pi-ai's bundled data
//   2. fromPiAiBundle — resolves legacy aliases (claude → anthropic)
//   3. fromPiAiBundle — returns empty models for unknown providers
//   4. saveCatalog + loadCatalog — round-trips identical CatalogFile shape
//   5. loadCatalog — returns null for missing or malformed files
//   6. isKnownProvider — accepts pi-ai canonical + legacy aliases
//   7. isKnownProvider — rejects garbage

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fromPiAiBundle,
  loadCatalog,
  saveCatalog,
  isKnownProvider,
  listCachedCatalogs,
  type CatalogFile,
} from "../lib/catalogs.ts";

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "subctl-catalogs-test-"));
  process.env.SUBCTL_CONFIG_DIR = scratchDir;
});

afterEach(() => {
  delete process.env.SUBCTL_CONFIG_DIR;
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("fromPiAiBundle", () => {
  test("materialises a CatalogFile for a real pi-ai provider", () => {
    const cat = fromPiAiBundle("anthropic");
    expect(cat.provider).toBe("anthropic");
    expect(cat.source).toBe("pi-ai-bundle");
    expect(cat.models.length).toBeGreaterThan(0);
    // First model has the expected fields
    const m = cat.models[0];
    expect(typeof m.id).toBe("string");
    expect(m.id.length).toBeGreaterThan(0);
    expect(typeof m.name).toBe("string");
    expect(m.enabled).toBe(true);
  });

  test("populates context_window when pi-ai has it", () => {
    const cat = fromPiAiBundle("anthropic");
    const withCtx = cat.models.find((m) => typeof m.context_window === "number");
    expect(withCtx).toBeDefined();
    expect(withCtx!.context_window).toBeGreaterThan(0);
  });

  test("resolves legacy alias claude → anthropic", () => {
    const viaAlias = fromPiAiBundle("claude");
    const viaCanonical = fromPiAiBundle("anthropic");
    expect(viaAlias.provider).toBe("anthropic"); // canonical id returned
    expect(viaAlias.models.length).toBe(viaCanonical.models.length);
  });

  test("returns empty models for an unknown provider", () => {
    const cat = fromPiAiBundle("definitely-not-a-real-provider");
    expect(cat.provider).toBe("definitely-not-a-real-provider");
    expect(cat.models).toEqual([]);
    expect(cat.source).toBe("pi-ai-bundle");
  });

  test("fetched_at is a parseable ISO timestamp", () => {
    const cat = fromPiAiBundle("anthropic");
    const parsed = new Date(cat.fetched_at);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
  });
});

describe("saveCatalog + loadCatalog", () => {
  test("round-trips a CatalogFile through disk", () => {
    const original: CatalogFile = {
      provider: "test-provider",
      fetched_at: "2026-05-16T12:00:00.000Z",
      source: "live-fetch",
      source_url: "https://example.com/v1/models",
      models: [
        {
          id: "test-model-1",
          name: "Test Model 1",
          context_window: 100_000,
          enabled: true,
        },
        {
          id: "test-model-2",
          name: "Test Model 2",
          context_window: 200_000,
          reasoning: true,
          cost: { input: 3, output: 15 },
          enabled: true,
        },
      ],
    };
    saveCatalog(original);
    const loaded = loadCatalog("test-provider");
    expect(loaded).toEqual(original);
  });

  test("loadCatalog returns null when file is absent", () => {
    expect(loadCatalog("never-saved")).toBeNull();
  });

  test("loadCatalog returns null when file is malformed JSON", () => {
    const catalogsDir = join(scratchDir, "catalogs");
    require("node:fs").mkdirSync(catalogsDir, { recursive: true });
    writeFileSync(join(catalogsDir, "broken.json"), "{not valid json{");
    expect(loadCatalog("broken")).toBeNull();
  });

  test("loadCatalog returns null when JSON lacks required fields", () => {
    const catalogsDir = join(scratchDir, "catalogs");
    require("node:fs").mkdirSync(catalogsDir, { recursive: true });
    writeFileSync(join(catalogsDir, "incomplete.json"), JSON.stringify({ foo: "bar" }));
    expect(loadCatalog("incomplete")).toBeNull();
  });

  test("saves to a sanitised filename — no path traversal", () => {
    // Funny provider name shouldn't escape the catalogs dir.
    const cat: CatalogFile = {
      provider: "..//escape//attempt",
      fetched_at: "2026-05-16T12:00:00.000Z",
      source: "pi-ai-bundle",
      models: [],
    };
    saveCatalog(cat);
    // The sanitiser strips non-[a-z0-9_-] chars; resulting filename should
    // live in the catalogs dir, not anywhere upward.
    const safeFile = join(scratchDir, "catalogs", "escapeattempt.json");
    expect(existsSync(safeFile)).toBe(true);
  });
});

describe("listCachedCatalogs", () => {
  test("returns empty array when catalogs dir is absent", () => {
    expect(listCachedCatalogs()).toEqual([]);
  });

  test("enumerates saved catalogs", () => {
    saveCatalog({
      provider: "alpha",
      fetched_at: "2026-05-16T12:00:00.000Z",
      source: "pi-ai-bundle",
      models: [{ id: "a", name: "A", enabled: true }],
    });
    saveCatalog({
      provider: "beta",
      fetched_at: "2026-05-16T12:00:00.000Z",
      source: "pi-ai-bundle",
      models: [{ id: "b", name: "B", enabled: true }],
    });
    const list = listCachedCatalogs();
    expect(list.length).toBe(2);
    const providers = list.map((c) => c.provider).sort();
    expect(providers).toEqual(["alpha", "beta"]);
  });
});

describe("isKnownProvider", () => {
  test("accepts pi-ai canonical ids", () => {
    expect(isKnownProvider("anthropic")).toBe(true);
    expect(isKnownProvider("openai")).toBe(true);
  });

  test("accepts subctl legacy aliases", () => {
    expect(isKnownProvider("claude")).toBe(true); // → anthropic
    expect(isKnownProvider("gemini")).toBe(true); // → google
  });

  test("rejects gibberish provider names", () => {
    expect(isKnownProvider("not-a-real-thing")).toBe(false);
    expect(isKnownProvider("")).toBe(false);
  });
});
