// components/evy/policy/exec.ts
//
// Centralized exec helper for the subctl evy daemon, dashboard, and any
// other TS surface inside the repo (v2.7.0 / PR 8.5). Sits one layer above
// `Bun.spawn` and provides:
//
//   - `execCommand(cmd, args, opts)` — ungated wrapper. Use this for internal
//     exec where the caller knows the command is safe (well-known binaries
//     like `git`, `tmux`, `launchctl` with argv-array form). Captures stdout
//     and stderr as strings, enforces a default 30s timeout, and never sets
//     `shell: true`.
//
//   - `execCommandGated(cmd, args, opts)` — calls the in-process policy
//     check (`components/evy/tools/policy/check.ts`) BEFORE spawning. If
//     the resolved policy denies the command, throws `PolicyDenied` with the
//     rule + rule_path that fired. Use this at callsites where the
//     command — or a major component of it — comes from operator/agent
//     input (HTTP body, MCP tool input, Telegram message, etc.).
//
// Design rationale (HANDOFF_DIGEST §3.2):
// - subctl has ~70 distinct exec call sites today. Some legitimately don't
//   need gating (internal daemon tooling); some absolutely do (the
//   user-supplied-input paths cataloged in EXEC_SURFACE.md §4). Forcing
//   every site through a single gated helper would break the master's
//   internal probes. Forcing nothing through a helper leaves no clean
//   chokepoint for future policy work. Two functions split the difference.
//
// - This helper is intentionally placed at `components/evy/policy/exec.ts`
//   (NOT `components/evy/tools/policy/`) for two reasons:
//   1. It fills the empty `components/evy/policy/` directory that the
//      safety-model worker flagged as a Chekhov's-gun dead-code path.
//   2. It is consumed by callsites OUTSIDE the master tool family
//      (dashboard, future provider scaffolding), so it cannot live under
//      `tools/` which is master-tool-namespace by convention.
//
// - Migrations are incremental. PR 8.5 migrates 3-5 representative TS sites
//   only. The rest are tracked in docs/exec-migration.md as follow-ups.
//
// Performance: warm-cache `execCommandGated` adds ~1-2ms of overhead vs
// `execCommand` (a single policy check against the cached resolved policy).
// The policy load itself is async-cached per project_root inside the call
// to `loadResolvedPolicy`; callers are expected to pass the same project
// root for the worker's lifetime.

import { checkCommand } from "../tools/policy/check";
import { loadResolvedPolicy } from "../tools/policy/load";
import type { Mode, PolicyDocument } from "../tools/policy/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecOptions {
  /** Working directory for the spawned process. Defaults to process cwd. */
  cwd?: string;
  /**
   * Environment for the spawned process. Per Bun.spawn, if `env` is set the
   * spawned process gets ONLY these vars — it does not inherit process.env.
   * Callers that want to extend should pass `{ ...process.env, FOO: "bar" }`.
   */
  env?: Record<string, string>;
  /** UTF-8 string written to the child's stdin then closed. Omit to inherit. */
  stdin?: string;
  /** Hard timeout in ms. Default 30_000 (30s). Set to 0 to disable. */
  timeout?: number;
  /**
   * Policy gating options. Required for `execCommandGated`; ignored by
   * `execCommand`. `mode`, when set, overrides the policy doc's
   * `default_mode` (per HANDOFF_DIGEST D3: command-tier can further restrict
   * but never relax). Omit to use the resolved policy's mode as-is.
   */
  policy?: { teamId: string; mode?: Mode; projectRoot: string };
}

export interface ExecResult {
  /** Captured stdout as a UTF-8 string. May be empty. */
  stdout: string;
  /** Captured stderr as a UTF-8 string. May be empty. */
  stderr: string;
  /**
   * Process exit code. `null` only when the process was killed by signal
   * before reporting an exit code (e.g. timeout kill, SIGTERM from operator).
   */
  exitCode: number | null;
  /** Wall-clock duration from spawn to exit, in milliseconds. */
  durationMs: number;
  /** True if the process was killed by the helper's timeout. */
  timedOut: boolean;
}

/**
 * Thrown by `execCommandGated` when the policy check denies the command.
 *
 * The error carries the same `rule` + `rule_path` strings the check engine
 * emits, so callsite code can route them straight into audit logs, the
 * dashboard's Live Logs Policy filter, or `[verifier]` correction prompts
 * (PR 6.5) without re-parsing.
 *
 * `.command` is the full reconstructed command line (cmd + args joined by
 * spaces). Note this is NOT shell-quoted — it's a human-readable rendering
 * for log/audit/error-message purposes, not something a shell could safely
 * re-execute.
 */
export class PolicyDenied extends Error {
  public readonly rule: string;
  public readonly rulePath: string;
  public readonly command: string;
  constructor(rule: string, rulePath: string, command: string) {
    super(`policy denied: ${rule} (${rulePath})`);
    this.name = "PolicyDenied";
    this.rule = rule;
    this.rulePath = rulePath;
    this.command = command;
  }
}

// ---------------------------------------------------------------------------
// Ungated exec
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawn `cmd` with `args` and return captured stdout/stderr + exit code.
 *
 * Always uses argv-array form (`Bun.spawn({ cmd: [head, ...args] })`); never
 * `shell: true`. The helper is responsible for capturing both streams to
 * UTF-8 strings and enforcing a hard timeout — callers shouldn't have to
 * re-implement either.
 *
 * On timeout, the child is sent SIGKILL and `timedOut: true` is set in the
 * result. `exitCode` will be `null` and `stderr`/`stdout` will contain
 * whatever the process emitted before being killed.
 *
 * Errors thrown:
 * - The spawn itself failing (binary not found, permission denied, etc.)
 *   bubbles as the native Bun error. Callers that prefer a result-style
 *   API should wrap in try/catch.
 */
export async function execCommand(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const start = performance.now();
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;

  // AbortSignal.timeout(0) would fire immediately; treat 0 as "no timeout".
  // Pulling the controller out so we can distinguish helper-imposed timeout
  // from a caller-supplied signal in a future revision.
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeout > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeout);
  }

  // Bun.spawn returns a Subprocess. stdin: "pipe" + writing a string is the
  // simplest path; for the common no-stdin case we use "ignore" so the
  // child sees /dev/null on fd 0.
  const stdinSpec: "ignore" | Blob =
    opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]);

  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    cwd: opts.cwd,
    env: opts.env,
    stdin: stdinSpec,
    stdout: "pipe",
    stderr: "pipe",
    signal: ctrl.signal,
  });

  let stdout = "";
  let stderr = "";
  try {
    // Concurrent stream drain prevents PIPE backpressure stalls on chatty
    // children. `await proc.exited` alone is insufficient if the child fills
    // the stdout pipe buffer and blocks waiting for a reader.
    const [outText, errText] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    stdout = outText;
    stderr = errText;
  } catch (err) {
    // AbortError from the timeout signal lands here for some Bun versions;
    // capture whatever streams produced before death.
    if (!timedOut) throw err;
  }

  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  const durationMs = performance.now() - start;

  return {
    stdout,
    stderr,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    durationMs,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Gated exec
// ---------------------------------------------------------------------------

// Per-projectRoot policy cache. The hot path of an HTTP handler that calls
// `execCommandGated` repeatedly (e.g. dashboard's `/api/orchestration/msg`)
// would otherwise re-read + re-merge the four-source TOML chain on every
// call. Cache is keyed by absolute projectRoot. There is no TTL: the master
// daemon writes a snapshot at spawn time per pack 09, and a worker's
// resolved policy is immutable for the life of the worker (HANDOFF_DIGEST
// D9 — defang is orthogonal, mode is locked at spawn).
//
// Callers that mutate policy mid-run (test fixtures, the `subctl policy
// reload` follow-up in v2.8) should call `_clearPolicyCacheForTesting()`.
const policyCache = new Map<string, PolicyDocument>();

async function resolvePolicyCached(projectRoot: string): Promise<PolicyDocument> {
  const cached = policyCache.get(projectRoot);
  if (cached) return cached;
  const fresh = await loadResolvedPolicy(projectRoot);
  policyCache.set(projectRoot, fresh);
  return fresh;
}

/**
 * Gate `cmd args` through the policy engine, then exec on allow.
 *
 * Resolution:
 *   1. Load (or hit cache for) the resolved policy at `opts.policy.projectRoot`.
 *   2. If `opts.policy.mode` is set, override the policy's `default_mode`
 *      (HANDOFF_DIGEST D3: command-tier overrides only further restrict).
 *   3. Build the full command line `"cmd arg1 arg2 ..."` (space-joined; this
 *      is the form the tokenizer + deny_always substrings expect).
 *   4. Call `checkCommand`. On deny → throw `PolicyDenied`. On allow →
 *      delegate to `execCommand`.
 *
 * Note on command-line construction: the policy engine tokenizes the same
 * string a shell would (via the shared `shell-quote` tokenizer in
 * tokenize.ts). For caller-supplied args containing spaces or shell
 * metacharacters, the reconstruction here is intentionally naive — that
 * matches how the upstream Claude Code `PreToolUse` hook sees the agent's
 * proposed command (a single string). Callers that need argv-array
 * preservation should not use the gated variant for now; gate at a higher
 * layer instead.
 */
export async function execCommandGated(
  cmd: string,
  args: string[],
  opts: ExecOptions & { policy: NonNullable<ExecOptions["policy"]> },
): Promise<ExecResult> {
  const { teamId, mode, projectRoot } = opts.policy;
  const policy = await resolvePolicyCached(projectRoot);

  // Mode override (HANDOFF_DIGEST D3). Operate on a shallow copy so we don't
  // mutate the cached doc — a downstream call with no override should still
  // see the policy's original default_mode.
  const effective: PolicyDocument = mode
    ? { ...policy, default_mode: mode }
    : policy;

  const commandLine = [cmd, ...args].join(" ");
  const result = checkCommand(effective, {
    command: commandLine,
    cwd: opts.cwd ?? projectRoot,
    team_id: teamId,
  });

  if (result.decision === "deny") {
    throw new PolicyDenied(
      result.rule ?? "unknown_rule",
      result.rule_path ?? "unknown_rule_path",
      commandLine,
    );
  }

  return execCommand(cmd, args, opts);
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/**
 * Clear the per-projectRoot policy cache. Tests that mock different
 * resolved policies at the same path should call this between cases.
 *
 * Not exported via index.ts on purpose — this is a test-only escape hatch.
 */
export function _clearPolicyCacheForTesting(): void {
  policyCache.clear();
}
