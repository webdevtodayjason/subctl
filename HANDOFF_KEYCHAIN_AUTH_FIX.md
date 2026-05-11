# Handoff: Claude Code 2.x Keychain auth detection in subctl

**Drafted by:** orchestrator in `claude-semfreak` profile, 2026-05-11
**For:** claude-titanium profile to commit + ship
**Status:** Working-tree changes only, NOT committed

## Problem

`subctl auth claude <alias>` printed misleading remediation:

```
✓ claude-titanium is already authenticated (/Users/sem/.claude-titanium)
  email expected: jbrashear@titaniumcomputing.com
  to re-auth, delete /Users/sem/.claude-titanium/.credentials.json and re-run.
```

But that file doesn't exist. Claude Code 2.x stores OAuth credentials in
**macOS Keychain**, not `.credentials.json`. The 1.x → 2.x migration shifted
the storage backend but subctl's checks + error messages still assumed file-only.

Today on Jason's machine the operative auth path was: `subctl_auth_status`
returned `ready` via the projects/ fallback (his `.claude-titanium/projects/`
has session history), NOT because the credential was actually verified.
Then the re-auth hint hardcoded the file path.

## Investigation

Hash algorithm used by Claude Code for Keychain entries:

```
Default ($HOME/.claude):     "Claude Code-credentials"            (no suffix, legacy)
Other CLAUDE_CONFIG_DIR:     "Claude Code-credentials-<hash>"
  where <hash> = first 8 hex chars of SHA-256(cfg_dir)
```

Verified on Jason's Mac:

| cfg_dir | sha256(cfg_dir)[:8] | Keychain entry found |
|---|---|---|
| `/Users/sem/.claude` | `a3110909` | `Claude Code-credentials` (unsuffixed) |
| `/Users/sem/.claude-titanium` | `7d74e2ba` | `Claude Code-credentials-7d74e2ba` ✓ |
| `/Users/sem/.claude-semfreak` | `4475ac37` | `Claude Code-credentials-4475ac37` ✓ |

## Changes (working tree, not committed)

### `lib/core.sh`

Two new helpers + extended `subctl_auth_status`:

- **`subctl_claude_keychain_service <cfg_dir>`** — outputs the canonical
  Keychain service name for a profile (handles the unsuffixed default case).

- **`subctl_claude_keychain_has_credential <cfg_dir>`** — true if
  `security find-generic-password -s "$svc"` succeeds.

- **`subctl_claude_credential_source <cfg_dir>`** — returns one of
  `file` / `keychain` / `projects` / `none`. Lets callers give a precise
  remediation hint.

- **`subctl_auth_status`** — now checks Keychain FIRST (Claude Code 2.x is
  the current default), then falls back to file/projects (1.x), then Codex.

### `providers/claude/auth.sh`

`provider_claude_auth()`'s "already authenticated" branch now switches on
`subctl_claude_credential_source` and prints the correct remediation:

- `file` → "delete `<cfg_dir>/.credentials.json` and re-run" (1.x)
- `keychain` → `security delete-generic-password -s "<svc>" && subctl auth claude <alias>` (2.x)
- `projects` → flags stale-config-dir; "force re-auth" hint
- `none` → generic "launch claude + /login"

## Diff stats

```
 lib/core.sh              | 49 +++++++++++++++++++++++++++++++++++++++++++++---
 providers/claude/auth.sh | 23 ++++++++++++++++++++++-
 2 files changed, 68 insertions(+), 4 deletions(-)
```

## Smoke test (passes)

```
=== subctl_claude_keychain_service ===
  /Users/sem/.claude            → Claude Code-credentials
  /Users/sem/.claude-titanium   → Claude Code-credentials-7d74e2ba
  /Users/sem/.claude-semfreak   → Claude Code-credentials-4475ac37

=== subctl_claude_credential_source ===
  /Users/sem/.claude-titanium  → keychain
  /Users/sem/.claude-semfreak  → keychain
  /Users/sem/.claude           → keychain

=== subctl_auth_status ===
  /Users/sem/.claude-titanium  → ready
  /Users/sem/.claude-semfreak  → ready
  /Users/sem/.claude           → ready
```

`bash -n` clean on both files.

## To ship (when you can log in)

1. Review the diff: `git diff lib/core.sh providers/claude/auth.sh`
2. Stage + commit: `git add lib/core.sh providers/claude/auth.sh && git commit -m "fix(claude): detect Claude Code 2.x macOS Keychain credentials + precise re-auth hint"`
3. Test against a real `subctl auth claude <alias>` invocation on a known-working
   profile (e.g. claude-titanium). Expected: still prints "already authenticated"
   but now the re-auth hint is the `security delete-generic-password` command.
4. Test against a brand-new profile dir (no projects/, no .credentials.json,
   no Keychain entry). Expected: `subctl_auth_status` returns `empty`, full
   OAuth flow runs.
5. Push + PR.

## Related future cleanup (not in this patch)

- `bin/subctl` lines ~491-506 ALREADY check Keychain correctly in the
  `doctor` command. So `subctl doctor` was already accurate; only the
  `subctl auth claude` flow was wrong. Consistency now restored.
- Consider exposing `subctl_claude_keychain_service` as a public helper
  for tests + diagnostics. Already structured for it.
- **projects/ fallback is a false-positive source.** `subctl_auth_status`
  treats a populated `$cfg_dir/projects/` as `ready` even when no
  credential exists. This masks the "deleted credential, session history
  remains" state. Suggest demoting to a new `stale` status that callers
  can distinguish (`provider_claude_auth` should treat `stale` like
  `empty` and trigger OAuth; `subctl doctor` should flag with a warning).
  Discovered 2026-05-11 when Jason needed to force re-auth on
  claude-titanium and `subctl auth claude` short-circuited despite the
  Keychain entry being stale, because projects/ still had session data.

## Origin

Jason hit this on 2026-05-11 during a "Your authentication token has been
invalidated" debugging session. Root cause was Codex OAuth token rotation
elsewhere, but the misleading subctl message wasted ~15 min of investigation.
Cleaning it up so the next operator's not led down the same wrong remediation.
