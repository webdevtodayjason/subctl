// components/master/tools/policy/tools/policy_list.ts
//
// `policy_list` — return the fully resolved policy for a project, with merge
// source attribution. Pack 06 §6.2: "Output is structured (object), not text —
// the master formats it for chat as needed."
//
// Shape follows the codebase tool convention `{description, schema, invoke}`.
// server.ts namespaces this as `policy_list` via the family prefix.

import { loadResolvedPolicy } from "../load";

export const policy_list = {
  description:
    "Return the fully resolved policy for a project (preset + user + defaults + project, merged). Use when the operator asks 'what mode is foothold-v3 in?' or 'what's allowed in the holace project?'. Returns structured data: default_mode, preset name, source_paths (the chain of files that contributed), allowlist_sha (stable hash for audit), and the merged mode tables (gated / sealed). Trusted mode is intentionally empty — it has no config.",
  schema: {
    type: "object",
    properties: {
      project_root: {
        type: "string",
        description: "Absolute path to the project root. Resolution walks .subctl/policy*.toml here + user config + preset + shipped defaults.",
      },
    },
    required: ["project_root"],
  },
  invoke: async (args: { project_root: string }) => {
    const { project_root } = args;
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
    return {
      ok: true,
      project_root,
      preset: policy.preset,
      default_mode: policy.default_mode ?? "gated",
      source_paths: policy.__meta?.sourcePaths ?? [],
      allowlist_sha: policy.__meta?.allowlistSha ?? "",
      resolved_at: policy.__meta?.resolvedAt,
      mode: {
        // trusted is intentionally omitted — it has no config to surface
        gated: policy.mode?.gated,
        sealed: policy.mode?.sealed,
      },
    };
  },
};
