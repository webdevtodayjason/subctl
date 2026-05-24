// components/evy/mcp/identity.ts
//
// MCP-Expose (#24, wave 1) — caller_id → DecisionProvenance adapter.
//
// Every action initiated through the MCP server (when the wave-2 tool
// surface lands) writes a row to `.subctl/docs/decisions.jsonl`. The
// `by` field threads the caller_id through with an `mcp:` prefix so the
// historian can tell, after the fact, that a decision arrived over MCP
// rather than via Telegram, dashboard, or the operator's REPL.
//
// Examples:
//
//   formatDecisionBy("claude-desktop")
//     → "mcp:claude-desktop"
//
//   formatDecisionBy("orch-claude-code-abc123")
//     → "mcp:orch-claude-code-abc123"
//
// The PREFIX is the contract — every downstream consumer searches for
// `mcp:*` to pull out MCP-originated actions. Do NOT rename without
// updating decisions.jsonl consumers (historians, dashboard filters).

/** Stable prefix marking decisions that arrived via MCP. */
export const MCP_DECISION_PREFIX = "mcp:" as const;

/**
 * Shape recorded in decisions.jsonl `by` field plus the contextual
 * metadata the eventual tool-surface adapter will attach. Held here so
 * the wave-2 worker imports a single source of truth.
 */
export interface McpProvenance {
  /** Always exactly "mcp" — discriminator for unions over `by` source. */
  source: "mcp";
  /** Verbatim X-Caller-Id from the request. */
  caller_id: string;
  /** `mcp:<caller_id>` — the actual string written to decisions.jsonl. */
  by: string;
  /** ISO-8601 timestamp of the originating MCP request. */
  received_at: string;
}

/**
 * Format a validated caller_id for the decisions.jsonl `by` field.
 * Caller is expected to have already passed the value through
 * `validateCallerId` in `./auth.ts` — this helper does not re-validate
 * (re-validation here would silently swallow programming errors
 * elsewhere). If the empty string slips through we return the bare
 * prefix; the wave-2 tool-surface code should never reach that branch.
 */
export function formatDecisionBy(callerId: string): string {
  return `${MCP_DECISION_PREFIX}${callerId}`;
}

/**
 * Parse a decisions.jsonl `by` value back into its caller_id, when the
 * value originated from MCP. Returns null for non-MCP rows so callers
 * can fall through to other sources.
 */
export function parseDecisionBy(
  by: string,
): { source: "mcp"; caller_id: string } | null {
  if (!by.startsWith(MCP_DECISION_PREFIX)) return null;
  const caller = by.slice(MCP_DECISION_PREFIX.length);
  if (caller.length === 0) return null;
  return { source: "mcp", caller_id: caller };
}

/**
 * Build the full provenance record. The wave-2 tool-surface worker
 * will spread this into the decision row alongside `project`, `action`,
 * and `rationale`. `now` is injectable for deterministic tests.
 */
export function buildMcpProvenance(
  callerId: string,
  now: Date = new Date(),
): McpProvenance {
  return {
    source: "mcp",
    caller_id: callerId,
    by: formatDecisionBy(callerId),
    received_at: now.toISOString(),
  };
}
