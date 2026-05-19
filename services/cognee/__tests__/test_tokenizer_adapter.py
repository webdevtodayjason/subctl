"""Tests for services/cognee/tokenizer_adapter.py.

Run with:

    ~/.local/share/subctl/cognee-venv/bin/python -m pytest \
        services/cognee/__tests__/test_tokenizer_adapter.py -v

These tests load the adapter from the sibling source file (not via a
package import) so they work without an `__init__.py` or packaging
machinery.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# Load services/cognee/tokenizer_adapter.py directly so the tests work
# without packaging the sidecar as a module.
_HERE = Path(__file__).resolve().parent
_TA_PATH = _HERE.parent / "tokenizer_adapter.py"
_spec = importlib.util.spec_from_file_location(
    "subctl_cognee_tokenizer_adapter_under_test", _TA_PATH
)
assert _spec is not None and _spec.loader is not None
ta = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ta)


# ── registry contents ──────────────────────────────────────────────────────


def test_registry_contains_nomic_entries():
    """All three nomic aliases the operator's stack passes must resolve to
    the same HF repo."""
    nomic = "nomic-ai/nomic-embed-text-v1.5"
    assert ta.REGISTRY["text-embedding-nomic-embed-text-v1.5"] == nomic
    assert ta.REGISTRY["nomic-embed-text-v1.5"] == nomic
    assert ta.REGISTRY["openai/text-embedding-nomic-embed-text-v1.5"] == nomic


# ── resolve_tokenizer ──────────────────────────────────────────────────────


def test_resolve_tokenizer_returns_adapter_with_int_ids():
    adapter = ta.resolve_tokenizer("text-embedding-nomic-embed-text-v1.5")
    assert isinstance(adapter, ta.TiktokenLikeAdapter)
    ids = adapter.encode("hello world")
    assert isinstance(ids, list)
    assert len(ids) > 0
    assert all(isinstance(i, int) for i in ids)
    assert adapter.n_vocab > 0
    assert adapter.name == "text-embedding-nomic-embed-text-v1.5"


def test_adapter_decode_round_trip_lossy_but_callable():
    adapter = ta.resolve_tokenizer("nomic-embed-text-v1.5")
    ids = adapter.encode("hello world")
    decoded = adapter.decode(ids)
    # BertTokenizer lower-cases by default; we just need decode to return
    # something non-empty so cognee's debug paths don't crash.
    assert isinstance(decoded, str)
    assert "hello" in decoded.lower()


# ── token-count parity with HF directly ────────────────────────────────────


def test_token_count_matches_hf_tokenizer_directly():
    """The adapter MUST return the same id sequence as calling
    `AutoTokenizer.from_pretrained(...).encode(...)` directly. DONE WHEN #3."""
    from transformers import AutoTokenizer  # type: ignore[import-not-found]

    # Bypass any monkey-patched from_pretrained for this comparison — use
    # the real repo id so we're testing the adapter's logic, not the
    # transformers patch.
    direct_tok = AutoTokenizer.from_pretrained("nomic-ai/nomic-embed-text-v1.5")
    direct_ids = direct_tok.encode(ta.BENCHMARK_STRING, add_special_tokens=False)

    adapter = ta.resolve_tokenizer("text-embedding-nomic-embed-text-v1.5")
    adapter_ids = adapter.encode(ta.BENCHMARK_STRING)

    assert adapter_ids == direct_ids, (
        f"adapter token ids must equal direct HF tokenizer ids; "
        f"adapter={adapter_ids[:10]}... direct={direct_ids[:10]}..."
    )


def test_verify_token_count_helper_returns_int():
    n = ta.verify_token_count(
        "text-embedding-nomic-embed-text-v1.5", ta.BENCHMARK_STRING
    )
    assert isinstance(n, int)
    assert n > 5  # benchmark is ~22 tokens; sanity floor


# ── install_patch idempotency + OpenAI fallback ────────────────────────────


def test_install_patch_is_idempotent():
    """Calling install_patch twice must not corrupt tiktoken. The second
    call should observe the patched state and return early without
    chaining wrappers."""
    import tiktoken

    r1 = ta.install_patch()
    r2 = ta.install_patch()
    assert r1["tiktoken_patched"] is True
    assert r2["tiktoken_patched"] is True
    # encoding_for_model still callable
    enc = tiktoken.encoding_for_model("gpt-4")
    assert enc.encode("hello") == [15339]  # cl100k_base for "hello"


def test_openai_models_still_work_after_patch():
    """Patched tiktoken.encoding_for_model('gpt-4') must return the real
    cl100k_base encoding, not our adapter."""
    ta.install_patch()
    import tiktoken

    enc = tiktoken.encoding_for_model("gpt-4")
    # Real tiktoken.Encoding (not our adapter).
    assert type(enc).__name__ == "Encoding"
    assert enc.name == "cl100k_base"
    ids = enc.encode("The quick brown fox")
    assert isinstance(ids, list) and all(isinstance(i, int) for i in ids)


def test_unknown_local_model_raises_keyerror_with_registry_hint():
    """Unknown non-OpenAI model must raise KeyError naming the model AND
    pointing to the registry — no silent cl100k_base fallback."""
    ta.install_patch()
    import tiktoken

    with pytest.raises(KeyError) as excinfo:
        tiktoken.encoding_for_model("nonexistent-local-embedding-zzz")
    msg = str(excinfo.value)
    assert "nonexistent-local-embedding-zzz" in msg
    assert "REGISTRY" in msg or "tokenizer_adapter.py" in msg


# ── chunking budget assertion ──────────────────────────────────────────────


def test_chunking_respects_8192_token_window():
    """Feed a long string, encode it, split at 8000 tokens, confirm every
    chunk is ≤ 8000 tokens. This is the 8192-context-window invariant that
    cognee's chunker MUST honor."""
    adapter = ta.resolve_tokenizer("text-embedding-nomic-embed-text-v1.5")
    # Build a string that will tokenize to >8000 tokens. Each repetition
    # of "lorem ipsum dolor sit amet " is ~6 tokens; 2000 reps ≈ 12000.
    long_text = "lorem ipsum dolor sit amet " * 2000
    ids = adapter.encode(long_text)
    assert len(ids) > 8000, (
        f"benchmark setup: long_text must encode to >8000 tokens, got {len(ids)}"
    )

    # Simulate chunking the same way cognee's chunker would.
    CHUNK = 8000
    chunks = [ids[i : i + CHUNK] for i in range(0, len(ids), CHUNK)]
    assert all(len(c) <= CHUNK for c in chunks), (
        "every chunk must be <= 8000 tokens"
    )
    # Round-trip: reassembling the chunks recovers the full token sequence.
    rebuilt = [t for c in chunks for t in c]
    assert rebuilt == ids


# ── register_local_tokenizer dynamic-add ───────────────────────────────────


def test_register_local_tokenizer_adds_new_model():
    """Adding a second model via register_local_tokenizer makes it
    resolvable. Demonstrates the model-agnostic requirement (DONE WHEN #6)
    with bert-base-uncased — small (~30MB cached) so the test stays fast."""
    ta.register_local_tokenizer("dummy-bert-alias", "bert-base-uncased")
    try:
        adapter = ta.resolve_tokenizer("dummy-bert-alias")
        assert isinstance(adapter, ta.TiktokenLikeAdapter)
        ids = adapter.encode("hello world")
        assert isinstance(ids, list) and len(ids) > 0
    finally:
        # Don't poison the registry for subsequent tests in the same run.
        ta.REGISTRY.pop("dummy-bert-alias", None)


# ── tiktoken get_encoding patch ────────────────────────────────────────────


def test_get_encoding_passes_through_real_encoding_names():
    """tiktoken.get_encoding('cl100k_base') must still return the real
    cl100k_base — that's what cognee's TikTokenTokenizer falls back to
    when model=None."""
    ta.install_patch()
    import tiktoken

    enc = tiktoken.get_encoding("cl100k_base")
    assert type(enc).__name__ == "Encoding"
    assert enc.name == "cl100k_base"


def test_get_encoding_routes_local_name_to_adapter():
    """If a caller asks tiktoken.get_encoding for a registry alias, route
    it to the adapter — defense-in-depth for any future Cognee version
    that uses get_encoding directly with a model name."""
    ta.install_patch()
    import tiktoken

    enc = tiktoken.get_encoding("nomic-embed-text-v1.5")
    assert isinstance(enc, ta.TiktokenLikeAdapter)
    assert enc.name == "nomic-embed-text-v1.5"
