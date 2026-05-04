// Package radar ports the read-only signals from lib/radar.sh:
// parallel-session counts, today's rate-limit hits, and best-effort
// detection of which Claude Code session a tmux pane is running.
package radar

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/webdevtodayjason/subctl/deck/tmux"
)

// projectsDirs returns every "$HOME/.claude*/projects" directory that
// actually exists. This mirrors subctl_radar_projects_dirs in bash.
func projectsDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	matches, err := filepath.Glob(filepath.Join(home, ".claude*"))
	if err != nil {
		return nil
	}
	// Glob doesn't match dotfiles consistently across platforms; also
	// add the canonical $HOME/.claude path explicitly.
	matches = append(matches, filepath.Join(home, ".claude"))
	seen := make(map[string]bool)
	var out []string
	for _, m := range matches {
		p := filepath.Join(m, "projects")
		if seen[p] {
			continue
		}
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			out = append(out, p)
			seen[p] = true
		}
	}
	return out
}

// ParallelSessionsCount counts Claude Code session JSONL files modified
// within the last two minutes across all known ~/.claude*/projects dirs.
func ParallelSessionsCount() int {
	cutoff := time.Now().Add(-2 * time.Minute)
	total := 0
	for _, dir := range projectsDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.ModTime().After(cutoff) {
				total++
			}
		}
	}
	return total
}

// rateLimitLogPath returns the path to ~/.claude/rate-limit-events.log,
// or "" if $HOME is unavailable.
func rateLimitLogPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "rate-limit-events.log")
}

// RLHitsToday counts rate-limit events logged today (local TZ).
// Each event is a JSON line; the simple substring check matches the
// bash implementation.
func RLHitsToday() int {
	path := rateLimitLogPath()
	if path == "" {
		return 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	today := time.Now().Format("2006-01-02")
	needle := "\"" + today
	n := 0
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), needle) {
			n++
		}
	}
	return n
}

// SessionAgeSeconds returns the wall-clock age of a Claude Code session
// in seconds, given its UUID. It searches all known projects/ dirs for
// {sessionUUID}.jsonl and parses the first "timestamp" field.
// Returns 0 if the file is missing or the timestamp can't be parsed.
func SessionAgeSeconds(sessionUUID string) int {
	if sessionUUID == "" {
		return 0
	}
	var path string
	for _, dir := range projectsDirs() {
		candidate := filepath.Join(dir, sessionUUID+".jsonl")
		if _, err := os.Stat(candidate); err == nil {
			path = candidate
			break
		}
	}
	if path == "" {
		return 0
	}
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue
		}
		ts, ok := entry["timestamp"].(string)
		if !ok || ts == "" {
			continue
		}
		t, err := parseTimestamp(ts)
		if err != nil {
			continue
		}
		return int(time.Since(t).Seconds())
	}
	return 0
}

// parseTimestamp accepts the few RFC3339-ish shapes Claude Code emits.
func parseTimestamp(s string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
	}
	var lastErr error
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, nil
		} else {
			lastErr = err
		}
	}
	return time.Time{}, lastErr
}

// DetectClaudeCodeSession is a best-effort lookup that maps a tmux
// session (cwd + panes + the session-scoped CLAUDE_CONFIG_DIR) to a
// Claude Code session UUID and a context-window percentage.
//
// Strategy:
//  1. Locate the projects/ dir for the relevant config dir (or scan all).
//  2. Within that dir, find the most-recently-modified jsonl whose first
//     entry's "cwd" matches `cwd` (or whose path contains the project name).
//  3. Read the last usage entry to estimate context %.
//
// Returns ("", 0) when nothing matches.
func DetectClaudeCodeSession(cwd string, panes []tmux.Pane, sessionEnvCfgDir string) (sessionID string, ctxPct int) {
	if !looksLikeClaudeCode(panes) {
		return "", 0
	}
	dirs := candidateProjectsDirs(sessionEnvCfgDir)
	bestPath := ""
	var bestMTime time.Time
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			full := filepath.Join(dir, e.Name())
			if !jsonlMatchesCwd(full, cwd) {
				continue
			}
			if info.ModTime().After(bestMTime) {
				bestMTime = info.ModTime()
				bestPath = full
			}
		}
	}
	if bestPath == "" {
		return "", 0
	}
	uuid := strings.TrimSuffix(filepath.Base(bestPath), ".jsonl")
	ctx := lastCtxPct(bestPath)
	return uuid, ctx
}

// looksLikeClaudeCode is a soft heuristic: any pane whose command or
// title mentions "claude" is enough.
func looksLikeClaudeCode(panes []tmux.Pane) bool {
	for _, p := range panes {
		cmd := strings.ToLower(p.Command)
		title := strings.ToLower(p.Title)
		if strings.Contains(cmd, "claude") || strings.Contains(title, "claude") {
			return true
		}
	}
	return false
}

// candidateProjectsDirs returns the projects/ dirs to search. If
// sessionEnvCfgDir is set we trust it; otherwise scan all of them.
func candidateProjectsDirs(sessionEnvCfgDir string) []string {
	if sessionEnvCfgDir != "" {
		p := filepath.Join(sessionEnvCfgDir, "projects")
		if info, err := os.Stat(p); err == nil && info.IsDir() {
			return []string{p}
		}
	}
	return projectsDirs()
}

// jsonlMatchesCwd reads only the first line and returns true if its
// "cwd" field equals cwd. An empty cwd argument always matches (the
// caller doesn't care which project).
func jsonlMatchesCwd(path, cwd string) bool {
	if cwd == "" {
		return true
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	if !scanner.Scan() {
		return false
	}
	var entry map[string]any
	if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
		return false
	}
	if c, ok := entry["cwd"].(string); ok {
		return strings.TrimRight(c, "/") == strings.TrimRight(cwd, "/")
	}
	return false
}

// lastCtxPct walks the entire jsonl looking for usage entries and
// returns the most recent context-window percentage. Returns 0 on
// any failure.
func lastCtxPct(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1024*1024), 4*1024*1024)
	last := 0
	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue
		}
		// Prefer top-level message.usage when present.
		usage := digUsage(entry)
		if usage == nil {
			continue
		}
		// Total tokens used in this turn — input + cache reads + cache writes.
		var input, cacheRead, cacheCreate float64
		if v, ok := usage["input_tokens"].(float64); ok {
			input = v
		}
		if v, ok := usage["cache_read_input_tokens"].(float64); ok {
			cacheRead = v
		}
		if v, ok := usage["cache_creation_input_tokens"].(float64); ok {
			cacheCreate = v
		}
		total := input + cacheRead + cacheCreate
		// Claude Sonnet/Opus default to a 200K context window; fall back
		// to that if we can't read a richer value out of the entry.
		window := 200000.0
		if w, ok := entry["context_window"].(float64); ok && w > 0 {
			window = w
		}
		if total > 0 && window > 0 {
			last = int((total / window) * 100)
			if last > 100 {
				last = 100
			}
		}
	}
	return last
}

// digUsage hunts for a "usage" map in the few shapes Claude Code's
// jsonl uses (top-level, or nested under "message").
func digUsage(entry map[string]any) map[string]any {
	if u, ok := entry["usage"].(map[string]any); ok {
		return u
	}
	if msg, ok := entry["message"].(map[string]any); ok {
		if u, ok := msg["usage"].(map[string]any); ok {
			return u
		}
	}
	return nil
}
