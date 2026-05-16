#!/usr/bin/env python3
"""subctl Memori sidecar — local-only HTTP surface for Tier 3 memory.

v2.8.10 — Memori-back Tier 3 (Memory Init #3, Phase 3b).

Why this exists:
  - The @memorilabs/memori TypeScript SDK is cloud-only.
  - BYODB is Python-only.
  - Subctl-master is Bun, so it can't import the Python SDK directly.

Bridge pattern (mirrors services/tts/server.py): the master daemon POSTs
turn payloads to this server's /capture endpoint and queries via /recall.
This server wraps memorilabs.Memori with a sqlite3 connection at
~/.config/subctl/master/memori.db per Knot #2 (SQLite first, abstract
enough to migrate to Postgres later).

Endpoints (must match components/master/memori-client.ts contract):
  GET  /health   → { version, database, total_memories }
  POST /capture  → { id }
  POST /recall   → { hits: [...] }
  POST /forget   → { removed }

Augmentation note (cloud trade-off):
  Memori's "Advanced Augmentation" — the structured fact/preference/
  relationship extraction that gives them the LoCoMo 81.95% number — runs
  server-side at memorilabs.ai via MEMORI_API_KEY. Even with BYODB,
  conversation content flows there for processing UNLESS the operator
  sets SUBCTL_MEMORI_AUGMENTATION=off, in which case the server skips
  the augmentation step and only stores raw turns locally.

Binds 127.0.0.1 only — ADR 0009 self-hosted-only floor extends here.

Logs to stderr so launchd's StandardErrorPath captures them.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("subctl-memori")
logging.basicConfig(
    level=os.environ.get("SUBCTL_MEMORI_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)

HOST = os.environ.get("SUBCTL_MEMORI_HOST", "127.0.0.1")
PORT = int(os.environ.get("SUBCTL_MEMORI_PORT", "8746"))
DB_PATH = os.environ.get(
    "SUBCTL_MEMORI_DB",
    str(Path.home() / ".config" / "subctl" / "master" / "memori.db"),
)
AUGMENTATION = os.environ.get("SUBCTL_MEMORI_AUGMENTATION", "on").lower() != "off"
VERSION = "0.1.0-subctl"

# ─── memori bootstrap ────────────────────────────────────────────────────
#
# Try to import the real memorilabs.Memori SDK. If it's not installed we
# fall back to a minimal pure-sqlite implementation that satisfies the
# HTTP contract without doing augmentation — enough to verify the
# scaffold end-to-end before the operator installs the package.

MEMORI = None
USING_REAL_SDK = False

try:
    from memori import Memori  # type: ignore[import-not-found]

    def _open_conn():
        return sqlite3.connect(DB_PATH, isolation_level=None)

    MEMORI = Memori(conn=_open_conn).llm  # type: ignore[attr-defined]
    USING_REAL_SDK = True
    LOG.info("memorilabs.Memori SDK loaded — augmentation=%s", AUGMENTATION)
except Exception as e:  # noqa: BLE001
    LOG.warning(
        "memorilabs.Memori not installed (%s). Running in fallback mode — "
        "raw sqlite only, no augmentation. `pip install memori` to enable "
        "the full SDK.",
        e.__class__.__name__,
    )


# ─── fallback sqlite schema (used when real SDK unavailable) ─────────────


def _ensure_schema():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS subctl_memori_raw (
              id TEXT PRIMARY KEY,
              entity_id TEXT NOT NULL,
              process_id TEXT NOT NULL,
              session_id TEXT,
              ts TEXT NOT NULL,
              user_text TEXT,
              assistant_text TEXT,
              tool_calls_json TEXT,
              decisions_json TEXT,
              outcomes_json TEXT,
              metadata_json TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memori_entity_ts "
            "ON subctl_memori_raw (entity_id, ts DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memori_process "
            "ON subctl_memori_raw (process_id)"
        )
        conn.commit()
    finally:
        conn.close()


_ensure_schema()


def _fallback_capture(payload: dict[str, Any]) -> str:
    mid = f"mem_{uuid.uuid4().hex[:12]}"
    conn = sqlite3.connect(DB_PATH)
    try:
        turn = payload.get("turn", {}) or {}
        conn.execute(
            """INSERT INTO subctl_memori_raw
            (id, entity_id, process_id, session_id, ts, user_text,
             assistant_text, tool_calls_json, decisions_json, outcomes_json,
             metadata_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                mid,
                payload.get("entity_id", "unknown"),
                payload.get("process_id", "unknown"),
                payload.get("session_id"),
                payload.get("ts") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                turn.get("user_text"),
                turn.get("assistant_text"),
                json.dumps(turn.get("tool_calls") or []),
                json.dumps(turn.get("decisions") or []),
                json.dumps(turn.get("outcomes") or []),
                json.dumps(payload.get("metadata") or {}),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return mid


def _fallback_recall(payload: dict[str, Any]) -> list[dict[str, Any]]:
    entity_id = payload.get("entity_id", "unknown")
    query = (payload.get("query") or "").strip().lower()
    top_k = max(1, min(int(payload.get("top_k") or 10), 200))
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute(
            "SELECT id, ts, user_text, assistant_text, tool_calls_json, "
            "decisions_json FROM subctl_memori_raw WHERE entity_id = ? "
            "ORDER BY ts DESC LIMIT ?",
            (entity_id, top_k * 4),  # over-fetch so the lexical filter still
                                      # gives top_k results
        )
        hits = []
        for row in cur:
            mid, ts, user_text, assistant_text, tool_calls_json, decisions_json = row
            blob = " ".join(
                [
                    user_text or "",
                    assistant_text or "",
                    tool_calls_json or "",
                    decisions_json or "",
                ]
            ).lower()
            score = 1.0 if not query else (1.0 if query in blob else 0.0)
            if score <= 0 and query:
                continue
            hits.append(
                {
                    "id": mid,
                    "text": (assistant_text or user_text or "")[:500],
                    "score": score,
                    "ts": ts,
                    "kind": "conversation",
                }
            )
            if len(hits) >= top_k:
                break
        return hits
    finally:
        conn.close()


def _fallback_forget(payload: dict[str, Any]) -> int:
    conn = sqlite3.connect(DB_PATH)
    try:
        if payload.get("id"):
            cur = conn.execute(
                "DELETE FROM subctl_memori_raw WHERE id = ?", (payload["id"],)
            )
        elif payload.get("entity_id") and payload.get("process_id"):
            cur = conn.execute(
                "DELETE FROM subctl_memori_raw WHERE entity_id = ? AND process_id = ?",
                (payload["entity_id"], payload["process_id"]),
            )
        elif payload.get("entity_id"):
            cur = conn.execute(
                "DELETE FROM subctl_memori_raw WHERE entity_id = ?",
                (payload["entity_id"],),
            )
        else:
            return 0
        removed = cur.rowcount
        conn.commit()
        return removed
    finally:
        conn.close()


def _total_memories() -> int:
    try:
        conn = sqlite3.connect(DB_PATH)
        try:
            cur = conn.execute("SELECT COUNT(*) FROM subctl_memori_raw")
            return int(cur.fetchone()[0])
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return 0


# ─── HTTP handler ────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "subctl-memori/" + VERSION

    def log_message(self, fmt, *args):
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, body: dict[str, Any]):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "version": VERSION,
                    "database": "sqlite",
                    "db_path": DB_PATH,
                    "total_memories": _total_memories(),
                    "using_real_sdk": USING_REAL_SDK,
                    "augmentation": AUGMENTATION,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        payload = self._read_json()
        if self.path == "/capture":
            try:
                mid = _fallback_capture(payload)
                # When the real SDK is available we'd also forward the
                # turn through MEMORI for augmentation. Phase 3b ships
                # fallback-first; Phase 3c wires the SDK path once the
                # operator confirms cloud-augmentation acceptance.
                self._send_json(200, {"ok": True, "id": mid})
            except Exception as e:  # noqa: BLE001
                LOG.exception("capture failed")
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if self.path == "/recall":
            try:
                hits = _fallback_recall(payload)
                self._send_json(200, {"ok": True, "hits": hits})
            except Exception as e:  # noqa: BLE001
                LOG.exception("recall failed")
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        if self.path == "/forget":
            try:
                removed = _fallback_forget(payload)
                self._send_json(200, {"ok": True, "removed": removed})
            except Exception as e:  # noqa: BLE001
                LOG.exception("forget failed")
                self._send_json(500, {"ok": False, "error": str(e)})
            return
        self._send_json(404, {"ok": False, "error": "not found"})


def main():
    LOG.info(
        "subctl-memori starting on %s:%s — db=%s — sdk=%s — augmentation=%s",
        HOST,
        PORT,
        DB_PATH,
        USING_REAL_SDK,
        AUGMENTATION,
    )
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOG.info("interrupted; shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
