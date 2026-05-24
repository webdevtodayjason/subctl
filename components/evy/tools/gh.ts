// GitHub queries via the gh CLI. Read-only by default.
// Mutating actions (gh pr create, gh pr comment) are gated separately —
// the master must consult policy.json before invoking them.

import { spawnSync } from "node:child_process";

function gh(args: string[], opts: { json?: boolean; cwd?: string } = {}): {
  stdout: string;
  stderr: string;
  exit_code: number;
  parsed?: unknown;
} {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: 30_000,
    cwd: opts.cwd,
  });
  const out = {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exit_code: r.status ?? -1,
  };
  if (opts.json && r.status === 0) {
    try {
      return { ...out, parsed: JSON.parse(out.stdout) };
    } catch {
      // fall through; parsed stays undefined
    }
  }
  return out;
}

export const ghTools = {
  pr_list: {
    description:
      "List PRs for a repo. By default returns open PRs. Use to inspect what's in flight.",
    schema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name format" },
        state: {
          type: "string",
          enum: ["open", "closed", "merged", "all"],
          default: "open",
        },
        head: { type: "string", description: "filter by head branch" },
        base: { type: "string", description: "filter by base branch" },
      },
      required: ["repo"],
    },
    invoke: async (args: {
      repo: string;
      state?: string;
      head?: string;
      base?: string;
    }) => {
      const opts = ["--repo", args.repo, "--state", args.state ?? "open"];
      if (args.head) opts.push("--head", args.head);
      if (args.base) opts.push("--base", args.base);
      opts.push(
        "--json",
        "number,title,state,mergeable,headRefName,baseRefName,url,createdAt,statusCheckRollup",
      );
      const r = gh(["pr", "list", ...opts], { json: true });
      return r.parsed ?? { error: r.stderr || r.stdout, exit_code: r.exit_code };
    },
  },

  pr_view: {
    description:
      "View a specific PR — title, body, comments, status checks, mergeable state. Use to read CodeRabbit comments and CI signals together.",
    schema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        pr: { type: "number" },
      },
      required: ["repo", "pr"],
    },
    invoke: async ({ repo, pr }: { repo: string; pr: number }) => {
      const r = gh(
        [
          "pr",
          "view",
          String(pr),
          "--repo",
          repo,
          "--json",
          "number,title,body,state,mergeable,headRefName,baseRefName,url,statusCheckRollup,reviews,comments",
          "--comments",
        ],
        { json: true },
      );
      return r.parsed ?? { error: r.stderr, exit_code: r.exit_code };
    },
  },

  pr_checks: {
    description:
      "Get the CI check status for a PR. Returns each check's name, status, and conclusion.",
    schema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        pr: { type: "number" },
      },
      required: ["repo", "pr"],
    },
    invoke: async ({ repo, pr }: { repo: string; pr: number }) => {
      const r = gh(["pr", "checks", String(pr), "--repo", repo], {});
      return {
        raw: r.stdout,
        exit_code: r.exit_code,
      };
    },
  },

  issue_list: {
    description: "List issues for a repo. Use to surface user-filed bugs/asks.",
    schema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
        label: { type: "string" },
      },
      required: ["repo"],
    },
    invoke: async (args: { repo: string; state?: string; label?: string }) => {
      const opts = ["--repo", args.repo, "--state", args.state ?? "open"];
      if (args.label) opts.push("--label", args.label);
      opts.push("--json", "number,title,state,labels,createdAt,updatedAt,url");
      const r = gh(["issue", "list", ...opts], { json: true });
      return r.parsed ?? { error: r.stderr, exit_code: r.exit_code };
    },
  },
};
