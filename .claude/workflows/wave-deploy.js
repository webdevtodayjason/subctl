// wave-deploy.js — sequential ship pipeline for a subctl release wave.
//
// STATUS: PROVISIONAL. Written 2026-05-23 against decompiled DSL from claude-code 2.1.150
// binary. Anthropic has not officially released /workflows; this script is staged for the
// day Statsig flips `tengu_workflows_enabled` true for our account. Validate by running:
//   /workflows
//   wave-deploy
// before trusting it on a real release. Adjust signatures if upstream DSL diverges.
//
// Invocation:
//   args = { version: "2.10.1", prNumber: 22 }
//
// Pattern this captures: today's v2.10.0 ship was:
//   resolve conflicts → push → admin-merge → tag → pull main (both worktrees) → install local
//   → restart local services → ssh M3 → install → restart M3 services → health-check
// Doing this by hand burns ~10 min and is mistake-prone. As a deterministic pipeline:

export const meta = {
  name: "wave-deploy",
  description:
    "Sequential ship pipeline: admin-merge PR, tag, deploy local + M3, verify both",
  phases: ["merge", "tag", "deploy-local", "deploy-m3", "verify"],
};

// --- Phase 1: admin-merge the PR
const merged = await phase("merge", async () => {
  return await agent({
    prompt: `Run \`gh pr view ${args.prNumber} --json mergeable,mergeStateStatus,state\`. If state is OPEN and mergeable is MERGEABLE (or UNSTABLE — admin override), run \`gh pr merge ${args.prNumber} --squash --admin\`. Then fetch origin and report the new main HEAD short-SHA. If the PR is already merged, just return the current main HEAD SHA with a "(already merged)" note.`,
    agentType: "general-purpose",
    effort: "low",
  });
});

// --- Phase 2: tag the release on the install worktree (which owns main)
const tagged = await phase("tag", async () => {
  return await agent({
    prompt: `In /Users/sem/.local/lib/subctl-install (the install worktree on main):
  1. \`git pull origin main\`
  2. \`cat VERSION\` — confirm it reads ${args.version}
  3. \`git tag -a v${args.version} -m "v${args.version}"\`
  4. \`git push origin v${args.version}\`

Report: new HEAD, VERSION content, tag pushed (yes/no), any errors.`,
    agentType: "general-purpose",
    effort: "low",
  });
});

// --- Phase 3: install + restart on local Mac
const localDeploy = await phase("deploy-local", async () => {
  return await agent({
    prompt: `Deploy v${args.version} on the local Mac:
  1. In /Users/sem/.local/lib/subctl-install run \`bash install.sh\` (build dashboard + binaries)
  2. The master plist on local reads from /Users/sem/code/subctl (dev tree) — if dev tree branch is feat/* and was just squash-merged, run \`cd /Users/sem/code/subctl && git fetch origin && git reset --hard origin/main\`. Otherwise just \`git pull origin main\` on whatever branch.
  3. \`launchctl kickstart -k "gui/$(id -u)/com.subctl.master"\`
  4. Sleep 6s.
  5. Probe: \`curl -s http://127.0.0.1:8787/api/version\` and \`curl -s http://127.0.0.1:8788/health | jq .version\` — both must report ${args.version}.

Report results. If versions don't match, stop and surface the diagnostic.`,
    agentType: "general-purpose",
    effort: "medium",
  });
});

// --- Phase 4: install + restart on M3 (via SSH) — only runs if local succeeded
const m3Deploy = await phase("deploy-m3", async () => {
  return await agent({
    prompt: `Deploy v${args.version} on M3 via SSH (host: sem@192.168.100.62):
  1. \`ssh sem@192.168.100.62 'cd /Users/sem/.local/lib/subctl-install && git pull origin main && bash install.sh'\`
  2. \`ssh sem@192.168.100.62 'launchctl kickstart -k "gui/$(id -u)/com.subctl.master" ; launchctl kickstart -k "gui/$(id -u)/com.subctl.dashboard"'\`
  3. Sleep 6s.
  4. \`ssh sem@192.168.100.62 'curl -s http://127.0.0.1:8787/api/version ; curl -s http://127.0.0.1:8788/health | jq .version'\` — both must report ${args.version}.

Note: M3 plist points at install worktree (unlike local), so no dev-tree reset needed. Report results.`,
    agentType: "general-purpose",
    effort: "medium",
  });
});

// --- Phase 5: cross-host verify + Cognee/Memori sidecar health
const verify = await phase("verify", async () => {
  return await agent({
    prompt: `Final verification for v${args.version}:
  1. Local master + dashboard report v${args.version} (recap from prior phases).
  2. M3 master + dashboard report v${args.version} (recap from prior phases).
  3. \`curl -s http://127.0.0.1:8745/health | jq .total_memories\` — Cognee local sidecar still up (any non-error JSON).
  4. \`curl -s http://127.0.0.1:8746/health\` — Memori local sidecar still up.

Produce a final ledger table: | Component | Host | Version / Status | OK? |
Then "ALL GREEN" or call out the row that needs attention.`,
    agentType: "general-purpose",
    effort: "low",
  });
});

return {
  merged,
  tagged,
  localDeploy,
  m3Deploy,
  verify,
};
