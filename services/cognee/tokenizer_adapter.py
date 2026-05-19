"""Cognee sidecar tokenizer adapter — Cognee 1.1 + local embedding models.

WHY THIS EXISTS
===============
Cognee 1.1.0 calls `tiktoken.encoding_for_model(model_name)` whenever a
TikTokenTokenizer is instantiated with a non-empty model name (see
`cognee/infrastructure/llm/tokenizer/TikToken/adapter.py`). tiktoken's
model registry only knows OpenAI model ids — so `text-embedding-nomic-embed-text-v1.5`
raises:

    KeyError: 'Could not automatically map text-embedding-nomic-embed-text-v1.5
              to a tokeniser. Please use tiktoken.get_encoding to explicitly
              get the tokeniser you expect.'

Cognee's fallback (TikTokenTokenizer with model=None → cl100k_base) "works"
but the token counts are wrong for nomic. That breaks the 8192-token chunk
budget assumption: cl100k_base estimates *fewer* tokens than nomic's
BertTokenizer, so chunks that look safe to cl100k_base can blow past nomic's
context window at embed time.

WHAT THIS MODULE DOES
=====================
At sidecar boot — BEFORE `import cognee` — `install_patch()` monkey-patches
two surfaces:

1. `tiktoken.encoding_for_model` + `tiktoken.get_encoding`
   On registry hit → return `TiktokenLikeAdapter` wrapping the real HF
   tokenizer for the model. On registry miss → call the original tiktoken
   function (preserves OpenAI fallback). On non-OpenAI miss → loud KeyError
   pointing to this file.

2. `transformers.AutoTokenizer.from_pretrained` (if `transformers` is
   importable)
   When called with a registered OpenAI-style alias (e.g.
   `"text-embedding-nomic-embed-text-v1.5"`), rewrites the model id to
   the real HF repo (`"nomic-ai/nomic-embed-text-v1.5"`) before delegating
   to the original. This fixes Cognee's `OpenAICompatibleEmbeddingEngine`
   path where `HuggingFaceTokenizer(model=self.model)` is otherwise an
   OSError → silent fallback to cl100k_base.

Both patches share the same `REGISTRY` dict, so adding a new local model
is a one-liner.

HOW TO ADD A NEW LOCAL EMBEDDING MODEL
======================================
Add an entry to `REGISTRY` below, or — at runtime — call
`tokenizer_adapter.register_local_tokenizer(<alias>, <hf_repo>)` before
`install_patch()` runs. Example:

    register_local_tokenizer(
        "text-embedding-bge-m3",
        "BAAI/bge-m3",
    )

Then any code that asks tiktoken or transformers for `text-embedding-bge-m3`
gets routed to BAAI/bge-m3's real tokenizer.

FAILURE MODE
============
If Cognee asks for a model name we don't recognize AND tiktoken doesn't
know it either, we raise `KeyError` with a message that NAMES the offending
model and points back to this file's `REGISTRY` dict. No silent fallback,
no cl100k_base mystery counts.

WHERE THE PATCH IS INSTALLED
============================
`services/cognee/server.py`, top of imports — see the call to
`tokenizer_adapter.install_patch()` BEFORE `import cognee`.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

LOG = logging.getLogger("subctl-cognee.tokenizer-adapter")

# ── registry ────────────────────────────────────────────────────────────────
# Map model aliases that the LLM/embedding stack uses → real HF repo id.
# Aliases are matched case-sensitive. Include every variant the upstream
# stack might pass through (raw, prefixed, with/without provider).
REGISTRY: dict[str, str] = {
    # Nomic Embed Text v1.5 — primary local embedding model on the box.
    "text-embedding-nomic-embed-text-v1.5": "nomic-ai/nomic-embed-text-v1.5",
    "nomic-embed-text-v1.5": "nomic-ai/nomic-embed-text-v1.5",
    # litellm prefixes custom models with `openai/` — handle both forms.
    "openai/text-embedding-nomic-embed-text-v1.5": "nomic-ai/nomic-embed-text-v1.5",
    "openai/nomic-embed-text-v1.5": "nomic-ai/nomic-embed-text-v1.5",
}

# Self-test benchmark string — pinned, used by `verify_token_count` and
# by the test suite for HF-parity assertions.
BENCHMARK_STRING = (
    "The operator switched the reviewer to oMLX on 2026-05-18 "
    "for thermal preservation."
)

# Sentinel attribute on tiktoken module — flips to True after a successful
# install_patch() so re-calls are no-ops.
_PATCH_ATTR = "_subctl_tokenizer_adapter_patched"

# Cache HF tokenizers so repeat lookups don't re-load from disk/HF hub.
_HF_TOKENIZER_CACHE: dict[str, Any] = {}


def register_local_tokenizer(model_name: str, hf_repo: str) -> None:
    """Add (or overwrite) a model alias → HF repo entry in the registry.

    Idempotent. Subsequent `resolve_tokenizer(model_name)` calls return an
    adapter backed by `hf_repo`. Both tiktoken and transformers patches
    consult this same dict at call time, so registering a new alias takes
    effect immediately even after install_patch() ran.
    """
    if not model_name or not hf_repo:
        raise ValueError("model_name and hf_repo are both required")
    REGISTRY[model_name] = hf_repo
    # Invalidate any cached adapter for this alias so the next lookup
    # rebuilds against the new repo.
    _HF_TOKENIZER_CACHE.pop(model_name, None)


def registered_models() -> list[str]:
    """Sorted list of all registered model aliases — used at boot for the
    `[tokenizer-adapter] registered N local model(s): ...` log line."""
    return sorted(REGISTRY.keys())


def _load_hf_tokenizer(hf_repo: str) -> Any:
    """Load (or fetch from cache) a HuggingFace tokenizer for ``hf_repo``.

    Uses `transformers.AutoTokenizer.from_pretrained`. The first call
    triggers a download to `~/.cache/huggingface/` (~150MB for nomic);
    subsequent calls are fast.
    """
    if hf_repo in _HF_TOKENIZER_CACHE:
        return _HF_TOKENIZER_CACHE[hf_repo]
    try:
        from transformers import AutoTokenizer  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "transformers is required for tokenizer_adapter but is not "
            "installed. Run: "
            "`~/.local/share/subctl/cognee-venv/bin/pip install transformers`"
        ) from e

    # use_fast=True is preferred when available (Rust-backed) but nomic's
    # tokenizer config sometimes only ships a slow BertTokenizer; let HF
    # decide which one to load.
    tok = AutoTokenizer.from_pretrained(hf_repo)
    _HF_TOKENIZER_CACHE[hf_repo] = tok
    return tok


class TiktokenLikeAdapter:
    """tiktoken.Encoding-compatible facade over a HuggingFace tokenizer.

    Exposes the slice of the tiktoken.Encoding API that Cognee 1.1
    actually calls:

    - ``encode(text, *, allowed_special=set(), disallowed_special='all') -> list[int]``
    - ``decode(tokens) -> str``
    - ``decode_single_token_bytes(token) -> bytes`` (Cognee's
      ``decode_single_token`` calls this)
    - ``n_vocab`` (property — Cognee may inspect for size checks)
    - ``name`` (str — Cognee logs use this)

    Other tiktoken methods are deliberately *not* implemented; if Cognee
    grows a new dependency on one in a future version, the AttributeError
    will be loud and we add it explicitly here rather than silently
    returning approximate values.
    """

    __slots__ = ("_hf", "_name", "_hf_repo")

    def __init__(self, hf_tokenizer: Any, model_name: str, hf_repo: str) -> None:
        self._hf = hf_tokenizer
        self._name = model_name
        self._hf_repo = hf_repo

    # — tiktoken-Encoding API surface —————————————————————————————————

    def encode(
        self,
        text: str,
        *,
        allowed_special: Any = None,
        disallowed_special: Any = None,
    ) -> list[int]:
        """Return token ids for ``text``.

        ``allowed_special`` / ``disallowed_special`` are accepted but
        ignored — HF tokenizers handle specials via their own config
        (`add_special_tokens=True` by default), not via call-site filters.
        Accepting them keeps the call signature wire-compatible with
        callers that pass tiktoken's kwargs.
        """
        # `add_special_tokens=False` matches what tiktoken returns: the
        # raw BPE/WordPiece ids without [CLS]/[SEP] wrappers. Cognee uses
        # the count for chunk-size budgeting, so excluding specials gives
        # a count that matches "tokens spent on actual content."
        return list(self._hf.encode(text, add_special_tokens=False))

    def decode(self, tokens: list[int] | int) -> str:
        if isinstance(tokens, int):
            tokens = [tokens]
        return self._hf.decode(tokens, skip_special_tokens=True)

    def decode_single_token_bytes(self, token: int) -> bytes:
        """Return the byte sequence for a single token id.

        tiktoken returns raw BPE bytes (e.g. b' hello'); HF doesn't expose
        bytes directly so we decode to str + utf-8 encode. Good enough for
        cognee's `decode_single_token`, which utf-8-decodes the result.
        """
        return self._hf.decode([token], skip_special_tokens=True).encode("utf-8")

    @property
    def n_vocab(self) -> int:
        # HF: vocab_size; tiktoken: n_vocab. Identical semantics.
        return int(getattr(self._hf, "vocab_size", 0))

    @property
    def name(self) -> str:
        return self._name

    @property
    def hf_repo(self) -> str:
        return self._hf_repo

    def __repr__(self) -> str:  # pragma: no cover — debug only
        return f"TiktokenLikeAdapter(name={self._name!r}, hf_repo={self._hf_repo!r})"


def resolve_tokenizer(model_name: str) -> TiktokenLikeAdapter:
    """Look up ``model_name`` in REGISTRY and return a wrapped HF tokenizer.

    Raises ``KeyError`` with a registry-pointing message if the alias
    isn't registered.
    """
    hf_repo = REGISTRY.get(model_name)
    if not hf_repo:
        raise KeyError(_unknown_model_message(model_name))
    hf = _load_hf_tokenizer(hf_repo)
    return TiktokenLikeAdapter(hf, model_name, hf_repo)


def verify_token_count(model_name: str, text: str) -> int:
    """Return the token count for ``text`` under ``model_name``'s tokenizer.

    Used in the boot probe to sanity-check the patch and in the test suite
    to assert parity with `AutoTokenizer.from_pretrained(...).encode(...)`.
    """
    adapter = resolve_tokenizer(model_name)
    return len(adapter.encode(text))


def _unknown_model_message(model_name: str) -> str:
    return (
        f"local embedding model '{model_name}' is not in the cognee-sidecar "
        "tokenizer registry. Add an entry in services/cognee/tokenizer_adapter.py "
        "(REGISTRY dict) mapping it to its HuggingFace tokenizer repo."
    )


# ── monkey-patch installers ────────────────────────────────────────────────


def _looks_like_openai_model(name: str) -> bool:
    """Heuristic: should tiktoken's original miss be treated as 'unknown
    local model' (loud error) or 'genuinely unknown OpenAI model' (let
    tiktoken's own KeyError bubble up)?

    OpenAI ids historically start with: gpt-, text-davinci-, text-curie-,
    text-babbage-, text-ada-, code-, text-embedding-ada-, text-embedding-3-,
    o1-, o3-, davinci, curie, babbage, ada. Tiktoken encoding names
    (cl100k_base, p50k_base, p50k_edit, r50k_base, o200k_base, gpt2) also
    pass through.
    """
    n = name.lower()
    openai_prefixes = (
        "gpt-",
        "gpt2",
        "gpt-3",
        "gpt-4",
        "o1-",
        "o3-",
        "o4-",
        "text-davinci",
        "text-curie",
        "text-babbage",
        "text-ada",
        "code-",
        "text-embedding-ada",
        "text-embedding-3",
        "text-embedding-small",
        "text-embedding-large",
    )
    if n in {"davinci", "curie", "babbage", "ada"}:
        return True
    if n in {"cl100k_base", "p50k_base", "p50k_edit", "r50k_base", "o200k_base"}:
        return True
    return n.startswith(openai_prefixes)


def _make_patched_encoding_for_model(original: Callable[..., Any]) -> Callable[..., Any]:
    def patched_encoding_for_model(model_name: str, *args: Any, **kwargs: Any) -> Any:
        # Registry hit — return our HF-backed adapter.
        if model_name in REGISTRY:
            return resolve_tokenizer(model_name)
        # Registry miss — defer to original. If it's a real OpenAI model
        # name tiktoken will handle it. If it raises KeyError AND it
        # *doesn't* look like an OpenAI model, re-raise with the
        # registry-pointing message.
        try:
            return original(model_name, *args, **kwargs)
        except KeyError:
            if _looks_like_openai_model(model_name):
                raise
            raise KeyError(_unknown_model_message(model_name)) from None

    patched_encoding_for_model.__wrapped__ = original  # type: ignore[attr-defined]
    return patched_encoding_for_model


def _make_patched_get_encoding(original: Callable[..., Any]) -> Callable[..., Any]:
    def patched_get_encoding(encoding_name: str, *args: Any, **kwargs: Any) -> Any:
        # Registry hit — same behaviour as encoding_for_model. Cognee's
        # TikTokenTokenizer falls back to get_encoding('cl100k_base')
        # when model=None, which must still work.
        if encoding_name in REGISTRY:
            return resolve_tokenizer(encoding_name)
        try:
            return original(encoding_name, *args, **kwargs)
        except (KeyError, ValueError):
            if _looks_like_openai_model(encoding_name):
                raise
            raise KeyError(_unknown_model_message(encoding_name)) from None

    patched_get_encoding.__wrapped__ = original  # type: ignore[attr-defined]
    return patched_get_encoding


def _make_patched_from_pretrained(original: Any) -> Any:
    # `AutoTokenizer.from_pretrained` is a classmethod-style bound to the
    # AutoTokenizer class. We wrap the bound-or-unbound callable directly;
    # the spec calls it as `AutoTokenizer.from_pretrained(model)` so we
    # don't need to re-bind.
    def patched_from_pretrained(
        pretrained_model_name_or_path: Any, *args: Any, **kwargs: Any
    ) -> Any:
        # Only rewrite if the caller passed a string alias we know about.
        # Anything else (a real HF repo id, a local path, a dict) goes
        # straight through.
        if (
            isinstance(pretrained_model_name_or_path, str)
            and pretrained_model_name_or_path in REGISTRY
        ):
            redirected = REGISTRY[pretrained_model_name_or_path]
            LOG.debug(
                "AutoTokenizer.from_pretrained: redirect %r → %r",
                pretrained_model_name_or_path,
                redirected,
            )
            return original(redirected, *args, **kwargs)
        return original(pretrained_model_name_or_path, *args, **kwargs)

    patched_from_pretrained.__wrapped__ = original  # type: ignore[attr-defined]
    return patched_from_pretrained


def install_patch() -> dict[str, Any]:
    """Install the tiktoken + transformers monkey-patches.

    Idempotent — repeat calls are no-ops. Returns a dict describing what
    was patched, useful for boot-time logging and test assertions.
    """
    import tiktoken

    result: dict[str, Any] = {
        "tiktoken_patched": False,
        "transformers_patched": False,
        "registered_models": registered_models(),
    }

    if getattr(tiktoken, _PATCH_ATTR, False):
        # Already patched — return what we know without re-wrapping (which
        # would chain wrappers).
        result["tiktoken_patched"] = True
        result["transformers_patched"] = bool(
            getattr(tiktoken, _PATCH_ATTR + "_hf", False)
        )
        return result

    # 1. tiktoken.encoding_for_model + tiktoken.get_encoding
    original_efm = tiktoken.encoding_for_model
    original_ge = tiktoken.get_encoding
    tiktoken.encoding_for_model = _make_patched_encoding_for_model(original_efm)  # type: ignore[assignment]
    tiktoken.get_encoding = _make_patched_get_encoding(original_ge)  # type: ignore[assignment]
    setattr(tiktoken, _PATCH_ATTR, True)
    result["tiktoken_patched"] = True

    # 2. transformers.AutoTokenizer.from_pretrained (optional — only if
    #    transformers is importable; the sidecar requires it but tests
    #    may run without).
    try:
        from transformers import AutoTokenizer  # type: ignore[import-not-found]

        original_fp = AutoTokenizer.from_pretrained
        AutoTokenizer.from_pretrained = _make_patched_from_pretrained(  # type: ignore[assignment]
            original_fp
        )
        setattr(tiktoken, _PATCH_ATTR + "_hf", True)
        result["transformers_patched"] = True
    except ImportError:
        LOG.warning(
            "transformers not importable — skipping AutoTokenizer.from_pretrained "
            "patch (the tiktoken patch is still active)"
        )

    return result
