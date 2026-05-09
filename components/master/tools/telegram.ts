// Telegram outbound for clawd. Uses a SEPARATE bot from subctl's
// notify-listener bot. Two-bot model is intentional:
//   - notify-bot: tactical worker escalations (existing, in components/notify/)
//   - master-bot: strategic conversation with the operator (this file + master-notify-listener.ts)
//
// Bot token + chat ID stored at ~/.config/subctl/master-notify.json:
//   { "bot_token": "...", "chat_id": "..." }

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MASTER_NOTIFY_CONFIG =
  process.env.SUBCTL_MASTER_NOTIFY_CONFIG ??
  join(process.env.HOME ?? "", ".config", "subctl", "master-notify.json");

interface MasterNotifyCreds {
  bot_token: string;
  chat_id: string;
}

let _creds: MasterNotifyCreds | null = null;

function getCreds(): MasterNotifyCreds {
  if (_creds) return _creds;
  const raw = readFileSync(MASTER_NOTIFY_CONFIG, "utf8");
  const parsed = JSON.parse(raw) as MasterNotifyCreds;
  if (!parsed.bot_token || !parsed.chat_id) {
    throw new Error(
      `${MASTER_NOTIFY_CONFIG} missing bot_token or chat_id`,
    );
  }
  _creds = parsed;
  return parsed;
}

async function sendMessage(
  text: string,
  opts: { parse_mode?: "MarkdownV2" | "HTML" } = {},
): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  const creds = getCreds();
  const url = `https://api.telegram.org/bot${creds.bot_token}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: creds.chat_id,
    text,
  };
  if (opts.parse_mode) body.parse_mode = opts.parse_mode;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!json.ok) return { ok: false, error: json.description ?? "Telegram API error" };
  return { ok: true, message_id: json.result?.message_id };
}

export const telegramTools = {
  send: {
    description:
      "Send a message to the operator via clawd's dedicated Telegram bot. Default to plain text — Markdown only when needed (and only with parse_mode='MarkdownV2', escape carefully). Keep messages under 200 words.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        markdown: {
          type: "boolean",
          default: false,
          description: "Send as MarkdownV2 (caller must escape special chars).",
        },
      },
      required: ["text"],
    },
    invoke: async (args: { text: string; markdown?: boolean }) => {
      return sendMessage(args.text, args.markdown ? { parse_mode: "MarkdownV2" } : {});
    },
  },

  send_digest: {
    description:
      "Send a structured portfolio digest. Format: status emoji + project + verdict, one line per project. Auto-truncates if too long.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", default: "Portfolio status" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              project: { type: "string" },
              verdict: { type: "string", enum: ["green", "amber", "red", "info"] },
              line: { type: "string" },
            },
            required: ["project", "verdict", "line"],
          },
        },
      },
      required: ["entries"],
    },
    invoke: async (args: {
      title?: string;
      entries: Array<{ project: string; verdict: "green" | "amber" | "red" | "info"; line: string }>;
    }) => {
      const emoji = { green: "🟢", amber: "🟡", red: "🔴", info: "ℹ️" };
      const header = args.title ?? "Portfolio status";
      const body = args.entries
        .map((e) => `${emoji[e.verdict]} ${e.project} — ${e.line}`)
        .join("\n");
      const text = `${header}\n${"─".repeat(20)}\n${body}`;
      return sendMessage(text);
    },
  },
};
