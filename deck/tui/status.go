package tui

import (
	"regexp"
	"strings"

	"github.com/webdevtodayjason/subctl/deck/tmux"
)

// stripANSI removes SGR color codes, cursor moves, and screen-clear
// sequences so pattern matching can run on plain text.
//
// We strip ALL escape sequences (including SGR) for the purposes of
// status detection — colors don't matter when we're scanning for
// "Do you want to proceed?". The same input is passed through
// stripCursorMoves elsewhere if it's destined for the preview viewport.
var ansiAny = regexp.MustCompile(`\x1b\[[?]?[0-9;]*[ -/]*[@-~]`)

// stripANSI returns s with all CSI escape sequences removed.
func stripANSI(s string) string {
	return ansiAny.ReplaceAllString(s, "")
}

// spinnerRunes are the braille frames used by Claude Code's "thinking" indicator.
var spinnerRunes = []rune{'⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'}

// permissionTells are substrings that indicate a permission/approval prompt.
// We deliberately avoid "(esc to interrupt)" — Claude shows that string while
// it's actively working, so treating it as "waiting" would mislabel every
// busy session. Stick to phrases that only appear on actual approval prompts.
var permissionTells = []string{
	"Do you want to proceed",
	"Do you want to make this edit",
	"Do you want to ",
	"[y/n]",
	"(y/n)",
	"Approve",
	"❯ 1. Yes",
	"❯ 2. No",
}

// workingTells are substrings that mean Claude is computing right now.
var workingTells = []string{
	"thinking…",
	"thinking...",
	"Tool use:",
	"Running…",
}

// idleTells are substrings that suggest the prompt is sitting idle, waiting
// for the user to type something.
var idleTells = []string{
	"\n> ",
	"\n│ > ",
}

// DetectStatus inspects the last ~200 lines of pane preview text and
// classifies the session's state.
//
// Order of precedence: waiting > working > idle > unknown. ANSI escape
// sequences are stripped before pattern matching.
func DetectStatus(panePreview string) tmux.Status {
	if panePreview == "" {
		return tmux.StatusUnknown
	}

	plain := stripANSI(panePreview)
	lines := strings.Split(plain, "\n")
	if len(lines) > 200 {
		lines = lines[len(lines)-200:]
	}
	tail := strings.Join(lines, "\n")

	last10 := lines
	if len(last10) > 10 {
		last10 = last10[len(last10)-10:]
	}
	last10s := strings.Join(last10, "\n")

	// Waiting takes precedence — a pending approval blocks everything else.
	for _, tell := range permissionTells {
		if strings.Contains(tail, tell) {
			return tmux.StatusWaiting
		}
	}

	// Working: spinner glyph or "Tool use:" within the last 10 lines.
	for _, r := range spinnerRunes {
		if strings.ContainsRune(last10s, r) {
			return tmux.StatusWorking
		}
	}
	for _, tell := range workingTells {
		if strings.Contains(last10s, tell) {
			return tmux.StatusWorking
		}
	}

	// Idle: a Claude prompt visible at the end of the pane.
	for _, tell := range idleTells {
		if strings.Contains(tail, tell) {
			return tmux.StatusIdle
		}
	}

	return tmux.StatusUnknown
}
