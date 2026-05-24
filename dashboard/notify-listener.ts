// dashboard/notify-listener.ts
//
// Telegram long-poll listener. Runs INSIDE the dashboard's Bun process —
// no separate launchd plist needed. Reads bot token + chat id from
// ~/.config/subctl/notify.json, polls getUpdates with timeout=25, writes
// every relevant event to ~/.config/subctl/inbox.jsonl.
//
// Why bundled (not a separate process):
//   - Same lifecycle as the dashboard service (single restart point)
//   - Inbox state available to the dashboard API "for free"
//   - One Bun process is plenty for 1 user / 1 bot
//
// Bot conflict rule: only ONE getUpdates loop per bot may run at a time
// (Telegram serves updates to the first caller). subctl uses its own
// dedicated bot (~/.config/subctl/notify.json); other tools (e.g. Argent's
// aos-telegram via TELEGRAM_BOT_TOKEN env) must use DIFFERENT bots.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { removePendingAsk } from "../components/evy/asks-pending";

const HOME = homedir();
const NOTIFY_CONFIG = join(HOME, ".config", "subctl", "notify.json");
const INBOX_PATH    = join(HOME, ".config", "subctl", "inbox.jsonl");
const OFFSET_PATH   = join(HOME, ".config", "subctl", "notify-listener.offset");

interface NotifyConfig {
  telegram_bot_token: string;
  telegram_chat_id: string;
}

// v3.2.0: widened to accept `source: "buddy"` and `type: "button"` for
// externally-injected replies (subctl-buddy bridge, `subctl notify reply`,
// `POST /api/notify/reply`). `from_id` is nullable because buddy replies
// have no Telegram user id. See docs/asks-pending-surface.md for the
// canonical reply schema.
export interface InboxEntry {
  ts: string;                        // ISO8601 UTC
  source: "message" | "callback_query" | "buddy" | string;
  type:
    | "text"
    | "yesno-answer"
    | "choice-answer"
    | "text-answer"
    | "raw"
    | "button"
    | string;
  question_id: string | null;        // tag from the original ask, if matched
  answer: string | null;             // the data payload (button id, yes/no, text)
  answer_label: string | null;       // human-readable label, e.g. "migrate-and-backfill"
  from_id: number | null;
  from_name: string;
  raw_text: string | null;           // user's literal text (for replies/asks-text)
  acked: boolean;                    // mark via subctl notify inbox-ack <id>
}

// Optional: pass buildState so the listener can answer /stats with live
// dashboard data. If absent, /stats returns a "stats unavailable" message.
type StateProvider = () => any;

let _running = false;
let _abortController: AbortController | null = null;
let _stateProvider: StateProvider | null = null;
let _allowedChatId: string | null = null;  // only respond to commands from this chat

export interface StartListenerOptions {
  stateProvider?: StateProvider;
}

export function startNotifyListener(opts: StartListenerOptions = {}): { running: boolean; reason?: string } {
  if (_running) return { running: true, reason: "already running" };
  if (!existsSync(NOTIFY_CONFIG)) {
    return { running: false, reason: "no notify config — run `subctl notify --setup`" };
  }

  let cfg: NotifyConfig;
  try {
    cfg = JSON.parse(readFileSync(NOTIFY_CONFIG, "utf8"));
  } catch (e) {
    return { running: false, reason: "notify config unreadable" };
  }
  if (!cfg.telegram_bot_token) {
    return { running: false, reason: "no bot token in notify config" };
  }

  mkdirSync(join(HOME, ".config", "subctl"), { recursive: true });

  _stateProvider = opts.stateProvider ?? null;
  _allowedChatId = cfg.telegram_chat_id ?? null;

  _running = true;
  _abortController = new AbortController();
  pollLoop(cfg.telegram_bot_token, _abortController.signal).catch(err => {
    console.error("[notify-listener] poll loop crashed:", err?.message || err);
    _running = false;
  });
  return { running: true };
}

export function stopNotifyListener(): void {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _running = false;
}

export function notifyListenerStatus(): { running: boolean; offset: number; inbox_size_kb: number } {
  let offset = 0;
  try { offset = Number(readFileSync(OFFSET_PATH, "utf8").trim()) || 0; } catch {}
  let size = 0;
  try { size = Bun.file(INBOX_PATH).size; } catch {}
  return { running: _running, offset, inbox_size_kb: Math.round(size / 1024) };
}

async function pollLoop(token: string, signal: AbortSignal) {
  console.log("[notify-listener] starting Telegram long-poll");

  // Pre-flight: verify bot + warn on webhook (which would block polling).
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      .then(r => r.json()) as any;
    if (me?.ok) {
      console.log(`[notify-listener] bot: @${me.result.username}`);
    }
    const wh = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
      .then(r => r.json()) as any;
    if (wh?.result?.url) {
      console.warn(`[notify-listener] WARNING: webhook set on this bot (${wh.result.url}) — getUpdates will return 409. Disable the webhook OR use a different bot.`);
    }
  } catch (e) {
    console.warn("[notify-listener] preflight failed:", (e as any)?.message);
  }

  // Resume from saved offset, if any.
  let offset = 0;
  try { offset = Number(readFileSync(OFFSET_PATH, "utf8").trim()) || 0; } catch {}

  while (!signal.aborted) {
    try {
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set("timeout", "25");
      if (offset > 0) url.searchParams.set("offset", String(offset));
      url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));

      const r = await fetch(url, { signal });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (r.status === 409) {
          console.error("[notify-listener] HTTP 409 — bot has a webhook OR another poller is running. Backing off 60s.");
          await sleep(60_000);
          continue;
        }
        console.warn(`[notify-listener] HTTP ${r.status}: ${body.slice(0, 200)}`);
        await sleep(5_000);
        continue;
      }
      const j = await r.json() as any;
      if (!j?.ok || !Array.isArray(j.result)) {
        await sleep(5_000);
        continue;
      }
      for (const update of j.result) {
        try { await handleUpdate(update, token); } catch (e) {
          console.error("[notify-listener] handleUpdate error:", (e as any)?.message);
        }
        if (typeof update.update_id === "number") {
          offset = update.update_id + 1;
        }
      }
      // Persist offset so a restart doesn't replay.
      try { Bun.write(OFFSET_PATH, String(offset)); } catch {}
    } catch (e: any) {
      if (e?.name === "AbortError") break;
      console.warn("[notify-listener] poll error:", e?.message || e);
      await sleep(5_000);
    }
  }
  console.log("[notify-listener] stopped");
  _running = false;
}

async function handleUpdate(update: any, token: string) {
  const ts = new Date().toISOString();

  // Plain text message → log as raw inbox event, or dispatch as bot command.
  if (update.message) {
    const msg = update.message;
    const text: string = msg.text ?? "";
    const fromId: number = msg.from?.id ?? 0;
    const fromName: string = msg.from?.first_name ?? "(unknown)";
    const chatId: string = String(msg.chat?.id ?? "");

    // Bot-command branch — only respond to commands from the authorized
    // chat (the chat configured in notify.json). Anyone else gets ignored.
    if (text.startsWith("/") && _allowedChatId && chatId === _allowedChatId) {
      await handleBotCommand(text, chatId, token);
      // Still log the command in inbox for audit trail
      appendInbox({
        ts, source: "message", type: "text",
        question_id: null,
        answer: text, answer_label: null,
        from_id: fromId, from_name: fromName,
        raw_text: text, acked: true,  // commands auto-acked (handled inline)
      });
      return;
    }

    // Match question ID from reply-to-message OR leading "#Q42" tag
    let questionId: string | null = null;
    if (msg.reply_to_message?.text) {
      const m = msg.reply_to_message.text.match(/\[(Q[A-Za-z0-9_-]+)\]/);
      if (m) questionId = m[1];
    }
    if (!questionId) {
      const m = text.match(/^#(Q[A-Za-z0-9_-]+)\b/);
      if (m) questionId = m[1];
    }

    const entry: InboxEntry = {
      ts,
      source: "message",
      type: questionId ? "text-answer" : "text",
      question_id: questionId,
      answer: text || null,
      answer_label: null,
      from_id: fromId,
      from_name: fromName,
      raw_text: text || null,
      acked: false,
    };
    appendInbox(entry);
    // v3.2.0 — text-answer with a matched question_id resolves the ask;
    // drop the corresponding pending-asks record so consumers (the
    // subctl-buddy bridge etc.) see the ask close. Best-effort: failure
    // here doesn't block inbox persistence.
    if (questionId) {
      void removePendingAsk(questionId).catch(() => { /* swallow */ });
    }
    return;
  }

  // Inline-keyboard tap → callback_query
  if (update.callback_query) {
    const cq = update.callback_query;
    const data: string = cq.data ?? ""; // e.g. "Q42:B:migrate-and-backfill"
    const fromId: number = cq.from?.id ?? 0;
    const fromName: string = cq.from?.first_name ?? "(unknown)";

    let questionId: string | null = null;
    let choiceId: string | null = null;
    let choiceLabel: string | null = null;
    let yesno: "yes" | "no" | null = null;

    const parts = data.split(":");
    if (parts.length >= 1 && parts[0]?.startsWith("Q")) questionId = parts[0]!;
    if (parts.length >= 2) choiceId = parts[1] || null;
    if (parts.length >= 3) choiceLabel = parts.slice(2).join(":") || null;

    if (choiceId === "yes" || choiceId === "no") {
      yesno = choiceId;
    }

    const entry: InboxEntry = {
      ts,
      source: "callback_query",
      type: yesno ? "yesno-answer" : "choice-answer",
      question_id: questionId,
      answer: yesno || choiceId,
      answer_label: choiceLabel,
      from_id: fromId,
      from_name: fromName,
      raw_text: data || null,
      acked: false,
    };
    appendInbox(entry);
    // v3.2.0 — inline-button tap resolves the ask; drop the
    // corresponding pending-asks record. Best-effort.
    if (questionId) {
      void removePendingAsk(questionId).catch(() => { /* swallow */ });
    }

    // Always answer the callback so Telegram's spinner stops on the user's phone.
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: cq.id,
          text: choiceLabel ? `→ ${choiceLabel}` : (yesno ?? "ack"),
        }),
      });
    } catch { /* swallow */ }
    return;
  }
}

function appendInbox(entry: InboxEntry) {
  appendFileSync(INBOX_PATH, JSON.stringify(entry) + "\n");
}

// ---------- bot command handler ----------

async function handleBotCommand(text: string, chatId: string, token: string) {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().split("@")[0]!;
  const args = parts.slice(1);
  let reply = "";
  switch (cmd) {
    case "/stats":
    case "/status":
      reply = formatStats();
      break;
    case "/help":
    case "/start":
      reply = formatHelp();
      break;
    case "/inbox":
      reply = formatRecentInbox();
      break;
    case "/sessions":
      reply = await formatSessionsList();
      break;
    case "/kill":
      reply = await execKill(args[0] || "");
      break;
    case "/msg":
      reply = await execMsg(args[0] || "", args.slice(1).join(" "));
      break;
    default:
      reply = `Unknown command: ${cmd}\n\nTry /stats, /sessions, /kill, /msg, /inbox, /help`;
  }
  await sendMessage(chatId, reply, token);
}

// ---------- new bot commands: /sessions /msg /kill ----------

async function formatSessionsList(): Promise<string> {
  // Reuse the dashboard's HTTP API rather than recomputing — single source of truth
  try {
    const r = await fetch("http://127.0.0.1:8787/api/orchestration");
    const j = await r.json() as any;
    const list = j?.orchestrations || [];
    if (list.length === 0) return "📭 no orchestrator sessions running\n\n(spawn one with: subctl orch spawn --account ...)";
    const lines = [`🧭 ${list.length} orchestrator session(s):`, ""];
    for (const s of list) {
      const att = s.attached ? "●" : "○";
      const acct = (s.claude_account_dir || "").split("/").pop() || "—";
      lines.push(`${att} ${s.name}`);
      lines.push(`   account: ${acct}`);
      lines.push(`   path:    ${(s.path || "").replace(process.env.HOME || "", "~")}`);
    }
    lines.push("");
    lines.push("Commands: /msg <name> <text> · /kill <name>");
    return lines.join("\n");
  } catch (e: any) {
    return `error listing sessions: ${e?.message || e}`;
  }
}

async function execKill(name: string): Promise<string> {
  if (!name) return "usage: /kill <session_name>\n\n(get names with /sessions)";
  try {
    const r = await fetch(`http://127.0.0.1:8787/api/orchestration/${encodeURIComponent(name)}/kill`, {
      method: "POST",
    });
    const j = await r.json() as any;
    return j?.ok ? `🔪 killed ${name}` : `kill failed: ${j?.error || "unknown"}`;
  } catch (e: any) {
    return `error: ${e?.message || e}`;
  }
}

async function execMsg(name: string, text: string): Promise<string> {
  if (!name || !text) return "usage: /msg <session_name> <text>\n\n(get names with /sessions)";
  try {
    const r = await fetch(`http://127.0.0.1:8787/api/orchestration/${encodeURIComponent(name)}/msg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const j = await r.json() as any;
    return j?.ok ? `📝 injected into ${name}: ${text.slice(0, 80)}` : `msg failed: ${j?.error || "unknown"}`;
  } catch (e: any) {
    return `error: ${e?.message || e}`;
  }
}

function formatStats(): string {
  if (!_stateProvider) {
    return "📊 stats unavailable\n\n(stateProvider not configured — listener running in standalone mode)";
  }
  let s: any;
  try { s = _stateProvider(); }
  catch (e: any) { return `stats error: ${e?.message || e}`; }

  const verdictEmoji = s?.dispatch?.verdict === "green" ? "🟢"
                     : s?.dispatch?.verdict === "yellow" ? "🟡"
                     : s?.dispatch?.verdict === "red" ? "🔴" : "⚪";

  const lines: string[] = [];
  lines.push(`📊 subctl stats · ${new Date().toISOString().slice(0, 19).replace("T", " ")}Z`);
  lines.push("");
  lines.push(`Verdict: ${verdictEmoji} ${(s?.dispatch?.verdict || "unknown").toUpperCase()}`);
  if (Array.isArray(s?.dispatch?.reasons) && s.dispatch.reasons.length > 0) {
    for (const r of s.dispatch.reasons.slice(0, 5)) lines.push(`  • ${r}`);
  }
  lines.push("");
  lines.push("Accounts:");
  for (const a of (s?.accounts || [])) {
    if (a.auth_status !== "ready") continue;
    const fivePct = a.five_hour_pct ?? a.five_hour_max_pct ?? null;
    const weekPct = a.seven_day_pct ?? a.seven_day_max_pct ?? null;
    const rl = a.rl_hits_today ?? 0;
    const fmt5 = fivePct == null ? "—" : `${fivePct}%`;
    const fmtW = weekPct == null ? "—" : `${weekPct}%`;
    lines.push(`  ● ${a.alias.padEnd(18)} 5h ${fmt5.padStart(4)} · week ${fmtW.padStart(4)} · ${rl} RL`);
  }
  lines.push("");
  const tmuxN = s?.totals?.tmux_sessions ?? 0;
  const conv  = s?.active_conversations?.length ?? 0;
  const rlT   = s?.totals?.rl_today ?? 0;
  const rlR   = s?.rate_limits?.recent_429_count ?? 0;
  lines.push(`Sessions: ${tmuxN} tmux · ${conv} active conv`);
  lines.push(`RL today: ${rlT} hits (${rlR} actionable in last 2h)`);

  if (s?.cost?.totals?.savings_month_usd != null) {
    const saved = s.cost.totals.savings_month_usd;
    const formatted = saved.toLocaleString("en-US", { style: "currency", currency: "USD" });
    lines.push("");
    lines.push(`Savings this month: ${formatted}`);
  }
  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "🤖 subctl bot · commands",
    "",
    "/stats              verdict, accounts, 5h%, week%, RL hits, savings",
    "/status             alias for /stats",
    "/sessions           list running orchestrator tmux sessions",
    "/msg <name> <text>  inject text into a specific session",
    "/kill <name>        kill a specific session",
    "/inbox              last 5 unacked inbox entries (replies, asks)",
    "/help               this message",
    "",
    "Plus: replies to ask-yesno/ask-choice/ask-text messages from",
    "subctl notify are routed to the orchestrator's inbox automatically.",
  ].join("\n");
}

function formatRecentInbox(): string {
  const entries = readInbox({ unacked_only: true, limit: 5 });
  if (entries.length === 0) return "📭 inbox empty (no pending replies)";
  const lines = ["📬 last 5 unacked inbox entries (newest first):", ""];
  for (const e of entries) {
    const tag = e.question_id ? `[${e.question_id}] ` : "";
    const ans = e.answer_label || e.answer || "(no text)";
    lines.push(`• ${e.ts.slice(11, 19)}Z  ${tag}${e.type}: ${ans.slice(0, 80)}`);
  }
  return lines.join("\n");
}

async function sendMessage(chatId: string, text: string, token: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.warn("[notify-listener] sendMessage failed:", (e as any)?.message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- public read API for the HTTP server ----------

export interface InboxQuery {
  question_id?: string;
  unacked_only?: boolean;
  limit?: number;
}

export function readInbox(q: InboxQuery = {}): InboxEntry[] {
  if (!existsSync(INBOX_PATH)) return [];
  const lines = readFileSync(INBOX_PATH, "utf8").split("\n");
  const out: InboxEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as InboxEntry;
      if (q.question_id && e.question_id !== q.question_id) continue;
      if (q.unacked_only && e.acked) continue;
      out.push(e);
    } catch { /* skip bad line */ }
  }
  out.reverse();  // newest first
  if (q.limit && q.limit > 0) return out.slice(0, q.limit);
  return out;
}

// Mark a question as acked (writes a new line; readInbox treats the latest
// matching entry as authoritative).
export function ackInboxEntry(questionId: string): boolean {
  const all = readInbox({ question_id: questionId, limit: 1 });
  if (all.length === 0) return false;
  const e = all[0]!;
  if (e.acked) return true;
  appendInbox({ ...e, acked: true, ts: new Date().toISOString() });
  return true;
}

// ─── v3.2.0 — external reply injection ────────────────────────────────────
//
// The subctl-buddy bridge (M5Stack ESP32 device) reads pending asks from
// `/api/asks/pending` and submits answers via `POST /api/notify/reply`,
// which forwards here. This is also how the `subctl notify reply` CLI
// verb writes its entries when the dashboard is reachable.
//
// Semantically identical to a Telegram tap: appends an inbox entry that
// `_subctl_notify_inbox_wait` (the bash --wait poll loop) will see, and
// removes the matching record from asks-pending.jsonl. Returns the new
// entry so the HTTP handler can echo it back.

export interface ExternalReplyInput {
  question_id: string;
  answer: string;
  /** Display label; defaults to `answer`. */
  answer_label?: string | null;
  /** Source tag. Default `"buddy"`. Use any non-Telegram identifier. */
  source?: string;
  /** Human-readable label for who/what answered. */
  from_name?: string | null;
}

export async function injectExternalReply(
  input: ExternalReplyInput,
): Promise<InboxEntry> {
  const ts = new Date().toISOString();
  const entry: InboxEntry = {
    ts,
    source: input.source ?? "buddy",
    type: "button",
    question_id: input.question_id,
    answer: input.answer,
    answer_label: input.answer_label ?? input.answer,
    from_id: null,
    from_name: input.from_name ?? "",
    raw_text: input.answer,
    acked: false,
  };
  appendInbox(entry);
  try {
    await removePendingAsk(input.question_id);
  } catch {
    // Best-effort — failure here doesn't invalidate the inbox entry,
    // which is the load-bearing artifact the --wait poll loop checks.
  }
  return entry;
}
