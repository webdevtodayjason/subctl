// components/evy/voice-config.ts
//
// v2.8.0 — Voice layer config. ~/.config/subctl/voice.json holds the
// operator-editable knobs for the local TTS pipeline:
//
//   {
//     "enabled": true,
//     "default_voice_id": "evy-rachel-weisz",
//     "model": "voxcpm-0.5b",
//     "tts_server": "http://localhost:8789"
//   }
//
// Boot path mirrors profiles.ts (v2.7.18):
//   1. loadVoiceConfig() — seeds the file with defaults if missing, returns
//      the parsed config. Stateless: every call re-reads from disk so the
//      VERSION-style single-source-of-truth rule applies (no cache).
//   2. watchVoiceConfig(onChange) — fs.watches the file with a 200ms
//      debounce. The master fires the callback on change so HTTP /voice/*
//      surfaces and the voice_render tool pick up new settings without
//      a daemon restart.
//
// The voice_render tool reads this file on every call too — there is no
// in-memory cache. That follows the operator's "VERSION is the one
// canonical source" rule (memory feedback 2026-05-11): every voice
// render reads the current enabled flag, current voice id, current
// server URL. Stale-cache failures are not tolerable for a feature that
// the operator can toggle from the dashboard.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  watch,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface VoiceConfig {
  enabled: boolean;
  default_voice_id: string;
  model: string;
  tts_server: string;
}

export const VOICE_DEFAULTS: VoiceConfig = {
  enabled: false, // default OFF — operator must opt in. Avoids surprise TTS spam.
  default_voice_id: "evy-rachel-weisz",
  model: "voxcpm-0.5b",
  tts_server: "http://localhost:8789",
};

const ENV_OVERRIDE = "SUBCTL_VOICE_CONFIG_PATH";

function defaultPath(): string {
  return join(homedir(), ".config", "subctl", "voice.json");
}

let _testPath: string | null = null;

/** @internal — test-only. Point loaders at a tmp file instead of ~/.config. */
export function _setPathForTesting(path: string | null): void {
  _testPath = path;
}

function currentPath(): string {
  if (_testPath) return _testPath;
  if (process.env[ENV_OVERRIDE]) return process.env[ENV_OVERRIDE] as string;
  return defaultPath();
}

function seedIfMissing(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(VOICE_DEFAULTS, null, 2), "utf8");
}

function normalize(parsed: Partial<VoiceConfig>): VoiceConfig {
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : VOICE_DEFAULTS.enabled,
    default_voice_id:
      typeof parsed.default_voice_id === "string" && parsed.default_voice_id.length > 0
        ? parsed.default_voice_id
        : VOICE_DEFAULTS.default_voice_id,
    model:
      typeof parsed.model === "string" && parsed.model.length > 0
        ? parsed.model
        : VOICE_DEFAULTS.model,
    tts_server:
      typeof parsed.tts_server === "string" && parsed.tts_server.length > 0
        ? parsed.tts_server
        : VOICE_DEFAULTS.tts_server,
  };
}

/**
 * Read the voice config from disk, seeding defaults if the file is
 * missing. Malformed JSON falls back to defaults with a single
 * console.error — same robustness rule as secrets-backends.json.
 */
export function loadVoiceConfig(): VoiceConfig {
  const path = currentPath();
  seedIfMissing(path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`[voice] read failed (${(err as Error).message}); using defaults`);
    return { ...VOICE_DEFAULTS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return normalize(parsed);
  } catch (err) {
    console.error(`[voice] parse failed (${(err as Error).message}); using defaults`);
    return { ...VOICE_DEFAULTS };
  }
}

/**
 * Persist voice config to disk. Used by the dashboard /voice/config POST
 * route and the CLI `subctl voice` enable/disable surface.
 */
export function saveVoiceConfig(next: Partial<VoiceConfig>): VoiceConfig {
  const current = loadVoiceConfig();
  const merged = normalize({ ...current, ...next });
  const path = currentPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * fs.watch voice.json with 200ms debounce (atomic-rename editors fire
 * the watcher twice on macOS — same trap profiles.ts already documents).
 * Returns a handle with close() for shutdown cleanup.
 */
export function watchVoiceConfig(
  onChange: (cfg: VoiceConfig) => void,
): { close: () => void } {
  const path = currentPath();
  // Make sure the file exists before watching — fs.watch on a missing
  // path errors immediately on macOS.
  loadVoiceConfig();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(path, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          onChange(loadVoiceConfig());
        } catch (err) {
          console.error(`[voice] watcher reload failed: ${(err as Error).message}`);
        }
      }, 200);
    });
  } catch (err) {
    console.error(`[voice] fs.watch failed: ${(err as Error).message}`);
  }
  return {
    close: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
