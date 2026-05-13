# subctl TTS service (v2.8.0)

Self-hosted TTS server for Evy's voice layer. Runs as a separate launchd
job (`com.subctl.tts`) so the master daemon doesn't have to manage a
Python subprocess directly.

## Why self-hosted

ADR 0009 (self-hosted-only memory floor) extends to TTS:
audio synthesis happens on the operator's M3 Ultra, not in a cloud API.
MSP client conversations and operator-Evy chat history don't egress to
a third party.

## Server contract

```
POST /render
  Content-Type: application/json
  body: { "text": "...", "voice_id": "evy-rachel-weisz", "model": "voxcpm-0.5b" }
  →
  Content-Type: audio/wav  (or audio/mpeg if mp3)
  X-Audio-Format: wav
  X-Audio-Duration-Ms: 2740
  body: <bytes>

GET /health
  → { "ok": true, "model": "voxcpm-0.5b", "backend": "voxcpm" | "mock", ... }
```

## Backend selection

Set `SUBCTL_TTS_BACKEND` in the launchd plist (or env) before starting
the server:

- `voxcpm` — operator's primary lean per `docs/persona/voice-future.md`.
  Requires `pip install voxcpm` (or the package as published by OpenBMB)
  plus model weights for the 0.5B variant. Apple Silicon: works on MPS
  device; CPU fallback exists but is slower.
- `kokoro` — Kokoro-82M fallback. Very small (~325MB), CPU-friendly,
  good enough for status notes. Use this if VoxCPM install hits
  Apple Silicon snags or for the M3 mini in the fleet.
- `mock` (default) — generates a 1-second silent WAV for the requested
  text. Lets the rest of the voice layer (master tool, dashboard button,
  Telegram /say, cache, CLI) be developed and tested without committing
  to a TTS backend. Production deploys MUST override.

Model selection rationale lives in
[`docs/adr/0017-voice-layer-tts.md`](../../docs/adr/0017-voice-layer-tts.md).

## Voice cloning

Voice reference clips live under `services/tts/voices/<voice_id>/`:

```
services/tts/voices/evy-rachel-weisz/
├── reference.wav         # ~10s clean speech sample
└── transcript.txt        # exact transcription of reference.wav
```

The character anchor for Evy is Rachel Weisz as Evy Carnahan in The
Mummy — a clean public-domain clip works fine. The operator is
responsible for sourcing a reference clip compatible with their
licensing posture.

## Install

`install.sh` handles dep install + voice-server scaffolding. The
plist template is `services/tts/launchd/com.subctl.tts.plist`; it is
copied into `~/Library/LaunchAgents/` with placeholders substituted at
install time.

Manual sanity start:

```
python3 services/tts/server.py
# then in another shell
curl -X POST http://localhost:8789/render \
  -H 'Content-Type: application/json' \
  -d '{"text":"clean, with one note.","voice_id":"evy-rachel-weisz"}' \
  --output /tmp/evy.wav
afplay /tmp/evy.wav
```
