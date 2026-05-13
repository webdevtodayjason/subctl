---
name: python-conventions
description: >-
  Python house style for subctl-adjacent work — tooling (uv, ruff, pytest),
  imports, types, errors, async patterns, packaging.

  Load this skill whenever a worker is touching `.py` files in a
  subctl-managed project. Most subctl projects are Bun-first, but supporting
  utilities, ML code, and external integrations may be Python. These are the
  defaults to apply when the project's local CLAUDE.md doesn't override.
scope: dev-team
loaded_by_default: []
created_at: "2026-05-10"
created_by: operator
---

# Python Conventions

Default ecosystem skill for Python-flavored work. Subctl itself is Bun, but
many adjacent projects (claude-mem worker, ML utilities, infrastructure
scripts) are Python. Use these defaults when you're not given project-specific
guidance.

---

## 1. Tooling — `uv`, `ruff`, `pytest`

### Project manager: uv

[uv](https://github.com/astral-sh/uv) is the operator's preferred Python
package manager. New projects use it; existing projects on `poetry` or plain
`pip` stay where they are unless the migration is explicit scope.

```bash
uv init                       # new project, generates pyproject.toml
uv add httpx                  # add a dep
uv add --dev pytest ruff      # dev dep
uv run python -m foo          # run with project venv
uv sync                       # install from uv.lock
```

Lockfile: `uv.lock`. Commit it.

### Linter / formatter: ruff

Single tool for both lint and format. Configured in `pyproject.toml`:

```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "RET"]
ignore = ["E501"]  # handled by formatter
```

Run before every commit:

```bash
uv run ruff check --fix .
uv run ruff format .
```

No `black`, no `isort`, no `flake8` — ruff supersedes all three. If a
project still has those, leave them; don't migrate as a side effect.

### Test runner: pytest

```bash
uv run pytest                 # full suite
uv run pytest -x              # stop on first failure
uv run pytest tests/foo.py::test_bar  # one test
```

Pytest config in `pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"
```

---

## 2. Python version

Target Python 3.12+ unless the project's runtime forces older. New `pyproject.toml`:

```toml
[project]
requires-python = ">=3.12"
```

3.12 features used by default: `type` statement, `pep 695` generics, `Self`
in type hints, structural pattern matching where it improves clarity.

---

## 3. Types — typed by default

All new code is fully type-hinted. mypy or pyright runs in strict mode.

```python
# yes
def resolve_secret(key: str, default: str | None = None) -> str:
    ...

# no
def resolve_secret(key, default=None):
    ...
```

- Use `X | None` over `Optional[X]` (3.10+ syntax)
- Use `list[str]`, `dict[str, int]`, `tuple[int, ...]` — never the
  `typing.List` capitalized variants
- `TypeAlias` deprecated in 3.12+; use the `type` statement:
  `type SecretKey = str`
- `dataclasses` for value objects; `pydantic` only when the project already
  uses it (for validation at boundaries)

---

## 4. Imports

PEP 8 grouping, enforced by ruff's I-rules:

```python
# standard library
import json
import os
from pathlib import Path

# third-party
import httpx
import pytest

# local
from myproject.config import load_policy
from myproject.errors import ResolutionError
```

- Absolute imports for project code; relative imports only inside a
  package's own internals
- One import per line for clarity (ruff allows multi-import; the operator
  prefers single)
- No `from foo import *` ever

---

## 5. Naming

| Kind | Convention | Example |
|------|------------|---------|
| Module / file | `snake_case` | `secret_backends.py` |
| Function / variable | `snake_case` | `resolve_secret` |
| Class | `PascalCase` | `SecretBackend` |
| Constant | `SCREAMING_SNAKE` | `DEFAULT_CHAIN` |
| Type alias | `PascalCase` | `type SecretKey = str` |
| Test file | `test_<module>.py` | `test_secret_backends.py` |
| Private | `_leading_underscore` | `_internal_helper` |

---

## 6. Errors

### Define module-level exceptions

```python
class ResolutionError(Exception):
    """Raised when no backend can resolve a key."""

class BackendUnavailable(ResolutionError):
    """Raised when a specific backend is misconfigured or offline."""
```

Inherit from a project-specific base class so callers can catch coarsely.
Never raise raw `Exception` from library code.

### Errors are exceptions, except at process boundaries

Inside a module: raise. At the boundary to another process / HTTP response
/ CLI output: catch and convert to a structured result. The Node-side
convention is `{ ok: false, error }`; in Python it's typically a
`dataclass` result or a typed-dict.

### Logging on catch

```python
import logging
log = logging.getLogger(__name__)

try:
    value = backend.resolve(key)
except BackendUnavailable as e:
    log.warning("backend %s unavailable: %s", backend.name, e)
    # fall through to next backend
```

Use `logging`, not `print`. Configure at the entry point only.

---

## 7. Async

Use `asyncio` only when the I/O genuinely benefits — long-lived watcher,
many concurrent HTTP calls, websocket server. For one-off scripts, sync is
fine and simpler to read.

When using async:

```python
import asyncio
import httpx

async def fetch_many(urls: list[str]) -> list[dict]:
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *(client.get(u) for u in urls),
            return_exceptions=True,
        )
    return [...]
```

- One async context manager per HTTP client; don't recreate per call
- `asyncio.gather` for batched concurrency; never bare `for` loops with `await`
- `asyncio.wait_for` for timeouts; bare awaits with no timeout leak

---

## 8. Logging

```python
import logging
log = logging.getLogger(__name__)

log.info("[secrets] resolved %s via %s", key, backend_name)
log.warning("[secrets] op CLI missing from PATH")
log.error("[secrets] backend chain exhausted for %s", key)
```

- Module-level `log = logging.getLogger(__name__)` — never the root logger
- `%s` format strings passed as args (lazy interpolation), not f-strings.
  This skips formatting when the log level is filtered.
- Same `[scope]` prefix convention as the Node side, for dashboard log
  filtering when these logs route through to subctl.
- Configure handlers at the entry point only, never inside library code.

---

## 9. Packaging

`pyproject.toml` is the only project config file. No `setup.py`, no
`setup.cfg`, no `requirements.txt` in new projects.

```toml
[project]
name = "myproject"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "httpx>=0.27",
  "pydantic>=2.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

`hatchling` is the operator's default backend. `setuptools` is fine if the
project already uses it.

---

## 10. Tests — pytest patterns

```python
import pytest
from myproject.secrets import resolve_secret, ResolutionError

class TestResolveSecret:
    def test_returns_env_var(self, monkeypatch):
        monkeypatch.setenv("MY_KEY", "value")
        assert resolve_secret("my_key") == "value"

    def test_raises_when_missing(self):
        with pytest.raises(ResolutionError):
            resolve_secret("nonexistent")
```

- Class-based tests when grouping related cases; flat `def test_*` for
  standalone
- `monkeypatch` fixture for env vars, attribute patching — never set
  globals directly
- `tmp_path` fixture for filesystem isolation
- Parametrize repeated cases:
  ```python
  @pytest.mark.parametrize("input,expected", [("a", 1), ("b", 2)])
  def test_lookup(input, expected):
      assert table[input] == expected
  ```

No `unittest.TestCase` in new code unless integrating with legacy.

---

## 11. Commit messages

Same convention as the Node side — conventional-commit prefix + scope:

```
feat(claude-mem): observation retention policy
fix(api): pydantic v2 migration for SearchRequest
test: add fixtures for backend chain resolution
```

---

## 12. What this skill does NOT cover

- Django / FastAPI / Flask specifics — check the project's CLAUDE.md
- Jupyter notebooks — see project conventions; subctl doesn't ship notebooks
- ML / PyTorch idioms — separate concern
- Node — `node-conventions`
- Rust — `rust-conventions`
