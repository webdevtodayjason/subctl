// components/evy/__tests__/voice-render.test.ts
//
// v2.8.0 — Voice render tool. Pins:
//   - returns "voice disabled" when voice.json#enabled=false
//   - text required + 4000-char ceiling
//   - egress redaction runs BEFORE the bytes leave the master process
//   - 24h cache (a second render with the same fingerprint hits cache)
//   - resolveCachedAudio rejects path traversal
//   - probeTtsServer maps reachable/unreachable cleanly
//
// The TTS server is mocked via a tiny Bun.serve() bound to a free
// localhost port. Each test sets voice.json + cache dir to isolated
// tmpdirs.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setPathForTesting, saveVoiceConfig } from "../voice-config";
import {
  renderVoice,
  resolveCachedAudio,
  probeTtsServer,
} from "../tools/voice-render";

interface MockedTts {
  url: string;
  close: () => void;
  receivedTexts: string[];
}

function startMockTts(opts: { failWith?: number } = {}): MockedTts {
  const receivedTexts: string[] = [];
  const server = Bun.serve({
    port: 0, // auto-pick a free port
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true, backend: "mock" });
      }
      if (url.pathname === "/render" && req.method === "POST") {
        const body = (await req.json()) as { text: string };
        receivedTexts.push(body.text);
        if (opts.failWith) {
          return new Response("nope", { status: opts.failWith });
        }
        // 4-byte WAV-ish placeholder; voice-render writes whatever bytes
        // the server returns, so any non-empty body passes the cache.
        const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
        return new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "X-Audio-Format": "wav",
            "X-Audio-Duration-Ms": "1000",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop(true),
    receivedTexts,
  };
}

let tmpDir: string;
let voicePath: string;
let cacheDir: string;
let originalCacheEnv: string | undefined;
let mock: MockedTts | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-voice-render-test-"));
  voicePath = join(tmpDir, "voice.json");
  cacheDir = join(tmpDir, "cache");
  _setPathForTesting(voicePath);
  originalCacheEnv = process.env.SUBCTL_VOICE_CACHE_DIR;
  process.env.SUBCTL_VOICE_CACHE_DIR = cacheDir;
});

afterEach(() => {
  _setPathForTesting(null);
  if (originalCacheEnv === undefined) {
    delete process.env.SUBCTL_VOICE_CACHE_DIR;
  } else {
    process.env.SUBCTL_VOICE_CACHE_DIR = originalCacheEnv;
  }
  if (mock) {
    mock.close();
    mock = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("renderVoice", () => {
  test("returns 'voice disabled' when voice.json.enabled=false", async () => {
    saveVoiceConfig({ enabled: false });
    const out = await renderVoice({ text: "hello" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("voice disabled");
  });

  test("rejects empty text", async () => {
    saveVoiceConfig({ enabled: true });
    const out = await renderVoice({ text: "   " });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("text required");
  });

  test("rejects text > 4000 chars", async () => {
    saveVoiceConfig({ enabled: true });
    const huge = "a".repeat(4001);
    const out = await renderVoice({ text: huge });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("exceeds 4000");
  });

  test("redacts secrets BEFORE sending text to TTS server", async () => {
    mock = startMockTts();
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    const text = "Token is sk-1234567890abcdefghij1234567890abcdefghij1234ABCD";
    const out = await renderVoice({ text });
    expect(out.ok).toBe(true);
    expect(mock.receivedTexts.length).toBe(1);
    // The raw sk-* token should NOT appear in what the TTS server received.
    expect(mock.receivedTexts[0]).not.toContain("sk-1234567890abcdef");
    expect(mock.receivedTexts[0]).toContain("[REDACTED]");
  });

  test("returns audio_url + writes to cache on first render", async () => {
    mock = startMockTts();
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    const out = await renderVoice({ text: "Evy here. Desk is clean." });
    expect(out.ok).toBe(true);
    expect(out.audio_url).toMatch(/^\/voice\/audio\/[a-f0-9]+\.wav$/);
    expect(out.cached).toBe(false);
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir).length).toBe(1);
  });

  test("second render with same text hits cache (no second TTS call)", async () => {
    mock = startMockTts();
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    const a = await renderVoice({ text: "cached line" });
    expect(a.ok).toBe(true);
    expect(a.cached).toBe(false);
    const b = await renderVoice({ text: "cached line" });
    expect(b.ok).toBe(true);
    expect(b.cached).toBe(true);
    expect(b.audio_url).toBe(a.audio_url);
    expect(mock.receivedTexts.length).toBe(1); // mock only received once
  });

  test("propagates TTS HTTP errors", async () => {
    mock = startMockTts({ failWith: 503 });
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    const out = await renderVoice({ text: "test" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("HTTP 503");
  });

  test("handles unreachable TTS server gracefully", async () => {
    saveVoiceConfig({
      enabled: true,
      tts_server: "http://127.0.0.1:1", // port 1 is reserved; not bound
    });
    const out = await renderVoice({ text: "test" });
    expect(out.ok).toBe(false);
    expect(out.error?.toLowerCase()).toMatch(/unreachable|connect|refused|fail/);
  });
});

describe("resolveCachedAudio", () => {
  test("returns null for path-traversal attempts", () => {
    expect(resolveCachedAudio("../../etc/passwd.txt")).toBeNull();
    expect(resolveCachedAudio("..%2Fetc.wav")).toBeNull();
    expect(resolveCachedAudio("/etc/passwd.wav")).toBeNull();
  });

  test("returns null when file is absent", () => {
    expect(resolveCachedAudio("deadbeef.wav")).toBeNull();
  });

  test("returns path + format for a real cached file", () => {
    mock = startMockTts();
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    return renderVoice({ text: "resolveCachedAudio test" }).then((r) => {
      const hashWithExt = r.audio_url!.replace(/^\/voice\/audio\//, "");
      const got = resolveCachedAudio(hashWithExt);
      expect(got).not.toBeNull();
      expect(got!.format).toBe("wav");
      expect(existsSync(got!.path)).toBe(true);
    });
  });
});

describe("probeTtsServer", () => {
  test("reports reachable when /health returns 200", async () => {
    mock = startMockTts();
    saveVoiceConfig({ enabled: true, tts_server: mock.url });
    const out = await probeTtsServer();
    expect(out.reachable).toBe(true);
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  test("reports unreachable on connection refused", async () => {
    saveVoiceConfig({ enabled: true, tts_server: "http://127.0.0.1:1" });
    const out = await probeTtsServer();
    expect(out.reachable).toBe(false);
    expect(out.error).toBeTruthy();
  });
});
