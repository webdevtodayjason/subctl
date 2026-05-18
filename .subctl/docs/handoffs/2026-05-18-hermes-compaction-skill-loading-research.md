# Handoff: Hermes compaction + skill-loading research

Date: 2026-05-18
Operator: Jason
Project: subctl

## Trigger

Jason showed a Hermes session where:

- Hermes visibly loaded relevant skills immediately (`hermes-agent`, `blogwatcher`, `arxiv`).
- Hermes created an AI Pulse morning briefing and a 2-hour silent-unless-interesting AI buzz watcher.
- Hermes performed preflight compression at ~153,281 tokens against a 136,000-token threshold, then compacted and continued.

Jason said: "The way Hermes does compaction is pretty amazing" and wants to look into this more.

## Research goal

Compare Hermes' actual implementation against subCTL's current compaction / skill-loading model. Produce a concrete recommendation for what subCTL should adopt.

## Known subCTL baseline from desk check

SubCTL current compact policy:

- Primary compaction is JIT at prompt composition time.
- Warn at ~25k tokens.
- Compact at ~40k tokens.
- Target ~30k tokens.
- Keep recent 6 turns intact.
- Safety-net ticker remains for tool outputs generated after composition.
- Module: `components/master/compact-policy.ts`.
- Config path: `~/.config/subctl/master/compact.json`.

Runtime supervisor snapshot:

- Supervisor provider: `openai-codex`.
- Model: `gpt-5.5`.
- Auto-compact enabled.
- Default reported config: `threshold_pct: 90`, `target_tokens: 50000`, `keep_recent: 6`.

Potential mismatch worth investigating: first-party subctl docs describe fixed 25k/40k/30k thresholds, but runtime introspection reports percent/default style. Determine whether that is drift, backwards-compatible config reporting, or real behavior mismatch.

## Hermes repo

Local repo exists:

- Path: `/Users/sem/code/hermes-agent`
- Branch: `main`
- Last commit: `55c9f3206 fix(tui): width-aware markdown table rendering with vertical fallback (#26195)`

## Questions to answer

1. How does Hermes decide when to compact?
   - Token threshold source
   - Preflight timing
   - What it preserves verbatim
   - How it summarizes prior turns
   - Whether skill state is reloaded after compaction
2. How does Hermes skill loading work?
   - How skills are discovered
   - How trigger selection works
   - Whether visible skill-load events are merely UI or actual context injection
3. How does Hermes schedule/cron automation work?
   - The pasted example used cron jobs with stable IDs and Telegram delivery.
   - Identify whether this is a Hermes feature we can model in subCTL or a different local runtime.
4. What should subCTL adopt?
   - Better visible skill load events?
   - Larger model-aware compaction thresholds?
   - Preflight compression UI?
   - Durable cron-style jobs beyond one-shot `schedule_followup`?
   - Morning digest / silent watcher first-class feature?

## Constraints

- This is research first. Do not edit code unless explicitly asked.
- Do not disturb active subCTL memory-kernel or template-spawn work.
- Do not deploy, push, merge, or restart services.

## Desired deliverable

A short report under `.subctl/docs/research/` with:

- Hermes findings with file references
- subCTL comparison
- recommended implementation slices
- risks / open questions
