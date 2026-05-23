// coderabbit-fix-fanout.js — parallel fan-out for CodeRabbit findings on the current PR.
//
// STATUS: PROVISIONAL. Written 2026-05-23 against decompiled DSL from claude-code 2.1.150
// binary. Anthropic has not officially released /workflows; this script is staged for the
// day Statsig flips `tengu_workflows_enabled` true for our account. Validate by running:
//   /workflows
//   coderabbit-fix-fanout
// before trusting it in a real convergence loop. Adjust signatures if upstream DSL diverges.
//
// Invocation:
//   args = { prNumber: 22, repo: "webdevtodayjason/subctl" }
//
// Pattern this captures: CodeRabbit posts N findings on a PR. Today we either dispatch
// workers sequentially (slow) or fan out via TeamCreate + Agent (works but ties up panes).
// With /workflows this becomes one deterministic JS file that:
//   1. Pulls the review body via gh CLI
//   2. Parses out actionable findings
//   3. Fans out N agents, one per finding, in parallel
//   4. Aggregates the diffs into a single report

export const meta = {
  name: "coderabbit-fix-fanout",
  description:
    "Fan out parallel fix agents for each CodeRabbit finding on a PR, then aggregate the diffs",
  phases: ["fetch-review", "parse-findings", "dispatch-fixes", "aggregate"],
};

// --- Phase 1: fetch the CodeRabbit review body
const reviewBody = await phase("fetch-review", async () => {
  return await agent({
    prompt: `Run \`gh pr view ${args.prNumber} --repo ${args.repo} --json reviews -q '.reviews[] | select(.author.login == "coderabbitai") | .body'\` and return the raw markdown body verbatim. No commentary.`,
    agentType: "general-purpose",
    effort: "low",
  });
});

// --- Phase 2: parse findings from the review body into a structured list
const findings = await phase("parse-findings", async () => {
  return await agent({
    prompt: `Below is a CodeRabbit review body. Extract every distinct actionable finding into a JSON array. Skip "nitpicks", "duplicates", and ">_ Files reviewed" sections. Each entry: { id: <short slug>, file: <path>, line: <number or null>, description: <one-sentence>, recommendation: <verbatim from review> }.

REVIEW BODY:
${reviewBody}`,
    agentType: "general-purpose",
    effort: "medium",
    schema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "file", "description", "recommendation"],
            properties: {
              id: { type: "string" },
              file: { type: "string" },
              line: { type: ["integer", "null"] },
              description: { type: "string" },
              recommendation: { type: "string" },
            },
          },
        },
      },
      required: ["findings"],
    },
  });
});

// --- Phase 3: dispatch one fix agent per finding, in parallel
const fixes = await phase("dispatch-fixes", async () => {
  return await parallel(
    findings.findings.map((f) => () =>
      agent({
        prompt: `You are fixing one CodeRabbit finding on PR #${args.prNumber}.

FINDING ID: ${f.id}
FILE: ${f.file}${f.line ? ":" + f.line : ""}
DESCRIPTION: ${f.description}
RECOMMENDATION:
${f.recommendation}

Apply the smallest correct fix. Stay strictly within ${f.file}. Do not touch unrelated files. Run the relevant test(s) if any. Report back: what you changed (file:line), why, and a one-line confidence note (high/medium/low).`,
        agentType: "general-purpose",
        effort: "medium",
        isolation: "worktree", // each fix in its own worktree so they can't conflict
      })
    )
  );
});

// --- Phase 4: aggregate fixes into a single report for the operator
const summary = await phase("aggregate", async () => {
  return await agent({
    prompt: `Below are ${fixes.length} fix-worker outputs from a parallel CodeRabbit convergence pass on PR #${args.prNumber}. Produce a single ledger:

| Finding ID | File | Status | Confidence | One-line summary |

Then a "Next step" block: either "All fixes look ready — push and re-poll CodeRabbit" or "N fixes need operator review before push" with the specific IDs called out.

FIX OUTPUTS:
${fixes.map((fix, i) => `--- fix #${i + 1} (id=${findings.findings[i].id}) ---\n${fix}`).join("\n\n")}`,
    agentType: "general-purpose",
    effort: "low",
  });
});

return summary;
