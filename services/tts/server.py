#!/usr/bin/env python3
"""subctl TTS server — local-only TTS HTTP surface for Evy's voice layer.

v2.8.0 introduces voice rendering as a separate launchd service. The master
daemon's voice_render tool POSTs to this server's /render endpoint; the
server returns raw audio bytes plus duration metadata in response headers.

Backend selection is env-driven (SUBCTL_TTS_BACKEND):

  - voxcpm   primary lean per docs/persona/voice-future.md (~0.5B model,
             quality + cloning + streaming on M3). Requires `pip install voxcpm`.
  - kokoro   CPU-friendly fallback (~82M, fast, no GPU). Requires `pip install kokoro`.
  - system   macOS-native `say` command (zero deps, instant). Lower quality + no
             cloning, but produces real audio immediately. Best operator-friendly
             default on macOS hosts; chosen automatically by `subctl voice install
             system` since v2.8.0.
  - mock     generates a 1s silent WAV; useful for tests + CI when no real
             backend is wired. Used as the fallback default if no env is set.

The server only binds to 127.0.0.1 (HOST env override exists but defaults
to localhost) — ADR 0009 self-hosted-only floor extends here. No CORS,
no external listener. The master daemon's /voice/audio route is what the
dashboard hits; the dashboard never talks to this server directly.

Logs go to stderr so launchd's StandardErrorPath captures them.
"""

from __future__ import annotations

import io
import json
import os
import sys
import wave
import time
import struct
import logging
import http.server
import socketserver
from typing import Optional

LOG = logging.getLogger("subctl-tts")
logging.basicConfig(
    level=os.environ.get("SUBCTL_TTS_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)

HOST = os.environ.get("SUBCTL_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("SUBCTL_TTS_PORT", "8789"))
BACKEND = os.environ.get("SUBCTL_TTS_BACKEND", "mock").lower()
MODEL_HINT = os.environ.get("SUBCTL_TTS_MODEL", "voxcpm-0.5b")
VOICES_DIR = os.environ.get(
    "SUBCTL_TTS_VOICES_DIR",
    os.path.join(os.path.dirname(__file__), "voices"),
)


# ─── backends ────────────────────────────────────────────────────────────


def _mock_render(text: str, voice_id: str, model: str) -> tuple[bytes, str, int]:
    """Generate a 1-second silent 16kHz mono WAV.

    Returns (bytes, format, duration_ms). Used:
      - by default when no real backend is wired
      - in CI / dev when the TTS model isn't installed
      - by tests that don't want to require voxcpm + weights
    """
    sample_rate = 16000
    n_samples = sample_rate * 1  # 1 second
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(struct.pack("<" + "h" * n_samples, *([0] * n_samples)))
    return buf.getvalue(), "wav", 1000


_VOXCPM_MODEL = None  # lazy-init, cached across requests


def _voxcpm_render(text: str, voice_id: str, model: str) -> tuple[bytes, str, int]:
    """Render via VoxCPM 2.x. Lazy-imports + lazy-loads the model on first call,
    then caches it for all subsequent requests (loading the 0.5B model + weights
    takes ~30-60s; we only pay that cost once per server process).

    Voice cloning: if `services/tts/voices/<voice_id>/reference.wav` exists,
    it's passed to VoxCPM via `reference_wav_path`. Paired transcript.txt
    becomes `prompt_text` if both files are present (improves quality).
    """
    global _VOXCPM_MODEL
    try:
        from voxcpm import VoxCPM  # type: ignore[import-not-found]
        import numpy as np
    except ImportError as e:
        raise RuntimeError(
            "voxcpm not installed; install via 'pip install voxcpm' "
            "or override SUBCTL_TTS_BACKEND=kokoro|mock|system"
        ) from e

    if _VOXCPM_MODEL is None:
        load_started = time.time()
        # Model id: caller passes "voxcpm-0.5b" friendly name, but
        # VoxCPM.from_pretrained needs the HuggingFace repo id.
        hf_id = "openbmb/VoxCPM-0.5B" if model == "voxcpm-0.5b" else model
        LOG.info("voxcpm loading model %s (first request — may take 30-60s)", hf_id)
        _VOXCPM_MODEL = VoxCPM.from_pretrained(hf_id)
        LOG.info("voxcpm model loaded in %.1fs", time.time() - load_started)

    ref_dir = os.path.join(VOICES_DIR, voice_id)
    ref_wav = os.path.join(ref_dir, "reference.wav")
    transcript_path = os.path.join(ref_dir, "transcript.txt")
    gen_kwargs: dict = {"text": text}
    if os.path.exists(ref_wav):
        gen_kwargs["reference_wav_path"] = ref_wav
    if os.path.exists(transcript_path):
        with open(transcript_path) as f:
            transcript_text = f.read().strip()
        if transcript_text:
            gen_kwargs["prompt_wav_path"] = ref_wav
            gen_kwargs["prompt_text"] = transcript_text

    started = time.time()
    audio = _VOXCPM_MODEL.generate(**gen_kwargs)  # returns np.ndarray, float32 [-1,1]
    elapsed_ms = int((time.time() - started) * 1000)

    # VoxCPM output is mono float32 @ 16kHz; convert to int16 PCM WAV.
    audio_int16 = (audio.clip(-1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(audio_int16.tobytes())
    LOG.info(
        "voxcpm render text_len=%d ms=%d bytes=%d cloned=%s",
        len(text), elapsed_ms, len(buf.getvalue()), os.path.exists(ref_wav),
    )
    return buf.getvalue(), "wav", elapsed_ms


def _kokoro_render(text: str, voice_id: str, model: str) -> tuple[bytes, str, int]:
    """Render via Kokoro-82M. Same lazy-import dance as VoxCPM."""
    try:
        from kokoro import KPipeline  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "kokoro not installed; install via 'pip install kokoro' "
            "or override SUBCTL_TTS_BACKEND=mock"
        ) from e
    pipe = KPipeline(lang_code="a")  # 'a' = American English
    started = time.time()
    chunks = list(pipe(text, voice="af_bella"))  # Kokoro returns iterable
    audio = b"".join(getattr(c, "audio", b"") for c in chunks)
    elapsed_ms = int((time.time() - started) * 1000)
    return audio, "wav", elapsed_ms


def _system_render(text: str, voice_id: str, model: str) -> tuple[bytes, str, int]:
    """Render via macOS native `say` command. Zero deps, instant audio.

    Trade-off: lower quality + no voice cloning vs Kokoro/VoxCPM, but produces
    real spoken audio immediately on any macOS host. Useful as the
    operator-friendly default when neither heavyweight backend is installed.

    voice_id maps to a `say` voice name (run `say -v ?` to list). For the
    Rachel-Weisz-as-Evy-Carnahan anchor, "Serena" (British female Siri voice)
    is the closest match; falls back to "Samantha" otherwise.
    """
    import subprocess
    import tempfile

    voice_map = {
        "evy-rachel-weisz": "Serena",
        "evy": "Serena",
        "default": "Samantha",
    }
    say_voice = voice_map.get(voice_id, voice_id) or "Samantha"

    fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="subctl-tts-")
    os.close(fd)
    started = time.time()
    try:
        subprocess.run(
            [
                "say",
                "-v", say_voice,
                "--data-format=LEI16@22050",
                "-o", tmp_path,
                text,
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        elapsed_ms = int((time.time() - started) * 1000)
        with open(tmp_path, "rb") as f:
            audio = f.read()
        LOG.info(
            "system render text_len=%d voice=%s ms=%d bytes=%d",
            len(text), say_voice, elapsed_ms, len(audio),
        )
        return audio, "wav", elapsed_ms
    except subprocess.CalledProcessError as e:
        stderr_tail = (e.stderr or b"").decode("utf-8", errors="replace")[-400:]
        raise RuntimeError(
            f"`say` command failed (voice={say_voice}): {stderr_tail.strip()}"
        ) from e
    except FileNotFoundError as e:
        raise RuntimeError(
            "`say` command not found — system backend is macOS-only. "
            "Use SUBCTL_TTS_BACKEND=mock|voxcpm|kokoro instead."
        ) from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def render(text: str, voice_id: str, model: str) -> tuple[bytes, str, int]:
    if BACKEND == "voxcpm":
        return _voxcpm_render(text, voice_id, model)
    if BACKEND == "kokoro":
        return _kokoro_render(text, voice_id, model)
    if BACKEND == "system":
        return _system_render(text, voice_id, model)
    return _mock_render(text, voice_id, model)


# ─── HTTP server ─────────────────────────────────────────────────────────


class Handler(http.server.BaseHTTPRequestHandler):
    # quieter access log — launchd already captures stderr
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "backend": BACKEND,
                    "model": MODEL_HINT,
                    "voices_dir": VOICES_DIR,
                    "port": PORT,
                },
            )
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/render":
            self._json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 1_000_000:
            self._json(400, {"ok": False, "error": "missing or oversized body"})
            return
        try:
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json(400, {"ok": False, "error": f"bad json: {e}"})
            return
        text = (body.get("text") or "").strip()
        voice_id = (body.get("voice_id") or "evy-rachel-weisz").strip()
        model = (body.get("model") or MODEL_HINT).strip()
        if not text:
            self._json(400, {"ok": False, "error": "text required"})
            return
        if len(text) > 4000:
            self._json(400, {"ok": False, "error": "text exceeds 4000 chars"})
            return
        try:
            audio, fmt, ms = render(text, voice_id, model)
        except Exception as e:
            LOG.exception("render failed")
            self._json(500, {"ok": False, "error": f"render failed: {e}"})
            return
        ctype = "audio/wav" if fmt == "wav" else "audio/mpeg"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Audio-Format", fmt)
        self.send_header("X-Audio-Duration-Ms", str(ms))
        self.send_header("X-TTS-Backend", BACKEND)
        self.end_headers()
        self.wfile.write(audio)


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    LOG.info(
        "[tts] starting backend=%s model=%s host=%s port=%d voices=%s",
        BACKEND,
        MODEL_HINT,
        HOST,
        PORT,
        VOICES_DIR,
    )
    if HOST not in ("127.0.0.1", "localhost", "::1"):
        LOG.warning(
            "[tts] HOST=%s is not localhost — ADR 0009 says voice should "
            "not egress. Are you sure?",
            HOST,
        )
    with ThreadedServer((HOST, PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            LOG.info("[tts] shutting down on SIGINT")


if __name__ == "__main__":
    main()
