# 0017: Voice layer (TTS) for Evy — self-hosted, opt-in, redacted

- **Status:** Accepted (ships v2.8.0)
- **Date:** 2026-05-13
- **Decided by:** Jason Brashear (operator)
- **Implemented in:** v2.8.0
- **Related:** [persona/voice-future.md](../persona/voice-future.md), [persona/evy.md](../persona/evy.md), [ADR 0009](0009-self-hosted-only-no-cloud-memory.md), [ADR 0004](0004-evy-persona-librarian-framing.md)

## Context

`docs/persona/voice-future.md` (authored 2026-05-12) parked Evy's voice
layer as a "future, not scheduled" item gated on text-Evy being stable.
By v2.7.30 text-Evy had logged 40 eval tests across fourteen categories
spanning seven shipped versions (v2.7.18 through v2.7.24), and the
persona-grader trend was healthy enough that the operator surfaced the
voice layer as the v2.8.0 promotion.

Three things had to be decided up front:

1. **Self-hosted or cloud TTS?** ElevenLabs, OpenAI TTS, and Azure
   Neural TTS all have stellar cloning fidelity, sub-second latency,
   and a published API. They also egress every synthesized line to a
   third party — including MSP client conversations and operator-Evy
   chat. [ADR 0009](0009-self-hosted-only-no-cloud-memory.md) already
   pinned memory backends to self-hosted-only for the same reason; the
   operator's "future voice layer" sentence in that ADR's Decision
   section already extended the rule. v2.8.0 honors it.

2. **Which open-source TTS model?**
   `docs/persona/voice-future.md` surveyed seven candidates: VoxCPM 2B,
   VoxCPM2 / VoxCPM 0.5B, Kokoro-82M, KittenTTS, Pocket TTS, Chatterbox,
   CosyVoice2-0.5B, Fish Speech, MOSS-TTS Nano, Piper, TinyTTS variants.
   The operator's lean was VoxCPM 0.5B for the M3 Ultra ("good quality,
   cloning fidelity, multilingual support, streaming, smaller than the
   2B base") with Kokoro-82M as a CPU-friendly fallback for the mini
   nodes.

3. **How to ship a voice layer that can be developed and tested without
   committing to a backend?**

## Decision

**A self-hosted, three-backend, opt-in voice layer.** Defaults to OFF
(`enabled: false` in `voice.json`). Operator opts in via the dashboard
toggle, `subctl voice on`, or `/voice on` in Telegram.

### Backend selection

Three backends, all behind one HTTP surface (`POST /render`):

- **`voxcpm`** — operator's primary lean. ~0.5B model, cloning
  fidelity + streaming, Apple-Silicon-capable on M3. Requires
  `pip install voxcpm` plus model weights for the 0.5B variant and a
  ~10s reference clip at `services/tts/voices/<voice_id>/reference.wav`
  with aligned transcript.
- **`kokoro`** — Kokoro-82M. ~325MB, CPU-friendly, no GPU required.
  Good fallback for the M2 mini and for the case where voxcpm's install
  hits an Apple-Silicon snag. Limited cloning vs voxcpm.
- **`mock`** — default. Generates a 1-second silent WAV for the
  requested text. Lets the rest of the voice layer (master tool,
  dashboard 🔊 button, Telegram `/say`, CLI, cache, redaction, tests)
  be developed and tested without committing to either real backend.
  Production deploys override via the `__BACKEND__` placeholder in
  `services/tts/launchd/com.subctl.tts.plist`.

The TTS service runs as a separate launchd job (`com.subctl.tts`) on
127.0.0.1:8789 — the master daemon does not embed the model. This
keeps the Python dep tree out of the bun runtime and lets the model be
restarted independently of the master.

### Redaction floor (don't speak secrets)

`renderVoice()` calls `redactForEgress()` from
`components/master/memory.ts` (the same function Telegram + dashboard
quoting use) BEFORE the text leaves master to the TTS server. The unit
test `redacts secrets BEFORE sending text to TTS server` pins this —
an `sk-*` token in the input never reaches the TTS server, regardless
of who originally produced the text. This applies whether the caller
is Evy via the `voice_render` tool, the dashboard's 🔊 button, the
Telegram `/say` command, or the `subctl voice render` CLI.

### Cache

Synthesized audio caches at
`~/.local/state/subctl/voice/cache/<hash>.<fmt>` with a 24h TTL.
Fingerprint is `sha256("model|voice_id|text")[:24]` so the same line in
the same voice + model hits cache; changing any of the three forces a
re-render. Path-traversal-resistant resolution: only filenames matching
`^[a-f0-9]+\.[a-z0-9]+$` resolve.

### Config + hot reload

`~/.config/subctl/voice.json` holds the four knobs (`enabled`,
`default_voice_id`, `model`, `tts_server`). The config is read on every
call by the voice tool — there is no in-memory cache. The operator's
[2026-05-11 feedback](../../components/master/feedback_version_single_source.md)
("VERSION is the one canonical source — every version display reads it
on each call; never cache at startup") applies here too: the operator
toggles voice on/off and expects the next render to honor the new
state, not the state at master boot. The fs.watch on `voice.json`
exists for SSE-side propagation (live UI updates), not for caching.

### Persona unchanged

Voice rendering is a delivery channel, not a persona change. Evy's
voice rules — no padding, no em dashes, dry/precise register — stay
in [ADR 0004](0004-evy-persona-librarian-framing.md) and
`components/skills/master/SKILL.md`. The TTS layer speaks whatever
text Evy already produced, after redaction. Voice cloning targets
Rachel Weisz as Evy Carnahan (the operator's character anchor); this
is metadata at the reference-clip level, not a system-prompt addition.

## Consequences

- Voice tooling lives behind `voiceTools.voice_render` and
  `voiceTools.voice_status` on the master daemon, with `telegram_send_voice`
  bridging audio to the operator's phone for `severity: alert`
  notifications and explicit `/say` requests.
- The dashboard chat panel grows a 🔊 button per Evy turn (visible
  only when `voice.json#enabled=true`). Audio plays inline via the
  master's `/voice/audio/<hash>` route.
- `subctl voice [status|test|render|on|off]` is the CLI sanity surface;
  `subctl voice test` plays a canned line via `afplay`.
- `install.sh` gains an opt-in "Install voice layer?" prompt that
  defaults to the `mock` backend so first-run install stays fast.
- Storage tier impact: zero on the memory tiers (audio renders from
  text at delivery time per `persona/voice-future.md`; the cache is
  bounded ephemeral state).
- License-check: VoxCPM (Apache 2.0), Kokoro (Apache 2.0) both
  permissive. Fish Speech was specifically flagged in
  `voice-future.md` for license-check and is NOT included as a
  v2.8.0 backend; can be added later if its license clarifies.

## Reasoning

- **Persona stability gates voice.** Shipping a TTS layer before the
  text register was solid would have produced an Evy-voiced bot that
  drifted register on hard turns. The v2.7.30 eval coverage gave
  enough confidence that the text layer wouldn't drift.
- **Opt-in default protects against surprise.** Voice can be loud,
  badly cached audio can carry secrets, and the operator may not want
  every Telegram reply read aloud. `enabled: false` keeps the
  decision in the operator's hands.
- **Three backends keeps the door open.** The mock backend means the
  layer is in production from day one regardless of whether the
  operator has finished setting up VoxCPM weights. Kokoro covers the
  CPU-only mini nodes. VoxCPM is the quality target.
- **Redaction at the tool boundary is the right place.** Earlier
  drafts considered redacting at the TTS server. The tool boundary
  guarantees redaction regardless of how the TTS server is
  configured (or replaced) — a future swap from VoxCPM to Chatterbox
  doesn't reintroduce the leak risk.
- **VERSION-as-canonical applies to config, not just version.** The
  operator's 2026-05-11 feedback was a generic stale-cache rule; the
  voice layer follows it from day one.

## Open questions deferred

- **Streaming audio over the SSE channel.** v2.8.0 ships file-cached
  WAV bytes; streaming TTS over the agent's SSE stream is feasible but
  not necessary for the operator's current chat-volume. Revisit if
  voice volumes grow.
- **Per-channel voice presets** (different voice on Telegram vs
  dashboard). Not v2.8.0 — single voice profile across surfaces.
- **Voice authentication for inbound audio** (operator speaking back).
  Out of scope; subctl is text-in for now.
