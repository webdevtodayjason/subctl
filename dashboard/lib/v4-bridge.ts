// dashboard/lib/v4-bridge.ts — BFF bridge: dashboard (:8787) → v4 Rust "evy" daemon (:8797)
//
// WHY THIS EXISTS (the load-bearing fact):
// The v3 browser (dashboard/public/tabs/chat.js) speaks a fire-and-listen
// chat model:
//   • POST /api/master/chat {text,source,attachments}  — fires a turn, only
//     checks r.ok; it does NOT read the reply off the POST body.
//   • GET  /api/master/events  (long-lived EventSource)                      —
//     reply tokens arrive here as NAMED events:
//        event: message_update  data:{assistantMessageEvent:{type:"text_delta",delta}}
//        event: message_end
// The v4 daemon speaks a different model: POST /api/evy/chat streams its reply
// INLINE on the POST response as tagged frames {kind:"token",content} /
// {kind:"done",session_id} / {kind:"error",...}; its /api/evy/events bus is
// monitoring-only (DaemonEvent — no chat tokens). chat.rs:218-250.
//
// So the seam must enclose the chat+events PAIR. This module OWNS the browser's
// events bus: it terminates GET /api/evy/events itself (merging the v3 master's
// non-chat events — telegram/watchdog/inbound/compact — passed through from
// :8788), and when a chat POST arrives it reads v4's inline stream, translates
// each frame into the v3 named events, and FANS them out to every open events
// connection.
//
// SCOPE NOTE (single-operator): delivery is a flat fan-out to all open events
// connections, and v4 conversational continuity uses one shared session. The
// dashboard is a localhost single-operator console, so this is correct and
// avoids the concurrent-EventSource cookie race (the page opens several events
// connections at once — chat tab + profile pill + app.js). If this ever serves
// multiple operators, scope both by an evy_sid cookie minted on the HTML
// response (so all of a page's connections share one id).
//
// Note: the dashboard normalizes /api/master/* → /api/evy/* before routing
// (server.ts:2920), so the routes this module handles are the /api/evy/* forms.

const V4_PORT = process.env.SUBCTL_EVY_V4_PORT ?? "8797";
const V4_BASE = `http://127.0.0.1:${V4_PORT}`;
// Legacy v3 master — still the source of non-chat events during the strangler.
const V3_PORT = process.env.SUBCTL_EVY_PORT ?? "8788";
const V3_BASE = `http://127.0.0.1:${V3_PORT}`;

const enc = new TextEncoder();

// Every open /api/evy/events connection. Chat tokens fan out to all of them.
type Ctrl = ReadableStreamDefaultController<Uint8Array>;
const subscribers = new Set<Ctrl>();
// v4 session id for conversational continuity (single-operator console).
let currentV4Session: string | null = null;

function sse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Safe enqueue — controllers close when the browser disconnects. */
function push(ctrl: Ctrl, bytes: Uint8Array): boolean {
  try {
    ctrl.enqueue(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Fan a frame out to every open events connection. */
function broadcast(bytes: Uint8Array): void {
  for (const ctrl of subscribers) {
    if (!push(ctrl, bytes)) subscribers.delete(ctrl);
  }
}

// ── translate one v4 frame → v3 named-event SSE bytes ───────────────────────
function translateFrame(frame: { kind?: string; content?: string; message?: string }): Uint8Array | null {
  switch (frame.kind) {
    case "token":
      // chat.js:1621 — lazy-creates the assistant bubble on the FIRST
      // text_delta, so no message_start bubble is needed (no empty bubbles).
      return sse("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: frame.content ?? "" },
      });
    case "error":
      // No generic "error" listener on the bus; surface the failure as a
      // visible delta so the operator sees it, then the caller emits message_end.
      return sse("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: `\n⚠️ ${frame.message ?? "v4 error"}` },
      });
    default:
      return null; // skill_loaded etc. — no browser-visible mapping (P1).
  }
}

/**
 * Drive ONE chat turn against v4: POST /api/evy/chat (SSE), translate each
 * frame, fan out to the events bus, and — if `echo` is supplied — also mirror
 * the named events onto that controller (for the curl P1 gate, which reads the
 * POST response directly). Captures the v4 session_id for reuse.
 */
async function streamV4Turn(text: string, echo?: Ctrl, signal?: AbortSignal): Promise<void> {
  const emit = (bytes: Uint8Array | null) => {
    if (!bytes) return;
    broadcast(bytes);
    if (echo) push(echo, bytes);
  };

  emit(sse("message_start", {}));

  let upstream: Response;
  try {
    upstream = await fetch(`${V4_BASE}/api/evy/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ session_id: currentV4Session, message: text }),
      signal,
    });
  } catch (err) {
    emit(translateFrame({ kind: "error", message: `v4 daemon unreachable: ${(err as Error).message}` }));
    emit(sse("message_end", {}));
    return;
  }

  if (!upstream.ok || !upstream.body) {
    emit(translateFrame({ kind: "error", message: `v4 chat HTTP ${upstream.status}` }));
    emit(sse("message_end", {}));
    return;
  }

  // Parse the v4 SSE stream frame-by-frame — forward immediately, never buffer
  // the whole reply (goal risk: "SSE buffering kills streaming UX").
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const rawFrame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        for (const line of rawFrame.split("\n")) {
          const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!trimmed) continue;
          let frame: any;
          try { frame = JSON.parse(trimmed); } catch { continue; }
          if (frame.kind === "done") {
            if (frame.session_id) currentV4Session = frame.session_id;
            emit(sse("message_end", {}));
            return;
          }
          emit(translateFrame(frame));
        }
      }
    }
  } catch (err) {
    emit(translateFrame({ kind: "error", message: `v4 stream broke: ${(err as Error).message}` }));
  }
  emit(sse("message_end", {})); // closed without an explicit done frame
}

// ── public handlers (wired in server.ts) ────────────────────────────────────

/** GET /api/evy/events — the owned chat+monitoring SSE bus. */
export function handleV4Events(req: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      subscribers.add(ctrl);
      push(ctrl, sse("connected", {})); // flip chat.js's pill to CONNECTED

      // Best-effort: pipe the v3 master's non-chat events through (telegram,
      // watchdog, inbound, compact_warning, transcript_compacted, notify…) so
      // those features don't regress during the strangler. Chat still works if
      // v3 is down.
      (async () => {
        try {
          const up = await fetch(`${V3_BASE}/api/evy/events`, {
            headers: { Accept: "text/event-stream" },
            signal: req.signal,
          });
          if (!up.ok || !up.body) return;
          const reader = up.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && !push(ctrl, value)) break;
          }
        } catch { /* v3 master optional during strangler */ }
      })();

      const cleanup = () => {
        subscribers.delete(ctrl);
        try { ctrl.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel(ctrl) {
      // ReadableStream cancel doesn't pass the controller; the abort handler
      // above is the primary cleanup path.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** POST /api/evy/chat — fire a turn at v4; tokens land on the events bus. */
export async function handleV4Chat(req: Request): Promise<Response> {
  let body: { text?: string; source?: string; attachments?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 });
  // Non-goal: attachments are deferred — dropped here (TODO: operator notice).

  const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");

  if (wantsStream) {
    // curl / programmatic clients read the reply off the POST response.
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        await streamV4Turn(text, ctrl, req.signal);
        try { ctrl.close(); } catch { /* closed */ }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
    });
  }

  // Browser path: fire-and-forget — kick off streaming to the events bus and
  // ack immediately (matches v3 chat.js, which only checks r.ok).
  void streamV4Turn(text).catch((err) => {
    broadcast(sse("message_update", {
      assistantMessageEvent: { type: "text_delta", delta: `\n⚠️ ${(err as Error).message}` },
    }));
    broadcast(sse("message_end", {}));
  });

  return Response.json({ ok: true });
}

/** POST /api/evy/transcript/clear shim — reset the shared v4 session ("New Chat"). */
export function resetV4Session(): void {
  currentV4Session = null;
}

/** Simple JSON pass-through to v4 (P0 /health, and per-phase migrated routes). */
export async function proxyV4Json(req: Request, v4Path: string): Promise<Response> {
  try {
    const init: RequestInit = { method: req.method, headers: { "Content-Type": "application/json" } };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.text();
    const up = await fetch(`${V4_BASE}${v4Path}`, init);
    const text = await up.text();
    return new Response(text, {
      status: up.status,
      headers: { "Content-Type": up.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err) {
    return Response.json({ ok: false, error: `v4 daemon unreachable: ${(err as Error).message}` }, { status: 502 });
  }
}

export const V4_BRIDGE_INFO = { V4_BASE, V3_BASE };
