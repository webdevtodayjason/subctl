// components/evy/tier1-consolidator.ts
//
// Tier 1 Consolidator (v2.9.0) — LLM-driven dedup pass for the pending
// candidate queue. The 5-minute memory-kernel reviewer is rule-permissive
// (errs on the side of proposing). Combined with the operator's actual
// conversational patterns (operator says "be terse" multiple ways across
// multiple sessions), the candidate queue accumulates semantic duplicates.
// Approving linearly burns the Tier 1 char budget on near-dups.
//
// This module:
//   1. Builds a consolidation prompt (current memory.md + pending candidates
//      + char budget + headroom).
//   2. Sends it to the supervisor model via the injected llmFetcher.
//   3. Parses + validates the structured JSON response.
//   4. Computes char-budget math the dashboard renders as a green/yellow/red
//      meter so the operator can spot over-budget proposals before Apply.
//
// Pure Bun/TS module — no fs, no master-daemon coupling. The endpoint
// handler in server.ts injects deps that read live state.
//
// Operator-in-the-loop is required by design — the consolidator NEVER
// writes Tier 1 by itself. It returns a proposal the operator reviews and
// approves via the dashboard modal.
//
// Design contract: see ~/Documents/Obsidian Vault/Subctl/Initiatives/
// Tier 1 Consolidator.md.

import type {
  LlmFetcherOpts,
  LlmMessage,
} from "./memory-kernel-reviewer";
import type { Tier1Candidate } from "./tier1-candidates";

// ─── public types ─────────────────────────────────────────────────────────

export const CONSOLIDATOR_SOURCE_TYPES = [
  "operator-asserted",
  "verified-external",
  "self-inferred",
  "agent-reported",
] as const;
export type ConsolidatorSourceType = (typeof CONSOLIDATOR_SOURCE_TYPES)[number];

const SOURCE_TYPE_SET: ReadonlySet<string> = new Set(CONSOLIDATOR_SOURCE_TYPES);

export interface ConsolidatedEntry {
  /** Consolidated fact, one concise sentence. */
  text: string;
  /** Highest-trust source amongst the merged candidates. */
  source_type: ConsolidatorSourceType;
  /** Why this consolidation — surfaced in the dashboard UI. */
  rationale: string;
  /** Candidate ids that the entry merges. >=1 entry. */
  merged_from_candidate_ids: string[];
}

export interface ConsolidateProposal {
  ok: true;
  proposal: ConsolidatedEntry[];
  /** Candidates the LLM decided to drop entirely (redundant / low-conf / already covered). */
  dropped_candidate_ids: string[];
  /** candidate_id → human-readable reason. */
  dropped_reasons: Record<string, string>;
  /** Candidates the LLM didn't touch — neither merged nor dropped. Rare; surfaces in UI. */
  pending_unchanged_candidate_ids: string[];
  /** Total chars ADDED by applying the proposal (delta over current memory.md). */
  char_total: number;
  /** Current SUBCTL_MEMORY_LIMIT. */
  char_budget: number;
  /** Current memory.md size in chars. */
  char_current: number;
  /** char_budget - (char_current + char_total). Negative = over budget. */
  headroom_after: number;
  /** "<provider>/<model>" of supervisor that did the consolidation. */
  reviewer_model: string;
  /** Only present when dry_run=true — raw LLM response for debugging. */
  llm_raw_response?: string;
}

export interface ConsolidateError {
  ok: false;
  /** Sanitized human-readable error message. */
  error: string;
  /** "<provider>/<model>" — populated whenever supervisor identity is known. */
  reviewer_model: string;
  /** Raw LLM response if the call succeeded but parsing failed. */
  llm_raw_response?: string;
}

export type ConsolidateResult = ConsolidateProposal | ConsolidateError;

export interface ConsolidatorDeps {
  /** Returns pending candidates (typically wired to tier1-candidates.listPending). */
  listPending: () => Tier1Candidate[];
  /** Returns current memory.md content. Empty string if file missing. */
  readMemoryContent: () => string;
  /** Returns the current SUBCTL_MEMORY_LIMIT. */
  charBudget: () => number;
  /** Dispatches the LLM call. Mirrors memory-kernel-reviewer's contract. */
  llmFetcher: (messages: LlmMessage[], opts: LlmFetcherOpts) => Promise<string>;
  /** "<provider>/<model>" of supervisor that did the consolidation. */
  configuredSupervisor: () => { provider: string; model: string };
}

export interface ConsolidateInput {
  /** When true, includes the raw LLM response for debugging. */
  dry_run?: boolean;
}

// ─── char budget math ────────────────────────────────────────────────────
//
// Mirrors the serializeEntries / writeMemory shape in
// components/evy/tools/tier1-memory.ts so the dashboard meter matches
// what memory_remember would actually compute on Apply.

/** Section break between memory.md entries — must match ENTRY_DELIMITER in tier1-memory.ts. */
const ENTRY_DELIMITER = "\n§\n";

/** Build the tagged provenance line that lands in memory.md. */
export function buildTaggedEntry(
  text: string,
  source_type: ConsolidatorSourceType,
): string {
  return `[source:${source_type}] ${text.trim()}`;
}

/**
 * Project the new memory.md content if `entries` were appended after
 * `currentContent`. Returns the projected serialized string.
 *
 * Matches memory_remember's serializeEntries shape: existing entries are
 * already joined by ENTRY_DELIMITER inside currentContent; appending more
 * means we prepend the delimiter only if currentContent is non-empty.
 */
export function projectMemoryContent(
  currentContent: string,
  entries: ConsolidatedEntry[],
): string {
  if (entries.length === 0) return currentContent;
  const taggedEntries = entries.map((e) =>
    buildTaggedEntry(e.text, e.source_type),
  );
  const appended = taggedEntries.join(ENTRY_DELIMITER);
  if (currentContent.trim().length === 0) return appended;
  return currentContent + ENTRY_DELIMITER + appended;
}

/**
 * Compute char-budget math for the dashboard meter.
 *   char_current     = current memory.md size
 *   char_total       = chars ADDED by applying the proposal
 *   headroom_after   = char_budget - (char_current + char_total). Negative = over budget.
 */
export function computeCharBudgetMath(args: {
  currentContent: string;
  charBudget: number;
  proposal: ConsolidatedEntry[];
}): { char_current: number; char_total: number; headroom_after: number } {
  const char_current = args.currentContent.length;
  const projected = projectMemoryContent(args.currentContent, args.proposal);
  const char_total = Math.max(0, projected.length - char_current);
  const headroom_after = args.charBudget - (char_current + char_total);
  return { char_current, char_total, headroom_after };
}

// ─── prompt building ──────────────────────────────────────────────────────

export function buildConsolidatorSystemPrompt(): string {
  return [
    "You are the subCTL Tier 1 memory consolidator.",
    "",
    "Tier 1 memory lives in the operator's system prompt forever. A bad",
    "merge is more durable than a good one. Be conservative: prefer",
    "preserving distinct facts over aggressive deduplication.",
    "",
    "You consolidate a list of proposed durable memories that the",
    "memory-kernel reviewer flagged for operator approval. Many entries",
    "are near-duplicates (the same operator preference expressed",
    "multiple ways across multiple sessions) — your job is to collapse",
    "them into the minimum distinct set while preserving operator intent.",
    "",
    "RULES (non-negotiable):",
    "  1. Identify semantic duplicates among the candidates and merge",
    "     them into a single entry. Pick the highest-trust source_type",
    "     from the merged group:",
    "       operator-asserted > verified-external > self-inferred > agent-reported",
    "  2. DROP candidates already covered by entries in the CURRENT MEMORY",
    "     block — do not re-promote facts that are already filed.",
    "  3. DROP candidates with confidence < 0.7 that have no unique signal",
    "     beyond what higher-confidence candidates already express.",
    "  4. PRESERVE distinct facts — never merge two semantically different",
    "     facts just to save budget.",
    "  5. STAY UNDER THE AVAILABLE HEADROOM. If the union of merged",
    "     entries would exceed it, drop the weakest-signal entries first.",
    "  6. Every consolidated entry MUST cite >=1 candidate id in",
    "     merged_from_candidate_ids. Cited ids must come from the",
    "     CANDIDATES list — do not invent ids.",
    "  7. Every dropped entry MUST appear in dropped_reasons with a short",
    "     human-readable explanation.",
    "",
    "OUTPUT FORMAT — JSON ONLY. No prose, no markdown fences, no comments.",
    "{",
    '  "proposal": [',
    "    {",
    '      "text": "Operator prefers terse responses.",',
    '      "source_type": "operator-asserted",',
    '      "rationale": "Merged 3 candidates that all express the same brevity preference",',
    '      "merged_from_candidate_ids": ["c_mpc8gp_...", "c_mpc8na_...", "c_mpc8q3_..."]',
    "    }",
    "  ],",
    '  "dropped_candidate_ids": ["c_mpc9aa_..."],',
    '  "dropped_reasons": {',
    '    "c_mpc9aa_...": "Low confidence (0.5) and redundant with merged entry above"',
    "  }",
    "}",
    "",
    "FIELD RULES:",
    "  - source_type: exactly one of operator-asserted, verified-external,",
    "    self-inferred, agent-reported.",
    "  - text: one concise sentence. Self-contained. No trailing period",
    "    required but allowed.",
    "  - rationale: short — one sentence on why this consolidation.",
    "  - merged_from_candidate_ids: array of >=1 candidate id strings.",
    "  - dropped_candidate_ids: array of strings (may be empty).",
    "  - dropped_reasons: object mapping every dropped id to a reason.",
  ].join("\n");
}

export function buildConsolidatorUserPrompt(args: {
  currentMemoryContent: string;
  candidates: Tier1Candidate[];
  charBudget: number;
}): string {
  const lines: string[] = [];
  const currentLen = args.currentMemoryContent.length;
  const headroom = Math.max(0, args.charBudget - currentLen);

  lines.push("CURRENT MEMORY (already stored — do NOT re-propose):");
  if (currentLen === 0) {
    lines.push("  (empty)");
  } else {
    lines.push("```");
    lines.push(args.currentMemoryContent);
    lines.push("```");
  }
  lines.push("");
  lines.push(`Char budget (SUBCTL_MEMORY_LIMIT): ${args.charBudget}`);
  lines.push(`Currently used: ${currentLen}`);
  lines.push(`Available headroom: ${headroom}`);
  lines.push(
    `Per-entry overhead: ~${ENTRY_DELIMITER.length} chars delimiter + ~25 chars provenance tag.`,
  );
  lines.push("");
  lines.push(`CANDIDATES pending review (count=${args.candidates.length}):`);
  lines.push("");
  for (const c of args.candidates) {
    lines.push(`[id=${c.id}]`);
    lines.push(`  proposed_at: ${c.proposed_at}`);
    lines.push(`  kind:        ${c.kind}`);
    lines.push(`  confidence:  ${c.confidence}`);
    lines.push(`  reason:      ${c.reason}`);
    lines.push(`  memory:      ${c.memory}`);
    lines.push("");
  }
  lines.push("Produce the consolidation JSON. Output JSON only.");
  return lines.join("\n");
}

// ─── JSON extraction + validation ─────────────────────────────────────────

/** Same dumb-but-effective strategy as memory-kernel-reviewer.extractJsonObject. */
export function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

interface ParsedProposal {
  proposal: ConsolidatedEntry[];
  dropped_candidate_ids: string[];
  dropped_reasons: Record<string, string>;
}

/**
 * Validate the LLM's response against the consolidator contract. Returns
 * the parsed proposal on success, or an error string describing the first
 * fatal validation failure.
 *
 * Tolerant of `dropped_reasons` being absent or partial — fills missing
 * reasons with a default placeholder so the UI doesn't blank out.
 *
 * `knownCandidateIds` is the set of ids the operator actually has
 * pending. Cited ids outside this set are silently dropped from
 * merged_from_candidate_ids; if that leaves an entry with zero citations
 * the whole entry is dropped (with an error if it leaves the proposal
 * empty AND the LLM had nothing else to say).
 */
export function parseConsolidatorResponse(
  raw: string,
  knownCandidateIds: ReadonlySet<string>,
): ParsedProposal | { error: string } {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") {
    return { error: "supervisor returned non-JSON response" };
  }
  const r = obj as Record<string, unknown>;

  if (!Array.isArray(r.proposal)) {
    return { error: "supervisor response missing `proposal` array" };
  }

  const proposal: ConsolidatedEntry[] = [];
  for (const item of r.proposal) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;

    if (!isNonEmptyString(e.text)) continue;
    if (!isNonEmptyString(e.source_type)) continue;
    if (!SOURCE_TYPE_SET.has(e.source_type)) continue;
    if (!isNonEmptyString(e.rationale)) continue;
    if (!Array.isArray(e.merged_from_candidate_ids)) continue;

    const merged = e.merged_from_candidate_ids
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .filter((id) => knownCandidateIds.has(id));
    if (merged.length === 0) continue;

    proposal.push({
      text: e.text.trim(),
      source_type: e.source_type as ConsolidatorSourceType,
      rationale: e.rationale.trim(),
      merged_from_candidate_ids: merged,
    });
  }

  const droppedIdsRaw = Array.isArray(r.dropped_candidate_ids)
    ? r.dropped_candidate_ids
    : [];
  const droppedIds = droppedIdsRaw
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .filter((id) => knownCandidateIds.has(id));

  const droppedReasons: Record<string, string> = {};
  const reasonsRaw =
    r.dropped_reasons && typeof r.dropped_reasons === "object"
      ? (r.dropped_reasons as Record<string, unknown>)
      : {};
  for (const id of droppedIds) {
    const reason = reasonsRaw[id];
    droppedReasons[id] = isNonEmptyString(reason)
      ? reason.trim()
      : "(no reason provided)";
  }

  if (proposal.length === 0 && droppedIds.length === 0) {
    return {
      error:
        "supervisor response yielded no valid entries (proposal empty AND dropped empty)",
    };
  }

  return { proposal, dropped_candidate_ids: droppedIds, dropped_reasons: droppedReasons };
}

// ─── public entry point ───────────────────────────────────────────────────

/**
 * Run one consolidation cycle. NEVER throws — returns a structured
 * ConsolidateError on any failure so the endpoint can render a clean 500.
 *
 * Empty candidate queue fast-path: returns a zero proposal without an
 * LLM call (saves credits + latency).
 */
export async function consolidate(
  input: ConsolidateInput,
  deps: ConsolidatorDeps,
): Promise<ConsolidateResult> {
  // CodeRabbit pass-7: honor the "NEVER throws" contract — wrap deps
  // resolution + dispatch in a top-level try/catch so any throw
  // (file-read errors, malformed providers.json, etc.) returns a
  // structured ConsolidateError instead of crashing the endpoint.
  let supervisor: { provider: string; model: string };
  let reviewer_model: string;
  let candidates: Tier1Candidate[];
  let currentContent: string;
  let charBudget: number;
  try {
    supervisor = deps.configuredSupervisor();
    reviewer_model = `${supervisor.provider}/${supervisor.model}`;
    candidates = deps.listPending();
    currentContent = deps.readMemoryContent();
    charBudget = deps.charBudget();
  } catch (err) {
    return {
      ok: false,
      error: `consolidator deps failed to resolve: ${(err as Error).message ?? err}`,
      reviewer_model: "(unresolved)",
    };
  }

  // Empty queue → trivial proposal, no LLM call.
  if (candidates.length === 0) {
    const math = computeCharBudgetMath({
      currentContent,
      charBudget,
      proposal: [],
    });
    return {
      ok: true,
      proposal: [],
      dropped_candidate_ids: [],
      dropped_reasons: {},
      pending_unchanged_candidate_ids: [],
      char_total: math.char_total,
      char_budget: charBudget,
      char_current: math.char_current,
      headroom_after: math.headroom_after,
      reviewer_model,
    };
  }

  const systemPrompt = buildConsolidatorSystemPrompt();
  const userPrompt = buildConsolidatorUserPrompt({
    currentMemoryContent: currentContent,
    candidates,
    charBudget,
  });

  let raw: string;
  try {
    raw = await deps.llmFetcher(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        provider: supervisor.provider,
        model: supervisor.model,
        max_tokens: 4096,
        temperature: 0.1,
      },
    );
  } catch (err) {
    return {
      ok: false,
      error: `supervisor LLM call failed: ${(err as Error).message}`,
      reviewer_model,
    };
  }

  if (!raw || raw.trim().length === 0) {
    return {
      ok: false,
      error: "supervisor returned an empty response",
      reviewer_model,
      llm_raw_response: raw,
    };
  }

  const knownIds = new Set(candidates.map((c) => c.id));
  const parsed = parseConsolidatorResponse(raw, knownIds);
  if ("error" in parsed) {
    return {
      ok: false,
      error: `supervisor returned malformed proposal: ${parsed.error}`,
      reviewer_model,
      llm_raw_response: raw,
    };
  }

  // Anything the LLM neither merged nor dropped surfaces in the UI as
  // "consider these too" — rare, but a useful safety net.
  const touched = new Set<string>(parsed.dropped_candidate_ids);
  for (const entry of parsed.proposal) {
    for (const id of entry.merged_from_candidate_ids) touched.add(id);
  }
  const pending_unchanged_candidate_ids = candidates
    .map((c) => c.id)
    .filter((id) => !touched.has(id));

  const math = computeCharBudgetMath({
    currentContent,
    charBudget,
    proposal: parsed.proposal,
  });

  const out: ConsolidateProposal = {
    ok: true,
    proposal: parsed.proposal,
    dropped_candidate_ids: parsed.dropped_candidate_ids,
    dropped_reasons: parsed.dropped_reasons,
    pending_unchanged_candidate_ids,
    char_total: math.char_total,
    char_budget: charBudget,
    char_current: math.char_current,
    headroom_after: math.headroom_after,
    reviewer_model,
  };
  if (input.dry_run) {
    out.llm_raw_response = raw;
  }
  return out;
}
