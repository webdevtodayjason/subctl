# Hermes — Compact + Skill-Loading Mechanism Findings

**Researched by:** hermes-researcher
**Date:** 2026-05-27
**Source:** `/Users/sem/code/hermes-agent` @ commit `e8955f222cecb6ed7ac3f0c541b9b5b02d22843f`

---

## TL;DR for the operator

- **Compact is LLM-driven summarization, not eviction.** Hermes uses an
  auxiliary cheap-model call to produce a structured summary of the middle
  turns, plus a cheap pre-pass that prunes old tool outputs *before* the LLM
  call. Head + tail are preserved verbatim; the middle is replaced by one
  summary message; the session row in SQLite is rotated (old session ended,
  new child session created) so lineage is preserved.
- **Skill loading is LLM-driven selection over a system-prompt index.** Every
  installed skill's `name + description` is folded into the system prompt
  under a `## Skills (mandatory)` block; the model is instructed to call
  `skill_view(name)` whenever a skill looks even partially relevant. The
  full SKILL.md body returns as a tool result and stays in the conversation
  thereafter. There is NO embeddings/classifier/regex layer in front of
  the model — the model itself is the router. Substring matching only
  exists for the *deterministic* `/skill-name` slash command surface.
- **There is no "approaching threshold" detection.** Hermes fires *at* the
  threshold (default 50% of context window), using the real `prompt_tokens`
  from the previous API response. The illusion of "approach" comes purely
  from setting the threshold low enough to leave headroom — which is
  exactly what Jason's "+30k bump" knob would tune.

---

## 1. Compact mechanism

### 1.1 Token thresholds

- Where the threshold is defined:
  - Config plumbing — `agent/agent_init.py:1220` reads
    `compression.threshold` from `config.yaml`, default **0.50** (50% of
    context window).
  - Hard floor — `agent/model_metadata.py:133`
    `MINIMUM_CONTEXT_LENGTH = 64_000`. Threshold is clamped via
    `max(int(ctx * threshold_percent), MINIMUM_CONTEXT_LENGTH)` at
    `agent/context_compressor.py:553-556`.
  - Per-model override — `agent/auxiliary_client.py:227-239`
    `_compression_threshold_for_model(model)` lets specific model families
    bump it (e.g. Arcee Trinity Thinking → 0.75).
- Current value: **`min(0.50 × model_context_length, 64_000)`** as a
  computed floor. For a 200K-context model that's 100K tokens; for a 64K
  model it's 64K (the minimum).
- Tunable via:
  - `compression.threshold` (float 0–1) in `config.yaml` — primary knob.
  - `compression.enabled` (bool) — kill switch (default `true`).
  - `compression.target_ratio` (float) — controls tail+summary token
    budget after compression (default 0.20).
  - `compression.protect_first_n`, `compression.protect_last_n` — head
    and tail preservation counts (defaults 3 and 20).
  - `compression.abort_on_summary_failure` (bool) — when `true`, a failed
    aux summarisation aborts compression entirely instead of inserting a
    static placeholder (default `false` for back-compat).
  - `auxiliary.compression.model` / `auxiliary.compression.context_length`
    — pick the cheap summariser model and (optionally) override its
    advertised context window.

### 1.2 Pre-flight compact step

- File(s): `agent/conversation_loop.py:498-564`.
- What it does: At the very top of `run_conversation()`, before entering
  the tool-calling loop, it estimates the size of the *loaded* conversation
  history (`estimate_request_tokens_rough(messages, system_prompt, tools)`
  — explicitly includes tool-schema tokens, which can add 20–30K in
  many-tool sessions). If that estimate already trips
  `should_compress`, it runs up to **3 successive compression passes**
  before the first model call, breaking out when either no further
  messages can be removed or the estimate drops below the threshold.
- When it fires: At the start of every `run_conversation()` call,
  guarded by `len(messages) > protect_first_n + protect_last_n + 1`.
- Inputs / outputs: Takes the rehydrated message list + system prompt +
  tools. Outputs the compressed message list and freshly-built system
  prompt; resets per-turn retry counters
  (`agent/conversation_loop.py:552-556`) so post-compression behavior
  doesn't inherit pre-compression failure state. Note: this is the *same*
  algorithm as the main compact — it's a preflight *trigger*, not a
  separate code path.

### 1.3 Main compact

- File(s):
  - `agent/conversation_compression.py:251-482` — `compress_context()`,
    the orchestration entry point (called from agent via
    `_compress_context`).
  - `agent/context_compressor.py:1495-…` — `ContextCompressor.compress()`,
    the actual algorithm.
  - `agent/context_compressor.py:914-…` — `_generate_summary()`, the LLM
    call.
- Algorithm (cited from `compress()` docstring at
  `agent/context_compressor.py:1495-1516` plus the implementation):
  1. **Phase 1 — Pre-pass pruning, no LLM.** Replace contents of old
     `tool` messages with a 1-line informative summary
     (`[terminal] ran 'npm test' -> exit 0, 47 lines output`). Implemented
     at `agent/context_compressor.py:640+` (`_prune_old_tool_results`).
     Also strips image parts from old multimodal messages
     (`_strip_image_parts_from_parts`, `agent/context_compressor.py:153`).
  2. **Phase 2 — Boundary detection.** Protect head (system prompt +
     `protect_first_n` non-system messages — `_protect_head_size`,
     `agent/context_compressor.py:1309+`). Find tail boundary by
     **token budget** rather than message count
     (`_find_tail_cut_by_tokens`, `agent/context_compressor.py:1413+`),
     defaulting to `tail_token_budget = threshold * summary_target_ratio`
     (~20% of threshold).
  3. **Phase 3 — LLM summarisation.** Send the middle turns
     (`turns_to_summarize`) to the auxiliary model with a structured
     template prompt at `agent/context_compressor.py:946-1090+`. Sections:
     `## Active Task`, `## Goal`, `## Constraints & Preferences`,
     `## Completed Actions`, `## Active State`, `## In Progress`,
     plus resolved/pending questions and remaining work. Iterative
     updates: if a prior summary exists, the prompt asks the model to
     *update* it rather than re-summarize from scratch
     (`_previous_summary` field).
  4. **Phase 4 — Assemble.** Compressed list = head + a single summary
     message (role chosen to avoid same-role collisions with neighbors,
     `agent/context_compressor.py:1663-1683`) + tail. A `SUMMARY_PREFIX`
     banner at `agent/context_compressor.py:37-51` tells the model the
     summary is reference-only and that MEMORY/USER files in the system
     prompt remain authoritative.
- When it fires relative to pre-flight: Pre-flight runs once before the
  first API call of a turn; the main compact runs **after every successful
  tool-calling iteration** at `agent/conversation_loop.py:3636-3663` (using
  real `last_prompt_tokens` from the API response, falling back to a
  rough estimate if missing per `#2153`). Recovery compact also runs
  inline when an API error is classified as context-overflow
  (`agent/conversation_loop.py:2499-2520`, retry loop limited by
  `max_compression_attempts`).
- What gets preserved vs dropped:
  - **Preserved verbatim:** system prompt, first `protect_first_n` non-
    system messages, the tail messages up to `tail_token_budget`.
  - **Replaced by structured summary:** everything in between.
  - **Dropped from tool messages:** raw outputs older than the tail
    window, replaced by 1-line summaries.
  - **Dropped from images:** image parts in old turns are replaced by
    `[screenshot removed to save context]`.
  - **Special case — abort:** if `compression.abort_on_summary_failure`
    is `true` and the LLM call fails, nothing is dropped; the original
    messages are returned unchanged and the agent surfaces a warning.
  - **Special case — anti-thrash:** if the last two compressions each
    saved < 10%, `should_compress` returns `false` regardless of token
    count (`agent/context_compressor.py:614-634`). Caller is nudged
    toward `/new` or `/compress <focus>`.

### 1.4 How "approaching threshold" is detected

- **Hermes does not detect "approaching".** It detects "at-or-past" using
  the real prompt_tokens from the most recent API response.
- Polling loop / event / hook: It's **inline** at the bottom of each
  successful tool-call iteration in `agent/conversation_loop.py:3636-3663`.
  The decision is `_compressor.should_compress(_real_tokens)`; if true,
  `_compress_context` runs synchronously before the next iteration.
- File(s):
  - Decision function: `agent/context_compressor.py:614-634`
    (`should_compress`).
  - Token source priority: `last_prompt_tokens` from API usage (preferred)
    → rough estimate including tool schemas (fallback). The
    completion/reasoning tokens are deliberately excluded
    (`#12026` — thinking models inflate them).
  - Preflight check site: `agent/conversation_loop.py:518`.
  - Post-turn check site: `agent/conversation_loop.py:3653`.
  - Recovery (on context-overflow API error): `agent/conversation_loop.py:2499-2520`.
- Notably absent: there's no background timer, no "we're at 80% of
  threshold so soft-warn" mechanism, no listener pattern. The "approach"
  buffer is the gap between `threshold_tokens` and `context_length` —
  set conservatively at 50% so that even after a sizeable next turn, the
  request still fits.

### 1.5 Implementation notes for Evy

#### v3 Evy (TypeScript)

Files to touch:
- `components/evy/compact-policy.ts` — already implements warn/compact
  absolute-token thresholds (`warn_tokens` / `compact_tokens`). For the
  "+30K bump" ask: just raise the defaults (e.g. `warn=55_000`,
  `compact=70_000` from the current `25_000` / `40_000`) and bump the
  back-compat `threshold_pct` ceiling alongside.
- The pre-flight + auto-compact-on-approach wiring lives in whatever
  module composes the next-turn prompt and calls into the Hermes-style
  estimator. Inspect `components/evy/` for the call site that consumes
  `CompactPolicyDecision` — that's the point to honor `warn` vs `compact`
  and to invoke the summariser early. (Out of scope for this research:
  Jason confirmed the v3 changes are his to wire.)

Rough plan:
1. Bump `DEFAULT_WARN_TOKENS` / `DEFAULT_COMPACT_TOKENS` (or whatever the
   constants are named) by 30K each.
2. Add an "approach" trigger by making the warn-rule action be
   *summarize* (today it's just a warning). The summarisation routine
   already exists somewhere in v3; lift it to fire on warn rather than
   only on compact. That gives the same behavioral envelope as Hermes:
   compact at threshold, but the "threshold" is intentionally below the
   hard ceiling.

#### v4 Evy (Rust)

Files to touch:
- New module (or extension) in `crates/evy-thinking/src/` — most naturally
  next to `session.rs` / `partner.rs`, since those manage the turn loop.
- Constants for token thresholds go in `evy-thinking` (the consumer
  decides the budget); `evy-skills` is the wrong layer.

Rough plan:
1. Define a `CompactPolicy` struct mirroring v3's
   `CompactPolicyDecision`: `warn_tokens`, `compact_tokens`,
   `threshold_pct` (back-compat), and an `evaluate(prompt_tokens, loaded_ctx)`
   method returning `Ok | Warn | Compact`.
2. Add a Rust port of the prune-old-tool-results pre-pass (no LLM) — this
   alone buys multi-kilobyte savings for free.
3. The LLM summariser call belongs in `evy-thinking::partner` (it's a
   model call) with the structured template from
   `agent/context_compressor.py:946-1090+` ported as a Rust raw-string
   constant.
4. Plumb the decision into the session loop after each successful turn —
   mirror Hermes's "use real prompt_tokens from response, fallback to
   rough estimate" pattern.

Hermes ports cleanly because the algorithm is conceptually small:
prune → boundary → summarise → reassemble. The complexity in Hermes is
all in edge cases (image shrinking, anti-thrash, aux model fallback,
session-DB rotation) — none of which v4 Evy has equivalents for yet.

---

## 2. Skill loading mechanism

### 2.1 Where skills live

- Filesystem location: `~/.hermes/skills/<category>/<skill-name>/SKILL.md`
  — anchored at `SKILLS_DIR = HERMES_HOME / "skills"`
  (`tools/skills_tool.py:90-91`). External skill directories also
  supported via `skills.external_dirs` config (read-only, queried in
  `agent/prompt_builder.py:1106-1156`).
- File format: Markdown with YAML frontmatter
  (`tools/skills_tool.py:28-50`).
- Frontmatter / metadata fields (`tools/skills_tool.py:28-46`):
  - `name` (required, ≤64 chars)
  - `description` (required, ≤1024 chars)
  - `version` (optional)
  - `license`, `platforms`, `prerequisites.env_vars`,
    `prerequisites.commands`, `compatibility`
  - `metadata.hermes.tags`, `metadata.hermes.related_skills`,
    `metadata.hermes.config` (skill-declared config keys with defaults).
- Each skill dir may carry `references/`, `templates/`, `scripts/`,
  `assets/` subdirs; those are advertised as "supporting files" in the
  loaded message and fetched on demand via `skill_view(name, file_path)`
  (`agent/skill_commands.py:236-250`).
- Plugin-provided skills live under `plugins/<plugin>/skills/` and are
  loaded with the namespaced form `plugin:skill-name`
  (`tools/skills_tool.py:743+`).

### 2.2 How Hermes recognizes "this turn needs a skill"

- **Detection signal:** LLM-driven via system-prompt injection. The model
  itself is the router — there is no embeddings layer, no rule engine,
  no intent classifier in front of it.
- File(s):
  - System-prompt assembler: `agent/system_prompt.py:169-185`. When any
    of `skills_list`, `skill_view`, `skill_manage` is in `valid_tool_names`,
    Hermes appends `build_skills_system_prompt(...)` output to the
    stable prompt parts.
  - Index builder: `agent/prompt_builder.py:983-1214`
    (`build_skills_system_prompt`). Walks the skills tree, builds a
    `category → [(name, description)]` map, and renders it under a
    `## Skills (mandatory)` block (`agent/prompt_builder.py:1178-1205`).
  - The mandatory-skills wording explicitly tells the model to "scan the
    skills below" and "load it with `skill_view(name)`" even if it
    *thinks* it could handle the task without one
    (`agent/prompt_builder.py:1180-1204`).
- Cost (per turn): **Zero extra per-turn cost beyond the cached system
  prompt tokens.** The skill index is part of the system prompt, which
  enjoys provider prefix caching (Anthropic/OpenAI). Hermes adds
  belt-and-braces caching:
  - In-process LRU keyed by `(skills_dir, tools, toolsets, platform,
    disabled)` (`agent/prompt_builder.py:1017-1029`).
  - Disk snapshot validated by mtime/size manifest
    (`.skills_prompt_snapshot.json`, `agent/prompt_builder.py:1031-1104`).
- Two additional non-LLM surfaces also exist:
  - **Slash commands** (`/skill-name`) — deterministic user-typed
    invocation. `agent/skill_commands.py:263-326` scans the disk for
    `SKILL.md` files and registers each as a slash command;
    `agent/skill_commands.py:428-472` builds the user message.
  - **Channel-bound auto-skills** — gateway can config-bind a skill to a
    chat channel/topic so new sessions in that channel auto-prepend the
    skill to the first message
    (`gateway/platforms/base.py:1449-1501`, `gateway/run.py:8337-8371`).

### 2.3 How a skill is selected

- Matching algorithm: **The LLM picks.** It reads the system-prompt
  skill index and emits a `skill_view(name="…")` tool call. There is no
  scoring inside Hermes for the autonomous path.
- File(s): The selection happens entirely in the model's response stream;
  Hermes only validates / serves the result (`tools/skills_tool.py:850+`,
  `skill_view`).
- Tie-breaking: N/A — only the LLM is choosing. For the *deterministic*
  surfaces (slash commands, channel bindings), name uniqueness is
  enforced by the registry: first-match-wins by alphabetical scan order,
  with local dir taking precedence over external dirs
  (`agent/skill_commands.py:284-323`).

### 2.4 How a skill is applied to the conversation

- Mechanism (**three distinct paths**):
  1. **LLM-driven (the autonomous case).** Model calls `skill_view(name)`;
     `tools/skills_tool.py:850+` returns JSON `{ success, name, content,
     description, linked_files, skill_dir, … }`. The full SKILL.md body
     lands as a normal tool result in the conversation. The next model
     turn sees the skill content in the tool_result message, then
     "follows its instructions" because that's what the system-prompt
     contract says to do.
  2. **Slash-command driven.** User types `/skill-name [user-instruction]`.
     `agent/skill_commands.py:428-472` builds a `_build_skill_message`
     payload that injects an activation note + the full skill body + a
     `[Skill directory: …]` block + resolved config + supporting-file
     hints. That payload is sent as the user's next message
     (`agent/skill_commands.py:160-260`).
  3. **Channel-bound auto-load.** On the first message of a new session
     in a bound channel, the gateway prepends the same
     `_build_skill_message` payload to the user's text
     (`gateway/run.py:8337-8371`). One-shot — subsequent messages in the
     same session don't re-inject because the content is already in
     history.
- File(s) (in addition to those cited):
  - Preprocessing — template var substitution (`${HERMES_SKILL_DIR}`,
    `${HERMES_SESSION_ID}`) and optional inline-shell expansion
    (`!`cmd`` substitution) happen in `agent/skill_preprocessing.py`,
    gated by `skills.template_vars` / `skills.inline_shell` config
    (`agent/skill_preprocessing.py:23-34`, `:101-138`).
  - Skill bundles (multi-skill aliases) live in `agent/skill_bundles.py`
    — YAML files at `~/.hermes/skill-bundles/*.yaml` map one slash
    command to N skills; the bundle invocation message concatenates
    every member's `_build_skill_message` output under a single header
    (`agent/skill_bundles.py:253-340`).
- Persistence: **Skill content stays in the conversation history.** No
  explicit unload step. It naturally falls into the "middle" window and
  gets summarised on the next compact — meaning a heavily-loaded skill
  can be replaced by its summary later, which is a feature (token
  reclamation) and a hazard (instructions get paraphrased away). The
  `SUMMARY_PREFIX` warns the model that summarised content is
  reference-only and not active instructions, which mitigates but does
  not eliminate the issue.

### 2.5 Implementation notes for Evy v4

- Which crate gets extended: **both**, with a clean split.
  - `evy-skills` already owns the registry, the skill model
    (`skill.rs`), and a substring-match router (`router.rs`). That's the
    deterministic surface — keep it.
  - `evy-thinking` should own the *autonomous* loader: turn the registry
    into a system-prompt index and feed it to the model, mirroring
    Hermes's `build_skills_system_prompt`.
- What's already in place:
  - `crates/evy-skills/src/router.rs:1-60+` — substring matcher with a
    composite score (`triggers + description + priority/10`),
    descending sort, alphabetical tie-break. Docstring already calls out
    a Phase-5 swap to embeddings, but Hermes's lesson says **don't
    bother** — the LLM is a better-and-cheaper router than embeddings
    for this use case as long as the index fits in the system prompt
    cache.
  - `crates/evy-skills/src/registry.rs` — disk loader.
- What needs to be added:
  1. **System-prompt index renderer** in `evy-thinking` (mirrors
     `agent/prompt_builder.py:983-1214`). Pulls the registry from
     `evy-skills` and emits the same kind of `## Skills (mandatory)`
     block with category grouping. Cache it the way Hermes does — at
     minimum an in-process LRU keyed by registry mtime.
  2. **`skill_view` tool** wired into whatever tool-dispatch surface
     `evy-thinking` exposes. Returns the rendered SKILL.md body the same
     way Hermes does, including supporting-file hints if you have
     analogues to `references/` / `templates/` / `scripts/`.
  3. **The mandatory-skills wording** from
     `agent/prompt_builder.py:1178-1205` is load-bearing. The model
     defaults to *not* loading skills unless instructed clearly that
     loading is the expected behavior. Port that prompt verbatim (or
     close to it) — don't paraphrase it shorter.
  4. **Keep the existing substring router** as a deterministic side
     channel for explicit dispatch (the equivalent of slash commands).
     Don't tear it out — Hermes keeps both.
- Rough implementation outline:
  1. Add `render_skill_index(&SkillRegistry) -> String` to `evy-skills`
     so the formatter lives next to the data model. Have `evy-thinking`
     call it once at session start and feed the result into the system
     prompt.
  2. Add a `SkillTool` impl in `evy-thinking` (or wherever tools live)
     that takes `{ name: String }` and returns the SKILL.md body.
     Validate the name against the registry — refuse to serve arbitrary
     paths (Hermes hardens this with `_outside_skills_dir` checks at
     `tools/skills_tool.py:1083`).
  3. Run an integration test: assert that when the user asks for
     something a skill is about, the model emits a `skill_view` tool
     call. (Hermes doesn't have a unit test for this — they rely on the
     model + system prompt instruction. Worth doing one for v4 to lock
     in the contract.)

---

## 3. Open questions / gotchas

- **The "approach" semantics are operator-side.** Hermes fires AT the
  threshold; the buffer between threshold and ceiling is the "approach
  zone." Jason's "+30K bump and auto-compact-on-approach" maps cleanly to
  "raise warn_tokens and have warn *also* fire compact." Worth confirming
  whether the v3 ask is (a) raise the absolute thresholds, or (b) add a
  genuinely new "approach" event that fires below the existing
  warn_tokens. The Hermes design supports (a) trivially and (a) is what
  it does in practice; (b) would be net-new.
- **Compact in Hermes mutates session DB state.** It ends the current
  session row and creates a new child session in SQLite
  (`agent/conversation_compression.py:375-410`). Evy may or may not have
  an equivalent session-store contract; if it does, plan the rotation
  semantics up front. If it doesn't, this can be a no-op port.
- **Aux model failure is a real failure mode.** Hermes added
  `abort_on_summary_failure` and a 600s cooldown
  (`_SUMMARY_FAILURE_COOLDOWN_SECONDS`,
  `agent/context_compressor.py:76`) because production users hit
  scenarios where summarisation silently inserted "context unavailable"
  placeholders. Decide your default early — Hermes keeps the legacy
  "drop with placeholder" default for back-compat; new code should
  probably default to abort.
- **Compaction is destructive of skill content over multiple rounds.**
  If a session loads a skill, runs many turns, gets compacted, and the
  skill content lands in the middle window, it becomes a summary of the
  skill. The `SUMMARY_PREFIX` warning helps but doesn't fully solve it.
  For v4, consider: (a) re-injecting active skills after each compact,
  or (b) tagging skill content so the compactor preserves it. Hermes
  does neither today — this is a known gotcha that Jason may want to
  fix in Evy.
- **No embeddings, no classifier.** Worth re-confirming the operator
  intent here. The v4 router docstring already plans for "Phase 5 —
  swap for semantic retriever." Hermes's design says **don't**: the
  model is the router and the index is the system prompt. If the
  operator wants a semantic prefilter, that's a *deviation* from Hermes,
  not an emulation of it.
- **`/compact <focus>` is the only "guided" path Hermes has.** Inspired
  explicitly by Claude Code (`agent/context_compressor.py:1509-1512`).
  The summariser is told to prioritise the focus topic. If Evy wants
  focused compaction, port `focus_topic` through alongside the
  threshold knobs.
- **Skill content stays in conversation forever (until compact).** There
  is NO automatic unload. If Evy wants "use a skill, then forget it,"
  that's net-new — Hermes doesn't have it.
