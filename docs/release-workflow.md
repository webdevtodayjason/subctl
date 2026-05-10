# Release Workflow

The canonical way to ship subctl changes. Both the laptop and the M3 Ultra
read from the same git history; nothing else.

## Source of truth

- **`VERSION`** (repo root) — the version string. One line. Read by `lib/core.sh`,
  `bin/subctl`, the dashboard, and the master daemon. Do not hardcode versions
  anywhere else.
- **`CHANGELOG.md`** — the human-readable narrative. Every bump in `VERSION`
  needs a matching CHANGELOG section.
- **git history** — the only deploy artifact. There is no rsync, no scp, no
  out-of-band file copy. If a host is missing a change, the answer is always
  "fetch + merge."

## To ship a change

On the dev machine (the laptop):

```bash
# 1. work normally — edit code, run tests
# 2. when ready, decide if it's a version bump
#    - patch (2.0.X) — bug fix, doc tweak, internal refactor with no behavior change
#    - minor (2.X.0) — new tool, new dashboard tab, new CLI verb, new opt-in feature
#    - major (X.0.0) — breaking config, removed tool, dashboard rearrangement,
#                       any user-visible flow change
# 3. if bumping:
echo "2.0.1" > VERSION
$EDITOR CHANGELOG.md   # add a new "## [2.0.1] — YYYY-MM-DD" section above 2.0.0
# 4. commit + push
git add -A
git commit -m "feat(<scope>): <one-line summary>"
git push origin main
```

On every other host (the M3 Ultra, future hosts):

```bash
subctl update
```

That's it. `subctl update` does the rest: fetches, fast-forwards,
re-runs `bun install` where `package.json` changed, bounces launchd
services, runs `subctl doctor`. The output shows `vOLD → vNEW`
plus the commit list.

## When the working tree is dirty on a remote host

`subctl update` refuses to run with uncommitted changes by default. The
options:

- **`--force`** — stashes, updates, restores. Use this when the dirty
  state is junk you don't care about (cache files, log droppings).
- **manual cleanup** — `git stash`, `git checkout -- <files>`, or commit
  the dirty state if it's intentional. Use this when the dirty state is
  real work you don't want to lose.

If `git diff --quiet` reports clean but `subctl update` still complains,
it usually means an untracked file exists. `git status` will show it.

## Bump policy

We follow strict semver:

| Bump  | When                                                   | Examples                                            |
| ----- | ------------------------------------------------------ | --------------------------------------------------- |
| patch | Bug fix; no public API change; no schema change        | Fix LM Studio JIT context reset; correct ANSI strip |
| minor | New feature; backwards-compatible; opt-in              | Add a new master tool; add a new dashboard tab      |
| major | Breaking change; config migration required; removal    | Restructure providers.json; remove a CLI verb       |

If you're not sure, prefer the higher bump. Versions are cheap; surprised
users are not.

## Tagging (optional)

Right now we don't tag every release; the `VERSION` file + CHANGELOG +
git SHA give us everything we need. If we want shareable artifacts
later, add `git tag v$(cat VERSION) && git push --tags` to the workflow.

## Where the version surfaces

- `subctl version` — CLI: prints version + branch + SHA + dirty flag
- dashboard sidebar header — `v{VERSION}` next to the brand name
- master daemon `/health` — `version` field
- `subctl doctor` — header line
- launchd log lines — boot announcement

All four read from the same `VERSION` file. If they ever disagree,
something is stale — re-run `subctl update`.
