// components/evy/tools/policy/tools/policy_audit_tail.ts
//
// `policy_audit_tail` — read recent entries from a team's policy audit JSONL.
// Pack 06 §6.3 + pack 09 §2/§3. Returns most-recent-first, optionally filtered
// by decision type.
//
// Path resolution:
//   - SUBCTL_STATE_DIR env var if set (test override + future XDG_STATE_HOME
//     migration), otherwise ~/.local/state/subctl.
//   - The audit file is `<state>/audit/<team_id>.jsonl`.
//
// PR 7 owns the writer (concurrent-safe append + 50MB rotation). For this PR
// we just READ. Missing file → empty array, NOT throw. Malformed lines are
// skipped silently (the writer is the source of truth; if a line is bad, it
// belongs to a half-written final entry from a crash and we don't want a
// single torn line to break tail-reads).
//
// Shape follows the codebase tool convention `{description, schema, invoke}`.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../types";

function resolveAuditDir(): string {
  const override = process.env.SUBCTL_STATE_DIR;
  const base = override ?? join(homedir(), ".local", "state", "subctl");
  return join(base, "audit");
}

function resolveAuditPath(team_id: string): string {
  return join(resolveAuditDir(), `${team_id}.jsonl`);
}

export const policy_audit_tail = {
  description:
    "Read the last N policy-audit entries for a team. Each entry is one event: a header (spawn), a check (allow|deny decision on a command), or a verifier_correction (denial-cluster intervention). Use when the operator asks 'show me what foothold-v3 just tried' or 'how many denials in the last hour?'. Returns most-recent-first. Filter by decision type with `decisions: ['deny']` to focus on what got blocked. Missing audit file → empty array (team has no activity yet, not an error).",
  schema: {
    type: "object",
    properties: {
      team_id: {
        type: "string",
        description: "Team id (matches the filename without .jsonl). E.g. 'foothold-v3'.",
      },
      n: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Number of most-recent entries to return. Defaults to 20. Max 500.",
      },
      decisions: {
        type: "array",
        items: { type: "string", enum: ["allow", "deny"] },
        description: "Filter to specific decision types. Default: both. E.g. ['deny'] to see only blocked commands.",
      },
    },
    required: ["team_id"],
  },
  invoke: async (args: { team_id: string; n?: number; decisions?: Array<"allow" | "deny"> }) => {
    const { team_id } = args;
    if (!team_id || typeof team_id !== "string") {
      return { ok: false, error: "team_id is required and must be a string" };
    }
    const n = typeof args.n === "number" ? Math.max(1, Math.min(500, Math.floor(args.n))) : 20;
    const decisions = Array.isArray(args.decisions) && args.decisions.length > 0
      ? new Set(args.decisions)
      : null;

    const path = resolveAuditPath(team_id);
    if (!existsSync(path)) {
      return { ok: true, team_id, path, entries: [], count: 0 };
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `audit read failed: ${msg}` };
    }

    const lines = raw.split("\n");
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as AuditEntry;
        if (decisions && !decisions.has(obj.decision)) continue;
        entries.push(obj);
      } catch {
        // Skip malformed line — likely a torn write from a crashed worker.
        // PR 7's writer uses O_APPEND atomic writes <PIPE_BUF so this should
        // be vanishingly rare; we ignore rather than fail the whole tail.
      }
    }

    // most-recent-first, capped at n
    const tail = entries.slice(-n).reverse();
    return {
      ok: true,
      team_id,
      path,
      count: tail.length,
      entries: tail,
    };
  },
};
