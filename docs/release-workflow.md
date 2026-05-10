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

We follow standard 3-digit semver `X.Y.Z`. **Default to patch.** Minor
bumps are reserved for genuine features, not for "this fix added a
file." When in doubt, stay on patch — minor exists for milestones the
operator wants to remember, not for daily deltas.

| Bump  | When                                                   | Examples                                                    |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------- |
| patch (Z) | Bug fix, doc tweak, refactor, internal change, *adding a small file or wiring*, behavior tightening | Fix Docker check, self-heal stale hooks, copy a skill into the repo and wire its install, add a check column to the dashboard |
| minor (Y) | A genuinely new user-visible feature that you'd announce | Master daemon ships, new CLI verb, new dashboard tab, plugin system goes live |
| major (X) | Breaking change; config migration required; removal | Restructure providers.json schema, remove a CLI verb, change auth model |

A patch bump is the default — most days produce 1–5 patch bumps. A
minor bump is rare; major bumps even rarer. Counter-example to avoid:
"I added a new file therefore minor" — no, the file is a leaf detail
of an existing feature, that's a patch.

Pacing examples:

```
2.1.0 → 2.1.1 → 2.1.2 → 2.1.3 → 2.1.4 → 2.1.5    ← five patches in a row, normal
2.1.5 → 2.2.0                                     ← user-visible feature shipped
2.2.0 → 2.2.1 → ... → 2.2.13                      ← back to patches
```

Don't roll-over to a new minor track every time you've shipped 4–5
patches. There's no "5-patch budget" — 2.1.50 is fine if that's how
the work flowed. Roll to minor when it's *meaningful*, not when the
patch counter "looks high."

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
