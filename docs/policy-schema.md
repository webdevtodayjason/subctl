# 02 — Policy Schema Reference

**Status:** Implementation reference. The TOML schema below is the contract between presets, project overrides, and the policy check function.

---

## 1. File locations

Policies are loaded in this priority order (lower number wins):

| Priority | Path | Purpose |
|----------|------|---------|
| 1 | `<project_root>/.subctl/policy.toml` | Per-project override (committed to repo) |
| 2 | `<project_root>/.subctl/policy.local.toml` | Per-project local override (gitignored) |
| 3 | `~/.config/subctl/policy.toml` | Per-user default policy |
| 4 | `<subctl_install>/config/policy/defaults.toml` | Shipped defaults |

Lower numbers override higher numbers field-by-field, not whole-file. A project that wants to add one command to the node preset only needs to declare that addition; the rest of the preset comes from the shipped default.

## 2. Top-level structure

```toml
# What ecosystem preset to inherit from (optional)
preset = "node"

# Default mode when subctl teams <provider> is invoked without --mode
default_mode = "gated"

[mode.trusted]
# nothing to configure; trusted is trusted

[mode.gated]
# overrides and additions to the preset's gated config

[mode.sealed]
# tool list + escalation config for sealed mode
```

## 3. The `[mode.gated]` table — full reference

### 3.1 `allow.commands`

Array of strings. Exact-match command names (the first whitespace-separated token of the proposed command line). No arg checking. Use this for commands that are unconditionally safe regardless of args.

```toml
[mode.gated.allow]
commands = ["pwd", "ls", "cat", "echo", "true", "false"]
```

Be conservative here. Most commands belong in `allow_pattern` with explicit arg constraints.

### 3.2 `allow_pattern` (array-of-tables)

Each entry defines an allowed command + the args it can be called with.

```toml
[[mode.gated.allow_pattern]]
command = "git"
args = ["status", "diff", "log", "show", "add", "commit", "branch", "checkout"]
```

**Semantics:**

- `command` — exact match on the first token
- `args` — the **first non-flag argument** must be in this list. Subsequent args are unrestricted *unless* `deny_if_arg_contains` is set.
- A command with no args matches if `command` matches and `args` is empty or `[""]`

Flag handling: flags (tokens starting with `-`) before the first non-flag arg are ignored for matching purposes. So `git -C /tmp status` matches `command = "git", args = ["status"]`.

### 3.3 `deny_if_arg_contains`

Inline field on an `allow_pattern` entry. If any token in the command contains any string in this list, the command is denied even though the pattern matched.

```toml
[[mode.gated.allow_pattern]]
command = "npm"
args = ["install"]
deny_if_arg_contains = ["--ignore-scripts=false"]
# blocks: npm install --ignore-scripts=false
# allows: npm install
# allows: npm install --save-dev foo
```

Strings are matched as substrings of any single token, not regex.

### 3.4 `deny_always`

Array of patterns that override everything. If any deny pattern matches anywhere in the command line (after normalizing whitespace), the command is denied regardless of allow rules.

```toml
[mode.gated.deny_always]
substrings = [
  "rm -rf",
  "rm -fr",
  ":(){:|:&};:",          # fork bomb
  "dd if=",
  "mkfs",
  "shred",
  "> /dev/sda",
]

regex = [
  '\bcurl\b.*\|\s*(sh|bash|zsh)\b',     # curl pipe to shell
  '\bwget\b.*\|\s*(sh|bash|zsh)\b',     # wget pipe to shell
  '\bnode\s+-e\b',                       # inline node code
  '\bpython3?\s+-c\b',                   # inline python code
  '\bperl\s+-e\b',                       # inline perl
  '\bruby\s+-e\b',                       # inline ruby
  '\bbash\s+-c\b',                       # nested bash -c
  '\bsh\s+-c\b',                         # nested sh -c
]
```

Substrings are case-sensitive, exact substring match. Regex is RE2 syntax (Go-style; no lookbehind). The hook implementation compiles regex once at startup.

### 3.5 Ecosystem-specific tables

Some commands need richer validation than `args` + `deny_if_arg_contains` can express. The schema reserves namespaced tables for these:

#### `[mode.gated.npm]`

```toml
[mode.gated.npm]
allowed_scripts = ["test", "lint", "build", "typecheck", "format"]
# 'npm run X' is denied if X is not in allowed_scripts
# 'npm test' is treated as 'npm run test' for this check
```

The hook reads `<cwd>/package.json` at check time. If the requested script isn't in the package.json's `scripts` table OR isn't in `allowed_scripts`, deny.

#### `[mode.gated.make]`

```toml
[mode.gated.make]
allowed_targets = ["test", "build", "fmt", "lint", "clean"]
```

The hook reads `<cwd>/Makefile` (or `GNUmakefile`) at check time, extracts declared targets, and validates that the requested target is in `allowed_targets`.

#### `[mode.gated.just]`

```toml
[mode.gated.just]
allowed_recipes = ["test", "build", "lint"]
```

Same shape as `make`. The hook runs `just --summary` to enumerate recipes if needed.

#### `[mode.gated.python_modules]`

```toml
[mode.gated.python_modules]
# 'python -m <module>' allowed modules
allowed = ["pytest", "unittest", "build", "pip"]
```

Pairs with a deny in `deny_always` for `python -c` so the only Python execution path through Gated is `python -m`.

## 4. The `[mode.sealed]` table

```toml
[mode.sealed]
mcp_tools = [
  "fs_read",
  "fs_write",
  "fs_list",
  "fs_search",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_log",
  "test_run",
  "pkg_list",
  "policy_request",
]

test_command = "npm test"
# exact string. no interpolation. the test_run tool executes this verbatim.

[mode.sealed.escalation]
# what policy_request does when the worker asks for a one-off command
target = "master"          # | "operator"
require_approval = true    # if false, master decides autonomously
timeout_seconds = 300
```

## 5. JSON Schema for IDE validation

Ship this at `config/policy/schema.json` so editors can validate `policy.toml` files. Truncated for readability; the full schema is generated from the TypeScript types in `lib/policy/types.ts` (see the policy tool family at `components/master/tools/policy/`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Subctl Policy",
  "type": "object",
  "properties": {
    "preset": {
      "type": "string",
      "enum": ["node", "python", "generic", "rust", "go"]
    },
    "default_mode": {
      "type": "string",
      "enum": ["trusted", "gated", "sealed"]
    },
    "mode": {
      "type": "object",
      "properties": {
        "trusted": { "type": "object" },
        "gated": { "$ref": "#/$defs/gatedMode" },
        "sealed": { "$ref": "#/$defs/sealedMode" }
      }
    }
  },
  "$defs": {
    "gatedMode": {
      "type": "object",
      "properties": {
        "allow": {
          "type": "object",
          "properties": {
            "commands": { "type": "array", "items": { "type": "string" } }
          }
        },
        "allow_pattern": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["command"],
            "properties": {
              "command": { "type": "string" },
              "args": { "type": "array", "items": { "type": "string" } },
              "deny_if_arg_contains": { "type": "array", "items": { "type": "string" } }
            }
          }
        },
        "deny_always": {
          "type": "object",
          "properties": {
            "substrings": { "type": "array", "items": { "type": "string" } },
            "regex": { "type": "array", "items": { "type": "string", "format": "regex" } }
          }
        }
      }
    },
    "sealedMode": {
      "type": "object",
      "properties": {
        "mcp_tools": { "type": "array", "items": { "type": "string" } },
        "test_command": { "type": "string" }
      }
    }
  }
}
```

## 6. Merge semantics (worked example)

Project at `~/code/foothold` has `.subctl/policy.toml`:

```toml
preset = "node"

[mode.gated]
[[mode.gated.allow_pattern]]
command = "gh"
args = ["pr", "issue"]

[mode.gated.deny_always]
substrings = ["aws "]
```

The shipped `config/policy/defaults.toml` node preset has 14 `allow_pattern` entries and a `deny_always` block. The resolved policy for the foothold project is:

- All 14 entries from the node preset
- The new `gh` entry from the project
- All `deny_always` entries from the node preset
- Plus the `"aws "` substring from the project

The merge is **additive for arrays** and **field-replacement for scalars**. A project cannot *remove* a deny_always entry from the inherited preset — only add. If a project needs to weaken the preset, it must opt out of the preset entirely by setting `preset = "none"` and declaring its full policy inline. This is intentional: removing a deny should require a deliberate act, not an accidental override.

## 7. Validation behavior

`subctl policy validate [<path>]` (see the `subctl policy` subcommand suite) checks:

1. Document is valid TOML
2. Document is valid against the JSON schema
3. Every regex in `deny_always.regex` compiles
4. Every preset name in `preset` resolves to a shipped file
5. No `allow_pattern.command` appears in `deny_always.substrings` (would always deny)
6. `test_command` is a single command (not a pipeline, not a `&&` chain)

Exit 0 on clean validation, non-zero with a list of issues on stderr.

## 8. Snapshot format

When a worker spawns in Gated mode, the resolved policy is written to:

```
~/.local/state/subctl/teams/<team_id>/policy.snapshot.toml
```

The snapshot file has an additional header:

```toml
# subctl policy snapshot
# team_id    = "foothold-v3"
# spawned_at = "2026-05-11T18:42:13Z"
# mode       = "gated"
# source_paths = [
#   "/Users/jason/code/foothold/.subctl/policy.toml",
#   "/Users/jason/.config/subctl/policy.toml",
#   "/opt/subctl/config/policy/defaults.toml"
# ]
# allowlist_sha = "a3f9c2e1..."
```

The hook reads exclusively from the snapshot. The snapshot is read-only after spawn. The audit log header records the `allowlist_sha` so a deny event can be traced to the exact policy version that produced it.
