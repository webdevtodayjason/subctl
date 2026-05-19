#!/usr/bin/env python3
"""subctl Cognee sidecar — local-only HTTP surface for Tier 4 memory.

v2.8.x — Memory Init #1 first-class install (Knot #1 finalization).

Why this exists:
  - The cognee Python SDK is the canonical entry point (remember/recall/
    forget/cognify/memify) and the upstream FastAPI server bundles a lot
    of optional surface (auth, sessions, OAuth, datasets, ontologies)
    that we don't need from subctl-master and that drifts in shape
    between versions.
  - components/master/cognee-client.ts speaks a stable, narrow contract:
    GET /health, POST /remember, POST /recall, POST /forget,
    POST /graph/neighbors, POST /graph/path, POST /graph/query.
  - This shim wraps the SDK so that contract stays stable across cognee
    version bumps — same pattern as services/memori/server.py wraps
    memorilabs.Memori.

When the cognee package is installed, real SDK calls are made through
`cognee.add()` + `cognee.cognify()` + `cognee.search()`. When it isn't,
we run in fallback mode: /health returns reachable=true with
using_real_sdk=false, and the operations return empty results rather
than 500ing. This lets the master flip its TOOL_GATES.cognee gate ON
the moment the launchd plist exists and the sidecar binds the port,
even before the operator decides whether to pull the ~2GB SDK + models.

LLM provider: by default the sidecar wires Cognee through a LOCAL
OpenAI-compatible endpoint (LM Studio at http://localhost:1234/v1) via
the SUBCTL_COGNEE_LLM_* env vars. This keeps embeddings + augmentation
local — ADR 0009 self-hosted-only floor — and avoids OpenAI cloud
charges. Operator can override with any OpenAI-compatible endpoint
(Ollama, vLLM, OpenRouter, real OpenAI) by changing the env vars in
the launchd plist and kickstarting.

Binds 127.0.0.1 only — ADR 0009 self-hosted-only floor extends here.

Logs to stderr so launchd's StandardErrorPath captures them.

Tokenizer adapter
-----------------
Cognee 1.1 calls `tiktoken.encoding_for_model(<embedding-model-name>)` from
its TikTokenTokenizer, which has no entry for local embeddings like
`text-embedding-nomic-embed-text-v1.5`. Result: KeyError before chunking
even begins.

The fix lives in `services/cognee/tokenizer_adapter.py`. Its
`install_patch()` runs once, BEFORE `import cognee`, and:

1. Monkey-patches `tiktoken.encoding_for_model` + `tiktoken.get_encoding`
   to consult a model→HF-repo registry and return a TiktokenLike adapter
   when the alias is local. OpenAI names still go through the original
   tiktoken path; unknown non-OpenAI names raise a LOUD KeyError naming
   the model + the registry's path.
2. Also patches `transformers.AutoTokenizer.from_pretrained` to redirect
   known aliases to their real HF repo — this fixes Cognee's
   OpenAICompatibleEmbeddingEngine, which calls
   `HuggingFaceTokenizer(model=self.model)` and previously fell back to
   cl100k_base when the alias wasn't a real HF repo id.

To add a new local embedding model: edit REGISTRY in
`tokenizer_adapter.py` OR call `register_local_tokenizer()` before
`install_patch()`. See that file's docstring for the full rationale.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("subctl-cognee")
logging.basicConfig(
    level=os.environ.get("SUBCTL_COGNEE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)

HOST = os.environ.get("SUBCTL_COGNEE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SUBCTL_COGNEE_PORT", "8745"))
# Accept both SUBCTL_COGNEE_DATA_DIR (spec name) and SUBCTL_COGNEE_DATA
# (legacy). Either works; SUBCTL_COGNEE_DATA_DIR wins if both set.
DATA_DIR = os.environ.get(
    "SUBCTL_COGNEE_DATA_DIR",
    os.environ.get(
        "SUBCTL_COGNEE_DATA",
        str(Path.home() / ".config" / "subctl" / "cognee-data"),
    ),
)
AUTH_TOKEN = os.environ.get("SUBCTL_COGNEE_AUTH_TOKEN") or os.environ.get(
    "COGNEE_AUTH_TOKEN"
)
DEFAULT_DATASET = os.environ.get("SUBCTL_COGNEE_DEFAULT_DATASET", "subctl_main")

# ── LLM provider config — local-first by default ──────────────────────────
# These env vars come from the launchd plist (or operator override). When
# SUBCTL_COGNEE_LLM_BASE is set, we wire cognee's litellm-based config
# (LLM_PROVIDER=custom, LLM_ENDPOINT, LLM_MODEL, LLM_API_KEY) BEFORE the
# `import cognee` so the SDK picks them up at module load.
LLM_BASE = os.environ.get("SUBCTL_COGNEE_LLM_BASE")  # e.g. http://localhost:1234/v1
LLM_MODEL = os.environ.get("SUBCTL_COGNEE_LLM_MODEL")
LLM_KEY = os.environ.get("SUBCTL_COGNEE_LLM_KEY", "lm-studio")
EMBED_PROVIDER = os.environ.get("SUBCTL_COGNEE_EMBED_PROVIDER")
EMBED_MODEL = os.environ.get("SUBCTL_COGNEE_EMBED_MODEL")
EMBED_BASE = os.environ.get("SUBCTL_COGNEE_EMBED_BASE")  # defaults to LLM_BASE
EMBED_KEY = os.environ.get("SUBCTL_COGNEE_EMBED_KEY", LLM_KEY)

VERSION = "0.2.0-subctl"

Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
# Cognee respects these env vars when its SDK is imported. Set them
# BEFORE the import so the data root + LLM config land before any SDK
# initialization.
os.environ.setdefault("COGNEE_DATA_ROOT_DIRECTORY", DATA_DIR)
os.environ.setdefault(
    "COGNEE_SYSTEM_ROOT_DIRECTORY",
    str(Path(DATA_DIR) / ".cognee_system"),
)

def _ensure_litellm_prefix(model: str, default_prefix: str) -> str:
    """Cognee + litellm need `<provider>/<model>` to route correctly.
    Auto-prefix if the caller passed a bare model id (no slash).
    """
    if not model or "/" in model:
        return model
    return f"{default_prefix}/{model}"


if LLM_BASE:
    # LM Studio + vLLM + OpenRouter all speak the OpenAI-compatible
    # protocol. Route through cognee's CUSTOM provider (which dispatches
    # to GenericAPIAdapter) rather than `openai` (which goes through
    # OpenAIAdapter — that one HARDCODES the default instructor mode to
    # TOOLS for non-gpt-5 models, ignoring LLM_INSTRUCTOR_MODE entirely
    # and emitting `tool_choice: {type: object}` which LM Studio rejects).
    # GenericAPIAdapter respects LLM_INSTRUCTOR_MODE, so we can set
    # `json_schema_mode` which LM Studio (v0.3+ MLX) honors via
    # `response_format: {type: json_schema, ...}`.
    LLM_MODEL_LITELLM = _ensure_litellm_prefix(LLM_MODEL or "", "openai")
    EMBED_MODEL_LITELLM = _ensure_litellm_prefix(EMBED_MODEL or "", "openai")

    os.environ.setdefault("LLM_PROVIDER", "custom")
    os.environ.setdefault("LLM_ENDPOINT", LLM_BASE)
    if LLM_MODEL_LITELLM:
        os.environ.setdefault("LLM_MODEL", LLM_MODEL_LITELLM)
    os.environ.setdefault("LLM_API_KEY", LLM_KEY)

    # Embeddings: default to the same endpoint unless caller overrode.
    # LM Studio exposes /v1/embeddings — same OpenAI-compat shape, but
    # cognee's `openai` embedding adapter goes through litellm which
    # demands a tiktoken-mapped model name (nomic-embed-text-v1.5 has
    # no mapping → KeyError). Use cognee's `openai_compatible` adapter
    # instead — it routes through the OpenAICompatibleEmbeddingEngine
    # which uses the raw model name without tiktoken.
    embed_base = EMBED_BASE or LLM_BASE
    os.environ.setdefault("EMBEDDING_PROVIDER", EMBED_PROVIDER or "openai_compatible")
    if EMBED_MODEL:  # use raw (un-prefixed) name for openai_compatible
        os.environ.setdefault("EMBEDDING_MODEL", EMBED_MODEL)
    if embed_base:
        os.environ.setdefault("EMBEDDING_ENDPOINT", embed_base)
    os.environ.setdefault("EMBEDDING_API_KEY", EMBED_KEY)

# Cognee 1.0+ defaults — disable multi-tenant access control and the
# new session cache so add/search work without an authenticated user.
# Operator can flip these back on by setting the env vars in the plist.
os.environ.setdefault("ENABLE_BACKEND_ACCESS_CONTROL", "false")
os.environ.setdefault("CACHING", "false")
# Structured-output extraction mode. Cognee's default for the generic
# OpenAI-compatible adapter routes through `tool_call`, which emits
# `tool_choice: {type: "object", ...}`. LM Studio rejects that ("Invalid
# tool_choice type: 'object'. Supported: none, auto, required").
# `json_schema_mode` uses `response_format: {type: "json_schema", ...}`
# which LM Studio (v0.3+ MLX builds) DOES support — verified against
# gemma-4-26b-a4b-it-mlx on the operator's box.
os.environ.setdefault("LLM_INSTRUCTOR_MODE", "json_schema_mode")


# ── sqlite augmentation store ────────────────────────────────────────────
# Lightweight local index that mirrors every /remember call. Used to
# back the fallback mode AND to power total_memories on /health. The
# real cognee SDK also writes its own DB (sqlite + parquet), but that
# schema is internal/volatile; this gives us a stable count + lexical
# fallback when the cognify pipeline is offline (e.g. LM Studio down).
AUG_DB_PATH = str(Path(DATA_DIR) / "subctl_index.sqlite")
_aug_lock = threading.Lock()


def _aug_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(AUG_DB_PATH, timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _aug_init() -> None:
    with _aug_lock, _aug_connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                dataset TEXT,
                session_id TEXT,
                metadata TEXT,
                ts REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memories_dataset_idx ON memories(dataset);
            CREATE INDEX IF NOT EXISTS memories_session_idx ON memories(session_id);
            CREATE INDEX IF NOT EXISTS memories_ts_idx ON memories(ts);
            """
        )


def _aug_insert(
    mem_id: str,
    text: str,
    dataset: str,
    session_id: str | None,
    metadata: dict[str, Any] | None,
) -> None:
    with _aug_lock, _aug_connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO memories (id, text, dataset, session_id, metadata, ts) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                mem_id,
                text,
                dataset,
                session_id,
                json.dumps(metadata or {}),
                time.time(),
            ),
        )


def _aug_count() -> int:
    try:
        with _aug_connect() as conn:
            row = conn.execute("SELECT COUNT(*) FROM memories").fetchone()
            return int(row[0]) if row else 0
    except sqlite3.Error:
        return 0


def _aug_search(
    query: str, dataset: str | None, top_k: int
) -> list[dict[str, Any]]:
    # Lexical LIKE — good enough for the fallback / sanity check. The
    # real recall path goes through cognee.search().
    pattern = f"%{query}%"
    with _aug_connect() as conn:
        cur = conn.cursor()
        if dataset:
            cur.execute(
                "SELECT id, text, metadata, ts FROM memories "
                "WHERE text LIKE ? AND dataset = ? ORDER BY ts DESC LIMIT ?",
                (pattern, dataset, top_k),
            )
        else:
            cur.execute(
                "SELECT id, text, metadata, ts FROM memories "
                "WHERE text LIKE ? ORDER BY ts DESC LIMIT ?",
                (pattern, top_k),
            )
        rows = cur.fetchall()
    hits = []
    for r in rows:
        mem_id, text, metadata_raw, ts = r
        try:
            metadata = json.loads(metadata_raw or "{}")
        except json.JSONDecodeError:
            metadata = {}
        hits.append(
            {
                "id": mem_id,
                "text": text[:2000],
                "score": None,
                "ts": ts,
                "metadata": metadata,
            }
        )
    return hits


def _aug_forget(dataset: str | None, target_id: str | None) -> int:
    with _aug_lock, _aug_connect() as conn:
        cur = conn.cursor()
        if target_id:
            cur.execute("DELETE FROM memories WHERE id = ?", (target_id,))
        elif dataset:
            cur.execute("DELETE FROM memories WHERE dataset = ?", (dataset,))
        else:
            return 0
        return cur.rowcount


_aug_init()


# ── cognee bootstrap ─────────────────────────────────────────────────────
#
# Cognee 1.0+ is heavy (lance, litellm, transformers metadata, etc.) so
# the first import can take 5-30s. We do it EAGERLY at module load so
# the HTTP server only binds the port once the SDK is ready — that
# matches the master daemon's boot probe which polls /health.
#
# Resource-limit caveat: launchd defaults to 256 file descriptors per
# process, which is not enough for cognee's import (it opens many small
# files transitively). The plist sets SoftResourceLimits.NumberOfFiles
# = 16384 so this is a non-issue at runtime; if you ever see EMFILE or
# 30s+ imports, check that the plist still has the limit override.

COGNEE: Any = None
USING_REAL_SDK = False
SDK_IMPORT_ERROR: str | None = None

# ── tokenizer adapter — MUST run BEFORE `import cognee` ─────────────────
# Cognee 1.1 calls `tiktoken.encoding_for_model(<embedding-model-name>)`
# from its TikTokenTokenizer; tiktoken's registry only knows OpenAI ids,
# so `text-embedding-nomic-embed-text-v1.5` (and any other local model)
# raises KeyError. The adapter monkey-patches tiktoken (+ transformers)
# at import time so local embedding models map to their real HF tokenizer.
# See services/cognee/tokenizer_adapter.py for the full rationale.
try:
    # Import without going through `from services.cognee...` so the module
    # is locatable whether the sidecar runs from the repo or from a vendored
    # install copy. Both cases put server.py next to tokenizer_adapter.py.
    import importlib.util as _ilu
    from pathlib import Path as _P

    _ta_path = _P(__file__).resolve().parent / "tokenizer_adapter.py"
    _spec = _ilu.spec_from_file_location("subctl_cognee_tokenizer_adapter", _ta_path)
    if _spec is None or _spec.loader is None:
        raise ImportError(f"could not load tokenizer_adapter at {_ta_path}")
    tokenizer_adapter = _ilu.module_from_spec(_spec)
    _spec.loader.exec_module(tokenizer_adapter)

    _ta_result = tokenizer_adapter.install_patch()
    _registered = _ta_result.get("registered_models", [])
    LOG.info(
        "[tokenizer-adapter] registered %d local model(s): %s",
        len(_registered),
        ", ".join(_registered),
    )
    LOG.info(
        "[tokenizer-adapter] tiktoken patched=%s transformers patched=%s",
        _ta_result.get("tiktoken_patched"),
        _ta_result.get("transformers_patched"),
    )

    # Loud self-test: resolve_tokenizer + patched tiktoken.encoding_for_model.
    _probe_model = "text-embedding-nomic-embed-text-v1.5"
    try:
        _probe_adapter = tokenizer_adapter.resolve_tokenizer(_probe_model)
        _probe_count = tokenizer_adapter.verify_token_count(
            _probe_model, tokenizer_adapter.BENCHMARK_STRING
        )
        LOG.info(
            "[tokenizer-adapter] probe OK: model=%s name=%s n_vocab=%d "
            "benchmark_tokens=%d",
            _probe_model,
            _probe_adapter.name,
            _probe_adapter.n_vocab,
            _probe_count,
        )
    except Exception as _probe_err:  # noqa: BLE001
        LOG.error(
            "[tokenizer-adapter] resolve_tokenizer(%s) failed: %s — "
            "graph extraction will NOT use nomic's exact tokenizer",
            _probe_model,
            _probe_err,
        )

    # Confirm the tiktoken monkey-patch is wired by going through the
    # patched surface. If this raises, install_patch() didn't apply
    # cleanly and downstream cognify will fail.
    try:
        import tiktoken as _tt

        _tt_probe = _tt.encoding_for_model(_probe_model)
        LOG.info(
            "[tokenizer-adapter] tiktoken.encoding_for_model(%s) self-test "
            "OK — adapter type=%s",
            _probe_model,
            type(_tt_probe).__name__,
        )
    except Exception as _tt_err:  # noqa: BLE001
        LOG.error(
            "[tokenizer-adapter] tiktoken self-test FAILED for %s: %s",
            _probe_model,
            _tt_err,
        )
except Exception as _ta_outer:  # noqa: BLE001
    LOG.error(
        "[tokenizer-adapter] install failed: %s — falling back to cognee's "
        "default tiktoken behaviour; local embedding models will likely "
        "raise KeyError downstream",
        _ta_outer,
    )

try:
    _t0 = time.time()
    LOG.info("importing cognee SDK (this may take 5-30s on first launch)...")
    import cognee  # type: ignore[import-not-found]

    COGNEE = cognee
    USING_REAL_SDK = True
    LOG.info(
        "cognee SDK loaded in %.1fs — data_root=%s — llm_endpoint=%s — llm_model=%s",
        time.time() - _t0,
        DATA_DIR,
        os.environ.get("LLM_ENDPOINT") or "(default/openai)",
        os.environ.get("LLM_MODEL") or "(default)",
    )
except ModuleNotFoundError as e:
    SDK_IMPORT_ERROR = f"ModuleNotFoundError: {e}"
    LOG.warning(
        "cognee SDK not installed — staying in fallback mode. "
        "pip install cognee in %s to activate.",
        sys.prefix,
    )
except Exception as e:  # noqa: BLE001
    SDK_IMPORT_ERROR = f"{e.__class__.__name__}: {e}"
    LOG.warning(
        "cognee SDK import threw (%s) — staying in fallback mode: %s",
        e.__class__.__name__,
        e,
    )


# ── async runner ─────────────────────────────────────────────────────────
#
# Cognee's SDK is async-native. Each HTTP request needs its own event
# loop because BaseHTTPRequestHandler runs in a thread per request.


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ── operation implementations ────────────────────────────────────────────


SDK_REMEMBER_TIMEOUT = float(
    os.environ.get("SUBCTL_COGNEE_SDK_REMEMBER_TIMEOUT", "5.0")
)
SDK_RECALL_TIMEOUT = float(
    os.environ.get("SUBCTL_COGNEE_SDK_RECALL_TIMEOUT", "4.0")
)
# Cognify is the heavy LLM extraction pipeline — generous default
# (10 min) lets it grind through a few dozen docs end-to-end. Caller
# can override per-request via body.timeout_s.
SDK_COGNIFY_TIMEOUT = float(
    os.environ.get("SUBCTL_COGNEE_SDK_COGNIFY_TIMEOUT", "600.0")
)


def _op_remember(payload: dict[str, Any]) -> dict[str, Any]:
    text = (payload.get("text") or "").strip()
    if not text:
        raise ValueError("text is required")
    dataset = payload.get("dataset") or DEFAULT_DATASET
    metadata = payload.get("metadata") or {}
    session_id = payload.get("session_id")
    mem_id = f"cog_{uuid.uuid4().hex[:12]}"

    # ALWAYS write to the local sqlite index so total_memories is real
    # and lexical fallback works whether or not the SDK is up.
    _aug_insert(mem_id, text, dataset, session_id, metadata)

    if not USING_REAL_SDK:
        LOG.debug(
            "remember (fallback) — dataset=%s session=%s len=%d",
            dataset,
            session_id,
            len(text),
        )
        return {"id": mem_id}

    async def _do():
        # `cognee.add` ingests raw text into the configured dataset.
        # In cognee 1.0+ add() may trigger structured extraction which
        # calls the configured LLM. If the LLM is misconfigured or down,
        # we don't want to block the request — bound it with a timeout
        # and let the sqlite mirror carry the contract.
        try:
            await asyncio.wait_for(
                COGNEE.add(text, dataset_name=dataset),
                timeout=SDK_REMEMBER_TIMEOUT,
            )
        except asyncio.TimeoutError:
            LOG.warning(
                "cognee.add exceeded %.1fs (LLM likely slow/down) — kept sqlite mirror",
                SDK_REMEMBER_TIMEOUT,
            )
        except Exception as e:  # noqa: BLE001
            LOG.warning("cognee.add failed (kept sqlite mirror): %s", e)
        return mem_id

    return {"id": _run_async(_do())}


def _op_recall(payload: dict[str, Any]) -> dict[str, Any]:
    query = (payload.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    dataset = payload.get("dataset") or DEFAULT_DATASET
    top_k = max(1, min(int(payload.get("top_k") or 10), 100))

    # Always try the SDK first when present — it goes through embeddings
    # + graph traversal. Fall back to lexical sqlite if SDK errors,
    # times out, or returns nothing.
    if USING_REAL_SDK:
        async def _do():
            try:
                results = await asyncio.wait_for(
                    COGNEE.search(
                        query_text=query,
                        datasets=[dataset],
                    ),
                    timeout=SDK_RECALL_TIMEOUT,
                )
            except asyncio.TimeoutError:
                LOG.warning(
                    "cognee.search exceeded %.1fs — falling back to lexical",
                    SDK_RECALL_TIMEOUT,
                )
                return None
            except Exception as e:  # noqa: BLE001
                LOG.warning("cognee.search failed, falling back: %s", e)
                return None
            hits = []
            for i, r in enumerate(results[:top_k]):
                if isinstance(r, dict):
                    text = r.get("text") or r.get("content") or json.dumps(r)
                    score = r.get("score")
                    metadata = {
                        k: v for k, v in r.items()
                        if k not in ("text", "content", "score")
                    }
                    hit_id = r.get("id") or f"hit_{i}"
                else:
                    text = str(r)
                    score = None
                    metadata = {}
                    hit_id = f"hit_{i}"
                hits.append(
                    {
                        "id": hit_id,
                        "text": text[:2000],
                        "score": score,
                        "metadata": metadata,
                    }
                )
            return hits

        sdk_hits = _run_async(_do())
        if sdk_hits is not None and len(sdk_hits) > 0:
            return {"hits": sdk_hits, "source": "cognee-sdk"}

    # Fallback or empty SDK result → lexical sqlite search
    lex_hits = _aug_search(query, dataset, top_k)
    return {"hits": lex_hits, "source": "cognee-lex"}


def _op_forget(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = payload.get("dataset")
    target_id = payload.get("id")
    if not dataset and not target_id:
        return {"removed": 0}

    # Always remove from the sqlite mirror.
    removed = _aug_forget(dataset, target_id)

    if USING_REAL_SDK:
        async def _do():
            try:
                if target_id:
                    await COGNEE.delete(data_id=target_id)
                    return 1
                from cognee.api.v1.prune import prune  # type: ignore

                await prune.prune_data()
                return -1
            except Exception as e:  # noqa: BLE001
                LOG.warning("forget through SDK failed: %s", e)
                return 0

        _run_async(_do())

    return {"removed": removed}


async def _get_graph_engine():
    """Async helper — pulls cognee's configured graph engine instance.

    Cognee 1.0 ships a lightweight in-memory + lance-backed graph store.
    The engine exposes get_node, get_neighbors, has_node etc.
    """
    if not USING_REAL_SDK:
        return None
    try:
        from cognee.infrastructure.databases.graph import (  # type: ignore
            get_graph_engine,
        )
        return await get_graph_engine()
    except Exception as e:  # noqa: BLE001
        LOG.warning("get_graph_engine failed: %s", e)
        return None


def _serialize_node(node: Any) -> dict[str, Any]:
    """Best-effort: cognee's graph nodes are heterogeneous (dicts,
    Pydantic models, or plain tuples depending on backend). Normalize.
    """
    if node is None:
        return {"id": None, "label": None, "type": None, "properties": {}}
    if isinstance(node, dict):
        node_id = (
            node.get("id")
            or node.get("node_id")
            or node.get("name")
            or "?"
        )
        return {
            "id": str(node_id),
            "label": node.get("label") or node.get("name"),
            "type": node.get("type") or node.get("kind"),
            "properties": {
                k: v for k, v in node.items()
                if k not in ("id", "node_id", "label", "name", "type", "kind")
            },
        }
    if isinstance(node, (list, tuple)) and len(node) >= 1:
        return {"id": str(node[0]), "label": None, "type": None, "properties": {}}
    # Pydantic / class instance fallback — pull dict()
    try:
        d = node.dict() if hasattr(node, "dict") else node.__dict__
        return _serialize_node(d)
    except Exception:
        return {"id": str(node), "label": None, "type": None, "properties": {}}


def _serialize_edge(edge: Any) -> dict[str, Any]:
    if isinstance(edge, dict):
        return {
            "from": str(
                edge.get("from") or edge.get("source") or edge.get("from_node") or "?"
            ),
            "to": str(
                edge.get("to") or edge.get("target") or edge.get("to_node") or "?"
            ),
            "relation": edge.get("relation") or edge.get("type") or edge.get("label"),
            "properties": edge.get("properties") or {},
        }
    if isinstance(edge, (list, tuple)) and len(edge) >= 3:
        # Cognee often returns (source, target, relation) tuples
        return {
            "from": str(edge[0]),
            "to": str(edge[1]),
            "relation": str(edge[2]) if len(edge) > 2 else None,
            "properties": dict(edge[3]) if len(edge) > 3 and isinstance(edge[3], dict) else {},
        }
    return {"from": "?", "to": "?", "relation": None, "properties": {}}


async def _resolve_node_via_sql(label_or_id: str) -> dict[str, Any] | None:
    """Cognee's graph_db abstraction wraps multiple backends and the
    high-level get_node()/get_connections() API needs the right id form
    per backend. Bypass the abstraction and query the relational store
    (sqlite-backed `nodes` table) directly — this works regardless of
    whether kuzu/ladybug or postgres is the graph backend, because
    cognee always replicates the metadata layer there.

    Note on dual IDs: cognee stores two different IDs per node:
      - nodes.id          — the relational row key (e.g. 0ad773d9...)
      - attributes.id     — the entity's UUID (e.g. d9697252-e1f9-...)
    The `edges` table references attributes.id (un-hyphenated), NOT
    nodes.id. So we resolve to BOTH ids and use entity_id for traversal.
    """
    try:
        from cognee.infrastructure.databases.relational import (  # type: ignore
            get_relational_engine,
        )
        from sqlalchemy import text as sql_text

        rel = get_relational_engine()
        async with rel.get_async_session() as sess:
            # Try by id, label, or attributes.id (with/without dashes).
            normalized = label_or_id.replace("-", "")
            r = await sess.execute(
                sql_text(
                    """
                    SELECT id, label, type, attributes FROM nodes
                    WHERE id = :raw
                       OR label = :raw
                       OR REPLACE(json_extract(attributes, '$.id'), '-', '') = :normalized
                    LIMIT 1
                    """
                ),
                {"raw": label_or_id, "normalized": normalized},
            )
            row = r.fetchone()
            if not row:
                return None
            attrs_raw = row[3]
            attrs = {}
            try:
                attrs = json.loads(attrs_raw) if isinstance(attrs_raw, str) else (attrs_raw or {})
            except Exception:
                pass
            # Extract the entity_id (used in edges)
            entity_id = (attrs.get("id") or "").replace("-", "") or row[0]
            return {
                "id": row[0],
                "entity_id": entity_id,
                "label": row[1],
                "type": row[2],
                "attributes": attrs_raw,
            }
    except Exception as e:  # noqa: BLE001
        LOG.debug("_resolve_node_via_sql failed: %s", e)
        return None


async def _connections_via_sql(entity_id: str) -> list[dict[str, Any]]:
    """Read connections from the relational `edges` table.

    edges.source_node_id / .destination_node_id reference the
    entity_id form (attributes.id un-hyphenated), so callers must pass
    the entity_id (resolve via _resolve_node_via_sql first).
    Neighbors are looked up by matching attributes.id back to nodes.
    """
    try:
        from cognee.infrastructure.databases.relational import (  # type: ignore
            get_relational_engine,
        )
        from sqlalchemy import text as sql_text

        rel = get_relational_engine()
        async with rel.get_async_session() as sess:
            # Use a self-contained query that joins on the un-hyphenated
            # form of attributes.id to find the neighbor row.
            r = await sess.execute(
                sql_text(
                    """
                    SELECT e.source_node_id, e.destination_node_id, e.relationship_name, e.label
                    FROM edges e
                    WHERE e.source_node_id = :eid OR e.destination_node_id = :eid
                    LIMIT 200
                    """
                ),
                {"eid": entity_id},
            )
            edge_rows = r.fetchall()
            if not edge_rows:
                return []
            # Collect all neighbor entity_ids
            neighbor_eids: set[str] = set()
            for src, dst, _rel, _lbl in edge_rows:
                neighbor_eids.add(dst if src == entity_id else src)
            # Resolve neighbor metadata
            placeholders = ",".join([f":e{i}" for i in range(len(neighbor_eids))])
            params = {f"e{i}": eid for i, eid in enumerate(neighbor_eids)}
            n_rows = []
            if neighbor_eids:
                nr = await sess.execute(
                    sql_text(
                        f"""
                        SELECT id, label, type, attributes,
                               REPLACE(json_extract(attributes, '$.id'), '-', '') AS entity_id
                        FROM nodes
                        WHERE REPLACE(json_extract(attributes, '$.id'), '-', '') IN ({placeholders})
                        """
                    ),
                    params,
                )
                n_rows = nr.fetchall()
            eid_to_node = {row[4]: row for row in n_rows}
            out = []
            for src, dst, rel_name, edge_lbl in edge_rows:
                other_eid = dst if src == entity_id else src
                meta = eid_to_node.get(other_eid)
                target_label = meta[1] if meta else None
                target_type = meta[2] if meta else None
                target_attrs = meta[3] if meta else None
                out.append(
                    {
                        "source_node_id": src,
                        "destination_node_id": dst,
                        "relationship_name": rel_name,
                        "edge_label": edge_lbl,
                        "neighbor_id": other_eid,
                        "neighbor_label": target_label,
                        "neighbor_type": target_type,
                        "neighbor_attributes": target_attrs,
                    }
                )
            return out
    except Exception as e:  # noqa: BLE001
        LOG.warning("_connections_via_sql(%s) failed: %s", entity_id, e)
        return []


def _op_neighbors(payload: dict[str, Any]) -> dict[str, Any]:
    node_id = payload.get("node_id")
    if not node_id:
        raise ValueError("node_id is required")

    if not USING_REAL_SDK:
        return {
            "node": {"id": node_id, "label": None, "type": None, "properties": {}},
            "neighbors": [],
        }

    async def _do():
        # Resolve the node first (by id OR label).
        node = await _resolve_node_via_sql(node_id)
        if not node:
            return None
        connections = await _connections_via_sql(node["entity_id"])
        return {"node": node, "connections": connections}

    try:
        result = asyncio.run(_do())
    except Exception as e:  # noqa: BLE001
        LOG.warning("/graph/neighbors failed: %s", e)
        return {
            "node": {"id": node_id, "label": None, "type": None, "properties": {}},
            "neighbors": [],
            "error": str(e),
        }
    if not result:
        return {
            "node": {"id": node_id, "label": None, "type": None, "properties": {}},
            "neighbors": [],
        }

    node_dict = {
        "id": result["node"]["id"],
        "label": result["node"]["label"],
        "type": result["node"]["type"],
        "properties": {},
    }
    # Try to lift name/description out of attributes JSON
    try:
        if result["node"].get("attributes"):
            attrs = json.loads(result["node"]["attributes"]) if isinstance(result["node"]["attributes"], str) else result["node"]["attributes"]
            for k in ("name", "description"):
                if attrs.get(k):
                    node_dict["properties"][k] = attrs[k]
    except Exception:
        pass

    serialized_neighbors = []
    for c in result["connections"]:
        neighbor_node = {
            "id": c["neighbor_id"],
            "label": c["neighbor_label"],
            "type": c["neighbor_type"],
            "properties": {},
        }
        try:
            if c["neighbor_attributes"]:
                attrs = (
                    json.loads(c["neighbor_attributes"])
                    if isinstance(c["neighbor_attributes"], str)
                    else c["neighbor_attributes"]
                )
                for k in ("name", "description"):
                    if attrs.get(k):
                        neighbor_node["properties"][k] = attrs[k]
        except Exception:
            pass
        serialized_neighbors.append(
            {
                "node": neighbor_node,
                "edge": {
                    "from": c["source_node_id"],
                    "to": c["destination_node_id"],
                    "relation": c["relationship_name"] or c["edge_label"],
                    "properties": {},
                },
            }
        )
    return {
        "node": node_dict,
        "resolved_id": result["node"]["id"],
        "neighbors": serialized_neighbors,
    }


def _op_path(payload: dict[str, Any]) -> dict[str, Any]:
    src = payload.get("from") or payload.get("source")
    dst = payload.get("to") or payload.get("target")
    if not src or not dst:
        return {"nodes": [], "edges": []}
    max_hops = max(1, min(int(payload.get("max_hops") or 4), 10))

    if not USING_REAL_SDK:
        return {"nodes": [], "edges": []}

    async def _do():
        # Resolve both endpoints via the SQL store (handles label OR id).
        src_node = await _resolve_node_via_sql(src)
        dst_node = await _resolve_node_via_sql(dst)
        if not src_node or not dst_node:
            return {"nodes": [], "edges": [], "hop_count": 0, "src_resolved": bool(src_node), "dst_resolved": bool(dst_node)}

        src_eid = src_node["entity_id"]
        dst_eid = dst_node["entity_id"]

        # BFS over the relational edge table (entity_id-keyed).
        from collections import deque
        from cognee.infrastructure.databases.relational import (  # type: ignore
            get_relational_engine,
        )
        from sqlalchemy import text as sql_text

        rel = get_relational_engine()
        async with rel.get_async_session() as sess:
            visited = {src_eid}
            parents: dict[str, tuple[str, dict[str, Any]]] = {}
            q: deque[tuple[str, int]] = deque([(src_eid, 0)])
            found = False
            while q:
                cur, hops = q.popleft()
                if cur == dst_eid:
                    found = True
                    break
                if hops >= max_hops:
                    continue
                r = await sess.execute(
                    sql_text(
                        """
                        SELECT source_node_id, destination_node_id, relationship_name, label
                        FROM edges
                        WHERE source_node_id = :nid OR destination_node_id = :nid
                        """
                    ),
                    {"nid": cur},
                )
                for row in r.fetchall():
                    src_n, dst_n, rel_name, edge_lbl = row
                    other = dst_n if src_n == cur else src_n
                    if other in visited:
                        continue
                    visited.add(other)
                    parents[other] = (
                        cur,
                        {
                            "from": src_n,
                            "to": dst_n,
                            "relation": rel_name or edge_lbl,
                        },
                    )
                    q.append((other, hops + 1))
            if not found:
                return {
                    "nodes": [],
                    "edges": [],
                    "hop_count": 0,
                    "src_resolved": True,
                    "dst_resolved": True,
                }

            # Reconstruct path
            path_node_eids: list[str] = [dst_eid]
            path_edges: list[dict[str, Any]] = []
            cur = dst_eid
            while cur in parents:
                prev, edge = parents[cur]
                path_node_eids.append(prev)
                path_edges.append(edge)
                cur = prev
            path_node_eids.reverse()
            path_edges.reverse()

            # Resolve node metadata via entity_id
            placeholders = ",".join([f":e{i}" for i in range(len(path_node_eids))])
            params = {f"e{i}": eid for i, eid in enumerate(path_node_eids)}
            r = await sess.execute(
                sql_text(
                    f"""
                    SELECT id, label, type,
                           REPLACE(json_extract(attributes, '$.id'), '-', '') AS entity_id
                    FROM nodes
                    WHERE REPLACE(json_extract(attributes, '$.id'), '-', '') IN ({placeholders})
                    """
                ),
                params,
            )
            eid_to_node = {row[3]: {"id": row[0], "entity_id": row[3], "label": row[1], "type": row[2]} for row in r.fetchall()}
            ordered_nodes = [
                eid_to_node.get(eid, {"id": None, "entity_id": eid, "label": None, "type": None})
                for eid in path_node_eids
            ]
            return {
                "nodes": ordered_nodes,
                "edges": path_edges,
                "hop_count": len(path_edges),
                "src_resolved": True,
                "dst_resolved": True,
            }

    try:
        return asyncio.run(_do())
    except Exception as e:  # noqa: BLE001
        LOG.warning("/graph/path failed: %s", e)
        return {"nodes": [], "edges": [], "error": str(e)}


def _op_query(payload: dict[str, Any]) -> dict[str, Any]:
    return {"rows": []}


def _op_cognify(payload: dict[str, Any]) -> dict[str, Any]:
    """Run cognee.cognify() — extract entities + build the graph.

    This is the heavy LLM-driven pipeline; it walks every doc in the
    configured dataset(s) and runs structured-output extraction to mint
    nodes + edges. Expect minutes-per-dataset runtime.

    Body schema:
      { dataset?: string | string[], timeout_s?: number }

    Returns:
      { ok, dataset, duration_ms, node_count_before, node_count_after,
        edge_count_before, edge_count_after, error? }
    """
    if not USING_REAL_SDK:
        return {
            "ok": False,
            "error": "cognee SDK not loaded (using_real_sdk=false). Cognify requires the real SDK.",
            "duration_ms": 0,
            "node_count_before": 0,
            "node_count_after": 0,
        }

    dataset_arg = payload.get("dataset")
    if dataset_arg is None:
        datasets = [DEFAULT_DATASET]
    elif isinstance(dataset_arg, str):
        datasets = [dataset_arg]
    elif isinstance(dataset_arg, list):
        datasets = [str(d) for d in dataset_arg]
    else:
        raise ValueError("dataset must be a string or list of strings")

    timeout = float(payload.get("timeout_s") or SDK_COGNIFY_TIMEOUT)
    t0 = time.time()

    async def _snapshot_counts(engine: Any) -> tuple[int, int]:
        if engine is None:
            return 0, 0
        # Cognee's graph_db_interface doesn't expose get_node_count;
        # query the storage layer (sqlite-backed `data`/`nodes`/`edges`
        # tables) directly. This works for both ladybug and postgres
        # backends since cognee writes node + edge metadata to its
        # relational store regardless.
        n_count, e_count = 0, 0
        try:
            from cognee.infrastructure.databases.relational import (  # type: ignore
                get_relational_engine,
            )
            rel = get_relational_engine()
            async with rel.get_async_session() as sess:
                from sqlalchemy import text
                r1 = await sess.execute(text("SELECT COUNT(*) FROM nodes"))
                n_count = int(r1.scalar() or 0)
                r2 = await sess.execute(text("SELECT COUNT(*) FROM edges"))
                e_count = int(r2.scalar() or 0)
        except Exception as e:  # noqa: BLE001
            LOG.debug("snapshot counts via relational failed: %s", e)
        return n_count, e_count

    async def _do():
        engine = await _get_graph_engine()
        nb_before, eb_before = await _snapshot_counts(engine)

        # Run cognify (the big LLM pipeline). API varies between versions.
        cognify_fn = getattr(COGNEE, "cognify", None)
        if not callable(cognify_fn):
            return {
                "ok": False,
                "error": "cognee.cognify not callable on this SDK version",
                "node_count_before": nb_before,
                "edge_count_before": eb_before,
            }
        try:
            # Try cognify(datasets=[...]) first (v1 API), then positional.
            try:
                await asyncio.wait_for(
                    cognify_fn(datasets=datasets), timeout=timeout
                )
            except TypeError:
                await asyncio.wait_for(
                    cognify_fn(datasets), timeout=timeout
                )
            err = None
        except asyncio.TimeoutError:
            err = f"cognify exceeded {timeout:.0f}s timeout"
        except Exception as e:  # noqa: BLE001
            err = f"{e.__class__.__name__}: {e}"

        # Snapshot counts after (best-effort even on error — partial
        # progress is interesting)
        nb_after, eb_after = await _snapshot_counts(engine)

        return {
            "ok": err is None,
            "error": err,
            "node_count_before": int(nb_before or 0),
            "node_count_after": int(nb_after or 0),
            "edge_count_before": int(eb_before or 0),
            "edge_count_after": int(eb_after or 0),
        }

    try:
        result = _run_async(_do())
    except Exception as e:  # noqa: BLE001
        LOG.exception("cognify outer failed")
        return {
            "ok": False,
            "error": f"{e.__class__.__name__}: {e}",
            "duration_ms": int((time.time() - t0) * 1000),
            "dataset": datasets,
        }

    return {
        **result,
        "dataset": datasets,
        "duration_ms": int((time.time() - t0) * 1000),
    }


# ── HTTP handler ─────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "subctl-cognee/" + VERSION

    def log_message(self, fmt, *args):
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def _check_auth(self) -> bool:
        if not AUTH_TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        if header == f"Bearer {AUTH_TOKEN}":
            return True
        self._send_json(401, {"ok": False, "error": "unauthorized"})
        return False

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
            # Health is intentionally auth-free — the master's probe runs
            # before secrets are wired in some flows. Echo SDK state +
            # LLM provider so the dashboard can render the truth.
            self._send_json(
                200,
                {
                    "ok": True,
                    "status": "ok",
                    "version": VERSION,
                    "using_real_sdk": USING_REAL_SDK,
                    "sdk_import_error": SDK_IMPORT_ERROR,
                    "augmentation": "on" if USING_REAL_SDK else "off",
                    "embeddings_provider": (
                        os.environ.get("EMBEDDING_PROVIDER")
                        or ("custom" if LLM_BASE else "default")
                    ),
                    "llm_provider": os.environ.get("LLM_PROVIDER") or "default",
                    "llm_base": LLM_BASE,
                    "llm_model": LLM_MODEL,
                    "data_root": DATA_DIR,
                    "default_dataset": DEFAULT_DATASET,
                    "total_memories": _aug_count(),
                    "auth_required": bool(AUTH_TOKEN),
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._check_auth():
            return
        payload = self._read_json()
        try:
            if self.path == "/remember":
                self._send_json(200, _op_remember(payload))
                return
            if self.path == "/recall":
                self._send_json(200, _op_recall(payload))
                return
            if self.path == "/forget":
                self._send_json(200, _op_forget(payload))
                return
            if self.path == "/graph/neighbors":
                self._send_json(200, _op_neighbors(payload))
                return
            if self.path == "/graph/path":
                self._send_json(200, _op_path(payload))
                return
            if self.path == "/graph/query":
                self._send_json(200, _op_query(payload))
                return
            if self.path == "/cognify":
                self._send_json(200, _op_cognify(payload))
                return
        except ValueError as e:
            self._send_json(400, {"ok": False, "error": str(e)})
            return
        except Exception as e:  # noqa: BLE001
            LOG.exception("%s failed", self.path)
            self._send_json(500, {"ok": False, "error": str(e)})
            return
        self._send_json(404, {"ok": False, "error": "not found"})


def main():
    LOG.info(
        "subctl-cognee starting on %s:%s — data=%s — sdk=%s — llm=%s — model=%s",
        HOST,
        PORT,
        DATA_DIR,
        USING_REAL_SDK,
        LLM_BASE or "(default)",
        LLM_MODEL or "(default)",
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
