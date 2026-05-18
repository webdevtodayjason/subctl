// components/master/background-runs.ts
//
// v2.8.10 — Background-task runtime.
//
// Problem this solves: native tools that take >15s (tinyfish_agent,
// specforge, voice render, deep fetches) block Evy's turn. The operator
// has to wait synchronously, even if the result isn't urgent. The
// background runtime lets her say "I've kicked off X, I'll let you know
// when it's back" and continue talking. When the run finishes, the
// operator gets a tray notification AND the result is buffered to
// prepend onto their next chat/telegram prompt.
//
// Surfacing mechanism — *prepend to next operator turn*. We do NOT inject
// synthetic messages into agent.state.messages, because:
//   - A mid-stream `system` message gets folded into `instructions` by
//     pi-ai's openai-codex-responses provider (it sets
//     includeSystemPrompt:false in buildRequestBody) — silently dropped.
//   - A synthetic `user` message would auto-trigger a turn on injection,
//     not on the operator (the auto-speak path we explicitly ruled out).
//   - A synthetic `assistant`+`toolResult` pair re-creates the orphaned-
//     toolResult bug that just produced a Codex HTTP 400 today.
//
// Instead: completions buffer here; processOnePrompt drains the buffer
// and prepends `[background completions since last turn: …]` to p.text
// when source is "chat" or "telegram". Evy responds to the operator's
// message with the background context attached.
//
// Limitation (Phase A): runs do not survive master restart. The fetch
// terminates with the process. On boot, any sidecar entries still in
// "running" state are marked "failed" with reason "lost on master
// restart". Operator-tunable durability via TinyFish MCP async API is
// future work — for now Phase A trades durability for simplicity.

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── types ─────────────────────────────────────────────────────────────────

export type BackgroundRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundRun {
  /** Stable id: bg_<timestampBase36>_<8 hex>. */
  id: string;
  /** Native tool name, e.g. "tinyfish_agent". */
  tool_name: string;
  /** Short truncated arg preview for operator-facing displays. */
  args_summary: string;
  status: BackgroundRunStatus;
  /** ISO 8601. */
  started_at: string;
  /** ISO 8601, set on terminal status. */
  finished_at?: string;
  /** Tool output on `completed`. */
  result?: unknown;
  /** Error string on `failed` / `cancelled`. */
  error?: string;
  /** Set when caller passes a label for human reference. */
  label?: string;
}

/** Executor receives an AbortSignal so cancel() can interrupt fetches. */
export type BackgroundExecutor = (
  signal: AbortSignal,
) => Promise<
  | { ok: true; result: unknown }
  | { ok: false; error: string }
>;

interface SidecarShape {
  version: 1;
  runs: BackgroundRun[];
}

// ─── injectable side-effect surface (for tests) ────────────────────────────

interface Deps {
  /** Current time in ms-since-epoch. Injected for deterministic tests. */
  now: () => number;
  /** Persist the full state to the sidecar JSON. */
  saveSidecar: (s: SidecarShape) => Promise<void>;
  /** Load the sidecar JSON if present, else null. */
  loadSidecar: () => Promise<SidecarShape | null>;
  /** Notification emitter — wired to components/master/notifications.ts in prod. */
  emitNotification?: (input: {
    kind: string;
    severity: "info" | "warn" | "alert";
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

function defaultSidecarPath(): string {
  const home = process.env.HOME ?? "/tmp";
  const cfg = process.env.SUBCTL_CONFIG_DIR ?? join(home, ".config", "subctl");
  return join(cfg, "master", "background-runs.json");
}

const realDeps: Deps = {
  now: () => Date.now(),
  saveSidecar: async (s) => {
    const path = defaultSidecarPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, path);
  },
  loadSidecar: async () => {
    const path = defaultSidecarPath();
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as SidecarShape;
      if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── module state ──────────────────────────────────────────────────────────

const runs = new Map<string, BackgroundRun>();
const controllers = new Map<string, AbortController>();
/**
 * Completions waiting to be prepended to the next operator turn. Cleared
 * by drainPendingForNextTurn() when processOnePrompt picks them up.
 * Keyed by run id for dedupe across multiple drains in one turn (unlikely
 * but harmless).
 */
const pendingForNextTurn = new Map<string, BackgroundRun>();

// ─── persistence helpers ───────────────────────────────────────────────────

async function persist(): Promise<void> {
  try {
    await deps.saveSidecar({
      version: 1,
      runs: [...runs.values()],
    });
  } catch (err) {
    // Sidecar write failures are warned-not-thrown — the in-memory state
    // is still valid for this process lifetime.
    console.error(
      `[background-runs] sidecar write failed: ${
        (err as Error).message ?? err
      }`,
    );
  }
}

export async function hydrateFromSidecar(): Promise<void> {
  const loaded = await deps.loadSidecar();
  if (!loaded || !Array.isArray(loaded.runs)) return;
  let lostCount = 0;
  for (const r of loaded.runs) {
    if (!r || typeof r !== "object" || typeof r.id !== "string") continue;
    if (r.status === "running") {
      r.status = "failed";
      r.error = "lost on master restart (Phase A limitation)";
      r.finished_at = new Date(deps.now()).toISOString();
      lostCount += 1;
    }
    runs.set(r.id, r);
  }
  if (lostCount > 0) {
    console.error(
      `[background-runs] hydrated ${loaded.runs.length} runs; marked ${lostCount} orphan(s) as failed (master restart)`,
    );
    await persist();
  } else if (loaded.runs.length > 0) {
    console.error(`[background-runs] hydrated ${loaded.runs.length} runs`);
  }
}

// ─── public API ────────────────────────────────────────────────────────────

function makeRunId(t: number): string {
  return `bg_${t.toString(36)}_${randomUUID().slice(0, 8)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

/**
 * Start a background run. Returns the run_id immediately. The executor
 * is fired-and-forgotten; its completion writes back to the run record
 * and buffers a completion notice for the next operator turn.
 */
export function startBackgroundRun(input: {
  tool_name: string;
  args_summary: string;
  label?: string;
  executor: BackgroundExecutor;
}): string {
  const t = deps.now();
  const id = makeRunId(t);
  const run: BackgroundRun = {
    id,
    tool_name: input.tool_name,
    args_summary: truncate(input.args_summary, 200),
    status: "running",
    started_at: new Date(t).toISOString(),
    label: input.label,
  };
  runs.set(id, run);
  const controller = new AbortController();
  controllers.set(id, controller);
  void persist();
  // Fire the executor in the background. Catches BOTH thrown errors
  // and ok:false results uniformly.
  void (async () => {
    try {
      const out = await input.executor(controller.signal);
      // cancelRun() pre-marks status as "cancelled" before aborting the
      // signal. Don't overwrite that with the executor's late-arriving
      // ok:false / error result.
      if (run.status === "cancelled") {
        // leave the cancellation in place
      } else if (out.ok) {
        run.status = "completed";
        run.result = out.result;
      } else {
        run.status = "failed";
        run.error = out.error;
      }
    } catch (err) {
      if (run.status === "cancelled") {
        // leave it
      } else if (controller.signal.aborted) {
        run.status = "cancelled";
        run.error = "aborted via cancel()";
      } else {
        run.status = "failed";
        run.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      run.finished_at = new Date(deps.now()).toISOString();
      controllers.delete(id);
      // Buffer for next operator turn (regardless of success/failure —
      // the operator wants to know either way).
      pendingForNextTurn.set(id, run);
      // Tray notification.
      if (deps.emitNotification) {
        const sev = run.status === "completed" ? "info" : "warn";
        const headline = `${input.tool_name} ${run.status}`;
        const summary =
          run.status === "completed"
            ? truncate(JSON.stringify(run.result), 200)
            : run.error ?? "no error message";
        try {
          deps.emitNotification({
            kind: "background-run",
            severity: sev,
            title: `${headline}: ${truncate(input.args_summary, 40)}`,
            body: summary,
            metadata: {
              run_id: id,
              tool_name: input.tool_name,
              status: run.status,
            },
          });
        } catch (err) {
          console.error(
            `[background-runs] emitNotification threw: ${(err as Error).message ?? err}`,
          );
        }
      }
      await persist();
    }
  })();
  return id;
}

export function getRun(run_id: string): BackgroundRun | null {
  return runs.get(run_id) ?? null;
}

export function listRuns(opts: {
  status?: BackgroundRunStatus;
  limit?: number;
} = {}): BackgroundRun[] {
  const all = [...runs.values()];
  const filtered = opts.status
    ? all.filter((r) => r.status === opts.status)
    : all;
  // Newest first.
  filtered.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

/**
 * Attempt to cancel a running run. Returns true if the cancel was
 * dispatched (the executor's AbortSignal fires). False if the run was
 * already terminal or unknown.
 */
export function cancelRun(run_id: string): boolean {
  const r = runs.get(run_id);
  if (!r || r.status !== "running") return false;
  const c = controllers.get(run_id);
  if (!c) return false;
  // Mark state up front so executors that don't honor the signal still
  // produce the right final state.
  r.status = "cancelled";
  r.error = "cancelled by operator";
  c.abort();
  void persist();
  return true;
}

/**
 * Drain and return any completions that finished since the last drain.
 * Called by processOnePrompt() at the top of every chat/telegram turn
 * so the operator's prompt is prepended with what came in while away.
 */
export function drainPendingForNextTurn(): BackgroundRun[] {
  if (pendingForNextTurn.size === 0) return [];
  const out = [...pendingForNextTurn.values()];
  pendingForNextTurn.clear();
  return out;
}

/**
 * Format a set of completed runs as a human-readable prepend block. Used
 * by processOnePrompt to attach context to the operator's next prompt.
 * Returns null when there's nothing to surface.
 *
 * Format is intentionally bracketed + signposted so the supervisor can
 * recognize it as ambient context distinct from the operator's actual
 * text — and so the operator can scan it in the dashboard transcript
 * without confusion.
 */
export function formatPrependForOperator(
  completed: BackgroundRun[],
): string | null {
  if (completed.length === 0) return null;
  const lines: string[] = [];
  lines.push(
    `[background completions since your last turn — ${completed.length} run${completed.length === 1 ? "" : "s"} finished while you were away]`,
  );
  for (const r of completed) {
    const elapsed =
      r.finished_at && r.started_at
        ? Math.round(
            (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000,
          )
        : null;
    const head = `· ${r.tool_name} [${r.id}] ${r.status}${
      elapsed != null ? ` (${elapsed}s)` : ""
    }`;
    lines.push(head);
    if (r.label) lines.push(`  label: ${r.label}`);
    lines.push(`  args: ${r.args_summary}`);
    if (r.status === "completed") {
      const resultStr = truncate(
        typeof r.result === "string" ? r.result : JSON.stringify(r.result),
        500,
      );
      lines.push(`  result: ${resultStr}`);
    } else {
      lines.push(`  error: ${truncate(r.error ?? "unknown", 300)}`);
    }
  }
  lines.push(
    `[end background completions — full results via background_status if you need them]`,
  );
  return lines.join("\n");
}

/** Reset for tests. */
export function _resetStateForTesting(): void {
  runs.clear();
  controllers.clear();
  pendingForNextTurn.clear();
}
