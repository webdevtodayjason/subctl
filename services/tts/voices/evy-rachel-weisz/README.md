# evy-rachel-weisz voice

Character anchor: **Rachel Weisz as Evy Carnahan** (The Mummy, 1999).

This directory should contain:

- `reference.wav` — a ~10 second clean speech sample of the target voice,
  16kHz mono. Used by VoxCPM (and other cloning-capable backends) as the
  voice reference for synthesis.
- `transcript.txt` — the exact text of `reference.wav`. Used by VoxCPM
  when it needs aligned reference text + audio for cloning.

Reference clip not committed — the operator sources it per their licensing
posture. The TTS server falls back to its model's default voice when
`reference.wav` is absent, and the dashboard's voice status surface
flags this state.
