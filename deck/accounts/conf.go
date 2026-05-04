// Package accounts parses subctl's accounts.conf file.
//
// The file is pipe-delimited with one account per line:
//
//	alias | provider | email | config_dir | description
//
// Whitespace around fields is trimmed; lines starting with '#' and blank
// lines are ignored; tildes in config_dir expand to $HOME.
package accounts

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// Account is one entry in accounts.conf. ConfigDir has had its leading
// tilde expanded to $HOME.
type Account struct {
	Alias       string
	Provider    string
	Email       string
	ConfigDir   string
	Description string
}

// confPath returns the resolved accounts.conf location, honoring
// $SUBCTL_ACCOUNTS_CONF, then $XDG_CONFIG_HOME, then $HOME/.config.
func confPath() string {
	if p := os.Getenv("SUBCTL_ACCOUNTS_CONF"); p != "" {
		return p
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "subctl", "accounts.conf")
}

// expandTilde swaps a leading "~" or "~/" for $HOME. Other tildes are left alone.
func expandTilde(p string) string {
	if p == "" || p[0] != '~' {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

// Load reads the accounts.conf file and returns its entries. A missing file
// is not an error; it returns an empty slice and a nil error.
func Load() ([]Account, error) {
	path := confPath()
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var out []Account
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, "|")
		// Pad to 5 fields; missing trailing fields become empty.
		for len(parts) < 5 {
			parts = append(parts, "")
		}
		alias := strings.TrimSpace(parts[0])
		if alias == "" || strings.HasPrefix(alias, "#") {
			continue
		}
		out = append(out, Account{
			Alias:       alias,
			Provider:    strings.TrimSpace(parts[1]),
			Email:       strings.TrimSpace(parts[2]),
			ConfigDir:   expandTilde(strings.TrimSpace(parts[3])),
			Description: strings.TrimSpace(parts[4]),
		})
	}
	if err := scanner.Err(); err != nil {
		return out, err
	}
	return out, nil
}

// ResolveByConfigDir finds the account whose ConfigDir matches dir.
// Both sides are normalized by trimming any single trailing slash before
// comparing. Returns the account and true on a hit, zero-value and false
// on a miss.
func ResolveByConfigDir(accs []Account, dir string) (Account, bool) {
	want := strings.TrimRight(dir, "/")
	for _, a := range accs {
		if strings.TrimRight(a.ConfigDir, "/") == want {
			return a, true
		}
	}
	return Account{}, false
}

// ClaudeOnly filters accs to just the Anthropic Claude provider entries.
func ClaudeOnly(accs []Account) []Account {
	out := make([]Account, 0, len(accs))
	for _, a := range accs {
		if a.Provider == "" || a.Provider == "claude" || a.Provider == "anthropic" {
			out = append(out, a)
		}
	}
	return out
}
