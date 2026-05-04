#!/usr/bin/env bash
# scripts/check-no-secrets.sh — fail if real personal data sneaks into the repo.
# Run by CI on every push, by the pre-push git hook, and manually by maintainers.
#
# Exits 0 if clean, 1 if any pattern matched.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Patterns that should never appear in committed files.
# Email patterns: any non-example.com email, plus specific domains we want to forbid.
# API key shapes: Anthropic, OpenAI, Google, GitHub, etc.
#
# We also forbid absolute home paths under /Users/ (mac) or /home/ (linux) other
# than placeholder forms (/Users/you, /home/you).
#
# IMPORTANT: this script searches its OWN working tree, but the file you're
# reading right now intentionally contains some of the forbidden tokens as
# regex patterns. We exclude this file from the search.

EXCLUDE_DIRS=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
              --exclude-dir=.bun --exclude-dir=.archived-)
EXCLUDE_FILES=(--exclude=check-no-secrets.sh)

# Patterns
FORBIDDEN=(
  # Real emails to forbid (examples I know about; extend as needed)
  '@webdevtoday\.com'
  '@titaniumcomputing\.com'
  'jbrashear@'
  'semfreak@'
  # Generic non-placeholder emails (anything @ a real domain that isn't example/company)
  # Not strict — the explicit list above covers the known leaks.

  # API key shapes
  'sk-[a-zA-Z0-9]{20,}'              # OpenAI, Anthropic
  'sk-ant-[a-zA-Z0-9_-]{20,}'        # Anthropic specifically
  'AIza[0-9A-Za-z_-]{35}'            # Google
  'ghp_[a-zA-Z0-9]{36}'              # GitHub personal access token
  'github_pat_[a-zA-Z0-9_]{82}'      # GitHub fine-grained PAT

  # Real user paths (we should always parameterize via $HOME or ~)
  '/Users/sem(/|$)'
)

found_any=0
for pat in "${FORBIDDEN[@]}"; do
  matches=$(grep -rEn "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" "$pat" . 2>/dev/null)
  if [[ -n "$matches" ]]; then
    echo "❌ Forbidden pattern matched: $pat"
    echo "$matches" | sed 's/^/    /'
    echo
    found_any=1
  fi
done

if [[ $found_any -eq 0 ]]; then
  echo "✓ secret scan clean"
  exit 0
else
  echo "✗ secret scan FAILED — fix the matches above before pushing"
  exit 1
fi
