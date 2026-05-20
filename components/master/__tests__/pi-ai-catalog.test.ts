// components/master/__tests__/pi-ai-catalog.test.ts
//
// Phase C coverage for the pi-ai-catalog xAI-OAuth synthetic provider.
//
// listCatalogProviders() iterates pi-ai's `getProviders()` enumeration,
// so subctl-only providers (those NOT in pi-ai's KnownProvider union)
// would never surface without the explicit SUBCTL_ONLY_PROVIDERS merge.
// This test pins:
//   1. The xai-oauth row appears.
//   2. It carries the right display name + auth method + notes.
//   3. The api-key "xai" row still appears alongside (they coexist; one
//      is for SuperGrok OAuth, the other is XAI_API_KEY).
//   4. isCatalogProvider("xai-oauth") returns true.
//   5. resolveProviderId is idempotent on "xai-oauth" (no legacy alias).

import { describe, expect, test } from "bun:test";

import {
  isCatalogProvider,
  listCatalogProviders,
  resolveProviderId,
  SUBCTL_ONLY_PROVIDERS,
} from "../pi-ai-catalog.ts";

describe("pi-ai catalog — xai-oauth synthetic provider", () => {
  test("xai-oauth is registered as a subctl-only provider", () => {
    expect(SUBCTL_ONLY_PROVIDERS).toContain("xai-oauth");
  });

  test("listCatalogProviders surfaces xai-oauth", () => {
    const ids = listCatalogProviders().map((p) => p.id);
    expect(ids).toContain("xai-oauth");
  });

  test("xai-oauth row has the expected display + auth + notes shape", () => {
    const row = listCatalogProviders().find((p) => p.id === "xai-oauth");
    expect(row).toBeDefined();
    expect(row?.display_name).toBe("xAI Grok OAuth (SuperGrok)");
    expect(row?.auth_method).toBe("oauth");
    expect(row?.notes).toContain("subctl auth xai-oauth");
    expect(row?.kind).toBe("cloud");
    expect(row?.available).toBe(true);
    expect(row?.default_model).toBe("grok-4.3");
  });

  test("api-key 'xai' row still coexists with the new oauth row", () => {
    const rows = listCatalogProviders();
    const apiKeyRow = rows.find((p) => p.id === "xai");
    expect(apiKeyRow).toBeDefined();
    expect(apiKeyRow?.auth_method).toBe("api-key");
    // The two rows are distinct entries; no deduplication.
    const oauthRow = rows.find((p) => p.id === "xai-oauth");
    expect(oauthRow?.id).not.toBe(apiKeyRow?.id);
  });

  test("isCatalogProvider('xai-oauth') returns true", () => {
    expect(isCatalogProvider("xai-oauth")).toBe(true);
  });

  test("resolveProviderId('xai-oauth') is idempotent (no legacy alias)", () => {
    expect(resolveProviderId("xai-oauth")).toBe("xai-oauth");
  });

  test("catalog is sorted by display_name; xai-oauth lands near the bottom", () => {
    const rows = listCatalogProviders();
    const displayNames = rows.map((p) => p.display_name);
    // Spot-check sort invariant.
    const sortedCopy = [...displayNames].sort((a, b) => a.localeCompare(b));
    expect(displayNames).toEqual(sortedCopy);
  });

  test("synthetic providers do NOT replace pi-ai-native rows", () => {
    // Sanity: the merge preserves pi-ai's rows. We pick a few high-confidence
    // pi-ai-native ids to confirm.
    const ids = listCatalogProviders().map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
  });
});
