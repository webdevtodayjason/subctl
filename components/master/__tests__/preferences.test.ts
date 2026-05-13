// components/master/__tests__/preferences.test.ts
//
// v2.8.1 — Operator preferences. Bilateral-maintenance config store at
// ~/.config/subctl/preferences.toml that both the operator (direct edit,
// CLI, dashboard, /prefs) and Evy (evy_set_preference tool) write to.
//
// These tests pin: seed-on-missing + chmod 600, get/set/list round-trip,
// merge-write preserving existing TOML structure + comments,
// watchPreferences debounce + reload, and renderPreferencesForPrompt
// markdown shape. Each test runs in an isolated tmpdir so the operator's
// real preferences file is never touched.

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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _setPathForTesting,
  deletePreference,
  getPreference,
  getPreferenceMeta,
  listPreferences,
  loadPreferences,
  renderPreferencesForPrompt,
  resetPreferences,
  setPreference,
  watchPreferences,
} from "../preferences";

let tmpDir: string;
let prefsPath: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subctl-prefs-test-"));
  prefsPath = join(tmpDir, "preferences.toml");
  _setPathForTesting(prefsPath);
  savedConfigDir = process.env.SUBCTL_CONFIG_DIR;
  process.env.SUBCTL_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  _setPathForTesting(null);
  if (savedConfigDir === undefined) delete process.env.SUBCTL_CONFIG_DIR;
  else process.env.SUBCTL_CONFIG_DIR = savedConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── loadPreferences ─────────────────────────────────────────────────────

describe("loadPreferences", () => {
  test("seeds defaults when file is missing", () => {
    expect(existsSync(prefsPath)).toBe(false);
    const prefs = loadPreferences();
    expect(existsSync(prefsPath)).toBe(true);
    // Spot-check the four seed categories the operator pinned in the spec.
    expect(prefs.communication?.preferred_channel).toBe("telegram");
    expect(prefs.communication?.audio_preferred).toBe(true);
    expect(prefs.coding?.test_first).toBe("preferred");
    expect(prefs.reports?.default_format).toBe("markdown_terse");
    expect(prefs.agent_behavior?.shutdown_idle_workers).toBe(true);
  });

  test("seeded file is chmod 600 on POSIX", () => {
    loadPreferences();
    const mode = statSync(prefsPath).mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  test("seeded file retains the comment preamble", () => {
    loadPreferences();
    const raw = readFileSync(prefsPath, "utf8");
    expect(raw).toContain("# Operator preferences for subctl.");
    // Inline category comment from the seed should also be present —
    // the operator explicitly wanted these visible when they $EDITOR the file.
    expect(raw).toContain("# voice notes for routine status");
  });

  test("recovers from unparseable file by re-seeding", () => {
    writeFileSync(prefsPath, "{{ not toml at all");
    const prefs = loadPreferences();
    expect(prefs.communication?.preferred_channel).toBe("telegram");
    // File on disk is now valid TOML again.
    const raw = readFileSync(prefsPath, "utf8");
    expect(raw).toContain("[communication]");
  });

  test("loads from an existing operator-edited file", () => {
    writeFileSync(
      prefsPath,
      `[communication]\npreferred_channel = "dashboard"\n\n[custom]\nfoo = 42\nbar = "baz"\n`,
    );
    const prefs = loadPreferences();
    expect(prefs.communication?.preferred_channel).toBe("dashboard");
    // Operator-added category survives.
    expect(prefs.custom?.foo).toBe(42);
    expect(prefs.custom?.bar).toBe("baz");
  });
});

// ─── getPreference ───────────────────────────────────────────────────────

describe("getPreference", () => {
  test("returns the file value when present", () => {
    loadPreferences();
    setPreference("communication", "preferred_channel", "dashboard");
    expect(getPreference("communication", "preferred_channel")).toBe("dashboard");
  });

  test("falls back to the SEED default when the key is absent in the file but present in defaults", () => {
    // Write a file with NO communication section to verify the seed
    // fallback short-circuits.
    writeFileSync(prefsPath, `[custom]\nfoo = 1\n`);
    expect(getPreference("communication", "preferred_channel")).toBe("telegram");
  });

  test("returns undefined for genuinely unknown keys", () => {
    loadPreferences();
    expect(getPreference("communication", "no_such_key")).toBeUndefined();
    expect(getPreference("no_such_category", "anything")).toBeUndefined();
  });
});

// ─── listPreferences ─────────────────────────────────────────────────────

describe("listPreferences", () => {
  test("flat list across every category by default", () => {
    loadPreferences();
    const all = listPreferences();
    expect(all.length).toBeGreaterThan(8);
    const cats = new Set(all.map((e) => e.category));
    expect(cats.has("communication")).toBe(true);
    expect(cats.has("coding")).toBe(true);
    expect(cats.has("reports")).toBe(true);
    expect(cats.has("agent_behavior")).toBe(true);
  });

  test("filters by category", () => {
    loadPreferences();
    const comm = listPreferences("communication");
    expect(comm.length).toBeGreaterThan(0);
    expect(comm.every((e) => e.category === "communication")).toBe(true);
  });
});

// ─── setPreference ───────────────────────────────────────────────────────

describe("setPreference", () => {
  test("round-trips through disk", () => {
    loadPreferences();
    setPreference("communication", "report_length", "verbose");
    // Re-read fresh from disk.
    const reread = loadPreferences();
    expect(reread.communication?.report_length).toBe("verbose");
  });

  test("preserves existing comments + ordering on update", () => {
    loadPreferences();
    const before = readFileSync(prefsPath, "utf8");
    expect(before).toContain("# Operator preferences for subctl.");
    setPreference("communication", "preferred_channel", "dashboard");
    const after = readFileSync(prefsPath, "utf8");
    // Preamble comment survives.
    expect(after).toContain("# Operator preferences for subctl.");
    // Inline comment on the changed line should also survive — the
    // regex-aware merge replaces only the value portion.
    expect(after).toContain("preferred_channel = \"dashboard\"");
    expect(after).toContain("# telegram | dashboard | both");
    // The next sibling key in the same section should still be present
    // and untouched.
    expect(after).toContain("audio_preferred = true");
  });

  test("coerces 'true' / 'false' / numeric strings", () => {
    loadPreferences();
    setPreference("communication", "audio_preferred", "false");
    expect(getPreference("communication", "audio_preferred")).toBe(false);
    setPreference("communication", "status_update_cadence_minutes", "10");
    expect(getPreference("communication", "status_update_cadence_minutes")).toBe(10);
  });

  test("adds a new key inside an existing category", () => {
    loadPreferences();
    setPreference("communication", "new_knob", "yes");
    const reread = loadPreferences();
    expect(reread.communication?.new_knob).toBe("yes");
    // Existing keys still there.
    expect(reread.communication?.preferred_channel).toBe("telegram");
  });

  test("adds a new category for operator-defined extension", () => {
    loadPreferences();
    setPreference("ops_custom", "favorite_color", "pink");
    const reread = loadPreferences();
    expect(reread.ops_custom?.favorite_color).toBe("pink");
    // Original categories untouched.
    expect(reread.communication?.preferred_channel).toBe("telegram");
  });

  test("rejects invalid category/key names", () => {
    loadPreferences();
    expect(() => setPreference("9bad", "x", "y")).toThrow(/category/i);
    expect(() => setPreference("ok", "bad name", "y")).toThrow(/key/i);
    expect(() => setPreference("", "x", "y")).toThrow();
  });

  test("records 'by' metadata in the sidecar", () => {
    loadPreferences();
    setPreference("communication", "report_length", "verbose", "evy", "learned during conversation");
    const meta = getPreferenceMeta("communication", "report_length");
    expect(meta.by).toBe("evy");
    expect(meta.reason).toBe("learned during conversation");
    expect(meta.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    setPreference("communication", "report_length", "terse", "operator");
    expect(getPreferenceMeta("communication", "report_length").by).toBe("operator");
  });
});

// ─── deletePreference ────────────────────────────────────────────────────

describe("deletePreference", () => {
  test("removes the line and leaves surroundings intact", () => {
    loadPreferences();
    setPreference("communication", "removable", "yes");
    const removed = deletePreference("communication", "removable");
    expect(removed).toBe(true);
    const reread = loadPreferences();
    expect(reread.communication?.removable).toBeUndefined();
    expect(reread.communication?.preferred_channel).toBe("telegram");
  });

  test("returns false when the key wasn't present", () => {
    loadPreferences();
    expect(deletePreference("communication", "never_existed")).toBe(false);
  });
});

// ─── resetPreferences ────────────────────────────────────────────────────

describe("resetPreferences", () => {
  test("restores seeded defaults", () => {
    loadPreferences();
    setPreference("communication", "preferred_channel", "dashboard");
    setPreference("ops_custom", "foo", "bar");
    resetPreferences();
    const reread = loadPreferences();
    expect(reread.communication?.preferred_channel).toBe("telegram");
    expect(reread.ops_custom?.foo).toBeUndefined();
  });
});

// ─── watchPreferences ────────────────────────────────────────────────────

describe("watchPreferences", () => {
  test("fires onChange when the file is rewritten", async () => {
    loadPreferences();
    let fired: ReturnType<typeof loadPreferences> | null = null;
    const handle = watchPreferences((prefs) => {
      fired = prefs;
    });
    try {
      setPreference("communication", "preferred_channel", "dashboard");
      const deadline = Date.now() + 600;
      while (Date.now() < deadline && fired === null) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fired).not.toBeNull();
      expect(fired!.communication?.preferred_channel).toBe("dashboard");
    } finally {
      handle.close();
    }
  });

  test("close() halts further callbacks", async () => {
    loadPreferences();
    let count = 0;
    const handle = watchPreferences(() => {
      count++;
    });
    handle.close();
    setPreference("communication", "preferred_channel", "dashboard");
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(0);
  });
});

// ─── renderPreferencesForPrompt ──────────────────────────────────────────

describe("renderPreferencesForPrompt", () => {
  test("emits a clearly-labeled markdown block", () => {
    loadPreferences();
    const md = renderPreferencesForPrompt();
    expect(md).toContain("Your operator's preferences");
    // Humanized category headers.
    expect(md).toContain("**Communication**");
    expect(md).toContain("**Coding**");
    // A specific value should render with the human-friendly key.
    expect(md).toContain("Preferred Channel: telegram");
    // booleans render as yes/no
    expect(md).toContain("Audio Preferred: yes");
  });

  test("includes operator-added categories", () => {
    loadPreferences();
    setPreference("project_specific", "deploy_window", "after_5pm_central");
    const md = renderPreferencesForPrompt();
    expect(md).toContain("**Project Specific**");
    expect(md).toContain("Deploy Window: after_5pm_central");
  });
});
