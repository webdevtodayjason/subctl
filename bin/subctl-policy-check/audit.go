// bin/subctl-policy-check/audit.go
//
// JSONL audit appender. Mirrors `components/master/tools/policy/audit.ts`
// (PR 7) for the on-disk format; differs by NOT rotating — per pack 09 §5
// rotation lives in the TS audit writer. The Go binary just appends.
//
// Path: <state>/audit/<team_id>.jsonl where <state> = SUBCTL_STATE_DIR or
// ~/.local/state/subctl (same precedence as snapshot.ts + audit.ts).
//
// Atomicity (pack 09 §4): one O_APPEND|O_WRONLY|O_CREATE open + single
// write() call. POSIX guarantees concurrent writes < PIPE_BUF (≥4 KB)
// appended to the same fd don't tear bytes. Audit lines are well below
// that threshold.
//
// Failure semantics (pack 09 §4): fail-open. If the audit append fails (disk
// full, permission denied, parent dir unwritable), the decision still
// propagates — the worker isn't blocked on audit. We can't bump a metric
// counter from a one-shot CLI process the way the long-running TS daemon
// can, so on failure we just write a warning to stderr and exit normally.
// The master daemon's own metrics surface the failure on its side.

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// AuditEntry mirrors `lib/policy/types.ts:AuditEntry`. JSON tag order
// determines key order in the emitted line; we lean toward the order shown
// in pack 09 §3.2's example so the file is grep-friendly the same way the
// TS writer's output is.
//
// `omitempty` for the optional fields matches the TS writer's behavior
// (where `agent_session_id`, `rule`, `rule_path`, `allowlist_sha` get
// dropped by JSON.stringify when undefined).
type AuditEntry struct {
	Ts             string `json:"ts"`
	TeamID         string `json:"team_id"`
	AgentSessionID string `json:"agent_session_id,omitempty"`
	Mode           string `json:"mode"`
	AllowlistSha   string `json:"allowlist_sha,omitempty"`
	Command        string `json:"command"`
	Decision       string `json:"decision"`
	Rule           string `json:"rule,omitempty"`
	RulePath       string `json:"rule_path,omitempty"`
	EventType      string `json:"event_type"`
}

// ResolveAuditDir mirrors audit.ts:resolveAuditDir.
func ResolveAuditDir() string {
	return filepath.Join(ResolveStateDir(), "audit")
}

// GetAuditLogPath returns the canonical audit log path for a team.
func GetAuditLogPath(teamID string) string {
	return filepath.Join(ResolveAuditDir(), teamID+".jsonl")
}

// AppendAuditEntry writes one entry to the team's audit log. Returns an
// error iff the entry can't be JSON-encoded or the write fails; callers
// should NOT propagate the error to the exit code (the decision is the
// exit code, not the audit success).
func AppendAuditEntry(teamID string, entry *AuditEntry) error {
	if teamID == "" {
		return fmt.Errorf("AppendAuditEntry: teamID is required")
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("audit json encode: %w", err)
	}
	line = append(line, '\n')

	dir := ResolveAuditDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("audit mkdir: %w", err)
	}
	path := GetAuditLogPath(teamID)
	// O_APPEND ensures concurrent writers don't overwrite each other; the
	// single Write() call below is POSIX-atomic up to PIPE_BUF.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return fmt.Errorf("audit open: %w", err)
	}
	defer f.Close()
	if _, err := f.Write(line); err != nil {
		return fmt.Errorf("audit write: %w", err)
	}
	return nil
}
