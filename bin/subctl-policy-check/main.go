// bin/subctl-policy-check/main.go
//
// CLI entry for the policy-engine hot path. Spec: pack 07 §3.
//
//   subctl-policy-check --team=<id> --project-root=<dir> [--mode=<mode>] < cmd
//
// Behavior:
//   1. Read full command from stdin (UTF-8; may be multi-line).
//   2. Load policy snapshot at <state>/teams/<team>/policy.snapshot.toml.
//      Missing or malformed → exit 2 (fail closed — pack 07 §3, pack 11 §8).
//   3. Apply --mode override (the spawn-time mode wins per HANDOFF_DIGEST D3).
//   4. Run CheckCommand; emit audit entry (fail-open per pack 09 §4).
//   5. Exit 0 (allow), 1 (deny — print rule to stderr+stdout), 2 (config error).
//
// Latency target (pack 07 §3): <50ms cold-start, <10ms warm. The Go binary
// loads, parses, checks, audits, exits. Total syscalls in the steady state:
//   - 1 stat snapshot
//   - 1 read snapshot
//   - 1 mkdir audit dir (no-op after first)
//   - 1 open audit log
//   - 1 write audit line
//   - 1 close audit log
//
// No network. No filesystem walks. No subprocess spawns.

package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"time"
)

// VERSION is the binary's reported version. Bumped in lockstep with the main
// subctl VERSION file. Surfaced via `--version`.
const VERSION = "2.7.0"

const (
	ExitAllow  = 0
	ExitDeny   = 1
	ExitConfig = 2
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// run is the testable form of main(). Separated so unit tests can drive it
// with synthetic argv/stdin/stdout without spawning a subprocess.
func run(argv []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("subctl-policy-check", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var (
		team        = fs.String("team", "", "team ID (required)")
		projectRoot = fs.String("project-root", "", "project root directory")
		mode        = fs.String("mode", "", "override mode: trusted|gated|sealed")
		sessionID   = fs.String("session", "", "agent session id (optional; recorded in audit)")
		showVersion = fs.Bool("version", false, "print version and exit")
		help        = fs.Bool("help", false, "print usage and exit")
	)

	if err := fs.Parse(argv); err != nil {
		// flag.ContinueOnError already printed the error; this is a config
		// error — exit 2 (fail closed).
		return ExitConfig
	}
	if *help {
		printUsage(stderr)
		return ExitAllow
	}
	if *showVersion {
		fmt.Fprintf(stdout, "subctl-policy-check %s\n", VERSION)
		return ExitAllow
	}

	if *team == "" {
		fmt.Fprintln(stderr, "ERROR: --team is required")
		printUsage(stderr)
		return ExitConfig
	}
	if *mode != "" && *mode != "trusted" && *mode != "gated" && *mode != "sealed" {
		fmt.Fprintf(stderr, "ERROR: --mode must be trusted|gated|sealed (got %q)\n", *mode)
		return ExitConfig
	}

	// Read the command from stdin (full read, no line-splitting).
	cmdBytes, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: read stdin: %v\n", err)
		return ExitConfig
	}
	command := string(cmdBytes)

	// Load + parse snapshot. Missing/malformed → exit 2 (fail closed).
	snapshotPath := GetSnapshotPath(*team)
	policy, meta, err := ReadSnapshot(snapshotPath)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: snapshot %s: %v\n", snapshotPath, err)
		return ExitConfig
	}

	// Spawn-time mode override (pack 07 §3; HANDOFF_DIGEST D3 — command-tier
	// further restricts/specifies but never relaxes).
	if *mode != "" {
		policy.DefaultMode = *mode
	}

	res := CheckCommand(policy, &CheckRequest{
		Command:        command,
		Cwd:            *projectRoot,
		TeamID:         *team,
		AgentSessionID: *sessionID,
	})

	// Emit audit entry. Fail-open: log to stderr on write failure but do NOT
	// alter the decision exit code (pack 09 §4).
	entry := &AuditEntry{
		Ts:             time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		TeamID:         *team,
		AgentSessionID: *sessionID,
		Mode:           policy.DefaultMode,
		AllowlistSha:   meta.AllowlistSha,
		Command:        command,
		Decision:       res.Decision,
		Rule:           res.Rule,
		RulePath:       res.RulePath,
		EventType:      "check",
	}
	if err := AppendAuditEntry(*team, entry); err != nil {
		fmt.Fprintf(stderr, "WARN: audit append failed: %v\n", err)
		// fall through — decision still propagates
	}

	if res.Decision == "deny" {
		msg := formatDenyReason(&res)
		// Claude Code's PreToolUse reads stderr for hook errors; the CLI
		// contract also writes to stdout for non-Claude consumers.
		fmt.Fprintln(stderr, msg)
		fmt.Fprintln(stdout, msg)
		return ExitDeny
	}
	return ExitAllow
}

func formatDenyReason(r *CheckResult) string {
	if r.RulePath != "" {
		return fmt.Sprintf("DENIED: %s (%s)", r.Rule, r.RulePath)
	}
	return fmt.Sprintf("DENIED: %s", r.Rule)
}

func printUsage(w io.Writer) {
	fmt.Fprintf(w, `subctl-policy-check %s

Hot-path policy gate for subctl's PreToolUse hook. Reads a command from
stdin, consults the team's resolved policy snapshot, and exits with:
  0 = allow
  1 = deny  (one-line reason printed to stderr + stdout)
  2 = config error (snapshot missing/malformed; hook should treat as deny)

Usage:
  subctl-policy-check --team=<id> --project-root=<dir> [--mode=<mode>] \
      [--session=<sid>] < command

Flags:
  --team           team identifier (required; selects the snapshot to load)
  --project-root   worker's project root (for package.json / Makefile probes)
  --mode           override the snapshot's default mode (trusted|gated|sealed)
  --session        agent session id (recorded in audit, optional)
  --version        print version and exit
  --help           print this help and exit

Snapshot path: $SUBCTL_STATE_DIR/teams/<team>/policy.snapshot.toml
               (fallback: ~/.local/state/subctl/teams/<team>/policy.snapshot.toml)
`, VERSION)
}
