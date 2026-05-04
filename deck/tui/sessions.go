package tui

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"github.com/webdevtodayjason/subctl/deck/tmux"
)

// projectGroup bundles every session that lives under one project
// (basename of session path), in last-updated-first order.
type projectGroup struct {
	Project     string
	Sessions    []tmux.Session
	LastUpdated time.Time
}

// groupSessions clusters sessions by project basename and orders both
// the groups (most recently updated first) and the sessions within each
// group.
func groupSessions(sessions []tmux.Session) []projectGroup {
	byProject := make(map[string][]tmux.Session)
	for _, s := range sessions {
		byProject[s.Project] = append(byProject[s.Project], s)
	}
	var groups []projectGroup
	for proj, list := range byProject {
		// Sort sessions in this group, newest LastUpdated (or Created) first.
		sort.Slice(list, func(i, j int) bool {
			ti := sessionRecency(list[i])
			tj := sessionRecency(list[j])
			return ti.After(tj)
		})
		groups = append(groups, projectGroup{
			Project:     proj,
			Sessions:    list,
			LastUpdated: sessionRecency(list[0]),
		})
	}
	sort.Slice(groups, func(i, j int) bool {
		return groups[i].LastUpdated.After(groups[j].LastUpdated)
	})
	return groups
}

func sessionRecency(s tmux.Session) time.Time {
	if !s.LastUpdated.IsZero() {
		return s.LastUpdated
	}
	return s.Created
}

// sessionsView renders the entire left rail given a flat session list,
// the currently-selected index in that flat list, and which project
// groups are expanded into per-pane trees.
func sessionsView(sessions []tmux.Session, selected int, expanded map[string]bool, width int) string {
	if len(sessions) == 0 {
		return EmptyHint.Width(width).Render("\nno tmux sessions\n\npress [n] to create one")
	}

	groups := groupSessions(sessions)
	flatIdx := flattenIndex(sessions)

	var b strings.Builder
	for gi, g := range groups {
		// Project group header.
		header := fmt.Sprintf("▾ %s", g.Project)
		if !expanded[g.Project] {
			header = fmt.Sprintf("▸ %s", g.Project)
		}
		if gi > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(ProjectGroupHeader.Render(header))
		b.WriteByte('\n')

		for _, s := range g.Sessions {
			isSel := flatIdx[s.Name] == selected
			b.WriteString(renderSessionRow(s, isSel, width))
			b.WriteByte('\n')
			if expanded[g.Project] && hasWorkerPanes(s) {
				b.WriteString(renderPaneTree(s, width))
			}
		}
	}
	return b.String()
}

// flattenIndex maps each session's name to its index in the flat
// sessions slice (post-grouping it stays the same — group order doesn't
// renumber sessions because the main model holds the canonical flat list).
func flattenIndex(sessions []tmux.Session) map[string]int {
	out := make(map[string]int, len(sessions))
	for i, s := range sessions {
		out[s.Name] = i
	}
	return out
}

// renderSessionRow renders one session as a two-line block:
//
//	● <account>  <ctx>% ctx  <N> panes
//	branch: <branch>     <status>  <relative_time>
func renderSessionRow(s tmux.Session, selected bool, width int) string {
	accentStyle := AccentForAccount(s.Account)
	dot := accentStyle.Render("●")
	account := s.Account
	if account == "" {
		account = "(none)"
	}

	headLine := fmt.Sprintf("  %s %s   %d%% ctx   %d panes",
		dot,
		accentStyle.Render(account),
		s.CtxPct,
		len(s.Panes),
	)

	branch := s.Branch
	if branch == "" {
		branch = "—"
	}
	statusLabel := StatusStyleFor(int(s.Status)).Render(s.Status.String())
	rec := sessionRecency(s)
	recStr := "—"
	if !rec.IsZero() {
		recStr = relativeTimeAgo(rec)
	}
	metaLine := SessionMetaLine.Render(
		fmt.Sprintf("    branch: %s   %s  %s",
			truncate(branch, 30),
			statusLabel,
			recStr,
		),
	)

	if selected {
		return SessionRowSelected.Width(width).Render(headLine + "\n" + metaLine)
	}
	return SessionRow.Render(headLine) + "\n" + metaLine
}

// hasWorkerPanes guesses whether a session is multi-pane in a way worth
// expanding into a tree: more than one pane plus at least one whose
// title or command suggests a worker.
func hasWorkerPanes(s tmux.Session) bool {
	if len(s.Panes) < 2 {
		return false
	}
	for _, p := range s.Panes {
		t := strings.ToLower(p.Title)
		c := strings.ToLower(p.Command)
		if strings.HasPrefix(t, "worker:") || strings.Contains(c, "claude") {
			return true
		}
	}
	return false
}

// renderPaneTree draws the per-pane sub-tree under an expanded session.
func renderPaneTree(s tmux.Session, _ int) string {
	if len(s.Panes) == 0 {
		return ""
	}
	var b strings.Builder
	for i, p := range s.Panes {
		prefix := "├"
		if i == len(s.Panes)-1 {
			prefix = "└"
		}
		title := p.Title
		if title == "" {
			title = p.Command
		}
		// Per-pane status would require a pane-specific capture; for the
		// initial cut we just label active/inactive. The root model can
		// upgrade this later with DetectStatus on each pane's preview.
		state := "idle"
		style := StatusIdle
		if p.Active {
			state = "active"
			style = StatusWorking
		}
		line := fmt.Sprintf("   %s %-22s %s",
			prefix,
			truncate(title, 22),
			style.Render(state),
		)
		b.WriteString(SubPaneRow.Render(line))
		b.WriteByte('\n')
	}
	return b.String()
}

// truncate trims s to max display columns, appending '…' when cut.
// Naive byte truncation is fine for pane titles which are ASCII in practice.
func truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	return s[:max-1] + "…"
}

// indexedSessions returns the sessions reordered so that, when iterating
// in display order (group-sorted), the same flat indices used by the
// root model still resolve to the same session. This is a no-op today
// because the model keeps a flat list and we only group at render time
// — included for future use if we ever flatten post-group.
//
// Kept as a small helper so callers don't have to know about the
// internal grouping.
func indexedSessions(sessions []tmux.Session) []tmux.Session {
	return sessions
}

// _ ensures the indexedSessions helper isn't elided by the compiler in
// case a future caller wants it; declaring an unused function is a vet
// error so we tag it onto a no-op variable.
var _ = indexedSessions

// _styleProbe is here so we keep importing lipgloss; remove if the
// styles package owns all rendering directly.
var _styleProbe = lipgloss.NewStyle()
