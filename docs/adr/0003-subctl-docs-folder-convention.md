# 0003: `.subctl/docs/` for project-local team artifacts

- **Status:** Accepted (ships v2.7.10)
- **Date:** 2026-05-12
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.7.10 (pr21)

## Context

Master had no file-write tools. Every directive, spec, handoff, or decision Evy expressed scrolled away in chat. Workers couldn't `cat` a SPEC; they could only see what was already pasted into their context. Operator couldn't inspect the project's directive history without scrolling chat.

When operator and Evy worked on a project together, the SPEC tended to live in the Obsidian vault. Workers couldn't reliably read `~/Documents/` paths due to macOS TCC restrictions. Even when TCC permitted access, the path translation between operator's vault and the worker's project root was a recurring source of confusion ("the SPEC said it was at X, but X doesn't exist on disk").

Three problems compound:

1. Workers can't find the SPEC.
2. Master has no audit trail — directives are ephemeral chat.
3. Operator → Master → Worker handoffs aren't inspectable artifacts.

## Decision

Subctl owns a project-local docs folder at `<project_root>/.subctl/docs/`. Master gets four new tools to read, write, list, and append to it:

- `team_doc_write({ project_root, relative_path, content, frontmatter? })`
- `team_doc_read({ project_root, relative_path })`
- `team_doc_list({ project_root, subdir? })`
- `team_decision_log({ project_root, summary, detail?, by? })`

Standard structure:

```
<project>/.subctl/docs/
├── mandate.md
├── SPEC.md
├── PRD.md
├── ARCH.md
├── decisions.jsonl
└── handoffs/
    └── <date>-<topic>.md
```

`decisions.jsonl` is append-only, machine-readable. Other artifacts are human-readable markdown.

## Reasoning

Three names were considered (see Alternatives). `.subctl/docs/` won because:

- Sits next to `.subctl/policy.toml` (the existing subctl-scoped per-project config). The convention is already established.
- Doesn't fight the project's own `docs/` tree. Many projects already have a `docs/` directory; subctl shouldn't claim it.
- Hidden by default (the dot prefix), so it doesn't clutter `ls` output unless the operator explicitly looks.

Workers can `cat .subctl/docs/SPEC.md` directly. No path translation. No TCC issues — `.subctl/docs/` lives in the project root, which the worker's tmux session already has access to.

Master writes via the new tools instead of using generic Edit/Write because:

- The tools enforce path traversal protection (can't write outside `<project_root>/.subctl/docs/`).
- They handle frontmatter consistently.
- They give the dashboard an inspection surface — every write is an attributable event.

## Consequences

### Positive

- Workers can re-read the SPEC at any point without depending on operator copy-paste.
- Master's directive history becomes inspectable: open `.subctl/docs/handoffs/` and read.
- `decisions.jsonl` provides an append-only audit trail that survives chat clearing or master restarts.
- The folder is gitable — projects that commit `.subctl/docs/` get their team history versioned alongside their code.

### Negative

- Two locations now exist for "project documentation": the project's own `docs/` and `.subctl/docs/`. Operators need to know which is which. The convention: `.subctl/docs/` is for subctl-managed artifacts (mandate, handoffs, decisions). The project's `docs/` is for everything else.
- Path traversal protection adds complexity to the tool implementation. Worth it.

### Open questions

- Should `.subctl/docs/` be gitignored by default or committed by default? Currently leaves it to the project's existing `.gitignore` — neither imposed. Worth revisiting if operators frequently make the wrong choice.

## Alternatives considered

### Alternative A: `api-docs/`

Operator's initial suggestion. Rejected because "api-docs" is loaded with OpenAPI-spec connotations. Putting non-API documentation there creates expectation drift.

### Alternative B: `docs/`

Standard, every project has one. Rejected because it would conflict with projects that already maintain their own `docs/` tree.

### Alternative C: `team-docs/`

Self-describing but verbose, and not aligned with the existing `.subctl/` convention.

### Alternative D: External path under `~/.local/state/subctl/teams/<id>/docs/`

Subctl already stores `policy.snapshot.toml` per team there. Adding docs there would keep them subctl-managed and out of the project tree.

Rejected because workers can't easily access paths outside their project root. The whole point is to make docs `cat`-able from the worker's working directory.

## References

- Worker pr21-team-docs-tools brief
- Related: [ADR 0002](0002-trust-channel-directive-wrapper.md) (directive marker), [ADR 0005](0005-five-tier-memory-architecture.md) (this folder is Tier 5)
- File: `components/master/tools/team-docs.ts` (forthcoming, v2.7.10)
