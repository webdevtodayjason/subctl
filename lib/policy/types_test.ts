// Type-only tests for the policy contract.
//
// There is no runtime to exercise here — types.ts exports interfaces and a
// string literal union. The "tests" are sample-shape construction (which
// must compile) and `@ts-expect-error` negative assertions (which must NOT
// compile). If you delete or relax a constraint in types.ts and a negative
// test starts compiling, this file will fail tsc with an unused-directive
// error — exactly what we want.
//
// Run with:
//   bunx tsc --noEmit --strict --target esnext --moduleResolution bundler \
//     lib/policy/types_test.ts
//
// Or as part of `bun build` if you prefer bundler-level checking.

import type {
  AllowPattern,
  AuditEntry,
  CheckRequest,
  CheckResult,
  GatedMode,
  Mode,
  PolicyDocument,
  SealedMode,
  TrustedMode,
} from "./index";

// ---------------------------------------------------------------------------
// 1. Positive samples — these must compile cleanly.
// ---------------------------------------------------------------------------

// 1.1 — Trivial trusted-mode document (no merge meta, no gated config).
export const sampleTrusted: PolicyDocument = {
  default_mode: "trusted",
  mode: {
    trusted: {},
  },
};

// 1.2 — A typical gated document with the full ecosystem table set.
// Faithful to docs/policy.md §8 (the npm-test problem) and §6 worked example.
export const sampleGated: PolicyDocument = {
  preset: "node",
  default_mode: "gated",
  mode: {
    gated: {
      allow: {
        commands: ["pwd", "ls", "cat", "echo", "true", "false"],
      },
      allow_pattern: [
        {
          command: "git",
          args: ["status", "diff", "log", "show", "add", "commit"],
        },
        {
          command: "npm",
          args: ["test", "run"],
        },
        {
          command: "npm",
          args: ["install"],
          deny_if_arg_contains: ["--ignore-scripts=false"],
        },
        // §6 worked example: project-added pattern on top of the node preset.
        {
          command: "gh",
          args: ["pr", "issue"],
        },
      ],
      deny_always: {
        substrings: ["rm -rf", "rm -fr", ":(){:|:&};:", "dd if=", "mkfs"],
        regex: [
          "\\bcurl\\b.*\\|\\s*(sh|bash|zsh)\\b",
          "\\bpython3?\\s+-c\\b",
          "\\bnode\\s+-e\\b",
        ],
      },
      npm: { allowed_scripts: ["test", "lint", "build", "typecheck"] },
      pnpm: { allowed_scripts: ["test", "lint", "build"] },
      bun: { allowed_scripts: ["test", "lint", "build"] },
      yarn: { allowed_scripts: ["test", "lint", "build"] },
      make: { allowed_targets: ["test", "build", "fmt", "lint", "clean"] },
      just: { allowed_recipes: ["test", "build", "lint"] },
      python_modules: { allowed: ["pytest", "unittest", "build", "pip"] },
      uv: { allowed_run_targets: ["pytest", "ruff", "mypy"] },
      poetry: { allowed_run_targets: ["pytest", "ruff"] },
    },
  },
};

// 1.3 — A sealed-mode document with the full v1 MCP tool set + escalation.
// Faithful to docs/policy.md §5 and docs/policy-schema.md §4.
export const sampleSealed: PolicyDocument = {
  preset: "node",
  default_mode: "sealed",
  mode: {
    sealed: {
      mcp_tools: [
        "fs_read",
        "fs_write",
        "fs_list",
        "fs_search",
        "git_status",
        "git_diff",
        "git_add",
        "git_commit",
        "git_log",
        "test_run",
        "pkg_list",
        "policy_request",
      ],
      test_command: "npm test",
      escalation: {
        target: "master",
        require_approval: true,
        timeout_seconds: 300,
      },
    },
  },
};

// 1.4 — A resolved policy as it appears AFTER the merge pass, with __meta.
export const sampleResolved: PolicyDocument = {
  ...sampleGated,
  __meta: {
    sourcePaths: [
      "/Users/jason/code/foothold/.subctl/policy.toml",
      "/Users/jason/.config/subctl/policy.toml",
      "/opt/subctl/config/policy/defaults.toml",
    ],
    allowlistSha: "a3f9c2e1",
    resolvedAt: "2026-05-11T18:42:13.901Z",
  },
};

// 1.5 — Construct a check request + result pair.
export const sampleCheckRequest: CheckRequest = {
  command: "git status",
  cwd: "/Users/jason/code/foothold",
  team_id: "foothold-v3",
  agent_session_id: "sess_xyz",
};

export const sampleCheckResult: CheckResult = {
  decision: "allow",
  rule: "allow_pattern: git status|diff|log|...",
  rule_path: "mode.gated.allow_pattern[0]",
};

// 1.6 — A default-deny result (no rule/rule_path set).
export const sampleDefaultDeny: CheckResult = {
  decision: "deny",
};

// 1.7 — All three audit event_type variants.
export const sampleAuditHeader: AuditEntry = {
  ts: "2026-05-11T18:42:00.000Z",
  team_id: "foothold-v3",
  mode: "gated",
  allowlist_sha: "a3f9c2e1",
  command: "",
  decision: "allow",
  rule: "spawn",
  event_type: "header",
};

export const sampleAuditCheck: AuditEntry = {
  ts: "2026-05-11T18:42:13.901Z",
  team_id: "foothold-v3",
  agent_session_id: "sess_xyz",
  mode: "gated",
  allowlist_sha: "a3f9c2e1",
  command: "git status",
  decision: "allow",
  rule: "allow_pattern: git status|diff|log|...",
  rule_path: "mode.gated.allow_pattern[4]",
  event_type: "check",
};

export const sampleAuditVerifierCorrection: AuditEntry = {
  ts: "2026-05-11T18:44:00.000Z",
  team_id: "foothold-v3",
  mode: "gated",
  allowlist_sha: "a3f9c2e1",
  command: "",
  decision: "deny",
  rule: "verifier: 5 denials in 60s, pattern 'mode.gated.deny_always.regex'",
  event_type: "verifier_correction",
};

// 1.8 — Smoke check that the named exports are usable as types.
export const sampleMode: Mode = "gated";
export const sampleTrustedMode: TrustedMode = {};
export const sampleAllowPattern: AllowPattern = {
  command: "git",
  args: ["status"],
};
export const sampleGatedMode: GatedMode = { allow: { commands: ["pwd"] } };
export const sampleSealedMode: SealedMode = { mcp_tools: ["fs_read"] };

// ---------------------------------------------------------------------------
// 2. Negative tests — these must NOT compile. `@ts-expect-error` asserts
//    that the next line has a type error. If types.ts is relaxed and the
//    error goes away, tsc will fail with TS2578 (unused expect-error).
// ---------------------------------------------------------------------------

// 2.1 — Mode is a closed string-literal union; arbitrary strings must fail.
// @ts-expect-error: "yolo" is not a valid Mode.
export const badMode: Mode = "yolo";

// 2.2 — npm.allowed_scripts is `string[]`, not `string`. From pack §3.5 +
// the docs/policy-schema.md §6 merge worked example.
export const badNpmShape: GatedMode = {
  // @ts-expect-error: allowed_scripts must be string[], not string.
  npm: { allowed_scripts: "test" },
};

// 2.3 — AllowPattern.command is required.
// @ts-expect-error: missing required `command` field.
export const badAllowPattern: AllowPattern = { args: ["status"] };

// 2.4 — SealedMode.mcp_tools is required.
// @ts-expect-error: missing required `mcp_tools` field.
export const badSealed: SealedMode = { test_command: "npm test" };

// 2.5 — CheckResult.decision is a closed union.
export const badDecision: CheckResult = {
  // @ts-expect-error: "maybe" is not a valid decision.
  decision: "maybe",
};

// 2.6 — AuditEntry.event_type is a closed union.
export const badEventType: AuditEntry = {
  ts: "2026-05-11T18:42:13.901Z",
  team_id: "foothold-v3",
  mode: "gated",
  command: "git status",
  decision: "allow",
  // @ts-expect-error: "sealed_tool_call" is not a v2.7.0 event_type (deferred).
  event_type: "sealed_tool_call",
};

// 2.7 — PolicyDocument.mode is required (it's the only required field).
// @ts-expect-error: missing required `mode` field on PolicyDocument.
export const badDoc: PolicyDocument = { default_mode: "gated" };

// 2.8 — escalation.target is a closed union.
export const badEscalation: SealedMode = {
  mcp_tools: ["fs_read"],
  escalation: {
    // @ts-expect-error: "slack" is not a valid escalation target.
    target: "slack",
    require_approval: true,
    timeout_seconds: 300,
  },
};
