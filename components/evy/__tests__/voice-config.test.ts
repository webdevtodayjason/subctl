// components/master/__tests__/voice-config.test.ts
//
// v2.8.0 — Voice layer config. Pins loadVoiceConfig / saveVoiceConfig /
// watchVoiceConfig contracts against an isolated tmpdir. Mirrors
// profiles.test.ts (v2.7.18) for symmetry.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VOICE_DEFAULTS,
  _setPathForTesting,
  loadVoiceConfig,
  saveVoiceConfig,
  watchVoiceConfig,
} from "../voice-config";

let tmpDir: string;
let voicePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-voice-test-"));
  voicePath = join(tmpDir, "voice.json");
  _setPathForTesting(voicePath);
});

afterEach(() => {
  _setPathForTesting(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadVoiceConfig", () => {
  test("seeds defaults when the file is missing", () => {
    expect(existsSync(voicePath)).toBe(false);
    const cfg = loadVoiceConfig();
    expect(existsSync(voicePath)).toBe(true);
    expect(cfg).toEqual(VOICE_DEFAULTS);
  });

  test("reads existing file unchanged", () => {
    writeFileSync(
      voicePath,
      JSON.stringify({
        enabled: true,
        default_voice_id: "alt-voice",
        model: "kokoro-82m",
        tts_server: "http://localhost:9999",
      }),
    );
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.default_voice_id).toBe("alt-voice");
    expect(cfg.model).toBe("kokoro-82m");
    expect(cfg.tts_server).toBe("http://localhost:9999");
  });

  test("normalizes missing fields back to defaults", () => {
    writeFileSync(voicePath, JSON.stringify({ enabled: true }));
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.default_voice_id).toBe(VOICE_DEFAULTS.default_voice_id);
    expect(cfg.model).toBe(VOICE_DEFAULTS.model);
    expect(cfg.tts_server).toBe(VOICE_DEFAULTS.tts_server);
  });

  test("falls back to defaults on malformed JSON", () => {
    writeFileSync(voicePath, "{not json");
    const cfg = loadVoiceConfig();
    expect(cfg).toEqual(VOICE_DEFAULTS);
  });

  test("treats empty string fields as missing (uses defaults)", () => {
    writeFileSync(
      voicePath,
      JSON.stringify({ default_voice_id: "", model: "", tts_server: "" }),
    );
    const cfg = loadVoiceConfig();
    expect(cfg.default_voice_id).toBe(VOICE_DEFAULTS.default_voice_id);
    expect(cfg.model).toBe(VOICE_DEFAULTS.model);
    expect(cfg.tts_server).toBe(VOICE_DEFAULTS.tts_server);
  });
});

describe("saveVoiceConfig", () => {
  test("merges patches over existing config", () => {
    saveVoiceConfig({ enabled: true });
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.default_voice_id).toBe(VOICE_DEFAULTS.default_voice_id);
  });

  test("subsequent patches preserve unrelated fields", () => {
    saveVoiceConfig({ enabled: true, model: "voxcpm-2b" });
    saveVoiceConfig({ tts_server: "http://localhost:7777" });
    const cfg = loadVoiceConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("voxcpm-2b");
    expect(cfg.tts_server).toBe("http://localhost:7777");
  });

  test("persists to disk in JSON form", () => {
    saveVoiceConfig({ enabled: true });
    const raw = readFileSync(voicePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.enabled).toBe(true);
  });
});

describe("watchVoiceConfig", () => {
  test("fires callback after file change (debounced 200ms)", async () => {
    // Seed file first so fs.watch has something to watch.
    loadVoiceConfig();
    let calls = 0;
    let lastEnabled: boolean | null = null;
    const handle = watchVoiceConfig((cfg) => {
      calls++;
      lastEnabled = cfg.enabled;
    });
    try {
      writeFileSync(
        voicePath,
        JSON.stringify({ ...VOICE_DEFAULTS, enabled: true }),
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(lastEnabled).toBe(true);
    } finally {
      handle.close();
    }
  });

  test("close() stops further callbacks", async () => {
    loadVoiceConfig();
    let calls = 0;
    const handle = watchVoiceConfig(() => {
      calls++;
    });
    handle.close();
    writeFileSync(
      voicePath,
      JSON.stringify({ ...VOICE_DEFAULTS, enabled: true }),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(0);
  });
});
