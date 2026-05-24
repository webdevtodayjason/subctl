// components/evy/local-backends/ollama.ts
//
// Ollama adapter — auto-loading model server with an OpenAI-compat shim.
//
// Surfaces used:
//   - /api/tags             native — list installed models
//   - /api/ps               native — currently loaded models (for `loaded` flag)
//   - /v1/chat/completions  OpenAI-compat — inference
//   - /v1/embeddings        OpenAI-compat — embeddings
//
// Ollama auto-loads on first request and auto-evicts under memory pressure
// (configurable via OLLAMA_KEEP_ALIVE). There's no explicit pin endpoint
// equivalent to LM Studio's /api/v1/models/load — pinModel is a no-op that
// returns a clear "auto-load" detail so operator logs aren't confusing.

import type {
  HealthProbeResult,
  LocalBackendAdapter,
  LocalModel,
  PinResult,
} from "./index";
import { authHeader, stripV1 } from "./_shared";

const DEFAULT_HOST = "http://localhost:11434";

interface OllamaTagRow {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
    family?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagRow[];
}

interface OllamaPsRow {
  name: string;
  model?: string;
  size_vram?: number;
  expires_at?: string;
}

interface OllamaPsResponse {
  models?: OllamaPsRow[];
}

export const ollama: LocalBackendAdapter = {
  kind: "ollama",
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
    const headers = { ...authHeader(opts?.api_key ?? null) };
    const r = await fetch(`${apiBase}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      throw new Error(`Ollama /api/tags HTTP ${r.status}`);
    }
    const j = (await r.json()) as OllamaTagsResponse;
    const tagRows = j.models ?? [];
    // Cross-reference with /api/ps to set `loaded: boolean` per model.
    // /api/ps failures are non-fatal — fall back to "unknown".
    let loadedSet: Set<string> | null = null;
    try {
      const ps = await fetch(`${apiBase}/api/ps`, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (ps.ok) {
        const pj = (await ps.json()) as OllamaPsResponse;
        loadedSet = new Set((pj.models ?? []).map((m) => m.name));
      }
    } catch {
      /* ignore — leave loaded as unknown */
    }
    return tagRows.map((m): LocalModel => ({
      id: m.name,
      loaded: loadedSet ? loadedSet.has(m.name) : "unknown",
      quantization: m.details?.quantization_level,
      raw: m as unknown as Record<string, unknown>,
    }));
  },

  async healthProbe(host, opts): Promise<HealthProbeResult> {
    const apiBase = stripV1(host);
    const timeout = opts?.timeout_ms ?? 2000;
    try {
      const r = await fetch(`${apiBase}/api/tags`, {
        headers: { ...authHeader(opts?.api_key ?? null) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) {
        return {
          ok: false,
          detail: `HTTP ${r.status}`,
          reachable_at: `${apiBase}/api/tags`,
        };
      }
      const j = (await r.json()) as OllamaTagsResponse;
      const count = (j.models ?? []).length;
      return {
        ok: true,
        detail: `Ollama reachable, ${count} models installed`,
        reachable_at: `${apiBase}/api/tags`,
        model_count: count,
      };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        reachable_at: `${apiBase}/api/tags`,
      };
    }
  },

  async pinModel(_host, id, _ctx, _opts): Promise<PinResult> {
    // Ollama auto-loads on first /v1/chat/completions request and
    // auto-evicts after OLLAMA_KEEP_ALIVE (default 5m). No HTTP pin
    // equivalent. Return a clear hint instead of throwing.
    return {
      ok: true,
      detail: `${id}: Ollama auto-loads on first inference call — set OLLAMA_KEEP_ALIVE to control eviction`,
    };
  },

  async unloadModel(_host, id, _opts): Promise<PinResult> {
    return {
      ok: true,
      detail: `${id}: Ollama auto-evicts — no explicit unload`,
    };
  },
};
