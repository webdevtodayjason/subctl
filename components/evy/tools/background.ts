// components/master/tools/background.ts
//
// v2.8.10 — Background-run tool family.
//
// Three tools surface the components/master/background-runs.ts runtime
// to Evy:
//
//   - background_run     (generic dispatcher: run ANY tool in the background)
//   - background_status  (inspect active + recent runs)
//   - background_cancel  (abort a running run by id)
//
// Per-tool `_async` shadows (e.g. tinyfish_agent_async) live alongside
// these as a discoverability hint — Evy sees the `_async` suffix in her
// registry and knows that tool has a long-running variant. The shadows
// just forward to startBackgroundRun, same as background_run does.
//
// Surfacing: when a run completes, its result is buffered and prepended
// to the operator's NEXT chat/telegram message — see
// components/master/background-runs.ts for the rationale (don't inject
// synthetic messages; provider-pairing rules will reject them).

import {
  startBackgroundRun,
  getRun,
  listRuns,
  cancelRun,
} from "../background-runs";

/**
 * Tool registry passed in by server.ts at boot time. We need this to
 * resolve `tool_name` → invoke fn for the generic dispatcher.
 */
export interface ToolEntry {
  description: string;
  schema: unknown;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
}

let registry: Record<string, ToolEntry> | null = null;

/**
 * Wire the background tools to the live tool registry. Called from
 * server.ts after the registry is constructed. Without this binding,
 * background_run will refuse to dispatch — fail closed rather than
 * silently no-op.
 */
export function bindBackgroundToolRegistry(
  r: Record<string, ToolEntry>,
): void {
  registry = r;
}

const SUMMARY_MAX = 200;

function summarizeArgs(args: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = String(args);
  }
  if (json.length <= SUMMARY_MAX) return json;
  return `${json.slice(0, SUMMARY_MAX)}…`;
}

// ─── tool 1: background_run ────────────────────────────────────────────────

const background_run = {
  description:
    "**Use this when** you want to fire off ANY registered tool in the background and keep talking to the operator. Returns a run_id immediately; the result is delivered as a tray notification AND prepended to the operator's next chat/telegram message. Good candidates: tinyfish_agent (use tinyfish_agent_async for a discoverable shortcut), voice_render (use voice_render_async), web_fetch on big pages, any specforge call that goes deep. Bad candidates: cheap synchronous reads (system_load, memory_search), anything where you need the result THIS turn to decide your next action. Args: pass the SAME args you'd pass to the underlying tool, plus optional `label` for human reference.",
  schema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "Exact name of the tool to invoke (e.g. 'tinyfish_agent', 'voice_render', 'web_fetch'). Must be a registered tool.",
      },
      tool_args: {
        type: "object",
        description:
          "Arguments to pass to the underlying tool. Same shape as if you were calling the tool directly.",
      },
      label: {
        type: "string",
        description:
          "Optional short human label for this run, surfaced in background_status output and the operator-facing prepend.",
      },
    },
    required: ["tool_name"],
  },
  invoke: async (args: {
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    label?: string;
  } = {}) => {
    const toolName = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
    if (!toolName) {
      return { ok: false, error: "tool_name is required" };
    }
    // Recursion guard runs BEFORE registry lookup: the rule is about
    // the name regardless of whether it's currently in the registry.
    if (toolName === "background_run" || toolName.startsWith("background_")) {
      return {
        ok: false,
        error: "refusing to background-dispatch a background_* tool — would recurse",
      };
    }
    if (!registry) {
      return {
        ok: false,
        error:
          "background_run not wired (registry binding missing). This is a master-boot bug — report it.",
      };
    }
    const target = registry[toolName];
    if (!target) {
      return {
        ok: false,
        error: `tool "${toolName}" is not in the registry. Use system_my_tools to see what's available.`,
      };
    }
    const toolArgs = (args.tool_args ?? {}) as Record<string, unknown>;
    const summary = `${toolName}: ${summarizeArgs(toolArgs)}`;
    const id = startBackgroundRun({
      tool_name: toolName,
      args_summary: summary,
      label: args.label,
      executor: async (_signal) => {
        try {
          const out = await target.invoke(toolArgs);
          // Pi-ai tools return { ok: bool, ... } envelopes; respect that
          // shape if present so failure is properly attributed.
          if (
            out &&
            typeof out === "object" &&
            "ok" in (out as Record<string, unknown>) &&
            (out as { ok: unknown }).ok === false
          ) {
            const err = (out as { error?: unknown }).error;
            return {
              ok: false,
              error:
                typeof err === "string"
                  ? err
                  : `${toolName} returned ok:false (no error string)`,
            };
          }
          return { ok: true, result: out };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
    return {
      ok: true,
      run_id: id,
      status: "started",
      tool_name: toolName,
      args_summary: summary,
      label: args.label ?? null,
      note: "Result will be delivered as a notification and prepended to the operator's next message.",
    };
  },
};

// ─── tool 2: background_status ─────────────────────────────────────────────

const background_status = {
  description:
    "**Use this when** the operator asks 'what's running' or 'is X done yet', or you want to introspect your own pending background work. Optional `run_id` returns one record; otherwise returns up to `limit` recent runs (newest-first), optionally filtered by `status`.",
  schema: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        description: "Inspect a single run by id.",
      },
      status: {
        type: "string",
        enum: ["running", "completed", "failed", "cancelled"],
        description: "Filter the list by terminal/active status.",
      },
      limit: {
        type: "integer",
        description: "Max records to return (default 20, max 200).",
        minimum: 1,
        maximum: 200,
      },
    },
    required: [],
  },
  invoke: async (args: {
    run_id?: string;
    status?: "running" | "completed" | "failed" | "cancelled";
    limit?: number;
  } = {}) => {
    if (typeof args.run_id === "string" && args.run_id) {
      const r = getRun(args.run_id);
      if (!r) {
        return { ok: false, error: `no run with id "${args.run_id}"` };
      }
      return { ok: true, run: r };
    }
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const runs = listRuns({ status: args.status, limit });
    return {
      ok: true,
      count: runs.length,
      filter_status: args.status ?? null,
      runs,
    };
  },
};

// ─── tool 3: background_cancel ─────────────────────────────────────────────

const background_cancel = {
  description:
    "**Use this when** the operator wants to abort a background run that's still running (you started a tinyfish_agent run and the operator changed their mind, or the run is taking too long). Returns ok:true if a cancel was dispatched; ok:false if the run is unknown or already terminal. The underlying fetch may not honor the AbortSignal yet (Phase A limitation) — the run will be marked cancelled in state regardless, and the late-arriving result is discarded.",
  schema: {
    type: "object",
    properties: {
      run_id: {
        type: "string",
        description: "Id of the run to cancel.",
      },
    },
    required: ["run_id"],
  },
  invoke: async (args: { run_id?: string } = {}) => {
    const id = typeof args.run_id === "string" ? args.run_id.trim() : "";
    if (!id) return { ok: false, error: "run_id is required" };
    const ok = cancelRun(id);
    if (!ok) {
      const r = getRun(id);
      if (!r) return { ok: false, error: `no run with id "${id}"` };
      return {
        ok: false,
        error: `run "${id}" is already ${r.status}, cannot cancel`,
      };
    }
    return { ok: true, run_id: id, status: "cancelled" };
  },
};

// ─── family export ─────────────────────────────────────────────────────────

export const backgroundTools = {
  background_run,
  background_status,
  background_cancel,
};
