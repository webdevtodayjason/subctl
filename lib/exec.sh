#!/usr/bin/env bash
# lib/exec.sh — centralized exec helpers for subctl bash scripts (v2.7.0 / PR 8.5).
#
# Two functions:
#   subctl_exec <cmd> [args...]
#     Ungated exec. Wraps an argv-array invocation with consistent logging.
#     Use this in place of bare `$(cmd ...)`, backticks, or `eval` where
#     gating doesn't apply but you want a single, greppable chokepoint.
#
#   subctl_exec_gated <team_id> <project_root> <cmd> [args...]
#     Gated exec. Calls `subctl-policy-check` (the Go binary built by PR 8)
#     before running. On deny, returns non-zero with the rule + rule_path
#     printed to stderr — analogous to TS-side PolicyDenied.
#
# Both functions:
#   - Always exec the argv array directly. No `eval`. No `bash -c`.
#   - Log to `${SUBCTL_EXEC_LOG:-/dev/stderr}` (override via env for tests
#     or to redirect into the dashboard audit feed).
#   - Pass through exit codes verbatim. Caller's `if subctl_exec ...; then`
#     idiom Just Works.
#
# Idempotent guard so repeated sourcing is safe.
[[ -n "${_SUBCTL_EXEC_LOADED:-}" ]] && return 0
_SUBCTL_EXEC_LOADED=1

# Resolve sibling lib if needed for core helpers (subctl_warn, etc.). We do
# NOT hard-require core.sh — exec.sh is intentionally usable from minimal
# scripts. The functions check for `subctl_warn`'s presence before calling.
_subctl_exec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Logging destination. Default stderr so it's visible in test output without
# any extra config. Override with SUBCTL_EXEC_LOG=/path/to/file to capture.
SUBCTL_EXEC_LOG="${SUBCTL_EXEC_LOG:-/dev/stderr}"

# Internal: emit a structured-ish log line. Format intentionally simple —
# a v2.8 follow-up can tighten this to JSONL if the dashboard wants to
# parse it. For now: `<ISO-ts> <event> <cmdline>`.
_subctl_exec_log() {
  local event="$1"; shift
  printf '[exec %s] %s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$event" \
    "$*" \
    >>"$SUBCTL_EXEC_LOG" 2>/dev/null || true
}

# subctl_exec <cmd> [args...]
# Ungated argv-array exec with logging. Returns the child's exit code.
subctl_exec() {
  if [[ $# -lt 1 ]]; then
    printf '[exec ERROR] subctl_exec called with no command\n' >&2
    return 2
  fi
  _subctl_exec_log "ungated" "$*"
  "$@"
}

# subctl_exec_gated <team_id> <project_root> <cmd> [args...]
# Policy-gated argv-array exec. Calls subctl-policy-check before running.
# On deny: prints "DENIED: <rule> (<rule_path>)" to stderr, returns 1.
# On allow: runs the command and returns its exit code.
# On policy-check missing/misconfigured: fails closed (returns 2). Pack 11 §8.
subctl_exec_gated() {
  if [[ $# -lt 3 ]]; then
    printf '[exec ERROR] subctl_exec_gated requires <team_id> <project_root> <cmd> [args...]\n' >&2
    return 2
  fi
  local team_id="$1"; shift
  local project_root="$1"; shift

  local policy_bin=""
  if [[ -n "${SUBCTL_POLICY_CHECK_BIN:-}" && -x "${SUBCTL_POLICY_CHECK_BIN}" ]]; then
    policy_bin="$SUBCTL_POLICY_CHECK_BIN"
  elif [[ -x "${SUBCTL_REPO_ROOT:-}/bin/subctl-policy-check/subctl-policy-check" ]]; then
    policy_bin="$SUBCTL_REPO_ROOT/bin/subctl-policy-check/subctl-policy-check"
  elif command -v subctl-policy-check >/dev/null 2>&1; then
    policy_bin="subctl-policy-check"
  else
    _subctl_exec_log "gated_no_binary" "$*"
    printf 'DENIED: subctl-policy-check not available (fail-closed)\n' >&2
    return 2
  fi

  # Reconstruct the full command line (cmd + args, space-joined) for the
  # tokenizer. This mirrors how the Claude Code PreToolUse hook sees the
  # agent's proposed command — a single string. Pack 06 §4.
  local cmdline="$*"

  # Pipe command via stdin per main.go contract.
  if "$policy_bin" --team "$team_id" --project-root "$project_root" \
      <<<"$cmdline" >/dev/null 2>"${_subctl_exec_err:-/dev/null}"; then
    _subctl_exec_log "gated_allow" "$cmdline"
    "$@"
  else
    local ec=$?
    _subctl_exec_log "gated_deny" "$cmdline (exit=$ec)"
    printf 'DENIED: subctl-policy-check exit=%d for: %s\n' "$ec" "$cmdline" >&2
    return 1
  fi
}

# Silence unused-var lint in shellcheck when sourced standalone.
: "${_subctl_exec_dir:?}"
