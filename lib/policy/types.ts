// Type contracts for the subctl policy engine (v2.7.0).
//
// This file is the single source of truth for the policy document shape and
// the inputs/outputs of the runtime check function. The TOML loader, the TS
// check.ts hot path, the Go CLI vector tests, the master tool family, the
// `subctl policy *` subcommands, and the dashboard all consume these types.
//
// Faithful transcription of the type contract in
// `.orchestration/handoff-pack/06-tool-family-policy.md` §3. Do not "improve"
// the shapes — downstream consumers (especially the Go port in PR 8) depend
// on field-by-field parity.
//
// Consumers should import from `lib/policy` (the index re-export), not from
// this file directly.

/**
 * The three policy modes a worker can spawn in.
 *
 * Per docs/policy.md §1, the mode is decided at spawn time, is immutable for
 * the life of the worker, and is recorded in the worker's audit log header.
 * Per HANDOFF_DIGEST §3.1 (D9): the defang stays in all three modes; the
 * `PreToolUse` hook is added on top, never as a replacement.
 */
export type Mode = "trusted" | "gated" | "sealed";

/**
 * The root policy document, as parsed from a `.subctl/policy.toml` file
 * (or any of the four merge sources — see docs/policy-schema.md §1).
 *
 * Per docs/policy-schema.md §2. `mode.gated` is the interesting one and
 * carries the bulk of the configuration surface.
 */
export interface PolicyDocument {
  /** Optional ecosystem preset to inherit from: "node" | "python" | "generic" | "rust" | "go". */
  preset?: string;
  /** Default mode when `subctl teams <provider>` is invoked without --mode. Defaults to "gated". */
  default_mode?: Mode;
  /** Per-mode configuration tables. */
  mode: {
    trusted?: TrustedMode;
    gated?: GatedMode;
    sealed?: SealedMode;
  };
  /**
   * Metadata populated by the loader AFTER the merge pass. Source files on
   * disk do NOT set this; it appears only on resolved policies in memory.
   * Per docs/policy-schema.md §8 (snapshot format).
   */
  __meta?: {
    sourcePaths: string[];
    allowlistSha: string;
    /** ISO 8601 timestamp with milliseconds, UTC. */
    resolvedAt: string;
  };
}

/**
 * Trusted-mode configuration.
 *
 * Intentionally empty: Trusted mode has nothing to configure. Per
 * docs/policy.md §1.1, the model's training and system prompt are the only
 * gates; subctl injects no hook and removes no tools. The defang STAYS even
 * in Trusted mode (HANDOFF_DIGEST §3.1, D9), but the defang is not a
 * per-mode toggle — it's a property of every subctl-spawned worker.
 *
 * This interface exists so the type system can name the empty shape and so
 * future additions (e.g. a one-time-warning suppression flag) have a clean
 * place to land.
 */
export interface TrustedMode {
  // intentionally empty; trusted has no config
}

/**
 * Gated-mode configuration — the bulk of the policy surface.
 *
 * Per docs/policy-schema.md §3. Resolution order at check time
 * (docs/policy.md §4): `deny_always` wins over everything; then
 * `deny_if_arg_contains` on a matched allow_pattern; then the allow_pattern;
 * then `allow.commands` exact-match; default deny.
 *
 * Ecosystem-specific tables (npm/pnpm/bun/yarn/make/just/python_modules/
 * uv/poetry) are namespaced because they need richer validation than
 * `args` + `deny_if_arg_contains` can express. The check.ts hot path reads
 * `package.json` / `Makefile` / etc. from `<cwd>` at check time, cached.
 */
export interface GatedMode {
  /** Exact-match command names (first whitespace-separated token). No arg checking. */
  allow?: {
    commands?: string[];
  };
  /** The core allowlist: command + arg-list filters. */
  allow_pattern?: AllowPattern[];
  /** Patterns that override every allow rule. */
  deny_always?: {
    substrings?: string[];
    /** RE2 syntax (Go-style; no lookbehind). Compiled once at policy-load. */
    regex?: string[];
  };
  /** `npm run <script>` allowlist; also gates `npm test` as `npm run test`. */
  npm?: { allowed_scripts: string[] };
  pnpm?: { allowed_scripts: string[] };
  bun?: { allowed_scripts: string[] };
  yarn?: { allowed_scripts: string[] };
  /** `make <target>` allowlist; the hook reads Makefile/GNUmakefile from `<cwd>`. */
  make?: { allowed_targets: string[] };
  /** `just <recipe>` allowlist. */
  just?: { allowed_recipes: string[] };
  /** `python -m <module>` allowlist. Pairs with deny_always for `python -c`. */
  python_modules?: { allowed: string[] };
  /** `uv run <target>` allowlist. */
  uv?: { allowed_run_targets: string[] };
  /** `poetry run <target>` allowlist. */
  poetry?: { allowed_run_targets: string[] };
}

/**
 * A single allow_pattern entry. Per docs/policy-schema.md §3.2.
 *
 * Semantics:
 * - `command` — exact match on the first non-flag token.
 * - `args` — the first non-flag argument must be in this list. Subsequent
 *   args are unrestricted unless `deny_if_arg_contains` is set. A command
 *   with no args matches if `command` matches and `args` is empty or `[""]`.
 * - Flags before the first non-flag arg are ignored for matching purposes
 *   (so `git -C /tmp status` matches `command="git", args=["status"]`).
 * - `deny_if_arg_contains` — substring match against any single token in
 *   the command. Fires after the pattern matches; substrings, not regex.
 */
export interface AllowPattern {
  command: string;
  args?: string[];
  deny_if_arg_contains?: string[];
}

/**
 * Sealed-mode configuration. Per docs/policy.md §5 + docs/policy-schema.md §4.
 *
 * In Sealed mode the worker has no `Bash` tool at all — it's listed in
 * `disabledTools` and replaced by an MCP server (`subctl-sealed-tools`)
 * exposing the named tool set. A belt-and-suspenders `PreToolUse` hook for
 * Bash is still installed; check.ts denies every invocation in this mode
 * as a fail-safe.
 */
export interface SealedMode {
  /** The whitelisted MCP tool names available to the Sealed worker. */
  mcp_tools: string[];
  /**
   * Exact string the `test_run` MCP tool will execute. No interpolation,
   * no piping, no `&&` chains. Validated by `subctl policy validate`.
   */
  test_command?: string;
  /** What `policy_request` does when the worker asks for a one-off command. */
  escalation?: {
    target: "master" | "operator";
    /** If false, master decides autonomously (no operator round-trip). */
    require_approval: boolean;
    timeout_seconds: number;
  };
}

/**
 * Input to the check function. Per pack 06 §3.
 *
 * The check is stateless wrt the worker — it takes the raw command, the
 * worker's cwd (so ecosystem helpers can read `package.json` / `Makefile`
 * etc.), the team_id (for audit logging), and an optional session id.
 */
export interface CheckRequest {
  /** Raw command line as proposed by the agent. NOT shell-expanded. */
  command: string;
  /** Worker's current working directory at the time of the proposed exec. */
  cwd: string;
  team_id: string;
  /** Claude Code (or other provider) session id, if available. */
  agent_session_id?: string;
}

/**
 * Output of the check function. Per pack 06 §3.
 *
 * `rule` is human-readable (renders into stderr + audit log + dashboard).
 * `rule_path` is structured (dot-path into the policy doc) and is what the
 * verifier's denial-cluster detection groups on.
 */
export interface CheckResult {
  decision: "allow" | "deny";
  /** Human-readable rule that fired, e.g. `deny_always.substrings: "rm -rf"`. */
  rule?: string;
  /** Dot-path into the policy doc, e.g. `mode.gated.deny_always.substrings`. */
  rule_path?: string;
}

/**
 * One row of the JSONL audit log at
 * `~/.local/state/subctl/audit/<team_id>.jsonl`. Per pack 09 §3.
 *
 * Three event_type variants:
 * - "header"  — written at spawn time; marks a session boundary in the log.
 * - "check"   — the dominant case; one per policy check, allow or deny.
 * - "verifier_correction" — written when the master's denial-cluster
 *   detection fires a `[verifier]` correction prompt at a worker (D8 in
 *   HANDOFF_DIGEST, shipped in v2.7.0).
 */
export interface AuditEntry {
  /** ISO 8601 with milliseconds, UTC: "2026-05-11T18:42:13.901Z". */
  ts: string;
  team_id: string;
  /** Provider session id (Claude Code session id, etc.) if available. */
  agent_session_id?: string;
  mode: Mode;
  /** First 8 hex chars of the policy snapshot's allowlist sha256. */
  allowlist_sha?: string;
  /** Untruncated raw command. Empty string on header / verifier_correction events. */
  command: string;
  decision: "allow" | "deny";
  /** Human-readable rule that fired. Absent for default-deny. */
  rule?: string;
  /** Structured dot-path. Absent for default-deny. */
  rule_path?: string;
  /** Event discriminator. Per pack 09 §3. */
  event_type: "check" | "header" | "verifier_correction";
}
