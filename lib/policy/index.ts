// Public import surface for the subctl policy engine type contracts.
//
// Consumers (the master tool family, the CLI subcommands, the Go vector
// tests, provider adapters, dashboard) should import from `lib/policy`,
// not directly from `./types`. This keeps the file layout under
// `lib/policy/` an implementation detail.

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
} from "./types";
