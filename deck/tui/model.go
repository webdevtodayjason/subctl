package tui

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/webdevtodayjason/subctl/deck/accounts"
	"github.com/webdevtodayjason/subctl/deck/radar"
	"github.com/webdevtodayjason/subctl/deck/tmux"
)

// Version is set by main.go via SetVersion so the header can show it
// without main → tui → main cycles.
var version = "0.0.0"

// SetVersion records the build version used in the header.
func SetVersion(v string) { version = v }

// Model is the root bubbletea model. It owns the full session list,
// the preview viewport, the optional new-session modal, the loaded
// accounts, and any background-fetch error to surface in the footer.
type Model struct {
	sessions []tmux.Session
	selected int
	expanded map[string]bool

	preview previewModel

	newSess  *newSessModel
	accounts []accounts.Account

	width, height int
	err           error
	showHelp      bool

	// Cached signals from the radar package, refreshed alongside sessions.
	parallelSessions int
	rlHitsToday      int
}

// NewModel constructs the root model with empty initial state.
func NewModel() Model {
	return Model{
		expanded: make(map[string]bool),
		preview:  newPreviewModel(),
	}
}

// SnapshotView renders one frame of the model after a single refresh —
// used by `subctl-deck --once` for scripts that want a static dump.
func SnapshotView() string {
	m := NewModel()
	m.width = 100
	m.height = 30
	if accs, err := accounts.Load(); err == nil {
		m.accounts = accs
	}
	sessions, _ := refreshSessionsBlocking()
	m.sessions = sessions
	m.parallelSessions = radar.ParallelSessionsCount()
	m.rlHitsToday = radar.RLHitsToday()
	m.preview.SetSize(60, 28)
	if len(sessions) > 0 {
		m.applyPreviewForSelected()
	}
	return m.View()
}

// Init kicks off the periodic refresh ticker and the first session load.
func (m Model) Init() tea.Cmd {
	return tea.Batch(
		loadAccountsCmd(),
		refreshSessionsCmd(),
		tickCmd(),
	)
}

// Update is the main event loop.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.preview.SetSize(m.previewWidth(), m.contentHeight())
		if m.newSess != nil {
			m.newSess.SetSize(m.width, m.height)
		}
		return m, nil

	case tea.KeyMsg:
		// Modal owns the keystroke when present.
		if m.newSess != nil {
			updated, cmd, done := m.newSess.Update(msg)
			m.newSess = &updated
			if done {
				m.newSess = nil
			}
			return m, cmd
		}
		return m.handleKey(msg)

	case sessionsLoadedMsg:
		m.sessions = msg.sessions
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.err = nil
		}
		if m.selected >= len(m.sessions) {
			m.selected = 0
		}
		m.parallelSessions = radar.ParallelSessionsCount()
		m.rlHitsToday = radar.RLHitsToday()
		m.applyPreviewForSelected()
		return m, nil

	case accountsLoadedMsg:
		m.accounts = msg.accounts
		return m, nil

	case tickMsg:
		return m, tea.Batch(refreshSessionsCmd(), tickCmd())

	case newSessFinishedMsg:
		// After the modal exec completes, refresh.
		if msg.Err != nil {
			m.err = msg.Err
		}
		return m, refreshSessionsCmd()

	case attachFinishedMsg:
		if msg.Err != nil {
			m.err = msg.Err
		}
		return m, refreshSessionsCmd()
	}

	return m, nil
}

// handleKey dispatches the root keymap. The modal-active branch is
// handled in Update before this is reached.
func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "?":
		m.showHelp = !m.showHelp
		return m, nil

	case "r":
		return m, refreshSessionsCmd()

	case "n":
		modal := newNewSessModel(accounts.ClaudeOnly(m.accounts), m.width, m.height)
		m.newSess = &modal
		m.newSess.syncFocus()
		return m, nil

	case "a":
		if len(m.sessions) == 0 {
			return m, nil
		}
		s := m.sessions[m.selected]
		return m, tea.ExecProcess(tmux.AttachCommand(s.Name), func(err error) tea.Msg {
			return attachFinishedMsg{Err: err}
		})

	case "k":
		if len(m.sessions) == 0 {
			return m, nil
		}
		s := m.sessions[m.selected]
		return m, killSessionCmd(s.Name)

	case "j", "down":
		if m.selected < len(m.sessions)-1 {
			m.selected++
			m.applyPreviewForSelected()
		}
		return m, nil

	case "K", "up":
		if m.selected > 0 {
			m.selected--
			m.applyPreviewForSelected()
		}
		return m, nil

	case "space", "enter":
		if len(m.sessions) > 0 {
			proj := m.sessions[m.selected].Project
			m.expanded[proj] = !m.expanded[proj]
		}
		return m, nil

	case "left":
		if m.selected > 0 {
			m.selected--
			m.applyPreviewForSelected()
		}
		return m, nil

	case "right":
		if m.selected < len(m.sessions)-1 {
			m.selected++
			m.applyPreviewForSelected()
		}
		return m, nil
	}

	// Forward to viewport for ↑↓ scroll inside the preview.
	var cmd tea.Cmd
	m.preview.vp, cmd = m.preview.vp.Update(msg)
	return m, cmd
}

// View renders the whole frame.
func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "loading…"
	}

	header := m.renderHeader()
	footer := m.renderFooter()
	body := m.renderBody()

	frame := lipgloss.JoinVertical(lipgloss.Left, header, body, footer)

	if m.newSess != nil {
		// Compose: the modal overlays the body. lipgloss.Place re-pads,
		// so we draw the modal on top of an empty canvas of the same size.
		return m.newSess.View()
	}
	return frame
}

func (m Model) renderHeader() string {
	now := time.Now().Format("15:04")
	left := fmt.Sprintf(" subctl deck   v%s", version)
	right := fmt.Sprintf("%d active · %d RL today · %s ",
		m.parallelSessions,
		m.rlHitsToday,
		now,
	)
	pad := m.width - len(stripStyleHints(left)) - len(stripStyleHints(right))
	if pad < 1 {
		pad = 1
	}
	bar := left + strings.Repeat(" ", pad) + right
	return HeaderStyle.Width(m.width).Render(bar)
}

func (m Model) renderFooter() string {
	keys := "[n] new  [k] kill  [a] attach  [r] ↻  [space] expand  [q] quit"
	if m.err != nil {
		keys = "error: " + m.err.Error()
	}
	return FooterStyle.Width(m.width).Render(keys)
}

func (m Model) renderBody() string {
	leftW := m.leftWidth()
	rightW := m.previewWidth()
	contentH := m.contentHeight()

	left := lipgloss.NewStyle().
		Width(leftW).
		Height(contentH).
		Padding(0, 1).
		Render(sessionsView(m.sessions, m.selected, m.expanded, leftW-2))

	right := lipgloss.NewStyle().
		Width(rightW).
		Height(contentH).
		Render(m.preview.View())

	return lipgloss.JoinHorizontal(lipgloss.Top, left, right)
}

func (m Model) leftWidth() int {
	w := m.width * 40 / 100
	if w < 30 {
		w = 30
	}
	return w
}

func (m Model) previewWidth() int {
	w := m.width - m.leftWidth()
	if w < 30 {
		w = 30
	}
	return w
}

func (m Model) contentHeight() int {
	h := m.height - 2 // header + footer
	if h < 5 {
		h = 5
	}
	return h
}

// applyPreviewForSelected refreshes the preview pane for the currently
// selected session. If there are no sessions, the preview shows its
// empty hint.
func (m *Model) applyPreviewForSelected() {
	if len(m.sessions) == 0 {
		m.preview.SetContent("", AccentGrey, "")
		m.preview.hasContent = false
		return
	}
	if m.selected < 0 || m.selected >= len(m.sessions) {
		m.selected = 0
	}
	s := m.sessions[m.selected]
	var paneID string
	for _, p := range s.Panes {
		if p.Active {
			paneID = p.ID
			break
		}
	}
	if paneID == "" && len(s.Panes) > 0 {
		paneID = s.Panes[0].ID
	}
	content := ""
	if paneID != "" {
		out, _ := tmux.CapturePane(paneID, 200)
		content = out
	}
	m.preview.SetContent(s.Account, AccentForAccount(s.Account), content)
}

// stripStyleHints returns s with ANSI escape sequences elided so we can
// approximate its on-screen width.
func stripStyleHints(s string) string {
	return stripANSI(s)
}

// ─── messages and commands ───────────────────────────────────────────

type sessionsLoadedMsg struct {
	sessions []tmux.Session
	err      error
}

type accountsLoadedMsg struct {
	accounts []accounts.Account
}

type tickMsg time.Time

type attachFinishedMsg struct {
	Err error
}

func tickCmd() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func loadAccountsCmd() tea.Cmd {
	return func() tea.Msg {
		accs, _ := accounts.Load()
		return accountsLoadedMsg{accounts: accs}
	}
}

func refreshSessionsCmd() tea.Cmd {
	return func() tea.Msg {
		sessions, err := refreshSessionsBlocking()
		return sessionsLoadedMsg{sessions: sessions, err: err}
	}
}

func killSessionCmd(name string) tea.Cmd {
	return func() tea.Msg {
		err := tmux.KillSession(name)
		if err != nil {
			return sessionsLoadedMsg{err: err}
		}
		// Force a refresh after killing.
		sessions, rerr := refreshSessionsBlocking()
		return sessionsLoadedMsg{sessions: sessions, err: rerr}
	}
}

// refreshSessionsBlocking pulls the latest session list and enriches
// each entry with panes, account info, branch, status, and (when
// detectable) Claude Code session ID + ctx %.
func refreshSessionsBlocking() ([]tmux.Session, error) {
	sessions, err := tmux.ListSessions()
	if err != nil {
		return nil, err
	}
	accs, _ := accounts.Load()

	for i := range sessions {
		s := &sessions[i]
		panes, _ := tmux.ListPanes(s.Name)
		s.Panes = panes
		s.LastUpdated = time.Now()

		cfgDir := tmux.GetSessionEnv(s.Name, "CLAUDE_CONFIG_DIR")
		if cfgDir != "" {
			if a, ok := accounts.ResolveByConfigDir(accs, cfgDir); ok {
				s.Account = a.Alias
			}
		}
		if s.Account == "" {
			s.Account = "(none)"
		}

		s.Branch = readGitBranch(s.Path)

		// Status from active pane preview.
		var activePaneID string
		for _, p := range s.Panes {
			if p.Active {
				activePaneID = p.ID
				break
			}
		}
		if activePaneID == "" && len(s.Panes) > 0 {
			activePaneID = s.Panes[0].ID
		}
		if activePaneID != "" {
			out, _ := tmux.CapturePane(activePaneID, 200)
			s.Status = DetectStatus(out)
		}

		uuid, ctx := radar.DetectClaudeCodeSession(s.Path, s.Panes, cfgDir)
		s.SessionID = uuid
		s.CtxPct = ctx
	}

	return sessions, nil
}

// readGitBranch tries `git -C path branch --show-current`. Empty result
// for non-git dirs.
func readGitBranch(path string) string {
	if path == "" {
		return ""
	}
	cmd := exec.Command("git", "-C", path, "branch", "--show-current")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
