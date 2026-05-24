// Telegram outbound for subctl master. Uses a SEPARATE bot from subctl's
// notify-listener bot. Two-bot model is intentional:
//   - notify-bot: tactical worker escalations (existing, in components/notify/)
//   - master-bot: strategic conversation with the operator (this file + master-notify-listener.ts)
//
// Bot token + chat ID stored at ~/.config/subctl/master-notify.json:
//   { "bot_token": "...", "chat_id": "..." }

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderVoice } from "./voice-render";
import { stripReasoningChannels } from "../text-sanitize";

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

// Exported so the master daemon can auto-relay assistant replies to
// Telegram when the inbound prompt came from there (so the operator
// reading on their phone doesn't have to wait for the master to
// remember to call the `telegram_send` tool).
export async function sendTelegramOutbound(
  text: string,
  opts: { parse_mode?: "MarkdownV2" | "HTML" } = {},
): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  return sendMessage(text, opts);
}

// v2.8.0 — exported helper to ship a rendered voice note to Telegram.
// Used by the /say command in master-notify-listener.ts AND by the
// telegram_send_voice tool below. The audio bytes are uploaded via
// multipart sendVoice rather than streamed from the master's HTTP
// surface (Telegram needs to fetch the file itself, and we don't
// publish master:8788 to the internet).
export async function sendTelegramVoice(
  audioPath: string,
  opts: { caption?: string; duration_ms?: number; format?: string } = {},
): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  const creds = getCreds();
  const url = `https://api.telegram.org/bot${creds.bot_token}/sendVoice`;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(audioPath);
  } catch (err) {
    return { ok: false, error: `read ${audioPath}: ${(err as Error).message}` };
  }
  // Telegram's sendVoice prefers Opus/OGG; many other formats work but
  // get sent as a generic voice note. We pass through whatever the TTS
  // server returned (wav or mpeg) and let Telegram transcode.
  const fmt = (opts.format ?? "wav").toLowerCase();
  const mime = fmt === "wav" ? "audio/wav" : fmt === "ogg" ? "audio/ogg" : "audio/mpeg";
  const form = new FormData();
  form.append("chat_id", creds.chat_id);
  if (opts.caption) form.append("caption", opts.caption.slice(0, 1000));
  if (typeof opts.duration_ms === "number" && opts.duration_ms > 0) {
    form.append("duration", String(Math.round(opts.duration_ms / 1000)));
  }
  form.append(
    "voice",
    new Blob([new Uint8Array(bytes)], { type: mime }),
    `evy.${fmt}`,
  );
  const r = await fetch(url, { method: "POST", body: form });
  const json = (await r.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!json.ok) return { ok: false, error: json.description ?? "Telegram API error" };
  return { ok: true, message_id: json.result?.message_id };
}

async function sendMessage(
  text: string,
  opts: { parse_mode?: "MarkdownV2" | "HTML" } = {},
): Promise<{ ok: boolean; message_id?: number; error?: string }> {
  const creds = getCreds();
  const url = `https://api.telegram.org/bot${creds.bot_token}/sendMessage`;
  // v2.8.9 — strip reasoning-channel markers before send. Local models
  // (notably gemma-4-26b-a4b-it MLX 4-bit) leak `<|channel>thought\n<channel|>`
  // into Evy's responses; saveAgentTranscript already strips them on
  // persistence and the dashboard strips on render, but the Telegram
  // outgoing path was a third surface that hadn't been wired through.
  const sanitized = stripReasoningChannels(text);
  const body: Record<string, unknown> = {
    chat_id: creds.chat_id,
    text: sanitized,
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
      "Send a message to the operator via subctl master's dedicated Telegram bot. Default to plain text — Markdown only when needed (and only with parse_mode='MarkdownV2', escape carefully). Keep messages under 200 words.",
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

  send_voice: {
    description:
      "Send a rendered voice note to the operator via Telegram. Renders `text` through the local TTS server (voice_render → cache) then uploads via Telegram's sendVoice API. Use ONLY for severity='alert' notifications OR when the operator explicitly asks to be voiced (e.g. /say). Voice must be enabled in voice.json. Don't speak secrets — egress redaction applies in voice_render before synthesis. Caption (optional) shows under the voice note in the Telegram client.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to synthesize. Max 4000 chars." },
        voice_id: { type: "string", description: "Voice slug; defaults to voice.json default_voice_id." },
        caption: { type: "string", description: "Optional caption shown under the voice note." },
      },
      required: ["text"],
    },
    invoke: async (args: { text: string; voice_id?: string; caption?: string }) => {
      const render = await renderVoice({ text: args.text, voice_id: args.voice_id });
      if (!render.ok) return { ok: false, error: render.error };
      if (!render.audio_path) {
        return { ok: false, error: "voice_render did not return an audio_path" };
      }
      const sent = await sendTelegramVoice(render.audio_path, {
        caption: args.caption,
        duration_ms: render.duration_ms,
        format: render.format,
      });
      if (!sent.ok) return { ok: false, error: sent.error };
      return {
        ok: true,
        message_id: sent.message_id,
        cached: render.cached,
        voice_id: render.voice_id,
        duration_ms: render.duration_ms,
      };
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
