package tui

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"
)

// previewModel wraps a viewport.Model with a header line and a footer
// "refreshed Ns ago" hint. It owns no IO of its own — the root model
// pulls capture-pane output and calls SetContent.
type previewModel struct {
	vp           viewport.Model
	headerLabel  string // e.g. "claude-personal"
	headerStyle  lipgloss.Style
	lastRefresh  time.Time
	hasContent   bool
	width        int
	height       int
	emptyMessage string
}

// newPreviewModel constructs a preview pane sized for the initial layout.
func newPreviewModel() previewModel {
	vp := viewport.New(40, 10)
	vp.MouseWheelEnabled = true
	return previewModel{
		vp:           vp,
		headerStyle:  AccentGrey,
		emptyMessage: "no sessions yet\n\npress [n] to create your first session",
	}
}

// SetSize resizes the inner viewport, accounting for the header,
// footer, and border lines we add.
func (p *previewModel) SetSize(width, height int) {
	p.width = width
	p.height = height
	// 2 lines header + 1 line footer + 2 border lines = 5 rows reserved.
	innerH := height - 5
	if innerH < 1 {
		innerH = 1
	}
	innerW := width - 4
	if innerW < 10 {
		innerW = 10
	}
	p.vp.Width = innerW
	p.vp.Height = innerH
}

// SetContent updates the viewport with new pane capture output.
// label is the account alias for the header; accent is its style.
func (p *previewModel) SetContent(label string, accent lipgloss.Style, ansiText string) {
	p.headerLabel = label
	p.headerStyle = accent
	p.lastRefresh = time.Now()
	p.hasContent = ansiText != ""
	p.vp.SetContent(stripCursorMoves(ansiText))
	p.vp.GotoBottom()
}

// View renders the entire preview pane (header + viewport + footer +
// border).
func (p previewModel) View() string {
	if !p.hasContent {
		empty := EmptyHint.Width(p.vp.Width).Render(p.emptyMessage)
		body := lipgloss.Place(p.vp.Width, p.vp.Height, lipgloss.Center, lipgloss.Center, empty)
		return PreviewBorder.Width(p.width - 2).Height(p.height - 2).Render(body)
	}

	header := p.renderHeader()
	footer := p.renderFooter()
	body := lipgloss.JoinVertical(lipgloss.Left, header, p.vp.View(), footer)
	return PreviewBorder.Width(p.width - 2).Height(p.height - 2).Render(body)
}

func (p previewModel) renderHeader() string {
	label := p.headerLabel
	if label == "" {
		label = "preview"
	}
	dashes := strings.Repeat("─", 5)
	return p.headerStyle.Render(fmt.Sprintf("%s %s %s", dashes, label, dashes))
}

func (p previewModel) renderFooter() string {
	if p.lastRefresh.IsZero() {
		return PreviewFooter.Render("refreshed —")
	}
	return PreviewFooter.Render("refreshed " + relativeTimeAgo(p.lastRefresh))
}

// stripCursorMoves removes cursor positioning, screen-clear, and other
// non-color CSI sequences while preserving SGR color/style sequences.
//
//	keep: \x1b[<n>m   (SGR — colors, bold, italic, …)
//	drop: everything else (cursor movement, scroll, erase, mode set, …)
var sgrSeq = regexp.MustCompile(`\x1b\[[0-9;]*m`)
var nonSgrCSI = regexp.MustCompile(`\x1b\[[?]?[0-9;]*[ABCDEFGHJKSTfsu]`)

func stripCursorMoves(s string) string {
	// First squirrel SGR sequences away by replacing them with a placeholder,
	// then strip non-SGR CSI sequences, then restore SGR.
	type repl struct{ idx int; val string }
	matches := sgrSeq.FindAllStringIndex(s, -1)
	stash := make([]repl, len(matches))
	out := s
	// Iterate in reverse so earlier indices stay valid as we mutate.
	for i := len(matches) - 1; i >= 0; i-- {
		m := matches[i]
		stash[i] = repl{idx: m[0], val: out[m[0]:m[1]]}
		out = out[:m[0]] + "\x00SGR" + out[m[1]:]
	}
	out = nonSgrCSI.ReplaceAllString(out, "")
	// Also drop the leftover non-CSI escapes (OSC, etc.) — anything
	// beginning with \x1b that isn't followed by '[' and a color is
	// noise for our preview.
	out = strings.ReplaceAll(out, "\x1b]0;", "")
	out = strings.ReplaceAll(out, "\x1b\\", "")
	// Restore SGR placeholders left-to-right.
	for _, r := range stash {
		out = strings.Replace(out, "\x00SGR", r.val, 1)
	}
	return out
}

// relativeTimeAgo prints a short "Ns ago" / "Nm ago" / "Nh ago" string.
func relativeTimeAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
}
