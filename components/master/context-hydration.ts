// components/master/context-hydration.ts
//
// v2.10.0 — Memory Cycle Phase 4: context slimming on boot + post-compact.
//
// Why this module exists
// ----------------------
// The master used to replay `~/.config/subctl/master/agent-state.json` (the
// raw transcript) into `agent.state.messages` at every boot and again after
// `/compact` chopped the tail off. That worked while transcripts were short.
// Once Cognee + Memori landed and the curated Tier 3 layer grew past a
// hundred rows, raw replay was wasting tens of thousands of supervisor
// tokens on noise the consciousness cycle had already distilled.
//
// Phase 4's contract: KEEP the raw transcript on disk for audit (still
// loaded into agent.state.messages so multi-turn coherence holds), but at
// boot AND after every compaction event, ALSO prepend a self-bounded
// `[memory-context-hydration]` block to the FIRST new prompt. That block
// summarises curated Tier 3 + top-N Cognee graph hits — the synthesis the
// downstream LLM would otherwise have to re-derive from raw bulk.
//
// The block is intentionally a `role: "user"` message (mirrors the
// compact-summary pattern at server.ts:2964) rather than a system-prompt
// addendum because:
//   - it's a per-prompt, one-shot artifact, not a recurring rule
//   - it shows up in the dashboard transcript view so the operator can
//     audit "what was hydrated for me at this moment"
//   - it doesn't compete with composeSystemPrompt's per-turn curated
//     section (v2.8.11) — those are different lifecycle: every-turn
//     fresh recall vs one-shot hydration at boot/compact boundaries
//
// What goes IN the payload
// ------------------------
//   - 1..N curated Memori rows (Tier 3 — survivors of the consciousness
//     cycle, kind="decision"/"preference"/"fact"/"project-state"/..., scored)
//   - 0..K Cognee graph hits (Tier 4 — `recall()` against a configurable
//     relevance_query; default null → skip Cognee entirely)
//   - a counts header so the LLM (and operator on review) immediately
//     knows the section's size + provenance
//
// What goes IN but is JUST INFORMATIONAL
//   - Tier 1 byte count (memory.md). Tier 1 is auto-injected via the
//     system prompt anyway; we surface its size in the source counts so the
//     audit trail records the full set of memory layers that informed
//     this prompt.
//
// What does NOT go in
//   - raw transcript bulk (that's the file on disk; this is the slimming)
//   - the operator's actual prompt (lands NATURALLY after this synthetic
//     message via the normal agent.prompt() call)
//   - Tier 2 / runtime telemetry (not part of the slimming contract)
//
// Failure modes
// -------------
// We never throw out of hydrateContext. Any of the four data sources can
// be unreachable independently:
//   - Memori sidecar down → no curated facts, but still emit the empty
//     marker block so the LLM knows hydration was attempted
//   - Cognee service down → skip GRAPH CONTEXT section, keep curated
//   - Cognee throws → caught locally, treated as "no graph hits"
//   - memory.md missing → tier1_chars = 0
//
// The only way to get ok: false is if BOTH primary sources crash at the
// transport level (network refusal AND filesystem error in a row, which
// in practice means master has bigger problems than missing hydration).

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── public types ──────────────────────────────────────────────────────────

/**
 * One curated row out of the Memori `subctl_memori_curated` table. Shape
 * mirrors `MemoriHit` from memori-client but stripped of optional fields
 * we don't render (score, raw metadata). Kept narrow so the deps-injected
 * test stubs don't need to satisfy the full HTTP contract.
 */
export interface MemoriCuratedRow {
  /** Curated row id; the "curated_" prefix is enforced by the source. */
  id: string;
  /** Promoted memory text — what gets rendered into the hydration block. */
  text: string;
  /** ISO-8601 timestamp. Used for newest-first sort + audit trail. */
  ts?: string;
  /**
   * Optional taxonomic tag from the reviewer (e.g. "decision",
   * "preference", "fact", "project-state"). Surfaced inline so the LLM
   * sees the row's category without parsing.
   */
  kind?: string;
  /**
   * Optional confidence score (0..1). Surfaced when present so the LLM
   * can weight low-confidence rows differently from high-confidence ones.
   */
  confidence?: number;
}

/**
 * One Cognee graph hit returned by `recall()`. Shape mirrors
 * `CogneeRecallHit` from cognee-client but narrowed to what we render.
 */
export interface CogneeHit {
  /** Best-effort: the matched text or summary. */
  text: string;
  /** Optional score; rendered when present. */
  score?: number;
  /** Optional stable id. Rendered when present for audit. */
  id?: string;
}

export interface HydrationInput {
  /** Operator entity scope — typically `policy.operator.name` lowercased. */
  entity_id: string;
  /** Max curated rows to pull. Server clamps to >=1. */
  recent_curated_limit: number;
  /**
   * Optional Cognee graph query. When null/empty, Cognee is SKIPPED
   * entirely (no hit, no error). Set to a domain-relevant phrase like
   * "current task" or "project state" to seed the graph traversal.
   */
  cognee_relevance_query?: string | null;
  /** Max Cognee hits. Ignored when relevance_query is null. */
  cognee_limit: number;
  /**
   * Optional Tier 1 path for the informational byte counter. When
   * omitted we resolve from SUBCTL_CONFIG_DIR or ~/.config/subctl/master/memory.md.
   * Tier 1 is NOT rendered into the payload — composeSystemPrompt
   * already injects it. We just report its size for audit.
   */
  tier1_memory_md_path?: string;
}

export interface HydrationResult {
  /**
   * True when the hydration attempt completed without a structural
   * failure. ok: true is compatible with EMPTY data — sidecar down +
   * Cognee disabled + empty memory.md still returns ok: true with an
   * empty marker payload.
   */
  ok: boolean;
  /**
   * The formatted prepend block, ready to push as a `role: "user"`
   * message. Always non-empty when ok: true — at minimum the open/close
   * markers fire so the LLM can see hydration WAS attempted.
   */
  context_payload: string;
  /** Provenance counts for the dashboard / decision log. */
  sources: {
    memori_curated_count: number;
    cognee_hits_count: number;
    tier1_chars: number;
  };
  /** Set when ok: false. Best-effort root cause. */
  error?: string;
}

export interface HydrationDeps {
  /**
   * Pull curated Tier 3 rows for the entity. Implementations:
   *   - production: memoriRecall + filterCuratedHits (matches v2.8.11)
   *   - tests: returns whatever the stub injects
   */
  listMemoriCurated: (args: {
    entity_id: string;
    limit: number;
  }) => Promise<MemoriCuratedRow[]>;
  /**
   * Query the Cognee graph for top-N hits. Implementations:
   *   - production: cogneeClient.recall
   *   - tests: stub returns canned hits / throws to exercise failure
   */
  queryCognee: (args: {
    query: string;
    limit: number;
  }) => Promise<CogneeHit[]>;
  /** Clock seam. */
  now: () => Date;
}

// ─── pure formatting helpers ──────────────────────────────────────────────

/**
 * Header marker — opens the hydration block. Includes ISO timestamp +
 * source counts so the LLM (and operator on transcript review)
 * immediately knows the block's age and provenance.
 *
 * Format:
 *   [memory-context-hydration · 2026-05-23T17:30:00.000Z · 18 curated + 5 graph hits]
 */
export function formatOpenMarker(
  ts: Date,
  curatedCount: number,
  cogneeCount: number,
): string {
  return `[memory-context-hydration · ${ts.toISOString()} · ${curatedCount} curated + ${cogneeCount} graph hits]`;
}

/** Closing marker — same shape as compactTranscriptInline's bracket conventions. */
export const CLOSE_MARKER = "[/memory-context-hydration]";

/**
 * Render the curated section. Returns "" when no rows (caller decides
 * whether to suppress the section header).
 */
export function formatCuratedSection(rows: MemoriCuratedRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r, i) => {
    const n = i + 1;
    const kind = r.kind ?? "fact";
    const conf =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? r.confidence.toFixed(2)
        : null;
    const tag = conf ? `[${kind}/${conf}]` : `[${kind}]`;
    return `${n}. ${tag} ${r.text}`;
  });
  return ["CURATED FACTS (recent + high-confidence):", ...lines].join("\n");
}

/**
 * Render the Cognee graph section. Returns "" when no hits (caller
 * decides whether to suppress).
 */
export function formatGraphSection(
  hits: CogneeHit[],
  query: string | null | undefined,
): string {
  if (hits.length === 0) return "";
  const label = query && query.trim().length > 0
    ? `GRAPH CONTEXT (top-relevance hits for "${query.trim()}"):`
    : "GRAPH CONTEXT (top-relevance hits):";
  const lines = hits.map((h) => {
    const score =
      typeof h.score === "number" && Number.isFinite(h.score)
        ? ` [score=${h.score.toFixed(2)}]`
        : "";
    return `- [Cognee${score}] ${h.text}`;
  });
  return [label, ...lines].join("\n");
}

/**
 * Compose the full payload. Pure — no I/O. Caller wires the inputs.
 *
 * Always returns a non-empty string when invoked: at minimum the
 * open/close markers fire so the LLM sees hydration WAS attempted
 * (vs silent no-op).
 */
export function formatHydrationPayload(args: {
  ts: Date;
  curated: MemoriCuratedRow[];
  cognee: CogneeHit[];
  cogneeQuery: string | null | undefined;
}): string {
  const header = formatOpenMarker(args.ts, args.curated.length, args.cognee.length);
  const sections: string[] = [];
  const curatedBlock = formatCuratedSection(args.curated);
  if (curatedBlock) sections.push(curatedBlock);
  const graphBlock = formatGraphSection(args.cognee, args.cogneeQuery);
  if (graphBlock) sections.push(graphBlock);
  const body = sections.length > 0 ? `\n\n${sections.join("\n\n")}\n\n` : "\n";
  return `${header}${body}${CLOSE_MARKER}`;
}

// ─── tier1 size probe (pure-ish — reads memory.md only) ───────────────────

function resolveDefaultTier1Path(): string {
  const cfg =
    process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
  return join(cfg, "master", "memory.md");
}

/**
 * Best-effort byte counter for memory.md. Failures are silent — the
 * counter is informational only (memory.md is auto-injected by
 * composeSystemPrompt; we just record its size for audit).
 */
export function tier1ByteCount(path?: string): number {
  const resolved = path ?? resolveDefaultTier1Path();
  try {
    if (!existsSync(resolved)) return 0;
    return statSync(resolved).size;
  } catch {
    return 0;
  }
}

// ─── main entry point ──────────────────────────────────────────────────────

/**
 * Build a context-hydration payload from injected sources. Returns
 * `ok: true` with an empty-marker payload when both sources are empty
 * (still useful — the LLM sees a hydration attempt happened, the
 * dashboard surfaces the zero counts).
 *
 * Only returns `ok: false` when listMemoriCurated itself rejects — i.e.
 * a transport-level failure the caller could surface as "hydration
 * failed entirely." Cognee failures are absorbed locally (treated as
 * "no graph hits") so a Cognee outage never blocks Memori-only
 * hydration.
 */
export async function hydrateContext(
  input: HydrationInput,
  deps: HydrationDeps,
): Promise<HydrationResult> {
  const limit = Math.max(1, input.recent_curated_limit);
  let curated: MemoriCuratedRow[];
  try {
    const raw = await deps.listMemoriCurated({
      entity_id: input.entity_id,
      limit,
    });
    // Enforce the limit on the consumer side too — defends against deps
    // that ignore the bound (e.g. a stub returning everything).
    curated = raw.slice(0, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      context_payload: "",
      sources: {
        memori_curated_count: 0,
        cognee_hits_count: 0,
        tier1_chars: tier1ByteCount(input.tier1_memory_md_path),
      },
      error: `listMemoriCurated threw: ${message}`,
    };
  }

  // Cognee is OPTIONAL — null/empty query means skip the call entirely.
  let cognee: CogneeHit[] = [];
  const cogneeQuery = (input.cognee_relevance_query ?? "").trim();
  if (cogneeQuery.length > 0 && input.cognee_limit > 0) {
    try {
      const raw = await deps.queryCognee({
        query: cogneeQuery,
        limit: Math.max(1, input.cognee_limit),
      });
      cognee = raw.slice(0, Math.max(1, input.cognee_limit));
    } catch (err) {
      // Swallow — Cognee outage must NOT abort hydration. We log only
      // through the count: cognee_hits_count: 0 is the signal.
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort stderr so operators tailing master.log see the cause
      // without us having to wire a callback through deps.
      console.error(
        `[context-hydration] cognee query failed (continuing without graph hits): ${message}`,
      );
      cognee = [];
    }
  }

  const payload = formatHydrationPayload({
    ts: deps.now(),
    curated,
    cognee,
    cogneeQuery: cogneeQuery.length > 0 ? cogneeQuery : null,
  });

  return {
    ok: true,
    context_payload: payload,
    sources: {
      memori_curated_count: curated.length,
      cognee_hits_count: cognee.length,
      tier1_chars: tier1ByteCount(input.tier1_memory_md_path),
    },
  };
}

// ─── config + env gate ────────────────────────────────────────────────────

export interface ContextHydrationConfig {
  enabled: boolean;
  recent_curated_limit: number;
  cognee_limit: number;
  /** null = skip Cognee (Memori-only hydration). */
  cognee_relevance_query: string | null;
}

export const DEFAULT_CONFIG: ContextHydrationConfig = {
  enabled: true,
  recent_curated_limit: 20,
  cognee_limit: 5,
  cognee_relevance_query: null,
};

/**
 * Resolve `~/.config/subctl/master/context-hydration.json`. Returns
 * DEFAULT_CONFIG when the file is missing or malformed.
 *
 * Env override `SUBCTL_CONTEXT_SLIMMING_ENABLED=0` forces enabled:false
 * regardless of file contents — operator escape hatch.
 */
export function loadContextHydrationConfig(path?: string): ContextHydrationConfig {
  const resolved =
    path ??
    join(
      process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl"),
      "master",
      "context-hydration.json",
    );
  let fromFile: ContextHydrationConfig = { ...DEFAULT_CONFIG };
  if (existsSync(resolved)) {
    try {
      const raw = readFileSync(resolved, "utf8");
      const parsed = JSON.parse(raw) as Partial<ContextHydrationConfig>;
      fromFile = {
        enabled:
          typeof parsed.enabled === "boolean"
            ? parsed.enabled
            : DEFAULT_CONFIG.enabled,
        recent_curated_limit:
          typeof parsed.recent_curated_limit === "number" &&
          Number.isFinite(parsed.recent_curated_limit) &&
          parsed.recent_curated_limit > 0
            ? Math.floor(parsed.recent_curated_limit)
            : DEFAULT_CONFIG.recent_curated_limit,
        cognee_limit:
          typeof parsed.cognee_limit === "number" &&
          Number.isFinite(parsed.cognee_limit) &&
          parsed.cognee_limit >= 0
            ? Math.floor(parsed.cognee_limit)
            : DEFAULT_CONFIG.cognee_limit,
        cognee_relevance_query:
          typeof parsed.cognee_relevance_query === "string" &&
          parsed.cognee_relevance_query.trim().length > 0
            ? parsed.cognee_relevance_query
            : null,
      };
    } catch (err) {
      console.error(
        `[context-hydration] config parse failed at ${resolved} — falling back to defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Env override wins for the kill-switch — operator can disable
  // without editing the JSON.
  const envFlag = process.env.SUBCTL_CONTEXT_SLIMMING_ENABLED;
  if (envFlag === "0" || envFlag === "false" || envFlag === "no") {
    fromFile = { ...fromFile, enabled: false };
  }
  return fromFile;
}
