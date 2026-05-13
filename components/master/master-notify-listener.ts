// components/master/master-notify-listener.ts
//
// subctl master's dedicated Telegram listener. NOT a separate process — runs IN
// the master daemon (server.ts imports startMasterNotifyListener and
// calls it from main()). One Bun process, one launchd plist, one
// lifecycle.
//
// Bot conflict rule (mandatory):
//   This is the MASTER bot — completely separate from the worker
//   notify-bot driven by dashboard/notify-listener.ts. Telegram serves
//   getUpdates to the first caller per bot, so each bot must have
//   exactly ONE poller. Use a different bot token in master-notify.json
//   than the one in ~/.config/subctl/notify.json. Don't share.
//
// Inbound flow:
//   Operator → master-bot → this listener →
//     • bot commands (/start /help /status /pause /resume) handled inline
//     • free-text queued in pendingMessages, drained by the agent loop
//
// Outbound is NOT this file's job — components/master/tools/telegram.ts
// already wraps the Telegram sendMessage API for the agent's tool surface.
// We only call sendMessage here for the small set of inline command echoes.
//
// CLI-prompt bridge:
//   `subctl master prompt "..."` (lib/master.sh) appends a JSON line to
//   ~/.config/subctl/master/cli-prompts.jsonl. This listener polls that
//   file (offset-tracked) and pushes lines into the SAME pendingMessages
//   queue, so server.ts has ONE source of operator input regardless of
//   channel.
//
// Server.ts contract (sdk-wiring slice fills this in):
//   import {
//     startMasterNotifyListener,
//     drainOperatorInbox,
//     subscribeOperatorMessages,
//   } from "./master-notify-listener";
//
//   const listener = startMasterNotifyListener({
//     stateProvider: () => buildLiveDaemonState(),
//   });
//   if (!listener.running) console.error(`[master] listener: ${listener.reason}`);
//
//   // Either pull each tick…
//   const messages = drainOperatorInbox();
//   for (const m of messages) feedAgent(m);
//
//   // …or push:
//   subscribeOperatorMessages((m) => agentQueue.push(m));

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  loadProfiles,
  setActiveProfile,
  PROFILE_NAMES,
} from "./profiles";
import {
  registerWatchdog,
  touchWatchdog,
  killWatchdog,
  listWatchdogs,
  killAllWatchdogs,
} from "./watchdogs";
import {
  listNotifications,
  markAllRead as markAllNotificationsRead,
} from "./notifications";
import { describeUpstreamState } from "./upstream-check";
import { describeBackendChain } from "./secrets-backends";
import {
  recordEntry as recordMemoryEntry,
  recallEntries as recallMemoryEntries,
  redactEntryForEgress,
} from "./memory";

const HOME = homedir();
const SUBCTL_CONFIG_DIR =
  process.env.SUBCTL_CONFIG_DIR ?? join(HOME, ".config", "subctl");
const MASTER_STATE_DIR = join(SUBCTL_CONFIG_DIR, "master");
const MASTER_NOTIFY_CONFIG =
  process.env.SUBCTL_MASTER_NOTIFY_CONFIG ??
  join(SUBCTL_CONFIG_DIR, "master-notify.json");
const OFFSET_PATH = join(MASTER_STATE_DIR, "master-notify-listener.offset");
const PAUSED_FLAG = join(MASTER_STATE_DIR, "PAUSED");
const CLI_PROMPTS_PATH = join(MASTER_STATE_DIR, "cli-prompts.jsonl");
const CLI_PROMPTS_OFFSET = join(MASTER_STATE_DIR, "cli-prompts.offset");
const DECISIONS_LOG = join(MASTER_STATE_DIR, "decisions.jsonl");

// master-notify.json field names settled on `bot_token` / `chat_id` after
// the dashboard's notify-listener used those, while early drafts of this
// listener used the `telegram_*` prefix. Accept either to avoid forcing a
// migration. See loadConfig() below for the merge.
interface MasterNotifyConfig {
  // canonical
  bot_token?: string;
  chat_id?: string;
  // legacy / alternate
  telegram_bot_token?: string;
  telegram_chat_id?: string;
}

export interface OperatorMessage {
  ts: string;
  source: "telegram" | "cli";
  text: string;
  from_id: number | null;
  from_name: string | null;
  chat_id: string | null;
}

type StateProvider = () => unknown;
type MessageSubscriber = (msg: OperatorMessage) => void;

let _running = false;
let _abortController: AbortController | null = null;
let _stateProvider: StateProvider | null = null;
let _allowedChatId: string | null = null;
let _botUsername: string | null = null;

const pendingMessages: OperatorMessage[] = [];
const subscribers: MessageSubscriber[] = [];

export interface StartMasterListenerOptions {
  stateProvider?: StateProvider;
  onOperatorMessage?: MessageSubscriber;
}

export function startMasterNotifyListener(
  opts: StartMasterListenerOptions = {},
): { running: boolean; reason?: string } {
  if (_running) return { running: true, reason: "already running" };

  if (!existsSync(MASTER_NOTIFY_CONFIG)) {
    return {
      running: false,
      reason: `no master-notify.json at ${MASTER_NOTIFY_CONFIG} — see components/master/README.md`,
    };
  }

  let cfg: MasterNotifyConfig;
  try {
    cfg = JSON.parse(readFileSync(MASTER_NOTIFY_CONFIG, "utf8"));
  } catch {
    return { running: false, reason: "master-notify.json unreadable / not JSON" };
  }
  // Accept either `bot_token`/`chat_id` (canonical) or `telegram_*` (legacy).
  const botToken = cfg.bot_token ?? cfg.telegram_bot_token;
  const chatId = cfg.chat_id ?? cfg.telegram_chat_id ?? null;
  if (!botToken) {
    return {
      running: false,
      reason: "no bot_token (or telegram_bot_token) in master-notify.json",
    };
  }

  mkdirSync(MASTER_STATE_DIR, { recursive: true });

  _stateProvider = opts.stateProvider ?? null;
  _allowedChatId = chatId ? String(chatId) : null;
  if (opts.onOperatorMessage) subscribers.push(opts.onOperatorMessage);

  _running = true;
  _abortController = new AbortController();

  // v2.7.19 watchdog registry — register the two looping consumers
  // before they start. The kill closures call _stopInternal() (raw
  // abort + flag flip, no killWatchdog re-entry), which is also what
  // stopMasterNotifyListener() does after deregistering; that
  // separation prevents infinite recursion when killWatchdog invokes
  // entry.kill which would otherwise call back into killWatchdog.
  try {
    registerWatchdog({
      id: "telegram-listener",
      kind: "telegram-listener",
      kill: () => _stopInternal(),
    });
  } catch (err) {
    // Duplicate id — listener restarted without registry cleanup.
    // Best-effort: continue, since the listener itself is still wired.
    console.error(
      `[master-notify] watchdog register failed (telegram-listener): ${(err as Error).message}`,
    );
  }
  try {
    registerWatchdog({
      id: "cli-prompt-poll",
      kind: "cli-prompt-poll",
      kill: () => _stopInternal(),
    });
  } catch (err) {
    console.error(
      `[master-notify] watchdog register failed (cli-prompt-poll): ${(err as Error).message}`,
    );
  }

  pollLoop(botToken, _abortController.signal).catch((err) => {
    console.error("[master-notify] poll loop crashed:", err?.message || err);
    _running = false;
  });

  cliPromptLoop(_abortController.signal).catch((err) => {
    console.error("[master-notify] cli-prompt loop crashed:", err?.message || err);
  });

  return { running: true };
}

// Private — actually tear down the abort controller + flip the flag.
// Split out so the watchdog-registry kill closures can call this
// without going through killWatchdog() (which would re-enter and
// recurse infinitely). Idempotent.
function _stopInternal(): void {
  if (_abortController) {
    _abortController.abort();
    _abortController = null;
  }
  _running = false;
}

export function stopMasterNotifyListener(): void {
  _stopInternal();
  // v2.7.19 — deregister both watchdog ids. killWatchdog() returns
  // { ok: false } on an unknown id, which is fine here (already
  // deregistered by an earlier kill or never registered yet).
  killWatchdog("telegram-listener");
  killWatchdog("cli-prompt-poll");
}

export function masterNotifyListenerStatus(): {
  running: boolean;
  offset: number;
  queue_size: number;
  bot_username: string | null;
} {
  let offset = 0;
  try {
    offset = Number(readFileSync(OFFSET_PATH, "utf8").trim()) || 0;
  } catch {
    offset = 0;
  }
  return {
    running: _running,
    offset,
    queue_size: pendingMessages.length,
    bot_username: _botUsername,
  };
}

// Drain the in-process operator-message queue. Returns all queued messages
// in arrival order and clears the queue. Server.ts's agent loop calls
// this on each tick (or after each tool call) to feed the agent.
export function drainOperatorInbox(): OperatorMessage[] {
  if (pendingMessages.length === 0) return [];
  return pendingMessages.splice(0, pendingMessages.length);
}

// Subscribe to operator messages as they arrive. Returns a disposer.
// Use this OR drainOperatorInbox(), not both — push and pull would
// double-count the same message.
export function subscribeOperatorMessages(cb: MessageSubscriber): () => void {
  subscribers.push(cb);
  return () => {
    const idx = subscribers.indexOf(cb);
    if (idx !== -1) subscribers.splice(idx, 1);
  };
}

function enqueueOperatorMessage(msg: OperatorMessage) {
  pendingMessages.push(msg);
  for (const s of subscribers) {
    try {
      s(msg);
    } catch (e) {
      console.error("[master-notify] subscriber threw:", (e as any)?.message || e);
    }
  }
}

async function pollLoop(token: string, signal: AbortSignal) {
  console.error("[master-notify] starting Telegram long-poll");

  // Pre-flight: verify bot identity, warn on webhook (would block polling).
  try {
    const me = (await fetch(`https://api.telegram.org/bot${token}/getMe`).then(
      (r) => r.json(),
    )) as any;
    if (me?.ok) {
      _botUsername = me.result.username;
      console.error(`[master-notify] bot: @${_botUsername}`);
    } else {
      console.error("[master-notify] getMe failed — bot token likely invalid");
    }
    const wh = (await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
    ).then((r) => r.json())) as any;
    if (wh?.result?.url) {
      console.error(
        `[master-notify] WARNING: webhook set on this bot (${wh.result.url}) — getUpdates will return 409. Disable the webhook OR use a different bot.`,
      );
    }
  } catch (e) {
    console.error("[master-notify] preflight failed:", (e as any)?.message);
  }

  // Resume from saved offset so a restart doesn't replay updates.
  let offset = 0;
  try {
    offset = Number(readFileSync(OFFSET_PATH, "utf8").trim()) || 0;
  } catch {
    offset = 0;
  }

  while (!signal.aborted) {
    // v2.7.19 watchdog freshness — bumped at the START of each loop
    // iteration so listWatchdogs() shows a recent tick even when
    // long-poll is blocked waiting on Telegram.
    touchWatchdog("telegram-listener");
    try {
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set("timeout", "25");
      if (offset > 0) url.searchParams.set("offset", String(offset));
      url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

      const r = await fetch(url, { signal });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        if (r.status === 409) {
          console.error(
            "[master-notify] HTTP 409 — bot has a webhook OR another poller is running. Backing off 60s.",
          );
          await sleep(60_000);
          continue;
        }
        console.error(`[master-notify] HTTP ${r.status}: ${body.slice(0, 200)}`);
        await sleep(5_000);
        continue;
      }
      const j = (await r.json()) as any;
      if (!j?.ok || !Array.isArray(j.result)) {
        await sleep(5_000);
        continue;
      }
      for (const update of j.result) {
        try {
          await handleUpdate(update, token);
        } catch (e) {
          console.error(
            "[master-notify] handleUpdate error:",
            (e as any)?.message,
          );
        }
        if (typeof update.update_id === "number") {
          offset = update.update_id + 1;
        }
      }
      try {
        writeFileSync(OFFSET_PATH, String(offset));
      } catch {
        /* offset persistence is best-effort */
      }
    } catch (e: any) {
      if (e?.name === "AbortError") break;
      console.error("[master-notify] poll error:", e?.message || e);
      await sleep(5_000);
    }
  }
  console.error("[master-notify] stopped");
  _running = false;
}

async function handleUpdate(update: any, token: string) {
  if (!update.message) return;
  const msg = update.message;
  const text: string = (msg.text ?? "").trim();
  if (!text) return;

  const fromId: number = msg.from?.id ?? 0;
  const fromName: string = msg.from?.first_name ?? "(unknown)";
  const chatId: string = String(msg.chat?.id ?? "");
  const ts = new Date().toISOString();

  // Auth: subctl master's tool surface can take real action (spawn workers, run gh
  // commands). Drop messages from any chat other than the configured one
  // — strangers must not have a path in.
  if (_allowedChatId && chatId !== _allowedChatId) {
    console.error(
      `[master-notify] dropping message from unauthorized chat=${chatId} from=${fromName}(${fromId})`,
    );
    return;
  }

  if (text.startsWith("/")) {
    const reply = await handleBotCommand(text);
    await sendMessage(chatId, reply, token);
    return;
  }

  enqueueOperatorMessage({
    ts,
    source: "telegram",
    text,
    from_id: fromId,
    from_name: fromName,
    chat_id: chatId,
  });
}

async function handleBotCommand(text: string): Promise<string> {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().split("@")[0]!;
  switch (cmd) {
    case "/start":
    case "/help":
      return formatHelp();
    case "/status":
      return formatStatus();
    case "/pause": {
      try {
        mkdirSync(MASTER_STATE_DIR, { recursive: true });
        writeFileSync(PAUSED_FLAG, new Date().toISOString());
        return "⏸  subctl master review loop PAUSED.\n\nThe daemon checks this flag each tick — already-running tools will complete. Resume with /resume.";
      } catch (e: any) {
        return `pause failed: ${e?.message || e}`;
      }
    }
    case "/resume": {
      try {
        if (existsSync(PAUSED_FLAG)) {
          unlinkSync(PAUSED_FLAG);
          return "▶️  subctl master review loop RESUMED.";
        }
        return "ℹ️  subctl master was not paused.";
      } catch (e: any) {
        return `resume failed: ${e?.message || e}`;
      }
    }
    case "/profile":
      // v2.7.18 — read or set the supervisor profile from Telegram.
      // `/profile`            → report the active profile + its supervisor model
      // `/profile chat|heavy` → swap to that profile (master picks it up on
      //                          the next prompt via the profiles.json watcher)
      // Anything else         → usage help. We don't bounce master; the
      // fs.watch in components/master/profiles.ts handles propagation.
      return handleProfileCommand(parts.slice(1));
    case "/watchdogs":
      // v2.7.19 — operator's emergency kill path for stuck periodic
      // probes. `/watchdogs` lists, `/watchdogs kill <id>` kills one,
      // `/watchdogs killall` nukes everything except the telegram
      // listener itself (since we need it alive to hear the next
      // command). The looping-tool incident on 2026-05-13 is the
      // motivating bug; see components/master/watchdogs.ts header.
      return handleWatchdogsCommand(parts.slice(1));
    case "/terminal":
      // v2.7.21 (ADR 0011 Layer 2) — operator-facing on/off control for
      // the web-terminal escape hatch in the dashboard. The dashboard
      // server checks for `~/.config/subctl/terminal.enabled` on every
      // /api/terminal/* request; this command just touches/removes that
      // flag and reports state. Default is OFF.
      return handleTerminalCommand(parts.slice(1));
    case "/notifications":
      // v2.7.22 — operator-facing read of the master's notification
      // ring buffer. `/notifications` returns the last 5; `/notifications
      // read` marks all as read. Higher-severity alerts already push
      // here on emit; this command lets the operator scrollback / clear
      // without opening the dashboard.
      return handleNotificationsCommand(parts.slice(1));
    case "/upstreams":
      // v2.7.25 — pi-ai + pi-agent-core watchdog state. `/upstreams`
      // returns the most recent check; the watchdog ticks every 6h on
      // its own. See ADR 0015 (always-latest policy) +
      // components/master/upstream-check.ts.
      return handleUpstreamsCommand();
    case "/secrets":
      // v2.7.31 — ADR 0012 backend chain status. Lists the configured
      // resolution order (default: env → 1Password → file), per-key
      // overrides, 1Password CLI availability, and cache stats. NEVER
      // surfaces a secret value.
      return handleSecretsCommand();
    case "/memory":
      // v2.7.23 — operator-facing query of Evy Memory (Tier 3).
      //   /memory <query>   → top 3 most-relevant matches
      //   /memory recent    → last 5 entries (terse)
      // Memory entries pass through redactEntryForEgress on the way out
      // so an HMAC mark / sk-* / bearer token can't leak through chat
      // even if the operator searched a noisy term.
      return handleMemoryCommand(parts.slice(1));
    case "/remember":
      // v2.7.23 — operator-facing save into Evy Memory. Everything after
      // "/remember " becomes a kind="operator-note" entry. Replies "saved"
      // with the id (so /memory <text> can find it back).
      return handleRememberCommand(text.slice("/remember".length));
    default:
      return `Unknown command: ${cmd}\n\nTry: /status, /pause, /resume, /profile, /watchdogs, /terminal, /notifications, /upstreams, /secrets, /memory, /remember, /help`;
  }
}

function handleSecretsCommand(): string {
  const s = describeBackendChain();
  const lines: string[] = ["🔐 Secret backends (ADR 0012):", ""];
  lines.push(`Chain: ${s.default_chain.join(" → ")}`);
  if (Object.keys(s.overrides).length > 0) {
    lines.push("");
    lines.push("Per-key overrides:");
    for (const [k, chain] of Object.entries(s.overrides)) {
      lines.push(`  • ${k}: ${chain.join(" → ")}`);
    }
  }
  lines.push("");
  lines.push("1Password backend:");
  lines.push(`  op CLI:    ${s.onepassword.cli_available ? "✓ installed" : "✗ missing"}`);
  lines.push(`  token:     ${s.onepassword.token_set ? "✓ set" : "✗ unset (OP_SERVICE_ACCOUNT_TOKEN)"}`);
  const status =
    s.onepassword.cli_available && s.onepassword.token_set
      ? "active"
      : "inactive (falls through to file)";
  lines.push(`  status:    ${status}`);
  lines.push(`  cache:     ${s.onepassword.cache_size} entr${s.onepassword.cache_size === 1 ? "y" : "ies"} (TTL ${Math.round(s.onepassword.cache_ttl_ms / 1000)}s)`);
  lines.push("");
  lines.push("No secret values are ever returned via this command.");
  return lines.join("\n");
}

function handleUpstreamsCommand(): string {
  const state = describeUpstreamState();
  const lines: string[] = ["📦 Upstreams (ADR 0015 always-latest):", ""];
  if (!state.checked_at) {
    lines.push("(no check yet — watchdog fires on boot+20s, then every 6h)");
    return lines.join("\n");
  }
  const when = state.checked_at.slice(11, 19);
  lines.push(`Last check: ${when}Z`);
  lines.push("");
  for (const r of state.results) {
    if (r.error) {
      lines.push(`• ${r.package}: ⚠ ${r.error}`);
      continue;
    }
    if (r.has_update) {
      lines.push(
        `• ${r.package}: ${r.pinned} → ${r.latest} (${r.bump_kind})`,
      );
    } else {
      lines.push(`• ${r.package}: ${r.pinned} (latest)`);
    }
  }
  lines.push("");
  lines.push(
    state.auto_update_enabled
      ? `Auto-update gate: ON (${state.auto_update_flag_path})`
      : `Auto-update gate: OFF — touch ${state.auto_update_flag_path} to enable`,
  );
  return lines.join("\n");
}

function handleMemoryCommand(args: string[]): string {
  const sub = (args[0] || "").trim().toLowerCase();
  // `/memory recent` — last 5 entries, terse.
  if (sub === "recent" || sub === "") {
    if (sub === "" && args.length === 0) {
      // No args at all → recent
    }
    if (sub === "recent" || args.length === 0) {
      const last = recallMemoryEntries({ limit: 5 });
      if (last.length === 0) return "(no memory entries)";
      const lines: string[] = ["📒 Last 5 memory entries:", ""];
      for (const e of last.map(redactEntryForEgress)) {
        lines.push(formatMemoryLine(e));
      }
      lines.push("");
      lines.push("Search: /memory <query>");
      lines.push("Save:   /remember <text>");
      return lines.join("\n");
    }
  }
  // `/memory <query>` — text search, top 3.
  const query = args.join(" ").trim();
  if (!query) {
    return "Usage:\n/memory <query>   — top 3 matches\n/memory recent    — last 5 entries";
  }
  const hits = recallMemoryEntries({ query, limit: 3 });
  if (hits.length === 0) {
    return `🔍 no memory matches for: ${query}`;
  }
  const lines: string[] = [`🔍 Top ${hits.length} for "${query}":`, ""];
  for (const e of hits.map(redactEntryForEgress)) {
    lines.push(formatMemoryLine(e));
  }
  return lines.join("\n");
}

function formatMemoryLine(e: {
  ts: string;
  role: string;
  kind: string;
  team_id?: string | null;
  content: string;
}): string {
  // YYYY-MM-DD HH:MM — short and absolute so it works across timezones
  // without the operator doing arithmetic. Telegram font is tight; keep
  // each entry on one logical block.
  const when = e.ts.slice(0, 10) + " " + e.ts.slice(11, 16);
  const scope = e.team_id ? `@${e.team_id}` : "·";
  const head = `${when} ${scope} [${e.role}/${e.kind}]`;
  const body =
    e.content.length > 220 ? e.content.slice(0, 217) + "…" : e.content;
  return `${head}\n${body}\n`;
}

function handleRememberCommand(rest: string): string {
  const content = rest.trim();
  if (!content) {
    return "Usage: /remember <text>\n\nSaves the text into Evy Memory under kind=operator-note. Recall later with /memory <query>.";
  }
  try {
    const entry = recordMemoryEntry({
      role: "user",
      kind: "operator-note",
      content,
      metadata: { source: "telegram" },
    });
    return `💾 saved (${entry.id.slice(0, 8)})`;
  } catch (e: any) {
    return `remember failed: ${e?.message || e}`;
  }
}

function handleNotificationsCommand(args: string[]): string {
  const sub = (args[0] || "").trim().toLowerCase();
  if (sub === "read") {
    const marked = markAllNotificationsRead();
    return marked === 0
      ? "(no unread notifications)"
      : `marked ${marked} notification(s) as read`;
  }
  const last = listNotifications({ limit: 5 });
  if (last.length === 0) return "(no notifications)";
  const lines: string[] = ["📬 Last 5 notifications:", ""];
  for (const n of last) {
    const sev =
      n.severity === "alert" ? "🚨" : n.severity === "warn" ? "⚠️" : "ℹ️";
    const readMark = n.read_at ? "  " : "● ";
    const when = n.ts.slice(11, 16);
    lines.push(`${readMark}${sev} ${when} · ${n.title}`);
  }
  lines.push("");
  lines.push("Mark all read: /notifications read");
  return lines.join("\n");
}

function terminalFlagFilePath(): string {
  // Mirrors dashboard/terminal.ts terminalFlagPath() — kept in sync.
  return join(SUBCTL_CONFIG_DIR, "terminal.enabled");
}

function handleTerminalCommand(args: string[]): string {
  const sub = (args[0] || "").trim().toLowerCase();
  const path = terminalFlagFilePath();
  if (!sub || sub === "status") {
    const on = existsSync(path);
    if (on) {
      return [
        "🟢 web terminal is ON",
        "",
        `flag: ${path}`,
        "Operator can open an in-browser tmux attach from each team card in",
        "the dashboard (orchestration cockpit). Bypasses master + HMAC.",
      ].join("\n");
    }
    return [
      "⚪ web terminal is OFF (default)",
      "",
      `flag: ${path}`,
      "Enable with `/terminal on`, or `touch ${path}` directly.",
    ].join("\n");
  }
  if (sub === "on" || sub === "enable") {
    try {
      mkdirSync(SUBCTL_CONFIG_DIR, { recursive: true });
      writeFileSync(path, new Date().toISOString() + "\n");
      return "🟢 web terminal enabled — refresh the dashboard to see Attach buttons on team cards.";
    } catch (e: any) {
      return `terminal enable failed: ${e?.message || e}`;
    }
  }
  if (sub === "off" || sub === "disable") {
    try {
      if (existsSync(path)) unlinkSync(path);
      return "⚪ web terminal disabled — Attach buttons hidden in the dashboard.";
    } catch (e: any) {
      return `terminal disable failed: ${e?.message || e}`;
    }
  }
  return [
    `Unknown /terminal subcommand: ${sub}`,
    "",
    "/terminal               show on/off state",
    "/terminal on            enable the web terminal escape hatch",
    "/terminal off           disable",
  ].join("\n");
}

function handleWatchdogsCommand(args: string[]): string {
  const sub = (args[0] || "").trim().toLowerCase();
  // No subcommand → list. Mirrors the `/profile` shape (no arg = read).
  if (!sub) {
    const all = listWatchdogs();
    if (all.length === 0) {
      return "No watchdogs registered.";
    }
    const lines: string[] = ["🐕 Active watchdogs:", ""];
    for (const w of all) {
      const ageStr =
        w.age_seconds < 60
          ? `${w.age_seconds}s`
          : w.age_seconds < 3600
            ? `${Math.floor(w.age_seconds / 60)}m`
            : `${(w.age_seconds / 3600).toFixed(1)}h`;
      lines.push(`• ${w.id} (${w.kind}) — age ${ageStr}`);
    }
    lines.push("");
    lines.push("Kill one: /watchdogs kill <id>");
    lines.push("Kill all (keeps telegram alive): /watchdogs killall");
    return lines.join("\n");
  }

  if (sub === "killall") {
    // Preserve the telegram listener — kind, not id — so a renamed
    // listener still survives. Reply mirrors the registry's killed +
    // preserved id lists for transparency.
    const result = killAllWatchdogs({ preserve_kinds: ["telegram-listener"] });
    const lines: string[] = [];
    lines.push(`killed ${result.killed.length} watchdog(s), kept telegram-listener alive`);
    if (result.killed.length > 0) {
      lines.push("");
      lines.push("Killed:");
      for (const id of result.killed) lines.push(`  • ${id}`);
    }
    if (result.preserved.length > 0) {
      lines.push("");
      lines.push("Preserved:");
      for (const id of result.preserved) lines.push(`  • ${id}`);
    }
    return lines.join("\n");
  }

  if (sub === "kill") {
    const id = (args[1] || "").trim();
    if (!id) {
      return "Usage: /watchdogs kill <id>\n\nRun /watchdogs to see ids.";
    }
    const r = killWatchdog(id);
    if (r.ok) return `✅ killed watchdog: ${r.killed_id}`;
    return `❌ ${r.error}`;
  }

  return "Usage:\n/watchdogs              — list\n/watchdogs kill <id>    — kill one\n/watchdogs killall      — kill all (keeps telegram-listener)";
}

function handleProfileCommand(args: string[]): string {
  const subject = (args[0] || "").trim().toLowerCase();
  if (!subject) {
    try {
      const file = loadProfiles();
      const entry = file.profiles[file.active];
      return `profile: ${file.active} (${entry.supervisor})`;
    } catch (e: any) {
      return `profile read failed: ${e?.message || e}`;
    }
  }
  if (!(PROFILE_NAMES as ReadonlyArray<string>).includes(subject)) {
    return `Usage: /profile [${PROFILE_NAMES.join("|")}]\n\n${formatProfileList()}`;
  }
  try {
    setActiveProfile(subject);
    return `swapped → ${subject} on next prompt`;
  } catch (e: any) {
    return `profile swap failed: ${e?.message || e}`;
  }
}

function formatProfileList(): string {
  try {
    const file = loadProfiles();
    const lines: string[] = [];
    for (const name of PROFILE_NAMES) {
      const entry = file.profiles[name];
      const marker = name === file.active ? "● " : "  ";
      lines.push(`${marker}${name}: ${entry.supervisor}`);
    }
    return lines.join("\n");
  } catch {
    return "(profile state unavailable)";
  }
}

function formatHelp(): string {
  return [
    "🤖 subctl master — the dev-team conductor",
    "",
    "/start, /help          this message",
    "/status                current daemon state + recent activity",
    "/pause                 halt the autonomous review loop",
    "/resume                resume after pause",
    "/profile               show active supervisor profile",
    "/profile chat          swap to the chat supervisor (gemma — fast, conversational)",
    "/profile heavy         swap to the heavy supervisor (qwen — deep reasoning)",
    "/watchdogs             list active watchdogs",
    "/watchdogs kill <id>   kill one watchdog",
    "/watchdogs killall     kill all (keeps telegram-listener alive)",
    "/terminal              web-terminal escape-hatch state",
    "/terminal on|off       toggle dashboard's in-browser tmux attach",
    "/notifications         show last 5 operator notifications",
    "/notifications read    mark all notifications read",
    "/upstreams             pi-ai + pi-agent-core check state (ADR 0015)",
    "/secrets               secret backend chain status (ADR 0012, no values)",
    "/memory <query>        search Evy Memory (Tier 3) — top 3 hits",
    "/memory recent         show last 5 memory entries",
    "/remember <text>       save a durable note into Evy Memory",
    "",
    "Free-text messages are queued for the next agent turn — subctl master",
    "will act on them per its policy and report back.",
  ].join("\n");
}

function formatStatus(): string {
  const lines: string[] = [];
  lines.push(
    `📊 subctl master · ${new Date().toISOString().slice(0, 19).replace("T", " ")}Z`,
  );
  lines.push("");
  lines.push(`Loop: ${existsSync(PAUSED_FLAG) ? "⏸ PAUSED" : "▶️ running"}`);
  lines.push(`Queued operator messages: ${pendingMessages.length}`);

  if (_stateProvider) {
    try {
      const s = _stateProvider() as any;
      if (s?.last_review_ts) lines.push(`Last review: ${s.last_review_ts}`);
      if (s?.active_projects) {
        const pcount = Object.keys(s.active_projects).length;
        lines.push(`Active projects: ${pcount}`);
      }
      if (s?.known_workers) {
        const wcount = Object.keys(s.known_workers).length;
        lines.push(`Known workers: ${wcount}`);
      }
    } catch (e: any) {
      lines.push(`(state unavailable: ${e?.message || e})`);
    }
  } else {
    lines.push(
      "(stateProvider not wired — pass one to startMasterNotifyListener)",
    );
  }

  if (existsSync(DECISIONS_LOG)) {
    try {
      const all = readFileSync(DECISIONS_LOG, "utf8").trim().split("\n");
      const last = all.slice(-3).filter(Boolean);
      if (last.length) {
        lines.push("");
        lines.push("Recent decisions:");
        for (const line of last) {
          try {
            const d = JSON.parse(line);
            const t = (d.ts || "").slice(11, 19);
            lines.push(`  ${t}Z · ${d.project || "—"} · ${d.action || "—"}`);
          } catch {
            /* skip bad line */
          }
        }
      }
    } catch {
      /* swallow — log read is best-effort */
    }
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
    console.error("[master-notify] sendMessage failed:", (e as any)?.message);
  }
}

// CLI-prompt bridge: poll the cli-prompts.jsonl file written by
// `subctl master prompt "..."`. Byte-offset-tracked so a daemon
// restart doesn't replay history. On first start (no offset file),
// we skip whatever's already in the file — we only consume prompts
// queued AFTER boot.
async function cliPromptLoop(signal: AbortSignal) {
  let offset = 0;
  try {
    offset = Number(readFileSync(CLI_PROMPTS_OFFSET, "utf8").trim()) || 0;
  } catch {
    offset = 0;
  }

  if (offset === 0 && existsSync(CLI_PROMPTS_PATH)) {
    try {
      offset = statSync(CLI_PROMPTS_PATH).size;
      writeFileSync(CLI_PROMPTS_OFFSET, String(offset));
    } catch {
      /* best-effort */
    }
  }

  while (!signal.aborted) {
    // v2.7.19 watchdog freshness.
    touchWatchdog("cli-prompt-poll");
    try {
      if (existsSync(CLI_PROMPTS_PATH)) {
        const size = statSync(CLI_PROMPTS_PATH).size;
        if (size < offset) {
          // file rotated/truncated — restart from 0
          offset = 0;
        }
        if (size > offset) {
          const whole = readFileSync(CLI_PROMPTS_PATH);
          const newBytes = whole.subarray(offset).toString("utf8");
          const lines = newBytes.split("\n").filter((l) => l.trim().length > 0);
          for (const line of lines) {
            try {
              const j = JSON.parse(line) as any;
              const text = String(j.text ?? "").trim();
              if (!text) continue;
              enqueueOperatorMessage({
                ts: j.ts ?? new Date().toISOString(),
                source: "cli",
                text,
                from_id: null,
                from_name: j.user ?? "cli",
                chat_id: null,
              });
            } catch {
              console.error(
                "[master-notify] bad cli-prompt line:",
                line.slice(0, 100),
              );
            }
          }
          offset = size;
          try {
            writeFileSync(CLI_PROMPTS_OFFSET, String(offset));
          } catch {
            /* best-effort */
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") break;
      console.error("[master-notify] cli-prompt poll error:", e?.message || e);
    }
    // 2s cadence — local stat() is cheap, and operator latency on a
    // CLI prompt is not user-perceptible at this granularity.
    await sleep(2_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
