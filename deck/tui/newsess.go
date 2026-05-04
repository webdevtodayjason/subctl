package tui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"

	"github.com/webdevtodayjason/subctl/deck/accounts"
)

// modalField is the index of the currently-focused control in the
// new-session form.
type modalField int

const (
	fieldAccount modalField = iota
	fieldFolder
	fieldName
	fieldOrchestrator
	fieldContinue
	fieldSkipPerms
	fieldSubmit

	numFields
)

// newSessModel is the modal that lets the user spin up a new session
// via `subctl teams claude`. It's a self-contained sub-model: the root
// model just feeds it key messages and renders its View.
type newSessModel struct {
	accounts        []accounts.Account
	accountIdx      int
	folder          textinput.Model
	name            textinput.Model
	orchestrator    bool
	continueSession bool
	skipPerms       bool
	field           modalField
	width           int
	height          int
	err             string
}

// newSessFinishedMsg is delivered when the modal is dismissed. If
// Submitted is true, the caller should refresh the sessions list.
type newSessFinishedMsg struct {
	Submitted bool
	Err       error
}

// newNewSessModel builds the modal pre-populated with $PWD as the
// folder and `claude-<basename>` as the name.
func newNewSessModel(accs []accounts.Account, width, height int) newSessModel {
	cwd, _ := os.Getwd()
	folder := textinput.New()
	folder.Placeholder = "/path/to/project"
	folder.Width = 40
	folder.SetValue(cwd)

	name := textinput.New()
	name.Placeholder = "claude-myproject"
	name.Width = 40
	name.SetValue("claude-" + filepath.Base(cwd))

	return newSessModel{
		accounts:        accs,
		folder:          folder,
		name:            name,
		field:           fieldAccount,
		width:           width,
		height:          height,
		continueSession: false,
		skipPerms:       false,
	}
}

// SetSize stashes the latest terminal size for the centered overlay.
func (m *newSessModel) SetSize(width, height int) {
	m.width = width
	m.height = height
}

// Update routes a tea.Msg through the modal. It returns the updated
// model, an optional command, and a `done` flag — when done is true the
// root model should clear its m.newSess pointer.
func (m newSessModel) Update(msg tea.Msg) (newSessModel, tea.Cmd, bool) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, nil, true
		case "tab", "down":
			m.focusNext()
			m.syncFocus()
			return m, nil, false
		case "shift+tab", "up":
			m.focusPrev()
			m.syncFocus()
			return m, nil, false
		case "left":
			if m.field == fieldAccount && len(m.accounts) > 0 {
				m.accountIdx = (m.accountIdx - 1 + len(m.accounts)) % len(m.accounts)
				return m, nil, false
			}
		case "right":
			if m.field == fieldAccount && len(m.accounts) > 0 {
				m.accountIdx = (m.accountIdx + 1) % len(m.accounts)
				return m, nil, false
			}
		case " ":
			switch m.field {
			case fieldOrchestrator:
				m.orchestrator = !m.orchestrator
				return m, nil, false
			case fieldContinue:
				m.continueSession = !m.continueSession
				return m, nil, false
			case fieldSkipPerms:
				m.skipPerms = !m.skipPerms
				return m, nil, false
			}
		case "enter":
			if m.field == fieldSubmit || m.field == fieldName || m.field == fieldFolder {
				cmd, err := m.submitCmd()
				if err != nil {
					m.err = err.Error()
					return m, nil, false
				}
				return m, cmd, true
			}
			m.focusNext()
			m.syncFocus()
			return m, nil, false
		}
	}

	// Forward to the focused textinput.
	var cmd tea.Cmd
	switch m.field {
	case fieldFolder:
		m.folder, cmd = m.folder.Update(msg)
	case fieldName:
		m.name, cmd = m.name.Update(msg)
	}
	return m, cmd, false
}

func (m *newSessModel) focusNext() {
	m.field = (m.field + 1) % numFields
}

func (m *newSessModel) focusPrev() {
	m.field = (m.field - 1 + numFields) % numFields
}

// syncFocus updates the textinputs' visible-cursor state to match m.field.
func (m *newSessModel) syncFocus() {
	if m.field == fieldFolder {
		m.folder.Focus()
	} else {
		m.folder.Blur()
	}
	if m.field == fieldName {
		m.name.Focus()
	} else {
		m.name.Blur()
	}
}

// submitCmd validates the form and returns a tea.Cmd that shells out to
// `subctl teams claude` and reports the outcome via newSessFinishedMsg.
func (m newSessModel) submitCmd() (tea.Cmd, error) {
	folder := strings.TrimSpace(m.folder.Value())
	if folder == "" {
		return nil, fmt.Errorf("folder is required")
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("folder does not exist: %s", folder)
	}
	name := strings.TrimSpace(m.name.Value())
	if name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if len(m.accounts) == 0 {
		return nil, fmt.Errorf("no claude accounts configured (edit ~/.config/subctl/accounts.conf)")
	}

	alias := m.accounts[m.accountIdx].Alias
	args := []string{"teams", "claude", "-a", alias, "-d", folder, "-n", name}
	if m.continueSession {
		args = append(args, "-c")
	}
	if m.skipPerms {
		args = append(args, "-y")
	}
	if m.orchestrator {
		args = append(args, "-o")
	}

	cmd := exec.Command("subctl", args...)
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		return newSessFinishedMsg{Submitted: true, Err: err}
	}), nil
}

// View renders the modal as a centered overlay — the caller is
// responsible for placing it on top of the rest of the UI.
func (m newSessModel) View() string {
	var b strings.Builder
	b.WriteString(ModalLabel.Render("new claude session"))
	b.WriteString("\n\n")

	b.WriteString(m.fieldRow(fieldAccount, "account", m.accountValue()))
	b.WriteString(m.fieldRow(fieldFolder, "folder", m.folder.View()))
	b.WriteString(m.fieldRow(fieldName, "name", m.name.View()))
	b.WriteString(m.fieldRow(fieldOrchestrator, "orchestrator prompt", checkbox(m.orchestrator)))
	b.WriteString(m.fieldRow(fieldContinue, "continue (-c)", checkbox(m.continueSession)))
	b.WriteString(m.fieldRow(fieldSkipPerms, "skip permissions (-y)", checkbox(m.skipPerms)))
	b.WriteString(m.fieldRow(fieldSubmit, "→ create session", ""))

	if m.err != "" {
		b.WriteString("\n")
		b.WriteString(StatusWaiting.Render("error: " + m.err))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(ModalHint.Render("tab/↑↓ next   ←→ cycle account   space toggle   enter submit   esc cancel"))

	body := ModalBorder.Render(b.String())
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, body)
}

func (m newSessModel) fieldRow(f modalField, label, value string) string {
	labelStyle := ModalLabel
	if m.field == f {
		labelStyle = ModalLabelFocus
	}
	return fmt.Sprintf("%s  %s\n", labelStyle.Render(padRight(label, 22)), ModalValue.Render(value))
}

func (m newSessModel) accountValue() string {
	if len(m.accounts) == 0 {
		return "(no accounts found)"
	}
	a := m.accounts[m.accountIdx]
	style := AccentForAccount(a.Alias)
	return style.Render(fmt.Sprintf("◀ %s ▶  %s", a.Alias, a.Email))
}

func checkbox(on bool) string {
	if on {
		return "[x]"
	}
	return "[ ]"
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}
