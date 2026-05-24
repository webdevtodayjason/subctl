// components/evy/__tests__/profiles.test.ts
//
// v2.7.18 — Supervisor profiles. Two named profiles ("chat" and "heavy")
// the operator switches between at the start of the next prompt without
// restarting master.
//
// These tests pin the loadProfiles / getActiveProfile / setActiveProfile
// contracts plus the fs.watch debounce + reload behavior. Each test
// runs in an isolated tmpdir via _setPathForTesting so we never touch
// the real ~/.config/subctl/profiles.json.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROFILE_NAMES,
  _setPathForTesting,
  getActiveProfile,
  loadProfiles,
  setActiveProfile,
  setProfileEntry,
  watchProfiles,
} from "../profiles";

let tmpDir: string;
let profilesPath: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-profiles-test-"));
  profilesPath = join(tmpDir, "profiles.json");
  _setPathForTesting(profilesPath);
  // Point SUBCTL_CONFIG_DIR at the tmpdir so the seeder's
  // providers.json sniff misses cleanly. Without this, the real
  // ~/.config/subctl/evy/providers.json contaminates the "seed
  // from defaults" tests on a developer machine.
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  process.env.SUBCTL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  _setPathForTesting(null);
  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── loadProfiles ────────────────────────────────────────────────────────

describe("loadProfiles", () => {
  test("seeds defaults when file is missing", () => {
    expect(existsSync(profilesPath)).toBe(false);
    const file = loadProfiles();
    // File should now exist (seeded on first call).
    expect(existsSync(profilesPath)).toBe(true);
    // Default active is "chat".
    expect(file.active).toBe("chat");
    // Both profiles populated with hardcoded defaults (gemma + qwen).
    expect(file.profiles.chat.supervisor).toMatch(/gemma/i);
    expect(file.profiles.heavy.supervisor).toMatch(/qwen/i);
    expect(file.profiles.chat.host).toMatch(/^https?:\/\//);
    expect(file.profiles.heavy.host).toMatch(/^https?:\/\//);
  });

  test("loads from an existing valid file", () => {
    const fixture = {
      active: "heavy",
      profiles: {
        chat: { supervisor: "custom/gemma-x", host: "http://other:9999/v1" },
        heavy: { supervisor: "custom/qwen-y", host: "http://other:9999/v1" },
      },
    };
    writeFileSync(profilesPath, JSON.stringify(fixture, null, 2));
    const file = loadProfiles();
    expect(file.active).toBe("heavy");
    expect(file.profiles.chat.supervisor).toBe("custom/gemma-x");
    expect(file.profiles.heavy.supervisor).toBe("custom/qwen-y");
    expect(file.profiles.heavy.host).toBe("http://other:9999/v1");
  });

  test("falls back to first profile when 'active' is unknown", () => {
    const fixture = {
      active: "ludicrous",
      profiles: {
        chat: { supervisor: "a", host: "h" },
        heavy: { supervisor: "b", host: "h" },
      },
    };
    writeFileSync(profilesPath, JSON.stringify(fixture));
    const file = loadProfiles();
    // First profile name in PROFILE_NAMES is "chat" — that's the documented
    // fallback per spec.
    expect(file.active).toBe("chat");
    expect(PROFILE_NAMES[0]).toBe("chat");
  });

  test("overwrites and seeds on unparseable JSON", () => {
    writeFileSync(profilesPath, "{ this is not json");
    const file = loadProfiles();
    // Recovered by seeding defaults — must produce something we can use.
    expect(file.active).toBe("chat");
    expect(file.profiles.chat.supervisor.length).toBeGreaterThan(0);
    // The file on disk is now valid JSON again.
    const re = readFileSync(profilesPath, "utf8");
    expect(() => JSON.parse(re)).not.toThrow();
  });

  test("seeded file is chmod 600 on POSIX", () => {
    loadProfiles();
    const mode = statSync(profilesPath).mode & 0o777;
    // 0o600 expected on Linux/macOS; Windows-style filesystems may report
    // 0o666, so guard.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  test("missing 'profiles.chat' is filled in from defaults", () => {
    const fixture = {
      active: "chat",
      profiles: {
        heavy: { supervisor: "x/y", host: "h" },
      },
    };
    writeFileSync(profilesPath, JSON.stringify(fixture));
    const file = loadProfiles();
    expect(file.profiles.chat.supervisor.length).toBeGreaterThan(0);
    expect(file.profiles.heavy.supervisor).toBe("x/y");
  });
});

// ─── getActiveProfile ────────────────────────────────────────────────────

describe("getActiveProfile", () => {
  test("returns the resolved entry with name", () => {
    const fixture = {
      active: "heavy",
      profiles: {
        chat: { supervisor: "a/b", host: "ha" },
        heavy: { supervisor: "c/d", host: "hc" },
      },
    };
    writeFileSync(profilesPath, JSON.stringify(fixture));
    const active = getActiveProfile();
    expect(active.name).toBe("heavy");
    expect(active.supervisor).toBe("c/d");
    expect(active.host).toBe("hc");
  });
});

// ─── setActiveProfile ────────────────────────────────────────────────────

describe("setActiveProfile", () => {
  test("persists the new active and leaves entries intact", () => {
    loadProfiles(); // seed
    const before = loadProfiles();
    const next = setActiveProfile("heavy");
    expect(next.active).toBe("heavy");
    // Re-read from disk to confirm persistence.
    const reread = loadProfiles();
    expect(reread.active).toBe("heavy");
    // Profile entries unchanged.
    expect(reread.profiles.chat.supervisor).toBe(before.profiles.chat.supervisor);
    expect(reread.profiles.heavy.supervisor).toBe(before.profiles.heavy.supervisor);
  });

  test("throws on an unknown profile name", () => {
    loadProfiles();
    expect(() => setActiveProfile("ludicrous")).toThrow(/unknown profile/i);
    expect(() => setActiveProfile("")).toThrow(/unknown profile/i);
  });
});

// ─── setProfileEntry ─────────────────────────────────────────────────────
//
// v2.8.7. The dashboard's POST /api/master/supervisor handler calls this
// after editing providers.json so master's boot-time override of supervisor
// model + host (from profiles.json[active]) doesn't silently clobber the
// operator's dropdown pick. Same validation contract as setActiveProfile.

describe("setProfileEntry", () => {
  test("persists the new supervisor + host for a profile", () => {
    loadProfiles(); // seed
    const next = setProfileEntry("chat", {
      supervisor: "openai-codex/gpt-5.5",
      host: "",
    });
    expect(next.profiles.chat.supervisor).toBe("openai-codex/gpt-5.5");
    expect(next.profiles.chat.host).toBe("");
    // Re-read from disk to confirm persistence.
    const reread = loadProfiles();
    expect(reread.profiles.chat.supervisor).toBe("openai-codex/gpt-5.5");
    expect(reread.profiles.chat.host).toBe("");
  });

  test("leaves the OTHER profile untouched and the active pointer alone", () => {
    loadProfiles();
    const before = loadProfiles();
    setActiveProfile("heavy");
    setProfileEntry("chat", {
      supervisor: "lmstudio/qwen/qwen3.6-27b",
      host: "http://localhost:1234/v1",
    });
    const after = loadProfiles();
    expect(after.active).toBe("heavy"); // active pointer NOT changed
    expect(after.profiles.heavy.supervisor).toBe(
      before.profiles.heavy.supervisor,
    );
    expect(after.profiles.chat.supervisor).toBe("lmstudio/qwen/qwen3.6-27b");
  });

  test("empty-string host is a legal value (cloud providers use it)", () => {
    loadProfiles();
    const next = setProfileEntry("chat", {
      supervisor: "anthropic/claude-sonnet-4-6",
      host: "",
    });
    expect(next.profiles.chat.host).toBe("");
  });

  test("throws on an unknown profile name", () => {
    loadProfiles();
    expect(() =>
      setProfileEntry("ludicrous", { supervisor: "x", host: "" }),
    ).toThrow(/unknown profile/i);
    expect(() =>
      setProfileEntry("", { supervisor: "x", host: "" }),
    ).toThrow(/unknown profile/i);
  });

  test("throws when supervisor is not a string", () => {
    loadProfiles();
    expect(() =>
      setProfileEntry("chat", {
        supervisor: undefined as unknown as string,
        host: "",
      }),
    ).toThrow(/supervisor/i);
  });

  test("throws when host is not a string (must use \"\" for absent)", () => {
    loadProfiles();
    expect(() =>
      setProfileEntry("chat", {
        supervisor: "x",
        host: null as unknown as string,
      }),
    ).toThrow(/host/i);
  });

  test("persists the new entry with chmod 600", () => {
    loadProfiles();
    setProfileEntry("chat", { supervisor: "x", host: "" });
    const mode = statSync(profilesPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── watchProfiles ───────────────────────────────────────────────────────

describe("watchProfiles", () => {
  test("fires onChange when the file is rewritten (within 500ms)", async () => {
    loadProfiles(); // ensure the file exists so fs.watch can attach
    let fired: { active: string } | null = null;
    const handle = watchProfiles((file) => {
      fired = { active: file.active };
    });
    try {
      // Write a new active to the file. fs.watch event → 200ms debounce
      // → callback runs.
      setActiveProfile("heavy");
      // Poll for up to 500ms — spec target. Tightened from a fixed wait
      // because macOS fs.watch latency varies.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && fired === null) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fired).not.toBeNull();
      expect(fired!.active).toBe("heavy");
    } finally {
      handle.close();
    }
  });

  test("close() stops further callbacks", async () => {
    loadProfiles();
    let count = 0;
    const handle = watchProfiles(() => {
      count += 1;
    });
    handle.close();
    // After close, writes should NOT fire the callback. We can't guarantee
    // zero races on every platform, but a write + 300ms wait is a sane
    // upper bound for the in-flight debounce.
    setActiveProfile("heavy");
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });
});
