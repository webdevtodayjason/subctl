// Command subctl-deck is a Bubble Tea TUI session manager for tmux
// sessions running Claude Code (and friends). It complements the
// bash-based subctl CLI with a split-pane live view.
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/webdevtodayjason/subctl/deck/tui"
)

// Version is the build version reported by --version. Bump in lockstep
// with the bash subctl release.
const Version = "0.3.0"

func main() {
	var (
		showVersion bool
		showHelp    bool
		once        bool
		debug       bool
	)
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.BoolVar(&showHelp, "help", false, "print help and exit")
	flag.BoolVar(&once, "once", false, "render a single snapshot to stdout and exit")
	flag.BoolVar(&debug, "debug", false, "enable debug logging to stderr")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "subctl-deck — tmux session manager TUI")
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Usage:")
		fmt.Fprintln(os.Stderr, "  subctl-deck            run interactive TUI")
		fmt.Fprintln(os.Stderr, "  subctl-deck --once     print one frame and exit")
		fmt.Fprintln(os.Stderr, "  subctl-deck --version  print version")
		fmt.Fprintln(os.Stderr)
		flag.PrintDefaults()
	}
	flag.Parse()

	tui.SetVersion(Version)

	if showVersion {
		fmt.Println("subctl-deck", Version)
		return
	}
	if showHelp {
		flag.Usage()
		return
	}
	if once {
		fmt.Println(tui.SnapshotView())
		return
	}

	p := tea.NewProgram(tui.NewModel(), tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "subctl-deck error:", err)
		os.Exit(1)
	}
}
