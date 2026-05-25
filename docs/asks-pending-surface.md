# Pending-asks surface — schema reference

**Since:** v3.2.0
**Audience:** subctl-buddy bridge maintainers, custom-dashboard authors, audit tooling.

This page is the canonical contract for the two on-disk artifacts the
buddy bridge depends on. Other consumers can rely on this exact shape
across the v3.x release line.

## File 1 — `asks-pending.jsonl`

**Path:** `${SUBCTL_CONFIG_DIR:-~/.config/subctl}/evy/asks-pending.jsonl`

**Lifecycle:**

- One line per outstanding `subctl notify ask-*` send.
- Appended by the bash sender (atomic O_APPEND of a single JSON line).
- Removed when the reply arrives via Telegram tap, `subctl notify reply`,
  or `POST /api/notify/reply`. Removal uses read-filter-write-rename
  under an `<path>.lockd` mkdir-based lock that both bash and TypeScript
  consumers honor.

**Record shape:**

```json
{
  "id":          "BLE-PROBE-1",
  "kind":        "ask-yesno",
  "question":    "test",
  "default":     "yes",
  "options":     null,
  "created_at":  "2026-05-24T22:18:31.000Z",
  "timeout_at":  null,
  "source_tool": "notify",
  "channels":    ["telegram"]
}
```

| Field         | Type                       | Notes                                                                                 |
|---------------|----------------------------|---------------------------------------------------------------------------------------|
| `id`          | string                     | Operator-visible question id. Auto-generated as `Q<ts>` if not supplied.              |
| `kind`        | `"ask-yesno" \| "ask-choice" \| "ask-text"` | Which ask-* verb originated the record.                                |
| `question`    | string                     | Question prompt as displayed.                                                          |
| `default`     | string \| null             | Default answer if `--wait` times out (ask-yesno only; null otherwise).                |
| `options`     | `[{id, label}]` \| null    | Option list for ask-choice; null otherwise.                                            |
| `created_at`  | ISO-8601 UTC string        | When the ask was sent.                                                                 |
| `timeout_at`  | ISO-8601 UTC string \| null | Deadline (if `--timeout` was passed).                                                  |
| `source_tool` | string                     | Origin tool — `"notify"` for CLI; reserved for future MCP/tooling.                    |
| `channels`    | string[]                   | Delivery channels (e.g. `["telegram"]`, `["buddy"]`, `["telegram","buddy"]`).         |

### Channel routing

`subctl notify ask-* ... --to <list>` controls delivery:

| Flag                       | Telegram send? | Pending record? | `channels` array         |
|----------------------------|----------------|-----------------|--------------------------|
| (no flag)                  | Yes            | Yes             | `["telegram"]`           |
| `--to telegram`            | Yes            | Yes             | `["telegram"]`           |
| `--to buddy`               | No             | Yes             | `["buddy"]`              |
| `--to telegram,buddy`      | Yes            | Yes             | `["telegram","buddy"]`   |
| `--to bogus`               | (rejected)     | (rejected)      | n/a                      |

**Records are always persisted regardless of routing.** Bridge consumers
filter via `record.channels.includes("buddy")` to decide whether the
buddy device should surface a given ask.

## File 2 — `inbox.jsonl` (reply schema)

**Path:** `${SUBCTL_CONFIG_DIR:-~/.config/subctl}/inbox.jsonl`

**Existing behavior preserved.** Telegram replies (text + callback_query)
continue to land here with the original schema:

- `source: "message" | "callback_query"`
- `type: "text" | "yesno-answer" | "choice-answer" | "text-answer" | "raw"`

v3.2.0 widens the schema for externally-injected replies:

- `source` accepts any string; canonical non-Telegram value is `"buddy"`.
- `type` accepts the new value `"button"` for buddy-originated taps.
- `from_id` is now `number | null` (Telegram entries keep their numeric
  user id; buddy entries set null).

**Canonical buddy reply shape:**

```json
{
  "ts":           "2026-05-24T22:30:00.000Z",
  "source":       "buddy",
  "type":         "button",
  "question_id":  "BLE-PROBE-1",
  "answer":       "yes",
  "answer_label": "Yes",
  "from_id":      null,
  "from_name":    "M5StickC Plus",
  "raw_text":     "yes",
  "acked":        false
}
```

The bash `--wait` poll loop (`_subctl_notify_inbox_wait`) matches replies
by `question_id` regardless of `source` — so externally-injected entries
are honored identically to Telegram callbacks. The originating
`subctl notify ask-* --wait` caller returns with the submitted answer.

## CLI surface

```text
# enumerate
subctl notify asks-pending [--id Q42] [--json]

# inject a reply (same effect as a Telegram tap)
subctl notify reply --id Q42 --answer yes [--source buddy] [--from-name NAME] [--answer-label LABEL]
```

The CLI is HTTP-first (consults the dashboard at 127.0.0.1:8787) with a
file-fallback (mirrors the `notify inbox` / `notify inbox-ack` pattern).

## HTTP surface

```text
GET  /api/asks/pending           → { "entries": [PendingAsk, ...] }
GET  /api/asks/pending?id=X      → PendingAsk JSON  | 404 { "error": "not found", "id": "X" }
POST /api/notify/reply           → { "ok": true, "entry": InboxEntry }
                                    body: {
                                      "question_id": "X",
                                      "answer":      "yes",
                                      "answer_label"?: "Yes",
                                      "source"?:     "buddy",
                                      "from_name"?:  "M5StickC Plus"
                                    }
```

All endpoints set `Cache-Control: no-store`. The 404 from
`GET /api/asks/pending?id=X` returns a JSON body so well-behaved clients
can distinguish "not found" from "endpoint missing".

## Concurrency contract

Two writers (the bash sender + the TypeScript removal path running in
the dashboard Bun process) coordinate via a `<path>.lockd` mkdir lock:

- Append (one JSON line) is atomic at the syscall level for writes
  under 4 KB. Acquires the lock as a defense-in-depth measure to
  serialize with rewrite-style operations.
- Remove uses read-filter-write-rename inside the same lock. The rename
  is atomic; concurrent readers see either the pre-rewrite snapshot or
  the post-rewrite snapshot, never a partial file.
- Stale locks older than 10 s are forcibly removed (any operation
  taking that long has crashed; the lock acquirer is responsible for
  the cleanup).

## What this surface is NOT for

- **Plan-approval HMAC workflow** — separate concern. The HMAC-signed
  `plan_approval_request` channel is independent of `notify ask-*` and
  is unchanged by v3.2.0.
- **Multi-buddy fanout** — one ask, many devices is a bridge-level
  protocol concern, not subctl's job.
- **Pub/sub** — no SSE on this surface in v1; poll the HTTP endpoint
  every 2 s or watch the file directly. SSE may land in a future minor
  release if there's demand.

## Handoff reference

The original integration request lives at
`/Users/you/code/subctl-buddy/docs/handoff-subctl-surface.md`. v3.2.0
implements every "Required change 1", "Required change 2", and the
"Optional but useful — channel routing" section in full.
