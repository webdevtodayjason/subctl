# v4 BFF bridge — dashboard surface map (Fork A)

The v3 dashboard (`:8787`) drives the v4 Rust "evy" daemon (`:8797`) via a
dashboard-as-proxy/BFF (`dashboard/lib/v4-bridge.ts`). This is a **strangler**:
chat + the chat-domain surfaces are migrated to v4; orchestration surfaces stay
on the v3 master (`:8788`). Ports: dashboard `:8787`, v3 master `:8788`,
v4 daemon `:8797`, TTS `:8789`.

## Routed to the v4 daemon (`:8797`)

| Surface | Route(s) | Notes |
|---|---|---|
| Health (ops) | `GET /health` | v4 `{ok,version}` (P0). The UI's own health/restart polling uses `/api/master/health`, which stays on v3. |
| Chat | `POST /api/evy/chat` | BFF translates v4 inline `{kind:token\|done\|error}` → v3 named events (`message_start`/`message_update`/`message_end`) and injects them into the owned events bus (P1). |
| Events bus | `GET /api/evy/events` | BFF-owned; merges v3 master non-chat events (telegram/watchdog/inbound/compact) + injected v4 chat tokens (P1). |
| Transcript | `GET /api/evy/transcript` | v4 session in v3-shape; BFF injects the current `session_id` (P2). |
| Context meter | `GET /api/evy/context`, `GET /api/evy/transcript/util` | token estimate + 4-state banner from the v4 session (P2). |
| Compact / clear | `POST /api/evy/transcript/compact\|clear` | v4 archives to `evy-archives/*.jsonl` + persists; clear resets the BFF session (P3). |

v4 sessions persist to `<state_dir>/evy-sessions.json` (atomic snapshot after each
turn, restored at boot) — they survive a daemon restart (P3, Goal 3).

## Deliberately left on the v3 master (`:8788`) — out of scope for v4 (P4–P6)

These are **orchestration / host-config** surfaces the v3 master owns. Porting
them into Rust is an explicit **non-goal** ("No wholesale port of `components/evy`
into Rust beyond the named chat-domain logic"). They are served by the v3 master
through the dashboard's generic proxy, returning their exact v3 shapes — no tab
404s/502s (Goal 4's "documented out-of-scope" clause).

| Surface | Route(s) | Owner |
|---|---|---|
| Providers | `GET /api/providers` | v3 master — AI account config / auth markers |
| Profile | `GET/POST /api/profile` | v3 master |
| Diagnostics | `GET /api/master/diag` | v3 master — CLI/tool health checks |
| Health (UI) | `GET /api/master/health` | v3 master — `uptime_s` for the restart-poll + `/status` |
| Teams | `GET /api/master/teams` | v3 master — tmux dev-team sessions |
| Supervisor | `POST /api/master/supervisor` | v3 master — model switching |
| Voice | `GET /api/voice/status`, `POST /api/voice/render\|config`, `GET /api/voice/audio/*` | v3 master → TTS `:8789` |
| Attachments | `POST /api/master/attachments` | v3 master — deferred per non-goal; BFF drops the `attachments` array on chat send |

Everything not listed in the v4 table above falls through to the v3 master via the
generic proxy in `dashboard/server.ts`. To migrate another surface to v4 later,
add a v4 handler + a BFF interceptor before the generic proxy (same pattern as P2).
