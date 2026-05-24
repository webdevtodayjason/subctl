// components/evy/preferences.ts
//
// v2.8.1 — Operator preferences. Bilateral-maintenance config that both
// the operator AND Evy can update. Distinct from profiles.json (model
// selection), policy.json (autonomy rules), personality (voice), and Evy
// Memory (conversational recall): preferences are the structured "how I
// like to be communicated with / coded for / reported to" knobs.
//
// Origin: operator request 2026-05-13. Quote:
//   "We need an operator preferences section that both me and the agent
//    can maintain. Examples: I prefer audio over Telegram versus text,
//    I prefer this coding style, I prefer this type of report."
//
// The bilateral edit story is the load-bearing requirement:
//   • Operator edits the TOML file directly when they have something to
//     set ("/prefs set communication.report_length terse", or open in
//     $EDITOR, or POST from the dashboard).
//   • Evy invokes `evy_set_preference` when she learns one in
//     conversation ("actually keep responses shorter" → she calls the
//     tool with by="evy" and a reason captured for the audit log).
//
// Schema is intentionally NOT enforced strictly — categories and keys
// are free-form strings so the operator can add `[reports]/footer_quote`
// or whatever else without us shipping a schema bump. Seed defaults
// give Evy a working set on first boot.
//
// On-disk shape mirrors profiles.json hygiene: chmod 600, dir chmod 700.
// Writes go through a regex-aware merge so existing comments + key
// ordering survive a setPreference call (smol-toml's stringify drops
// comments entirely). On unparseable input we never block — fall back
// to seeded defaults and log a warning.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { parse as parseToml } from "smol-toml";

// ─── path resolution ────────────────────────────────────────────────────
//
// Mirrors profiles.ts: resolve lazily so tests that set SUBCTL_CONFIG_DIR
// after import-time see the override. Tests can also inject an absolute
// path via _setPathForTesting().

function subctlConfigDir(): string {
  return process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
}

function defaultPreferencesPath(): string {
  return join(subctlConfigDir(), "preferences.toml");
}

let _pathOverride: string | null = null;

/** @internal — test-only. Pass null to clear. */
export function _setPathForTesting(p: string | null): void {
  _pathOverride = p;
}

function currentPath(): string {
  return _pathOverride ?? defaultPreferencesPath();
}

// ─── public types ───────────────────────────────────────────────────────

export type PreferenceValue = string | number | boolean;

export interface PreferenceEntry {
  category: string;
  key: string;
  value: PreferenceValue;
}

export type PreferencesObject = Record<string, Record<string, PreferenceValue>>;

export interface SetByMeta {
  /** Who set this value most recently. */
  by: "operator" | "evy" | "default";
  /** Optional reason captured when Evy writes (audit log). */
  reason?: string;
  /** ISO timestamp of the write. */
  at: string;
}

/** Tracks "set_by" metadata in a sidecar JSON file (preferences.meta.json). */
type MetaIndex = Record<string, Record<string, SetByMeta>>;

// ─── seed defaults ──────────────────────────────────────────────────────
//
// Embedded as a TOML string so the comments survive into the file the
// operator opens in $EDITOR. Categories beyond these can be added freely
// at runtime — we don't enforce a closed schema.

const SEED_TOML = `# Operator preferences for subctl. Edited by Jason directly, or
# by Evy when she learns one from conversation. Reloaded on
# every change via fs.watch.
#
# Schema is intentionally loose — add categories and keys freely.
# Evy reads this file via renderPreferencesForPrompt() at the start
# of every turn.

[communication]
preferred_channel = "telegram"        # telegram | dashboard | both
audio_preferred = true                 # voice notes for routine status, text otherwise
report_length = "terse"                # terse | normal | verbose
status_update_cadence_minutes = 5

[coding]
style_guide = ""                       # operator can paste a URL or short text
test_first = "preferred"               # required | preferred | optional
preferred_test_runner = "bun test"
comment_density = "low"                # low | medium | high

[reports]
default_format = "markdown_terse"      # markdown_terse | markdown_full | plain_text
include_metrics = true
include_open_questions = true
end_with_next_action = true

[agent_behavior]
ask_before_destructive = true
dispatch_parallel_by_default = true    # operator preference from 2026-05-13
shutdown_idle_workers = true
loud_when_dry = true
`;

/**
 * Default preference values, mirrored from SEED_TOML. Used when callers
 * recall() against a category/key that doesn't exist yet so renderers
 * see consistent shape.
 */
const SEED_OBJECT: PreferencesObject = {
  communication: {
    preferred_channel: "telegram",
    audio_preferred: true,
    report_length: "terse",
    status_update_cadence_minutes: 5,
  },
  coding: {
    style_guide: "",
    test_first: "preferred",
    preferred_test_runner: "bun test",
    comment_density: "low",
  },
  reports: {
    default_format: "markdown_terse",
    include_metrics: true,
    include_open_questions: true,
    end_with_next_action: true,
  },
  agent_behavior: {
    ask_before_destructive: true,
    dispatch_parallel_by_default: true,
    shutdown_idle_workers: true,
    loud_when_dry: true,
  },
};

// ─── filesystem hygiene ─────────────────────────────────────────────────

function writeFileSecure(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Re-chmod the parent dir defensively (a permissive umask wouldn't
  // re-narrow a directory that already existed at 0755).
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort — non-POSIX hosts tolerate 0755 */
  }
  writeFileSync(path, contents);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

// ─── meta sidecar ───────────────────────────────────────────────────────
//
// "Who set this?" metadata lives in a sidecar JSON file so we never have
// to round-trip + lose user-authored TOML comments to record an audit
// stamp. The sidecar is rebuilt lazily; missing entries report as "default".

function metaPath(): string {
  return currentPath().replace(/\.toml$/i, ".meta.json");
}

function loadMeta(): MetaIndex {
  const p = metaPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MetaIndex;
    }
    return {};
  } catch {
    return {};
  }
}

function saveMeta(meta: MetaIndex): void {
  writeFileSecure(metaPath(), JSON.stringify(meta, null, 2));
}

// ─── parse / load ───────────────────────────────────────────────────────

function castValue(v: unknown): PreferenceValue | undefined {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

function normalizeParsed(parsed: unknown): PreferencesObject {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: PreferencesObject = {};
  for (const [cat, body] of Object.entries(parsed as Record<string, unknown>)) {
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const inner: Record<string, PreferenceValue> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const cast = castValue(v);
      if (cast !== undefined) inner[k] = cast;
      // Nested tables / arrays are silently dropped — preferences are
      // flat key/value bags by design.
    }
    out[cat] = inner;
  }
  return out;
}

/**
 * Read preferences.toml. Seeds defaults (with comments) on first call.
 * Unparseable file → seed defaults and overwrite (we never block boot
 * on a corrupt config).
 */
export function loadPreferences(): PreferencesObject {
  const path = currentPath();
  if (!existsSync(path)) {
    writeFileSecure(path, SEED_TOML);
    return JSON.parse(JSON.stringify(SEED_OBJECT)) as PreferencesObject;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return JSON.parse(JSON.stringify(SEED_OBJECT)) as PreferencesObject;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    console.error(
      `[preferences] preferences.toml unparseable, re-seeding defaults: ${(err as Error).message}`,
    );
    writeFileSecure(path, SEED_TOML);
    return JSON.parse(JSON.stringify(SEED_OBJECT)) as PreferencesObject;
  }
  return normalizeParsed(parsed);
}

/**
 * Read a single preference value. Returns the live value, the SEED
 * default if unset, or `undefined` if there's no default either.
 */
export function getPreference(
  category: string,
  key: string,
): PreferenceValue | undefined {
  const prefs = loadPreferences();
  const fromFile = prefs[category]?.[key];
  if (fromFile !== undefined) return fromFile;
  return SEED_OBJECT[category]?.[key];
}

/**
 * Flat list of every preference entry. Filter by category if provided.
 * Order: category alphabetic, keys in insertion order (which mirrors
 * file order for TOML).
 */
export function listPreferences(category?: string): PreferenceEntry[] {
  const prefs = loadPreferences();
  const cats = category ? [category] : Object.keys(prefs).sort();
  const out: PreferenceEntry[] = [];
  for (const cat of cats) {
    const body = prefs[cat];
    if (!body) continue;
    for (const [k, v] of Object.entries(body)) {
      out.push({ category: cat, key: k, value: v });
    }
  }
  return out;
}

/** Returns the SetByMeta for a single preference. "default" when unset. */
export function getPreferenceMeta(category: string, key: string): SetByMeta {
  const meta = loadMeta();
  const hit = meta[category]?.[key];
  if (hit) return hit;
  return { by: "default", at: "" };
}

// ─── TOML regex-aware merge ─────────────────────────────────────────────
//
// smol-toml's stringify() drops comments, so we'd lose the entire seed
// preamble + inline category guidance on the first setPreference. Two
// alternatives:
//
//   (a) Use smol-toml round-trip and accept comment loss. Operator
//       complained explicitly about wanting the comments — rejected.
//   (b) Hand-roll a regex-aware merge: locate the [category] section,
//       locate the key= line inside it, replace just the value. Append
//       at the right place when the key/category is new.
//
// We do (b). The grammar we support is the subset preferences.toml
// actually uses: flat string/bool/number values, simple [section]
// headers, line-anchored key/value pairs. Multi-line strings, arrays,
// and nested tables aren't part of the preferences contract and will
// pass through untouched (we only mutate matched lines).

const SECTION_RE = /^\s*\[([^\]\s]+)\]\s*(#.*)?$/;
const KEY_LINE_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*=\s*)(.+?)(\s*#.*)?\s*$/;

function formatTomlValue(v: PreferenceValue): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // String — quote with JSON.stringify so backslashes/quotes are escaped.
  return JSON.stringify(String(v));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Write `value` for `[category].key` while preserving the rest of the
 * file (including comments + ordering) as faithfully as possible.
 *
 * Cases:
 *   • category + key both exist → replace just the value portion of
 *     the matched line; inline trailing comment survives.
 *   • category exists, key new → insert a new line at the end of the
 *     section.
 *   • category new → append `[category]\nkey = value\n` to the file.
 *   • file missing → seed first via loadPreferences(), then re-call.
 */
function mergeWrite(
  category: string,
  key: string,
  value: PreferenceValue,
): void {
  const path = currentPath();
  if (!existsSync(path)) {
    writeFileSecure(path, SEED_TOML);
  }
  let raw = readFileSync(path, "utf8");
  // Normalize line endings on read; write back with whatever the file used.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";

  const lines = raw.split(/\r?\n/);
  const newValue = formatTomlValue(value);

  let inCategory = false;
  let categoryStart = -1; // index of `[category]` header
  let categoryEnd = -1;   // index of last line that belongs to the category (exclusive bound below)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const secMatch = line.match(SECTION_RE);
    if (secMatch) {
      if (inCategory) {
        categoryEnd = i;
        break;
      }
      if (secMatch[1] === category) {
        inCategory = true;
        categoryStart = i;
        continue;
      }
      continue;
    }
    if (!inCategory) continue;
    const keyMatch = line.match(KEY_LINE_RE);
    if (keyMatch && keyMatch[2] === key) {
      // Replace just the value portion. Preserve indentation + trailing
      // comment.
      const indent = keyMatch[1] ?? "";
      const eq = keyMatch[3] ?? " = ";
      const trailing = keyMatch[5] ?? "";
      lines[i] = `${indent}${key}${eq}${newValue}${trailing}`;
      writeFileSecure(path, lines.join(eol));
      return;
    }
  }
  if (inCategory && categoryEnd === -1) {
    // Category runs to EOF.
    categoryEnd = lines.length;
  }

  if (categoryStart >= 0) {
    // Insert a new key inside the existing section. Skip trailing blank
    // lines that visually separate the section from the next one — we
    // want the new key glued to the section body, not floating between
    // sections.
    let insertAt = categoryEnd;
    while (insertAt > categoryStart + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
      insertAt--;
    }
    lines.splice(insertAt, 0, `${key} = ${newValue}`);
    writeFileSecure(path, lines.join(eol));
    return;
  }

  // Category not present — append a new section. Ensure there's a blank
  // line between the previous content and the new section.
  const needsSep = raw.length > 0 && !raw.endsWith(eol + eol) && !raw.endsWith("\n\n");
  const sep = raw.length === 0 ? "" : needsSep ? eol + eol : "";
  const appended = `${raw}${sep}[${category}]${eol}${key} = ${newValue}${eol}`;
  writeFileSecure(path, appended);
  // Sanity: if we just appended without a trailing newline, make sure
  // future reads don't concatenate lines.
  void escapeRegex; // retained for future fuzzy-match extensions
}

// ─── set / delete ───────────────────────────────────────────────────────

/**
 * Persist a preference. `by` records who's making the change for the
 * audit metadata sidecar; `reason` is captured when Evy is the writer.
 * Returns the materialized value (after coercion).
 */
export function setPreference(
  category: string,
  key: string,
  value: PreferenceValue,
  by: "operator" | "evy" = "operator",
  reason?: string,
): PreferenceEntry {
  validateName(category, "category");
  validateName(key, "key");
  const coerced = coerceValue(value);
  mergeWrite(category, key, coerced);

  // Update sidecar metadata. Never throws — audit is best-effort.
  try {
    const meta = loadMeta();
    if (!meta[category]) meta[category] = {};
    const entry: SetByMeta = { by, at: new Date().toISOString() };
    if (reason && reason.trim()) entry.reason = reason.trim().slice(0, 240);
    meta[category]![key] = entry;
    saveMeta(meta);
  } catch (err) {
    console.error(
      `[preferences] meta write failed: ${(err as Error).message ?? err}`,
    );
  }

  return { category, key, value: coerced };
}

/**
 * Remove a preference. If the file didn't have it set, this is a no-op
 * (returns false). Comments + adjacent keys are left undisturbed.
 */
export function deletePreference(category: string, key: string): boolean {
  validateName(category, "category");
  validateName(key, "key");
  const path = currentPath();
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let inCategory = false;
  let removed = false;
  const next: string[] = [];
  for (const line of lines) {
    const secMatch = line.match(SECTION_RE);
    if (secMatch) {
      inCategory = secMatch[1] === category;
      next.push(line);
      continue;
    }
    if (inCategory) {
      const keyMatch = line.match(KEY_LINE_RE);
      if (keyMatch && keyMatch[2] === key) {
        removed = true;
        continue; // drop the line
      }
    }
    next.push(line);
  }
  if (removed) {
    writeFileSecure(path, next.join(eol));
    // Also drop the meta entry.
    try {
      const meta = loadMeta();
      if (meta[category]) {
        delete meta[category]![key];
        if (Object.keys(meta[category]!).length === 0) {
          delete meta[category];
        }
        saveMeta(meta);
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/**
 * Reset to seeded defaults. Wipes user edits — operator-facing surfaces
 * gate this behind a confirm flag.
 */
export function resetPreferences(): PreferencesObject {
  writeFileSecure(currentPath(), SEED_TOML);
  try {
    saveMeta({});
  } catch {
    /* best-effort */
  }
  return JSON.parse(JSON.stringify(SEED_OBJECT)) as PreferencesObject;
}

// ─── validation helpers ─────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validateName(s: string, what: "category" | "key"): void {
  if (typeof s !== "string" || !s.trim()) {
    throw new Error(`${what} must be a non-empty string`);
  }
  if (!NAME_RE.test(s)) {
    throw new Error(
      `${what} "${s}" must match ${NAME_RE} (start with letter/underscore; alphanumerics, _, -)`,
    );
  }
}

function coerceValue(v: unknown): PreferenceValue {
  // Accept JSON-encoded booleans/numbers from CLI / dashboard so the
  // operator can type `subctl prefs set communication.audio_preferred false`
  // and have it land as a boolean instead of the literal string "false".
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isSafeInteger(n)) return n;
    }
    if (/^-?\d+\.\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }
    return v;
  }
  if (v === null || v === undefined) {
    throw new Error("preference value must be string, number, or boolean");
  }
  return String(v);
}

// ─── fs.watch ───────────────────────────────────────────────────────────

/**
 * fs.watch preferences.toml. Debounce 200ms (matches profiles.ts — atomic
 * rename fires twice on macOS). Callback receives the freshly-loaded
 * preferences object so subscribers don't have to re-read.
 *
 * Returns a handle with close() so the daemon can dispose the watcher
 * cleanly on shutdown.
 */
export function watchPreferences(
  onChange: (prefs: PreferencesObject) => void,
): { close: () => void } {
  const path = currentPath();
  // Ensure the file exists before watching — fs.watch on a missing file
  // errors immediately.
  loadPreferences();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(path, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const reloaded = loadPreferences();
          onChange(reloaded);
        } catch (err) {
          console.error(
            `[preferences] watcher reload failed: ${(err as Error).message}`,
          );
        }
      }, 200);
    });
  } catch (err) {
    console.error(`[preferences] fs.watch failed: ${(err as Error).message}`);
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

// ─── prompt rendering ───────────────────────────────────────────────────
//
// Injected into the master system prompt at the start of every turn.
// Format: a clearly-labeled markdown block so Evy can distinguish
// operator-set preferences from persona / SKILL.md. The header text
// is intentionally explicit ("Your operator's preferences") so it
// doesn't read as a system contract — these are knobs, not commands.

function humanizeKey(k: string): string {
  return k.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeValue(v: PreferenceValue): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v === "") return "(unset)";
  return String(v);
}

/**
 * Markdown block describing the active preferences. Empty section
 * (no categories) returns the empty string so the prompt isn't littered
 * with a hollow header.
 */
export function renderPreferencesForPrompt(): string {
  let prefs: PreferencesObject;
  try {
    prefs = loadPreferences();
  } catch {
    return "";
  }
  const cats = Object.keys(prefs).sort();
  if (cats.length === 0) return "";
  const lines: string[] = [
    "## Your operator's preferences",
    "",
    "These are settings the operator (or you, when you learned them) maintain.",
    "They tune your behavior — they don't override safety rules or SKILL.md.",
    "Update via the `evy_set_preference` tool when you learn a new one.",
    "",
  ];
  for (const cat of cats) {
    const body = prefs[cat];
    if (!body || Object.keys(body).length === 0) continue;
    lines.push(`**${humanizeKey(cat)}**`);
    for (const [k, v] of Object.entries(body)) {
      lines.push(`- ${humanizeKey(k)}: ${humanizeValue(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── test helpers ───────────────────────────────────────────────────────

/**
 * @internal — test-only. Stateless module today (every call re-reads),
 * kept for parity with profiles.ts in case we add caching.
 */
export function _resetForTesting(): void {
  // intentionally empty
}

/** @internal — test-only. Exposed for assertions on seed shape. */
export const _SEED_TOML = SEED_TOML;
export const _SEED_OBJECT = SEED_OBJECT;
