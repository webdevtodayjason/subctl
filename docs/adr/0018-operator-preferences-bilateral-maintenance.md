# 0018: Operator preferences — bilateral maintenance, structured TOML

- **Status:** Accepted (ships v2.8.1)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.8.1
- **Related:** [ADR 0005](0005-five-tier-memory-architecture.md), [ADR 0014](0014-evy-memory-ts-port-of-memori.md), [ADR 0004](0004-evy-persona-librarian-framing.md)

## Context

By v2.8.0 Evy had three places where "how the operator wants me to
work" could land:

1. **Persona** (`personality.json`) — voice / cadence / refusal style.
   Operator switches presets, but the *content* of a preset is shipped
   in the repo. It's not a knob the operator updates day-to-day.
2. **Evy Memory Tier 3** (`evy.db`, SQLite + FTS5) — full conversation
   record, decisions, captured notes. Searchable but unstructured.
   Setting "actually keep responses shorter from now on" through memory
   means hoping the retrieval surfaces it on every relevant turn.
3. **Policy** (`policy.json`) — autonomy levels per project, escalation
   triggers. Structured but scoped to dev-team conduct, not personal
   preference.

What was missing: a small, structured, **operator-readable** bag of
"how I like to be communicated with / coded for / reported to" knobs
that Evy reads at the start of *every* turn. The operator's exact
framing on 2026-05-13:

> We need to have an operator preferences section that both me and
> the agent can maintain. Examples would be: I prefer audio over
> Telegram versus text, I prefer this coding style, I prefer this
> type of report, et cetera.

Two things had to be decided:

1. **Storage shape** — JSON like `policy.json` and `voice.json`, or
   TOML like `team-templates/*.toml` (v2.8.0).
2. **Write authority** — operator-only, Evy-only, or both.

## Decision

**A bilateral-maintenance TOML preferences file at
`~/.config/subctl/preferences.toml` (chmod 600, dir chmod 700) that
both the operator and Evy write to.**

### Bilateral maintenance

The load-bearing requirement is two-way authorship. Two distinct write
paths land in the same file:

- **Operator** edits directly: dashboard Preferences tab, `subctl
  prefs set …`, `/prefs set …` in Telegram, or `$EDITOR ~/.config/
  subctl/preferences.toml` (the master daemon's fs.watch picks up the
  save automatically — no restart, no manual reload).
- **Evy** writes via the master tool `evy_set_preference({category,
  key, value, reason})` whenever she **learns** a preference in
  conversation. The canonical trigger: operator says "actually keep
  responses shorter," Evy calls the tool with `reason="operator
  said 'keep replies shorter'"`. The next turn's system prompt
  reflects the new value.

A sidecar `preferences.meta.json` records `{by: "operator" | "evy" |
"default", at: ISO8601, reason?}` for every write. This is the audit
trail when the operator looks back and asks "wait, when did this get
set?".

Conflict resolution: last write wins. The structured precedence-or-
voting machinery is rejected as premature. If a stale Evy-set
preference no longer matches what the operator wants, the operator
overwrites it on the next turn — and the `by` field on the meta makes
that visible.

### TOML over JSON

Three reasons preferences.toml uses TOML rather than JSON:

1. **Comments survive.** The seeded file ships with inline guidance
   ("`# telegram | dashboard | both`") explaining the legal values for
   each key. JSON has no comment syntax; the only way to attach prose
   to a JSON key is `_comment` keys that pollute the data and trip up
   strict parsers. Operators edit this file. Comments matter.
2. **Matches v2.8.0 precedent.** `team-templates/*.toml` adopted TOML
   for the same reason. Keeping the operator-facing config files
   homogeneous (TOML) and the daemon-internal files homogeneous (JSON
   — providers.json, profiles.json, voice.json) draws a clean line.
3. **smol-toml is already a dependency.** No new package; just a new
   call site.

To preserve comments **across writes** (smol-toml's `stringify()`
drops comments), `setPreference()` uses a regex-aware merge: locate
the `[category]` header, locate the `key =` line, replace just the
value portion, leave inline comments and surrounding lines untouched.
For new keys we insert at the end of the section; for new categories
we append a new block. This is simpler than wiring a comment-
preserving TOML round-tripper and good enough for the flat-table
schema preferences actually uses. Multi-line strings, arrays, and
nested tables aren't part of the preferences contract and the merger
leaves them alone.

### Schema flexibility

The schema is **not** enforced strictly. The seeded categories are:

- `[communication]` — preferred channel, audio preference, report
  length / cadence
- `[coding]` — style guide, test_first, preferred test runner,
  comment density
- `[reports]` — default format, what to include, end-with-next-action
- `[agent_behavior]` — ask_before_destructive, dispatch_parallel,
  shutdown_idle_workers, loud_when_dry

Operators can add categories at runtime (`/prefs set
project_specific.deploy_window after_5pm_central`) and the system
honors them. Validation is limited to "category and key names match
`^[A-Za-z_][A-Za-z0-9_-]*$`" and "value is a scalar (string, number,
bool)". This trades type safety for the operator's ability to make
the file say whatever they need without us shipping a schema bump.

### Distinct from Tier 3 memory

Preferences are NOT Evy Memory Tier 3 entries. The split:

- **Memory** is the conversation/decision log: free-form, append-only,
  retrievable via FTS5. Good for "what did we decide three weeks ago
  about X?".
- **Preferences** are structured config: keyed, last-write-wins, read
  on every turn. Good for "Evy, default to terse reports."

A note like "operator said keep replies shorter" still lands in memory
when Evy makes the decision to persist it; the *preference itself*
(`reports.report_length = "terse"`) lives in preferences.toml and is
injected into Evy's system prompt every turn via
`renderPreferencesForPrompt()`.

### Distinct from persona

Persona changes voice. Preferences change behavior knobs that the
persona obeys. A persona preset never relaxes safety rules; nor does
a preference. Both layer on top of SKILL.md (the canonical behavioral
contract).

## Consequences

**Wins:**
- Operator gets a structured, edit-in-place config file that's clearly
  documented (inline comments) and clearly authored ("set by:
  operator" / "set by: evy" / "set by: default" badges in the
  dashboard).
- Evy gets a way to persist learned preferences without abusing
  memory.
- The prompt-injection path is one line in `composeSystemPrompt()` —
  every turn sees fresh preferences.
- Four surfaces in lock-step: TOML file, master tool, dashboard tab,
  Telegram `/prefs`, CLI `subctl prefs`. Editing any one updates all
  others on the next read.

**Losses:**
- Two writers + last-write-wins means a busy session where the
  operator and Evy disagree could ping-pong. We accept this; the
  alternative (precedence rules, voting) is premature complexity.
  If it becomes a real problem the operator can pin a key by setting
  `by="operator"` and we add a "evy_can_overwrite" guard later.
- Schema-loose means a typo on `[comunication]` quietly creates a
  parallel category. Mitigation: the dashboard surfaces every
  category, so the operator sees the duplicate immediately.

**Open question:** Should some keys be marked `read_only_for_evy`
once the operator has set them? Today, no. Revisit if the operator
reports Evy overwriting their pinned preferences after a few weeks
of real use.

## Surfaces shipped

- **TOML file:** `~/.config/subctl/preferences.toml` (chmod 600).
  Sidecar `preferences.meta.json` for "set by" metadata.
- **Master tools:** `evy_get_preferences({category?})`,
  `evy_set_preference({category, key, value, reason?})`,
  `evy_get_preference_value({category, key})`.
- **Prompt injection:** `renderPreferencesForPrompt()` runs inside
  `composeSystemPrompt()` before every dispatched turn.
- **Master HTTP:** `GET /preferences`, `GET /preferences/:category`,
  `POST /preferences/:category/:key`, `DELETE …`, `POST
  /preferences/reset`.
- **Dashboard:** `/api/preferences*` proxy + Preferences tab UI.
- **Telegram:** `/prefs`, `/prefs <category>`, `/prefs get
  <cat>.<key>`, `/prefs set <cat>.<key> <value>`, `/prefs reset`.
- **CLI:** `subctl prefs show|get|set|edit|reset`.
