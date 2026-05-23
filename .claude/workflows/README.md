# `.claude/workflows/` — pre-staged Claude Code workflow scripts

These scripts target the **undocumented, Statsig-gated** Claude Code Workflow tool that ships in 2.1.147+. The feature requires:

1. `CLAUDE_CODE_WORKFLOWS=1` in the env at process startup (cached per-process)
2. Statsig flag `tengu_workflows_enabled` true for the account (defaults true in binary but Anthropic appears to gate to internal accounts)

As of **2026-05-23** condition 1 is satisfied across our fleet but condition 2 is not — `/workflows` returns "Unknown command". Scripts here are staged for the day the gate flips.

See `Subctl/AI Docs/2026-05-23 - Claude Code workflows discovery.md` in the Obsidian vault for the full context.

## Scripts

| File | Pattern | Args | Status |
|---|---|---|---|
| [`coderabbit-fix-fanout.js`](./coderabbit-fix-fanout.js) | Parallel fan-out (one agent per finding) → aggregate | `{ prNumber, repo }` | provisional — DSL inferred from binary strings |
| [`wave-deploy.js`](./wave-deploy.js) | Sequential pipeline (admin-merge → tag → deploy local → deploy M3 → verify) | `{ version, prNumber }` | provisional — DSL inferred from binary strings |

## DSL surface (from binary archaeology)

```js
export const meta = {
  name: "<slug>",                     // command name shown by /workflows
  description: "<short>",             // hover/help text
  phases: ["a", "b", "c"],            // declared phase names, MUST be a pure literal
};

// Top-level await is supported. `args` is a global passed in via the Workflow tool.
const result = await agent({
  prompt: "...",                      // string sent to the subagent
  agentType: "general-purpose",       // or any registered agent type
  model: "claude-opus-4-7",           // optional
  effort: "low" | "medium" | "high" | "max" | "xhigh",
  isolation: "worktree" | "remote",   // optional
  schema: { /* JSON Schema */ },      // optional — forces StructuredOutput
  cwd: "/abs/path",                   // optional
});

// Parallel takes THUNKS (functions returning promises), NOT promises themselves.
// Wrong:   parallel([agent(...), agent(...)])
// Right:   parallel([() => agent(...), () => agent(...)])
const results = await parallel([
  () => agent({ prompt: "a" }),
  () => agent({ prompt: "b" }),
]);

// Pipeline maps over items + optional aggregator.
const out = await pipeline(
  items,                              // array
  (item) => agent({ prompt: ... }),   // per-item function
  (results) => agent({ prompt: ... }) // optional aggregator
);

// Phase wraps a unit of work for the /workflows progress UI.
const x = await phase("phase-name", async () => {
  return await agent({ /* ... */ });
});
```

## Constraints (enforced by the runtime)

- **Deterministic only.** `Date.now()`, `Math.random()`, `new Date()` are unavailable inside the script body. Pass timestamps via `args` if you need them. This is so workflows can be resumed.
- **`meta` must be a pure literal.** No computed values. Static analysis reads it before script execution.
- **Resume:** every invocation persists its script to a file in the session directory. To iterate, edit that file and re-invoke with `{ scriptPath: "<path>" }`. Use `{ resumeFromRunId: "wf_..." }` to skip already-completed agent calls.
- **No background sessions while resuming.** Stop the prior run first.

## Things we don't know yet (verify when Statsig flips)

- Exact return shape of `agent()` when `schema` is set (parsed JSON object? validated object?).
- Whether `pipeline()` runs items sequentially or in parallel (binary error string says "stages must be functions" but doesn't clarify concurrency).
- Cancellation semantics for in-flight `parallel()` children if one throws.
- Whether `args` accepts only JSON-serializable values or richer types.
- How errors inside `agent()` surface — exception that bubbles, or return-value shape?

When the gate opens: run each workflow once with logging-style prompts, observe behavior, update these scripts and this README.
