// Package tui contains the bubbletea models that compose subctl-deck's
// terminal UI: the root model, left-rail session list, right-rail
// preview viewport, and the new-session modal.
package tui

import "github.com/charmbracelet/lipgloss"

// Color palette. Centralized so we don't sprinkle magic colors across
// the rest of the package.
var (
	colorCyan     = lipgloss.Color("#5fd7d7")
	colorBlue     = lipgloss.Color("#5f87ff")
	colorMagenta  = lipgloss.Color("#d75fd7")
	colorGrey     = lipgloss.Color("#5f5f5f")
	colorGreen    = lipgloss.Color("#5fd75f")
	colorYellow   = lipgloss.Color("#d7d75f")
	colorOrange   = lipgloss.Color("#ff8700")
	colorRed      = lipgloss.Color("#ff5f5f")
	colorDim      = lipgloss.Color("#7a7a7a")
	colorBright   = lipgloss.Color("#eeeeee")
	colorBorder   = lipgloss.Color("#3a3a3a")
	colorAccent   = lipgloss.Color("#8be9fd")
	colorOverlay  = lipgloss.Color("#1c1c1c")
	colorFootText = lipgloss.Color("#9e9e9e")
)

// Layout-level styles: header bar, footer bar, and the borderless
// content region between them.
var (
	HeaderStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(colorBright).
			Background(colorBorder).
			Padding(0, 1)

	FooterStyle = lipgloss.NewStyle().
			Foreground(colorFootText).
			Padding(0, 1)
)

// Account-color accents. The mapping from alias → color is implemented
// in AccentForAccount below.
var (
	AccentCyan    = lipgloss.NewStyle().Foreground(colorCyan)
	AccentBlue    = lipgloss.NewStyle().Foreground(colorBlue)
	AccentMagenta = lipgloss.NewStyle().Foreground(colorMagenta)
	AccentGrey    = lipgloss.NewStyle().Foreground(colorGrey)
)

// Status labels — colored short strings for working/idle/waiting/unknown.
var (
	StatusWorking = lipgloss.NewStyle().Foreground(colorGreen).Bold(true)
	StatusIdle    = lipgloss.NewStyle().Foreground(colorDim)
	StatusWaiting = lipgloss.NewStyle().Foreground(colorOrange).Bold(true)
	StatusUnknown = lipgloss.NewStyle().Foreground(colorGrey)
)

// Left-rail row styles.
var (
	ProjectGroupHeader = lipgloss.NewStyle().
				Foreground(colorAccent).
				Bold(true).
				MarginTop(1)

	SessionRow = lipgloss.NewStyle().
			Foreground(colorBright)

	SessionRowSelected = lipgloss.NewStyle().
				Foreground(colorBright).
				Background(colorBorder).
				Bold(true)

	SubPaneRow = lipgloss.NewStyle().
			Foreground(colorDim).
			MarginLeft(2)

	SessionMetaLine = lipgloss.NewStyle().
			Foreground(colorDim)
)

// Right-rail and modal frame styles.
var (
	PreviewBorder = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(colorBorder).
			Padding(0, 1)

	PreviewHeader = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true)

	PreviewFooter = lipgloss.NewStyle().
			Foreground(colorDim).
			Italic(true)

	ModalBorder = lipgloss.NewStyle().
			Border(lipgloss.DoubleBorder()).
			BorderForeground(colorAccent).
			Background(colorOverlay).
			Foreground(colorBright).
			Padding(1, 2)

	ModalLabel = lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true)

	ModalLabelFocus = lipgloss.NewStyle().
			Foreground(colorBright).
			Background(colorBlue).
			Bold(true).
			Padding(0, 1)

	ModalValue = lipgloss.NewStyle().
			Foreground(colorBright)

	ModalHint = lipgloss.NewStyle().
			Foreground(colorDim).
			Italic(true)
)

// Empty-state hint shown when there are no tmux sessions.
var (
	EmptyHint = lipgloss.NewStyle().
		Foreground(colorDim).
		Italic(true).
		Align(lipgloss.Center)
)

// AccentForAccount picks an account-color accent style by alias.
// The match is on lowercase substrings, ordered by specificity:
//
//	personal  → cyan
//	work      → blue
//	overflow  → magenta
//	otherwise → grey
//
// Aliases in accounts.conf are user-defined; only the generic role
// keywords are matched here so the binary stays free of any specific
// host or username.
func AccentForAccount(alias string) lipgloss.Style {
	a := lowerASCII(alias)
	switch {
	case contains(a, "personal"):
		return AccentCyan
	case contains(a, "work"):
		return AccentBlue
	case contains(a, "overflow"):
		return AccentMagenta
	default:
		return AccentGrey
	}
}

// StatusStyleFor maps a status int to one of the StatusXxx styles.
// Imported as int so the styles file doesn't depend on tmux.Status.
func StatusStyleFor(status int) lipgloss.Style {
	switch status {
	case 1:
		return StatusIdle
	case 2:
		return StatusWorking
	case 3:
		return StatusWaiting
	default:
		return StatusUnknown
	}
}

// lowerASCII is a tiny strings.ToLower that avoids the import for one call.
func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
