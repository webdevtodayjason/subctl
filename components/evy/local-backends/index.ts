// components/evy/local-backends/index.ts
//
// Phase 4 — Local inference backend registry + common contract.
//
// One adapter per supported runtime. The master daemon stops talking to LM
// Studio / Ollama / oMLX directly; it talks to `getAdapter(kind)` and lets
// each adapter own its protocol quirks. New backend = new file + one line in
// REGISTRY below. Nothing else in the master core has to change.
//
// Adapter contract is OpenAI-compatible at the wire level: every adapter
// exposes `inferenceUrl(host)` returning a `/v1/chat/completions`-shaped URL
// and `embeddingsUrl(host)` for `/v1/embeddings`. The `pinModel` /
// `unloadModel` hooks are optional — only LM Studio implements them. Ollama
// auto-loads on request, oMLX manages its own LRU eviction. For those two
// the adapter still exposes the hook but it's a no-op so callers can call
// uniformly.
//
// Design note: the adapter never reads master state directly. Anything the
// caller needs (auth token, ctx_size, role name) is passed in. Keeps the
// adapter pure-ish — unit-testable with mocked fetch.

import { lmstudio } from "./lmstudio";
import { ollama } from "./ollama";
import { omlx } from "./omlx";

export type LocalBackendKind = "lmstudio" | "ollama" | "omlx";

export interface LocalModel {
  id: string;
  loaded: boolean | "unknown";
  context_length?: number;
  type?: "llm" | "vlm" | "embeddings";
  quantization?: string;
  // Free-form per-backend metadata. Operator-facing dashboards can surface
  // any of this; the adapter contract doesn't require backends agree on
  // shape. LM Studio surfaces `state` + `loaded_context_length`, Ollama
  // surfaces `digest` + `size`, oMLX surfaces `alias` + `directory_name`.
  raw?: Record<string, unknown>;
}

export interface HealthProbeResult {
  ok: boolean;
  detail?: string;
  reachable_at?: string;
  model_count?: number;
}

export interface PinResult {
  ok: boolean;
  detail: string;
}

export interface LocalBackendAdapter {
  kind: LocalBackendKind;
  defaultHost: string;
  /** OpenAI-compatible /v1/chat/completions URL for this host. */
  inferenceUrl(host: string): string;
  /** OpenAI-compatible /v1/embeddings URL for this host. */
  embeddingsUrl(host: string): string;
  /** List models available on this backend. Cross-references load state when possible. */
  listModels(
    host: string,
    opts?: { timeout_ms?: number; api_key?: string | null },
  ): Promise<LocalModel[]>;
  /** Health probe — fast, non-destructive, never throws. */
  healthProbe(
    host: string,
    opts?: { timeout_ms?: number; api_key?: string | null },
  ): Promise<HealthProbeResult>;
  /**
   * Force-load a model at an explicit context window. LM Studio implements
   * this against /api/v1/models/load; Ollama + oMLX log a hint and return
   * {ok:true, detail:"auto-load"} since they don't expose HTTP pinning.
   */
  pinModel?(
    host: string,
    id: string,
    ctx_size: number,
    opts?: { api_key?: string | null },
  ): Promise<PinResult>;
  /** Unload a model. LM Studio only; others no-op. */
  unloadModel?(
    host: string,
    id: string,
    opts?: { api_key?: string | null },
  ): Promise<PinResult>;
}

const REGISTRY: Record<LocalBackendKind, LocalBackendAdapter> = {
  lmstudio,
  ollama,
  omlx,
};

export function getAdapter(kind: LocalBackendKind): LocalBackendAdapter {
  const a = REGISTRY[kind];
  if (!a) {
    throw new Error(
      `unknown local backend kind="${kind}" — supported: ${listAvailableBackends().join(", ")}`,
    );
  }
  return a;
}

export function listAvailableBackends(): LocalBackendKind[] {
  return Object.keys(REGISTRY) as LocalBackendKind[];
}

// Adapter-local helpers (stripV1, authHeader) live in ./_shared.ts to
// avoid the circular import that arises if adapters reach back through
// the registry barrel.
export { stripV1, authHeader } from "./_shared";
