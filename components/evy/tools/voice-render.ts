// components/master/tools/voice-render.ts
//
// v2.8.0 — Master tool: voice_render({ text, voice_id? }) → { audio_url,
// format, duration_ms, cached, hash }. POSTs to the local TTS server
// (default http://localhost:8789) and caches rendered audio to
// ~/.local/state/subctl/voice/cache/<sha256(text|voice|model)>.<fmt>
// with a 24h TTL so repeated synthesis of the same line is cheap.
//
// Self-hosted-only floor per ADR 0009 — the TTS server runs on the
// operator's M3, no cloud egress. The text is redacted via the egress
// redactor (same path as Telegram/dashboard quoting) before the bytes
// leave the master process, so "don't speak secrets" is enforced at the
// tool boundary, not just at the persona layer.
//
// Audio is served to the dashboard via the master's HTTP server at
// GET /voice/audio/<hash>.<fmt> — see server.ts. This tool returns the
// URL, not the bytes, so the agent's transcript stays small.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadVoiceConfig } from "../voice-config";
import { redactForEgress } from "../memory";

// Cache dir override for tests + the dashboard's /audio route.
const ENV_CACHE_DIR = "SUBCTL_VOICE_CACHE_DIR";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_TEXT_CHARS = 4000; // hard ceiling; protects the local TTS server

export function getVoiceCacheDir(): string {
  if (process.env[ENV_CACHE_DIR]) return process.env[ENV_CACHE_DIR] as string;
  return join(homedir(), ".local", "state", "subctl", "voice", "cache");
}

interface RenderResult {
  ok: boolean;
  audio_url?: string;
  audio_path?: string;
  format?: string;
  duration_ms?: number;
  hash?: string;
  cached?: boolean;
  voice_id?: string;
  model?: string;
  error?: string;
}

/** sha256(`${model}|${voice_id}|${text}`) — the cache key. */
function fingerprint(text: string, voice_id: string, model: string): string {
  return createHash("sha256")
    .update(`${model}|${voice_id}|${text}`)
    .digest("hex")
    .slice(0, 24);
}

function findCached(dir: string, hash: string): { path: string; format: string } | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(`${hash}.`)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
      try {
        unlinkSync(full);
      } catch {
        /* best-effort eviction */
      }
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const format = dot > 0 ? entry.slice(dot + 1) : "wav";
    return { path: full, format };
  }
  return null;
}

/**
 * Programmatic API. Used by:
 *   - voiceTools.voice_render (Evy's master tool)
 *   - master HTTP route POST /voice/render (CLI + dashboard)
 *   - Telegram /say command
 */
export async function renderVoice(args: {
  text: string;
  voice_id?: string;
}): Promise<RenderResult> {
  const cfg = loadVoiceConfig();
  if (!cfg.enabled) {
    return { ok: false, error: "voice disabled in voice.json" };
  }
  const raw = (args.text ?? "").trim();
  if (!raw) return { ok: false, error: "text required" };
  if (raw.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `text exceeds ${MAX_TEXT_CHARS} chars` };
  }
  // Egress redaction floor: don't speak secrets even if the agent slips
  // a token into a turn. Mirrors what Telegram / dashboard quoting does
  // for text rendering.
  const safeText = redactForEgress(raw);
  const voice_id = (args.voice_id ?? cfg.default_voice_id).trim();
  const model = cfg.model;
  const hash = fingerprint(safeText, voice_id, model);
  const cacheDir = getVoiceCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  // Cache hit — return the URL without round-tripping the TTS server.
  const hit = findCached(cacheDir, hash);
  if (hit) {
    return {
      ok: true,
      audio_url: `/voice/audio/${hash}.${hit.format}`,
      audio_path: hit.path,
      format: hit.format,
      duration_ms: 0,
      hash,
      cached: true,
      voice_id,
      model,
    };
  }

  // POST to the local TTS server.
  let resp: Response;
  try {
    resp = await fetch(`${cfg.tts_server}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: safeText, voice_id, model }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `tts server unreachable (${cfg.tts_server}): ${(err as Error).message}`,
    };
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      /* ignore body read failure */
    }
    return {
      ok: false,
      error: `tts server HTTP ${resp.status}: ${detail.slice(0, 200)}`,
    };
  }
  const format = (resp.headers.get("X-Audio-Format") ?? "wav").toLowerCase();
  const durHeader = resp.headers.get("X-Audio-Duration-Ms");
  const duration_ms = durHeader ? parseInt(durHeader, 10) || 0 : 0;
  let bytes: ArrayBuffer;
  try {
    bytes = await resp.arrayBuffer();
  } catch (err) {
    return { ok: false, error: `tts read failed: ${(err as Error).message}` };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, error: "tts returned empty audio" };
  }
  const outPath = join(cacheDir, `${hash}.${format}`);
  try {
    writeFileSync(outPath, new Uint8Array(bytes));
  } catch (err) {
    return { ok: false, error: `cache write failed: ${(err as Error).message}` };
  }
  return {
    ok: true,
    audio_url: `/voice/audio/${hash}.${format}`,
    audio_path: outPath,
    format,
    duration_ms,
    hash,
    cached: false,
    voice_id,
    model,
  };
}

/**
 * Resolve a cache hash back to a file path. Used by the master HTTP
 * route GET /voice/audio/<hash>.<fmt> when the dashboard's <audio> tag
 * fetches the bytes.
 */
export function resolveCachedAudio(hashWithExt: string): {
  path: string;
  format: string;
} | null {
  // Defend against path traversal — the hash should be hex + a single dot.
  if (!/^[a-f0-9]{1,64}\.[a-z0-9]{1,8}$/i.test(hashWithExt)) return null;
  const cacheDir = getVoiceCacheDir();
  const full = join(cacheDir, hashWithExt);
  if (!existsSync(full)) return null;
  // Confirm the resolved path is still inside the cache dir.
  if (!full.startsWith(cacheDir)) return null;
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return null;
  }
  if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
    try {
      unlinkSync(full);
    } catch {
      /* best-effort eviction */
    }
    return null;
  }
  const dot = hashWithExt.lastIndexOf(".");
  const format = dot > 0 ? hashWithExt.slice(dot + 1) : "wav";
  return { path: full, format };
}

/**
 * Quick reachability probe for the TTS server. Used by /voice/status and
 * the `subctl voice status` CLI surface. Never throws.
 */
export async function probeTtsServer(): Promise<{
  reachable: boolean;
  url: string;
  ms?: number;
  error?: string;
}> {
  const cfg = loadVoiceConfig();
  const url = `${cfg.tts_server}/health`;
  const start = Date.now();
  try {
    const r = await fetch(url, { method: "GET" });
    const ms = Date.now() - start;
    if (!r.ok) {
      return { reachable: false, url, ms, error: `HTTP ${r.status}` };
    }
    return { reachable: true, url, ms };
  } catch (err) {
    return { reachable: false, url, error: (err as Error).message };
  }
}

/** Read on demand so the value reflects current voice.json without a restart. */
function describeStatus(): string {
  try {
    const cfg = loadVoiceConfig();
    return `enabled=${cfg.enabled} voice=${cfg.default_voice_id} model=${cfg.model} server=${cfg.tts_server}`;
  } catch {
    return "voice config unreadable";
  }
}

export const voiceTools = {
  voice_render: {
    description:
      "Render text to speech via the local self-hosted TTS server and return a playable audio URL. Use ONLY when the operator explicitly asks for audio (e.g. /say <text>, dashboard click on the 🔊 icon, or operator says 'speak this'). The audio_url is relative to master's HTTP base (e.g. /voice/audio/<hash>.wav). Voice is disabled by default — voice.json must have enabled=true. Egress redaction applies before synthesis; do NOT pass secrets, tokens, or HMAC markers into this tool. Cached for 24h by (text, voice_id, model) fingerprint.",
    schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The text to speak. Max 4000 chars. Will be redacted for egress before being sent to the TTS server.",
        },
        voice_id: {
          type: "string",
          description:
            "Voice cloning slug (defaults to voice.json default_voice_id — typically evy-rachel-weisz).",
        },
      },
      required: ["text"],
    },
    invoke: async (args: { text: string; voice_id?: string }) => {
      const result = await renderVoice(args);
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        audio_url: result.audio_url,
        format: result.format,
        duration_ms: result.duration_ms,
        cached: result.cached,
        voice_id: result.voice_id,
        model: result.model,
        message: result.cached
          ? "audio served from cache; share the audio_url with the operator"
          : "audio rendered; share the audio_url with the operator",
      };
    },
  },

  voice_status: {
    description:
      "Quick read of voice layer state — whether voice is enabled, the configured voice id, model, and TTS server URL plus a reachability probe. Use when the operator asks 'is voice working' or 'what's the voice config'.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const cfg = loadVoiceConfig();
      const probe = await probeTtsServer();
      return {
        ok: true,
        config: cfg,
        tts_reachable: probe.reachable,
        tts_url: probe.url,
        latency_ms: probe.ms ?? null,
        status_line: describeStatus(),
      };
    },
  },
};
