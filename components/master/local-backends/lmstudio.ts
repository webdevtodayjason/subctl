// components/master/local-backends/lmstudio.ts
//
// LM Studio adapter — most capable of the three local backends.
//
// LM Studio runs an HTTP server with two parallel surfaces:
//   - /v1/*       OpenAI-compatible (chat/completions, embeddings, models)
//   - /api/v0/*   LM Studio native — richer model catalog with state,
//                 loaded_context_length, quantization, type (llm/vlm/embeddings)
//   - /api/v1/*   LM Studio native admin — models/load, models/unload
//
// Master uses /api/v0/models for the catalog (richer) and the OpenAI-compat
// /v1/chat/completions for inference. The pin endpoint is the only way to
// force a model to load at an explicit context window, which is the entire
// reason the LM Studio adapter exists as a special case — the 4K JIT trap
// (LM Studio quietly evicts under memory pressure and reloads at 4K
// default) makes daemons that don't explicitly pin silently truncate
// every prompt past the first.
//
// All logic that previously lived in `ensureModelLoaded()` in server.ts
// moves here. The role-default ctx map stays in server.ts as policy.

import type {
  HealthProbeResult,
  LocalBackendAdapter,
  LocalModel,
  PinResult,
} from "./index";
import { authHeader, stripV1 } from "./_shared";

const DEFAULT_HOST = "http://localhost:1234";

interface LmStudioModelRow {
  id: string;
  state?: string; // "loaded" | "not-loaded"
  loaded_context_length?: number;
  max_context_length?: number;
  quantization?: string;
  type?: string; // "llm" | "vlm" | "embeddings"
}

interface LmStudioModelsResponse {
  data?: LmStudioModelRow[];
}

interface LmStudioLoadResponse {
  load_config?: { context_length?: number };
}

export const lmstudio: LocalBackendAdapter = {
  kind: "lmstudio",
  defaultHost: DEFAULT_HOST,

  inferenceUrl(host: string): string {
    return `${stripV1(host)}/v1/chat/completions`;
  },

  embeddingsUrl(host: string): string {
    return `${stripV1(host)}/v1/embeddings`;
  },

  async listModels(host, opts): Promise<LocalModel[]> {
    const apiBase = stripV1(host);
    const timeout = opts?.timeout_ms ?? 2000;
    const r = await fetch(`${apiBase}/api/v0/models`, {
      headers: { ...authHeader(opts?.api_key ?? null) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      throw new Error(`LM Studio /api/v0/models HTTP ${r.status}`);
    }
    const j = (await r.json()) as LmStudioModelsResponse;
    const rows = j.data ?? [];
    return rows.map((m): LocalModel => {
      const loaded: LocalModel["loaded"] =
        m.state === "loaded" ? true : m.state ? false : "unknown";
      const t: LocalModel["type"] | undefined =
        m.type === "llm" || m.type === "vlm" || m.type === "embeddings"
          ? m.type
          : undefined;
      return {
        id: m.id,
        loaded,
        context_length: m.loaded_context_length ?? m.max_context_length,
        type: t,
        quantization: m.quantization,
        raw: m as unknown as Record<string, unknown>,
      };
    });
  },

  async healthProbe(host, opts): Promise<HealthProbeResult> {
    const apiBase = stripV1(host);
    const timeout = opts?.timeout_ms ?? 2000;
    try {
      const r = await fetch(`${apiBase}/api/v0/models`, {
        headers: { ...authHeader(opts?.api_key ?? null) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) {
        return {
          ok: false,
          detail: `HTTP ${r.status}`,
          reachable_at: `${apiBase}/api/v0/models`,
        };
      }
      const j = (await r.json()) as LmStudioModelsResponse;
      const count = (j.data ?? []).length;
      return {
        ok: true,
        detail: `LM Studio reachable, ${count} models in catalog`,
        reachable_at: `${apiBase}/api/v0/models`,
        model_count: count,
      };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        reachable_at: `${apiBase}/api/v0/models`,
      };
    }
  },

  async pinModel(host, id, ctx_size, opts): Promise<PinResult> {
    if (!ctx_size) return { ok: true, detail: `${id} ctx_size=0; not enforcing` };
    const apiBase = stripV1(host);
    const headers = {
      "Content-Type": "application/json",
      ...authHeader(opts?.api_key ?? null),
    };
    // 1. Check current load state — skip the reload if it's already where
    //    we want it. Tight 2s timeout: if LM Studio isn't responding to a
    //    GET we shouldn't dump a load request into it — bail to JIT.
    let reachable = false;
    try {
      const r = await fetch(`${apiBase}/api/v0/models`, {
        headers: { ...authHeader(opts?.api_key ?? null) },
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        reachable = true;
        const j = (await r.json()) as LmStudioModelsResponse;
        const current = (j.data ?? []).find((m) => m.id === id);
        // If model is already loaded at ANY context, leave it alone. The
        // operator's manual config (and LM Studio's own state) wins. The
        // previous "upgrade ctx if loaded < desired" path tried to
        // unload+reload, but unload-by-model-name silently fails in current
        // LM Studio (it requires instance_id), so the load step created a
        // duplicate :2 instance. Master only enforces ctx on cold start
        // (model not yet loaded).
        if (current?.state === "loaded") {
          return {
            ok: true,
            detail: `${id} already loaded at ctx ${(current.loaded_context_length ?? 0).toLocaleString()} — respecting existing load (operator/LM Studio config wins)`,
          };
        }
      }
    } catch {
      /* fall through */
    }
    if (!reachable) {
      return {
        ok: false,
        detail: `LM Studio at ${apiBase} did not respond to /api/v0/models within 2s — skipping pin, JIT will handle on first prompt`,
      };
    }
    // 2. Unload first (safe reload pattern). Best-effort.
    try {
      await fetch(`${apiBase}/api/v1/models/unload`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      /* unload failures are non-fatal — load below will replace */
    }
    // 3. Load with explicit context_length. Cap at 20s — if LM Studio
    //    can't load in 20s the daemon shouldn't block boot. JIT-on-first-
    //    prompt is the fallback.
    try {
      const r = await fetch(`${apiBase}/api/v1/models/load`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: id,
          context_length: ctx_size,
          flash_attention: true,
          echo_load_config: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { ok: false, detail: `load HTTP ${r.status}: ${text.slice(0, 300)}` };
      }
      const j = (await r.json()) as LmStudioLoadResponse;
      const got = j.load_config?.context_length;
      return {
        ok: true,
        detail: `${id} loaded with ctx ${(got ?? ctx_size).toLocaleString()}`,
      };
    } catch (err) {
      return { ok: false, detail: `load error: ${(err as Error).message}` };
    }
  },

  async unloadModel(host, id, opts): Promise<PinResult> {
    const apiBase = stripV1(host);
    try {
      const r = await fetch(`${apiBase}/api/v1/models/unload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader(opts?.api_key ?? null),
        },
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) {
        return { ok: false, detail: `unload HTTP ${r.status}` };
      }
      return { ok: true, detail: `${id} unloaded` };
    } catch (err) {
      return { ok: false, detail: `unload error: ${(err as Error).message}` };
    }
  },
};
