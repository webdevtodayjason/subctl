// providers/claude/__tests__/integration/detection.test.ts
//
// Exercises providers/claude/policy.sh's ecosystem-detection helper
// (`_subctl_claude_detect_ecosystem`) against fixture project directories.
// Covers pack 08 §3 marker rules:
//   - node markers   → "node"
//   - python markers → "python"
//   - none           → "generic"
//   - both           → "generic" + a warning emitted on stderr
//
// We invoke the helper by sourcing policy.sh in a bash subshell rather than
// re-implementing the detection in TS — the bash function IS the canonical
// implementation for the v2.7.0 provider, and a test that re-implements it
// would just verify the test's own mirror.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const POLICY_SH = join(REPO_ROOT, "providers", "claude", "policy.sh");

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function detect(projectRoot: string): Promise<BashResult> {
  // Source policy.sh + invoke the detect helper. We pipe through stdout so
  // the function's printf is what we capture; warnings go to stderr via
  // subctl_warn.
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `. "${POLICY_SH}"; _subctl_claude_detect_ecosystem "${projectRoot}"`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout: stdout.trim(), stderr };
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "subctl-detect-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("_subctl_claude_detect_ecosystem", () => {
  test("empty project returns generic", async () => {
    const r = await detect(scratch);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("generic");
  });

  test("package.json → node", async () => {
    writeFileSync(join(scratch, "package.json"), "{}");
    const r = await detect(scratch);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("node");
  });

  test("bun.lockb → node", async () => {
    writeFileSync(join(scratch, "bun.lockb"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("node");
  });

  test("pnpm-lock.yaml → node", async () => {
    writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("node");
  });

  test("yarn.lock → node", async () => {
    writeFileSync(join(scratch, "yarn.lock"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("node");
  });

  test("pyproject.toml → python", async () => {
    writeFileSync(join(scratch, "pyproject.toml"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("python");
  });

  test("requirements.txt → python", async () => {
    writeFileSync(join(scratch, "requirements.txt"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("python");
  });

  test("uv.lock → python", async () => {
    writeFileSync(join(scratch, "uv.lock"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("python");
  });

  test("poetry.lock → python", async () => {
    writeFileSync(join(scratch, "poetry.lock"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("python");
  });

  test("Pipfile → python", async () => {
    writeFileSync(join(scratch, "Pipfile"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("python");
  });

  test("multiple ecosystems → generic + warning on stderr", async () => {
    writeFileSync(join(scratch, "package.json"), "{}");
    writeFileSync(join(scratch, "pyproject.toml"), "");
    const r = await detect(scratch);
    expect(r.stdout).toBe("generic");
    expect(r.stderr).toContain("multiple ecosystems detected");
    expect(r.stderr).toContain("node");
    expect(r.stderr).toContain("python");
  });

  test("non-existent dir returns generic (no crash)", async () => {
    const r = await detect(join(scratch, "does-not-exist"));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("generic");
  });
});
