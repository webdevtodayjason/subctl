// components/master/pi-ai-catalog.ts
//
// v2.7.24 — pi-ai provider catalog adapter.
//
// Wraps the provider list exported by `@earendil-works/pi-ai` (mitsuhiko's
// pi-mono/packages/ai) into the shape the dashboard needs: human-readable
// display name, transport kind, auth method hint, and a backwards-compat
// alias table so subctl's existing provider IDs (`claude`, `gemini`,
// `zai`, `minimax`) keep resolving even though pi-ai uses different
// canonical names (`anthropic`, `google`, …).
//
// IMPORTANT: this module is ADDITIVE — pi-ai is the catalog of "what
// providers exist". The agent runtime is still `@earendil-works/pi-agent-core`
// (separate package, untouched). The integration glue under `providers/<name>/`
// (tmux launchers, OAuth helpers) is also untouched. This file's only job
// is to feed the dashboard a dynamic list so we stop maintaining a
// hand-curated dropdown.
//
// ADR 0015 documents the call.

import { getProviders, getModels } from "@earendil-works/pi-ai";
import type { KnownProvider } from "@earendil-works/pi-ai";

/**
 * Shape returned to dashboard / API consumers. Stable contract — bump
 * thoughtfully.
 */
export interface CatalogProvider {
  /** Canonical pi-ai provider id (e.g. "anthropic", "openai", "groq"). */
  id: string;
  /** Human-readable name for the dropdown. */
  display_name: string;
  /** Transport kind. Everything in pi-ai is `cloud`; LM Studio / Ollama
   *  / vLLM are local OpenAI-compat endpoints and are synthesized
   *  elsewhere (dashboard's lmstudio path). */
  kind: "cloud" | "local";
  /** How operators authenticate. `oauth` means subctl already has (or
   *  needs) a per-account OAuth shim — subctl auth <provider> <alias>.
   *  `api-key` means a long-lived secret. `none` means no creds needed
   *  (faux/test providers). */
  auth_method: "api-key" | "oauth" | "none";
  /** pi-ai supports it. Reserved for future degraded modes. */
  available: boolean;
  /** Number of models pi-ai's generated catalog knows about. Useful
   *  for UI ("OpenAI — 84 models"). 0 means pi-ai recognises the
   *  provider but ships no static catalog entries (operator brings
   *  their own model id via API). */
  model_count: number;
  /** Caveats / hints surfaced to the operator. */
  notes?: string;
}

/**
 * Backwards-compat alias table.
 *
 * subctl's accounts.conf and `providers/<name>/` integration dirs use
 * historical names that predate pi-ai (`claude` was our first provider
 * via Claude Code OAuth). Pi-ai uses the upstream model-card name
 * (`anthropic`). The dashboard accepts either and maps to pi-ai.
 *
 * Direction: legacy subctl id → pi-ai provider id.
 *
 * Round-trip: see `legacyAliasFor()` for the reverse — keeps the
 * `subctl auth <legacy>` command surface stable.
 */
export const SUBCTL_TO_PI_AI: Record<string, string> = {
  // historical first-class — predates pi-ai
  claude: "anthropic",
  // gemini is the Google AI Studio API; pi-ai calls it `google`. Vertex
  // (enterprise) stays `google-vertex` and has no legacy alias.
  gemini: "google",
  // zai, minimax, openai keep their names — pi-ai matches.
  // pi-coding-agent is a subctl-side wrapper (provider dir name);
  // operators authenticating against the underlying provider use
  // `anthropic` profiles (pi-coding-agent is the runner, not the LLM).
  "pi-coding-agent": "anthropic",
};

/** Reverse the alias table for one provider id. Returns the legacy
 *  subctl id if one exists, otherwise the pi-ai id unchanged. The
 *  dashboard uses this when surfacing `subctl auth <name> <alias>`
 *  hints — those commands shell into `providers/<legacy>/auth.sh`. */
export function legacyAliasFor(piAiId: string): string {
  for (const [legacy, canonical] of Object.entries(SUBCTL_TO_PI_AI)) {
    if (canonical === piAiId) return legacy;
  }
  return piAiId;
}

/** Resolve a (possibly legacy) provider id to the pi-ai canonical id.
 *  Idempotent: pi-ai ids pass through unchanged. */
export function resolveProviderId(id: string): string {
  return SUBCTL_TO_PI_AI[id] ?? id;
}

/**
 * Display-name + auth-method overrides. Anything not in this table
 * uses a kebab-case → Title Case fallback and api-key auth.
 *
 * Auth-method assignment:
 *   - oauth   → subctl has (or needs) a per-account OAuth helper
 *               (Anthropic Claude Code, OpenAI Codex ChatGPT, GitHub
 *               Copilot all flow through a browser dance, then a
 *               token cache on disk).
 *   - api-key → operator pastes a long-lived secret via the dashboard
 *               Settings panel or sets an env var.
 *   - none    → faux / test providers that need no creds.
 *
 * pi-ai's `findEnvKeys()` helper doesn't expose the canonical
 * env-var list when nothing is set, so we mirror its known auth
 * shapes here. If pi-ai adds a brand-new provider, it lands here
 * with the fallback (api-key) and the dropdown still works — just
 * with a generic display name until we add an entry.
 */
const PROVIDER_META: Record<
  string,
  { display: string; auth: CatalogProvider["auth_method"]; notes?: string }
> = {
  anthropic: {
    display: "Anthropic Claude",
    auth: "oauth",
    notes: "Claude Code OAuth (preferred) or ANTHROPIC_API_KEY",
  },
  openai: {
    display: "OpenAI",
    auth: "api-key",
    notes: "OPENAI_API_KEY",
  },
  "openai-codex": {
    display: "OpenAI Codex (ChatGPT subscription)",
    auth: "oauth",
    notes: "OAuth via ChatGPT account — no API key path",
  },
  "azure-openai-responses": {
    display: "Azure OpenAI",
    auth: "api-key",
    notes: "AZURE_OPENAI_API_KEY + endpoint",
  },
  google: {
    display: "Google Gemini",
    auth: "api-key",
    notes: "GEMINI_API_KEY (Google AI Studio)",
  },
  "google-vertex": {
    display: "Google Vertex AI",
    auth: "api-key",
    notes: "GOOGLE_CLOUD_API_KEY or Application Default Credentials",
  },
  "amazon-bedrock": {
    display: "Amazon Bedrock",
    auth: "api-key",
    notes: "AWS profile / IAM role (no single env var)",
  },
  "github-copilot": {
    display: "GitHub Copilot",
    auth: "oauth",
    notes: "COPILOT_GITHUB_TOKEN / gh-cli auth",
  },
  mistral: { display: "Mistral", auth: "api-key", notes: "MISTRAL_API_KEY" },
  groq: { display: "Groq", auth: "api-key", notes: "GROQ_API_KEY" },
  cerebras: { display: "Cerebras", auth: "api-key", notes: "CEREBRAS_API_KEY" },
  xai: { display: "xAI (Grok)", auth: "api-key", notes: "XAI_API_KEY" },
  openrouter: {
    display: "OpenRouter",
    auth: "api-key",
    notes: "OPENROUTER_API_KEY — gateway to hundreds of models",
  },
  "vercel-ai-gateway": {
    display: "Vercel AI Gateway",
    auth: "api-key",
    notes: "AI_GATEWAY_API_KEY",
  },
  deepseek: { display: "DeepSeek", auth: "api-key", notes: "DEEPSEEK_API_KEY" },
  fireworks: {
    display: "Fireworks AI",
    auth: "api-key",
    notes: "FIREWORKS_API_KEY",
  },
  "cloudflare-workers-ai": {
    display: "Cloudflare Workers AI",
    auth: "api-key",
    notes: "CLOUDFLARE_API_KEY",
  },
  "cloudflare-ai-gateway": {
    display: "Cloudflare AI Gateway",
    auth: "api-key",
    notes: "CLOUDFLARE_API_KEY",
  },
  minimax: { display: "MiniMax", auth: "api-key", notes: "MINIMAX_API_KEY" },
  "minimax-cn": {
    display: "MiniMax (China)",
    auth: "api-key",
    notes: "MINIMAX_CN_API_KEY",
  },
  moonshotai: {
    display: "Moonshot (Kimi)",
    auth: "api-key",
    notes: "MOONSHOT_API_KEY",
  },
  "moonshotai-cn": {
    display: "Moonshot (Kimi, China)",
    auth: "api-key",
    notes: "MOONSHOT_API_KEY",
  },
  "kimi-coding": {
    display: "Kimi for Coding",
    auth: "api-key",
    notes: "KIMI_API_KEY",
  },
  zai: { display: "Z.ai (GLM)", auth: "api-key", notes: "ZAI_API_KEY" },
  huggingface: {
    display: "Hugging Face",
    auth: "api-key",
    notes: "HF_TOKEN",
  },
  opencode: {
    display: "OpenCode Zen",
    auth: "api-key",
    notes: "OPENCODE_API_KEY",
  },
  "opencode-go": {
    display: "OpenCode Go",
    auth: "api-key",
    notes: "OPENCODE_API_KEY",
  },
  xiaomi: { display: "Xiaomi", auth: "api-key", notes: "XIAOMI_API_KEY" },
  "xiaomi-token-plan-ams": {
    display: "Xiaomi Token Plan (Americas)",
    auth: "api-key",
  },
  "xiaomi-token-plan-cn": {
    display: "Xiaomi Token Plan (China)",
    auth: "api-key",
  },
  "xiaomi-token-plan-sgp": {
    display: "Xiaomi Token Plan (Singapore)",
    auth: "api-key",
  },
};

/** Convert kebab-case to a presentable name when we have no override. */
function titleCase(id: string): string {
  return id
    .split("-")
    .map((p) => (p.length > 0 ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * Return the merged catalog. Pi-ai's enumeration is the source of
 * truth — anything it knows about, we surface. New providers added
 * upstream light up automatically with a Title-Case fallback name.
 */
export function listCatalogProviders(): CatalogProvider[] {
  const piProviders = getProviders();
  const out: CatalogProvider[] = piProviders.map((id) => {
    const meta = PROVIDER_META[id];
    let modelCount = 0;
    try {
      modelCount = getModels(id as KnownProvider).length;
    } catch {
      modelCount = 0;
    }
    return {
      id,
      display_name: meta?.display ?? titleCase(id),
      kind: "cloud",
      auth_method: meta?.auth ?? "api-key",
      available: true,
      model_count: modelCount,
      notes: meta?.notes,
    };
  });
  // Stable sort: display_name asc, so the dashboard dropdown is
  // deterministic regardless of pi-ai's internal order.
  out.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return out;
}

/** True iff the provider (after alias resolution) is in pi-ai's
 *  catalog. The dashboard POST handler uses this to reject stale
 *  references at write time so accounts.conf can't drift. */
export function isCatalogProvider(id: string): boolean {
  const canonical = resolveProviderId(id);
  return listCatalogProviders().some((p) => p.id === canonical);
}
