// project tools — scoped, narrow project + vault write capabilities for
// the master daemon. Master can create new projects (clone or empty init)
// and append to vault markdown files. Both are bounded:
//
//   project_create  → posts to the dashboard's /api/projects/create
//                     endpoint, which already runs git clone + vault init +
//                     policy.json append + master restart in a controlled
//                     way. Master invokes the same code path as Jason
//                     pressing the New Project button, so behavior is
//                     identical.
//
//   vault_append    → append-only writes inside ~/Documents/Obsidian Vault/
//                     ONLY. Refuses absolute paths outside that root,
//                     refuses .. traversal, never overwrites, never
//                     deletes. Designed for: master logging decisions,
//                     master adding notes to RESUME.md, master writing
//                     project status updates to vault entries — not for
//                     code generation, not for arbitrary file IO.

import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, normalize, join, dirname } from "node:path";

// Resolve the configured Obsidian vault root. Reads
// ~/.config/subctl/master/obsidian.json if present (set via dashboard
// Settings → Obsidian vault), otherwise falls back to the default.
function resolveVaultRoot(): string {
  const fallback = `${homedir()}/Documents/Obsidian Vault`;
  try {
    const cfgPath = `${homedir()}/.config/subctl/master/obsidian.json`;
    if (existsSync(cfgPath)) {
      const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
      if (j.vault_root) return j.vault_root.replace(/^~/, homedir());
    }
  } catch { /* ignore */ }
  return fallback;
}

const SUBCTL_API = process.env.SUBCTL_API ?? "http://127.0.0.1:8787";

function pathEscapesRoot(targetAbs: string, root: string): boolean {
  const normT = normalize(targetAbs);
  const normR = normalize(root);
  // True if normT is NOT inside normR
  if (!normT.startsWith(normR + "/") && normT !== normR) return true;
  return false;
}

export const projectTools = {
  project_create: {
    description:
      "Create a new project on this host. Optionally clones a git URL (or initializes an empty repo with a README), creates an Obsidian vault subtree at ~/Documents/Obsidian Vault/<name>/ with RESUME.md + design/ + reviews/ + postmortems/ folders, appends an entry to ~/.config/subctl/master/policy.json with the chosen autonomy level, and restarts the master daemon so the new project is tracked. Use this when Jason asks to start a new project (and only with his explicit go).",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Project name. Becomes ~/code/<name>. Alphanumerics + . - _ only (no spaces). Required.",
        },
        git_url: {
          type: "string",
          description: "Optional git URL to clone (e.g. git@github.com:owner/repo.git). If omitted, an empty directory is created with a README and `git init`.",
        },
        autonomy_level: {
          type: "string",
          enum: ["drive", "ask", "shadow"],
          description: "How much autonomy you have over this project. ask = propose every action; drive = act on most things, escalate push/merge/deploy; shadow = observe only.",
        },
        create_vault: {
          type: "boolean",
          description: "Create the Obsidian vault subtree. Default true.",
        },
        add_to_policy: {
          type: "boolean",
          description: "Add the project to policy.json so master watches it. Default true.",
        },
      },
      required: ["name", "autonomy_level"],
    },
    invoke: async (args: {
      name: string;
      git_url?: string;
      autonomy_level: "drive" | "ask" | "shadow";
      create_vault?: boolean;
      add_to_policy?: boolean;
    }) => {
      const r = await fetch(`${SUBCTL_API}/api/projects/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          git_url: args.git_url ?? "",
          autonomy_level: args.autonomy_level,
          create_vault: args.create_vault ?? true,
          add_to_policy: args.add_to_policy ?? true,
        }),
      });
      const j = await r.json();
      return j;
    },
  },

  vault_append: {
    description:
      "Append text to a markdown file inside Jason's Obsidian vault (~/Documents/Obsidian Vault/). Append-only — never overwrites, never deletes, never reads files outside the vault. Refuses paths that escape the vault root. Use this to log decisions, update RESUME.md, write status notes for a project, or capture findings. Creates the parent directory if needed. The path is RELATIVE to the vault root (e.g. 'subctl/decisions.md', 'master/decisions.md').",
    schema: {
      type: "object",
      properties: {
        relative_path: {
          type: "string",
          description: "Path relative to ~/Documents/Obsidian Vault/. Must end in .md. Example: 'subctl/decisions.md' or 'master/portfolio.md'.",
        },
        content: {
          type: "string",
          description: "Markdown content to append. Will be appended verbatim with a trailing newline. Include your own headings/timestamps/separators as needed.",
        },
        prepend_heading: {
          type: "string",
          description: "Optional heading to write above the content (e.g. '## 2026-05-10 — decision X'). Will be sandwiched between blank lines.",
        },
      },
      required: ["relative_path", "content"],
    },
    invoke: async (args: {
      relative_path: string;
      content: string;
      prepend_heading?: string;
    }) => {
      const rel = (args.relative_path ?? "").trim();
      if (!rel) return { ok: false, error: "relative_path required" };
      if (!rel.endsWith(".md")) return { ok: false, error: "path must end in .md" };
      if (rel.startsWith("/")) return { ok: false, error: "path must be relative to the vault root, not absolute" };
      if (rel.includes("..")) return { ok: false, error: "path may not contain '..'" };

      const vaultRoot = resolveVaultRoot();
      const target = resolve(vaultRoot, rel);
      if (pathEscapesRoot(target, vaultRoot)) {
        return { ok: false, error: `path escapes vault root: ${target}` };
      }

      // Make sure the vault root itself exists — if Obsidian isn't installed
      // yet, the master should NOT silently create the vault dir; that
      // would leave Jason with an empty unconfigured Obsidian directory.
      if (!existsSync(vaultRoot)) {
        return {
          ok: false,
          error: `vault root does not exist at ${vaultRoot}. Install Obsidian (curl -fsSL https://obsidian.md/install.sh) or set the vault_root via Settings → Obsidian vault.`,
        };
      }

      try {
        // Make parent dir if missing
        mkdirSync(dirname(target), { recursive: true });
        const blob =
          (args.prepend_heading
            ? `\n${args.prepend_heading.trim()}\n\n`
            : "") +
          args.content +
          (args.content.endsWith("\n") ? "" : "\n");
        appendFileSync(target, blob);
        return {
          ok: true,
          path: target,
          relative_path: rel,
          appended_chars: blob.length,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  },
};
