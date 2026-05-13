// components/master/tools/preferences.ts
//
// v2.8.1 — Master tools so Evy can read and update operator preferences
// from inside a turn. Distinct from Evy Memory (Tier 3): preferences are
// structured config the operator + Evy both maintain, memory is the
// conversation/decision log.
//
// Bilateral-maintenance design: operator edits the TOML file directly
// (CLI / dashboard / $EDITOR / /prefs), Evy uses evy_set_preference when
// she learns one in conversation. Every write is stamped with `by` +
// optional `reason` so the audit trail says who decided what.

import {
  getPreference,
  listPreferences,
  setPreference,
  type PreferenceValue,
} from "../preferences";

export const preferencesTools = {
  evy_get_preferences: {
    description:
      "Read the operator's preferences. Returns every category by default, or just one when `category` is given. Use this when the operator asks \"what do I have set for X?\" or when you want to confirm a preference before acting on it. Distinct from evy_recall — that's conversational memory; this is structured config.",
    schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Optional category name to restrict the result (e.g. \"communication\", \"coding\", \"reports\", \"agent_behavior\"). Omit to get all categories.",
        },
      },
      required: [],
    },
    invoke: async (args: { category?: string }) => {
      const category = (args.category ?? "").trim() || undefined;
      try {
        const entries = listPreferences(category);
        // Group back into the {category: {key: value}} shape so the
        // model can address values by path. listPreferences guarantees
        // category-major ordering for stable serialization.
        const grouped: Record<string, Record<string, PreferenceValue>> = {};
        for (const e of entries) {
          if (!grouped[e.category]) grouped[e.category] = {};
          grouped[e.category]![e.key] = e.value;
        }
        return {
          ok: true,
          preferences: grouped,
          count: entries.length,
          filtered_to: category ?? null,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },
  },

  evy_set_preference: {
    description:
      "Persist a preference the operator just told you about. Use this when the operator says something like \"actually keep responses shorter\" or \"always run bun test before pushing\" — capture it so you remember next time. The TOML file is reloaded on every change so the next turn sees the new value. Pass a short `reason` describing what they said so the audit trail is useful when the operator looks back. Never call this for guesses — only for things the operator explicitly stated as a standing preference.",
    schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Category bucket. Use existing names where possible: \"communication\", \"coding\", \"reports\", \"agent_behavior\". Free-form is OK — the operator can add categories.",
        },
        key: {
          type: "string",
          description:
            "Snake-case key inside the category. Examples: \"report_length\", \"preferred_channel\", \"test_first\". Letters, digits, underscores, hyphens.",
        },
        value: {
          description:
            "The preference value. Strings, booleans, and numbers all accepted. Strings like \"true\"/\"false\" and numeric strings get coerced automatically.",
        },
        reason: {
          type: "string",
          description:
            "Brief justification (≤240 chars). The operator phrase or context that led you to set this — e.g. \"operator said 'keep replies shorter from now on'\". Captured in the audit sidecar so the operator can see why a value changed.",
        },
      },
      required: ["category", "key", "value"],
    },
    invoke: async (args: {
      category: string;
      key: string;
      value: unknown;
      reason?: string;
    }) => {
      const category = (args.category ?? "").toString().trim();
      const key = (args.key ?? "").toString().trim();
      if (!category || !key) {
        return { ok: false, error: "category and key are required" };
      }
      // Defense in depth: setPreference coerces, but we reject obvious
      // non-scalar shapes early so the audit log doesn't fill with
      // "[object Object]" entries.
      const v = args.value;
      if (v !== null && typeof v === "object") {
        return {
          ok: false,
          error: "value must be a string, number, or boolean",
        };
      }
      try {
        const entry = setPreference(
          category,
          key,
          v as string | number | boolean,
          "evy",
          (args.reason ?? "").toString(),
        );
        return {
          ok: true,
          entry,
          message:
            "preference saved; the next turn's system prompt will reflect it",
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },
  },

  evy_get_preference_value: {
    description:
      "Quick single-key lookup. Returns the value (or the seeded default if you've never set it). Use this when you want to branch on a specific preference inline rather than scanning the whole bag.",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category name." },
        key: { type: "string", description: "Key inside the category." },
      },
      required: ["category", "key"],
    },
    invoke: async (args: { category: string; key: string }) => {
      const category = (args.category ?? "").toString().trim();
      const key = (args.key ?? "").toString().trim();
      if (!category || !key) {
        return { ok: false, error: "category and key are required" };
      }
      try {
        const value = getPreference(category, key);
        if (value === undefined) {
          return { ok: true, found: false, category, key, value: null };
        }
        return { ok: true, found: true, category, key, value };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },
  },
};
