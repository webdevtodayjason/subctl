// Personality presets for the master daemon.
//
// Voice (tone/cadence/mannerisms) is decoupled from persona (job: dev-team
// orchestrator). composeSystemPrompt() injects whichever preset is active
// at the END of the system prompt so the voice rules are the most-recent
// thing the model reads before responding.
//
// State lives at ~/.config/subctl/evy/personality.json:
//   { "preset": "straight-shooter" }
//
// Hot-swap is real: composeSystemPrompt() reads the file on every turn,
// so a write via dashboard or `subctl evy personality set <preset>`
// takes effect on the next prompt with no daemon restart.
//
// Anti-hallucination rules in master SKILL.md and the v2.1.4 runtime
// verifier override these voice rules in every preset — verified by
// language inside each fragment ("Anti-hallucination rules unchanged").

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");
const CONFIG_PATH = join(SUBCTL_CONFIG_DIR, "evy", "personality.json");
const PRESETS_DIR = join(import.meta.dir, "personalities");

const PRESETS = [
  "evy",
  "straight-shooter",
  "witty",
  "sarcastic",
  "robotic",
  "arnold",
  "elon",
  "hilarious",
] as const;

export type Preset = (typeof PRESETS)[number];

export const ALL_PRESETS: ReadonlyArray<Preset> = PRESETS;
// v2.7.15: default flipped from "straight-shooter" to "evy" — the
// master daemon is now the Evy persona (see docs/persona/evy.md). The
// evy.md preset is intentionally compatible with the persona's spec:
// voice rules in the preset reinforce, never contradict, the SKILL.md
// prompt. Operators can still opt out by writing
// ~/.config/subctl/evy/personality.json with a different preset.
export const DEFAULT_PRESET: Preset = "evy";

export function readActivePreset(): Preset {
  try {
    if (!existsSync(CONFIG_PATH)) return DEFAULT_PRESET;
    const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { preset?: string };
    const p = j.preset;
    if (typeof p === "string" && (PRESETS as ReadonlyArray<string>).includes(p)) {
      return p as Preset;
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_PRESET;
}

// Returns the personality fragment as a string ready to concatenate
// onto the system prompt. Leading "\n\n" separator + trailing newline
// ensures it sits cleanly as its own paragraph at the end of the prompt.
export function buildPersonalityFragment(): string {
  const preset = readActivePreset();
  const path = join(PRESETS_DIR, `${preset}.md`);
  try {
    if (!existsSync(path)) return "";
    return "\n\n" + readFileSync(path, "utf8").trim() + "\n";
  } catch {
    return "";
  }
}

export function setPreset(preset: string): { ok: boolean; error?: string; preset?: Preset } {
  if (!(PRESETS as ReadonlyArray<string>).includes(preset)) {
    return {
      ok: false,
      error: `unknown preset "${preset}". valid: ${PRESETS.join(", ")}`,
    };
  }
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          preset,
          _comment: `set via subctl evy personality at ${new Date().toISOString()}`,
        },
        null,
        2,
      ),
    );
    return { ok: true, preset: preset as Preset };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Returns the preview text for each preset — used by the dashboard tile
// and `subctl evy personality list` to show what each voice does
// without the operator having to read every file.
export function describePresets(): Array<{ id: Preset; preview: string }> {
  const out: Array<{ id: Preset; preview: string }> = [];
  for (const p of PRESETS) {
    const path = join(PRESETS_DIR, `${p}.md`);
    let preview = "";
    try {
      const content = readFileSync(path, "utf8");
      // Strip the [voice: ...] header and any "Anti-hallucination..."
      // boilerplate to keep the preview tight.
      const lines = content
        .replace(/^\[voice:[^\]]+\]\s*/m, "")
        .split(". ")
        .filter(
          (s) =>
            !s.toLowerCase().includes("anti-hallucination") &&
            s.trim().length > 0,
        );
      preview = (lines[0] ?? "").trim() + (lines[1] ? ". " + lines[1].trim() : "");
      if (preview.length > 160) preview = preview.slice(0, 157) + "…";
    } catch {
      preview = "(preview unavailable)";
    }
    out.push({ id: p, preview });
  }
  return out;
}
