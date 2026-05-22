// components/master/local-backends/_shared.ts
//
// Adapter-local utilities. Lives in its own file so adapter modules can
// import these without going through `./index.ts` — that would cause a
// circular import (index imports adapters; adapters would import index).

/**
 * Normalize a host string to the bare scheme://host:port form (no /v1
 * suffix). LM Studio's docs and the operator's providers.json sometimes
 * carry the `/v1` suffix because pi-ai needs it on the inference URL.
 * Management surfaces (/api/v0/models, /api/tags) strip it.
 */
export function stripV1(host: string): string {
  return host.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Bearer-token header builder shared by all adapters. */
export function authHeader(
  apiKey: string | null | undefined,
): Record<string, string> {
  if (!apiKey || apiKey === "not-needed") return {};
  return { Authorization: `Bearer ${apiKey}` };
}
