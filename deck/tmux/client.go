// Package tmux is a thin wrapper around the tmux command-line client.
//
// It is read-mostly: ListSessions, ListPanes, CapturePane, and
// GetSessionEnv are pure queries; KillSession, AttachSession, and
// NewSession mutate state. Errors from a missing tmux binary are
// non-fatal — callers should treat them like an empty result set.
package tmux

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Status represents a session's current activity state, derived from
// the most recent capture-pane snapshot of its active pane.
type Status int

// Session activity states.
const (
	// StatusUnknown means the pane content didn't match any known tell.
	StatusUnknown Status = iota
	// StatusIdle means the pane shows a Claude prompt with no active work.
	StatusIdle
	// StatusWorking means a spinner or "thinking..." line is visible.
	StatusWorking
	// StatusWaiting means a permission prompt is awaiting user input.
	StatusWaiting
)

// String returns a short label for the status.
func (s Status) String() string {
	switch s {
	case StatusIdle:
		return "idle"
	case StatusWorking:
		return "working"
	case StatusWaiting:
		return "waiting"
	default:
		return "unknown"
	}
}

// Pane is one tmux pane within a session.
type Pane struct {
	ID      string
	Command string
	Title   string
	Active  bool
}

// Session is one tmux session, plus the metadata subctl-deck cares about.
// Panes is populated lazily by ListPanes; the other fields after Panes
// are filled in by callers (radar, status detection, git, etc.).
type Session struct {
	Name        string
	Path        string
	Project     string
	Created     time.Time
	Account     string
	Branch      string
	Panes       []Pane
	Status      Status
	LastUpdated time.Time
	CtxPct      int
	SessionID   string
}

// Available reports whether the tmux binary is on $PATH.
func Available() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

// run is a small helper that runs tmux with the given args and returns
// trimmed stdout. A missing tmux binary returns ("", nil) — callers
// treat that as "no sessions" rather than a hard failure.
func run(args ...string) (string, error) {
	if !Available() {
		return "", nil
	}
	cmd := exec.Command("tmux", args...)
	out, err := cmd.Output()
	if err != nil {
		// `tmux list-sessions` exits non-zero with "no server running on ..."
		// which is the no-sessions case; propagate stderr only when there's
		// real output to inspect.
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			msg := strings.ToLower(string(ee.Stderr))
			if strings.Contains(msg, "no server running") || strings.Contains(msg, "no sessions") {
				return "", nil
			}
			return "", fmt.Errorf("tmux %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return string(out), nil
}

// ListSessions returns every running tmux session. Panes is left empty;
// call ListPanes for each session you care about.
//
// Missing tmux binary or no sessions both return ([], nil).
func ListSessions() ([]Session, error) {
	const fmtStr = "#{session_name}|#{session_created}|#{session_path}|#{session_windows}"
	out, err := run("list-sessions", "-F", fmtStr)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	var sessions []Session
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		fields := strings.SplitN(line, "|", 4)
		if len(fields) < 3 {
			continue
		}
		s := Session{
			Name: fields[0],
			Path: fields[2],
		}
		if epoch, perr := strconv.ParseInt(fields[1], 10, 64); perr == nil {
			s.Created = time.Unix(epoch, 0)
		}
		s.Project = projectBasename(s.Path)
		sessions = append(sessions, s)
	}
	return sessions, nil
}

// ListPanes returns every pane belonging to sessionName.
func ListPanes(sessionName string) ([]Pane, error) {
	const fmtStr = "#{pane_id}|#{pane_current_command}|#{pane_title}|#{pane_active}"
	out, err := run("list-panes", "-t", sessionName, "-F", fmtStr)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	var panes []Pane
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		fields := strings.SplitN(line, "|", 4)
		if len(fields) < 4 {
			continue
		}
		panes = append(panes, Pane{
			ID:      fields[0],
			Command: fields[1],
			Title:   fields[2],
			Active:  fields[3] == "1",
		})
	}
	return panes, nil
}

// CapturePane returns the last `lines` of paneID's output, with ANSI
// SGR colors preserved.
func CapturePane(paneID string, lines int) (string, error) {
	if lines <= 0 {
		lines = 200
	}
	return run("capture-pane", "-p", "-e", "-S", fmt.Sprintf("-%d", lines), "-t", paneID)
}

// GetSessionEnv reads a tmux session-scoped environment variable.
// Returns "" if the key is unset, the session is gone, or tmux is missing.
func GetSessionEnv(sessionName, key string) string {
	out, err := run("show-environment", "-t", sessionName, key)
	if err != nil {
		return ""
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return ""
	}
	// Format: KEY=VALUE on success; "-KEY" if unset.
	if strings.HasPrefix(out, "-") {
		return ""
	}
	if i := strings.IndexByte(out, '='); i >= 0 {
		return out[i+1:]
	}
	return ""
}

// KillSession ends the tmux session named name.
func KillSession(name string) error {
	_, err := run("kill-session", "-t", name)
	return err
}

// AttachCommand returns the *exec.Cmd that, when run, attaches the user
// to sessionName. Callers should hand it to tea.ExecProcess so the TUI
// suspends cleanly while tmux owns the terminal.
func AttachCommand(sessionName string) *exec.Cmd {
	return exec.Command("tmux", "attach", "-t", sessionName)
}

// AttachSession is provided for completeness — it execs `tmux attach`
// and blocks until the user detaches. Prefer AttachCommand from a
// bubbletea Update via tea.ExecProcess; calling this directly will
// fight the TUI for the terminal.
func AttachSession(name string) error {
	cmd := AttachCommand(name)
	return cmd.Run()
}

// NewSession creates a detached session. env is passed via repeated
// `-e KEY=VALUE` flags; if command is non-empty it's appended as the
// initial command.
func NewSession(name, path string, env map[string]string, command []string) error {
	args := []string{"new-session", "-d", "-s", name}
	if path != "" {
		args = append(args, "-c", path)
	}
	for k, v := range env {
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}
	args = append(args, command...)
	_, err := run(args...)
	return err
}

// projectBasename returns the basename of path, treating "/" specially.
func projectBasename(path string) string {
	path = strings.TrimRight(path, "/")
	if path == "" {
		return "(none)"
	}
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[i+1:]
	}
	return path
}
