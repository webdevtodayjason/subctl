// vault_link tool — returns a deep-linkable dashboard URL the master can
// include in chat or Telegram messages so the operator can jump straight
// to a note. Backed by the Phase 3n vault viewer at /dashboard#vault?...

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(homedir(), ".config", "subctl");

function getVaultRoot(): string {
  let root = `${homedir()}/Documents/Obsidian Vault`;
  try {
    const cfgPath = join(SUBCTL_CONFIG_DIR, "master", "obsidian.json");
    if (existsSync(cfgPath)) {
      const j = JSON.parse(readFileSync(cfgPath, "utf8")) as { vault_root?: string };
      if (j.vault_root) root = j.vault_root.replace(/^~/, homedir());
    }
  } catch { /* ignore */ }
  return root;
}

// Dashboard URL = http://<host>:<port>. Best-effort detection — env var
// override OR localhost:8787 default. Operator's actual LAN URL (e.g.
// 192.168.100.98:8787) requires DASHBOARD_PUBLIC_URL to be set in the env.
function getDashboardOrigin(): string {
  return process.env.DASHBOARD_PUBLIC_URL ?? "http://127.0.0.1:8787";
}

export const vaultLinkTools = {
  vault_link: {
    description:
      "Build a deep-linkable URL into the dashboard's Vault viewer for a specific note. Use this whenever you reference a vault file in chat — gives the operator one click to open the rendered note. Returns the URL only; doesn't read content. For reading content, use vault_append (write) or just include note text inline.",
    schema: {
      type: "object",
      properties: {
        note_path: {
          type: "string",
          description:
            "Relative path within the vault, e.g. 'Down-Time-Arena/decisions.md'. Don't include the vault slug prefix — that's the `root` arg.",
        },
        root: {
          type: "string",
          description:
            "Vault slug (sub-directory under vault_root). Defaults to 'master' — the daemon's own vault created by `subctl install`.",
        },
      },
      required: ["note_path"],
    },
    invoke: async (args: { note_path: string; root?: string }) => {
      const root = (args.root ?? "master").trim();
      const note = (args.note_path ?? "").trim();
      if (!note) return { ok: false, error: "note_path required" };
      if (note.includes("..") || note.startsWith("/")) {
        return { ok: false, error: "note_path must be vault-relative, no `..` or absolute paths" };
      }
      const vaultRoot = getVaultRoot();
      const absPath = `${vaultRoot}/${root}/${note}`;
      const exists = existsSync(absPath);
      const origin = getDashboardOrigin();
      const url = `${origin}/dashboard#vault?root=${encodeURIComponent(root)}&path=${encodeURIComponent(note)}`;
      return {
        ok: true,
        url,
        exists,
        hint: exists
          ? "Note exists. Drop the URL in chat/Telegram and the operator can click to read."
          : "Note does NOT exist yet at the expected path — the URL still works (will show 'Note not found') but consider vault_append first if you meant to write it.",
      };
    },
  },
};
