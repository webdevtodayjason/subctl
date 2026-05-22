// components/master/local-backends/omlx.ts
//
// OmniMLX adapter — Apple-Silicon LLM inference server (jundot/omlx).
//
// OpenAI-compatible surface:
//   - /v1/models             list models
//   - /v1/chat/completions   inference (streaming SSE)
//   - /v1/embeddings         embeddings
//
// No dedicated /health endpoint. /v1/models returning 200 is the probe.
// No HTTP pin/unpin endpoints — oMLX manages models via auto LRU eviction
// under memory pressure with configurable per-model idle TTL. The
// operator's dashboard UI does manual pinning. Adapter pinModel is a
// no-op that logs a hint pointing operators at the dashboard.
//
// Optional `--api-key` auth — localhost can bypass via admin setting. We
// honor `opts.api_key` when supplied so secured deployments still work.

import type {
  HealthProbeResult,
  LocalBackendAdapter,
  LocalModel,
  PinResult,
} from "./index";
import { authHeader, stripV1 } from "./_shared";

const DEFAULT_HOST = "http://localhost:8000";

interface OmlxModelRow {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  // oMLX-specific extensions on the OpenAI-compat catalog
  alias?: string;
  directory_name?: string;
  loaded?: boolean;
  context_length?: number;
  type?: string;
  quantization?: string;
}

interface OmlxModelsResponse {
  data?: OmlxModelRow[];
}

export const omlx: LocalBackendAdapter = {
  kind: "omlx",
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
    const r = await fetch(`${apiBase}/v1/models`, {
      headers: { ...authHeader(opts?.api_key ?? null) },
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      throw new Error(`oMLX /v1/models HTTP ${r.status}`);
    }
    const j = (await r.json()) as OmlxModelsResponse;
    const rows = j.data ?? [];
    return rows.map((m): LocalModel => {
      const t: LocalModel["type"] | undefined =
        m.type === "llm" || m.type === "vlm" || m.type === "embeddings"
          ? m.type
          : undefined;
      const loaded: LocalModel["loaded"] =
        typeof m.loaded === "boolean" ? m.loaded : "unknown";
      return {
        id: m.id,
        loaded,
        context_length: m.context_length,
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
      const r = await fetch(`${apiBase}/v1/models`, {
        headers: { ...authHeader(opts?.api_key ?? null) },
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) {
        return {
          ok: false,
          detail: `HTTP ${r.status}`,
          reachable_at: `${apiBase}/v1/models`,
        };
      }
      const j = (await r.json()) as OmlxModelsResponse;
      const count = (j.data ?? []).length;
      return {
        ok: true,
        detail: `oMLX reachable, ${count} models in catalog`,
        reachable_at: `${apiBase}/v1/models`,
        model_count: count,
      };
    } catch (err) {
      return {
        ok: false,
        detail: (err as Error).message,
        reachable_at: `${apiBase}/v1/models`,
      };
    }
  },

  async pinModel(_host, id, _ctx, _opts): Promise<PinResult> {
    // oMLX has no HTTP pin endpoint. Pinning is configured server-side
    // via the oMLX dashboard's per-model idle TTL setting. Return a clear
    // hint so operator logs explain the no-op.
    return {
      ok: true,
      detail: `${id}: oMLX pins via dashboard (per-model idle TTL); no HTTP pin endpoint — auto-load on first inference`,
    };
  },

  async unloadModel(_host, id, _opts): Promise<PinResult> {
    return {
      ok: true,
      detail: `${id}: oMLX manages eviction via LRU + idle TTL; no HTTP unload`,
    };
  },
};
