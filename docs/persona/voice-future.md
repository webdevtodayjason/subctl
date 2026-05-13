# Future: Voice Layer for Evy

- **Status:** Future consideration, not scheduled
- **Last updated:** 2026-05-12
- **Owner:** Jason Brashear (operator) — model selection
- **Related:** [persona/evy.md](evy.md), [roadmap.md](../roadmap.md)

This document captures the voice-synthesis candidates the operator has identified for a future Evy voice layer. No work is scheduled; this is a parking lot for when text-Evy is stable and the voice layer becomes worth pursuing.

## Why this exists separately

A voice layer is downstream of the persona, not part of it. Evy's identity, voice rules (no padding, no em dashes, dry/precise register), and operating stance are defined in text. When and if subctl gains a TTS layer, it renders Evy's text response to audio at delivery time. The memory model doesn't change; the persona doesn't change; only the output channel widens.

That makes voice a clean future addition rather than a feature dependency.

## Candidate models

Operator-surveyed open-source TTS options. Listed roughly by size; the trade-offs are quality / cloning fidelity / latency / hardware footprint / license.

### Reference candidate

- **VoxCPM (OpenBMB)** — https://github.com/OpenBMB/VoxCPM
  Operator's initial reference. ~2B-class model. Good quality, cloning fidelity, multilingual support, streaming. The benchmark to compare lighter candidates against.

### Operator-recommended (best balance)

- **VoxCPM2 or VoxCPM 0.5B variant** — operator's lean for "new projects pushing the edge." Quality + cloning fidelity + multilingual + streaming at a smaller footprint than the 2B base.

### Lighter alternatives (size/speed-optimized)

| Model | Params | Notes |
|---|---|---|
| Kokoro-82M | 82M | Extremely lightweight, fast, CPU-friendly. Good quality for size. Limited voices/cloning vs VoxCPM. |
| KittenTTS | 15M–80M | Ultra-small (~25–80MB), CPU-only viable. Lightweight deployment focus. |
| Pocket TTS | ~100M | Fast, low-latency streaming, voice cloning, no-GPU operation. On-device / edge focus. |
| Chatterbox | ~0.35B–0.5B | Lightweight, real-time / low-latency, strong naturalness + cloning. Production focus. |
| CosyVoice2-0.5B | 0.5B | Strong streaming, low latency. |
| Fish Speech | varies | Excellent multilingual cloning. Check licensing carefully. |
| MOSS-TTS Nano | very light | Cloning support. |

### Ultra-constrained / embedded

- **Piper** — CPU-friendly, many languages, but limited cloning capability.
- **TinyTTS variants** — smallest footprint, narrowest feature set.

### Hybrid approach

Layer a tiny model (Kitten / Pocket) with post-processing like RVC for enhanced cloning quality where the base model is limited. Useful if VRAM is the binding constraint but cloning fidelity still matters.

## What decides selection

Not yet scheduled, but the decision factors will be:

1. **Self-hosting feasibility on M3.** Same floor as memory backends (see [ADR 0009](../adr/0009-self-hosted-only-no-cloud-memory.md)). No cloud egress of Evy's voice. M3 has the compute headroom for any of these candidates; CPU-only matters less here.
2. **Cloning fidelity.** If Evy gets a specific voice (Rachel Weisz-as-Evy-Carnahan is the character anchor), cloning matters. VoxCPM-family and Chatterbox / CosyVoice2 are the strong candidates.
3. **Latency.** Streaming TTS for back-and-forth conversation needs sub-second time-to-first-audio. Streaming-native models (CosyVoice2, Chatterbox, Pocket) win here.
4. **License.** Apache 2.0 or similar permissive license. Fish Speech specifically flagged for license-check.

## How this would integrate

Sketch only; no code planned:

- Master daemon gains a `voice_render({text, voice_id})` master tool that posts to a local TTS HTTP server.
- The TTS server runs as a separate launchd service on M3, similar to how LM Studio runs.
- The dashboard's chat panel gets a "play audio" affordance per Evy turn.
- Telegram integration could send voice notes for routine status messages (the operator's chosen mode of asynchronous check-ins).

Storage tier impact: zero. Audio is rendered from text at delivery time. Memory tiers store text. (See [memory-architecture.md](../memory-architecture.md).)

## When this gets prioritized

After:

1. v2.7.12 ships text-Evy with the eval harness.
2. v2.7.13 ships Memori integration.
3. v2.8.0 ships team templates.
4. Eval-score trends show text-Evy is stable for at least a month.

Could be slotted into a v2.9.x or v3.x wave at that point.

## References

- [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM)
- r/LocalLLaMA discussions on TTS comparisons (operator-suggested watering hole for inference tweaks)
- Operator's voice survey: session 2026-05-12
