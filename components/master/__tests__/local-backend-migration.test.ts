// components/master/__tests__/local-backend-migration.test.ts
//
// Phase 4 — first-boot migration. The operator's providers.json from
// before this release has roles still pointing at lmstudio / ollama /
// mlx / omlx / vllm. Master must seed local_backend from those, rewrite
// the affected roles to provider:"local", and persist. The 2026-05-15
// dead-mlx-config case must end up at LM Studio (the spec's preferred
// kind when the operator's MLX choice was accidental).

import { describe, expect, test } from "bun:test";

import {
  migrateLocalBackend,
  mapToLocalBackendKind,
  resolveRoleCfg,
} from "../server";

describe("mapToLocalBackendKind", () => {
  test("first-class kinds map to themselves", () => {
    expect(mapToLocalBackendKind("lmstudio")).toBe("lmstudio");
    expect(mapToLocalBackendKind("ollama")).toBe("ollama");
    expect(mapToLocalBackendKind("omlx")).toBe("omlx");
  });

  test("legacy mlx + vllm fold to lmstudio", () => {
    expect(mapToLocalBackendKind("mlx")).toBe("lmstudio");
    expect(mapToLocalBackendKind("vllm")).toBe("lmstudio");
  });

  test("cloud providers return null", () => {
    expect(mapToLocalBackendKind("anthropic")).toBeNull();
    expect(mapToLocalBackendKind("openai")).toBeNull();
    expect(mapToLocalBackendKind("openrouter")).toBeNull();
  });
});

describe("migrateLocalBackend — first boot seeding", () => {
  test("the 2026-05-15 dead-mlx case seeds LM Studio (spec preference)", () => {
    const providers = {
      models: {
        supervisor: { provider: "lmstudio", model: "qwen/qwen3.6-27b", host: "http://localhost:1234/v1" },
        reviewer: { provider: "lmstudio", model: "qwen/qwen3.6-27b", host: "http://localhost:1234/v1" },
        embeddings: { provider: "mlx", model: "text-embedding-nomic", host: "http://localhost:8080" },
        router: { provider: "mlx", model: "qwen-router", host: "http://localhost:8080" },
      },
    } as Parameters<typeof migrateLocalBackend>[0];

    const result = migrateLocalBackend(providers);
    expect(result.migrated).toBe(true);
    expect(result.picked?.kind).toBe("lmstudio");
    // LM Studio wins the host because it's the LM Studio candidate that was picked.
    expect(providers.local_backend).toBeDefined();
    expect(providers.local_backend!.kind).toBe("lmstudio");
    expect(providers.local_backend!.host).toBe("http://localhost:1234/v1");
    // All four roles fold into local_backend.models.
    expect(providers.local_backend!.models.supervisor).toBe("qwen/qwen3.6-27b");
    expect(providers.local_backend!.models.reviewer).toBe("qwen/qwen3.6-27b");
    expect(providers.local_backend!.models.embeddings).toBe("text-embedding-nomic");
    expect(providers.local_backend!.models.router).toBe("qwen-router");
    // All four roles rewrote to provider:"local"
    expect(providers.models.supervisor!.provider).toBe("local");
    expect(providers.models.reviewer!.provider).toBe("local");
    expect(providers.models.embeddings!.provider).toBe("local");
    expect(providers.models.router!.provider).toBe("local");
    expect(result.rewrittenRoles.sort()).toEqual(["embeddings", "reviewer", "router", "supervisor"]);
  });

  test("ollama-only providers.json seeds ollama (no lmstudio override)", () => {
    const providers = {
      models: {
        supervisor: { provider: "ollama", model: "llama3.2", host: "http://localhost:11434" },
      },
    } as Parameters<typeof migrateLocalBackend>[0];
    const result = migrateLocalBackend(providers);
    expect(result.migrated).toBe(true);
    expect(result.picked?.kind).toBe("ollama");
    expect(providers.local_backend!.kind).toBe("ollama");
    expect(providers.local_backend!.host).toBe("http://localhost:11434");
  });

  test("legacy vllm folds into lmstudio kind", () => {
    const providers = {
      models: {
        supervisor: { provider: "vllm", model: "Qwen2.5-Coder", host: "http://localhost:8000/v1" },
      },
    } as Parameters<typeof migrateLocalBackend>[0];
    const result = migrateLocalBackend(providers);
    expect(result.migrated).toBe(true);
    expect(result.picked?.kind).toBe("lmstudio");
    expect(providers.models.supervisor!.provider).toBe("local");
  });

  test("no local roles → no migration", () => {
    const providers = {
      models: {
        supervisor: { provider: "anthropic", model: "claude-sonnet-4-6" },
        embeddings: { provider: "openai", model: "text-embedding-3-large" },
      },
    } as Parameters<typeof migrateLocalBackend>[0];
    const result = migrateLocalBackend(providers);
    expect(result.migrated).toBe(false);
    expect(providers.local_backend).toBeUndefined();
  });

  test("idempotent — second call no-ops once local_backend exists", () => {
    const providers = {
      models: {
        supervisor: { provider: "lmstudio", model: "qwen3.6", host: "http://localhost:1234/v1" },
      },
    } as Parameters<typeof migrateLocalBackend>[0];
    const r1 = migrateLocalBackend(providers);
    expect(r1.migrated).toBe(true);
    const r2 = migrateLocalBackend(providers);
    expect(r2.migrated).toBe(false);
    // Provider stays at "local" — no second rewrite.
    expect(providers.models.supervisor!.provider).toBe("local");
  });
});

describe("resolveRoleCfg", () => {
  test("non-local roles pass through unchanged", () => {
    const raw = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const out = resolveRoleCfg("supervisor", raw, { local_backend: undefined });
    expect(out).toBe(raw);
  });

  test("local roles fold provider/host/model from local_backend", () => {
    const out = resolveRoleCfg("supervisor", {
      provider: "local",
      model: "ignored-by-resolver",
    }, {
      local_backend: {
        kind: "lmstudio",
        host: "http://localhost:1234/v1",
        models: { supervisor: "qwen/qwen3.6-27b" },
      },
    });
    expect(out.provider).toBe("lmstudio");
    expect(out.host).toBe("http://localhost:1234/v1");
    expect(out.model).toBe("qwen/qwen3.6-27b");
  });

  test("local + missing local_backend throws (defense-in-depth)", () => {
    expect(() =>
      resolveRoleCfg(
        "supervisor",
        { provider: "local", model: "x" },
        { local_backend: undefined },
      ),
    ).toThrow(/local_backend is missing/);
  });

  test("local + missing model for role throws", () => {
    expect(() =>
      resolveRoleCfg(
        "router",
        { provider: "local", model: "" },
        {
          local_backend: {
            kind: "lmstudio",
            host: "http://localhost:1234/v1",
            models: { router: null },
          },
        },
      ),
    ).toThrow(/null and role.model is empty/);
  });

  test("falls back to raw.model when local_backend.models[role] is unset", () => {
    const out = resolveRoleCfg("supervisor", {
      provider: "local",
      model: "fallback-model",
    }, {
      local_backend: {
        kind: "ollama",
        host: "http://localhost:11434",
        models: { /* supervisor unset */ },
      },
    });
    expect(out.model).toBe("fallback-model");
    expect(out.provider).toBe("ollama");
  });
});
