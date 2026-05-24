// Re-export shim for the master daemon's `policy` tool family.
//
// The single source of truth for these types is `lib/policy/types.ts` (PR 2).
// Local consumers under `components/evy/tools/policy/` import from here so
// the path looks local; the actual definitions live one place only.
//
// Per `.orchestration/handoff-pack/06-tool-family-policy.md` §2 + §3.

export type {
  Mode,
  PolicyDocument,
  TrustedMode,
  GatedMode,
  AllowPattern,
  SealedMode,
  CheckRequest,
  CheckResult,
  AuditEntry,
} from "../../../../lib/policy/types";
