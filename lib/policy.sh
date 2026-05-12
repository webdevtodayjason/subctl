#!/usr/bin/env bash
# lib/policy.sh — `subctl policy <verb>` dispatcher.
#
# Six verbs:
#   check     → delegates to the Go binary bin/subctl-policy-check (PR 8).
#               The hot path; called by Claude Code hooks per command.
#               Must be fast (<50ms cold, <10ms warm) — that's why it's Go.
#   list      → bin/policy/list.ts      (operator-facing resolved-policy view)
#   validate  → bin/policy/validate.ts  (schema + invariants check)
#   explain   → bin/policy/explain.ts   (allow/deny trace + suggested fix)
#   audit     → bin/policy/audit.ts     (JSONL log reader with filters)
#   snapshot  → bin/policy/snapshot.ts  (per-team snapshot --show / --verify)
#
# The TS verbs run via `bun`. Each verb's argv is forwarded verbatim — flags
# live in the TS script's own commander-style parser, not here. Per PR 9 brief:
# latency doesn't matter for these (operator-interactive), so we don't pay
# the price of bundling them into the Go binary.
#
# Per HANDOFF_DIGEST §3.1 (D9), this whole subcommand family is INSPECTION +
# CONFIGURATION. It does not touch the defang. The Bash-script defang stays
# in providers/claude/teams.sh, untouched by this file.

. "$(dirname "${BASH_SOURCE[0]}")/core.sh"

# Resolve the path to the subctl-policy-check Go binary.
#
# Priority:
#   1. $SUBCTL_POLICY_CHECK_BIN (explicit override; tests + dev workflows)
#   2. $SUBCTL_HOME/bin/subctl-policy-check (installed path; default ~/.subctl)
#   3. $SUBCTL_REPO_ROOT/bin/subctl-policy-check/subctl-policy-check (built in repo)
#
# Fails closed (subctl_die) if none of those exist — the hook MUST have a real
# binary. Per pack 07 §3, missing binary surfaces as a clear install error.
_subctl_policy_check_bin() {
  if [[ -n "${SUBCTL_POLICY_CHECK_BIN:-}" ]] && [[ -x "$SUBCTL_POLICY_CHECK_BIN" ]]; then
    printf '%s\n' "$SUBCTL_POLICY_CHECK_BIN"
    return 0
  fi
  local installed="${SUBCTL_HOME:-$HOME/.subctl}/bin/subctl-policy-check"
  if [[ -x "$installed" ]]; then
    printf '%s\n' "$installed"
    return 0
  fi
  local built="$SUBCTL_REPO_ROOT/bin/subctl-policy-check/subctl-policy-check"
  if [[ -x "$built" ]]; then
    printf '%s\n' "$built"
    return 0
  fi
  return 1
}

_subctl_policy_help() {
  cat <<'EOF'
subctl policy <verb> [args]

  Inspect + manage the policy engine for spawned coding agents (modes,
  allowlists, audit). Per docs/policy.md.

Verbs:
  check       The gate — called by hooks. stdin=command, exit 0/1/2.
              Delegates to the Go binary `subctl-policy-check` for latency.
  list        Show the resolved policy for a project (human or --json).
  validate    Validate a policy.toml file against the schema + invariants.
  explain     Show the allow/deny evaluation trace for a command — the
              single most useful debugging tool when a worker hits a denial.
  audit       Read the audit log for a team (human / --jsonl / --csv).
  snapshot    Inspect / verify a team's policy snapshot (--show, --verify,
              --rewrite).

Each verb takes --help for its own usage. See docs/policy.md for the
full spec.
EOF
}

_subctl_policy() {
  local sub="${1:-help}"
  [[ $# -gt 0 ]] && shift

  case "$sub" in
    check)
      local bin_path
      if ! bin_path=$(_subctl_policy_check_bin); then
        subctl_die "subctl-policy-check binary not found — run 'bash install.sh' or 'cd bin/subctl-policy-check && make' (looked in: \$SUBCTL_POLICY_CHECK_BIN, \$SUBCTL_HOME/bin, $SUBCTL_REPO_ROOT/bin/subctl-policy-check)"
      fi
      exec "$bin_path" "$@"
      ;;
    list)
      exec bun run "$SUBCTL_REPO_ROOT/bin/policy/list.ts" "$@"
      ;;
    validate)
      exec bun run "$SUBCTL_REPO_ROOT/bin/policy/validate.ts" "$@"
      ;;
    explain)
      exec bun run "$SUBCTL_REPO_ROOT/bin/policy/explain.ts" "$@"
      ;;
    audit)
      exec bun run "$SUBCTL_REPO_ROOT/bin/policy/audit.ts" "$@"
      ;;
    snapshot)
      exec bun run "$SUBCTL_REPO_ROOT/bin/policy/snapshot.ts" "$@"
      ;;
    help|-h|--help|"")
      _subctl_policy_help
      ;;
    *)
      subctl_err "unknown policy verb: $sub"
      _subctl_policy_help >&2
      exit 1
      ;;
  esac
}
