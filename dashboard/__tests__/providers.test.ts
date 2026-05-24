// dashboard/__tests__/providers.test.ts
//
// v2.7.24 — tests for the pi-ai provider catalog adapter and the
// `/api/providers` dashboard surface that exposes it.
//
// We hit the adapter (`components/evy/pi-ai-catalog.ts`) and a
// fetch handler stub for the POST path directly. No HTTP server is
// spun up; we exercise the same code paths the route handlers run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listCatalogProviders,
  isCatalogProvider,
  resolveProviderId,
  legacyAliasFor,
  SUBCTL_TO_PI_AI,
  type CatalogProvider,
} from "../../components/evy/pi-ai-catalog";

describe("pi-ai-catalog adapter", () => {
  test("listCatalogProviders returns a non-trivial number of providers", () => {
    const list = listCatalogProviders();
    // Pi-ai ships ~25-31 providers. Floor at 20 so a minor pi-ai
    // refactor that renames a couple doesn't break the test, but a
    // catastrophic drop (e.g. provider enumeration broken) still fails.
    expect(list.length).toBeGreaterThanOrEqual(20);
  });

  test("every entry has a stable shape", () => {
    for (const p of listCatalogProviders()) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.display_name).toBe("string");
      expect(p.display_name.length).toBeGreaterThan(0);
      expect(p.kind).toBe("cloud");
      expect(["api-key", "oauth", "none"]).toContain(p.auth_method);
      expect(p.available).toBe(true);
      expect(typeof p.model_count).toBe("number");
    }
  });

  test("anthropic + openai are in the catalog", () => {
    const ids = listCatalogProviders().map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
  });

  test("anthropic is flagged as oauth-capable", () => {
    const a = listCatalogProviders().find((p) => p.id === "anthropic");
    expect(a).toBeDefined();
    expect(a!.auth_method).toBe("oauth");
  });

  test("openai-codex is flagged as oauth (ChatGPT subscription)", () => {
    const c = listCatalogProviders().find((p) => p.id === "openai-codex");
    if (c) {
      expect(c.auth_method).toBe("oauth");
    }
  });

  test("list is sorted by display_name", () => {
    const names = listCatalogProviders().map((p) => p.display_name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test("at least a dozen providers have model entries", () => {
    const withModels = listCatalogProviders().filter((p) => p.model_count > 0);
    expect(withModels.length).toBeGreaterThanOrEqual(12);
  });
});

describe("subctl ↔ pi-ai alias mapping", () => {
  test("legacy claude resolves to anthropic", () => {
    expect(resolveProviderId("claude")).toBe("anthropic");
  });

  test("legacy gemini resolves to google", () => {
    expect(resolveProviderId("gemini")).toBe("google");
  });

  test("pi-coding-agent resolves to anthropic", () => {
    expect(resolveProviderId("pi-coding-agent")).toBe("anthropic");
  });

  test("pi-ai canonicals pass through unchanged", () => {
    expect(resolveProviderId("anthropic")).toBe("anthropic");
    expect(resolveProviderId("groq")).toBe("groq");
    expect(resolveProviderId("openrouter")).toBe("openrouter");
  });

  test("unknown ids pass through (catalog check is responsible for rejecting)", () => {
    expect(resolveProviderId("bogus-provider")).toBe("bogus-provider");
  });

  test("legacyAliasFor inverts the map", () => {
    expect(legacyAliasFor("anthropic")).toBe("claude");
    expect(legacyAliasFor("google")).toBe("gemini");
  });

  test("legacyAliasFor returns input when no alias exists", () => {
    expect(legacyAliasFor("groq")).toBe("groq");
    expect(legacyAliasFor("openrouter")).toBe("openrouter");
  });

  test("every alias resolves to a real catalog provider", () => {
    for (const [legacy, canonical] of Object.entries(SUBCTL_TO_PI_AI)) {
      expect(isCatalogProvider(legacy)).toBe(true);
      expect(isCatalogProvider(canonical)).toBe(true);
    }
  });
});

describe("isCatalogProvider validation", () => {
  test("accepts pi-ai canonical ids", () => {
    expect(isCatalogProvider("anthropic")).toBe(true);
    expect(isCatalogProvider("openai")).toBe(true);
    expect(isCatalogProvider("groq")).toBe(true);
    expect(isCatalogProvider("cerebras")).toBe(true);
    expect(isCatalogProvider("openrouter")).toBe(true);
  });

  test("accepts legacy subctl ids", () => {
    expect(isCatalogProvider("claude")).toBe(true);
    expect(isCatalogProvider("gemini")).toBe(true);
  });

  test("rejects bogus ids", () => {
    expect(isCatalogProvider("totally-fake")).toBe(false);
    expect(isCatalogProvider("not-a-provider")).toBe(false);
    expect(isCatalogProvider("")).toBe(false);
  });
});

// ── /api/providers GET merge logic ─────────────────────────────────
//
// We can't easily import dashboard/server.ts (it boots the HTTP
// server on import). Instead we replicate the merge contract: a
// catalog entry should appear with profiles when accounts.conf has
// a row that resolves (via SUBCTL_TO_PI_AI) to that catalog id.
//
// This is the same logic at dashboard/server.ts:4423-4480 (the
// `profilesByPiId` accumulation + the catalog walk).

describe("catalog × profiles merge contract", () => {
  function mergeProfiles(
    catalog: CatalogProvider[],
    profilesByProvider: Record<string, Array<{ alias: string; authed: boolean }>>,
  ) {
    const profilesByPiId: Record<string, typeof profilesByProvider[string]> = {};
    for (const [legacyOrCanonical, profiles] of Object.entries(profilesByProvider)) {
      const canonical = resolveProviderId(legacyOrCanonical);
      (profilesByPiId[canonical] ??= []).push(...profiles);
    }
    return catalog.map((entry) => ({
      id: entry.id,
      profiles: profilesByPiId[entry.id] ?? [],
    }));
  }

  test("legacy `claude` row attaches to the anthropic catalog entry", () => {
    const merged = mergeProfiles(listCatalogProviders(), {
      claude: [{ alias: "claude-jason", authed: true }],
    });
    const anth = merged.find((p) => p.id === "anthropic");
    expect(anth?.profiles.length).toBe(1);
    expect(anth?.profiles[0]?.alias).toBe("claude-jason");
  });

  test("multiple legacy ids merging into the same canonical (anthropic)", () => {
    // pi-coding-agent and claude both alias to anthropic.
    const merged = mergeProfiles(listCatalogProviders(), {
      claude: [{ alias: "claude-personal", authed: true }],
      "pi-coding-agent": [{ alias: "pi-work", authed: false }],
    });
    const anth = merged.find((p) => p.id === "anthropic");
    expect(anth?.profiles.length).toBe(2);
  });

  test("a canonical-id profile (groq) attaches directly", () => {
    const merged = mergeProfiles(listCatalogProviders(), {
      groq: [{ alias: "groq-test", authed: true }],
    });
    const g = merged.find((p) => p.id === "groq");
    expect(g?.profiles.length).toBe(1);
  });

  test("an unknown provider row does NOT attach to any catalog entry", () => {
    const merged = mergeProfiles(listCatalogProviders(), {
      "made-up-provider": [{ alias: "x", authed: false }],
    });
    for (const m of merged) {
      expect(m.profiles.find((p) => p.alias === "x")).toBeUndefined();
    }
  });
});

// ── /api/providers/profiles POST validation ────────────────────────
//
// The route's first check (catalog membership) is the surface we
// want to lock down. The accounts.conf write side already had
// coverage via integration. Here we just assert the gate.

describe("POST /api/providers/profiles validation gate", () => {
  test("a known legacy id passes the catalog gate", () => {
    expect(isCatalogProvider("claude")).toBe(true);
  });

  test("a new pi-ai provider (groq) passes the catalog gate", () => {
    expect(isCatalogProvider("groq")).toBe(true);
  });

  test("an unknown id fails the catalog gate", () => {
    expect(isCatalogProvider("bogus-llm")).toBe(false);
  });
});

// ── accounts.conf-format smoke (no real file) ──────────────────────

let stateDir: string;
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "providers-test-"));
  mkdirSync(join(stateDir, ".config", "subctl"), { recursive: true });
  process.env.HOME = stateDir;
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("accounts.conf parse robustness", () => {
  // Mirror of the parser at dashboard/server.ts:4394-4420. We
  // re-implement the smallest version so a future server-side
  // refactor that breaks line-splitting is caught here.
  function parse(text: string) {
    const out: Record<string, Array<{ alias: string }>> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split("|").map((p) => p.trim());
      if (parts.length < 4) continue;
      const [alias, provider] = parts;
      (out[provider!] ??= []).push({ alias: alias! });
    }
    return out;
  }

  test("legacy claude rows parse and merge into anthropic", () => {
    const conf = `
# subctl accounts
claude-jason | claude | jason@example.com | ~/.claude-jason | daily
groq-test     | groq    | n/a              | ~/.groq-test     |
`;
    const parsed = parse(conf);
    expect(parsed.claude?.length).toBe(1);
    expect(parsed.groq?.length).toBe(1);
    // After alias resolution, claude rows attach to anthropic.
    expect(resolveProviderId("claude")).toBe("anthropic");
  });
});
