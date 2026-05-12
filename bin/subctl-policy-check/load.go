// bin/subctl-policy-check/load.go
//
// Snapshot reader. The Go binary owns its own read path so the hook fires
// without spinning up the TS runtime. Same on-disk format the TS writer
// emits — see `components/master/tools/policy/snapshot.ts` (PR 7).
//
// Snapshot file layout (snapshot.ts §buildHeader / §splitHeader):
//
//   # subctl policy snapshot
//   # team_id = "foothold-v3"
//   # spawned_at = "2026-05-11T18:42:00.000Z"
//   # mode = "gated"
//   # source_paths = [
//   #   "/path/to/.subctl/policy.toml",
//   #   ...
//   # ]
//   # allowlist_sha = "a3f9c2e1"
//   <body: a serialized PolicyDocument TOML, no __meta>
//
// Failure mode (pack 07 §3): if the snapshot is missing or unparseable, the
// caller exits 2 and the hook treats that as deny. This file just returns an
// error; main.go does the exit.
//
// Path resolution mirrors snapshot.ts: honor SUBCTL_STATE_DIR if set,
// otherwise ~/.local/state/subctl. The override is critical for tests +
// vector parity runs that don't want to touch the real state dir.

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// SnapshotMetadata mirrors `snapshot.ts:SnapshotMetadata`. We don't currently
// surface every field through the CLI but parsing them defensively means a
// header drift is detected at load time rather than silently ignored.
type SnapshotMetadata struct {
	TeamID       string
	SpawnedAt    string
	Mode         string
	SourcePaths  []string
	AllowlistSha string
	SnapshotPath string
}

// ResolveStateDir returns SUBCTL_STATE_DIR if set, else ~/.local/state/subctl.
// Same precedence as snapshot.ts + audit.ts.
func ResolveStateDir() string {
	if v := os.Getenv("SUBCTL_STATE_DIR"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// Fallback to current dir-relative path; this only happens when
		// HOME is unset, which is exceedingly rare for the hook caller.
		return filepath.Join(".local", "state", "subctl")
	}
	return filepath.Join(home, ".local", "state", "subctl")
}

// GetSnapshotPath returns the canonical snapshot file path for a team.
// Deterministic; no I/O.
func GetSnapshotPath(teamID string) string {
	return filepath.Join(ResolveStateDir(), "teams", teamID, "policy.snapshot.toml")
}

// ReadSnapshot parses the snapshot at `path`. Returns the policy doc + the
// metadata block parsed from the header comments. Errors when the file
// doesn't exist or fails to parse — the caller maps both to exit 2 to honor
// the fail-closed contract (pack 07 §3).
func ReadSnapshot(path string) (*PolicyDocument, *SnapshotMetadata, error) {
	if path == "" {
		return nil, nil, errors.New("snapshot path is empty")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("snapshot read: %w", err)
	}
	return parseSnapshotBytes(data, path)
}

func parseSnapshotBytes(data []byte, path string) (*PolicyDocument, *SnapshotMetadata, error) {
	headerText, bodyText := splitSnapshotHeader(string(data))

	meta, err := parseSnapshotHeader(headerText)
	if err != nil {
		return nil, nil, fmt.Errorf("snapshot header in %s: %w", path, err)
	}
	meta.SnapshotPath = path

	var doc PolicyDocument
	if _, err := toml.Decode(bodyText, &doc); err != nil {
		return nil, nil, fmt.Errorf("snapshot body in %s: %w", path, err)
	}

	// If the body's default_mode is unset, fall back to the header's mode —
	// the spawn-time override is what the hook should honor for the lifetime
	// of this worker.
	if doc.DefaultMode == "" && meta.Mode != "" {
		doc.DefaultMode = meta.Mode
	}

	return &doc, meta, nil
}

// splitSnapshotHeader walks from the top collecting consecutive comment
// lines (with a single blank line tolerated) and returns the header block as
// one string + the body as the remainder. Mirrors snapshot.ts:splitHeader.
func splitSnapshotHeader(text string) (header, body string) {
	lines := strings.Split(text, "\n")
	headerLines := make([]string, 0, 16)
	bodyStart := 0
	for i, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "#") {
			headerLines = append(headerLines, raw)
			bodyStart = i + 1
			continue
		}
		if trimmed == "" && len(headerLines) > 0 && len(headerLines) < 50 {
			// Allow a single blank line between header and body.
			bodyStart = i + 1
			continue
		}
		break
	}
	return strings.Join(headerLines, "\n"), strings.Join(lines[bodyStart:], "\n")
}

// parseSnapshotHeader strips the `# ` prefix from each header line, drops
// the banner, and parses the rest as inline TOML. snapshot.ts emits each
// field in a TOML-compatible form so this round-trips.
func parseSnapshotHeader(headerText string) (*SnapshotMetadata, error) {
	if strings.TrimSpace(headerText) == "" {
		return nil, errors.New("empty header block")
	}

	var sb strings.Builder
	for _, line := range strings.Split(headerText, "\n") {
		stripped := stripCommentPrefix(line)
		if stripped == "" {
			continue
		}
		// Drop the banner line; otherwise it'd fail TOML parsing.
		if strings.TrimSpace(stripped) == "subctl policy snapshot" {
			continue
		}
		sb.WriteString(stripped)
		sb.WriteString("\n")
	}

	type headerShape struct {
		TeamID       string   `toml:"team_id"`
		SpawnedAt    string   `toml:"spawned_at"`
		Mode         string   `toml:"mode"`
		SourcePaths  []string `toml:"source_paths"`
		AllowlistSha string   `toml:"allowlist_sha"`
	}
	var h headerShape
	if _, err := toml.Decode(sb.String(), &h); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}

	if h.TeamID == "" || h.SpawnedAt == "" || h.Mode == "" || h.AllowlistSha == "" {
		return nil, fmt.Errorf("missing required header fields (team_id/spawned_at/mode/allowlist_sha)")
	}
	switch h.Mode {
	case "trusted", "gated", "sealed":
	default:
		return nil, fmt.Errorf("invalid mode %q in header", h.Mode)
	}

	return &SnapshotMetadata{
		TeamID:       h.TeamID,
		SpawnedAt:    h.SpawnedAt,
		Mode:         h.Mode,
		SourcePaths:  h.SourcePaths,
		AllowlistSha: h.AllowlistSha,
	}, nil
}

// stripCommentPrefix removes one leading `#` (and one optional space) from a
// line. Returns the line as-is (sans leading whitespace) if it isn't a
// comment.
func stripCommentPrefix(line string) string {
	ln := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(ln, "#") {
		return ""
	}
	ln = ln[1:]
	if strings.HasPrefix(ln, " ") {
		ln = ln[1:]
	}
	return ln
}

// LoadPresetByName reads a shipped preset directly — used by vectors_test.go
// to run the corpus without spinning up a fake snapshot for each preset.
//
// Resolution: <root>/config/policy/presets/<name>.toml where <root> comes
// from the SUBCTL_INSTALL_ROOT env var (set by the test runner) or, as a
// fallback, walking up from the binary's CWD to find a `config/policy`
// directory. Tests always set the env var so the fallback rarely runs.
func LoadPresetByName(name string) (*PolicyDocument, error) {
	root := os.Getenv("SUBCTL_INSTALL_ROOT")
	if root == "" {
		// Best-effort walk up looking for `config/policy/presets`.
		wd, err := os.Getwd()
		if err == nil {
			cur := wd
			for i := 0; i < 8; i++ {
				if fileExists(filepath.Join(cur, "config", "policy", "presets")) {
					root = cur
					break
				}
				parent := filepath.Dir(cur)
				if parent == cur {
					break
				}
				cur = parent
			}
		}
	}
	if root == "" {
		return nil, fmt.Errorf("could not resolve subctl install root for preset %q", name)
	}
	path := filepath.Join(root, "config", "policy", "presets", name+".toml")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("preset read %s: %w", path, err)
	}
	var doc PolicyDocument
	if _, err := toml.Decode(string(data), &doc); err != nil {
		return nil, fmt.Errorf("preset parse %s: %w", path, err)
	}
	if doc.DefaultMode == "" {
		doc.DefaultMode = "gated"
	}
	return &doc, nil
}
