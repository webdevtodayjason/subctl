// components/evy/policy/index.ts
//
// Public surface of the master daemon's `policy` module. Distinct from
// `components/evy/tools/policy/` (which is the master-tool-family
// namespace exposing `policy_check`, `policy_list`, `policy_audit_tail` to
// the LLM). This module ships the in-process helpers the daemon + dashboard
// + any other TS surface inside subctl uses directly.
//
// Current contents (v2.7.0 / PR 8.5):
//   - exec.ts        — central exec helper (`execCommand` + `execCommandGated`)
//
// Future PRs may add: hook injection writers (PR 10), snapshot writers
// (already at tools/policy/snapshot.ts; may grow a duplicate here if the
// dashboard needs to write snapshots without going through master tool
// invocation).

export {
  execCommand,
  execCommandGated,
  PolicyDenied,
} from "./exec";
export type { ExecOptions, ExecResult } from "./exec";
