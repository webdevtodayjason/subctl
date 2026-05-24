// components/master/text-sanitize.ts
//
// v2.8.9 — Shared text-sanitisation helpers. Centralised so every outbound
// path (transcript persistence, Telegram send, voice TTS, dashboard SSE
// broadcast, etc.) strips the same artifacts the same way.
//
// Previously the strip lived only in server.ts's saveAgentTranscript and
// the dashboard's appendDelta render. The Telegram outgoing path
// (tools/telegram.ts sendMessage) didn't strip, so reasoning-channel
// markers from local-model output leaked into Evy's Telegram replies.

/** Match opening + closing reasoning-channel markers, including the
 *  malformed `<|channel>NAME<channel|>` variant emitted by
 *  gemma-4-26b-a4b-it MLX 4-bit (and likely other 4-bit MLX quantisations).
 *  Strips both pipes-each-side and missing-pipe variants. */
export const REASONING_CHANNEL_RE = /<\|?channel\|?>[\s\S]*?<\|?channel\|?>/g;

/** Strip reasoning-channel markers from text. Idempotent — safe to call
 *  on already-clean text. */
export function stripReasoningChannels(text: string): string {
  return text.replace(REASONING_CHANNEL_RE, "");
}
