// components/master/profiles.ts
//
// v2.7.18 — Supervisor profiles. Two named bundles of {supervisor model,
// host} the operator switches between without editing providers.json or
// restarting the master daemon.
//
// Why: on 2026-05-13 the supervisor was qwen/qwen3.6-35b-a3b (heavy
// reasoning model). It got stuck in a tool-call loop and stopped
// responding to Telegram while the operator was on a 90-minute drive.
// The chat profile (gemma-4-31b) would have been responsive. Operator
// wants a one-click switch so daily chat uses a light model and heavy
// lifting uses a reasoning model.
//
// State lives at ~/.config/subctl/profiles.json (chmod 600):
//   {
//     "active": "chat",
//     "profiles": {
//       "chat":  { "supervisor": "google/gemma-4-31b",   "host": "http://localhost:1234/v1" },
//       "heavy": { "supervisor": "qwen/qwen3.6-35b-a3b", "host": "http://localhost:1234/v1" }
//     }
//   }
//
// On boot the master:
//   1. calls loadProfiles() to seed the file (from providers.json if
//      possible) and pick the active supervisor.
//   2. calls watchProfiles(onChange) which fs.watches the file. On change
//      it debounces 200ms, reloads, and fires the callback. The server
//      sets a `pendingProfileSwap` flag and rebuilds the model at the
//      START of the next prompt (NOT mid-turn).
//
// Profile switching never restarts master. The old supervisor stays
// loaded in LM Studio until the next prompt boundary; from there the
// agent talks to the new one.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { FSWatcher } from "node:fs";

// Resolved lazily so tests (and any operator who sets the env var after
// the module is imported by something at the top of the dependency
// graph) see the correct path. Captured at module-load time the function
// would lock in whatever was set when server.ts first pulled this file
// in, which makes tmpdir-scoped tests impossible.
function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}
function defaultProfilesPath(): string {
  return join(subctlConfigDir(), "profiles.json");
}

// Defaults — used when neither profiles.json nor a parseable
// providers.json gives us a model to seed from. Kept in sync with
// providers.json.example.
const DEFAULT_CHAT_MODEL = "google/gemma-4-31b";
const DEFAULT_HEAVY_MODEL = "qwen/qwen3.6-35b-a3b";
const DEFAULT_HOST = "http://localhost:1234/v1";

export type ProfileName = "chat" | "heavy";

export const PROFILE_NAMES: ReadonlyArray<ProfileName> = ["chat", "heavy"];

export interface ProfileEntry {
  supervisor: string;
  host: string;
}

export interface ProfilesFile {
  active: ProfileName;
  profiles: Record<ProfileName, ProfileEntry>;
}

// ─── path overrides for tests ────────────────────────────────────────────
// Tests inject a tmpdir-scoped path via _setPathForTesting() so they don't
// stomp the real ~/.config/subctl/profiles.json. Mirrors the pattern in
// components/master/secrets.ts.

let _pathOverride: string | null = null;

export function _setPathForTesting(p: string | null): void {
  _pathOverride = p;
}

function currentPath(): string {
  return _pathOverride ?? defaultProfilesPath();
}

// ─── seeding ─────────────────────────────────────────────────────────────

// Heuristic: a supervisor id "looks like gemma" if it contains "gemma"
// (case-insensitive). Same shape for qwen. Used to seed the chat / heavy
// profiles from an existing providers.json without forcing the operator
// to retype model ids.
function looksLikeGemma(model: string): boolean {
  return /gemma/i.test(model);
}
function looksLikeQwen(model: string): boolean {
  return /qwen/i.test(model);
}

interface MaybeProvidersJson {
  models?: {
    supervisor?: { model?: string; host?: string };
  };
}

function readProvidersSupervisor(): { model: string; host: string } | null {
  const providersPath = join(subctlConfigDir(), "master", "providers.json");
  if (!existsSync(providersPath)) return null;
  try {
    const raw = readFileSync(providersPath, "utf8");
    // Mirror server.ts: strip _comment lines + trailing commas before JSON.parse.
    const stripped = raw
      .split("\n")
      .filter((l) => !/^\s*"_comment[^"]*"\s*:/.test(l))
      .join("\n")
      .replace(/,(\s*[}\]])/g, "$1");
    const cfg = JSON.parse(stripped) as MaybeProvidersJson;
    const sup = cfg.models?.supervisor;
    if (!sup?.model) return null;
    return {
      model: sup.model,
      host: typeof sup.host === "string" && sup.host.length > 0
        ? sup.host
        : DEFAULT_HOST,
    };
  } catch {
    return null;
  }
}

function seedDefaults(): ProfilesFile {
  // Try to keep whatever the operator already configured in providers.json
  // as one of the two profiles, so a `chmod`-able toggle never silently
  // changes the model they were already on.
  const fromProviders = readProvidersSupervisor();
  let chat: ProfileEntry = { supervisor: DEFAULT_CHAT_MODEL, host: DEFAULT_HOST };
  let heavy: ProfileEntry = { supervisor: DEFAULT_HEAVY_MODEL, host: DEFAULT_HOST };
  let active: ProfileName = "chat";
  if (fromProviders) {
    if (looksLikeGemma(fromProviders.model)) {
      chat = { supervisor: fromProviders.model, host: fromProviders.host };
      active = "chat";
    } else if (looksLikeQwen(fromProviders.model)) {
      heavy = { supervisor: fromProviders.model, host: fromProviders.host };
      active = "heavy";
    }
    // Anything else: keep both hardcoded defaults — we don't know which
    // role the operator's current supervisor plays.
  }
  return {
    active,
    profiles: { chat, heavy },
  };
}

function writeFileSecure(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  // chmod 600 — profiles.json doesn't carry secrets today but the host
  // field could point at an internal LM Studio that uses a Require-API-Token
  // setup. Match the secrets.json hygiene rather than leaving 0644.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort — non-POSIX hosts (Windows shells under WSL) tolerate 0644 */
  }
}

// ─── public API ──────────────────────────────────────────────────────────

/**
 * Read profiles.json. If the file does not exist, seed it from
 * providers.json (when possible) and write it with chmod 600. On
 * unparseable file, falls back to seeded defaults and overwrites — we
 * never block boot on a corrupt profiles.json.
 */
export function loadProfiles(): ProfilesFile {
  const path = currentPath();
  if (!existsSync(path)) {
    const seeded = seedDefaults();
    writeFileSecure(path, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  let parsed: Partial<ProfilesFile>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProfilesFile>;
  } catch {
    const seeded = seedDefaults();
    writeFileSecure(path, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  return normalize(parsed);
}

function isProfileEntry(v: unknown): v is ProfileEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.supervisor === "string" && typeof e.host === "string";
}

function normalize(parsed: Partial<ProfilesFile>): ProfilesFile {
  const defaults = seedDefaults();
  const chat = isProfileEntry(parsed.profiles?.chat)
    ? parsed.profiles!.chat
    : defaults.profiles.chat;
  const heavy = isProfileEntry(parsed.profiles?.heavy)
    ? parsed.profiles!.heavy
    : defaults.profiles.heavy;
  // If parsed.active was something unexpected ("router", "", undefined),
  // fall back to "chat" — the first profile. Documented contract:
  // "Invalid active → falls back to first profile."
  const active: ProfileName =
    (PROFILE_NAMES as ReadonlyArray<string>).includes(parsed.active ?? "")
      ? (parsed.active as ProfileName)
      : "chat";
  return {
    active,
    profiles: { chat, heavy },
  };
}

/**
 * Return the currently-active profile entry. Convenience for callers
 * that don't care about the surrounding structure.
 */
export function getActiveProfile(): ProfileEntry & { name: ProfileName } {
  const file = loadProfiles();
  return { name: file.active, ...file.profiles[file.active] };
}

/**
 * Set the active profile and persist the file. Throws on an unknown
 * profile name — the caller is expected to validate user input before
 * calling, but the throw is a hard contract for the test suite too.
 */
export function setActiveProfile(name: string): ProfilesFile {
  if (!(PROFILE_NAMES as ReadonlyArray<string>).includes(name)) {
    throw new Error(
      `unknown profile "${name}". valid: ${PROFILE_NAMES.join(", ")}`,
    );
  }
  const current = loadProfiles();
  const next: ProfilesFile = {
    active: name as ProfileName,
    profiles: current.profiles,
  };
  writeFileSecure(currentPath(), JSON.stringify(next, null, 2));
  return next;
}

/**
 * fs.watch profiles.json. Debounce 200ms — the fs.watch event fires
 * twice on macOS (one for the rename, one for the new inode being
 * created) when an editor saves via the atomic-rename pattern. The
 * callback receives the freshly-loaded profile so the caller doesn't
 * have to re-read.
 *
 * Returns a handle with `close()` so the daemon can dispose the watcher
 * cleanly on shutdown.
 */
export function watchProfiles(
  onChange: (file: ProfilesFile) => void,
): { close: () => void } {
  const path = currentPath();
  // Ensure the file exists before watching — fs.watch on a missing file
  // errors immediately. loadProfiles() creates it if absent.
  loadProfiles();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(path, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const reloaded = loadProfiles();
          onChange(reloaded);
        } catch (err) {
          console.error(
            `[profile] watcher reload failed: ${(err as Error).message}`,
          );
        }
      }, 200);
    });
  } catch (err) {
    console.error(`[profile] fs.watch failed: ${(err as Error).message}`);
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

// ─── test helpers ────────────────────────────────────────────────────────

/**
 * Force-reset the in-memory state. profiles.ts is stateless today
 * (every call re-reads from disk), so this is a no-op kept for symmetry
 * with secrets.ts in case we add caching later.
 */
export function _resetForTesting(): void {
  // intentionally empty — see comment above
}
