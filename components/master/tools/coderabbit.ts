// CodeRabbit CLI integration. The --agent mode emits structured findings
// suitable for programmatic consumption by clawd.
//
// The master uses this in two ways:
//   1. Pre-PR review (worker invokes via MCP, before pushing) — ensures the
//      diff would survive CodeRabbit's PR review BEFORE the PR is opened.
//   2. Post-PR synthesis (master polls for CodeRabbit's PR comments via gh
//      pr view --comments, since CodeRabbit posts directly to the PR).
//
// This module is the local-CLI side. PR-side comment ingestion lives in gh.ts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CODERABBIT_BIN =
  process.env.CODERABBIT_BIN ??
  `${process.env.HOME}/.local/bin/coderabbit`;

function coderabbit(
  args: string[],
  opts: { cwd?: string; timeout_ms?: number } = {},
): { stdout: string; stderr: string; exit_code: number } {
  const r = spawnSync(CODERABBIT_BIN, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    timeout: opts.timeout_ms ?? 180_000, // 3 min default — reviews can be slow
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exit_code: r.status ?? -1,
  };
}

export const coderabbitTools = {
  review_local: {
    description:
      "Run CodeRabbit's --agent review on local changes in a project. Returns structured findings (severity, file, line, summary, suggested fix). Use BEFORE opening a PR to verify the diff is clean. Compare type='committed' (matches what CI sees) against type='all' (includes WIP).",
    schema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Absolute path to the project directory (cwd for review).",
        },
        type: {
          type: "string",
          enum: ["all", "committed", "uncommitted"],
          default: "committed",
          description:
            "Scope of changes to review. 'committed' matches what would land in a PR.",
        },
        base: {
          type: "string",
          description:
            "Base branch for comparison (e.g. 'main'). Reviews diff between current branch and base.",
        },
        config: {
          type: "string",
          description:
            "Optional path to a coderabbit.yaml or claude.md with project-specific instructions.",
        },
      },
      required: ["project"],
    },
    invoke: async (args: {
      project: string;
      type?: string;
      base?: string;
      config?: string;
    }) => {
      if (!existsSync(CODERABBIT_BIN)) {
        return {
          error: `CodeRabbit CLI not found at ${CODERABBIT_BIN}`,
          hint: "Install: curl -fsSL https://www.coderabbit.ai/install | sh",
        };
      }
      const argv = ["review", "--agent", "--no-color"];
      argv.push("--type", args.type ?? "committed");
      if (args.base) argv.push("--base", args.base);
      if (args.config) argv.push("--config", args.config);
      const r = coderabbit(argv, { cwd: args.project });
      // Try to parse JSON output (--agent emits JSON lines or a JSON object)
      try {
        const trimmed = r.stdout.trim();
        // Some versions emit JSONL, others a single JSON. Try both.
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          return { findings: JSON.parse(trimmed), exit_code: r.exit_code };
        }
        // JSONL: parse each non-empty line
        const lines = trimmed.split("\n").filter((l) => l.trim());
        const parsed = lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { _raw: l };
          }
        });
        return { findings: parsed, exit_code: r.exit_code };
      } catch (e) {
        return {
          findings: null,
          raw_stdout: r.stdout.slice(0, 4000),
          stderr: r.stderr.slice(0, 1000),
          exit_code: r.exit_code,
          parse_error: String(e),
        };
      }
    },
  },

  /**
   * Estimate review scope without running it. Useful for cost-aware
   * decisions ("is this big enough that I should run a real review?").
   */
  preview_prompts: {
    description:
      "Preview what CodeRabbit would review without actually running the review. Returns the AI prompts CodeRabbit would generate. Useful for estimating scope and cost before running review_local.",
    schema: {
      type: "object",
      properties: {
        project: { type: "string" },
        type: { type: "string", enum: ["all", "committed", "uncommitted"], default: "committed" },
      },
      required: ["project"],
    },
    invoke: async (args: { project: string; type?: string }) => {
      const argv = [
        "review",
        "--prompt-only",
        "--type",
        args.type ?? "committed",
      ];
      const r = coderabbit(argv, { cwd: args.project, timeout_ms: 30_000 });
      return {
        raw: r.stdout.slice(0, 8000),
        exit_code: r.exit_code,
      };
    },
  },

  stats: {
    description: "Show CodeRabbit review statistics (history, usage).",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const r = coderabbit(["stats"], { timeout_ms: 15_000 });
      return { raw: r.stdout.slice(0, 4000), exit_code: r.exit_code };
    },
  },
};
