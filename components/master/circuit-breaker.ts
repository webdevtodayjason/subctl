// components/master/circuit-breaker.ts
//
// v2.7.19 — Empty-listener tool-call circuit breaker.
//
// THE BUG IT FIXES
// ────────────────
// 2026-05-13, ~21:30. Operator on a 90-minute drive home. The master daemon
// (heavy supervisor: qwen3.6-35b-a3b) stops responding to Telegram. Diagnosis
// after-the-fact: master was stuck in an infinite tool-call loop, alternating
// between
//
//   • assistant turn, stopReason="toolUse", empty text
//   • tool result, payload: { entries: [], listener: { running: false, … } }
//
// The tool was subctl_orch_inbox (→ /api/notify/inbox on the dashboard), and
// the listener whose `running:false` it was reporting was the dashboard's
// notify-listener. The reasoning model fell into a "check again before
// answering" trap: empty inbox → check again → empty → check again → …
//
// CPU stayed at 0.3% (idle), but the prompt queue was wedged for 90 minutes
// because every assistant turn ended in another tool-use rather than a
// final text response. Telegram input piled up; the operator had no kill
// path until they got home.
//
// THE FIX
// ───────
// A narrow heuristic-based circuit breaker. Per (tool-name) we count
// consecutive returns whose shape STRONGLY indicates "listener is dead AND
// nothing to deliver" — specifically: `result.entries === []` AND
// `result.listener.running === false`. After 3 such consecutive returns,
// the NEXT call to that same tool is refused with a synthesized tool
// result the model sees:
//
//   { error: "circuit-breaker: tool <name> returned empty entries with
//     listener.running=false 3 times in a row. The listener is dead.
//     Stop polling — either call watchdog_list to inspect, or respond
//     to the operator with what you have." }
//
// The counter is conservative on purpose. False positives should be rare:
//   • A healthy inbox poll returns entries with listener.running=TRUE.
//   • An empty inbox poll where the listener IS alive doesn't trip — the
//     agent might still legitimately re-poll.
//   • A different tool result (or a different tool call) resets the
//     counter — only sustained spamming of the dead path trips.
//   • A new operator message resets via resetOnNewTurn() so the breaker
//     doesn't leak across turns.
//
// State lives in module-scope. The master daemon is single-process and
// per-(tool-name) state is what the spec calls for; no need for plumbing
// through the agent state object.

const CIRCUIT_BREAKER_THRESHOLD = 3;

// `lastEmptyListenerTool` tracks the most-recent tool name whose result
// matched the empty-listener pattern. Together with `consecutiveEmptyCount`
// they form a 2-tuple state machine. We don't track per-tool counters in a
// Map because the spec is clear that ANY OTHER TOOL'S RESULT resets the
// counter — once another tool runs, the trail is broken regardless of
// which tool we were watching.
let _lastEmptyListenerTool: string | null = null;
let _consecutiveEmptyCount = 0;

interface MaybeListener {
  running?: unknown;
}

interface MaybeListenerResult {
  entries?: unknown;
  listener?: MaybeListener;
}

/**
 * Detect the "empty listener" result shape that the looping tool returned
 * during the 2026-05-13 incident. Tight match: entries MUST be an empty
 * array (not just missing), AND listener.running MUST be explicitly
 * false (not undefined). A result that lacks one of those properties
 * doesn't trip — it just resets the counter as a non-matching tool result.
 */
export function isEmptyListenerResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const r = value as MaybeListenerResult;
  if (!Array.isArray(r.entries) || r.entries.length !== 0) return false;
  const listener = r.listener;
  if (!listener || typeof listener !== "object") return false;
  return (listener as MaybeListener).running === false;
}

/**
 * Inspect a freshly-completed tool result and update the breaker state.
 *   • Matching result for the same tool: bump the counter.
 *   • Matching result for a DIFFERENT tool: reset & start counting on new tool.
 *   • Non-matching result for any tool: reset entirely.
 *
 * Call this AFTER tool.invoke() resolves, regardless of error / success.
 * The breaker never raises on its own — shouldRefuseToolCall() is what
 * stops the next call.
 */
export function recordToolResult(toolName: string, result: unknown): void {
  if (isEmptyListenerResult(result)) {
    if (_lastEmptyListenerTool === toolName) {
      _consecutiveEmptyCount += 1;
    } else {
      _lastEmptyListenerTool = toolName;
      _consecutiveEmptyCount = 1;
    }
    return;
  }
  // Anything other than the dead-listener pattern resets the counter.
  // The spec is intentional: ONLY sustained spamming of the same dead
  // path trips the breaker. A successful inbox read (entries non-empty)
  // or any other tool's result clears the trail.
  _lastEmptyListenerTool = null;
  _consecutiveEmptyCount = 0;
}

/**
 * Should the next call to `toolName` be refused?
 *
 * Returns true ONLY when the counter has reached threshold for THIS exact
 * tool name. A model that pivots to a different tool after 3 dead-listener
 * returns is allowed through; only doubling down on the same dead path
 * trips the gate.
 */
export function shouldRefuseToolCall(toolName: string): boolean {
  return (
    _lastEmptyListenerTool === toolName &&
    _consecutiveEmptyCount >= CIRCUIT_BREAKER_THRESHOLD
  );
}

/**
 * Produce the synthesized error payload that gets returned to the model
 * in place of invoking the tool. The text is deliberately blunt — the
 * model should pivot to watchdog_list OR respond to the operator.
 */
export function synthesizeRefusal(toolName: string): { error: string } {
  return {
    error: `circuit-breaker: tool ${toolName} returned empty entries with listener.running=false ${CIRCUIT_BREAKER_THRESHOLD} times in a row. The listener is dead. Stop polling — either call watchdog_list to inspect, or respond to the operator with what you have.`,
  };
}

/**
 * Reset state when a new operator message arrives. Server.ts calls this
 * at the top of processOnePrompt so the breaker can't carry a tripped
 * state across turns (the operator's new prompt is a clean signal that
 * whatever the model was doing in the prior turn is no longer the task).
 */
export function resetOnNewTurn(): void {
  _lastEmptyListenerTool = null;
  _consecutiveEmptyCount = 0;
}

/**
 * Test-only: forcibly reset state. Equivalent to resetOnNewTurn() but
 * named so tests aren't pretending to be a new turn.
 */
export function _resetForTesting(): void {
  _lastEmptyListenerTool = null;
  _consecutiveEmptyCount = 0;
}

/**
 * Test-only: peek at the state without going through the public API.
 * Used by circuit-breaker.test.ts to assert intermediate counter values.
 */
export function _peekStateForTesting(): {
  tool: string | null;
  count: number;
  threshold: number;
} {
  return {
    tool: _lastEmptyListenerTool,
    count: _consecutiveEmptyCount,
    threshold: CIRCUIT_BREAKER_THRESHOLD,
  };
}
