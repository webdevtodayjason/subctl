// dashboard/__tests__/spawn-errors.test.ts
//
// Regression coverage for the 2026-05-18 template-spawn 500 incident.
//
// `subctl_orch_spawn_template` was returning opaque HTTP 500 even for
// trivially user-facing failures (template not found, account not
// configured), which made the supervisor abandon the template path on
// first failure. The dashboard now classifies known stderr/stdout
// patterns from `subctl teams claude` into 4xx kinds; only genuine
// infra failures stay 500. These tests pin the patterns so future
// edits to providers/claude/teams.sh that drop the recognized phrases
// fail loudly.

import { describe, expect, test } from "bun:test";

import { classifySpawnError } from "../lib/spawn-errors";

describe("classifySpawnError", () => {
  test("template not found → 404 template_not_found", () => {
    const c = classifySpawnError({
      stderr: " ✗ team template not found: /Users/sem/.config/subctl/master/team-templates/code-review.json\n",
      stdout: "",
    });
    expect(c.status).toBe(404);
    expect(c.kind).toBe("template_not_found");
    expect(c.error).toContain("team template not found");
  });

  test("unknown account (from accounts.conf gate) → 404 unknown_account", () => {
    const c = classifySpawnError({
      stderr: "✗ unknown account: claude-nobody (not in accounts.conf)\n",
    });
    expect(c.status).toBe(404);
    expect(c.kind).toBe("unknown_account");
  });

  test("missing config directory → 412 account_unconfigured", () => {
    const c = classifySpawnError({
      stderr: "✗ claude-jason has no config directory: /tmp/missing (run: subctl auth claude claude-jason)\n",
    });
    expect(c.status).toBe(412);
    expect(c.kind).toBe("account_unconfigured");
  });

  test("missing --prompt-file → 404 missing_prompt_file", () => {
    const c = classifySpawnError({
      stderr: "✗ prompt file not found: /tmp/nope.md\n",
    });
    expect(c.status).toBe(404);
    expect(c.kind).toBe("missing_prompt_file");
  });

  test("policy snapshot failure → 500 policy_failure", () => {
    const c = classifySpawnError({
      stderr: "policy: failed to write snapshot for team claude-foo\n",
    });
    expect(c.status).toBe(500);
    expect(c.kind).toBe("policy_failure");
  });

  test("unrecognized stderr → 500 spawn_failed with body preserved", () => {
    const c = classifySpawnError({
      stderr: "tmux: command not found\n",
    });
    expect(c.status).toBe(500);
    expect(c.kind).toBe("spawn_failed");
    expect(c.error).toContain("tmux");
  });

  test("timeout shortcircuits → 504 spawn_timeout", () => {
    const c = classifySpawnError({
      stderr: "team template not found",
      timedOut: true,
    });
    expect(c.status).toBe(504);
    expect(c.kind).toBe("spawn_timeout");
  });

  test("totally empty output → 500 spawn_failed with fallback string", () => {
    const c = classifySpawnError({ stderr: "", stdout: "" });
    expect(c.status).toBe(500);
    expect(c.kind).toBe("spawn_failed");
    expect(c.error).toBe("spawn failed");
  });

  test("very long stderr is truncated to 800 chars", () => {
    const big = "x".repeat(2000);
    const c = classifySpawnError({ stderr: big });
    expect(c.error.length).toBeLessThanOrEqual(800);
  });

  test("pattern matching is case-insensitive", () => {
    const c = classifySpawnError({
      stderr: "TEAM TEMPLATE NOT FOUND: foo.json",
    });
    expect(c.kind).toBe("template_not_found");
  });
});
