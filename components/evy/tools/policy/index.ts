// components/evy/tools/policy/index.ts
//
// Aggregator for the `policy` master tool family. Pack 06 §5 specifies the
// design intent (`policyToolFamily = {name, tools, description}`); the actual
// codebase convention used by every other family (`systemTools`, `projectTools`,
// `schedulerTools`, etc.) is a flat `Record<string, {description, schema, invoke}>`
// merged into `toolRegistry` in server.ts with a family-name prefix. We follow
// the codebase convention — that's the contract server.ts actually consumes.
//
// Registered tools (after server.ts adds the `policy_` prefix):
//   - policy_check       — would-this-command-be-allowed inspection
//   - policy_list        — return the fully resolved policy for a project
//   - policy_audit_tail  — read recent audit JSONL entries for a team

import { policy_check } from "./tools/policy_check";
import { policy_list } from "./tools/policy_list";
import { policy_audit_tail } from "./tools/policy_audit_tail";

export const policyTools = {
  check: policy_check,
  list: policy_list,
  audit_tail: policy_audit_tail,
};
