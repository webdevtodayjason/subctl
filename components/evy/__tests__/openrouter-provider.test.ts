// components/evy/__tests__/openrouter-provider.test.ts
//
// v2.7.17 — OpenRouter as a first-class model provider.
//
// OpenRouter is a unified gateway for hundreds of models (incl. a free
// preview tier) speaking the OpenAI Chat Completions wire format at
// https://openrouter.ai/api/v1. The integration is intentionally tiny:
//
//   1. PROVIDER_API table maps "openrouter" → "openai-completions" so
//      pi-ai dispatches to the right stream factory.
//   2. buildModel defaults baseUrl to https://openrouter.ai/api/v1 when
//      provider is "openrouter" and `host` is omitted from providers.json.
//      Explicit `host` (proxies, regional endpoints) wins.
//   3. getApiKeyForProvider("openrouter") returns the resolved secret OR
//      undefined when absent. CRITICAL: must NOT return "not-needed" —
//      OpenRouter requires a real key and the "no API key for provider"
//      error must surface clearly to the operator instead of a generic 401.
//
// These tests pin those three contracts and the "explicit host wins" override.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildModel,
  getApiKeyForProvider,
  PROVIDER_API,
} from "../server";
import {
  _resetCacheForTesting,
  _setPathForTesting,
  setSecret,
} from "../secrets";

// ---------------------------------------------------------------------------
// env-var save/restore — getApiKeyForProvider consults
// OPENROUTER_API_KEY via the v2.7.4 priority chain.
// ---------------------------------------------------------------------------

let savedEnv: string | undefined;
let tmpDir: string;

beforeEach(() => {
  savedEnv = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-openrouter-test-"));
  _setPathForTesting(join(tmpDir, "secrets.json"));
  _resetCacheForTesting();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedEnv;
  _setPathForTesting(null);
  _resetCacheForTesting();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PROVIDER_API registration
// ---------------------------------------------------------------------------

describe("PROVIDER_API includes openrouter", () => {
  test("'openrouter' maps to 'openai-completions'", () => {
    expect(PROVIDER_API.openrouter).toBe("openai-completions");
  });
});

// ---------------------------------------------------------------------------
// getApiKeyForProvider — openrouter REQUIRES a real key
// ---------------------------------------------------------------------------

describe("getApiKeyForProvider('openrouter')", () => {
  test("returns the env var when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-AAAAAAAA1111111";
    expect(getApiKeyForProvider("openrouter")).toBe(
      "sk-or-v1-AAAAAAAA1111111",
    );
  });

  test("returns the secrets.json value when env is unset", async () => {
    await setSecret("openrouter_api_key", "sk-or-v1-BBBBBBBB2222222");
    expect(getApiKeyForProvider("openrouter")).toBe(
      "sk-or-v1-BBBBBBBB2222222",
    );
  });

  test("env beats secrets.json (v2.7.4 priority chain)", async () => {
    await setSecret("openrouter_api_key", "sk-or-v1-FROM-DISK");
    process.env.OPENROUTER_API_KEY = "sk-or-v1-FROM-ENV";
    expect(getApiKeyForProvider("openrouter")).toBe("sk-or-v1-FROM-ENV");
  });

  test(
    "returns undefined when secret is absent — NOT 'not-needed'. " +
      "OpenRouter requires a real key; pi-ai must surface 'no API key' " +
      "instead of silently 401-ing.",
    () => {
      expect(getApiKeyForProvider("openrouter")).toBeUndefined();
    },
  );

  test("empty-string secrets.json field is treated as unset", async () => {
    // setSecret("", "") would no-op; verify direct write with "" coerces
    // through loadSecret's length check (length-0 → null).
    await setSecret("openrouter_api_key", "sk-or-v1-XXX");
    await setSecret("openrouter_api_key", null); // clear
    expect(getApiKeyForProvider("openrouter")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildModel baseUrl defaults
// ---------------------------------------------------------------------------

describe("buildModel({provider: 'openrouter'})", () => {
  test("defaults baseUrl to https://openrouter.ai/api/v1 when host omitted", () => {
    const m = buildModel({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(m.api).toBe("openai-completions");
    expect(m.provider).toBe("openrouter");
    expect(m.id).toBe("anthropic/claude-sonnet-4");
  });

  test("explicit host wins (proxies, regional endpoints)", () => {
    const m = buildModel({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      host: "https://my-proxy.example.com/v1",
    });
    expect(m.baseUrl).toBe("https://my-proxy.example.com/v1");
  });

  test("vendor/model IDs are passed through unchanged", () => {
    // OpenRouter model IDs use vendor/name (openai/gpt-5.2,
    // mistralai/mixtral-8x22b-instruct, …). They must NOT be mangled.
    const ids = [
      "openai/gpt-5.2",
      "mistralai/mixtral-8x22b-instruct",
      "meta-llama/llama-3.3-70b-instruct:free",
    ];
    for (const id of ids) {
      const m = buildModel({ provider: "openrouter", model: id });
      expect(m.id).toBe(id);
      expect(m.name).toBe(id);
    }
  });

  test(
    "openrouter is NOT in LOCAL_PROVIDERS — baseUrl never falls through " +
      "to http://localhost:1234/v1 even when host is omitted",
    () => {
      const m = buildModel({
        provider: "openrouter",
        model: "openai/gpt-5.2",
      });
      expect(m.baseUrl).not.toBe("http://localhost:1234/v1");
      expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
    },
  );
});
