// components/master/tools/policy/tools/policy_check.ts
//
// `policy_check` — master-callable introspection tool. Wraps the PR 4 loader
// and the PR 5 hot-path check so the master can answer "would this command be
// allowed?" from chat without spawning a worker. Pack 06 §6.1.
//
// Shape matches the existing tool-family convention used across
// components/master/tools/*.ts: `{ description, schema, invoke }`. The pack's
// `{ name, parameters, handler }` design intent is reshaped into the codebase's
// actual contract. server.ts namespaces this as `policy_check` via the
// family prefix.

import { loadResolvedPolicy } from "../load";
import { checkCommand } from "../check";
import type { Mode } from "../types";

export const policy_check = {
  description:
    "Check whether a proposed shell command would be allowed under the active policy for a given project. Wraps the same load+check pipeline the PreToolUse hook uses, so the verdict is identical to what a Gated worker would see. Use to answer 'would `npm run lint` be allowed for foothold-v3?' or to dry-run a denial before suggesting a command to the operator. Pass an explicit `mode` to override the project's default for what-if analysis (e.g. mode='trusted' always returns allow).",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command line to check (raw, untokenized; matches what the hook would see).",
      },
      project_root: {
        type: "string",
        description: "Absolute path to the project root. The .subctl/policy.toml + .subctl/policy.local.toml here merge into the resolved policy.",
      },
      mode: {
        type: "string",
        enum: ["trusted", "gated", "sealed"],
        description: "Optional mode override. Defaults to the project's resolved default_mode. trusted=blanket allow, gated=run the rule engine, sealed=blanket deny.",
      },
    },
    required: ["command", "project_root"],
  },
  invoke: async (args: { command: string; project_root: string; mode?: Mode }) => {
    const { command, project_root, mode } = args;
    if (!command || typeof command !== "string") {
      return { ok: false, error: "command is required and must be a string" };
    }
    if (!project_root || typeof project_root !== "string") {
      return { ok: false, error: "project_root is required and must be a string" };
    }
    let policy;
    try {
      policy = await loadResolvedPolicy(project_root);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `policy load failed: ${msg}` };
    }
    if (mode) policy.default_mode = mode;
    const result = checkCommand(policy, {
      command,
      cwd: project_root,
      team_id: "__master_introspection__",
    });
    return {
      ok: true,
      decision: result.decision,
      rule: result.rule,
      rule_path: result.rule_path,
      mode: policy.default_mode ?? "gated",
      allowlist_sha: policy.__meta?.allowlistSha,
    };
  },
};
