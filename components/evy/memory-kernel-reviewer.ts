// components/evy/memory-kernel-reviewer.ts
//
// Memory Consciousness Cycle — Reviewer (Worker B deliverable).
//
// Pure Bun/TS module. No side effects. No fs. No master-daemon coupling.
//
// Takes raw Tier 3 events + operator context, calls the configured
// supervisor LLM with Evy's exact JSON contract, parses the response,
// returns a typed decisions array. The watchdog (Worker C) injects
// `llmFetcher` / `configuredSupervisor` closures that read master's live
// state; this module never touches disk or globals itself.
//
// Design contract: see ~/Documents/Obsidian Vault/Subctl/design/
// memory-kernel-consciousness-cycle.md — section "Reviewer Prompt Contract".

// ─── public types ─────────────────────────────────────────────────────────

/**
 * Raw event shape as returned by Worker A's /select_unreviewed Memori
 * sidecar route. Most fields are optional because tool-only events have
 * no user/assistant text, conversation events have no tool calls, etc.
 */
export interface RawEvent {
  id: string;
  ts: number | string;
  user_text?: string;
  assistant_text?: string;
  tool_calls_json?: string;
  decisions_json?: string;
  outcomes_json?: string;
  metadata_json?: string;
}

/**
 * Context bag threaded into the prompt so the reviewer can:
 *   1. avoid re-promoting facts that are already curated (Tier 1 + Evy)
 *   2. scope reasoning to the current project when known
 *   3. address the operator by name in escalations
 */
export interface ReviewerContext {
  operator_name: string;
  recent_tier1_facts?: string[];
  recent_evy_memories?: string[];
  active_project?: string;
}

export type ReviewAction =
  | "discard"
  | "keep_raw"
  | "promote_tier3"
  | "propose_tier1"
  | "escalate";

export type ReviewKind =
  | "decision"
  | "preference"
  | "finding"
  | "project-state"
  | "operator-note"
  | "design-note";

const ACTION_SET: ReadonlySet<ReviewAction> = new Set<ReviewAction>([
  "discard",
  "keep_raw",
  "promote_tier3",
  "propose_tier1",
  "escalate",
]);

const KIND_SET: ReadonlySet<ReviewKind> = new Set<ReviewKind>([
  "decision",
  "preference",
  "finding",
  "project-state",
  "operator-note",
  "design-note",
]);

const PROMOTING_ACTIONS: ReadonlySet<ReviewAction> = new Set<ReviewAction>([
  "promote_tier3",
  "propose_tier1",
]);

export interface ReviewDecision {
  source_event_ids: string[];
  action: ReviewAction;
  memory?: string;
  kind?: ReviewKind;
  reason: string;
  confidence: number;
}

export interface ReviewerOutput {
  decisions: ReviewDecision[];
  /** "<provider>/<model>" of the supervisor used. Mirrors configuredSupervisor(). */
  reviewer_model: string;
  /** Wall-clock ms from cycle entry to return (includes LLM call). */
  cycle_ms: number;
}

/** Minimal chat message shape — provider-agnostic. */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Options passed to the llmFetcher. The fetcher is responsible for
 * dispatching to the right provider transport (Codex /responses, OpenAI
 * /chat/completions, LM Studio /v1/chat/completions, etc.).
 *
 * `authToken` is resolved by the CALLER (Worker C's watchdog), not this
 * module — that's how we stay pure: no fs, no oauth refresh logic here.
 */
export interface LlmFetcherOpts {
  provider: string;
  model: string;
  /** Provider base URL. Required for non-default endpoints (LM Studio, OpenRouter, …). */
  baseUrl?: string;
  /** Auth bearer/token. Caller resolves from secrets / OAuth / etc. */
  authToken?: string;
  /** Soft cap on output tokens. Reviewer asks for compact JSON; 4096 is plenty. */
  max_tokens?: number;
  /** Lower → more deterministic. Reviewer wants 0.1-ish; structured JSON. */
  temperature?: number;
  /** Optional abort signal (watchdog uses cycle timeout). */
  signal?: AbortSignal;
}

/**
 * All deps the reviewer needs are test-injectable. In production Worker C
 * builds these from master daemon state. In tests we inject mocks.
 *
 * All fields are optional via `Partial<ReviewerDeps>` on the public
 * function; defaults are conservative:
 *   - `now` = `Date.now`
 *   - `configuredSupervisor` returns ("unknown", "unknown") — caller
 *     should always override in prod so reviewer_model is meaningful
 *   - `llmFetcher` throws — there's no sensible "do an LLM call by
 *     magic" default in a pure module
 */
export interface ReviewerDeps {
  llmFetcher: (messages: LlmMessage[], opts: LlmFetcherOpts) => Promise<string>;
  now: () => number;
  configuredSupervisor: () => { provider: string; model: string };
}

// ─── prompt building ──────────────────────────────────────────────────────

/**
 * Build the system prompt encoding Evy's reviewer contract + rules.
 * Exported for test transparency and so the watchdog can log it on
 * dry-run cycles.
 */
export function buildReviewerSystemPrompt(): string {
  return [
    "You are the subCTL memory-kernel reviewer.",
    "",
    "ROLE: scan recent raw Tier 3 conversation events captured between the",
    "operator and the assistant (Evy). Decide what to do with each event",
    "or coherent cluster of events. You run autonomously in the background;",
    "the operator never sees your output directly — they only see the",
    "downstream effect of promoted memories surfacing in future turns.",
    "",
    "ACTIONS (pick exactly one per decision):",
    "  - discard:         noise, transient, duplicate, tool chatter,",
    "                     trivial acknowledgement (\"ok\", \"thanks\", \"sounds good\")",
    "  - keep_raw:        useful for later search but not durable enough",
    "                     to curate; raw event stays, no promotion",
    "  - promote_tier3:   durable conversation fact — a decision, finding,",
    "                     preference, project state, operator note, or",
    "                     design note worth surfacing later via recall",
    "  - propose_tier1:   stable operator preference or profile fact worth",
    "                     keeping always-in-context. STRICTER threshold than",
    "                     promote_tier3 — only confident, durable facts.",
    "  - escalate:        contradiction with existing memory, safety issue,",
    "                     unclear operator intent. Do NOT silently overwrite.",
    "",
    "RULES (non-negotiable):",
    "  1. Do not promote trivial acknowledgements.",
    "  2. Do not promote every tool result; most tool chatter is transient.",
    "  3. Prefer compact, source-grounded facts. One sentence per memory.",
    "  4. Preserve provenance: every decision MUST cite >=1 source_event_id.",
    "  5. Do not write secrets (API keys, tokens, passwords, private contact",
    "     info, anything that looks like a credential).",
    "  6. Tier 1 proposals require a stricter threshold than Tier 3 writes.",
    "  7. Escalate contradictions; never overwrite curated memory silently.",
    "  8. If a fact is already in the curated context (recent_tier1_facts or",
    "     recent_evy_memories below), DO NOT re-promote it — discard or",
    "     keep_raw instead.",
    "",
    "OUTPUT FORMAT — JSON ONLY. No prose, no markdown fences, no comments.",
    "{",
    "  \"decisions\": [",
    "    {",
    "      \"source_event_ids\": [\"...\"],",
    "      \"action\": \"discard|keep_raw|promote_tier3|propose_tier1|escalate\",",
    "      \"memory\": \"one concise durable sentence, if promoted\",",
    "      \"kind\": \"decision|preference|finding|project-state|operator-note|design-note\",",
    "      \"reason\": \"short rationale\",",
    "      \"confidence\": 0.0",
    "    }",
    "  ]",
    "}",
    "",
    "FIELD RULES:",
    "  - source_event_ids: array of >=1 event-id strings drawn from the",
    "    events you were given.",
    "  - action: exactly one of the five enum values.",
    "  - memory: required when action is promote_tier3 or propose_tier1;",
    "    omit or leave empty otherwise.",
    "  - kind: required when action is promote_tier3 or propose_tier1;",
    "    omit otherwise.",
    "  - reason: short rationale, always present.",
    "  - confidence: float in [0.0, 1.0]. Out-of-range values may be",
    "    clamped or dropped by the downstream parser; stay in range.",
  ].join("\n");
}

/**
 * Build the user-message body. Threads operator context + recent curated
 * memory + the raw event batch into one structured prompt.
 */
export function buildReviewerUserPrompt(
  events: RawEvent[],
  context: ReviewerContext,
): string {
  const lines: string[] = [];
  lines.push(`Operator: ${context.operator_name}`);
  lines.push(`Active project: ${context.active_project ?? "(none)"}`);
  lines.push("");

  const tier1 = context.recent_tier1_facts ?? [];
  lines.push(`Recent Tier 1 facts (already curated — DO NOT re-promote):`);
  if (tier1.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of tier1) lines.push(`  - ${f}`);
  }
  lines.push("");

  const evy = context.recent_evy_memories ?? [];
  lines.push(`Recent Evy memories (already curated — DO NOT re-promote):`);
  if (evy.length === 0) {
    lines.push("  (none)");
  } else {
    for (const m of evy) lines.push(`  - ${m}`);
  }
  lines.push("");

  lines.push(`Raw events to review (count=${events.length}):`);
  lines.push("");
  for (const ev of events) {
    lines.push(`[event id=${ev.id} ts=${ev.ts}]`);
    if (ev.user_text) lines.push(`user: ${truncate(ev.user_text, 1200)}`);
    if (ev.assistant_text)
      lines.push(`assistant: ${truncate(ev.assistant_text, 1200)}`);
    if (ev.tool_calls_json)
      lines.push(`tool_calls: ${truncate(ev.tool_calls_json, 600)}`);
    if (ev.decisions_json)
      lines.push(`decisions: ${truncate(ev.decisions_json, 600)}`);
    if (ev.outcomes_json)
      lines.push(`outcomes: ${truncate(ev.outcomes_json, 600)}`);
    if (ev.metadata_json)
      lines.push(`metadata: ${truncate(ev.metadata_json, 400)}`);
    lines.push("");
  }

  lines.push("Now produce the JSON. Output JSON only.");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// ─── JSON extraction + validation ─────────────────────────────────────────

/**
 * Try to extract a JSON object from a response that may have prose
 * around it. Strategy: try direct parse → fall back to substring from
 * first `{` to last `}` → try again. Keeps the extractor dumb on
 * purpose; balanced-brace parsing with string-state tracking is more
 * code for marginal gain and easy to get wrong.
 *
 * Returns the parsed object on success, null on failure.
 */
function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to greedy extraction */
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = trimmed.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Validate one raw decision against the contract. Returns a typed
 * ReviewDecision on success, or null if any field fails (caller drops).
 *
 * Confidence policy: clamp finite numbers to [0,1]; drop on NaN or
 * non-number (clamping NaN would propagate quietly).
 */
function validateDecision(raw: unknown): ReviewDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  // source_event_ids: array of >=1 non-empty strings
  if (!Array.isArray(r.source_event_ids)) return null;
  const ids = r.source_event_ids.filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  if (ids.length === 0) return null;

  // action: enum membership
  if (typeof r.action !== "string") return null;
  if (!ACTION_SET.has(r.action as ReviewAction)) return null;
  const action = r.action as ReviewAction;

  // reason: non-empty string
  if (typeof r.reason !== "string" || r.reason.trim().length === 0) return null;
  const reason = r.reason.trim();

  // confidence: finite number → clamp to [0,1]; NaN/non-number → drop
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) {
    return null;
  }
  const confidence = Math.min(1, Math.max(0, r.confidence));

  // memory + kind required when promoting
  let memory: string | undefined;
  let kind: ReviewKind | undefined;
  if (PROMOTING_ACTIONS.has(action)) {
    if (typeof r.memory !== "string" || r.memory.trim().length === 0) {
      return null;
    }
    memory = r.memory.trim();
    if (typeof r.kind !== "string" || !KIND_SET.has(r.kind as ReviewKind)) {
      return null;
    }
    kind = r.kind as ReviewKind;
  } else {
    // For non-promoting actions, memory/kind are optional; pass through
    // if present and well-formed, else just omit them.
    if (typeof r.memory === "string" && r.memory.trim().length > 0) {
      memory = r.memory.trim();
    }
    if (typeof r.kind === "string" && KIND_SET.has(r.kind as ReviewKind)) {
      kind = r.kind as ReviewKind;
    }
  }

  const out: ReviewDecision = {
    source_event_ids: ids,
    action,
    reason,
    confidence,
  };
  if (memory !== undefined) out.memory = memory;
  if (kind !== undefined) out.kind = kind;
  return out;
}

/**
 * Parse the LLM's raw text into a validated decisions array. Tolerant
 * of every realistic failure mode — never throws. Returns [] on
 * malformed output, missing `decisions` key, non-array `decisions`,
 * or all-rejected decisions.
 */
function parseAndValidateDecisions(raw: string): ReviewDecision[] {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") {
    console.error("[memory-kernel-reviewer] could not extract JSON from response");
    return [];
  }
  const decisionsField = (obj as Record<string, unknown>).decisions;
  if (!Array.isArray(decisionsField)) {
    console.error("[memory-kernel-reviewer] response missing `decisions` array");
    return [];
  }
  const out: ReviewDecision[] = [];
  let dropped = 0;
  for (const d of decisionsField) {
    const v = validateDecision(d);
    if (v) out.push(v);
    else dropped++;
  }
  if (dropped > 0) {
    console.error(
      `[memory-kernel-reviewer] dropped ${dropped}/${decisionsField.length} malformed decision(s)`,
    );
  }
  return out;
}

// ─── default callSupervisor helper (HTTP only — caller resolves auth) ─────

/**
 * One-shot supervisor call. Pure HTTP — no fs, no oauth refresh, no
 * provider-specific quirks beyond the wire-format selection. The
 * CALLER (Worker C's watchdog) is responsible for:
 *   - resolving the auth token (Codex OAuth, LM Studio bearer, …)
 *   - resolving the baseUrl (providers.json + profiles.json)
 *   - handling 401 → refresh → retry (out of scope here)
 *
 * Dispatch by wire format:
 *   - openai-codex → OpenAI /v1/responses
 *   - anything else → OpenAI Chat Completions (/v1/chat/completions)
 *     — works for openai, openrouter, lmstudio, ollama, mlx, vllm.
 *   - anthropic is intentionally NOT supported here; if the operator
 *     wires the reviewer at an Anthropic model, the watchdog must
 *     inject a custom llmFetcher. (We keep this helper small.)
 *
 * Throws on HTTP failure with a sanitized message; callers convert to
 * an empty-decisions return at the reviewEvents() boundary.
 */
export async function callSupervisor(
  messages: LlmMessage[],
  opts: LlmFetcherOpts,
): Promise<string> {
  const baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("callSupervisor: baseUrl is required");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;

  if (opts.provider === "openai-codex") {
    // /v1/responses uses an "input" array with type=message blocks.
    const input = messages.map((m) => ({
      role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
    }));
    const r = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        input,
        max_output_tokens: opts.max_tokens ?? 4096,
        temperature: opts.temperature ?? 0.1,
      }),
      signal: opts.signal,
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`callSupervisor (codex /v1/responses) ${r.status}: ${body.slice(0, 400)}`);
    }
    const j = (await r.json()) as unknown;
    return extractTextFromResponsesJson(j);
  }

  // Default path: OpenAI Chat Completions wire format.
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages,
      max_tokens: opts.max_tokens ?? 4096,
      temperature: opts.temperature ?? 0.1,
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(
      `callSupervisor (chat/completions) ${r.status}: ${body.slice(0, 400)}`,
    );
  }
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return j.choices?.[0]?.message?.content ?? "";
}

/**
 * Pull the assistant text out of OpenAI /v1/responses JSON. Shape:
 *   { output: [{ type: "message", content: [{ type: "output_text", text: "..." }] }] }
 * Tolerant of variations — returns "" if nothing useful found.
 */
function extractTextFromResponsesJson(j: unknown): string {
  if (!j || typeof j !== "object") return "";
  const obj = j as Record<string, unknown>;
  // Some responses include a top-level "output_text" convenience field.
  if (typeof obj.output_text === "string") return obj.output_text;
  const output = obj.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const t = (c as Record<string, unknown>).text;
      if (typeof t === "string") chunks.push(t);
    }
  }
  return chunks.join("");
}

// ─── default deps ─────────────────────────────────────────────────────────

function defaultLlmFetcher(): Promise<string> {
  return Promise.reject(
    new Error(
      "memory-kernel-reviewer: no llmFetcher injected — caller must supply one via deps (see callSupervisor for a default implementation)",
    ),
  );
}

function defaultConfiguredSupervisor(): { provider: string; model: string } {
  return { provider: "unknown", model: "unknown" };
}

// ─── public entry point ───────────────────────────────────────────────────

/**
 * Run one reviewer cycle over the given events.
 *
 * Behavior:
 *   - Empty events → no LLM call, returns {decisions: []} with populated
 *     reviewer_model + cycle_ms (saves credits + cycle time).
 *   - Otherwise: build system + user prompt, call llmFetcher, parse and
 *     validate the response.
 *   - On any LLM error or parse failure: returns {decisions: []} with
 *     console.error breadcrumb. NEVER throws.
 *
 * The function is pure modulo the injected deps; in particular, it does
 * NOT touch the filesystem, mutate globals, or perform any side effects
 * beyond the llmFetcher call and console.error logging.
 */
export async function reviewEvents(
  events: RawEvent[],
  context: ReviewerContext,
  deps?: Partial<ReviewerDeps>,
): Promise<ReviewerOutput> {
  const now = deps?.now ?? Date.now;
  const configuredSupervisor =
    deps?.configuredSupervisor ?? defaultConfiguredSupervisor;
  const llmFetcher = deps?.llmFetcher ?? defaultLlmFetcher;

  const start = now();
  const supervisor = configuredSupervisor();
  const reviewer_model = `${supervisor.provider}/${supervisor.model}`;

  // Empty-events fast path — no LLM call. cycle_ms still populated so
  // diagnostics can distinguish a zero-event cycle from a stuck one.
  if (events.length === 0) {
    return {
      decisions: [],
      reviewer_model,
      cycle_ms: Math.max(0, now() - start),
    };
  }

  const systemPrompt = buildReviewerSystemPrompt();
  const userPrompt = buildReviewerUserPrompt(events, context);

  let raw: string;
  try {
    raw = await llmFetcher(
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
    console.error(
      `[memory-kernel-reviewer] llmFetcher failed: ${(err as Error).message}`,
    );
    return {
      decisions: [],
      reviewer_model,
      cycle_ms: Math.max(0, now() - start),
    };
  }

  const decisions = parseAndValidateDecisions(raw);

  return {
    decisions,
    reviewer_model,
    cycle_ms: Math.max(0, now() - start),
  };
}
