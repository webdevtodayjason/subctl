// Classify failures from `bin/subctl teams <provider>` so the dashboard
// returns 4xx for user errors (template not found, account not configured,
// missing prompt file) and reserves 500 for genuine infra failures. The
// caller previously collapsed every non-zero exit to HTTP 500, which made
// `subctl_orch_spawn_template` indistinguishable from a server crash and
// trained the master to abandon the template path on first failure.
//
// All recognized patterns come from `subctl_die` invocations in
// providers/claude/teams.sh and lib/core.sh — the messages are stable
// because subctl-master tools key off them too.

export type SpawnErrorKind =
  | "template_not_found"
  | "unknown_account"
  | "account_unconfigured"
  | "missing_prompt_file"
  | "policy_failure"
  | "spawn_failed"
  | "spawn_timeout";

export interface ClassifiedSpawnError {
  status: number;
  kind: SpawnErrorKind;
  error: string;
}

export interface SpawnErrorInput {
  stderr?: string | null;
  stdout?: string | null;
  timedOut?: boolean;
}

const MAX_ERROR_LEN = 800;

function trimErr(s: string): string {
  const t = s.trim();
  return t.length > MAX_ERROR_LEN ? t.slice(0, MAX_ERROR_LEN) : t;
}

export function classifySpawnError(input: SpawnErrorInput): ClassifiedSpawnError {
  if (input.timedOut) {
    return { status: 504, kind: "spawn_timeout", error: "spawn timed out" };
  }
  const blob = `${input.stderr ?? ""}\n${input.stdout ?? ""}`;
  const head = trimErr(blob) || "spawn failed";

  if (/team template not found/i.test(blob)) {
    return { status: 404, kind: "template_not_found", error: head };
  }
  if (/unknown account/i.test(blob) || /not in accounts\.conf/i.test(blob)) {
    return { status: 404, kind: "unknown_account", error: head };
  }
  if (/has no config directory/i.test(blob)) {
    return { status: 412, kind: "account_unconfigured", error: head };
  }
  if (/prompt file not found/i.test(blob)) {
    return { status: 404, kind: "missing_prompt_file", error: head };
  }
  if (/^\s*policy:/im.test(blob)) {
    return { status: 500, kind: "policy_failure", error: head };
  }
  return { status: 500, kind: "spawn_failed", error: head };
}
