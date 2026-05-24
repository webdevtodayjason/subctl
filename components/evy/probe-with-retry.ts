// components/evy/probe-with-retry.ts
//
// Generic retry-with-backoff wrapper for sidecar reachability probes
// (Cognee, Memori, etc.). Replaces the one-shot probe pattern that
// produced false-UNREACHABLE log lines during the master boot race:
// Python sidecars take 5–15s to come up (interpreter + SDK load), and
// master would fire its probe immediately, log a loud
// `[cognee] UNREACHABLE` line, then quietly recover on the next
// kickstart. From the operator's perspective the sidecar looked broken
// at every boot.
//
// Contract:
//   * Probe is invoked once. If `reachable === true`, return immediately.
//   * Otherwise wait `baseDelayMs * 2^attempt` and try again, up to
//     `maxAttempts` or until cumulative wall time exceeds `budgetMs`,
//     whichever comes first.
//   * Intermediate failures log a *quiet* line:
//       `[name] not yet reachable (attempt N/M, will retry in Xs)`
//     not the loud UNREACHABLE — that's reserved for the final state
//     after exhaustion.
//   * On final success: `[name] reachable after N attempts (Xms total)`.
//   * On final exhaustion: a loud UNREACHABLE line with the last error.
//
// Tests inject a synthetic sleep via `_setDepsForTesting` so the suite
// doesn't burn real wall-time on backoff.

export interface ProbeWithRetryOpts<T extends { reachable: boolean }> {
  /** Short tag used in log prefixes, e.g. "cognee", "memori". */
  name: string;
  /** Probe function — invoked once per attempt. */
  probe: () => Promise<T>;
  /** Maximum total wall time (ms) to spend across all attempts. */
  budgetMs: number;
  /** First retry waits this long; doubles each attempt. */
  baseDelayMs: number;
  /** Hard cap on attempts regardless of budget. */
  maxAttempts: number;
  /** Log sink — pass `console.error` in prod, capture in tests. */
  log: (line: string) => void;
}

// ─── deps seam (test-injectable sleep + clock) ────────────────────────────

interface Deps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realDeps: Deps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function describeError(probe: { error?: string | null }): string {
  return probe.error ?? "unknown";
}

// ─── main ─────────────────────────────────────────────────────────────────

export async function probeWithRetry<T extends { reachable: boolean }>(
  opts: ProbeWithRetryOpts<T>,
): Promise<T> {
  const { name, probe, budgetMs, baseDelayMs, maxAttempts, log } = opts;
  const start = deps.now();
  let attempt = 0;
  let lastResult: T | null = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await probe();
    lastResult = result;

    if (result.reachable) {
      const total = deps.now() - start;
      if (attempt === 1) {
        // First-try success → caller's existing "reachable" log line
        // upstream is sufficient. We still return cleanly without an
        // extra log to avoid double-logging. Caller logs detail.
        return result;
      }
      log(
        `[${name}] reachable after ${attempt} attempts (${total}ms total)`,
      );
      return result;
    }

    // Decide whether to retry. Stop if we're out of attempts OR the
    // *next* backoff would push us past the budget.
    const elapsed = deps.now() - start;
    const nextDelay = baseDelayMs * 2 ** (attempt - 1);
    const willExceedBudget = elapsed + nextDelay > budgetMs;
    const attemptsExhausted = attempt >= maxAttempts;

    if (attemptsExhausted || willExceedBudget) {
      // Final failure → loud UNREACHABLE line. Caller's broadcast
      // path takes over from here.
      log(
        `[${name}] UNREACHABLE after ${attempt} attempts (${elapsed}ms total) — ${describeError(result)}`,
      );
      return result;
    }

    // Intermediate failure → quiet line with the retry hint.
    const delaySec = (nextDelay / 1000).toFixed(1);
    log(
      `[${name}] not yet reachable (attempt ${attempt}/${maxAttempts}, will retry in ${delaySec}s)`,
    );
    await deps.sleep(nextDelay);
  }

  // Defensive: loop guard above always returns. If we somehow fall
  // through (maxAttempts === 0), surface the last result or a
  // synthetic "never tried" shape.
  if (lastResult) return lastResult;
  return { reachable: false } as T;
}
